//! Fixed, native-only candidate probes. A request never supplies an executable,
//! arguments, a success flag, or replacement credentials.
use crate::{
    model::Manager,
    resource_files::{self, OwnedFile},
    resource_github::DownloadSource,
    resource_runtime::{ActionDefinition, Argument},
    resource_update::{self, ValidationTarget},
    resources::{ResourceRecord, StoreRequest},
};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

const MAX_OUTPUT: usize = 32 * 1024;
const MAX_METADATA: u64 = 1024 * 1024;
const REACH: &str = "panniantong/agent-reach";
const EDGE: &str = "microsoft/playwright-mcp";
const EDGE_CLI: &str = "node_modules/@playwright/mcp/cli.js";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Adapter {
    Reach,
    Edge,
}
impl Adapter {
    fn id(self) -> &'static str {
        match self {
            Self::Reach => "agent-reach-isolated-cli-local-doctor-v2",
            Self::Edge => "playwright-mcp-isolated-cli-help-v2",
        }
    }
    fn scopes(self) -> &'static [&'static str] {
        match self {
            Self::Reach => &["cliVersion", "isolatedLocalDoctor"],
            Self::Edge => &["cliVersion", "cliHelp"],
        }
    }
}

struct ProbeCommand {
    executable: PathBuf,
    expected_hash: String,
    directory: PathBuf,
    args: Vec<String>,
    python: bool,
    timeout: Duration,
}
struct Plan {
    commands: Vec<ProbeCommand>,
    version: String,
    adapter: Adapter,
}

// This supplies an empty temporary profile to the fixed probe commands. It is
// not an OS filesystem sandbox and does not constrain arbitrary native code.
// Never copy the original configuration, browser profile or login state here.
struct ProbeProfile {
    root: PathBuf,
    identity: String,
    directories: Vec<(&'static str, PathBuf)>,
}
impl ProbeProfile {
    fn new(temporary_root: &Path) -> Result<Self, String> {
        crate::transaction::verify_root(temporary_root)?;
        let parent = temporary_root.join("resource-probes");
        fs::create_dir_all(&parent).map_err(|_| "不能创建候选自检的隔离配置目录")?;
        crate::transaction::verify_root(&parent)?;
        let root = parent.join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&root).map_err(|_| "不能创建本次候选自检的独立配置目录")?;
        let mut directories = Vec::new();
        for (relative, names) in [
            ("home", &["HOME", "USERPROFILE"][..]),
            ("temp", &["TEMP", "TMP", "TMPDIR"][..]),
            ("config", &["XDG_CONFIG_HOME"][..]),
            ("data", &["XDG_DATA_HOME"][..]),
            ("cache", &["XDG_CACHE_HOME"][..]),
            ("state", &["XDG_STATE_HOME"][..]),
            ("appdata-roaming", &["APPDATA"][..]),
            ("appdata-local", &["LOCALAPPDATA"][..]),
        ] {
            let directory = root.join(relative);
            fs::create_dir(&directory).map_err(|_| "不能创建本次自检的配置或临时目录")?;
            for name in names {
                directories.push((*name, directory.clone()));
            }
        }
        crate::transaction::verify_root(&root)?;
        let identity = crate::clients::file_identity(&root)?;
        Ok(Self {
            root,
            identity,
            directories,
        })
    }

    fn apply(&self, command: &mut Command) -> Result<(), String> {
        crate::transaction::verify_root(&self.root)?;
        if crate::clients::file_identity(&self.root)? != self.identity {
            return Err("本次自检的隔离配置目录已变化，未运行候选".into());
        }
        for (name, directory) in &self.directories {
            crate::transaction::verify_root(directory)?;
            if !directory.is_dir() {
                return Err("本次自检的隔离配置或临时目录不可用，未运行候选".into());
            }
            command.env(name, directory);
        }
        Ok(())
    }
}

