use super::*;
use std::{fs, path::PathBuf};

fn fixture() -> tempfile::TempDir {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("work/resource-relocation-tests");
    fs::create_dir_all(&root).unwrap();
    tempfile::tempdir_in(root).unwrap()
}
fn write(root: &Path, relative: &str, contents: impl AsRef<[u8]>) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}
fn layout(root: &Path, adapter: &str) {
    if adapter == "agentReach" {
        for file in [
            "Scripts/agent-reach.exe",
            "Scripts/python.exe",
            "pyvenv.cfg",
            "Lib/site-packages/agent_reach/cli.py",
            "Lib/site-packages/agent_reach/runtime/manage.py",
        ] {
            write(root, file, "synthetic non-executable fixture; never run");
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
        write(root, "agent-reach.cmd", "@echo off\nset \"PYTHONDONTWRITEBYTECODE=1\"\nset \"PATH=%~dp0Scripts;%PATH%\"\n\"%~dp0Scripts\\agent-reach.exe\" %*\n");
    } else {
        write(
            root,
            "DragonCodexBoot.exe",
            "synthetic non-executable fixture; never run",
        );
        write(root, "VERSION", "0.2.0\n");
        write(
            root,
            "launcher.json",
            r#"{"DisplayName":"Dragon Codex Boot","ScanAllLocalDrives":true}"#,
        );
        write(root, "LICENSE", "MIT License\n");
    }
    write(
        root,
        "data/private.json",
        "private data must remain byte-identical",
    );
    write(root, "records/kept.txt", "unique local customization");
}
fn adopted(m: &mut Manager, root: &Path, adapter: &str) -> ResourceRecord {
    layout(root, adapter);
    let preview = crate::dispatch_local(
        m,
        &json!({"action":"preview_resource_adapter","adapter":adapter,"rootPath":root}),
    )
    .unwrap();
    let result = crate::dispatch_local(
        m,
        &json!({"action":"apply_resource_adapter","previewId":preview["id"]}),
    )
    .unwrap();
    serde_json::from_value(result["resource"].clone()).unwrap()
}
fn setup(adapter: &str) -> (tempfile::TempDir, Manager, ResourceRecord, PathBuf) {
    let dir = fixture();
    let mut m = Manager::new(dir.path().join("manager")).unwrap();
    m.save().unwrap();
    let original = adopted(&mut m, &dir.path().join("old"), adapter);
    let next = dir.path().join("next");
    fs::rename(&original.root_path, &next).unwrap();
    (dir, m, original, next)
}
fn edge_setup() -> (tempfile::TempDir, Manager, ResourceRecord, PathBuf, PathBuf) {
    let dir = fixture();
    let old = dir.path().join("old-edge");
    let node = dir.path().join("shared-runtime/node.exe");
    write(
        dir.path(),
        "shared-runtime/node.exe",
        "synthetic Node; never execute",
    );
    for file in [
        "node_modules/@playwright/mcp/cli.js",
        "node_modules/playwright-core/lib/coreBundle.js",
        "node_modules/playwright-core/lib/utilsBundle.js",
    ] {
        write(&old, file, "synthetic fixed library fixture");
    }
    write(&old, "node_modules/@playwright/mcp/package.json", json!({"name":"@playwright/mcp","version":"0.0.84","license":"Apache-2.0","repository":{"url":"git+https://github.com/microsoft/playwright-mcp.git"}}).to_string());
    write(
        &old,
        "node_modules/@playwright/mcp/LICENSE",
        "Apache License",
    );
    write(
        &old,
        "node_modules/playwright-core/package.json",
        json!({"name":"playwright-core","version":"1.57.0","license":"Apache-2.0"}).to_string(),
    );
    write(
        &old,
        "install-manifest.json",
        json!({"mode":"extension","browser":"msedge","nodePath":node}).to_string(),
    );
    write(
        &old,
        "runtime/private-session.json",
        "private state; not read by relocation",
    );
    let mut m = Manager::new(dir.path().join("manager")).unwrap();
    m.save().unwrap();
    let p = crate::dispatch_local(
        &mut m,
        &json!({"action":"preview_resource_adapter","adapter":"edgeControl","rootPath":old}),
    )
    .unwrap();
    let adopted = crate::dispatch_local(
        &mut m,
        &json!({"action":"apply_resource_adapter","previewId":p["id"]}),
    )
    .unwrap();
    let original = serde_json::from_value(adopted["resource"].clone()).unwrap();
    let next = dir.path().join("new-edge");
    fs::rename(old, &next).unwrap();
    (dir, m, original, next, node)
}
fn preview(m: &mut Manager, original: &ResourceRecord, next: &Path) -> Result<Value, String> {
    crate::dispatch_local(
        m,
        &json!({"action":"preview_resource_relocate","id":original.id,"expectedRevision":original.revision,"rootPath":next}),
    )
}
fn apply(m: &mut Manager, p: &Value) -> Result<Value, String> {
    crate::dispatch_local(
        m,
        &json!({"action":"apply_resource_relocate","previewId":p["previewId"]}),
    )
}
fn save(m: &Manager, record: &ResourceRecord) {
    m.resource_store(StoreRequest::Replace {
        record: Box::new(record.clone()),
        expected_revision: record.revision,
    })
    .unwrap();
}
fn tree(root: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
    fn visit(base: &Path, path: &Path, result: &mut std::collections::BTreeMap<String, Vec<u8>>) {
        for entry in fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(base, &path, result);
            } else {
                result.insert(
                    path.strip_prefix(base)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    fs::read(&path).unwrap(),
                );
            }
        }
    }
    let mut result = std::collections::BTreeMap::new();
    visit(root, root, &mut result);
    result
}

