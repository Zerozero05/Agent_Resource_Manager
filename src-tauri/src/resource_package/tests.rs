use super::*;
use std::{fs, io::Write};
use zip::{write::SimpleFileOptions, ZipWriter};

#[test]
fn official_metadata_conditionally_revalidates_and_does_not_treat_404_as_cached_success() {
    use std::{
        io::Read,
        net::TcpListener,
        sync::mpsc,
        thread,
        time::{Duration, Instant},
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}/metadata", listener.local_addr().unwrap());
    let _gate = crate::network::test_gate_scope(&url);
    let (stop, stopped) = mpsc::channel();
    let server = thread::spawn(move || {
        let mut requests = vec![];
        let deadline = Instant::now() + Duration::from_secs(10);
        for reply in [
            "HTTP/1.1 200 OK\r\nContent-Length: 19\r\nETag: \"official-v1\"\r\nConnection: close\r\n\r\n{\"version\":\"1.0.0\"}",
            "HTTP/1.1 304 Not Modified\r\nConnection: close\r\n\r\n",
            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            "HTTP/1.1 304 Not Modified\r\nConnection: close\r\n\r\n",
        ] {
            let mut stream=loop {
                if stopped.try_recv().is_ok() || Instant::now()>deadline { return requests; }
                match listener.accept() {
                    Ok((stream,_))=>break stream,
                    Err(error) if error.kind()==std::io::ErrorKind::WouldBlock=>thread::sleep(Duration::from_millis(5)),
                    Err(error)=>panic!("local metadata server failed: {error}"),
                }
            };
            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut header=vec![];
            while !header.ends_with(b"\r\n\r\n") {
                let mut byte=[0u8;1];
                stream.read_exact(&mut byte).unwrap();
                header.push(byte[0]);
                assert!(header.len()<=16*1024);
            }
            requests.push(String::from_utf8(header).unwrap());
            stream.write_all(reply.as_bytes()).unwrap();
        }
        requests
    });
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let read = || json_response_cached(&client, 0, &url, crate::network::CachePolicy::Revalidate);
    let first = read();
    let second = read();
    let missing = read();
    let after_missing = read();
    let _ = stop.send(());
    let requests = server.join().unwrap();
    assert_eq!(first.unwrap(), json!({"version":"1.0.0"}));
    assert_eq!(second.unwrap(), json!({"version":"1.0.0"}));
    assert!(
        missing.is_err(),
        "404 must stay a failed observation, not use old metadata as fresh success"
    );
    assert_eq!(after_missing.unwrap(), json!({"version":"1.0.0"}));
    assert_eq!(requests.len(), 4);
    assert!(!requests[0].to_ascii_lowercase().contains("if-none-match:"));
    for request in &requests[1..] {
        assert!(request
            .to_ascii_lowercase()
            .contains("if-none-match: \"official-v1\"\r\n"));
    }
}

