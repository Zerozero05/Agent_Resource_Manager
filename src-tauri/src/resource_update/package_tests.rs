use super::*;
use crate::resource_package_lifecycle::test_support::package;

fn fixture() -> tempfile::TempDir {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("work/package-update-tests");
    fs::create_dir_all(&root).unwrap();
    tempfile::tempdir_in(root).unwrap()
}
fn setup(root: &Path) -> (Manager, ResourceRecord, PathBuf) {
    let m = Manager::new(root.join("manager")).unwrap();
    let node = root.join("node.exe");
    fs::write(&node, b"synthetic node; no execution").unwrap();
    let result = crate::resource_lifecycle::register_materialized(
        &m,
        "Synthetic MCP",
        package(&root.join("v1"), "0.0.82", &node),
    )
    .unwrap();
    assert_eq!(result["complete"], true);
    let record = serde_json::from_value(result["resource"].clone()).unwrap();
    (m, record, node)
}
fn staged_package(
    m: &Manager,
    record: &ResourceRecord,
    root: &Path,
    node: &Path,
) -> crate::resource_package::controller::MaterializedPackage {
    let mut value = package(root, "0.0.83", node);
    value.binding = Some(crate::resource_package::controller::ResourceBinding {
        record: record.clone(),
        root_identity: crate::clients::file_identity(Path::new(&record.root_path)).unwrap(),
        relations: relations(m, &record.id).unwrap(),
    });
    value
}
#[test]
fn package_candidate_switch_keeps_both_real_provenances_and_all_roles() {
    let temp = fixture();
    let (m, original, node) = setup(temp.path());
    let old_source = json!(original.installation.as_ref().unwrap().runtime_package);
    let old_files = json!(original.installation.as_ref().unwrap().files);
    let prepared = staged_package(&m, &original, &temp.path().join("v2"), &node);
    let new_source = json!(prepared.provenance);
    let new_files = json!(prepared.receipt.files);
    let result = stage_materialized(&m, prepared).unwrap();
    assert_eq!(result["staged"], true);
    assert_eq!(result["switched"], false);
    assert_eq!(result["resource"]["rootPath"], original.root_path);
    let resource: ResourceRecord = serde_json::from_value(result["resource"].clone()).unwrap();
    assert!(candidate(&resource).unwrap().download_source.is_none());
    assert!(candidate(&resource)
        .unwrap()
        .archive_path
        .as_os_str()
        .is_empty());
    let verified = validate_candidate_with(&m, &original.id, "synthetic-package-probe", |target| {
        assert_eq!(target.version, "0.0.83");
        assert_eq!(json!(target.files), new_files);
        Ok(())
    })
    .unwrap();
    let switched = switch_with(
        &m,
        &verified["resource"],
        |_, _| {
            Ok(ProbeEvidence {
                adapter: "synthetic-package-post-probe".into(),
                verified_scopes: vec!["syntheticFixtureOnly".into()],
            })
        },
        |_| panic!("a successful switch must not run a restored-version probe"),
    )
    .unwrap();
    assert_eq!(switched["complete"], true);
    let installed = &switched["resource"]["installation"];
    assert_eq!(installed["runtimePackage"], new_source);
    assert_eq!(installed["files"], new_files);
    assert_eq!(
        installed["updateState"]["previous"][0]["runtimePackage"],
        old_source
    );
    assert_eq!(installed["updateState"]["previous"][0]["files"], old_files);
    assert!(installed["downloadSource"].is_null());
    assert!(temp
        .path()
        .join("v1/node_modules/@playwright/mcp/cli.js")
        .is_file());
}
#[test]
fn stale_resource_and_changed_shared_runtime_cannot_admit_package_candidate() {
    let temp = fixture();
    let (m, original, node) = setup(temp.path());
    let prepared = staged_package(&m, &original, &temp.path().join("v2"), &node);
    let mut edited = original.clone();
    edited.notes = "new user note".into();
    save_record(&m, edited).unwrap();
    assert!(stage_materialized(&m, prepared).is_err());
    assert!(read(&m, &original.id)
        .unwrap()
        .installation
        .unwrap()
        .update_state
        .is_none());
    let latest = read(&m, &original.id).unwrap();
    let prepared = staged_package(&m, &latest, &temp.path().join("v3"), &node);
    fs::write(&node, b"changed node; no execution").unwrap();
    assert!(stage_materialized(&m, prepared).is_err());
}
#[test]
fn failed_package_switch_restores_original_provenance_without_discarding_candidate() {
    let temp = fixture();
    let (m, original, node) = setup(temp.path());
    let old_source = json!(original.installation.as_ref().unwrap().runtime_package);
    let prepared = staged_package(&m, &original, &temp.path().join("v2"), &node);
    stage_materialized(&m, prepared).unwrap();
    let verified =
        validate_candidate_with(&m, &original.id, "synthetic-package-probe", |_| Ok(())).unwrap();
    let result = switch_with(
        &m,
        &verified["resource"],
        |_, _| Err("synthetic post-switch rejection".into()),
        |restored| {
            assert_eq!(restored.root_path, original.root_path);
            assert_eq!(
                json!(restored.installation.as_ref().unwrap().runtime_package),
                old_source
            );
            assert!(Path::new(&restored.root_path)
                .join("node_modules/@playwright/mcp/cli.js")
                .is_file());
            Ok(ProbeEvidence {
                adapter: "synthetic-package-restored-probe".into(),
                verified_scopes: vec!["syntheticRestoredFixtureRead".into()],
            })
        },
    )
    .unwrap();
    assert_eq!(result["rolledBack"], true);
    assert_eq!(result["resource"]["rootPath"], original.root_path);
    assert_eq!(
        result["resource"]["installation"]["runtimePackage"],
        old_source
    );
    assert_eq!(
        result["resource"]["installation"]["updateState"]["candidate"]["runtimePackage"]["version"],
        "0.0.83"
    );
}
