use super::*;

fn fixture() -> tempfile::TempDir {
    let parent = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("work/resource-manifest-tests");
    fs::create_dir_all(&parent).unwrap();
    tempfile::tempdir_in(parent).unwrap()
}
fn owned(root: &Path, relative: &str, content: &str, role: FileRole) -> OwnedFile {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, content).unwrap();
    OwnedFile {
        path: relative.into(),
        role,
        installed_sha256: resource_files::fingerprint(&path).unwrap().sha256,
    }
}
fn source() -> ManifestSource {
    ManifestSource {
        runtime_package: None,
        repository: Some("https://github.com/synthetic/tool".into()),
        repository_id: Some(11),
        release_id: Some(22),
        asset_id: Some(33),
        asset_name: Some("tool-win.zip".into()),
        archive_sha256: Some("a".repeat(64)),
    }
}
fn prepared(root: &Path, files: &[OwnedFile], complete: bool) -> PreparedManifest {
    prepare(
        root,
        "synthetic-resource",
        "cli",
        Some("v1"),
        Some(source()),
        files,
        complete,
    )
    .unwrap()
}

fn runtime_package_sources() -> [RuntimePackageSource; 3] {
    use crate::resource_package::{ArtifactOrigin, Recipe};
    [
        (
            Recipe::AgentReachWheelV1,
            ArtifactOrigin::GithubRelease {
                source: crate::resource_github::DownloadSource {
                    repository: "https://github.com/synthetic/tool".into(),
                    version: "v1.0.0".into(),
                    verification: "githubAsset".into(),
                    author: "synthetic".into(),
                    release_id: 22,
                    asset_id: 33,
                    asset_name: "tool-1.0.0-py3-none-any.whl".into(),
                    download_url: "https://github.com/synthetic/tool/releases/download/v1.0.0/tool-1.0.0-py3-none-any.whl".into(),
                    sha256: "a".repeat(64),
                    expected_sha256: None,
                },
            },
        ),
        (
            Recipe::EdgeMcpNpmV1,
            ArtifactOrigin::NpmRegistry {
                registry: "https://registry.npmjs.org".into(),
                package: "@playwright/mcp".into(),
                version: "0.0.83".into(),
                repository: "https://github.com/microsoft/playwright-mcp".into(),
                tarball: "https://registry.npmjs.org/@playwright/mcp/-/mcp-0.0.83.tgz".into(),
                integrity: "sha512-Zml4dHVyZQ==".into(),
            },
        ),
        (
            Recipe::AgentReachWheelV1,
            ArtifactOrigin::PyPiWheel {
                package: "synthetic-dependency".into(),
                version: "1.0.0".into(),
                filename: "synthetic_dependency-1.0.0-py3-none-any.whl".into(),
                url: "https://files.pythonhosted.org/packages/synthetic_dependency-1.0.0-py3-none-any.whl".into(),
                sha256: "a".repeat(64),
            },
        ),
    ]
    .map(|(recipe, origin)| RuntimePackageSource {
        recipe,
        version: "1.0.0".into(),
        plan_hash: "b".repeat(64),
        artifacts: vec![RuntimeArtifact {
            origin,
            bytes: 17,
            sha256: "a".repeat(64),
        }],
    })
}

