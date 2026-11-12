use super::*;
use std::{cell::RefCell, io::Write};

struct Case {
    manager: Manager,
    record: ResourceRecord,
    previous: PathBuf,
    candidate: PathBuf,
    retained: PathBuf,
    _dir: tempfile::TempDir,
}

fn files(root: &Path) -> Vec<OwnedFile> {
    let mut files = vec![];
    for (name, role) in [
        ("tool.exe", FileRole::Runtime),
        ("private/runtime.dll", FileRole::PrivateDependency),
        ("LICENSE", FileRole::License),
        ("config.json", FileRole::Configuration),
    ] {
        let path = root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, name.as_bytes()).unwrap();
        files.push(OwnedFile {
            path: name.into(),
            role,
            installed_sha256: resource_files::fingerprint(&path).unwrap().sha256,
        });
    }
    files
}

fn case() -> Case {
    let base = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("work/runtime-removal-tests");
    fs::create_dir_all(&base).unwrap();
    let dir = tempfile::tempdir_in(base).unwrap();
    let mut manager = Manager::new(dir.path().join("manager")).unwrap();
    let archive = dir.path().join("package.zip");
    let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
    for name in ["tool.exe", "LICENSE"] {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(name.as_bytes()).unwrap();
    }
    zip.finish().unwrap();
    let plan=handle(&mut manager,&json!({"action":"preview_resource_install","archivePath":archive,"destinationPath":dir.path().join("current"),"name":"Synthetic multi-root tool","kind":"portable","version":"v1","selectedFiles":["tool.exe"]})).unwrap().unwrap();
    let installed = apply_local(
        &mut manager,
        &json!({"action":"apply_resource_install","previewId":plan["id"]}),
    )
    .unwrap()
    .unwrap();
    let mut record =
        read_resource(&manager, installed["resource"]["id"].as_str().unwrap()).unwrap();
    let previous = dir.path().join("previous");
    let previous_files = files(&previous);
    let candidate = dir.path().join("candidate");
    let candidate_files = files(&candidate);
    let retained = dir.path().join("retained");
    let retained_files = files(&retained);
    let installation = record.installation.as_ref().unwrap();
    let original = json!({"root":record.root_path,"rootIdentity":crate::clients::file_identity(Path::new(&record.root_path)).unwrap(),"files":{},"resource":record,"relations":{}});
    let candidate_value = |root: &Path, owned: &Vec<OwnedFile>, version: &str| json!({"root":root,"version":version,"archivePath":archive,"archiveSha256":installation.archive_sha256,"downloadSource":null,"files":owned,"createdPaths":[root.join("tool.exe"),root.join("unhashed.part")],"complete":true,"error":null,"original":original,"validation":null});
    let mut state:crate::resource_update::UpdateState=serde_json::from_value(json!({
        "candidate":candidate_value(&candidate,&candidate_files,"v2"),
        "previous":[{"root":previous,"version":"v0","archivePath":archive,"archiveSha256":installation.archive_sha256,"sourceRepository":null,"sourceVersion":"v0","downloadSource":null,"files":previous_files,"retainedRepairFiles":[],"actions":[],"retainedAt":now(),"reason":"retained old runtime"}],
        "retainedCandidates":[{"candidate":candidate_value(&retained,&retained_files,"v3"),"retainedAt":now(),"reason":"retained partial candidate"}],"lastFailure":null
    })).unwrap();
    let write_metadata = |root: &Path, files: &[OwnedFile], version: &str| {
        let prepared = crate::resource_manifest::prepare(
            root,
            &record.id,
            &record.kind,
            Some(version),
            Some(manifest_source(installation).expect("synthetic installation source is valid")),
            files,
            true,
        )
        .unwrap();
        crate::resource_manifest::write_new(root, &prepared).unwrap()
    };
    state.previous[0].resource_manifest =
        Some(write_metadata(&previous, &state.previous[0].files, "v0"));
    let candidate_state = state.candidate.as_mut().unwrap();
    candidate_state.resource_manifest =
        Some(write_metadata(&candidate, &candidate_state.files, "v2"));
    candidate_state
        .created_paths
        .push(candidate.join(crate::resource_manifest::NAME));
    let retained_state = &mut state.retained_candidates[0].candidate;
    retained_state.resource_manifest = Some(write_metadata(&retained, &retained_state.files, "v3"));
    retained_state
        .created_paths
        .push(retained.join(crate::resource_manifest::NAME));
    fs::write(candidate.join("unhashed.part"), b"unhashed partial bytes").unwrap();
    fs::write(retained.join("unhashed.part"), b"unhashed retained bytes").unwrap();
    record.installation.as_mut().unwrap().update_state = Some(state);
    let expected = record.revision;
    record.revision += 1;
    manager
        .resource_store(StoreRequest::Replace {
            record: Box::new(record.clone()),
            expected_revision: expected,
        })
        .unwrap();
    Case {
        manager,
        record,
        previous,
        candidate,
        retained,
        _dir: dir,
    }
}

