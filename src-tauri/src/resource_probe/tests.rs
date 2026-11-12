use super::*;
use crate::resource_files::FileRole;
use crate::resource_lifecycle::InstallationRecord;

fn fixture() -> tempfile::TempDir {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("work/resource-probe-tests");
    fs::create_dir_all(&root).unwrap();
    tempfile::tempdir_in(root).unwrap()
}
fn put(root: &Path, relative: &str, text: &str) -> OwnedFile {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, text).unwrap();
    OwnedFile {
        path: relative.into(),
        role: FileRole::Runtime,
        installed_sha256: resource_files::fingerprint(&path).unwrap().sha256,
    }
}
fn source(repo: &str) -> DownloadSource {
    DownloadSource {
        repository: format!("https://github.com/{repo}"),
        version: "v2.0.0".into(),
        verification: "githubAsset".into(),
        author: repo.split('/').next().unwrap().into(),
        release_id: 1,
        asset_id: 2,
        asset_name: "test.zip".into(),
        download_url: format!("https://github.com/{repo}/releases/download/v2.0.0/test.zip"),
        sha256: "a".repeat(64),
        expected_sha256: None,
    }
}
fn record(root: &Path, repo: &str) -> ResourceRecord {
    ResourceRecord {
        id: "synthetic".into(),
        name: "Synthetic".into(),
        kind: "cli".into(),
        root_path: root.to_string_lossy().into_owned(),
        repository: Some(format!("https://github.com/{repo}")),
        version: Some("v1.0.0".into()),
        source_binding: None,
        source_history: vec![],
        alias: "".into(),
        notes: "".into(),
        enabled: true,
        ownership: "user".into(),
        management_scope: "full".into(),
        actions: vec![],
        capabilities: vec![json!({"id":"execution","status":"unverified"})],
        update_policy: json!({"mode":"manual"}),
        installation: Some(InstallationRecord {
            runtime_package: None,
            schema_version: 1,
            installed_at: "test".into(),
            archive_path: "synthetic".into(),
            archive_sha256: "a".repeat(64),
            source_repository: Some(format!("https://github.com/{repo}")),
            source_version: Some("v1.0.0".into()),
            download_source: Some(source(repo)),
            files: vec![],
            system_entries: vec![],
            removal_state: None,
            resource_manifest: None,
            status: "installed".into(),
            error: None,
            pending_repair: None,
            retained_repair_files: vec![],
            update_state: None,
        }),
        revision: 1,
        created_at: "test".into(),
        updated_at: "test".into(),
    }
}
fn action(executable: &Path, root: &Path, args: Vec<String>) -> Value {
    json!({"id":"entry","label":"Synthetic","mode":"task","executable":crate::local::canonical(executable).unwrap(),
        "workingDirectory":crate::local::canonical(root).unwrap(),"args":args.into_iter().map(|value|json!({"type":"literal","value":value})).collect::<Vec<_>>(),
        "parameters":[],"executableSha256":resource_files::fingerprint(executable).unwrap().sha256})
}
fn copy_target(target: &ValidationTarget) -> ValidationTarget {
    ValidationTarget {
        root: target.root.clone(),
        version: target.version.clone(),
        files: target.files.clone(),
        actions: target.actions.clone(),
    }
}
fn candidate_receipt(record: &mut ResourceRecord, repo: &str) {
    record.installation.as_mut().unwrap().update_state = Some(serde_json::from_value(json!({
        "candidate":{"root":record.root_path,"version":"v2.0.0","archivePath":"synthetic.zip",
            "archiveSha256":"a".repeat(64),"downloadSource":source(repo),"files":[],"createdPaths":[],"complete":true,"error":null,
            "original":{"root":record.root_path,"rootIdentity":"synthetic","files":{},"resource":{},"relations":{}},"validation":null},
        "previous":[],"retainedCandidates":[],"lastFailure":null,"lastValidation":null
    })).unwrap());
}
fn reach_fixture(root: &Path) -> (ResourceRecord, ValidationTarget) {
    let old = root.join("old");
    let candidate = root.join("candidate");
    fs::create_dir_all(&old).unwrap();
    fs::create_dir_all(&candidate).unwrap();
    put(&old, "Scripts/agent-reach.exe", "synthetic original");
    let python = candidate.join("Scripts/python.exe");
    let mut files = vec![put(
        &candidate,
        "Scripts/agent-reach.exe",
        &format!("SYNTHETIC\n#!{}\n", python.display()),
    )];
    for relative in [
        "Scripts/python.exe",
        "pyvenv.cfg",
        "Lib/site-packages/agent_reach/__init__.py",
        "Lib/site-packages/agent_reach/cli.py",
        "Lib/site-packages/agent_reach/runtime/cli.py",
        "Lib/site-packages/agent_reach/runtime/manage.py",
    ] {
        files.push(put(&candidate, relative, "synthetic fixture"));
    }
    let mut record = record(&old, REACH);
    record.actions = vec![action(
        &old.join("Scripts/agent-reach.exe"),
        &old,
        vec!["version".into()],
    )];
    let target = ValidationTarget {
        root: candidate.clone(),
        version: "v2.0.0".into(),
        files,
        actions: vec![action(
            &candidate.join("Scripts/agent-reach.exe"),
            &candidate,
            vec!["version".into()],
        )],
    };
    (record, target)
}

