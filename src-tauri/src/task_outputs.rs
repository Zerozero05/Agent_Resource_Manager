//! Durable result locations; history never retains output contents or replays work.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResultFile {
    id: String,
    label: String,
    path: String,
    bytes: Option<u64>,
    modified_millis: Option<u64>,
}

fn valid_location(path: &Path) -> bool {
    path.is_absolute()
        && !path.to_string_lossy().contains('\0')
        && path.as_os_str().len() <= 32767
        && !path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
}
fn checked_metadata(path: &Path) -> Result<fs::Metadata, String> {
    if !valid_location(path) {
        return Err("结果位置不是完整的本地路径".into());
    }
    for part in path.ancestors() {
        let metadata = fs::symlink_metadata(part).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "结果位置已不存在".into()
            } else {
                format!("无法读取结果位置：{error}")
            }
        })?;
        #[cfg(windows)]
        let linked = {
            use std::os::windows::fs::MetadataExt;
            metadata.file_attributes() & 0x400 != 0
        };
        #[cfg(not(windows))]
        let linked = metadata.file_type().is_symlink();
        if linked {
            return Err("结果位置经过链接或目录联接，请本人核对位置".into());
        }
    }
    fs::metadata(path).map_err(|error| error.to_string())
}

fn modified(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis()
        .try_into()
        .ok()
}

fn document_type(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "txt"
            | "md"
            | "json"
            | "csv"
            | "tsv"
            | "log"
            | "tex"
            | "pdf"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "bmp"
            | "mp3"
            | "wav"
            | "m4a"
            | "flac"
            | "mp4"
            | "webm"
            | "mkv"
            | "srt"
            | "vtt"
            | "zip"
            | "7z"
            | "docx"
            | "xlsx"
            | "pptx"
    )
}

pub(crate) fn capture(action: &str, value: &Value) -> Vec<ResultFile> {
    let (label, path) = match action {
        "export" => ("导出文件", value["path"].as_str()),
        "export_configuration" => ("配置导出文件", value["path"].as_str()),
        "apply_resource_download" if value["complete"] == true => {
            ("下载文件", value["archivePath"].as_str())
        }
        _ => return Vec::new(),
    };
    let Some(path) = path else { return Vec::new() };
    // Only known backend receipts supply file paths. Never infer one from logs,
    // user arguments, previews, or text printed by a third-party executable.
    if !valid_location(Path::new(path)) {
        return Vec::new();
    }
    let metadata = checked_metadata(Path::new(path)).ok();
    if metadata.as_ref().is_some_and(|value| !value.is_file()) {
        return Vec::new();
    }
    vec![ResultFile {
        id: uuid::Uuid::new_v4().to_string(),
        label: label.into(),
        path: path.into(),
        bytes: metadata.as_ref().map(fs::Metadata::len),
        modified_millis: metadata.as_ref().and_then(modified),
    }]
}

impl ResultFile {
    fn folder(&self) -> Result<PathBuf, String> {
        let parent = Path::new(&self.path)
            .parent()
            .ok_or("结果没有可打开的目录")?;
        if !checked_metadata(parent)?.is_dir() {
            return Err("结果目录已不存在".into());
        }
        Ok(parent.into())
    }
    fn resolved(&self, folder: bool, basic_mode: bool) -> Result<PathBuf, String> {
        if folder {
            return self.folder();
        }
        if basic_mode {
            return Err("基本模式只允许查看结果位置和打开目录".into());
        }
        let path = Path::new(&self.path);
        if !checked_metadata(path)?.is_file() {
            return Err("结果文件已不存在或类型已变化".into());
        }
        if !document_type(path) {
            return Err("此类型只提供打开目录，请在目录中自行处理".into());
        }
        Ok(path.into())
    }
    fn inspect(&self) -> Value {
        let path = Path::new(&self.path);
        let (status, reason) = match checked_metadata(path) {
            Ok(metadata) if !metadata.is_file() => {
                ("unavailable", "原结果位置已不是文件".to_string())
            }
            Ok(metadata)
                if self.bytes.is_some_and(|bytes| metadata.len() != bytes)
                    || self
                        .modified_millis
                        .is_some_and(|stamp| modified(&metadata) != Some(stamp)) =>
            {
                (
                    "changed",
                    "文件在任务完成后已有变化；打开的是当前位置的文件".to_string(),
                )
            }
            Ok(_) => ("available", "".to_string()),
            Err(error) => ("unavailable", error),
        };
        json!({"id":self.id,"label":self.label,"path":self.path,"bytes":self.bytes,
            "status":status,"reason":reason,"canOpen":status != "unavailable" && document_type(path),"canOpenFolder":self.folder().is_ok()})
    }
}

pub(crate) fn inspect(files: &[ResultFile]) -> Vec<Value> {
    files.iter().map(ResultFile::inspect).collect()
}

