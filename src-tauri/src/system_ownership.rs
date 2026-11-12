//! Exact integration receipts. Registration, imports and name scans cannot create them.
//! The lifecycle owns the local confirmation and durable journal; this module never
//! scans system locations, executes uninstall strings or recursively deletes keys.
use crate::resource_files::{FileRole, Fingerprint, RemovalExtent};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Origin {
    ManagerCreated,
    ExplicitTakeover,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RegistryView {
    Native,
    View32,
    View64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum SystemAddress {
    Shortcut {
        path: PathBuf,
        target: PathBuf,
    },
    DirectoryLink {
        path: PathBuf,
        target: PathBuf,
    },
    /// HKCU only; a precise value, including the default value, never a whole key.
    RegistryValue {
        key: String,
        value_name: String,
        view: RegistryView,
    },
    /// HKCU\Environment\Path; a token, not permission to restore a whole PATH.
    UserPathFragment {
        token: String,
        view: RegistryView,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RegistryData {
    pub kind: u32,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum SystemValue {
    Absent,
    File {
        fingerprint: Fingerprint,
        file_id: String,
    },
    Link {
        file_id: String,
        raw_target: PathBuf,
        resolved_target: PathBuf,
    },
    Registry {
        value: Option<RegistryData>,
    },
}

/// Callers may persist this only after the actual approved native operation has
/// established ownership and observed its before/after values. No JSON API adopts it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OwnedSystemEntry {
    pub schema_version: u32,
    pub id: String,
    pub receipt_id: String,
    /// Stable UUID of the approved integration, shared by its exact entries.
    pub integration_id: String,
    pub origin: Origin,
    pub role: FileRole,
    pub address: SystemAddress,
    pub before: SystemValue,
    pub installed: SystemValue,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Operation {
    Remove,
    Restore,
    Keep,
    AlreadyAbsent,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlannedEntry {
    pub id: String,
    pub address: SystemAddress,
    pub operation: Operation,
    pub reason: String,
    pub requested: bool,
    expected: Option<SystemValue>,
    desired: Option<SystemValue>,
}

/// Stored in the server's private preview, not serialized raw into a UI/log/export.
/// Use public_entries for the UI; registry bytes can contain private settings.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemPlan {
    pub id: String,
    pub entries: Vec<PlannedEntry>,
    ownership: Vec<OwnedSystemEntry>,
    shared_keys: BTreeSet<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EntryResult {
    pub id: String,
    pub status: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemResult {
    pub plan_id: String,
    pub entries: Vec<EntryResult>,
    pub complete: bool,
    pub persistence_error: Option<String>,
}

/// Tests use an isolated in-memory backend. Native access is only selected by the
/// local lifecycle after its own stored preview and resource locks are checked.
pub(crate) trait SystemAccess {
    fn read(&self, address: &SystemAddress) -> Result<SystemValue, String>;
    fn change(
        &self,
        address: &SystemAddress,
        expected: &SystemValue,
        desired: &SystemValue,
    ) -> Result<(), String>;
}

fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let text = text.strip_prefix("//?/").unwrap_or(&text);
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text.into()
    }
}

pub(crate) fn address_key(address: &SystemAddress) -> String {
    match address {
        SystemAddress::Shortcut { path, .. } | SystemAddress::DirectoryLink { path, .. } => {
            format!("entry:{}", path_key(path))
        }
        SystemAddress::RegistryValue {
            key,
            value_name,
            view,
        } => format!(
            "hkcu:{:?}:{}:{}",
            physical_view(*view),
            key.to_lowercase(),
            value_name.to_lowercase()
        ),
        // HKCU\\Environment is shared, not redirected between registry views.
        SystemAddress::UserPathFragment { token, .. } => {
            format!("hkcu:environment:path-token:{}", token.to_lowercase())
        }
    }
}

fn physical_view(view: RegistryView) -> RegistryView {
    match view {
        RegistryView::Native if cfg!(target_pointer_width = "64") => RegistryView::View64,
        RegistryView::Native => RegistryView::View32,
        explicit => explicit,
    }
}

fn valid_text(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.contains('\0')
}

/// Native creation/takeover callers must validate before persisting a receipt.
/// This does not establish ownership by itself and is not an adoption API.
pub(crate) fn validate_receipt(entry: &OwnedSystemEntry) -> Result<(), String> {
    if entry.schema_version != 1
        || !valid_text(&entry.id, 96)
        || uuid::Uuid::parse_str(&entry.receipt_id).is_err()
        || uuid::Uuid::parse_str(&entry.integration_id).is_err()
    {
        return Err("系统项缺少可信的稳定归属回执".into());
    }
    match (&entry.address, &entry.before, &entry.installed) {
        (
            SystemAddress::Shortcut { path, target },
            SystemValue::Absent,
            SystemValue::File { .. },
        ) => {
            if !path.is_absolute()
                || !target.is_absolute()
                || !path
                    .extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case("lnk"))
            {
                return Err("快捷方式归属必须包含准确的绝对路径和原目标".into());
            }
        }
        (
            SystemAddress::DirectoryLink { path, target },
            SystemValue::Absent,
            SystemValue::Link {
                resolved_target, ..
            },
        ) => {
            if !path.is_absolute()
                || !target.is_absolute()
                || path_key(target) != path_key(resolved_target)
            {
                return Err("目录链接归属与真实目标不一致".into());
            }
        }
        (
            SystemAddress::RegistryValue {
                key, value_name, ..
            },
            SystemValue::Registry { value: before },
            SystemValue::Registry { value: Some(after) },
        ) => {
            validate_registry_entry(entry, key, value_name, before.as_ref(), after)?;
        }
        (
            SystemAddress::UserPathFragment { token, .. },
            SystemValue::Registry { value: before },
            SystemValue::Registry { value: Some(after) },
        ) => {
            if !valid_text(token, 32_767) || token.contains(';') || token.trim() != token {
                return Err("PATH 归属必须是一个完整片段".into());
            }
            let after_text = decode_path(after)?;
            let reduced =
                remove_path_token(&after_text, token)?.ok_or("归属回执未证明写入该 PATH 片段")?;
            let original = before
                .as_ref()
                .map(decode_path)
                .transpose()?
                .unwrap_or_default();
            if reduced != original || before.as_ref().is_some_and(|b| b.kind != after.kind) {
                return Err("PATH 写入前后不只相差本次片段，归属不可核实".into());
            }
        }
        _ => return Err("系统项归属类型或前后值不完整，现有系统项保留".into()),
    }
    Ok(())
}

fn validate_registry_entry(
    entry: &OwnedSystemEntry,
    key: &str,
    name: &str,
    before: Option<&RegistryData>,
    after: &RegistryData,
) -> Result<(), String> {
    if !valid_text(key, 2048)
        || key.split('\\').any(str::is_empty)
        || name.len() > 1024
        || name.contains('\0')
    {
        return Err("注册表值地址无效".into());
    }
    if key.eq_ignore_ascii_case("Environment") && name.eq_ignore_ascii_case("Path") {
        return Err("PATH 只能按已记录片段处理，不能恢复整值".into());
    }
    let root = format!("AgentResourceManager.{}", entry.integration_id);
    let classes = format!("Software\\Classes\\{root}");
    let uninstall = format!("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{root}");
    let launch = (key.eq_ignore_ascii_case(&classes)
        && ["", "URL Protocol"]
            .iter()
            .any(|allowed| name.eq_ignore_ascii_case(allowed)))
        || (["shell\\open\\command", "DefaultIcon"]
            .iter()
            .any(|tail| key.eq_ignore_ascii_case(&format!("{classes}\\{tail}")))
            && name.is_empty());
    let uninstall_value = key.eq_ignore_ascii_case(&uninstall)
        && [
            "DisplayName",
            "DisplayVersion",
            "Publisher",
            "InstallLocation",
            "UninstallString",
            "QuietUninstallString",
            "DisplayIcon",
            "NoModify",
            "NoRepair",
            "EstimatedSize",
        ]
        .iter()
        .any(|allowed| name.eq_ignore_ascii_case(allowed));
    if !launch && !uninstall_value {
        return Err("仅处理本功能已创建的启动或卸载关联，其他注册表项保留".into());
    }
    let dword = ["NoModify", "NoRepair", "EstimatedSize"]
        .iter()
        .any(|allowed| name.eq_ignore_ascii_case(allowed));
    for value in before.into_iter().chain(std::iter::once(after)) {
        if dword {
            if value.kind != 4 || value.bytes.len() != 4 {
                return Err("关联数值类型无法核对，保留".into());
            }
        } else {
            if value.bytes.len() > 16 * 1024 {
                return Err("关联说明超出本功能范围，保留".into());
            }
            let text = decode_path(value)?.to_lowercase();
            if [
                "password",
                "passwd",
                "access_token",
                "refresh_token",
                "client_secret",
                "api_key",
                "bearer ",
                "github_pat_",
                "ghp_",
                "-----begin",
            ]
            .iter()
            .any(|marker| text.contains(marker))
            {
                return Err("关联值可能包含凭据，不保存或处理此归属记录".into());
            }
        }
    }
    Ok(())
}

fn decode_path(value: &RegistryData) -> Result<String, String> {
    if ![1, 2].contains(&value.kind)
        || !value.bytes.len().is_multiple_of(2)
        || value.bytes.len() > 65_536
    {
        return Err("用户 PATH 不是可核对的 Unicode 字符串".into());
    }
    let mut words: Vec<u16> = value
        .bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    while words.last() == Some(&0) {
        words.pop();
    }
    if words.contains(&0) {
        return Err("用户 PATH 包含异常终止字符，未改写".into());
    }
    String::from_utf16(&words).map_err(|_| "用户 PATH 的 Unicode 编码无效".into())
}

fn path_data(value: &str, kind: u32) -> RegistryData {
    RegistryData {
        kind,
        bytes: value
            .encode_utf16()
            .chain(std::iter::once(0))
            .flat_map(u16::to_le_bytes)
            .collect(),
    }
}

fn remove_path_token(value: &str, token: &str) -> Result<Option<String>, String> {
    let parts: Vec<_> = value.split(';').collect();
    let found: Vec<_> = parts
        .iter()
        .enumerate()
        .filter(|(_, item)| **item == token)
        .map(|(i, _)| i)
        .collect();
    if found.len() > 1 {
        return Err("PATH 中该片段重复，不能判断哪个属于本资源；原值保留".into());
    }
    let Some(index) = found.first() else {
        return Ok(None);
    };
    Ok(Some(
        parts
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != *index)
            .map(|(_, part)| *part)
            .collect::<Vec<_>>()
            .join(";"),
    ))
}

fn wanted(role: &FileRole, extent: &RemovalExtent, id: &str, custom: &BTreeSet<String>) -> bool {
    match extent {
        RemovalExtent::Disable => false,
        RemovalExtent::Runtime => matches!(
            role,
            FileRole::Runtime | FileRole::PrivateDependency | FileRole::License
        ),
        RemovalExtent::Complete => true,
        RemovalExtent::Custom => custom.contains(id),
    }
}

fn removal_for(
    entry: &OwnedSystemEntry,
    current: &SystemValue,
) -> Result<(Operation, String, Option<SystemValue>), String> {
    if let SystemAddress::UserPathFragment { token, .. } = &entry.address {
        let SystemValue::Registry {
            value: current_value,
        } = current
        else {
            return Err("PATH 读取结果类型不符".into());
        };
        let Some(current_value) = current_value else {
            return Ok((
                Operation::AlreadyAbsent,
                "所记录 PATH 片段已不存在，无需重做".into(),
                None,
            ));
        };
        let original = decode_path(current_value)?;
        let Some(reduced) = remove_path_token(&original, token)? else {
            return Ok((
                Operation::AlreadyAbsent,
                "所记录 PATH 片段已不存在，其余内容保持".into(),
                None,
            ));
        };
        let SystemValue::Registry {
            value: Some(installed),
        } = &entry.installed
        else {
            return Err("PATH 归属记录无效".into());
        };
        if current_value.kind != installed.kind {
            return Ok((
                Operation::Keep,
                "PATH 类型已由其他操作改变，保留".into(),
                None,
            ));
        }
        let originally_absent = matches!(&entry.before, SystemValue::Registry { value: None });
        let result = if reduced.is_empty() && originally_absent {
            None
        } else {
            Some(path_data(&reduced, current_value.kind))
        };
        return Ok((
            Operation::Restore,
            "只移除本资源的精确 PATH 片段，其他片段保持原状".into(),
            Some(SystemValue::Registry { value: result }),
        ));
    }
    if *current == entry.before {
        return Ok((
            Operation::AlreadyAbsent,
            "当前已处于写入前状态，无需重做".into(),
            None,
        ));
    }
    if *current != entry.installed {
        return Ok((
            Operation::Keep,
            "系统项已被其他操作修改或替换，保留当前内容".into(),
            None,
        ));
    }
    let op = if matches!(
        &entry.before,
        SystemValue::Absent | SystemValue::Registry { value: None }
    ) {
        Operation::Remove
    } else {
        Operation::Restore
    };
    Ok((
        op,
        "按准确归属恢复此对象，不处理同名或同目录的其他项".into(),
        Some(entry.before.clone()),
    ))
}

pub(crate) fn preview(
    ownership: &[OwnedSystemEntry],
    extent: &RemovalExtent,
    custom: &BTreeSet<String>,
    shared_keys: &BTreeSet<String>,
    access: &impl SystemAccess,
) -> Result<SystemPlan, String> {
    let mut ids = BTreeSet::new();
    let mut addresses = BTreeSet::new();
    let mut entries = vec![];
    if ownership.len() > 1024 {
        return Err("系统归属项目过多，请核对记录".into());
    }
    for owner in ownership {
        if !ids.insert(owner.id.clone()) || !addresses.insert(address_key(&owner.address)) {
            return Err("系统归属记录包含重复标识或目标".into());
        }
        let requested = wanted(&owner.role, extent, &owner.id, custom);
        let mut entry = PlannedEntry {
            id: owner.id.clone(),
            address: owner.address.clone(),
            operation: Operation::Keep,
            reason: "本次保留".into(),
            requested,
            expected: None,
            desired: None,
        };
        if !requested {
            entries.push(entry);
            continue;
        }
        let scope = validate_receipt(owner).and_then(|_| access.read(&owner.address));
        match scope {
            Err(error) => entry.reason = format!("无法完整核对，保留：{error}"),
            Ok(current) => {
                entry.expected = Some(current.clone());
                if shared_keys.contains(&address_key(&owner.address)) {
                    entry.reason = "此系统项仍被其他资源共享，保留".into();
                } else {
                    match removal_for(owner, &current) {
                        Ok((operation, reason, desired)) => {
                            entry.operation = operation;
                            entry.reason = reason;
                            entry.desired = desired;
                        }
                        Err(error) => entry.reason = format!("不能安全处理，保留：{error}"),
                    }
                }
            }
        }
        entries.push(entry);
    }
    if custom.iter().any(|id| !ids.contains(id)) {
        return Err("自定义选择含归属不明的系统项目".into());
    }
    Ok(SystemPlan {
        id: uuid::Uuid::new_v4().to_string(),
        entries,
        ownership: ownership.to_vec(),
        shared_keys: shared_keys.clone(),
    })
}

pub(crate) fn check(
    plan: &SystemPlan,
    current_ownership: &[OwnedSystemEntry],
    current_shared: &BTreeSet<String>,
    access: &impl SystemAccess,
) -> Result<(), String> {
    if plan.ownership != current_ownership || plan.shared_keys != *current_shared {
        return Err("系统归属或共享使用关系已变化，请重新预览".into());
    }
    for entry in &plan.entries {
        if matches!(entry.operation, Operation::Remove | Operation::Restore)
            && (entry.expected.is_none() || entry.desired.is_none())
        {
            return Err("已存系统预览不完整，请重新预览".into());
        }
        if let Some(expected) = &entry.expected {
            if access.read(&entry.address)? != *expected {
                return Err(format!("系统项自预览后变化，请重新确认：{}", entry.id));
            }
        }
    }
    Ok(())
}

impl SystemPlan {
    /// Exact addresses and actions, without raw private registry payloads.
    pub(crate) fn public_entries(&self) -> serde_json::Value {
        serde_json::json!(self.entries.iter().map(|entry|serde_json::json!({"id":entry.id,"address":entry.address,"operation":entry.operation,"requested":entry.requested,"reason":entry.reason})).collect::<Vec<_>>())
    }
}

/// Called only after the outer lifecycle consumes this exact local confirmation.
/// The caller persists an intent first. It then persists each result before the
/// next side effect, allowing crash recovery to inspect rather than replay work.
pub(crate) fn apply(
    plan: &SystemPlan,
    current_ownership: &[OwnedSystemEntry],
    current_shared: &BTreeSet<String>,
    access: &impl SystemAccess,
    mut persist: impl FnMut(&[EntryResult]) -> Result<(), String>,
) -> Result<SystemResult, String> {
    check(plan, current_ownership, current_shared, access)?;
    let mut results = vec![];
    let mut persistence_error = None;
    let mut path_value: Option<SystemValue> = None;
    for entry in &plan.entries {
        let result = match entry.operation {
            Operation::Keep => EntryResult {
                id: entry.id.clone(),
                status: "retained".into(),
                reason: entry.reason.clone(),
            },
            Operation::AlreadyAbsent => EntryResult {
                id: entry.id.clone(),
                status: "alreadyAbsent".into(),
                reason: entry.reason.clone(),
            },
            Operation::Remove | Operation::Restore => {
                let mut expected = entry.expected.clone().ok_or("已存系统预览缺少实际值")?;
                let mut desired = entry.desired.clone().ok_or("已存系统预览缺少处理目标")?;
                // Several owned tokens share one user PATH. Carry only our own
                // verified preceding changes forward; concurrent edits still fail.
                if matches!(&entry.address, SystemAddress::UserPathFragment { .. }) {
                    if let Some(previous) = &path_value {
                        expected = previous.clone();
                        let owner = plan
                            .ownership
                            .iter()
                            .find(|owner| owner.id == entry.id)
                            .ok_or("PATH归属已失效")?;
                        desired = removal_for(owner, &expected)?
                            .2
                            .ok_or("PATH片段处理目标已变化，请重新预览")?;
                    }
                }
                let result = access
                    .change(&entry.address, &expected, &desired)
                    .and_then(|_| {
                        if access.read(&entry.address)? != desired {
                            return Err("处理后读回不符，需核对实际结果".into());
                        }
                        Ok(())
                    });
                if result.is_ok()
                    && matches!(&entry.address, SystemAddress::UserPathFragment { .. })
                {
                    path_value = Some(desired);
                }
                match result {
                    Ok(()) => EntryResult {
                        id: entry.id.clone(),
                        status: if entry.operation == Operation::Remove {
                            "deleted"
                        } else {
                            "restored"
                        }
                        .into(),
                        reason: entry.reason.clone(),
                    },
                    Err(error) => EntryResult {
                        id: entry.id.clone(),
                        status: "failed".into(),
                        reason: error,
                    },
                }
            }
        };
        results.push(result);
        if let Err(error) = persist(&results) {
            persistence_error = Some(error);
            break;
        }
    }
    let complete = persistence_error.is_none()
        && results.len() == plan.entries.len()
        && plan.entries.iter().zip(&results).all(|(entry, result)| {
            !entry.requested
                || ["deleted", "restored", "alreadyAbsent"].contains(&result.status.as_str())
        });
    Ok(SystemResult {
        plan_id: plan.id.clone(),
        entries: results,
        complete,
        persistence_error,
    })
}

pub(crate) struct NativeSystemAccess;

impl SystemAccess for NativeSystemAccess {
    fn read(&self, address: &SystemAddress) -> Result<SystemValue, String> {
        match address {
            SystemAddress::Shortcut { path, .. } => {
                let parent = path.parent().ok_or("快捷方式没有父目录")?;
                crate::transaction::verify_root(parent)?;
                match fs::symlink_metadata(path) {
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SystemValue::Absent),
                    Err(e) => Err(e.to_string()),
                    Ok(_) => Ok(SystemValue::File {
                        fingerprint: crate::resource_files::fingerprint(path)?,
                        file_id: crate::clients::file_identity(path)?,
                    }),
                }
            }
            SystemAddress::DirectoryLink { path, target } => {
                crate::transaction::verify_root(path.parent().ok_or("目录链接没有父目录")?)?;
                match fs::symlink_metadata(path) {
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SystemValue::Absent),
                    Err(e) => Err(e.to_string()),
                    Ok(meta) => {
                        #[cfg(windows)]
                        let linked = {
                            use std::os::windows::fs::MetadataExt;
                            meta.file_attributes() & 0x400 != 0
                        };
                        #[cfg(not(windows))]
                        let linked = meta.file_type().is_symlink();
                        if !linked {
                            return Err("目标不是目录链接，普通目录保留".into());
                        }
                        let resolved = crate::local::canonical(path)?;
                        if path_key(&resolved) != path_key(&crate::local::canonical(target)?) {
                            return Err("目录链接目标已变化".into());
                        }
                        Ok(SystemValue::Link {
                            file_id: crate::clients::file_identity(path)?,
                            raw_target: fs::read_link(path).map_err(|e| e.to_string())?,
                            resolved_target: resolved,
                        })
                    }
                }
            }
            SystemAddress::RegistryValue {
                key,
                value_name,
                view,
            } => Ok(SystemValue::Registry {
                value: registry_read(key, value_name, *view)?,
            }),
            SystemAddress::UserPathFragment { view, .. } => Ok(SystemValue::Registry {
                value: registry_read("Environment", "Path", *view)?,
            }),
        }
    }
    fn change(
        &self,
        address: &SystemAddress,
        expected: &SystemValue,
        desired: &SystemValue,
    ) -> Result<(), String> {
        if self.read(address)? != *expected {
            return Err("执行前系统项已变化，未处理".into());
        }
        match (address, desired) {
            (SystemAddress::Shortcut { path, .. }, SystemValue::Absent) => {
                fs::remove_file(path).map_err(|e| e.to_string())
            }
            (SystemAddress::DirectoryLink { path, target }, SystemValue::Absent) => {
                crate::clients::remove_link(path, target)
            }
            (
                SystemAddress::RegistryValue {
                    key,
                    value_name,
                    view,
                },
                SystemValue::Registry { value },
            ) => registry_write(key, value_name, *view, value.as_ref()),
            (SystemAddress::UserPathFragment { view, .. }, SystemValue::Registry { value }) => {
                registry_write("Environment", "Path", *view, value.as_ref())
            }
            _ => Err("不支持按此预览改写系统项".into()),
        }
    }
}

#[cfg(windows)]
fn registry_view(view: RegistryView) -> u32 {
    use windows_sys::Win32::System::Registry::{KEY_WOW64_32KEY, KEY_WOW64_64KEY};
    match view {
        RegistryView::Native => 0,
        RegistryView::View32 => KEY_WOW64_32KEY,
        RegistryView::View64 => KEY_WOW64_64KEY,
    }
}

#[cfg(windows)]
fn wide(value: &str) -> Result<Vec<u16>, String> {
    if value.contains('\0') {
        return Err("注册表地址包含无效字符".into());
    }
    Ok(value.encode_utf16().chain(std::iter::once(0)).collect())
}

#[cfg(windows)]
struct RegistryKey(windows_sys::Win32::System::Registry::HKEY);
#[cfg(windows)]
impl Drop for RegistryKey {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::System::Registry::RegCloseKey(self.0);
        }
    }
}

