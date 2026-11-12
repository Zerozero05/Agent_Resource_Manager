//! Uses the existing loopback protocol fixture; no real repositories or folders.
use super::*;

const RUNTIME: &[u8] =
    b"---\nname: protocol-skill\ndescription: synthetic\n---\nUse the selected runtime.\n";

fn installed_fixture(old: &Server, next: &Server) -> Fixture {
    let mut fixture = fixture(old);
    let skill = &mut fixture.manager.state.skills[0];
    skill["sourceId"] = json!("source");
    skill["repo"] = json!(old.repo());
    skill["branch"] = json!("main");
    skill["remotePath"] = json!("original/skill");
    skill["commit"] = json!(old.head());
    skill["installedCommit"] = json!(old.head());
    skill["baselineCommit"] = json!(old.head());
    skill["baselineKind"] = json!("installation");
    skill["baselineHashes"] = json!({"SKILL.md":hash(RUNTIME)});
    skill["baselineDocHash"] = json!("old-doc-evidence");
    skill["runtimeFiles"] = json!(["SKILL.md"]);
    skill["runtimeConfirmed"] = json!(true);
    skill["runtimeSources"] = json!({"SKILL.md":"original/skill/SKILL.md"});
    skill["history"] = json!([{"event":"kept-original-history"}]);
    fixture.manager.state.sources.push(
        json!({"id":"next-source","repo":next.repo(),"branch":"main","roots":[],"ignoredPaths":[]}),
    );
    fixture.manager.save().unwrap();
    fixture
}

fn associate_preview(fixture: &mut Fixture) -> Value {
    action(&mut fixture.manager, json!({"action":"preview_associate","skillId":"local-id","sourceId":"next-source","remotePath":"replacement/skill"})).unwrap()
}

fn apply(fixture: &mut Fixture, preview: &Value) -> Result<Value, String> {
    action(
        &mut fixture.manager,
        json!({"action":"apply_associate","previewId":preview["id"]}),
    )
}

fn pair() -> (Server, Server) {
    (
        Server::new(&[
            ("original/skill/SKILL.md", RUNTIME),
            (
                "original/skill/README.md",
                b"# Original installed instructions\n",
            ),
            ("original/skill/guide.md", b"Original pinned guide"),
            ("original/skill/image.png", b"synthetic-old-image"),
        ]),
        Server::new(&[
            ("replacement/skill/SKILL.md", RUNTIME),
            (
                "replacement/skill/README.md",
                b"# Replacement instructions\n",
            ),
        ]),
    )
}

