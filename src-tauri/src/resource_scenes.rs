//! Scenes select eligibility inside this manager; they never rewrite manual
//! enablement, resource files, client links or running processes.
use crate::{
    model::{Manager, State},
    resource_relations::Endpoint,
    resources::ResourceRecord,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) enum StoreRequest {
    List,
    Eligibility(Endpoint),
    Save {
        id: Option<String>,
        expected_revision: u64,
        name: String,
        members: Vec<Endpoint>,
    },
    Remove {
        id: String,
        expected_revision: u64,
    },
    Activate {
        id: Option<String>,
        expected_revision: u64,
    },
}
impl StoreRequest {
    pub(crate) fn writes(&self) -> bool {
        !matches!(self, Self::List | Self::Eligibility(_))
    }
}
struct Scene {
    id: String,
    name: String,
    members: Vec<Endpoint>,
}

fn exists(db: &Connection, table: &str) -> Result<bool, String> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}
fn metadata(db: &Connection) -> Result<(u64, Option<String>), String> {
    if !exists(db, "resource_scenes_meta")? {
        return Ok((0, None));
    }
    db.query_row(
        "SELECT revision,active_scene_id FROM resource_scenes_meta WHERE id=1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map(|v| v.unwrap_or((0, None)))
    .map_err(|e| e.to_string())
}
pub(crate) fn revision(db: &Connection) -> Result<u64, String> {
    Ok(metadata(db)?.0)
}
pub(crate) fn initialize(db: &Connection) -> Result<u64, String> {
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS resource_scenes (id TEXT PRIMARY KEY,name TEXT NOT NULL,members TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS resource_scenes_meta (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,active_scene_id TEXT);").map_err(|e|e.to_string())?;
    let result = revision(&tx)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(result)
}
fn scenes(db: &Connection) -> Result<Vec<Scene>, String> {
    if !exists(db, "resource_scenes")? {
        return Ok(vec![]);
    }
    let mut query = db
        .prepare("SELECT id,name,members FROM resource_scenes ORDER BY rowid")
        .map_err(|e| e.to_string())?;
    let rows = query
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        let (id, name, members) = row.map_err(|e| e.to_string())?;
        let members =
            serde_json::from_str(&members).map_err(|e| format!("场景成员记录不可读：{e}"))?;
        Ok(Scene { id, name, members })
    })
    .collect()
}

