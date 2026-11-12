//! Server-only correlation and official package version observations. These
//! values are never accepted from native/MCP requests as execution permission.
use super::*;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AutomaticBinding {
    pub resource_id: String,
    pub grant_revision: u64,
    pub attempt_id: String,
    pub version: String,
    pub source_key: String,
    pub source_check_revision: u64,
    pub metadata_hash: Option<String>,
    pub permitted_packages: Vec<String>,
}

pub(crate) fn runtime_paths(runtime: &BuilderRuntime) -> Vec<PathBuf> {
    match runtime {
        BuilderRuntime::Node(node) => vec![node.path.clone()],
        BuilderRuntime::PythonPip(pip) => vec![
            pip.interpreter.path.clone(),
            pip.site_packages.join("pip"),
            pip.python_license.clone(),
        ],
    }
}

/// Each selected write directory must be separate from the shared interpreter
/// installation. The existing runtime is inspected, never repaired or upgraded.
pub(crate) fn validate_write_locations(
    runtime: &BuilderRuntime,
    locations: &[&Path],
    original_root: Option<&Path>,
) -> Result<(), String> {
    let same_or_nested = |left: &Path, right: &Path| {
        let key = |p: &Path| {
            if cfg!(windows) {
                p.to_string_lossy().replace('/', "\\").to_lowercase()
            } else {
                p.to_string_lossy().into_owned()
            }
        };
        let (left, right) = (key(left), key(right));
        left == right || left.starts_with(&(right + if cfg!(windows) { "\\" } else { "/" }))
    };
    let interpreter = match runtime {
        BuilderRuntime::Node(node) => node.path(),
        BuilderRuntime::PythonPip(pip) => pip.interpreter.path(),
    };
    let shared_root = interpreter.parent().ok_or("共享运行环境根目录未知")?;
    for (index, location) in locations.iter().enumerate() {
        if same_or_nested(location, shared_root)
            || same_or_nested(shared_root, location)
            || original_root.is_some_and(|root| {
                same_or_nested(location, root) || same_or_nested(root, location)
            })
            || locations[..index]
                .iter()
                .any(|other| same_or_nested(location, other) || same_or_nested(other, location))
        {
            return Err(
                "准备、下载和候选目录须互不嵌套，并避开原运行目录及共享 Python/Node 目录".into(),
            );
        }
    }
    Ok(())
}

pub(crate) fn artifact_packages(artifacts: &[ArtifactBinding]) -> Result<Vec<String>, String> {
    let mut names = BTreeSet::new();
    for artifact in artifacts {
        let name = match &artifact.origin {
            ArtifactOrigin::GithubRelease { source }
                if canonical_repo(&source.repository) == canonical_repo(REACH_REPOSITORY) =>
            {
                "agent-reach".to_owned()
            }
            ArtifactOrigin::PyPiWheel { package, .. }
            | ArtifactOrigin::NpmRegistry { package, .. } => package.clone(),
            _ => return Err("运行包包含不属于固定配方的来源".into()),
        };
        if !names.insert(name) {
            return Err("运行包依赖包名重复".into());
        }
    }
    Ok(names.into_iter().collect())
}

/// Only unambiguous stable numeric versions are automatically ordered. A new
/// prerelease/format stays visible for manual review instead of being guessed.
pub(crate) fn stable_version(value: &str) -> Result<[u64; 3], String> {
    let values = value.split('.').collect::<Vec<_>>();
    if values.len() != 3
        || values.iter().any(|v| {
            v.is_empty()
                || v.len() > 16
                || !v.bytes().all(|b| b.is_ascii_digit())
                || (v.len() > 1 && v.starts_with('0'))
        })
    {
        return Err("版本不是可自动比较的稳定三段版本".into());
    }
    Ok([
        values[0].parse().map_err(|_| "版本超出范围")?,
        values[1].parse().map_err(|_| "版本超出范围")?,
        values[2].parse().map_err(|_| "版本超出范围")?,
    ])
}
pub(crate) fn require_newer(target: &str, original: &str) -> Result<(), String> {
    if stable_version(target)? <= stable_version(original.trim_start_matches('v'))? {
        return Err("目标包版本并不高于当前版本，未自动降级或重装".into());
    }
    Ok(())
}

