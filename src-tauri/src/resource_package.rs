//! Package preparation facts, distinct from installation or execution evidence.
//! Plans and receipts are created by the backend, never deserialized from a request.
//! ZIP installation remains in resource_files; wheel/npm preparation does not
//! turn a generated environment into an upstream release asset.
use crate::{
    model::Manager,
    resource_files::{self, Fingerprint, PackageInventory},
    resource_github::DownloadSource,
};
use base64::{engine::general_purpose, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256, Sha512};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};
use url::Url;

const MAX_ARCHIVE: u64 = 512 * 1024 * 1024;
const MAX_METADATA: u64 = 1024 * 1024;
const REACH_REPOSITORY: &str = "https://github.com/panniantong/agent-reach";
const NPM_REGISTRY: &str = "https://registry.npmjs.org";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Recipe {
    AgentReachWheelV1,
    EdgeMcpNpmV1,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum ArtifactOrigin {
    GithubRelease {
        source: DownloadSource,
    },
    NpmRegistry {
        registry: String,
        package: String,
        version: String,
        repository: String,
        tarball: String,
        integrity: String,
    },
    PyPiWheel {
        package: String,
        version: String,
        filename: String,
        url: String,
        sha256: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArtifactBinding {
    pub path: PathBuf,
    pub file: Fingerprint,
    pub origin: ArtifactOrigin,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WheelInspection {
    pub package: String,
    pub version: String,
    pub requires_python: Option<String>,
    pub requirements: Vec<String>,
    pub entry_points: BTreeMap<String, String>,
    pub licenses: Vec<String>,
    pub inventory: PackageInventory,
    pub record_verified: bool,
    pub pure_python: bool,
    pub wheel_tags: Vec<String>,
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn package_name(value: &str) -> Result<String, String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
    {
        return Err("Python 包标识无效".into());
    }
    let mut normalized = String::new();
    for ch in value.chars() {
        if matches!(ch, '-' | '_' | '.') {
            if !normalized.ends_with('-') {
                normalized.push('-');
            }
        } else {
            normalized.push(ch.to_ascii_lowercase());
        }
    }
    Ok(normalized)
}
fn small_zip_text(archive: &mut zip::ZipArchive<File>, name: &str) -> Result<String, String> {
    let mut entry = archive.by_name(name).map_err(|_| "wheel 缺少必要元数据")?;
    if entry.size() > MAX_METADATA {
        return Err("wheel 元数据超过有限读取范围".into());
    }
    let mut text = String::new();
    entry
        .read_to_string(&mut text)
        .map_err(|_| "wheel 元数据不是 UTF-8 文本")?;
    Ok(text)
}
fn fields(text: &str) -> Result<BTreeMap<String, Vec<String>>, String> {
    let mut result: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut last = None::<String>;
    for line in text.lines() {
        if line.is_empty() {
            break;
        }
        if line.starts_with([' ', '\t']) {
            let key = last.as_ref().ok_or("元数据续行缺少字段")?;
            let value = result
                .get_mut(key)
                .and_then(|values| values.last_mut())
                .ok_or("元数据字段缺失")?;
            value.push(' ');
            value.push_str(line.trim());
            continue;
        }
        let (key, value) = line.split_once(':').ok_or("wheel 元数据字段无效")?;
        if key.is_empty() || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return Err("wheel 元数据字段名称无效".into());
        }
        let key = key.to_ascii_lowercase();
        result
            .entry(key.clone())
            .or_default()
            .push(value.trim().into());
        last = Some(key);
    }
    Ok(result)
}
fn one(map: &BTreeMap<String, Vec<String>>, key: &str) -> Result<String, String> {
    let values = map.get(key).ok_or_else(|| format!("包元数据缺少 {key}"))?;
    if values.len() != 1 || values[0].is_empty() {
        return Err(format!("包元数据 {key} 不是唯一有效值"));
    }
    Ok(values[0].clone())
}
fn csv_row(line: &str) -> Result<Vec<String>, String> {
    let mut fields = vec![];
    let mut value = String::new();
    let mut chars = line.chars().peekable();
    let mut quoted = false;
    let mut closed = false;
    while let Some(ch) = chars.next() {
        match ch {
            '"' if quoted => {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    value.push('"');
                } else {
                    quoted = false;
                    closed = true;
                }
            }
            '"' if value.is_empty() && !closed => quoted = true,
            ',' if !quoted => {
                fields.push(std::mem::take(&mut value));
                closed = false;
            }
            _ if closed => return Err("wheel RECORD 引号字段无效".into()),
            '"' => return Err("wheel RECORD 字段引号无效".into()),
            _ => value.push(ch),
        }
    }
    if quoted {
        return Err("wheel RECORD 引号未闭合".into());
    }
    fields.push(value);
    Ok(fields)
}

/// All archive paths, RECORD hashes and file lengths are checked. Dependency
/// declarations are preserved, not mistaken for an installed dependency closure.
pub(crate) fn inspect_wheel(path: &Path) -> Result<WheelInspection, String> {
    let inventory = resource_files::inspect_zip(path, MAX_ARCHIVE)?;
    let metadata: Vec<_> = inventory
        .files
        .iter()
        .filter(|file| file.path.ends_with(".dist-info/METADATA"))
        .collect();
    if metadata.len() != 1 {
        return Err("wheel 必须只有一份主发行元数据".into());
    }
    let prefix = metadata[0]
        .path
        .strip_suffix("METADATA")
        .ok_or("wheel 元数据路径无效")?;
    let mut archive = zip::ZipArchive::new(File::open(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let meta = fields(&small_zip_text(&mut archive, &format!("{prefix}METADATA"))?)?;
    let package = package_name(&one(&meta, "name")?)?;
    let version = one(&meta, "version")?;
    let requirements = meta.get("requires-dist").cloned().unwrap_or_default();
    if requirements
        .iter()
        .any(|value| value.contains('@') || value.contains("://") || value.contains('\\'))
    {
        return Err("wheel 声明了直接 URL 或本地来源依赖，不能进入固定公共 wheel 配方".into());
    }
    let directory = prefix
        .trim_end_matches('/')
        .strip_suffix(".dist-info")
        .ok_or("wheel 元数据目录无效")?;
    let (distribution, directory_version) = directory
        .rsplit_once('-')
        .ok_or("wheel 元数据目录缺少版本")?;
    if directory.contains('/')
        || package_name(distribution)? != package
        || directory_version != version
    {
        return Err("wheel 元数据目录与包名、版本不一致".into());
    }
    let wheel = fields(&small_zip_text(&mut archive, &format!("{prefix}WHEEL"))?)?;
    if one(&wheel, "wheel-version")? != "1.0" {
        return Err("wheel 格式版本尚未核对".into());
    }
    let pure_python = match one(&wheel, "root-is-purelib")?.as_str() {
        "true" => true,
        "false" => false,
        _ => return Err("wheel purelib 声明无效".into()),
    };
    let tags = wheel.get("tag").cloned().unwrap_or_default();
    if tags.is_empty() {
        return Err("wheel 缺少平台兼容标签".into());
    }
    let record_path = format!("{prefix}RECORD");
    let record = small_zip_text(&mut archive, &record_path)?;
    let mut recorded = BTreeSet::new();
    for row in record.lines() {
        let values = csv_row(row)?;
        if values.len() != 3 {
            return Err("wheel RECORD 必须使用三个字段".into());
        }
        let name = &values[0];
        crate::local::validate_relative_path(name)?;
        if !recorded.insert(name.clone()) {
            return Err("wheel RECORD 路径重复".into());
        }
        if !inventory.files.iter().any(|file| &file.path == name) {
            return Err("wheel RECORD 指向不存在的包内文件".into());
        }
        if name == &record_path {
            if !values[1].is_empty() || !values[2].is_empty() {
                return Err("wheel RECORD 自身不应声明摘要".into());
            }
            continue;
        }
        let expected = values[1]
            .strip_prefix("sha256=")
            .ok_or("wheel 文件须有 SHA-256 RECORD 摘要")?;
        let expected = general_purpose::URL_SAFE_NO_PAD
            .decode(expected)
            .map_err(|_| "wheel RECORD 摘要编码无效")?;
        let length = values[2]
            .parse::<u64>()
            .map_err(|_| "wheel RECORD 长度无效")?;
        let mut file = archive
            .by_name(name)
            .map_err(|_| "wheel RECORD 文件不可读取")?;
        if file.size() != length {
            return Err("wheel RECORD 文件长度不一致".into());
        }
        let mut digest = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            crate::network::check_cancelled()?;
            let size = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if size == 0 {
                break;
            }
            digest.update(&buffer[..size]);
        }
        if expected.as_slice() != digest.finalize().as_slice() {
            return Err("wheel RECORD 内容摘要不一致".into());
        }
    }
    if inventory.files.iter().any(|file| {
        !recorded.contains(&file.path)
            && file.path != format!("{prefix}RECORD.jws")
            && file.path != format!("{prefix}RECORD.p7s")
    }) {
        return Err("wheel 有未列于 RECORD 的运行文件".into());
    }
    let mut entry_points = BTreeMap::new();
    let entry_file = format!("{prefix}entry_points.txt");
    if inventory.files.iter().any(|file| file.path == entry_file) {
        let text = small_zip_text(&mut archive, &entry_file)?;
        let mut console = false;
        for line in text.lines().map(str::trim) {
            if line.starts_with('[') {
                console = line == "[console_scripts]";
                continue;
            }
            if !console || line.is_empty() || line.starts_with(['#', ';']) {
                continue;
            }
            let (name, target) = line
                .split_once('=')
                .ok_or("wheel console_scripts 入口无效")?;
            if entry_points
                .insert(name.trim().into(), target.trim().into())
                .is_some()
            {
                return Err("wheel 原生入口重复".into());
            }
        }
    }
    if resource_files::fingerprint(path)? != inventory.archive {
        return Err("wheel 在检查期间发生变化".into());
    }
    Ok(WheelInspection {
        package,
        version,
        requires_python: meta
            .get("requires-python")
            .map(|_| one(&meta, "requires-python"))
            .transpose()?,
        requirements,
        entry_points,
        licenses: inventory
            .files
            .iter()
            .filter(|file| file.license)
            .map(|file| file.path.clone())
            .collect(),
        inventory,
        record_verified: true,
        pure_python,
        wheel_tags: tags,
    })
}

/// Only a real in-process GitHub download receipt can establish this origin.
pub(crate) fn bind_reach_wheel(
    m: &Manager,
    path: &Path,
    download_id: &str,
) -> Result<(ArtifactBinding, WheelInspection), String> {
    let inspected = inspect_wheel(path)?;
    let source = crate::resource_github::verified_source(
        m,
        &json!({"downloadId":download_id}),
        path,
        &inspected.inventory.archive,
    )?
    .ok_or("wheel 缺少实际下载来源回执")?;
    if !source
        .repository
        .trim_end_matches('/')
        .eq_ignore_ascii_case(REACH_REPOSITORY)
        || !source.asset_name.ends_with(".whl")
        || inspected.package != "agent-reach"
        || source.version.trim_start_matches('v') != inspected.version
        || source.sha256 != inspected.inventory.archive.sha256
        || source.release_id == 0
        || source.asset_id == 0
        || !matches!(source.verification.as_str(), "githubDigest" | "githubAsset")
        || inspected
            .entry_points
            .get("agent-reach")
            .map(String::as_str)
            != Some("agent_reach.cli:main")
    {
        return Err("wheel 实际身份与已核对的 Agent Reach 来源、版本或入口不一致".into());
    }
    if !inspected.pure_python || !inspected.wheel_tags.iter().any(|tag| tag == "py3-none-any") {
        return Err("此 Agent Reach wheel 不是已核对的通用 Python 3 运行包".into());
    }
    if inspected.licenses.is_empty() {
        return Err("wheel 缺少应保留的包内许可文件，需先核对上游许可布局".into());
    }
    Ok((
        ArtifactBinding {
            path: path.to_owned(),
            file: inspected.inventory.archive.clone(),
            origin: ArtifactOrigin::GithubRelease { source },
        },
        inspected,
    ))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NpmPackageMetadata {
    pub package: String,
    pub version: String,
    pub repository: String,
    pub tarball: String,
    pub integrity: String,
    pub dependencies: BTreeMap<String, String>,
    pub node_requirement: String,
    pub license: String,
}
fn exact_version(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+'))
    {
        return false;
    }
    value.split('-').next().is_some_and(|core| {
        core.split('.').count() == 3
            && core
                .split('.')
                .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
    })
}
fn npm_repository(name: &str) -> Option<&'static str> {
    match name {
        "@playwright/mcp" => Some("https://github.com/microsoft/playwright-mcp"),
        "playwright" | "playwright-core" => Some("https://github.com/microsoft/playwright"),
        _ => None,
    }
}
fn canonical_repo(value: &str) -> String {
    value
        .trim_start_matches("git+")
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .to_ascii_lowercase()
}
fn npm_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "npm 资产地址无效")?;
    if url.scheme() != "https"
        || url.host_str() != Some("registry.npmjs.org")
        || url.port().is_some_and(|port| port != 443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("npm 包只接受无凭据的固定官方 registry 资产".into());
    }
    Ok(url)
}
fn sri512(value: &str) -> Result<Vec<u8>, String> {
    let encoded = value
        .strip_prefix("sha512-")
        .ok_or("npm 包须有 SHA-512 integrity")?;
    let bytes = general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "npm integrity 编码无效")?;
    if bytes.len() != 64 {
        return Err("npm integrity 长度无效".into());
    }
    Ok(bytes)
}

