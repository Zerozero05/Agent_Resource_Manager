use super::*;

fn fixture() -> (tempfile::TempDir, Arc<TaskSystem>) {
    let parent = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("work/task-automation-tests");
    std::fs::create_dir_all(&parent).unwrap();
    let root = tempfile::tempdir_in(parent).unwrap();
    let service = TaskSystem::new(Manager::new(root.path().join("state")).unwrap()).unwrap();
    (root, service)
}

#[test]
fn public_dispatch_and_tasks_cannot_forge_an_automatic_update_context() {
    let (_root, service) = fixture();
    let before = service.snapshot().unwrap();
    for request in [
        json!({"action":"resource_list","automation":{},"automatic":true}),
        json!({"action":"apply_resource_update_switch","previewId":"invented","automation":{"resourceId":"tool","grantRevision":1,"version":"v2"},"automatic":true}),
        json!({"action":"apply_resource_package_materialize","previewId":"invented","automation":{"resourceId":"tool","grantRevision":1,"version":"0.0.83"},"automatic":true}),
        json!({"action":"apply_resource_package_commit","previewId":"invented","automation":{"resourceId":"tool","grantRevision":1,"version":"0.0.83"},"automatic":true}),
        json!({"action":"__resource_automation_scan","automatic":true}),
        json!({"action":"__resource_automation_finish","automatic":true,"status":"completed"}),
    ] {
        let error = service
            .execute(request.clone(), crate::dispatch)
            .unwrap_err();
        assert!(error.contains("内部调度"), "{error}");
        let error = service
            .execute(request.clone(), crate::dispatch_local)
            .unwrap_err();
        assert!(error.contains("内部调度"), "{error}");
        let mut manager = service.manager.lock().unwrap();
        assert!(crate::dispatch(&mut manager, &request)
            .unwrap_err()
            .contains("内部调度"));
        assert!(crate::dispatch_local(&mut manager, &request)
            .unwrap_err()
            .contains("内部调度"));
    }
    assert_eq!(before, service.snapshot().unwrap());
    assert!(service.list().unwrap().is_empty());
}

#[test]
fn only_internal_result_recording_can_finish_after_a_maintenance_pause() {
    let (_root, service) = fixture();
    let mut manager = service.manager.lock().unwrap();
    manager.state.settings["maintenance"] =
        json!({"revision":1,"pausedManually":true,"pauseUntil":null,"window":null});
    let finish = json!({"action":"__resource_automation_finish","automatic":true});
    assert!(ensure_task_allowed(&manager, &finish, true).is_ok());
    assert!(validate_task_automatic(&manager.state, &finish, true).is_ok());
    assert!(validate_task_automatic(&manager.state, &finish, false).is_err());
    assert!(validate_task_automatic(
        &manager.state,
        &json!({"action":"apply_resource_update_switch","automatic":true}),
        true
    )
    .is_err());
    manager.basic_mode = true;
    assert!(ensure_task_allowed(&manager, &finish, true).is_err());
}

#[test]
fn periodic_maintenance_reads_the_live_writer_after_detaching() {
    let (_root, service) = fixture();
    let scan = json!({"action":"__resource_automation_scan","automatic":true});
    let due = json!({"action":"__resource_version_due","automatic":true});
    let hook = Arc::new(WorkerHook {
        service: Arc::downgrade(&service),
        base: None,
        action: "__resource_automation_scan".into(),
        request: scan.clone(),
        cancel: Arc::new(AtomicBool::new(false)),
        cancellable: true,
        commit_started: AtomicBool::new(false),
        internal_resource_automation: true,
        check_summary: None,
    });
    let mut worker = service.manager.lock().unwrap().detached(hook, false);
    let run = |worker: &mut Manager| {
        [
            crate::resource_automation::engine::dispatch_step(worker, &scan),
            crate::resource_checks::dispatch_due(worker, &due),
        ]
    };
    assert!(run(&mut worker).into_iter().all(|result| result.is_ok()));

    service.manager.lock().unwrap().state.settings["maintenance"] =
        json!({"revision":1,"pausedManually":true,"pauseUntil":null,"window":null});
    assert!(worker.state.settings.get("maintenance").is_none());
    for result in run(&mut worker) {
        assert_eq!(result.unwrap_err(), "自动维护已暂停，等待手动恢复");
    }

    {
        let mut manager = service.manager.lock().unwrap();
        manager.state.settings["maintenance"] =
            json!({"revision":2,"pausedManually":false,"pauseUntil":null,"window":null});
        manager.basic_mode = true;
    }
    assert!(!worker.basic_mode);
    let [scan_result, due_result] = run(&mut worker);
    assert_eq!(scan_result.unwrap_err(), "基本模式不修改或执行自动更新许可");
    assert_eq!(due_result.unwrap_err(), "基本模式不联网检查工具版本");

    service.manager.lock().unwrap().basic_mode = false;
    assert!(run(&mut worker).into_iter().all(|result| result.is_ok()));
    drop(service);
    for result in run(&mut worker) {
        assert_eq!(result.unwrap_err(), "Task service is unavailable");
    }
}