#[test]
fn relocation_rebinds_only_existing_reach_paths_and_preserves_history_and_metadata() {
    let (_dir, mut m, mut original, next) = setup("agentReach");
    original.notes = "retained note".into();
    original.alias = "custom alias".into();
    original.enabled = false;
    original.update_policy = json!({"mode":"automatic","intervalHours":48,"pinnedVersion":"1.6.0","skippedVersions":["1.5.0"]});
    original.source_history = serde_json::from_value(json!([{"changedAt":"historical-time","repository":"https://github.com/example/prior","binding":null,"capabilities":[{"id":"historical"}]}])).unwrap();
    original.installation = Some(serde_json::from_value(json!({"schemaVersion":1,"installedAt":"historical-time","archivePath":"D:/historical/archive.zip","archiveSha256":"historical-sha","sourceRepository":"https://github.com/example/prior","sourceVersion":"v0","files":[],"status":"installed","error":null})).unwrap());
    original.installation.as_mut().unwrap().system_entries.push(
        serde_json::from_value(json!({"schemaVersion":1,"id":"synthetic-entry","receiptId":"synthetic-receipt","integrationId":"synthetic-integration","origin":"explicitTakeover","role":"configuration",
            "address":{"kind":"registryValue","key":"Software\\SyntheticRelocationFixture","valueName":"Fixture","view":"native"},
            "before":{"kind":"registry","value":{"kind":1,"bytes":[1,2,3]}},"installed":{"kind":"registry","value":{"kind":1,"bytes":[4,5,6]}}})).unwrap()
    );
    save(&m, &original);
    let old_epoch = m
        .capability_evidence_store(crate::resource_capability_evidence::StoreRequest::Epoch {
            resource_id: original.id.clone(),
        })
        .unwrap()["epoch"]
        .as_u64()
        .unwrap();
    let before = tree(&next);
    let p = preview(&mut m, &original, &next).unwrap();
    assert_eq!(p["kind"], KIND);
    assert_eq!(p["actions"].as_array().unwrap().len(), 4);
    assert_eq!(p["version"], "1.6.0");
    assert_eq!(p["actionsAdded"], 0);
    assert_eq!(json!(read(&m, &original.id).unwrap()), json!(original));
    let result = apply(&mut m, &p).unwrap();
    assert_eq!(result["complete"], true);
    assert!(result["resource"]["installation"]["systemEntries"][0]
        .get("before")
        .is_none());
    assert!(result["resource"]["installation"]["systemEntries"][0]
        .get("installed")
        .is_none());
    for field in ["executed", "filesChanged"] {
        assert_eq!(result[field], false);
    }
    let saved = read(&m, &original.id).unwrap();
    assert_eq!(saved.revision, original.revision + 1);
    assert_eq!(key(&saved.root_path), key(next.to_str().unwrap()));
    assert_eq!(saved.actions.len(), 4);
    for (old, new) in original.actions.iter().zip(&saved.actions) {
        for field in [
            "id",
            "label",
            "mode",
            "cancellable",
            "args",
            "parameters",
            "timeoutSeconds",
            "idleReleaseSafe",
            "idleUsageTracked",
            "idleTimeoutSeconds",
        ] {
            assert_eq!(old[field], new[field], "{field}");
        }
        let definition =
            crate::resource_runtime::registered_definition(&saved, new["id"].as_str().unwrap())
                .unwrap();
        crate::resource_adapters::validate_action(&saved, &definition).unwrap();
        assert!(new["adapterBinding"].is_object());
    }
    let mut comparable = json!(saved);
    for field in [
        "rootPath",
        "actions",
        "revision",
        "updatedAt",
        "capabilities",
    ] {
        comparable[field] = json!(original)[field].clone();
    }
    assert_eq!(comparable, json!(original));
    let metadata = saved
        .capabilities
        .iter()
        .find(|v| v["id"] == "versionMetadata")
        .unwrap();
    assert_eq!(metadata["entry"], saved.root_path);
    assert_eq!(metadata["method"], "staticMetadata");
    assert_eq!(tree(&next), before);
    assert!(!Path::new(&original.root_path).exists());
    assert!(apply(&mut m, &p).is_err());
    let epoch = m
        .capability_evidence_store(crate::resource_capability_evidence::StoreRequest::Epoch {
            resource_id: original.id.clone(),
        })
        .unwrap();
    assert_eq!(epoch["epoch"], old_epoch + 1);
    // The catalog root key moved too; another record may use the old spelling.
    let mut old_root_record = original.clone();
    old_root_record.id = uuid::Uuid::new_v4().to_string();
    m.resource_store(StoreRequest::Insert(Box::new(old_root_record)))
        .unwrap();
    let mut duplicate = saved;
    duplicate.id = uuid::Uuid::new_v4().to_string();
    assert!(m
        .resource_store(StoreRequest::Insert(Box::new(duplicate)))
        .is_err());
}

