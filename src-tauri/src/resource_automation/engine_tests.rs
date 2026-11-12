use super::*;

#[test]
fn unsupported_phase_and_permission_booleans_are_not_internal_steps() {
    assert!(!is_step(
        &json!({"action":"apply_resource_remove","automatic":true,"automation":{"confirmed":true}})
    ));
    assert!(!is_step(
        &json!({"action":"apply_resource_update_switch","automation":{"confirmed":true}})
    ));
    assert!(context(
        &json!({"automation":{"resourceId":"one","grantRevision":1,"version":"v2","verified":true}})
    )
    .is_err());
}

#[test]
fn release_selection_requires_exact_unique_stable_asset() {
    let stable = json!({"releases":[{"id":1,"tag":"v2","prerelease":false,"assets":[{"id":2,"name":"windows.zip"},{"id":3,"name":"linux.zip"}]}]});
    assert_eq!(
        select_release(&stable, "windows.zip", "v2").unwrap(),
        (1, 2)
    );
    assert!(select_release(&stable, "other.zip", "v2").is_err());
    let mut changed = stable.clone();
    changed["releases"][0]["prerelease"] = json!(true);
    assert!(select_release(&changed, "windows.zip", "v2").is_err());
    let mut duplicate = stable.clone();
    duplicate["releases"][0]["assets"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":4,"name":"windows.zip"}));
    assert!(select_release(&duplicate, "windows.zip", "v2").is_err());
    let mut unavailable = stable;
    unavailable["releases"][0]["assets"][0]["unavailableReason"] = json!("changed");
    assert!(select_release(&unavailable, "windows.zip", "v2").is_err());
}

#[test]
fn attempt_key_binds_resource_grant_and_version() {
    let original = attempt_key("one", 1, "v2");
    assert_ne!(original, attempt_key("two", 1, "v2"));
    assert_ne!(original, attempt_key("one", 2, "v2"));
    assert_ne!(original, attempt_key("one", 1, "v3"));
    assert_eq!(original, attempt_key("one", 1, "v2"));
}

#[test]
fn release_dates_prevent_automatic_downgrade_and_require_original_identity() {
    let current = json!({"releases":[{"id":20,"tag":"v1","publishedAt":"2026-10-20T00:00:00Z"}]});
    let next = json!({"releases":[{"id":21,"tag":"v2","publishedAt":"2026-10-21T00:00:00Z"}]});
    assert!(ensure_newer_release(&next, &current, 21, 20, "v2", "v1").is_ok());
    assert!(ensure_newer_release(&current, &next, 20, 21, "v1", "v2").is_err());
    assert!(ensure_newer_release(&next, &current, 21, 99, "v2", "v1").is_err());
    let unknown = json!({"releases":[{"id":20,"tag":"v1","publishedAt":null}]});
    assert!(ensure_newer_release(&next, &unknown, 21, 20, "v2", "v1").is_err());
    let same_time = json!({"releases":[{"id":21,"tag":"v2","publishedAt":"2026-10-20T00:00:00Z"}]});
    assert!(ensure_newer_release(&same_time, &current, 21, 20, "v2", "v1").is_err());
}

fn pending(resource: &ResourceRecord, grant: &AutomationGrant, parent: &Path) -> Attempt {
    Attempt {
        key: attempt_key(&resource.id, grant.revision, "v2"),
        id: uuid::Uuid::new_v4().to_string(),
        resource_id: resource.id.clone(),
        grant_revision: grant.revision,
        version: "v2".into(),
        source_check_revision: 0,
        source_key: String::new(),
        resume_download_id: None,
        candidate_root: parent.join("new-runtime"),
        status: "running".into(),
        phase: "release".into(),
        created_at: now(),
        updated_at: now(),
        result: Value::Null,
    }
}

#[test]
fn attempt_claim_is_durable_and_never_replays_same_authorized_version() {
    use super::super::tests::{apply, fixture, preview, request};
    let (_dir, mut manager, original, parent, downloads) = fixture();
    let plan = preview(&mut manager, &request(&original, &parent, &downloads)).unwrap();
    apply(&mut manager, &plan).unwrap();
    let current = read(&manager, &original.id).unwrap();
    let authorization = grant(&manager, &original.id).unwrap().unwrap();
    let attempt = pending(&current, &authorization, &parent);
    let claim = || StoreRequest::ClaimAttempt {
        expected_resource: Box::new(current.clone()),
        expected_grant_revision: authorization.revision,
        attempt: Box::new(attempt.clone()),
    };
    assert_eq!(
        manager.resource_automation_store(claim()).unwrap()["claimed"],
        true
    );
    assert_eq!(
        manager.resource_automation_store(claim()).unwrap()["claimed"],
        false
    );
    let rows = manager
        .resource_automation_store(StoreRequest::Attempts(current.id.clone()))
        .unwrap();
    assert_eq!(rows["attempts"].as_array().unwrap().len(), 1);
    let mut tampered = attempt.clone();
    tampered.version = "v3".into();
    assert!(manager
        .resource_automation_store(StoreRequest::ClaimAttempt {
            expected_resource: Box::new(current.clone()),
            expected_grant_revision: authorization.revision,
            attempt: Box::new(tampered)
        })
        .is_err());
    assert!(!attempt.candidate_root.exists());
    assert_eq!(
        fs::read_to_string(Path::new(&current.root_path).join("tool.exe")).unwrap(),
        "synthetic runtime"
    );
}

#[test]
fn partial_attempt_results_use_cas_and_cannot_resume_old_operations() {
    use super::super::tests::{apply, fixture, preview, request};
    let (_dir, mut manager, original, parent, downloads) = fixture();
    let plan = preview(&mut manager, &request(&original, &parent, &downloads)).unwrap();
    apply(&mut manager, &plan).unwrap();
    let record = read(&manager, &original.id).unwrap();
    let authorization = grant(&manager, &record.id).unwrap().unwrap();
    let old = pending(&record, &authorization, &parent);
    manager
        .resource_automation_store(StoreRequest::ClaimAttempt {
            expected_resource: Box::new(record),
            expected_grant_revision: authorization.revision,
            attempt: Box::new(old.clone()),
        })
        .unwrap();
    let mut changed = old.clone();
    changed.status = "stopped".into();
    changed.phase = "stage".into();
    changed.result = json!({"changed":true,"candidatePath":old.candidate_root,"downloadId":"one"});
    let save = || StoreRequest::SaveAttempt {
        expected: Box::new(old.clone()),
        attempt: Box::new(changed.clone()),
    };
    let saved = manager.resource_automation_store(save()).unwrap();
    assert_eq!(saved["automaticResult"]["status"], "stopped");
    assert_eq!(saved["automaticResult"]["changed"], true);
    assert!(manager.resource_automation_store(save()).is_err());
    let ctx = Context {
        resource_id: old.resource_id,
        grant_revision: old.grant_revision,
        version: old.version,
        source_check_revision: old.source_check_revision,
        source_key: old.source_key,
        attempt_id: Some(old.id),
    };
    assert!(attempt(&manager, &ctx).is_err());
    assert!(!old.candidate_root.exists());
}

struct Pipeline {
    fail: Option<&'static str>,
    switch_failure: bool,
    calls: Vec<Value>,
    attempt: Attempt,
    scope: AutomationScope,
}
impl Pipeline {
    fn new(fail: Option<&'static str>) -> Self {
        let scope = AutomationScope {
            repository: "https://github.com/synthetic/tool".into(),
            repository_id: 11,
            source_fingerprint: "s".into(),
            constraint_fingerprint: "f".into(),
            original_root: PathBuf::from("runtime-v1"),
            original_root_id: "old-id".into(),
            candidate_parent_path: PathBuf::from("versions"),
            candidate_parent_id: "parent-id".into(),
            download_directory: PathBuf::from("downloads"),
            download_directory_id: "download-id".into(),
            channel: "stable".into(),
            asset_name: "windows.zip".into(),
            files: BTreeMap::from([
                ("tool.exe".into(), FileRole::Runtime),
                ("LICENSE".into(), FileRole::License),
            ]),
            pinned_version: None,
            skipped_versions: vec![],
            runtime_package: None,
        };
        Self {
            fail,
            switch_failure: false,
            calls: vec![],
            scope,
            attempt: Attempt {
                key: attempt_key("synthetic", 1, "v2"),
                id: "attempt-one".into(),
                resource_id: "synthetic".into(),
                grant_revision: 1,
                version: "v2".into(),
                source_check_revision: 0,
                source_key: String::new(),
                resume_download_id: None,
                candidate_root: PathBuf::from("versions/runtime-v2"),
                status: "running".into(),
                phase: "release".into(),
                created_at: now(),
                updated_at: now(),
                result: Value::Null,
            },
        }
    }
    fn ctx(&self) -> Context {
        Context {
            resource_id: "synthetic".into(),
            grant_revision: 1,
            version: "v2".into(),
            source_check_revision: 0,
            source_key: String::new(),
            attempt_id: None,
        }
    }
    fn execute(&mut self, request: Value) -> Result<Value, String> {
        let action = request["action"].as_str().unwrap().to_owned();
        self.calls.push(request.clone());
        if self.fail == Some(action.as_str()) {
            return Err("synthetic failure".into());
        }
        Ok(match action.as_str() {
            "__resource_automation_claim" => {
                json!({"claimed":true,"attempt":self.attempt,"scope":self.scope})
            }
            "resource_github_releases" => {
                json!({"releases":[{"id":21,"tag":"v2","prerelease":false,"assets":[{"id":33,"name":"windows.zip"}]}]})
            }
            "__resource_automation_finish" => json!({"saved":true}),
            "preview_resource_download" | "preview_resource_resume" => {
                json!({"id":"download-preview","downloadId":"download-one","targetPath":"downloads/release.zip","partialPath":"downloads/release.zip.part"})
            }
            "apply_resource_download" => {
                json!({"complete":true,"archivePath":"downloads/release.zip","downloadId":"download-one"})
            }
            "resource_update_state" => json!({"resource":{"revision":2}}),
            "preview_resource_update" => json!({"id":"stage-preview"}),
            "apply_resource_update_stage" => json!({"complete":true,"resource":{"revision":3}}),
            "verify_resource_update" => json!({"verified":true,"resource":{"revision":4}}),
            "preview_resource_update_switch" => json!({"id":"switch-preview"}),
            "apply_resource_update_switch" if self.switch_failure => {
                json!({"complete":false,"switched":true,"postSwitchVerified":false,"rolledBack":false})
            }
            "apply_resource_update_switch" => {
                json!({"complete":true,"switched":true,"postSwitchVerified":true,"authorizationAdvanced":true})
            }
            _ => panic!("unexpected phase: {action}"),
        })
    }
}

#[test]
fn coordinator_requires_download_stage_real_probe_and_post_switch_result_in_order() {
    let mut fixture = Pipeline::new(None);
    let ctx = fixture.ctx();
    let outcome = run_one_with(ctx, &mut |request| fixture.execute(request)).unwrap();
    assert_eq!(outcome["postSwitchVerified"], true);
    let operational: Vec<_> = fixture
        .calls
        .iter()
        .filter_map(|r| {
            let a = r["action"].as_str().unwrap();
            (a != "__resource_automation_finish").then_some(a)
        })
        .collect();
    assert_eq!(
        operational,
        vec![
            "__resource_automation_claim",
            "resource_github_releases",
            "preview_resource_download",
            "apply_resource_download",
            "resource_update_state",
            "preview_resource_update",
            "apply_resource_update_stage",
            "verify_resource_update",
            "preview_resource_update_switch",
            "apply_resource_update_switch"
        ]
    );
    for request in &fixture.calls {
        assert!(is_step(request));
        assert_eq!(request["automatic"], true);
        assert_eq!(request["automation"]["resourceId"], "synthetic");
        assert!(request.get("confirmed").is_none());
        assert!(request.get("verified").is_none());
    }
    let stage = fixture
        .calls
        .iter()
        .find(|r| r["action"] == "preview_resource_update")
        .unwrap();
    assert_eq!(
        stage["destinationPath"],
        json!(fixture.attempt.candidate_root)
    );
    assert_eq!(stage["fileRoles"], json!(fixture.scope.files));
    assert_eq!(stage["expectedRevision"], 2);
    let verify = fixture
        .calls
        .iter()
        .find(|r| r["action"] == "verify_resource_update")
        .unwrap();
    assert_eq!(verify["expectedRevision"], 3);
    let switch = fixture
        .calls
        .iter()
        .find(|r| r["action"] == "preview_resource_update_switch")
        .unwrap();
    assert_eq!(switch["expectedRevision"], 4);
    let final_receipt = fixture.calls.last().unwrap();
    assert_eq!(final_receipt["status"], "completed");
    assert_eq!(final_receipt["result"]["postSwitchVerified"], true);
}

#[test]
fn every_failed_phase_stops_later_writes_and_persists_its_actual_stage() {
    for (failed, phase) in [
        ("resource_github_releases", "release"),
        ("apply_resource_download", "download"),
        ("apply_resource_update_stage", "stage"),
        ("verify_resource_update", "verify"),
        ("apply_resource_update_switch", "switch"),
    ] {
        let mut fixture = Pipeline::new(Some(failed));
        let ctx = fixture.ctx();
        assert!(run_one_with(ctx, &mut |request| fixture.execute(request)).is_err());
        let at = fixture
            .calls
            .iter()
            .position(|r| r["action"] == failed)
            .unwrap();
        assert!(fixture.calls[at + 1..]
            .iter()
            .all(|r| r["action"] == "__resource_automation_finish"));
        let receipt = fixture.calls.last().unwrap();
        assert_eq!(receipt["status"], "stopped");
        assert_eq!(receipt["phase"], phase);
        if matches!(phase, "stage" | "verify" | "switch") {
            assert_eq!(receipt["result"]["downloadId"], "download-one");
            assert_eq!(receipt["result"]["changed"], true);
        }
    }
}

#[test]
fn post_switch_failure_is_not_reported_as_update_success_or_safe_rollback() {
    let mut fixture = Pipeline::new(None);
    fixture.switch_failure = true;
    let ctx = fixture.ctx();
    assert!(run_one_with(ctx, &mut |request| fixture.execute(request)).is_err());
    let receipt = fixture.calls.last().unwrap();
    assert_eq!(receipt["status"], "stopped");
    assert_eq!(receipt["phase"], "switch");
    assert_eq!(receipt["result"]["switched"], true);
    assert_eq!(receipt["result"]["postSwitchVerified"], false);
    assert_eq!(receipt["result"]["rolledBack"], false);
}

#[test]
fn old_attempt_records_remain_readable_without_creating_a_fresh_retry() {
    let mut value = json!({"key":attempt_key("one",1,"v2"),"id":"old","resourceId":"one","grantRevision":1,"version":"v2","candidateRoot":"versions/old","status":"stopped","phase":"release","createdAt":now(),"updatedAt":now(),"result":{"changed":false}});
    let previous: Attempt = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(previous.source_check_revision, 0);
    assert!(previous.source_key.is_empty());
    assert!(previous.resume_download_id.is_none());
    let observed = Observation {
        version: "v2".into(),
        revision: 1,
        source_key: "source".into(),
        checked_at: Utc::now() - Duration::hours(1),
    };
    assert!(retry(Some(&previous), &observed).is_err());
    value["updatedAt"] = json!((Utc::now() - Duration::hours(2)).to_rfc3339());
    let previous: Attempt = serde_json::from_value(value).unwrap();
    assert_eq!(retry(Some(&previous), &observed).unwrap(), None);
}

#[test]
fn new_observations_retry_only_release_reads_without_transfer_or_candidate_evidence() {
    let fixture = Pipeline::new(None);
    let mut previous = fixture.attempt.clone();
    previous.status = "stopped".into();
    previous.updated_at = (Utc::now() - Duration::hours(1)).to_rfc3339();
    previous.result = json!({"changed":false});
    previous.source_check_revision = 2;
    previous.source_key = "source".into();
    let mut observed = Observation {
        version: "v2".into(),
        revision: 2,
        source_key: "source".into(),
        checked_at: Utc::now(),
    };
    assert!(retry(Some(&previous), &observed).is_err());
    observed.revision = 3;
    assert_eq!(retry(Some(&previous), &observed).unwrap(), None);
    for phase in ["stage", "verify", "switch", "complete"] {
        previous.phase = phase.into();
        assert!(retry(Some(&previous), &observed).is_err(), "{phase}");
    }
    previous.phase = "download".into();
    previous.result = json!({"changed":true,"downloadId":"existing-download"});
    assert!(retry(Some(&previous), &observed).is_err());
    previous.result = json!({"changed":true});
    assert!(retry(Some(&previous), &observed).is_err());
    previous.phase = "release".into();
    previous.result = json!({"changed":false});
    for key in [
        "downloadId",
        "archivePath",
        "partialPath",
        "candidatePath",
        "packageSessionId",
    ] {
        previous.result[key] = json!("existing-evidence");
        assert!(retry(Some(&previous), &observed).is_err(), "{key}");
        previous.result.as_object_mut().unwrap().remove(key);
    }
    previous.result["receivedBytes"] = json!(128);
    assert!(retry(Some(&previous), &observed).is_err());
    previous
        .result
        .as_object_mut()
        .unwrap()
        .remove("receivedBytes");
    previous.resume_download_id = Some("existing-download".into());
    assert!(retry(Some(&previous), &observed).is_err());
    previous.resume_download_id = None;
    previous.status = "running".into();
    assert!(retry(Some(&previous), &observed).is_err());
}

#[test]
fn legacy_running_resume_attempt_stops_before_transport_and_preserves_its_evidence() {
    let mut fixture = Pipeline::new(None);
    fixture.attempt.resume_download_id = Some("download-one".into());
    fixture.attempt.result = json!({"changed":true,"downloadId":"download-one","partialPath":"downloads/release.zip.part","receivedBytes":128});
    let ctx = fixture.ctx();
    let error = run_one_with(ctx, &mut |request| fixture.execute(request)).unwrap_err();
    assert!(error.contains("本人重新预览并确认"));
    assert_eq!(fixture.calls.len(), 2);
    assert_eq!(fixture.calls[0]["action"], "__resource_automation_claim");
    let stopped = &fixture.calls[1];
    assert_eq!(stopped["action"], "__resource_automation_finish");
    assert_eq!(stopped["status"], "stopped");
    assert_eq!(stopped["result"]["downloadId"], "download-one");
    assert_eq!(
        stopped["result"]["partialPath"],
        "downloads/release.zip.part"
    );
    assert_eq!(stopped["result"]["receivedBytes"], 128);
    assert!(stopped["result"]["message"]
        .as_str()
        .unwrap()
        .contains("本人重新预览并确认继续"));
    assert!(fixture.calls.iter().all(is_step));
}

#[test]
fn a_new_resume_attempt_keeps_only_transfer_evidence_not_prior_decisions() {
    let mut previous = Pipeline::new(None).attempt;
    previous.result = json!({
        "changed":true,"downloadId":"original-download","archivePath":"downloads/original.zip",
        "partialPath":"downloads/original.zip.part","receivedBytes":128,
        "message":"old failure","admissionRejected":true,"switched":true,
        "postSwitchVerified":false,"rolledBack":false,"authorizationAdvanced":false,
        "downloadStatus":"failed","unexpectedField":"must not carry forward"
    });
    assert_eq!(
        recovery_result(Some(&previous), Some("original-download")),
        json!({
            "changed":true,"downloadId":"original-download","archivePath":"downloads/original.zip",
            "partialPath":"downloads/original.zip.part","receivedBytes":128
        })
    );
    assert_eq!(
        recovery_result(Some(&previous), None),
        json!({"changed":false})
    );
}

fn seed_observation(manager: &Manager, id: &str, at: DateTime<Utc>) -> Result<Value, String> {
    use crate::resource_checks::{
        CheckRecord, CheckSource, CheckTarget, ReleaseSummary, StoreRequest as CheckStore,
    };
    let resource = read(manager, id)?;
    let binding = resource
        .source_binding
        .as_ref()
        .ok_or("missing fixture source")?;
    let repository = binding.repository.to_ascii_lowercase();
    let key = format!(
        "{:x}",
        Sha256::digest(format!("{repository}\n{}\nstable", binding.repository_id).as_bytes())
    );
    let previous = manager.resource_check_store(CheckStore::Get(key.clone()))?;
    let revision = previous["revision"].as_u64().unwrap_or(0);
    manager.resource_check_store(CheckStore::Save {
        expected_revision: revision,
        targets: vec![CheckTarget {
            id: id.into(),
            revision: resource.revision,
            source_key: key.clone(),
        }],
        record: Box::new(CheckRecord {
            source: CheckSource {
                key,
                repository: repository.clone(),
                repository_id: binding.repository_id,
                channel: "stable".into(),
                runtime_package: None,
            },
            revision: revision + 1,
            checked_at: at.to_rfc3339(),
            next_check_at: (at + Duration::hours(24)).to_rfc3339(),
            failures: 0,
            status: "checked".into(),
            message: "synthetic scheduled observation".into(),
            latest: Some(ReleaseSummary {
                version: "v2".into(),
                url: format!("{repository}/releases/tag/v2"),
                published_at: Some(at.to_rfc3339()),
                metadata_hash: None,
            }),
        }),
    })
}
fn inject_observation(manager: &mut Manager, request: &Value) -> Result<Value, String> {
    if request["action"] != "__synthetic_source_observation" {
        return crate::dispatch(manager, request);
    }
    let at = DateTime::parse_from_rfc3339(request["at"].as_str().ok_or("missing fixture date")?)
        .map_err(|e| e.to_string())?
        .with_timezone(&Utc);
    seed_observation(
        manager,
        request["id"].as_str().ok_or("missing fixture id")?,
        at,
    )
}

#[test]
fn actual_service_rechecks_once_per_new_observation_and_records_failed_admission_without_io() {
    let (_dir, manager, resource, parent, _downloads, _launcher, _exe) = native_fixture();
    seed_observation(&manager, &resource.id, Utc::now() - Duration::hours(2)).unwrap();
    let authorization = grant(&manager, &resource.id).unwrap().unwrap();
    let mut previous = pending(&resource, &authorization, &parent);
    previous.updated_at = (Utc::now() - Duration::hours(1)).to_rfc3339();
    previous.result = json!({"changed":false});
    manager
        .resource_automation_store(StoreRequest::ClaimAttempt {
            expected_resource: Box::new(resource.clone()),
            expected_grant_revision: authorization.revision,
            attempt: Box::new(previous.clone()),
        })
        .unwrap();
    let mut ended = previous.clone();
    ended.status = "stopped".into();
    manager
        .resource_automation_store(StoreRequest::SaveAttempt {
            expected: Box::new(previous),
            attempt: Box::new(ended),
        })
        .unwrap();
    let service = TaskSystem::new(manager).unwrap();
    for _ in 0..3 {
        assert_eq!(run_due(&service).unwrap()["results"], json!([]));
    }
    service.execute(json!({"action":"__synthetic_source_observation","id":resource.id,"at":(Utc::now()-Duration::minutes(5)).to_rfc3339()}),inject_observation).unwrap();
    // A local edit makes the next admission fail. The real coordinator must
    // record that once, without reaching metadata transport or execution.
    fs::write(
        Path::new(&resource.root_path).join("tool.exe"),
        "synthetic local edit",
    )
    .unwrap();
    let result = run_due(&service).unwrap();
    assert_eq!(result["results"].as_array().unwrap().len(), 1);
    assert_eq!(result["results"][0]["skipped"], true);
    for _ in 0..3 {
        assert_eq!(run_due(&service).unwrap()["results"], json!([]));
    }
    let status = service
        .execute(
            json!({"action":"resource_automation_status","resourceId":resource.id}),
            crate::dispatch,
        )
        .unwrap();
    let attempts = status["attempts"].as_array().unwrap();
    assert_eq!(attempts.len(), 2);
    assert_eq!(attempts[0]["sourceCheckRevision"], 2);
    assert_eq!(attempts[0]["status"], "stopped");
    assert_eq!(attempts[0]["result"]["admissionRejected"], true);
    assert_eq!(
        fs::read_to_string(Path::new(&resource.root_path).join("tool.exe")).unwrap(),
        "synthetic local edit"
    );
    assert_eq!(fs::read_dir(&parent).unwrap().count(), 0);
}

#[test]
fn actual_service_preserves_interrupted_transfers_until_explicit_manual_continuation() {
    use std::io::Write;
    for published in [false, true] {
        let download_id = "cb2dba5e-9848-46dc-90cf-41f59f46b2ae";
        let (_dir, manager, resource, parent, downloads, _launcher, _exe) = native_fixture();
        let archive = downloads.join(format!("{download_id}-windows.zip"));
        let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
        zip.start_file("tool.exe", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"synthetic candidate").unwrap();
        zip.finish().unwrap();
        let fingerprint = resource_files::fingerprint(&archive).unwrap();
        let partial = PathBuf::from(format!("{}.part", archive.display()));
        let observed_file = if published {
            archive.clone()
        } else {
            partial.clone()
        };
        if !published {
            fs::rename(&archive, &partial).unwrap();
            fs::OpenOptions::new()
                .write(true)
                .open(&partial)
                .unwrap()
                .set_len(fingerprint.bytes / 2)
                .unwrap();
        }
        let observed_fingerprint = resource_files::fingerprint(&observed_file).unwrap();
        let repository = resource.repository.clone().unwrap();
        let prepared = json!({"downloadId":download_id,"repo":"Panniantong/Agent-Reach","releaseId":50,"tag":"v2","author":"Panniantong","asset":{"id":51,"name":"windows.zip","size":fingerprint.bytes,"digest":null,"url":format!("{repository}/releases/download/v2/windows.zip"),"updatedAt":now()},"target":archive,"partial":partial,"rate":0,"progress":{"bytes":observed_fingerprint.bytes,"sha256":observed_fingerprint.sha256,"etag":"synthetic-etag"}});
        let source = json!({"repository":repository,"version":"v2","verification":"githubAsset","author":"Panniantong","releaseId":50,"assetId":51,"assetName":"windows.zip","downloadUrl":format!("{repository}/releases/download/v2/windows.zip"),"sha256":fingerprint.sha256,"expectedSha256":null});
        // Both an actual partial file and a completed publish with an interrupted
        // terminal journal require a new explicit human action, not a source poll.
        manager.download_store(crate::resource_github::DownloadStore::Save{id:download_id.into(),record:json!({"schemaVersion":1,"id":download_id,"status":"failed","prepared":prepared,"source":source,"fingerprint":fingerprint,"updatedAt":now(),"error":"synthetic interruption after publish"})}).unwrap();
        seed_observation(&manager, &resource.id, Utc::now() - Duration::hours(2)).unwrap();
        let authorization = grant(&manager, &resource.id).unwrap().unwrap();
        let mut previous = pending(&resource, &authorization, &parent);
        previous.result = json!({"changed":true,"downloadId":download_id,"archivePath":archive});
        previous.updated_at = (Utc::now() - Duration::hours(1)).to_rfc3339();
        manager
            .resource_automation_store(StoreRequest::ClaimAttempt {
                expected_resource: Box::new(resource.clone()),
                expected_grant_revision: authorization.revision,
                attempt: Box::new(previous.clone()),
            })
            .unwrap();
        let mut ended = previous.clone();
        ended.status = "stopped".into();
        ended.phase = "download".into();
        manager
            .resource_automation_store(StoreRequest::SaveAttempt {
                expected: Box::new(previous),
                attempt: Box::new(ended),
            })
            .unwrap();
        let service = TaskSystem::new(manager).unwrap();
        let downloads_before = service
            .execute(json!({"action":"resource_downloads"}), crate::dispatch)
            .unwrap();
        assert_eq!(run_due(&service).unwrap()["results"], json!([]));
        service.execute(json!({"action":"__synthetic_source_observation","id":resource.id,"at":(Utc::now()-Duration::minutes(5)).to_rfc3339()}),inject_observation).unwrap();
        let scan = service
            .execute_automatic_resource_step(
                json!({"action":"__resource_automation_scan","automatic":true}),
            )
            .unwrap();
        assert_eq!(scan["jobs"], json!([]));
        for _ in 0..3 {
            assert_eq!(run_due(&service).unwrap()["results"], json!([]));
        }
        let check = service
            .execute(
                json!({"action":"resource_version_check_status","id":resource.id}),
                crate::dispatch,
            )
            .unwrap();
        let ctx = Context {
            resource_id: resource.id.clone(),
            grant_revision: authorization.revision,
            version: "v2".into(),
            source_check_revision: check["check"]["revision"].as_u64().unwrap(),
            source_key: check["check"]["source"]["key"].as_str().unwrap().into(),
            attempt_id: None,
        };
        assert!(service
            .execute_automatic_resource_step(wrap(
                json!({"action":"__resource_automation_claim"}),
                &ctx,
            ))
            .is_err());
        let status = service
            .execute(
                json!({"action":"resource_automation_status","resourceId":resource.id}),
                crate::dispatch,
            )
            .unwrap();
        assert_eq!(status["attempts"].as_array().unwrap().len(), 1);
        assert_eq!(status["attempts"][0]["status"], "stopped");
        assert_eq!(status["attempts"][0]["result"]["downloadId"], download_id);
        assert_eq!(
            service
                .execute(json!({"action":"resource_downloads"}), crate::dispatch)
                .unwrap(),
            downloads_before
        );
        assert_eq!(
            resource_files::fingerprint(&observed_file).unwrap(),
            observed_fingerprint
        );
        assert_eq!(archive.exists(), published);
        assert_eq!(partial.exists(), !published);
        if published {
            let resumed = service
                .execute(
                    json!({"action":"preview_resource_resume","downloadId":download_id}),
                    crate::dispatch,
                )
                .unwrap();
            assert_eq!(resumed["alreadyComplete"], true);
            assert_eq!(resumed["downloadId"], download_id);
            let completed = service
                .execute(
                    json!({"action":"apply_resource_download","previewId":resumed["id"]}),
                    crate::dispatch_local,
                )
                .unwrap();
            assert_eq!(completed["complete"], true);
            assert_eq!(completed["downloadId"], download_id);
        }
        assert_eq!(fs::read_dir(&downloads).unwrap().count(), 1);
        assert_eq!(
            resource_files::fingerprint(&observed_file).unwrap(),
            observed_fingerprint
        );
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 0);
        let state = service
            .execute(
                json!({"action":"resource_update_state","id":resource.id}),
                crate::dispatch,
            )
            .unwrap();
        assert_eq!(state["resource"]["version"], "v1");
        assert!(state["updateState"].is_null());
        let scope = authorization.scope.as_ref().unwrap();
        let consent = service.execute(json!({"action":"preview_resource_automation","resourceId":resource.id,"expectedRevision":state["resource"]["revision"],"enabled":true,"candidateParentPath":scope.candidate_parent_path,"downloadDirectory":scope.download_directory,"channel":"stable","assetName":scope.asset_name,"selectedFiles":scope.files.keys().collect::<Vec<_>>(),"fileRoles":scope.files}), crate::dispatch_local).unwrap();
        let renewed = service
            .execute(
                json!({"action":"apply_resource_automation","previewId":consent["id"]}),
                crate::dispatch_local,
            )
            .unwrap();
        assert_eq!(
            renewed["authorization"]["revision"],
            authorization.revision + 1
        );
        let jobs = service
            .execute_automatic_resource_step(
                json!({"action":"__resource_automation_scan","automatic":true}),
            )
            .unwrap();
        assert_eq!(jobs["jobs"].as_array().unwrap().len(), 1);
        assert_eq!(jobs["jobs"][0]["grantRevision"], authorization.revision + 1);
        assert_eq!(
            resource_files::fingerprint(&observed_file).unwrap(),
            observed_fingerprint
        );
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 0);
    }
}