#[test]
fn reach_fixed_commands_use_candidate_launcher_without_changing_home_or_running_it() {
    let dir = fixture();
    let (record, target) = reach_fixture(dir.path());
    let plan = prepare(&record, &target, Adapter::Reach).unwrap();
    assert_eq!(plan.commands[0].args, vec!["version"]);
    assert_eq!(plan.commands[1].args, vec!["doctor", "--text"]);
    assert!(plan
        .commands
        .iter()
        .all(|c| c.python && c.directory == target.root));
    assert_eq!(plan.adapter.scopes(), ["cliVersion", "isolatedLocalDoctor"]);
    let outputs = vec![
        r#"{"ok":true,"action":"version","result":{"version":"2.0.0"}}"#.into(),
        "Agent Reach 2.0.0\r\n\r\nlocal state only".into(),
    ];
    verify_output(&plan, &outputs).unwrap();
    assert!(verify_output(
        &plan,
        &[outputs[0].replace("2.0.0", "1.0.0"), outputs[1].clone()]
    )
    .is_err());
}
#[test]
fn moved_python_launcher_cannot_validate_old_runtime_as_candidate() {
    let dir = fixture();
    let (record, mut target) = reach_fixture(dir.path());
    target.files[0] = put(
        &target.root,
        "Scripts/agent-reach.exe",
        &format!(
            "SYNTHETIC\n#!{}\n",
            Path::new(&record.root_path)
                .join("Scripts/python.exe")
                .display()
        ),
    );
    // This fixture starts with an intact registered launcher whose embedded
    // Python path is wrong; it is not a post-registration binary modification.
    target.actions[0]["executableSha256"] = json!(target.files[0].installed_sha256);
    let err = prepare(&record, &target, Adapter::Reach).err().unwrap();
    assert!(err.contains("其他版本"), "unexpected rejection: {err}");
}
fn edge_fixture(root: &Path) -> (ResourceRecord, ValidationTarget, PathBuf) {
    let old = root.join("old");
    let candidate = root.join("candidate");
    fs::create_dir_all(&old).unwrap();
    fs::create_dir_all(&candidate).unwrap();
    let node = root.join("node.exe");
    fs::write(&node, "SYNTHETIC_NODE_NOT_EXECUTED").unwrap();
    put(&old, EDGE_CLI, "old cli");
    let files = vec![
        put(
            &candidate,
            EDGE_CLI,
            "program.version('Version'); program.parseAsync(process.argv)",
        ),
        put(
            &candidate,
            "node_modules/@playwright/mcp/package.json",
            r#"{"name":"@playwright/mcp","version":"2.0.0","repository":{"url":"git+https://github.com/microsoft/playwright-mcp.git"}}"#,
        ),
    ];
    let mut record = record(&old, EDGE);
    let old_args = vec![
        crate::local::canonical(&old.join(EDGE_CLI))
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        "--version".into(),
    ];
    record.actions = vec![action(&node, &old, old_args)];
    let target_args = vec![
        crate::local::canonical(&candidate.join(EDGE_CLI))
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        "--version".into(),
    ];
    let target = ValidationTarget {
        root: candidate.clone(),
        version: "v2.0.0".into(),
        files,
        actions: vec![action(&node, &candidate, target_args)],
    };
    (record, target, node)
}
#[test]
fn shared_node_requires_exact_registered_hash_and_full_argument_mapping() {
    let dir = fixture();
    let (record, mut target, node) = edge_fixture(dir.path());
    let plan = prepare(&record, &target, Adapter::Edge).unwrap();
    assert_eq!(plan.commands[0].args[1], "--version");
    assert_eq!(plan.commands[1].args[1], "--help");
    assert!(!plan
        .commands
        .iter()
        .any(|c| c.args.iter().any(|a| a == "--extension")));
    assert_eq!(
        plan.commands[0].executable,
        crate::local::canonical(&node).unwrap()
    );
    verify_output(
        &plan,
        &[
            "Version 2.0.0\r\n".into(),
            "Usage: Playwright MCP\nOptions:\n--help".into(),
        ],
    )
    .unwrap();
    target.actions[0]["args"][1]["value"] = json!("--unexpected");
    assert!(prepare(&record, &target, Adapter::Edge).is_err());
    target.actions[0]["args"][1]["value"] = json!("--version");
    fs::write(&node, "CHANGED_SHARED_RUNTIME").unwrap();
    assert!(prepare(&record, &target, Adapter::Edge).is_err());
}
#[test]
fn every_registered_reach_action_needs_coverage_even_without_required_capability_flags() {
    let dir = fixture();
    let (record, target) = reach_fixture(dir.path());
    assert!(record
        .capabilities
        .iter()
        .all(|c| c.get("required").is_none()));
    assert_eq!(current_adapter(&record).unwrap(), Adapter::Reach);
    for args in [
        vec!["channels"],
        vec!["web", "read", "https://example.org", "--backend", "jina"],
        vec!["version", "--unreviewed"],
    ] {
        let mut record = record.clone();
        let mut target = copy_target(&target);
        let mut extra = record.actions[0].clone();
        extra["id"] = json!("looks-like-a-version-check");
        extra["label"] = json!("Additional selected capability");
        extra["args"] = json!(args
            .iter()
            .map(|v| json!({"type":"literal","value":v}))
            .collect::<Vec<_>>());
        let mut next = target.actions[0].clone();
        next["id"] = extra["id"].clone();
        next["label"] = extra["label"].clone();
        next["args"] = extra["args"].clone();
        record.actions.push(extra);
        target.actions.push(next);
        assert!(current_adapter(&record).unwrap_err().contains("能力范围"));
        assert!(automation_supported(&record)
            .unwrap_err()
            .contains("能力范围"));
        assert!(prepare(&record, &target, Adapter::Reach)
            .err()
            .unwrap()
            .contains("能力范围"));
    }
}
#[test]
fn registered_task_mode_parameters_and_all_candidate_pairs_remain_in_the_fixed_scope() {
    let dir = fixture();
    let (record, target) = reach_fixture(dir.path());
    for change in [
        json!({"mode":"service"}),
        json!({"parameters":[{"name":"input","label":"Input","kind":"text"}]}),
        json!({"args":[{"type":"parameter","name":"command"}]}),
    ] {
        let mut changed = record.clone();
        for (key, value) in change.as_object().unwrap() {
            changed.actions[0][key] = value.clone();
        }
        assert!(current_adapter(&changed).unwrap_err().contains("能力范围"));
        assert!(prepare(&changed, &target, Adapter::Reach).is_err());
    }
    for (key, value) in [("cancellable", json!(true)), ("timeoutSeconds", json!(1))] {
        let mut changed = copy_target(&target);
        changed.actions[0][key] = value;
        assert!(prepare(&record, &changed, Adapter::Reach)
            .err()
            .unwrap()
            .contains("固定参数"));
    }
    let mut doctor = record.clone();
    let mut next_doctor = copy_target(&target);
    doctor.actions[0]["args"] =
        json!([{"type":"literal","value":"doctor"},{"type":"literal","value":"--text"}]);
    next_doctor.actions[0]["args"] = doctor.actions[0]["args"].clone();
    assert_eq!(current_adapter(&doctor).unwrap(), Adapter::Reach);
    assert!(prepare(&doctor, &next_doctor, Adapter::Reach).is_ok());
}
#[test]
fn browser_actions_after_a_valid_edge_version_action_are_not_covered_by_cli_help() {
    let dir = fixture();
    let (record, target, _) = edge_fixture(dir.path());
    for id in ["edge-tabs", "edge-snapshot"] {
        let mut record = record.clone();
        let mut target = copy_target(&target);
        let mut original = record.actions[0].clone();
        let mut next = target.actions[0].clone();
        for action in [&mut original, &mut next] {
            action["id"] = json!(id);
            action["args"][1]["value"] = json!("--extension");
        }
        record.actions.push(original);
        target.actions.push(next);
        assert_eq!(record.capabilities[0]["required"], Value::Null);
        assert!(current_adapter(&record).unwrap_err().contains("能力范围"));
        assert!(automation_supported(&record)
            .unwrap_err()
            .contains("能力范围"));
        assert!(prepare(&record, &target, Adapter::Edge)
            .err()
            .unwrap()
            .contains("能力范围"));
    }
}
#[test]
fn a_second_narrow_action_is_checked_and_candidate_action_sets_cannot_drift() {
    let dir = fixture();
    let (mut record, mut target, _) = edge_fixture(dir.path());
    let mut original = record.actions[0].clone();
    let mut next = target.actions[0].clone();
    for action in [&mut original, &mut next] {
        action["id"] = json!("help");
        action["args"][1]["value"] = json!("--help");
    }
    record.actions.push(original);
    target.actions.push(next);
    assert_eq!(current_adapter(&record).unwrap(), Adapter::Edge);
    assert!(prepare(&record, &target, Adapter::Edge).is_ok());
    let mut changed = copy_target(&target);
    changed.actions[1]["executableSha256"] = json!("b".repeat(64));
    assert!(prepare(&record, &changed, Adapter::Edge)
        .err()
        .unwrap()
        .contains("执行程序发生变化"));
    changed = copy_target(&target);
    changed.actions[1]["cancellable"] = json!(true);
    assert!(prepare(&record, &changed, Adapter::Edge)
        .err()
        .unwrap()
        .contains("固定参数"));
    changed = copy_target(&target);
    changed.actions.pop();
    assert!(prepare(&record, &changed, Adapter::Edge).is_err());
    changed = copy_target(&target);
    changed.actions[1]["id"] = json!("entry");
    assert!(prepare(&record, &changed, Adapter::Edge).is_err());
    record.actions[1]["id"] = json!("entry");
    assert!(prepare(&record, &target, Adapter::Edge).is_err());
}
#[test]
fn unknown_or_dragon_sources_and_forged_success_never_run_commands() {
    let dir = fixture();
    let m = Manager::new(dir.path().join("state")).unwrap();
    let root = dir.path().join("tool");
    fs::create_dir(&root).unwrap();
    for repo in ["user/unknown", "user/DragonCodexBoot"] {
        assert!(select_adapter(&record(&root, repo)).is_err());
    }
    assert!(apply_local(&m,&json!({"action":"verify_resource_update","id":"missing","expectedRevision":1,"verified":true})).is_err());
    assert!(apply_local(&m,&json!({"action":"verify_resource_update","id":"missing","expectedRevision":1,"command":"anything"})).is_err());
    assert!(apply_local(&m, &json!({"action":"unrelated"}))
        .unwrap()
        .is_none());
    assert_eq!(
        repository("https://github.com/Panniantong/Agent-Reach.git").as_deref(),
        Some(REACH)
    );
    assert!(repository("https://github.com.attacker.invalid/panniantong/agent-reach").is_none());
}

