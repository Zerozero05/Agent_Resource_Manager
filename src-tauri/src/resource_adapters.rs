//! Native adoption of known existing layouts. Inspection never starts a tool,
//! changes its files, imports credentials, or manufactures installation ownership.
use crate::{
    model::{now, Manager},
    resource_files::{self, Fingerprint},
    resource_runtime::ActionDefinition,
    resources::{ResourceRecord, StoreRequest},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

const REACH: &str = "agentReach";
const EDGE: &str = "edgeControl";
const DRAGON: &str = "dragonCodexBoot";
const EDGE_CLI: &str = "node_modules/@playwright/mcp/cli.js";
const MAX_TEXT: u64 = 1024 * 1024;

// The bound Playwright core accepts these as implicit configuration, in addition
// to CLI flags. Keep the two approved extension calls fixed even if the manager
// inherited another client's configuration. The extension token is deliberately
// absent: the child may inherit it naturally; the manager never reads its value.
const EDGE_ENV_OVERRIDES: &[&str] = &[
    "PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS",
    "PLAYWRIGHT_MCP_ALLOWED_HOSTS",
    "PLAYWRIGHT_MCP_ALLOWED_ORIGINS",
    "PLAYWRIGHT_MCP_BLOCK_SERVICE_WORKERS",
    "PLAYWRIGHT_MCP_BLOCKED_ORIGINS",
    "PLAYWRIGHT_MCP_BROWSER",
    "PLAYWRIGHT_MCP_CAPS",
    "PLAYWRIGHT_MCP_CDP_ENDPOINT",
    "PLAYWRIGHT_MCP_CDP_HEADERS",
    "PLAYWRIGHT_MCP_CDP_TIMEOUT",
    "PLAYWRIGHT_MCP_CODEGEN",
    "PLAYWRIGHT_MCP_CONFIG",
    "PLAYWRIGHT_MCP_CONSOLE_LEVEL",
    "PLAYWRIGHT_MCP_DEVICE",
    "PLAYWRIGHT_MCP_EXECUTABLE_PATH",
    "PLAYWRIGHT_MCP_EXTENSION",
    "PLAYWRIGHT_MCP_FILE_PATHS",
    "PLAYWRIGHT_MCP_GRANT_PERMISSIONS",
    "PLAYWRIGHT_MCP_HEADLESS",
    "PLAYWRIGHT_MCP_HOST",
    "PLAYWRIGHT_MCP_IDLE_TIMEOUT",
    "PLAYWRIGHT_MCP_IGNORE_HTTPS_ERRORS",
    "PLAYWRIGHT_MCP_IMAGE_RESPONSES",
    "PLAYWRIGHT_MCP_INIT_PAGE",
    "PLAYWRIGHT_MCP_INIT_SCRIPT",
    "PLAYWRIGHT_MCP_ISOLATED",
    "PLAYWRIGHT_MCP_MOBILE",
    "PLAYWRIGHT_MCP_OUTPUT_DIR",
    "PLAYWRIGHT_MCP_OUTPUT_MAX_SIZE",
    "PLAYWRIGHT_MCP_PING_TIMEOUT_MS",
    "PLAYWRIGHT_MCP_PORT",
    "PLAYWRIGHT_MCP_PROFILE_DIR_NAME",
    "PLAYWRIGHT_MCP_PROXY_BYPASS",
    "PLAYWRIGHT_MCP_PROXY_SERVER",
    "PLAYWRIGHT_MCP_REMOTE_HEADERS",
    "PLAYWRIGHT_MCP_SANDBOX",
    "PLAYWRIGHT_MCP_SECRETS_FILE",
    "PLAYWRIGHT_MCP_STORAGE_STATE",
    "PLAYWRIGHT_MCP_TEST_ID_ATTRIBUTE",
    "PLAYWRIGHT_MCP_TIMEOUT_ACTION",
    "PLAYWRIGHT_MCP_TIMEOUT_NAVIGATION",
    "PLAYWRIGHT_MCP_TIMEOUT_SETTLE",
    "PLAYWRIGHT_MCP_USER_AGENT",
    "PLAYWRIGHT_MCP_USER_DATA_DIR",
    "PLAYWRIGHT_MCP_VIEWPORT_SIZE",
    "PLAYWRIGHT_MCP_WEBMCP",
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BoundFile {
    path: String,
    object_identity: String,
    fingerprint: Fingerprint,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActionBinding {
    pub adapter: String,
    pub root_path: String,
    root_identity: String,
    files: Vec<BoundFile>,
    /// Existing shared Node is referenced, never adopted as owned runtime.
    pub node_path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Inspection {
    adapter: String,
    name: String,
    kind: String,
    root_path: String,
    version: String,
    repository: Option<String>,
    license: String,
    binding: ActionBinding,
    actions: Vec<Value>,
    preserved: Vec<String>,
    warnings: Vec<String>,
}

fn display(path: &Path) -> String {
    let value = path.to_string_lossy();
    value
        .strip_prefix(r"\\?\UNC\")
        .map(|s| format!(r"\\{s}"))
        .or_else(|| value.strip_prefix(r"\\?\").map(str::to_owned))
        .unwrap_or_else(|| value.into_owned())
}
fn key(path: &Path) -> String {
    let value = display(path);
    if cfg!(windows) {
        value.replace('/', "\\").to_ascii_lowercase()
    } else {
        value
    }
}
fn actual(path: &Path, directory: bool) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("请选择现有工具的绝对路径".into());
    }
    crate::transaction::verify_root(path)?;
    let path = crate::local::canonical(path)?;
    if if directory {
        !path.is_dir()
    } else {
        !path.is_file()
    } {
        return Err("工具入口或目录不可用，未登记也未运行".into());
    }
    Ok(PathBuf::from(display(&path)))
}
fn bind(path: &Path) -> Result<BoundFile, String> {
    let path = actual(path, false)?;
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 256 * 1024 * 1024 {
        return Err("入口文件超过接管核对范围，未运行".into());
    }
    Ok(BoundFile {
        path: display(&path),
        object_identity: crate::clients::file_identity(&path)?,
        fingerprint: resource_files::fingerprint(&path)?,
    })
}
fn text(path: &Path) -> Result<String, String> {
    actual(path, false)?;
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > MAX_TEXT {
        return Err("工具元数据超过读取范围".into());
    }
    fs::read_to_string(path).map_err(|_| "工具元数据不是可读取的 UTF-8 文本".into())
}
fn version(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 80
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b'+'))
        || !value.bytes().any(|c| c.is_ascii_digit())
    {
        return Err("本地版本元数据无效，未猜测版本".into());
    }
    Ok(value.into())
}
fn python_version(value: &str) -> Result<String, String> {
    let line = value
        .lines()
        .find(|line| line.trim_start().starts_with("__version__ ="))
        .and_then(|line| line.split_once('=').map(|(_, value)| value.trim()))
        .ok_or("Agent Reach 缺少可读取的版本元数据")?;
    let quote = line.chars().next().ok_or("版本元数据为空")?;
    if !matches!(quote, '\'' | '"') || !line.ends_with(quote) || line.len() < 3 {
        return Err("版本元数据格式不支持".into());
    }
    version(&line[1..line.len() - 1])
}
fn definition(
    binding: &ActionBinding,
    id: &str,
    label: &str,
    executable: &Path,
    args: Vec<String>,
    seconds: u64,
) -> Result<Value, String> {
    let executable = actual(executable, false)?;
    let proof = binding
        .files
        .iter()
        .find(|file| key(Path::new(&file.path)) == key(&executable))
        .ok_or("动作缺少已核对的入口")?;
    let value = json!({"id":id,"label":label,"mode":"task","cancellable":true,"executable":display(&executable),"workingDirectory":binding.root_path,
        "args":args.into_iter().map(|value|json!({"type":"literal","value":value})).collect::<Vec<_>>(),"parameters":[],"timeoutSeconds":seconds,
        "executableSha256":proof.fingerprint.sha256,"adapterBinding":binding});
    let value: ActionDefinition = serde_json::from_value(value).map_err(|e| e.to_string())?;
    Ok(json!(value))
}
fn inspect(
    adapter: &str,
    selected_root: &Path,
    supplied_node: Option<&Path>,
) -> Result<Inspection, String> {
    let root = actual(selected_root, true)?;
    let mut binding = ActionBinding {
        adapter: adapter.into(),
        root_path: display(&root),
        root_identity: crate::clients::file_identity(&root)?,
        files: vec![],
        node_path: None,
    };
    let mut keep = |relative: &str| -> Result<(), String> {
        binding
            .files
            .push(bind(&crate::local::safe_join(&root, relative)?)?);
        Ok(())
    };
    let (name, kind, detected_version, repository, license, preserved, warnings) = match adapter {
        REACH => {
            if supplied_node.is_some() {
                return Err("Agent Reach 不使用 Node 路径".into());
            }
            for relative in [
                "Scripts/agent-reach.exe",
                "Scripts/python.exe",
                "pyvenv.cfg",
                "Lib/site-packages/agent_reach/__init__.py",
                "Lib/site-packages/agent_reach/cli.py",
                "Lib/site-packages/agent_reach/runtime/cli.py",
                "Lib/site-packages/agent_reach/runtime/manage.py",
                "agent-reach.cmd",
            ] {
                keep(relative)?;
            }
            let wrapper = text(&root.join("agent-reach.cmd"))?.replace('\r', "");
            if !wrapper.contains("set \"PYTHONDONTWRITEBYTECODE=1\"")
                || !wrapper.contains("set \"PATH=%~dp0Scripts;%PATH%\"")
                || !wrapper.contains("\"%~dp0Scripts\\agent-reach.exe\" %*")
            {
                return Err(
                    "现有 Agent Reach 包装入口与固定适配器不一致；保留本地改造，未代替执行".into(),
                );
            }
            let cli = text(&root.join("Lib/site-packages/agent_reach/runtime/cli.py"))?;
            if !["_cmd_channels", "_cmd_doctor", "version"]
                .iter()
                .all(|needle| cli.contains(needle))
            {
                return Err("Agent Reach 命令布局无法核实".into());
            }
            let v = python_version(&text(
                &root.join("Lib/site-packages/agent_reach/__init__.py"),
            )?)?;
            let metadata_path = root.join(format!(
                "Lib/site-packages/agent_reach-{v}.dist-info/METADATA"
            ));
            let metadata = text(&metadata_path)?;
            if !metadata
                .lines()
                .any(|line| line.trim() == "Name: agent-reach")
                || !metadata
                    .lines()
                    .any(|line| line.trim() == format!("Version: {v}"))
                || !metadata.lines().any(|line| line.trim() == "License: MIT")
                || !metadata.lines().any(|line| {
                    line.trim().eq_ignore_ascii_case(
                        "Project-URL: Repository, https://github.com/Panniantong/agent-reach",
                    )
                })
            {
                return Err(
                    "Agent Reach 安装包的名称、版本、许可证或声明来源无法核实；本地文件保持".into(),
                );
            }
            binding.files.push(bind(&metadata_path)?);
            let license_path = metadata_path
                .parent()
                .ok_or("安装元数据位置无效")?
                .join("licenses/LICENSE");
            if !text(&license_path)?.contains("MIT License") {
                return Err("Agent Reach 许可证与安装包声明不一致，未猜测许可".into());
            }
            binding.files.push(bind(&license_path)?);
            (
                "Agent Reach",
                "cli",
                v,
                Some("https://github.com/Panniantong/agent-reach".into()),
                "MIT（已安装包元数据；本地改造保留）",
                vec!["data/", "records/", "本地平台修复及现有登录会话"],
                vec![
                    "只读取本地元数据；尚未执行版本、doctor 或平台调用。",
                    "已安装来源为包声明，尚未联网核对仓库或发行文件；不产生自动更新许可。",
                ],
            )
        }
        EDGE => {
            for relative in [
                EDGE_CLI,
                "node_modules/@playwright/mcp/package.json",
                "node_modules/@playwright/mcp/LICENSE",
                "node_modules/playwright-core/package.json",
                "node_modules/playwright-core/lib/coreBundle.js",
                "node_modules/playwright-core/lib/utilsBundle.js",
                "install-manifest.json",
            ] {
                keep(relative)?;
            }
            let package: Value = serde_json::from_str(&text(
                &root.join("node_modules/@playwright/mcp/package.json"),
            )?)
            .map_err(|_| "MCP 包元数据无效")?;
            if package["name"] != "@playwright/mcp"
                || package["license"] != "Apache-2.0"
                || !text(&root.join("node_modules/@playwright/mcp/LICENSE"))?
                    .contains("Apache License")
                || package["repository"]["url"]
                    != "git+https://github.com/microsoft/playwright-mcp.git"
            {
                return Err("本地 MCP 包身份与 Playwright MCP 固定适配器不符".into());
            }
            let v = version(package["version"].as_str().ok_or("MCP 包版本缺失")?)?;
            let core: Value = serde_json::from_str(&text(
                &root.join("node_modules/playwright-core/package.json"),
            )?)
            .map_err(|_| "MCP 实际控制库元数据无效")?;
            if core["name"] != "playwright-core" || core["license"] != "Apache-2.0" {
                return Err("MCP 实际控制库身份无法核实".into());
            }
            version(core["version"].as_str().ok_or("MCP 实际控制库版本缺失")?)?;
            let manifest: Value = serde_json::from_str(&text(&root.join("install-manifest.json"))?)
                .map_err(|_| "Playwright MCP 安装元数据无效")?;
            if manifest["mode"] != "extension" || manifest["browser"] != "msedge" {
                return Err(
                    "仅接管使用现有 Edge 扩展连接的布局，未创建浏览器配置或更换连接方式".into(),
                );
            }
            let node = supplied_node
                .map(Path::to_owned)
                .or_else(|| manifest["nodePath"].as_str().map(PathBuf::from))
                .ok_or("请选择现有 Node 可执行文件，不下载运行环境")?;
            let node = actual(&node, false)?;
            if !node
                .file_name()
                .is_some_and(|name| name.eq_ignore_ascii_case("node.exe"))
            {
                return Err("请选择现有 node.exe，不使用 Shell 或其他脚本宿主".into());
            }
            binding.files.push(bind(&node)?);
            binding.node_path = Some(display(&node));
            ("Playwright MCP", "mcp", v, Some("https://github.com/microsoft/playwright-mcp".into()), "Apache-2.0", vec!["runtime/", "现有 Edge 扩展、Default 配置和网页登录"], vec!["确认接管后，可通过管理器自有 MCP 连接列出标签页或读取当前页面快照；首次连接可能需要已有扩展配对。", "不接管其他客户端进程，不创建浏览器配置；安装记录中的既往验证不作为本次调用证据。"])
        }
        DRAGON => {
            if supplied_node.is_some() {
                return Err("DragonCodexBoot 不使用 Node 路径".into());
            }
            for relative in ["DragonCodexBoot.exe", "VERSION", "launcher.json", "LICENSE"] {
                keep(relative)?;
            }
            let v = version(&text(&root.join("VERSION"))?)?;
            let config: Value = serde_json::from_str(&text(&root.join("launcher.json"))?)
                .map_err(|_| "Dragon 启动配置无效")?;
            if config["DisplayName"] != "Dragon Codex Boot" {
                return Err("Dragon 启动配置身份无法核实".into());
            }
            if !text(&root.join("LICENSE"))?.contains("MIT License") {
                return Err("Dragon 本地许可证无法核实，未猜测许可".into());
            }
            (
                "DragonCodexBoot",
                "portable",
                v,
                None,
                "MIT",
                vec![
                    "launcher.json",
                    "media/",
                    ".integration/",
                    "现有启动入口和集成记录",
                ],
                vec![
                    "只读取 VERSION、入口摘要和启动配置；不使用 --help 或 --version 试启动。",
                    "启动器配置可能扫描磁盘并替换入口，因此本次不登记启动动作；原生入口保持。",
                    "尚未核实上游仓库地址，不猜测来源。",
                ],
            )
        }
        _ => return Err("没有此工具的固定接管适配器".into()),
    };
    let mut actions = vec![];
    if adapter == REACH {
        let exe = root.join("Scripts/agent-reach.exe");
        for (id, label, args, seconds) in [
            ("reach-version", "读取 CLI 版本", vec!["version".into()], 10),
            (
                "reach-doctor",
                "检查本地依赖",
                vec!["doctor".into(), "--text".into()],
                25,
            ),
            (
                "reach-channels",
                "列出平台与动作",
                vec!["channels".into()],
                15,
            ),
        ] {
            actions.push(definition(&binding, id, label, &exe, args, seconds)?);
        }
        let mut read = definition(
            &binding,
            "reach-read",
            "读取公共网页",
            &exe,
            vec![
                "web".into(),
                "read".into(),
                "PUBLIC_URL".into(),
                "--backend".into(),
                "jina".into(),
                "--timeout".into(),
                "30".into(),
            ],
            40,
        )?;
        read["args"][2] = json!({"type":"parameter","name":"url"});
        read["parameters"] = json!([{"name":"url","label":"公开网页 URL","kind":"text","required":true,"maxLength":4096}]);
        actions.push(read);
    } else if adapter == EDGE {
        let node = Path::new(binding.node_path.as_ref().ok_or("Node 入口缺失")?);
        for (id, label, flag) in [
            ("edge-version", "读取 MCP 版本", "--version"),
            ("edge-help", "读取 MCP 帮助", "--help"),
        ] {
            actions.push(definition(
                &binding,
                id,
                label,
                node,
                vec![display(&root.join(EDGE_CLI)), flag.into()],
                10,
            )?);
        }
        for (id, label) in [
            ("edge-tabs", "列出 Edge 标签页"),
            ("edge-snapshot", "读取当前 Edge 页面"),
        ] {
            let mut action = definition(
                &binding,
                id,
                label,
                node,
                vec![
                    display(&root.join(EDGE_CLI)),
                    "--extension".into(),
                    "--browser".into(),
                    "msedge".into(),
                    "--profile-dir-name".into(),
                    "Default".into(),
                    "--output-dir".into(),
                    display(&root.join("runtime")),
                ],
                40,
            )?;
            action["idleReleaseSafe"] = json!(true);
            action["idleUsageTracked"] = json!(true);
            action["idleTimeoutSeconds"] = json!(600);
            actions.push(action);
        }
    }
    Ok(Inspection {
        adapter: adapter.into(),
        name: name.into(),
        kind: kind.into(),
        root_path: display(&root),
        version: detected_version,
        repository,
        license: license.into(),
        binding,
        actions,
        preserved: preserved.into_iter().map(str::to_owned).collect(),
        warnings: warnings.into_iter().map(str::to_owned).collect(),
    })
}

fn action_without_policy(value: &ActionDefinition) -> Result<Value, String> {
    let mut value = json!(value);
    for field in ["idleReleaseSafe", "idleUsageTracked", "idleTimeoutSeconds"] {
        value.as_object_mut().expect("definition").remove(field);
    }
    // Runtime validation canonicalizes these two paths (including Windows' verbatim
    // spelling). Compare the actual object and its canonical path, not its spelling.
    // Fixed arguments, parameters, hashes and the complete adoption binding remain exact.
    for (field, directory) in [("executable", false), ("workingDirectory", true)] {
        let path = actual(
            Path::new(value[field].as_str().ok_or("动作实际路径缺失")?),
            directory,
        )?;
        value[field] =
            json!({"path":key(&path),"objectIdentity":crate::clients::file_identity(&path)?});
    }
    Ok(value)
}
pub(crate) fn same_fixed_execution(
    left: &ActionDefinition,
    right: &ActionDefinition,
) -> Result<bool, String> {
    Ok(action_without_policy(left)? == action_without_policy(right)?)
}
fn inspect_binding(binding: &ActionBinding) -> Result<Inspection, String> {
    let value = inspect(
        &binding.adapter,
        Path::new(&binding.root_path),
        binding.node_path.as_deref().map(Path::new),
    )?;
    if value.binding != *binding {
        return Err("已接管入口、元数据或对象身份发生变化，请重新预览；保留原文件，未运行".into());
    }
    Ok(value)
}
pub(crate) fn validate_action(
    record: &ResourceRecord,
    definition: &ActionDefinition,
) -> Result<(), String> {
    let Some(binding) = &definition.adapter_binding else {
        return Ok(());
    };
    if key(Path::new(&record.root_path)) != key(Path::new(&binding.root_path)) {
        return Err("接管绑定与资源目录不一致".into());
    }
    validate_bound_action(definition)
}
pub(crate) fn validate_public_url(value: &str) -> Result<(), String> {
    let reject = || "仅接受不含登录信息、凭据参数或片段的公开 HTTP(S) 网页 URL".to_string();
    if value.len() > 4096 || value.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(reject());
    }
    let url = url::Url::parse(value).map_err(|_| reject())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
    {
        return Err(reject());
    }
    let host = url.host_str().unwrap_or_default();
    if host.eq_ignore_ascii_case("localhost")
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || url.host().is_some_and(|host| match host {
            url::Host::Ipv4(ip) => {
                ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_unspecified()
            }
            url::Host::Ipv6(ip) => {
                ip.is_loopback()
                    || ip.is_unspecified()
                    || ip.is_unique_local()
                    || ip.is_unicast_link_local()
            }
            _ => false,
        })
        || url.query_pairs().any(|(key, _)| {
            crate::resource_runtime::sensitive_parameter_name(&key)
                || matches!(
                    key.to_ascii_lowercase().as_str(),
                    "key" | "sig" | "signature" | "jwt"
                )
        })
    {
        return Err(reject());
    }
    Ok(())
}
pub(crate) fn validate_bound_action(definition: &ActionDefinition) -> Result<(), String> {
    let Some(binding) = &definition.adapter_binding else {
        return Ok(());
    };
    let inspection = inspect_binding(binding)?;
    let expected = inspection
        .actions
        .iter()
        .find(|action| action["id"] == definition.id)
        .ok_or("未登记此适配器的固定动作")?;
    let expected: ActionDefinition =
        serde_json::from_value(expected.clone()).map_err(|e| e.to_string())?;
    if !same_fixed_execution(definition, &expected)? {
        return Err("接管动作的入口、固定参数或权限已变化，请重新预览".into());
    }
    Ok(())
}
pub(crate) fn apply_environment(
    definition: &ActionDefinition,
    command: &mut Command,
) -> Result<(), String> {
    let Some(binding) = &definition.adapter_binding else {
        return Ok(());
    };
    validate_bound_action(definition)?;
    match binding.adapter.as_str() {
        REACH => {
            let mut paths = vec![Path::new(&binding.root_path).join("Scripts")];
            if let Some(existing) = std::env::var_os("PATH") {
                paths.extend(std::env::split_paths(&existing));
            }
            let paths =
                std::env::join_paths(paths).map_err(|_| "无法准备当前工具的 Scripts 路径")?;
            command
                .env("PYTHONDONTWRITEBYTECODE", "1")
                .env("PATH", paths);
        }
        EDGE => {
            for key in EDGE_ENV_OVERRIDES {
                command.env_remove(key);
            }
            command
                .env_remove("NODE_OPTIONS")
                .env_remove("NODE_PATH")
                .env("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", "1");
        }
        _ => return Err("此接管适配器没有执行动作".into()),
    }
    Ok(())
}
pub(crate) fn rebind_candidate(
    old: &ResourceRecord,
    candidate_root: &Path,
    definition: &mut ActionDefinition,
) -> Result<(), String> {
    let original = crate::resource_runtime::registered_definition(old, &definition.id)?;
    let Some(binding) = original.adapter_binding.as_ref() else {
        return Ok(());
    };
    validate_action(old, &original)?;
    let next = inspect(
        &binding.adapter,
        candidate_root,
        binding.node_path.as_deref().map(Path::new),
    )?;
    let expected: ActionDefinition = serde_json::from_value(
        next.actions
            .iter()
            .find(|action| action["id"] == definition.id)
            .ok_or("候选不具备原固定适配器动作")?
            .clone(),
    )
    .map_err(|e| e.to_string())?;
    let mut rebound = definition.clone();
    rebound.adapter_binding = expected.adapter_binding.clone();
    if !same_fixed_execution(&rebound, &expected)? {
        return Err("候选固定入口与原适配器范围不一致，未扩大命令权限".into());
    }
    definition.adapter_binding = rebound.adapter_binding;
    Ok(())
}

fn allowed(request: &Value, fields: &[&str]) -> Result<(), String> {
    if request
        .as_object()
        .is_none_or(|object| object.keys().any(|key| !fields.contains(&key.as_str())))
    {
        Err("接管请求包含未批准字段".into())
    } else {
        Ok(())
    }
}
fn existing(m: &Manager, root: &str) -> Result<Option<ResourceRecord>, String> {
    let listed = m.resource_store(StoreRequest::List)?;
    for value in listed["resources"].as_array().ok_or("工具目录不可读取")? {
        let record: ResourceRecord =
            serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
        if key(Path::new(&record.root_path)) == key(Path::new(root)) {
            return Ok(Some(record));
        }
    }
    Ok(None)
}

fn refresh_definition(value: &Value) -> Result<ActionDefinition, String> {
    // Additional catalogue metadata is retained in the original JSON on save.
    // Only the execution fields understood by this adapter participate in checks.
    let mut definition = value.clone();
    definition
        .as_object_mut()
        .ok_or("已登记动作不是可读取的对象")?
        .retain(|field, _| {
            matches!(
                field.as_str(),
                "id" | "label"
                    | "mode"
                    | "cancellable"
                    | "executable"
                    | "workingDirectory"
                    | "args"
                    | "parameters"
                    | "timeoutSeconds"
                    | "executableSha256"
                    | "idleReleaseSafe"
                    | "idleUsageTracked"
                    | "idleTimeoutSeconds"
                    | "adapterBinding"
            )
        });
    serde_json::from_value(definition).map_err(|e| format!("已登记动作无法核对：{e}"))
}

fn normalized_binding(binding: &ActionBinding) -> Result<ActionBinding, String> {
    let mut normalized = binding.clone();
    normalized.root_path = key(&actual(Path::new(&binding.root_path), true)?);
    normalized.node_path = binding
        .node_path
        .as_deref()
        .map(|path| actual(Path::new(path), false).map(|path| key(&path)))
        .transpose()?;
    for file in &mut normalized.files {
        file.path = key(&actual(Path::new(&file.path), false)?);
    }
    Ok(normalized)
}

fn refreshed_node_actions(
    record: &ResourceRecord,
    inspection: &Inspection,
) -> Result<(Vec<Value>, Value), String> {
    let first = record.actions.first().ok_or("此资源没有已登记固定动作")?;
    let first = refresh_definition(first)?;
    let binding = first
        .adapter_binding
        .as_ref()
        .ok_or("此资源不是固定适配器接管")?;
    if binding.adapter != EDGE
        || inspection.adapter != EDGE
        || record.kind != inspection.kind
        || key(&actual(Path::new(&record.root_path), true)?)
            != key(&actual(Path::new(&binding.root_path), true)?)
    {
        return Err("仅支持在原资源中重新核对 Playwright MCP 的同一 Node 入口".into());
    }
    let before = normalized_binding(binding)?;
    let after = normalized_binding(&inspection.binding)?;
    let node_path = before
        .node_path
        .as_deref()
        .ok_or("原固定绑定缺少 Node 入口")?;
    if after.node_path.as_deref() != Some(node_path) {
        return Err("Node 入口路径已变化，未更换原执行权限".into());
    }
    let old_node = before
        .files
        .iter()
        .find(|file| file.path == node_path)
        .ok_or("原固定绑定缺少 Node 指纹")?;
    let new_node = after
        .files
        .iter()
        .find(|file| file.path == node_path)
        .ok_or("当前固定绑定缺少 Node 指纹")?;
    let mut expected_binding = before.clone();
    for file in &mut expected_binding.files {
        if file.path == node_path {
            *file = new_node.clone();
        }
    }
    if expected_binding != after {
        return Err("Node 以外的工具入口、布局或元数据已变化；本次不扩大原绑定范围".into());
    }
    let expected_ids = inspection
        .actions
        .iter()
        .map(|value| value["id"].as_str().ok_or("固定动作缺少标识"))
        .collect::<Result<std::collections::BTreeSet<_>, _>>()?;
    let mut seen = std::collections::BTreeSet::new();
    let mut actions = Vec::with_capacity(record.actions.len());
    for original in &record.actions {
        let definition = refresh_definition(original)?;
        if !seen.insert(definition.id.clone()) {
            return Err("已登记固定动作标识重复，未改写".into());
        }
        let mut expected: ActionDefinition = serde_json::from_value(
            inspection
                .actions
                .iter()
                .find(|value| value["id"] == definition.id)
                .ok_or("已登记动作集合与固定适配器不一致，未新增或移除动作")?
                .clone(),
        )
        .map_err(|e| e.to_string())?;
        let original_binding = definition
            .adapter_binding
            .as_ref()
            .ok_or("已登记动作缺少固定适配器绑定")?;
        if normalized_binding(original_binding)? != before
            || definition.executable_sha256.as_deref() != Some(old_node.fingerprint.sha256.as_str())
        {
            return Err("已登记动作的原执行指纹或绑定不一致，未改写".into());
        }
        // Labels, timeouts and idle policies are existing user settings, not new
        // execution authority. The remaining fixed execution must stay exact.
        expected.label = definition.label.clone();
        expected.timeout_seconds = definition.timeout_seconds;
        let mut refreshed = definition.clone();
        refreshed.executable_sha256 = Some(new_node.fingerprint.sha256.clone());
        refreshed.adapter_binding = Some(inspection.binding.clone());
        if !same_fixed_execution(&refreshed, &expected)? {
            return Err("已登记动作的参数、权限或执行方式与固定适配器不一致，未改写".into());
        }
        let mut value = original.clone();
        value["executableSha256"] = json!(new_node.fingerprint.sha256);
        value["adapterBinding"] = json!(inspection.binding);
        actions.push(value);
    }
    if seen.len() != expected_ids.len() || seen.iter().any(|id| !expected_ids.contains(id.as_str()))
    {
        return Err("已登记动作集合与固定适配器不一致，未新增或移除动作".into());
    }
    Ok((
        actions,
        json!({"path":inspection.binding.node_path,"previousSha256":old_node.fingerprint.sha256,"currentSha256":new_node.fingerprint.sha256}),
    ))
}

fn preview_node_refresh(m: &mut Manager, request: &Value) -> Result<Value, String> {
    allowed(
        request,
        &[
            "action",
            "operation",
            "resourceId",
            "expectedRevision",
            "adapter",
            "rootPath",
            "nodePath",
        ],
    )?;
    let id = request["resourceId"].as_str().ok_or("请选择已登记资源")?;
    let revision = request["expectedRevision"]
        .as_u64()
        .ok_or("缺少原资源修订号")?;
    let prior: ResourceRecord =
        serde_json::from_value(m.resource_store(StoreRequest::Get(id.into()))?)
            .map_err(|e| e.to_string())?;
    if prior.revision != revision {
        return Err("资源已变化，请刷新详情后重新核对入口".into());
    }
    let first = refresh_definition(prior.actions.first().ok_or("此资源没有已登记固定动作")?)?;
    let binding = first
        .adapter_binding
        .as_ref()
        .ok_or("此资源不是固定适配器接管")?;
    if binding.adapter != EDGE {
        return Err("本次仅支持重新核对 Playwright MCP 的 Node 入口".into());
    }
    let node = binding
        .node_path
        .as_deref()
        .ok_or("原固定绑定缺少 Node 入口")?;
    for (field, expected, directory) in [
        ("rootPath", binding.root_path.as_str(), true),
        ("nodePath", node, false),
    ] {
        if let Some(value) = request.get(field) {
            let value = value.as_str().ok_or("固定入口路径必须是文字")?;
            if key(&actual(Path::new(value), directory)?)
                != key(&actual(Path::new(expected), directory)?)
            {
                return Err("本次重新核对不能更换工具目录或 Node 路径".into());
            }
        }
    }
    if request
        .get("adapter")
        .is_some_and(|value| value.as_str() != Some(EDGE))
    {
        return Err("本次重新核对不能更换固定适配器".into());
    }
    let inspection = inspect(EDGE, Path::new(&binding.root_path), Some(Path::new(node)))?;
    let (_, change) = refreshed_node_actions(&prior, &inspection)?;
    let id = uuid::Uuid::new_v4().to_string();
    let public = json!({"id":id,"kind":"resourceAdapter","operation":"refreshNode","adapter":EDGE,"name":prior.name,"rootPath":inspection.root_path,"resourceId":prior.id,"resourceRevision":prior.revision,
        "detectedVersion":inspection.version,"versionEvidence":"本地版本元数据；未执行程序","repository":prior.repository,"sourceVerified":false,"license":inspection.license,"actions":prior.actions,"preserved":inspection.preserved,"warnings":["仅更新同一路径的 Node 指纹；原动作、策略与资源信息保留，确认前不运行。"],"runtimeChange":change,"canApply":true,"deleteGrant":false,"automaticUpdateGrant":false,"filesChanged":false});
    let stored = json!({"kind":"resourceAdapter","operation":"refreshNode","createdAt":chrono::Utc::now().timestamp_millis(),"targetPath":inspection.root_path,"resourceId":prior.id,"public":public,"inspection":inspection,"prior":prior});
    m.previews.retain(|_, value| {
        value["kind"] != "resourceAdapter"
            || value["createdAt"]
                .as_i64()
                .is_some_and(|at| chrono::Utc::now().timestamp_millis() - at < 600_000)
    });
    m.previews.insert(id, stored);
    Ok(public)
}

pub(crate) fn preview_local(m: &mut Manager, request: &Value) -> Result<Option<Value>, String> {
    if request["action"] != "preview_resource_adapter" {
        return Ok(None);
    }
    if m.basic_mode {
        return Err("基本模式只读，不准备新的接管权限".into());
    }
    if request["operation"] == "refreshNode" {
        return preview_node_refresh(m, request).map(Some);
    }
    allowed(request, &["action", "adapter", "rootPath", "nodePath"])?;
    let adapter = request["adapter"].as_str().ok_or("请选择接管类型")?;
    let root = request["rootPath"].as_str().ok_or("请选择现有工具目录")?;
    let node = match request.get("nodePath") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if value.is_empty() => None,
        Some(Value::String(value)) => Some(Path::new(value)),
        _ => return Err("Node 路径必须是文字".into()),
    };
    let inspection = inspect(adapter, Path::new(root), node)?;
    let prior = existing(m, &inspection.root_path)?;
    if prior
        .as_ref()
        .is_some_and(|record| record.installation.is_some() || !record.actions.is_empty())
    {
        return Err(
            "该目录已有安装或执行权限记录；请在现有资源中管理，避免覆盖本地范围与动作".into(),
        );
    }
    if prior
        .as_ref()
        .is_some_and(|record| record.kind != inspection.kind)
    {
        return Err(
            "已登记资源类型与固定适配器不一致，请先核对原登记；未改写其类型或调用权限".into(),
        );
    }
    let id = uuid::Uuid::new_v4().to_string();
    let public = json!({"id":id,"kind":"resourceAdapter","adapter":adapter,"name":inspection.name,"rootPath":inspection.root_path,"resourceId":prior.as_ref().map(|r|&r.id),"resourceRevision":prior.as_ref().map(|r|r.revision),
        "detectedVersion":inspection.version,"versionEvidence":"本地版本元数据；未执行程序","repository":inspection.repository,"sourceVerified":false,"license":inspection.license,"actions":inspection.actions,"preserved":inspection.preserved,"warnings":inspection.warnings,"canApply":true,"deleteGrant":false,"automaticUpdateGrant":false,"filesChanged":false});
    let stored = json!({"kind":"resourceAdapter","createdAt":chrono::Utc::now().timestamp_millis(),"targetPath":inspection.root_path,"resourceId":prior.as_ref().map(|r|&r.id),"public":public,"inspection":inspection,"prior":prior});
    m.previews.retain(|_, value| {
        value["kind"] != "resourceAdapter"
            || value["createdAt"]
                .as_i64()
                .is_some_and(|at| chrono::Utc::now().timestamp_millis() - at < 600_000)
    });
    m.previews.insert(id, stored);
    Ok(Some(public))
}
pub(crate) fn apply_local(m: &mut Manager, request: &Value) -> Result<Option<Value>, String> {
    if request["action"] != "apply_resource_adapter" {
        return Ok(None);
    }
    if m.basic_mode {
        return Err("基本模式不保存接管或执行权限".into());
    }
    allowed(request, &["action", "previewId"])?;
    let id = request["previewId"].as_str().ok_or("缺少本次接管预览")?;
    let saved = m.previews.remove(id).ok_or("接管预览已失效，请重新读取")?;
    if saved["kind"] != "resourceAdapter"
        || saved["createdAt"].as_i64().is_none_or(|at| {
            let age = chrono::Utc::now().timestamp_millis() - at;
            !(0..600_000).contains(&age)
        })
    {
        return Err("本次接管确认已失效".into());
    }
    let inspection: Inspection =
        serde_json::from_value(saved["inspection"].clone()).map_err(|e| e.to_string())?;
    let current = inspect_binding(&inspection.binding)?;
    if json!(current) != json!(inspection) {
        return Err("预览后的本地布局或版本已变化，请重新核对".into());
    }
    let prior = existing(m, &inspection.root_path)?;
    if json!(prior) != saved["prior"] {
        return Err("预览后目录登记、策略或备注已变化，旧确认失效".into());
    }
    let timestamp = now();
    if saved["operation"] == "refreshNode" {
        let mut record = prior.ok_or("原资源已不存在，请重新读取")?;
        let (actions, _) = refreshed_node_actions(&record, &inspection)?;
        let expected_revision = record.revision;
        record.actions = actions;
        record.revision = expected_revision
            .checked_add(1)
            .ok_or("资源修订号超出范围")?;
        record.updated_at = timestamp;
        let result = m.resource_store(StoreRequest::Replace {
            record: Box::new(record),
            expected_revision,
        })?;
        return Ok(Some(
            json!({"resource":result["resource"],"complete":true,"adopted":true,"operation":"refreshNode","filesChanged":false,"executed":false,"ownership":result["resource"]["ownership"],"sourceVerified":false}),
        ));
    }
    let expected = prior.as_ref().map(|r| r.revision);
    let mut record = prior.unwrap_or_else(|| ResourceRecord {
        id: uuid::Uuid::new_v4().to_string(), name: inspection.name.clone(), kind: inspection.kind.clone(), root_path: inspection.root_path.clone(), repository: inspection.repository.clone(), version: Some(inspection.version.clone()), source_binding: None, source_history: vec![], alias: String::new(), notes: String::new(), enabled: true, ownership: "external".into(), management_scope: "register".into(), actions: vec![], capabilities: vec![], update_policy: json!({"mode":"manual","intervalHours":24,"pinnedVersion":null,"skippedVersions":[]}), installation: None, revision: 1, created_at: timestamp.clone(), updated_at: timestamp.clone(),
    });
    if record.version.is_none() {
        record.version = Some(inspection.version.clone());
    }
    if record.repository.is_none() {
        record.repository = inspection.repository;
    }
    record.actions = inspection.actions;
    record.management_scope = if record.actions.is_empty() {
        "register"
    } else {
        "invoke"
    }
    .into();
    record.capabilities.retain(|value| {
        !matches!(
            value["id"].as_str(),
            Some("registration" | "execution" | "versionMetadata")
        )
    });
    record.capabilities.extend([
        json!({"id":"registration","label":"目录登记","status":"available","verifiedAt":timestamp}),
        json!({"id":"versionMetadata","label":"版本元数据","status":"available","verifiedAt":timestamp,"version":inspection.version,"entry":inspection.root_path,"method":"staticMetadata","reason":"只读取本地元数据，不代表调用成功"}),
        json!({"id":"execution","label":"统一调用","status":if record.actions.is_empty(){"unverified"}else{"configured"},"verifiedAt":null,"reason":if record.actions.is_empty(){"未登记启动动作；原生入口保留"}else{"固定检查动作已登记，尚未实际调用；平台与登录能力分别核验"}}),
    ]);
    record.updated_at = timestamp;
    let result = match expected {
        Some(expected_revision) => {
            record.revision = expected_revision
                .checked_add(1)
                .ok_or("资源修订号超出范围")?;
            m.resource_store(StoreRequest::Replace {
                record: Box::new(record),
                expected_revision,
            })?
        }
        None => m.resource_store(StoreRequest::Insert(Box::new(record)))?,
    };
    Ok(Some(
        json!({"resource":result["resource"],"complete":true,"adopted":true,"filesChanged":false,"executed":false,"ownership":"external","sourceVerified":false}),
    ))
}

#[cfg(test)]
mod tests;
