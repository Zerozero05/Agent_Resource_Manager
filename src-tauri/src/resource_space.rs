//! On-demand logical file sizes with bounded ownership-metadata checks.
//! Runtime content is not read; links are not followed and nothing is cleaned.
use crate::{
    model::{now, Manager},
    resource_files::FileRole,
    resource_relations::Endpoint,
    resources::{ResourceRecord, StoreRequest},
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
    time::{Duration, Instant},
};

#[derive(Default)]
struct Scan {
    bytes: u64,
    files: usize,
    visited: usize,
    skipped: usize,
    partial: bool,
    buckets: BTreeMap<&'static str, (u64, usize)>,
    reasons: BTreeSet<String>,
    file_ids: BTreeSet<String>,
}
struct Limits {
    started: Instant,
    entries: usize,
    duration: Duration,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            started: Instant::now(),
            entries: 100_000,
            duration: Duration::from_secs(3),
        }
    }
}
fn key(path: &str) -> String {
    let path = path.replace('\\', "/");
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path
    }
}
fn category(role: &FileRole) -> &'static str {
    match role {
        FileRole::Runtime | FileRole::License => "runtime",
        FileRole::PrivateDependency => "privateDependency",
        FileRole::Cache => "cache",
        FileRole::Configuration | FileRole::UserData | FileRole::LocalModification => "userData",
    }
}
impl Scan {
    fn skip(&mut self, reason: &str) {
        self.skipped += 1;
        self.partial = true;
        if self.reasons.len() < 12 {
            self.reasons.insert(reason.into());
        }
    }
    fn visit(
        &mut self,
        root: &Path,
        dir: &Path,
        roles: &BTreeMap<String, &'static str>,
        limits: &Limits,
        depth: usize,
    ) -> Result<(), String> {
        if crate::transaction::verify_root(dir).is_err() {
            self.skip("目录在读取前已变化或经过链接，未继续统计");
            return Ok(());
        }
        if depth > 64 {
            self.skip("部分目录层级过深，未继续读取");
            return Ok(());
        }
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(_) => {
                self.skip("部分目录无法读取，大小未知");
                return Ok(());
            }
        };
        for entry in entries {
            crate::network::check_cancelled()?;
            if self.visited >= limits.entries || limits.started.elapsed() >= limits.duration {
                self.partial = true;
                self.reasons
                    .insert("达到本次统计上限，显示已读取部分；可稍后按需重新统计".into());
                break;
            }
            self.visited += 1;
            let Ok(entry) = entry else {
                self.skip("部分目录项无法读取，大小未知");
                continue;
            };
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                self.skip("部分文件已变化或无法读取，大小未知");
                continue;
            };
            #[cfg(windows)]
            let linked = {
                use std::os::windows::fs::MetadataExt;
                metadata.file_attributes() & 0x400 != 0
            };
            #[cfg(not(windows))]
            let linked = metadata.file_type().is_symlink();
            if linked {
                self.skip("链接与目录联接未跟随，目标空间未计入");
                continue;
            }
            if metadata.is_dir() {
                self.visit(root, &path, roles, limits, depth + 1)?;
            } else if metadata.is_file() {
                let identity = match crate::clients::file_identity(&path) {
                    Ok(identity) => identity,
                    Err(_) => {
                        self.skip("部分文件身份无法核对，大小未知");
                        continue;
                    }
                };
                if !self.file_ids.insert(identity) {
                    self.reasons
                        .insert("同一实际文件经多个路径发现，仅统计一次".into());
                    continue;
                }
                let relative = key(&path
                    .strip_prefix(root)
                    .map_err(|error| error.to_string())?
                    .to_string_lossy());
                let bucket = self
                    .buckets
                    .entry(roles.get(&relative).copied().unwrap_or("unknown"))
                    .or_default();
                bucket.0 += metadata.len();
                bucket.1 += 1;
                self.bytes += metadata.len();
                self.files += 1;
            } else {
                self.skip("特殊文件未统计");
            }
        }
        Ok(())
    }
}