/// Registry declarations are inspected independently of archive contents. This
/// does not confer a verified-download or installation receipt.
pub(crate) fn inspect_npm_metadata(
    name: &str,
    version: &str,
    value: &Value,
) -> Result<NpmPackageMetadata, String> {
    let repository = npm_repository(name).ok_or("此 npm 包没有经过核对的固定运行配方")?;
    if !exact_version(version) || value["name"] != name || value["version"] != version {
        return Err("npm 精确包名或版本与查询结果不一致".into());
    }
    let declared_repo = value["repository"]
        .as_str()
        .or_else(|| value["repository"]["url"].as_str())
        .ok_or("npm 包没有声明来源仓库")?;
    if canonical_repo(declared_repo) != repository {
        return Err("npm 包声明的仓库与已核对配方不同".into());
    }
    let tarball = value["dist"]["tarball"]
        .as_str()
        .ok_or("npm 包没有固定 tarball")?;
    let url = npm_url(tarball)?;
    let leaf = name.rsplit('/').next().ok_or("npm 包名称无效")?;
    if url.path() != format!("/{name}/-/{leaf}-{version}.tgz") {
        return Err("npm tarball 路径与精确包版本不同".into());
    }
    let integrity = value["dist"]["integrity"]
        .as_str()
        .ok_or("npm 包没有 integrity")?;
    sri512(integrity)?;
    let dependencies: BTreeMap<String, String> = match value.get("dependencies") {
        None => BTreeMap::new(),
        Some(value) => serde_json::from_value(value.clone()).map_err(|_| "npm 依赖声明无效")?,
    };
    if dependencies
        .iter()
        .any(|(name, version)| npm_repository(name).is_none() || !exact_version(version))
    {
        return Err("npm 配方出现未核对的依赖、范围版本或可变来源，需先明确运行闭包".into());
    }
    let required: BTreeSet<&str> = match name {
        "@playwright/mcp" => ["playwright", "playwright-core"].into(),
        "playwright" => ["playwright-core"].into(),
        "playwright-core" => BTreeSet::new(),
        _ => return Err("npm 包不在已核对配方中".into()),
    };
    if dependencies
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>()
        != required
    {
        return Err("npm 依赖结构已变化，需重新核对运行配方".into());
    }
    if ["peerDependencies", "optionalDependencies"]
        .iter()
        .any(|key| {
            value
                .get(key)
                .is_some_and(|v| v.as_object().is_none_or(|o| !o.is_empty()))
        })
    {
        return Err("npm 配方存在尚未核对的 peer/optional 依赖，不能静默省略".into());
    }
    if ["os", "cpu", "libc"].iter().any(|key| {
        value
            .get(key)
            .is_some_and(|v| v.as_array().is_none_or(|a| !a.is_empty()))
    }) {
        return Err("npm 包增加了尚未核对的平台限制".into());
    }
    let node_requirement = value["engines"]["node"]
        .as_str()
        .ok_or("npm 包缺少 Node 兼容声明")?;
    if !matches!(node_requirement, ">=18" | ">=20") {
        return Err("npm Node 版本约束尚未核对".into());
    }
    let license = value["license"]
        .as_str()
        .filter(|v| !v.trim().is_empty())
        .ok_or("npm 缺少许可证声明")?;
    Ok(NpmPackageMetadata {
        package: name.into(),
        version: version.into(),
        repository: repository.into(),
        tarball: tarball.into(),
        integrity: integrity.into(),
        dependencies,
        node_requirement: node_requirement.into(),
        license: license.into(),
    })
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NpmClosure {
    pub packages: Vec<NpmPackageMetadata>,
    pub node_major_minimum: u32,
    pub metadata_hash: String,
    pub archive_contents_inspected: bool,
}
pub(crate) fn npm_closure(
    main_version: &str,
    metadata: Vec<NpmPackageMetadata>,
) -> Result<NpmClosure, String> {
    let mut all = BTreeMap::new();
    for value in metadata {
        let key = (value.package.clone(), value.version.clone());
        if all.insert(key, value).is_some() {
            return Err("npm 闭包包版本重复".into());
        }
    }
    let mut pending = vec![("@playwright/mcp".to_owned(), main_version.to_owned())];
    let mut seen = BTreeSet::new();
    while let Some(key) = pending.pop() {
        if !seen.insert(key.clone()) {
            continue;
        }
        let package = all.get(&key).ok_or("npm 闭包缺少精确版本的运行依赖")?;
        pending.extend(
            package
                .dependencies
                .iter()
                .map(|(name, version)| (name.clone(), version.clone())),
        );
    }
    if seen.len() != all.len() {
        return Err("npm 闭包含未被运行依赖引用的附加包".into());
    }
    if seen
        .iter()
        .map(|(name, _)| name)
        .collect::<BTreeSet<_>>()
        .len()
        != seen.len()
    {
        return Err("固定 npm 配方不接受同包多版本隐式布局".into());
    }
    let packages: Vec<_> = all.into_values().collect();
    let node_major_minimum = if packages.iter().any(|p| p.node_requirement == ">=20") {
        20
    } else {
        18
    };
    let metadata_hash = sha256(&serde_json::to_vec(&packages).map_err(|e| e.to_string())?);
    Ok(NpmClosure {
        packages,
        node_major_minimum,
        metadata_hash,
        archive_contents_inspected: false,
    })
}
pub(crate) fn verify_npm_archive(
    path: &Path,
    metadata: &NpmPackageMetadata,
) -> Result<ArtifactBinding, String> {
    let before = resource_files::fingerprint(path)?;
    if before.bytes > MAX_ARCHIVE {
        return Err("npm 资产超过本次有限大小".into());
    }
    let expected = sri512(&metadata.integrity)?;
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha512::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        crate::network::check_cancelled()?;
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    if expected.as_slice() != digest.finalize().as_slice()
        || resource_files::fingerprint(path)? != before
    {
        return Err("npm 资产的 SHA-512 integrity 不一致或读取期间变化".into());
    }
    Ok(ArtifactBinding {
        path: path.to_owned(),
        file: before,
        origin: ArtifactOrigin::NpmRegistry {
            registry: NPM_REGISTRY.into(),
            package: metadata.package.clone(),
            version: metadata.version.clone(),
            repository: metadata.repository.clone(),
            tarball: metadata.tarball.clone(),
            integrity: metadata.integrity.clone(),
        },
    })
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeBinding {
    path: PathBuf,
    object_identity: String,
    file: Fingerprint,
}
impl RuntimeBinding {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
    pub(crate) fn fingerprint(&self) -> &Fingerprint {
        &self.file
    }
    pub(crate) fn object_identity(&self) -> &str {
        &self.object_identity
    }
    pub(crate) fn inspect(path: &Path) -> Result<Self, String> {
        crate::transaction::verify_root(path)?;
        let path = crate::local::canonical(path)?;
        Ok(Self {
            object_identity: crate::clients::file_identity(&path)?,
            file: resource_files::fingerprint(&path)?,
            path,
        })
    }
    fn recheck(&self) -> Result<(), String> {
        if resource_files::fingerprint(&self.path)? != self.file
            || crate::clients::file_identity(&self.path)? != self.object_identity
        {
            return Err("已选择的共享运行环境已改变，需重新预览".into());
        }
        Ok(())
    }
}

/// Only fixed builder commands are described here; no request supplies a shell,
/// arbitrary command text, installer hook or replacement environment values.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FixedChildSpec {
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub working_directory: PathBuf,
    pub remove_environment: Vec<String>,
    pub environment: BTreeMap<String, String>,
}
pub(crate) fn fresh_final_path(
    manager_data: &Path,
    runtime_root: &Path,
    destination: &Path,
) -> Result<PathBuf, String> {
    if !destination.is_absolute() || destination.exists() {
        return Err("最终运行目录必须是尚不存在的绝对路径".into());
    }
    let parent = destination.parent().ok_or("最终目录没有父目录")?;
    crate::transaction::verify_root(parent)?;
    let parent = crate::local::canonical(parent)?;
    let destination = parent.join(destination.file_name().ok_or("最终目录名称缺失")?);
    for protected in [manager_data, runtime_root] {
        let protected = crate::local::canonical(protected)?;
        if destination.starts_with(&protected) || protected.starts_with(&destination) {
            return Err("新运行目录须独立于管理器数据和现有运行目录".into());
        }
    }
    Ok(destination)
}
pub(crate) fn python_venv_spec(
    python: &RuntimeBinding,
    final_path: &Path,
    temporary: &Path,
) -> Result<FixedChildSpec, String> {
    python.recheck()?;
    if !python
        .path
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case("python.exe"))
        || final_path.exists()
        || !temporary.is_dir()
    {
        return Err("Python 环境入口、最终目录或本次临时目录无效".into());
    }
    crate::transaction::verify_root(temporary)?;
    Ok(FixedChildSpec {
        executable: python.path.clone(),
        args: vec![
            "-I".into(),
            "-B".into(),
            "-m".into(),
            "venv".into(),
            "--without-pip".into(),
            final_path.to_string_lossy().into_owned(),
        ],
        working_directory: temporary.to_owned(),
        remove_environment: [
            "PYTHONHOME",
            "PYTHONPATH",
            "PYTHONSTARTUP",
            "PYTHONUSERBASE",
            "PYTHONBREAKPOINT",
            "PIP_CONFIG_FILE",
            "PIP_TARGET",
            "PIP_PREFIX",
            "PIP_USER",
            "PIP_INDEX_URL",
            "PIP_EXTRA_INDEX_URL",
            "PIP_FIND_LINKS",
        ]
        .iter()
        .map(|v| (*v).into())
        .collect(),
        environment: [
            ("PYTHONDONTWRITEBYTECODE".into(), "1".into()),
            ("TEMP".into(), temporary.to_string_lossy().into_owned()),
            ("TMP".into(), temporary.to_string_lossy().into_owned()),
        ]
        .into(),
    })
}