fn preview(case: &mut Case, extent: &str, custom: &[String]) -> Value {
    let record = read_resource(&case.manager, &case.record.id).unwrap();
    handle(&mut case.manager,&json!({"action":"preview_resource_remove","id":record.id,"expectedRevision":record.revision,"extent":extent,"customFiles":custom})).unwrap().unwrap()
}

fn apply(case: &mut Case, plan: &Value) -> Result<Value, String> {
    apply_local(
        &mut case.manager,
        &json!({"action":"apply_resource_remove","previewId":plan["id"]}),
    )
    .map(|result| result.unwrap())
}

#[test]
fn complete_removal_covers_all_owned_roots_and_preserves_unhashed_paths_and_directories() {
    let mut case = case();
    let plan = preview(&mut case, "complete", &[]);
    assert_eq!(plan["runtimeGroups"].as_array().unwrap().len(), 4);
    assert_eq!(plan["metadataEntries"].as_array().unwrap().len(), 4);
    assert_eq!(plan["targetPaths"].as_array().unwrap().len(), 4);
    assert_eq!(plan["protectedEntries"].as_array().unwrap().len(), 2);
    assert_eq!(plan["entries"].as_array().unwrap().len(), 14);
    let result = apply(&mut case, &plan).unwrap();
    assert_eq!(result["complete"], true);
    assert_eq!(result["result"]["deleted"].as_array().unwrap().len(), 14);
    assert_eq!(result["runtimeResults"].as_array().unwrap().len(), 4);
    let resource = read_resource(&case.manager, &case.record.id).unwrap();
    let installation = resource.installation.unwrap();
    assert!(installation.files.is_empty());
    let state = installation.update_state.unwrap();
    assert!(state.previous[0].files.is_empty());
    assert!(state.candidate.as_ref().unwrap().files.is_empty());
    assert!(state.retained_candidates[0].candidate.files.is_empty());
    assert!(!state.candidate.unwrap().complete);
    assert!(!state.retained_candidates[0].candidate.complete);
    assert!(state.previous[0].resource_manifest.is_none());
    assert!(state.retained_candidates[0]
        .candidate
        .resource_manifest
        .is_none());
    assert!(Path::new(&resource.root_path).is_dir());
    assert!(case.previous.is_dir());
    assert!(case.candidate.is_dir());
    assert!(case.retained.is_dir());
    assert_eq!(
        fs::read(case.candidate.join("unhashed.part")).unwrap(),
        b"unhashed partial bytes"
    );
    assert_eq!(
        fs::read(case.retained.join("unhashed.part")).unwrap(),
        b"unhashed retained bytes"
    );
    assert_eq!(installation.removal_state.unwrap().runtime_results.len(), 4);
}

#[test]
fn runtime_extent_removes_each_versions_runtime_dependencies_and_license_but_keeps_configuration() {
    let mut case = case();
    let plan = preview(&mut case, "runtime", &[]);
    let result = apply(&mut case, &plan).unwrap();
    assert_eq!(result["complete"], true);
    for root in [&case.previous, &case.candidate, &case.retained] {
        assert!(!root.join("tool.exe").exists());
        assert!(!root.join("private/runtime.dll").exists());
        assert!(!root.join("LICENSE").exists());
        assert!(root.join("config.json").is_file());
    }
    let record = read_resource(&case.manager, &case.record.id).unwrap();
    let state = record.installation.unwrap().update_state.unwrap();
    assert_eq!(state.previous[0].files.len(), 1);
    assert_eq!(state.candidate.unwrap().files.len(), 1);
    assert_eq!(state.retained_candidates[0].candidate.files.len(), 1);
}

