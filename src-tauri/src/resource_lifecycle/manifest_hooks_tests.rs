use super::*;
use std::io::Write;

fn fixture() -> tempfile::TempDir {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("work/lifecycle-manifest-tests");
    fs::create_dir_all(&root).unwrap();
    tempfile::tempdir_in(root).unwrap()
}
fn package(root: &Path) -> PathBuf {
    let archive = root.join("synthetic.zip");
    let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
    for (path, bytes) in [
        ("tool.exe", "synthetic runtime"),
        ("LICENSE", "synthetic license"),
        ("config.json", "never-copy-private-value"),
    ] {
        zip.start_file(path, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes.as_bytes()).unwrap();
    }
    zip.finish().unwrap();
    archive
}
fn request(root: &Path) -> Value {
    json!({"action":"preview_resource_install","archivePath":package(root),"destinationPath":root.join("tool"),"name":"Synthetic manifest tool","kind":"portable","version":"1","selectedFiles":["tool.exe","config.json"],"fileRoles":{"tool.exe":"runtime","config.json":"configuration"}})
}
fn install(m: &mut Manager, root: &Path) -> ResourceRecord {
    let plan = handle(m, &request(root)).unwrap().unwrap();
    assert_eq!(
        path_key(Path::new(plan["metadata"]["targetPath"].as_str().unwrap())),
        path_key(&root.join("tool").join(crate::resource_manifest::NAME))
    );
    let result = apply_local(
        m,
        &json!({"action":"apply_resource_install","previewId":plan["id"]}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(result["complete"], true);
    read_resource(m, result["resource"]["id"].as_str().unwrap()).unwrap()
}
fn remove(m: &mut Manager, record: &ResourceRecord, extent: &str, custom: &[&str]) -> Value {
    handle(m,&json!({"action":"preview_resource_remove","id":record.id,"expectedRevision":record.revision,"extent":extent,"customFiles":custom})).unwrap().unwrap()
}

#[test]
fn new_tool_install_writes_one_nonsecret_native_recovery_index_without_claiming_private_files() {
    let dir = fixture();
    let mut manager = Manager::new(dir.path().join("manager")).unwrap();
    let record = install(&mut manager, dir.path());
    let root = Path::new(&record.root_path);
    let receipt = record
        .installation
        .as_ref()
        .unwrap()
        .resource_manifest
        .as_ref()
        .unwrap();
    crate::resource_manifest::validate_owned(root, receipt).unwrap();
    let text = fs::read_to_string(root.join(crate::resource_manifest::NAME)).unwrap();
    assert!(!text.contains("never-copy-private-value"));
    assert!(!text.contains("config.json"));
    assert!(record
        .installation
        .as_ref()
        .unwrap()
        .files
        .iter()
        .all(|file| file.path != crate::resource_manifest::NAME));
    let recovered = crate::resource_manifest::recover(root).unwrap();
    assert_eq!(recovered["resourceId"], record.id);
    assert_eq!(recovered["version"], "1");
    assert_eq!(recovered["canRegister"], true);
    assert_eq!(recovered["executionGrant"], false);
    assert_eq!(recovered["deleteGrant"], false);
    assert_eq!(recovered["automaticUpdateGrant"], false);
    assert_eq!(recovered["verifiedFiles"].as_array().unwrap().len(), 2);
    assert!(recovered["unknownFilesRetained"]
        .as_array()
        .unwrap()
        .contains(&json!("config.json")));
    assert_eq!(
        fs::read_dir(root).unwrap().count(),
        4,
        "no backup, metadata mirror or staging directory is created"
    );
}

#[test]
fn metadata_collision_after_extraction_is_partial_and_keeps_runtime_ownership_and_unknown_object() {
    let dir = fixture();
    let mut manager = Manager::new(dir.path().join("manager")).unwrap();
    let plan = handle(&mut manager, &request(dir.path())).unwrap().unwrap();
    let saved = manager
        .previews
        .remove(plan["id"].as_str().unwrap())
        .unwrap();
    let result = apply_install_with_metadata(
        &manager,
        serde_json::from_value(saved["prepared"].clone()).unwrap(),
        |resource, receipt| {
            fs::write(
                receipt.root.join(crate::resource_manifest::NAME),
                b"unknown object created by another actor",
            )
            .unwrap();
            let metadata =
                prepare_manifest(resource, &receipt.root, &receipt.files, receipt.complete)?;
            crate::resource_manifest::write_new(&receipt.root, &metadata)
        },
    )
    .unwrap();
    assert_eq!(result["complete"], false);
    assert_eq!(result["metadata"]["status"], "failed");
    let record = read_resource(&manager, result["resource"]["id"].as_str().unwrap()).unwrap();
    let installation = record.installation.unwrap();
    assert_eq!(installation.status, "partial");
    assert_eq!(installation.files.len(), 3);
    assert!(installation.resource_manifest.is_none());
    assert!(!record.enabled);
    let root = Path::new(&record.root_path);
    assert_eq!(
        fs::read(root.join(crate::resource_manifest::NAME)).unwrap(),
        b"unknown object created by another actor"
    );
    assert_eq!(
        fs::read(root.join("tool.exe")).unwrap(),
        b"synthetic runtime"
    );
}

#[test]
fn skill_install_keeps_original_minimal_layout_without_tool_metadata() {
    let dir = fixture();
    let mut manager = Manager::new(dir.path().join("manager")).unwrap();
    let mut input = request(dir.path());
    input["kind"] = json!("skill");
    let plan = handle(&mut manager, &input).unwrap().unwrap();
    assert!(plan["metadata"].is_null());
    let result = apply_local(
        &mut manager,
        &json!({"action":"apply_resource_install","previewId":plan["id"]}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(result["complete"], true);
    assert_eq!(result["metadata"]["status"], "notApplicable");
    assert!(!dir
        .path()
        .join("tool")
        .join(crate::resource_manifest::NAME)
        .exists());
    assert!(dir.path().join("tool/tool.exe").exists());
}

#[test]
fn repair_refreshes_only_exact_registered_index_and_metadata_drift_stops_before_runtime_writes() {
    let dir = fixture();
    let mut manager = Manager::new(dir.path().join("manager")).unwrap();
    let record = install(&mut manager, dir.path());
    let root = Path::new(&record.root_path);
    let old = record
        .installation
        .as_ref()
        .unwrap()
        .resource_manifest
        .as_ref()
        .unwrap()
        .clone();
    fs::remove_file(root.join("LICENSE")).unwrap();
    let plan=handle(&mut manager,&json!({"action":"preview_resource_repair","id":record.id,"expectedRevision":record.revision})).unwrap().unwrap();
    let result = apply_local(
        &mut manager,
        &json!({"action":"apply_resource_repair","previewId":plan["id"]}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(result["complete"], true);
    assert_eq!(result["metadata"]["status"], "updated");
    let current = read_resource(&manager, &record.id).unwrap();
    let manifest = current
        .installation
        .as_ref()
        .unwrap()
        .resource_manifest
        .as_ref()
        .unwrap();
    assert_eq!(manifest.file_id, old.file_id);
    crate::resource_manifest::validate_owned(root, manifest).unwrap();
    fs::remove_file(root.join("LICENSE")).unwrap();
    let plan=handle(&mut manager,&json!({"action":"preview_resource_repair","id":current.id,"expectedRevision":current.revision})).unwrap().unwrap();
    let mut changed = fs::read(root.join(crate::resource_manifest::NAME)).unwrap();
    changed.push(b' ');
    fs::write(root.join(crate::resource_manifest::NAME), &changed).unwrap();
    assert!(apply_local(
        &mut manager,
        &json!({"action":"apply_resource_repair","previewId":plan["id"]})
    )
    .is_err());
    assert!(!root.join("LICENSE").exists());
    assert_eq!(
        fs::read(root.join(crate::resource_manifest::NAME)).unwrap(),
        changed
    );
    assert_eq!(
        json!(read_resource(&manager, &record.id).unwrap()),
        json!(current)
    );
}

#[test]
fn runtime_removal_preserves_metadata_then_full_removal_explicitly_removes_the_registered_index() {
    let dir = fixture();
    let mut manager = Manager::new(dir.path().join("manager")).unwrap();
    let record = install(&mut manager, dir.path());
    let root = PathBuf::from(&record.root_path);
    let plan = remove(&mut manager, &record, "runtime", &[]);
    assert_eq!(plan["metadataEntries"][0]["requested"], false);
    assert_eq!(plan["metadataEntries"][0]["remove"], false);
    let result = apply_local(
        &mut manager,
        &json!({"action":"apply_resource_remove","previewId":plan["id"]}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(result["complete"], true);
    assert!(root.join(crate::resource_manifest::NAME).is_file());
    assert!(root.join("config.json").is_file());
    let current = read_resource(&manager, &record.id).unwrap();
    let plan = remove(&mut manager, &current, "complete", &[]);
    assert_eq!(plan["metadataEntries"][0]["remove"], true);
    assert!(plan["entries"]
        .as_array()
        .unwrap()
        .iter()
        .all(|entry| entry["relative"] != crate::resource_manifest::NAME));
    let result = apply_local(
        &mut manager,
        &json!({"action":"apply_resource_remove","previewId":plan["id"]}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(result["complete"], true);
    assert_eq!(result["metadataResult"]["entries"][0]["status"], "deleted");
    assert!(!root.join(crate::resource_manifest::NAME).exists());
    assert!(root.is_dir());
    assert!(read_resource(&manager, &record.id)
        .unwrap()
        .installation
        .unwrap()
        .resource_manifest
        .is_none());
}

#[test]
fn custom_metadata_selection_is_separate_and_modified_indexes_are_kept_without_reclassification() {
    let dir = fixture();
    let mut manager = Manager::new(dir.path().join("manager")).unwrap();
    let record = install(&mut manager, dir.path());
    let root = PathBuf::from(&record.root_path);
    let plan = remove(&mut manager, &record, "custom", &["metadata:current"]);
    let result = apply_local(
        &mut manager,
        &json!({"action":"apply_resource_remove","previewId":plan["id"]}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(result["complete"], true);
    assert_eq!(result["metadataResult"]["entries"][0]["status"], "deleted");
    assert!(root.join("tool.exe").is_file());
    assert!(root.join("LICENSE").is_file());
    assert_eq!(result["result"]["deleted"].as_array().unwrap().len(), 0);
    let current = read_resource(&manager, &record.id).unwrap();
    fs::write(
        root.join(crate::resource_manifest::NAME),
        b"unregistered private object",
    )
    .unwrap();
    let plan = remove(&mut manager, &current, "complete", &[]);
    assert!(plan["metadataEntries"].as_array().unwrap().is_empty());
    assert!(plan["protectedEntries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["reason"].as_str().unwrap().contains("没有精确")));
    let result = apply_local(
        &mut manager,
        &json!({"action":"apply_resource_remove","previewId":plan["id"]}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(result["complete"], true);
    assert_eq!(
        fs::read(root.join(crate::resource_manifest::NAME)).unwrap(),
        b"unregistered private object"
    );
}

#[test]
fn registered_metadata_changes_invalidate_old_confirmation_and_are_preserved_in_a_fresh_preview() {
    let dir = fixture();
    let mut manager = Manager::new(dir.path().join("manager")).unwrap();
    let record = install(&mut manager, dir.path());
    let root = PathBuf::from(&record.root_path);
    let old = remove(&mut manager, &record, "complete", &[]);
    let mut bytes = fs::read(root.join(crate::resource_manifest::NAME)).unwrap();
    bytes.push(b' ');
    fs::write(root.join(crate::resource_manifest::NAME), &bytes).unwrap();
    assert!(apply_local(
        &mut manager,
        &json!({"action":"apply_resource_remove","previewId":old["id"]})
    )
    .is_err());
    assert!(root.join("tool.exe").exists());
    assert_eq!(
        json!(read_resource(&manager, &record.id).unwrap()),
        json!(record)
    );
    let fresh = remove(&mut manager, &record, "complete", &[]);
    assert_eq!(fresh["metadataEntries"][0]["status"], "changed");
    assert_eq!(fresh["metadataEntries"][0]["remove"], false);
    let result = apply_local(
        &mut manager,
        &json!({"action":"apply_resource_remove","previewId":fresh["id"]}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(result["complete"], false);
    assert_eq!(result["metadataResult"]["entries"][0]["status"], "retained");
    assert_eq!(
        fs::read(root.join(crate::resource_manifest::NAME)).unwrap(),
        bytes
    );
    assert!(!result["result"]["failures"].as_array().unwrap().is_empty());
    assert!(read_resource(&manager, &record.id)
        .unwrap()
        .installation
        .unwrap()
        .resource_manifest
        .is_some());
}

#[test]
fn legacy_repair_never_rewrites_or_adopts_an_unregistered_same_name_file() {
    let dir = fixture();
    let mut manager = Manager::new(dir.path().join("manager")).unwrap();
    let mut record = install(&mut manager, dir.path());
    let root = PathBuf::from(&record.root_path);
    record.installation.as_mut().unwrap().resource_manifest = None;
    let expected = record.revision;
    record.revision += 1;
    manager
        .resource_store(StoreRequest::Replace {
            record: Box::new(record.clone()),
            expected_revision: expected,
        })
        .unwrap();
    fs::write(
        root.join(crate::resource_manifest::NAME),
        b"legacy user data - never adopt",
    )
    .unwrap();
    fs::remove_file(root.join("LICENSE")).unwrap();
    let plan=handle(&mut manager,&json!({"action":"preview_resource_repair","id":record.id,"expectedRevision":record.revision})).unwrap().unwrap();
    assert!(plan["metadata"].is_null());
    let result = apply_local(
        &mut manager,
        &json!({"action":"apply_resource_repair","previewId":plan["id"]}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(result["complete"], true);
    assert_eq!(result["metadata"]["status"], "notRegistered");
    assert_eq!(
        fs::read(root.join(crate::resource_manifest::NAME)).unwrap(),
        b"legacy user data - never adopt"
    );
    assert!(root.join("LICENSE").exists());
    assert!(read_resource(&manager, &record.id)
        .unwrap()
        .installation
        .unwrap()
        .resource_manifest
        .is_none());
}
