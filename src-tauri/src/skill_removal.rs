//! Human-confirmed Skill removal. Discovery/baseline hashes never grant ownership.
use crate::{
    model::{now, Manager},
    resource_files::{self, OwnedFile, RemovalExtent, RemovalPlan, RemovalResult},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Disconnect {
    id: String,
    entries: Value,
    preview_id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Prepared {
    skill: Value,
    root_identity: Option<String>,
    connections: Vec<Value>,
    relations_revision: u64,
    shared_roots: Value,
    plan: RemovalPlan,
    disconnects: Vec<Disconnect>,
    blocked_links: Vec<Value>,
    created_at: i64,
}

fn text<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value[field]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.len() <= 512 && !s.contains('\0'))
        .ok_or_else(|| format!("缺少或无效的参数：{field}"))
}

fn checked_fields(request: &Value, allowed: &[&str]) -> Result<(), String> {
    if request
        .as_object()
        .is_none_or(|o| o.keys().any(|k| !allowed.contains(&k.as_str())))
    {
        return Err("仅接受本次已存预览；不能用确认标志或请求文件清单代替人工确认".into());
    }
    Ok(())
}

fn extent(value: &Value) -> Result<RemovalExtent, String> {
    if value == "full" {
        return Ok(RemovalExtent::Complete);
    }
    serde_json::from_value(value.clone()).map_err(|_| "每次处理须重新选择明确的卸载程度".into())
}

fn readable(path: &Path) -> String {
    let value = path.to_string_lossy();
    if cfg!(windows) {
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return rest.to_owned();
        }
    }
    value.into_owned()
}

fn key(path: &Path) -> String {
    let path = readable(path).replace('\\', "/");
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path
    }
}

fn overlaps(a: &Path, b: &Path) -> bool {
    let a = key(a);
    let b = key(b);
    a == b
        || a.starts_with(&format!("{}/", b.trim_end_matches('/')))
        || b.starts_with(&format!("{}/", a.trim_end_matches('/')))
}

fn connections(m: &Manager, id: &str) -> Vec<Value> {
    let mut rows: Vec<_> = m
        .state
        .connections
        .iter()
        .filter(|r| r["skillId"] == id)
        .cloned()
        .collect();
    rows.sort_by_key(|r| r["id"].as_str().unwrap_or_default().to_owned());
    rows
}

fn relations(m: &Manager, id: &str) -> Result<Value, String> {
    m.relation_store(crate::resource_relations::StoreRequest::List {
        endpoint: crate::resource_relations::Endpoint {
            kind: "skill".into(),
            id: id.into(),
        },
    })
}

fn shared_roots(m: &Manager, id: &str) -> Result<Value, String> {
    let mut rows = vec![];
    for skill in &m.state.skills {
        if skill["id"] != id && skill["localPath"].is_string() {
            rows.push(json!({"kind":"skill","id":skill["id"],"path":skill["localPath"]}));
        }
    }
    let tools = m.resource_store(crate::resources::StoreRequest::List)?;
    for tool in tools["resources"]
        .as_array()
        .ok_or("工具目录不可读，不能核实共享范围")?
    {
        rows.push(json!({"kind":"tool","id":tool["id"],"path":tool["rootPath"]}));
    }
    rows.push(json!({"kind":"manager","id":"data","path":m.data_dir}));
    rows.sort_by_key(|r| r.to_string());
    Ok(json!(rows))
}

fn shared(root: &Path, rows: &Value) -> bool {
    rows.as_array().is_none_or(|rows| {
        rows.iter().any(|row| {
            row["path"].as_str().is_some_and(|value| {
                let declared = Path::new(value);
                let resolved =
                    crate::local::canonical(declared).unwrap_or_else(|_| declared.to_owned());
                overlaps(root, &resolved)
            })
        })
    })
}

fn receipt(skill: &Value, root: &Path) -> Result<Vec<OwnedFile>, String> {
    let stored = &skill["installation"];
    if stored.is_null() {
        return Ok(vec![]);
    }
    if stored["schemaVersion"] != 1 || stored["origin"] != "managerInstall" {
        return Err("安装记录没有可信的管理器文件归属，仅扫描或比较基准不能代替归属".into());
    }
    let recorded = crate::local::canonical(Path::new(text(stored, "rootPath")?))?;
    if key(&recorded) != key(root) {
        return Err("安装归属与当前目录不一致，不能卸载文件".into());
    }
    let files: Vec<OwnedFile> =
        serde_json::from_value(stored["files"].clone()).map_err(|_| "安装文件归属格式无效")?;
    if files.len() > 20_000 {
        return Err("安装文件归属数量超出可核对范围".into());
    }
    Ok(files)
}