fn wheel(dir: &Path, corrupt: bool, missing_record: bool) -> PathBuf {
    let prefix = "agent_reach-1.6.0.dist-info";
    let mut files = BTreeMap::from([
        ("agent_reach/__init__.py".to_string(), "# inert synthetic package\n".to_string()),
        (format!("{prefix}/METADATA"), "Metadata-Version: 2.4\nName: agent-reach\nVersion: 1.6.0\nRequires-Python: >=3.10\nRequires-Dist: requests>=2.28\nRequires-Dist: pytest>=8; extra == 'dev'\n\nSynthetic fixture.\n".to_string()),
        (format!("{prefix}/WHEEL"), "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n".to_string()),
        (format!("{prefix}/entry_points.txt"), "[console_scripts]\nagent-reach = agent_reach.cli:main\n".to_string()),
        (format!("{prefix}/licenses/LICENSE"), "Synthetic test licence; no third-party code.\n".to_string()),
    ]);
    let mut record = String::new();
    for (path, contents) in &files {
        if missing_record && path == "agent_reach/__init__.py" {
            continue;
        }
        let hash = general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(contents.as_bytes()));
        record.push_str(&format!("{path},sha256={hash},{}\n", contents.len()));
    }
    record.push_str(&format!("{prefix}/RECORD,,\n"));
    files.insert(format!("{prefix}/RECORD"), record);
    if corrupt {
        files.insert(
            "agent_reach/__init__.py".into(),
            "# replaced inert bytes\n".into(),
        );
    }
    let path = dir.join("agent_reach-1.6.0-py3-none-any.whl");
    let mut zip = ZipWriter::new(File::create(&path).unwrap());
    for (path, text) in files {
        zip.start_file(path, SimpleFileOptions::default()).unwrap();
        zip.write_all(text.as_bytes()).unwrap();
    }
    zip.finish().unwrap();
    path
}
#[test]
fn wheel_checks_real_record_bytes_and_preserves_dependencies_without_claiming_them_installed() {
    let dir = tempfile::tempdir().unwrap();
    let file = wheel(dir.path(), false, false);
    let inspected = inspect_wheel(&file).unwrap();
    assert_eq!(inspected.package, "agent-reach");
    assert_eq!(inspected.version, "1.6.0");
    assert!(inspected.record_verified && inspected.pure_python);
    assert_eq!(inspected.requires_python.as_deref(), Some(">=3.10"));
    assert_eq!(inspected.requirements.len(), 2);
    assert_eq!(inspected.licenses.len(), 1);
    assert_eq!(
        inspected.entry_points["agent-reach"],
        "agent_reach.cli:main"
    );
}
#[test]
fn wheel_rejects_replaced_bytes_and_files_missing_from_record() {
    for (corrupt, missing, text) in [(true, false, "不一致"), (false, true, "未列于 RECORD")]
    {
        let dir = tempfile::tempdir().unwrap();
        assert!(inspect_wheel(&wheel(dir.path(), corrupt, missing))
            .unwrap_err()
            .contains(text));
    }
}
#[test]
fn record_csv_supports_quoted_paths_but_rejects_ambiguous_fields() {
    assert_eq!(
        csv_row("\"dir/file,name.py\",sha256=abc,4").unwrap(),
        ["dir/file,name.py", "sha256=abc", "4"]
    );
    assert!(csv_row("\"unclosed,sha256=abc,4").is_err());
    assert!(csv_row("\"closed\"extra,,").is_err());
}
fn npm(name: &str, version: &str, dependencies: Value, minimum: &str, bytes: &[u8]) -> Value {
    let repository = npm_repository(name).unwrap();
    let leaf = name.rsplit('/').next().unwrap();
    json!({"name":name,"version":version,"repository":{"url":format!("git+{repository}.git")},"dependencies":dependencies,"license":"Apache-2.0","engines":{"node":minimum},"dist":{"tarball":format!("https://registry.npmjs.org/{name}/-/{leaf}-{version}.tgz"),"integrity":format!("sha512-{}",general_purpose::STANDARD.encode(Sha512::digest(bytes)))}})
}
fn metadata() -> Vec<NpmPackageMetadata> {
    let version = "1.64.0-alpha-1790635538000";
    [
        (
            "@playwright/mcp",
            "0.0.83",
            json!({"playwright":version,"playwright-core":version}),
            ">=18",
        ),
        (
            "playwright",
            version,
            json!({"playwright-core":version}),
            ">=20",
        ),
        ("playwright-core", version, json!({}), ">=20"),
    ]
    .into_iter()
    .map(|(name, version, dependencies, min)| {
        inspect_npm_metadata(
            name,
            version,
            &npm(name, version, dependencies, min, b"synthetic archive bytes"),
        )
        .unwrap()
    })
    .collect()
}
#[test]
fn npm_closure_is_exact_and_honours_the_stronger_transitive_node_requirement() {
    let closure = npm_closure("0.0.83", metadata()).unwrap();
    assert_eq!(closure.packages.len(), 3);
    assert_eq!(closure.node_major_minimum, 20);
    assert!(!closure.archive_contents_inspected);
    let mut missing = metadata();
    missing.pop();
    assert!(npm_closure("0.0.83", missing).unwrap_err().contains("缺少"));
    let mut duplicate = metadata();
    duplicate.push(duplicate[0].clone());
    assert!(npm_closure("0.0.83", duplicate)
        .unwrap_err()
        .contains("重复"));
}
#[test]
fn npm_metadata_rejects_mutable_sources_unreviewed_dependencies_and_credentials() {
    for change in [
        json!({"dist":{"tarball":"https://user:password@registry.npmjs.org/playwright-core/-/playwright-core-1.0.0.tgz"}}),
        json!({"dependencies":{"unreviewed-package":"1.0.0"}}),
        json!({"dependencies":{"playwright-core":"^1.0.0"}}),
        json!({"peerDependencies":{"extra":"*"}}),
        json!({"engines":{"node":">=999"}}),
        json!({"repository":{"url":"https://github.com/unrelated/tool"}}),
    ] {
        let mut value = npm("playwright-core", "1.0.0", json!({}), ">=20", b"synthetic");
        for (key, replacement) in change.as_object().unwrap() {
            value[key] = replacement.clone();
        }
        assert!(inspect_npm_metadata("playwright-core", "1.0.0", &value).is_err());
    }
}
#[test]
fn npm_integrity_checks_actual_bytes_without_calling_an_archive_runtime_verified() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("synthetic.tgz");
    fs::write(&path, b"synthetic archive bytes").unwrap();
    let metadata = metadata();
    let binding = verify_npm_archive(&path, &metadata[0]).unwrap();
    assert_eq!(binding.file.sha256, sha256(b"synthetic archive bytes"));
    fs::write(&path, b"modified synthetic archive").unwrap();
    assert!(verify_npm_archive(&path, &metadata[0])
        .unwrap_err()
        .contains("integrity"));
}

