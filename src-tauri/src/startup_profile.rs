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

#[test]
#[ignore = "manual backend update contention diagnosis; requires a fresh isolated fixture"]
fn profile_documents_during_resource_stage() {
    use serde_json::{json, Value};
    use std::{
        fs,
        path::{Path, PathBuf},
        time::Duration,
    };

    fn canonical(path: &Path) -> PathBuf {
        let physical = crate::local::canonical(path).unwrap();
        let text = physical.to_str().unwrap();
        PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(text))
    }

    let manager_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap();
    let validation = canonical(&manager_root.join("validation"));
    let data_root = validation.join("manager-data");
    let resources_root = validation.join("resources");
    let run_root = canonical(Path::new(&std::env::var("ARM_STAGE_PROFILE_ROOT").unwrap()));
    let fixture_root = canonical(Path::new(
        &std::env::var("ARM_STAGE_PROFILE_FIXTURE").unwrap(),
    ));
    assert_eq!(run_root.parent(), Some(data_root.as_path()));
    assert_eq!(fixture_root.parent(), Some(resources_root.as_path()));
    assert!(run_root
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("backend-document-stage-"));
    assert!(fixture_root
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("native-load-"));
    let dataset_root = canonical(&run_root.join("document-stage-fixture"));
    assert_eq!(dataset_root.parent(), Some(run_root.as_path()));
    let data = canonical(&dataset_root.join("data"));
    assert_eq!(data.parent(), Some(dataset_root.as_path()));
    let plan: Value =
        serde_json::from_slice(&fs::read(fixture_root.join("load-fixture.json")).unwrap()).unwrap();
    assert_eq!(plan["syntheticOnly"], true);
    assert_eq!(plan["format"], "agent-resource-manager-native-load-v1");
    assert_eq!(plan["limits"]["fileCount"], 4098);
    assert_eq!(plan["limits"]["unpackedBytes"], 16_777_333);
    let live = fixture_root.join("current-runtime");
    let package = fixture_root.join("v2.zip");
    let candidate_parent = canonical(&fixture_root.join("candidates"));
    assert_eq!(canonical(&live), live);
    assert_eq!(canonical(&package), package);
    assert_eq!(candidate_parent, fixture_root.join("candidates"));
    let destination = candidate_parent.join("backend-diagnostic-v2");
    assert!(!destination.exists());
    let original_files = ["LICENSE", "bin/tool.txt"].map(|entry| {
        let path = live.join(entry);
        assert!(canonical(&path).starts_with(&live));
        let sha256 = crate::resource_files::fingerprint(&path).unwrap().sha256;
        (path, sha256)
    });
    assert_eq!(
        crate::resource_files::fingerprint(&package).unwrap().sha256,
        plan["nextArchive"]["sha256"].as_str().unwrap()
    );
    let _network = crate::network::test_configuration_guard();
    let manager =
        crate::initialize_manager(crate::storage::Storage::isolated(data), false).unwrap();
    assert_eq!(manager.state.skills.len(), 1000);
    assert!(manager.state.sources.is_empty() && manager.state.connections.is_empty());
    let service = crate::tasks::TaskSystem::new(manager).unwrap();
    let skills = service.snapshot().unwrap()["skills"].clone();
    let execute = |request| service.execute(request, crate::dispatch_local).unwrap();
    let initial = execute(json!({"action":"resource_list"}));
    assert_eq!(initial["resources"].as_array().unwrap().len(), 100);
    let initial_resource = &initial["resources"][initial["resources"]
        .as_array()
        .unwrap()
        .iter()
        .position(|r| r["id"] == "perf-tool-000")
        .unwrap()];
    assert_eq!(initial_resource["version"], "v1");
    assert_eq!(initial_resource["rootPath"], json!(live));
    assert_eq!(initial_resource["actions"], json!([]));
    let preview = execute(
        json!({"action":"preview_resource_update","id":"perf-tool-000",
        "expectedRevision":initial_resource["revision"],"archivePath":package,"destinationPath":destination,
        "version":"v2","selectedFiles":plan["operations"]["update"]["selectedFiles"],
        "fileRoles":plan["operations"]["update"]["fileRoles"]}),
    );
    assert_eq!(preview["canApply"], true);

    let read = |index| {
        let skill = format!("perf-skill-{index:04}");
        let expected =
            fs::read_to_string(dataset_root.join("skills").join(&skill).join("SKILL.md")).unwrap();
        let start = Instant::now();
        let actual = execute(json!({"action":"get_document","skillId":skill,"version":"latest"}));
        let duration = start.elapsed();
        assert_eq!(actual["markdown"], expected);
        assert_eq!(actual["source"], "本地运行文件");
        assert_eq!(actual["documentPath"], "SKILL.md");
        assert!(actual["readGeneration"].is_u64() && actual["localFingerprint"].is_string());
        duration.as_secs_f64() * 1000.0
    };
    let first_idle = read(0);
    let idle: Vec<f64> = (1..101).map(read).collect();
    let task = execute(json!({"action":"start_task","request":{
        "action":"apply_resource_update_stage","previewId":preview["id"]}}));
    let id = task["task"]["id"].as_str().unwrap();
    let status = || execute(json!({"action":"get_task","taskId":id}))["task"].clone();
    let began = Instant::now();
    while !destination.join("LICENSE").is_file() {
        assert!(
            began.elapsed() < Duration::from_secs(15),
            "No stage file activity"
        );
        let observed = status();
        assert!(
            matches!(observed["status"].as_str(), Some("queued" | "running")),
            "Stage stopped before copying: {}",
            observed["error"]
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let mut active = Vec::new();
    for index in 101..202 {
        if status()["status"] != "running" {
            break;
        }
        let elapsed = read(index);
        if status()["status"] != "running" {
            break;
        }
        active.push(elapsed);
    }
    assert!(!active.is_empty(), "No completed overlapping reads");
    let first_active = active.remove(0);
    let finished = loop {
        let observed = status();
        if observed["status"] != "running" {
            break observed;
        }
        assert!(
            began.elapsed() < Duration::from_secs(90),
            "Stage did not finish in time"
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(finished["status"], "succeeded");
    let result = &finished["result"];
    assert_eq!(result["complete"], true);
    assert_eq!(result["staged"], true);
    assert_eq!(result["switched"], false);
    assert_eq!(result["resource"]["rootPath"], json!(live));
    assert_eq!(result["resource"]["version"], "v1");
    assert_eq!(result["receipt"]["files"].as_array().unwrap().len(), 4098);
    for (path, hash) in original_files {
        assert_eq!(
            crate::resource_files::fingerprint(&path).unwrap().sha256,
            hash
        );
    }
    assert!(
        service.snapshot().unwrap()["skills"] == skills,
        "The exposed Skill rows changed during read and stage"
    );
    let durations = |mut items: Vec<f64>| {
        items.sort_by(f64::total_cmp);
        json!({"count":items.len(),"p95Ms":items.get((items.len()*95).div_ceil(100).saturating_sub(1)),
            "maximumMs":items.last()})
    };
    println!(
        "backend-document-stage {}",
        json!({
            "noGui":true, "noNativePerformanceClaim":true, "stageTask":id,
            "skills":1000, "tools":100, "files":4098, "firstIdleReadMs":first_idle,
            "idleSubsequent":durations(idle), "firstActiveNewDocumentMs":first_active,
            "stageActiveSubsequent":durations(active),"latestStageObservedMs":began.elapsed().as_secs_f64()*1000.0,
            "preservedLiveFilesAndSkillRows":true,"candidateStagedNotSwitched":true
        })
    );
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
