//! Explicit backend-only diagnosis; not a replacement for native startup acceptance.
use std::time::Instant;

#[test]
#[ignore = "manual document diagnosis; does not open windows or make network requests"]
fn profile_local_document_tasks() {
    profile_documents(false);
}

#[test]
#[ignore = "manual concurrent local check diagnosis; no windows or network sources"]
fn profile_documents_during_local_check() {
    profile_documents(true);
}

fn profile_documents(concurrent_check: bool) {
    let project = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap();
    let data_root = project.join("validation/manager-data/local-document-profile");
    let resources_root = project.join("validation/resources/local-document-profile");
    std::fs::create_dir_all(&data_root).unwrap();
    std::fs::create_dir_all(&resources_root).unwrap();
    let _network = crate::network::test_configuration_guard();
    let data = tempfile::tempdir_in(data_root).unwrap();
    let resources = tempfile::tempdir_in(resources_root).unwrap();
    let markdown = "# 合成技能说明\n\n保留全部正文和来源。\n".repeat(100);
    std::fs::write(resources.path().join("SKILL.md"), &markdown).unwrap();
    let mut manager = crate::initialize_manager(
        crate::storage::Storage::isolated(data.path().to_owned()),
        false,
    )
    .unwrap();
    manager.state.skills = (0..1000)
        .map(|id| {
            serde_json::json!({
                "id":format!("skill-{id}"), "name":format!("合成技能 {id}"),
                "description":"保留完整说明及引用。".repeat(20),
                "localPath":resources.path(), "runtimeFiles":["SKILL.md"], "version":"1.0.0"
            })
        })
        .collect();
    manager.save().unwrap();
    let service = crate::tasks::TaskSystem::new(manager).unwrap();
    let active = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let worker = concurrent_check.then(|| {
        let service = service.clone();
        let active = active.clone();
        std::thread::spawn(move || {
            active.store(true, std::sync::atomic::Ordering::SeqCst);
            let result =
                service.execute(serde_json::json!({"action":"check_now"}), crate::dispatch);
            active.store(false, std::sync::atomic::Ordering::SeqCst);
            result.unwrap();
        })
    });
    let mut overlapping = 0;
    let mut samples = Vec::new();
    for index in 0..110 {
        let overlap = active.load(std::sync::atomic::Ordering::SeqCst);
        let started = Instant::now();
        let result = service
            .execute(
                serde_json::json!({
                    "action":"get_document", "skillId":format!("skill-{}",index % 1000),
                    "origin":"local", "path":"SKILL.md"
                }),
                crate::dispatch,
            )
            .unwrap();
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(result["markdown"], markdown);
        assert_eq!(result["source"], "本地运行文件");
        assert_eq!(result["documentPath"], "SKILL.md");
        assert!(result["localFingerprint"].is_string());
        assert!(result["readGeneration"].is_u64());
        if overlap && active.load(std::sync::atomic::Ordering::SeqCst) {
            overlapping += 1;
        }
        if index >= 10 {
            samples.push(elapsed);
        }
    }
    if let Some(worker) = worker {
        worker.join().unwrap();
    }
    println!(
        "local-document-load concurrent_check={concurrent_check} overlapping_reads={overlapping}"
    );
    samples.sort_by(f64::total_cmp);
    println!("local-document-profile skills=1000 warmup=10 samples={} debug=true backend-only=true p50_ms={:.3} p95_ms={:.3} max_ms={:.3}",
        samples.len(), samples[49], samples[94], samples[99]);
}

#[test]
#[ignore = "manual startup diagnosis; does not open windows or make network requests"]
fn profile_startup_phases() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("work/startup-profile");
    std::fs::create_dir_all(&root).unwrap();
    let _network = crate::network::test_configuration_guard();
    for sample in 0..10 {
        let dir = tempfile::tempdir_in(&root).unwrap();
        let started = Instant::now();
        let db = rusqlite::Connection::open(dir.path().join("manager.sqlite3")).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
        println!(
            "startup-profile sample={sample} phase=open-wal ms={:.3}",
            started.elapsed().as_secs_f64() * 1000.0
        );
        macro_rules! phase {
            ($name:literal, $call:expr) => {{
                let start = Instant::now();
                $call.unwrap();
                println!(
                    "startup-profile sample={sample} phase={} ms={:.3}",
                    $name,
                    start.elapsed().as_secs_f64() * 1000.0
                );
            }};
        }
        phase!("catalog-and-evidence", crate::resources::initialize(&db));
        phase!("downloads", crate::resource_github::initialize(&db));
        phase!("version-checks", crate::resource_checks::initialize(&db));
        phase!("automation", crate::resource_automation::initialize(&db));
        phase!("management", crate::management_data::initialize(&db));
        phase!("templates", crate::invocation_templates::initialize(&db));
        phase!("relations", crate::resource_relations::initialize(&db));
        phase!("scenes", crate::resource_scenes::initialize(&db));
        drop(db);
        let fresh = tempfile::tempdir_in(&root).unwrap();
        let start = Instant::now();
        let manager = crate::initialize_manager(
            crate::storage::Storage::isolated(fresh.path().to_owned()),
            false,
        )
        .unwrap();
        println!(
            "startup-profile sample={sample} phase=complete-manager ms={:.3}",
            start.elapsed().as_secs_f64() * 1000.0
        );
        let start = Instant::now();
        let service = crate::tasks::TaskSystem::new(manager).unwrap();
        println!(
            "startup-profile sample={sample} phase=task-service ms={:.3}",
            start.elapsed().as_secs_f64() * 1000.0
        );
        drop(service);
    }
}
