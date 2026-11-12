use super::*;
use std::{cell::RefCell, collections::BTreeMap};

const INTEGRATION: &str = "11111111-2222-4333-8444-555555555555";

#[derive(Default)]
struct Fake {
    values: RefCell<BTreeMap<String, SystemValue>>,
    writes: RefCell<Vec<String>>,
    reads: RefCell<usize>,
    fail: RefCell<BTreeSet<String>>,
    unreadable: RefCell<BTreeSet<String>>,
}

fn location(address: &SystemAddress) -> String {
    match address {
        SystemAddress::UserPathFragment { .. } => "hkcu:user-path".into(),
        other => address_key(other),
    }
}

impl Fake {
    fn put(&self, address: &SystemAddress, value: SystemValue) {
        self.values.borrow_mut().insert(location(address), value);
    }
    fn from_owners(owners: &[OwnedSystemEntry]) -> Self {
        let fake = Self::default();
        for owner in owners {
            fake.put(&owner.address, owner.installed.clone());
        }
        fake
    }
}

impl SystemAccess for Fake {
    fn read(&self, address: &SystemAddress) -> Result<SystemValue, String> {
        *self.reads.borrow_mut() += 1;
        let key = location(address);
        if self.unreadable.borrow().contains(&key) {
            return Err("synthetic unreadable value".into());
        }
        Ok(self
            .values
            .borrow()
            .get(&key)
            .cloned()
            .unwrap_or(match address {
                SystemAddress::RegistryValue { .. } | SystemAddress::UserPathFragment { .. } => {
                    SystemValue::Registry { value: None }
                }
                _ => SystemValue::Absent,
            }))
    }
    fn change(
        &self,
        address: &SystemAddress,
        expected: &SystemValue,
        desired: &SystemValue,
    ) -> Result<(), String> {
        let key = location(address);
        if self.read(address)? != *expected {
            return Err("synthetic stale value".into());
        }
        if self.fail.borrow().contains(&key) {
            return Err("synthetic write denied".into());
        }
        self.writes.borrow_mut().push(key);
        self.put(address, desired.clone());
        Ok(())
    }
}

fn text(value: &str) -> SystemValue {
    SystemValue::Registry {
        value: Some(path_data(value, 1)),
    }
}

fn owner(
    id: &str,
    address: SystemAddress,
    before: SystemValue,
    installed: SystemValue,
) -> OwnedSystemEntry {
    OwnedSystemEntry {
        schema_version: 1,
        id: id.into(),
        receipt_id: uuid::Uuid::new_v4().to_string(),
        integration_id: INTEGRATION.into(),
        origin: Origin::ManagerCreated,
        role: FileRole::Runtime,
        address,
        before,
        installed,
    }
}

fn registry(id: &str, name: &str, before: Option<&str>, after: &str) -> OwnedSystemEntry {
    owner(id, SystemAddress::RegistryValue {
        key: format!("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AgentResourceManager.{INTEGRATION}"),
        value_name: name.into(), view: RegistryView::View64,
    }, before.map(text).unwrap_or(SystemValue::Registry { value: None }), text(after))
}

fn path_owner(id: &str, token: &str, before: Option<&str>, installed: &str) -> OwnedSystemEntry {
    owner(
        id,
        SystemAddress::UserPathFragment {
            token: token.into(),
            view: RegistryView::Native,
        },
        before
            .map(text)
            .unwrap_or(SystemValue::Registry { value: None }),
        text(installed),
    )
}

fn full(owners: &[OwnedSystemEntry], fake: &Fake) -> SystemPlan {
    preview(
        owners,
        &RemovalExtent::Complete,
        &BTreeSet::new(),
        &BTreeSet::new(),
        fake,
    )
    .unwrap()
}

fn apply_all(plan: &SystemPlan, owners: &[OwnedSystemEntry], fake: &Fake) -> SystemResult {
    apply(plan, owners, &BTreeSet::new(), fake, |_| Ok(())).unwrap()
}

