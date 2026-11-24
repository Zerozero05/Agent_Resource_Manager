//! Background operations share one durable state writer, never a long I/O lock.
use crate::model::{now, Manager, ManagerRuntime, State, TaskHistoryRow, TaskHistoryWrite};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
#[cfg(test)]
use std::sync::atomic::AtomicU64;
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    io::{Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex, Weak,
    },
    time::Duration,
};

const HISTORY_LIMIT: usize = 100;
const CANCELLED: &str = "任务已取消";
type Dispatch = fn(&mut Manager, &Value) -> Result<Value, String>;
type EventSink = Arc<dyn Fn(Value) + Send + Sync>;
type Completion = Arc<(Mutex<Option<Result<Arc<TaskResult>, String>>>, Condvar)>;
type ProgressSink = Arc<dyn Fn(&str, Option<usize>, Option<usize>) + Send + Sync>;

// History and waiting callers share one lossless payload. Repeated checks can
// return the whole library; keeping two JSON trees per record grows with it.
struct TaskResult {
    bytes: Vec<u8>,
    compressed: bool,
}

impl TaskResult {
    fn new(value: &Value) -> Self {
        let bytes = serde_json::to_vec(value).expect("serializable task result");
        if bytes.len() >= 64 * 1024 {
            let mut encoder =
                flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
            if encoder.write_all(&bytes).is_ok() {
                if let Ok(packed) = encoder.finish() {
                    if packed.len() < bytes.len() {
                        return Self {
                            bytes: packed,
                            compressed: true,
                        };
                    }
                }
            }
        }
        Self {
            bytes,
            compressed: false,
        }
    }

    fn read(&self) -> Result<Value, String> {
        let mut unpacked = Vec::new();
        let bytes = if self.compressed {
            flate2::read::ZlibDecoder::new(self.bytes.as_slice())
                .read_to_end(&mut unpacked)
                .map_err(|error| format!("无法读取任务结果：{error}"))?;
            unpacked.as_slice()
        } else {
            self.bytes.as_slice()
        };
        serde_json::from_slice(bytes).map_err(|error| format!("无法读取任务结果：{error}"))
    }
}
thread_local! { static PROGRESS: RefCell<Option<ProgressSink>> = const { RefCell::new(None) }; }

pub(crate) fn report_progress(stage: &str, completed: Option<usize>, total: Option<usize>) {
    let sink = PROGRESS.with(|slot| slot.borrow().clone());
    if let Some(sink) = sink {
        sink(stage, completed, total);
    }
}
fn with_progress<T>(sink: ProgressSink, run: impl FnOnce() -> T) -> T {
    struct Reset(Option<ProgressSink>);
    impl Drop for Reset {
        fn drop(&mut self) {
            PROGRESS.with(|slot| *slot.borrow_mut() = self.0.take());
        }
    }
    let _reset = Reset(PROGRESS.with(|slot| slot.replace(Some(sink))));
    run()
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Task {
    id: String,
    action: String,
    label: String,
    status: String,
    stage: String,
    created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    finished_at: Option<String>,
    #[serde(default)]
    origin: Value,
    #[serde(default)]
    progress: Value,
    #[serde(default)]
    cancellable: bool,
    #[serde(default)]
    cancel_requested: bool,
    #[serde(default)]
    result_available: bool,
    #[serde(default)]
    result_expired: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip)]
    result: Option<Arc<TaskResult>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    result_files: Vec<crate::task_outputs::ResultFile>,
    #[serde(
        default,
        serialize_with = "serialize_resource_keys",
        deserialize_with = "deserialize_resource_keys"
    )]
    resources: Arc<[String]>,
}

fn serialize_resource_keys<S: serde::Serializer>(
    keys: &[String],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    keys.serialize(serializer)
}

fn deserialize_resource_keys<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Arc<[String]>, D::Error> {
    Vec::<String>::deserialize(deserializer).map(Arc::from)
}

#[derive(Serialize)]
#[serde(untagged)]
enum TaskHistoryField<'a> {
    Summary(&'a Value),
    Resources(&'a [String]),
}

impl Task {
    fn terminal(&self) -> bool {
        !matches!(self.status.as_str(), "queued" | "running")
    }
    fn metadata(&self) -> Value {
        serde_json::to_value(self).expect("serializable task")
    }
    fn history_row(&self) -> TaskHistoryRow {
        let summary = self.summary();
        let mut fields: BTreeMap<_, _> = summary
            .as_object()
            .expect("task summary object")
            .iter()
            .map(|(name, value)| (name.as_str(), TaskHistoryField::Summary(value)))
            .collect();
        // Keep the existing JSON field order for SQLite's unchanged-row comparison.
        fields.insert("resources", TaskHistoryField::Resources(&self.resources));
        TaskHistoryRow {
            id: self.id.clone(),
            payload: serde_json::to_string(&fields).expect("serializable task metadata"),
        }
    }
    fn summary(&self) -> Value {
        // Scheduling keys remain in durable history and individual task reads.
        // Build summaries directly so list and event reads never copy the lock set.
        let mut fields = Map::new();
        fields.insert("id".into(), json!(self.id));
        fields.insert("action".into(), json!(self.action));
        fields.insert("label".into(), json!(self.label));
        fields.insert("status".into(), json!(self.status));
        fields.insert("stage".into(), json!(self.stage));
        fields.insert("createdAt".into(), json!(self.created_at));
        if let Some(started_at) = &self.started_at {
            fields.insert("startedAt".into(), json!(started_at));
        }
        if let Some(finished_at) = &self.finished_at {
            fields.insert("finishedAt".into(), json!(finished_at));
        }
        fields.insert("origin".into(), self.origin.clone());
        fields.insert("progress".into(), self.progress.clone());
        fields.insert("cancellable".into(), json!(self.cancellable));
        fields.insert("cancelRequested".into(), json!(self.cancel_requested));
        fields.insert("resultAvailable".into(), json!(self.result_available));
        fields.insert("resultExpired".into(), json!(self.result_expired));
        if let Some(error) = &self.error {
            fields.insert("error".into(), json!(error));
        }
        if !self.result_files.is_empty() {
            fields.insert("resultFiles".into(), json!(self.result_files));
        }
        Value::Object(fields)
    }
}

struct Job {
    task: Task,
    completion_stamp: Option<CheckCompletionStamp>,
    history_revision: u64,
    cancel: Arc<AtomicBool>,
    completion: Completion,
    visible: bool,
    recorded: bool,
    consumers: usize,
    dedup: Option<String>,
    automatic: bool,
    resource_automation: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckCompletionStamp {
    state_revision: u64,
    read_generation: Option<u64>,
}

impl CheckCompletionStamp {
    fn from_result(value: &Value) -> Option<Self> {
        if !["skills", "sources", "connections"]
            .iter()
            .all(|field| value[*field].is_array())
        {
            return None;
        }
        let read_generation = match value.get("readGeneration")? {
            Value::Null => None,
            generation => Some(generation.as_u64()?),
        };
        Some(Self {
            state_revision: value["stateRevision"].as_u64()?,
            read_generation,
        })
    }
}

#[derive(Clone, Copy)]
enum StartTaskReply {
    Hidden,
    Full,
    StatusOnly,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskRetentionCounts {
    jobs: usize,
    recorded_jobs: usize,
    active_jobs: usize,
    unique_results: usize,
    compressed_results: usize,
    payload_bytes: usize,
    payload_capacity_bytes: usize,
    scheduling_keys: usize,
    unique_key_sets: usize,
    unique_scheduling_keys: usize,
    key_utf8_bytes: usize,
    key_buffer_capacity_bytes: usize,
    key_vector_capacity_bytes: usize,
    #[serde(skip)]
    result_addresses: BTreeSet<usize>,
    #[serde(skip)]
    key_set_addresses: BTreeSet<usize>,
}

impl TaskRetentionCounts {
    fn include(&mut self, job: &Job) {
        self.jobs += 1;
        self.recorded_jobs += usize::from(job.recorded);
        self.active_jobs += usize::from(!job.task.terminal());
        let keys = &job.task.resources;
        self.scheduling_keys += keys.len();
        if !keys.is_empty() && self.key_set_addresses.insert(keys.as_ptr() as usize) {
            self.unique_key_sets += 1;
            self.unique_scheduling_keys += keys.len();
            self.key_vector_capacity_bytes += std::mem::size_of_val(keys.as_ref());
            for key in keys.iter() {
                self.key_utf8_bytes += key.len();
                self.key_buffer_capacity_bytes += key.capacity();
            }
        }
        if let Some(result) = &job.task.result {
            if self.result_addresses.insert(Arc::as_ptr(result) as usize) {
                self.unique_results += 1;
                self.compressed_results += usize::from(result.compressed);
                self.payload_bytes += result.bytes.len();
                self.payload_capacity_bytes += result.bytes.capacity();
            }
        }
    }
}

fn shared_check_keys(jobs: &BTreeMap<String, Job>, task: &Task) -> Option<Arc<[String]>> {
    if task.action != "check_now" || task.resources.is_empty() {
        return None;
    }
    // Reuse only exact ordered keys from an existing history record. Active
    // scheduler locks still use the separately owned Resource list.
    jobs.values()
        .find(|job| {
            job.task.id != task.id
                && job.recorded
                && job.task.terminal()
                && job.task.action == "check_now"
                && job.task.resources == task.resources
        })
        .map(|job| Arc::clone(&job.task.resources))
}

// Unknown action strings can contain arbitrary caller input, so diagnostics use
// fixed buckets rather than returning request strings, labels or resource keys.
fn retention_action(action: &str) -> &'static str {
    match action {
        "check_now" => "check_now",
        "refresh" => "refresh",
        "audit_skills" => "audit_skills",
        "resource_list" => "resource_list",
        "get_files" => "get_files",
        "get_document" => "get_document",
        "read_file" => "read_file",
        "get_export_plan" => "get_export_plan",
        "preview_update" => "preview_update",
        "preview_upload" => "preview_upload",
        "apply_update" => "apply_update",
        "apply_upload" => "apply_upload",
        "resource_invoke" => "resource_invoke",
        "preview_resource_install" => "preview_resource_install",
        "apply_resource_install" => "apply_resource_install",
        "preview_resource_remove" => "preview_resource_remove",
        "apply_resource_remove" => "apply_resource_remove",
        _ => "other",
    }
}
fn history_jobs(jobs: &BTreeMap<String, Job>) -> Vec<&Job> {
    let mut terminal: Vec<_> = jobs
        .values()
        .filter(|job| job.visible && job.task.terminal())
        .collect();
    terminal.sort_by(|a, b| {
        b.task
            .finished_at
            .as_deref()
            .cmp(&a.task.finished_at.as_deref())
    });
    terminal.truncate(HISTORY_LIMIT);
    terminal.extend(
        jobs.values()
            .filter(|job| job.visible && !job.task.terminal()),
    );
    terminal
}

fn history_records(jobs: &BTreeMap<String, Job>) -> Vec<TaskHistoryRow> {
    history_jobs(jobs)
        .into_iter()
        .map(|job| job.task.history_row())
        .collect()
}

#[derive(Default)]
struct CommittedHistory {
    data_version: Option<i64>,
    terminal_revisions: BTreeMap<String, u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Resource {
    key: String,
    write: bool,
}

fn conflicts(left: &[Resource], right: &[Resource]) -> bool {
    left.iter()
        .any(|a| right.iter().any(|b| a.key == b.key && (a.write || b.write)))
}

#[derive(Default)]
struct Scheduler {
    waiting: Vec<(String, bool, Vec<Resource>)>,
    active: HashMap<String, Vec<Resource>>,
}

pub(crate) struct TaskSystem {
    manager: Arc<Mutex<Manager>>,
    jobs: Mutex<BTreeMap<String, Job>>,
    scheduler: Mutex<Scheduler>,
    wake: Condvar,
    events: Mutex<Option<EventSink>>,
    closing: AtomicBool,
    resource_automation_running: AtomicBool,
    history_lock: Mutex<CommittedHistory>,
    #[cfg(test)]
    snapshot_reads: AtomicU64,
}

impl TaskSystem {
    pub(crate) fn basic_mode(&self) -> bool {
        self.manager
            .lock()
            .map(|manager| manager.basic_mode)
            .unwrap_or(true)
    }
    pub(crate) fn new(manager: Manager) -> Result<Arc<Self>, String> {
        let history = manager.task_history()?;
        let mut jobs = BTreeMap::new();
        for value in history {
            let mut task: Task = serde_json::from_value(value)
                .map_err(|e| format!("无法读取操作记录；原数据库已保留：{e}"))?;
            if !task.terminal() {
                task.status = "interrupted".into();
                task.stage = "上次运行已中断，请检查当前状态后重新操作".into();
                task.finished_at = Some(now());
                task.error = Some("程序在任务完成前关闭；不会自动重放操作".into());
            }
            task.cancellable = false;
            task.result = None;
            task.result_available = false;
            task.result_expired = true;
            if let Some(keys) = shared_check_keys(&jobs, &task) {
                task.resources = keys;
            }
            jobs.insert(
                task.id.clone(),
                Job {
                    task,
                    completion_stamp: None,
                    history_revision: 0,
                    cancel: Arc::new(AtomicBool::new(false)),
                    completion: Arc::new((Mutex::new(None), Condvar::new())),
                    visible: true,
                    recorded: true,
                    consumers: 0,
                    dedup: None,
                    automatic: false,
                    resource_automation: false,
                },
            );
        }
        let service = Arc::new(Self {
            manager: Arc::new(Mutex::new(manager)),
            jobs: Mutex::new(jobs),
            scheduler: Mutex::new(Scheduler::default()),
            wake: Condvar::new(),
            events: Mutex::new(None),
            closing: AtomicBool::new(false),
            resource_automation_running: AtomicBool::new(false),
            history_lock: Mutex::new(CommittedHistory::default()),
            #[cfg(test)]
            snapshot_reads: AtomicU64::new(0),
        });
        {
            let manager = service
                .manager
                .lock()
                .map_err(|_| "Manager state lock failed")?;
            if !manager.basic_mode {
                crate::network::configure(&manager.state.settings)?;
            }
        }
        service.persist_history()?;
        Ok(service)
    }

    pub(crate) fn set_events(&self, events: EventSink) {
        *self.events.lock().expect("task events lock") = Some(events);
    }
    pub(crate) fn set_resource_events(&self, events: EventSink) -> Result<(), String> {
        self.manager
            .lock()
            .map_err(|_| "Manager state lock failed")?
            .resource_runtime
            .set_events(events);
        Ok(())
    }
    pub(crate) fn set_state_events(
        &self,
        events: Arc<dyn Fn(u64) + Send + Sync>,
    ) -> Result<(), String> {
        self.manager
            .lock()
            .map_err(|_| "Manager state lock failed")?
            .set_state_events(events);
        Ok(())
    }
    pub(crate) fn workspace_state(&self) -> Result<Option<Value>, String> {
        self.manager
            .lock()
            .map_err(|_| "Manager state lock failed")?
            .workspace_state()
    }
    pub(crate) fn storage(&self) -> Result<Arc<crate::storage::Storage>, String> {
        Ok(self
            .manager
            .lock()
            .map_err(|_| "Manager state lock failed")?
            .storage
            .clone())
    }
    pub(crate) fn migrate_storage(&self, preview_id: &str) -> Result<(), String> {
        if self.basic_mode() {
            return Err("基本模式不执行存储迁移".into());
        }
        let manager = self
            .manager
            .lock()
            .map_err(|_| "Manager state lock failed")?;
        manager
            .storage
            .migrate(preview_id, |destination| manager.copy_database(destination))
    }
    #[cfg(test)]
    pub(crate) fn match_external_background(
        self: &Arc<Self>,
        after: Option<String>,
    ) -> std::thread::JoinHandle<()> {
        self.match_external_background_for(after, None)
    }
    fn match_external_background_for(
        self: &Arc<Self>,
        after: Option<String>,
        selected: Option<Vec<Value>>,
    ) -> std::thread::JoinHandle<()> {
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || {
            let Some(service) = weak.upgrade() else {
                return;
            };
            if let Some(id) = after {
                let _ = service.wait(&id);
            }
            if let Ok(snapshot) = service.snapshot() {
                if snapshot["checkMode"] != "auto" || snapshot["startup"]["basicMode"] == true {
                    return;
                }
                let generation = snapshot["checkGeneration"].clone();
                for skill in snapshot["skills"].as_array().into_iter().flatten() {
                    if selected
                        .as_ref()
                        .is_some_and(|ids| !ids.contains(&skill["id"]))
                    {
                        continue;
                    }
                    if service.closing.load(Ordering::Relaxed) {
                        break;
                    }
                    if skill["localPath"].is_string()
                        && skill["repo"].is_string()
                        && skill["sourceId"].is_string()
                        && skill["readOnly"] != true
                    {
                        let Some(commit) = skill["commit"].as_str().filter(|v| v.len() == 40)
                        else {
                            continue;
                        };
                        let inventory=service.start(json!({"action":"get_external_dependencies","skillId":skill["id"],"remoteCommit":commit,"automatic":true,"checkGeneration":generation}),Some("正在核对外部文件来源"),None,false,false,crate::dispatch);
                        let Ok(inventory) = inventory else {
                            continue;
                        };
                        let Some(id) = inventory["id"].as_str() else {
                            continue;
                        };
                        let report = service.wait(id);
                        service.release_compat(id);
                        if let Ok(report) = report {
                            let items:Vec<_>=report["items"].as_array().into_iter().flatten().filter(|item|!matches!(item["referenceKind"].as_str(),Some("command"|"skill_alias"))).map(|item|json!({"id":item["id"],"expectedFingerprint":item["referenceFingerprint"]})).collect();
                            if !items.is_empty() {
                                let _=service.background(json!({"action":"batch_external_dependencies","operation":"auto_match","skillId":skill["id"],"remoteCommit":commit,"items":items,"automatic":true,"checkGeneration":generation}),"正在匹配外部文件来源",crate::dispatch);
                            }
                        }
                    }
                }
            }
        })
    }
    pub(crate) fn store_workspace_state(&self, value: &Value) -> Result<(), String> {
        self.manager
            .lock()
            .map_err(|_| "Manager state lock failed")?
            .store_workspace_state(value)
    }
    pub(crate) fn store_workspace_move(
        &self,
        layout: &Value,
        pane_id: &str,
        window_label: &str,
    ) -> Result<(), String> {
        let mut history = self
            .history_lock
            .lock()
            .map_err(|_| "Task history lock failed")?;
        let mut jobs = self.jobs.lock().map_err(|_| "Task registry lock failed")?;
        let previous: Vec<_> = jobs
            .iter()
            .filter(|(_, job)| job.task.origin["paneId"] == pane_id)
            .map(|(id, job)| (id.clone(), job.task.origin.clone()))
            .collect();
        for (id, _) in &previous {
            jobs.get_mut(id).expect("registered task").task.origin["windowLabel"] =
                json!(window_label);
        }
        let records = history_records(&jobs);
        let result = self
            .manager
            .lock()
            .map_err(|_| "Manager state lock failed")?
            .store_workspace_with_history(layout, &records);
        if let Err(error) = result {
            for (id, origin) in previous {
                jobs.get_mut(&id).expect("registered task").task.origin = origin;
            }
            return Err(error);
        }
        *history = CommittedHistory::default();
        Ok(())
    }
    pub(crate) fn background(
        self: &Arc<Self>,
        request: Value,
        label: &str,
        dispatch: Dispatch,
    ) -> Result<Value, String> {
        self.start(
            request,
            Some(label),
            Some(&json!({"view":"skills","windowLabel":"application"})),
            false,
            true,
            dispatch,
        )
    }

    pub(crate) fn snapshot(&self) -> Result<Value, String> {
        #[cfg(test)]
        self.snapshot_reads.fetch_add(1, Ordering::Relaxed);
        Ok(self
            .manager
            .lock()
            .map_err(|_| "Manager state lock failed")?
            .snapshot())
    }

    /// The existing scheduler tick shares the live writer with maintenance changes.
    pub(crate) fn release_idle_resources(&self) -> Result<Value, String> {
        if self.closing.load(Ordering::Relaxed) {
            return Ok(json!({"released":[],"reason":"管理器正在退出"}));
        }
        let manager = self
            .manager
            .lock()
            .map_err(|_| "Manager state lock failed")?;
        crate::resource_runtime::release_idle(&manager)
    }

    /// Read scheduler policy every tick; only active skill watches need path data.
    pub(crate) fn check_configuration(&self) -> Result<Value, String> {
        let manager = self
            .manager
            .lock()
            .map_err(|_| "Manager state lock failed")?;
        let mut config = json!({
            "mode": if manager.basic_mode { "manual" } else { manager.state.check_mode.as_str() },
            "generation": manager.state.check_generation,
            "maintenance": crate::maintenance::snapshot(&manager.state.settings, manager.basic_mode),
            "roots": [],
            "skills": [],
        });
        if crate::checks::skill_watch_active(&config) {
            config["roots"] = json!(manager.state.local_roots);
            config["skills"] = Value::Array(
                manager
                    .state
                    .skills
                    .iter()
                    .filter_map(|skill| {
                        Some(json!({"id": skill["id"], "localPath": skill["localPath"].as_str()?}))
                    })
                    .collect(),
            );
        }
        Ok(config)
    }

    pub(crate) fn automatic_check(self: &Arc<Self>, request: Value) -> Result<(), String> {
        let selected = request["skillIds"].as_array().cloned();
        let task = self.start(
            request,
            Some("正在检查变化"),
            None,
            false,
            false,
            crate::dispatch,
        )?;
        let id = task["id"].as_str().ok_or("Invalid task ID")?.to_owned();
        let service = self.clone();
        std::thread::spawn(move || {
            let changed = service
                .wait(&id)
                .is_ok_and(|value| value["checkSummary"]["changed"] == true);
            service.release_compat(&id);
            if changed {
                let _ = service.match_external_background_for(None, selected);
            }
        });
        Ok(())
    }

    pub(crate) fn automatic_resource_version_check(self: &Arc<Self>) -> Result<(), String> {
        let task = self.start(
            json!({"action":"__resource_version_due","automatic":true}),
            Some("正在检查工具版本"),
            None,
            false,
            false,
            crate::resource_checks::dispatch_due,
        )?;
        let id = task["id"].as_str().ok_or("Invalid task ID")?.to_owned();
        let service = self.clone();
        std::thread::spawn(move || {
            let checked = service.wait(&id).is_ok();
            service.release_compat(&id);
            if checked {
                service.schedule_resource_automation();
            }
        });
        Ok(())
    }

    fn schedule_resource_automation(self: &Arc<Self>) {
        if self
            .resource_automation_running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let service = self.clone();
        std::thread::spawn(move || {
            struct Reset<'a>(&'a AtomicBool);
            impl Drop for Reset<'_> {
                fn drop(&mut self) {
                    self.0.store(false, Ordering::Release);
                }
            }
            let _reset = Reset(&service.resource_automation_running);
            let _ = crate::resource_automation::engine::run_due(&service);
        });
    }

    /// Internal phases use their existing per-operation locks. The coordinator
    /// never holds the catalogue lock while waiting on a network transfer.
    pub(crate) fn execute_automatic_resource_step(
        self: &Arc<Self>,
        request: Value,
    ) -> Result<Value, String> {
        let task = self.start(
            request,
            Some("自动维护工具"),
            None,
            false,
            false,
            crate::resource_automation::engine::dispatch_step,
        )?;
        let id = task["id"].as_str().ok_or("Invalid task ID")?;
        let outcome = self.wait(id);
        self.release_compat(id);
        outcome
    }

    /// Local discovery has its own short metadata task. It can finish while a
    /// remote check is waiting on the network, then queue association afterward.
    pub(crate) fn automatic_local_check(
        self: &Arc<Self>,
        mut request: Value,
    ) -> Result<(), String> {
        request["action"] = json!("discover_local");
        let task = self.start(
            request.clone(),
            Some("正在发现本地 Skill"),
            None,
            false,
            false,
            crate::dispatch,
        )?;
        let id = task["id"].as_str().ok_or("Invalid task ID")?.to_owned();
        let service = self.clone();
        std::thread::spawn(move || {
            let result = service.wait(&id);
            service.release_compat(&id);
            if let Ok(result) = result {
                let mut ids = request["skillIds"].as_array().cloned().unwrap_or_default();
                for id in result["discoveredSkillIds"]
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    if !ids.contains(id) {
                        ids.push(id.clone());
                    }
                }
                if request["full"] == true || !ids.is_empty() {
                    let mut check = json!({"action":"check_now","automatic":true,"checkGeneration":request["checkGeneration"],"skipLocalDiscovery":true});
                    if request["full"] != true {
                        check["skillIds"] = json!(ids);
                    }
                    let _ = service.automatic_check(check);
                }
            }
        });
        Ok(())
    }

    pub(crate) fn cancel_automatic(&self) {
        self.cancel_automatic_where(false);
    }

    pub(crate) fn cancel_automatic_skill_checks(&self) {
        self.cancel_automatic_where(true);
    }

    fn cancel_automatic_where(&self, skills_only: bool) {
        if let Ok(mut jobs) = self.jobs.lock() {
            for job in jobs.values_mut().filter(|job| {
                job.automatic
                    && (automatic_check_action(&job.task.action)
                        || (!skills_only
                            && (job.task.action == "__resource_version_due"
                                || job.resource_automation)))
                    && job.task.cancellable
                    && !job.task.terminal()
            }) {
                job.cancel.store(true, Ordering::Relaxed);
                job.task.cancel_requested = true;
            }
        }
        self.wake.notify_all();
    }

    pub(crate) fn control(
        self: &Arc<Self>,
        request: &Value,
        dispatch: Dispatch,
    ) -> Result<Option<Value>, String> {
        Ok(Some(match request["action"].as_str().unwrap_or_default() {
            "get_state" => self.snapshot()?,
            "get_content_cache_stats" => {
                if request
                    .as_object()
                    .is_none_or(|fields| fields.keys().any(|field| field != "action"))
                {
                    return Err("缓存诊断只接受读取请求".into());
                }
                let mut value = crate::network::cache_stats()?;
                value["taskRetention"] = self.retention_stats()?;
                value
            }
            "get_startup_status" => self
                .manager
                .lock()
                .map_err(|_| "Manager state lock failed")?
                .startup_status(),
            "start_task" => {
                let business = request
                    .get("request")
                    .filter(|v| v.is_object())
                    .ok_or("start_task requires a business request")?;
                let reply = if request["statusOnly"] == true {
                    if business["action"] != "check_now" {
                        return Err("轻量任务状态仅适用于检查 Skill 变化".into());
                    }
                    StartTaskReply::StatusOnly
                } else {
                    StartTaskReply::Full
                };
                let task = self.start_with_reply(
                    business.clone(),
                    request["label"].as_str(),
                    request.get("origin"),
                    request["foreground"] != false,
                    reply,
                    dispatch,
                )?;
                json!({"task":task})
            }
            "get_task" if request["statusOnly"] == true => {
                json!({"task":self.get_check_status(text(request,"taskId")?)?})
            }
            "get_task" => json!({"task":self.get(text(request,"taskId")?,true)?}),
            "list_tasks" => json!({"tasks":self.list()?}),
            "task_result_files" => {
                let id = text(request, "taskId")?;
                let files = self.result_files(id)?;
                json!({"taskId":id,"files":crate::task_outputs::inspect(&files)})
            }
            "task_open_result" => {
                let id = text(request, "taskId")?;
                let files = self.result_files(id)?;
                crate::task_outputs::open(
                    &files,
                    text(request, "resultId")?,
                    request["folder"].as_bool().ok_or("请选择打开文件或目录")?,
                    self.basic_mode(),
                )?
            }
            "cancel_task" => json!({"task":self.cancel(text(request,"taskId")?)?}),
            "clear_task_history" => {
                if self.basic_mode() {
                    return Err("基本模式不清除操作记录".into());
                }
                let cleared = self.clear_history()?;
                json!({"tasks":self.list()?,"clearedTaskIds":cleared})
            }
            "prepare_close" => self.prepare_close()?,
            "cancel_close" => {
                self.closing.store(false, Ordering::Relaxed);
                json!({"ready":true})
            }
            _ => return Ok(None),
        }))
    }

    pub(crate) fn execute(
        self: &Arc<Self>,
        request: Value,
        dispatch: Dispatch,
    ) -> Result<Value, String> {
        if let Some(value) = self.control(&request, dispatch)? {
            return Ok(value);
        }
        let task = self.start(request, None, None, true, false, dispatch)?;
        let id = task["id"].as_str().ok_or("Invalid task ID")?;
        let outcome = self.wait(id);
        self.release_compat(id);
        outcome
    }

    fn start(
        self: &Arc<Self>,
        request: Value,
        label: Option<&str>,
        origin: Option<&Value>,
        foreground: bool,
        visible: bool,
        dispatch: Dispatch,
    ) -> Result<Value, String> {
        let reply = if visible {
            StartTaskReply::Full
        } else {
            StartTaskReply::Hidden
        };
        self.start_with_reply(request, label, origin, foreground, reply, dispatch)
    }

    fn start_with_reply(
        self: &Arc<Self>,
        request: Value,
        label: Option<&str>,
        origin: Option<&Value>,
        foreground: bool,
        reply: StartTaskReply,
        dispatch: Dispatch,
    ) -> Result<Value, String> {
        let action = text(&request, "action")?.to_owned();
        let visible = !matches!(reply, StartTaskReply::Hidden);
        let reply_for = |task: &Task| match reply {
            StartTaskReply::StatusOnly => task.summary(),
            _ => task.metadata(),
        };
        let internal_resource_automation = std::ptr::fn_addr_eq(
            dispatch,
            crate::resource_automation::engine::dispatch_step as Dispatch,
        );
        if (request.get("automation").is_some() || action.starts_with("__resource_automation_"))
            && !internal_resource_automation
        {
            return Err("自动更新执行封套只能由内部调度产生".into());
        }
        if internal_resource_automation
            && (request["automatic"] != true
                || !crate::resource_automation::engine::is_step(&request))
        {
            return Err("内部自动更新步骤无效".into());
        }
        if matches!(
            action.as_str(),
            "start_task"
                | "get_task"
                | "list_tasks"
                | "task_result_files"
                | "task_open_result"
                | "cancel_task"
                | "clear_task_history"
                | "get_state"
                | "get_startup_status"
                | "prepare_close"
                | "cancel_close"
        ) {
            return Err("此请求不能作为后台业务任务启动".into());
        }
        if self.closing.load(Ordering::Relaxed) && action != "set_settings" {
            return Err("程序正在保存并关闭，暂不开始新任务".into());
        }
        let (resources, dedup) = {
            let manager = self
                .manager
                .lock()
                .map_err(|_| "Manager state lock failed")?;
            ensure_task_allowed(&manager, &request, internal_resource_automation)?;
            if request["automatic"] == true {
                validate_task_automatic(&manager.state, &request, internal_resource_automation)?;
            }
            (
                resources_for(&manager, &request)?,
                auto_match_dedup(&manager, &request).or_else(|| dedup_key(&request)),
            )
        };
        let id = uuid::Uuid::new_v4().to_string();
        let cancel = Arc::new(AtomicBool::new(false));
        let task = Task {
            id: id.clone(),
            action: action.clone(),
            label: redact(label.unwrap_or(&action), &request)
                .chars()
                .take(240)
                .collect(),
            status: "queued".into(),
            stage: "等待执行".into(),
            created_at: now(),
            started_at: None,
            finished_at: None,
            origin: clean_origin(origin, &request),
            progress: Value::Null,
            cancellable: true,
            cancel_requested: false,
            result_available: false,
            result_expired: false,
            error: None,
            result: None,
            result_files: Vec::new(),
            resources: resources.iter().map(|r| r.key.clone()).collect(),
        };
        let metadata = reply_for(&task);
        {
            let mut jobs = self.jobs.lock().map_err(|_| "Task registry lock failed")?;
            if let Some(key) = &dedup {
                if let Some(existing) = jobs.values_mut().find(|job| {
                    !job.task.terminal()
                        && !job.task.cancel_requested
                        && job.dedup.as_ref() == Some(key)
                }) {
                    if visible {
                        existing.visible = true;
                        existing.recorded = true;
                    } else {
                        existing.consumers += 1;
                    }
                    return Ok(reply_for(&existing.task));
                }
            }
            jobs.insert(
                id.clone(),
                Job {
                    task,
                    completion_stamp: None,
                    history_revision: 0,
                    cancel: cancel.clone(),
                    completion: Arc::new((Mutex::new(None), Condvar::new())),
                    visible,
                    recorded: visible,
                    consumers: usize::from(!visible),
                    dedup,
                    automatic: request["automatic"] == true,
                    resource_automation: internal_resource_automation,
                },
            );
        }
        if let Err(error) = self.persist_visible(&id) {
            self.jobs
                .lock()
                .map_err(|_| "Task registry lock failed")?
                .remove(&id);
            return Err(format!("未能保存任务记录，任务未开始：{error}"));
        }
        self.emit(&id);
        let service = self.clone();
        std::thread::spawn(move || {
            service.run(id, request, resources, foreground, cancel, dispatch)
        });
        Ok(metadata)
    }

    fn run(
        self: Arc<Self>,
        id: String,
        request: Value,
        resources: Vec<Resource>,
        foreground: bool,
        cancel: Arc<AtomicBool>,
        dispatch: Dispatch,
    ) {
        let internal_resource_automation = std::ptr::fn_addr_eq(
            dispatch,
            crate::resource_automation::engine::dispatch_step as Dispatch,
        );
        // The local dispatcher reads documentation without saving state or
        // touching approvals. Other dispatchers retain their merge semantics.
        let local_dispatch = std::ptr::fn_addr_eq(dispatch, crate::dispatch_local as Dispatch);
        let local_document_read = request["action"] == "get_document" && local_dispatch;
        let defer_check_snapshot = request["action"] == "check_now"
            && (local_dispatch || std::ptr::fn_addr_eq(dispatch, crate::dispatch as Dispatch));
        let outcome =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<Value, String> {
                let _resources = self.acquire(&id, resources, foreground, &cancel)?;
                if cancel.load(Ordering::Relaxed) {
                    return Err(CANCELLED.into());
                }
                let cancellable = if request["action"] == "resource_invoke" {
                    let manager = self
                        .manager
                        .lock()
                        .map_err(|_| "Manager state lock failed")?;
                    crate::resource_runtime::invocation_cancellable(&manager, &request)?
                } else {
                    read_request(&request)
                        || matches!(
                            request["action"].as_str(),
                            Some(
                                "apply_resource_download"
                                    | "apply_resource_package_download"
                                    | "apply_resource_package_resume"
                            )
                        )
                };
                {
                    let mut jobs = self.jobs.lock().map_err(|_| "Task registry lock failed")?;
                    let task = &mut jobs.get_mut(&id).ok_or("任务不存在")?.task;
                    if cancel.load(Ordering::Relaxed) {
                        return Err(CANCELLED.into());
                    }
                    task.status = "running".into();
                    task.started_at = Some(now());
                    task.stage = if request["action"] == "resource_invoke" {
                        if cancellable {
                            "正在运行受管动作，可取消本次进程"
                        } else {
                            "正在运行受管动作，等待完成"
                        }
                    } else if matches!(
                        request["action"].as_str(),
                        Some(
                            "apply_resource_download"
                                | "apply_resource_package_download"
                                | "apply_resource_package_resume"
                        )
                    ) {
                        "正在下载，可取消并保留已接收内容"
                    } else if cancellable {
                        "正在读取与核对，可在后台继续"
                    } else {
                        "正在执行，关键写入期间不可中止"
                    }
                    .into();
                    task.cancellable = cancellable;
                }
                self.emit(&id);
                self.persist_visible(&id)?;
                let (mut worker, hook) = {
                    let manager = self
                        .manager
                        .lock()
                        .map_err(|_| "Manager state lock failed")?;
                    // Document reads never use approvals; keep large unrelated update
                    // previews out of both snapshots without changing other tasks.
                    let include_previews = request["action"] != "get_document";
                    let hook = Arc::new(WorkerHook {
                        service: Arc::downgrade(&self),
                        base: (!local_document_read).then(|| {
                            Mutex::new(WorkerBase {
                                state: manager.state.clone(),
                                previews: if include_previews {
                                    manager.previews.clone()
                                } else {
                                    HashMap::new()
                                },
                                undo: manager.management_undo.clone(),
                                redo: manager.management_redo.clone(),
                            })
                        }),
                        action: request["action"].as_str().unwrap_or_default().to_owned(),
                        request: request.clone(),
                        cancel: cancel.clone(),
                        cancellable,
                        commit_started: AtomicBool::new(false),
                        internal_resource_automation,
                        check_summary: defer_check_snapshot.then(|| Mutex::new(None)),
                    });
                    let local_skill = if local_document_read && request["automatic"] != true {
                        crate::remote::local_document_skill(&manager, &request)
                    } else {
                        None
                    };
                    // This read only needs its target at the point the resource lock is held.
                    // The original dispatcher still owns validation, I/O, and the result.
                    let worker = if let Some(skill) = local_skill {
                        manager.detached_for_local_document(hook.clone(), skill)
                    } else {
                        manager.detached(hook.clone(), include_previews)
                    };
                    (worker, hook)
                };
                if request["automatic"] == true {
                    validate_task_automatic(&worker.state, &request, internal_resource_automation)?;
                }
                let progress_service = Arc::downgrade(&self);
                let progress_id = id.clone();
                let result = with_progress(
                    Arc::new(move |stage, completed, total| {
                        if let Some(service) = progress_service.upgrade() {
                            service.change(&progress_id, |task| {
                                if !task.cancel_requested {
                                    task.stage = stage.into();
                                    task.progress = match (completed, total) {
                                        (Some(completed), Some(total)) => {
                                            json!({"completed":completed,"total":total})
                                        }
                                        _ => Value::Null,
                                    };
                                }
                            });
                        }
                    }),
                    || {
                        crate::network::with_task_context(
                            crate::network::TaskContext {
                                foreground,
                                cancel: if cancellable {
                                    cancel.clone()
                                } else {
                                    Arc::new(AtomicBool::new(false))
                                },
                            },
                            || dispatch(&mut worker, &request),
                        )
                    },
                );
                // A consumed preview stays consumed on failure. Management history
                // is already committed with its state by the writer.
                if !local_document_read {
                    hook.publish_ephemeral(&worker)?;
                }
                let mut value = result?;
                // A verified download receipt is a completed write. Cancellation
                // arriving after its final commit must not disguise that result.
                // An invocation also owns its terminal result: keep the observed
                // outcome and evidence when cancellation races with completion.
                let invocation_completed = request["action"] == "resource_invoke"
                    && matches!(
                        value["run"]["status"].as_str(),
                        Some("succeeded" | "failed" | "timed_out" | "stopped")
                    );
                if cancellable
                    && !matches!(
                        request["action"].as_str(),
                        Some(
                            "apply_resource_download"
                                | "apply_resource_package_download"
                                | "apply_resource_package_resume"
                        )
                    )
                    && !invocation_completed
                    && cancel.load(Ordering::Relaxed)
                {
                    if request["action"] == "resource_invoke" && value["run"]["status"] == "running"
                    {
                        if let Some(run_id) = value["run"]["runId"].as_str() {
                            worker.resource_runtime.stop(run_id)?;
                        }
                    }
                    return Err(CANCELLED.into());
                }
                if let Some(summary) = hook.take_check_summary()? {
                    // The detached check and its merge base are finished.
                    // Release them before building the full live result.
                    drop(worker);
                    drop(hook);
                    value = self.snapshot()?;
                    for field in ["sceneRevision", "activeSceneId", "sceneError"] {
                        if value.get(field).is_none() {
                            value[field] = Value::Null;
                        }
                    }
                    value["checkSummary"] = summary;
                } else {
                    rebase_result(&mut value, || self.snapshot())?;
                }
                crate::resource_lifecycle::scrub_public_receipts(&mut value);
                Ok(value)
            }))
            .unwrap_or_else(|_| Err("后台操作异常终止；请检查当前状态后重试".into()));
        self.finish(&id, outcome, &request, cancel.load(Ordering::Relaxed));
    }

    fn finish(&self, id: &str, outcome: Result<Value, String>, request: &Value, cancelled: bool) {
        // Encode outside the registry lock so status reads never wait for it.
        let stored = outcome
            .as_ref()
            .map(|value| Arc::new(TaskResult::new(value)))
            .map_err(Clone::clone);
        // File metadata can live on a slow selected volume; never hold the task
        // registry lock while checking it.
        let result_files = outcome
            .as_ref()
            .map(|value| {
                crate::task_outputs::capture(request["action"].as_str().unwrap_or_default(), value)
            })
            .unwrap_or_default();
        let completion = {
            let mut jobs = self.jobs.lock().expect("task registry lock");
            let shared_keys = jobs
                .get(id)
                .and_then(|job| shared_check_keys(&jobs, &job.task));
            let Some(job) = jobs.get_mut(id) else {
                return;
            };
            if let Some(keys) = shared_keys {
                job.task.resources = keys;
            }
            // Only useful automatic results enter operation history. Empty
            // polling rounds remain transient and cannot evict user actions.
            if job.automatic && !cancelled {
                let meaningful = if job.resource_automation {
                    job.task.action == "__resource_automation_finish"
                        && match &outcome {
                            Ok(value) => {
                                value["automaticResult"]["status"] == "stopped"
                                    || (value["automaticResult"]["status"] == "completed"
                                        && value["automaticResult"]["changed"] == true)
                            }
                            Err(_) => true,
                        }
                } else {
                    match &outcome {
                        Ok(value) => {
                            value["checkSummary"]["changed"] == true
                                || (job.task.action == "repair_client_connections"
                                    && value["connectionResults"]
                                        .as_array()
                                        .is_some_and(|items| !items.is_empty()))
                        }
                        Err(error) => !error.contains("自动检查设置已改变"),
                    }
                };
                if meaningful {
                    job.visible = true;
                    job.recorded = true;
                }
            }
            job.task.finished_at = Some(now());
            job.task.cancellable = false;
            match &outcome {
                Ok(value) => {
                    let incomplete_resource = matches!(
                        job.task.action.as_str(),
                        "apply_resource_install"
                            | "apply_resource_remove"
                            | "apply_resource_repair"
                            | "apply_resource_package_prepare"
                            | "apply_resource_package_download"
                            | "apply_resource_package_resume"
                            | "apply_resource_package_materialize"
                            | "apply_resource_package_commit"
                    ) && value["complete"] == false;
                    let stopped_automation =
                        job.resource_automation && value["automaticResult"]["status"] == "stopped";
                    job.task.status =
                        if partial(value) || incomplete_resource || stopped_automation {
                            "partial"
                        } else {
                            "succeeded"
                        }
                        .into();
                    job.task.stage = if stopped_automation {
                        "自动更新已停止，已完成的阶段与保留内容可查看"
                    } else if partial(value) || incomplete_resource {
                        "操作完成，部分项目需要处理"
                    } else {
                        "操作完成"
                    }
                    .into();
                    if value["autoMatchSummary"].is_object() {
                        let summary = &value["autoMatchSummary"];
                        job.task.stage = format!(
                            "已匹配 {} · 记录修复 {} · 远端就绪 {} · 补齐需预览 {} · 待选择 {} · 缺失 {} · 异常 {}",
                            summary["matched"].as_u64().unwrap_or(0),
                            summary["recordsRepaired"].as_u64().unwrap_or(0),
                            summary["remoteReady"].as_u64().unwrap_or(0),
                            summary["localPreviewRequired"].as_u64().unwrap_or(0),
                            summary["needsSelection"].as_u64().unwrap_or(0),
                            summary["missing"].as_u64().unwrap_or(0),
                            summary["error"].as_u64().unwrap_or(0)
                        );
                    }
                    job.task.result = stored.as_ref().ok().cloned();
                    job.task.result_files = result_files;
                    if job.task.action == "resource_invoke" {
                        match value["run"]["status"].as_str() {
                            Some("failed" | "timed_out") => {
                                job.task.status = "failed".into();
                                if value["run"]["protocolEvidence"].is_object() {
                                    job.task.stage = "MCP 调用未成功完成，请查看运行结果".into();
                                    job.task.error =
                                        Some(format!("MCP 调用状态：{}", value["run"]["status"]));
                                } else {
                                    job.task.stage = "进程未成功完成，请查看运行结果".into();
                                    job.task.error = Some(format!(
                                        "受管进程状态：{}；退出码：{}",
                                        value["run"]["status"], value["run"]["exitCode"]
                                    ));
                                }
                            }
                            Some("stopped") => {
                                job.task.status = "cancelled".into();
                                job.task.stage = "受管进程已停止".into();
                            }
                            Some("running") => {
                                job.task.stage = "服务进程已启动，运行状态单独显示".into();
                            }
                            _ => {}
                        }
                    }
                    job.task.result_available = true;
                    job.task.progress = result_progress(value);
                    if job.task.action == "check_now" {
                        job.completion_stamp = CheckCompletionStamp::from_result(value);
                    }
                }
                Err(error) => {
                    let is_cancel = cancelled
                        && (error == CANCELLED
                            || read_task(&job.task.action)
                            || (matches!(
                                job.task.action.as_str(),
                                "apply_resource_download" | "resource_invoke"
                            ) && error == "操作已取消"));
                    job.task.status = if is_cancel { "cancelled" } else { "failed" }.into();
                    job.task.stage = if is_cancel && job.task.action == "apply_resource_download" {
                        "已取消下载，已接收内容保留供复核或续传"
                    } else if is_cancel {
                        "已停止，未开始的操作不再执行"
                    } else {
                        "操作未完成，请查看原因"
                    }
                    .into();
                    job.task.error = Some(redact(error, request));
                }
            }
            job.completion.clone()
        };
        if let Err(error) = self.persist_visible(id) {
            self.change(id, |task| {
                task.error = Some(format!("操作结果已保留在当前会话；历史保存失败：{error}"));
            });
        }
        self.emit(id);
        self.prune();
        *completion.0.lock().expect("task completion lock") = Some(stored);
        completion.1.notify_all();
    }

    fn acquire(
        self: &Arc<Self>,
        id: &str,
        resources: Vec<Resource>,
        foreground: bool,
        cancel: &AtomicBool,
    ) -> Result<ResourceGuard, String> {
        let mut scheduler = self
            .scheduler
            .lock()
            .map_err(|_| "Task queue lock failed")?;
        scheduler
            .waiting
            .push((id.into(), foreground, resources.clone()));
        loop {
            if cancel.load(Ordering::Relaxed) {
                scheduler.waiting.retain(|(key, _, _)| key != id);
                self.wake.notify_all();
                return Err(CANCELLED.into());
            }
            let index = scheduler
                .waiting
                .iter()
                .position(|(key, _, _)| key == id)
                .ok_or("Task left queue")?;
            let active_conflict = scheduler
                .active
                .values()
                .any(|held| conflicts(held, &resources));
            let waiting_conflict =
                scheduler
                    .waiting
                    .iter()
                    .enumerate()
                    .any(|(other, (key, priority, wants))| {
                        key != id
                            && conflicts(wants, &resources)
                            && ((*priority && !foreground)
                                || (*priority == foreground && other < index))
                    });
            if !active_conflict && !waiting_conflict {
                scheduler.waiting.remove(index);
                scheduler.active.insert(id.into(), resources);
                return Ok(ResourceGuard {
                    service: self.clone(),
                    id: id.into(),
                });
            }
            scheduler = self
                .wake
                .wait_timeout(scheduler, Duration::from_millis(100))
                .map_err(|_| "Task queue wait failed")?
                .0;
        }
    }

    fn wait(&self, id: &str) -> Result<Value, String> {
        let completion = self
            .jobs
            .lock()
            .map_err(|_| "Task registry lock failed")?
            .get(id)
            .ok_or("任务不存在")?
            .completion
            .clone();
        let mut value = completion
            .0
            .lock()
            .map_err(|_| "Task completion lock failed")?;
        while value.is_none() {
            value = completion
                .1
                .wait(value)
                .map_err(|_| "Task completion wait failed")?;
        }
        let result = value.as_ref().expect("completed task").clone();
        drop(value);
        result?.read()
    }
    fn release_compat(&self, id: &str) {
        let mut jobs = self.jobs.lock().expect("task registry lock");
        let remove = jobs.get_mut(id).is_some_and(|job| {
            job.consumers -= 1;
            !job.recorded && job.consumers == 0 && job.task.terminal()
        });
        if remove {
            jobs.remove(id);
        }
    }

    fn result_files(&self, id: &str) -> Result<Vec<crate::task_outputs::ResultFile>, String> {
        let jobs = self.jobs.lock().map_err(|_| "Task registry lock failed")?;
        Ok(jobs
            .get(id)
            .ok_or("操作记录已移除或不存在")?
            .task
            .result_files
            .clone())
    }

    fn get(&self, id: &str, result: bool) -> Result<Value, String> {
        let jobs = self.jobs.lock().map_err(|_| "Task registry lock failed")?;
        let job = jobs.get(id).ok_or("操作记录已移除或不存在")?;
        let mut value = job.task.metadata();
        let payload = result.then(|| job.task.result.clone()).flatten();
        if !job.visible {
            value["hidden"] = json!(true);
        }
        drop(jobs);
        if let Some(payload) = payload {
            value["result"] = payload.read()?;
        }
        Ok(value)
    }

    fn get_check_status(&self, id: &str) -> Result<Value, String> {
        let jobs = self.jobs.lock().map_err(|_| "Task registry lock failed")?;
        let job = jobs.get(id).ok_or("操作记录已移除或不存在")?;
        if job.task.action != "check_now" {
            return Err("轻量任务状态仅适用于检查 Skill 变化".into());
        }
        let mut value = job.task.summary();
        if !job.visible {
            value["hidden"] = json!(true);
        }
        if let Some(stamp) = &job.completion_stamp {
            value["completionStamp"] = json!(stamp);
        }
        Ok(value)
    }
    fn retention_stats(&self) -> Result<Value, String> {
        let mut total = TaskRetentionCounts::default();
        let mut by_action = BTreeMap::<&'static str, TaskRetentionCounts>::new();
        {
            let jobs = self.jobs.lock().map_err(|_| "Task registry lock failed")?;
            for job in jobs.values() {
                total.include(job);
                by_action
                    .entry(retention_action(&job.task.action))
                    .or_default()
                    .include(job);
            }
        }
        // Completion shares result Arcs and history can share exact key slices.
        // Exclude workers, external callers, allocator overhead and SQLite.
        let mut value = serde_json::to_value(total).map_err(|error| error.to_string())?;
        value["formatVersion"] = json!(1);
        value["scope"] = json!("job-owned-result-and-key-buffers");
        value["byActionDeduplication"] = json!("within-each-action");
        value["historyLimit"] = json!(HISTORY_LIMIT);
        value["byAction"] = serde_json::to_value(by_action).map_err(|error| error.to_string())?;
        Ok(value)
    }
    fn list(&self) -> Result<Vec<Value>, String> {
        let jobs = self.jobs.lock().map_err(|_| "Task registry lock failed")?;
        let mut tasks: Vec<_> = jobs
            .values()
            .filter(|job| job.visible)
            .map(|job| job.task.summary())
            .collect();
        tasks.sort_by(|a, b| b["createdAt"].as_str().cmp(&a["createdAt"].as_str()));
        Ok(tasks)
    }
    fn cancel(&self, id: &str) -> Result<Value, String> {
        {
            let mut jobs = self.jobs.lock().map_err(|_| "Task registry lock failed")?;
            let job = jobs.get_mut(id).ok_or("任务不存在")?;
            if job.task.terminal() {
                return Ok(job.task.metadata());
            }
            if !job.task.cancellable {
                return Err("任务正在执行关键写入，完成后会给出结果".into());
            }
            job.cancel.store(true, Ordering::Relaxed);
            job.task.cancel_requested = true;
            job.task.stage = if job.task.action == "resource_invoke" {
                "正在停止本次受管进程"
            } else {
                "正在停止；当前网络请求返回后结束"
            }
            .into();
        }
        self.wake.notify_all();
        self.emit(id);
        self.persist_history()?;
        self.get(id, false)
    }
    fn change(&self, id: &str, change: impl FnOnce(&mut Task)) {
        if let Some(job) = self.jobs.lock().expect("task registry lock").get_mut(id) {
            change(&mut job.task);
            if job.task.terminal() {
                job.history_revision += 1;
            }
        }
        self.emit(id);
    }
    fn emit(&self, id: &str) {
        let task = {
            let jobs = self.jobs.lock().expect("task registry lock");
            let Some(job) = jobs.get(id).filter(|job| job.visible) else {
                return;
            };
            job.task.summary()
        };
        if let Some(events) = self.events.lock().expect("task events lock").clone() {
            events(json!({"task":task}));
        }
    }
    fn persist_history(&self) -> Result<(), String> {
        let mut history = self
            .history_lock
            .lock()
            .map_err(|_| "Task history lock failed")?;
        let data_version = history.data_version;
        if self.persist_history_snapshot(&mut history, data_version)? {
            return Ok(());
        }
        // A changed database or a missing archived row needs a full snapshot.
        if self.persist_history_snapshot(&mut history, None)? {
            return Ok(());
        }
        Err("Unable to reconcile task history".into())
    }
    fn persist_history_snapshot(
        &self,
        history: &mut CommittedHistory,
        data_version: Option<i64>,
    ) -> Result<bool, String> {
        let (retained, records, terminal_revisions) = {
            let jobs = self.jobs.lock().map_err(|_| "Task registry lock failed")?;
            let mut retained = BTreeSet::new();
            let mut records = vec![];
            let mut terminal_revisions = BTreeMap::new();
            for job in history_jobs(&jobs) {
                let id = &job.task.id;
                retained.insert(id.clone());
                if job.task.terminal() {
                    terminal_revisions.insert(id.clone(), job.history_revision);
                    if data_version.is_some()
                        && history.terminal_revisions.get(id) == Some(&job.history_revision)
                    {
                        continue;
                    }
                }
                // Keep the latest progress of every visible active job.
                records.push(job.task.history_row());
            }
            (retained, records, terminal_revisions)
        };
        let saved = self
            .manager
            .lock()
            .map_err(|_| "Manager state lock failed")?
            .store_task_history_rows(&retained, &records, data_version)?;
        let TaskHistoryWrite::Saved(data_version) = saved else {
            return Ok(false);
        };
        *history = CommittedHistory {
            data_version,
            terminal_revisions,
        };
        Ok(true)
    }
    fn persist_visible(&self, id: &str) -> Result<(), String> {
        let visible = self
            .jobs
            .lock()
            .map_err(|_| "Task registry lock failed")?
            .get(id)
            .is_some_and(|job| job.visible);
        if visible {
            self.persist_history()
        } else {
            Ok(())
        }
    }
    fn prune(&self) {
        let mut jobs = self.jobs.lock().expect("task registry lock");
        let mut terminal: Vec<_> = jobs
            .iter()
            .filter(|(_, job)| job.recorded && job.task.terminal())
            .map(|(id, job)| (id.clone(), job.task.finished_at.clone()))
            .collect();
        terminal.sort_by(|a, b| b.1.cmp(&a.1));
        for (id, _) in terminal.into_iter().skip(HISTORY_LIMIT) {
            if jobs.get(&id).is_some_and(|job| job.consumers == 0) {
                jobs.remove(&id);
            }
        }
        // Compatibility calls are not user-visible history entries. A completed
        // caller still owns its completion Arc after removal.
        jobs.retain(|_, job| {
            job.recorded
                || !job.task.terminal()
                || job.consumers > 0
                || Arc::strong_count(&job.completion) > 1
        });
    }
    fn clear_history(&self) -> Result<Vec<String>, String> {
        let cleared = {
            let mut jobs = self.jobs.lock().map_err(|_| "Task registry lock failed")?;
            jobs.values_mut()
                .filter_map(|job| {
                    if job.task.terminal() && job.visible {
                        job.visible = false;
                        Some(job.task.id.clone())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
        };
        if let Err(error) = self.persist_history() {
            let mut jobs = self.jobs.lock().map_err(|_| "Task registry lock failed")?;
            for id in &cleared {
                if let Some(job) = jobs.get_mut(id) {
                    job.visible = true;
                }
            }
            return Err(error);
        }
        if let Some(events) = self
            .events
            .lock()
            .map_err(|_| "Task events lock failed")?
            .clone()
        {
            events(json!({"clearedTaskIds":cleared,"tasks":self.list()?}));
        }
        Ok(cleared)
    }
    fn prepare_close(&self) -> Result<Value, String> {
        self.closing.store(true, Ordering::Relaxed);
        let running = {
            let mut jobs = self.jobs.lock().map_err(|_| "Task registry lock failed")?;
            jobs.values_mut()
                .filter(|job| !job.task.terminal())
                .map(|job| {
                    if job.task.cancellable {
                        job.cancel.store(true, Ordering::Relaxed);
                        job.task.cancel_requested = true;
                        job.task.stage = "程序正在关闭，等待本次读取停止".into();
                    }
                    (job.task.id.clone(), job.completion.clone())
                })
                .collect::<Vec<_>>()
        };
        self.wake.notify_all();
        for (id, _) in &running {
            self.emit(id);
        }
        for (_, completion) in running {
            let mut value = completion
                .0
                .lock()
                .map_err(|_| "Task completion lock failed")?;
            while value.is_none() {
                value = completion
                    .1
                    .wait(value)
                    .map_err(|_| "Task completion wait failed")?;
            }
        }
        self.manager
            .lock()
            .map_err(|_| "Manager state lock failed")?
            .resource_runtime
            .shutdown()?;
        self.persist_history()?;
        Ok(json!({"ready":true}))
    }
}

struct ResourceGuard {
    service: Arc<TaskSystem>,
    id: String,
}
impl Drop for ResourceGuard {
    fn drop(&mut self) {
        if let Ok(mut scheduler) = self.service.scheduler.lock() {
            scheduler.active.remove(&self.id);
        }
        self.service.wake.notify_all();
    }
}

struct WorkerBase {
    state: State,
    previews: HashMap<String, Value>,
    undo: Vec<Value>,
    redo: Vec<Value>,
}
struct WorkerHook {
    service: Weak<TaskSystem>,
    base: Option<Mutex<WorkerBase>>,
    action: String,
    request: Value,
    cancel: Arc<AtomicBool>,
    cancellable: bool,
    commit_started: AtomicBool,
    internal_resource_automation: bool,
    // Only the built-in check dispatcher can hand its summary to finalization.
    check_summary: Option<Mutex<Option<Value>>>,
}

impl WorkerHook {
    fn take_check_summary(&self) -> Result<Option<Value>, String> {
        let Some(summary) = &self.check_summary else {
            return Ok(None);
        };
        Ok(summary
            .lock()
            .map_err(|_| "Check summary lock failed")?
            .take())
    }

    fn resource_spawn_with(
        &self,
        request: crate::resource_runtime::PreparedInvocation,
        prepare: impl FnOnce(
            crate::resources::ResourceRecord,
            crate::resource_runtime::PreparedInvocation,
        ) -> Result<crate::resource_runtime::PreparedSpawn, String>,
    ) -> Result<Value, String> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.into());
        }
        if request.definition.cancellable != self.cancellable {
            return Err("动作取消策略已变化，请重新读取后调用".into());
        }
        let service = self
            .service
            .upgrade()
            .ok_or("Task service is unavailable")?;
        let record = service
            .manager
            .lock()
            .map_err(|_| "Manager state lock failed")?
            .resource_spawn_record(&request)?;
        // File/adapter verification and command setup must not hold the live writer.
        let prepared = prepare(record, request)?;
        let manager = service
            .manager
            .lock()
            .map_err(|_| "Manager state lock failed")?;
        if self.cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.into());
        }
        if prepared.cancellable() != self.cancellable {
            return Err("动作取消策略已变化，请重新读取后调用".into());
        }
        manager.resource_spawn_prepared(prepared)
    }
}