pub(crate) struct Eligibility {
    pub revision: u64,
    pub active_scene_id: Option<String>,
    members: BTreeSet<Endpoint>,
}
impl Eligibility {
    fn allows(&self, endpoint: &Endpoint) -> bool {
        self.active_scene_id.is_none() || self.members.contains(endpoint)
    }
    pub(crate) fn annotate(
        &self,
        endpoint: &Endpoint,
        manual: bool,
        exists: bool,
        value: &mut Value,
    ) {
        let allowed = exists && self.allows(endpoint);
        value["sceneEligible"] = json!(allowed);
        value["sceneReason"] = json!(if !exists {
            "资源已失效，请核对或移除场景中的原引用"
        } else if !allowed {
            "当前场景未包含此资源；仍可浏览和管理"
        } else {
            ""
        });
        value["effectiveEnabled"] = json!(manual && allowed);
    }
}
pub(crate) fn eligibility(db: &Connection) -> Result<Eligibility, String> {
    let (revision, active_scene_id) = metadata(db)?;
    let members = if let Some(id) = &active_scene_id {
        let serialized: String = db
            .query_row(
                "SELECT members FROM resource_scenes WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or("当前场景记录不存在，使用资格无法核对")?;
        serde_json::from_str(&serialized).map_err(|e| format!("场景成员记录不可读：{e}"))?
    } else {
        BTreeSet::new()
    };
    Ok(Eligibility {
        revision,
        active_scene_id,
        members,
    })
}
fn known(state: &State, tools: &[ResourceRecord]) -> BTreeMap<Endpoint, Value> {
    let mut values = BTreeMap::new();
    for tool in tools {
        let e = Endpoint {
            kind: "tool".into(),
            id: tool.id.clone(),
        };
        values.insert(e,json!({"kind":"tool","id":tool.id,"name":tool.name,"exists":true,"enabled":tool.enabled}));
    }
    for skill in &state.skills {
        if let Some(id) = skill["id"].as_str() {
            let name = skill["displayName"]
                .as_str()
                .filter(|v| !v.is_empty())
                .or(skill["name"].as_str())
                .unwrap_or(id);
            values.insert(
                Endpoint {
                    kind: "skill".into(),
                    id: id.into(),
                },
                json!({"kind":"skill","id":id,"name":name,"exists":true,"enabled":true}),
            );
        }
    }
    values
}
fn snapshot(db: &Connection, known: &BTreeMap<Endpoint, Value>) -> Result<Value, String> {
    let context = eligibility(db)?;
    let summary = |e: &Endpoint| {
        let mut v = known.get(e).cloned().unwrap_or_else(
            || json!({"kind":e.kind,"id":e.id,"name":e.id,"exists":false,"enabled":false}),
        );
        let manual = v["enabled"] == true;
        let exists = v["exists"] == true;
        context.annotate(e, manual, exists, &mut v);
        v
    };
    let values:Vec<_>=scenes(db)?.into_iter().map(|s|json!({"id":s.id,"name":s.name,"members":s.members.iter().map(&summary).collect::<Vec<_>>()})).collect();
    Ok(
        json!({"revision":context.revision,"activeSceneId":context.active_scene_id,"scenes":values,"candidates":known.keys().map(summary).collect::<Vec<_>>()}),
    )
}

pub(crate) fn store(
    db: &Connection,
    state: &State,
    tools: &[ResourceRecord],
    request: StoreRequest,
    state_revision: u64,
) -> Result<(Value, bool), String> {
    if let StoreRequest::Eligibility(endpoint) = &request {
        let context = eligibility(db)?;
        let mut value = json!({});
        context.annotate(endpoint, true, true, &mut value);
        return Ok((value, false));
    }
    let known = known(state, tools);
    if matches!(request, StoreRequest::List) {
        return Ok((snapshot(db, &known)?, false));
    }
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    let expected = match &request {
        StoreRequest::Save {
            expected_revision, ..
        }
        | StoreRequest::Remove {
            expected_revision, ..
        }
        | StoreRequest::Activate {
            expected_revision, ..
        } => *expected_revision,
        _ => unreachable!(),
    };
    let (current, mut active) = metadata(&tx)?;
    if expected != current {
        return Err("场景已在其他窗口变化，请重新读取后保存".into());
    }
    let saved = scenes(&tx)?;
    let changed = match request {
        StoreRequest::Save {
            id,
            name,
            mut members,
            ..
        } => {
            let name = name.trim();
            if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
                return Err("场景名称须为1至80个可显示字符".into());
            }
            members.sort();
            members.dedup();
            let old = id
                .as_ref()
                .map(|id| {
                    saved
                        .iter()
                        .find(|s| &s.id == id)
                        .ok_or("场景不存在，请重新读取")
                })
                .transpose()?;
            for e in &members {
                validate_endpoint(e)?;
                if !known.contains_key(e) && !old.is_some_and(|s| s.members.contains(e)) {
                    return Err("场景成员不存在，不能按名称或未知标识新增引用".into());
                }
            }
            if old.is_some_and(|s| s.name == name && s.members == members) {
                false
            } else {
                let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                tx.execute("INSERT INTO resource_scenes(id,name,members) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET name=excluded.name,members=excluded.members",params![id,name,serde_json::to_string(&members).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
                true
            }
        }
        StoreRequest::Remove { id, .. } => {
            if !saved.iter().any(|s| s.id == id) {
                return Err("场景不存在，请重新读取".into());
            }
            tx.execute("DELETE FROM resource_scenes WHERE id=?1", [&id])
                .map_err(|e| e.to_string())?;
            if active.as_ref() == Some(&id) {
                active = None;
            }
            true
        }
        StoreRequest::Activate { id, .. } => {
            if id
                .as_ref()
                .is_some_and(|id| !saved.iter().any(|s| &s.id == id))
            {
                return Err("场景不存在，未切换当前场景".into());
            }
            let changed = active != id;
            active = id;
            changed
        }
        _ => unreachable!(),
    };
    if changed {
        tx.execute("INSERT INTO resource_scenes_meta(id,revision,active_scene_id) VALUES(1,?1,?2) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,active_scene_id=excluded.active_scene_id",params![state_revision,active]).map_err(|e|e.to_string())?;
    }
    let value = snapshot(&tx, &known)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok((value, changed))
}
fn validate_endpoint(e: &Endpoint) -> Result<(), String> {
    if !matches!(e.kind.as_str(), "tool" | "skill")
        || e.id.trim().is_empty()
        || e.id.len() > 160
        || e.id.chars().any(char::is_control)
    {
        return Err("场景成员类型或标识无效".into());
    }
    Ok(())
}
fn fields(v: &Value, allowed: &[&str]) -> Result<(), String> {
    if v.as_object()
        .is_none_or(|o| o.keys().any(|k| !allowed.contains(&k.as_str())))
    {
        return Err("场景请求包含不支持的字段".into());
    }
    Ok(())
}
fn expected(v: &Value) -> Result<u64, String> {
    v["expectedRevision"]
        .as_u64()
        .filter(|n| *n <= i64::MAX as u64)
        .ok_or_else(|| "需要当前场景 expectedRevision".into())
}
fn id(v: &Value) -> Result<String, String> {
    v.as_str()
        .filter(|s| !s.is_empty() && s.len() <= 160 && !s.chars().any(char::is_control))
        .map(str::to_owned)
        .ok_or_else(|| "场景标识无效".into())
}
pub(crate) fn handle(m: &Manager, v: &Value) -> Result<Option<Value>, String> {
    match v["action"].as_str().unwrap_or_default() {
        "resource_scenes" => {
            fields(v, &["action"])?;
            m.scene_store(StoreRequest::List).map(Some)
        }
        "resource_scene_activate" => apply_local(m, v),
        "resource_scene_save" | "resource_scene_remove" => {
            Err("场景定义的保存和移除仅允许在本地管理器界面进行".into())
        }
        _ => Ok(None),
    }
}
pub(crate) fn apply_local(m: &Manager, v: &Value) -> Result<Option<Value>, String> {
    let request = match v["action"].as_str().unwrap_or_default() {
        "resource_scene_save" => {
            fields(v, &["action", "id", "expectedRevision", "name", "members"])?;
            StoreRequest::Save {
                id: v.get("id").map(id).transpose()?,
                expected_revision: expected(v)?,
                name: v["name"].as_str().ok_or("缺少场景名称")?.into(),
                members: serde_json::from_value(v["members"].clone())
                    .map_err(|_| "场景成员须仅包含 kind 和 id")?,
            }
        }
        "resource_scene_remove" => {
            fields(v, &["action", "id", "expectedRevision"])?;
            StoreRequest::Remove {
                id: id(&v["id"])?,
                expected_revision: expected(v)?,
            }
        }
        "resource_scene_activate" => {
            fields(v, &["action", "id", "expectedRevision"])?;
            let value = v.get("id").ok_or("请选择场景或显式传入 null")?;
            StoreRequest::Activate {
                id: if value.is_null() {
                    None
                } else {
                    Some(id(value)?)
                },
                expected_revision: expected(v)?,
            }
        }
        _ => return Ok(None),
    };
    m.scene_store(request).map(Some)
}

/// Keep every registered item visible, including those outside the active scene.
pub(crate) fn decorate(m: &Manager, request: &Value, value: &mut Value) -> Result<(), String> {
    if !matches!(
        request["action"].as_str(),
        Some("resource_list" | "resource_capabilities")
    ) {
        return Ok(());
    }
    let snapshot = m.scene_store(StoreRequest::List)?;
    let candidates = snapshot["candidates"]
        .as_array()
        .ok_or("场景资格结果无效")?;
    let annotate = |record: &mut Value| {
        if let Some(summary) = candidates
            .iter()
            .find(|s| s["kind"] == "tool" && s["id"] == record["id"])
        {
            for field in ["sceneEligible", "sceneReason", "effectiveEnabled"] {
                record[field] = summary[field].clone();
            }
        } else {
            record["sceneEligible"] = json!(false);
            record["effectiveEnabled"] = json!(false);
            record["sceneReason"] = json!("资源已移除，请刷新目录");
        }
    };
    if let Some(items) = value["resources"].as_array_mut() {
        for item in items {
            annotate(item);
        }
    }
    if request["action"] == "resource_capabilities" {
        annotate(value);
        if value["effectiveEnabled"] != true {
            value["actions"] = json!([]);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        path::Path,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Barrier,
        },
    };
    fn setup() -> (tempfile::TempDir, Manager, String) {
        let parent = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("work/resource-scenes-tests");
        std::fs::create_dir_all(&parent).unwrap();
        let dir = tempfile::tempdir_in(parent).unwrap();
        let mut m = Manager::new(dir.path().join("state")).unwrap();
        m.state.skills = vec![
            json!({"id":"skill-one","name":"Skill one"}),
            json!({"id":"skill-two","name":"Skill two"}),
        ];
        m.state.connections = vec![
            json!({"id":"existing-connection","skillId":"skill-two","path":"D:/synthetic/existing-client"}),
        ];
        m.save().unwrap();
        let root = dir.path().join("tool");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("config.json"), "preserve").unwrap();
        let resource = crate::resources::handle(
            &m,
            &json!({"action":"resource_register","name":"Tool","kind":"cli","rootPath":root}),
        )
        .unwrap()
        .unwrap();
        (dir, m, resource["resource"]["id"].as_str().unwrap().into())
    }
    fn list(m: &Manager) -> Value {
        m.scene_store(StoreRequest::List).unwrap()
    }
    fn save(
        m: &Manager,
        id: Option<&str>,
        revision: u64,
        name: &str,
        members: Value,
    ) -> Result<Value, String> {
        let mut request = json!({"action":"resource_scene_save","expectedRevision":revision,"name":name,"members":members});
        if let Some(id) = id {
            request["id"] = json!(id);
        }
        apply_local(m, &request).map(Option::unwrap)
    }
    fn activate(m: &Manager, id: Value, revision: &Value) -> Value {
        apply_local(
            m,
            &json!({"action":"resource_scene_activate","id":id,"expectedRevision":revision}),
        )
        .unwrap()
        .unwrap()
    }

    #[test]
    fn persistence_legacy_save_and_derived_skill_eligibility_preserve_source_data() {
        let (dir, mut m, tool) = setup();
        let original = m.state.clone();
        let saved = save(
            &m,
            None,
            0,
            "Selected",
            json!([{"kind":"skill","id":"skill-one"},{"kind":"tool","id":tool}]),
        )
        .unwrap();
        let active = activate(&m, saved["scenes"][0]["id"].clone(), &saved["revision"]);
        assert!(m.state == original);
        assert_eq!(m.snapshot()["skills"][0]["sceneEligible"], true);
        assert_eq!(m.snapshot()["skills"][1]["sceneEligible"], false);
        m.state.skills[0]["favorite"] = json!(true);
        m.save().unwrap();
        assert_eq!(list(&m), active);
        drop(m);
        let reopened = Manager::new(dir.path().join("state")).unwrap();
        assert_eq!(list(&reopened), active);
        assert_eq!(reopened.state.connections, original.connections);
        assert!(reopened
            .state
            .skills
            .iter()
            .all(|s| s.get("sceneEligible").is_none()));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("tool/config.json")).unwrap(),
            "preserve"
        );
    }

    #[test]
    fn no_op_conflict_and_delete_active_scene_have_one_cas_history() {
        let (_dir, mut m, _) = setup();
        let events = Arc::new(AtomicUsize::new(0));
        let sink = events.clone();
        m.set_state_events(Arc::new(move |_| {
            sink.fetch_add(1, Ordering::Relaxed);
        }));
        let members = json!([{"kind":"skill","id":"skill-one"}]);
        let saved = save(&m, None, 0, "One", members.clone()).unwrap();
        let id = saved["scenes"][0]["id"].as_str().unwrap();
        assert_eq!(
            save(
                &m,
                Some(id),
                saved["revision"].as_u64().unwrap(),
                "One",
                members.clone()
            )
            .unwrap(),
            saved
        );
        assert!(save(&m, Some(id), 0, "Stale", members).is_err());
        let active = activate(&m, json!(id), &saved["revision"]);
        assert_eq!(activate(&m, json!(id), &active["revision"]), active);
        let removed=apply_local(&m,&json!({"action":"resource_scene_remove","id":id,"expectedRevision":active["revision"]})).unwrap().unwrap();
        assert!(removed["activeSceneId"].is_null());
        assert_eq!(removed["scenes"], json!([]));
        assert!(removed["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c["sceneEligible"] == true));
        assert_eq!(events.load(Ordering::Relaxed), 3);
    }

    #[test]
    fn missing_members_remain_by_identity_and_can_be_explicitly_removed() {
        let (_dir, mut m, _) = setup();
        let saved = save(
            &m,
            None,
            0,
            "Keep",
            json!([{"kind":"skill","id":"skill-one"}]),
        )
        .unwrap();
        let id = saved["scenes"][0]["id"].as_str().unwrap();
        m.state.skills.retain(|s| s["id"] != "skill-one");
        m.state
            .skills
            .push(json!({"id":"different-id","name":"Skill one"}));
        m.save().unwrap();
        let current = list(&m);
        assert_eq!(current["scenes"][0]["members"][0]["exists"], false);
        assert_eq!(current["scenes"][0]["members"][0]["id"], "skill-one");
        assert!(save(
            &m,
            None,
            current["revision"].as_u64().unwrap(),
            "Invalid",
            json!([{"kind":"skill","id":"skill-one"}])
        )
        .is_err());
        let renamed = save(
            &m,
            Some(id),
            current["revision"].as_u64().unwrap(),
            "Renamed",
            json!([{"kind":"skill","id":"skill-one"}]),
        )
        .unwrap();
        let empty = save(
            &m,
            Some(id),
            renamed["revision"].as_u64().unwrap(),
            "Renamed",
            json!([]),
        )
        .unwrap();
        assert_eq!(empty["scenes"][0]["members"], json!([]));
    }

    #[test]
    fn failures_preserve_scenes_state_revision_and_events() {
        let (dir, mut m, _) = setup();
        let saved = save(&m, None, 0, "One", json!([])).unwrap();
        let revision = m.snapshot()["stateRevision"].clone();
        let events = Arc::new(AtomicUsize::new(0));
        let sink = events.clone();
        m.set_state_events(Arc::new(move |_| {
            sink.fetch_add(1, Ordering::Relaxed);
        }));
        let db = Connection::open(dir.path().join("state/manager.sqlite3")).unwrap();
        db.execute_batch("CREATE TRIGGER fail_scene BEFORE UPDATE ON resource_scenes_meta BEGIN SELECT RAISE(ABORT,'synthetic failed transaction'); END;").unwrap();
        assert!(save(
            &m,
            None,
            saved["revision"].as_u64().unwrap(),
            "Second",
            json!([])
        )
        .is_err());
        assert_eq!(list(&m), saved);
        assert_eq!(m.snapshot()["stateRevision"], revision);
        assert_eq!(events.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn basic_mode_old_database_reads_without_creating_tables_and_rejects_writes() {
        let (dir, m, _) = setup();
        let old = dir.path().join("old");
        std::fs::create_dir(&old).unwrap();
        let db = Connection::open(old.join("manager.sqlite3")).unwrap();
        db.execute_batch("CREATE TABLE app_state(id INTEGER PRIMARY KEY,schema_version INTEGER,payload TEXT NOT NULL)").unwrap();
        db.execute(
            "INSERT INTO app_state VALUES(1,1,?1)",
            [serde_json::to_string(&m.state).unwrap()],
        )
        .unwrap();
        let basic =
            Manager::with_storage_mode(crate::storage::Storage::isolated(old), true).unwrap();
        let listed = list(&basic);
        assert_eq!(listed["revision"], 0);
        assert_eq!(listed["scenes"], json!([]));
        assert!(save(&basic, None, 0, "Denied", json!([])).is_err());
        assert!(apply_local(
            &basic,
            &json!({"action":"resource_scene_activate","id":null,"expectedRevision":0})
        )
        .is_err());
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table'",
                [],
                |row| row.get::<_, u64>(0)
            )
            .unwrap(),
            1
        );
    }

    #[test]
    fn task_system_serializes_cas_and_keeps_inventory_visible() {
        let (_dir, m, tool) = setup();
        let service = crate::tasks::TaskSystem::new(m).unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let workers:Vec<_>=["One","Two"].into_iter().map(|name|{let service=service.clone();let barrier=barrier.clone();std::thread::spawn(move||{barrier.wait();service.execute(json!({"action":"resource_scene_save","expectedRevision":0,"name":name,"members":[]}),crate::dispatch_local)})}).collect();
        barrier.wait();
        let outcomes: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
        assert_eq!(outcomes.iter().filter(|r| r.is_ok()).count(), 1);
        let saved = service
            .execute(json!({"action":"resource_scenes"}), crate::dispatch)
            .unwrap();
        service.execute(json!({"action":"resource_scene_activate","id":saved["scenes"][0]["id"],"expectedRevision":saved["revision"]}),crate::dispatch).unwrap();
        let resources = service
            .execute(json!({"action":"resource_list"}), crate::dispatch)
            .unwrap();
        assert_eq!(resources["resources"].as_array().unwrap().len(), 1);
        assert_eq!(resources["resources"][0]["id"], tool);
        assert_eq!(resources["resources"][0]["enabled"], true);
        assert_eq!(resources["resources"][0]["effectiveEnabled"], false);
        let before = service.snapshot().unwrap();
        assert!(service
            .execute(
                json!({"action":"connect","skillId":"skill-one","client":"codex"}),
                crate::dispatch
            )
            .unwrap_err()
            .contains("当前场景"));
        assert!(service.execute(json!({"action":"connect_batch","skillIds":["skill-one","skill-two"],"client":"codex"}),crate::dispatch).unwrap_err().contains("当前场景"));
        assert_eq!(
            service.snapshot().unwrap()["connections"],
            before["connections"]
        );
    }

    #[test]
    fn validation_rejects_unknown_fields_and_members_while_activation_is_shared() {
        let (_dir, mut m, _) = setup();
        for request in [
            json!({"action":"resource_scene_save","expectedRevision":0,"name":"x","members":[{"kind":"shell","id":"one"}]}),
            json!({"action":"resource_scene_save","expectedRevision":0,"name":"x","members":[{"kind":"skill","id":"skill-one","command":"bad"}]}),
            json!({"action":"resource_scene_save","expectedRevision":0,"name":"x","members":[],"enabled":true}),
        ] {
            assert!(apply_local(&m, &request).is_err());
        }
        assert!(crate::dispatch(
            &mut m,
            &json!({"action":"resource_scene_save","expectedRevision":0,"name":"x","members":[]})
        )
        .is_err());
        assert!(crate::dispatch(
            &mut m,
            &json!({"action":"resource_scene_activate","id":"unknown","expectedRevision":0})
        )
        .is_err());
        assert_eq!(
            crate::dispatch(
                &mut m,
                &json!({"action":"resource_scene_activate","id":null,"expectedRevision":0})
            )
            .unwrap()["revision"],
            0
        );
    }

    #[test]
    #[ignore]
    fn synthetic_scene_service() {
        std::thread::sleep(std::time::Duration::from_secs(30));
    }

    #[test]
    fn live_spawn_protects_dependency_service_through_skill_nodes_and_cycles() {
        let (dir, mut m, consumer) = setup();
        let dependency_root = dir.path().join("dependency");
        std::fs::create_dir(&dependency_root).unwrap();
        let dependency=crate::dispatch(&mut m,&json!({"action":"resource_register","name":"Dependency","kind":"cli","rootPath":dependency_root})).unwrap()["resource"]["id"].as_str().unwrap().to_owned();
        for id in [&consumer, &dependency] {
            let record = m
                .resource_store(crate::resources::StoreRequest::Get(id.clone()))
                .unwrap();
            crate::dispatch_local(&mut m,&json!({"action":"resource_action_set","id":id,"expectedRevision":1,"definition":{"id":"serve","label":"Synthetic service","mode":"service","cancellable":true,"executable":std::env::current_exe().unwrap(),"workingDirectory":record["rootPath"],"args":[{"type":"literal","value":"--exact"},{"type":"literal","value":"resource_scenes::tests::synthetic_scene_service"},{"type":"literal","value":"--ignored"}],"parameters":[]}})).unwrap();
        }
        let run_dependency = crate::dispatch(
            &mut m,
            &json!({"action":"resource_invoke","id":dependency,"actionId":"serve","parameters":{}}),
        )
        .unwrap()["run"]
            .clone();
        let tool = |id: &str| Endpoint {
            kind: "tool".into(),
            id: id.into(),
        };
        let skill = Endpoint {
            kind: "skill".into(),
            id: "skill-one".into(),
        };
        let mut revision = 0;
        for (dependent, dependency) in [
            (tool(&consumer), skill.clone()),
            (skill, tool(&dependency)),
            (tool(&dependency), tool(&consumer)),
        ] {
            let value = m
                .relation_store(crate::resource_relations::StoreRequest::Add {
                    dependent,
                    dependency,
                    expected_revision: revision,
                })
                .unwrap();
            revision = value["revision"].as_u64().unwrap();
        }
        let run_consumer = crate::dispatch(
            &mut m,
            &json!({"action":"resource_invoke","id":consumer,"actionId":"serve","parameters":{}}),
        )
        .unwrap()["run"]
            .clone();
        assert_eq!(
            m.resource_runtime
                .result(run_dependency["runId"].as_str().unwrap())
                .unwrap()["run"]["activeUses"],
            1
        );
        assert_eq!(
            m.resource_runtime
                .result(run_consumer["runId"].as_str().unwrap())
                .unwrap()["run"]["activeUses"],
            0
        );
        m.resource_runtime
            .stop(run_consumer["runId"].as_str().unwrap())
            .unwrap();
        assert_eq!(
            m.resource_runtime
                .result(run_dependency["runId"].as_str().unwrap())
                .unwrap()["run"]["activeUses"],
            0
        );
        m.resource_runtime
            .stop(run_dependency["runId"].as_str().unwrap())
            .unwrap();
    }

    #[test]
    fn live_spawn_gate_preserves_manual_disable_and_scene_switch_keeps_running_service() {
        let (_dir, mut m, tool) = setup();
        let record = m
            .resource_store(crate::resources::StoreRequest::Get(tool.clone()))
            .unwrap();
        crate::dispatch_local(&mut m,&json!({"action":"resource_action_set","id":tool,"expectedRevision":1,"definition":{"id":"serve","label":"Synthetic service","mode":"service","cancellable":true,"executable":std::env::current_exe().unwrap(),"workingDirectory":record["rootPath"],"args":[{"type":"literal","value":"--exact"},{"type":"literal","value":"resource_scenes::tests::synthetic_scene_service"},{"type":"literal","value":"--ignored"}],"parameters":[]}})).unwrap();
        let current: ResourceRecord = serde_json::from_value(
            m.resource_store(crate::resources::StoreRequest::Get(tool.clone()))
                .unwrap(),
        )
        .unwrap();
        let definition = crate::resource_runtime::verified_definition(&current, "serve").unwrap();
        let run = crate::dispatch(
            &mut m,
            &json!({"action":"resource_invoke","id":tool,"actionId":"serve","parameters":{}}),
        )
        .unwrap();
        let saved = save(&m, None, 0, "Empty", json!([])).unwrap();
        let active = activate(&m, saved["scenes"][0]["id"].clone(), &saved["revision"]);
        assert_eq!(
            m.resource_runtime.snapshot(Some(&tool)).unwrap()["runs"][0]["status"],
            "running"
        );
        assert!(m
            .resource_spawn(crate::resource_runtime::PreparedInvocation {
                resource_id: tool.clone(),
                revision: current.revision,
                definition: definition.clone(),
                args: vec![]
            })
            .unwrap_err()
            .contains("当前场景"));
        let capabilities =
            crate::dispatch(&mut m, &json!({"action":"resource_capabilities","id":tool})).unwrap();
        assert_eq!(capabilities["actions"], json!([]));
        assert_eq!(capabilities["enabled"], true);
        let included = save(
            &m,
            Some(saved["scenes"][0]["id"].as_str().unwrap()),
            active["revision"].as_u64().unwrap(),
            "Included",
            json!([{"kind":"tool","id":tool}]),
        )
        .unwrap();
        crate::dispatch(&mut m,&json!({"action":"resource_set_enabled","id":tool,"expectedRevision":current.revision,"enabled":false})).unwrap();
        activate(&m, Value::Null, &included["revision"]);
        let now = m
            .resource_store(crate::resources::StoreRequest::Get(tool.clone()))
            .unwrap();
        assert_eq!(now["enabled"], false);
        assert!(m
            .resource_spawn(crate::resource_runtime::PreparedInvocation {
                resource_id: tool.clone(),
                revision: now["revision"].as_u64().unwrap(),
                definition,
                args: vec![]
            })
            .is_err());
        m.resource_runtime
            .stop(run["run"]["runId"].as_str().unwrap())
            .unwrap();
    }
}
