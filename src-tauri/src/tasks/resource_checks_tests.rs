use super::*;
use crate::resource_checks::{
    CheckRecord, CheckSource, CheckTarget, ReleaseSummary, StoreRequest as CheckStore,
};
use crate::resources::{ResourceRecord, StoreRequest as Catalog};
use sha2::{Digest, Sha256};
use std::sync::{mpsc, OnceLock};

#[derive(Default)]
struct Gate {
    entered: bool,
    released: bool,
}
type Latch = Arc<(Mutex<Gate>, Condvar)>;
fn latches() -> &'static Mutex<HashMap<String, Latch>> {
    static VALUES: OnceLock<Mutex<HashMap<String, Latch>>> = OnceLock::new();
    VALUES.get_or_init(Default::default)
}
fn latch_key(root: &Path, action: &str) -> String {
    format!("{}:{action}", root.display())
}
fn gate_for(service: &TaskSystem, action: &str) -> Latch {
    let root = service.manager.lock().unwrap().data_dir.clone();
    let value = Arc::new((Mutex::new(Gate::default()), Condvar::new()));
    latches()
        .lock()
        .unwrap()
        .insert(latch_key(&root, action), value.clone());
    value
}
fn wait_entered(latch: &Latch) {
    let (mutex, changed) = &**latch;
    let state = mutex.lock().unwrap();
    let (state, timeout) = changed
        .wait_timeout_while(state, Duration::from_secs(5), |v| !v.entered)
        .unwrap();
    assert!(
        state.entered && !timeout.timed_out(),
        "synthetic dispatcher did not start"
    );
}
fn release(latch: &Latch) {
    let (mutex, changed) = &**latch;
    mutex.lock().unwrap().released = true;
    changed.notify_all();
}
fn hold(root: &Path, action: &str) -> Result<(), String> {
    let Some(latch) = latches()
        .lock()
        .unwrap()
        .get(&latch_key(root, action))
        .cloned()
    else {
        return Ok(());
    };
    let (mutex, changed) = &*latch;
    let mut state = mutex.lock().unwrap();
    state.entered = true;
    changed.notify_all();
    let (state, timeout) = changed
        .wait_timeout_while(state, Duration::from_secs(8), |v| !v.released)
        .map_err(|_| "synthetic latch poisoned")?;
    if timeout.timed_out() && !state.released {
        return Err("synthetic latch timeout".into());
    }
    Ok(())
}
fn resource(id: &str) -> ResourceRecord {
    ResourceRecord {
        id: id.into(),
        name: id.into(),
        kind: "cli".into(),
        root_path: format!("D:/synthetic/tasks-resource-check/{id}"),
        repository: Some("https://github.com/synthetic/tool".into()),
        version: Some("v1".into()),
        source_binding: Some(crate::resource_source::SourceBinding {
            repository: "https://github.com/synthetic/tool".into(),
            repository_id: 44,
            asset: None,
            verified_at: "2026-10-30T00:00:00Z".into(),
        }),
        source_history: vec![],
        alias: String::new(),
        notes: String::new(),
        enabled: true,
        ownership: "external".into(),
        management_scope: "register".into(),
        actions: vec![json!({"id":"synthetic","cancellable":true})],
        capabilities: vec![],
        update_policy: json!({"mode":"manual","intervalHours":24,"pinnedVersion":null,"skippedVersions":[]}),
        installation: None,
        revision: 1,
        created_at: String::new(),
        updated_at: String::new(),
    }
}
fn fixture(with_resources: bool) -> (tempfile::TempDir, Arc<TaskSystem>) {
    let parent = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("work/resource-check-task-tests");
    std::fs::create_dir_all(&parent).unwrap();
    let dir = tempfile::tempdir_in(parent).unwrap();
    let mut manager = Manager::new(dir.path().into()).unwrap();
    manager.state.skills = vec![
        json!({"id":"skill","name":"skill","repo":"synthetic/skill","branch":"main","runtimeFiles":["SKILL.md"],"status":"local_only"}),
    ];
    if with_resources {
        for id in ["one", "two"] {
            manager
                .resource_store(Catalog::Insert(Box::new(resource(id))))
                .unwrap();
        }
    }
    manager.save().unwrap();
    (dir, TaskSystem::new(manager).unwrap())
}
fn synthetic_dispatch(m: &mut Manager, request: &Value) -> Result<Value, String> {
    let action = request["action"].as_str().unwrap();
    if action == "resource_invoke" {
        return Ok(json!({"syntheticForeground":true,"startedProcess":false}));
    }
    let catalog = m.resource_store(Catalog::List)?;
    let records: Vec<ResourceRecord> =
        serde_json::from_value(catalog["resources"].clone()).map_err(|e| e.to_string())?;
    let key = format!(
        "{:x}",
        Sha256::digest(b"https://github.com/synthetic/tool\n44\nstable")
    );
    let previous = m.resource_check_store(CheckStore::Get(key.clone()))?;
    let revision = previous["revision"].as_u64().unwrap_or(0);
    hold(&m.data_dir, action)?;
    crate::network::check_cancelled()?;
    if action == "check_now" {
        return Ok(json!({"syntheticSkillCheck":true}));
    }
    let now = chrono::Utc::now();
    m.resource_check_store(CheckStore::Save {
        expected_revision: revision,
        record: Box::new(CheckRecord {
            source: CheckSource {
                key: key.clone(),
                repository: "https://github.com/synthetic/tool".into(),
                repository_id: 44,
                channel: "stable".into(),
                runtime_package: None,
            },
            revision: revision + 1,
            checked_at: now.to_rfc3339(),
            next_check_at: (now + chrono::Duration::hours(24)).to_rfc3339(),
            failures: 0,
            status: "checked".into(),
            message: "synthetic observation only".into(),
            latest: Some(ReleaseSummary {
                version: "v2".into(),
                url: "https://github.com/synthetic/tool/releases/tag/v2".into(),
                published_at: None,
                metadata_hash: None,
            }),
        }),
        targets: records
            .into_iter()
            .map(|r| CheckTarget {
                id: r.id,
                revision: r.revision,
                source_key: key.clone(),
            })
            .collect(),
    })
}
fn start_due(service: &Arc<TaskSystem>, dispatch: Dispatch) -> String {
    service
        .start(
            json!({"action":"__resource_version_due","automatic":true}),
            None,
            None,
            false,
            false,
            dispatch,
        )
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .into()
}
fn catalog(service: &TaskSystem) -> Value {
    service
        .manager
        .lock()
        .unwrap()
        .resource_store(Catalog::List)
        .unwrap()
}

