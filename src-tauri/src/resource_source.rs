//! Source association is metadata. Installed bytes, entry points and original
//! installation receipts keep their own identities across an explicit rebind.
use crate::{
    model::{now, Manager},
    resource_github,
    resources::{self, ResourceRecord, StoreRequest},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AssetMapping {
    pub release_id: u64,
    pub asset_id: u64,
    pub tag: String,
    pub asset_name: String,
    pub size: u64,
    pub digest: Option<String>,
    pub url: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceBinding {
    pub repository: String,
    pub repository_id: u64,
    pub asset: Option<AssetMapping>,
    pub verified_at: String,
}

impl SourceBinding {
    fn same_target(&self, other: &Self) -> bool {
        self.repository.eq_ignore_ascii_case(&other.repository)
            && self.repository_id == other.repository_id
            && self.asset == other.asset
    }
    fn selection(&self) -> Option<(u64, u64)> {
        self.asset.as_ref().map(|a| (a.release_id, a.asset_id))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceHistory {
    pub changed_at: String,
    pub repository: Option<String>,
    pub binding: Option<SourceBinding>,
    pub capabilities: Vec<Value>,
}

fn allowed(request: &Value, fields: &[&str]) -> Result<(), String> {
    if request
        .as_object()
        .is_none_or(|o| o.keys().any(|key| !fields.contains(&key.as_str())))
    {
        return Err("来源请求包含不支持的字段".into());
    }
    Ok(())
}

fn identifier<'a>(request: &'a Value, key: &str) -> Result<&'a str, String> {
    request[key]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 64 && !s.chars().any(char::is_control))
        .ok_or_else(|| format!("{key} 标识缺失或无效"))
}

fn read(m: &Manager, id: &str) -> Result<ResourceRecord, String> {
    serde_json::from_value(m.resource_store(StoreRequest::Get(id.into()))?)
        .map_err(|e| e.to_string())
}

fn checked(m: &Manager, id: &str, expected: u64) -> Result<ResourceRecord, String> {
    let record = read(m, id)?;
    if expected == 0 || record.revision != expected {
        return Err("资源已变化，请重新读取来源并预览".into());
    }
    Ok(record)
}

fn normal_mode(m: &Manager) -> Result<(), String> {
    if m.basic_mode {
        return Err("基本模式只读取已保存的来源，不联网核对或重绑".into());
    }
    Ok(())
}

fn mapping_status(binding: Option<&SourceBinding>) -> &'static str {
    if binding.is_some_and(|b| b.asset.is_some()) {
        "releaseAsset"
    } else {
        "repositoryOnly"
    }
}

fn data(record: &ResourceRecord) -> Value {
    let installed = record.installation.as_ref().map(|i| {
        let package=i.runtime_package.as_ref().map(crate::resource_manifest::RuntimePackageSource::from_provenance).transpose();
        let (package,error)=match package{Ok(value)=>(value,None),Err(error)=>(None,Some(error))};
        json!({"repository":i.source_repository,"version":i.source_version,
            "archiveSha256":i.archive_sha256,"downloadSource":i.download_source,"runtimePackage":package,"runtimePackageError":error})
    });
    json!({"id":record.id,"resourceRevision":record.revision,"repository":record.repository,
        "installedVersion":record.version,"installationSource":installed,
        "binding":record.source_binding,"history":record.source_history,
        "mappingStatus":mapping_status(record.source_binding.as_ref()),
        "requiresVerification":record.source_binding.is_some()})
}

fn health(status: &str, message: &str) -> Value {
    json!({"status":status,"message":message,"checkedAt":now()})
}

/// The shared GitHub reader already redacts errors and distinguishes access,
/// throttling and transport failures. An unavailable response is never deletion proof.
pub(crate) fn failure_health(error: &str) -> Value {
    let status = if error.contains("authentication failed") {
        "authentication"
    } else if error.contains("permission denied") {
        "permission"
    } else if error.contains("限流") {
        "rateLimited"
    } else if error.contains("Cannot reach GitHub")
        || error.contains("timed out")
        || error.contains("Cannot read GitHub response")
    {
        "network"
    } else if error.contains("不可访问")
        || error.contains("unavailable")
        || error.contains("发行文件已移除")
        || error.contains("已选发行版不可用")
    {
        "unavailable"
    } else if error.contains("身份与所选来源不一致") || error.contains("信息在核对期间变化")
    {
        "changed"
    } else {
        "error"
    };
    health(status, error)
}

