//! Explicit, inert configuration transfer. No executable definitions, ownership,
//! credentials, runtime evidence or one-shot grants travel in this format.
use crate::{
    model::{Manager, State},
    resources::ResourceRecord,
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    path::{Component, Path},
};

const MAX_BYTES: usize = 8 * 1024 * 1024;
const SETTINGS: &[&str] = &[
    "editorPath",
    "uiTheme",
    "uiZoom",
    "uiFontSize",
    "uiAccent",
    "uiDensity",
    "uiMotion",
    "libraryMode",
    "libraryPageSize",
    "librarySort",
    "sidebarWidth",
    "sidebarCollapsed",
    "maintenance",
    "network",
];
const SKILL: &[&str] = &[
    "id",
    "name",
    "displayName",
    "localPath",
    "sourceId",
    "repo",
    "branch",
    "remotePath",
    "categoryId",
    "favorite",
    "enabled",
    "runtimeFiles",
];
const SOURCE: &[&str] = &["id", "kind", "repo", "branch", "roots", "ignoredPaths"];
const TOOL: &[&str] = &[
    "id",
    "name",
    "kind",
    "rootPath",
    "repository",
    "sourceBinding",
    "alias",
    "notes",
    "updatePolicy",
];
const ROOT: &[&str] = &["id", "name", "path", "enabled"];

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Item {
    kind: String,
    id: String,
    data: Value,
}
impl Item {
    fn key(&self) -> String {
        format!("{}:{}", self.kind, self.id)
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Document {
    format: String,
    format_version: u32,
    items: Vec<Item>,
}
pub(crate) enum StoreRequest {
    Read,
    Apply {
        document: Document,
        expected_revision: u64,
        selected: BTreeSet<String>,
    },
}

fn select(value: &Value, fields: &[&str]) -> Value {
    Value::Object(
        fields
            .iter()
            .filter_map(|key| value.get(*key).map(|v| ((*key).into(), v.clone())))
            .collect(),
    )
}
fn fields(value: &Value, allowed: &[&str]) -> Result<(), String> {
    if value
        .as_object()
        .is_none_or(|o| o.keys().any(|key| !allowed.contains(&key.as_str())))
    {
        return Err("配置包含不支持的字段；未修改本机信息".into());
    }
    Ok(())
}
fn text<'a>(
    value: &'a Value,
    field: &str,
    limit: usize,
    required: bool,
) -> Result<&'a str, String> {
    let value = match value.get(field) {
        Some(Value::String(value)) => value.as_str(),
        None | Some(Value::Null) if !required => "",
        _ => return Err(format!("配置字段 {field} 不是有效文字")),
    };
    if value.len() > limit || value.contains('\0') || (required && value.trim().is_empty()) {
        return Err(format!("配置字段 {field} 缺失或过长"));
    }
    Ok(value)
}
fn array<'a>(value: &'a Value, field: &str) -> Result<&'a Vec<Value>, String> {
    value[field]
        .as_array()
        .filter(|v| v.len() <= 10000)
        .ok_or_else(|| format!("配置字段 {field} 必须是有限列表"))
}
fn string_list(value: &Value, field: &str) -> Result<(), String> {
    if let Some(values) = value.get(field) {
        if !values.is_null()
            && values.as_array().is_none_or(|list| {
                list.len() > 10000
                    || list.iter().any(|v| {
                        v.as_str()
                            .is_none_or(|s| s.len() > 32767 || s.contains('\0'))
                    })
            })
        {
            return Err(format!("配置字段 {field} 包含无效路径或文字"));
        }
    }
    Ok(())
}
fn path_syntax(path: &str) -> Result<(), String> {
    let path = Path::new(path);
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err("配置位置必须是无上级跳转的完整路径".into());
    }
    Ok(())
}
fn is_link(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}
fn checked_path(path: &Path, exists: bool) -> Result<(), String> {
    path_syntax(&path.to_string_lossy())?;
    for (i, part) in path.ancestors().enumerate() {
        match fs::symlink_metadata(part) {
            Ok(meta) if is_link(&meta) => {
                return Err("配置位置经过链接或目录联接，请重新选择".into())
            }
            Ok(_) => {}
            Err(e) if i == 0 && !exists && e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("配置位置不可读取：{e}")),
        }
    }
    Ok(())
}
fn read_file(path: &Path) -> Result<(Document, String), String> {
    use sha2::{Digest, Sha256};
    checked_path(path, true)?;
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("请选择配置文件".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("配置文件超过8MiB，未读取或导入".into());
    }
    let document: Document =
        serde_json::from_slice(&bytes).map_err(|_| "配置文件格式无效，未修改本机信息")?;
    validate(&document)?;
    Ok((document, format!("{:x}", Sha256::digest(&bytes))))
}
fn repo(value: &Value, field: &str) -> Result<(), String> {
    let raw = text(value, field, 512, false)?;
    if raw.is_empty() {
        return Ok(());
    }
    let url = if field == "repo" {
        format!("https://github.com/{raw}")
    } else {
        raw.into()
    };
    crate::resources::repository(&json!({"repository":url}))?;
    Ok(())
}
fn settings(value: &Value) -> Result<(), String> {
    fields(value, SETTINGS)?;
    for (key, allowed) in [
        ("uiTheme", &["light", "dark", "eye"][..]),
        ("libraryMode", &["list", "details", "cards"][..]),
        ("librarySort", &["name", "status", "checked"][..]),
        ("uiAccent", &["violet", "blue", "teal", "rose"][..]),
        ("uiDensity", &["compact", "comfortable"][..]),
        ("uiMotion", &["system", "light", "none"][..]),
    ] {
        if value
            .get(key)
            .is_some_and(|v| v.as_str().is_none_or(|v| !allowed.contains(&v)))
        {
            return Err(format!("配置字段 {key} 无效"));
        }
    }
    for (key, min, max) in [
        ("uiZoom", 80, 160),
        ("uiFontSize", 14, 22),
        ("sidebarWidth", 200, 420),
    ] {
        if value
            .get(key)
            .is_some_and(|v| v.as_u64().is_none_or(|v| !(min..=max).contains(&v)))
        {
            return Err(format!("配置字段 {key} 超出范围"));
        }
    }
    if value
        .get("libraryPageSize")
        .is_some_and(|v| !matches!(v.as_u64(), Some(20 | 50 | 100)))
    {
        return Err("配置分页大小无效".into());
    }
    if value
        .get("sidebarCollapsed")
        .is_some_and(|v| !v.is_boolean())
    {
        return Err("侧栏设置无效".into());
    }
    text(value, "editorPath", 32767, false)?;
    if value.get("maintenance").is_some()
        && crate::maintenance::snapshot(value, false)["valid"] != true
    {
        return Err("导入的维护策略无效".into());
    }
    if let Some(network) = value.get("network") {
        fields(network, &["mode", "proxyUrl"])?;
        crate::network::Settings::from_value(network)?;
    }
    Ok(())
}

