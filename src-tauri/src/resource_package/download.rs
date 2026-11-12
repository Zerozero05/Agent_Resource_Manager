//! Fixed package artifacts share transport limits with other manager work.
//! A cancellation returns its actual partial file. Resuming is explicit and
//! rechecks that file and the immutable digest; no operation is replayed on read.
use super::*;
use std::{
    fs::OpenOptions,
    io::Write,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteArtifact {
    package: String,
    filename: String,
    url: String,
    bytes: Option<u64>,
    sha256: Option<String>,
    sha512: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackageDownloadPlan {
    recipe: Recipe,
    directory: PathBuf,
    directory_identity: String,
    bytes_per_second: u64,
    artifacts: Vec<RemoteArtifact>,
    plan_hash: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Transfer {
    package: String,
    target: PathBuf,
    partial: Option<PathBuf>,
    observed: Option<Fingerprint>,
    #[serde(default)]
    file_identity: Option<String>,
    etag: Option<String>,
    complete: bool,
    created: bool,
    error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackageDownloadReceipt {
    plan: PackageDownloadPlan,
    transfers: Vec<Transfer>,
    pub complete: bool,
}
impl PackageDownloadPlan {
    fn new(
        recipe: Recipe,
        directory: &Path,
        bytes_per_second: u64,
        artifacts: Vec<RemoteArtifact>,
    ) -> Result<Self, String> {
        if bytes_per_second != 0 && !(1024..=1024 * 1024 * 1024).contains(&bytes_per_second) {
            return Err("依赖下载限速范围无效".into());
        }
        crate::transaction::verify_root(directory)?;
        if !directory.is_dir() {
            return Err("请选择已有的依赖下载保存目录".into());
        }
        let directory = crate::local::canonical(directory)?;
        let directory_identity = crate::clients::file_identity(&directory)?;
        let mut names = BTreeSet::new();
        if artifacts.len() > 128 {
            return Err("依赖资产数超出有限范围".into());
        }
        for artifact in &artifacts {
            crate::local::validate_relative_path(&artifact.filename)?;
            if artifact.filename.contains(['/', '\\'])
                || !names.insert(artifact.filename.to_lowercase())
            {
                return Err("依赖资产文件名重复或含目录".into());
            }
            match recipe {
                Recipe::AgentReachWheelV1 => {
                    pypi_url(&artifact.url)?;
                    if artifact
                        .sha256
                        .as_ref()
                        .is_none_or(|h| h.len() != 64 || !h.bytes().all(|b| b.is_ascii_hexdigit()))
                        || !artifact.filename.ends_with(".whl")
                    {
                        return Err("Python 依赖缺少固定官方 wheel 摘要".into());
                    }
                }
                Recipe::EdgeMcpNpmV1 => {
                    npm_url(&artifact.url)?;
                    sri512(artifact.sha512.as_deref().ok_or("npm 依赖缺少 integrity")?)?;
                    if !artifact.filename.ends_with(".tgz") {
                        return Err("npm 依赖不是固定 tgz".into());
                    }
                }
            }
        }
        let plan_hash = sha256(&serde_json::to_vec(&json!({"recipe":recipe,"directory":directory,"identity":directory_identity,"rate":bytes_per_second,"artifacts":artifacts})).map_err(|e|e.to_string())?);
        Ok(Self {
            recipe,
            directory,
            directory_identity,
            bytes_per_second,
            artifacts,
            plan_hash,
        })
    }
    pub(crate) fn reach(
        resolution: &ReachResolution,
        directory: &Path,
        rate: u64,
    ) -> Result<Self, String> {
        Self::new(
            Recipe::AgentReachWheelV1,
            directory,
            rate,
            resolution
                .dependencies
                .iter()
                .map(|d| RemoteArtifact {
                    package: d.package.clone(),
                    filename: d.filename.clone(),
                    url: d.url.clone(),
                    bytes: Some(d.bytes),
                    sha256: Some(d.sha256.clone()),
                    sha512: None,
                })
                .collect(),
        )
    }
    pub(crate) fn edge(closure: &NpmClosure, directory: &Path, rate: u64) -> Result<Self, String> {
        let artifacts = closure
            .packages
            .iter()
            .map(|package| {
                let url = npm_url(&package.tarball)?;
                let filename = url
                    .path_segments()
                    .and_then(|mut parts| parts.next_back())
                    .ok_or("npm 资产名称缺失")?;
                Ok(RemoteArtifact {
                    package: package.package.clone(),
                    filename: filename.into(),
                    url: package.tarball.clone(),
                    bytes: None,
                    sha256: None,
                    sha512: Some(package.integrity.clone()),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Self::new(Recipe::EdgeMcpNpmV1, directory, rate, artifacts)
    }
    fn recheck(&self) -> Result<(), String> {
        let checked = Self::new(
            self.recipe.clone(),
            &self.directory,
            self.bytes_per_second,
            self.artifacts.clone(),
        )?;
        if checked.directory_identity != self.directory_identity
            || checked.plan_hash != self.plan_hash
        {
            return Err("依赖下载保存目录已被替换".into());
        }
        Ok(())
    }
    pub(crate) fn preview(&self) -> Value {
        let known = self
            .artifacts
            .iter()
            .all(|artifact| artifact.bytes.is_some());
        json!({"kind":"runtimePackageDownload","recipe":self.recipe,"directory":self.directory,"bytesPerSecond":self.bytes_per_second,"artifacts":self.artifacts,"downloadBytes":known.then(||self.artifacts.iter().filter_map(|a|a.bytes).sum::<u64>()),"maximumArtifactBytes":MAX_ARCHIVE,"planHash":self.plan_hash,"canApply":true,"installsFiles":false,"executesCode":false,"warning":"本步只下载已选择的精确资产；包内文件范围在校验后再预览，不把未知下载量记为零。"})
    }
    #[cfg(test)]
    pub(crate) fn apply(self) -> Result<PackageDownloadReceipt, String> {
        self.apply_with_checkpoint(|_| Ok(()))
    }
    pub(crate) fn apply_with_checkpoint(
        self,
        mut checkpoint: impl FnMut(&PackageDownloadReceipt) -> Result<(), String>,
    ) -> Result<PackageDownloadReceipt, String> {
        self.transfer(None, &mut checkpoint)
    }
    fn transfer(
        self,
        previous: Option<PackageDownloadReceipt>,
        checkpoint: &mut dyn FnMut(&PackageDownloadReceipt) -> Result<(), String>,
    ) -> Result<PackageDownloadReceipt, String> {
        self.recheck()?;
        let mut rows = previous.map(|p| p.transfers).unwrap_or_default();
        checkpoint(&PackageDownloadReceipt {
            plan: self.clone(),
            transfers: rows.clone(),
            complete: false,
        })?;
        for (index, artifact) in self.artifacts.iter().enumerate() {
            crate::tasks::report_progress(
                "下载并核对运行依赖",
                Some(index),
                Some(self.artifacts.len()),
            );
            let previous = rows
                .iter()
                .position(|row| row.package == artifact.package)
                .map(|i| rows.remove(i));
            let row = one(&self, artifact, previous, &mut |row| {
                let mut transfers = rows.clone();
                transfers.push(row.clone());
                checkpoint(&PackageDownloadReceipt {
                    plan: self.clone(),
                    transfers,
                    complete: false,
                })
            });
            let complete = row.complete;
            rows.push(row);
            let receipt = PackageDownloadReceipt {
                plan: self.clone(),
                transfers: rows.clone(),
                complete: complete && rows.len() == self.artifacts.len(),
            };
            checkpoint(&receipt)?;
            if !complete {
                return Ok(PackageDownloadReceipt {
                    plan: self,
                    transfers: rows,
                    complete: false,
                });
            }
        }
        Ok(PackageDownloadReceipt {
            plan: self,
            transfers: rows,
            complete: true,
        })
    }
}
impl PackageDownloadReceipt {
    pub(crate) fn files(&self) -> Result<BTreeMap<String, PathBuf>, String> {
        if !self.complete || self.transfers.len() != self.plan.artifacts.len() {
            return Err("依赖下载尚未完整完成".into());
        }
        let mut result = BTreeMap::new();
        for artifact in &self.plan.artifacts {
            let row = self
                .transfers
                .iter()
                .find(|row| row.package == artifact.package && row.complete)
                .ok_or("依赖回执不完整")?;
            verify(&row.target, artifact)?;
            if Some(resource_files::fingerprint(&row.target)?) != row.observed {
                return Err("已下载依赖发生变化，需重新核对".into());
            }
            result.insert(artifact.package.clone(), row.target.clone());
        }
        Ok(result)
    }
    pub(crate) fn preview_resume(&self) -> Result<Value, String> {
        self.plan.recheck()?;
        let mut actual_transfers = self.transfers.clone();
        let mut recovered_tail_bytes = 0u64;
        for row in &mut actual_transfers {
            let artifact = self
                .plan
                .artifacts
                .iter()
                .find(|a| a.package == row.package)
                .ok_or("下载事实包含未选择的资产")?;
            if row.target != self.plan.directory.join(&artifact.filename)
                || row
                    .partial
                    .as_ref()
                    .is_some_and(|p| p.parent() != Some(self.plan.directory.as_path()))
            {
                return Err("下载事实保存位置与原计划不同".into());
            }
            if !row.complete
                && row.partial.as_ref().is_some_and(|p| !p.exists())
                && row.target.exists()
            {
                let same_object = row.file_identity.as_ref().is_some_and(|id| {
                    crate::clients::file_identity(&row.target).ok().as_ref() == Some(id)
                });
                if !same_object {
                    return Err("原部分文件已消失且目标身份不同，未收为已创建资产".into());
                }
                verify(&row.target, artifact)?;
                row.observed = Some(resource_files::fingerprint(&row.target)?);
                row.complete = true;
            }
            if !row.created
                && row.observed.is_none()
                && !row.target.exists()
                && row.partial.as_ref().is_none_or(|p| !p.exists())
            {
                continue;
            }
            let path = if row.complete {
                &row.target
            } else {
                row.partial.as_ref().ok_or("没有可续传的部分文件")?
            };
            let actual = resume_observation(row, path)?;
            recovered_tail_bytes += actual
                .bytes
                .saturating_sub(row.observed.as_ref().map_or(0, |v| v.bytes));
            row.observed = Some(actual);
        }
        Ok(
            json!({"kind":"runtimePackageResume","plan":self.plan.preview(),"transfers":actual_transfers,"recoveredTailBytes":recovered_tail_bytes,"willTruncate":false,"canApply":true,"willReplayInstall":false}),
        )
    }
    #[cfg(test)]
    pub(crate) fn resume(self) -> Result<Self, String> {
        self.resume_with_checkpoint(|_| Ok(()))
    }
    pub(crate) fn resume_with_checkpoint(
        self,
        mut checkpoint: impl FnMut(&Self) -> Result<(), String>,
    ) -> Result<Self, String> {
        self.preview_resume()?;
        self.plan.clone().transfer(Some(self), &mut checkpoint)
    }
}

/// An interrupted process may leave bytes after its last durable checkpoint.
/// Adopt that append-only tail only after checking the same file object and the
/// entire saved prefix; the final immutable artifact digest is still mandatory.
fn resume_observation(row: &Transfer, path: &Path) -> Result<Fingerprint, String> {
    let actual = resource_files::fingerprint(path)?;
    let expected = row
        .observed
        .as_ref()
        .ok_or("部分文件尚无可核对的持久检查点")?;
    if let Some(identity) = &row.file_identity {
        if crate::clients::file_identity(path)? != *identity {
            return Err("部分文件对象已被替换，不沿用续传范围".into());
        }
    }
    if actual == *expected {
        return Ok(actual);
    }
    if row.complete
        || row.file_identity.is_none()
        || actual.bytes <= expected.bytes
        || actual.bytes > MAX_ARCHIVE
    {
        return Err("下载文件已变化，不沿用原续传范围".into());
    }
    let mut input = File::open(path).map_err(|e| e.to_string())?;
    let mut remaining = expected.bytes;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    while remaining > 0 {
        crate::network::check_cancelled()?;
        let count = input
            .read(&mut buffer[..remaining.min(64 * 1024) as usize])
            .map_err(|e| e.to_string())?;
        if count == 0 {
            return Err("持久检查点前缀变短，未续传".into());
        }
        hash.update(&buffer[..count]);
        remaining -= count as u64;
    }
    if format!("{:x}", hash.finalize()) != expected.sha256
        || resource_files::fingerprint(path)? != actual
    {
        return Err("部分文件的已记录前缀已变化，未续传".into());
    }
    Ok(actual)
}
fn verify(path: &Path, artifact: &RemoteArtifact) -> Result<(), String> {
    let actual = resource_files::fingerprint(path)?;
    if actual.bytes > MAX_ARCHIVE
        || artifact.bytes.is_some_and(|n| n != actual.bytes)
        || artifact
            .sha256
            .as_ref()
            .is_some_and(|hash| !actual.sha256.eq_ignore_ascii_case(hash))
    {
        return Err("依赖资产大小或 SHA-256 不一致".into());
    }
    if let Some(integrity) = &artifact.sha512 {
        let expected = sri512(integrity)?;
        let mut digest = Sha512::new();
        let mut file = File::open(path).map_err(|e| e.to_string())?;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            crate::network::check_cancelled()?;
            let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        if expected.as_slice() != digest.finalize().as_slice() {
            return Err("依赖资产 SHA-512 integrity 不一致".into());
        }
    }
    Ok(())
}
fn one(
    plan: &PackageDownloadPlan,
    artifact: &RemoteArtifact,
    previous: Option<Transfer>,
    checkpoint: &mut dyn FnMut(&Transfer) -> Result<(), String>,
) -> Transfer {
    let target = plan.directory.join(&artifact.filename);
    let mut row = previous.unwrap_or_else(|| Transfer {
        package: artifact.package.clone(),
        target: target.clone(),
        partial: None,
        observed: None,
        file_identity: None,
        etag: None,
        complete: false,
        created: false,
        error: None,
    });
    row.error = None;
    let result = (|| {
        plan.recheck()?;
        if row.target != target {
            return Err("下载回执目标与当前资产不一致".into());
        }
        if target.exists() {
            verify(&target, artifact)?;
            row.observed = Some(resource_files::fingerprint(&target)?);
            let identity = crate::clients::file_identity(&target)?;
            // A matching file created by somebody else may be reused, but its
            // bytes do not confer ownership. A pre-crash publication is ours
            // only when it is still the recorded partial's same file object.
            row.created = row.created && row.file_identity.as_ref() == Some(&identity);
            row.file_identity = Some(identity);
            row.complete = true;
            return Ok(());
        }
        let resuming = row.created && row.partial.is_some();
        let partial = row
            .partial
            .get_or_insert_with(|| {
                plan.directory.join(format!(
                    "{}.{}.part",
                    artifact.filename,
                    uuid::Uuid::new_v4()
                ))
            })
            .clone();
        crate::transaction::verify_root(&partial)?;
        if partial.parent() != Some(plan.directory.as_path()) {
            return Err("部分文件不在本次选择的目录".into());
        }
        let offset = if resuming {
            let current = resume_observation(&row, &partial)?;
            row.observed = Some(current.clone());
            current.bytes
        } else {
            0
        };
        if resuming && verify(&partial, artifact).is_ok() {
            publish(&partial, &target)?;
            row.observed = Some(resource_files::fingerprint(&target)?);
            row.file_identity = Some(crate::clients::file_identity(&target)?);
            row.complete = true;
            return Ok(());
        }
        let _permit = crate::network::acquire(true, true)?;
        let (client, _) = crate::network::client()?;
        let mut request = client.get(&artifact.url).timeout(Duration::from_secs(600));
        if offset > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
            if let Some(etag) = &row.etag {
                request = request.header(reqwest::header::IF_RANGE, etag)
            }
        }
        let mut response = request.send().map_err(|_| "无法下载已核对的官方依赖资产")?;
        match plan.recipe {
            Recipe::AgentReachWheelV1 => {
                pypi_url(response.url().as_str())?;
            }
            Recipe::EdgeMcpNpmV1 => {
                npm_url(response.url().as_str())?;
            }
        }
        if response.url().as_str() != artifact.url {
            return Err("依赖资产下载地址变化，保留已有内容待核对".into());
        }
        if offset > 0 {
            if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
                return Err("服务器未接受续传；已有部分文件保持，不自动重下或覆盖".into());
            }
            let range = response
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .ok_or("续传响应没有 Content-Range")?;
            let expected = format!("bytes {offset}-");
            if !range.starts_with(&expected) {
                return Err("服务器续传起点与已有文件不同".into());
            }
        } else if response.status() != reqwest::StatusCode::OK {
            return Err("官方依赖资产当前不可下载".into());
        }
        if response
            .content_length()
            .is_some_and(|n| n > MAX_ARCHIVE.saturating_sub(offset))
        {
            return Err("依赖下载量超过本次有限范围".into());
        }
        row.etag = response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|v| v.to_str().ok())
            .filter(|v| v.len() <= 256 && !v.chars().any(char::is_control))
            .map(str::to_owned);
        let mut output = if resuming {
            OpenOptions::new().append(true).open(&partial)
        } else {
            OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&partial)
        }
        .map_err(|e| e.to_string())?;
        row.created = true;
        row.file_identity = Some(crate::clients::file_identity(&partial)?);
        output.flush().map_err(|e| e.to_string())?;
        row.observed = Some(resource_files::fingerprint(&partial)?);
        checkpoint(&row)?;
        let started = Instant::now();
        let mut last_checkpoint = Instant::now();
        let mut received = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            crate::network::check_cancelled()?;
            let count = response
                .read(&mut buffer)
                .map_err(|_| "依赖下载中断，部分文件保留")?;
            if count == 0 {
                break;
            }
            received += count as u64;
            if offset + received > MAX_ARCHIVE {
                return Err("依赖下载流超过本次有限范围".into());
            }
            output
                .write_all(&buffer[..count])
                .map_err(|e| e.to_string())?;
            if last_checkpoint.elapsed() >= Duration::from_secs(1) {
                output.flush().map_err(|e| e.to_string())?;
                row.observed = Some(resource_files::fingerprint(&partial)?);
                checkpoint(&row)?;
                last_checkpoint = Instant::now();
            }
            if plan.bytes_per_second > 0 {
                let required =
                    Duration::from_secs_f64(received as f64 / plan.bytes_per_second as f64);
                while started.elapsed() < required {
                    crate::network::check_cancelled()?;
                    std::thread::sleep(
                        required
                            .saturating_sub(started.elapsed())
                            .min(Duration::from_millis(25)),
                    );
                }
            }
        }
        output.sync_all().map_err(|e| e.to_string())?;
        drop(output);
        verify(&partial, artifact)?;
        publish(&partial, &target)?;
        row.observed = Some(resource_files::fingerprint(&target)?);
        row.file_identity = Some(crate::clients::file_identity(&target)?);
        row.complete = true;
        Ok(())
    })();
    if let Err(error) = result {
        row.error = Some(error);
        if let Some(partial) = &row.partial {
            row.observed = crate::network::with_task_context(
                crate::network::TaskContext {
                    foreground: false,
                    cancel: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                },
                || resource_files::fingerprint(partial),
            )
            .ok();
        }
    }
    row
}
fn publish(partial: &Path, target: &Path) -> Result<(), String> {
    crate::transaction::verify_root(partial)?;
    crate::transaction::verify_root(target)?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let from: Vec<_> = partial.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<_> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {
            windows_sys::Win32::Storage::FileSystem::MoveFileExW(from.as_ptr(), to.as_ptr(), 0)
        } == 0
        {
            return Err("下载提交时目标已出现或不可写；部分文件保持，没有覆盖".into());
        }
    }
    #[cfg(not(windows))]
    {
        std::fs::hard_link(partial, target).map_err(|_| "下载目标已存在或不可写，没有覆盖")?;
        std::fs::remove_file(partial).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn artifact(bytes: &[u8]) -> RemoteArtifact {
        RemoteArtifact {
            package: "synthetic-dependency".into(),
            filename: "synthetic-1.0.0-py3-none-any.whl".into(),
            url:
                "https://files.pythonhosted.org/packages/synthetic/synthetic-1.0.0-py3-none-any.whl"
                    .into(),
            bytes: Some(bytes.len() as u64),
            sha256: Some(sha256(bytes)),
            sha512: None,
        }
    }
    #[test]
    fn existing_exact_asset_is_reused_offline_and_later_changes_invalidate_the_receipt() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"synthetic pre-existing asset";
        let asset = artifact(bytes);
        let path = dir.path().join(&asset.filename);
        std::fs::write(&path, bytes).unwrap();
        let plan = PackageDownloadPlan::new(Recipe::AgentReachWheelV1, dir.path(), 0, vec![asset])
            .unwrap();
        assert_eq!(plan.preview()["installsFiles"], false);
        let receipt = plan.apply().unwrap();
        assert!(receipt.complete);
        assert!(!receipt.transfers[0].created);
        assert_eq!(
            receipt.files().unwrap()["synthetic-dependency"],
            crate::local::canonical(&path).unwrap()
        );
        std::fs::write(&path, "modified").unwrap();
        assert!(receipt.files().is_err());
        assert!(receipt.preview_resume().is_err());
    }
    #[test]
    fn an_explicit_resume_can_publish_a_fully_verified_partial_without_requesting_the_network() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"synthetic complete partial";
        let asset = artifact(bytes);
        let partial = dir.path().join("owned-synthetic.part");
        std::fs::write(&partial, bytes).unwrap();
        let plan = PackageDownloadPlan::new(Recipe::AgentReachWheelV1, dir.path(), 0, vec![asset])
            .unwrap();
        let target = plan.directory.join(&plan.artifacts[0].filename);
        let partial = crate::local::canonical(&partial).unwrap();
        let old = PackageDownloadReceipt {
            plan,
            transfers: vec![Transfer {
                package: "synthetic-dependency".into(),
                target: target.clone(),
                partial: Some(partial.clone()),
                observed: Some(resource_files::fingerprint(&partial).unwrap()),
                file_identity: Some(crate::clients::file_identity(&partial).unwrap()),
                etag: None,
                complete: false,
                created: true,
                error: Some("synthetic cancellation after receiving bytes".into()),
            }],
            complete: false,
        };
        assert_eq!(old.preview_resume().unwrap()["willReplayInstall"], false);
        let completed = old.resume().unwrap();
        assert!(completed.complete);
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
    }
    #[test]
    fn publication_never_overwrites_an_intervening_target_and_source_urls_cannot_contain_credentials(
    ) {
        let dir = tempfile::tempdir().unwrap();
        let partial = dir.path().join("owned.part");
        let target = dir.path().join("preserved.whl");
        std::fs::write(&partial, "new").unwrap();
        std::fs::write(&target, "original").unwrap();
        assert!(publish(&partial, &target).is_err());
        assert_eq!(std::fs::read_to_string(target).unwrap(), "original");
        assert_eq!(std::fs::read_to_string(partial).unwrap(), "new");
        let mut bad = artifact(b"bytes");
        bad.url = "https://user:secret@files.pythonhosted.org/package.whl".into();
        assert!(
            PackageDownloadPlan::new(Recipe::AgentReachWheelV1, dir.path(), 0, vec![bad]).is_err()
        );
    }

    #[test]
    fn interrupted_tail_requires_the_same_object_and_complete_saved_prefix() {
        let root = tempfile::tempdir().unwrap();
        let partial = root.path().join("owned.part");
        std::fs::write(&partial, b"trusted-prefix").unwrap();
        let row = Transfer {
            package: "synthetic".into(),
            target: root.path().join("target.whl"),
            partial: Some(partial.clone()),
            observed: Some(resource_files::fingerprint(&partial).unwrap()),
            file_identity: Some(crate::clients::file_identity(&partial).unwrap()),
            etag: None,
            complete: false,
            created: true,
            error: None,
        };
        let mut output = OpenOptions::new().append(true).open(&partial).unwrap();
        output.write_all(b"-tail").unwrap();
        drop(output);
        assert_eq!(resume_observation(&row, &partial).unwrap().bytes, 19);
        std::fs::write(&partial, b"changed-prefix-tail").unwrap();
        assert!(resume_observation(&row, &partial).is_err());
        std::fs::remove_file(&partial).unwrap();
        std::fs::write(&partial, b"trusted-prefix-tail").unwrap();
        assert!(resume_observation(&row, &partial).is_err());
    }

    #[test]
    fn checkpoints_are_actual_facts_and_a_failed_journal_stops_before_new_writes() {
        let root = tempfile::tempdir().unwrap();
        let bytes = b"inert exact existing artifact";
        let asset = artifact(bytes);
        std::fs::write(root.path().join(&asset.filename), bytes).unwrap();
        let plan = PackageDownloadPlan::new(Recipe::AgentReachWheelV1, root.path(), 0, vec![asset])
            .unwrap();
        let mut observed = vec![];
        let receipt = plan
            .clone()
            .apply_with_checkpoint(|r| {
                observed.push(serde_json::to_value(r).unwrap());
                Ok(())
            })
            .unwrap();
        assert!(receipt.complete && observed.len() >= 2);
        assert_eq!(observed.last().unwrap()["transfers"][0]["complete"], true);
        assert_eq!(observed.last().unwrap()["transfers"][0]["created"], false);
        assert!(plan
            .apply_with_checkpoint(|_| Err("synthetic writer unavailable".into()))
            .is_err());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn publication_crash_is_recovered_only_from_the_same_verified_file_object() {
        let root = tempfile::tempdir().unwrap();
        let bytes = b"synthetic complete artifact";
        let asset = artifact(bytes);
        let partial = root.path().join("owned.part");
        std::fs::write(&partial, bytes).unwrap();
        let partial = crate::local::canonical(&partial).unwrap();
        let plan = PackageDownloadPlan::new(Recipe::AgentReachWheelV1, root.path(), 0, vec![asset])
            .unwrap();
        let target = plan.directory.join(&plan.artifacts[0].filename);
        let row = Transfer {
            package: "synthetic-dependency".into(),
            target: target.clone(),
            partial: Some(partial.clone()),
            observed: Some(resource_files::fingerprint(&partial).unwrap()),
            file_identity: Some(crate::clients::file_identity(&partial).unwrap()),
            etag: None,
            complete: false,
            created: true,
            error: Some("synthetic crash before final checkpoint".into()),
        };
        publish(&partial, &target).unwrap();
        let receipt = PackageDownloadReceipt {
            plan,
            transfers: vec![row],
            complete: false,
        };
        assert_eq!(
            receipt.preview_resume().unwrap()["transfers"][0]["complete"],
            true
        );
        let completed = receipt.clone().resume().unwrap();
        assert!(completed.complete && completed.transfers[0].created);
        std::fs::remove_file(&target).unwrap();
        std::fs::write(&target, bytes).unwrap();
        assert!(receipt.preview_resume().is_err());
    }
}
