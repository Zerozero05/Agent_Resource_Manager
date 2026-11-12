//! Native-confirmed preparation of the two reviewed package recipes.
//! Persistent sessions are evidence, never an execution grant. Every write needs
//! a fresh volatile preview and the task service's existing maintenance locks.
use super::*;
use crate::resources::ResourceRecord;
use rusqlite::{params, Connection, OptionalExtension};

const SESSION_TABLE: &str = "resource_package_sessions";
const PREVIEW_LIFETIME_MS: i64 = 600_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResourceBinding {
    pub record: ResourceRecord,
    pub root_identity: String,
    pub relations: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreparationInput {
    recipe: Recipe,
    version: String,
    runtime: BuilderRuntime,
    work: PathBuf,
    work_identity: String,
    downloads: PathBuf,
    downloads_identity: String,
    destination: PathBuf,
    rate: u64,
    wheel: Option<ArtifactBinding>,
    wheel_download_id: Option<String>,
    binding: Option<ResourceBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    automatic: Option<super::automation::AutomaticBinding>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "recipe", content = "prepared", rename_all = "camelCase")]
enum PreparedSource {
    AgentReachWheelV1(Box<ReachResolution>),
    EdgeMcpNpmV1(NpmClosure),
}

/// Stored only in the private manager database, excluded from settings exports.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackageSession {
    pub id: String,
    pub revision: u64,
    input: PreparationInput,
    prepared: Option<PreparedSource>,
    download: Option<PackageDownloadReceipt>,
    pub receipt: Option<RuntimePackageReceipt>,
    materialized_root_identity: Option<String>,
    status: String,
    error: Option<String>,
    created_at: String,
    updated_at: String,
}

pub(crate) enum StoreRequest {
    List,
    Get(String),
    Save {
        session: Box<PackageSession>,
        expected_revision: Option<u64>,
    },
}
impl StoreRequest {
    pub(crate) fn writes(&self) -> bool {
        matches!(self, Self::Save { .. })
    }
}