#[test]
fn restored_probe_rejects_unknown_sources_and_required_platform_calls_before_creating_a_profile() {
    let dir = fixture();
    let temporary = dir.path().join("probe-profile");
    assert!(verify_restored(&record(dir.path(), "user/unknown"), &temporary).is_err());
    assert!(!temporary.exists());
    let (mut restored, _) = reach_fixture(dir.path());
    restored
        .capabilities
        .push(json!({"id":"platformSearch","required":true}));
    assert!(verify_restored(&restored, &temporary)
        .err()
        .unwrap()
        .contains("必须实际验证"));
    assert!(!temporary.exists());
}

#[test]
fn restored_probe_rechecks_actual_registered_files_before_starting_any_command() {
    let dir = fixture();
    let (mut restored, target, _) = edge_fixture(dir.path());
    restored.root_path = target.root.to_string_lossy().into_owned();
    restored.version = Some(target.version);
    restored.actions = target.actions;
    restored.installation.as_mut().unwrap().files = target.files;
    fs::write(
        Path::new(&restored.root_path).join(EDGE_CLI),
        "changed restored CLI",
    )
    .unwrap();
    let temporary = dir.path().join("probe-profile");
    assert!(verify_restored(&restored, &temporary)
        .err()
        .unwrap()
        .contains("本地改造"));
    assert!(!temporary.exists());
}
#[test]
fn source_provenance_and_required_platform_capabilities_are_not_bool_validation() {
    let dir = fixture();
    let r = record(dir.path(), REACH);
    assert!(select_adapter(&r).is_err()); // No candidate receipt, despite trusted name.
    assert!(!source_matches(&source(REACH), EDGE, &"a".repeat(64)));
    let mut fake = source(REACH);
    fake.verification = "userProvided".into();
    assert!(!source_matches(&fake, REACH, &"a".repeat(64)));
    assert!(!source_matches(&source(REACH), REACH, &"b".repeat(64)));
    let dir2 = fixture();
    let (mut record, target) = reach_fixture(dir2.path());
    candidate_receipt(&mut record, REACH);
    assert_eq!(select_adapter(&record).unwrap(), Adapter::Reach);
    record
        .capabilities
        .push(json!({"id":"bilibiliSearch","required":true,"status":"verified"}));
    assert!(select_adapter(&record)
        .unwrap_err()
        .contains("必须实际验证"));
    // A prior platform status must not change the startup probe's fixed scope.
    let plan = prepare(&record, &target, Adapter::Reach).unwrap();
    assert_eq!(plan.adapter.scopes(), ["cliVersion", "isolatedLocalDoctor"]);
}