// A portable mapping is a description, not a transferred verification result.
fn source_binding(value: &Value, repository: &Value) -> Result<(), String> {
    if value.is_null() {
        return Ok(());
    }
    fields(value, &["repository", "repositoryId", "asset"])?;
    repo(value, "repository")?;
    if value["repository"] != *repository || value["repositoryId"].as_u64().is_none_or(|id| id == 0)
    {
        return Err("来源映射与工具仓库不一致".into());
    }
    if let Some(asset) = value.get("asset").filter(|asset| !asset.is_null()) {
        fields(
            asset,
            &[
                "releaseId",
                "assetId",
                "tag",
                "assetName",
                "size",
                "digest",
                "url",
                "updatedAt",
            ],
        )?;
        for key in ["releaseId", "assetId"] {
            if asset[key].as_u64().is_none_or(|id| id == 0) {
                return Err("发行资产身份无效".into());
            }
        }
        if asset["size"].as_u64().is_none() {
            return Err("发行资产大小无效".into());
        }
        for key in ["tag", "assetName", "updatedAt"] {
            text(asset, key, 1024, true)?;
        }
        let digest = text(asset, "digest", 128, false)?;
        if !digest.is_empty() {
            let hash = digest.strip_prefix("sha256:").unwrap_or(digest);
            if hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_hexdigit()) {
                return Err("发行资产摘要无效".into());
            }
        }
        let address = text(asset, "url", 4096, true)?;
        let parsed = url::Url::parse(address).map_err(|_| "发行资产地址无效")?;
        let prefix = format!(
            "{}/releases/download/",
            value["repository"].as_str().unwrap_or_default()
        );
        if parsed.scheme() != "https"
            || parsed.host_str() != Some("github.com")
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || parsed.port().is_some()
            || !address.starts_with(&prefix)
        {
            return Err("发行资产地址必须属于所选仓库，且不含凭据或临时查询参数".into());
        }
    }
    Ok(())
}
fn validate(document: &Document) -> Result<(), String> {
    if document.format != "agent-resource-manager-config"
        || document.format_version != 1
        || document.items.len() > 20000
    {
        return Err("不支持此配置格式或版本，原信息保留".into());
    }
    if serde_json::to_vec(document)
        .map_err(|e| e.to_string())?
        .len()
        > MAX_BYTES
    {
        return Err("配置超过8MiB，未读取或导入".into());
    }
    let mut keys = BTreeSet::new();
    for item in &document.items {
        if item.id.is_empty()
            || item.id.len() > 160
            || item.id.chars().any(char::is_control)
            || !keys.insert(item.key())
        {
            return Err("配置身份重复或无效".into());
        }
        let value = &item.data;
        match item.kind.as_str() {
            "settings" => {
                if item.id != "preferences" {
                    return Err("未知设置身份".into());
                }
                settings(value)?;
            }
            "category" => {
                fields(value, &["id", "name", "color"])?;
                text(value, "name", 160, true)?;
                if let Some(color) = value.get("color") {
                    if ![
                        "blue", "teal", "green", "purple", "orange", "rose", "indigo", "slate",
                    ]
                    .contains(&color.as_str().unwrap_or_default())
                    {
                        return Err("分类颜色无效".into());
                    }
                }
            }
            "source" => {
                fields(value, SOURCE)?;
                repo(value, "repo")?;
                text(value, "branch", 512, false)?;
                string_list(value, "roots")?;
                string_list(value, "ignoredPaths")?;
                if value["kind"] != "github" {
                    return Err("不支持此来源类型".into());
                }
            }
            "skill" => {
                fields(value, SKILL)?;
                text(value, "name", 512, true)?;
                text(value, "displayName", 512, false)?;
                repo(value, "repo")?;
                for key in ["sourceId", "categoryId", "branch", "remotePath"] {
                    text(value, key, 2048, false)?;
                }
                if let Some(path) = value["remotePath"].as_str().filter(|path| !path.is_empty()) {
                    crate::local::validate_relative_path(path)?;
                }
                for key in ["favorite", "enabled"] {
                    if value.get(key).is_some_and(|v| !v.is_boolean()) {
                        return Err(format!("{key} 必须为开关"));
                    }
                }
                let path = text(value, "localPath", 32767, false)?;
                if !path.is_empty() {
                    path_syntax(path)?;
                }
                string_list(value, "runtimeFiles")?;
                for path in value["runtimeFiles"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                {
                    crate::local::validate_relative_path(path)?;
                }
            }
            "tool" => {
                fields(value, TOOL)?;
                text(value, "name", 160, true)?;
                text(value, "alias", 160, false)?;
                text(value, "notes", 4096, false)?;
                path_syntax(text(value, "rootPath", 32767, true)?)?;
                repo(value, "repository")?;
                source_binding(&value["sourceBinding"], &value["repository"])?;
                if !["skill", "portable", "cli", "mcp"]
                    .contains(&value["kind"].as_str().unwrap_or_default())
                {
                    return Err("工具类型无效".into());
                }
                crate::resources::update_policy(&value["updatePolicy"])?;
            }
            "root" => {
                fields(value, ROOT)?;
                text(value, "name", 512, false)?;
                path_syntax(text(value, "path", 32767, true)?)?;
                if value
                    .get("enabled")
                    .is_some_and(|enabled| !enabled.is_boolean())
                {
                    return Err("目录启用设置必须为开关".into());
                }
            }
            "ignoredPaths" => {
                fields(value, &["paths"])?;
                string_list(value, "paths")?;
                for path in array(value, "paths")? {
                    path_syntax(path.as_str().ok_or("忽略路径无效")?)?;
                }
            }
            "annotation" => {
                fields(value, &["alias", "notes"])?;
                text(value, "alias", 160, false)?;
                text(value, "notes", 4096, false)?;
            }
            "view" => {
                fields(value, &["id", "name", "view", "filters"])?;
                text(value, "name", 160, true)?;
                crate::management_data::validate_filters(
                    text(value, "view", 16, true)?,
                    &value["filters"],
                )?;
            }
            "template" => {
                fields(
                    value,
                    &["id", "name", "resourceId", "actionId", "parameters"],
                )?;
                text(value, "name", 160, true)?;
                text(value, "resourceId", 64, true)?;
                text(value, "actionId", 64, true)?;
                let p = value["parameters"].as_object().ok_or("模板参数无效")?;
                if p.len() > 32
                    || p.iter().any(|(k, v)| {
                        crate::resource_runtime::sensitive_parameter_name(k)
                            || (!v.is_i64()
                                && v.as_str()
                                    .is_none_or(|s| s.len() > 32767 || s.contains('\0')))
                    })
                {
                    return Err("配置包含敏感或无效模板参数".into());
                }
            }
            "scene" => {
                fields(value, &["id", "name", "members"])?;
                text(value, "name", 160, true)?;
                let mut members = BTreeSet::new();
                for member in array(value, "members")? {
                    let endpoint: crate::resource_relations::Endpoint =
                        serde_json::from_value(member.clone()).map_err(|_| "场景成员无效")?;
                    if !["tool", "skill"].contains(&endpoint.kind.as_str())
                        || endpoint.id.is_empty()
                        || !members.insert(endpoint)
                    {
                        return Err("场景成员重复或无效".into());
                    }
                }
            }
            "relation" => {
                fields(value, &["id", "dependent", "dependency"])?;
                for field in ["dependent", "dependency"] {
                    let endpoint: crate::resource_relations::Endpoint =
                        serde_json::from_value(value[field].clone()).map_err(|_| "依赖端点无效")?;
                    if !["tool", "skill"].contains(&endpoint.kind.as_str())
                        || endpoint.id.is_empty()
                    {
                        return Err("依赖端点无效".into());
                    }
                }
                if value["dependent"] == value["dependency"] {
                    return Err("资源不能依赖自己".into());
                }
            }
            _ => return Err("配置含不支持的管理项目".into()),
        }
        if value.get("id").is_some_and(|id| id != &item.id) {
            return Err("配置项目身份不一致".into());
        }
    }
    Ok(())
}

fn rows(db: &Connection, table: &str, query: &str) -> Result<Vec<Value>, String> {
    let exists: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
            [table],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Ok(vec![]);
    }
    let mut statement = db.prepare(query).map_err(|e| e.to_string())?;
    let records = statement
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    records
        .map(|v| {
            serde_json::from_str(&v.map_err(|e| e.to_string())?)
                .map_err(|_| "管理记录无法读取，原信息保留".into())
        })
        .collect()
}

