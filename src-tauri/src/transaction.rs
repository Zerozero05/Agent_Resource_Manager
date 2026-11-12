//! Journaled file updates. Recovery snapshots are not a second deployable skill source.
use crate::model::now;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
};

#[derive(Serialize, Deserialize)]
struct Entry {
    path: String,
    before: Option<String>,
    after: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Journal {
    root: PathBuf,
    state: String,
    created_at: String,
    entries: Vec<Entry>,
    #[serde(default)]
    backup_plan: Option<BackupPlan>,
    #[serde(default)]
    backup_approved_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupFile {
    pub relative_path: String,
    pub source_path: PathBuf,
    pub destination_path: PathBuf,
    pub sha256: String,
    pub bytes: u64,
    pub modified: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupPlan {
    pub id: String,
    pub required: bool,
    pub source_root: PathBuf,
    pub recovery_root: PathBuf,
    pub destination: PathBuf,
    pub method: String,
    pub files: Vec<BackupFile>,
    pub file_count: usize,
    pub total_bytes: u64,
    pub summary: String,
    operation_digest: String,
}

// This value cannot be deserialized from a request or persisted as reusable approval.
pub(crate) struct BackupGrant {
    plan_id: String,
    plan_digest: String,
    approved_at: String,
}

pub(crate) fn authorize_local_preview(plan: &BackupPlan) -> Result<BackupGrant, String> {
    Ok(BackupGrant {
        plan_id: plan.id.clone(),
        plan_digest: hash(&serde_json::to_vec(plan).map_err(|e| e.to_string())?),
        approved_at: now(),
    })
}

pub(crate) fn plan_backup(
    history: &Path,
    root: &Path,
    expected: &BTreeMap<String, String>,
    writes: &BTreeMap<String, Vec<u8>>,
    deletes: &[String],
) -> Result<BackupPlan, String> {
    plan_backup_with_id(
        history,
        root,
        expected,
        writes,
        deletes,
        uuid::Uuid::new_v4().to_string(),
    )
}

fn plan_backup_with_id(
    history: &Path,
    root: &Path,
    expected: &BTreeMap<String, String>,
    writes: &BTreeMap<String, Vec<u8>>,
    deletes: &[String],
    id: String,
) -> Result<BackupPlan, String> {
    verify_root(root)?;
    verify_root(history)?;
    if uuid::Uuid::parse_str(&id).is_err() {
        return Err("备份计划标识无效".into());
    }
    let actual = if root.exists() {
        crate::local::files(root)?
    } else {
        BTreeMap::new()
    };
    if actual != *expected {
        return Err("Local files changed after preview. Check changes again.".into());
    }
    let destination = history.join(&id).join("before");
    let mut files = Vec::new();
    let mut changes = BTreeMap::new();
    for (path, bytes) in writes {
        checked(root, path)?;
        let after = hash(bytes);
        if expected.get(path) != Some(&after) {
            changes.insert(path.clone(), Some(after));
        }
    }
    for path in deletes {
        checked(root, path)?;
        if writes.contains_key(path) {
            return Err("Ambiguous update: file both written and deleted".into());
        }
        changes.insert(path.clone(), None);
    }
    for path in changes.keys() {
        if let Some(expected_hash) = expected.get(path) {
            let source = checked(root, path)?;
            let fingerprint = crate::resource_files::fingerprint(&source)?;
            if fingerprint.sha256 != *expected_hash {
                return Err("文件在准备备份计划时变化，请重新预览".into());
            }
            files.push(BackupFile {
                relative_path: path.clone(),
                source_path: source,
                destination_path: checked(&destination, path)?,
                sha256: fingerprint.sha256,
                bytes: fingerprint.bytes,
                modified: fingerprint.modified,
            });
        }
    }
    let total_bytes = files.iter().try_fold(0u64, |sum, file| {
        sum.checked_add(file.bytes).ok_or("备份大小超出范围")
    })?;
    Ok(BackupPlan {
        id,
        required: !files.is_empty(),
        source_root: root.to_owned(),
        recovery_root: history.to_owned(),
        destination,
        method: "copy-existing-files".into(),
        file_count: files.len(),
        total_bytes,
        summary: if files.is_empty() {
            "仅新增文件或更新记录，不复制已有文件备份".into()
        } else {
            format!(
                "将复制 {} 个需替换或删除的原文件，保留失败回滚能力",
                files.len()
            )
        },
        files,
        operation_digest: hash(&serde_json::to_vec(&changes).map_err(|e| e.to_string())?),
    })
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn linked(path: &Path) -> Result<bool, String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        Ok(meta.file_attributes() & 0x400 != 0)
    }
    #[cfg(not(windows))]
    {
        Ok(meta.file_type().is_symlink())
    }
}

fn valid_component(part: &str) -> bool {
    if part.is_empty()
        || part == "."
        || part == ".."
        || part
            .chars()
            .any(|c| c.is_control() || "<>:\"|?*\\/".contains(c))
        || part.ends_with(['.', ' '])
    {
        return false;
    }
    let stem = part
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(['.', ' '])
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) {
        return false;
    }
    let suffix = stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"));
    !matches!(
        suffix,
        Some("1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")
    )
}

fn inspect_link(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => linked(path),
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            Ok(false)
        }
        Err(e) => Err(format!("Cannot inspect path {}: {e}", path.display())),
    }
}

