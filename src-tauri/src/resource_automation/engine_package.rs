//! Typed package branch of the same private task coordinator. Every phase still
//! obtains the normal controller preview and checks its live grant separately.
use super::*;
use crate::resource_package::{automation as package_auto, controller, Recipe};

fn binding(
    m: &Manager,
    scope: &AutomationScope,
    ctx: &Context,
) -> Result<package_auto::AutomaticBinding, String> {
    let package = scope.runtime_package.as_ref().ok_or("没有固定运行包许可")?;
    let record = read(m, &ctx.resource_id)?;
    let value = m.resource_check_store(crate::resource_checks::StoreRequest::Get(
        ctx.source_key.clone(),
    ))?;
    let observed = observation(&value, &record, scope)?
        .filter(|o| {
            o.revision == ctx.source_check_revision
                && o.version == ctx.version
                && o.source_key == ctx.source_key
        })
        .ok_or("本次官方包来源观察已被替换或过期，未继续应用")?;
    package_auto::require_newer(
        ctx.version.trim_start_matches('v'),
        record.version.as_deref().ok_or("原包版本未知")?,
    )?;
    Ok(package_auto::AutomaticBinding {
        resource_id: ctx.resource_id.clone(),
        grant_revision: ctx.grant_revision,
        attempt_id: ctx.attempt_id.clone().ok_or("缺少自动尝试身份")?,
        version: ctx.version.clone(),
        source_key: observed.source_key,
        source_check_revision: observed.revision,
        metadata_hash: value["latest"]["metadataHash"].as_str().map(str::to_owned),
        permitted_packages: package.permitted_packages.clone(),
    })
}
pub(super) fn validate_observation(
    m: &Manager,
    scope: &AutomationScope,
    ctx: &Context,
) -> Result<(), String> {
    binding(m, scope, ctx).map(|_| ())
}

pub(super) fn select_reach(
    m: &mut Manager,
    releases: &Value,
    scope: &AutomationScope,
    ctx: &Context,
) -> Result<(u64, u64), String> {
    if scope
        .runtime_package
        .as_ref()
        .is_none_or(|p| p.recipe != Recipe::AgentReachWheelV1)
    {
        return Err("npm 更新不能改用 GitHub 资产".into());
    }
    let expected = binding(m, scope, ctx)?;
    let rows = releases["releases"]
        .as_array()
        .ok_or("官方 wheel 发行列表不可读取")?
        .iter()
        .filter(|r| r["tag"] == ctx.version && r["prerelease"] == false)
        .collect::<Vec<_>>();
    if rows.len() != 1 {
        return Err("官方 wheel 稳定发行身份不唯一".into());
    }
    let release = rows[0];
    let assets = release["assets"]
        .as_array()
        .ok_or("官方 wheel 资产缺失")?
        .iter()
        .filter(|a| {
            a["unavailableReason"].is_null()
                && a["name"]
                    .as_str()
                    .is_some_and(|n| package_auto::reach_wheel_name(n, &ctx.version))
        })
        .collect::<Vec<_>>();
    if assets.len() != 1 {
        return Err("主 wheel 缺失或不唯一，未自动换包".into());
    }
    let release_id = release["id"].as_u64().ok_or("官方发行标识缺失")?;
    if expected.metadata_hash.as_deref()
        != Some(package_auto::reach_asset_hash(release_id, &ctx.version, assets[0])?.as_str())
    {
        return Err("主 wheel 身份不同于本次成功来源观察，未自动下载".into());
    }
    let current = read(m, &ctx.resource_id)?;
    let provenance = current
        .installation
        .as_ref()
        .and_then(|i| i.runtime_package.as_ref())
        .ok_or("原运行包来源缺失")?;
    let source = provenance
        .source_artifacts
        .iter()
        .find_map(|a| match &a.origin {
            crate::resource_package::ArtifactOrigin::GithubRelease { source } => Some(source),
            _ => None,
        })
        .ok_or("原主 wheel 实际发行回执缺失")?;
    let old=crate::resource_github::handle(m,&json!({"action":"resource_github_releases","repository":scope.repository,"tag":source.version}))?.ok_or("原固定 wheel 发行不可读")?;
    ensure_newer_release(
        releases,
        &old,
        release_id,
        source.release_id,
        &ctx.version,
        &source.version,
    )?;
    Ok((
        release_id,
        assets[0]["id"].as_u64().ok_or("主 wheel 标识缺失")?,
    ))
}