/// A bounded preparation observation. This is deliberately not an InstallReceipt
/// and cannot establish file ownership or approve a candidate switch.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg(test)]
pub(crate) struct MaterializationPlan {
    recipe: Recipe,
    final_path: PathBuf,
    runtime: RuntimeBinding,
    artifacts: Vec<ArtifactBinding>,
    binding_hash: String,
    archive_contents_inspected: bool,
}
#[cfg(test)]
impl MaterializationPlan {
    pub(crate) fn reach_wheel(
        manager: &Manager,
        wheel: &Path,
        download_id: &str,
        manager_root: &Path,
        current_runtime: &Path,
        final_path: &Path,
        python: &Path,
    ) -> Result<(Self, WheelInspection), String> {
        let (artifact, inspected) = bind_reach_wheel(manager, wheel, download_id)?;
        let final_path = fresh_final_path(manager_root, current_runtime, final_path)?;
        let runtime = RuntimeBinding::inspect(python)?;
        let artifacts = vec![artifact];
        let binding_hash = sha256(&serde_json::to_vec(&json!({"recipe":Recipe::AgentReachWheelV1,"target":final_path,"runtime":runtime,"artifacts":artifacts})).map_err(|e| e.to_string())?);
        Ok((
            Self {
                recipe: Recipe::AgentReachWheelV1,
                final_path,
                runtime,
                artifacts,
                binding_hash,
                archive_contents_inspected: true,
            },
            inspected,
        ))
    }
    pub(crate) fn edge_npm(
        closure: &NpmClosure,
        paths: &BTreeMap<String, PathBuf>,
        manager_root: &Path,
        current_runtime: &Path,
        final_path: &Path,
        node: &Path,
    ) -> Result<Self, String> {
        if paths.len() != closure.packages.len() {
            return Err("npm 资产集合与精确运行闭包不一致".into());
        }
        let artifacts = closure
            .packages
            .iter()
            .map(|package| {
                let path = paths
                    .get(&package.package)
                    .ok_or("npm 闭包缺少已经下载的资产")?;
                verify_npm_archive(path, package)
            })
            .collect::<Result<Vec<_>, String>>()?;
        let final_path = fresh_final_path(manager_root, current_runtime, final_path)?;
        let runtime = RuntimeBinding::inspect(node)?;
        let binding_hash = sha256(&serde_json::to_vec(&json!({"recipe":Recipe::EdgeMcpNpmV1,"target":final_path,"runtime":runtime,"artifacts":artifacts,"closure":closure.metadata_hash})).map_err(|e| e.to_string())?);
        Ok(Self {
            recipe: Recipe::EdgeMcpNpmV1,
            final_path,
            runtime,
            artifacts,
            binding_hash,
            archive_contents_inspected: false,
        })
    }
    pub(crate) fn preview(&self) -> Value {
        json!({"kind":"runtimePackagePreparation","recipe":self.recipe,"targetPath":self.final_path,"runtime":self.runtime,"artifacts":self.artifacts,"bindingHash":self.binding_hash,"archiveContentsInspected":self.archive_contents_inspected,"dependencyClosureInstalled":false,"runtimeCompatibilityProbed":false,"canApply":false,"installed":false,"executionVerified":false,"ownershipGranted":false,"reason":"此层仅核对包准备依据；依赖解析、最终路径构建、安装回执和实际能力验证须由完整生命周期完成。"})
    }
}