fn helper(name: &str, timeout: Duration) -> ProbeCommand {
    ProbeCommand {
        executable: std::env::current_exe().unwrap(),
        expected_hash: resource_files::fingerprint(&std::env::current_exe().unwrap())
            .unwrap()
            .sha256,
        directory: std::env::current_dir().unwrap(),
        args: vec![
            "--exact".into(),
            format!("resource_probe::tests::{name}"),
            "--ignored".into(),
            "--nocapture".into(),
        ],
        python: false,
        timeout,
    }
}

#[test]
fn repeated_probe_accepts_only_its_own_prior_proof_clear_revision() {
    let dir = fixture();
    let mut record = record(dir.path(), REACH);
    candidate_receipt(&mut record, REACH);
    let mut data = json!(record);
    data["installation"]["updateState"]["candidate"]["validation"] = json!({
        "adapter":"synthetic", "verifiedAt":"test", "candidateRootIdentity":"fixture", "files":{}, "actions":[]});
    record = serde_json::from_value(data).unwrap();
    let mut cleared = json!(record);
    cleared["installation"]["updateState"]["candidate"]["validation"] = Value::Null;
    cleared["revision"] = json!(record.revision + 1);
    cleared["updatedAt"] = json!("internal proof clear");
    assert!(callback_record_matches(&record, &cleared));
    cleared["notes"] = json!("concurrent modification");
    assert!(!callback_record_matches(&record, &cleared));
    cleared["notes"] = json!(record.notes);
    cleared["revision"] = json!(record.revision + 2);
    assert!(!callback_record_matches(&record, &cleared));
}