fn verify_files(plan: &RemovalPlan) -> Result<(), String> {
    if plan.entries.is_empty() {
        return Ok(());
    }
    crate::transaction::verify_root(&plan.root)?;
    for entry in &plan.entries {
        let path = crate::local::safe_join(&plan.root, &entry.relative)?;
        if path != entry.path {
            return Err("文件真实路径已变化，请重新预览".into());
        }
        let current = match fs::symlink_metadata(&path) {
            Ok(_) => Some(resource_files::fingerprint(&path)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.to_string()),
        };
        if current != entry.expected {
            return Err(format!(
                "文件自预览后变化，未处理任何入口或文件：{}",
                path.display()
            ));
        }
    }
    Ok(())
}

fn disconnect_preview(m: &mut Manager, id: &str) -> Result<Value, String> {
    crate::clients::handle(
        m,
        &json!({"action":"preview_disconnect","connectionId":id,"mode":"disconnect"}),
    )?
    .ok_or_else(|| "无法核对客户端链接".into())
}

fn preview(m: &mut Manager, request: &Value) -> Result<Value, String> {
    checked_fields(request, &["action", "skillId", "extent", "customFiles"])?;
    m.ensure_request_allowed(request)?;
    let id = text(request, "skillId")?.to_owned();
    let skill = m.skill(&id)?;
    if skill["readOnly"] == true {
        return Err("此 Skill 由应用或插件托管，请通过所属应用管理".into());
    }
    let extent = extent(&request["extent"])?;
    let path = text(&skill, "localPath")?;
    crate::transaction::verify_root(Path::new(path))?;
    let root = crate::local::canonical(Path::new(path))?;
    let root_identity = Some(crate::clients::file_identity(&root)?);
    let mut warnings = vec!["仅处理本次已核实归属的普通文件及客户端目录链接；来源关联、未知文件、共享内容和目录本身保留。".to_owned()];
    let owned = match receipt(&skill, &root) {
        Ok(files) => files,
        Err(error) => {
            warnings.push(error);
            vec![]
        }
    };
    let custom: Vec<String> = if extent == RemovalExtent::Custom {
        serde_json::from_value(request["customFiles"].clone())
            .map_err(|_| "自定义范围必须是文件列表")?
    } else {
        vec![]
    };
    if custom.len() > 20_000 {
        return Err("自定义范围过长".into());
    }
    if custom.iter().collect::<BTreeSet<_>>().len() != custom.len() {
        return Err("自定义范围包含重复文件".into());
    }
    let plan = if extent == RemovalExtent::Disable || owned.is_empty() {
        RemovalPlan {
            id: m.id(),
            root,
            extent: extent.clone(),
            entries: vec![],
        }
    } else {
        resource_files::preview_removal(&root, &owned, extent.clone(), &custom)?
    };
    let relation = relations(m, &id)?;
    let relations_revision = relation["revision"].as_u64().ok_or("依赖关系修订不可用")?;
    let dependents = relation["dependents"].as_array().ok_or("依赖影响不可读")?;
    let shared_roots = shared_roots(m, &id)?;
    let has_shared = shared(&plan.root, &shared_roots);
    let removes_files = plan.entries.iter().any(|entry| entry.remove);
    let current_connections = connections(m, &id);
    let mut disconnects = vec![];
    let mut blocked_links = vec![];
    let mut link_entries = vec![];
    for record in &current_connections {
        let result = record["id"]
            .as_str()
            .ok_or_else(|| "连接记录缺少稳定标识".to_owned())
            .and_then(|connection_id| disconnect_preview(m, connection_id));
        match result {
            Ok(value) => {
                let preview_id = text(&value, "id")?.to_owned();
                if let Some(child) = m
                    .previews
                    .get_mut(&preview_id)
                    .filter(|preview| preview["kind"] == "disconnect")
                {
                    child["skillRemovalPreviewId"] = json!(plan.id);
                }
                let entries = value["entries"].clone();
                for entry in entries.as_array().ok_or("链接清单格式无效")? {
                    link_entries.push(json!({"path":entry["path"],"target":entry["target"],"connectionId":entry["connectionId"],"remove":true,"reason":"仅解除已核实的目录链接，原文件不随链接删除"}));
                }
                disconnects.push(Disconnect {
                    id: text(record, "id")?.to_owned(),
                    entries,
                    preview_id,
                });
            }
            Err(error) => {
                let entry = json!({"path":record["path"],"target":record["target"],"connectionId":record["id"],"remove":false,"reason":error});
                link_entries.push(entry.clone());
                blocked_links.push(entry);
            }
        }
    }
    if owned.is_empty() {
        warnings.push(
            "没有可信安装归属清单；只能解除已核实链接，不会从本地扫描或比较哈希补造文件所有权。"
                .into(),
        );
    }
    if has_shared {
        warnings.push(
            "所选目录与其他资源或管理数据范围重叠；本次文件删除已阻止，请先核对共享关系。".into(),
        );
    }
    if !dependents.is_empty() {
        warnings.push("此 Skill 仍被其他资源依赖；删除文件被阻止，依赖记录保持。".into());
    }
    if !blocked_links.is_empty() {
        warnings.push(
            "部分入口无法安全解除；运行文件删除被阻止，不会强行删除直接目录或未知入口。".into(),
        );
    }
    let can_apply = if extent == RemovalExtent::Disable {
        !disconnects.is_empty()
    } else {
        !owned.is_empty()
            && (!removes_files
                || (!has_shared && dependents.is_empty() && blocked_links.is_empty()))
    };
    if extent == RemovalExtent::Disable && current_connections.is_empty() {
        warnings.push("没有已登记的客户端入口，本次无需处理；客户端原生发现或当前对话已读取的内容不受此入口控制。".into());
    }
    let public = json!({"id":plan.id,"kind":"skillRemove","skillId":id,"extent":extent,"targetPath":readable(&plan.root),
        "entries":plan.entries,"linkEntries":link_entries,"canApply":can_apply,"warnings":warnings,"dependents":dependents,"relationsRevision":relations_revision});
    let prepared = Prepared {
        skill,
        root_identity,
        connections: current_connections,
        relations_revision,
        shared_roots,
        plan,
        disconnects,
        blocked_links,
        created_at: chrono::Utc::now().timestamp(),
    };
    m.previews.insert(text(&public, "id")?.to_owned(), json!({"kind":"skillRemove","skillId":id,"targetPath":public["targetPath"],"public":public,"prepared":prepared,"createdAt":chrono::Utc::now().timestamp_millis()}));
    crate::resource_lifecycle::trim_previews(&mut m.previews);
    Ok(public)
}

