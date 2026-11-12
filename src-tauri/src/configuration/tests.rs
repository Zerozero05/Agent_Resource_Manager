use super::*;
use std::sync::{Arc, Mutex};

fn fixture() -> tempfile::TempDir {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("work/configuration-tests");
    fs::create_dir_all(&root).unwrap();
    tempfile::tempdir_in(root).unwrap()
}
fn manager(path: &Path) -> Manager {
    Manager::new(path.join("state")).unwrap()
}
fn local(m: &mut Manager, request: Value) -> Result<Value, String> {
    crate::dispatch_local(m, &request)
}
fn document(m: &mut Manager) -> Document {
    serde_json::from_value(m.configuration_store(StoreRequest::Read).unwrap()["document"].clone())
        .unwrap()
}
fn write_preview(m: &mut Manager, root: &Path, doc: &Document) -> Value {
    let path = root.join(format!("{}.json", uuid::Uuid::new_v4()));
    fs::write(&path, serde_json::to_vec(doc).unwrap()).unwrap();
    local(
        m,
        json!({"action":"preview_configuration_import","path":path}),
    )
    .unwrap()
}
fn apply_preview(m: &mut Manager, p: &Value) -> Result<Value, String> {
    let selected: Vec<_> = p["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| matches!(r["status"].as_str(), Some("new" | "conflict")))
        .map(|r| r["key"].clone())
        .collect();
    local(
        m,
        json!({"action":"apply_configuration_import","previewId":p["previewId"],"selected":selected}),
    )
}
fn populated(root: &Path) -> Manager {
    let mut m = manager(root);
    let skill_root = root.join("skill");
    fs::create_dir(&skill_root).unwrap();
    fs::write(skill_root.join("SKILL.md"), "# Synthetic").unwrap();
    m.state.settings["uiTheme"] = json!("eye");
    m.state.settings["privateToken"] = json!("DO-NOT-EXPORT-CREDENTIAL");
    m.state.settings["categories"] = json!([{"id":"cat","name":"研究","color":"teal"}]);
    m.state.sources = vec![
        json!({"id":"source","kind":"github","repo":"example/skills","branch":"main","roots":["skills"],"ignoredPaths":[],"token":"DO-NOT-EXPORT-CREDENTIAL"}),
    ];
    m.state.skills = vec![
        json!({"id":"skill","name":"Synthetic","displayName":"研究技能","localPath":skill_root,"sourceId":"source","repo":"example/skills","branch":"main","remotePath":"skills/test","categoryId":"cat","favorite":true,"enabled":true,"runtimeFiles":["SKILL.md"],"runtimeConfirmed":true,"managed":true,"installedCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","baselineHashes":{"SKILL.md":"original"},"login":"DO-NOT-EXPORT-CREDENTIAL"}),
    ];
    m.state.local_roots = vec![
        json!({"id":"root","name":"目录","path":skill_root,"resolvedPath":skill_root,"enabled":true}),
    ];
    m.state.ignored_local_paths = vec![root.join("ignored").to_string_lossy().into_owned()];
    m.save().unwrap();
    m.management_store(crate::management_data::StoreRequest::AnnotationSet {
        skill_id: "skill".into(),
        expected_revision: 0,
        alias: "研究助手".into(),
        notes: "个人备注".into(),
    })
    .unwrap();
    m.management_store(crate::management_data::StoreRequest::ViewSave {
        id: None,
        expected_revision: 0,
        name: "常用工具".into(),
        view: "tools".into(),
        filters: json!({"query":"研究","kind":""}),
    })
    .unwrap();
    m.scene_store(crate::resource_scenes::StoreRequest::Save {
        id: None,
        expected_revision: 0,
        name: "研究场景".into(),
        members: vec![crate::resource_relations::Endpoint {
            kind: "skill".into(),
            id: "skill".into(),
        }],
    })
    .unwrap();
    let tool_root = root.join("tool");
    fs::create_dir(&tool_root).unwrap();
    let registered=crate::dispatch(&mut m,&json!({"action":"resource_register","name":"Synthetic tool","kind":"cli","rootPath":tool_root,"repository":"https://github.com/example/tool"})).unwrap();
    let mut tool: ResourceRecord = serde_json::from_value(registered["resource"].clone()).unwrap();
    let old = tool.revision;
    tool.actions = vec![
        json!({"id":"query","label":"查询","mode":"command","executable":"not-exported.exe","args":[],"parameters":[],"private":"DO-NOT-EXPORT-CREDENTIAL"}),
    ];
    tool.revision += 1;
    m.resource_store(crate::resources::StoreRequest::Replace {
        record: Box::new(tool.clone()),
        expected_revision: old,
    })
    .unwrap();
    let db = Connection::open(m.data_dir.join("manager.sqlite3")).unwrap();
    let template = json!({"id":"template","revision":1,"name":"查询模板","resourceId":tool.id,"actionId":"query","parameters":{"query":"数学","count":3},"binding":"DO-NOT-EXPORT-CREDENTIAL"});
    db.execute("INSERT INTO invocation_templates(id,resource_id,action_id,revision,payload) VALUES('template',?1,'query',1,?2)",params![tool.id,template.to_string()]).unwrap();
    m.relation_store(crate::resource_relations::StoreRequest::Add {
        dependent: crate::resource_relations::Endpoint {
            kind: "skill".into(),
            id: "skill".into(),
        },
        dependency: crate::resource_relations::Endpoint {
            kind: "tool".into(),
            id: tool.id,
        },
        expected_revision: 0,
    })
    .unwrap();
    m
}

fn set_count_parameter_policy(m: &mut Manager, allowed: bool, sensitive: bool) {
    let resources = m
        .resource_store(crate::resources::StoreRequest::List)
        .unwrap();
    let mut record: ResourceRecord =
        serde_json::from_value(resources["resources"][0].clone()).unwrap();
    let previous = record.revision;
    record.actions = vec![json!({
        "id":"query", "label":"查询", "mode":"task",
        "executable":Path::new(&record.root_path).join("never-executed.exe"),
        "workingDirectory":record.root_path, "args":[],
        "parameters":[
            {"name":"query","label":"查询","kind":"text","templateAllowed":true},
            {"name":"count","label":"数量","kind":"integer","templateAllowed":allowed,"sensitive":sensitive}
        ]
    })];
    record.revision += 1;
    m.resource_store(crate::resources::StoreRequest::Replace {
        record: Box::new(record),
        expected_revision: previous,
    })
    .unwrap();
}

#[test]
fn export_does_not_transport_or_activate_native_automatic_update_permission() {
    let root = fixture();
    let mut m = populated(root.path());
    let listed = m
        .resource_store(crate::resources::StoreRequest::List)
        .unwrap();
    let mut record: ResourceRecord =
        serde_json::from_value(listed["resources"][0].clone()).unwrap();
    let revision = record.revision;
    record.update_policy = json!({"mode":"automatic","intervalHours":24,"pinnedVersion":"v1.0.0","skippedVersions":["v0.9.0"]});
    record.revision += 1;
    m.resource_store(crate::resources::StoreRequest::Replace {
        record: Box::new(record.clone()),
        expected_revision: revision,
    })
    .unwrap();
    let exported = document(&mut m);
    let item = exported
        .items
        .iter()
        .find(|item| item.kind == "tool" && item.id == record.id)
        .unwrap();
    assert_eq!(item.data["updatePolicy"]["mode"], "manual");
    assert_eq!(item.data["updatePolicy"]["pinnedVersion"], "v1.0.0");
    assert_eq!(
        item.data["updatePolicy"]["skippedVersions"],
        json!(["v0.9.0"])
    );
    let current = m
        .resource_store(crate::resources::StoreRequest::Get(record.id))
        .unwrap();
    assert_eq!(current["updatePolicy"]["mode"], "automatic");
    validate(&exported).unwrap();
}

#[test]
fn export_requires_local_preview_and_keeps_credentials_grants_and_existing_files_out() {
    let root = fixture();
    let mut m = populated(root.path());
    let before = m.state.clone();
    let p = local(&mut m, json!({"action":"preview_configuration_export"})).unwrap();
    let exported = p["document"].to_string();
    for excluded in [
        "DO-NOT-EXPORT-CREDENTIAL",
        "baselineHashes",
        "installedCommit",
        "runtimeConfirmed",
        "executable",
        "binding",
    ] {
        assert!(!exported.contains(excluded), "leaked {excluded}");
    }
    assert!(exported.contains("个人备注"));
    assert!(exported.contains("\"count\":3"));
    let path = root.path().join("portable.json");
    assert!(!path.exists());
    let request = json!({"action":"export_configuration","previewId":p["previewId"],"path":path});
    assert!(crate::dispatch(&mut m, &request).is_err());
    assert!(local(&mut m,json!({"action":"export_configuration","previewId":p["previewId"],"path":path,"confirmed":true})).is_err());
    local(&mut m, request.clone()).unwrap();
    assert_eq!(
        read_file(&path).unwrap().0.items.len(),
        p["document"]["items"].as_array().unwrap().len()
    );
    assert!(local(&mut m, request).is_err());
    let p = local(&mut m, json!({"action":"preview_configuration_export"})).unwrap();
    let bytes = fs::read(&path).unwrap();
    assert!(local(
        &mut m,
        json!({"action":"export_configuration","previewId":p["previewId"],"path":path})
    )
    .is_err());
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert!(m.state == before);
}

#[test]
fn configuration_export_rejects_parameters_disallowed_by_the_current_action() {
    for (allowed, sensitive) in [(true, true), (false, false)] {
        let root = fixture();
        let mut m = populated(root.path());
        set_count_parameter_policy(&mut m, true, false);
        assert!(document(&mut m)
            .items
            .iter()
            .any(|item| item.kind == "template"));
        set_count_parameter_policy(&mut m, allowed, sensitive);
        let before = m.snapshot();
        let history = (m.management_undo.clone(), m.management_redo.clone());
        let error = local(&mut m, json!({"action":"preview_configuration_export"})).unwrap_err();
        assert!(error.contains("参数 count 不允许随配置保存"), "{error}");
        assert_eq!(m.snapshot(), before);
        assert_eq!(
            (m.management_undo.clone(), m.management_redo.clone()),
            history
        );

        // An unavailable action still preserves its non-sensitive, inactive template.
        let resources = m
            .resource_store(crate::resources::StoreRequest::List)
            .unwrap();
        let mut record: ResourceRecord =
            serde_json::from_value(resources["resources"][0].clone()).unwrap();
        let previous = record.revision;
        record.actions.clear();
        record.revision += 1;
        m.resource_store(crate::resources::StoreRequest::Replace {
            record: Box::new(record),
            expected_revision: previous,
        })
        .unwrap();
        assert_eq!(
            document(&mut m)
                .items
                .iter()
                .find(|item| item.kind == "template")
                .unwrap()
                .data["parameters"]["count"],
            3
        );
    }
}

#[test]
fn disallowed_template_import_rolls_back_related_records_and_twenty_step_history() {
    for (allowed, sensitive) in [(true, true), (false, false)] {
        let root = fixture();
        let mut m = populated(root.path());
        let mut incoming = document(&mut m);
        incoming.items.retain(|item| {
            matches!(
                item.kind.as_str(),
                "settings" | "category" | "source" | "scene" | "template"
            )
        });
        for item in &mut incoming.items {
            match item.kind.as_str() {
                "settings" => item.data["uiTheme"] = json!("dark"),
                "category" | "scene" => item.data["name"] = json!("必须整体回滚"),
                "source" => item.data["roots"] = json!(["skills", "extra"]),
                _ => {}
            }
        }
        // Reach the template after writes to the other selected management tables.
        incoming.items.sort_by_key(|item| item.kind == "template");
        let db = Connection::open(m.data_dir.join("manager.sqlite3")).unwrap();
        db.execute("DELETE FROM invocation_templates", []).unwrap();
        set_count_parameter_policy(&mut m, allowed, sensitive);
        for index in 0..25 {
            local(
                &mut m,
                json!({"action":"set_favorite","skillId":"skill","favorite":index % 2 != 0}),
            )
            .unwrap();
        }
        for _ in 0..7 {
            local(&mut m, json!({"action":"undo_management"})).unwrap();
        }
        let history = (m.management_undo.clone(), m.management_redo.clone());
        assert_eq!((history.0.len(), history.1.len()), (13, 7));
        let portable_before = serde_json::to_value(document(&mut m)).unwrap();
        let preview = write_preview(&mut m, root.path(), &incoming);
        let before = m.snapshot();
        let events = Arc::new(Mutex::new(vec![]));
        let sink = events.clone();
        m.set_state_events(Arc::new(move |revision| {
            sink.lock().unwrap().push(revision)
        }));
        let error = apply_preview(&mut m, &preview).unwrap_err();
        assert!(error.contains("参数 count 不允许随配置保存"), "{error}");
        assert_eq!(m.snapshot(), before);
        assert_eq!(
            (m.management_undo.clone(), m.management_redo.clone()),
            history
        );
        assert!(events.lock().unwrap().is_empty());
        assert!(m
            .previews
            .contains_key(preview["previewId"].as_str().unwrap()));
        assert_eq!(
            serde_json::to_value(document(&mut m)).unwrap(),
            portable_before
        );
        let mut reopened = manager(root.path());
        assert_eq!(
            serde_json::to_value(document(&mut reopened)).unwrap(),
            portable_before
        );
    }
}

#[test]
fn all_management_groups_import_together_without_ownership_execution_or_deletion() {
    let source = fixture();
    let mut a = populated(source.path());
    let doc = document(&mut a);
    let target = fixture();
    let mut b = manager(target.path());
    b.state.skills.push(json!({"id":"keep","name":"Keep","localPath":target.path().join("missing"),"favorite":false}));
    b.state.settings["futurePreference"] = json!("keep");
    b.state.settings["categories"] = json!([{"id":"existing","name":"Keep"}]);
    b.save().unwrap();
    let p = write_preview(&mut b, target.path(), &doc);
    assert!(p["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["status"] == "conflict"));
    let result = apply_preview(&mut b, &p).unwrap();
    assert!(result["applied"].as_u64().unwrap() > 10);
    assert_eq!(b.state.settings["uiTheme"], "eye");
    assert_eq!(b.state.settings["futurePreference"], "keep");
    assert!(b.state.skills.iter().any(|s| s["id"] == "keep"));
    assert_eq!(b.skill("skill").unwrap()["managed"], false);
    assert_eq!(b.skill("skill").unwrap()["enabled"], false);
    assert!(b.state.connections.is_empty());
    assert_eq!(b.state.local_roots[0]["enabled"], false);
    let tools = b
        .resource_store(crate::resources::StoreRequest::List)
        .unwrap();
    let tool = &tools["resources"][0];
    assert_eq!(tool["actions"], json!([]));
    assert!(tool["installation"].is_null());
    assert_eq!(tool["enabled"], false);
    assert_eq!(tool["ownership"], "external");
    let restored = document(&mut b);
    for kind in [
        "category",
        "source",
        "skill",
        "tool",
        "root",
        "ignoredPaths",
        "annotation",
        "view",
        "template",
        "scene",
        "relation",
    ] {
        assert!(
            restored.items.iter().any(|i| i.kind == kind),
            "missing {kind}"
        );
    }
    assert_eq!(
        restored
            .items
            .iter()
            .find(|i| i.kind == "template")
            .unwrap()
            .data["parameters"]["count"],
        3
    );
    let saved = serde_json::to_value(&restored).unwrap();
    drop(b);
    let mut restarted = manager(target.path());
    assert_eq!(
        serde_json::to_value(document(&mut restarted)).unwrap(),
        saved
    );
    assert!(source.path().join("skill/SKILL.md").exists());
    assert!(!target.path().join("missing").exists());
}

#[test]
fn transaction_failure_rolls_back_every_table_memory_revision_and_notification() {
    let root = fixture();
    let mut m = manager(root.path());
    m.save().unwrap();
    local(
        &mut m,
        json!({"action":"create_category","name":"撤销测试"}),
    )
    .unwrap();
    local(&mut m, json!({"action":"undo_management"})).unwrap();
    let history_before = (m.management_undo.clone(), m.management_redo.clone());
    assert!(!history_before.1.is_empty());
    let doc = Document {
        format: "agent-resource-manager-config".into(),
        format_version: 1,
        items: vec![
            Item {
                kind: "settings".into(),
                id: "preferences".into(),
                data: json!({"uiTheme":"dark"}),
            },
            Item {
                kind: "category".into(),
                id: "cat".into(),
                data: json!({"id":"cat","name":"New"}),
            },
            Item {
                kind: "view".into(),
                id: "view".into(),
                data: json!({"id":"view","name":"New","view":"tools","filters":{"kind":"","query":""}}),
            },
        ],
    };
    let p = write_preview(&mut m, root.path(), &doc);
    let before = m.snapshot();
    let events = Arc::new(Mutex::new(vec![]));
    let sink = events.clone();
    m.set_state_events(Arc::new(move |r| sink.lock().unwrap().push(r)));
    let db = Connection::open(m.data_dir.join("manager.sqlite3")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_configuration BEFORE INSERT ON saved_views BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END;").unwrap();
    assert!(apply_preview(&mut m, &p)
        .unwrap_err()
        .contains("synthetic disk failure"));
    assert_eq!(m.snapshot(), before);
    assert_eq!(
        (m.management_undo.clone(), m.management_redo.clone()),
        history_before
    );
    assert!(events.lock().unwrap().is_empty());
    let mut reopened = manager(root.path());
    assert_eq!(document(&mut reopened).items.len(), 2);
    assert_eq!(reopened.state.settings["uiTheme"], "light");
    db.execute_batch("DROP TRIGGER fail_configuration").unwrap();
    apply_preview(&mut m, &p).unwrap();
    assert_eq!(events.lock().unwrap().len(), 1);
    assert_eq!(m.state.settings["uiTheme"], "dark");
}

fn select_only(m: &mut Manager, p: &Value, selected: &[&str]) -> Result<Value, String> {
    local(
        m,
        json!({"action":"apply_configuration_import","previewId":p["previewId"],"selected":selected}),
    )
}

fn preview_row<'a>(p: &'a Value, key: &str) -> &'a Value {
    p["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["key"] == key)
        .unwrap()
}

#[test]
fn partial_selection_keeps_exact_source_and_category_references_or_rejects_before_writing() {
    let source = fixture();
    let mut a = populated(source.path());
    let doc = document(&mut a);
    let target = fixture();
    let mut b = manager(target.path());
    let p = write_preview(&mut b, target.path(), &doc);
    let row = preview_row(&p, "skill:skill");
    assert_eq!(row["status"], "new");
    assert_eq!(
        row["references"],
        json!([
            {"key":"category:cat","kind":"category","id":"cat","status":"incoming"},
            {"key":"source:source","kind":"source","id":"source","status":"incoming"}
        ])
    );
    let before = b.snapshot();
    let error = select_only(&mut b, &p, &["skill:skill"]).unwrap_err();
    assert!(error.contains("需要关联"));
    assert_eq!(b.snapshot(), before);
    assert!(b.state.sources.is_empty());
    // The rejected subset does not consume the preview or silently drop IDs.
    select_only(
        &mut b,
        &p,
        &["skill:skill", "source:source", "category:cat"],
    )
    .unwrap();
    let skill = b.skill("skill").unwrap();
    assert_eq!(skill["sourceId"], "source");
    assert_eq!(skill["categoryId"], "cat");
    assert_eq!(skill["remotePath"], "skills/test");
    assert_eq!(skill["branch"], "main");
    assert_eq!(skill["enabled"], false);
    assert!(skill["installedCommit"].is_null());
}

#[test]
fn readded_relation_blocks_the_old_exported_identity_before_import_without_changing_local_data() {
    let root = fixture();
    let mut m = populated(root.path());
    let doc = document(&mut m);
    let exported = doc
        .items
        .iter()
        .find(|item| item.kind == "relation")
        .unwrap();
    let endpoint = exported.data["dependent"].clone();
    let listed = local(
        &mut m,
        json!({"action":"resource_relations","endpoint":endpoint}),
    )
    .unwrap();
    let removed = local(
        &mut m,
        json!({"action":"resource_relation_remove","id":exported.id,"expectedRevision":listed["revision"]}),
    )
    .unwrap();
    let readded = local(
        &mut m,
        json!({"action":"resource_relation_add","dependent":endpoint,"dependency":exported.data["dependency"],"expectedRevision":removed["revision"]}),
    )
    .unwrap();
    assert_eq!(readded["dependencies"].as_array().unwrap().len(), 1);
    assert_ne!(readded["dependencies"][0]["id"], exported.id);
    local(
        &mut m,
        json!({"action":"set_settings","settings":{"uiTheme":"light"}}),
    )
    .unwrap();
    local(
        &mut m,
        json!({"action":"create_category","name":"保留撤销分支"}),
    )
    .unwrap();
    local(&mut m, json!({"action":"undo_management"})).unwrap();
    let history_before = (m.management_undo.clone(), m.management_redo.clone());
    assert!(!history_before.1.is_empty());
    let events = Arc::new(Mutex::new(vec![]));
    let sink = events.clone();
    m.set_state_events(Arc::new(move |revision| {
        sink.lock().unwrap().push(revision)
    }));
    let p = write_preview(&mut m, root.path(), &doc);
    let relation_key = exported.key();
    let row = preview_row(&p, &relation_key);
    assert_eq!(row["status"], "blocked");
    assert!(row["reason"].as_str().unwrap().contains("保留本机关系"));
    assert_eq!(
        preview_row(&p, "settings:preferences")["status"],
        "conflict"
    );
    let before = m.snapshot();
    let document_before = serde_json::to_value(document(&mut m)).unwrap();
    let error =
        select_only(&mut m, &p, &["settings:preferences", relation_key.as_str()]).unwrap_err();
    assert!(error.contains("请选择预览中可导入的项目"));
    assert!(!error.contains("UNIQUE"));
    assert_eq!(m.snapshot(), before);
    assert_eq!(
        serde_json::to_value(document(&mut m)).unwrap(),
        document_before
    );
    assert_eq!(
        (m.management_undo.clone(), m.management_redo.clone()),
        history_before
    );
    assert!(events.lock().unwrap().is_empty());
    let imported = select_only(&mut m, &p, &["settings:preferences"]).unwrap();
    assert_eq!(imported["applied"], 1);
    assert_eq!(m.state.settings["uiTheme"], "eye");
    assert_eq!(events.lock().unwrap().len(), 1);
    assert_eq!(
        local(
            &mut m,
            json!({"action":"resource_relations","endpoint":endpoint}),
        )
        .unwrap(),
        readded
    );
}

#[test]
fn relation_preview_matches_typed_directional_endpoints_and_blocks_duplicate_import_identities() {
    let relation = |id: &str, dependent: Value, dependency: Value| Item {
        kind: "relation".into(),
        id: id.into(),
        data: json!({"id":id,"dependent":dependent,"dependency":dependency}),
    };
    let dependent = json!({"kind":"skill","id":"one"});
    let dependency = json!({"kind":"tool","id":"two"});
    let old = relation("existing", dependent.clone(), dependency.clone());
    let local = Document {
        format: "agent-resource-manager-config".into(),
        format_version: 1,
        items: vec![old.clone()],
    };
    let different_id = relation("imported", dependent.clone(), dependency.clone());
    assert!(relation_conflict(&different_id, &local, &local).is_some());
    assert!(relation_conflict(&old, &local, &local).is_none());
    let reverse = relation("reverse", dependency.clone(), dependent.clone());
    assert!(relation_conflict(&reverse, &local, &local).is_none());
    let different_kind = relation(
        "different-kind",
        json!({"kind":"tool","id":"one"}),
        dependency,
    );
    assert!(relation_conflict(&different_kind, &local, &local).is_none());
    let incoming = Document {
        items: vec![old.clone(), different_id.clone()],
        ..local.clone()
    };
    let empty = Document {
        items: vec![],
        ..local
    };
    for item in [&old, &different_id] {
        assert!(relation_conflict(item, &empty, &incoming)
            .unwrap()
            .contains("多个标识"));
    }
}

#[test]
fn unresolved_and_same_name_different_identity_are_never_guessed_as_the_reference() {
    let source = fixture();
    let mut a = populated(source.path());
    let mut doc = document(&mut a);
    doc.items.retain(|item| item.kind != "source");
    let target = fixture();
    let mut b = manager(target.path());
    b.state.sources.push(json!({"id":"other-source","kind":"github","repo":"example/skills","branch":"main","roots":[],"ignoredPaths":[]}));
    b.save().unwrap();
    let p = write_preview(&mut b, target.path(), &doc);
    let row = preview_row(&p, "skill:skill");
    assert_eq!(row["status"], "blocked");
    assert!(row["references"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["key"] == "source:source" && r["status"] == "unresolved"));
    let before = b.snapshot();
    assert!(select_only(&mut b, &p, &["skill:skill"]).is_err());
    assert_eq!(b.snapshot(), before);
    assert!(b.state.skills.is_empty());
}

#[test]
fn skill_source_identity_must_match_the_repository_and_branch_that_will_remain() {
    let source = fixture();
    let mut a = populated(source.path());
    let mut doc = document(&mut a);
    let target = fixture();
    let mut b = manager(target.path());
    for (field, value) in [("repo", "another/skills"), ("branch", "another-branch")] {
        let skill = doc
            .items
            .iter_mut()
            .find(|item| item.kind == "skill")
            .unwrap();
        skill.data[field] = json!(value);
        let p = write_preview(&mut b, target.path(), &doc);
        assert_eq!(preview_row(&p, "skill:skill")["status"], "blocked");
        assert!(preview_row(&p, "skill:skill")["reason"]
            .as_str()
            .unwrap()
            .contains("所指来源身份"));
        assert!(select_only(
            &mut b,
            &p,
            &["skill:skill", "source:source", "category:cat"]
        )
        .is_err());
        let skill = doc
            .items
            .iter_mut()
            .find(|item| item.kind == "skill")
            .unwrap();
        skill.data[field] = if field == "repo" {
            json!("example/skills")
        } else {
            json!("main")
        };
    }
    assert!(b.state.skills.is_empty());
}

#[test]
fn tool_source_asset_roundtrip_preserves_mapping_but_never_imports_verification_or_ownership() {
    let source = fixture();
    let mut a = populated(source.path());
    let listed = a
        .resource_store(crate::resources::StoreRequest::List)
        .unwrap();
    let mut tool: ResourceRecord = serde_json::from_value(listed["resources"][0].clone()).unwrap();
    let old_revision = tool.revision;
    let asset = json!({"releaseId":10,"assetId":20,"tag":"v1","assetName":"tool.zip","size":125,"digest":format!("sha256:{}", "a".repeat(64)),"url":"https://github.com/example/tool/releases/download/v1/tool.zip","updatedAt":"fixed"});
    tool.source_binding = Some(serde_json::from_value(json!({"repository":"https://github.com/example/tool","repositoryId":9,"asset":asset,"verifiedAt":"2026-10-30T01:00:00Z"})).unwrap());
    tool.revision += 1;
    a.resource_store(crate::resources::StoreRequest::Replace {
        record: Box::new(tool.clone()),
        expected_revision: old_revision,
    })
    .unwrap();
    let mut doc = document(&mut a);
    let exported_binding =
        doc.items.iter().find(|i| i.kind == "tool").unwrap().data["sourceBinding"].clone();
    assert!(exported_binding.get("verifiedAt").is_none());
    assert_eq!(exported_binding["asset"], asset);
    // Imported order is irrelevant to stable identities and associations.
    doc.items.reverse();
    let target = fixture();
    let mut b = manager(target.path());
    let p = write_preview(&mut b, target.path(), &doc);
    apply_preview(&mut b, &p).unwrap();
    let restored: ResourceRecord = serde_json::from_value(
        b.resource_store(crate::resources::StoreRequest::Get(tool.id))
            .unwrap(),
    )
    .unwrap();
    let binding = restored.source_binding.as_ref().unwrap();
    assert_eq!(binding.repository_id, 9);
    assert!(binding.verified_at.is_empty());
    assert_eq!(
        serde_json::to_value(binding.asset.as_ref().unwrap()).unwrap(),
        asset
    );
    assert!(restored.installation.is_none());
    assert!(restored.capabilities.is_empty());
    assert!(restored.actions.is_empty());
    assert!(!restored.enabled);
    assert_eq!(restored.update_policy["mode"], "manual");
    let exported_again = document(&mut b);
    assert_eq!(
        exported_again
            .items
            .iter()
            .find(|i| i.kind == "tool")
            .unwrap()
            .data["sourceBinding"],
        exported_binding
    );
}

#[test]
fn malformed_source_assets_and_command_permissions_cannot_enter_portable_data() {
    let source = fixture();
    let mut m = populated(source.path());
    let doc = document(&mut m);
    for address in [
        "https://github.com/another/tool/releases/download/v1/tool.zip",
        "https://user:secret@github.com/example/tool/releases/download/v1/tool.zip",
        "https://github.com/example/tool/releases/download/v1/tool.zip?token=secret",
    ] {
        let mut invalid = doc.clone();
        invalid
            .items
            .iter_mut()
            .find(|i| i.kind == "tool")
            .unwrap()
            .data["sourceBinding"] = json!({"repository":"https://github.com/example/tool","repositoryId":9,"asset":{"releaseId":1,"assetId":2,"tag":"v1","assetName":"tool.zip","size":1,"digest":null,"url":address,"updatedAt":"fixed"}});
        assert!(validate(&invalid).is_err());
    }
    for field in ["verifiedAt", "commands", "actions", "installation"] {
        let mut invalid = doc.clone();
        invalid
            .items
            .iter_mut()
            .find(|i| i.kind == "tool")
            .unwrap()
            .data[field] = json!(true);
        assert!(validate(&invalid).is_err());
    }
    let mut invalid = doc;
    invalid
        .items
        .iter_mut()
        .find(|i| i.kind == "tool")
        .unwrap()
        .data["updatePolicy"]["mode"] = json!("automatic");
    assert!(validate(&invalid).is_err());
}

#[test]
fn changed_file_and_changed_live_state_invalidate_preview_without_writing() {
    let root = fixture();
    let mut m = manager(root.path());
    let mut doc = document(&mut m);
    doc.items[0].data["uiTheme"] = json!("dark");
    let p = write_preview(&mut m, root.path(), &doc);
    let before = m.snapshot();
    fs::write(p["path"].as_str().unwrap(), b"{}").unwrap();
    assert!(apply_preview(&mut m, &p).is_err());
    assert_eq!(m.snapshot(), before);
    let p = write_preview(&mut m, root.path(), &doc);
    m.state.settings["uiZoom"] = json!(120);
    m.save().unwrap();
    let before = m.snapshot();
    assert!(apply_preview(&mut m, &p)
        .unwrap_err()
        .contains("管理信息已变化"));
    assert_eq!(m.snapshot(), before);
    let p = write_preview(&mut m, root.path(), &doc);
    assert!(local(&mut m,json!({"action":"apply_configuration_import","previewId":p["previewId"],"selected":["forged:any"]})).is_err());
    assert_eq!(m.snapshot(), before);
}

#[test]
fn binding_conflicts_remain_visible_and_cannot_retarget_installed_records() {
    let root = fixture();
    let mut m = populated(root.path());
    let mut doc = document(&mut m);
    let skill = doc.items.iter_mut().find(|i| i.kind == "skill").unwrap();
    skill.data["localPath"] = json!(root.path().join("other"));
    let p = write_preview(&mut m, root.path(), &doc);
    let row = p["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["key"] == "skill:skill")
        .unwrap();
    assert_eq!(row["status"], "blocked");
    assert!(row["current"]["localPath"] != row["incoming"]["localPath"]);
    let before = m.snapshot();
    assert!(local(&mut m,json!({"action":"apply_configuration_import","previewId":p["previewId"],"selected":["skill:skill"]})).is_err());
    assert_eq!(m.snapshot(), before);
    let mut doc = document(&mut m);
    doc.items
        .iter_mut()
        .find(|i| i.kind == "skill")
        .unwrap()
        .data["runtimeFiles"] = json!(["SKILL.md", "new.py"]);
    let p = write_preview(&mut m, root.path(), &doc);
    apply_preview(&mut m, &p).unwrap();
    assert_eq!(m.skill("skill").unwrap()["runtimeConfirmed"], false);
    assert_eq!(
        m.skill("skill").unwrap()["baselineHashes"]["SKILL.md"],
        "original"
    );
}

#[test]
fn unsupported_formats_sensitive_fields_and_basic_mode_do_not_import() {
    let root = fixture();
    let mut m = manager(root.path());
    m.save().unwrap();
    let before = m.snapshot();
    let mut doc = document(&mut m);
    doc.format_version = 99;
    assert!(validate(&doc).is_err());
    doc.format_version = 1;
    doc.items[0].data["token"] = json!("bad");
    assert!(validate(&doc).is_err());
    doc.items[0].data =
        json!({"network":{"mode":"manual","proxyUrl":"https://user:password@example.invalid"}});
    assert!(validate(&doc).is_err());
    doc.items[0].data = json!({"uiZoom":0});
    assert!(validate(&doc).is_err());
    let mut basic = Manager::with_storage_mode(m.storage.clone(), true).unwrap();
    assert!(local(&mut basic, json!({"action":"preview_configuration_export"})).is_err());
    assert!(local(
        &mut basic,
        json!({"action":"preview_configuration_import","path":"unused"})
    )
    .is_err());
    assert_eq!(m.snapshot(), before);
}

#[cfg(windows)]
#[test]
fn configuration_read_and_export_reject_directory_junctions() {
    let root = fixture();
    let outside = fixture();
    let link = root.path().join("link");
    junction::create(outside.path(), &link).unwrap();
    let mut m = manager(root.path());
    let doc = document(&mut m);
    fs::write(
        outside.path().join("config.json"),
        serde_json::to_vec(&doc).unwrap(),
    )
    .unwrap();
    assert!(read_file(&link.join("config.json")).is_err());
    let p = local(&mut m, json!({"action":"preview_configuration_export"})).unwrap();
    assert!(local(&mut m,json!({"action":"export_configuration","previewId":p["previewId"],"path":link.join("export.json")})).is_err());
    assert!(!outside.path().join("export.json").exists());
    junction::delete(link).unwrap();
}
