//! Registered resources are metadata only until an execution adapter is attached.
//! Their catalog uses separate SQLite tables and the manager's existing single writer.
use crate::model::{now, Manager};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResourceRecord {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub root_path: String,
    pub repository: Option<String>,
    pub version: Option<String>,
    #[serde(default)]
    pub source_binding: Option<crate::resource_source::SourceBinding>,
    #[serde(default)]
    pub source_history: Vec<crate::resource_source::SourceHistory>,
    pub alias: String,
    pub notes: String,
    pub enabled: bool,
    pub ownership: String,
    pub management_scope: String,
    pub actions: Vec<Value>,
    pub capabilities: Vec<Value>,
    pub update_policy: Value,
    #[serde(default)]
    pub installation: Option<crate::resource_lifecycle::InstallationRecord>,
    pub revision: u64,
    pub created_at: String,
    pub updated_at: String,
}

pub(crate) enum StoreRequest {
    List,
    Get(String),
    Insert(Box<ResourceRecord>),
    Replace {
        record: Box<ResourceRecord>,
        expected_revision: u64,
    },
    Relocate {
        original: Box<ResourceRecord>,
        record: Box<ResourceRecord>,
    },
}

impl StoreRequest {
    pub(crate) fn writes(&self) -> bool {
        matches!(
            self,
            Self::Insert(_) | Self::Replace { .. } | Self::Relocate { .. }
        )
    }
}

pub(crate) fn initialize(db: &Connection) -> Result<u64, String> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS resource_catalog (
            id TEXT PRIMARY KEY,
            root_key TEXT NOT NULL UNIQUE,
            revision INTEGER NOT NULL CHECK(revision > 0),
            payload TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS resource_catalog_meta (
            id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL
        );",
    )
    .map_err(|e| e.to_string())?;
    // Every catalogue writer needs the same transactional evidence epoch table,
    // including the isolated source-check service and configuration importer.
    crate::resource_capability_evidence::initialize(db)?;
    db.query_row(
        "SELECT revision FROM resource_catalog_meta WHERE id=1",
        [],
        |r| r.get(0),
    )
    .optional()
    .map(|value| value.unwrap_or(0))
    .map_err(|e| e.to_string())
}

