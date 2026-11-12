//! Local candidate installation and ownership-scoped removal.
//! Inspection is agent-readable; filesystem writes require the native UI dispatcher.
use crate::{
    model::{now, Manager},
    resource_files::{self, FileRole, OwnedFile, PackageInventory, RemovalExtent, RemovalPlan},
    resources::{ResourceRecord, StoreRequest},
    system_ownership::{self, OwnedSystemEntry, SystemAccess, SystemPlan},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    path::{Path, PathBuf},
};

const MAX_UNPACKED_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallationRecord {
    pub schema_version: u32,
    pub installed_at: String,
    pub archive_path: String,
    pub archive_sha256: String,
    pub source_repository: Option<String>,
    pub source_version: Option<String>,
    #[serde(default)]
    pub download_source: Option<crate::resource_github::DownloadSource>,
    /// A generated runtime has real package inputs, not a fictional release ZIP.
    #[serde(default)]
    pub runtime_package: Option<crate::resource_package::RuntimePackageProvenance>,
    pub files: Vec<OwnedFile>,
    #[serde(default)]
    pub system_entries: Vec<OwnedSystemEntry>,
    pub status: String,
    pub error: Option<String>,
    #[serde(default)]
    pub pending_repair: Option<RepairIntent>,
    /// Retained candidate paths are an index, not permission to remove files.
    #[serde(default)]
    pub retained_repair_files: Vec<PathBuf>,
    #[serde(default)]
    pub update_state: Option<crate::resource_update::UpdateState>,
    #[serde(default)]
    pub removal_state: Option<RemovalState>,
    #[serde(default)]
    pub resource_manifest: Option<crate::resource_manifest::ManifestRecord>,
}