#[test]
fn custom_history_selection_is_stable_and_never_selects_same_named_files_in_other_roots() {
    let mut case = case();
    let all = preview(&mut case, "custom", &[]);
    let selected = all["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| {
            entry["path"].as_str().is_some_and(|path| {
                path_key(Path::new(path)) == path_key(&case.previous.join("tool.exe"))
            })
        })
        .unwrap()["selectionId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(selected.starts_with("previous:"));
    let plan = preview(&mut case, "custom", &[selected]);
    let result = apply(&mut case, &plan).unwrap();
    assert_eq!(result["complete"], true);
    assert!(!case.previous.join("tool.exe").exists());
    assert!(Path::new(&case.record.root_path).join("tool.exe").exists());
    assert!(case.candidate.join("tool.exe").exists());
    assert!(case.retained.join("tool.exe").exists());
    assert_eq!(result["result"]["deleted"].as_array().unwrap().len(), 1);
    let record = read_resource(&case.manager, &case.record.id).unwrap();
    let state = record.installation.unwrap().update_state.unwrap();
    assert_eq!(state.previous[0].files.len(), 3);
    assert_eq!(state.candidate.unwrap().files.len(), 4);
    let bogus = format!(
        "{}::unhashed.part",
        all["runtimeGroups"][2]["id"].as_str().unwrap()
    );
    let current = read_resource(&case.manager, &case.record.id).unwrap();
    assert!(handle(&mut case.manager,&json!({"action":"preview_resource_remove","id":current.id,"expectedRevision":current.revision,"extent":"custom","customFiles":[bogus]})).is_err());
}

#[test]
fn history_changes_or_new_shared_claims_invalidate_entire_preview_before_first_delete() {
    let mut case = case();
    let old = preview(&mut case, "complete", &[]);
    fs::write(case.previous.join("tool.exe"), b"changed after preview").unwrap();
    assert!(apply(&mut case, &old).is_err());
    assert!(Path::new(&case.record.root_path).join("tool.exe").exists());
    assert!(case.candidate.join("tool.exe").exists());
    let fresh = preview(&mut case, "complete", &[]);
    crate::resources::handle(&case.manager,&json!({"action":"resource_register","name":"Other owner","kind":"portable","rootPath":case.retained})).unwrap().unwrap();
    assert!(apply(&mut case, &fresh).unwrap_err().contains("共享"));
    let blocked = preview(&mut case, "complete", &[]);
    assert_eq!(blocked["canApply"], false);
    assert!(Path::new(&case.record.root_path).join("tool.exe").exists());
    assert!(case.retained.join("tool.exe").exists());
}

struct DriftSystem {
    value: RefCell<crate::system_ownership::SystemValue>,
    path: PathBuf,
}
impl SystemAccess for DriftSystem {
    fn read(
        &self,
        _: &crate::system_ownership::SystemAddress,
    ) -> Result<crate::system_ownership::SystemValue, String> {
        Ok(self.value.borrow().clone())
    }
    fn change(
        &self,
        _: &crate::system_ownership::SystemAddress,
        expected: &crate::system_ownership::SystemValue,
        desired: &crate::system_ownership::SystemValue,
    ) -> Result<(), String> {
        if *self.value.borrow() != *expected {
            return Err("synthetic stale system item".into());
        }
        *self.value.borrow_mut() = desired.clone();
        fs::write(&self.path, b"changed only after all-root preflight")
            .map_err(|error| error.to_string())
    }
}