// Candidate startup probes do not need account credentials, saved proxies or
// package-manager/browser overrides. Read only these ordinary runtime values;
// never enumerate the parent environment or inspect secret variable values.
fn isolated_runtime_environment(command: &mut Command) {
    command.env_clear();
    for name in [
        "PATH",
        "SystemRoot",
        "WINDIR",
        "SystemDrive",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "CommonProgramFiles",
        "CommonProgramFiles(x86)",
        "PATHEXT",
        "COMSPEC",
        "OS",
        "PROCESSOR_ARCHITECTURE",
        "NUMBER_OF_PROCESSORS",
        "LANG",
        "LANGUAGE",
        "LC_ALL",
        "LC_CTYPE",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
}

fn repository(value: &str) -> Option<String> {
    let value = value.trim().trim_end_matches('/');
    let name = value.strip_prefix("https://github.com/")?;
    let name = name.strip_suffix(".git").unwrap_or(name);
    let parts: Vec<_> = name.split('/').collect();
    (parts.len() == 2
        && parts.iter().all(|s| {
            !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        }))
    .then(|| name.to_ascii_lowercase())
}
fn source_matches(source: &DownloadSource, expected: &str, sha256: &str) -> bool {
    repository(&source.repository).as_deref() == Some(expected)
        && matches!(source.verification.as_str(), "githubDigest" | "githubAsset")
        && source.release_id > 0
        && source.asset_id > 0
        && source.sha256.eq_ignore_ascii_case(sha256)
        && sha256.len() == 64
        && sha256.bytes().all(|b| b.is_ascii_hexdigit())
}
pub(crate) fn package_source_matches(
    package: &crate::resource_package::RuntimePackageProvenance,
    expected: &str,
    version: &str,
) -> bool {
    package.recheck_shared_runtime().is_ok()
        && package
            .source_repository()
            .ok()
            .and_then(|value| repository(&value))
            .as_deref()
            == Some(expected)
        && normalized_version(&package.version) == normalized_version(version)
        && matches!(
            (expected, &package.recipe),
            (REACH, crate::resource_package::Recipe::AgentReachWheelV1)
                | (EDGE, crate::resource_package::Recipe::EdgeMcpNpmV1)
        )
}
fn current_adapter(record: &ResourceRecord) -> Result<Adapter, String> {
    let expected = match record.repository.as_deref().and_then(repository).as_deref() {
        Some(REACH) => (REACH, Adapter::Reach),
        Some(EDGE) => (EDGE, Adapter::Edge),
        _ => {
            return Err("此来源没有经过核对的只读候选验证适配器，未运行程序，也不能切换；Dragon 启动器只能静态读取版本，不能验证启动能力".into())
        }
    };
    if record
        .source_binding
        .as_ref()
        .is_some_and(|s| repository(&s.repository).as_deref() != Some(expected.0))
    {
        return Err("当前关联来源与固定验证适配器不一致，未运行候选".into());
    }
    let install = record
        .installation
        .as_ref()
        .ok_or("缺少原安装来源凭据，不能选择候选适配器")?;
    if install
        .source_repository
        .as_deref()
        .and_then(repository)
        .as_deref()
        != Some(expected.0)
        || !match &install.runtime_package {
            Some(package) => record
                .version
                .as_deref()
                .is_some_and(|version| package_source_matches(package, expected.0, version)),
            None => install
                .download_source
                .as_ref()
                .is_some_and(|s| source_matches(s, expected.0, &install.archive_sha256)),
        }
    {
        return Err("原安装必须具有固定官方来源的已验证下载记录；手填仓库名称不能授权执行".into());
    }
    // Version/help cannot validate real browser sessions or platform requests.
    // A resource which makes one of those capabilities mandatory stays blocked.
    if record.capabilities.iter().any(|c| {
        c["required"] == true
            && !matches!(c["id"].as_str(), Some("registration" | "cliVersion"))
            && !(expected.1 == Adapter::Reach && c["id"] == "localDoctor")
            && !(expected.1 == Adapter::Edge && c["id"] == "cliHelp")
    }) {
        return Err("资源包含必须实际验证的平台或会话能力；只读版本/帮助自检无法覆盖，候选保持未验证且不能切换".into());
    }
    if record.actions.is_empty() {
        return Err("尚未登记可由固定验证器覆盖的动作，不能授权候选切换".into());
    }
    for value in &record.actions {
        let definition: ActionDefinition =
            serde_json::from_value(value.clone()).map_err(|_| "已登记动作定义无效")?;
        covered_action(&definition, Path::new(&record.root_path), expected.1)?;
    }
    Ok(expected.1)
}
fn select_adapter(record: &ResourceRecord) -> Result<Adapter, String> {
    let adapter = current_adapter(record)?;
    let expected = match adapter {
        Adapter::Reach => REACH,
        Adapter::Edge => EDGE,
    };
    let candidate = record
        .installation
        .as_ref()
        .and_then(|i| i.update_state.as_ref())
        .and_then(|s| s.candidate.as_ref())
        .ok_or("尚未准备候选运行版本")?;
    if !match &candidate.runtime_package {
        Some(package) => package_source_matches(package, expected, &candidate.version),
        None => candidate
            .download_source
            .as_ref()
            .is_some_and(|s| source_matches(s, expected, &candidate.archive_sha256)),
    } {
        return Err("候选必须具有同一可信来源的已验证下载记录，手填仓库名称不能授权执行".into());
    }
    Ok(adapter)
}

/// A scope check for the native automation grant. It executes no program and
/// does not turn static matching into capability evidence or a switch grant.
pub(crate) fn automation_supported(record: &ResourceRecord) -> Result<(), String> {
    let adapter = current_adapter(record)?;
    crate::resource_update::verify_registered_runtime(record)?;
    let installation = record.installation.as_ref().ok_or("原安装记录缺失")?;
    let target = ValidationTarget {
        root: PathBuf::from(&record.root_path),
        version: record
            .version
            .clone()
            .ok_or("版本未知，不能安全授权自动更新")?,
        files: installation.files.clone(),
        actions: record.actions.clone(),
    };
    prepare(record, &target, adapter).map(|_| ())
}
fn same_path(left: &Path, right: &Path) -> Result<bool, String> {
    Ok(crate::local::canonical(left)? == crate::local::canonical(right)?)
}
fn owned_path(root: &Path, files: &[OwnedFile], relative: &str) -> Result<PathBuf, String> {
    let file = files
        .iter()
        .find(|f| f.path == relative)
        .ok_or("候选缺少可核实归属的运行入口或元数据")?;
    let path = crate::local::safe_join(root, relative)?;
    if resource_files::fingerprint(&path)?.sha256 != file.installed_sha256 {
        return Err("运行入口或元数据摘要已变化，未运行候选".into());
    }
    Ok(path)
}
fn small_text(path: &Path) -> Result<String, String> {
    if fs::metadata(path).map_err(|_| "验证元数据不可读")?.len() > MAX_METADATA {
        return Err("验证元数据过大，未运行候选".into());
    }
    fs::read_to_string(path).map_err(|_| "验证元数据不是可读取的 UTF-8 文本".into())
}
fn literal_args(definition: &ActionDefinition) -> Result<Vec<String>, String> {
    definition
        .args
        .iter()
        .map(|arg| match arg {
            Argument::Literal { value } => Ok(value.clone()),
            Argument::Parameter { .. } => {
                Err("候选验证需要已登记的固定入口，不能从参数拼接执行命令".into())
            }
        })
        .collect()
}
// Coverage comes from the actual registered execution definition, not an
// optional capability flag or a trusted-looking action name. These probes do
// not exercise platform reads, browser sessions or arbitrary user actions.
fn covered_action(
    definition: &ActionDefinition,
    root: &Path,
    adapter: Adapter,
) -> Result<(), String> {
    let unsupported = || {
        format!(
            "已登记动作“{}”超出当前固定自检的能力范围；版本/帮助不能验证该动作，未运行候选也不能切换",
            definition.label
        )
    };
    if definition.mode != "task" || !definition.parameters.is_empty() {
        return Err(unsupported());
    }
    let args = literal_args(definition).map_err(|_| unsupported())?;
    let supported = match adapter {
        Adapter::Reach => {
            same_path(
                Path::new(&definition.executable),
                &root.join("Scripts/agent-reach.exe"),
            )? && (args == ["version"] || args == ["doctor", "--text"])
        }
        Adapter::Edge => {
            Path::new(&definition.executable)
                .file_name()
                .is_some_and(|n| n.eq_ignore_ascii_case("node.exe"))
                && args.len() == 2
                && same_path(Path::new(&args[0]), &root.join(EDGE_CLI))?
                && matches!(args[1].as_str(), "--version" | "--help")
        }
    };
    if !supported || !same_path(Path::new(&definition.working_directory), root)? {
        return Err(unsupported());
    }
    Ok(())
}
fn action_pair(
    record: &ResourceRecord,
    target: &ValidationTarget,
    adapter: Adapter,
) -> Result<(ActionDefinition, ActionDefinition), String> {
    if target.actions.len() != record.actions.len() {
        return Err("候选动作集合与已登记范围不一致，未运行候选".into());
    }
    let mut first = None;
    let mut ids = BTreeSet::new();
    for value in &record.actions {
        let original: ActionDefinition =
            serde_json::from_value(value.clone()).map_err(|_| "已登记动作定义无效")?;
        if !ids.insert(original.id.clone()) {
            return Err("已登记动作标识重复，不能核对完整能力范围".into());
        }
        let candidates: Vec<_> = target
            .actions
            .iter()
            .filter(|a| a["id"] == original.id)
            .collect();
        if candidates.len() != 1 {
            return Err("候选缺少唯一对应的已登记动作，未运行候选".into());
        }
        let next: ActionDefinition =
            serde_json::from_value(candidates[0].clone()).map_err(|_| "候选动作定义无效")?;
        covered_action(&original, Path::new(&record.root_path), adapter)?;
        covered_action(&next, &target.root, adapter)?;
        let matches = match adapter {
            Adapter::Reach => {
                same_path(
                    Path::new(&original.executable),
                    &Path::new(&record.root_path).join("Scripts/agent-reach.exe"),
                )? && same_path(
                    Path::new(&next.executable),
                    &target.root.join("Scripts/agent-reach.exe"),
                )?
            }
            Adapter::Edge => {
                Path::new(&original.executable)
                    .file_name()
                    .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("node.exe"))
                    && same_path(Path::new(&original.executable), Path::new(&next.executable))?
                    && literal_args(&original)?.first().is_some_and(|p| {
                        same_path(Path::new(p), &Path::new(&record.root_path).join(EDGE_CLI))
                            .unwrap_or(false)
                    })
            }
        };
        if !matches {
            return Err("已登记动作或候选入口不在固定验证布局内，未运行候选".into());
        }
        let original_hash = original
            .executable_sha256
            .as_ref()
            .ok_or("已登记入口缺少原摘要，不能执行候选验证")?;
        if resource_files::fingerprint(Path::new(&original.executable))?.sha256 != *original_hash {
            return Err("已登记执行程序发生变化，未运行候选".into());
        }
        let target_hash = next.executable_sha256.as_ref().ok_or("候选入口缺少摘要")?;
        if resource_files::fingerprint(Path::new(&next.executable))?.sha256 != *target_hash {
            return Err("候选执行程序发生变化，未运行候选".into());
        }
        let old_root = crate::local::canonical(Path::new(&record.root_path))?;
        let new_root = crate::local::canonical(&target.root)?;
        if !same_path(Path::new(&original.working_directory), &old_root)?
            || !same_path(Path::new(&next.working_directory), &new_root)?
        {
            return Err("候选动作工作目录不是已核实的版本根目录".into());
        }
        let old_args = literal_args(&original)?;
        let new_args = literal_args(&next)?;
        let mapped: Vec<String> = old_args
            .iter()
            .map(|value| {
                if Path::new(value).is_absolute() {
                    let original_path = crate::local::canonical(Path::new(value))?;
                    let relative = original_path
                        .strip_prefix(&old_root)
                        .map_err(|_| "动作参数引用版本目录之外的数据，不能自动验证")?;
                    Ok(new_root.join(relative).to_string_lossy().into_owned())
                } else {
                    Ok(value.clone())
                }
            })
            .collect::<Result<_, String>>()?;
        if new_args != mapped
            || original.mode != next.mode
            || original.cancellable != next.cancellable
            || original.timeout_seconds != next.timeout_seconds
        {
            return Err("候选固定参数与已登记入口不一致，未运行候选".into());
        }
        if adapter == Adapter::Edge && original_hash != target_hash {
            return Err("共享 Node 的摘要发生变化，不能将其作为原登记的运行时".into());
        }
        if first.is_none() {
            first = Some((original, next));
        }
    }
    first.ok_or_else(|| "未找到与实际布局及原登记摘要一致的固定验证入口，未运行候选".into())
}

