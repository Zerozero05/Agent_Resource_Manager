//! Explicit use/dependency relationships. An edge never grants ownership or file access.
use crate::{
    model::{now, Manager, State},
    resources::ResourceRecord,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
pub(crate) struct Endpoint {
    pub kind: String,
    pub id: String,
}

pub(crate) enum StoreRequest {
    List {
        endpoint: Endpoint,
    },
    Add {
        dependent: Endpoint,
        dependency: Endpoint,
        expected_revision: u64,
    },
    Remove {
        id: String,
        expected_revision: u64,
    },
}
impl StoreRequest {
    pub(crate) fn writes(&self) -> bool {
        !matches!(self, Self::List { .. })
    }
}
struct Edge {
    id: String,
    dependent: Endpoint,
    dependency: Endpoint,
    created_at: String,
}

fn table_exists(db: &Connection, name: &str) -> Result<bool, String> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}
pub(crate) fn revision(db: &Connection) -> Result<u64, String> {
    if !table_exists(db, "resource_relations_meta")? {
        return Ok(0);
    }
    db.query_row(
        "SELECT revision FROM resource_relations_meta WHERE id=1",
        [],
        |row| row.get(0),
    )
    .optional()
    .map(|value| value.unwrap_or(0))
    .map_err(|e| e.to_string())
}
pub(crate) fn initialize(db: &Connection) -> Result<u64, String> {
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS resource_relations (
        id TEXT PRIMARY KEY, dependent_kind TEXT NOT NULL CHECK(dependent_kind IN ('tool','skill')),
        dependent_id TEXT NOT NULL, dependency_kind TEXT NOT NULL CHECK(dependency_kind IN ('tool','skill')),
        dependency_id TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(dependent_kind,dependent_id,dependency_kind,dependency_id),
        CHECK(dependent_kind != dependency_kind OR dependent_id != dependency_id)
    ); CREATE TABLE IF NOT EXISTS resource_relations_meta (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);").map_err(|e|e.to_string())?;
    let revision = revision(&tx)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(revision)
}
fn edges(db: &Connection) -> Result<Vec<Edge>, String> {
    if !table_exists(db, "resource_relations")? {
        return Ok(Vec::new());
    }
    let mut query=db.prepare("SELECT id,dependent_kind,dependent_id,dependency_kind,dependency_id,created_at FROM resource_relations ORDER BY rowid").map_err(|e|e.to_string())?;
    let rows = query
        .query_map([], |row| {
            Ok(Edge {
                id: row.get(0)?,
                dependent: Endpoint {
                    kind: row.get(1)?,
                    id: row.get(2)?,
                },
                dependency: Endpoint {
                    kind: row.get(3)?,
                    id: row.get(4)?,
                },
                created_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.map(|row| row.map_err(|e| e.to_string())).collect()
}

fn nonempty(value: &Value, key: &str) -> bool {
    value[key].as_str().is_some_and(|value| !value.is_empty())
}
fn tool_ownership(record: &ResourceRecord) -> &'static str {
    if record.ownership == "external" {
        "external"
    } else if record.ownership == "managedFiles"
        && record
            .installation
            .as_ref()
            .is_some_and(|installed| installed.schema_version == 1 && !installed.files.is_empty())
    {
        "managed"
    } else {
        "unknown"
    }
}
fn skill_ownership(skill: &Value) -> &'static str {
    if skill["readOnly"] == true {
        "external"
    } else if nonempty(skill, "localPath")
        && nonempty(skill, "installedCommit")
        && skill["baselineKind"] == "installation"
        && skill["runtimeConfirmed"] == true
    {
        "managed"
    } else {
        "unknown"
    }
}
fn endpoints(state: &State, resources: &[ResourceRecord]) -> BTreeMap<Endpoint, Value> {
    let mut endpoints = BTreeMap::new();
    for record in resources {
        let endpoint = Endpoint {
            kind: "tool".into(),
            id: record.id.clone(),
        };
        endpoints.insert(endpoint.clone(),json!({"kind":endpoint.kind,"id":endpoint.id,"name":record.name,"exists":true,"ownership":tool_ownership(record),"shared":false}));
    }
    for skill in &state.skills {
        let Some(id) = skill["id"].as_str() else {
            continue;
        };
        let endpoint = Endpoint {
            kind: "skill".into(),
            id: id.into(),
        };
        let name = skill["displayName"]
            .as_str()
            .filter(|name| !name.trim().is_empty())
            .or_else(|| skill["name"].as_str())
            .unwrap_or(id);
        endpoints.insert(endpoint.clone(),json!({"kind":endpoint.kind,"id":endpoint.id,"name":name,"exists":true,"ownership":skill_ownership(skill),"shared":false}));
    }
    endpoints
}
fn snapshot(
    db: &Connection,
    endpoint: &Endpoint,
    known: &BTreeMap<Endpoint, Value>,
) -> Result<Value, String> {
    let edges = edges(db)?;
    if !known.contains_key(endpoint)
        && !edges
            .iter()
            .any(|edge| &edge.dependent == endpoint || &edge.dependency == endpoint)
    {
        return Err("资源端点不存在，请重新读取目录".into());
    }
    let mut users: BTreeMap<&Endpoint, usize> = BTreeMap::new();
    for edge in &edges {
        *users.entry(&edge.dependency).or_default() += 1;
    }
    let summary = |endpoint: &Endpoint| {
        let mut value=known.get(endpoint).cloned().unwrap_or_else(||json!({"kind":endpoint.kind,"id":endpoint.id,"name":endpoint.id,"exists":false,"ownership":"unknown"}));
        value["shared"] = json!(users.get(endpoint).copied().unwrap_or(0) > 1);
        value
    };
    let public_edge = |edge: &Edge| json!({"id":edge.id,"dependent":summary(&edge.dependent),"dependency":summary(&edge.dependency),"createdAt":edge.created_at});
    let dependencies: Vec<_> = edges
        .iter()
        .filter(|edge| &edge.dependent == endpoint)
        .map(&public_edge)
        .collect();
    let dependents: Vec<_> = edges
        .iter()
        .filter(|edge| &edge.dependency == endpoint)
        .map(&public_edge)
        .collect();
    let candidates: Vec<_> = known
        .keys()
        .filter(|candidate| *candidate != endpoint)
        .map(&summary)
        .collect();
    Ok(
        json!({"revision":revision(db)?,"endpoint":summary(endpoint),"dependencies":dependencies,"dependents":dependents,"candidates":candidates}),
    )
}

/// The caller supplies live state/catalog while holding the single writer lock.
pub(crate) fn store(
    db: &Connection,
    state: &State,
    resources: &[ResourceRecord],
    request: StoreRequest,
    state_revision: u64,
) -> Result<(Value, bool), String> {
    let known = endpoints(state, resources);
    if let StoreRequest::List { endpoint } = request {
        return Ok((snapshot(db, &endpoint, &known)?, false));
    }
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    let expected = match &request {
        StoreRequest::Add {
            expected_revision, ..
        }
        | StoreRequest::Remove {
            expected_revision, ..
        } => *expected_revision,
        _ => unreachable!(),
    };
    if expected != revision(&tx)? {
        return Err("依赖关系已在其他位置变化，请重新读取后操作".into());
    }
    let (endpoint, changed) = match request {
        StoreRequest::Add {
            dependent,
            dependency,
            ..
        } => {
            if dependent == dependency {
                return Err("资源不能依赖自身".into());
            }
            if !known.contains_key(&dependent) || !known.contains_key(&dependency) {
                return Err("资源端点不存在，未保存依赖关系".into());
            }
            let existing:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM resource_relations WHERE dependent_kind=?1 AND dependent_id=?2 AND dependency_kind=?3 AND dependency_id=?4)",params![dependent.kind,dependent.id,dependency.kind,dependency.id],|row|row.get(0)).map_err(|e|e.to_string())?;
            if !existing {
                tx.execute("INSERT INTO resource_relations(id,dependent_kind,dependent_id,dependency_kind,dependency_id,created_at) VALUES(?1,?2,?3,?4,?5,?6)",params![uuid::Uuid::new_v4().to_string(),dependent.kind,dependent.id,dependency.kind,dependency.id,now()]).map_err(|e|e.to_string())?;
            }
            (dependent, !existing)
        }
        StoreRequest::Remove { id, .. } => {
            let dependent = tx
                .query_row(
                    "SELECT dependent_kind,dependent_id FROM resource_relations WHERE id=?1",
                    [&id],
                    |row| {
                        Ok(Endpoint {
                            kind: row.get(0)?,
                            id: row.get(1)?,
                        })
                    },
                )
                .optional()
                .map_err(|e| e.to_string())?
                .ok_or("依赖关系不存在或已移除，请重新读取")?;
            tx.execute("DELETE FROM resource_relations WHERE id=?1", [id])
                .map_err(|e| e.to_string())?;
            (dependent, true)
        }
        _ => unreachable!(),
    };
    if changed {
        tx.execute("INSERT INTO resource_relations_meta(id,revision) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision",[state_revision]).map_err(|e|e.to_string())?;
    }
    // Removing the final edge of a missing dependent must still return its page.
    let mut response_known = known;
    response_known.entry(endpoint.clone()).or_insert_with(||json!({"kind":endpoint.kind,"id":endpoint.id,"name":endpoint.id,"exists":false,"ownership":"unknown","shared":false}));
    let result = snapshot(&tx, &endpoint, &response_known)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok((result, changed))
}

fn fields(request: &Value, allowed: &[&str]) -> Result<(), String> {
    if request
        .as_object()
        .ok_or("请求必须是对象")?
        .keys()
        .any(|key| !allowed.contains(&key.as_str()))
    {
        return Err("依赖关系请求包含不支持的字段".into());
    }
    Ok(())
}
fn endpoint(value: &Value) -> Result<Endpoint, String> {
    let endpoint: Endpoint =
        serde_json::from_value(value.clone()).map_err(|_| "端点必须仅包含 kind 和 id")?;
    if !matches!(endpoint.kind.as_str(), "tool" | "skill")
        || endpoint.id.trim().is_empty()
        || endpoint.id.len() > 160
        || endpoint.id.contains('\0')
    {
        return Err("资源端点类型或标识无效".into());
    }
    Ok(endpoint)
}
fn expected(request: &Value) -> Result<u64, String> {
    request["expectedRevision"]
        .as_u64()
        .filter(|value| *value <= i64::MAX as u64)
        .ok_or_else(|| "需要当前依赖关系 expectedRevision".into())
}
pub(crate) fn handle(manager: &Manager, request: &Value) -> Result<Option<Value>, String> {
    match request["action"].as_str().unwrap_or_default() {
        "resource_relations" => {
            fields(request, &["action", "endpoint"])?;
            Ok(Some(manager.relation_store(StoreRequest::List {
                endpoint: endpoint(&request["endpoint"])?,
            })?))
        }
        "resource_relation_add" | "resource_relation_remove" => {
            Err("依赖关系的新增和移除仅允许在本地管理器界面进行".into())
        }
        _ => Ok(None),
    }
}
pub(crate) fn apply_local(manager: &Manager, request: &Value) -> Result<Option<Value>, String> {
    let operation = match request["action"].as_str().unwrap_or_default() {
        "resource_relation_add" => {
            fields(
                request,
                &["action", "dependent", "dependency", "expectedRevision"],
            )?;
            StoreRequest::Add {
                dependent: endpoint(&request["dependent"])?,
                dependency: endpoint(&request["dependency"])?,
                expected_revision: expected(request)?,
            }
        }
        "resource_relation_remove" => {
            fields(request, &["action", "id", "expectedRevision"])?;
            let id = request["id"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 160 && !id.contains('\0'))
                .ok_or("依赖关系标识无效")?
                .to_owned();
            StoreRequest::Remove {
                id,
                expected_revision: expected(request)?,
            }
        }
        _ => return Ok(None),
    };
    Ok(Some(manager.relation_store(operation)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        path::Path,
        sync::{Arc, Barrier, Mutex},
    };
    fn directory() -> tempfile::TempDir {
        let parent = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("work/resource-relation-tests");
        std::fs::create_dir_all(&parent).unwrap();
        tempfile::tempdir_in(parent).unwrap()
    }
    fn skill(id: &str) -> Endpoint {
        Endpoint {
            kind: "skill".into(),
            id: id.into(),
        }
    }
    fn setup() -> (tempfile::TempDir, Manager, Endpoint) {
        let dir = directory();
        let root = dir.path().join("tool");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("keep.txt"), "original content").unwrap();
        let mut manager = Manager::new(dir.path().join("state")).unwrap();
        manager.state.skills = vec![
            json!({"id":"one","name":"One","localPath":"synthetic","managed":true}),
            json!({"id":"two","name":"Two","readOnly":true}),
        ];
        manager.save().unwrap();
        let resource = crate::resources::handle(
            &manager,
            &json!({"action":"resource_register","name":"Tool","kind":"cli","rootPath":root}),
        )
        .unwrap()
        .unwrap()["resource"]
            .clone();
        (
            dir,
            manager,
            Endpoint {
                kind: "tool".into(),
                id: resource["id"].as_str().unwrap().into(),
            },
        )
    }
    fn list(manager: &Manager, endpoint: &Endpoint) -> Value {
        manager
            .relation_store(StoreRequest::List {
                endpoint: endpoint.clone(),
            })
            .unwrap()
    }
    fn add_request(dependent: &Endpoint, dependency: &Endpoint, revision: u64) -> Value {
        json!({"action":"resource_relation_add","dependent":dependent,"dependency":dependency,"expectedRevision":revision})
    }
    fn add(manager: &Manager, dependent: &Endpoint, dependency: &Endpoint, revision: u64) -> Value {
        apply_local(manager, &add_request(dependent, dependency, revision))
            .unwrap()
            .unwrap()
    }
    fn remove(manager: &Manager, id: &Value, revision: &Value) -> Value {
        apply_local(
            manager,
            &json!({"action":"resource_relation_remove","id":id,"expectedRevision":revision}),
        )
        .unwrap()
        .unwrap()
    }

    #[test]
    fn relations_persist_separately_and_legacy_state_saves_preserve_them_and_files() {
        let (dir, manager, tool) = setup();
        let db = Connection::open(dir.path().join("state/manager.sqlite3")).unwrap();
        let original: String = db
            .query_row("SELECT payload FROM app_state WHERE id=1", [], |r| r.get(0))
            .unwrap();
        let saved = add(&manager, &skill("one"), &tool, 0);
        assert_eq!(saved["endpoint"]["kind"], "skill");
        assert_eq!(saved["dependencies"][0]["dependency"]["id"], tool.id);
        assert_eq!(
            saved["dependencies"][0]["dependency"]["ownership"],
            "external"
        );
        assert_eq!(
            saved["endpoint"]["ownership"], "unknown",
            "path-derived managed flag is not ownership evidence"
        );
        let after: String = db
            .query_row("SELECT payload FROM app_state WHERE id=1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(after, original);
        let state_revision = manager.snapshot()["stateRevision"].clone();
        drop(manager);
        let reopened = Manager::new(dir.path().join("state")).unwrap();
        assert_eq!(reopened.snapshot()["stateRevision"], state_revision);
        assert_eq!(list(&reopened, &skill("one")), saved);
        reopened.save().unwrap();
        assert_eq!(list(&reopened, &skill("one")), saved);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("tool/keep.txt")).unwrap(),
            "original content"
        );
        assert!(serde_json::to_value(&reopened.state)
            .unwrap()
            .get("relations")
            .is_none());
    }

    #[test]
    fn duplicate_add_is_no_op_global_cas_conflicts_and_legal_cycles_are_retained() {
        let (_dir, mut manager, tool) = setup();
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        manager.set_state_events(Arc::new(move |revision| {
            sink.lock().unwrap().push(revision)
        }));
        let first = add(&manager, &skill("one"), &tool, 0);
        let revision = first["revision"].as_u64().unwrap();
        let state_revision = manager.snapshot()["stateRevision"].clone();
        assert_eq!(add(&manager, &skill("one"), &tool, revision), first);
        assert_eq!(manager.snapshot()["stateRevision"], state_revision);
        assert_eq!(events.lock().unwrap().len(), 1);
        assert!(apply_local(&manager, &add_request(&skill("two"), &tool, 0)).is_err());
        let second = add(&manager, &skill("two"), &tool, revision);
        assert_eq!(second["dependencies"][0]["dependency"]["shared"], true);
        let cycle = add(
            &manager,
            &tool,
            &skill("one"),
            second["revision"].as_u64().unwrap(),
        );
        assert_eq!(cycle["dependencies"].as_array().unwrap().len(), 1);
        assert_eq!(cycle["dependents"].as_array().unwrap().len(), 2);
        assert_eq!(events.lock().unwrap().len(), 3);
        let removed = remove(
            &manager,
            &second["dependencies"][0]["id"],
            &cycle["revision"],
        );
        assert_eq!(removed["endpoint"]["id"], "two");
        assert_eq!(removed["dependencies"], json!([]));
        assert_eq!(list(&manager, &tool)["endpoint"]["shared"], false);
    }

    #[test]
    fn unknown_and_invalid_endpoints_are_rejected_and_gui_is_required_for_writes() {
        let (_dir, mut manager, tool) = setup();
        let before = list(&manager, &tool);
        for request in [
            add_request(&skill("missing"), &tool, 0),
            add_request(&skill("one"), &skill("one"), 0),
            json!({"action":"resource_relation_add","dependent":{"kind":"shell","id":"one"},"dependency":tool,"expectedRevision":0}),
            json!({"action":"resource_relation_add","dependent":{"kind":"skill","id":"one","ownership":"managed"},"dependency":tool,"expectedRevision":0}),
        ] {
            assert!(apply_local(&manager, &request).is_err());
        }
        assert!(
            crate::dispatch(&mut manager, &add_request(&skill("one"), &tool, 0))
                .unwrap_err()
                .contains("本地管理器")
        );
        assert_eq!(list(&manager, &tool), before);
        let saved =
            crate::dispatch_local(&mut manager, &add_request(&skill("one"), &tool, 0)).unwrap();
        assert_eq!(saved["dependencies"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn missing_records_keep_relationship_evidence_and_can_remove_only_that_edge() {
        let (dir, mut manager, tool) = setup();
        let first = add(&manager, &skill("one"), &tool, 0);
        let second = add(
            &manager,
            &skill("two"),
            &tool,
            first["revision"].as_u64().unwrap(),
        );
        manager.state.skills.retain(|skill| skill["id"] != "one");
        manager.save().unwrap();
        let snapshot = list(&manager, &tool);
        assert_eq!(snapshot["revision"], second["revision"]);
        assert_eq!(snapshot["dependents"][0]["dependent"]["exists"], false);
        assert_eq!(
            snapshot["dependents"][0]["dependent"]["ownership"],
            "unknown"
        );
        assert_eq!(
            snapshot["endpoint"]["shared"], true,
            "missing dependents do not erase usage evidence"
        );
        assert_eq!(list(&manager, &skill("one"))["endpoint"]["exists"], false);
        let removed = remove(
            &manager,
            &first["dependencies"][0]["id"],
            &second["revision"],
        );
        assert_eq!(removed["endpoint"]["exists"], false);
        assert_eq!(removed["dependencies"], json!([]));
        assert_eq!(
            list(&manager, &tool)["dependents"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("tool/keep.txt")).unwrap(),
            "original content"
        );
    }

    #[test]
    fn failed_commit_keeps_edges_revision_and_state_events_unchanged() {
        let (dir, mut manager, tool) = setup();
        let saved = add(&manager, &skill("one"), &tool, 0);
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        manager.set_state_events(Arc::new(move |revision| {
            sink.lock().unwrap().push(revision)
        }));
        let db = Connection::open(dir.path().join("state/manager.sqlite3")).unwrap();
        db.execute_batch("CREATE TRIGGER fail_relation_commit BEFORE UPDATE ON resource_relations_meta BEGIN SELECT RAISE(ABORT,'synthetic relation transaction failure'); END;").unwrap();
        let state_revision = manager.snapshot()["stateRevision"].clone();
        assert!(apply_local(
            &manager,
            &add_request(&skill("two"), &tool, saved["revision"].as_u64().unwrap())
        )
        .is_err());
        assert!(apply_local(&manager,&json!({"action":"resource_relation_remove","id":saved["dependencies"][0]["id"],"expectedRevision":saved["revision"]})).is_err());
        assert_eq!(list(&manager, &skill("one")), saved);
        assert_eq!(manager.snapshot()["stateRevision"], state_revision);
        assert!(events.lock().unwrap().is_empty());
    }

    #[test]
    fn basic_mode_reads_legacy_database_without_creating_tables_and_rejects_writes() {
        let dir = directory();
        let db = Connection::open(dir.path().join("manager.sqlite3")).unwrap();
        db.execute_batch("CREATE TABLE app_state(id INTEGER PRIMARY KEY,payload TEXT NOT NULL);")
            .unwrap();
        db.execute("INSERT INTO app_state VALUES(1,?1)",[json!({"skills":[{"id":"one","name":"One"},{"id":"two","name":"Two"}],"sources":[],"connections":[],"settings":{}}).to_string()]).unwrap();
        let basic =
            Manager::with_storage_mode(crate::storage::Storage::isolated(dir.path().into()), true)
                .unwrap();
        let snapshot = list(&basic, &skill("one"));
        assert_eq!(snapshot["revision"], 0);
        assert_eq!(snapshot["dependencies"], json!([]));
        assert_eq!(snapshot["candidates"][0]["id"], "two");
        let service = crate::tasks::TaskSystem::new(basic).unwrap();
        assert!(service
            .execute(
                add_request(&skill("one"), &skill("two"), 0),
                crate::dispatch_local
            )
            .unwrap_err()
            .contains("基本模式"));
        assert_eq!(
            service
                .execute(
                    json!({"action":"resource_relations","endpoint":skill("one")}),
                    crate::dispatch
                )
                .unwrap(),
            snapshot
        );
        let tables: u64 = db
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 1);
    }

    #[test]
    fn task_system_concurrent_different_edges_compete_on_one_relation_revision() {
        let (_dir, manager, tool) = setup();
        let service = crate::tasks::TaskSystem::new(manager).unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let workers: Vec<_> = ["one", "two"]
            .into_iter()
            .map(|id| {
                let service = service.clone();
                let barrier = barrier.clone();
                let request = add_request(&skill(id), &tool, 0);
                std::thread::spawn(move || {
                    barrier.wait();
                    service.execute(request, crate::dispatch_local)
                })
            })
            .collect();
        barrier.wait();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        let listed = service
            .execute(
                json!({"action":"resource_relations","endpoint":tool}),
                crate::dispatch,
            )
            .unwrap();
        assert_eq!(listed["dependents"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn ownership_requires_installed_evidence_and_read_only_evidence_takes_precedence() {
        let (_dir, manager, tool) = setup();
        let mut record: ResourceRecord = serde_json::from_value(
            manager
                .resource_store(crate::resources::StoreRequest::Get(tool.id))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(tool_ownership(&record), "external");
        record.ownership = "managedFiles".into();
        assert_eq!(tool_ownership(&record), "unknown");
        record.installation=Some(serde_json::from_value(json!({"schemaVersion":1,"installedAt":"synthetic","archivePath":"synthetic","archiveSha256":"a".repeat(64),"sourceRepository":null,"sourceVersion":null,"files":[],"status":"installing","error":null})).unwrap());
        assert_eq!(tool_ownership(&record), "unknown");
        record
            .installation
            .as_mut()
            .unwrap()
            .files
            .push(crate::resource_files::OwnedFile {
                path: "runtime.exe".into(),
                role: crate::resource_files::FileRole::Runtime,
                installed_sha256: "a".repeat(64),
            });
        assert_eq!(tool_ownership(&record), "managed");
        let mut installed = json!({"localPath":"synthetic","installedCommit":"verified-installation","baselineKind":"installation","runtimeConfirmed":true});
        assert_eq!(skill_ownership(&installed), "managed");
        installed["readOnly"] = json!(true);
        assert_eq!(skill_ownership(&installed), "external");
        assert_eq!(
            skill_ownership(&json!({"managed":true,"baselineCommit":"comparison-only"})),
            "unknown"
        );
    }
}