#[test]
fn automation_scope_is_read_only_checks_current_layout_and_never_grants_platform_evidence() {
    let dir = fixture();
    let (mut record, target) = reach_fixture(dir.path());
    record.root_path = target.root.to_string_lossy().into_owned();
    record.version = Some(target.version);
    record.actions = target.actions;
    record.installation.as_mut().unwrap().files = target.files;
    // These are text fixtures, not runnable programs. Success therefore proves
    // this helper inspects scope instead of trying to execute the tool.
    automation_supported(&record).unwrap();
    record
        .capabilities
        .push(json!({"id":"authenticatedPlatformRead","required":true}));
    assert!(automation_supported(&record)
        .unwrap_err()
        .contains("必须实际验证"));
    record.capabilities.pop();
    fs::write(
        Path::new(&record.root_path).join("user-local.json"),
        "user state",
    )
    .unwrap();
    assert!(automation_supported(&record)
        .unwrap_err()
        .contains("未知归属"));
    record.repository = Some("https://github.com/unknown/agent-reach".into());
    assert!(automation_supported(&record)
        .unwrap_err()
        .contains("没有经过核对"));
    assert!(record.installation.as_ref().unwrap().update_state.is_none());
}
#[test]
#[ignore = "Only an isolated subprocess fixture"]
fn synthetic_echo() {
    println!("SYNTHETIC_PROBE_OUTPUT_NEVER_PERSISTED");
}
#[test]
#[ignore = "Only an isolated subprocess fixture"]
fn synthetic_failure() {
    eprintln!("SYNTHETIC_PRIVATE_DETAIL_NEVER_PERSISTED");
    std::process::exit(7);
}
#[test]
#[ignore = "Only an isolated subprocess fixture"]
fn synthetic_wait() {
    std::thread::sleep(Duration::from_secs(15));
}
#[test]
#[ignore = "Only an isolated subprocess fixture"]
fn synthetic_excess() {
    for _ in 0..100 {
        println!("{}", "z".repeat(1024));
    }
}
#[test]
fn process_output_is_bounded_errors_are_private_and_timeout_stops_only_own_child() {
    let directory = fixture();
    let profile = ProbeProfile::new(directory.path()).unwrap();
    let output = run(&helper("synthetic_echo", Duration::from_secs(8)), &profile).unwrap();
    assert!(output.contains("SYNTHETIC_PROBE_OUTPUT_NEVER_PERSISTED"));
    let err = run(
        &helper("synthetic_failure", Duration::from_secs(8)),
        &profile,
    )
    .unwrap_err();
    assert!(!err.contains("SYNTHETIC_PRIVATE_DETAIL"));
    assert!(run(
        &helper("synthetic_excess", Duration::from_secs(8)),
        &profile
    )
    .is_err());
    let mut unrelated = Command::new(std::env::current_exe().unwrap())
        .args(helper("synthetic_wait", Duration::from_secs(8)).args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let start = Instant::now();
    assert!(run(
        &helper("synthetic_wait", Duration::from_millis(150)),
        &profile
    )
    .unwrap_err()
    .contains("超时"));
    assert!(start.elapsed() < Duration::from_secs(5));
    assert!(unrelated.try_wait().unwrap().is_none());
    unrelated.kill().unwrap();
    unrelated.wait().unwrap();
}

#[test]
#[ignore = "Only an isolated subprocess fixture"]
fn synthetic_profile_writes() {
    let base = std::env::current_dir().unwrap();
    let mut seen = serde_json::Map::new();
    for name in [
        "GITHUB_TOKEN",
        "PLAYWRIGHT_MCP_EXTENSION_TOKEN",
        "ARM_PROBE_SYNTHETIC_SECRET",
        "PIP_CONFIG_FILE",
        "HTTPS_PROXY",
        "NODE_OPTIONS",
        "PYTHONPATH",
    ] {
        assert!(std::env::var_os(name).is_none());
    }
    assert!(std::env::var_os("PATH").is_some());
    #[cfg(windows)]
    assert!(std::env::var_os("SystemRoot").is_some());
    for name in [
        "HOME",
        "USERPROFILE",
        "TEMP",
        "TMP",
        "TMPDIR",
        "APPDATA",
        "LOCALAPPDATA",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
    ] {
        let path = PathBuf::from(std::env::var_os(name).unwrap());
        assert!(path.is_absolute() && path.starts_with(&base) && path.is_dir());
        seen.insert(name.into(), json!(path));
    }
    // Assert every redirection before writing anything. A missing override must
    // fail without touching the real user profile or machine temporary folder.
    let home = PathBuf::from(std::env::var_os("HOME").unwrap());
    let temporary = PathBuf::from(std::env::var_os("TEMP").unwrap());
    fs::create_dir(home.join(".agent-reach")).unwrap();
    fs::write(
        home.join(".agent-reach/state.json"),
        "synthetic health bookkeeping",
    )
    .unwrap();
    fs::write(
        temporary.join("probe-output.txt"),
        "synthetic temporary file",
    )
    .unwrap();
    println!("\nISOLATED_PROFILE={}", Value::Object(seen));
}

#[test]
fn an_actual_probe_child_writes_only_into_its_new_profile_and_parent_environment_is_unchanged() {
    let directory = fixture();
    let selected_temporary = directory.path().join("selected-cache");
    let profile = ProbeProfile::new(&selected_temporary).unwrap();
    let parent_environment: Vec<_> = profile
        .directories
        .iter()
        .map(|(name, _)| (*name, std::env::var_os(name)))
        .collect();
    let mut probe = helper("synthetic_profile_writes", Duration::from_secs(8));
    probe.directory = directory.path().to_owned();
    let output = run(&probe, &profile).unwrap();
    let observed: Value = serde_json::from_str(
        output
            .lines()
            .find_map(|line| line.strip_prefix("ISOLATED_PROFILE="))
            .unwrap(),
    )
    .unwrap();
    for (name, path) in &profile.directories {
        assert_eq!(observed[*name], json!(path));
    }
    for (name, value) in parent_environment {
        assert_eq!(std::env::var_os(name), value);
    }
    assert_eq!(
        fs::read_to_string(profile.root.join("home/.agent-reach/state.json")).unwrap(),
        "synthetic health bookkeeping"
    );
    assert!(profile.root.join("temp/probe-output.txt").is_file());
    assert_eq!(fs::read_dir(&selected_temporary).unwrap().count(), 1);
    assert_eq!(
        Adapter::Reach.scopes(),
        ["cliVersion", "isolatedLocalDoctor"]
    );
    assert!(Adapter::Reach.id().contains("isolated"));
    assert!(Adapter::Edge.id().contains("isolated"));
}

#[test]
fn isolated_profile_overrides_existing_child_locations_and_rejects_root_replacement() {
    let directory = fixture();
    let original = directory.path().join("original-profile");
    fs::create_dir(&original).unwrap();
    fs::write(original.join("state.json"), "synthetic original state").unwrap();
    let profile = ProbeProfile::new(&directory.path().join("selected-cache")).unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    for (name, _) in &profile.directories {
        command.env(name, &original);
    }
    profile.apply(&mut command).unwrap();
    for (name, path) in &profile.directories {
        assert_eq!(
            command
                .get_envs()
                .find(|(key, _)| *key == std::ffi::OsStr::new(name))
                .unwrap()
                .1,
            Some(path.as_os_str())
        );
    }
    assert_eq!(
        fs::read_to_string(original.join("state.json")).unwrap(),
        "synthetic original state"
    );
    fs::rename(&profile.root, directory.path().join("retained-probe-state")).unwrap();
    fs::create_dir(&profile.root).unwrap();
    assert!(profile
        .apply(&mut command)
        .unwrap_err()
        .contains("目录已变化"));
    assert!(ProbeProfile::new(Path::new("relative-temp")).is_err());
}

#[test]
fn actual_probe_child_drops_synthetic_credentials_and_arbitrary_overrides_but_keeps_os_runtime() {
    let directory = fixture();
    let profile = ProbeProfile::new(&directory.path().join("selected-cache")).unwrap();
    let probe = helper("synthetic_profile_writes", Duration::from_secs(8));
    let mut command = Command::new(&probe.executable);
    command
        .args(&probe.args)
        .current_dir(directory.path())
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .stdout(Stdio::piped());
    for name in [
        "GITHUB_TOKEN",
        "PLAYWRIGHT_MCP_EXTENSION_TOKEN",
        "ARM_PROBE_SYNTHETIC_SECRET",
        "PIP_CONFIG_FILE",
        "HTTPS_PROXY",
        "NODE_OPTIONS",
        "PYTHONPATH",
    ] {
        command.env(name, "SYNTHETIC_NOT_A_REAL_CREDENTIAL_OR_CONFIGURATION");
    }
    isolated_runtime_environment(&mut command);
    profile.apply(&mut command).unwrap();
    let output = command.output().unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8(output.stdout)
        .unwrap()
        .contains("ISOLATED_PROFILE="));
    assert_eq!(
        fs::read_to_string(profile.root.join("home/.agent-reach/state.json")).unwrap(),
        "synthetic health bookkeeping"
    );
}
