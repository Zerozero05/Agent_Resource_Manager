//! Bounded npm tar inspection/extraction. No npm scripts or package code run.
use super::*;
use flate2::read::MultiGzDecoder;
use std::{fs::OpenOptions, io::Write};

const BLOCK: usize = 512;
const MAX_EXTENDED: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TarFile {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    pub license: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TarInventory {
    pub archive: Fingerprint,
    pub files: Vec<TarFile>,
    pub unpacked_bytes: u64,
}
struct Limited<R> {
    input: R,
    bytes: u64,
}
impl<R: Read> Read for Limited<R> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        crate::network::check_cancelled().map_err(std::io::Error::other)?;
        let maximum = output
            .len()
            .min((MAX_RUNTIME_BYTES + 1 - self.bytes) as usize);
        if maximum == 0 {
            return Err(std::io::Error::other("npm 展开流超过有限范围"));
        }
        let count = self.input.read(&mut output[..maximum])?;
        self.bytes += count as u64;
        if self.bytes > MAX_RUNTIME_BYTES {
            return Err(std::io::Error::other("npm 展开流超过有限范围"));
        }
        Ok(count)
    }
}
fn text(bytes: &[u8]) -> Result<String, String> {
    let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
    std::str::from_utf8(&bytes[..end])
        .map(str::to_owned)
        .map_err(|_| "npm tar 路径不是有效 UTF-8".into())
}
fn number(bytes: &[u8]) -> Result<u64, String> {
    if bytes.first().is_some_and(|byte| byte & 0x80 != 0) {
        return Err("npm tar 二进制数值格式尚未核对".into());
    }
    let value = text(bytes)?;
    let value = value.trim();
    if value.is_empty() {
        return Ok(0);
    }
    u64::from_str_radix(value, 8).map_err(|_| "npm tar 数值字段无效".into())
}
fn pax(bytes: &[u8]) -> Result<BTreeMap<String, String>, String> {
    let mut offset = 0usize;
    let mut fields = BTreeMap::new();
    while offset < bytes.len() {
        let space = bytes[offset..]
            .iter()
            .position(|b| *b == b' ')
            .ok_or("npm PAX 记录长度缺失")?
            + offset;
        let size = std::str::from_utf8(&bytes[offset..space])
            .map_err(|_| "npm PAX 长度无效")?
            .parse::<usize>()
            .map_err(|_| "npm PAX 长度无效")?;
        if size == 0
            || size > MAX_EXTENDED
            || offset + size > bytes.len()
            || offset + size <= space + 1
            || bytes[offset + size - 1] != b'\n'
        {
            return Err("npm PAX 记录范围无效".into());
        }
        let value = std::str::from_utf8(&bytes[space + 1..offset + size - 1])
            .map_err(|_| "npm PAX 字段不是 UTF-8")?;
        let (key, value) = value.split_once('=').ok_or("npm PAX 字段无效")?;
        if key == "linkpath" || key.starts_with("GNU.sparse") || key == "size" {
            return Err("npm PAX 含未经核对的链接或大小覆盖".into());
        }
        if fields.insert(key.into(), value.into()).is_some() {
            return Err("npm PAX 字段重复".into());
        }
        offset += size;
    }
    Ok(fields)
}
fn padding(input: &mut impl Read, size: u64) -> Result<(), String> {
    let count = ((BLOCK as u64 - size % BLOCK as u64) % BLOCK as u64) as usize;
    let mut bytes = [0u8; BLOCK];
    input
        .read_exact(&mut bytes[..count])
        .map_err(|_| "npm tar 数据补齐不完整")?;
    if bytes[..count].iter().any(|byte| *byte != 0) {
        return Err("npm tar 补齐数据无效".into());
    }
    Ok(())
}
fn register_path(
    seen: &mut BTreeMap<String, (String, bool)>,
    path: &str,
    directory: bool,
) -> Result<(), String> {
    let components: Vec<_> = path.split('/').collect();
    for end in 1..=components.len() {
        let value = components[..end].join("/");
        let is_dir = directory || end < components.len();
        let key = value.to_lowercase();
        match seen.get(&key) {
            Some((original, true)) if original == &value && is_dir => {}
            Some(_) => return Err("npm tar 存在重复、大小写或文件目录冲突".into()),
            None => {
                seen.insert(key, (value, is_dir));
            }
        }
    }
    Ok(())
}
fn package_path(raw: &str) -> Result<Option<String>, String> {
    if raw.trim_end_matches('/') == "package" {
        return Ok(None);
    }
    let value = raw
        .strip_prefix("package/")
        .ok_or("npm tar 必须使用唯一 package 根目录")?
        .trim_end_matches('/');
    crate::local::validate_relative_path(value)?;
    Ok(Some(value.into()))
}