/// Resolver/build stages have fixed commands, not caller-provided installers.
/// The parent lifecycle owns admission, write locks and persistence of receipts.
const PIP_BOOTSTRAP: &str = "import runpy,sys; sys.path.append(sys.argv.pop(1)); runpy.run_module('pip',run_name='__main__')";
const MAX_RUNTIME_FILES: usize = 50_000;
const MAX_RUNTIME_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PipRuntime {
    interpreter: RuntimeBinding,
    site_packages: PathBuf,
    pip_files: BTreeMap<String, Fingerprint>,
    python_license: PathBuf,
    python_license_file: Fingerprint,
}
fn inventory(root: &Path) -> Result<BTreeMap<String, Fingerprint>, String> {
    crate::transaction::verify_root(root)?;
    let mut pending = vec![root.to_owned()];
    let mut files = BTreeMap::new();
    let mut bytes = 0u64;
    while let Some(path) = pending.pop() {
        crate::network::check_cancelled()?;
        crate::transaction::verify_root(&path)?;
        let metadata = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if metadata.is_dir() {
            let children = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
            for child in children {
                pending.push(child.map_err(|e| e.to_string())?.path());
                if pending.len() + files.len() > MAX_RUNTIME_FILES {
                    return Err("运行闭包文件数超过本次有限范围".into());
                }
            }
        } else if metadata.is_file() {
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "运行闭包路径逸出所选目录")?
                .to_string_lossy()
                .replace('\\', "/");
            crate::local::validate_relative_path(&relative)?;
            let file = resource_files::fingerprint(&path)?;
            bytes = bytes.checked_add(file.bytes).ok_or("运行闭包大小溢出")?;
            if bytes > MAX_RUNTIME_BYTES {
                return Err("运行闭包超过本次大小范围".into());
            }
            if files.insert(relative, file).is_some() {
                return Err("运行闭包路径重复".into());
            }
        } else {
            return Err("运行闭包含未知文件类型".into());
        }
    }
    Ok(files)
}
impl PipRuntime {
    pub(crate) fn inspect(python: &Path) -> Result<Self, String> {
        let interpreter = RuntimeBinding::inspect(python)?;
        if !interpreter
            .path
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case("python.exe"))
        {
            return Err("请选择已安装的真实 Python 入口".into());
        }
        let root = interpreter.path.parent().ok_or("Python 根目录不可读取")?;
        let site_packages = root.join("Lib/site-packages");
        let pip_root = site_packages.join("pip");
        if !pip_root.join("__main__.py").is_file()
            || !pip_root.join("_internal/cli/main.py").is_file()
        {
            return Err("所选 Python 缺少可核对的现有 pip，不自动安装共享依赖".into());
        }
        let pip_files = inventory(&pip_root)?;
        let python_license = root.join("LICENSE.txt");
        let python_license_file = resource_files::fingerprint(&python_license)
            .map_err(|_| "所选 Python 缺少应随私人运行文件保留的 LICENSE.txt")?;
        Ok(Self {
            interpreter,
            site_packages,
            pip_files,
            python_license,
            python_license_file,
        })
    }
    fn recheck(&self) -> Result<(), String> {
        self.interpreter.recheck()?;
        if inventory(&self.site_packages.join("pip"))? != self.pip_files
            || resource_files::fingerprint(&self.python_license)? != self.python_license_file
        {
            return Err("pip 或 Python 许可文件已变化，需重新核对准备计划".into());
        }
        Ok(())
    }
    fn command(&self, arguments: Vec<String>, work: &Path) -> Result<FixedChildSpec, String> {
        self.recheck()?;
        let mut command =
            python_venv_spec(&self.interpreter, &work.join("unused-venv-spec"), work)?;
        command.args = vec![
            "-I".into(),
            "-S".into(),
            "-B".into(),
            "-c".into(),
            PIP_BOOTSTRAP.into(),
            self.site_packages.to_string_lossy().into_owned(),
            "--isolated".into(),
        ];
        command.args.extend(arguments);
        // os.devnull disables global, user and site pip configuration. The
        // isolated HOME belongs to this preparation, never to the user browser.
        command
            .environment
            .insert("PIP_CONFIG_FILE".into(), "nul".into());
        command
            .environment
            .insert("HOME".into(), work.to_string_lossy().into_owned());
        command
            .environment
            .insert("USERPROFILE".into(), work.to_string_lossy().into_owned());
        Ok(command)
    }
}

#[cfg(windows)]
fn drain_builder(
    pipe: &mut (impl Read + std::os::windows::io::AsRawHandle),
    output: &mut Vec<u8>,
) -> Result<(), String> {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn PeekNamedPipe(
            handle: *mut std::ffi::c_void,
            buffer: *mut std::ffi::c_void,
            size: u32,
            read: *mut u32,
            available: *mut u32,
            left: *mut u32,
        ) -> i32;
    }
    let mut buffer = [0u8; 4096];
    for _ in 0..17 {
        let mut available = 0;
        let result = unsafe {
            PeekNamedPipe(
                pipe.as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        };
        if result == 0 {
            if std::io::Error::last_os_error().raw_os_error() == Some(109) {
                break;
            }
            return Err("准备子进程输出不可读取，未保存原始输出".into());
        }
        let count = (available as usize).min(buffer.len());
        if count == 0 {
            break;
        }
        let count = pipe
            .read(&mut buffer[..count])
            .map_err(|_| "准备子进程输出读取失败")?;
        if count == 0 {
            break;
        }
        if output.len() + count > 64 * 1024 {
            return Err("准备子进程输出超过有限范围，未截断为成功".into());
        }
        output.extend_from_slice(&buffer[..count]);
    }
    Ok(())
}