impl ManagerRuntime for WorkerHook {
    fn defer_check_snapshot(&self, summary: &mut Value) -> Result<bool, String> {
        let Some(check_summary) = &self.check_summary else {
            return Ok(false);
        };
        *check_summary
            .lock()
            .map_err(|_| "Check summary lock failed")? = Some(summary.take());
        Ok(true)
    }
    fn ensure_live_maintenance_allowed(&self, basic_mode_error: &str) -> Result<(), String> {
        let service = self
            .service
            .upgrade()
            .ok_or("Task service is unavailable")?;
        let manager = service
            .manager
            .lock()
            .map_err(|_| "Manager state lock failed")?;
        manager.ensure_live_maintenance_allowed(basic_mode_error)
    }
    fn capability_evidence_store(
        &self,
        request: crate::resource_capability_evidence::StoreRequest,
    ) -> Result<Value, String> {
        // Actual completion evidence must survive cancellation after process exit.
        let service = self
            .service
            .upgrade()
            .ok_or("Task service is unavailable")?;
        let manager = service
            .manager
            .lock()
            .map_err(|_| "Manager state lock failed")?;
        manager.capability_evidence_store(request)
    }
    fn resource_automation_store(
        &self,
        request: crate::resource_automation::StoreRequest,
    ) -> Result<Value, String> {
        if self.cancellable && self.cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.into());
        }
        let service = self
            .service
            .upgrade()
            .ok_or("Task service is unavailable")?;
        let manager = service
            .manager
            .lock()
            .map_err(|_| "Manager state lock failed")?;
        manager.resource_automation_store(request)
    }
    fn resource_check_store(
        &self,
        request: crate::resource_checks::StoreRequest,
    ) -> Result<Value, String> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.into());
        }
        let service = self
            .service
            .upgrade()
            .ok_or("Task service is unavailable")?;
        let manager = service
            .manager
            .lock()
            .map_err(|_| "Manager state lock failed")?;
        // The live writer rechecks maintenance and Basic mode, not the detached snapshot.
        manager.resource_check_store(request)
    }
    fn begin_automatic_commit(&self) -> Result<(), String> {
        // Admission is bound to the worker's original request, never an IPC grant.
        if (!self.internal_resource_automation && self.action != "repair_client_connections")
            || (self.internal_resource_automation
                && !matches!(
                    self.action.as_str(),
                    "apply_resource_update_stage"
                        | "apply_resource_update_switch"
                        | "apply_resource_package_materialize"
                        | "apply_resource_package_commit"
                ))
            || self.request["action"] != self.action
            || self.request["automatic"] != true
        {
            return Err("此任务没有自动写入流程".into());
        }
        let service = self
            .service
            .upgrade()
            .ok_or("Task service is unavailable")?;
        let manager = service
            .manager
            .lock()
            .map_err(|_| "Manager state lock failed")?;
        ensure_task_allowed(&manager, &self.request, self.internal_resource_automation)?;
        validate_task_automatic(
            &manager.state,
            &self.request,
            self.internal_resource_automation,
        )?;
        // The admitted batch must finish and persist evidence even if its policy
        // changes after this point. Entry ownership/path checks still run normally.
        self.commit_started.store(true, Ordering::Release);
        Ok(())
    }
    fn download_store(
        &self,
        request: crate::resource_github::DownloadStore,
    ) -> Result<Value, String> {
        // Cancellation must still preserve already-received bytes and terminal
        // evidence. This records progress; it never starts or repeats a transfer.
        let service = self
            .service
            .upgrade()
            .ok_or("Task service is unavailable")?;
        let manager = service
            .manager
            .lock()
            .map_err(|_| "Manager state lock failed")?;
        manager.download_store(request)
    }

    fn resource_package_store(
        &self,
        request: crate::resource_package::StoreRequest,
    ) -> Result<Value, String> {
        // An interrupted transfer or builder must retain observed receipts.
        // This journal write does not admit or replay another package phase.
        let service = self
            .service
            .upgrade()
            .ok_or("Task service is unavailable")?;
        let manager = service
            .manager
            .lock()
            .map_err(|_| "Manager state lock failed")?;
        manager.resource_package_store(request)
    }

    fn resource_spawn(
        &self,
        request: crate::resource_runtime::PreparedInvocation,
    ) -> Result<Value, String> {
        self.resource_spawn_with(request, crate::resource_runtime::prepare_spawn)
    }
    fn resource_store(&self, request: crate::resources::StoreRequest) -> Result<Value, String> {
        if self.cancellable && self.cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.into());
        }
        let service = self
            .service
            .upgrade()
            .ok_or("Task service is unavailable")?;
        let manager = service
            .manager
            .lock()
            .map_err(|_| "Manager state lock failed")?;
        if let crate::resources::StoreRequest::Relocate { original, .. } = &request {
            manager.ensure_request_allowed(&self.request)?;
            crate::resource_relocation::ensure_stopped(&manager, &original.id)?;
        }
        manager.resource_store(request)
    }
    fn management_store(
        &self,
        request: crate::management_data::StoreRequest,
    ) -> Result<Value, String> {
        if self.cancellable && self.cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.into());
        }
        let service = self
            .service
            .upgrade()
            .ok_or("Task service is unavailable")?;
        let manager = service
            .manager
            .lock()
            .map_err(|_| "Manager state lock failed")?;
        manager.ensure_request_allowed(&self.request)?;
        manager.management_store(request)
    }
    fn configuration_store(
        &self,
        request: crate::configuration::StoreRequest,
    ) -> Result<Value, String> {
        if self.cancellable && self.cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.into());
        }
        let service = self
            .service
            .upgrade()
            .ok_or("Task service is unavailable")?;
        let mut manager = service
            .manager
            .lock()
            .map_err(|_| "Manager state lock failed")?;
        manager.ensure_request_allowed(&self.request)?;
        manager.configuration_store(request)
    }
    fn scene_store(&self, request: crate::resource_scenes::StoreRequest) -> Result<Value, String> {
        if self.cancellable && self.cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.into());
        }
        let service = self
            .service
            .upgrade()
            .ok_or("Task service is unavailable")?;
        let manager = service
            .manager
            .lock()
            .map_err(|_| "Manager state lock failed")?;
        manager.ensure_request_allowed(&self.request)?;
        manager.scene_store(request)
    }
    fn relation_store(
        &self,
        request: crate::resource_relations::StoreRequest,
    ) -> Result<Value, String> {
        if self.cancellable && self.cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.into());
        }
        let service = self
            .service
            .upgrade()
            .ok_or("Task service is unavailable")?;
        let manager = service
            .manager
            .lock()
            .map_err(|_| "Manager state lock failed")?;
        manager.ensure_request_allowed(&self.request)?;
        manager.relation_store(request)
    }
    fn template_store(
        &self,
        request: crate::invocation_templates::StoreRequest,
    ) -> Result<Value, String> {
        if self.cancellable && self.cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.into());
        }
        let service = self
            .service
            .upgrade()
            .ok_or("Task service is unavailable")?;
        let manager = service
            .manager
            .lock()
            .map_err(|_| "Manager state lock failed")?;
        manager.ensure_request_allowed(&self.request)?;
        manager.template_store(request)
    }
    fn save(&self, worker: &Manager) -> Result<(), String> {
        if self.cancellable && self.cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.into());
        }
        let service = self
            .service
            .upgrade()
            .ok_or("Task service is unavailable")?;
        let mut base = self
            .base
            .as_ref()
            .ok_or("说明读取不能保存管理状态")?
            .lock()
            .map_err(|_| "Task merge lock failed")?;
        let history_changed =
            worker.management_undo != base.undo || worker.management_redo != base.redo;
        let summary_only = self.action == "check_now"
            && !history_changed
            && same_state_except_check_summary(&base.state, &worker.state)
            && valid_summary_merge_state(&base.state);
        if !summary_only {
            validate_observations(&base.state, &worker.state, &self.action)?;
        }
        let mut manager = service
            .manager
            .lock()
            .map_err(|_| "Manager state lock failed")?;
        if self.request["automatic"] == true && !self.commit_started.load(Ordering::Acquire) {
            validate_task_automatic(
                &manager.state,
                &self.request,
                self.internal_resource_automation,
            )?;
        }
        if self.action == "apply_associate" {
            let preview = self.request["previewId"]
                .as_str()
                .and_then(|id| base.previews.get(id))
                .ok_or("来源预览已失效，请重新生成")?;
            crate::remote::association_guard(&manager.state, preview)?;
        }
        if history_changed
            && (manager.management_undo != base.undo || manager.management_redo != base.redo)
        {
            return Err("管理操作记录已变化，请重新读取后撤销或重做".into());
        }
        // A check can save discoveries and refreshed records before its final
        // summary. At this point, only the summary may differ from the base of
        // the most recent successful save. Keep every other live field in place.
        if summary_only && valid_summary_merge_state(&manager.state) {
            let summary = &worker.state.check_summary;
            if base.state.check_summary == *summary {
                return Ok(());
            }
            if manager.state.check_summary != *summary {
                let previous = std::mem::replace(&mut manager.state.check_summary, summary.clone());
                if let Err(error) = manager.save() {
                    manager.state.check_summary = previous;
                    return Err(error);
                }
            }
            base.state.check_summary.clone_from(summary);
            return Ok(());
        }
        let merged = if history_changed
            && matches!(self.action.as_str(), "undo_management" | "redo_management")
        {
            let redo = self.action == "redo_management";
            let entry = if redo {
                base.redo.last()
            } else {
                base.undo.last()
            }
            .ok_or("管理操作记录已变化，请重新读取")?;
            // Recheck the same local delta against live fields while holding the
            // writer lock, including members discovered after the worker began.
            crate::categories::replay_state(&manager.state, entry, redo)?
        } else {
            merge_state(&base.state, &worker.state, &manager.state, &self.action)?
        };
        if matches!(self.action.as_str(), "forget" | "relocate_local") {
            manager.ensure_request_allowed(&self.request)?;
        }
        crate::local::validate_local_record_commit(
            &manager,
            &manager.state,
            &merged,
            &self.action,
        )?;
        if merged == manager.state && !history_changed {
            base.state = worker.state.clone();
            return Ok(());
        }
        let previous = std::mem::replace(&mut manager.state, merged);
        let previous_history = history_changed.then(|| {
            (
                std::mem::replace(&mut manager.management_undo, worker.management_undo.clone()),
                std::mem::replace(&mut manager.management_redo, worker.management_redo.clone()),
            )
        });
        if let Err(error) = manager.save() {
            manager.state = previous;
            if let Some((undo, redo)) = previous_history {
                manager.management_undo = undo;
                manager.management_redo = redo;
            }
            return Err(error);
        }
        base.state = worker.state.clone();
        if history_changed {
            base.undo = worker.management_undo.clone();
            base.redo = worker.management_redo.clone();
        }
        Ok(())
    }
    fn snapshot(&self) -> Value {
        self.service
            .upgrade()
            .and_then(|service| service.snapshot().ok())
            .unwrap_or(Value::Null)
    }
}

fn automatic_check_action(action: &str) -> bool {
    matches!(
        action,
        "check_now"
            | "discover_local"
            | "get_external_dependencies"
            | "batch_external_dependencies"
    )
}

#[cfg(test)]
#[path = "tasks/resource_checks_tests.rs"]
mod resource_checks_tests;

#[cfg(test)]
#[path = "tasks/resource_automation_tests.rs"]
mod resource_automation_tests;

fn ensure_task_allowed(
    manager: &Manager,
    request: &Value,
    internal_resource_automation: bool,
) -> Result<(), String> {
    if internal_resource_automation && request["action"] == "__resource_automation_finish" {
        if manager.basic_mode {
            return Err("基本模式不保存自动更新结果".into());
        }
        // Recording actual results must remain possible after a maintenance pause.
        return Ok(());
    }
    manager.ensure_request_allowed(request)
}

fn validate_task_automatic(
    state: &State,
    request: &Value,
    internal_resource_automation: bool,
) -> Result<(), String> {
    if internal_resource_automation {
        if request["action"] == "__resource_automation_finish" {
            return Ok(());
        }
        return crate::maintenance::ensure_automatic_allowed(&state.settings);
    }
    validate_automatic_configuration(state, request)
}

pub(crate) fn validate_automatic_configuration(
    state: &State,
    request: &Value,
) -> Result<(), String> {
    if request["action"] == "__resource_version_due" {
        return crate::maintenance::ensure_automatic_allowed(&state.settings);
    }
    if !(automatic_check_action(request["action"].as_str().unwrap_or_default())
        || request["action"] == "repair_client_connections")
        || (request["action"] == "batch_external_dependencies"
            && request["operation"] != "auto_match")
    {
        return Err("此操作尚未提供自动维护执行流程，请使用明确的手动入口".into());
    }
    crate::maintenance::ensure_automatic_allowed(&state.settings)?;
    if state.check_mode != "auto"
        || request["checkGeneration"].as_u64() != Some(state.check_generation)
    {
        return Err("自动检查设置已改变，本次旧检查已停止".into());
    }
    Ok(())
}

fn validate_observations(before: &State, after: &State, action: &str) -> Result<(), String> {
    if !matches!(
        action,
        "refresh"
            | "audit_skills"
            | "check_now"
            | "discover_local"
            | "auto_associate"
            | "get_files"
            | "get_export_plan"
    ) {
        return Ok(());
    }
    for skill in &after.skills {
        let Some(prior) = before
            .skills
            .iter()
            .find(|prior| prior["id"] == skill["id"])
        else {
            continue;
        };
        let audit_changed = prior["runtimeAudit"] != skill["runtimeAudit"]
            && skill["runtimeAudit"]["scopeHashes"].is_object();
        let hashes_changed = prior["lastLocalCheckedAt"] != skill["lastLocalCheckedAt"]
            && skill["localHashes"].is_object();
        if !audit_changed && !hashes_changed {
            continue;
        }
        let Some(path) = skill["localPath"].as_str() else {
            continue;
        };
        let current = crate::local::files(Path::new(path))?;
        if audit_changed {
            if skill["runtimeAudit"]["inventoryHashes"].is_object()
                && skill["runtimeAudit"]["inventoryHashes"] != json!(current)
            {
                return Err(
                    "本地文件在核对期间发生变化；本次过期核对结果未保存，请重新检查".into(),
                );
            }
            let scope = &skill["runtimeAudit"]["scopeHashes"];
            if scope
                .as_object()
                .expect("hash object")
                .iter()
                .any(|(path, hash)| current.get(path).map(String::as_str) != hash.as_str())
            {
                return Err(
                    "本地文件在核对期间发生变化；本次过期核对结果未保存，请重新检查".into(),
                );
            }
        }
        if hashes_changed
            && skill["localHashes"]
                .as_object()
                .expect("hash object")
                .iter()
                .any(|(path, hash)| current.get(path).map(String::as_str) != hash.as_str())
        {
            return Err(
                "本地文件在远端检查期间发生变化；本次过期比较结果未保存，请重新检查".into(),
            );
        }
    }
    Ok(())
}

impl WorkerHook {
    fn publish_ephemeral(&self, worker: &Manager) -> Result<(), String> {
        let service = self
            .service
            .upgrade()
            .ok_or("Task service is unavailable")?;
        let base = self
            .base
            .as_ref()
            .ok_or("说明读取不能发布预览")?
            .lock()
            .map_err(|_| "Task merge lock failed")?;
        let mut manager = service
            .manager
            .lock()
            .map_err(|_| "Manager state lock failed")?;
        if worker.management_undo != base.undo || worker.management_redo != base.redo {
            return Err("管理操作记录尚未随状态保存".into());
        }
        if let Some(id) = self.request["previewId"]
            .as_str()
            .or_else(|| self.request["planId"].as_str())
        {
            if base.previews.contains_key(id) && !worker.previews.contains_key(id) {
                manager.previews.remove(id);
            }
        }
        for (id, preview) in &worker.previews {
            if base.previews.get(id) != Some(preview) {
                if manager.previews.get(id).is_some_and(|current| {
                    Some(current) != base.previews.get(id) && current != preview
                }) {
                    return Err("预览已变化，请重新生成".into());
                }
                manager.previews.insert(id.clone(), preview.clone());
            }
        }
        crate::export_plan::trim_previews(&mut manager.previews);
        crate::resource_lifecycle::trim_previews(&mut manager.previews);
        let relocation_preview = (self.action == "preview_relocate_local")
            .then(|| {
                worker.previews.iter().find_map(|(id, preview)| {
                    (preview["kind"] == "localRelocation" && !base.previews.contains_key(id))
                        .then(|| id.clone())
                })
            })
            .flatten();
        crate::local::trim_relocation_previews(
            &mut manager.previews,
            relocation_preview.as_deref(),
        );
        let resource_relocation = (self.action == "preview_resource_relocate")
            .then(|| {
                worker.previews.iter().find_map(|(id, p)| {
                    (p["kind"] == "resourceRelocation" && !base.previews.contains_key(id))
                        .then(|| id.clone())
                })
            })
            .flatten();
        crate::resource_relocation::trim_previews(
            &mut manager.previews,
            resource_relocation.as_deref(),
        );
        Ok(())
    }
}

fn same_state_except_check_summary(before: &State, after: &State) -> bool {
    let State {
        skills,
        sources,
        connections,
        settings,
        local_roots,
        ignored_local_paths,
        check_mode,
        check_generation,
        check_summary: _,
    } = before;
    skills == &after.skills
        && sources == &after.sources
        && connections == &after.connections
        && settings == &after.settings
        && local_roots == &after.local_roots
        && ignored_local_paths == &after.ignored_local_paths
        && check_mode == &after.check_mode
        && *check_generation == after.check_generation
}