#[test]
fn durable_package_origins_do_not_become_execution_evidence_or_mutable_sources() {
    let root = tempfile::tempdir().unwrap();
    let node = root.path().join("node.exe");
    fs::write(&node, b"inert synthetic runtime identity").unwrap();
    let mut artifacts = vec![];
    for (i, package) in metadata().iter().enumerate() {
        let archive = root.path().join(format!("inert-{i}.tgz"));
        fs::write(&archive, b"synthetic archive bytes").unwrap();
        artifacts.push(verify_npm_archive(&archive, package).unwrap());
    }
    let provenance = RuntimePackageProvenance {
        schema_version: 1,
        recipe: Recipe::EdgeMcpNpmV1,
        version: "0.0.83".into(),
        plan_hash: sha256(b"synthetic fixed preparation identity"),
        source_artifacts: artifacts,
        runtime: BuilderRuntime::Node(RuntimeBinding::inspect(&node).unwrap()),
    };
    provenance.validate_source().unwrap();
    provenance.recheck_shared_runtime().unwrap();
    assert_eq!(
        provenance.source_repository().unwrap(),
        "https://github.com/microsoft/playwright-mcp"
    );
    let serialized = serde_json::to_value(&provenance).unwrap();
    assert!(serialized.get("executionVerified").is_none() && serialized.get("ownership").is_none());
    let roundtrip: RuntimePackageProvenance = serde_json::from_value(serialized).unwrap();
    roundtrip.validate_source().unwrap();
    let mut different = provenance.clone();
    different.version = "0.0.82".into();
    assert!(different.validate_source().is_err());
    let mut different = provenance.clone();
    different.source_artifacts.pop();
    assert!(different.validate_source().is_err());
    let mut different = provenance.clone();
    if let ArtifactOrigin::NpmRegistry { tarball, .. } = &mut different.source_artifacts[0].origin {
        *tarball = "https://user:secret@registry.npmjs.org/irrelevant.tgz".into();
    }
    assert!(different.validate_source().is_err());
    fs::write(&node, b"changed identity").unwrap();
    assert!(provenance.recheck_shared_runtime().is_err());
}
#[test]
fn final_environment_never_uses_the_manager_or_current_version_directory() {
    let dir = tempfile::tempdir().unwrap();
    let manager = dir.path().join("manager");
    let current = dir.path().join("current");
    fs::create_dir(&manager).unwrap();
    fs::create_dir(&current).unwrap();
    assert!(fresh_final_path(&manager, &current, &manager.join("candidate")).is_err());
    assert!(fresh_final_path(&manager, &current, &current.join("candidate")).is_err());
    assert!(fresh_final_path(&manager, &current, &current).is_err());
    assert_eq!(
        fresh_final_path(&manager, &current, &dir.path().join("next"))
            .unwrap()
            .file_name()
            .unwrap(),
        "next"
    );
}
#[test]
fn fixed_python_builder_uses_the_final_path_without_shell_user_site_or_pip_bootstrap() {
    let dir = tempfile::tempdir().unwrap();
    let python = dir.path().join("python.exe");
    fs::write(
        &python,
        "inert synthetic executable identity; never launched",
    )
    .unwrap();
    let bound = RuntimeBinding::inspect(&python).unwrap();
    let target = dir.path().join("new environment & preserved spaces");
    let spec = python_venv_spec(&bound, &target, dir.path()).unwrap();
    assert_eq!(spec.args[..5], ["-I", "-B", "-m", "venv", "--without-pip"]);
    assert_eq!(spec.args[5], target.to_string_lossy());
    assert_eq!(spec.environment["TEMP"], dir.path().to_string_lossy());
    assert!(spec
        .remove_environment
        .iter()
        .any(|key| key == "PYTHONPATH"));
    fs::write(&python, "replacement").unwrap();
    assert!(python_venv_spec(&bound, &target, dir.path())
        .unwrap_err()
        .contains("已改变"));
}
#[test]
fn npm_preparation_never_grants_installation_or_execution_from_a_static_archive_hash() {
    let dir = tempfile::tempdir().unwrap();
    let manager = dir.path().join("manager");
    let current = dir.path().join("current");
    fs::create_dir(&manager).unwrap();
    fs::create_dir(&current).unwrap();
    let node = dir.path().join("node.exe");
    fs::write(&node, "synthetic runtime identity; never launched").unwrap();
    let closure = npm_closure("0.0.83", metadata()).unwrap();
    let mut paths = BTreeMap::new();
    for (index, package) in closure.packages.iter().enumerate() {
        let path = dir.path().join(format!("package-{index}.tgz"));
        fs::write(&path, b"synthetic archive bytes").unwrap();
        paths.insert(package.package.clone(), path);
    }
    let preview = MaterializationPlan::edge_npm(
        &closure,
        &paths,
        &manager,
        &current,
        &dir.path().join("next"),
        &node,
    )
    .unwrap()
    .preview();
    for key in [
        "canApply",
        "installed",
        "executionVerified",
        "ownershipGranted",
        "archiveContentsInspected",
        "dependencyClosureInstalled",
        "runtimeCompatibilityProbed",
    ] {
        assert_eq!(preview[key], false, "{key}");
    }
    assert_eq!(preview["artifacts"].as_array().unwrap().len(), 3);
}

