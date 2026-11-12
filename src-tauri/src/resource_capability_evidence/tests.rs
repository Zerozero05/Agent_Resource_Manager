use super::*;
use std::{
    fs,
    sync::Arc,
    time::{Duration, Instant},
};

fn fixture() -> tempfile::TempDir {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("work/resource-capability-evidence-tests");
    fs::create_dir_all(&root).unwrap();
    tempfile::tempdir_in(root).unwrap()
}
fn setup(
    mode: &str,
    own_entry: bool,
) -> (tempfile::TempDir, Arc<crate::tasks::TaskSystem>, String) {
    let fixture = fixture();
    let root = fixture.path().join("tool");
    fs::create_dir(&root).unwrap();
    let executable = if own_entry {
        let entry = root.join("synthetic-evidence.exe");
        fs::hard_link(std::env::current_exe().unwrap(), &entry).unwrap();
        entry
    } else {
        std::env::current_exe().unwrap()
    };
    let service =
        crate::tasks::TaskSystem::new(Manager::new(fixture.path().join("state")).unwrap()).unwrap();
    let saved=service.execute(json!({"action":"resource_register","name":"Synthetic evidence fixture","kind":"cli","rootPath":root,"version":"v1"}),crate::dispatch).unwrap();
    let id = saved["resource"]["id"].as_str().unwrap().to_owned();
    service.execute(json!({"action":"resource_action_set","id":id,"expectedRevision":1,"definition":{"id":"check","label":"Synthetic check","mode":mode,"cancellable":true,"executable":executable,"workingDirectory":root,"timeoutSeconds":10,
        "args":[{"type":"literal","value":"--exact"},{"type":"literal","value":"resource_capability_evidence::tests::synthetic_owned_task"},{"type":"literal","value":"--ignored"},{"type":"literal","value":"--nocapture"},{"type":"literal","value":"--skip"},{"type":"parameter","name":"payload"}],
        "parameters":[{"name":"payload","label":"Test value","kind":"text","required":true,"sensitive":true}]}}),crate::dispatch_local).unwrap();
    (fixture, service, id)
}
fn invoke(service: &Arc<crate::tasks::TaskSystem>, id: &str, payload: &str) -> Value {
    service.execute(json!({"action":"resource_invoke","id":id,"actionId":"check","parameters":{"payload":payload}}),crate::dispatch).unwrap()
}
fn status(service: &Arc<crate::tasks::TaskSystem>, id: &str) -> Value {
    service
        .execute(
            json!({"action":"resource_capability_evidence","resourceId":id}),
            crate::dispatch,
        )
        .unwrap()
}
fn live(service: &Arc<crate::tasks::TaskSystem>, id: &str) -> ResourceRecord {
    fn dispatch(m: &mut Manager, request: &Value) -> Result<Value, String> {
        m.resource_store(Catalog::Get(request["id"].as_str().unwrap().into()))
    }
    serde_json::from_value(
        service
            .execute(
                json!({"action":"synthetic_read_resource","id":id}),
                dispatch,
            )
            .unwrap(),
    )
    .unwrap()
}
fn fixture_record_change(
    service: &Arc<crate::tasks::TaskSystem>,
    id: &str,
    field: &str,
    value: Value,
) {
    fn dispatch(m: &mut Manager, request: &Value) -> Result<Value, String> {
        let record = m.resource_store(Catalog::Get(request["id"].as_str().unwrap().into()))?;
        let mut value = record;
        value[request["field"].as_str().unwrap()] = request["value"].clone();
        let mut changed: ResourceRecord =
            serde_json::from_value(value).map_err(|e| e.to_string())?;
        let expected_revision = changed.revision;
        changed.revision += 1;
        changed.updated_at = now();
        m.resource_store(Catalog::Replace {
            record: Box::new(changed),
            expected_revision,
        })
    }
    service
        .execute(
            json!({"action":"synthetic_change_resource","id":id,"field":field,"value":value}),
            dispatch,
        )
        .unwrap();
}

