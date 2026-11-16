//! Inert, explicitly selected non-sensitive parameters; never launch or restore actions.
use crate::{
    model::Manager,
    resource_runtime::{self, ActionDefinition},
    resources::ResourceRecord,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

pub(crate) enum Operation {
    List,
    Save {
        template_id: Option<String>,
        expected_revision: u64,
        expected_resource_revision: u64,
        name: String,
        parameters: Value,
        verified_binding: String,
    },
    Remove {
        template_id: String,
        expected_revision: u64,
    },
    Prepare {
        template_id: String,
        expected_revision: u64,
        expected_resource_revision: u64,
        verified_binding: String,
    },
}
pub(crate) struct StoreRequest {
    pub resource_id: String,
    pub action_id: String,
    pub operation: Operation,
}
impl StoreRequest {
    pub(crate) fn writes(&self) -> bool {
        matches!(
            self.operation,
            Operation::Save { .. } | Operation::Remove { .. }
        )
    }
    pub(crate) fn lists(&self) -> bool {
        matches!(self.operation, Operation::List)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Template {
    id: String,
    revision: u64,
    name: String,
    resource_id: String,
    action_id: String,
    binding: String,
    parameters: Value,
}

fn table_exists(db: &Connection, name: &str) -> Result<bool, String> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}
pub(crate) fn revision(db: &Connection) -> Result<u64, String> {
    if !table_exists(db, "invocation_templates_meta")? {
        return Ok(0);
    }
    db.query_row(
        "SELECT revision FROM invocation_templates_meta WHERE id=1",
        [],
        |r| r.get(0),
    )
    .optional()
    .map(|value| value.unwrap_or(0))
    .map_err(|e| e.to_string())
}
pub(crate) fn initialize(db: &Connection) -> Result<u64, String> {
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS invocation_templates (
        id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, action_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision>0), payload TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS invocation_templates_target ON invocation_templates(resource_id,action_id);
    CREATE TABLE IF NOT EXISTS invocation_templates_meta (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);").map_err(|e|e.to_string())?;
    let revision = revision(&tx)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(revision)
}

pub(crate) fn binding(
    record: &ResourceRecord,
    definition: &ActionDefinition,
) -> Result<String, String> {
    let root = crate::local::canonical(Path::new(&record.root_path))?;
    if !root.is_dir() {
        return Err("资源实际目录不可用".into());
    }
    // Verification normalizes these paths (including Windows' verbatim prefix).
    // Save, live CAS, list and prepare must hash that same definition spelling.
    let mut definition = definition.clone();
    definition.executable = crate::local::canonical(Path::new(&definition.executable))?
        .to_string_lossy()
        .into_owned();
    definition.working_directory =
        crate::local::canonical(Path::new(&definition.working_directory))?
            .to_string_lossy()
            .into_owned();
    let evidence = json!({"resourceId":record.id,"root":root.to_string_lossy(),"version":record.version,"definition":definition});
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&evidence).map_err(|e| e.to_string())?)
    ))
}
fn decode(payload: String) -> Result<Template, String> {
    serde_json::from_str(&payload).map_err(|e| format!("无法读取调用模板，原记录保留：{e}"))
}
fn read_one(
    db: &Connection,
    id: &str,
    resource_id: &str,
    action_id: &str,
) -> Result<Template, String> {
    let payload=db.query_row("SELECT payload FROM invocation_templates WHERE id=?1 AND resource_id=?2 AND action_id=?3",params![id,resource_id,action_id],|r|r.get::<_,String>(0)).optional().map_err(|e|e.to_string())?.ok_or("调用模板不存在或已删除，请重新读取")?;
    let template = decode(payload)?;
    if template.id != id || template.resource_id != resource_id || template.action_id != action_id {
        return Err("调用模板身份不一致，原记录保留".into());
    }
    Ok(template)
}
fn compatible(
    record: &ResourceRecord,
    definition: &ActionDefinition,
    template: &Template,
) -> Result<(), String> {
    if template.binding != binding(record, definition)? {
        return Err("资源位置、版本或动作定义已变化，请重新核对后保存模板".into());
    }
    resource_runtime::validate_template_parameters(definition, &template.parameters)
}
fn list(db: &Connection, record: &ResourceRecord, action_id: &str) -> Result<Value, String> {
    let mut templates = Vec::new();
    if table_exists(db, "invocation_templates")? {
        let mut query=db.prepare("SELECT payload FROM invocation_templates WHERE resource_id=?1 AND action_id=?2 ORDER BY rowid").map_err(|e|e.to_string())?;
        let rows = query
            .query_map(params![record.id, action_id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let definition = resource_runtime::registered_definition(record, action_id);
        for row in rows {
            let template = decode(row.map_err(|e| e.to_string())?)?;
            let outcome = definition
                .as_ref()
                .map_err(Clone::clone)
                .and_then(|definition| compatible(record, definition, &template));
            let mut item = json!({"id":template.id,"revision":template.revision,"name":template.name,"resourceId":template.resource_id,"actionId":template.action_id,"parameterNames":template.parameters.as_object().ok_or("调用模板参数无效，原记录保留")?.keys().collect::<Vec<_>>(),"compatible":outcome.is_ok()});
            if let Err(reason) = outcome {
                item["reason"] = json!(reason);
            }
            templates.push(item);
        }
    }
    Ok(json!({"templates":templates,"resourceRevision":record.revision}))
}
const CONFLICT: &str = "调用模板或资源已变化，请重新读取后再操作";
fn next_revision(current: u64) -> Result<u64, String> {
    current
        .checked_add(1)
        .filter(|value| *value <= i64::MAX as u64)
        .ok_or_else(|| "模板修订号超出范围".into())
}
fn recheck(
    record: &ResourceRecord,
    action_id: &str,
    expected: u64,
    verified: &str,
) -> Result<ActionDefinition, String> {
    if record.revision != expected {
        return Err(CONFLICT.into());
    }
    let definition = resource_runtime::registered_definition(record, action_id)?;
    if binding(record, &definition)? != verified {
        return Err(CONFLICT.into());
    }
    Ok(definition)
}

/// Only called on the live connection, with current catalog and manager lock.
pub(crate) fn store(
    db: &Connection,
    record: &ResourceRecord,
    request: StoreRequest,
    state_revision: u64,
) -> Result<(Value, bool), String> {
    let action_id = &request.action_id;
    match request.operation {
        Operation::List => Ok((list(db, record, action_id)?, false)),
        Operation::Prepare {
            template_id,
            expected_revision,
            expected_resource_revision,
            verified_binding,
        } => {
            let definition = recheck(
                record,
                action_id,
                expected_resource_revision,
                &verified_binding,
            )?;
            let template = read_one(db, &template_id, &record.id, action_id)?;
            if template.revision != expected_revision {
                return Err(CONFLICT.into());
            }
            compatible(record, &definition, &template)?;
            Ok((
                json!({"parameters":template.parameters,"resourceRevision":record.revision,"actionId":action_id,"templateId":template_id}),
                false,
            ))
        }
        operation => {
            let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
            let (changed, saved_id) = match operation {
                Operation::Save {
                    template_id,
                    expected_revision,
                    expected_resource_revision,
                    name,
                    parameters,
                    verified_binding,
                } => {
                    let definition = recheck(
                        record,
                        action_id,
                        expected_resource_revision,
                        &verified_binding,
                    )?;
                    resource_runtime::validate_template_parameters(&definition, &parameters)?;
                    let current = template_id
                        .as_ref()
                        .map(|id| read_one(&tx, id, &record.id, action_id))
                        .transpose()?;
                    if current.as_ref().map_or(0, |template| template.revision) != expected_revision
                    {
                        return Err(CONFLICT.into());
                    }
                    let id = template_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                    let changed = !current.as_ref().is_some_and(|template| {
                        template.name == name
                            && template.parameters == parameters
                            && template.binding == verified_binding
                    });
                    if changed {
                        let next = next_revision(expected_revision)?;
                        let template = Template {
                            id: id.clone(),
                            revision: next,
                            name,
                            resource_id: record.id.clone(),
                            action_id: action_id.clone(),
                            binding: verified_binding,
                            parameters,
                        };
                        let payload =
                            serde_json::to_string(&template).map_err(|e| e.to_string())?;
                        let affected=if current.is_some() {
                            tx.execute("UPDATE invocation_templates SET revision=?1,payload=?2 WHERE id=?3 AND revision=?4",params![next,payload,id,expected_revision])
                        }else{
                            tx.execute("INSERT INTO invocation_templates(id,resource_id,action_id,revision,payload) VALUES(?1,?2,?3,?4,?5)",params![id,record.id,action_id,next,payload])
                        }.map_err(|e|e.to_string())?;
                        if affected != 1 {
                            return Err(CONFLICT.into());
                        }
                    }
                    (changed, Some(id))
                }
                Operation::Remove {
                    template_id,
                    expected_revision,
                } => {
                    let template = read_one(&tx, &template_id, &record.id, action_id)?;
                    if template.revision != expected_revision {
                        return Err(CONFLICT.into());
                    }
                    let affected = tx
                        .execute(
                            "DELETE FROM invocation_templates WHERE id=?1 AND revision=?2",
                            params![template_id, expected_revision],
                        )
                        .map_err(|e| e.to_string())?;
                    if affected != 1 {
                        return Err(CONFLICT.into());
                    }
                    (true, None)
                }
                _ => unreachable!(),
            };
            if changed {
                tx.execute("INSERT INTO invocation_templates_meta(id,revision) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision",[state_revision]).map_err(|e|e.to_string())?;
            }
            let mut result = list(&tx, record, action_id)?;
            if let Some(id) = saved_id {
                result["templateId"] = json!(id);
            }
            tx.commit().map_err(|e| e.to_string())?;
            Ok((result, changed))
        }
    }
}

fn fields(request: &Value, allowed: &[&str]) -> Result<(), String> {
    if request
        .as_object()
        .ok_or("请求必须是对象")?
        .keys()
        .any(|key| !allowed.contains(&key.as_str()))
    {
        return Err("调用模板请求包含不支持的字段".into());
    }
    Ok(())
}
fn text(request: &Value, key: &str, max: usize) -> Result<String, String> {
    let value = request[key].as_str().ok_or_else(|| format!("缺少 {key}"))?;
    if value.trim().is_empty() || value.chars().count() > max || value.contains('\0') {
        return Err(format!("{key} 无效或过长"));
    }
    Ok(value.to_owned())
}
fn expected(request: &Value, key: &str, allow_zero: bool) -> Result<u64, String> {
    request[key]
        .as_u64()
        .filter(|value| (*value > 0 || allow_zero) && *value <= i64::MAX as u64)
        .ok_or_else(|| format!("需要当前 {key}"))
}
pub(crate) fn handle(manager: &Manager, request: &Value) -> Result<Option<Value>, String> {
    let action = request["action"].as_str().unwrap_or_default();
    let allowed: &[&str] = match action {
        "resource_templates" => &["action", "id", "actionId"],
        "resource_template_save" => &[
            "action",
            "id",
            "actionId",
            "expectedResourceRevision",
            "templateId",
            "expectedRevision",
            "name",
            "parameters",
        ],
        "resource_template_remove" => {
            &["action", "id", "actionId", "templateId", "expectedRevision"]
        }
        "resource_template_prepare" => &[
            "action",
            "id",
            "actionId",
            "templateId",
            "expectedRevision",
            "expectedResourceRevision",
        ],
        _ => return Ok(None),
    };
    fields(request, allowed)?;
    let resource_id = text(request, "id", 64)?;
    let action_id = text(request, "actionId", 64)?;
    // Expensive executable verification occurs on a worker, before the live writer
    // rechecks revision and binding. This never launches a third-party process.
    let verified_binding = if matches!(
        action,
        "resource_template_save" | "resource_template_prepare"
    ) {
        let record: ResourceRecord = serde_json::from_value(
            manager.resource_store(crate::resources::StoreRequest::Get(resource_id.clone()))?,
        )
        .map_err(|e| e.to_string())?;
        if record.revision != expected(request, "expectedResourceRevision", false)? {
            return Err(CONFLICT.into());
        }
        let definition = resource_runtime::verified_definition(&record, &action_id)?;
        binding(&record, &definition)?
    } else {
        String::new()
    };
    let operation = match action {
        "resource_templates" => Operation::List,
        "resource_template_save" => {
            let template_id = if request.get("templateId").is_some() {
                Some(text(request, "templateId", 64)?)
            } else {
                None
            };
            let expected_revision = expected(request, "expectedRevision", true)?;
            if template_id.is_some() != (expected_revision > 0) {
                return Err("新模板省略 templateId 并使用修订号 0；编辑需要当前模板修订号".into());
            }
            Operation::Save {
                template_id,
                expected_revision,
                expected_resource_revision: expected(request, "expectedResourceRevision", false)?,
                name: text(request, "name", 80)?.trim().to_owned(),
                parameters: request["parameters"].clone(),
                verified_binding,
            }
        }
        "resource_template_remove" => Operation::Remove {
            template_id: text(request, "templateId", 64)?,
            expected_revision: expected(request, "expectedRevision", false)?,
        },
        "resource_template_prepare" => Operation::Prepare {
            template_id: text(request, "templateId", 64)?,
            expected_revision: expected(request, "expectedRevision", false)?,
            expected_resource_revision: expected(request, "expectedResourceRevision", false)?,
            verified_binding,
        },
        _ => unreachable!(),
    };
    Ok(Some(manager.template_store(StoreRequest {
        resource_id,
        action_id,
        operation,
    })?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier, Mutex};
    fn directory() -> tempfile::TempDir {
        let parent = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("work/invocation-template-tests");
        std::fs::create_dir_all(&parent).unwrap();
        tempfile::tempdir_in(parent).unwrap()
    }
    fn setup() -> (tempfile::TempDir, Manager, Value) {
        let dir = directory();
        let root = dir.path().join("tool");
        std::fs::create_dir(&root).unwrap();
        let executable = root.join("fixture.exe");
        std::fs::write(
            &executable,
            b"synthetic non-executable bytes; never launched",
        )
        .unwrap();
        let manager = Manager::new(dir.path().join("state")).unwrap();
        manager.save().unwrap();
        let record=crate::resources::handle(&manager,&json!({"action":"resource_register","name":"Fixture","kind":"cli","rootPath":root,"version":"1"})).unwrap().unwrap()["resource"].clone();
        let definition = json!({"id":"query","label":"Query","mode":"task","executable":executable,"workingDirectory":root,"args":[{"type":"parameter","name":"query"},{"type":"parameter","name":"count"},{"type":"parameter","name":"format"},{"type":"parameter","name":"password"},{"type":"parameter","name":"oneOff"},{"type":"parameter","name":"privateValue"}],"parameters":[{"name":"query","label":"Query","kind":"text","required":true,"maxLength":100,"templateAllowed":true},{"name":"count","label":"Count","kind":"integer","min":1,"max":10,"templateAllowed":true},{"name":"format","label":"Format","kind":"choice","choices":["json","text"],"templateAllowed":true},{"name":"password","label":"Password","kind":"text","templateAllowed":true},{"name":"oneOff","label":"One-off","kind":"text"},{"name":"privateValue","label":"Private","kind":"text","templateAllowed":true,"sensitive":true}]});
        let record=crate::resource_runtime::configure(&manager,&json!({"action":"resource_action_set","id":record["id"],"expectedRevision":record["revision"],"definition":definition})).unwrap().unwrap()["resource"].clone();
        (dir, manager, record)
    }
    fn call(manager: &Manager, request: Value) -> Value {
        handle(manager, &request).unwrap().unwrap()
    }
    fn list_request(record: &Value) -> Value {
        json!({"action":"resource_templates","id":record["id"],"actionId":"query"})
    }
    fn save(record: &Value, parameters: Value) -> Value {
        json!({"action":"resource_template_save","id":record["id"],"actionId":"query","expectedResourceRevision":record["revision"],"expectedRevision":0,"name":"Saved query","parameters":parameters})
    }
    fn prepare(record: &Value, saved: &Value, revision: u64) -> Value {
        json!({"action":"resource_template_prepare","id":record["id"],"actionId":"query","templateId":saved["templateId"],"expectedRevision":revision,"expectedResourceRevision":record["revision"]})
    }

    #[test]
    fn partial_templates_survive_restart_and_old_state_saves_without_exposing_values_in_list() {
        let (dir, manager, record) = setup();
        let before = manager.state.clone();
        let saved = call(&manager, save(&record, json!({"count":3,"format":"json"})));
        assert_eq!(
            saved["templates"][0]["parameterNames"],
            json!(["count", "format"])
        );
        assert_eq!(saved["templates"][0]["compatible"], true);
        assert!(saved["templates"][0].get("parameters").is_none());
        let prepared = call(&manager, prepare(&record, &saved, 1));
        assert_eq!(prepared["parameters"], json!({"count":3,"format":"json"}));
        assert_eq!(prepared["resourceRevision"], record["revision"]);
        assert!(manager.state == before);
        let revision = manager.snapshot()["stateRevision"].clone();
        assert_eq!(
            manager.resource_runtime.snapshot(None).unwrap()["runs"],
            json!([])
        );
        drop(manager);
        let reopened = Manager::new(dir.path().join("state")).unwrap();
        assert_eq!(reopened.snapshot()["stateRevision"], revision);
        reopened.save().unwrap();
        assert_eq!(call(&reopened, prepare(&record, &saved, 1)), prepared);
        assert_eq!(
            call(&reopened, list_request(&record))["templates"],
            saved["templates"]
        );
    }

    #[test]
    fn no_op_stale_and_failed_transaction_preserve_data_and_emit_only_real_commits() {
        let _network = crate::network::test_configuration_guard();
        let (dir, mut manager, record) = setup();
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        manager.set_state_events(Arc::new(move |revision| {
            sink.lock().unwrap().push(revision)
        }));
        let mut request = save(&record, json!({"query":"kept"}));
        let saved = call(&manager, request.clone());
        request["templateId"] = saved["templateId"].clone();
        request["expectedRevision"] = json!(1);
        assert_eq!(call(&manager, request.clone()), saved);
        assert_eq!(events.lock().unwrap().len(), 1);
        let snapshot = manager.snapshot();
        let db = Connection::open(dir.path().join("state/manager.sqlite3")).unwrap();
        db.execute_batch("CREATE TRIGGER fail_template_commit BEFORE UPDATE ON invocation_templates_meta BEGIN SELECT RAISE(ABORT,'synthetic template commit failure'); END;").unwrap();
        request["name"] = json!("Changed");
        assert!(handle(&manager, &request)
            .unwrap_err()
            .contains("synthetic template commit failure"));
        assert_eq!(
            call(&manager, list_request(&record))["templates"],
            saved["templates"]
        );
        assert_eq!(manager.snapshot(), snapshot);
        assert_eq!(events.lock().unwrap().len(), 1);
        db.execute_batch("DROP TRIGGER fail_template_commit")
            .unwrap();
        let changed = call(&manager, request.clone());
        assert_eq!(changed["templates"][0]["revision"], 2);
        assert!(handle(&manager, &request).is_err());
        assert!(handle(&manager, &prepare(&record, &saved, 1)).is_err());
        assert_eq!(
            call(&manager, prepare(&record, &saved, 2))["parameters"]["query"],
            "kept"
        );
        assert_eq!(events.lock().unwrap().len(), 2);
    }

    #[test]
    fn templates_reject_unselected_unknown_sensitive_and_invalid_values() {
        let (_dir, manager, record) = setup();
        for parameters in [
            json!({"password":"no"}),
            json!({"privateValue":"no"}),
            json!({"oneOff":"no"}),
            json!({"unknown":"no"}),
            json!({"count":0}),
            json!({"count":1.5}),
            json!({"format":"xml"}),
            json!({"query":"--execute"}),
            json!({"query":""}),
            json!({"query":"x".repeat(101)}),
            Value::Null,
            json!([]),
        ] {
            assert!(
                handle(&manager, &save(&record, parameters.clone())).is_err(),
                "accepted {parameters}"
            );
        }
        let mut unknown = save(&record, json!({}));
        unknown["command"] = json!("do not run");
        assert!(handle(&manager, &unknown).is_err());
        assert!(call(&manager, list_request(&record))["templates"]
            .as_array()
            .unwrap()
            .is_empty());
        // Missing required parameters are deliberate: the caller fills them at invocation.
        let empty = call(&manager, save(&record, json!({})));
        assert_eq!(
            call(&manager, prepare(&record, &empty, 1))["parameters"],
            json!({})
        );
        for name in [
            "password",
            "accessToken",
            "SECRET",
            "session-cookie",
            "authorization",
            "api_key",
            "privateKey",
            "access_key",
            "sessionKey",
            "pwd",
            "oauthCode",
            "passPhrase",
        ] {
            assert!(resource_runtime::sensitive_parameter_name(name), "{name}");
        }
        for name in ["query", "count", "format"] {
            assert!(!resource_runtime::sensitive_parameter_name(name));
        }
    }

    #[test]
    fn bound_root_version_and_full_action_changes_disable_old_templates() {
        let (dir, manager, record) = setup();
        let saved = call(&manager, save(&record, json!({"count":2})));
        let original: ResourceRecord = serde_json::from_value(record.clone()).unwrap();
        let mut current = original.clone();
        let other_root = dir.path().join("other");
        std::fs::create_dir(&other_root).unwrap();
        for variant in 0..5 {
            let mut changed = original.clone();
            changed.revision = current.revision + 1;
            match variant {
                0 => changed.version = Some("2".into()),
                1 => changed.root_path = other_root.to_string_lossy().into_owned(),
                2 => changed.actions[0]["parameters"][1]["max"] = json!(1),
                3 => changed.actions[0]["label"] = json!("New definition"),
                _ => changed.actions.clear(),
            }
            manager
                .resource_store(crate::resources::StoreRequest::Replace {
                    record: Box::new(changed.clone()),
                    expected_revision: current.revision,
                })
                .unwrap();
            let changed_value = serde_json::to_value(&changed).unwrap();
            let listed = call(&manager, list_request(&record));
            assert_eq!(
                listed["templates"][0]["compatible"], false,
                "variant {variant}"
            );
            assert!(listed["templates"][0]["reason"].is_string());
            assert!(handle(&manager, &prepare(&changed_value, &saved, 1)).is_err());
            current = changed;
        }
        // Even a removed action does not prevent explicitly deleting its stale template.
        let removed = call(
            &manager,
            json!({"action":"resource_template_remove","id":record["id"],"actionId":"query","templateId":saved["templateId"],"expectedRevision":1}),
        );
        assert_eq!(removed["templates"], json!([]));
        assert_eq!(
            manager.resource_runtime.snapshot(None).unwrap()["runs"],
            json!([])
        );
    }

    #[test]
    fn prepare_rechecks_actual_executable_without_launching_and_rejects_other_targets() {
        let (_dir, manager, record) = setup();
        let saved = call(&manager, save(&record, json!({"query":"inert"})));
        let mut wrong = prepare(&record, &saved, 1);
        wrong["expectedResourceRevision"] = json!(1);
        assert!(handle(&manager, &wrong).is_err());
        wrong = prepare(&record, &saved, 1);
        wrong["actionId"] = json!("other");
        assert!(handle(&manager, &wrong).is_err());
        let executable = record["actions"][0]["executable"].as_str().unwrap();
        std::fs::write(executable, b"changed synthetic entry").unwrap();
        assert!(handle(&manager, &prepare(&record, &saved, 1))
            .unwrap_err()
            .contains("入口内容已变化"));
        assert!(handle(&manager, &save(&record, json!({}))).is_err());
        assert_eq!(
            manager.resource_runtime.snapshot(None).unwrap()["runs"],
            json!([])
        );
    }

    #[test]
    fn task_system_uses_live_cas_for_concurrent_updates_and_preserves_winner() {
        let (_dir, manager, record) = setup();
        let saved = call(&manager, save(&record, json!({"query":"original"})));
        let service = crate::tasks::TaskSystem::new(manager).unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let threads: Vec<_> = ["First", "Second"]
            .into_iter()
            .map(|name| {
                let service = service.clone();
                let barrier = barrier.clone();
                let mut request = save(&record, json!({"query":name}));
                request["templateId"] = saved["templateId"].clone();
                request["expectedRevision"] = json!(1);
                std::thread::spawn(move || {
                    barrier.wait();
                    service.execute(request, crate::dispatch)
                })
            })
            .collect();
        barrier.wait();
        let outcomes: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
        let listed = service
            .execute(list_request(&record), crate::dispatch)
            .unwrap();
        assert_eq!(listed["templates"][0]["revision"], 2);
        assert!(service
            .execute(prepare(&record, &saved, 1), crate::dispatch)
            .is_err());
        let prepared = service
            .execute(prepare(&record, &saved, 2), crate::dispatch)
            .unwrap();
        assert!(["First", "Second"].contains(&prepared["parameters"]["query"].as_str().unwrap()));
        assert_eq!(
            service
                .execute(json!({"action":"resource_runtime"}), crate::dispatch)
                .unwrap()["runs"],
            json!([])
        );
    }

    #[test]
    fn basic_mode_reads_old_and_current_databases_without_creating_tables_or_writing() {
        let dir = directory();
        let db = Connection::open(dir.path().join("manager.sqlite3")).unwrap();
        db.execute_batch("CREATE TABLE app_state(id INTEGER PRIMARY KEY,payload TEXT NOT NULL);")
            .unwrap();
        db.execute(
            "INSERT INTO app_state VALUES(1,?1)",
            [json!({"skills":[],"sources":[],"connections":[],"settings":{}}).to_string()],
        )
        .unwrap();
        let basic =
            Manager::with_storage_mode(crate::storage::Storage::isolated(dir.path().into()), true)
                .unwrap();
        let request = json!({"action":"resource_templates","id":"old","actionId":"query"});
        assert_eq!(
            call(&basic, request),
            json!({"templates":[],"resourceRevision":0})
        );
        assert!(!table_exists(&db, "invocation_templates").unwrap());
        let (fixture, manager, record) = setup();
        let saved = call(&manager, save(&record, json!({"count":2})));
        drop(manager);
        let basic = Manager::with_storage_mode(
            crate::storage::Storage::isolated(fixture.path().join("state")),
            true,
        )
        .unwrap();
        let service = crate::tasks::TaskSystem::new(basic).unwrap();
        assert_eq!(
            service
                .execute(list_request(&record), crate::dispatch)
                .unwrap()["templates"],
            saved["templates"]
        );
        assert!(service
            .execute(save(&record, json!({"count":3})), crate::dispatch)
            .unwrap_err()
            .contains("基本模式"));
        assert!(service.execute(json!({"action":"resource_template_remove","id":record["id"],"actionId":"query","templateId":saved["templateId"],"expectedRevision":1}),crate::dispatch).is_err());
        assert_eq!(
            service
                .execute(prepare(&record, &saved, 1), crate::dispatch)
                .unwrap()["parameters"],
            json!({"count":2})
        );
    }
}