#[cfg(windows)]
fn registry_open(
    key: &str,
    view: RegistryView,
    access: u32,
) -> Result<Option<RegistryKey>, String> {
    use windows_sys::Win32::{
        Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS},
        System::Registry::{RegOpenKeyExW, HKEY_CURRENT_USER},
    };
    let key = wide(key)?;
    let mut opened = std::ptr::null_mut();
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            0,
            access | registry_view(view),
            &mut opened,
        )
    };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if status != ERROR_SUCCESS {
        return Err(format!("无法打开已记录的用户注册表值，Windows错误{status}"));
    }
    Ok(Some(RegistryKey(opened)))
}

#[cfg(windows)]
fn registry_read(
    key: &str,
    name: &str,
    view: RegistryView,
) -> Result<Option<RegistryData>, String> {
    use windows_sys::Win32::{
        Foundation::{ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_SUCCESS},
        System::Registry::{RegQueryValueExW, KEY_QUERY_VALUE},
    };
    let Some(key) = registry_open(key, view, KEY_QUERY_VALUE)? else {
        return Ok(None);
    };
    let name = wide(name)?;
    for _ in 0..3 {
        let mut kind = 0;
        let mut size = 0;
        let status = unsafe {
            RegQueryValueExW(
                key.0,
                name.as_ptr(),
                std::ptr::null(),
                &mut kind,
                std::ptr::null_mut(),
                &mut size,
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if status != ERROR_SUCCESS {
            return Err(format!("读取用户注册表值失败，Windows错误{status}"));
        }
        if size > 512 * 1024 {
            return Err("注册表值超出安全读取范围".into());
        }
        let mut data = vec![0u8; size as usize];
        let status = unsafe {
            RegQueryValueExW(
                key.0,
                name.as_ptr(),
                std::ptr::null(),
                &mut kind,
                data.as_mut_ptr(),
                &mut size,
            )
        };
        if status == ERROR_MORE_DATA {
            continue;
        }
        if status != ERROR_SUCCESS {
            return Err(format!(
                "读取期间注册表值发生变化或不可读，Windows错误{status}"
            ));
        }
        data.truncate(size as usize);
        return Ok(Some(RegistryData { kind, bytes: data }));
    }
    Err("注册表值持续变化，请重新预览".into())
}

#[cfg(windows)]
fn registry_write(
    key: &str,
    name: &str,
    view: RegistryView,
    value: Option<&RegistryData>,
) -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS},
        System::Registry::{RegDeleteValueW, RegSetValueExW, KEY_SET_VALUE},
    };
    let Some(key) = registry_open(key, view, KEY_SET_VALUE)? else {
        return Err("已记录的注册表键已不存在，不能自动创建或重放".into());
    };
    let name = wide(name)?;
    let status = unsafe {
        match value {
            Some(value) => RegSetValueExW(
                key.0,
                name.as_ptr(),
                0,
                value.kind,
                value.bytes.as_ptr(),
                value.bytes.len().try_into().map_err(|_| "注册表值过长")?,
            ),
            None => RegDeleteValueW(key.0, name.as_ptr()),
        }
    };
    if status == ERROR_SUCCESS || (value.is_none() && status == ERROR_FILE_NOT_FOUND) {
        Ok(())
    } else {
        Err(format!(
            "处理用户注册表值失败，Windows错误{status}；其他项目保留"
        ))
    }
}

#[cfg(not(windows))]
fn registry_read(_: &str, _: &str, _: RegistryView) -> Result<Option<RegistryData>, String> {
    Err("当前平台不处理Windows用户注册表".into())
}
#[cfg(not(windows))]
fn registry_write(
    _: &str,
    _: &str,
    _: RegistryView,
    _: Option<&RegistryData>,
) -> Result<(), String> {
    Err("当前平台不处理Windows用户注册表".into())
}

#[cfg(test)]
#[path = "system_ownership/tests.rs"]
mod tests;
