//! Personal annotations and saved filters belong to the manager, never Skill sources.
//! Separate tables keep legacy app_state saves from discarding this information.
use crate::model::Manager;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub(crate) enum StoreRequest {
    List,
    AnnotationSet {
        skill_id: String,
        expected_revision: u64,
        alias: String,
        notes: String,
    },
    ViewSave {
        id: Option<String>,
        expected_revision: u64,
        name: String,
        view: String,
        filters: Value,
    },
    ViewRemove {
        id: String,
        expected_revision: u64,
    },
}

impl StoreRequest {
    pub(crate) fn writes(&self) -> bool {
        !matches!(self, Self::List)
    }
    pub(crate) fn skill_id(&self) -> Option<&str> {
        match self {
            Self::AnnotationSet { skill_id, .. } => Some(skill_id),
            _ => None,
        }
    }
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
    if !table_exists(db, "management_data_meta")? {
        return Ok(0);
    }
    db.query_row(
        "SELECT revision FROM management_data_meta WHERE id=1",
        [],
        |row| row.get(0),
    )
    .optional()
    .map(|revision| revision.unwrap_or(0))
    .map_err(|e| e.to_string())
}

pub(crate) fn initialize(db: &Connection) -> Result<u64, String> {
    let transaction = db.unchecked_transaction().map_err(|e| e.to_string())?;
    transaction.execute_batch("CREATE TABLE IF NOT EXISTS skill_annotations (
        skill_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision > 0), alias TEXT NOT NULL, notes TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS saved_views (
        id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision > 0), name TEXT NOT NULL,
        view TEXT NOT NULL CHECK(view IN ('skills','tools')), filters TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS management_data_meta (
        id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL
    );").map_err(|e| e.to_string())?;
    let revision = revision(&transaction)?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(revision)
}

fn read(db: &Connection) -> Result<Value, String> {
    let mut annotations = Vec::new();
    if table_exists(db, "skill_annotations")? {
        let mut statement = db
            .prepare("SELECT skill_id,revision,alias,notes FROM skill_annotations ORDER BY rowid")
            .map_err(|e| e.to_string())?;
        let rows = statement.query_map([], |row| Ok(json!({"skillId":row.get::<_,String>(0)?,"revision":row.get::<_,u64>(1)?,"alias":row.get::<_,String>(2)?,"notes":row.get::<_,String>(3)?}))).map_err(|e| e.to_string())?;
        for row in rows {
            annotations.push(row.map_err(|e| e.to_string())?);
        }
    }
    let mut views = Vec::new();
    if table_exists(db, "saved_views")? {
        let mut statement = db
            .prepare("SELECT id,revision,name,view,filters FROM saved_views ORDER BY rowid")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, u64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, revision, name, view, filters) = row.map_err(|e| e.to_string())?;
            let filters: Value = serde_json::from_str(&filters)
                .map_err(|e| format!("无法读取常用筛选，原记录保留：{e}"))?;
            validate_filters(&view, &filters)?;
            views.push(
                json!({"id":id,"revision":revision,"name":name,"view":view,"filters":filters}),
            );
        }
    }
    Ok(json!({"revision":revision(db)?,"skillAnnotations":annotations,"savedViews":views}))
}

const CONFLICT: &str = "个人信息或常用筛选已被其他操作修改，请重新读取后再保存";

