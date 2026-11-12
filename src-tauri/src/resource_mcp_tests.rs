use super::*;
#[cfg(windows)]
use std::{fs, path::Path};

fn node() -> String {
    let output = Command::new("node")
        .args(["-p", "process.execPath"])
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .output()
        .expect(
            "Synthetic MCP tests require the existing Node environment; no runtime is downloaded",
        );
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}
fn script(mode: &str) -> String {
    r#"
const mode=__MODE__;
const readline=require('node:readline');
let initialized=false,starts=0,calls=0;
const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{
  const q=JSON.parse(line);
  if(q.method==='initialize'){
    if(q.params.clientInfo.name!=='Agent Resource Manager')process.exit(33);
    starts++;
    reply(q.id,{protocolVersion:mode==='bad-version'?'2099-01-01':'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'Synthetic MCP',version:'1'}});
  }else if(q.method==='notifications/initialized'){ initialized=true; }
  else if(q.method==='tools/call'){
    if(!initialized)process.exit(34);
    calls++;
    const tool=q.params.name, args=q.params.arguments;
    if(!((tool==='browser_tabs'&&JSON.stringify(args)===JSON.stringify({action:'list'}))||(tool==='browser_snapshot'&&JSON.stringify(args)===JSON.stringify({depth:8}))))process.exit(35);
    if(mode==='timeout')return;
    if(mode==='good-then-timeout'&&calls>1){
      const fs=require('node:fs');
      fs.writeFileSync('mcp-cancel-request-started.tmp',JSON.stringify({pid:process.pid,starts,calls,tool,args}));
      fs.renameSync('mcp-cancel-request-started.tmp','mcp-cancel-request-started');
      return;
    }
    if(mode==='await-marker'){
      const fs=require('node:fs');
      fs.writeFileSync('mcp-request-started','synthetic');
      const timer=setInterval(()=>{if(fs.existsSync('mcp-release-reply')){clearInterval(timer);reply(q.id,{content:[{type:'text',text:'synthetic completed reply'}],isError:false});}},5);
      return;
    }
    if(mode==='exit-zero')process.exit(0);
    if(mode==='rpc-error'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,error:{code:-32000,message:'synthetic server error'}})+'\n');return;}
    if(mode==='object-id'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:{payload:'x'.repeat(8000)},method:'ping'})+'\n');return;}
    if(mode==='request-flood'){for(let i=0;i<20;i++)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:'server-'+i,method:'ping'})+'\n');return;}
    if(mode==='oversized'){process.stdout.write('x'.repeat(1048590)+'\n');return;}
    process.stderr.write('A diagnostic is not tool failure\n');
    if(mode==='bad-format'){reply(q.id,{content:'invalid'});return;}
    if(mode==='scalar-content'){reply(q.id,{content:[null,123]});return;}
    if(mode==='malformed-text'){reply(q.id,{content:[{type:'text',text:123}]});return;}
    if(mode==='empty-content'){reply(q.id,{content:[]});return;}
    reply(q.id,{content:[{type:'text',text:JSON.stringify({pid:process.pid,starts,calls,tool,args,privateText:'SYNTHETIC_MCP_PRIVATE_NOT_FOR_DB'})}],isError:mode==='tool-error'});
  }
});
"#.replace("__MODE__",&json!(mode).to_string())
}
fn control(mode: &str) -> Control {
    let mut command = Command::new(node());
    command
        .arg("-e")
        .arg(script(mode))
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH");
    Control::start(command, "synthetic-test-only".into()).unwrap()
}
#[test]
fn stdio_reuses_handshake_and_checks_actual_tool_result_without_treating_stderr_as_failure() {
    let control = control("good");
    let tabs = control.call("browser_tabs", Duration::from_secs(5));
    assert_eq!(tabs.status, "succeeded");
    assert!(control.alive());
    assert_eq!(tabs.evidence["rpcResultReceived"], true);
    assert_eq!(tabs.evidence["isError"], false);
    let snapshot = control.call("browser_snapshot", Duration::from_secs(5));
    assert_eq!(snapshot.status, "succeeded");
    let reply: Value = serde_json::from_str(&snapshot.stdout).unwrap();
    let content: Value =
        serde_json::from_str(reply["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(content["starts"], 1);
    assert_eq!(content["calls"], 2);
    assert_eq!(content["pid"], control.pid);
    assert_eq!(tabs.evidence["sessionId"], snapshot.evidence["sessionId"]);
    assert_eq!(control.close().unwrap().code, Some(0));
    assert!(!control.alive());
}
#[test]
fn actual_protocol_errors_and_zero_process_exit_are_not_tool_success() {
    for (mode, received, rpc) in [
        ("tool-error", true, false),
        ("rpc-error", false, true),
        ("bad-version", false, false),
        ("bad-format", true, false),
        ("scalar-content", true, false),
        ("malformed-text", true, false),
        ("exit-zero", false, false),
        ("oversized", false, false),
        ("object-id", false, false),
        ("request-flood", false, false),
    ] {
        let control = control(mode);
        let result = control.call("browser_tabs", Duration::from_secs(5));
        assert_eq!(result.status, "failed", "{mode}");
        assert_eq!(result.evidence["rpcResultReceived"], received, "{mode}");
        assert_eq!(result.evidence["jsonRpcError"], rpc, "{mode}");
        assert_ne!(result.evidence["isError"], json!(false), "{mode}");
        if mode == "tool-error" {
            assert_eq!(result.evidence["isError"], true);
            assert!(control.alive());
        } else {
            assert!(!control.alive());
        }
        control.close().unwrap();
    }
}

#[test]
fn a_server_that_never_reads_stdin_cannot_hold_the_caller_or_owned_close_open() {
    let mut command = Command::new(node());
    command
        .args(["-e", "setInterval(()=>{},1000)"])
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH");
    let control = Control::start(command, "synthetic-never-reads".into()).unwrap();
    let cancelled = AtomicBool::new(false);
    let started = Instant::now();
    let error = {
        let session = control.session.lock().unwrap();
        let deadline = Instant::now() + Duration::from_millis(200);
        loop {
            if let Err(error) =
                session
                    .writer
                    .send(&json!({"padding":"x".repeat(3900)}), deadline, &cancelled)
            {
                break error;
            }
        }
    };
    assert!(matches!(error, Failure::Timeout));
    control.close().unwrap();
    assert!(!control.alive());
    assert!(started.elapsed() < Duration::from_secs(3));
}
#[test]
fn an_empty_but_well_formed_content_array_is_a_valid_tool_result() {
    let control = control("empty-content");
    let result = control.call("browser_tabs", Duration::from_secs(5));
    assert_eq!(result.status, "succeeded");
    assert_eq!(result.evidence["isError"], false);
    control.close().unwrap();
}
#[test]
fn timeout_and_cancellation_close_only_owned_mcp_and_leave_another_owned_test_process_alive() {
    let mut unrelated = Command::new(node())
        .args(["-e", "setInterval(()=>{},1000)"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let owned = control("timeout");
    let start = Instant::now();
    let result = owned.call("browser_tabs", Duration::from_millis(150));
    assert_eq!(result.status, "timed_out");
    assert!(start.elapsed() < Duration::from_secs(3));
    assert!(!owned.alive());
    assert!(unrelated.try_wait().unwrap().is_none());
    let cancelled = control("good");
    cancelled.cancel();
    assert_eq!(
        cancelled
            .call("browser_tabs", Duration::from_secs(2))
            .status,
        "stopped"
    );
    assert!(unrelated.try_wait().unwrap().is_none());
    unrelated.kill().unwrap();
    unrelated.wait().unwrap();
}

#[cfg(windows)]
pub(crate) fn fixture(
    mode: &str,
) -> (
    tempfile::TempDir,
    std::sync::Arc<crate::tasks::TaskSystem>,
    String,
) {
    let (dir, manager, id) = manager_fixture(mode);
    (dir, crate::tasks::TaskSystem::new(manager).unwrap(), id)
}
#[cfg(windows)]
fn manager_fixture(mode: &str) -> (tempfile::TempDir, crate::model::Manager, String) {
    let parent = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("work/resource-mcp-tests");
    fs::create_dir_all(&parent).unwrap();
    let dir = tempfile::tempdir_in(parent).unwrap();
    let root = dir.path().join("edge");
    let package = root.join("node_modules/@playwright/mcp");
    fs::create_dir_all(&package).unwrap();
    fs::create_dir(root.join("runtime")).unwrap();
    fs::write(package.join("cli.js"), script(mode)).unwrap();
    fs::write(package.join("package.json"),json!({"name":"@playwright/mcp","version":"0.0.83","license":"Apache-2.0","repository":{"url":"git+https://github.com/microsoft/playwright-mcp.git"}}).to_string()).unwrap();
    fs::write(package.join("LICENSE"), "Apache License Version 2.0").unwrap();
    let core = root.join("node_modules/playwright-core");
    fs::create_dir_all(core.join("lib")).unwrap();
    fs::write(
        core.join("package.json"),
        json!({"name":"playwright-core","version":"1.57.0","license":"Apache-2.0"}).to_string(),
    )
    .unwrap();
    fs::write(
        core.join("lib/coreBundle.js"),
        "// synthetic inert core bundle",
    )
    .unwrap();
    fs::write(
        core.join("lib/utilsBundle.js"),
        "// synthetic inert utils bundle",
    )
    .unwrap();
    fs::write(
        root.join("install-manifest.json"),
        json!({"mode":"extension","browser":"msedge","nodePath":node()}).to_string(),
    )
    .unwrap();
    let mut manager = crate::model::Manager::new(dir.path().join("state")).unwrap();
    let preview = crate::resource_adapters::preview_local(
        &mut manager,
        &json!({"action":"preview_resource_adapter","adapter":"edgeControl","rootPath":root}),
    )
    .unwrap()
    .unwrap();
    let resource = crate::resource_adapters::apply_local(
        &mut manager,
        &json!({"action":"apply_resource_adapter","previewId":preview["id"]}),
    )
    .unwrap()
    .unwrap();
    (
        dir,
        manager,
        resource["resource"]["id"].as_str().unwrap().into(),
    )
}

#[cfg(windows)]
#[test]
fn actual_node_child_discards_mcp_config_script_and_browser_overrides_but_preserves_normal_environment(
) {
    let (_dir, manager, id) = manager_fixture("good");
    let definition =
        super::super::verified_definition(&record(&manager, &id), "edge-tabs").unwrap();
    let mut command = Command::new(&definition.executable);
    let overrides = [
        "PLAYWRIGHT_MCP_CONFIG",
        "PLAYWRIGHT_MCP_CDP_ENDPOINT",
        "PLAYWRIGHT_MCP_ISOLATED",
        "PLAYWRIGHT_MCP_INIT_PAGE",
        "PLAYWRIGHT_MCP_INIT_SCRIPT",
        "PLAYWRIGHT_MCP_USER_DATA_DIR",
        "PLAYWRIGHT_MCP_EXECUTABLE_PATH",
        "PLAYWRIGHT_MCP_STORAGE_STATE",
        "PLAYWRIGHT_MCP_SECRETS_FILE",
        "PLAYWRIGHT_MCP_EXTENSION",
        "PLAYWRIGHT_MCP_PROFILE_DIR_NAME",
        "NODE_OPTIONS",
        "NODE_PATH",
    ];
    for key in overrides {
        command.env(key, "SYNTHETIC_OVERRIDE_MUST_NOT_REACH_CHILD");
    }
    // All values in this probe are synthetic and child-local. No actual token or
    // proxy value is read, copied into the command, or included in its output.
    command
        .env(
            "PLAYWRIGHT_MCP_EXTENSION_TOKEN",
            "SYNTHETIC_PAIRING_SENTINEL",
        )
        .env("HTTP_PROXY", "http://synthetic.invalid:8765")
        .env("ARM_TEST_ENV_SENTINEL", "ordinary-child-env")
        .env("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", "0");
    crate::resource_adapters::apply_environment(&definition, &mut command).unwrap();
    let probe = format!("const keys={};const stripped=keys.every(k=>process.env[k]===undefined);const normal=process.env.ARM_TEST_ENV_SENTINEL==='ordinary-child-env'&&process.env.HTTP_PROXY==='http://synthetic.invalid:8765'&&!!process.env.PATH&&!!process.env.SystemRoot;const token=process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN==='SYNTHETIC_PAIRING_SENTINEL';console.log(JSON.stringify({{stripped,normal,token,skip:process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD}}));", json!(overrides));
    let output = command.args(["-e", &probe]).output().unwrap();
    assert!(output.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!({"stripped":true,"normal":true,"token":true,"skip":"1"})
    );
}

#[cfg(windows)]
fn task(service: &Arc<crate::tasks::TaskSystem>, id: &Value) -> Value {
    service
        .control(&json!({"action":"get_task","taskId":id}), crate::dispatch)
        .unwrap()
        .unwrap()["task"]
        .clone()
}
#[cfg(windows)]
fn await_terminal_task(service: &Arc<crate::tasks::TaskSystem>, id: &Value) -> Value {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let current = task(service, id);
        if !matches!(current["status"].as_str(), Some("queued" | "running")) {
            return current;
        }
        assert!(Instant::now() < deadline, "{current}");
        std::thread::sleep(Duration::from_millis(10));
    }
}
#[cfg(windows)]
#[test]
fn cancelling_an_actual_task_system_mcp_call_keeps_its_stopped_protocol_result_and_evidence() {
    let session_started = Instant::now();
    let (dir, service, id) = fixture("good-then-timeout");
    let first = service
        .execute(
            json!({"action":"resource_invoke","id":id,"actionId":"edge-tabs","parameters":{}}),
            crate::dispatch,
        )
        .unwrap();
    assert_eq!(first["run"]["status"], "succeeded");
    eprintln!(
        "MCP cancellation shared session established in {:?}",
        session_started.elapsed()
    );
    let expected_resource = json!(id);
    let expected_session = first["run"]["sessionId"].clone();
    let expected_pid = first["run"]["pid"].clone();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    service
        .set_resource_events(Arc::new(move |event| {
            let run = &event["run"];
            if run["resourceId"] == expected_resource
                && run["actionId"] == "edge-snapshot"
                && run["mode"] == "task"
                && run["status"] == "running"
                && run["sessionId"] == expected_session
                && run["pid"] == expected_pid
            {
                let _ = ready_tx.send((Instant::now(), run.clone()));
            }
        }))
        .unwrap();
    // Admission hashes the real Node executable before an MCP call exists. Its
    // finite preparation budget is the registered action's 40 seconds, separate
    // from the original eight-second protocol observation and cancellation gates.
    let preparing = Instant::now();
    let preparation_deadline = preparing + Duration::from_secs(40);
    let started=service.control(&json!({"action":"start_task","request":{"action":"resource_invoke","id":id,"actionId":"edge-snapshot","parameters":{}}}),crate::dispatch).unwrap().unwrap();
    let task_id = &started["task"]["id"];
    let (running_at, active_run) = ready_rx
        .recv_timeout(preparation_deadline.saturating_duration_since(Instant::now()))
        .unwrap_or_else(|error| {
            panic!(
                "real MCP call was not ready within its preparation budget: {error}; elapsed {:?}; task {}",
                preparing.elapsed(),
                task(&service, task_id)
            )
        });
    assert!(running_at < preparation_deadline);
    eprintln!(
        "MCP cancellation preparation took {:?}; protocol observation keeps its eight-second budget",
        running_at.duration_since(preparing)
    );
    let deadline = running_at + Duration::from_secs(8);
    let receipt_path = dir.path().join("edge/mcp-cancel-request-started");
    while !receipt_path.exists() {
        assert!(
            Instant::now() < deadline,
            "the shared Node process did not receive its second tools/call"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let receipt: Value = serde_json::from_slice(&fs::read(receipt_path).unwrap()).unwrap();
    assert_eq!(receipt["pid"], first["run"]["pid"]);
    assert_eq!(receipt["starts"], 1);
    assert_eq!(receipt["calls"], 2);
    assert_eq!(receipt["tool"], "browser_snapshot");
    assert_eq!(receipt["args"], json!({"depth":8}));
    loop {
        let runs = service
            .execute(
                json!({"action":"resource_runtime","id":id}),
                crate::dispatch,
            )
            .unwrap();
        assert!(
            Instant::now() < deadline,
            "observing the actual in-flight call exceeded its protocol budget: {runs}"
        );
        if runs["runs"].as_array().unwrap().iter().any(|run| {
            run["runId"] == active_run["runId"]
                && run["actionId"] == "edge-snapshot"
                && run["status"] == "running"
        }) {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let cancelling = Instant::now();
    service
        .control(
            &json!({"action":"cancel_task","taskId":task_id}),
            crate::dispatch,
        )
        .unwrap()
        .unwrap();
    let done = await_terminal_task(&service, task_id);
    assert!(
        cancelling.elapsed() < Duration::from_secs(8),
        "cancellation and its terminal task result exceeded eight seconds"
    );
    assert_eq!(done["status"], "cancelled");
    assert_eq!(done["result"]["run"]["status"], "stopped");
    assert!(done["result"]["run"]["exitCode"].is_null());
    assert_eq!(
        done["result"]["run"]["protocolEvidence"]["toolName"],
        "browser_snapshot"
    );
    assert_eq!(
        done["result"]["run"]["protocolEvidence"]["rpcResultReceived"],
        false
    );
    assert!(
        done["result"].get("capabilityEvidenceWarning").is_none(),
        "{done}"
    );
    assert_eq!(
        done["result"]["capabilityEvidence"]["evidence"]["processStatus"],
        "stopped"
    );
    let observed = service
        .execute(
            json!({"action":"resource_capability_evidence","resourceId":id}),
            crate::dispatch,
        )
        .unwrap();
    assert_eq!(observed["total"], 2);
    let action = observed["actions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|action| action["actionId"] == "edge-snapshot")
        .unwrap();
    assert_eq!(action["status"], "failed");
    assert_eq!(action["latest"]["processStatus"], "stopped");
    let runs = service
        .execute(
            json!({"action":"resource_runtime","id":id}),
            crate::dispatch,
        )
        .unwrap();
    assert!(runs["runs"]
        .as_array()
        .unwrap()
        .iter()
        .all(|run| run["status"] != "running"));
}

#[cfg(windows)]
#[test]
fn stopping_transport_after_an_actual_reply_cannot_replace_the_completed_tool_result() {
    let (dir, manager, id) = manager_fixture("await-marker");
    let definition =
        super::super::verified_definition(&record(&manager, &id), "edge-tabs").unwrap();
    let revision = record(&manager, &id).revision;
    let args = super::super::arguments(&definition, &json!({})).unwrap();
    let run = manager
        .resource_spawn(PreparedInvocation {
            resource_id: id,
            revision,
            definition,
            args,
        })
        .unwrap();
    let run_id = run["runId"].as_str().unwrap();
    let root = dir.path().join("edge");
    let deadline = Instant::now() + Duration::from_secs(8);
    while !root.join("mcp-request-started").exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    let mut state = manager.resource_runtime.state.lock().unwrap();
    let current = state.runs.get_mut(run_id).unwrap();
    let control = current.mcp_call.as_ref().unwrap().clone();
    fs::write(root.join("mcp-release-reply"), "synthetic").unwrap();
    // Holding the registry lock deterministically delays outcome publication;
    // the session lock becoming free proves actual tools/call has returned.
    loop {
        if control.session.try_lock().is_ok() {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    current.stop("stopped").unwrap();
    assert!(current.mcp_pending);
    assert_eq!(current.metadata["status"], "running");
    drop(state);
    loop {
        let result = manager.resource_runtime.result(run_id).unwrap();
        if result["run"]["status"] != "running" {
            assert_eq!(result["run"]["status"], "succeeded");
            assert_eq!(result["run"]["protocolEvidence"]["isError"], false);
            assert_eq!(result["run"]["protocolEvidence"]["rpcResultReceived"], true);
            assert!(result["run"]["exitCode"].is_null());
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[cfg(windows)]
fn wait_before_dispatch(
    manager: &mut crate::model::Manager,
    request: &Value,
) -> Result<Value, String> {
    fs::write(manager.data_dir.join("dispatch-ready"), "synthetic").unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    while !manager.data_dir.join("dispatch-release").exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    crate::dispatch(manager, request)
}
#[cfg(windows)]
#[test]
fn cancelling_before_real_mcp_dispatch_creates_no_run_or_capability_evidence() {
    let (dir, service, id) = fixture("good");
    let started=service.control(&json!({"action":"start_task","request":{"action":"resource_invoke","id":id,"actionId":"edge-tabs","parameters":{}}}),wait_before_dispatch).unwrap().unwrap();
    let task_id = &started["task"]["id"];
    let deadline = Instant::now() + Duration::from_secs(8);
    while !dir.path().join("state/dispatch-ready").exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    service
        .control(
            &json!({"action":"cancel_task","taskId":task_id}),
            crate::dispatch,
        )
        .unwrap()
        .unwrap();
    fs::write(dir.path().join("state/dispatch-release"), "synthetic").unwrap();
    let done = await_terminal_task(&service, task_id);
    assert_eq!(done["status"], "cancelled");
    assert!(done["result"].is_null());
    assert!(service
        .execute(
            json!({"action":"resource_runtime","id":id}),
            crate::dispatch
        )
        .unwrap()["runs"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        service
            .execute(
                json!({"action":"resource_capability_evidence","resourceId":id}),
                crate::dispatch
            )
            .unwrap()["total"],
        0
    );
}
#[cfg(windows)]
#[test]
fn actual_task_system_fixed_adapter_runs_two_tools_in_one_owned_session_and_keeps_content_out_of_history(
) {
    let (dir, service, id) = fixture("good");
    let invoke = |action: &str| {
        service
            .execute(
                json!({"action":"resource_invoke","id":id,"actionId":action,"parameters":{}}),
                crate::dispatch,
            )
            .unwrap()
    };
    let first = invoke("edge-tabs");
    let second = invoke("edge-snapshot");
    for (result, tool) in [(&first, "browser_tabs"), (&second, "browser_snapshot")] {
        assert_eq!(result["run"]["status"], "succeeded");
        assert!(result["run"]["exitCode"].is_null());
        assert_eq!(result["run"]["protocolEvidence"]["toolName"], tool);
        assert_eq!(result["run"]["protocolEvidence"]["isError"], false);
    }
    assert_eq!(first["run"]["sessionId"], second["run"]["sessionId"]);
    let runs = service
        .execute(
            json!({"action":"resource_runtime","id":id}),
            crate::dispatch,
        )
        .unwrap();
    assert_eq!(
        runs["runs"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|run| run["protocolSession"] == true && run["status"] == "running")
            .count(),
        1
    );
    let session = runs["runs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|run| run["protocolSession"] == true)
        .unwrap();
    assert_eq!(session["activeUses"], 0);
    let db = rusqlite::Connection::open(dir.path().join("state/manager.sqlite3")).unwrap();
    let rows: Vec<String> = db
        .prepare("SELECT payload FROM task_history")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert!(rows
        .iter()
        .all(|row| !row.contains("SYNTHETIC_MCP_PRIVATE_NOT_FOR_DB")));
    service
        .execute(
            json!({"action":"resource_stop","runId":session["runId"]}),
            crate::dispatch,
        )
        .unwrap();
    let stopped = service
        .execute(
            json!({"action":"resource_result","runId":session["runId"]}),
            crate::dispatch,
        )
        .unwrap();
    assert_eq!(stopped["run"]["status"], "stopped");
    assert_eq!(stopped["run"]["exitCode"], 0);
}

#[cfg(windows)]
fn record(manager: &crate::model::Manager, id: &str) -> crate::resources::ResourceRecord {
    serde_json::from_value(
        manager
            .resource_store(crate::resources::StoreRequest::Get(id.into()))
            .unwrap(),
    )
    .unwrap()
}
#[cfg(windows)]
fn set_idle(
    manager: &crate::model::Manager,
    id: &str,
    safe: bool,
    tracked: bool,
    seconds: u64,
) -> Value {
    super::super::configure(manager,&json!({"action":"resource_idle_set","id":id,"actionId":"edge-session","expectedRevision":record(manager,id).revision,"idleReleaseSafe":safe,"idleUsageTracked":tracked,"idleTimeoutSeconds":seconds})).unwrap().unwrap()
}
#[cfg(windows)]
fn assert_kept(manager: &crate::model::Manager, at: Instant) {
    assert!(
        super::super::release_idle_at(manager, at).unwrap()["released"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
#[cfg(windows)]
#[test]
fn shared_mcp_idle_policy_is_adjustable_atomic_and_obeys_disabled_safe_tracked_keepalive_login_and_pause(
) {
    let (_dir, mut manager, id) = manager_fixture("good");
    let result = super::super::handle(
        &manager,
        &json!({"action":"resource_invoke","id":id,"actionId":"edge-snapshot","parameters":{}}),
    )
    .unwrap()
    .unwrap();
    let session = result["run"]["sessionId"].as_str().unwrap();
    let initial = super::super::idle_snapshot(&manager, &id).unwrap();
    let policies: Vec<_> = initial["actions"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|action| action["mode"] == "service")
        .collect();
    assert_eq!(policies.len(), 1);
    assert_eq!(policies[0]["actionId"], "edge-session");
    assert_eq!(policies[0]["idleTimeoutSeconds"], 600);
    let before = record(&manager, &id).revision;
    let zero = set_idle(&manager, &id, true, true, 0);
    assert_eq!(zero["resourceRevision"], before + 1);
    for action in record(&manager, &id)
        .actions
        .iter()
        .filter(|action| matches!(action["id"].as_str(), Some("edge-tabs" | "edge-snapshot")))
    {
        assert_eq!(action["mode"], "task");
        assert_eq!(action["idleTimeoutSeconds"], 0);
    }
    let at = Instant::now() + Duration::from_secs(3600);
    assert_kept(&manager, at);
    set_idle(&manager, &id, false, true, 1);
    assert_kept(&manager, at);
    set_idle(&manager, &id, true, false, 1);
    assert_kept(&manager, at);
    set_idle(&manager, &id, true, true, 1);
    manager
        .resource_runtime
        .activity_request(&json!({"action":"resource_keep_alive","runId":session,"enabled":true}))
        .unwrap();
    assert_kept(&manager, at);
    manager
        .resource_runtime
        .activity_request(&json!({"action":"resource_keep_alive","runId":session,"enabled":false}))
        .unwrap();
    let login = manager
        .resource_runtime
        .activity_request(&json!({"action":"resource_usage_begin","runId":session,"kind":"login"}))
        .unwrap();
    let call = manager
        .resource_runtime
        .activity_request(&json!({"action":"resource_usage_begin","runId":session,"kind":"call"}))
        .unwrap();
    assert_kept(&manager, at);
    manager
        .resource_runtime
        .activity_request(
            &json!({"action":"resource_usage_end","runId":session,"leaseId":login["leaseId"]}),
        )
        .unwrap();
    assert_kept(&manager, at);
    manager
        .resource_runtime
        .activity_request(
            &json!({"action":"resource_usage_end","runId":session,"leaseId":call["leaseId"]}),
        )
        .unwrap();
    manager.state.settings["maintenance"] = json!({"revision":1,"pausedManually":true});
    assert_eq!(
        super::super::release_idle_at(&manager, at).unwrap()["paused"],
        true
    );
    manager.state.settings["maintenance"] = json!({"revision":2,"pausedManually":false});
    let released = super::super::release_idle_at(&manager, at).unwrap();
    assert_eq!(released["released"][0]["runId"], session);
    assert_eq!(released["released"][0]["status"], "idle_released");
}
#[cfg(windows)]
#[test]
fn an_actual_inflight_mcp_call_protects_the_shared_session_from_idle_release() {
    let (_dir, manager, id) = manager_fixture("timeout");
    set_idle(&manager, &id, true, true, 1);
    let current = record(&manager, &id);
    let definition = super::super::verified_definition(&current, "edge-tabs").unwrap();
    let args = super::super::arguments(&definition, &json!({})).unwrap();
    let run = manager
        .resource_spawn(PreparedInvocation {
            resource_id: id,
            revision: current.revision,
            definition,
            args,
        })
        .unwrap();
    let session = run["sessionId"].as_str().unwrap();
    assert_eq!(
        manager.resource_runtime.result(session).unwrap()["run"]["activeUses"],
        1
    );
    assert_kept(&manager, Instant::now() + Duration::from_secs(3600));
    assert_eq!(
        manager.resource_runtime.result(session).unwrap()["run"]["status"],
        "running"
    );
    manager
        .resource_runtime
        .stop(run["runId"].as_str().unwrap())
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while manager.resource_runtime.result(session).unwrap()["run"]["status"] == "running" {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
}