enum Expectation<'a> {
    Registry(&'a NpmPackageMetadata),
    Recorded(&'a ArtifactBinding),
}
struct Identity {
    package: String,
    version: String,
    repository: String,
    tarball: String,
    integrity: String,
}
fn identity(expected: &Expectation<'_>) -> Result<Identity, String> {
    let value = match expected {
        Expectation::Registry(m) => Identity {
            package: m.package.clone(),
            version: m.version.clone(),
            repository: m.repository.clone(),
            tarball: m.tarball.clone(),
            integrity: m.integrity.clone(),
        },
        Expectation::Recorded(a) => match &a.origin {
            ArtifactOrigin::NpmRegistry {
                registry,
                package,
                version,
                repository,
                tarball,
                integrity,
            } if registry == NPM_REGISTRY => Identity {
                package: package.clone(),
                version: version.clone(),
                repository: repository.clone(),
                tarball: tarball.clone(),
                integrity: integrity.clone(),
            },
            _ => return Err("修复资产不是原 npm 精确来源".into()),
        },
    };
    let repository = npm_repository(&value.package).ok_or("npm 资产超出已核对配方")?;
    let leaf = value.package.rsplit('/').next().ok_or("npm 包名缺失")?;
    if canonical_repo(&value.repository) != canonical_repo(repository)
        || !exact_version(&value.version)
        || npm_url(&value.tarball)?.path()
            != format!("/{}/-/{leaf}-{}.tgz", value.package, value.version)
    {
        return Err("npm 原资产身份或地址不一致".into());
    }
    sri512(&value.integrity)?;
    Ok(value)
}

/// Inspects the entire compressed stream, including CRC/end padding. Extraction
/// uses create-new files only and can never follow tar links or invoke hooks.
fn walk(
    archive: &Path,
    metadata: &NpmPackageMetadata,
    destination: Option<&Path>,
) -> Result<TarInventory, String> {
    walk_expected(archive, Expectation::Registry(metadata), destination, None)
        .map(|(inventory, _)| inventory)
}
fn walk_expected(
    archive: &Path,
    expected: Expectation<'_>,
    destination: Option<&Path>,
    selected: Option<&BTreeMap<String, PathBuf>>,
) -> Result<(TarInventory, NpmPackageMetadata), String> {
    let metadata = identity(&expected)?;
    let before = resource_files::fingerprint(archive)?;
    if before.bytes > MAX_ARCHIVE {
        return Err("npm 资产超过有限范围".into());
    }
    if let Expectation::Recorded(record) = &expected {
        if before.bytes != record.file.bytes || before.sha256 != record.file.sha256 {
            return Err("原 npm 资产摘要或长度不一致，未修复".into());
        }
    }
    let mut compressed = File::open(archive).map_err(|e| e.to_string())?;
    let mut integrity = Sha512::new();
    let mut bytes = [0u8; 64 * 1024];
    loop {
        crate::network::check_cancelled()?;
        let count = compressed.read(&mut bytes).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        integrity.update(&bytes[..count]);
    }
    if sri512(&metadata.integrity)?.as_slice() != integrity.finalize().as_slice()
        || resource_files::fingerprint(archive)? != before
    {
        return Err("npm 原资产 integrity 不一致或读取时变化".into());
    }
    if let Some(selected) = selected {
        for (relative, path) in selected {
            crate::local::validate_relative_path(relative)?;
            crate::transaction::verify_root(path)?;
            if !path.is_absolute() || path.try_exists().map_err(|e| e.to_string())? {
                return Err("修复候选位置必须是新的绝对路径".into());
            }
        }
    }
    let decoder = MultiGzDecoder::new(File::open(archive).map_err(|e| e.to_string())?);
    let mut input = Limited {
        input: decoder,
        bytes: 0,
    };
    let mut files = vec![];
    let mut seen = BTreeMap::new();
    let mut total = 0u64;
    let mut count = 0usize;
    let mut extended = BTreeMap::new();
    let mut long_name = None;
    let mut package_json = None;
    loop {
        let mut header = [0u8; BLOCK];
        input
            .read_exact(&mut header)
            .map_err(|_| "npm tar 头或结束标记不完整")?;
        if header.iter().all(|byte| *byte == 0) {
            let mut second = [0u8; BLOCK];
            input
                .read_exact(&mut second)
                .map_err(|_| "npm tar 结束块缺失")?;
            if second.iter().any(|byte| *byte != 0) {
                return Err("npm tar 结束块后有隐藏条目".into());
            }
            let mut rest = [0u8; 8192];
            loop {
                let bytes = input
                    .read(&mut rest)
                    .map_err(|_| "npm gzip 校验失败或展开流超过有限范围")?;
                if bytes == 0 {
                    break;
                }
                if rest[..bytes].iter().any(|byte| *byte != 0) {
                    return Err("npm tar 结束后有附加非空数据".into());
                }
            }
            break;
        }
        count += 1;
        if count > MAX_RUNTIME_FILES {
            return Err("npm tar 条目数超过本次有限范围".into());
        }
        let expected = number(&header[148..156])?;
        let checksum: u64 = header
            .iter()
            .enumerate()
            .map(|(index, value)| {
                if (148..156).contains(&index) {
                    b' ' as u64
                } else {
                    *value as u64
                }
            })
            .sum();
        if checksum != expected || !header[257..263].starts_with(b"ustar") {
            return Err("npm tar 头校验或格式不符".into());
        }
        let size = number(&header[124..136])?;
        let flag = header[156];
        if matches!(flag, b'x' | b'L') {
            if size == 0 || size > MAX_EXTENDED as u64 {
                return Err("npm tar 扩展头超过有限范围".into());
            }
            let mut bytes = vec![0u8; size as usize];
            input
                .read_exact(&mut bytes)
                .map_err(|_| "npm tar 扩展头数据缺失")?;
            padding(&mut input, size)?;
            if flag == b'x' {
                if !extended.is_empty() {
                    return Err("npm tar 重复 PAX 覆盖".into());
                }
                extended = pax(&bytes)?;
            } else {
                if long_name.is_some() {
                    return Err("npm tar 重复长路径覆盖".into());
                }
                long_name = Some(text(&bytes)?);
            }
            continue;
        }
        if !matches!(flag, 0 | b'0' | b'5') {
            return Err("npm tar 含链接、设备或未经核对的特殊条目".into());
        }
        let directory = flag == b'5';
        if directory && size != 0 {
            return Err("npm tar 目录不能含文件数据".into());
        }
        let prefix = text(&header[345..500])?;
        let mut raw = text(&header[..100])?;
        if !prefix.is_empty() {
            raw = format!("{prefix}/{raw}");
        }
        let pax_path = extended.remove("path");
        if let Some(path) = &pax_path {
            raw = path.clone();
        }
        if let Some(path) = long_name.take() {
            if pax_path.is_some() && path != raw {
                return Err("npm tar 长路径覆盖冲突".into());
            }
            raw = path;
        }
        extended.clear();
        let relative = package_path(&raw)?;
        let Some(relative) = relative else {
            if !directory {
                return Err("npm tar 根条目不是目录".into());
            }
            continue;
        };
        register_path(&mut seen, &relative, directory)?;
        if directory {
            continue;
        }
        total = total.checked_add(size).ok_or("npm tar 大小溢出")?;
        if total > MAX_RUNTIME_BYTES {
            return Err("npm tar 文件量超过本次有限范围".into());
        }
        let output_path = if let Some(root) = destination {
            Some(crate::local::safe_join(root, &relative)?)
        } else {
            selected.and_then(|s| s.get(&relative)).cloned()
        };
        let mut output = if let Some(path) = output_path {
            let parent = path.parent().ok_or("npm 文件没有父目录")?;
            if destination.is_some() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            crate::transaction::verify_root(parent)?;
            Some(
                OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&path)
                    .map_err(|e| e.to_string())?,
            )
        } else {
            None
        };
        if relative == "package.json" && size > MAX_METADATA {
            return Err("npm package.json 超过有限范围".into());
        }
        let mut body = Vec::new();
        let mut remaining = size;
        let mut buffer = [0u8; 64 * 1024];
        let mut hash = Sha256::new();
        while remaining > 0 {
            let maximum = buffer.len().min(remaining as usize);
            input
                .read_exact(&mut buffer[..maximum])
                .map_err(|_| "npm tar 文件数据不完整")?;
            hash.update(&buffer[..maximum]);
            if relative == "package.json" {
                body.extend_from_slice(&buffer[..maximum]);
            }
            if let Some(file) = output.as_mut() {
                file.write_all(&buffer[..maximum])
                    .map_err(|e| e.to_string())?;
            }
            remaining -= maximum as u64;
        }
        if let Some(file) = output.as_mut() {
            file.sync_all().map_err(|e| e.to_string())?;
        }
        if relative == "package.json" {
            package_json = Some(
                serde_json::from_slice::<Value>(&body).map_err(|_| "npm 包内 package.json 无效")?,
            );
        }
        padding(&mut input, size)?;
        files.push(TarFile {
            license: crate::local::license_path(&relative),
            path: relative,
            bytes: size,
            sha256: format!("{:x}", hash.finalize()),
        });
    }
    if !extended.is_empty() || long_name.is_some() {
        return Err("npm tar 扩展头没有对应条目".into());
    }
    let mut package_json = package_json.ok_or("npm 运行包缺少 package.json")?;
    // dist is a registry declaration, not normally copied into package.json.
    package_json["dist"] = json!({"tarball":metadata.tarball,"integrity":metadata.integrity});
    let actual = inspect_npm_metadata(&metadata.package, &metadata.version, &package_json)?;
    if let Expectation::Registry(expected) = expected {
        if actual.dependencies != expected.dependencies
            || actual.license != expected.license
            || actual.node_requirement != expected.node_requirement
        {
            return Err("npm 包内身份、依赖或许可与 registry 固定元数据不一致".into());
        }
    }
    if !files.iter().any(|file| file.license) {
        return Err("npm 运行包缺少应保留的实际许可文件".into());
    }
    let required: &[&str] = match metadata.package.as_str() {
        "@playwright/mcp" => &["cli.js", "package.json"],
        "playwright" => &["index.js", "package.json"],
        "playwright-core" => &[
            "index.js",
            "package.json",
            "lib/bootstrap.js",
            "lib/coreBundle.js",
            "lib/utilsBundle.js",
        ],
        _ => return Err("npm 运行包不在已核对配方内".into()),
    };
    if required
        .iter()
        .any(|path| !files.iter().any(|file| file.path == *path))
    {
        return Err("npm 运行包缺少所选能力的入口或实际控制库".into());
    }
    if resource_files::fingerprint(archive)? != before {
        return Err("npm tar 检查期间资产发生变化".into());
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    if selected.is_some_and(|chosen| chosen.keys().any(|p| !files.iter().any(|f| &f.path == p))) {
        return Err("原 npm 资产缺少已选修复条目，候选文件保留".into());
    }
    Ok((
        TarInventory {
            archive: before,
            files,
            unpacked_bytes: total,
        },
        actual,
    ))
}

/// Recover metadata from the actual SRI-bound package.json, not from a fabricated
/// registry response. The original recorded origin still fixes package/version.
pub(crate) fn inspect_recorded(
    artifact: &ArtifactBinding,
) -> Result<(TarInventory, NpmPackageMetadata), String> {
    walk_expected(&artifact.path, Expectation::Recorded(artifact), None, None)
}
pub(crate) fn read_selected(
    artifact: &ArtifactBinding,
    expected: &TarInventory,
    targets: &BTreeMap<String, PathBuf>,
) -> Result<(), String> {
    if resource_files::fingerprint(&artifact.path)? != expected.archive {
        return Err("修复预览后 npm 原资产发生变化".into());
    }
    let (observed, _) = walk_expected(
        &artifact.path,
        Expectation::Recorded(artifact),
        None,
        Some(targets),
    )?;
    if observed.archive != expected.archive || observed.files != expected.files {
        return Err("读取修复条目时原资产变化，候选文件保持".into());
    }
    Ok(())
}
pub(crate) fn inspect(
    archive: &Path,
    metadata: &NpmPackageMetadata,
) -> Result<TarInventory, String> {
    walk(archive, metadata, None)
}
pub(crate) fn extract(
    archive: &Path,
    metadata: &NpmPackageMetadata,
    expected: &TarInventory,
    destination: &Path,
) -> Result<Vec<resource_files::OwnedFile>, String> {
    if destination.exists() || resource_files::fingerprint(archive)? != expected.archive {
        return Err("npm 最终目录或已检查资产发生变化".into());
    }
    let before = inspect(archive, metadata)?;
    if before.files != expected.files {
        return Err("npm 内容清单发生变化".into());
    }
    std::fs::create_dir(destination).map_err(|e| e.to_string())?;
    let observed = walk(archive, metadata, Some(destination))?;
    if observed.files != expected.files {
        return Err("npm 解包结果与已核对清单不同，部分目录保持供核对".into());
    }
    Ok(observed
        .files
        .into_iter()
        .map(|file| resource_files::OwnedFile {
            path: file.path,
            role: if file.license {
                resource_files::FileRole::License
            } else {
                resource_files::FileRole::Runtime
            },
            installed_sha256: file.sha256,
        })
        .collect())
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    pub(in crate::resource_package) fn tar(files: Vec<(&str, &[u8], u8)>) -> Vec<u8> {
        let mut bytes = vec![];
        for (name, data, kind) in files {
            let mut header = [0u8; BLOCK];
            assert!(name.len() < 100);
            header[..name.len()].copy_from_slice(name.as_bytes());
            header[100..108].copy_from_slice(b"0000644\0");
            header[108..116].copy_from_slice(b"0000000\0");
            header[116..124].copy_from_slice(b"0000000\0");
            header[124..136].copy_from_slice(format!("{:011o}\0", data.len()).as_bytes());
            header[136..148].copy_from_slice(b"00000000000\0");
            header[148..156].fill(b' ');
            header[156] = kind;
            header[257..263].copy_from_slice(b"ustar\0");
            header[263..265].copy_from_slice(b"00");
            let checksum: u64 = header.iter().map(|byte| *byte as u64).sum();
            header[148..156].copy_from_slice(format!("{checksum:06o}\0 ").as_bytes());
            bytes.extend_from_slice(&header);
            bytes.extend_from_slice(data);
            bytes.resize(bytes.len() + (BLOCK - data.len() % BLOCK) % BLOCK, 0);
        }
        bytes.resize(bytes.len() + BLOCK * 2, 0);
        bytes
    }
    fn archive(root: &Path, extra: Vec<(&str, &[u8], u8)>) -> (PathBuf, NpmPackageMetadata) {
        let manifest = json!({"name":"@playwright/mcp","version":"0.0.83","repository":{"url":"git+https://github.com/microsoft/playwright-mcp.git"},"license":"Apache-2.0","engines":{"node":">=18"},"dependencies":{"playwright":"1.64.0-alpha-1790635538000","playwright-core":"1.64.0-alpha-1790635538000"}});
        let json = serde_json::to_vec(&manifest).unwrap();
        let mut files = vec![
            ("package/package.json", json.as_slice(), b'0'),
            (
                "package/LICENSE",
                b"Synthetic fixture license".as_slice(),
                b'0',
            ),
            (
                "package/cli.js",
                b"// synthetic never-executed entry".as_slice(),
                b'0',
            ),
        ];
        files.extend(extra);
        let mut compressed = GzEncoder::new(Vec::new(), Compression::default());
        compressed.write_all(&tar(files)).unwrap();
        let bytes = compressed.finish().unwrap();
        let file = root.join("package.tgz");
        std::fs::write(&file, &bytes).unwrap();
        let mut registry = manifest;
        registry["dist"] = json!({"tarball":"https://registry.npmjs.org/@playwright/mcp/-/mcp-0.0.83.tgz","integrity":format!("sha512-{}",general_purpose::STANDARD.encode(Sha512::digest(&bytes)))});
        (
            file,
            inspect_npm_metadata("@playwright/mcp", "0.0.83", &registry).unwrap(),
        )
    }
    #[test]
    fn actual_tgz_is_streamed_checked_and_extracted_without_running_the_package() {
        let dir = tempfile::tempdir().unwrap();
        let (file, meta) = archive(dir.path(), vec![]);
        let inspected = inspect(&file, &meta).unwrap();
        assert_eq!(inspected.files.len(), 3);
        let target = dir.path().join("new-runtime");
        let receipt = extract(&file, &meta, &inspected, &target).unwrap();
        assert_eq!(receipt.len(), 3);
        assert!(receipt
            .iter()
            .any(|file| file.role == resource_files::FileRole::License));
        assert_eq!(
            std::fs::read_to_string(target.join("cli.js")).unwrap(),
            "// synthetic never-executed entry"
        );
        assert!(extract(&file, &meta, &inspected, &target).is_err());
    }
    #[test]
    fn tar_links_traversal_case_collisions_and_special_entries_are_rejected_before_extract() {
        for entries in [
            vec![("package/../../escape", b"bad".as_slice(), b'0')],
            vec![("package/LINK", b"".as_slice(), b'2')],
            vec![("package/cli.js", b"again".as_slice(), b'0')],
            vec![("package/CLI.js", b"collision".as_slice(), b'0')],
            vec![("package/device", b"".as_slice(), b'3')],
        ] {
            let dir = tempfile::tempdir().unwrap();
            let (file, meta) = archive(dir.path(), entries);
            assert!(inspect(&file, &meta).is_err());
            assert!(!dir.path().join("escape").exists());
        }
    }
    #[test]
    fn pax_parsing_is_bounded_and_cannot_replace_size_or_link_targets() {
        assert_eq!(
            pax(b"25 path=package/file.txt\n").unwrap()["path"],
            "package/file.txt"
        );
        assert!(pax(b"999999999999999 path=x\n").is_err());
        assert!(pax(b"10 size=1\n").is_err());
        assert!(pax(b"14 linkpath=x\n").is_err());
    }
}