fn native_fixture() -> (
    tempfile::TempDir,
    Manager,
    ResourceRecord,
    PathBuf,
    PathBuf,
    String,
    PathBuf,
) {
    use super::super::tests::fixture;
    let (dir, mut manager, mut record, parent, downloads) = fixture();
    // Entirely synthetic launcher/layout: static scope checks are real, but
    // this test never invokes the launcher, Python, a network or a user tool.
    let root = PathBuf::from(&record.root_path);
    let python = root.join("Scripts/python.exe");
    let launcher = format!("SYNTHETIC\n#!{}\n", python.display());
    let paths = [
        ("Scripts/agent-reach.exe", launcher.as_str()),
        ("Scripts/python.exe", "synthetic python"),
        ("pyvenv.cfg", "synthetic venv"),
        ("Lib/site-packages/agent_reach/__init__.py", "synthetic"),
        ("Lib/site-packages/agent_reach/cli.py", "synthetic"),
        ("Lib/site-packages/agent_reach/runtime/cli.py", "synthetic"),
        (
            "Lib/site-packages/agent_reach/runtime/manage.py",
            "synthetic",
        ),
    ];
    for (relative, contents) in paths {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, contents).unwrap();
        record
            .installation
            .as_mut()
            .unwrap()
            .files
            .push(crate::resource_files::OwnedFile {
                path: relative.into(),
                role: FileRole::Runtime,
                installed_sha256: resource_files::fingerprint(&path).unwrap().sha256,
            });
    }
    let repository = "https://github.com/Panniantong/Agent-Reach".to_owned();
    record.repository = Some(repository.clone());
    record.source_binding.as_mut().unwrap().repository = repository.clone();
    let installation = record.installation.as_mut().unwrap();
    installation.source_repository = Some(repository.clone());
    let source = installation.download_source.as_mut().unwrap();
    source.repository = repository.clone();
    source.author = "Panniantong".into();
    source.download_url = format!("{repository}/releases/download/v1/windows.zip");
    let exe = root.join("Scripts/agent-reach.exe");
    record.actions = vec![
        json!({"id":"entry","label":"Synthetic","mode":"task","executable":crate::local::canonical(&exe).unwrap(),"workingDirectory":crate::local::canonical(&root).unwrap(),"args":[{"type":"literal","value":"version"}],"parameters":[],"executableSha256":resource_files::fingerprint(&exe).unwrap().sha256}),
    ];
    record.revision += 1;
    manager
        .resource_store(Catalog::Replace {
            record: Box::new(record.clone()),
            expected_revision: record.revision - 1,
        })
        .unwrap();
    let roles: BTreeMap<_, _> = record
        .installation
        .as_ref()
        .unwrap()
        .files
        .iter()
        .map(|f| (f.path.clone(), f.role.clone()))
        .collect();
    let preview=super::super::preview_local(&mut manager,&json!({"action":"preview_resource_automation","resourceId":record.id,"expectedRevision":record.revision,"enabled":true,"candidateParentPath":parent,"downloadDirectory":downloads,"channel":"stable","assetName":"windows.zip","selectedFiles":roles.keys().collect::<Vec<_>>(),"fileRoles":roles})).unwrap().unwrap();
    super::super::apply_local(
        &mut manager,
        &json!({"action":"apply_resource_automation","previewId":preview["id"]}),
    )
    .unwrap()
    .unwrap();
    let record = read(&manager, &record.id).unwrap();
    (dir, manager, record, parent, downloads, launcher, exe)
}