fn checked(root: &Path, relative: &str) -> Result<PathBuf, String> {
    // Validate the original slash-separated text: Path::components normalizes
    // repeated separators and some dot components, losing evidence of aliases.
    if relative.split('/').any(|part| !valid_component(part)) {
        return Err("Unsafe relative file path".into());
    }
    let path = Path::new(relative);
    if path
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
        || path.is_absolute()
    {
        return Err("File path escapes the selected folder".into());
    }
    let mut p = root.to_path_buf();
    for c in path.components() {
        p.push(c);
        if inspect_link(&p)? {
            return Err("Internal directory links are not writable".into());
        }
    }
    Ok(p)
}
pub(crate) fn verify_root(root: &Path) -> Result<(), String> {
    if !root.is_absolute() {
        return Err("An absolute destination is required".into());
    }
    for component in root.components() {
        match component {
            Component::ParentDir | Component::CurDir => {
                return Err("Destination contains traversal components".into())
            }
            Component::Normal(name) if !name.to_str().map(valid_component).unwrap_or(false) => {
                return Err("Destination contains an unsafe file name".into())
            }
            #[cfg(windows)]
            Component::Prefix(prefix)
                if matches!(
                    prefix.kind(),
                    std::path::Prefix::DeviceNS(_) | std::path::Prefix::Verbatim(_)
                ) =>
            {
                return Err("Windows device namespace destinations are not allowed".into())
            }
            _ => {}
        }
    }
    for p in root.ancestors() {
        if inspect_link(p)? {
            return Err(
                "Destination ancestors contain a directory link; select its real folder".into(),
            );
        }
    }
    Ok(())
}
fn current(path: &Path) -> Result<Option<String>, String> {
    match fs::symlink_metadata(path) {
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            return Ok(None)
        }
        Err(e) => {
            return Err(format!(
                "Cannot inspect current file {}: {e}",
                path.display()
            ))
        }
        Ok(_) => {}
    }
    fs::read(path)
        .map(|b| Some(hash(&b)))
        .map_err(|e| e.to_string())
}
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("File has no parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = parent.join(format!(".skill-manager-{}.tmp", uuid::Uuid::new_v4()));
    use std::io::Write;
    let mut created = false;
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        created = true;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&temporary, path)
            .map_err(|e| format!("Could not replace file (a program may have it open): {e}"))
    })();
    if let Err(error) = result {
        if !created {
            return Err(error);
        }
        return match fs::remove_file(&temporary) {
            Ok(()) => Err(error),
            Err(cleanup) if cleanup.kind() == std::io::ErrorKind::NotFound => Err(error),
            Err(cleanup) => Err(format!(
                "{error}; temporary file retained at {}: {cleanup}",
                temporary.display()
            )),
        };
    }
    Ok(())
}
fn save(dir: &Path, journal: &Journal) -> Result<(), String> {
    atomic_write(
        &dir.join("journal.json"),
        &serde_json::to_vec_pretty(journal).map_err(|e| e.to_string())?,
    )
}
fn rollback(dir: &Path, journal: &mut Journal) -> Result<(), String> {
    verify_root(&journal.root)?;
    verify_root(&dir.join("before"))?;
    // Check all affected files before restoring any. Preserve edits made after the interruption.
    for entry in &journal.entries {
        let destination = checked(&journal.root, &entry.path)?;
        let value = current(&destination)?;
        if value != entry.before && value != entry.after {
            return Err(format!("Recovery needs review: {} changed after the operation. Original bytes are preserved in {}", entry.path, dir.display()));
        }
        // Validate every backup before restoring the first file. A corrupt
        // later snapshot must not leave a recovery half applied.
        if let Some(expected) = &entry.before {
            let original =
                fs::read(checked(&dir.join("before"), &entry.path)?).map_err(|e| e.to_string())?;
            if &hash(&original) != expected {
                return Err("Recovery snapshot checksum mismatch".into());
            }
        }
    }
    for entry in journal.entries.iter().rev() {
        let destination = checked(&journal.root, &entry.path)?;
        if entry.before.is_some() {
            let original =
                fs::read(checked(&dir.join("before"), &entry.path)?).map_err(|e| e.to_string())?;
            if Some(hash(&original)) != entry.before {
                return Err("Recovery snapshot checksum mismatch".into());
            }
            atomic_write(&destination, &original)?;
        } else if destination.exists() {
            fs::remove_file(&destination).map_err(|e| e.to_string())?;
        }
    }
    journal.state = "rolled_back".into();
    save(dir, journal)
}