#[test]
fn rebind_preserves_original_installation_documents_navigation_assets_and_local_identity() {
    let (old, next) = pair();
    let mut fixture = installed_fixture(&old, &next);
    let before = fixture.manager.state.clone();
    let original_files = local::files(&fixture.root).unwrap();
    {
        let _transport = old.transport();
        let doc = action(
            &mut fixture.manager,
            json!({"action":"get_document","skillId":"local-id","version":"installed"}),
        )
        .unwrap();
        assert_eq!(doc["markdown"], "# Original installed instructions\n");
        assert_eq!(doc["source"], old.repo());
    }
    let preview = {
        let _transport = next.transport();
        let preview = associate_preview(&mut fixture);
        assert_eq!(fixture.manager.state.skills, before.skills);
        assert_eq!(fixture.manager.state.sources, before.sources);
        assert_eq!(preview["kind"], "associate");
        assert_eq!(preview["previousSource"]["remotePath"], "original/skill");
        assert_eq!(preview["targetSource"]["remotePath"], "replacement/skill");
        assert_eq!(preview["installedProvenance"]["repo"], old.repo());
        assert_eq!(preview["localProtection"]["filesUnchanged"], true);
        assert_eq!(preview["files"], json!([]));
        apply(&mut fixture, &preview).unwrap();
        let current = fixture.manager.skill("local-id").unwrap();
        assert_eq!(current["sourceId"], "next-source");
        assert_eq!(current["installedCommit"], old.head());
        assert_eq!(current["installedProvenance"]["repo"], old.repo());
        assert_eq!(
            current["installedProvenance"]["runtimeSources"],
            before.skills[0]["runtimeSources"]
        );
        assert_eq!(current["baselineCommit"], Value::Null);
        assert_eq!(current["baselineHashes"], json!({}));
        assert_eq!(current["runtimeSources"], json!({}));
        assert_eq!(current["status"], "unknown_baseline");
        assert_eq!(current["comparisonPending"], true);
        assert_eq!(
            current["sourceVerification"]["invocationStatus"],
            "not_verified"
        );
        for field in [
            "id",
            "localPath",
            "history",
            "runtimeFiles",
            "favorite",
            "categoryId",
        ] {
            assert_eq!(current[field], before.skills[0][field], "{field}");
        }
        assert!(apply(&mut fixture, &preview)
            .unwrap_err()
            .contains("already used"));
        let latest = action(
            &mut fixture.manager,
            json!({"action":"get_document","skillId":"local-id","version":"latest"}),
        )
        .unwrap();
        assert_eq!(latest["markdown"], "# Replacement instructions\n");
        preview
    };
    assert_eq!(local::files(&fixture.root).unwrap(), original_files);
    // Removing the old catalogue source cannot break the independent receipt.
    fixture
        .manager
        .state
        .sources
        .retain(|source| source["id"] != "source");
    fixture.manager.save().unwrap();
    fixture.manager = Manager::new(fixture.manager.data_dir.clone()).unwrap();
    {
        let _transport = old.transport();
        let doc = action(
            &mut fixture.manager,
            json!({"action":"get_document","skillId":"local-id","version":"installed"}),
        )
        .unwrap();
        assert_eq!(doc["documentPath"], "original/skill/README.md");
        assert_eq!(doc["source"], old.repo());
        assert!(doc["baseUrl"].as_str().unwrap().contains(&format!(
            "/{}/blob/{}/original/skill/README.md",
            old.repo(),
            old.head()
        )));
        let guide = action(&mut fixture.manager, json!({"action":"get_document","skillId":"local-id","version":"installed","remoteCommit":doc["commit"],"path":"original/skill/guide.md"})).unwrap();
        assert_eq!(guide["markdown"], "Original pinned guide");
        let image = action(&mut fixture.manager, json!({"action":"get_doc_asset","skillId":"local-id","version":"installed","remoteCommit":doc["commit"],"path":"original/skill/image.png"})).unwrap();
        assert_eq!(
            image["dataUrl"],
            format!(
                "data:image/png;base64,{}",
                STANDARD.encode(b"synthetic-old-image")
            )
        );
        let file = action(&mut fixture.manager, json!({"action":"read_file","source":"github","skillId":"local-id","version":"installed","remoteCommit":doc["commit"],"path":"SKILL.md"})).unwrap();
        assert_eq!(file["repositoryPath"], "original/skill/SKILL.md");
        assert_eq!(file["content"], std::str::from_utf8(RUNTIME).unwrap());
        assert!(apply(&mut fixture, &preview).is_err());
    }
    for server in [&old, &next] {
        assert!(server
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .all(|request| request.method == "GET"));
        server.assert_clean();
    }
}

#[test]
fn rebind_rejects_changed_target_commit_skill_or_source_and_consumes_failed_preview() {
    for changed in [
        "branch",
        "skill",
        "source",
        "missing-source",
        "missing-skill",
    ] {
        let (old, next) = pair();
        let _transport = next.transport();
        let mut fixture = installed_fixture(&old, &next);
        let preview = associate_preview(&mut fixture);
        match changed {
            "branch" => next.advance(Some(("replacement/skill/SKILL.md", b"changed runtime"))),
            "skill" => fixture.manager.state.skills[0]["history"] = json!(["concurrent edit"]),
            "source" => fixture.manager.state.sources[1]["roots"] = json!(["new-scope"]),
            "missing-source" => {
                fixture.manager.state.sources.pop();
            }
            "missing-skill" => fixture.manager.state.skills.clear(),
            _ => unreachable!(),
        }
        let expected = serde_json::to_value(&fixture.manager.state).unwrap();
        let files = local::files(&fixture.root).unwrap();
        assert!(apply(&mut fixture, &preview).is_err(), "{changed}");
        assert_eq!(
            serde_json::to_value(&fixture.manager.state).unwrap(),
            expected,
            "{changed}"
        );
        assert_eq!(local::files(&fixture.root).unwrap(), files);
        assert!(apply(&mut fixture, &preview)
            .unwrap_err()
            .contains("already used"));
        next.assert_clean();
    }
}

