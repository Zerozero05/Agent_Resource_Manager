use super::*;
use crate::{
    resource_files::OwnedFile,
    resource_source::{AssetMapping, SourceBinding},
};
use chrono::Timelike;

pub(super) fn fixture() -> (tempfile::TempDir, Manager, ResourceRecord, PathBuf, PathBuf) {
    let parent = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("work/resource-automation-tests");
    fs::create_dir_all(&parent).unwrap();
    let dir = tempfile::tempdir_in(parent).unwrap();
    let m = Manager::new(dir.path().join("manager")).unwrap();
    let root = dir.path().join("runtime-v1");
    let candidate = dir.path().join("versions");
    let downloads = dir.path().join("downloads");
    for path in [&root, &candidate, &downloads] {
        fs::create_dir(path).unwrap();
    }
    let files = [
        ("tool.exe", "synthetic runtime", FileRole::Runtime),
        ("LICENSE", "synthetic license", FileRole::License),
    ]
    .into_iter()
    .map(|(path, content, role)| {
        fs::write(root.join(path), content).unwrap();
        OwnedFile {
            path: path.into(),
            role,
            installed_sha256: resource_files::fingerprint(&root.join(path))
                .unwrap()
                .sha256,
        }
    })
    .collect::<Vec<_>>();
    let repository = "https://github.com/synthetic/tool".to_owned();
    let installation=serde_json::from_value(json!({"schemaVersion":1,"installedAt":now(),"archivePath":dir.path().join("v1.zip"),"archiveSha256":"a".repeat(64),"sourceRepository":repository,"sourceVersion":"v1","downloadSource":{"repository":repository,"version":"v1","verification":"githubAsset","author":"synthetic","releaseId":22,"assetId":33,"assetName":"windows.zip","downloadUrl":format!("{repository}/releases/download/v1/windows.zip"),"sha256":"a".repeat(64),"expectedSha256":null},"files":files,"systemEntries":[],"status":"installed","error":null})).unwrap();
    let record = ResourceRecord {
        id: "synthetic".into(),
        name: "Original name".into(),
        kind: "cli".into(),
        root_path: root.to_string_lossy().into_owned(),
        repository: Some(repository.clone()),
        version: Some("v1".into()),
        source_binding: Some(SourceBinding {
            repository: repository.clone(),
            repository_id: 11,
            asset: Some(AssetMapping {
                release_id: 22,
                asset_id: 33,
                tag: "v1".into(),
                asset_name: "windows.zip".into(),
                size: 10,
                digest: None,
                url: format!("{repository}/releases/download/v1/windows.zip"),
                updated_at: now(),
            }),
            verified_at: now(),
        }),
        source_history: vec![],
        alias: "Personal alias".into(),
        notes: "Personal notes".into(),
        enabled: true,
        ownership: "managedFiles".into(),
        management_scope: "ownedFiles".into(),
        actions: vec![],
        capabilities: vec![json!({"id":"execution","status":"unverified"})],
        update_policy: json!({"mode":"manual","intervalHours":24,"pinnedVersion":null,"skippedVersions":[]}),
        installation: Some(installation),
        revision: 1,
        created_at: now(),
        updated_at: now(),
    };
    m.resource_store(Catalog::Insert(Box::new(record.clone())))
        .unwrap();
    (dir, m, record, candidate, downloads)
}
pub(super) fn request(record: &ResourceRecord, parent: &Path, downloads: &Path) -> Value {
    json!({"action":"preview_resource_automation","resourceId":record.id,"expectedRevision":record.revision,"enabled":true,"candidateParentPath":parent,"downloadDirectory":downloads,"channel":"stable","assetName":"windows.zip","selectedFiles":["tool.exe","LICENSE"],"fileRoles":{"tool.exe":"runtime","LICENSE":"license"}})
}
pub(super) fn preview(m: &mut Manager, request: &Value) -> Result<Value, String> {
    preview_with(m, request, |_| Ok(()))
}
pub(super) fn apply(m: &mut Manager, plan: &Value) -> Result<Value, String> {
    apply_with(
        m,
        &json!({"action":"apply_resource_automation","previewId":plan["id"]}),
        |_| Ok(()),
    )
}
fn candidate() -> CandidateScope {
    CandidateScope {
        repository: "https://github.com/synthetic/tool".into(),
        repository_id: 11,
        version: "v2".into(),
        channel: "stable".into(),
        asset_name: "windows.zip".into(),
        files: BTreeMap::from([
            ("LICENSE".into(), FileRole::License),
            ("tool.exe".into(), FileRole::Runtime),
        ]),
    }
}
fn authorize_test(
    m: &Manager,
    candidate: &CandidateScope,
    phase: Phase,
) -> Result<AutomationGrant, String> {
    authorize_with(m, "synthetic", candidate, phase, |_| Ok(()))
}
fn replace(m: &Manager, mut value: ResourceRecord) -> ResourceRecord {
    let expected = value.revision;
    value.revision += 1;
    value.updated_at = now();
    m.resource_store(Catalog::Replace {
        record: Box::new(value.clone()),
        expected_revision: expected,
    })
    .unwrap();
    value
}

