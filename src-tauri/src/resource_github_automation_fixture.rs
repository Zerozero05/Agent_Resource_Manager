//! Test-only source selection. Transfers reuse the existing loopback HTTP Source
//! fixture, while staging, process probes and switching remain production code.
use super::*;
use std::{
    cell::RefCell,
    collections::BTreeMap,
    sync::{Arc, Mutex, OnceLock},
};

struct Registered {
    repository: String,
    repository_id: u64,
    releases: Vec<Value>,
    bytes: Vec<u8>,
    transfers: Mutex<Vec<(u64, u64)>>,
}

fn registry() -> &'static Mutex<BTreeMap<PathBuf, Arc<Registered>>> {
    static SOURCES: OnceLock<Mutex<BTreeMap<PathBuf, Arc<Registered>>>> = OnceLock::new();
    SOURCES.get_or_init(Mutex::default)
}

thread_local! {
    static CURRENT: RefCell<Option<Arc<Registered>>> = const { RefCell::new(None) };
}

pub(crate) struct Registration {
    directory: PathBuf,
    source: Arc<Registered>,
}

impl Registration {
    pub(crate) fn transfers(&self) -> Vec<(u64, u64)> {
        self.source.transfers.lock().unwrap().clone()
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        registry().lock().unwrap().remove(&self.directory);
    }
}

pub(crate) fn register(
    manager: &Manager,
    repository: &str,
    repository_id: u64,
    releases: Vec<Value>,
    bytes: Vec<u8>,
) -> Registration {
    let source = Arc::new(Registered {
        repository: repository
            .trim_start_matches("https://github.com/")
            .to_owned(),
        repository_id,
        releases,
        bytes,
        transfers: Mutex::new(Vec::new()),
    });
    let directory = manager.data_dir.clone();
    assert!(registry()
        .lock()
        .unwrap()
        .insert(directory.clone(), source.clone())
        .is_none());
    Registration { directory, source }
}

pub(crate) struct Context(Option<Arc<Registered>>);

impl Drop for Context {
    fn drop(&mut self) {
        CURRENT.with(|slot| *slot.borrow_mut() = self.0.take());
    }
}

pub(crate) fn enter(manager: &Manager) -> Context {
    let selected = registry().lock().unwrap().get(&manager.data_dir).cloned();
    Context(CURRENT.with(|slot| slot.replace(selected)))
}

struct LocalSource {
    registered: Arc<Registered>,
    transport: super::tests::Fixture,
}

fn source(repository: &str) -> Option<Result<LocalSource, String>> {
    CURRENT
        .with(|slot| slot.borrow().clone())
        .map(|registered| {
            if repository.trim_start_matches("https://github.com/") != registered.repository {
                return Err(
                    "Synthetic automation source mismatch; real transport is forbidden".into(),
                );
            }
            Ok(LocalSource {
                transport: super::tests::Fixture::automation_transport(registered.bytes.clone()),
                registered,
            })
        })
}

impl Source for LocalSource {
    fn get(&self, segments: &[&str], _fresh: bool) -> Result<Value, String> {
        if segments.is_empty() {
            return Ok(
                json!({"id":self.registered.repository_id,"full_name":self.registered.repository}),
            );
        }
        if segments == ["releases"] {
            return Ok(json!(self.registered.releases));
        }
        for release in &self.registered.releases {
            if segments == ["releases", "tags", release["tag_name"].as_str().unwrap()]
                || segments == ["releases", &release["id"].to_string()]
            {
                return Ok(release.clone());
            }
            for asset in release["assets"].as_array().unwrap() {
                if segments == ["releases", "assets", &asset["id"].to_string()] {
                    return Ok(asset.clone());
                }
            }
        }
        Err("Unexpected synthetic metadata request; real transport is forbidden".into())
    }

    fn open(
        &self,
        asset: &Asset,
        start: u64,
        end: u64,
        etag: Option<&str>,
    ) -> Result<Response, String> {
        self.registered.transfers.lock().unwrap().push((start, end));
        self.transport.open(asset, start, end, etag)
    }
}

pub(crate) fn source_metadata(
    repository: &str,
    selection: Option<(u64, u64)>,
) -> Option<Result<crate::resource_source::SourceBinding, String>> {
    source(repository).map(|result| {
        let source = result?;
        let mapped = selection
            .map(|(release_id, asset_id)| {
                let (release, asset) =
                    release_asset(&source, &source.registered.repository, release_id, asset_id)?;
                Ok::<_, String>(crate::resource_source::AssetMapping {
                    release_id,
                    asset_id: asset.id,
                    tag: text(&release, "tag_name", 160)?,
                    asset_name: asset.name,
                    size: asset.size,
                    digest: asset.digest,
                    url: asset.url,
                    updated_at: asset.updated_at,
                })
            })
            .transpose()?;
        Ok(crate::resource_source::SourceBinding {
            repository: format!("https://github.com/{}", source.registered.repository),
            repository_id: source.registered.repository_id,
            asset: mapped,
            verified_at: crate::model::now(),
        })
    })
}

pub(crate) fn handle(
    manager: &mut Manager,
    request: &Value,
) -> Option<Result<Option<Value>, String>> {
    if !matches!(
        request["action"].as_str(),
        Some("resource_github_releases" | "preview_resource_download")
    ) {
        return None;
    }
    let active = CURRENT.with(|slot| slot.borrow().is_some());
    if !active {
        return None;
    }
    Some((|| {
        let (repository, _, _) = location(request)?;
        let source = source(&repository).ok_or("Missing synthetic source context")??;
        if request["action"] == "resource_github_releases" {
            list(&source, &repository, request).map(Some)
        } else {
            preview(manager, &source, &repository, request).map(Some)
        }
    })())
}

pub(crate) fn apply_local(
    manager: &mut Manager,
    request: &Value,
) -> Option<Result<Option<Value>, String>> {
    if request["action"] != "apply_resource_download"
        || !CURRENT.with(|slot| slot.borrow().is_some())
    {
        return None;
    }
    Some((|| {
        let saved = manager
            .previews
            .get(
                request["previewId"]
                    .as_str()
                    .ok_or("Missing synthetic preview")?,
            )
            .ok_or("Missing synthetic preview")?;
        let repository = saved["prepared"]["repo"]
            .as_str()
            .ok_or("Missing synthetic repository")?;
        let source = source(repository).ok_or("Missing synthetic source context")??;
        apply(manager, Some(&source), request).map(Some)
    })())
}