#[test]
fn rebind_live_guard_rechecks_new_placeholder_connections_and_configuration() {
    let (old, next) = pair();
    let _transport = next.transport();
    let mut fixture = installed_fixture(&old, &next);
    fixture.manager.state.skills.push(json!({"id":"remote-placeholder","sourceId":"next-source","remotePath":"replacement/skill","localPath":null}));
    let preview = associate_preview(&mut fixture);
    let internal = fixture.manager.previews[preview["id"].as_str().unwrap()].clone();
    association_guard(&fixture.manager.state, &internal).unwrap();
    fixture
        .manager
        .state
        .connections
        .push(json!({"id":"new-link","skillId":"remote-placeholder"}));
    assert!(association_guard(&fixture.manager.state, &internal).is_err());
    assert!(apply(&mut fixture, &preview).is_err());
    assert!(fixture
        .manager
        .state
        .skills
        .iter()
        .any(|s| s["id"] == "remote-placeholder"));
    let next_preview = associate_preview(&mut fixture);
    assert_eq!(next_preview["canApply"], false);
}

#[test]
fn rebind_failed_durable_save_restores_state_and_does_not_reuse_confirmation() {
    let (old, next) = pair();
    let _transport = next.transport();
    let mut fixture = installed_fixture(&old, &next);
    let preview = associate_preview(&mut fixture);
    let before = serde_json::to_value(&fixture.manager.state).unwrap();
    let files = local::files(&fixture.root).unwrap();
    let db = rusqlite::Connection::open(fixture.manager.data_dir.join("manager.sqlite3")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_rebind_save BEFORE UPDATE ON app_state BEGIN SELECT RAISE(ABORT, 'synthetic save rejected'); END;").unwrap();
    let error = apply(&mut fixture, &preview).unwrap_err();
    assert!(error.contains("synthetic save rejected"), "{error}");
    assert_eq!(
        serde_json::to_value(&fixture.manager.state).unwrap(),
        before
    );
    assert_eq!(local::files(&fixture.root).unwrap(), files);
    assert!(apply(&mut fixture, &preview)
        .unwrap_err()
        .contains("already used"));
    let persisted: String = db
        .query_row("SELECT payload FROM app_state WHERE id=1", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&persisted).unwrap()["skills"],
        before["skills"]
    );
    db.execute_batch("DROP TRIGGER fail_rebind_save").unwrap();
    let retry = associate_preview(&mut fixture);
    apply(&mut fixture, &retry).unwrap();
}

#[test]
fn rebind_requires_preview_and_rejects_request_supplied_permission_flags() {
    let (old, next) = pair();
    let _transport = next.transport();
    let mut fixture = installed_fixture(&old, &next);
    assert!(action(&mut fixture.manager, json!({"action":"associate","skillId":"local-id","sourceId":"next-source","remotePath":"replacement/skill"})).unwrap_err().contains("preview_associate"));
    assert!(next.state.lock().unwrap().requests.is_empty());
    let preview = associate_preview(&mut fixture);
    for field in ["confirmed", "backupAllowed", "sourceId", "remotePath"] {
        let mut req = json!({"action":"apply_associate","previewId":preview["id"]});
        req[field] = json!(true);
        assert!(action(&mut fixture.manager, req).is_err());
    }
    assert_eq!(
        fixture.manager.skill("local-id").unwrap()["repo"],
        old.repo()
    );
    fixture.manager.basic_mode = true;
    assert!(apply(&mut fixture, &preview).is_err());
    assert!(action(
        &mut fixture.manager,
        json!({"action":"skill_source_health","skillId":"local-id"})
    )
    .is_err());
}