fn root_key(path: &str) -> String {
    if cfg!(windows) {
        let path = path.replace('/', "\\").to_lowercase();
        if let Some(unc) = path.strip_prefix(r"\\?\unc\") {
            format!(r"\\{unc}")
        } else {
            path.strip_prefix(r"\\?\").unwrap_or(&path).to_owned()
        }
    } else {
        path.to_owned()
    }
}

fn read_one(db: &Connection, id: &str) -> Result<ResourceRecord, String> {
    let payload: String = db
        .query_row(
            "SELECT payload FROM resource_catalog WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("资源不存在，请重新读取列表")?;
    serde_json::from_str(&payload).map_err(|e| format!("无法读取资源记录，原数据保留：{e}"))
}

/// Called only on the live Manager connection; workers send requests to its writer.
pub(crate) fn store(
    db: &Connection,
    request: StoreRequest,
    catalog_revision: u64,
) -> Result<Value, String> {
    match request {
        StoreRequest::List => {
            let mut statement = db
                .prepare("SELECT payload FROM resource_catalog ORDER BY rowid")
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            let mut resources = Vec::new();
            for row in rows {
                let payload = row.map_err(|e| e.to_string())?;
                resources.push(
                    serde_json::from_str::<ResourceRecord>(&payload)
                        .map_err(|e| format!("无法读取资源记录，原数据保留：{e}"))?,
                );
            }
            Ok(json!({"resources":resources}))
        }
        StoreRequest::Get(id) => Ok(json!(read_one(db, &id)?)),
        mutation => {
            let transaction = db.unchecked_transaction().map_err(|e| e.to_string())?;
            let mutation = match mutation {
                StoreRequest::Relocate { original, record } => {
                    let before = read_one(&transaction, &original.id)?;
                    if serde_json::to_value(&before).map_err(|e| e.to_string())?
                        != serde_json::to_value(&original).map_err(|e| e.to_string())?
                        || record.id != original.id
                        || original.revision.checked_add(1) != Some(record.revision)
                    {
                        return Err("预览后原资源已变化，目录修复未保存".into());
                    }
                    StoreRequest::Replace {
                        record,
                        expected_revision: original.revision,
                    }
                }
                other => other,
            };
            let record = match mutation {
                StoreRequest::Insert(record) => {
                    let duplicate: bool = transaction
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM resource_catalog WHERE root_key=?1)",
                            [root_key(&record.root_path)],
                            |r| r.get(0),
                        )
                        .map_err(|e| e.to_string())?;
                    if duplicate {
                        return Err("该真实目录已登记，请编辑已有资源".into());
                    }
                    transaction.execute(
                        "INSERT INTO resource_catalog(id,root_key,revision,payload) VALUES(?1,?2,?3,?4)",
                        params![record.id, root_key(&record.root_path), record.revision, serde_json::to_string(&record).map_err(|e|e.to_string())?],
                    ).map_err(|e| e.to_string())?;
                    record
                }
                StoreRequest::Replace {
                    record,
                    expected_revision,
                } => {
                    let before = read_one(&transaction, &record.id)?;
                    let changed = transaction.execute(
                        "UPDATE resource_catalog SET revision=?1,payload=?2,root_key=?5 WHERE id=?3 AND revision=?4",
                        params![record.revision, serde_json::to_string(&record).map_err(|e|e.to_string())?, record.id, expected_revision, root_key(&record.root_path)],
                    ).map_err(|e| e.to_string())?;
                    if changed != 1 {
                        return Err("资源已被其他操作修改，请重新读取后再保存".into());
                    }
                    crate::resource_capability_evidence::transition(
                        &transaction,
                        &before,
                        &record,
                    )?;
                    record
                }
                _ => unreachable!(),
            };
            transaction.execute(
                "INSERT INTO resource_catalog_meta(id,revision) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision",
                [catalog_revision],
            ).map_err(|e|e.to_string())?;
            transaction.commit().map_err(|e| e.to_string())?;
            Ok(json!({"resource":record}))
        }
    }
}

fn text(value: &Value, field: &str, max: usize, required: bool) -> Result<String, String> {
    let text = match value.get(field) {
        None if !required => "",
        Some(Value::String(text)) => text.trim(),
        _ => return Err(format!("{field} 必须是文字")),
    };
    if (required && text.is_empty()) || text.chars().count() > max || text.contains('\0') {
        return Err(format!("{field} 内容为空、过长或包含无效字符"));
    }
    Ok(text.to_owned())
}

fn optional_text(value: &Value, field: &str, max: usize) -> Result<Option<String>, String> {
    if value.get(field).is_none_or(Value::is_null) {
        return Ok(None);
    }
    let text = text(value, field, max, false)?;
    Ok((!text.is_empty()).then_some(text))
}

pub(crate) fn repository(value: &Value) -> Result<Option<String>, String> {
    let Some(raw) = optional_text(value, "repository", 512)? else {
        return Ok(None);
    };
    if raw.contains(['\\', '%']) || raw.contains("/../") || raw.contains("/./") {
        return Err("仓库地址不能包含编码、反斜线或相对路径段".into());
    }
    let parsed = url::Url::parse(&raw).map_err(|_| "请输入完整的 GitHub HTTPS 仓库地址")?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("github.com")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("仓库地址必须是 https://github.com/作者/仓库，不能包含凭据或查询参数".into());
    }
    let parts: Vec<_> = parsed.path().trim_matches('/').split('/').collect();
    if parts.len() != 2 {
        return Err("请填写仓库主页地址，子目录和发行包将在安装流程中选择".into());
    }
    let owner = parts[0];
    let repo = parts[1].strip_suffix(".git").unwrap_or(parts[1]);
    if owner.is_empty()
        || repo.is_empty()
        || matches!(repo, "." | "..")
        || !owner
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        || !repo
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
    {
        return Err("GitHub 作者或仓库名称无效".into());
    }
    Ok(Some(format!("https://github.com/{owner}/{repo}")))
}

