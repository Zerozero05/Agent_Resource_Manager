//! File ownership and minimal ZIP installation. No recursive deletion or backups.
//! The caller supplies a fixed, approved scope and owns the human approval gate.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Fingerprint {
    pub bytes: u64,
    pub sha256: String,
    pub modified: String,
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

fn stamp(meta: &fs::Metadata) -> Result<String, String> {
    meta.modified()
        .and_then(|time| {
            time.duration_since(UNIX_EPOCH)
                .map_err(std::io::Error::other)
        })
        .map(|time| time.as_nanos().to_string())
        .map_err(|e| e.to_string())
}

pub(crate) fn fingerprint(path: &Path) -> Result<Fingerprint, String> {
    let before = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !before.is_file() || linked(&before) {
        return Err(format!("目标不是普通文件：{}", path.display()));
    }
    let before_stamp = stamp(&before)?;
    let mut input = File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut bytes = 0u64;
    loop {
        crate::network::check_cancelled()?;
        let count = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        hash.update(&buffer[..count]);
    }
    let after = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if linked(&after)
        || bytes != before.len()
        || after.len() != before.len()
        || stamp(&after)? != before_stamp
    {
        return Err(format!("读取期间文件变化，请重新预览：{}", path.display()));
    }
    Ok(Fingerprint {
        bytes,
        sha256: format!("{:x}", hash.finalize()),
        modified: before_stamp,
    })
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum FileRole {
    Runtime,
    PrivateDependency,
    License,
    Configuration,
    UserData,
    Cache,
    LocalModification,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OwnedFile {
    pub path: String,
    pub role: FileRole,
    pub installed_sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackageFile {
    pub path: String,
    pub bytes: u64,
    pub license: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackageInventory {
    pub archive: Fingerprint,
    pub files: Vec<PackageFile>,
    pub unpacked_bytes: u64,
}

/// Inspect every name before accepting any selected file; unsafe unselected names
/// still make the asset unsuitable for this installation.
pub(crate) fn inspect_zip(path: &Path, maximum_bytes: u64) -> Result<PackageInventory, String> {
    let archive = fingerprint(path)?;
    let mut zip = zip::ZipArchive::new(File::open(path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("无法读取发行包：{e}"))?;
    let mut files = Vec::new();
    let mut names = BTreeSet::new();
    let mut unpacked_bytes = 0u64;
    for index in 0..zip.len() {
        if index >= 50_000 {
            return Err("发行包文件数过多，请选择适用平台的最小发行包".into());
        }
        crate::network::check_cancelled()?;
        let entry = zip.by_index(index).map_err(|e| e.to_string())?;
        let name = entry.name().trim_end_matches('/');
        crate::local::validate_relative_path(name)?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(format!("发行包包含链接，需明确适配后处理：{name}"));
        }
        if !names.insert(name.to_lowercase()) {
            return Err(format!("发行包包含重复或大小写冲突的路径：{name}"));
        }
        if entry.is_dir() {
            continue;
        }
        unpacked_bytes = unpacked_bytes
            .checked_add(entry.size())
            .ok_or("发行包大小溢出")?;
        if unpacked_bytes > maximum_bytes {
            return Err("发行包展开大小超过本次批准上限".into());
        }
        files.push(PackageFile {
            path: name.into(),
            bytes: entry.size(),
            license: crate::local::license_path(name),
        });
    }
    if fingerprint(path)? != archive {
        return Err("发行包在检查期间发生变化".into());
    }
    Ok(PackageInventory {
        archive,
        files,
        unpacked_bytes,
    })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallReceipt {
    pub root: PathBuf,
    pub files: Vec<OwnedFile>,
    pub created_paths: Vec<PathBuf>,
    pub complete: bool,
    pub error: Option<String>,
}

/// Only installs explicit files plus the asset's licenses to a new final directory.
/// Partial output is retained and reported; it is never promoted to a working version.
pub(crate) fn install_zip(
    archive: &Path,
    inventory: &PackageInventory,
    selected: &[String],
    destination: &Path,
) -> Result<InstallReceipt, String> {
    crate::transaction::verify_root(destination)?;
    if destination.exists() {
        return Err("安装目标必须是尚不存在的新版本目录".into());
    }
    let parent = destination.parent().ok_or("安装目录没有父目录")?;
    if !parent.is_dir() {
        return Err("请先选择存在且可写的持久父目录".into());
    }
    if fingerprint(archive)? != inventory.archive {
        return Err("发行包已变化，请重新预览".into());
    }
    let by_name: BTreeMap<_, _> = inventory
        .files
        .iter()
        .map(|file| (file.path.clone(), file))
        .collect();
    let mut paths = BTreeSet::new();
    if selected.is_empty() {
        return Err("至少选择一个已核实的运行文件".into());
    }
    for name in selected {
        crate::local::validate_relative_path(name)?;
        if !by_name.contains_key(name) {
            return Err(format!("选择的文件不在已核验发行包内：{name}"));
        }
        paths.insert(name.clone());
    }
    paths.extend(
        inventory
            .files
            .iter()
            .filter(|file| file.license)
            .map(|file| file.path.clone()),
    );
    let mut zip = zip::ZipArchive::new(File::open(archive).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    fs::create_dir(destination).map_err(|e| e.to_string())?;
    let mut receipt = InstallReceipt {
        root: destination.to_owned(),
        files: vec![],
        created_paths: vec![destination.to_owned()],
        complete: false,
        error: None,
    };
    let outcome = (|| {
        for name in paths {
            crate::network::check_cancelled()?;
            crate::transaction::verify_root(destination)?;
            let target = crate::local::safe_join(destination, &name)?;
            let parent = target.parent().ok_or("文件没有父目录")?;
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            crate::transaction::verify_root(parent)?;
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map_err(|e| e.to_string())?;
            receipt.created_paths.push(target.clone());
            let mut input = zip.by_name(&name).map_err(|e| e.to_string())?;
            let maximum = by_name[&name].bytes;
            let mut bytes = 0u64;
            let mut digest = Sha256::new();
            let mut buffer = [0u8; 64 * 1024];
            loop {
                crate::network::check_cancelled()?;
                let count = input.read(&mut buffer).map_err(|e| e.to_string())?;
                if count == 0 {
                    break;
                }
                bytes += count as u64;
                if bytes > maximum {
                    return Err("解包数据超过已核验大小".into());
                }
                output
                    .write_all(&buffer[..count])
                    .map_err(|e| e.to_string())?;
                digest.update(&buffer[..count]);
            }
            output.sync_all().map_err(|e| e.to_string())?;
            if bytes != maximum {
                return Err(format!("文件展开长度不完整：{name}"));
            }
            drop(output);
            let sha256 = format!("{:x}", digest.finalize());
            if fingerprint(&target)?.sha256 != sha256 {
                return Err(format!("落盘内容核验失败：{name}"));
            }
            receipt.files.push(OwnedFile {
                path: name.clone(),
                role: if by_name[&name].license {
                    FileRole::License
                } else {
                    FileRole::Runtime
                },
                installed_sha256: sha256,
            });
        }
        if fingerprint(archive)? != inventory.archive {
            return Err("解包期间发行包发生变化".into());
        }
        Ok(())
    })();
    match outcome {
        Ok(()) => receipt.complete = true,
        Err(error) => receipt.error = Some(error),
    }
    Ok(receipt)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairEntry {
    pub path: String,
    pub role: FileRole,
    pub decision: String,
    pub reason: String,
    pub target: PathBuf,
    pub temporary_path: Option<PathBuf>,
    pub expected: Option<Fingerprint>,
    pub installed_sha256: String,
    pub bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairPlan {
    pub id: String,
    pub root: PathBuf,
    pub root_identity: String,
    pub entries: Vec<RepairEntry>,
    pub required_bytes: u64,
}

fn optional_fingerprint(path: &Path) -> Result<Option<Fingerprint>, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => fingerprint(path).map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub(crate) fn preview_repair(
    root: &Path,
    owned: &[OwnedFile],
    inventory: &PackageInventory,
) -> Result<RepairPlan, String> {
    preview_repair_files(root, owned, &inventory.files)
}

/// File-scope planning is shared by verified ZIP and npm payload readers. It
/// conveys no archive provenance; each reader must separately bind its source.
pub(crate) fn preview_repair_files(
    root: &Path,
    owned: &[OwnedFile],
    files: &[PackageFile],
) -> Result<RepairPlan, String> {
    crate::transaction::verify_root(root)?;
    let root = crate::local::canonical(root)?;
    let id = uuid::Uuid::new_v4().to_string();
    let mut entries = Vec::new();
    let mut known = BTreeSet::new();
    let mut required_bytes = 0u64;
    for file in owned {
        if !known.insert(file.path.to_lowercase()) {
            return Err("归属清单包含重复路径".into());
        }
        let target = crate::local::safe_join(&root, &file.path)?;
        let expected = optional_fingerprint(&target)?;
        let eligible = matches!(
            file.role,
            FileRole::Runtime | FileRole::PrivateDependency | FileRole::License
        );
        let restore = expected.is_none() && eligible;
        let (reason, bytes, temporary_path) = if restore {
            if file.installed_sha256.len() != 64
                || !file.installed_sha256.bytes().all(|c| c.is_ascii_hexdigit())
            {
                return Err(format!("文件缺少可信安装摘要：{}", file.path));
            }
            let original = files
                .iter()
                .find(|entry| entry.path == file.path)
                .ok_or_else(|| format!("固定发行包缺少原安装文件：{}", file.path))?;
            required_bytes = required_bytes
                .checked_add(original.bytes)
                .ok_or("修复空间溢出")?;
            let temporary = crate::local::safe_join(
                &root,
                &format!(".arm-repair-{id}-{}.part", entries.len()),
            )?;
            if fs::symlink_metadata(&temporary).is_ok() {
                return Err("修复临时位置已存在，请重新预览".into());
            }
            (
                "仅补齐已登记且缺失的运行文件".to_owned(),
                original.bytes,
                Some(temporary),
            )
        } else {
            (
                if expected.is_none() {
                    "配置、数据、缓存及本地改造不从发行包补写"
                } else {
                    "现有文件原样保留，包括本地改造"
                }
                .into(),
                0,
                None,
            )
        };
        entries.push(RepairEntry {
            path: file.path.clone(),
            role: file.role.clone(),
            decision: if restore { "restore" } else { "preserve" }.into(),
            reason,
            target,
            temporary_path,
            expected,
            installed_sha256: file.installed_sha256.clone(),
            bytes,
        });
    }
    Ok(RepairPlan {
        id,
        root_identity: crate::clients::file_identity(&root)?,
        root,
        entries,
        required_bytes,
    })
}

pub(crate) fn verify_repair(
    archive: &Path,
    inventory: &PackageInventory,
    plan: &RepairPlan,
) -> Result<(), String> {
    crate::transaction::verify_root(&plan.root)?;
    if crate::local::canonical(&plan.root)? != plan.root
        || fingerprint(archive)? != inventory.archive
    {
        return Err("原发行包或运行根目录已变化，请重新预览".into());
    }
    verify_repair_scope(plan)
}

pub(crate) fn verify_repair_scope(plan: &RepairPlan) -> Result<(), String> {
    crate::transaction::verify_root(&plan.root)?;
    if crate::local::canonical(&plan.root)? != plan.root
        || crate::clients::file_identity(&plan.root)? != plan.root_identity
    {
        return Err("原运行目录或对象身份已变化，请重新预览".into());
    }
    for entry in &plan.entries {
        let target = crate::local::safe_join(&plan.root, &entry.path)?;
        if target != entry.target || optional_fingerprint(&target)? != entry.expected {
            return Err(format!("修复清单已失效，未写入：{}", entry.path));
        }
        if let Some(temporary) = &entry.temporary_path {
            crate::transaction::verify_root(temporary)?;
            if temporary.parent() != Some(plan.root.as_path())
                || temporary.try_exists().map_err(|e| e.to_string())?
            {
                return Err("本次新临时位置已变化，未写入".into());
            }
        }
    }
    let (_, available) = crate::storage::destination_space(&plan.root)?;
    if available.is_some_and(|bytes| bytes < plan.required_bytes) {
        return Err("运行目录空间不足，未开始修复".into());
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairReceipt {
    pub restored: Vec<PathBuf>,
    pub retained: Vec<PathBuf>,
    pub failures: Vec<(PathBuf, String)>,
    pub temporary_paths: Vec<PathBuf>,
}

pub(crate) fn publish_repaired(temporary: &Path, target: &Path) -> Result<(), String> {
    crate::transaction::verify_root(temporary)?;
    crate::transaction::verify_root(target)?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let from: Vec<_> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<_> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {
            windows_sys::Win32::Storage::FileSystem::MoveFileExW(from.as_ptr(), to.as_ptr(), 0)
        } == 0
        {
            return Err(format!(
                "无法提交修复文件，未覆盖目标：{}",
                std::io::Error::last_os_error()
            ));
        }
    }
    #[cfg(not(windows))]
    fs::hard_link(temporary, target).map_err(|e| e.to_string())?;
    Ok(())
}

/// Restores only the already-owned missing runtime subset. Temporary files are
/// new candidate bytes, never copies of existing content or implicit backups.
pub(crate) fn repair_zip(
    archive: &Path,
    inventory: &PackageInventory,
    plan: &RepairPlan,
) -> Result<RepairReceipt, String> {
    repair_zip_with(archive, inventory, plan, |_| Ok(()))
}
fn repair_zip_with(
    archive: &Path,
    inventory: &PackageInventory,
    plan: &RepairPlan,
    mut before_publish: impl FnMut(&RepairEntry) -> Result<(), String>,
) -> Result<RepairReceipt, String> {
    verify_repair(archive, inventory, plan)?;
    let mut zip = zip::ZipArchive::new(File::open(archive).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut receipt = RepairReceipt {
        restored: vec![],
        retained: plan
            .entries
            .iter()
            .filter(|e| e.decision == "preserve")
            .map(|e| e.target.clone())
            .collect(),
        failures: vec![],
        temporary_paths: vec![],
    };
    for entry in plan.entries.iter().filter(|e| e.decision == "restore") {
        let outcome: Result<(), String> = (|| {
            crate::network::check_cancelled()?;
            let target = crate::local::safe_join(&plan.root, &entry.path)?;
            if optional_fingerprint(&target)?.is_some() {
                return Err("目标出现已有文件，未覆盖".into());
            }
            let temporary = entry.temporary_path.as_ref().ok_or("预览缺少新临时位置")?;
            crate::transaction::verify_root(temporary)?;
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(temporary)
                .map_err(|e| e.to_string())?;
            receipt.temporary_paths.push(temporary.clone());
            let mut input = zip.by_name(&entry.path).map_err(|e| e.to_string())?;
            let mut hash = Sha256::new();
            let mut bytes = 0u64;
            let mut buffer = [0u8; 64 * 1024];
            loop {
                crate::network::check_cancelled()?;
                let count = input.read(&mut buffer).map_err(|e| e.to_string())?;
                if count == 0 {
                    break;
                }
                bytes += count as u64;
                if bytes > entry.bytes {
                    return Err("修复文件超过已核验长度".into());
                }
                output
                    .write_all(&buffer[..count])
                    .map_err(|e| e.to_string())?;
                hash.update(&buffer[..count]);
            }
            output.sync_all().map_err(|e| e.to_string())?;
            drop(output);
            let actual = fingerprint(temporary)?;
            if bytes != entry.bytes
                || actual.bytes != entry.bytes
                || format!("{:x}", hash.finalize()) != entry.installed_sha256
                || actual.sha256 != entry.installed_sha256
            {
                return Err("候选文件与原安装摘要不符，未提交".into());
            }
            before_publish(entry)?;
            crate::network::check_cancelled()?;
            if crate::clients::file_identity(&plan.root)? != plan.root_identity {
                return Err("修复期间原运行目录被替换，未继续发布".into());
            }
            let target = crate::local::safe_join(&plan.root, &entry.path)?;
            let parent = target.parent().ok_or("修复文件没有父目录")?;
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            crate::transaction::verify_root(parent)?;
            publish_repaired(temporary, &target)?;
            if !temporary.try_exists().map_err(|e| e.to_string())? {
                receipt.temporary_paths.retain(|p| p != temporary);
            }
            if fingerprint(&target)?.sha256 != entry.installed_sha256 {
                return Err("提交后文件变化，需重新核验".into());
            }
            receipt.restored.push(target.clone());
            Ok(())
        })();
        if let Err(error) = outcome {
            receipt.failures.push((entry.target.clone(), error));
            break;
        }
    }
    for entry in plan.entries.iter().filter(|e| e.decision == "restore") {
        if !receipt.restored.contains(&entry.target)
            && !receipt
                .failures
                .iter()
                .any(|(path, _)| path == &entry.target)
        {
            receipt
                .failures
                .push((entry.target.clone(), "前序文件失败，本次尚未执行".into()));
        }
    }
    if let Err(error) = fingerprint(archive).and_then(|current| {
        if current == inventory.archive {
            Ok(())
        } else {
            Err("修复期间原发行包发生变化".into())
        }
    }) {
        receipt.failures.push((archive.to_owned(), error));
    }
    Ok(receipt)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RemovalExtent {
    Disable,
    Runtime,
    Complete,
    Custom,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemovalEntry {
    pub path: PathBuf,
    pub relative: String,
    pub role: FileRole,
    pub remove: bool,
    pub reason: String,
    pub expected: Option<Fingerprint>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemovalPlan {
    pub id: String,
    pub root: PathBuf,
    pub extent: RemovalExtent,
    pub entries: Vec<RemovalEntry>,
}

pub(crate) fn preview_removal(
    root: &Path,
    owned: &[OwnedFile],
    extent: RemovalExtent,
    custom: &[String],
) -> Result<RemovalPlan, String> {
    crate::transaction::verify_root(root)?;
    let resolved = crate::local::canonical(root)?;
    let mut entries = Vec::new();
    let mut known = BTreeSet::new();
    for file in owned {
        if !known.insert(file.path.to_lowercase()) {
            return Err("归属清单包含重复路径".into());
        }
        let target = crate::local::safe_join(&resolved, &file.path)?;
        let current = match fs::symlink_metadata(&target) {
            Ok(_) => Some(fingerprint(&target)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.to_string()),
        };
        let requested = match extent {
            RemovalExtent::Disable => false,
            RemovalExtent::Runtime => matches!(
                file.role,
                FileRole::Runtime | FileRole::PrivateDependency | FileRole::License
            ),
            RemovalExtent::Complete => true,
            RemovalExtent::Custom => custom.contains(&file.path),
        };
        let changed_runtime = matches!(
            file.role,
            FileRole::Runtime | FileRole::PrivateDependency | FileRole::License
        ) && current
            .as_ref()
            .is_some_and(|current| current.sha256 != file.installed_sha256);
        let (remove, reason) = if current.is_none() {
            (false, "文件已不存在")
        } else if changed_runtime && extent != RemovalExtent::Custom {
            (false, "运行文件有本地改造；保留，需在自定义范围中明确选择")
        } else if requested {
            (true, "本次所选程度内的已登记文件")
        } else {
            (false, "本次保留")
        };
        entries.push(RemovalEntry {
            path: target,
            relative: file.path.clone(),
            role: file.role.clone(),
            remove,
            reason: reason.into(),
            expected: current,
        });
    }
    if extent == RemovalExtent::Custom
        && custom
            .iter()
            .any(|path| !owned.iter().any(|file| file.path == *path))
    {
        return Err("自定义选择包含归属不明的文件".into());
    }
    Ok(RemovalPlan {
        id: uuid::Uuid::new_v4().to_string(),
        root: resolved,
        extent,
        entries,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemovalResult {
    pub plan_id: String,
    pub deleted: Vec<PathBuf>,
    pub retained: Vec<PathBuf>,
    pub failures: Vec<(PathBuf, String)>,
}

/// Call only after the native UI approves this stored plan. No request-provided
/// list or boolean can establish human approval. Rechecks precede the first delete.
pub(crate) fn apply_removal(plan: &RemovalPlan) -> Result<RemovalResult, String> {
    crate::transaction::verify_root(&plan.root)?;
    for entry in &plan.entries {
        let target = crate::local::safe_join(&plan.root, &entry.relative)?;
        if target != entry.path {
            return Err("文件真实路径已变化，请重新预览".into());
        }
        let current = match fs::symlink_metadata(&target) {
            Ok(_) => Some(fingerprint(&target)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.to_string()),
        };
        if current != entry.expected {
            return Err(format!("清单已失效，请重新预览：{}", target.display()));
        }
    }
    let mut result = RemovalResult {
        plan_id: plan.id.clone(),
        deleted: vec![],
        retained: vec![],
        failures: vec![],
    };
    for entry in &plan.entries {
        if !entry.remove {
            result.retained.push(entry.path.clone());
            continue;
        }
        let removed = (|| {
            crate::transaction::verify_root(&plan.root)?;
            let target = crate::local::safe_join(&plan.root, &entry.relative)?;
            if Some(fingerprint(&target)?) != entry.expected {
                return Err("执行前文件已变化，未删除".into());
            }
            fs::remove_file(&target).map_err(|e| e.to_string())?;
            match fs::symlink_metadata(&target) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Ok(_) => Err("删除后目标仍存在，需重新核实".into()),
                Err(e) => Err(format!("无法核实删除结果：{e}")),
            }
        })();
        match removed {
            Ok(()) => result.deleted.push(entry.path.clone()),
            Err(error) => result.failures.push((entry.path.clone(), error)),
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn archive(root: &Path, entries: &[(&str, &[u8])]) -> PathBuf {
        let path = root.join("package.zip");
        let mut writer = zip::ZipWriter::new(File::create(&path).unwrap());
        for (name, bytes) in entries {
            writer
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
        path
    }
    fn own(root: &Path, name: &str, role: FileRole) -> OwnedFile {
        OwnedFile {
            path: name.into(),
            role,
            installed_sha256: fingerprint(&root.join(name)).unwrap().sha256,
        }
    }
    fn repair_fixture() -> tempfile::TempDir {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("work/resource-repair-files-tests");
        fs::create_dir_all(&root).unwrap();
        tempfile::tempdir_in(root).unwrap()
    }
    #[test]
    fn repair_only_restores_missing_owned_runtime_roles_and_keeps_existing_bytes() {
        let dir = repair_fixture();
        let zip = archive(
            dir.path(),
            &[
                ("tool", b"tool"),
                ("dep", b"dep"),
                ("LICENSE", b"terms"),
                ("config", b"defaults"),
                ("patch", b"original"),
                ("not-owned", b"unused"),
            ],
        );
        let inventory = inspect_zip(&zip, 1024).unwrap();
        let root = dir.path().join("runtime");
        let mut installed = install_zip(
            &zip,
            &inventory,
            &["tool".into(), "dep".into(), "config".into(), "patch".into()],
            &root,
        )
        .unwrap();
        for file in &mut installed.files {
            if file.path == "dep" {
                file.role = FileRole::PrivateDependency;
            }
            if file.path == "config" {
                file.role = FileRole::Configuration;
            }
        }
        for name in ["tool", "dep", "LICENSE", "config"] {
            fs::remove_file(root.join(name)).unwrap();
        }
        fs::write(root.join("patch"), b"local patch").unwrap();
        fs::write(root.join("unknown"), b"user data").unwrap();
        let plan = preview_repair(&root, &installed.files, &inventory).unwrap();
        assert_eq!(
            plan.entries
                .iter()
                .filter(|e| e.decision == "restore")
                .count(),
            3
        );
        let receipt = repair_zip(&zip, &inventory, &plan).unwrap();
        assert_eq!(receipt.restored.len(), 3);
        assert!(receipt.failures.is_empty());
        assert_eq!(fs::read(root.join("dep")).unwrap(), b"dep");
        assert_eq!(fs::read(root.join("patch")).unwrap(), b"local patch");
        assert_eq!(fs::read(root.join("unknown")).unwrap(), b"user data");
        assert!(!root.join("config").exists());
        assert!(!root.join("not-owned").exists());
    }
    #[test]
    fn repair_preview_drift_rejects_before_any_temporary_file_is_created() {
        let dir = repair_fixture();
        let zip = archive(dir.path(), &[("tool", b"tool")]);
        let inventory = inspect_zip(&zip, 1024).unwrap();
        let root = dir.path().join("runtime");
        let installed = install_zip(&zip, &inventory, &["tool".into()], &root).unwrap();
        fs::remove_file(root.join("tool")).unwrap();
        let plan = preview_repair(&root, &installed.files, &inventory).unwrap();
        fs::write(root.join("tool"), b"user replacement").unwrap();
        assert!(repair_zip(&zip, &inventory, &plan).is_err());
        assert!(plan
            .entries
            .iter()
            .filter_map(|e| e.temporary_path.as_ref())
            .all(|p| !p.exists()));
        assert_eq!(fs::read(root.join("tool")).unwrap(), b"user replacement");
    }
    #[test]
    fn repair_partial_failure_and_destination_race_preserve_new_temporary_bytes() {
        let dir = repair_fixture();
        let zip = archive(dir.path(), &[("a", b"first"), ("b", b"second")]);
        let inventory = inspect_zip(&zip, 1024).unwrap();
        let root = dir.path().join("runtime");
        let mut installed =
            install_zip(&zip, &inventory, &["a".into(), "b".into()], &root).unwrap();
        for file in &installed.files {
            fs::remove_file(root.join(&file.path)).unwrap();
        }
        installed
            .files
            .iter_mut()
            .find(|f| f.path == "b")
            .unwrap()
            .installed_sha256 = "0".repeat(64);
        let plan = preview_repair(&root, &installed.files, &inventory).unwrap();
        let receipt = repair_zip(&zip, &inventory, &plan).unwrap();
        assert_eq!(receipt.restored.len(), 1);
        assert_eq!(receipt.failures.len(), 1);
        assert!(!root.join("b").exists());
        assert_eq!(receipt.temporary_paths.len(), 1);
        assert_eq!(fs::read(&receipt.temporary_paths[0]).unwrap(), b"second");
        installed
            .files
            .iter_mut()
            .find(|f| f.path == "b")
            .unwrap()
            .installed_sha256 = format!("{:x}", Sha256::digest(b"second"));
        let plan = preview_repair(&root, &installed.files, &inventory).unwrap();
        let receipt = repair_zip_with(&zip, &inventory, &plan, |entry| {
            fs::write(&entry.target, b"concurrent user file").map_err(|e| e.to_string())
        })
        .unwrap();
        assert!(receipt.restored.is_empty());
        assert_eq!(receipt.failures.len(), 1);
        assert_eq!(fs::read(root.join("b")).unwrap(), b"concurrent user file");
        assert_eq!(fs::read(&receipt.temporary_paths[0]).unwrap(), b"second");
    }
    #[test]
    fn minimal_install_keeps_licenses_and_excludes_development_files_without_overwriting() {
        let dir = tempfile::tempdir().unwrap();
        let zip = archive(
            dir.path(),
            &[
                ("bin/tool.exe", b"synthetic exe"),
                ("LICENSE", b"terms"),
                ("tests/dev.txt", b"development"),
            ],
        );
        let inventory = inspect_zip(&zip, 1024).unwrap();
        let target = dir.path().join("v1");
        let receipt = install_zip(&zip, &inventory, &["bin/tool.exe".into()], &target).unwrap();
        assert!(receipt.complete);
        assert_eq!(receipt.files.len(), 2);
        assert!(target.join("LICENSE").is_file());
        assert!(!target.join("tests").exists());
        assert!(install_zip(&zip, &inventory, &["bin/tool.exe".into()], &target).is_err());
        assert_eq!(
            fs::read(target.join("bin/tool.exe")).unwrap(),
            b"synthetic exe"
        );
    }
    #[test]
    fn archive_drift_unsafe_names_collisions_and_size_overflow_fail_before_destination_creation() {
        for entries in [
            vec![("../outside", &b"x"[..])],
            vec![("A.txt", &b"a"[..]), ("a.txt", &b"b"[..])],
        ] {
            let dir = tempfile::tempdir().unwrap();
            let zip = archive(dir.path(), &entries);
            assert!(inspect_zip(&zip, 1024).is_err());
        }
        let dir = tempfile::tempdir().unwrap();
        let zip = archive(dir.path(), &[("tool", b"data")]);
        assert!(inspect_zip(&zip, 3).is_err());
        let inventory = inspect_zip(&zip, 100).unwrap();
        fs::write(&zip, b"replaced archive").unwrap();
        let target = dir.path().join("v1");
        assert!(install_zip(&zip, &inventory, &["tool".into()], &target).is_err());
        assert!(!target.exists());
    }
    #[test]
    fn runtime_removal_keeps_configuration_unknown_files_and_local_modifications() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for name in ["tool.exe", "custom.exe", "config.json", "untracked.txt"] {
            fs::write(root.join(name), name).unwrap();
        }
        let owned = vec![
            own(root, "tool.exe", FileRole::Runtime),
            own(root, "custom.exe", FileRole::Runtime),
            own(root, "config.json", FileRole::Configuration),
        ];
        fs::write(root.join("custom.exe"), b"local patch").unwrap();
        let plan = preview_removal(root, &owned, RemovalExtent::Runtime, &[]).unwrap();
        assert_eq!(plan.entries.iter().filter(|entry| entry.remove).count(), 1);
        let result = apply_removal(&plan).unwrap();
        assert_eq!(result.deleted.len(), 1);
        assert!(root.join("config.json").exists());
        assert!(root.join("untracked.txt").exists());
        assert_eq!(fs::read(root.join("custom.exe")).unwrap(), b"local patch");
    }
    #[test]
    fn any_preview_drift_blocks_all_deletions_and_custom_scope_cannot_claim_unknown_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a"), b"a").unwrap();
        fs::write(root.join("b"), b"b").unwrap();
        let owned = vec![
            own(root, "a", FileRole::Runtime),
            own(root, "b", FileRole::UserData),
        ];
        let plan = preview_removal(root, &owned, RemovalExtent::Complete, &[]).unwrap();
        fs::write(root.join("b"), b"changed").unwrap();
        assert!(apply_removal(&plan).is_err());
        assert!(root.join("a").exists());
        assert!(preview_removal(root, &owned, RemovalExtent::Custom, &["unknown".into()]).is_err());
        let disabled = preview_removal(root, &owned, RemovalExtent::Disable, &[]).unwrap();
        assert!(apply_removal(&disabled).unwrap().deleted.is_empty());
    }
    #[test]
    fn explicit_custom_removal_can_include_local_edits_with_fresh_preview() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("tool"), b"original").unwrap();
        let owned = vec![own(root, "tool", FileRole::Runtime)];
        fs::write(root.join("tool"), b"patch").unwrap();
        let plan = preview_removal(root, &owned, RemovalExtent::Custom, &["tool".into()]).unwrap();
        assert_eq!(apply_removal(&plan).unwrap().deleted.len(), 1);
    }
}