fn source_health(m: &Manager, request: &Value) -> Result<Value, String> {
    normal_mode(m)?;
    let id = identifier(request, "id")?;
    let expected = request["expectedRevision"]
        .as_u64()
        .ok_or("缺少当前资源修订号")?;
    let record = checked(m, id, expected)?;
    let result = if let Some(repository) = &record.repository {
        match resource_github::source_metadata(
            repository,
            record
                .source_binding
                .as_ref()
                .and_then(SourceBinding::selection),
        ) {
            Ok(actual) => {
                if record
                    .source_binding
                    .as_ref()
                    .is_some_and(|b| !b.same_target(&actual))
                {
                    health(
                        "changed",
                        "仓库或发行文件身份已变化，请重新预览关联；原安装证据保留",
                    )
                } else {
                    health(
                        "reachable",
                        "来源当前可访问；这不代表已验证本地兼容性或运行能力",
                    )
                }
            }
            Err(error) => failure_health(&error),
        }
    } else {
        health("unconfigured", "尚未登记 GitHub 来源")
    };
    let mut value = data(&checked(m, id, expected)?);
    value["health"] = result;
    Ok(value)
}

fn selection(request: &Value) -> Result<Option<(u64, u64)>, String> {
    match (request.get("releaseId"), request.get("assetId")) {
        (None, None) => Ok(None),
        (Some(release), Some(asset)) => {
            let release = release
                .as_u64()
                .filter(|id| *id > 0)
                .ok_or("发行版标识无效")?;
            let asset = asset
                .as_u64()
                .filter(|id| *id > 0)
                .ok_or("发行文件标识无效")?;
            Ok(Some((release, asset)))
        }
        _ => Err("请同时选择具体发行版和发行文件；仅登记仓库时省略两项".into()),
    }
}

fn preview(m: &mut Manager, request: &Value) -> Result<Value, String> {
    normal_mode(m)?;
    let id = identifier(request, "id")?;
    let expected = request["expectedRevision"]
        .as_u64()
        .ok_or("缺少当前资源修订号")?;
    let record = checked(m, id, expected)?;
    let repository = resources::repository(request)?.ok_or("请填写新 GitHub 仓库地址")?;
    let next = resource_github::source_metadata(&repository, selection(request)?)?;
    checked(m, id, expected)?;
    let preview_id = uuid::Uuid::new_v4().to_string();
    let mut warnings =
        vec!["仅保存来源关联，不下载、不安装、不改变运行入口；本地兼容性和能力需重新核验"];
    if next.asset.is_none() {
        warnings.push("尚未选择具体发行文件；此关联仅是仓库登记，不具备完整更新映射");
    }
    let public = json!({"previewId":preview_id,"kind":"resourceSource","id":id,
        "resourceRevision":expected,"previous":data(&record),"next":next,
        "mappingStatus":mapping_status(Some(&next)),"canApply":true,"warnings":warnings});
    m.previews.insert(
        preview_id,
        json!({"kind":"resourceSource","resourceId":id,
        "expectedRevision":expected,"prepared":next,"public":public,
        "createdAt":chrono::Utc::now().timestamp_millis()}),
    );
    crate::resource_lifecycle::trim_previews(&mut m.previews);
    Ok(public)
}

pub(crate) fn handle(m: &mut Manager, request: &Value) -> Result<Option<Value>, String> {
    let action = request["action"].as_str().unwrap_or_default();
    match action {
        "resource_source" => {
            allowed(request, &["action", "id"])?;
            Ok(Some(data(&read(m, identifier(request, "id")?)?)))
        }
        "resource_source_health" => {
            allowed(request, &["action", "id", "expectedRevision"])?;
            source_health(m, request).map(Some)
        }
        "preview_resource_source" => {
            allowed(
                request,
                &[
                    "action",
                    "id",
                    "expectedRevision",
                    "repository",
                    "releaseId",
                    "assetId",
                ],
            )?;
            preview(m, request).map(Some)
        }
        "apply_resource_source" => Err("来源重绑需要在本地界面核对预览后确认".into()),
        _ => Ok(None),
    }
}