fn portable_template_parameters(
    record: Option<&ResourceRecord>,
    data: &Value,
) -> Result<(), String> {
    let Some(definition) = record.and_then(|record| {
        crate::resource_runtime::registered_definition(record, data["actionId"].as_str()?).ok()
    }) else {
        return Ok(());
    };
    for parameter in &definition.parameters {
        if data["parameters"].get(&parameter.name).is_some()
            && (parameter.sensitive || !parameter.template_allowed)
        {
            return Err(format!(
                "参数 {} 不允许随配置保存；凭据和敏感参数须在本次调用时填写",
                parameter.name
            ));
        }
    }
    Ok(())
}

pub(crate) fn read(db: &Connection, state: &State) -> Result<Document, String> {
    let mut preferences = select(&state.settings, SETTINGS);
    if let Some(maintenance) = preferences.get_mut("maintenance") {
        // Its revision is a local CAS counter, never portable user configuration.
        maintenance["revision"] = json!(0);
    }
    let mut items = vec![Item {
        kind: "settings".into(),
        id: "preferences".into(),
        data: preferences,
    }];
    let mut add = |kind: &str, list: Vec<Value>, allowed: &[&str]| {
        for value in list {
            if let Some(id) = value["id"].as_str() {
                let mut data = select(&value, allowed);
                if kind == "tool" && data["updatePolicy"]["mode"] == "automatic" {
                    // A portable preference cannot restore this machine's native grant.
                    data["updatePolicy"]["mode"] = json!("manual");
                }
                if kind == "tool" && !data["sourceBinding"].is_null() {
                    data["sourceBinding"] = select(
                        &data["sourceBinding"],
                        &["repository", "repositoryId", "asset"],
                    );
                }
                items.push(Item {
                    kind: kind.into(),
                    id: id.into(),
                    data,
                });
            }
        }
    };
    add(
        "category",
        state.settings["categories"]
            .as_array()
            .cloned()
            .unwrap_or_default(),
        &["id", "name", "color"],
    );
    add("source", state.sources.clone(), SOURCE);
    add("skill", state.skills.clone(), SKILL);
    add("root", state.local_roots.clone(), ROOT);
    let tools = rows(
        db,
        "resource_catalog",
        "SELECT payload FROM resource_catalog ORDER BY rowid",
    )?;
    let templates = rows(
        db,
        "invocation_templates",
        "SELECT payload FROM invocation_templates ORDER BY rowid",
    )?;
    for template in &templates {
        let record = tools
            .iter()
            .find(|tool| tool["id"] == template["resourceId"])
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok());
        portable_template_parameters(record.as_ref(), template)?;
    }
    add("tool", tools, TOOL);
    add("view",rows(db,"saved_views","SELECT json_object('id',id,'name',name,'view',view,'filters',json(filters)) FROM saved_views ORDER BY rowid")?,&["id","name","view","filters"]);
    add(
        "template",
        templates,
        &["id", "name", "resourceId", "actionId", "parameters"],
    );
    add("scene",rows(db,"resource_scenes","SELECT json_object('id',id,'name',name,'members',json(members)) FROM resource_scenes ORDER BY rowid")?,&["id","name","members"]);
    add("relation",rows(db,"resource_relations","SELECT json_object('id',id,'dependent',json_object('kind',dependent_kind,'id',dependent_id),'dependency',json_object('kind',dependency_kind,'id',dependency_id)) FROM resource_relations ORDER BY rowid")?,&["id","dependent","dependency"]);
    for value in rows(db,"skill_annotations","SELECT json_object('id',skill_id,'alias',alias,'notes',notes) FROM skill_annotations ORDER BY rowid")? { items.push(Item{kind:"annotation".into(),id:value["id"].as_str().ok_or("备注身份无效")?.into(),data:select(&value,&["alias","notes"])}); }
    items.push(Item {
        kind: "ignoredPaths".into(),
        id: "local".into(),
        data: json!({"paths":state.ignored_local_paths}),
    });
    let doc = Document {
        format: "agent-resource-manager-config".into(),
        format_version: 1,
        items,
    };
    validate(&doc)?;
    Ok(doc)
}

