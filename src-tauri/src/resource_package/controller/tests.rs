use super::*;

fn session(root: &Path) -> PackageSession {
    let executable = std::env::current_exe().unwrap();
    let runtime = BuilderRuntime::Node(RuntimeBinding::inspect(&executable).unwrap());
    let identity = crate::clients::file_identity(root).unwrap();
    PackageSession {
        id: uuid::Uuid::new_v4().to_string(),
        revision: 1,
        input: PreparationInput {
            recipe: Recipe::EdgeMcpNpmV1,
            version: "0.0.83".into(),
            runtime,
            work: root.to_owned(),
            work_identity: identity.clone(),
            downloads: root.to_owned(),
            downloads_identity: identity,
            destination: root.join("new-runtime"),
            rate: 0,
            wheel: None,
            wheel_download_id: None,
            binding: None,
            automatic: None,
        },
        prepared: None,
        download: None,
        receipt: None,
        materialized_root_identity: None,
        status: "preparing".into(),
        error: None,
        created_at: crate::model::now(),
        updated_at: crate::model::now(),
    }
}

#[test]
fn automatic_correlation_is_private_and_cannot_be_rebound_in_a_saved_session() {
    let root = tempfile::tempdir().unwrap();
    let mut original = session(root.path());
    original.input.automatic = Some(super::super::automation::AutomaticBinding {
        resource_id: "tool".into(),
        grant_revision: 1,
        attempt_id: "attempt-one".into(),
        version: "0.0.83".into(),
        source_key: "source".into(),
        source_check_revision: 2,
        metadata_hash: Some("a".repeat(64)),
        permitted_packages: vec![
            "@playwright/mcp".into(),
            "playwright".into(),
            "playwright-core".into(),
        ],
    });
    assert!(original.summary().get("automatic").is_none());
    let mut next = original.clone();
    next.input.automatic.as_mut().unwrap().attempt_id = "another-attempt".into();
    assert!(validate_transition(&original, &next).is_err());
    next = original.clone();
    next.input.automatic.as_mut().unwrap().metadata_hash = Some("b".repeat(64));
    assert!(validate_transition(&original, &next).is_err());
    assert!(validate_transition(&original, &original).is_ok());
}
#[test]
fn reading_missing_package_table_does_not_initialize_it() {
    let db = Connection::open_in_memory().unwrap();
    assert_eq!(
        store(&db, StoreRequest::List).unwrap(),
        json!({"sessions":[]})
    );
    assert!(
        store(&db, StoreRequest::Get(uuid::Uuid::new_v4().to_string()))
            .unwrap()
            .is_null()
    );
    assert!(!exists(&db).unwrap());
}
#[test]
fn session_cas_persists_evidence_but_never_a_replay_permission() {
    let root = tempfile::tempdir().unwrap();
    let db = Connection::open_in_memory().unwrap();
    let mut value = session(root.path());
    store(
        &db,
        StoreRequest::Save {
            session: Box::new(value.clone()),
            expected_revision: None,
        },
    )
    .unwrap();
    assert!(store(
        &db,
        StoreRequest::Save {
            session: Box::new(value.clone()),
            expected_revision: None
        }
    )
    .is_err());
    value.revision = 2;
    value.status = "prepareFailed".into();
    value.error = Some("synthetic stopped preparation".into());
    store(
        &db,
        StoreRequest::Save {
            session: Box::new(value.clone()),
            expected_revision: Some(1),
        },
    )
    .unwrap();
    let loaded = store(&db, StoreRequest::Get(value.id.clone())).unwrap();
    assert_eq!(loaded["status"], "prepareFailed");
    let summary = &store(&db, StoreRequest::List).unwrap()["sessions"][0];
    assert_eq!(summary["executionVerified"], false);
    assert!(summary.get("input").is_none() && summary.get("prepared").is_none());
    assert!(summary.get("canApply").is_none());
    value.revision = 3;
    value.input.destination = root.path().join("different");
    assert!(store(
        &db,
        StoreRequest::Save {
            session: Box::new(value),
            expected_revision: Some(2)
        }
    )
    .is_err());
}
#[test]
fn public_api_rejects_forged_objects_and_basic_mode_writes() {
    let root = tempfile::tempdir().unwrap();
    let mut manager = Manager::new(root.path().join("manager")).unwrap();
    let request = json!({"action":"apply_resource_package_materialize","previewId":uuid::Uuid::new_v4().to_string(),"prepared":{"complete":true}});
    assert!(apply_local(&mut manager, &request)
        .unwrap_err()
        .contains("未批准"));
    assert!(handle(
        &mut manager,
        &json!({"action":"resource_package_sessions","prepared":{"complete":true}})
    )
    .is_err());
    assert!(handle(
        &mut manager,
        &json!({"action":"apply_resource_package_prepare","previewId":"unused"})
    )
    .unwrap_err()
    .contains("本机界面"));
    assert!(materialized(&manager, &uuid::Uuid::new_v4().to_string()).is_err());
    manager.basic_mode = true;
    assert!(handle(
        &mut manager,
        &json!({"action":"preview_resource_package_prepare"})
    )
    .unwrap_err()
    .contains("基本模式"));
    assert!(apply_local(
        &mut manager,
        &json!({"action":"apply_resource_package_prepare","previewId":"unused"})
    )
    .unwrap_err()
    .contains("基本模式"));
}
#[test]
fn volatile_preview_is_typed_expiring_and_single_use() {
    let root = tempfile::tempdir().unwrap();
    let mut manager = Manager::new(root.path().join("manager")).unwrap();
    let preview = remember(
        &mut manager,
        "resourcePackagePrepare",
        json!({"targetPath":root.path().join("runtime")}),
        json!({"not":"PreparationInput"}),
    )
    .unwrap();
    let request = json!({"action":"apply_resource_package_prepare","previewId":preview["id"]});
    assert!(apply_local(&mut manager, &request).is_err());
    assert!(!manager
        .previews
        .contains_key(preview["id"].as_str().unwrap()));
    assert!(apply_local(&mut manager, &request).is_err());
    let preview = remember(
        &mut manager,
        "resourcePackageDownload",
        json!({}),
        Value::Null,
    )
    .unwrap();
    manager
        .previews
        .get_mut(preview["id"].as_str().unwrap())
        .unwrap()["createdAt"] = json!(0);
    assert!(apply_local(
        &mut manager,
        &json!({"action":"apply_resource_package_download","previewId":preview["id"]})
    )
    .is_err());
}
