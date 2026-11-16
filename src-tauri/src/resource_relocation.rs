//! Native-window-only repair of existing catalog paths. Never moves files,
//! adopts an executable, starts a process, or creates update permissions.
use crate::{
    model::{now, Manager},
    resources::{ResourceRecord, StoreRequest},
};
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path};

const KIND: &str = "resourceRelocation";
const TTL: i64 = 600_000;

fn allowed(request: &Value, fields: &[&str]) -> Result<(), String> {
    if request
        .as_object()
        .is_none_or(|o| o.keys().any(|k| !fields.contains(&k.as_str())))
    {
        return Err("目录修复请求包含未批准字段".into());
    }
    Ok(())
}
fn identifier<'a>(request: &'a Value, field: &str) -> Result<&'a str, String> {
    request[field]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 64 && !s.chars().any(char::is_control))
        .ok_or_else(|| format!("缺少有效的 {field}"))
}
fn normal(m: &Manager) -> Result<(), String> {
    if m.basic_mode || m.snapshot()["startup"]["basicMode"] == true {
        return Err("基本模式不修改工具目录".into());
    }
    Ok(())
}
fn read(m: &Manager, id: &str) -> Result<ResourceRecord, String> {
    serde_json::from_value(m.resource_store(StoreRequest::Get(id.into()))?)
        .map_err(|e| e.to_string())
}
fn key(path: &str) -> String {
    let path = if cfg!(windows) {
        path.replace('/', "\\").to_lowercase()
    } else {
        path.into()
    };
    let path = if let Some(unc) = path.strip_prefix(r"\\?\unc\") {
        format!(r"\\{unc}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(&path).to_owned()
    };
    path.trim_end_matches(['/', '\\']).into()
}
fn overlaps(left: &str, right: &str) -> bool {
    let (left, right) = (key(left), key(right));
    left == right
        || left.starts_with(&format!("{right}{}", std::path::MAIN_SEPARATOR))
        || right.starts_with(&format!("{left}{}", std::path::MAIN_SEPARATOR))
}
fn available(m: &Manager, original: &ResourceRecord, root: &str) -> Result<(), String> {
    if key(root) == key(&original.root_path) {
        return Err("新目录与原登记相同，无需重新定位".into());
    }
    let listed = m.resource_store(StoreRequest::List)?;
    for value in listed["resources"].as_array().ok_or("工具目录无法读取")? {
        let record: ResourceRecord =
            serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
        if record.id != original.id && overlaps(root, &record.root_path) {
            return Err("新目录与其他已登记资源冲突，请核对原登记".into());
        }
    }
    ensure_stopped(m, &original.id)
}
pub(crate) fn ensure_stopped(m: &Manager, id: &str) -> Result<(), String> {
    if m.resource_runtime.snapshot(Some(id))?["runs"]
        .as_array()
        .is_some_and(|runs| runs.iter().any(|run| run["status"] == "running"))
    {
        return Err("此资源仍在运行，请先停止受管进程再修复目录".into());
    }
    Ok(())
}

/// Bound the family after worker previews are merged as well as at creation.
pub(crate) fn trim_previews(previews: &mut HashMap<String, Value>, keep: Option<&str>) {
    let now = chrono::Utc::now().timestamp_millis();
    previews.retain(|_, p| {
        p["kind"] != KIND
            || p["createdAt"]
                .as_i64()
                .is_some_and(|at| (0..TTL).contains(&(now - at)))
    });
    let mut family: Vec<_> = previews
        .iter()
        .filter(|(_, p)| p["kind"] == KIND)
        .map(|(id, p)| (id.clone(), p["createdAt"].as_i64().unwrap_or(0)))
        .collect();
    family.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.cmp(&a.0)));
    if let Some(keep) = keep {
        family.sort_by_key(|(id, _)| id != keep);
    }
    for (id, _) in family.into_iter().skip(32) {
        previews.remove(&id);
    }
}

