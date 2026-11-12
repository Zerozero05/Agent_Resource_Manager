//! Changing the comparison source never rewrites installation provenance.
use super::*;

fn allowed(req: &Value, fields: &[&str]) -> Result<(), String> {
    if req
        .as_object()
        .is_none_or(|object| object.keys().any(|key| !fields.contains(&key.as_str())))
    {
        return Err("来源请求包含不支持的字段；确认时只提交本次 previewId".into());
    }
    Ok(())
}

/// Older records already carry real installation evidence in these fields.
/// A comparison baseline alone must never be promoted to an installation.
pub(super) fn installation(skill: &Value) -> Result<Option<Value>, String> {
    if let Some(receipt) = skill.get("installedProvenance").filter(|v| !v.is_null()) {
        text(receipt, "repo")?;
        remote_path(receipt)?;
        github::sha(&receipt["commit"])?;
        return Ok(Some(receipt.clone()));
    }
    let Some(commit) = skill["installedCommit"].as_str() else {
        return Ok(None);
    };
    github::sha(&json!(commit))?;
    Ok(Some(
        json!({"sourceId":skill["sourceId"],"repo":repo(skill)?,
        "branch":skill["branch"],"remotePath":remote_path(skill)?,"commit":commit,
        "documentationPath":skill["documentationPath"],"runtimeFiles":skill["runtimeFiles"],
        "runtimeSources":skill["runtimeSources"],"baselineHashes":skill["baselineHashes"],
        "baselineCommit":skill["baselineCommit"],"baselineKind":skill["baselineKind"],
        "baselineDocHash":skill["baselineDocHash"],"installedAt":skill["baselineVerifiedAt"]}),
    ))
}

pub(super) fn record_installation(skill: &mut Value) -> Result<(), String> {
    // This is called only after a successful install/update, for the actual source.
    skill["installedProvenance"] = Value::Null;
    skill["installedProvenance"] = installation(skill)?.unwrap_or(Value::Null);
    Ok(())
}

pub(super) fn reading_skill(skill: &Value, req: &Value) -> Result<Value, String> {
    if req["version"] != "installed" {
        return Ok(skill.clone());
    }
    let receipt = installation(skill)?.ok_or(
        "Installed version is unknown; a comparison baseline is not an installation record",
    )?;
    if req
        .get("remoteCommit")
        .filter(|v| !v.is_null())
        .is_some_and(|commit| *commit != receipt["commit"])
    {
        return Err("安装版本提交已变化，请重新读取安装说明".into());
    }
    let mut result = skill.clone();
    for field in [
        "sourceId",
        "repo",
        "branch",
        "remotePath",
        "documentationPath",
        "runtimeSources",
    ] {
        result[field] = receipt[field].clone();
    }
    result["installedCommit"] = receipt["commit"].clone();
    result["commit"] = receipt["commit"].clone();
    Ok(result)
}

fn source_mapping(source: &Value) -> Value {
    json!({"id":source["id"],"repo":source["repo"],"branch":source["branch"],
        "roots":source["roots"],"ignoredPaths":source["ignoredPaths"]})
}

fn binding(skill: &Value) -> Value {
    json!({"sourceId":skill["sourceId"],"repo":skill["repo"],"branch":skill["branch"],
        "remotePath":skill["remotePath"],"commit":skill["commit"]})
}

fn placeholders(state: &crate::model::State, skill: &Value, target: &Value) -> Vec<Value> {
    state
        .skills
        .iter()
        .filter(|other| {
            other["id"] != skill["id"]
                && other["sourceId"] == target["sourceId"]
                && other["remotePath"] == target["remotePath"]
                && other["localPath"].is_null()
        })
        .cloned()
        .collect()
}

/// Called again by the live writer while it holds the Manager mutex.
pub(crate) fn guard(state: &crate::model::State, preview: &Value) -> Result<(), String> {
    let skill = state
        .skills
        .iter()
        .find(|s| s["id"] == preview["public"]["skillId"])
        .ok_or("Skill no longer exists; preview again")?;
    if skill_stamp(skill) != preview["skillStamp"] || *skill != preview["expectedSkill"] {
        return Err("Skill configuration changed after preview; preview again".into());
    }
    let target = &preview["public"]["targetSource"];
    let source = state
        .sources
        .iter()
        .find(|s| s["id"] == target["sourceId"])
        .ok_or("Source no longer exists; preview again")?;
    if source_mapping(source) != preview["sourceMapping"] {
        return Err("Source mapping changed after preview; preview again".into());
    }
    let duplicates = placeholders(state, skill, target);
    if json!(duplicates) != preview["placeholders"]
        || duplicates.iter().any(|duplicate| {
            state
                .connections
                .iter()
                .any(|connection| connection["skillId"] == duplicate["id"])
        })
    {
        return Err("远端占位记录或其客户端连接已变化，请重新核对来源".into());
    }
    Ok(())
}