#[test]
#[ignore = "Only an isolated subprocess fixture explicitly invoked by TaskSystem tests"]
fn synthetic_owned_task() {
    println!("PRIVATE_OUTPUT_NEVER_IN_CAPABILITY_EVIDENCE");
    eprintln!("PRIVATE_ERROR_OUTPUT_NEVER_IN_CAPABILITY_EVIDENCE");
    if std::env::args().any(|value| value == "PRIVATE_PARAMETER_FAILURE") {
        std::process::exit(7);
    }
}

#[test]
fn actual_task_exit_persists_scoped_version_entry_time_without_parameters_or_output() {
    let (fixture, service, id) = setup("task", false);
    let before = live(&service, &id);
    let result = invoke(&service, &id, "PRIVATE_PARAMETER_SUCCESS");
    assert_eq!(result["run"]["status"], "succeeded");
    let observed = status(&service, &id);
    assert_eq!(observed["actions"][0]["status"], "passed");
    assert_eq!(observed["actions"][0]["latest"]["version"], "v1");
    assert_eq!(
        observed["actions"][0]["latest"]["scope"],
        "registeredTaskExit"
    );
    assert_eq!(observed["actions"][0]["latest"]["exitCode"], 0);
    assert_eq!(
        path_key(Path::new(
            observed["actions"][0]["latest"]["entryPath"]
                .as_str()
                .unwrap()
        )),
        path_key(&std::env::current_exe().unwrap())
    );
    assert!(chrono::DateTime::parse_from_rfc3339(
        observed["actions"][0]["latest"]["finishedAt"]
            .as_str()
            .unwrap()
    )
    .is_ok());
    assert_eq!(observed["platformCallsVerified"], false);
    assert_eq!(observed["userSessionVerified"], false);
    assert_eq!(observed["outputStored"], false);
    assert_eq!(observed["parametersStored"], false);
    assert_eq!(live(&service, &id).revision, before.revision);
    let db = Connection::open(fixture.path().join("state/manager.sqlite3")).unwrap();
    let payload: String = db
        .query_row(
            "SELECT payload FROM resource_capability_evidence",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!payload.contains("PRIVATE_PARAMETER"));
    assert!(!payload.contains("PRIVATE_OUTPUT"));
    assert!(!payload.contains("PRIVATE_ERROR_OUTPUT"));
    assert!(!payload.contains("parameters"));
    assert!(!payload.contains("stdout"));
    drop(db);
    drop(service);
    let m = Manager::new(fixture.path().join("state")).unwrap();
    let reloaded = read(&m, &id).unwrap();
    assert_eq!(reloaded["actions"][0]["status"], "passed");
    assert_eq!(reloaded["total"], 1);
}

#[test]
fn later_real_nonzero_exit_replaces_current_success_and_preserves_both_historical_results() {
    let (_fixture, service, id) = setup("task", false);
    invoke(&service, &id, "PRIVATE_PARAMETER_SUCCESS");
    let failed = invoke(&service, &id, "PRIVATE_PARAMETER_FAILURE");
    assert_eq!(failed["run"]["status"], "failed");
    assert_eq!(failed["run"]["exitCode"], 7);
    let observed = status(&service, &id);
    assert_eq!(observed["actions"][0]["status"], "failed");
    assert_eq!(observed["actions"][0]["latest"]["exitCode"], 7);
    assert_eq!(observed["total"], 2);
    assert!(observed["history"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["processStatus"] == "succeeded"));
}

#[test]
fn alias_notes_display_name_and_action_label_changes_do_not_invalidate_actual_execution() {
    let (_fixture, service, id) = setup("task", false);
    invoke(&service, &id, "PRIVATE_PARAMETER_SUCCESS");
    let current = live(&service, &id);
    service.execute(json!({"action":"resource_update","id":id,"expectedRevision":current.revision,"changes":{"name":"Renamed display","alias":"Personal alias","notes":"Personal notes"}}),crate::dispatch).unwrap();
    let current = live(&service, &id);
    let mut action = current.actions[0].clone();
    action["label"] = json!("Updated display label");
    action["parameters"][0]["label"] = json!("Updated input label");
    service.execute(json!({"action":"resource_action_set","id":id,"expectedRevision":current.revision,"definition":action}),crate::dispatch_local).unwrap();
    let observed = status(&service, &id);
    assert_eq!(observed["actions"][0]["status"], "passed");
    assert_eq!(observed["actions"][0]["label"], "Updated display label");
    assert_eq!(observed["total"], 1);
}