/// The live writer holds the manager lock for existence checks and this transaction.
/// Reads are completed before commit so a failed response cannot conceal a committed write.
pub(crate) fn store(
    db: &Connection,
    request: StoreRequest,
    state_revision: u64,
) -> Result<(Value, bool), String> {
    if matches!(request, StoreRequest::List) {
        return Ok((read(db)?, false));
    }
    let transaction = db.unchecked_transaction().map_err(|e| e.to_string())?;
    let changed = match request {
        StoreRequest::AnnotationSet {
            skill_id,
            expected_revision,
            alias,
            notes,
        } => {
            let current = transaction
                .query_row(
                    "SELECT revision,alias,notes FROM skill_annotations WHERE skill_id=?1",
                    [&skill_id],
                    |row| {
                        Ok((
                            row.get::<_, u64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if current.as_ref().map_or(0, |r| r.0) != expected_revision {
                return Err(CONFLICT.into());
            }
            if current
                .as_ref()
                .map_or(alias.is_empty() && notes.is_empty(), |r| {
                    r.1 == alias && r.2 == notes
                })
            {
                false
            } else {
                let next = next_revision(expected_revision)?;
                let affected = if current.is_some() {
                    transaction.execute("UPDATE skill_annotations SET revision=?1,alias=?2,notes=?3 WHERE skill_id=?4 AND revision=?5", params![next,alias,notes,skill_id,expected_revision])
                } else {
                    transaction.execute("INSERT INTO skill_annotations(skill_id,revision,alias,notes) VALUES(?1,?2,?3,?4)", params![skill_id,next,alias,notes])
                }.map_err(|e| e.to_string())?;
                if affected != 1 {
                    return Err(CONFLICT.into());
                }
                true
            }
        }
        StoreRequest::ViewSave {
            id,
            expected_revision,
            name,
            view,
            filters,
        } => {
            let existing_id = id.is_some();
            let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let current = transaction
                .query_row(
                    "SELECT revision,name,view,filters FROM saved_views WHERE id=?1",
                    [&id],
                    |row| {
                        Ok((
                            row.get::<_, u64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    },
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if existing_id != current.is_some()
                || current.as_ref().map_or(0, |r| r.0) != expected_revision
            {
                return Err(CONFLICT.into());
            }
            let filters = serde_json::to_string(&filters).map_err(|e| e.to_string())?;
            if current
                .as_ref()
                .is_some_and(|r| r.1 == name && r.2 == view && r.3 == filters)
            {
                false
            } else {
                let next = next_revision(expected_revision)?;
                let affected = if existing_id {
                    transaction.execute("UPDATE saved_views SET revision=?1,name=?2,view=?3,filters=?4 WHERE id=?5 AND revision=?6", params![next,name,view,filters,id,expected_revision])
                } else {
                    transaction.execute("INSERT INTO saved_views(id,revision,name,view,filters) VALUES(?1,?2,?3,?4,?5)", params![id,next,name,view,filters])
                }.map_err(|e| e.to_string())?;
                if affected != 1 {
                    return Err(CONFLICT.into());
                }
                true
            }
        }
        StoreRequest::ViewRemove {
            id,
            expected_revision,
        } => {
            let affected = transaction
                .execute(
                    "DELETE FROM saved_views WHERE id=?1 AND revision=?2",
                    params![id, expected_revision],
                )
                .map_err(|e| e.to_string())?;
            if affected != 1 {
                return Err(CONFLICT.into());
            }
            true
        }
        StoreRequest::List => unreachable!(),
    };
    if changed {
        transaction.execute("INSERT INTO management_data_meta(id,revision) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision", [state_revision]).map_err(|e| e.to_string())?;
    }
    let result = read(&transaction)?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok((result, changed))
}

fn next_revision(current: u64) -> Result<u64, String> {
    current
        .checked_add(1)
        .filter(|revision| *revision <= i64::MAX as u64)
        .ok_or_else(|| "管理数据修订号超出范围".into())
}

fn fields(value: &Value, allowed: &[&str]) -> Result<(), String> {
    let object = value.as_object().ok_or("请求和筛选条件必须是对象")?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("请求包含不支持的字段；常用筛选不保存动作、命令或执行参数".into());
    }
    Ok(())
}

fn text(value: &Value, key: &str, max: usize, required: bool) -> Result<String, String> {
    let text = value[key]
        .as_str()
        .ok_or_else(|| format!("{key} 必须是文字"))?;
    if (required && text.trim().is_empty()) || text.chars().count() > max || text.contains('\0') {
        return Err(format!("{key} 内容为空、过长或包含无效字符"));
    }
    Ok(text.to_owned())
}

fn choice(value: &Value, key: &str, allowed: &[&str]) -> Result<(), String> {
    if !value[key]
        .as_str()
        .is_some_and(|item| allowed.contains(&item))
    {
        return Err(format!("{key} 不是支持的筛选选项"));
    }
    Ok(())
}

pub(crate) fn validate_filters(view: &str, filters: &Value) -> Result<(), String> {
    match view {
        "skills" => {
            fields(
                filters,
                &[
                    "query",
                    "sourceFilter",
                    "statusFilter",
                    "categoryFilter",
                    "sort",
                    "mode",
                    "pageSize",
                ],
            )?;
            text(filters, "query", 2000, false)?;
            text(filters, "categoryFilter", 160, true)?;
            choice(
                filters,
                "sourceFilter",
                &["all", "local", "github", "linked"],
            )?;
            choice(
                filters,
                "statusFilter",
                &[
                    "all",
                    "attention",
                    "local_only",
                    "remote_only",
                    "synced",
                    "changed",
                    "review",
                    "problem",
                    "remote_updated",
                    "local_modified",
                    "both_modified",
                    "docs_updated",
                    "unknown_baseline",
                    "local_extra",
                    "remote_missing",
                    "remote_check_required",
                    "error",
                ],
            )?;
            choice(filters, "sort", &["name", "status", "checked"])?;
            choice(filters, "mode", &["list", "details", "cards"])?;
            if !matches!(filters["pageSize"].as_u64(), Some(20 | 50 | 100)) {
                return Err("pageSize 必须是 20、50 或 100".into());
            }
        }
        "tools" => {
            fields(filters, &["query", "kind"])?;
            text(filters, "query", 2000, false)?;
            choice(filters, "kind", &["", "skill", "portable", "cli", "mcp"])?;
        }
        _ => return Err("view 必须是 skills 或 tools".into()),
    }
    Ok(())
}

fn expected_revision(request: &Value) -> Result<u64, String> {
    request["expectedRevision"]
        .as_u64()
        .filter(|revision| *revision <= i64::MAX as u64)
        .ok_or_else(|| "保存前需要当前 expectedRevision；新记录使用 0".into())
}

pub(crate) fn handle(manager: &Manager, request: &Value) -> Result<Option<Value>, String> {
    let operation = match request["action"].as_str().unwrap_or_default() {
        "management_data" => {
            fields(request, &["action"])?;
            StoreRequest::List
        }
        "skill_annotation_set" => {
            fields(
                request,
                &["action", "skillId", "expectedRevision", "alias", "notes"],
            )?;
            StoreRequest::AnnotationSet {
                skill_id: text(request, "skillId", 160, true)?,
                expected_revision: expected_revision(request)?,
                alias: text(request, "alias", 160, false)?,
                notes: text(request, "notes", 4000, false)?,
            }
        }
        "saved_view_save" => {
            fields(
                request,
                &[
                    "action",
                    "id",
                    "expectedRevision",
                    "name",
                    "view",
                    "filters",
                ],
            )?;
            let id = if request.get("id").is_some() {
                Some(text(request, "id", 160, true)?)
            } else {
                None
            };
            let expected_revision = expected_revision(request)?;
            if id.is_some() != (expected_revision > 0) {
                return Err(
                    "新增常用筛选应省略 id 并使用修订号 0；编辑需要当前 id 和修订号".into(),
                );
            }
            let view = text(request, "view", 16, true)?;
            validate_filters(&view, &request["filters"])?;
            StoreRequest::ViewSave {
                id,
                expected_revision,
                name: text(request, "name", 80, true)?.trim().to_owned(),
                view,
                filters: request["filters"].clone(),
            }
        }
        "saved_view_remove" => {
            fields(request, &["action", "id", "expectedRevision"])?;
            let expected_revision = expected_revision(request)?;
            if expected_revision == 0 {
                return Err("删除需要当前常用筛选修订号".into());
            }
            StoreRequest::ViewRemove {
                id: text(request, "id", 160, true)?,
                expected_revision,
            }
        }
        _ => return Ok(None),
    };
    Ok(Some(manager.management_store(operation)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        path::Path,
        sync::{Arc, Barrier, Mutex},
    };

    fn fixture() -> tempfile::TempDir {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("work/management-data-tests");
        std::fs::create_dir_all(&root).unwrap();
        tempfile::tempdir_in(root).unwrap()
    }
    fn manager(path: &Path) -> Manager {
        let mut manager = Manager::new(path.to_owned()).unwrap();
        manager
            .state
            .skills
            .push(json!({"id":"one","name":"original","description":"upstream description"}));
        manager.save().unwrap();
        manager
    }
    fn invoke(manager: &Manager, request: Value) -> Value {
        handle(manager, &request).unwrap().unwrap()
    }
    fn list(manager: &Manager) -> Value {
        invoke(manager, json!({"action":"management_data"}))
    }
    fn annotation(expected: u64, alias: &str, notes: &str) -> Value {
        json!({"action":"skill_annotation_set","skillId":"one","expectedRevision":expected,"alias":alias,"notes":notes})
    }
    fn skill_filters() -> Value {
        json!({"query":"note","sourceFilter":"all","statusFilter":"attention","categoryFilter":"all","sort":"checked","mode":"details","pageSize":50})
    }
    fn view(name: &str, view: &str, filters: Value) -> Value {
        json!({"action":"saved_view_save","expectedRevision":0,"name":name,"view":view,"filters":filters})
    }

    #[test]
    fn independent_tables_survive_restart_and_legacy_saves_without_touching_skill_files() {
        let dir = fixture();
        let root = dir.path().join("skill");
        std::fs::create_dir(&root).unwrap();
        let source = root.join("SKILL.md");
        std::fs::write(&source, "original source").unwrap();
        let data = dir.path().join("state");
        let mut m = manager(&data);
        m.state.skills[0]["localPath"] = json!(root);
        m.state.settings["privateSetting"] = json!("retained");
        m.save().unwrap();
        let db = Connection::open(data.join("manager.sqlite3")).unwrap();
        let old_payload: String = db
            .query_row("SELECT payload FROM app_state WHERE id=1", [], |row| {
                row.get(0)
            })
            .unwrap();
        invoke(&m, annotation(0, "My alias", "first line\n  second line"));
        invoke(&m, view("Needs attention", "skills", skill_filters()));
        let result = invoke(
            &m,
            view("Tools", "tools", json!({"query":"cli","kind":"cli"})),
        );
        let payload: String = db
            .query_row("SELECT payload FROM app_state WHERE id=1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(payload, old_payload);
        assert_eq!(
            result["skillAnnotations"][0]["notes"],
            "first line\n  second line"
        );
        assert_eq!(result["savedViews"].as_array().unwrap().len(), 2);
        let snapshot = m.snapshot();
        assert_eq!(snapshot["managementRevision"], result["revision"]);
        assert!(snapshot.get("skillAnnotations").is_none());
        assert!(snapshot.get("savedViews").is_none());
        assert!(serde_json::to_value(&m.state)
            .unwrap()
            .get("managementRevision")
            .is_none());
        drop(m);
        let reopened = Manager::new(data).unwrap();
        assert_eq!(list(&reopened), result);
        assert_eq!(
            reopened.snapshot()["stateRevision"],
            snapshot["stateRevision"]
        );
        reopened.save().unwrap();
        assert_eq!(list(&reopened), result);
        assert_eq!(reopened.state.skills[0]["name"], "original");
        assert_eq!(
            reopened.state.skills[0]["description"],
            "upstream description"
        );
        assert_eq!(reopened.state.settings["privateSetting"], "retained");
        assert_eq!(std::fs::read_to_string(source).unwrap(), "original source");
    }

    #[test]
    fn no_op_and_failed_cas_preserve_revisions_and_emit_only_committed_changes() {
        let _network = crate::network::test_configuration_guard();
        let dir = fixture();
        let mut m = manager(dir.path());
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        m.set_state_events(Arc::new(move |revision| {
            sink.lock().unwrap().push(revision)
        }));
        let before = m.snapshot();
        assert_eq!(invoke(&m, annotation(0, "", "")), list(&m));
        assert_eq!(m.snapshot(), before);
        let saved = invoke(&m, annotation(0, "alias", "notes"));
        let snapshot = m.snapshot();
        assert_eq!(invoke(&m, annotation(1, "alias", "notes")), saved);
        assert!(handle(&m, &annotation(0, "alias", "notes")).is_err());
        assert_eq!(m.snapshot(), snapshot);
        assert_eq!(events.lock().unwrap().len(), 1);
        assert_eq!(
            events.lock().unwrap()[0],
            saved["revision"].as_u64().unwrap()
        );
        let views = invoke(&m, view("Example", "skills", skill_filters()));
        let record = &views["savedViews"][0];
        let update = json!({"action":"saved_view_save","id":record["id"],"expectedRevision":1,"name":"Example","view":"skills","filters":skill_filters()});
        assert_eq!(invoke(&m, update.clone()), views);
        let mut renamed = update.clone();
        renamed["name"] = json!("Renamed");
        let renamed_result = invoke(&m, renamed);
        assert_eq!(renamed_result["savedViews"][0]["revision"], 2);
        assert!(handle(&m, &update).is_err());
        assert!(handle(
            &m,
            &json!({"action":"saved_view_remove","id":record["id"],"expectedRevision":1})
        )
        .is_err());
        let removed = invoke(
            &m,
            json!({"action":"saved_view_remove","id":record["id"],"expectedRevision":2}),
        );
        assert_eq!(removed["savedViews"], json!([]));
        assert_eq!(removed["skillAnnotations"], saved["skillAnnotations"]);
        assert_eq!(events.lock().unwrap().len(), 4);
    }

    #[test]
    fn failed_transaction_rolls_back_records_and_revision_before_emitting_events() {
        let _network = crate::network::test_configuration_guard();
        let dir = fixture();
        let mut m = manager(dir.path());
        let saved = invoke(&m, annotation(0, "preserved", "original"));
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        m.set_state_events(Arc::new(move |revision| {
            sink.lock().unwrap().push(revision)
        }));
        let snapshot = m.snapshot();
        let db = Connection::open(dir.path().join("manager.sqlite3")).unwrap();
        db.execute_batch("CREATE TRIGGER fail_management_revision BEFORE UPDATE ON management_data_meta BEGIN SELECT RAISE(ABORT,'synthetic transaction failure'); END;").unwrap();
        assert!(handle(&m, &annotation(1, "changed", "new notes"))
            .unwrap_err()
            .contains("synthetic transaction failure"));
        assert!(handle(&m, &view("Fail", "tools", json!({"query":"","kind":""}))).is_err());
        assert_eq!(list(&m), saved);
        assert_eq!(m.snapshot(), snapshot);
        assert!(events.lock().unwrap().is_empty());
        drop(m);
        assert_eq!(list(&Manager::new(dir.path().to_owned()).unwrap()), saved);
    }

    #[test]
    fn basic_mode_reads_old_database_without_creating_tables_and_rejects_writes() {
        let dir = fixture();
        let legacy = Connection::open(dir.path().join("manager.sqlite3")).unwrap();
        legacy.execute_batch("CREATE TABLE app_state(id INTEGER PRIMARY KEY, schema_version INTEGER, payload TEXT);").unwrap();
        legacy.execute("INSERT INTO app_state VALUES(1,1,?1)", [json!({"skills":[{"id":"one","name":"legacy"}],"sources":[],"connections":[],"settings":{"untouched":true}}).to_string()]).unwrap();
        let tables = || {
            legacy
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table'",
                    [],
                    |row| row.get::<_, u64>(0),
                )
                .unwrap()
        };
        let before = tables();
        let m = Manager::with_storage_mode(
            crate::storage::Storage::isolated(dir.path().to_owned()),
            true,
        )
        .unwrap();
        assert_eq!(
            list(&m),
            json!({"revision":0,"skillAnnotations":[],"savedViews":[]})
        );
        assert_eq!(m.snapshot()["managementRevision"], 0);
        assert!(handle(&m, &annotation(0, "alias", "notes")).is_err());
        let service = crate::tasks::TaskSystem::new(m).unwrap();
        assert_eq!(
            service
                .execute(json!({"action":"management_data"}), crate::dispatch)
                .unwrap()["revision"],
            0
        );
        assert!(service
            .execute(
                view("view", "tools", json!({"query":"","kind":""})),
                crate::dispatch
            )
            .is_err());
        assert_eq!(tables(), before);
    }

    #[test]
    fn basic_mode_can_read_existing_management_data_without_rewriting_it() {
        let dir = fixture();
        let m = manager(dir.path());
        invoke(&m, annotation(0, "alias", "notes"));
        let expected = invoke(&m, view("Saved", "skills", skill_filters()));
        drop(m);
        let basic = Manager::with_storage_mode(
            crate::storage::Storage::isolated(dir.path().to_owned()),
            true,
        )
        .unwrap();
        assert_eq!(list(&basic), expected);
        assert_eq!(basic.snapshot()["managementRevision"], expected["revision"]);
        assert!(handle(&basic, &annotation(1, "changed", "changed")).is_err());
        assert_eq!(list(&basic), expected);
    }

    #[test]
    fn strict_schema_rejects_executable_fields_invalid_enums_and_oversized_content() {
        let _network = crate::network::test_configuration_guard();
        let dir = fixture();
        let m = manager(dir.path());
        let mut bad = vec![
            annotation(0, &"x".repeat(161), ""),
            annotation(0, "", &"x".repeat(4001)),
            annotation(0, "bad\0alias", ""),
        ];
        let mut extra = annotation(0, "alias", "notes");
        extra["command"] = json!("not executable");
        bad.push(extra);
        let mut missing = annotation(0, "alias", "notes");
        missing.as_object_mut().unwrap().remove("expectedRevision");
        bad.push(missing);
        let mut missing_skill = annotation(0, "alias", "notes");
        missing_skill["skillId"] = json!("missing");
        bad.push(missing_skill);
        bad.push(view(&"x".repeat(81), "skills", skill_filters()));
        bad.push(view(" ", "skills", skill_filters()));
        bad.push(view("bad", "tools", json!({"query":"","kind":"shell"})));
        bad.push(view("bad", "skills", json!({"query":""})));
        for (key, value) in [
            ("sort", json!("run")),
            ("mode", json!("execute")),
            ("pageSize", json!(30)),
            ("statusFilter", json!("invalid")),
            ("sourceFilter", json!("all-other")),
            ("categoryFilter", Value::Null),
            ("command", json!("tool.exe")),
            ("arguments", json!(["--run"])),
        ] {
            let mut filters = skill_filters();
            filters[key] = value;
            bad.push(view("bad", "skills", filters));
        }
        for key in [
            "query",
            "sourceFilter",
            "statusFilter",
            "categoryFilter",
            "sort",
            "mode",
            "pageSize",
        ] {
            let mut filters = skill_filters();
            filters.as_object_mut().unwrap().remove(key);
            bad.push(view("missing", "skills", filters));
        }
        let before = list(&m);
        let snapshot = m.snapshot();
        for request in bad {
            assert!(handle(&m, &request).is_err(), "accepted {request}");
        }
        assert_eq!(list(&m), before);
        assert_eq!(m.snapshot(), snapshot);
        // Free text is inert personal data; it must not be interpreted as a command.
        let literal = "$(not-a-command) <script>text</script>";
        assert_eq!(
            invoke(&m, annotation(0, "literal", literal))["skillAnnotations"][0]["notes"],
            literal
        );
    }

    #[test]
    fn task_system_serializes_concurrent_cas_and_preserves_unrelated_data() {
        let dir = fixture();
        let m = manager(dir.path());
        invoke(&m, view("Retain", "skills", skill_filters()));
        let service = crate::tasks::TaskSystem::new(m).unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let threads: Vec<_> = ["First", "Second"]
            .into_iter()
            .map(|alias| {
                let service = service.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    service.execute(annotation(0, alias, "same notes"), crate::dispatch)
                })
            })
            .collect();
        barrier.wait();
        let outcomes: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
        assert_eq!(
            outcomes.iter().filter(|outcome| outcome.is_err()).count(),
            1
        );
        let saved = service
            .execute(json!({"action":"management_data"}), crate::dispatch)
            .unwrap();
        assert_eq!(saved["skillAnnotations"].as_array().unwrap().len(), 1);
        assert_eq!(saved["skillAnnotations"][0]["revision"], 1);
        assert_eq!(saved["savedViews"][0]["name"], "Retain");
        assert!(service
            .execute(annotation(0, "Stale", "no overwrite"), crate::dispatch)
            .is_err());
        assert_eq!(
            service
                .execute(json!({"action":"management_data"}), crate::dispatch)
                .unwrap(),
            saved
        );
    }
}
