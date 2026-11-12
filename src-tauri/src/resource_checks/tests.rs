use super::*;
use crate::resources;
use std::path::Path;

fn at(value: &str) -> DateTime<Utc> {
    timestamp(value).unwrap()
}
fn binding(repo: &str, id: u64) -> SourceBinding {
    SourceBinding {
        repository: repo.into(),
        repository_id: id,
        asset: None,
        verified_at: "2026-10-29T00:00:00Z".into(),
    }
}
fn record(id: &str, repository: &str, repo_id: u64) -> ResourceRecord {
    ResourceRecord {
        id: id.into(),
        name: id.into(),
        kind: "cli".into(),
        root_path: format!("D:/synthetic/resource-check/{id}"),
        repository: Some(repository.into()),
        version: Some("v1".into()),
        source_binding: Some(binding(repository, repo_id)),
        source_history: vec![],
        alias: String::new(),
        notes: String::new(),
        enabled: true,
        ownership: "external".into(),
        management_scope: "register".into(),
        actions: vec![],
        capabilities: vec![],
        update_policy: json!({"mode":"manual","intervalHours":24,"pinnedVersion":null,"skippedVersions":[]}),
        installation: None,
        revision: 1,
        created_at: String::new(),
        updated_at: String::new(),
    }
}
fn release(source: &CheckSource, version: &str) -> ReleaseSummary {
    ReleaseSummary {
        version: version.into(),
        url: format!("{}/releases/tag/{version}", source.repository),
        published_at: Some("2026-10-29T00:00:00Z".into()),
        metadata_hash: None,
    }
}

#[test]
fn package_observation_has_a_distinct_persisted_source_and_registry_link() {
    let mut package = source(
        "https://github.com/microsoft/playwright-mcp",
        &binding("https://github.com/microsoft/playwright-mcp", 10),
    )
    .unwrap();
    let old_key = package.key.clone();
    package.runtime_package = Some(crate::resource_package::Recipe::EdgeMcpNpmV1);
    package.key = package_key(&package).unwrap();
    assert_ne!(package.key, old_key);
    let mut observed = observation(
        package,
        None,
        at("2026-11-01T00:00:00Z"),
        Ok(Some(ReleaseSummary {
            version: "0.0.83".into(),
            url: "https://www.npmjs.com/package/@playwright/mcp/v/0.0.83".into(),
            published_at: None,
            metadata_hash: Some("a".repeat(64)),
        })),
    )
    .unwrap();
    assert!(validate_record(&observed, 0).is_ok());
    observed.latest.as_mut().unwrap().url =
        "https://github.com/microsoft/playwright-mcp/releases/tag/0.0.83".into();
    assert!(validate_record(&observed, 0).is_err());
    observed.latest.as_mut().unwrap().url =
        "https://www.npmjs.com/package/@playwright/mcp/v/0.0.83".into();
    observed.latest.as_mut().unwrap().metadata_hash = None;
    assert!(validate_record(&observed, 0).is_err());
}

