use super::*;

fn fixture() -> tempfile::TempDir {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("work/resource-adapter-tests");
    fs::create_dir_all(&root).unwrap();
    tempfile::tempdir_in(root).unwrap()
}
fn write(root: &Path, relative: &str, bytes: impl AsRef<[u8]>) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}
fn reach(root: &Path) {
    for relative in [
        "Scripts/agent-reach.exe",
        "Scripts/python.exe",
        "pyvenv.cfg",
        "Lib/site-packages/agent_reach/cli.py",
        "Lib/site-packages/agent_reach/runtime/manage.py",
    ] {
        write(root, relative, "synthetic non-executable fixture");
    }
    write(
        root,
        "Lib/site-packages/agent_reach/__init__.py",
        "__version__ = \"1.6.0\"\n",
    );
    write(
        root,
        "Lib/site-packages/agent_reach/runtime/cli.py",
        "_cmd_channels\n_cmd_doctor\nversion\n",
    );
    write(root, "Lib/site-packages/agent_reach-1.6.0.dist-info/METADATA", "Name: agent-reach\nVersion: 1.6.0\nLicense: MIT\nProject-URL: Repository, https://github.com/Panniantong/agent-reach\n");
    write(
        root,
        "Lib/site-packages/agent_reach-1.6.0.dist-info/licenses/LICENSE",
        "MIT License\n",
    );
    write(root, "agent-reach.cmd", "@echo off\nsetlocal\nset \"PYTHONDONTWRITEBYTECODE=1\"\nset \"PATH=%~dp0Scripts;%PATH%\"\n\"%~dp0Scripts\\agent-reach.exe\" %*\nexit /b %errorlevel%\n");
    write(
        root,
        "data/private-session.json",
        "PRIVATE_SESSION_NEVER_READ_OR_EXPORTED",
    );
    write(root, "records/local-platform-fix.txt", "unique local fix");
}
fn edge(root: &Path, node: &Path) {
    write(root, EDGE_CLI, "synthetic CLI fixture, never executed");
    write(
        root,
        "node_modules/playwright-core/package.json",
        json!({"name":"playwright-core","version":"1.57.0","license":"Apache-2.0"}).to_string(),
    );
    write(
        root,
        "node_modules/playwright-core/lib/coreBundle.js",
        "synthetic lazy core bundle, never executed",
    );
    write(
        root,
        "node_modules/playwright-core/lib/utilsBundle.js",
        "synthetic lazy utils bundle, never executed",
    );
    write(root, "node_modules/@playwright/mcp/package.json", json!({"name":"@playwright/mcp","version":"0.0.83","license":"Apache-2.0","repository":{"url":"git+https://github.com/microsoft/playwright-mcp.git"}}).to_string());
    write(
        root,
        "node_modules/@playwright/mcp/LICENSE",
        "Apache License\nVersion 2.0",
    );
    write(root, "install-manifest.json", json!({"mode":"extension","browser":"msedge","nodePath":node,"profileDirectory":"Default","privateToken":"PRIVATE_TOKEN_NEVER_READ_OR_EXPORTED"}).to_string());
    write(
        root,
        "runtime/private.json",
        "PRIVATE_BROWSER_SESSION_NEVER_READ_OR_EXPORTED",
    );
    fs::write(node, "synthetic Node fixture, never execute").unwrap();
}
fn dragon(root: &Path) {
    write(
        root,
        "DragonCodexBoot.exe",
        "synthetic non-executable fixture",
    );
    write(root, "VERSION", "0.2.0\n");
    write(root, "launcher.json", json!({"DisplayName":"Dragon Codex Boot","AutoReplaceEntrypoints":true,"ScanAllLocalDrives":true,"Video":"media/startup.mp4"}).to_string());
    write(root, "LICENSE", "MIT License");
    write(root, "media/startup.mp4", "synthetic media");
    write(
        root,
        ".integration/unique-original-entry.txt",
        "unique integration state",
    );
}
fn tree(root: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
    fn walk(base: &Path, here: &Path, out: &mut std::collections::BTreeMap<String, Vec<u8>>) {
        for entry in fs::read_dir(here).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(base, &path, out);
            } else {
                out.insert(
                    path.strip_prefix(base)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    fs::read(path).unwrap(),
                );
            }
        }
    }
    let mut result = std::collections::BTreeMap::new();
    walk(root, root, &mut result);
    result
}
fn plan(m: &mut Manager, adapter: &str, root: &Path) -> Value {
    preview_local(
        m,
        &json!({"action":"preview_resource_adapter","adapter":adapter,"rootPath":root}),
    )
    .unwrap()
    .unwrap()
}
fn apply(m: &mut Manager, id: &Value) -> Result<Value, String> {
    apply_local(
        m,
        &json!({"action":"apply_resource_adapter","previewId":id}),
    )
    .map(Option::unwrap)
}
fn resource(m: &Manager, id: &Value) -> ResourceRecord {
    serde_json::from_value(
        m.resource_store(StoreRequest::Get(id.as_str().unwrap().into()))
            .unwrap(),
    )
    .unwrap()
}