#[test]
fn rebind_unknown_baseline_does_not_create_an_installation_and_new_install_updates_receipt() {
    let (old, next) = pair();
    let _transport = next.transport();
    let mut fixture = installed_fixture(&old, &next);
    fixture.manager.state.skills[0]["installedCommit"] = Value::Null;
    fixture.manager.state.skills[0]["baselineKind"] = json!("comparison");
    let preview = associate_preview(&mut fixture);
    assert_eq!(preview["installedProvenance"], Value::Null);
    apply(&mut fixture, &preview).unwrap();
    assert!(action(
        &mut fixture.manager,
        json!({"action":"get_document","skillId":"local-id","version":"installed"})
    )
    .is_err());
    let install = action(
        &mut fixture.manager,
        json!({"action":"preview_update","skillId":"local-id"}),
    )
    .unwrap();
    assert_eq!(install["canApply"], true);
    action(
        &mut fixture.manager,
        json!({"action":"apply_update","previewId":install["id"]}),
    )
    .unwrap();
    let installed = fixture.manager.skill("local-id").unwrap();
    assert_eq!(installed["installedProvenance"]["repo"], next.repo());
    assert_eq!(
        installed["installedProvenance"]["remotePath"],
        "replacement/skill"
    );
    assert_eq!(installed["installedProvenance"]["commit"], next.head());
    assert_eq!(
        installed["installedProvenance"]["runtimeSources"]["SKILL.md"],
        "replacement/skill/SKILL.md"
    );
    let doc = action(
        &mut fixture.manager,
        json!({"action":"get_document","skillId":"local-id","version":"installed"}),
    )
    .unwrap();
    assert_eq!(doc["markdown"], "# Replacement instructions\n");
    next.assert_clean();
}

#[test]
fn rebind_source_health_reads_the_bound_directory_without_claiming_invocation_or_writing() {
    let (old, next) = pair();
    let _transport = old.transport();
    let mut fixture = installed_fixture(&old, &next);
    let before = serde_json::to_value(&fixture.manager.state).unwrap();
    let result = action(
        &mut fixture.manager,
        json!({"action":"skill_source_health","skillId":"local-id"}),
    )
    .unwrap();
    assert_eq!(result["health"]["status"], "ok");
    assert_eq!(result["source"]["remotePath"], "original/skill");
    assert_eq!(
        serde_json::to_value(&fixture.manager.state).unwrap(),
        before
    );
    fixture.manager.state.skills[0]["remotePath"] = json!("missing/skill");
    let missing = action(
        &mut fixture.manager,
        json!({"action":"skill_source_health","skillId":"local-id"}),
    )
    .unwrap();
    assert_ne!(missing["health"]["status"], "ok");
    assert!(old
        .state
        .lock()
        .unwrap()
        .requests
        .iter()
        .all(|request| request.method == "GET"));
    old.assert_clean();
}

#[test]
fn rebind_automatic_matching_cannot_overwrite_a_detached_fixed_installation() {
    let (old, next) = pair();
    let _transport = next.transport();
    let mut fixture = installed_fixture(&old, &next);
    let skill = &mut fixture.manager.state.skills[0];
    skill["installedProvenance"] = rebinding::installation(skill).unwrap().unwrap();
    skill["sourceId"] = Value::Null;
    skill["baselineCommit"] = Value::Null;
    let original = skill.clone();
    fixture.manager.state.skills.push(json!({"id":"candidate","name":"protocol-skill",
        "sourceId":"next-source","repo":next.repo(),"branch":"main","remotePath":"replacement/skill","localPath":null}));
    let snap = Snapshot::load_fresh(&next.repo(), Some("main")).unwrap();
    auto_associate_with(
        &mut fixture.manager,
        &BTreeMap::from([("next-source".into(), snap)]),
    );
    let retained = fixture.manager.skill("local-id").unwrap();
    for field in [
        "sourceId",
        "repo",
        "remotePath",
        "installedCommit",
        "installedProvenance",
    ] {
        assert_eq!(retained[field], original[field], "{field}");
    }
    assert!(fixture
        .manager
        .state
        .skills
        .iter()
        .any(|skill| skill["id"] == "candidate"));
    next.assert_clean();
}