#[test]
fn private_due_dispatch_runs_in_skill_manual_mode_and_public_dispatch_has_no_scheduler_route() {
    let (_dir, service) = fixture(false);
    service
        .execute(
            json!({"action":"set_check_mode","mode":"manual"}),
            crate::dispatch,
        )
        .unwrap();
    let before = catalog(&service);
    let task = start_due(&service, crate::resource_checks::dispatch_due);
    let result = service.wait(&task).unwrap();
    assert_eq!(result["checkedSources"], 0);
    assert_eq!(result["downloaded"], false);
    assert_eq!(result["applied"], false);
    assert!(service
        .execute(
            json!({"action":"__resource_version_due","automatic":true}),
            crate::dispatch
        )
        .is_err());
    assert_eq!(catalog(&service), before);
    assert_eq!(service.check_configuration().unwrap()["mode"], "manual");
}

#[test]
fn same_due_task_deduplicates_and_does_not_block_foreground_or_cancel_with_skill_checks() {
    let (_dir, service) = fixture(true);
    let before = catalog(&service);
    let tools = gate_for(&service, "__resource_version_due");
    let skills = gate_for(&service, "check_now");
    let task = start_due(&service, synthetic_dispatch);
    wait_entered(&tools);
    assert_eq!(start_due(&service, synthetic_dispatch), task);
    let skill = service
        .start(
            json!({"action":"check_now","automatic":true,"checkGeneration":0,"skillId":"skill"}),
            None,
            None,
            false,
            false,
            synthetic_dispatch,
        )
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    wait_entered(&skills);
    let (send, receive) = mpsc::channel();
    let active = service.clone();
    let foreground = std::thread::spawn(move || {
        let _ = send.send(active.execute(
            json!({"action":"resource_invoke","id":"one","actionId":"synthetic"}),
            synthetic_dispatch,
        ));
    });
    let result = receive.recv_timeout(Duration::from_secs(3));
    if result.is_err() {
        release(&tools);
        release(&skills);
    }
    let result = result
        .expect("version observation blocked foreground resource call")
        .unwrap();
    assert_eq!(result["startedProcess"], false);
    foreground.join().unwrap();
    service.cancel_automatic_skill_checks();
    assert_eq!(service.get(&skill, false).unwrap()["cancelRequested"], true);
    assert_eq!(service.get(&task, false).unwrap()["cancelRequested"], false);
    release(&skills);
    release(&tools);
    assert!(service.wait(&skill).is_err());
    let result = service.wait(&task).unwrap();
    assert_eq!(result["appliedIds"], json!(["one", "two"]));
    assert_eq!(catalog(&service), before);
    let checks = service
        .manager
        .lock()
        .unwrap()
        .resource_check_store(CheckStore::List)
        .unwrap();
    assert_eq!(checks["checks"].as_array().unwrap().len(), 1);
}

