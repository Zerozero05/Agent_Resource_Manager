//! Evidence of actual owned task completion, separate from mutable catalog metadata.
//! Parameters, process output and credentials never enter this journal.
use crate::{
    model::{now, Manager},
    resource_files::{self, FileRole},
    resource_runtime::ActionDefinition,
    resources::{ResourceRecord, StoreRequest as Catalog},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Binding {
    definition_hash: String,
    file_binding_hash: String,
    source_hash: String,
    binding_hash: String,
}

/// Created before spawn from a checked action. Never accepted from JSON or stored
/// in exported settings. Catalog revision/alias/notes are deliberately excluded.
pub(crate) struct InvocationStamp {
    resource_id: String,
    action_id: String,
    version: Option<String>,
    root_path: String,
    entry_path: String,
    scope: String,
    epoch: u64,
    binding: Binding,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum CompletionKind {
    #[default]
    ProcessExit,
    McpToolCall,
}

/// Protocol metadata only. The connection identifier, arguments and returned
/// page/tab content deliberately never enter the persistent evidence journal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProtocolEvidence {
    method: Option<String>,
    tool_name: Option<String>,
    protocol_version: Option<String>,
    rpc_result_received: bool,
    is_error: Option<bool>,
    json_rpc_error: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecutionEvidence {
    run_id: String,
    resource_id: String,
    action_id: String,
    version: Option<String>,
    root_path: String,
    entry_path: String,
    scope: String,
    started_at: String,
    finished_at: String,
    process_status: String,
    exit_code: Option<i64>,
    #[serde(default)]
    completion_kind: CompletionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    protocol: Option<ProtocolEvidence>,
    #[serde(default)]
    epoch: u64,
    binding: Binding,
}

pub(crate) enum StoreRequest {
    Observe(Box<ExecutionEvidence>),
    List { resource_id: String },
    Epoch { resource_id: String },
}
impl StoreRequest {
    pub(crate) fn writes(&self) -> bool {
        matches!(self, Self::Observe(_))
    }
}

pub(crate) fn initialize(db: &Connection) -> Result<(), String> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS resource_capability_evidence (run_id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, action_id TEXT NOT NULL, finished_at TEXT NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS resource_capability_evidence_resource ON resource_capability_evidence(resource_id,action_id,finished_at); CREATE TABLE IF NOT EXISTS resource_capability_epochs (resource_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL CHECK(epoch>=0));")
        .map_err(|e|e.to_string())
}
fn available(db: &Connection) -> Result<bool, String> {
    db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='resource_capability_evidence')",[],|row|row.get(0)).map_err(|e|e.to_string())
}
pub(crate) fn store(db: &Connection, request: StoreRequest) -> Result<Value, String> {
    match request {
        StoreRequest::Epoch { resource_id } => Ok(json!({"epoch":epoch(db,&resource_id)?})),
        StoreRequest::Observe(evidence) => {
            let existing: Option<String> = db
                .query_row(
                    "SELECT payload FROM resource_capability_evidence WHERE run_id=?1",
                    [&evidence.run_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let payload = serde_json::to_string(&evidence).map_err(|e| e.to_string())?;
            if let Some(existing) = existing {
                if existing != payload {
                    return Err("同一次受管任务已有不同的完成证据，原记录保留".into());
                }
                return Ok(json!({"evidence":evidence,"saved":true,"alreadyRecorded":true}));
            }
            db.execute("INSERT INTO resource_capability_evidence(run_id,resource_id,action_id,finished_at,payload) VALUES(?1,?2,?3,?4,?5)",params![evidence.run_id,evidence.resource_id,evidence.action_id,evidence.finished_at,payload]).map_err(|e|e.to_string())?;
            Ok(json!({"evidence":evidence,"saved":true,"alreadyRecorded":false}))
        }
        StoreRequest::List { resource_id } => {
            if !available(db)? {
                return Ok(json!({"latest":[],"history":[],"total":0,"tableAvailable":false}));
            }
            let read = |sql: &str| -> Result<Vec<ExecutionEvidence>, String> {
                let mut statement = db.prepare(sql).map_err(|e| e.to_string())?;
                let values = statement
                    .query_map([&resource_id], |row| row.get::<_, String>(0))
                    .map_err(|e| e.to_string())?;
                values
                    .map(|value| {
                        serde_json::from_str(&value.map_err(|e| e.to_string())?)
                            .map_err(|e| format!("调用证据不可读取，原记录保留：{e}"))
                    })
                    .collect()
            };
            let latest=read("SELECT e.payload FROM resource_capability_evidence e WHERE e.resource_id=?1 AND NOT EXISTS(SELECT 1 FROM resource_capability_evidence newer WHERE newer.resource_id=e.resource_id AND newer.action_id=e.action_id AND (newer.finished_at>e.finished_at OR (newer.finished_at=e.finished_at AND newer.rowid>e.rowid))) ORDER BY e.finished_at DESC,e.rowid DESC")?;
            let history=read("SELECT payload FROM resource_capability_evidence WHERE resource_id=?1 ORDER BY finished_at DESC,rowid DESC LIMIT 50")?;
            let count: u64 = db
                .query_row(
                    "SELECT COUNT(*) FROM resource_capability_evidence WHERE resource_id=?1",
                    [&resource_id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            Ok(json!({"latest":latest,"history":history,"total":count,"tableAvailable":true}))
        }
    }
}

fn epoch(db: &Connection, resource_id: &str) -> Result<u64, String> {
    let available:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='resource_capability_epochs')",[],|row|row.get(0)).map_err(|e|e.to_string())?;
    if !available {
        return Ok(0);
    }
    db.query_row(
        "SELECT epoch FROM resource_capability_epochs WHERE resource_id=?1",
        [resource_id],
        |row| row.get::<_, u64>(0),
    )
    .optional()
    .map(|value| value.unwrap_or(0))
    .map_err(|e| e.to_string())
}

fn catalog_signature(record: &ResourceRecord) -> String {
    let mut actions: Vec<_> = record
        .actions
        .iter()
        .map(|value| {
            serde_json::from_value::<ActionDefinition>(value.clone())
                .map(|definition| definition_hash(&definition))
                .unwrap_or_else(|_| digest(value))
        })
        .collect();
    actions.sort();
    let mut files=record.installation.as_ref().map(|installation|installation.files.iter().filter(|file|matches!(file.role,FileRole::Runtime|FileRole::PrivateDependency)).map(|file|json!({"path":file.path,"role":file.role,"sha256":file.installed_sha256})).collect::<Vec<_>>()).unwrap_or_default();
    files.sort_by_key(Value::to_string);
    digest(
        &json!({"version":record.version,"root":path_key(Path::new(&record.root_path)),"source":stable_source(record),"actions":actions,"files":files}),
    )
}
/// Called by the single writer inside the same catalog/configuration transaction.
/// The monotonic epoch stops a change-and-revert from resurrecting an old pass.
pub(crate) fn transition(
    db: &Connection,
    before: &ResourceRecord,
    after: &ResourceRecord,
) -> Result<(), String> {
    if before.id != after.id {
        return Err("能力证据的资源身份不能在原记录中变更".into());
    }
    if catalog_signature(before) == catalog_signature(after) {
        return Ok(());
    }
    let next = epoch(db, &before.id)?
        .checked_add(1)
        .ok_or("调用证据代次超出范围")?;
    db.execute("INSERT INTO resource_capability_epochs(resource_id,epoch) VALUES(?1,?2) ON CONFLICT(resource_id) DO UPDATE SET epoch=excluded.epoch",params![before.id,next]).map_err(|e|e.to_string())?;
    Ok(())
}

fn digest(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}
fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy();
    let text = text
        .strip_prefix(r"\\?\UNC\")
        .map(|value| format!(r"\\{value}"))
        .or_else(|| text.strip_prefix(r"\\?\").map(str::to_owned))
        .unwrap_or_else(|| text.into_owned());
    if cfg!(windows) {
        text.replace('/', "\\").to_ascii_lowercase()
    } else {
        text
    }
}
fn definition_hash(definition: &ActionDefinition) -> String {
    let mut value = json!(definition);
    for key in [
        "label",
        "idleReleaseSafe",
        "idleUsageTracked",
        "idleTimeoutSeconds",
    ] {
        value.as_object_mut().unwrap().remove(key);
    }
    if let Some(parameters) = value["parameters"].as_array_mut() {
        for parameter in parameters {
            if let Some(fields) = parameter.as_object_mut() {
                for key in ["label", "templateAllowed"] {
                    fields.remove(key);
                }
            }
        }
    }
    digest(&value)
}
fn stable_source(record: &ResourceRecord) -> Value {
    let source = record.source_binding.as_ref();
    let asset = source.and_then(|source| source.asset.as_ref());
    let installation = record.installation.as_ref();
    json!({"repository":record.repository.as_ref().map(|value|value.trim_end_matches('/').to_ascii_lowercase()),
        "binding":source.map(|source|json!({"repository":source.repository.trim_end_matches('/').to_ascii_lowercase(),"repositoryId":source.repository_id})),
        "asset":asset.map(|asset|json!({"releaseId":asset.release_id,"assetId":asset.asset_id,"tag":asset.tag,"assetName":asset.asset_name,"digest":asset.digest})),
        "installation":installation.map(|install|json!({"archiveSha256":install.archive_sha256,"sourceRepository":install.source_repository,"sourceVersion":install.source_version}))})
}
fn binding(record: &ResourceRecord, definition: &ActionDefinition) -> Result<Binding, String> {
    crate::resource_adapters::validate_action(record, definition)?;
    let executable = Path::new(&definition.executable);
    crate::transaction::verify_root(executable)?;
    let executable_file = resource_files::fingerprint(executable)?;
    if definition.executable_sha256.as_deref() != Some(executable_file.sha256.as_str()) {
        return Err("调用入口摘要已变化，历史证据需复核".into());
    }
    let mut files = vec![
        json!({"path":path_key(executable),"objectIdentity":crate::clients::file_identity(executable)?,"file":executable_file}),
    ];
    if let Some(installation) = record.installation.as_ref() {
        for file in &installation.files {
            if matches!(file.role, FileRole::Runtime | FileRole::PrivateDependency) {
                let path = crate::local::safe_join(Path::new(&record.root_path), &file.path)?;
                if path_key(&path) == path_key(executable) {
                    continue;
                }
                files.push(json!({"path":path_key(&path),"objectIdentity":crate::clients::file_identity(&path)?,"file":resource_files::fingerprint(&path)?}));
            }
        }
    }
    // A fixed interpreter argument may be the real program (for example a
    // local Python/JavaScript entry). Do not read arbitrary configuration,
    // parameter values, output paths or credential files to form this proof.
    for argument in &definition.args {
        let crate::resource_runtime::Argument::Literal { value } = argument else {
            continue;
        };
        if value.starts_with('-') {
            continue;
        }
        let path = Path::new(value);
        let Some(extension) = path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
        else {
            continue;
        };
        if !matches!(
            extension.as_str(),
            "exe"
                | "dll"
                | "so"
                | "dylib"
                | "py"
                | "pyw"
                | "js"
                | "mjs"
                | "cjs"
                | "ps1"
                | "sh"
                | "bat"
                | "cmd"
        ) {
            continue;
        }
        let path = if path.is_absolute() {
            path.to_owned()
        } else {
            Path::new(&definition.working_directory).join(path)
        };
        if !path.is_file() {
            continue;
        }
        crate::transaction::verify_root(&path)?;
        let key = path_key(&path);
        if files.iter().any(|file| file["path"] == key) {
            continue;
        }
        files.push(json!({"path":key,"objectIdentity":crate::clients::file_identity(&path)?,"file":resource_files::fingerprint(&path)?}));
    }
    files.sort_by_key(|file| file["path"].as_str().unwrap_or_default().to_owned());
    let definition_hash = definition_hash(definition);
    let file_binding_hash = digest(
        &json!({"root":path_key(Path::new(&record.root_path)),"rootIdentity":crate::clients::file_identity(Path::new(&record.root_path))?,"files":files,"adapter":definition.adapter_binding}),
    );
    let source_hash = digest(&stable_source(record));
    let binding_hash = digest(
        &json!({"version":record.version,"definition":definition_hash,"files":file_binding_hash,"source":source_hash}),
    );
    Ok(Binding {
        definition_hash,
        file_binding_hash,
        source_hash,
        binding_hash,
    })
}
fn scope(definition: &ActionDefinition) -> &'static str {
    if crate::resource_runtime::mcp_tool_for_action(definition).is_some() {
        return "mcpToolCall";
    }
    match (
        definition
            .adapter_binding
            .as_ref()
            .map(|binding| binding.adapter.as_str()),
        definition.id.as_str(),
    ) {
        (Some("agentReach"), "reach-version") | (Some("edgeControl"), "edge-version") => {
            "cliVersionCommand"
        }
        (Some("agentReach"), "reach-doctor") => "localDoctorCommand",
        (Some("agentReach"), "reach-channels") => "channelListingCommand",
        (Some("edgeControl"), "edge-help") => "cliHelpCommand",
        _ => "registeredTaskExit",
    }
}

fn protocol_evidence(run: &Value) -> ProtocolEvidence {
    let value = &run["protocolEvidence"];
    let protocol_version = value["protocolVersion"].as_str().filter(|version| {
        version.len() == 10
            && version.bytes().enumerate().all(|(index, byte)| {
                if matches!(index, 4 | 7) {
                    byte == b'-'
                } else {
                    byte.is_ascii_digit()
                }
            })
    });
    ProtocolEvidence {
        method: value["method"]
            .as_str()
            .filter(|method| *method == "tools/call")
            .map(str::to_owned),
        tool_name: value["toolName"]
            .as_str()
            .filter(|tool| matches!(*tool, "browser_tabs" | "browser_snapshot"))
            .map(str::to_owned),
        protocol_version: protocol_version.map(str::to_owned),
        rpc_result_received: value["rpcResultReceived"].as_bool() == Some(true),
        is_error: value["isError"].as_bool(),
        // Missing/malformed error state cannot accidentally become a pass.
        json_rpc_error: value["jsonRpcError"].as_bool() != Some(false),
    }
}

fn protocol_passed(tool: &str, evidence: &ExecutionEvidence) -> bool {
    evidence.completion_kind == CompletionKind::McpToolCall
        && evidence.process_status == "succeeded"
        && evidence.exit_code.is_none()
        && evidence.protocol.as_ref().is_some_and(|protocol| {
            protocol.method.as_deref() == Some("tools/call")
                && protocol.tool_name.as_deref() == Some(tool)
                && protocol
                    .protocol_version
                    .as_deref()
                    .is_some_and(crate::resource_runtime::supports_mcp_protocol)
                && protocol.rpc_result_received
                && protocol.is_error == Some(false)
                && !protocol.json_rpc_error
        })
}

fn completion_status(
    definition: &ActionDefinition,
    evidence: &ExecutionEvidence,
) -> (&'static str, String) {
    if let Some(tool) = crate::resource_runtime::mcp_tool_for_action(definition) {
        return if protocol_passed(tool, evidence) {
            ("passed", format!("固定 MCP 动作 {tool} 已收到成功的协议结果；不据此认定其他浏览器动作或登录能力通过"))
        } else {
            (
                "failed",
                format!("固定 MCP 动作 {tool} 未取得匹配的成功协议结果；保留实际完成状态与时间"),
            )
        };
    }
    if evidence.completion_kind == CompletionKind::ProcessExit
        && evidence.protocol.is_none()
        && evidence.process_status == "succeeded"
        && evidence.exit_code == Some(0)
    {
        (
            "passed",
            "本次固定动作进程成功退出；不据此认定平台、浏览器或登录能力通过".into(),
        )
    } else {
        (
            "failed",
            "实际动作进程未成功完成；详情保留退出状态与时间".into(),
        )
    }
}
pub(crate) fn capture(
    m: &Manager,
    record: &ResourceRecord,
    definition: &ActionDefinition,
) -> Result<Option<InvocationStamp>, String> {
    if definition.mode != "task" {
        return Ok(None);
    }
    Ok(Some(InvocationStamp {
        resource_id: record.id.clone(),
        action_id: definition.id.clone(),
        version: record.version.clone(),
        root_path: record.root_path.clone(),
        entry_path: definition.executable.clone(),
        scope: scope(definition).into(),
        epoch: m.capability_evidence_store(StoreRequest::Epoch {
            resource_id: record.id.clone(),
        })?["epoch"]
            .as_u64()
            .ok_or("调用证据代次不可读取")?,
        binding: binding(record, definition)?,
    }))
}

/// Called after the owned task has actually completed. The run and immutable
/// definition come from RuntimeRegistry, never the caller's success flag.
pub(crate) fn observe(m: &Manager, stamp: &InvocationStamp, run_id: &str) -> Result<Value, String> {
    let actual = m.resource_runtime.result(run_id)?;
    let run = &actual["run"];
    let definition = m
        .resource_runtime
        .completed_definition(run_id)?
        .ok_or("服务或尚未结束的进程不构成任务完成证据")?;
    if run["resourceId"] != stamp.resource_id
        || run["actionId"] != stamp.action_id
        || run["mode"] != "task"
        || definition_hash(&definition) != stamp.binding.definition_hash
    {
        return Err("实际受管进程与本次调用绑定不同，未记录能力通过".into());
    }
    let status = run["status"]
        .as_str()
        .filter(|value| matches!(*value, "succeeded" | "failed" | "timed_out" | "stopped"))
        .ok_or("进程尚无明确完成状态")?;
    let started = run["startedAt"].as_str().ok_or("实际开始时间缺失")?;
    let finished = run["finishedAt"].as_str().ok_or("实际完成时间缺失")?;
    let start_time = chrono::DateTime::parse_from_rfc3339(started).map_err(|_| "开始时间无效")?;
    let finish_time = chrono::DateTime::parse_from_rfc3339(finished).map_err(|_| "完成时间无效")?;
    if finish_time < start_time {
        return Err("调用时间顺序无效，未记录能力通过".into());
    }
    let is_mcp = crate::resource_runtime::mcp_tool_for_action(&definition).is_some();
    if !is_mcp && !run["protocolEvidence"].is_null() {
        return Err("普通进程动作不能提交 MCP 协议证据".into());
    }
    if is_mcp
        && !run
            .get("exitCode")
            .is_some_and(|value| value.is_null() || value.as_i64().is_some())
    {
        return Err("MCP 任务完成状态中的退出码格式无效，未记录能力通过".into());
    }
    let evidence = ExecutionEvidence {
        run_id: run_id.into(),
        resource_id: stamp.resource_id.clone(),
        action_id: stamp.action_id.clone(),
        version: stamp.version.clone(),
        root_path: stamp.root_path.clone(),
        entry_path: stamp.entry_path.clone(),
        scope: stamp.scope.clone(),
        started_at: started.into(),
        finished_at: finished.into(),
        process_status: status.into(),
        exit_code: run["exitCode"].as_i64(),
        completion_kind: if is_mcp {
            CompletionKind::McpToolCall
        } else {
            CompletionKind::ProcessExit
        },
        protocol: is_mcp.then(|| protocol_evidence(run)),
        epoch: stamp.epoch,
        binding: stamp.binding.clone(),
    };
    m.capability_evidence_store(StoreRequest::Observe(Box::new(evidence)))
}
fn read(m: &Manager, id: &str) -> Result<Value, String> {
    let record: ResourceRecord = serde_json::from_value(m.resource_store(Catalog::Get(id.into()))?)
        .map_err(|e| e.to_string())?;
    let stored = m.capability_evidence_store(StoreRequest::List {
        resource_id: id.into(),
    })?;
    let latest: Vec<ExecutionEvidence> =
        serde_json::from_value(stored["latest"].clone()).map_err(|e| e.to_string())?;
    let epoch = m.capability_evidence_store(StoreRequest::Epoch {
        resource_id: id.into(),
    })?["epoch"]
        .as_u64()
        .ok_or("调用证据代次不可读取")?;
    let mut actions = vec![];
    for value in &record.actions {
        let definition: ActionDefinition =
            serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
        let evidence = latest
            .iter()
            .find(|evidence| evidence.action_id == definition.id);
        let checked = if definition.mode == "task"
            && evidence.is_some_and(|evidence| evidence.epoch == epoch)
        {
            Some(
                crate::resource_runtime::verified_definition(&record, &definition.id)
                    .and_then(|current| binding(&record, &current)),
            )
        } else {
            None
        };
        let (status, reason) = if definition.mode != "task" {
            (
                "unverified",
                "服务启动或连接存在不代表能力实测通过".to_string(),
            )
        } else if let Some(evidence) = evidence.filter(|evidence| evidence.epoch == epoch) {
            match checked.as_ref().expect("evidence binding was checked") {
                Ok(current) if *current == evidence.binding => {
                    completion_status(&definition, evidence)
                }
                Ok(_) => (
                    "stale",
                    "版本、来源、固定动作或运行文件已变化，原证据保留为历史".into(),
                ),
                Err(error) => ("stale", error.clone()),
            }
        } else if evidence.is_some() {
            (
                "stale",
                "相关运行配置曾发生变化；即使恢复原值，仍须重新实际调用，历史结果保留".into(),
            )
        } else {
            ("unverified", "尚无此动作实际完成的受管任务证据".into())
        };
        actions.push(json!({"actionId":definition.id,"label":definition.label,"mode":definition.mode,"status":status,"reason":reason,"latest":evidence}));
    }
    let removed: Vec<_> = latest
        .iter()
        .filter(|evidence| {
            !record
                .actions
                .iter()
                .any(|action| action["id"] == evidence.action_id)
        })
        .collect();
    Ok(
        json!({"resourceId":record.id,"version":record.version,"rootPath":record.root_path,"checkedAt":now(),"actions":actions,"removedActionEvidence":removed,"history":stored["history"],"total":stored["total"],"historyLimit":50,"scope":"ownedActionCompletion","completionKinds":["processExit","mcpToolCall"],"parametersStored":false,"outputStored":false,"platformCallsVerified":false,"userSessionVerified":false}),
    )
}
pub(crate) fn handle(m: &Manager, request: &Value) -> Result<Option<Value>, String> {
    if request["action"] != "resource_capability_evidence" {
        return Ok(None);
    }
    if request.as_object().is_none_or(|value| {
        value
            .keys()
            .any(|key| !matches!(key.as_str(), "action" | "resourceId"))
    }) {
        return Err("调用证据只读请求不接受通过标记或参数".into());
    }
    let id = request["resourceId"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 64)
        .ok_or("缺少资源标识")?;
    read(m, id).map(Some)
}

#[cfg(test)]
mod tests;