#[test]
fn relevant_source_version_or_definition_changes_keep_old_results_as_stale_history() {
    let (_fixture, service, id) = setup("task", false);
    invoke(&service, &id, "PRIVATE_PARAMETER_SUCCESS");
    fixture_record_change(
        &service,
        &id,
        "repository",
        json!("https://github.com/synthetic/changed-source"),
    );
    assert_eq!(status(&service, &id)["actions"][0]["status"], "stale");
    fixture_record_change(&service, &id, "repository", Value::Null);
    assert_eq!(status(&service, &id)["actions"][0]["status"], "stale");
    invoke(&service, &id, "PRIVATE_PARAMETER_SUCCESS");
    assert_eq!(status(&service, &id)["actions"][0]["status"], "passed");
    fixture_record_change(&service, &id, "version", json!("v2"));
    let observed = status(&service, &id);
    assert_eq!(observed["actions"][0]["status"], "stale");
    assert_eq!(observed["actions"][0]["latest"]["version"], "v1");
    fixture_record_change(&service, &id, "version", json!("v1"));
    assert_eq!(status(&service, &id)["actions"][0]["status"], "stale");
    invoke(&service, &id, "PRIVATE_PARAMETER_SUCCESS");
    let current = live(&service, &id);
    let mut action = current.actions[0].clone();
    action["timeoutSeconds"] = json!(9);
    service.execute(json!({"action":"resource_action_set","id":id,"expectedRevision":current.revision,"definition":action}),crate::dispatch_local).unwrap();
    assert_eq!(status(&service, &id)["actions"][0]["status"], "stale");
}

#[test]
fn same_path_entry_replacement_does_not_reuse_old_execution_evidence() {
    let (fixture, service, id) = setup("task", true);
    invoke(&service, &id, "PRIVATE_PARAMETER_SUCCESS");
    let entry = fixture.path().join("tool/synthetic-evidence.exe");
    fs::remove_file(&entry).unwrap();
    fs::write(&entry, "new unverified executable bytes").unwrap();
    let observed = status(&service, &id);
    assert_eq!(observed["actions"][0]["status"], "stale");
    assert_eq!(observed["total"], 1);
    assert!(observed["actions"][0]["reason"]
        .as_str()
        .unwrap()
        .contains("摘要"));
}

#[test]
fn even_a_successfully_exited_service_is_not_a_task_or_platform_capability_pass() {
    let (_fixture, service, id) = setup("service", false);
    let result = invoke(&service, &id, "PRIVATE_PARAMETER_SUCCESS");
    let run_id = &result["run"]["runId"];
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let result = service
            .execute(
                json!({"action":"resource_result","runId":run_id}),
                crate::dispatch,
            )
            .unwrap();
        if result["run"]["status"] != "running" {
            assert_eq!(result["run"]["status"], "succeeded");
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(20));
    }
    let observed = status(&service, &id);
    assert_eq!(observed["actions"][0]["status"], "unverified");
    assert_eq!(observed["total"], 0);
}

#[test]
fn evidence_database_write_failure_does_not_change_the_actual_successful_process_result() {
    let (fixture, service, id) = setup("task", false);
    let db = Connection::open(fixture.path().join("state/manager.sqlite3")).unwrap();
    db.execute_batch("CREATE TRIGGER synthetic_evidence_rejection BEFORE INSERT ON resource_capability_evidence BEGIN SELECT RAISE(ABORT,'synthetic evidence failure'); END;").unwrap();
    let result = invoke(&service, &id, "PRIVATE_PARAMETER_SUCCESS");
    assert_eq!(result["run"]["status"], "succeeded");
    assert_eq!(result["run"]["exitCode"], 0);
    assert!(result["capabilityEvidenceWarning"]
        .as_str()
        .is_some_and(|reason| reason.contains("synthetic evidence failure")));
    assert_eq!(status(&service, &id)["total"], 0);
}