pub(super) fn validate_wheel_download(
    m: &Manager,
    plan: &Value,
    scope: &AutomationScope,
    ctx: &Context,
) -> Result<(), String> {
    let expected = binding(m, scope, ctx)?;
    let asset = json!({"id":plan["assetId"],"name":plan["assetName"],"size":plan["downloadBytes"]});
    let actual = package_auto::reach_asset_hash(
        plan["releaseId"].as_u64().ok_or("主 wheel 发行标识缺失")?,
        &ctx.version,
        &asset,
    )?;
    if expected.metadata_hash.as_deref() != Some(actual.as_str()) {
        return Err("下载预览与实际来源观察不一致".into());
    }
    Ok(())
}

fn session_id<'a>(request: &'a Value, attempt: &Attempt) -> Result<&'a str, String> {
    let id = request["sessionId"].as_str().ok_or("缺少本次包准备记录")?;
    if attempt.result["packageSessionId"] != id {
        return Err("包会话不属于已持久记录的本次尝试".into());
    }
    Ok(id)
}
pub(super) fn dispatch(
    m: &mut Manager,
    internal: &Value,
    request: &Value,
    ctx: &Context,
    scope: &AutomationScope,
    attempt: &Attempt,
) -> Result<Value, String> {
    let package = scope
        .runtime_package
        .as_ref()
        .ok_or("ZIP 许可不允许执行运行包阶段")?;
    let action = request["action"].as_str().ok_or("包阶段缺失")?;
    let bound = binding(m, scope, ctx)?;
    let is_preview = action.starts_with("preview_");
    if action == "preview_resource_package_prepare" {
        if !controller::automatic_sessions(m, &bound)?.is_empty() {
            return Err("本次尝试已有真实准备记录，未重放解析或安装".into());
        }
        if request["recipe"] != json!(package.recipe)
            || request["version"] != ctx.version.trim_start_matches('v')
            || request["resourceId"] != ctx.resource_id
            || request["expectedRevision"].as_u64() != Some(read(m, &ctx.resource_id)?.revision)
            || request["runtimePath"].as_str().map(Path::new).map(path_key)
                != Some(path_key(&package.runtime_path))
            || request["workDirectory"]
                .as_str()
                .map(Path::new)
                .map(path_key)
                != Some(path_key(&package.work_directory))
            || request["downloadDirectory"]
                .as_str()
                .map(Path::new)
                .map(path_key)
                != Some(path_key(&scope.download_directory))
            || request["destinationPath"]
                .as_str()
                .map(Path::new)
                .map(path_key)
                != Some(path_key(&attempt.candidate_root))
            || request["bytesPerSecond"].as_u64() != Some(package.bytes_per_second)
        {
            return Err("运行包准备请求超出固定配方、共享环境或保存位置许可".into());
        }
        if package.recipe == Recipe::AgentReachWheelV1
            && (request["downloadId"] != attempt.result["downloadId"]
                || request["archivePath"] != attempt.result["archivePath"])
        {
            return Err("主 wheel 不属于本次自动下载回执".into());
        }
        let result = controller::handle(m, request)?.ok_or("运行包准备预览不可用")?;
        controller::bind_automatic_prepare(
            m,
            result["id"].as_str().ok_or("准备预览标识缺失")?,
            bound,
        )?;
        bind_preview(m, &result, ctx)?;
        return Ok(result);
    }
    if action == "apply_resource_package_prepare" {
        let plan = check_preview(m, request, ctx, "resourcePackagePrepare")?;
        if !controller::automatic_sessions(m, &bound)?.is_empty() {
            return Err("本次尝试已有真实准备记录，旧解析预览不再重放".into());
        }
        let cached = m
            .previews
            .get(request["previewId"].as_str().ok_or("准备预览标识缺失")?)
            .ok_or("准备预览已失效")?;
        if cached["prepared"]["automatic"] != json!(bound) {
            return Err("准备预览的许可、来源观察或尝试封套已变化".into());
        }
        if plan["recipe"] != json!(package.recipe)
            || plan["targetPath"].as_str().map(Path::new).map(path_key)
                != Some(path_key(&attempt.candidate_root))
        {
            return Err("自动解析预览范围不符".into());
        }
        return controller::apply_local(m, request)?.ok_or("运行包解析不可用".into());
    }
    let (kind, phase) = match action {
        "preview_resource_package_download" | "apply_resource_package_download" => {
            ("resourcePackageDownload", "packageDownload")
        }
        "preview_resource_package_resume" | "apply_resource_package_resume" => {
            ("resourcePackageResume", "packageDownload")
        }
        "preview_resource_package_materialize" | "apply_resource_package_materialize" => {
            ("resourcePackageMaterialize", "materialize")
        }
        "preview_resource_package_commit" | "apply_resource_package_commit" => {
            ("resourcePackageCommit", "packageCommit")
        }
        _ => return Err("未知自动运行包阶段".into()),
    };
    let plan = if is_preview {
        request.clone()
    } else {
        check_preview(m, request, ctx, kind)?
    };
    let id = session_id(&plan, attempt)?;
    let summary = controller::automatic_session(m, id, &bound)?;
    if summary["destinationPath"]
        .as_str()
        .map(Path::new)
        .map(path_key)
        != Some(path_key(&attempt.candidate_root))
        || summary["recipe"] != json!(package.recipe)
    {
        return Err("实际包准备会话超出候选范围".into());
    }
    if phase != "packageCommit" && summary["materialized"] == true {
        return Err("已有最终目录创建回执，未重放运行包写入".into());
    }
    let result = if is_preview {
        let result = if phase == "packageCommit" {
            crate::resource_package_lifecycle::handle(m, request)?
        } else {
            controller::handle(m, request)?
        }
        .ok_or("自动运行包阶段预览不可用")?;
        if phase == "packageCommit"
            && (result["mode"] != "candidate"
                || result["resourceId"] != ctx.resource_id
                || result["version"] != ctx.version.trim_start_matches('v')
                || result["targetPath"].as_str().map(Path::new).map(path_key)
                    != Some(path_key(&attempt.candidate_root)))
        {
            return Err("真实运行包登记不能作为本次候选".into());
        }
        bind_preview(m, &result, ctx)?;
        result
    } else {
        if matches!(phase, "materialize" | "packageCommit") {
            m.begin_automatic_commit(internal)?;
        }
        if phase == "packageCommit" {
            crate::resource_package_lifecycle::apply_local(m, request)?
        } else {
            controller::apply_local(m, request)?
        }
        .ok_or("自动运行包阶段不可用")?
    };
    Ok(result)
}