pub(crate) fn handle(m: &Manager, request: &Value) -> Result<Option<Value>, String> {
    if request["action"] != "resource_space" {
        return Ok(None);
    }
    let endpoint: Endpoint =
        serde_json::from_value(json!({"kind":request["kind"],"id":request["id"]}))
            .map_err(|_| "请选择已登记的工具或Skill")?;
    let mut roles = BTreeMap::new();
    let mut additional = Vec::<(String, BTreeMap<String, &'static str>)>::new();
    let mut has_previous = false;
    let mut metadata_warnings = Vec::new();
    let root = match endpoint.kind.as_str() {
        "tool" => {
            let record: ResourceRecord =
                serde_json::from_value(m.resource_store(StoreRequest::Get(endpoint.id.clone()))?)
                    .map_err(|error| error.to_string())?;
            if let Some(installation) = record.installation {
                for file in &installation.files {
                    roles.insert(key(&file.path), category(&file.role));
                }
                if let Some(manifest) = &installation.resource_manifest {
                    if crate::resource_manifest::validate_owned(
                        Path::new(&record.root_path),
                        manifest,
                    )
                    .is_ok()
                    {
                        roles.insert(key(&manifest.relative_path), "metadata");
                    } else {
                        metadata_warnings.push("当前管理记录已变化，按未识别用途统计");
                    }
                }
                if let Some(update) = &installation.update_state {
                    let value = json!(update);
                    let previous = value["previous"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|item| (item, true));
                    let retained = value["retainedCandidates"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|item| (&item["candidate"], false));
                    let candidate = value
                        .get("candidate")
                        .filter(|item| !item.is_null())
                        .into_iter()
                        .map(|item| (item, false));
                    for (item, previous) in previous.chain(candidate).chain(retained) {
                        let Some(root) = item["root"].as_str() else {
                            continue;
                        };
                        has_previous |= previous;
                        let mut known = BTreeMap::new();
                        for file in item["files"].as_array().into_iter().flatten() {
                            if let Ok(file) = serde_json::from_value::<
                                crate::resource_files::OwnedFile,
                            >(file.clone())
                            {
                                let group = if matches!(
                                    file.role,
                                    FileRole::Runtime
                                        | FileRole::PrivateDependency
                                        | FileRole::License
                                ) {
                                    if previous {
                                        "previous"
                                    } else {
                                        "candidate"
                                    }
                                } else {
                                    category(&file.role)
                                };
                                known.insert(key(&file.path), group);
                            }
                        }
                        if let Ok(manifest) =
                            serde_json::from_value::<crate::resource_manifest::ManifestRecord>(
                                item["resourceManifest"].clone(),
                            )
                        {
                            if crate::resource_manifest::validate_owned(Path::new(root), &manifest)
                                .is_ok()
                            {
                                known.insert(key(&manifest.relative_path), "metadata");
                            } else {
                                metadata_warnings.push("部分历史管理记录已变化，按未识别用途统计");
                            }
                        }
                        additional.push((root.into(), known));
                    }
                }
            }
            record.root_path
        }
        "skill" => {
            let skill = m.skill(&endpoint.id)?;
            for file in skill["runtimeFiles"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                roles.insert(key(file), "runtime");
            }
            skill["localPath"]
                .as_str()
                .ok_or("该Skill尚无本地运行目录")?
                .into()
        }
        _ => return Err("只支持已登记工具或Skill".into()),
    };
    let root = Path::new(&root);
    crate::transaction::verify_root(root)?;
    if !root.is_dir() {
        return Err("实际运行目录已不存在或无法读取".into());
    }
    let relation = m.relation_store(crate::resource_relations::StoreRequest::List {
        endpoint: endpoint.clone(),
    })?;
    let mut seen = BTreeSet::new();
    let shared: Vec<_> = relation["dependencies"].as_array().into_iter().flatten().filter_map(|edge| {
        let dependency = &edge["dependency"];
        let identity = (dependency["kind"].as_str()?, dependency["id"].as_str()?);
        if dependency["shared"] != true || !seen.insert((identity.0.to_string(), identity.1.to_string())) { return None }
        Some(json!({"kind":identity.0,"id":identity.1,"name":dependency["name"],"exists":dependency["exists"]}))
    }).collect();
    let mut scan = Scan::default();
    let limits = Limits::default();
    scan.visit(root, root, &roles, &limits, 0)?;
    let mut root_keys = BTreeSet::from([key(&crate::local::canonical(root)?.to_string_lossy())]);
    for (other, known) in additional {
        let path = Path::new(&other);
        if crate::transaction::verify_root(path).is_err() || !path.is_dir() {
            scan.skip("部分已登记历史或候选目录无法安全读取，大小未知");
            continue;
        }
        match crate::local::canonical(path) {
            Ok(canonical) if root_keys.insert(key(&canonical.to_string_lossy())) => {
                scan.visit(&canonical, &canonical, &known, &limits, 0)?
            }
            Ok(_) => {}
            Err(_) => scan.skip("部分已登记历史或候选目录无法读取，大小未知"),
        }
    }
    scan.reasons
        .extend(metadata_warnings.into_iter().map(str::to_owned));
    let mut categories: Vec<_> = [
        ("runtime", "当前运行文件与许可"),
        ("privateDependency", "私人依赖"),
        ("cache", "缓存"),
        ("userData", "配置、用户数据与本地改造"),
        ("unknown", "未识别用途"),
    ]
    .into_iter()
    .map(|(id, label)| {
        let (bytes, files) = scan.buckets.get(id).copied().unwrap_or_default();
        json!({"id":id,"label":label,"bytes":bytes,"files":files})
    })
    .collect();
    let previous = scan.buckets.get("previous").copied();
    categories.push(if has_previous { json!({"id":"previous","label":"已保留运行版本","bytes":previous.map(|item| item.0),"files":previous.map(|item| item.1),"reason":if scan.partial { "只计已读取并有归属记录的文件" } else { "依据明确保留版本记录；未识别文件单独统计" }}) }
        else { json!({"id":"previous","label":"上一版本","bytes":null,"files":null,"reason":"尚无独立上一版本记录，不推测目录名称"}) });
    for (id, label) in [("candidate", "候选运行文件"), ("metadata", "资源管理记录")] {
        if let Some((bytes, files)) = scan.buckets.get(id) {
            categories.push(json!({"id":id,"label":label,"bytes":bytes,"files":files}));
        }
    }
    Ok(Some(
        json!({"endpoint":endpoint,"rootPath":root,"scope":if root_keys.len()>1 { "registeredRuntimeRoots" } else { "singleRoot" },"rootCount":root_keys.len(),"scannedAt":now(),"observedBytes":scan.bytes,"fileCount":scan.files,"partial":scan.partial,"skippedCount":scan.skipped,"reasons":scan.reasons,"categories":categories,"sharedDependencies":shared,
        "basis":"本次已登记运行、保留及候选目录内已读取文件的逻辑字节；分类依据已有归属记录，外部共享依赖不加入总计，同一实际文件仅计一次。未跟随链接，不等于磁盘物理分配空间。"}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_statistics_read_the_actual_catalog_shape_and_include_retained_roots_once() {
        let dir = fixture();
        let current = dir.path().join("v2");
        let old = dir.path().join("v1");
        fs::create_dir_all(&current).unwrap();
        fs::create_dir_all(&old).unwrap();
        for (path, size) in [
            (current.join("app.bin"), 7),
            (current.join("private.bin"), 5),
            (old.join("app.bin"), 9),
            (old.join("unknown.txt"), 11),
        ] {
            fs::write(path, vec![0; size]).unwrap();
        }
        let m = Manager::new(dir.path().join("state")).unwrap();
        let inserted = crate::resources::handle(
            &m,
            &json!({"action":"resource_register","name":"tool","kind":"cli","rootPath":current}),
        )
        .unwrap()
        .unwrap();
        let mut record: ResourceRecord =
            serde_json::from_value(inserted["resource"].clone()).unwrap();
        let plain = handle(
            &m,
            &json!({"action":"resource_space","kind":"tool","id":record.id}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(plain["observedBytes"], 12);
        let owned =
            |path: &str, role: &str| json!({"path":path,"role":role,"installedSha256":"synthetic"});
        let previous = json!({"root":old,"version":"v1","archivePath":"","archiveSha256":"","sourceRepository":null,"sourceVersion":null,"downloadSource":null,"files":[owned("app.bin","runtime")],"actions":[],"retainedAt":now(),"reason":"approved prior runtime"});
        record.installation=Some(serde_json::from_value(json!({"schemaVersion":1,"installedAt":now(),"archivePath":"","archiveSha256":"","sourceRepository":null,"sourceVersion":"v2","files":[owned("app.bin","runtime"),owned("private.bin","privateDependency")],"status":"installed","error":null,
            "updateState":{"candidate":null,"previous":[previous.clone(),previous],"retainedCandidates":[],"lastFailure":null}})).unwrap());
        record.revision += 1;
        m.resource_store(StoreRequest::Replace {
            record: Box::new(record.clone()),
            expected_revision: 1,
        })
        .unwrap();
        let before = m
            .resource_store(StoreRequest::Get(record.id.clone()))
            .unwrap();
        let stats = handle(
            &m,
            &json!({"action":"resource_space","kind":"tool","id":record.id}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(stats["observedBytes"], 32);
        assert_eq!(stats["fileCount"], 4);
        assert_eq!(stats["rootCount"], 2);
        assert_eq!(stats["scope"], "registeredRuntimeRoots");
        let rows = stats["categories"].as_array().unwrap();
        assert_eq!(
            rows.iter().find(|row| row["id"] == "previous").unwrap()["bytes"],
            9
        );
        assert_eq!(
            rows.iter().find(|row| row["id"] == "unknown").unwrap()["bytes"],
            11
        );
        assert_eq!(
            before,
            m.resource_store(StoreRequest::Get(record.id)).unwrap()
        );
        assert!(old.join("unknown.txt").is_file());
    }

    #[test]
    fn logical_space_does_not_double_count_a_hardlinked_file() {
        let dir = fixture();
        fs::write(dir.path().join("one.bin"), b"logical").unwrap();
        fs::hard_link(dir.path().join("one.bin"), dir.path().join("two.bin")).unwrap();
        let mut scan = Scan::default();
        scan.visit(
            dir.path(),
            dir.path(),
            &BTreeMap::new(),
            &Limits::default(),
            0,
        )
        .unwrap();
        assert_eq!((scan.bytes, scan.files, scan.partial), (7, 1, false));
        assert!(scan
            .reasons
            .iter()
            .any(|reason| reason.contains("仅统计一次")));
    }
    fn fixture() -> tempfile::TempDir {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("work/resource-space-tests");
        fs::create_dir_all(&root).unwrap();
        tempfile::tempdir_in(root).unwrap()
    }
    #[test]
    fn scan_counts_observed_files_once_and_keeps_unknown_classification_explicit() {
        let dir = fixture();
        fs::create_dir(dir.path().join("nested")).unwrap();
        for (file, bytes) in [
            ("app.bin", 7),
            ("nested/private.bin", 11),
            ("notes.txt", 13),
        ] {
            fs::write(dir.path().join(file), vec![0; bytes]).unwrap();
        }
        let roles = BTreeMap::from([
            (key("app.bin"), "runtime"),
            (key("nested/private.bin"), "privateDependency"),
        ]);
        let mut scan = Scan::default();
        scan.visit(
            dir.path(),
            dir.path(),
            &roles,
            &Limits {
                entries: 100,
                ..Limits::default()
            },
            0,
        )
        .unwrap();
        assert_eq!((scan.bytes, scan.files, scan.partial), (31, 3, false));
        assert_eq!(scan.buckets["runtime"], (7, 1));
        assert_eq!(scan.buckets["privateDependency"], (11, 1));
        assert_eq!(scan.buckets["unknown"], (13, 1));
        assert!(dir.path().join("notes.txt").is_file());
        let mut bounded = Scan::default();
        bounded
            .visit(
                dir.path(),
                dir.path(),
                &roles,
                &Limits {
                    entries: 0,
                    ..Limits::default()
                },
                0,
            )
            .unwrap();
        assert!(bounded.partial);
        assert_eq!(bounded.bytes, 0);
        assert!(!bounded.reasons.is_empty());
    }
    #[test]
    fn registered_skill_statistics_are_read_only_and_do_not_invent_previous_versions() {
        let dir = fixture();
        let runtime = dir.path().join("skill");
        fs::create_dir(&runtime).unwrap();
        fs::write(runtime.join("SKILL.md"), "synthetic").unwrap();
        let mut m = Manager::new(dir.path().join("state")).unwrap();
        m.state
            .skills
            .push(json!({"id":"one","name":"one","localPath":runtime,"runtimeFiles":["SKILL.md"]}));
        m.save().unwrap();
        let before = m.snapshot();
        let value = handle(
            &m,
            &json!({"action":"resource_space","kind":"skill","id":"one"}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(value["observedBytes"], 9);
        assert_eq!(value["categories"][0]["bytes"], 9);
        assert!(value["categories"][5]["bytes"].is_null());
        let mut after = m.snapshot();
        // The transport epoch is process-global and may advance in another
        // parallel test; it is not a write to this manager's persistent state.
        after["readGeneration"] = before["readGeneration"].clone();
        assert_eq!(before, after);
        assert!(handle(
            &m,
            &json!({"action":"resource_space","kind":"directory","id":"one","path":"D:/"})
        )
        .is_err());
    }

    #[test]
    fn shared_external_dependencies_are_not_added_to_each_consumers_total_and_basic_reads_work() {
        let dir = fixture();
        let mut m = Manager::new(dir.path().join("state")).unwrap();
        for id in ["one", "two", "shared"] {
            let root = dir.path().join(id);
            fs::create_dir(&root).unwrap();
            fs::write(
                root.join("SKILL.md"),
                if id == "shared" {
                    "shared dependency bytes"
                } else {
                    "local"
                },
            )
            .unwrap();
            m.state
                .skills
                .push(json!({"id":id,"name":id,"localPath":root,"runtimeFiles":["SKILL.md"]}));
        }
        m.save().unwrap();
        for id in ["one", "two"] {
            let revision = m
                .relation_store(crate::resource_relations::StoreRequest::List {
                    endpoint: Endpoint {
                        kind: "skill".into(),
                        id: id.into(),
                    },
                })
                .unwrap()["revision"]
                .as_u64()
                .unwrap();
            m.relation_store(crate::resource_relations::StoreRequest::Add {
                dependent: Endpoint {
                    kind: "skill".into(),
                    id: id.into(),
                },
                dependency: Endpoint {
                    kind: "skill".into(),
                    id: "shared".into(),
                },
                expected_revision: revision,
            })
            .unwrap();
        }
        let request = json!({"action":"resource_space","kind":"skill","id":"one"});
        let normal = crate::dispatch(&mut m, &request).unwrap();
        assert_eq!(normal["observedBytes"], 5);
        assert_eq!(normal["sharedDependencies"].as_array().unwrap().len(), 1);
        assert_eq!(normal["sharedDependencies"][0]["id"], "shared");
        let mut basic = Manager::with_storage_mode(m.storage.clone(), true).unwrap();
        let read = crate::dispatch(&mut basic, &request).unwrap();
        assert_eq!(read["observedBytes"], normal["observedBytes"]);
        assert_eq!(read["sharedDependencies"], normal["sharedDependencies"]);
    }

    #[cfg(windows)]
    #[test]
    fn scanning_never_follows_a_junction_or_counts_its_target() {
        let dir = fixture();
        let root = dir.path().join("runtime");
        let outside = dir.path().join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(root.join("app.bin"), b"own").unwrap();
        fs::write(outside.join("private.bin"), b"not counted").unwrap();
        let link = root.join("linked");
        junction::create(&outside, &link).unwrap();
        let mut scan = Scan::default();
        scan.visit(&root, &root, &BTreeMap::new(), &Limits::default(), 0)
            .unwrap();
        assert_eq!(scan.bytes, 3);
        assert_eq!(scan.skipped, 1);
        assert!(scan.partial);
        assert_eq!(
            fs::read(outside.join("private.bin")).unwrap(),
            b"not counted"
        );
        junction::delete(&link).unwrap();
    }
}