#[test]
fn dragon_remains_zero_actions_and_can_relocate_again_after_static_metadata_refresh() {
    let (dir, mut m, original, next) = setup("dragonCodexBoot");
    let renamed = crate::dispatch(&mut m, &json!({"action":"resource_update","id":original.id,"expectedRevision":original.revision,"changes":{"name":"我的 Dragon 启动器"}})).unwrap();
    let original: ResourceRecord = serde_json::from_value(renamed["resource"].clone()).unwrap();
    let before = tree(&next);
    let p = preview(&mut m, &original, &next).unwrap();
    assert_eq!(p["adapter"], "dragonCodexBoot");
    assert_eq!(p["actions"], json!([]));
    let result = apply(&mut m, &p).unwrap();
    assert_eq!(result["resource"]["actions"], json!([]));
    assert_eq!(result["resource"]["name"], "我的 Dragon 启动器");
    assert_eq!(tree(&next), before);
    let current = read(&m, &original.id).unwrap();
    let third = dir.path().join("third");
    fs::rename(&next, &third).unwrap();
    let p = preview(&mut m, &current, &third).unwrap();
    assert_eq!(
        apply(&mut m, &p).unwrap()["resource"]["revision"],
        original.revision + 2
    );
}

#[test]
fn relocation_rechecks_new_file_hashes_and_directory_identity_without_partial_writes() {
    for change in ["entry", "metadata", "directory"] {
        let (dir, mut m, original, next) = setup("dragonCodexBoot");
        let p = preview(&mut m, &original, &next).unwrap();
        match change {
            "entry" => write(&next, "DragonCodexBoot.exe", "changed fixture"),
            "metadata" => write(
                &next,
                "launcher.json",
                r#"{"DisplayName":"Dragon Codex Boot","Extra":"changed"}"#,
            ),
            _ => {
                fs::rename(&next, dir.path().join("held-original")).unwrap();
                layout(&next, "dragonCodexBoot");
            }
        }
        assert!(apply(&mut m, &p).is_err(), "{change}");
        assert_eq!(json!(read(&m, &original.id).unwrap()), json!(original));
        assert!(apply(&mut m, &p).is_err());
    }
}