#[test]
fn explicit_preview_then_single_native_apply_atomically_saves_grant_and_mode_without_running_or_modifying_installation(
) {
    let (_dir, mut m, original, parent, downloads) = fixture();
    let before = serde_json::to_value(&original.installation).unwrap();
    let plan = preview(&mut m, &request(&original, &parent, &downloads)).unwrap();
    assert!(grant(&m, "synthetic").unwrap().is_none());
    assert_eq!(
        read(&m, "synthetic").unwrap().update_policy["mode"],
        "manual"
    );
    let selected_parent = Path::new(plan["scope"]["candidateParentPath"].as_str().unwrap());
    let selected_download = Path::new(plan["scope"]["downloadDirectory"].as_str().unwrap());
    assert_eq!(path_key(selected_parent), path_key(&parent));
    assert_eq!(path_key(selected_download), path_key(&downloads));
    assert_eq!(
        crate::clients::file_identity(selected_parent).unwrap(),
        crate::clients::file_identity(&parent).unwrap()
    );
    assert_eq!(
        crate::clients::file_identity(selected_download).unwrap(),
        crate::clients::file_identity(&downloads).unwrap()
    );
    assert_eq!(
        plan["scope"]["files"],
        json!({"LICENSE":"license","tool.exe":"runtime"})
    );
    let result = apply(&mut m, &plan).unwrap();
    assert_eq!(result["resource"]["updatePolicy"]["mode"], "automatic");
    assert_eq!(result["authorization"]["enabled"], true);
    assert_eq!(result["automaticApplied"], false);
    assert_eq!(result["resource"]["version"], "v1");
    assert_eq!(result["resource"]["installation"], before);
    assert_eq!(
        result["resource"]["capabilities"],
        json!(original.capabilities)
    );
    assert_eq!(result["resource"]["notes"], original.notes);
    assert!(authorize_test(&m, &candidate(), Phase::BeforeDownload).is_ok());
    assert!(apply(&mut m, &plan).is_err());
    assert_eq!(grant(&m, "synthetic").unwrap().unwrap().revision, 1);
}

#[test]
fn manual_mode_or_imported_policy_never_recreates_an_independent_permission() {
    let (_dir, mut m, original, parent, downloads) = fixture();
    assert!(crate::resources::update_policy(
        &json!({"mode":"automatic","intervalHours":24,"pinnedVersion":null,"skippedVersions":[]})
    )
    .is_err());
    assert!(handle(&m, &request(&original, &parent, &downloads))
        .unwrap()
        .is_none());
    assert!(handle(
        &m,
        &json!({"action":"apply_resource_automation","previewId":"forged","enabled":true})
    )
    .unwrap()
    .is_none());
    assert!(authorize_test(&m, &candidate(), Phase::BeforeDownload).is_err());
    let plan = preview(&mut m, &request(&original, &parent, &downloads)).unwrap();
    apply(&mut m, &plan).unwrap();
    let mut imported = read(&m, "synthetic").unwrap();
    imported.update_policy["mode"] = json!("manual");
    replace(&m, imported);
    assert!(grant(&m, "synthetic").unwrap().unwrap().enabled);
    assert!(authorize_test(&m, &candidate(), Phase::BeforeDownload)
        .unwrap_err()
        .contains("手动"));
}

#[test]
fn source_roles_extra_permissions_and_manager_nested_candidate_locations_cannot_be_authorized() {
    let (_dir, mut m, original, parent, downloads) = fixture();
    for change in [
        json!({"channel":"beta"}),
        json!({"assetName":"*.zip"}),
        json!({"selectedFiles":["tool.exe"]}),
        json!({"fileRoles":{"tool.exe":"userData","LICENSE":"license"}}),
        json!({"verified":true}),
        json!({"candidateParentPath":m.data_dir}),
    ] {
        let mut value = request(&original, &parent, &downloads);
        for (k, v) in change.as_object().unwrap() {
            value[k] = v.clone();
        }
        assert!(preview(&mut m, &value).is_err(), "{value}");
    }
    assert!(grant(&m, "synthetic").unwrap().is_none());
    assert!(
        preview_with(&mut m, &request(&original, &parent, &downloads), |_| Err(
            "no safe adapter".into()
        ))
        .is_err()
    );
    assert!(preview_local(&mut m, &request(&original, &parent, &downloads)).is_err());
    // Production cannot use the synthetic adapter seam.
}