fn exists(db: &Connection) -> Result<bool, String> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [SESSION_TABLE],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// The live writer alone calls this. Reading an absent table does not initialize
/// it, including in Basic mode. CAS protects competing workers and stale previews.
pub(crate) fn store(db: &Connection, request: StoreRequest) -> Result<Value, String> {
    if !exists(db)? {
        if !request.writes() {
            return Ok(match request {
                StoreRequest::List => json!({"sessions":[]}),
                _ => Value::Null,
            });
        }
        db.execute_batch("CREATE TABLE resource_package_sessions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0), payload TEXT NOT NULL)")
            .map_err(|e| e.to_string())?;
    }
    match request {
        StoreRequest::List => {
            let mut statement = db
                .prepare("SELECT payload FROM resource_package_sessions ORDER BY rowid DESC")
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            let mut sessions = Vec::new();
            for row in rows {
                let row = row.map_err(|e| e.to_string())?;
                let session: PackageSession =
                    serde_json::from_str(&row).map_err(|_| "包准备记录不可读取，原记录保留")?;
                sessions.push(session.summary());
            }
            Ok(json!({"sessions":sessions}))
        }
        StoreRequest::Get(id) => {
            let payload: Option<String> = db
                .query_row(
                    "SELECT payload FROM resource_package_sessions WHERE id=?1",
                    [id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            payload
                .map(|p| {
                    serde_json::from_str(&p).map_err(|_| "包准备记录不可读取，原记录保留".into())
                })
                .transpose()
                .map(|v| v.unwrap_or(Value::Null))
        }
        StoreRequest::Save {
            session,
            expected_revision,
        } => {
            validate_id(&session.id)?;
            let next = expected_revision
                .unwrap_or(0)
                .checked_add(1)
                .filter(|r| *r <= i64::MAX as u64)
                .ok_or("包准备修订号超出范围")?;
            if session.revision != next {
                return Err("包准备修订号不连续".into());
            }
            if let Some(expected) = expected_revision {
                let previous: Option<String> = db
                    .query_row(
                        "SELECT payload FROM resource_package_sessions WHERE id=?1 AND revision=?2",
                        params![session.id, expected],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                let previous: PackageSession =
                    serde_json::from_str(&previous.ok_or("包准备记录已变化，请重新读取并预览")?)
                        .map_err(|_| "原包准备记录不可读取")?;
                validate_transition(&previous, &session)?;
            } else if session.status != "preparing"
                || session.prepared.is_some()
                || session.download.is_some()
                || session.receipt.is_some()
            {
                return Err("新包准备记录须从本机确认的准备初态开始".into());
            }
            let payload = serde_json::to_string(&session).map_err(|e| e.to_string())?;
            if payload.len() > 16 * 1024 * 1024 {
                return Err("包准备记录超过有限范围".into());
            }
            let changed = if let Some(expected)=expected_revision {
                db.execute("UPDATE resource_package_sessions SET revision=?1,payload=?2 WHERE id=?3 AND revision=?4",params![next,payload,session.id,expected])
            } else {
                db.execute("INSERT OR IGNORE INTO resource_package_sessions(id,revision,payload)VALUES(?1,?2,?3)",params![session.id,next,payload])
            }.map_err(|e|e.to_string())?;
            if changed != 1 {
                return Err("包准备记录已变化，请重新读取并预览".into());
            }
            Ok(json!(session))
        }
    }
}

fn validate_transition(previous: &PackageSession, next: &PackageSession) -> Result<(), String> {
    if previous.id != next.id
        || previous.created_at != next.created_at
        || serde_json::to_value(&previous.input).map_err(|e| e.to_string())?
            != serde_json::to_value(&next.input).map_err(|e| e.to_string())?
    {
        return Err("已有准备记录的来源、保存位置或资源绑定不能被覆盖".into());
    }
    if previous.prepared.is_some()
        && serde_json::to_value(&previous.prepared).map_err(|e| e.to_string())?
            != serde_json::to_value(&next.prepared).map_err(|e| e.to_string())?
    {
        return Err("已有精确解析来源不能被替换".into());
    }
    if let Some(old) = &previous.download {
        let new = next.download.as_ref().ok_or("不能丢弃已有下载事实")?;
        // Compare immutable source facts without reading partial files: a
        // vanished/changed partial is still a fact that must remain journaled.
        if serde_json::to_value(old).map_err(|e| e.to_string())?["plan"]
            != serde_json::to_value(new).map_err(|e| e.to_string())?["plan"]
        {
            return Err("续传不能替换原精确资产计划".into());
        }
    }
    if let Some(old) = &previous.receipt {
        let new = next
            .receipt
            .as_ref()
            .ok_or("不能丢弃已有最终目录创建事实")?;
        let immutable_changed = old.complete
            || old.recipe != new.recipe
            || old.root != new.root
            || old.plan_hash != new.plan_hash
            || serde_json::to_value(&old.source_artifacts).map_err(|e| e.to_string())?
                != serde_json::to_value(&new.source_artifacts).map_err(|e| e.to_string())?
            || serde_json::to_value(&old.runtime).map_err(|e| e.to_string())?
                != serde_json::to_value(&new.runtime).map_err(|e| e.to_string())?;
        if immutable_changed
            && serde_json::to_value(old).map_err(|e| e.to_string())?
                != serde_json::to_value(new).map_err(|e| e.to_string())?
        {
            return Err("已有最终目录的绑定事实不能被替换".into());
        }
    }
    Ok(())
}

fn allowed(request: &Value, keys: &[&str]) -> Result<(), String> {
    if request
        .as_object()
        .is_none_or(|o| o.keys().any(|k| !keys.contains(&k.as_str())))
    {
        Err("包准备请求包含未批准的字段".into())
    } else {
        Ok(())
    }
}
fn text<'a>(request: &'a Value, key: &str, limit: usize) -> Result<&'a str, String> {
    request[key]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= limit && !s.chars().any(char::is_control))
        .ok_or_else(|| format!("{key} 缺失或无效"))
}
fn validate_id(id: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| "包准备标识无效".into())
}
fn normal(manager: &Manager) -> Result<(), String> {
    if manager.basic_mode {
        Err("基本模式只读取包准备记录，不解析、下载或创建运行环境".into())
    } else {
        Ok(())
    }
}
fn directory(value: &Value, key: &str) -> Result<(PathBuf, String), String> {
    let path = PathBuf::from(text(value, key, 32767)?);
    if !path.is_absolute() {
        return Err(format!("{key} 必须是绝对路径"));
    }
    crate::transaction::verify_root(&path)?;
    if !path.is_dir() {
        return Err(format!("{key} 须为本次选择的已有目录"));
    }
    let path = crate::local::canonical(&path)?;
    let identity = crate::clients::file_identity(&path)?;
    Ok((path, identity))
}
fn read_resource(manager: &Manager, id: &str) -> Result<ResourceRecord, String> {
    serde_json::from_value(manager.resource_store(crate::resources::StoreRequest::Get(id.into()))?)
        .map_err(|e| e.to_string())
}
fn relation_binding(manager: &Manager, id: &str) -> Result<Value, String> {
    let value = manager.relation_store(crate::resource_relations::StoreRequest::List {
        endpoint: crate::resource_relations::Endpoint {
            kind: "tool".into(),
            id: id.into(),
        },
    })?;
    Ok(
        json!({"revision":value["revision"],"dependencies":value["dependencies"],"dependents":value["dependents"],"endpoint":value["endpoint"]}),
    )
}
fn resource_binding(manager: &Manager, request: &Value) -> Result<Option<ResourceBinding>, String> {
    let Some(id) = request.get("resourceId").filter(|v| !v.is_null()) else {
        if request
            .get("expectedRevision")
            .is_some_and(|v| !v.is_null())
        {
            return Err("修订号必须对应既有资源".into());
        }
        return Ok(None);
    };
    let record = read_resource(manager, id.as_str().ok_or("资源标识无效")?)?;
    if request["expectedRevision"].as_u64() != Some(record.revision) {
        return Err("资源已变化，请重新读取".into());
    }
    crate::resource_update::verify_registered_runtime(&record)?;
    let root_identity = crate::clients::file_identity(Path::new(&record.root_path))?;
    Ok(Some(ResourceBinding {
        relations: relation_binding(manager, &record.id)?,
        record,
        root_identity,
    }))
}
impl PreparationInput {
    fn verify(&self, manager: &Manager) -> Result<(), String> {
        normal(manager)?;
        super::automation::validate_write_locations(
            &self.runtime,
            &[&self.work, &self.downloads, &self.destination],
            self.binding
                .as_ref()
                .map(|b| Path::new(&b.record.root_path)),
        )?;
        for (path, identity) in [
            (&self.work, &self.work_identity),
            (&self.downloads, &self.downloads_identity),
        ] {
            crate::transaction::verify_root(path)?;
            if crate::clients::file_identity(path)? != *identity {
                return Err("包准备保存位置已被替换".into());
            }
        }
        if let Some(binding) = &self.binding {
            let current = read_resource(manager, &binding.record.id)?;
            if serde_json::to_value(&current).map_err(|e| e.to_string())?
                != serde_json::to_value(&binding.record).map_err(|e| e.to_string())?
                || crate::clients::file_identity(Path::new(&current.root_path))?
                    != binding.root_identity
                || relation_binding(manager, &current.id)? != binding.relations
            {
                return Err(
                    "原版本、安装记录、启用状态、策略或使用关系已变化，须重新准备预览".into(),
                );
            }
            crate::resource_update::verify_registered_runtime(&current)?;
            crate::resource_lifecycle::ensure_independent_update_destination(
                manager,
                &self.destination,
                &current.id,
            )?;
        } else {
            crate::resource_lifecycle::ensure_independent_destination(manager, &self.destination)?;
        }
        match &self.runtime {
            BuilderRuntime::PythonPip(pip) => pip.recheck()?,
            BuilderRuntime::Node(node) => node.recheck()?,
        }
        if let Some(wheel) = &self.wheel {
            if resource_files::fingerprint(&wheel.path)? != wheel.file {
                return Err("已核实主 wheel 已变化".into());
            }
        }
        Ok(())
    }
    fn current_root<'a>(&'a self, manager: &'a Manager) -> &'a Path {
        self.binding
            .as_ref()
            .map(|b| Path::new(&b.record.root_path))
            .unwrap_or(manager.data_dir.as_path())
    }
}
impl PackageSession {
    /// Phase admission and lifecycle commit call this. Saving an already observed
    /// partial receipt must remain possible after eligibility changes; that
    /// journal write never grants another phase or a reusable execution right.
    pub(crate) fn verify_binding(&self, manager: &Manager) -> Result<(), String> {
        self.input.verify(manager)
    }
    pub(crate) fn resource_id(&self) -> Option<&str> {
        self.input.binding.as_ref().map(|b| b.record.id.as_str())
    }
    fn summary(&self) -> Value {
        json!({"id":self.id,"revision":self.revision,"recipe":self.input.recipe,"version":self.input.version,"resourceId":self.resource_id(),"destinationPath":self.input.destination,"downloadDirectory":self.input.downloads,"workingDirectory":self.input.work,"runtimePaths":super::automation::runtime_paths(&self.input.runtime),"status":self.status,"error":self.error,"downloadComplete":self.download.as_ref().is_some_and(|d|d.complete),"materialized":self.receipt.as_ref().is_some_and(|r|r.complete),"executionVerified":false,"createdAt":self.created_at,"updatedAt":self.updated_at})
    }
}
fn load(manager: &Manager, id: &str) -> Result<PackageSession, String> {
    validate_id(id)?;
    let value = manager.resource_package_store(StoreRequest::Get(id.into()))?;
    if value.is_null() {
        return Err("包准备记录不存在".into());
    }
    serde_json::from_value(value).map_err(|_| "包准备记录不可读取，原记录保留".into())
}
fn save(
    manager: &Manager,
    session: &mut PackageSession,
    expected: Option<u64>,
) -> Result<(), String> {
    let mut candidate = session.clone();
    candidate.revision = expected
        .unwrap_or(0)
        .checked_add(1)
        .ok_or("修订号超出范围")?;
    candidate.updated_at = crate::model::now();
    // Actual partial/failed evidence must survive cancellation after the child or
    // transfer has stopped. The live writer still enforces Basic/maintenance/CAS.
    manager.resource_package_store(StoreRequest::Save {
        session: Box::new(candidate.clone()),
        expected_revision: expected,
    })?;
    *session = candidate;
    Ok(())
}