#[test]
fn a_local_wheel_cannot_create_an_official_source_plan_without_the_actual_download_receipt() {
    let dir = tempfile::tempdir().unwrap();
    let manager_root = dir.path().join("management");
    let manager = Manager::new(manager_root.clone()).unwrap();
    let current = dir.path().join("current");
    fs::create_dir(&current).unwrap();
    let python = dir.path().join("python.exe");
    fs::write(&python, "inert synthetic runtime identity; never launched").unwrap();
    let file = wheel(dir.path(), false, false);
    let error = MaterializationPlan::reach_wheel(
        &manager,
        &file,
        "not-a-download-receipt",
        &manager_root,
        &current,
        &dir.path().join("candidate"),
        &python,
    )
    .unwrap_err();
    assert!(error.contains("回执"));
    assert!(!dir.path().join("candidate").exists());
}

fn report_environment() -> Value {
    json!({"python_full_version":"3.12.14","sys_platform":"win32","platform_machine":"AMD64"})
}
#[test]
fn resolver_report_binds_every_dependency_to_its_real_official_metadata_and_keeps_the_main_github_asset(
) {
    for version in ["3.18", "2026.8.19", "1.0rc1", "1!2.0.post1"] {
        assert!(exact_python_version(version));
    }
    for version in [">=3.18", "3.*", "1/../2", "1 @ https://example.org"] {
        assert!(!exact_python_version(version));
    }
    let dir = tempfile::tempdir().unwrap();
    let file = wheel(dir.path(), false, false);
    let main = inspect_wheel(&file).unwrap();
    let url = "https://files.pythonhosted.org/packages/test/requests-2.34.2-py3-none-any.whl";
    let hash = "a".repeat(64);
    let report = json!({"version":"1","environment":report_environment(),"install":[
        {"metadata":{"name":"agent-reach","version":"1.6.0"},"download_info":{"archive_info":{"hashes":{"sha256":main.inventory.archive.sha256}}}},
        {"metadata":{"name":"requests","version":"2.34.2"},"is_direct":false,"download_info":{"url":url,"archive_info":{"hashes":{"sha256":hash}}}}
    ]});
    let official = json!({"info":{"name":"requests","version":"2.34.2"},"urls":[{"filename":"requests-2.34.2-py3-none-any.whl","url":url,"digests":{"sha256":hash},"packagetype":"bdist_wheel","yanked":false,"size":12345}]});
    let mut queries = vec![];
    let resolved = resolve_report(&report, &main, |name, version| {
        queries.push((name.to_owned(), version.to_owned()));
        Ok(official.clone())
    })
    .unwrap();
    assert_eq!(queries, [("requests".into(), "2.34.2".into())]);
    assert_eq!(resolved.len(), 1);
    assert_eq!(resolved[0].sha256, hash);
    let mut wrong = official.clone();
    wrong["urls"][0]["digests"]["sha256"] = json!("b".repeat(64));
    assert!(resolve_report(&report, &main, |_, _| Ok(wrong.clone())).is_err());
    let mut direct = report.clone();
    direct["install"][1]["is_direct"] = json!(true);
    assert!(resolve_report(&direct, &main, |_, _| panic!(
        "direct sources must stop before an official query"
    ))
    .is_err());
    let mut incompatible = report.clone();
    incompatible["environment"]["python_full_version"] = json!("3.9.1");
    assert!(resolve_report(&incompatible, &main, |_, _| panic!(
        "incompatible runtime must stop before an official query"
    ))
    .is_err());
}

