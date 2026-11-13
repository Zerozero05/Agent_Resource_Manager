use super::*;

fn fixture() -> tempfile::TempDir {
    let parent = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("work/local-record-tests");
    fs::create_dir_all(&parent).unwrap();
    tempfile::tempdir_in(parent).unwrap()
}

fn create_skill(path: &Path, name: &str) {
    fs::create_dir_all(path).unwrap();
    fs::write(
        path.join("SKILL.md"),
        format!(
            "---\nname: {name}\ndescription: synthetic\nversion: '1.0.0'\n---\nUse this Skill.\n"
        ),
    )
    .unwrap();
}

fn register(m: &mut Manager, path: &Path) -> String {
    handle(m, &json!({"action":"add_local","paths":[path]})).unwrap();
    m.state
        .skills
        .iter()
        .find(|skill| skill["localPath"] == readable_path(&canonical(path).unwrap()))
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn preview(m: &mut Manager, id: &str, path: &Path) -> Value {
    handle(
        m,
        &json!({"action":"preview_relocate_local","skillId":id,"path":path}),
    )
    .unwrap()
    .unwrap()
}

#[test]
fn physical_rename_keeps_stable_id_and_management_instead_of_importing_a_duplicate() {
    let f = fixture();
    let old = f.path().join("old");
    let new = f.path().join("new");
    create_skill(&old, "old-internal");
    let mut m = Manager::new(f.path().join("state")).unwrap();
    let id = register(&mut m, &old);
    let automatic_identity_available = m.state.skills[0]["localIdentity"].is_string();
    m.state.skills[0]["categoryId"] = json!("category");
    m.state.skills[0]["favorite"] = json!(true);
    m.state.skills[0]["sourceId"] = json!("source");
    m.state.skills[0]["remotePath"] = json!("original-remote");
    m.state.skills[0]["baselineCommit"] = json!("installed");
    m.state.skills[0]["baselineHashes"] = json!({"SKILL.md":"historical"});
    fs::rename(&old, &new).unwrap();
    create_skill(&new, "renamed-internal");
    handle(&mut m, &json!({"action":"add_local","paths":[new]})).unwrap();
    if !automatic_identity_available {
        assert_eq!(m.state.skills.len(), 2);
        assert_eq!(m.state.skills[0]["id"], id);
        assert_eq!(m.state.skills[0]["name"], "old-internal");
        return;
    }
    assert_eq!(m.state.skills.len(), 1);
    let record = &m.state.skills[0];
    assert_eq!(record["id"], id);
    assert_eq!(record["name"], "renamed-internal");
    assert_eq!(record["categoryId"], "category");
    assert_eq!(record["favorite"], true);
    assert_eq!(record["remotePath"], "original-remote");
    assert_eq!(record["baselineCommit"], "installed");
    assert_eq!(record["baselineHashes"]["SKILL.md"], "historical");
    assert_ne!(record["status"], "synced");
}

#[test]
fn missing_legacy_record_is_never_merged_by_equal_name_or_equal_bytes() {
    let f = fixture();
    let old = f.path().join("old");
    let new = f.path().join("new");
    create_skill(&old, "same-name");
    let mut m = Manager::new(f.path().join("state")).unwrap();
    let old_id = register(&mut m, &old);
    m.state.skills[0]["localIdentity"] = Value::Null;
    fs::rename(&old, &new).unwrap();
    let new_id = register(&mut m, &new);
    assert_ne!(new_id, old_id);
    assert_eq!(m.state.skills.len(), 2);
}

#[test]
fn explicit_relocation_absorbs_only_clean_duplicate_and_preserves_old_identity_and_notes() {
    let f = fixture();
    let old = f.path().join("old");
    let new = f.path().join("new");
    create_skill(&old, "old-internal");
    let mut m = Manager::new(f.path().join("state")).unwrap();
    let id = register(&mut m, &old);
    m.state.skills[0]["localIdentity"] = Value::Null;
    m.state.skills[0]["categoryId"] = json!("category");
    m.state.skills[0]["favorite"] = json!(true);
    m.state.skills[0]["sourceId"] = json!("source");
    m.state.skills[0]["remotePath"] = json!("old-remote");
    m.state.skills[0]["baselineCommit"] = json!("immutable");
    m.state.skills[0]["installedCommit"] = json!("immutable");
    m.state.skills[0]["baselineHashes"] = json!({"SKILL.md":"old-base"});
    m.management_store(crate::management_data::StoreRequest::AnnotationSet {
        skill_id: id.clone(),
        expected_revision: 0,
        alias: "Personal alias".into(),
        notes: "Keep my notes".into(),
    })
    .unwrap();
    fs::rename(&old, &new).unwrap();
    create_skill(&new, "actual-internal");
    let duplicate = register(&mut m, &new);
    assert_ne!(duplicate, id);
    let plan = preview(&mut m, &id, &new);
    assert_eq!(plan["duplicateId"], duplicate);
    assert_eq!(plan["canApply"], true);
    handle(
        &mut m,
        &json!({"action":"relocate_local","previewId":plan["id"]}),
    )
    .unwrap();
    assert_eq!(m.state.skills.len(), 1);
    let record = &m.state.skills[0];
    assert_eq!(record["id"], id);
    assert_eq!(record["name"], "actual-internal");
    assert_eq!(record["categoryId"], "category");
    assert_eq!(record["favorite"], true);
    assert_eq!(record["remotePath"], "old-remote");
    assert_eq!(record["installedCommit"], "immutable");
    assert_eq!(record["baselineCommit"], "immutable");
    assert_eq!(
        m.management_store(crate::management_data::StoreRequest::List)
            .unwrap()["skillAnnotations"][0]["notes"],
        "Keep my notes"
    );
    assert!(new.join("SKILL.md").is_file());
    assert!(!old.exists());
    assert!(handle(
        &mut m,
        &json!({"action":"relocate_local","previewId":plan["id"]})
    )
    .is_err());
}

#[test]
fn relocation_rejects_target_edits_and_preserves_all_state_on_save_failure() {
    let f = fixture();
    let old = f.path().join("old");
    let new = f.path().join("new");
    create_skill(&old, "old");
    create_skill(&new, "new");
    let mut m = Manager::new(f.path().join("state")).unwrap();
    let id = register(&mut m, &old);
    let plan = preview(&mut m, &id, &new);
    let before = m.state.clone();
    create_skill(&new, "edited-after-preview");
    assert!(handle(
        &mut m,
        &json!({"action":"relocate_local","previewId":plan["id"]})
    )
    .is_err());
    assert!(m.state == before);
    let plan = preview(&mut m, &id, &new);
    m.basic_mode = true;
    assert!(handle(
        &mut m,
        &json!({"action":"relocate_local","previewId":plan["id"]})
    )
    .is_err());
    assert!(m.state == before);
}

#[test]
fn duplicate_notes_and_client_connections_block_absorption_without_losing_them() {
    let f = fixture();
    let old = f.path().join("old");
    let new = f.path().join("new");
    create_skill(&old, "old");
    create_skill(&new, "new");
    let mut m = Manager::new(f.path().join("state")).unwrap();
    let id = register(&mut m, &old);
    let duplicate = register(&mut m, &new);
    m.management_store(crate::management_data::StoreRequest::AnnotationSet {
        skill_id: duplicate.clone(),
        expected_revision: 0,
        alias: "".into(),
        notes: "Unique duplicate note".into(),
    })
    .unwrap();
    assert_eq!(preview(&mut m, &id, &new)["canApply"], false);
    m.management_store(crate::management_data::StoreRequest::AnnotationSet {
        skill_id: duplicate.clone(),
        expected_revision: 1,
        alias: "".into(),
        notes: "".into(),
    })
    .unwrap();
    m.state.connections.push(json!({"id":"existing-entry","skillId":duplicate,"client":"codex","path":f.path().join("entry"),"target":new}));
    assert_eq!(preview(&mut m, &id, &new)["canApply"], false);
    assert_eq!(m.state.skills.len(), 2);
    assert_eq!(m.state.connections.len(), 1);
}

#[test]
fn forget_preserves_relations_scenes_and_annotations_instead_of_dangling_or_erasing_them() {
    let f = fixture();
    let one = f.path().join("one");
    let two = f.path().join("two");
    create_skill(&one, "one");
    create_skill(&two, "two");
    let mut m = Manager::new(f.path().join("state")).unwrap();
    let first = register(&mut m, &one);
    let second = register(&mut m, &two);
    m.relation_store(crate::resource_relations::StoreRequest::Add {
        dependent: crate::resource_relations::Endpoint {
            kind: "skill".into(),
            id: first.clone(),
        },
        dependency: crate::resource_relations::Endpoint {
            kind: "skill".into(),
            id: second.clone(),
        },
        expected_revision: 0,
    })
    .unwrap();
    let before = m.state.clone();
    assert!(handle(&mut m, &json!({"action":"forget","skillId":first}))
        .unwrap_err()
        .contains("依赖"));
    assert!(handle(&mut m, &json!({"action":"forget","skillId":second})).is_err());
    assert!(m.state == before);
    let edge = m
        .relation_store(crate::resource_relations::StoreRequest::List {
            endpoint: crate::resource_relations::Endpoint {
                kind: "skill".into(),
                id: first.clone(),
            },
        })
        .unwrap();
    m.relation_store(crate::resource_relations::StoreRequest::Remove {
        id: edge["dependencies"][0]["id"].as_str().unwrap().into(),
        expected_revision: edge["revision"].as_u64().unwrap(),
    })
    .unwrap();
    m.scene_store(crate::resource_scenes::StoreRequest::Save {
        id: None,
        expected_revision: 0,
        name: "A scene".into(),
        members: vec![crate::resource_relations::Endpoint {
            kind: "skill".into(),
            id: first.clone(),
        }],
    })
    .unwrap();
    assert!(handle(&mut m, &json!({"action":"forget","skillId":first}))
        .unwrap_err()
        .contains("场景"));
    assert!(one.join("SKILL.md").is_file());
}

#[test]
fn refresh_metadata_updates_internal_name_and_fallbacks_without_touching_management() {
    let f = fixture();
    let root = f.path().join("fallback-name");
    create_skill(&root, "initial");
    let mut m = Manager::new(f.path().join("state")).unwrap();
    let id = register(&mut m, &root);
    m.state.skills[0]["favorite"] = json!(true);
    m.state.skills[0]["categoryId"] = json!("category");
    create_skill(&root, "new-name");
    handle(&mut m, &json!({"action":"refresh","skillId":id})).unwrap();
    assert_eq!(m.state.skills[0]["name"], "new-name");
    fs::write(
        root.join("SKILL.md"),
        "---\ndescription: fallback declaration\n---\nBody.\n",
    )
    .unwrap();
    handle(&mut m, &json!({"action":"refresh","skillId":id})).unwrap();
    assert_eq!(m.state.skills[0]["name"], "fallback-name");
    assert_eq!(m.state.skills[0]["displayName"], "fallback-name");
    assert!(m.state.skills[0]["version"].is_null());
    assert_eq!(m.state.skills[0]["favorite"], true);
    assert_eq!(m.state.skills[0]["categoryId"], "category");
}

#[test]
fn legacy_catalog_display_updates_on_relocation_but_unknown_custom_display_is_retained() {
    let f = fixture();
    let old = f.path().join("model-search");
    let new = f.path().join("model-research");
    create_skill(&old, "model-search");
    create_skill(&new, "model-research");
    fs::write(new.join("SKILL.md"), "---\nname: model-research\ndisplayName: Model Research\ndescription: synthetic\n---\nResearch.\n").unwrap();
    let mut m = Manager::new(f.path().join("state")).unwrap();
    let id = register(&mut m, &old);
    m.state.skills[0]
        .as_object_mut()
        .unwrap()
        .remove("localDeclaredDisplayName");
    m.state.skills[0]["displayName"] = json!("Model Search");
    m.state.skills[0]["catalogMetadata"] = json!({"display_name":"Model Search"});
    m.state.skills[0]["sourceId"] = json!("existing-source");
    m.state.skills[0]["remotePath"] = json!("model-search");
    let plan = preview(&mut m, &id, &new);
    handle(
        &mut m,
        &json!({"action":"relocate_local","previewId":plan["id"]}),
    )
    .unwrap();
    assert_eq!(m.state.skills[0]["id"], id);
    assert_eq!(m.state.skills[0]["name"], "model-research");
    assert_eq!(m.state.skills[0]["displayName"], "Model Research");
    assert_eq!(m.state.skills[0]["remotePath"], "model-search");
    let mut custom = m.state.skills[0].clone();
    custom
        .as_object_mut()
        .unwrap()
        .remove("localDeclaredDisplayName");
    custom["displayName"] = json!("My independent label");
    refresh_declared_metadata(&mut custom, None).unwrap();
    assert_eq!(custom["displayName"], "My independent label");
}

#[test]
fn local_version_removal_restores_existing_fallback_and_pure_local_version_becomes_unknown() {
    let f = fixture();
    let root = f.path().join("versioned");
    create_skill(&root, "versioned");
    let mut record = draft(&root).unwrap();
    record["version"] = json!("known-source-version");
    create_skill(&root, "versioned");
    refresh_declared_metadata(&mut record, None).unwrap();
    assert_eq!(record["version"], "1.0.0");
    assert_eq!(record["localVersionFallback"], "known-source-version");
    fs::write(
        root.join("SKILL.md"),
        "---\nname: versioned\ndescription: synthetic\n---\nNo local version.\n",
    )
    .unwrap();
    refresh_declared_metadata(&mut record, None).unwrap();
    assert_eq!(record["version"], "known-source-version");
    let mut local_only = draft(&root).unwrap();
    create_skill(&root, "versioned");
    refresh_declared_metadata(&mut local_only, None).unwrap();
    assert_eq!(local_only["version"], "1.0.0");
    fs::write(
        root.join("SKILL.md"),
        "---\nname: versioned\ndescription: synthetic\n---\nVersion removed.\n",
    )
    .unwrap();
    refresh_declared_metadata(&mut local_only, None).unwrap();
    assert!(local_only["version"].is_null());
}