pub(crate) fn handle(m: &mut Manager, request: &Value) -> Result<Option<Value>, String> {
    if request["action"] != "preview_skill_remove" {
        return Ok(None);
    }
    preview(m, request).map(Some)
}

fn preflight(m: &mut Manager, prepared: &Prepared) -> Result<(), String> {
    let id = text(&prepared.skill, "id")?;
    if m.skill(id)? != prepared.skill || connections(m, id) != prepared.connections {
        return Err("Skill 或客户端记录已变化，请重新选择程度并预览".into());
    }
    crate::transaction::verify_root(&prepared.plan.root)?;
    if Some(crate::clients::file_identity(&prepared.plan.root)?) != prepared.root_identity {
        return Err("Skill 原目录对象已替换，请重新预览；现有内容未处理".into());
    }
    let relation = relations(m, id)?;
    if relation["revision"].as_u64() != Some(prepared.relations_revision)
        || shared_roots(m, id)? != prepared.shared_roots
    {
        return Err("依赖或共享范围已变化，请重新核对卸载影响".into());
    }
    if prepared.plan.entries.iter().any(|e| e.remove)
        && (shared(&prepared.plan.root, &prepared.shared_roots)
            || relation["dependents"]
                .as_array()
                .is_none_or(|rows| !rows.is_empty())
            || !prepared.blocked_links.is_empty())
    {
        return Err("文件仍有共享使用或不可解除入口，未处理".into());
    }
    verify_files(&prepared.plan)?;
    for disconnect in &prepared.disconnects {
        let fresh = disconnect_preview(m, &disconnect.id)?;
        m.previews.remove(text(&fresh, "id")?);
        if fresh["entries"] != disconnect.entries {
            return Err("客户端链接对象已变化，请重新预览；原文件未处理".into());
        }
        let stored = m
            .previews
            .get(&disconnect.preview_id)
            .ok_or("客户端解除预览已失效，请重新预览")?;
        if stored["entries"] != disconnect.entries {
            return Err("已存客户端预览发生变化".into());
        }
    }
    Ok(())
}

pub(crate) fn apply_local(m: &mut Manager, request: &Value) -> Result<Option<Value>, String> {
    if request["action"] != "apply_skill_remove" {
        return Ok(None);
    }
    checked_fields(request, &["action", "previewId"])?;
    m.ensure_request_allowed(request)?;
    let id = text(request, "previewId")?;
    let stored = m
        .previews
        .remove(id)
        .ok_or("卸载预览已消费或失效，请重新选择程度")?;
    let result = apply_stored(m, &stored);
    crate::resource_lifecycle::trim_previews(&mut m.previews);
    result
}