#[test]
fn relocation_rejects_record_changes_even_without_revision_increment_and_cas_is_atomic() {
    let (_dir, mut m, original, next) = setup("agentReach");
    let p = preview(&mut m, &original, &next).unwrap();
    let mut changed = original.clone();
    changed.notes = "concurrent change".into();
    save(&m, &changed);
    assert!(apply(&mut m, &p).unwrap_err().contains("已变化"));
    let mut proposed = original.clone();
    proposed.root_path = next.to_string_lossy().into_owned();
    proposed.revision += 1;
    assert!(m
        .resource_store(StoreRequest::Relocate {
            original: Box::new(original),
            record: Box::new(proposed)
        })
        .is_err());
    assert_eq!(json!(read(&m, &changed.id).unwrap()), json!(changed));
}

#[test]
fn relocation_rejects_conflicting_roots_at_preview_and_apply() {
    for conflict_after_preview in [false, true] {
        let (_dir, mut m, original, next) = setup("dragonCodexBoot");
        let p = conflict_after_preview.then(|| preview(&mut m, &original, &next).unwrap());
        let mut other = original.clone();
        other.id = "other".into();
        other.root_path = next.join("data").to_string_lossy().into_owned();
        m.resource_store(StoreRequest::Insert(Box::new(other)))
            .unwrap();
        if let Some(p) = p {
            assert!(apply(&mut m, &p).unwrap_err().contains("冲突"));
        } else {
            assert!(preview(&mut m, &original, &next)
                .unwrap_err()
                .contains("冲突"));
        }
        assert_eq!(json!(read(&m, &original.id).unwrap()), json!(original));
    }
}

#[test]
fn relocation_rejects_unknown_bindings_outside_paths_and_tampered_commands() {
    for change in [
        "missing-binding",
        "unknown-adapter",
        "outside-executable",
        "outside-workdir",
        "argument",
        "duplicate-id",
        "hash",
        "binding-file",
    ] {
        let (_dir, mut m, mut original, next) = setup("agentReach");
        match change {
            "missing-binding" => {
                original.actions[0]
                    .as_object_mut()
                    .unwrap()
                    .remove("adapterBinding");
            }
            "unknown-adapter" => {
                original.actions[0]["adapterBinding"]["adapter"] = json!("unknown")
            }
            "outside-executable" => {
                original.actions[0]["executable"] = json!(next.join("Scripts/agent-reach.exe"))
            }
            "outside-workdir" => original.actions[0]["workingDirectory"] = json!(next),
            "argument" => {
                original.actions[0]["args"] = json!([{"type":"literal","value":"install"}])
            }
            "duplicate-id" => original.actions[1] = original.actions[0].clone(),
            "hash" => original.actions[0]["executableSha256"] = json!("changed"),
            _ => {
                original.actions[0]["adapterBinding"]["files"][0]["path"] =
                    json!(next.join("outside.exe"))
            }
        }
        save(&m, &original);
        assert!(preview(&mut m, &original, &next).is_err(), "{change}");
        assert!(m.previews.values().all(|p| p["kind"] != KIND));
        assert_eq!(json!(read(&m, &original.id).unwrap()), json!(original));
    }
}