fn path_field(kind: &str) -> Option<&'static str> {
    match kind {
        "skill" => Some("localPath"),
        "tool" => Some("rootPath"),
        "root" => Some("path"),
        _ => None,
    }
}
fn blocked(item: &Item, current: Option<&Item>, local: &Document) -> Option<String> {
    if let Some(previous) = current {
        let binding = match item.kind.as_str() {
            "skill" => &["localPath", "repo", "branch", "remotePath", "sourceId"][..],
            "tool" => &["rootPath", "kind", "repository", "sourceBinding"][..],
            "source" => &["repo", "branch"][..],
            "root" => &["path"][..],
            _ => &[][..],
        };
        if binding
            .iter()
            .any(|key| previous.data.get(*key) != item.data.get(*key))
        {
            return Some(
                "同一身份的路径或来源不同；保留本机关联，请通过对应资源的关联流程处理".into(),
            );
        }
    } else if let Some(field) = path_field(&item.kind) {
        if let Some(path) = item.data[field].as_str().filter(|p| !p.is_empty()) {
            let key = crate::local_roots::path_key(Path::new(path));
            if local.items.iter().any(|existing| {
                existing.kind == item.kind
                    && existing.data[field]
                        .as_str()
                        .is_some_and(|p| crate::local_roots::path_key(Path::new(p)) == key)
            }) {
                return Some("此路径已登记为另一身份；保留本机记录，未按同名或路径合并".into());
            }
        }
    }
    None
}
fn references(item: &Item) -> Vec<(String, String)> {
    let mut result = Vec::new();
    let d = &item.data;
    let mut add = |kind: &str, id: &Value| {
        if let Some(id) = id.as_str().filter(|id| !id.is_empty()) {
            result.push((kind.to_owned(), id.to_owned()));
        }
    };
    match item.kind.as_str() {
        "skill" => {
            add("category", &d["categoryId"]);
            add("source", &d["sourceId"]);
        }
        "annotation" => add("skill", &json!(item.id)),
        "template" => add("tool", &d["resourceId"]),
        "scene" => {
            for member in d["members"].as_array().into_iter().flatten() {
                add(member["kind"].as_str().unwrap_or_default(), &member["id"]);
            }
        }
        "relation" => {
            for field in ["dependent", "dependency"] {
                add(
                    d[field]["kind"].as_str().unwrap_or_default(),
                    &d[field]["id"],
                );
            }
        }
        "view"
            if d["view"] == "skills"
                && d["filters"]["categoryFilter"]
                    .as_str()
                    .is_some_and(|category| {
                        !["all", "favorite", "uncategorized"].contains(&category)
                    }) =>
        {
            add("category", &d["filters"]["categoryFilter"]);
        }
        _ => {}
    }
    result.sort();
    result.dedup();
    result
}