#[test]
fn reach_checks_only_the_unique_version_bound_main_wheel() {
    let mut package = source(
        "https://github.com/panniantong/agent-reach",
        &binding("https://github.com/panniantong/agent-reach", 11),
    )
    .unwrap();
    package.runtime_package = Some(crate::resource_package::Recipe::AgentReachWheelV1);
    package.key = package_key(&package).unwrap();
    let mut releases = json!([{"id":20,"tag_name":"v1.6.0","draft":false,"prerelease":false,"published_at":"2026-11-01T00:00:00Z","assets":[{"id":21,"name":"agent_reach-1.6.0-py3-none-any.whl","size":500,"state":"uploaded"}]}]);
    let observed = latest_release(&package, &releases).unwrap().unwrap();
    assert_eq!(observed.version, "v1.6.0");
    assert_eq!(observed.metadata_hash.as_ref().map(String::len), Some(64));
    releases[0]["assets"].as_array_mut().unwrap().push(json!({"id":22,"name":"agent_reach-1.6.0-py3-none-win_amd64.whl","size":600,"state":"uploaded"}));
    assert!(latest_release(&package, &releases).is_err());
    releases[0]["assets"] = json!([{"id":23,"name":"source.zip","size":600,"state":"uploaded"}]);
    assert!(latest_release(&package, &releases).unwrap().is_none());
}
fn target(record: &ResourceRecord) -> CheckTarget {
    CheckTarget {
        id: record.id.clone(),
        revision: record.revision,
        source_key: resource_source(record).unwrap().key,
    }
}
fn db() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    resources::initialize(&db).unwrap();
    initialize(&db).unwrap();
    db
}
fn insert(db: &Connection, value: &ResourceRecord) {
    resources::store(db, ResourceStore::Insert(Box::new(value.clone())), 0).unwrap();
}
fn save(db: &Connection, value: CheckRecord, targets: Vec<CheckTarget>) -> Result<Value, String> {
    let expected_revision = value.revision - 1;
    store(
        db,
        StoreRequest::Save {
            record: Box::new(value),
            expected_revision,
            targets,
        },
    )
}
fn fixture() -> tempfile::TempDir {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("work/resource-check-tests");
    std::fs::create_dir_all(&root).unwrap();
    tempfile::tempdir_in(root).unwrap()
}
fn manager_insert(m: &Manager, value: ResourceRecord) {
    m.resource_store(ResourceStore::Insert(Box::new(value)))
        .unwrap();
}

#[test]
fn source_identity_is_case_normalized_channel_scoped_and_unverified_imports_remain_not_checked() {
    let first = record("one", "https://github.com/Synthetic/Tool", 11);
    let second = record("two", "https://github.com/synthetic/tool", 11);
    assert_eq!(
        resource_source(&first).unwrap(),
        resource_source(&second).unwrap()
    );
    let mut other = second.clone();
    other.source_binding.as_mut().unwrap().repository_id = 12;
    assert_ne!(
        resource_source(&first).unwrap().key,
        resource_source(&other).unwrap().key
    );
    other.source_binding.as_mut().unwrap().verified_at.clear();
    assert!(resource_source(&other).is_err());
    other = second.clone();
    other.source_binding.as_mut().unwrap().repository = "https://github.com/other/tool".into();
    assert!(resource_source(&other).is_err());
    other = second;
    other.kind = "skill".into();
    assert!(resource_source(&other).is_err());
}

#[test]
fn success_expires_after_exactly_24_hours_and_failure_backoff_is_bounded_and_secret_free() {
    let source = resource_source(&record("one", "https://github.com/synthetic/tool", 1)).unwrap();
    let start = at("2026-10-30T00:00:00Z");
    let success = observation(
        source.clone(),
        None,
        start,
        Ok(Some(release(&source, "v2"))),
    )
    .unwrap();
    assert!(!due(
        Some(&success),
        start + Duration::hours(24) - Duration::milliseconds(1)
    )
    .unwrap());
    assert!(due(Some(&success), start + Duration::hours(24)).unwrap());
    assert_eq!(success.failures, 0);
    assert_eq!(success.status, "checked");
    let mut previous = None;
    for (number, minutes) in [
        (1, 15),
        (2, 30),
        (3, 60),
        (4, 120),
        (5, 240),
        (6, 480),
        (7, 960),
        (8, 1440),
        (9, 1440),
    ] {
        let value = observation(
            source.clone(),
            previous.as_ref(),
            start,
            Err("Cannot reach GitHub https://temporary.invalid/?token=never-persist".into()),
        )
        .unwrap();
        assert_eq!(value.failures, number);
        assert_eq!(
            timestamp(&value.next_check_at).unwrap() - start,
            Duration::minutes(minutes)
        );
        assert_eq!(value.status, "network");
        assert!(value.latest.is_none());
        assert!(!serde_json::to_string(&value)
            .unwrap()
            .contains("never-persist"));
        previous = Some(value);
    }
    let recovered = observation(
        source.clone(),
        previous.as_ref(),
        start,
        Ok(Some(release(&source, "v3"))),
    )
    .unwrap();
    assert_eq!(recovered.failures, 0);
    assert_eq!(
        timestamp(&recovered.next_check_at).unwrap() - start,
        Duration::hours(24)
    );
}