#[test]
fn post_preflight_history_failure_is_partial_per_root_and_successes_are_not_replayed() {
    use crate::system_ownership::{Origin, RegistryData, RegistryView, SystemAddress, SystemValue};
    let mut case = case();
    let integration = "11111111-2222-4333-8444-555555555555";
    let installed = SystemValue::Registry {
        value: Some(RegistryData {
            kind: 1,
            bytes: "Synthetic name"
                .encode_utf16()
                .chain(Some(0))
                .flat_map(u16::to_le_bytes)
                .collect(),
        }),
    };
    let entry=OwnedSystemEntry{schema_version:1,id:"synthetic-name".into(),receipt_id:uuid::Uuid::new_v4().to_string(),integration_id:integration.into(),origin:Origin::ManagerCreated,role:FileRole::Runtime,address:SystemAddress::RegistryValue{key:format!("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AgentResourceManager.{integration}"),value_name:"DisplayName".into(),view:RegistryView::View64},before:SystemValue::Registry{value:None},installed:installed.clone()};
    let mut record = read_resource(&case.manager, &case.record.id).unwrap();
    record.installation.as_mut().unwrap().system_entries = vec![entry];
    let expected = record.revision;
    record.revision += 1;
    case.manager
        .resource_store(StoreRequest::Replace {
            record: Box::new(record.clone()),
            expected_revision: expected,
        })
        .unwrap();
    let fake = DriftSystem {
        value: RefCell::new(installed),
        path: case.previous.join("tool.exe"),
    };
    let plan=preview_remove_with(&mut case.manager,&json!({"action":"preview_resource_remove","id":record.id,"expectedRevision":record.revision,"extent":"complete"}),&fake).unwrap();
    let saved = case
        .manager
        .previews
        .remove(plan["id"].as_str().unwrap())
        .unwrap();
    let result = apply_remove_with(
        &case.manager,
        serde_json::from_value(saved["prepared"].clone()).unwrap(),
        &fake,
    )
    .unwrap();
    assert_eq!(result["complete"], false);
    assert!(!result["result"]["failures"].as_array().unwrap().is_empty());
    assert!(!Path::new(&record.root_path).join("tool.exe").exists());
    assert!(case.previous.join("tool.exe").exists());
    assert!(!case.candidate.join("tool.exe").exists());
    assert!(!case.retained.join("tool.exe").exists());
    let current = read_resource(&case.manager, &record.id).unwrap();
    let installation = current.installation.as_ref().unwrap();
    assert!(installation.files.is_empty());
    assert_eq!(
        installation
            .removal_state
            .as_ref()
            .unwrap()
            .runtime_results
            .len(),
        4
    );
    assert_eq!(
        installation.removal_state.as_ref().unwrap().status,
        "partial"
    );
    let state = installation.update_state.as_ref().unwrap();
    assert_eq!(state.previous[0].files.len(), 4);
    assert!(state.candidate.as_ref().unwrap().files.is_empty());
    assert!(state.retained_candidates[0].candidate.files.is_empty());
    let fresh = preview(&mut case, "custom", &[]);
    assert_eq!(
        fresh["entries"].as_array().unwrap().len(),
        4,
        "completed roots no longer supply ownership to replay"
    );
    assert!(fresh["entries"]
        .as_array()
        .unwrap()
        .iter()
        .all(|entry| entry["runtimeId"]
            .as_str()
            .unwrap()
            .starts_with("previous:")));
}

#[test]
fn vanished_history_root_is_bound_as_absent_and_reappearance_invalidates_confirmation() {
    let mut case = case();
    for name in ["tool.exe", "private/runtime.dll", "LICENSE", "config.json"] {
        fs::remove_file(case.previous.join(name)).unwrap();
    }
    fs::remove_file(case.previous.join(crate::resource_manifest::NAME)).unwrap();
    fs::remove_dir(case.previous.join("private")).unwrap();
    fs::remove_dir(&case.previous).unwrap();
    let plan = preview(&mut case, "complete", &[]);
    fs::create_dir(&case.previous).unwrap();
    assert!(apply(&mut case, &plan)
        .unwrap_err()
        .contains("不存在的版本目录已变化"));
    assert!(Path::new(&case.record.root_path).join("tool.exe").exists());
    fs::remove_dir(&case.previous).unwrap();
    let fresh = preview(&mut case, "complete", &[]);
    let result = apply(&mut case, &fresh).unwrap();
    assert_eq!(result["complete"], true);
    let state = read_resource(&case.manager, &case.record.id)
        .unwrap()
        .installation
        .unwrap()
        .update_state
        .unwrap();
    assert!(state.previous[0].files.is_empty());
    assert!(!case.previous.exists());
}