fn remember(
    manager: &mut Manager,
    kind: &str,
    mut public: Value,
    prepared: Value,
) -> Result<Value, String> {
    let id = uuid::Uuid::new_v4().to_string();
    public["id"] = json!(id);
    public["canApply"] = json!(true);
    manager.previews.insert(id,json!({"kind":kind,"resourceId":public["resourceId"],"targetPath":public["targetPath"],"archivePath":public["source"]["path"],"public":public,"prepared":prepared,"createdAt":chrono::Utc::now().timestamp_millis()}));
    let cutoff = chrono::Utc::now().timestamp_millis() - PREVIEW_LIFETIME_MS;
    let mut ids: Vec<_> = manager
        .previews
        .iter()
        .filter(|(_, p)| {
            p["kind"]
                .as_str()
                .is_some_and(|s| s.starts_with("resourcePackage"))
        })
        .map(|(id, p)| (p["createdAt"].as_i64().unwrap_or(0), id.clone()))
        .collect();
    ids.sort();
    let count = ids.len();
    for (index, (created, id)) in ids.into_iter().enumerate() {
        if created < cutoff || index + 32 < count {
            manager.previews.remove(&id);
        }
    }
    Ok(public)
}
fn prepare_preview(manager: &mut Manager, request: &Value) -> Result<Value, String> {
    normal(manager)?;
    allowed(
        request,
        &[
            "action",
            "recipe",
            "version",
            "runtimePath",
            "workDirectory",
            "downloadDirectory",
            "destinationPath",
            "bytesPerSecond",
            "archivePath",
            "downloadId",
            "resourceId",
            "expectedRevision",
        ],
    )?;
    let recipe = match text(request, "recipe", 64)? {
        "agentReachWheelV1" => Recipe::AgentReachWheelV1,
        "edgeMcpNpmV1" => Recipe::EdgeMcpNpmV1,
        _ => return Err("仅支持已核对的 Agent Reach wheel 和 Edge MCP npm 配方".into()),
    };
    let version = text(request, "version", 128)?.to_owned();
    if !exact_version(&version) {
        return Err("请选择明确的包版本".into());
    }
    let (work, work_identity) = directory(request, "workDirectory")?;
    let (downloads, downloads_identity) = directory(request, "downloadDirectory")?;
    let binding = resource_binding(manager, request)?;
    let runtime_path = PathBuf::from(text(request, "runtimePath", 32767)?);
    let runtime = match recipe {
        Recipe::AgentReachWheelV1 => BuilderRuntime::PythonPip(PipRuntime::inspect(&runtime_path)?),
        Recipe::EdgeMcpNpmV1 => BuilderRuntime::Node(RuntimeBinding::inspect(&runtime_path)?),
    };
    let destination = fresh_final_path(
        &manager.data_dir,
        binding
            .as_ref()
            .map(|b| Path::new(&b.record.root_path))
            .unwrap_or(&manager.data_dir),
        &PathBuf::from(text(request, "destinationPath", 32767)?),
    )?;
    if destination.starts_with(&work)
        || work.starts_with(&destination)
        || destination.starts_with(&downloads)
        || downloads.starts_with(&destination)
    {
        return Err("准备、下载和最终运行位置必须互不嵌套".into());
    }
    let rate = request
        .get("bytesPerSecond")
        .map(|v| v.as_u64().ok_or("下载限速无效"))
        .transpose()?
        .unwrap_or(0);
    if rate != 0 && !(1024..=1024 * 1024 * 1024).contains(&rate) {
        return Err("下载限速范围无效".into());
    }
    let (wheel, wheel_download_id) = if recipe == Recipe::AgentReachWheelV1 {
        let id = text(request, "downloadId", 64)?.to_owned();
        let (wheel, inspected) = bind_reach_wheel(
            manager,
            &PathBuf::from(text(request, "archivePath", 32767)?),
            &id,
        )?;
        if inspected.version != version {
            return Err("所选版本与实际官方 wheel 不一致".into());
        }
        (Some(wheel), Some(id))
    } else {
        if request.get("archivePath").is_some() || request.get("downloadId").is_some() {
            return Err("npm 配方从官方精确 registry 元数据解析，不接受 wheel 资产".into());
        }
        (None, None)
    };
    let input = PreparationInput {
        recipe: recipe.clone(),
        version: version.clone(),
        runtime,
        work,
        work_identity,
        downloads,
        downloads_identity,
        destination,
        rate,
        wheel,
        wheel_download_id,
        binding,
        automatic: None,
    };
    input.verify(manager)?;
    let mut public = json!({"kind":"runtimePackagePreparation","recipe":recipe,"version":version,"targetPath":input.destination,"workingDirectory":input.work,"downloadDirectory":input.downloads,"runtimePaths":super::automation::runtime_paths(&input.runtime),"bytesPerSecond":rate,"source":input.wheel,"installsFiles":false,"executionVerified":false,"resourceId":input.binding.as_ref().map(|b|&b.record.id)});
    if recipe == Recipe::AgentReachWheelV1 {
        public["network"] = json!({"hosts":["pypi.org","files.pythonhosted.org"],"purpose":"解析兼容的预编译 wheel 闭包并核对官方精确元数据","resolverMayDownloadWheels":true,"resolverDownloadsRateLimited":false,"finalArtifactDownloadsRateLimited":true,"temporaryCacheParent":input.work});
        public["warning"]=json!("本步会启动已核对的本机 Python/pip；pip 解析可能下载元数据或完整 wheel，保存于所选工作目录的专用子目录，解析下载不受管理器资产限速。仅允许预编译 wheel，无源码构建或安装；确认后才开始。");
    } else {
        public["network"] = json!({"hosts":["registry.npmjs.org"],"purpose":"只读取已选版本及两个精确依赖的元数据","downloadsArchives":false});
        public["warning"]=json!("本步只读取官方 npm 精确版本元数据，不运行 npm 脚本、不安装浏览器，也不读取现有浏览器登录资料。");
    }
    remember(
        manager,
        "resourcePackagePrepare",
        public,
        serde_json::to_value(input).map_err(|e| e.to_string())?,
    )
}
fn session_preview(manager: &mut Manager, request: &Value, step: &str) -> Result<Value, String> {
    normal(manager)?;
    allowed(request, &["action", "sessionId"])?;
    let session = load(manager, text(request, "sessionId", 64)?)?;
    session.verify_binding(manager)?;
    if session.receipt.is_some() {
        return Err("最终运行目录已有真实创建记录，不能重复安装；请查看该记录".into());
    }
    let (kind, mut public, prepared) = match step {
        "download" => {
            if session.download.is_some() {
                return Err("已有下载记录，请读取记录并使用显式继续预览".into());
            }
            let plan = match session.prepared.as_ref().ok_or("尚未完成官方依赖解析")? {
                PreparedSource::AgentReachWheelV1(r) => {
                    PackageDownloadPlan::reach(r, &session.input.downloads, session.input.rate)?
                }
                PreparedSource::EdgeMcpNpmV1(c) => {
                    PackageDownloadPlan::edge(c, &session.input.downloads, session.input.rate)?
                }
            };
            (
                "resourcePackageDownload",
                plan.preview(),
                serde_json::to_value(plan).map_err(|e| e.to_string())?,
            )
        }
        "resume" => {
            let receipt = session
                .download
                .as_ref()
                .ok_or("没有可继续的依赖下载记录")?;
            if receipt.complete {
                return Err("依赖下载已完成，请预览准备最终运行目录".into());
            }
            (
                "resourcePackageResume",
                receipt.preview_resume()?,
                receipt.preview_resume()?,
            )
        }
        "materialize" => {
            let receipt = session.download.as_ref().ok_or("尚无完整依赖下载回执")?;
            let (public, prepared) = match session.prepared.clone().ok_or("依赖解析记录缺失")?
            {
                PreparedSource::AgentReachWheelV1(r) => {
                    let ready = ReadyReachPlan::from_downloads(
                        *r,
                        receipt,
                        &manager.data_dir,
                        session.input.current_root(manager),
                        &session.input.destination,
                        &session.input.work,
                    )?;
                    (
                        ready.preview(),
                        json!({"recipe":"agentReachWheelV1","plan":ready}),
                    )
                }
                PreparedSource::EdgeMcpNpmV1(c) => {
                    let BuilderRuntime::Node(runtime) = &session.input.runtime else {
                        return Err("npm 运行时绑定不一致".into());
                    };
                    let ready = ReadyNpmPlan::from_downloads(
                        c,
                        receipt,
                        &manager.data_dir,
                        session.input.current_root(manager),
                        &session.input.destination,
                        &runtime.path,
                    )?;
                    (
                        ready.preview(),
                        json!({"recipe":"edgeMcpNpmV1","plan":ready}),
                    )
                }
            };
            ("resourcePackageMaterialize", public, prepared)
        }
        _ => return Err("包准备阶段无效".into()),
    };
    public["sessionId"] = json!(session.id);
    public["sessionRevision"] = json!(session.revision);
    public["resourceId"] = json!(session.resource_id());
    public["runtimePaths"] = json!(super::automation::runtime_paths(&session.input.runtime));
    remember(
        manager,
        kind,
        public,
        json!({"sessionId":session.id,"revision":session.revision,"value":prepared}),
    )
}