#[test]
fn caller_success_flags_and_unknown_run_ids_cannot_create_evidence() {
    let (_fixture, service, id) = setup("task", false);
    assert!(service
        .execute(
            json!({"action":"resource_capability_evidence","resourceId":id,"verified":true}),
            crate::dispatch
        )
        .is_err());
    assert!(service.execute(json!({"action":"resource_capability_observe","resourceId":id,"runId":"forged","exitCode":0}),crate::dispatch).is_err());
    assert_eq!(status(&service, &id)["total"], 0);
}

#[test]
fn a_late_observation_of_an_older_process_never_displaces_the_newer_completion() {
    let db = Connection::open_in_memory().unwrap();
    initialize(&db).unwrap();
    let evidence = |id: &str, time: &str| ExecutionEvidence {
        run_id: id.into(),
        resource_id: "fixture".into(),
        action_id: "one".into(),
        version: Some("v1".into()),
        root_path: "D:/synthetic".into(),
        entry_path: "D:/synthetic/entry.exe".into(),
        scope: "registeredTaskExit".into(),
        started_at: "2026-10-30T00:00:00+00:00".into(),
        finished_at: time.into(),
        process_status: "succeeded".into(),
        exit_code: Some(0),
        completion_kind: CompletionKind::ProcessExit,
        protocol: None,
        epoch: 0,
        binding: Binding {
            definition_hash: "a".repeat(64),
            file_binding_hash: "b".repeat(64),
            source_hash: "c".repeat(64),
            binding_hash: "d".repeat(64),
        },
    };
    store(
        &db,
        StoreRequest::Observe(Box::new(evidence("newer", "2026-10-30T00:00:02+00:00"))),
    )
    .unwrap();
    let older = evidence("older", "2026-10-30T00:00:01+00:00");
    store(&db, StoreRequest::Observe(Box::new(older.clone()))).unwrap();
    let again = store(&db, StoreRequest::Observe(Box::new(older))).unwrap();
    assert_eq!(again["alreadyRecorded"], true);
    let observed = store(
        &db,
        StoreRequest::List {
            resource_id: "fixture".into(),
        },
    )
    .unwrap();
    assert_eq!(observed["latest"][0]["runId"], "newer");
    assert_eq!(observed["total"], 2);
}

fn metadata_record() -> ResourceRecord {
    serde_json::from_value(json!({"id":"metadata-fixture","name":"Fixture","kind":"cli","rootPath":"D:/synthetic/first","repository":null,"version":"v1","alias":"","notes":"","enabled":true,"ownership":"external","managementScope":"invoke","actions":[{"id":"one","label":"Display label","mode":"task","executable":"D:/synthetic/first/entry.exe","workingDirectory":"D:/synthetic/first","args":[],"parameters":[]}],"capabilities":[],"updatePolicy":{"mode":"manual","intervalHours":24,"pinnedVersion":null,"skippedVersions":[]},"installation":null,"revision":1,"createdAt":"","updatedAt":""})).unwrap()
}

#[test]
fn invalidation_epoch_is_transactional_and_ignores_display_and_maintenance_policy_changes() {
    let db = Connection::open_in_memory().unwrap();
    initialize(&db).unwrap();
    let before = metadata_record();
    let mut after = before.clone();
    after.name = "Display rename".into();
    after.alias = "Alias".into();
    after.notes = "Notes".into();
    after.update_policy = json!({"mode":"automatic","intervalHours":24,"pinnedVersion":"v1","skippedVersions":["v2"]});
    after.actions[0]["label"] = json!("New label");
    after.actions[0]["idleTimeoutSeconds"] = json!(0);
    transition(&db, &before, &after).unwrap();
    assert_eq!(epoch(&db, &before.id).unwrap(), 0);
    let mut changed = after.clone();
    changed.version = Some("v2".into());
    {
        let transaction = db.unchecked_transaction().unwrap();
        transition(&transaction, &after, &changed).unwrap();
        assert_eq!(epoch(&transaction, &before.id).unwrap(), 1);
    }
    assert_eq!(
        epoch(&db, &before.id).unwrap(),
        0,
        "rolled-back catalog transaction must not invalidate evidence independently"
    );
    let transaction = db.unchecked_transaction().unwrap();
    transition(&transaction, &after, &changed).unwrap();
    transaction.commit().unwrap();
    assert_eq!(epoch(&db, &before.id).unwrap(), 1);
    transition(&db, &changed, &after).unwrap();
    assert_eq!(
        epoch(&db, &before.id).unwrap(),
        2,
        "restoring an old value must not restore its old pass"
    );
}

