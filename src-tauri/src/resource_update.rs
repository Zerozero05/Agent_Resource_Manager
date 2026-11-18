//! Stage new runtimes in their final directories. Old files and user data are never copied.
//! A native-only switch requires an isolated capability probe owned by an adapter,
//! not a Boolean supplied by a GUI or Agent request.
use crate::{
    model::{now, Manager},
    resource_files::{self, FileRole, Fingerprint, OwnedFile, PackageInventory},
    resource_github::DownloadSource,
    resource_lifecycle::InstallationRecord,
    resources::{ResourceRecord, StoreRequest},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateState {
    pub candidate: Option<Candidate>,
    pub previous: Vec<PreviousRuntime>,
    #[serde(default)]
    pub retained_candidates: Vec<RetainedCandidate>,
    pub last_failure: Option<String>,
    #[serde(default)]
    last_validation: Option<Validation>,
    #[serde(default)]
    switch_check: Option<SwitchCheck>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SwitchCheck {
    #[serde(default)]
    attempt_id: String,
    status: String,
    checked_at: String,
    adapter: Option<String>,
    verified_scopes: Vec<String>,
    error: Option<String>,
}

/// Constructed only by a server-owned adapter after its actual read-only probe.
pub(crate) struct ProbeEvidence {
    pub adapter: String,
    pub verified_scopes: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RetainedCandidate {
    pub candidate: Candidate,
    pub retained_at: String,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviousRuntime {
    pub root: PathBuf,
    pub version: Option<String>,
    pub archive_path: String,
    pub archive_sha256: String,
    pub source_repository: Option<String>,
    pub source_version: Option<String>,
    pub download_source: Option<DownloadSource>,
    #[serde(default)]
    pub runtime_package: Option<crate::resource_package::RuntimePackageProvenance>,
    #[serde(default)]
    pub resource_manifest: Option<crate::resource_manifest::ManifestRecord>,
    pub files: Vec<OwnedFile>,
    #[serde(default)]
    pub retained_repair_files: Vec<PathBuf>,
    pub actions: Vec<Value>,
    pub retained_at: String,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Candidate {
    pub root: PathBuf,
    pub version: String,
    pub archive_path: PathBuf,
    pub archive_sha256: String,
    pub download_source: Option<DownloadSource>,
    #[serde(default)]
    pub runtime_package: Option<crate::resource_package::RuntimePackageProvenance>,
    #[serde(default)]
    pub resource_manifest: Option<crate::resource_manifest::ManifestRecord>,
    /// An observed failed/competing metadata write, never owned by filename.
    #[serde(default)]
    pub unverified_manifest_path: Option<PathBuf>,
    pub files: Vec<OwnedFile>,
    /// Paths created even when a file was only partly written. This is a
    /// durable receipt index, not permission to delete unhashed content.
    #[serde(default)]
    pub created_paths: Vec<PathBuf>,
    pub complete: bool,
    pub error: Option<String>,
    original: Baseline,
    validation: Option<Validation>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Baseline {
    root: PathBuf,
    root_identity: String,
    files: BTreeMap<String, Fingerprint>,
    resource: Value,
    relations: Value,
    #[serde(default)]
    resource_manifest: Option<crate::resource_manifest::ManifestRecord>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Validation {
    adapter: String,
    verified_at: String,
    candidate_root_identity: String,
    files: BTreeMap<String, Fingerprint>,
    actions: Vec<Value>,
    #[serde(default)]
    external_executables: BTreeMap<String, ExecutableProof>,
    #[serde(default)]
    resource_manifest: Option<crate::resource_manifest::ManifestRecord>,
    #[serde(default)]
    runtime_package: Option<crate::resource_package::RuntimePackageProvenance>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecutableProof {
    file: Fingerprint,
    object_identity: String,
}
fn external_executables(
    actions: &[Value],
    root: &Path,
) -> Result<BTreeMap<String, ExecutableProof>, String> {
    let root = crate::local::canonical(root)?;
    let mut result = BTreeMap::new();
    for action in actions {
        let action: crate::resource_runtime::ActionDefinition =
            serde_json::from_value(action.clone()).map_err(|_| "执行入口定义无效")?;
        let path = crate::local::canonical(Path::new(&action.executable))?;
        if !nested(&path, &root) {
            let file = resource_files::fingerprint(&path)?;
            if action.executable_sha256.as_deref() != Some(file.sha256.as_str()) {
                return Err("共享执行环境摘要已变化".into());
            }
            if result
                .insert(
                    action.id,
                    ExecutableProof {
                        file,
                        object_identity: crate::clients::file_identity(&path)?,
                    },
                )
                .is_some()
            {
                return Err("共享执行环境的动作标识重复，不能绑定验证".into());
            }
        }
    }
    Ok(result)
}

/// This target is constructed only after all local/package invariants pass.
/// The adapter must use isolated inputs/data and must never probe user login data.
pub(crate) struct ValidationTarget {
    pub root: PathBuf,
    pub version: String,
    pub files: Vec<OwnedFile>,
    pub actions: Vec<Value>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreparedStage {
    resource_id: String,
    original: Baseline,
    archive_path: PathBuf,
    inventory: PackageInventory,
    destination: PathBuf,
    version: String,
    selected: Vec<String>,
    roles: BTreeMap<String, FileRole>,
    source: Option<DownloadSource>,
}

fn display(path: &Path) -> String {
    let text = path.to_string_lossy();
    text.strip_prefix(r"\\?\UNC\")
        .map(|s| format!(r"\\{s}"))
        .or_else(|| text.strip_prefix(r"\\?\").map(str::to_owned))
        .unwrap_or_else(|| text.into_owned())
}
fn key(path: &Path) -> String {
    let text = display(path);
    if cfg!(windows) {
        text.replace('/', "\\").to_lowercase()
    } else {
        text
    }
}
fn nested(path: &Path, root: &Path) -> bool {
    let (p, r) = (key(path), key(root));
    p == r || p.starts_with(&(r + if cfg!(windows) { "\\" } else { "/" }))
}
fn text<'a>(value: &'a Value, field: &str, max: usize) -> Result<&'a str, String> {
    value[field]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.len() <= max && !s.chars().any(char::is_control))
        .ok_or_else(|| format!("{field} 内容缺失或无效"))
}
fn allowed(request: &Value, fields: &[&str]) -> Result<(), String> {
    if request
        .as_object()
        .is_none_or(|o| o.keys().any(|k| !fields.contains(&k.as_str())))
    {
        Err("更新请求包含未批准的字段".into())
    } else {
        Ok(())
    }
}
fn read(m: &Manager, id: &str) -> Result<ResourceRecord, String> {
    serde_json::from_value(m.resource_store(StoreRequest::Get(id.into()))?)
        .map_err(|e| e.to_string())
}
fn normal(m: &Manager) -> Result<(), String> {
    if m.basic_mode {
        Err("基本模式不准备、验证或切换运行版本".into())
    } else {
        Ok(())
    }
}
fn installation(record: &ResourceRecord) -> Result<&InstallationRecord, String> {
    record
        .installation
        .as_ref()
        .filter(|i| i.schema_version == 1 && i.status == "installed" && i.pending_repair.is_none())
        .ok_or_else(|| "没有完整可信的原安装记录，不能据此更新运行版本".into())
}
fn identity(record: &ResourceRecord) -> Value {
    let mut value = json!(record);
    value.as_object_mut().expect("record").remove("revision");
    value.as_object_mut().expect("record").remove("updatedAt");
    if let Some(i) = value["installation"].as_object_mut() {
        i.remove("updateState");
    }
    value
}
fn linked(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}
/// Includes unknown and dot files; no tool inventory is inferred from a Skill scan.
#[cfg(test)]
fn inventory(root: &Path) -> Result<BTreeMap<String, Fingerprint>, String> {
    inventory_registered(root, None)
}
fn inventory_registered(
    root: &Path,
    manifest: Option<&crate::resource_manifest::ManifestRecord>,
) -> Result<BTreeMap<String, Fingerprint>, String> {
    // A filename alone is never an exclusion. Validate the catalog's exact
    // receipt first, including bytes and file identity, then skip that one file.
    if let Some(manifest) = manifest {
        crate::resource_manifest::validate_owned(root, manifest)?;
    }
    fn walk(
        root: &Path,
        dir: &Path,
        depth: usize,
        out: &mut BTreeMap<String, Fingerprint>,
        manifest_path: Option<&str>,
    ) -> Result<(), String> {
        if depth > 32 {
            return Err("运行目录层级过深，不能完整核对".into());
        }
        for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
            crate::network::check_cancelled()?;
            let path = entry.map_err(|e| e.to_string())?.path();
            let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if linked(&meta) {
                return Err(format!(
                    "目录包含链接或重解析点，需先核对：{}",
                    path.display()
                ));
            }
            if meta.is_dir() {
                walk(root, &path, depth + 1, out, manifest_path)?;
            } else if meta.is_file() {
                if out.len() >= 50_000 {
                    return Err("运行目录文件数超过核对范围".into());
                }
                let relative = path
                    .strip_prefix(root)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                crate::local::validate_relative_path(&relative)?;
                if manifest_path == Some(relative.as_str()) {
                    continue;
                }
                out.insert(relative, resource_files::fingerprint(&path)?);
            } else {
                return Err("运行目录包含不支持的文件类型".into());
            }
        }
        Ok(())
    }
    crate::transaction::verify_root(root)?;
    if !root.is_dir() {
        return Err("运行版本目录不可用".into());
    }
    let mut result = BTreeMap::new();
    walk(
        root,
        root,
        0,
        &mut result,
        manifest.map(|m| m.relative_path.as_str()),
    )?;
    Ok(result)
}
fn relations(m: &Manager, id: &str) -> Result<Value, String> {
    let value = m.relation_store(crate::resource_relations::StoreRequest::List {
        endpoint: crate::resource_relations::Endpoint {
            kind: "tool".into(),
            id: id.into(),
        },
    })?;
    Ok(
        json!({"revision":value["revision"],"endpoint":value["endpoint"],
        "dependencies":value["dependencies"],"dependents":value["dependents"]}),
    )
}
fn baseline(m: &Manager, record: &ResourceRecord) -> Result<Baseline, String> {
    installation(record)?;
    let root = PathBuf::from(&record.root_path);
    Ok(Baseline {
        root_identity: crate::clients::file_identity(&root)?,
        files: inventory_registered(&root, installation(record)?.resource_manifest.as_ref())?,
        root,
        resource: identity(record),
        relations: relations(m, &record.id)?,
        resource_manifest: installation(record)?.resource_manifest.clone(),
    })
}
fn verify_baseline(
    m: &Manager,
    record: &ResourceRecord,
    original: &Baseline,
) -> Result<(), String> {
    if key(Path::new(&record.root_path)) != key(&original.root)
        || identity(record) != original.resource
        || relations(m, &record.id)? != original.relations
        || crate::clients::file_identity(&original.root)? != original.root_identity
        || inventory_registered(&original.root, original.resource_manifest.as_ref())?
            != original.files
    {
        return Err("原版本、文件、策略、动作或使用关系已变化，请重新核对更新".into());
    }
    Ok(())
}
fn new_destination(m: &Manager, path: &Path, record: &ResourceRecord) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("新版本保存位置须为绝对路径".into());
    }
    crate::transaction::verify_root(path)?;
    if path.exists() {
        return Err("新版本目录已存在；不覆盖或复用其中内容".into());
    }
    let parent = crate::local::canonical(path.parent().ok_or("缺少保存位置父目录")?)?;
    let final_path =
        PathBuf::from(display(&parent)).join(path.file_name().ok_or("缺少版本目录名")?);
    // Installation and update share the live location boundary, including
    // custom manager paths, development files, Skills and all retained runtimes.
    crate::resource_lifecycle::ensure_independent_update_destination(m, &final_path, &record.id)?;
    Ok(final_path)
}
fn save_record(m: &Manager, mut record: ResourceRecord) -> Result<ResourceRecord, String> {
    let expected = record.revision;
    record.revision = expected.checked_add(1).ok_or("修订号超出范围")?;
    record.updated_at = now();
    m.resource_store(StoreRequest::Replace {
        record: Box::new(record.clone()),
        expected_revision: expected,
    })?;
    Ok(record)
}
fn remember(m: &mut Manager, kind: &str, public: Value, prepared: Value) -> Value {
    let id = public["id"].as_str().expect("id").to_owned();
    m.previews.insert(id, json!({"kind":kind,"resourceId":public["resourceId"],"targetPath":public["targetPath"],"originalPath":public["originalPath"],"archivePath":public["archivePath"],"prepared":prepared,"createdAt":chrono::Utc::now().timestamp_millis(),"public":public}));
    let cutoff = chrono::Utc::now().timestamp_millis() - 600_000;
    m.previews.retain(|_, p| {
        !matches!(
            p["kind"].as_str(),
            Some("resourceUpdateStage" | "resourceUpdateSwitch" | "resourceUpdateAbandon")
        ) || p["createdAt"].as_i64().is_some_and(|n| n >= cutoff)
    });
    public
}
fn preview_stage(m: &mut Manager, request: &Value) -> Result<Value, String> {
    normal(m)?;
    allowed(
        request,
        &[
            "action",
            "id",
            "expectedRevision",
            "archivePath",
            "destinationPath",
            "version",
            "selectedFiles",
            "fileRoles",
            "downloadId",
        ],
    )?;
    let record = read(m, text(request, "id", 64)?)?;
    if request["expectedRevision"].as_u64() != Some(record.revision) {
        return Err("资源已变化，请重新读取后更新".into());
    }
    let installed = installation(&record)?;
    if installed
        .update_state
        .as_ref()
        .is_some_and(|s| s.candidate.is_some())
    {
        return Err("已有未处理候选版本，先核对其结果，不能覆盖或丢失其归属".into());
    }
    let original = baseline(m, &record)?;
    let version = text(request, "version", 160)?.trim().to_owned();
    if record.version.as_deref() == Some(&version) {
        return Err("候选与当前版本相同；固定版本缺失文件请使用修复入口".into());
    }
    let archive = PathBuf::from(text(request, "archivePath", 32767)?);
    crate::transaction::verify_root(&archive)?;
    let archive = PathBuf::from(display(&crate::local::canonical(&archive)?));
    let package = resource_files::inspect_zip(&archive, MAX_BYTES)?;
    let source = crate::resource_github::verified_source(m, request, &archive, &package.archive)?;
    if source
        .as_ref()
        .is_some_and(|s| record.repository.as_ref() != Some(&s.repository))
    {
        return Err("下载来源与当前关联不同，需先显式核对来源重绑".into());
    }
    let destination = new_destination(
        m,
        Path::new(text(request, "destinationPath", 32767)?),
        &record,
    )?;
    let mut selected: BTreeSet<String> =
        serde_json::from_value::<Vec<String>>(request["selectedFiles"].clone())
            .map_err(|_| "必须选择候选运行文件")?
            .into_iter()
            .collect();
    if selected.is_empty() {
        return Err("必须选择候选运行文件".into());
    }
    if selected
        .iter()
        .any(|name| !package.files.iter().any(|f| &f.path == name))
    {
        return Err("选择包含不在已验包内的文件".into());
    }
    selected.extend(
        package
            .files
            .iter()
            .filter(|f| f.license)
            .map(|f| f.path.clone()),
    );
    let mut roles: BTreeMap<String, FileRole> = if request.get("fileRoles").is_none() {
        BTreeMap::new()
    } else {
        serde_json::from_value(request["fileRoles"].clone()).map_err(|_| "候选文件用途无效")?
    };
    if roles.keys().any(|p| !selected.contains(p)) {
        return Err("文件用途包含未选文件".into());
    }
    for name in &selected {
        if name.eq_ignore_ascii_case(crate::resource_manifest::NAME) {
            return Err("包内同名管理记录不能冒认或覆盖；请从运行文件选择中移除此项".into());
        }
        let package_file = package
            .files
            .iter()
            .find(|f| f.path == *name)
            .ok_or("候选文件不存在")?;
        let role = if package_file.license {
            FileRole::License
        } else {
            roles.get(name).cloned().unwrap_or(FileRole::Runtime)
        };
        if !matches!(
            role,
            FileRole::Runtime | FileRole::PrivateDependency | FileRole::License
        ) || (!package_file.license && role == FileRole::License)
        {
            return Err(
                "候选运行目录只包含运行文件、私人依赖和许可证；用户数据与配置需独立保留".into(),
            );
        }
        roles.insert(name.clone(), role);
    }
    if !roles.values().any(|r| *r == FileRole::Runtime) {
        return Err("候选不能仅包含许可或依赖，需有运行入口".into());
    }
    let hashes = archive_hashes(&archive, &package, &selected)?;
    let mut names: BTreeSet<_> = installed.files.iter().map(|f| f.path.clone()).collect();
    names.extend(selected.iter().cloned());
    let changes: Vec<_> = names.iter().map(|name| {
        let before = installed.files.iter().find(|f| f.path == *name).map(|f| f.installed_sha256.as_str());
        let local = original.files.get(name).map(|f| f.sha256.as_str());
        let upstream = hashes.get(name).map(String::as_str);
        json!({"path":name,"baselineSha256":before,"localSha256":local,"upstreamSha256":upstream,"localModified":before!=local,"upstreamChanged":before!=upstream})
    }).collect();
    let selected_bytes: u64 = package
        .files
        .iter()
        .filter(|f| selected.contains(&f.path))
        .map(|f| f.bytes)
        .sum();
    let (_, space) =
        crate::storage::destination_space(destination.parent().ok_or("保存父目录不可用")?)?;
    if space.is_some_and(|s| s < selected_bytes) {
        return Err("候选保存位置空间不足，当前版本未改动".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let public = json!({"id":id,"kind":"resourceUpdateStage","resourceId":record.id,"resourceRevision":record.revision,"originalPath":record.root_path,"targetPath":destination,"archivePath":archive,"version":version,"files":roles,"changes":changes,"selectedBytes":selected_bytes,"canApply":true,
        "managementRecord":{"relativePath":crate::resource_manifest::NAME,"targetPath":destination.join(crate::resource_manifest::NAME),"purpose":"本候选的单份非敏感管理索引，不含配置、登录信息或源码副本","executionGrant":false,"deleteGrant":false},
        "warnings":["只准备候选，当前运行入口保持；需要实际隔离验证后另行确认切换。","原版本、配置、本地改造和未知文件不复制、不删除；有无法分离的内容时暂停切换。"]});
    let prepared = PreparedStage {
        resource_id: record.id,
        original,
        archive_path: archive,
        inventory: package,
        destination,
        version,
        selected: selected.into_iter().collect(),
        roles,
        source,
    };
    Ok(remember(m, "resourceUpdateStage", public, json!(prepared)))
}
fn archive_hashes(
    path: &Path,
    package: &PackageInventory,
    selected: &BTreeSet<String>,
) -> Result<BTreeMap<String, String>, String> {
    use sha2::{Digest, Sha256};
    let mut zip = zip::ZipArchive::new(fs::File::open(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut hashes = BTreeMap::new();
    for name in selected {
        let mut entry = zip.by_name(name).map_err(|e| e.to_string())?;
        let maximum = package
            .files
            .iter()
            .find(|file| file.path == *name)
            .ok_or("候选清单缺少文件")?
            .bytes;
        let mut bytes = 0u64;
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 65536];
        loop {
            crate::network::check_cancelled()?;
            let n = entry.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            bytes += n as u64;
            if bytes > maximum {
                return Err("候选文件超过已核实的展开大小".into());
            }
            hash.update(&buffer[..n]);
        }
        if bytes != maximum {
            return Err("候选文件长度与清单不符".into());
        }
        hashes.insert(name.clone(), format!("{:x}", hash.finalize()));
    }
    if resource_files::fingerprint(path)? != package.archive {
        return Err("候选包核对时发生变化".into());
    }
    Ok(hashes)
}
fn stage(m: &Manager, prepared: PreparedStage) -> Result<Value, String> {
    stage_with(m, prepared, resource_files::install_zip)
}
fn stage_with(
    m: &Manager,
    prepared: PreparedStage,
    installer: impl FnOnce(
        &Path,
        &PackageInventory,
        &[String],
        &Path,
    ) -> Result<resource_files::InstallReceipt, String>,
) -> Result<Value, String> {
    normal(m)?;
    let mut record = read(m, &prepared.resource_id)?;
    verify_baseline(m, &record, &prepared.original)?;
    if installation(&record)?
        .update_state
        .as_ref()
        .is_some_and(|s| s.candidate.is_some())
    {
        return Err("已有候选版本，原候选保留".into());
    }
    new_destination(m, &prepared.destination, &record)?;
    let selected: BTreeSet<&str> = prepared.selected.iter().map(String::as_str).collect();
    let selected_bytes: u64 = prepared
        .inventory
        .files
        .iter()
        .filter(|f| selected.contains(f.path.as_str()) || f.license)
        .map(|f| f.bytes)
        .sum();
    let (_, space) = crate::storage::destination_space(
        prepared.destination.parent().ok_or("候选父目录不可用")?,
    )?;
    if space.is_some_and(|s| s < selected_bytes) {
        return Err("保存空间已不足，当前版本未改动".into());
    }
    let mut receipt = installer(
        &prepared.archive_path,
        &prepared.inventory,
        &prepared.selected,
        &prepared.destination,
    )?;
    let mut files = receipt.files.clone();
    for file in &mut files {
        file.role = prepared
            .roles
            .get(&file.path)
            .cloned()
            .ok_or("候选归属缺少用途")?;
    }
    let source_repository = prepared
        .source
        .as_ref()
        .map(|s| s.repository.clone())
        .or(record.repository.clone());
    let source = crate::resource_manifest::ManifestSource {
        repository: source_repository.clone(),
        repository_id: record
            .source_binding
            .as_ref()
            .filter(|s| Some(&s.repository) == source_repository.as_ref())
            .map(|s| s.repository_id),
        release_id: prepared.source.as_ref().map(|s| s.release_id),
        asset_id: prepared.source.as_ref().map(|s| s.asset_id),
        asset_name: prepared.source.as_ref().map(|s| s.asset_name.clone()),
        archive_sha256: Some(prepared.inventory.archive.sha256.clone()),
        runtime_package: None,
    };
    let metadata_path = prepared.destination.join(crate::resource_manifest::NAME);
    let metadata = crate::resource_manifest::prepare(
        &prepared.destination,
        &record.id,
        &record.kind,
        Some(&prepared.version),
        Some(source),
        &files,
        receipt.complete,
    )
    .and_then(|metadata| {
        let preview = metadata.preview(&prepared.destination);
        crate::resource_manifest::write_new(&prepared.destination, &metadata)
            .map(|record| (record, preview))
    });
    let (manifest, manifest_preview, unverified_manifest_path) = match metadata {
        Ok((manifest, preview)) => {
            receipt.created_paths.push(metadata_path.clone());
            (Some(manifest), Some(preview), None)
        }
        Err(error) => {
            receipt.complete = false;
            receipt.error = Some(match receipt.error.take() {
                Some(prior) => format!("{prior}；候选管理记录：{error}"),
                None => format!("候选管理记录未完成：{error}"),
            });
            // An observed file could belong to a competing user write. Keep its
            // location durable without claiming creation or deletion authority.
            let observed = fs::symlink_metadata(&metadata_path)
                .is_ok()
                .then_some(metadata_path);
            (None, None, observed)
        }
    };
    let candidate = Candidate {
        root: prepared.destination,
        version: prepared.version,
        archive_path: prepared.archive_path,
        archive_sha256: prepared.inventory.archive.sha256,
        download_source: prepared.source,
        runtime_package: None,
        resource_manifest: manifest,
        unverified_manifest_path,
        files,
        created_paths: receipt.created_paths.clone(),
        complete: receipt.complete,
        error: receipt.error.clone(),
        original: prepared.original,
        validation: None,
    };
    let candidate_receipt = candidate.clone();
    let installed = record.installation.as_mut().ok_or("原安装记录缺失")?;
    let state = installed
        .update_state
        .get_or_insert_with(UpdateState::default);
    state.candidate = Some(candidate);
    state.last_failure = receipt.error.clone();
    match save_record(m, record) {
        Ok(saved) => Ok(
            json!({"resource":saved,"receipt":receipt,"managementRecord":manifest_preview,"complete":receipt.complete,"staged":true,"switched":false}),
        ),
        Err(error) => Ok(
            json!({"receipt":receipt,"candidateReceipt":candidate_receipt,"complete":false,"staged":true,"switched":false,"ownershipSaved":false,"error":format!("候选文件保留，保存归属记录失败，请核对本次回执：{error}")}),
        ),
    }
}
fn candidate(record: &ResourceRecord) -> Result<&Candidate, String> {
    installation(record)?
        .update_state
        .as_ref()
        .and_then(|s| s.candidate.as_ref())
        .filter(|c| c.complete)
        .ok_or_else(|| "没有完整候选运行版本".into())
}

pub(crate) fn check_materialized_candidate(
    m: &Manager,
    package: &crate::resource_package::controller::MaterializedPackage,
) -> Result<(), String> {
    normal(m)?;
    package.provenance.recheck_shared_runtime()?;
    if package.receipt.recipe != package.provenance.recipe
        || package.receipt.plan_hash != package.provenance.plan_hash
        || !package.receipt.complete
        || package.receipt.execution_verified
        || !package.receipt.dependency_check_passed
    {
        return Err("运行包实际准备回执与来源不一致".into());
    }
    let Some(binding) = &package.binding else {
        return crate::resource_lifecycle::ensure_independent_destination(m, &package.receipt.root);
    };
    let record = read(m, &binding.record.id)?;
    if json!(record) != json!(binding.record)
        || crate::clients::file_identity(Path::new(&record.root_path))? != binding.root_identity
        || relations(m, &record.id)? != binding.relations
    {
        return Err("原版本、目录、策略或使用关系已变化，请重新准备候选".into());
    }
    verify_registered_runtime(&record)?;
    let installed = installation(&record)?;
    if installed
        .update_state
        .as_ref()
        .is_some_and(|s| s.candidate.is_some())
    {
        return Err("已有候选版本，不能覆盖其文件归属".into());
    }
    let normalized = |value: &str| {
        value
            .trim()
            .trim_end_matches('/')
            .trim_end_matches(".git")
            .to_ascii_lowercase()
    };
    if record.repository.as_deref().map(normalized)
        != Some(normalized(&package.provenance.source_repository()?))
    {
        return Err("运行包官方来源与原登记资源不同，不能据此创建候选".into());
    }
    if record
        .version
        .as_deref()
        .is_some_and(|v| v.trim_start_matches('v') == package.provenance.version)
    {
        return Err("运行包版本与当前版本相同，不能冒充升级候选".into());
    }
    if let Some(previous) = &installed.runtime_package {
        previous.recheck_shared_runtime()?;
        let old = previous.shared_runtime_binding();
        let new = package.provenance.shared_runtime_binding();
        if old.path() != new.path()
            || old.object_identity() != new.object_identity()
            || old.fingerprint() != new.fingerprint()
        {
            return Err("候选使用了不同的共享运行环境，请先单独核对该环境，原入口保持".into());
        }
    }
    crate::resource_lifecycle::ensure_independent_update_destination(
        m,
        &package.receipt.root,
        &record.id,
    )
}

/// Admits an already materialized, hash-checked final directory. No ZIP installer
/// or caller-provided ownership list participates in this route.
pub(crate) fn stage_materialized(
    m: &Manager,
    package: crate::resource_package::controller::MaterializedPackage,
) -> Result<Value, String> {
    check_materialized_candidate(m, &package)?;
    let binding = package.binding.as_ref().ok_or("此准备会话未绑定原资源")?;
    let mut record = read(m, &binding.record.id)?;
    let original = baseline(m, &record)?;
    verify_baseline(m, &record, &original)?;
    let receipt = package.receipt;
    if receipt.files.is_empty()
        || receipt.files.iter().any(|f| {
            !matches!(
                f.role,
                FileRole::Runtime | FileRole::PrivateDependency | FileRole::License
            )
        })
    {
        return Err("候选运行包没有完整、明确的运行文件归属".into());
    }
    let provenance = package.provenance;
    let source = crate::resource_manifest::ManifestSource {
        repository: Some(provenance.source_repository()?),
        repository_id: None,
        release_id: None,
        asset_id: None,
        asset_name: None,
        archive_sha256: None,
        runtime_package: Some(
            crate::resource_manifest::RuntimePackageSource::from_provenance(&provenance)?,
        ),
    };
    let metadata_path = receipt.root.join(crate::resource_manifest::NAME);
    let metadata = crate::resource_manifest::prepare(
        &receipt.root,
        &record.id,
        &record.kind,
        Some(&provenance.version),
        Some(source),
        &receipt.files,
        true,
    )
    .and_then(|prepared| crate::resource_manifest::write_new(&receipt.root, &prepared));
    let (manifest, mut error, unverified) = match metadata {
        Ok(value) => (Some(value), None, None),
        Err(reason) => (
            None,
            Some(format!("候选管理记录未完成：{reason}")),
            fs::symlink_metadata(&metadata_path)
                .is_ok()
                .then_some(metadata_path.clone()),
        ),
    };
    if error.is_none() {
        if let Err(reason) = inventory_registered(&receipt.root, manifest.as_ref())
            .and_then(|actual| verify_owned_runtime(&receipt.files, &actual))
        {
            error = Some(reason);
        }
    }
    let mut created_paths = receipt.created_paths.clone();
    if manifest.is_some() {
        created_paths.push(metadata_path);
    }
    let staged = Candidate {
        root: receipt.root.clone(),
        version: provenance.version.clone(),
        archive_path: PathBuf::new(),
        archive_sha256: String::new(),
        download_source: None,
        runtime_package: Some(provenance),
        resource_manifest: manifest,
        unverified_manifest_path: unverified,
        files: receipt.files.clone(),
        created_paths,
        complete: error.is_none(),
        error: error.clone(),
        original,
        validation: None,
    };
    let candidate_receipt = staged.clone();
    let state = record
        .installation
        .as_mut()
        .ok_or("原安装归属缺失")?
        .update_state
        .get_or_insert_with(UpdateState::default);
    state.candidate = Some(staged);
    state.last_failure = error.clone();
    match save_record(m, record) {
        Ok(saved) => Ok(
            json!({"resource":crate::resource_lifecycle::public_record(&saved),"receipt":receipt,"registered":false,"staged":true,"switched":false,"executionVerified":false,"ownershipSaved":true,"complete":error.is_none(),"error":error}),
        ),
        Err(reason) => Ok(
            json!({"receipt":receipt,"candidateReceipt":candidate_receipt,"registered":false,"staged":false,"switched":false,"executionVerified":false,"ownershipSaved":false,"complete":false,"error":format!("候选目录保持，归属保存失败：{reason}")}),
        ),
    }
}

pub(crate) fn verify_registered_runtime(record: &ResourceRecord) -> Result<(), String> {
    let installed = installation(record)?;
    if let Some(package) = &installed.runtime_package {
        package.recheck_shared_runtime()?;
    }
    if !installed.system_entries.is_empty()
        || installed
            .removal_state
            .as_ref()
            .is_some_and(|s| !s.complete)
    {
        return Err("资源含专用系统入口或未完成移除，不能自动切换".into());
    }
    let actual = inventory_registered(
        Path::new(&record.root_path),
        installed.resource_manifest.as_ref(),
    )?;
    verify_owned_runtime(&installed.files, &actual)
}
fn verify_owned_runtime(
    owned: &[OwnedFile],
    actual: &BTreeMap<String, Fingerprint>,
) -> Result<(), String> {
    if owned.is_empty() {
        return Err("缺少原运行文件归属，不能完整保留本地信息".into());
    }
    for file in owned {
        if !matches!(
            file.role,
            FileRole::Runtime | FileRole::PrivateDependency | FileRole::License
        ) {
            return Err(
                "原目录含配置、用户数据、缓存或本地改造，请先核对数据分离，当前入口保持".into(),
            );
        }
        if actual.get(&file.path).map(|f| f.sha256.as_str()) != Some(file.installed_sha256.as_str())
        {
            return Err(format!(
                "原版本文件缺失或有本地改造，切换暂停：{}",
                file.path
            ));
        }
    }
    if actual
        .keys()
        .any(|name| !owned.iter().any(|file| &file.path == name))
    {
        return Err("原版本含未知归属文件，不能假定切换后仍能使用这些配置或数据".into());
    }
    Ok(())
}
fn switch_eligible(
    m: &Manager,
    record: &ResourceRecord,
    candidate: &Candidate,
) -> Result<(), String> {
    verify_baseline(m, record, &candidate.original)?;
    crate::resource_lifecycle::ensure_independent_update_destination(
        m,
        &candidate.root,
        &record.id,
    )?;
    if !installation(record)?.system_entries.is_empty()
        || installation(record)?
            .removal_state
            .as_ref()
            .is_some_and(|state| !state.complete)
    {
        return Err(
            "当前版本还有系统入口归属或未完成卸载，须先核对专用入口切换，原运行版本保持".into(),
        );
    }
    verify_owned_runtime(&installation(record)?.files, &candidate.original.files)?;
    if m.resource_runtime.snapshot(Some(&record.id))?["runs"]
        .as_array()
        .is_some_and(|runs| runs.iter().any(|r| r["status"] == "running"))
    {
        return Err("此资源仍在运行，请先协调停止受管进程，未切换入口".into());
    }
    let actual = inventory_registered(&candidate.root, candidate.resource_manifest.as_ref())?;
    if actual.len() != candidate.files.len()
        || candidate.files.iter().any(|f| {
            actual.get(&f.path).map(|a| a.sha256.as_str()) != Some(f.installed_sha256.as_str())
        })
    {
        return Err("候选运行文件不完整或已被修改，请重新核对".into());
    }
    Ok(())
}
fn new_actions(record: &ResourceRecord, candidate: &Candidate) -> Result<Vec<Value>, String> {
    let old = crate::local::canonical(Path::new(&record.root_path))?;
    let new = crate::local::canonical(&candidate.root)?;
    let mut actions = record.actions.clone();
    fn rebase(value: &str, old: &Path, new: &Path) -> Result<String, String> {
        let path = Path::new(value);
        if !path.is_absolute() {
            return Err("动作使用未核实的相对入口，需先核对适配器".into());
        }
        crate::transaction::verify_root(path)?;
        let path = crate::local::canonical(path)?;
        let relative = path
            .strip_prefix(old)
            .map_err(|_| "动作依赖版本目录之外的入口或数据，不能自动改写")?;
        let result = new.join(relative);
        crate::transaction::verify_root(&result)?;
        if !result.exists() {
            return Err(format!("候选缺少动作入口或工作目录：{}", result.display()));
        }
        Ok(result.to_string_lossy().into_owned())
    }
    for action in &mut actions {
        let mut definition: crate::resource_runtime::ActionDefinition =
            serde_json::from_value(action.clone()).map_err(|_| "当前动作定义无法核对")?;
        let executable = crate::local::canonical(Path::new(&definition.executable))?;
        if executable.starts_with(&old) {
            definition.executable = rebase(&definition.executable, &old, &new)?;
        } else {
            // This reviewed adapter reuses an already registered shared Node runtime.
            // It does not grant other external interpreters or infer ownership of Node.
            let installed = record.installation.as_ref().ok_or("原安装来源缺失")?;
            let repo_ok = |source: &DownloadSource| {
                source
                    .repository
                    .trim_end_matches('/')
                    .trim_end_matches(".git")
                    .eq_ignore_ascii_case("https://github.com/microsoft/playwright-mcp")
                    && matches!(source.verification.as_str(), "githubDigest" | "githubAsset")
            };
            let cli = old.join("node_modules/@playwright/mcp/cli.js");
            let cli_arg = matches!(definition.args.first(), Some(crate::resource_runtime::Argument::Literal { value })
                if crate::local::canonical(Path::new(value)).is_ok_and(|path| key(&path) == key(&cli)));
            let actual = resource_files::fingerprint(&executable)?.sha256;
            let package_ok = |package: &crate::resource_package::RuntimePackageProvenance,
                              version: &str| {
                let runtime = package.shared_runtime_binding();
                crate::resource_probe::package_source_matches(
                    package,
                    "microsoft/playwright-mcp",
                    version,
                ) && key(runtime.path()) == key(&executable)
                    && runtime.object_identity()
                        == crate::clients::file_identity(&executable).unwrap_or_default()
                    && runtime.fingerprint().sha256 == actual
            };
            let original_source_ok = match &installed.runtime_package {
                Some(package) => record
                    .version
                    .as_deref()
                    .is_some_and(|version| package_ok(package, version)),
                None => installed.download_source.as_ref().is_some_and(repo_ok),
            };
            let candidate_source_ok = match &candidate.runtime_package {
                Some(package) => package_ok(package, &candidate.version),
                None => candidate.download_source.as_ref().is_some_and(repo_ok),
            };
            if !executable
                .file_name()
                .is_some_and(|name| name.eq_ignore_ascii_case("node.exe"))
                || definition.executable_sha256.as_deref() != Some(actual.as_str())
                || !original_source_ok
                || !candidate_source_ok
                || !cli_arg
            {
                return Err("动作依赖未核实的外部运行环境，需先核对固定适配器".into());
            }
        }
        definition.working_directory = rebase(&definition.working_directory, &old, &new)?;
        definition.executable_sha256 =
            Some(resource_files::fingerprint(Path::new(&definition.executable))?.sha256);
        for arg in &mut definition.args {
            if let crate::resource_runtime::Argument::Literal { value } = arg {
                if Path::new(value).is_absolute() {
                    *value = rebase(value, &old, &new)?;
                }
            }
        }
        crate::resource_adapters::rebind_candidate(record, &new, &mut definition)?;
        *action = json!(definition);
    }
    Ok(actions)
}
pub(crate) fn validate_candidate_with(
    m: &Manager,
    id: &str,
    adapter: &str,
    probe: impl FnOnce(&ValidationTarget) -> Result<(), String>,
) -> Result<Value, String> {
    normal(m)?;
    if adapter.is_empty() || adapter.len() > 160 || adapter.chars().any(char::is_control) {
        return Err("缺少可信隔离验证适配器标识".into());
    }
    let mut record = read(m, id)?;
    let staged = candidate(&record)?.clone();
    switch_eligible(m, &record, &staged)?;
    let before = inventory_registered(&staged.root, staged.resource_manifest.as_ref())?;
    let root_id = crate::clients::file_identity(&staged.root)?;
    let actions = new_actions(&record, &staged)?;
    let executables = external_executables(&actions, &staged.root)?;
    // A new failed probe cannot leave the earlier success as current evidence.
    if staged.validation.is_some() {
        record
            .installation
            .as_mut()
            .and_then(|i| i.update_state.as_mut())
            .and_then(|s| s.candidate.as_mut())
            .ok_or("候选已失效")?
            .validation = None;
        record = save_record(m, record)?;
    }
    let target = ValidationTarget {
        root: staged.root.clone(),
        version: staged.version.clone(),
        files: staged.files.clone(),
        actions: actions.clone(),
    };
    probe(&target)?;
    // Probe work cannot silently grant itself a changed configuration/version.
    let latest = read(m, id)?;
    if json!(latest) != json!(record) {
        return Err("验证期间资源记录已变化，本次验证不生效".into());
    }
    switch_eligible(m, &record, &staged)?;
    if external_executables(&actions, &staged.root)? != executables {
        return Err("验证期间共享执行环境对象或文件已变化，本次验证不生效".into());
    }
    if before != inventory_registered(&staged.root, staged.resource_manifest.as_ref())?
        || root_id != crate::clients::file_identity(&staged.root)?
    {
        return Err("验证期间候选发生变化，本次验证不生效".into());
    }
    record
        .installation
        .as_mut()
        .and_then(|i| i.update_state.as_mut())
        .and_then(|s| s.candidate.as_mut())
        .ok_or("候选已失效")?
        .validation = Some(Validation {
        adapter: adapter.into(),
        verified_at: now(),
        candidate_root_identity: root_id,
        files: before,
        actions,
        external_executables: executables,
        resource_manifest: staged.resource_manifest.clone(),
        runtime_package: staged.runtime_package.clone(),
    });
    let saved = save_record(m, record)?;
    Ok(json!({"resource":saved,"verified":true,"scope":"isolatedCapabilityProbe","switched":false}))
}
fn verified(m: &Manager, record: &ResourceRecord) -> Result<(), String> {
    let staged = candidate(record)?;
    switch_eligible(m, record, staged)?;
    let proof = staged
        .validation
        .as_ref()
        .ok_or("候选尚无实际隔离能力验证，不能切换；文件摘要不等于运行能力")?;
    if proof.files != inventory_registered(&staged.root, staged.resource_manifest.as_ref())?
        || proof.candidate_root_identity != crate::clients::file_identity(&staged.root)?
        || proof.actions != new_actions(record, staged)?
        || proof.external_executables != external_executables(&proof.actions, &staged.root)?
        || proof.resource_manifest != staged.resource_manifest
        || json!(proof.runtime_package) != json!(staged.runtime_package)
    {
        return Err("隔离验证已失效，候选文件或入口发生变化".into());
    }
    Ok(())
}
fn preview_switch(m: &mut Manager, request: &Value) -> Result<Value, String> {
    normal(m)?;
    allowed(request, &["action", "id", "expectedRevision"])?;
    let record = read(m, text(request, "id", 64)?)?;
    if request["expectedRevision"].as_u64() != Some(record.revision) {
        return Err("资源已变化，请重新核对切换".into());
    }
    let staged = candidate(&record)?;
    let error = verified(m, &record).err();
    let id = uuid::Uuid::new_v4().to_string();
    let public = json!({"id":id,"kind":"resourceUpdateSwitch","resourceId":record.id,"resourceRevision":record.revision,"originalPath":record.root_path,"targetPath":staged.root,"version":staged.version,"canApply":error.is_none(),"warnings":error.into_iter().collect::<Vec<_>>(),"previousVersionRetained":true});
    Ok(remember(m, "resourceUpdateSwitch", public, json!(record)))
}
struct SwitchGuard {
    original: Baseline,
    old_file_ids: BTreeMap<String, String>,
    candidate_root: PathBuf,
    candidate_root_id: String,
    candidate_files: BTreeMap<String, Fingerprint>,
    candidate_file_ids: BTreeMap<String, String>,
    candidate_manifest: Option<crate::resource_manifest::ManifestRecord>,
    external: BTreeMap<PathBuf, (Fingerprint, String)>,
}
fn file_ids(
    root: &Path,
    files: &BTreeMap<String, Fingerprint>,
) -> Result<BTreeMap<String, String>, String> {
    files
        .keys()
        .map(|relative| {
            let path = crate::local::safe_join(root, relative)?;
            Ok((relative.clone(), crate::clients::file_identity(&path)?))
        })
        .collect()
}
impl SwitchGuard {
    fn capture(record: &ResourceRecord, staged: &Candidate) -> Result<Self, String> {
        let proof = staged.validation.as_ref().ok_or("缺少切换前能力验证")?;
        let mut external = BTreeMap::new();
        let old_root = crate::local::canonical(&staged.original.root)?;
        for action in &record.actions {
            let definition: crate::resource_runtime::ActionDefinition =
                serde_json::from_value(action.clone()).map_err(|_| "动作定义无效")?;
            let path = crate::local::canonical(Path::new(&definition.executable))?;
            if !nested(&path, &old_root) {
                let hash = resource_files::fingerprint(&path)?;
                if definition.executable_sha256.as_deref() != Some(hash.sha256.as_str()) {
                    return Err("外部执行环境已变化，切换保持原版".into());
                }
                external.insert(path.clone(), (hash, crate::clients::file_identity(&path)?));
            }
        }
        Ok(Self {
            old_file_ids: file_ids(&staged.original.root, &staged.original.files)?,
            candidate_file_ids: file_ids(&staged.root, &proof.files)?,
            candidate_manifest: staged.resource_manifest.clone(),
            original: staged.original.clone(),
            candidate_root: staged.root.clone(),
            candidate_root_id: proof.candidate_root_identity.clone(),
            candidate_files: proof.files.clone(),
            external,
        })
    }
    fn verify(&self, m: &Manager, expected: &ResourceRecord) -> Result<(), String> {
        if json!(read(m, &expected.id)?) != json!(expected) {
            return Err("切换后资源记录、策略或入口已变化".into());
        }
        if relations(m, &expected.id)? != self.original.relations {
            return Err("切换后使用关系已变化".into());
        }
        if crate::clients::file_identity(&self.original.root)? != self.original.root_identity
            || inventory_registered(
                &self.original.root,
                self.original.resource_manifest.as_ref(),
            )? != self.original.files
            || file_ids(&self.original.root, &self.original.files)? != self.old_file_ids
        {
            return Err("切换后原版本目录或文件已变化".into());
        }
        if crate::clients::file_identity(&self.candidate_root)? != self.candidate_root_id
            || inventory_registered(&self.candidate_root, self.candidate_manifest.as_ref())?
                != self.candidate_files
            || file_ids(&self.candidate_root, &self.candidate_files)? != self.candidate_file_ids
        {
            return Err("切换后候选目录或文件已变化".into());
        }
        for (path, (fingerprint, identity)) in &self.external {
            if resource_files::fingerprint(path)? != *fingerprint
                || crate::clients::file_identity(path)? != *identity
            {
                return Err("切换后共享执行环境已变化".into());
            }
        }
        if m.resource_runtime.snapshot(Some(&expected.id))?["runs"]
            .as_array()
            .is_some_and(|runs| runs.iter().any(|run| run["status"] == "running"))
        {
            return Err("资源已开始运行，不能自动改写当前入口".into());
        }
        Ok(())
    }
}
fn switch_with(
    m: &Manager,
    request: &Value,
    post_probe: impl FnOnce(&ResourceRecord, &ResourceRecord) -> Result<ProbeEvidence, String>,
    restored_probe: impl FnOnce(&ResourceRecord) -> Result<ProbeEvidence, String>,
) -> Result<Value, String> {
    normal(m)?;
    let original: ResourceRecord =
        serde_json::from_value(request.clone()).map_err(|e| e.to_string())?;
    let mut current = read(m, &original.id)?;
    if json!(current) != json!(original) {
        return Err("切换预览后资源已变化，旧确认失效".into());
    }
    verified(m, &current)?;
    let old_install = installation(&current)?.clone();
    let staged = candidate(&current)?.clone();
    let actions = new_actions(&current, &staged)?;
    let guard = SwitchGuard::capture(&current, &staged)?;
    let mut state = old_install.update_state.clone().unwrap_or_default();
    state.candidate = None;
    state.last_failure = None;
    state.last_validation = staged.validation.clone();
    state.switch_check = Some(SwitchCheck {
        attempt_id: uuid::Uuid::new_v4().to_string(),
        status: "pending".into(),
        checked_at: now(),
        adapter: None,
        verified_scopes: vec![],
        error: None,
    });
    state.previous.push(PreviousRuntime {
        root: PathBuf::from(&current.root_path),
        version: current.version.clone(),
        archive_path: old_install.archive_path,
        archive_sha256: old_install.archive_sha256,
        source_repository: old_install.source_repository,
        source_version: old_install.source_version,
        download_source: old_install.download_source,
        runtime_package: old_install.runtime_package,
        resource_manifest: old_install.resource_manifest,
        files: old_install.files,
        retained_repair_files: old_install.retained_repair_files,
        actions: current.actions.clone(),
        retained_at: now(),
        reason: "上一工作运行版本原位保留；再次轮换不自动删除历史版本或私人依赖".into(),
    });
    current.root_path = display(&staged.root);
    current.version = Some(staged.version.clone());
    current.actions = actions;
    current.installation = Some(InstallationRecord {
        schema_version: 1,
        installed_at: now(),
        archive_path: display(&staged.archive_path),
        archive_sha256: staged.archive_sha256,
        source_repository: staged
            .download_source
            .as_ref()
            .map(|s| s.repository.clone())
            .or(current.repository.clone()),
        source_version: Some(staged.version),
        download_source: staged.download_source,
        runtime_package: staged.runtime_package,
        files: staged.files,
        status: "installed".into(),
        error: None,
        pending_repair: None,
        retained_repair_files: vec![],
        update_state: Some(state),
        system_entries: old_install.system_entries,
        removal_state: old_install.removal_state,
        resource_manifest: staged.resource_manifest,
    });
    for capability in &mut current.capabilities {
        capability["historicalEvidence"] = capability.clone();
        capability["status"] = json!("unverified");
        capability["verifiedAt"] = Value::Null;
        capability["reason"] = json!("运行版本已切换，原能力证据保留为历史；隔离验证单独记录");
    }
    // The exact final candidate path is already validated; no environment relocation occurs.
    let saved = save_record(m, current)?;
    let outcome = guard
        .verify(m, &saved)
        .and_then(|_| post_probe(&original, &saved))
        .and_then(|evidence| {
            guard.verify(m, &saved)?;
            Ok(evidence)
        });
    match outcome {
        Ok(evidence) => {
            let mut complete = saved.clone();
            complete
                .installation
                .as_mut()
                .and_then(|i| i.update_state.as_mut())
                .ok_or("切换记录缺失")?
                .switch_check = Some(SwitchCheck {
                attempt_id: switch_attempt(&saved).unwrap_or_default().into(),
                status: "passed".into(),
                checked_at: now(),
                adapter: Some(evidence.adapter),
                verified_scopes: evidence.verified_scopes,
                error: None,
            });
            match save_record(m, complete) {
                Ok(complete) => Ok(
                    json!({"resource":complete,"complete":true,"switched":true,"postSwitchVerified":true,
                    "platformCallsVerified":false,"userSessionVerified":false,"previousVersionRetained":true,"dataCopied":false}),
                ),
                Err(_) => switch_failure(
                    m,
                    &original,
                    &saved,
                    &guard,
                    "切换后的验证记录未能按原修订号保存".into(),
                    restored_probe,
                ),
            }
        }
        Err(error) => switch_failure(m, &original, &saved, &guard, error, restored_probe),
    }
}

fn switch_failure(
    m: &Manager,
    original: &ResourceRecord,
    expected: &ResourceRecord,
    guard: &SwitchGuard,
    error: String,
    restored_probe: impl FnOnce(&ResourceRecord) -> Result<ProbeEvidence, String>,
) -> Result<Value, String> {
    let live = read(m, &expected.id)?;
    let blocked = guard.verify(m, expected).err();
    if blocked.is_none() && json!(live) == json!(expected) {
        let mut restored = original.clone();
        restored.revision = live.revision;
        for capability in &mut restored.capabilities {
            capability["historicalEvidence"] = capability.clone();
            capability["status"] = json!("unverified");
            capability["verifiedAt"] = Value::Null;
            capability["reason"] = json!("原入口恢复后需要重新核验；原能力证据保留为历史");
        }
        let state = restored
            .installation
            .as_mut()
            .and_then(|i| i.update_state.as_mut())
            .ok_or("原版本恢复记录缺失")?;
        state.last_failure = Some(error.clone());
        if let Some(candidate) = state.candidate.as_mut() {
            candidate.validation = None;
        }
        state.switch_check = Some(SwitchCheck {
            attempt_id: switch_attempt(expected).unwrap_or_default().into(),
            status: "rollbackPending".into(),
            checked_at: now(),
            adapter: None,
            verified_scopes: vec![],
            error: Some(error.clone()),
        });
        let restored = match save_record(m, restored) {
            Ok(restored) => restored,
            Err(_) => {
                return rollback_blocked(
                    m,
                    expected,
                    &guard.original.root,
                    error,
                    "恢复前资源修订已变化".into(),
                )
            }
        };
        if let Err(reason) = guard.verify(m, &restored) {
            return rollback_blocked(m, &restored, &guard.original.root, error, reason);
        }
        let evidence = restored_probe(&restored)
            .map_err(|reason| format!("恢复入口后的只读自检未通过：{reason}"))
            .and_then(|evidence| {
                guard.verify(m, &restored)?;
                Ok(evidence)
            });
        let evidence = match evidence {
            Ok(evidence) => evidence,
            Err(reason) => {
                return rollback_blocked(m, &restored, &guard.original.root, error, reason)
            }
        };
        let mut complete = restored.clone();
        let check = complete
            .installation
            .as_mut()
            .and_then(|i| i.update_state.as_mut())
            .and_then(|s| s.switch_check.as_mut())
            .ok_or("恢复记录缺失")?;
        check.status = "rolledBack".into();
        check.adapter = Some(evidence.adapter);
        check.verified_scopes = evidence.verified_scopes;
        return match save_record(m, complete) {
            Ok(complete) => Ok(
                json!({"resource":complete,"complete":false,"switched":false,"postSwitchVerified":false,
                "rolledBack":true,"entryRestored":true,"rollbackVerified":true,"rollbackScope":"entrypointFilesAndReadOnlyProbe","error":error,"previousVersionRetained":true,"dataCopied":false}),
            ),
            Err(_) => rollback_blocked(
                m,
                &restored,
                &guard.original.root,
                error,
                "恢复后的核验记录未能按原修订号保存".into(),
            ),
        };
    }
    rollback_blocked(
        m,
        expected,
        &guard.original.root,
        error,
        blocked.unwrap_or_else(|| "恢复前资源记录已变化".into()),
    )
}
fn switch_attempt(record: &ResourceRecord) -> Option<&str> {
    record
        .installation
        .as_ref()?
        .update_state
        .as_ref()?
        .switch_check
        .as_ref()
        .map(|check| check.attempt_id.as_str())
        .filter(|id| !id.is_empty())
}
fn rollback_blocked(
    m: &Manager,
    expected: &ResourceRecord,
    original_root: &Path,
    error: String,
    reason: String,
) -> Result<Value, String> {
    let mut live = read(m, &expected.id)?;
    let entry_restored = key(Path::new(&live.root_path)) == key(original_root);
    // Add only this attempt's journal to the latest record, retaining concurrent
    // notes/policy changes. A changed version/root/attempt is never rewritten.
    if switch_attempt(&live).is_some()
        && switch_attempt(&live) == switch_attempt(expected)
        && key(Path::new(&live.root_path)) == key(Path::new(&expected.root_path))
        && live.version == expected.version
    {
        if let Some(state) = live
            .installation
            .as_mut()
            .and_then(|i| i.update_state.as_mut())
        {
            state.last_failure = Some(error.clone());
            state.switch_check = Some(SwitchCheck {
                attempt_id: switch_attempt(expected).unwrap_or_default().into(),
                status: if entry_restored {
                    "rollbackUnverified"
                } else {
                    "rollbackBlocked"
                }
                .into(),
                checked_at: now(),
                adapter: None,
                verified_scopes: vec![],
                error: Some(format!("{error}；{reason}")),
            });
            live = match save_record(m, live) {
                Ok(saved) => saved,
                Err(_) => read(m, &expected.id)?,
            };
        }
    }
    let switched = key(Path::new(&live.root_path)) != key(original_root);
    Ok(
        json!({"resource":live,"complete":false,"switched":switched,"postSwitchVerified":false,"rolledBack":false,"entryRestored":!switched,"rollbackVerified":false,"error":error,"rollbackBlockedReason":reason,
        "warning":if switched {"检测到状态变化，不能确认安全回退；保留当前真实入口和两个原位目录，未复制或删除文件"} else {"原入口已恢复，运行自检未完成；保留两个原位目录，请核对恢复记录"},"dataCopied":false}),
    )
}

fn preview_abandon(m: &mut Manager, request: &Value) -> Result<Value, String> {
    normal(m)?;
    allowed(request, &["action", "id", "expectedRevision"])?;
    let record = read(m, text(request, "id", 64)?)?;
    if request["expectedRevision"].as_u64() != Some(record.revision) {
        return Err("资源记录已变化，请重新核对候选版本".into());
    }
    let staged = record
        .installation
        .as_ref()
        .and_then(|i| i.update_state.as_ref())
        .and_then(|s| s.candidate.as_ref())
        .ok_or("没有待处理候选版本")?;
    let id = uuid::Uuid::new_v4().to_string();
    let public = json!({"id":id,"kind":"resourceUpdateAbandon","resourceId":record.id,
        "resourceRevision":record.revision,"originalPath":record.root_path,"targetPath":staged.root,
        "version":staged.version,"createdPaths":staged.created_paths,"canApply":true,
        "warnings":["只结束本次候选流程；候选文件、部分写入路径、归属及验证记录全部原位保留。",
            "当前运行版本保持；如需重新准备，请另选新的版本目录。本操作不清理文件。"]});
    Ok(remember(m, "resourceUpdateAbandon", public, json!(record)))
}

fn abandon(m: &Manager, prepared: &Value) -> Result<Value, String> {
    let original: ResourceRecord =
        serde_json::from_value(prepared.clone()).map_err(|e| e.to_string())?;
    let mut record = read(m, &original.id)?;
    if json!(record) != json!(original) {
        return Err("预览后候选或资源记录已变化，原确认失效".into());
    }
    let state = record
        .installation
        .as_mut()
        .and_then(|i| i.update_state.as_mut())
        .ok_or("候选记录已不存在")?;
    let candidate = state.candidate.take().ok_or("候选记录已不存在")?;
    state.retained_candidates.push(RetainedCandidate {
        candidate,
        retained_at: now(),
        reason: "已按本次确认结束候选流程，文件和归属原位保留；未作为工作运行版本启用".into(),
    });
    state.last_failure = None;
    let saved = save_record(m, record)?;
    Ok(
        json!({"resource":saved,"complete":true,"abandoned":true,"switched":false,
        "deleted":[],"filesRetained":true}),
    )
}

pub(crate) fn handle(m: &mut Manager, request: &Value) -> Result<Option<Value>, String> {
    Ok(Some(match request["action"].as_str().unwrap_or_default() {
        "preview_resource_update" => preview_stage(m, request)?,
        "preview_resource_update_switch" => preview_switch(m, request)?,
        "preview_resource_update_abandon" => preview_abandon(m, request)?,
        "resource_update_state" => {
            allowed(request, &["action", "id"])?;
            let record = read(m, text(request, "id", 64)?)?;
            json!({"resource":record,"updateState":record.installation.as_ref().and_then(|i|i.update_state.as_ref())})
        }
        _ => return Ok(None),
    }))
}
pub(crate) fn apply_local(m: &mut Manager, request: &Value) -> Result<Option<Value>, String> {
    let probe_temporary_root = m.storage.path("temp")?;
    apply_local_with(
        m,
        request,
        |original, installed| {
            crate::resource_probe::verify_switched(original, installed, &probe_temporary_root)
        },
        |restored| crate::resource_probe::verify_restored(restored, &probe_temporary_root),
    )
}
fn apply_local_with(
    m: &mut Manager,
    request: &Value,
    post_probe: impl FnOnce(&ResourceRecord, &ResourceRecord) -> Result<ProbeEvidence, String>,
    restored_probe: impl FnOnce(&ResourceRecord) -> Result<ProbeEvidence, String>,
) -> Result<Option<Value>, String> {
    let kind = match request["action"].as_str().unwrap_or_default() {
        "apply_resource_update_stage" => "resourceUpdateStage",
        "apply_resource_update_switch" => "resourceUpdateSwitch",
        "apply_resource_update_abandon" => "resourceUpdateAbandon",
        _ => return Ok(None),
    };
    normal(m)?;
    allowed(request, &["action", "previewId"])?;
    let id = text(request, "previewId", 64)?;
    let saved = m.previews.get(id).ok_or("更新预览已失效，请重新核对")?;
    if saved["kind"] != kind
        || saved["public"]["canApply"] != true
        || !saved["createdAt"]
            .as_i64()
            .is_some_and(|t| chrono::Utc::now().timestamp_millis() - t <= 600_000)
    {
        return Err("预览类型无效、不能应用或已过期".into());
    }
    let saved = m.previews.remove(id).ok_or("更新预览已消费")?;
    Ok(Some(if kind == "resourceUpdateStage" {
        stage(
            m,
            serde_json::from_value(saved["prepared"].clone()).map_err(|e| e.to_string())?,
        )?
    } else if kind == "resourceUpdateSwitch" {
        switch_with(m, &saved["prepared"], post_probe, restored_probe)?
    } else {
        abandon(m, &saved["prepared"])?
    }))
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod package_tests;
