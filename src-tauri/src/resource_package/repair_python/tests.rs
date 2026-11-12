use super::*;
use zip::{write::SimpleFileOptions, ZipWriter};

struct Fixture {
    _directory: tempfile::TempDir,
    root: PathBuf,
    provenance: RuntimePackageProvenance,
    owned: Vec<OwnedFile>,
}
fn wheel(
    directory: &Path,
    name: &str,
    version: &str,
    payload: &[(&str, &[u8])],
) -> (PathBuf, BTreeMap<String, Vec<u8>>) {
    let distribution = name.replace('-', "_");
    let prefix = format!("{distribution}-{version}.dist-info");
    let mut files = BTreeMap::from([
        (format!("{prefix}/METADATA"), format!("Metadata-Version: 2.4\nName: {name}\nVersion: {version}\n\nInert generated fixture.\n").into_bytes()),
        (format!("{prefix}/WHEEL"), b"Wheel-Version: 1.0\nRoot-Is-Purelib: false\nTag: cp312-cp312-win_amd64\n".to_vec()),
        (format!("{prefix}/licenses/LICENSE"), b"Generated test license, no downloaded code.\n".to_vec()),
    ]);
    for (path, bytes) in payload {
        files.insert((*path).into(), bytes.to_vec());
    }
    let mut record = String::new();
    for (path, bytes) in &files {
        record.push_str(&format!(
            "{path},sha256={},{}\n",
            general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(bytes)),
            bytes.len()
        ));
    }
    record.push_str(&format!("{prefix}/RECORD,,\n"));
    files.insert(format!("{prefix}/RECORD"), record.into_bytes());
    let path = directory.join(format!(
        "{distribution}-{version}-cp312-cp312-win_amd64.whl"
    ));
    let mut zip = ZipWriter::new(File::create(&path).unwrap());
    for (name, bytes) in &files {
        zip.start_file(name, SimpleFileOptions::default()).unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap();
    (path, files)
}
fn own(root: &Path, owned: &mut Vec<OwnedFile>, path: &str, bytes: &[u8], role: FileRole) {
    let target = root.join(path);
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::write(&target, bytes).unwrap();
    owned.push(OwnedFile {
        path: path.into(),
        role,
        installed_sha256: resource_files::fingerprint(&target).unwrap().sha256,
    });
}
fn fixture() -> Fixture {
    let parent = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("work/python-repair-tests");
    fs::create_dir_all(&parent).unwrap();
    let directory = tempfile::tempdir_in(parent).unwrap();
    let root = directory.path().join("private-runtime");
    fs::create_dir(&root).unwrap();
    let base = directory.path().join("shared-python");
    fs::create_dir_all(base.join("Lib/site-packages/pip/_internal/cli")).unwrap();
    fs::write(
        base.join("python.exe"),
        b"inert synthetic interpreter; never executed",
    )
    .unwrap();
    fs::write(base.join("LICENSE.txt"), b"inert original Python license").unwrap();
    fs::write(
        base.join("Lib/site-packages/pip/__main__.py"),
        b"# inert pip binding",
    )
    .unwrap();
    fs::write(
        base.join("Lib/site-packages/pip/_internal/cli/main.py"),
        b"# inert pip binding",
    )
    .unwrap();
    fs::create_dir_all(base.join("Lib/venv/scripts/nt")).unwrap();
    fs::write(
        base.join("Lib/venv/scripts/nt/python.exe"),
        b"inert exact redirector",
    )
    .unwrap();
    let runtime = PipRuntime::inspect(&base.join("python.exe")).unwrap();
    let mut artifacts = Vec::new();
    let mut owned = Vec::new();
    for (name, version, payload) in [
        (
            "agent-reach",
            "1.6.0",
            vec![
                (
                    "agent_reach/__init__.py",
                    b"# original package\n".as_slice(),
                ),
                ("agent_reach/cli.py", b"# original local code\n".as_slice()),
            ],
        ),
        (
            "binary-dep",
            "1.0.0",
            vec![
                (
                    "binary_dep/module.pyd",
                    b"inert binary payload\0\x01".as_slice(),
                ),
                (
                    "binary_dep-1.0.0.data/platlib/binary_dep/extra.bin",
                    b"inert mapped binary payload".as_slice(),
                ),
            ],
        ),
        (
            "unused-dep",
            "1.0.0",
            vec![(
                "unused_dep/__init__.py",
                b"# unchanged dependency\n".as_slice(),
            )],
        ),
    ] {
        let (path, files) = wheel(directory.path(), name, version, &payload);
        let file = resource_files::fingerprint(&path).unwrap();
        let filename = path.file_name().unwrap().to_string_lossy().into_owned();
        let origin = if name == "agent-reach" {
            ArtifactOrigin::GithubRelease {
                source: DownloadSource {
                    repository: REACH_REPOSITORY.into(),
                    version: "v1.6.0".into(),
                    verification: "githubDigest".into(),
                    author: "inert-generated-fixture".into(),
                    release_id: 1,
                    asset_id: 2,
                    asset_name: filename.clone(),
                    download_url: format!("{REACH_REPOSITORY}/releases/download/v1.6.0/{filename}"),
                    sha256: file.sha256.clone(),
                    expected_sha256: Some(file.sha256.clone()),
                },
            }
        } else {
            ArtifactOrigin::PyPiWheel {
                package: name.into(),
                version: version.into(),
                filename: filename.clone(),
                url: format!("https://files.pythonhosted.org/packages/generated/{filename}"),
                sha256: file.sha256.clone(),
            }
        };
        artifacts.push(ArtifactBinding { path, file, origin });
        for (path, bytes) in files {
            let Some(target) = destination(&path).unwrap() else {
                continue;
            };
            let role = if crate::local::license_path(&path) {
                FileRole::License
            } else {
                FileRole::PrivateDependency
            };
            own(&root, &mut owned, &target, &bytes, role);
        }
    }
    own(
        &root,
        &mut owned,
        "Scripts/python.exe",
        b"inert exact redirector",
        FileRole::PrivateDependency,
    );
    own(
        &root,
        &mut owned,
        "Scripts/agent-reach.exe",
        b"inert generated launcher with original timestamp",
        FileRole::Runtime,
    );
    own(
        &root,
        &mut owned,
        "pyvenv.cfg",
        b"original exact final-path config",
        FileRole::PrivateDependency,
    );
    own(
        &root,
        &mut owned,
        "licenses/Python-LICENSE.txt",
        b"inert original Python license",
        FileRole::License,
    );
    let provenance = RuntimePackageProvenance {
        schema_version: 1,
        recipe: Recipe::AgentReachWheelV1,
        version: "1.6.0".into(),
        plan_hash: sha256(b"inert generated fixed original preparation"),
        source_artifacts: artifacts,
        runtime: BuilderRuntime::PythonPip(runtime),
    };
    Fixture {
        _directory: directory,
        root,
        provenance,
        owned,
    }
}