pub(crate) fn latest_edge() -> Result<(String, String), String> {
    let value = json_response("https://registry.npmjs.org/@playwright%2fmcp/latest")?;
    let version = value["version"].as_str().ok_or("官方 npm 稳定版本缺失")?;
    stable_version(version)?;
    let main = inspect_npm_metadata("@playwright/mcp", version, &value)?;
    let closure = resolve_edge_registry(version)?;
    if !closure
        .packages
        .iter()
        .any(|p| p.package == "@playwright/mcp" && json!(p) == json!(main))
    {
        return Err("npm 稳定观察与精确版本元数据不一致".into());
    }
    Ok((version.to_owned(), closure.metadata_hash))
}

pub(crate) fn reach_wheel_name(name: &str, version: &str) -> bool {
    let version = version.trim_start_matches('v');
    stable_version(version).is_ok()
        && name.starts_with(&format!("agent_reach-{version}-"))
        && name.ends_with(".whl")
        && !name.contains(['/', '\\'])
}
pub(crate) fn reach_asset_hash(
    release_id: u64,
    tag: &str,
    asset: &Value,
) -> Result<String, String> {
    if release_id == 0
        || asset["id"].as_u64().is_none_or(|id| id == 0)
        || asset["size"]
            .as_u64()
            .is_none_or(|size| size == 0 || size > MAX_ARCHIVE)
        || asset["name"]
            .as_str()
            .is_none_or(|name| !reach_wheel_name(name, tag))
    {
        return Err("官方 wheel 观察的发行、文件或大小无效".into());
    }
    Ok(sha256(&serde_json::to_vec(&json!({"releaseId":release_id,"tag":tag,"assetId":asset["id"],"name":asset["name"],"size":asset["size"]})).map_err(|e| e.to_string())?))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn package_ordering_and_wheel_identity_do_not_guess_formats_or_sources() {
        assert!(require_newer("1.6.1", "v1.6.0").is_ok());
        for target in ["1.6.0", "1.5.9", "1.6.1-rc1", "01.6.1", "1.6", "v1.6.1"] {
            assert!(require_newer(target, "1.6.0").is_err(), "{target}");
        }
        assert!(reach_wheel_name(
            "agent_reach-1.6.0-py3-none-any.whl",
            "v1.6.0"
        ));
        assert!(!reach_wheel_name("other-1.6.0-py3-none-any.whl", "v1.6.0"));
        let asset = json!({"id":1,"name":"agent_reach-1.6.0-py3-none-any.whl","size":20});
        assert_ne!(
            reach_asset_hash(2, "v1.6.0", &asset).unwrap(),
            reach_asset_hash(3, "v1.6.0", &asset).unwrap()
        );
    }
    #[test]
    fn write_paths_cannot_nest_in_original_or_shared_runtime() {
        let root = tempfile::tempdir().unwrap();
        let runtime = BuilderRuntime::Node(RuntimeBinding {
            path: root.path().join("shared/node.exe"),
            file: Fingerprint {
                bytes: 1,
                sha256: "a".repeat(64),
                modified: "0".into(),
            },
            object_identity: "synthetic".into(),
        });
        let original = root.path().join("old");
        assert!(validate_write_locations(
            &runtime,
            &[
                &root.path().join("work"),
                &root.path().join("downloads"),
                &root.path().join("candidate")
            ],
            Some(&original)
        )
        .is_ok());
        assert!(
            validate_write_locations(&runtime, &[&original.join("work")], Some(&original)).is_err()
        );
        assert!(validate_write_locations(
            &runtime,
            &[&root.path().join("shared/work")],
            Some(&original)
        )
        .is_err());
        assert!(validate_write_locations(&runtime, &[root.path()], Some(&original)).is_err());
    }
}