#[test]
fn registry_restores_exact_value_and_keeps_other_values() {
    let owners = vec![
        registry(
            "name",
            "DisplayName",
            Some("Old public name"),
            "New public name",
        ),
        registry("version", "DisplayVersion", None, "1.0"),
    ];
    let fake = Fake::from_owners(&owners);
    let other = registry("other", "Publisher", None, "Unrelated publisher");
    fake.put(&other.address, other.installed.clone());
    let plan = full(&owners, &fake);
    assert_eq!(plan.entries[0].operation, Operation::Restore);
    assert_eq!(plan.entries[1].operation, Operation::Remove);
    let result = apply_all(&plan, &owners, &fake);
    assert!(result.complete);
    assert_eq!(fake.read(&owners[0].address).unwrap(), owners[0].before);
    assert_eq!(
        fake.read(&owners[1].address).unwrap(),
        SystemValue::Registry { value: None }
    );
    assert_eq!(fake.read(&other.address).unwrap(), other.installed);
    assert_eq!(fake.writes.borrow().len(), 2);
}

#[test]
fn changed_or_shared_system_items_are_preserved_even_when_custom_selected() {
    let owners = vec![registry("name", "DisplayName", None, "Public name")];
    let fake = Fake::from_owners(&owners);
    fake.put(&owners[0].address, text("Changed elsewhere"));
    let custom = BTreeSet::from(["name".into()]);
    let plan = preview(
        &owners,
        &RemovalExtent::Custom,
        &custom,
        &BTreeSet::new(),
        &fake,
    )
    .unwrap();
    assert_eq!(plan.entries[0].operation, Operation::Keep);
    assert!(!apply_all(&plan, &owners, &fake).complete);
    assert!(fake.writes.borrow().is_empty());
    fake.put(&owners[0].address, owners[0].installed.clone());
    let shared = BTreeSet::from([address_key(&owners[0].address)]);
    let plan = preview(
        &owners,
        &RemovalExtent::Complete,
        &BTreeSet::new(),
        &shared,
        &fake,
    )
    .unwrap();
    assert_eq!(plan.entries[0].operation, Operation::Keep);
    assert!(
        !apply(&plan, &owners, &shared, &fake, |_| Ok(()))
            .unwrap()
            .complete
    );
    assert!(fake.writes.borrow().is_empty());
}

#[test]
fn disabled_and_runtime_scopes_preserve_configuration_and_custom_is_exact() {
    let mut owners = vec![
        registry("runtime", "DisplayName", None, "Name"),
        registry("config", "Publisher", None, "Publisher"),
    ];
    owners[1].role = FileRole::Configuration;
    let fake = Fake::from_owners(&owners);
    let disabled = preview(
        &owners,
        &RemovalExtent::Disable,
        &BTreeSet::new(),
        &BTreeSet::new(),
        &fake,
    )
    .unwrap();
    assert_eq!(*fake.reads.borrow(), 0);
    assert!(disabled
        .entries
        .iter()
        .all(|entry| !entry.requested && entry.operation == Operation::Keep));
    let runtime = preview(
        &owners,
        &RemovalExtent::Runtime,
        &BTreeSet::new(),
        &BTreeSet::new(),
        &fake,
    )
    .unwrap();
    assert!(runtime.entries[0].requested);
    assert!(!runtime.entries[1].requested);
    let custom = preview(
        &owners,
        &RemovalExtent::Custom,
        &BTreeSet::from(["config".into()]),
        &BTreeSet::new(),
        &fake,
    )
    .unwrap();
    assert!(!custom.entries[0].requested);
    assert_eq!(custom.entries[1].operation, Operation::Remove);
    assert!(preview(
        &owners,
        &RemovalExtent::Custom,
        &BTreeSet::from(["unowned".into()]),
        &BTreeSet::new(),
        &fake
    )
    .is_err());
    assert!(fake.writes.borrow().is_empty());
}