#[cfg(windows)]
fn run_fixed(spec: &FixedChildSpec, timeout: std::time::Duration) -> Result<(), String> {
    use std::{
        os::windows::process::CommandExt,
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    let mut command = Command::new(&spec.executable);
    command
        .args(&spec.args)
        .current_dir(&spec.working_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x08000000);
    for key in &spec.remove_environment {
        command.env_remove(key);
    }
    for (key, value) in &spec.environment {
        command.env(key, value);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "无法启动本次已核对的准备入口")?;
    let mut stdout = child.stdout.take().ok_or("准备进程没有输出句柄")?;
    let mut stderr = child.stderr.take().ok_or("准备进程没有诊断句柄")?;
    let deadline = Instant::now() + timeout;
    let mut out = Vec::new();
    let mut err = Vec::new();
    let result = (|| loop {
        crate::network::check_cancelled()?;
        drain_builder(&mut stdout, &mut out)?;
        drain_builder(&mut stderr, &mut err)?;
        if let Some(status) = child.try_wait().map_err(|_| "无法核对准备进程状态")? {
            drain_builder(&mut stdout, &mut out)?;
            drain_builder(&mut stderr, &mut err)?;
            if !status.success() {
                return Err(format!(
                    "准备阶段未成功完成（退出码 {:?}）；不保存可能含凭据的原始输出",
                    status.code()
                ));
            }
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("准备阶段超时，未认定安装成功".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    })();
    if result.is_err()
        && child
            .try_wait()
            .map_err(|_| "无法核对自有准备进程")?
            .is_none()
    {
        child
            .kill()
            .map_err(|_| "无法停止本次自有准备进程；不处理其他进程")?;
        let deadline = Instant::now() + Duration::from_secs(3);
        while child
            .try_wait()
            .map_err(|_| "无法核对自有准备进程退出")?
            .is_none()
        {
            if Instant::now() >= deadline {
                return Err("本次自有准备进程尚未退出，不能认定取消完成".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    result
}
#[cfg(not(windows))]
fn run_fixed(_spec: &FixedChildSpec, _timeout: std::time::Duration) -> Result<(), String> {
    Err("本版私人 Python 环境准备仅支持已核对的 Windows 路线".into())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolvedWheel {
    package: String,
    version: String,
    filename: String,
    url: String,
    sha256: String,
    bytes: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReachResolution {
    main: ArtifactBinding,
    package: WheelInspection,
    runtime: PipRuntime,
    dependencies: Vec<ResolvedWheel>,
    resolution_hash: String,
    resolver_work: PathBuf,
}
fn pypi_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "PyPI 资产地址无效")?;
    if url.scheme() != "https"
        || url.host_str() != Some("files.pythonhosted.org")
        || url.port().is_some_and(|p| p != 443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("依赖只接受无凭据的官方 PyPI 固定 wheel 下载地址".into());
    }
    Ok(url)
}
fn exact_python_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_digit()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'+' | b'!'))
}
fn json_response(url: &str) -> Result<Value, String> {
    let (client, generation) = crate::network::client()?;
    json_response_cached(
        &client,
        generation,
        url,
        crate::network::CachePolicy::MaxAge(std::time::Duration::from_secs(300)),
    )
}
fn json_response_cached(
    client: &reqwest::blocking::Client,
    generation: u64,
    url: &str,
    policy: crate::network::CachePolicy,
) -> Result<Value, String> {
    use crate::network::Loaded;
    let bytes = crate::network::cached(
        &format!("runtime-package:{generation}:{url}"),
        policy,
        |etag| {
            let _permit = crate::network::acquire(false, true)?;
            crate::network::check_cancelled()?;
            let mut request = client.get(url).timeout(std::time::Duration::from_secs(30));
            if let Some(etag) = etag {
                request = request.header(reqwest::header::IF_NONE_MATCH, etag);
            }
            let response = request.send().map_err(|_| "无法读取官方包元数据")?;
            if response.url().as_str() != url {
                return Err("官方包元数据不可访问或地址发生跳转".into());
            }
            if response.status() == reqwest::StatusCode::NOT_MODIFIED {
                return Ok(Loaded {
                    body: vec![],
                    etag: None,
                    not_modified: true,
                });
            }
            if !response.status().is_success() {
                return Err("官方包元数据不可访问或地址发生跳转".into());
            }
            let etag = response
                .headers()
                .get(reqwest::header::ETAG)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            let mut body = Vec::new();
            response
                .take(MAX_METADATA + 1)
                .read_to_end(&mut body)
                .map_err(|_| "官方元数据读取失败")?;
            if body.len() as u64 > MAX_METADATA {
                return Err("官方包元数据超过有限读取范围".into());
            }
            Ok(Loaded {
                body,
                etag,
                not_modified: false,
            })
        },
    )?;
    serde_json::from_slice(&bytes).map_err(|_| "官方包元数据不是有效 JSON".into())
}
fn resolve_report(
    report: &Value,
    main: &WheelInspection,
    mut official: impl FnMut(&str, &str) -> Result<Value, String>,
) -> Result<Vec<ResolvedWheel>, String> {
    if report["version"] != "1" {
        return Err("pip 解析报告格式版本未核对".into());
    }
    let environment = &report["environment"];
    let version = environment["python_full_version"]
        .as_str()
        .ok_or("pip 报告缺少真实 Python 版本")?;
    let mut parts = version.split('.');
    let major = parts
        .next()
        .and_then(|p| p.parse::<u32>().ok())
        .ok_or("Python 版本无效")?;
    let minor = parts
        .next()
        .and_then(|p| p.parse::<u32>().ok())
        .ok_or("Python 版本无效")?;
    if (major, minor) < (3, 10)
        || major != 3
        || environment["sys_platform"] != "win32"
        || environment["platform_machine"] != "AMD64"
    {
        return Err("当前固定配方要求 Windows x64 与 Python 3.10 以上的已核对兼容环境".into());
    }
    let entries = report["install"].as_array().ok_or("pip 没有返回安装闭包")?;
    if entries.is_empty() || entries.len() > 128 {
        return Err("pip 解析闭包为空或超过有限范围".into());
    }
    let mut seen = BTreeSet::new();
    let mut main_seen = false;
    let mut result = vec![];
    let mut total = 0u64;
    for entry in entries {
        let name = package_name(entry["metadata"]["name"].as_str().ok_or("依赖包名缺失")?)?;
        let version = entry["metadata"]["version"]
            .as_str()
            .ok_or("依赖版本缺失")?;
        if !exact_python_version(version) || !seen.insert(name.clone()) {
            return Err("依赖版本不是精确值或包名重复".into());
        }
        if name == main.package {
            if version != main.version
                || entry["download_info"]["archive_info"]["hashes"]["sha256"]
                    != main.inventory.archive.sha256
            {
                return Err("pip 主包与实际 wheel 不一致".into());
            }
            main_seen = true;
            continue;
        }
        if entry["is_direct"] == true {
            return Err("依赖解析出现直接来源，不能沿用公共 PyPI wheel 配方".into());
        }
        let url = entry["download_info"]["url"]
            .as_str()
            .ok_or("依赖没有固定下载地址")?;
        pypi_url(url)?;
        let hash = entry["download_info"]["archive_info"]["hashes"]["sha256"]
            .as_str()
            .filter(|value| value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit()))
            .ok_or("依赖没有精确 SHA-256")?;
        let metadata = official(&name, version)?;
        if package_name(metadata["info"]["name"].as_str().ok_or("PyPI 包身份缺失")?)? != name
            || metadata["info"]["version"] != version
        {
            return Err("PyPI 身份与解析结果不同".into());
        }
        let file = metadata["urls"]
            .as_array()
            .and_then(|assets| {
                assets.iter().find(|asset| {
                    asset["url"] == url
                        && asset["digests"]["sha256"] == hash
                        && asset["packagetype"] == "bdist_wheel"
                        && asset["yanked"] == false
                })
            })
            .ok_or("解析依赖不是该 PyPI 精确版本的可核对 wheel")?;
        let filename = file["filename"].as_str().ok_or("依赖文件名缺失")?;
        crate::local::validate_relative_path(filename)?;
        if filename.contains(['/', '\\']) || !filename.ends_with(".whl") {
            return Err("依赖文件不是单一预构建 wheel".into());
        }
        let bytes = file["size"]
            .as_u64()
            .filter(|v| *v > 0 && *v <= MAX_ARCHIVE)
            .ok_or("依赖 wheel 大小不明确")?;
        total = total.checked_add(bytes).ok_or("依赖下载量溢出")?;
        if total > MAX_RUNTIME_BYTES {
            return Err("依赖下载量超过本次有限范围".into());
        }
        result.push(ResolvedWheel {
            package: name,
            version: version.into(),
            filename: filename.into(),
            url: url.into(),
            sha256: hash.to_ascii_lowercase(),
            bytes,
        });
    }
    if !main_seen {
        return Err("pip 解析未包含已核实的主 wheel".into());
    }
    result.sort_by(|a, b| a.package.cmp(&b.package));
    Ok(result)
}
impl ReachResolution {
    pub(crate) fn resolve(
        manager: &Manager,
        wheel: &Path,
        download_id: &str,
        runtime: PipRuntime,
        work: &Path,
    ) -> Result<Self, String> {
        use std::time::Duration;
        let (main, package) = bind_reach_wheel(manager, wheel, download_id)?;
        if !work.is_dir() {
            return Err("请选择本次已授权的准备工作目录".into());
        }
        crate::transaction::verify_root(work)?;
        let resolver_work = work.join(format!("package-resolution-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&resolver_work).map_err(|e| e.to_string())?;
        let report = resolver_work.join("pip-resolution.json");
        let cache = resolver_work.join("pip-cache");
        std::fs::create_dir(&cache).map_err(|e| e.to_string())?;
        let arguments = vec![
            "--cache-dir".into(),
            cache.to_string_lossy().into_owned(),
            "install".into(),
            "--keyring-provider".into(),
            "disabled".into(),
            "--dry-run".into(),
            "--ignore-installed".into(),
            "--only-binary=:all:".into(),
            "--no-input".into(),
            "--disable-pip-version-check".into(),
            "--index-url".into(),
            "https://pypi.org/simple".into(),
            "--report".into(),
            report.to_string_lossy().into_owned(),
            main.path.to_string_lossy().into_owned(),
        ];
        run_fixed(
            &runtime.command(arguments, &resolver_work)?,
            Duration::from_secs(180),
        )?;
        if resource_files::fingerprint(&main.path)? != main.file {
            return Err("主 wheel 在依赖解析期间发生变化".into());
        }
        let report_file = resource_files::fingerprint(&report)?;
        if report_file.bytes > MAX_METADATA {
            return Err("pip 解析报告超过有限范围".into());
        }
        let value: Value =
            serde_json::from_slice(&std::fs::read(&report).map_err(|e| e.to_string())?)
                .map_err(|_| "pip 解析报告不可读取")?;
        let dependencies = resolve_report(&value, &package, |name, version| {
            json_response(&format!("https://pypi.org/pypi/{name}/{version}/json"))
        })?;
        let resolution_hash = sha256(
            &serde_json::to_vec(
                &json!({"main":main,"runtime":runtime,"dependencies":dependencies}),
            )
            .map_err(|e| e.to_string())?,
        );
        Ok(Self {
            main,
            package,
            runtime,
            dependencies,
            resolution_hash,
            resolver_work,
        })
    }
    #[cfg(test)]
    pub(crate) fn preview(&self) -> Value {
        json!({"kind":"resolvedPythonRuntime","recipe":Recipe::AgentReachWheelV1,"source":self.main,"dependencies":self.dependencies,"runtime":self.runtime,"bindingHash":self.resolution_hash,"resolverWorkingPath":self.resolver_work,"dependencyBytes":self.dependencies.iter().map(|d|d.bytes).sum::<u64>(),"installed":false,"executionVerified":false,"canApply":false,"nextStep":"下载并核对这些精确 wheel，预览最终运行位置后再创建环境；不下载源码构建或开发extras。"})
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimePackageReceipt {
    pub recipe: Recipe,
    pub source_artifacts: Vec<ArtifactBinding>,
    pub runtime: BuilderRuntime,
    pub plan_hash: String,
    pub root: PathBuf,
    pub files: Vec<resource_files::OwnedFile>,
    pub created_paths: Vec<PathBuf>,
    pub complete: bool,
    pub error: Option<String>,
    pub dependency_check_passed: bool,
    pub execution_verified: bool,
    pub temporary_paths: Vec<PathBuf>,
}

fn observe_created_runtime(receipt: &mut RuntimePackageReceipt) -> Result<(), String> {
    let observed = inventory(&receipt.root)?;
    receipt.files.clear();
    receipt.created_paths = vec![receipt.root.clone()];
    for (path, file) in observed {
        let role = if path == "licenses/Python-LICENSE.txt" || crate::local::license_path(&path) {
            resource_files::FileRole::License
        } else if match receipt.recipe {
            Recipe::AgentReachWheelV1 => {
                path == "Scripts/agent-reach.exe"
                    || path.starts_with("Lib/site-packages/agent_reach/")
            }
            Recipe::EdgeMcpNpmV1 => path.starts_with("node_modules/@playwright/mcp/"),
        } {
            resource_files::FileRole::Runtime
        } else {
            resource_files::FileRole::PrivateDependency
        };
        receipt.created_paths.push(receipt.root.join(&path));
        receipt.files.push(resource_files::OwnedFile {
            path,
            role,
            installed_sha256: file.sha256,
        });
    }
    Ok(())
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadyReachPlan {
    resolution: ReachResolution,
    artifacts: Vec<ArtifactBinding>,
    destination: PathBuf,
    work: PathBuf,
    plan_hash: String,
}
impl ReadyReachPlan {
    pub(crate) fn from_downloads(
        resolution: ReachResolution,
        receipt: &PackageDownloadReceipt,
        manager_root: &Path,
        current_runtime: &Path,
        destination: &Path,
        work: &Path,
    ) -> Result<Self, String> {
        Self::bind(
            resolution,
            &receipt.files()?,
            manager_root,
            current_runtime,
            destination,
            work,
        )
    }
    pub(crate) fn bind(
        resolution: ReachResolution,
        downloaded: &BTreeMap<String, PathBuf>,
        manager_root: &Path,
        current_runtime: &Path,
        destination: &Path,
        work: &Path,
    ) -> Result<Self, String> {
        let destination = fresh_final_path(manager_root, current_runtime, destination)?;
        crate::transaction::verify_root(work)?;
        if !work.is_dir() || destination.starts_with(work) || work.starts_with(&destination) {
            return Err("准备目录与最终运行目录必须独立".into());
        }
        if downloaded.len() != resolution.dependencies.len() {
            return Err("已下载 wheel 集合与精确依赖闭包不同".into());
        }
        resolution.runtime.recheck()?;
        if resource_files::fingerprint(&resolution.main.path)? != resolution.main.file {
            return Err("主 wheel 已变化".into());
        }
        let mut artifacts = vec![resolution.main.clone()];
        for dependency in &resolution.dependencies {
            let path = downloaded
                .get(&dependency.package)
                .ok_or("缺少已经下载的依赖 wheel")?;
            let file = resource_files::fingerprint(path)?;
            if file.sha256 != dependency.sha256
                || file.bytes != dependency.bytes
                || path.file_name().and_then(|n| n.to_str()) != Some(dependency.filename.as_str())
            {
                return Err("依赖 wheel 与精确官方资产摘要、长度或名称不同".into());
            }
            let inspected = inspect_wheel(path)?;
            if inspected.package != dependency.package || inspected.version != dependency.version {
                return Err("依赖 wheel 包身份与解析闭包不一致".into());
            }
            artifacts.push(ArtifactBinding {
                path: path.to_owned(),
                file,
                origin: ArtifactOrigin::PyPiWheel {
                    package: dependency.package.clone(),
                    version: dependency.version.clone(),
                    filename: dependency.filename.clone(),
                    url: dependency.url.clone(),
                    sha256: dependency.sha256.clone(),
                },
            });
        }
        for artifact in &artifacts {
            let inspected = inspect_wheel(&artifact.path)?;
            if inspected.inventory.files.iter().any(|f| {
                f.path.ends_with(".pth")
                    || f.path
                        .rsplit('/')
                        .next()
                        .is_some_and(|name| matches!(name, "sitecustomize.py" | "usercustomize.py"))
            }) {
                return Err(
                    "wheel 含会在 Python 启动时自动执行的配置，需先核对，未执行安装".into(),
                );
            }
        }
        let work = work.join(format!("package-build-{}", uuid::Uuid::new_v4()));
        let plan_hash = sha256(&serde_json::to_vec(&json!({"resolution":resolution.resolution_hash,"artifacts":artifacts,"destination":destination,"work":work})).map_err(|e| e.to_string())?);
        Ok(Self {
            resolution,
            artifacts,
            destination,
            work,
            plan_hash,
        })
    }
    pub(crate) fn preview(&self) -> Value {
        json!({"kind":"pythonRuntimeMaterialization","recipe":Recipe::AgentReachWheelV1,"targetPath":self.destination,"workingPath":self.work,"artifacts":self.artifacts,"runtime":self.resolution.runtime,"planHash":self.plan_hash,"canApply":true,"executionVerified":false,"sideEffects":["只在新的最终运行目录建立私人环境","离线安装已核对的完整 wheel 集合，不运行源码构建或包安装脚本","保留现有运行版本、配置和未知文件；不会复制用户配置或登录资料"]})
    }
    #[cfg(test)]
    pub(crate) fn materialize(self) -> Result<RuntimePackageReceipt, String> {
        self.materialize_with_checkpoint(|_| Ok(()))
    }
    pub(crate) fn materialize_with_checkpoint(
        self,
        mut checkpoint: impl FnMut(&RuntimePackageReceipt) -> Result<(), String>,
    ) -> Result<RuntimePackageReceipt, String> {
        use std::{fs::OpenOptions, io::Write, time::Duration};
        self.resolution.runtime.recheck()?;
        if self.destination.exists() {
            return Err("最终运行位置已出现内容，需重新预览；没有覆盖".into());
        }
        for artifact in &self.artifacts {
            if resource_files::fingerprint(&artifact.path)? != artifact.file {
                return Err("准备的 wheel 在应用前已变化，未建立运行目录".into());
            }
        }
        std::fs::create_dir(&self.work).map_err(|e| e.to_string())?;
        let lock = self.work.join("wheel-lock.txt");
        let mut lock_file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&lock)
            .map_err(|e| e.to_string())?;
        for artifact in &self.artifacts {
            let absolute = crate::local::canonical(&artifact.path)?;
            let url = Url::from_file_path(&absolute)
                .map_err(|_| "本地 wheel 路径不能作为固定文件 URI")?;
            writeln!(lock_file, "{url} --hash=sha256:{}", artifact.file.sha256)
                .map_err(|e| e.to_string())?;
        }
        lock_file.sync_all().map_err(|e| e.to_string())?;
        let mut receipt = RuntimePackageReceipt {
            recipe: Recipe::AgentReachWheelV1,
            source_artifacts: self.artifacts.clone(),
            runtime: BuilderRuntime::PythonPip(self.resolution.runtime.clone()),
            plan_hash: self.plan_hash,
            root: self.destination.clone(),
            files: vec![],
            created_paths: vec![],
            complete: false,
            error: None,
            dependency_check_passed: false,
            execution_verified: false,
            temporary_paths: vec![self.work.clone(), self.resolution.resolver_work.clone()],
        };
        checkpoint(&receipt)?;
        let mut target_created = false;
        let result = (|| {
            let venv = python_venv_spec(
                &self.resolution.runtime.interpreter,
                &self.destination,
                &self.work,
            )?;
            // venv accepts an existing directory. Reserve this fresh directory
            // atomically so the builder cannot adopt or overwrite another root.
            std::fs::create_dir(&self.destination)
                .map_err(|_| "最终目录已被占用，未运行准备命令")?;
            target_created = true;
            receipt.created_paths.push(self.destination.clone());
            checkpoint(&receipt)?;
            run_fixed(&venv, Duration::from_secs(60))?;
            observe_created_runtime(&mut receipt)?;
            checkpoint(&receipt)?;
            self.resolution.runtime.recheck()?;
            for artifact in &self.artifacts {
                if resource_files::fingerprint(&artifact.path)? != artifact.file {
                    return Err("wheel 在准备期间发生变化，新目录保留，未继续安装".into());
                }
            }
            let python = self.destination.join("Scripts/python.exe");
            resource_files::fingerprint(&python)
                .map_err(|_| "新私人环境没有生成真实 Python 入口")?;
            let args = vec![
                "--python".into(),
                python.to_string_lossy().into_owned(),
                "install".into(),
                "--keyring-provider".into(),
                "disabled".into(),
                "--no-index".into(),
                "--only-binary=:all:".into(),
                "--require-hashes".into(),
                "--no-compile".into(),
                "--no-input".into(),
                "--disable-pip-version-check".into(),
                "-r".into(),
                lock.to_string_lossy().into_owned(),
            ];
            run_fixed(
                &self.resolution.runtime.command(args, &self.work)?,
                Duration::from_secs(180),
            )?;
            observe_created_runtime(&mut receipt)?;
            checkpoint(&receipt)?;
            run_fixed(
                &self.resolution.runtime.command(
                    vec![
                        "--python".into(),
                        python.to_string_lossy().into_owned(),
                        "check".into(),
                        "--disable-pip-version-check".into(),
                    ],
                    &self.work,
                )?,
                Duration::from_secs(60),
            )?;
            receipt.dependency_check_passed = true;
            if !self.destination.join("Scripts/agent-reach.exe").is_file() {
                return Err("安装后没有生成 Agent Reach 原生入口".into());
            }
            let licenses = self.destination.join("licenses");
            std::fs::create_dir(&licenses).map_err(|e| e.to_string())?;
            let mut target = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(licenses.join("Python-LICENSE.txt"))
                .map_err(|e| e.to_string())?;
            let mut source =
                File::open(&self.resolution.runtime.python_license).map_err(|e| e.to_string())?;
            std::io::copy(&mut source, &mut target).map_err(|e| e.to_string())?;
            target.sync_all().map_err(|e| e.to_string())?;
            Ok(())
        })();
        // All of this directory was newly created by this owned builder. Existing
        // roots/configuration are never accepted as an inventory/ownership source.
        if target_created {
            let observed = crate::network::with_task_context(
                crate::network::TaskContext {
                    foreground: false,
                    cancel: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                },
                || observe_created_runtime(&mut receipt),
            );
            match observed {
                Ok(()) => {}
                Err(error) => {
                    receipt.error = Some(format!(
                        "{}；创建文件范围尚未完整核对：{error}",
                        result.err().unwrap_or_default()
                    ));
                    checkpoint(&receipt)?;
                    return Ok(receipt);
                }
            }
        }
        receipt.complete = result.is_ok();
        receipt.error = result.err();
        checkpoint(&receipt)?;
        Ok(receipt)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", content = "binding", rename_all = "camelCase")]
pub(crate) enum BuilderRuntime {
    PythonPip(PipRuntime),
    Node(RuntimeBinding),
}

/// Durable origin of an actually prepared runtime, not an upstream ZIP receipt,
/// ownership imported from a manifest, or evidence of an executed capability.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimePackageProvenance {
    pub schema_version: u32,
    pub recipe: Recipe,
    pub version: String,
    pub plan_hash: String,
    pub source_artifacts: Vec<ArtifactBinding>,
    pub runtime: BuilderRuntime,
}
impl RuntimePackageProvenance {
    pub(crate) fn validate_source(&self) -> Result<(), String> {
        if self.schema_version != 1
            || !exact_version(&self.version)
            || self.plan_hash.len() != 64
            || !self.plan_hash.bytes().all(|b| b.is_ascii_hexdigit())
            || self.source_artifacts.is_empty()
            || self.source_artifacts.len() > 129
        {
            return Err("运行包来源结构、版本或准备绑定无效".into());
        }
        let mut packages = BTreeMap::new();
        let mut github_count = 0usize;
        for artifact in &self.source_artifacts {
            if artifact.file.bytes == 0
                || artifact.file.bytes > MAX_ARCHIVE
                || artifact.file.sha256.len() != 64
                || !artifact.file.sha256.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err("运行包实际资产摘要无效".into());
            }
            match (&self.recipe, &artifact.origin) {
                (Recipe::AgentReachWheelV1, ArtifactOrigin::GithubRelease { source }) => {
                    github_count += 1;
                    if canonical_repo(&source.repository) != canonical_repo(REACH_REPOSITORY)
                        || source.version.trim_start_matches('v') != self.version
                        || source.release_id == 0
                        || source.asset_id == 0
                        || !source.asset_name.ends_with(".whl")
                        || source.sha256 != artifact.file.sha256
                        || !matches!(source.verification.as_str(), "githubDigest" | "githubAsset")
                    {
                        return Err("Agent Reach 主 wheel 来源不是实际核对的官方发行资产".into());
                    }
                }
                (
                    Recipe::AgentReachWheelV1,
                    ArtifactOrigin::PyPiWheel {
                        package,
                        version,
                        filename,
                        url,
                        sha256,
                    },
                ) => {
                    if package_name(package)? != *package
                        || package == "agent-reach"
                        || !exact_python_version(version)
                        || !filename.ends_with(".whl")
                        || sha256 != &artifact.file.sha256
                        || pypi_url(url)?
                            .path_segments()
                            .and_then(|mut p| p.next_back())
                            != Some(filename.as_str())
                        || packages.insert(package.clone(), version.clone()).is_some()
                    {
                        return Err("Python 精确依赖来源无效或重复".into());
                    }
                }
                (
                    Recipe::EdgeMcpNpmV1,
                    ArtifactOrigin::NpmRegistry {
                        registry,
                        package,
                        version,
                        repository,
                        tarball,
                        integrity,
                    },
                ) => {
                    let expected = npm_repository(package).ok_or("npm 来源超出已核对的固定闭包")?;
                    let leaf = package.rsplit('/').next().ok_or("npm 包名缺失")?;
                    if registry != NPM_REGISTRY
                        || canonical_repo(repository) != canonical_repo(expected)
                        || !exact_version(version)
                        || npm_url(tarball)?.path() != format!("/{package}/-/{leaf}-{version}.tgz")
                        || packages.insert(package.clone(), version.clone()).is_some()
                    {
                        return Err("npm 精确依赖来源无效或重复".into());
                    }
                    sri512(integrity)?;
                }
                _ => return Err("实际资产来源与运行包配方不同".into()),
            }
        }
        match (&self.recipe, &self.runtime) {
            (Recipe::AgentReachWheelV1, BuilderRuntime::PythonPip(_)) if github_count == 1 => {}
            (Recipe::EdgeMcpNpmV1, BuilderRuntime::Node(_))
                if packages.len() == 3
                    && packages.get("@playwright/mcp") == Some(&self.version)
                    && packages.contains_key("playwright")
                    && packages.get("playwright") == packages.get("playwright-core") => {}
            _ => return Err("运行包主版本、依赖闭包或共享执行环境不一致".into()),
        }
        let expected_executable = match self.recipe {
            Recipe::AgentReachWheelV1 => "python.exe",
            Recipe::EdgeMcpNpmV1 => "node.exe",
        };
        if !self.shared_runtime_binding().path.is_absolute()
            || !self
                .shared_runtime_binding()
                .path
                .file_name()
                .is_some_and(|name| name.eq_ignore_ascii_case(expected_executable))
        {
            return Err("运行包共享执行入口与配方不同".into());
        }
        Ok(())
    }
    pub(crate) fn shared_runtime_binding(&self) -> &RuntimeBinding {
        match &self.runtime {
            BuilderRuntime::PythonPip(pip) => &pip.interpreter,
            BuilderRuntime::Node(node) => node,
        }
    }
    pub(crate) fn recheck_shared_runtime(&self) -> Result<(), String> {
        self.validate_source()?;
        self.shared_runtime_binding().recheck()
    }
    pub(crate) fn source_repository(&self) -> Result<String, String> {
        self.validate_source()?;
        Ok(match self.recipe {
            Recipe::AgentReachWheelV1 => REACH_REPOSITORY,
            Recipe::EdgeMcpNpmV1 => "https://github.com/microsoft/playwright-mcp",
        }
        .into())
    }
}

/// Resolves only the reviewed package names and exact dependency edges. It
/// cannot install a package or grant permission to execute its contents.
pub(crate) fn resolve_edge_registry(version: &str) -> Result<NpmClosure, String> {
    if !exact_version(version) {
        return Err("请选择明确的 npm 包版本".into());
    }
    let mut pending = vec![("@playwright/mcp".to_owned(), version.to_owned())];
    let mut seen = BTreeSet::new();
    let mut packages = vec![];
    while let Some((name, version)) = pending.pop() {
        if !seen.insert((name.clone(), version.clone())) {
            continue;
        }
        if seen.len() > 3 {
            return Err("npm 运行依赖超出已核对的固定配方".into());
        }
        let mut url = Url::parse(NPM_REGISTRY).map_err(|_| "固定 registry 地址不可读取")?;
        url.path_segments_mut()
            .map_err(|_| "固定 registry 路径无效")?
            .push(&name)
            .push(&version);
        let value = json_response(url.as_str())?;
        let metadata = inspect_npm_metadata(&name, &version, &value)?;
        pending.extend(
            metadata
                .dependencies
                .iter()
                .map(|(name, version)| (name.clone(), version.clone())),
        );
        packages.push(metadata);
    }
    npm_closure(version, packages)
}

pub(crate) mod automation;
#[path = "resource_package/controller.rs"]
pub(crate) mod controller;
#[path = "resource_package/repair.rs"]
pub(crate) mod repair;
#[path = "resource_package/repair_python.rs"]
pub(crate) mod repair_python;
pub(crate) use controller::{apply_local, handle, store, StoreRequest};
#[path = "resource_package/download.rs"]
mod download;
#[path = "resource_package/tgz.rs"]
mod tgz;
pub(crate) use download::{PackageDownloadPlan, PackageDownloadReceipt};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadyNpmPlan {
    closure: NpmClosure,
    runtime: RuntimeBinding,
    artifacts: BTreeMap<String, ArtifactBinding>,
    inventories: BTreeMap<String, tgz::TarInventory>,
    destination: PathBuf,
    plan_hash: String,
}
impl ReadyNpmPlan {
    pub(crate) fn from_downloads(
        closure: NpmClosure,
        receipt: &PackageDownloadReceipt,
        manager_root: &Path,
        current_runtime: &Path,
        destination: &Path,
        node: &Path,
    ) -> Result<Self, String> {
        Self::bind(
            closure,
            &receipt.files()?,
            manager_root,
            current_runtime,
            destination,
            node,
        )
    }
    pub(crate) fn bind(
        closure: NpmClosure,
        downloaded: &BTreeMap<String, PathBuf>,
        manager_root: &Path,
        current_runtime: &Path,
        destination: &Path,
        node: &Path,
    ) -> Result<Self, String> {
        let root_version = closure
            .packages
            .iter()
            .find(|package| package.package == "@playwright/mcp")
            .ok_or("npm 闭包主包缺失")?
            .version
            .clone();
        let checked = npm_closure(&root_version, closure.packages.clone())?;
        if checked.metadata_hash != closure.metadata_hash
            || checked.node_major_minimum != closure.node_major_minimum
            || downloaded.len() != closure.packages.len()
        {
            return Err("npm 准备闭包已变化".into());
        }
        let destination = fresh_final_path(manager_root, current_runtime, destination)?;
        let runtime = RuntimeBinding::inspect(node)?;
        if !runtime
            .path
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case("node.exe"))
        {
            return Err("请选择已安装的 Node.js 入口".into());
        }
        if runtime
            .path
            .starts_with(crate::local::canonical(manager_root)?)
        {
            return Err("工具不能依赖管理器目录里的唯一 Node 环境".into());
        }
        let mut artifacts = BTreeMap::new();
        let mut inventories = BTreeMap::new();
        for package in &closure.packages {
            let path = downloaded
                .get(&package.package)
                .ok_or("npm 运行闭包缺少已下载的精确资产")?;
            artifacts.insert(package.package.clone(), verify_npm_archive(path, package)?);
            inventories.insert(package.package.clone(), tgz::inspect(path, package)?);
        }
        let plan_hash = sha256(&serde_json::to_vec(&json!({"recipe":Recipe::EdgeMcpNpmV1,"runtime":runtime,"closure":closure,"artifacts":artifacts,"inventories":inventories,"target":destination})).map_err(|e| e.to_string())?);
        Ok(Self {
            closure,
            runtime,
            artifacts,
            inventories,
            destination,
            plan_hash,
        })
    }
    pub(crate) fn preview(&self) -> Value {
        json!({"kind":"npmRuntimeMaterialization","recipe":Recipe::EdgeMcpNpmV1,"targetPath":self.destination,"runtime":self.runtime,"artifacts":self.artifacts,"files":self.inventories,"planHash":self.plan_hash,"nodeMajorMinimum":self.closure.node_major_minimum,"canApply":true,"executionVerified":false,"warnings":["只解包已核对的运行闭包及许可证，不执行npm脚本或安装浏览器","原配置、现有Edge会话与当前运行目录保持；共享Node仍在其原位置"]})
    }
    #[cfg(test)]
    pub(crate) fn materialize(self, temporary: &Path) -> Result<RuntimePackageReceipt, String> {
        self.materialize_with_checkpoint(temporary, |_| Ok(()))
    }
    pub(crate) fn materialize_with_checkpoint(
        self,
        temporary: &Path,
        mut checkpoint: impl FnMut(&RuntimePackageReceipt) -> Result<(), String>,
    ) -> Result<RuntimePackageReceipt, String> {
        self.runtime.recheck()?;
        if self.destination.exists() {
            return Err("npm 最终位置已出现内容，未覆盖".into());
        }
        crate::transaction::verify_root(temporary)?;
        if !temporary.is_dir() {
            return Err("请选择本次独立的准备临时目录".into());
        }
        for artifact in self.artifacts.values() {
            if resource_files::fingerprint(&artifact.path)? != artifact.file {
                return Err("npm 资产在应用前已变化".into());
            }
        }
        let minimum = self.closure.node_major_minimum;
        let spec = FixedChildSpec { executable:self.runtime.path.clone(), args:vec!["--no-warnings".into(), "-e".into(), format!("if(process.platform!=='win32'||process.arch!=='x64'||Number(process.versions.node.split('.')[0])<{minimum})process.exit(24)")], working_directory:temporary.to_owned(), remove_environment:vec!["NODE_OPTIONS".into(), "NODE_PATH".into()], environment:BTreeMap::new() };
        run_fixed(&spec, std::time::Duration::from_secs(15))?;
        let mut receipt = RuntimePackageReceipt {
            recipe: Recipe::EdgeMcpNpmV1,
            source_artifacts: self.artifacts.values().cloned().collect(),
            runtime: BuilderRuntime::Node(self.runtime.clone()),
            plan_hash: self.plan_hash,
            root: self.destination.clone(),
            files: vec![],
            created_paths: vec![],
            complete: false,
            error: None,
            dependency_check_passed: false,
            execution_verified: false,
            temporary_paths: vec![],
        };
        checkpoint(&receipt)?;
        std::fs::create_dir(&self.destination).map_err(|_| "最终目录已被占用，未解包")?;
        receipt.created_paths.push(self.destination.clone());
        checkpoint(&receipt)?;
        let result = (|| {
            let modules = self.destination.join("node_modules");
            std::fs::create_dir(&modules).map_err(|e| e.to_string())?;
            for package in &self.closure.packages {
                let artifact = self.artifacts.get(&package.package).ok_or("npm 资产丢失")?;
                let expected = self
                    .inventories
                    .get(&package.package)
                    .ok_or("npm 内容清单丢失")?;
                let target = crate::local::safe_join(&modules, &package.package)?;
                let parent = target.parent().ok_or("npm 目录父级不可读取")?;
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                tgz::extract(&artifact.path, package, expected, &target)?;
                observe_created_runtime(&mut receipt)?;
                checkpoint(&receipt)?;
            }
            self.runtime.recheck()?;
            receipt.dependency_check_passed = true;
            Ok(())
        })();
        let observed = crate::network::with_task_context(
            crate::network::TaskContext {
                foreground: false,
                cancel: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            },
            || observe_created_runtime(&mut receipt),
        );
        match observed {
            Ok(()) => {}
            Err(error) => {
                receipt.error = Some(format!(
                    "{}；创建文件范围未完整核对：{error}",
                    result.err().unwrap_or_default()
                ));
                checkpoint(&receipt)?;
                return Ok(receipt);
            }
        }
        receipt.complete = result.is_ok();
        receipt.error = result.err();
        checkpoint(&receipt)?;
        Ok(receipt)
    }
}

#[cfg(test)]
#[path = "resource_package/tests.rs"]
mod tests;