#[test]
fn creates_one_non_sensitive_metadata_file_without_copying_runtime_or_private_materials() {
    let dir = fixture();
    let root = dir.path();
    let runtime = owned(root, "bin/tool.exe", "synthetic runtime", FileRole::Runtime);
    let protected = owned(
        root,
        "private/settings.env",
        "PRIVATE_CANARY_VALUE_NEVER_EXPORT",
        FileRole::Configuration,
    );
    let before_runtime = fs::read(root.join("bin/tool.exe")).unwrap();
    let before_private = fs::read(root.join("private/settings.env")).unwrap();
    let prepared = prepared(root, &[runtime, protected], true);
    let preview = prepared.preview(root);
    assert_eq!(preview["targetPath"], json!(root.join(NAME)));
    assert_eq!(preview["excludedProtectedFiles"], 1);
    let receipt = write_new(root, &prepared).unwrap();
    validate_owned(root, &receipt).unwrap();
    let raw = fs::read_to_string(root.join(NAME)).unwrap();
    assert!(!raw.contains("PRIVATE_CANARY"));
    assert!(!raw.contains("settings.env"));
    assert!(!raw.contains(&root.to_string_lossy().to_string()));
    assert!(!raw.contains("Grant"));
    assert!(!raw.contains("actions"));
    assert_eq!(fs::read(root.join("bin/tool.exe")).unwrap(), before_runtime);
    assert_eq!(
        fs::read(root.join("private/settings.env")).unwrap(),
        before_private
    );
    let names: Vec<_> = fs::read_dir(root)
        .unwrap()
        .map(|v| v.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(names.len(), 3);
    assert!(names.contains(&NAME.into()));
    let (path, stamp) = registered_file(root, &receipt).unwrap();
    assert_eq!(path.file_name().unwrap(), NAME);
    assert_eq!(stamp.sha256, receipt.sha256);
    assert_eq!(stamp.bytes, receipt.bytes);
}

#[test]
fn refuses_any_existing_same_name_object_and_never_assumes_ownership_from_its_name() {
    let dir = fixture();
    let root = dir.path();
    let file = owned(root, "tool.exe", "runtime", FileRole::Runtime);
    let prepared = prepared(root, &[file], true);
    fs::write(root.join(NAME), b"user-owned non-json content").unwrap();
    assert!(write_new(root, &prepared).is_err());
    assert_eq!(
        fs::read(root.join(NAME)).unwrap(),
        b"user-owned non-json content"
    );
    assert!(!is_registered_path(root, NAME, None).unwrap());
    fs::remove_file(root.join(NAME)).unwrap();
    fs::create_dir(root.join(NAME)).unwrap();
    assert!(write_new(root, &prepared).is_err());
    assert!(root.join(NAME).is_dir());
}

#[test]
fn partial_record_lists_only_verified_receipt_files_and_is_not_promoted_to_complete() {
    let dir = fixture();
    let root = dir.path();
    let file = owned(
        root,
        "tool.exe",
        "complete synthetic file",
        FileRole::Runtime,
    );
    fs::write(root.join("unfinished.dll"), b"partial").unwrap();
    let prepared = prepared(root, &[file], false);
    let receipt = write_new(root, &prepared).unwrap();
    validate_owned(root, &receipt).unwrap();
    let recovery = recover(root).unwrap();
    assert_eq!(recovery["recordedComplete"], false);
    assert_eq!(recovery["canRegister"], false);
    assert_eq!(recovery["verifiedFiles"].as_array().unwrap().len(), 1);
    assert_eq!(recovery["unknownFilesRetained"], json!(["unfinished.dll"]));
    let mut missing = prepared.document.files[0].clone();
    missing.path = "not-written.exe".into();
    let entry = OwnedFile {
        path: missing.path,
        role: missing.role,
        installed_sha256: missing.sha256,
    };
    assert!(prepare(
        root,
        "synthetic-resource",
        "cli",
        Some("v1"),
        Some(source()),
        &[entry],
        false
    )
    .is_err());
}

#[test]
fn validates_both_hash_and_object_identity_before_inventory_exclusion() {
    let dir = fixture();
    let root = dir.path();
    let file = owned(root, "tool.exe", "runtime", FileRole::Runtime);
    let receipt = write_new(root, &prepared(root, &[file], true)).unwrap();
    assert!(is_registered_path(root, NAME, Some(&receipt)).unwrap());
    assert!(!is_registered_path(root, "another.json", Some(&receipt)).unwrap());
    let bytes = fs::read(root.join(NAME)).unwrap();
    fs::write(root.join("replacement.json"), &bytes).unwrap();
    fs::remove_file(root.join(NAME)).unwrap();
    fs::rename(root.join("replacement.json"), root.join(NAME)).unwrap();
    assert!(validate_owned(root, &receipt).is_err());
    assert!(is_registered_path(root, NAME, Some(&receipt)).is_err());
    assert!(registered_file(root, &receipt).is_err());
    assert_eq!(fs::read(root.join(NAME)).unwrap(), bytes);
}

#[test]
fn tampered_hash_and_hardlinks_are_rejected_without_modifying_other_objects() {
    let dir = fixture();
    let root = dir.path();
    let file = owned(root, "tool.exe", "runtime", FileRole::Runtime);
    let prepared = prepared(root, &[file], true);
    let receipt = write_new(root, &prepared).unwrap();
    let mut wrong = receipt.clone();
    wrong.sha256 = "f".repeat(64);
    assert!(validate_owned(root, &wrong).is_err());
    assert!(update_owned(root, &wrong, &prepared).is_err());
    fs::hard_link(root.join(NAME), root.join("shared-record.json")).unwrap();
    let before = fs::read(root.join("shared-record.json")).unwrap();
    assert!(validate_owned(root, &receipt).is_err());
    assert!(recover(root).is_err());
    assert!(update_owned(root, &receipt, &prepared).is_err());
    assert_eq!(fs::read(root.join("shared-record.json")).unwrap(), before);
}

#[test]
fn recovery_rechecks_actual_files_preserves_unknowns_and_grants_no_permissions() {
    let dir = fixture();
    let root = dir.path();
    let first = owned(root, "tool.exe", "runtime", FileRole::Runtime);
    let second = owned(
        root,
        "private/library.dll",
        "dependency",
        FileRole::PrivateDependency,
    );
    write_new(root, &prepared(root, &[first, second], true)).unwrap();
    fs::write(root.join("tool.exe"), b"local modification").unwrap();
    fs::remove_file(root.join("private/library.dll")).unwrap();
    fs::write(root.join("personal.txt"), b"unique user file").unwrap();
    let value = recover(root).unwrap();
    assert_eq!(value["modifiedFiles"], json!(["tool.exe"]));
    assert_eq!(value["missingOrUnreadable"], json!(["private/library.dll"]));
    assert_eq!(value["unknownFilesRetained"], json!(["personal.txt"]));
    assert_eq!(value["canRegister"], false);
    assert_eq!(value["ownership"], "external");
    for field in [
        "executionGrant",
        "deleteGrant",
        "automaticUpdateGrant",
        "sourceVerified",
    ] {
        assert_eq!(value[field], false);
    }
    assert_eq!(
        fs::read(root.join("personal.txt")).unwrap(),
        b"unique user file"
    );
    assert_eq!(
        fs::read(root.join("tool.exe")).unwrap(),
        b"local modification"
    );
}

#[test]
fn rejects_traversal_absolute_paths_unknown_permission_fields_and_private_source_urls() {
    let dir = fixture();
    let root = dir.path();
    let file = owned(root, "tool.exe", "runtime", FileRole::Runtime);
    let safe = prepared(root, &[file], true);
    let document = serde_json::to_value(&safe.document).unwrap();
    for unsafe_path in [
        "../outside.txt",
        "D:/private/credentials.txt",
        "/private/token",
        NAME,
    ] {
        let mut value = document.clone();
        value["files"][0]["path"] = json!(unsafe_path);
        assert!(parse(&serde_json::to_vec(&value).unwrap()).is_err());
    }
    for field in ["actions", "deleteGrant", "automaticUpdateGrant", "token"] {
        let mut value = document.clone();
        value[field] = json!(true);
        assert!(parse(&serde_json::to_vec(&value).unwrap()).is_err());
    }
    let mut private_source = source();
    private_source.repository = Some("https://user:secret@github.com/synthetic/tool".into());
    assert!(validate_source(&private_source).is_err());
    let mut absolute_version = safe.document.clone();
    absolute_version.version = Some("D:\\private\\release".into());
    assert!(bytes(&absolute_version).is_err());
    let mut protected = safe.document.clone();
    protected.files[0].role = FileRole::UserData;
    assert!(bytes(&protected).is_err());
}

#[test]
fn recovery_accepts_public_runtime_package_sources_without_granting_permissions() {
    for package in runtime_package_sources() {
        let dir = fixture();
        let root = dir.path();
        let file = owned(root, "tool.exe", "synthetic runtime", FileRole::Runtime);
        let mut document = prepared(root, &[file], true).document;
        document.source.as_mut().unwrap().runtime_package = Some(package);
        let payload = bytes(&document).unwrap();
        assert!(parse(&payload).is_ok());
        fs::write(root.join(NAME), &payload).unwrap();
        let recovered = recover(root).unwrap();
        assert_eq!(recovered["source"], json!(document.source));
        assert_eq!(recovered["canRegister"], true);
        assert_eq!(recovered["ownership"], "external");
        for field in [
            "sourceVerified",
            "executionGrant",
            "deleteGrant",
            "automaticUpdateGrant",
        ] {
            assert_eq!(recovered[field], false, "{field}");
        }
        assert_eq!(fs::read(root.join(NAME)).unwrap(), payload);
    }
    assert!(public_artifact_url("https://github.com:443/synthetic/tool", "github.com").is_ok());
}

#[test]
fn recovery_rejects_private_or_nonofficial_urls_in_each_runtime_package_origin() {
    use crate::resource_package::ArtifactOrigin;
    for package in runtime_package_sources() {
        let fields: &[&str] = match &package.artifacts[0].origin {
            ArtifactOrigin::GithubRelease { .. } => &["/source/repository", "/source/downloadUrl"],
            ArtifactOrigin::NpmRegistry { .. } => &["/registry", "/repository", "/tarball"],
            ArtifactOrigin::PyPiWheel { .. } => &["/url"],
        };
        let dir = fixture();
        let root = dir.path();
        let file = owned(root, "tool.exe", "synthetic runtime", FileRole::Runtime);
        let mut document = prepared(root, &[file], true).document;
        document.source.as_mut().unwrap().runtime_package = Some(package);
        let safe = json!(document);
        for field in fields {
            let pointer = format!("/source/runtimePackage/artifacts/0/origin{field}");
            let original = safe.pointer(&pointer).unwrap().as_str().unwrap();
            let parsed = url::Url::parse(original).unwrap();
            let host = parsed.host_str().unwrap();
            for invalid in [
                original.replacen("https://", "http://", 1),
                original.replacen(host, "untrusted.example", 1),
                original.replacen("https://", "https://fixture:synthetic@", 1),
                format!("{original}?token=SYNTHETIC_NOT_A_CREDENTIAL"),
                format!("{original}#synthetic"),
                original.replacen(host, &format!("{host}:444"), 1),
            ] {
                let mut value = safe.clone();
                *value.pointer_mut(&pointer).unwrap() = json!(invalid);
                let payload = serde_json::to_vec(&value).unwrap();
                assert!(parse(&payload).is_err(), "{pointer}: {invalid}");
                fs::write(root.join(NAME), &payload).unwrap();
                assert!(recover(root).is_err(), "{pointer}: {invalid}");
                assert_eq!(fs::read(root.join(NAME)).unwrap(), payload);
                assert_eq!(
                    fs::read(root.join("tool.exe")).unwrap(),
                    b"synthetic runtime"
                );
            }
        }
    }
}

#[test]
fn changed_runtime_after_prepare_prevents_new_record_write() {
    let dir = fixture();
    let root = dir.path();
    let file = owned(root, "tool.exe", "runtime", FileRole::Runtime);
    let prepared = prepared(root, &[file], true);
    fs::write(root.join("tool.exe"), b"user changes after preview").unwrap();
    assert!(write_new(root, &prepared).is_err());
    assert!(!root.join(NAME).exists());
    assert_eq!(
        fs::read(root.join("tool.exe")).unwrap(),
        b"user changes after preview"
    );
}

#[cfg(windows)]
#[test]
fn owned_cas_update_retains_installation_identity_and_refuses_rewritten_provenance() {
    let dir = fixture();
    let root = dir.path();
    let file = owned(root, "tool.exe", "runtime", FileRole::Runtime);
    let initial = prepared(root, std::slice::from_ref(&file), false);
    let receipt = write_new(root, &initial).unwrap();
    let next = prepared(root, std::slice::from_ref(&file), true);
    let updated = update_owned(root, &receipt, &next).unwrap();
    validate_owned(root, &updated).unwrap();
    let document = parse(&fs::read(root.join(NAME)).unwrap()).unwrap();
    assert_eq!(document.installation_id, initial.document.installation_id);
    assert_eq!(document.created_at, initial.document.created_at);
    assert!(document.complete);
    assert_eq!(receipt.file_id, updated.file_id);
    let mut different = prepared(root, &[file], true);
    different.document.source.as_mut().unwrap().repository_id = Some(999);
    different.payload = bytes(&different.document).unwrap();
    let before = fs::read(root.join(NAME)).unwrap();
    assert!(update_owned(root, &updated, &different).is_err());
    assert_eq!(fs::read(root.join(NAME)).unwrap(), before);
    assert!(update_owned(root, &receipt, &next).is_err());
}

#[cfg(not(windows))]
#[test]
fn unavailable_cas_platform_preserves_existing_record() {
    let dir = fixture();
    let root = dir.path();
    let file = owned(root, "tool.exe", "runtime", FileRole::Runtime);
    let prepared = prepared(root, &[file], true);
    let record = write_new(root, &prepared).unwrap();
    let before = fs::read(root.join(NAME)).unwrap();
    assert!(update_owned(root, &record, &prepared).is_err());
    assert_eq!(fs::read(root.join(NAME)).unwrap(), before);
}

#[cfg(windows)]
#[test]
fn recovery_does_not_follow_junctions_outside_resource_scope() {
    let dir = fixture();
    let root = dir.path().join("resource");
    let outside = dir.path().join("outside");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret.txt"), b"must not be inspected").unwrap();
    let file = owned(&root, "tool.exe", "runtime", FileRole::Runtime);
    write_new(&root, &prepared(&root, &[file], true)).unwrap();
    junction::create(&outside, root.join("external")).unwrap();
    let result = recover(&root).unwrap();
    assert_eq!(result["unknownFilesRetained"], json!(["external"]));
    assert!(!serde_json::to_string(&result)
        .unwrap()
        .contains("must not be inspected"));
}