#[cfg(windows)]
fn stub_runtime(root: &Path) -> PipRuntime {
    use std::{process::Command, sync::OnceLock};
    static COMPILED: OnceLock<tempfile::TempDir> = OnceLock::new();
    let compiled = COMPILED.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("package_stub.rs");
        fs::write(&source, r###"
use std::{env,fs,path::PathBuf,process};
fn main(){
 let args:Vec<String>=env::args().skip(1).collect();
 let own=env::current_exe().unwrap(); let base=own.parent().unwrap();
 if args.iter().any(|a|a=="venv"){
  assert!(args.iter().any(|a|a=="--without-pip")); assert!(args.iter().any(|a|a=="-B"));
  let target=PathBuf::from(args.last().unwrap()); fs::create_dir(target.join("Scripts")).unwrap();
  fs::copy(&own,target.join("Scripts/python.exe")).unwrap(); fs::write(target.join("pyvenv.cfg"),"synthetic final-path environment").unwrap(); return;
 }
 assert_eq!(env::var("PIP_CONFIG_FILE").unwrap(),"nul");
 assert!(args.iter().any(|a|a=="-S")); assert!(args.iter().any(|a|a=="--isolated"));
 let position=args.iter().position(|a|a=="--python").unwrap(); let target=PathBuf::from(&args[position+1]); let target=target.parent().unwrap().parent().unwrap();
 if args.iter().any(|a|a=="install"){
  for flag in ["--no-index","--only-binary=:all:","--require-hashes","--no-compile"] {assert!(args.iter().any(|a|a==flag));}
  assert!(!args.iter().any(|a|a=="--no-deps"));
  let lock=&args[args.iter().position(|a|a=="-r").unwrap()+1]; assert!(fs::read_to_string(lock).unwrap().contains("--hash=sha256:"));
  fs::write(target.join("Scripts/agent-reach.exe"),"synthetic inert launcher, not an actual Agent Reach capability").unwrap();
  if base.join("fail-install").exists(){process::exit(7)}
  fs::create_dir_all(target.join("Lib/site-packages/agent_reach")).unwrap(); fs::write(target.join("Lib/site-packages/agent_reach/__init__.py"),"# synthetic installed bytes").unwrap(); return;
 }
 assert!(args.iter().any(|a|a=="check"));
}
"###).unwrap();
        let output = Command::new("rustc").args(["--edition=2021", "--crate-name", "resource_package_stub"]).arg(&source).arg("-o").arg(dir.path().join("python.exe")).output().expect("Use the existing development Rust toolchain; no dependency is installed");
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        dir
    });
    fs::create_dir(root).unwrap();
    fs::copy(compiled.path().join("python.exe"), root.join("python.exe")).unwrap();
    let pip = root.join("Lib/site-packages/pip");
    fs::create_dir_all(pip.join("_internal/cli")).unwrap();
    fs::write(
        pip.join("__main__.py"),
        "# synthetic pip binding, not executed\n",
    )
    .unwrap();
    fs::write(
        pip.join("_internal/cli/main.py"),
        "# synthetic pip CLI binding\n",
    )
    .unwrap();
    fs::write(root.join("LICENSE.txt"), "Synthetic fixture licence\n").unwrap();
    PipRuntime::inspect(&root.join("python.exe")).unwrap()
}
#[cfg(windows)]
fn synthetic_ready(root: &Path, fail: bool) -> ReadyReachPlan {
    let manager = root.join("manager");
    let current = root.join("current");
    let work = root.join("work");
    for path in [&manager, &current, &work] {
        fs::create_dir(path).unwrap();
    }
    fs::write(
        current.join("USER-CONFIG.txt"),
        "unique original configuration",
    )
    .unwrap();
    fs::write(current.join("UNKNOWN.txt"), "unique original unknown file").unwrap();
    let runtime = stub_runtime(&root.join("base-runtime"));
    if fail {
        fs::write(
            root.join("base-runtime/fail-install"),
            "synthetic controlled failure",
        )
        .unwrap();
    }
    let file = wheel(root, false, false);
    let package = inspect_wheel(&file).unwrap();
    let main = ArtifactBinding { path: file, file: package.inventory.archive.clone(), origin: ArtifactOrigin::GithubRelease { source: DownloadSource {
        repository:"https://github.com/synthetic/not-a-native-verification".into(), version:"v1.6.0".into(), verification:"synthetic-unit-fixture-only".into(), author:"synthetic".into(), release_id:1, asset_id:2, asset_name:"synthetic.whl".into(), download_url:"https://github.com/synthetic/not-a-native-verification/releases/download/v1/synthetic.whl".into(), sha256:package.inventory.archive.sha256.clone(), expected_sha256:None,
    } } };
    let resolution = ReachResolution {
        main,
        package,
        runtime,
        dependencies: vec![],
        resolution_hash: "synthetic-resolver-test-only-not-a-native-receipt".into(),
        resolver_work: work.clone(),
    };
    assert_eq!(resolution.preview()["canApply"], false);
    ReadyReachPlan::bind(
        resolution,
        &BTreeMap::new(),
        &manager,
        &current,
        &root.join("candidate-final"),
        &work,
    )
    .unwrap()
}
#[cfg(windows)]
#[test]
fn fixed_builder_executes_its_commands_and_reports_created_files_but_does_not_claim_runtime_capability(
) {
    let dir = tempfile::tempdir().unwrap();
    let plan = synthetic_ready(dir.path(), false);
    assert_eq!(plan.preview()["canApply"], true);
    let mut checkpoints = vec![];
    let receipt = plan
        .materialize_with_checkpoint(|r| {
            checkpoints.push(r.clone());
            Ok(())
        })
        .unwrap();
    assert!(checkpoints.len() >= 4);
    assert!(checkpoints[0].created_paths.is_empty() && !checkpoints[0].complete);
    assert!(checkpoints
        .iter()
        .any(|r| r.created_paths == vec![r.root.clone()] && !r.complete));
    assert!(checkpoints.last().unwrap().complete);
    assert!(receipt.complete, "{:?}", receipt.error);
    assert!(receipt.dependency_check_passed);
    assert!(!receipt.execution_verified);
    assert!(receipt
        .files
        .iter()
        .any(|file| file.path == "Scripts/agent-reach.exe"));
    assert!(receipt
        .files
        .iter()
        .any(|file| file.role == resource_files::FileRole::PrivateDependency));
    assert!(receipt
        .files
        .iter()
        .any(|file| file.role == resource_files::FileRole::License));
    assert_eq!(
        fs::read_to_string(dir.path().join("current/USER-CONFIG.txt")).unwrap(),
        "unique original configuration"
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("current/UNKNOWN.txt")).unwrap(),
        "unique original unknown file"
    );
}
#[cfg(windows)]
#[test]
fn fixed_builder_failure_retains_its_partial_receipt_and_changed_artifacts_stop_before_target_creation(
) {
    let dir = tempfile::tempdir().unwrap();
    let plan = synthetic_ready(dir.path(), true);
    let receipt = plan.materialize().unwrap();
    assert!(!receipt.complete && !receipt.dependency_check_passed && !receipt.execution_verified);
    assert!(receipt.error.as_ref().unwrap().contains("退出码"));
    assert!(receipt
        .files
        .iter()
        .any(|file| file.path == "Scripts/agent-reach.exe"));
    assert_eq!(
        fs::read_to_string(dir.path().join("current/USER-CONFIG.txt")).unwrap(),
        "unique original configuration"
    );
    let changed = tempfile::tempdir().unwrap();
    let plan = synthetic_ready(changed.path(), false);
    fs::write(&plan.artifacts[0].path, "modified archive").unwrap();
    assert!(plan.materialize().unwrap_err().contains("已变化"));
    assert!(!changed.path().join("candidate-final").exists());
}