#[cfg(test)]
pub fn apply(
    data_dir: &Path,
    root: &Path,
    expected: &BTreeMap<String, String>,
    writes: &BTreeMap<String, Vec<u8>>,
    deletes: &[String],
) -> Result<String, String> {
    // Synthetic rollback tests opt in explicitly. Production callers must obtain
    // the non-serializable grant through the local window's preview route.
    let history = data_dir.join("recovery");
    let plan = plan_backup(&history, root, expected, writes, deletes)?;
    let grant = plan
        .required
        .then(|| authorize_local_preview(&plan))
        .transpose()?;
    apply_in(&history, root, expected, writes, deletes, &plan, grant)
}
pub(crate) fn apply_in(
    history: &Path,
    root: &Path,
    expected: &BTreeMap<String, String>,
    writes: &BTreeMap<String, Vec<u8>>,
    deletes: &[String],
    plan: &BackupPlan,
    grant: Option<BackupGrant>,
) -> Result<String, String> {
    verify_root(root)?;
    verify_root(history)?;
    let fresh = plan_backup_with_id(history, root, expected, writes, deletes, plan.id.clone())?;
    if fresh != *plan {
        return Err("备份对象、路径或文件时间戳已变化，请重新预览并允许本次备份".into());
    }
    if plan.required
        && !grant.as_ref().is_some_and(|grant| {
            grant.plan_id == plan.id
                && serde_json::to_vec(plan).is_ok_and(|bytes| grant.plan_digest == hash(&bytes))
        })
    {
        return Err("本次更新需要备份；请在本地预览中核对对象、位置和方式后明确允许".into());
    }
    let writes: BTreeMap<_, _> = writes
        .iter()
        .filter(|(path, bytes)| expected.get(*path) != Some(&hash(bytes)))
        .map(|(path, bytes)| (path.clone(), bytes.clone()))
        .collect();
    let writes = &writes;
    let dir = history.join(&plan.id);
    if fs::symlink_metadata(&dir).is_ok() {
        return Err("备份事务目录已存在，不能复用或覆盖；请重新预览".into());
    }
    fs::create_dir_all(history).map_err(|e| e.to_string())?;
    for item in fs::read_dir(history).map_err(|e| e.to_string())? {
        let path = item.map_err(|e| e.to_string())?.path().join("journal.json");
        if path.is_file() {
            let j: Journal = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            if j.root == root && j.state == "applying" {
                return Err("An earlier update needs recovery before another write".into());
            }
        }
    }
    let actual = if root.exists() {
        crate::local::files(root)?
    } else {
        BTreeMap::new()
    };
    if actual != *expected {
        return Err("Local files changed after preview. Check changes again.".into());
    }
    for path in writes.keys().chain(deletes.iter()) {
        checked(root, path)?;
    }
    if writes.keys().any(|p| deletes.contains(p)) {
        return Err("Ambiguous update: file both written and deleted".into());
    }
    let id = plan.id.clone();
    fs::create_dir(&dir).map_err(|e| e.to_string())?;
    if plan.required {
        fs::create_dir(dir.join("before")).map_err(|e| e.to_string())?;
    }
    let mut entries = Vec::new();
    for path in writes.keys().chain(deletes.iter()) {
        let destination = checked(root, path)?;
        let before = current(&destination)?;
        if before.is_some() {
            let approved = plan
                .files
                .iter()
                .find(|file| file.relative_path == *path)
                .ok_or("待备份文件不在本次允许清单中")?;
            let original = crate::resource_files::fingerprint(&destination)?;
            if original.sha256 != approved.sha256
                || original.bytes != approved.bytes
                || original.modified != approved.modified
            {
                return Err("复制前原文件已变化，未开始替换，请重新预览".into());
            }
            let backup = checked(&dir.join("before"), path)?;
            fs::create_dir_all(backup.parent().ok_or("No parent")?).map_err(|e| e.to_string())?;
            fs::copy(&destination, &backup).map_err(|e| e.to_string())?;
            let copied = crate::resource_files::fingerprint(&backup)?;
            if copied.sha256 != approved.sha256 || copied.bytes != approved.bytes {
                return Err("备份副本核验失败，原运行文件尚未替换".into());
            }
        }
        entries.push(Entry {
            path: path.clone(),
            before,
            after: writes.get(path).map(|b| hash(b)),
        });
    }
    let mut journal = Journal {
        root: root.to_path_buf(),
        state: "applying".into(),
        created_at: now(),
        entries,
        backup_plan: Some(plan.clone()),
        backup_approved_at: grant.map(|grant| grant.approved_at),
    };
    save(&dir, &journal)?;
    let result = (|| {
        fs::create_dir_all(root).map_err(|e| e.to_string())?;
        for (path, bytes) in writes {
            let destination = checked(root, path)?;
            // Recheck affected bytes just before each replacement as well as at preview boundary.
            if current(&destination)? != expected.get(path).cloned() {
                return Err("File changed during update".into());
            }
            atomic_write(&destination, bytes)?;
        }
        for path in deletes {
            let destination = checked(root, path)?;
            if current(&destination)? != expected.get(path).cloned() {
                return Err("File changed during update".into());
            }
            if destination.exists() {
                fs::remove_file(destination).map_err(|e| e.to_string())?;
            }
        }
        Ok::<(), String>(())
    })();
    if let Err(error) = result {
        return match rollback(&dir, &mut journal) {
            Ok(()) => Err(format!("{error}. Original files restored.")),
            Err(recovery) => Err(format!("{error}. {recovery}")),
        };
    }
    journal.state = "committed".into();
    if let Err(error) = save(&dir, &journal) {
        journal.state = "applying".into();
        return match rollback(&dir, &mut journal) {
            Ok(()) => Err(format!(
                "Could not commit the recovery journal: {error}. Original files restored."
            )),
            Err(recovery) => Err(format!(
                "Could not commit the recovery journal: {error}. {recovery}"
            )),
        };
    }
    Ok(id)
}

