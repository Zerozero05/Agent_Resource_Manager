//! Exact npm payload repair. No package scripts, full extraction, backups or
//! launcher relocation. Only already-owned, absent runtime files can publish.
use super::*;
use crate::resource_files::{FileRole, OwnedFile, PackageFile, RepairPlan, RepairReceipt};
use std::fs;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Asset {
    binding: ArtifactBinding,
    inventory: tgz::TarInventory,
    metadata: NpmPackageMetadata,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NpmRepairSource {
    provenance: RuntimePackageProvenance,
    assets: Vec<Asset>,
}
fn eligible(role: &FileRole) -> bool {
    matches!(
        role,
        FileRole::Runtime | FileRole::PrivateDependency | FileRole::License
    )
}
fn npm_origin(artifact: &ArtifactBinding) -> Result<(&str, &str, &str), String> {
    match &artifact.origin {
        ArtifactOrigin::NpmRegistry {
            package,
            version,
            tarball,
            ..
        } => Ok((package, version, tarball)),
        _ => Err("修复只接受原 npm 精确资产".into()),
    }
}
fn selected_path(artifact: &ArtifactBinding, directory: Option<&Path>) -> Result<PathBuf, String> {
    let (_, _, url) = npm_origin(artifact)?;
    let path = if let Some(directory) = directory {
        let url = npm_url(url)?;
        let name = url
            .path_segments()
            .and_then(|mut s| s.next_back())
            .ok_or("原 npm 资产缺少文件名")?;
        crate::local::validate_relative_path(name)?;
        directory.join(name)
    } else {
        artifact.path.clone()
    };
    if !path.is_absolute() {
        return Err("原 npm 资产路径必须是绝对路径".into());
    }
    crate::transaction::verify_root(&path)?;
    Ok(path)
}
fn directory(path: Option<&Path>) -> Result<Option<PathBuf>, String> {
    path.map(|p| {
        if !p.is_absolute() || !p.is_dir() {
            return Err("原 npm 资产目录必须是现有的绝对目录".into());
        }
        crate::transaction::verify_root(p)?;
        crate::local::canonical(p)
    })
    .transpose()
}
/// Used by task admission and preview alike. It resolves only the recorded
/// exact filenames; no network lookup or source/version override is possible.
pub(crate) fn source_paths(
    provenance: &RuntimePackageProvenance,
    override_directory: Option<&Path>,
) -> Result<Vec<PathBuf>, String> {
    provenance.validate_source()?;
    if provenance.recipe != Recipe::EdgeMcpNpmV1 {
        return Err("原安装不是已核对的 npm 固定闭包".into());
    }
    let directory = directory(override_directory)?;
    provenance
        .source_artifacts
        .iter()
        .map(|a| selected_path(a, directory.as_deref()))
        .collect()
}
fn package_relative<'a>(path: &'a str, package: &str) -> Option<&'a str> {
    path.strip_prefix(&format!("node_modules/{package}/"))
}
fn missing_packages(
    root: &Path,
    owned: &[OwnedFile],
    provenance: &RuntimePackageProvenance,
) -> Result<BTreeSet<String>, String> {
    let mut needed = BTreeSet::new();
    for file in owned.iter().filter(|f| eligible(&f.role)) {
        let path = crate::local::safe_join(root, &file.path)?;
        match fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let found = provenance
                    .source_artifacts
                    .iter()
                    .find_map(|a| {
                        let (package, _, _) = npm_origin(a).ok()?;
                        package_relative(&file.path, package).map(|_| package.to_owned())
                    })
                    .ok_or_else(|| {
                        format!(
                            "缺失文件不属于原 npm 精确资产，不猜测生成来源：{}",
                            file.path
                        )
                    })?;
                needed.insert(found);
            }
            Ok(_) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(needed)
}
impl NpmRepairSource {
    pub(crate) fn prepare(
        root: &Path,
        owned: &[OwnedFile],
        provenance: &RuntimePackageProvenance,
        override_directory: Option<&Path>,
    ) -> Result<(Self, RepairPlan), String> {
        let paths = source_paths(provenance, override_directory)?;
        let needed = missing_packages(root, owned, provenance)?;
        let mut assets = vec![];
        let mut files = vec![];
        for (original, path) in provenance.source_artifacts.iter().zip(paths) {
            let (package, _, _) = npm_origin(original)?;
            if !needed.contains(package) {
                continue;
            }
            let mut binding = original.clone();
            binding.path = path;
            let(inventory,metadata)=tgz::inspect_recorded(&binding).map_err(|e|format!("原版依赖包 {} 不可用：{e}；请选择相同原资产目录，不会下载最新版本或覆盖现有文件",binding.path.display()))?;
            for (name, version) in &metadata.dependencies {
                if !provenance
                    .source_artifacts
                    .iter()
                    .any(|a| npm_origin(a).is_ok_and(|(p, v, _)| p == name && v == version))
                {
                    return Err("原 npm 包内依赖与安装时固定闭包不同".into());
                }
            }
            binding.file = inventory.archive.clone();
            for file in &inventory.files {
                files.push(PackageFile {
                    path: format!("node_modules/{package}/{}", file.path),
                    bytes: file.bytes,
                    license: file.license,
                });
            }
            assets.push(Asset {
                binding,
                inventory,
                metadata,
            });
        }
        let source = Self {
            provenance: provenance.clone(),
            assets,
        };
        let plan = resource_files::preview_repair_files(root, owned, &files)?;
        source.verify(&plan)?;
        Ok((source, plan))
    }
    pub(crate) fn paths(&self) -> Vec<PathBuf> {
        self.assets.iter().map(|a| a.binding.path.clone()).collect()
    }
    pub(crate) fn public_source(&self) -> Result<Value, String> {
        Ok(
            json!({"repository":self.provenance.source_repository()?,"version":self.provenance.version,"verification":"npmIntegrity","recipe":self.provenance.recipe,"planHash":self.provenance.plan_hash,"artifacts":self.assets.iter().map(|a|&a.binding).collect::<Vec<_>>()}),
        )
    }
    pub(crate) fn matches(&self, provenance: &RuntimePackageProvenance) -> Result<(), String> {
        if serde_json::to_value(&self.provenance).map_err(|e| e.to_string())?
            != serde_json::to_value(provenance).map_err(|e| e.to_string())?
        {
            return Err("原 npm 版本、来源或安装闭包已变化，请重新预览修复".into());
        }
        Ok(())
    }
    fn payload<'a>(&'a self, path: &str) -> Result<(&'a Asset, &'a tgz::TarFile), String> {
        for asset in &self.assets {
            if let Some(relative) = package_relative(path, &asset.metadata.package) {
                return asset
                    .inventory
                    .files
                    .iter()
                    .find(|f| f.path == relative)
                    .map(|f| (asset, f))
                    .ok_or_else(|| format!("原 npm 包缺少已登记文件：{path}"));
            }
        }
        Err(format!("未绑定缺失文件的原 npm 资产：{path}"))
    }
    pub(crate) fn verify(&self, plan: &RepairPlan) -> Result<(), String> {
        self.provenance.validate_source()?;
        for asset in &self.assets {
            if resource_files::fingerprint(&asset.binding.path)? != asset.binding.file {
                return Err("修复预览后原 npm 资产发生变化".into());
            }
            if asset.inventory.archive != asset.binding.file
                || !self.provenance.source_artifacts.iter().any(|original| {
                    original.file.sha256 == asset.binding.file.sha256
                        && original.file.bytes == asset.binding.file.bytes
                        && serde_json::to_value(&original.origin).ok()
                            == serde_json::to_value(&asset.binding.origin).ok()
                })
            {
                return Err("修复资产不是原安装的精确字节来源".into());
            }
        }
        for entry in plan.entries.iter().filter(|e| e.decision == "restore") {
            let (_, payload) = self.payload(&entry.path)?;
            if !eligible(&entry.role)
                || entry.expected.is_some()
                || entry.installed_sha256 != payload.sha256
                || entry.bytes != payload.bytes
            {
                return Err("缺失文件与原归属摘要、长度或可修复用途不一致".into());
            }
        }
        resource_files::verify_repair_scope(plan)
    }
    pub(crate) fn apply(&self, plan: &RepairPlan) -> Result<RepairReceipt, String> {
        self.verify(plan)?;
        let mut receipt = RepairReceipt {
            restored: vec![],
            retained: plan
                .entries
                .iter()
                .filter(|e| e.decision == "preserve")
                .map(|e| e.target.clone())
                .collect(),
            failures: vec![],
            temporary_paths: vec![],
        };
        for asset in &self.assets {
            let entries: Vec<_> = plan
                .entries
                .iter()
                .filter(|e| {
                    e.decision == "restore"
                        && package_relative(&e.path, &asset.metadata.package).is_some()
                })
                .collect();
            if entries.is_empty() {
                continue;
            }
            let targets = entries
                .iter()
                .map(|e| {
                    Ok((
                        package_relative(&e.path, &asset.metadata.package)
                            .ok_or("修复条目包路径无效")?
                            .to_owned(),
                        e.temporary_path.clone().ok_or("修复预览缺少新候选位置")?,
                    ))
                })
                .collect::<Result<BTreeMap<_, _>, String>>()?;
            let result = (|| {
                tgz::read_selected(&asset.binding, &asset.inventory, &targets)?;
                for entry in &entries {
                    crate::network::check_cancelled()?;
                    if crate::clients::file_identity(&plan.root)? != plan.root_identity {
                        return Err("修复期间原运行目录被替换，未继续发布".into());
                    }
                    let target = crate::local::safe_join(&plan.root, &entry.path)?;
                    if target != entry.target || fs::symlink_metadata(&target).is_ok() {
                        return Err("修复目标出现现有内容，未覆盖".into());
                    }
                    let temporary = entry.temporary_path.as_ref().ok_or("修复候选位置缺失")?;
                    if temporary.parent() != Some(plan.root.as_path()) {
                        return Err("修复候选位置不在原运行目录".into());
                    }
                    let actual = resource_files::fingerprint(temporary)?;
                    if actual.bytes != entry.bytes || actual.sha256 != entry.installed_sha256 {
                        return Err("修复候选字节与原安装摘要不同，未提交".into());
                    }
                    let parent = target.parent().ok_or("修复目标缺少父目录")?;
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                    crate::transaction::verify_root(parent)?;
                    resource_files::publish_repaired(temporary, &target)?;
                    if resource_files::fingerprint(&target)?.sha256 != entry.installed_sha256 {
                        return Err("修复发布后目标变化，请核对".into());
                    }
                    receipt.restored.push(target);
                }
                if resource_files::fingerprint(&asset.binding.path)? != asset.inventory.archive {
                    return Err("修复过程中原 npm 资产变化".into());
                }
                Ok(())
            })();
            for temporary in targets.values() {
                if temporary.try_exists().unwrap_or(true)
                    && !receipt.temporary_paths.contains(temporary)
                {
                    receipt.temporary_paths.push(temporary.clone());
                }
            }
            if let Err(error) = result {
                receipt.failures.push((plan.root.clone(), error));
                break;
            }
        }
        for entry in plan.entries.iter().filter(|e| e.decision == "restore") {
            if !receipt.restored.contains(&entry.target)
                && !receipt.failures.iter().any(|(p, _)| p == &entry.target)
            {
                receipt
                    .failures
                    .push((entry.target.clone(), "前序条目失败，本次尚未补齐".into()));
            }
        }
        Ok(receipt)
    }
}

#[cfg(test)]
#[path = "repair/tests.rs"]
pub(crate) mod tests;
