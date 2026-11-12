//! Explicit native-window authorization. Policy flags, imports, source records
//! and successful version checks cannot create this non-exported permission.
use crate::{
    model::{now, Manager},
    resource_files::{self, FileRole},
    resources::{ResourceRecord, StoreRequest as Catalog},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AutomationScope {
    pub repository: String,
    pub repository_id: u64,
    pub source_fingerprint: String,
    pub constraint_fingerprint: String,
    pub original_root: PathBuf,
    pub original_root_id: String,
    pub candidate_parent_path: PathBuf,
    pub candidate_parent_id: String,
    pub download_directory: PathBuf,
    pub download_directory_id: String,
    pub channel: String,
    pub asset_name: String,
    pub files: BTreeMap<String, FileRole>,
    pub pinned_version: Option<String>,
    pub skipped_versions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_package: Option<package::PackageScope>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AutomationGrant {
    pub resource_id: String,
    pub revision: u64,
    pub enabled: bool,
    pub updated_at: String,
    pub scope: Option<AutomationScope>,
}
pub(crate) enum StoreRequest {
    Get(String),
    List,
    Attempts(String),
    LatestAttempt {
        resource_id: String,
        grant_revision: u64,
        version: String,
    },
    ClaimAttempt {
        expected_resource: Box<ResourceRecord>,
        expected_grant_revision: u64,
        attempt: Box<engine::Attempt>,
    },
    SaveAttempt {
        expected: Box<engine::Attempt>,
        attempt: Box<engine::Attempt>,
    },
    Apply {
        expected_resource: Box<ResourceRecord>,
        expected_grant_revision: u64,
        grant: Box<AutomationGrant>,
    },
}
impl StoreRequest {
    pub(crate) fn writes(&self) -> bool {
        matches!(
            self,
            Self::Apply { .. } | Self::ClaimAttempt { .. } | Self::SaveAttempt { .. }
        )
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Phase {
    BeforeDownload,
    BeforeCommit,
}
pub(crate) struct CandidateScope {
    pub repository: String,
    pub repository_id: u64,
    pub version: String,
    pub channel: String,
    pub asset_name: String,
    pub files: BTreeMap<String, FileRole>,
}
#[derive(Serialize, Deserialize)]
struct Prepared {
    original: ResourceRecord,
    grant: AutomationGrant,
    expected_grant_revision: u64,
}
struct Facts {
    repository: String,
    repository_id: u64,
    source_fingerprint: String,
    constraint_fingerprint: String,
    root_id: String,
    files: BTreeMap<String, FileRole>,
    asset_name: String,
    pinned_version: Option<String>,
    skipped_versions: Vec<String>,
    runtime_package: Option<package::PackageFacts>,
}

fn hash(value: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).expect("JSON value"))
    )
}
fn id(request: &Value, field: &str) -> Result<String, String> {
    request[field]
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= 64 && !v.chars().any(char::is_control))
        .map(str::to_owned)
        .ok_or_else(|| format!("{field} 标识缺失"))
}
fn allowed(request: &Value, fields: &[&str]) -> Result<(), String> {
    if request
        .as_object()
        .is_none_or(|o| o.keys().any(|key| !fields.contains(&key.as_str())))
    {
        Err("自动更新许可请求包含未知字段".into())
    } else {
        Ok(())
    }
}
fn read(m: &Manager, id: &str) -> Result<ResourceRecord, String> {
    serde_json::from_value(m.resource_store(Catalog::Get(id.into()))?).map_err(|e| e.to_string())
}
fn grant(m: &Manager, id: &str) -> Result<Option<AutomationGrant>, String> {
    serde_json::from_value(m.resource_automation_store(StoreRequest::Get(id.into()))?)
        .map_err(|_| "自动更新许可记录无法读取".into())
}
fn normal(m: &Manager) -> Result<(), String> {
    if m.basic_mode || m.snapshot()["startup"]["basicMode"] == true {
        Err("基本模式不修改或执行自动更新许可".into())
    } else {
        Ok(())
    }
}
fn path_key(path: &Path) -> String {
    let s = path.to_string_lossy().replace('/', "\\");
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        path.to_string_lossy().into_owned()
    }
}
fn nested(path: &Path, root: &Path) -> bool {
    let (p, r) = (path_key(path), path_key(root));
    p == r || p.starts_with(&(r + if cfg!(windows) { "\\" } else { "/" }))
}
fn display(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    PathBuf::from(
        s.strip_prefix(r"\\?\UNC\")
            .map(|v| format!(r"\\{v}"))
            .or_else(|| s.strip_prefix(r"\\?\").map(str::to_owned))
            .unwrap_or_else(|| s.into_owned()),
    )
}
fn directory(raw: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw);
    crate::transaction::verify_root(path)?;
    if !path.is_dir() {
        return Err("请选择实际存在的真实目录".into());
    }
    Ok(display(&crate::local::canonical(path)?))
}
fn relations(m: &Manager, id: &str) -> Result<Value, String> {
    let v = m.relation_store(crate::resource_relations::StoreRequest::List {
        endpoint: crate::resource_relations::Endpoint {
            kind: "tool".into(),
            id: id.into(),
        },
    })?;
    Ok(json!({"dependencies":v["dependencies"],"dependents":v["dependents"]}))
}
fn runtime_role(role: &FileRole) -> bool {
    matches!(
        role,
        FileRole::Runtime | FileRole::PrivateDependency | FileRole::License
    )
}
fn inventory(
    root: &Path,
    manifest: Option<&crate::resource_manifest::ManifestRecord>,
) -> Result<BTreeMap<String, resource_files::Fingerprint>, String> {
    fn walk(
        root: &Path,
        dir: &Path,
        manifest: Option<&crate::resource_manifest::ManifestRecord>,
        out: &mut BTreeMap<String, resource_files::Fingerprint>,
        depth: usize,
    ) -> Result<(), String> {
        if depth > 32 || out.len() > 50_000 {
            return Err("当前运行目录过大，不能完整核实授权范围".into());
        }
        for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            #[cfg(windows)]
            let linked = {
                use std::os::windows::fs::MetadataExt;
                meta.file_attributes() & 0x400 != 0
            };
            #[cfg(not(windows))]
            let linked = meta.file_type().is_symlink();
            if linked {
                return Err("运行目录含链接或外部资料，不能授予自动更新许可".into());
            }
            if meta.is_dir() {
                walk(root, &path, manifest, out, depth + 1)?;
            } else if meta.is_file() {
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| "范围外文件")?
                    .to_string_lossy()
                    .replace('\\', "/");
                if crate::resource_manifest::is_registered_path(root, &relative, manifest)? {
                    continue;
                }
                crate::local::validate_relative_path(&relative)?;
                out.insert(relative, resource_files::fingerprint(&path)?);
            } else {
                return Err("运行目录包含未知类型对象".into());
            }
        }
        Ok(())
    }
    crate::transaction::verify_root(root)?;
    let mut out = BTreeMap::new();
    walk(root, root, manifest, &mut out, 0)?;
    Ok(out)
}
fn policy(record: &ResourceRecord) -> Result<(Option<String>, Vec<String>), String> {
    let value = &record.update_policy;
    if !matches!(value["mode"].as_str(), Some("manual" | "automatic"))
        || value["intervalHours"] != 24
    {
        return Err("原更新策略无法核实".into());
    }
    let pin = match &value["pinnedVersion"] {
        Value::Null => None,
        Value::String(v) if !v.trim().is_empty() && v.len() <= 160 => Some(v.clone()),
        _ => return Err("锁定版本设置无效".into()),
    };
    let skip: Vec<String> =
        serde_json::from_value(value["skippedVersions"].clone()).map_err(|_| "跳过版本列表无效")?;
    if skip.len() > 100
        || skip
            .iter()
            .any(|v| v.is_empty() || v.len() > 160 || v.chars().any(char::is_control))
    {
        return Err("跳过版本列表无效".into());
    }
    Ok((pin, skip))
}
fn facts_with(
    m: &Manager,
    record: &ResourceRecord,
    allow_candidate: bool,
    supported: impl FnOnce(&ResourceRecord) -> Result<(), String>,
) -> Result<Facts, String> {
    if record.kind == "skill" || !record.enabled {
        return Err("仅为已启用且可独立维护的工具提供自动更新许可".into());
    }
    supported(record)?;
    let installation = record
        .installation
        .as_ref()
        .filter(|v| v.schema_version == 1 && v.status == "installed" && v.error.is_none())
        .ok_or("原安装尚未完整核实")?;
    if installation.pending_repair.is_some()
        || !installation.retained_repair_files.is_empty()
        || !installation.system_entries.is_empty()
    {
        return Err("仍有修复残留或系统入口需要单独核对，不能自动维护".into());
    }
    if installation
        .removal_state
        .as_ref()
        .is_some_and(|s| !matches!(s.status.as_str(), "complete" | "completed"))
    {
        return Err("卸载流程尚未收尾".into());
    }
    if let Some(state) = &installation.update_state {
        if (!allow_candidate && state.candidate.is_some())
            || state.previous.len() > 1
            || !state.retained_candidates.is_empty()
            || state.last_failure.is_some()
        {
            return Err("候选、历史多目录或失败维护尚未收尾".into());
        }
    }
    let binding = record
        .source_binding
        .as_ref()
        .filter(|b| b.repository_id > 0 && !b.verified_at.is_empty())
        .ok_or("来源身份尚未核实，不能授予自动更新许可")?;
    let repository = crate::resources::repository(&json!({"repository":record.repository}))?
        .ok_or("缺少明确来源")?;
    if !repository.eq_ignore_ascii_case(&binding.repository)
        || !installation
            .source_repository
            .as_ref()
            .is_some_and(|r| r.eq_ignore_ascii_case(&repository))
        || record.version != installation.source_version
    {
        return Err("当前来源、固定版本与原安装证据不一致".into());
    }
    let runtime_package = installation
        .runtime_package
        .as_ref()
        .map(package::from_provenance)
        .transpose()?;
    let asset_name = if let Some(package) = &runtime_package {
        let origin = installation
            .runtime_package
            .as_ref()
            .ok_or("运行包来源缺失")?;
        if origin.version != record.version.as_deref().unwrap_or("")
            || !origin
                .source_repository()?
                .eq_ignore_ascii_case(&repository)
            || installation.download_source.is_some()
            || !installation.archive_sha256.is_empty()
        {
            return Err("真实运行包来源、版本或共享环境与安装记录不一致".into());
        }
        package.asset_key().to_owned()
    } else {
        let mapping = binding.asset.as_ref().ok_or("尚未明确对应发行文件")?;
        let downloaded = installation
            .download_source
            .as_ref()
            .ok_or("原版本没有固定发行下载回执，不能自动维护")?;
        if installation.archive_sha256.len() != 64
            || !downloaded.repository.eq_ignore_ascii_case(&repository)
            || Some(downloaded.version.as_str()) != record.version.as_deref()
            || downloaded.sha256 != installation.archive_sha256
            || downloaded.asset_name != mapping.asset_name
            || downloaded.release_id == 0
            || downloaded.asset_id == 0
        {
            return Err("固定发行回执与原安装基线不一致".into());
        }
        if !mapping.asset_name.to_ascii_lowercase().ends_with(".zip") {
            return Err("仅支持已核 ZIP 或固定官方运行包配方的自动更新许可".into());
        }
        mapping.asset_name.clone()
    };
    let root = Path::new(&record.root_path);
    let actual = inventory(root, installation.resource_manifest.as_ref())?;
    let mut files = BTreeMap::new();
    for file in &installation.files {
        if !runtime_role(&file.role) {
            return Err("运行文件与配置、登录资料或本地改造尚未分离".into());
        }
        if actual
            .get(&file.path)
            .is_none_or(|v| v.sha256 != file.installed_sha256)
        {
            return Err(format!("原文件缺失或已有本地修改：{}", file.path));
        }
        if files.insert(file.path.clone(), file.role.clone()).is_some() {
            return Err("原安装文件清单重复".into());
        }
    }
    if actual.len() != files.len() || !files.values().any(|v| *v == FileRole::Runtime) {
        return Err("运行目录含未知文件或缺少明确运行入口".into());
    }
    if runtime_package.is_none()
        && m.resource_runtime.snapshot(Some(&record.id))?["runs"]
            .as_array()
            .is_some_and(|runs| runs.iter().any(|r| r["status"] == "running"))
    {
        return Err("工具仍在运行，暂不自动维护".into());
    }
    let root_id = crate::clients::file_identity(root)?;
    let (pinned_version, skipped_versions) = policy(record)?;
    let source_fingerprint = if let Some(package) = &runtime_package {
        hash(
            &json!({"repository":repository.to_ascii_lowercase(),"repositoryId":binding.repository_id,"runtimePackage":package}),
        )
    } else {
        hash(
            &json!({"repository":repository.to_ascii_lowercase(),"repositoryId":binding.repository_id,"asset":binding.asset}),
        )
    };
    let mut constraints = json!({"root":record.root_path,"rootId":root_id,"source":source_fingerprint,"archiveSha256":installation.archive_sha256,"installedVersion":installation.source_version,"ownedFiles":installation.files,"manifest":installation.resource_manifest,"actualFiles":actual,"actions":record.actions,"relations":relations(m,&record.id)?,"pins":pinned_version,"skips":skipped_versions});
    if let Some(origin) = &installation.runtime_package {
        constraints["runtimePackage"] = json!(origin);
    }
    let constraint_fingerprint = hash(&constraints);
    Ok(Facts {
        repository,
        repository_id: binding.repository_id,
        source_fingerprint,
        constraint_fingerprint,
        root_id,
        files,
        asset_name,
        pinned_version,
        skipped_versions,
        runtime_package,
    })
}
fn facts(m: &Manager, record: &ResourceRecord, allow_candidate: bool) -> Result<Facts, String> {
    facts_with(
        m,
        record,
        allow_candidate,
        crate::resource_probe::automation_supported,
    )
}
fn locations(
    m: &Manager,
    record: &ResourceRecord,
    parent: &Path,
    download: &Path,
) -> Result<(), String> {
    let snapshot = m.storage.snapshot()?;
    let managed = Path::new(snapshot["managedRoot"].as_str().ok_or("管理器根目录未知")?);
    if parent.parent().is_none() || nested(parent, managed) || nested(managed, parent) {
        return Err("候选父目录须为管理器目录之外的独立持久目录".into());
    }
    let listed = m.resource_store(Catalog::List)?;
    for other in listed["resources"].as_array().ok_or("工具目录不可读")? {
        if let Some(root) = other["rootPath"].as_str() {
            if nested(parent, Path::new(root)) || nested(download, Path::new(root)) {
                return Err("候选或下载目录不能位于现有运行目录内".into());
            }
        }
    }
    let live = m.snapshot();
    for skill in live["skills"].as_array().ok_or("Skill目录不可读")? {
        if let Some(root) = skill["localPath"].as_str() {
            if nested(parent, Path::new(root)) || nested(download, Path::new(root)) {
                return Err("候选或下载目录不能位于Skill目录内".into());
            }
        }
    }
    if let Some(state) = record
        .installation
        .as_ref()
        .and_then(|i| i.update_state.as_ref())
    {
        for old in &state.previous {
            if nested(parent, &old.root) || nested(download, &old.root) {
                return Err("保存位置与保留运行目录重叠".into());
            }
        }
    }
    Ok(())
}
pub(crate) fn initialize(db: &Connection) -> Result<(), String> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS resource_automation_grants(resource_id TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>0),payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS resource_automation_attempts(attempt_key TEXT PRIMARY KEY,resource_id TEXT NOT NULL,payload TEXT NOT NULL);").map_err(|e|e.to_string())
}
fn load(db: &Connection, id: &str) -> Result<Option<AutomationGrant>, String> {
    db.query_row(
        "SELECT payload FROM resource_automation_grants WHERE resource_id=?1",
        [id],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .map(|raw| serde_json::from_str(&raw).map_err(|_| "自动更新许可记录损坏，原记录保留".into()))
    .transpose()
}
pub(crate) fn store(
    db: &Connection,
    request: StoreRequest,
    catalog_revision: u64,
) -> Result<Value, String> {
    let exists:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='resource_automation_grants')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !exists {
        return match request {
            StoreRequest::Get(_) => Ok(Value::Null),
            StoreRequest::List => Ok(json!({"authorizations":[]})),
            StoreRequest::Attempts(_) => Ok(json!({"attempts":[]})),
            StoreRequest::LatestAttempt { .. } => Ok(Value::Null),
            _ => Err("自动更新授权表尚未初始化".into()),
        };
    }
    match request {
        StoreRequest::Attempts(id) => engine::attempts(db, &id),
        StoreRequest::LatestAttempt {
            resource_id,
            grant_revision,
            version,
        } => engine::latest_attempt(db, &resource_id, grant_revision, &version)
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        StoreRequest::ClaimAttempt {
            expected_resource,
            expected_grant_revision,
            attempt,
        } => engine::claim(
            db,
            &expected_resource,
            expected_grant_revision,
            &attempt,
            catalog_revision,
        ),
        StoreRequest::SaveAttempt { expected, attempt } => {
            engine::save_attempt(db, &expected, &attempt)
        }
        StoreRequest::Get(id) => serde_json::to_value(load(db, &id)?).map_err(|e| e.to_string()),
        StoreRequest::List => {
            let mut statement = db
                .prepare("SELECT payload FROM resource_automation_grants ORDER BY resource_id")
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            let mut values = Vec::new();
            for row in rows {
                values.push(
                    serde_json::from_str::<AutomationGrant>(&row.map_err(|e| e.to_string())?)
                        .map_err(|_| "许可记录格式无效")?,
                );
            }
            Ok(json!({"authorizations":values}))
        }
        StoreRequest::Apply {
            expected_resource,
            expected_grant_revision,
            grant,
        } => {
            if grant.resource_id != expected_resource.id
                || grant.revision
                    != expected_grant_revision
                        .checked_add(1)
                        .ok_or("许可修订号超出范围")?
                || grant.enabled && grant.scope.is_none()
            {
                return Err("许可身份或修订号无效".into());
            }
            let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
            let current = crate::resources::store(
                &tx,
                Catalog::Get(expected_resource.id.clone()),
                catalog_revision,
            )?;
            if current != json!(expected_resource)
                || load(&tx, &expected_resource.id)?
                    .map(|g| g.revision)
                    .unwrap_or(0)
                    != expected_grant_revision
            {
                return Err("预览后资源或许可已变化，旧确认失效".into());
            }
            let mut record = *expected_resource;
            record.revision = record.revision.checked_add(1).ok_or("资源修订号超出范围")?;
            record.updated_at = now();
            if let Some(policy) = record.update_policy.as_object_mut() {
                policy.insert(
                    "mode".into(),
                    json!(if grant.enabled { "automatic" } else { "manual" }),
                );
            } else if grant.enabled {
                return Err("原更新策略格式无效".into());
            }
            tx.execute("INSERT INTO resource_automation_grants(resource_id,revision,payload) VALUES(?1,?2,?3) ON CONFLICT(resource_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload",params![grant.resource_id,grant.revision,serde_json::to_string(&grant).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
            let changed=tx.execute("UPDATE resource_catalog SET revision=?1,payload=?2 WHERE id=?3 AND revision=?4",params![record.revision,serde_json::to_string(&record).map_err(|e|e.to_string())?,record.id,record.revision-1]).map_err(|e|e.to_string())?;
            if changed != 1 {
                return Err("资源已变化，授权未保存".into());
            }
            tx.execute("INSERT INTO resource_catalog_meta(id,revision) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision",[catalog_revision]).map_err(|e|e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok(
                json!({"resource":record,"authorization":grant,"saved":true,"automaticApplied":false}),
            )
        }
    }
}
fn preview_with(
    m: &mut Manager,
    request: &Value,
    supported: impl FnOnce(&ResourceRecord) -> Result<(), String>,
) -> Result<Value, String> {
    normal(m)?;
    let resource_id = id(request, "resourceId")?;
    let record = read(m, &resource_id)?;
    if request["expectedRevision"].as_u64() != Some(record.revision) {
        return Err("资源已变化，请重新读取后预览".into());
    }
    let enabled = request["enabled"]
        .as_bool()
        .ok_or("需明确选择是否启用自动更新许可")?;
    allowed(
        request,
        if enabled {
            &[
                "action",
                "resourceId",
                "expectedRevision",
                "enabled",
                "candidateParentPath",
                "downloadDirectory",
                "channel",
                "assetName",
                "selectedFiles",
                "fileRoles",
                "workDirectory",
                "bytesPerSecond",
            ]
        } else {
            &["action", "resourceId", "expectedRevision", "enabled"]
        },
    )?;
    let previous = grant(m, &resource_id)?;
    let revision = previous.as_ref().map(|g| g.revision).unwrap_or(0);
    let scope = if enabled {
        let facts = facts_with(m, &record, false, supported)?;
        if request["channel"] != "stable"
            || (facts.runtime_package.is_none() && request["assetName"] != facts.asset_name)
            || (facts.runtime_package.is_some()
                && request
                    .get("assetName")
                    .is_some_and(|a| a != &json!(facts.asset_name)))
        {
            return Err("仅授权当前已核发行文件的精确名称及稳定渠道，不接受通配符或换渠道".into());
        }
        let selected: BTreeSet<String> =
            serde_json::from_value::<Vec<String>>(request["selectedFiles"].clone())
                .map_err(|_| "必须明确授权文件范围")?
                .into_iter()
                .collect();
        if selected != facts.files.keys().cloned().collect() {
            return Err("授权文件范围必须完整对应已核运行文件，不接受增加或遗漏".into());
        }
        let roles: BTreeMap<String, FileRole> =
            serde_json::from_value(request["fileRoles"].clone()).map_err(|_| "文件用途无效")?;
        if roles != facts.files {
            return Err("授权文件用途与原运行范围不符".into());
        }
        let parent = directory(
            request["candidateParentPath"]
                .as_str()
                .ok_or("请选择候选持久父目录")?,
        )?;
        let download = directory(
            request["downloadDirectory"]
                .as_str()
                .ok_or("请选择下载目录")?,
        )?;
        locations(m, &record, &parent, &download)?;
        let package = match facts.runtime_package {
            Some(package) => {
                let work = directory(
                    request["workDirectory"]
                        .as_str()
                        .ok_or("请选择官方包准备目录")?,
                )?;
                let rate = request["bytesPerSecond"]
                    .as_u64()
                    .ok_or("请明确下载限速，0 表示不限速")?;
                if rate != 0 && !(1024..=1024 * 1024 * 1024).contains(&rate) {
                    return Err("下载限速范围无效".into());
                }
                Some(package.with_locations(work, rate)?)
            }
            None => {
                if request.get("workDirectory").is_some() || request.get("bytesPerSecond").is_some()
                {
                    return Err("ZIP 许可不接受运行包准备参数".into());
                }
                None
            }
        };
        let scope = AutomationScope {
            repository: facts.repository,
            repository_id: facts.repository_id,
            source_fingerprint: facts.source_fingerprint,
            constraint_fingerprint: facts.constraint_fingerprint,
            original_root: PathBuf::from(&record.root_path),
            original_root_id: facts.root_id,
            candidate_parent_id: crate::clients::file_identity(&parent)?,
            candidate_parent_path: parent,
            download_directory_id: crate::clients::file_identity(&download)?,
            download_directory: download,
            channel: "stable".into(),
            asset_name: facts.asset_name,
            files: facts.files,
            pinned_version: facts.pinned_version,
            skipped_versions: facts.skipped_versions,
            runtime_package: package,
        };
        package::locations(&scope, m, &record)?;
        Some(scope)
    } else {
        previous.as_ref().and_then(|g| g.scope.clone())
    };
    let grant = AutomationGrant {
        resource_id: resource_id.clone(),
        revision: revision.checked_add(1).ok_or("许可修订号超出范围")?,
        enabled,
        updated_at: now(),
        scope,
    };
    let token = uuid::Uuid::new_v4().to_string();
    let package_enabled = grant
        .scope
        .as_ref()
        .is_some_and(|s| s.runtime_package.is_some());
    let public = json!({"id":token,"kind":"resourceAutomation","resourceId":resource_id,"resourceRevision":record.revision,"enabled":enabled,"scope":grant.scope,"canApply":true,"permissions":if enabled && package_enabled{vec!["仅按固定官方 npm/wheel 配方解析精确稳定版本及已核依赖","仅向所选准备、下载和候选目录写入；共享 Python/Node 与现有 pip 保持只读","Python/pip 解析可能联网下载 wheel，解析流量不受资产限速；不允许源码构建或新权限","候选隔离验证、提交及切换后核验全部通过后才更新此资源入口"]}else if enabled{vec!["仅下载精确匹配的稳定ZIP到已选目录","仅在已选父目录创建新的候选运行目录","仅准备清单内的运行文件、专用依赖和许可证","隔离验证及提交前重核全部通过后才允许切换此资源入口"]}else{vec!["停止后续自动下载与切换；文件及已进入关键提交的收尾保持"]},"warnings":["这次仅保存明确授权，不立即下载、安装或切换。","不授权新权限、共享依赖变化、数据迁移、通用Shell或清理旧版本。"]});
    m.previews.insert(token,json!({"kind":"resourceAutomation","resourceId":resource_id,"createdAt":chrono::Utc::now().timestamp_millis(),"public":public,"prepared":Prepared{original:record,grant,expected_grant_revision:revision}}));
    Ok(public)
}
fn apply_with(
    m: &mut Manager,
    request: &Value,
    supported: impl FnOnce(&ResourceRecord) -> Result<(), String>,
) -> Result<Value, String> {
    normal(m)?;
    allowed(request, &["action", "previewId"])?;
    let token = id(request, "previewId")?;
    let cached = m
        .previews
        .remove(&token)
        .ok_or("自动更新许可预览已失效，请重新核对")?;
    if cached["kind"] != "resourceAutomation"
        || cached["public"]["canApply"] != true
        || !cached["createdAt"]
            .as_i64()
            .is_some_and(|t| chrono::Utc::now().timestamp_millis() - t <= 600_000)
    {
        return Err("许可预览类型或有效期不符".into());
    }
    let prepared: Prepared =
        serde_json::from_value(cached["prepared"].clone()).map_err(|_| "许可预览记录无效")?;
    let current = read(m, &prepared.original.id)?;
    if json!(current) != json!(prepared.original) {
        return Err("预览后资源已变化，授权未保存".into());
    }
    if prepared.grant.enabled {
        let f = facts_with(m, &current, false, supported)?;
        let scope = prepared.grant.scope.as_ref().ok_or("许可缺少范围")?;
        if f.constraint_fingerprint != scope.constraint_fingerprint
            || f.source_fingerprint != scope.source_fingerprint
            || crate::clients::file_identity(&scope.candidate_parent_path)?
                != scope.candidate_parent_id
            || crate::clients::file_identity(&scope.download_directory)?
                != scope.download_directory_id
        {
            return Err("预览后文件、来源或保存目录身份已变化，授权未保存".into());
        }
        locations(
            m,
            &current,
            &scope.candidate_parent_path,
            &scope.download_directory,
        )?;
        package::locations(scope, m, &current)?;
    }
    m.resource_automation_store(StoreRequest::Apply {
        expected_resource: Box::new(current),
        expected_grant_revision: prepared.expected_grant_revision,
        grant: Box::new(prepared.grant),
    })
}
fn authorize_with(
    m: &Manager,
    id: &str,
    candidate: &CandidateScope,
    phase: Phase,
    supported: impl FnOnce(&ResourceRecord) -> Result<(), String>,
) -> Result<AutomationGrant, String> {
    normal(m)?;
    crate::maintenance::ensure_automatic_allowed(&m.snapshot()["settings"])?;
    let record = read(m, id)?;
    let grant = grant(m, id)?
        .filter(|g| g.enabled)
        .ok_or("此资源未取得明确的自动更新许可")?;
    let scope = grant.scope.as_ref().ok_or("许可缺少范围")?;
    if record.update_policy["mode"] != "automatic" || !record.enabled {
        return Err("资源已转为手动或停用，自动应用暂停".into());
    }
    let f = facts_with(m, &record, phase == Phase::BeforeCommit, supported)?;
    if f.source_fingerprint != scope.source_fingerprint
        || f.constraint_fingerprint != scope.constraint_fingerprint
        || f.root_id != scope.original_root_id
        || f.files != scope.files
    {
        return Err("来源、原文件、动作、关系或权限条件已变化，需重新授权".into());
    }
    if candidate.repository_id != scope.repository_id
        || !candidate.repository.eq_ignore_ascii_case(&scope.repository)
        || candidate.channel != "stable"
        || candidate.channel != scope.channel
        || candidate.asset_name != scope.asset_name
        || candidate.files != scope.files
        || candidate.version.trim().is_empty()
        || candidate.version == record.version.as_deref().unwrap_or("")
    {
        return Err("候选来源、稳定渠道、资产或文件用途超出许可".into());
    }
    let version_blocked = if scope.runtime_package.is_some() {
        let version = crate::resource_package::automation::stable_version(
            candidate.version.trim_start_matches('v'),
        )?;
        let pinned = f
            .pinned_version
            .as_deref()
            .map(|v| crate::resource_package::automation::stable_version(v.trim_start_matches('v')))
            .transpose()?;
        let skipped = f
            .skipped_versions
            .iter()
            .map(|v| crate::resource_package::automation::stable_version(v.trim_start_matches('v')))
            .collect::<Result<Vec<_>, _>>()?;
        pinned.is_some_and(|pin| pin != version) || skipped.contains(&version)
    } else {
        f.pinned_version
            .as_ref()
            .is_some_and(|pin| pin != &candidate.version)
            || f.skipped_versions.contains(&candidate.version)
    };
    if version_blocked {
        return Err("候选版本受版本锁定或跳过设置限制".into());
    }
    if directory(scope.candidate_parent_path.to_str().ok_or("候选目录无效")?)?
        != scope.candidate_parent_path
        || directory(scope.download_directory.to_str().ok_or("下载目录无效")?)?
            != scope.download_directory
        || crate::clients::file_identity(&scope.candidate_parent_path)? != scope.candidate_parent_id
        || crate::clients::file_identity(&scope.download_directory)? != scope.download_directory_id
    {
        return Err("已授权目录的真实位置或对象身份已变化".into());
    }
    locations(
        m,
        &record,
        &scope.candidate_parent_path,
        &scope.download_directory,
    )?;
    package::locations(scope, m, &record)?;
    if phase == Phase::BeforeCommit {
        if scope.runtime_package.is_some() {
            package::candidate_matches(&record, scope, candidate)?;
            return Ok(grant);
        }
        let staged = record
            .installation
            .as_ref()
            .and_then(|i| i.update_state.as_ref())
            .and_then(|s| s.candidate.as_ref())
            .ok_or("没有可核验的已准备候选")?;
        let files: BTreeMap<_, _> = staged
            .files
            .iter()
            .map(|f| (f.path.clone(), f.role.clone()))
            .collect();
        if !staged.complete
            || staged.error.is_some()
            || staged.version != candidate.version
            || staged.root.parent().map(path_key) != Some(path_key(&scope.candidate_parent_path))
            || files != scope.files
            || !staged.download_source.as_ref().is_some_and(|s| {
                s.repository.eq_ignore_ascii_case(&scope.repository)
                    && s.version == candidate.version
                    && s.asset_name == scope.asset_name
            })
        {
            return Err("已准备候选不属于本次许可范围，不能自动提交".into());
        }
    }
    Ok(grant)
}
/// Internal scope admission only. It does not claim a candidate was isolated,
/// verified or switched. The update engine must separately validate its real
/// source/asset response, candidate probe and final switch receipt.
pub(crate) fn authorize(
    m: &Manager,
    id: &str,
    candidate: &CandidateScope,
    phase: Phase,
) -> Result<AutomationGrant, String> {
    authorize_with(
        m,
        id,
        candidate,
        phase,
        crate::resource_probe::automation_supported,
    )
}
pub(crate) fn handle(m: &Manager, request: &Value) -> Result<Option<Value>, String> {
    if request["action"] != "resource_automation_status" {
        return Ok(None);
    }
    allowed(request, &["action", "resourceId"])?;
    let id = id(request, "resourceId")?;
    let record = read(m, &id)?;
    let authorization = grant(m, &id)?;
    let current = facts(m, &record, false);
    let fingerprints = current.as_ref().ok().map(|f| {
        (
            f.source_fingerprint.clone(),
            f.constraint_fingerprint.clone(),
        )
    });
    let (current_scope, mut reason) = match current {
        Ok(f) => (
            json!({"repository":f.repository,"repositoryId":f.repository_id,"installedVersion":record.version,"assetName":f.asset_name,"files":f.files,"pinnedVersion":f.pinned_version,"skippedVersions":f.skipped_versions,"runtimePackage":f.runtime_package}),
            String::new(),
        ),
        Err(reason) => (Value::Null, reason),
    };
    if m.basic_mode || m.snapshot()["startup"]["basicMode"] == true {
        reason = "基本模式不执行自动更新".into();
    } else if let Err(maintenance) =
        crate::maintenance::ensure_automatic_allowed(&m.snapshot()["settings"])
    {
        reason = maintenance;
    }
    if reason.is_empty() {
        if let Some(scope) = authorization
            .as_ref()
            .filter(|g| g.enabled)
            .and_then(|g| g.scope.as_ref())
        {
            if record.update_policy["mode"] != "automatic"
                || fingerprints
                    != Some((
                        scope.source_fingerprint.clone(),
                        scope.constraint_fingerprint.clone(),
                    ))
            {
                reason = "当前为手动策略或旧许可已失效".into();
            } else if let Err(problem) = locations(
                m,
                &record,
                &scope.candidate_parent_path,
                &scope.download_directory,
            ) {
                reason = problem;
            } else if let Err(problem) = package::locations(scope, m, &record) {
                reason = problem;
            } else if crate::clients::file_identity(&scope.candidate_parent_path)
                .ok()
                .as_ref()
                != Some(&scope.candidate_parent_id)
                || crate::clients::file_identity(&scope.download_directory)
                    .ok()
                    .as_ref()
                    != Some(&scope.download_directory_id)
            {
                reason = "已授权目录身份已变化".into();
            }
        } else {
            reason = "尚未明确授权自动下载或应用".into();
        }
    }
    Ok(Some(
        json!({"resourceId":id,"resourceRevision":record.revision,"policyMode":record.update_policy["mode"],"authorization":authorization,"currentScope":current_scope,"effective":reason.is_empty(),"blockedReason":reason,"automaticApplied":false,"attempts":m.resource_automation_store(StoreRequest::Attempts(id.clone()))?["attempts"]}),
    ))
}
pub(crate) fn preview_local(m: &mut Manager, request: &Value) -> Result<Option<Value>, String> {
    if request["action"] != "preview_resource_automation" {
        return Ok(None);
    }
    preview_with(m, request, crate::resource_probe::automation_supported).map(Some)
}
pub(crate) fn apply_local(m: &mut Manager, request: &Value) -> Result<Option<Value>, String> {
    if request["action"] != "apply_resource_automation" {
        return Ok(None);
    }
    apply_with(m, request, crate::resource_probe::automation_supported).map(Some)
}

#[cfg(test)]
mod tests;

pub(crate) mod engine;
pub(crate) mod package;