fn normalized_version(version: &str) -> &str {
    version.trim().trim_start_matches('v')
}
fn prepare(
    record: &ResourceRecord,
    target: &ValidationTarget,
    adapter: Adapter,
) -> Result<Plan, String> {
    let (_, next) = action_pair(record, target, adapter)?;
    let command = |args: Vec<String>, seconds: u64| ProbeCommand {
        executable: PathBuf::from(&next.executable),
        expected_hash: next.executable_sha256.clone().expect("checked action hash"),
        directory: target.root.clone(),
        args,
        python: adapter == Adapter::Reach,
        timeout: Duration::from_secs(seconds),
    };
    match adapter {
        Adapter::Reach => {
            let executable = owned_path(&target.root, &target.files, "Scripts/agent-reach.exe")?;
            let python = owned_path(&target.root, &target.files, "Scripts/python.exe")?;
            for relative in [
                "pyvenv.cfg",
                "Lib/site-packages/agent_reach/__init__.py",
                "Lib/site-packages/agent_reach/cli.py",
                "Lib/site-packages/agent_reach/runtime/cli.py",
                "Lib/site-packages/agent_reach/runtime/manage.py",
            ] {
                owned_path(&target.root, &target.files, relative)?;
            }
            // Windows console launchers embed an absolute Python shebang. A
            // moved launcher could execute the old version and produce a false pass.
            if fs::metadata(&executable).map_err(|_| "入口不可读")?.len() > 8 * 1024 * 1024 {
                return Err("Python 启动入口无法可靠核实，未运行候选".into());
            }
            let bytes = fs::read(executable).map_err(|_| "Python 启动入口不可读")?;
            let python_text = python.to_string_lossy();
            let python_text = python_text.strip_prefix(r"\\?\").unwrap_or(&python_text);
            let expected = format!("#!{python_text}");
            let expected_quoted = format!("#!\"{python_text}\"");
            let launcher = String::from_utf8_lossy(&bytes)
                .replace('/', "\\")
                .to_ascii_lowercase();
            if !launcher.lines().any(|line| {
                let line = line.trim_end_matches('\r');
                line.ends_with(&expected.to_ascii_lowercase())
                    || line.ends_with(&expected_quoted.to_ascii_lowercase())
            }) {
                return Err("候选 Python 启动器仍绑定其他版本或无法核实；不能把原版本执行结果当作候选验证，未运行也未切换".into());
            }
            Ok(Plan {
                commands: vec![
                    command(vec!["version".into()], 8),
                    command(vec!["doctor".into(), "--text".into()], 15),
                ],
                version: target.version.clone(),
                adapter,
            })
        }
        Adapter::Edge => {
            let cli = owned_path(&target.root, &target.files, EDGE_CLI)?;
            let package = owned_path(
                &target.root,
                &target.files,
                "node_modules/@playwright/mcp/package.json",
            )?;
            let package: Value = serde_json::from_str(&small_text(&package)?)
                .map_err(|_| "候选 MCP 包元数据无效")?;
            if package["name"] != "@playwright/mcp"
                || package["repository"]["url"]
                    != "git+https://github.com/microsoft/playwright-mcp.git"
            {
                return Err("候选 MCP 包身份与固定适配器不一致".into());
            }
            let version = package["version"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or("候选 MCP 包缺少版本")?;
            if normalized_version(version) != normalized_version(&target.version) {
                return Err("候选标记版本与 MCP 包版本不同，不能可靠验证".into());
            }
            let script = small_text(&cli)?;
            if !script.contains("program.version(")
                || !script.contains("program.parseAsync(process.argv)")
            {
                return Err("候选 CLI 不符合已核对的版本/帮助终止路径，不能安全执行验证".into());
            }
            let entry = cli.to_string_lossy().into_owned();
            Ok(Plan {
                commands: vec![
                    command(vec![entry.clone(), "--version".into()], 8),
                    command(vec![entry, "--help".into()], 8),
                ],
                version: version.into(),
                adapter,
            })
        }
    }
}

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

#[cfg(windows)]
fn drain(
    pipe: &mut (impl Read + std::os::windows::io::AsRawHandle),
    output: &mut Vec<u8>,
) -> Result<(), String> {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn PeekNamedPipe(
            handle: *mut c_void,
            buffer: *mut c_void,
            size: u32,
            read: *mut u32,
            available: *mut u32,
            left: *mut u32,
        ) -> i32;
    }
    let mut budget = MAX_OUTPUT + 1;
    let mut buffer = [0; 4096];
    while budget > 0 {
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
            return Err("读取候选自检输出失败，未保存原始输出".into());
        }
        let count = (available as usize).min(buffer.len()).min(budget);
        if count == 0 {
            break;
        }
        let count = pipe
            .read(&mut buffer[..count])
            .map_err(|_| "读取候选自检输出失败")?;
        if count == 0 {
            break;
        }
        if output.len() + count > MAX_OUTPUT {
            return Err("候选自检输出超过限制，未保存原始输出".into());
        }
        output.extend_from_slice(&buffer[..count]);
        budget -= count;
    }
    Ok(())
}
#[cfg(not(windows))]
fn drain(
    pipe: &mut (impl Read + std::os::fd::AsRawFd),
    output: &mut Vec<u8>,
) -> Result<(), String> {
    unsafe extern "C" {
        fn fcntl(fd: i32, cmd: i32, ...) -> i32;
    }
    #[cfg(target_os = "linux")]
    let nonblock = 2048;
    #[cfg(not(target_os = "linux"))]
    let nonblock = 4;
    let fd = pipe.as_raw_fd();
    let flags = unsafe { fcntl(fd, 3) };
    if flags < 0 || unsafe { fcntl(fd, 4, flags | nonblock) } < 0 {
        return Err("无法设置有界自检输出".into());
    }
    let mut buffer = [0; 4096];
    let mut budget = MAX_OUTPUT + 1;
    while budget > 0 {
        let capacity = buffer.len().min(budget);
        match pipe.read(&mut buffer[..capacity]) {
            Ok(0) => break,
            Ok(count) => {
                if output.len() + count > MAX_OUTPUT {
                    return Err("候选自检输出超过限制，未保存原始输出".into());
                }
                output.extend_from_slice(&buffer[..count]);
                budget -= count;
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(_) => return Err("读取候选自检输出失败，未保存原始输出".into()),
        }
    }
    Ok(())
}
fn run(probe: &ProbeCommand, profile: &ProbeProfile) -> Result<String, String> {
    if resource_files::fingerprint(&probe.executable)
        .map_err(|_| "自检执行程序不可核实，未运行候选")?
        .sha256
        != probe.expected_hash
    {
        return Err("自检执行程序已变化，未运行候选".into());
    }
    let executable_identity =
        crate::clients::file_identity(&probe.executable).map_err(|_| "自检执行程序身份不可核实")?;
    let mut command = Command::new(&probe.executable);
    command
        .args(&probe.args)
        .current_dir(&probe.directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // These affect this short-lived child only. Probe bookkeeping belongs to
    // this fresh profile, never the user's original configuration or login.
    isolated_runtime_environment(&mut command);
    profile.apply(&mut command)?;
    if probe.python {
        command
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env("PYTHONNOUSERSITE", "1");
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = OwnedChild(
        command
            .spawn()
            .map_err(|_| "无法启动已核实的候选自检入口，未保存系统错误中的路径")?,
    );
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let started = Instant::now();
    loop {
        if started.elapsed() >= probe.timeout {
            return Err("候选只读自检超时，已结束本次自检进程，当前版本保持".into());
        }
        if let Some(pipe) = child.0.stdout.as_mut() {
            drain(pipe, &mut stdout)?;
        }
        if let Some(pipe) = child.0.stderr.as_mut() {
            drain(pipe, &mut stderr)?;
        }
        if stdout.len() + stderr.len() > MAX_OUTPUT {
            return Err("候选自检输出超过限制，已结束本次自检进程".into());
        }
        if let Some(status) = child.0.try_wait().map_err(|_| "无法读取自检进程状态")? {
            if let Some(pipe) = child.0.stdout.as_mut() {
                drain(pipe, &mut stdout)?;
            }
            if let Some(pipe) = child.0.stderr.as_mut() {
                drain(pipe, &mut stderr)?;
            }
            if !status.success() {
                return Err("候选只读自检未成功退出；未保存原始输出，当前版本保持".into());
            }
            if stdout.len() + stderr.len() > MAX_OUTPUT {
                return Err("候选自检输出超过限制，未保存原始输出".into());
            }
            if resource_files::fingerprint(&probe.executable)
                .map_err(|_| "验证后执行程序不可核实")?
                .sha256
                != probe.expected_hash
                || crate::clients::file_identity(&probe.executable)
                    .map_err(|_| "验证后执行程序身份不可核实")?
                    != executable_identity
            {
                return Err("自检期间执行程序发生变化，本次验证不生效".into());
            }
            return String::from_utf8(stdout)
                .map_err(|_| "候选自检输出格式无法核实，未保存原始输出".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn verify_output(plan: &Plan, outputs: &[String]) -> Result<(), String> {
    if outputs.len() != 2 {
        return Err("只读自检未完成所有固定步骤".into());
    }
    match plan.adapter {
        Adapter::Reach => {
            let output: Value = serde_json::from_str(outputs[0].trim())
                .map_err(|_| "候选版本自检未返回预期格式")?;
            if output["ok"] != true
                || output["action"] != "version"
                || output["result"]["version"].as_str().map(normalized_version)
                    != Some(normalized_version(&plan.version))
                || outputs[1].lines().next()
                    != Some(format!("Agent Reach {}", normalized_version(&plan.version)).as_str())
            {
                return Err("候选 CLI 版本与本地自检结果不一致，不能切换".into());
            }
        }
        Adapter::Edge => {
            if outputs[0].trim() != format!("Version {}", normalized_version(&plan.version))
                || !outputs[1].contains("Options:")
                || !outputs[1].contains("Playwright MCP")
            {
                return Err("候选 CLI 版本或帮助自检不符合预期，不能切换".into());
            }
        }
    }
    Ok(())
}

fn callback_record_matches(record: &ResourceRecord, latest: &Value) -> bool {
    let original = json!(record);
    if *latest == original {
        return true;
    }
    // validate_candidate_with clears a previous successful proof before a new
    // attempt. Only that exact internal mutation may advance this request's CAS.
    if original["installation"]["updateState"]["candidate"]["validation"].is_null() {
        return false;
    }
    let Some(next_revision) = record.revision.checked_add(1) else {
        return false;
    };
    let mut cleared = original;
    cleared["revision"] = json!(next_revision);
    cleared["updatedAt"] = latest["updatedAt"].clone();
    cleared["installation"]["updateState"]["candidate"]["validation"] = Value::Null;
    *latest == cleared
}

/// Verify the installed catalog entry after switching, using the same reviewed
/// command adapter and the original source/action identity. No caller command
/// or earlier success flag can replace this second execution.
pub(crate) fn verify_switched(
    original: &ResourceRecord,
    installed: &ResourceRecord,
    probe_temporary_root: &Path,
) -> Result<resource_update::ProbeEvidence, String> {
    let adapter = select_adapter(original)?;
    let installation = installed
        .installation
        .as_ref()
        .ok_or("切换后安装记录缺失")?;
    let candidate = original
        .installation
        .as_ref()
        .and_then(|i| i.update_state.as_ref())
        .and_then(|s| s.candidate.as_ref())
        .ok_or("原候选记录缺失")?;
    if !same_path(Path::new(&installed.root_path), &candidate.root)?
        || installed.version.as_deref() != Some(candidate.version.as_str())
        || json!(installation.download_source) != json!(candidate.download_source)
        || json!(installation.runtime_package) != json!(candidate.runtime_package)
        || json!(installation.files) != json!(candidate.files)
        || installation.resource_manifest != candidate.resource_manifest
    {
        return Err("切换后的实际目录、版本或来源不再是已验证候选，未运行自检".into());
    }
    if let Some(manifest) = installation.resource_manifest.as_ref() {
        crate::resource_manifest::validate_owned(Path::new(&installed.root_path), manifest)?;
    }
    let target = ValidationTarget {
        root: PathBuf::from(&installed.root_path),
        version: candidate.version.clone(),
        files: installation.files.clone(),
        actions: installed.actions.clone(),
    };
    let plan = prepare(original, &target, adapter)?;
    let profile = ProbeProfile::new(probe_temporary_root)?;
    let outputs = plan
        .commands
        .iter()
        .map(|command| run(command, &profile))
        .collect::<Result<Vec<_>, _>>()?;
    verify_output(&plan, &outputs)?;
    Ok(resource_update::ProbeEvidence {
        adapter: adapter.id().into(),
        verified_scopes: adapter.scopes().iter().map(|s| s.to_string()).collect(),
    })
}

pub(crate) fn verify_restored(
    restored: &ResourceRecord,
    probe_temporary_root: &Path,
) -> Result<resource_update::ProbeEvidence, String> {
    let adapter = current_adapter(restored)?;
    resource_update::verify_registered_runtime(restored)?;
    let installation = restored
        .installation
        .as_ref()
        .ok_or("恢复后的安装记录缺失")?;
    let target = ValidationTarget {
        root: PathBuf::from(&restored.root_path),
        version: restored.version.clone().ok_or("恢复后的版本未知")?,
        files: installation.files.clone(),
        actions: restored.actions.clone(),
    };
    let plan = prepare(restored, &target, adapter)?;
    let profile = ProbeProfile::new(probe_temporary_root)?;
    let outputs = plan
        .commands
        .iter()
        .map(|command| run(command, &profile))
        .collect::<Result<Vec<_>, _>>()?;
    verify_output(&plan, &outputs)?;
    Ok(resource_update::ProbeEvidence {
        adapter: adapter.id().into(),
        verified_scopes: adapter.scopes().iter().map(|s| s.to_string()).collect(),
    })
}

/// Wired only into the native local dispatcher. The parent task system supplies
/// resource execution locking; no agent/HTTP route should forward this mutation.
pub(crate) fn apply_local(m: &Manager, request: &Value) -> Result<Option<Value>, String> {
    if request["action"] != "verify_resource_update" {
        return Ok(None);
    }
    if m.basic_mode {
        return Err("基本模式不运行候选验证".into());
    }
    m.ensure_request_allowed(request)?;
    if request.as_object().is_none_or(|o| {
        o.keys()
            .any(|k| !["action", "id", "expectedRevision"].contains(&k.as_str()))
    }) {
        return Err("验证请求只能指定资源和修订号，不能提交命令或通过标记".into());
    }
    let id = request["id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("缺少资源标识")?;
    let record: ResourceRecord =
        serde_json::from_value(m.resource_store(StoreRequest::Get(id.into()))?)
            .map_err(|_| "资源记录无效")?;
    if request["expectedRevision"].as_u64() != Some(record.revision) {
        return Err("资源已变化，请重新读取后验证".into());
    }
    let adapter = select_adapter(&record)?;
    let mut result = resource_update::validate_candidate_with(m, id, adapter.id(), |target| {
        if !callback_record_matches(&record, &m.resource_store(StoreRequest::Get(id.into()))?) {
            return Err("资源修订已变化，本次验证不生效".into());
        }
        let plan = prepare(&record, target, adapter)?;
        let profile = ProbeProfile::new(&m.storage.path("temp")?)?;
        let outputs = plan
            .commands
            .iter()
            .map(|command| run(command, &profile))
            .collect::<Result<Vec<_>, _>>()?;
        verify_output(&plan, &outputs)
    })?;
    result["verifiedScopes"] = json!(adapter.scopes());
    result["platformCallsVerified"] = json!(false);
    result["userSessionVerified"] = json!(false);
    result["scope"] = json!("readOnlyEntrypointProbe");
    result["probeEnvironment"] = json!("isolatedTemporaryHome");
    Ok(Some(result))
}

#[cfg(test)]
#[path = "resource_probe/tests.rs"]
mod tests;
