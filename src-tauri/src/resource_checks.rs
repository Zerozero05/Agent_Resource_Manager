//! Source-scoped version observations only. No package download, installation,
//! runtime switch, capability evidence or ownership is produced here.
use crate::{
    model::Manager,
    remote::github,
    resource_source::SourceBinding,
    resources::{ResourceRecord, StoreRequest as ResourceStore},
};
use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

const CHANNEL: &str = "stable";
const INTERVAL_HOURS: i64 = 24;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckSource {
    pub key: String,
    pub repository: String,
    pub repository_id: u64,
    pub channel: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_package: Option<crate::resource_package::Recipe>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReleaseSummary {
    pub version: String,
    pub url: String,
    pub published_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata_hash: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckRecord {
    pub source: CheckSource,
    pub revision: u64,
    pub checked_at: String,
    pub next_check_at: String,
    pub failures: u32,
    pub status: String,
    pub message: String,
    pub latest: Option<ReleaseSummary>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckTarget {
    pub id: String,
    pub revision: u64,
    pub source_key: String,
}
pub(crate) enum StoreRequest {
    Get(String),
    List,
    Save {
        record: Box<CheckRecord>,
        expected_revision: u64,
        targets: Vec<CheckTarget>,
    },
}
impl StoreRequest {
    pub(crate) fn writes(&self) -> bool {
        matches!(self, Self::Save { .. })
    }
}
pub(crate) fn initialize(db: &Connection) -> Result<(), String> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS resource_version_checks (source_key TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0), payload TEXT NOT NULL);")
        .map_err(|e| e.to_string())
}
fn timestamp(value: &str) -> Result<DateTime<Utc>, String> {
    DateTime::parse_from_rfc3339(value)
        .map(|v| v.with_timezone(&Utc))
        .map_err(|_| "版本检查时间无效".into())
}
fn source(repository: &str, binding: &SourceBinding) -> Result<CheckSource, String> {
    let normalized =
        crate::resources::repository(&json!({"repository":repository}))?.ok_or("未登记来源")?;
    if binding.repository_id == 0
        || binding.verified_at.trim().is_empty()
        || !normalized.eq_ignore_ascii_case(&binding.repository)
    {
        return Err("来源身份尚未核实，未检查版本".into());
    }
    let repository = normalized.to_ascii_lowercase();
    let key = format!(
        "{:x}",
        Sha256::digest(format!("{repository}\n{}\n{CHANNEL}", binding.repository_id).as_bytes())
    );
    Ok(CheckSource {
        key,
        repository,
        repository_id: binding.repository_id,
        channel: CHANNEL.into(),
        runtime_package: None,
    })
}
fn resource_source(record: &ResourceRecord) -> Result<CheckSource, String> {
    if record.kind == "skill" {
        return Err("Skill沿用原检查方式".into());
    }
    let mut identity = source(
        record
            .repository
            .as_deref()
            .ok_or("未登记来源，未检查版本")?,
        record
            .source_binding
            .as_ref()
            .ok_or("来源身份尚未核实，未检查版本")?,
    )?;
    if let Some(package) = record
        .installation
        .as_ref()
        .and_then(|i| i.runtime_package.as_ref())
    {
        package.validate_source()?;
        if !package
            .source_repository()?
            .eq_ignore_ascii_case(&identity.repository)
        {
            return Err("运行包来源与仓库身份不一致，未检查版本".into());
        }
        identity.runtime_package = Some(package.recipe.clone());
        identity.key = package_key(&identity)?;
    }
    Ok(identity)
}
fn package_key(source: &CheckSource) -> Result<String, String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(&json!({"repository":source.repository,"repositoryId":source.repository_id,"channel":source.channel,"recipe":source.runtime_package})).map_err(|e| e.to_string())?)))
}
fn get(db: &Connection, key: &str) -> Result<Option<CheckRecord>, String> {
    db.query_row(
        "SELECT payload FROM resource_version_checks WHERE source_key=?1",
        [key],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .map(|v| serde_json::from_str(&v).map_err(|_| "版本检查记录损坏，原记录保留".into()))
    .transpose()
}
fn validate_record(record: &CheckRecord, expected: u64) -> Result<(), String> {
    let binding = SourceBinding {
        repository: record.source.repository.clone(),
        repository_id: record.source.repository_id,
        asset: None,
        verified_at: record.checked_at.clone(),
    };
    let mut expected_source = source(&record.source.repository, &binding)?;
    if let Some(recipe) = &record.source.runtime_package {
        let repo = match recipe {
            crate::resource_package::Recipe::AgentReachWheelV1 => {
                "https://github.com/panniantong/agent-reach"
            }
            crate::resource_package::Recipe::EdgeMcpNpmV1 => {
                "https://github.com/microsoft/playwright-mcp"
            }
        };
        if !repo.eq_ignore_ascii_case(&record.source.repository) {
            return Err("固定配方与来源仓库不一致".into());
        }
        expected_source.runtime_package = Some(recipe.clone());
        expected_source.key = package_key(&expected_source)?;
    }
    if expected_source != record.source
        || record.source.channel != CHANNEL
        || record.revision != expected.checked_add(1).ok_or("检查修订号超出范围")?
    {
        return Err("版本检查来源或修订号无效".into());
    }
    let checked = timestamp(&record.checked_at)?;
    if timestamp(&record.next_check_at)? <= checked
        || record.message.len() > 256
        || !matches!(
            record.status.as_str(),
            "checked"
                | "noStableRelease"
                | "network"
                | "rateLimited"
                | "authentication"
                | "permission"
                | "unavailable"
                | "sourceChanged"
                | "error"
        )
    {
        return Err("版本检查摘要无效".into());
    }
    if let Some(latest) = &record.latest {
        let url = url::Url::parse(&latest.url).map_err(|_| "发行链接无效")?;
        let prefix = format!("{}/releases/tag/", record.source.repository);
        if latest.version.is_empty()
            || latest.version.len() > 160
            || latest.version.chars().any(char::is_control)
            || (if record.source.runtime_package
                == Some(crate::resource_package::Recipe::EdgeMcpNpmV1)
            {
                latest.url
                    != format!(
                        "https://www.npmjs.com/package/@playwright/mcp/v/{}",
                        latest.version
                    )
            } else {
                !latest.url.starts_with(&prefix)
            })
            || url.query().is_some()
            || url.fragment().is_some()
            || (record.source.runtime_package.is_some()
                && latest
                    .metadata_hash
                    .as_ref()
                    .is_none_or(|h| h.len() != 64 || !h.bytes().all(|b| b.is_ascii_hexdigit())))
        {
            return Err("稳定发行摘要无效".into());
        }
    }
    Ok(())
}
/// The live single writer must check basic mode and current maintenance policy
/// before this function. The transaction additionally rejects changed targets.
pub(crate) fn store(db: &Connection, request: StoreRequest) -> Result<Value, String> {
    let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='resource_version_checks')", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if !exists {
        return match request {
            StoreRequest::Get(_) => Ok(Value::Null),
            StoreRequest::List => Ok(json!({"checks":[]})),
            StoreRequest::Save { .. } => Err("版本检查表尚未初始化，未写入记录".into()),
        };
    }
    match request {
        StoreRequest::Get(key) => serde_json::to_value(get(db, &key)?).map_err(|e| e.to_string()),
        StoreRequest::List => {
            let mut query = db
                .prepare("SELECT payload FROM resource_version_checks ORDER BY source_key")
                .map_err(|e| e.to_string())?;
            let rows = query
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            let mut checks = Vec::new();
            for row in rows {
                checks.push(
                    serde_json::from_str::<CheckRecord>(&row.map_err(|e| e.to_string())?)
                        .map_err(|_| "版本检查记录损坏，原记录保留")?,
                );
            }
            Ok(json!({"checks":checks}))
        }
        StoreRequest::Save {
            record,
            expected_revision,
            targets,
        } => {
            validate_record(&record, expected_revision)?;
            let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
            if get(&tx, &record.source.key)?
                .map(|v| v.revision)
                .unwrap_or(0)
                != expected_revision
            {
                return Err("同源检查记录已变化，旧结果未覆盖新摘要".into());
            }
            let mut ids = Vec::new();
            for target in targets {
                let raw: Option<String> = tx
                    .query_row(
                        "SELECT payload FROM resource_catalog WHERE id=?1",
                        [&target.id],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                let Some(raw) = raw else { continue };
                let current: ResourceRecord =
                    serde_json::from_str(&raw).map_err(|_| "资源记录损坏，版本检查未保存")?;
                if current.enabled
                    && current.revision == target.revision
                    && target.source_key == record.source.key
                    && resource_source(&current).is_ok_and(|s| s == record.source)
                {
                    ids.push(target.id);
                }
            }
            if ids.is_empty() {
                return Ok(json!({"stale":true,"appliedIds":[],"record":null}));
            }
            ids.sort();
            ids.dedup();
            tx.execute("INSERT INTO resource_version_checks(source_key,revision,payload) VALUES(?1,?2,?3) ON CONFLICT(source_key) DO UPDATE SET revision=excluded.revision,payload=excluded.payload", params![record.source.key,record.revision,serde_json::to_string(&record).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok(json!({"stale":false,"appliedIds":ids,"record":record}))
        }
    }
}
fn due(record: Option<&CheckRecord>, at: DateTime<Utc>) -> Result<bool, String> {
    record
        .map(|r| timestamp(&r.next_check_at).map(|next| at >= next))
        .unwrap_or(Ok(true))
}
fn fetch(source: &CheckSource) -> Result<Option<ReleaseSummary>, String> {
    let repo = source.repository.trim_start_matches("https://github.com/");
    let api = github::Api::new(repo)?;
    let metadata = api.get(&[])?;
    if metadata["id"].as_u64() != Some(source.repository_id)
        || !metadata["full_name"]
            .as_str()
            .is_some_and(|name| name.eq_ignore_ascii_case(repo))
    {
        return Err("sourceIdentityChanged".into());
    }
    if source.runtime_package == Some(crate::resource_package::Recipe::EdgeMcpNpmV1) {
        let (version, metadata_hash) = crate::resource_package::automation::latest_edge()?;
        return Ok(Some(ReleaseSummary {
            url: format!("https://www.npmjs.com/package/@playwright/mcp/v/{version}"),
            version,
            published_at: None,
            metadata_hash: Some(metadata_hash),
        }));
    }
    let response = api.get(&["releases"])?;
    latest_release(source, &response)
}
fn latest_release(
    source: &CheckSource,
    response: &Value,
) -> Result<Option<ReleaseSummary>, String> {
    let releases = response.as_array().ok_or("GitHub发行列表格式无效")?;
    let mut stable = Vec::new();
    for release in releases.iter().take(100) {
        if release["draft"] != false || release["prerelease"] != false {
            continue;
        }
        let tag = release["tag_name"]
            .as_str()
            .filter(|v| !v.is_empty() && v.len() <= 160 && !v.chars().any(char::is_control))
            .ok_or("GitHub稳定版本标识无效")?;
        let metadata_hash =
            if source.runtime_package == Some(crate::resource_package::Recipe::AgentReachWheelV1) {
                let wheels = release["assets"]
                    .as_array()
                    .ok_or("官方 wheel 列表缺失")?
                    .iter()
                    .filter(|a| {
                        a["name"].as_str().is_some_and(|name| {
                            crate::resource_package::automation::reach_wheel_name(name, tag)
                        }) && a["state"] == "uploaded"
                    })
                    .collect::<Vec<_>>();
                if wheels.is_empty() {
                    continue;
                }
                if wheels.len() != 1 {
                    return Err("官方稳定版本的主 wheel 不唯一，不能自动选择".into());
                }
                Some(crate::resource_package::automation::reach_asset_hash(
                    release["id"].as_u64().ok_or("发行标识缺失")?,
                    tag,
                    wheels[0],
                )?)
            } else {
                None
            };
        let published_at = release["published_at"].as_str().map(str::to_owned);
        let date = published_at.as_deref().map(timestamp).transpose()?;
        let mut link = url::Url::parse(&source.repository).map_err(|_| "来源地址无效")?;
        link.path_segments_mut()
            .map_err(|_| "来源路径无效")?
            .extend(["releases", "tag", tag]);
        stable.push((
            date,
            ReleaseSummary {
                version: tag.into(),
                url: link.into(),
                published_at,
                metadata_hash,
            },
        ));
    }
    // "Latest" is the most recently published stable release, not a guessed
    // semantic-version upgrade or proof of compatible runtime contents.
    stable.sort_by_key(|a| std::cmp::Reverse(a.0));
    Ok(stable.into_iter().next().map(|(_, value)| value))
}
fn failure(error: &str) -> (&'static str, &'static str) {
    if error == "sourceIdentityChanged" {
        ("sourceChanged", "仓库身份已变化，原来源记录未改动")
    } else if error.contains("限流") {
        ("rateLimited", "GitHub暂时限流，已延后检查")
    } else if error.contains("authentication failed") {
        ("authentication", "来源凭据失效，未核实最新版本")
    } else if error.contains("permission denied") {
        ("permission", "来源访问受限，未核实最新版本")
    } else if error.contains("Cannot reach GitHub")
        || error.contains("timed out")
        || error.contains("Cannot read GitHub response")
    {
        ("network", "网络读取未完成，已延后检查")
    } else if error.contains("unavailable") || error.contains("不可访问") {
        ("unavailable", "来源暂不可访问，不代表已删除")
    } else {
        ("error", "版本信息未能核实，已延后检查")
    }
}
fn observation(
    source: CheckSource,
    previous: Option<&CheckRecord>,
    at: DateTime<Utc>,
    result: Result<Option<ReleaseSummary>, String>,
) -> Result<CheckRecord, String> {
    let revision = previous
        .map(|v| v.revision)
        .unwrap_or(0)
        .checked_add(1)
        .ok_or("检查修订号超出范围")?;
    let (latest, failures, status, message, delay) = match result {
        Ok(latest) => {
            let has_release = latest.is_some();
            (
                latest,
                0,
                if has_release {
                    "checked"
                } else {
                    "noStableRelease"
                },
                if has_release {
                    "已读取最近稳定发行版本；未下载或应用"
                } else {
                    "当前未发现稳定发行版本；未改动已安装内容"
                },
                Duration::hours(INTERVAL_HOURS),
            )
        }
        Err(error) => {
            let failures = previous.map(|v| v.failures).unwrap_or(0).saturating_add(1);
            let (status, message) = failure(&error);
            let minutes = 15i64
                .saturating_mul(1i64 << failures.saturating_sub(1).min(7))
                .min(24 * 60);
            (None, failures, status, message, Duration::minutes(minutes))
        }
    };
    Ok(CheckRecord {
        source,
        revision,
        checked_at: at.to_rfc3339(),
        next_check_at: (at + delay).to_rfc3339(),
        failures,
        status: status.into(),
        message: message.into(),
        latest,
    })
}
fn run_due_with(
    m: &Manager,
    at: DateTime<Utc>,
    mut read_source: impl FnMut(&CheckSource) -> Result<Option<ReleaseSummary>, String>,
) -> Result<Value, String> {
    const BASIC_MODE_ERROR: &str = "基本模式不联网检查工具版本";
    m.ensure_live_maintenance_allowed(BASIC_MODE_ERROR)?;
    let resources = m.resource_store(ResourceStore::List)?;
    let records: Vec<ResourceRecord> =
        serde_json::from_value(resources["resources"].clone()).map_err(|_| "工具目录格式无效")?;
    let stored = m.resource_check_store(StoreRequest::List)?;
    let summaries: Vec<CheckRecord> =
        serde_json::from_value(stored["checks"].clone()).map_err(|_| "版本检查记录格式无效")?;
    let summaries: BTreeMap<_, _> = summaries
        .into_iter()
        .map(|record| (record.source.key.clone(), record))
        .collect();
    let mut groups = BTreeMap::<String, (CheckSource, Vec<CheckTarget>)>::new();
    let mut not_checked = Vec::new();
    for resource in records {
        if resource.kind == "skill" {
            continue;
        }
        if !resource.enabled {
            not_checked.push(json!({"id":resource.id,"reason":"工具已停用，未自动检查"}));
            continue;
        }
        match resource_source(&resource) {
            Ok(source) => {
                let target = CheckTarget {
                    id: resource.id,
                    revision: resource.revision,
                    source_key: source.key.clone(),
                };
                groups
                    .entry(source.key.clone())
                    .or_insert_with(|| (source, Vec::new()))
                    .1
                    .push(target);
            }
            Err(reason) => not_checked.push(json!({"id":resource.id,"reason":reason})),
        }
    }
    let mut results = Vec::new();
    let mut cached_sources = 0;
    for (key, (source, targets)) in groups {
        let previous = summaries.get(&key);
        if !due(previous, at)? {
            cached_sources += 1;
            continue;
        }
        crate::network::check_cancelled()?;
        m.ensure_live_maintenance_allowed(BASIC_MODE_ERROR)?;
        let result = read_source(&source);
        crate::network::check_cancelled()?;
        let record = observation(source, previous, at, result)?;
        // Recheck maintenance and source state on the live writer before saving.
        let saved = m.resource_check_store(StoreRequest::Save {
            expected_revision: previous.map(|v| v.revision).unwrap_or(0),
            record: Box::new(record),
            targets,
        })?;
        results.push(saved);
    }
    Ok(
        json!({"checkedSources":results.len(),"cachedSources":cached_sources,"notChecked":not_checked,"results":results,"downloaded":false,"applied":false}),
    )
}
/// Used only as TaskSystem's private scheduler dispatcher. The regular IPC
/// dispatcher deliberately has no action that forwards to this function.
pub(crate) fn dispatch_due(m: &mut Manager, request: &Value) -> Result<Value, String> {
    if request["action"] != "__resource_version_due"
        || request["automatic"] != true
        || request.as_object().is_none_or(|v| {
            v.keys()
                .any(|key| !["action", "automatic"].contains(&key.as_str()))
        })
    {
        return Err("工具版本定时检查只能由内部调度启动".into());
    }
    run_due_with(m, Utc::now(), fetch)
}
pub(crate) fn handle(m: &Manager, request: &Value) -> Result<Option<Value>, String> {
    if request["action"] != "resource_version_check_status" {
        return Ok(None);
    }
    if request.as_object().is_none_or(|v| {
        v.keys()
            .any(|key| !["action", "id"].contains(&key.as_str()))
    }) {
        return Err("版本检查状态请求包含未知字段".into());
    }
    let id = request["id"]
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= 64)
        .ok_or("缺少工具标识")?;
    let resource: ResourceRecord =
        serde_json::from_value(m.resource_store(ResourceStore::Get(id.into()))?)
            .map_err(|_| "工具记录格式无效")?;
    let source = match resource_source(&resource) {
        Ok(value) => value,
        Err(reason) => {
            return Ok(Some(
                json!({"id":id,"status":"notChecked","message":reason,"check":null}),
            ))
        }
    };
    let check = m.resource_check_store(StoreRequest::Get(source.key.clone()))?;
    let status = if check.is_null() {
        "notChecked"
    } else {
        "recorded"
    };
    Ok(Some(
        json!({"id":id,"status":status,"message":if check.is_null() { "尚未检查此来源的稳定版本" } else { "摘要仅表示版本读取，不证明运行能力" },"source":source,"check":check,"automaticEligible":resource.enabled,"installedVersion":resource.version}),
    ))
}

#[cfg(test)]
mod tests;