pub(crate) fn handle(manager: &mut Manager, request: &Value) -> Result<Option<Value>, String> {
    Ok(Some(match request["action"].as_str().unwrap_or_default() {
        "resource_package_sessions" => {
            allowed(request, &["action", "sessionId"])?;
            if request.get("sessionId").is_some() {
                load(manager, text(request, "sessionId", 64)?)?.summary()
            } else {
                manager.resource_package_store(StoreRequest::List)?
            }
        }
        "preview_resource_package_prepare" => prepare_preview(manager, request)?,
        "preview_resource_package_download" => session_preview(manager, request, "download")?,
        "preview_resource_package_resume" => session_preview(manager, request, "resume")?,
        "preview_resource_package_materialize" => session_preview(manager, request, "materialize")?,
        "apply_resource_package_prepare"
        | "apply_resource_package_download"
        | "apply_resource_package_resume"
        | "apply_resource_package_materialize" => {
            return Err(
                "请在管理器本机界面检查本次预览后确认；Agent 接口不能直接应用运行包操作".into(),
            )
        }
        _ => return Ok(None),
    }))
}

fn apply_prepare(manager: &Manager, prepared: Value) -> Result<Value, String> {
    let input: PreparationInput =
        serde_json::from_value(prepared).map_err(|_| "内部准备预览不可读取")?;
    input.verify(manager)?;
    let mut session = PackageSession {
        id: uuid::Uuid::new_v4().to_string(),
        revision: 0,
        input,
        prepared: None,
        download: None,
        receipt: None,
        materialized_root_identity: None,
        status: "preparing".into(),
        error: None,
        created_at: crate::model::now(),
        updated_at: crate::model::now(),
    };
    save(manager, &mut session, None)?;
    let prepared = (|| match &session.input.runtime {
        BuilderRuntime::PythonPip(pip) => {
            let wheel = session.input.wheel.as_ref().ok_or("官方主 wheel 缺失")?;
            let r = ReachResolution::resolve(
                manager,
                &wheel.path,
                session
                    .input
                    .wheel_download_id
                    .as_deref()
                    .ok_or("官方主 wheel 回执缺失")?,
                pip.clone(),
                &session.input.work,
            )?;
            Ok(PreparedSource::AgentReachWheelV1(Box::new(r)))
        }
        BuilderRuntime::Node(_) => {
            resolve_edge_registry(&session.input.version).map(PreparedSource::EdgeMcpNpmV1)
        }
    })();
    let prepared = prepared.and_then(|source| {
        if let Some(binding) = &session.input.automatic {
            let mut packages = match &source {
                PreparedSource::AgentReachWheelV1(reach) => {
                    let mut names = reach
                        .dependencies
                        .iter()
                        .map(|p| p.package.clone())
                        .collect::<Vec<_>>();
                    names.push("agent-reach".into());
                    names
                }
                PreparedSource::EdgeMcpNpmV1(closure) => {
                    if binding.metadata_hash.as_deref() != Some(closure.metadata_hash.as_str()) {
                        return Err("官方 npm 精确元数据已不同于本次来源观察，未下载或安装".into());
                    }
                    closure
                        .packages
                        .iter()
                        .map(|p| p.package.clone())
                        .collect::<Vec<_>>()
                }
            };
            packages.sort();
            if packages != binding.permitted_packages {
                return Err("新版本依赖包名集合超出原许可，须重新核对授权".into());
            }
        }
        Ok(source)
    });
    match prepared {
        Ok(p) => {
            session.prepared = Some(p);
            session.status = "resolved".into();
        }
        Err(e) => {
            session.status = "prepareFailed".into();
            session.error = Some(e);
        }
    }
    let revision = session.revision;
    save(manager, &mut session, Some(revision))?;
    Ok(
        json!({"session":session.summary(),"complete":session.prepared.is_some(),"installed":false,"executionVerified":false}),
    )
}

