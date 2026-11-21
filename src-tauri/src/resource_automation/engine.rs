//! Server-only automatic update coordinator. Every phase is a separate task;
//! metadata and downloads never hold the resource catalogue write lock.
use super::*;
use crate::tasks::TaskSystem;
use chrono::{DateTime, Duration, Utc};
use std::sync::Arc;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Attempt {
    pub key: String,
    pub id: String,
    pub resource_id: String,
    pub grant_revision: u64,
    pub version: String,
    #[serde(default)]
    pub source_check_revision: u64,
    #[serde(default)]
    pub source_key: String,
    #[serde(default)]
    pub resume_download_id: Option<String>,
    pub candidate_root: PathBuf,
    pub status: String,
    pub phase: String,
    pub created_at: String,
    pub updated_at: String,
    pub result: Value,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Context {
    resource_id: String,
    grant_revision: u64,
    version: String,
    #[serde(default)]
    source_check_revision: u64,
    #[serde(default)]
    source_key: String,
    #[serde(default)]
    attempt_id: Option<String>,
}

fn attempt_key(resource: &str, revision: u64, version: &str) -> String {
    hash(&json!([resource, revision, version]))
}
fn observed_key(
    resource: &str,
    grant_revision: u64,
    version: &str,
    source_key: &str,
    check_revision: u64,
) -> String {
    if check_revision == 0 {
        attempt_key(resource, grant_revision, version)
    } else {
        hash(&json!([
            resource,
            grant_revision,
            version,
            source_key,
            check_revision
        ]))
    }
}
pub(super) fn latest_attempt(
    db: &Connection,
    resource: &str,
    revision: u64,
    version: &str,
) -> Result<Option<Attempt>, String> {
    let exists:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='resource_automation_attempts')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !exists {
        return Ok(None);
    }
    db.query_row("SELECT payload FROM resource_automation_attempts WHERE resource_id=?1 AND json_extract(payload,'$.grantRevision')=?2 AND json_extract(payload,'$.version')=?3 ORDER BY rowid DESC LIMIT 1",params![resource,revision,version],|r|r.get::<_,String>(0)).optional().map_err(|e|e.to_string())?.map(|raw|serde_json::from_str(&raw).map_err(|_|"原自动更新尝试无法读取，未自动重放".into())).transpose()
}
#[derive(Clone)]
struct Observation {
    version: String,
    revision: u64,
    source_key: String,
    checked_at: DateTime<Utc>,
}
fn observation(
    value: &Value,
    record: &ResourceRecord,
    scope: &AutomationScope,
) -> Result<Option<Observation>, String> {
    if value["status"] != "checked"
        || value["source"]["repositoryId"] != scope.repository_id
        || value["source"]["channel"] != "stable"
        || value["source"]["repository"]
            .as_str()
            .is_none_or(|r| !r.eq_ignore_ascii_case(&scope.repository))
    {
        return Ok(None);
    }
    if let Some(package) = &scope.runtime_package {
        if value["source"]["runtimePackage"] != json!(package.recipe)
            || value["latest"]["metadataHash"]
                .as_str()
                .is_none_or(|h| h.len() != 64 || !h.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Ok(None);
        }
    } else if !value["source"]["runtimePackage"].is_null() {
        return Ok(None);
    }
    let checked_at =
        DateTime::parse_from_rfc3339(value["checkedAt"].as_str().ok_or("版本检查时间缺失")?)
            .map_err(|_| "版本检查时间无效")?
            .with_timezone(&Utc);
    let age = Utc::now() - checked_at;
    if age < Duration::zero() || age > Duration::hours(24) {
        return Ok(None);
    }
    let Some(version) = value["latest"]["version"].as_str().filter(|v| {
        !v.is_empty()
            && v.len() <= 160
            && !v.chars().any(char::is_control)
            && record.version.as_deref() != Some(*v)
    }) else {
        return Ok(None);
    };
    if scope.runtime_package.is_some()
        && crate::resource_package::automation::require_newer(
            version.trim_start_matches('v'),
            record.version.as_deref().ok_or("原运行包版本未知")?,
        )
        .is_err()
    {
        return Ok(None);
    }
    let revision = value["revision"]
        .as_u64()
        .filter(|r| *r > 0)
        .ok_or("版本检查修订号无效")?;
    let source_key = value["source"]["key"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("来源检查标识无效")?;
    Ok(Some(Observation {
        version: version.into(),
        revision,
        source_key: source_key.into(),
        checked_at,
    }))
}
fn retry(previous: Option<&Attempt>, observation: &Observation) -> Result<Option<String>, String> {
    let Some(previous) = previous else {
        return Ok(None);
    };
    let ended = DateTime::parse_from_rfc3339(&previous.updated_at)
        .map_err(|_| "上次尝试结束时间未知，未自动重放")?
        .with_timezone(&Utc);
    if previous.status != "stopped"
        || !matches!(previous.phase.as_str(), "release" | "download")
        || observation.checked_at <= ended
        || (previous.source_check_revision > 0
            && (previous.source_key != observation.source_key
                || observation.revision <= previous.source_check_revision))
    {
        return Err("上次结果尚需处理或没有新的成功来源观察，未自动重放".into());
    }
    // A newer source observation is not consent to continue an interrupted
    // transfer. Keep its receipt for the ordinary human-confirmed resume flow.
    if previous.phase == "release"
        && previous.result["changed"] == false
        && previous.resume_download_id.is_none()
        && [
            "downloadId",
            "archivePath",
            "partialPath",
            "candidatePath",
            "packageSessionId",
        ]
        .iter()
        .all(|key| previous.result[*key].is_null())
        && previous.result["receivedBytes"].as_u64().unwrap_or(0) == 0
    {
        return Ok(None);
    }
    Err("上次下载或候选已有处理记录，请本人重新预览并确认继续；未自动续传或重新下包".into())
}
fn validate_resume_record(
    value: &Value,
    id: &str,
    scope: &AutomationScope,
    version: &str,
) -> Result<(), String> {
    let prepared = &value["prepared"];
    let target = prepared["target"]
        .as_str()
        .map(Path::new)
        .ok_or("原下载目标不明，不能续传")?;
    if value["id"] != id
        || value["schemaVersion"] != 1
        || prepared["downloadId"] != id
        || prepared["repo"].as_str().is_none_or(|r| {
            !r.eq_ignore_ascii_case(scope.repository.trim_start_matches("https://github.com/"))
        })
        || prepared["tag"] != version
        || (if scope.runtime_package.is_some() {
            prepared["asset"]["name"]
                .as_str()
                .is_none_or(|n| !crate::resource_package::automation::reach_wheel_name(n, version))
        } else {
            prepared["asset"]["name"] != scope.asset_name
        })
        || target.parent().map(path_key) != Some(path_key(&scope.download_directory))
        || prepared["partial"].as_str() != Some(format!("{}.part", target.display()).as_str())
        || !matches!(
            value["status"].as_str(),
            Some("prepared" | "downloading" | "interrupted" | "failed" | "complete")
        )
    {
        return Err("原下载回执不属于当前许可、资产或目录，未创建新下载".into());
    }
    Ok(())
}
fn load_attempt(db: &Connection, key: &str) -> Result<Option<Attempt>, String> {
    db.query_row(
        "SELECT payload FROM resource_automation_attempts WHERE attempt_key=?1",
        [key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .map(|raw| serde_json::from_str(&raw).map_err(|_| "自动更新阶段记录损坏，未重放操作".into()))
    .transpose()
}
pub(super) fn attempts(db: &Connection, id: &str) -> Result<Value, String> {
    let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='resource_automation_attempts')", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if !exists {
        return Ok(json!({"attempts":[]}));
    }
    let mut statement = db.prepare("SELECT payload FROM resource_automation_attempts WHERE resource_id=?1 ORDER BY rowid DESC LIMIT 10").map_err(|e|e.to_string())?;
    let rows = statement
        .query_map([id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut records = Vec::new();
    for row in rows {
        records.push(
            serde_json::from_str::<Attempt>(&row.map_err(|e| e.to_string())?)
                .map_err(|_| "自动更新阶段记录无法读取")?,
        );
    }
    Ok(json!({"attempts":records}))
}
pub(super) fn claim(
    db: &Connection,
    expected: &ResourceRecord,
    grant_revision: u64,
    attempt: &Attempt,
    catalog_revision: u64,
) -> Result<Value, String> {
    if attempt.resource_id != expected.id
        || attempt.grant_revision != grant_revision
        || attempt.key
            != observed_key(
                &expected.id,
                grant_revision,
                &attempt.version,
                &attempt.source_key,
                attempt.source_check_revision,
            )
        || !matches!(attempt.status.as_str(), "running" | "stopped")
        || !matches!(attempt.phase.as_str(), "release" | "download")
        || attempt.resume_download_id.is_some()
        || attempt.id.is_empty()
    {
        return Err("自动更新尝试身份不符".into());
    }
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    let current =
        crate::resources::store(&tx, Catalog::Get(expected.id.clone()), catalog_revision)?;
    let current_grant = load(&tx, &expected.id)?
        .filter(|g| g.enabled && g.revision == grant_revision)
        .ok_or("自动更新授权已变化")?;
    if current != json!(expected)
        || expected.update_policy["mode"] != "automatic"
        || current_grant.scope.as_ref().is_none_or(|s| {
            attempt.candidate_root.parent() != Some(s.candidate_parent_path.as_path())
        })
    {
        return Err("自动更新开始前资源或目录许可已变化".into());
    }
    if let Some(previous) = load_attempt(&tx, &attempt.key)? {
        return Ok(json!({"claimed":false,"attempt":previous,"replayed":false}));
    }
    if attempt.source_check_revision > 0 {
        let scope = current_grant.scope.as_ref().ok_or("自动更新许可范围缺失")?;
        let stored = crate::resource_checks::store(
            &tx,
            crate::resource_checks::StoreRequest::Get(attempt.source_key.clone()),
        )?;
        let observed = observation(&stored, expected, scope)?
            .filter(|o| {
                o.source_key == attempt.source_key
                    && o.revision == attempt.source_check_revision
                    && o.version == attempt.version
            })
            .ok_or("来源观察已变化，未开始旧自动任务")?;
        let previous = latest_attempt(&tx, &expected.id, grant_revision, &attempt.version)?;
        let resumed = retry(previous.as_ref(), &observed)?;
        if resumed != attempt.resume_download_id {
            return Err("恢复下载身份已变化，未重复下包".into());
        }
        if let Some(id) = resumed.filter(|_| attempt.status == "running") {
            let stored = crate::resource_github::store(
                &tx,
                crate::resource_github::DownloadStore::Get(id.clone()),
            )?;
            validate_resume_record(&stored, &id, scope, &attempt.version)?;
        }
    }
    tx.execute("INSERT INTO resource_automation_attempts(attempt_key,resource_id,payload) VALUES(?1,?2,?3)", params![attempt.key, attempt.resource_id, serde_json::to_string(attempt).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(
        json!({"claimed":attempt.status=="running","attempt":attempt,"scope":current_grant.scope,"replayed":false}),
    )
}
pub(super) fn save_attempt(
    db: &Connection,
    expected: &Attempt,
    attempt: &Attempt,
) -> Result<Value, String> {
    if expected.key != attempt.key
        || expected.id != attempt.id
        || expected.resource_id != attempt.resource_id
        || expected.grant_revision != attempt.grant_revision
        || expected.version != attempt.version
        || expected.source_check_revision != attempt.source_check_revision
        || expected.source_key != attempt.source_key
        || expected.resume_download_id != attempt.resume_download_id
        || expected.candidate_root != attempt.candidate_root
        || expected.created_at != attempt.created_at
        || expected.status != "running"
        || !matches!(attempt.status.as_str(), "running" | "completed" | "stopped")
        || !matches!(
            attempt.phase.as_str(),
            "release"
                | "download"
                | "stage"
                | "resolve"
                | "packageDownload"
                | "materialize"
                | "packageCommit"
                | "verify"
                | "switch"
                | "complete"
        )
        || serde_json::to_vec(&attempt.result)
            .map_err(|e| e.to_string())?
            .len()
            > 16384
    {
        return Err("自动更新结果不匹配原尝试，未覆盖旧记录".into());
    }
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    if load_attempt(&tx, &expected.key)?.as_ref() != Some(expected) {
        return Err("自动更新阶段记录已变化".into());
    }
    tx.execute(
        "UPDATE resource_automation_attempts SET payload=?1 WHERE attempt_key=?2",
        params![
            serde_json::to_string(attempt).map_err(|e| e.to_string())?,
            attempt.key
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(
        json!({"saved":true,"attempt":attempt,"automaticResult":{"changed":attempt.result["changed"]==true,"resourceId":attempt.resource_id,"version":attempt.version,"status":attempt.status,"phase":attempt.phase}}),
    )
}

/// Shape recognition only. TaskSystem additionally requires this module's
/// dispatcher function identity; JSON alone never grants an internal route.
pub(crate) fn is_step(request: &Value) -> bool {
    request["automatic"] == true
        && matches!(
            request["action"].as_str(),
            Some(
                "__resource_automation_scan"
                    | "__resource_automation_claim"
                    | "__resource_automation_finish"
                    | "resource_github_releases"
                    | "preview_resource_download"
                    | "preview_resource_resume"
                    | "apply_resource_download"
                    | "preview_resource_update"
                    | "apply_resource_update_stage"
                    | "verify_resource_update"
                    | "preview_resource_update_switch"
                    | "apply_resource_update_switch"
                    | "resource_update_state"
                    | "preview_resource_package_prepare"
                    | "apply_resource_package_prepare"
                    | "preview_resource_package_download"
                    | "apply_resource_package_download"
                    | "preview_resource_package_resume"
                    | "apply_resource_package_resume"
                    | "preview_resource_package_materialize"
                    | "apply_resource_package_materialize"
                    | "preview_resource_package_commit"
                    | "apply_resource_package_commit"
            )
        )
}
fn context(request: &Value) -> Result<Context, String> {
    serde_json::from_value(request["automation"].clone())
        .map_err(|_| "内部自动更新上下文无效".into())
}
fn candidate(grant: &AutomationGrant, version: &str) -> Result<CandidateScope, String> {
    let scope = grant.scope.as_ref().ok_or("缺少自动更新范围")?;
    Ok(CandidateScope {
        repository: scope.repository.clone(),
        repository_id: scope.repository_id,
        version: if scope.runtime_package.is_some() {
            version.trim_start_matches('v').into()
        } else {
            version.into()
        },
        channel: scope.channel.clone(),
        asset_name: scope.asset_name.clone(),
        files: scope.files.clone(),
    })
}
fn latest(
    m: &Manager,
    record: &ResourceRecord,
    grant: &AutomationGrant,
) -> Result<Option<Observation>, String> {
    let observed = crate::resource_checks::handle(
        m,
        &json!({"action":"resource_version_check_status","id":record.id}),
    )?
    .ok_or("版本摘要不可读")?;
    let scope = grant.scope.as_ref().ok_or("许可范围缺失")?;
    observation(&observed["check"], record, scope)
}
fn scan(m: &Manager, request: &Value) -> Result<Value, String> {
    allowed(request, &["action", "automatic"])?;
    m.ensure_live_maintenance_allowed("基本模式不修改或执行自动更新许可")?;
    let grants = m.resource_automation_store(StoreRequest::List)?;
    let grants: Vec<AutomationGrant> = serde_json::from_value(grants["authorizations"].clone())
        .map_err(|_| "自动更新许可不可读")?;
    let mut jobs = Vec::new();
    for grant in grants.into_iter().filter(|g| g.enabled) {
        let record = match read(m, &grant.resource_id) {
            Ok(record) if record.enabled && record.update_policy["mode"] == "automatic" => record,
            _ => continue,
        };
        let Some(observed) = latest(m, &record, &grant)? else {
            continue;
        };
        let previous: Option<Attempt> =
            serde_json::from_value(m.resource_automation_store(StoreRequest::LatestAttempt {
                resource_id: record.id.clone(),
                grant_revision: grant.revision,
                version: observed.version.clone(),
            })?)
            .map_err(|_| "原尝试记录无法核对")?;
        if previous.as_ref().is_some_and(|p| {
            p.source_check_revision == observed.revision && p.source_key == observed.source_key
        }) || retry(previous.as_ref(), &observed).is_err()
        {
            continue;
        }
        jobs.push(json!(Context {
            resource_id: record.id,
            grant_revision: grant.revision,
            version: observed.version,
            source_check_revision: observed.revision,
            source_key: observed.source_key,
            attempt_id: None
        }));
    }
    Ok(json!({"jobs":jobs,"downloaded":false,"applied":false}))
}
fn attempt(m: &Manager, ctx: &Context) -> Result<Attempt, String> {
    let records = m.resource_automation_store(StoreRequest::Attempts(ctx.resource_id.clone()))?;
    let record = records["attempts"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|r| r["id"].as_str() == ctx.attempt_id.as_deref())
        })
        .ok_or("自动更新尝试不存在，未重放操作")?;
    let attempt: Attempt =
        serde_json::from_value(record.clone()).map_err(|_| "自动更新尝试格式无效")?;
    if attempt.resource_id != ctx.resource_id
        || attempt.grant_revision != ctx.grant_revision
        || attempt.version != ctx.version
        || attempt.source_check_revision != ctx.source_check_revision
        || attempt.source_key != ctx.source_key
        || attempt.status != "running"
    {
        return Err("自动更新尝试已结束或身份不符".into());
    }
    Ok(attempt)
}
fn finish(m: &Manager, request: &Value, ctx: &Context) -> Result<Value, String> {
    allowed(
        request,
        &[
            "action",
            "automatic",
            "automation",
            "phase",
            "status",
            "result",
        ],
    )?;
    normal(m)?;
    let old = attempt(m, ctx)?;
    let mut changed = old.clone();
    changed.phase = request["phase"].as_str().ok_or("缺少实际阶段")?.into();
    changed.status = request["status"].as_str().ok_or("缺少实际结果")?.into();
    changed.result = request["result"].clone();
    let package_sessions = if grant(m, &ctx.resource_id)?
        .and_then(|g| g.scope)
        .is_some_and(|s| s.runtime_package.is_some())
    {
        crate::resource_package::controller::automatic_attempt_sessions(m, &old.id)?
    } else {
        Vec::new()
    };
    if let Some(session) = package_sessions.into_iter().next() {
        changed.result["packageSessionId"] = session["id"].clone();
        changed.result["packageStatus"] = session["status"].clone();
        changed.result["packageRevision"] = session["revision"].clone();
        if session["downloadComplete"] == true
            || matches!(
                session["status"].as_str(),
                Some(
                    "preparing"
                        | "prepareFailed"
                        | "downloading"
                        | "downloadInterrupted"
                        | "downloaded"
                        | "materializing"
                        | "materialized"
                        | "materializationIncomplete"
                        | "failed"
                )
            )
        {
            changed.result["changed"] = json!(true);
        }
    }
    if changed.status != "running" {
        if let Some(id) = changed.result["downloadId"].as_str().map(str::to_owned) {
            let downloaded =
                m.download_store(crate::resource_github::DownloadStore::Get(id.clone()))?;
            if downloaded["id"] == id {
                let bytes = downloaded["prepared"]["progress"]["bytes"]
                    .as_u64()
                    .unwrap_or(0);
                changed.result["receivedBytes"] = json!(bytes);
                changed.result["downloadStatus"] = downloaded["status"].clone();
                if bytes > 0 || downloaded["status"] == "complete" {
                    changed.result["changed"] = json!(true);
                }
            }
        }
    }
    changed.updated_at = now();
    m.resource_automation_store(StoreRequest::SaveAttempt {
        expected: Box::new(old),
        attempt: Box::new(changed),
    })
}
fn check_preview(
    m: &Manager,
    business: &Value,
    ctx: &Context,
    kind: &str,
) -> Result<Value, String> {
    let id = business["previewId"].as_str().ok_or("缺少本次阶段预览")?;
    let cached = m.previews.get(id).ok_or("本次自动阶段预览已失效")?;
    if cached["kind"] != kind
        || cached["automationAttemptId"].as_str() != ctx.attempt_id.as_deref()
        || cached["public"]["canApply"] != true
    {
        return Err("预览不属于本次已授权尝试".into());
    }
    Ok(cached["public"].clone())
}
fn bind_preview(m: &mut Manager, result: &Value, ctx: &Context) -> Result<(), String> {
    let cached = m
        .previews
        .get_mut(result["id"].as_str().ok_or("阶段预览缺少标识")?)
        .ok_or("阶段预览不存在")?;
    cached["automationAttemptId"] = json!(ctx.attempt_id);
    Ok(())
}
fn validate_download(
    m: &Manager,
    plan: &Value,
    scope: &AutomationScope,
    ctx: &Context,
) -> Result<(), String> {
    if plan["repository"] != scope.repository
        || plan["version"] != ctx.version
        || (if scope.runtime_package.is_some() {
            plan["assetName"].as_str().is_none_or(|n| {
                !crate::resource_package::automation::reach_wheel_name(n, &ctx.version)
            })
        } else {
            plan["assetName"] != scope.asset_name
        })
        || plan["targetPath"]
            .as_str()
            .and_then(|p| Path::new(p).parent())
            .map(path_key)
            != Some(path_key(&scope.download_directory))
    {
        return Err("发行文件预览超出已选来源或下载位置".into());
    }
    if scope.runtime_package.is_some() {
        package_steps::validate_wheel_download(m, plan, scope, ctx)?;
    }
    Ok(())
}
fn validate_stage(
    plan: &Value,
    scope: &AutomationScope,
    ctx: &Context,
    attempt: &Attempt,
) -> Result<(), String> {
    let files: BTreeMap<String, FileRole> =
        serde_json::from_value(plan["files"].clone()).map_err(|_| "候选用途不可读")?;
    if plan["resourceId"] != ctx.resource_id
        || plan["version"] != ctx.version
        || plan["targetPath"].as_str().map(Path::new).map(path_key)
            != Some(path_key(&attempt.candidate_root))
        || files != scope.files
        || plan["canApply"] != true
    {
        return Err("候选需要新增文件、权限或改变保存位置，已暂停自动应用".into());
    }
    Ok(())
}

fn recovery_result(previous: Option<&Attempt>, download_id: Option<&str>) -> Value {
    let mut result = json!({"changed":false});
    if let (Some(previous), Some(id)) = (previous, download_id) {
        result["changed"] = json!(previous.result["changed"] == true);
        result["downloadId"] = json!(id);
        for key in ["archivePath", "partialPath"] {
            if let Some(path) = previous.result[key].as_str() {
                result[key] = json!(path);
            }
        }
        if let Some(bytes) = previous.result["receivedBytes"].as_u64() {
            result["receivedBytes"] = json!(bytes);
        }
    }
    result
}

fn create_claim(
    m: &Manager,
    request: &Value,
    ctx: &Context,
    authorization: &AutomationGrant,
    target: &CandidateScope,
) -> Result<Value, String> {
    allowed(request, &["action", "automatic", "automation"])?;
    if ctx.attempt_id.is_some() {
        return Err("不能复用旧自动更新尝试".into());
    }
    let record = read(m, &ctx.resource_id)?;
    let observed = latest(m, &record, authorization)?
        .filter(|o| {
            o.version == ctx.version
                && o.revision == ctx.source_check_revision
                && o.source_key == ctx.source_key
        })
        .ok_or("最新成功来源观察已失效，未下载或应用")?;
    let scope = authorization.scope.as_ref().ok_or("许可范围缺失")?;
    let previous: Option<Attempt> =
        serde_json::from_value(m.resource_automation_store(StoreRequest::LatestAttempt {
            resource_id: record.id.clone(),
            grant_revision: ctx.grant_revision,
            version: ctx.version.clone(),
        })?)
        .map_err(|_| "原自动尝试不可读")?;
    let key = observed_key(
        &ctx.resource_id,
        ctx.grant_revision,
        &ctx.version,
        &observed.source_key,
        observed.revision,
    );
    if previous.as_ref().is_some_and(|p| p.key == key) {
        return Ok(json!({"claimed":false,"replayed":false,"attempt":previous}));
    }
    let resumed = retry(previous.as_ref(), &observed)?;
    let mut blocked = authorize(m, &ctx.resource_id, target, Phase::BeforeDownload).err();
    if let Some(id) = &resumed {
        let value = m.download_store(crate::resource_github::DownloadStore::Get(id.clone()))?;
        if let Err(error) = validate_resume_record(&value, id, scope, &ctx.version) {
            blocked = Some(error);
        }
    }
    let mut result = recovery_result(previous.as_ref(), resumed.as_deref());
    if blocked.is_some() {
        result["message"]=json!("本次新的来源观察已重新核对；当前文件、运行状态或下载回执不满足自动应用条件，未执行后续阶段。");
        result["admissionRejected"] = json!(true);
    }
    let stamp = now();
    let attempt = Attempt {
        key,
        id: uuid::Uuid::new_v4().to_string(),
        resource_id: ctx.resource_id.clone(),
        grant_revision: ctx.grant_revision,
        version: ctx.version.clone(),
        source_check_revision: observed.revision,
        source_key: observed.source_key,
        resume_download_id: resumed,
        candidate_root: scope
            .candidate_parent_path
            .join(format!("runtime-{}", uuid::Uuid::new_v4())),
        status: if blocked.is_some() {
            "stopped"
        } else {
            "running"
        }
        .into(),
        phase: "release".into(),
        created_at: stamp.clone(),
        updated_at: stamp,
        result,
    };
    m.resource_automation_store(StoreRequest::ClaimAttempt {
        expected_resource: Box::new(record),
        expected_grant_revision: ctx.grant_revision,
        attempt: Box::new(attempt),
    })
}

/// Called only by TaskSystem's private dispatcher selection, never lib IPC/MCP.
pub(crate) fn dispatch_step(m: &mut Manager, request: &Value) -> Result<Value, String> {
    #[cfg(test)]
    let _fixture = crate::resource_github::automation_fixture::enter(m);
    if !is_step(request) {
        return Err("未知的内部自动更新阶段".into());
    }
    if request["action"] == "__resource_automation_scan" {
        return scan(m, request);
    }
    let ctx = context(request)?;
    if request["action"] == "__resource_automation_finish" {
        return finish(m, request, &ctx);
    }
    let current_grant = grant(m, &ctx.resource_id)?
        .filter(|g| g.revision == ctx.grant_revision && g.enabled)
        .ok_or("此自动更新许可已被修改或撤回")?;
    let target = candidate(&current_grant, &ctx.version)?;
    let action = request["action"].as_str().ok_or("缺少自动阶段")?;
    if action == "__resource_automation_claim" {
        return create_claim(m, request, &ctx, &current_grant, &target);
    }
    let phase = if matches!(
        action,
        "verify_resource_update"
            | "preview_resource_update_switch"
            | "apply_resource_update_switch"
    ) {
        Phase::BeforeCommit
    } else {
        Phase::BeforeDownload
    };
    let authorization = authorize(m, &ctx.resource_id, &target, phase)?;
    let scope = authorization.scope.as_ref().ok_or("许可范围缺失")?;
    let attempt = attempt(m, &ctx)?;
    if attempt.resume_download_id.is_some() {
        return Err("旧自动续传尝试需由本人重新预览并确认，原下载记录和部分文件保留".into());
    }
    let mut business = request.clone();
    let object = business.as_object_mut().ok_or("阶段请求无效")?;
    object.remove("automatic");
    object.remove("automation");
    if action.contains("resource_package_") {
        return package_steps::dispatch(m, request, &business, &ctx, scope, &attempt);
    }
    if scope.runtime_package.is_some() {
        package_steps::validate_observation(m, scope, &ctx)?;
    }
    if matches!(
        action,
        "preview_resource_update"
            | "verify_resource_update"
            | "preview_resource_update_switch"
            | "resource_update_state"
    ) && business["id"] != ctx.resource_id
    {
        return Err("自动阶段资源不符".into());
    }
    let result = match action {
        "resource_update_state" => {
            crate::resource_update::handle(m, &business)?.ok_or("当前运行记录不可读")?
        }
        "preview_resource_resume" => {
            if business["downloadId"].as_str() != attempt.resume_download_id.as_deref() {
                return Err("续传请求不属于原下载，未新建下载".into());
            }
            let stored = m.download_store(crate::resource_github::DownloadStore::Get(
                attempt.resume_download_id.clone().ok_or("没有可恢复下载")?,
            ))?;
            validate_resume_record(
                &stored,
                business["downloadId"].as_str().ok_or("缺少原下载标识")?,
                scope,
                &ctx.version,
            )?;
            let result = crate::resource_github::handle(m, &business)?.ok_or("续传预览不可用")?;
            validate_download(m, &result, scope, &ctx)?;
            bind_preview(m, &result, &ctx)?;
            result
        }
        "resource_github_releases" => {
            if business["repository"] != scope.repository || business["tag"] != ctx.version {
                return Err("版本请求超出授权来源".into());
            }
            let identity = crate::resource_github::source_metadata(&scope.repository, None)?;
            if identity.repository_id != scope.repository_id {
                return Err("GitHub仓库身份已变化，未自动替换来源".into());
            }
            let result = crate::resource_github::handle(m, &business)?.ok_or("发行读取不可用")?;
            if scope.runtime_package.is_some() {
                package_steps::select_reach(m, &result, scope, &ctx)?;
                return Ok(result);
            }
            let (release_id, _) = select_release(&result, &scope.asset_name, &ctx.version)?;
            let current = read(m, &ctx.resource_id)?;
            let installed = current
                .installation
                .as_ref()
                .and_then(|i| i.download_source.as_ref())
                .ok_or("原版本没有可核实的发行回执，不能自动判断升级先后")?;
            let old_version = current.version.as_deref().ok_or("原版本未知")?;
            let old = crate::resource_github::handle(m, &json!({"action":"resource_github_releases","repository":scope.repository,"tag":old_version}))?.ok_or("原固定发行版不可读")?;
            ensure_newer_release(
                &result,
                &old,
                release_id,
                installed.release_id,
                &ctx.version,
                old_version,
            )?;
            result
        }
        "preview_resource_download" => {
            if attempt.resume_download_id.is_some() {
                return Err("已有固定下载回执，只允许校验并续传原下载，不重复下包".into());
            }
            if business["repository"] != scope.repository
                || business["downloadDirectory"]
                    .as_str()
                    .map(Path::new)
                    .map(path_key)
                    != Some(path_key(&scope.download_directory))
            {
                return Err("下载请求超出许可位置".into());
            }
            let result = crate::resource_github::handle(m, &business)?.ok_or("下载预览不可用")?;
            validate_download(m, &result, scope, &ctx)?;
            bind_preview(m, &result, &ctx)?;
            result
        }
        "apply_resource_download" => {
            let plan = check_preview(m, &business, &ctx, "resourceDownload")?;
            validate_download(m, &plan, scope, &ctx)?;
            crate::resource_github::apply_local(m, &business)?.ok_or("下载应用不可用")?
        }
        "preview_resource_update" => {
            let result = crate::resource_update::handle(m, &business)?.ok_or("候选预览不可用")?;
            validate_stage(&result, scope, &ctx, &attempt)?;
            bind_preview(m, &result, &ctx)?;
            result
        }
        "apply_resource_update_stage" => {
            let plan = check_preview(m, &business, &ctx, "resourceUpdateStage")?;
            validate_stage(&plan, scope, &ctx, &attempt)?;
            m.begin_automatic_commit(request)?;
            crate::resource_update::apply_local(m, &business)?.ok_or("候选准备不可用")?
        }
        "verify_resource_update" => {
            crate::resource_probe::apply_local(m, &business)?.ok_or("隔离验证不可用")?
        }
        "preview_resource_update_switch" => {
            let result = crate::resource_update::handle(m, &business)?.ok_or("切换预览不可用")?;
            if result["targetPath"].as_str().map(Path::new).map(path_key)
                != Some(path_key(&attempt.candidate_root))
                || result["resourceId"] != ctx.resource_id
                || result["version"] != ctx.version
                || result["canApply"] != true
            {
                return Err("当前候选不能自动切换".into());
            }
            bind_preview(m, &result, &ctx)?;
            result
        }
        "apply_resource_update_switch" => {
            let plan = check_preview(m, &business, &ctx, "resourceUpdateSwitch")?;
            if plan["resourceId"] != ctx.resource_id
                || plan["targetPath"].as_str().map(Path::new).map(path_key)
                    != Some(path_key(&attempt.candidate_root))
                || plan["version"] != ctx.version
            {
                return Err("切换预览不匹配本次候选".into());
            }
            m.begin_automatic_commit(request)?;
            let mut result =
                crate::resource_update::apply_local(m, &business)?.ok_or("切换应用不可用")?;
            if result["complete"] == true
                && result["switched"] == true
                && result["postSwitchVerified"] == true
            {
                match advance(m, &authorization, &attempt, &result) {
                    Ok(saved) => {
                        result["resource"] = saved["resource"].clone();
                        result["authorizationAdvanced"] = json!(true);
                    }
                    Err(_) => {
                        result["authorizationAdvanced"] = json!(false);
                        result["authorizationNotice"] = json!(
                            "本次实际切换及核验已完成；后续自动许可未推进，需重新核对当前范围。"
                        );
                    }
                }
            }
            result
        }
        _ => return Err("不支持的自动更新阶段".into()),
    };
    Ok(result)
}

fn ensure_newer_release(
    target: &Value,
    installed: &Value,
    target_id: u64,
    installed_id: u64,
    target_version: &str,
    installed_version: &str,
) -> Result<(), String> {
    fn published(value: &Value, id: u64, version: &str) -> Result<DateTime<Utc>, String> {
        let matching: Vec<_> = value["releases"]
            .as_array()
            .ok_or("固定发行信息不可读")?
            .iter()
            .filter(|r| r["id"] == id && r["tag"] == version)
            .collect();
        if matching.len() != 1 {
            return Err("固定发行身份已变化，不能自动猜测更新顺序".into());
        }
        DateTime::parse_from_rfc3339(
            matching[0]["publishedAt"]
                .as_str()
                .ok_or("发行发布时间缺失")?,
        )
        .map(|t| t.with_timezone(&Utc))
        .map_err(|_| "发行发布时间无效".into())
    }
    if target_id == installed_id
        || published(target, target_id, target_version)?
            <= published(installed, installed_id, installed_version)?
    {
        return Err("目标不是在当前固定发行版之后发布，自动更新已暂停；如需降级请手动核对".into());
    }
    Ok(())
}

fn advance(
    m: &Manager,
    previous: &AutomationGrant,
    attempt: &Attempt,
    receipt: &Value,
) -> Result<Value, String> {
    let current = read(m, &previous.resource_id)?;
    if receipt["resource"] != json!(current)
        || receipt["complete"] != true
        || receipt["switched"] != true
        || receipt["postSwitchVerified"] != true
        || Path::new(&current.root_path).parent() != attempt.candidate_root.parent()
        || path_key(Path::new(&current.root_path)) != path_key(&attempt.candidate_root)
        || current.version.as_deref()
            != Some(
                if previous
                    .scope
                    .as_ref()
                    .is_some_and(|s| s.runtime_package.is_some())
                {
                    attempt.version.trim_start_matches('v')
                } else {
                    attempt.version.as_str()
                },
            )
    {
        return Err("当前记录与实际切换回执不一致".into());
    }
    let state = serde_json::to_value(
        current
            .installation
            .as_ref()
            .and_then(|i| i.update_state.as_ref()),
    )
    .map_err(|e| e.to_string())?;
    if state["switchCheck"]["status"] != "passed"
        || state["switchCheck"]["attemptId"]
            .as_str()
            .is_none_or(|v| v.is_empty())
    {
        return Err("切换尚无完成的实测记录".into());
    }
    if grant(m, &current.id)?.as_ref().map(|g| json!(g)) != Some(json!(previous)) {
        return Err("切换期间用户已修改自动许可".into());
    }
    let facts = facts(m, &current, false)?;
    let old = previous.scope.as_ref().ok_or("原许可范围缺失")?;
    if facts.repository_id != old.repository_id
        || !facts.repository.eq_ignore_ascii_case(&old.repository)
        || facts.source_fingerprint != old.source_fingerprint
        || (old.runtime_package.is_none() && facts.files != old.files)
        || facts.asset_name != old.asset_name
        || facts.pinned_version != old.pinned_version
        || facts.skipped_versions != old.skipped_versions
    {
        return Err("切换后的来源或权限超出原许可".into());
    }
    let mut next = previous.clone();
    next.revision = next.revision.checked_add(1).ok_or("许可修订号超出范围")?;
    next.updated_at = now();
    let scope = next.scope.as_mut().ok_or("原许可范围缺失")?;
    scope.original_root = PathBuf::from(&current.root_path);
    scope.original_root_id = facts.root_id;
    scope.constraint_fingerprint = facts.constraint_fingerprint;
    if scope.runtime_package.is_some() {
        scope.files = facts.files;
    }
    m.resource_automation_store(StoreRequest::Apply {
        expected_resource: Box::new(current),
        expected_grant_revision: previous.revision,
        grant: Box::new(next),
    })
}
fn select_release(value: &Value, asset_name: &str, version: &str) -> Result<(u64, u64), String> {
    let releases = value["releases"].as_array().ok_or("发行列表不可读")?;
    let matched: Vec<_> = releases
        .iter()
        .filter(|r| r["tag"] == version && r["prerelease"] == false)
        .collect();
    if matched.len() != 1 {
        return Err("稳定发行版本不唯一或已失效".into());
    }
    let release = matched[0];
    let assets: Vec<_> = release["assets"]
        .as_array()
        .ok_or("发行文件缺失")?
        .iter()
        .filter(|a| a["name"] == asset_name && a["unavailableReason"].is_null())
        .collect();
    if assets.len() != 1 {
        return Err("授权发行文件缺失或不唯一，未自动换用其他文件".into());
    }
    Ok((
        release["id"].as_u64().ok_or("发行标识无效")?,
        assets[0]["id"].as_u64().ok_or("发行文件标识无效")?,
    ))
}

fn wrap(mut request: Value, ctx: &Context) -> Value {
    request["automatic"] = json!(true);
    request["automation"] = json!(ctx);
    request
}
fn progress(
    execute: &mut dyn FnMut(Value) -> Result<Value, String>,
    ctx: &Context,
    phase: &str,
    status: &str,
    result: Value,
) -> Result<Value, String> {
    execute(wrap(
        json!({"action":"__resource_automation_finish","phase":phase,"status":status,"result":result}),
        ctx,
    ))
}
fn run_one_with(
    mut ctx: Context,
    execute: &mut dyn FnMut(Value) -> Result<Value, String>,
) -> Result<Value, String> {
    let claim = execute(wrap(json!({"action":"__resource_automation_claim"}), &ctx))?;
    if claim["claimed"] != true {
        return Ok(json!({"resourceId":ctx.resource_id,"skipped":true,"replayed":false}));
    }
    let attempt: Attempt =
        serde_json::from_value(claim["attempt"].clone()).map_err(|_| "新尝试记录无效")?;
    let scope: AutomationScope =
        serde_json::from_value(claim["scope"].clone()).map_err(|_| "新尝试范围无效")?;
    ctx.attempt_id = Some(attempt.id.clone());
    let mut phase = "release";
    let mut retained = if attempt.result.is_object() {
        attempt.result.clone()
    } else {
        json!({"changed":false})
    };
    let outcome = (|| {
        if attempt.resume_download_id.is_some() {
            return Err("旧自动续传尝试需由本人重新预览并确认，原下载记录和部分文件保留".into());
        }
        let staged = if scope.runtime_package.is_some() {
            package_steps::prepare(execute, &ctx, &scope, &attempt, &mut phase, &mut retained)?
        } else {
            let release = execute(wrap(
                json!({"action":"resource_github_releases","repository":scope.repository,"tag":ctx.version}),
                &ctx,
            ))?;
            let (release_id, asset_id) = select_release(&release, &scope.asset_name, &ctx.version)?;
            phase = "download";
            progress(execute, &ctx, phase, "running", retained.clone())?;
            let preview = execute(wrap(
                if let Some(download_id) = &attempt.resume_download_id {
                    json!({"action":"preview_resource_resume","downloadId":download_id})
                } else {
                    json!({"action":"preview_resource_download","repository":scope.repository,"releaseId":release_id,"assetId":asset_id,"downloadDirectory":scope.download_directory})
                },
                &ctx,
            ))?;
            // Persist the exact server-generated transfer identity before the first
            // byte. A later observation can only resume this existing receipt.
            retained["downloadId"] = preview["downloadId"].clone();
            retained["archivePath"] = preview["targetPath"].clone();
            retained["partialPath"] = preview["partialPath"].clone();
            progress(execute, &ctx, phase, "running", retained.clone())?;
            let downloaded = execute(wrap(
                json!({"action":"apply_resource_download","previewId":preview["id"]}),
                &ctx,
            ))?;
            if downloaded["complete"] != true {
                return Err("发行文件下载尚未完成，部分文件保留".into());
            }
            retained = json!({"changed":true,"downloadId":downloaded["downloadId"],"archivePath":downloaded["archivePath"],"candidatePath":attempt.candidate_root});
            phase = "stage";
            progress(execute, &ctx, phase, "running", retained.clone())?;
            // The server's claim bound the source baseline. The stage preview also
            // performs its own current revision and file-content comparison.
            let status = execute(wrap(
                json!({"action":"resource_update_state","id":ctx.resource_id}),
                &ctx,
            ))?;
            let preview = execute(wrap(
                json!({"action":"preview_resource_update","id":ctx.resource_id,"expectedRevision":status["resource"]["revision"],"archivePath":downloaded["archivePath"],"downloadId":downloaded["downloadId"],"destinationPath":attempt.candidate_root,"version":ctx.version,"selectedFiles":scope.files.keys().collect::<Vec<_>>(),"fileRoles":scope.files}),
                &ctx,
            ))?;
            let staged = execute(wrap(
                json!({"action":"apply_resource_update_stage","previewId":preview["id"]}),
                &ctx,
            ))?;
            if staged["complete"] != true {
                return Err("候选准备未完成，当前版本及部分候选原位保留".into());
            }
            staged
        };
        phase = "verify";
        progress(execute, &ctx, phase, "running", retained.clone())?;
        let verified = execute(wrap(
            json!({"action":"verify_resource_update","id":ctx.resource_id,"expectedRevision":staged["resource"]["revision"]}),
            &ctx,
        ))?;
        if verified["verified"] != true {
            return Err("候选隔离验证未通过，未切换入口".into());
        }
        phase = "switch";
        progress(execute, &ctx, phase, "running", retained.clone())?;
        let preview = execute(wrap(
            json!({"action":"preview_resource_update_switch","id":ctx.resource_id,"expectedRevision":verified["resource"]["revision"]}),
            &ctx,
        ))?;
        let switched = execute(wrap(
            json!({"action":"apply_resource_update_switch","previewId":preview["id"]}),
            &ctx,
        ))?;
        retained["switched"] = switched["switched"].clone();
        retained["postSwitchVerified"] = switched["postSwitchVerified"].clone();
        retained["rolledBack"] = switched["rolledBack"].clone();
        retained["authorizationAdvanced"] = switched["authorizationAdvanced"].clone();
        if switched["complete"] != true || switched["postSwitchVerified"] != true {
            return Err("切换核验未完成，已记录实际入口和恢复结果，请查看对应任务".into());
        }
        Ok(switched)
    })();
    match outcome {
        Ok(value) => {
            progress(execute, &ctx, "complete", "completed", retained)?;
            Ok(
                json!({"resourceId":ctx.resource_id,"version":ctx.version,"complete":true,"switched":true,"postSwitchVerified":true,"authorizationAdvanced":value["authorizationAdvanced"]}),
            )
        }
        Err(error) => {
            // The journal contains a bounded generic summary; the actual phase
            // task retains its redacted error. It cannot replay file operations.
            retained["message"] = if phase == "download" || attempt.resume_download_id.is_some() {
                json!("下载已停止，原下载记录和部分文件保留；请本人重新预览并确认继续，未自动续传或重新下包。")
            } else {
                json!(format!(
                    "自动更新在 {phase} 阶段停止；请查看对应任务，未自动重放。"
                ))
            };
            let recorded = progress(execute, &ctx, phase, "stopped", retained).is_ok();
            Err(if recorded {
                error
            } else {
                format!("{error}；阶段结果记录未完成，原尝试仍禁止自动重放")
            })
        }
    }
}
/// Scheduler entry. It does not retain any catalogue or execution lock while
/// awaiting nested tasks. Each phase obtains only its own normal task locks.
pub(crate) fn run_due(service: &Arc<TaskSystem>) -> Result<Value, String> {
    let scan = service.execute_automatic_resource_step(
        json!({"action":"__resource_automation_scan","automatic":true}),
    )?;
    let jobs: Vec<Context> =
        serde_json::from_value(scan["jobs"].clone()).map_err(|_| "自动更新任务列表无效")?;
    let mut results = Vec::new();
    for job in jobs {
        let id = job.resource_id.clone();
        match run_one_with(job,&mut |request| service.execute_automatic_resource_step(request)){Ok(result)=>results.push(result),Err(_)=>results.push(json!({"resourceId":id,"complete":false,"message":"自动更新未完成；对应阶段任务与保留文件可查看，未重复应用。"}))}
    }
    Ok(
        json!({"results":results,"automaticResult":{"changed":results.iter().any(|r|r["switched"]==true)}}),
    )
}

#[cfg(test)]
#[path = "engine_tests.rs"]
mod tests;

#[path = "engine_package.rs"]
mod package_steps;