#[test]
fn untrusted_schema_sensitive_values_and_whole_path_have_no_action() {
    let base = registry("name", "DisplayName", None, "Name");
    let mut invalid = base.clone();
    invalid.schema_version = 99;
    assert!(validate_receipt(&invalid).is_err());
    invalid = base.clone();
    invalid.receipt_id.clear();
    assert!(validate_receipt(&invalid).is_err());
    invalid = base.clone();
    invalid.integration_id.clear();
    assert!(validate_receipt(&invalid).is_err());
    invalid = base.clone();
    invalid.before = text("password=do-not-store");
    assert!(validate_receipt(&invalid).is_err());
    invalid = base.clone();
    invalid.installed = SystemValue::Registry {
        value: Some(RegistryData {
            kind: 3,
            bytes: vec![1, 2, 3],
        }),
    };
    assert!(validate_receipt(&invalid).is_err());
    for key in [
        "Environment",
        "Environment\\",
        "Environment\\\\",
        "Software\\Credentials",
        "Software\\Classes\\Unrelated",
    ] {
        invalid = base.clone();
        invalid.address = SystemAddress::RegistryValue {
            key: key.into(),
            value_name: "Path".into(),
            view: RegistryView::Native,
        };
        let fake = Fake::from_owners(&[invalid.clone()]);
        let plan = full(&[invalid.clone()], &fake);
        assert_eq!(plan.entries[0].operation, Operation::Keep);
        assert_eq!(*fake.reads.borrow(), 0);
        assert!(!apply_all(&plan, &[invalid], &fake).complete);
        assert!(fake.writes.borrow().is_empty());
    }
}

#[test]
fn approved_launch_namespace_accepts_only_fixed_noncredential_values() {
    let mut receipt = registry("command", "DisplayName", None, "Name");
    receipt.address = SystemAddress::RegistryValue {
        key: format!("Software\\Classes\\AgentResourceManager.{INTEGRATION}\\shell\\open\\command"),
        value_name: String::new(),
        view: RegistryView::View64,
    };
    receipt.installed = text("\"D:\\Tools\\app.exe\" \"%1\"");
    assert!(validate_receipt(&receipt).is_ok());
    let SystemAddress::RegistryValue { value_name, .. } = &mut receipt.address else {
        unreachable!()
    };
    *value_name = "AccessToken".into();
    assert!(validate_receipt(&receipt).is_err());
}

#[test]
fn stale_values_ownership_shared_relations_or_invalid_preview_stop_before_any_write() {
    let owners = vec![
        registry("name", "DisplayName", None, "Name"),
        registry("version", "DisplayVersion", None, "1"),
    ];
    let fake = Fake::from_owners(&owners);
    let plan = full(&owners, &fake);
    fake.put(&owners[1].address, text("2"));
    assert!(apply(&plan, &owners, &BTreeSet::new(), &fake, |_| Ok(())).is_err());
    assert!(fake.writes.borrow().is_empty());
    fake.put(&owners[1].address, owners[1].installed.clone());
    let mut changed = owners.clone();
    changed[0].origin = Origin::ExplicitTakeover;
    assert!(apply(&plan, &changed, &BTreeSet::new(), &fake, |_| Ok(())).is_err());
    assert!(apply(
        &plan,
        &owners,
        &BTreeSet::from(["new shared relation".into()]),
        &fake,
        |_| Ok(())
    )
    .is_err());
    let mut invalid = plan.clone();
    invalid.entries[1].desired = None;
    assert!(apply(&invalid, &owners, &BTreeSet::new(), &fake, |_| Ok(())).is_err());
    assert!(fake.writes.borrow().is_empty());
}

