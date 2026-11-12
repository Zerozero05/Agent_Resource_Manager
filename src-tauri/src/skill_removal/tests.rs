use super::*;
use crate::resource_files::FileRole;

fn fixture() -> tempfile::TempDir {
    let base = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("work/skill-removal-tests");
    fs::create_dir_all(&base).unwrap();
    tempfile::tempdir_in(base).unwrap()
}

fn setup(path: &Path, with_receipt: bool) -> (Manager, PathBuf, String) {
    let root = path.join("skill");
    fs::create_dir_all(&root).unwrap();
    for (name, content) in [
        (
            "SKILL.md",
            "---\nname: synthetic\ndescription: Synthetic fixture\n---\nBody",
        ),
        ("LICENSE", "synthetic license"),
        ("config.json", "synthetic user config"),
    ] {
        fs::write(root.join(name), content).unwrap();
    }
    let mut m = Manager::new(path.join("state")).unwrap();
    crate::local::handle(&mut m, &json!({"action":"add_local","paths":[root]})).unwrap();
    let id = m.state.skills[0]["id"].as_str().unwrap().to_owned();
    if with_receipt {
        install_receipt(&mut m, &root);
    }
    m.save().unwrap();
    (m, root, id)
}

fn install_receipt(m: &mut Manager, root: &Path) {
    let files: Vec<_> = [
        ("SKILL.md", FileRole::Runtime),
        ("LICENSE", FileRole::License),
        ("config.json", FileRole::Configuration),
    ]
    .into_iter()
    .map(|(name, role)| OwnedFile {
        path: name.into(),
        role,
        installed_sha256: resource_files::fingerprint(&root.join(name))
            .unwrap()
            .sha256,
    })
    .collect();
    m.state.skills[0]["installation"] =
        json!({"schemaVersion":1,"origin":"managerInstall","rootPath":root,"files":files});
}

fn plan(m: &mut Manager, id: &str, extent: &str) -> Value {
    handle(
        m,
        &json!({"action":"preview_skill_remove","skillId":id,"extent":extent,"customFiles":[]}),
    )
    .unwrap()
    .unwrap()
}

fn apply(m: &mut Manager, plan: &Value) -> Result<Value, String> {
    apply_local(
        m,
        &json!({"action":"apply_skill_remove","previewId":plan["id"]}),
    )
    .map(Option::unwrap)
}

fn link(m: &mut Manager, id: &str, path: &Path) {
    crate::clients::handle(
        m,
        &json!({"action":"connect","client":"codex","skillId":id,"targetPath":path}),
    )
    .unwrap();
}

#[test]
fn scans_and_baselines_do_not_grant_ownership_and_disable_only_unlinks() {
    let f = fixture();
    let (mut m, root, id) = setup(f.path(), false);
    m.state.skills[0]["baselineHashes"] = json!(crate::local::files(&root).unwrap());
    let before = crate::local::files(&root).unwrap();
    let full = plan(&mut m, &id, "full");
    assert_eq!(full["canApply"], false);
    assert!(apply(&mut m, &full).is_err());
    let entry = f.path().join("client/synthetic");
    link(&mut m, &id, &entry);
    let disable = plan(&mut m, &id, "disable");
    assert_eq!(disable["canApply"], true);
    assert!(disable["entries"].as_array().unwrap().is_empty());
    assert_eq!(
        disable["linkEntries"][0]["target"],
        json!(readable(&crate::local::canonical(&root).unwrap()))
    );
    let result = apply(&mut m, &disable).unwrap();
    assert_eq!(result["complete"], true);
    assert!(m.state.connections.is_empty());
    assert!(fs::symlink_metadata(&entry).is_err());
    assert_eq!(crate::local::files(&root).unwrap(), before);
    assert!(m.state.skills[0].get("installation").is_none());
    assert!(apply(&mut m, &disable).is_err());
}