fn selected_root(request: &Value) -> Result<String, String> {
    let raw = text(request, "rootPath", 32767, true)?;
    let path = Path::new(&raw);
    if !path.is_absolute() {
        return Err("请选择完整的绝对目录路径".into());
    }
    let canonical = crate::local::canonical(path)?;
    if !canonical.is_dir() {
        return Err("资源位置必须是现有目录".into());
    }
    let path = canonical.to_string_lossy().into_owned();
    #[cfg(windows)]
    let path = if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(&path).to_owned()
    };
    Ok(path)
}

pub(crate) fn update_policy(value: &Value) -> Result<Value, String> {
    let object = value.as_object().ok_or("updatePolicy 必须是对象")?;
    if object.keys().any(|key| {
        !["mode", "intervalHours", "pinnedVersion", "skippedVersions"].contains(&key.as_str())
    }) {
        return Err("更新策略包含不支持的字段".into());
    }
    // Registration alone cannot grant automatic maintenance ownership.
    if value["mode"] != "manual" || value["intervalHours"] != 24 {
        return Err("仅登记资源暂用手动维护，自动更新需先完成运行范围与兼容性核验".into());
    }
    let pinned = optional_text(value, "pinnedVersion", 160)?;
    let skipped = value["skippedVersions"]
        .as_array()
        .ok_or("skippedVersions 必须是版本列表")?;
    if skipped.len() > 100
        || skipped.iter().any(|v| {
            !v.as_str()
                .is_some_and(|s| !s.trim().is_empty() && s.len() <= 160 && !s.contains('\0'))
        })
    {
        return Err("跳过版本列表无效或过长".into());
    }
    Ok(json!({"mode":"manual","intervalHours":24,"pinnedVersion":pinned,"skippedVersions":skipped}))
}