#[test]
fn basic_reads_of_an_older_database_do_not_create_evidence_or_epoch_tables() {
    let db = Connection::open_in_memory().unwrap();
    let before: u64 = db
        .query_row("SELECT COUNT(*) FROM sqlite_master", [], |row| row.get(0))
        .unwrap();
    let value = store(
        &db,
        StoreRequest::List {
            resource_id: "missing".into(),
        },
    )
    .unwrap();
    assert_eq!(value["total"], 0);
    assert_eq!(value["tableAvailable"], false);
    assert_eq!(
        store(
            &db,
            StoreRequest::Epoch {
                resource_id: "missing".into()
            }
        )
        .unwrap()["epoch"],
        0
    );
    let after: u64 = db
        .query_row("SELECT COUNT(*) FROM sqlite_master", [], |row| row.get(0))
        .unwrap();
    assert_eq!(after, before);
}

#[test]
fn fixed_script_content_is_bound_but_arbitrary_configuration_and_parameter_values_are_not_read() {
    let dir = fixture();
    let root = dir.path().join("tool");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("entry.py"), "print('first')").unwrap();
    fs::write(root.join("private.json"), "PRIVATE_CREDENTIAL_CONTENT").unwrap();
    let mut record = metadata_record();
    record.root_path = root.to_string_lossy().into_owned();
    let value = json!({"id":"one","label":"Fixture","mode":"task","executable":std::env::current_exe().unwrap(),"workingDirectory":root,"args":[{"type":"literal","value":"entry.py"},{"type":"literal","value":"private.json"}],"parameters":[],"executableSha256":resource_files::fingerprint(&std::env::current_exe().unwrap()).unwrap().sha256});
    let definition: ActionDefinition = serde_json::from_value(value).unwrap();
    let initial = binding(&record, &definition).unwrap();
    fs::write(
        root.join("private.json"),
        "DIFFERENT_PRIVATE_CREDENTIAL_CONTENT",
    )
    .unwrap();
    assert_eq!(binding(&record, &definition).unwrap(), initial);
    fs::write(root.join("entry.py"), "print('second')").unwrap();
    let changed = binding(&record, &definition).unwrap();
    assert_eq!(changed.definition_hash, initial.definition_hash);
    assert_ne!(changed.file_binding_hash, initial.file_binding_hash);
}