#[test]
fn processing_intent_restart_requires_fresh_scope_and_never_replays_completed_file_removal() {
    for first_file_removed in [false, true] {
        let mut case = case();
        let old = preview(&mut case, "complete", &[]);
        let prepared: PreparedRemoval = serde_json::from_value(
            case.manager.previews[old["id"].as_str().unwrap()]["prepared"].clone(),
        )
        .unwrap();
        let mut record = read_resource(&case.manager, &case.record.id).unwrap();
        let expected = record.revision;
        record.enabled = false;
        record.revision += 1;
        let installation = record.installation.as_mut().unwrap();
        installation.status = "removing".into();
        // Model the persisted intent before a root result is committed. Normal
        // storage and file-operation primitives are used without claiming GUI.
        installation.removal_state = Some(RemovalState {
            plan_id: prepared.plan.id.clone(),
            extent: prepared.plan.extent.clone(),
            status: "processing".into(),
            complete: false,
            started_at: now(),
            updated_at: now(),
            file_entries: prepared
                .plan
                .entries
                .iter()
                .chain(
                    prepared
                        .runtime_plans
                        .iter()
                        .flat_map(|runtime| &runtime.plan.entries),
                )
                .cloned()
                .collect(),
            system_entry_ids: vec![],
            file_result: json!({"status":"pending","deleted":[],"retained":[],"failures":[]}),
            system_results: vec![],
            runtime_results: vec![],
            metadata_results: vec![],
            error: None,
        });
        case.manager
            .resource_store(StoreRequest::Replace {
                record: Box::new(record.clone()),
                expected_revision: expected,
            })
            .unwrap();
        let completed_path = crate::local::safe_join(&prepared.plan.root, "tool.exe").unwrap();
        if first_file_removed {
            let first = RemovalPlan {
                entries: prepared
                    .plan
                    .entries
                    .iter()
                    .filter(|entry| entry.relative == "tool.exe")
                    .cloned()
                    .collect(),
                ..prepared.plan.clone()
            };
            let result = resource_files::apply_removal(&first).unwrap();
            assert_eq!(result.deleted, vec![completed_path.clone()]);
            assert!(result.failures.is_empty());
        }
        let current_license = fs::read(Path::new(&record.root_path).join("LICENSE")).unwrap();
        let manager_directory = case.manager.data_dir.clone();
        let Case {
            manager,
            previous,
            candidate,
            retained,
            _dir,
            ..
        } = case;
        drop(manager);
        let manager = Manager::new(manager_directory).unwrap();
        let reopened = read_resource(&manager, &record.id).unwrap();
        assert!(!reopened.enabled);
        assert_eq!(reopened.installation.as_ref().unwrap().status, "removing");
        let journal = reopened
            .installation
            .as_ref()
            .unwrap()
            .removal_state
            .as_ref()
            .unwrap();
        assert_eq!(journal.status, "processing");
        assert_eq!(journal.plan_id, prepared.plan.id);
        assert!(journal.runtime_results.is_empty());
        assert!(manager.previews.is_empty());
        let mut case = Case {
            manager,
            record: reopened,
            previous,
            candidate,
            retained,
            _dir,
        };
        assert!(apply(&mut case, &old).is_err());
        assert_eq!(completed_path.exists(), !first_file_removed);
        assert_eq!(
            fs::read(Path::new(&record.root_path).join("LICENSE")).unwrap(),
            current_license
        );
        for root in [&case.previous, &case.candidate, &case.retained] {
            assert!(root.join("tool.exe").exists());
            assert!(root.join("private/runtime.dll").exists());
            assert!(root.join("LICENSE").exists());
            assert!(root.join("config.json").exists());
        }

        let fresh = preview(&mut case, "runtime", &[]);
        assert_ne!(fresh["id"], old["id"]);
        assert_eq!(fresh["extent"], "runtime");
        let original_tool = fresh["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["runtimeId"] == "current" && entry["relative"] == "tool.exe")
            .unwrap();
        assert_eq!(original_tool["expected"].is_null(), first_file_removed);
        assert_eq!(original_tool["remove"], !first_file_removed);
        let result = apply(&mut case, &fresh).unwrap();
        assert_eq!(result["complete"], true);
        let deleted = result["result"]["deleted"].as_array().unwrap();
        assert_eq!(deleted.len(), if first_file_removed { 10 } else { 11 });
        if first_file_removed {
            assert!(!deleted.contains(&json!(completed_path)));
        }
        assert!(result["result"]["failures"].as_array().unwrap().is_empty());
        assert!(apply(&mut case, &fresh).is_err());
        assert!(!completed_path.exists());
        let final_record = read_resource(&case.manager, &record.id).unwrap();
        assert!(final_record.installation.as_ref().unwrap().files.is_empty());
        let final_journal = final_record
            .installation
            .as_ref()
            .unwrap()
            .removal_state
            .as_ref()
            .unwrap();
        assert_eq!(final_journal.status, "complete");
        assert_eq!(final_journal.extent, RemovalExtent::Runtime);
        for root in [&case.previous, &case.candidate, &case.retained] {
            assert!(root.join("config.json").exists());
            assert!(!root.join("tool.exe").exists());
            assert!(!root.join("private/runtime.dll").exists());
        }
        assert_eq!(
            fs::read(case.candidate.join("unhashed.part")).unwrap(),
            b"unhashed partial bytes"
        );
    }
}