/// An audit journal, never a persisted permission to replay an uninstall.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemovalState {
    pub plan_id: String,
    pub extent: RemovalExtent,
    pub status: String,
    pub complete: bool,
    pub started_at: String,
    pub updated_at: String,
    pub file_entries: Vec<resource_files::RemovalEntry>,
    pub system_entry_ids: Vec<String>,
    pub file_result: Value,
    pub system_results: Vec<system_ownership::EntryResult>,
    #[serde(default)]
    pub runtime_results: Vec<Value>,
    #[serde(default)]
    pub metadata_results: Vec<Value>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairIntent {
    previous_enabled: bool,
    previous_status: String,
    previous_error: Option<String>,
    known_revision: u64,
    #[serde(default)]
    original_root: PathBuf,
    #[serde(default)]
    original_source: Value,
    owned_files: Vec<OwnedFile>,
    entries: Vec<resource_files::RepairEntry>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreparedInstall {
    archive_path: PathBuf,
    inventory: PackageInventory,
    destination: PathBuf,
    selected: Vec<String>,
    file_roles: BTreeMap<String, FileRole>,
    record: ResourceRecord,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreparedRemoval {
    resource_id: String,
    record_revision: u64,
    relations_revision: u64,
    plan: RemovalPlan,
    root_identity: Option<String>,
    shared_scope: Value,
    system_plan: SystemPlan,
    custom_files: Vec<String>,
    current_missing: bool,
    runtime_plans: Vec<RuntimeRemoval>,
    metadata: Vec<MetadataRemoval>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum RuntimeSlot {
    Previous { index: usize },
    Candidate,
    RetainedCandidate { index: usize },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeRemoval {
    id: String,
    label: String,
    slot: RuntimeSlot,
    plan: RemovalPlan,
    root_identity: Option<String>,
    root_missing: bool,
    custom_files: Vec<String>,
}

struct RuntimeOwnership {
    id: String,
    label: String,
    slot: RuntimeSlot,
    root: PathBuf,
    files: Vec<OwnedFile>,
    unowned_paths: Vec<PathBuf>,
    manifest: Option<crate::resource_manifest::ManifestRecord>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetadataRemoval {
    id: String,
    runtime_id: String,
    runtime_label: String,
    root: PathBuf,
    slot: Option<RuntimeSlot>,
    record: crate::resource_manifest::ManifestRecord,
    root_identity: Option<String>,
    root_missing: bool,
    expected: Option<resource_files::Fingerprint>,
    file_identity: Option<String>,
    status: String,
    requested: bool,
    remove: bool,
    reason: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreparedRepair {
    resource_id: String,
    record_revision: u64,
    source: RepairSource,
    plan: resource_files::RepairPlan,
    manifest: Option<crate::resource_manifest::ManifestRecord>,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "format", rename_all = "camelCase")]
enum RepairSource {
    Zip {
        archive_path: PathBuf,
        inventory: PackageInventory,
    },
    Npm {
        source: crate::resource_package::repair::NpmRepairSource,
    },
    PythonWheel {
        source: crate::resource_package::repair_python::PythonRepairSource,
    },
}
impl RepairSource {
    fn verify(
        &self,
        installation: &InstallationRecord,
        plan: &resource_files::RepairPlan,
    ) -> Result<(), String> {
        match self {
            Self::Zip {
                archive_path,
                inventory,
            } => {
                if installation.runtime_package.is_some()
                    || installation.archive_sha256 != inventory.archive.sha256
                {
                    return Err("原 ZIP 安装来源与修复预览不同".into());
                }
                resource_files::verify_repair(archive_path, inventory, plan)
            }
            Self::Npm { source } => {
                source.matches(
                    installation
                        .runtime_package
                        .as_ref()
                        .ok_or("原 npm 运行包来源已变化")?,
                )?;
                source.verify(plan)
            }
            Self::PythonWheel { source } => {
                source.matches(
                    installation
                        .runtime_package
                        .as_ref()
                        .ok_or("原 Python 运行包来源已变化")?,
                )?;
                source.verify(plan)
            }
        }
    }
    fn apply(
        &self,
        plan: &resource_files::RepairPlan,
    ) -> Result<resource_files::RepairReceipt, String> {
        match self {
            Self::Zip {
                archive_path,
                inventory,
            } => resource_files::repair_zip(archive_path, inventory, plan),
            Self::Npm { source } => source.apply(plan),
            Self::PythonWheel { source } => source.apply(plan),
        }
    }
    fn paths(&self) -> Vec<PathBuf> {
        match self {
            Self::Zip { archive_path, .. } => vec![archive_path.clone()],
            Self::Npm { source } => source.paths(),
            Self::PythonWheel { source } => source.paths(),
        }
    }
}

#[cfg(test)]
#[path = "resource_lifecycle/npm_repair_tests.rs"]
mod npm_repair_tests;

fn manifest_source(
    installation: &InstallationRecord,
) -> Result<crate::resource_manifest::ManifestSource, String> {
    let downloaded = installation.download_source.as_ref();
    Ok(crate::resource_manifest::ManifestSource {
        repository: installation.source_repository.clone(),
        repository_id: None,
        release_id: downloaded
            .map(|source| source.release_id)
            .filter(|id| *id > 0),
        asset_id: downloaded
            .map(|source| source.asset_id)
            .filter(|id| *id > 0),
        asset_name: downloaded.map(|source| source.asset_name.clone()),
        archive_sha256: (!installation.archive_sha256.is_empty())
            .then(|| installation.archive_sha256.clone()),
        runtime_package: installation
            .runtime_package
            .as_ref()
            .map(crate::resource_manifest::RuntimePackageSource::from_provenance)
            .transpose()?,
    })
}

fn prepare_manifest(
    resource: &ResourceRecord,
    root: &Path,
    files: &[OwnedFile],
    complete: bool,
) -> Result<crate::resource_manifest::PreparedManifest, String> {
    let installation = resource
        .installation
        .as_ref()
        .ok_or("安装归属缺失，不能写资源侧管理记录")?;
    crate::resource_manifest::prepare(
        root,
        &resource.id,
        &resource.kind,
        installation
            .source_version
            .as_deref()
            .or(resource.version.as_deref()),
        Some(manifest_source(installation)?),
        files,
        complete && files.iter().any(|file| file.role == FileRole::Runtime),
    )
}

fn refresh_manifest(
    resource: &ResourceRecord,
    root: &Path,
    expected: &crate::resource_manifest::ManifestRecord,
    complete: bool,
) -> Result<crate::resource_manifest::ManifestRecord, String> {
    let installation = resource.installation.as_ref().ok_or("安装归属缺失")?;
    let mut exact = vec![];
    let mut all_exact = true;
    for file in &installation.files {
        if matches!(
            file.role,
            FileRole::Runtime | FileRole::PrivateDependency | FileRole::License
        ) {
            let matches = crate::local::safe_join(root, &file.path)
                .and_then(|path| resource_files::fingerprint(&path))
                .is_ok_and(|actual| actual.sha256.eq_ignore_ascii_case(&file.installed_sha256));
            if !matches {
                all_exact = false;
                continue;
            }
        }
        exact.push(file.clone());
    }
    let prepared = prepare_manifest(resource, root, &exact, complete && all_exact)?;
    crate::resource_manifest::update_owned(root, expected, &prepared)
}

fn text(request: &Value, key: &str, limit: usize) -> Result<String, String> {
    request[key]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.chars().count() <= limit && !s.contains('\0'))
        .map(|s| s.trim().to_owned())
        .ok_or_else(|| format!("{key} 内容为空、无效或过长"))
}

fn paths(request: &Value, key: &str) -> Result<Vec<String>, String> {
    let list = request[key]
        .as_array()
        .ok_or_else(|| format!("{key} 必须是文件列表"))?;
    if list.len() > 50_000 {
        return Err("选择的文件数过多".into());
    }
    list.iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| "文件路径必须是文字".into())
        })
        .collect()
}

fn display(path: &Path) -> String {
    let value = path.to_string_lossy();
    value
        .strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .or_else(|| value.strip_prefix(r"\\?\").map(str::to_owned))
        .unwrap_or_else(|| value.into_owned())
}

fn archive_path(request: &Value) -> Result<PathBuf, String> {
    let path = PathBuf::from(text(request, "archivePath", 32767)?);
    crate::transaction::verify_root(&path)?;
    Ok(PathBuf::from(display(&crate::local::canonical(&path)?)))
}

fn destination(request: &Value) -> Result<PathBuf, String> {
    let path = PathBuf::from(text(request, "destinationPath", 32767)?);
    crate::transaction::verify_root(&path)?;
    match fs::symlink_metadata(&path) {
        Ok(_) => return Err("安装目标必须是尚不存在的新版本目录".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    let parent = path.parent().ok_or("请选择有父目录的持久位置")?;
    if !parent.is_dir() {
        return Err("请先选择现有的持久父目录".into());
    }
    Ok(PathBuf::from(display(&crate::local::canonical(parent)?))
        .join(path.file_name().ok_or("缺少版本目录名")?))
}

/// New installations must survive removal of the manager. Existing registrations
/// remain untouched; this is also rechecked immediately before the first write.
pub(crate) fn ensure_independent_destination(
    m: &Manager,
    destination: &Path,
) -> Result<(), String> {
    independent_destination(m, destination, None)
}

pub(crate) fn ensure_independent_update_destination(
    m: &Manager,
    destination: &Path,
    resource_id: &str,
) -> Result<(), String> {
    independent_destination(m, destination, Some(resource_id))
}

fn independent_destination(
    m: &Manager,
    destination: &Path,
    update_resource: Option<&str>,
) -> Result<(), String> {
    crate::transaction::verify_root(destination)?;
    let snapshot = m.storage.snapshot()?;
    let managed = snapshot["managedRoot"]
        .as_str()
        .ok_or("管理器根目录未知，不能确认资源独立保存位置")?;
    let mut protected = vec![("管理器根目录".to_owned(), PathBuf::from(managed))];
    for (kind, value) in snapshot["paths"]
        .as_object()
        .ok_or("管理器保存位置不可读")?
    {
        protected.push((
            format!("管理器保存位置 {kind}"),
            PathBuf::from(
                value["effective"]
                    .as_str()
                    .ok_or("管理器保存位置缺少准确路径")?,
            ),
        ));
    }
    if let Some(developer) = snapshot["developer"].as_object() {
        for field in ["projectRoot", "dependencyRoot"] {
            if let Some(path) = developer.get(field).and_then(Value::as_str) {
                protected.push(("开发目录".into(), PathBuf::from(path)));
            }
        }
    }
    let resources = m.resource_store(StoreRequest::List)?;
    for value in resources["resources"]
        .as_array()
        .ok_or("资源目录不可读，不能核对安装位置")?
    {
        let resource: ResourceRecord =
            serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
        protected.push((
            format!("已登记工具 {}", resource.name),
            PathBuf::from(&resource.root_path),
        ));
        if let Some(update) = resource
            .installation
            .as_ref()
            .and_then(|installation| installation.update_state.as_ref())
        {
            for previous in &update.previous {
                protected.push(("已保留运行版本".into(), previous.root.clone()));
            }
            if let Some(candidate) = &update.candidate {
                if update_resource != Some(resource.id.as_str())
                    || path_key(destination) != path_key(&candidate.root)
                {
                    protected.push(("已登记候选版本".into(), candidate.root.clone()));
                }
            }
            for retained in &update.retained_candidates {
                protected.push(("已保留候选版本".into(), retained.candidate.root.clone()));
            }
        }
    }
    let live = m.snapshot();
    for skill in live["skills"]
        .as_array()
        .ok_or("Skill 目录不可读，不能核对安装位置")?
    {
        if let Some(path) = skill["localPath"].as_str() {
            protected.push(("已登记 Skill".into(), PathBuf::from(path)));
        }
    }
    let destination =
        crate::local::canonical(destination).unwrap_or_else(|_| destination.to_owned());
    for (label, root) in protected {
        if !root.is_absolute() {
            return Err(format!("{label} 的准确位置不可核对，安装尚未开始"));
        }
        let root = crate::local::canonical(&root).unwrap_or(root);
        if path_overlap(&destination, &root) {
            return Err(format!(
                "新安装位置与{label}重叠：{}；请选择管理器和现有资源之外的独立持久目录",
                display(&root)
            ));
        }
    }
    Ok(())
}

fn remember(m: &mut Manager, mut stored: Value, public: Value) -> Result<Value, String> {
    let id = public["id"].as_str().ok_or("预览缺少标识")?.to_owned();
    stored["public"] = public.clone();
    stored["createdAt"] = json!(chrono::Utc::now().timestamp_millis());
    m.previews.insert(id, stored);
    trim_previews(&mut m.previews);
    Ok(public)
}

pub(crate) fn trim_previews(previews: &mut HashMap<String, Value>) {
    let mut plans: Vec<_> = previews
        .iter()
        .filter(|(_, p)| {
            matches!(
                p["kind"].as_str(),
                Some(
                    "resourceInstall"
                        | "resourceRemove"
                        | "resourceDownload"
                        | "resourceDownloadReceipt"
                        | "resourceRepair"
                        | "skillRemove"
                        | "resourceSource"
                )
            )
        })
        .map(|(id, p)| (p["createdAt"].as_i64().unwrap_or(0), id.clone()))
        .collect();
    plans.sort();
    let excess = plans.len().saturating_sub(32);
    for (_, id) in plans.into_iter().take(excess) {
        previews.remove(&id);
    }
    let orphaned_disconnects: Vec<_> = previews
        .iter()
        .filter(|(_, preview)| preview["kind"] == "disconnect")
        .filter_map(|(id, preview)| {
            let parent_id = preview["skillRemovalPreviewId"].as_str()?;
            let owned = previews.get(parent_id).is_some_and(|parent| {
                parent["kind"] == "skillRemove"
                    && parent["prepared"]["disconnects"]
                        .as_array()
                        .is_some_and(|disconnects| {
                            disconnects.iter().any(|disconnect| {
                                disconnect["previewId"].as_str() == Some(id.as_str())
                            })
                        })
            });
            (!owned).then(|| id.clone())
        })
        .collect();
    for id in orphaned_disconnects {
        previews.remove(&id);
    }
}

fn inspect(request: &Value) -> Result<Value, String> {
    let archive = archive_path(request)?;
    let inventory = resource_files::inspect_zip(&archive, MAX_UNPACKED_BYTES)?;
    Ok(
        json!({"archivePath":archive,"archive":inventory.archive,"files":inventory.files,"unpackedBytes":inventory.unpacked_bytes}),
    )
}

fn preview_install(m: &mut Manager, request: &Value) -> Result<Value, String> {
    let archive = archive_path(request)?;
    let inventory = resource_files::inspect_zip(&archive, MAX_UNPACKED_BYTES)?;
    let download_source =
        crate::resource_github::verified_source(m, request, &archive, &inventory.archive)?;
    let destination = destination(request)?;
    ensure_independent_destination(m, &destination)?;
    let selected = paths(request, "selectedFiles")?;
    let mut chosen: BTreeSet<_> = selected.iter().cloned().collect();
    if chosen.is_empty() {
        return Err("请选择已核实的运行文件及必要依赖".into());
    }
    for path in &chosen {
        crate::local::validate_relative_path(path)?;
        if !inventory.files.iter().any(|file| file.path == *path) {
            return Err(format!("文件不在当前发行包中：{path}"));
        }
    }
    chosen.extend(
        inventory
            .files
            .iter()
            .filter(|f| f.license)
            .map(|f| f.path.clone()),
    );
    if chosen
        .iter()
        .any(|path| path.eq_ignore_ascii_case(crate::resource_manifest::NAME))
    {
        return Err("资源侧管理记录由本次安装生成，不能从上游文件选择中认领或覆盖".into());
    }
    let files: Vec<_> = inventory
        .files
        .iter()
        .filter(|f| chosen.contains(&f.path))
        .cloned()
        .collect();
    let (_, available) =
        crate::storage::destination_space(destination.parent().ok_or("安装父目录不可用")?)?;
    let selected_bytes: u64 = files.iter().map(|file| file.bytes).sum();
    if available.is_some_and(|bytes| bytes < selected_bytes) {
        return Err("安装目录可用空间不足".into());
    }
    if !files.iter().any(|file| !file.license) {
        return Err("不能只安装许可文件，请选择实际运行文件".into());
    }
    let mut file_roles: BTreeMap<String, FileRole> = match request.get("fileRoles") {
        None => BTreeMap::new(),
        Some(value) => serde_json::from_value(value.clone()).map_err(|_| "文件角色清单格式无效")?,
    };
    if file_roles.keys().any(|path| !chosen.contains(path)) {
        return Err("文件角色包含本次未选择的文件".into());
    }
    for file in &files {
        if file.license {
            if file_roles
                .get(&file.path)
                .is_some_and(|role| *role != FileRole::License)
            {
                return Err("许可文件的归属类型必须保留为 license".into());
            }
            file_roles.insert(file.path.clone(), FileRole::License);
        } else {
            if file_roles.get(&file.path) == Some(&FileRole::License) {
                return Err("不能把普通文件标记为许可文件".into());
            }
            file_roles
                .entry(file.path.clone())
                .or_insert(FileRole::Runtime);
        }
    }
    let public_files: Vec<_> = files.iter().map(|file| json!({"path":file.path,"bytes":file.bytes,"license":file.license,"role":file_roles[&file.path]})).collect();
    let kind = text(request, "kind", 32)?;
    if !["skill", "portable", "cli", "mcp"].contains(&kind.as_str()) {
        return Err("资源类型无效".into());
    }
    let repository = download_source
        .as_ref()
        .map(|s| Some(s.repository.clone()))
        .unwrap_or(crate::resources::repository(request)?);
    let version = if let Some(source) = &download_source {
        Some(source.version.clone())
    } else {
        match request.get("version") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if s.trim().is_empty() => None,
            _ => Some(text(request, "version", 160)?),
        }
    };
    let timestamp = now();
    let record = ResourceRecord {
        id: uuid::Uuid::new_v4().to_string(),
        name: text(request, "name", 160)?,
        kind,
        root_path: display(&destination),
        repository: repository.clone(),
        version: version.clone(),
        source_binding: None,
        source_history: vec![],
        alias: String::new(),
        notes: String::new(),
        enabled: false,
        ownership: "managedFiles".into(),
        management_scope: "ownedFiles".into(),
        actions: vec![],
        capabilities: vec![
            json!({"id":"installation","label":"文件安装","status":"unverified","reason":"等待本次预览确认"}),
        ],
        update_policy: json!({"mode":"manual","intervalHours":24,"pinnedVersion":null,"skippedVersions":[]}),
        installation: Some(InstallationRecord {
            schema_version: 1,
            installed_at: timestamp.clone(),
            archive_path: display(&archive),
            archive_sha256: inventory.archive.sha256.clone(),
            source_repository: repository.clone(),
            source_version: version.clone(),
            download_source: download_source.clone(),
            runtime_package: None,
            files: vec![],
            system_entries: vec![],
            status: "installing".into(),
            error: None,
            pending_repair: None,
            retained_repair_files: vec![],
            update_state: None,
            removal_state: None,
            resource_manifest: None,
        }),
        revision: 1,
        created_at: timestamp.clone(),
        updated_at: timestamp,
    };
    let id = uuid::Uuid::new_v4().to_string();
    let source = match download_source {
        Some(source) => serde_json::to_value(source).map_err(|e| e.to_string())?,
        None => json!({"repository":repository,"version":version,"verification":"userProvided"}),
    };
    let source_warning = if source["verification"] == "userProvided" {
        "来源和版本为本次填写信息；本地文件安装不会自动验证 GitHub 发布者或运行依赖。"
    } else {
        "来源及文件摘要已与下载回执一致核对；所选运行功能和依赖仍需单独验证。"
    };
    let public = json!({"id":id,"kind":"resourceInstall","archivePath":archive,"targetPath":destination,
        "files":public_files,"selectedBytes":files.iter().map(|f| f.bytes).sum::<u64>(),"canApply":true,
        "source":source,"metadata":(record.kind!="skill").then(||json!({"kind":"resourceMetadata","targetPath":destination.join(crate::resource_manifest::NAME),"relativePath":crate::resource_manifest::NAME,"executionGrant":false,"deleteGrant":false,"containsPrivateConfiguration":false})),
        "warnings":[source_warning, if record.kind=="skill" {"Skill沿用原有精简运行文件格式，不生成额外资源侧管理记录。"} else {"许可文件自动保留；另生成单份非敏感资源侧管理记录，便于管理器不可用时核对来源与版本；它不授予执行或删除权限。"},"仅安装当前清单，不会自动运行发行包或修改环境变量、注册表。"]});
    let prepared = PreparedInstall {
        archive_path: archive.clone(),
        inventory,
        destination: destination.clone(),
        selected,
        file_roles,
        record,
    };
    remember(
        m,
        json!({"kind":"resourceInstall","targetPath":destination,"archivePath":archive,"prepared":prepared}),
        public,
    )
}

fn read_resource(m: &Manager, id: &str) -> Result<ResourceRecord, String> {
    serde_json::from_value(m.resource_store(StoreRequest::Get(id.to_owned()))?)
        .map_err(|e| e.to_string())
}

fn removal_relations(m: &Manager, id: &str) -> Result<(u64, Vec<Value>), String> {
    let relations = m.relation_store(crate::resource_relations::StoreRequest::List {
        endpoint: crate::resource_relations::Endpoint {
            kind: "tool".into(),
            id: id.to_owned(),
        },
    })?;
    let revision = relations["revision"]
        .as_u64()
        .ok_or("依赖关系修订号不可用，不能确认卸载影响")?;
    let dependents = relations["dependents"]
        .as_array()
        .ok_or("依赖关系清单不可用，不能确认卸载影响")?
        .clone();
    Ok((revision, dependents))
}

/// Internal StoreRequest reads retain exact receipts. Public reads must use this
/// projection so registry before/after values never reach agents, UI or logs.
pub(crate) fn public_record(resource: &ResourceRecord) -> Value {
    let mut value = json!(resource);
    scrub_public_receipts(&mut value);
    value
}

pub(crate) fn scrub_public_receipts(value: &mut Value) {
    match value {
        Value::Object(object) => {
            let receipt = object
                .get("address")
                .and_then(|address| address["kind"].as_str())
                .is_some_and(|kind| {
                    [
                        "shortcut",
                        "directoryLink",
                        "registryValue",
                        "userPathFragment",
                    ]
                    .contains(&kind)
                })
                && (object.contains_key("receiptId") || object.contains_key("integrationId"));
            if receipt {
                object.remove("before");
                object.remove("installed");
            }
            for (key, child) in object {
                if key.to_lowercase().ends_with("systementries") {
                    if let Some(entries) = child.as_array_mut() {
                        for entry in entries {
                            if let Some(entry) = entry.as_object_mut() {
                                entry.remove("before");
                                entry.remove("installed");
                            }
                        }
                    }
                }
                scrub_public_receipts(child);
            }
        }
        Value::Array(array) => {
            for child in array {
                scrub_public_receipts(child);
            }
        }
        _ => {}
    }
}

fn path_key(path: &Path) -> String {
    let path = display(path).replace('\\', "/");
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path
    }
}

fn path_overlap(first: &Path, second: &Path) -> bool {
    let first = path_key(first).trim_end_matches('/').to_owned();
    let second = path_key(second).trim_end_matches('/').to_owned();
    first == second
        || first.starts_with(&format!("{second}/"))
        || second.starts_with(&format!("{first}/"))
}

fn removal_shared_scope(m: &Manager, id: &str) -> Result<Value, String> {
    let mut rows = vec![];
    let resources = m.resource_store(StoreRequest::List)?;
    for resource in resources["resources"]
        .as_array()
        .ok_or("资源目录不可读，不能核对共享归属")?
    {
        if resource["id"] == id {
            continue;
        }
        let declared = resource["rootPath"]
            .as_str()
            .ok_or("共享资源缺少真实目录")?;
        let resolved = crate::local::canonical(Path::new(declared))
            .unwrap_or_else(|_| PathBuf::from(declared));
        let record: ResourceRecord =
            serde_json::from_value(resource.clone()).map_err(|e| e.to_string())?;
        let keys: Vec<_> = record
            .installation
            .as_ref()
            .map(|record| {
                record
                    .system_entries
                    .iter()
                    .map(|entry| system_ownership::address_key(&entry.address))
                    .collect()
            })
            .unwrap_or_default();
        rows.push(
            json!({"kind":"tool","id":resource["id"],"path":display(&resolved),"systemKeys":keys}),
        );
        if let Some(update) = record
            .installation
            .as_ref()
            .and_then(|installation| installation.update_state.as_ref())
        {
            for root in update
                .previous
                .iter()
                .map(|version| &version.root)
                .chain(update.candidate.iter().map(|candidate| &candidate.root))
                .chain(
                    update
                        .retained_candidates
                        .iter()
                        .map(|retained| &retained.candidate.root),
                )
            {
                let resolved = crate::local::canonical(root).unwrap_or_else(|_| root.clone());
                rows.push(json!({"kind":"retainedRuntime","id":resource["id"],"path":display(&resolved),"systemKeys":[]}));
            }
        }
        for action in &record.actions {
            for field in ["executable", "workingDirectory"] {
                if let Some(path) = action[field]
                    .as_str()
                    .filter(|path| Path::new(path).is_absolute())
                {
                    let resolved = crate::local::canonical(Path::new(path))
                        .unwrap_or_else(|_| PathBuf::from(path));
                    rows.push(json!({"kind":"action","id":resource["id"],"path":display(&resolved),"systemKeys":[]}));
                }
            }
        }
    }
    let live = m.snapshot();
    for skill in live["skills"]
        .as_array()
        .ok_or("Skill 目录不可读，不能核对共享归属")?
    {
        if let Some(declared) = skill["localPath"].as_str() {
            let resolved = crate::local::canonical(Path::new(declared))
                .unwrap_or_else(|_| PathBuf::from(declared));
            rows.push(
                json!({"kind":"skill","id":skill["id"],"path":display(&resolved),"systemKeys":[]}),
            );
        }
    }
    let snapshot = m.storage.snapshot()?;
    let mut manager_paths = vec![PathBuf::from(
        snapshot["managedRoot"]
            .as_str()
            .ok_or("管理器根目录不可核对")?,
    )];
    for value in snapshot["paths"]
        .as_object()
        .ok_or("管理器保存范围不可核对")?
        .values()
    {
        manager_paths.push(PathBuf::from(
            value["effective"]
                .as_str()
                .ok_or("管理器保存路径不可核对")?,
        ));
    }
    if let Some(developer) = snapshot["developer"].as_object() {
        manager_paths.extend(
            ["projectRoot", "dependencyRoot"]
                .iter()
                .filter_map(|field| {
                    developer
                        .get(*field)
                        .and_then(Value::as_str)
                        .map(PathBuf::from)
                }),
        );
    }
    for path in manager_paths {
        rows.push(json!({"kind":"manager","id":"managed","path":display(&path),"systemKeys":[]}));
    }
    rows.sort_by_key(Value::to_string);
    Ok(json!(rows))
}

fn root_shared(root: &Path, scope: &Value) -> bool {
    scope.as_array().is_none_or(|rows| {
        rows.iter().any(|row| {
            row["path"]
                .as_str()
                .is_some_and(|path| path_overlap(root, Path::new(path)))
        })
    })
}

fn shared_system_keys(ownership: &[OwnedSystemEntry], scope: &Value) -> BTreeSet<String> {
    let mut keys = BTreeSet::new();
    for row in scope.as_array().into_iter().flatten() {
        keys.extend(
            row["systemKeys"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned),
        );
        if let Some(root) = row["path"].as_str() {
            for owner in ownership {
                let path = match &owner.address {
                    system_ownership::SystemAddress::Shortcut { path, .. }
                    | system_ownership::SystemAddress::DirectoryLink { path, .. } => Some(path),
                    _ => None,
                };
                if path.is_some_and(|path| path_overlap(path, Path::new(root))) {
                    keys.insert(system_ownership::address_key(&owner.address));
                }
            }
        }
    }
    keys
}

fn verify_removal_files(plan: &RemovalPlan) -> Result<(), String> {
    if plan.entries.is_empty() {
        return Ok(());
    }
    crate::transaction::verify_root(&plan.root)?;
    for entry in &plan.entries {
        let target = crate::local::safe_join(&plan.root, &entry.relative)?;
        if target != entry.path {
            return Err("文件真实路径已变化，请重新预览".into());
        }
        let current = match fs::symlink_metadata(&target) {
            Ok(_) => Some(resource_files::fingerprint(&target)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.to_string()),
        };
        if current != entry.expected {
            return Err(format!(
                "文件自预览后变化，尚未处理文件或系统项：{}",
                display(&target)
            ));
        }
    }
    Ok(())
}

fn file_requested(
    entry: &resource_files::RemovalEntry,
    extent: &RemovalExtent,
    custom: &[String],
) -> bool {
    match extent {
        RemovalExtent::Disable => false,
        RemovalExtent::Runtime => matches!(
            entry.role,
            FileRole::Runtime | FileRole::PrivateDependency | FileRole::License
        ),
        RemovalExtent::Complete => true,
        RemovalExtent::Custom => custom.contains(&entry.relative),
    }
}

fn runtime_key(kind: &str, root: &Path) -> String {
    format!("{kind}:{:x}", Sha256::digest(path_key(root).as_bytes()))
}

fn historical_ownership(resource: &ResourceRecord) -> Vec<RuntimeOwnership> {
    let Some(update) = resource
        .installation
        .as_ref()
        .filter(|installation| installation.schema_version == 1)
        .and_then(|installation| installation.update_state.as_ref())
    else {
        return vec![];
    };
    let mut roots = vec![];
    for (index, previous) in update.previous.iter().enumerate() {
        roots.push(RuntimeOwnership {
            id: runtime_key("previous", &previous.root),
            label: format!(
                "上一运行版本 {}",
                previous.version.as_deref().unwrap_or("未知")
            ),
            slot: RuntimeSlot::Previous { index },
            root: previous.root.clone(),
            files: previous.files.clone(),
            unowned_paths: previous.retained_repair_files.clone(),
            manifest: previous.resource_manifest.clone(),
        });
    }
    if let Some(candidate) = &update.candidate {
        roots.push(RuntimeOwnership {
            id: runtime_key("candidate", &candidate.root),
            label: format!("待应用候选 {}", candidate.version),
            slot: RuntimeSlot::Candidate,
            root: candidate.root.clone(),
            files: candidate.files.clone(),
            unowned_paths: candidate.created_paths.clone(),
            manifest: candidate.resource_manifest.clone(),
        });
    }
    for (index, retained) in update.retained_candidates.iter().enumerate() {
        let candidate = &retained.candidate;
        roots.push(RuntimeOwnership {
            id: runtime_key("retained", &candidate.root),
            label: format!("保留候选 {}", candidate.version),
            slot: RuntimeSlot::RetainedCandidate { index },
            root: candidate.root.clone(),
            files: candidate.files.clone(),
            unowned_paths: candidate.created_paths.clone(),
            manifest: candidate.resource_manifest.clone(),
        });
    }
    roots
}

fn selection_id(runtime: &str, path: &str) -> String {
    if runtime == "current" {
        path.into()
    } else {
        format!("{runtime}::{path}")
    }
}

fn preview_runtime_files(
    root: &Path,
    owned: &[OwnedFile],
    extent: &RemovalExtent,
    custom: &[String],
) -> Result<(RemovalPlan, Option<String>, bool), String> {
    crate::transaction::verify_root(root)?;
    if *extent == RemovalExtent::Disable || owned.is_empty() {
        return Ok((
            RemovalPlan {
                id: uuid::Uuid::new_v4().to_string(),
                root: root.to_owned(),
                extent: extent.clone(),
                entries: vec![],
            },
            None,
            false,
        ));
    }
    for file in owned {
        crate::local::validate_relative_path(&file.path)?;
        if file.installed_sha256.len() != 64
            || !file
                .installed_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(format!(
                "文件缺少可信安装摘要，现有内容保留：{}",
                display(&root.join(&file.path))
            ));
        }
    }
    match fs::symlink_metadata(root) {
        Ok(metadata) if !metadata.is_dir() => Err("已登记版本目录不再是普通目录，未处理".into()),
        Ok(_) => {
            let plan = resource_files::preview_removal(root, owned, extent.clone(), custom)?;
            let identity = crate::clients::file_identity(&plan.root)?;
            Ok((plan, Some(identity), false))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut paths = BTreeSet::new();
            let entries = owned
                .iter()
                .map(|file| {
                    if !paths.insert(file.path.to_lowercase()) {
                        return Err("版本归属清单包含重复路径".to_owned());
                    }
                    Ok(resource_files::RemovalEntry {
                        path: root.join(&file.path),
                        relative: file.path.clone(),
                        role: file.role.clone(),
                        remove: false,
                        reason: "文件及版本目录已不存在；仅核对并结束所选归属".into(),
                        expected: None,
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;
            Ok((
                RemovalPlan {
                    id: uuid::Uuid::new_v4().to_string(),
                    root: root.to_owned(),
                    extent: extent.clone(),
                    entries,
                },
                None,
                true,
            ))
        }
        Err(error) => Err(error.to_string()),
    }
}

fn verify_runtime(plan: &RemovalPlan, identity: Option<&str>, missing: bool) -> Result<(), String> {
    if missing {
        crate::transaction::verify_root(&plan.root)?;
        return match fs::symlink_metadata(&plan.root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            _ => Err("预览时不存在的版本目录已变化，请重新预览".into()),
        };
    }
    if let Some(identity) = identity {
        crate::transaction::verify_root(&plan.root)?;
        if crate::clients::file_identity(&plan.root)? != identity {
            return Err("原运行目录对象已替换，请重新预览".into());
        }
    }
    verify_removal_files(plan)
}

fn public_file_entries(plan: &RemovalPlan, id: &str, label: &str) -> Vec<Value> {
    plan.entries
        .iter()
        .map(|entry| {
            let mut value = json!(entry);
            value["runtimeId"] = json!(id);
            value["runtimeLabel"] = json!(label);
            value["selectionId"] = json!(selection_id(id, &entry.relative));
            value
        })
        .collect()
}

fn apply_runtime_files(
    plan: &RemovalPlan,
    identity: Option<&str>,
    missing: bool,
) -> resource_files::RemovalResult {
    let checked = verify_runtime(plan, identity, missing);
    if let Err(error) = checked {
        return resource_files::RemovalResult {
            plan_id: plan.id.clone(),
            deleted: vec![],
            retained: plan
                .entries
                .iter()
                .map(|entry| entry.path.clone())
                .collect(),
            failures: vec![(plan.root.clone(), error)],
        };
    }
    if missing {
        return resource_files::RemovalResult {
            plan_id: plan.id.clone(),
            deleted: vec![],
            retained: plan
                .entries
                .iter()
                .map(|entry| entry.path.clone())
                .collect(),
            failures: vec![],
        };
    }
    resource_files::apply_removal(plan).unwrap_or_else(|error| resource_files::RemovalResult {
        plan_id: plan.id.clone(),
        deleted: vec![],
        retained: plan
            .entries
            .iter()
            .map(|entry| entry.path.clone())
            .collect(),
        failures: vec![(plan.root.clone(), error)],
    })
}

fn prune_files(
    files: &mut Vec<OwnedFile>,
    plan: &RemovalPlan,
    custom: &[String],
    result: &resource_files::RemovalResult,
) {
    files.retain(|file| {
        !plan.entries.iter().any(|entry| {
            entry.relative == file.path
                && (result.deleted.contains(&entry.path)
                    || (result.failures.is_empty()
                        && entry.expected.is_none()
                        && file_requested(entry, &plan.extent, custom)))
        })
    });
}

fn prune_historical(
    resource: &mut ResourceRecord,
    runtime: &RuntimeRemoval,
    result: &resource_files::RemovalResult,
) -> Result<(), String> {
    let update = resource
        .installation
        .as_mut()
        .and_then(|installation| installation.update_state.as_mut())
        .ok_or("版本归属已失效")?;
    match runtime.slot {
        RuntimeSlot::Previous { index } => {
            let previous = update.previous.get_mut(index).ok_or("上一版本归属已变化")?;
            prune_files(
                &mut previous.files,
                &runtime.plan,
                &runtime.custom_files,
                result,
            );
            previous.reason = "已处理本次所选归属；未选、改造及未知文件保留，原目录不删除".into();
        }
        RuntimeSlot::Candidate | RuntimeSlot::RetainedCandidate { .. } => {
            let candidate = match runtime.slot {
                RuntimeSlot::Candidate => update.candidate.as_mut().ok_or("候选归属已变化")?,
                RuntimeSlot::RetainedCandidate { index } => {
                    &mut update
                        .retained_candidates
                        .get_mut(index)
                        .ok_or("保留候选归属已变化")?
                        .candidate
                }
                RuntimeSlot::Previous { .. } => unreachable!(),
            };
            prune_files(
                &mut candidate.files,
                &runtime.plan,
                &runtime.custom_files,
                result,
            );
            candidate.created_paths.retain(|path| {
                !runtime.plan.entries.iter().any(|entry| {
                    path_key(path) == path_key(&entry.path)
                        && (result
                            .deleted
                            .iter()
                            .any(|deleted| path_key(deleted) == path_key(path))
                            || (result.failures.is_empty()
                                && entry.expected.is_none()
                                && file_requested(
                                    entry,
                                    &runtime.plan.extent,
                                    &runtime.custom_files,
                                )))
                })
            });
            if !result.deleted.is_empty()
                || (runtime.root_missing
                    && runtime.plan.entries.iter().any(|entry| {
                        file_requested(entry, &runtime.plan.extent, &runtime.custom_files)
                    }))
            {
                candidate.complete = false;
                candidate.error = Some("候选的部分运行文件已按本次确认移除，不可用于切换".into());
            }
        }
    }
    Ok(())
}

fn preview_metadata(
    root: &Path,
    runtime_id: &str,
    label: &str,
    slot: Option<RuntimeSlot>,
    record: &crate::resource_manifest::ManifestRecord,
    extent: &RemovalExtent,
    custom: &[String],
) -> MetadataRemoval {
    let id = format!("metadata:{runtime_id}");
    let requested = *extent == RemovalExtent::Complete
        || (*extent == RemovalExtent::Custom && custom.contains(&id));
    let mut entry = MetadataRemoval {
        id,
        runtime_id: runtime_id.into(),
        runtime_label: label.into(),
        root: root.to_owned(),
        slot,
        record: record.clone(),
        root_identity: None,
        root_missing: false,
        expected: None,
        file_identity: None,
        status: "unavailable".into(),
        requested,
        remove: false,
        reason: "管理记录无法完整核对，保持原样".into(),
    };
    let checked: Result<(), String> = (|| {
        crate::transaction::verify_root(root)?;
        match fs::symlink_metadata(root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                entry.root_missing = true;
                entry.status = "absent".into();
                entry.reason = "版本目录及管理记录已不存在，不重复删除".into();
                return Ok(());
            }
            Err(error) => return Err(error.to_string()),
            Ok(metadata) if !metadata.is_dir() => {
                return Err("管理记录所在位置已不是普通目录".into())
            }
            Ok(_) => entry.root_identity = Some(crate::clients::file_identity(root)?),
        }
        let target = crate::local::safe_join(root, crate::resource_manifest::NAME)?;
        match fs::symlink_metadata(&target) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                entry.status = "absent".into();
                entry.reason = "管理记录已不存在，不重复删除".into();
                return Ok(());
            }
            Err(error) => return Err(error.to_string()),
            Ok(_) => {}
        }
        entry.expected = Some(resource_files::fingerprint(&target)?);
        entry.file_identity = Some(crate::clients::file_identity(&target)?);
        match crate::resource_manifest::validate_owned(root, record) {
            Ok(()) => {
                entry.status = "owned".into();
                entry.remove = requested;
                entry.reason = if requested {
                    "仅删除本次已核实的资源侧管理记录，不触及运行文件或其他配置"
                } else {
                    "本次程度保留资源侧管理记录；它不是运行文件或许可证"
                }
                .into();
            }
            Err(error) => {
                entry.status = "changed".into();
                entry.reason = format!("管理记录已变化或归属不可核对，保留：{error}");
            }
        }
        Ok(())
    })();
    if let Err(error) = checked {
        entry.reason = format!("管理记录保持原样：{error}");
    }
    entry
}

fn metadata_public(entry: &MetadataRemoval) -> Value {
    json!({"id":entry.id,"runtimeId":entry.runtime_id,"runtimeLabel":entry.runtime_label,"root":entry.root,"path":entry.root.join(crate::resource_manifest::NAME),
        "relativePath":crate::resource_manifest::NAME,"kind":"resourceMetadata","requested":entry.requested,"remove":entry.remove,"status":entry.status,"reason":entry.reason})
}

fn verify_metadata(entry: &MetadataRemoval) -> Result<(), String> {
    crate::transaction::verify_root(&entry.root)?;
    if entry.root_missing {
        return match fs::symlink_metadata(&entry.root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            _ => Err("管理记录所在版本目录自预览后出现，请重新确认".into()),
        };
    }
    if let Some(expected) = &entry.root_identity {
        if crate::clients::file_identity(&entry.root)? != *expected {
            return Err("管理记录所在目录对象已变化，请重新确认".into());
        }
    }
    if entry.status == "unavailable" {
        return Ok(());
    }
    let path = crate::local::safe_join(&entry.root, crate::resource_manifest::NAME)?;
    let actual = match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
        Ok(_) => Some(resource_files::fingerprint(&path)?),
    };
    if actual != entry.expected {
        return Err("资源侧管理记录自预览后变化，请重新确认".into());
    }
    if let Some(expected) = &entry.file_identity {
        if crate::clients::file_identity(&path)? != *expected {
            return Err("资源侧管理记录对象已替换，请重新确认".into());
        }
    }
    if entry.remove {
        crate::resource_manifest::validate_owned(&entry.root, &entry.record)?;
    }
    Ok(())
}

fn clear_metadata(resource: &mut ResourceRecord, entry: &MetadataRemoval) -> Result<(), String> {
    let installation = resource
        .installation
        .as_mut()
        .ok_or("管理记录的安装归属缺失")?;
    let record = match entry.slot {
        None => &mut installation.resource_manifest,
        Some(RuntimeSlot::Previous { index }) => {
            &mut installation
                .update_state
                .as_mut()
                .and_then(|state| state.previous.get_mut(index))
                .ok_or("上一版本管理记录归属已变化")?
                .resource_manifest
        }
        Some(RuntimeSlot::Candidate) => {
            &mut installation
                .update_state
                .as_mut()
                .and_then(|state| state.candidate.as_mut())
                .ok_or("候选管理记录归属已变化")?
                .resource_manifest
        }
        Some(RuntimeSlot::RetainedCandidate { index }) => {
            &mut installation
                .update_state
                .as_mut()
                .and_then(|state| state.retained_candidates.get_mut(index))
                .ok_or("保留候选管理记录归属已变化")?
                .candidate
                .resource_manifest
        }
    };
    if record.as_ref() != Some(&entry.record) {
        return Err("管理记录归属已变化，未清除登记".into());
    }
    *record = None;
    Ok(())
}

fn delete_metadata(entry: &MetadataRemoval) -> Result<(), String> {
    verify_metadata(entry)?;
    let (path, expected) = crate::resource_manifest::registered_file(&entry.root, &entry.record)?;
    let plan = RemovalPlan {
        id: uuid::Uuid::new_v4().to_string(),
        root: crate::local::canonical(&entry.root)?,
        extent: RemovalExtent::Custom,
        entries: vec![resource_files::RemovalEntry {
            path: path.clone(),
            relative: crate::resource_manifest::NAME.into(),
            role: FileRole::Configuration,
            remove: true,
            reason: "已确认单独删除资源侧管理记录".into(),
            expected: Some(expected),
        }],
    };
    let result = resource_files::apply_removal(&plan)?;
    if result.deleted.contains(&path) && result.failures.is_empty() {
        Ok(())
    } else {
        Err(result
            .failures
            .first()
            .map(|(_, error)| error.clone())
            .unwrap_or_else(|| "管理记录删除结果未核实".into()))
    }
}

fn preview_remove(m: &mut Manager, request: &Value) -> Result<Value, String> {
    preview_remove_with(m, request, &system_ownership::NativeSystemAccess)
}

fn preview_remove_with(
    m: &mut Manager,
    request: &Value,
    access: &impl SystemAccess,
) -> Result<Value, String> {
    if request.as_object().is_none_or(|object| {
        object.keys().any(|key| {
            ![
                "action",
                "id",
                "expectedRevision",
                "extent",
                "customFiles",
                "customSystemIds",
            ]
            .contains(&key.as_str())
        })
    }) {
        return Err("卸载预览仅接受资源、程度和本次自定义标识，不能传入归属记录".into());
    }
    let resource = read_resource(m, &text(request, "id", 64)?)?;
    let expected = request["expectedRevision"]
        .as_u64()
        .ok_or("缺少当前资源修订号")?;
    if resource.revision != expected {
        return Err("资源已变化，请重新读取后选择卸载程度".into());
    }
    let extent: RemovalExtent = serde_json::from_value(request["extent"].clone())
        .map_err(|_| "每次卸载必须重新选择明确的卸载程度")?;
    let custom = if extent == RemovalExtent::Custom && request.get("customFiles").is_some() {
        paths(request, "customFiles")?
    } else {
        vec![]
    };
    let owned = resource
        .installation
        .as_ref()
        .filter(|r| r.schema_version == 1)
        .map(|r| r.files.as_slice())
        .unwrap_or(&[]);
    let historical = if extent == RemovalExtent::Disable {
        vec![]
    } else {
        historical_ownership(&resource)
    };
    if historical.len() > 128
        || owned.len()
            + historical
                .iter()
                .map(|runtime| runtime.files.len())
                .sum::<usize>()
            > 200_000
    {
        return Err("受管版本数量或文件范围过多，请分批核对".into());
    }
    let mut metadata = vec![];
    if let Some(record) = resource
        .installation
        .as_ref()
        .filter(|installation| installation.schema_version == 1)
        .and_then(|installation| installation.resource_manifest.as_ref())
    {
        metadata.push(preview_metadata(
            Path::new(&resource.root_path),
            "current",
            "当前运行版本",
            None,
            record,
            &extent,
            &custom,
        ));
    }
    metadata.extend(historical.iter().filter_map(|runtime| {
        runtime.manifest.as_ref().map(|manifest| {
            preview_metadata(
                &runtime.root,
                &runtime.id,
                &runtime.label,
                Some(runtime.slot),
                manifest,
                &extent,
                &custom,
            )
        })
    }));
    let known: BTreeSet<_> = owned
        .iter()
        .map(|file| file.path.clone())
        .chain(historical.iter().flat_map(|runtime| {
            runtime
                .files
                .iter()
                .map(|file| selection_id(&runtime.id, &file.path))
        }))
        .chain(metadata.iter().map(|entry| entry.id.clone()))
        .collect();
    if custom.iter().any(|path| !known.contains(path)) {
        return Err("自定义选择包含归属不明的文件".into());
    }
    let current_custom: Vec<_> = custom
        .iter()
        .filter(|path| owned.iter().any(|file| file.path.as_str() == path.as_str()))
        .cloned()
        .collect();
    let system_owned = resource
        .installation
        .as_ref()
        .filter(|record| record.schema_version == 1)
        .map(|record| record.system_entries.as_slice())
        .unwrap_or(&[]);
    let custom_system: BTreeSet<String> =
        if extent == RemovalExtent::Custom && request.get("customSystemIds").is_some() {
            paths(request, "customSystemIds")?.into_iter().collect()
        } else {
            BTreeSet::new()
        };
    if custom_system.len() > 1024 {
        return Err("自定义系统项清单过长".into());
    }
    let shared_scope = removal_shared_scope(m, &resource.id)?;
    let shared_system = shared_system_keys(system_owned, &shared_scope);
    let system_plan = system_ownership::preview(
        system_owned,
        &extent,
        &custom_system,
        &shared_system,
        access,
    )?;
    let (relations_revision, dependents) = removal_relations(m, &resource.id)?;
    let (plan, root_identity, current_missing) = preview_runtime_files(
        Path::new(&resource.root_path),
        owned,
        &extent,
        &current_custom,
    )?;
    let mut runtime_plans = vec![];
    let mut protected_entries = vec![];
    let mut root_paths = vec![plan.root.clone()];
    if resource
        .installation
        .as_ref()
        .and_then(|installation| installation.resource_manifest.as_ref())
        .is_none()
        && fs::symlink_metadata(plan.root.join(crate::resource_manifest::NAME)).is_ok()
    {
        protected_entries.push(json!({"path":plan.root.join(crate::resource_manifest::NAME),"reason":"没有精确的管理记录归属；现有同名文件保持原样","runtimeId":"current"}));
    }
    for runtime in &historical {
        for path in &runtime.unowned_paths {
            if fs::symlink_metadata(path)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            {
                continue;
            }
            let known = runtime
                .files
                .iter()
                .any(|file| path_key(&runtime.root.join(&file.path)) == path_key(path))
                || (runtime.manifest.is_some()
                    && path_key(path)
                        == path_key(&runtime.root.join(crate::resource_manifest::NAME)));
            if !known {
                protected_entries.push(json!({"path":display(path),"reason":"仅有创建或修复路径记录，缺少文件摘要归属；保留，不会递归删除","runtimeId":runtime.id}));
            }
        }
        if runtime.manifest.is_none()
            && fs::symlink_metadata(runtime.root.join(crate::resource_manifest::NAME)).is_ok()
            && !protected_entries.iter().any(|entry| {
                entry["path"].as_str().is_some_and(|path| {
                    path_key(Path::new(path))
                        == path_key(&runtime.root.join(crate::resource_manifest::NAME))
                })
            })
        {
            protected_entries.push(json!({"path":runtime.root.join(crate::resource_manifest::NAME),"reason":"没有精确的管理记录归属；现有同名文件保持原样","runtimeId":runtime.id}));
        }
        if runtime.files.is_empty() && runtime.manifest.is_none() {
            continue;
        }
        let root = crate::local::canonical(&runtime.root).unwrap_or_else(|_| runtime.root.clone());
        if root_paths.iter().any(|known| path_overlap(&root, known)) {
            return Err("受管版本目录相互重叠，不能按独立归属卸载；现有内容保留".into());
        }
        root_paths.push(root);
        if runtime.files.is_empty() {
            continue;
        }
        let runtime_custom: Vec<_> = runtime
            .files
            .iter()
            .filter(|file| custom.contains(&selection_id(&runtime.id, &file.path)))
            .map(|file| file.path.clone())
            .collect();
        let (runtime_plan, identity, missing) =
            preview_runtime_files(&runtime.root, &runtime.files, &extent, &runtime_custom)?;
        runtime_plans.push(RuntimeRemoval {
            id: runtime.id.clone(),
            label: runtime.label.clone(),
            slot: runtime.slot,
            plan: runtime_plan,
            root_identity: identity,
            root_missing: missing,
            custom_files: runtime_custom,
        });
    }
    let removes_files = plan
        .entries
        .iter()
        .chain(
            runtime_plans
                .iter()
                .flat_map(|runtime| runtime.plan.entries.iter()),
        )
        .any(|entry| entry.remove);
    let removes_metadata = metadata.iter().any(|entry| entry.remove);
    let removes_system = system_plan.entries.iter().any(|entry| {
        matches!(
            entry.operation,
            system_ownership::Operation::Remove | system_ownership::Operation::Restore
        )
    });
    let shared_root = (plan.entries.iter().any(|entry| entry.remove)
        && root_shared(&plan.root, &shared_scope))
        || runtime_plans.iter().any(|runtime| {
            runtime.plan.entries.iter().any(|entry| entry.remove)
                && root_shared(&runtime.plan.root, &shared_scope)
        })
        || metadata
            .iter()
            .any(|entry| entry.remove && root_shared(&entry.root, &shared_scope));
    let can_apply = (extent == RemovalExtent::Disable
        || !owned.is_empty()
        || !system_owned.is_empty()
        || !runtime_plans.is_empty()
        || !metadata.is_empty())
        && !((removes_files || removes_system || removes_metadata) && !dependents.is_empty())
        && !shared_root;
    let id = plan.id.clone();
    let mut warnings = vec![
        "仅处理已核实归属的文件和本次列明的系统项；未知归属、共享内容、来源关联和管理记录保留。"
            .to_owned(),
    ];
    if owned.is_empty()
        && system_owned.is_empty()
        && runtime_plans.is_empty()
        && metadata.is_empty()
    {
        warnings
            .push("没有可信的文件归属清单，只能停用，不能据此执行文件卸载或声称完整卸载。".into());
    }
    if !protected_entries.is_empty() {
        warnings.push("部分候选/修复产物只有创建路径而无可信文件摘要，将原位保留；完整卸载仅处理已核实归属，不清空目录。".into());
    }
    if metadata
        .iter()
        .any(|entry| entry.requested && !entry.remove && entry.status != "absent")
    {
        warnings.push(
            "部分管理记录的内容或对象身份无法核实，将保留并记录为未完成；不按文件名认领。".into(),
        );
    }
    if shared_root && (removes_files || removes_metadata) {
        warnings
            .push("运行目录与其他资源或管理数据重叠，已阻止文件删除；请核对实际共享范围。".into());
    }
    if system_plan
        .entries
        .iter()
        .any(|entry| entry.requested && entry.operation == system_ownership::Operation::Keep)
    {
        warnings.push("部分系统项已改变、被共享或归属无法核对，将保留并记录为未完成。".into());
    }
    if plan
        .entries
        .iter()
        .chain(
            runtime_plans
                .iter()
                .flat_map(|runtime| runtime.plan.entries.iter()),
        )
        .any(|e| !e.remove && e.reason.contains("本地改造"))
    {
        warnings
            .push("存在本地改造文件，将保留；需要删除时请重新选择自定义程度并核对清单。".into());
    }
    if !dependents.is_empty() {
        warnings.push(if extent == RemovalExtent::Disable {
            "此工具有已登记的使用者；停用管理入口可能影响其后续调用，实际文件和依赖关系保留。".into()
        } else if removes_files || removes_system || removes_metadata {
            "此工具仍被其他资源依赖，本次禁止删除文件。请先核实使用情况；只有明确解除对应管理关系后，才能重新预览。".into()
        } else {
            "此工具有已登记的使用者；本次没有可删除文件，停用管理入口仍可能影响后续调用。".into()
        });
        for edge in &dependents {
            let dependent = &edge["dependent"];
            let name = dependent["name"].as_str().unwrap_or("未知资源");
            let id = dependent["id"].as_str().unwrap_or("未知标识");
            let kind = if dependent["kind"] == "skill" {
                "Skill"
            } else {
                "工具"
            };
            let status = if dependent["exists"] == true {
                "已登记的使用者"
            } else {
                "使用者记录已失效或无法核实；依赖关系仍保留，不能据此认定文件可删除"
            };
            warnings.push(format!("{kind}：{name}（{id}）—{status}。"));
        }
    }
    let mut entries = public_file_entries(&plan, "current", "当前运行版本");
    entries.extend(
        runtime_plans
            .iter()
            .flat_map(|runtime| public_file_entries(&runtime.plan, &runtime.id, &runtime.label)),
    );
    let groups:Vec<_>=std::iter::once(json!({"id":"current","label":"当前运行版本","root":plan.root,"files":plan.entries.len()})).chain(runtime_plans.iter().map(|runtime|json!({"id":runtime.id,"label":runtime.label,"root":runtime.plan.root,"files":runtime.plan.entries.len()}))).collect();
    let public = json!({"id":id,"kind":"resourceRemove","resourceId":resource.id,"resourceName":resource.name,
        "targetPath":resource.root_path,"targetPaths":root_paths,"extent":extent,"entries":entries,"metadataEntries":metadata.iter().map(metadata_public).collect::<Vec<_>>(),"runtimeGroups":groups,"protectedEntries":protected_entries,"systemEntries":system_plan.public_entries(),"canApply":can_apply,"warnings":warnings,
        "relationsRevision":relations_revision,"dependents":dependents});
    let prepared = PreparedRemoval {
        resource_id: resource.id.clone(),
        record_revision: resource.revision,
        relations_revision,
        plan,
        root_identity,
        shared_scope,
        system_plan,
        custom_files: current_custom,
        current_missing,
        runtime_plans,
        metadata,
    };
    remember(
        m,
        json!({"kind":"resourceRemove","resourceId":resource.id,"targetPath":resource.root_path,"prepared":prepared}),
        public,
    )
}

fn repair_artifact_directory(request: &Value) -> Result<Option<PathBuf>, String> {
    match request.get("artifactDirectory") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if value.trim().is_empty() => Ok(None),
        Some(Value::String(_)) => Ok(Some(PathBuf::from(text(
            request,
            "artifactDirectory",
            32767,
        )?))),
        _ => Err("原软件包资产目录无效".into()),
    }
}
/// Admission locks use the same exact-origin resolver as the eventual preview.
/// No archive is unpacked and no source is downloaded by this read-only helper.
pub(crate) fn repair_source_paths(m: &Manager, request: &Value) -> Result<Vec<PathBuf>, String> {
    let resource = read_resource(m, &text(request, "id", 64)?)?;
    let installation = resource.installation.as_ref().ok_or("原安装归属缺失")?;
    if let Some(provenance) = &installation.runtime_package {
        let directory = repair_artifact_directory(request)?;
        match provenance.recipe {
            crate::resource_package::Recipe::EdgeMcpNpmV1 => {
                crate::resource_package::repair::source_paths(provenance, directory.as_deref())
            }
            crate::resource_package::Recipe::AgentReachWheelV1 => {
                crate::resource_package::repair_python::source_paths(
                    provenance,
                    directory.as_deref(),
                )
            }
        }
    } else {
        let path = request["archivePath"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&installation.archive_path);
        Ok(vec![PathBuf::from(path)])
    }
}

fn preview_repair(m: &mut Manager, request: &Value) -> Result<Value, String> {
    if request.as_object().is_none_or(|o| {
        o.keys().any(|key| {
            ![
                "action",
                "id",
                "expectedRevision",
                "archivePath",
                "downloadId",
                "artifactDirectory",
            ]
            .contains(&key.as_str())
        })
    }) {
        return Err("修复仅接受资源身份、当前修订号及原发行包；不能另传来源或新版本".into());
    }
    let resource = read_resource(m, &text(request, "id", 64)?)?;
    if request["expectedRevision"].as_u64() != Some(resource.revision) {
        return Err("资源已变化，请重新读取后预览修复".into());
    }
    let installation = resource
        .installation
        .as_ref()
        .filter(|i| i.schema_version == 1 && !i.files.is_empty())
        .ok_or("没有可信的安装文件归属，不能猜测修复范围")?;
    let retained = check_repair_intent(&resource, false)?;
    let override_directory = repair_artifact_directory(request)?;
    let (repair_source, plan, archive, source, source_format) = if let Some(provenance) =
        &installation.runtime_package
    {
        if request
            .get("archivePath")
            .is_some_and(|v| v.as_str().is_some_and(|s| !s.trim().is_empty()))
            || request.get("downloadId").is_some_and(|v| !v.is_null())
        {
            return Err("软件包固定版本修复使用原精确资产，不接受 ZIP 或另一份下载来源".into());
        }
        match provenance.recipe {
            crate::resource_package::Recipe::EdgeMcpNpmV1 => {
                let (source, plan) = crate::resource_package::repair::NpmRepairSource::prepare(
                    Path::new(&resource.root_path),
                    &installation.files,
                    provenance,
                    override_directory.as_deref(),
                )?;
                let public_source = source.public_source()?;
                (
                    RepairSource::Npm { source },
                    plan,
                    None,
                    public_source,
                    "npmTgz",
                )
            }
            crate::resource_package::Recipe::AgentReachWheelV1 => {
                let (source, plan) =
                    crate::resource_package::repair_python::PythonRepairSource::prepare(
                        Path::new(&resource.root_path),
                        &installation.files,
                        provenance,
                        override_directory.as_deref(),
                    )?;
                let public_source = source.public_source()?;
                (
                    RepairSource::PythonWheel { source },
                    plan,
                    None,
                    public_source,
                    "pythonWheel",
                )
            }
        }
    } else {
        if override_directory.is_some() {
            return Err("原 ZIP 修复使用 archivePath，不接受软件包资产目录".into());
        }
        let archive = if request["archivePath"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty())
        {
            archive_path(request)?
        } else {
            archive_path(&json!({"archivePath":installation.archive_path}))?
        };
        let inventory = resource_files::inspect_zip(&archive, MAX_UNPACKED_BYTES)?;
        if inventory.archive.sha256 != installation.archive_sha256 {
            return Err("修复必须使用原安装固定发行包；摘要不一致，未升级或替换".into());
        }
        if let Some(source) =
            crate::resource_github::verified_source(m, request, &archive, &inventory.archive)?
        {
            if source.repository != installation.source_repository.clone().unwrap_or_default()
                || Some(&source.version) != installation.source_version.as_ref()
                || installation
                    .download_source
                    .as_ref()
                    .is_some_and(|original| {
                        serde_json::to_value(original).ok() != serde_json::to_value(&source).ok()
                    })
            {
                return Err("下载回执与原安装来源不一致，不能冒用修复".into());
            }
        }
        let plan = resource_files::preview_repair(
            Path::new(&resource.root_path),
            &installation.files,
            &inventory,
        )?;
        let public_source = match &installation.download_source {
            Some(source) => serde_json::to_value(source).map_err(|e| e.to_string())?,
            None => {
                json!({"repository":installation.source_repository,"version":installation.source_version,"verification":"userProvided"})
            }
        };
        (
            RepairSource::Zip {
                archive_path: archive.clone(),
                inventory,
            },
            plan,
            Some(archive),
            public_source,
            "zip",
        )
    };
    let source_paths = repair_source.paths();
    let has_missing = plan.entries.iter().any(|e| e.decision == "restore");
    let completion_only = !has_missing && installation.pending_repair.is_some();
    if completion_only {
        check_repair_intent(&resource, true)?;
    }
    let can_apply = has_missing || completion_only;
    if let Some(manifest) = &installation.resource_manifest {
        crate::resource_manifest::validate_owned(&plan.root, manifest)?;
    }
    let public = json!({"id":plan.id,"kind":"resourceRepair","resourceId":resource.id,"targetPath":resource.root_path,"archivePath":archive,
        "source":source,"sourceFormat":source_format,"sourcePaths":source_paths,"files":plan.entries,"requiredBytes":plan.required_bytes,"temporaryPaths":plan.entries.iter().filter_map(|e|e.temporary_path.clone()).collect::<Vec<_>>(),"retainedTemporaryPaths":retained,
        "metadata":installation.resource_manifest.as_ref().map(|manifest|json!({"kind":"resourceMetadata","targetPath":plan.root.join(&manifest.relative_path),"operation":"updateRegistered","executionGrant":false,"deleteGrant":false})),
        "canApply":can_apply,"completionOnly":completion_only,"warnings":[if completion_only {"上次缺失文件已补齐；确认后仅核验并完成上次修复记录，不下载或重新写入现有文件。"}else if can_apply {"只补齐原归属清单中缺失的运行、私人依赖和许可文件；现有内容与用户数据不覆盖。"}else{"没有可补齐的缺失运行文件；现有文件和未登记内容保持原样。"},"新临时文件为原发行包的候选字节，不是现有内容备份；失败时保留并列明，不自动清理。","修复不升级、启动工具或验证登录；完成后能力需要重新核验。"]});
    let prepared = PreparedRepair {
        resource_id: resource.id.clone(),
        record_revision: resource.revision,
        source: repair_source,
        plan,
        manifest: installation.resource_manifest.clone(),
    };
    remember(
        m,
        json!({"kind":"resourceRepair","resourceId":resource.id,"targetPath":resource.root_path,"archivePath":archive,"sourcePaths":source_paths,"prepared":prepared}),
        public,
    )
}

fn repair_source_identity(installation: &InstallationRecord) -> Value {
    json!({"archiveSha256":installation.archive_sha256,"repository":installation.source_repository,"version":installation.source_version,"downloadSource":installation.download_source,"runtimePackage":installation.runtime_package})
}

fn retained_repair_path(
    root: &Path,
    path: &Path,
    retained: &mut Vec<PathBuf>,
) -> Result<(), String> {
    crate::transaction::verify_root(path)?;
    if path.parent() != Some(root) {
        return Err("上次修复临时位置不在原运行目录".into());
    }
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() => {
            if !retained.contains(&path.to_owned()) {
                retained.push(path.to_owned());
            }
        }
        Ok(_) => return Err("上次修复临时路径不是普通文件；原件保留，请核对".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    Ok(())
}

fn check_repair_intent(
    resource: &ResourceRecord,
    require_complete: bool,
) -> Result<Vec<PathBuf>, String> {
    let installation = resource.installation.as_ref().ok_or("安装归属缺失")?;
    let root = crate::local::canonical(Path::new(&resource.root_path))?;
    let mut retained = Vec::new();
    for path in &installation.retained_repair_files {
        retained_repair_path(&root, path, &mut retained)?;
    }
    let Some(intent) = &installation.pending_repair else {
        if installation.status == "repairing" {
            return Err("旧修复缺少可核实的收尾记录，保持停用并等待处理".into());
        }
        return Ok(retained);
    };
    if root != intent.original_root
        || repair_source_identity(installation) != intent.original_source
        || serde_json::to_value(&installation.files).map_err(|e| e.to_string())?
            != serde_json::to_value(&intent.owned_files).map_err(|e| e.to_string())?
    {
        return Err("运行根目录、固定来源或文件归属在上次修复后变化，请核对后重新确定范围".into());
    }
    for entry in &intent.entries {
        let target = crate::local::safe_join(&root, &entry.path)?;
        if target != entry.target {
            return Err("上次修复目标路径变化".into());
        }
        if target.try_exists().map_err(|e| e.to_string())? {
            if resource_files::fingerprint(&target)?.sha256 != entry.installed_sha256 {
                return Err("上次修复目标出现本地变化；未覆盖，资源保持停用".into());
            }
        } else if require_complete {
            return Err("上次修复仍有文件缺失，不能宣称收尾完成".into());
        }
        if let Some(temporary) = &entry.temporary_path {
            // These old candidate bytes will neither be reused nor published.
            // A short interrupted file is preserved, not a reason to prohibit a
            // fresh explicitly approved repair using a new temporary path.
            retained_repair_path(&root, temporary, &mut retained)?;
        }
    }
    Ok(retained)
}

pub(crate) fn handle(m: &mut Manager, request: &Value) -> Result<Option<Value>, String> {
    Ok(Some(match request["action"].as_str().unwrap_or_default() {
        "resource_package_inspect" => inspect(request)?,
        "preview_resource_install" => preview_install(m, request)?,
        "preview_resource_remove" => preview_remove(m, request)?,
        "preview_resource_repair" => preview_repair(m, request)?,
        "apply_resource_install" | "apply_resource_remove" | "apply_resource_repair" => {
            return Err("文件安装和卸载只能通过本地管理器界面确认执行".into())
        }
        _ => return Ok(None),
    }))
}

fn apply_repair(m: &Manager, prepared: PreparedRepair) -> Result<Value, String> {
    let mut resource = read_resource(m, &prepared.resource_id)?;
    if resource.revision != prepared.record_revision {
        return Err("资源已变化，请重新预览修复".into());
    }
    let final_revision = resource
        .revision
        .checked_add(2)
        .ok_or("资源修订号超出范围")?;
    let original = resource
        .installation
        .as_ref()
        .ok_or("原安装归属缺失")?
        .clone();
    let retained_temporaries = check_repair_intent(&resource, false)?;
    if original.resource_manifest != prepared.manifest {
        return Err("已登记管理记录归属变化，请重新预览修复".into());
    }
    if let Some(manifest) = &prepared.manifest {
        crate::resource_manifest::validate_owned(&prepared.plan.root, manifest)?;
    }
    let runs = m.resource_runtime.snapshot(Some(&resource.id))?;
    if runs["runs"]
        .as_array()
        .is_some_and(|runs| runs.iter().any(|r| r["status"] == "running"))
    {
        return Err("资源仍在运行，请先停止受管进程后重新预览修复".into());
    }
    prepared.source.verify(&original, &prepared.plan)?;
    let mut intent = original
        .pending_repair
        .clone()
        .unwrap_or_else(|| RepairIntent {
            previous_enabled: resource.enabled,
            previous_status: original.status.clone(),
            previous_error: original.error.clone(),
            known_revision: resource.revision,
            original_root: prepared.plan.root.clone(),
            original_source: repair_source_identity(&original),
            owned_files: original.files.clone(),
            entries: vec![],
        });
    if resource.revision != intent.known_revision {
        // A newer user edit invalidates old previews but not the immutable file
        // scope. The new preview respects the current enabled choice.
        intent.previous_enabled = resource.enabled;
    }
    intent.entries.extend(
        prepared
            .plan
            .entries
            .iter()
            .filter(|e| e.decision == "restore")
            .cloned(),
    );
    resource.enabled = false;
    resource.revision += 1;
    resource.updated_at = now();
    let installation = resource.installation.as_mut().ok_or("原安装归属缺失")?;
    installation.status = "repairing".into();
    installation.error = None;
    intent.known_revision = resource.revision;
    installation.pending_repair = Some(intent.clone());
    for capability in &mut resource.capabilities {
        if let Some(object) = capability.as_object_mut() {
            object.insert("status".into(), json!("unverified"));
            object.insert(
                "reason".into(),
                json!("修复期间暂停调用；完成后需重新核验能力"),
            );
        }
    }
    m.resource_store(StoreRequest::Replace {
        record: Box::new(resource.clone()),
        expected_revision: prepared.record_revision,
    })?;
    let reserved = resource.clone();
    let mut receipt = match prepared.source.apply(&prepared.plan) {
        Ok(receipt) => receipt,
        Err(error) => resource_files::RepairReceipt {
            restored: vec![],
            retained: prepared
                .plan
                .entries
                .iter()
                .filter(|e| e.decision == "preserve")
                .map(|e| e.target.clone())
                .collect(),
            failures: vec![(prepared.plan.root.clone(), error)],
            temporary_paths: vec![],
        },
    };
    for path in retained_temporaries {
        if !receipt.temporary_paths.contains(&path) {
            receipt.temporary_paths.push(path);
        }
    }
    if receipt.failures.is_empty() {
        if let Err(error) = check_repair_intent(&resource, true) {
            receipt.failures.push((prepared.plan.root.clone(), error));
        }
    }
    let files_complete = receipt.failures.is_empty()
        && receipt.restored.len()
            == prepared
                .plan
                .entries
                .iter()
                .filter(|e| e.decision == "restore")
                .count();
    let metadata = if let Some(expected) = &prepared.manifest {
        match refresh_manifest(
            &resource,
            &prepared.plan.root,
            expected,
            files_complete && intent.previous_status == "installed",
        ) {
            Ok(manifest) => {
                resource
                    .installation
                    .as_mut()
                    .ok_or("安装归属缺失")?
                    .resource_manifest = Some(manifest.clone());
                json!({"status":"updated","record":manifest})
            }
            Err(error) => {
                receipt.failures.push((
                    prepared.plan.root.join(crate::resource_manifest::NAME),
                    error.clone(),
                ));
                json!({"status":"failed","reason":error})
            }
        }
    } else {
        json!({"status":"notRegistered","reason":"没有管理器创建的精确记录，现有同名文件保持原样"})
    };
    let complete = files_complete && receipt.failures.is_empty();
    resource.enabled = complete && intent.previous_enabled;
    let installation = resource.installation.as_mut().ok_or("原安装归属缺失")?;
    // Repair does not invent ownership or turn a formerly incomplete install
    // into a verified complete package. Only its missing registered subset changed.
    installation.status = if complete {
        intent.previous_status.clone()
    } else {
        "partial".into()
    };
    installation.error = if complete {
        intent.previous_error.clone()
    } else {
        Some("修复未完整完成，资源保持停用，请查看文件回执".into())
    };
    intent.known_revision = final_revision;
    installation.pending_repair = (!complete).then_some(intent);
    for path in &receipt.temporary_paths {
        if !installation.retained_repair_files.contains(path) {
            installation.retained_repair_files.push(path.clone());
        }
    }
    resource.revision = final_revision;
    resource.updated_at = now();
    for capability in &mut resource.capabilities {
        if let Some(object) = capability.as_object_mut() {
            object.insert(
                "reason".into(),
                json!(if complete {
                    "已补齐所选缺失文件；运行能力需重新核验"
                } else {
                    "修复未完成，资源停用；请核对回执"
                }),
            );
        }
    }
    match m.resource_store(StoreRequest::Replace {
        record: Box::new(resource.clone()),
        expected_revision: final_revision - 1,
    }) {
        Ok(_) => Ok(
            json!({"resource":resource,"receipt":receipt,"metadata":metadata,"complete":complete,"ownershipSaved":true}),
        ),
        Err(error) => Ok(
            json!({"resource":reserved,"receipt":receipt,"metadata":metadata,"complete":false,"ownershipSaved":false,"warning":format!("文件回执已保留，但修复记录保存失败；资源仍停用：{error}")}),
        ),
    }
}

fn apply_install(m: &Manager, prepared: PreparedInstall) -> Result<Value, String> {
    apply_install_with_metadata(m, prepared, |resource, receipt| {
        let metadata = prepare_manifest(resource, &receipt.root, &receipt.files, receipt.complete)?;
        crate::resource_manifest::write_new(&receipt.root, &metadata)
    })
}

/// Admits only a backend materialization receipt. It never reinterprets a
/// generated environment as the contents of an upstream release archive.
pub(crate) fn register_materialized(
    m: &Manager,
    name: &str,
    package: crate::resource_package::controller::MaterializedPackage,
) -> Result<Value, String> {
    if m.basic_mode || package.binding.is_some() {
        return Err("此运行包不能作为新安装登记".into());
    }
    let provenance = package.provenance;
    provenance.recheck_shared_runtime()?;
    let receipt = package.receipt;
    ensure_independent_destination(m, &receipt.root)?;
    if !receipt.complete
        || !receipt.dependency_check_passed
        || receipt.execution_verified
        || receipt.files.is_empty()
        || receipt.files.iter().any(|f| {
            !matches!(
                f.role,
                FileRole::Runtime | FileRole::PrivateDependency | FileRole::License
            )
        })
    {
        return Err("真实运行包文件归属尚未完整核对".into());
    }
    let repository = provenance.source_repository()?;
    let (kind, executable, args) = match provenance.recipe {
        crate::resource_package::Recipe::AgentReachWheelV1 => (
            "cli",
            receipt.root.join("Scripts/agent-reach.exe"),
            vec![json!({"type":"literal","value":"version"})],
        ),
        crate::resource_package::Recipe::EdgeMcpNpmV1 => (
            "mcp",
            provenance.shared_runtime_binding().path().to_owned(),
            vec![
                json!({"type":"literal","value":crate::local::canonical(&receipt.root.join("node_modules/@playwright/mcp/cli.js"))?}),
                json!({"type":"literal","value":"--version"}),
            ],
        ),
    };
    let executable = crate::local::canonical(&executable)?;
    let executable_hash = resource_files::fingerprint(&executable)?.sha256;
    let action = json!({"id":"version","label":"读取版本","mode":"task","executable":executable,"workingDirectory":receipt.root,"args":args,"parameters":[],"timeoutSeconds":15,"cancellable":true,"executableSha256":executable_hash});
    serde_json::from_value::<crate::resource_runtime::ActionDefinition>(action.clone())
        .map_err(|_| "固定版本动作无法读取")?;
    let timestamp = now();
    let mut record = ResourceRecord {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.into(),
        kind: kind.into(),
        root_path: display(&receipt.root),
        repository: Some(repository.clone()),
        version: Some(provenance.version.clone()),
        source_binding: None,
        source_history: vec![],
        alias: String::new(),
        notes: String::new(),
        enabled: false,
        ownership: "managedFiles".into(),
        management_scope: "ownedFiles".into(),
        actions: vec![],
        capabilities: vec![],
        update_policy: json!({"mode":"manual","intervalHours":24,"pinnedVersion":null,"skippedVersions":[]}),
        installation: Some(InstallationRecord {
            schema_version: 1,
            installed_at: timestamp.clone(),
            archive_path: String::new(),
            archive_sha256: String::new(),
            source_repository: Some(repository),
            source_version: Some(provenance.version.clone()),
            download_source: None,
            runtime_package: Some(provenance),
            files: receipt.files.clone(),
            system_entries: vec![],
            status: "installing".into(),
            error: None,
            pending_repair: None,
            retained_repair_files: vec![],
            update_state: None,
            removal_state: None,
            resource_manifest: None,
        }),
        revision: 1,
        created_at: timestamp.clone(),
        updated_at: timestamp,
    };
    m.resource_store(StoreRequest::Insert(Box::new(record.clone())))?;
    let metadata = prepare_manifest(&record, &receipt.root, &receipt.files, true)
        .and_then(|prepared| crate::resource_manifest::write_new(&receipt.root, &prepared));
    let (manifest, mut error) = match metadata {
        Ok(value) => (Some(value), None),
        Err(error) => (None, Some(format!("运行包管理记录未完成：{error}"))),
    };
    {
        let installed = record.installation.as_mut().ok_or("安装归属缺失")?;
        installed.resource_manifest = manifest;
        installed.status = if error.is_none() {
            "installed"
        } else {
            "partial"
        }
        .into();
        installed.error = error.clone();
    }
    if error.is_none() {
        if let Err(reason) = crate::resource_update::verify_registered_runtime(&record) {
            error = Some(reason);
            let installed = record.installation.as_mut().ok_or("安装归属缺失")?;
            installed.status = "partial".into();
            installed.error = error.clone();
        }
    }
    record.enabled = error.is_none();
    if error.is_none() {
        record.actions = vec![action];
    }
    record.capabilities = vec![
        json!({"id":"installation","label":"文件准备","status":if error.is_none(){"available"}else{"failed"},"verifiedAt":now()}),
        json!({"id":"cliVersion","label":"版本查询","status":"unverified","reason":"已登记固定入口，尚未实际执行；平台、浏览器和用户会话另行验证"}),
    ];
    record.revision = 2;
    record.updated_at = now();
    match m.resource_store(StoreRequest::Replace {
        record: Box::new(record.clone()),
        expected_revision: 1,
    }) {
        Ok(_) => Ok(
            json!({"resource":public_record(&record),"receipt":receipt,"registered":error.is_none(),"staged":false,"switched":false,"executionVerified":false,"ownershipSaved":true,"complete":error.is_none(),"error":error}),
        ),
        Err(reason) => Ok(
            json!({"receipt":receipt,"registered":false,"staged":false,"switched":false,"executionVerified":false,"ownershipSaved":false,"complete":false,"error":format!("真实运行包保留，登记归属最终保存失败：{reason}")}),
        ),
    }
}

fn apply_install_with_metadata(
    m: &Manager,
    prepared: PreparedInstall,
    write_metadata: impl FnOnce(
        &ResourceRecord,
        &resource_files::InstallReceipt,
    ) -> Result<crate::resource_manifest::ManifestRecord, String>,
) -> Result<Value, String> {
    // Recheck before reserving ownership. The disabled catalog entry survives a
    // later filesystem failure and never presents partial bytes as a runnable tool.
    crate::transaction::verify_root(&prepared.destination)?;
    ensure_independent_destination(m, &prepared.destination)?;
    if prepared.destination.exists()
        || resource_files::fingerprint(&prepared.archive_path)? != prepared.inventory.archive
    {
        return Err("发行包或安装位置已变化，请重新预览".into());
    }
    let required: u64 = prepared
        .inventory
        .files
        .iter()
        .filter(|file| prepared.selected.contains(&file.path) || file.license)
        .map(|file| file.bytes)
        .sum();
    let (_, available) = crate::storage::destination_space(
        prepared.destination.parent().ok_or("安装父目录不可用")?,
    )?;
    if available.is_some_and(|bytes| bytes < required) {
        return Err("安装目录可用空间不足，未登记或写入运行文件".into());
    }
    let mut record = prepared.record;
    let reserved_record = record.clone();
    m.resource_store(StoreRequest::Insert(Box::new(record.clone())))?;
    let mut receipt = match resource_files::install_zip(
        &prepared.archive_path,
        &prepared.inventory,
        &prepared.selected,
        &prepared.destination,
    ) {
        Ok(receipt) => receipt,
        Err(error) => resource_files::InstallReceipt {
            root: prepared.destination,
            files: vec![],
            created_paths: vec![],
            complete: false,
            error: Some(error),
        },
    };
    for file in &mut receipt.files {
        file.role = prepared
            .file_roles
            .get(&file.path)
            .cloned()
            .ok_or("已存安装预览缺少文件归属类型")?;
    }
    let metadata = if record.kind == "skill" {
        json!({"status":"notApplicable","reason":"Skill保持原有精简运行文件格式"})
    } else {
        match write_metadata(&record, &receipt) {
            Ok(manifest) => {
                record
                    .installation
                    .as_mut()
                    .ok_or("安装归属缺失")?
                    .resource_manifest = Some(manifest.clone());
                json!({"status":"created","record":manifest,"targetPath":receipt.root.join(crate::resource_manifest::NAME)})
            }
            Err(error) => {
                receipt.complete = false;
                receipt.error = Some(match receipt.error.take() {
                    Some(original) => format!("{original}；资源侧管理记录未完整保存：{error}"),
                    None => format!("资源侧管理记录未完整保存：{error}"),
                });
                json!({"status":"failed","reason":error,"targetPath":receipt.root.join(crate::resource_manifest::NAME)})
            }
        }
    };
    let installation = record.installation.as_mut().ok_or("安装归属记录缺失")?;
    installation.files = receipt.files.clone();
    installation.status = if receipt.complete {
        "installed"
    } else {
        "partial"
    }
    .into();
    installation.error = receipt.error.clone();
    record.enabled = receipt.complete;
    record.capabilities = vec![
        json!({"id":"installation","label":"文件安装","status":if receipt.complete { "available" } else { "failed" },"verifiedAt":now()}),
        json!({"id":"execution","label":"统一调用","status":"unverified","reason":"文件已登记；调用入口及依赖仍需单独核验"}),
    ];
    record.revision += 1;
    record.updated_at = now();
    match m.resource_store(StoreRequest::Replace {
        record: Box::new(record.clone()),
        expected_revision: 1,
    }) {
        Ok(_) => Ok(
            json!({"resource":record,"receipt":receipt,"metadata":metadata,"complete":receipt.complete,"ownershipSaved":true}),
        ),
        Err(error) => Ok(
            json!({"resource":reserved_record,"receipt":receipt,"metadata":metadata,"complete":false,"ownershipSaved":false,
            "warning":format!("文件已保留，但最终归属记录保存失败；请保留本次回执并核实：{error}")}),
        ),
    }
}

fn apply_remove(m: &Manager, prepared: PreparedRemoval) -> Result<Value, String> {
    apply_remove_with(m, prepared, &system_ownership::NativeSystemAccess)
}

fn apply_remove_with(
    m: &Manager,
    prepared: PreparedRemoval,
    access: &impl SystemAccess,
) -> Result<Value, String> {
    let mut resource = read_resource(m, &prepared.resource_id)?;
    if resource.revision != prepared.record_revision {
        return Err("资源已变化，请重新预览卸载范围".into());
    }
    // TaskSystem holds the catalog write lock across this live-writer read and the
    // file operation. Relation mutations use the same lock, so old impact consent
    // cannot race a newly registered user of these files.
    let (relations_revision, dependents) = removal_relations(m, &resource.id)?;
    if relations_revision != prepared.relations_revision {
        return Err("依赖关系已变化，请重新预览卸载影响".into());
    }
    let changes_system = prepared.system_plan.entries.iter().any(|entry| {
        matches!(
            entry.operation,
            system_ownership::Operation::Remove | system_ownership::Operation::Restore
        )
    });
    if (prepared
        .plan
        .entries
        .iter()
        .chain(
            prepared
                .runtime_plans
                .iter()
                .flat_map(|runtime| runtime.plan.entries.iter()),
        )
        .any(|entry| entry.remove)
        || changes_system
        || prepared.metadata.iter().any(|entry| entry.remove))
        && !dependents.is_empty()
    {
        return Err(
            "此工具仍有已登记或待核实的使用者，本次文件保留；请核实依赖关系后重新预览".into(),
        );
    }
    let shared_scope = removal_shared_scope(m, &resource.id)?;
    if shared_scope != prepared.shared_scope {
        return Err("共享资源或系统项归属已变化，请重新预览".into());
    }
    if (prepared.plan.entries.iter().any(|entry| entry.remove)
        && root_shared(&prepared.plan.root, &shared_scope))
        || prepared.runtime_plans.iter().any(|runtime| {
            runtime.plan.entries.iter().any(|entry| entry.remove)
                && root_shared(&runtime.plan.root, &shared_scope)
        })
        || prepared
            .metadata
            .iter()
            .any(|entry| entry.remove && root_shared(&entry.root, &shared_scope))
    {
        return Err("目录仍与其他资源或管理数据共享，本次文件保留".into());
    }
    verify_runtime(
        &prepared.plan,
        prepared.root_identity.as_deref(),
        prepared.current_missing,
    )?;
    for runtime in &prepared.runtime_plans {
        verify_runtime(
            &runtime.plan,
            runtime.root_identity.as_deref(),
            runtime.root_missing,
        )?;
    }
    for entry in &prepared.metadata {
        verify_metadata(entry)?;
    }
    let system_owned = resource
        .installation
        .as_ref()
        .filter(|record| record.schema_version == 1)
        .map(|record| record.system_entries.clone())
        .unwrap_or_default();
    let shared_system = shared_system_keys(&system_owned, &shared_scope);
    system_ownership::check(&prepared.system_plan, &system_owned, &shared_system, access)?;
    if prepared.plan.extent != RemovalExtent::Disable {
        let runs = m.resource_runtime.snapshot(Some(&resource.id))?;
        if runs["runs"]
            .as_array()
            .is_some_and(|runs| runs.iter().any(|r| r["status"] == "running"))
        {
            return Err("资源仍在运行，请先停止受管进程再重新预览".into());
        }
        for capability in &mut resource.capabilities {
            if let Some(object) = capability.as_object_mut() {
                if object.get("status").and_then(Value::as_str) != Some("unverified") {
                    let mut evidence = object.clone();
                    evidence.remove("historicalEvidence");
                    object.insert("historicalEvidence".into(), Value::Object(evidence));
                }
                object.insert("status".into(), json!("unverified"));
                object.insert("verifiedAt".into(), Value::Null);
                object.insert(
                    "reason".into(),
                    json!("卸载期间停用；所选文件和系统项结果需分别核对"),
                );
            }
        }
    }
    // Disable under the live catalog writer before changing files. Concurrent
    // invocations must also hold the TaskSystem resource-execution lock.
    resource.enabled = false;
    resource.revision = resource
        .revision
        .checked_add(1)
        .ok_or("资源修订号超出范围")?;
    resource.updated_at = now();
    if prepared.plan.extent != RemovalExtent::Disable {
        if let Some(installation) = resource.installation.as_mut() {
            installation.status = "removing".into();
            installation.error = None;
            installation.removal_state = Some(RemovalState {
                plan_id: prepared.plan.id.clone(),
                extent: prepared.plan.extent.clone(),
                status: "processing".into(),
                complete: false,
                started_at: now(),
                updated_at: now(),
                file_entries: prepared
                    .plan
                    .entries
                    .iter()
                    .chain(
                        prepared
                            .runtime_plans
                            .iter()
                            .flat_map(|runtime| runtime.plan.entries.iter()),
                    )
                    .cloned()
                    .collect(),
                system_entry_ids: prepared
                    .system_plan
                    .entries
                    .iter()
                    .filter(|entry| entry.requested)
                    .map(|entry| entry.id.clone())
                    .collect(),
                file_result: json!({"status":"pending","deleted":[],"retained":[],"failures":[]}),
                system_results: vec![],
                runtime_results: vec![],
                metadata_results: vec![],
                error: None,
            });
        }
    }
    m.resource_store(StoreRequest::Replace {
        record: Box::new(resource.clone()),
        expected_revision: prepared.record_revision,
    })?;
    if prepared.plan.extent == RemovalExtent::Disable {
        return Ok(
            json!({"resource":public_record(&resource),"result":{"planId":prepared.plan.id,"deleted":[],"retained":[],"failures":[]},"systemResult":{"entries":[],"complete":true},"complete":true,"fullyRemoved":false}),
        );
    }
    let system_outcome = system_ownership::apply(
        &prepared.system_plan,
        &system_owned,
        &shared_system,
        access,
        |results| {
            let mut next = resource.clone();
            let installation = next.installation.as_mut().ok_or("系统项的安装归属缺失")?;
            installation.system_entries.retain(|entry| {
                !results.iter().any(|result| {
                    result.id == entry.id
                        && ["deleted", "restored", "alreadyAbsent"]
                            .contains(&result.status.as_str())
                })
            });
            let journal = installation
                .removal_state
                .as_mut()
                .ok_or("卸载意图记录缺失")?;
            journal.system_results = results.to_vec();
            journal.updated_at = now();
            next.revision = next.revision.checked_add(1).ok_or("资源修订号超出范围")?;
            next.updated_at = now();
            m.resource_store(StoreRequest::Replace {
                record: Box::new(next.clone()),
                expected_revision: resource.revision,
            })?;
            resource = next;
            Ok(())
        },
    );
    let system_invalid = system_outcome.is_err();
    let system_result = system_outcome.unwrap_or_else(|error| system_ownership::SystemResult {
        plan_id: prepared.system_plan.id.clone(),
        entries: prepared
            .system_plan
            .entries
            .iter()
            .filter(|entry| entry.requested)
            .map(|entry| system_ownership::EntryResult {
                id: entry.id.clone(),
                status: "notAttempted".into(),
                reason: format!("执行准备后系统项变化或无法核对，本次未执行：{error}"),
            })
            .collect(),
        complete: false,
        persistence_error: None,
    });
    let mut result = resource_files::RemovalResult {
        plan_id: prepared.plan.id.clone(),
        deleted: vec![],
        retained: vec![],
        failures: vec![],
    };
    let mut runtime_results = vec![];
    let mut persistence_error = None;
    let mut blocked = system_invalid || system_result.persistence_error.is_some();
    let current = (
        &prepared.plan,
        prepared.root_identity.as_deref(),
        prepared.current_missing,
        None,
        prepared.custom_files.as_slice(),
    );
    let roots = std::iter::once(current).chain(prepared.runtime_plans.iter().map(|runtime| {
        (
            &runtime.plan,
            runtime.root_identity.as_deref(),
            runtime.root_missing,
            Some(runtime),
            runtime.custom_files.as_slice(),
        )
    }));
    for (plan, identity, missing, historical, custom) in
        roots.filter(|(plan, _, _, _, _)| !plan.entries.is_empty())
    {
        let outcome = if blocked {
            resource_files::RemovalResult {
                plan_id: plan.id.clone(),
                deleted: vec![],
                retained: plan
                    .entries
                    .iter()
                    .map(|entry| entry.path.clone())
                    .collect(),
                failures: vec![(
                    plan.root.clone(),
                    "前序核对或结果保存失败，本版本未执行；须重新预览并确认".into(),
                )],
            }
        } else {
            apply_runtime_files(plan, identity, missing)
        };
        result.deleted.extend(outcome.deleted.iter().cloned());
        result.retained.extend(outcome.retained.iter().cloned());
        result.failures.extend(outcome.failures.iter().cloned());
        let id = historical
            .map(|runtime| runtime.id.as_str())
            .unwrap_or("current");
        let complete = outcome.failures.is_empty()
            && !plan.entries.iter().any(|entry| {
                file_requested(entry, &plan.extent, custom)
                    && !entry.remove
                    && entry.expected.is_some()
            });
        runtime_results
            .push(json!({"id":id,"root":plan.root,"complete":complete,"result":outcome}));
        if blocked {
            continue;
        }
        let mut next = resource.clone();
        if let Some(runtime) = historical {
            prune_historical(&mut next, runtime, &outcome)?;
        } else {
            prune_files(
                &mut next.installation.as_mut().ok_or("文件安装归属缺失")?.files,
                plan,
                custom,
                &outcome,
            );
        }
        let journal = next
            .installation
            .as_mut()
            .and_then(|installation| installation.removal_state.as_mut())
            .ok_or("卸载意图记录缺失")?;
        journal.runtime_results = runtime_results.clone();
        journal.file_result = json!(result);
        journal.updated_at = now();
        next.revision = next.revision.checked_add(1).ok_or("资源修订号超出范围")?;
        next.updated_at = now();
        match m.resource_store(StoreRequest::Replace {
            record: Box::new(next.clone()),
            expected_revision: resource.revision,
        }) {
            Ok(_) => resource = next,
            Err(error) => {
                persistence_error = Some(error);
                blocked = true;
            }
        }
    }
    if prepared.plan.entries.is_empty() && prepared.runtime_plans.is_empty() && blocked {
        result.failures.push((
            prepared.plan.root.clone(),
            "系统项核对或结果保存未完成".into(),
        ));
    }
    let mut metadata_results = vec![];
    for entry in &prepared.metadata {
        let root_complete = runtime_results
            .iter()
            .find(|result| result["id"] == entry.runtime_id)
            .is_none_or(|result| result["complete"] == true);
        let (status, reason) = if !entry.requested {
            ("retained", entry.reason.clone())
        } else if blocked {
            (
                "notAttempted",
                "前序核对或保存失败，管理记录保持原样；须重新确认".into(),
            )
        } else if !root_complete {
            (
                "retained",
                "此版本仍有未完成文件，保留管理记录以便核对和恢复".into(),
            )
        } else if entry.status == "absent" {
            ("alreadyAbsent", "管理记录已不存在，不重复删除".into())
        } else if !entry.remove {
            ("retained", entry.reason.clone())
        } else {
            match delete_metadata(entry) {
                Ok(()) => (
                    "deleted",
                    "已删除并核对该资源侧管理记录；不代表删除其他个人文件".into(),
                ),
                Err(error) => ("failed", error),
            }
        };
        metadata_results.push(json!({"id":entry.id,"runtimeId":entry.runtime_id,"path":entry.root.join(crate::resource_manifest::NAME),"status":status,"reason":reason}));
        if entry.requested && !["deleted", "alreadyAbsent"].contains(&status) {
            result.failures.push((
                entry.root.join(crate::resource_manifest::NAME),
                reason.clone(),
            ));
        }
        if !entry.requested || blocked {
            continue;
        }
        let mut next = resource.clone();
        if ["deleted", "alreadyAbsent"].contains(&status) {
            clear_metadata(&mut next, entry)?;
        }
        let journal = next
            .installation
            .as_mut()
            .and_then(|installation| installation.removal_state.as_mut())
            .ok_or("管理记录处理意图缺失")?;
        journal.metadata_results = metadata_results.clone();
        journal.file_result = json!(result);
        journal.updated_at = now();
        next.revision = next.revision.checked_add(1).ok_or("资源修订号超出范围")?;
        next.updated_at = now();
        match m.resource_store(StoreRequest::Replace {
            record: Box::new(next.clone()),
            expected_revision: resource.revision,
        }) {
            Ok(_) => resource = next,
            Err(error) => {
                persistence_error = Some(error);
                blocked = true;
            }
        }
    }
    let metadata_complete =
        prepared
            .metadata
            .iter()
            .zip(&metadata_results)
            .all(|(entry, result)| {
                !entry.requested
                    || matches!(result["status"].as_str(), Some("deleted" | "alreadyAbsent"))
            });
    let metadata_result = json!({"entries":metadata_results,"complete":metadata_complete});
    let preserved_edits = prepared.plan.entries.iter().any(|entry| {
        file_requested(entry, &prepared.plan.extent, &prepared.custom_files)
            && !entry.remove
            && entry.expected.is_some()
    }) || prepared.runtime_plans.iter().any(|runtime| {
        runtime.plan.entries.iter().any(|entry| {
            file_requested(entry, &runtime.plan.extent, &runtime.custom_files)
                && !entry.remove
                && entry.expected.is_some()
        })
    });
    let complete = result.failures.is_empty()
        && !preserved_edits
        && system_result.complete
        && persistence_error.is_none()
        && metadata_complete;
    if let Some(installation) = resource.installation.as_mut() {
        installation.status = if complete {
            "filesRemoved"
        } else {
            "partiallyRemoved"
        }
        .into();
        installation.error = (!complete)
            .then(|| "部分文件或系统项保留、失败或结果未完整保存，请重新核对剩余归属".into());
        if let Some(journal) = installation.removal_state.as_mut() {
            journal.status = if complete { "complete" } else { "partial" }.into();
            journal.complete = complete;
            journal.updated_at = now();
            journal.file_result = json!(result);
            journal.system_results = system_result.entries.clone();
            journal.runtime_results = runtime_results.clone();
            journal.metadata_results = metadata_results.clone();
            journal.error = installation
                .error
                .clone()
                .or_else(|| system_result.persistence_error.clone())
                .or_else(|| persistence_error.clone());
        }
    }
    resource.capabilities.retain(|c| c["id"] != "installation");
    resource.capabilities.push(json!({"id":"installation","label":"文件安装","status":"unverified","reason":"已执行所选范围移除；资源停用，剩余文件与来源记录保留"}));
    let expected = resource.revision;
    resource.revision = expected.checked_add(1).ok_or("资源修订号超出范围")?;
    resource.updated_at = now();
    match m.resource_store(StoreRequest::Replace {
        record: Box::new(resource.clone()),
        expected_revision: expected,
    }) {
        Ok(_) => Ok(
            json!({"resource":public_record(&resource),"result":result,"runtimeResults":runtime_results,"metadataResult":metadata_result,"systemResult":system_result,"complete":complete,"fullyRemoved":false,"persistenceError":persistence_error}),
        ),
        Err(error) => Ok(
            json!({"resource":public_record(&resource),"result":result,"runtimeResults":runtime_results,"metadataResult":metadata_result,"systemResult":system_result,"complete":false,"fullyRemoved":false,"persistenceError":persistence_error,
            "warning":format!("文件操作回执已保留，但最新归属记录保存失败：{error}")}),
        ),
    }
}

pub(crate) fn apply_local(m: &mut Manager, request: &Value) -> Result<Option<Value>, String> {
    let kind = match request["action"].as_str().unwrap_or_default() {
        "apply_resource_install" => "resourceInstall",
        "apply_resource_remove" => "resourceRemove",
        "apply_resource_repair" => "resourceRepair",
        _ => return Ok(None),
    };
    if request.as_object().is_none_or(|object| {
        object
            .keys()
            .any(|key| !["action", "previewId"].contains(&key.as_str()))
    }) {
        return Err("执行仅接受已存预览标识，不能用确认布尔值或请求文件清单代替界面确认".into());
    }
    let id = text(request, "previewId", 64)?;
    let saved = m.previews.get(&id).ok_or("预览已消费或过期，请重新预览")?;
    if saved["kind"] != kind || saved["public"]["canApply"] != true {
        return Err("预览类型不匹配或没有可执行的可信范围".into());
    }
    let saved = m.previews.remove(&id).ok_or("预览已过期")?;
    if kind == "resourceRemove" {
        let current = chrono::Utc::now().timestamp_millis();
        if saved["createdAt"].as_i64().is_none_or(|created| {
            current.saturating_sub(created) > 10 * 60 * 1000 || created > current + 5_000
        }) {
            return Err("卸载预览已超过10分钟或时间无效，请重新选择程度并确认".into());
        }
    }
    Ok(Some(if kind == "resourceInstall" {
        apply_install(
            m,
            serde_json::from_value(saved["prepared"].clone()).map_err(|e| e.to_string())?,
        )?
    } else if kind == "resourceRepair" {
        apply_repair(
            m,
            serde_json::from_value(saved["prepared"].clone()).map_err(|e| e.to_string())?,
        )?
    } else {
        apply_remove(
            m,
            serde_json::from_value(saved["prepared"].clone()).map_err(|e| e.to_string())?,
        )?
    }))
}

#[cfg(test)]
#[path = "resource_lifecycle/removal_system_tests.rs"]
mod removal_system_tests;

#[cfg(test)]
#[path = "resource_lifecycle/installation_location_tests.rs"]
mod installation_location_tests;

#[cfg(test)]
#[path = "resource_lifecycle/runtime_removal_tests.rs"]
mod runtime_removal_tests;

#[cfg(test)]
#[path = "resource_lifecycle/manifest_hooks_tests.rs"]
mod manifest_hooks_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn abandoned_mixed_previews_share_the_existing_bound_and_preserve_other_kinds() {
        let kinds = [
            "resourceInstall",
            "resourceRemove",
            "resourceDownload",
            "resourceDownloadReceipt",
            "resourceRepair",
            "skillRemove",
            "resourceSource",
        ];
        let mut previews = HashMap::new();
        for kind in ["configurationImport", "resourceAutomation", "unrelated"] {
            previews.insert(kind.into(), json!({"kind":kind,"createdAt":-1,"keep":true}));
        }
        let protected = previews.clone();
        for index in 0..70 {
            let kind = kinds[index % kinds.len()];
            previews.insert(
                format!("preview-{index:03}"),
                json!({"kind":kind,"createdAt":index}),
            );
            trim_previews(&mut previews);
            assert_eq!(previews.len(), (index + 1).min(32) + protected.len());
        }
        for (id, value) in protected {
            assert_eq!(previews[&id], value);
        }
        for index in 0..70 {
            assert_eq!(
                previews.contains_key(&format!("preview-{index:03}")),
                index >= 38
            );
        }
    }

    fn fixture() -> tempfile::TempDir {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("work/resource-lifecycle-tests");
        fs::create_dir_all(&root).unwrap();
        tempfile::tempdir_in(root).unwrap()
    }

    fn package(root: &Path) -> PathBuf {
        let path = root.join("release.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        for (name, data) in [
            ("bin/tool.exe", "synthetic runtime"),
            ("LICENSE", "license terms"),
            ("tests/dev.txt", "development"),
        ] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(data.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        path
    }

    fn request(archive: &Path, destination: &Path) -> Value {
        json!({"action":"preview_resource_install","archivePath":archive,"destinationPath":destination,
            "name":"Synthetic tool","kind":"cli","repository":"https://github.com/example/tool","version":"v1",
            "selectedFiles":["bin/tool.exe"]})
    }

    fn install(m: &mut Manager, root: &Path) -> Value {
        let plan = handle(m, &request(&package(root), &root.join("v1")))
            .unwrap()
            .unwrap();
        apply_local(
            m,
            &json!({"action":"apply_resource_install","previewId":plan["id"]}),
        )
        .unwrap()
        .unwrap()
    }

    fn tool_relations(m: &Manager, id: &str) -> Value {
        m.relation_store(crate::resource_relations::StoreRequest::List {
            endpoint: crate::resource_relations::Endpoint {
                kind: "tool".into(),
                id: id.to_owned(),
            },
        })
        .unwrap()
    }

    fn add_consumer(m: &mut Manager, root: &Path, tool_id: &str) -> Value {
        let path = root.join("consumer");
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("SKILL.md"), b"synthetic consumer source").unwrap();
        m.state
            .skills
            .push(json!({"id":"consumer","name":"Synthetic Consumer","localPath":path}));
        m.save().unwrap();
        let revision = tool_relations(m, tool_id)["revision"].as_u64().unwrap();
        m.relation_store(crate::resource_relations::StoreRequest::Add {
            dependent: crate::resource_relations::Endpoint {
                kind: "skill".into(),
                id: "consumer".into(),
            },
            dependency: crate::resource_relations::Endpoint {
                kind: "tool".into(),
                id: tool_id.to_owned(),
            },
            expected_revision: revision,
        })
        .unwrap();
        tool_relations(m, tool_id)
    }

    fn removal_preview(m: &mut Manager, id: &str, extent: &str) -> Value {
        let revision = read_resource(m, id).unwrap().revision;
        let mut request = json!({"action":"preview_resource_remove","id":id,"expectedRevision":revision,"extent":extent});
        if extent == "custom" {
            request["customFiles"] = json!(["bin/tool.exe"]);
        }
        handle(m, &request).unwrap().unwrap()
    }

    fn assert_runtime_retained(root: &Path) {
        assert_eq!(
            fs::read(root.join("v1/bin/tool.exe")).unwrap(),
            b"synthetic runtime"
        );
        assert_eq!(fs::read(root.join("v1/LICENSE")).unwrap(), b"license terms");
    }

    #[test]
    fn removal_dependencies_block_runtime_complete_and_custom_files_and_expose_real_users() {
        let dir = fixture();
        let mut manager = Manager::new(dir.path().join("state")).unwrap();
        let installed = install(&mut manager, dir.path());
        let id = installed["resource"]["id"].as_str().unwrap();
        let relations = add_consumer(&mut manager, dir.path(), id);
        for extent in ["runtime", "complete", "custom"] {
            let plan = removal_preview(&mut manager, id, extent);
            assert_eq!(plan["canApply"], false);
            assert_eq!(plan["relationsRevision"], relations["revision"]);
            assert_eq!(plan["dependents"], relations["dependents"]);
            assert_eq!(
                plan["dependents"][0]["dependent"]["name"],
                "Synthetic Consumer"
            );
            assert!(plan["warnings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value.as_str().unwrap().contains("Synthetic Consumer")));
            assert!(apply_local(
                &mut manager,
                &json!({"action":"apply_resource_remove","previewId":plan["id"]})
            )
            .is_err());
            assert_runtime_retained(dir.path());
            assert_eq!(
                json!(read_resource(&manager, id).unwrap()),
                installed["resource"]
            );
        }
        assert_eq!(
            fs::read(dir.path().join("consumer/SKILL.md")).unwrap(),
            b"synthetic consumer source"
        );
    }

    #[test]
    fn removal_dependencies_keep_protecting_files_after_a_consumer_record_disappears() {
        let dir = fixture();
        let mut manager = Manager::new(dir.path().join("state")).unwrap();
        let installed = install(&mut manager, dir.path());
        let id = installed["resource"]["id"].as_str().unwrap();
        let relations = add_consumer(&mut manager, dir.path(), id);
        manager.state.skills.clear();
        manager.save().unwrap();
        let plan = removal_preview(&mut manager, id, "complete");
        assert_eq!(plan["dependents"][0]["dependent"]["exists"], false);
        assert_eq!(plan["dependents"][0]["dependent"]["ownership"], "unknown");
        assert_eq!(
            plan["relationsRevision"], relations["revision"],
            "losing a directory record never removes the dependency edge"
        );
        assert_eq!(plan["canApply"], false);
        assert!(plan["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value.as_str().unwrap().contains("不能据此认定文件可删除")));
        assert!(apply_local(
            &mut manager,
            &json!({"action":"apply_resource_remove","previewId":plan["id"]})
        )
        .is_err());
        assert_runtime_retained(dir.path());
        assert_eq!(
            fs::read(dir.path().join("consumer/SKILL.md")).unwrap(),
            b"synthetic consumer source"
        );
    }

    #[test]
    fn removal_dependencies_invalidate_old_previews_after_both_add_and_remove_then_require_new_preview(
    ) {
        let dir = fixture();
        let mut manager = Manager::new(dir.path().join("state")).unwrap();
        let installed = install(&mut manager, dir.path());
        let id = installed["resource"]["id"].as_str().unwrap();
        let before_add = removal_preview(&mut manager, id, "runtime");
        assert_eq!(before_add["canApply"], true);
        let relations = add_consumer(&mut manager, dir.path(), id);
        let error = apply_local(
            &mut manager,
            &json!({"action":"apply_resource_remove","previewId":before_add["id"]}),
        )
        .unwrap_err();
        assert!(error.contains("依赖关系已变化"));
        assert!(!manager
            .previews
            .contains_key(before_add["id"].as_str().unwrap()));
        assert_runtime_retained(dir.path());
        assert_eq!(
            json!(read_resource(&manager, id).unwrap()),
            installed["resource"]
        );

        let before_remove = removal_preview(&mut manager, id, "disable");
        assert_eq!(before_remove["canApply"], true);
        manager
            .relation_store(crate::resource_relations::StoreRequest::Remove {
                id: relations["dependents"][0]["id"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
                expected_revision: relations["revision"].as_u64().unwrap(),
            })
            .unwrap();
        let error = apply_local(
            &mut manager,
            &json!({"action":"apply_resource_remove","previewId":before_remove["id"]}),
        )
        .unwrap_err();
        assert!(
            error.contains("依赖关系已变化"),
            "even a safer graph cannot reuse the prior impact confirmation"
        );
        assert_runtime_retained(dir.path());
        assert_eq!(
            json!(read_resource(&manager, id).unwrap()),
            installed["resource"]
        );

        let fresh = removal_preview(&mut manager, id, "runtime");
        assert_eq!(fresh["canApply"], true);
        let result = apply_local(
            &mut manager,
            &json!({"action":"apply_resource_remove","previewId":fresh["id"]}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(result["complete"], true);
        assert!(!dir.path().join("v1/bin/tool.exe").exists());
        assert_eq!(
            fs::read(dir.path().join("consumer/SKILL.md")).unwrap(),
            b"synthetic consumer source"
        );
        assert_eq!(manager.state.skills.len(), 1);
    }

    #[test]
    fn removal_dependencies_allow_disable_with_impact_warning_but_keep_files_and_relations() {
        let dir = fixture();
        let mut manager = Manager::new(dir.path().join("state")).unwrap();
        let installed = install(&mut manager, dir.path());
        let id = installed["resource"]["id"].as_str().unwrap();
        let relations = add_consumer(&mut manager, dir.path(), id);
        let plan = removal_preview(&mut manager, id, "disable");
        assert_eq!(plan["canApply"], true);
        assert!(plan["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value.as_str().unwrap().contains("可能影响其后续调用")));
        let result = apply_local(
            &mut manager,
            &json!({"action":"apply_resource_remove","previewId":plan["id"]}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(result["resource"]["enabled"], false);
        assert_eq!(result["result"]["deleted"], json!([]));
        assert_eq!(result["fullyRemoved"], false);
        assert_runtime_retained(dir.path());
        assert_eq!(
            tool_relations(&manager, id)["dependents"],
            relations["dependents"]
        );
        assert_eq!(
            tool_relations(&manager, id)["revision"],
            relations["revision"]
        );
    }

    #[test]
    fn removal_dependencies_unlink_only_changes_management_records_and_not_runtime_or_consumer_files(
    ) {
        let dir = fixture();
        let mut manager = Manager::new(dir.path().join("state")).unwrap();
        let installed = install(&mut manager, dir.path());
        let id = installed["resource"]["id"].as_str().unwrap();
        let relations = add_consumer(&mut manager, dir.path(), id);
        crate::resource_relations::apply_local(
            &manager,
            &json!({
                "action":"resource_relation_remove", "id":relations["dependents"][0]["id"],
                "expectedRevision":relations["revision"]
            }),
        )
        .unwrap()
        .unwrap();
        assert_eq!(tool_relations(&manager, id)["dependents"], json!([]));
        assert_runtime_retained(dir.path());
        assert_eq!(
            fs::read(dir.path().join("consumer/SKILL.md")).unwrap(),
            b"synthetic consumer source"
        );
        assert_eq!(
            json!(read_resource(&manager, id).unwrap()),
            installed["resource"]
        );
        assert_eq!(manager.state.skills.len(), 1);
    }

    #[test]
    fn removal_dependencies_never_cascade_into_a_removed_tools_own_dependencies() {
        let dir = fixture();
        let mut manager = Manager::new(dir.path().join("state")).unwrap();
        let installed = install(&mut manager, dir.path());
        let id = installed["resource"]["id"].as_str().unwrap();
        let target = dir.path().join("external-runtime");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("shared.exe"), b"external dependency bytes").unwrap();
        let dependency = crate::resources::handle(&manager, &json!({"action":"resource_register","name":"External dependency","kind":"portable","rootPath":target})).unwrap().unwrap()["resource"].clone();
        let current = tool_relations(&manager, id);
        let relations = manager
            .relation_store(crate::resource_relations::StoreRequest::Add {
                dependent: crate::resource_relations::Endpoint {
                    kind: "tool".into(),
                    id: id.to_owned(),
                },
                dependency: crate::resource_relations::Endpoint {
                    kind: "tool".into(),
                    id: dependency["id"].as_str().unwrap().to_owned(),
                },
                expected_revision: current["revision"].as_u64().unwrap(),
            })
            .unwrap();
        let plan = removal_preview(&mut manager, id, "complete");
        assert_eq!(plan["canApply"], true);
        apply_local(
            &mut manager,
            &json!({"action":"apply_resource_remove","previewId":plan["id"]}),
        )
        .unwrap()
        .unwrap();
        assert!(!dir.path().join("v1/bin/tool.exe").exists());
        assert_eq!(
            fs::read(target.join("shared.exe")).unwrap(),
            b"external dependency bytes"
        );
        assert_eq!(
            json!(read_resource(&manager, dependency["id"].as_str().unwrap()).unwrap()),
            dependency
        );
        let retained = tool_relations(&manager, id);
        assert_eq!(retained["dependencies"].as_array().unwrap().len(), 1);
        assert_eq!(
            retained["dependencies"][0]["id"],
            relations["dependencies"][0]["id"]
        );
        assert_eq!(
            retained["dependencies"][0]["dependency"],
            relations["dependencies"][0]["dependency"]
        );
    }

    fn repair_request(resource: &Value) -> Value {
        json!({"action":"preview_resource_repair","id":resource["id"],"expectedRevision":resource["revision"]})
    }
    fn repair_apply(plan: &Value) -> Value {
        json!({"action":"apply_resource_repair","previewId":plan["id"]})
    }
    #[test]
    fn repair_uses_original_provenance_keeps_local_edits_and_disabled_policy() {
        let dir = fixture();
        let mut manager = Manager::new(dir.path().join("state")).unwrap();
        let installed = install(&mut manager, dir.path());
        let mut record =
            read_resource(&manager, installed["resource"]["id"].as_str().unwrap()).unwrap();
        record.repository = Some("https://github.com/other/source".into());
        record.version = Some("personal-label".into());
        record.alias = "keep alias".into();
        record.notes = "personal note".into();
        record.enabled = false;
        record.update_policy = json!({"mode":"manual","pinnedVersion":"personal-lock"});
        record.revision += 1;
        manager
            .resource_store(StoreRequest::Replace {
                record: Box::new(record.clone()),
                expected_revision: 2,
            })
            .unwrap();
        let root = dir.path().join("v1");
        fs::write(root.join("bin/tool.exe"), b"local patch").unwrap();
        fs::write(root.join("config.json"), b"private data").unwrap();
        fs::remove_file(root.join("LICENSE")).unwrap();
        let before = serde_json::to_value(&record).unwrap();
        let plan = handle(&mut manager, &repair_request(&before))
            .unwrap()
            .unwrap();
        assert_eq!(
            plan["source"]["repository"],
            "https://github.com/example/tool"
        );
        assert_eq!(plan["source"]["version"], "v1");
        assert_eq!(
            plan["files"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|f| f["decision"] == "restore")
                .count(),
            1
        );
        assert!(plan["temporaryPaths"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| !Path::new(p.as_str().unwrap()).exists()));
        assert!(crate::dispatch(&mut manager, &repair_apply(&plan)).is_err());
        let result = crate::dispatch_local(&mut manager, &repair_apply(&plan)).unwrap();
        assert_eq!(result["complete"], true);
        assert_eq!(result["ownershipSaved"], true);
        for field in [
            "id",
            "rootPath",
            "name",
            "repository",
            "version",
            "alias",
            "notes",
            "actions",
            "updatePolicy",
            "enabled",
        ] {
            assert_eq!(
                result["resource"][field], before[field],
                "{field} must be preserved"
            );
        }
        assert_eq!(
            result["resource"]["installation"]["files"],
            before["installation"]["files"]
        );
        assert!(result["resource"]["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c["status"] == "unverified"));
        assert_eq!(fs::read(root.join("bin/tool.exe")).unwrap(), b"local patch");
        assert_eq!(fs::read(root.join("config.json")).unwrap(), b"private data");
        assert!(root.join("LICENSE").is_file());
        assert!(crate::dispatch_local(&mut manager, &repair_apply(&plan)).is_err());
        let no_work = handle(&mut manager, &repair_request(&result["resource"]))
            .unwrap()
            .unwrap();
        assert_eq!(no_work["canApply"], false);
    }
    #[test]
    fn repair_rejects_wrong_package_forged_source_and_preview_drift_before_catalog_changes() {
        let dir = fixture();
        let mut manager = Manager::new(dir.path().join("state")).unwrap();
        let installed = install(&mut manager, dir.path());
        let root = dir.path().join("v1");
        fs::remove_file(root.join("LICENSE")).unwrap();
        let mut forged = repair_request(&installed["resource"]);
        forged["repository"] = json!("https://github.com/other/repo");
        assert!(handle(&mut manager, &forged).is_err());
        let archive = archive_path(&json!({"archivePath":dir.path().join("release.zip")})).unwrap();
        let fingerprint = resource_files::fingerprint(&archive).unwrap();
        let receipt_id = uuid::Uuid::new_v4().to_string();
        manager.previews.insert(receipt_id.clone(),json!({"kind":"resourceDownloadReceipt","archivePath":archive,"fingerprint":fingerprint,
            "source":{"repository":"https://github.com/other/repo","version":"v1","verification":"githubDigest","author":"other","releaseId":11,"assetId":22,"assetName":"release.zip","downloadUrl":"https://github.com/other/repo/releases/download/v1/release.zip","sha256":fingerprint.sha256,"expectedSha256":fingerprint.sha256}}));
        let mut wrong_source = repair_request(&installed["resource"]);
        wrong_source["downloadId"] = json!(receipt_id);
        assert!(handle(&mut manager, &wrong_source)
            .unwrap_err()
            .contains("原安装来源不一致"));
        let plan = handle(&mut manager, &repair_request(&installed["resource"]))
            .unwrap()
            .unwrap();
        fs::write(root.join("LICENSE"), b"user replacement").unwrap();
        assert!(crate::dispatch_local(&mut manager, &repair_apply(&plan)).is_err());
        let current =
            read_resource(&manager, installed["resource"]["id"].as_str().unwrap()).unwrap();
        assert_eq!(current.revision, 2);
        assert!(current.enabled);
        assert!(plan["temporaryPaths"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| !Path::new(p.as_str().unwrap()).exists()));
        assert_eq!(fs::read(root.join("LICENSE")).unwrap(), b"user replacement");
        let other = dir.path().join("different.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&other).unwrap());
        zip.start_file("LICENSE", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"different").unwrap();
        zip.finish().unwrap();
        let mut wrong = repair_request(&installed["resource"]);
        wrong["archivePath"] = json!(other);
        assert!(handle(&mut manager, &wrong)
            .unwrap_err()
            .contains("摘要不一致"));
    }
    #[test]
    fn repair_failure_stays_disabled_and_does_not_resurrect_removed_ownership() {
        let dir = fixture();
        let mut manager = Manager::new(dir.path().join("state")).unwrap();
        let installed = install(&mut manager, dir.path());
        let id = installed["resource"]["id"].as_str().unwrap();
        let mut record = read_resource(&manager, id).unwrap();
        record
            .installation
            .as_mut()
            .unwrap()
            .files
            .iter_mut()
            .find(|f| f.path == "LICENSE")
            .unwrap()
            .installed_sha256 = "0".repeat(64);
        record.revision += 1;
        manager
            .resource_store(StoreRequest::Replace {
                record: Box::new(record.clone()),
                expected_revision: 2,
            })
            .unwrap();
        fs::remove_file(dir.path().join("v1/LICENSE")).unwrap();
        let plan = handle(
            &mut manager,
            &repair_request(&serde_json::to_value(record).unwrap()),
        )
        .unwrap()
        .unwrap();
        let result = crate::dispatch_local(&mut manager, &repair_apply(&plan)).unwrap();
        assert_eq!(result["complete"], false);
        assert_eq!(result["resource"]["enabled"], false);
        assert_eq!(result["resource"]["installation"]["status"], "partial");
        assert_eq!(result["receipt"]["failures"].as_array().unwrap().len(), 1);
        assert!(!dir.path().join("v1/LICENSE").exists());
        let temporary = result["receipt"]["temporaryPaths"][0].as_str().unwrap();
        assert_eq!(fs::read(temporary).unwrap(), b"license terms");
        let mut record = read_resource(&manager, id).unwrap();
        let revision = record.revision;
        record
            .installation
            .as_mut()
            .unwrap()
            .files
            .retain(|f| f.path != "LICENSE");
        record.revision += 1;
        manager
            .resource_store(StoreRequest::Replace {
                record: Box::new(record.clone()),
                expected_revision: revision,
            })
            .unwrap();
        assert!(
            handle(
                &mut manager,
                &repair_request(&serde_json::to_value(record).unwrap())
            )
            .is_err(),
            "changed ownership must not inherit an old repair intent"
        );
        assert!(!dir.path().join("v1/LICENSE").exists());
    }
    #[test]
    fn repair_final_record_failure_can_be_verified_and_finished_explicitly_after_restart() {
        let dir = fixture();
        let state = dir.path().join("state");
        let mut manager = Manager::new(state.clone()).unwrap();
        let installed = install(&mut manager, dir.path());
        let id = installed["resource"]["id"].as_str().unwrap();
        fs::remove_file(dir.path().join("v1/LICENSE")).unwrap();
        let plan = handle(&mut manager, &repair_request(&installed["resource"]))
            .unwrap()
            .unwrap();
        let db = rusqlite::Connection::open(state.join("manager.sqlite3")).unwrap();
        db.execute_batch("CREATE TRIGGER fail_repair_final BEFORE UPDATE ON resource_catalog WHEN NEW.revision=4 BEGIN SELECT RAISE(ABORT,'synthetic final save denied'); END;").unwrap();
        let result = crate::dispatch_local(&mut manager, &repair_apply(&plan)).unwrap();
        assert_eq!(result["ownershipSaved"], false);
        assert_eq!(result["complete"], false);
        assert!(dir.path().join("v1/LICENSE").exists());
        let pending = read_resource(&manager, id).unwrap();
        assert!(!pending.enabled);
        assert_eq!(pending.installation.as_ref().unwrap().status, "repairing");
        assert!(pending
            .installation
            .as_ref()
            .unwrap()
            .pending_repair
            .is_some());
        db.execute_batch("DROP TRIGGER fail_repair_final;").unwrap();
        drop(db);
        drop(manager);
        let mut manager = Manager::new(state).unwrap();
        let record = read_resource(&manager, id).unwrap();
        assert_eq!(record.revision, 3);
        let proof = resource_files::fingerprint(&dir.path().join("v1/LICENSE")).unwrap();
        let ready = handle(
            &mut manager,
            &repair_request(&serde_json::to_value(&record).unwrap()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(ready["completionOnly"], true);
        assert_eq!(ready["canApply"], true);
        assert_eq!(
            read_resource(&manager, id).unwrap().revision,
            3,
            "preview never finishes a pending operation"
        );
        let done = crate::dispatch_local(&mut manager, &repair_apply(&ready)).unwrap();
        assert_eq!(done["complete"], true);
        assert_eq!(done["resource"]["enabled"], true);
        assert_eq!(done["resource"]["installation"]["status"], "installed");
        assert!(done["resource"]["installation"]["pendingRepair"].is_null());
        assert!(done["receipt"]["restored"].as_array().unwrap().is_empty());
        assert_eq!(
            resource_files::fingerprint(&dir.path().join("v1/LICENSE")).unwrap(),
            proof
        );
    }
    #[test]
    fn interrupted_partial_candidate_is_retained_and_fresh_repair_respects_later_user_edits() {
        let dir = fixture();
        let state = dir.path().join("state");
        let mut manager = Manager::new(state.clone()).unwrap();
        let installed = install(&mut manager, dir.path());
        let id = installed["resource"]["id"].as_str().unwrap();
        fs::remove_file(dir.path().join("v1/LICENSE")).unwrap();
        let plan = handle(&mut manager, &repair_request(&installed["resource"]))
            .unwrap()
            .unwrap();
        let prepared: PreparedRepair = serde_json::from_value(
            manager.previews[plan["id"].as_str().unwrap()]["prepared"].clone(),
        )
        .unwrap();
        let mut resource = read_resource(&manager, id).unwrap();
        let original_root = crate::local::canonical(Path::new(&resource.root_path)).unwrap();
        let installation = resource.installation.as_mut().unwrap();
        let original_source = repair_source_identity(installation);
        let old_temporary = prepared
            .plan
            .entries
            .iter()
            .find_map(|entry| entry.temporary_path.clone())
            .unwrap();
        fs::write(&old_temporary, b"lic").unwrap();
        installation.pending_repair = Some(RepairIntent {
            previous_enabled: true,
            previous_status: installation.status.clone(),
            previous_error: installation.error.clone(),
            known_revision: 3,
            original_root,
            original_source,
            owned_files: installation.files.clone(),
            entries: prepared
                .plan
                .entries
                .into_iter()
                .filter(|e| e.decision == "restore")
                .collect(),
        });
        installation.status = "repairing".into();
        resource.enabled = false;
        resource.revision = 3;
        manager
            .resource_store(StoreRequest::Replace {
                record: Box::new(resource.clone()),
                expected_revision: 2,
            })
            .unwrap();
        drop(manager);
        let mut manager = Manager::new(state.clone()).unwrap();
        assert!(!dir.path().join("v1/LICENSE").exists());
        let ready = handle(
            &mut manager,
            &repair_request(&serde_json::to_value(&resource).unwrap()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(ready["completionOnly"], false);
        assert_eq!(ready["retainedTemporaryPaths"], json!([old_temporary]));
        assert!(!dir.path().join("v1/LICENSE").exists());
        // Explicit newer user policy must not be overwritten by prior intent.
        resource.revision = 4;
        resource.notes = "user changed the disabled resource".into();
        manager
            .resource_store(StoreRequest::Replace {
                record: Box::new(resource.clone()),
                expected_revision: 3,
            })
            .unwrap();
        assert!(crate::dispatch_local(&mut manager, &repair_apply(&ready)).is_err());
        assert!(!read_resource(&manager, id).unwrap().enabled);
        assert!(!dir.path().join("v1/LICENSE").exists());
        fs::write(dir.path().join("v1/LICENSE"), b"later user file").unwrap();
        assert!(handle(
            &mut manager,
            &repair_request(&serde_json::to_value(&resource).unwrap())
        )
        .is_err());
        assert_eq!(
            fs::read(dir.path().join("v1/LICENSE")).unwrap(),
            b"later user file"
        );
        fs::remove_file(dir.path().join("v1/LICENSE")).unwrap();
        let fresh = handle(
            &mut manager,
            &repair_request(&serde_json::to_value(&resource).unwrap()),
        )
        .unwrap()
        .unwrap();
        assert_ne!(fresh["temporaryPaths"], ready["temporaryPaths"]);
        let done = crate::dispatch_local(&mut manager, &repair_apply(&fresh)).unwrap();
        assert_eq!(done["complete"], true);
        assert_eq!(done["resource"]["enabled"], false);
        assert_eq!(
            done["resource"]["notes"],
            "user changed the disabled resource"
        );
        assert!(done["resource"]["installation"]["pendingRepair"].is_null());
        assert_eq!(done["receipt"]["temporaryPaths"], json!([old_temporary]));
        assert_eq!(fs::read(&old_temporary).unwrap(), b"lic");
        assert_eq!(
            fs::read(dir.path().join("v1/LICENSE")).unwrap(),
            b"license terms"
        );
        drop(manager);
        let mut reopened = Manager::new(state).unwrap();
        let stored = read_resource(&reopened, id).unwrap();
        assert_eq!(
            stored.installation.as_ref().unwrap().retained_repair_files,
            vec![old_temporary.clone()]
        );
        assert!(!stored.enabled);
        let no_work = handle(
            &mut reopened,
            &repair_request(&serde_json::to_value(&stored).unwrap()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(no_work["canApply"], false);
        assert_eq!(no_work["retainedTemporaryPaths"], json!([old_temporary]));
        assert_eq!(fs::read(&old_temporary).unwrap(), b"lic");
    }
    #[test]
    fn shared_task_repair_persists_the_same_resource_and_original_enabled_state() {
        let dir = fixture();
        let state = dir.path().join("state");
        let mut manager = Manager::new(state.clone()).unwrap();
        let installed = install(&mut manager, dir.path());
        fs::remove_file(dir.path().join("v1/bin/tool.exe")).unwrap();
        let service = crate::tasks::TaskSystem::new(manager).unwrap();
        let plan = service
            .execute(repair_request(&installed["resource"]), crate::dispatch)
            .unwrap();
        let repaired = service
            .execute(repair_apply(&plan), crate::dispatch_local)
            .unwrap();
        assert_eq!(repaired["complete"], true);
        assert_eq!(repaired["resource"]["enabled"], true);
        drop(service);
        let reopened = Manager::new(state).unwrap();
        let record =
            read_resource(&reopened, installed["resource"]["id"].as_str().unwrap()).unwrap();
        assert_eq!(record.revision, 4);
        assert_eq!(record.installation.unwrap().files.len(), 2);
        assert!(record.enabled);
        assert_eq!(
            fs::read(dir.path().join("v1/bin/tool.exe")).unwrap(),
            b"synthetic runtime"
        );
    }
    #[test]
    fn repair_refuses_active_owned_service_without_stopping_it() {
        let dir = fixture();
        let mut manager = Manager::new(dir.path().join("state")).unwrap();
        let installed = install(&mut manager, dir.path());
        let id = installed["resource"]["id"].as_str().unwrap();
        crate::dispatch_local(&mut manager,&json!({"action":"resource_action_set","id":id,"expectedRevision":2,
            "definition":{"id":"test","label":"Synthetic service","mode":"service","executable":std::env::current_exe().unwrap(),"workingDirectory":dir.path().join("v1"),
            "args":[{"type":"literal","value":"--exact"},{"type":"literal","value":"resource_runtime::tests::synthetic_wait"},{"type":"literal","value":"--ignored"}]}})).unwrap();
        fs::remove_file(dir.path().join("v1/LICENSE")).unwrap();
        let record = read_resource(&manager, id).unwrap();
        let plan = handle(
            &mut manager,
            &repair_request(&serde_json::to_value(&record).unwrap()),
        )
        .unwrap()
        .unwrap();
        let run = crate::dispatch(
            &mut manager,
            &json!({"action":"resource_invoke","id":id,"actionId":"test","parameters":{}}),
        )
        .unwrap();
        let error = crate::dispatch_local(&mut manager, &repair_apply(&plan)).unwrap_err();
        assert!(error.contains("仍在运行"));
        assert_eq!(
            manager.resource_runtime.snapshot(Some(id)).unwrap()["runs"][0]["status"],
            "running"
        );
        assert_eq!(
            read_resource(&manager, id).unwrap().revision,
            record.revision
        );
        manager
            .resource_runtime
            .stop(run["run"]["runId"].as_str().unwrap())
            .unwrap();
    }

    #[test]
    fn minimal_install_is_previewed_native_only_single_use_and_durably_owned() {
        let dir = fixture();
        let mut manager = Manager::new(dir.path().join("state")).unwrap();
        let archive = package(dir.path());
        let target = dir.path().join("v1");
        let inventory = handle(
            &mut manager,
            &json!({"action":"resource_package_inspect","archivePath":archive}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(inventory["files"].as_array().unwrap().len(), 3);
        let plan = handle(&mut manager, &request(&archive, &target))
            .unwrap()
            .unwrap();
        assert!(!target.exists());
        assert_eq!(plan["files"].as_array().unwrap().len(), 2);
        let apply = json!({"action":"apply_resource_install","previewId":plan["id"]});
        assert!(crate::dispatch(&mut manager, &apply).is_err());
        assert!(crate::dispatch(
            &mut manager,
            &json!({"action":"apply_resource_install","previewId":plan["id"],"confirmed":true})
        )
        .is_err());
        assert!(apply_local(
            &mut manager,
            &json!({"action":"apply_resource_install","previewId":plan["id"],"confirmed":true})
        )
        .is_err());
        let result = crate::dispatch_local(&mut manager, &apply).unwrap();
        assert_eq!(result["complete"], true);
        assert_eq!(result["ownershipSaved"], true);
        assert_eq!(
            result["resource"]["installation"]["files"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(target.join("LICENSE").is_file());
        assert!(!target.join("tests").exists());
        assert!(crate::dispatch_local(&mut manager, &apply).is_err());
        drop(manager);
        let reopened = Manager::new(dir.path().join("state")).unwrap();
        let record = read_resource(&reopened, result["resource"]["id"].as_str().unwrap()).unwrap();
        assert_eq!(record.installation.unwrap().status, "installed");
        assert_eq!(
            record.repository.as_deref(),
            Some("https://github.com/example/tool")
        );
    }

    #[test]
    fn archive_changes_fail_before_catalog_or_files_are_created() {
        let dir = fixture();
        let mut manager = Manager::new(dir.path().join("state")).unwrap();
        let archive = package(dir.path());
        let target = dir.path().join("v1");
        let plan = handle(&mut manager, &request(&archive, &target))
            .unwrap()
            .unwrap();
        fs::write(&archive, b"changed archive").unwrap();
        assert!(apply_local(
            &mut manager,
            &json!({"action":"apply_resource_install","previewId":plan["id"]})
        )
        .is_err());
        assert!(!target.exists());
        assert_eq!(
            manager.resource_store(StoreRequest::List).unwrap()["resources"],
            json!([])
        );
        assert!(!manager.previews.contains_key(plan["id"].as_str().unwrap()));
    }

    #[test]
    fn unowned_registration_can_only_disable_without_claiming_full_uninstall() {
        let dir = fixture();
        let target = dir.path().join("external");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("user.txt"), b"unique user data").unwrap();
        let mut manager = Manager::new(dir.path().join("state")).unwrap();
        let record = crate::resources::handle(&manager,&json!({"action":"resource_register","name":"external","kind":"portable","rootPath":target})).unwrap().unwrap()["resource"].clone();
        let plan = handle(&mut manager,&json!({"action":"preview_resource_remove","id":record["id"],"expectedRevision":1,"extent":"complete"})).unwrap().unwrap();
        assert_eq!(plan["canApply"], false);
        assert!(apply_local(
            &mut manager,
            &json!({"action":"apply_resource_remove","previewId":plan["id"]})
        )
        .is_err());
        let plan = handle(&mut manager,&json!({"action":"preview_resource_remove","id":record["id"],"expectedRevision":1,"extent":"disable"})).unwrap().unwrap();
        let result = apply_local(
            &mut manager,
            &json!({"action":"apply_resource_remove","previewId":plan["id"]}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(result["complete"], true);
        assert_eq!(result["fullyRemoved"], false);
        assert_eq!(result["resource"]["enabled"], false);
        assert_eq!(
            fs::read(target.join("user.txt")).unwrap(),
            b"unique user data"
        );
    }

    #[test]
    fn runtime_removal_preserves_local_edits_unknown_data_and_origin_then_custom_is_explicit() {
        let dir = fixture();
        let mut manager = Manager::new(dir.path().join("state")).unwrap();
        let installed = install(&mut manager, dir.path());
        let id = installed["resource"]["id"].clone();
        let target = dir.path().join("v1");
        fs::write(target.join("bin/tool.exe"), b"local patch").unwrap();
        fs::write(target.join("config.json"), b"private config").unwrap();
        let plan = handle(&mut manager,&json!({"action":"preview_resource_remove","id":id,"expectedRevision":2,"extent":"runtime"})).unwrap().unwrap();
        let result = apply_local(
            &mut manager,
            &json!({"action":"apply_resource_remove","previewId":plan["id"]}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(result["complete"], false);
        assert_eq!(
            result["resource"]["repository"],
            "https://github.com/example/tool"
        );
        assert_eq!(
            fs::read(target.join("bin/tool.exe")).unwrap(),
            b"local patch"
        );
        assert_eq!(
            fs::read(target.join("config.json")).unwrap(),
            b"private config"
        );
        assert!(!target.join("LICENSE").exists());
        let plan = handle(&mut manager,&json!({"action":"preview_resource_remove","id":id,"expectedRevision":result["resource"]["revision"],"extent":"custom","customFiles":["bin/tool.exe"]})).unwrap().unwrap();
        let result = apply_local(
            &mut manager,
            &json!({"action":"apply_resource_remove","previewId":plan["id"]}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(result["complete"], true);
        assert_eq!(result["fullyRemoved"], false);
        assert!(!target.join("bin/tool.exe").exists());
        assert!(target.join("config.json").exists());
    }

    #[test]
    fn file_or_record_drift_invalidates_a_consumed_removal_preview_before_deletion() {
        let dir = fixture();
        let mut manager = Manager::new(dir.path().join("state")).unwrap();
        let installed = install(&mut manager, dir.path());
        let id = installed["resource"]["id"].clone();
        let plan = handle(&mut manager,&json!({"action":"preview_resource_remove","id":id,"expectedRevision":2,"extent":"complete"})).unwrap().unwrap();
        fs::write(dir.path().join("v1/LICENSE"), b"changed after preview").unwrap();
        assert!(apply_local(
            &mut manager,
            &json!({"action":"apply_resource_remove","previewId":plan["id"]})
        )
        .is_err());
        assert!(dir.path().join("v1/bin/tool.exe").exists());
        assert!(!manager.previews.contains_key(plan["id"].as_str().unwrap()));
        let current = read_resource(&manager, id.as_str().unwrap()).unwrap();
        let plan = handle(&mut manager,&json!({"action":"preview_resource_remove","id":id,"expectedRevision":current.revision,"extent":"custom","customFiles":["bin/tool.exe"]})).unwrap().unwrap();
        crate::resources::handle(&manager,&json!({"action":"resource_update","id":id,"expectedRevision":current.revision,"changes":{"notes":"new note"}})).unwrap();
        assert!(apply_local(
            &mut manager,
            &json!({"action":"apply_resource_remove","previewId":plan["id"]})
        )
        .is_err());
        assert!(dir.path().join("v1/bin/tool.exe").exists());
    }

    #[test]
    fn single_writer_tasks_retain_previews_and_persist_real_installation_ownership() {
        let dir = fixture();
        let service =
            crate::tasks::TaskSystem::new(Manager::new(dir.path().join("state")).unwrap()).unwrap();
        let plan = service
            .execute(
                request(&package(dir.path()), &dir.path().join("v1")),
                crate::dispatch,
            )
            .unwrap();
        let apply = json!({"action":"apply_resource_install","previewId":plan["id"]});
        assert!(service.execute(apply.clone(), crate::dispatch).is_err());
        let result = service
            .execute(apply.clone(), crate::dispatch_local)
            .unwrap();
        assert_eq!(result["complete"], true);
        assert!(service.execute(apply, crate::dispatch_local).is_err());
        let list = service
            .execute(json!({"action":"resource_list"}), crate::dispatch)
            .unwrap();
        assert_eq!(list["resources"][0]["installation"]["status"], "installed");
        assert_eq!(
            list["resources"][0]["installation"]["files"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn selected_file_roles_are_owned_and_runtime_removal_keeps_configuration_and_user_material() {
        let dir = fixture();
        let archive = dir.path().join("roles.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
        for name in [
            "tool.exe",
            "config.json",
            "data.db",
            "cache.bin",
            "patch.txt",
            "LICENSE",
        ] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(name.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        let mut manager = Manager::new(dir.path().join("state")).unwrap();
        let mut input = request(&archive, &dir.path().join("v1"));
        input["selectedFiles"] = json!([
            "tool.exe",
            "config.json",
            "data.db",
            "cache.bin",
            "patch.txt"
        ]);
        input["fileRoles"] = json!({"tool.exe":"runtime","config.json":"configuration","data.db":"userData","cache.bin":"cache","patch.txt":"localModification"});
        let plan = handle(&mut manager, &input).unwrap().unwrap();
        let installed = apply_local(
            &mut manager,
            &json!({"action":"apply_resource_install","previewId":plan["id"]}),
        )
        .unwrap()
        .unwrap();
        assert!(installed["receipt"]["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["path"] == "config.json" && f["role"] == "configuration"));
        let plan = handle(&mut manager,&json!({"action":"preview_resource_remove","id":installed["resource"]["id"],"expectedRevision":2,"extent":"runtime"})).unwrap().unwrap();
        let result = apply_local(
            &mut manager,
            &json!({"action":"apply_resource_remove","previewId":plan["id"]}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(result["complete"], true);
        assert!(!dir.path().join("v1/tool.exe").exists());
        for name in ["config.json", "data.db", "cache.bin", "patch.txt"] {
            assert!(dir.path().join("v1").join(name).is_file());
        }
        assert_eq!(
            result["resource"]["installation"]["files"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
    }

    #[test]
    fn failed_extraction_keeps_partial_receipt_disabled_and_never_claims_installed() {
        let dir = fixture();
        let archive = dir.path().join("corrupt.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
        for (name, data) in [
            ("LICENSE", "valid terms"),
            ("bin/tool.exe", "SYNTHETIC_CRC_PAYLOAD"),
        ] {
            zip.start_file(
                name,
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
            zip.write_all(data.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        let mut bytes = fs::read(&archive).unwrap();
        let offset = bytes
            .windows(b"SYNTHETIC_CRC_PAYLOAD".len())
            .position(|w| w == b"SYNTHETIC_CRC_PAYLOAD")
            .unwrap();
        bytes[offset] = b'X';
        fs::write(&archive, bytes).unwrap();
        let mut manager = Manager::new(dir.path().join("state")).unwrap();
        let plan = handle(&mut manager, &request(&archive, &dir.path().join("v1")))
            .unwrap()
            .unwrap();
        let result = apply_local(
            &mut manager,
            &json!({"action":"apply_resource_install","previewId":plan["id"]}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(result["complete"], false);
        assert_eq!(result["resource"]["enabled"], false);
        assert_eq!(result["resource"]["installation"]["status"], "partial");
        assert!(result["receipt"]["error"].is_string());
        assert!(dir.path().join("v1/LICENSE").is_file());
        let persisted =
            read_resource(&manager, result["resource"]["id"].as_str().unwrap()).unwrap();
        assert!(!persisted.enabled);
        assert_eq!(persisted.installation.unwrap().status, "partial");
    }
}