#[test]
fn unavailable_items_are_retained_and_absent_values_are_not_replayed() {
    let owners = vec![
        registry("name", "DisplayName", None, "Name"),
        registry("version", "DisplayVersion", None, "1"),
    ];
    let fake = Fake::from_owners(&owners);
    fake.unreadable
        .borrow_mut()
        .insert(location(&owners[0].address));
    fake.put(&owners[1].address, owners[1].before.clone());
    let plan = full(&owners, &fake);
    assert_eq!(plan.entries[0].operation, Operation::Keep);
    assert_eq!(plan.entries[1].operation, Operation::AlreadyAbsent);
    let result = apply_all(&plan, &owners, &fake);
    assert!(!result.complete);
    assert_eq!(result.entries[1].status, "alreadyAbsent");
    assert!(fake.writes.borrow().is_empty());
}

#[test]
fn path_removal_preserves_new_segments_empty_segments_unicode_and_type() {
    let mut receipt = path_owner(
        "path",
        "D:\\My Tool\\bin",
        Some("C:\\Base;"),
        "C:\\Base;;D:\\My Tool\\bin",
    );
    receipt.before = SystemValue::Registry {
        value: Some(path_data("C:\\Base;", 2)),
    };
    receipt.installed = SystemValue::Registry {
        value: Some(path_data("C:\\Base;;D:\\My Tool\\bin", 2)),
    };
    let owners = vec![receipt];
    let fake = Fake::from_owners(&owners);
    fake.put(
        &owners[0].address,
        SystemValue::Registry {
            value: Some(path_data("C:\\Base;;D:\\My Tool\\bin;E:\\用户新增;", 2)),
        },
    );
    let result = apply_all(&full(&owners, &fake), &owners, &fake);
    assert!(result.complete);
    assert_eq!(
        fake.read(&owners[0].address).unwrap(),
        SystemValue::Registry {
            value: Some(path_data("C:\\Base;;E:\\用户新增;", 2))
        }
    );
}

#[test]
fn several_owned_path_tokens_are_removed_without_reverting_each_other_or_user_additions() {
    let owners = vec![
        path_owner("first", "D:\\One", Some("C:\\Base"), "C:\\Base;D:\\One"),
        path_owner(
            "second",
            "D:\\Two",
            Some("C:\\Base;D:\\One"),
            "C:\\Base;D:\\One;D:\\Two",
        ),
    ];
    let fake = Fake::from_owners(&owners);
    fake.put(&owners[0].address, text("C:\\Base;D:\\One;D:\\Two;E:\\New"));
    let result = apply_all(&full(&owners, &fake), &owners, &fake);
    assert!(result.complete);
    assert_eq!(
        fake.read(&owners[0].address).unwrap(),
        text("C:\\Base;E:\\New")
    );
    assert_eq!(fake.writes.borrow().len(), 2);
}

#[test]
fn ambiguous_changed_type_or_invalid_path_receipts_never_write() {
    let receipt = path_owner("path", "D:\\Mine", Some("C:\\Base"), "C:\\Base;D:\\Mine");
    let owners = vec![receipt.clone()];
    let fake = Fake::from_owners(&owners);
    for current in [
        text("C:\\Base;D:\\Mine;D:\\Mine"),
        SystemValue::Registry {
            value: Some(path_data("C:\\Base;D:\\Mine", 2)),
        },
    ] {
        fake.put(&receipt.address, current);
        let plan = full(&owners, &fake);
        assert_eq!(plan.entries[0].operation, Operation::Keep);
        assert!(!apply_all(&plan, &owners, &fake).complete);
    }
    let mut invalid = receipt.clone();
    invalid.installed = text("C:\\Other;D:\\Mine");
    assert!(validate_receipt(&invalid).is_err());
    invalid = receipt;
    invalid.installed = text("C:\\Base;D:\\Mine;D:\\Mine");
    assert!(validate_receipt(&invalid).is_err());
    assert!(fake.writes.borrow().is_empty());
}

