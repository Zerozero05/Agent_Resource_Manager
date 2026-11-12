//! A small resource-side index, never an execution/deletion grant or a copy of
//! configuration, login data, source code or a prior manifest.
use crate::resource_files::{self, FileRole, Fingerprint, OwnedFile};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

pub(crate) const NAME: &str = ".agent-resource.json";
const MAX_BYTES: u64 = 8 * 1024 * 1024;
const MAX_FILES: usize = 50_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManifestRecord {
    pub relative_path: String,
    pub sha256: String,
    pub bytes: u64,
    pub file_id: String,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManifestSource {
    pub repository: Option<String>,
    pub repository_id: Option<u64>,
    pub release_id: Option<u64>,
    pub asset_id: Option<u64>,
    pub asset_name: Option<String>,
    pub archive_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_package: Option<RuntimePackageSource>,
}

/// Portable provenance omits every local builder, download and profile path.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RuntimePackageSource {
    recipe: crate::resource_package::Recipe,
    version: String,
    plan_hash: String,
    artifacts: Vec<RuntimeArtifact>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeArtifact {
    origin: crate::resource_package::ArtifactOrigin,
    bytes: u64,
    sha256: String,
}
impl PartialEq for RuntimePackageSource {
    fn eq(&self, other: &Self) -> bool {
        serde_json::to_value(self).ok() == serde_json::to_value(other).ok()
    }
}
impl Eq for RuntimePackageSource {}
impl RuntimePackageSource {
    pub(crate) fn from_provenance(
        value: &crate::resource_package::RuntimePackageProvenance,
    ) -> Result<Self, String> {
        value.validate_source()?;
        Ok(Self {
            recipe: value.recipe.clone(),
            version: value.version.clone(),
            plan_hash: value.plan_hash.clone(),
            artifacts: value
                .source_artifacts
                .iter()
                .map(|artifact| RuntimeArtifact {
                    origin: artifact.origin.clone(),
                    bytes: artifact.file.bytes,
                    sha256: artifact.file.sha256.clone(),
                })
                .collect(),
        })
    }
    fn validate(&self) -> Result<(), String> {
        if !text(&self.version, 160)
            || absolute_value(&self.version)
            || !valid_hash(&self.plan_hash)
            || self.artifacts.is_empty()
            || self.artifacts.len() > 129
        {
            return Err("运行包来源投影格式无效".into());
        }
        for artifact in &self.artifacts {
            if artifact.bytes == 0 || !valid_hash(&artifact.sha256) {
                return Err("运行包来源资产摘要无效".into());
            }
            // Readback is informational. It never recreates the private session,
            // installation ownership or permission to execute these packages.
            let source = serde_json::to_value(&artifact.origin).map_err(|e| e.to_string())?;
            if source.to_string().len() > 16 * 1024 {
                return Err("运行包来源资产过长".into());
            }
            match &artifact.origin {
                crate::resource_package::ArtifactOrigin::GithubRelease { source } => {
                    crate::resources::repository(&json!({"repository":source.repository}))?
                        .ok_or("运行包缺少 GitHub 来源仓库")?;
                    public_artifact_url(&source.download_url, "github.com")?;
                }
                crate::resource_package::ArtifactOrigin::NpmRegistry {
                    registry,
                    repository,
                    tarball,
                    ..
                } => {
                    public_artifact_url(registry, "registry.npmjs.org")?;
                    public_artifact_url(tarball, "registry.npmjs.org")?;
                    crate::resources::repository(&json!({"repository":repository}))?
                        .ok_or("运行包缺少 npm 来源仓库")?;
                }
                crate::resource_package::ArtifactOrigin::PyPiWheel { url, .. } => {
                    public_artifact_url(url, "files.pythonhosted.org")?;
                }
            }
        }
        Ok(())
    }
}

fn public_artifact_url(value: &str, expected_host: &str) -> Result<(), String> {
    if !text(value, 4096) || value.chars().any(char::is_whitespace) {
        return Err("运行包来源地址无效".into());
    }
    let url = url::Url::parse(value).map_err(|_| "运行包来源地址无效")?;
    if url.scheme() != "https"
        || url.host_str() != Some(expected_host)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("运行包来源仅接受对应官方 HTTPS 地址，不能含凭据、查询参数或片段".into());
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManifestFile {
    path: String,
    role: FileRole,
    sha256: String,
    bytes: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document {
    schema_version: u32,
    resource_id: String,
    installation_id: String,
    kind: String,
    version: Option<String>,
    created_at: String,
    complete: bool,
    source: Option<ManifestSource>,
    files: Vec<ManifestFile>,
}
pub(crate) struct PreparedManifest {
    document: Document,
    payload: Vec<u8>,
    excluded_protected_files: usize,
}
impl PreparedManifest {
    pub(crate) fn preview(&self, root: &Path) -> Value {
        json!({"relativePath":NAME,"targetPath":root.join(NAME),"sha256":digest(&self.payload),"bytes":self.payload.len(),"verifiedFileCount":self.document.files.len(),"excludedProtectedFiles":self.excluded_protected_files,"complete":self.document.complete,"executionGrant":false,"deleteGrant":false,"automaticUpdateGrant":false})
    }
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
fn text(value: &str, maximum: usize) -> bool {
    !value.trim().is_empty() && value.len() <= maximum && !value.chars().any(char::is_control)
}
fn absolute_value(value: &str) -> bool {
    Path::new(value).is_absolute()
        || value.starts_with("\\\\")
        || value.as_bytes().get(1) == Some(&b':')
            && value
                .as_bytes()
                .get(2)
                .is_some_and(|c| *c == b'/' || *c == b'\\')
}
fn runtime_role(role: &FileRole) -> bool {
    matches!(
        role,
        FileRole::Runtime | FileRole::PrivateDependency | FileRole::License
    )
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
fn normal_root(root: &Path) -> Result<(), String> {
    crate::transaction::verify_root(root)?;
    if !fs::symlink_metadata(root).is_ok_and(|m| m.is_dir() && !linked(&m)) {
        return Err("资源目录不是可核验的真实目录".into());
    }
    Ok(())
}
fn path(root: &Path) -> Result<PathBuf, String> {
    normal_root(root)?;
    crate::local::safe_join(root, NAME)
}
fn validate_source(source: &ManifestSource) -> Result<(), String> {
    if let Some(package) = &source.runtime_package {
        package.validate()?;
    }
    if let Some(repository) = &source.repository {
        let normalized = crate::resources::repository(&json!({"repository":repository}))?
            .ok_or("来源地址无效")?;
        if &normalized != repository {
            return Err("管理记录只保存规范仓库地址".into());
        }
    } else if source.repository_id.is_some()
        || source.release_id.is_some()
        || source.asset_id.is_some()
        || source.asset_name.is_some()
    {
        return Err("发行身份缺少对应仓库".into());
    }
    if [source.repository_id, source.release_id, source.asset_id]
        .into_iter()
        .flatten()
        .any(|id| id == 0)
        || source
            .asset_name
            .as_ref()
            .is_some_and(|name| !text(name, 240) || name.contains(['/', '\\', ':']))
        || source
            .archive_sha256
            .as_ref()
            .is_some_and(|hash| !valid_hash(hash))
    {
        return Err("来源摘要包含无效字段".into());
    }
    Ok(())
}
fn validate(document: &Document) -> Result<(), String> {
    if document.schema_version != 1
        || !text(&document.resource_id, 64)
        || document.resource_id.contains(['/', '\\', ':'])
        || uuid::Uuid::parse_str(&document.installation_id).is_err()
        || !matches!(document.kind.as_str(), "cli" | "portable" | "mcp")
        || document
            .version
            .as_ref()
            .is_some_and(|v| !text(v, 160) || absolute_value(v))
        || chrono::DateTime::parse_from_rfc3339(&document.created_at).is_err()
        || document.files.len() > MAX_FILES
    {
        return Err("资源侧管理记录格式无效".into());
    }
    if let Some(source) = &document.source {
        validate_source(source)?;
    }
    let mut names = BTreeSet::new();
    for file in &document.files {
        crate::local::validate_relative_path(&file.path)?;
        if file.path.eq_ignore_ascii_case(NAME)
            || !runtime_role(&file.role)
            || !valid_hash(&file.sha256)
            || !names.insert(file.path.to_lowercase())
        {
            return Err("管理记录文件范围包含重复、受保护或无效条目".into());
        }
    }
    if document.complete
        && !document
            .files
            .iter()
            .any(|file| file.role == FileRole::Runtime)
    {
        return Err("完整管理记录缺少已核验运行文件".into());
    }
    Ok(())
}
fn bytes(document: &Document) -> Result<Vec<u8>, String> {
    validate(document)?;
    let payload = serde_json::to_vec_pretty(document).map_err(|e| e.to_string())?;
    if payload.len() as u64 > MAX_BYTES {
        return Err("资源侧管理记录过大".into());
    }
    Ok(payload)
}
fn parse(payload: &[u8]) -> Result<Document, String> {
    if payload.len() as u64 > MAX_BYTES {
        return Err("资源侧管理记录超出读取范围".into());
    }
    let value: Document =
        serde_json::from_slice(payload).map_err(|_| "资源侧管理记录无法解析，未授予任何权限")?;
    validate(&value)?;
    Ok(value)
}
fn verify_files(root: &Path, document: &Document) -> Result<(), String> {
    normal_root(root)?;
    for file in &document.files {
        let actual = resource_files::fingerprint(&crate::local::safe_join(root, &file.path)?)?;
        if actual.bytes != file.bytes || !actual.sha256.eq_ignore_ascii_case(&file.sha256) {
            return Err(format!("运行文件已变化，管理记录未写入：{}", file.path));
        }
    }
    Ok(())
}
/// Reads only the explicit receipt's runtime files. Configuration, user data,
/// cache and local-modification entries never enter this portable projection.
pub(crate) fn prepare(
    root: &Path,
    resource_id: &str,
    kind: &str,
    version: Option<&str>,
    source: Option<ManifestSource>,
    files: &[OwnedFile],
    complete: bool,
) -> Result<PreparedManifest, String> {
    normal_root(root)?;
    let mut verified = Vec::new();
    let mut excluded = 0;
    for file in files {
        if !runtime_role(&file.role) {
            excluded += 1;
            continue;
        }
        let actual = resource_files::fingerprint(&crate::local::safe_join(root, &file.path)?)?;
        if !actual.sha256.eq_ignore_ascii_case(&file.installed_sha256) {
            return Err(format!("运行文件与本次回执不符：{}", file.path));
        }
        verified.push(ManifestFile {
            path: file.path.clone(),
            role: file.role.clone(),
            sha256: actual.sha256,
            bytes: actual.bytes,
        });
    }
    verified.sort_by(|a, b| a.path.cmp(&b.path));
    let document = Document {
        schema_version: 1,
        resource_id: resource_id.into(),
        installation_id: uuid::Uuid::new_v4().to_string(),
        kind: kind.into(),
        version: version.map(str::to_owned),
        created_at: crate::model::now(),
        complete,
        source,
        files: verified,
    };
    let payload = bytes(&document)?;
    Ok(PreparedManifest {
        document,
        payload,
        excluded_protected_files: excluded,
    })
}
fn options(write: bool, create: bool) -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true).write(write).create_new(create);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1).custom_flags(0x0020_0000);
    }
    options
}
fn one_link(file: &File) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        let mut info: windows_sys::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION =
            unsafe { std::mem::zeroed() };
        if unsafe {
            windows_sys::Win32::Storage::FileSystem::GetFileInformationByHandle(
                file.as_raw_handle() as _,
                &mut info,
            )
        } == 0
        {
            return Err("无法核验管理记录文件身份".into());
        }
        if info.nNumberOfLinks != 1 {
            return Err("管理记录具有其他硬链接，未修改".into());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if file.metadata().map_err(|e| e.to_string())?.nlink() != 1 {
            return Err("管理记录具有其他硬链接，未修改".into());
        }
    }
    Ok(())
}
fn read_handle(file: &mut File) -> Result<Vec<u8>, String> {
    if !file
        .metadata()
        .is_ok_and(|m| m.is_file() && !linked(&m) && m.len() <= MAX_BYTES)
    {
        return Err("管理记录不是受限大小的普通文件".into());
    }
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut payload = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut payload)
        .map_err(|e| e.to_string())?;
    if payload.len() as u64 > MAX_BYTES {
        return Err("管理记录读取期间超出大小范围".into());
    }
    Ok(payload)
}
fn record(root: &Path, payload: &[u8]) -> Result<ManifestRecord, String> {
    let target = path(root)?;
    let actual = resource_files::fingerprint(&target)?;
    if actual.bytes != payload.len() as u64 || actual.sha256 != digest(payload) {
        return Err("管理记录写后核验失败；文件保留，未宣告完成".into());
    }
    Ok(ManifestRecord {
        relative_path: NAME.into(),
        sha256: actual.sha256,
        bytes: actual.bytes,
        file_id: crate::clients::file_identity(&target)?,
    })
}
pub(crate) fn write_new(
    root: &Path,
    prepared: &PreparedManifest,
) -> Result<ManifestRecord, String> {
    validate(&prepared.document)?;
    verify_files(root, &prepared.document)?;
    let target = path(root)?;
    let mut file = options(true, true)
        .open(&target)
        .map_err(|_| "资源目录已有同名对象或不可写；未覆盖管理记录")?;
    one_link(&file)?;
    file.write_all(&prepared.payload)
        .and_then(|_| file.sync_all())
        .map_err(|_| "管理记录写入未完整完成，已产生的文件保留")?;
    if read_handle(&mut file)? != prepared.payload {
        return Err("管理记录写后内容不符，文件保留".into());
    }
    record(root, &prepared.payload)
}
fn validate_expected(root: &Path, expected: &ManifestRecord, payload: &[u8]) -> Result<(), String> {
    if expected.relative_path != NAME
        || !valid_hash(&expected.sha256)
        || expected.bytes > MAX_BYTES
        || !text(&expected.file_id, 512)
        || expected.bytes != payload.len() as u64
        || !expected.sha256.eq_ignore_ascii_case(&digest(payload))
        || crate::clients::file_identity(&path(root)?)? != expected.file_id
    {
        return Err("已登记管理记录的内容或对象身份已变化，未修改或跳过该文件".into());
    }
    parse(payload)?;
    Ok(())
}
pub(crate) fn validate_owned(root: &Path, expected: &ManifestRecord) -> Result<(), String> {
    let target = path(root)?;
    let mut file = options(false, false)
        .open(&target)
        .map_err(|_| "已登记管理记录不可读取")?;
    one_link(&file)?;
    let payload = read_handle(&mut file)?;
    validate_expected(root, expected, &payload)
}
/// Inventory exclusion always verifies the registered object and bytes first.
/// An unknown same-name object remains part of the normal unknown-file check.
pub(crate) fn is_registered_path(
    root: &Path,
    relative: &str,
    expected: Option<&ManifestRecord>,
) -> Result<bool, String> {
    let Some(expected) = expected.filter(|record| relative == NAME && record.relative_path == NAME)
    else {
        return Ok(false);
    };
    validate_owned(root, expected)?;
    Ok(true)
}
pub(crate) fn registered_file(
    root: &Path,
    expected: &ManifestRecord,
) -> Result<(PathBuf, Fingerprint), String> {
    validate_owned(root, expected)?;
    let target = path(root)?;
    let actual = resource_files::fingerprint(&target)?;
    if actual.sha256 != expected.sha256 || actual.bytes != expected.bytes {
        return Err("管理记录在核对期间变化".into());
    }
    Ok((target, actual))
}
/// Windows keeps a handle denying other writes and replacement throughout CAS.
/// This changes only the single current JSON; a failed write is reported as an
/// incomplete metadata update, never as a rollback or a reason to touch runtime data.
pub(crate) fn update_owned(
    root: &Path,
    expected: &ManifestRecord,
    prepared: &PreparedManifest,
) -> Result<ManifestRecord, String> {
    #[cfg(not(windows))]
    {
        let _ = (root, expected, prepared);
        return Err("当前平台尚未实现持有排他句柄的管理记录更新，原记录保留".into());
    }
    #[cfg(windows)]
    {
        verify_files(root, &prepared.document)?;
        let target = path(root)?;
        let mut file = options(true, false)
            .open(&target)
            .map_err(|_| "无法独占已登记管理记录，未修改")?;
        one_link(&file)?;
        let payload = read_handle(&mut file)?;
        validate_expected(root, expected, &payload)?;
        let old = parse(&payload)?;
        if old.resource_id != prepared.document.resource_id
            || old.kind != prepared.document.kind
            || old.version != prepared.document.version
            || old.source != prepared.document.source
        {
            return Err("更新管理记录不能改写原安装身份、来源或版本".into());
        }
        let mut document = prepared.document.clone();
        document.installation_id = old.installation_id;
        document.created_at = old.created_at;
        let payload = bytes(&document)?;
        file.seek(SeekFrom::Start(0))
            .and_then(|_| file.write_all(&payload))
            .and_then(|_| file.set_len(payload.len() as u64))
            .and_then(|_| file.sync_all())
            .map_err(|_| "管理记录更新未完整完成；运行文件未修改，未宣告回滚")?;
        if read_handle(&mut file)? != payload {
            return Err("管理记录更新后核验失败，文件原位保留".into());
        }
        record(root, &payload)
    }
}
fn unknown_files(
    root: &Path,
    directory: &Path,
    known: &BTreeSet<String>,
    out: &mut Vec<String>,
    depth: usize,
    visited: &mut usize,
) -> Result<(), String> {
    if depth > 32 {
        return Err("资源目录过深，未知文件核对未完成".into());
    }
    for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
        *visited += 1;
        if *visited > MAX_FILES * 2 + 1 {
            return Err("资源目录过大，未知文件核对未完成".into());
        }
        let path = entry.map_err(|e| e.to_string())?.path();
        let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "路径超出资源目录")?
            .to_string_lossy()
            .replace('\\', "/");
        if linked(&meta) {
            out.push(relative);
        } else if meta.is_dir() {
            unknown_files(root, &path, known, out, depth + 1, visited)?;
        } else if relative != NAME && !known.contains(&relative) {
            out.push(relative);
        }
    }
    Ok(())
}
/// Treat every on-disk JSON as an untrusted recovery hint. Only file-content
/// matches are reported; neither the claims nor matching hashes grant ownership.
pub(crate) fn recover(root: &Path) -> Result<Value, String> {
    let target = path(root)?;
    let mut file = options(false, false)
        .open(&target)
        .map_err(|_| "资源侧管理记录不可读取")?;
    one_link(&file)?;
    let document = parse(&read_handle(&mut file)?)?;
    let mut verified = Vec::new();
    let mut missing = Vec::new();
    let mut modified = Vec::new();
    let mut known = BTreeSet::new();
    for item in &document.files {
        known.insert(item.path.clone());
        match crate::local::safe_join(root, &item.path).and_then(|path| resource_files::fingerprint(&path)) {
            Ok(actual) if actual.bytes == item.bytes && actual.sha256.eq_ignore_ascii_case(&item.sha256) => verified.push(json!({"path":item.path,"role":item.role,"bytes":item.bytes,"sha256":actual.sha256})),
            Ok(_) => modified.push(item.path.clone()),
            Err(_) => missing.push(item.path.clone()),
        }
    }
    let mut unknown = Vec::new();
    unknown_files(root, root, &known, &mut unknown, 0, &mut 0)?;
    Ok(
        json!({"schemaVersion":1,"resourceId":document.resource_id,"installationId":document.installation_id,"kind":document.kind,"version":document.version,"source":document.source,"recordedComplete":document.complete,"canRegister":document.complete&&missing.is_empty()&&modified.is_empty(),"verifiedFiles":verified,"missingOrUnreadable":missing,"modifiedFiles":modified,"unknownFilesRetained":unknown,"ownership":"external","sourceVerified":false,"executionGrant":false,"deleteGrant":false,"automaticUpdateGrant":false,"message":"仅为重新登记预览；来源、归属和调用需独立核验，未知及本地修改保留。"}),
    )
}

#[cfg(test)]
mod tests;