pub(super) fn prepare(
    execute: &mut dyn FnMut(Value) -> Result<Value, String>,
    ctx: &Context,
    scope: &AutomationScope,
    attempt: &Attempt,
    phase: &mut &'static str,
    retained: &mut Value,
) -> Result<Value, String> {
    let package = scope.runtime_package.as_ref().ok_or("运行包许可缺失")?;
    if package.recipe == Recipe::AgentReachWheelV1 {
        let releases = execute(wrap(
            json!({"action":"resource_github_releases","repository":scope.repository,"tag":ctx.version}),
            ctx,
        ))?;
        let rows = releases["releases"]
            .as_array()
            .ok_or("主 wheel 发行不可读")?
            .iter()
            .filter(|r| r["tag"] == ctx.version && r["prerelease"] == false)
            .collect::<Vec<_>>();
        if rows.len() != 1 {
            return Err("主 wheel 稳定发行不唯一".into());
        }
        let wheels = rows[0]["assets"]
            .as_array()
            .ok_or("主 wheel 文件缺失")?
            .iter()
            .filter(|a| {
                a["unavailableReason"].is_null()
                    && a["name"]
                        .as_str()
                        .is_some_and(|n| package_auto::reach_wheel_name(n, &ctx.version))
            })
            .collect::<Vec<_>>();
        if wheels.len() != 1 {
            return Err("主 wheel 文件不唯一".into());
        }
        *phase = "download";
        progress(execute, ctx, phase, "running", retained.clone())?;
        let preview = execute(wrap(
            if let Some(id) = &attempt.resume_download_id {
                json!({"action":"preview_resource_resume","downloadId":id})
            } else {
                json!({"action":"preview_resource_download","repository":scope.repository,"releaseId":rows[0]["id"],"assetId":wheels[0]["id"],"downloadDirectory":scope.download_directory})
            },
            ctx,
        ))?;
        retained["downloadId"] = preview["downloadId"].clone();
        retained["archivePath"] = preview["targetPath"].clone();
        retained["partialPath"] = preview["partialPath"].clone();
        progress(execute, ctx, phase, "running", retained.clone())?;
        let downloaded = execute(wrap(
            json!({"action":"apply_resource_download","previewId":preview["id"]}),
            ctx,
        ))?;
        if downloaded["complete"] != true {
            return Err("主 wheel 下载尚未完成，真实部分文件保留".into());
        }
        retained["changed"] = json!(true);
        retained["archivePath"] = downloaded["archivePath"].clone();
    }
    *phase = "resolve";
    progress(execute, ctx, phase, "running", retained.clone())?;
    let status = execute(wrap(
        json!({"action":"resource_update_state","id":ctx.resource_id}),
        ctx,
    ))?;
    let mut request = json!({"action":"preview_resource_package_prepare","recipe":package.recipe,"version":ctx.version.trim_start_matches('v'),"runtimePath":package.runtime_path,"workDirectory":package.work_directory,"downloadDirectory":scope.download_directory,"destinationPath":attempt.candidate_root,"bytesPerSecond":package.bytes_per_second,"resourceId":ctx.resource_id,"expectedRevision":status["resource"]["revision"]});
    if package.recipe == Recipe::AgentReachWheelV1 {
        request["archivePath"] = retained["archivePath"].clone();
        request["downloadId"] = retained["downloadId"].clone();
    }
    let preview = execute(wrap(request, ctx))?;
    let prepared = execute(wrap(
        json!({"action":"apply_resource_package_prepare","previewId":preview["id"]}),
        ctx,
    ))?;
    retained["packageSessionId"] = prepared["session"]["id"].clone();
    retained["packageStatus"] = prepared["session"]["status"].clone();
    retained["changed"] = json!(true);
    progress(execute, ctx, phase, "running", retained.clone())?;
    if prepared["complete"] != true {
        return Err("官方包解析未完成或依赖集合已变化，记录保留，未自动重放".into());
    }
    for (name, preview_action, apply_action) in [
        (
            "packageDownload",
            "preview_resource_package_download",
            "apply_resource_package_download",
        ),
        (
            "materialize",
            "preview_resource_package_materialize",
            "apply_resource_package_materialize",
        ),
        (
            "packageCommit",
            "preview_resource_package_commit",
            "apply_resource_package_commit",
        ),
    ] {
        *phase = name;
        progress(execute, ctx, phase, "running", retained.clone())?;
        let preview = execute(wrap(
            json!({"action":preview_action,"sessionId":retained["packageSessionId"]}),
            ctx,
        ))?;
        let result = execute(wrap(
            json!({"action":apply_action,"previewId":preview["id"]}),
            ctx,
        ))?;
        if result["complete"] != true {
            return Err(format!(
                "运行包 {name} 阶段未完成，实际记录保留且不重放安装"
            ));
        }
        if name == "packageCommit" {
            if result["staged"] != true
                || result["registered"] != false
                || result["switched"] != false
            {
                return Err("运行包未形成独立候选，未自动验证或切换".into());
            }
            return Ok(result);
        }
    }
    Err("运行包准备阶段未完成".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Context, AutomationScope, Attempt) {
        let ctx = Context {
            resource_id: "synthetic".into(),
            grant_revision: 1,
            version: "0.0.83".into(),
            source_check_revision: 2,
            source_key: "source".into(),
            attempt_id: Some("attempt".into()),
        };
        let scope = AutomationScope {
            repository: "https://github.com/microsoft/playwright-mcp".into(),
            repository_id: 1,
            source_fingerprint: "source".into(),
            constraint_fingerprint: "facts".into(),
            original_root: PathBuf::from("old"),
            original_root_id: "original".into(),
            candidate_parent_path: PathBuf::from("versions"),
            candidate_parent_id: "versions-id".into(),
            download_directory: PathBuf::from("downloads"),
            download_directory_id: "downloads-id".into(),
            channel: "stable".into(),
            asset_name: "npm:@playwright/mcp".into(),
            files: BTreeMap::from([("cli.js".into(), FileRole::Runtime)]),
            pinned_version: None,
            skipped_versions: vec![],
            runtime_package: Some(crate::resource_automation::package::PackageScope {
                recipe: Recipe::EdgeMcpNpmV1,
                package_name: "@playwright/mcp".into(),
                registry: "https://registry.npmjs.org".into(),
                runtime_path: PathBuf::from("node.exe"),
                runtime_sha256: "a".repeat(64),
                runtime_binding_hash: "b".repeat(64),
                permitted_packages: vec![
                    "@playwright/mcp".into(),
                    "playwright".into(),
                    "playwright-core".into(),
                ],
                work_directory: PathBuf::from("work"),
                work_directory_id: "work-id".into(),
                bytes_per_second: 0,
            }),
        };
        let attempt = Attempt {
            key: "key".into(),
            id: "attempt".into(),
            resource_id: ctx.resource_id.clone(),
            grant_revision: 1,
            version: ctx.version.clone(),
            source_check_revision: 2,
            source_key: ctx.source_key.clone(),
            resume_download_id: None,
            candidate_root: PathBuf::from("versions/candidate"),
            status: "running".into(),
            phase: "release".into(),
            created_at: String::new(),
            updated_at: String::new(),
            result: json!({}),
        };
        (ctx, scope, attempt)
    }
    fn run(fail_materialize: bool) -> (Result<Value, String>, Vec<String>) {
        let (ctx, scope, attempt) = fixture();
        let mut calls = vec![];
        let mut phase = "release";
        let mut retained = json!({"changed":false});
        let result = prepare(
            &mut |request| {
                let action = request["action"].as_str().unwrap().to_owned();
                assert_eq!(request["automatic"], true);
                assert_eq!(request["automation"]["attemptId"], "attempt");
                calls.push(action.clone());
                match action.as_str() {
                    "__resource_automation_finish" => Ok(json!({"saved":true})),
                    "resource_update_state" => Ok(json!({"resource":{"revision":1}})),
                    "preview_resource_package_prepare" => {
                        assert_eq!(request["recipe"], "edgeMcpNpmV1");
                        assert!(request.get("archivePath").is_none());
                        Ok(json!({"id":"prepare"}))
                    }
                    "apply_resource_package_prepare" => {
                        Ok(json!({"complete":true,"session":{"id":"session","status":"resolved"}}))
                    }
                    "preview_resource_package_download"
                    | "preview_resource_package_materialize"
                    | "preview_resource_package_commit" => {
                        assert_eq!(request["sessionId"], "session");
                        Ok(json!({"id":"phase-preview"}))
                    }
                    "apply_resource_package_download" => Ok(json!({"complete":true})),
                    "apply_resource_package_materialize" => {
                        Ok(json!({"complete":!fail_materialize}))
                    }
                    "apply_resource_package_commit" => Ok(
                        json!({"complete":true,"staged":true,"registered":false,"switched":false,"resource":{"revision":2}}),
                    ),
                    _ => Err(format!("unexpected ZIP/GitHub or execution step {action}")),
                }
            },
            &ctx,
            &scope,
            &attempt,
            &mut phase,
            &mut retained,
        );
        assert_eq!(retained["packageSessionId"], "session");
        (result, calls)
    }
    #[test]
    fn official_npm_prepares_a_candidate_before_any_verification_or_switch() {
        let (result, calls) = run(false);
        assert_eq!(result.unwrap()["staged"], true);
        let steps = calls
            .into_iter()
            .filter(|a| a != "__resource_automation_finish")
            .collect::<Vec<_>>();
        assert_eq!(
            steps,
            vec![
                "resource_update_state",
                "preview_resource_package_prepare",
                "apply_resource_package_prepare",
                "preview_resource_package_download",
                "apply_resource_package_download",
                "preview_resource_package_materialize",
                "apply_resource_package_materialize",
                "preview_resource_package_commit",
                "apply_resource_package_commit"
            ]
        );
    }
    #[test]
    fn partial_materialization_cannot_register_or_replay() {
        let (result, calls) = run(true);
        assert!(result.is_err());
        assert_eq!(
            calls
                .iter()
                .filter(|a| a.as_str() == "apply_resource_package_materialize")
                .count(),
            1
        );
        assert!(!calls.iter().any(|a| a.contains("package_commit")
            || a.contains("update_switch")
            || a == "verify_resource_update"));
    }
}