#[cfg(test)]
pub fn recover(data_dir: &Path) -> Result<Vec<String>, String> {
    recover_in(&data_dir.join("recovery"))
}
pub(crate) fn recover_in(history: &Path) -> Result<Vec<String>, String> {
    verify_root(history)?;
    if !history.exists() {
        return Ok(vec![]);
    }
    let mut messages = Vec::new();
    for item in fs::read_dir(history).map_err(|e| e.to_string())? {
        let dir = item.map_err(|e| e.to_string())?.path();
        verify_root(&dir)?;
        let file = dir.join("journal.json");
        if !file.is_file() {
            continue;
        }
        let mut journal: Journal =
            serde_json::from_slice(&fs::read(file).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if journal.state == "applying" {
            match rollback(&dir, &mut journal) {
                Ok(()) => messages.push(format!(
                    "Recovered interrupted update of {}",
                    journal.root.display()
                )),
                Err(e) => messages.push(e),
            }
        }
    }
    Ok(messages)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp() -> tempfile::TempDir {
        let p = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("work/test-fixtures");
        fs::create_dir_all(&p).unwrap();
        tempfile::tempdir_in(p).unwrap()
    }

    #[test]
    fn backup_plan_lists_only_changed_originals_and_requires_the_exact_grant() {
        let d = temp();
        let root = d.path().join("skill");
        let history = d.path().join("data/recovery");
        fs::create_dir(&root).unwrap();
        for (path, bytes) in [
            ("SKILL.md", "old instructions"),
            ("retired.txt", "old script"),
            ("LICENSE", "same license"),
            ("private.txt", "unique user data"),
        ] {
            fs::write(root.join(path), bytes).unwrap();
        }
        let expected = crate::local::files(&root).unwrap();
        let writes = BTreeMap::from([
            ("SKILL.md".into(), b"new instructions".to_vec()),
            ("LICENSE".into(), b"same license".to_vec()),
            ("new.txt".into(), b"new script".to_vec()),
        ]);
        let deletes = vec!["retired.txt".into()];
        let plan = plan_backup(&history, &root, &expected, &writes, &deletes).unwrap();
        assert!(plan.required);
        assert_eq!(plan.file_count, 2);
        assert_eq!(plan.total_bytes, 26);
        assert_eq!(plan.method, "copy-existing-files");
        assert_eq!(plan.source_root, root);
        assert_eq!(plan.recovery_root, history);
        assert_eq!(plan.destination, history.join(&plan.id).join("before"));
        assert_eq!(
            plan.files
                .iter()
                .map(|f| f.relative_path.as_str())
                .collect::<Vec<_>>(),
            ["SKILL.md", "retired.txt"]
        );
        for file in &plan.files {
            assert_eq!(file.source_path, root.join(&file.relative_path));
            assert_eq!(
                file.destination_path,
                plan.destination.join(&file.relative_path)
            );
            assert_eq!(file.sha256, expected[&file.relative_path]);
        }
        assert!(!history.exists(), "preview must not create backup folders");
        let denied =
            apply_in(&history, &root, &expected, &writes, &deletes, &plan, None).unwrap_err();
        assert!(denied.contains("明确允许"));
        assert!(!history.exists());
        let other_plan = plan_backup(&history, &root, &expected, &writes, &deletes).unwrap();
        assert!(apply_in(
            &history,
            &root,
            &expected,
            &writes,
            &deletes,
            &plan,
            Some(authorize_local_preview(&other_plan).unwrap())
        )
        .is_err());
        assert!(!history.exists());
        assert_eq!(crate::local::files(&root).unwrap(), expected);
        let id = apply_in(
            &history,
            &root,
            &expected,
            &writes,
            &deletes,
            &plan,
            Some(authorize_local_preview(&plan).unwrap()),
        )
        .unwrap();
        assert_eq!(id, plan.id);
        assert_eq!(
            fs::read(plan.destination.join("SKILL.md")).unwrap(),
            b"old instructions"
        );
        assert_eq!(
            fs::read(plan.destination.join("retired.txt")).unwrap(),
            b"old script"
        );
        assert!(!plan.destination.join("LICENSE").exists());
        assert!(!plan.destination.join("new.txt").exists());
        assert!(!plan.destination.join("private.txt").exists());
        assert_eq!(
            fs::read(root.join("private.txt")).unwrap(),
            b"unique user data"
        );
        assert_eq!(fs::read(root.join("new.txt")).unwrap(), b"new script");
        assert!(!root.join("retired.txt").exists());
        let journal: Journal =
            serde_json::from_slice(&fs::read(history.join(id).join("journal.json")).unwrap())
                .unwrap();
        assert_eq!(journal.backup_plan.as_ref(), Some(&plan));
        assert!(journal.backup_approved_at.is_some());
        assert!(apply_in(
            &history,
            &root,
            &expected,
            &writes,
            &deletes,
            &plan,
            Some(authorize_local_preview(&plan).unwrap())
        )
        .is_err());
    }

    #[test]
    fn backup_consent_cannot_follow_changed_content_location_operation_or_timestamp() {
        let d = temp();
        let root = d.path().join("skill");
        let history = d.path().join("recovery");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("SKILL.md"), b"original").unwrap();
        let expected = crate::local::files(&root).unwrap();
        let writes = BTreeMap::from([("SKILL.md".into(), b"approved update".to_vec())]);
        let plan = plan_backup(&history, &root, &expected, &writes, &[]).unwrap();
        let changed_writes = BTreeMap::from([("SKILL.md".into(), b"different update".to_vec())]);
        let grant = || Some(authorize_local_preview(&plan).unwrap());
        assert!(apply_in(
            &history,
            &root,
            &expected,
            &changed_writes,
            &[],
            &plan,
            grant()
        )
        .is_err());
        let other_history = d.path().join("elsewhere");
        assert!(apply_in(
            &other_history,
            &root,
            &expected,
            &writes,
            &[],
            &plan,
            grant()
        )
        .is_err());
        assert!(!other_history.exists());
        // Same bytes at a different path still require a new displayed plan.
        let other_root = d.path().join("other-skill");
        fs::create_dir(&other_root).unwrap();
        fs::write(other_root.join("SKILL.md"), b"original").unwrap();
        assert!(apply_in(
            &history,
            &other_root,
            &expected,
            &writes,
            &[],
            &plan,
            grant()
        )
        .is_err());
        let file = fs::OpenOptions::new()
            .write(true)
            .open(root.join("SKILL.md"))
            .unwrap();
        let changed_time =
            file.metadata().unwrap().modified().unwrap() + std::time::Duration::from_secs(5);
        file.set_times(fs::FileTimes::new().set_modified(changed_time))
            .unwrap();
        drop(file);
        assert_eq!(
            crate::local::files(&root).unwrap(),
            expected,
            "timestamp-only drift retains the original bytes"
        );
        let error = apply_in(&history, &root, &expected, &writes, &[], &plan, grant()).unwrap_err();
        assert!(error.contains("时间戳"));
        fs::write(root.join("SKILL.md"), b"later user edit").unwrap();
        assert!(apply_in(&history, &root, &expected, &writes, &[], &plan, grant()).is_err());
        assert_eq!(fs::read(root.join("SKILL.md")).unwrap(), b"later user edit");
        assert!(
            !history.exists(),
            "all rejected grants must precede creation or copying"
        );
    }

    #[test]
    fn new_files_and_unchanged_files_never_create_backup_copies() {
        let d = temp();
        let root = d.path().join("skill");
        let history = d.path().join("recovery");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("SKILL.md"), b"instructions").unwrap();
        let expected = crate::local::files(&root).unwrap();
        let writes = BTreeMap::from([
            ("SKILL.md".into(), b"instructions".to_vec()),
            ("new.txt".into(), b"new file".to_vec()),
        ]);
        let plan = plan_backup(&history, &root, &expected, &writes, &[]).unwrap();
        assert!(!plan.required);
        assert!(plan.files.is_empty());
        assert_eq!(plan.total_bytes, 0);
        apply_in(&history, &root, &expected, &writes, &[], &plan, None).unwrap();
        assert!(!plan.destination.exists());
        assert_eq!(fs::read(root.join("SKILL.md")).unwrap(), b"instructions");
        let journal: Journal =
            serde_json::from_slice(&fs::read(history.join(&plan.id).join("journal.json")).unwrap())
                .unwrap();
        assert!(journal.backup_approved_at.is_none());
        assert_eq!(journal.entries.len(), 1);
        assert_eq!(journal.entries[0].path, "new.txt");
        assert!(journal.entries[0].before.is_none());
    }
    #[test]
    fn update_preserves_unmanaged_and_can_restore_interruption() {
        let d = temp();
        let root = d.path().join("skill");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("SKILL.md"), "original").unwrap();
        fs::write(root.join("notes.txt"), "unique").unwrap();
        let expected = crate::local::files(&root).unwrap();
        let writes = BTreeMap::from([("SKILL.md".into(), b"new".to_vec())]);
        let id = apply(&d.path().join("data"), &root, &expected, &writes, &[]).unwrap();
        assert_eq!(fs::read(root.join("notes.txt")).unwrap(), b"unique");
        let jpath = d.path().join("data/recovery").join(id).join("journal.json");
        let mut journal: Journal = serde_json::from_slice(&fs::read(&jpath).unwrap()).unwrap();
        journal.state = "applying".into();
        save(jpath.parent().unwrap(), &journal).unwrap();
        assert_eq!(recover(&d.path().join("data")).unwrap().len(), 1);
        assert_eq!(fs::read(root.join("SKILL.md")).unwrap(), b"original");
    }
    #[test]
    fn refuses_drift_and_traversal_before_touching_files() {
        let d = temp();
        let root = d.path().join("skill");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("SKILL.md"), "a").unwrap();
        let old = crate::local::files(&root).unwrap();
        fs::write(root.join("SKILL.md"), "user edit").unwrap();
        assert!(apply(
            d.path(),
            &root,
            &old,
            &BTreeMap::from([("SKILL.md".into(), b"remote".to_vec())]),
            &[]
        )
        .is_err());
        assert!(checked(&root, "../outside").is_err());
        assert!(checked(&root, "C:/escape").is_err());
        assert_eq!(fs::read(root.join("SKILL.md")).unwrap(), b"user edit");
    }
    #[test]
    fn recovery_keeps_post_crash_user_edits() {
        let d = temp();
        let root = d.path().join("skill");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("SKILL.md"), "before").unwrap();
        let original = crate::local::files(&root).unwrap();
        let id = apply(
            &d.path().join("data"),
            &root,
            &original,
            &BTreeMap::from([("SKILL.md".into(), b"after".to_vec())]),
            &[],
        )
        .unwrap();
        let dir = d.path().join("data/recovery").join(id);
        let mut j: Journal =
            serde_json::from_slice(&fs::read(dir.join("journal.json")).unwrap()).unwrap();
        j.state = "applying".into();
        save(&dir, &j).unwrap();
        fs::write(root.join("SKILL.md"), "later user edit").unwrap();
        let messages = recover(&d.path().join("data")).unwrap();
        assert!(messages[0].contains("needs review"));
        assert_eq!(fs::read(root.join("SKILL.md")).unwrap(), b"later user edit");
    }

    #[test]
    fn middle_io_failure_restores_written_file_and_preserves_customized_and_unknown_files() {
        let d = temp();
        let root = d.path().join("skill");
        let data = d.path().join("data");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("a.txt"), b"locally customized original").unwrap();
        fs::write(
            root.join("private-notes.txt"),
            b"unique unmanaged information",
        )
        .unwrap();
        // The first replacement succeeds. A real file blocks the second
        // write's parent mkdir, exercising rollback after observable I/O.
        fs::write(root.join("z-blocker"), b"existing file, never a directory").unwrap();
        let expected = crate::local::files(&root).unwrap();
        let writes = BTreeMap::from([
            ("a.txt".into(), b"new upstream text".to_vec()),
            ("z-blocker/child.txt".into(), b"cannot be created".to_vec()),
        ]);
        let error = apply(&data, &root, &expected, &writes, &[]).unwrap_err();
        assert!(error.contains("Original files restored"), "{error}");
        assert_eq!(crate::local::files(&root).unwrap(), expected);
        assert_eq!(
            fs::read(root.join("a.txt")).unwrap(),
            b"locally customized original"
        );
        assert_eq!(
            fs::read(root.join("private-notes.txt")).unwrap(),
            b"unique unmanaged information"
        );
        assert_eq!(
            fs::read(root.join("z-blocker")).unwrap(),
            b"existing file, never a directory"
        );
        let journal_dir = fs::read_dir(data.join("recovery"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let journal: Journal =
            serde_json::from_slice(&fs::read(journal_dir.join("journal.json")).unwrap()).unwrap();
        assert_eq!(journal.state, "rolled_back");
        assert_eq!(
            fs::read(journal_dir.join("before/a.txt")).unwrap(),
            b"locally customized original"
        );
        assert!(recover(&data).unwrap().is_empty());
    }

    #[test]
    fn two_previews_do_not_allow_an_older_snapshot_to_replace_newer_or_user_edited_files() {
        let d = temp();
        let root = d.path().join("skill");
        let data = d.path().join("data");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("SKILL.md"), b"installed").unwrap();
        let preview_a = crate::local::files(&root).unwrap();
        let preview_b = crate::local::files(&root).unwrap();
        apply(
            &data,
            &root,
            &preview_a,
            &BTreeMap::from([("SKILL.md".into(), b"first accepted update".to_vec())]),
            &[],
        )
        .unwrap();
        let error = apply(
            &data,
            &root,
            &preview_b,
            &BTreeMap::from([("SKILL.md".into(), b"stale second preview".to_vec())]),
            &[],
        )
        .unwrap_err();
        assert!(error.contains("changed after preview"));
        assert_eq!(
            fs::read(root.join("SKILL.md")).unwrap(),
            b"first accepted update"
        );
        let preview_after_update = crate::local::files(&root).unwrap();
        fs::write(root.join("SKILL.md"), b"user edit after both previews").unwrap();
        assert!(apply(
            &data,
            &root,
            &preview_after_update,
            &BTreeMap::from([("SKILL.md".into(), b"unreviewed overwrite".to_vec())]),
            &[]
        )
        .is_err());
        assert_eq!(
            fs::read(root.join("SKILL.md")).unwrap(),
            b"user edit after both previews"
        );
    }

    #[test]
    fn windows_aliases_and_unsafe_components_are_rejected_before_file_operations() {
        let d = temp();
        for relative in [
            "CON",
            "NUL.txt",
            "com1.log",
            "LPT9",
            "COM¹.txt",
            "CONIN$",
            "CONOUT$",
            "sub/PRN.md",
            "name.",
            "name ",
            "a//b",
            "a/./b",
            "a/../b",
            "SKILL.md:stream",
            r"a\b",
            "../outside",
        ] {
            assert!(checked(d.path(), relative).is_err(), "{relative}");
        }
        #[cfg(windows)]
        for root in [
            r"\\.\NUL",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1\",
            r"D:\NUL\skill",
        ] {
            assert!(verify_root(Path::new(root)).is_err(), "{root}");
        }
    }

    #[test]
    fn failed_atomic_replacement_leaves_no_temporary_file() {
        let d = temp();
        let occupied = d.path().join("occupied");
        fs::create_dir(&occupied).unwrap();
        fs::write(occupied.join("keep.txt"), b"preserve this directory").unwrap();
        assert!(atomic_write(&occupied, b"cannot replace a directory").is_err());
        assert_eq!(
            fs::read(occupied.join("keep.txt")).unwrap(),
            b"preserve this directory"
        );
        let leftovers: Vec<_> = fs::read_dir(d.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .filter(|s| s.to_string_lossy().starts_with(".skill-manager-"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn root_internal_and_dangling_junctions_are_never_writable() {
        let d = temp();
        let real = d.path().join("real");
        let outside = d.path().join("outside");
        fs::create_dir(&real).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(real.join("SKILL.md"), b"real source").unwrap();
        fs::write(outside.join("keep.txt"), b"outside data").unwrap();
        let root_alias = d.path().join("root-alias");
        junction::create(&real, &root_alias).unwrap();
        assert!(verify_root(&root_alias).is_err());
        assert!(verify_root(&root_alias.join("new-child")).is_err());
        let internal = real.join("internal");
        junction::create(&outside, &internal).unwrap();
        assert!(checked(&real, "internal/keep.txt").is_err());
        assert!(apply(
            &d.path().join("data"),
            &real,
            &BTreeMap::new(),
            &BTreeMap::from([("internal/keep.txt".into(), b"overwrite".to_vec())]),
            &[]
        )
        .is_err());
        assert_eq!(fs::read(outside.join("keep.txt")).unwrap(), b"outside data");
        fs::remove_dir(&internal).unwrap();
        let transient = d.path().join("transient");
        fs::create_dir(&transient).unwrap();
        let dangling = real.join("dangling");
        junction::create(&transient, &dangling).unwrap();
        fs::remove_dir(&transient).unwrap();
        assert!(!dangling.exists());
        assert!(checked(&real, "dangling/file.txt").is_err());
        assert!(verify_root(&dangling).is_err());
        fs::remove_dir(&dangling).unwrap();
        fs::remove_dir(&root_alias).unwrap();
    }

    #[test]
    fn corrupt_recovery_snapshot_is_validated_before_restoring_any_file() {
        let d = temp();
        let root = d.path().join("skill");
        let data = d.path().join("data");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("a.txt"), b"old a").unwrap();
        fs::write(root.join("z.txt"), b"old z").unwrap();
        let expected = crate::local::files(&root).unwrap();
        let id = apply(
            &data,
            &root,
            &expected,
            &BTreeMap::from([
                ("a.txt".into(), b"new a".to_vec()),
                ("z.txt".into(), b"new z".to_vec()),
            ]),
            &[],
        )
        .unwrap();
        let dir = data.join("recovery").join(id);
        let mut journal: Journal =
            serde_json::from_slice(&fs::read(dir.join("journal.json")).unwrap()).unwrap();
        journal.state = "applying".into();
        save(&dir, &journal).unwrap();
        // a.txt would be restored after z.txt in reverse order. Detect its
        // corrupted backup before touching either runtime file.
        fs::write(dir.join("before/a.txt"), b"corrupted backup").unwrap();
        let messages = recover(&data).unwrap();
        assert!(messages[0].contains("checksum mismatch"));
        assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"new a");
        assert_eq!(fs::read(root.join("z.txt")).unwrap(), b"new z");
    }
}
