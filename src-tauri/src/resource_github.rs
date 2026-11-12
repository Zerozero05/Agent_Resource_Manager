//! Fixed GitHub release assets: preview first, bounded resumable transfer, then
//! an authenticated-in-process receipt for the existing selected-file installer.
use crate::{model::Manager, network, remote::github, resource_files};
use reqwest::{
    blocking::{Client, Response},
    StatusCode,
};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const MAX_ASSET: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Asset {
    id: u64,
    name: String,
    size: u64,
    digest: Option<String>,
    url: String,
    updated_at: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Partial {
    bytes: u64,
    sha256: String,
    etag: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Prepared {
    download_id: String,
    repo: String,
    release_id: u64,
    tag: String,
    author: String,
    asset: Asset,
    target: PathBuf,
    partial: PathBuf,
    rate: u64,
    progress: Option<Partial>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadRecord {
    schema_version: u32,
    id: String,
    status: String,
    prepared: Prepared,
    source: Option<DownloadSource>,
    fingerprint: Option<resource_files::Fingerprint>,
    updated_at: String,
    error: Option<String>,
}

pub(crate) enum DownloadStore {
    List { offset: u64, limit: u64 },
    Get(String),
    Save { id: String, record: Value },
}
pub(crate) fn initialize(db: &Connection) -> Result<(), String> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS download_records (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS download_records_updated ON download_records(updated_at DESC,id);")
        .map_err(|e|e.to_string())
}
pub(crate) fn store(db: &Connection, request: DownloadStore) -> Result<Value, String> {
    if let DownloadStore::List { offset, limit } = &request {
        if !(1..=100).contains(limit) || *offset > i64::MAX as u64 {
            return Err("下载列表分页范围无效".into());
        }
    }
    let available:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='download_records')",[],|row|row.get(0)).map_err(|e|e.to_string())?;
    if !available {
        return match request {
            DownloadStore::List { offset, limit } => {
                Ok(json!({"records":[],"total":0,"offset":offset,"limit":limit}))
            }
            DownloadStore::Get(_) => Ok(Value::Null),
            DownloadStore::Save { .. } => Err("下载记录存储尚不可用".into()),
        };
    }
    match request {
        DownloadStore::List { offset, limit } => {
            let total: u64 = db
                .query_row("SELECT COUNT(*) FROM download_records", [], |row| {
                    row.get(0)
                })
                .map_err(|e| e.to_string())?;
            let mut query=db.prepare("SELECT payload FROM download_records ORDER BY updated_at DESC,id LIMIT ?1 OFFSET ?2").map_err(|e|e.to_string())?;
            let records = query
                .query_map(rusqlite::params![limit, offset], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|e| e.to_string())?
                .map(|row| {
                    row.map_err(|e| e.to_string())
                        .and_then(|s| serde_json::from_str::<Value>(&s).map_err(|e| e.to_string()))
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(json!({"records":records,"total":total,"offset":offset,"limit":limit}))
        }
        DownloadStore::Get(id) => {
            let value = db
                .query_row(
                    "SELECT payload FROM download_records WHERE id=?1",
                    [id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            value
                .map(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
                .unwrap_or(Ok(Value::Null))
        }
        DownloadStore::Save { id, record } => {
            let record: DownloadRecord =
                serde_json::from_value(record).map_err(|_| "下载记录内容无效")?;
            if record.schema_version != 1
                || record.id != id
                || record.prepared.download_id != id
                || uuid::Uuid::parse_str(&id).is_err()
                || ![
                    "prepared",
                    "downloading",
                    "interrupted",
                    "failed",
                    "complete",
                ]
                .contains(&record.status.as_str())
            {
                return Err("下载记录身份或状态无效".into());
            }
            let value = serde_json::to_value(&record).map_err(|e| e.to_string())?;
            db.execute("INSERT INTO download_records(id,payload,updated_at) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at",
                rusqlite::params![id,serde_json::to_string(&value).map_err(|e|e.to_string())?,record.updated_at]).map_err(|e|e.to_string())?;
            Ok(value)
        }
    }
}
fn load_record(m: &Manager, id: &str) -> Result<Option<DownloadRecord>, String> {
    let value = m.download_store(DownloadStore::Get(id.into()))?;
    if value.is_null() {
        Ok(None)
    } else {
        serde_json::from_value(value)
            .map(Some)
            .map_err(|_| "下载记录无法读取".into())
    }
}
fn save_record(
    m: &Manager,
    record: &mut DownloadRecord,
    status: &str,
    error: Option<String>,
) -> Result<(), String> {
    record.status = status.into();
    // Transport errors can contain temporary addresses. Persist only a stable
    // summary; the current task receives its actual error separately.
    record.error = error.map(|_| {
        if status == "interrupted" {
            "下载已中断，已有内容保留"
        } else {
            "下载未完成，请重新核对已有内容"
        }
        .into()
    });
    record.updated_at = crate::model::now();
    m.download_store(DownloadStore::Save {
        id: record.id.clone(),
        record: serde_json::to_value(record).map_err(|e| e.to_string())?,
    })?;
    Ok(())
}
fn records(m: &Manager, request: &Value) -> Result<Value, String> {
    let offset = request
        .get("offset")
        .map(|v| v.as_u64().ok_or("分页起点无效"))
        .transpose()?
        .unwrap_or(0);
    let limit = request
        .get("limit")
        .map(|v| v.as_u64().ok_or("分页大小无效"))
        .transpose()?
        .unwrap_or(20);
    let data = m.download_store(DownloadStore::List { offset, limit })?;
    let entries=data["records"].as_array().ok_or("下载列表内容无效")?.iter().map(|v| {
        let r:DownloadRecord=serde_json::from_value(v.clone()).map_err(|_|"下载记录无法读取")?;
        Ok(json!({"id":r.id,"status":r.status,"assetName":r.prepared.asset.name,"repository":format!("https://github.com/{}",r.prepared.repo),
            "version":r.prepared.tag,"targetPath":r.prepared.target,"partialPath":r.prepared.partial,"receivedBytes":r.prepared.progress.as_ref().map(|p|p.bytes).unwrap_or(0),
            "totalBytes":r.prepared.asset.size,"updatedAt":r.updated_at}))
    }).collect::<Result<Vec<Value>,String>>()?;
    Ok(json!({"downloads":entries,"total":data["total"],"offset":offset,"limit":limit}))
}
fn record_stamp(record: &DownloadRecord) -> Result<String, String> {
    let bytes = serde_json::to_vec(record).map_err(|e| e.to_string())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadSource {
    pub repository: String,
    pub version: String,
    pub verification: String,
    pub author: String,
    pub release_id: u64,
    pub asset_id: u64,
    pub asset_name: String,
    pub download_url: String,
    pub sha256: String,
    pub expected_sha256: Option<String>,
}

fn text(v: &Value, key: &str, max: usize) -> Result<String, String> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty() && s.chars().count() <= max && !s.chars().any(char::is_control))
        .map(str::to_owned)
        .ok_or_else(|| format!("{key} 内容缺失或无效"))
}
fn id(v: &Value, key: &str) -> Result<u64, String> {
    v[key]
        .as_u64()
        .filter(|n| *n > 0)
        .ok_or_else(|| format!("{key} 标识无效"))
}
fn display(path: &Path) -> String {
    let s = path.to_string_lossy();
    s.strip_prefix(r"\\?\UNC\")
        .map(|r| format!(r"\\{r}"))
        .or_else(|| s.strip_prefix(r"\\?\").map(str::to_owned))
        .unwrap_or_else(|| s.into_owned())
}
fn location(request: &Value) -> Result<(String, Option<String>, Option<String>), String> {
    let raw = text(request, "repository", 4096)?;
    let url = url::Url::parse(&raw).map_err(|_| "请填写 GitHub 仓库或发行版链接")?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("请使用不含凭据或查询参数的 GitHub HTTPS 链接".into());
    }
    let parts = url
        .path_segments()
        .ok_or("GitHub 地址路径无效")?
        .filter(|s| !s.is_empty())
        .map(github::decode_component)
        .collect::<Result<Vec<_>, _>>()?;
    if parts.len() < 2 {
        return Err("GitHub 地址缺少作者或仓库".into());
    }
    let repo = github::parse_location(&format!("{}/{}", parts[0], parts[1]))?.repo;
    let (tag, name) = match parts.get(2).map(String::as_str) {
        None => (None, None),
        Some("releases") if parts.len() >= 5 && parts[3] == "tag" => {
            (Some(parts[4..].join("/")), None)
        }
        Some("releases") if parts.len() >= 6 && parts[3] == "download" => (
            Some(parts[4..parts.len() - 1].join("/")),
            parts.last().cloned(),
        ),
        _ => return Err("请选择仓库、发行版本或发行文件链接；Skill 子目录沿用技能来源入口".into()),
    };
    if tag
        .as_ref()
        .is_some_and(|s| s.len() > 160 || s.chars().any(char::is_control))
    {
        return Err("发行版本无效".into());
    }
    Ok((repo, tag, name))
}
fn digest(value: &Value) -> Result<Option<String>, String> {
    if value.is_null() {
        return Ok(None);
    }
    let raw = value.as_str().ok_or("发行文件摘要格式无效")?;
    let hash = raw
        .strip_prefix("sha256:")
        .filter(|s| s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or("发行文件摘要不是受支持的 SHA-256")?;
    Ok(Some(hash.to_ascii_lowercase()))
}
fn asset(value: &Value, repo: &str) -> Result<Asset, String> {
    let name = text(value, "name", 160)?;
    crate::local::validate_relative_path(&name)?;
    if name.contains(['/', '\\']) {
        return Err("发行文件名不能包含目录".into());
    }
    let size = value["size"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= MAX_ASSET)
        .ok_or("发行文件大小无效或超过 2 GiB")?;
    let url = text(value, "browser_download_url", 4096)?;
    let parsed = url::Url::parse(&url).map_err(|_| "发行下载地址无效")?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("github.com")
        || parsed.port().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !parsed
            .path()
            .to_ascii_lowercase()
            .starts_with(&format!("/{repo}/releases/download/").to_ascii_lowercase())
    {
        return Err("发行下载地址与已选 GitHub 仓库不一致".into());
    }
    if value["state"] != "uploaded" {
        return Err("发行文件尚未上传完成".into());
    }
    Ok(Asset {
        id: id(value, "id")?,
        name,
        size,
        digest: digest(&value["digest"])?,
        url,
        updated_at: text(value, "updated_at", 80)?,
    })
}

// This small seam keeps loopback fixtures out of the production URL policy.
trait Source {
    fn get(&self, segments: &[&str], fresh: bool) -> Result<Value, String>;
    fn open(
        &self,
        asset: &Asset,
        start: u64,
        end: u64,
        etag: Option<&str>,
    ) -> Result<Response, String>;
}
struct Github {
    api: github::Api,
    client: Client,
    token: Option<String>,
}
impl Github {
    fn new(repo: &str) -> Result<Self, String> {
        Ok(Self {
            api: github::Api::new(repo)?,
            client: network::client()?.0,
            token: github::credential(repo)?,
        })
    }
}
fn allowed_redirect(url: &url::Url) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && matches!(
            url.host_str(),
            Some(
                "github.com"
                    | "release-assets.githubusercontent.com"
                    | "objects.githubusercontent.com"
                    | "github-releases.githubusercontent.com"
            )
        )
}
impl Source for Github {
    fn get(&self, segments: &[&str], fresh: bool) -> Result<Value, String> {
        if fresh {
            self.api
                .optional(segments)?
                .ok_or_else(|| "GitHub 仓库、发行版或文件当前不可访问".into())
        } else {
            self.api.get(segments)
        }
    }
    fn open(
        &self,
        asset: &Asset,
        start: u64,
        end: u64,
        etag: Option<&str>,
    ) -> Result<Response, String> {
        let mut url = url::Url::parse(&format!(
            "https://api.github.com/repos/{}/releases/assets/{}",
            self.api.repo, asset.id
        ))
        .map_err(|_| "下载地址无效")?;
        for hop in 0..=4 {
            network::check_cancelled()?;
            let mut request = self
                .client
                .get(url.clone())
                .header("User-Agent", "Skill-Manager")
                .header("Accept", "application/octet-stream")
                .header("Accept-Encoding", "identity")
                .header("X-GitHub-Api-Version", "2022-11-28")
                .header("Range", format!("bytes={start}-{end}"));
            // No credential may follow a signed redirect to a different host.
            if hop == 0 {
                if let Some(token) = &self.token {
                    request = request.bearer_auth(token);
                }
            }
            if let Some(etag) = etag {
                request = request.header("If-Range", etag);
            }
            let response = request
                .send()
                .map_err(|_| "下载连接中断或超时，已收到的部分保留，可重试本次清单")?;
            if response.status().is_redirection() {
                let location = response
                    .headers()
                    .get("location")
                    .and_then(|s| s.to_str().ok())
                    .ok_or("下载重定向缺少目标")?;
                let next = url.join(location).map_err(|_| "下载重定向无效")?;
                if !allowed_redirect(&next) {
                    return Err("下载重定向不是可信的 GitHub 发行文件地址".into());
                }
                url = next;
            } else {
                return Ok(response);
            }
        }
        Err("GitHub 下载重定向次数过多".into())
    }
}

fn list(source: &impl Source, repo: &str, request: &Value) -> Result<Value, String> {
    let values = if let Some(tag) = request["tag"].as_str().filter(|s| !s.is_empty()) {
        if tag.len() > 160 || tag.chars().any(char::is_control) {
            return Err("发行版本无效".into());
        }
        vec![source.get(&["releases", "tags", tag], true)?]
    } else {
        source
            .get(&["releases"], false)?
            .as_array()
            .cloned()
            .ok_or("GitHub 发行列表格式无效")?
    };
    let mut releases = Vec::new();
    for value in values.into_iter().filter(|r| r["draft"] != true).take(30) {
        let mut assets = Vec::new();
        for item in value["assets"]
            .as_array()
            .ok_or("发行文件清单缺失")?
            .iter()
            .take(1000)
        {
            // Unsupported large/unfinished files remain visible, but cannot be downloaded.
            match asset(item,repo) {
                Ok(a) => assets.push(serde_json::to_value(a).map_err(|e|e.to_string())?),
                Err(reason) => assets.push(json!({"id":item["id"],"name":item["name"],"size":item["size"],"url":null,"unavailableReason":reason})),
            }
        }
        releases.push(json!({"id":id(&value,"id")?,"tag":text(&value,"tag_name",160)?,"name":value["name"],
            "url":value["html_url"],"publishedAt":value["published_at"],"prerelease":value["prerelease"] == true,"assets":assets}));
    }
    Ok(
        json!({"repository":format!("https://github.com/{repo}"),"author":repo.split('/').next(),"releases":releases}),
    )
}
fn release_asset(
    source: &impl Source,
    repo: &str,
    release_id: u64,
    asset_id: u64,
) -> Result<(Value, Asset), String> {
    let release = source.get(&["releases", &release_id.to_string()], true)?;
    if id(&release, "id")? != release_id || release["draft"] == true {
        return Err("已选发行版不可用或身份已变化".into());
    }
    let item = release["assets"]
        .as_array()
        .ok_or("发行文件清单缺失")?
        .iter()
        .find(|item| item["id"].as_u64() == Some(asset_id))
        .ok_or("发行文件已移除，请重新选择")?;
    let selected = asset(item, repo)?;
    let actual = asset(
        &source.get(&["releases", "assets", &asset_id.to_string()], true)?,
        repo,
    )?;
    if actual != selected {
        return Err("发行文件信息在核对期间变化，请重新预览".into());
    }
    Ok((release, actual))
}

/// Reads only repository/release metadata. It neither opens nor downloads an asset.
pub(crate) fn source_metadata(
    repository: &str,
    selection: Option<(u64, u64)>,
) -> Result<crate::resource_source::SourceBinding, String> {
    #[cfg(test)]
    if let Some(result) = automation_fixture::source_metadata(repository, selection) {
        return result;
    }
    let normalized = crate::resources::repository(&json!({"repository":repository}))?
        .ok_or("请填写 GitHub 仓库地址")?;
    let repo = normalized.trim_start_matches("https://github.com/");
    let source = Github::new(repo)?;
    let metadata = source.get(&[], true)?;
    let repository_id = id(&metadata, "id")?;
    if !text(&metadata, "full_name", 512)?.eq_ignore_ascii_case(repo) {
        return Err("GitHub 返回的仓库身份与所选来源不一致，请重新选择来源".into());
    }
    let mapped = selection
        .map(|(release_id, asset_id)| {
            let (release, asset) = release_asset(&source, repo, release_id, asset_id)?;
            Ok::<_, String>(crate::resource_source::AssetMapping {
                release_id,
                asset_id: asset.id,
                tag: text(&release, "tag_name", 160)?,
                asset_name: asset.name,
                size: asset.size,
                digest: asset.digest,
                url: asset.url,
                updated_at: asset.updated_at,
            })
        })
        .transpose()?;
    Ok(crate::resource_source::SourceBinding {
        repository: normalized,
        repository_id,
        asset: mapped,
        verified_at: crate::model::now(),
    })
}
fn wheel_asset(repo: &str, tag: &str, asset: &Asset) -> Result<bool, String> {
    if asset.name.to_ascii_lowercase().ends_with(".zip") {
        return Ok(false);
    }
    if repo.eq_ignore_ascii_case("panniantong/agent-reach")
        && asset.name
            == format!(
                "agent_reach-{}-py3-none-any.whl",
                tag.trim_start_matches('v')
            )
        && asset.digest.is_some()
    {
        return Ok(true);
    }
    Err(
        "请选择 ZIP 发行包，或已核对官方来源、版本和摘要的 Agent Reach wheel；不会替换为整仓源码"
            .into(),
    )
}

fn downloaded_inventory(
    p: &Prepared,
    path: &Path,
) -> Result<resource_files::PackageInventory, String> {
    if !wheel_asset(&p.repo, &p.tag, &p.asset)? {
        return resource_files::inspect_zip(path, MAX_ASSET);
    }
    let wheel = crate::resource_package::inspect_wheel(path)?;
    if wheel.package != "agent-reach"
        || wheel.version != p.tag.trim_start_matches('v')
        || !wheel.pure_python
        || !wheel.wheel_tags.iter().any(|tag| tag == "py3-none-any")
        || wheel.licenses.is_empty()
        || wheel.entry_points.get("agent-reach").map(String::as_str) != Some("agent_reach.cli:main")
    {
        return Err(
            "下载的 wheel 实际包名、版本、入口或许可与官方配方不一致，文件保留，未安装".into(),
        );
    }
    Ok(wheel.inventory)
}

fn preview(
    m: &mut Manager,
    source: &impl Source,
    repo: &str,
    request: &Value,
) -> Result<Value, String> {
    let release_id = id(request, "releaseId")?;
    let (release, asset) = release_asset(source, repo, release_id, id(request, "assetId")?)?;
    wheel_asset(repo, &text(&release, "tag_name", 160)?, &asset)?;
    let directory = PathBuf::from(text(request, "downloadDirectory", 32767)?);
    crate::transaction::verify_root(&directory)?;
    if !directory.is_dir() {
        return Err("请选择已有的下载目录".into());
    }
    let directory = PathBuf::from(display(&crate::local::canonical(&directory)?));
    let (_, available) = crate::storage::destination_space(&directory)?;
    if available.is_some_and(|n| n < asset.size) {
        return Err("下载目录可用空间不足".into());
    }
    let rate = match request.get("bytesPerSecond") {
        None | Some(Value::Null) => 0,
        Some(v) => v
            .as_u64()
            .filter(|n| *n == 0 || (1024..=1024 * 1024 * 1024).contains(n))
            .ok_or("下载限速须为 0 或每秒 1 KiB 至 1 GiB")?,
    };
    let download_id = uuid::Uuid::new_v4().to_string();
    let target = directory.join(format!("{download_id}-{}", asset.name));
    let partial = PathBuf::from(format!("{}.part", target.display()));
    let prepared = Prepared {
        download_id,
        repo: repo.into(),
        release_id,
        tag: text(&release, "tag_name", 160)?,
        author: text(&release["author"], "login", 160)?,
        asset,
        target,
        partial,
        rate,
        progress: None,
    };
    remember_download_preview(m, prepared, available, false, None)
}
fn remember_download_preview(
    m: &mut Manager,
    prepared: Prepared,
    available: Option<u64>,
    already_complete: bool,
    record_stamp: Option<String>,
) -> Result<Value, String> {
    let preview_id = uuid::Uuid::new_v4().to_string();
    let public = json!({"id":preview_id,"downloadId":prepared.download_id,"kind":"resourceDownload","repository":format!("https://github.com/{}",prepared.repo),
        "version":prepared.tag,"author":prepared.author,"releaseId":prepared.release_id,"assetId":prepared.asset.id,"assetName":prepared.asset.name,
        "downloadUrl":prepared.asset.url,"targetPath":prepared.target,"partialPath":prepared.partial,"downloadBytes":prepared.asset.size,
        "receivedBytes":prepared.progress.as_ref().map(|p|p.bytes).unwrap_or(0),"alreadyComplete":already_complete,
        "expectedSha256":prepared.asset.digest,"availableBytes":available,"downloadPeakBytes":prepared.asset.size,"canApply":true,"warnings":[if already_complete {"已完成文件与持久回执一致；确认后使用现有文件，不再次下载。"}else{"下载整个已选发行包以读取内部文件；安装前仍须选择必要运行文件及依赖。"}, if prepared.asset.digest.is_some() {"下载后核对 GitHub 提供的 SHA-256；这不代表运行能力或依赖已经验证。"} else {"上游没有提供 SHA-256；将记录实物摘要与来源，不能冒称已核对发布者摘要。"},"中断内容保留于列出的 .part 路径；不会自动清理或覆盖已有文件。"]});
    m.previews.insert(preview_id,json!({"kind":"resourceDownload","downloadId":prepared.download_id,"targetPath":prepared.target,"partialPath":prepared.partial,
        "alreadyComplete":already_complete,"recordStamp":record_stamp,
        "prepared":prepared,"public":public,"createdAt":chrono::Utc::now().timestamp_millis()}));
    crate::resource_lifecycle::trim_previews(&mut m.previews);
    Ok(public)
}

fn completed_inventory(
    record: &DownloadRecord,
) -> Result<Option<resource_files::PackageInventory>, String> {
    let p = &record.prepared;
    crate::transaction::verify_root(&p.target)?;
    if !p.target.try_exists().map_err(|e| e.to_string())? {
        if record.status == "complete" {
            return Err("已完成的下载文件不在原位置；不会自动重新下载".into());
        }
        return Ok(None);
    }
    let expected = record
        .fingerprint
        .as_ref()
        .ok_or("目标位置已有未经本次完成回执确认的文件，未覆盖")?;
    let source = record.source.as_ref().ok_or("下载缺少完整来源回执")?;
    let inventory = downloaded_inventory(p, &p.target)?;
    if &inventory.archive != expected
        || inventory.archive.sha256 != source.sha256
        || inventory.archive.bytes != p.asset.size
    {
        return Err("已完成下载文件与持久回执不一致，未复用或覆盖".into());
    }
    Ok(Some(inventory))
}
fn check_partial(p: &Prepared) -> Result<(), String> {
    crate::transaction::verify_root(&p.partial)?;
    if let Some(previous) = &p.progress {
        let current = resource_files::fingerprint(&p.partial)?;
        if current.bytes != previous.bytes || current.sha256 != previous.sha256 {
            return Err(
                "部分文件与已记录进度不一致，可能含未记录尾部；未截断或删除，请另选新下载".into(),
            );
        }
        if previous.bytes > 0 && p.asset.digest.is_none() && previous.etag.is_none() {
            return Err("缺少可核实的摘要或 ETag，不能安全续传".into());
        }
    } else if p.partial.try_exists().map_err(|e| e.to_string())? {
        return Err("部分文件尚无已保存的内容记录，不能猜测归属或截断，请另选新下载".into());
    }
    Ok(())
}
fn resume_preview(
    m: &mut Manager,
    source: &impl Source,
    record: DownloadRecord,
) -> Result<Value, String> {
    let stamp = Some(record_stamp(&record)?);
    if completed_inventory(&record)?.is_some() {
        return remember_download_preview(m, record.prepared, None, true, stamp);
    }
    check_partial(&record.prepared)?;
    let p = &record.prepared;
    let (release, current) = release_asset(source, &p.repo, p.release_id, p.asset.id)?;
    if current != p.asset
        || text(&release, "tag_name", 160)? != p.tag
        || text(&release["author"], "login", 160)? != p.author
    {
        return Err("固定发行资产已变化，不能继续原下载；部分文件保留".into());
    }
    let (_, available) =
        crate::storage::destination_space(p.target.parent().ok_or("下载目录无效")?)?;
    remember_download_preview(m, record.prepared, available, false, stamp)
}

fn hash_file(path: &Path) -> Result<Sha256, String> {
    let mut input = File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buf = [0; 65536];
    loop {
        network::check_cancelled()?;
        let n = input.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(hash)
}
fn strong_etag(response: &Response) -> Option<String> {
    response
        .headers()
        .get("etag")
        .and_then(|s| s.to_str().ok())
        .filter(|s| s.starts_with('"') && s.ends_with('"') && s.len() <= 256)
        .map(str::to_owned)
}
fn response_length(response: &Response, start: u64, end: u64, total: u64) -> Result<u64, String> {
    if response.status() == StatusCode::PARTIAL_CONTENT {
        let value = response
            .headers()
            .get("content-range")
            .and_then(|s| s.to_str().ok())
            .ok_or("续传响应缺少范围")?;
        if value != format!("bytes {start}-{end}/{total}") {
            return Err("下载响应范围与固定资产不一致".into());
        }
        Ok(end - start + 1)
    } else if response.status() == StatusCode::OK && start == 0 {
        Ok(total)
    } else {
        Err(format!(
            "下载服务器未接受固定范围（HTTP {}），已有内容保留",
            response.status().as_u16()
        ))
    }
}
fn transfer(
    source: &impl Source,
    p: &Prepared,
    progress: &mut Partial,
    mut checkpoint: impl FnMut(&Partial) -> Result<(), String>,
) -> Result<(), String> {
    crate::transaction::verify_root(&p.target)?;
    crate::transaction::verify_root(&p.partial)?;
    if p.target.exists() {
        return Err("下载目标已存在，不会覆盖；请重新预览".into());
    }
    let (_, available) =
        crate::storage::destination_space(p.target.parent().ok_or("下载目录无效")?)?;
    if available.is_some_and(|n| n < p.asset.size.saturating_sub(progress.bytes)) {
        return Err("下载目录可用空间不足".into());
    }
    let mut hash;
    let mut output;
    if let Some(previous) = &p.progress {
        let actual = resource_files::fingerprint(&p.partial)?;
        if actual.bytes != previous.bytes || actual.sha256 != previous.sha256 {
            return Err("续传文件已变化，请重新预览；原部分文件保留".into());
        }
        if actual.bytes > 0 && p.asset.digest.is_none() && previous.etag.is_none() {
            return Err("没有可验证的资产摘要或 ETag，不能安全续接，请重新预览".into());
        }
        hash = hash_file(&p.partial)?;
        output = OpenOptions::new()
            .append(true)
            .open(&p.partial)
            .map_err(|e| e.to_string())?;
    } else {
        hash = Sha256::new();
        output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&p.partial)
            .map_err(|e| e.to_string())?;
    }
    let began = Instant::now();
    let initial = progress.bytes;
    let mut last_report = Instant::now();
    let mut last_checkpoint = Instant::now();
    let result = (|| {
        while progress.bytes < p.asset.size {
            network::check_cancelled()?;
            let start = progress.bytes;
            let end = p.asset.size - 1;
            let _permit = network::acquire(true, true)?;
            let mut response = source.open(&p.asset, start, end, progress.etag.as_deref())?;
            if let Some(etag) = strong_etag(&response) {
                if progress.etag.as_ref().is_some_and(|old| old != &etag) {
                    return Err("发行文件 ETag 已变化，停止续传".into());
                }
                progress.etag = Some(etag);
            }
            let expected = response_length(&response, start, end, p.asset.size)?;
            if response.content_length().is_some_and(|len| len != expected) {
                return Err("下载响应长度与固定资产不一致".into());
            }
            let mut received = 0u64;
            let mut buf = [0; 65536];
            loop {
                network::check_cancelled()?;
                let n = response
                    .read(&mut buf)
                    .map_err(|_| "下载读取中断；已收到的部分保留，可重试本次清单")?;
                if n == 0 {
                    break;
                }
                if received + n as u64 > expected || progress.bytes + n as u64 > p.asset.size {
                    return Err("下载内容超过预览中的固定大小".into());
                }
                output.write_all(&buf[..n]).map_err(|e| e.to_string())?;
                hash.update(&buf[..n]);
                received += n as u64;
                progress.bytes += n as u64;
                if last_report.elapsed() >= Duration::from_millis(150)
                    || progress.bytes == p.asset.size
                {
                    crate::tasks::report_progress(
                        "下载已选发行文件",
                        Some(progress.bytes as usize),
                        Some(p.asset.size as usize),
                    );
                    last_report = Instant::now();
                }
                if last_checkpoint.elapsed() >= Duration::from_secs(1) {
                    output.flush().map_err(|e| e.to_string())?;
                    output.sync_all().map_err(|e| e.to_string())?;
                    progress.sha256 = format!("{:x}", hash.clone().finalize());
                    checkpoint(progress)?;
                    last_checkpoint = Instant::now();
                }
                if p.rate > 0 {
                    let due =
                        Duration::from_secs_f64((progress.bytes - initial) as f64 / p.rate as f64);
                    while began.elapsed() < due {
                        network::check_cancelled()?;
                        std::thread::sleep(
                            due.saturating_sub(began.elapsed())
                                .min(Duration::from_millis(50)),
                        );
                    }
                }
            }
            if received != expected {
                return Err("下载内容不完整，已有部分保留，可重试本次清单".into());
            }
            drop(response);
            drop(_permit);
        }
        output.flush().map_err(|e| e.to_string())?;
        output.sync_all().map_err(|e| e.to_string())?;
        Ok(())
    })();
    progress.sha256 = format!("{:x}", hash.finalize());
    // Normal cancellation/failure saves the exact tail, without checking the
    // cancellation flag again or discarding bytes already received.
    output.flush().map_err(|e| e.to_string())?;
    output.sync_all().map_err(|e| e.to_string())?;
    result
}

fn apply(m: &mut Manager, source: Option<&impl Source>, request: &Value) -> Result<Value, String> {
    if request.as_object().is_none_or(|o| {
        o.keys()
            .any(|k| !["action", "previewId"].contains(&k.as_str()))
    }) {
        return Err("下载只接受已存预览标识，不能提交新地址或确认布尔值".into());
    }
    let preview_id = text(request, "previewId", 64)?;
    let saved = m
        .previews
        .get(&preview_id)
        .cloned()
        .ok_or("下载预览已过期，请重新预览")?;
    if saved["kind"] != "resourceDownload" || saved["public"]["canApply"] != true {
        return Err("下载预览类型无效".into());
    }
    let p: Prepared =
        serde_json::from_value(saved["prepared"].clone()).map_err(|_| "下载预览内容无效")?;
    let existing = load_record(m, &p.download_id)?;
    if let Some(record) = &existing {
        if saved["recordStamp"].as_str() != Some(record_stamp(record)?.as_str())
            || p != record.prepared
        {
            return Err("该下载的持久状态已变化，本次旧预览失效；请重新读取记录".into());
        }
    } else if !saved["recordStamp"].is_null() {
        return Err("下载持久记录已变化，请重新核对".into());
    }
    let mut record = existing.unwrap_or_else(|| DownloadRecord {
        schema_version: 1,
        id: p.download_id.clone(),
        status: "prepared".into(),
        prepared: p.clone(),
        source: None,
        fingerprint: None,
        updated_at: crate::model::now(),
        error: None,
    });
    if let Some(inventory) = completed_inventory(&record)? {
        if record.status != "complete" {
            save_record(m, &mut record, "complete", None)?;
        }
        return finish_receipt(m, &preview_id, &record, inventory);
    }
    if saved["alreadyComplete"] == true {
        return Err("已完成文件不在原位置，未重新下载".into());
    }
    check_partial(&p)?;
    let source = source.ok_or("下载尚未完成，需要重新核对来源")?;
    let (release, current) = release_asset(source, &p.repo, p.release_id, p.asset.id)?;
    if current != p.asset
        || text(&release, "tag_name", 160)? != p.tag
        || text(&release["author"], "login", 160)? != p.author
    {
        return Err("发行资产或版本已变化，请重新预览；已有文件保留".into());
    }
    save_record(m, &mut record, "prepared", None)?;
    let mut progress = p.progress.clone().unwrap_or(Partial {
        bytes: 0,
        sha256: format!("{:x}", Sha256::digest([])),
        etag: None,
    });
    let outcome: Result<resource_files::PackageInventory, String> = (|| {
        let result = transfer(source, &p, &mut progress, |progress| {
            record.prepared.progress = Some(progress.clone());
            save_record(m, &mut record, "downloading", None)
        });
        if p.partial.is_file() {
            record.prepared.progress = Some(progress.clone());
        }
        result?;
        let (release, after) = release_asset(source, &p.repo, p.release_id, p.asset.id)?;
        if after != p.asset
            || text(&release, "tag_name", 160)? != p.tag
            || text(&release["author"], "login", 160)? != p.author
        {
            return Err("下载期间发行资产或版本变化，未安装；已有文件保留".into());
        }
        if p.asset
            .digest
            .as_ref()
            .is_some_and(|expected| expected != &progress.sha256)
        {
            return Err("下载 SHA-256 不匹配，未安装；文件保留，请重新预览".into());
        }
        let inventory = downloaded_inventory(&p, &p.partial)?;
        if inventory.archive.sha256 != progress.sha256 || inventory.archive.bytes != p.asset.size {
            return Err("下载文件在核验期间变化".into());
        }
        record.fingerprint = Some(inventory.archive.clone());
        record.source = Some(download_source(&p, &progress));
        // Persist the verified receipt before publishing. A restart between the
        // rename and final save can identify the final file without downloading.
        save_record(m, &mut record, "downloading", None)?;
        network::check_cancelled()?;
        publish(&p.partial, &p.target)?;
        save_record(m, &mut record, "complete", None)?;
        Ok(inventory)
    })();
    match outcome {
        Ok(inventory) => finish_receipt(m, &preview_id, &record, inventory),
        Err(error) => {
            let status = if error == "操作已取消" {
                "interrupted"
            } else {
                "failed"
            };
            let persistence = save_record(m, &mut record, status, Some(error.clone()));
            if let Some(stored) = m.previews.get_mut(&preview_id) {
                stored["prepared"] =
                    serde_json::to_value(&record.prepared).map_err(|e| e.to_string())?;
                stored["recordStamp"] = json!(record_stamp(&record)?);
            }
            persistence.map_err(|failure| {
                format!("{error}；下载状态保存失败：{failure}，请保留已有文件")
            })?;
            Err(error)
        }
    }
}
fn download_source(p: &Prepared, progress: &Partial) -> DownloadSource {
    DownloadSource {
        repository: format!("https://github.com/{}", p.repo),
        version: p.tag.clone(),
        verification: if p.asset.digest.is_some() {
            "githubDigest"
        } else {
            "githubAsset"
        }
        .into(),
        author: p.author.clone(),
        release_id: p.release_id,
        asset_id: p.asset.id,
        asset_name: p.asset.name.clone(),
        download_url: p.asset.url.clone(),
        sha256: progress.sha256.clone(),
        expected_sha256: p.asset.digest.clone(),
    }
}
fn finish_receipt(
    m: &mut Manager,
    preview_id: &str,
    record: &DownloadRecord,
    inventory: resource_files::PackageInventory,
) -> Result<Value, String> {
    let p = &record.prepared;
    let source = record.source.as_ref().ok_or("下载来源回执缺失")?;
    let download_id = p.download_id.clone();
    m.previews.remove(preview_id);
    m.previews.insert(download_id.clone(),json!({"kind":"resourceDownloadReceipt","archivePath":p.target,"targetPath":p.target,
        "fingerprint":inventory.archive,"source":source,"createdAt":chrono::Utc::now().timestamp_millis()}));
    crate::resource_lifecycle::trim_previews(&mut m.previews);
    Ok(
        json!({"complete":true,"format":if wheel_asset(&p.repo,&p.tag,&p.asset)? {"pythonWheel"} else {"zip"},"archivePath":p.target,"downloadId":download_id,"source":source,"files":inventory.files,
        "unpackedBytes":inventory.unpacked_bytes,"partialPath":p.partial}),
    )
}

fn publish(partial: &Path, target: &Path) -> Result<(), String> {
    crate::transaction::verify_root(partial)?;
    crate::transaction::verify_root(target)?;
    if partial.parent() != target.parent() {
        return Err("下载提交必须留在同一已选目录".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let from: Vec<_> = partial.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<_> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        // No MOVEFILE_REPLACE_EXISTING: an intervening destination wins, never overwritten.
        if unsafe {
            windows_sys::Win32::Storage::FileSystem::MoveFileExW(from.as_ptr(), to.as_ptr(), 0)
        } == 0
        {
            return Err(format!(
                "无法提交已校验下载，原部分文件保留：{}",
                std::io::Error::last_os_error()
            ));
        }
    }
    #[cfg(not(windows))]
    std::fs::hard_link(partial, target)
        .map_err(|e| format!("无法提交已校验下载，原部分文件保留：{e}"))?;
    Ok(())
}

pub(crate) fn verified_source(
    m: &Manager,
    request: &Value,
    archive: &Path,
    fingerprint: &resource_files::Fingerprint,
) -> Result<Option<DownloadSource>, String> {
    let Some(download_id) = request.get("downloadId").filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    let receipt = m
        .previews
        .get(download_id.as_str().ok_or("下载回执标识无效")?)
        .ok_or("下载回执已过期，请重新核对来源")?;
    if receipt["kind"] != "resourceDownloadReceipt"
        || receipt["archivePath"].as_str() != Some(display(archive).as_str())
    {
        return Err("下载回执与当前发行文件不一致".into());
    }
    let expected: resource_files::Fingerprint =
        serde_json::from_value(receipt["fingerprint"].clone()).map_err(|_| "下载回执摘要无效")?;
    if &expected != fingerprint {
        return Err("下载后文件已变化，不能沿用原来源证明".into());
    }
    let source: DownloadSource =
        serde_json::from_value(receipt["source"].clone()).map_err(|_| "下载来源回执无效")?;
    if request["repository"]
        .as_str()
        .is_some_and(|r| r != source.repository)
        || request["version"]
            .as_str()
            .is_some_and(|v| v != source.version)
    {
        return Err("填写的来源或版本与实际下载回执不一致".into());
    }
    Ok(Some(source))
}

pub(crate) fn handle(m: &mut Manager, request: &Value) -> Result<Option<Value>, String> {
    #[cfg(test)]
    if let Some(result) = automation_fixture::handle(m, request) {
        return result;
    }
    match request["action"].as_str().unwrap_or_default() {
        "resource_downloads" => records(m, request).map(Some),
        "preview_resource_resume" => {
            let record =
                load_record(m, &text(request, "downloadId", 64)?)?.ok_or("下载记录不存在")?;
            // Completed files can be recovered offline; do not even initialize
            // credentials or transport merely to inspect the local receipt.
            if completed_inventory(&record)?.is_some() {
                let stamp = Some(record_stamp(&record)?);
                return remember_download_preview(m, record.prepared, None, true, stamp).map(Some);
            }
            let source = Github::new(&record.prepared.repo)?;
            resume_preview(m, &source, record).map(Some)
        }
        "resource_github_releases" | "preview_resource_download" => {
            let (repo, tag, asset_name) = location(request)?;
            let source = Github::new(&repo)?;
            Ok(Some(if request["action"] == "resource_github_releases" {
                let mut resolved = request.clone();
                if let Some(tag) = tag {
                    if request["tag"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .is_some_and(|s| s != tag)
                    {
                        return Err("填写的版本与发行链接不一致".into());
                    }
                    resolved["tag"] = json!(tag);
                }
                let mut result = list(&source, &repo, &resolved)?;
                if let Some(name) = asset_name {
                    if let Some(releases) = result["releases"].as_array_mut() {
                        for release in releases {
                            if let Some(assets) = release["assets"].as_array_mut() {
                                assets.retain(|a| a["name"] == name);
                            }
                        }
                    }
                }
                result
            } else {
                preview(m, &source, &repo, request)?
            }))
        }
        "apply_resource_download" => Err("下载需要在本地界面核对并确认具体清单".into()),
        _ => Ok(None),
    }
}
pub(crate) fn apply_local(m: &mut Manager, request: &Value) -> Result<Option<Value>, String> {
    #[cfg(test)]
    if let Some(result) = automation_fixture::apply_local(m, request) {
        return result;
    }
    if request["action"] != "apply_resource_download" {
        return Ok(None);
    }
    let saved = m
        .previews
        .get(request["previewId"].as_str().ok_or("缺少预览标识")?)
        .ok_or("下载预览已过期")?;
    if saved["alreadyComplete"] == true {
        return apply(m, None::<&Github>, request).map(Some);
    }
    let repo = saved["prepared"]["repo"]
        .as_str()
        .ok_or("下载预览缺少来源")?;
    let source = Github::new(repo)?;
    apply(m, Some(&source), request).map(Some)
}

#[cfg(test)]
#[path = "resource_github_automation_fixture.rs"]
pub(crate) mod automation_fixture;

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use std::{
        cell::{Cell, RefCell},
        fs,
        io::Cursor,
        net::TcpListener,
    };

    #[test]
    fn wheel_download_requires_exact_official_source_and_checks_actual_record() {
        let directory = tempfile::tempdir().unwrap();
        let mut manager = Manager::new(directory.path().join("manager")).unwrap();
        let mut fixture = Fixture::new();
        fixture.asset["name"] = json!("agent_reach-1-py3-none-any.whl");
        fixture.asset["browser_download_url"] = json!("https://github.com/panniantong/agent-reach/releases/download/v1/agent_reach-1-py3-none-any.whl");
        let selected = asset(&fixture.asset, "panniantong/agent-reach").unwrap();
        assert!(wheel_asset("panniantong/agent-reach", "v1", &selected).unwrap());
        assert!(wheel_asset("other/agent-reach", "v1", &selected).is_err());
        assert!(wheel_asset("panniantong/agent-reach", "v2", &selected).is_err());
        let mut missing_digest = selected.clone();
        missing_digest.digest = None;
        assert!(wheel_asset("panniantong/agent-reach", "v1", &missing_digest).is_err());

        let prefix = "agent_reach-1.dist-info";
        let mut files = vec![
            (
                "agent_reach/__init__.py".to_owned(),
                "# inert fixture\n".to_owned(),
            ),
            (
                format!("{prefix}/METADATA"),
                "Metadata-Version: 2.4\nName: agent-reach\nVersion: 1\nRequires-Python: >=3.10\n\n"
                    .to_owned(),
            ),
            (
                format!("{prefix}/WHEEL"),
                "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n".to_owned(),
            ),
            (
                format!("{prefix}/entry_points.txt"),
                "[console_scripts]\nagent-reach = agent_reach.cli:main\n".to_owned(),
            ),
            (
                format!("{prefix}/licenses/LICENSE"),
                "Synthetic test license\n".to_owned(),
            ),
        ];
        let mut record = files
            .iter()
            .map(|(name, body)| {
                format!(
                    "{name},sha256={},{}\n",
                    URL_SAFE_NO_PAD.encode(Sha256::digest(body.as_bytes())),
                    body.len()
                )
            })
            .collect::<String>();
        record.push_str(&format!("{prefix}/RECORD,,\n"));
        files.push((format!("{prefix}/RECORD"), record));
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, body) in files {
            writer
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(body.as_bytes()).unwrap();
        }
        fixture.bytes = writer.finish().unwrap().into_inner();
        fixture.asset["size"] = json!(fixture.bytes.len());
        fixture.asset["digest"] = json!(format!("sha256:{:x}", Sha256::digest(&fixture.bytes)));
        let plan = preview(
            &mut manager,
            &fixture,
            "panniantong/agent-reach",
            &json!({"releaseId":11,"assetId":22,"downloadDirectory":directory.path()}),
        )
        .unwrap();
        let result = apply(&mut manager, Some(&fixture), &request(&plan)).unwrap();
        assert_eq!(result["format"], "pythonWheel");
        assert_eq!(result["complete"], true);
        assert!(!result["files"].as_array().unwrap().is_empty());
        let inspected = crate::resource_package::bind_reach_wheel(
            &manager,
            Path::new(result["archivePath"].as_str().unwrap()),
            result["downloadId"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(inspected.1.version, "1");
    }

    pub(super) struct Fixture {
        asset: Value,
        bytes: Vec<u8>,
        cut: Cell<Option<usize>>,
        bad_range: Cell<bool>,
        offsets: RefCell<Vec<u64>>,
        servers: RefCell<Vec<std::thread::JoinHandle<()>>>,
        ignore_range: bool,
    }
    impl Fixture {
        pub(super) fn automation_transport(bytes: Vec<u8>) -> Self {
            let mut fixture = Self::new();
            fixture.bytes = bytes;
            fixture
        }

        fn new() -> Self {
            let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
            for (name, body) in [
                ("bin/tool.txt", "synthetic runtime"),
                ("LICENSE", "synthetic license"),
                ("dev/test.txt", "development only"),
            ] {
                zip.start_file(name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                zip.write_all(body.as_bytes()).unwrap();
            }
            let bytes = zip.finish().unwrap().into_inner();
            let asset = json!({"id":22,"name":"fixture.zip","size":bytes.len(),"state":"uploaded",
                "digest":format!("sha256:{:x}",Sha256::digest(&bytes)),"updated_at":"2026-10-28T00:00:00Z",
                "browser_download_url":"https://github.com/synthetic/tool/releases/download/v1/fixture.zip"});
            Self {
                asset,
                bytes,
                cut: Cell::new(None),
                bad_range: Cell::new(false),
                offsets: RefCell::new(vec![]),
                servers: RefCell::new(vec![]),
                ignore_range: false,
            }
        }
        fn release(&self) -> Value {
            json!({"id":11,"tag_name":"v1","name":"Fixture","draft":false,"prerelease":false,
            "author":{"login":"synthetic"},"html_url":"https://github.com/synthetic/tool/releases/tag/v1",
            "published_at":"2026-10-28T00:00:00Z","assets":[self.asset]})
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            for server in self.servers.get_mut().drain(..) {
                let result = server.join();
                if !std::thread::panicking() {
                    result.expect("synthetic asset server failed");
                }
            }
        }
    }
    impl Source for Fixture {
        fn get(&self, segments: &[&str], _fresh: bool) -> Result<Value, String> {
            Ok(if segments == ["releases"] {
                json!([self.release()])
            } else if segments == ["releases", "assets", "22"] {
                self.asset.clone()
            } else if segments == ["releases", "11"] || segments == ["releases", "tags", "v1"] {
                self.release()
            } else {
                return Err("unexpected synthetic request".into());
            })
        }
        fn open(
            &self,
            _asset: &Asset,
            start: u64,
            end: u64,
            etag: Option<&str>,
        ) -> Result<Response, String> {
            self.offsets.borrow_mut().push(start);
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let bytes = self.bytes.clone();
            let cut = self.cut.take();
            let wrong = self.bad_range.get();
            let ignore = self.ignore_range;
            let expected_etag = etag.map(str::to_owned);
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut header = Vec::new();
                let mut byte = [0];
                while !header.ends_with(b"\r\n\r\n") && header.len() < 16384 {
                    stream.read_exact(&mut byte).unwrap();
                    header.push(byte[0]);
                }
                let header = String::from_utf8(header).unwrap().to_ascii_lowercase();
                assert!(header.contains(&format!("range: bytes={start}-{end}")));
                if let Some(etag) = expected_etag {
                    assert!(header.contains(&format!("if-range: {etag}")))
                }
                let total = bytes.len();
                let body = &bytes[start as usize..];
                let status = if ignore {
                    "200 OK"
                } else {
                    "206 Partial Content"
                };
                let range = if ignore {
                    String::new()
                } else {
                    format!(
                        "Content-Range: bytes {}-{end}/{total}\r\n",
                        if wrong { start + 1 } else { start }
                    )
                };
                write!(stream,"HTTP/1.1 {status}\r\nContent-Length: {}\r\n{range}ETag: \"fixture-v1\"\r\nConnection: close\r\n\r\n",body.len()).unwrap();
                stream
                    .write_all(&body[..cut.unwrap_or(body.len()).min(body.len())])
                    .unwrap();
            });
            let client = Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap();
            let mut request = client
                .get(format!("http://{address}/fixture"))
                .header("Range", format!("bytes={start}-{end}"));
            if let Some(etag) = etag {
                request = request.header("If-Range", etag)
            }
            let response = request.send().map_err(|e| e.to_string());
            self.servers.borrow_mut().push(server);
            response
        }
    }
    fn directory() -> tempfile::TempDir {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("work/resource-github-tests");
        fs::create_dir_all(&root).unwrap();
        tempfile::tempdir_in(root).unwrap()
    }
    fn plan(m: &mut Manager, f: &Fixture, root: &Path) -> Value {
        preview(
            m,
            f,
            "synthetic/tool",
            &json!({"releaseId":11,"assetId":22,"downloadDirectory":root}),
        )
        .unwrap()
    }
    fn request(p: &Value) -> Value {
        json!({"action":"apply_resource_download","previewId":p["id"]})
    }

    fn synthetic_dispatch(m: &mut Manager, request: &Value) -> Result<Value, String> {
        let f = Fixture::new();
        match request["action"].as_str().unwrap_or_default() {
            "preview_resource_download" => preview(m, &f, "synthetic/tool", request),
            "preview_resource_resume" => {
                let record = load_record(m, request["downloadId"].as_str().unwrap())?
                    .ok_or("missing synthetic download")?;
                resume_preview(m, &f, record)
            }
            "apply_resource_download" => {
                let saved = &m.previews[request["previewId"].as_str().unwrap()];
                if saved["prepared"]["progress"].is_null() {
                    f.cut.set(Some(37));
                }
                apply(m, Some(&f), request)
            }
            _ => crate::dispatch(m, request),
        }
    }

    #[test]
    fn shared_writer_keeps_progress_across_restart_without_replaying_downloads() {
        let dir = directory();
        let state = dir.path().join("state");
        let service = crate::tasks::TaskSystem::new(Manager::new(state.clone()).unwrap()).unwrap();
        let p = service.execute(json!({"action":"preview_resource_download","releaseId":11,"assetId":22,"downloadDirectory":dir.path()}), synthetic_dispatch).unwrap();
        let list_request = json!({"action":"resource_downloads"});
        assert_eq!(
            service
                .execute(list_request.clone(), synthetic_dispatch)
                .unwrap()["total"],
            0
        );
        assert!(service.execute(request(&p), synthetic_dispatch).is_err());
        let first = service
            .execute(list_request.clone(), synthetic_dispatch)
            .unwrap();
        assert_eq!(first["downloads"][0]["id"], p["downloadId"]);
        assert_eq!(first["downloads"][0]["receivedBytes"], 37);
        assert_eq!(first["downloads"][0]["status"], "failed");
        drop(service);

        let service = crate::tasks::TaskSystem::new(Manager::new(state).unwrap()).unwrap();
        let recovered = service.execute(list_request, synthetic_dispatch).unwrap();
        assert_eq!(recovered["downloads"], first["downloads"]);
        assert!(!Path::new(p["targetPath"].as_str().unwrap()).exists());
        assert_eq!(
            fs::metadata(p["partialPath"].as_str().unwrap())
                .unwrap()
                .len(),
            37
        );
        let ready = service
            .execute(
                json!({"action":"preview_resource_resume","downloadId":p["downloadId"]}),
                synthetic_dispatch,
            )
            .unwrap();
        assert_eq!(ready["receivedBytes"], 37);
        assert!(!Path::new(p["targetPath"].as_str().unwrap()).exists());
        let complete = service
            .execute(request(&ready), synthetic_dispatch)
            .unwrap();
        assert_eq!(complete["downloadId"], p["downloadId"]);
        assert_eq!(
            fs::read(complete["archivePath"].as_str().unwrap()).unwrap(),
            Fixture::new().bytes
        );
    }

    #[test]
    fn completed_download_is_restored_offline_and_modified_file_is_preserved() {
        let dir = directory();
        let state = dir.path().join("state");
        let mut m = Manager::new(state.clone()).unwrap();
        let f = Fixture::new();
        let p = plan(&mut m, &f, dir.path());
        let done = apply(&mut m, Some(&f), &request(&p)).unwrap();
        drop(m);
        let mut m = Manager::new(state).unwrap();
        assert!(m.previews.is_empty());
        let resume = json!({"action":"preview_resource_resume","downloadId":p["downloadId"]});
        let ready = handle(&mut m, &resume).unwrap().unwrap();
        assert_eq!(ready["alreadyComplete"], true);
        let complete = apply_local(&mut m, &request(&ready)).unwrap().unwrap();
        assert_eq!(complete["source"], done["source"]);
        let path = Path::new(complete["archivePath"].as_str().unwrap());
        let fingerprint = resource_files::fingerprint(path).unwrap();
        assert!(verified_source(
            &m,
            &json!({"downloadId":p["downloadId"]}),
            path,
            &fingerprint
        )
        .unwrap()
        .is_some());
        assert_eq!(*f.offsets.borrow(), vec![0]);
        let ready = handle(&mut m, &resume).unwrap().unwrap();
        fs::write(path, b"local replacement").unwrap();
        assert!(apply_local(&mut m, &request(&ready)).is_err());
        assert!(handle(&mut m, &resume).is_err());
        assert_eq!(fs::read(path).unwrap(), b"local replacement");
    }

    #[test]
    fn stale_resume_previews_cannot_replace_new_progress_or_a_completed_receipt() {
        let dir = directory();
        let mut m = Manager::new(dir.path().join("state")).unwrap();
        let f = Fixture::new();
        let p = plan(&mut m, &f, dir.path());
        f.cut.set(Some(37));
        assert!(apply(&mut m, Some(&f), &request(&p)).is_err());
        let initial = load_record(&m, p["downloadId"].as_str().unwrap())
            .unwrap()
            .unwrap();
        let first = resume_preview(&mut m, &f, initial.clone()).unwrap();
        let stale = resume_preview(&mut m, &f, initial).unwrap();
        f.cut.set(Some(13));
        assert!(apply(&mut m, Some(&f), &request(&first)).is_err());
        let current = load_record(&m, p["downloadId"].as_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(current.prepared.progress.as_ref().unwrap().bytes, 50);
        let stamp = record_stamp(&current).unwrap();
        assert!(apply(&mut m, Some(&f), &request(&stale))
            .unwrap_err()
            .contains("旧预览失效"));
        assert_eq!(
            record_stamp(&load_record(&m, &current.id).unwrap().unwrap()).unwrap(),
            stamp
        );
        let ready = resume_preview(&mut m, &f, current).unwrap();
        let done = apply(&mut m, Some(&f), &request(&ready)).unwrap();
        assert!(apply(&mut m, Some(&f), &request(&first)).is_err());
        assert_eq!(
            load_record(&m, p["downloadId"].as_str().unwrap())
                .unwrap()
                .unwrap()
                .status,
            "complete"
        );
        assert_eq!(
            fs::read(done["archivePath"].as_str().unwrap()).unwrap(),
            f.bytes
        );
    }

    #[test]
    fn rename_completion_gap_recovers_but_unrecorded_tail_and_changed_asset_do_not() {
        let dir = directory();
        let state = dir.path().join("state");
        let mut m = Manager::new(state.clone()).unwrap();
        let mut f = Fixture::new();
        let p = plan(&mut m, &f, dir.path());
        let prepared: Prepared =
            serde_json::from_value(m.previews[p["id"].as_str().unwrap()]["prepared"].clone())
                .unwrap();
        fs::write(&prepared.partial, &f.bytes).unwrap();
        let inventory = resource_files::inspect_zip(&prepared.partial, MAX_ASSET).unwrap();
        let progress = Partial {
            bytes: f.bytes.len() as u64,
            sha256: inventory.archive.sha256.clone(),
            etag: Some("\"fixture-v1\"".into()),
        };
        let mut record = DownloadRecord {
            schema_version: 1,
            id: prepared.download_id.clone(),
            status: "downloading".into(),
            prepared: Prepared {
                progress: Some(progress.clone()),
                ..prepared.clone()
            },
            source: Some(download_source(&prepared, &progress)),
            fingerprint: Some(inventory.archive),
            updated_at: crate::model::now(),
            error: None,
        };
        save_record(&m, &mut record, "downloading", None).unwrap();
        publish(&prepared.partial, &prepared.target).unwrap();
        drop(m);
        let mut m = Manager::new(state).unwrap();
        let ready = handle(
            &mut m,
            &json!({"action":"preview_resource_resume","downloadId":record.id}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            load_record(&m, &record.id).unwrap().unwrap().status,
            "downloading",
            "preview is read-only"
        );
        assert_eq!(
            apply_local(&mut m, &request(&ready)).unwrap().unwrap()["complete"],
            true
        );
        assert_eq!(
            load_record(&m, &record.id).unwrap().unwrap().status,
            "complete"
        );
        assert!(f.offsets.borrow().is_empty());

        let p = plan(&mut m, &f, dir.path());
        f.cut.set(Some(29));
        assert!(apply(&mut m, Some(&f), &request(&p)).is_err());
        let original = load_record(&m, p["downloadId"].as_str().unwrap())
            .unwrap()
            .unwrap();
        f.asset["updated_at"] = json!("changed fixed asset");
        assert!(resume_preview(&mut m, &f, original.clone())
            .unwrap_err()
            .contains("已变化"));
        OpenOptions::new()
            .append(true)
            .open(&original.prepared.partial)
            .unwrap()
            .write_all(b"unknown tail")
            .unwrap();
        let retained = fs::read(&original.prepared.partial).unwrap();
        assert!(resume_preview(&mut m, &f, original.clone())
            .unwrap_err()
            .contains("未截断"));
        assert_eq!(fs::read(&original.prepared.partial).unwrap(), retained);
        assert_eq!(
            load_record(&m, &original.id)
                .unwrap()
                .unwrap()
                .prepared
                .progress
                .unwrap()
                .bytes,
            29
        );
    }

    #[test]
    fn download_listing_is_bounded_and_does_not_store_transport_secrets() {
        let dir = directory();
        let m = Manager::new(dir.path().join("state")).unwrap();
        let f = Fixture::new();
        let mut creator = Manager::new(dir.path().join("creator")).unwrap();
        let p = plan(&mut creator, &f, dir.path());
        let prepared: Prepared =
            serde_json::from_value(creator.previews[p["id"].as_str().unwrap()]["prepared"].clone())
                .unwrap();
        for _ in 0..23 {
            let id = uuid::Uuid::new_v4().to_string();
            let mut record = DownloadRecord {
                schema_version: 1,
                id: id.clone(),
                status: "prepared".into(),
                prepared: Prepared {
                    download_id: id,
                    ..prepared.clone()
                },
                source: None,
                fingerprint: None,
                updated_at: String::new(),
                error: None,
            };
            save_record(
                &m,
                &mut record,
                "failed",
                Some("https://temporary.test/?token=secret-value".into()),
            )
            .unwrap();
        }
        let first = records(&m, &json!({})).unwrap();
        let second = records(&m, &json!({"offset":20,"limit":20})).unwrap();
        assert_eq!(first["total"], 23);
        assert_eq!(first["downloads"].as_array().unwrap().len(), 20);
        assert_eq!(second["downloads"].as_array().unwrap().len(), 3);
        let first_ids: Vec<_> = first["downloads"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["id"].clone())
            .collect();
        assert!(second["downloads"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| !first_ids.contains(&v["id"])));
        for bad in [
            json!({"limit":0}),
            json!({"limit":101}),
            json!({"offset":-1}),
            json!({"offset":u64::MAX}),
        ] {
            assert!(records(&m, &bad).is_err());
        }
        let stored = m
            .download_store(DownloadStore::List {
                offset: 0,
                limit: 100,
            })
            .unwrap()
            .to_string();
        assert!(!stored.contains("secret-value"));
        assert!(!stored.contains("temporary.test"));
    }

    #[test]
    fn stream_read_timeout_is_not_a_total_deadline_during_throttling() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (release, wait) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\na")
                .unwrap();
            wait.recv_timeout(Duration::from_secs(3)).unwrap();
            stream.write_all(b"b").unwrap();
        });
        let client = Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(300))
            .build()
            .unwrap();
        let mut response = client
            .get(format!("http://{address}/fixture"))
            .send()
            .unwrap();
        let mut first = [0];
        response.read_exact(&mut first).unwrap();
        assert_eq!(first, [b'a']);
        // Application throttling exceeds the client's individual read timeout.
        // No read is blocked during this pause, so the next read must work.
        std::thread::sleep(Duration::from_millis(450));
        release.send(()).unwrap();
        let mut second = [0];
        response.read_exact(&mut second).unwrap();
        assert_eq!(second, [b'b']);
        server.join().unwrap();
    }

    #[test]
    fn long_transfer_checkpoints_only_flushed_exact_bytes() {
        let dir = directory();
        let mut m = Manager::new(dir.path().join("state")).unwrap();
        let mut f = Fixture::new();
        // This transfer test needs bytes, not an installable package. Integrity
        // and package validation are exercised by the complete apply tests.
        f.bytes = vec![b'x'; 320 * 1024];
        f.asset["size"] = json!(f.bytes.len());
        f.asset["digest"] = json!(format!("sha256:{:x}", Sha256::digest(&f.bytes)));
        let p = preview(&mut m, &f, "synthetic/tool", &json!({"releaseId":11,"assetId":22,"downloadDirectory":dir.path(),"bytesPerSecond":131072})).unwrap();
        let prepared: Prepared =
            serde_json::from_value(m.previews[p["id"].as_str().unwrap()]["prepared"].clone())
                .unwrap();
        let mut progress = Partial {
            bytes: 0,
            sha256: format!("{:x}", Sha256::digest([])),
            etag: None,
        };
        let mut checkpoints = Vec::new();
        let mut last_checkpoint = Instant::now();
        transfer(&f, &prepared, &mut progress, |partial| {
            let actual = resource_files::fingerprint(&prepared.partial)?;
            assert_eq!(actual.bytes, partial.bytes);
            assert_eq!(actual.sha256, partial.sha256);
            assert!(last_checkpoint.elapsed() >= Duration::from_secs(1));
            last_checkpoint = Instant::now();
            checkpoints.push(partial.bytes);
            Ok(())
        })
        .unwrap();
        assert!(!checkpoints.is_empty());
        assert_eq!(progress.bytes, f.bytes.len() as u64);
        assert_eq!(progress.sha256, format!("{:x}", Sha256::digest(&f.bytes)));
    }

    #[test]
    fn github_links_are_scoped_and_metadata_does_not_download() {
        assert_eq!(
            location(
                &json!({"repository":"https://github.com/Owner/Repo/releases/tag/release%2Fv1"})
            )
            .unwrap(),
            ("Owner/Repo".into(), Some("release/v1".into()), None)
        );
        assert_eq!(
            location(
                &json!({"repository":"https://github.com/Owner/Repo/releases/download/v1/tool.zip"})
            )
            .unwrap()
            .2
            .as_deref(),
            Some("tool.zip")
        );
        for bad in [
            "https://evil.test/owner/repo",
            "https://user:secret@github.com/owner/repo",
            "https://github.com/owner/repo?token=x",
            "https://github.com/owner/repo/issues/1",
        ] {
            assert!(location(&json!({"repository":bad})).is_err());
        }
        let f = Fixture::new();
        assert!(asset(&f.asset, "SYNTHETIC/Tool").is_ok());
        let result = list(&f, "synthetic/tool", &json!({})).unwrap();
        assert_eq!(result["releases"][0]["assets"][0]["id"], 22);
        assert!(f.offsets.borrow().is_empty());
        for bad in [
            "https://evil.test/a",
            "http://objects.githubusercontent.com/a",
            "https://user:pass@release-assets.githubusercontent.com/a",
        ] {
            assert!(!allowed_redirect(&url::Url::parse(bad).unwrap()));
        }
        assert!(allowed_redirect(
            &url::Url::parse(
                "https://release-assets.githubusercontent.com/path?signature=temporary"
            )
            .unwrap()
        ));
    }

    #[test]
    fn downloaded_bytes_bind_minimal_install_source_and_reject_forgery() {
        let dir = directory();
        let mut m = Manager::new(dir.path().join("state")).unwrap();
        let f = Fixture::new();
        let p = plan(&mut m, &f, dir.path());
        assert!(!Path::new(p["targetPath"].as_str().unwrap()).exists());
        assert!(handle(&mut m, &request(&p)).is_err());
        let mut forged = request(&p);
        forged["confirmed"] = json!(true);
        assert!(apply(&mut m, Some(&f), &forged).is_err());
        let done = apply(&mut m, Some(&f), &request(&p)).unwrap();
        assert_eq!(done["complete"], true);
        assert_eq!(done["source"]["verification"], "githubDigest");
        assert!(apply(&mut m, Some(&f), &request(&p)).is_err());
        let install = json!({"action":"preview_resource_install","archivePath":done["archivePath"],"downloadId":done["downloadId"],
            "destinationPath":dir.path().join("runtime"),"name":"Fixture","kind":"cli","selectedFiles":["bin/tool.txt"]});
        let ready = crate::resource_lifecycle::handle(&mut m, &install)
            .unwrap()
            .unwrap();
        assert_eq!(ready["source"]["assetId"], 22);
        assert_eq!(ready["files"].as_array().unwrap().len(), 2);
        let result = crate::resource_lifecycle::apply_local(
            &mut m,
            &json!({"action":"apply_resource_install","previewId":ready["id"]}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            result["resource"]["installation"]["downloadSource"]["assetId"],
            22
        );
        assert!(dir.path().join("runtime/bin/tool.txt").is_file());
        assert!(!dir.path().join("runtime/dev").exists());
        let mut forged = install.clone();
        forged["version"] = json!("unrelated");
        assert!(crate::resource_lifecycle::handle(&mut m, &forged).is_err());
        fs::write(done["archivePath"].as_str().unwrap(), b"changed bytes").unwrap();
        assert!(crate::resource_lifecycle::handle(&mut m, &install).is_err());
    }

    #[test]
    fn interrupted_stream_resumes_only_the_same_bytes_and_fixed_asset() {
        let dir = directory();
        let mut m = Manager::new(dir.path().join("state")).unwrap();
        let f = Fixture::new();
        let p = plan(&mut m, &f, dir.path());
        f.cut.set(Some(37));
        assert!(apply(&mut m, Some(&f), &request(&p)).is_err());
        assert!(m.previews.contains_key(p["id"].as_str().unwrap()));
        assert_eq!(
            fs::metadata(p["partialPath"].as_str().unwrap())
                .unwrap()
                .len(),
            37
        );
        let done = apply(&mut m, Some(&f), &request(&p)).unwrap();
        assert_eq!(*f.offsets.borrow(), vec![0, 37]);
        assert_eq!(
            fs::read(done["archivePath"].as_str().unwrap()).unwrap(),
            f.bytes
        );

        let p = plan(&mut m, &f, dir.path());
        f.cut.set(Some(19));
        assert!(apply(&mut m, Some(&f), &request(&p)).is_err());
        fs::write(p["partialPath"].as_str().unwrap(), b"tampered partial").unwrap();
        let count = f.offsets.borrow().len();
        assert!(apply(&mut m, Some(&f), &request(&p)).is_err());
        assert_eq!(count, f.offsets.borrow().len());
    }

    #[test]
    fn changed_asset_wrong_range_digest_and_existing_target_never_commit() {
        let dir = directory();
        let mut m = Manager::new(dir.path().join("state")).unwrap();
        let mut f = Fixture::new();
        let p = plan(&mut m, &f, dir.path());
        f.asset["updated_at"] = json!("2026-10-28T00:01:00Z");
        assert!(apply(&mut m, Some(&f), &request(&p)).is_err());
        assert!(f.offsets.borrow().is_empty());
        let p = plan(&mut m, &f, dir.path());
        f.bad_range.set(true);
        assert!(apply(&mut m, Some(&f), &request(&p)).is_err());
        assert!(!Path::new(p["targetPath"].as_str().unwrap()).exists());
        f.bad_range.set(false);
        f.asset["digest"] = json!(format!("sha256:{}", "0".repeat(64)));
        let p = plan(&mut m, &f, dir.path());
        assert!(apply(&mut m, Some(&f), &request(&p))
            .unwrap_err()
            .contains("SHA-256"));
        assert!(!Path::new(p["targetPath"].as_str().unwrap()).exists());
        let p = plan(&mut m, &f, dir.path());
        fs::write(p["targetPath"].as_str().unwrap(), b"user file").unwrap();
        assert!(apply(&mut m, Some(&f), &request(&p)).is_err());
        assert_eq!(
            fs::read(p["targetPath"].as_str().unwrap()).unwrap(),
            b"user file"
        );
    }

    #[test]
    fn ignored_range_is_throttled_during_stream_and_cancellation_keeps_partial() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        let dir = directory();
        let mut m = Manager::new(dir.path().join("state")).unwrap();
        let mut f = Fixture::new();
        f.ignore_range = true;
        let p=preview(&mut m,&f,"synthetic/tool",&json!({"releaseId":11,"assetId":22,"downloadDirectory":dir.path(),"bytesPerSecond":1024})).unwrap();
        let flag = Arc::new(AtomicBool::new(false));
        let trigger = flag.clone();
        let partial = PathBuf::from(p["partialPath"].as_str().unwrap());
        let cancel = std::thread::spawn(move || {
            let began = Instant::now();
            while !fs::metadata(&partial).is_ok_and(|m| m.len() > 0) {
                assert!(
                    began.elapsed() < Duration::from_secs(5),
                    "synthetic stream did not write bytes"
                );
                std::thread::sleep(Duration::from_millis(1));
            }
            trigger.store(true, Ordering::Relaxed);
        });
        let result = network::with_task_context(
            network::TaskContext {
                foreground: true,
                cancel: flag,
            },
            || apply(&mut m, Some(&f), &request(&p)),
        );
        cancel.join().unwrap();
        assert!(result.is_err());
        assert!(Path::new(p["partialPath"].as_str().unwrap()).is_file());
        assert!(!Path::new(p["targetPath"].as_str().unwrap()).exists());
        assert!(
            m.previews[p["id"].as_str().unwrap()]["prepared"]["progress"]["bytes"]
                .as_u64()
                .unwrap()
                > 0
        );
        let resumed = apply(&mut m, Some(&f), &request(&p)).unwrap();
        assert_eq!(resumed["complete"], true);
    }
}