fn valid_summary_merge_state(state: &State) -> bool {
    // Older data can contain missing or duplicate IDs. Use the general merge
    // for those records so its existing conflict checks still apply.
    state.settings.is_object()
        && [
            &state.skills,
            &state.sources,
            &state.connections,
            &state.local_roots,
        ]
        .into_iter()
        .all(|records| {
            let mut ids = HashSet::with_capacity(records.len());
            records.iter().all(|record| {
                record["id"]
                    .as_str()
                    .is_some_and(|id| !id.is_empty() && ids.insert(id))
            })
        })
}

fn merge_state(
    before: &State,
    after: &State,
    current: &State,
    action: &str,
) -> Result<State, String> {
    let skills = merge_records(
        &before.skills,
        &after.skills,
        &current.skills,
        "Skill",
        action,
    )?;
    let sources = merge_records(
        &before.sources,
        &after.sources,
        &current.sources,
        "来源",
        action,
    )?;
    let connections = merge_records(
        &before.connections,
        &after.connections,
        &current.connections,
        "客户端连接",
        action,
    )?;
    let mut settings = current.settings.clone();
    merge_object_into(
        &before.settings,
        &after.settings,
        &mut settings,
        "设置",
        &["ignoredClientConnections"],
    )?;
    let mut merged = State {
        skills,
        sources,
        connections,
        settings,
        local_roots: merge_records(
            &before.local_roots,
            &after.local_roots,
            &current.local_roots,
            "本地目录",
            action,
        )?,
        ignored_local_paths: current.ignored_local_paths.clone(),
        check_mode: current.check_mode.clone(),
        check_generation: current.check_generation,
        check_summary: current.check_summary.clone(),
    };
    if before.ignored_local_paths != after.ignored_local_paths {
        merged.ignored_local_paths.retain(|path| {
            !before.ignored_local_paths.contains(path) || after.ignored_local_paths.contains(path)
        });
        for path in after
            .ignored_local_paths
            .iter()
            .filter(|path| !before.ignored_local_paths.contains(path))
        {
            if !merged.ignored_local_paths.contains(path) {
                merged.ignored_local_paths.push(path.clone());
            }
        }
    }
    if before.check_mode != after.check_mode {
        if current.check_mode != before.check_mode && current.check_mode != after.check_mode {
            return Err("检查模式已改变，请重试".into());
        }
        merged.check_mode = after.check_mode.clone();
    }
    if before.check_generation != after.check_generation {
        merged.check_generation = current.check_generation + 1;
    }
    if before.check_summary != after.check_summary {
        merged.check_summary = after.check_summary.clone();
    }
    if before.settings.get("ignoredClientConnections")
        != after.settings.get("ignoredClientConnections")
    {
        let old = before.settings["ignoredClientConnections"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let next = after.settings["ignoredClientConnections"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut live = current.settings["ignoredClientConnections"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        live.retain(|entry| !old.contains(entry) || next.contains(entry));
        for entry in next.iter().filter(|entry| !old.contains(entry)) {
            if !live.contains(entry) {
                live.push(entry.clone());
            }
        }
        merged.settings["ignoredClientConnections"] = json!(live);
    }
    Ok(merged)
}

fn merge_records(
    before: &[Value],
    after: &[Value],
    current: &[Value],
    kind: &str,
    action: &str,
) -> Result<Vec<Value>, String> {
    let mut merged = current.to_vec();
    for prior in before {
        let id = &prior["id"];
        let next = after.iter().find(|item| item["id"] == *id);
        let live = merged.iter().position(|item| item["id"] == *id);
        match (next, live) {
            (None, Some(index)) => {
                if merged[index] != *prior {
                    return Err(format!("{kind}记录在任务运行期间发生变化，请重新操作"));
                }
                merged.remove(index);
            }
            (Some(next), Some(index)) if next != prior => {
                if kind == "Skill" && !management_task(action) {
                    for field in [
                        "localPath",
                        "sourceId",
                        "repo",
                        "branch",
                        "remotePath",
                        "runtimeFiles",
                        "externalBindings",
                        "installedCommit",
                        "baselineCommit",
                    ] {
                        if merged[index].get(field) != prior.get(field)
                            && next.get(field) != merged[index].get(field)
                        {
                            return Err(format!(
                                "{kind}的{field}在任务运行期间发生变化，本次过期结果未写入"
                            ));
                        }
                    }
                }
                let protected = if kind == "Skill"
                    && matches!(
                        action,
                        "refresh" | "audit_skills" | "check_now" | "auto_associate" | "add_github"
                    ) {
                    &["categoryId", "favorite", "externalBindings"][..]
                } else {
                    &[]
                };
                if kind == "Skill" && matches!(action, "get_files" | "get_export_plan") {
                    let mut prior = prior.clone();
                    let mut next = next.clone();
                    let live = &merged[index];
                    if same_runtime_audit_proof(&next["runtimeAudit"], &live["runtimeAudit"]) {
                        next["runtimeAudit"] = live["runtimeAudit"].clone();
                    } else if same_runtime_audit_proof(
                        &prior["runtimeAudit"],
                        &live["runtimeAudit"],
                    ) {
                        prior["runtimeAudit"] = live["runtimeAudit"].clone();
                    }
                    merge_object_into(&prior, &next, &mut merged[index], kind, protected)?;
                } else {
                    merge_object_into(prior, next, &mut merged[index], kind, protected)?;
                }
            }
            (Some(next), None) if next != prior => {
                return Err(format!("{kind}记录已被移除，本次结果未写入"))
            }
            _ => {}
        }
    }
    for item in after
        .iter()
        .filter(|item| !before.iter().any(|prior| prior["id"] == item["id"]))
    {
        if kind == "Skill"
            && item["localPath"].as_str().is_some_and(|path| {
                let key = path_key(path);
                merged.iter().any(|live| {
                    live["id"] != item["id"]
                        && live["localPath"]
                            .as_str()
                            .is_some_and(|path| path_key(path) == key)
                })
            })
        {
            return Err("相同实际目录已登记，本次过期发现结果未写入".into());
        }
        if let Some(live) = merged.iter().find(|live| live["id"] == item["id"]) {
            if live != item {
                return Err(format!("{kind}记录已存在，请刷新后操作"));
            }
        } else {
            merged.push(item.clone());
        }
    }
    Ok(merged)
}

fn same_runtime_audit_proof(left: &Value, right: &Value) -> bool {
    fn proof(value: &Value) -> Option<Value> {
        if value["method"] != "static_package" {
            return None;
        }
        let mut value = value.clone();
        let record = value.as_object_mut()?;
        record.remove("checkedAt");
        record.remove("invalidatedAt");
        if let Some(dependencies) = record
            .get_mut("externalDependencies")
            .and_then(Value::as_array_mut)
        {
            for dependency in dependencies {
                if let Some(record) = dependency.as_object_mut() {
                    record.remove("checkedAt");
                    for source in ["local", "remote"] {
                        if let Some(evidence) =
                            record.get_mut(source).and_then(Value::as_object_mut)
                        {
                            evidence.remove("checkedAt");
                        }
                    }
                }
            }
        }
        Some(value)
    }
    match (proof(left), proof(right)) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

// The output is a private copy of the live value, discarded by the caller on failure.
fn merge_object_into(
    before: &Value,
    after: &Value,
    output: &mut Value,
    kind: &str,
    protected: &[&str],
) -> Result<(), String> {
    let (Some(prior), Some(next), Some(live)) = (
        before.as_object(),
        after.as_object(),
        output.as_object_mut(),
    ) else {
        return if *output == *before || *output == *after {
            *output = after.clone();
            Ok(())
        } else {
            Err(format!("{kind}在任务运行期间已变化"))
        };
    };
    let keys: BTreeSet<_> = prior.keys().chain(next.keys()).collect();
    for key in keys {
        if protected.contains(&key.as_str()) || prior.get(key) == next.get(key) {
            continue;
        }
        if live.get(key) != prior.get(key) && live.get(key) != next.get(key) {
            return Err(format!("{kind}的{key}已变化，本次过期结果未写入"));
        }
        match next.get(key) {
            Some(value) => {
                live.insert(key.clone(), value.clone());
            }
            None => {
                live.remove(key);
            }
        }
    }
    Ok(())
}

fn rebase_result(
    value: &mut Value,
    snapshot: impl FnOnce() -> Result<Value, String>,
) -> Result<(), String> {
    let top_level = value["skills"].is_array()
        && value["sources"].is_array()
        && value["connections"].is_array();
    let nested = ["stateSnapshot", "snapshot"]
        .iter()
        .any(|field| value[*field]["skills"].is_array());
    // Plain document/file results do not contain manager state to refresh.
    if !top_level && !nested {
        return Ok(());
    }
    let mut current = snapshot()?;
    if top_level {
        for field in [
            "skills",
            "sources",
            "connections",
            "settings",
            "localRoots",
            "ignoredLocalPaths",
            "checkMode",
            "checkGeneration",
            "dataDir",
            "storage",
            "managementUndo",
            "managementRedo",
            "maintenance",
            "sceneRevision",
            "activeSceneId",
            "sceneError",
            "stateRevision",
            "managementRevision",
            "readGeneration",
        ] {
            value[field] = if nested {
                current[field].clone()
            } else {
                // Without a nested consumer, transfer the live values directly.
                current
                    .as_object_mut()
                    .and_then(|fields| fields.remove(field))
                    .unwrap_or(Value::Null)
            };
        }
    }
    for field in ["stateSnapshot", "snapshot"] {
        if value[field]["skills"].is_array() {
            value[field] = current.clone();
        }
    }
    Ok(())
}

fn read_task(action: &str) -> bool {
    action.starts_with("preview_")
        || action == "__resource_automation_scan"
        || matches!(
            action,
            "refresh"
                | "get_content_cache_stats"
                | "management_data"
                | "resource_list"
                | "resource_templates"
                | "resource_relations"
                | "resource_scenes"
                | "resource_source"
                | "resource_source_health"
                | "skill_source_health"
                | "resource_template_prepare"
                | "resource_capabilities"
                | "resource_runtime"
                | "resource_idle"
                | "resource_space"
                | "resource_result"
                | "resource_package_inspect"
                | "resource_package_sessions"
                | "resource_github_releases"
                | "resource_downloads"
                | "resource_update_state"
                | "resource_version_check_status"
                | "resource_automation_status"
                | "resource_capability_evidence"
                | "open_system_apps"
                | "__resource_version_due"
                | "check_now"
                | "discover_local"
                | "audit_skills"
                | "refresh_clients"
                | "get_document"
                | "get_doc_asset"
                | "get_files"
                | "get_export_plan"
                | "read_file"
                | "get_skill_info"
                | "scan_local"
                | "get_cleanup_receipts"
                | "get_external_dependencies"
                | "check_external_dependencies"
                | "test_network"
                | "get_network_settings"
                | "storage_get"
                | "storage_stats"
                | "storage_preview"
                | "storage_open_path"
                | "storage_resolve_default_path"
        )
}
pub(crate) fn read_request(request: &Value) -> bool {
    read_task(request["action"].as_str().unwrap_or_default())
        || (request["action"] == "batch_external_dependencies" && request["operation"] == "recheck")
}
fn management_task(action: &str) -> bool {
    matches!(
        action,
        "create_category"
            | "rename_category"
            | "delete_category"
            | "reorder_categories"
            | "set_category_color"
            | "assign_category"
            | "restore_category_assignments"
            | "set_favorite"
            | "undo_management"
            | "redo_management"
    )
}

fn resources_for(manager: &Manager, request: &Value) -> Result<Vec<Resource>, String> {
    let action = text(request, "action")?;
    let preview = request["previewId"]
        .as_str()
        .or_else(|| request["planId"].as_str())
        .and_then(|id| manager.previews.get(id));
    let skill_id = if action == "relocate_local" {
        preview.and_then(|p| {
            p["original"]["id"]
                .as_str()
                .or_else(|| p["public"]["skillId"].as_str())
        })
    } else {
        request["skillId"].as_str().or_else(|| {
            preview.and_then(|p| {
                p["public"]["skillId"]
                    .as_str()
                    .or_else(|| p["skillId"].as_str())
            })
        })
    };
    let write = !read_request(request)
        && !action.starts_with("preview_")
        && !matches!(action, "open_local" | "open_folder" | "export");
    let management = management_task(action);
    let mut resources = BTreeMap::new();
    let mut add = |key: String, exclusive: bool| {
        resources
            .entry(key)
            .and_modify(|v| *v |= exclusive)
            .or_insert(exclusive);
    };
    if action == "__resource_version_due" {
        add("resource-version-checks".into(), true);
    }
    if action.starts_with("__resource_automation_") {
        add("resource-automation".into(), write);
        add("resource-catalog".into(), write);
    }
    // Import changes several management tables in one commit. Other jobs keep
    // their normal independent locks and share this gate; only import is exclusive.
    add(
        "configuration-import".into(),
        action == "apply_configuration_import",
    );
    if matches!(
        action,
        "management_data" | "skill_annotation_set" | "saved_view_save" | "saved_view_remove"
    ) {
        add("management-data".into(), write);
    }
    if matches!(
        action,
        "resource_scenes"
            | "resource_scene_save"
            | "resource_scene_remove"
            | "resource_scene_activate"
    ) {
        add("resource-scenes".into(), write);
    }
    if matches!(action, "connect" | "connect_batch") {
        add("resource-scenes".into(), false);
    }
    if action == "resource_invoke" {
        add(
            format!(
                "resource-execution:{}",
                request["id"].as_str().unwrap_or_default()
            ),
            true,
        );
    } else if !matches!(
        action,
        "resource_stop"
            | "resource_idle"
            | "resource_keep_alive"
            | "resource_usage_begin"
            | "resource_usage_end"
            | "resource_runtime"
            | "resource_result"
            | "resource_github_releases"
            | "resource_downloads"
    ) && action.starts_with("resource_")
    {
        add("resource-catalog".into(), write);
    }
    if matches!(
        action,
        "resource_templates"
            | "resource_template_save"
            | "resource_template_remove"
            | "resource_template_prepare"
    ) {
        add(
            format!(
                "resource-execution:{}",
                request["id"].as_str().unwrap_or_default()
            ),
            write,
        );
    }
    if matches!(
        action,
        "preview_resource_relocate" | "apply_resource_relocate"
    ) {
        add("resource-catalog".into(), write);
        if let Some(id) = request["id"]
            .as_str()
            .or_else(|| preview.and_then(|p| p["resourceId"].as_str()))
        {
            add(format!("resource-execution:{id}"), write);
            let record = manager.resource_store(crate::resources::StoreRequest::Get(id.into()))?;
            if let Some(path) = record["rootPath"].as_str() {
                add(format!("directory:{}", path_key(path)), write);
            }
        }
        if let Some(path) = request["rootPath"]
            .as_str()
            .or_else(|| preview.and_then(|p| p["targetPath"].as_str()))
        {
            add(format!("directory:{}", path_key(path)), write);
        }
    }
    if matches!(
        action,
        "preview_resource_adapter" | "apply_resource_adapter"
    ) {
        add("resource-catalog".into(), write);
        if let Some(path) = request["rootPath"]
            .as_str()
            .or_else(|| preview.and_then(|p| p["inspection"]["rootPath"].as_str()))
        {
            add(format!("directory:{}", path_key(path)), false);
        }
    }
    if matches!(
        action,
        "preview_resource_automation" | "apply_resource_automation"
    ) {
        add("resource-catalog".into(), write);
        add("resource-automation".into(), write);
        if let Some(id) = request["resourceId"]
            .as_str()
            .or_else(|| preview.and_then(|p| p["resourceId"].as_str()))
        {
            add(format!("resource-execution:{id}"), write);
            let record = manager.resource_store(crate::resources::StoreRequest::Get(id.into()))?;
            if let Some(path) = record["rootPath"].as_str() {
                add(format!("directory:{}", path_key(path)), write);
            }
        }
    }
    if matches!(
        action,
        "preview_resource_install"
            | "preview_resource_remove"
            | "preview_resource_repair"
            | "apply_resource_install"
            | "apply_resource_remove"
            | "apply_resource_repair"
            | "preview_resource_update"
            | "preview_resource_update_switch"
            | "apply_resource_update_stage"
            | "apply_resource_update_switch"
            | "preview_resource_update_abandon"
            | "apply_resource_update_abandon"
            | "verify_resource_update"
    ) {
        add("resource-catalog".into(), write);
        let requested_archive = request["archivePath"]
            .as_str()
            .map(str::trim)
            .filter(|path| !path.is_empty());
        let repair_archive = if action == "preview_resource_repair" && requested_archive.is_none() {
            let record = manager.resource_store(crate::resources::StoreRequest::Get(
                text(request, "id")?.to_owned(),
            ))?;
            record["installation"]["archivePath"]
                .as_str()
                .map(str::to_owned)
        } else {
            None
        };
        if let Some(path) = requested_archive
            .or_else(|| preview.and_then(|p| p["archivePath"].as_str()))
            .or(repair_archive.as_deref())
        {
            add(format!("archive:{}", path_key(path)), false);
        }
        if action == "preview_resource_repair" {
            for path in crate::resource_lifecycle::repair_source_paths(manager, request)? {
                add(
                    format!("archive:{}", path_key(&path.to_string_lossy())),
                    false,
                );
            }
        } else if action == "apply_resource_repair" {
            if let Some(paths) = preview.and_then(|p| p["sourcePaths"].as_array()) {
                for path in paths.iter().filter_map(Value::as_str) {
                    add(format!("archive:{}", path_key(path)), false);
                }
            }
        }
        if let Some(path) = request["destinationPath"]
            .as_str()
            .or_else(|| preview.and_then(|p| p["targetPath"].as_str()))
        {
            add(format!("directory:{}", path_key(path)), write);
        }
        if let Some(paths) = preview.and_then(|p| p["targetPaths"].as_array()) {
            for path in paths.iter().filter_map(Value::as_str) {
                add(format!("directory:{}", path_key(path)), write);
            }
        }
        if let Some(id) = request["id"]
            .as_str()
            .or_else(|| preview.and_then(|p| p["resourceId"].as_str()))
        {
            add(format!("resource-execution:{id}"), write);
            if action.contains("resource_update") {
                let current =
                    manager.resource_store(crate::resources::StoreRequest::Get(id.into()))?;
                if let Some(path) = current["rootPath"].as_str() {
                    add(format!("directory:{}", path_key(path)), write);
                }
            }
        }
    }
    if matches!(action, "preview_skill_remove" | "apply_skill_remove") {
        add("resource-catalog".into(), false);
        add("resource-relations".into(), false);
        add("local:discovery".into(), false);
        add("sources:discovery".into(), false);
        for skill in &manager.state.skills {
            if let Some(id) = skill["id"].as_str() {
                add(format!("skill:{id}"), false);
            }
        }
        for connection in manager
            .state
            .connections
            .iter()
            .filter(|c| c["skillId"].as_str() == skill_id)
        {
            if let Some(client) = connection["client"].as_str() {
                add(format!("client:{client}"), write);
            }
            if let Some(path) = connection["path"].as_str() {
                add(format!("entry:{}", path_key(path)), write);
            }
        }
    }
    if matches!(
        action,
        "forget" | "preview_relocate_local" | "relocate_local"
    ) {
        add("local:discovery".into(), write);
        add("sources:discovery".into(), write);
        add("resource-catalog".into(), false);
        add("resource-relations".into(), false);
        add("resource-scenes".into(), false);
        add("management-data".into(), false);
        // Forget changes client registration/ignore records. Refresh may discover
        // an entry that had no connection record when these locks were planned.
        if action == "forget" {
            for client in ["codex", "claude", "cursor"] {
                add(format!("client:{client}"), true);
            }
        }
        if let Some(path) = if action == "preview_relocate_local" {
            request["path"].as_str()
        } else {
            preview.and_then(|p| {
                p["draft"]["localPath"]
                    .as_str()
                    .or_else(|| p["public"]["path"].as_str())
            })
        } {
            add(format!("directory:{}", path_key(path)), write);
        }
        let duplicate = preview.and_then(|p| {
            p["duplicate"]["id"]
                .as_str()
                .or_else(|| p["public"]["duplicateId"].as_str())
        });
        if let Some(id) = duplicate {
            add(format!("skill:{id}"), write);
            if let Ok(skill) = manager.skill(id) {
                if let Some(path) = skill["localPath"].as_str() {
                    add(format!("directory:{}", path_key(path)), write);
                }
            }
        }
        for connection in &manager.state.connections {
            if connection["skillId"].as_str() == skill_id
                || duplicate.is_some_and(|id| connection["skillId"] == id)
            {
                if let Some(client) = connection["client"].as_str() {
                    add(format!("client:{client}"), write);
                }
                if let Some(path) = connection["path"].as_str() {
                    add(format!("entry:{}", path_key(path)), write);
                }
            }
        }
    }
    if action == "resource_package_inspect" {
        if let Some(path) = request["archivePath"].as_str() {
            add(format!("archive:{}", path_key(path)), false);
        }
    }
    if action == "resource_package_sessions" || action.contains("_resource_package_") {
        // Long dependency resolution and transfers own their session and exact
        // destinations. Catalogue admission is rechecked at each phase and CAS;
        // only registering the resulting runtime needs its exclusive lock.
        if matches!(
            action,
            "preview_resource_package_commit" | "apply_resource_package_commit"
        ) {
            add("resource-catalog".into(), write);
        }
        add("resource-relations".into(), false);
        let session_id = request["sessionId"]
            .as_str()
            .or_else(|| preview.and_then(|p| p["prepared"]["sessionId"].as_str()));
        let session = session_id
            .map(|id| {
                manager
                    .resource_package_store(crate::resource_package::StoreRequest::Get(id.into()))
            })
            .transpose()?;
        let runtime = session
            .as_ref()
            .map(|value| &value["input"]["runtime"])
            .or_else(|| preview.map(|value| &value["prepared"]["runtime"]));
        let mut runtime_paths = Vec::new();
        if let Some(path) = request["runtimePath"].as_str() {
            runtime_paths.push(path);
        }
        if let Some(paths) = preview.and_then(|value| value["public"]["runtimePaths"].as_array()) {
            runtime_paths.extend(paths.iter().filter_map(Value::as_str));
        }
        if let Some(runtime) = runtime {
            if let Some(path) = runtime["binding"]["path"].as_str() {
                runtime_paths.push(path);
            }
            for field in ["interpreter", "pythonLicense"] {
                if let Some(path) = runtime["binding"][field]["path"]
                    .as_str()
                    .or_else(|| runtime["binding"][field].as_str())
                {
                    runtime_paths.push(path);
                }
            }
            if let Some(path) = runtime["binding"]["sitePackages"].as_str() {
                add(format!("directory:{}", path_key(path)), false);
            }
        }
        for path in runtime_paths {
            add(format!("archive:{}", path_key(path)), false);
            add(format!("directory:{}", path_key(path)), false);
            if let Some(parent) = Path::new(path).parent().and_then(Path::to_str) {
                add(format!("directory:{}", path_key(parent)), false);
            }
        }
        if let Some(id) = session_id {
            add(format!("package-session:{id}"), write);
        }
        for (request_key, input_key, public_key) in [
            ("workDirectory", "work", "workingDirectory"),
            ("downloadDirectory", "downloads", "downloadDirectory"),
            ("destinationPath", "destination", "targetPath"),
        ] {
            if let Some(path) = request[request_key]
                .as_str()
                .or_else(|| preview.and_then(|p| p["public"][public_key].as_str()))
                .or_else(|| {
                    session
                        .as_ref()
                        .and_then(|s| s["input"][input_key].as_str())
                })
            {
                add(format!("directory:{}", path_key(path)), write);
            }
        }
        if let Some(path) = request["archivePath"]
            .as_str()
            .or_else(|| preview.and_then(|p| p["archivePath"].as_str()))
        {
            add(format!("archive:{}", path_key(path)), false);
        }
        if let Some(id) = request["resourceId"]
            .as_str()
            .or_else(|| preview.and_then(|p| p["resourceId"].as_str()))
            .or_else(|| {
                session
                    .as_ref()
                    .and_then(|s| s["input"]["binding"]["record"]["id"].as_str())
            })
        {
            let commit = action == "apply_resource_package_commit";
            if commit {
                add(format!("resource-execution:{id}"), true);
            }
            let current = manager.resource_store(crate::resources::StoreRequest::Get(id.into()))?;
            if let Some(path) = current["rootPath"].as_str() {
                add(format!("directory:{}", path_key(path)), commit);
            }
        }
    }
    if action == "apply_resource_download" {
        // Download cancellation does not make it a reader. Both publication and
        // resumption own their exact paths, including against ZIP inspection.
        for field in ["targetPath", "partialPath"] {
            if let Some(path) = preview.and_then(|p| p[field].as_str()) {
                add(format!("archive:{}", path_key(path)), true);
            }
        }
    }
    if management {
        add("management".into(), true);
    }
    if matches!(action, "preview_resource_source" | "apply_resource_source") {
        add("resource-catalog".into(), write);
        if let Some(id) = request["id"]
            .as_str()
            .or_else(|| preview.and_then(|p| p["resourceId"].as_str()))
        {
            add(format!("resource-execution:{id}"), write);
        }
    }
    if matches!(action, "preview_associate" | "apply_associate") {
        add("sources:discovery".into(), write);
        if let Some(placeholders) = preview.and_then(|p| p["placeholders"].as_array()) {
            for record in placeholders {
                if let Some(id) = record["id"].as_str() {
                    add(format!("skill:{id}"), write);
                }
            }
        }
    }
    if action == "set_settings" {
        add("settings:display".into(), true);
    }
    if action == "set_maintenance" {
        add("settings:maintenance".into(), true);
    }
    if matches!(
        action,
        "set_check_mode"
            | "add_local_roots"
            | "update_local_root"
            | "remove_local_roots"
            | "restore_local_ignores"
            | "forget"
            | "relocate_local"
    ) {
        add("settings:checking".into(), true);
    }
    if action == "check_now" {
        add("sources:discovery".into(), true);
    }
    if matches!(action, "discover_local" | "add_local" | "add_local_roots") {
        add("local:discovery".into(), true);
    }
    if action == "set_network_settings" {
        add("settings:network".into(), true);
    }
    if action.starts_with("storage_") {
        add(
            "settings:storage".into(),
            matches!(action, "storage_apply_defaults" | "storage_default_path"),
        );
    }
    if matches!(action, "set_token" | "delete_token") {
        add(
            format!(
                "credential:{}",
                request["repo"].as_str().unwrap_or_default().to_lowercase()
            ),
            true,
        );
    }
    if action == "scan_local" {
        if let Some(path) = request["path"].as_str() {
            add(format!("directory:{}", path_key(path)), false);
        }
    }
    if action == "add_local" {
        if let Some(paths) = request["paths"].as_array() {
            for path in paths.iter().filter_map(Value::as_str) {
                add(format!("directory:{}", path_key(path)), true);
            }
        }
    }
    if matches!(
        action,
        "add_github" | "auto_associate" | "add_local" | "add_local_roots"
    ) {
        add("sources:discovery".into(), true);
    }
    let selected: Vec<_> = if matches!(action, "refresh" | "audit_skills" | "check_now") {
        let ids = manager.refresh_selection(request)?;
        manager
            .state
            .skills
            .iter()
            .filter(|skill| {
                ids.as_ref()
                    .is_none_or(|set| skill["id"].as_str().is_some_and(|id| set.contains(id)))
            })
            .collect()
    } else if action == "connect_batch" {
        manager
            .state
            .skills
            .iter()
            .filter(|skill| {
                request["skillIds"]
                    .as_array()
                    .is_some_and(|ids| ids.iter().any(|id| *id == skill["id"]))
            })
            .collect()
    } else {
        skill_id
            .and_then(|id| manager.state.skills.iter().find(|skill| skill["id"] == id))
            .into_iter()
            .collect()
    };
    if !management {
        for skill in &selected {
            add(
                format!("skill:{}", skill["id"].as_str().unwrap_or_default()),
                write,
            );
            if let Some(path) = skill["localPath"].as_str() {
                add(format!("directory:{}", path_key(path)), write);
            }
        }
    }
    if let Some(path) = preview.and_then(|p| p["targetPath"].as_str()) {
        if action.starts_with("apply_") && !matches!(action, "apply_push" | "apply_upload") {
            add(format!("directory:{}", path_key(path)), true);
        }
    }
    if matches!(action, "apply_install" | "apply_update") {
        if let Some(path) = preview.and_then(|p| p["backupPlan"]["recoveryRoot"].as_str()) {
            add(format!("directory:{}", path_key(path)), true);
        }
    }
    if let Some(id) = request["previewId"].as_str() {
        add(format!("preview:{id}"), true);
    }
    if matches!(action, "apply_push" | "apply_upload") {
        let repo = preview
            .and_then(|p| p["repo"].as_str())
            .or_else(|| selected.first().and_then(|s| s["repo"].as_str()))
            .unwrap_or_default();
        let branch = preview
            .and_then(|p| p["branch"].as_str())
            .or_else(|| selected.first().and_then(|s| s["branch"].as_str()))
            .unwrap_or("main");
        add(format!("branch:{}:{branch}", repo.to_lowercase()), true);
    }
    let connection = request["connectionId"]
        .as_str()
        .and_then(|id| manager.state.connections.iter().find(|c| c["id"] == id))
        .or_else(|| {
            preview
                .and_then(|p| p["connectionId"].as_str())
                .and_then(|id| manager.state.connections.iter().find(|c| c["id"] == id))
        });
    if matches!(
        action,
        "connect"
            | "connect_batch"
            | "disconnect"
            | "remove_connection_record"
            | "preview_disconnect"
            | "apply_disconnect"
            | "refresh_clients"
            | "repair_client_connections"
            | "confirm_client_usage"
            | "refresh"
            | "audit_skills"
    ) {
        if let Some(client) = request["client"]
            .as_str()
            .or_else(|| connection.and_then(|c| c["client"].as_str()))
        {
            add(format!("client:{client}"), write);
        } else {
            for client in ["codex", "claude", "cursor"] {
                add(format!("client:{client}"), write);
            }
        }
        if let Some(path) = request["targetPath"].as_str() {
            add(format!("entry:{}", path_key(path)), write);
        }
        if let Some(paths) = request["targetPaths"].as_object() {
            for path in paths.values().filter_map(Value::as_str) {
                add(format!("entry:{}", path_key(path)), write);
            }
        }
        if let Some(path) = connection.and_then(|connection| connection["path"].as_str()) {
            add(format!("entry:{}", path_key(path)), write);
        }
        // Batch previews and automatic repairs may cover several clients and source folders.
        // Lock each actual record, including source content used by a usage confirmation.
        let mut ids = BTreeSet::new();
        if let Some(id) = request["connectionId"].as_str() {
            ids.insert(id);
        }
        if let Some(items) = request["connectionIds"].as_array() {
            ids.extend(items.iter().filter_map(Value::as_str));
        }
        if let Some(entries) = preview.and_then(|value| value["entries"].as_array()) {
            ids.extend(
                entries
                    .iter()
                    .filter_map(|entry| entry["connectionId"].as_str()),
            );
        }
        for record in &manager.state.connections {
            if !ids.contains(record["id"].as_str().unwrap_or_default())
                && !(matches!(action, "refresh" | "audit_skills" | "refresh_clients")
                    || action == "repair_client_connections" && ids.is_empty())
            {
                continue;
            }
            if let Some(client) = record["client"].as_str() {
                add(format!("client:{client}"), write);
            }
            if let Some(path) = record["path"].as_str() {
                add(format!("entry:{}", path_key(path)), write);
            }
            if let Some(id) = record["skillId"].as_str() {
                add(format!("skill:{id}"), write);
                if let Ok(skill) = manager.skill(id) {
                    if let Some(path) = skill["localPath"].as_str() {
                        add(format!("directory:{}", path_key(path)), write);
                    }
                }
            }
        }
    }
    if action == "export" {
        if let Some(path) = request["destination"].as_str() {
            add(format!("destination:{}", path_key(path)), true);
        }
    }
    Ok(resources
        .into_iter()
        .map(|(key, write)| Resource { key, write })
        .collect())
}

fn path_key(path: &str) -> String {
    let path =
        crate::local::canonical(Path::new(path)).unwrap_or_else(|_| Path::new(path).to_path_buf());
    let value = path.to_string_lossy().replace('/', "\\");
    if cfg!(windows) {
        value
            .strip_prefix(r"\\?\UNC\")
            .map(|rest| format!(r"\\{rest}"))
            .or_else(|| value.strip_prefix(r"\\?\").map(str::to_owned))
            .unwrap_or(value)
            .to_lowercase()
    } else {
        value
    }
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("Missing {key}"))
}
fn clean_origin(origin: Option<&Value>, request: &Value) -> Value {
    let mut value = Map::new();
    for key in [
        "view",
        "skillId",
        "sourceId",
        "resourceId",
        "clientId",
        "tab",
        "resultKind",
        "paneId",
        "windowLabel",
    ] {
        if let Some(text) = origin.and_then(|o| o[key].as_str()) {
            value.insert(
                key.into(),
                json!(text.chars().take(512).collect::<String>()),
            );
        }
    }
    if !value.contains_key("skillId") {
        if let Some(id) = request["skillId"].as_str() {
            value.insert("skillId".into(), json!(id));
        }
    }
    if let Some(id) = request["automation"]["resourceId"].as_str() {
        value.entry("resourceId").or_insert_with(|| json!(id));
        value.entry("view").or_insert_with(|| json!("tools"));
    }
    Value::Object(value)
}
fn redact(text: &str, request: &Value) -> String {
    let mut value = text.to_owned();
    for field in ["token", "proxyUsername", "proxyPassword"] {
        if let Some(secret) = request[field].as_str().filter(|v| !v.is_empty()) {
            value = value.replace(secret, "[凭据已隐藏]");
        }
    }
    value.chars().take(4000).collect()
}
fn dedup_key(request: &Value) -> Option<String> {
    if request["action"] == "__resource_version_due" {
        return Some("tool-version-check-due".into());
    }
    let action = request["action"].as_str()?;
    if request.get("automation").is_some() || action.starts_with("__resource_automation_") {
        return Some(
            json!([
                "resource-automation",
                action,
                request["automation"],
                request["id"],
                request["previewId"]
            ])
            .to_string(),
        );
    }
    if action == "repair_client_connections" {
        let mut ids = request["connectionIds"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        ids.sort_by(|left, right| left.as_str().cmp(&right.as_str()));
        ids.dedup();
        return Some(
            json!([
                action,
                request["automatic"] == true,
                request["checkGeneration"],
                ids
            ])
            .to_string(),
        );
    }
    if !matches!(
        action,
        "refresh" | "audit_skills" | "refresh_clients" | "check_now" | "discover_local"
    ) {
        return None;
    }
    let mut ids = request["skillIds"].as_array().cloned().unwrap_or_default();
    if let Some(id) = request["skillId"].as_str() {
        ids.push(json!(id));
    }
    ids.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
    ids.dedup();
    Some(
        json!([
            action,
            request["localOnly"] == true,
            request["remoteOnly"] == true,
            request["automatic"] == true,
            request["checkGeneration"],
            request["rootIds"],
            request["changedPaths"],
            ids
        ])
        .to_string(),
    )
}
fn auto_match_dedup(manager: &Manager, request: &Value) -> Option<String> {
    if request["action"] != "batch_external_dependencies" || request["operation"] != "auto_match" {
        return None;
    }
    let skill = manager.skill(request["skillId"].as_str()?).ok()?;
    let commit = request["remoteCommit"].as_str()?.to_ascii_lowercase();
    if commit.len() != 40 || !commit.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let mut proof = Vec::new();
    for item in request["items"].as_array()? {
        proof.push((item["id"].as_str()?, item["expectedFingerprint"].as_str()?));
    }
    proof.sort_unstable();
    let length = proof.len();
    proof.dedup();
    if proof.len() != length {
        return None;
    }
    Some(
        json!([
            "external-auto-match",
            skill["id"],
            skill["sourceId"],
            skill["repo"].as_str().map(str::to_lowercase),
            skill["branch"],
            skill["remotePath"],
            skill["localPath"].as_str().map(path_key),
            commit,
            proof,
            request["includeRemote"] != false,
            skill["externalBindings"]
        ])
        .to_string(),
    )
}
fn partial(value: &Value) -> bool {
    value["transferResult"]["verificationError"]
        .as_str()
        .is_some()
        || value["transferResult"]["cleanup"]["recordError"]
            .as_str()
            .is_some()
        || value["transferResult"]["cleanup"]["retained"]
            .as_array()
            .is_some_and(|items| !items.is_empty())
        || value["auditSummary"]["failed"].as_u64().unwrap_or(0) > 0
        || value["auditSummary"]["needsReview"].as_u64().unwrap_or(0) > 0
        || value["failed"].as_u64().unwrap_or(0) > 0
        || ["needsSelection", "missing", "error"]
            .iter()
            .any(|key| value["autoMatchSummary"][key].as_u64().unwrap_or(0) > 0)
}
fn result_progress(value: &Value) -> Value {
    let total = value["auditSummary"]["checked"].as_u64();
    let total = total.or_else(|| {
        value["connectionResults"]
            .as_array()
            .map(|items| items.len() as u64)
    });
    total
        .map(|total| json!({"completed":total,"total":total}))
        .unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_check_tasks_read_one_catalog_snapshot_and_keep_the_full_result() {
        fn custom_dispatch(manager: &mut Manager, request: &Value) -> Result<Value, String> {
            let mut result = crate::dispatch(manager, request)?;
            assert!(result["skills"].is_array());
            result["customField"] = json!("preserved");
            Ok(result)
        }

        for (dispatch, expected_reads) in [
            (crate::dispatch as Dispatch, 1),
            (crate::dispatch_local as Dispatch, 1),
            (custom_dispatch as Dispatch, 2),
        ] {
            let (_dir, service) = fixture();
            let request = json!({"action":"check_now","localOnly":true,"skipLocalDiscovery":true});
            let before = service.snapshot_reads.load(Ordering::Relaxed);
            let pending = service
                .execute(
                    json!({"action":"start_task","statusOnly":true,"request":request}),
                    dispatch,
                )
                .unwrap();
            let id = pending["task"]["id"].as_str().unwrap();
            let result = service.wait(id).unwrap();
            assert_eq!(
                service.snapshot_reads.load(Ordering::Relaxed) - before,
                expected_reads
            );

            let latest = service.snapshot().unwrap();
            for field in [
                "skills",
                "sources",
                "settings",
                "sceneRevision",
                "activeSceneId",
                "sceneError",
                "stateRevision",
            ] {
                assert_eq!(result[field], latest[field], "{field}");
                assert!(result.get(field).is_some(), "{field}");
            }
            assert!(result["checkSummary"]["errors"].is_number());
            assert!(result["checkSummary"]["rootErrors"].is_array());
            if expected_reads == 2 {
                assert_eq!(result["customField"], "preserved");
            }
            let full = service
                .execute(json!({"action":"get_task","taskId":id}), dispatch)
                .unwrap();
            assert_eq!(full["task"]["result"], result);
            let status = service
                .execute(
                    json!({"action":"get_task","taskId":id,"statusOnly":true}),
                    dispatch,
                )
                .unwrap();
            assert_eq!(status["task"]["status"], "succeeded");
            assert_eq!(
                status["task"]["completionStamp"]["stateRevision"],
                result["stateRevision"]
            );
            assert_eq!(
                status["task"]["completionStamp"]["readGeneration"],
                result["readGeneration"]
            );
        }
    }

    #[test]
    fn lightweight_check_status_reports_the_rebased_stamp_without_loading_results() {
        fn dispatch(manager: &mut Manager, _: &Value) -> Result<Value, String> {
            let mut value = manager.snapshot();
            value["stateRevision"] = json!(0);
            value["checkSummary"] = json!({"errors":0});
            value["failed"] = json!(1);
            Ok(value)
        }

        let (dir, service) = fixture();
        let pending = service
            .execute(
                json!({"action":"start_task","statusOnly":true,"request":{"action":"check_now"}}),
                dispatch,
            )
            .unwrap();
        let id = pending["task"]["id"].as_str().unwrap();
        assert_eq!(pending["task"]["status"], "queued");
        assert!(pending["task"].get("resources").is_none());
        assert!(pending["task"].get("completionStamp").is_none());

        let result = service.wait(id).unwrap();
        let read = json!({"action":"get_task","taskId":id});
        let full = service.execute(read.clone(), dispatch).unwrap();
        assert_eq!(full["task"]["result"], result);
        assert!(full["task"]["resources"].is_array());
        assert!(full["task"].get("completionStamp").is_none());
        assert_eq!(result["checkSummary"]["errors"], 0);
        assert!(result["stateRevision"].as_u64().unwrap() > 0);

        let db = rusqlite::Connection::open(dir.path().join("manager.sqlite3")).unwrap();
        let row: Value = serde_json::from_str(&history_payloads(&db)[id]).unwrap();
        assert_eq!(row["resources"], full["task"]["resources"]);
        assert!(row.get("completionStamp").is_none());
        assert!(service.list().unwrap()[0].get("completionStamp").is_none());

        // A corrupted payload may make full retrieval fail, but must not affect
        // the lightweight status derived from the completed runtime snapshot.
        service
            .jobs
            .lock()
            .unwrap()
            .get_mut(id)
            .unwrap()
            .task
            .result = Some(Arc::new(TaskResult {
            bytes: vec![1, 2, 3],
            compressed: true,
        }));
        assert!(service.execute(read.clone(), dispatch).is_err());
        let mut status_only = read;
        status_only["statusOnly"] = json!(true);
        let status = service.execute(status_only, dispatch).unwrap();
        let task = &status["task"];
        assert_eq!(task["status"], "partial");
        assert_eq!(
            task["completionStamp"]["stateRevision"],
            result["stateRevision"]
        );
        assert_eq!(
            task["completionStamp"]["readGeneration"],
            result["readGeneration"]
        );
        assert!(task.get("resources").is_none());
        assert!(task.get("result").is_none());
    }

    #[test]
    fn lightweight_check_status_rejects_other_actions_and_omits_ineligible_stamps() {
        let (_dir, service) = fixture();
        assert!(service
            .execute(
                json!({"action":"start_task","statusOnly":true,"request":{"action":"refresh"}}),
                |_, _| panic!("unsupported lightweight request must not dispatch"),
            )
            .is_err());
        let other = start(&service, json!({"action":"refresh"}));
        service.wait(&other).unwrap();
        assert!(service
            .execute(
                json!({"action":"get_task","taskId":other,"statusOnly":true}),
                fake_dispatch
            )
            .is_err());

        let failed = start(&service, json!({"action":"check_now","fail":true}));
        assert!(service.wait(&failed).is_err());
        let status = service.get_check_status(&failed).unwrap();
        assert_eq!(status["status"], "failed");
        assert_eq!(status["error"], "Synthetic failure");
        assert!(status.get("completionStamp").is_none());

        let (hold_id, latch) = new_latch();
        let cancelled = start(&service, json!({"action":"check_now","hold":hold_id}));
        entered(&latch);
        service.cancel(&cancelled).unwrap();
        assert!(service.wait(&cancelled).is_err());
        let status = service.get_check_status(&cancelled).unwrap();
        assert_eq!(status["status"], "cancelled");
        assert!(status.get("completionStamp").is_none());
        assert!(CheckCompletionStamp::from_result(
            &json!({"stateRevision":1,"readGeneration":null})
        )
        .is_none());
    }

    fn retention_job(
        id: &str,
        action: &str,
        result: Arc<TaskResult>,
        resources: Vec<String>,
    ) -> Job {
        let mut task: Task = serde_json::from_value(json!({
            "id":id,"action":action,"label":"private-label","status":"succeeded",
            "stage":"private-stage","createdAt":"2026-11-11T00:00:00Z"
        }))
        .unwrap();
        task.result = Some(result.clone());
        task.resources = resources.into();
        Job {
            task,
            completion_stamp: None,
            history_revision: 0,
            cancel: Arc::new(AtomicBool::new(false)),
            completion: Arc::new((Mutex::new(Some(Ok(result))), Condvar::new())),
            visible: true,
            recorded: true,
            consumers: 0,
            dedup: None,
            automatic: false,
            resource_automation: false,
        }
    }

    #[test]
    fn completed_checks_share_exact_keys_across_live_history_and_reopen() {
        let (dir, service) = fixture();
        let ids = ["one", "one", "two"].map(|skill_id| {
            let id = start(&service, json!({"action":"check_now","skillId":skill_id}));
            service.wait(&id).unwrap();
            id
        });
        assert_eq!(ids.iter().collect::<BTreeSet<_>>().len(), ids.len());

        let verify_sharing = |tasks: &TaskSystem| {
            let jobs = tasks.jobs.lock().unwrap();
            let [first, repeated, distinct] = ids.each_ref().map(|id| &jobs[id].task.resources);
            assert!(Arc::ptr_eq(first, repeated));
            assert_eq!(first.len(), distinct.len());
            assert_ne!(first.as_ref(), distinct.as_ref());
            assert!(!Arc::ptr_eq(first, distinct));
            let key_count = first.len();
            let buffer_bytes: usize = first
                .iter()
                .chain(distinct.iter())
                .map(String::capacity)
                .sum();
            drop(jobs);

            let counts = tasks.retention_stats().unwrap();
            assert_eq!(counts["schedulingKeys"], key_count * 3);
            assert_eq!(counts["uniqueKeySets"], 2);
            assert_eq!(counts["uniqueSchedulingKeys"], key_count * 2);
            assert_eq!(counts["keyBufferCapacityBytes"], buffer_bytes);
            assert_eq!(
                counts["keyVectorCapacityBytes"],
                key_count * 2 * std::mem::size_of::<String>()
            );
            assert_eq!(counts["byAction"]["check_now"]["uniqueKeySets"], 2);
        };
        verify_sharing(&service);

        let live_keys = ids.each_ref().map(|id| {
            let keys = service.get(id, false).unwrap()["resources"].clone();
            assert!(keys.is_array());
            keys
        });
        assert_eq!(live_keys[0], live_keys[1]);
        assert_ne!(live_keys[0], live_keys[2]);
        let db = rusqlite::Connection::open(dir.path().join("manager.sqlite3")).unwrap();
        let saved = history_payloads(&db);
        for (id, keys) in ids.iter().zip(&live_keys) {
            let row: Value = serde_json::from_str(&saved[id]).unwrap();
            assert_eq!(&row["resources"], keys);
        }

        drop(service);
        let reopened = TaskSystem::new(Manager::new(dir.path().into()).unwrap()).unwrap();
        verify_sharing(&reopened);
        for (id, keys) in ids.iter().zip(&live_keys) {
            assert_eq!(&reopened.get(id, false).unwrap()["resources"], keys);
        }
    }

    #[test]
    fn task_retention_counts_shared_payload_and_owned_key_buffers_without_decoding() {
        let (_dir, service) = fixture();
        let mut bytes = Vec::with_capacity(64);
        bytes.extend_from_slice(&[1, 2, 3]);
        // Deliberately invalid compressed data proves observation never decodes it.
        let result = Arc::new(TaskResult {
            bytes,
            compressed: true,
        });
        let mut key = String::with_capacity(80);
        key.push_str("file:D:/私有/目录");
        let mut keys = Vec::with_capacity(4);
        keys.push(key);
        keys.push("skill:private-id".to_owned());
        let key_bytes: usize = keys.iter().map(String::len).sum();
        let key_capacity: usize = keys.iter().map(String::capacity).sum();
        let vector_capacity = std::mem::size_of_val(keys.as_slice());
        let first = retention_job("private-one", "check_now", result.clone(), keys);
        let mut second = retention_job("private-two", "resource_list", result.clone(), vec![]);
        second.recorded = false;
        second.task.status = "running".into();
        {
            let mut jobs = service.jobs.lock().unwrap();
            jobs.clear();
            jobs.insert(first.task.id.clone(), first);
            jobs.insert(second.task.id.clone(), second);
        }
        let value = service.retention_stats().unwrap();
        assert_eq!(value["jobs"], 2);
        assert_eq!(value["recordedJobs"], 1);
        assert_eq!(value["activeJobs"], 1);
        assert_eq!(value["uniqueResults"], 1);
        assert_eq!(value["compressedResults"], 1);
        assert_eq!(value["payloadBytes"], result.bytes.len());
        assert_eq!(value["payloadCapacityBytes"], result.bytes.capacity());
        assert_eq!(value["schedulingKeys"], 2);
        assert_eq!(value["uniqueKeySets"], 1);
        assert_eq!(value["uniqueSchedulingKeys"], 2);
        assert_eq!(value["keyUtf8Bytes"], key_bytes);
        assert_eq!(value["keyBufferCapacityBytes"], key_capacity);
        assert_eq!(value["keyVectorCapacityBytes"], vector_capacity);
        assert_eq!(value["byAction"]["check_now"]["uniqueResults"], 1);
        assert_eq!(value["byAction"]["resource_list"]["uniqueResults"], 1);
        assert_eq!(value["byActionDeduplication"], "within-each-action");
        let encoded = value.to_string();
        for secret in ["private-one", "private-id", "私有", "resultAddresses"] {
            assert!(!encoded.contains(secret));
        }
    }

    #[test]
    fn task_retention_observation_is_readonly_and_preserves_cache_fields() {
        let (_dir, service) = fixture();
        let outcome = json!({"private-result":"完整内容".repeat(20000)});
        let result = Arc::new(TaskResult::new(&outcome));
        assert!(result.compressed);
        {
            let mut jobs = service.jobs.lock().unwrap();
            jobs.clear();
            jobs.insert(
                "private-one".into(),
                retention_job("private-one", "check_now", result.clone(), vec![]),
            );
        }
        let before_tasks = service.list().unwrap();
        let before_state = service.snapshot().unwrap();
        let before_history = service.manager.lock().unwrap().task_history().unwrap();
        let before_references = Arc::strong_count(&result);
        let value = service
            .execute(json!({"action":"get_content_cache_stats"}), |_, _| {
                panic!("diagnostic observation must not dispatch a worker")
            })
            .unwrap();
        for field in ["bytes", "entries", "inFlight", "limitBytes"] {
            assert!(
                value[field].is_u64(),
                "missing original cache field {field}"
            );
        }
        assert_eq!(value["taskRetention"]["formatVersion"], 1);
        assert_eq!(
            value["taskRetention"]["scope"],
            "job-owned-result-and-key-buffers"
        );
        assert_eq!(value["taskRetention"]["jobs"], 1);
        assert_eq!(value["taskRetention"]["payloadBytes"], result.bytes.len());
        assert_eq!(service.list().unwrap(), before_tasks);
        assert_eq!(service.snapshot().unwrap(), before_state);
        assert_eq!(
            service.manager.lock().unwrap().task_history().unwrap(),
            before_history
        );
        assert_eq!(Arc::strong_count(&result), before_references);
        assert_eq!(result.read().unwrap(), outcome);
        assert!(!value.to_string().contains("private-result"));
    }

    #[test]
    fn task_retention_observation_rejects_options_and_redacts_unknown_actions() {
        let (_dir, service) = fixture();
        let result = Arc::new(TaskResult::new(&json!({"secret":"private-content"})));
        {
            let mut jobs = service.jobs.lock().unwrap();
            jobs.clear();
            jobs.insert(
                "private-one".into(),
                retention_job("private-one", "D:/private/unknown-action", result, vec![]),
            );
        }
        for options in [json!({"includeContents":true}), json!({"keys":true})] {
            let mut request = options;
            request["action"] = json!("get_content_cache_stats");
            assert_eq!(
                service.execute(request, |_, _| panic!("options must be rejected")),
                Err("缓存诊断只接受读取请求".into())
            );
        }
        let value = service.retention_stats().unwrap();
        assert_eq!(value["jobs"], 1);
        assert_eq!(value["byAction"].as_object().unwrap().len(), 1);
        assert_eq!(value["byAction"]["other"]["jobs"], 1);
        let encoded = value.to_string();
        assert!(!encoded.contains("private"));
        assert!(!encoded.contains("D:/"));
    }

    #[test]
    fn plain_results_do_not_read_manager_snapshot() {
        for mut value in [
            json!({"markdown":"完整说明", "readGeneration":42}),
            json!({"files":["SKILL.md"], "snapshot":null}),
            json!({"skills":[], "description":"not a state snapshot"}),
            json!({"snapshot":{"summary":"nested non-state result"}}),
            json!(["a", "b"]),
            Value::Null,
        ] {
            let expected = value.clone();
            rebase_result(&mut value, || panic!("plain result must not load state")).unwrap();
            assert_eq!(value, expected);
        }
    }

    #[test]
    fn state_results_rebase_once_and_keep_operation_fields() {
        let (_dir, service) = fixture();
        let current = service.snapshot().unwrap();
        let mut stale = current.clone();
        stale["skills"] = json!([]);
        stale["stateRevision"] = json!(0);
        stale["operationResult"] = json!({"paths":["D:/资源/输出.zip"]});
        stale["stateSnapshot"] = json!({"skills":[], "stateRevision":0});
        stale["snapshot"] = json!({"skills":[], "stateRevision":0});
        let mut calls = 0;
        rebase_result(&mut stale, || {
            calls += 1;
            Ok(current.clone())
        })
        .unwrap();
        let mut expected = current.clone();
        expected["sceneError"] = Value::Null;
        expected["operationResult"] = json!({"paths":["D:/资源/输出.zip"]});
        expected["stateSnapshot"] = current.clone();
        expected["snapshot"] = current;
        assert_eq!(calls, 1);
        assert_eq!(stale, expected);
    }

    #[test]
    fn nested_state_rebases_and_required_snapshot_errors_are_preserved() {
        for field in ["stateSnapshot", "snapshot"] {
            let current = json!({"skills":[{"id":"current"}],"stateRevision":7});
            let mut value = json!({"operation":"complete"});
            value[field] = json!({"skills":[]});
            rebase_result(&mut value, || Ok(current.clone())).unwrap();
            assert_eq!(value[field], current);
            assert_eq!(value["operation"], "complete");
            let expected = value.clone();
            assert_eq!(
                rebase_result(&mut value, || Err("snapshot unavailable".into())),
                Err("snapshot unavailable".into())
            );
            assert_eq!(value, expected);
        }
    }

    #[test]
    fn retained_task_results_round_trip_small_and_large_values_without_loss() {
        let small = json!({"path":"D:/资源/结果.zip","complete":true,"warnings":[],"missing":null});
        let small_payload = TaskResult::new(&small);
        assert!(!small_payload.compressed);
        assert_eq!(small_payload.read().unwrap(), small);

        let large = json!({"skills":(0..1000).map(|id| json!({
            "id":id,"name":format!("技能 {id}"),"description":"原始内容与引用完整保留。".repeat(30),
            "files":["SKILL.md","scripts/run.py"],"version":"1.0.0"
        })).collect::<Vec<_>>(),"summary":"检查完成","revision":9007199254740993u64});
        let payload = TaskResult::new(&large);
        assert!(payload.compressed);
        assert!(payload.bytes.len() < serde_json::to_vec(&large).unwrap().len() / 4);
        assert_eq!(payload.read().unwrap(), large);
        assert_eq!(payload.read().unwrap(), large);
    }

    #[test]
    fn large_task_result_is_shared_and_survives_metadata_reads_and_history_clear() {
        let (_dir, service) = fixture();
        let description = "保留完整结果，不删除历史或重放任务。".repeat(10000);
        let id = start(
            &service,
            json!({"action":"apply_update","skillId":"one",
            "fields":{"description":description}}),
        );
        let result = service.wait(&id).unwrap();
        assert_eq!(result["skills"][0]["description"], description);
        {
            let jobs = service.jobs.lock().unwrap();
            let job = &jobs[&id];
            let payload = job.task.result.as_ref().unwrap();
            let completion = job.completion.0.lock().unwrap();
            assert!(Arc::ptr_eq(
                payload,
                completion.as_ref().unwrap().as_ref().unwrap()
            ));
            assert!(payload.compressed);
            assert!(job.task.metadata().get("result").is_none());
        }
        assert!(service
            .list()
            .unwrap()
            .iter()
            .all(|task| task.get("result").is_none()));
        assert!(service
            .manager
            .lock()
            .unwrap()
            .task_history()
            .unwrap()
            .iter()
            .all(|task| task.get("result").is_none()));
        assert_eq!(service.get(&id, true).unwrap()["result"], result);
        service.clear_history().unwrap();
        assert!(service.list().unwrap().is_empty());
        assert_eq!(service.get(&id, true).unwrap()["result"], result);
        assert_eq!(service.wait(&id).unwrap(), result);
    }

    #[test]
    fn scene_switch_coordinates_new_skill_connections_without_blocking_run_activity() {
        let (_dir, service) = fixture();
        let manager = service.manager.lock().unwrap();
        let switching = resources_for(
            &manager,
            &json!({"action":"resource_scene_activate","id":null,"expectedRevision":0}),
        )
        .unwrap();
        for action in ["connect", "connect_batch"] {
            let connecting = resources_for(
                &manager,
                &json!({"action":action,"skillId":"one","skillIds":["one"],"client":"codex"}),
            )
            .unwrap();
            assert!(conflicts(&switching, &connecting));
        }
        let invocation =
            resources_for(&manager, &json!({"action":"resource_invoke","id":"tool"})).unwrap();
        assert!(!conflicts(&switching, &invocation));
        for action in [
            "resource_keep_alive",
            "resource_usage_begin",
            "resource_usage_end",
            "resource_stop",
        ] {
            let activity =
                resources_for(&manager, &json!({"action":action,"runId":"run"})).unwrap();
            assert!(!conflicts(&switching, &activity));
            assert!(!conflicts(&invocation, &activity));
        }
    }
    use std::{sync::OnceLock, time::Instant};

    #[test]
    fn manual_mode_invalidates_inflight_automatic_results_without_touching_user_work() {
        let (_dir, service) = fixture();
        let (hold_id, latch) = new_latch();
        let task=service.start(json!({"action":"check_now","automatic":true,"checkGeneration":0,"skillIds":["one"],"skillIdForTest":"one","hold":hold_id,"fields":{"status":"synced"},"skillId":"one"}),None,None,false,false,fake_dispatch);
        // A check may select one ID or a list, never both.
        assert!(task.is_err());
        let task=service.start(json!({"action":"check_now","automatic":true,"checkGeneration":0,"skillId":"one","hold":hold_id,"fields":{"status":"synced"}}),None,None,false,false,fake_dispatch).unwrap();
        entered(&latch);
        service
            .execute(
                json!({"action":"set_check_mode","mode":"manual"}),
                crate::dispatch,
            )
            .unwrap();
        release(&latch);
        assert!(service.wait(task["id"].as_str().unwrap()).is_err());
        assert_eq!(
            service.snapshot().unwrap()["skills"][0]["status"],
            "local_only"
        );
        assert_eq!(service.snapshot().unwrap()["checkMode"], "manual");
    }

    #[test]
    fn automatic_noop_has_no_revision_event_or_history_write() {
        fn noop(manager: &mut Manager, _: &Value) -> Result<Value, String> {
            manager.save()?;
            let mut snapshot = manager.snapshot();
            snapshot["checkSummary"] = json!({"changed":false});
            Ok(snapshot)
        }
        let (_dir, service) = fixture();
        {
            let mut manager = service.manager.lock().unwrap();
            manager.state.check_summary = json!({"changed":true,"newLocal":1});
            manager.save().unwrap();
        }
        let revision = service.snapshot().unwrap()["stateRevision"].clone();
        let task = service
            .start(
                json!({"action":"check_now","automatic":true,"checkGeneration":0}),
                None,
                None,
                false,
                false,
                noop,
            )
            .unwrap();
        let result = service.wait(task["id"].as_str().unwrap()).unwrap();
        assert_eq!(result["checkSummary"]["changed"], false);
        assert_eq!(service.snapshot().unwrap()["stateRevision"], revision);
        assert!(service.list().unwrap().is_empty());
    }

    #[test]
    fn check_summary_save_keeps_concurrent_library_and_settings_in_place() {
        fn summarize(manager: &mut Manager, request: &Value) -> Result<Value, String> {
            hold(request["hold"].as_str().unwrap())?;
            manager.state.check_summary = json!({"changed":true,"newLocal":1});
            manager.save()?;
            Ok(manager.snapshot())
        }

        let (dir, service) = fixture();
        let (hold_id, latch) = new_latch();
        let task = service
            .start(
                json!({"action":"check_now","skillId":"one","hold":hold_id}),
                None,
                None,
                false,
                false,
                summarize,
            )
            .unwrap();
        entered(&latch);
        let (skills_address, expected_revision) = {
            let mut manager = service.manager.lock().unwrap();
            manager.state.skills[0]["favorite"] = json!(true);
            manager.state.settings["editorPath"] = json!("alternative-editor");
            manager.state.check_summary = json!({"changed":true,"newLocal":2});
            manager.save().unwrap();
            (
                manager.state.skills.as_ptr() as usize,
                manager.snapshot()["stateRevision"].as_u64().unwrap() + 1,
            )
        };
        release(&latch);
        let result = service.wait(task["id"].as_str().unwrap()).unwrap();
        let manager = service.manager.lock().unwrap();
        assert_eq!(manager.state.skills.as_ptr() as usize, skills_address);
        assert_eq!(manager.state.skills[0]["favorite"], true);
        assert_eq!(manager.state.settings["editorPath"], "alternative-editor");
        assert_eq!(result["checkSummary"]["newLocal"], 1);
        let reopened = Manager::new(dir.path().into()).unwrap();
        assert!(reopened.state == manager.state);
        assert_eq!(reopened.snapshot()["stateRevision"], expected_revision);
    }

    #[test]
    fn failed_check_summary_save_preserves_already_committed_discovery() {
        let (dir, service) = fixture();
        let root = dir.path().join("auto-import");
        std::fs::create_dir(&root).unwrap();
        service
            .execute(
                json!({"action":"add_local_roots","paths":[root]}),
                crate::dispatch,
            )
            .unwrap();
        let new_skill = root.join("check-summary-fixture");
        std::fs::create_dir(&new_skill).unwrap();
        std::fs::write(
            new_skill.join("SKILL.md"),
            "---\nname: check-summary-fixture\ndescription: Synthetic fixture\n---\nRead it.\n",
        )
        .unwrap();
        let before = service.snapshot().unwrap();
        let db = rusqlite::Connection::open(dir.path().join("manager.sqlite3")).unwrap();
        db.execute_batch(
            "CREATE TRIGGER reject_check_summary BEFORE UPDATE ON app_state
             WHEN json_extract(NEW.payload, '$.checkSummary')
             IS NOT json_extract(OLD.payload, '$.checkSummary')
             BEGIN SELECT RAISE(ABORT, 'synthetic summary failure'); END;",
        )
        .unwrap();

        let pending = service
            .execute(
                json!({"action":"start_task","statusOnly":true,"request":{"action":"check_now","localOnly":true}}),
                crate::dispatch,
            )
            .unwrap();
        let id = pending["task"]["id"].as_str().unwrap();
        assert!(service
            .wait(id)
            .unwrap_err()
            .contains("synthetic summary failure"));
        let live = service.snapshot().unwrap();
        assert_eq!(live["checkSummary"], before["checkSummary"]);
        assert!(live["stateRevision"].as_u64() > before["stateRevision"].as_u64());
        assert!(live["skills"].as_array().unwrap().iter().any(|skill| {
            skill["name"] == "check-summary-fixture" && skill["localPath"].is_string()
        }));
        let reopened = Manager::new(dir.path().into()).unwrap().snapshot();
        for field in ["skills", "settings", "checkSummary", "stateRevision"] {
            assert_eq!(reopened[field], live[field], "{field}");
        }
        assert_eq!(service.get(id, false).unwrap()["status"], "failed");
    }

    #[test]
    fn maintenance_pause_blocks_new_and_inflight_checks_but_preserves_manual_work() {
        let (_dir, service) = fixture();
        let (hold_id, latch) = new_latch();
        let task = service
            .start(
                json!({"action":"check_now","automatic":true,"checkGeneration":0,
            "skillId":"one","hold":hold_id,"fields":{"status":"synced"}}),
                None,
                None,
                false,
                false,
                fake_dispatch,
            )
            .unwrap();
        entered(&latch);
        let paused = service
            .execute(
                json!({"action":"set_maintenance","expectedRevision":0,"pause":"manual"}),
                crate::dispatch,
            )
            .unwrap();
        assert_eq!(paused["maintenance"]["automaticAllowed"], false);
        assert_eq!(paused["checkMode"], "auto");
        assert_eq!(
            service.check_configuration().unwrap()["maintenance"]["automaticAllowed"],
            false
        );
        assert!(service
            .start(
                json!({"action":"check_now","automatic":true,"checkGeneration":0}),
                None,
                None,
                false,
                false,
                fake_dispatch
            )
            .is_err());
        release(&latch);
        assert!(service
            .wait(task["id"].as_str().unwrap())
            .unwrap_err()
            .contains("暂停"));
        assert_eq!(
            service.snapshot().unwrap()["skills"][0]["status"],
            "local_only"
        );
        let manual = start(
            &service,
            json!({"action":"check_now","skillId":"one","fields":{"status":"manual-checked"}}),
        );
        service.wait(&manual).unwrap();
        assert_eq!(
            service.snapshot().unwrap()["skills"][0]["status"],
            "manual-checked"
        );
        service
            .execute(
                json!({"action":"set_check_mode","mode":"manual"}),
                crate::dispatch,
            )
            .unwrap();
        let resumed = service
            .execute(
                json!({"action":"set_maintenance","expectedRevision":1,"pause":"resume"}),
                crate::dispatch,
            )
            .unwrap();
        assert_eq!(resumed["maintenance"]["automaticAllowed"], true);
        assert_eq!(resumed["checkMode"], "manual");
        assert_eq!(service.check_configuration().unwrap()["mode"], "manual");
    }

    #[test]
    fn queued_automatic_check_rechecks_maintenance_after_its_resource_lock() {
        let (_dir, service) = fixture();
        let (hold_id, latch) = new_latch();
        let manual = start(
            &service,
            json!({"action":"check_now","skillId":"one","hold":hold_id,"fields":{"status":"manual-checked"}}),
        );
        entered(&latch);
        let automatic = service
            .start(
                json!({"action":"check_now","skillId":"one","automatic":true,"checkGeneration":0,
            "fields":{"status":"must-not-apply"}}),
                None,
                None,
                false,
                false,
                fake_dispatch,
            )
            .unwrap();
        service
            .execute(
                json!({"action":"set_maintenance","expectedRevision":0,"pause":"manual"}),
                crate::dispatch,
            )
            .unwrap();
        release(&latch);
        service.wait(&manual).unwrap();
        assert!(service
            .wait(automatic["id"].as_str().unwrap())
            .unwrap_err()
            .contains("暂停"));
        assert_eq!(
            service.snapshot().unwrap()["skills"][0]["status"],
            "manual-checked"
        );
    }

    fn missing_client_fixture() -> (tempfile::TempDir, Arc<TaskSystem>, std::path::PathBuf) {
        let (dir, service) = fixture();
        let source = dir.path().join("source");
        let entry = dir.path().join("client/one");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(
            source.join("SKILL.md"),
            "---\nname: one\ndescription: Fixture\n---\nSynthetic skill.\n",
        )
        .unwrap();
        let mut manager = service.manager.lock().unwrap();
        manager.state.skills[0]["localPath"] = json!(source);
        manager.state.connections =
            vec![json!({"id":"owned-entry","skillId":"one","client":"codex",
            "path":entry,"target":source,"origin":"created","kind":"link","autoRepairable":true})];
        manager.save().unwrap();
        drop(manager);
        (dir, service, entry)
    }

    fn repair_dispatch(manager: &mut Manager, request: &Value) -> Result<Value, String> {
        if let Some(id) = request["beforeCommit"].as_str() {
            hold(id)?;
        }
        if let Some(id) = request["afterCommit"].as_str() {
            let id = id.to_owned();
            // The real client loop reports progress after admission and before
            // connect creates its first directory/link. No production test hook.
            return with_progress(
                Arc::new(move |stage, _, _| {
                    if stage == "正在安全恢复客户端入口" {
                        hold(&id).unwrap();
                    }
                }),
                || crate::dispatch(manager, request),
            );
        }
        crate::dispatch(manager, request)
    }

    fn change_repair_policy(service: &Arc<TaskSystem>, change: &str) {
        let request = match change {
            "pause" => json!({"action":"set_maintenance","expectedRevision":0,"pause":"manual"}),
            "mode" => json!({"action":"set_check_mode","mode":"manual"}),
            "window" => {
                use chrono::Timelike;
                let now = chrono::Local::now();
                let minute = now.hour() * 60 + now.minute();
                json!({"action":"set_maintenance","expectedRevision":0,
                    "window":{"startMinute":(minute+30)%1440,"endMinute":(minute+60)%1440}})
            }
            _ => unreachable!(),
        };
        service.execute(request, crate::dispatch).unwrap();
    }

    #[test]
    fn automatic_repair_rechecks_live_policy_before_any_entry_write() {
        for change in ["pause", "mode", "window"] {
            let (_dir, service, entry) = missing_client_fixture();
            let before = service.snapshot().unwrap()["connections"].clone();
            let (hold_id, latch) = new_latch();
            let task = service
                .start(
                    json!({"action":"repair_client_connections","connectionIds":["owned-entry"],
                "automatic":true,"checkGeneration":0,"beforeCommit":hold_id}),
                    None,
                    None,
                    false,
                    false,
                    repair_dispatch,
                )
                .unwrap();
            entered(&latch);
            change_repair_policy(&service, change);
            service.cancel_automatic();
            assert_eq!(
                service.get(task["id"].as_str().unwrap(), false).unwrap()["cancelRequested"],
                false
            );
            release(&latch);
            assert!(
                service.wait(task["id"].as_str().unwrap()).is_err(),
                "{change}"
            );
            assert!(
                !entry.parent().unwrap().exists(),
                "{change}: no client directory may be created"
            );
            assert_eq!(service.snapshot().unwrap()["connections"], before);
        }
    }

    #[test]
    fn queued_automatic_repair_rechecks_policy_after_waiting_and_manual_repair_remains_available() {
        let (_dir, service, entry) = missing_client_fixture();
        let (hold_id, latch) = new_latch();
        let blocker = start(
            &service,
            json!({"action":"connect_batch","client":"codex","skillIds":["one"],"hold":hold_id}),
        );
        entered(&latch);
        let request = json!({"action":"repair_client_connections","connectionIds":["owned-entry"],"automatic":true,"checkGeneration":0});
        let automatic = service
            .start(request.clone(), None, None, false, false, repair_dispatch)
            .unwrap();
        assert_eq!(
            service
                .get(automatic["id"].as_str().unwrap(), false)
                .unwrap()["status"],
            "queued"
        );
        change_repair_policy(&service, "pause");
        assert!(service
            .start(request, None, None, false, false, repair_dispatch)
            .is_err());
        let manual = service
            .start(
                json!({"action":"repair_client_connections","connectionIds":["owned-entry"]}),
                None,
                None,
                false,
                true,
                repair_dispatch,
            )
            .unwrap();
        assert_ne!(
            manual["id"], automatic["id"],
            "manual repair cannot reuse the gated automatic request"
        );
        release(&latch);
        service.wait(&blocker).unwrap();
        assert!(service
            .wait(automatic["id"].as_str().unwrap())
            .unwrap_err()
            .contains("暂停"));
        let result = service.wait(manual["id"].as_str().unwrap()).unwrap();
        assert_eq!(result["failed"], 0);
        assert!(entry.join("SKILL.md").is_file());
        assert_eq!(result["maintenance"]["automaticAllowed"], false);
        assert_eq!(result["connections"][0]["linked"], true);
    }

    #[test]
    fn admitted_automatic_repair_finishes_and_persists_evidence_after_policy_changes() {
        for change in ["pause", "mode", "window"] {
            let (dir, service, entry) = missing_client_fixture();
            let (hold_id, latch) = new_latch();
            let task = service
                .start(
                    json!({"action":"repair_client_connections","connectionIds":["owned-entry"],
                "automatic":true,"checkGeneration":0,"afterCommit":hold_id}),
                    None,
                    None,
                    false,
                    false,
                    repair_dispatch,
                )
                .unwrap();
            entered(&latch);
            assert!(!entry.exists());
            change_repair_policy(&service, change);
            service.cancel_automatic();
            assert!(service.cancel(task["id"].as_str().unwrap()).is_err());
            release(&latch);
            let result = service.wait(task["id"].as_str().unwrap()).unwrap();
            assert_eq!(result["failed"], 0, "{change}");
            assert_eq!(result["connectionResults"][0]["success"], true);
            assert!(entry.join("SKILL.md").is_file());
            assert_eq!(result["connections"][0]["linked"], true);
            assert_eq!(
                service.get(task["id"].as_str().unwrap(), false).unwrap()["status"],
                "succeeded"
            );
            let saved = Manager::new(dir.path().into()).unwrap();
            assert_eq!(saved.state.connections[0]["linked"], true);
            assert!(saved
                .task_history()
                .unwrap()
                .iter()
                .any(|record| record["id"] == task["id"] && record["status"] == "succeeded"));
        }
    }

    #[test]
    fn automatic_commit_admission_is_bound_to_the_original_repair_action_and_generation() {
        fn wrong_action(manager: &mut Manager, _: &Value) -> Result<Value, String> {
            manager.begin_automatic_commit(
                &json!({"action":"repair_client_connections","automatic":true}),
            )?;
            Err("unexpected admission".into())
        }
        let (_dir, service, entry) = missing_client_fixture();
        let task = service
            .start(
                json!({"action":"check_now","automatic":true,"checkGeneration":0}),
                None,
                None,
                false,
                false,
                wrong_action,
            )
            .unwrap();
        assert!(service
            .wait(task["id"].as_str().unwrap())
            .unwrap_err()
            .contains("没有自动写入流程"));
        assert!(service
            .start(
                json!({"action":"repair_client_connections","automatic":true,"checkGeneration":1}),
                None,
                None,
                false,
                false,
                repair_dispatch
            )
            .unwrap_err()
            .contains("设置已改变"));
        service.manager.lock().unwrap().basic_mode = true;
        for automatic in [false, true] {
            assert!(service.start(json!({"action":"repair_client_connections","automatic":automatic,"checkGeneration":0}),
                None, None, false, false, repair_dispatch).unwrap_err().contains("基本模式"));
        }
        assert!(!entry.parent().unwrap().exists());
    }

    #[test]
    fn maintenance_policy_is_not_an_automatic_install_or_confirmation_grant() {
        let (_dir, service) = fixture();
        for action in [
            "apply_resource_install",
            "apply_resource_repair",
            "apply_resource_remove",
            "set_maintenance",
        ] {
            let result = service.start(
                json!({"action":action,"automatic":true,"checkGeneration":0}),
                None,
                None,
                false,
                false,
                fake_dispatch,
            );
            assert!(result.unwrap_err().contains("自动维护执行流程"));
        }
        let display = resources_for(
            &service.manager.lock().unwrap(),
            &json!({"action":"set_settings"}),
        )
        .unwrap();
        let policy = resources_for(
            &service.manager.lock().unwrap(),
            &json!({"action":"set_maintenance"}),
        )
        .unwrap();
        assert!(!conflicts(&display, &policy));
        assert!(conflicts(&policy, &policy));
    }

    #[test]
    fn source_records_merge_by_id_and_config_edits_advance_live_generation() {
        let (_dir, service) = fixture();
        let before = service.manager.lock().unwrap().state.clone();
        let mut after = before.clone();
        let mut live = before.clone();
        after
            .local_roots
            .push(json!({"id":"a","path":"a","enabled":true}));
        after.check_generation += 1;
        live.local_roots
            .push(json!({"id":"b","path":"b","enabled":true}));
        live.check_generation += 1;
        let merged = merge_state(&before, &after, &live, "add_local_roots").unwrap();
        assert_eq!(merged.local_roots.len(), 2);
        assert_eq!(merged.check_generation, 2);
        assert!(validate_automatic_configuration(&merged, &json!({"checkGeneration":1})).is_err());
    }

    #[test]
    fn new_local_skill_registers_while_remote_task_is_blocked() {
        let (dir, service) = fixture();
        let root = dir.path().join("local");
        std::fs::create_dir(&root).unwrap();
        service
            .execute(
                json!({"action":"add_local_roots","paths":[root]}),
                crate::dispatch,
            )
            .unwrap();
        let generation = service.snapshot().unwrap()["checkGeneration"].clone();
        let (hold_id, latch) = new_latch();
        let remote=service.start(json!({"action":"check_now","automatic":true,"checkGeneration":generation,"remoteOnly":true,"hold":hold_id}),None,None,false,false,fake_dispatch).unwrap();
        entered(&latch);
        let skill = root.join("new");
        std::fs::create_dir(&skill).unwrap();
        std::fs::write(
            skill.join("SKILL.md"),
            "---\nname: new\ndescription: synthetic\n---\nUse it.\n",
        )
        .unwrap();
        let discovery=service.start(json!({"action":"discover_local","automatic":true,"checkGeneration":generation,"skillIds":[],"changedPaths":[skill.join("SKILL.md")]}),None,None,false,false,crate::dispatch).unwrap();
        let id = discovery["id"].as_str().unwrap();
        task_status(&service, id, "succeeded");
        let result = service.wait(id).unwrap();
        assert_eq!(result["discoveredSkillIds"].as_array().unwrap().len(), 1);
        assert_eq!(
            service.snapshot().unwrap()["skills"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
        assert_eq!(
            service.get(remote["id"].as_str().unwrap(), false).unwrap()["status"],
            "running"
        );
        release(&latch);
        service.wait(remote["id"].as_str().unwrap()).unwrap();
    }

    #[test]
    fn concurrent_same_real_local_directory_is_rejected_without_duplicate_records() {
        let (dir, service) = fixture();
        let folder = dir.path().join("skill");
        std::fs::create_dir(&folder).unwrap();
        let before = service.manager.lock().unwrap().state.clone();
        let mut after = before.clone();
        let mut live = before.clone();
        after.skills.push(json!({"id":"first","localPath":folder}));
        live.skills.push(json!({"id":"second","localPath":folder}));
        assert!(merge_state(&before, &after, &live, "discover_local").is_err());
        assert_eq!(live.skills.len(), 4);
    }

    #[test]
    fn durable_metadata_events_use_live_revision_and_workspace_uses_same_database() {
        let (dir, service) = fixture();
        let revisions = Arc::new(Mutex::new(Vec::new()));
        let observed = revisions.clone();
        service
            .set_state_events(Arc::new(move |revision| {
                observed.lock().unwrap().push(revision)
            }))
            .unwrap();
        service
            .execute(
                json!({"action":"set_settings","settings":{"uiZoom":125}}),
                fake_dispatch,
            )
            .unwrap();
        let revision = service.snapshot().unwrap()["stateRevision"]
            .as_u64()
            .unwrap();
        assert_eq!(*revisions.lock().unwrap(), vec![revision]);
        let workspace =
            json!({"revision":2,"windows":[{"label":"main","panes":[],"activePaneId":"home"}]});
        service.store_workspace_state(&workspace).unwrap();
        assert_eq!(service.workspace_state().unwrap(), Some(workspace.clone()));
        let db = rusqlite::Connection::open(dir.path().join("manager.sqlite3")).unwrap();
        let stored: String = db
            .query_row(
                "SELECT payload FROM workspace_state WHERE id=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&stored).unwrap(), workspace);
        assert_eq!(service.snapshot().unwrap()["settings"]["uiZoom"], 125);
    }

    #[test]
    fn task_origin_retains_stable_pane_identity_when_moved_to_another_window() {
        let (_dir, service) = fixture();
        let task = service
            .start(
                json!({"action":"get_document","skillId":"one"}),
                Some("read"),
                Some(&json!({"paneId":"detail-one","windowLabel":"main"})),
                true,
                true,
                fake_dispatch,
            )
            .unwrap();
        let id = task["id"].as_str().unwrap();
        service.wait(id).unwrap();
        service
            .store_workspace_move(
                &json!({"revision":1,"windows":[]}),
                "detail-one",
                "workspace-second",
            )
            .unwrap();
        let moved = service.get(id, false).unwrap();
        assert_eq!(moved["origin"]["paneId"], "detail-one");
        assert_eq!(moved["origin"]["windowLabel"], "workspace-second");
        assert!(
            service
                .manager
                .lock()
                .unwrap()
                .task_history()
                .unwrap()
                .iter()
                .any(|entry| entry["id"] == id
                    && entry["origin"]["windowLabel"] == "workspace-second")
        );
    }

    #[test]
    fn pane_move_rolls_back_layout_and_task_ownership_together_on_history_write_failure() {
        let (dir, service) = fixture();
        let task = service
            .start(
                json!({"action":"get_document","skillId":"one"}),
                None,
                Some(&json!({"paneId":"detail-one","windowLabel":"main"})),
                true,
                true,
                fake_dispatch,
            )
            .unwrap();
        let id = task["id"].as_str().unwrap();
        service.wait(id).unwrap();
        let before = json!({"revision":1,"windows":[{"label":"main"}]});
        service.store_workspace_state(&before).unwrap();
        let db = rusqlite::Connection::open(dir.path().join("manager.sqlite3")).unwrap();
        db.execute_batch("CREATE TRIGGER stop_history BEFORE INSERT ON task_history BEGIN SELECT RAISE(ABORT,'synthetic history failure'); END").unwrap();
        assert!(service
            .store_workspace_move(
                &json!({"revision":2,"windows":[{"label":"workspace-second"}]}),
                "detail-one",
                "workspace-second"
            )
            .is_err());
        assert_eq!(service.workspace_state().unwrap(), Some(before));
        assert_eq!(
            service.get(id, false).unwrap()["origin"]["windowLabel"],
            "main"
        );
        let stored: String = db
            .query_row(
                "SELECT payload FROM task_history WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&stored).unwrap()["origin"]["windowLabel"],
            "main"
        );
    }
    #[test]
    fn history_clear_broadcasts_exact_ids_only_after_durable_success_and_restores_on_failure() {
        let (dir, service) = fixture();
        let id = start(&service, json!({"action":"get_files","skillId":"one"}));
        service.wait(&id).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let listener = events.clone();
        service.set_events(Arc::new(move |event| listener.lock().unwrap().push(event)));
        let db = rusqlite::Connection::open(dir.path().join("manager.sqlite3")).unwrap();
        db.execute_batch("CREATE TRIGGER prevent_history_clear BEFORE DELETE ON task_history BEGIN SELECT RAISE(ABORT,'synthetic failure'); END").unwrap();
        assert!(service.clear_history().is_err());
        assert_eq!(service.list().unwrap().len(), 1);
        assert!(events.lock().unwrap().is_empty());
        db.execute_batch("DROP TRIGGER prevent_history_clear")
            .unwrap();
        assert_eq!(service.clear_history().unwrap(), vec![id.clone()]);
        let event = events.lock().unwrap()[0].clone();
        assert_eq!(event["clearedTaskIds"], json!([id]));
        assert_eq!(event["tasks"], json!([]));
        assert_eq!(service.get(&id, true).unwrap()["hidden"], true);
        assert!(event.get("result").is_none());
    }

    #[test]
    fn external_batch_rechecks_are_reads_and_binding_conflicts_with_export_scope() {
        let (_dir, service) = fixture();
        let manager = service.manager.lock().unwrap();
        let check =
            json!({"action":"batch_external_dependencies","operation":"recheck","skillId":"one"});
        let bind =
            json!({"action":"batch_external_dependencies","operation":"bind","skillId":"one"});
        assert!(read_request(&check));
        assert!(!read_request(&bind));
        let reads = resources_for(&manager, &check).unwrap();
        let writes = resources_for(&manager, &bind).unwrap();
        let export = resources_for(
            &manager,
            &json!({"action":"export","skillId":"one","destination":"synthetic.zip"}),
        )
        .unwrap();
        assert!(conflicts(&writes, &export));
        assert!(!conflicts(&reads, &export));
    }
    #[test]
    fn automatic_matching_deduplicates_identical_proof_across_callers_but_not_new_proof() {
        let (_dir, service) = fixture();
        {
            let mut manager = service.manager.lock().unwrap();
            let skill = &mut manager.state.skills[0];
            skill["sourceId"] = json!("source");
            skill["repo"] = json!("synthetic/repo");
            skill["branch"] = json!("main");
            skill["remotePath"] = json!("one");
        }
        let (hold_id, latch) = new_latch();
        let request = json!({"action":"batch_external_dependencies","operation":"auto_match","skillId":"one","remoteCommit":"a".repeat(40),"items":[{"id":"b","expectedFingerprint":"second"},{"id":"a","expectedFingerprint":"first"}],"hold":hold_id});
        let first = service
            .start(
                request.clone(),
                Some("background"),
                None,
                false,
                true,
                fake_dispatch,
            )
            .unwrap();
        entered(&latch);
        let mut reordered = request.clone();
        reordered["items"].as_array_mut().unwrap().reverse();
        let joined = service
            .start(
                reordered,
                Some("opened detail"),
                Some(&json!({"paneId":"detail-one","windowLabel":"main"})),
                true,
                true,
                fake_dispatch,
            )
            .unwrap();
        assert_eq!(first["id"], joined["id"]);
        let mut other_commit = request.clone();
        other_commit["remoteCommit"] = json!("b".repeat(40));
        let distinct = service
            .start(other_commit, None, None, true, true, fake_dispatch)
            .unwrap();
        assert_ne!(first["id"], distinct["id"]);
        let mut other_fingerprint = request.clone();
        other_fingerprint["items"][0]["expectedFingerprint"] = json!("changed");
        let distinct_fingerprint = service
            .start(other_fingerprint, None, None, true, true, fake_dispatch)
            .unwrap();
        assert_ne!(first["id"], distinct_fingerprint["id"]);
        {
            service.manager.lock().unwrap().state.skills[0]["remotePath"] =
                json!("other-association");
        }
        let association = service
            .start(request, None, None, true, true, fake_dispatch)
            .unwrap();
        assert_ne!(first["id"], association["id"]);
        assert_eq!(service.jobs.lock().unwrap().len(), 4);
        release(&latch);
        for task in [first, distinct, distinct_fingerprint, association] {
            let _ = service.wait(task["id"].as_str().unwrap());
        }
    }
    #[test]
    fn scheduler_waits_do_not_release_recorded_or_hidden_callers_compatibility_consumers() {
        for visible in [true, false] {
            let (_dir, service) = fixture();
            let (id, latch) = new_latch();
            let task = service
                .start(
                    json!({"action":"audit_skills","hold":id}),
                    None,
                    None,
                    false,
                    visible,
                    fake_dispatch,
                )
                .unwrap();
            entered(&latch);
            let task_id = task["id"].as_str().unwrap().to_owned();
            let scheduler = service.match_external_background(Some(task_id.clone()));
            // Dense consumers can still register independent reads while the
            // application scheduler waits for an existing audit.
            let other = service
                .start(
                    json!({"action":"get_files","skillId":"two"}),
                    None,
                    None,
                    true,
                    true,
                    fake_dispatch,
                )
                .unwrap();
            service.wait(other["id"].as_str().unwrap()).unwrap();
            release(&latch);
            scheduler.join().unwrap();
            assert_eq!(
                service
                    .jobs
                    .lock()
                    .unwrap()
                    .get(&task_id)
                    .unwrap()
                    .consumers,
                usize::from(!visible)
            );
            assert!(service.get(&task_id, true).is_ok());
            assert!(service.snapshot().is_ok());
            if !visible {
                service.release_compat(&task_id);
                assert!(!service.jobs.lock().unwrap().contains_key(&task_id));
            }
        }
    }
    #[test]
    fn automatic_match_attention_and_errors_are_partial_with_four_counts() {
        fn answer(_: &mut Manager, request: &Value) -> Result<Value, String> {
            Ok(request["answer"].clone())
        }
        let (_dir, service) = fixture();
        for field in ["needsSelection", "missing", "error"] {
            let mut summary = json!({"matched":1,"needsSelection":0,"missing":0,"error":0});
            summary[field] = json!(1);
            let task=service.start(json!({"action":"batch_external_dependencies","operation":"auto_match","skillId":"one","answer":{"autoMatchSummary":summary}}),None,None,true,true,answer).unwrap();
            let id = task["id"].as_str().unwrap();
            service.wait(id).unwrap();
            let task = service.get(id, true).unwrap();
            assert_eq!(task["status"], "partial");
            let stage = task["stage"].as_str().unwrap();
            for label in ["已匹配", "待选择", "缺失", "异常"] {
                assert!(stage.contains(label));
            }
        }
    }

    #[derive(Default)]
    struct LatchState {
        entered: bool,
        released: bool,
    }
    type Latch = Arc<(Mutex<LatchState>, Condvar)>;
    fn latches() -> &'static Mutex<HashMap<String, Latch>> {
        static LATCHES: OnceLock<Mutex<HashMap<String, Latch>>> = OnceLock::new();
        LATCHES.get_or_init(|| Mutex::new(HashMap::new()))
    }
    fn new_latch() -> (String, Latch) {
        let id = uuid::Uuid::new_v4().to_string();
        let latch = Arc::new((Mutex::new(LatchState::default()), Condvar::new()));
        latches().lock().unwrap().insert(id.clone(), latch.clone());
        (id, latch)
    }
    fn entered(latch: &Latch) {
        let limit = Instant::now() + Duration::from_secs(5);
        let mut state = latch.0.lock().unwrap();
        while !state.entered {
            assert!(Instant::now() < limit, "synthetic worker did not enter");
            state = latch
                .1
                .wait_timeout(state, Duration::from_millis(20))
                .unwrap()
                .0;
        }
    }
    fn release(latch: &Latch) {
        latch.0.lock().unwrap().released = true;
        latch.1.notify_all();
    }
    fn hold(id: &str) -> Result<(), String> {
        let latch = latches().lock().unwrap().get(id).unwrap().clone();
        let mut state = latch.0.lock().unwrap();
        state.entered = true;
        latch.1.notify_all();
        while !state.released {
            crate::network::check_cancelled()?;
            state = latch
                .1
                .wait_timeout(state, Duration::from_millis(20))
                .unwrap()
                .0;
        }
        Ok(())
    }
    fn fake_dispatch(manager: &mut Manager, request: &Value) -> Result<Value, String> {
        if management_task(request["action"].as_str().unwrap_or_default()) {
            if let Some(id) = request["beforeManagement"].as_str() {
                hold(id)?;
            }
            let result =
                crate::categories::handle(manager, request)?.ok_or("Unknown management action")?;
            if let Some(id) = request["afterManagement"].as_str() {
                hold(id)?;
            }
            return Ok(result);
        }
        if request["action"] == "set_settings" {
            return crate::dispatch(manager, request);
        }
        if let Some(id) = request["hold"].as_str() {
            hold(id)?;
        }
        if let Some(fields) = request["fields"].as_object() {
            let mut skill = manager.skill(text(request, "skillId")?)?;
            for (field, value) in fields {
                skill[field] = value.clone();
            }
            manager.upsert_skill(skill);
            manager.save()?;
        }
        if let Some(id) = request["preview"].as_str() {
            manager.previews.clear();
            manager.previews.insert(id.into(),json!({"public":{"id":id,"skillId":request["skillId"],"kind":"update","canApply":true},"repo":"synthetic/repo","branch":"main"}));
            return Ok(
                json!({"id":id,"kind":"update","skillId":request["skillId"],"canApply":true}),
            );
        }
        if let Some(id) = request["previewId"].as_str() {
            manager
                .previews
                .remove(id)
                .ok_or("Preview already consumed")?;
            if request["fail"] == true {
                return Err("Synthetic apply failed".into());
            }
        }
        if let Some(id) = request["afterSave"].as_str() {
            hold(id)?;
        }
        if request["fail"] == true {
            return Err(request["error"]
                .as_str()
                .unwrap_or("Synthetic failure")
                .into());
        }
        report_progress("已读取测试数据", Some(1), Some(1));
        Ok(manager.snapshot())
    }
    fn fixture() -> (tempfile::TempDir, Arc<TaskSystem>) {
        let parent = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("work/tasks-tests");
        std::fs::create_dir_all(&parent).unwrap();
        let dir = tempfile::tempdir_in(parent).unwrap();
        let mut manager = Manager::new(dir.path().into()).unwrap();
        manager.state.skills = vec![
            json!({"id":"one","name":"one","repo":"synthetic/repo","branch":"main","favorite":false,"runtimeFiles":["SKILL.md"],"status":"local_only"}),
            json!({"id":"two","name":"two","repo":"synthetic/repo","branch":"main","favorite":false,"runtimeFiles":["SKILL.md"]}),
            json!({"id":"three","name":"three","repo":"synthetic/repo","branch":"other","runtimeFiles":["SKILL.md"]}),
        ];
        manager.save().unwrap();
        (dir, TaskSystem::new(manager).unwrap())
    }
    fn start(service: &Arc<TaskSystem>, request: Value) -> String {
        service
            .start(
                request,
                Some("测试操作"),
                Some(&json!({"view":"skills","tab":"files"})),
                true,
                true,
                fake_dispatch,
            )
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .into()
    }
    fn task_status(service: &TaskSystem, id: &str, status: &str) {
        let limit = Instant::now() + Duration::from_secs(5);
        loop {
            if service.get(id, false).unwrap()["status"] == status {
                return;
            }
            assert!(
                Instant::now() < limit,
                "expected task status {status}: {:?}",
                service.get(id, true)
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn result_file_indices_survive_restart_without_replaying_tasks_or_storing_file_contents() {
        fn export_fixture(_: &mut Manager, request: &Value) -> Result<Value, String> {
            let path = text(request, "destination")?;
            std::fs::write(path, "synthetic output bytes").map_err(|error| error.to_string())?;
            Ok(json!({"path":path}))
        }
        let (dir, service) = fixture();
        let destination = dir.path().join("output.zip");
        let task = service
            .start(
                json!({"action":"export","skillId":"one","destination":destination}),
                Some("export"),
                None,
                true,
                true,
                export_fixture,
            )
            .unwrap();
        let id = task["id"].as_str().unwrap();
        service.wait(id).unwrap();
        let saved = service.get(id, false).unwrap();
        assert_eq!(saved["resultFiles"].as_array().unwrap().len(), 1);
        assert!(!saved.to_string().contains("synthetic output bytes"));
        drop(service);
        let reopened = TaskSystem::new(Manager::new(dir.path().into()).unwrap()).unwrap();
        let restored = reopened.get(id, true).unwrap();
        assert_eq!(restored["resultFiles"], saved["resultFiles"]);
        assert_eq!(restored["resultExpired"], true);
        assert!(restored["result"].is_null());
        let count = reopened.list().unwrap().len();
        let current = reopened
            .execute(
                json!({"action":"task_result_files","taskId":id}),
                crate::dispatch,
            )
            .unwrap();
        assert_eq!(current["files"][0]["status"], "available");
        std::fs::remove_file(&destination).unwrap();
        let current = reopened
            .execute(
                json!({"action":"task_result_files","taskId":id}),
                crate::dispatch,
            )
            .unwrap();
        assert_eq!(current["files"][0]["status"], "unavailable");
        assert_eq!(current["files"][0]["canOpenFolder"], true);
        assert_eq!(reopened.list().unwrap().len(), count);
        assert!(!destination.exists());
        assert!(reopened
            .execute(
                json!({"action":"task_open_result","taskId":id,"resultId":"forged","folder":true}),
                crate::dispatch
            )
            .is_err());
        assert!(reopened
            .start(
                json!({"action":"task_result_files","taskId":id}),
                None,
                None,
                true,
                false,
                crate::dispatch
            )
            .is_err());
    }

    #[test]
    fn skill_removal_locks_all_approved_client_entries_and_shared_metadata() {
        let (_dir, service) = fixture();
        let mut manager = service.manager.lock().unwrap();
        manager.state.skills[0]["localPath"] = json!("D:/synthetic/skill");
        manager.state.connections = vec![
            json!({"id":"link","skillId":"one","client":"codex","path":"D:/synthetic/client/one"}),
        ];
        manager.previews.insert("skill-remove".into(), json!({"kind":"skillRemove","skillId":"one","public":{"skillId":"one"},"targetPath":"D:/synthetic/skill"}));
        let locks = resources_for(
            &manager,
            &json!({"action":"apply_skill_remove","previewId":"skill-remove"}),
        )
        .unwrap();
        for name in [
            "skill:one",
            "client:codex",
            "entry:d:/synthetic/client/one",
            "directory:d:/synthetic/skill",
        ] {
            let normalized = name.replace('/', "\\");
            assert!(
                locks
                    .iter()
                    .any(|item| item.write && (item.key == name || item.key == normalized)),
                "{name}: {locks:?}"
            );
        }
        assert!(locks
            .iter()
            .any(|item| item.key == "resource-catalog" && !item.write));
        assert!(locks
            .iter()
            .any(|item| item.key == "local:discovery" && !item.write));
        assert!(crate::dispatch(
            &mut manager,
            &json!({"action":"apply_skill_remove","previewId":"skill-remove","confirmed":true})
        )
        .is_err());
        assert!(manager.previews.contains_key("skill-remove"));
        assert_eq!(manager.state.connections.len(), 1);
    }
    #[test]
    fn resource_removal_and_repair_exclude_new_invocations_but_not_stop() {
        let (_dir, service) = fixture();
        let mut manager = service.manager.lock().unwrap();
        manager.previews.insert(
            "remove-plan".into(),
            json!({"kind":"resourceRemove","resourceId":"tool","targetPath":"D:/synthetic/tool"}),
        );
        let remove = resources_for(
            &manager,
            &json!({"action":"apply_resource_remove","previewId":"remove-plan"}),
        )
        .unwrap();
        let invoke = resources_for(
            &manager,
            &json!({"action":"resource_invoke","id":"tool","actionId":"read"}),
        )
        .unwrap();
        let stop = resources_for(
            &manager,
            &json!({"action":"resource_stop","runId":"owned-run"}),
        )
        .unwrap();
        let catalog =
            resources_for(&manager, &json!({"action":"resource_update","id":"tool"})).unwrap();
        assert!(conflicts(&remove, &invoke));
        assert!(conflicts(&remove, &catalog));
        assert!(!conflicts(&invoke, &stop));
        assert!(!conflicts(&remove, &stop));
        manager.previews.insert(
            "repair-plan".into(),
            json!({"kind":"resourceRepair","resourceId":"tool","targetPath":"D:/synthetic/tool","archivePath":"D:/synthetic/original.zip"}),
        );
        let repair = resources_for(
            &manager,
            &json!({"action":"apply_resource_repair","previewId":"repair-plan"}),
        )
        .unwrap();
        assert!(conflicts(&repair, &invoke));
        assert!(conflicts(&repair, &catalog));
        assert!(conflicts(&repair, &remove));
        assert!(!conflicts(&repair, &stop));
        assert!(repair.iter().any(|entry| entry.key
            == format!("archive:{}", path_key("D:/synthetic/original.zip"))
            && !entry.write));
        assert!(repair.iter().any(|entry| entry.key
            == format!("directory:{}", path_key("D:/synthetic/tool"))
            && entry.write));
        assert!(!read_request(&json!({"action":"apply_resource_install"})));
        assert!(!read_request(&json!({"action":"apply_resource_remove"})));
        assert!(!read_request(&json!({"action":"apply_resource_repair"})));
    }

    #[test]
    fn resource_relocation_locks_both_directories_and_excludes_catalog_edits_and_invocations() {
        let (dir, service) = fixture();
        let mut manager = service.manager.lock().unwrap();
        let root = dir.path().join("registered-tool");
        std::fs::create_dir_all(&root).unwrap();
        let record = crate::resources::handle(
            &manager,
            &json!({"action":"resource_register","name":"Tool","kind":"cli","rootPath":root}),
        )
        .unwrap()
        .unwrap()["resource"]
            .clone();
        let id = record["id"].as_str().unwrap();
        let next = dir.path().join("new-tool");
        manager.previews.insert(
            "relocate".into(),
            json!({"kind":"resourceRelocation","resourceId":id,"targetPath":next}),
        );
        let preview = resources_for(
            &manager,
            &json!({"action":"preview_resource_relocate","id":id,"rootPath":next}),
        )
        .unwrap();
        let apply = resources_for(
            &manager,
            &json!({"action":"apply_resource_relocate","previewId":"relocate"}),
        )
        .unwrap();
        let invoke = resources_for(
            &manager,
            &json!({"action":"resource_invoke","id":id,"actionId":"read"}),
        )
        .unwrap();
        let other = resources_for(
            &manager,
            &json!({"action":"resource_invoke","id":"other","actionId":"read"}),
        )
        .unwrap();
        let edit = resources_for(&manager, &json!({"action":"resource_update","id":id})).unwrap();
        let stop =
            resources_for(&manager, &json!({"action":"resource_stop","runId":"owned"})).unwrap();
        assert!(conflicts(&apply, &preview));
        assert!(conflicts(&apply, &invoke));
        assert!(conflicts(&apply, &edit));
        assert!(!conflicts(&apply, &other));
        assert!(!conflicts(&apply, &stop));
        for path in [root.as_path(), next.as_path()] {
            assert!(apply
                .iter()
                .any(|r| r.write
                    && r.key == format!("directory:{}", path_key(path.to_str().unwrap()))));
        }
        assert!(read_request(&json!({"action":"preview_resource_relocate"})));
        assert!(!read_request(&json!({"action":"apply_resource_relocate"})));
    }

    #[test]
    fn download_writes_are_exclusive_without_blocking_unrelated_resources() {
        let (_dir, service) = fixture();
        let mut manager = service.manager.lock().unwrap();
        for (id, path) in [
            ("one", "D:/synthetic/package.zip"),
            ("same", "D:/synthetic/package.zip"),
            ("other", "D:/synthetic/other.zip"),
        ] {
            manager.previews.insert(id.into(), json!({"kind":"resourceDownload","targetPath":path,"partialPath":format!("{path}.part")}));
        }
        let request = json!({"action":"apply_resource_download","previewId":"one"});
        assert!(!read_request(&request));
        let download = resources_for(&manager, &request).unwrap();
        let same = resources_for(
            &manager,
            &json!({"action":"apply_resource_download","previewId":"same"}),
        )
        .unwrap();
        let other = resources_for(
            &manager,
            &json!({"action":"apply_resource_download","previewId":"other"}),
        )
        .unwrap();
        let inspect = resources_for(
            &manager,
            &json!({"action":"resource_package_inspect","archivePath":"D:/synthetic/package.zip"}),
        )
        .unwrap();
        let metadata = resources_for(&manager, &json!({"action":"resource_github_releases","repository":"https://github.com/example/tool"})).unwrap();
        assert!(conflicts(&download, &same));
        assert!(conflicts(&download, &inspect));
        assert!(!conflicts(&download, &other));
        assert!(!conflicts(&download, &metadata));
        assert!(read_request(&json!({"action":"resource_github_releases"})));
    }

    #[test]
    fn package_phases_lock_their_selected_locations_and_require_native_confirmation() {
        let (_dir, service) = fixture();
        let mut manager = service.manager.lock().unwrap();
        manager.previews.insert("package-step".into(), json!({
            "kind":"resourcePackageDownload", "prepared":{"sessionId":"synthetic-session"},
            "public":{"workingDirectory":"D:/synthetic/work","downloadDirectory":"D:/synthetic/download","targetPath":"D:/synthetic/runtime"}
        }));
        for action in [
            "apply_resource_package_prepare",
            "apply_resource_package_download",
            "apply_resource_package_resume",
            "apply_resource_package_materialize",
            "apply_resource_package_commit",
        ] {
            let request = json!({"action":action,"previewId":"package-step"});
            assert!(!read_request(&request));
            let locks = resources_for(&manager, &request).unwrap();
            let catalog_edit =
                resources_for(&manager, &json!({"action":"resource_register"})).unwrap();
            assert_eq!(
                conflicts(&locks, &catalog_edit),
                action == "apply_resource_package_commit",
                "Only the final package registration takes the catalogue write lock."
            );
            for path in [
                "D:/synthetic/work",
                "D:/synthetic/download",
                "D:/synthetic/runtime",
            ] {
                assert!(
                    locks
                        .iter()
                        .any(|lock| lock.write
                            && lock.key == format!("directory:{}", path_key(path))),
                    "{action}: {path}"
                );
            }
            assert!(crate::dispatch(&mut manager, &request).is_err());
            assert!(
                manager.previews.contains_key("package-step"),
                "An agent route cannot consume the native confirmation."
            );
        }
        assert!(read_request(&json!({"action":"resource_package_sessions"})));
        manager.basic_mode = true;
        assert!(manager
            .ensure_request_allowed(&json!({"action":"resource_package_sessions"}))
            .is_ok());
        assert!(manager
            .ensure_request_allowed(&json!({"action":"apply_resource_package_download"}))
            .is_err());
    }

    #[test]
    fn resource_repair_preview_locks_the_recorded_archive_when_path_is_omitted() {
        let (dir, service) = fixture();
        let manager = service.manager.lock().unwrap();
        let archive = dir.path().join("original.zip");
        std::fs::write(&archive, b"synthetic lock fixture").unwrap();
        let registered = crate::resources::handle(&manager, &json!({
            "action":"resource_register","name":"Repair fixture","kind":"portable","rootPath":dir.path()
        })).unwrap().unwrap();
        let mut record: crate::resources::ResourceRecord =
            serde_json::from_value(registered["resource"].clone()).unwrap();
        record.installation = Some(crate::resource_lifecycle::InstallationRecord {
            schema_version: 1,
            installed_at: now(),
            archive_path: archive.to_string_lossy().into_owned(),
            archive_sha256: "synthetic lock identity".into(),
            runtime_package: None,
            source_repository: None,
            source_version: None,
            download_source: None,
            files: vec![],
            status: "installed".into(),
            error: None,
            pending_repair: None,
            retained_repair_files: vec![],
            update_state: None,
            system_entries: vec![],
            removal_state: None,
            resource_manifest: None,
        });
        record.revision += 1;
        manager
            .resource_store(crate::resources::StoreRequest::Replace {
                record: Box::new(record.clone()),
                expected_revision: 1,
            })
            .unwrap();
        let expected = format!("archive:{}", path_key(archive.to_str().unwrap()));
        for archive_input in [Value::Null, json!("  "), json!(archive.to_string_lossy())] {
            let preview = resources_for(&manager, &json!({"action":"preview_resource_repair","id":record.id,"expectedRevision":2,"archivePath":archive_input})).unwrap();
            assert!(preview
                .iter()
                .any(|entry| entry.key == expected && !entry.write));
            assert!(conflicts(
                &preview,
                &[Resource {
                    key: expected.clone(),
                    write: true
                }]
            ));
        }
    }

    #[test]
    fn download_path_lock_survives_file_creation_and_canonicalization() {
        let (dir, service) = fixture();
        let archive = dir.path().join("new-download.zip");
        let partial = dir.path().join("new-download.zip.part");
        let raw = archive.to_string_lossy().to_string();
        let before = path_key(&raw);
        let mut manager = service.manager.lock().unwrap();
        manager.previews.insert(
            "download".into(),
            json!({"kind":"resourceDownload","targetPath":archive,"partialPath":partial}),
        );
        let download = resources_for(
            &manager,
            &json!({"action":"apply_resource_download","previewId":"download"}),
        )
        .unwrap();
        std::fs::write(&archive, b"new file with the same path").unwrap();
        assert_eq!(before, path_key(&raw));
        let canonical = std::fs::canonicalize(&archive).unwrap();
        assert_eq!(before, path_key(&canonical.to_string_lossy()));
        let inspect = resources_for(
            &manager,
            &json!({"action":"resource_package_inspect","archivePath":canonical}),
        )
        .unwrap();
        assert!(conflicts(&download, &inspect));
    }

    #[test]
    fn cancelled_download_keeps_partial_progress_and_never_publishes_final_file() {
        fn download(manager: &mut Manager, request: &Value) -> Result<Value, String> {
            use sha2::Digest;
            let partial = manager.data_dir.join("received.zip.part");
            std::fs::write(&partial, b"received bytes").map_err(|e| e.to_string())?;
            let download_id = request["downloadId"].as_str().unwrap();
            let mut record = json!({
                "schemaVersion":1,"id":download_id,"status":"downloading",
                "prepared":{"downloadId":download_id,"repo":"example/tool","releaseId":1,"tag":"v1","author":"example",
                    "asset":{"id":2,"name":"tool.zip","size":64,"digest":null,"url":"https://github.com/example/tool/releases/download/v1/tool.zip","updatedAt":"fixed"},
                    "target":manager.data_dir.join("received.zip"),"partial":partial,"rate":0,
                    "progress":{"bytes":14,"sha256":format!("{:x}",sha2::Sha256::digest(b"received bytes")),"etag":"\"fixed\""}},
                "source":null,"fingerprint":null,"updatedAt":crate::model::now(),"error":null
            });
            manager.download_store(crate::resource_github::DownloadStore::Save {
                id: download_id.into(),
                record: record.clone(),
            })?;
            manager.previews.insert(
                "download-progress".into(),
                json!({"kind":"resourceDownload","partialPath":partial,"receivedBytes":14}),
            );
            if let Err(error) = hold(request["hold"].as_str().unwrap()) {
                record["status"] = json!("interrupted");
                manager.download_store(crate::resource_github::DownloadStore::Save {
                    id: download_id.into(),
                    record,
                })?;
                return Err(error);
            }
            panic!("cancelled transfer must not reach publication");
        }
        let (dir, service) = fixture();
        let (hold_id, latch) = new_latch();
        let download_id = uuid::Uuid::new_v4().to_string();
        let before = service.snapshot().unwrap();
        let task = service
            .start(
                json!({"action":"apply_resource_download","hold":hold_id,"downloadId":download_id}),
                None,
                None,
                true,
                true,
                download,
            )
            .unwrap();
        let id = task["id"].as_str().unwrap();
        entered(&latch);
        let observed = service
            .execute(json!({"action":"resource_downloads"}), crate::dispatch)
            .unwrap();
        assert_eq!(observed["downloads"][0]["status"], "downloading");
        assert_eq!(service.get(id, false).unwrap()["cancellable"], true);
        service.cancel(id).unwrap();
        assert!(service.wait(id).is_err());
        task_status(&service, id, "cancelled");
        assert_eq!(
            std::fs::read(dir.path().join("received.zip.part")).unwrap(),
            b"received bytes"
        );
        assert!(!dir.path().join("received.zip").exists());
        assert_eq!(
            service.manager.lock().unwrap().previews["download-progress"]["receivedBytes"],
            14
        );
        let after = service.snapshot().unwrap();
        assert_eq!(after["stateRevision"], before["stateRevision"]);
        assert_eq!(after["skills"], before["skills"]);
        drop(service);
        let restarted = Manager::new(dir.path().into()).unwrap();
        let record = restarted
            .download_store(crate::resource_github::DownloadStore::Get(download_id))
            .unwrap();
        assert_eq!(record["status"], "interrupted");
        assert_eq!(record["prepared"]["progress"]["bytes"], 14);
        assert!(!dir.path().join("received.zip").exists());
    }

    #[test]
    fn download_completed_receipt_survives_a_late_cancel_request() {
        fn download(manager: &mut Manager, request: &Value) -> Result<Value, String> {
            crate::network::check_cancelled()?;
            let archive = manager.data_dir.join("completed.zip");
            std::fs::write(&archive, b"verified download").map_err(|e| e.to_string())?;
            let receipt = json!({"complete":true,"archivePath":archive,"downloadId":"receipt"});
            manager.previews.insert(
                "receipt".into(),
                json!({"kind":"resourceDownloadReceipt","archivePath":archive}),
            );
            // The transfer already committed. Keep its result while the test
            // injects cancellation before the task service receives that result.
            let latch = latches()
                .lock()
                .unwrap()
                .get(request["hold"].as_str().unwrap())
                .unwrap()
                .clone();
            let mut state = latch.0.lock().unwrap();
            state.entered = true;
            latch.1.notify_all();
            while !state.released {
                state = latch
                    .1
                    .wait_timeout(state, Duration::from_secs(5))
                    .unwrap()
                    .0;
            }
            Ok(receipt)
        }
        let (dir, service) = fixture();
        let (hold_id, latch) = new_latch();
        let task = service
            .start(
                json!({"action":"apply_resource_download","hold":hold_id}),
                None,
                None,
                true,
                true,
                download,
            )
            .unwrap();
        let id = task["id"].as_str().unwrap();
        entered(&latch);
        service.cancel(id).unwrap();
        release(&latch);
        let result = service.wait(id).unwrap();
        task_status(&service, id, "succeeded");
        assert_eq!(result["downloadId"], "receipt");
        assert_eq!(
            std::fs::read(dir.path().join("completed.zip")).unwrap(),
            b"verified download"
        );
        assert!(service
            .manager
            .lock()
            .unwrap()
            .previews
            .contains_key("receipt"));
    }

    #[test]
    fn incomplete_resource_lifecycle_keeps_receipt_but_records_partial() {
        fn incomplete(_: &mut Manager, _: &Value) -> Result<Value, String> {
            Ok(
                json!({"complete":false,"ownershipSaved":false,"receipt":{"complete":false,"error":"synthetic write failure"}}),
            )
        }
        let (dir, service) = fixture();
        for action in [
            "apply_resource_install",
            "apply_resource_remove",
            "apply_resource_repair",
        ] {
            let started = service
                .start(json!({"action":action}), None, None, true, true, incomplete)
                .unwrap();
            let id = started["id"].as_str().unwrap();
            let result = service.wait(id).unwrap();
            assert_eq!(result["complete"], false);
            let task = service.get(id, true).unwrap();
            assert_eq!(task["status"], "partial");
            assert_eq!(
                task["result"]["receipt"]["error"],
                "synthetic write failure"
            );
            let db = rusqlite::Connection::open(dir.path().join("manager.sqlite3")).unwrap();
            let payload: String = db
                .query_row("SELECT payload FROM task_history WHERE id=?1", [id], |r| {
                    r.get(0)
                })
                .unwrap();
            let saved: Value = serde_json::from_str(&payload).unwrap();
            assert_eq!(saved["status"], "partial");
            assert!(saved.get("result").is_none());
        }
    }

    #[test]
    fn independent_reads_and_management_do_not_wait_for_long_io_or_overwrite_each_other() {
        let (_dir, service) = fixture();
        let (hold_id, latch) = new_latch();
        let a = start(
            &service,
            json!({"action":"audit_skills","skillId":"one","hold":hold_id,"fields":{"status":"synced"}}),
        );
        entered(&latch);
        let began = Instant::now();
        let b = start(&service, json!({"action":"read_file","skillId":"two"}));
        service.wait(&b).unwrap();
        let favorite = start(
            &service,
            json!({"action":"set_favorite","skillId":"one","favorite":true}),
        );
        service.wait(&favorite).unwrap();
        let settings = start(
            &service,
            json!({"action":"set_settings","settings":{"uiZoom":125}}),
        );
        service.wait(&settings).unwrap();
        assert!(began.elapsed() < Duration::from_secs(2));
        let state = service.snapshot().unwrap();
        assert_eq!(state["skills"][0]["favorite"], true);
        assert_eq!(state["settings"]["uiZoom"], 125);
        release(&latch);
        let final_state = service.wait(&a).unwrap();
        assert_eq!(final_state["skills"][0]["favorite"], true);
        assert_eq!(final_state["skills"][0]["status"], "synced");
        assert_eq!(final_state["settings"]["uiZoom"], 125);
        assert_eq!(final_state["managementUndo"]["available"], true);
    }

    #[test]
    fn one_skill_writes_queue_while_an_independent_skill_finishes() {
        let (_dir, service) = fixture();
        let (hold_id, latch) = new_latch();
        let a = start(
            &service,
            json!({"action":"apply_update","skillId":"one","hold":hold_id,"fields":{"version":"a"}}),
        );
        entered(&latch);
        let b = start(
            &service,
            json!({"action":"apply_update","skillId":"one","fields":{"version":"b"}}),
        );
        let c = start(
            &service,
            json!({"action":"apply_update","skillId":"two","fields":{"version":"c"}}),
        );
        service.wait(&c).unwrap();
        assert_eq!(service.get(&b, false).unwrap()["status"], "queued");
        assert!(service.cancel(&a).is_err());
        release(&latch);
        service.wait(&a).unwrap();
        service.wait(&b).unwrap();
        let state = service.snapshot().unwrap();
        assert_eq!(state["skills"][0]["version"], "b");
        assert_eq!(state["skills"][1]["version"], "c");
    }

    #[test]
    fn same_repository_branch_uploads_queue_but_other_branch_does_not() {
        let (_dir, service) = fixture();
        let (hold_id, latch) = new_latch();
        let a = start(
            &service,
            json!({"action":"apply_push","skillId":"one","hold":hold_id}),
        );
        entered(&latch);
        let b = start(&service, json!({"action":"apply_push","skillId":"two"}));
        let c = start(&service, json!({"action":"apply_push","skillId":"three"}));
        service.wait(&c).unwrap();
        assert_eq!(service.get(&b, false).unwrap()["status"], "queued");
        release(&latch);
        service.wait(&a).unwrap();
        service.wait(&b).unwrap();
    }

    #[test]
    fn cancelled_queued_write_never_dispatches_and_running_read_stops_cooperatively() {
        let (_dir, service) = fixture();
        let (hold_id, latch) = new_latch();
        let a = start(
            &service,
            json!({"action":"apply_update","skillId":"one","hold":hold_id}),
        );
        entered(&latch);
        let b = start(
            &service,
            json!({"action":"apply_update","skillId":"one","fields":{"version":"must-not-write"}}),
        );
        service.cancel(&b).unwrap();
        assert!(service.wait(&b).is_err());
        task_status(&service, &b, "cancelled");
        release(&latch);
        service.wait(&a).unwrap();
        assert!(service.snapshot().unwrap()["skills"][0]["version"].is_null());
        let (read_hold, read_latch) = new_latch();
        let read = start(
            &service,
            json!({"action":"read_file","skillId":"two","hold":read_hold}),
        );
        entered(&read_latch);
        service.cancel(&read).unwrap();
        assert!(service.wait(&read).is_err());
        task_status(&service, &read, "cancelled");
    }

    #[test]
    fn save_acknowledgement_is_already_durable_before_worker_continues() {
        let (dir, service) = fixture();
        let (hold_id, latch) = new_latch();
        let task = start(
            &service,
            json!({"action":"apply_update","skillId":"one","fields":{"version":"durable"},"afterSave":hold_id}),
        );
        entered(&latch);
        let independently_read = Manager::new(dir.path().into()).unwrap();
        assert_eq!(independently_read.state.skills[0]["version"], "durable");
        assert!(
            independently_read.snapshot()["stateRevision"]
                .as_u64()
                .unwrap()
                > 1
        );
        release(&latch);
        service.wait(&task).unwrap();
    }

    #[test]
    fn conflicting_binding_or_runtime_scope_rejects_stale_derived_results() {
        let (_dir, service) = fixture();
        let (hold_id, latch) = new_latch();
        let task = start(
            &service,
            json!({"action":"audit_skills","skillId":"one","hold":hold_id,"fields":{"status":"synced"}}),
        );
        entered(&latch);
        {
            let mut manager = service.manager.lock().unwrap();
            manager.state.skills[0]["externalBindings"] = json!({"new":"binding"});
            manager.save().unwrap();
        }
        release(&latch);
        assert!(service
            .wait(&task)
            .unwrap_err()
            .contains("externalBindings"));
        let state = service.snapshot().unwrap();
        assert_eq!(state["skills"][0]["status"], "local_only");
        assert_eq!(state["skills"][0]["externalBindings"]["new"], "binding");
    }

    fn document_fixture_with_large_preview() -> (tempfile::TempDir, Arc<TaskSystem>, String) {
        let (dir, service) = fixture();
        let root = dir.path().join("local-document");
        std::fs::create_dir(&root).unwrap();
        let markdown = format!(
            "# Local document\n\n{}",
            "Complete local content.\n".repeat(80)
        );
        std::fs::write(root.join("SKILL.md"), &markdown).unwrap();
        std::fs::write(dir.path().join("outside.md"), "Outside the registered root").unwrap();
        let files: Vec<_> = (0..4098)
            .map(|index| {
                json!({"path":format!("data/payload-{index:05}.bin"),"bytes":4096,"license":false})
            })
            .collect();
        let selected: Vec<_> = files.iter().map(|file| file["path"].clone()).collect();
        let roles: Map<_, _> = files
            .iter()
            .map(|file| (file["path"].as_str().unwrap().to_owned(), json!("runtime")))
            .collect();
        let changes: Vec<_> = files
            .iter()
            .map(|file| json!({"path":file["path"],"upstreamChanged":true}))
            .collect();
        {
            let mut manager = service.manager.lock().unwrap();
            manager.state.skills[0]["localPath"] = json!(crate::local::canonical(&root).unwrap());
            manager.state.skills[0]["repo"] = Value::Null;
            manager.state.skills[0]["branch"] = Value::Null;
            manager.previews.insert(
                "unrelated-update".into(),
                json!({
                    "kind":"resourceUpdateStage","resourceId":"unrelated-tool",
                    "createdAt":chrono::Utc::now().timestamp_millis(),
                    "prepared":{"inventory":{"files":files},"selected":selected,"roles":roles},
                    "public":{"files":roles,"changes":changes}
                }),
            );
            manager.save().unwrap();
        }
        (dir, service, markdown)
    }

    fn document_dispatch_without_previews(
        manager: &mut Manager,
        request: &Value,
    ) -> Result<Value, String> {
        assert_eq!(request["action"], "get_document");
        assert!(
            manager.previews.is_empty(),
            "document worker copied unrelated approvals"
        );
        if let Some(id) = request["hold"].as_str() {
            hold(id)?;
        }
        crate::dispatch_local(manager, request)
    }

    #[test]
    fn document_read_with_large_unrelated_preview_preserves_content_and_boundaries() {
        use sha2::Digest;

        let (_dir, service, markdown) = document_fixture_with_large_preview();
        let before = service.snapshot().unwrap();
        let previews = service.manager.lock().unwrap().previews.clone();
        let result = service
            .execute(
                json!({"action":"get_document","skillId":"one","previewId":"unrelated-update"}),
                document_dispatch_without_previews,
            )
            .unwrap();
        assert_eq!(result["markdown"], markdown);
        assert_eq!(result["source"], "本地运行文件");
        assert_eq!(result["documentPath"], "SKILL.md");
        assert_eq!(
            result["localFingerprint"],
            format!("{:x}", sha2::Sha256::digest(markdown.as_bytes()))
        );
        assert!(result["readGeneration"].is_u64());
        for path in ["../outside.md", "missing.md"] {
            assert!(service
                .execute(
                    json!({"action":"get_document","skillId":"one","path":path}),
                    document_dispatch_without_previews,
                )
                .is_err());
        }
        assert_eq!(service.manager.lock().unwrap().previews, previews);
        assert_eq!(service.snapshot().unwrap(), before);
        assert!(service.list().unwrap().is_empty());
    }

    #[test]
    fn document_read_does_not_resurrect_consumed_previews_or_replace_new_previews() {
        let (_dir, service, markdown) = document_fixture_with_large_preview();
        let first = start(
            &service,
            json!({"action":"preview_update","skillId":"two","preview":"old-preview"}),
        );
        service.wait(&first).unwrap();
        let (hold_id, latch) = new_latch();
        let read = service
            .start(
                json!({"action":"get_document","skillId":"one","hold":hold_id}),
                None,
                None,
                true,
                true,
                document_dispatch_without_previews,
            )
            .unwrap();
        entered(&latch);
        let consumed = start(
            &service,
            json!({"action":"apply_update","previewId":"old-preview","fail":true}),
        );
        assert!(service.wait(&consumed).is_err());
        let created = start(
            &service,
            json!({"action":"preview_update","skillId":"three","preview":"new-preview"}),
        );
        service.wait(&created).unwrap();
        let current = service.manager.lock().unwrap().previews.clone();
        assert!(!current.contains_key("old-preview"));
        assert!(current.contains_key("new-preview"));
        assert_eq!(
            current["unrelated-update"]["prepared"]["inventory"]["files"]
                .as_array()
                .unwrap()
                .len(),
            4098
        );
        release(&latch);
        let result = service.wait(read["id"].as_str().unwrap()).unwrap();
        assert_eq!(result["markdown"], markdown);
        assert_eq!(service.manager.lock().unwrap().previews, current);
    }

    #[test]
    fn local_document_read_does_not_trim_unrelated_previews() {
        let (_dir, service, markdown) = document_fixture_with_large_preview();
        let before = {
            let mut manager = service.manager.lock().unwrap();
            for index in 0..33 {
                manager.previews.insert(
                    format!("export-{index}"),
                    json!({"kind":"export_plan","createdAt":index}),
                );
            }
            manager.previews.clone()
        };
        let result = service
            .execute(
                json!({"action":"get_document","skillId":"one"}),
                crate::dispatch_local,
            )
            .unwrap();
        assert_eq!(result["markdown"], markdown);
        assert!(result["readGeneration"].is_u64());
        let outside = service.execute(
            json!({"action":"get_document","skillId":"one","path":"../outside.md"}),
            crate::dispatch_local,
        );
        assert!(outside.is_err());
        let missing_skill = service.execute(
            json!({"action":"get_document","skillId":"missing"}),
            crate::dispatch_local,
        );
        assert_eq!(missing_skill.unwrap_err(), "Skill no longer exists");
        {
            let mut manager = service.manager.lock().unwrap();
            manager.state.skills[0]["sourceId"] = json!("linked");
            let latest = json!({"action":"get_document","skillId":"one","version":"latest"});
            assert!(crate::remote::local_document_skill(&manager, &latest).is_none());
        }
        let linked_local = service
            .execute(
                json!({"action":"get_document","skillId":"one","origin":"local"}),
                crate::dispatch_local,
            )
            .unwrap();
        assert_eq!(linked_local["markdown"], markdown);
        assert_eq!(linked_local["source"], "本地运行文件");
        assert_eq!(service.manager.lock().unwrap().previews, before);
        assert!(service.list().unwrap().is_empty());
    }

    #[test]
    fn concurrent_previews_are_retained_and_consumption_is_single_use_even_on_failure() {
        let (_dir, service) = fixture();
        let a = start(
            &service,
            json!({"action":"preview_update","skillId":"one","preview":"preview-one"}),
        );
        service.wait(&a).unwrap();
        let b = start(
            &service,
            json!({"action":"preview_update","skillId":"two","preview":"preview-two"}),
        );
        service.wait(&b).unwrap();
        assert_eq!(service.manager.lock().unwrap().previews.len(), 2);
        let apply = start(
            &service,
            json!({"action":"apply_update","previewId":"preview-one","fail":true}),
        );
        assert!(service.wait(&apply).is_err());
        let manager = service.manager.lock().unwrap();
        assert!(!manager.previews.contains_key("preview-one"));
        assert!(manager.previews.contains_key("preview-two"));
    }

    #[test]
    fn late_read_worker_does_not_resurrect_evicted_skill_or_source_previews() {
        let (_dir, service) = fixture();
        {
            let mut manager = service.manager.lock().unwrap();
            manager.previews.insert(
                "old-skill".into(),
                json!({"kind":"skillRemove","createdAt":0,"prepared":{"disconnects":[{"previewId":"old-skill-disconnect"}]}}),
            );
            manager.previews.insert(
                "old-skill-disconnect".into(),
                json!({"kind":"disconnect","skillRemovalPreviewId":"old-skill"}),
            );
            manager.previews.insert(
                "consumed-skill-disconnect".into(),
                json!({"kind":"disconnect","skillRemovalPreviewId":"consumed-skill"}),
            );
            manager.previews.insert(
                "independent-disconnect".into(),
                json!({"kind":"disconnect","createdAt":0,"keep":true}),
            );
            manager.previews.insert(
                "old-source".into(),
                json!({"kind":"resourceSource","createdAt":0}),
            );
            manager.previews.insert(
                "unrelated-preview".into(),
                json!({"kind":"unrelated","createdAt":0,"keep":true}),
            );
        }
        let (hold_id, latch) = new_latch();
        let read = start(
            &service,
            json!({"action":"read_file","skillId":"one","hold":hold_id}),
        );
        entered(&latch);
        let retained = {
            let mut manager = service.manager.lock().unwrap();
            for index in 0..40 {
                let kind = if index % 2 == 0 {
                    "skillRemove"
                } else {
                    "resourceSource"
                };
                let parent_id = format!("new-preview-{index:02}");
                let child_id = format!("new-disconnect-{index:02}");
                let mut preview = json!({"kind":kind,"createdAt":index + 1});
                if kind == "skillRemove" {
                    preview["prepared"] = json!({"disconnects":[{"previewId":child_id}]});
                    manager.previews.insert(
                        child_id,
                        json!({"kind":"disconnect","skillRemovalPreviewId":parent_id}),
                    );
                }
                manager.previews.insert(parent_id, preview);
            }
            crate::resource_lifecycle::trim_previews(&mut manager.previews);
            manager.previews.clone()
        };
        release(&latch);
        service.wait(&read).unwrap();
        assert_eq!(retained.len(), 32 + 16 + 2);
        assert!(!retained.contains_key("old-skill"));
        assert!(!retained.contains_key("old-skill-disconnect"));
        assert!(!retained.contains_key("consumed-skill-disconnect"));
        assert!(!retained.contains_key("old-source"));
        assert_eq!(retained["unrelated-preview"]["keep"], true);
        assert_eq!(retained["independent-disconnect"]["keep"], true);
        for index in (0..40).step_by(2) {
            assert_eq!(
                retained.contains_key(&format!("new-disconnect-{index:02}")),
                index >= 8
            );
        }
        assert_eq!(service.manager.lock().unwrap().previews, retained);

        let root = _dir.path().join("connected-skill");
        let entry = _dir.path().join("client/connected-skill");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(
            root.join("SKILL.md"),
            "---\nname: connected\ndescription: Synthetic connected skill\n---\nBody",
        )
        .unwrap();
        let skill_id = {
            let mut manager = service.manager.lock().unwrap();
            crate::local::handle(&mut manager, &json!({"action":"add_local","paths":[root]}))
                .unwrap();
            let id = manager
                .state
                .skills
                .iter()
                .find(|skill| skill["name"] == "connected")
                .unwrap()["id"]
                .clone();
            crate::clients::handle(
                &mut manager,
                &json!({"action":"connect","client":"codex","skillId":id,"targetPath":entry}),
            )
            .unwrap();
            id
        };
        for expired in [true, false] {
            let preview = service
                .execute(
                    json!({"action":"preview_skill_remove","skillId":skill_id,"extent":"disable","customFiles":[]}),
                    crate::dispatch_local,
                )
                .unwrap();
            let parent_id = preview["id"].as_str().unwrap();
            let child_id = service.manager.lock().unwrap().previews[parent_id]["prepared"]
                ["disconnects"][0]["previewId"]
                .as_str()
                .unwrap()
                .to_owned();
            let (hold_id, latch) = new_latch();
            let read = start(
                &service,
                json!({"action":"read_file","skillId":"one","hold":hold_id}),
            );
            entered(&latch);
            if expired {
                service
                    .manager
                    .lock()
                    .unwrap()
                    .previews
                    .get_mut(parent_id)
                    .unwrap()["prepared"]["createdAt"] =
                    json!(chrono::Utc::now().timestamp() - 601);
            }
            let outcome = service.execute(
                json!({"action":"apply_skill_remove","previewId":parent_id}),
                crate::dispatch_local,
            );
            release(&latch);
            service.wait(&read).unwrap();
            if expired {
                assert!(outcome.unwrap_err().contains("过期"));
            } else {
                assert_eq!(outcome.unwrap()["complete"], true);
            }
            let manager = service.manager.lock().unwrap();
            assert!(!manager.previews.contains_key(parent_id));
            assert!(!manager.previews.contains_key(&child_id));
            assert_eq!(manager.previews["independent-disconnect"]["keep"], true);
            assert_eq!(manager.previews["unrelated-preview"]["keep"], true);
            assert_eq!(std::fs::symlink_metadata(&entry).is_ok(), expired);
            assert!(root.join("SKILL.md").is_file());
        }
    }

    #[test]
    fn color_management_uses_existing_serialization_and_survives_concurrent_read_completion() {
        let (_dir, service) = fixture();
        {
            let mut manager = service.manager.lock().unwrap();
            manager.state.settings["categories"] =
                json!([{"id":"legacy","name":"Legacy","future":{"keep":true}}]);
            manager.save().unwrap();
        }
        let (hold_id, latch) = new_latch();
        let read = start(
            &service,
            json!({"action":"audit_skills","skillId":"one","hold":hold_id,"fields":{"status":"synced"}}),
        );
        entered(&latch);
        let color = start(
            &service,
            json!({"action":"set_category_color","categoryId":"legacy","color":"purple"}),
        );
        service.wait(&color).unwrap();
        let favorite = start(
            &service,
            json!({"action":"set_favorite","skillId":"one","favorite":true}),
        );
        service.wait(&favorite).unwrap();
        release(&latch);
        let state = service.wait(&read).unwrap();
        assert_eq!(state["settings"]["categories"][0]["color"], "purple");
        assert_eq!(
            state["settings"]["categories"][0]["future"],
            json!({"keep":true})
        );
        assert_eq!(state["skills"][0]["favorite"], true);
        assert_eq!(state["skills"][0]["status"], "synced");
        let undo = start(&service, json!({"action":"undo_management"}));
        service.wait(&undo).unwrap();
        let undo = start(&service, json!({"action":"undo_management"}));
        let state = service.wait(&undo).unwrap();
        assert_eq!(
            state["settings"]["categories"],
            json!([{"id":"legacy","name":"Legacy","future":{"keep":true}}])
        );
        assert_eq!(state["skills"][0]["status"], "synced");
        assert!(read_request(
            &json!({"action":"storage_resolve_default_path","kind":"export"})
        ));
        let manager = service.manager.lock().unwrap();
        assert!(resources_for(
            &manager,
            &json!({"action":"storage_resolve_default_path","kind":"export"})
        )
        .unwrap()
        .iter()
        .all(|resource| !resource.write));
    }

    #[test]
    fn management_undo_remains_consistent_after_task_completion() {
        let (_dir, service) = fixture();
        let a = start(
            &service,
            json!({"action":"set_favorite","skillId":"one","favorite":true}),
        );
        let state = service.wait(&a).unwrap();
        assert_eq!(state["managementUndo"]["available"], true);
        let entry_id = state["managementUndo"]["entryId"].clone();
        let b = start(&service, json!({"action":"undo_management"}));
        let state = service.wait(&b).unwrap();
        assert_eq!(state["skills"][0]["favorite"], false);
        assert_eq!(state["managementUndo"]["available"], false);
        assert_eq!(state["managementRedo"]["entryId"], entry_id);
        let c = start(
            &service,
            json!({"action":"redo_management","expectedEntryId":entry_id}),
        );
        let state = service.wait(&c).unwrap();
        assert_eq!(state["skills"][0]["favorite"], true);
        assert_eq!(state["managementUndo"]["entryId"], entry_id);
        assert_eq!(state["managementRedo"]["available"], false);
    }

    #[test]
    fn management_events_expose_committed_state_and_both_stacks_before_task_completion() {
        let (_dir, service) = fixture();
        let revisions = Arc::new(Mutex::new(Vec::new()));
        let captured = revisions.clone();
        service
            .set_state_events(Arc::new(move |revision| {
                captured.lock().unwrap().push(revision)
            }))
            .unwrap();
        let mut entry_id = Value::Null;
        for (index, action) in ["set_favorite", "undo_management", "redo_management"]
            .into_iter()
            .enumerate()
        {
            let (hold_id, latch) = new_latch();
            let mut request = json!({"action":action,"afterManagement":hold_id});
            if index == 0 {
                request["skillId"] = json!("one");
                request["favorite"] = json!(true);
            } else {
                request["expectedEntryId"] = entry_id.clone();
            }
            let task = start(&service, request);
            entered(&latch);
            let state = service.snapshot().unwrap();
            assert_eq!(revisions.lock().unwrap().len(), index + 1);
            assert_eq!(
                revisions.lock().unwrap().last().copied(),
                state["stateRevision"].as_u64()
            );
            assert_eq!(state["skills"][0]["favorite"], index != 1);
            assert_eq!(state["managementUndo"]["available"], index != 1);
            assert_eq!(state["managementRedo"]["available"], index == 1);
            let active = if index == 1 {
                "managementRedo"
            } else {
                "managementUndo"
            };
            if index == 0 {
                entry_id = state[active]["entryId"].clone();
                assert!(entry_id.as_str().is_some_and(|id| !id.is_empty()));
            } else {
                assert_eq!(state[active]["entryId"], entry_id);
            }
            release(&latch);
            let result = service.wait(&task).unwrap();
            assert_eq!(result["managementUndo"], state["managementUndo"]);
            assert_eq!(result["managementRedo"], state["managementRedo"]);
        }
    }

    #[test]
    fn redo_database_failure_preserves_writer_state_stacks_and_events_for_retry() {
        let (dir, service) = fixture();
        let change = start(
            &service,
            json!({"action":"set_favorite","skillId":"one","favorite":true}),
        );
        service.wait(&change).unwrap();
        let undo = start(&service, json!({"action":"undo_management"}));
        let before = service.wait(&undo).unwrap();
        let stored_before = serde_json::to_value(&service.manager.lock().unwrap().state).unwrap();
        let entry_id = before["managementRedo"]["entryId"].clone();
        let revisions = Arc::new(Mutex::new(Vec::new()));
        let captured = revisions.clone();
        service
            .set_state_events(Arc::new(move |revision| {
                captured.lock().unwrap().push(revision)
            }))
            .unwrap();
        let db = rusqlite::Connection::open(dir.path().join("manager.sqlite3")).unwrap();
        db.execute_batch("CREATE TRIGGER reject_redo BEFORE INSERT ON app_state BEGIN SELECT RAISE(ABORT, 'synthetic redo save failure'); END;").unwrap();
        let redo = start(
            &service,
            json!({"action":"redo_management","expectedEntryId":entry_id}),
        );
        assert!(service
            .wait(&redo)
            .unwrap_err()
            .contains("synthetic redo save failure"));
        let after = service.snapshot().unwrap();
        for key in [
            "skills",
            "settings",
            "managementUndo",
            "managementRedo",
            "stateRevision",
        ] {
            assert_eq!(after[key], before[key]);
        }
        assert!(revisions.lock().unwrap().is_empty());
        let stored: String = db
            .query_row("SELECT payload FROM app_state WHERE id=1", [], |row| {
                row.get(0)
            })
            .unwrap();
        let stored: Value = serde_json::from_str(&stored).unwrap();
        assert_eq!(stored["skills"], stored_before["skills"]);
        assert!(stored["skills"]
            .as_array()
            .unwrap()
            .iter()
            .all(|skill| skill.get("sceneEligible").is_none()));
        assert!(stored.get("managementRedo").is_none());
        db.execute_batch("DROP TRIGGER reject_redo").unwrap();
        let retry = start(
            &service,
            json!({"action":"redo_management","expectedEntryId":entry_id}),
        );
        let after = service.wait(&retry).unwrap();
        assert_eq!(after["skills"][0]["favorite"], true);
        assert_eq!(after["managementUndo"]["entryId"], entry_id);
        assert_eq!(revisions.lock().unwrap().len(), 1);
    }

    #[test]
    fn concurrent_read_preserves_redo_and_a_new_branch_rejects_the_old_displayed_entry() {
        let (_dir, service) = fixture();
        let (hold_id, latch) = new_latch();
        let read = start(
            &service,
            json!({"action":"audit_skills","skillId":"one","hold":hold_id,"fields":{"status":"synced"}}),
        );
        entered(&latch);
        let change = start(
            &service,
            json!({"action":"set_favorite","skillId":"one","favorite":true}),
        );
        service.wait(&change).unwrap();
        let undo = start(&service, json!({"action":"undo_management"}));
        let state = service.wait(&undo).unwrap();
        let old_entry = state["managementRedo"]["entryId"].clone();
        release(&latch);
        let state = service.wait(&read).unwrap();
        assert_eq!(state["managementRedo"]["entryId"], old_entry);
        assert_eq!(state["skills"][0]["status"], "synced");
        let noop = start(
            &service,
            json!({"action":"set_favorite","skillId":"one","favorite":false}),
        );
        assert_eq!(
            service.wait(&noop).unwrap()["managementRedo"]["entryId"],
            old_entry
        );
        let branch = start(
            &service,
            json!({"action":"set_favorite","skillId":"two","favorite":true}),
        );
        assert_eq!(
            service.wait(&branch).unwrap()["managementRedo"]["available"],
            false
        );
        let undo = start(&service, json!({"action":"undo_management"}));
        let before = service.wait(&undo).unwrap();
        let current_entry = before["managementRedo"]["entryId"].clone();
        assert_ne!(current_entry, old_entry);
        let stale = start(
            &service,
            json!({"action":"redo_management","expectedEntryId":old_entry}),
        );
        assert!(service
            .wait(&stale)
            .unwrap_err()
            .contains("管理操作记录已变化"));
        assert_eq!(
            service.snapshot().unwrap()["managementRedo"],
            before["managementRedo"]
        );
        let redo = start(
            &service,
            json!({"action":"redo_management","expectedEntryId":current_entry}),
        );
        let after = service.wait(&redo).unwrap();
        assert_eq!(after["skills"][0]["favorite"], false);
        assert_eq!(after["skills"][1]["favorite"], true);
        assert_eq!(after["skills"][0]["status"], "synced");
    }

    #[test]
    fn stale_worker_cannot_publish_history_or_partial_state_over_another_window() {
        let (_dir, service) = fixture();
        let (hold_id, latch) = new_latch();
        let stale = start(
            &service,
            json!({"action":"set_favorite","skillId":"one","favorite":true,"beforeManagement":hold_id}),
        );
        entered(&latch);
        {
            let mut manager = service.manager.lock().unwrap();
            crate::categories::handle(
                &mut manager,
                &json!({"action":"set_favorite","skillId":"two","favorite":true}),
            )
            .unwrap();
        }
        let before = service.snapshot().unwrap();
        release(&latch);
        assert!(service
            .wait(&stale)
            .unwrap_err()
            .contains("管理操作记录已变化"));
        let after = service.snapshot().unwrap();
        for key in [
            "skills",
            "managementUndo",
            "managementRedo",
            "stateRevision",
        ] {
            assert_eq!(after[key], before[key]);
        }
        let manager = service.manager.lock().unwrap();
        assert_eq!(manager.management_undo.len(), 1);
        assert!(manager.management_redo.is_empty());
    }

    #[test]
    fn undo_and_redo_recheck_live_fields_even_when_another_write_matches_the_target() {
        for redo in [false, true] {
            let (_dir, service) = fixture();
            let change = start(
                &service,
                json!({"action":"set_favorite","skillId":"one","favorite":true}),
            );
            let mut state = service.wait(&change).unwrap();
            if redo {
                let undo = start(&service, json!({"action":"undo_management"}));
                state = service.wait(&undo).unwrap();
            }
            let (action, history) = if redo {
                ("redo_management", "managementRedo")
            } else {
                ("undo_management", "managementUndo")
            };
            let (hold_id, latch) = new_latch();
            let task = start(
                &service,
                json!({"action":action,"expectedEntryId":state[history]["entryId"],"beforeManagement":hold_id}),
            );
            entered(&latch);
            {
                let mut manager = service.manager.lock().unwrap();
                manager.state.skills[0]["favorite"] = json!(redo);
                manager.save().unwrap();
            }
            let before = service.snapshot().unwrap();
            release(&latch);
            assert!(service.wait(&task).unwrap_err().contains("无法安全"));
            let after = service.snapshot().unwrap();
            for key in [
                "skills",
                "managementUndo",
                "managementRedo",
                "stateRevision",
            ] {
                assert_eq!(after[key], before[key]);
            }
        }
    }

    #[test]
    fn undo_and_redo_cannot_orphan_members_added_after_the_worker_snapshot() {
        for redo in [false, true] {
            let (_dir, service) = fixture();
            let create = start(
                &service,
                json!({"action":"create_category","name":"Research"}),
            );
            let mut state = service.wait(&create).unwrap();
            let category = state["settings"]["categories"][0]["id"].clone();
            if redo {
                let delete = start(
                    &service,
                    json!({"action":"delete_category","categoryId":category}),
                );
                service.wait(&delete).unwrap();
                let undo = start(&service, json!({"action":"undo_management"}));
                state = service.wait(&undo).unwrap();
            }
            let (action, history) = if redo {
                ("redo_management", "managementRedo")
            } else {
                ("undo_management", "managementUndo")
            };
            let (hold_id, latch) = new_latch();
            let task = start(
                &service,
                json!({"action":action,"expectedEntryId":state[history]["entryId"],"beforeManagement":hold_id}),
            );
            entered(&latch);
            {
                let mut manager = service.manager.lock().unwrap();
                manager
                    .state
                    .skills
                    .push(json!({"id":"new-member","categoryId":category}));
                manager.save().unwrap();
            }
            let before = service.snapshot().unwrap();
            release(&latch);
            assert!(service.wait(&task).unwrap_err().contains("新的成员"));
            let after = service.snapshot().unwrap();
            for key in [
                "skills",
                "settings",
                "managementUndo",
                "managementRedo",
                "stateRevision",
            ] {
                assert_eq!(after[key], before[key]);
            }
        }
    }

    #[test]
    fn repeated_refreshes_join_one_task_and_events_do_not_expose_full_results() {
        let (_dir, service) = fixture();
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        service.set_events(Arc::new(move |event| captured.lock().unwrap().push(event)));
        let (hold_id, latch) = new_latch();
        let a = start(
            &service,
            json!({"action":"refresh","skillId":"one","localOnly":true,"hold":hold_id}),
        );
        entered(&latch);
        let b = start(
            &service,
            json!({"action":"refresh","skillIds":["one"],"localOnly":true}),
        );
        assert_eq!(a, b);
        release(&latch);
        service.wait(&a).unwrap();
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .all(|event| event["task"].get("result").is_none()));
        assert!(service.get(&a, true).unwrap()["result"]["skills"].is_array());
        assert_eq!(service.list().unwrap().len(), 1);
    }

    #[test]
    fn history_is_bounded_durable_redacted_and_never_replays_expired_results() {
        let (dir, service) = fixture();
        for _ in 0..102 {
            let task = start(&service, json!({"action":"read_file","skillId":"one"}));
            service.wait(&task).unwrap();
        }
        let secret = "synthetic-private-token";
        let task=service.start(json!({"action":"set_token","repo":"synthetic/repo","token":secret,"fail":true,"error":secret}),Some(secret),None,true,true,fake_dispatch).unwrap()["id"].as_str().unwrap().to_owned();
        assert!(service.wait(&task).is_err());
        let saved = service.manager.lock().unwrap().task_history().unwrap();
        assert_eq!(saved.len(), 100);
        assert!(!json!(saved).to_string().contains(secret));
        let restarted = TaskSystem::new(Manager::new(dir.path().into()).unwrap()).unwrap();
        assert_eq!(restarted.list().unwrap().len(), 100);
        assert!(restarted
            .list()
            .unwrap()
            .iter()
            .all(|task| task["resultExpired"] == true && task["resultAvailable"] == false));
        restarted.clear_history().unwrap();
        assert!(restarted.list().unwrap().is_empty());
    }

    fn history_payloads(db: &rusqlite::Connection) -> BTreeMap<String, String> {
        db.prepare("SELECT id,payload FROM task_history")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn durable_history_delta_retries_changes_and_repairs_external_rows() {
        let (dir, service) = fixture();
        let db = rusqlite::Connection::open(dir.path().join("manager.sqlite3")).unwrap();
        db.execute_batch(
            "CREATE TABLE history_insert_attempts (id TEXT NOT NULL);
             CREATE TRIGGER record_history_insert BEFORE INSERT ON task_history
                 BEGIN INSERT INTO history_insert_attempts VALUES (NEW.id); END;
             CREATE TRIGGER reject_history_insert BEFORE INSERT ON task_history
                 WHEN NEW.id='zz-break-write'
                 BEGIN SELECT RAISE(ABORT,'synthetic history failure'); END;",
        )
        .unwrap();
        let payload = Arc::new(TaskResult::new(&json!(null)));
        let resources: Vec<_> = (0..2002)
            .map(|index| format!("skill:fixture-{index}"))
            .collect();
        {
            let mut jobs = service.jobs.lock().unwrap();
            for id in ["archived-changed", "archived-stable"] {
                jobs.insert(
                    id.into(),
                    retention_job(id, "check_now", payload.clone(), resources.clone()),
                );
            }
            for id in ["active-a", "active-b"] {
                let mut job = retention_job(id, "get_files", payload.clone(), vec![]);
                job.task.status = "running".into();
                jobs.insert(id.into(), job);
            }
        }
        service.persist_history().unwrap();
        let before = history_payloads(&db);
        service.change("archived-changed", |task| {
            task.error = Some("重试后保存".into())
        });
        for (id, completed) in [("active-a", 3), ("active-b", 7)] {
            service.change(id, |task| task.progress = json!({"completed":completed}));
        }
        service.jobs.lock().unwrap().insert(
            "zz-break-write".into(),
            retention_job("zz-break-write", "check_now", payload, vec![]),
        );
        assert!(service
            .persist_history()
            .unwrap_err()
            .contains("synthetic history failure"));
        assert_eq!(history_payloads(&db), before);
        service.jobs.lock().unwrap().remove("zz-break-write");
        service.persist_history().unwrap();
        let saved = history_payloads(&db);
        assert_eq!(saved["archived-stable"], before["archived-stable"]);
        let attempts: i64 = db
            .query_row(
                "SELECT count(*) FROM history_insert_attempts WHERE id='archived-stable'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            attempts, 1,
            "an unchanged archived row did not reach the UPSERT"
        );
        let changed: Value = serde_json::from_str(&saved["archived-changed"]).unwrap();
        assert_eq!(changed["error"], "重试后保存");
        assert_eq!(changed["resources"].as_array().unwrap().len(), 2002);
        for (id, completed) in [("active-a", 3), ("active-b", 7)] {
            let record: Value = serde_json::from_str(&saved[id]).unwrap();
            assert_eq!(record["progress"]["completed"], completed);
        }
        db.execute_batch(
            "UPDATE task_history SET payload='invalid' WHERE id='archived-changed';
             DELETE FROM task_history WHERE id='archived-stable';",
        )
        .unwrap();
        service.persist_history().unwrap();
        assert_eq!(history_payloads(&db), saved);
    }

    #[test]
    fn task_history_row_matches_legacy_bytes_without_rewriting() {
        let (dir, service) = fixture();
        let result = Arc::new(TaskResult::new(&json!({"privateResult":true})));
        let resources: Vec<_> = (0..2002)
            .map(|index| format!("file:D:\\技能\\{index}\t\"输入\"\n🧪"))
            .collect();
        let mut job = retention_job(
            "history-row",
            "check_now",
            result.clone(),
            resources.clone(),
        );
        job.task.started_at = Some("2026-11-11T00:00:01Z".into());
        job.task.finished_at = Some("2026-11-11T00:00:02Z".into());
        job.task.error = Some("历史提示".into());
        job.task.origin = json!({"windowLabel":"main","paneId":"详情"});
        job.task.progress = json!({"total":2002,"completed":2002});
        job.task.result_files = serde_json::from_value(json!([{
            "id":"result","label":"摘要","path":"D:\\技能\\摘要.md",
            "bytes":42,"modifiedMillis":null
        }]))
        .unwrap();
        let legacy = job.task.metadata();
        assert_eq!(legacy["resources"], json!(resources));
        let row = job.task.history_row();
        assert_eq!(row.id, job.task.id);
        assert_eq!(row.payload, legacy.to_string());
        let empty = retention_job("empty-row", "get_document", result, vec![]);
        assert_eq!(
            empty.task.history_row().payload,
            empty.task.metadata().to_string()
        );

        service
            .manager
            .lock()
            .unwrap()
            .store_task_history(&[legacy])
            .unwrap();
        let db = rusqlite::Connection::open(dir.path().join("manager.sqlite3")).unwrap();
        db.execute_batch(
            "CREATE TRIGGER reject_unchanged_history_write BEFORE UPDATE ON task_history
             BEGIN SELECT RAISE(ABORT,'unchanged history was rewritten'); END;",
        )
        .unwrap();
        service.jobs.lock().unwrap().insert(row.id, job);
        service.persist_history().unwrap();
        assert_eq!(history_payloads(&db)["history-row"], row.payload);
    }

    #[test]
    fn task_history_incremental_persistence_changes_only_modified_rows() {
        let (dir, service) = fixture();
        let before = vec![
            json!({"id":"active","status":"running","progress":{"completed":1,"total":8},"origin":{"paneId":"pane-a"},"resources":["skill:one","file:one/SKILL.md"]}),
            json!({"id":"expired","status":"succeeded","label":"previous task"}),
            json!({"id":"unchanged","status":"succeeded","resultFiles":[{"path":"synthetic-output.txt"}],"resources":["skill:two"]}),
        ];
        service
            .manager
            .lock()
            .unwrap()
            .store_task_history(&before)
            .unwrap();
        let db = rusqlite::Connection::open(dir.path().join("manager.sqlite3")).unwrap();
        db.execute_batch(
            "CREATE TABLE history_write_audit (kind TEXT NOT NULL,id TEXT NOT NULL);
             CREATE TRIGGER audit_history_insert AFTER INSERT ON task_history BEGIN INSERT INTO history_write_audit VALUES('insert',NEW.id); END;
             CREATE TRIGGER audit_history_update AFTER UPDATE ON task_history BEGIN INSERT INTO history_write_audit VALUES('update',NEW.id); END;
             CREATE TRIGGER audit_history_delete AFTER DELETE ON task_history BEGIN INSERT INTO history_write_audit VALUES('delete',OLD.id); END;",
        ).unwrap();
        let original = history_payloads(&db);
        service
            .manager
            .lock()
            .unwrap()
            .store_task_history(&before)
            .unwrap();
        assert_eq!(history_payloads(&db), original);
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM history_write_audit", [], |row| row
                .get::<_, usize>(
                0
            ))
            .unwrap(),
            0
        );

        let mut active = before[0].clone();
        active["progress"]["completed"] = json!(7);
        let after = vec![
            active,
            before[2].clone(),
            json!({"id":"new","status":"queued"}),
        ];
        service
            .manager
            .lock()
            .unwrap()
            .store_task_history(&after)
            .unwrap();
        let writes: Vec<(String, String)> = db
            .prepare("SELECT kind,id FROM history_write_audit ORDER BY kind,id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            writes,
            vec![
                ("delete".into(), "expired".into()),
                ("insert".into(), "new".into()),
                ("update".into(), "active".into())
            ]
        );
        let expected = after
            .iter()
            .map(|row| (row["id"].as_str().unwrap().to_owned(), row.to_string()))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(history_payloads(&db), expected);
        db.execute("DELETE FROM history_write_audit", []).unwrap();
        service
            .manager
            .lock()
            .unwrap()
            .store_task_history(&after)
            .unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM history_write_audit", [], |row| row
                .get::<_, usize>(
                0
            ))
            .unwrap(),
            0
        );
    }

    #[test]
    fn task_history_incremental_persistence_rolls_back_changes_and_expiry_together() {
        let (dir, service) = fixture();
        let before = vec![
            json!({"id":"changed","status":"running","progress":1}),
            json!({"id":"expired","status":"succeeded"}),
        ];
        service
            .manager
            .lock()
            .unwrap()
            .store_task_history(&before)
            .unwrap();
        let db = rusqlite::Connection::open(dir.path().join("manager.sqlite3")).unwrap();
        let original = history_payloads(&db);
        db.execute_batch("CREATE TRIGGER fail_history_insert BEFORE INSERT ON task_history WHEN NEW.id='failure' BEGIN SELECT RAISE(ABORT,'synthetic history write failure'); END").unwrap();
        let desired = vec![
            json!({"id":"changed","status":"running","progress":2}),
            json!({"id":"inserted","status":"queued"}),
            json!({"id":"failure","status":"queued"}),
        ];
        assert!(service
            .manager
            .lock()
            .unwrap()
            .store_task_history(&desired)
            .is_err());
        assert_eq!(
            history_payloads(&db),
            original,
            "deletion, update and earlier insertion must all roll back"
        );
        db.execute_batch("DROP TRIGGER fail_history_insert")
            .unwrap();
        service
            .manager
            .lock()
            .unwrap()
            .store_task_history(&desired)
            .unwrap();
        let expected = desired
            .iter()
            .map(|row| (row["id"].as_str().unwrap().to_owned(), row.to_string()))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            history_payloads(&db),
            expected,
            "the failed transaction must leave the writer usable"
        );
    }

    #[test]
    fn task_history_incremental_persistence_rejects_invalid_and_duplicate_ids_atomically() {
        let (dir, service) = fixture();
        let before = json!({"id":"existing","status":"succeeded","label":"retain exactly"});
        service
            .manager
            .lock()
            .unwrap()
            .store_task_history(&[before])
            .unwrap();
        let db = rusqlite::Connection::open(dir.path().join("manager.sqlite3")).unwrap();
        let original = history_payloads(&db);
        for invalid in [
            json!({"status":"queued"}),
            json!({"id":7,"status":"queued"}),
        ] {
            let records = [json!({"id":"existing","label":"must not commit"}), invalid];
            assert!(service
                .manager
                .lock()
                .unwrap()
                .store_task_history(&records)
                .is_err());
            assert_eq!(history_payloads(&db), original);
        }
        let repeated = [
            json!({"id":"duplicate","status":"queued"}),
            json!({"id":"duplicate","status":"running"}),
        ];
        assert!(service
            .manager
            .lock()
            .unwrap()
            .store_task_history(&repeated)
            .is_err());
        assert_eq!(history_payloads(&db), original);
        service
            .manager
            .lock()
            .unwrap()
            .store_task_history(&[])
            .unwrap();
        assert!(
            history_payloads(&db).is_empty(),
            "valid empty snapshots still clear all stored history"
        );
    }

    #[test]
    fn history_snapshot_preserves_terminal_ties_and_all_active_progress() {
        let payload = Arc::new(TaskResult::new(&json!(null)));
        let mut jobs = BTreeMap::new();
        for index in 0..105 {
            let id = format!("terminal-{index:03}");
            let mut job =
                retention_job(&id, "check_now", payload.clone(), vec!["skill:one".into()]);
            job.task.finished_at = Some("2026-11-11T00:00:00Z".into());
            if index == 104 {
                job.task.finished_at = Some("2026-11-12T00:00:00Z".into());
            } else if index == 103 {
                job.task.finished_at = None;
            }
            jobs.insert(id, job);
        }
        for (id, status, completed) in [("active-a", "queued", 2), ("active-z", "running", 7)] {
            let mut job = retention_job(id, "check_now", payload.clone(), vec![]);
            job.task.status = status.into();
            job.task.progress = json!({"completed":completed,"total":9});
            jobs.insert(id.into(), job);
        }
        let mut hidden = retention_job("hidden", "check_now", payload, vec![]);
        hidden.visible = false;
        jobs.insert("hidden".into(), hidden);
        let records: Vec<Value> = history_records(&jobs)
            .into_iter()
            .map(|row| serde_json::from_str(&row.payload).unwrap())
            .collect();
        let mut expected_ids = vec!["terminal-104".to_owned()];
        expected_ids.extend((0..99).map(|index| format!("terminal-{index:03}")));
        expected_ids.extend(["active-a".to_owned(), "active-z".to_owned()]);
        assert_eq!(
            records
                .iter()
                .map(|row| row["id"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>(),
            expected_ids
        );
        assert_eq!(records[100]["status"], "queued");
        assert_eq!(records[100]["progress"]["completed"], 2);
        assert_eq!(records[101]["status"], "running");
        assert_eq!(records[101]["progress"]["completed"], 7);
        assert!(records.iter().all(|row| row.get("result").is_none()));
    }

    #[test]
    fn history_snapshot_reconciles_database_rows_after_failed_save_and_prune() {
        let (dir, service) = fixture();
        let payload = Arc::new(TaskResult::new(&json!(null)));
        {
            let mut jobs = service.jobs.lock().unwrap();
            jobs.clear();
            for index in 0..100 {
                let id = format!("terminal-{index:03}");
                let mut job = retention_job(&id, "check_now", payload.clone(), vec![]);
                job.task.finished_at = Some(format!(
                    "2026-11-11T00:{:02}:{:02}Z",
                    index / 60,
                    index % 60
                ));
                jobs.insert(id, job);
            }
            for id in ["active-a", "active-b"] {
                let mut job = retention_job(id, "check_now", payload.clone(), vec![]);
                job.task.status = "running".into();
                job.task.progress = json!({"completed":1,"total":9});
                jobs.insert(id.into(), job);
            }
        }
        service.persist_history().unwrap();
        let db = rusqlite::Connection::open(dir.path().join("manager.sqlite3")).unwrap();
        let original = history_payloads(&db);
        assert_eq!(original.len(), 102);
        db.execute_batch("CREATE TRIGGER prevent_expired_history_delete BEFORE DELETE ON task_history WHEN OLD.id='terminal-000' BEGIN SELECT RAISE(ABORT,'synthetic expiry failure'); END").unwrap();
        {
            let mut jobs = service.jobs.lock().unwrap();
            let mut newest = retention_job("newest", "check_now", payload, vec![]);
            newest.task.finished_at = Some("2026-11-12T00:00:00Z".into());
            jobs.insert("newest".into(), newest);
            jobs.get_mut("active-a").unwrap().task.progress["completed"] = json!(4);
            jobs.get_mut("active-b").unwrap().task.progress["completed"] = json!(8);
        }
        assert!(service.persist_history().is_err());
        service.prune();
        assert!(!service.jobs.lock().unwrap().contains_key("terminal-000"));
        assert_eq!(
            history_payloads(&db),
            original,
            "the failed save leaves an old ID in SQLite after in-memory prune"
        );
        db.execute_batch("DROP TRIGGER prevent_expired_history_delete")
            .unwrap();
        service.persist_history().unwrap();
        let saved = history_payloads(&db);
        assert_eq!(saved.len(), 102);
        assert!(!saved.contains_key("terminal-000"));
        assert!(saved.contains_key("newest"));
        for (id, completed) in [("active-a", 4), ("active-b", 8)] {
            let record: Value = serde_json::from_str(&saved[id]).unwrap();
            assert_eq!(record["status"], "running");
            assert_eq!(
                record["progress"]["completed"], completed,
                "all active progress is retained, not only the triggering task"
            );
        }
    }

    #[test]
    fn unfinished_history_becomes_interrupted_on_restart_without_running_business_code() {
        let (dir, service) = fixture();
        let task = json!({"id":"old","action":"apply_push","label":"旧上传","status":"running","stage":"提交中","createdAt":now(),"origin":{"view":"skills","skillId":"one"}});
        service
            .manager
            .lock()
            .unwrap()
            .store_task_history(&[task])
            .unwrap();
        let restarted = TaskSystem::new(Manager::new(dir.path().into()).unwrap()).unwrap();
        let record = restarted.get("old", true).unwrap();
        assert_eq!(record["status"], "interrupted");
        assert_eq!(record["resultExpired"], true);
        assert!(record.get("result").is_none());
        assert_eq!(
            restarted.snapshot().unwrap()["skills"][0]["status"],
            "local_only"
        );
    }

    #[test]
    fn prepare_close_cancels_reads_but_waits_for_critical_write_and_can_be_reversed() {
        let (_dir, service) = fixture();
        let (write_hold, write_latch) = new_latch();
        let write = start(
            &service,
            json!({"action":"apply_update","skillId":"one","hold":write_hold,"fields":{"version":"committed"}}),
        );
        entered(&write_latch);
        let (read_hold, read_latch) = new_latch();
        let read = start(
            &service,
            json!({"action":"read_file","skillId":"two","hold":read_hold}),
        );
        entered(&read_latch);
        let close_service = service.clone();
        let close = std::thread::spawn(move || close_service.prepare_close());
        task_status(&service, &read, "cancelled");
        assert!(!close.is_finished());
        assert!(service
            .start(
                json!({"action":"scan_local"}),
                None,
                None,
                true,
                true,
                fake_dispatch
            )
            .is_err());
        release(&write_latch);
        service.wait(&write).unwrap();
        assert_eq!(close.join().unwrap().unwrap()["ready"], true);
        service
            .control(&json!({"action":"cancel_close"}), fake_dispatch)
            .unwrap();
        let fresh = start(&service, json!({"action":"read_file","skillId":"one"}));
        service.wait(&fresh).unwrap();
    }

    #[test]
    fn check_configuration_projects_only_active_skill_watch_inputs() {
        let (_dir, service) = fixture();
        let roots = json!([
            {"resolvedPath": "D:/synthetic/skills", "enabled": true},
            {"resolvedPath": "D:/synthetic/paused", "enabled": false}
        ]);
        let skills = (0..1000)
            .map(|index| {
                json!({
                    "id": format!("skill-{index}"),
                    "localPath": format!("D:/synthetic/skills/{index}")
                })
            })
            .collect::<Vec<_>>();
        {
            let mut manager = service.manager.lock().unwrap();
            manager.state.local_roots = roots.as_array().unwrap().clone();
            manager.state.skills = skills
                .iter()
                .cloned()
                .map(|mut skill| {
                    skill["description"] = json!("Do not copy unrelated metadata");
                    skill
                })
                .chain([json!({"id": "remote-only"})])
                .collect();
            manager.state.check_generation = 17;
        }
        let expected_skills = Value::Array(skills);
        for (mode, paused, basic, watch_active) in [
            ("manual", false, false, false),
            ("auto", false, false, true),
            ("auto", true, false, false),
            ("auto", false, false, true),
            ("auto", false, true, false),
        ] {
            {
                let mut manager = service.manager.lock().unwrap();
                manager.state.check_mode = mode.into();
                manager.basic_mode = basic;
                manager.state.settings["maintenance"] = json!({
                    "revision": 8,
                    "pausedManually": paused,
                    "pauseUntil": null,
                    "window": null,
                });
            }
            let config = service.check_configuration().unwrap();
            assert_eq!(config["mode"], if basic { "manual" } else { mode });
            assert_eq!(config["generation"], 17);
            assert_eq!(config["maintenance"]["revision"], 8);
            assert_eq!(config["maintenance"]["automaticAllowed"], !paused && !basic);
            assert_eq!(crate::checks::skill_watch_active(&config), watch_active);
            if watch_active {
                assert_eq!(config["roots"], roots);
                assert_eq!(config["skills"], expected_skills);
            } else {
                assert_eq!(config["roots"], json!([]));
                assert_eq!(config["skills"], json!([]));
            }
        }
    }

    #[test]
    fn get_state_is_pure_and_does_not_discover_or_save_connections() {
        let _network = crate::network::test_configuration_guard();
        let (_dir, service) = fixture();
        let before = service.snapshot().unwrap();
        let state = service
            .execute(json!({"action":"get_state"}), crate::dispatch)
            .unwrap();
        assert_eq!(state, before);
        assert!(service.list().unwrap().is_empty());
    }

    #[test]
    fn merge_conflicts_are_atomic_and_preserve_unrelated_fields() {
        let (_dir, service) = fixture();
        let before = service.manager.lock().unwrap().state.clone();
        let mut after = before.clone();
        after.skills[0]["description"] = json!("Checked metadata");
        after.skills[0]["status"] = json!("synced");
        after.settings["uiZoom"] = json!(125);
        let mut current = before.clone();
        current.skills[0]["status"] = json!("both_modified");
        current.settings["uiFontSize"] = json!(18);
        let current_skill = current.skills[0].clone();
        assert!(merge_state(&before, &after, &current, "refresh").is_err());
        assert_eq!(current.skills[0], current_skill);
        assert_eq!(current.settings["uiZoom"], 100);
        current.skills[0]["status"] = before.skills[0]["status"].clone();
        let merged = merge_state(&before, &after, &current, "refresh").unwrap();
        assert_eq!(merged.skills[0]["description"], "Checked metadata");
        assert_eq!(merged.settings["uiZoom"], 125);
        assert_eq!(merged.settings["uiFontSize"], 18);
    }

    #[test]
    fn canonical_directory_aliases_serialize_even_with_different_skill_ids() {
        let (dir, service) = fixture();
        let root = dir.path().join("skill");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("SKILL.md"),
            "---\nname: synthetic\ndescription: test\n---\n",
        )
        .unwrap();
        {
            let mut manager = service.manager.lock().unwrap();
            manager.state.skills[0]["localPath"] = json!(root.to_string_lossy());
            manager.state.skills[1]["localPath"] = json!(root.join(".").to_string_lossy());
            manager.save().unwrap();
        }
        let (hold_id, latch) = new_latch();
        let a = start(
            &service,
            json!({"action":"apply_update","skillId":"one","hold":hold_id}),
        );
        entered(&latch);
        let b = start(
            &service,
            json!({"action":"apply_update","skillId":"two","fields":{"version":"b"}}),
        );
        assert_eq!(service.get(&b, false).unwrap()["status"], "queued");
        release(&latch);
        service.wait(&a).unwrap();
        service.wait(&b).unwrap();
    }

    #[test]
    fn client_repair_and_usage_take_source_locks_while_checks_remain_reads() {
        let (_dir, service) = fixture();
        let mut manager = service.manager.lock().unwrap();
        manager.state.skills[0]["localPath"] = json!("D:/synthetic/skill-one");
        manager.state.skills[1]["localPath"] = json!("D:/synthetic/skill-two");
        manager.state.connections = vec![
            json!({"id":"entry-one","client":"codex","skillId":"one","path":"D:/synthetic/codex/one"}),
            json!({"id":"entry-two","client":"cursor","skillId":"two","path":"D:/synthetic/cursor/two"}),
        ];
        for action in ["repair_client_connections", "confirm_client_usage"] {
            let resources = resources_for(
                &manager,
                &json!({"action":action,"connectionId":"entry-one","connectionIds":["entry-one"]}),
            )
            .unwrap();
            assert!(!read_request(&json!({"action":action})));
            for prefix in ["client:codex", "skill:one", "directory:", "entry:"] {
                assert!(
                    resources
                        .iter()
                        .any(|resource| resource.key.starts_with(prefix) && resource.write),
                    "{action}: {prefix}"
                );
            }
        }
        for action in ["refresh", "audit_skills", "refresh_clients"] {
            let resources =
                resources_for(&manager, &json!({"action":action,"skillId":"one"})).unwrap();
            for name in ["client:codex", "client:cursor", "skill:one", "skill:two"] {
                assert!(
                    resources
                        .iter()
                        .any(|resource| resource.key == name && !resource.write),
                    "{action}: {name}"
                );
            }
            assert!(resources
                .iter()
                .filter(|resource| resource.key.starts_with("directory:"))
                .all(|resource| !resource.write));
        }
        manager.previews.insert(
            "client-preview".into(),
            json!({"entries":[{"connectionId":"entry-one"},{"connectionId":"entry-two"}]}),
        );
        let resources = resources_for(
            &manager,
            &json!({"action":"apply_disconnect","previewId":"client-preview"}),
        )
        .unwrap();
        for name in [
            "client:codex",
            "client:cursor",
            "skill:one",
            "skill:two",
            "preview:client-preview",
        ] {
            assert!(
                resources
                    .iter()
                    .any(|resource| resource.key == name && resource.write),
                "batch preview: {name}"
            );
        }
    }

    #[test]
    fn identical_automatic_repair_requests_coalesce_and_distinct_targets_do_not() {
        let first =
            dedup_key(&json!({"action":"repair_client_connections","connectionIds":["b","a","a"]}));
        assert_eq!(
            first,
            dedup_key(&json!({"action":"repair_client_connections","connectionIds":["a","b"]}))
        );
        assert_ne!(
            first,
            dedup_key(&json!({"action":"repair_client_connections","connectionIds":["a"]}))
        );
    }

    #[test]
    fn same_client_batch_and_remove_record_queue_without_blocking_another_client() {
        let (_dir, service) = fixture();
        {
            let mut manager = service.manager.lock().unwrap();
            manager.state.connections = vec![
                json!({"id":"entry","client":"codex","skillId":"two","path":"D:/synthetic/client"}),
            ];
            manager.save().unwrap();
        }
        let (hold_id, latch) = new_latch();
        let a = start(
            &service,
            json!({"action":"connect_batch","client":"codex","skillIds":["one"],"hold":hold_id}),
        );
        entered(&latch);
        let b = start(
            &service,
            json!({"action":"remove_connection_record","connectionId":"entry"}),
        );
        let c = start(
            &service,
            json!({"action":"connect","client":"claude","skillId":"three"}),
        );
        service.wait(&c).unwrap();
        assert_eq!(service.get(&b, false).unwrap()["status"], "queued");
        release(&latch);
        service.wait(&a).unwrap();
        service.wait(&b).unwrap();
    }

    #[test]
    fn a_failed_durable_save_does_not_acknowledge_or_modify_live_state() {
        let _network = crate::network::test_configuration_guard();
        let (dir, service) = fixture();
        let before = service.snapshot().unwrap();
        let db = rusqlite::Connection::open(dir.path().join("manager.sqlite3")).unwrap();
        db.execute_batch("CREATE TRIGGER deny_test_save BEFORE UPDATE ON app_state BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END").unwrap();
        let a = start(
            &service,
            json!({"action":"apply_update","skillId":"one","fields":{"version":"must-not-commit"}}),
        );
        assert!(service
            .wait(&a)
            .unwrap_err()
            .contains("synthetic disk failure"));
        assert_eq!(service.snapshot().unwrap(), before);
        let persisted = Manager::new(dir.path().into()).unwrap();
        assert!(persisted.state.skills[0]["version"].is_null());
    }

    #[test]
    fn external_file_change_rejects_stale_hash_observations_without_holding_live_lock() {
        let (dir, service) = fixture();
        let root = dir.path().join("observed");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("SKILL.md"), "original bytes").unwrap();
        let digest = crate::local::files(&root).unwrap()["SKILL.md"].clone();
        {
            let mut manager = service.manager.lock().unwrap();
            manager.state.skills[0]["localPath"] = json!(root.to_string_lossy());
            manager.save().unwrap();
        }
        let (hold_id, latch) = new_latch();
        let a = start(
            &service,
            json!({"action":"refresh","skillId":"one","hold":hold_id,"fields":{"localHashes":{"SKILL.md":digest},"lastLocalCheckedAt":now(),"status":"synced"}}),
        );
        entered(&latch);
        std::fs::write(root.join("SKILL.md"), "edited in existing editor").unwrap();
        release(&latch);
        assert!(service.wait(&a).unwrap_err().contains("本地文件"));
        assert_eq!(
            service.snapshot().unwrap()["skills"][0]["status"],
            "local_only"
        );
    }

    #[test]
    fn independent_client_ignore_changes_merge_as_set_differences() {
        let (_dir, service) = fixture();
        let before = service.manager.lock().unwrap().state.clone();
        let mut after = before.clone();
        after.settings["ignoredClientConnections"] =
            json!([{"client":"codex","path":"a","target":"one"}]);
        let mut current = before.clone();
        current.settings["ignoredClientConnections"] =
            json!([{"client":"claude","path":"b","target":"two"}]);
        let merged = merge_state(&before, &after, &current, "remove_connection_record").unwrap();
        assert_eq!(
            merged.settings["ignoredClientConnections"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn inventory_read_merges_reject_added_files_and_changed_evidence_with_the_same_timestamp() {
        for action in ["get_files", "get_export_plan"] {
            let (dir, service) = fixture();
            let root = dir.path().join("observed");
            std::fs::create_dir_all(&root).unwrap();
            std::fs::write(root.join("SKILL.md"), "original bytes").unwrap();
            let original = crate::local::files(&root).unwrap();
            let mut before = service.manager.lock().unwrap().state.clone();
            before.skills[0]["localPath"] = json!(root.to_string_lossy());
            before.skills[0]["runtimeAudit"] =
                json!({"checkedAt":"same-timestamp","scopeHashes":original});
            let mut after = before.clone();
            after.skills[0]["runtimeAudit"]["inventoryHashes"] = json!(original);
            assert!(validate_observations(&before, &after, action).is_ok());
            std::fs::write(root.join("new-file.md"), "new inventory member").unwrap();
            assert!(validate_observations(&before, &after, action)
                .unwrap_err()
                .contains("本地文件"));
            let current = crate::local::files(&root).unwrap();
            after.skills[0]["runtimeAudit"]["inventoryHashes"] = json!(current);
            assert!(validate_observations(&before, &after, action).is_ok());
            std::fs::write(root.join("SKILL.md"), "changed required bytes").unwrap();
            assert!(validate_observations(&before, &after, action).is_err());
        }
    }

    #[test]
    fn concurrent_real_inventory_and_export_plan_reads_share_equivalent_audit_evidence() {
        let _network = crate::network::test_configuration_guard();
        static BARRIER: std::sync::OnceLock<std::sync::Barrier> = std::sync::OnceLock::new();
        fn synchronized_dispatch(manager: &mut Manager, request: &Value) -> Result<Value, String> {
            BARRIER.get().unwrap().wait();
            crate::dispatch(manager, request)
        }
        let (dir, service) = fixture();
        let root = dir.path().join("concurrent-inventory");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("SKILL.md"),
            "---\nname: concurrent-fixture\n---\nUse this skill.\n",
        )
        .unwrap();
        {
            let mut manager = service.manager.lock().unwrap();
            let mut skill = crate::local::draft(&root).unwrap();
            skill["id"] = json!("one");
            manager.upsert_skill(skill);
            manager.save().unwrap();
        }
        BARRIER.get_or_init(|| std::sync::Barrier::new(2));
        for added in [false, true] {
            if added {
                std::fs::write(root.join("optional-native.md"), "New optional file.").unwrap();
            }
            let before = service.snapshot().unwrap();
            let files_service = service.clone();
            let files = std::thread::spawn(move || {
                files_service.execute(
                    json!({"action":"get_files","skillId":"one"}),
                    synchronized_dispatch,
                )
            });
            let plan_service = service.clone();
            let plan = std::thread::spawn(move || {
                plan_service.execute(
                    json!({"action":"get_export_plan","skillId":"one","selectedIds":[]}),
                    synchronized_dispatch,
                )
            });
            let files = files.join().unwrap().unwrap();
            let plan = plan.join().unwrap().unwrap();
            assert_eq!(
                files["files"].as_array().unwrap().len(),
                if added { 2 } else { 1 }
            );
            assert_eq!(plan["canExport"], true);
            let after = service.snapshot().unwrap();
            assert_eq!(
                after["stateRevision"].as_u64().unwrap(),
                before["stateRevision"].as_u64().unwrap() + 1,
                "Equivalent concurrent evidence is persisted once"
            );
            let record = after["skills"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["id"] == "one")
                .unwrap();
            assert_eq!(
                record["runtimeAudit"]["inventoryHashes"],
                json!(crate::local::files(&root).unwrap())
            );
            assert!(record["baselineCommit"].is_null());
            assert!(record["installedCommit"].is_null());
            service
                .execute(
                    json!({"action":"get_files","skillId":"one"}),
                    crate::dispatch,
                )
                .unwrap();
            service
                .execute(
                    json!({"action":"get_export_plan","skillId":"one","selectedIds":[]}),
                    crate::dispatch,
                )
                .unwrap();
            assert_eq!(
                service.snapshot().unwrap(),
                after,
                "Unchanged subsequent reads do not rewrite the evidence"
            );
        }
    }

    #[test]
    fn inventory_audit_timestamp_merge_preserves_real_proof_selection_and_binding_conflicts() {
        for action in ["get_files", "get_export_plan"] {
            let (_dir, service) = fixture();
            let mut before = service.manager.lock().unwrap().state.clone();
            before.skills[0]["runtimeAudit"] = json!({"method":"static_package","checkedAt":"old","status":"passed","scopeHashes":{"SKILL.md":"hash"},"inventoryHashes":{"SKILL.md":"hash"},"externalBindingStamp":"binding","proposedScope":["SKILL.md"],"externalDependencies":[{"id":"ref","role":"environment","source":"SKILL.md","checkedAt":"old","local":{"status":"available","checkedAt":"old"}}]});
            let mut after = before.clone();
            after.skills[0]["runtimeAudit"]["checkedAt"] = json!("worker");
            let mut live = before.clone();
            live.skills[0]["runtimeAudit"]["checkedAt"] = json!("live");
            assert!(merge_state(&before, &after, &live, action).is_ok());
            for (field, value) in [
                ("status", json!("failed")),
                ("inventoryHashes", json!({"SKILL.md":"other"})),
                ("scopeHashes", json!({"SKILL.md":"other"})),
                ("externalBindingStamp", json!("changed")),
                ("proposedScope", json!(["SKILL.md", "new.py"])),
            ] {
                let mut changed = live.clone();
                changed.skills[0]["runtimeAudit"][field] = value;
                assert!(
                    merge_state(&before, &after, &changed, action).is_err(),
                    "{field}"
                );
            }
            let mut changed_role = live.clone();
            changed_role.skills[0]["runtimeAudit"]["externalDependencies"][0]["role"] =
                json!("required");
            assert!(merge_state(&before, &after, &changed_role, action).is_err());
            for (field, value) in [
                ("runtimeFiles", json!(["SKILL.md", "README.md"])),
                (
                    "externalBindings",
                    json!([{"id":"new-binding","role":"required"}]),
                ),
            ] {
                let mut changed = live.clone();
                changed.skills[0][field] = value;
                assert!(
                    merge_state(&before, &after, &changed, action).is_err(),
                    "{field}"
                );
            }
        }
    }

    #[test]
    fn compatibility_detail_reads_do_not_emit_history_or_write_its_database_table() {
        let (dir, service) = fixture();
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        service.set_events(Arc::new(move |event| captured.lock().unwrap().push(event)));
        let db = rusqlite::Connection::open(dir.path().join("manager.sqlite3")).unwrap();
        db.execute_batch(
            "CREATE TRIGGER deny_test_history_delete BEFORE DELETE ON task_history BEGIN SELECT RAISE(ABORT,'detail read must not delete history'); END;
             CREATE TRIGGER deny_test_history_insert BEFORE INSERT ON task_history BEGIN SELECT RAISE(ABORT,'detail read must not insert history'); END;
             CREATE TRIGGER deny_test_history_update BEFORE UPDATE ON task_history BEGIN SELECT RAISE(ABORT,'detail read must not update history'); END;",
        ).unwrap();
        service
            .execute(json!({"action":"read_file","skillId":"one"}), fake_dispatch)
            .unwrap();
        assert!(events.lock().unwrap().is_empty());
        assert!(service.list().unwrap().is_empty());
    }

    #[test]
    fn clearing_terminal_history_preserves_a_result_until_its_waiting_caller_reads_it() {
        let (_dir, service) = fixture();
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        service.set_events(Arc::new(move |event| captured.lock().unwrap().push(event)));
        let task = start(
            &service,
            json!({"action":"apply_update","skillId":"one","fields":{"version":"saved-before-clear"}}),
        );
        task_status(&service, &task, "succeeded");
        service.clear_history().unwrap();
        assert!(service.list().unwrap().is_empty());
        assert!(service
            .manager
            .lock()
            .unwrap()
            .task_history()
            .unwrap()
            .is_empty());
        let event_count = events.lock().unwrap().len();
        let retained = service.get(&task, true).unwrap();
        assert_eq!(retained["hidden"], true);
        assert_eq!(
            retained["result"]["skills"][0]["version"],
            "saved-before-clear"
        );
        assert_eq!(
            service.wait(&task).unwrap()["skills"][0]["version"],
            "saved-before-clear"
        );
        service.emit(&task);
        assert_eq!(events.lock().unwrap().len(), event_count);
        assert!(service.list().unwrap().is_empty());
    }

    #[test]
    fn clear_keeps_running_tasks_and_retains_cleared_results_after_later_completions() {
        let (_dir, service) = fixture();
        let completed = start(&service, json!({"action":"read_file","skillId":"one"}));
        service.wait(&completed).unwrap();
        let (hold_id, latch) = new_latch();
        let running = start(
            &service,
            json!({"action":"read_file","skillId":"two","hold":hold_id}),
        );
        entered(&latch);
        service.clear_history().unwrap();
        assert_eq!(service.list().unwrap().len(), 1);
        assert_eq!(service.list().unwrap()[0]["id"], running);
        assert_eq!(
            service
                .manager
                .lock()
                .unwrap()
                .task_history()
                .unwrap()
                .len(),
            1
        );
        release(&latch);
        service.wait(&running).unwrap();
        assert_eq!(service.get(&completed, true).unwrap()["hidden"], true);
        assert_eq!(service.get(&running, true).unwrap()["status"], "succeeded");
        assert_eq!(service.list().unwrap().len(), 1);
    }

    #[test]
    fn cleared_session_results_share_the_same_one_hundred_terminal_memory_bound() {
        let (_dir, service) = fixture();
        let mut ids = Vec::new();
        for index in 0..120 {
            let task = start(&service, json!({"action":"read_file","skillId":"one"}));
            service.wait(&task).unwrap();
            ids.push(task);
            if index == 59 {
                service.clear_history().unwrap();
            }
        }
        assert_eq!(service.jobs.lock().unwrap().len(), 100);
        assert_eq!(service.list().unwrap().len(), 60);
        assert_eq!(
            service
                .manager
                .lock()
                .unwrap()
                .task_history()
                .unwrap()
                .len(),
            60
        );
        assert!(service.get(&ids[0], true).is_err());
        assert_eq!(service.get(&ids[40], true).unwrap()["hidden"], true);
        assert_eq!(service.get(&ids[119], true).unwrap()["status"], "succeeded");
    }

    #[test]
    fn large_history_results_are_released_when_history_rotates() {
        let (_dir, service) = fixture();
        {
            let mut manager = service.manager.lock().unwrap();
            manager.state.skills = (0..1000)
                .map(|index| {
                    json!({"id":format!("skill-{index}"),"name":format!("技能 {index}"),
                        "description":"完整保留任务内容与来源。".repeat(20),
                        "runtimeFiles":["SKILL.md","scripts/run.py"],"version":"1.0.0"})
                })
                .collect();
            manager.save().unwrap();
        }
        let mut expected = service.snapshot().unwrap();
        // Task snapshots explicitly include the nullable scene error after rebasing.
        expected["sceneError"] = Value::Null;
        let mut results = Vec::new();
        for _ in 0..120 {
            let id = start(&service, json!({"action":"read_file","skillId":"skill-0"}));
            assert_eq!(service.wait(&id).unwrap(), expected);
            let weak = {
                let jobs = service.jobs.lock().unwrap();
                Arc::downgrade(jobs[&id].task.result.as_ref().unwrap())
            };
            results.push((id, weak));
        }
        assert_eq!(service.list().unwrap().len(), 100);
        for (id, weak) in &results[..20] {
            assert!(service.get(id, true).is_err());
            assert!(
                weak.upgrade().is_none(),
                "expired result still retained: {id}"
            );
        }
        for (id, weak) in &results[20..] {
            assert!(weak.upgrade().is_some());
            assert_eq!(service.get(id, true).unwrap()["result"], expected);
        }
        // Metadata polling must neither decode into retained copies nor evict results.
        for _ in 0..100 {
            assert!(service
                .list()
                .unwrap()
                .iter()
                .all(|task| task.get("result").is_none()));
        }
        drop(service);
        assert!(results.iter().all(|(_, weak)| weak.upgrade().is_none()));
    }

    #[test]
    fn task_summaries_preserve_metadata_fields_and_omissions() {
        let mut task: Task = serde_json::from_value(json!({
            "id": "summary-test",
            "action": "check_now",
            "label": "检查资源",
            "status": "succeeded",
            "stage": "complete",
            "createdAt": "2026-11-08T00:00:00Z",
            "startedAt": "",
            "finishedAt": "2026-11-08T00:00:01Z",
            "origin": {"kind": "schedule", "missing": null},
            "progress": {"current": 2, "total": 2},
            "cancellable": true,
            "cancelRequested": true,
            "resultAvailable": true,
            "resultExpired": true,
            "error": "",
            "resultFiles": [{
                "id": "output",
                "label": "检查结果",
                "path": "D:/generated-native-retention/result.json",
                "bytes": 9007199254740993u64,
                "modifiedMillis": null
            }],
            "resources": ["state", "directory:D:/generated-native-retention/resources"]
        }))
        .unwrap();
        task.result = Some(Arc::new(TaskResult::new(&json!({"skills": []}))));
        for optional_fields_present in [true, false] {
            if !optional_fields_present {
                task.started_at = None;
                task.finished_at = None;
                task.error = None;
                task.result_files.clear();
                task.origin = Value::Null;
                task.progress = Value::Null;
                task.cancellable = false;
                task.cancel_requested = false;
                task.result_available = false;
                task.result_expired = false;
            }
            let mut expected = task.metadata();
            expected.as_object_mut().unwrap().remove("resources");
            let summary = task.summary();
            assert_eq!(summary, expected);
            assert_eq!(
                serde_json::to_vec(&summary).unwrap(),
                serde_json::to_vec(&expected).unwrap()
            );
            assert!(summary.get("result").is_none());
            for field in ["startedAt", "finishedAt", "error", "resultFiles"] {
                assert_eq!(summary.get(field).is_some(), optional_fields_present);
            }
        }
    }

    #[test]
    fn task_lists_and_events_do_not_repeat_large_scheduling_keys() {
        let (_dir, service) = fixture();
        let request = json!({"action":"check_now"});
        let keys = {
            let mut manager = service.manager.lock().unwrap();
            manager.state.skills = (0..1000)
                .map(|index| {
                    json!({
                        "id": format!("skill-{index:04}"),
                        "localPath": format!("D:/generated-native-retention/resources/skills/long-resource-name-{index:04}")
                    })
                })
                .collect();
            manager.save().unwrap();
            let keys: Vec<_> = resources_for(&manager, &request)
                .unwrap()
                .into_iter()
                .map(|resource| resource.key)
                .collect();
            assert_eq!(keys.len(), 2002);
            json!(keys)
        };
        let captured = Arc::new(Mutex::new(Vec::new()));
        let listener = captured.clone();
        service.set_events(Arc::new(move |event| listener.lock().unwrap().push(event)));
        let mut ids = Vec::new();
        for _ in 0..100 {
            let task = service
                .start(request.clone(), None, None, true, true, |_, _| {
                    Ok(Value::Null)
                })
                .unwrap();
            let id = task["id"].as_str().unwrap();
            service.wait(id).unwrap();
            ids.push(id.to_owned());
        }
        service.persist_history().unwrap();
        let listed = service.list().unwrap();
        assert_eq!(listed.len(), 100);
        assert!(serde_json::to_vec(&listed).unwrap().len() < 512 * 1024);
        assert!(listed.iter().all(|task| task.get("resources").is_none()));
        assert!(captured
            .lock()
            .unwrap()
            .iter()
            .all(|event| event["task"].get("resources").is_none()));
        for id in ids {
            assert_eq!(service.get(&id, true).unwrap()["resources"], keys);
        }
        let stored = service.manager.lock().unwrap().task_history().unwrap();
        assert_eq!(stored.len(), 100);
        assert!(serde_json::to_vec(&stored).unwrap().len() > 8 * 1024 * 1024);
        assert!(stored.iter().all(|task| task["resources"] == keys));
    }

    #[test]
    fn an_invisible_fast_result_is_pinned_before_its_caller_reaches_wait() {
        let (_dir, service) = fixture();
        let task = service
            .start(
                json!({"action":"get_network_settings"}),
                None,
                None,
                true,
                false,
                fake_dispatch,
            )
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        task_status(&service, &task, "succeeded");
        let limit = Instant::now() + Duration::from_secs(5);
        while service
            .jobs
            .lock()
            .unwrap()
            .get(&task)
            .is_some_and(|job| Arc::strong_count(&job.completion) > 1)
        {
            assert!(Instant::now() < limit);
            std::thread::sleep(Duration::from_millis(2));
        }
        let other = start(&service, json!({"action":"read_file","skillId":"two"}));
        service.wait(&other).unwrap();
        assert!(service.wait(&task).unwrap()["skills"].is_array());
        service.release_compat(&task);
        assert!(service.get(&task, true).is_err());
    }

    #[test]
    fn deduplicated_compatibility_callers_each_hold_their_completion_until_read() {
        let (_dir, service) = fixture();
        let (hold_id, latch) = new_latch();
        let first = service
            .start(
                json!({"action":"refresh","skillId":"one","localOnly":true,"hold":hold_id}),
                None,
                None,
                true,
                false,
                fake_dispatch,
            )
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        entered(&latch);
        let second = service
            .start(
                json!({"action":"refresh","skillIds":["one"],"localOnly":true}),
                None,
                None,
                true,
                false,
                fake_dispatch,
            )
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(first, second);
        assert_eq!(service.jobs.lock().unwrap()[&first].consumers, 2);
        release(&latch);
        service.wait(&first).unwrap();
        service.release_compat(&first);
        let other = start(&service, json!({"action":"read_file","skillId":"two"}));
        service.wait(&other).unwrap();
        service.wait(&second).unwrap();
        service.release_compat(&second);
        assert!(service.get(&first, true).is_err());
    }

    #[test]
    fn awaited_compatibility_execution_does_not_accumulate_invisible_results() {
        let (_dir, service) = fixture();
        for _ in 0..40 {
            service
                .execute(json!({"action":"read_file","skillId":"one"}), fake_dispatch)
                .unwrap();
        }
        assert!(service.jobs.lock().unwrap().is_empty());
        assert!(service.list().unwrap().is_empty());
        assert!(service
            .manager
            .lock()
            .unwrap()
            .task_history()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn management_annotations_recheck_live_skill_after_worker_snapshot() {
        fn paused_annotation(manager: &mut Manager, request: &Value) -> Result<Value, String> {
            assert!(manager.skill("one").is_ok());
            hold(request["hold"].as_str().unwrap())?;
            let mut business = request.clone();
            business.as_object_mut().unwrap().remove("hold");
            crate::dispatch(manager, &business)
        }
        let (_dir, service) = fixture();
        let original = service.execute(json!({"action":"skill_annotation_set","skillId":"one","expectedRevision":0,"alias":"retained","notes":"personal notes"}), crate::dispatch).unwrap();
        let (gate, latch) = new_latch();
        let worker_service = service.clone();
        let worker = std::thread::spawn(move || {
            worker_service.execute(json!({"action":"skill_annotation_set","skillId":"one","expectedRevision":1,"alias":"stale","notes":"overwrite","hold":gate}), paused_annotation)
        });
        entered(&latch);
        {
            let mut live = service.manager.lock().unwrap();
            live.state.skills.retain(|skill| skill["id"] != "one");
            live.save().unwrap();
        }
        let snapshot = service.snapshot().unwrap();
        release(&latch);
        assert!(worker
            .join()
            .unwrap()
            .unwrap_err()
            .contains("no longer exists"));
        assert_eq!(
            service
                .execute(json!({"action":"management_data"}), crate::dispatch)
                .unwrap(),
            original
        );
        assert_eq!(service.snapshot().unwrap(), snapshot);
    }

    #[test]
    fn invocation_templates_share_catalog_and_execution_locks_and_prepare_is_read_only() {
        let (_dir, service) = fixture();
        let manager = service.manager.lock().unwrap();
        let invoke =
            resources_for(&manager, &json!({"action":"resource_invoke","id":"tool"})).unwrap();
        let configure = resources_for(
            &manager,
            &json!({"action":"resource_action_set","id":"tool"}),
        )
        .unwrap();
        let save = resources_for(
            &manager,
            &json!({"action":"resource_template_save","id":"tool"}),
        )
        .unwrap();
        let remove = resources_for(
            &manager,
            &json!({"action":"resource_template_remove","id":"tool"}),
        )
        .unwrap();
        let prepare = resources_for(
            &manager,
            &json!({"action":"resource_template_prepare","id":"tool"}),
        )
        .unwrap();
        assert!(conflicts(&save, &invoke));
        assert!(conflicts(&save, &configure));
        assert!(conflicts(&remove, &save));
        assert!(conflicts(&prepare, &save));
        assert!(conflicts(&prepare, &configure));
        assert!(!conflicts(&prepare, &prepare));
        assert!(read_request(&json!({"action":"resource_templates"})));
        assert!(read_request(&json!({"action":"resource_template_prepare"})));
        assert!(!read_request(&json!({"action":"resource_template_save"})));
    }

    #[test]
    fn resource_relations_recheck_live_endpoints_after_worker_snapshot_and_read_live_names() {
        fn paused_relation(manager: &mut Manager, request: &Value) -> Result<Value, String> {
            assert!(manager.skill("one").is_ok());
            hold(request["hold"].as_str().unwrap())?;
            let mut business = request.clone();
            business.as_object_mut().unwrap().remove("hold");
            crate::dispatch_local(manager, &business)
        }
        fn stale_reader(manager: &mut Manager, request: &Value) -> Result<Value, String> {
            manager.state.skills[0]["name"] = json!("stale worker name");
            crate::dispatch(manager, request)
        }
        let (_dir, service) = fixture();
        let snapshot = service
            .execute(
                json!({"action":"resource_relations","endpoint":{"kind":"skill","id":"one"}}),
                stale_reader,
            )
            .unwrap();
        assert_eq!(snapshot["endpoint"]["name"], "one");
        let (gate, latch) = new_latch();
        let worker_service = service.clone();
        let worker = std::thread::spawn(move || {
            worker_service.execute(json!({"action":"resource_relation_add","dependent":{"kind":"skill","id":"one"},"dependency":{"kind":"skill","id":"two"},"expectedRevision":0,"hold":gate}),paused_relation)
        });
        entered(&latch);
        {
            let mut live = service.manager.lock().unwrap();
            live.state.skills.retain(|skill| skill["id"] != "one");
            live.save().unwrap();
        }
        let revision = service.snapshot().unwrap()["stateRevision"].clone();
        release(&latch);
        assert!(worker.join().unwrap().unwrap_err().contains("端点不存在"));
        let listed = service
            .execute(
                json!({"action":"resource_relations","endpoint":{"kind":"skill","id":"two"}}),
                crate::dispatch,
            )
            .unwrap();
        assert_eq!(listed["revision"], 0);
        assert_eq!(listed["dependents"], json!([]));
        assert_eq!(service.snapshot().unwrap()["stateRevision"], revision);
    }

    #[test]
    fn relation_writes_exclude_catalog_and_lifecycle_mutations_but_reads_share() {
        let (_dir, service) = fixture();
        let manager = service.manager.lock().unwrap();
        let add = resources_for(&manager, &json!({"action":"resource_relation_add"})).unwrap();
        let remove =
            resources_for(&manager, &json!({"action":"resource_relation_remove"})).unwrap();
        let read = resources_for(&manager, &json!({"action":"resource_relations"})).unwrap();
        let catalog =
            resources_for(&manager, &json!({"action":"resource_update","id":"tool"})).unwrap();
        let removal = resources_for(
            &manager,
            &json!({"action":"apply_resource_remove","id":"tool"}),
        )
        .unwrap();
        assert!(conflicts(&add, &catalog));
        assert!(conflicts(&add, &removal));
        assert!(conflicts(&remove, &removal));
        assert!(conflicts(&read, &add));
        assert!(!conflicts(&read, &read));
        assert!(read_request(&json!({"action":"resource_relations"})));
        assert!(!read_request(&json!({"action":"resource_relation_add"})));
    }

    struct AssociationServer {
        repo: String,
        endpoint: String,
        stop: Arc<AtomicBool>,
        gate: Latch,
        worker: Option<std::thread::JoinHandle<()>>,
    }
    impl AssociationServer {
        fn new() -> Self {
            use std::io::{Read, Write};
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let endpoint = format!("http://{}/", listener.local_addr().unwrap());
            let repo = format!(
                "synthetic-protocol/association-writer-{}",
                uuid::Uuid::new_v4()
            );
            let expected_repo = repo.clone();
            let stop = Arc::new(AtomicBool::new(false));
            let stopped = stop.clone();
            let (gate_id, gate) = new_latch();
            let worker = std::thread::spawn(move || {
                let mut branch_reads = 0;
                while !stopped.load(Ordering::Relaxed) {
                    let (mut stream, _) = match listener.accept() {
                        Ok(connection) => connection,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(2));
                            continue;
                        }
                        Err(error) => panic!("synthetic listener failed: {error}"),
                    };
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(3)))
                        .unwrap();
                    let mut bytes = Vec::new();
                    while !bytes.windows(4).any(|part| part == b"\r\n\r\n") {
                        let mut buffer = [0; 4096];
                        let count = stream.read(&mut buffer).unwrap();
                        assert_ne!(count, 0);
                        bytes.extend_from_slice(&buffer[..count]);
                        assert!(bytes.len() < 64 * 1024);
                    }
                    let headers = String::from_utf8(bytes).unwrap();
                    let mut request = headers.lines().next().unwrap().split_whitespace();
                    assert_eq!(request.next(), Some("GET"));
                    let target = request.next().unwrap().split('?').next().unwrap();
                    let route = target
                        .strip_prefix(&format!("/repos/{expected_repo}"))
                        .unwrap();
                    let commit = "1111111111111111111111111111111111111111";
                    let tree = "2222222222222222222222222222222222222222";
                    let body = match route {
                        "" => {
                            json!({"private":false,"default_branch":"main","full_name":expected_repo})
                        }
                        "/commits/main" => {
                            branch_reads += 1;
                            // The apply worker passed its initial guard; pause actual
                            // HTTP I/O before its eventual live-writer save.
                            if branch_reads == 2 {
                                hold(&gate_id).unwrap();
                            }
                            json!({"sha":commit,"commit":{"tree":{"sha":tree}}})
                        }
                        "/git/trees/2222222222222222222222222222222222222222" => {
                            json!({"sha":tree,"truncated":false,"tree":[
                            {"path":"chosen/SKILL.md","mode":"100644","type":"blob","sha":"3333333333333333333333333333333333333333","size":10}]})
                        }
                        _ => panic!("unexpected synthetic route: {route}"),
                    };
                    let body = serde_json::to_vec(&body).unwrap();
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
                    stream.write_all(&body).unwrap();
                    stream.shutdown(std::net::Shutdown::Write).unwrap();
                    let mut remaining = [0; 256];
                    while stream.read(&mut remaining).is_ok_and(|count| count > 0) {}
                }
            });
            Self {
                repo,
                endpoint,
                stop,
                gate,
                worker: Some(worker),
            }
        }
        fn request(&self, mut business: Value) -> Value {
            business["testRepo"] = json!(self.repo);
            business["testEndpoint"] = json!(self.endpoint);
            business
        }
    }
    impl Drop for AssociationServer {
        fn drop(&mut self) {
            release(&self.gate);
            self.stop.store(true, Ordering::Relaxed);
            if let Some(worker) = self.worker.take() {
                worker.join().unwrap();
            }
        }
    }
    fn association_dispatch(manager: &mut Manager, request: &Value) -> Result<Value, String> {
        let _transport = crate::remote::github::test_transport(
            request["testRepo"].as_str().unwrap(),
            request["testEndpoint"].as_str().unwrap(),
        );
        let mut business = request.clone();
        business.as_object_mut().unwrap().remove("testRepo");
        business.as_object_mut().unwrap().remove("testEndpoint");
        crate::dispatch_local(manager, &business)
    }

    #[test]
    fn association_live_writer_rejects_source_or_placeholder_changes_during_remote_io() {
        for change in ["source", "placeholder", "none"] {
            let (dir, service) = fixture();
            let server = AssociationServer::new();
            let local = dir.path().join("skill");
            std::fs::create_dir(&local).unwrap();
            std::fs::write(local.join("SKILL.md"), b"local bytes stay unchanged").unwrap();
            {
                let mut manager = service.manager.lock().unwrap();
                manager.state.skills[0]["localPath"] = json!(local);
                manager.state.sources.push(json!({"id":"chosen-source","repo":server.repo,"branch":"main","roots":[],"ignoredPaths":[]}));
                manager.state.skills.push(json!({"id":"placeholder","name":"original placeholder","sourceId":"chosen-source","remotePath":"chosen","localPath":null}));
                manager.save().unwrap();
            }
            let preview = service.execute(server.request(json!({"action":"preview_associate","skillId":"one","sourceId":"chosen-source","remotePath":"chosen"})), association_dispatch).unwrap();
            assert_eq!(preview["canApply"], true);
            let request =
                server.request(json!({"action":"apply_associate","previewId":preview["id"]}));
            let other = service.clone();
            let applying = std::thread::spawn(move || other.execute(request, association_dispatch));
            entered(&server.gate);
            {
                let mut manager = service.manager.lock().unwrap();
                match change {
                    "source" => {
                        manager
                            .state
                            .sources
                            .iter_mut()
                            .find(|s| s["id"] == "chosen-source")
                            .unwrap()["roots"] = json!(["concurrent/scope"])
                    }
                    "placeholder" => {
                        manager
                            .state
                            .skills
                            .iter_mut()
                            .find(|s| s["id"] == "placeholder")
                            .unwrap()["name"] = json!("concurrent placeholder")
                    }
                    "none" => {}
                    _ => unreachable!(),
                }
                if change != "none" {
                    manager.save().unwrap();
                }
            }
            let expected = service.snapshot().unwrap();
            let expected_stored =
                serde_json::to_value(&service.manager.lock().unwrap().state).unwrap();
            release(&server.gate);
            let result = applying.join().unwrap();
            if change == "none" {
                let saved = result.unwrap();
                assert_eq!(
                    saved["skills"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|s| s["id"] == "one")
                        .unwrap()["sourceId"],
                    "chosen-source"
                );
                assert!(!saved["skills"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|s| s["id"] == "placeholder"));
                let reopened = Manager::new(dir.path().into()).unwrap();
                assert_eq!(reopened.skill("one").unwrap()["remotePath"], "chosen");
            } else {
                let error = result.unwrap_err();
                assert!(
                    if change == "source" {
                        error.contains("Source mapping changed")
                    } else {
                        error.contains("占位记录")
                    },
                    "{change}: {error}"
                );
                let actual = service.snapshot().unwrap();
                for field in ["skills", "sources", "connections", "stateRevision"] {
                    assert_eq!(actual[field], expected[field], "{change}: {field}");
                }
                let reopened = Manager::new(dir.path().into()).unwrap();
                assert_eq!(
                    serde_json::to_value(reopened.state).unwrap()["skills"],
                    expected_stored["skills"]
                );
            }
            assert_eq!(
                std::fs::read(local.join("SKILL.md")).unwrap(),
                b"local bytes stay unchanged"
            );
            assert!(!service
                .manager
                .lock()
                .unwrap()
                .previews
                .contains_key(preview["id"].as_str().unwrap()));
        }
    }

    #[test]
    fn source_previews_share_reads_and_source_applications_exclude_catalogue_invocation_and_discovery(
    ) {
        let (_dir, service) = fixture();
        let mut manager = service.manager.lock().unwrap();
        manager.previews.insert(
            "tool-source".into(),
            json!({"kind":"resourceSource","resourceId":"tool","public":{"kind":"resourceSource"}}),
        );
        manager.previews.insert(
            "skill-source".into(),
            json!({"public":{"kind":"associate","skillId":"one"},"placeholders":[{"id":"two"}]}),
        );
        let tool_preview = resources_for(
            &manager,
            &json!({"action":"preview_resource_source","id":"tool"}),
        )
        .unwrap();
        let tool_apply = resources_for(
            &manager,
            &json!({"action":"apply_resource_source","previewId":"tool-source"}),
        )
        .unwrap();
        let catalog =
            resources_for(&manager, &json!({"action":"resource_update","id":"tool"})).unwrap();
        let invoke =
            resources_for(&manager, &json!({"action":"resource_invoke","id":"tool"})).unwrap();
        let other_invoke =
            resources_for(&manager, &json!({"action":"resource_invoke","id":"other"})).unwrap();
        assert!(conflicts(&tool_preview, &catalog));
        assert!(conflicts(&tool_preview, &invoke));
        assert!(conflicts(&tool_apply, &catalog));
        assert!(conflicts(&tool_apply, &invoke));
        assert!(conflicts(&tool_apply, &tool_preview));
        assert!(!conflicts(&tool_preview, &tool_preview));
        assert!(!conflicts(&tool_apply, &other_invoke));
        let skill_preview = resources_for(
            &manager,
            &json!({"action":"preview_associate","skillId":"one"}),
        )
        .unwrap();
        let skill_apply = resources_for(
            &manager,
            &json!({"action":"apply_associate","previewId":"skill-source"}),
        )
        .unwrap();
        let discovery = resources_for(&manager, &json!({"action":"add_github"})).unwrap();
        let read =
            resources_for(&manager, &json!({"action":"get_document","skillId":"one"})).unwrap();
        let placeholder_write =
            resources_for(&manager, &json!({"action":"apply_update","skillId":"two"})).unwrap();
        assert!(conflicts(&skill_preview, &discovery));
        assert!(conflicts(&skill_apply, &discovery));
        assert!(conflicts(&skill_apply, &read));
        assert!(conflicts(&skill_apply, &placeholder_write));
        assert!(!conflicts(&skill_preview, &read));
        assert!(!conflicts(&skill_preview, &skill_preview));
        assert!(read_request(&json!({"action":"preview_associate"})));
        assert!(read_request(&json!({"action":"skill_source_health"})));
        assert!(!read_request(&json!({"action":"apply_associate"})));
        assert!(!read_request(&json!({"action":"apply_resource_source"})));
    }

    #[test]
    fn basic_mode_keeps_saved_source_reads_and_rejects_network_checks_and_rebinding() {
        let (dir, service) = fixture();
        let root = dir.path().join("registered-tool");
        std::fs::create_dir(&root).unwrap();
        let record = {
            let mut manager = service.manager.lock().unwrap();
            let record = crate::resources::handle(&manager, &json!({"action":"resource_register","name":"Saved source","kind":"cli","rootPath":root,"repository":"https://github.com/example/recorded"})).unwrap().unwrap()["resource"].clone();
            manager.basic_mode = true;
            record
        };
        let before = service.snapshot().unwrap();
        let saved = service
            .execute(
                json!({"action":"resource_source","id":record["id"]}),
                crate::dispatch,
            )
            .unwrap();
        assert_eq!(saved["repository"], "https://github.com/example/recorded");
        for request in [
            json!({"action":"resource_source_health","id":record["id"],"expectedRevision":record["revision"]}),
            json!({"action":"preview_resource_source","id":record["id"],"expectedRevision":record["revision"],"repository":"https://github.com/example/replacement"}),
            json!({"action":"apply_resource_source","previewId":"unusable"}),
            json!({"action":"skill_source_health","skillId":"one"}),
            json!({"action":"preview_associate","skillId":"one","sourceId":"source","remotePath":""}),
            json!({"action":"apply_associate","previewId":"unusable"}),
        ] {
            let action = request["action"].clone();
            let error = service.execute(request, crate::dispatch_local).unwrap_err();
            assert!(error.contains("基本模式"), "{action}: {error}");
        }
        let after = service.snapshot().unwrap();
        for field in ["skills", "sources", "stateRevision"] {
            assert_eq!(after[field], before[field]);
        }
        assert!(root.is_dir());
    }

    fn spawn_admission_fixture() -> (
        tempfile::TempDir,
        Arc<TaskSystem>,
        crate::resource_runtime::PreparedInvocation,
    ) {
        let (dir, service) = fixture();
        let root = dir.path().join("never-launched-tool");
        std::fs::create_dir(&root).unwrap();
        let executable = root.join("never-launched.exe");
        std::fs::write(&executable, b"synthetic admission fixture; never executed").unwrap();
        let id = service.execute(
            json!({"action":"resource_register","name":"Admission fixture","kind":"cli","rootPath":root}),
            crate::dispatch,
        ).unwrap()["resource"]["id"].as_str().unwrap().to_owned();
        service.execute(
            json!({"action":"resource_action_set","id":id,"expectedRevision":1,"definition":{"id":"test","label":"Never launch","mode":"task","cancellable":true,"executable":executable,"workingDirectory":root,"args":[]}}),
            crate::dispatch_local,
        ).unwrap();
        let record: crate::resources::ResourceRecord = serde_json::from_value(
            service
                .manager
                .lock()
                .unwrap()
                .resource_store(crate::resources::StoreRequest::Get(id.clone()))
                .unwrap(),
        )
        .unwrap();
        let definition = crate::resource_runtime::verified_definition(&record, "test").unwrap();
        let request = crate::resource_runtime::PreparedInvocation {
            resource_id: id,
            revision: record.revision,
            definition,
            args: vec![],
        };
        (dir, service, request)
    }

    #[test]
    fn resource_spawn_verification_releases_writer_and_rechecks_live_admission() {
        struct ReleaseOnDrop(Latch);
        impl Drop for ReleaseOnDrop {
            fn drop(&mut self) {
                release(&self.0);
            }
        }
        for change in ["disabled", "revision", "action", "basic", "cancel"] {
            let (_dir, service, request) = spawn_admission_fixture();
            let id = request.resource_id.clone();
            let definition = serde_json::to_value(&request.definition).unwrap();
            let cancel = Arc::new(AtomicBool::new(false));
            let hook = WorkerHook {
                service: Arc::downgrade(&service),
                base: Some(Mutex::new(WorkerBase {
                    state: service.manager.lock().unwrap().state.clone(),
                    previews: HashMap::new(),
                    undo: vec![],
                    redo: vec![],
                })),
                action: "resource_invoke".into(),
                request: json!({"action":"resource_invoke","id":id,"actionId":"test"}),
                cancel: cancel.clone(),
                cancellable: true,
                commit_started: AtomicBool::new(false),
                internal_resource_automation: false,
                check_summary: None,
            };
            let (gate_id, gate) = new_latch();
            let _release = ReleaseOnDrop(gate.clone());
            let worker = std::thread::spawn(move || {
                hook.resource_spawn_with(request, |record, request| {
                    hold(&gate_id)?;
                    crate::resource_runtime::prepare_spawn(record, request)
                })
            });
            entered(&gate);
            // The preparation callback is paused: these operations must finish
            // before it is released, rather than merely meet a timing threshold.
            assert!(
                service.manager.try_lock().is_ok(),
                "{change}: live writer held during verification"
            );
            assert_eq!(
                service
                    .execute(
                        json!({"action":"resource_runtime","id":id}),
                        crate::dispatch,
                    )
                    .unwrap()["runs"],
                json!([])
            );
            match change {
                "disabled" => {
                    service.execute(
                    json!({"action":"resource_set_enabled","id":id,"expectedRevision":2,"enabled":false}), crate::dispatch,
                ).unwrap();
                }
                "revision" => {
                    service.execute(
                    json!({"action":"resource_update","id":id,"expectedRevision":2,"changes":{"notes":"changed while verifying"}}), crate::dispatch,
                ).unwrap();
                }
                "action" => {
                    let mut changed = definition;
                    changed["cancellable"] = json!(false);
                    service.execute(
                        json!({"action":"resource_action_set","id":id,"expectedRevision":2,"definition":changed}), crate::dispatch_local,
                    ).unwrap();
                }
                "basic" => service.manager.lock().unwrap().basic_mode = true,
                "cancel" => cancel.store(true, Ordering::Relaxed),
                _ => unreachable!(),
            }
            release(&gate);
            let error = worker.join().unwrap().unwrap_err();
            match change {
                "basic" => assert!(error.contains("基本模式"), "{error}"),
                "cancel" => assert_eq!(error, CANCELLED),
                _ => assert!(error.contains("资源或动作已改变"), "{change}: {error}"),
            }
            assert_eq!(
                service
                    .manager
                    .lock()
                    .unwrap()
                    .resource_runtime
                    .snapshot(Some(&id))
                    .unwrap()["runs"],
                json!([])
            );
        }
    }

    #[test]
    fn direct_resource_spawn_still_rechecks_executable_contents() {
        let (_dir, service, request) = spawn_admission_fixture();
        std::fs::write(
            &request.definition.executable,
            b"changed after initial verification",
        )
        .unwrap();
        let manager = service.manager.lock().unwrap();
        let error = manager.resource_spawn(request).unwrap_err();
        assert!(error.contains("摘要不一致"), "{error}");
        assert_eq!(
            manager.resource_runtime.snapshot(None).unwrap()["runs"],
            json!([])
        );
    }

    #[test]
    fn local_record_changes_lock_discovery_clients_references_and_server_preview_targets() {
        let (_dir, service) = fixture();
        let mut manager = service.manager.lock().unwrap();
        manager.state.skills[0]["localPath"] = json!("D:/synthetic/old");
        manager.state.skills[1]["localPath"] = json!("D:/synthetic/new");
        manager.state.connections = vec![
            json!({"id":"old-entry","skillId":"one","client":"codex","path":"D:/synthetic/codex/one"}),
            json!({"id":"duplicate-entry","skillId":"two","client":"claude","path":"D:/synthetic/claude/two"}),
        ];
        let original = manager.state.skills[0].clone();
        let duplicate = manager.state.skills[1].clone();
        manager.previews.insert(
            "relocate".into(),
            json!({
                "kind":"localRelocation", "original":original, "duplicate":duplicate,
                "draft":{"localPath":"D:/synthetic/new"},
                "public":{"skillId":"one","path":"D:/synthetic/new","duplicateId":"two"}
            }),
        );
        let forget = resources_for(&manager, &json!({"action":"forget","skillId":"one"})).unwrap();
        let relocating = resources_for(&manager, &json!({"action":"relocate_local","previewId":"relocate","skillId":"three","path":"D:/forged"})).unwrap();
        for locks in [&forget, &relocating] {
            for key in [
                "local:discovery",
                "sources:discovery",
                "skill:one",
                "client:codex",
            ] {
                assert!(
                    locks.iter().any(|lock| lock.key == key && lock.write),
                    "{key}: {locks:?}"
                );
            }
            for key in [
                "resource-catalog",
                "resource-relations",
                "resource-scenes",
                "management-data",
            ] {
                assert!(
                    locks.iter().any(|lock| lock.key == key && !lock.write),
                    "{key}: {locks:?}"
                );
            }
            for request in [
                json!({"action":"discover_local"}),
                json!({"action":"add_local","paths":["D:/synthetic/new"]}),
                json!({"action":"check_now"}),
                json!({"action":"resource_relation_add"}),
                json!({"action":"resource_scene_save"}),
                json!({"action":"resource_update","id":"tool"}),
                json!({"action":"skill_annotation_set","skillId":"one"}),
                json!({"action":"refresh_clients"}),
            ] {
                assert!(
                    conflicts(locks, &resources_for(&manager, &request).unwrap()),
                    "{request}: {locks:?}"
                );
            }
        }
        assert!(forget
            .iter()
            .any(|lock| lock.key == "client:cursor" && lock.write));
        assert!(!relocating.iter().any(|lock| lock.key == "client:cursor"));
        assert!(relocating
            .iter()
            .any(|lock| lock.key == "skill:two" && lock.write));
        for path in [
            "D:/synthetic/old",
            "D:/synthetic/new",
            "D:/synthetic/claude/two",
        ] {
            let prefix = if path.contains("claude") {
                "entry"
            } else {
                "directory"
            };
            assert!(relocating
                .iter()
                .any(|lock| lock.key == format!("{prefix}:{}", path_key(path)) && lock.write));
        }
        assert!(!relocating
            .iter()
            .any(|lock| lock.key == "skill:three" || lock.key.contains("forged")));
        let preview = resources_for(
            &manager,
            &json!({"action":"preview_relocate_local","skillId":"one","path":"D:/synthetic/new"}),
        )
        .unwrap();
        assert!(!conflicts(&preview, &preview));
        assert!(conflicts(&preview, &relocating));
        assert!(read_request(&json!({"action":"preview_relocate_local"})));
        assert!(!read_request(&json!({"action":"relocate_local"})));
        assert!(!read_request(&json!({"action":"forget"})));
    }

    struct LocalRecordLatchRelease(Latch);
    impl Drop for LocalRecordLatchRelease {
        fn drop(&mut self) {
            release(&self.0);
        }
    }

    fn paused_local_record_removal(
        manager: &mut Manager,
        request: &Value,
    ) -> Result<Value, String> {
        let removed = text(request, "removedId")?;
        crate::local::guard_skill_record_removal(manager, removed)?;
        manager.state.skills.retain(|skill| skill["id"] != removed);
        // Model the interval after a handler's initial checks and before its
        // state save; the real live writer must repeat reference admission.
        hold(text(request, "hold")?)?;
        manager.save()?;
        Ok(manager.snapshot())
    }

    #[test]
    fn local_record_live_writer_rechecks_new_relations_and_scene_references() {
        for reference in ["relation", "scene"] {
            let (_dir, service) = fixture();
            let (gate, latch) = new_latch();
            let _release = LocalRecordLatchRelease(latch.clone());
            let worker_service = service.clone();
            let worker = std::thread::spawn(move || {
                worker_service.execute(
                    json!({"action":"forget","skillId":"one","removedId":"one","hold":gate}),
                    paused_local_record_removal,
                )
            });
            entered(&latch);
            {
                let live = service.manager.lock().unwrap();
                let endpoint = crate::resource_relations::Endpoint {
                    kind: "skill".into(),
                    id: "one".into(),
                };
                if reference == "relation" {
                    live.relation_store(crate::resource_relations::StoreRequest::Add {
                        dependent: endpoint,
                        dependency: crate::resource_relations::Endpoint {
                            kind: "skill".into(),
                            id: "two".into(),
                        },
                        expected_revision: 0,
                    })
                    .unwrap();
                } else {
                    live.scene_store(crate::resource_scenes::StoreRequest::Save {
                        id: None,
                        expected_revision: 0,
                        name: "New live reference".into(),
                        members: vec![endpoint],
                    })
                    .unwrap();
                }
            }
            let retained = service.snapshot().unwrap();
            release(&latch);
            let error = worker.join().unwrap().unwrap_err();
            assert!(
                error.contains(if reference == "relation" {
                    "依赖或使用关系"
                } else {
                    "场景"
                }),
                "{error}"
            );
            assert_eq!(service.snapshot().unwrap(), retained);
        }
    }

    #[test]
    fn local_record_live_writer_preserves_new_duplicate_annotations_and_connections() {
        for change in ["annotation", "connection"] {
            let (_dir, service) = fixture();
            {
                let mut live = service.manager.lock().unwrap();
                // The final merge is about to drop only the duplicate at the
                // retained ID's target. No physical file operation is involved.
                live.state.skills[0]["localPath"] = json!("D:/synthetic/target");
                live.state.skills[1]["localPath"] = json!("D:/synthetic/target");
                live.save().unwrap();
            }
            let (gate, latch) = new_latch();
            let _release = LocalRecordLatchRelease(latch.clone());
            let worker_service = service.clone();
            let worker = std::thread::spawn(move || {
                worker_service.execute(
                    json!({"action":"relocate_local","removedId":"two","hold":gate}),
                    paused_local_record_removal,
                )
            });
            entered(&latch);
            {
                let mut live = service.manager.lock().unwrap();
                if change == "annotation" {
                    live.management_store(crate::management_data::StoreRequest::AnnotationSet {
                        skill_id: "two".into(),
                        expected_revision: 0,
                        alias: "Keep alias".into(),
                        notes: "Keep new note".into(),
                    })
                    .unwrap();
                } else {
                    live.state.connections.push(json!({"id":"new","skillId":"two","client":"codex","path":"D:/synthetic/entry"}));
                    live.save().unwrap();
                }
            }
            let retained = service.snapshot().unwrap();
            let annotations = service
                .manager
                .lock()
                .unwrap()
                .management_store(crate::management_data::StoreRequest::List)
                .unwrap();
            release(&latch);
            let error = worker.join().unwrap().unwrap_err();
            assert!(
                error.contains(if change == "annotation" {
                    "别名或备注"
                } else {
                    "客户端连接"
                }),
                "{error}"
            );
            assert_eq!(service.snapshot().unwrap(), retained);
            assert_eq!(
                service
                    .manager
                    .lock()
                    .unwrap()
                    .management_store(crate::management_data::StoreRequest::List)
                    .unwrap(),
                annotations
            );
        }
    }

    #[test]
    fn local_record_forget_cas_preserves_live_favorite_and_undo_history() {
        let (_dir, service) = fixture();
        let (gate, latch) = new_latch();
        let _release = LocalRecordLatchRelease(latch.clone());
        let worker_service = service.clone();
        let worker = std::thread::spawn(move || {
            worker_service.execute(
                json!({"action":"forget","skillId":"one","removedId":"one","hold":gate}),
                paused_local_record_removal,
            )
        });
        entered(&latch);
        {
            let mut live = service.manager.lock().unwrap();
            crate::categories::handle(
                &mut live,
                &json!({"action":"set_favorite","skillId":"one","favorite":true}),
            )
            .unwrap()
            .unwrap();
        }
        let retained = service.snapshot().unwrap();
        let history = service.manager.lock().unwrap().management_undo.clone();
        release(&latch);
        let error = worker.join().unwrap().unwrap_err();
        assert!(error.contains("记录在任务运行期间发生变化"), "{error}");
        assert_eq!(service.snapshot().unwrap(), retained);
        assert_eq!(service.manager.lock().unwrap().management_undo, history);
        assert!(service.manager.lock().unwrap().skill("one").unwrap()["favorite"] == true);
    }

    #[test]
    fn local_record_tasks_are_blocked_before_worker_launch_in_basic_mode() {
        let (_dir, service) = fixture();
        service.manager.lock().unwrap().basic_mode = true;
        for action in ["forget", "relocate_local", "preview_relocate_local"] {
            let error = service.execute(json!({"action":action,"skillId":"one","path":"D:/unused","previewId":"unused"}), |_, _| panic!("basic mode must reject before dispatch")).unwrap_err();
            assert!(error.contains("基本模式"), "{error}");
        }
        assert!(service.jobs.lock().unwrap().is_empty());
    }

    #[test]
    fn local_record_tasks_publish_relocation_preview_and_forget_without_file_changes() {
        let (dir, service) = fixture();
        let old = dir.path().join("before");
        let new = dir.path().join("after");
        std::fs::create_dir(&old).unwrap();
        let bytes =
            b"---\nname: relocated\ndescription: synthetic\n---\nRetain the only runtime bytes.\n";
        std::fs::write(old.join("SKILL.md"), bytes).unwrap();
        {
            let mut live = service.manager.lock().unwrap();
            let mut original = crate::local::draft(&old).unwrap();
            original["id"] = json!("one");
            original["favorite"] = json!(true);
            live.upsert_skill(original);
            live.save().unwrap();
        }
        std::fs::rename(&old, &new).unwrap();
        let preview = service
            .execute(
                json!({"action":"preview_relocate_local","skillId":"one","path":new}),
                crate::dispatch_local,
            )
            .unwrap();
        assert_eq!(preview["kind"], "localRelocation");
        assert_eq!(preview["canApply"], true);
        assert!(service
            .manager
            .lock()
            .unwrap()
            .previews
            .contains_key(preview["id"].as_str().unwrap()));
        let moved = service
            .execute(
                json!({"action":"relocate_local","previewId":preview["id"]}),
                crate::dispatch_local,
            )
            .unwrap();
        let retained = moved["skills"]
            .as_array()
            .unwrap()
            .iter()
            .find(|skill| skill["id"] == "one")
            .unwrap();
        assert_eq!(
            path_key(retained["localPath"].as_str().unwrap()),
            path_key(new.to_str().unwrap())
        );
        assert_eq!(retained["favorite"], true);
        assert!(!service
            .manager
            .lock()
            .unwrap()
            .previews
            .contains_key(preview["id"].as_str().unwrap()));
        let forgotten = service
            .execute(
                json!({"action":"forget","skillId":"one"}),
                crate::dispatch_local,
            )
            .unwrap();
        assert!(forgotten["skills"]
            .as_array()
            .unwrap()
            .iter()
            .all(|skill| skill["id"] != "one"));
        assert!(forgotten["ignoredLocalPaths"]
            .as_array()
            .unwrap()
            .iter()
            .any(|path| path_key(path.as_str().unwrap()) == path_key(new.to_str().unwrap())));
        assert_eq!(std::fs::read(new.join("SKILL.md")).unwrap(), bytes);
    }

    #[test]
    fn local_record_preview_publication_bounds_merged_family_and_keeps_new_same_millisecond_id() {
        fn paused_preview(manager: &mut Manager, request: &Value) -> Result<Value, String> {
            let id = text(request, "newPreviewId")?;
            let public = json!({"id":id,"kind":"localRelocation","skillId":"one","canApply":true});
            manager.previews.insert(
                id.into(),
                json!({"kind":"localRelocation","public":public,"createdAt":request["createdAt"]}),
            );
            hold(text(request, "hold")?)?;
            Ok(public)
        }
        let (_dir, service) = fixture();
        let now = chrono::Utc::now().timestamp_millis();
        let unrelated = json!({"kind":"update","createdAt":0,"keep":"old-family"});
        let export = json!({"kind":"export_plan","createdAt":0,"keep":"export-family"});
        {
            let mut live = service.manager.lock().unwrap();
            for index in 0..32 {
                live.previews.insert(
                    format!("existing-{index:02}"),
                    json!({"kind":"localRelocation","createdAt":now}),
                );
            }
            live.previews.insert(
                "expired-local".into(),
                json!({"kind":"localRelocation","createdAt":now-30*60*1000-1}),
            );
            live.previews
                .insert("undated-local".into(), json!({"kind":"localRelocation"}));
            live.previews.insert("unrelated".into(), unrelated.clone());
            live.previews.insert("export".into(), export.clone());
        }
        let (gate, latch) = new_latch();
        let _release = LocalRecordLatchRelease(latch.clone());
        let worker_service = service.clone();
        let worker = std::thread::spawn(move || {
            worker_service.execute(
            json!({"action":"preview_relocate_local","skillId":"one","path":"D:/synthetic/target","newPreviewId":"000-new-preview","createdAt":now,"hold":gate}), paused_preview)
        });
        entered(&latch);
        {
            let mut live = service.manager.lock().unwrap();
            for index in 0..20 {
                live.previews.insert(
                    format!("concurrent-{index:02}"),
                    json!({"kind":"localRelocation","createdAt":now}),
                );
            }
        }
        release(&latch);
        let public = worker.join().unwrap().unwrap();
        assert_eq!(public["id"], "000-new-preview");
        let live = service.manager.lock().unwrap();
        assert_eq!(
            live.previews
                .values()
                .filter(|preview| preview["kind"] == "localRelocation")
                .count(),
            32
        );
        assert_eq!(live.previews["000-new-preview"]["public"], public);
        assert!(!live.previews.contains_key("expired-local"));
        assert!(!live.previews.contains_key("undated-local"));
        assert_eq!(live.previews["unrelated"], unrelated);
        assert_eq!(live.previews["export"], export);
    }
}