#[test]
fn relocation_is_local_only_strict_basic_mode_guarded_and_preview_bound() {
    let (_dir, mut m, original, next) = setup("dragonCodexBoot");
    let request = json!({"action":"preview_resource_relocate","id":original.id,"expectedRevision":original.revision,"rootPath":next});
    assert!(crate::dispatch(&mut m, &request).is_err());
    assert!(m.previews.is_empty());
    let mut extra = request.clone();
    extra["execute"] = json!(true);
    assert!(crate::dispatch_local(&mut m, &extra).is_err());
    let mut stale = request.clone();
    stale["expectedRevision"] = json!(2);
    assert!(crate::dispatch_local(&mut m, &stale).is_err());
    let p = preview(&mut m, &original, &next).unwrap();
    assert!(crate::dispatch(
        &mut m,
        &json!({"action":"apply_resource_relocate","previewId":p["previewId"]})
    )
    .is_err());
    assert!(m.previews.contains_key(p["previewId"].as_str().unwrap()));
    m.basic_mode = true;
    assert!(preview(&mut m, &original, &next)
        .unwrap_err()
        .contains("基本模式"));
    assert!(apply(&mut m, &p).unwrap_err().contains("基本模式"));
    m.basic_mode = false;
    m.previews
        .get_mut(p["previewId"].as_str().unwrap())
        .unwrap()["createdAt"] = json!(chrono::Utc::now().timestamp_millis() - TTL);
    assert!(apply(&mut m, &p).unwrap_err().contains("过期"));
    for _ in 0..35 {
        preview(&mut m, &original, &next).unwrap();
    }
    assert_eq!(
        m.previews.values().filter(|p| p["kind"] == KIND).count(),
        32
    );
    assert_eq!(json!(read(&m, &original.id).unwrap()), json!(original));
}

#[test]
fn dragon_identity_and_version_mismatch_are_rejected_before_preview() {
    for change in ["identity", "version", "unknown-registration", "same-root"] {
        let (_dir, mut m, mut original, next) = setup("dragonCodexBoot");
        match change {
            "identity" => write(
                &next,
                "launcher.json",
                r#"{"DisplayName":"Other launcher"}"#,
            ),
            "version" => write(&next, "VERSION", "0.3.0"),
            "unknown-registration" => {
                original.capabilities.clear();
                save(&m, &original);
            }
            _ => {
                original.root_path = next.to_string_lossy().into_owned();
                for c in &mut original.capabilities {
                    if c["id"] == "versionMetadata" {
                        c["entry"] = json!(original.root_path);
                    }
                }
                save(&m, &original);
            }
        }
        assert!(preview(&mut m, &original, &next).is_err(), "{change}");
        assert!(m.previews.is_empty());
    }
}

#[test]
fn relocation_worker_publishes_and_consumes_preview_through_the_live_single_writer() {
    let (_dir, mut m, original, next) = setup("agentReach");
    let expected_before = crate::dispatch(&mut m, &json!({"action":"resource_list"})).unwrap();
    let service = crate::tasks::TaskSystem::new(m).unwrap();
    let p = service.execute(json!({"action":"preview_resource_relocate","id":original.id,"expectedRevision":original.revision,"rootPath":next}), crate::dispatch_local).unwrap();
    let before = service
        .execute(json!({"action":"resource_list"}), crate::dispatch)
        .unwrap();
    assert_eq!(before["resources"], expected_before["resources"]);
    let applied = service
        .execute(
            json!({"action":"apply_resource_relocate","previewId":p["previewId"]}),
            crate::dispatch_local,
        )
        .unwrap();
    assert_eq!(applied["complete"], true);
    assert_eq!(applied["resource"]["id"], original.id);
    assert_eq!(applied["resource"]["revision"], original.revision + 1);
    assert!(service
        .execute(
            json!({"action":"apply_resource_relocate","previewId":p["previewId"]}),
            crate::dispatch_local
        )
        .is_err());
    let after = service
        .execute(json!({"action":"resource_list"}), crate::dispatch)
        .unwrap();
    let mut expected_after = before["resources"][0].clone();
    let saved: ResourceRecord = serde_json::from_value(applied["resource"].clone()).unwrap();
    for (field, value) in crate::resource_lifecycle::public_record(&saved)
        .as_object()
        .unwrap()
    {
        expected_after[field] = value.clone();
    }
    assert_eq!(after["resources"][0], expected_after);
    assert_eq!(after["resources"].as_array().unwrap().len(), 1);
}

