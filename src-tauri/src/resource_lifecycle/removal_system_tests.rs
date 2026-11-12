use super::*;
use crate::system_ownership::{Origin, RegistryData, RegistryView, SystemAddress, SystemValue};
use std::{cell::RefCell, io::Write};

const INTEGRATION: &str = "11111111-2222-4333-8444-555555555555";

#[derive(Default)]
struct FakeSystem {
    values: RefCell<BTreeMap<String, SystemValue>>,
    writes: RefCell<Vec<String>>,
    denied: RefCell<BTreeSet<String>>,
    reads: RefCell<usize>,
    fail_read_at: RefCell<Option<usize>>,
}

impl SystemAccess for FakeSystem {
    fn read(&self, address: &SystemAddress) -> Result<SystemValue, String> {
        let mut reads = self.reads.borrow_mut();
        *reads += 1;
        if *self.fail_read_at.borrow() == Some(*reads) {
            return Err("synthetic post-intent change".into());
        }
        Ok(self
            .values
            .borrow()
            .get(&system_ownership::address_key(address))
            .cloned()
            .unwrap_or(SystemValue::Registry { value: None }))
    }
    fn change(
        &self,
        address: &SystemAddress,
        expected: &SystemValue,
        desired: &SystemValue,
    ) -> Result<(), String> {
        let key = system_ownership::address_key(address);
        if self.read(address)? != *expected || self.denied.borrow().contains(&key) {
            return Err("synthetic system write denied or changed".into());
        }
        self.values
            .borrow_mut()
            .insert(key.clone(), desired.clone());
        self.writes.borrow_mut().push(key);
        Ok(())
    }
}

fn reg_text(value: &str) -> SystemValue {
    SystemValue::Registry {
        value: Some(RegistryData {
            kind: 1,
            bytes: value
                .encode_utf16()
                .chain(Some(0))
                .flat_map(u16::to_le_bytes)
                .collect(),
        }),
    }
}

fn system_entry(id: &str, name: &str, value: &str) -> OwnedSystemEntry {
    OwnedSystemEntry {
        schema_version:1, id:id.into(), receipt_id:uuid::Uuid::new_v4().to_string(), integration_id:INTEGRATION.into(), origin:Origin::ManagerCreated, role:FileRole::Runtime,
        address:SystemAddress::RegistryValue { key:format!("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AgentResourceManager.{INTEGRATION}"),value_name:name.into(),view:RegistryView::View64 },
        before:SystemValue::Registry { value:None },installed:reg_text(value),
    }
}

fn fixture() -> tempfile::TempDir {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("work/lifecycle-system-removal-tests");
    fs::create_dir_all(&root).unwrap();
    tempfile::tempdir_in(root).unwrap()
}