pub(crate) fn open(
    files: &[ResultFile],
    id: &str,
    folder: bool,
    basic_mode: bool,
) -> Result<Value, String> {
    let item = files
        .iter()
        .find(|item| item.id == id)
        .ok_or("结果索引已不存在，请重新读取记录")?;
    let path = item.resolved(folder, basic_mode)?;
    #[cfg(windows)]
    let mut command = std::process::Command::new("explorer.exe");
    #[cfg(not(windows))]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .arg(&path)
        .spawn()
        .map_err(|error| format!("无法打开结果位置：{error}"))?;
    Ok(json!({"opened":true,"path":path}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> tempfile::TempDir {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("work/task-output-tests");
        fs::create_dir_all(&root).unwrap();
        tempfile::tempdir_in(root).unwrap()
    }
    #[test]
    fn receipts_only_index_real_completed_outputs_and_roundtrip_without_contents() {
        let dir = fixture();
        let path = dir.path().join("result.zip");
        fs::write(&path, "synthetic-content-not-in-history").unwrap();
        let files = capture("export", &json!({"path":path}));
        assert_eq!(files.len(), 1);
        let data = serde_json::to_string(&files).unwrap();
        assert!(!data.contains("synthetic-content-not-in-history"));
        let restored: Vec<ResultFile> = serde_json::from_str(&data).unwrap();
        assert_eq!(inspect(&restored)[0]["status"], "available");
        assert_eq!(restored[0].resolved(false, false).unwrap(), path);
        assert!(restored[0].resolved(false, true).is_err());
        assert_eq!(restored[0].resolved(true, true).unwrap(), dir.path());
        for action in [
            "preview_resource_download",
            "resource_invoke",
            "resource_result",
        ] {
            assert!(capture(
                action,
                &json!({"path":path,"archivePath":path,"complete":true})
            )
            .is_empty());
        }
        assert!(capture(
            "apply_resource_download",
            &json!({"archivePath":path,"complete":false})
        )
        .is_empty());
        assert_eq!(
            capture(
                "apply_resource_download",
                &json!({"archivePath":path,"complete":true})
            )
            .len(),
            1
        );
        assert!(capture("export", &json!({"path":dir.path()})).is_empty());
        let missing = capture(
            "export",
            &json!({"path":dir.path().join("already-moved.zip")}),
        );
        assert_eq!(missing.len(), 1);
        assert_eq!(inspect(&missing)[0]["status"], "unavailable");
    }
    #[test]
    fn missing_changed_and_executable_files_keep_the_index_but_are_not_blindly_opened() {
        let dir = fixture();
        let path = dir.path().join("result.txt");
        fs::write(&path, "one").unwrap();
        let files = capture("export", &json!({"path":path}));
        fs::write(&path, "changed output").unwrap();
        assert_eq!(inspect(&files)[0]["status"], "changed");
        fs::remove_file(&path).unwrap();
        assert_eq!(inspect(&files)[0]["status"], "unavailable");
        assert_eq!(inspect(&files)[0]["canOpenFolder"], true);
        assert!(files[0].resolved(false, false).is_err());
        fs::create_dir(&path).unwrap();
        assert_eq!(inspect(&files)[0]["canOpen"], false);
        let executable = dir.path().join("result.cmd");
        fs::write(&executable, "synthetic").unwrap();
        let executable = capture("export", &json!({"path":executable}));
        assert_eq!(inspect(&executable)[0]["canOpen"], false);
        assert!(executable[0].resolved(false, false).is_err());
        assert!(checked_metadata(Path::new("relative.zip")).is_err());
        assert!(checked_metadata(&dir.path().join("../outside.zip")).is_err());
        assert!(open(&files, "foreign-index", true, false).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn a_result_parent_replaced_with_a_junction_is_reported_and_cannot_be_opened() {
        let dir = fixture();
        let original = dir.path().join("original");
        let outside = dir.path().join("outside");
        fs::create_dir(&original).unwrap();
        fs::create_dir(&outside).unwrap();
        let path = original.join("result.txt");
        fs::write(&path, b"saved").unwrap();
        let files = capture("export", &json!({"path":path}));
        fs::remove_file(&path).unwrap();
        fs::remove_dir(&original).unwrap();
        fs::write(outside.join("result.txt"), b"external").unwrap();
        junction::create(&outside, &original).unwrap();
        assert_eq!(inspect(&files)[0]["canOpen"], false);
        assert_eq!(inspect(&files)[0]["canOpenFolder"], false);
        assert!(files[0].resolved(false, false).is_err());
        assert!(files[0].resolved(true, false).is_err());
        assert_eq!(fs::read(outside.join("result.txt")).unwrap(), b"external");
        junction::delete(&original).unwrap();
    }
}
