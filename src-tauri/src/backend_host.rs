//! The GUI and local MCP transport share one in-process service and writer.
#![cfg(windows)]
use crate::{
    backend_ipc::{Claim, Endpoint, InstanceGuard, Server},
    mcp,
    tasks::TaskSystem,
    workspace::WorkspaceSystem,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Child,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::Manager;

const SCOPE: &str = "io.skillmanager.desktop";
const PROTOCOL: u32 = 1;

pub(crate) struct Host {
    endpoint: Endpoint,
    // A Windows mutex must be released on the claiming thread, after IPC stops.
    guard: InstanceGuard,
    server: Arc<Mutex<Option<Server>>>,
    app: Arc<Mutex<Option<tauri::AppHandle>>>,
}

fn status(endpoint: &Endpoint) -> Result<Value, String> {
    endpoint.request(
        &json!({"protocol":PROTOCOL,"kind":"status"}),
        Duration::from_secs(2),
    )
}
fn wait_ready(endpoint: &Endpoint, mut child: Option<&mut Child>) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let result = status(endpoint);
        if result.as_ref().is_ok_and(|value| value["ready"] == true) {
            return result;
        }
        if let Some(child) = child.as_deref_mut() {
            if let Some(exit) = child.try_wait().map_err(|error| error.to_string())? {
                return Err(format!(
                    "管理后台在就绪前已退出（{exit}）；启动诊断已写入标准错误，没有重试启动或打开另一数据库。"
                ));
            }
        }
        if Instant::now() >= deadline {
            return Err(result.err().unwrap_or_else(|| {
                "后台尚未完成初始化，请稍后重新打开；没有启动另一写入进程".into()
            }));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
fn same_directory(expected: &Path, actual: &Path) -> bool {
    std::fs::canonicalize(expected)
        .ok()
        .zip(std::fs::canonicalize(actual).ok())
        .is_some_and(|(left, right)| {
            left.to_string_lossy()
                .eq_ignore_ascii_case(&right.to_string_lossy())
        })
}
fn check_target(status: &Value, expected: Option<&Path>, basic_mode: bool) -> Result<(), String> {
    if status["basicMode"].as_bool() != Some(basic_mode) {
        return Err(
            "已有后台的启动模式不同。请先完全退出该实例，再打开所选模式；不会另开写入方。".into(),
        );
    }
    if let Some(expected) = expected {
        let actual = status["dataDir"].as_str().ok_or("后台未返回数据目录")?;
        if !same_directory(expected, Path::new(actual)) {
            return Err(format!(
                "已有后台正在使用 {actual}；本次选择 {}。请先完全退出已有实例再切换目录。",
                expected.display()
            ));
        }
    }
    Ok(())
}

impl Host {
    fn primary(endpoint: Endpoint, guard: InstanceGuard) -> Self {
        Self {
            endpoint,
            guard,
            server: Arc::new(Mutex::new(None)),
            app: Arc::new(Mutex::new(None)),
        }
    }
    /// Called before Storage::load, migration recovery, or opening SQLite.
    pub(crate) fn claim(
        expected: Option<&Path>,
        basic_mode: bool,
        background: bool,
    ) -> Result<Option<Self>, String> {
        let endpoint = Endpoint::current_user(SCOPE)?;
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            // The old process may actually have exited/restarted while we wait.
            // Only a fresh kernel ownership claim permits opening storage; a
            // failed observation or deadline alone never creates a new writer.
            if let Claim::Primary(guard) = endpoint.claim()? {
                return Ok(Some(Self::primary(endpoint, guard)));
            }
            let state = status(&endpoint);
            if let Ok(state) = &state {
                if state["ready"] == true {
                    check_target(state, expected, basic_mode)?;
                    if !background {
                        if let Err(error) = endpoint.request(&json!({"protocol":PROTOCOL,"kind":"activate","basicMode":basic_mode,"dataDir":expected}),Duration::from_secs(5)) {
                            // Do not replay an uncertain activation against a
                            // still-live instance. Only take over after exit.
                            return match endpoint.claim()? {
                                Claim::Primary(guard) => Ok(Some(Self::primary(endpoint, guard))),
                                Claim::Existing => Err(error),
                            };
                        }
                    }
                    return Ok(None);
                }
            }
            if Instant::now() >= deadline {
                return Err(state
                    .err()
                    .unwrap_or_else(|| "后台尚未完成初始化；没有启动另一写入进程".into()));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    pub(crate) fn ready_slot(&self) -> Arc<Mutex<Option<tauri::AppHandle>>> {
        self.app.clone()
    }
    /// Tauri restart can bypass stack destructors. Call this on RunEvent::Exit
    /// as well as after run_return; the main-thread InstanceGuard stays alive.
    pub(crate) fn shutdown_handle(&self) -> Arc<dyn Fn() + Send + Sync> {
        let server = self.server.clone();
        let app = self.app.clone();
        Arc::new(move || {
            if let Ok(mut app) = app.lock() {
                *app = None;
            }
            if let Ok(mut server) = server.lock() {
                // Keep the lock until stop finishes, so a repeated/concurrent
                // call cannot return early while workers still use the service.
                if let Some(server) = server.as_mut() {
                    server.stop();
                }
                *server = None;
            }
        })
    }
    pub(crate) fn start(
        &mut self,
        service: Arc<TaskSystem>,
        workspace: Arc<WorkspaceSystem>,
    ) -> Result<(), String> {
        let slot = self.app.clone();
        let mut server = self.server.lock().map_err(|_| "后台服务状态不可用")?;
        if server.is_some() {
            return Err("当前后台服务已经启动".into());
        }
        *server = Some(Server::start(
            &self.endpoint,
            &self.guard,
            Arc::new(move |request| {
                if request["protocol"] != PROTOCOL {
                    return Err("本地后台协议不匹配，请使用同一版本管理器".into());
                }
                let app = slot.lock().map_err(|_| "后台启动状态不可用")?.clone();
                let mut startup =
                    service.execute(json!({"action":"get_startup_status"}), crate::dispatch)?;
                startup["ready"] = json!(app.is_some());
                startup["processId"] = json!(std::process::id());
                match request["kind"].as_str() {
                    Some("status") => Ok(startup),
                    Some("activate") => {
                        let app = app.ok_or("后台尚未准备好")?;
                        let expected = request["dataDir"].as_str().map(Path::new);
                        let basic = request["basicMode"].as_bool().ok_or("缺少启动模式")?;
                        check_target(&startup, expected, basic)?;
                        let windows = workspace.clone();
                        let handle = app.clone();
                        app.run_on_main_thread(move || {
                            if let Err(error) = windows.show_windows(&handle) {
                                crate::startup_failure(&error);
                            }
                        })
                        .map_err(|error| error.to_string())?;
                        Ok(json!({"activationQueued":true}))
                    }
                    Some("tool") => {
                        if app.is_none() {
                            return Err("后台尚未准备好".into());
                        }
                        let name = request["name"].as_str().ok_or("缺少工具名")?;
                        mcp::call_backend(
                            &service,
                            name,
                            request
                                .get("arguments")
                                .cloned()
                                .unwrap_or_else(|| json!({})),
                        )
                    }
                    _ => Err("未知后台请求；不提供任意命令或本地人工确认路由".into()),
                }
            }),
        )?);
        Ok(())
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        self.shutdown_handle()();
    }
}

/// No database is opened here. Discovery/status never starts the application.
pub(crate) fn stdio(expected: Option<PathBuf>) -> Result<(), String> {
    let endpoint = Endpoint::current_user(SCOPE)?;
    mcp::serve(
        std::io::stdin().lock(),
        std::io::stdout().lock(),
        |name, arguments| {
            if name == "resource_invoke" && status(&endpoint).is_err() {
                match endpoint.claim()? {
                    Claim::Existing => {
                        wait_ready(&endpoint, None)?;
                    }
                    Claim::Primary(guard) => {
                        drop(guard);
                        use std::os::windows::process::CommandExt;
                        let mut command = std::process::Command::new(
                            std::env::current_exe().map_err(|error| error.to_string())?,
                        );
                        command
                            .arg("--background")
                            .creation_flags(0x08000000)
                            .stdin(std::process::Stdio::null())
                            .stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::inherit());
                        if let Some(path) = &expected {
                            command.arg("--data-dir").arg(path);
                        }
                        let mut child = command
                            .spawn()
                            .map_err(|error| format!("无法启动管理后台：{error}"))?;
                        wait_ready(&endpoint, Some(&mut child))?;
                    }
                }
            }
            let startup = status(&endpoint)?;
            // Basic mode may be inspected through MCP, but its own service rejects writes.
            if let Some(path) = &expected {
                check_target(
                    &startup,
                    Some(path),
                    startup["basicMode"].as_bool().unwrap_or(false),
                )?;
            }
            endpoint.request(
                &json!({"protocol":PROTOCOL,"kind":"tool","name":name,"arguments":arguments}),
                Duration::from_secs(30),
            )
        },
    )
}

pub(crate) fn tray(
    app: &tauri::AppHandle,
    workspace: Arc<WorkspaceSystem>,
    service: Arc<TaskSystem>,
) -> Result<(), String> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::TrayIconBuilder,
        Emitter,
    };
    let open = MenuItem::with_id(
        app,
        "open-manager",
        "打开 Agent 资源管理器",
        true,
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    let quit = MenuItem::with_id(app, "quit-manager", "完全退出管理器", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let menu = Menu::with_items(app, &[&open, &quit]).map_err(|error| error.to_string())?;
    let mut builder = TrayIconBuilder::with_id("agent-resource-manager")
        .menu(&menu)
        .tooltip("Agent 资源管理器 · 工具与任务在后台继续运行");
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder
        .on_menu_event(move |app, event| {
            if event.id.as_ref() == "open-manager" {
                if let Err(error) = workspace.show_windows(app) {
                    crate::startup_failure(&error);
                }
            } else if event.id.as_ref() == "quit-manager" {
                if let Some(window) = app.webview_windows().values().next() {
                    if let Err(error) = window.emit("workspace-request-quit", json!({})) {
                        crate::startup_failure(&error.to_string());
                    }
                } else {
                    let service = service.clone();
                    let handle = app.clone();
                    let workspace = workspace.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        match service.execute(json!({"action":"prepare_close"}), crate::dispatch) {
                            Ok(_) => handle.exit(0),
                            Err(error) => {
                                let _ = service
                                    .execute(json!({"action":"cancel_close"}), crate::dispatch);
                                let visible = handle.clone();
                                let _ = handle.run_on_main_thread(move || {
                                    let _ = workspace.show_windows(&visible);
                                    crate::startup_failure(&error);
                                });
                            }
                        }
                    });
                }
            }
        })
        .build(app)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shutdown_is_repeatable_and_keeps_ownership_until_host_drop() {
        let endpoint =
            Endpoint::current_user(&format!("synthetic-host-{}", uuid::Uuid::new_v4())).unwrap();
        let Claim::Primary(guard) = endpoint.claim().unwrap() else {
            panic!("unexpected test owner");
        };
        let server = Server::start(&endpoint, &guard, Arc::new(Ok)).unwrap();
        let host = Host {
            endpoint: endpoint.clone(),
            guard,
            server: Arc::new(Mutex::new(Some(server))),
            app: Arc::new(Mutex::new(None)),
        };
        let stop = host.shutdown_handle();
        assert_eq!(
            endpoint
                .request(&json!({"live":true}), Duration::from_secs(2))
                .unwrap()["live"],
            true
        );
        stop();
        stop();
        assert!(endpoint
            .request(&Value::Null, Duration::from_millis(100))
            .is_err());
        assert!(matches!(endpoint.claim().unwrap(), Claim::Existing));
        drop(host);
        assert!(matches!(endpoint.claim().unwrap(), Claim::Primary(_)));
    }

    #[test]
    #[ignore = "subprocess fixture for early startup failure"]
    fn synthetic_failed_backend_start() {
        std::process::exit(7);
    }

    #[test]
    fn startup_wait_detects_an_exited_child_without_waiting_for_the_full_deadline() {
        use std::os::windows::process::CommandExt;
        let endpoint =
            Endpoint::current_user(&format!("synthetic-failed-start-{}", uuid::Uuid::new_v4()))
                .unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "backend_host::tests::synthetic_failed_backend_start",
                "--ignored",
            ])
            .creation_flags(0x08000000)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let started = Instant::now();
        let error = wait_ready(&endpoint, Some(&mut child)).unwrap_err();
        assert!(error.contains("就绪前已退出"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(child.wait().unwrap().code(), Some(7));
    }

    #[test]
    fn existing_instance_cannot_silently_switch_data_or_basic_mode() {
        let parent = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("work/backend-host-tests");
        std::fs::create_dir_all(&parent).unwrap();
        let fixture = tempfile::tempdir_in(parent).unwrap();
        let other = fixture.path().join("other");
        std::fs::create_dir(&other).unwrap();
        let status = json!({"basicMode":false,"dataDir":fixture.path()});
        assert!(check_target(&status, Some(fixture.path()), false).is_ok());
        assert!(check_target(&status, Some(&other), false).is_err());
        assert!(check_target(&status, None, true).is_err());
    }
}