#[test]
fn actual_task_system_accepts_the_wrapped_state_phase_and_keeps_journals_after_pause() {
    let (_dir, manager, resource, parent, _downloads, launcher, exe) = native_fixture();
    let record = resource.clone();
    let authorization = grant(&manager, &record.id).unwrap().unwrap();
    let pending = pending(&resource, &authorization, &parent);
    manager
        .resource_automation_store(StoreRequest::ClaimAttempt {
            expected_resource: Box::new(resource.clone()),
            expected_grant_revision: authorization.revision,
            attempt: Box::new(pending.clone()),
        })
        .unwrap();
    let ctx = Context {
        resource_id: record.id.clone(),
        grant_revision: authorization.revision,
        version: "v2".into(),
        source_check_revision: pending.source_check_revision,
        source_key: pending.source_key.clone(),
        attempt_id: Some(pending.id),
    };
    let request = wrap(
        json!({"action":"resource_update_state","id":record.id}),
        &ctx,
    );
    let service = TaskSystem::new(manager).unwrap();
    // The ordinary entry rejects the same JSON; only the internal dispatcher
    // can execute this phase. This catches pipeline / TaskSystem schema drift.
    assert!(service.execute(request.clone(), crate::dispatch).is_err());
    let current = service
        .execute_automatic_resource_step(request.clone())
        .unwrap();
    assert_eq!(current["resource"]["id"], resource.id);
    assert_eq!(current["resource"]["revision"], resource.revision);
    assert_eq!(current["resource"]["version"], "v1");
    assert_eq!(run_due(&service).unwrap()["results"], json!([]));
    service
        .execute(
            json!({"action":"set_maintenance","expectedRevision":0,"pause":"manual"}),
            crate::dispatch,
        )
        .unwrap();
    assert!(service.execute_automatic_resource_step(request).is_err());
    let saved = progress(
        &mut |request| service.execute_automatic_resource_step(request),
        &ctx,
        "stage",
        "stopped",
        json!({"changed":false}),
    )
    .unwrap();
    assert_eq!(saved["automaticResult"]["status"], "stopped");
    assert_eq!(fs::read_to_string(&exe).unwrap(), launcher);
    assert!(!parent.join("new-runtime").exists());
    let runtime = service
        .execute(json!({"action":"resource_runtime"}), crate::dispatch)
        .unwrap();
    assert!(runtime["runs"].as_array().unwrap().is_empty());
}

