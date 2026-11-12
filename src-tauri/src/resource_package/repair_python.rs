//! Restore original wheel bytes and exact bound Python files, never reinstall
//! into an existing environment or relocate generated console launchers.
use super::*;
use crate::resource_files::{FileRole, OwnedFile, PackageFile, RepairPlan, RepairReceipt};
use std::{fs, fs::OpenOptions, io::Write};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Asset {
    binding: ArtifactBinding,
    inspection: WheelInspection,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum PayloadSource {
    Wheel { asset: usize, path: String },
    PythonFile { path: PathBuf, file: Fingerprint },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Payload {
    target: String,
    bytes: u64,
    sha256: String,
    source: PayloadSource,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PythonRepairSource {
    provenance: RuntimePackageProvenance,
    assets: Vec<Asset>,
    payloads: Vec<Payload>,
}
fn eligible(role: &FileRole) -> bool {
    matches!(
        role,
        FileRole::Runtime | FileRole::PrivateDependency | FileRole::License
    )
}
fn python(provenance: &RuntimePackageProvenance) -> Result<&PipRuntime, String> {
    provenance.validate_source()?;
    match (&provenance.recipe, &provenance.runtime) {
        (Recipe::AgentReachWheelV1, BuilderRuntime::PythonPip(runtime)) => Ok(runtime),
        _ => Err("原安装不是已核对的 Agent Reach wheel 配方".into()),
    }
}
fn wheel_paths(
    provenance: &RuntimePackageProvenance,
    directory: Option<&Path>,
) -> Result<Vec<PathBuf>, String> {
    python(provenance)?;
    let directory = directory
        .map(|path| {
            if !path.is_absolute() || !path.is_dir() {
                return Err("原 wheel 资产目录必须是现有的绝对目录".into());
            }
            crate::transaction::verify_root(path)?;
            crate::local::canonical(path)
        })
        .transpose()?;
    provenance
        .source_artifacts
        .iter()
        .map(|artifact| {
            let filename = match &artifact.origin {
                ArtifactOrigin::GithubRelease { source } => &source.asset_name,
                ArtifactOrigin::PyPiWheel { filename, .. } => filename,
                _ => return Err("原 Python 安装含不同配方资产".into()),
            };
            crate::local::validate_relative_path(filename)?;
            if filename.contains(['/', '\\']) || !filename.ends_with(".whl") {
                return Err("原 wheel 资产文件名无效".into());
            }
            let path = directory
                .as_ref()
                .map(|p| p.join(filename))
                .unwrap_or_else(|| artifact.path.clone());
            if !path.is_absolute() {
                return Err("原 wheel 资产路径必须是绝对路径".into());
            }
            crate::transaction::verify_root(&path)?;
            Ok(path)
        })
        .collect()
}
fn redirectors(runtime: &PipRuntime, target: &str) -> Result<Vec<PathBuf>, String> {
    let (name, fallback) = match target {
        "Scripts/python.exe" => ("python.exe", "venvlauncher.exe"),
        "Scripts/pythonw.exe" => ("pythonw.exe", "venvwlauncher.exe"),
        "Scripts/python_d.exe" => ("python_d.exe", "venvlauncher_d.exe"),
        "Scripts/pythonw_d.exe" => ("pythonw_d.exe", "venvwlauncher_d.exe"),
        _ => return Ok(vec![]),
    };
    let root = runtime
        .interpreter
        .path
        .parent()
        .ok_or("原 Python 入口没有父目录")?;
    Ok(vec![
        root.join("Lib/venv/scripts/nt").join(name),
        root.join(fallback),
    ])
}
/// Read-lock inputs are resolved by the same exact-origin rules as preview.
/// Missing unrelated cached wheels do not become required repair payloads.
pub(crate) fn source_paths(
    provenance: &RuntimePackageProvenance,
    directory: Option<&Path>,
) -> Result<Vec<PathBuf>, String> {
    let runtime = python(provenance)?;
    let mut paths = wheel_paths(provenance, directory)?;
    paths.push(runtime.interpreter.path.clone());
    paths.push(runtime.python_license.clone());
    for target in [
        "Scripts/python.exe",
        "Scripts/pythonw.exe",
        "Scripts/python_d.exe",
        "Scripts/pythonw_d.exe",
    ] {
        paths.extend(redirectors(runtime, target)?);
    }
    Ok(paths)
}
fn destination(path: &str) -> Result<Option<String>, String> {
    crate::local::validate_relative_path(path)?;
    let (first, rest) = path.split_once('/').unwrap_or((path, ""));
    let relative = if first.ends_with(".data") {
        let Some((scheme, relative)) = rest.split_once('/') else {
            return Ok(None);
        };
        if !matches!(scheme, "purelib" | "platlib") {
            return Ok(None);
        }
        relative
    } else {
        path
    };
    if relative.is_empty() {
        return Ok(None);
    }
    crate::local::validate_relative_path(relative)?;
    Ok(Some(format!("Lib/site-packages/{relative}")))
}
fn stream(
    input: &mut impl Read,
    maximum: u64,
    mut output: Option<&mut File>,
) -> Result<String, String> {
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        crate::network::check_cancelled()?;
        let read = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        bytes = bytes.checked_add(read as u64).ok_or("修复字节长度溢出")?;
        if bytes > maximum {
            return Err("修复载荷超过原字节范围".into());
        }
        hash.update(&buffer[..read]);
        if let Some(file) = &mut output {
            file.write_all(&buffer[..read]).map_err(|e| e.to_string())?
        }
    }
    if bytes != maximum {
        return Err("修复载荷长度与原记录不同".into());
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn inspect_asset(
    binding: ArtifactBinding,
    provenance: &RuntimePackageProvenance,
) -> Result<Asset, String> {
    let actual = resource_files::fingerprint(&binding.path)?;
    if actual.bytes != binding.file.bytes || actual.sha256 != binding.file.sha256 {
        return Err("原 wheel 与安装时的精确大小或 SHA256 不同".into());
    }
    let inspection = inspect_wheel(&binding.path)?;
    let expected = match &binding.origin {
        ArtifactOrigin::GithubRelease { .. } => ("agent-reach", provenance.version.as_str()),
        ArtifactOrigin::PyPiWheel {
            package, version, ..
        } => (package.as_str(), version.as_str()),
        _ => return Err("修复源不是原 wheel 来源".into()),
    };
    if (inspection.package.as_str(), inspection.version.as_str()) != expected {
        return Err("原 wheel 包名、版本与已登记来源不同".into());
    }
    let mut binding = binding;
    binding.file = inspection.inventory.archive.clone();
    Ok(Asset {
        binding,
        inspection,
    })
}
fn missing(root: &Path, owned: &[OwnedFile]) -> Result<BTreeMap<String, String>, String> {
    let mut result = BTreeMap::new();
    for item in owned.iter().filter(|f| eligible(&f.role)) {
        let path = crate::local::safe_join(root, &item.path)?;
        match fs::symlink_metadata(&path) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if result
                    .insert(item.path.clone(), item.installed_sha256.clone())
                    .is_some()
                {
                    return Err("原归属清单路径重复".into());
                }
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(result)
}
fn unavailable(path: &str) -> String {
    let reason = if path == "pyvenv.cfg" {
        "该文件含原最终路径及 Python 配置，原回执未保存可逐字重建的生成输入"
    } else if path.starts_with("Scripts/") && path.ends_with(".exe") {
        "该入口由原 pip/venv 生成，不能从其他环境复制；没有与原安装 SHA256 一致的可信候选"
    } else if path.ends_with(".dist-info/RECORD") || path.ends_with(".dist-info/direct_url.json") {
        "该元数据在原安装时生成或改写，wheel 原字节不能代替原安装字节"
    } else {
        "原精确 wheel 或已绑定 Python 文件中未找到与原安装 SHA256 一致的载荷"
    };
    format!("无法可靠修复缺失文件 {path}：{reason}；本次未写入任何文件")
}
impl PythonRepairSource {
    pub(crate) fn prepare(
        root: &Path,
        owned: &[OwnedFile],
        provenance: &RuntimePackageProvenance,
        directory: Option<&Path>,
    ) -> Result<(Self, RepairPlan), String> {
        let runtime = python(provenance)?;
        let needed = missing(root, owned)?;
        let paths = wheel_paths(provenance, directory)?;
        let mut result = Self {
            provenance: provenance.clone(),
            assets: vec![],
            payloads: vec![],
        };
        let mut problems = BTreeMap::new();
        let mut unavailable_assets = Vec::new();
        for (original, path) in provenance.source_artifacts.iter().zip(paths) {
            crate::network::check_cancelled()?;
            if !needed.keys().any(|p| p.starts_with("Lib/site-packages/")) {
                break;
            }
            if !path.try_exists().map_err(|e| e.to_string())? {
                continue;
            }
            let mut binding = original.clone();
            binding.path = path;
            let asset = match inspect_asset(binding, provenance) {
                Ok(asset) => asset,
                Err(error) => {
                    crate::network::check_cancelled()?;
                    unavailable_assets.push(error);
                    continue;
                }
            };
            let mut selected = Vec::new();
            let mut archive =
                zip::ZipArchive::new(File::open(&asset.binding.path).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            for file in &asset.inspection.inventory.files {
                let Some(target) = destination(&file.path)? else {
                    continue;
                };
                let Some(expected) = needed.get(&target) else {
                    continue;
                };
                let mut input = archive.by_name(&file.path).map_err(|e| e.to_string())?;
                let sha256 = stream(&mut input, file.bytes, None)?;
                if &sha256 != expected {
                    problems.insert(target.clone(), unavailable(&target));
                    continue;
                }
                if result.payloads.iter().any(|p| p.target == target)
                    || selected.iter().any(|p: &Payload| p.target == target)
                {
                    return Err(format!(
                        "多个原 wheel 映射同一缺失文件，不猜测来源：{target}"
                    ));
                }
                selected.push(Payload {
                    target,
                    bytes: file.bytes,
                    sha256,
                    source: PayloadSource::Wheel {
                        asset: result.assets.len(),
                        path: file.path.clone(),
                    },
                });
            }
            if !selected.is_empty() {
                if resource_files::fingerprint(&asset.binding.path)? != asset.binding.file {
                    return Err("原 wheel 在预览期间发生变化".into());
                }
                result.payloads.extend(selected);
                result.assets.push(asset);
            }
        }
        for (path, expected) in &needed {
            crate::network::check_cancelled()?;
            if result.payloads.iter().any(|p| &p.target == path) {
                continue;
            }
            let candidates = if path == "licenses/Python-LICENSE.txt" {
                vec![runtime.python_license.clone()]
            } else {
                let candidates = redirectors(runtime, path)?;
                if !candidates.is_empty() {
                    runtime.interpreter.recheck()?
                }
                candidates
            };
            for source in candidates {
                if !source.try_exists().map_err(|e| e.to_string())? {
                    continue;
                }
                let file = resource_files::fingerprint(&source)?;
                let original_license = path != "licenses/Python-LICENSE.txt"
                    || (file.bytes == runtime.python_license_file.bytes
                        && file.sha256 == runtime.python_license_file.sha256);
                if file.sha256 == *expected && original_license {
                    result.payloads.push(Payload {
                        target: path.clone(),
                        bytes: file.bytes,
                        sha256: file.sha256.clone(),
                        source: PayloadSource::PythonFile { path: source, file },
                    });
                    break;
                }
            }
        }
        let unresolved: Vec<_> = needed
            .keys()
            .filter(|path| !result.payloads.iter().any(|p| &p.target == *path))
            .map(|path| problems.remove(path).unwrap_or_else(|| unavailable(path)))
            .collect();
        if !unresolved.is_empty() {
            let mut error = unresolved.join("\n");
            if !unavailable_assets.is_empty() {
                error.push_str(&format!(
                    "\n原资产读取问题：{}",
                    unavailable_assets.join("；")
                ))
            }
            return Err(error);
        }
        let files = result
            .payloads
            .iter()
            .map(|p| PackageFile {
                path: p.target.clone(),
                bytes: p.bytes,
                license: crate::local::license_path(&p.target),
            })
            .collect::<Vec<_>>();
        let plan = resource_files::preview_repair_files(root, owned, &files)?;
        result.verify(&plan)?;
        Ok((result, plan))
    }
    pub(crate) fn paths(&self) -> Vec<PathBuf> {
        let mut result: Vec<_> = self.assets.iter().map(|a| a.binding.path.clone()).collect();
        for payload in &self.payloads {
            if let PayloadSource::PythonFile { path, .. } = &payload.source {
                if !result.contains(path) {
                    result.push(path.clone())
                }
            }
        }
        if self.payloads.iter().any(|p| {
            matches!(&p.source, PayloadSource::PythonFile { .. })
                && p.target.starts_with("Scripts/")
        }) {
            result.push(self.provenance.shared_runtime_binding().path.clone());
        }
        result
    }
    pub(crate) fn public_source(&self) -> Result<Value, String> {
        let runtime_files: Vec<_> = self
            .payloads
            .iter()
            .filter_map(|p| match &p.source {
                PayloadSource::PythonFile { path, file } => Some(
                    json!({"path":path,"target":p.target,"bytes":file.bytes,"sha256":file.sha256}),
                ),
                _ => None,
            })
            .collect();
        Ok(
            json!({"repository":self.provenance.source_repository()?,"version":self.provenance.version,"verification":"wheelRecord","recipe":self.provenance.recipe,"planHash":self.provenance.plan_hash,"artifacts":self.assets.iter().map(|a|&a.binding).collect::<Vec<_>>(),"runtimeFiles":runtime_files}),
        )
    }
    pub(crate) fn matches(&self, provenance: &RuntimePackageProvenance) -> Result<(), String> {
        if serde_json::to_value(&self.provenance).map_err(|e| e.to_string())?
            != serde_json::to_value(provenance).map_err(|e| e.to_string())?
        {
            return Err("原 Python 版本、来源或运行闭包已变化，请重新预览修复".into());
        }
        Ok(())
    }
    pub(crate) fn verify(&self, plan: &RepairPlan) -> Result<(), String> {
        let runtime = python(&self.provenance)?;
        for asset in &self.assets {
            if resource_files::fingerprint(&asset.binding.path)? != asset.binding.file
                || !self.provenance.source_artifacts.iter().any(|original| {
                    original.file.bytes == asset.binding.file.bytes
                        && original.file.sha256 == asset.binding.file.sha256
                        && serde_json::to_value(&original.origin).ok()
                            == serde_json::to_value(&asset.binding.origin).ok()
                })
            {
                return Err("修复原 wheel 的字节或来源发生变化".into());
            }
        }
        for entry in plan.entries.iter().filter(|e| e.decision == "restore") {
            let payload = self
                .payloads
                .iter()
                .find(|p| p.target == entry.path)
                .ok_or("缺失文件的精确载荷未绑定")?;
            if !eligible(&entry.role)
                || entry.expected.is_some()
                || payload.bytes != entry.bytes
                || payload.sha256 != entry.installed_sha256
            {
                return Err("修复载荷与原归属摘要、长度或用途不同".into());
            }
            match &payload.source {
                PayloadSource::Wheel { asset, path } => {
                    let asset = self.assets.get(*asset).ok_or("wheel 修复来源索引无效")?;
                    if destination(path)?.as_deref() != Some(entry.path.as_str())
                        || !asset
                            .inspection
                            .inventory
                            .files
                            .iter()
                            .any(|f| &f.path == path && f.bytes == entry.bytes)
                    {
                        return Err("原 wheel 路径映射与预览不同".into());
                    }
                }
                PayloadSource::PythonFile { path, file } => {
                    let valid = if entry.path == "licenses/Python-LICENSE.txt" {
                        path == &runtime.python_license
                            && file.sha256 == runtime.python_license_file.sha256
                            && file.bytes == runtime.python_license_file.bytes
                    } else {
                        runtime.interpreter.recheck()?;
                        redirectors(runtime, &entry.path)?.contains(path)
                    };
                    if !valid
                        || resource_files::fingerprint(path)? != *file
                        || file.sha256 != payload.sha256
                        || file.bytes != payload.bytes
                    {
                        return Err("原 Python 许可或 redirector 候选与预览不同".into());
                    }
                }
            }
        }
        resource_files::verify_repair_scope(plan)
    }
    pub(crate) fn apply(&self, plan: &RepairPlan) -> Result<RepairReceipt, String> {
        self.verify(plan)?;
        // Validate every needed archive before creating the first candidate.
        for asset in &self.assets {
            inspect_asset(asset.binding.clone(), &self.provenance)?;
        }
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
        for entry in plan.entries.iter().filter(|e| e.decision == "restore") {
            let result = (|| {
                crate::network::check_cancelled()?;
                let payload = self
                    .payloads
                    .iter()
                    .find(|p| p.target == entry.path)
                    .ok_or("缺失文件的精确载荷未绑定")?;
                let temporary = entry
                    .temporary_path
                    .as_ref()
                    .ok_or("修复预览缺少候选位置")?;
                if crate::clients::file_identity(&plan.root)? != plan.root_identity
                    || temporary.parent() != Some(plan.root.as_path())
                {
                    return Err("原目录或修复候选位置已变化，未写入".into());
                }
                crate::transaction::verify_root(temporary)?;
                let mut output = OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(temporary)
                    .map_err(|e| e.to_string())?;
                receipt.temporary_paths.push(temporary.clone());
                let hash = match &payload.source {
                    PayloadSource::Wheel { asset, path } => {
                        let asset = &self.assets[*asset];
                        if resource_files::fingerprint(&asset.binding.path)? != asset.binding.file {
                            return Err("原 wheel 在应用期间发生变化".into());
                        }
                        let mut archive = zip::ZipArchive::new(
                            File::open(&asset.binding.path).map_err(|e| e.to_string())?,
                        )
                        .map_err(|e| e.to_string())?;
                        let mut input = archive.by_name(path).map_err(|e| e.to_string())?;
                        stream(&mut input, entry.bytes, Some(&mut output))?
                    }
                    PayloadSource::PythonFile { path, file } => {
                        if resource_files::fingerprint(path)? != *file {
                            return Err("Python 原文件在应用期间发生变化".into());
                        }
                        let mut input = File::open(path).map_err(|e| e.to_string())?;
                        stream(&mut input, entry.bytes, Some(&mut output))?
                    }
                };
                output.sync_all().map_err(|e| e.to_string())?;
                drop(output);
                let actual = resource_files::fingerprint(temporary)?;
                if hash != entry.installed_sha256
                    || actual.sha256 != entry.installed_sha256
                    || actual.bytes != entry.bytes
                {
                    return Err("修复候选与原安装字节不同，未发布".into());
                }
                match &payload.source {
                    PayloadSource::Wheel { asset, .. } => {
                        let asset = &self.assets[*asset];
                        if resource_files::fingerprint(&asset.binding.path)? != asset.binding.file {
                            return Err("原 wheel 在读取期间发生变化，未发布".into());
                        }
                    }
                    PayloadSource::PythonFile { path, file } => {
                        if resource_files::fingerprint(path)? != *file {
                            return Err("原 Python 文件在读取期间发生变化，未发布".into());
                        }
                        if entry.path.starts_with("Scripts/") {
                            self.provenance.shared_runtime_binding().recheck()?;
                        }
                    }
                }
                if crate::clients::file_identity(&plan.root)? != plan.root_identity {
                    return Err("原运行目录在修复期间被替换，未发布".into());
                }
                let target = crate::local::safe_join(&plan.root, &entry.path)?;
                if target != entry.target || target.try_exists().map_err(|e| e.to_string())? {
                    return Err("修复目标已有内容，未覆盖".into());
                }
                let parent = target.parent().ok_or("修复目标没有父目录")?;
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                crate::transaction::verify_root(parent)?;
                resource_files::publish_repaired(temporary, &target)?;
                if !temporary.try_exists().map_err(|e| e.to_string())? {
                    receipt.temporary_paths.retain(|p| p != temporary)
                }
                if resource_files::fingerprint(&target)?.sha256 != entry.installed_sha256 {
                    return Err("修复目标发布后变化，请核对".into());
                }
                receipt.restored.push(target);
                Ok(())
            })();
            if let Err(error) = result {
                receipt.failures.push((entry.target.clone(), error));
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
#[path = "repair_python/tests.rs"]
mod tests;
