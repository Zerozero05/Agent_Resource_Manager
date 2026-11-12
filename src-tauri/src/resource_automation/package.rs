//! Fixed package permissions supplement the existing ZIP grant. They never turn
//! a package-built runtime into an upstream archive or grant shared-runtime writes.
use super::*;
use crate::resource_package::{
    BuilderRuntime, PipRuntime, Recipe, RuntimeBinding, RuntimePackageProvenance,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PackageFacts {
    pub recipe: Recipe,
    pub package_name: String,
    pub registry: String,
    pub runtime_path: PathBuf,
    pub runtime_sha256: String,
    pub runtime_binding_hash: String,
    pub permitted_packages: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PackageScope {
    pub recipe: Recipe,
    pub package_name: String,
    pub registry: String,
    pub runtime_path: PathBuf,
    pub runtime_sha256: String,
    pub runtime_binding_hash: String,
    pub permitted_packages: Vec<String>,
    pub work_directory: PathBuf,
    pub work_directory_id: String,
    pub bytes_per_second: u64,
}
impl PackageFacts {
    pub(crate) fn asset_key(&self) -> &'static str {
        match self.recipe {
            Recipe::AgentReachWheelV1 => "wheel:agent-reach",
            Recipe::EdgeMcpNpmV1 => "npm:@playwright/mcp",
        }
    }
    pub(crate) fn with_locations(self, work: PathBuf, rate: u64) -> Result<PackageScope, String> {
        Ok(PackageScope {
            recipe: self.recipe,
            package_name: self.package_name,
            registry: self.registry,
            runtime_path: self.runtime_path,
            runtime_sha256: self.runtime_sha256,
            runtime_binding_hash: self.runtime_binding_hash,
            permitted_packages: self.permitted_packages,
            work_directory_id: crate::clients::file_identity(&work)?,
            work_directory: work,
            bytes_per_second: rate,
        })
    }
}
impl PackageScope {
    pub(crate) fn verify(&self, provenance: &RuntimePackageProvenance) -> Result<(), String> {
        let facts = from_provenance(provenance)?;
        if facts.recipe != self.recipe
            || facts.package_name != self.package_name
            || facts.registry != self.registry
            || facts.permitted_packages != self.permitted_packages
            || path_key(&facts.runtime_path) != path_key(&self.runtime_path)
            || facts.runtime_sha256 != self.runtime_sha256
            || facts.runtime_binding_hash != self.runtime_binding_hash
            || directory(self.work_directory.to_str().ok_or("准备目录无效")?)?
                != self.work_directory
            || crate::clients::file_identity(&self.work_directory)? != self.work_directory_id
        {
            return Err("固定配方、共享运行环境或准备目录已变化，自动许可失效".into());
        }
        Ok(())
    }
}
pub(crate) fn from_provenance(
    provenance: &RuntimePackageProvenance,
) -> Result<PackageFacts, String> {
    provenance.validate_source()?;
    let runtime = provenance.shared_runtime_binding();
    let fresh = match provenance.recipe {
        Recipe::AgentReachWheelV1 => {
            BuilderRuntime::PythonPip(PipRuntime::inspect(runtime.path())?)
        }
        Recipe::EdgeMcpNpmV1 => BuilderRuntime::Node(RuntimeBinding::inspect(runtime.path())?),
    };
    if json!(fresh) != json!(provenance.runtime) {
        return Err("共享 Python/Node、pip 或许可文件已变化，不能沿用自动许可".into());
    }
    Ok(PackageFacts {
        recipe: provenance.recipe.clone(),
        package_name: match provenance.recipe {
            Recipe::AgentReachWheelV1 => "agent-reach",
            Recipe::EdgeMcpNpmV1 => "@playwright/mcp",
        }
        .into(),
        registry: match provenance.recipe {
            Recipe::AgentReachWheelV1 => "https://pypi.org",
            Recipe::EdgeMcpNpmV1 => "https://registry.npmjs.org",
        }
        .into(),
        runtime_path: runtime.path().to_path_buf(),
        runtime_sha256: runtime.fingerprint().sha256.clone(),
        runtime_binding_hash: hash(&json!(fresh)),
        permitted_packages: crate::resource_package::automation::artifact_packages(
            &provenance.source_artifacts,
        )?,
    })
}
pub(crate) fn installed(record: &ResourceRecord) -> Option<&RuntimePackageProvenance> {
    record.installation.as_ref()?.runtime_package.as_ref()
}
pub(crate) fn candidate_matches(
    record: &ResourceRecord,
    scope: &AutomationScope,
    target: &CandidateScope,
) -> Result<(), String> {
    let permission = scope.runtime_package.as_ref().ok_or("缺少固定运行包许可")?;
    let candidate = record
        .installation
        .as_ref()
        .and_then(|i| i.update_state.as_ref())
        .and_then(|s| s.candidate.as_ref())
        .ok_or("没有真实已准备候选")?;
    let provenance = candidate
        .runtime_package
        .as_ref()
        .ok_or("候选不是本次固定运行包配方")?;
    permission.verify(provenance)?;
    let version = crate::resource_package::automation::stable_version(
        target.version.trim_start_matches('v'),
    )?;
    if !candidate.complete
        || candidate.error.is_some()
        || crate::resource_package::automation::stable_version(
            candidate.version.trim_start_matches('v'),
        )? != version
        || crate::resource_package::automation::stable_version(
            provenance.version.trim_start_matches('v'),
        )? != version
        || candidate.root.parent().map(path_key) != Some(path_key(&scope.candidate_parent_path))
        || candidate.files.is_empty()
        || candidate.files.iter().any(|f| !runtime_role(&f.role))
        || !candidate.files.iter().any(|f| f.role == FileRole::Runtime)
        || candidate
            .files
            .iter()
            .map(|f| &f.path)
            .collect::<BTreeSet<_>>()
            .len()
            != candidate.files.len()
    {
        return Err("候选的真实配方、版本、文件用途或目录超出运行包许可".into());
    }
    Ok(())
}
pub(crate) fn locations(
    scope: &AutomationScope,
    manager: &Manager,
    record: &ResourceRecord,
) -> Result<(), String> {
    if let Some(package) = &scope.runtime_package {
        package.verify(installed(record).ok_or("原安装缺少运行包来源")?)?;
        let runtime = &installed(record).ok_or("原安装缺少运行包来源")?.runtime;
        crate::resource_package::automation::validate_write_locations(
            runtime,
            &[&package.work_directory, &scope.download_directory],
            Some(Path::new(&record.root_path)),
        )?;
        crate::resource_package::automation::validate_write_locations(
            runtime,
            &[
                &package.work_directory,
                &scope.download_directory,
                &scope.candidate_parent_path,
            ],
            None,
        )?;
        super::locations(
            manager,
            record,
            &scope.candidate_parent_path,
            &package.work_directory,
        )?;
        for location in [&scope.candidate_parent_path, &scope.download_directory] {
            if nested(&package.work_directory, location)
                || nested(location, &package.work_directory)
            {
                return Err("准备、下载与候选父目录必须互不嵌套".into());
            }
        }
    }
    Ok(())
}