#[test]
fn changed_physical_file_or_directory_identity_invalidates_the_one_use_confirmation() {
    let (_dir, mut m, original, parent, downloads) = fixture();
    let plan = preview(&mut m, &request(&original, &parent, &downloads)).unwrap();
    fs::write(
        Path::new(&original.root_path).join("tool.exe"),
        b"local changes",
    )
    .unwrap();
    assert!(apply(&mut m, &plan).is_err());
    assert!(grant(&m, "synthetic").unwrap().is_none());
    assert_eq!(
        read(&m, "synthetic").unwrap().update_policy["mode"],
        "manual"
    );
    assert!(apply(&mut m, &plan).is_err());
    let (_dir, mut m, original, parent, downloads) = fixture();
    let plan = preview(&mut m, &request(&original, &parent, &downloads)).unwrap();
    let different = parent.with_file_name("different-object");
    fs::create_dir(&different).unwrap();
    fs::remove_dir(&parent).unwrap();
    fs::rename(&different, &parent).unwrap();
    assert!(apply(&mut m, &plan).is_err());
    assert!(grant(&m, "synthetic").unwrap().is_none());
}

#[test]
fn stale_source_or_catalog_and_sql_failure_preserve_both_policy_and_authorization() {
    let (_dir, mut m, original, parent, downloads) = fixture();
    let plan = preview(&mut m, &request(&original, &parent, &downloads)).unwrap();
    let mut changed = original.clone();
    changed.source_binding.as_mut().unwrap().repository_id = 999;
    replace(&m, changed);
    assert!(apply(&mut m, &plan).is_err());
    assert!(grant(&m, "synthetic").unwrap().is_none());
    let (_dir, mut m, original, parent, downloads) = fixture();
    let plan = preview(&mut m, &request(&original, &parent, &downloads)).unwrap();
    let db = Connection::open(m.data_dir.join("manager.sqlite3")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_automation_catalog BEFORE UPDATE ON resource_catalog BEGIN SELECT RAISE(ABORT,'synthetic denied'); END;").unwrap();
    assert!(apply(&mut m, &plan).is_err());
    assert!(grant(&m, "synthetic").unwrap().is_none());
    assert_eq!(json!(read(&m, "synthetic").unwrap()), json!(original));
}

#[test]
fn every_internal_admission_rechecks_basic_maintenance_manual_disable_pins_skips_and_scope() {
    let (_dir, mut m, mut original, parent, downloads) = fixture();
    original.update_policy["pinnedVersion"] = json!("v3");
    original.update_policy["skippedVersions"] = json!(["v4"]);
    original = replace(&m, original);
    let plan = preview(&mut m, &request(&original, &parent, &downloads)).unwrap();
    apply(&mut m, &plan).unwrap();
    assert!(authorize_test(&m, &candidate(), Phase::BeforeDownload)
        .unwrap_err()
        .contains("锁定"));
    let mut allowed = candidate();
    allowed.version = "v3".into();
    assert!(authorize_test(&m, &allowed, Phase::BeforeDownload).is_ok());
    allowed.version = "v4".into();
    assert!(authorize_test(&m, &allowed, Phase::BeforeDownload).is_err());
    allowed.version = "v3".into();
    m.basic_mode = true;
    assert!(authorize_test(&m, &allowed, Phase::BeforeDownload).is_err());
    m.basic_mode = false;
    m.state.settings["maintenance"] =
        json!({"revision":1,"pausedManually":true,"pauseUntil":null,"window":null});
    assert!(authorize_test(&m, &allowed, Phase::BeforeDownload)
        .unwrap_err()
        .contains("暂停"));
    let minute = chrono::Local::now().hour() * 60 + chrono::Local::now().minute();
    m.state.settings["maintenance"] = json!({"revision":2,"pausedManually":false,"pauseUntil":null,"window":{"startMinute":(minute+5)%1440,"endMinute":(minute+10)%1440}});
    assert!(authorize_test(&m, &allowed, Phase::BeforeDownload)
        .unwrap_err()
        .contains("窗口"));
    m.state.settings["maintenance"] =
        json!({"revision":3,"pausedManually":false,"pauseUntil":null,"window":null});
    let mut scope = allowed;
    scope.files.insert("extra.exe".into(), FileRole::Runtime);
    assert!(authorize_test(&m, &scope, Phase::BeforeDownload).is_err());
    scope = candidate();
    scope.repository_id = 999;
    assert!(authorize_test(&m, &scope, Phase::BeforeDownload).is_err());
    let mut disabled = read(&m, "synthetic").unwrap();
    disabled.enabled = false;
    replace(&m, disabled);
    assert!(authorize_test(&m, &candidate(), Phase::BeforeDownload).is_err());
}

#[test]
fn disable_uses_native_confirmation_even_when_runtime_is_missing_and_maintenance_is_paused() {
    let (_dir, mut m, original, parent, downloads) = fixture();
    let plan = preview(&mut m, &request(&original, &parent, &downloads)).unwrap();
    apply(&mut m, &plan).unwrap();
    fs::remove_file(Path::new(&original.root_path).join("tool.exe")).unwrap();
    m.state.settings["maintenance"] =
        json!({"revision":1,"pausedManually":true,"pauseUntil":null,"window":null});
    let current = read(&m, "synthetic").unwrap();
    let preview=preview(&mut m,&json!({"action":"preview_resource_automation","resourceId":"synthetic","expectedRevision":current.revision,"enabled":false})).unwrap();
    assert!(grant(&m, "synthetic").unwrap().unwrap().enabled);
    let result = apply(&mut m, &preview).unwrap();
    assert_eq!(result["resource"]["updatePolicy"]["mode"], "manual");
    assert_eq!(result["authorization"]["enabled"], false);
    assert_eq!(result["resource"]["version"], "v1");
}

#[test]
fn pending_maintenance_unknown_files_and_changed_relations_never_become_new_permissions() {
    let (_dir, mut m, mut original, parent, downloads) = fixture();
    fs::write(
        Path::new(&original.root_path).join("user-config.env"),
        b"private",
    )
    .unwrap();
    assert!(preview(&mut m, &request(&original, &parent, &downloads)).is_err());
    fs::remove_file(Path::new(&original.root_path).join("user-config.env")).unwrap();
    original.installation.as_mut().unwrap().pending_repair=Some(serde_json::from_value(json!({"previousEnabled":true,"previousStatus":"installed","previousError":null,"knownRevision":1,"ownedFiles":[],"entries":[]})).unwrap());
    original = replace(&m, original);
    assert!(preview(&mut m, &request(&original, &parent, &downloads)).is_err());
    let (_dir, mut m, original, parent, downloads) = fixture();
    let plan = preview(&mut m, &request(&original, &parent, &downloads)).unwrap();
    apply(&mut m, &plan).unwrap();
    m.state
        .skills
        .push(json!({"id":"dependent-skill","name":"dependent","localPath":null}));
    m.relation_store(crate::resource_relations::StoreRequest::Add {
        dependent: crate::resource_relations::Endpoint {
            kind: "skill".into(),
            id: "dependent-skill".into(),
        },
        dependency: crate::resource_relations::Endpoint {
            kind: "tool".into(),
            id: "synthetic".into(),
        },
        expected_revision: 0,
    })
    .unwrap();
    assert!(authorize_test(&m, &candidate(), Phase::BeforeDownload)
        .unwrap_err()
        .contains("关系"));
    assert!(authorize_test(&m, &candidate(), Phase::BeforeCommit).is_err());
}

#[test]
fn basic_mode_cannot_preview_or_apply_grants_and_reads_of_old_database_create_no_table() {
    let (_dir, mut m, original, parent, downloads) = fixture();
    let plan = preview(&mut m, &request(&original, &parent, &downloads)).unwrap();
    m.basic_mode = true;
    assert!(apply(&mut m, &plan).is_err());
    assert!(preview(&mut m, &request(&original, &parent, &downloads)).is_err());
    m.basic_mode = false;
    assert!(grant(&m, "synthetic").unwrap().is_none());
    let db = Connection::open_in_memory().unwrap();
    assert!(store(&db, StoreRequest::Get("x".into()), 0)
        .unwrap()
        .is_null());
    assert_eq!(
        store(&db, StoreRequest::List, 0).unwrap(),
        json!({"authorizations":[]})
    );
    let count: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name='resource_automation_grants'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}