#[cfg(windows)]
#[test]
fn dependency_resolution_requires_the_original_receipt_before_spawning_or_creating_a_cache() {
    let dir = tempfile::tempdir().unwrap();
    let manager = Manager::new(dir.path().join("manager")).unwrap();
    let runtime = stub_runtime(&dir.path().join("base-runtime"));
    let work = dir.path().join("work");
    fs::create_dir(&work).unwrap();
    let archive = wheel(dir.path(), false, false);
    let error = ReachResolution::resolve(&manager, &archive, "missing-receipt", runtime, &work)
        .unwrap_err();
    assert!(error.contains("回执"));
    assert_eq!(fs::read_dir(&work).unwrap().count(), 0);
}

#[cfg(windows)]
#[test]
fn resolved_reach_downloads_are_consumed_by_the_final_path_builder_without_recreating_source_receipts(
) {
    let dir = tempfile::tempdir().unwrap();
    let plan = synthetic_ready(dir.path(), false);
    let work = dir.path().join("downloads");
    fs::create_dir(&work).unwrap();
    let download = PackageDownloadPlan::reach(&plan.resolution, &work, 0).unwrap();
    let receipt = download.apply().unwrap();
    assert!(receipt.complete);
    let bound = ReadyReachPlan::from_downloads(
        plan.resolution,
        &receipt,
        &dir.path().join("manager"),
        &dir.path().join("current"),
        &dir.path().join("second-final"),
        &dir.path().join("work"),
    )
    .unwrap();
    assert_eq!(bound.preview()["canApply"], true);
    assert!(bound.materialize().unwrap().complete);
}
fn npm_runtime_archives(root: &Path) -> (NpmClosure, BTreeMap<String, PathBuf>) {
    use flate2::{write::GzEncoder, Compression};
    let mut facts = vec![];
    let mut paths = BTreeMap::new();
    for (index, package) in metadata().into_iter().enumerate() {
        let actual = json!({"name":package.package,"version":package.version,"repository":{"url":format!("git+{}.git",package.repository)},"license":package.license,"engines":{"node":package.node_requirement},"dependencies":package.dependencies});
        let json = serde_json::to_vec(&actual).unwrap();
        let mut files = vec![
            ("package/package.json", json.as_slice(), b'0'),
            (
                "package/LICENSE",
                b"Synthetic fixture licence".as_slice(),
                b'0',
            ),
        ];
        match package.package.as_str() {
            "@playwright/mcp" => files.push((
                "package/cli.js",
                b"// synthetic MCP entry, never executed".as_slice(),
                b'0',
            )),
            "playwright" => files.push((
                "package/index.js",
                b"// synthetic playwright".as_slice(),
                b'0',
            )),
            "playwright-core" => {
                for path in [
                    "package/index.js",
                    "package/lib/bootstrap.js",
                    "package/lib/coreBundle.js",
                    "package/lib/utilsBundle.js",
                ] {
                    files.push((path, b"// synthetic core resource".as_slice(), b'0'));
                }
            }
            _ => unreachable!(),
        }
        let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
        gzip.write_all(&tgz::tests::tar(files)).unwrap();
        let bytes = gzip.finish().unwrap();
        let path = root.join(format!("package-{index}.tgz"));
        fs::write(&path, &bytes).unwrap();
        let mut registry = actual;
        registry["dist"] = json!({"tarball":package.tarball,"integrity":format!("sha512-{}",general_purpose::STANDARD.encode(Sha512::digest(&bytes)))});
        let fact = inspect_npm_metadata(&package.package, &package.version, &registry).unwrap();
        paths.insert(fact.package.clone(), path);
        facts.push(fact);
    }
    (npm_closure("0.0.83", facts).unwrap(), paths)
}
#[cfg(windows)]
#[test]
fn actual_tgz_runtime_materialization_keeps_original_configuration_and_records_private_dependencies(
) {
    use std::process::Command;
    assert!(resolve_edge_registry("not a version").is_err());
    let dir = tempfile::tempdir().unwrap();
    let manager = dir.path().join("manager");
    let current = dir.path().join("current");
    let work = dir.path().join("work");
    for path in [&manager, &current, &work] {
        fs::create_dir(path).unwrap();
    }
    fs::write(current.join("config"), "unique existing configuration").unwrap();
    let (closure, paths) = npm_runtime_archives(dir.path());
    // Static inspection plus actual Node's fixed version/architecture check. No
    // JavaScript from any of these synthetic packages is executed.
    let output = Command::new("node")
        .args(["-p", "process.execPath"])
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .output()
        .unwrap();
    assert!(output.status.success());
    let node = PathBuf::from(String::from_utf8(output.stdout).unwrap().trim());
    let plan = ReadyNpmPlan::bind(
        closure,
        &paths,
        &manager,
        &current,
        &dir.path().join("new-node-runtime"),
        &node,
    )
    .unwrap();
    assert_eq!(plan.preview()["canApply"], true);
    let mut checkpoints = vec![];
    let receipt = plan
        .materialize_with_checkpoint(&work, |r| {
            checkpoints.push(r.clone());
            Ok(())
        })
        .unwrap();
    assert!(checkpoints.len() >= 5);
    assert!(checkpoints[0].created_paths.is_empty() && !checkpoints[0].complete);
    assert!(checkpoints
        .iter()
        .any(|r| r.created_paths == vec![r.root.clone()] && !r.complete));
    assert!(checkpoints.last().unwrap().complete);
    assert!(receipt.complete, "{:?}", receipt.error);
    assert!(!receipt.execution_verified);
    assert!(receipt.files.iter().any(|file| file.path
        == "node_modules/playwright-core/lib/coreBundle.js"
        && file.role == resource_files::FileRole::PrivateDependency));
    assert!(receipt
        .files
        .iter()
        .any(|file| file.role == resource_files::FileRole::License));
    assert_eq!(
        fs::read_to_string(current.join("config")).unwrap(),
        "unique existing configuration"
    );
    let (closure, paths) = npm_runtime_archives(dir.path());
    let packages = dir.path().join("npm-downloads");
    fs::create_dir(&packages).unwrap();
    for package in &closure.packages {
        let name = Url::parse(&package.tarball)
            .unwrap()
            .path_segments()
            .unwrap()
            .next_back()
            .unwrap()
            .to_owned();
        fs::copy(&paths[&package.package], packages.join(name)).unwrap();
    }
    let download_plan = PackageDownloadPlan::edge(&closure, &packages, 0).unwrap();
    assert!(download_plan.preview()["downloadBytes"].is_null());
    let downloaded = download_plan.apply().unwrap();
    assert!(downloaded.complete);
    let again = ReadyNpmPlan::from_downloads(
        closure,
        &downloaded,
        &manager,
        &current,
        &dir.path().join("second-node-runtime"),
        &node,
    )
    .unwrap();
    assert!(again.materialize(&work).unwrap().complete);
}