pub(super) fn preview(m: &mut Manager, req: &Value) -> Result<Value, String> {
    allowed(req, &["action", "skillId", "sourceId", "remotePath"])?;
    if m.basic_mode {
        return Err("基本模式不联网预览或修改来源".into());
    }
    let skill = m.skill(text(req, "skillId")?)?;
    writable(&skill)?;
    if protected_record(&skill) {
        return Err("受托管保护的 Skill 不允许重绑来源".into());
    }
    let source = m
        .state
        .sources
        .iter()
        .find(|s| s["id"] == req["sourceId"])
        .cloned()
        .ok_or("Source does not exist")?;
    let root = text(req, "remotePath")?;
    if !root.is_empty() {
        github::validate_relative(root)?;
    }
    let snap = Snapshot::load_fresh(text(&source, "repo")?, source["branch"].as_str())?;
    snap.skill_files(root)?;
    let mut scoped = source.clone();
    track_scope(&mut scoped, &m.state.skills, root, false)?;
    let receipt = installation(&skill)?;
    let target = json!({"sourceId":source["id"],"repo":snap.api.repo,"branch":snap.branch,
        "remotePath":root,"commit":snap.commit});
    let old = binding(&skill);
    let label = |value: &Value| {
        format!(
            "{} · {} · {}",
            value["repo"].as_str().unwrap_or("未关联"),
            value["branch"].as_str().unwrap_or("未知分支"),
            value["remotePath"]
                .as_str()
                .filter(|p| !p.is_empty())
                .unwrap_or("仓库根目录")
        )
    };
    let mut warnings = vec![format!("原关联：{}", label(&old)), format!("新关联：{}", label(&target)),
        "仅修改来源记录；保留本地文件、Skill 身份和安装记录，不下载、启动或覆盖运行文件。新来源比较与能力仍待核验。".into()];
    warnings.push(match &receipt {
        Some(value) => format!(
            "原安装来源：{} · 提交 {}；安装说明仍从此版本读取。",
            label(value),
            value["commit"].as_str().unwrap_or("未知")
        ),
        None => "原安装来源未知；本次关联不会建立或冒认安装记录。".into(),
    });
    let duplicates = placeholders(&m.state, &skill, &target);
    let can_apply = !duplicates.iter().any(|duplicate| {
        m.state
            .connections
            .iter()
            .any(|c| c["skillId"] == duplicate["id"])
    });
    if !can_apply {
        warnings.push("远端占位记录存在客户端连接，请先核对并保留该记录。".into());
    }
    let id = m.id();
    let public = json!({"id":id,"kind":"associate","skillId":skill["id"],"summary":"核对并确认 Skill 来源关联",
        "files":[],"warnings":warnings,"canApply":can_apply,"previousSource":old,"targetSource":target,
        "installedProvenance":receipt,"localProtection":{"path":skill["localPath"],"filesUnchanged":true,"identityUnchanged":true},"commit":snap.commit});
    m.previews.clear();
    m.previews.insert(
        id,
        json!({"public":public,"skillStamp":skill_stamp(&skill),"expectedSkill":skill,
        "sourceMapping":source_mapping(&source),"placeholders":duplicates}),
    );
    Ok(public)
}