#[test]
fn relocation_retains_but_invalidates_old_invocation_templates() {
    let dir = fixture();
    let mut m = Manager::new(dir.path().join("manager")).unwrap();
    m.save().unwrap();
    let original = adopted(&mut m, &dir.path().join("old"), "agentReach");
    let template = crate::dispatch(&mut m, &json!({"action":"resource_template_save","id":original.id,"actionId":"reach-version","expectedResourceRevision":original.revision,"expectedRevision":0,"name":"Version check","parameters":{}})).unwrap();
    assert_eq!(template["templates"][0]["compatible"], true);
    let prepared = crate::dispatch(&mut m, &json!({"action":"resource_template_prepare","id":original.id,"actionId":"reach-version","expectedResourceRevision":original.revision,"templateId":template["templateId"],"expectedRevision":1})).unwrap();
    assert_eq!(prepared["parameters"], json!({}));
    let next = dir.path().join("next");
    fs::rename(&original.root_path, &next).unwrap();
    let p = preview(&mut m, &original, &next).unwrap();
    let result = apply(&mut m, &p).unwrap();
    let listed = crate::dispatch(
        &mut m,
        &json!({"action":"resource_templates","id":original.id,"actionId":"reach-version"}),
    )
    .unwrap();
    assert_eq!(listed["templates"].as_array().unwrap().len(), 1);
    assert_eq!(listed["templates"][0]["id"], template["templateId"]);
    assert_eq!(listed["templates"][0]["compatible"], false);
    assert!(crate::dispatch(&mut m, &json!({"action":"resource_template_prepare","id":original.id,"actionId":"reach-version","expectedResourceRevision":result["resource"]["revision"],"templateId":template["templateId"],"expectedRevision":1})).is_err());
}

#[test]
fn edge_relocation_preserves_shared_node_and_explicitly_previews_all_root_argument_paths() {
    let (_dir, mut m, original, next, node) = edge_setup();
    let before = tree(&next);
    let node_before = fs::read(&node).unwrap();
    let p = preview(&mut m, &original, &next).unwrap();
    assert_eq!(p["adapter"], "edgeControl");
    assert!(p.get("runtimeChange").is_none());
    for action in p["actions"].as_array().unwrap() {
        assert_eq!(action["oldExecutable"], action["newExecutable"]);
        let paths = action["argumentPaths"].as_array().unwrap();
        assert_eq!(paths[0]["index"], 0);
        assert_eq!(paths[0]["oldPath"], original.actions[0]["args"][0]["value"]);
        assert_eq!(
            key(paths[0]["newPath"].as_str().unwrap()),
            key(next
                .join("node_modules/@playwright/mcp/cli.js")
                .to_str()
                .unwrap())
        );
        if matches!(action["id"].as_str(), Some("edge-tabs" | "edge-snapshot")) {
            assert_eq!(paths.len(), 2);
            assert_eq!(paths[1]["index"], 7);
        } else {
            assert_eq!(paths.len(), 1);
        }
    }
    apply(&mut m, &p).unwrap();
    let saved = read(&m, &original.id).unwrap();
    for (old, new) in original.actions.iter().zip(&saved.actions) {
        for field in [
            "id",
            "label",
            "mode",
            "cancellable",
            "parameters",
            "timeoutSeconds",
            "executable",
            "executableSha256",
            "idleReleaseSafe",
            "idleUsageTracked",
            "idleTimeoutSeconds",
        ] {
            assert_eq!(old[field], new[field], "{field}");
        }
        let definition =
            crate::resource_runtime::verified_definition(&saved, new["id"].as_str().unwrap())
                .unwrap();
        assert_eq!(
            key(definition
                .adapter_binding
                .unwrap()
                .node_path
                .as_deref()
                .unwrap()),
            key(node.to_str().unwrap())
        );
    }
    assert_eq!(tree(&next), before);
    assert_eq!(fs::read(node).unwrap(), node_before);
}