fn apply_stored(m: &mut Manager, stored: &Value) -> Result<Option<Value>, String> {
    if stored["kind"] != "skillRemove" || stored["public"]["canApply"] != true {
        return Err("此预览没有可安全处理的范围".into());
    }
    let prepared: Prepared =
        serde_json::from_value(stored["prepared"].clone()).map_err(|_| "已存卸载预览格式无效")?;
    let elapsed = chrono::Utc::now().timestamp() - prepared.created_at;
    if !(0..=600).contains(&elapsed) {
        return Err("卸载预览已过期，请重新选择程度并核对".into());
    }
    preflight(m, &prepared)?;
    let skill_id = text(&prepared.skill, "id")?.to_owned();
    let before = m.state.clone();
    let pending = json!({"planId":prepared.plan.id,"extent":prepared.plan.extent,"startedAt":now(),"status":"processing","entries":prepared.plan.entries,"linkEntries":stored["public"]["linkEntries"]});
    m.state
        .skills
        .iter_mut()
        .find(|s| s["id"] == skill_id)
        .ok_or("Skill 已消失")?["lastRemoval"] = pending;
    if let Err(error) = m.save() {
        m.state = before;
        return Err(format!("不能保存本次处理记录，文件和入口未修改：{error}"));
    }
    let mut connection_results = vec![];
    let mut failures: Vec<(PathBuf, String)> = vec![];
    for entry in &prepared.blocked_links {
        failures.push((
            PathBuf::from(entry["path"].as_str().unwrap_or_default()),
            entry["reason"]
                .as_str()
                .unwrap_or("入口无法安全解除")
                .into(),
        ));
    }
    for disconnect in &prepared.disconnects {
        let result = crate::clients::handle(
            m,
            &json!({"action":"apply_disconnect","previewId":disconnect.preview_id}),
        );
        let error = result.err();
        if let Some(error) = &error {
            let path = disconnect.entries[0]["path"].as_str().unwrap_or_default();
            failures.push((PathBuf::from(path), error.clone()));
        }
        connection_results
            .push(json!({"id":disconnect.id,"success":error.is_none(),"error":error}));
    }
    let mut result = RemovalResult {
        plan_id: prepared.plan.id.clone(),
        deleted: vec![],
        retained: vec![],
        failures: vec![],
    };
    if prepared.plan.extent != RemovalExtent::Disable {
        if failures.is_empty() {
            match resource_files::apply_removal(&prepared.plan) {
                Ok(receipt) => result = receipt,
                Err(error) => {
                    result.retained = prepared
                        .plan
                        .entries
                        .iter()
                        .map(|e| e.path.clone())
                        .collect();
                    result.failures.push((prepared.plan.root.clone(), error));
                }
            }
        } else {
            result.retained = prepared
                .plan
                .entries
                .iter()
                .map(|e| e.path.clone())
                .collect();
        }
    }
    result.failures.extend(failures);
    let preserved_runtime = prepared.plan.extent != RemovalExtent::Custom
        && prepared
            .plan
            .entries
            .iter()
            .any(|entry| !entry.remove && entry.reason.contains("本地改造"));
    let complete = result.failures.is_empty() && !preserved_runtime;
    let updated = m
        .state
        .skills
        .iter_mut()
        .find(|s| s["id"] == skill_id)
        .ok_or("Skill 已消失，处理结果需核对")?;
    if let Some(files) = updated
        .get_mut("installation")
        .and_then(|record| record.get_mut("files"))
        .and_then(Value::as_array_mut)
    {
        files.retain(|file| {
            !prepared.plan.entries.iter().any(|entry| {
                file["path"].as_str() == Some(entry.relative.as_str())
                    && result.deleted.contains(&entry.path)
            })
        });
    }
    if updated["installation"].is_object() {
        updated["installation"]["status"] = json!(if complete {
            "selectedScopeRemoved"
        } else {
            "partiallyRemoved"
        });
    }
    if !result.deleted.is_empty() {
        updated["runtimeAudit"] = json!({"status":"needs_review","reason":"所选文件已卸载；保留目录和来源，不把剩余文件认定为完整可运行版本","checkedAt":now()});
        updated["status"] = json!(if updated["repo"].is_string() {
            "remote_check_required"
        } else {
            "local_only"
        });
        updated["localHashes"] = Value::Null;
    }
    let finished = json!({"planId":prepared.plan.id,"extent":prepared.plan.extent,"finishedAt":now(),"status":if complete {"completed"} else {"partial"},"result":result,"connectionResults":connection_results,"rootPath":readable(&prepared.plan.root),"sourceRetained":true});
    updated["lastRemoval"] = finished;
    let save_error = m.save().err();
    let warnings: Vec<String> = save_error
        .iter()
        .map(|error| {
            format!(
                "外部操作结果已返回，但最终记录保存失败；先核对本次结果，不可重放旧确认：{error}"
            )
        })
        .collect();
    Ok(Some(
        json!({"complete":complete && save_error.is_none(),"state":m.snapshot(),"result":result,"connectionResults":connection_results,"warnings":warnings,"sourceRetained":true,"fullyRemoved":false}),
    ))
}

#[cfg(test)]
#[path = "skill_removal/tests.rs"]
mod tests;