pub(crate) fn apply_local(m: &mut Manager, request: &Value) -> Result<Option<Value>, String> {
    if request["action"] != "apply_resource_source" {
        return Ok(None);
    }
    normal_mode(m)?;
    allowed(request, &["action", "previewId"])?;
    let preview_id = identifier(request, "previewId")?;
    let saved = m
        .previews
        .get(preview_id)
        .ok_or("预览已消费或过期，请重新预览")?;
    if saved["kind"] != "resourceSource" || saved["public"]["canApply"] != true {
        return Err("来源预览类型不匹配".into());
    }
    let saved = m.previews.remove(preview_id).ok_or("预览已过期")?;
    let id = identifier(&saved, "resourceId")?;
    let expected = saved["expectedRevision"].as_u64().ok_or("预览修订号缺失")?;
    checked(m, id, expected)?;
    let prepared: SourceBinding =
        serde_json::from_value(saved["prepared"].clone()).map_err(|e| e.to_string())?;
    let actual = resource_github::source_metadata(&prepared.repository, prepared.selection())?;
    if !prepared.same_target(&actual) {
        return Err("预览后仓库或发行文件身份已变化，请重新预览；未修改原关联".into());
    }
    // Reading through the runtime bridge again observes edits committed while
    // the remote identity was checked; Replace then applies the final live CAS.
    let mut record = checked(m, id, expected)?;
    if record
        .source_binding
        .as_ref()
        .is_some_and(|b| b.same_target(&actual))
        && record.repository.as_deref() == Some(actual.repository.as_str())
    {
        return Ok(Some(data(&record)));
    }
    record.source_history.push(SourceHistory {
        changed_at: now(),
        repository: record.repository.clone(),
        binding: record.source_binding.clone(),
        capabilities: record.capabilities.clone(),
    });
    record.repository = Some(actual.repository.clone());
    record.source_binding = Some(actual);
    // Installed files and directory registration remain historical facts.
    // Execution/capability evidence is retained above and cannot certify the new source.
    for capability in &mut record.capabilities {
        if !matches!(
            capability["id"].as_str(),
            Some("registration" | "installation")
        ) {
            capability["status"] = json!("needs_reverification");
            capability["reason"] =
                json!("来源关联已变化；历史结果保留，本地兼容性与能力需重新核验");
        }
    }
    record.update_policy["mode"] = json!("manual");
    record.revision = expected.checked_add(1).ok_or("资源修订号超出范围")?;
    record.updated_at = now();
    let saved = m.resource_store(StoreRequest::Replace {
        record: Box::new(record),
        expected_revision: expected,
    })?;
    let record: ResourceRecord =
        serde_json::from_value(saved["resource"].clone()).map_err(|e| e.to_string())?;
    Ok(Some(data(&record)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::github;
    use std::{
        io::{Read, Write},
        path::Path,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::Duration,
    };

    const REPO: &str = "synthetic-protocol/source-binding";
    const URL: &str = "https://github.com/synthetic-protocol/source-binding";

    #[test]
    fn package_source_projection_keeps_real_origins_and_hashes_without_private_builder_paths() {
        let directory = fixture();
        let m = Manager::new(directory.path().join("manager")).unwrap();
        let node = directory.path().join("node.exe");
        std::fs::write(&node, b"synthetic node; never executed").unwrap();
        let package = crate::resource_package_lifecycle::test_support::package(
            &directory.path().join("runtime"),
            "0.0.83",
            &node,
        );
        let result =
            crate::resource_lifecycle::register_materialized(&m, "Synthetic source", package)
                .unwrap();
        let mut record: ResourceRecord =
            serde_json::from_value(result["resource"].clone()).unwrap();
        let before = json!(record);
        let projection = data(&record);
        let installed = &projection["installationSource"];
        assert_eq!(installed["runtimePackage"]["recipe"], "edgeMcpNpmV1");
        assert_eq!(installed["runtimePackage"]["version"], "0.0.83");
        assert_eq!(
            installed["runtimePackage"]["artifacts"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
        assert_eq!(
            installed["runtimePackage"]["artifacts"][0]["sha256"],
            "a".repeat(64)
        );
        assert!(
            installed["runtimePackage"]["artifacts"][0]["origin"]["tarball"]
                .as_str()
                .unwrap()
                .starts_with("https://registry.npmjs.org/")
        );
        assert_eq!(installed["archiveSha256"], "");
        assert!(installed["downloadSource"].is_null());
        assert!(!installed["runtimePackage"]
            .to_string()
            .contains(&directory.path().to_string_lossy().to_string()));
        assert_eq!(json!(read(&m, &record.id).unwrap()), before);
        record
            .installation
            .as_mut()
            .unwrap()
            .runtime_package
            .as_mut()
            .unwrap()
            .source_artifacts
            .clear();
        let invalid = data(&record);
        assert!(invalid["installationSource"]["runtimePackage"].is_null());
        assert!(invalid["installationSource"]["runtimePackageError"]
            .as_str()
            .is_some_and(|v| !v.is_empty()));
    }

    fn fixture() -> tempfile::TempDir {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("work/resource-source-tests");
        std::fs::create_dir_all(&root).unwrap();
        tempfile::tempdir_in(root).unwrap()
    }

    fn registered(m: &Manager, directory: &Path) -> ResourceRecord {
        std::fs::create_dir_all(directory).unwrap();
        std::fs::write(
            directory.join("config.json"),
            b"private configuration stays in place",
        )
        .unwrap();
        let result = resources::handle(
            m,
            &json!({"action":"resource_register","name":"tool","kind":"cli",
            "rootPath":directory,"repository":"https://github.com/original/tool","version":"v1"}),
        )
        .unwrap()
        .unwrap();
        serde_json::from_value(result["resource"].clone()).unwrap()
    }

    type Reply = (u16, Value, &'static str);
    fn server(replies: Vec<Reply>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        server_with(replies, |_| {})
    }
    fn server_with(
        replies: Vec<Reply>,
        mut before_reply: impl FnMut(usize) + Send + 'static,
    ) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let mut requests = vec![];
            for (status, value, headers) in replies {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = vec![];
                while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                    let mut buffer = [0; 4096];
                    let count = stream.read(&mut buffer).unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&buffer[..count]);
                }
                requests.push(String::from_utf8(request).unwrap());
                before_reply(requests.len() - 1);
                let body = serde_json::to_vec(&value).unwrap();
                write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{headers}Connection: close\r\n\r\n", body.len()).unwrap();
                stream.write_all(&body).unwrap();
            }
            requests
        });
        (endpoint, worker)
    }

    fn repo_reply(repository_id: u64) -> Reply {
        (200, json!({"id":repository_id,"full_name":REPO}), "")
    }
    fn asset(size: u64) -> Value {
        json!({"id":22,"name":"tool.zip","size":size,"state":"uploaded",
            "digest":format!("sha256:{}", "a".repeat(64)),
            "browser_download_url":format!("{URL}/releases/download/v2/tool.zip"),
            "updated_at":"2026-10-30T00:00:00Z"})
    }
    fn asset_replies(size: u64) -> Vec<Reply> {
        vec![
            repo_reply(10),
            (
                200,
                json!({"id":11,"draft":false,"tag_name":"v2","assets":[asset(size)]}),
                "",
            ),
            (200, asset(size), ""),
        ]
    }
    fn plan(m: &mut Manager, record: &ResourceRecord, mapped: bool) -> Value {
        let mut request = json!({"action":"preview_resource_source","id":record.id,
            "expectedRevision":record.revision,"repository":URL});
        if mapped {
            request["releaseId"] = json!(11);
            request["assetId"] = json!(22);
        }
        handle(m, &request).unwrap().unwrap()
    }
    fn apply(m: &mut Manager, preview: &Value) -> Result<Value, String> {
        apply_local(
            m,
            &json!({"action":"apply_resource_source","previewId":preview["previewId"]}),
        )
        .map(Option::unwrap)
    }

    #[test]
    fn rebind_keeps_installation_actions_configuration_and_history_across_restart() {
        let directory = fixture();
        let state_dir = directory.path().join("state");
        let mut m = Manager::new(state_dir.clone()).unwrap();
        let mut record = registered(&m, &directory.path().join("tool"));
        record.actions = vec![json!({"id":"existing","label":"existing entry"})];
        record.capabilities.push(json!({"id":"test","status":"passed","verifiedAt":"original-time","evidence":"old-result"}));
        record.installation = Some(
            serde_json::from_value(json!({"schemaVersion":1,"installedAt":"old",
            "archivePath":"D:/synthetic/original.zip","archiveSha256":"original-package-hash",
            "sourceRepository":"https://github.com/original/tool","sourceVersion":"v1",
            "files":[],"status":"installed","error":null}))
            .unwrap(),
        );
        record.revision = 2;
        m.resource_store(StoreRequest::Replace {
            record: Box::new(record.clone()),
            expected_revision: 1,
        })
        .unwrap();
        let original = serde_json::to_value(&record).unwrap();
        let (endpoint, server) = server([asset_replies(12), asset_replies(12)].concat());
        let _transport = github::test_transport(REPO, &endpoint);
        let preview = plan(&mut m, &record, true);
        assert_eq!(preview["previous"]["installationSource"]["version"], "v1");
        let result = apply(&mut m, &preview).unwrap();
        assert_eq!(result["binding"]["asset"]["tag"], "v2");
        assert_eq!(result["installedVersion"], "v1");
        assert_eq!(result["resourceRevision"], 3);
        assert_eq!(
            result["history"][0]["capabilities"],
            original["capabilities"]
        );
        assert!(apply(&mut m, &preview).unwrap_err().contains("消费"));
        let actual = serde_json::to_value(read(&m, &record.id).unwrap()).unwrap();
        for field in [
            "installation",
            "actions",
            "version",
            "rootPath",
            "ownership",
            "managementScope",
            "enabled",
        ] {
            assert_eq!(actual[field], original[field], "{field}");
        }
        assert_eq!(
            actual["capabilities"].as_array().unwrap().last().unwrap()["status"],
            "needs_reverification"
        );
        assert_eq!(
            std::fs::read(directory.path().join("tool/config.json")).unwrap(),
            b"private configuration stays in place"
        );
        m.state
            .skills
            .push(json!({"id":"legacy","name":"preserved"}));
        m.save().unwrap();
        drop(m);
        let restarted = Manager::new(state_dir).unwrap();
        assert_eq!(data(&read(&restarted, &record.id).unwrap()), result);
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 6);
        assert!(requests
            .iter()
            .all(|request| request.starts_with("GET /repos/")
                && !request.contains("application/octet-stream")));
    }

    #[test]
    fn repository_only_is_explicit_and_identical_rebind_is_a_noop() {
        let directory = fixture();
        let mut m = Manager::new(directory.path().join("state")).unwrap();
        let record = registered(&m, &directory.path().join("tool"));
        let (endpoint, server) = server(vec![
            repo_reply(10),
            repo_reply(10),
            repo_reply(10),
            repo_reply(10),
        ]);
        let _transport = github::test_transport(REPO, &endpoint);
        let events = Arc::new(AtomicUsize::new(0));
        let events_copy = Arc::clone(&events);
        m.set_state_events(Arc::new(move |_| {
            events_copy.fetch_add(1, Ordering::Relaxed);
        }));
        let preview = plan(&mut m, &record, false);
        assert_eq!(preview["mappingStatus"], "repositoryOnly");
        assert!(preview["next"]["asset"].is_null());
        assert_eq!(preview["warnings"].as_array().unwrap().len(), 2);
        let first = apply(&mut m, &preview).unwrap();
        let current = read(&m, &record.id).unwrap();
        let preview = plan(&mut m, &current, false);
        let second = apply(&mut m, &preview).unwrap();
        assert_eq!(first, second);
        assert_eq!(events.load(Ordering::Relaxed), 1);
        assert_eq!(second["history"].as_array().unwrap().len(), 1);
        server.join().unwrap();
    }

    #[test]
    fn asset_or_repository_identity_drift_rejects_without_changes() {
        for mapped in [false, true] {
            let directory = fixture();
            let mut m = Manager::new(directory.path().join("state")).unwrap();
            let record = registered(&m, &directory.path().join("tool"));
            let replies = if mapped {
                [asset_replies(12), asset_replies(13)].concat()
            } else {
                vec![repo_reply(10), repo_reply(20)]
            };
            let (endpoint, server) = server(replies);
            let _transport = github::test_transport(REPO, &endpoint);
            let preview = plan(&mut m, &record, mapped);
            assert!(apply(&mut m, &preview).unwrap_err().contains("身份已变化"));
            assert_eq!(data(&read(&m, &record.id).unwrap()), data(&record));
            server.join().unwrap();
        }
    }

    #[test]
    fn another_window_revision_or_failed_transaction_cannot_replace_original_binding() {
        for database_failure in [false, true] {
            let directory = fixture();
            let state_dir = directory.path().join("state");
            let mut m = Manager::new(state_dir.clone()).unwrap();
            let record = registered(&m, &directory.path().join("tool"));
            let replies = if database_failure {
                vec![repo_reply(10), repo_reply(10)]
            } else {
                vec![repo_reply(10)]
            };
            let (endpoint, server) = server(replies);
            let _transport = github::test_transport(REPO, &endpoint);
            let preview = plan(&mut m, &record, false);
            if database_failure {
                rusqlite::Connection::open(state_dir.join("manager.sqlite3")).unwrap().execute_batch(
                    "CREATE TRIGGER fail_source_write BEFORE UPDATE ON resource_catalog BEGIN SELECT RAISE(ABORT,'synthetic source failure'); END;"
                ).unwrap();
            } else {
                let second_window = Manager::new(state_dir).unwrap();
                resources::handle(&second_window, &json!({"action":"resource_update","id":record.id,"expectedRevision":1,"changes":{"notes":"other window"}})).unwrap();
            }
            assert!(apply(&mut m, &preview).is_err());
            let current = read(&m, &record.id).unwrap();
            assert!(current.source_binding.is_none());
            assert!(current.source_history.is_empty());
            assert_eq!(current.repository, record.repository);
            server.join().unwrap();
        }
    }

    #[test]
    fn preview_health_and_apply_recheck_live_version_after_http() {
        for operation in [
            "preview_resource_source",
            "resource_source_health",
            "apply_resource_source",
        ] {
            let directory = fixture();
            let state_dir = directory.path().join("state");
            let mut m = Manager::new(state_dir.clone()).unwrap();
            let mut record = registered(&m, &directory.path().join("tool"));
            record.repository = Some(URL.into());
            record.revision = 2;
            m.resource_store(StoreRequest::Replace {
                record: Box::new(record.clone()),
                expected_revision: 1,
            })
            .unwrap();
            let id = record.id.clone();
            let applying = operation == "apply_resource_source";
            let replies = if applying {
                vec![repo_reply(10), repo_reply(10)]
            } else {
                vec![repo_reply(10)]
            };
            let (endpoint, server) = server_with(replies, move |index| {
                if index == if applying { 1 } else { 0 } {
                    let other = Manager::new(state_dir.clone()).unwrap();
                    let mut current = read(&other, &id).unwrap();
                    let expected = current.revision;
                    current.version = Some("installed-by-other-task".into());
                    current.revision += 1;
                    other
                        .resource_store(StoreRequest::Replace {
                            record: Box::new(current),
                            expected_revision: expected,
                        })
                        .unwrap();
                }
            });
            let _transport = github::test_transport(REPO, &endpoint);
            let result = if applying {
                let preview = plan(&mut m, &record, false);
                apply(&mut m, &preview)
            } else {
                let mut request = json!({"action":operation,"id":record.id,"expectedRevision":2});
                if operation == "preview_resource_source" {
                    request["repository"] = json!(URL);
                }
                handle(&mut m, &request).map(Option::unwrap)
            };
            assert!(result.unwrap_err().contains("资源已变化"));
            let current = read(&m, &record.id).unwrap();
            assert_eq!(current.version.as_deref(), Some("installed-by-other-task"));
            assert!(current.source_binding.is_none());
            assert!(current.source_history.is_empty());
            assert!(m
                .previews
                .values()
                .all(|preview| preview["kind"] != "resourceSource"));
            server.join().unwrap();
        }
    }

    #[test]
    fn old_record_and_basic_mode_are_readable_without_mutation() {
        let directory = fixture();
        let state_dir = directory.path().join("state");
        let m = Manager::new(state_dir.clone()).unwrap();
        let record = registered(&m, &directory.path().join("tool"));
        let mut old = serde_json::to_value(&record).unwrap();
        old.as_object_mut().unwrap().remove("sourceBinding");
        old.as_object_mut().unwrap().remove("sourceHistory");
        let db = rusqlite::Connection::open(state_dir.join("manager.sqlite3")).unwrap();
        db.execute(
            "UPDATE resource_catalog SET payload=?1 WHERE id=?2",
            rusqlite::params![old.to_string(), record.id],
        )
        .unwrap();
        drop(m);
        let before: String = db
            .query_row(
                "SELECT group_concat(name,',') FROM sqlite_master ORDER BY name",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let storage = crate::storage::Storage::isolated(state_dir);
        let mut basic = Manager::with_storage_mode(storage, true).unwrap();
        assert!(handle(
            &mut basic,
            &json!({"action":"resource_source","id":record.id})
        )
        .unwrap()
        .unwrap()["binding"]
            .is_null());
        for action in ["resource_source_health", "preview_resource_source"] {
            let request = if action == "resource_source_health" {
                json!({"action":action,"id":record.id,"expectedRevision":1})
            } else {
                json!({"action":action,"id":record.id,"expectedRevision":1,"repository":URL})
            };
            assert!(handle(&mut basic, &request)
                .unwrap_err()
                .contains("基本模式"));
        }
        assert!(apply_local(
            &mut basic,
            &json!({"action":"apply_resource_source","previewId":"not-created"})
        )
        .unwrap_err()
        .contains("基本模式"));
        let after: String = db
            .query_row(
                "SELECT group_concat(name,',') FROM sqlite_master ORDER BY name",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(before, after);
        let retained: String = db
            .query_row(
                "SELECT payload FROM resource_catalog WHERE id=?1",
                [&record.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&retained).unwrap(), old);
    }

    #[test]
    fn source_health_uses_shared_http_errors_without_claiming_deletion() {
        for (code, headers, expected) in [
            (401, "", "authentication"),
            (403, "", "permission"),
            (404, "", "unavailable"),
            (429, "Retry-After: 0\r\n", "rateLimited"),
        ] {
            let directory = fixture();
            let mut m = Manager::new(directory.path().join("state")).unwrap();
            let mut record = registered(&m, &directory.path().join("tool"));
            record.repository = Some(URL.into());
            record.revision = 2;
            m.resource_store(StoreRequest::Replace {
                record: Box::new(record.clone()),
                expected_revision: 1,
            })
            .unwrap();
            let (endpoint, server) = server(vec![(
                code,
                json!({"message":"not copied into output"}),
                headers,
            )]);
            let _transport = github::test_transport(REPO, &endpoint);
            let result = handle(
                &mut m,
                &json!({"action":"resource_source_health","id":record.id,"expectedRevision":2}),
            )
            .unwrap()
            .unwrap();
            assert_eq!(result["health"]["status"], expected);
            assert!(!result["health"].to_string().contains("删除"));
            assert_eq!(read(&m, &record.id).unwrap().revision, 2);
            server.join().unwrap();
        }
        assert_eq!(
            failure_health("GitHub request timed out")["status"],
            "network"
        );
        assert_eq!(failure_health("Cannot reach GitHub")["status"], "network");
    }

    #[test]
    fn health_reports_changed_or_missing_asset_without_selecting_a_replacement() {
        let directory = fixture();
        let mut m = Manager::new(directory.path().join("state")).unwrap();
        let mut record = registered(&m, &directory.path().join("tool"));
        record.repository = Some(URL.into());
        record.source_binding = Some(SourceBinding {
            repository: URL.into(),
            repository_id: 10,
            verified_at: "prior-check".into(),
            asset: Some(AssetMapping {
                release_id: 11,
                asset_id: 22,
                tag: "v2".into(),
                asset_name: "tool.zip".into(),
                size: 12,
                digest: Some("a".repeat(64)),
                url: format!("{URL}/releases/download/v2/tool.zip"),
                updated_at: "2026-10-30T00:00:00Z".into(),
            }),
        });
        record.revision = 2;
        m.resource_store(StoreRequest::Replace {
            record: Box::new(record.clone()),
            expected_revision: 1,
        })
        .unwrap();
        let mut replacement = asset(12);
        replacement["id"] = json!(23); // Same name, distinct asset: never substitute it.
        let replies = [
            asset_replies(12),
            asset_replies(13),
            vec![
                repo_reply(10),
                (
                    200,
                    json!({"id":11,"draft":false,"tag_name":"v2","assets":[replacement]}),
                    "",
                ),
            ],
        ]
        .concat();
        let (endpoint, server) = server(replies);
        let _transport = github::test_transport(REPO, &endpoint);
        for expected in ["reachable", "changed", "unavailable"] {
            let result = handle(
                &mut m,
                &json!({"action":"resource_source_health","id":record.id,"expectedRevision":2}),
            )
            .unwrap()
            .unwrap();
            assert_eq!(result["health"]["status"], expected);
            assert_eq!(data(&read(&m, &record.id).unwrap()), data(&record));
        }
        assert_eq!(server.join().unwrap().len(), 8);
    }

    #[test]
    fn edit_cannot_change_source_or_installed_version_or_accept_execution_fields() {
        let directory = fixture();
        let mut m = Manager::new(directory.path().join("state")).unwrap();
        let record = registered(&m, &directory.path().join("tool"));
        for changes in [json!({"repository":URL}), json!({"version":"v2"})] {
            assert!(resources::handle(&m,&json!({"action":"resource_update","id":record.id,"expectedRevision":1,"changes":changes})).is_err());
        }
        assert!(handle(&mut m,&json!({"action":"preview_resource_source","id":record.id,"expectedRevision":1,"repository":URL,"command":"unexpected"})).is_err());
        assert!(handle(&mut m,&json!({"action":"preview_resource_source","id":record.id,"expectedRevision":1,"repository":URL,"releaseId":11})).is_err());
        assert!(handle(
            &mut m,
            &json!({"action":"apply_resource_source","previewId":"anything"})
        )
        .is_err());
        let same=resources::handle(&m,&json!({"action":"resource_update","id":record.id,"expectedRevision":1,"changes":{"repository":record.repository,"version":record.version,"notes":"personal"}})).unwrap().unwrap();
        assert_eq!(same["resource"]["version"], "v1");
        assert_eq!(same["resource"]["notes"], "personal");
    }

    #[test]
    fn abandoned_source_previews_are_bounded_and_leave_registered_sources_unchanged() {
        let directory = fixture();
        let mut m = Manager::new(directory.path().join("state")).unwrap();
        let record = registered(&m, &directory.path().join("tool"));
        let original = json!(read(&m, &record.id).unwrap());
        let configuration = std::fs::read(directory.path().join("tool/config.json")).unwrap();
        m.previews.insert(
            "unrelated-preview".into(),
            json!({"kind":"unrelated","createdAt":0,"keep":true}),
        );
        let (endpoint, server) = server((0..41).map(|_| repo_reply(10)).collect());
        let _transport = github::test_transport(REPO, &endpoint);
        let oldest = plan(&mut m, &record, false);
        let mut latest = oldest.clone();
        for _ in 0..39 {
            std::thread::sleep(Duration::from_millis(2));
            latest = plan(&mut m, &record, false);
        }
        assert_eq!(
            m.previews
                .values()
                .filter(|value| value["kind"] == "resourceSource")
                .count(),
            32
        );
        assert_eq!(m.previews.len(), 33);
        assert_eq!(m.previews["unrelated-preview"]["keep"], true);
        assert!(!m
            .previews
            .contains_key(oldest["previewId"].as_str().unwrap()));
        assert!(m
            .previews
            .contains_key(latest["previewId"].as_str().unwrap()));
        assert!(apply(&mut m, &oldest).unwrap_err().contains("过期"));
        assert_eq!(json!(read(&m, &record.id).unwrap()), original);
        assert_eq!(
            std::fs::read(directory.path().join("tool/config.json")).unwrap(),
            configuration
        );
        let changed = apply(&mut m, &latest).unwrap();
        assert_eq!(changed["binding"]["repository"], URL);
        assert_eq!(
            std::fs::read(directory.path().join("tool/config.json")).unwrap(),
            configuration
        );
        assert!(m.previews.contains_key("unrelated-preview"));
        assert_eq!(server.join().unwrap().len(), 41);
    }
}