#[test]
fn queued_due_work_rechecks_maintenance_before_dispatch_and_live_writer_rechecks_before_save() {
    let (_dir, service) = fixture(true);
    let latch = gate_for(&service, "__resource_version_due");
    service.scheduler.lock().unwrap().active.insert(
        "synthetic-blocker".into(),
        vec![Resource {
            key: "resource-version-checks".into(),
            write: true,
        }],
    );
    let task = start_due(&service, synthetic_dispatch);
    service
        .execute(
            json!({"action":"set_maintenance","expectedRevision":0,"pause":"manual"}),
            crate::dispatch,
        )
        .unwrap();
    service
        .scheduler
        .lock()
        .unwrap()
        .active
        .remove("synthetic-blocker");
    service.wake.notify_all();
    assert!(service.wait(&task).unwrap_err().contains("暂停"));
    assert!(!latch.0.lock().unwrap().entered);
    service
        .execute(
            json!({"action":"set_maintenance","expectedRevision":1,"pause":"resume"}),
            crate::dispatch,
        )
        .unwrap();
    let latch = gate_for(&service, "__resource_version_due");
    let task = start_due(&service, synthetic_dispatch);
    wait_entered(&latch);
    service
        .execute(
            json!({"action":"set_maintenance","expectedRevision":2,"pause":"manual"}),
            crate::dispatch,
        )
        .unwrap();
    release(&latch);
    assert!(service.wait(&task).unwrap_err().contains("暂停"));
    assert!(service
        .manager
        .lock()
        .unwrap()
        .resource_check_store(CheckStore::List)
        .unwrap()["checks"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn worker_source_compare_and_swap_cannot_publish_pre_rebind_success_as_current_source() {
    let (_dir, service) = fixture(true);
    let latch = gate_for(&service, "__resource_version_due");
    let task = start_due(&service, synthetic_dispatch);
    wait_entered(&latch);
    {
        let manager = service.manager.lock().unwrap();
        for id in ["one", "two"] {
            let mut changed: ResourceRecord =
                serde_json::from_value(manager.resource_store(Catalog::Get(id.into())).unwrap())
                    .unwrap();
            changed.repository = Some("https://github.com/synthetic/new".into());
            changed.source_binding.as_mut().unwrap().repository =
                "https://github.com/synthetic/new".into();
            changed.source_binding.as_mut().unwrap().repository_id = 55;
            changed.revision = 2;
            manager
                .resource_store(Catalog::Replace {
                    record: Box::new(changed),
                    expected_revision: 1,
                })
                .unwrap();
        }
    }
    let before = catalog(&service);
    release(&latch);
    let result = service.wait(&task).unwrap();
    assert_eq!(result["stale"], true);
    assert_eq!(result["appliedIds"], json!([]));
    assert_eq!(catalog(&service), before);
    let manager = service.manager.lock().unwrap();
    assert!(
        manager.resource_check_store(CheckStore::List).unwrap()["checks"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let status = crate::resource_checks::handle(
        &manager,
        &json!({"action":"resource_version_check_status","id":"one"}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(status["status"], "notChecked");
    assert!(status["check"].is_null());
}