#[test]
fn python_repair_restores_original_wheel_binary_mapping_license_and_redirector_without_installing()
{
    let mut f = fixture();
    let missing = [
        "Lib/site-packages/agent_reach/__init__.py",
        "Lib/site-packages/binary_dep/module.pyd",
        "Lib/site-packages/binary_dep/extra.bin",
        "Scripts/python.exe",
        "licenses/Python-LICENSE.txt",
    ];
    for path in missing {
        fs::remove_file(f.root.join(path)).unwrap();
    }
    let modified = f.root.join("Lib/site-packages/agent_reach/cli.py");
    fs::write(&modified, b"unique current local modification").unwrap();
    let unknown = f.root.join("private-user-data.json");
    fs::write(&unknown, b"unique current user data").unwrap();
    f.owned.push(OwnedFile {
        path: "config/missing-user.json".into(),
        role: FileRole::Configuration,
        installed_sha256: sha256(b"private configuration"),
    });
    fs::remove_file(&f.provenance.source_artifacts[2].path).unwrap();
    let (source, plan) =
        PythonRepairSource::prepare(&f.root, &f.owned, &f.provenance, None).unwrap();
    assert_eq!(source.assets.len(), 2);
    assert_eq!(
        plan.entries
            .iter()
            .filter(|e| e.decision == "restore")
            .count(),
        missing.len()
    );
    assert_eq!(
        source.public_source().unwrap()["verification"],
        "wheelRecord"
    );
    let receipt = source.apply(&plan).unwrap();
    assert!(receipt.failures.is_empty() && receipt.temporary_paths.is_empty());
    assert_eq!(receipt.restored.len(), missing.len());
    for path in missing {
        assert_eq!(
            resource_files::fingerprint(&f.root.join(path))
                .unwrap()
                .sha256,
            f.owned
                .iter()
                .find(|p| p.path == path)
                .unwrap()
                .installed_sha256
        );
    }
    assert_eq!(
        fs::read(modified).unwrap(),
        b"unique current local modification"
    );
    assert_eq!(fs::read(unknown).unwrap(), b"unique current user data");
    assert!(!f.root.join("config/missing-user.json").exists());
}