/// Only the private automatic dispatcher can seal this correlation. The native
/// request allowlist has no corresponding input field.
pub(crate) fn bind_automatic_prepare(
    manager: &mut Manager,
    preview_id: &str,
    binding: super::automation::AutomaticBinding,
) -> Result<(), String> {
    let preview = manager
        .previews
        .get(preview_id)
        .ok_or("自动运行包准备预览不存在")?;
    if preview["kind"] != "resourcePackagePrepare" {
        return Err("自动准备预览类型不符".into());
    }
    let mut input: PreparationInput =
        serde_json::from_value(preview["prepared"].clone()).map_err(|_| "自动准备依据不可读")?;
    if input.automatic.is_some()
        || input.version != binding.version.trim_start_matches('v')
        || input.binding.as_ref().map(|b| b.record.id.as_str())
            != Some(binding.resource_id.as_str())
    {
        return Err("自动准备的资源、版本或私有绑定不符".into());
    }
    input.verify(manager)?;
    input.automatic = Some(binding);
    manager
        .previews
        .get_mut(preview_id)
        .ok_or("自动准备预览已变化")?["prepared"] = json!(input);
    Ok(())
}
pub(crate) fn automatic_session(
    manager: &Manager,
    session_id: &str,
    binding: &super::automation::AutomaticBinding,
) -> Result<Value, String> {
    let session = load(manager, session_id)?;
    if session.input.automatic.as_ref() != Some(binding) {
        return Err("准备会话不属于本次自动许可及来源观察，未重放".into());
    }
    session.verify_binding(manager)?;
    Ok(session.summary())
}
pub(crate) fn automatic_sessions(
    manager: &Manager,
    binding: &super::automation::AutomaticBinding,
) -> Result<Vec<Value>, String> {
    let list = manager.resource_package_store(StoreRequest::List)?;
    let mut matched = vec![];
    for summary in list["sessions"].as_array().ok_or("准备会话列表不可读取")? {
        let session = load(manager, summary["id"].as_str().ok_or("准备会话标识缺失")?)?;
        if session.input.automatic.as_ref() == Some(binding) {
            matched.push(session.summary());
        }
    }
    Ok(matched)
}
/// Journal projection only; it cannot admit or replay a package phase.
pub(crate) fn automatic_attempt_sessions(
    manager: &Manager,
    attempt_id: &str,
) -> Result<Vec<Value>, String> {
    let list = manager.resource_package_store(StoreRequest::List)?;
    let mut matched = vec![];
    for summary in list["sessions"].as_array().ok_or("准备会话列表不可读取")? {
        let session = load(manager, summary["id"].as_str().ok_or("准备会话标识缺失")?)?;
        if session
            .input
            .automatic
            .as_ref()
            .is_some_and(|b| b.attempt_id == attempt_id)
        {
            matched.push(session.summary());
        }
    }
    if matched.len() > 1 {
        return Err("同一次自动尝试存在多个准备记录，不能自动选择或重放".into());
    }
    Ok(matched)
}