pub(crate) fn handle(m: &Manager, request: &Value) -> Result<Option<Value>, String> {
    let action = request["action"].as_str().unwrap_or_default();
    let mut result = match action {
        "resource_list" => m.resource_store(StoreRequest::List)?,
        "resource_register" => {
            if request.get("ownership").is_some_and(|v| v != "external")
                || request
                    .get("managementScope")
                    .is_some_and(|v| v != "register")
                || request.get("actions").is_some()
                || request.get("capabilities").is_some()
            {
                return Err("目录登记不会授予执行或系统维护权限".into());
            }
            let name = text(request, "name", 160, true)?;
            let kind = text(request, "kind", 32, true)?;
            if !["skill", "portable", "cli", "mcp"].contains(&kind.as_str()) {
                return Err("资源类型无效".into());
            }
            let timestamp = now();
            let record = ResourceRecord {
                id: uuid::Uuid::new_v4().to_string(),
                name,
                kind,
                root_path: selected_root(request)?,
                repository: repository(request)?,
                version: optional_text(request, "version", 160)?,
                source_binding: None,
                source_history: vec![],
                alias: text(request, "alias", 160, false)?,
                notes: text(request, "notes", 4096, false)?,
                enabled: match request.get("enabled") {
                    None => true,
                    Some(Value::Bool(v)) => *v,
                    _ => return Err("enabled 必须是真或假".into()),
                },
                ownership: "external".into(),
                management_scope: "register".into(),
                actions: vec![],
                capabilities: vec![
                    json!({"id":"registration","label":"目录登记","status":"available","verifiedAt":timestamp}),
                    json!({"id":"execution","label":"统一调用","status":"unverified","verifiedAt":null,"reason":"尚未接入执行适配；登记不代表调用已验证"}),
                ],
                update_policy: match request.get("updatePolicy") {
                    Some(policy) => update_policy(policy)?,
                    None => {
                        json!({"mode":"manual","intervalHours":24,"pinnedVersion":null,"skippedVersions":[]})
                    }
                },
                installation: None,
                revision: 1,
                created_at: timestamp.clone(),
                updated_at: timestamp,
            };
            m.resource_store(StoreRequest::Insert(Box::new(record)))?
        }
        "resource_update" | "resource_set_enabled" | "resource_capabilities" => {
            let id = text(request, "id", 64, true)?;
            let mut record: ResourceRecord =
                serde_json::from_value(m.resource_store(StoreRequest::Get(id.clone()))?)
                    .map_err(|e| e.to_string())?;
            if action == "resource_capabilities" {
                return Ok(Some(
                    json!({"id":id,"enabled":record.enabled,"actions":record.actions,"capabilities":record.capabilities}),
                ));
            }
            let expected = request["expectedRevision"]
                .as_u64()
                .filter(|r| *r > 0)
                .ok_or("保存前需要当前 expectedRevision")?;
            if expected != record.revision {
                return Err("资源已被其他操作修改，请重新读取后再保存".into());
            }
            if action == "resource_set_enabled" {
                record.enabled = request["enabled"].as_bool().ok_or("enabled 必须是真或假")?;
            } else {
                let changes = request["changes"].as_object().ok_or("changes 必须是对象")?;
                for key in changes.keys() {
                    match key.as_str() {
                        "name" => record.name = text(&request["changes"], "name", 160, true)?,
                        "repository" => {
                            if repository(&request["changes"])? != record.repository {
                                return Err("变更来源需要先预览旧新仓库及发行文件对应关系".into());
                            }
                        }
                        "version" => {
                            if optional_text(&request["changes"], "version", 160)? != record.version
                            {
                                return Err(
                                    "已安装版本不能通过编辑文字改变；请核对实际安装证据".into()
                                );
                            }
                        }
                        "alias" => record.alias = text(&request["changes"], "alias", 160, false)?,
                        "notes" => record.notes = text(&request["changes"], "notes", 4096, false)?,
                        "updatePolicy" => {
                            record.update_policy = update_policy(&request["changes"][key])?
                        }
                        _ => return Err(format!("不允许通过登记编辑修改 {key}")),
                    }
                }
            }
            record.revision = expected.checked_add(1).ok_or("资源修订号超出范围")?;
            record.updated_at = now();
            m.resource_store(StoreRequest::Replace {
                record: Box::new(record),
                expected_revision: expected,
            })?
        }
        _ => return Ok(None),
    };
    crate::resource_lifecycle::scrub_public_receipts(&mut result);
    Ok(Some(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> tempfile::TempDir {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("work/resource-tests");
        std::fs::create_dir_all(&root).unwrap();
        tempfile::tempdir_in(root).unwrap()
    }
    fn register(m: &Manager, root: &Path, name: &str) -> Value {
        handle(m, &json!({"action":"resource_register","name":name,"kind":"cli","rootPath":root,"repository":"https://github.com/example/tool.git"})).unwrap().unwrap()["resource"].clone()
    }
    #[test]
    fn catalog_survives_restart_without_rewriting_legacy_state_or_resource_files() {
        let fixture = fixture();
        let root = fixture.path().join("tool");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("local-config.txt"), "original config").unwrap();
        let state = fixture.path().join("state");
        let mut m = Manager::new(state.clone()).unwrap();
        m.state
            .skills
            .push(json!({"id":"existing-skill","name":"original"}));
        m.state.settings["privateSetting"] = json!("preserved");
        m.save().unwrap();
        let db = Connection::open(state.join("manager.sqlite3")).unwrap();
        let original: String = db
            .query_row("SELECT payload FROM app_state WHERE id=1", [], |r| r.get(0))
            .unwrap();
        let record = register(&m, &root, "First");
        assert!(record["version"].is_null());
        assert_eq!(record["repository"], "https://github.com/example/tool");
        assert_eq!(record["actions"], json!([]));
        let changed = handle(&m, &json!({"action":"resource_update","id":record["id"],"expectedRevision":1,"changes":{"alias":"short name","notes":"local note"}})).unwrap().unwrap();
        assert_eq!(changed["resource"]["revision"], 2);
        let revision = m.snapshot()["stateRevision"].clone();
        drop(m);
        let reopened = Manager::new(state).unwrap();
        assert_eq!(reopened.snapshot()["stateRevision"], revision);
        assert_eq!(reopened.state.skills[0]["id"], "existing-skill");
        assert_eq!(reopened.state.settings["privateSetting"], "preserved");
        let resources = handle(&reopened, &json!({"action":"resource_list"}))
            .unwrap()
            .unwrap();
        assert_eq!(resources["resources"][0]["alias"], "short name");
        assert_eq!(
            std::fs::read_to_string(root.join("local-config.txt")).unwrap(),
            "original config"
        );
        let current: String = db
            .query_row("SELECT payload FROM app_state WHERE id=1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(current, original);
        // The legacy app_state writer must never replace the separate catalog.
        reopened.save().unwrap();
        assert_eq!(
            handle(&reopened, &json!({"action":"resource_list"}))
                .unwrap()
                .unwrap()["resources"][0]["alias"],
            "short name"
        );
    }
    #[test]
    fn rejects_invalid_paths_duplicate_roots_and_stale_edits() {
        let fixture = fixture();
        let root = fixture.path().join("tool");
        std::fs::create_dir(&root).unwrap();
        let m = Manager::new(fixture.path().join("state")).unwrap();
        for path in [
            "relative/path".to_owned(),
            root.join("missing").to_string_lossy().into_owned(),
        ] {
            assert!(handle(
                &m,
                &json!({"action":"resource_register","name":"bad","kind":"cli","rootPath":path})
            )
            .is_err());
        }
        let record = register(&m, &root, "First");
        assert!(handle(&m, &json!({"action":"resource_register","name":"duplicate","kind":"cli","rootPath":root.join(".")})).is_err());
        handle(&m, &json!({"action":"resource_set_enabled","id":record["id"],"expectedRevision":1,"enabled":false})).unwrap();
        assert!(handle(&m, &json!({"action":"resource_update","id":record["id"],"expectedRevision":1,"changes":{"notes":"stale"}})).is_err());
        assert!(handle(&m, &json!({"action":"resource_update","id":record["id"],"expectedRevision":2,"changes":{"name":"changed","ownership":"managed"}})).is_err());
        let result = handle(&m, &json!({"action":"resource_list"}))
            .unwrap()
            .unwrap();
        assert_eq!(result["resources"][0]["name"], "First");
        assert_eq!(result["resources"][0]["notes"], "");
        assert_eq!(result["resources"][0]["enabled"], false);
    }
    #[test]
    fn replacing_runtime_root_keeps_unique_catalog_identity_and_rejects_collisions() {
        let fixture = fixture();
        let m = Manager::new(fixture.path().join("state")).unwrap();
        let first = fixture.path().join("v1");
        let next = fixture.path().join("v2");
        let occupied = fixture.path().join("other");
        for path in [&first, &next, &occupied] {
            std::fs::create_dir(path).unwrap();
        }
        let original = register(&m, &first, "Original");
        register(&m, &occupied, "Other");
        let mut changed: ResourceRecord = serde_json::from_value(original).unwrap();
        changed.root_path = crate::local::canonical(&next)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        changed.revision += 1;
        m.resource_store(StoreRequest::Replace {
            record: Box::new(changed.clone()),
            expected_revision: 1,
        })
        .unwrap();
        assert!(handle(
            &m,
            &json!({"action":"resource_register","name":"duplicate","kind":"cli","rootPath":next})
        )
        .is_err());
        register(&m, &first, "Old location is no longer current");
        let before = m.snapshot();
        let mut collision = changed.clone();
        collision.root_path = crate::local::canonical(&occupied)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        collision.revision += 1;
        assert!(m
            .resource_store(StoreRequest::Replace {
                record: Box::new(collision),
                expected_revision: 2
            })
            .is_err());
        let after = m.resource_store(StoreRequest::Get(changed.id)).unwrap();
        assert_eq!(after["rootPath"], json!(changed.root_path));
        assert_eq!(after["revision"], 2);
        assert_eq!(m.snapshot(), before);
    }
    #[test]
    fn repository_validation_rejects_credentials_and_ambiguous_sources() {
        for url in [
            "http://github.com/owner/repo",
            "https://github.com.evil/owner/repo",
            "https://token@github.com/owner/repo",
            "https://github.com/owner/repo?token=hidden",
            "https://github.com/owner/repo/tree/main",
            "https://github.com/owner/repo#fragment",
            "https://github.com/owner/%72epo",
        ] {
            assert!(repository(&json!({"repository":url})).is_err(), "{url}");
        }
        assert!(repository(&json!({"repository":""})).unwrap().is_none());
    }
    #[test]
    fn worker_requests_use_single_writer_and_preserve_insertion_order() {
        let fixture = fixture();
        let first = fixture.path().join("first");
        let second = fixture.path().join("second");
        std::fs::create_dir(&first).unwrap();
        std::fs::create_dir(&second).unwrap();
        let service =
            crate::tasks::TaskSystem::new(Manager::new(fixture.path().join("state")).unwrap())
                .unwrap();
        let one = service.execute(json!({"action":"resource_register","name":"Z first","kind":"cli","rootPath":first}), crate::dispatch).unwrap()["resource"].clone();
        service.execute(json!({"action":"resource_register","name":"A second","kind":"mcp","rootPath":second}), crate::dispatch).unwrap();
        service.execute(json!({"action":"resource_set_enabled","id":one["id"],"expectedRevision":1,"enabled":false}), crate::dispatch).unwrap();
        let list = service
            .execute(json!({"action":"resource_list"}), crate::dispatch)
            .unwrap();
        assert_eq!(list["resources"][0]["name"], "Z first");
        assert_eq!(list["resources"][1]["name"], "A second");
        assert_eq!(list["resources"][0]["enabled"], false);
    }

    #[test]
    fn catalog_events_are_emitted_only_after_successful_writes() {
        use std::sync::{Arc, Mutex};
        let fixture = fixture();
        let root = fixture.path().join("tool");
        std::fs::create_dir(&root).unwrap();
        let mut m = Manager::new(fixture.path().join("state")).unwrap();
        let observed = Arc::new(Mutex::new(Vec::new()));
        let events = observed.clone();
        m.set_state_events(Arc::new(move |revision| {
            events.lock().unwrap().push(revision)
        }));
        let record = register(&m, &root, "Original");
        handle(&m, &json!({"action":"resource_list"})).unwrap();
        assert!(handle(&m, &json!({"action":"resource_update","id":record["id"],"expectedRevision":100,"changes":{"name":"stale"}})).is_err());
        assert_eq!(observed.lock().unwrap().len(), 1);
        let state = m.snapshot();
        assert_eq!(state["stateRevision"], observed.lock().unwrap()[0]);
        assert!(state.get("resources").is_none());
        let capabilities = handle(
            &m,
            &json!({"action":"resource_capabilities","id":record["id"]}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(capabilities["capabilities"][1]["status"], "unverified");
        assert_eq!(capabilities["actions"], json!([]));
    }
}