#[test]
fn edge_relocation_explicitly_refreshes_only_the_original_same_path_node_proof() {
    let (_dir, mut m, original, next, node) = edge_setup();
    fs::write(&node, "synthetic replacement Node; never execute").unwrap();
    let p = preview(&mut m, &original, &next).unwrap();
    assert_eq!(
        key(p["runtimeChange"]["path"].as_str().unwrap()),
        key(node.to_str().unwrap())
    );
    assert_eq!(
        p["runtimeChange"]["previousSha256"],
        original.actions[0]["executableSha256"]
    );
    let sha = crate::resource_files::fingerprint(&node).unwrap().sha256;
    assert_eq!(p["runtimeChange"]["currentSha256"], sha);
    assert_ne!(
        p["runtimeChange"]["previousSha256"],
        p["runtimeChange"]["currentSha256"]
    );
    let result = apply(&mut m, &p).unwrap();
    for action in result["resource"]["actions"].as_array().unwrap() {
        assert_eq!(action["executableSha256"], sha);
        assert_eq!(action["executable"], original.actions[0]["executable"]);
    }
    let current = read(&m, &original.id).unwrap();
    for action in &current.actions {
        crate::resource_runtime::verified_definition(&current, action["id"].as_str().unwrap())
            .unwrap();
    }
}

#[test]
fn edge_relocation_rejects_node_drift_after_preview_and_any_original_command_expansion() {
    for change in [
        "node-after-preview",
        "extra-flag",
        "external-argument",
        "different-executable",
        "different-binding",
    ] {
        let (dir, mut m, mut original, next, node) = edge_setup();
        if change == "node-after-preview" {
            let p = preview(&mut m, &original, &next).unwrap();
            fs::write(&node, "Node changed after preview").unwrap();
            assert!(apply(&mut m, &p).is_err());
        } else {
            match change {
                "extra-flag" => original.actions[0]["args"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"type":"literal","value":"--allow-unrestricted-file-access"})),
                "external-argument" => original.actions[0]["args"][0]["value"] = json!(node),
                "different-executable" => {
                    write(dir.path(), "other/node.exe", "different fixture");
                    original.actions[0]["executable"] = json!(dir.path().join("other/node.exe"));
                }
                _ => {
                    original.actions[0]["adapterBinding"]["nodePath"] =
                        json!(dir.path().join("other/node.exe"))
                }
            }
            save(&m, &original);
            assert!(preview(&mut m, &original, &next).is_err(), "{change}");
        }
        assert_eq!(json!(read(&m, &original.id).unwrap()), json!(original));
    }
}

#[test]
fn edge_relocation_discloses_same_hash_node_replacement_and_rechecks_its_object_identity() {
    for replace_after_preview in [false, true] {
        let (dir, mut m, original, next, node) = edge_setup();
        let held = dir.path().join("held-node-before-preview.exe");
        fs::rename(&node, &held).unwrap();
        fs::copy(&held, &node).unwrap();
        let p = preview(&mut m, &original, &next).unwrap();
        assert!(p["runtimeChange"].is_object());
        assert_eq!(
            p["runtimeChange"]["previousSha256"],
            p["runtimeChange"]["currentSha256"]
        );
        if replace_after_preview {
            let held_again = dir.path().join("held-node-after-preview.exe");
            fs::rename(&node, &held_again).unwrap();
            fs::copy(&held_again, &node).unwrap();
            assert!(apply(&mut m, &p).unwrap_err().contains("已变化"));
            assert_eq!(json!(read(&m, &original.id).unwrap()), json!(original));
        } else {
            let result = apply(&mut m, &p).unwrap();
            assert_eq!(result["complete"], true);
            assert_eq!(
                result["resource"]["actions"][0]["executableSha256"],
                original.actions[0]["executableSha256"]
            );
            let current = read(&m, &original.id).unwrap();
            crate::resource_runtime::verified_definition(&current, "edge-tabs").unwrap();
        }
    }
}
