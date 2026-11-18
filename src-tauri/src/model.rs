use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashMap},
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct State {
    pub skills: Vec<Value>,
    pub sources: Vec<Value>,
    pub connections: Vec<Value>,
    pub settings: Value,
    #[serde(default, rename = "localRoots")]
    pub local_roots: Vec<Value>,
    #[serde(default, rename = "ignoredLocalPaths")]
    pub ignored_local_paths: Vec<String>,
    #[serde(default = "automatic_checks", rename = "checkMode")]
    pub check_mode: String,
    #[serde(default, rename = "checkGeneration")]
    pub check_generation: u64,
    #[serde(default, rename = "checkSummary")]
    pub check_summary: Value,
}

fn automatic_checks() -> String {
    "auto".into()
}

pub(crate) struct TaskHistoryRow {
    pub(crate) id: String,
    pub(crate) payload: String,
}

pub struct Manager {
    pub(crate) basic_mode: bool,
    resource_catalog_available: bool,
    pub data_dir: PathBuf,
    pub(crate) storage: Arc<crate::storage::Storage>,
    pub state: State,
    pub previews: HashMap<String, Value>,
    pub management_undo: Vec<Value>,
    pub management_redo: Vec<Value>,
    pub(crate) resource_runtime: Arc<crate::resource_runtime::RuntimeRegistry>,
    db: Option<Connection>,
    revision: AtomicU64,
    management_revision: AtomicU64,
    runtime: Option<Arc<dyn ManagerRuntime>>,
    state_events: Option<Arc<dyn Fn(u64) + Send + Sync>>,
}

