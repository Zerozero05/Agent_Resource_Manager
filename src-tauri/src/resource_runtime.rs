//! Explicit local action definitions; only process handles created here are stopped.
#[path = "resource_idle.rs"]
mod idle;
#[path = "resource_mcp.rs"]
mod mcp;
use crate::{
    model::{now, Manager},
    resources::{ResourceRecord, StoreRequest},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    path::Path,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActionDefinition {
    pub id: String,
    pub label: String,
    pub mode: String,
    #[serde(default)]
    pub cancellable: bool,
    pub executable: String,
    pub working_directory: String,
    #[serde(default)]
    pub args: Vec<Argument>,
    #[serde(default)]
    pub parameters: Vec<Parameter>,
    #[serde(default)]
    pub timeout_seconds: Option<u64>,
    #[serde(default)]
    pub executable_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub idle_release_safe: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub idle_usage_tracked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_timeout_seconds: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter_binding: Option<crate::resource_adapters::ActionBinding>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Argument {
    Literal { value: String },
    Parameter { name: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Parameter {
    pub(crate) name: String,
    label: String,
    kind: String,
    #[serde(default)]
    required: bool,
    #[serde(default)]
    max_length: Option<usize>,
    #[serde(default)]
    choices: Vec<String>,
    #[serde(default)]
    min: Option<i64>,
    #[serde(default)]
    max: Option<i64>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub(crate) template_allowed: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub(crate) sensitive: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

pub(crate) fn sensitive_parameter_name(name: &str) -> bool {
    let name: String = name
        .to_ascii_lowercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect();
    name == "pwd"
        || [
            "password",
            "passwd",
            "passphrase",
            "token",
            "cookie",
            "secret",
            "auth",
            "credential",
            "apikey",
            "privatekey",
            "accesskey",
            "sessionkey",
        ]
        .iter()
        .any(|word| name.contains(word))
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
}
fn safe_text(value: &str, limit: usize) -> bool {
    value.len() <= limit && !value.contains('\0')
}
fn allowed_fields(request: &Value, fields: &[&str]) -> Result<(), String> {
    if request
        .as_object()
        .is_none_or(|object| object.keys().any(|k| !fields.contains(&k.as_str())))
    {
        return Err("请求包含不支持的参数".into());
    }
    Ok(())
}
fn protected_client(definition: &ActionDefinition) -> bool {
    let name = Path::new(&definition.executable)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        name.as_str(),
        "msedge" | "microsoftedge" | "edge" | "codex" | "chatgpt"
    ) || name.starts_with("codex-")
}
fn validate_idle_policy(definition: &ActionDefinition) -> Result<(), String> {
    if definition.idle_timeout_seconds.is_some_and(|n| n > 86400) {
        return Err("闲置时间须为0–86400秒；0表示关闭".into());
    }
    if (definition.idle_release_safe
        || definition.idle_usage_tracked
        || definition.idle_timeout_seconds.is_some())
        && definition.mode != "service"
        && mcp::tool(definition).is_none()
    {
        return Err("闲置释放仅适用于已登记服务，不能用于正在执行的任务".into());
    }
    if mcp::tool(definition).is_some() {
        crate::resource_adapters::validate_bound_action(definition)?;
    }
    if definition.idle_release_safe && protected_client(definition) {
        return Err("用户浏览器和Codex客户端不允许自动闲置结束".into());
    }
    Ok(())
}
fn idle_safe(definition: &ActionDefinition) -> bool {
    (definition.mode == "service" || mcp::tool(definition).is_some())
        && definition.idle_release_safe
        && definition.idle_usage_tracked
        && !protected_client(definition)
}
fn same_execution(left: &ActionDefinition, right: &ActionDefinition) -> bool {
    crate::resource_adapters::same_fixed_execution(left, right).unwrap_or(false)
}
fn idle_snapshot(m: &Manager, id: &str) -> Result<Value, String> {
    let record: ResourceRecord =
        serde_json::from_value(m.resource_store(StoreRequest::Get(id.into()))?)
            .map_err(|e| e.to_string())?;
    let mut session = None;
    let mut actions:Vec<Value>=record.actions.iter().filter(|value| {
        let definition=serde_json::from_value::<ActionDefinition>((*value).clone()).ok();
        if let Some(definition)=definition.filter(|definition|mcp::tool(definition).is_some()) {
            if session.is_none() { session=Some(definition); }
            false
        } else { true }
    }).map(|value| json!({"actionId":value["id"],"label":value["label"],"mode":value["mode"],
        "idleReleaseSafe":value["idleReleaseSafe"].as_bool().unwrap_or(false),"idleUsageTracked":value["idleUsageTracked"].as_bool().unwrap_or(false),
        "idleTimeoutSeconds":value["idleTimeoutSeconds"].as_u64().unwrap_or(600)})).collect();
    if let Some(session) = session {
        actions.push(json!({"actionId":"edge-session","label":"Edge 浏览器连接","mode":"service","idleReleaseSafe":session.idle_release_safe,"idleUsageTracked":session.idle_usage_tracked,"idleTimeoutSeconds":session.idle_timeout_seconds.unwrap_or(600)}));
    }
    let mut runs = m.resource_runtime.snapshot(Some(id))?["runs"].clone();
    if let Some(runs) = runs.as_array_mut() {
        for run in runs.iter_mut().filter(|run| run["protocolSession"] == true) {
            run["actionId"] = json!("edge-session");
        }
    }
    Ok(json!({"id":id,"resourceRevision":record.revision,"actions":actions,"runs":runs}))
}
fn fingerprint(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("无法读取执行入口：{e}"))?;
    let mut hash = Sha256::new();
    let mut bytes = [0; 65536];
    loop {
        let count = file.read(&mut bytes).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&bytes[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn canonical_path(value: &str, directory: bool) -> Result<String, String> {
    if !Path::new(value).is_absolute() {
        return Err("执行入口和工作目录必须使用绝对路径".into());
    }
    let path = crate::local::canonical(Path::new(value))?;
    if if directory {
        !path.is_dir()
    } else {
        !path.is_file()
    } {
        return Err("执行入口或工作目录不存在".into());
    }
    Ok(path.to_string_lossy().into_owned())
}
fn validate_definition(
    record: &ResourceRecord,
    definition: &mut ActionDefinition,
) -> Result<(), String> {
    if !identifier(&definition.id)
        || definition.label.trim().is_empty()
        || !safe_text(&definition.label, 160)
        || !matches!(definition.mode.as_str(), "task" | "service")
    {
        return Err("动作标识、名称或运行方式无效".into());
    }
    definition.executable = canonical_path(&definition.executable, false)?;
    validate_idle_policy(definition)?;
    definition.working_directory = canonical_path(&definition.working_directory, true)?;
    let root = crate::local::canonical(Path::new(&record.root_path))?;
    if !Path::new(&definition.working_directory).starts_with(&root) {
        return Err("工作目录必须位于资源实际目录内".into());
    }
    let executable = Path::new(&definition.executable);
    let stem = executable
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if [
        "cmd",
        "powershell",
        "pwsh",
        "bash",
        "sh",
        "zsh",
        "wscript",
        "cscript",
        "mshta",
        "rundll32",
        "regsvr32",
    ]
    .contains(&stem.as_str())
    {
        return Err("请登记具体工具可执行文件，不支持通用Shell或系统脚本宿主".into());
    }
    #[cfg(windows)]
    if !executable
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("exe"))
    {
        return Err("Windows动作入口必须是.exe；脚本应通过固定的专用运行时和参数登记".into());
    }
    if definition
        .timeout_seconds
        .is_some_and(|n| n > 86400 || (n == 0 && definition.mode == "task"))
    {
        return Err("任务超时须为1–86400秒，服务可为0表示不限时".into());
    }
    if definition.args.len() > 128 || definition.parameters.len() > 32 {
        return Err("动作参数过多".into());
    }
    let mut names = BTreeSet::new();
    for p in &definition.parameters {
        if !identifier(&p.name)
            || !names.insert(p.name.clone())
            || !safe_text(&p.label, 160)
            || !matches!(p.kind.as_str(), "text" | "choice" | "integer")
        {
            return Err("命名参数定义无效或重复".into());
        }
        if p.max_length.is_some_and(|n| n == 0 || n > 4096)
            || p.min.zip(p.max).is_some_and(|(min, max)| min > max)
            || p.choices.len() > 100
            || p.choices
                .iter()
                .any(|s| s.is_empty() || !safe_text(s, 4096) || s.starts_with('-'))
            || (p.kind == "choice" && p.choices.is_empty())
        {
            return Err("参数长度、范围或候选值无效".into());
        }
    }
    for arg in &definition.args {
        match arg {
            Argument::Literal { value } if !safe_text(value, 8192) => {
                return Err("固定参数过长或包含无效字符".into())
            }
            Argument::Parameter { name } if !names.contains(name) => {
                return Err("动作引用了未定义的参数".into())
            }
            _ => {}
        }
    }
    if definition.parameters.iter().any(|p| {
        !definition
            .args
            .iter()
            .any(|a| matches!(a,Argument::Parameter{name} if name==&p.name))
    }) {
        return Err("参数定义必须在固定参数顺序中使用".into());
    }
    definition.executable_sha256 = Some(fingerprint(executable)?);
    Ok(())
}

fn validate_parameters(
    definition: &ActionDefinition,
    input: &Value,
    partial: bool,
) -> Result<BTreeMap<String, String>, String> {
    let empty = serde_json::Map::new();
    let values = if input.is_null() {
        &empty
    } else {
        input.as_object().ok_or("parameters必须是命名参数对象")?
    };
    if values
        .keys()
        .any(|key| !definition.parameters.iter().any(|p| &p.name == key))
    {
        return Err("包含未登记的参数".into());
    }
    let mut validated = BTreeMap::new();
    for p in &definition.parameters {
        let Some(value) = values.get(&p.name) else {
            if p.required && !partial {
                return Err(format!("缺少参数：{}", p.label));
            }
            continue;
        };
        let text = if p.kind == "integer" {
            let n = value.as_i64().ok_or("数值参数必须是整数")?;
            if p.min.is_some_and(|min| n < min) || p.max.is_some_and(|max| n > max) {
                return Err(format!("参数{}超出范围", p.label));
            }
            n.to_string()
        } else {
            let s = value.as_str().ok_or("文字参数必须是字符串")?;
            if !safe_text(s, p.max_length.unwrap_or(1024))
                || s.starts_with('-')
                || (p.required && s.trim().is_empty())
                || (p.kind == "choice" && !p.choices.iter().any(|c| c == s))
            {
                return Err(format!("参数{}不符合已登记约束", p.label));
            }
            s.to_owned()
        };
        validated.insert(p.name.clone(), text);
    }
    Ok(validated)
}

pub(crate) fn validate_template_parameters(
    definition: &ActionDefinition,
    input: &Value,
) -> Result<(), String> {
    let values = input
        .as_object()
        .ok_or("模板 parameters 必须是命名参数对象")?;
    for name in values.keys() {
        let parameter = definition
            .parameters
            .iter()
            .find(|p| &p.name == name)
            .ok_or("包含未登记的参数")?;
        if !parameter.template_allowed || parameter.sensitive || sensitive_parameter_name(name) {
            return Err(format!(
                "参数 {name} 不允许保存到模板；凭据和敏感参数须在本次调用时填写"
            ));
        }
    }
    validate_parameters(definition, input, true)?;
    Ok(())
}

pub(crate) fn registered_definition(
    record: &ResourceRecord,
    action_id: &str,
) -> Result<ActionDefinition, String> {
    serde_json::from_value(
        record
            .actions
            .iter()
            .find(|a| a["id"] == action_id)
            .ok_or("未登记该动作")?
            .clone(),
    )
    .map_err(|e| e.to_string())
}

pub(crate) fn verified_definition(
    record: &ResourceRecord,
    action_id: &str,
) -> Result<ActionDefinition, String> {
    let mut definition = registered_definition(record, action_id)?;
    let expected = definition.executable_sha256.clone();
    validate_definition(record, &mut definition)?;
    if expected != definition.executable_sha256 {
        return Err("执行入口内容已变化（摘要不一致），请在本地界面重新核对并登记动作".into());
    }
    crate::resource_adapters::validate_action(record, &definition)?;
    Ok(definition)
}

fn arguments(definition: &ActionDefinition, input: &Value) -> Result<Vec<String>, String> {
    let validated = validate_parameters(definition, input, false)?;
    if definition.id == "reach-read"
        && definition
            .adapter_binding
            .as_ref()
            .is_some_and(|binding| binding.adapter == "agentReach")
    {
        crate::resource_adapters::validate_public_url(
            validated.get("url").ok_or("缺少公开网页 URL")?,
        )?;
    }
    Ok(definition
        .args
        .iter()
        .filter_map(|a| match a {
            Argument::Literal { value } => Some(value.clone()),
            Argument::Parameter { name } => validated.get(name).cloned(),
        })
        .collect())
}
pub(crate) fn supports_mcp_protocol(version: &str) -> bool {
    mcp::supports_protocol(version)
}
pub(crate) fn mcp_tool_for_action(definition: &ActionDefinition) -> Option<&'static str> {
    mcp::tool(definition)
}
#[cfg(all(test, windows))]
pub(crate) fn mcp_fixture(
    mode: &str,
) -> (tempfile::TempDir, Arc<crate::tasks::TaskSystem>, String) {
    mcp::tests::fixture(mode)
}

/// Invoked only by dispatch_local, never by the shared Agent/MCP dispatcher.
pub(crate) fn configure(m: &Manager, request: &Value) -> Result<Option<Value>, String> {
    if !matches!(
        request["action"].as_str(),
        Some("resource_action_set" | "resource_action_remove" | "resource_idle_set")
    ) {
        return Ok(None);
    }
    let id = request["id"].as_str().ok_or("缺少资源标识")?;
    let mut record: ResourceRecord =
        serde_json::from_value(m.resource_store(StoreRequest::Get(id.into()))?)
            .map_err(|e| e.to_string())?;
    let expected = request["expectedRevision"]
        .as_u64()
        .filter(|r| *r == record.revision)
        .ok_or("资源已变化，请重新读取后登记动作")?;
    if request["action"] == "resource_idle_set" {
        allowed_fields(
            request,
            &[
                "action",
                "id",
                "actionId",
                "expectedRevision",
                "idleReleaseSafe",
                "idleUsageTracked",
                "idleTimeoutSeconds",
            ],
        )?;
        let action_id = request["actionId"].as_str().ok_or("缺少动作标识")?;
        let mut definition = if action_id == "edge-session" {
            record
                .actions
                .iter()
                .filter_map(|value| serde_json::from_value::<ActionDefinition>(value.clone()).ok())
                .find(|definition| mcp::tool(definition).is_some())
                .ok_or("未登记管理器自有 Edge 连接")?
        } else {
            registered_definition(&record, action_id)?
        };
        definition.idle_release_safe = request["idleReleaseSafe"]
            .as_bool()
            .ok_or("缺少安全停止选择")?;
        definition.idle_usage_tracked = request["idleUsageTracked"]
            .as_bool()
            .ok_or("缺少活动可观测性选择")?;
        definition.idle_timeout_seconds = Some(
            request["idleTimeoutSeconds"]
                .as_u64()
                .ok_or("闲置时间必须是非负秒数")?,
        );
        validate_idle_policy(&definition)?;
        if mcp::tool(&definition).is_some() {
            let key = mcp::connection_key(&definition);
            for value in &mut record.actions {
                let mut sibling: ActionDefinition =
                    serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
                if mcp::tool(&sibling).is_some() && mcp::connection_key(&sibling) == key {
                    sibling.idle_release_safe = definition.idle_release_safe;
                    sibling.idle_usage_tracked = definition.idle_usage_tracked;
                    sibling.idle_timeout_seconds = definition.idle_timeout_seconds;
                    validate_idle_policy(&sibling)?;
                    *value = serde_json::to_value(sibling).map_err(|e| e.to_string())?;
                }
            }
        } else {
            *record
                .actions
                .iter_mut()
                .find(|a| a["id"] == action_id)
                .ok_or("动作不存在")? =
                serde_json::to_value(definition).map_err(|e| e.to_string())?;
        }
    } else if request["action"] == "resource_action_set" {
        if request["definition"].get("adapterBinding").is_some() {
            return Err("专用适配器绑定须通过本地接管预览生成".into());
        }
        let mut definition: ActionDefinition =
            serde_json::from_value(request["definition"].clone())
                .map_err(|e| format!("动作定义无效：{e}"))?;
        validate_definition(&record, &mut definition)?;
        let value = serde_json::to_value(&definition).map_err(|e| e.to_string())?;
        if let Some(existing) = record.actions.iter_mut().find(|a| a["id"] == definition.id) {
            *existing = value;
        } else {
            record.actions.push(value);
        }
    } else {
        let action_id = request["actionId"].as_str().ok_or("缺少动作标识")?;
        if !record.actions.iter().any(|a| a["id"] == action_id) {
            return Err("动作不存在".into());
        }
        record.actions.retain(|a| a["id"] != action_id);
    }
    record.management_scope = if record.actions.is_empty() {
        "register"
    } else {
        "invoke"
    }
    .into();
    for capability in &mut record.capabilities {
        if request["action"] != "resource_idle_set" && capability["id"] == "execution" {
            *capability = json!({"id":"execution","label":"统一调用","status":if record.actions.is_empty(){"unverified"}else{"configured"},"verifiedAt":null,"reason":"动作配置状态不等于实际调用验证"});
        }
    }
    record.revision = expected.checked_add(1).ok_or("修订号超出范围")?;
    record.updated_at = now();
    let result = m.resource_store(StoreRequest::Replace {
        record: Box::new(record),
        expected_revision: expected,
    })?;
    Ok(Some(if request["action"] == "resource_idle_set" {
        idle_snapshot(m, id)?
    } else {
        result
    }))
}

pub(crate) struct PreparedInvocation {
    pub resource_id: String,
    pub revision: u64,
    pub definition: ActionDefinition,
    pub args: Vec<String>,
}

struct Run {
    child: Option<Child>,
    mcp_session: Option<Arc<mcp::Control>>,
    mcp_call: Option<Arc<mcp::Control>>,
    mcp_pending: bool,
    metadata: Value,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    truncated: bool,
    deadline: Option<Instant>,
    definition: ActionDefinition,
    activity: idle::Activity,
    dependency_uses: Vec<(String, String)>,
}
#[derive(Default)]
struct RegistryState {
    runs: BTreeMap<String, Run>,
    monitoring: bool,
}
type RuntimeEvents = Arc<dyn Fn(Value) + Send + Sync>;

#[derive(Default)]
pub(crate) struct RuntimeRegistry {
    state: Mutex<RegistryState>,
    events: Mutex<Option<RuntimeEvents>>,
}

fn release_dependency_uses(state: &mut RegistryState, at: Instant) -> Vec<Value> {
    let released: Vec<_> = state
        .runs
        .values_mut()
        .filter(|r| !r.active())
        .flat_map(|run| std::mem::take(&mut run.dependency_uses))
        .collect();
    let mut changed = Vec::new();
    for (id, lease) in released {
        if let Some(run) = state.runs.get_mut(&id) {
            if run.activity.end(&lease, at) {
                run.touch(at);
                changed.push(run.metadata.clone());
            }
        }
    }
    changed
}

impl RuntimeRegistry {
    fn activity_request(&self, request: &Value) -> Result<Value, String> {
        let action = request["action"].as_str().unwrap_or_default();
        allowed_fields(
            request,
            match action {
                "resource_keep_alive" => &["action", "runId", "enabled"],
                "resource_usage_begin" => &["action", "runId", "kind"],
                "resource_usage_end" => &["action", "runId", "leaseId"],
                _ => return Err("未知活动操作".into()),
            },
        )?;
        let id = request["runId"].as_str().ok_or("缺少运行标识")?;
        let mut state = self.state.lock().map_err(|_| "运行状态锁不可用")?;
        let run = state
            .runs
            .get_mut(id)
            .ok_or("本会话不持有该进程，不能声明其活动")?;
        if !run.active() {
            return Err("该运行已结束".into());
        }
        let mut lease_id = None;
        match action {
            "resource_keep_alive" => {
                run.activity.keep_alive = request["enabled"].as_bool().ok_or("缺少保活选择")?
            }
            "resource_usage_begin" => {
                let kind = request["kind"]
                    .as_str()
                    .filter(|kind| matches!(*kind, "call" | "login"))
                    .ok_or("使用类型须为call或login")?;
                let lease = uuid::Uuid::new_v4().to_string();
                run.activity.uses.insert(lease.clone(), kind.into());
                lease_id = Some(lease);
            }
            "resource_usage_end" => {
                if !run.activity.end(
                    request["leaseId"].as_str().ok_or("缺少使用标识")?,
                    Instant::now(),
                ) {
                    return Err("使用记录不存在或已结束".into());
                }
            }
            _ => unreachable!(),
        }
        run.touch(Instant::now());
        let metadata = run.metadata.clone();
        drop(state);
        self.emit(metadata.clone());
        let mut result = json!({"run":metadata});
        if let Some(id) = lease_id {
            result["leaseId"] = json!(id);
        }
        Ok(result)
    }
}

/// Called by the existing scheduler while holding the live Manager writer lock.
pub(crate) fn release_idle(m: &Manager) -> Result<Value, String> {
    release_idle_at(m, Instant::now())
}
fn release_idle_at(m: &Manager, at: Instant) -> Result<Value, String> {
    if m.basic_mode || crate::maintenance::ensure_automatic_allowed(&m.state.settings).is_err() {
        return Ok(json!({"released":[],"paused":true}));
    }
    let runtime = &m.resource_runtime;
    let mut state = runtime.state.lock().map_err(|_| "运行状态锁不可用")?;
    if !state
        .runs
        .values()
        .any(|r| r.active() && r.idle_allowed() && r.metadata["idleError"].is_null())
    {
        return Ok(json!({"released":[],"paused":false}));
    }
    let records = m.resource_store(StoreRequest::List).and_then(|value| {
        serde_json::from_value::<Vec<ResourceRecord>>(value["resources"].clone())
            .map_err(|e| e.to_string())
    });
    let records = match records {
        Ok(records) => records,
        Err(error) => {
            let mut affected = Vec::new();
            for run in state
                .runs
                .values_mut()
                .filter(|r| r.active() && r.idle_allowed() && r.metadata["idleError"].is_null())
            {
                run.idle_failed(format!("无法核对当前闲置策略：{error}"));
                affected.push(run.metadata.clone());
            }
            drop(state);
            for run in &affected {
                runtime.emit(run.clone());
            }
            return Ok(json!({"released":[],"paused":false,"errors":affected}));
        }
    };
    let mut released = Vec::new();
    let mut errors = Vec::new();
    for run in state.runs.values_mut() {
        if !run.active() || !run.idle_allowed() || !run.metadata["idleError"].is_null() {
            continue;
        }
        let current = records
            .iter()
            .find(|r| run.metadata["resourceId"] == r.id)
            .and_then(|record| {
                registered_definition(
                    record,
                    run.metadata["actionId"].as_str().unwrap_or_default(),
                )
                .ok()
            });
        let Some(current) = current else {
            run.metadata["idleEligible"] = json!(false);
            continue;
        };
        let seconds = current.idle_timeout_seconds.unwrap_or(600);
        let eligible = idle_safe(&current)
            && same_execution(&run.definition, &current)
            && seconds > 0
            && run.metadata["outputError"].is_null();
        run.metadata["idleEligible"] = json!(eligible);
        run.metadata["idleTimeoutSeconds"] = json!(seconds);
        if eligible && run.activity.idle(at, seconds) {
            // poll() may observe real output since the last monitor pass.
            let attempt = run.poll().and_then(|observed| {
                if !observed
                    && run.active()
                    && run.activity.idle(at, seconds)
                    && run.metadata["outputError"].is_null()
                {
                    run.stop("idle_released")?;
                    released.push(run.metadata.clone());
                }
                Ok(())
            });
            if let Err(error) = attempt {
                run.idle_failed(error);
                errors.push(run.metadata.clone());
            }
        }
    }
    let ended = release_dependency_uses(&mut state, at);
    drop(state);
    for run in released.iter().chain(&ended).chain(&errors) {
        runtime.emit(run.clone());
    }
    Ok(json!({"released":released,"paused":false,"errors":errors}))
}

#[cfg(windows)]
fn available(pipe: &impl std::os::windows::io::AsRawHandle) -> std::io::Result<usize> {
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
    let mut bytes = 0;
    let ok = unsafe {
        PeekNamedPipe(
            pipe.as_raw_handle(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            &mut bytes,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(109) {
            return Ok(0);
        }
        return Err(error);
    }
    Ok(bytes as usize)
}
#[cfg(windows)]
fn drain(
    pipe: &mut (impl Read + std::os::windows::io::AsRawHandle),
    output: &mut Vec<u8>,
    truncated: &mut bool,
) -> std::io::Result<bool> {
    let mut budget = 32768;
    let mut buffer = [0; 4096];
    while budget > 0 {
        let n = available(pipe)?.min(buffer.len()).min(budget);
        if n == 0 {
            break;
        }
        let n = pipe.read(&mut buffer[..n])?;
        if n == 0 {
            break;
        }
        let keep = n.min(32768usize.saturating_sub(output.len()));
        output.extend_from_slice(&buffer[..keep]);
        *truncated |= keep < n;
        budget -= n;
    }
    if budget == 0 && available(pipe)? > 0 {
        *truncated = true;
    }
    Ok(budget < 32768)
}
#[cfg(not(windows))]
fn drain(
    pipe: &mut (impl Read + std::os::fd::AsRawFd),
    output: &mut Vec<u8>,
    truncated: &mut bool,
) -> std::io::Result<bool> {
    unsafe extern "C" {
        fn fcntl(fd: i32, cmd: i32, ...) -> i32;
    }
    let fd = pipe.as_raw_fd();
    let flags = unsafe { fcntl(fd, 3) };
    if flags < 0 {
        return Err(std::io::Error::last_os_error());
    }
    #[cfg(target_os = "linux")]
    let nonblock = 2048;
    #[cfg(not(target_os = "linux"))]
    let nonblock = 4;
    if unsafe { fcntl(fd, 4, flags | nonblock) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let mut buffer = [0; 4096];
    let mut budget = 32768;
    while budget > 0 {
        match pipe.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                let keep = n.min(32768usize.saturating_sub(output.len()));
                output.extend_from_slice(&buffer[..keep]);
                *truncated |= keep < n;
                budget -= n;
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(e) => return Err(e),
        }
    }
    Ok(budget < 32768)
}
impl Run {
    fn active(&self) -> bool {
        self.child.is_some()
            || self.mcp_pending
            || (self
                .mcp_session
                .as_ref()
                .is_some_and(|session| session.alive())
                && self.metadata["status"] == "running")
    }
    fn idle_allowed(&self) -> bool {
        self.mcp_session.is_some()
            || (self.definition.mode == "service" && !protected_client(&self.definition))
    }
    fn idle_failed(&mut self, error: String) {
        self.metadata["idleEligible"] = json!(false);
        self.metadata["idleError"] = json!(format!(
            "自动释放已停止尝试；保留当前服务，请核查后手动处理或重新启动：{error}"
        ));
    }
    fn publish_activity(&mut self) {
        self.metadata["keepAlive"] = json!(self.activity.keep_alive);
        self.metadata["activeUses"] = json!(self.activity.uses.len());
        self.metadata["loginUses"] = json!(self
            .activity
            .uses
            .values()
            .filter(|kind| kind.as_str() == "login")
            .count());
    }
    fn touch(&mut self, at: Instant) {
        self.activity.touch(at);
        self.metadata["lastActivityAt"] = json!(now());
        self.publish_activity();
    }
    fn poll(&mut self) -> Result<bool, String> {
        if let Some(session) = &self.mcp_session {
            if self.metadata["status"] != "running" {
                return Ok(false);
            }
            if let Some(exit) = session.exit()? {
                self.metadata["status"] = json!(if exit.requested {
                    "stopped"
                } else if exit.code == Some(0) {
                    "succeeded"
                } else {
                    "failed"
                });
                self.metadata["exitCode"] = json!(exit.code);
                if self.metadata["finishedAt"].is_null() {
                    self.metadata["finishedAt"] = json!(now());
                }
            }
            return Ok(false);
        }
        let Some(child) = &mut self.child else {
            return Ok(false);
        };
        let mut activity = false;
        if let Some(pipe) = child.stdout.as_mut() {
            match drain(pipe, &mut self.stdout, &mut self.truncated) {
                Ok(read) => activity |= read,
                Err(error) => {
                    self.truncated = true;
                    self.metadata["outputError"] = json!(format!("标准输出未完整读取：{error}"));
                }
            }
        }
        if let Some(pipe) = child.stderr.as_mut() {
            match drain(pipe, &mut self.stderr, &mut self.truncated) {
                Ok(read) => activity |= read,
                Err(error) => {
                    self.truncated = true;
                    self.metadata["outputError"] = json!(format!("错误输出未完整读取：{error}"));
                }
            }
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            if let Some(pipe) = child.stdout.as_mut() {
                if drain(pipe, &mut self.stdout, &mut self.truncated).is_err() {
                    self.truncated = true;
                }
            }
            if let Some(pipe) = child.stderr.as_mut() {
                if drain(pipe, &mut self.stderr, &mut self.truncated).is_err() {
                    self.truncated = true;
                }
            }
            self.metadata["status"] = json!(if status.success() {
                "succeeded"
            } else {
                "failed"
            });
            self.metadata["exitCode"] = json!(status.code());
            self.metadata["finishedAt"] = json!(now());
            // A descendant may inherit a pipe; never wait for its EOF or terminate it.
            self.child = None;
        } else if self
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            self.stop("timed_out")?;
        }
        if activity {
            self.touch(Instant::now());
        }
        Ok(activity)
    }
    fn stop(&mut self, status: &str) -> Result<(), String> {
        if let Some(control) = self.mcp_call.as_ref() {
            if self.active() {
                // The invocation thread owns the actual tools/call outcome. Keep
                // it pending until that thread publishes its protocol evidence;
                // stopping the transport cannot invent a call result or replace
                // a completion that already won the race.
                control.close()?;
            }
            return Ok(());
        }
        if let Some(control) = self.mcp_session.as_ref() {
            if !self.active() {
                return Ok(());
            }
            let exit = control.close()?;
            self.mcp_pending = false;
            self.metadata["status"] = json!(status);
            // A call completion is not a process exit; the session run owns that evidence.
            self.metadata["exitCode"] = json!(exit.code);
            self.metadata["finishedAt"] = json!(now());
            return Ok(());
        }
        let Some(child) = &mut self.child else {
            return Ok(());
        };
        if let Some(exit) = child.try_wait().map_err(|e| e.to_string())? {
            self.metadata["status"] = json!(if exit.success() {
                "succeeded"
            } else {
                "failed"
            });
            self.metadata["exitCode"] = json!(exit.code());
        } else {
            child.kill().map_err(|e| format!("停止受管进程失败：{e}"))?;
            let exit = child.wait().map_err(|e| e.to_string())?;
            self.metadata["status"] = json!(status);
            self.metadata["exitCode"] = json!(exit.code());
        }
        self.metadata["finishedAt"] = json!(now());
        if let Some(pipe) = child.stdout.as_mut() {
            if drain(pipe, &mut self.stdout, &mut self.truncated).is_err() {
                self.truncated = true;
            }
        }
        if let Some(pipe) = child.stderr.as_mut() {
            if drain(pipe, &mut self.stderr, &mut self.truncated).is_err() {
                self.truncated = true;
            }
        }
        self.child = None;
        Ok(())
    }
    fn result(&self) -> Value {
        json!({"run":self.metadata,"stdout":String::from_utf8_lossy(&self.stdout),"stderr":String::from_utf8_lossy(&self.stderr),"outputTruncated":self.truncated})
    }
}
impl RuntimeRegistry {
    fn spawn_mcp(
        self: &Arc<Self>,
        prepared: PreparedInvocation,
        dependency_ids: Vec<String>,
    ) -> Result<Value, String> {
        let tool = mcp::tool(&prepared.definition).ok_or("未登记固定 MCP 动作")?;
        let mut state = self.state.lock().map_err(|_| "运行状态锁不可用")?;
        for run in state.runs.values_mut().filter(|run| {
            run.mcp_session.is_some() && run.metadata["resourceId"] == prepared.resource_id
        }) {
            run.poll()?;
        }
        if state.runs.values().any(|run| {
            run.active()
                && run.mcp_session.is_none()
                && run.metadata["resourceId"] == prepared.resource_id
        }) {
            return Err("该资源已有调用正在执行，请等待完成或取消本次调用".into());
        }
        let existing = state
            .runs
            .values()
            .find(|run| {
                run.active()
                    && run.mcp_session.is_some()
                    && run.metadata["resourceId"] == prepared.resource_id
            })
            .and_then(|run| run.mcp_session.clone());
        let control = if let Some(control) = existing {
            if control.key != mcp::connection_key(&prepared.definition) {
                return Err("固定入口绑定已变化；请先关闭管理器自有 MCP 连接，再重新调用".into());
            }
            control
        } else {
            let control = Arc::new(mcp::Control::spawn(&prepared)?);
            let metadata = json!({"runId":control.id,"sessionId":control.id,"resourceId":prepared.resource_id,"actionId":prepared.definition.id,"pid":control.pid,"mode":"service","cancellable":true,"status":"running","startedAt":now(),"finishedAt":null,"exitCode":null,"protocolSession":true,"keepAlive":false,"activeUses":0,"loginUses":0,"idleEligible":idle_safe(&prepared.definition)&&prepared.definition.idle_timeout_seconds!=Some(0),"lastActivityAt":now(),"idleTimeoutSeconds":prepared.definition.idle_timeout_seconds.unwrap_or(600)});
            state.runs.insert(
                control.id.clone(),
                Run {
                    child: None,
                    mcp_session: Some(control.clone()),
                    mcp_call: None,
                    mcp_pending: false,
                    metadata: metadata.clone(),
                    stdout: vec![],
                    stderr: vec![],
                    truncated: false,
                    deadline: None,
                    definition: prepared.definition.clone(),
                    activity: idle::Activity::new(Instant::now()),
                    dependency_uses: vec![],
                },
            );
            control
        };
        let run_id = uuid::Uuid::new_v4().to_string();
        let metadata = json!({"runId":run_id,"resourceId":prepared.resource_id,"actionId":prepared.definition.id,"pid":control.pid,"mode":"task","cancellable":true,"status":"running","startedAt":now(),"finishedAt":null,"exitCode":null,"sessionId":control.id,"keepAlive":false,"activeUses":0,"loginUses":0,"idleEligible":false,"lastActivityAt":now(),"protocolEvidence":{"method":"tools/call","toolName":tool,"protocolVersion":null,"rpcResultReceived":false,"isError":null,"jsonRpcError":false,"sessionId":control.id}});
        let mut dependency_uses = vec![];
        let mut events = vec![];
        for (id, run) in state.runs.iter_mut() {
            if run.active()
                && run.metadata["mode"] == "service"
                && (id == &control.id
                    || dependency_ids
                        .iter()
                        .any(|resource| run.metadata["resourceId"] == *resource))
            {
                let lease = uuid::Uuid::new_v4().to_string();
                run.activity.uses.insert(lease.clone(), "call".into());
                run.touch(Instant::now());
                dependency_uses.push((id.clone(), lease));
                events.push(run.metadata.clone());
            }
        }
        let timeout = Duration::from_secs(
            prepared
                .definition
                .timeout_seconds
                .unwrap_or(40)
                .clamp(1, 40),
        );
        state.runs.insert(
            run_id.clone(),
            Run {
                child: None,
                mcp_session: None,
                mcp_call: Some(control.clone()),
                mcp_pending: true,
                metadata: metadata.clone(),
                stdout: vec![],
                stderr: vec![],
                truncated: false,
                deadline: None,
                definition: prepared.definition,
                activity: idle::Activity::new(Instant::now()),
                dependency_uses,
            },
        );
        let start_monitor = !state.monitoring;
        state.monitoring = true;
        drop(state);
        for event in events {
            self.emit(event);
        }
        self.emit(metadata.clone());
        let registry = self.clone();
        std::thread::spawn(move || {
            let outcome = control.call(tool, timeout);
            let Ok(mut state) = registry.state.lock() else {
                let _ = control.close();
                return;
            };
            let mut events = vec![];
            if let Some(run) = state.runs.get_mut(&run_id) {
                if run.mcp_pending {
                    run.mcp_pending = false;
                    run.metadata["status"] = json!(outcome.status);
                    run.metadata["finishedAt"] = json!(now());
                    run.metadata["protocolEvidence"] = outcome.evidence;
                    if let Some(error) = outcome.error {
                        run.metadata["error"] = json!(error);
                    }
                    run.stdout = outcome.stdout.into_bytes();
                    run.touch(Instant::now());
                }
                events.push(run.metadata.clone());
            }
            if let Some(session) = state.runs.get_mut(&control.id) {
                let _ = session.poll();
                events.push(session.metadata.clone());
            }
            events.extend(release_dependency_uses(&mut state, Instant::now()));
            drop(state);
            for event in events {
                registry.emit(event);
            }
        });
        if start_monitor {
            let weak = Arc::downgrade(self);
            std::thread::spawn(move || loop {
                let Some(registry) = weak.upgrade() else {
                    return;
                };
                if !registry.poll_all() {
                    return;
                }
                drop(registry);
                std::thread::sleep(Duration::from_millis(20));
            });
        }
        Ok(metadata)
    }
    pub(crate) fn set_events(&self, events: RuntimeEvents) {
        *self.events.lock().expect("resource events lock") = Some(events);
    }
    fn emit(&self, run: Value) {
        if let Some(events) = self.events.lock().ok().and_then(|e| e.clone()) {
            events(json!({"run":run}));
        }
    }
    pub(crate) fn spawn(
        self: &Arc<Self>,
        prepared: PreparedInvocation,
        dependency_ids: Vec<String>,
    ) -> Result<Value, String> {
        if mcp::validate(&prepared)? {
            return self.spawn_mcp(prepared, dependency_ids);
        }
        let mut command = Command::new(&prepared.definition.executable);
        crate::resource_adapters::apply_environment(&prepared.definition, &mut command)?;
        command
            .args(&prepared.args)
            .current_dir(&prepared.definition.working_directory)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut state = self.state.lock().map_err(|_| "运行状态锁不可用")?;
        if state
            .runs
            .values()
            .any(|run| run.active() && run.metadata["resourceId"] == prepared.resource_id)
        {
            return Err("该资源已有受管进程运行，请先停止或等待结束".into());
        }
        let child = command.spawn().map_err(|e| format!("启动失败：{e}"))?;
        let run_id = uuid::Uuid::new_v4().to_string();
        let metadata = json!({"runId":run_id,"resourceId":prepared.resource_id,"actionId":prepared.definition.id,"pid":child.id(),"mode":prepared.definition.mode,"cancellable":prepared.definition.cancellable,"status":"running","startedAt":now(),"finishedAt":null,"exitCode":null,
            "keepAlive":false,"activeUses":0,"loginUses":0,"idleEligible":idle_safe(&prepared.definition)&&prepared.definition.idle_timeout_seconds!=Some(0),"lastActivityAt":now(),"idleTimeoutSeconds":prepared.definition.idle_timeout_seconds.unwrap_or(600)});
        let seconds = prepared.definition.timeout_seconds.unwrap_or(0);
        let mut dependency_uses = Vec::new();
        let mut dependency_events = Vec::new();
        for (id, run) in state.runs.iter_mut() {
            if run.active()
                && run.metadata["mode"] == "service"
                && dependency_ids
                    .iter()
                    .any(|resource| run.metadata["resourceId"] == *resource)
            {
                let lease = uuid::Uuid::new_v4().to_string();
                run.activity.uses.insert(lease.clone(), "call".into());
                run.touch(Instant::now());
                dependency_uses.push((id.clone(), lease));
                dependency_events.push(run.metadata.clone());
            }
        }
        state.runs.insert(
            run_id,
            Run {
                child: Some(child),
                mcp_session: None,
                mcp_call: None,
                mcp_pending: false,
                metadata: metadata.clone(),
                stdout: vec![],
                stderr: vec![],
                truncated: false,
                deadline: (seconds > 0).then(|| Instant::now() + Duration::from_secs(seconds)),
                definition: prepared.definition,
                activity: idle::Activity::new(Instant::now()),
                dependency_uses,
            },
        );
        let start_monitor = !state.monitoring;
        state.monitoring = true;
        drop(state);
        for run in dependency_events {
            self.emit(run);
        }
        self.emit(metadata.clone());
        if start_monitor {
            let weak = Arc::downgrade(self);
            std::thread::spawn(move || loop {
                let Some(registry) = weak.upgrade() else {
                    return;
                };
                if !registry.poll_all() {
                    return;
                }
                drop(registry);
                std::thread::sleep(Duration::from_millis(20));
            });
        }
        Ok(metadata)
    }
    fn poll_all(&self) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let mut transitions = Vec::new();
        for run in state.runs.values_mut() {
            let before = run.metadata["status"].clone();
            if let Err(error) = run.poll() {
                run.metadata["error"] = json!(error);
            }
            if before != run.metadata["status"] {
                transitions.push(run.metadata.clone());
            }
        }
        transitions.extend(release_dependency_uses(&mut state, Instant::now()));
        let mut completed: Vec<_> = state
            .runs
            .iter()
            .filter(|(_, r)| !r.active())
            .map(|(id, r)| {
                (
                    id.clone(),
                    r.metadata["startedAt"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                )
            })
            .collect();
        completed.sort_by(|a, b| b.1.cmp(&a.1));
        for (id, _) in completed.into_iter().skip(100) {
            state.runs.remove(&id);
        }
        let active = state.runs.values().any(Run::active);
        if !active {
            state.monitoring = false;
        }
        drop(state);
        for run in transitions {
            self.emit(run);
        }
        active
    }
    pub(crate) fn snapshot(&self, id: Option<&str>) -> Result<Value, String> {
        let state = self.state.lock().map_err(|_| "运行状态锁不可用")?;
        Ok(
            json!({"runs":state.runs.values().filter(|r|id.is_none_or(|id|r.metadata["resourceId"]==id)).map(|r|r.metadata.clone()).collect::<Vec<_>>()}),
        )
    }
    pub(crate) fn result(&self, id: &str) -> Result<Value, String> {
        let state = self.state.lock().map_err(|_| "运行状态锁不可用")?;
        Ok(state.runs.get(id).ok_or("本次会话没有该运行记录")?.result())
    }
    pub(crate) fn completed_definition(
        &self,
        id: &str,
    ) -> Result<Option<ActionDefinition>, String> {
        let state = self.state.lock().map_err(|_| "运行状态锁不可用")?;
        let run = state.runs.get(id).ok_or("本次会话没有该运行记录")?;
        if run.active()
            || run.metadata["mode"] != "task"
            || !matches!(
                run.metadata["status"].as_str(),
                Some("succeeded" | "failed" | "timed_out" | "stopped")
            )
        {
            return Ok(None);
        }
        Ok(Some(run.definition.clone()))
    }
    pub(crate) fn stop(&self, id: &str) -> Result<Value, String> {
        let mut state = self.state.lock().map_err(|_| "运行状态锁不可用")?;
        let run = state
            .runs
            .get_mut(id)
            .ok_or("本次会话没有该受管进程，不能按PID或名称终止")?;
        let active = run.active();
        if active && run.metadata["mode"] == "task" && run.metadata["cancellable"] != true {
            return Err("该任务未声明可安全中止，请等待完成；服务停止不能绕过任务取消限制".into());
        }
        run.stop("stopped")?;
        let metadata = run.metadata.clone();
        let released = release_dependency_uses(&mut state, Instant::now());
        drop(state);
        if active {
            self.emit(metadata.clone());
        }
        for run in released {
            self.emit(run);
        }
        Ok(json!({"run":metadata}))
    }

    pub(crate) fn shutdown(&self) -> Result<(), String> {
        let active: Vec<String> = self
            .state
            .lock()
            .map_err(|_| "运行状态锁不可用")?
            .runs
            .iter()
            .filter(|(_, run)| run.active())
            .map(|(id, _)| id.clone())
            .collect();
        for id in active {
            // stop() still enforces the original cancellation policy and only
            // touches the Child handle owned by this registry.
            self.stop(&id)?;
        }
        Ok(())
    }
}
impl Drop for RuntimeRegistry {
    fn drop(&mut self) {
        if let Ok(state) = self.state.get_mut() {
            for run in state.runs.values_mut() {
                if run.metadata["cancellable"] == true {
                    let _ = run.stop("stopped");
                }
            }
        }
    }
}

pub(crate) fn handle(m: &Manager, request: &Value) -> Result<Option<Value>, String> {
    Ok(Some(match request["action"].as_str().unwrap_or_default() {
        "resource_action_set" | "resource_action_remove" | "resource_idle_set" => {
            return Err("动作登记与修改仅允许在本地管理器界面进行".into())
        }
        "resource_idle" => {
            allowed_fields(request, &["action", "id"])?;
            idle_snapshot(m, request["id"].as_str().ok_or("缺少资源标识")?)?
        }
        "resource_keep_alive" | "resource_usage_begin" | "resource_usage_end" => {
            m.resource_runtime.activity_request(request)?
        }
        "resource_runtime" => m.resource_runtime.snapshot(request["id"].as_str())?,
        "resource_result" => m
            .resource_runtime
            .result(request["runId"].as_str().ok_or("缺少运行标识")?)?,
        "resource_stop" => m
            .resource_runtime
            .stop(request["runId"].as_str().ok_or("缺少运行标识")?)?,
        "resource_invoke" => {
            crate::network::check_cancelled()?;
            let id = request["id"].as_str().ok_or("缺少资源标识")?;
            let record: ResourceRecord =
                serde_json::from_value(m.resource_store(StoreRequest::Get(id.into()))?)
                    .map_err(|e| e.to_string())?;
            if !record.enabled {
                return Err("资源已停用，不能开始新调用".into());
            }
            if request.get("expectedRevision").is_some()
                && request["expectedRevision"].as_u64() != Some(record.revision)
            {
                return Err("资源动作已变化，请重新读取并核对本次调用".into());
            }
            let action_id = request["actionId"].as_str().ok_or("缺少动作标识")?;
            let definition = verified_definition(&record, action_id)?;
            let args = arguments(&definition, &request["parameters"])?;
            let evidence_stamp =
                crate::resource_capability_evidence::capture(m, &record, &definition);
            crate::network::check_cancelled()?;
            let mode = definition.mode.clone();
            let run = m.resource_spawn(PreparedInvocation {
                resource_id: id.into(),
                revision: record.revision,
                definition,
                args,
            })?;
            let run_id = run["runId"].as_str().ok_or("缺少运行标识")?;
            if mode == "service" {
                json!({"run":run,"stdout":"","stderr":"","outputTruncated":false})
            } else {
                let mut result = loop {
                    if crate::network::check_cancelled().is_err() {
                        // A cancellation signal is not itself an execution outcome.
                        // Observe the same owned run after stopping (or after it won
                        // the completion race), then journal its actual terminal result.
                        let stopped = m.resource_runtime.stop(run_id);
                        let actual = m.resource_runtime.result(run_id)?;
                        if actual["run"]["status"] != "running" {
                            break actual;
                        }
                        stopped?;
                        std::thread::sleep(Duration::from_millis(20));
                        continue;
                    }
                    let result = m.resource_runtime.result(run_id)?;
                    if result["run"]["status"] != "running" {
                        break result;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                };
                match evidence_stamp {
                    Ok(Some(stamp)) => {
                        match crate::resource_capability_evidence::observe(m, &stamp, run_id) {
                            Ok(evidence) => result["capabilityEvidence"] = evidence,
                            Err(reason) => result["capabilityEvidenceWarning"] = json!(reason),
                        }
                    }
                    Err(reason) => result["capabilityEvidenceWarning"] = json!(reason),
                    Ok(None) => {}
                }
                result
            }
        }
        _ => return Ok(None),
    }))
}

pub(crate) fn invocation_cancellable(m: &Manager, request: &Value) -> Result<bool, String> {
    let id = request["id"].as_str().ok_or("缺少资源标识")?;
    let record: ResourceRecord =
        serde_json::from_value(m.resource_store(StoreRequest::Get(id.into()))?)
            .map_err(|e| e.to_string())?;
    let action_id = request["actionId"].as_str().ok_or("缺少动作标识")?;
    Ok(record
        .actions
        .iter()
        .find(|a| a["id"] == action_id)
        .ok_or("未登记该动作")?["cancellable"]
        == true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn template_policy_is_opt_in_without_changing_legacy_invocation_validation() {
        let original = json!({"id":"query","label":"Query","mode":"task","executable":"unused","workingDirectory":"unused","args":[{"type":"parameter","name":"query"}],"parameters":[{"name":"query","label":"Query","kind":"text","required":true}]});
        let mut definition: ActionDefinition = serde_json::from_value(original).unwrap();
        let serialized = serde_json::to_value(&definition).unwrap();
        assert!(serialized["parameters"][0].get("templateAllowed").is_none());
        assert!(serialized["parameters"][0].get("sensitive").is_none());
        assert_eq!(
            arguments(&definition, &json!({"query":"value"})).unwrap(),
            vec!["value"]
        );
        assert!(arguments(&definition, &json!({})).is_err());
        assert!(validate_template_parameters(&definition, &json!({"query":"value"})).is_err());
        assert!(validate_template_parameters(&definition, &json!({})).is_ok());
        definition.parameters[0].template_allowed = true;
        assert!(validate_template_parameters(&definition, &json!({"query":"value"})).is_ok());
        definition.parameters[0].sensitive = true;
        assert!(validate_template_parameters(&definition, &json!({"query":"value"})).is_err());
        assert_eq!(
            arguments(&definition, &json!({"query":"value"})).unwrap(),
            vec!["value"]
        );
    }
    fn fixture() -> tempfile::TempDir {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("work/resource-runtime-tests");
        std::fs::create_dir_all(&root).unwrap();
        tempfile::tempdir_in(root).unwrap()
    }
    fn setup(
        mode: &str,
        helper: &str,
    ) -> (tempfile::TempDir, Arc<crate::tasks::TaskSystem>, String) {
        let fixture = fixture();
        let root = fixture.path().join("tool");
        std::fs::create_dir(&root).unwrap();
        let service =
            crate::tasks::TaskSystem::new(Manager::new(fixture.path().join("state")).unwrap())
                .unwrap();
        let resource=service.execute(json!({"action":"resource_register","name":"synthetic","kind":"cli","rootPath":root}),crate::dispatch).unwrap()["resource"].clone();
        let id = resource["id"].as_str().unwrap().to_owned();
        service.execute(json!({"action":"resource_action_set","id":id,"expectedRevision":1,"definition":{"id":"test","label":"Synthetic test","mode":mode,"executable":std::env::current_exe().unwrap(),"workingDirectory":root,"args":[{"type":"literal","value":"--exact"},{"type":"literal","value":format!("resource_runtime::tests::{helper}")},{"type":"literal","value":"--ignored"},{"type":"literal","value":"--nocapture"}]}}),crate::dispatch_local).unwrap();
        (fixture, service, id)
    }
    #[test]
    #[ignore = "Safe subprocess fixture, invoked explicitly by runtime tests"]
    fn synthetic_echo() {
        println!("SYNTHETIC_OUTPUT_NOT_FOR_DATABASE");
        eprintln!("synthetic stderr");
    }
    #[test]
    #[ignore = "Safe subprocess fixture, invoked explicitly by runtime tests"]
    fn synthetic_wait() {
        std::thread::sleep(Duration::from_secs(15));
    }
    #[test]
    #[ignore = "Safe short non-cancellable subprocess fixture"]
    fn synthetic_short_wait() {
        std::thread::sleep(Duration::from_secs(2));
    }
    #[test]
    #[ignore = "Safe nonzero subprocess fixture"]
    fn synthetic_failure() {
        std::process::exit(7);
    }
    #[test]
    #[ignore = "Safe bounded output subprocess fixture"]
    fn synthetic_large_output() {
        for _ in 0..100 {
            println!("{}", "x".repeat(1024));
        }
    }

    #[test]
    fn configured_action_returns_bounded_output_and_does_not_persist_it() {
        let (fixture, service, id) = setup("task", "synthetic_echo");
        let started=service.control(&json!({"action":"start_task","request":{"action":"resource_invoke","id":id,"actionId":"test","parameters":{}}}),crate::dispatch).unwrap().unwrap();
        let task_id = started["task"]["id"].as_str().unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        let task = loop {
            let task = service
                .control(
                    &json!({"action":"get_task","taskId":task_id}),
                    crate::dispatch,
                )
                .unwrap()
                .unwrap()["task"]
                .clone();
            if task["status"] != "running" && task["status"] != "queued" {
                break task;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(task["status"], "succeeded");
        assert!(task["result"]["stdout"]
            .as_str()
            .unwrap()
            .contains("SYNTHETIC_OUTPUT_NOT_FOR_DATABASE"));
        let db = rusqlite::Connection::open(fixture.path().join("state/manager.sqlite3")).unwrap();
        let payload: String = db
            .query_row(
                "SELECT payload FROM task_history WHERE id=?1",
                [task_id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!payload.contains("SYNTHETIC_OUTPUT_NOT_FOR_DATABASE"));
        assert!(!payload.contains("stdout"));
    }
    #[test]
    fn shared_dispatch_cannot_register_actions_and_disabled_resource_cannot_start() {
        let (_fixture, service, id) = setup("task", "synthetic_echo");
        assert!(service.execute(json!({"action":"resource_action_remove","id":id,"expectedRevision":2,"actionId":"test","confirmed":true,"source":"local"}),crate::dispatch).is_err());
        service.execute(json!({"action":"resource_set_enabled","id":id,"expectedRevision":2,"enabled":false}),crate::dispatch).unwrap();
        assert!(service
            .execute(
                json!({"action":"resource_invoke","id":id,"actionId":"test"}),
                crate::dispatch
            )
            .is_err());
        assert!(service
            .execute(
                json!({"action":"resource_runtime","id":id}),
                crate::dispatch
            )
            .unwrap()["runs"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn invocation_rejects_stale_displayed_revision_before_starting_the_program() {
        let (_fixture, service, id) = setup("task", "synthetic_echo");
        for expected in [json!(1), Value::Null, json!("2")] {
            let error = service
                .execute(
                    json!({"action":"resource_invoke","id":id,"actionId":"test","expectedRevision":expected,"parameters":{}}),
                    crate::dispatch,
                )
                .unwrap_err();
            assert!(error.contains("资源动作已变化"), "{error}");
            let runtime = service
                .execute(
                    json!({"action":"resource_runtime","id":id}),
                    crate::dispatch,
                )
                .unwrap();
            assert_eq!(runtime["runs"], json!([]));
        }
        let result = service
            .execute(
                json!({"action":"resource_invoke","id":id,"actionId":"test","expectedRevision":2,"parameters":{}}),
                crate::dispatch,
            )
            .unwrap();
        assert_eq!(result["run"]["status"], "succeeded");
        assert!(result["stdout"]
            .as_str()
            .unwrap()
            .contains("SYNTHETIC_OUTPUT_NOT_FOR_DATABASE"));
    }
    #[test]
    fn service_stop_uses_own_handle_and_is_available_after_disable() {
        let (_fixture, service, id) = setup("service", "synthetic_wait");
        let mut unrelated = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "resource_runtime::tests::synthetic_wait",
                "--ignored",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let run = service
            .execute(
                json!({"action":"resource_invoke","id":id,"actionId":"test"}),
                crate::dispatch,
            )
            .unwrap()["run"]
            .clone();
        service.execute(json!({"action":"resource_set_enabled","id":id,"expectedRevision":2,"enabled":false}),crate::dispatch).unwrap();
        let stopped = service
            .execute(
                json!({"action":"resource_stop","runId":run["runId"]}),
                crate::dispatch,
            )
            .unwrap();
        assert_eq!(stopped["run"]["status"], "stopped");
        assert!(unrelated.try_wait().unwrap().is_none());
        unrelated.kill().unwrap();
        unrelated.wait().unwrap();
        assert!(service
            .execute(
                json!({"action":"resource_stop","runId":"not-owned","pid":1}),
                crate::dispatch
            )
            .is_err());
    }
    #[test]
    fn complete_exit_stops_owned_services_and_keeps_unrelated_processes() {
        let (_fixture, service, id) = setup("service", "synthetic_wait");
        let mut unrelated = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "resource_runtime::tests::synthetic_wait",
                "--ignored",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let run = service
            .execute(
                json!({"action":"resource_invoke","id":id,"actionId":"test"}),
                crate::dispatch,
            )
            .unwrap()["run"]
            .clone();
        let result = service
            .execute(json!({"action":"prepare_close"}), crate::dispatch)
            .unwrap();
        assert_eq!(result["ready"], true);
        service
            .execute(json!({"action":"cancel_close"}), crate::dispatch)
            .unwrap();
        let status = service
            .execute(
                json!({"action":"resource_result","runId":run["runId"]}),
                crate::dispatch,
            )
            .unwrap();
        assert_eq!(status["run"]["status"], "stopped");
        assert!(unrelated.try_wait().unwrap().is_none());
        unrelated.kill().unwrap();
        unrelated.wait().unwrap();
    }
    #[test]
    fn stop_bypasses_running_task_lock_and_nonzero_exit_is_failed() {
        let (_fixture, service, id) = setup("task", "synthetic_wait");
        let mut definition = service
            .execute(json!({"action":"resource_list"}), crate::dispatch)
            .unwrap()["resources"][0]["actions"][0]
            .clone();
        definition["cancellable"] = json!(true);
        service.execute(json!({"action":"resource_action_set","id":id,"expectedRevision":2,"definition":definition}), crate::dispatch_local).unwrap();
        let started=service.control(&json!({"action":"start_task","request":{"action":"resource_invoke","id":id,"actionId":"test"}}),crate::dispatch).unwrap().unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        let run = loop {
            let runs = service
                .execute(
                    json!({"action":"resource_runtime","id":id}),
                    crate::dispatch,
                )
                .unwrap();
            if let Some(run) = runs["runs"].as_array().unwrap().first() {
                break run.clone();
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(20));
        };
        let before = Instant::now();
        service
            .execute(
                json!({"action":"resource_stop","runId":run["runId"]}),
                crate::dispatch,
            )
            .unwrap();
        assert!(before.elapsed() < Duration::from_secs(5));
        let task_id = &started["task"]["id"];
        let task = loop {
            let task = service
                .control(
                    &json!({"action":"get_task","taskId":task_id}),
                    crate::dispatch,
                )
                .unwrap()
                .unwrap()["task"]
                .clone();
            if task["status"] != "running" && task["status"] != "queued" {
                break task;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(task["status"], "cancelled");
        let (_fixture, service, id) = setup("task", "synthetic_failure");
        let result = service
            .execute(
                json!({"action":"resource_invoke","id":id,"actionId":"test"}),
                crate::dispatch,
            )
            .unwrap();
        assert_eq!(result["run"]["exitCode"], 7);
        assert_eq!(result["run"]["status"], "failed");
    }
    #[test]
    fn noncancellable_task_keeps_launched_policy_and_close_waits_for_completion() {
        let (_fixture, service, id) = setup("task", "synthetic_short_wait");
        let started = service.control(&json!({"action":"start_task","request":{"action":"resource_invoke","id":id,"actionId":"test"}}), crate::dispatch).unwrap().unwrap();
        let task_id = &started["task"]["id"];
        let deadline = Instant::now() + Duration::from_secs(30);
        let run = loop {
            let runs = service
                .execute(
                    json!({"action":"resource_runtime","id":id}),
                    crate::dispatch,
                )
                .unwrap();
            if let Some(run) = runs["runs"].as_array().unwrap().first() {
                break run.clone();
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(run["cancellable"], false);
        let mut definition = service
            .execute(json!({"action":"resource_list"}), crate::dispatch)
            .unwrap()["resources"][0]["actions"][0]
            .clone();
        definition["cancellable"] = json!(true);
        service.execute(json!({"action":"resource_action_set","id":id,"expectedRevision":2,"definition":definition}), crate::dispatch_local).unwrap();
        assert!(service
            .control(
                &json!({"action":"cancel_task","taskId":task_id}),
                crate::dispatch
            )
            .is_err());
        assert!(service
            .execute(
                json!({"action":"resource_stop","runId":run["runId"]}),
                crate::dispatch
            )
            .is_err());
        let closed = service
            .control(&json!({"action":"prepare_close"}), crate::dispatch)
            .unwrap()
            .unwrap();
        assert_eq!(closed["ready"], true);
        let task = service
            .control(
                &json!({"action":"get_task","taskId":task_id}),
                crate::dispatch,
            )
            .unwrap()
            .unwrap();
        assert_eq!(task["task"]["status"], "succeeded");
        assert_eq!(task["task"]["result"]["run"]["status"], "succeeded");
        assert_eq!(task["task"]["result"]["run"]["cancellable"], false);
    }
    #[test]
    fn large_output_is_drained_but_memory_is_bounded() {
        let (_fixture, service, id) = setup("task", "synthetic_large_output");
        let result = service
            .execute(
                json!({"action":"resource_invoke","id":id,"actionId":"test"}),
                crate::dispatch,
            )
            .unwrap();
        assert_eq!(result["run"]["status"], "succeeded");
        assert_eq!(result["outputTruncated"], true);
        assert!(result["stdout"].as_str().unwrap().len() <= 32768);
    }
    #[test]
    fn parameter_values_are_single_arguments_and_constraints_are_enforced() {
        let mut definition:ActionDefinition=serde_json::from_value(json!({"id":"query","label":"query","mode":"task","executable":"unused","workingDirectory":"unused","args":[{"type":"literal","value":"--query"},{"type":"parameter","name":"query"}],"parameters":[{"name":"query","label":"查询","kind":"text","required":true,"maxLength":100}]})).unwrap();
        assert_eq!(
            arguments(&definition, &json!({"query":"a & b; $(echo no)"})).unwrap(),
            vec!["--query", "a & b; $(echo no)"]
        );
        for input in [
            json!({}),
            json!({"query":"--execute"}),
            json!({"query":"ok","unknown":"bad"}),
            json!({"query":"x".repeat(101)}),
        ] {
            assert!(arguments(&definition, &input).is_err());
        }
        definition.parameters[0].kind = "choice".into();
        definition.parameters[0].choices = vec!["safe".into()];
        assert!(arguments(&definition, &json!({"query":"other"})).is_err());
    }

    #[test]
    fn cancellation_is_opt_in_and_stops_only_the_invocation_process() {
        let (_fixture, service, id) = setup("task", "synthetic_wait");
        let mut definition = service
            .execute(json!({"action":"resource_list"}), crate::dispatch)
            .unwrap()["resources"][0]["actions"][0]
            .clone();
        assert_eq!(definition["cancellable"], false);
        definition["cancellable"] = json!(true);
        service.execute(json!({"action":"resource_action_set","id":id,"expectedRevision":2,"definition":definition}),crate::dispatch_local).unwrap();
        let started=service.control(&json!({"action":"start_task","request":{"action":"resource_invoke","id":id,"actionId":"test"}}),crate::dispatch).unwrap().unwrap();
        let task_id = &started["task"]["id"];
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let runs = service
                .execute(
                    json!({"action":"resource_runtime","id":id}),
                    crate::dispatch,
                )
                .unwrap();
            if !runs["runs"].as_array().unwrap().is_empty() {
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(20));
        }
        service
            .control(
                &json!({"action":"cancel_task","taskId":task_id}),
                crate::dispatch,
            )
            .unwrap();
        loop {
            let task = service
                .control(
                    &json!({"action":"get_task","taskId":task_id}),
                    crate::dispatch,
                )
                .unwrap()
                .unwrap()["task"]
                .clone();
            if task["status"] != "running" {
                assert_eq!(task["status"], "cancelled");
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            service
                .execute(
                    json!({"action":"resource_runtime","id":id}),
                    crate::dispatch
                )
                .unwrap()["runs"][0]["status"],
            "stopped"
        );
    }

    fn idle_action(
        m: &Manager,
        root: &Path,
        mode: &str,
        safe: bool,
        tracked: bool,
    ) -> (String, ActionDefinition, u64) {
        std::fs::create_dir(root).unwrap();
        let registered=crate::resources::handle(m,&json!({"action":"resource_register","name":"Idle fixture","kind":"cli","rootPath":root})).unwrap().unwrap();
        let id = registered["resource"]["id"].as_str().unwrap().to_owned();
        let mut definition = json!({"id":"idle","label":"Idle fixture","mode":mode,"cancellable":true,
            "executable":std::env::current_exe().unwrap(),"workingDirectory":root,
            "args":[{"type":"literal","value":"--exact"},{"type":"literal","value":"resource_runtime::tests::synthetic_wait"},{"type":"literal","value":"--ignored"},{"type":"literal","value":"--nocapture"}]});
        if mode == "service" {
            definition["idleReleaseSafe"] = json!(safe);
            definition["idleUsageTracked"] = json!(tracked);
        }
        configure(m,&json!({"action":"resource_action_set","id":id,"expectedRevision":1,"definition":definition})).unwrap();
        let record: ResourceRecord =
            serde_json::from_value(m.resource_store(StoreRequest::Get(id.clone())).unwrap())
                .unwrap();
        (
            id,
            registered_definition(&record, "idle").unwrap(),
            record.revision,
        )
    }
    fn spawn_idle(
        m: &Manager,
        setup: (String, ActionDefinition, u64),
        dependencies: Vec<String>,
    ) -> Value {
        let (resource_id, definition, revision) = setup;
        let args = arguments(&definition, &json!({})).unwrap();
        m.resource_runtime
            .spawn(
                PreparedInvocation {
                    resource_id,
                    revision,
                    definition,
                    args,
                },
                dependencies,
            )
            .unwrap()
    }
    fn settle_idle_output(m: &Manager, run: &Value) {
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            let result = m
                .resource_runtime
                .result(run["runId"].as_str().unwrap())
                .unwrap();
            if result["stdout"]
                .as_str()
                .unwrap()
                .contains("running 1 test")
            {
                break;
            }
            assert!(Instant::now() < until, "synthetic service did not start");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn idle_release_uses_default_elapsed_activity_only_for_safe_observed_owned_services() {
        let dir = fixture();
        let m = Manager::new(dir.path().join("state")).unwrap();
        let safe = spawn_idle(
            &m,
            idle_action(&m, &dir.path().join("safe"), "service", true, true),
            vec![],
        );
        let unknown = spawn_idle(
            &m,
            idle_action(&m, &dir.path().join("unknown"), "service", false, true),
            vec![],
        );
        let shared = spawn_idle(
            &m,
            idle_action(&m, &dir.path().join("shared"), "service", true, false),
            vec![],
        );
        let task = spawn_idle(
            &m,
            idle_action(&m, &dir.path().join("task"), "task", false, false),
            vec![],
        );
        settle_idle_output(&m, &safe);
        let at = m.resource_runtime.state.lock().unwrap().runs[safe["runId"].as_str().unwrap()]
            .activity
            .last;
        assert!(
            release_idle_at(&m, at + Duration::from_secs(599)).unwrap()["released"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let released = release_idle_at(&m, at + Duration::from_secs(601)).unwrap();
        assert_eq!(released["released"][0]["runId"], safe["runId"]);
        assert_eq!(released["released"][0]["status"], "idle_released");
        for kept in [&unknown, &shared, &task] {
            assert_eq!(
                m.resource_runtime
                    .result(kept["runId"].as_str().unwrap())
                    .unwrap()["run"]["status"],
                "running"
            );
            m.resource_runtime
                .stop(kept["runId"].as_str().unwrap())
                .unwrap();
        }
        assert!(m.resource_runtime.stop("foreign-client-process").is_err());
    }

    #[test]
    fn idle_release_respects_pause_current_policy_and_independent_call_login_keepalive() {
        let dir = fixture();
        let mut m = Manager::new(dir.path().join("state")).unwrap();
        let setup = idle_action(&m, &dir.path().join("safe"), "service", true, true);
        let resource_id = setup.0.clone();
        let run = spawn_idle(&m, setup, vec![]);
        settle_idle_output(&m, &run);
        let at = Instant::now() + Duration::from_secs(3600);
        let call = m
            .resource_runtime
            .activity_request(
                &json!({"action":"resource_usage_begin","runId":run["runId"],"kind":"call"}),
            )
            .unwrap();
        let login = m
            .resource_runtime
            .activity_request(
                &json!({"action":"resource_usage_begin","runId":run["runId"],"kind":"login"}),
            )
            .unwrap();
        assert_eq!(login["run"]["activeUses"], 2);
        assert_eq!(login["run"]["loginUses"], 1);
        m.resource_runtime.activity_request(&json!({"action":"resource_usage_end","runId":run["runId"],"leaseId":call["leaseId"]})).unwrap();
        assert!(release_idle_at(&m, at).unwrap()["released"]
            .as_array()
            .unwrap()
            .is_empty());
        m.resource_runtime
            .activity_request(
                &json!({"action":"resource_keep_alive","runId":run["runId"],"enabled":true}),
            )
            .unwrap();
        m.resource_runtime.activity_request(&json!({"action":"resource_usage_end","runId":run["runId"],"leaseId":login["leaseId"]})).unwrap();
        assert!(release_idle_at(&m, at).unwrap()["released"]
            .as_array()
            .unwrap()
            .is_empty());
        m.resource_runtime
            .activity_request(
                &json!({"action":"resource_keep_alive","runId":run["runId"],"enabled":false}),
            )
            .unwrap();
        m.state.settings["maintenance"] = json!({"revision":1,"pausedManually":true});
        assert_eq!(release_idle_at(&m, at).unwrap()["paused"], true);
        m.state.settings["maintenance"] = json!({"revision":2,"pausedManually":false});
        let policy=configure(&m,&json!({"action":"resource_idle_set","id":resource_id,"actionId":"idle","expectedRevision":2,"idleReleaseSafe":true,"idleUsageTracked":true,"idleTimeoutSeconds":0})).unwrap().unwrap();
        assert_eq!(policy["resourceRevision"], 3);
        assert_eq!(policy["actions"][0]["idleTimeoutSeconds"], 0);
        assert!(release_idle_at(&m, at).unwrap()["released"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(configure(&m,&json!({"action":"resource_idle_set","id":resource_id,"actionId":"idle","expectedRevision":2,"idleReleaseSafe":true,"idleUsageTracked":true,"idleTimeoutSeconds":10})).is_err());
        configure(&m,&json!({"action":"resource_idle_set","id":resource_id,"actionId":"idle","expectedRevision":3,"idleReleaseSafe":true,"idleUsageTracked":true,"idleTimeoutSeconds":10})).unwrap();
        assert_eq!(
            release_idle_at(&m, at).unwrap()["released"][0]["status"],
            "idle_released"
        );
    }

    #[test]
    fn idle_dependency_uses_live_until_each_actual_child_finishes_and_failed_spawn_adds_none() {
        let dir = fixture();
        let m = Manager::new(dir.path().join("state")).unwrap();
        let service = idle_action(&m, &dir.path().join("safe"), "service", true, true);
        let dependency_id = service.0.clone();
        let run = spawn_idle(&m, service, vec![]);
        settle_idle_output(&m, &run);
        let first = spawn_idle(
            &m,
            idle_action(&m, &dir.path().join("first"), "task", false, false),
            vec![dependency_id.clone(), dependency_id.clone()],
        );
        let second = spawn_idle(
            &m,
            idle_action(&m, &dir.path().join("second"), "task", false, false),
            vec![dependency_id.clone()],
        );
        assert_eq!(
            m.resource_runtime
                .result(run["runId"].as_str().unwrap())
                .unwrap()["run"]["activeUses"],
            2
        );
        let at = Instant::now() + Duration::from_secs(3600);
        assert!(release_idle_at(&m, at).unwrap()["released"]
            .as_array()
            .unwrap()
            .is_empty());
        m.resource_runtime
            .stop(first["runId"].as_str().unwrap())
            .unwrap();
        assert_eq!(
            m.resource_runtime
                .result(run["runId"].as_str().unwrap())
                .unwrap()["run"]["activeUses"],
            1
        );
        assert!(release_idle_at(&m, at).unwrap()["released"]
            .as_array()
            .unwrap()
            .is_empty());
        m.resource_runtime
            .stop(second["runId"].as_str().unwrap())
            .unwrap();
        assert_eq!(
            m.resource_runtime
                .result(run["runId"].as_str().unwrap())
                .unwrap()["run"]["activeUses"],
            0
        );
        let last_use = m.resource_runtime.state.lock().unwrap().runs
            [run["runId"].as_str().unwrap()]
        .activity
        .last;
        let (id, mut definition, revision) =
            idle_action(&m, &dir.path().join("failed"), "task", false, false);
        definition.executable = dir
            .path()
            .join("missing-program.exe")
            .to_string_lossy()
            .into_owned();
        assert!(m
            .resource_runtime
            .spawn(
                PreparedInvocation {
                    resource_id: id,
                    revision,
                    definition,
                    args: vec![]
                },
                vec![dependency_id]
            )
            .is_err());
        assert_eq!(
            m.resource_runtime
                .result(run["runId"].as_str().unwrap())
                .unwrap()["run"]["activeUses"],
            0
        );
        assert_eq!(
            m.resource_runtime.state.lock().unwrap().runs[run["runId"].as_str().unwrap()]
                .activity
                .last,
            last_use,
            "a failed spawn must not postpone the dependency's idle deadline"
        );
        assert!(
            release_idle_at(&m, last_use + Duration::from_secs(599)).unwrap()["released"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            release_idle_at(&m, last_use + Duration::from_secs(600)).unwrap()["released"][0]
                ["runId"],
            run["runId"]
        );
    }

    #[test]
    fn idle_unknown_clients_tasks_and_legacy_definitions_never_gain_automatic_permission() {
        let base = json!({"id":"read","label":"Read","mode":"service","executable":"D:/synthetic/tool.exe","workingDirectory":"D:/synthetic"});
        let mut definition: ActionDefinition = serde_json::from_value(base).unwrap();
        assert!(!idle_safe(&definition));
        assert_eq!(definition.idle_timeout_seconds.unwrap_or(600), 600);
        assert!(serde_json::to_value(&definition)
            .unwrap()
            .get("idleReleaseSafe")
            .is_none());
        definition.idle_release_safe = true;
        assert!(!idle_safe(&definition));
        definition.idle_usage_tracked = true;
        assert!(idle_safe(&definition));
        for executable in [
            "D:/user/msedge.exe",
            "D:/user/codex.exe",
            "D:/user/Codex-cli.exe",
        ] {
            definition.executable = executable.into();
            assert!(!idle_safe(&definition));
            assert!(validate_idle_policy(&definition).is_err());
        }
        definition.executable = "D:/synthetic/tool.exe".into();
        definition.mode = "task".into();
        assert!(!idle_safe(&definition));
        assert!(validate_idle_policy(&definition).is_err());
    }

    #[test]
    fn idle_policy_read_failure_keeps_service_and_reports_once_without_automatic_retry() {
        let dir = fixture();
        let m = Manager::new(dir.path().join("state")).unwrap();
        let run = spawn_idle(
            &m,
            idle_action(&m, &dir.path().join("safe"), "service", true, true),
            vec![],
        );
        settle_idle_output(&m, &run);
        let id = run["runId"].as_str().unwrap();
        let db = rusqlite::Connection::open(dir.path().join("state/manager.sqlite3")).unwrap();
        db.execute("UPDATE resource_catalog SET payload='invalid JSON'", [])
            .unwrap();
        let at = Instant::now() + Duration::from_secs(3600);
        let result = release_idle_at(&m, at).unwrap();
        assert_eq!(result["errors"].as_array().unwrap().len(), 1);
        assert!(result["released"].as_array().unwrap().is_empty());
        let retained = m.resource_runtime.result(id).unwrap();
        assert_eq!(retained["run"]["status"], "running");
        assert_eq!(retained["run"]["idleEligible"], false);
        assert!(retained["run"]["idleError"]
            .as_str()
            .unwrap()
            .contains("无法核对当前闲置策略"));
        assert_eq!(
            release_idle_at(&m, at + Duration::from_secs(60)).unwrap(),
            json!({"released":[],"paused":false})
        );
        m.resource_runtime.stop(id).unwrap();
    }
}