#[cfg(windows)]
#[test]
fn actual_automatic_update_downloads_probes_and_switches_without_replaying_or_changing_original() {
    use crate::resource_files::OwnedFile;
    use std::io::{Cursor, Write};

    let validation = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap()
        .join("validation/manager-data/resource-automation-native-cli-tests");
    fs::create_dir_all(&validation).unwrap();
    let dir = tempfile::tempdir_in(&validation).unwrap();
    let mut manager = Manager::new(dir.path().join("data")).unwrap();
    let original_root = dir.path().join("runtime-v1");
    let parent = dir.path().join("versions");
    let downloads = dir.path().join("downloads");
    for path in [&original_root, &parent, &downloads] {
        fs::create_dir(path).unwrap();
    }
    let node = std::env::split_paths(&std::env::var_os("PATH").expect("Node runtime PATH"))
        .map(|directory| directory.join("node.exe"))
        .find(|path| path.is_file())
        .expect("The native automatic-update regression requires the existing Node runtime");
    let node = crate::local::canonical(&node).unwrap();
    let node_before = resource_files::fingerprint(&node).unwrap();
    let calls = dir.path().join("actual-cli-calls.jsonl");
    let user_data = dir.path().join("user-data.json");
    fs::write(
        &user_data,
        "personal configuration remains outside the runtime",
    )
    .unwrap();
    let user_data_before = resource_files::fingerprint(&user_data).unwrap();
    let files = |version: &str| {
        BTreeMap::from([
            ("LICENSE".to_owned(), "Synthetic local test license".to_owned()),
            ("node_modules/@playwright/mcp/package.json".to_owned(), json!({"name":"@playwright/mcp","version":version,"repository":{"url":"git+https://github.com/microsoft/playwright-mcp.git"}}).to_string()),
            ("node_modules/@playwright/mcp/cli.js".to_owned(), format!(r#"const fs = require('node:fs');
const version = {version};
const argument = process.argv[2];
fs.appendFileSync({calls}, JSON.stringify({{ version, argument, pid: process.pid, cwd: process.cwd() }}) + '\n');
const program = {{
  version(text) {{ this.text = text; return this; }},
  parseAsync(argv) {{
    if (argv[2] === '--version') console.log(this.text);
    else if (argv[2] === '--help') console.log('Playwright MCP synthetic automatic-update fixture\nOptions: --version --help');
    else process.exit(24);
  }}
}};
program.version('Version ' + version);
program.parseAsync(process.argv);
"#, version=json!(version), calls=json!(calls))),
        ])
    };
    let old_contents = files("1");
    let next_contents = files("2");
    let mut owned = Vec::new();
    for (relative, contents) in &old_contents {
        let path = original_root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, contents).unwrap();
        owned.push(OwnedFile {
            path: relative.clone(),
            role: if relative == "LICENSE" {
                FileRole::License
            } else {
                FileRole::Runtime
            },
            installed_sha256: resource_files::fingerprint(&path).unwrap().sha256,
        });
    }
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (relative, contents) in &next_contents {
        zip.start_file(relative, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(contents.as_bytes()).unwrap();
    }
    let bytes = zip.finish().unwrap().into_inner();
    let archive_hash = format!("{:x}", Sha256::digest(&bytes));
    let repository = "https://github.com/microsoft/playwright-mcp";
    let asset_name = "synthetic-automatic.zip";
    let installation = serde_json::from_value(json!({
        "schemaVersion":1,"installedAt":now(),"archivePath":dir.path().join("v1.zip"),
        "archiveSha256":"a".repeat(64),"sourceRepository":repository,"sourceVersion":"v1",
        "downloadSource":{"repository":repository,"version":"v1","verification":"githubAsset",
            "author":"microsoft","releaseId":22,"assetId":33,"assetName":asset_name,
            "downloadUrl":format!("{repository}/releases/download/v1/{asset_name}"),
            "sha256":"a".repeat(64),"expectedSha256":null},
        "files":owned,"systemEntries":[],"status":"installed","error":null
    }))
    .unwrap();
    let record = ResourceRecord {
        id: "synthetic-automatic-edge".into(),
        name: "Synthetic automatic fixture".into(),
        kind: "cli".into(),
        root_path: original_root.to_string_lossy().into_owned(),
        repository: Some(repository.into()),
        version: Some("v1".into()),
        source_binding: Some(crate::resource_source::SourceBinding {
            repository: repository.into(),
            repository_id: 11,
            verified_at: now(),
            asset: Some(crate::resource_source::AssetMapping {
                release_id: 22,
                asset_id: 33,
                tag: "v1".into(),
                asset_name: asset_name.into(),
                size: 10,
                digest: None,
                url: format!("{repository}/releases/download/v1/{asset_name}"),
                updated_at: now(),
            }),
        }),
        source_history: vec![],
        alias: "Preserved alias".into(),
        notes: "Preserved notes".into(),
        enabled: true,
        ownership: "managedFiles".into(),
        management_scope: "ownedFiles".into(),
        actions: vec![
            json!({"id":"version","label":"Synthetic CLI version","mode":"task",
            "executable":node,"executableSha256":node_before.sha256,
            "workingDirectory":crate::local::canonical(&original_root).unwrap(),
            "args":[{"type":"literal","value":crate::local::canonical(&original_root.join("node_modules/@playwright/mcp/cli.js")).unwrap()},
                {"type":"literal","value":"--version"}],"parameters":[]}),
        ],
        capabilities: vec![json!({"id":"cliVersion","status":"unverified"})],
        update_policy: json!({"mode":"manual","intervalHours":24,"pinnedVersion":null,"skippedVersions":[]}),
        installation: Some(installation),
        revision: 1,
        created_at: now(),
        updated_at: now(),
    };
    manager
        .resource_store(Catalog::Insert(Box::new(record.clone())))
        .unwrap();
    let roles: BTreeMap<_, _> = record
        .installation
        .as_ref()
        .unwrap()
        .files
        .iter()
        .map(|file| (file.path.clone(), file.role.clone()))
        .collect();
    let preview = super::super::preview_local(&mut manager, &json!({
        "action":"preview_resource_automation","resourceId":record.id,"expectedRevision":record.revision,
        "enabled":true,"candidateParentPath":parent,"downloadDirectory":downloads,
        "channel":"stable","assetName":asset_name,"selectedFiles":roles.keys().collect::<Vec<_>>(),"fileRoles":roles
    })).unwrap().unwrap();
    super::super::apply_local(
        &mut manager,
        &json!({"action":"apply_resource_automation","previewId":preview["id"]}),
    )
    .unwrap()
    .unwrap();
    seed_observation(&manager, &record.id, Utc::now() - Duration::minutes(1)).unwrap();

    let release = |version: &str, release_id: u64, asset_id: u64, published: &str| {
        json!({
            "id":release_id,"tag_name":version,"name":"Synthetic stable release","draft":false,
            "prerelease":false,"author":{"login":"microsoft"},"html_url":format!("{repository}/releases/tag/{version}"),
            "published_at":published,"assets":[{"id":asset_id,"name":asset_name,"size":bytes.len(),"state":"uploaded",
                "digest":format!("sha256:{archive_hash}"),"updated_at":published,
                "browser_download_url":format!("{repository}/releases/download/{version}/{asset_name}")}]
        })
    };
    let source = crate::resource_github::automation_fixture::register(
        &manager,
        repository,
        11,
        vec![
            release("v1", 22, 33, "2026-10-28T00:00:00Z"),
            release("v2", 44, 55, "2026-10-29T00:00:00Z"),
        ],
        bytes.clone(),
    );
    {
        let _context = crate::resource_github::automation_fixture::enter(&manager);
        assert!(crate::resource_github::automation_fixture::source_metadata(
            "https://github.com/unexpected/source",
            None,
        )
        .unwrap()
        .is_err());
    }
    assert!(
        crate::resource_github::automation_fixture::source_metadata(repository, None).is_none()
    );
    let service = TaskSystem::new(manager).unwrap();
    let result = run_due(&service).unwrap();
    assert_eq!(result["results"][0]["complete"], true, "{result}");
    assert_eq!(result["results"][0]["switched"], true);
    assert_eq!(result["results"][0]["postSwitchVerified"], true);
    assert_eq!(result["results"][0]["authorizationAdvanced"], true);
    assert_eq!(source.transfers(), vec![(0, bytes.len() as u64 - 1)]);
    let state = service
        .execute(
            json!({"action":"resource_update_state","id":record.id}),
            crate::dispatch,
        )
        .unwrap();
    let current: ResourceRecord = serde_json::from_value(state["resource"].clone()).unwrap();
    let target = PathBuf::from(&current.root_path);
    assert_eq!(current.version.as_deref(), Some("v2"));
    assert_eq!(target.parent(), Some(parent.as_path()));
    assert_ne!(target, original_root);
    assert_eq!(current.alias, record.alias);
    assert_eq!(current.notes, record.notes);
    assert_eq!(
        current.actions[0]["args"][0]["value"]
            .as_str()
            .map(Path::new),
        Some(
            crate::local::canonical(&target.join("node_modules/@playwright/mcp/cli.js"))
                .unwrap()
                .as_path()
        )
    );
    for (relative, contents) in &next_contents {
        assert_eq!(
            fs::read_to_string(target.join(relative)).unwrap(),
            *contents
        );
    }
    for (relative, contents) in &old_contents {
        assert_eq!(
            fs::read_to_string(original_root.join(relative)).unwrap(),
            *contents
        );
    }
    assert_eq!(
        resource_files::fingerprint(&user_data).unwrap(),
        user_data_before
    );
    assert_eq!(resource_files::fingerprint(&node).unwrap(), node_before);
    let installed = current.installation.as_ref().unwrap();
    assert_eq!(installed.archive_sha256, archive_hash);
    assert_eq!(fs::read(&installed.archive_path).unwrap(), bytes);
    assert!(state["updateState"]["candidate"].is_null());
    assert_eq!(state["updateState"]["switchCheck"]["status"], "passed");
    assert_eq!(
        state["updateState"]["previous"].as_array().unwrap().len(),
        1
    );
    let invocations: Vec<Value> = fs::read_to_string(&calls)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(invocations.len(), 4);
    for (call, argument) in invocations
        .iter()
        .zip(["--version", "--help", "--version", "--help"])
    {
        assert_eq!(call["version"], "2");
        assert_eq!(call["argument"], argument);
        assert!(call["pid"]
            .as_u64()
            .is_some_and(|pid| pid != std::process::id() as u64));
        assert_eq!(
            crate::local::canonical(Path::new(call["cwd"].as_str().unwrap())).unwrap(),
            crate::local::canonical(&target).unwrap()
        );
    }
    let status = service
        .execute(
            json!({"action":"resource_automation_status","resourceId":record.id}),
            crate::dispatch,
        )
        .unwrap();
    assert_eq!(status["attempts"].as_array().unwrap().len(), 1);
    assert_eq!(status["attempts"][0]["status"], "completed");
    assert_eq!(status["attempts"][0]["phase"], "complete");
    assert_eq!(
        status["authorization"]["scope"]["originalRoot"]
            .as_str()
            .map(Path::new),
        Some(target.as_path())
    );
    assert!(run_due(&service).unwrap()["results"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(source.transfers().len(), 1);
    assert_eq!(fs::read_to_string(&calls).unwrap().lines().count(), 4);
}
