//! Native receipt admission. A generated runtime is never relabeled as a ZIP.
use crate::{
    model::Manager,
    resource_package::controller::{self, MaterializedPackage},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const LIFETIME_MS: i64 = 600_000;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Prepared {
    session_id: String,
    session_revision: u64,
    name: String,
    seal: String,
}
fn allowed(request: &Value, keys: &[&str]) -> Result<(), String> {
    if request
        .as_object()
        .is_none_or(|o| o.keys().any(|k| !keys.contains(&k.as_str())))
    {
        return Err("运行包登记只接受已存会话和本次预览，不接受来源、文件角色或成功标记".into());
    }
    Ok(())
}
fn text<'a>(request: &'a Value, key: &str, max: usize) -> Result<&'a str, String> {
    request[key]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.len() <= max && !s.chars().any(char::is_control))
        .ok_or_else(|| format!("{key} 缺失或无效"))
}
fn normal(m: &Manager) -> Result<(), String> {
    if m.basic_mode {
        Err("基本模式不登记或切换运行包".into())
    } else {
        Ok(())
    }
}
fn seal(package: &MaterializedPackage) -> Result<String, String> {
    let identity = crate::clients::file_identity(&package.receipt.root)?;
    Ok(format!("{:x}",Sha256::digest(serde_json::to_vec(&json!({"revision":package.session_revision,"receipt":package.receipt,"provenance":package.provenance,"binding":package.binding,"rootIdentity":identity})).map_err(|e|e.to_string())?)))
}
pub(crate) fn handle(m: &mut Manager, request: &Value) -> Result<Option<Value>, String> {
    if request["action"] != "preview_resource_package_commit" {
        return Ok(None);
    }
    normal(m)?;
    allowed(request, &["action", "sessionId", "name"])?;
    let session_id = text(request, "sessionId", 64)?.to_owned();
    let package = controller::materialized_package(m, &session_id)?;
    package.provenance.recheck_shared_runtime()?;
    crate::resource_update::check_materialized_candidate(m, &package)?;
    let name = match request.get("name") {
        Some(Value::String(value)) if !value.trim().is_empty() => {
            text(request, "name", 160)?.trim().to_owned()
        }
        None | Some(Value::Null) | Some(Value::String(_)) => match package.provenance.recipe {
            crate::resource_package::Recipe::AgentReachWheelV1 => "Agent Reach",
            crate::resource_package::Recipe::EdgeMcpNpmV1 => "Playwright MCP",
        }
        .into(),
        _ => return Err("名称格式无效".into()),
    };
    let prepared = Prepared {
        session_id: session_id.clone(),
        session_revision: package.session_revision,
        name: name.clone(),
        seal: seal(&package)?,
    };
    let resource_id = package.binding.as_ref().map(|b| b.record.id.clone());
    let kind = match package.provenance.recipe {
        crate::resource_package::Recipe::AgentReachWheelV1 => "cli",
        crate::resource_package::Recipe::EdgeMcpNpmV1 => "mcp",
    };
    let id = uuid::Uuid::new_v4().to_string();
    let source =
        crate::resource_manifest::RuntimePackageSource::from_provenance(&package.provenance)?;
    let public = json!({"id":id,"kind":"resourcePackageCommit","recipe":package.provenance.recipe,"resourceKind":kind,"name":name,"sessionId":session_id,"sessionRevision":package.session_revision,"resourceId":resource_id,"targetPath":package.receipt.root,"version":package.provenance.version,"mode":if resource_id.is_some(){"candidate"}else{"register"},"files":package.receipt.files,"source":source,"canApply":true,"warnings":["登记本次真实准备的目录和文件，不重新安装、不复制配置或登录信息；来源记录不等于运行能力验证。",if resource_id.is_some(){"只登记候选，原版本保持；验证与切换仍需分别确认。"}else{"登记后只附加固定版本查询入口；平台和浏览器功能另行验证。"}]});
    m.previews.retain(|_, v| {
        v["kind"] != "resourcePackageCommit"
            || v["createdAt"].as_i64().is_some_and(|t| {
                (0..=LIFETIME_MS).contains(&(chrono::Utc::now().timestamp_millis() - t))
            })
    });
    if m.previews
        .values()
        .filter(|v| v["kind"] == "resourcePackageCommit")
        .count()
        >= 32
    {
        return Err("运行包登记预览过多，请先完成已有操作".into());
    }
    m.previews.insert(id,json!({"kind":"resourcePackageCommit","resourceId":resource_id,"targetPath":public["targetPath"],"sessionId":session_id,"prepared":prepared,"public":public,"createdAt":chrono::Utc::now().timestamp_millis()}));
    Ok(Some(public))
}
pub(crate) fn apply_local(m: &mut Manager, request: &Value) -> Result<Option<Value>, String> {
    if request["action"] != "apply_resource_package_commit" {
        return Ok(None);
    }
    normal(m)?;
    allowed(request, &["action", "previewId"])?;
    let id = text(request, "previewId", 64)?;
    let preview = m
        .previews
        .get(id)
        .ok_or("登记预览已过期或消费，请重新核对")?;
    if preview["kind"] != "resourcePackageCommit"
        || preview["public"]["canApply"] != true
        || !preview["createdAt"].as_i64().is_some_and(|t| {
            (0..=LIFETIME_MS).contains(&(chrono::Utc::now().timestamp_millis() - t))
        })
    {
        return Err("登记预览类型、时间或范围已失效".into());
    }
    let preview = m.previews.remove(id).ok_or("登记预览已消费")?;
    let prepared: Prepared =
        serde_json::from_value(preview["prepared"].clone()).map_err(|_| "内部登记预览不可读取")?;
    let package = controller::materialized_package(m, &prepared.session_id)?;
    if package.session_revision != prepared.session_revision || seal(&package)? != prepared.seal {
        return Err("运行包、目录、共享环境或原资源已变化，请重新预览".into());
    }
    package.provenance.recheck_shared_runtime()?;
    crate::resource_update::check_materialized_candidate(m, &package)?;
    Ok(Some(if package.binding.is_some() {
        crate::resource_update::stage_materialized(m, package)?
    } else {
        crate::resource_lifecycle::register_materialized(m, &prepared.name, package)?
    }))
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use crate::{
        resource_files::{FileRole, Fingerprint, OwnedFile},
        resource_package::{
            ArtifactBinding, ArtifactOrigin, BuilderRuntime, Recipe, RuntimeBinding,
            RuntimePackageProvenance, RuntimePackageReceipt,
        },
    };
    use std::{fs, path::Path};
    pub(crate) fn package(root: &Path, version: &str, node: &Path) -> MaterializedPackage {
        fs::create_dir_all(root).unwrap();
        let mut files = vec![];
        for (path, bytes, role) in [
            (
                "node_modules/@playwright/mcp/cli.js",
                "program.version('Version');program.parseAsync(process.argv)",
                FileRole::Runtime,
            ),
            (
                "node_modules/playwright/index.js",
                "synthetic dependency",
                FileRole::PrivateDependency,
            ),
            (
                "node_modules/playwright-core/index.js",
                "synthetic dependency core",
                FileRole::PrivateDependency,
            ),
            (
                "node_modules/@playwright/mcp/LICENSE",
                "synthetic Apache license",
                FileRole::License,
            ),
        ] {
            let target = root.join(path);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(&target, bytes).unwrap();
            files.push(OwnedFile {
                path: path.into(),
                role,
                installed_sha256: crate::resource_files::fingerprint(&target).unwrap().sha256,
            });
        }
        let target = root.join("node_modules/@playwright/mcp/package.json");
        fs::write(&target,serde_json::to_vec(&json!({"name":"@playwright/mcp","version":version,"repository":{"url":"git+https://github.com/microsoft/playwright-mcp.git"}})).unwrap()).unwrap();
        files.push(OwnedFile {
            path: "node_modules/@playwright/mcp/package.json".into(),
            role: FileRole::Runtime,
            installed_sha256: crate::resource_files::fingerprint(&target).unwrap().sha256,
        });
        let packages = [
            ("@playwright/mcp", version, "microsoft/playwright-mcp"),
            ("playwright", "1.64.0-alpha-1", "microsoft/playwright"),
            ("playwright-core", "1.64.0-alpha-1", "microsoft/playwright"),
        ];
        let artifacts = packages
            .into_iter()
            .map(|(name, version, repo)| {
                use base64::Engine;
                let basename = name.rsplit('/').next().unwrap();
                ArtifactBinding {
                    path: root
                        .parent()
                        .unwrap()
                        .join(format!("downloads/{basename}-{version}.tgz")),
                    file: Fingerprint {
                        bytes: 42,
                        sha256: "a".repeat(64),
                        modified: "synthetic".into(),
                    },
                    origin: ArtifactOrigin::NpmRegistry {
                        registry: "https://registry.npmjs.org".into(),
                        package: name.into(),
                        version: version.into(),
                        repository: format!("https://github.com/{repo}"),
                        tarball: format!(
                            "https://registry.npmjs.org/{name}/-/{basename}-{version}.tgz"
                        ),
                        integrity: format!(
                            "sha512-{}",
                            base64::engine::general_purpose::STANDARD.encode([0u8; 64])
                        ),
                    },
                }
            })
            .collect::<Vec<_>>();
        let runtime = BuilderRuntime::Node(RuntimeBinding::inspect(node).unwrap());
        let provenance = RuntimePackageProvenance {
            schema_version: 1,
            recipe: Recipe::EdgeMcpNpmV1,
            version: version.into(),
            plan_hash: "b".repeat(64),
            source_artifacts: artifacts.clone(),
            runtime: runtime.clone(),
        };
        provenance.validate_source().unwrap();
        MaterializedPackage {
            session_revision: 2,
            receipt: RuntimePackageReceipt {
                recipe: Recipe::EdgeMcpNpmV1,
                source_artifacts: artifacts,
                runtime,
                plan_hash: provenance.plan_hash.clone(),
                root: root.into(),
                created_paths: files.iter().map(|file| root.join(&file.path)).collect(),
                files,
                complete: true,
                error: None,
                dependency_check_passed: true,
                execution_verified: false,
                temporary_paths: vec![],
            },
            provenance,
            binding: None,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn manager() -> (tempfile::TempDir, Manager) {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("work/package-lifecycle-tests");
        std::fs::create_dir_all(&root).unwrap();
        let temp = tempfile::tempdir_in(root).unwrap();
        let manager = Manager::new(temp.path().join("manager")).unwrap();
        (temp, manager)
    }
    #[test]
    fn caller_receipts_flags_and_unknown_sessions_do_not_register() {
        let (_temp, mut m) = manager();
        assert!(handle(&mut m,&json!({"action":"preview_resource_package_commit","sessionId":"fake","receipt":{"complete":true}})).is_err());
        assert!(handle(&mut m,&json!({"action":"preview_resource_package_commit","sessionId":uuid::Uuid::new_v4().to_string()})).is_err());
        assert!(apply_local(
            &mut m,
            &json!({"action":"apply_resource_package_commit","previewId":"fake","confirmed":true})
        )
        .is_err());
        assert!(m
            .resource_store(crate::resources::StoreRequest::List)
            .unwrap()["resources"]
            .as_array()
            .unwrap()
            .is_empty());
    }
    #[test]
    fn basic_mode_and_wrong_or_expired_previews_cannot_commit() {
        let (_temp, mut m) = manager();
        m.basic_mode = true;
        assert!(handle(
            &mut m,
            &json!({"action":"preview_resource_package_commit","sessionId":"fake"})
        )
        .unwrap_err()
        .contains("基本模式"));
        m.basic_mode = false;
        for (kind, time) in [
            ("resourceInstall", chrono::Utc::now().timestamp_millis()),
            ("resourcePackageCommit", 0),
        ] {
            let id = uuid::Uuid::new_v4().to_string();
            m.previews.insert(
                id.clone(),
                json!({"kind":kind,"public":{"canApply":true},"createdAt":time}),
            );
            assert!(apply_local(
                &mut m,
                &json!({"action":"apply_resource_package_commit","previewId":id})
            )
            .is_err());
        }
    }
    #[test]
    fn real_owned_directory_registration_retains_roles_and_shared_runtime_without_fake_zip() {
        let (temp, m) = manager();
        let node = temp.path().join("node.exe");
        std::fs::write(&node, b"synthetic node; never executed").unwrap();
        let root = temp.path().join("runtime");
        let package = test_support::package(&root, "0.0.82", &node);
        let expected = json!(package.receipt.files);
        let expected_runtime = json!(package.provenance.runtime);
        let result =
            crate::resource_lifecycle::register_materialized(&m, "Synthetic MCP", package).unwrap();
        assert_eq!(result["registered"], true);
        assert_eq!(result["executionVerified"], false);
        assert_eq!(result["resource"]["installation"]["files"], expected);
        assert_eq!(
            result["resource"]["installation"]["runtimePackage"]["runtime"],
            expected_runtime
        );
        assert_eq!(result["resource"]["installation"]["archivePath"], "");
        assert!(result["resource"]["installation"]["downloadSource"].is_null());
        let raw = std::fs::read_to_string(root.join(crate::resource_manifest::NAME)).unwrap();
        assert!(!raw.contains(&temp.path().to_string_lossy().to_string()));
        assert!(!raw.contains("sharedRuntime"));
        let recovery = crate::resource_manifest::recover(&root).unwrap();
        assert_eq!(
            recovery["source"]["runtimePackage"]["recipe"],
            "edgeMcpNpmV1"
        );
        assert_eq!(recovery["executionGrant"], false);
        let resource: crate::resources::ResourceRecord =
            serde_json::from_value(result["resource"].clone()).unwrap();
        assert_eq!(
            resource.actions[0]["args"][0]["value"],
            json!(
                crate::local::canonical(&root.join("node_modules/@playwright/mcp/cli.js")).unwrap()
            )
        );
        let supported = crate::resource_probe::automation_supported(&resource);
        assert!(supported.is_ok(), "{supported:?}");
        let mut browser = resource.clone();
        browser.actions[0]["args"]
            .as_array_mut()
            .unwrap()
            .last_mut()
            .unwrap()["value"] = json!("--extension");
        assert!(crate::resource_probe::automation_supported(&browser).is_err());
        let mut forged = resource.clone();
        forged
            .installation
            .as_mut()
            .unwrap()
            .runtime_package
            .as_mut()
            .unwrap()
            .source_artifacts
            .clear();
        assert!(crate::resource_probe::automation_supported(&forged).is_err());
        std::fs::write(&node, b"changed synthetic runtime").unwrap();
        assert!(crate::resource_update::verify_registered_runtime(&resource).is_err());
    }
}