#[test]
fn missing_path_token_is_done_and_single_new_value_can_be_removed() {
    let owners = vec![path_owner("path", "D:\\Mine", None, "D:\\Mine")];
    let fake = Fake::from_owners(&owners);
    let result = apply_all(&full(&owners, &fake), &owners, &fake);
    assert!(result.complete);
    assert_eq!(
        fake.read(&owners[0].address).unwrap(),
        SystemValue::Registry { value: None }
    );
    let count = fake.writes.borrow().len();
    fake.put(&owners[0].address, text("E:\\Unrelated"));
    let result = apply_all(&full(&owners, &fake), &owners, &fake);
    assert!(result.complete);
    assert_eq!(result.entries[0].status, "alreadyAbsent");
    assert_eq!(fake.writes.borrow().len(), count);
    assert_eq!(
        fake.read(&owners[0].address).unwrap(),
        text("E:\\Unrelated")
    );
}

#[test]
fn partial_results_persist_each_item_and_fresh_preview_does_not_replay_successes() {
    let owners = vec![
        registry("name", "DisplayName", None, "Name"),
        registry("version", "DisplayVersion", None, "1"),
        registry("publisher", "Publisher", None, "Publisher"),
    ];
    let fake = Fake::from_owners(&owners);
    fake.fail.borrow_mut().insert(location(&owners[1].address));
    let mut journals = vec![];
    let result = apply(
        &full(&owners, &fake),
        &owners,
        &BTreeSet::new(),
        &fake,
        |entries| {
            journals.push(entries.to_vec());
            Ok(())
        },
    )
    .unwrap();
    assert!(!result.complete);
    assert_eq!(
        result
            .entries
            .iter()
            .map(|entry| entry.status.as_str())
            .collect::<Vec<_>>(),
        ["deleted", "failed", "deleted"]
    );
    assert_eq!(journals.iter().map(Vec::len).collect::<Vec<_>>(), [1, 2, 3]);
    fake.fail.borrow_mut().clear();
    fake.writes.borrow_mut().clear();
    let second = full(&owners, &fake);
    assert_eq!(
        second
            .entries
            .iter()
            .map(|entry| &entry.operation)
            .collect::<Vec<_>>(),
        [
            &Operation::AlreadyAbsent,
            &Operation::Remove,
            &Operation::AlreadyAbsent
        ]
    );
    assert!(apply_all(&second, &owners, &fake).complete);
    assert_eq!(fake.writes.borrow().len(), 1);
}

#[test]
fn failed_result_persistence_stops_before_next_system_write() {
    let owners = vec![
        registry("name", "DisplayName", None, "Name"),
        registry("version", "DisplayVersion", None, "1"),
    ];
    let fake = Fake::from_owners(&owners);
    let result = apply(
        &full(&owners, &fake),
        &owners,
        &BTreeSet::new(),
        &fake,
        |_| Err("synthetic journal unavailable".into()),
    )
    .unwrap();
    assert!(!result.complete);
    assert_eq!(result.entries.len(), 1);
    assert!(result.persistence_error.is_some());
    assert_eq!(fake.writes.borrow().len(), 1);
    assert_eq!(fake.read(&owners[1].address).unwrap(), owners[1].installed);
}

fn absolute(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("work")
        .join(name)
}

fn fake_file(id: &str) -> SystemValue {
    SystemValue::File {
        fingerprint: Fingerprint {
            bytes: 1,
            sha256: "a".repeat(64),
            modified: "1".into(),
        },
        file_id: id.into(),
    }
}

#[test]
fn shortcut_replacement_identity_and_changed_link_target_are_preserved() {
    let shortcut = owner(
        "shortcut",
        SystemAddress::Shortcut {
            path: absolute("entry.lnk"),
            target: absolute("app.exe"),
        },
        SystemValue::Absent,
        fake_file("original-id"),
    );
    let target = absolute("canonical-tool");
    let link = owner(
        "link",
        SystemAddress::DirectoryLink {
            path: absolute("tool-link"),
            target: target.clone(),
        },
        SystemValue::Absent,
        SystemValue::Link {
            file_id: "link-id".into(),
            raw_target: target.clone(),
            resolved_target: target,
        },
    );
    let owners = vec![shortcut, link];
    let fake = Fake::from_owners(&owners);
    fake.put(&owners[0].address, fake_file("replacement-id"));
    fake.put(
        &owners[1].address,
        SystemValue::Link {
            file_id: "link-id".into(),
            raw_target: absolute("other"),
            resolved_target: absolute("other"),
        },
    );
    let plan = full(&owners, &fake);
    assert!(plan
        .entries
        .iter()
        .all(|entry| entry.operation == Operation::Keep));
    assert!(!apply_all(&plan, &owners, &fake).complete);
    assert!(fake.writes.borrow().is_empty());
}