#[test]
fn legacy_process_rows_default_to_process_completion_and_protocol_is_a_content_free_whitelist() {
    let legacy = json!({"runId":"legacy","resourceId":"fixture","actionId":"check","version":"v1","rootPath":"D:/synthetic","entryPath":"D:/synthetic/entry.exe","scope":"registeredTaskExit","startedAt":"2026-10-30T00:00:00Z","finishedAt":"2026-10-30T00:00:01Z","processStatus":"succeeded","exitCode":0,"binding":{"definitionHash":"a","fileBindingHash":"b","sourceHash":"c","bindingHash":"d"}});
    let evidence: ExecutionEvidence = serde_json::from_value(legacy).unwrap();
    assert_eq!(evidence.completion_kind, CompletionKind::ProcessExit);
    assert!(evidence.protocol.is_none());
    let raw = json!({"protocolEvidence":{"method":"tools/call","toolName":"browser_tabs","protocolVersion":"2025-11-25","rpcResultReceived":true,"isError":false,"jsonRpcError":false,"sessionId":"PRIVATE_CONNECTION","arguments":{"cookie":"PRIVATE_COOKIE"},"content":"PRIVATE_PAGE"}});
    let protocol = protocol_evidence(&raw);
    let serialized = serde_json::to_string(&protocol).unwrap();
    assert!(!serialized.contains("PRIVATE_"));
    assert!(!serialized.contains("sessionId"));
    assert!(!serialized.contains("arguments"));
    assert!(!serialized.contains("content"));
    assert_eq!(protocol.tool_name.as_deref(), Some("browser_tabs"));
    let malformed = protocol_evidence(
        &json!({"protocolEvidence":{"method":"unapproved","toolName":"browser_evaluate","protocolVersion":"PRIVATE_TOKEN","rpcResultReceived":"true","isError":"false","jsonRpcError":"false"}}),
    );
    assert!(malformed.method.is_none());
    assert!(malformed.tool_name.is_none());
    assert!(malformed.protocol_version.is_none());
    assert!(!malformed.rpc_result_received);
    assert!(malformed.is_error.is_none());
    assert!(malformed.json_rpc_error);
}

#[cfg(windows)]
fn mcp_invoke(service: &Arc<crate::tasks::TaskSystem>, id: &str, action: &str) -> Value {
    service
        .execute(
            json!({"action":"resource_invoke","id":id,"actionId":action,"parameters":{}}),
            crate::dispatch,
        )
        .unwrap()
}

#[cfg(windows)]
fn stop_mcp_fixture(service: &Arc<crate::tasks::TaskSystem>, result: &Value) {
    service
        .execute(
            json!({"action":"resource_stop","runId":result["run"]["sessionId"]}),
            crate::dispatch,
        )
        .unwrap();
}

#[cfg(windows)]
fn mcp_status<'a>(observed: &'a Value, action: &str) -> &'a Value {
    observed["actions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["actionId"] == action)
        .unwrap()
}

#[cfg(windows)]
#[test]
fn actual_mcp_tasks_persist_only_their_exact_protocol_result_and_keep_service_start_unverified() {
    let (dir, service, id) = crate::resource_runtime::mcp_fixture("good");
    let tabs = mcp_invoke(&service, &id, "edge-tabs");
    let snapshot = mcp_invoke(&service, &id, "edge-snapshot");
    stop_mcp_fixture(&service, &snapshot);
    let observed = status(&service, &id);
    assert_eq!(observed["scope"], "ownedActionCompletion");
    assert_eq!(observed["total"], 2);
    for (action, tool, result) in [
        ("edge-tabs", "browser_tabs", tabs),
        ("edge-snapshot", "browser_snapshot", snapshot),
    ] {
        assert!(
            result.get("capabilityEvidenceWarning").is_none(),
            "{result:?}"
        );
        let action = mcp_status(&observed, action);
        assert_eq!(action["status"], "passed");
        assert_eq!(action["latest"]["completionKind"], "mcpToolCall");
        assert_eq!(action["latest"]["scope"], "mcpToolCall");
        assert!(action["latest"]["exitCode"].is_null());
        assert_eq!(action["latest"]["protocol"]["method"], "tools/call");
        assert_eq!(action["latest"]["protocol"]["toolName"], tool);
        assert_eq!(
            action["latest"]["protocol"]["protocolVersion"],
            "2025-11-25"
        );
        assert_eq!(action["latest"]["protocol"]["rpcResultReceived"], true);
        assert_eq!(action["latest"]["protocol"]["isError"], false);
        assert_eq!(action["latest"]["protocol"]["jsonRpcError"], false);
        assert_eq!(action["latest"]["version"], "0.0.83");
        assert!(chrono::DateTime::parse_from_rfc3339(
            action["latest"]["finishedAt"].as_str().unwrap()
        )
        .is_ok());
    }
    assert_eq!(
        mcp_status(&observed, "edge-version")["status"],
        "unverified"
    );
    let db = Connection::open(dir.path().join("state/manager.sqlite3")).unwrap();
    let values: Vec<String> = db
        .prepare("SELECT payload FROM resource_capability_evidence")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(values.len(), 2);
    for value in values {
        assert!(!value.contains("SYNTHETIC_MCP_PRIVATE_NOT_FOR_DB"));
        assert!(!value.contains("sessionId"));
        assert!(!value.contains("parameters"));
        assert!(!value.contains("content"));
        assert!(!value.contains("stdout"));
    }
}