#[test]
fn stable_release_selection_excludes_drafts_prereleases_and_does_not_guess_semver_or_download_assets(
) {
    let source = resource_source(&record("one", "https://github.com/synthetic/tool", 1)).unwrap();
    let values = json!([
        {"tag_name":"v99-beta","prerelease":true,"draft":false,"published_at":"2026-10-30T00:00:00Z"},
        {"tag_name":"v500","prerelease":false,"draft":true,"published_at":"2026-10-30T00:00:00Z"},
        {"tag_name":"v20","prerelease":false,"draft":false,"published_at":"2026-10-28T00:00:00Z"},
        {"tag_name":"v2","prerelease":false,"draft":false,"published_at":"2026-10-29T00:00:00Z","assets":[{"browser_download_url":"https://must-not-download.invalid/token"}]}
    ]);
    let latest = latest_release(&source, &values).unwrap().unwrap();
    assert_eq!(latest.version, "v2");
    assert_eq!(
        latest.url,
        "https://github.com/synthetic/tool/releases/tag/v2"
    );
    assert!(latest_release(&source, &json!([])).unwrap().is_none());
    assert!(latest_release(
        &source,
        &json!([{ "tag_name":"bad\nversion","draft":false,"prerelease":false }])
    )
    .is_err());
}

#[test]
fn source_summary_fans_out_once_without_changing_installed_resources_capabilities_or_ownership() {
    let db = db();
    let first = record("one", "https://github.com/synthetic/tool", 1);
    let second = record("two", "https://github.com/synthetic/tool", 1);
    insert(&db, &first);
    insert(&db, &second);
    let before = resources::store(&db, ResourceStore::List, 0).unwrap();
    let source = resource_source(&first).unwrap();
    let checked = observation(
        source.clone(),
        None,
        at("2026-10-30T00:00:00Z"),
        Ok(Some(release(&source, "v2"))),
    )
    .unwrap();
    let value = save(&db, checked, vec![target(&first), target(&second)]).unwrap();
    assert_eq!(value["appliedIds"], json!(["one", "two"]));
    assert_eq!(value["stale"], false);
    assert_eq!(
        resources::store(&db, ResourceStore::List, 0).unwrap(),
        before
    );
    assert_eq!(
        store(&db, StoreRequest::List).unwrap()["checks"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn source_rebind_and_disable_during_fetch_cannot_accept_old_source_success() {
    let db = db();
    let original = record("one", "https://github.com/synthetic/tool", 1);
    insert(&db, &original);
    let source = resource_source(&original).unwrap();
    let result = observation(
        source.clone(),
        None,
        at("2026-10-30T00:00:00Z"),
        Ok(Some(release(&source, "v2"))),
    )
    .unwrap();
    let mut changed = original.clone();
    changed.repository = Some("https://github.com/synthetic/new".into());
    changed.source_binding = Some(binding("https://github.com/synthetic/new", 2));
    changed.revision = 2;
    resources::store(
        &db,
        ResourceStore::Replace {
            record: Box::new(changed.clone()),
            expected_revision: 1,
        },
        0,
    )
    .unwrap();
    assert_eq!(
        save(&db, result.clone(), vec![target(&original)]).unwrap()["stale"],
        true
    );
    assert!(get(&db, &source.key).unwrap().is_none());
    let next_source = resource_source(&changed).unwrap();
    let newer = observation(
        next_source.clone(),
        None,
        at("2026-10-30T00:00:00Z"),
        Ok(Some(release(&next_source, "v3"))),
    )
    .unwrap();
    let mut disabled = changed.clone();
    disabled.revision = 3;
    disabled.enabled = false;
    resources::store(
        &db,
        ResourceStore::Replace {
            record: Box::new(disabled),
            expected_revision: 2,
        },
        0,
    )
    .unwrap();
    assert_eq!(
        save(&db, newer, vec![target(&changed)]).unwrap()["stale"],
        true
    );
    assert!(get(&db, &next_source.key).unwrap().is_none());
}

#[test]
fn one_stale_target_does_not_suppress_unchanged_same_source_target_and_old_check_cas_cannot_overwrite(
) {
    let db = db();
    let first = record("one", "https://github.com/synthetic/tool", 1);
    let second = record("two", "https://github.com/synthetic/tool", 1);
    insert(&db, &first);
    insert(&db, &second);
    let mut changed = first.clone();
    changed.enabled = false;
    changed.revision += 1;
    resources::store(
        &db,
        ResourceStore::Replace {
            record: Box::new(changed),
            expected_revision: 1,
        },
        0,
    )
    .unwrap();
    let source = resource_source(&first).unwrap();
    let value = observation(
        source.clone(),
        None,
        at("2026-10-30T00:00:00Z"),
        Ok(Some(release(&source, "v2"))),
    )
    .unwrap();
    assert_eq!(
        save(&db, value.clone(), vec![target(&first), target(&second)]).unwrap()["appliedIds"],
        json!(["two"])
    );
    assert!(save(&db, value, vec![target(&second)])
        .unwrap_err()
        .contains("旧结果"));
    assert_eq!(
        get(&db, &source.key)
            .unwrap()
            .unwrap()
            .latest
            .unwrap()
            .version,
        "v2"
    );
}

#[test]
fn failed_store_rolls_back_summary_and_reading_an_old_database_never_creates_tables() {
    let old = Connection::open_in_memory().unwrap();
    assert!(store(&old, StoreRequest::Get("unknown".into()))
        .unwrap()
        .is_null());
    assert_eq!(
        store(&old, StoreRequest::List).unwrap(),
        json!({"checks":[]})
    );
    let count: i64 = old
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name='resource_version_checks'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    let db = db();
    let resource = record("one", "https://github.com/synthetic/tool", 1);
    insert(&db, &resource);
    let source = resource_source(&resource).unwrap();
    let initial = observation(
        source.clone(),
        None,
        at("2026-10-30T00:00:00Z"),
        Ok(Some(release(&source, "v2"))),
    )
    .unwrap();
    save(&db, initial.clone(), vec![target(&resource)]).unwrap();
    db.execute_batch("CREATE TRIGGER reject_check BEFORE UPDATE ON resource_version_checks BEGIN SELECT RAISE(ABORT,'synthetic check save failure'); END;").unwrap();
    let newer = observation(
        source.clone(),
        Some(&initial),
        at("2026-10-31T00:00:00Z"),
        Ok(Some(release(&source, "v3"))),
    )
    .unwrap();
    assert!(save(&db, newer, vec![target(&resource)]).is_err());
    let retained = get(&db, &source.key).unwrap().unwrap();
    assert_eq!(retained.revision, 1);
    assert_eq!(retained.latest.unwrap().version, "v2");
}

#[test]
fn scheduler_groups_sources_and_preserves_skill_manual_mode_with_no_download_or_apply() {
    let dir = fixture();
    let mut m = Manager::new(dir.path().join("data")).unwrap();
    m.state.check_mode = "manual".into();
    manager_insert(&m, record("one", "https://github.com/synthetic/tool", 1));
    manager_insert(&m, record("two", "https://github.com/synthetic/tool", 1));
    let mut disabled = record("disabled", "https://github.com/synthetic/disabled", 2);
    disabled.enabled = false;
    manager_insert(&m, disabled);
    let mut unknown = record("unknown", "https://github.com/synthetic/unknown", 3);
    unknown.source_binding = None;
    manager_insert(&m, unknown);
    let mut skill = record("skill", "https://github.com/synthetic/skill", 4);
    skill.kind = "skill".into();
    manager_insert(&m, skill);
    let before = m.resource_store(ResourceStore::List).unwrap();
    let mut fetched = Vec::new();
    let value = run_due_with(&m, at("2026-10-30T00:00:00Z"), |source| {
        fetched.push(source.key.clone());
        Ok(Some(release(source, "v2")))
    })
    .unwrap();
    assert_eq!(fetched.len(), 1);
    assert_eq!(value["checkedSources"], 1);
    assert_eq!(value["results"][0]["appliedIds"], json!(["one", "two"]));
    assert_eq!(value["notChecked"].as_array().unwrap().len(), 2);
    assert_eq!(value["downloaded"], false);
    assert_eq!(value["applied"], false);
    assert_eq!(m.state.check_mode, "manual");
    assert_eq!(m.resource_store(ResourceStore::List).unwrap(), before);
    let next = run_due_with(&m, at("2026-10-30T23:59:59Z"), |_| {
        panic!("fresh sources must not be fetched")
    })
    .unwrap();
    assert_eq!(next["cachedSources"], 1);
    let last = run_due_with(&m, at("2026-10-31T00:00:00Z"), |source| {
        Ok(Some(release(source, "v3")))
    })
    .unwrap();
    assert_eq!(last["checkedSources"], 1);
}

#[test]
fn persisted_due_and_failure_retry_survive_restart_without_replaying_prior_io() {
    let dir = fixture();
    let root = dir.path().join("data");
    let source;
    {
        let m = Manager::new(root.clone()).unwrap();
        let resource = record("one", "https://github.com/synthetic/tool", 1);
        source = resource_source(&resource).unwrap();
        manager_insert(&m, resource);
        run_due_with(&m, at("2026-10-30T00:00:00Z"), |_| {
            Err("限流 synthetic".into())
        })
        .unwrap();
    }
    let m = Manager::new(root).unwrap();
    let stored = m
        .resource_check_store(StoreRequest::Get(source.key))
        .unwrap();
    assert_eq!(stored["status"], "rateLimited");
    assert_eq!(stored["failures"], 1);
    run_due_with(&m, at("2026-10-30T00:14:59Z"), |_| {
        panic!("backoff persisted across restart")
    })
    .unwrap();
    let value = run_due_with(&m, at("2026-10-30T00:15:00Z"), |source| {
        Ok(Some(release(source, "v2")))
    })
    .unwrap();
    assert_eq!(value["checkedSources"], 1);
}

#[test]
fn basic_mode_and_paused_maintenance_never_fetch_or_save_checks() {
    let dir = fixture();
    let mut m = Manager::new(dir.path().join("data")).unwrap();
    manager_insert(&m, record("one", "https://github.com/synthetic/tool", 1));
    m.basic_mode = true;
    assert!(run_due_with(&m, Utc::now(), |_| panic!("basic mode network")).is_err());
    m.basic_mode = false;
    m.state.settings["maintenance"] =
        json!({"revision":1,"pausedManually":true,"pauseUntil":null,"window":null});
    assert!(run_due_with(&m, Utc::now(), |_| panic!("paused network")).is_err());
    assert!(
        m.resource_check_store(StoreRequest::List).unwrap()["checks"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn status_uses_only_current_binding_and_regular_handler_never_accepts_scheduler_actions_or_fake_grants(
) {
    let dir = fixture();
    let mut m = Manager::new(dir.path().join("data")).unwrap();
    let mut original = record("one", "https://github.com/synthetic/tool", 1);
    manager_insert(&m, original.clone());
    run_due_with(&m, at("2026-10-30T00:00:00Z"), |source| {
        Ok(Some(release(source, "v2")))
    })
    .unwrap();
    let status = handle(
        &m,
        &json!({"action":"resource_version_check_status","id":"one"}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(status["check"]["latest"]["version"], "v2");
    assert_eq!(status["installedVersion"], "v1");
    original.repository = Some("https://github.com/synthetic/new".into());
    original.source_binding = Some(binding("https://github.com/synthetic/new", 2));
    original.revision += 1;
    m.resource_store(ResourceStore::Replace {
        record: Box::new(original),
        expected_revision: 1,
    })
    .unwrap();
    let current = handle(
        &m,
        &json!({"action":"resource_version_check_status","id":"one"}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(current["status"], "notChecked");
    assert!(current["check"].is_null());
    assert!(handle(
        &m,
        &json!({"action":"__resource_version_due","automatic":true})
    )
    .unwrap()
    .is_none());
    assert!(handle(
        &m,
        &json!({"action":"resource_version_check_status","id":"one","automatic":true})
    )
    .is_err());
    assert!(dispatch_due(
        &mut m,
        &json!({"action":"__resource_version_due","automatic":false})
    )
    .is_err());
}
