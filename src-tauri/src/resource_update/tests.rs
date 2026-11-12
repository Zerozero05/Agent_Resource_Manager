use super::*;
use std::io::Write;

fn fixture() -> tempfile::TempDir {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("work/resource-update-tests");
    fs::create_dir_all(&root).unwrap();
    tempfile::tempdir_in(root).unwrap()
}
fn zip(root: &Path, name: &str, data: &str) -> PathBuf {
    let path = root.join(name);
    let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    for (path, bytes) in [
        ("bin/tool.exe", data),
        ("private/runtime.dll", "private dependency"),
        ("LICENSE", "license"),
    ] {
        zip.start_file(path, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes.as_bytes()).unwrap();
    }
    zip.finish().unwrap();
    path
}
fn installed(m: &mut Manager, root: &Path) -> ResourceRecord {
    let package = zip(root, "v1.zip", "version-one");
    let request = json!({"action":"preview_resource_install","archivePath":package,"destinationPath":root.join("v1"),"name":"Synthetic","kind":"cli","version":"v1","selectedFiles":["bin/tool.exe","private/runtime.dll"],"fileRoles":{"bin/tool.exe":"runtime","private/runtime.dll":"privateDependency"}});
    let plan = crate::resource_lifecycle::handle(m, &request)
        .unwrap()
        .unwrap();
    let result = crate::resource_lifecycle::apply_local(
        m,
        &json!({"action":"apply_resource_install","previewId":plan["id"]}),
    )
    .unwrap()
    .unwrap();
    serde_json::from_value(result["resource"].clone()).unwrap()
}
fn request(root: &Path, record: &ResourceRecord) -> Value {
    json!({"action":"preview_resource_update","id":record.id,"expectedRevision":record.revision,"archivePath":zip(root,"v2.zip","version-two"),"destinationPath":root.join("v2"),"version":"v2","selectedFiles":["bin/tool.exe","private/runtime.dll"],"fileRoles":{"bin/tool.exe":"runtime","private/runtime.dll":"privateDependency"}})
}
fn staged(m: &mut Manager, root: &Path, record: &ResourceRecord) -> ResourceRecord {
    let plan = handle(m, &request(root, record)).unwrap().unwrap();
    let result = apply_local(
        m,
        &json!({"action":"apply_resource_update_stage","previewId":plan["id"]}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(result["complete"], true);
    assert_eq!(result["switched"], false);
    serde_json::from_value(result["resource"].clone()).unwrap()
}
fn set_actions(m: &Manager, mut record: ResourceRecord) -> ResourceRecord {
    record.actions = vec![
        json!({"id":"check","label":"Synthetic probe","mode":"task","executable":crate::local::canonical(&Path::new(&record.root_path).join("bin/tool.exe")).unwrap(),"workingDirectory":crate::local::canonical(Path::new(&record.root_path)).unwrap(),"args":[],"parameters":[]}),
    ];
    save_record(m, record).unwrap()
}
fn verify(m: &Manager, id: &str) -> ResourceRecord {
    let result = validate_candidate_with(m, id, "synthetic-isolated-check", |target| {
        assert_eq!(target.version, "v2");
        assert_eq!(target.files.len(), 3);
        assert_eq!(
            fs::read_to_string(target.root.join("bin/tool.exe")).unwrap(),
            "version-two"
        );
        assert_eq!(target.actions.len(), 1);
        Ok(())
    })
    .unwrap();
    serde_json::from_value(result["resource"].clone()).unwrap()
}
fn fixture_post_probe(
    original: &ResourceRecord,
    actual: &ResourceRecord,
) -> Result<ProbeEvidence, String> {
    assert_eq!(original.version.as_deref(), Some("v1"));
    assert_eq!(actual.version.as_deref(), Some("v2"));
    assert_ne!(actual.root_path, original.root_path);
    assert_eq!(
        fs::read_to_string(Path::new(&actual.root_path).join("bin/tool.exe")).unwrap(),
        "version-two"
    );
    assert!(actual
        .actions
        .iter()
        .all(|a| Path::new(a["workingDirectory"].as_str().unwrap())
            == crate::local::canonical(Path::new(&actual.root_path)).unwrap()));
    Ok(ProbeEvidence {
        adapter: "synthetic-read-only-after-switch".into(),
        verified_scopes: vec!["syntheticFixtureRead".into()],
    })
}
fn fixture_restored_probe(restored: &ResourceRecord) -> Result<ProbeEvidence, String> {
    assert_eq!(restored.version.as_deref(), Some("v1"));
    assert_eq!(
        fs::read_to_string(Path::new(&restored.root_path).join("bin/tool.exe")).unwrap(),
        "version-one"
    );
    assert!(restored.actions.iter().all(|action| {
        Path::new(action["workingDirectory"].as_str().unwrap())
            == crate::local::canonical(Path::new(&restored.root_path)).unwrap()
    }));
    Ok(ProbeEvidence {
        adapter: "synthetic-read-only-after-restore".into(),
        verified_scopes: vec!["syntheticRestoredFixtureRead".into()],
    })
}

#[cfg(windows)]
#[test]
fn real_cli_post_switch_failures_restore_runnable_entry_and_preserve_local_data() {
    let validation = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap()
        .join("validation/manager-data/resource-update-native-cli-tests");
    fs::create_dir_all(&validation).unwrap();
    let node = std::env::split_paths(&std::env::var_os("PATH").expect("Node runtime PATH"))
        .map(|directory| directory.join("node.exe"))
        .find(|path| path.is_file())
        .expect("These native-process regressions require the existing Node runtime");
    let node = crate::local::canonical(&node).unwrap();
    let node_before = resource_files::fingerprint(&node).unwrap();

    for failure in ["exit", "wrong-version"] {
        let dir = tempfile::tempdir_in(&validation).unwrap();
        let data = dir.path().join("data");
        let mut manager = Manager::new(data.clone()).unwrap();
        let original = installed(&mut manager, dir.path());
        let mut record = staged(&mut manager, dir.path(), &original);
        let mut next = candidate(&record).unwrap().clone();
        let original_root = PathBuf::from(&record.root_path);
        let control = dir.path().join("probe-control.json");
        let calls = dir.path().join("actual-cli-calls.jsonl");
        let user_data = dir.path().join("user-data.json");
        fs::write(&control, r#"{"failure":"none"}"#).unwrap();
        fs::write(&user_data, "private local configuration must remain").unwrap();
        let user_data_before = resource_files::fingerprint(&user_data).unwrap();

        // Source metadata is synthetic. Only the local production probe, real
        // Node processes, catalogue switch and recovery are under test here.
        for (root, version, owned) in [
            (
                &original_root,
                "1",
                &mut record.installation.as_mut().unwrap().files,
            ),
            (&next.root, "2", &mut next.files),
        ] {
            let script = format!(
                r#"const fs = require('node:fs');
const control = JSON.parse(fs.readFileSync({control}, 'utf8'));
const version = {version};
const failed = version === '2' && control.failure !== 'none';
const argument = process.argv[2];
fs.appendFileSync({calls}, JSON.stringify({{ version, argument, failed, pid: process.pid, cwd: process.cwd() }}) + '\n');
if (failed && control.failure === 'exit') process.exit(23);
const program = {{
  version(value) {{ this.versionText = value; return this; }},
  parseAsync(argv) {{
    if (argv[2] === '--version') console.log(failed ? 'Version unexpected' : this.versionText);
    else if (argv[2] === '--help') console.log('Playwright MCP synthetic recovery fixture\nOptions: --version --help');
    else process.exit(24);
  }}
}};
program.version('Version ' + version);
program.parseAsync(process.argv);
"#,
                control = json!(control),
                calls = json!(calls),
                version = json!(version),
            );
            for (relative, contents) in [
                ("node_modules/@playwright/mcp/cli.js", script),
                (
                    "node_modules/@playwright/mcp/package.json",
                    json!({"name":"@playwright/mcp","version":version,"repository":{"url":"git+https://github.com/microsoft/playwright-mcp.git"}}).to_string(),
                ),
            ] {
                let path = root.join(relative);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(&path, contents).unwrap();
                owned.push(OwnedFile {
                    path: relative.into(),
                    role: FileRole::Runtime,
                    installed_sha256: resource_files::fingerprint(&path).unwrap().sha256,
                });
            }
        }
        let repository = "https://github.com/microsoft/playwright-mcp";
        record.repository = Some(repository.into());
        record.alias = "preserved local alias".into();
        record.notes = "preserved local notes".into();
        let installation = record.installation.as_mut().unwrap();
        installation.source_repository = Some(repository.into());
        let source = DownloadSource {
            repository: repository.into(),
            version: "v1".into(),
            verification: "githubAsset".into(),
            author: "microsoft".into(),
            release_id: 1,
            asset_id: 2,
            asset_name: "synthetic-fixture.zip".into(),
            download_url: format!("{repository}/releases/download/v1/synthetic-fixture.zip"),
            sha256: installation.archive_sha256.clone(),
            expected_sha256: None,
        };
        installation.download_source = Some(source.clone());
        next.download_source = Some(DownloadSource {
            version: "v2".into(),
            sha256: next.archive_sha256.clone(),
            download_url: format!("{repository}/releases/download/v2/synthetic-fixture.zip"),
            ..source
        });
        record.actions = vec![json!({
            "id":"version","label":"Synthetic CLI version","mode":"task",
            "executable":node,"executableSha256":node_before.sha256,
            "workingDirectory":crate::local::canonical(&original_root).unwrap(),
            "args":[{"type":"literal","value":crate::local::canonical(&original_root.join("node_modules/@playwright/mcp/cli.js")).unwrap()},
                {"type":"literal","value":"--version"}],"parameters":[]
        })];
        next.original = baseline(&manager, &record).unwrap();
        let candidate_root = next.root.clone();
        record
            .installation
            .as_mut()
            .unwrap()
            .update_state
            .as_mut()
            .unwrap()
            .candidate = Some(next);
        let record = save_record(&manager, record).unwrap();
        let original_files = inventory(&original_root).unwrap();
        let candidate_files = inventory(&candidate_root).unwrap();
        let verified = crate::dispatch_local(
            &mut manager,
            &json!({
                "action":"verify_resource_update","id":record.id,"expectedRevision":record.revision
            }),
        )
        .unwrap();
        assert_eq!(verified["verified"], true);
        assert_eq!(verified["verifiedScopes"], json!(["cliVersion", "cliHelp"]));

        // This test-owned control sits outside both runtimes. Changing it does
        // not tamper with the validated candidate or fabricate probe results.
        fs::write(&control, json!({"failure":failure}).to_string()).unwrap();
        let preview = crate::dispatch_local(
            &mut manager,
            &json!({
                "action":"preview_resource_update_switch","id":record.id,
                "expectedRevision":verified["resource"]["revision"]
            }),
        )
        .unwrap();
        assert_eq!(preview["canApply"], true);
        let result = crate::dispatch_local(
            &mut manager,
            &json!({
                "action":"apply_resource_update_switch","previewId":preview["id"]
            }),
        )
        .unwrap();
        assert_eq!(result["complete"], false, "{failure}");
        assert_eq!(result["postSwitchVerified"], false, "{failure}");
        assert_eq!(result["entryRestored"], true, "{failure}");
        assert_eq!(result["rollbackVerified"], true, "{failure}");
        assert_eq!(result["rolledBack"], true, "{failure}");
        assert_eq!(result["dataCopied"], false);
        let restored = read(&manager, &record.id).unwrap();
        assert_eq!(restored.root_path, record.root_path);
        assert_eq!(restored.version.as_deref(), Some("v1"));
        assert_eq!(restored.actions, record.actions);
        assert_eq!(restored.alias, record.alias);
        assert_eq!(restored.notes, record.notes);
        assert_eq!(inventory(&original_root).unwrap(), original_files);
        assert_eq!(inventory(&candidate_root).unwrap(), candidate_files);
        assert_eq!(
            resource_files::fingerprint(&user_data).unwrap(),
            user_data_before
        );
        let check = restored
            .installation
            .as_ref()
            .unwrap()
            .update_state
            .as_ref()
            .unwrap()
            .switch_check
            .as_ref()
            .unwrap();
        assert_eq!(check.status, "rolledBack");
        assert_eq!(
            check.adapter.as_deref(),
            Some("playwright-mcp-isolated-cli-help-v2")
        );
        assert_eq!(check.verified_scopes, vec!["cliVersion", "cliHelp"]);
        assert!(candidate(&restored).unwrap().validation.is_none());

        let observed: Vec<Value> = fs::read_to_string(&calls)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(observed[0]["version"], "2");
        assert_eq!(observed[0]["argument"], "--version");
        assert_eq!(observed[1]["argument"], "--help");
        assert_eq!(observed[2]["version"], "2");
        assert_eq!(observed[2]["failed"], true);
        assert!(observed
            .iter()
            .all(|call| call["pid"].as_u64().is_some_and(|pid| pid > 0)));
        let tail = &observed[observed.len() - 2..];
        assert_eq!(tail[0]["version"], "1");
        assert_eq!(tail[0]["argument"], "--version");
        assert_eq!(tail[1]["version"], "1");
        assert_eq!(tail[1]["argument"], "--help");
        assert!(tail.iter().all(|call| call["failed"] == false));
        drop(manager);
        let reopened = Manager::new(data).unwrap();
        let persisted = read(&reopened, &record.id).unwrap();
        assert_eq!(persisted.root_path, restored.root_path);
        assert_eq!(persisted.actions, restored.actions);
        assert_eq!(
            persisted
                .installation
                .as_ref()
                .unwrap()
                .update_state
                .as_ref()
                .unwrap()
                .switch_check
                .as_ref()
                .unwrap()
                .status,
            "rolledBack"
        );
        crate::resource_probe::verify_restored(&persisted, &reopened.storage.path("temp").unwrap())
            .unwrap();
        assert_eq!(
            resource_files::fingerprint(&user_data).unwrap(),
            user_data_before
        );
        assert_eq!(resource_files::fingerprint(&node).unwrap(), node_before);
    }
}

#[test]
fn update_preview_is_read_only_and_stage_retains_original_runtime_and_survives_restart() {
    let dir = fixture();
    let mut manager = Manager::new(dir.path().join("data")).unwrap();
    let record = installed(&mut manager, dir.path());
    let before = inventory(Path::new(&record.root_path)).unwrap();
    let plan = handle(&mut manager, &request(dir.path(), &record))
        .unwrap()
        .unwrap();
    assert!(!dir.path().join("v2").exists());
    assert_eq!(plan["changes"].as_array().unwrap().len(), 3);
    assert_eq!(plan["changes"][0]["localModified"], false);
    let result = apply_local(
        &mut manager,
        &json!({"action":"apply_resource_update_stage","previewId":plan["id"]}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(result["switched"], false);
    assert_eq!(inventory(Path::new(&record.root_path)).unwrap(), before);
    assert_eq!(result["resource"]["rootPath"], record.root_path);
    assert_eq!(result["resource"]["version"], "v1");
    drop(manager);
    let manager = Manager::new(dir.path().join("data")).unwrap();
    let reopened = read(&manager, &record.id).unwrap();
    let candidate = candidate(&reopened).unwrap();
    assert_eq!(candidate.version, "v2");
    assert!(candidate.root.join("private/runtime.dll").is_file());
    assert!(candidate.validation.is_none());
}

#[test]
fn switch_requires_real_server_probe_and_preserves_previous_with_private_dependencies() {
    let dir = fixture();
    let mut manager = Manager::new(dir.path().join("data")).unwrap();
    let record = installed(&mut manager, dir.path());
    let record = set_actions(&manager, record);
    let original = inventory(Path::new(&record.root_path)).unwrap();
    let record = staged(&mut manager, dir.path(), &record);
    let before=handle(&mut manager,&json!({"action":"preview_resource_update_switch","id":record.id,"expectedRevision":record.revision})).unwrap().unwrap();
    assert_eq!(before["canApply"], false);
    assert!(apply_local(
        &mut manager,
        &json!({"action":"apply_resource_update_switch","previewId":before["id"],"verified":true})
    )
    .is_err());
    let verified = verify(&manager, &record.id);
    let plan=handle(&mut manager,&json!({"action":"preview_resource_update_switch","id":record.id,"expectedRevision":verified.revision})).unwrap().unwrap();
    assert_eq!(plan["canApply"], true);
    let result = apply_local_with(
        &mut manager,
        &json!({"action":"apply_resource_update_switch","previewId":plan["id"]}),
        fixture_post_probe,
        fixture_restored_probe,
    )
    .unwrap()
    .unwrap();
    assert_eq!(result["complete"], true);
    assert_eq!(result["switched"], true);
    assert_eq!(result["postSwitchVerified"], true);
    assert_eq!(result["resource"]["version"], "v2");
    assert_eq!(inventory(Path::new(&record.root_path)).unwrap(), original);
    let updated = read(&manager, &record.id).unwrap();
    let state = updated
        .installation
        .as_ref()
        .unwrap()
        .update_state
        .as_ref()
        .unwrap();
    assert!(state.candidate.is_none());
    assert_eq!(state.previous.len(), 1);
    assert_eq!(
        state.previous[0]
            .files
            .iter()
            .filter(|f| f.role == FileRole::PrivateDependency)
            .count(),
        1
    );
    assert!(updated.actions[0]["executable"]
        .as_str()
        .unwrap()
        .contains("v2"));
    assert!(apply_local(
        &mut manager,
        &json!({"action":"apply_resource_update_switch","previewId":plan["id"]})
    )
    .is_err());
}

#[test]
fn original_modified_unknown_or_data_files_block_switch_without_copying_or_deleting() {
    for kind in ["modified", "unknown", "data"] {
        let dir = fixture();
        let mut manager = Manager::new(dir.path().join("data")).unwrap();
        let mut record = installed(&mut manager, dir.path());
        if kind == "modified" {
            fs::write(
                Path::new(&record.root_path).join("bin/tool.exe"),
                "local-edits",
            )
            .unwrap();
        }
        if kind == "unknown" {
            fs::write(
                Path::new(&record.root_path).join("login.json"),
                "private local contents",
            )
            .unwrap();
        }
        if kind == "data" {
            record.installation.as_mut().unwrap().files[0].role = FileRole::Configuration;
            record = save_record(&manager, record).unwrap();
        }
        let before = inventory(Path::new(&record.root_path)).unwrap();
        let record = staged(&mut manager, dir.path(), &record);
        let mut called = false;
        assert!(
            validate_candidate_with(&manager, &record.id, "synthetic", |_| {
                called = true;
                Ok(())
            })
            .is_err()
        );
        assert!(!called);
        assert_eq!(inventory(Path::new(&record.root_path)).unwrap(), before);
        assert!(!dir.path().join("v2/login.json").exists());
        assert_eq!(
            read(&manager, &record.id).unwrap().version.as_deref(),
            Some("v1")
        );
    }
}

#[test]
fn preview_drift_policy_or_file_changes_prevent_staging() {
    for change in ["local", "archive", "policy", "destination"] {
        let dir = fixture();
        let mut manager = Manager::new(dir.path().join("data")).unwrap();
        let mut record = installed(&mut manager, dir.path());
        let req = request(dir.path(), &record);
        let plan = handle(&mut manager, &req).unwrap().unwrap();
        match change {
            "local" => fs::write(
                Path::new(&record.root_path).join("bin/tool.exe"),
                "late edits",
            )
            .unwrap(),
            "archive" => {
                zip(dir.path(), "v2.zip", "replaced-upstream");
            }
            "destination" => {
                fs::create_dir(dir.path().join("v2")).unwrap();
                fs::write(dir.path().join("v2/user.txt"), "preserve").unwrap();
            }
            _ => {
                record.update_policy["pinnedVersion"] = json!("v1");
                save_record(&manager, record.clone()).unwrap();
            }
        }
        assert!(apply_local(
            &mut manager,
            &json!({"action":"apply_resource_update_stage","previewId":plan["id"]})
        )
        .is_err());
        assert_eq!(
            read(&manager, &record.id).unwrap().version.as_deref(),
            Some("v1")
        );
        if change != "destination" {
            assert!(!dir.path().join("v2").exists());
        }
    }
}

#[test]
fn failed_or_mutating_probe_cannot_leave_applicable_validation() {
    let dir = fixture();
    let mut manager = Manager::new(dir.path().join("data")).unwrap();
    let record = installed(&mut manager, dir.path());
    let record = set_actions(&manager, record);
    let record = staged(&mut manager, dir.path(), &record);
    assert!(
        validate_candidate_with(&manager, &record.id, "synthetic", |_| Err(
            "probe failed".into()
        ))
        .is_err()
    );
    assert!(candidate(&read(&manager, &record.id).unwrap())
        .unwrap()
        .validation
        .is_none());
    assert!(
        validate_candidate_with(&manager, &record.id, "synthetic", |target| {
            fs::write(target.root.join("bin/tool.exe"), "mutated by probe").unwrap();
            Ok(())
        })
        .is_err()
    );
    assert!(candidate(&read(&manager, &record.id).unwrap())
        .unwrap()
        .validation
        .is_none());
}

#[test]
fn validated_candidate_changes_and_relation_changes_make_old_switch_preview_inert() {
    for change in ["candidate", "relations", "record"] {
        let dir = fixture();
        let mut manager = Manager::new(dir.path().join("data")).unwrap();
        let record = installed(&mut manager, dir.path());
        let record = set_actions(&manager, record);
        let record = staged(&mut manager, dir.path(), &record);
        let checked = verify(&manager, &record.id);
        let plan=handle(&mut manager,&json!({"action":"preview_resource_update_switch","id":record.id,"expectedRevision":checked.revision})).unwrap().unwrap();
        assert_eq!(plan["canApply"], true);
        if change == "candidate" {
            fs::write(dir.path().join("v2/bin/tool.exe"), "changed").unwrap();
        } else if change == "record" {
            let mut updated = checked;
            updated.enabled = false;
            save_record(&manager, updated).unwrap();
        } else {
            manager
                .state
                .skills
                .push(json!({"id":"consumer","name":"consumer"}));
            manager.save().unwrap();
            manager
                .relation_store(crate::resource_relations::StoreRequest::Add {
                    dependent: crate::resource_relations::Endpoint {
                        kind: "skill".into(),
                        id: "consumer".into(),
                    },
                    dependency: crate::resource_relations::Endpoint {
                        kind: "tool".into(),
                        id: record.id.clone(),
                    },
                    expected_revision: relations(&manager, &record.id).unwrap()["revision"]
                        .as_u64()
                        .unwrap(),
                })
                .unwrap();
        }
        assert!(apply_local(
            &mut manager,
            &json!({"action":"apply_resource_update_switch","previewId":plan["id"]})
        )
        .is_err());
        assert_eq!(
            read(&manager, &record.id).unwrap().version.as_deref(),
            Some("v1")
        );
    }
}

#[test]
fn external_action_paths_and_overlapping_destinations_require_explicit_adapter_work() {
    let dir = fixture();
    let mut manager = Manager::new(dir.path().join("data")).unwrap();
    let mut record = installed(&mut manager, dir.path());
    let external = dir.path().join("external.exe");
    fs::write(&external, "external shared dependency").unwrap();
    record.actions = vec![
        json!({"id":"run","label":"External","mode":"task","executable":external,"workingDirectory":crate::local::canonical(Path::new(&record.root_path)).unwrap()}),
    ];
    record = save_record(&manager, record).unwrap();
    let record = staged(&mut manager, dir.path(), &record);
    assert!(validate_candidate_with(&manager, &record.id, "synthetic", |_| Ok(())).is_err());
    assert_eq!(
        fs::read_to_string(external).unwrap(),
        "external shared dependency"
    );
    let mut req = request(dir.path(), &record);
    req["destinationPath"] = json!(dir.path().join("data/candidate"));
    assert!(handle(&mut manager, &req).is_err());
}

#[test]
fn basic_mode_and_forged_requests_do_not_create_or_switch_candidates() {
    let dir = fixture();
    let mut manager = Manager::new(dir.path().join("data")).unwrap();
    let record = installed(&mut manager, dir.path());
    let mut req = request(dir.path(), &record);
    req["validated"] = json!(true);
    assert!(handle(&mut manager, &req).is_err());
    req.as_object_mut().unwrap().remove("validated");
    manager.basic_mode = true;
    assert!(handle(&mut manager, &req).is_err());
    assert!(!dir.path().join("v2").exists());
}

#[test]
fn failed_candidate_created_paths_survive_restart_and_explicit_abandon_allows_fresh_stage() {
    let dir = fixture();
    let mut manager = Manager::new(dir.path().join("data")).unwrap();
    let record = installed(&mut manager, dir.path());
    let plan = handle(&mut manager, &request(dir.path(), &record))
        .unwrap()
        .unwrap();
    let prepared: PreparedStage =
        serde_json::from_value(manager.previews[plan["id"].as_str().unwrap()]["prepared"].clone())
            .unwrap();
    let partial = dir.path().join("v2/bin/tool.exe");
    let result = stage_with(&manager, prepared, |_, _, _, destination| {
        fs::create_dir(destination).unwrap();
        fs::create_dir(destination.join("bin")).unwrap();
        fs::write(&partial, "partial candidate bytes").unwrap();
        Ok(resource_files::InstallReceipt {
            root: destination.to_owned(),
            files: vec![],
            created_paths: vec![destination.to_owned(), partial.clone()],
            complete: false,
            error: Some("synthetic interrupted write".into()),
        })
    })
    .unwrap();
    assert_eq!(result["complete"], false);
    drop(manager);
    let mut manager = Manager::new(dir.path().join("data")).unwrap();
    let current = read(&manager, &record.id).unwrap();
    let candidate = current
        .installation
        .as_ref()
        .unwrap()
        .update_state
        .as_ref()
        .unwrap()
        .candidate
        .as_ref()
        .unwrap();
    assert!(!candidate.complete);
    assert!(candidate.created_paths.contains(&partial));
    let partial_manifest = candidate.resource_manifest.clone().unwrap();
    crate::resource_manifest::validate_owned(&candidate.root, &partial_manifest).unwrap();
    assert!(candidate
        .created_paths
        .contains(&candidate.root.join(crate::resource_manifest::NAME)));
    let partial_index: Value = serde_json::from_slice(
        &fs::read(candidate.root.join(crate::resource_manifest::NAME)).unwrap(),
    )
    .unwrap();
    assert_eq!(partial_index["complete"], false);
    let preview=handle(&mut manager,&json!({"action":"preview_resource_update_abandon","id":record.id,"expectedRevision":current.revision})).unwrap().unwrap();
    assert_eq!(preview["canApply"], true);
    assert!(partial.is_file());
    assert!(apply_local(&mut manager,&json!({"action":"apply_resource_update_abandon","previewId":preview["id"],"deleteFiles":true})).is_err());
    let result = apply_local(
        &mut manager,
        &json!({"action":"apply_resource_update_abandon","previewId":preview["id"]}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(result["deleted"], json!([]));
    assert_eq!(
        fs::read_to_string(&partial).unwrap(),
        "partial candidate bytes"
    );
    drop(manager);
    let mut manager = Manager::new(dir.path().join("data")).unwrap();
    let current = read(&manager, &record.id).unwrap();
    let state = current
        .installation
        .as_ref()
        .unwrap()
        .update_state
        .as_ref()
        .unwrap();
    assert!(state.candidate.is_none());
    assert_eq!(state.retained_candidates.len(), 1);
    assert_eq!(
        state.retained_candidates[0].candidate.resource_manifest,
        Some(partial_manifest)
    );
    assert!(state.retained_candidates[0]
        .candidate
        .created_paths
        .contains(&partial));
    let mut next = request(dir.path(), &current);
    next["destinationPath"] = json!(dir.path().join("v2-retry"));
    let plan = handle(&mut manager, &next).unwrap().unwrap();
    let result = apply_local(
        &mut manager,
        &json!({"action":"apply_resource_update_stage","previewId":plan["id"]}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(result["complete"], true);
    assert_eq!(result["resource"]["version"], "v1");
    let final_record = read(&manager, &record.id).unwrap();
    assert_eq!(
        final_record
            .installation
            .unwrap()
            .update_state
            .unwrap()
            .retained_candidates
            .len(),
        1
    );
    assert_eq!(
        fs::read_to_string(&partial).unwrap(),
        "partial candidate bytes"
    );
}

#[test]
fn abandon_confirmation_is_revision_bound_and_retained_paths_cannot_be_reused() {
    let dir = fixture();
    let mut manager = Manager::new(dir.path().join("data")).unwrap();
    let original = installed(&mut manager, dir.path());
    let record = staged(&mut manager, dir.path(), &original);
    let preview=handle(&mut manager,&json!({"action":"preview_resource_update_abandon","id":record.id,"expectedRevision":record.revision})).unwrap().unwrap();
    let mut changed = record.clone();
    changed.notes = "new local note".into();
    let changed = save_record(&manager, changed).unwrap();
    assert!(apply_local(
        &mut manager,
        &json!({"action":"apply_resource_update_abandon","previewId":preview["id"]})
    )
    .is_err());
    let preview=handle(&mut manager,&json!({"action":"preview_resource_update_abandon","id":record.id,"expectedRevision":changed.revision})).unwrap().unwrap();
    apply_local(
        &mut manager,
        &json!({"action":"apply_resource_update_abandon","previewId":preview["id"]}),
    )
    .unwrap();
    let current = read(&manager, &record.id).unwrap();
    let mut next = request(dir.path(), &current);
    next["destinationPath"] = json!(dir.path().join("v2/nested"));
    assert!(handle(&mut manager, &next).is_err());
    assert!(dir.path().join("v2/bin/tool.exe").is_file());
    assert_eq!(read(&manager, &record.id).unwrap().notes, "new local note");
}

#[test]
fn switching_keeps_repair_path_indices_and_latest_probe_failure_invalidates_success() {
    let dir = fixture();
    let mut manager = Manager::new(dir.path().join("data")).unwrap();
    let mut record = installed(&mut manager, dir.path());
    let repaired = dir.path().join("retained-repair-part");
    fs::write(&repaired, "retained failed repair bytes").unwrap();
    record
        .installation
        .as_mut()
        .unwrap()
        .retained_repair_files
        .push(repaired.clone());
    let record = save_record(&manager, record).unwrap();
    let record = set_actions(&manager, record);
    let record = staged(&mut manager, dir.path(), &record);
    let verified = verify(&manager, &record.id);
    assert!(
        validate_candidate_with(&manager, &record.id, "synthetic", |_| Err(
            "latest probe failed".into()
        ))
        .is_err()
    );
    let after_failure = read(&manager, &record.id).unwrap();
    assert!(candidate(&after_failure).unwrap().validation.is_none());
    assert!(after_failure.revision > verified.revision);
    let verified = verify(&manager, &record.id);
    let preview=handle(&mut manager,&json!({"action":"preview_resource_update_switch","id":record.id,"expectedRevision":verified.revision})).unwrap().unwrap();
    let result = apply_local_with(
        &mut manager,
        &json!({"action":"apply_resource_update_switch","previewId":preview["id"]}),
        fixture_post_probe,
        fixture_restored_probe,
    )
    .unwrap()
    .unwrap();
    assert_eq!(result["complete"], true);
    let final_record = read(&manager, &record.id).unwrap();
    let state = final_record.installation.unwrap().update_state.unwrap();
    assert_eq!(
        state.previous[0].retained_repair_files,
        vec![repaired.clone()]
    );
    assert_eq!(
        fs::read_to_string(repaired).unwrap(),
        "retained failed repair bytes"
    );
}

fn shared_node_fixture() -> (tempfile::TempDir, ResourceRecord, Candidate, PathBuf) {
    let dir = fixture();
    let mut manager = Manager::new(dir.path().join("data")).unwrap();
    let original = installed(&mut manager, dir.path());
    let mut record = staged(&mut manager, dir.path(), &original);
    let mut next = candidate(&record).unwrap().clone();
    let old_root = PathBuf::from(&record.root_path);
    for root in [&old_root, &next.root] {
        let cli = root.join("node_modules/@playwright/mcp/cli.js");
        fs::create_dir_all(cli.parent().unwrap()).unwrap();
        fs::write(cli, "synthetic CLI, never executed").unwrap();
    }
    let node = dir.path().join("node.exe");
    fs::write(&node, "synthetic shared Node, never executed").unwrap();
    let source = DownloadSource {
        repository: "https://github.com/microsoft/playwright-mcp".into(),
        version: "v2".into(),
        verification: "githubAsset".into(),
        author: "microsoft".into(),
        release_id: 1,
        asset_id: 2,
        asset_name: "fixture.zip".into(),
        download_url:
            "https://github.com/microsoft/playwright-mcp/releases/download/v2/fixture.zip".into(),
        sha256: "a".repeat(64),
        expected_sha256: None,
    };
    record.installation.as_mut().unwrap().download_source = Some(source.clone());
    next.download_source = Some(source);
    record.actions = vec![
        json!({"id":"mcp","label":"Synthetic fixed Node entry","mode":"service",
        "executable":crate::local::canonical(&node).unwrap(),"executableSha256":resource_files::fingerprint(&node).unwrap().sha256,
        "workingDirectory":crate::local::canonical(&old_root).unwrap(),
        "args":[{"type":"literal","value":crate::local::canonical(&old_root.join("node_modules/@playwright/mcp/cli.js")).unwrap()},
            {"type":"literal","value":"--extension"}],"parameters":[]}),
    ];
    (dir, record, next, node)
}

#[test]
fn fixed_shared_node_keeps_original_hash_and_rebases_only_registered_cli() {
    let (_dir, record, next, node) = shared_node_fixture();
    let actions = new_actions(&record, &next).unwrap();
    assert_eq!(
        Path::new(actions[0]["executable"].as_str().unwrap()),
        crate::local::canonical(&node).unwrap()
    );
    assert_eq!(
        actions[0]["executableSha256"],
        record.actions[0]["executableSha256"]
    );
    assert_eq!(
        Path::new(actions[0]["args"][0]["value"].as_str().unwrap()),
        crate::local::canonical(&next.root.join("node_modules/@playwright/mcp/cli.js")).unwrap()
    );
    assert_eq!(actions[0]["args"][1]["value"], "--extension");
}

#[test]
fn changed_shared_node_or_other_external_executable_is_refused() {
    let (dir, mut record, next, node) = shared_node_fixture();
    fs::write(&node, "different Node bytes").unwrap();
    assert!(new_actions(&record, &next).is_err());
    let other = dir.path().join("other.exe");
    fs::write(&other, "synthetic external executable").unwrap();
    record.actions[0]["executable"] = json!(crate::local::canonical(&other).unwrap());
    record.actions[0]["executableSha256"] =
        json!(resource_files::fingerprint(&other).unwrap().sha256);
    assert!(new_actions(&record, &next).is_err());
}

#[test]
fn shared_node_requires_same_verified_source_and_exact_first_cli_argument() {
    let (_dir, mut record, mut next, _) = shared_node_fixture();
    next.download_source.as_mut().unwrap().repository =
        "https://github.com/untrusted/playwright-mcp".into();
    assert!(new_actions(&record, &next).is_err());
    next.download_source.as_mut().unwrap().repository =
        "https://github.com/microsoft/playwright-mcp".into();
    record
        .installation
        .as_mut()
        .unwrap()
        .download_source
        .as_mut()
        .unwrap()
        .verification = "userProvided".into();
    assert!(new_actions(&record, &next).is_err());
    record
        .installation
        .as_mut()
        .unwrap()
        .download_source
        .as_mut()
        .unwrap()
        .verification = "githubAsset".into();
    record.actions[0]["args"][0]["value"] =
        json!(Path::new(&record.root_path).join("bin/tool.exe"));
    assert!(new_actions(&record, &next).is_err());
}

#[test]
fn native_switch_without_supported_probe_restores_entry_without_claiming_verified_rollback() {
    let dir = fixture();
    let mut manager = Manager::new(dir.path().join("data")).unwrap();
    let record = installed(&mut manager, dir.path());
    let record = set_actions(&manager, record);
    let original = inventory(Path::new(&record.root_path)).unwrap();
    let record = staged(&mut manager, dir.path(), &record);
    let checked = verify(&manager, &record.id);
    let plan=handle(&mut manager,&json!({"action":"preview_resource_update_switch","id":record.id,"expectedRevision":checked.revision})).unwrap().unwrap();
    let result = apply_local(
        &mut manager,
        &json!({"action":"apply_resource_update_switch","previewId":plan["id"]}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(result["complete"], false);
    assert_eq!(result["rolledBack"], false);
    assert_eq!(result["entryRestored"], true);
    assert_eq!(result["rollbackVerified"], false);
    assert!(result["rollbackBlockedReason"]
        .as_str()
        .unwrap()
        .contains("只读候选验证适配器"));
    assert_eq!(result["switched"], false);
    assert_eq!(result["postSwitchVerified"], false);
    assert!(result["error"]
        .as_str()
        .unwrap()
        .contains("只读候选验证适配器"));
    assert_eq!(inventory(Path::new(&record.root_path)).unwrap(), original);
    assert!(dir.path().join("v2/private/runtime.dll").is_file());
    drop(manager);
    let manager = Manager::new(dir.path().join("data")).unwrap();
    let current = read(&manager, &record.id).unwrap();
    assert_eq!(current.version.as_deref(), Some("v1"));
    let state = current
        .installation
        .as_ref()
        .unwrap()
        .update_state
        .as_ref()
        .unwrap();
    assert_eq!(
        state.switch_check.as_ref().unwrap().status,
        "rollbackUnverified"
    );
    assert!(state.switch_check.as_ref().unwrap().adapter.is_none());
    assert!(state
        .switch_check
        .as_ref()
        .unwrap()
        .verified_scopes
        .is_empty());
    assert!(state.last_failure.is_some());
    assert!(state.candidate.as_ref().unwrap().validation.is_none());
    assert!(state
        .candidate
        .as_ref()
        .unwrap()
        .root
        .join("bin/tool.exe")
        .is_file());
}

#[test]
fn actual_post_probe_failure_rolls_back_only_unchanged_entry_and_files() {
    let dir = fixture();
    let mut manager = Manager::new(dir.path().join("data")).unwrap();
    let record = installed(&mut manager, dir.path());
    let record = set_actions(&manager, record);
    let record = staged(&mut manager, dir.path(), &record);
    let checked = verify(&manager, &record.id);
    let mut ran = false;
    let result = switch_with(
        &manager,
        &json!(checked),
        |original, actual| {
            ran = true;
            assert_eq!(
                read(&manager, &record.id).unwrap().root_path,
                actual.root_path
            );
            assert_ne!(actual.root_path, original.root_path);
            assert_eq!(actual.version.as_deref(), Some("v2"));
            assert_eq!(
                fs::read_to_string(Path::new(&actual.root_path).join("bin/tool.exe")).unwrap(),
                "version-two"
            );
            Err("synthetic actual post-switch failure".into())
        },
        fixture_restored_probe,
    )
    .unwrap();
    assert!(ran);
    assert_eq!(result["rolledBack"], true);
    assert_eq!(result["entryRestored"], true);
    assert_eq!(result["rollbackVerified"], true);
    let rollback = &result["resource"]["installation"]["updateState"]["switchCheck"];
    assert_eq!(rollback["adapter"], "synthetic-read-only-after-restore");
    assert_eq!(
        rollback["verifiedScopes"],
        json!(["syntheticRestoredFixtureRead"])
    );
    assert_eq!(result["resource"]["version"], "v1");
    assert_eq!(result["dataCopied"], false);
    assert_eq!(
        fs::read_to_string(Path::new(&record.root_path).join("bin/tool.exe")).unwrap(),
        "version-one"
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("v2/bin/tool.exe")).unwrap(),
        "version-two"
    );
    let current = read(&manager, &record.id).unwrap();
    assert!(candidate(&current).unwrap().validation.is_none());
    assert!(current
        .installation
        .unwrap()
        .update_state
        .unwrap()
        .last_failure
        .unwrap()
        .contains("post-switch failure"));
}

#[test]
fn failed_restored_probe_keeps_original_entry_but_invalidates_current_capability_evidence() {
    let dir = fixture();
    let mut manager = Manager::new(dir.path().join("data")).unwrap();
    let record = installed(&mut manager, dir.path());
    let mut record = set_actions(&manager, record);
    record.capabilities = vec![
        json!({"id":"cliVersion","status":"verified","verifiedAt":"prior-proof","evidence":"original runtime"}),
    ];
    let record = save_record(&manager, record).unwrap();
    let old_files = inventory(Path::new(&record.root_path)).unwrap();
    let record = staged(&mut manager, dir.path(), &record);
    let checked = verify(&manager, &record.id);
    let mut restored_ran = false;
    let result = switch_with(
        &manager,
        &json!(checked),
        |_, _| Err("synthetic new runtime failure".into()),
        |restored| {
            restored_ran = true;
            fixture_restored_probe(restored)?;
            assert_eq!(
                read(&manager, &record.id).unwrap().root_path,
                restored.root_path
            );
            Err("synthetic restored runtime failure".into())
        },
    )
    .unwrap();
    assert!(restored_ran);
    assert_eq!(result["rolledBack"], false);
    assert_eq!(result["entryRestored"], true);
    assert_eq!(result["rollbackVerified"], false);
    assert_eq!(result["switched"], false);
    assert_eq!(result["resource"]["rootPath"], record.root_path);
    assert_eq!(inventory(Path::new(&record.root_path)).unwrap(), old_files);
    assert!(dir.path().join("v2/bin/tool.exe").is_file());
    assert!(result["rollbackBlockedReason"]
        .as_str()
        .unwrap()
        .contains("synthetic restored runtime failure"));
    let live = read(&manager, &record.id).unwrap();
    let check = live
        .installation
        .as_ref()
        .unwrap()
        .update_state
        .as_ref()
        .unwrap()
        .switch_check
        .as_ref()
        .unwrap();
    assert_eq!(check.status, "rollbackUnverified");
    assert!(check.adapter.is_none());
    assert!(check.verified_scopes.is_empty());
    assert_eq!(live.capabilities[0]["status"], "unverified");
    assert!(live.capabilities[0]["verifiedAt"].is_null());
    assert_eq!(
        live.capabilities[0]["historicalEvidence"]["verifiedAt"],
        "prior-proof"
    );
    assert_eq!(
        live.capabilities[0]["historicalEvidence"]["evidence"],
        "original runtime"
    );
}

#[test]
fn restored_probe_drift_cannot_claim_verified_rollback_or_overwrite_concurrent_changes() {
    for change in ["originalFile", "catalog"] {
        let dir = fixture();
        let mut manager = Manager::new(dir.path().join("data")).unwrap();
        let record = installed(&mut manager, dir.path());
        let record = set_actions(&manager, record);
        let record = staged(&mut manager, dir.path(), &record);
        let checked = verify(&manager, &record.id);
        let result = switch_with(
            &manager,
            &json!(checked),
            |_, _| Err("synthetic new runtime failure".into()),
            |restored| {
                let evidence = fixture_restored_probe(restored)?;
                if change == "originalFile" {
                    fs::write(
                        Path::new(&restored.root_path).join("bin/tool.exe"),
                        "concurrent original edit",
                    )
                    .unwrap();
                } else {
                    let mut latest = read(&manager, &record.id).unwrap();
                    latest.notes = "concurrent restored entry note".into();
                    save_record(&manager, latest).unwrap();
                }
                Ok(evidence)
            },
        )
        .unwrap();
        assert_eq!(result["rolledBack"], false, "{change}");
        assert_eq!(result["entryRestored"], true, "{change}");
        assert_eq!(result["rollbackVerified"], false, "{change}");
        let live = read(&manager, &record.id).unwrap();
        assert_eq!(live.root_path, record.root_path);
        let check = live
            .installation
            .as_ref()
            .unwrap()
            .update_state
            .as_ref()
            .unwrap()
            .switch_check
            .as_ref()
            .unwrap();
        assert_eq!(check.status, "rollbackUnverified");
        assert!(check.adapter.is_none());
        assert!(check.verified_scopes.is_empty());
        assert!(result["rollbackBlockedReason"]
            .as_str()
            .is_some_and(|reason| !reason.is_empty()));
        if change == "originalFile" {
            assert_eq!(
                fs::read_to_string(Path::new(&live.root_path).join("bin/tool.exe")).unwrap(),
                "concurrent original edit"
            );
        } else {
            assert_eq!(live.notes, "concurrent restored entry note");
        }
    }
}

#[test]
fn post_switch_drift_never_claims_rollback_or_overwrites_local_changes() {
    for change in [
        "candidateFile",
        "unknownFile",
        "candidateRoot",
        "oldFile",
        "oldRoot",
        "catalog",
        "policy",
        "relation",
    ] {
        let dir = fixture();
        let mut manager = Manager::new(dir.path().join("data")).unwrap();
        manager
            .state
            .skills
            .push(json!({"id":"consumer","name":"consumer"}));
        manager.save().unwrap();
        let record = installed(&mut manager, dir.path());
        let record = set_actions(&manager, record);
        let record = staged(&mut manager, dir.path(), &record);
        let checked = verify(&manager, &record.id);
        let result = switch_with(
            &manager,
            &json!(checked),
            |_, actual| {
                let evidence = fixture_post_probe(&checked, actual)?;
                match change {
                    "candidateFile" => fs::write(
                        Path::new(&actual.root_path).join("bin/tool.exe"),
                        "new local candidate edit",
                    )
                    .unwrap(),
                    "unknownFile" => fs::write(
                        Path::new(&actual.root_path).join("user-data.txt"),
                        "new user data",
                    )
                    .unwrap(),
                    "candidateRoot" => {
                        fs::rename(&actual.root_path, dir.path().join("candidate-moved")).unwrap();
                        fs::create_dir_all(Path::new(&actual.root_path).join("bin")).unwrap();
                        fs::write(
                            Path::new(&actual.root_path).join("bin/tool.exe"),
                            "replacement directory",
                        )
                        .unwrap();
                    }
                    "oldFile" => fs::write(
                        Path::new(&record.root_path).join("bin/tool.exe"),
                        "new local old edit",
                    )
                    .unwrap(),
                    "oldRoot" => {
                        fs::rename(&record.root_path, dir.path().join("old-moved")).unwrap();
                        fs::create_dir_all(Path::new(&record.root_path).join("bin")).unwrap();
                        fs::write(
                            Path::new(&record.root_path).join("bin/tool.exe"),
                            "replacement old directory",
                        )
                        .unwrap();
                    }
                    "catalog" | "policy" => {
                        let mut edited = read(&manager, &record.id).unwrap();
                        if change == "catalog" {
                            edited.notes = "concurrent user note".into();
                        } else {
                            edited.update_policy =
                                json!({"mode":"manual","checkIntervalMinutes":120});
                        }
                        save_record(&manager, edited).unwrap();
                    }
                    "relation" => {
                        manager
                            .relation_store(crate::resource_relations::StoreRequest::Add {
                                dependent: crate::resource_relations::Endpoint {
                                    kind: "skill".into(),
                                    id: "consumer".into(),
                                },
                                dependency: crate::resource_relations::Endpoint {
                                    kind: "tool".into(),
                                    id: record.id.clone(),
                                },
                                expected_revision: relations(&manager, &record.id).unwrap()
                                    ["revision"]
                                    .as_u64()
                                    .unwrap(),
                            })
                            .unwrap();
                    }
                    _ => unreachable!(),
                }
                Ok(evidence)
            },
            |_| panic!("post-switch drift must prevent any restored-version probe"),
        )
        .unwrap();
        assert_eq!(result["complete"], false, "{change}: {result}");
        assert_eq!(result["rolledBack"], false, "{change}: {result}");
        assert_eq!(result["postSwitchVerified"], false);
        assert!(result["rollbackBlockedReason"]
            .as_str()
            .is_some_and(|s| !s.is_empty()));
        let live = read(&manager, &record.id).unwrap();
        assert_eq!(live.version.as_deref(), Some("v2"));
        assert_eq!(
            live.installation
                .as_ref()
                .unwrap()
                .update_state
                .as_ref()
                .unwrap()
                .switch_check
                .as_ref()
                .unwrap()
                .status,
            "rollbackBlocked"
        );
        if change == "candidateFile" {
            assert_eq!(
                fs::read_to_string(Path::new(&live.root_path).join("bin/tool.exe")).unwrap(),
                "new local candidate edit"
            );
        }
        if change == "unknownFile" {
            assert_eq!(
                fs::read_to_string(Path::new(&live.root_path).join("user-data.txt")).unwrap(),
                "new user data"
            );
        }
        if change == "oldFile" {
            assert_eq!(
                fs::read_to_string(Path::new(&record.root_path).join("bin/tool.exe")).unwrap(),
                "new local old edit"
            );
        }
        if change == "catalog" {
            assert_eq!(live.notes, "concurrent user note");
        }
        if change == "policy" {
            assert_eq!(live.update_policy["checkIntervalMinutes"], 120);
        }
        if change == "oldRoot" {
            assert!(dir.path().join("old-moved/private/runtime.dll").is_file());
        }
        if change == "candidateRoot" {
            assert!(dir
                .path()
                .join("candidate-moved/private/runtime.dll")
                .is_file());
        }
    }
}

fn checked_node_fixture() -> (tempfile::TempDir, Manager, ResourceRecord, PathBuf) {
    let (dir, mut record, mut next, node) = shared_node_fixture();
    let manager = Manager::new(dir.path().join("data")).unwrap();
    let relative = "node_modules/@playwright/mcp/cli.js";
    record.installation.as_mut().unwrap().files.push(OwnedFile {
        path: relative.into(),
        role: FileRole::Runtime,
        installed_sha256: resource_files::fingerprint(&Path::new(&record.root_path).join(relative))
            .unwrap()
            .sha256,
    });
    next.files.push(OwnedFile {
        path: relative.into(),
        role: FileRole::Runtime,
        installed_sha256: resource_files::fingerprint(&next.root.join(relative))
            .unwrap()
            .sha256,
    });
    next.original = baseline(&manager, &record).unwrap();
    record
        .installation
        .as_mut()
        .unwrap()
        .update_state
        .as_mut()
        .unwrap()
        .candidate = Some(next);
    let record = save_record(&manager, record).unwrap();
    let checked: ResourceRecord = serde_json::from_value(
        validate_candidate_with(&manager, &record.id, "synthetic-shared-node", |target| {
            assert_eq!(target.files.len(), 4);
            assert_eq!(target.actions.len(), 1);
            Ok(())
        })
        .unwrap()["resource"]
            .clone(),
    )
    .unwrap();
    (dir, manager, checked, node)
}

#[test]
fn post_switch_shared_node_drift_blocks_rollback_and_retains_both_versions() {
    let (dir, manager, checked, node) = checked_node_fixture();
    let result = switch_with(
        &manager,
        &json!(checked),
        |_, _| {
            fs::write(&node, "shared Node changed during post validation").unwrap();
            Ok(ProbeEvidence {
                adapter: "synthetic-shared-node".into(),
                verified_scopes: vec!["syntheticFixtureRead".into()],
            })
        },
        |_| panic!("changed shared runtime must prevent a restored-version probe"),
    )
    .unwrap();
    assert_eq!(result["rolledBack"], false);
    assert_eq!(result["complete"], false);
    assert!(result["rollbackBlockedReason"]
        .as_str()
        .unwrap()
        .contains("共享执行环境"));
    assert!(dir.path().join("v1/private/runtime.dll").is_file());
    assert!(dir.path().join("v2/private/runtime.dll").is_file());
    assert_eq!(
        fs::read_to_string(node).unwrap(),
        "shared Node changed during post validation"
    );
}

#[test]
fn replacing_shared_node_with_same_bytes_invalidates_pre_switch_proof() {
    let (dir, manager, checked, node) = checked_node_fixture();
    let content = fs::read(&node).unwrap();
    fs::rename(&node, dir.path().join("original-shared-node-object.exe")).unwrap();
    fs::write(&node, &content).unwrap();
    assert_eq!(
        resource_files::fingerprint(&node).unwrap().sha256,
        checked.actions[0]["executableSha256"].as_str().unwrap()
    );
    assert!(new_actions(&checked, candidate(&checked).unwrap()).is_ok());
    assert!(verified(&manager, &checked)
        .unwrap_err()
        .contains("隔离验证已失效"));
    assert!(switch_with(
        &manager,
        &json!(checked),
        fixture_post_probe,
        fixture_restored_probe
    )
    .is_err());
    assert_eq!(
        read(&manager, &checked.id).unwrap().version.as_deref(),
        Some("v1")
    );
}

#[test]
fn candidate_manifest_path_is_previewed_and_exact_receipt_survives_switch() {
    let dir = fixture();
    let mut manager = Manager::new(dir.path().join("data")).unwrap();
    let record = installed(&mut manager, dir.path());
    let record = set_actions(&manager, record);
    let old_manifest = record
        .installation
        .as_ref()
        .unwrap()
        .resource_manifest
        .clone();
    let original = inventory(Path::new(&record.root_path)).unwrap();
    let preview = handle(&mut manager, &request(dir.path(), &record))
        .unwrap()
        .unwrap();
    assert_eq!(
        Path::new(preview["managementRecord"]["targetPath"].as_str().unwrap()),
        dir.path().join("v2").join(crate::resource_manifest::NAME)
    );
    assert!(!dir.path().join("v2").exists());
    let result = apply_local(
        &mut manager,
        &json!({"action":"apply_resource_update_stage","previewId":preview["id"]}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(result["complete"], true);
    let current = read(&manager, &record.id).unwrap();
    let staged = candidate(&current).unwrap();
    let manifest = staged.resource_manifest.clone().unwrap();
    crate::resource_manifest::validate_owned(&staged.root, &manifest).unwrap();
    assert!(staged
        .created_paths
        .contains(&staged.root.join(crate::resource_manifest::NAME)));
    assert!(!inventory_registered(&staged.root, Some(&manifest))
        .unwrap()
        .contains_key(crate::resource_manifest::NAME));
    assert!(inventory(&staged.root)
        .unwrap()
        .contains_key(crate::resource_manifest::NAME));
    assert_eq!(inventory(Path::new(&record.root_path)).unwrap(), original);
    let checked = verify(&manager, &record.id);
    assert_eq!(
        candidate(&checked)
            .unwrap()
            .validation
            .as_ref()
            .unwrap()
            .resource_manifest
            .as_ref(),
        Some(&manifest)
    );
    let result = switch_with(
        &manager,
        &json!(checked),
        fixture_post_probe,
        fixture_restored_probe,
    )
    .unwrap();
    assert_eq!(result["complete"], true);
    let installed = read(&manager, &record.id).unwrap().installation.unwrap();
    assert_eq!(installed.resource_manifest, Some(manifest));
    assert_eq!(
        installed.update_state.unwrap().previous[0].resource_manifest,
        old_manifest
    );
}

#[test]
fn changed_candidate_manifest_invalidates_validation_without_ignoring_unknown_names() {
    let dir = fixture();
    let mut manager = Manager::new(dir.path().join("data")).unwrap();
    let record = installed(&mut manager, dir.path());
    let record = set_actions(&manager, record);
    let record = staged(&mut manager, dir.path(), &record);
    let checked = verify(&manager, &record.id);
    let root = &candidate(&checked).unwrap().root;
    let path = root.join(crate::resource_manifest::NAME);
    let mut content = fs::read(&path).unwrap();
    content.push(b' ');
    fs::write(&path, &content).unwrap();
    let preview=handle(&mut manager,&json!({"action":"preview_resource_update_switch","id":checked.id,"expectedRevision":checked.revision})).unwrap().unwrap();
    assert_eq!(preview["canApply"], false);
    assert!(inventory_registered(
        root,
        candidate(&checked).unwrap().resource_manifest.as_ref()
    )
    .is_err());
    let unknown = dir.path().join("unknown");
    fs::create_dir(&unknown).unwrap();
    fs::write(
        unknown.join(crate::resource_manifest::NAME),
        "unknown user file",
    )
    .unwrap();
    assert!(inventory_registered(&unknown, None)
        .unwrap()
        .contains_key(crate::resource_manifest::NAME));
    assert_eq!(
        fs::read_to_string(unknown.join(crate::resource_manifest::NAME)).unwrap(),
        "unknown user file"
    );
}

#[test]
fn same_name_metadata_collision_keeps_unverified_path_without_claiming_ownership() {
    let dir = fixture();
    let mut manager = Manager::new(dir.path().join("data")).unwrap();
    let record = installed(&mut manager, dir.path());
    let preview = handle(&mut manager, &request(dir.path(), &record))
        .unwrap()
        .unwrap();
    let prepared: PreparedStage = serde_json::from_value(
        manager.previews[preview["id"].as_str().unwrap()]["prepared"].clone(),
    )
    .unwrap();
    let result = stage_with(
        &manager,
        prepared,
        |archive, inventory, selected, destination| {
            let receipt = resource_files::install_zip(archive, inventory, selected, destination)?;
            fs::write(
                destination.join(crate::resource_manifest::NAME),
                "concurrent user metadata",
            )
            .unwrap();
            Ok(receipt)
        },
    )
    .unwrap();
    assert_eq!(result["complete"], false);
    let current = read(&manager, &record.id).unwrap();
    let staged = current
        .installation
        .as_ref()
        .unwrap()
        .update_state
        .as_ref()
        .unwrap()
        .candidate
        .as_ref()
        .unwrap();
    let path = staged.root.join(crate::resource_manifest::NAME);
    assert_eq!(staged.unverified_manifest_path.as_ref(), Some(&path));
    assert!(staged.resource_manifest.is_none());
    assert!(!staged.created_paths.contains(&path));
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "concurrent user metadata"
    );
    drop(manager);
    let manager = Manager::new(dir.path().join("data")).unwrap();
    assert_eq!(
        read(&manager, &record.id)
            .unwrap()
            .installation
            .unwrap()
            .update_state
            .unwrap()
            .candidate
            .unwrap()
            .unverified_manifest_path,
        Some(path)
    );
}

#[test]
fn package_metadata_cannot_be_selected_as_runtime_or_adopted_by_name() {
    let dir = fixture();
    let mut manager = Manager::new(dir.path().join("data")).unwrap();
    let record = installed(&mut manager, dir.path());
    let package = dir.path().join("with-metadata.zip");
    let mut zip = zip::ZipWriter::new(fs::File::create(&package).unwrap());
    for name in ["bin/tool.exe", crate::resource_manifest::NAME] {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"untrusted package entry").unwrap();
    }
    zip.finish().unwrap();
    let request = json!({"action":"preview_resource_update","id":record.id,"expectedRevision":record.revision,"archivePath":package,
        "destinationPath":dir.path().join("v2"),"version":"v2","selectedFiles":["bin/tool.exe",crate::resource_manifest::NAME]});
    assert!(handle(&mut manager, &request)
        .unwrap_err()
        .contains("管理记录"));
    assert!(!dir.path().join("v2").exists());
}

fn detached_location_dispatch(m: &mut Manager, request: &Value) -> Result<Value, String> {
    assert!(m.state.skills.is_empty());
    m.state.skills.push(json!({
        "id":"live-protected-skill","name":"Synthetic live Skill",
        "localPath":request["liveSkillRoot"]
    }));
    m.save()?;
    // A detached worker can retain its earlier in-memory view while the
    // single writer has already accepted a new registration.
    let saved = std::mem::take(&mut m.state.skills);
    assert_eq!(m.snapshot()["skills"].as_array().unwrap().len(), 1);
    let result = handle(m, &request["update"]);
    m.state.skills = saved;
    Ok(json!({"blocked":result.is_err(),"error":result.err()}))
}

#[test]
fn detached_update_location_check_uses_live_skill_registration() {
    let dir = fixture();
    let mut manager = Manager::new(dir.path().join("data")).unwrap();
    let record = installed(&mut manager, dir.path());
    let live_skill = dir.path().join("live-skill");
    fs::create_dir(&live_skill).unwrap();
    let mut update = request(dir.path(), &record);
    update["destinationPath"] = json!(live_skill.join("candidate"));
    let service = crate::tasks::TaskSystem::new(manager).unwrap();
    let outcome = service.execute(
        json!({"action":"synthetic_update_location_audit","liveSkillRoot":live_skill,"update":update}),
        detached_location_dispatch,
    ).unwrap();
    assert_eq!(outcome["blocked"], true);
    assert!(outcome["error"].as_str().unwrap().contains("Skill"));
    assert!(!live_skill.join("candidate").exists());
    assert_eq!(read_from_service_version(&service, &record.id), "v1");
}

fn read_from_service_version(
    service: &std::sync::Arc<crate::tasks::TaskSystem>,
    id: &str,
) -> String {
    fn read_dispatch(m: &mut Manager, request: &Value) -> Result<Value, String> {
        Ok(json!(read(m, request["id"].as_str().unwrap())?))
    }
    service
        .execute(json!({"action":"get_resource","id":id}), read_dispatch)
        .unwrap()["version"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn existing_candidate_exception_does_not_allow_descendants_or_another_resources_candidate() {
    let dir = fixture();
    let mut manager = Manager::new(dir.path().join("data")).unwrap();
    let record = installed(&mut manager, dir.path());
    let record = staged(&mut manager, dir.path(), &record);
    let candidate_root = candidate(&record).unwrap().root.clone();
    crate::resource_lifecycle::ensure_independent_update_destination(
        &manager,
        &candidate_root,
        &record.id,
    )
    .unwrap();
    assert!(
        crate::resource_lifecycle::ensure_independent_update_destination(
            &manager,
            &candidate_root.join("nested"),
            &record.id,
        )
        .is_err()
    );
    assert!(
        crate::resource_lifecycle::ensure_independent_update_destination(
            &manager,
            &candidate_root,
            "different-resource",
        )
        .is_err()
    );
    assert!(new_destination(&manager, &candidate_root, &record).is_err());

    let other = dir.path().join("other");
    fs::create_dir(&other).unwrap();
    let second = installed(&mut manager, &other);
    let second = set_actions(&manager, second);
    let second = staged(&mut manager, &other, &second);
    let checked = verify(&manager, &second.id);
    let switched = switch_with(
        &manager,
        &json!(checked),
        fixture_post_probe,
        fixture_restored_probe,
    )
    .unwrap();
    assert_eq!(switched["complete"], true);
    assert!(
        new_destination(&manager, &other.join("v1/inside-history"), &record)
            .unwrap_err()
            .contains("保留运行版本")
    );
    assert!(!other.join("v1/inside-history").exists());
}
