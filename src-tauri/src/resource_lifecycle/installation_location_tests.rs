use super::*;
use std::io::Write;

fn fixture() -> tempfile::TempDir {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("work/install-location-tests");
    fs::create_dir_all(&root).unwrap();
    tempfile::tempdir_in(root).unwrap()
}

fn archive(root: &Path) -> PathBuf {
    let path = root.join("synthetic.zip");
    let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    zip.start_file("tool.exe", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(b"synthetic runtime").unwrap();
    zip.finish().unwrap();
    path
}

fn request(archive: &Path, destination: &Path) -> Value {
    json!({"action":"preview_resource_install","archivePath":archive,"destinationPath":destination,"name":"Synthetic location test","kind":"portable","version":"1","selectedFiles":["tool.exe"]})
}

fn register(m: &Manager, path: &Path) -> ResourceRecord {
    fs::create_dir_all(path).unwrap();
    let result=crate::resources::handle(m,&json!({"action":"resource_register","name":"Existing tool","kind":"portable","rootPath":path})).unwrap().unwrap();
    serde_json::from_value(result["resource"].clone()).unwrap()
}

#[test]
fn managed_root_app_development_data_and_cache_are_rejected_before_catalog_or_file_writes() {
    let dir = fixture();
    let managed = dir.path().join("manager");
    let mut m = Manager::new(managed.clone()).unwrap();
    let zip = archive(dir.path());
    for name in ["app", "dev", "data", "cache"] {
        let parent = managed.join(name);
        fs::create_dir_all(&parent).unwrap();
        let destination = parent.join("tool");
        let error = handle(&mut m, &request(&zip, &destination)).unwrap_err();
        assert!(error.contains("独立持久目录"));
        assert!(!destination.exists());
    }
    assert!(m.resource_store(StoreRequest::List).unwrap()["resources"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn external_sibling_installation_succeeds_and_stays_outside_manager_owned_paths() {
    let dir = fixture();
    let mut m = Manager::new(dir.path().join("manager")).unwrap();
    let zip = archive(dir.path());
    let target = dir.path().join("native-tool");
    let plan = handle(&mut m, &request(&zip, &target)).unwrap().unwrap();
    let result = apply_local(
        &mut m,
        &json!({"action":"apply_resource_install","previewId":plan["id"]}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(result["complete"], true);
    assert_eq!(
        path_key(Path::new(result["resource"]["rootPath"].as_str().unwrap())),
        path_key(&target)
    );
    assert_eq!(
        fs::read(target.join("tool.exe")).unwrap(),
        b"synthetic runtime"
    );
    assert!(!dir.path().join("manager/tool.exe").exists());
}

#[test]
fn registered_tool_and_skill_trees_are_protected_without_moving_existing_sources() {
    let dir = fixture();
    let mut m = Manager::new(dir.path().join("manager")).unwrap();
    let zip = archive(dir.path());
    let existing = dir.path().join("existing-tool");
    register(&m, &existing);
    let skill = dir.path().join("canonical-skill");
    fs::create_dir(&skill).unwrap();
    fs::write(skill.join("SKILL.md"), b"canonical skill").unwrap();
    m.state
        .skills
        .push(json!({"id":"existing","name":"Existing skill","localPath":skill}));
    m.save().unwrap();
    for root in [&existing, &skill] {
        let target = root.join("new-runtime");
        assert!(handle(&mut m, &request(&zip, &target))
            .unwrap_err()
            .contains("重叠"));
        assert!(!target.exists());
    }
    assert_eq!(
        fs::read(skill.join("SKILL.md")).unwrap(),
        b"canonical skill"
    );
    assert_eq!(
        m.resource_store(StoreRequest::List).unwrap()["resources"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn newly_registered_owner_after_preview_invalidates_installation_before_first_write() {
    let dir = fixture();
    let mut m = Manager::new(dir.path().join("manager")).unwrap();
    let zip = archive(dir.path());
    let parent = dir.path().join("resources");
    fs::create_dir(&parent).unwrap();
    let target = parent.join("runtime");
    let plan = handle(&mut m, &request(&zip, &target)).unwrap().unwrap();
    register(&m, &parent);
    assert!(apply_local(
        &mut m,
        &json!({"action":"apply_resource_install","previewId":plan["id"]})
    )
    .unwrap_err()
    .contains("重叠"));
    assert!(!target.exists());
    assert!(!m.previews.contains_key(plan["id"].as_str().unwrap()));
    assert_eq!(
        m.resource_store(StoreRequest::List).unwrap()["resources"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn explicit_manager_path_overrides_and_developer_roots_are_also_protected() {
    let dir = fixture();
    let managed = dir.path().join("manager");
    let source = dir.path().join("source");
    let app = source.join("target/debug");
    let state = dir.path().join("external-state");
    let cache = dir.path().join("external-cache");
    let deps = dir.path().join("dependencies");
    for path in [&state, &cache, &app, &deps] {
        fs::create_dir_all(path).unwrap();
    }
    // Storage reads these isolated fixture files; no user configuration is used.
    fs::write(app.join("storage-paths.json"),serde_json::to_vec(&json!({"formatVersion":1,"config":{"managedRoot":managed,"overrides":{"state":state,"temp":cache}}})).unwrap()).unwrap();
    fs::create_dir(source.join("src-tauri")).unwrap();
    fs::write(source.join("package.json"), b"{}").unwrap();
    fs::write(
        source.join("src-tauri/Cargo.toml"),
        b"# synthetic developer detection fixture",
    )
    .unwrap();
    fs::write(
        source.join("developer-paths.json"),
        serde_json::to_vec(&json!({"dependencyRoot":deps})).unwrap(),
    )
    .unwrap();
    let storage = crate::storage::Storage::load(
        managed,
        &app.join("agent-resource-manager.exe"),
        "fixture",
        false,
    )
    .unwrap();
    let m = Manager::with_storage(storage).unwrap();
    for root in [&state, &cache] {
        assert!(ensure_independent_destination(&m, &root.join("runtime")).is_err());
    }
    let snapshot = m.storage.snapshot().unwrap();
    let developer = snapshot["developer"].as_object().unwrap();
    assert_eq!(
        path_key(Path::new(developer["projectRoot"].as_str().unwrap())),
        path_key(&source)
    );
    assert_eq!(
        path_key(Path::new(developer["dependencyRoot"].as_str().unwrap())),
        path_key(&deps)
    );
    for field in ["projectRoot", "dependencyRoot"] {
        let root = Path::new(developer[field].as_str().unwrap());
        assert!(ensure_independent_destination(&m, &root.join("runtime")).is_err());
    }
}

struct LiveSnapshot(Value);

macro_rules! unused_store {
    ($name:ident, $request:ty) => {
        fn $name(&self, _request: $request) -> Result<Value, String> {
            Err("synthetic runtime does not accept writes".into())
        }
    };
}

impl crate::model::ManagerRuntime for LiveSnapshot {
    fn ensure_live_maintenance_allowed(&self, basic_mode_error: &str) -> Result<(), String> {
        if self.0["startup"]["basicMode"] == true {
            return Err(basic_mode_error.into());
        }
        crate::maintenance::ensure_automatic_allowed(&self.0["settings"])
    }
    fn snapshot(&self) -> Value {
        self.0.clone()
    }
    fn save(&self, _manager: &Manager) -> Result<(), String> {
        Err("no writes".into())
    }
    fn begin_automatic_commit(&self) -> Result<(), String> {
        Err("no commits".into())
    }
    fn resource_store(&self, request: StoreRequest) -> Result<Value, String> {
        match request {
            StoreRequest::List => Ok(json!({"resources":[]})),
            _ => Err("no catalogue writes".into()),
        }
    }
    unused_store!(resource_check_store, crate::resource_checks::StoreRequest);
    unused_store!(
        resource_automation_store,
        crate::resource_automation::StoreRequest
    );
    unused_store!(management_store, crate::management_data::StoreRequest);
    unused_store!(template_store, crate::invocation_templates::StoreRequest);
    unused_store!(relation_store, crate::resource_relations::StoreRequest);
    unused_store!(scene_store, crate::resource_scenes::StoreRequest);
    unused_store!(configuration_store, crate::configuration::StoreRequest);
    unused_store!(download_store, crate::resource_github::DownloadStore);
    unused_store!(resource_spawn, crate::resource_runtime::PreparedInvocation);
}

#[test]
fn detached_install_and_remove_use_live_skill_ownership_instead_of_worker_state() {
    let dir = fixture();
    let manager = Manager::new(dir.path().join("manager")).unwrap();
    let skill = dir.path().join("newly-discovered-skill");
    fs::create_dir(&skill).unwrap();
    let live = json!({"skills":[{"id":"new-skill","localPath":skill}]});
    let worker = manager.detached(std::sync::Arc::new(LiveSnapshot(live)), true);
    assert!(
        worker.state.skills.is_empty(),
        "detached worker was created before discovery"
    );
    let target = skill.join("runtime");
    assert!(ensure_independent_destination(&worker, &target)
        .unwrap_err()
        .contains("已登记 Skill"));
    let shared = removal_shared_scope(&worker, "unrelated-tool").unwrap();
    assert!(shared
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["id"] == "new-skill"));
    assert!(root_shared(&skill, &shared));
    assert!(!target.exists());
}

#[test]
fn unreadable_live_skill_ownership_blocks_installation_and_removal_checks() {
    let dir = fixture();
    let manager = Manager::new(dir.path().join("manager")).unwrap();
    let worker = manager.detached(std::sync::Arc::new(LiveSnapshot(Value::Null)), true);
    assert!(
        ensure_independent_destination(&worker, &dir.path().join("runtime"))
            .unwrap_err()
            .contains("Skill 目录不可读")
    );
    assert!(removal_shared_scope(&worker, "unrelated-tool")
        .unwrap_err()
        .contains("Skill 目录不可读"));
    assert!(!dir.path().join("runtime").exists());
}