fn refresh_plan(m: &mut Manager, record: &ResourceRecord) -> Result<Value, String> {
    preview_local(m, &json!({"action":"preview_resource_adapter","operation":"refreshNode","resourceId":record.id,"expectedRevision":record.revision}))
        .map(Option::unwrap)
}

fn save_record(m: &Manager, mut record: ResourceRecord) -> ResourceRecord {
    let expected_revision = record.revision;
    record.revision += 1;
    let id = json!(record.id);
    m.resource_store(StoreRequest::Replace {
        record: Box::new(record),
        expected_revision,
    })
    .unwrap();
    resource(m, &id)
}

#[test]
fn node_refresh_only_updates_runtime_proofs_and_preserves_the_complete_original_record() {
    let dir = fixture();
    let root = dir.path().join("edge");
    let node = dir.path().join("node.exe");
    edge(&root, &node);
    let mut m = Manager::new(dir.path().join("data")).unwrap();
    let p = plan(&mut m, EDGE, &root);
    let adopted = apply(&mut m, &p["id"]).unwrap();
    let mut prior = resource(&m, &adopted["resource"]["id"]);
    prior.name = "My Edge".into();
    prior.alias = "Personal browser".into();
    prior.notes = "Retain this note".into();
    prior.enabled = false;
    prior.repository = Some("https://github.com/synthetic/local-edge".into());
    prior.version = Some("local-0.0.83".into());
    prior.update_policy = json!({"mode":"manual","intervalHours":72,"customPolicy":"retain"});
    prior
        .capabilities
        .push(json!({"id":"custom","status":"unverified","note":"retain"}));
    prior.installation = Some(serde_json::from_value(json!({"schemaVersion":1,"installedAt":"original","archivePath":"D:/synthetic/original.zip","archiveSha256":"original-proof","sourceRepository":null,"sourceVersion":null,"files":[],"status":"installed","error":null})).unwrap());
    for action in &mut prior.actions {
        action["label"] = json!(format!("Personal {}", action["id"].as_str().unwrap()));
        action["timeoutSeconds"] = json!(90);
        action["idleReleaseSafe"] = json!(true);
        action["idleUsageTracked"] = json!(true);
        action["idleTimeoutSeconds"] = json!(45);
        action["customCatalogueMetadata"] = json!({"keep":"all original JSON"});
    }
    prior = save_record(&m, prior);
    let old_sha = prior.actions[0]["executableSha256"].clone();
    let replacement = dir.path().join("replacement.exe");
    fs::write(&replacement, "updated synthetic Node, never execute").unwrap();
    fs::remove_file(&node).unwrap();
    fs::rename(replacement, &node).unwrap();
    let before = tree(dir.path());
    let p = refresh_plan(&mut m, &prior).unwrap();
    assert_eq!(p["operation"], "refreshNode");
    assert_eq!(p["runtimeChange"]["previousSha256"], old_sha);
    assert_eq!(
        p["runtimeChange"]["currentSha256"],
        resource_files::fingerprint(&node).unwrap().sha256
    );
    assert_ne!(p["runtimeChange"]["currentSha256"], old_sha);
    assert!(!p.to_string().contains("PRIVATE_TOKEN_NEVER"));
    assert!(!p.to_string().contains("PRIVATE_BROWSER_SESSION_NEVER"));
    assert_eq!(
        json!(resource(&m, &adopted["resource"]["id"])),
        json!(prior)
    );
    let result = apply(&mut m, &p["id"]).unwrap();
    assert_eq!(result["operation"], "refreshNode");
    assert_eq!(result["executed"], false);
    assert_eq!(result["filesChanged"], false);
    let next = resource(&m, &adopted["resource"]["id"]);
    let mut expected = json!(prior);
    for (original, refreshed) in expected["actions"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .zip(&next.actions)
    {
        original["executableSha256"] = refreshed["executableSha256"].clone();
        original["adapterBinding"] = refreshed["adapterBinding"].clone();
    }
    expected["revision"] = json!(prior.revision + 1);
    expected["updatedAt"] = json!(next.updated_at);
    assert_eq!(json!(next), expected);
    // Catalogue writes are expected; all original tool files and Node stay put.
    let after = tree(dir.path());
    for (path, bytes) in before.iter().filter(|(path, _)| !path.starts_with("data")) {
        assert_eq!(after.get(path), Some(bytes), "{path}");
    }
    assert!(apply(&mut m, &p["id"]).is_err());
    assert!(preview_local(
        &mut m,
        &json!({"action":"preview_resource_adapter","adapter":EDGE,"rootPath":root})
    )
    .unwrap_err()
    .contains("已有安装或执行权限"));
}

#[test]
fn node_refresh_rejects_changes_outside_node_and_modified_fixed_actions() {
    for mutation in [
        "cli",
        "bundle",
        "missingAction",
        "extraAction",
        "arguments",
        "mode",
        "permission",
        "workingDirectory",
        "nodePath",
        "oldProof",
    ] {
        let dir = fixture();
        let root = dir.path().join("edge");
        let node = dir.path().join("node.exe");
        edge(&root, &node);
        let mut m = Manager::new(dir.path().join("data")).unwrap();
        let p = plan(&mut m, EDGE, &root);
        let adopted = apply(&mut m, &p["id"]).unwrap();
        let mut prior = resource(&m, &adopted["resource"]["id"]);
        fs::write(&node, "updated synthetic Node, never execute").unwrap();
        match mutation {
            "cli" => write(&root, EDGE_CLI, "changed CLI"),
            "bundle" => write(
                &root,
                "node_modules/playwright-core/lib/coreBundle.js",
                "changed control bundle",
            ),
            "missingAction" => {
                prior.actions.pop();
            }
            "extraAction" => {
                let mut action = prior.actions[0].clone();
                action["id"] = json!("edge-extra");
                prior.actions.push(action);
            }
            "arguments" => prior.actions[0]["args"][1]["value"] = json!("--isolated"),
            "mode" => prior.actions[0]["mode"] = json!("service"),
            "permission" => prior.actions[0]["cancellable"] = json!(false),
            "workingDirectory" => prior.actions[0]["workingDirectory"] = json!(dir.path()),
            "nodePath" => {
                let other = dir.path().join("other/node.exe");
                write(dir.path(), "other/node.exe", "other Node");
                prior.actions[0]["adapterBinding"]["nodePath"] = json!(other);
            }
            "oldProof" => prior.actions[0]["executableSha256"] = json!("forged"),
            _ => unreachable!(),
        }
        if !matches!(mutation, "cli" | "bundle") {
            prior = save_record(&m, prior);
        }
        let before = json!(resource(&m, &adopted["resource"]["id"]));
        assert!(refresh_plan(&mut m, &prior).is_err(), "{mutation}");
        assert_eq!(
            json!(resource(&m, &adopted["resource"]["id"])),
            before,
            "{mutation}"
        );
    }
}

#[test]
fn node_refresh_confirmation_expires_and_rechecks_files_and_the_entire_live_record() {
    for mutation in ["node", "cli", "policy", "expiry"] {
        let dir = fixture();
        let root = dir.path().join("edge");
        let node = dir.path().join("node.exe");
        edge(&root, &node);
        let mut m = Manager::new(dir.path().join("data")).unwrap();
        let p = plan(&mut m, EDGE, &root);
        let adopted = apply(&mut m, &p["id"]).unwrap();
        let prior = resource(&m, &adopted["resource"]["id"]);
        fs::write(&node, "updated synthetic Node, never execute").unwrap();
        let p = refresh_plan(&mut m, &prior).unwrap();
        match mutation {
            "node" => fs::write(&node, "changed again after preview").unwrap(),
            "cli" => write(&root, EDGE_CLI, "changed after preview"),
            "policy" => {
                let mut next = prior.clone();
                next.update_policy["mode"] = json!("disabled");
                save_record(&m, next);
            }
            "expiry" => {
                m.previews.get_mut(p["id"].as_str().unwrap()).unwrap()["createdAt"] = json!(0)
            }
            _ => unreachable!(),
        }
        let before = json!(resource(&m, &adopted["resource"]["id"]));
        assert!(apply(&mut m, &p["id"]).is_err(), "{mutation}");
        assert_eq!(
            json!(resource(&m, &adopted["resource"]["id"])),
            before,
            "{mutation}"
        );
        assert!(apply(&mut m, &p["id"]).is_err());
    }
}

#[test]
fn node_refresh_fixes_the_resource_revision_and_accepts_equivalent_path_spelling() {
    let dir = fixture();
    let root = dir.path().join("edge");
    let node = dir.path().join("node.exe");
    edge(&root, &node);
    let mut m = Manager::new(dir.path().join("data")).unwrap();
    let p = plan(&mut m, EDGE, &root);
    let adopted = apply(&mut m, &p["id"]).unwrap();
    let mut prior = resource(&m, &adopted["resource"]["id"]);
    for action in &mut prior.actions {
        let binding = &mut action["adapterBinding"];
        for field in ["rootPath", "nodePath"] {
            let path =
                crate::local::canonical(Path::new(binding[field].as_str().unwrap())).unwrap();
            binding[field] = json!(if cfg!(windows) {
                path.to_string_lossy().to_uppercase()
            } else {
                path.to_string_lossy().into_owned()
            });
        }
        for file in binding["files"].as_array_mut().unwrap() {
            let path = crate::local::canonical(Path::new(file["path"].as_str().unwrap())).unwrap();
            file["path"] = json!(if cfg!(windows) {
                path.to_string_lossy().to_uppercase()
            } else {
                path.to_string_lossy().into_owned()
            });
        }
    }
    let prior = save_record(&m, prior);
    fs::write(&node, "updated synthetic Node, never execute").unwrap();
    let request = json!({"action":"preview_resource_adapter","operation":"refreshNode","resourceId":prior.id,"expectedRevision":prior.revision,"adapter":EDGE,"rootPath":root,"nodePath":node});
    let mut stale = request.clone();
    stale["expectedRevision"] = json!(prior.revision - 1);
    assert!(preview_local(&mut m, &stale)
        .unwrap_err()
        .contains("资源已变化"));
    let mut other = request.clone();
    other["nodePath"] = json!(root.join(EDGE_CLI));
    assert!(preview_local(&mut m, &other).is_err());
    let p = preview_local(&mut m, &request).unwrap().unwrap();
    assert_eq!(
        p["runtimeChange"]["path"],
        display(&actual(&node, false).unwrap())
    );
    apply(&mut m, &p["id"]).unwrap();
    m.basic_mode = true;
    assert!(preview_local(&mut m, &request).is_err());
}

#[test]
fn reach_preview_and_adoption_preserve_all_files_and_never_execute_fixtures() {
    let dir = fixture();
    let root = dir.path().join("reach");
    reach(&root);
    let before = tree(&root);
    let mut m = Manager::new(dir.path().join("data")).unwrap();
    let p = plan(&mut m, REACH, &root);
    assert_eq!(p["detectedVersion"], "1.6.0");
    assert_eq!(p["actions"].as_array().unwrap().len(), 4);
    assert_eq!(p["deleteGrant"], false);
    assert_eq!(p["automaticUpdateGrant"], false);
    assert_eq!(p["sourceVerified"], false);
    assert!(!p.to_string().contains("PRIVATE_SESSION_NEVER"));
    assert_eq!(tree(&root), before);
    let result = apply(&mut m, &p["id"]).unwrap();
    assert_eq!(result["executed"], false);
    assert_eq!(result["filesChanged"], false);
    let r = resource(&m, &result["resource"]["id"]);
    assert_eq!(r.ownership, "external");
    assert!(r.installation.is_none());
    assert!(r.source_binding.is_none());
    assert_eq!(r.update_policy["mode"], "manual");
    assert_eq!(
        r.capabilities
            .iter()
            .find(|value| value["id"] == "execution")
            .unwrap()["status"],
        "configured"
    );
    for value in &r.actions {
        let action: ActionDefinition = serde_json::from_value(value.clone()).unwrap();
        validate_action(&r, &action).unwrap();
        assert!(Path::new(&action.executable).ends_with("Scripts/agent-reach.exe"));
    }
    assert_eq!(tree(&root), before);
    assert!(apply(&mut m, &p["id"]).is_err());
}

#[test]
fn edge_uses_existing_node_but_does_not_start_a_second_browser_or_expose_manifest_secrets() {
    let dir = fixture();
    let root = dir.path().join("edge");
    let node = dir.path().join("node.exe");
    edge(&root, &node);
    let before = tree(&root);
    let mut m = Manager::new(dir.path().join("data")).unwrap();
    let p = plan(&mut m, EDGE, &root);
    assert_eq!(p["detectedVersion"], "0.0.83");
    assert!(!p.to_string().contains("PRIVATE_TOKEN_NEVER"));
    assert!(!p.to_string().contains("PRIVATE_BROWSER_SESSION_NEVER"));
    let actions = p["actions"].as_array().unwrap();
    assert_eq!(actions.len(), 4);
    for action in actions
        .iter()
        .filter(|action| matches!(action["id"].as_str(), Some("edge-version" | "edge-help")))
    {
        let args = action["args"].as_array().unwrap();
        assert_eq!(args.len(), 2);
        assert!(matches!(
            args[1]["value"].as_str(),
            Some("--version" | "--help")
        ));
        assert!(!action.to_string().contains("--extension"));
    }
    for action in actions
        .iter()
        .filter(|action| matches!(action["id"].as_str(), Some("edge-tabs" | "edge-snapshot")))
    {
        let expected = [
            display(&root.join(EDGE_CLI)),
            "--extension".into(),
            "--browser".into(),
            "msedge".into(),
            "--profile-dir-name".into(),
            "Default".into(),
            "--output-dir".into(),
            display(&root.join("runtime")),
        ];
        let actual_args = action["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|arg| arg["value"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(actual_args.len(), expected.len());
        assert_eq!(
            key(&crate::local::canonical(Path::new(&actual_args[0])).unwrap()),
            key(&crate::local::canonical(Path::new(&expected[0])).unwrap())
        );
        assert_eq!(&actual_args[1..7], &expected[1..7]);
        assert_eq!(
            key(&crate::local::canonical(Path::new(&actual_args[7])).unwrap()),
            key(&crate::local::canonical(Path::new(&expected[7])).unwrap())
        );
        assert!(action["parameters"].as_array().unwrap().is_empty());
    }
    let result = apply(&mut m, &p["id"]).unwrap();
    let r = resource(&m, &result["resource"]["id"]);
    assert_eq!(r.kind, "mcp");
    for value in &r.actions {
        let action: ActionDefinition = serde_json::from_value(value.clone()).unwrap();
        validate_action(&r, &action).unwrap();
        assert_eq!(key(Path::new(&action.executable)), key(&node));
    }
    assert_eq!(tree(&root), before);
}

#[test]
fn dragon_reads_static_metadata_without_registering_unsafe_startup_or_integration_actions() {
    let dir = fixture();
    let root = dir.path().join("dragon");
    dragon(&root);
    let before = tree(&root);
    let mut m = Manager::new(dir.path().join("data")).unwrap();
    let p = plan(&mut m, DRAGON, &root);
    assert_eq!(p["detectedVersion"], "0.2.0");
    assert!(p["repository"].is_null());
    assert!(p["actions"].as_array().unwrap().is_empty());
    let result = apply(&mut m, &p["id"]).unwrap();
    let r = resource(&m, &result["resource"]["id"]);
    assert_eq!(r.management_scope, "register");
    assert!(r.actions.is_empty());
    assert!(r.repository.is_none());
    assert_eq!(tree(&root), before);
}

#[test]
fn wrapper_or_package_layout_changes_are_not_silently_replaced_or_executed() {
    let dir = fixture();
    let root = dir.path().join("reach");
    reach(&root);
    write(
        &root,
        "agent-reach.cmd",
        "custom wrapper with additional user initialization",
    );
    assert!(inspect(REACH, &root, None)
        .unwrap_err()
        .contains("保留本地改造"));
    assert_eq!(
        fs::read_to_string(root.join("agent-reach.cmd")).unwrap(),
        "custom wrapper with additional user initialization"
    );
    let edge_root = dir.path().join("edge");
    let node = dir.path().join("node.exe");
    edge(&edge_root, &node);
    write(
        &edge_root,
        "install-manifest.json",
        json!({"mode":"standalone","browser":"chromium","nodePath":node}).to_string(),
    );
    assert!(inspect(EDGE, &edge_root, None)
        .unwrap_err()
        .contains("现有 Edge"));
    assert!(inspect("arbitrary-shell", &root, None).is_err());
}

#[test]
fn preview_is_once_time_bound_and_changes_to_files_or_live_registration_invalidate_it() {
    for mutation in ["file", "register", "expiry"] {
        let dir = fixture();
        let root = dir.path().join("reach");
        reach(&root);
        let mut m = Manager::new(dir.path().join("data")).unwrap();
        let p = plan(&mut m, REACH, &root);
        if mutation == "file" {
            write(
                &root,
                "Lib/site-packages/agent_reach/runtime/cli.py",
                "changed user local code",
            );
        } else if mutation == "register" {
            crate::resources::handle(&m,&json!({"action":"resource_register","name":"User registered meanwhile","kind":"cli","rootPath":root})).unwrap();
        } else {
            m.previews.get_mut(p["id"].as_str().unwrap()).unwrap()["createdAt"] = json!(0);
        }
        assert!(apply(&mut m, &p["id"]).is_err());
        assert!(!m.previews.contains_key(p["id"].as_str().unwrap()));
        assert!(apply(&mut m, &p["id"]).is_err());
    }
}

#[test]
fn adopting_existing_registration_keeps_identity_notes_disabled_state_known_version_and_source() {
    let dir = fixture();
    let root = dir.path().join("reach");
    reach(&root);
    let mut m = Manager::new(dir.path().join("data")).unwrap();
    let saved=crate::resources::handle(&m,&json!({"action":"resource_register","name":"My local fork","kind":"cli","rootPath":root,"version":"local-1.6.0","repository":"https://github.com/synthetic/fork","alias":"My Reach","notes":"keep my note","enabled":false})).unwrap().unwrap();
    let prior = resource(&m, &saved["resource"]["id"]);
    let p = plan(&mut m, REACH, &root);
    let result = apply(&mut m, &p["id"]).unwrap();
    let next = resource(&m, &result["resource"]["id"]);
    assert_eq!(next.id, prior.id);
    assert_eq!(next.name, prior.name);
    assert_eq!(next.alias, prior.alias);
    assert_eq!(next.notes, prior.notes);
    assert!(!next.enabled);
    assert_eq!(next.repository, prior.repository);
    assert_eq!(next.version, prior.version);
    assert_eq!(next.revision, prior.revision + 1);
    assert!(preview_local(
        &mut m,
        &json!({"action":"preview_resource_adapter","adapter":REACH,"rootPath":root})
    )
    .unwrap_err()
    .contains("已有安装或执行权限"));
}

#[test]
fn binding_prevents_changed_arguments_root_or_same_path_replacements() {
    let dir = fixture();
    let root = dir.path().join("reach");
    reach(&root);
    let mut m = Manager::new(dir.path().join("data")).unwrap();
    let p = plan(&mut m, REACH, &root);
    let result = apply(&mut m, &p["id"]).unwrap();
    let r = resource(&m, &result["resource"]["id"]);
    let original: ActionDefinition = serde_json::from_value(r.actions[0].clone()).unwrap();
    let mut changed = original.clone();
    changed.args = vec![crate::resource_runtime::Argument::Literal {
        value: "setup".into(),
    }];
    assert!(validate_action(&r, &changed).is_err());
    let mut unrelated = r.clone();
    unrelated.root_path = dir.path().to_string_lossy().into_owned();
    assert!(validate_action(&unrelated, &original).is_err());
    let executable = Path::new(&original.executable);
    let bytes = fs::read(executable).unwrap();
    let temporary = root.join("new-entry.exe");
    fs::write(&temporary, bytes).unwrap();
    fs::remove_file(executable).unwrap();
    fs::rename(temporary, executable).unwrap();
    assert!(validate_action(&r, &original)
        .unwrap_err()
        .contains("对象身份"));
}

#[test]
fn reach_environment_is_fixed_child_only_and_preserves_user_home() {
    let dir = fixture();
    let root = dir.path().join("reach");
    reach(&root);
    let value = inspect(REACH, &root, None).unwrap();
    let action: ActionDefinition = serde_json::from_value(value.actions[0].clone()).unwrap();
    let before = std::env::var_os("PATH");
    let mut command = Command::new(&action.executable);
    apply_environment(&action, &mut command).unwrap();
    let environment: std::collections::BTreeMap<_, _> = command
        .get_envs()
        .map(|(name, value)| {
            (
                name.to_string_lossy().into_owned(),
                value.map(|value| value.to_os_string()),
            )
        })
        .collect();
    assert_eq!(
        environment["PYTHONDONTWRITEBYTECODE"].as_deref(),
        Some(std::ffi::OsStr::new("1"))
    );
    let paths: Vec<_> = std::env::split_paths(environment["PATH"].as_ref().unwrap()).collect();
    assert_eq!(key(&paths[0]), key(&root.join("Scripts")));
    assert!(!environment.contains_key("HOME"));
    assert!(!environment.contains_key("USERPROFILE"));
    assert_eq!(std::env::var_os("PATH"), before);
}

#[test]
fn edge_environment_discards_node_injection_without_reading_or_changing_login_values() {
    let dir = fixture();
    let root = dir.path().join("edge");
    let node = dir.path().join("node.exe");
    edge(&root, &node);
    let value = inspect(EDGE, &root, None).unwrap();
    let action: ActionDefinition = serde_json::from_value(value.actions[0].clone()).unwrap();
    let mut command = Command::new(&action.executable);
    apply_environment(&action, &mut command).unwrap();
    let environment: Vec<_> = command
        .get_envs()
        .map(|(key, value)| (key.to_string_lossy().into_owned(), value.is_none()))
        .collect();
    assert!(environment.contains(&("NODE_OPTIONS".into(), true)));
    assert!(environment.contains(&("NODE_PATH".into(), true)));
    assert!(environment.contains(&("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD".into(), false)));
    for key in EDGE_ENV_OVERRIDES {
        assert!(environment.contains(&(key.to_string(), true)), "{key}");
    }
    assert!(!environment
        .iter()
        .any(|(key, _)| key == "PLAYWRIGHT_MCP_EXTENSION_TOKEN"));
    assert_eq!(environment.len(), EDGE_ENV_OVERRIDES.len() + 3);
}

#[test]
fn public_read_has_one_url_argument_and_rejects_credentials_and_non_public_schemes() {
    for value in [
        "https://example.com",
        "https://www.youtube.com/watch?v=jNQXAC9IVRw",
        "https://github.com/yt-dlp/yt-dlp",
    ] {
        validate_public_url(value).unwrap();
    }
    for value in [
        "file:///D:/private",
        "https://user:secret@example.com",
        "https://example.com#secret",
        "https://example.com?access_token=secret",
        "https://example.com?%74oken=secret",
        "http://127.0.0.1",
        "http://[::1]",
        "https://example.com\nsecret",
        "https://example.com?signature=secret",
    ] {
        assert!(validate_public_url(value).is_err(), "{value}");
    }
    let dir = fixture();
    let root = dir.path().join("reach");
    reach(&root);
    let inspected = inspect(REACH, &root, None).unwrap();
    let read = inspected
        .actions
        .iter()
        .find(|action| action["id"] == "reach-read")
        .unwrap();
    assert_eq!(read["label"], "读取公共网页");
    assert_eq!(
        read["args"],
        json!([{"type":"literal","value":"web"},{"type":"literal","value":"read"},{"type":"parameter","name":"url"},{"type":"literal","value":"--backend"},{"type":"literal","value":"jina"},{"type":"literal","value":"--timeout"},{"type":"literal","value":"30"}])
    );
    assert_eq!(read["parameters"][0]["name"], "url");
    assert!(read["parameters"][0].get("templateAllowed").is_none());
}

#[test]
fn runtime_canonical_spelling_preserves_exact_adopted_identity_without_relaxing_fixed_permissions()
{
    let dir = fixture();
    let root = dir.path().join("edge");
    let node = dir.path().join("node.exe");
    edge(&root, &node);
    let inspected = inspect(EDGE, &root, None).unwrap();
    let original: ActionDefinition = serde_json::from_value(
        inspected
            .actions
            .iter()
            .find(|action| action["id"] == "edge-tabs")
            .unwrap()
            .clone(),
    )
    .unwrap();
    let mut canonical = original.clone();
    canonical.executable = crate::local::canonical(Path::new(&original.executable))
        .unwrap()
        .to_string_lossy()
        .into_owned();
    canonical.working_directory = crate::local::canonical(Path::new(&original.working_directory))
        .unwrap()
        .to_string_lossy()
        .into_owned();
    validate_bound_action(&canonical).unwrap();
    assert!(same_fixed_execution(&original, &canonical).unwrap());
    let mut other = canonical.clone();
    other.args[1] = crate::resource_runtime::Argument::Literal {
        value: "--isolated".into(),
    };
    assert!(validate_bound_action(&other).is_err());
    let mut other = canonical.clone();
    other.working_directory = display(&root.join("runtime"));
    assert!(validate_bound_action(&other).is_err());
    let mut other = canonical;
    other.mode = "service".into();
    assert!(validate_bound_action(&other).is_err());
}

#[test]
fn changing_a_required_control_bundle_or_its_package_invalidates_the_existing_adoption() {
    for relative in [
        "node_modules/playwright-core/lib/coreBundle.js",
        "node_modules/playwright-core/lib/utilsBundle.js",
        "node_modules/playwright-core/package.json",
    ] {
        let dir = fixture();
        let root = dir.path().join("edge");
        let node = dir.path().join("node.exe");
        edge(&root, &node);
        let inspected = inspect(EDGE, &root, None).unwrap();
        let action: ActionDefinition = serde_json::from_value(
            inspected
                .actions
                .iter()
                .find(|action| action["id"] == "edge-tabs")
                .unwrap()
                .clone(),
        )
        .unwrap();
        let bytes = if relative.ends_with("package.json") {
            json!({"name":"playwright-core","version":"1.58.0","license":"Apache-2.0"}).to_string()
        } else {
            "changed actual synthetic bundle".into()
        };
        write(&root, relative, bytes);
        assert!(validate_bound_action(&action).is_err(), "{relative}");
        assert!(
            inspect(EDGE, &root, None).is_ok(),
            "a fresh explicit preview can establish the new exact binding"
        );
    }
}

#[test]
fn basic_mode_and_forged_control_fields_cannot_adopt_or_add_commands() {
    let dir = fixture();
    let root = dir.path().join("reach");
    reach(&root);
    let mut m = Manager::new(dir.path().join("data")).unwrap();
    let p = plan(&mut m, REACH, &root);
    assert!(preview_local(&mut m,&json!({"action":"preview_resource_adapter","adapter":REACH,"rootPath":root,"executable":"cmd.exe"})).is_err());
    assert!(apply_local(
        &mut m,
        &json!({"action":"apply_resource_adapter","previewId":p["id"],"confirmed":true})
    )
    .is_err());
    assert!(m.previews.contains_key(p["id"].as_str().unwrap()));
    m.basic_mode = true;
    assert!(preview_local(
        &mut m,
        &json!({"action":"preview_resource_adapter","adapter":REACH,"rootPath":root})
    )
    .is_err());
    assert!(apply(&mut m, &p["id"]).is_err());
    assert!(m.resource_store(StoreRequest::List).unwrap()["resources"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn unsupported_license_and_conflicting_existing_kind_do_not_create_execution_grants() {
    let dir = fixture();
    let root = dir.path().join("reach");
    reach(&root);
    let mut m = Manager::new(dir.path().join("data")).unwrap();
    crate::resources::handle(&m, &json!({"action":"resource_register","name":"Existing Skill metadata","kind":"skill","rootPath":root})).unwrap();
    assert!(preview_local(
        &mut m,
        &json!({"action":"preview_resource_adapter","adapter":REACH,"rootPath":root})
    )
    .unwrap_err()
    .contains("类型与固定适配器不一致"));
    let resources = m.resource_store(StoreRequest::List).unwrap();
    assert_eq!(resources["resources"][0]["kind"], "skill");
    assert!(resources["resources"][0]["actions"]
        .as_array()
        .unwrap()
        .is_empty());
    write(
        &root,
        "Lib/site-packages/agent_reach-1.6.0.dist-info/licenses/LICENSE",
        "unverified local licensing",
    );
    assert!(inspect(REACH, &root, None).unwrap_err().contains("许可证"));
}

#[test]
fn candidate_binding_is_rebuilt_only_for_the_same_fixed_action_and_complete_layout() {
    let dir = fixture();
    let root = dir.path().join("reach");
    reach(&root);
    let mut m = Manager::new(dir.path().join("data")).unwrap();
    let p = plan(&mut m, REACH, &root);
    let saved = apply(&mut m, &p["id"]).unwrap();
    let old = resource(&m, &saved["resource"]["id"]);
    let candidate = dir.path().join("next");
    reach(&candidate);
    let mut next: ActionDefinition = serde_json::from_value(old.actions[0].clone()).unwrap();
    next.executable = display(&actual(&candidate.join("Scripts/agent-reach.exe"), false).unwrap());
    next.working_directory = display(&actual(&candidate, true).unwrap());
    next.executable_sha256 = Some(
        resource_files::fingerprint(Path::new(&next.executable))
            .unwrap()
            .sha256,
    );
    rebind_candidate(&old, &candidate, &mut next).unwrap();
    assert_eq!(
        key(Path::new(&next.adapter_binding.as_ref().unwrap().root_path)),
        key(&candidate)
    );
    let mut updated = old.clone();
    updated.root_path = display(&candidate);
    validate_action(&updated, &next).unwrap();
    let mut invalid = next.clone();
    invalid.args = vec![crate::resource_runtime::Argument::Literal {
        value: "setup".into(),
    }];
    assert!(rebind_candidate(&old, &candidate, &mut invalid).is_err());
    fs::remove_file(candidate.join("Scripts/python.exe")).unwrap();
    assert!(rebind_candidate(&old, &candidate, &mut next).is_err());
    let original_root = Path::new(
        old.actions[0]["adapterBinding"]["rootPath"]
            .as_str()
            .unwrap(),
    );
    assert_eq!(key(original_root), key(&root));
    assert_eq!(
        crate::clients::file_identity(original_root).unwrap(),
        crate::clients::file_identity(&root).unwrap()
    );
}