// Detached task workers never own a database. Their saves are acknowledged only
// after the live single writer has safely merged and persisted their changes.
pub(crate) trait ManagerRuntime: Send + Sync {
    fn save(&self, manager: &Manager) -> Result<(), String>;
    fn begin_automatic_commit(&self) -> Result<(), String>;
    fn snapshot(&self) -> Value;
    fn resource_store(&self, request: crate::resources::StoreRequest) -> Result<Value, String>;
    fn resource_check_store(
        &self,
        request: crate::resource_checks::StoreRequest,
    ) -> Result<Value, String>;
    fn resource_automation_store(
        &self,
        request: crate::resource_automation::StoreRequest,
    ) -> Result<Value, String>;
    fn capability_evidence_store(
        &self,
        _request: crate::resource_capability_evidence::StoreRequest,
    ) -> Result<Value, String> {
        Err("运行证据存储暂不可用".into())
    }
    fn management_store(
        &self,
        request: crate::management_data::StoreRequest,
    ) -> Result<Value, String>;
    fn template_store(
        &self,
        request: crate::invocation_templates::StoreRequest,
    ) -> Result<Value, String>;
    fn relation_store(
        &self,
        request: crate::resource_relations::StoreRequest,
    ) -> Result<Value, String>;
    fn scene_store(&self, request: crate::resource_scenes::StoreRequest) -> Result<Value, String>;
    fn configuration_store(
        &self,
        request: crate::configuration::StoreRequest,
    ) -> Result<Value, String>;
    fn download_store(
        &self,
        request: crate::resource_github::DownloadStore,
    ) -> Result<Value, String>;
    fn resource_package_store(
        &self,
        _request: crate::resource_package::StoreRequest,
    ) -> Result<Value, String> {
        Err("包准备记录存储暂不可用".into())
    }
    fn resource_spawn(
        &self,
        request: crate::resource_runtime::PreparedInvocation,
    ) -> Result<Value, String>;
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn table_exists(db: &Connection, name: &str) -> Result<bool, String> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

impl Manager {
    #[cfg(test)]
    pub fn new(data_dir: PathBuf) -> Result<Self, String> {
        Self::with_storage(crate::storage::Storage::isolated(data_dir))
    }
    pub(crate) fn with_storage(storage: Arc<crate::storage::Storage>) -> Result<Self, String> {
        Self::with_storage_mode(storage, false)
    }
    pub(crate) fn with_storage_mode(
        storage: Arc<crate::storage::Storage>,
        basic_mode: bool,
    ) -> Result<Self, String> {
        let data_dir = storage.path("state")?;
        let database = data_dir.join("manager.sqlite3");
        let db = if basic_mode {
            Connection::open_with_flags(&database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|e| {
                    format!(
                        "基本模式无法只读打开 {}；未重建数据库：{e}",
                        database.display()
                    )
                })?
        } else {
            std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
            Connection::open(&database).map_err(|e| e.to_string())?
        };
        if !basic_mode {
            db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS workspace_state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);").map_err(|e| e.to_string())?;
        }
        let saved: Result<String, _> =
            db.query_row("SELECT payload FROM app_state WHERE id=1", [], |r| r.get(0));
        let (state, revision) = match saved {
            Ok(s) => {
                let value: Value = serde_json::from_str(&s).map_err(|e| {
                    format!("Cannot read saved state; original database preserved: {e}")
                })?;
                let revision = value["stateRevision"].as_u64().unwrap_or(0);
                (
                    serde_json::from_value(value).map_err(|e| e.to_string())?,
                    revision,
                )
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => (
                State {
                    skills: vec![],
                    sources: vec![],
                    connections: vec![],
                    settings: json!({"checkIntervalMinutes":30,"uiTheme":"light","uiZoom":100,"uiFontSize":16,"libraryMode":"list","libraryPageSize":20,"librarySort":"name","categories":[],"sidebarWidth":224,"sidebarCollapsed":false}),
                    local_roots: vec![],
                    ignored_local_paths: vec![],
                    check_mode: automatic_checks(),
                    check_generation: 0,
                    check_summary: Value::Null,
                },
                0,
            ),
            Err(e) => return Err(e.to_string()),
        };
        let resource_revision = if basic_mode {
            if table_exists(&db, "resource_catalog_meta")? {
                db.query_row(
                    "SELECT COALESCE(MAX(revision),0) FROM resource_catalog_meta",
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?
            } else {
                0
            }
        } else {
            crate::resources::initialize(&db)?
        };
        let resource_catalog_available = table_exists(&db, "resource_catalog")?;
        if !basic_mode {
            crate::resource_github::initialize(&db)?;
            crate::resource_checks::initialize(&db)?;
            crate::resource_automation::initialize(&db)?;
        }
        let management_revision = if basic_mode {
            crate::management_data::revision(&db)?
        } else {
            crate::management_data::initialize(&db)?
        };
        let template_revision = if basic_mode {
            crate::invocation_templates::revision(&db)?
        } else {
            crate::invocation_templates::initialize(&db)?
        };
        let relation_revision = if basic_mode {
            crate::resource_relations::revision(&db)?
        } else {
            crate::resource_relations::initialize(&db)?
        };
        let scene_revision = if basic_mode {
            crate::resource_scenes::revision(&db)?
        } else {
            crate::resource_scenes::initialize(&db)?
        };
        Ok(Self {
            basic_mode,
            resource_catalog_available,
            data_dir,
            storage,
            state,
            previews: HashMap::new(),
            management_undo: Vec::new(),
            management_redo: Vec::new(),
            resource_runtime: Arc::new(crate::resource_runtime::RuntimeRegistry::default()),
            db: Some(db),
            revision: AtomicU64::new(
                revision
                    .max(resource_revision)
                    .max(management_revision)
                    .max(template_revision)
                    .max(relation_revision)
                    .max(scene_revision),
            ),
            management_revision: AtomicU64::new(management_revision),
            runtime: None,
            state_events: None,
        })
    }
    pub fn snapshot(&self) -> Value {
        if let Some(runtime) = &self.runtime {
            return runtime.snapshot();
        }
        let mut v = serde_json::to_value(&self.state).expect("serializable state");
        v["dataDir"] = json!(self.data_dir.to_string_lossy());
        v["storage"] = self.storage.snapshot().unwrap_or(Value::Null);
        v["managementUndo"] = json!({"available":!self.management_undo.is_empty(),"label":self.management_undo.last().and_then(|entry|entry["label"].as_str()),"entryId":self.management_undo.last().and_then(|entry|entry["id"].as_str())});
        v["managementRedo"] = json!({"available":!self.management_redo.is_empty(),"label":self.management_redo.last().and_then(|entry|entry["label"].as_str()),"entryId":self.management_redo.last().and_then(|entry|entry["id"].as_str())});
        v["stateRevision"] = json!(self.revision.load(Ordering::Relaxed));
        v["managementRevision"] = json!(self.management_revision.load(Ordering::Relaxed));
        v["readGeneration"] = json!(crate::network::read_generation().ok());
        v["startup"] = self.startup_status();
        v["maintenance"] = crate::maintenance::snapshot(&self.state.settings, self.basic_mode);
        if let Some(db) = &self.db {
            match crate::resource_scenes::eligibility(db) {
                Ok(context) => {
                    v["sceneRevision"] = json!(context.revision);
                    v["activeSceneId"] = json!(context.active_scene_id);
                    if let Some(skills) = v["skills"].as_array_mut() {
                        for skill in skills {
                            let endpoint = crate::resource_relations::Endpoint {
                                kind: "skill".into(),
                                id: skill["id"].as_str().unwrap_or_default().into(),
                            };
                            context.annotate(&endpoint, true, true, skill);
                        }
                    }
                }
                Err(reason) => {
                    v["sceneError"] = json!(reason);
                    if let Some(skills) = v["skills"].as_array_mut() {
                        for skill in skills {
                            skill["sceneEligible"] = json!(false);
                            skill["effectiveEnabled"] = json!(false);
                            skill["sceneReason"] = json!("场景记录暂不可读，使用资格尚未核对");
                        }
                    }
                }
            }
        }
        v
    }
    pub(crate) fn startup_status(&self) -> Value {
        let catalog = self.resource_catalog_available;
        json!({"basicMode":self.basic_mode,"readOnly":self.basic_mode,"resourceCatalogAvailable":catalog,"dataDir":self.data_dir,"warnings":if self.basic_mode && !catalog {vec!["当前数据库没有工具目录；基本模式不会创建新表。"]}else{vec![]}})
    }
    pub(crate) fn ensure_request_allowed(&self, request: &Value) -> Result<(), String> {
        if self.basic_mode
            && (request["automatic"] == true
                || !matches!(
                    request["action"].as_str().unwrap_or_default(),
                    "get_state"
                        | "get_content_cache_stats"
                        | "get_startup_status"
                        | "resource_list"
                        | "resource_templates"
                        | "resource_relations"
                        | "resource_scenes"
                        | "resource_source"
                        | "resource_template_prepare"
                        | "management_data"
                        | "resource_capabilities"
                        | "resource_runtime"
                        | "resource_idle"
                        | "resource_space"
                        | "resource_result"
                        | "resource_downloads"
                        | "resource_package_sessions"
                        | "resource_update_state"
                        | "resource_version_check_status"
                        | "resource_automation_status"
                        | "resource_capability_evidence"
                        | "open_system_apps"
                        | "preview_resource_recover"
                        | "storage_get"
                        | "storage_stats"
                        | "storage_open_path"
                        | "get_network_settings"
                        | "get_document"
                        | "get_doc_asset"
                        | "get_skill_info"
                        | "read_file"
                        | "get_cleanup_receipts"
                ))
        {
            return Err(
                "基本模式仅保留读取和诊断；自动维护、工具启动及更改已暂停。退出后正常启动可恢复。"
                    .into(),
            );
        }
        if request["automatic"] == true {
            crate::maintenance::ensure_automatic_allowed(&self.state.settings)?;
        }
        if matches!(
            request["action"].as_str(),
            Some("connect" | "connect_batch")
        ) {
            let ids: Vec<&str> = if request["action"] == "connect" {
                request["skillId"].as_str().into_iter().collect()
            } else {
                request["skillIds"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect()
            };
            for id in ids {
                let eligibility =
                    self.scene_store(crate::resource_scenes::StoreRequest::Eligibility(
                        crate::resource_relations::Endpoint {
                            kind: "skill".into(),
                            id: id.into(),
                        },
                    ))?;
                if eligibility["sceneEligible"] != true {
                    return Err(
                        "当前场景未包含所选 Skill，不能建立新的客户端连接；已有入口保持".into(),
                    );
                }
            }
        }
        Ok(())
    }
    pub(crate) fn begin_automatic_commit(&self, request: &Value) -> Result<(), String> {
        if request["automatic"] != true {
            return Ok(());
        }
        if let Some(runtime) = &self.runtime {
            return runtime.begin_automatic_commit();
        }
        if request["action"] != "repair_client_connections" {
            return Err("此操作没有自动写入流程".into());
        }
        self.ensure_request_allowed(request)?;
        crate::tasks::validate_automatic_configuration(&self.state, request)
    }
    pub(crate) fn configuration_store(
        &mut self,
        request: crate::configuration::StoreRequest,
    ) -> Result<Value, String> {
        if let Some(runtime) = &self.runtime {
            return runtime.configuration_store(request);
        }
        let db = self
            .db
            .as_ref()
            .ok_or("Task worker cannot access configuration storage")?;
        let current = self.revision.load(Ordering::Relaxed);
        match request {
            crate::configuration::StoreRequest::Read => Ok(
                json!({"revision":current,"document":crate::configuration::read(db,&self.state)?}),
            ),
            crate::configuration::StoreRequest::Apply {
                document,
                expected_revision,
                selected,
            } => {
                if self.basic_mode {
                    return Err("基本模式不能导入配置".into());
                }
                if expected_revision != current {
                    return Err("管理信息已变化，请重新预览配置导入".into());
                }
                let revision = current
                    .checked_add(1)
                    .filter(|n| *n <= i64::MAX as u64)
                    .ok_or("配置修订号超出范围")?;
                let count = selected.len();
                let management_changed = selected
                    .iter()
                    .any(|key| key.starts_with("annotation:") || key.starts_with("view:"));
                let next =
                    crate::configuration::apply(db, &self.state, document, selected, revision)?;
                self.state = next;
                self.management_undo.clear();
                self.management_redo.clear();
                self.revision.store(revision, Ordering::Relaxed);
                if management_changed {
                    self.management_revision.store(revision, Ordering::Relaxed);
                }
                if let Some(events) = &self.state_events {
                    events(revision);
                }
                Ok(json!({"applied":count,"state":self.snapshot()}))
            }
        }
    }
    pub(crate) fn scene_store(
        &self,
        request: crate::resource_scenes::StoreRequest,
    ) -> Result<Value, String> {
        if let Some(runtime) = &self.runtime {
            return runtime.scene_store(request);
        }
        let writes = request.writes();
        if self.basic_mode && writes {
            return Err("基本模式不修改或切换场景".into());
        }
        let resources = if matches!(
            &request,
            crate::resource_scenes::StoreRequest::Eligibility(_)
        ) {
            vec![]
        } else {
            let listed = self.resource_store(crate::resources::StoreRequest::List)?;
            serde_json::from_value(listed["resources"].clone()).map_err(|e| e.to_string())?
        };
        let revision = if writes {
            self.revision
                .load(Ordering::Relaxed)
                .checked_add(1)
                .filter(|n| *n <= i64::MAX as u64)
                .ok_or("场景修订号超出范围")?
        } else {
            self.revision.load(Ordering::Relaxed)
        };
        let (result, changed) = crate::resource_scenes::store(
            self.db
                .as_ref()
                .ok_or("Task worker cannot write a database")?,
            &self.state,
            &resources,
            request,
            revision,
        )?;
        if changed {
            self.revision.store(revision, Ordering::Relaxed);
            if let Some(events) = &self.state_events {
                events(revision);
            }
        }
        Ok(result)
    }
    pub(crate) fn relation_store(
        &self,
        request: crate::resource_relations::StoreRequest,
    ) -> Result<Value, String> {
        if let Some(runtime) = &self.runtime {
            return runtime.relation_store(request);
        }
        if self.basic_mode && request.writes() {
            return Err("基本模式不修改资源依赖关系".into());
        }
        let listed = self.resource_store(crate::resources::StoreRequest::List)?;
        let resources: Vec<crate::resources::ResourceRecord> =
            serde_json::from_value(listed["resources"].clone()).map_err(|e| e.to_string())?;
        let revision = if request.writes() {
            self.revision
                .load(Ordering::Relaxed)
                .checked_add(1)
                .filter(|value| *value <= i64::MAX as u64)
                .ok_or("关系修订号超出范围")?
        } else {
            self.revision.load(Ordering::Relaxed)
        };
        let (result, changed) = crate::resource_relations::store(
            self.db
                .as_ref()
                .ok_or("Task worker cannot write a database")?,
            &self.state,
            &resources,
            request,
            revision,
        )?;
        if changed {
            self.revision.store(revision, Ordering::Relaxed);
            if let Some(events) = &self.state_events {
                events(revision);
            }
        }
        Ok(result)
    }
    pub(crate) fn template_store(
        &self,
        request: crate::invocation_templates::StoreRequest,
    ) -> Result<Value, String> {
        if let Some(runtime) = &self.runtime {
            return runtime.template_store(request);
        }
        if self.basic_mode && request.writes() {
            return Err("基本模式不修改调用模板".into());
        }
        if self.basic_mode && !self.resource_catalog_available && request.lists() {
            return Ok(json!({"templates":[],"resourceRevision":0}));
        }
        let record: crate::resources::ResourceRecord =
            serde_json::from_value(self.resource_store(crate::resources::StoreRequest::Get(
                request.resource_id.clone(),
            ))?)
            .map_err(|e| e.to_string())?;
        let revision = if request.writes() {
            self.revision
                .load(Ordering::Relaxed)
                .checked_add(1)
                .filter(|value| *value <= i64::MAX as u64)
                .ok_or("模板修订号超出范围")?
        } else {
            self.revision.load(Ordering::Relaxed)
        };
        let (result, changed) = crate::invocation_templates::store(
            self.db
                .as_ref()
                .ok_or("Task worker cannot write a database")?,
            &record,
            request,
            revision,
        )?;
        if changed {
            self.revision.store(revision, Ordering::Relaxed);
            if let Some(events) = &self.state_events {
                events(revision);
            }
        }
        Ok(result)
    }
    pub(crate) fn management_store(
        &self,
        request: crate::management_data::StoreRequest,
    ) -> Result<Value, String> {
        if let Some(runtime) = &self.runtime {
            return runtime.management_store(request);
        }
        if self.basic_mode && request.writes() {
            return Err("基本模式不修改个人信息和常用筛选".into());
        }
        // Workers may have stale Skill snapshots; only this live writer decides
        // whether the target still exists. Removing a Skill never erases its notes.
        if let Some(id) = request.skill_id() {
            self.skill(id)?;
        }
        let revision = if request.writes() {
            self.revision
                .load(Ordering::Relaxed)
                .checked_add(1)
                .filter(|revision| *revision <= i64::MAX as u64)
                .ok_or("管理数据修订号超出范围")?
        } else {
            self.revision.load(Ordering::Relaxed)
        };
        let (result, changed) = crate::management_data::store(
            self.db
                .as_ref()
                .ok_or("Task worker cannot write a database")?,
            request,
            revision,
        )?;
        if changed {
            self.management_revision.store(revision, Ordering::Relaxed);
            self.revision.store(revision, Ordering::Relaxed);
            if let Some(events) = &self.state_events {
                events(revision);
            }
        }
        Ok(result)
    }
    pub(crate) fn resource_store(
        &self,
        request: crate::resources::StoreRequest,
    ) -> Result<Value, String> {
        if let Some(runtime) = &self.runtime {
            return runtime.resource_store(request);
        }
        let writes = request.writes();
        if self.basic_mode {
            if writes {
                return Err("基本模式不修改资源目录".into());
            }
            if self.db.is_some() && !self.resource_catalog_available {
                return match request {
                    crate::resources::StoreRequest::List => Ok(
                        json!({"resources":[],"unavailableReason":"当前数据库没有工具目录；基本模式未创建新表"}),
                    ),
                    _ => Err("当前数据库没有工具目录；基本模式未创建新表".into()),
                };
            }
        }
        let revision = self
            .revision
            .load(Ordering::Relaxed)
            .checked_add(1)
            .ok_or("资源目录修订号超出范围")?;
        let result = crate::resources::store(
            self.db
                .as_ref()
                .ok_or("Task worker cannot write a database")?,
            request,
            revision,
        )?;
        if writes {
            self.revision.store(revision, Ordering::Relaxed);
            if let Some(events) = &self.state_events {
                events(revision);
            }
        }
        Ok(result)
    }
    pub(crate) fn download_store(
        &self,
        request: crate::resource_github::DownloadStore,
    ) -> Result<Value, String> {
        if let Some(runtime) = &self.runtime {
            return runtime.download_store(request);
        }
        if self.basic_mode && matches!(&request, crate::resource_github::DownloadStore::Save { .. })
        {
            return Err("基本模式不修改下载记录".into());
        }
        crate::resource_github::store(
            self.db
                .as_ref()
                .ok_or("Task worker cannot write a database")?,
            request,
        )
    }

    pub(crate) fn resource_package_store(
        &self,
        request: crate::resource_package::StoreRequest,
    ) -> Result<Value, String> {
        if let Some(runtime) = &self.runtime {
            return runtime.resource_package_store(request);
        }
        if self.basic_mode && request.writes() {
            return Err("基本模式不修改包准备记录".into());
        }
        crate::resource_package::store(
            self.db
                .as_ref()
                .ok_or("Task worker cannot write a database")?,
            request,
        )
    }

    pub(crate) fn resource_check_store(
        &self,
        request: crate::resource_checks::StoreRequest,
    ) -> Result<Value, String> {
        if let Some(runtime) = &self.runtime {
            return runtime.resource_check_store(request);
        }
        if request.writes() {
            if self.basic_mode {
                return Err("基本模式不修改版本检查记录".into());
            }
            crate::maintenance::ensure_automatic_allowed(&self.state.settings)?;
        }
        crate::resource_checks::store(
            self.db
                .as_ref()
                .ok_or("Task worker cannot write a database")?,
            request,
        )
    }

    pub(crate) fn resource_automation_store(
        &self,
        request: crate::resource_automation::StoreRequest,
    ) -> Result<Value, String> {
        if let Some(runtime) = &self.runtime {
            return runtime.resource_automation_store(request);
        }
        let writes = request.writes();
        if writes && self.basic_mode {
            return Err("基本模式不修改自动更新授权".into());
        }
        let current = self.revision.load(Ordering::Relaxed);
        let revision = if writes {
            current.checked_add(1).ok_or("资源目录修订号超出范围")?
        } else {
            current
        };
        let value = crate::resource_automation::store(
            self.db
                .as_ref()
                .ok_or("Task worker cannot write a database")?,
            request,
            revision,
        )?;
        if writes {
            self.revision.store(revision, Ordering::Relaxed);
            if let Some(events) = &self.state_events {
                events(revision);
            }
        }
        Ok(value)
    }

    pub(crate) fn capability_evidence_store(
        &self,
        request: crate::resource_capability_evidence::StoreRequest,
    ) -> Result<Value, String> {
        if let Some(runtime) = &self.runtime {
            return runtime.capability_evidence_store(request);
        }
        if self.basic_mode && request.writes() {
            return Err("基本模式不保存新的运行证据".into());
        }
        crate::resource_capability_evidence::store(
            self.db
                .as_ref()
                .ok_or("Task worker cannot write a database")?,
            request,
        )
    }

    pub fn refresh_selection(&self, request: &Value) -> Result<Option<BTreeSet<String>>, String> {
        if request.get("skillId").is_some() && request.get("skillIds").is_some() {
            return Err("Choose skillId or skillIds, not both".into());
        }
        let values = if let Some(value) = request.get("skillIds") {
            let ids = value
                .as_array()
                .ok_or("skillIds must be a list of Skill IDs")?;
            if ids.is_empty() {
                return Err("Select at least one Skill to check".into());
            }
            ids.clone()
        } else if let Some(value) = request.get("skillId") {
            vec![value.clone()]
        } else {
            return Ok(None);
        };
        let mut ids = BTreeSet::new();
        for value in values {
            let id = value
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or("Invalid Skill ID in selection")?;
            self.skill(id)?;
            ids.insert(id.to_owned());
        }
        Ok(Some(ids))
    }
    pub(crate) fn resource_spawn(
        &self,
        request: crate::resource_runtime::PreparedInvocation,
    ) -> Result<Value, String> {
        if self.basic_mode {
            return Err("基本模式暂停第三方工具启动".into());
        }
        if let Some(runtime) = &self.runtime {
            return runtime.resource_spawn(request);
        }
        let record = self.resource_spawn_record(&request)?;
        let prepared = crate::resource_runtime::prepare_spawn(record, request)?;
        self.resource_spawn_prepared(prepared)
    }

    pub(crate) fn resource_spawn_record(
        &self,
        request: &crate::resource_runtime::PreparedInvocation,
    ) -> Result<crate::resources::ResourceRecord, String> {
        if self.basic_mode {
            return Err("基本模式暂停第三方工具启动".into());
        }
        let record: crate::resources::ResourceRecord =
            serde_json::from_value(self.resource_store(crate::resources::StoreRequest::Get(
                request.resource_id.clone(),
            ))?)
            .map_err(|e| e.to_string())?;
        if !record.enabled || record.revision != request.revision {
            return Err("资源或动作已改变，请重新读取后调用".into());
        }
        Ok(record)
    }

    pub(crate) fn resource_spawn_prepared(
        &self,
        prepared: crate::resource_runtime::PreparedSpawn,
    ) -> Result<Value, String> {
        if self.basic_mode {
            return Err("基本模式暂停第三方工具启动".into());
        }
        if self.runtime.is_some() {
            return Err("最终进程准入必须由当前管理器核对".into());
        }
        // Only cheap live admission and spawn share this lock with disable/configuration writes.
        let record: crate::resources::ResourceRecord =
            serde_json::from_value(self.resource_store(crate::resources::StoreRequest::Get(
                prepared.resource_id().to_owned(),
            ))?)
            .map_err(|e| e.to_string())?;
        prepared.admit(&record)?;
        let eligibility = self.scene_store(crate::resource_scenes::StoreRequest::Eligibility(
            crate::resource_relations::Endpoint {
                kind: "tool".into(),
                id: record.id.clone(),
            },
        ))?;
        if eligibility["sceneEligible"] != true {
            return Err("当前场景未包含此资源，不能开始新调用".into());
        }
        let mut visited = BTreeSet::new();
        let mut pending = vec![crate::resource_relations::Endpoint {
            kind: "tool".into(),
            id: record.id.clone(),
        }];
        let mut dependencies = BTreeSet::new();
        while let Some(endpoint) = pending.pop() {
            if !visited.insert(endpoint.clone()) {
                continue;
            }
            let relationships =
                self.relation_store(crate::resource_relations::StoreRequest::List { endpoint })?;
            for edge in relationships["dependencies"]
                .as_array()
                .into_iter()
                .flatten()
            {
                let dependency = &edge["dependency"];
                let endpoint = crate::resource_relations::Endpoint {
                    kind: dependency["kind"]
                        .as_str()
                        .ok_or("依赖端点类型缺失")?
                        .into(),
                    id: dependency["id"].as_str().ok_or("依赖端点标识缺失")?.into(),
                };
                if endpoint.kind == "tool" && endpoint.id != record.id {
                    dependencies.insert(endpoint.id.clone());
                }
                pending.push(endpoint);
            }
        }
        self.resource_runtime
            .spawn_prepared(prepared, dependencies.into_iter().collect())
    }
    pub fn save(&self) -> Result<(), String> {
        if self.basic_mode {
            return Err("基本模式不修改保存设置或资源数据".into());
        }
        if let Some(runtime) = &self.runtime {
            return runtime.save(self);
        }
        let revision = self.revision.load(Ordering::Relaxed) + 1;
        let mut payload = serde_json::to_value(&self.state).map_err(|e| e.to_string())?;
        payload["stateRevision"] = json!(revision);
        self.db.as_ref().ok_or("Task worker cannot write a database")?.execute("INSERT INTO app_state(id,schema_version,payload) VALUES(1,1,?1) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", params![payload.to_string()]).map_err(|e| e.to_string())?;
        self.revision.store(revision, Ordering::Relaxed);
        if let Some(events) = &self.state_events {
            events(revision);
        }
        Ok(())
    }
    pub(crate) fn detached(
        &self,
        runtime: Arc<dyn ManagerRuntime>,
        include_previews: bool,
    ) -> Self {
        Self {
            basic_mode: self.basic_mode,
            resource_catalog_available: self.resource_catalog_available,
            data_dir: self.data_dir.clone(),
            storage: self.storage.clone(),
            state: self.state.clone(),
            previews: if include_previews {
                self.previews.clone()
            } else {
                HashMap::new()
            },
            management_undo: self.management_undo.clone(),
            management_redo: self.management_redo.clone(),
            resource_runtime: self.resource_runtime.clone(),
            db: None,
            revision: AtomicU64::new(self.revision.load(Ordering::Relaxed)),
            management_revision: AtomicU64::new(self.management_revision.load(Ordering::Relaxed)),
            runtime: Some(runtime),
            state_events: None,
        }
    }
    pub(crate) fn set_state_events(&mut self, events: Arc<dyn Fn(u64) + Send + Sync>) {
        self.state_events = Some(events);
    }
    pub(crate) fn workspace_state(&self) -> Result<Option<Value>, String> {
        if self.basic_mode {
            return Ok(None);
        }
        let db = self
            .db
            .as_ref()
            .ok_or("Task worker has no workspace database")?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS workspace_state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)").map_err(|e|e.to_string())?;
        match db.query_row("SELECT payload FROM workspace_state WHERE id=1", [], |r| {
            r.get::<_, String>(0)
        }) {
            Ok(value) => serde_json::from_str(&value)
                .map(Some)
                .map_err(|e| format!("Cannot read workspace; original data preserved: {e}")),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }
    pub(crate) fn copy_database(&self, destination: &std::path::Path) -> Result<(), String> {
        if self.basic_mode {
            return Err("基本模式不执行存储迁移".into());
        }
        let db = self
            .db
            .as_ref()
            .ok_or("Task worker cannot copy a database")?;
        db.execute("VACUUM INTO ?1", params![destination.to_string_lossy()])
            .map_err(|e| e.to_string())?;
        let copy =
            Connection::open_with_flags(destination, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|e| e.to_string())?;
        let check: String = copy
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if check != "ok" {
            return Err("复制后的数据库校验失败，原数据库已保留".into());
        }
        drop(copy);
        std::fs::OpenOptions::new()
            .write(true)
            .open(destination)
            .and_then(|file| file.sync_all())
            .map_err(|e| e.to_string())
    }
    pub(crate) fn store_workspace_state(&self, value: &Value) -> Result<(), String> {
        if self.basic_mode {
            return Ok(());
        }
        self.db.as_ref().ok_or("Task worker has no workspace database")?.execute("INSERT INTO workspace_state(id,payload) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", params![value.to_string()]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub(crate) fn store_workspace_with_history(
        &self,
        value: &Value,
        records: &[TaskHistoryRow],
    ) -> Result<(), String> {
        if self.basic_mode {
            return Ok(());
        }
        let db = self
            .db
            .as_ref()
            .ok_or("Task worker has no workspace database")?;
        db.execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        let result = (|| {
            db.execute("INSERT INTO workspace_state(id,payload) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",params![value.to_string()]).map_err(|e|e.to_string())?;
            db.execute("DELETE FROM task_history", [])
                .map_err(|e| e.to_string())?;
            for record in records {
                db.execute(
                    "INSERT INTO task_history(id,payload) VALUES(?1,?2)",
                    params![record.id, record.payload],
                )
                .map_err(|e| e.to_string())?;
            }
            db.execute_batch("COMMIT").map_err(|e| e.to_string())
        })();
        if result.is_err() {
            let _ = db.execute_batch("ROLLBACK");
        }
        result
    }
    pub(crate) fn task_history(&self) -> Result<Vec<Value>, String> {
        let db = self
            .db
            .as_ref()
            .ok_or("Task worker has no history database")?;
        if self.basic_mode {
            if !table_exists(db, "task_history")? {
                return Ok(vec![]);
            }
        } else {
            db.execute_batch(
            "CREATE TABLE IF NOT EXISTS task_history (id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
        )
        .map_err(|e| e.to_string())?;
        }
        let mut statement = db
            .prepare("SELECT payload FROM task_history")
            .map_err(|e| e.to_string())?;
        let records = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .map(|row| {
                row.map_err(|e| e.to_string())
                    .and_then(|text| serde_json::from_str(&text).map_err(|e| e.to_string()))
            })
            .collect();
        records
    }
    #[cfg(test)]
    pub(crate) fn store_task_history(&self, records: &[Value]) -> Result<(), String> {
        let rows = records
            .iter()
            .map(|record| {
                Ok(TaskHistoryRow {
                    id: record["id"]
                        .as_str()
                        .ok_or("Invalid task history ID")?
                        .into(),
                    payload: record.to_string(),
                })
            })
            .collect::<Result<Vec<_>, &str>>()?;
        self.store_task_history_rows(&rows)
    }

    pub(crate) fn store_task_history_rows(&self, records: &[TaskHistoryRow]) -> Result<(), String> {
        if self.basic_mode {
            return Ok(());
        }
        let db = self
            .db
            .as_ref()
            .ok_or("Task worker has no history database")?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS task_history (id TEXT PRIMARY KEY, payload TEXT NOT NULL); BEGIN IMMEDIATE").map_err(|e|e.to_string())?;
        let result = (|| {
            let mut retained = BTreeSet::new();
            for record in records {
                if !retained.insert(record.id.as_str()) {
                    return Err("Duplicate task history ID".into());
                }
            }
            let existing = {
                let mut statement = db
                    .prepare("SELECT id FROM task_history")
                    .map_err(|e| e.to_string())?;
                let ids = statement
                    .query_map([], |row| row.get::<_, String>(0))
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                ids
            };
            let mut remove = db
                .prepare("DELETE FROM task_history WHERE id=?1")
                .map_err(|e| e.to_string())?;
            for id in existing {
                if !retained.contains(id.as_str()) {
                    remove.execute([id]).map_err(|e| e.to_string())?;
                }
            }
            let mut save = db
                .prepare("INSERT INTO task_history(id,payload) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload WHERE task_history.payload <> excluded.payload")
                .map_err(|e| e.to_string())?;
            for record in records {
                save.execute(params![record.id, record.payload])
                    .map_err(|e| e.to_string())?;
            }
            db.execute_batch("COMMIT").map_err(|e| e.to_string())
        })();
        if result.is_err() {
            let _ = db.execute_batch("ROLLBACK");
        }
        result
    }
    pub fn skill(&self, id: &str) -> Result<Value, String> {
        self.state
            .skills
            .iter()
            .find(|s| s["id"] == id)
            .cloned()
            .ok_or_else(|| "Skill no longer exists".into())
    }
    pub fn upsert_skill(&mut self, skill: Value) {
        if let Some(i) = self
            .state
            .skills
            .iter()
            .position(|s| s["id"] == skill["id"])
        {
            self.state.skills[i] = skill;
        } else {
            self.state.skills.push(skill);
        }
    }
    pub fn id(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
}