fn reference_preview(item: &Item, local: &Document, incoming: &Document) -> Vec<Value> {
    references(item)
        .into_iter()
        .map(|(kind, id)| {
            let existing = local.items.iter().find(|i| i.kind == kind && i.id == id);
            let candidate = incoming.items.iter().find(|i| i.kind == kind && i.id == id);
            let status = if existing.is_some() {
                "local"
            } else if candidate.is_some_and(|i| blocked(i, None, local).is_none()) {
                "incoming"
            } else {
                "unresolved"
            };
            json!({"key":format!("{kind}:{id}"),"kind":kind,"id":id,"status":status})
        })
        .collect()
}
fn duplicate_path(item: &Item, incoming: &Document) -> bool {
    let Some(field) = path_field(&item.kind) else {
        return false;
    };
    let Some(path) = item.data[field].as_str().filter(|p| !p.is_empty()) else {
        return false;
    };
    let key = crate::local_roots::path_key(Path::new(path));
    incoming.items.iter().any(|other| {
        other.kind == item.kind
            && other.id != item.id
            && other.data[field]
                .as_str()
                .is_some_and(|p| crate::local_roots::path_key(Path::new(p)) == key)
    })
}
fn source_conflict(item: &Item, local: &Document, incoming: &Document) -> bool {
    if item.kind != "skill" {
        return false;
    }
    let Some(id) = item.data["sourceId"].as_str().filter(|id| !id.is_empty()) else {
        return false;
    };
    // An existing source keeps its binding, even if the file also contains a
    // blocked attempt to rebind that identity. Never attach by display name.
    let source = local
        .items
        .iter()
        .chain(incoming.items.iter())
        .find(|value| value.kind == "source" && value.id == id);
    source.is_some_and(|source| {
        item.data["repo"].as_str().map(str::to_ascii_lowercase)
            != source.data["repo"].as_str().map(str::to_ascii_lowercase)
            || item.data["branch"].as_str().unwrap_or("main")
                != source.data["branch"].as_str().unwrap_or("main")
    })
}
fn relation_conflict(item: &Item, local: &Document, incoming: &Document) -> Option<String> {
    if item.kind != "relation" {
        return None;
    }
    let same_edge = |other: &Item| {
        other.kind == "relation"
            && other.id != item.id
            && other.data["dependent"] == item.data["dependent"]
            && other.data["dependency"] == item.data["dependency"]
    };
    if local.items.iter().any(same_edge) {
        Some("相同依赖关系已使用另一标识登记；保留本机关系，不重复导入".into())
    } else if incoming.items.iter().any(same_edge) {
        Some("配置中相同依赖关系对应多个标识；请保留一项后重新预览".into())
    } else {
        None
    }
}
fn preview(local: &Document, incoming: &Document) -> Vec<Value> {
    let existing: BTreeMap<_, _> = local.items.iter().map(|i| (i.key(), i)).collect();
    incoming.items.iter().map(|item| {
        let old=existing.get(&item.key()).copied(); let mut reason=blocked(item,old,local);
        if reason.is_none() && duplicate_path(item, incoming) {
            reason = Some("配置中同一路径对应多个身份；请保留明确的资源身份后重新导入".into());
        }
        if reason.is_none() && source_conflict(item, local, incoming) {
            reason = Some("Skill 的仓库或分支与所指来源身份不一致；请先核对对应来源，不按同名猜配".into());
        }
        if reason.is_none() {
            reason = relation_conflict(item, local, incoming);
        }
        let associations = reference_preview(item, local, incoming);
        if reason.is_none() && associations.iter().any(|r| r["status"] == "unresolved") {
            reason = Some("关联记录尚未登记，保留为待核对；请先登记对应身份，不按同名或路径猜配".into());
        }
        let status=if reason.is_some(){"blocked"}else if old.is_some_and(|i|i.data==item.data){"same"}else if old.is_some(){"conflict"}else{"new"};
        let path=path_field(&item.kind).and_then(|field|item.data[field].as_str());
        let path_status=path.filter(|p|!p.is_empty()).map(|p| if checked_path(Path::new(p),true).is_ok() && Path::new(p).is_dir(){"available"}else{"unavailable"});
        let effect=match item.kind.as_str(){"skill"|"tool"|"root" if old.is_none()=>"仅登记关联，保持停用；不安装、不授予命令或文件归属", "template"=>"仅保存参数；仍按本机动作重新核对，不自动调用", "scene"=>"保存场景内容，保留本机当前场景选择；不启动程序", _=>"仅替换所选管理信息，文件中缺少的本机项目保持"};
        json!({"key":item.key(),"kind":item.kind,"id":item.id,"name":item.data["name"].as_str().or(item.data["displayName"].as_str()).unwrap_or(&item.id),"status":status,"reason":reason,"path":path,"pathStatus":path_status,"effect":effect,"references":associations,"current":old.map(|i|&i.data),"incoming":item.data})
    }).collect()
}
fn merge_record(list: &mut Vec<Value>, item: &Item) {
    if let Some(old) = list.iter_mut().find(|v| v["id"] == item.id) {
        for (k, v) in item.data.as_object().expect("validated") {
            old[k] = v.clone();
        }
    } else {
        list.push(item.data.clone());
    }
}
fn bump(db: &Connection, table: &str, revision: u64) -> Result<(), String> {
    db.execute(&format!("INSERT INTO {table}(id,revision) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision"),[revision]).map_err(|e|e.to_string())?;
    Ok(())
}