#[cfg(windows)]
#[test]
fn actual_tool_errors_handshake_rejection_and_exit_zero_are_persisted_as_failed_mcp_calls() {
    for mode in [
        "tool-error",
        "rpc-error",
        "bad-version",
        "bad-format",
        "exit-zero",
    ] {
        let (_dir, service, id) = crate::resource_runtime::mcp_fixture(mode);
        let result = mcp_invoke(&service, &id, "edge-tabs");
        stop_mcp_fixture(&service, &result);
        assert_eq!(result["run"]["status"], "failed", "{mode}");
        assert!(
            result.get("capabilityEvidenceWarning").is_none(),
            "{mode}: {result:?}"
        );
        let observed = status(&service, &id);
        let action = mcp_status(&observed, "edge-tabs");
        assert_eq!(action["status"], "failed", "{mode}");
        assert_eq!(action["latest"]["completionKind"], "mcpToolCall", "{mode}");
        assert!(action["latest"]["exitCode"].is_null());
        assert_eq!(observed["total"], 1);
        assert_eq!(
            mcp_status(&observed, "edge-snapshot")["status"],
            "unverified"
        );
    }
}

#[cfg(windows)]
#[test]
fn current_protocol_binding_rejects_wrong_tools_or_unnegotiated_success_and_script_change_is_stale()
{
    let (dir, service, id) = crate::resource_runtime::mcp_fixture("good");
    let result = mcp_invoke(&service, &id, "edge-tabs");
    stop_mcp_fixture(&service, &result);
    let observed = status(&service, &id);
    let actual = mcp_status(&observed, "edge-tabs")["latest"].clone();
    let evidence: ExecutionEvidence = serde_json::from_value(actual).unwrap();
    let definition: ActionDefinition = serde_json::from_value(
        live(&service, &id)
            .actions
            .into_iter()
            .find(|action| action["id"] == "edge-tabs")
            .unwrap(),
    )
    .unwrap();
    assert_eq!(completion_status(&definition, &evidence).0, "passed");
    for change in [
        json!({"protocolVersion":"2099-01-01"}),
        json!({"toolName":"browser_snapshot"}),
        json!({"method":null}),
        json!({"rpcResultReceived":false}),
        json!({"isError":true}),
        json!({"jsonRpcError":true}),
    ] {
        let mut changed = evidence.clone();
        let mut protocol = json!(changed.protocol);
        for (key, value) in change.as_object().unwrap() {
            protocol[key] = value.clone();
        }
        changed.protocol = Some(serde_json::from_value(protocol).unwrap());
        assert_eq!(completion_status(&definition, &changed).0, "failed");
    }
    let mut wrong_kind = evidence.clone();
    wrong_kind.completion_kind = CompletionKind::ProcessExit;
    wrong_kind.exit_code = Some(0);
    assert_eq!(completion_status(&definition, &wrong_kind).0, "failed");
    let mut timed_out = evidence.clone();
    timed_out.process_status = "timed_out".into();
    timed_out.protocol.as_mut().unwrap().protocol_version = None;
    assert_eq!(completion_status(&definition, &timed_out).0, "failed");
    let cli = dir.path().join("edge/node_modules/@playwright/mcp/cli.js");
    let mut bytes = fs::read(&cli).unwrap();
    bytes.extend_from_slice(b"\n// synthetic changed entry\n");
    fs::write(cli, bytes).unwrap();
    let stale = status(&service, &id);
    assert_eq!(mcp_status(&stale, "edge-tabs")["status"], "stale");
    assert_eq!(stale["total"], 1);
    assert_eq!(stale["history"][0]["protocol"]["toolName"], "browser_tabs");
}