#[test]
fn python_repair_names_unreconstructible_generated_entries_and_does_not_start_partial_repair() {
    for generated in [
        "Scripts/agent-reach.exe",
        "pyvenv.cfg",
        "Lib/site-packages/agent_reach-1.6.0.dist-info/RECORD",
    ] {
        let mut f = fixture();
        if generated.ends_with("/RECORD") {
            fs::write(
                f.root.join(generated),
                b"inert original generated installed RECORD",
            )
            .unwrap();
            f.owned
                .iter_mut()
                .find(|p| p.path == generated)
                .unwrap()
                .installed_sha256 = resource_files::fingerprint(&f.root.join(generated))
                .unwrap()
                .sha256;
        }
        let raw = "Lib/site-packages/agent_reach/__init__.py";
        fs::remove_file(f.root.join(raw)).unwrap();
        fs::remove_file(f.root.join(generated)).unwrap();
        let error =
            PythonRepairSource::prepare(&f.root, &f.owned, &f.provenance, None).unwrap_err();
        assert!(error.contains(generated) && error.contains("未写入任何文件"));
        assert!(!f.root.join(raw).exists());
        assert!(!fs::read_dir(&f.root).unwrap().any(|p| p
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".arm-repair-")));
    }
}

#[test]
fn python_repair_reads_exact_original_wheels_from_selected_local_directory_only() {
    let f = fixture();
    let target = "Lib/site-packages/binary_dep/module.pyd";
    fs::remove_file(f.root.join(target)).unwrap();
    let relocated = f.root.parent().unwrap().join("selected-original-assets");
    fs::create_dir(&relocated).unwrap();
    let artifact = &f.provenance.source_artifacts[1];
    let name = artifact.path.file_name().unwrap();
    fs::copy(&artifact.path, relocated.join(name)).unwrap();
    fs::remove_file(&artifact.path).unwrap();
    let (source, plan) =
        PythonRepairSource::prepare(&f.root, &f.owned, &f.provenance, Some(&relocated)).unwrap();
    assert_eq!(
        source.paths(),
        [crate::local::canonical(&relocated.join(name)).unwrap()]
    );
    assert!(source.apply(&plan).unwrap().failures.is_empty());
    fs::remove_file(f.root.join(target)).unwrap();
    fs::write(relocated.join(name), b"another asset or different version").unwrap();
    assert!(
        PythonRepairSource::prepare(&f.root, &f.owned, &f.provenance, Some(&relocated))
            .unwrap_err()
            .contains(target)
    );
}

#[test]
fn python_repair_rejects_asset_runtime_and_owned_hash_drift_before_candidate_writes() {
    for change in ["asset", "runtime", "owned"] {
        let mut f = fixture();
        let path = if change == "runtime" {
            "Scripts/python.exe"
        } else {
            "Lib/site-packages/agent_reach/__init__.py"
        };
        fs::remove_file(f.root.join(path)).unwrap();
        if change == "owned" {
            f.owned
                .iter_mut()
                .find(|p| p.path == path)
                .unwrap()
                .installed_sha256 = "0".repeat(64);
            assert!(PythonRepairSource::prepare(&f.root, &f.owned, &f.provenance, None).is_err());
        } else {
            let (source, plan) =
                PythonRepairSource::prepare(&f.root, &f.owned, &f.provenance, None).unwrap();
            let target = if change == "asset" {
                &f.provenance.source_artifacts[0].path
            } else {
                f.provenance.shared_runtime_binding().path()
            };
            fs::write(target, b"changed original bound file").unwrap();
            assert!(source.apply(&plan).is_err());
        }
        assert!(!f.root.join(path).exists());
        assert!(!fs::read_dir(&f.root).unwrap().any(|p| p
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".arm-repair-")));
    }
}