#[test]
fn native_shortcut_removes_only_unchanged_owned_ordinary_fixture_file() {
    struct Fixture {
        root: PathBuf,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            for name in ["test.lnk", "neighbor.txt"] {
                let _ = fs::remove_file(self.root.join(name));
            }
            let _ = fs::remove_dir(&self.root);
        }
    }
    let fixture = Fixture {
        root: absolute(&format!("system-ownership-{}", uuid::Uuid::new_v4())),
    };
    fs::create_dir_all(&fixture.root).unwrap();
    let path = fixture.root.join("test.lnk");
    let neighbor = fixture.root.join("neighbor.txt");
    fs::write(&path, b"synthetic ordinary shortcut bytes").unwrap();
    fs::write(&neighbor, b"retain").unwrap();
    let address = SystemAddress::Shortcut {
        path: path.clone(),
        target: fixture.root.join("app.exe"),
    };
    let native = NativeSystemAccess;
    let receipt = owner(
        "shortcut",
        address.clone(),
        SystemValue::Absent,
        native.read(&address).unwrap(),
    );
    let owners = vec![receipt];
    let plan = preview(
        &owners,
        &RemovalExtent::Complete,
        &BTreeSet::new(),
        &BTreeSet::new(),
        &native,
    )
    .unwrap();
    let result = apply(&plan, &owners, &BTreeSet::new(), &native, |_| Ok(())).unwrap();
    assert!(result.complete);
    assert!(!path.exists());
    assert_eq!(fs::read(neighbor).unwrap(), b"retain");
}

#[test]
fn public_preview_omits_registry_payloads_and_address_fields_are_camel_case() {
    let owners = vec![registry(
        "name",
        "DisplayName",
        Some("OriginalPrivateMetadata"),
        "InstalledPrivateMetadata",
    )];
    let fake = Fake::from_owners(&owners);
    let output = full(&owners, &fake).public_entries().to_string();
    for excluded in [
        "bytes",
        "before",
        "installed",
        "OriginalPrivateMetadata",
        "InstalledPrivateMetadata",
        "receiptId",
    ] {
        assert!(!output.contains(excluded), "{excluded}");
    }
    assert!(output.contains("valueName"));
    assert!(!output.contains("value_name"));
}

#[test]
fn duplicate_physical_native_view_or_case_insensitive_path_receipts_are_rejected() {
    let first = registry("one", "DisplayName", None, "Name");
    let mut duplicate = first.clone();
    duplicate.id = "two".into();
    let SystemAddress::RegistryValue { view, .. } = &mut duplicate.address else {
        unreachable!()
    };
    *view = RegistryView::Native;
    let mut explicit = first;
    let SystemAddress::RegistryValue { view, .. } = &mut explicit.address else {
        unreachable!()
    };
    *view = physical_view(RegistryView::Native);
    let owners = vec![explicit, duplicate];
    let fake = Fake::from_owners(&owners);
    assert!(preview(
        &owners,
        &RemovalExtent::Complete,
        &BTreeSet::new(),
        &BTreeSet::new(),
        &fake
    )
    .is_err());
    let owners = vec![
        path_owner("one", "D:\\Mine", None, "D:\\Mine"),
        path_owner("two", "d:\\mine", None, "d:\\mine"),
    ];
    assert!(preview(
        &owners,
        &RemovalExtent::Complete,
        &BTreeSet::new(),
        &BTreeSet::new(),
        &fake
    )
    .is_err());
}