#[test]
fn rebind_archives_runtime_audit_and_invalidates_automatic_confirmation_only() {
    for kind in ["automatic", "manual"] {
        let (old, next) = pair();
        let _transport = next.transport();
        let mut fixture = installed_fixture(&old, &next);
        let files = local::files(&fixture.root).unwrap();
        let skill = &mut fixture.manager.state.skills[0];
        skill["runtimeConfirmationKind"] = json!(kind);
        crate::audit::refresh_local_audit(skill, Some(&files));
        assert_eq!(skill["runtimeAudit"]["status"], "passed");
        assert_eq!(skill["runtimeAudit"]["canAutoConfirm"], true);
        let before = skill.clone();
        fixture.manager.save().unwrap();
        let preview = associate_preview(&mut fixture);
        apply(&mut fixture, &preview).unwrap();
        let current = fixture.manager.skill("local-id").unwrap();
        let historical = current["sourceHistory"].as_array().unwrap().last().unwrap();
        assert_eq!(historical["runtimeAudit"], before["runtimeAudit"]);
        assert_eq!(historical["runtimeConfirmed"], true);
        assert_eq!(historical["runtimeConfirmationKind"], kind);
        assert_eq!(current["runtimeAudit"]["status"], "needs_review");
        assert_eq!(current["runtimeAudit"]["canAutoConfirm"], false);
        assert_eq!(current["runtimeAudit"]["invocationStatus"], "not_verified");
        assert!(current["runtimeAudit"]["invalidatedAt"].is_string());
        assert!(current["runtimeAudit"]["reason"]
            .as_str()
            .unwrap()
            .contains("来源关联"));
        assert_eq!(current["runtimeConfirmed"], kind == "manual");
        assert_eq!(current["runtimeFiles"], before["runtimeFiles"]);
        assert_eq!(local::files(&fixture.root).unwrap(), files);
        let reopened = Manager::new(fixture.manager.data_dir.clone()).unwrap();
        assert_eq!(
            reopened.skill("local-id").unwrap()["runtimeAudit"],
            current["runtimeAudit"]
        );
        next.assert_clean();
    }
}

#[test]
fn rebind_same_binding_keeps_evidence_when_head_advanced_but_rejects_post_preview_drift() {
    for change in ["unchanged", "before-preview", "after-preview"] {
        let (old, next) = pair();
        let _transport = old.transport();
        let mut fixture = installed_fixture(&old, &next);
        if change == "before-preview" {
            old.advance(Some((
                "original/skill/README.md",
                b"New upstream documentation",
            )));
        }
        let before = serde_json::to_value(&fixture.manager.state).unwrap();
        let files = local::files(&fixture.root).unwrap();
        let preview = action(&mut fixture.manager, json!({"action":"preview_associate","skillId":"local-id","sourceId":"source","remotePath":"original/skill"})).unwrap();
        assert_eq!(preview["canApply"], true);
        if change == "before-preview" {
            assert_ne!(preview["commit"], before["skills"][0]["commit"]);
        }
        if change == "after-preview" {
            old.advance(Some((
                "original/skill/README.md",
                b"Unconfirmed upstream drift",
            )));
            assert!(apply(&mut fixture, &preview)
                .unwrap_err()
                .contains("remote branch changed"));
        } else {
            apply(&mut fixture, &preview).unwrap();
        }
        assert_eq!(
            serde_json::to_value(&fixture.manager.state).unwrap(),
            before,
            "{change}"
        );
        assert_eq!(local::files(&fixture.root).unwrap(), files);
        assert!(apply(&mut fixture, &preview)
            .unwrap_err()
            .contains("already used"));
        old.assert_clean();
    }
}