/// Only the native dispatcher calls this. No action accepts a proof, plan,
/// success flag, shell command or caller-supplied prepared session.
pub(crate) fn apply_local(manager: &mut Manager, request: &Value) -> Result<Option<Value>, String> {
    let kind = match request["action"].as_str().unwrap_or_default() {
        "apply_resource_package_prepare" => "resourcePackagePrepare",
        "apply_resource_package_download" => "resourcePackageDownload",
        "apply_resource_package_resume" => "resourcePackageResume",
        "apply_resource_package_materialize" => "resourcePackageMaterialize",
        _ => return Ok(None),
    };
    normal(manager)?;
    allowed(request, &["action", "previewId"])?;
    let id = text(request, "previewId", 64)?;
    let stored = manager
        .previews
        .get(id)
        .ok_or("包准备预览已失效，请重新核对")?;
    if stored["kind"] != kind
        || stored["public"]["canApply"] != true
        || !stored["createdAt"].as_i64().is_some_and(|t| {
            let age = chrono::Utc::now().timestamp_millis() - t;
            (0..=PREVIEW_LIFETIME_MS).contains(&age)
        })
    {
        return Err("包准备预览类型无效或已过期".into());
    }
    let stored = manager.previews.remove(id).ok_or("包准备预览已消费")?;
    if kind == "resourcePackagePrepare" {
        return apply_prepare(manager, stored["prepared"].clone()).map(Some);
    }
    let prepared = &stored["prepared"];
    let mut session = load(manager, text(prepared, "sessionId", 64)?)?;
    if prepared["revision"].as_u64() != Some(session.revision) {
        return Err("包准备记录已变化，请重新预览".into());
    }
    session.verify_binding(manager)?;
    if session.receipt.is_some() {
        return Err("已有最终目录创建记录，不能重复应用".into());
    }
    session.error = None;
    let result: Result<(), String> = (|| {
        match kind {
            "resourcePackageDownload" => {
                if session.download.is_some() {
                    return Err("已有下载记录，不能重放下载".into());
                }
                let plan: PackageDownloadPlan = serde_json::from_value(prepared["value"].clone())
                    .map_err(|_| "内部下载预览不可读取")?;
                session.download = Some(plan.apply_with_checkpoint(|observed| {
                    session.download = Some(observed.clone());
                    session.status = "downloading".into();
                    let revision = session.revision;
                    save(manager, &mut session, Some(revision))
                })?);
                session.status = if session.download.as_ref().is_some_and(|d| d.complete) {
                    "downloaded"
                } else {
                    "downloadInterrupted"
                }
                .into();
            }
            "resourcePackageResume" => {
                let receipt = session.download.clone().ok_or("下载记录缺失")?;
                if receipt.preview_resume()?["transfers"] != prepared["value"]["transfers"] {
                    return Err("部分文件在续传预览后已变化，请重新预览实际长度".into());
                }
                // Keep the last actual receipt if preflight fails before a byte
                // is written. Successful resume replaces it with observed state.
                session.download = Some(receipt.clone());
                session.download = Some(receipt.resume_with_checkpoint(|observed| {
                    session.download = Some(observed.clone());
                    session.status = "downloading".into();
                    let revision = session.revision;
                    save(manager, &mut session, Some(revision))
                })?);
                session.status = if session.download.as_ref().is_some_and(|d| d.complete) {
                    "downloaded"
                } else {
                    "downloadInterrupted"
                }
                .into();
            }
            "resourcePackageMaterialize" => {
                let ready = &prepared["value"];
                let work = session.input.work.clone();
                let mut checkpoint = |observed: &RuntimePackageReceipt| {
                    session.receipt = Some(observed.clone());
                    session.materialized_root_identity =
                        crate::clients::file_identity(&observed.root).ok();
                    session.status = "materializing".into();
                    let revision = session.revision;
                    save(manager, &mut session, Some(revision))
                };
                let receipt = match ready["recipe"].as_str() {
                    Some("agentReachWheelV1") => {
                        serde_json::from_value::<ReadyReachPlan>(ready["plan"].clone())
                            .map_err(|_| "内部 Python 准备预览不可读取")?
                            .materialize_with_checkpoint(&mut checkpoint)?
                    }
                    Some("edgeMcpNpmV1") => {
                        serde_json::from_value::<ReadyNpmPlan>(ready["plan"].clone())
                            .map_err(|_| "内部 npm 准备预览不可读取")?
                            .materialize_with_checkpoint(&work, &mut checkpoint)?
                    }
                    _ => return Err("内部准备配方不一致".into()),
                };
                session.materialized_root_identity =
                    crate::clients::file_identity(&receipt.root).ok();
                session.status = if receipt.complete {
                    "materialized"
                } else {
                    "materializationIncomplete"
                }
                .into();
                session.error = receipt.error.clone();
                session.receipt = Some(receipt);
            }
            _ => return Err("内部包准备阶段不一致".into()),
        }
        Ok(())
    })();
    if let Err(error) = result {
        session.error = Some(error);
        session.status = "failed".into();
    }
    // Rechecked by the live writer at this CAS; no catalog entry is replaced here.
    let revision = session.revision;
    save(manager, &mut session, Some(revision))?;
    Ok(Some(
        json!({"session":session.summary(),"complete":session.error.is_none()&&match kind{"resourcePackageMaterialize"=>session.receipt.as_ref().is_some_and(|r|r.complete),_=>session.download.as_ref().is_some_and(|r|r.complete)},"receipt":session.receipt,"installed":false,"executionVerified":false}),
    ))
}