/// Called while the sole live writer is locked. All tables and legacy state
/// commit together; callers publish memory/events only after this returns.
pub(crate) fn apply(
    db: &Connection,
    state: &State,
    document: Document,
    selected: BTreeSet<String>,
    revision: u64,
) -> Result<State, String> {
    validate(&document)?;
    let local = read(db, state)?;
    let choices = preview(&local, &document);
    if selected.is_empty()
        || selected.len() > document.items.len()
        || selected.iter().any(|key| {
            !choices.iter().any(|v| {
                v["key"] == *key && matches!(v["status"].as_str(), Some("new" | "conflict"))
            })
        })
    {
        return Err("请选择预览中可导入的项目；原信息保留".into());
    }
    // A selected child cannot silently lose its source/category/resource when
    // the user skips the corresponding new entry from the same document.
    for item in document
        .items
        .iter()
        .filter(|item| selected.contains(&item.key()))
    {
        for (kind, id) in references(item) {
            let key = format!("{kind}:{id}");
            if !local.items.iter().any(|i| i.key() == key) && !selected.contains(&key) {
                return Err(format!(
                    "{} 需要关联 {key}；请选择该关联项目或先登记对应身份，原信息保留",
                    item.key()
                ));
            }
        }
    }
    let mut next = state.clone();
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    for item in document
        .items
        .iter()
        .filter(|item| selected.contains(&item.key()))
    {
        let d = &item.data;
        match item.kind.as_str() {
            "settings" => {
                for (k, v) in d.as_object().expect("validated") {
                    next.settings[k] = v.clone();
                }
                if d.get("maintenance").is_some() {
                    next.settings["maintenance"]["revision"] = json!(revision);
                }
            }
            "category" => {
                let mut categories = next.settings["categories"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                merge_record(&mut categories, item);
                next.settings["categories"] = json!(categories);
            }
            "source" => merge_record(&mut next.sources, item),
            "skill" => {
                let old = next.skills.iter().find(|v| v["id"] == item.id).cloned();
                merge_record(&mut next.skills, item);
                let skill = next
                    .skills
                    .iter_mut()
                    .find(|v| v["id"] == item.id)
                    .expect("inserted");
                if old.is_none() {
                    skill["enabled"] = json!(false);
                    skill["managed"] = json!(false);
                    skill["runtimeConfirmed"] = json!(false);
                    skill["status"] = json!("unknown_baseline");
                    skill["readOnly"] = json!(skill["localPath"]
                        .as_str()
                        .is_some_and(|p| crate::local::readonly_reason(Path::new(p)).is_some()));
                } else if old
                    .as_ref()
                    .is_some_and(|v| v["runtimeFiles"] != skill["runtimeFiles"])
                {
                    skill["runtimeConfirmed"] = json!(false);
                    if skill["runtimeAudit"].is_object() {
                        skill["runtimeAudit"]["status"] = json!("needs_review");
                        skill["runtimeAudit"]["canAutoConfirm"] = json!(false);
                        skill["runtimeAudit"]["invalidatedAt"] = json!(crate::model::now());
                    }
                }
            }
            "root" => {
                let old = next
                    .local_roots
                    .iter()
                    .find(|v| v["id"] == item.id)
                    .cloned();
                merge_record(&mut next.local_roots, item);
                let root = next
                    .local_roots
                    .iter_mut()
                    .find(|v| v["id"] == item.id)
                    .expect("inserted");
                if old.is_none() {
                    root["enabled"] = json!(false);
                    root["resolvedPath"] = d["path"].clone();
                }
            }
            "ignoredPaths" => {
                for path in array(d, "paths")?.iter().filter_map(Value::as_str) {
                    if !next.ignored_local_paths.iter().any(|v| v == path) {
                        next.ignored_local_paths.push(path.into());
                    }
                }
            }
            "tool" => {
                let saved: Option<String> = tx
                    .query_row(
                        "SELECT payload FROM resource_catalog WHERE id=?1",
                        [&item.id],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                let mut record: ResourceRecord = if let Some(saved) = saved {
                    serde_json::from_str(&saved).map_err(|e| format!("工具记录不可读：{e}"))?
                } else {
                    let source_binding = if d["sourceBinding"].is_null() {
                        None
                    } else {
                        let mut binding = d["sourceBinding"].clone();
                        binding["verifiedAt"] = json!("");
                        Some(serde_json::from_value(binding).map_err(|_| "来源映射格式无效")?)
                    };
                    ResourceRecord {
                        id: item.id.clone(),
                        name: String::new(),
                        kind: d["kind"].as_str().expect("validated").into(),
                        root_path: d["rootPath"].as_str().expect("validated").into(),
                        repository: crate::resources::repository(d)?,
                        version: None,
                        source_binding,
                        source_history: vec![],
                        alias: String::new(),
                        notes: String::new(),
                        enabled: false,
                        ownership: "external".into(),
                        management_scope: "register".into(),
                        actions: vec![],
                        capabilities: vec![],
                        update_policy: json!({}),
                        installation: None,
                        revision: 0,
                        created_at: crate::model::now(),
                        updated_at: crate::model::now(),
                    }
                };
                let before = record.clone();
                record.name = d["name"].as_str().expect("validated").into();
                record.alias = text(d, "alias", 160, false)?.into();
                record.notes = text(d, "notes", 4096, false)?.into();
                record.update_policy = d["updatePolicy"].clone();
                record.revision = revision;
                record.updated_at = crate::model::now();
                crate::resource_capability_evidence::transition(&tx, &before, &record)?;
                tx.execute("INSERT INTO resource_catalog(id,root_key,revision,payload) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload",params![record.id,crate::local_roots::path_key(Path::new(&record.root_path)),revision,serde_json::to_string(&record).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
                bump(&tx, "resource_catalog_meta", revision)?;
            }
            "annotation" => {
                tx.execute("INSERT INTO skill_annotations(skill_id,revision,alias,notes) VALUES(?1,?2,?3,?4) ON CONFLICT(skill_id) DO UPDATE SET revision=excluded.revision,alias=excluded.alias,notes=excluded.notes",params![item.id,revision,text(d,"alias",160,false)?,text(d,"notes",4096,false)?]).map_err(|e|e.to_string())?;
                bump(&tx, "management_data_meta", revision)?;
            }
            "view" => {
                tx.execute("INSERT INTO saved_views(id,revision,name,view,filters) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,name=excluded.name,view=excluded.view,filters=excluded.filters",params![item.id,revision,d["name"].as_str(),d["view"].as_str(),d["filters"].to_string()]).map_err(|e|e.to_string())?;
                bump(&tx, "management_data_meta", revision)?;
            }
            "template" => {
                let mut payload = d.clone();
                payload["revision"] = json!(revision);
                let record: Option<String> = tx
                    .query_row(
                        "SELECT payload FROM resource_catalog WHERE id=?1",
                        [d["resourceId"].as_str().expect("validated")],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                let record =
                    record.and_then(|raw| serde_json::from_str::<ResourceRecord>(&raw).ok());
                portable_template_parameters(record.as_ref(), d)?;
                let binding = record
                    .and_then(|record| {
                        let definition = crate::resource_runtime::registered_definition(
                            &record,
                            d["actionId"].as_str()?,
                        )
                        .ok()?;
                        crate::resource_runtime::validate_template_parameters(
                            &definition,
                            &d["parameters"],
                        )
                        .ok()?;
                        crate::invocation_templates::binding(&record, &definition).ok()
                    })
                    .unwrap_or_default();
                payload["binding"] = json!(binding);
                tx.execute("INSERT INTO invocation_templates(id,resource_id,action_id,revision,payload) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET resource_id=excluded.resource_id,action_id=excluded.action_id,revision=excluded.revision,payload=excluded.payload",params![item.id,d["resourceId"].as_str(),d["actionId"].as_str(),revision,payload.to_string()]).map_err(|e|e.to_string())?;
                bump(&tx, "invocation_templates_meta", revision)?;
            }
            "scene" => {
                tx.execute("INSERT INTO resource_scenes(id,name,members) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET name=excluded.name,members=excluded.members",params![item.id,d["name"].as_str(),d["members"].to_string()]).map_err(|e|e.to_string())?;
                bump(&tx, "resource_scenes_meta", revision)?;
            }
            "relation" => {
                tx.execute("INSERT INTO resource_relations(id,dependent_kind,dependent_id,dependency_kind,dependency_id,created_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET dependent_kind=excluded.dependent_kind,dependent_id=excluded.dependent_id,dependency_kind=excluded.dependency_kind,dependency_id=excluded.dependency_id",params![item.id,d["dependent"]["kind"].as_str(),d["dependent"]["id"].as_str(),d["dependency"]["kind"].as_str(),d["dependency"]["id"].as_str(),crate::model::now()]).map_err(|e|e.to_string())?;
                bump(&tx, "resource_relations_meta", revision)?;
            }
            _ => return Err("未知配置类别".into()),
        }
    }
    next.check_generation = next
        .check_generation
        .checked_add(1)
        .ok_or("检查修订号超出范围")?;
    let mut payload = serde_json::to_value(&next).map_err(|e| e.to_string())?;
    payload["stateRevision"] = json!(revision);
    tx.execute("INSERT INTO app_state(id,schema_version,payload) VALUES(1,1,?1) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",[payload.to_string()]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(next)
}
use rusqlite::OptionalExtension;

fn cache_preview(m: &mut Manager, id: String, value: Value) {
    let mut previous: Vec<_> = m
        .previews
        .iter()
        .filter(|(_, v)| {
            matches!(
                v["kind"].as_str(),
                Some("configurationExport" | "configurationImport")
            )
        })
        .map(|(k, v)| (v["createdAt"].as_i64().unwrap_or(0), k.clone()))
        .collect();
    previous.sort();
    let remove = previous.len().saturating_sub(3);
    for (_, key) in previous.into_iter().take(remove) {
        m.previews.remove(&key);
    }
    m.previews.insert(id, value);
}

#[cfg(test)]
mod tests;

pub(crate) fn apply_local(m: &mut Manager, request: &Value) -> Result<Option<Value>, String> {
    let action = request["action"].as_str().unwrap_or_default();
    if !matches!(
        action,
        "preview_configuration_export"
            | "export_configuration"
            | "preview_configuration_import"
            | "apply_configuration_import"
    ) {
        return Ok(None);
    }
    m.ensure_request_allowed(request)?;
    match action {
        "preview_configuration_export" => {
            fields(request, &["action"])?;
            let snapshot = m.configuration_store(StoreRequest::Read)?;
            let id = uuid::Uuid::new_v4().to_string();
            cache_preview(
                m,
                id.clone(),
                json!({"kind":"configurationExport","createdAt":chrono::Utc::now().timestamp_millis(),"snapshot":snapshot}),
            );
            Ok(Some(
                json!({"previewId":id,"revision":snapshot["revision"],"document":snapshot["document"]}),
            ))
        }
        "preview_configuration_import" => {
            fields(request, &["action", "path"])?;
            let path = text(request, "path", 32767, true)?;
            let (document, digest) = read_file(Path::new(path))?;
            let snapshot = m.configuration_store(StoreRequest::Read)?;
            let local: Document =
                serde_json::from_value(snapshot["document"].clone()).map_err(|e| e.to_string())?;
            let items = preview(&local, &document);
            let id = uuid::Uuid::new_v4().to_string();
            cache_preview(
                m,
                id.clone(),
                json!({"kind":"configurationImport","createdAt":chrono::Utc::now().timestamp_millis(),"path":path,"digest":digest,"revision":snapshot["revision"],"document":document}),
            );
            Ok(Some(
                json!({"previewId":id,"revision":snapshot["revision"],"items":items,"path":path}),
            ))
        }
        _ => {
            fields(
                request,
                if action == "export_configuration" {
                    &["action", "previewId", "path"]
                } else {
                    &["action", "previewId", "selected"]
                },
            )?;
            let id = text(request, "previewId", 64, true)?.to_owned();
            let stored = m
                .previews
                .get(&id)
                .cloned()
                .ok_or("配置预览已失效，请重新生成")?;
            let expected_kind = if action == "export_configuration" {
                "configurationExport"
            } else {
                "configurationImport"
            };
            if stored["kind"] != expected_kind
                || stored["createdAt"]
                    .as_i64()
                    .is_none_or(|created| chrono::Utc::now().timestamp_millis() - created > 600000)
            {
                return Err("配置预览已失效，请重新生成".into());
            }
            if action == "export_configuration" {
                let current = m.configuration_store(StoreRequest::Read)?;
                if current["revision"] != stored["snapshot"]["revision"] {
                    return Err("管理信息已变化，请重新预览导出".into());
                }
                let path = Path::new(text(request, "path", 32767, true)?);
                checked_path(path, false)?;
                let bytes = serde_json::to_vec_pretty(&stored["snapshot"]["document"])
                    .map_err(|e| e.to_string())?;
                if bytes.len() > MAX_BYTES {
                    return Err("配置超过8MiB，未写入".into());
                }
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(path)
                    .map_err(|e| format!("无法创建配置文件，不覆盖已有文件：{e}"))?;
                file.write_all(&bytes)
                    .and_then(|_| file.sync_all())
                    .map_err(|e| format!("配置导出未完成，目标文件可能不完整：{e}"))?;
                m.previews.remove(&id);
                Ok(Some(
                    json!({"path":path.to_string_lossy(),"bytes":bytes.len()}),
                ))
            } else {
                let (document, digest) =
                    read_file(Path::new(stored["path"].as_str().ok_or("导入路径无效")?))?;
                if digest != stored["digest"].as_str().unwrap_or_default() {
                    return Err("配置文件在预览后变化，请重新选择并预览".into());
                }
                let selected: BTreeSet<String> =
                    serde_json::from_value(request["selected"].clone())
                        .map_err(|_| "请明确选择导入项目")?;
                let result = m.configuration_store(StoreRequest::Apply {
                    document,
                    expected_revision: stored["revision"].as_u64().ok_or("配置修订号无效")?,
                    selected,
                })?;
                m.previews.remove(&id);
                Ok(Some(result))
            }
        }
    }
}