pub(super) fn apply(m: &mut Manager, req: &Value) -> Result<Value, String> {
    allowed(req, &["action", "previewId"])?;
    if m.basic_mode {
        return Err("基本模式不修改来源".into());
    }
    let preview = consume_preview(m, req, "associate")?;
    guard(&m.state, &preview)?;
    let target = &preview["public"]["targetSource"];
    let mut source = m
        .state
        .sources
        .iter()
        .find(|s| s["id"] == target["sourceId"])
        .cloned()
        .ok_or("Source no longer exists")?;
    let snap = Snapshot::load_fresh(text(&source, "repo")?, source["branch"].as_str())?;
    if snap.commit != text(target, "commit")? || snap.branch != text(target, "branch")? {
        return Err("The remote branch changed after preview; refresh and preview again".into());
    }
    let root = text(target, "remotePath")?;
    snap.skill_files(root)?;
    let mut skill = m.skill(text(&preview["public"], "skillId")?)?;
    if ["sourceId", "repo", "branch", "remotePath"]
        .iter()
        .all(|field| skill[*field] == target[*field])
    {
        // Reconfirming an unchanged binding is not an update check. The worker's
        // unchanged save still runs the live guard before acknowledging this no-op.
        m.save()?;
        return Ok(m.snapshot());
    }
    track_scope(&mut source, &m.state.skills, root, false)?;
    // Capture provenance before replacing any source or comparison fields.
    skill["installedProvenance"] = installation(&skill)?.unwrap_or(Value::Null);
    let mut history = skill["sourceHistory"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    history.push(json!({"changedAt":now(),"source":binding(&skill),"baselineCommit":skill["baselineCommit"],
        "baselineKind":skill["baselineKind"],"baselineHashes":skill["baselineHashes"],"baselineDocHash":skill["baselineDocHash"],
        "comparisonCommit":skill["comparisonCommit"],"comparisonLocalHashes":skill["comparisonLocalHashes"],
        "comparisonRemoteHashes":skill["comparisonRemoteHashes"],"associationReason":skill["associationReason"],
        "runtimeSources":skill["runtimeSources"],"installedProvenance":skill["installedProvenance"],
        "runtimeAudit":skill["runtimeAudit"],"runtimeConfirmed":skill["runtimeConfirmed"],
        "runtimeConfirmationKind":skill["runtimeConfirmationKind"]}));
    skill["sourceHistory"] = json!(history);
    for field in ["sourceId", "repo", "branch", "remotePath", "commit"] {
        skill[field] = target[field].clone();
    }
    for field in [
        "baselineCommit",
        "baselineKind",
        "baselineVerifiedAt",
        "baselineDocHash",
        "associationBaselineVerifiedAt",
        "remoteHashes",
        "remoteDocHash",
        "lastRemoteCheckedAt",
        "documentationPath",
        "catalogMetadata",
        "comparisonLocalHashes",
        "comparisonRemoteHashes",
        "comparisonObservedAt",
        "comparisonRuntimeFiles",
        "comparisonRuntimeSelection",
        "comparisonCommit",
        "comparisonScope",
        "comparisonDocHash",
    ] {
        skill[field] = Value::Null;
    }
    skill["baselineHashes"] = json!({});
    skill["runtimeSources"] = json!({});
    skill["changeDetails"] = json!([]);
    skill["remoteCheckRequired"] = json!(true);
    skill["comparisonPending"] = json!(true);
    skill["comparisonScopeUnverified"] = json!(true);
    skill["associationPending"] = json!(false);
    skill["associationReason"] = json!("用户预览确认了此 GitHub 来源");
    skill["associationNote"] =
        json!("来源关联已变更；本地文件与原安装证据保留，新来源内容与能力尚待核验");
    skill["comparisonNote"] = skill["associationNote"].clone();
    skill["sourceVerification"] = json!({"status":"pending","invocationStatus":"not_verified"});
    if skill["runtimeAudit"].is_object() {
        // The old manifest stamp includes the source mapping. Archive its full
        // proof above; no consumer may keep using it until a fresh local audit.
        skill["runtimeAudit"] = json!({"status":"needs_review","checkedAt":null,
            "invalidatedAt":now(),"method":"static_package","canAutoConfirm":false,
            "reason":"来源关联已变化，原静态核对证据已保留在来源历史，请重新核对",
            "preservedScope":skill["runtimeFiles"],"invocationStatus":"not_verified"});
        if skill["runtimeConfirmationKind"] == "automatic" {
            skill["runtimeConfirmed"] = json!(false);
        }
    }
    skill["sourceHealth"] = json!({"status":"unknown","message":"新来源尚待核验","checkedAt":null});
    skill["private"] = json!(snap.private);
    skill["error"] = Value::Null;
    skill["remoteMissing"] = json!(false);
    skill["status"] = json!(if skill["localPath"].is_string() {
        "unknown_baseline"
    } else {
        "remote_only"
    });
    let duplicates = preview["placeholders"]
        .as_array()
        .ok_or("Invalid association preview")?;
    for other in duplicates {
        if other["favorite"] == true {
            skill["favorite"] = json!(true);
        }
        if !skill["categoryId"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
        {
            skill["categoryId"] = other["categoryId"].clone();
        }
    }
    let previous = m.state.clone();
    m.state
        .skills
        .retain(|s| !duplicates.iter().any(|other| other["id"] == s["id"]));
    m.upsert_skill(skill);
    if let Some(stored) = m.state.sources.iter_mut().find(|s| s["id"] == source["id"]) {
        *stored = source;
    }
    update_source(m, &snap, &target["sourceId"]);
    save_association_state(m, previous)
}

pub(super) fn health(m: &Manager, req: &Value) -> Result<Value, String> {
    allowed(req, &["action", "skillId"])?;
    if m.basic_mode {
        return Err("基本模式只读取已保存资料，不联网核对来源".into());
    }
    let skill = m.skill(text(req, "skillId")?)?;
    let read = (|| -> Result<Value, String> {
        let source = source_for(m, &skill)?;
        if source["repo"] != skill["repo"] {
            return Err("Skill/source association is inconsistent".into());
        }
        let snap = Snapshot::load_fresh(
            repo(&skill)?,
            skill["branch"].as_str().or(source["branch"].as_str()),
        )?;
        snap.skill_files(remote_path(&skill)?)?;
        Ok(
            json!({"status":"ok","message":"来源与具体 Skill 目录可读取；尚未验证运行能力","checkedAt":now(),"commit":snap.commit}),
        )
    })();
    let health = read.unwrap_or_else(|error| crate::resource_source::failure_health(&error));
    Ok(json!({"skillId":skill["id"],"source":binding(&skill),"health":health}))
}