#[test]
fn runtime_removal_preserves_modified_runtime_unknown_files_and_user_data() {
    let f = fixture();
    let (mut m, root, id) = setup(f.path(), true);
    fs::write(root.join("SKILL.md"), "local modification").unwrap();
    fs::write(root.join("unique.txt"), "unknown unique file").unwrap();
    let preview = plan(&mut m, &id, "runtime");
    assert_eq!(preview["canApply"], true);
    let result = apply(&mut m, &preview).unwrap();
    assert_eq!(result["complete"], false);
    assert!(!root.join("LICENSE").exists());
    assert!(root.join("SKILL.md").exists());
    assert!(root.join("config.json").exists());
    assert!(root.join("unique.txt").exists());
    let remaining = m.state.skills[0]["installation"]["files"]
        .as_array()
        .unwrap();
    assert_eq!(remaining.len(), 2);
    assert_eq!(m.state.skills[0]["lastRemoval"]["status"], "partial");
    assert_eq!(m.state.skills[0]["runtimeAudit"]["status"], "needs_review");
    assert_eq!(
        m.state.skills[0]["localPath"],
        json!(readable(&crate::local::canonical(&root).unwrap()))
    );
}

#[test]
fn full_removes_only_owned_files_and_custom_can_explicitly_choose_modified_runtime() {
    let f = fixture();
    let (mut m, root, id) = setup(f.path(), true);
    fs::write(root.join("unknown.txt"), "keep").unwrap();
    fs::write(root.join("SKILL.md"), "modified").unwrap();
    let full = plan(&mut m, &id, "full");
    let result = apply(&mut m, &full).unwrap();
    assert_eq!(result["complete"], false);
    assert!(root.join("SKILL.md").exists());
    assert!(!root.join("config.json").exists());
    assert!(root.join("unknown.txt").exists());
    let custom = handle(&mut m, &json!({"action":"preview_skill_remove","skillId":id,"extent":"custom","customFiles":["SKILL.md"]})).unwrap().unwrap();
    assert_eq!(custom["entries"][0]["remove"], true);
    let result = apply(&mut m, &custom).unwrap();
    assert_eq!(result["complete"], true);
    assert!(!root.join("SKILL.md").exists());
    assert!(root.join("unknown.txt").exists());
    assert!(root.is_dir());
    assert_eq!(m.state.skills.len(), 1);
    assert!(m.state.skills[0]["installation"]["files"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn changed_file_invalidates_whole_preview_before_unlinking_any_client() {
    let f = fixture();
    let (mut m, root, id) = setup(f.path(), true);
    let entry = f.path().join("client/synthetic");
    link(&mut m, &id, &entry);
    let preview = plan(&mut m, &id, "full");
    fs::write(root.join("config.json"), "changed after preview").unwrap();
    assert!(apply(&mut m, &preview).unwrap_err().contains("预览后变化"));
    assert!(fs::symlink_metadata(entry).is_ok());
    assert_eq!(m.state.connections.len(), 1);
    assert!(root.join("LICENSE").exists());
    assert!(m.state.skills[0].get("lastRemoval").is_none());
}

#[test]
fn replaced_root_object_with_same_files_is_not_the_approved_directory() {
    let f = fixture();
    let (mut m, root, id) = setup(f.path(), true);
    let preview = plan(&mut m, &id, "full");
    let moved = f.path().join("old-root");
    fs::rename(&root, &moved).unwrap();
    fs::create_dir(&root).unwrap();
    for name in ["SKILL.md", "LICENSE", "config.json"] {
        fs::copy(moved.join(name), root.join(name)).unwrap();
    }
    assert!(apply(&mut m, &preview)
        .unwrap_err()
        .contains("目录对象已替换"));
    assert!(root.join("SKILL.md").exists());
    assert!(moved.join("SKILL.md").exists());
}

#[test]
fn new_dependency_and_new_shared_root_invalidate_removal() {
    for relation in [true, false] {
        let f = fixture();
        let (mut m, root, id) = setup(f.path(), true);
        let preview = plan(&mut m, &id, "full");
        if relation {
            let other = f.path().join("consumer");
            fs::create_dir(&other).unwrap();
            fs::write(other.join("SKILL.md"), "consumer").unwrap();
            m.state
                .skills
                .push(json!({"id":"consumer","name":"consumer","localPath":other}));
            let revision = relations(&m, &id).unwrap()["revision"].as_u64().unwrap();
            m.relation_store(crate::resource_relations::StoreRequest::Add {
                dependent: crate::resource_relations::Endpoint {
                    kind: "skill".into(),
                    id: "consumer".into(),
                },
                dependency: crate::resource_relations::Endpoint {
                    kind: "skill".into(),
                    id: id.clone(),
                },
                expected_revision: revision,
            })
            .unwrap();
        } else {
            crate::resources::handle(
                &m,
                &json!({"action":"resource_register","name":"shared","kind":"cli","rootPath":root}),
            )
            .unwrap();
        }
        assert!(apply(&mut m, &preview)
            .unwrap_err()
            .contains("共享范围已变化"));
        assert!(root.join("SKILL.md").exists());
    }
}

#[test]
fn current_shared_or_readonly_or_forged_root_never_grants_deletion() {
    let f = fixture();
    let (mut m, root, id) = setup(f.path(), true);
    m.state
        .skills
        .push(json!({"id":"shared","localPath":root,"name":"same root"}));
    assert_eq!(plan(&mut m, &id, "full")["canApply"], false);
    m.state.skills.pop();
    m.state.skills[0]["installation"]["rootPath"] = json!(f.path());
    assert_eq!(plan(&mut m, &id, "full")["canApply"], false);
    m.state.skills[0]["readOnly"] = json!(true);
    assert!(handle(
        &mut m,
        &json!({"action":"preview_skill_remove","skillId":id,"extent":"disable"})
    )
    .is_err());
    assert!(root.join("SKILL.md").exists());
}

#[test]
fn save_failure_precedes_all_external_writes_and_rejects_reusable_confirmation_flags() {
    let f = fixture();
    let (mut m, root, id) = setup(f.path(), true);
    let entry = f.path().join("client/synthetic");
    link(&mut m, &id, &entry);
    let preview = plan(&mut m, &id, "full");
    assert!(apply_local(
        &mut m,
        &json!({"action":"apply_skill_remove","previewId":preview["id"],"confirmed":true})
    )
    .is_err());
    let db = rusqlite::Connection::open(m.data_dir.join("manager.sqlite3")).unwrap();
    db.execute_batch("CREATE TRIGGER removal_test_no_update BEFORE UPDATE ON app_state BEGIN SELECT RAISE(FAIL, 'synthetic save failure'); END;").unwrap();
    let before = m.state.clone();
    assert!(apply(&mut m, &preview)
        .unwrap_err()
        .contains("不能保存本次处理记录"));
    assert!(m.state == before);
    assert!(fs::symlink_metadata(&entry).is_ok());
    assert!(root.join("SKILL.md").exists());
}

#[test]
fn expired_or_changed_connection_preview_is_rejected_without_deletion() {
    let f = fixture();
    let (mut m, root, id) = setup(f.path(), true);
    let entry = f.path().join("client/synthetic");
    link(&mut m, &id, &entry);
    let expired = plan(&mut m, &id, "full");
    let preview_id = expired["id"].as_str().unwrap();
    m.previews.get_mut(preview_id).unwrap()["prepared"]["createdAt"] =
        json!(chrono::Utc::now().timestamp() - 601);
    assert!(apply(&mut m, &expired).unwrap_err().contains("过期"));
    let changed = plan(&mut m, &id, "full");
    m.state.connections[0]["origin"] = json!("external-change");
    assert!(apply(&mut m, &changed).unwrap_err().contains("记录已变化"));
    assert!(fs::symlink_metadata(entry).is_ok());
    assert!(root.join("SKILL.md").exists());
}

#[test]
fn custom_scope_cannot_add_unknown_files_or_duplicate_entries() {
    let f = fixture();
    let (mut m, root, id) = setup(f.path(), true);
    fs::write(root.join("unknown.txt"), "unique input").unwrap();
    for files in [
        json!(["unknown.txt"]),
        json!(["SKILL.md", "SKILL.md"]),
        json!(["../outside.txt"]),
    ] {
        assert!(handle(&mut m,&json!({"action":"preview_skill_remove","skillId":id,"extent":"custom","customFiles":files})).is_err());
    }
    assert!(root.join("unknown.txt").exists());
}

#[test]
fn processing_intent_restart_requires_fresh_scope_and_never_replays_completed_file_removal() {
    for first_file_removed in [false, true] {
        let f = fixture();
        let (mut m, root, id) = setup(f.path(), true);
        let old = plan(&mut m, &id, "full");
        let prepared: Prepared =
            serde_json::from_value(m.previews[old["id"].as_str().unwrap()]["prepared"].clone())
                .unwrap();
        // Model the durable intent / first file-write boundary. The final result
        // was never saved. This is a backend restart fixture, not a GUI crash.
        m.state.skills[0]["lastRemoval"] = json!({"planId":prepared.plan.id,"extent":prepared.plan.extent,"startedAt":now(),"status":"processing","entries":prepared.plan.entries,"linkEntries":old["linkEntries"]});
        m.save().unwrap();
        let completed_path = crate::local::safe_join(&prepared.plan.root, "LICENSE").unwrap();
        if first_file_removed {
            let first = RemovalPlan {
                entries: prepared
                    .plan
                    .entries
                    .iter()
                    .filter(|entry| entry.relative == "LICENSE")
                    .cloned()
                    .collect(),
                ..prepared.plan.clone()
            };
            let result = resource_files::apply_removal(&first).unwrap();
            assert_eq!(result.deleted, vec![completed_path.clone()]);
            assert!(result.failures.is_empty());
        }
        let source_before = fs::read(root.join("SKILL.md")).unwrap();
        let config_before = fs::read(root.join("config.json")).unwrap();
        drop(m);

        let mut reopened = Manager::new(f.path().join("state")).unwrap();
        assert_eq!(
            reopened.state.skills[0]["lastRemoval"]["status"],
            "processing"
        );
        assert_eq!(reopened.state.skills[0]["lastRemoval"]["planId"], old["id"]);
        assert!(reopened.previews.is_empty());
        assert!(apply(&mut reopened, &old).is_err());
        assert_eq!(completed_path.exists(), !first_file_removed);
        assert_eq!(fs::read(root.join("SKILL.md")).unwrap(), source_before);
        assert_eq!(fs::read(root.join("config.json")).unwrap(), config_before);

        let fresh = plan(&mut reopened, &id, "runtime");
        assert_ne!(fresh["id"], old["id"]);
        assert_eq!(fresh["extent"], "runtime");
        let license = fresh["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["relative"] == "LICENSE")
            .unwrap();
        assert_eq!(license["expected"].is_null(), first_file_removed);
        assert_eq!(license["remove"], !first_file_removed);
        assert!(
            root.join("SKILL.md").exists(),
            "preview must not remove files"
        );
        let result = apply(&mut reopened, &fresh).unwrap();
        assert_eq!(result["complete"], true);
        let deleted = result["result"]["deleted"].as_array().unwrap();
        assert_eq!(deleted.len(), if first_file_removed { 1 } else { 2 });
        if first_file_removed {
            assert!(!deleted.contains(&json!(completed_path)));
        }
        assert!(result["result"]["failures"].as_array().unwrap().is_empty());
        assert!(apply(&mut reopened, &fresh).is_err());
        assert!(!root.join("SKILL.md").exists());
        assert!(!completed_path.exists());
        assert_eq!(fs::read(root.join("config.json")).unwrap(), config_before);
        assert_eq!(reopened.state.skills.len(), 1);
        assert_eq!(
            reopened.state.skills[0]["lastRemoval"]["status"],
            "completed"
        );
        assert_eq!(reopened.state.skills[0]["lastRemoval"]["extent"], "runtime");
        drop(reopened);
        let final_state = Manager::new(f.path().join("state")).unwrap();
        assert_eq!(
            final_state.state.skills[0]["lastRemoval"]["status"],
            "completed"
        );
        assert_eq!(fs::read(root.join("config.json")).unwrap(), config_before);
    }
}

#[test]
fn abandoned_skill_removal_previews_are_bounded_and_keep_the_latest_confirmation() {
    let f = fixture();
    let (mut m, root, id) = setup(f.path(), true);
    let before = crate::local::files(&root).unwrap();
    let oldest = plan(&mut m, &id, "runtime");
    let mut latest = oldest.clone();
    for _ in 0..39 {
        std::thread::sleep(std::time::Duration::from_millis(2));
        latest = plan(&mut m, &id, "runtime");
    }
    assert_eq!(m.previews.len(), 32);
    assert!(!m.previews.contains_key(oldest["id"].as_str().unwrap()));
    assert!(m.previews.contains_key(latest["id"].as_str().unwrap()));
    assert!(apply(&mut m, &oldest).is_err());
    assert_eq!(crate::local::files(&root).unwrap(), before);
    let latest_id = latest["id"].as_str().unwrap();
    m.previews.get_mut(latest_id).unwrap()["prepared"]["createdAt"] =
        json!(chrono::Utc::now().timestamp() - 601);
    assert!(apply(&mut m, &latest).unwrap_err().contains("过期"));
    assert_eq!(crate::local::files(&root).unwrap(), before);
    let fresh = plan(&mut m, &id, "runtime");
    let result = apply(&mut m, &fresh).unwrap();
    assert_eq!(result["complete"], true);
    assert_eq!(
        fs::read_to_string(root.join("config.json")).unwrap(),
        "synthetic user config"
    );
}

#[test]
fn newest_skill_preview_uses_milliseconds_in_the_mixed_pool_without_changing_consent_age() {
    let f = fixture();
    let (mut m, root, id) = setup(f.path(), true);
    let stamp = chrono::Utc::now().timestamp_millis();
    for index in 0..32 {
        m.previews.insert(
            format!("existing-resource-{index:02}"),
            json!({"kind":"resourceRemove","createdAt":stamp - 1000 + index}),
        );
    }
    let fresh = plan(&mut m, &id, "runtime");
    let cached = &m.previews[fresh["id"].as_str().unwrap()];
    assert_eq!(m.previews.len(), 32);
    assert!(!m.previews.contains_key("existing-resource-00"));
    assert!(cached["createdAt"].as_i64().unwrap() >= stamp);
    let consent_created_at = cached["prepared"]["createdAt"].as_i64().unwrap();
    assert!((0..=1).contains(&(chrono::Utc::now().timestamp() - consent_created_at)));
    assert_eq!(apply(&mut m, &fresh).unwrap()["complete"], true);
    assert!(root.join("config.json").exists());
}

#[test]
fn connected_skill_preview_reclaims_only_its_owned_disconnect_previews() {
    let f = fixture();
    let (mut m, root, id) = setup(f.path(), true);
    let entry = f.path().join("client/synthetic");
    link(&mut m, &id, &entry);
    let connection_id = m.state.connections[0]["id"].clone();
    let independent = crate::clients::handle(
        &mut m,
        &json!({"action":"preview_disconnect","connectionId":connection_id}),
    )
    .unwrap()
    .unwrap();
    m.previews.insert(
        "protected-configuration".into(),
        json!({"kind":"configurationImport","skillRemovalPreviewId":"missing","keep":true}),
    );
    let before = crate::local::files(&root).unwrap();
    let oldest = plan(&mut m, &id, "runtime");
    let oldest_child = m.previews[oldest["id"].as_str().unwrap()]["prepared"]["disconnects"][0]
        ["previewId"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut latest = oldest.clone();
    for _ in 0..39 {
        std::thread::sleep(std::time::Duration::from_millis(2));
        latest = plan(&mut m, &id, "runtime");
    }
    assert_eq!(m.previews.len(), 32 * 2 + 2);
    assert!(!m.previews.contains_key(oldest["id"].as_str().unwrap()));
    assert!(!m.previews.contains_key(&oldest_child));
    assert_eq!(m.previews[independent["id"].as_str().unwrap()], independent);
    assert_eq!(m.previews["protected-configuration"]["keep"], true);
    assert_eq!(crate::local::files(&root).unwrap(), before);
    assert!(fs::symlink_metadata(&entry).is_ok());
    let latest_child = m.previews[latest["id"].as_str().unwrap()]["prepared"]["disconnects"][0]
        ["previewId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(m.previews[&latest_child]["kind"], "disconnect");
    let result = apply(&mut m, &latest).unwrap();
    assert_eq!(result["complete"], true);
    assert!(!m.previews.contains_key(&latest_child));
    assert!(!m.previews.contains_key(latest["id"].as_str().unwrap()));
    assert!(m.previews.contains_key(independent["id"].as_str().unwrap()));
    assert!(m.previews.contains_key("protected-configuration"));
    assert!(fs::symlink_metadata(&entry).is_err());
    assert!(root.join("config.json").is_file());
}

#[test]
fn failed_skill_removal_consumes_only_its_owned_disconnect_previews() {
    for failure in ["expired", "file-changed", "save-failed"] {
        let f = fixture();
        let (mut m, root, id) = setup(f.path(), true);
        let entry = f.path().join("client/synthetic");
        link(&mut m, &id, &entry);
        let connection_id = m.state.connections[0]["id"].clone();
        let independent = crate::clients::handle(
            &mut m,
            &json!({"action":"preview_disconnect","connectionId":connection_id}),
        )
        .unwrap()
        .unwrap();
        let preview = plan(&mut m, &id, "runtime");
        let parent_id = preview["id"].as_str().unwrap();
        let child_id = m.previews[parent_id]["prepared"]["disconnects"][0]["previewId"]
            .as_str()
            .unwrap()
            .to_owned();
        let expected_error = match failure {
            "expired" => {
                m.previews.get_mut(parent_id).unwrap()["prepared"]["createdAt"] =
                    json!(chrono::Utc::now().timestamp() - 601);
                "过期"
            }
            "file-changed" => {
                fs::write(root.join("SKILL.md"), "changed after preview").unwrap();
                "变化"
            }
            "save-failed" => {
                let db = rusqlite::Connection::open(m.data_dir.join("manager.sqlite3")).unwrap();
                db.execute_batch("CREATE TRIGGER removal_test_no_update BEFORE UPDATE ON app_state BEGIN SELECT RAISE(FAIL, 'synthetic save failure'); END;").unwrap();
                "不能保存本次处理记录"
            }
            _ => unreachable!(),
        };
        let before = crate::local::files(&root).unwrap();
        let error = apply(&mut m, &preview).unwrap_err();
        assert!(error.contains(expected_error), "{failure}: {error}");
        assert!(!m.previews.contains_key(parent_id), "{failure}");
        assert!(!m.previews.contains_key(&child_id), "{failure}");
        assert_eq!(
            m.previews[independent["id"].as_str().unwrap()],
            independent,
            "{failure}"
        );
        assert_eq!(crate::local::files(&root).unwrap(), before, "{failure}");
        assert!(fs::symlink_metadata(&entry).is_ok(), "{failure}");
        assert_eq!(m.state.connections.len(), 1, "{failure}");
    }
}
