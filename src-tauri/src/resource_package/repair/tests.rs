use super::*;
use flate2::{write::GzEncoder, Compression};
use std::io::Write;

pub(crate) struct Fixture {
    _dir: tempfile::TempDir,
    pub root: PathBuf,
    pub provenance: RuntimePackageProvenance,
    pub owned: Vec<OwnedFile>,
}
pub(crate) fn fixture() -> Fixture {
    let parent = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("work/npm-repair-tests");
    fs::create_dir_all(&parent).unwrap();
    let dir = tempfile::tempdir_in(parent).unwrap();
    let root = dir.path().join("runtime");
    fs::create_dir(&root).unwrap();
    let node = dir.path().join("node.exe");
    fs::write(&node, b"inert synthetic identity; never executed").unwrap();
    let dependency = "1.64.0-alpha-1790635538000";
    let mut artifacts = vec![];
    let mut owned = vec![];
    for (name, version, deps) in [
        (
            "@playwright/mcp",
            "0.0.83",
            json!({"playwright":dependency,"playwright-core":dependency}),
        ),
        (
            "playwright",
            dependency,
            json!({"playwright-core":dependency}),
        ),
        ("playwright-core", dependency, json!({})),
    ] {
        let package = json!({"name":name,"version":version,"dependencies":deps,"repository":{"url":npm_repository(name).unwrap()},"license":"Apache-2.0","engines":{"node":">=20"}});
        let mut files = BTreeMap::from([
            (
                "package.json".to_owned(),
                serde_json::to_vec(&package).unwrap(),
            ),
            (
                "LICENSE".into(),
                b"Original inert test licence, no downloaded code.".to_vec(),
            ),
        ]);
        for path in match name {
            "@playwright/mcp" => vec!["cli.js"],
            "playwright" => vec!["index.js"],
            _ => vec![
                "index.js",
                "lib/bootstrap.js",
                "lib/coreBundle.js",
                "lib/utilsBundle.js",
            ],
        } {
            files.insert(
                path.into(),
                format!("// inert synthetic {name}/{path}; never executed\n").into_bytes(),
            );
        }
        let names: Vec<_> = files.keys().map(|p| format!("package/{p}")).collect();
        let records = names
            .iter()
            .zip(files.values())
            .map(|(n, b)| (n.as_str(), b.as_slice(), b'0'))
            .collect();
        let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
        gzip.write_all(&tgz::tests::tar(records)).unwrap();
        let bytes = gzip.finish().unwrap();
        let leaf = name.rsplit('/').next().unwrap();
        let path = dir.path().join(format!("{leaf}-{version}.tgz"));
        fs::write(&path, &bytes).unwrap();
        let mut registry = package;
        registry["dist"] = json!({"tarball":format!("https://registry.npmjs.org/{name}/-/{leaf}-{version}.tgz"),"integrity":format!("sha512-{}",general_purpose::STANDARD.encode(Sha512::digest(&bytes)))});
        let metadata = inspect_npm_metadata(name, version, &registry).unwrap();
        artifacts.push(verify_npm_archive(&path, &metadata).unwrap());
        for (path, bytes) in files {
            let relative = format!("node_modules/{name}/{path}");
            let target = root.join(&relative);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(&target, bytes).unwrap();
            owned.push(OwnedFile {
                path: relative,
                role: if path == "LICENSE" {
                    FileRole::License
                } else if name == "@playwright/mcp" {
                    FileRole::Runtime
                } else {
                    FileRole::PrivateDependency
                },
                installed_sha256: resource_files::fingerprint(&target).unwrap().sha256,
            });
        }
    }
    let provenance = RuntimePackageProvenance {
        schema_version: 1,
        recipe: Recipe::EdgeMcpNpmV1,
        version: "0.0.83".into(),
        plan_hash: sha256(b"original generated fixture only"),
        source_artifacts: artifacts,
        runtime: BuilderRuntime::Node(RuntimeBinding::inspect(&node).unwrap()),
    };
    Fixture {
        _dir: dir,
        root,
        provenance,
        owned,
    }
}
#[test]
fn npm_repair_reads_only_affected_original_packages_and_preserves_local_content() {
    let mut f = fixture();
    let missing = [
        "node_modules/@playwright/mcp/cli.js",
        "node_modules/playwright-core/lib/coreBundle.js",
    ];
    for path in missing {
        fs::remove_file(f.root.join(path)).unwrap();
    }
    let modified = f.root.join("node_modules/playwright/index.js");
    fs::write(&modified, b"unique user modification").unwrap();
    let unknown = f.root.join("unknown-user.txt");
    fs::write(&unknown, b"unique user data").unwrap();
    f.owned.push(OwnedFile {
        path: "config/private.json".into(),
        role: FileRole::Configuration,
        installed_sha256: sha256(b"original private configuration"),
    });
    let unused = f
        .provenance
        .source_artifacts
        .iter()
        .find(|a| npm_origin(a).unwrap().0 == "playwright")
        .unwrap();
    fs::remove_file(&unused.path).unwrap();
    let (source, plan) = NpmRepairSource::prepare(&f.root, &f.owned, &f.provenance, None).unwrap();
    assert_eq!(source.paths().len(), 2);
    let receipt = source.apply(&plan).unwrap();
    assert!(receipt.failures.is_empty());
    assert_eq!(receipt.restored.len(), 2);
    assert!(receipt.temporary_paths.is_empty());
    for path in missing {
        let expected = f.owned.iter().find(|v| v.path == path).unwrap();
        assert_eq!(
            resource_files::fingerprint(&f.root.join(path))
                .unwrap()
                .sha256,
            expected.installed_sha256
        );
    }
    assert_eq!(fs::read(modified).unwrap(), b"unique user modification");
    assert_eq!(fs::read(unknown).unwrap(), b"unique user data");
    assert!(!f.root.join("config/private.json").exists());
}
#[test]
fn target_or_source_drift_and_wrong_ownership_hash_fail_before_new_candidate_files() {
    for changed in ["target", "source", "ownership"] {
        let mut f = fixture();
        let missing = "node_modules/@playwright/mcp/cli.js";
        fs::remove_file(f.root.join(missing)).unwrap();
        if changed == "ownership" {
            f.owned
                .iter_mut()
                .find(|v| v.path == missing)
                .unwrap()
                .installed_sha256 = "0".repeat(64);
            assert!(NpmRepairSource::prepare(&f.root, &f.owned, &f.provenance, None).is_err());
            continue;
        }
        let (source, plan) =
            NpmRepairSource::prepare(&f.root, &f.owned, &f.provenance, None).unwrap();
        if changed == "target" {
            fs::write(f.root.join(missing), b"user race replacement").unwrap();
        } else {
            fs::write(&source.assets[0].binding.path, b"changed original archive").unwrap();
        }
        assert!(source.apply(&plan).is_err());
        assert!(plan
            .entries
            .iter()
            .filter_map(|v| v.temporary_path.as_ref())
            .all(|p| !p.exists()));
        if changed == "target" {
            assert_eq!(
                fs::read(f.root.join(missing)).unwrap(),
                b"user race replacement"
            );
        } else {
            assert!(!f.root.join(missing).exists());
        }
    }
}
#[test]
fn exact_asset_relocation_is_explicit_and_never_accepts_a_new_version() {
    let f = fixture();
    let missing = "node_modules/@playwright/mcp/cli.js";
    fs::remove_file(f.root.join(missing)).unwrap();
    let relocated = f._dir.path().join("relocated-originals");
    fs::create_dir(&relocated).unwrap();
    for artifact in &f.provenance.source_artifacts {
        fs::rename(
            &artifact.path,
            relocated.join(artifact.path.file_name().unwrap()),
        )
        .unwrap();
    }
    assert!(NpmRepairSource::prepare(&f.root, &f.owned, &f.provenance, None).is_err());
    let (source, plan) =
        NpmRepairSource::prepare(&f.root, &f.owned, &f.provenance, Some(&relocated)).unwrap();
    assert!(source.apply(&plan).unwrap().failures.is_empty());
    fs::remove_file(f.root.join(missing)).unwrap();
    fs::write(
        relocated.join("mcp-0.0.83.tgz"),
        b"unrelated version archive",
    )
    .unwrap();
    assert!(NpmRepairSource::prepare(&f.root, &f.owned, &f.provenance, Some(&relocated)).is_err());
}