pub(crate) fn preview_local(m: &mut Manager, request: &Value) -> Result<Option<Value>, String> {
    if request["action"] != "preview_resource_relocate" {
        return Ok(None);
    }
    normal(m)?;
    allowed(request, &["action", "id", "expectedRevision", "rootPath"])?;
    let id = identifier(request, "id")?;
    let original = read(m, id)?;
    let expected = request["expectedRevision"]
        .as_u64()
        .filter(|n| *n > 0)
        .ok_or("需要当前资源修订号")?;
    if original.revision != expected {
        return Err("资源已变化，请重新读取后预览".into());
    }
    ensure_stopped(m, id)?;
    let root = request["rootPath"]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.len() <= 32767 && !s.chars().any(char::is_control))
        .ok_or("请选择现有工具的绝对目录")?;
    let inspection = crate::resource_adapters::inspect_relocation(&original, Path::new(root))?;
    available(m, &original, &inspection.root_path)?;
    if json!(read(m, id)?) != json!(original) {
        return Err("检查期间原资源已变化，请重新预览".into());
    }
    let preview_id = uuid::Uuid::new_v4().to_string();
    let actions: Vec<_> = original.actions.iter().zip(&inspection.actions).map(|(old,new)| {
        let mut action = json!({"id":old["id"],"label":old["label"],"oldExecutable":old["executable"],"newExecutable":new["executable"],
            "oldWorkingDirectory":old["workingDirectory"],"newWorkingDirectory":new["workingDirectory"]});
        let argument_paths: Vec<_> = old["args"].as_array().into_iter().flatten().zip(new["args"].as_array().into_iter().flatten()).enumerate()
            .filter(|(_, (old,new))| old["type"] == "literal" && new["type"] == "literal" && old["value"] != new["value"])
            .map(|(index,(old,new))| json!({"index":index,"oldPath":old["value"],"newPath":new["value"]})).collect();
        if !argument_paths.is_empty() { action["argumentPaths"] = json!(argument_paths); }
        action
    }).collect();
    let mut warnings = inspection.warnings.clone();
    warnings.extend([
        "仅保存资源目录和原动作路径；不会移动文件或执行工具。".into(),
        "原策略及授权历史保留；旧目录的调用证据、模板和自动更新许可不能认证新目录。".into(),
    ]);
    if inspection.runtime_change.is_some() {
        warnings.push("共享 Node 的同一路径文件指纹已变化；确认将同时重新核对该指纹，不更换路径或扩大原固定动作权限。".into());
    }
    let mut public = json!({"previewId":preview_id,"kind":KIND,"resourceId":original.id,"resourceRevision":original.revision,
        "oldRootPath":original.root_path,"newRootPath":inspection.root_path,"adapter":inspection.adapter,"version":inspection.version,
        "license":inspection.license,"actions":actions,"preserved":inspection.preserved,"warnings":warnings,
        "canApply":true,"filesChanged":false,"executed":false,"actionsAdded":0});
    if let Some(change) = &inspection.runtime_change {
        public["runtimeChange"] = change.clone();
    }
    m.previews.insert(preview_id.clone(),json!({"kind":KIND,"resourceId":original.id,"createdAt":chrono::Utc::now().timestamp_millis(),
        "targetPath":inspection.root_path,"public":public,"original":original,"inspection":inspection}));
    trim_previews(&mut m.previews, Some(&preview_id));
    Ok(Some(public))
}

pub(crate) fn apply_local(m: &mut Manager, request: &Value) -> Result<Option<Value>, String> {
    if request["action"] != "apply_resource_relocate" {
        return Ok(None);
    }
    normal(m)?;
    allowed(request, &["action", "previewId"])?;
    let preview_id = identifier(request, "previewId")?;
    let saved = m
        .previews
        .get(preview_id)
        .ok_or("目录修复预览已消费或过期，请重新预览")?;
    if saved["kind"] != KIND || saved["public"]["canApply"] != true {
        return Err("目录修复预览类型不匹配".into());
    }
    let saved = m.previews.remove(preview_id).ok_or("目录修复预览已过期")?;
    if saved["createdAt"]
        .as_i64()
        .is_none_or(|at| !(0..TTL).contains(&(chrono::Utc::now().timestamp_millis() - at)))
    {
        return Err("目录修复预览已过期，请重新预览".into());
    }
    let original: ResourceRecord =
        serde_json::from_value(saved["original"].clone()).map_err(|e| e.to_string())?;
    if json!(read(m, &original.id)?) != json!(original) {
        return Err("预览后原资源或策略已变化，请重新预览".into());
    }
    let root = saved["targetPath"].as_str().ok_or("预览缺少新目录")?;
    let inspection = crate::resource_adapters::inspect_relocation(&original, Path::new(root))?;
    if json!(inspection) != saved["inspection"] {
        return Err("预览后新目录身份、关键文件或元数据已变化，请重新预览".into());
    }
    available(m, &original, &inspection.root_path)?;
    let mut next = original.clone();
    next.root_path = inspection.root_path;
    next.actions = inspection.actions;
    next.revision = next.revision.checked_add(1).ok_or("资源修订号超出范围")?;
    next.updated_at = now();
    for capability in &mut next.capabilities {
        if capability["id"] == "versionMetadata"
            && capability["method"] == "staticMetadata"
            && capability["entry"]
                .as_str()
                .is_some_and(|p| key(p) == key(&original.root_path))
        {
            capability["entry"] = json!(next.root_path);
            capability["version"] = json!(inspection.version);
            capability["verifiedAt"] = json!(next.updated_at);
            capability["reason"] = json!("新目录静态元数据已核对；未执行工具，不代表调用成功");
        }
    }
    let result = m.resource_store(StoreRequest::Relocate {
        original: Box::new(original),
        record: Box::new(next),
    })?;
    let resource: ResourceRecord =
        serde_json::from_value(result["resource"].clone()).map_err(|e| e.to_string())?;
    Ok(Some(
        json!({"resource":crate::resource_lifecycle::public_record(&resource),"complete":true,"filesChanged":false,"executed":false,"actionsAdded":0}),
    ))
}

#[cfg(test)]
mod tests;