fn install(m: &mut Manager, root: &Path) -> ResourceRecord {
    let archive = root.join("package.zip");
    let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
    for (name, bytes) in [
        ("bin/tool.exe", b"synthetic tool".as_slice()),
        ("LICENSE", b"synthetic terms".as_slice()),
    ] {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap();
    let plan=handle(m,&json!({"action":"preview_resource_install","archivePath":archive,"destinationPath":root.join("v1"),"name":"Synthetic portable","kind":"portable","repository":"https://github.com/example/portable","version":"v1","selectedFiles":["bin/tool.exe"]})).unwrap().unwrap();
    let result = apply_local(
        m,
        &json!({"action":"apply_resource_install","previewId":plan["id"]}),
    )
    .unwrap()
    .unwrap();
    read_resource(m, result["resource"]["id"].as_str().unwrap()).unwrap()
}

fn attach(
    m: &Manager,
    mut resource: ResourceRecord,
    entries: Vec<OwnedSystemEntry>,
    fake: &FakeSystem,
) -> ResourceRecord {
    for entry in &entries {
        fake.values.borrow_mut().insert(
            system_ownership::address_key(&entry.address),
            entry.installed.clone(),
        );
    }
    resource.installation.as_mut().unwrap().system_entries = entries;
    let expected = resource.revision;
    resource.revision += 1;
    m.resource_store(StoreRequest::Replace {
        record: Box::new(resource.clone()),
        expected_revision: expected,
    })
    .unwrap();
    resource
}

fn preview(
    m: &mut Manager,
    record: &ResourceRecord,
    extent: &str,
    ids: &[&str],
    fake: &FakeSystem,
) -> Value {
    preview_remove_with(m,&json!({"action":"preview_resource_remove","id":record.id,"expectedRevision":record.revision,"extent":extent,"customFiles":[],"customSystemIds":ids}),fake).unwrap()
}

fn consume(m: &mut Manager, plan: &Value, fake: &FakeSystem) -> Result<Value, String> {
    let saved = m.previews.remove(plan["id"].as_str().unwrap()).unwrap();
    apply_remove_with(
        m,
        serde_json::from_value(saved["prepared"].clone()).unwrap(),
        fake,
    )
}

#[test]
fn system_scope_is_publicly_redacted_but_internal_store_retains_original_receipts() {
    let dir = fixture();
    let mut m = Manager::new(dir.path().join("state")).unwrap();
    let fake = FakeSystem::default();
    let installed = install(&mut m, dir.path());
    let entry = system_entry("name", "DisplayName", "NotPublicRegistryPayload");
    let raw_installed = json!(entry.installed).to_string();
    let record = attach(&m, installed, vec![entry.clone()], &fake);
    let public = public_record(&record);
    assert!(!public["installation"]["systemEntries"]
        .to_string()
        .contains("bytes"));
    assert!(!public.to_string().contains(&raw_installed));
    assert!(public["installation"]["systemEntries"][0]["address"].is_object());
    let list = crate::resources::handle(&m, &json!({"action":"resource_list"}))
        .unwrap()
        .unwrap();
    assert!(!list["resources"][0]["installation"]["systemEntries"]
        .to_string()
        .contains("bytes"));
    assert!(!list.to_string().contains(&raw_installed));
    assert_eq!(
        read_resource(&m, &record.id)
            .unwrap()
            .installation
            .unwrap()
            .system_entries
            .as_slice(),
        std::slice::from_ref(&entry)
    );
    let mut historical = json!({"previous":{"installation":{"systemEntries":[entry.clone()]}},"retainedSystemEntries":[entry]});
    scrub_public_receipts(&mut historical);
    assert!(!historical.to_string().contains("installed"));
    assert!(!historical.to_string().contains("before"));
    let plan = preview(&mut m, &record, "complete", &[], &fake);
    assert!(!plan["systemEntries"].to_string().contains("bytes"));
    for entry in plan["systemEntries"].as_array().unwrap() {
        for private_field in ["before", "installed", "expected", "desired"] {
            assert!(entry.get(private_field).is_none(), "{private_field}");
        }
    }
    assert!(!plan.to_string().contains(&raw_installed));
    assert!(!plan.to_string().contains("NotPublicRegistryPayload"));
    assert_eq!(plan["systemEntries"][0]["operation"], "remove");
    assert!(fake.writes.borrow().is_empty());
}

#[test]
fn native_remove_integration_persists_exact_results_and_clears_only_completed_ownership() {
    let dir = fixture();
    let mut m = Manager::new(dir.path().join("state")).unwrap();
    let fake = FakeSystem::default();
    let installed = install(&mut m, dir.path());
    let source = installed.repository.clone();
    let record = attach(
        &m,
        installed,
        vec![system_entry("name", "DisplayName", "Name")],
        &fake,
    );
    fs::write(dir.path().join("v1/unowned.txt"), b"keep unknown").unwrap();
    let plan = preview(&mut m, &record, "complete", &[], &fake);
    assert_eq!(plan["canApply"], true);
    let result = consume(&mut m, &plan, &fake).unwrap();
    assert_eq!(result["complete"], true);
    assert_eq!(result["fullyRemoved"], false);
    let current = read_resource(&m, &record.id).unwrap();
    let installation = current.installation.as_ref().unwrap();
    assert!(installation.files.is_empty());
    assert!(installation.system_entries.is_empty());
    assert!(installation.removal_state.as_ref().unwrap().complete);
    assert_eq!(
        installation.removal_state.as_ref().unwrap().system_results[0].status,
        "deleted"
    );
    assert_eq!(current.repository, source);
    assert!(!current.enabled);
    assert_eq!(
        fs::read(dir.path().join("v1/unowned.txt")).unwrap(),
        b"keep unknown"
    );
    assert!(!dir.path().join("v1/bin/tool.exe").exists());
    assert_eq!(fake.writes.borrow().len(), 1);
    assert!(current
        .capabilities
        .iter()
        .all(|capability| capability["status"] != "available"));
}

#[test]
fn partial_system_failure_keeps_remaining_receipt_and_new_preview_does_not_replay_success() {
    let dir = fixture();
    let mut m = Manager::new(dir.path().join("state")).unwrap();
    let fake = FakeSystem::default();
    let entries = vec![
        system_entry("name", "DisplayName", "Name"),
        system_entry("version", "DisplayVersion", "1"),
    ];
    let installed = install(&mut m, dir.path());
    let record = attach(&m, installed, entries.clone(), &fake);
    fake.denied
        .borrow_mut()
        .insert(system_ownership::address_key(&entries[1].address));
    let plan = preview(&mut m, &record, "complete", &[], &fake);
    let result = consume(&mut m, &plan, &fake).unwrap();
    assert_eq!(result["complete"], false);
    let current = read_resource(&m, &record.id).unwrap();
    let installation = current.installation.as_ref().unwrap();
    assert_eq!(installation.system_entries.len(), 1);
    assert_eq!(installation.system_entries[0].id, "version");
    let state = installation.removal_state.as_ref().unwrap();
    assert!(!state.complete);
    assert_eq!(state.status, "partial");
    assert_eq!(
        state
            .system_results
            .iter()
            .map(|result| result.status.as_str())
            .collect::<Vec<_>>(),
        ["deleted", "failed"]
    );
    drop(m);
    let mut m = Manager::new(dir.path().join("state")).unwrap();
    let reopened = read_resource(&m, &record.id).unwrap();
    assert_eq!(
        reopened
            .installation
            .as_ref()
            .unwrap()
            .removal_state
            .as_ref()
            .unwrap()
            .system_results
            .len(),
        2
    );
    assert_eq!(
        fake.writes.borrow().len(),
        1,
        "opening the manager must not replay system writes"
    );
    fake.denied.borrow_mut().clear();
    fake.writes.borrow_mut().clear();
    let fresh = preview(&mut m, &reopened, "complete", &[], &fake);
    assert_eq!(fresh["systemEntries"].as_array().unwrap().len(), 1);
    assert_eq!(fresh["systemEntries"][0]["id"], "version");
    assert_eq!(consume(&mut m, &fresh, &fake).unwrap()["complete"], true);
    assert_eq!(fake.writes.borrow().len(), 1);
    assert!(read_resource(&m, &record.id)
        .unwrap()
        .installation
        .unwrap()
        .system_entries
        .is_empty());
}

#[test]
fn custom_system_ids_do_not_select_files_or_other_system_items_and_unknown_ids_fail() {
    let dir = fixture();
    let mut m = Manager::new(dir.path().join("state")).unwrap();
    let fake = FakeSystem::default();
    let entries = vec![
        system_entry("name", "DisplayName", "Name"),
        system_entry("version", "DisplayVersion", "1"),
    ];
    let installed = install(&mut m, dir.path());
    let record = attach(&m, installed, entries, &fake);
    assert!(preview_remove_with(&mut m,&json!({"action":"preview_resource_remove","id":record.id,"expectedRevision":record.revision,"extent":"custom","customFiles":[],"customSystemIds":["not-owned"]}),&fake).is_err());
    let plan = preview(&mut m, &record, "custom", &["name"], &fake);
    let result = consume(&mut m, &plan, &fake).unwrap();
    assert_eq!(result["complete"], true);
    assert!(dir.path().join("v1/bin/tool.exe").is_file());
    assert!(dir.path().join("v1/LICENSE").is_file());
    let remaining = read_resource(&m, &record.id).unwrap().installation.unwrap();
    assert_eq!(remaining.files.len(), 2);
    assert_eq!(remaining.system_entries.len(), 1);
    assert_eq!(remaining.system_entries[0].id, "version");
    assert_eq!(fake.writes.borrow().len(), 1);
}

#[test]
fn untrusted_receipts_and_external_json_cannot_grant_system_ownership() {
    let dir = fixture();
    let mut m = Manager::new(dir.path().join("state")).unwrap();
    let fake = FakeSystem::default();
    let mut invalid = system_entry("name", "DisplayName", "Name");
    invalid.schema_version = 99;
    let installed = install(&mut m, dir.path());
    let record = attach(&m, installed, vec![invalid.clone()], &fake);
    let plan = preview(&mut m, &record, "custom", &["name"], &fake);
    assert_eq!(plan["systemEntries"][0]["operation"], "keep");
    assert_eq!(consume(&mut m, &plan, &fake).unwrap()["complete"], false);
    assert_eq!(
        read_resource(&m, &record.id)
            .unwrap()
            .installation
            .unwrap()
            .system_entries,
        [invalid.clone()]
    );
    assert!(fake.writes.borrow().is_empty());
    assert!(dir.path().join("v1/bin/tool.exe").exists());
    let fresh = read_resource(&m, &record.id).unwrap();
    assert!(crate::resources::handle(&m,&json!({"action":"resource_update","id":record.id,"expectedRevision":fresh.revision,"changes":{"installation":{"systemEntries":[invalid]}}})).is_err());
    assert!(preview_remove_with(&mut m,&json!({"action":"preview_resource_remove","id":record.id,"expectedRevision":fresh.revision,"extent":"complete","systemEntries":[]}),&fake).is_err());
}

#[test]
fn shared_system_items_and_new_shared_roots_are_not_removed() {
    let dir = fixture();
    let mut m = Manager::new(dir.path().join("state")).unwrap();
    let fake = FakeSystem::default();
    let entry = system_entry("name", "DisplayName", "Name");
    let installed = install(&mut m, dir.path());
    let record = attach(&m, installed, vec![entry.clone()], &fake);
    let old = preview(&mut m, &record, "complete", &[], &fake);
    let other_path = dir.path().join("other");
    fs::create_dir(&other_path).unwrap();
    let other=crate::resources::handle(&m,&json!({"action":"resource_register","name":"Other tool","kind":"portable","rootPath":other_path})).unwrap().unwrap();
    let mut other: ResourceRecord = serde_json::from_value(other["resource"].clone()).unwrap();
    let mut installation = record.installation.clone().unwrap();
    installation.files.clear();
    installation.system_entries = vec![entry];
    other.installation = Some(installation);
    let expected = other.revision;
    other.revision += 1;
    m.resource_store(StoreRequest::Replace {
        record: Box::new(other),
        expected_revision: expected,
    })
    .unwrap();
    assert!(consume(&mut m, &old, &fake).unwrap_err().contains("共享"));
    assert!(dir.path().join("v1/bin/tool.exe").exists());
    assert!(fake.writes.borrow().is_empty());
    let fresh = preview(&mut m, &record, "custom", &["name"], &fake);
    assert_eq!(fresh["systemEntries"][0]["operation"], "keep");
    assert_eq!(consume(&mut m, &fresh, &fake).unwrap()["complete"], false);
    assert!(fake.writes.borrow().is_empty());
}

#[test]
fn file_drift_prevents_first_system_write_and_post_intent_system_drift_becomes_durable_partial() {
    let dir = fixture();
    let mut m = Manager::new(dir.path().join("state")).unwrap();
    let fake = FakeSystem::default();
    let installed = install(&mut m, dir.path());
    let record = attach(
        &m,
        installed,
        vec![system_entry("name", "DisplayName", "Name")],
        &fake,
    );
    let old = preview(&mut m, &record, "complete", &[], &fake);
    fs::write(dir.path().join("v1/LICENSE"), b"changed locally").unwrap();
    assert!(consume(&mut m, &old, &fake).is_err());
    assert!(fake.writes.borrow().is_empty());
    assert_eq!(json!(read_resource(&m, &record.id).unwrap()), json!(record));
    let fresh = preview(&mut m, &record, "complete", &[], &fake);
    *fake.fail_read_at.borrow_mut() = Some(*fake.reads.borrow() + 2);
    let result = consume(&mut m, &fresh, &fake).unwrap();
    assert_eq!(result["complete"], false);
    assert_eq!(
        result["systemResult"]["entries"][0]["status"],
        "notAttempted"
    );
    assert!(fake.writes.borrow().is_empty());
    assert!(dir.path().join("v1/bin/tool.exe").exists());
    let current = read_resource(&m, &record.id).unwrap();
    let installation = current.installation.unwrap();
    assert_eq!(
        installation.removal_state.as_ref().unwrap().status,
        "partial"
    );
    assert!(!installation.removal_state.unwrap().complete);
    assert_eq!(installation.system_entries.len(), 1);
    assert_eq!(installation.files.len(), 2);
    assert!(!current.enabled);
}

#[test]
fn native_only_expired_or_request_mutated_confirmation_never_reaches_system_access() {
    let dir = fixture();
    let mut m = Manager::new(dir.path().join("state")).unwrap();
    let fake = FakeSystem::default();
    let installed = install(&mut m, dir.path());
    let record = attach(
        &m,
        installed,
        vec![system_entry("name", "DisplayName", "Name")],
        &fake,
    );
    let plan = preview(&mut m, &record, "complete", &[], &fake);
    let id = plan["id"].as_str().unwrap();
    assert!(handle(
        &mut m,
        &json!({"action":"apply_resource_remove","previewId":id})
    )
    .is_err());
    assert!(apply_local(
        &mut m,
        &json!({"action":"apply_resource_remove","previewId":id,"confirmed":true})
    )
    .is_err());
    m.previews.get_mut(id).unwrap()["createdAt"] =
        json!(chrono::Utc::now().timestamp_millis() - 601_000);
    assert!(apply_local(
        &mut m,
        &json!({"action":"apply_resource_remove","previewId":id})
    )
    .unwrap_err()
    .contains("10分钟"));
    assert!(!m.previews.contains_key(id));
    assert!(fake.writes.borrow().is_empty());
    assert!(dir.path().join("v1/bin/tool.exe").is_file());
    assert_eq!(json!(read_resource(&m, &record.id).unwrap()), json!(record));
}

#[test]
fn replaced_runtime_directory_invalidates_preview_before_any_file_or_system_write() {
    let dir = fixture();
    let mut m = Manager::new(dir.path().join("state")).unwrap();
    let fake = FakeSystem::default();
    let installed = install(&mut m, dir.path());
    let record = attach(
        &m,
        installed,
        vec![system_entry("name", "DisplayName", "Name")],
        &fake,
    );
    let plan = preview(&mut m, &record, "complete", &[], &fake);
    fs::rename(dir.path().join("v1"), dir.path().join("original-v1")).unwrap();
    fs::create_dir_all(dir.path().join("v1/bin")).unwrap();
    fs::write(dir.path().join("v1/bin/tool.exe"), b"synthetic tool").unwrap();
    fs::write(dir.path().join("v1/LICENSE"), b"synthetic terms").unwrap();
    assert!(consume(&mut m, &plan, &fake)
        .unwrap_err()
        .contains("目录对象已替换"));
    assert!(dir.path().join("v1/bin/tool.exe").is_file());
    assert!(dir.path().join("original-v1/bin/tool.exe").is_file());
    assert!(fake.writes.borrow().is_empty());
    assert_eq!(json!(read_resource(&m, &record.id).unwrap()), json!(record));
}