/// Root lifecycle/update integration consumes only this internally retrieved
/// receipt. It must still run its existing manifest/CAS/capability/switch checks.
#[cfg(test)]
#[cfg(test)]
pub(crate) fn materialized(
    manager: &Manager,
    session_id: &str,
) -> Result<RuntimePackageReceipt, String> {
    Ok(materialized_package(manager, session_id)?.receipt)
}

pub(crate) struct MaterializedPackage {
    pub session_revision: u64,
    pub receipt: RuntimePackageReceipt,
    pub provenance: RuntimePackageProvenance,
    pub binding: Option<ResourceBinding>,
}

pub(crate) fn materialized_package(
    manager: &Manager,
    session_id: &str,
) -> Result<MaterializedPackage, String> {
    let session = load(manager, session_id)?;
    session.verify_binding(manager)?;
    let receipt = session.receipt.ok_or("尚无真实最终目录创建回执")?;
    if receipt.root != session.input.destination
        || !receipt.complete
        || !receipt.dependency_check_passed
        || receipt.execution_verified
        || session.materialized_root_identity.as_deref()
            != Some(crate::clients::file_identity(&receipt.root)?.as_str())
    {
        return Err("运行包准备未完成或目录身份已变化".into());
    }
    let actual = inventory(&receipt.root)?;
    if actual.len() != receipt.files.len()
        || receipt.files.iter().any(|f| {
            actual.get(&f.path).map(|v| v.sha256.as_str()) != Some(f.installed_sha256.as_str())
        })
    {
        return Err("最终运行目录内容与实际创建回执不同".into());
    }
    let provenance = RuntimePackageProvenance {
        schema_version: 1,
        recipe: receipt.recipe.clone(),
        version: session.input.version,
        plan_hash: receipt.plan_hash.clone(),
        source_artifacts: receipt.source_artifacts.clone(),
        runtime: receipt.runtime.clone(),
    };
    provenance.validate_source()?;
    Ok(MaterializedPackage {
        session_revision: session.revision,
        receipt,
        provenance,
        binding: session.input.binding,
    })
}

#[cfg(test)]
#[path = "controller/tests.rs"]
mod tests;
