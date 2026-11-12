//! A manager-owned stdio connection for two fixed, explicitly adopted Edge actions.
//! Neither browser processes nor another client's MCP handles are enumerated or stopped.
use super::{ActionDefinition, PreparedInvocation};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

const MAX_FRAME: usize = 1024 * 1024;
const MAX_REPLY_BYTES: usize = 2 * 1024 * 1024;
const GRACE: Duration = Duration::from_millis(250);
const MAX_REQUEST: usize = 4096;
pub(super) fn supports_protocol(version: &str) -> bool {
    matches!(version, "2025-11-25" | "2025-06-18" | "2025-03-26")
}
pub(super) fn tool(definition: &ActionDefinition) -> Option<&'static str> {
    if definition.adapter_binding.as_ref()?.adapter != "edgeControl" {
        return None;
    }
    match definition.id.as_str() {
        "edge-tabs" => Some("browser_tabs"),
        "edge-snapshot" => Some("browser_snapshot"),
        _ => None,
    }
}
#[cfg(test)]
pub(super) fn validate(prepared: &PreparedInvocation) -> Result<bool, String> {
    let protocol = validate_shape(prepared)?;
    if protocol {
        crate::resource_adapters::validate_bound_action(&prepared.definition)?;
    }
    Ok(protocol)
}
pub(super) fn validate_shape(prepared: &PreparedInvocation) -> Result<bool, String> {
    if !matches!(
        prepared.definition.id.as_str(),
        "edge-tabs" | "edge-snapshot"
    ) {
        return Ok(false);
    }
    if tool(&prepared.definition).is_none() {
        return Err("Edge 协议调用只允许本地明确接管的固定动作".into());
    }
    let literals: Option<Vec<_>> = prepared
        .definition
        .args
        .iter()
        .map(|arg| match arg {
            super::Argument::Literal { value } => Some(value.clone()),
            _ => None,
        })
        .collect();
    if prepared.definition.mode != "task"
        || !prepared.definition.parameters.is_empty()
        || literals.as_ref() != Some(&prepared.args)
    {
        return Err("Edge 协议动作不接受额外参数或任意工具名".into());
    }
    Ok(true)
}
pub(super) fn connection_key(definition: &ActionDefinition) -> String {
    json!({"binding":definition.adapter_binding,"executable":definition.executable,"args":definition.args,"cwd":definition.working_directory}).to_string()
}

pub(super) struct Outcome {
    pub status: &'static str,
    pub stdout: String,
    pub evidence: Value,
    pub error: Option<String>,
}
#[derive(Clone)]
pub(super) struct Exit {
    pub code: Option<i32>,
    pub requested: bool,
}
struct Session {
    child: Option<Child>,
    writer: Writer,
    pending: Vec<u8>,
    protocol: Option<String>,
    next_id: u64,
    exit: Option<Exit>,
}
struct Packet {
    bytes: Vec<u8>,
    finished: SyncSender<Result<(), ()>>,
}
struct Writer {
    sender: Option<SyncSender<Packet>>,
    stopping: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Writer {
    fn new(mut input: ChildStdin) -> Self {
        let (sender, receiver) = mpsc::sync_channel::<Packet>(1);
        let stopping = Arc::new(AtomicBool::new(false));
        let stopped = stopping.clone();
        let thread = std::thread::spawn(move || {
            while let Ok(packet) = receiver.recv() {
                if stopped.load(Ordering::Acquire) {
                    break;
                }
                let result = write_frame(&mut input, &packet.bytes, &stopped).map_err(|_| ());
                let failed = result.is_err();
                let _ = packet.finished.send(result);
                if failed {
                    break;
                }
            }
            // Closing this manager-owned stdin is the stdio shutdown signal.
        });
        Self {
            sender: Some(sender),
            stopping,
            thread: Some(thread),
        }
    }
    fn send(
        &self,
        value: &Value,
        deadline: Instant,
        cancelled: &AtomicBool,
    ) -> Result<(), Failure> {
        let mut bytes = value.to_string().into_bytes();
        bytes.push(b'\n');
        if bytes.len() > MAX_REQUEST {
            return Err(Failure::Limit);
        }
        let (finished, result) = mpsc::sync_channel(1);
        let mut packet = Packet { bytes, finished };
        let sender = self.sender.as_ref().ok_or(Failure::Transport)?;
        loop {
            if cancelled.load(Ordering::Acquire) {
                return Err(Failure::Stopped);
            }
            if Instant::now() >= deadline {
                return Err(Failure::Timeout);
            }
            match sender.try_send(packet) {
                Ok(()) => break,
                Err(mpsc::TrySendError::Full(value)) => packet = value,
                Err(mpsc::TrySendError::Disconnected(_)) => return Err(Failure::Transport),
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        loop {
            if cancelled.load(Ordering::Acquire) {
                return Err(Failure::Stopped);
            }
            if Instant::now() >= deadline {
                return Err(Failure::Timeout);
            }
            match result.recv_timeout(Duration::from_millis(5)) {
                Ok(Ok(())) => return Ok(()),
                Ok(Err(())) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(Failure::Transport)
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    }
    fn stop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        self.sender.take();
        if let Some(thread) = self.thread.as_ref() {
            cancel_writer_io(thread);
        }
    }
    fn reap(&mut self) {
        self.stop();
        if self
            .thread
            .as_ref()
            .is_some_and(|thread| thread.is_finished())
        {
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }
}
impl Drop for Writer {
    fn drop(&mut self) {
        self.reap();
    }
}
#[cfg(windows)]
fn cancel_writer_io(thread: &std::thread::JoinHandle<()>) {
    use std::os::windows::io::AsRawHandle;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CancelSynchronousIo(thread: *mut std::ffi::c_void) -> i32;
    }
    // This is our writer thread's borrowed handle, never a user process ID.
    unsafe {
        CancelSynchronousIo(thread.as_raw_handle());
    }
}
#[cfg(not(windows))]
fn cancel_writer_io(_thread: &std::thread::JoinHandle<()>) {}
#[cfg(windows)]
fn write_frame(input: &mut ChildStdin, bytes: &[u8], _stopped: &AtomicBool) -> std::io::Result<()> {
    input.write_all(bytes).and_then(|_| input.flush())
}
#[cfg(not(windows))]
fn write_frame(
    input: &mut ChildStdin,
    mut bytes: &[u8],
    stopped: &AtomicBool,
) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    unsafe extern "C" {
        fn fcntl(fd: i32, cmd: i32, ...) -> i32;
    }
    let fd = input.as_raw_fd();
    let flags = unsafe { fcntl(fd, 3) };
    #[cfg(target_os = "linux")]
    let nonblock = 2048;
    #[cfg(not(target_os = "linux"))]
    let nonblock = 4;
    if flags < 0 || unsafe { fcntl(fd, 4, flags | nonblock) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    while !bytes.is_empty() {
        if stopped.load(Ordering::Acquire) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "owned MCP writer stopped",
            ));
        }
        match input.write(bytes) {
            Ok(0) => return Err(std::io::ErrorKind::WriteZero.into()),
            Ok(count) => bytes = &bytes[count..],
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(5))
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}
pub(super) struct Control {
    pub id: String,
    pub key: String,
    pub pid: u32,
    cancelled: AtomicBool,
    alive: AtomicBool,
    session: Mutex<Session>,
}
impl Control {
    #[cfg(test)]
    pub fn spawn(prepared: &PreparedInvocation) -> Result<Self, String> {
        if !validate(prepared)? {
            return Err("不是固定 Edge 协议动作".into());
        }
        let mut command = Command::new(&prepared.definition.executable);
        crate::resource_adapters::apply_environment(&prepared.definition, &mut command)?;
        command
            .args(&prepared.args)
            .current_dir(&prepared.definition.working_directory);
        Self::start(command, connection_key(&prepared.definition))
    }
    pub(super) fn start(mut command: Command, key: String) -> Result<Self, String> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("无法启动管理器自有 MCP：{e}"))?;
        let input = child.stdin.take().expect("piped owned stdin");
        Ok(Self {
            id: uuid::Uuid::new_v4().to_string(),
            key,
            pid: child.id(),
            cancelled: AtomicBool::new(false),
            alive: AtomicBool::new(true),
            session: Mutex::new(Session {
                child: Some(child),
                writer: Writer::new(input),
                pending: vec![],
                protocol: None,
                next_id: 0,
                exit: None,
            }),
        })
    }
    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }
    pub fn exit(&self) -> Result<Option<Exit>, String> {
        let Ok(mut session) = self.session.try_lock() else {
            return Ok(None);
        };
        if let Some(child) = session.child.as_mut() {
            if let Some(status) = child.try_wait().map_err(|_| "无法核对自有 MCP 进程状态")?
            {
                session.exit = Some(Exit {
                    code: status.code(),
                    requested: false,
                });
                session.writer.reap();
                session.child.take();
                self.alive.store(false, Ordering::Release);
            }
        }
        Ok(session.exit.clone())
    }
    pub fn close(&self) -> Result<Exit, String> {
        self.cancel();
        let mut session = self.session.lock().map_err(|_| "MCP 连接状态不可用")?;
        let exit = session.close()?;
        self.alive.store(false, Ordering::Release);
        Ok(exit)
    }
    pub fn call(&self, tool_name: &'static str, timeout: Duration) -> Outcome {
        let mut evidence = json!({"method":"tools/call","toolName":tool_name,"protocolVersion":null,"rpcResultReceived":false,"isError":null,"jsonRpcError":false,"sessionId":self.id});
        let mut session = match self.session.lock() {
            Ok(session) => session,
            Err(_) => {
                return Outcome {
                    status: "failed",
                    stdout: String::new(),
                    evidence,
                    error: Some("MCP 连接状态不可用".into()),
                }
            }
        };
        let deadline = Instant::now() + timeout;
        let mut budget = MAX_REPLY_BYTES;
        let result = (|| -> Result<Value, Failure> {
            if self.cancelled.load(Ordering::Acquire) {
                return Err(Failure::Stopped);
            }
            if session.protocol.is_none() {
                let initialized = session.request("initialize", json!({"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"Agent Resource Manager","version":env!("CARGO_PKG_VERSION")}}), deadline, &self.cancelled, &mut budget)?;
                let version = initialized["protocolVersion"]
                    .as_str()
                    .filter(|version| supports_protocol(version))
                    .ok_or(Failure::Protocol)?;
                if !initialized["capabilities"]["tools"].is_object()
                    || !initialized["serverInfo"].is_object()
                {
                    return Err(Failure::Protocol);
                }
                session.protocol = Some(version.into());
                session.send(
                    &json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
                    deadline,
                    &self.cancelled,
                )?;
            }
            evidence["protocolVersion"] = json!(session.protocol);
            let args = match tool_name {
                "browser_tabs" => json!({"action":"list"}),
                "browser_snapshot" => json!({"depth":8}),
                _ => return Err(Failure::Protocol),
            };
            let result = session.request(
                "tools/call",
                json!({"name":tool_name,"arguments":args}),
                deadline,
                &self.cancelled,
                &mut budget,
            )?;
            evidence["rpcResultReceived"] = json!(true);
            if !result["content"].as_array().is_some_and(|blocks| {
                blocks.iter().all(|block| {
                    block.is_object() && block["type"] == "text" && block["text"].is_string()
                })
            }) || result
                .get("isError")
                .is_some_and(|value| !value.is_boolean())
            {
                return Err(Failure::Protocol);
            }
            evidence["isError"] = json!(result["isError"].as_bool().unwrap_or(false));
            Ok(result)
        })();
        match result {
            Ok(result) => Outcome {
                status: if result["isError"] == true {
                    "failed"
                } else {
                    "succeeded"
                },
                stdout: result.to_string(),
                evidence,
                error: (result["isError"] == true).then(|| {
                    "Edge MCP 工具返回失败；现有扩展配对或页面权限可能受阻，未认定调用通过".into()
                }),
            },
            Err(failure) => {
                evidence["protocolVersion"] = json!(session.protocol);
                evidence["jsonRpcError"] = json!(matches!(failure, Failure::Rpc));
                // A transport/protocol failure has no trustworthy request boundary to reuse.
                let closed = session.close().is_ok();
                self.alive.store(session.child.is_some(), Ordering::Release);
                Outcome {
                    status: match failure {
                        Failure::Timeout => "timed_out",
                        Failure::Stopped => "stopped",
                        _ => "failed",
                    },
                    stdout: String::new(),
                    evidence,
                    error: Some(if closed {
                        failure.message().into()
                    } else {
                        format!(
                            "{} 自有连接尚未退出，句柄保持；请在运行列表中停止该连接。",
                            failure.message()
                        )
                    }),
                }
            }
        }
    }
}
impl Drop for Control {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
#[derive(Debug)]
enum Failure {
    Timeout,
    Stopped,
    Transport,
    Protocol,
    Limit,
    Rpc,
}
impl Failure {
    fn message(&self) -> &'static str {
        match self {
        Self::Timeout=>"Edge MCP 调用超时，可能尚未完成现有扩展配对；仅已关闭管理器自有连接，用户 Edge 和其他客户端保持。",
        Self::Stopped=>"Edge MCP 调用已取消；仅关闭管理器自有连接。",
        Self::Transport=>"管理器自有 MCP 传输中断，未取得工具调用结果。",
        Self::Protocol=>"MCP 响应协议、能力或结果格式不符，未认定调用通过。",
        Self::Limit=>"MCP 响应超出有限读取范围，连接已关闭，未截断为成功。",
        Self::Rpc=>"MCP 返回 JSON-RPC 错误，未认定工具调用通过。",
    }
    }
}
impl Session {
    fn send(
        &self,
        value: &Value,
        deadline: Instant,
        cancelled: &AtomicBool,
    ) -> Result<(), Failure> {
        self.writer.send(value, deadline, cancelled)
    }
    fn request(
        &mut self,
        method: &str,
        params: Value,
        deadline: Instant,
        cancelled: &AtomicBool,
        budget: &mut usize,
    ) -> Result<Value, Failure> {
        self.next_id = self.next_id.checked_add(1).ok_or(Failure::Protocol)?;
        let id = self.next_id;
        self.send(
            &json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
            deadline,
            cancelled,
        )?;
        let mut server_requests = 0usize;
        loop {
            if cancelled.load(Ordering::Acquire) {
                return Err(Failure::Stopped);
            }
            if Instant::now() >= deadline {
                return Err(Failure::Timeout);
            }
            if let Some(frame) = self.frame(budget)? {
                if frame["jsonrpc"] != "2.0" || !frame.is_object() {
                    return Err(Failure::Protocol);
                }
                if let Some(server_id) = frame.get("id") {
                    if let Some(method) = frame["method"].as_str() {
                        server_requests += 1;
                        if server_requests > 16
                            || !(server_id.as_i64().is_some()
                                || server_id.as_str().is_some_and(|id| id.len() <= 128))
                        {
                            return Err(Failure::Protocol);
                        }
                        // No roots, sampling, elicitation or arbitrary server requests are granted.
                        if method == "ping" {
                            self.send(
                                &json!({"jsonrpc":"2.0","id":server_id,"result":{}}),
                                deadline,
                                cancelled,
                            )?;
                        } else {
                            self.send(&json!({"jsonrpc":"2.0","id":server_id,"error":{"code":-32601,"message":"Client capability not enabled"}}),deadline,cancelled)?;
                        }
                        continue;
                    }
                    if server_id.as_u64() != Some(id)
                        || frame.get("result").is_some() == frame.get("error").is_some()
                    {
                        return Err(Failure::Protocol);
                    }
                    if frame.get("error").is_some() {
                        return Err(Failure::Rpc);
                    }
                    return frame
                        .get("result")
                        .filter(|value| value.is_object())
                        .cloned()
                        .ok_or(Failure::Protocol);
                }
                if !frame["method"].is_string() {
                    return Err(Failure::Protocol);
                }
            } else {
                if self
                    .child
                    .as_mut()
                    .ok_or(Failure::Transport)?
                    .try_wait()
                    .map_err(|_| Failure::Transport)?
                    .is_some()
                {
                    return Err(Failure::Transport);
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }
    fn frame(&mut self, budget: &mut usize) -> Result<Option<Value>, Failure> {
        if let Some(end) = self.pending.iter().position(|byte| *byte == b'\n') {
            let frame: Vec<_> = self.pending.drain(..=end).collect();
            return serde_json::from_slice(&frame)
                .map(Some)
                .map_err(|_| Failure::Protocol);
        }
        let child = self.child.as_mut().ok_or(Failure::Transport)?;
        // stderr is drained but deliberately neither persisted nor interpreted as failure:
        // extension pairing URLs can contain private authorization material.
        let mut bytes = [0u8; 8192];
        if let Some(stderr) = child.stderr.as_mut() {
            let count = read_available(stderr, &mut bytes).map_err(|_| Failure::Transport)?;
            *budget = budget.checked_sub(count).ok_or(Failure::Limit)?;
        }
        if let Some(stdout) = child.stdout.as_mut() {
            let count = read_available(stdout, &mut bytes).map_err(|_| Failure::Transport)?;
            *budget = budget.checked_sub(count).ok_or(Failure::Limit)?;
            self.pending.extend_from_slice(&bytes[..count]);
            if self.pending.len() > MAX_FRAME {
                return Err(Failure::Limit);
            }
        }
        if let Some(end) = self.pending.iter().position(|byte| *byte == b'\n') {
            let frame: Vec<_> = self.pending.drain(..=end).collect();
            serde_json::from_slice(&frame)
                .map(Some)
                .map_err(|_| Failure::Protocol)
        } else {
            Ok(None)
        }
    }
    fn close(&mut self) -> Result<Exit, String> {
        self.writer.stop();
        if let Some(exit) = &self.exit {
            self.writer.reap();
            return Ok(exit.clone());
        }
        let Some(child) = self.child.as_mut() else {
            self.writer.reap();
            return Ok(Exit {
                code: None,
                requested: true,
            });
        };
        let mut deadline = Instant::now() + GRACE;
        let mut killed = false;
        let mut discarded = [0u8; 8192];
        let status = loop {
            self.writer.reap();
            if let Some(status) = child.try_wait().map_err(|_| "无法核对自有 MCP 退出")? {
                break status;
            }
            if Instant::now() >= deadline {
                if killed {
                    return Err("自有 MCP 尚未退出；原句柄保持，不按名称终止其他进程".into());
                }
                if child.kill().is_err()
                    && child
                        .try_wait()
                        .map_err(|_| "自有 MCP 退出状态不可读取")?
                        .is_none()
                {
                    return Err("停止管理器自有 MCP 失败；原句柄保持，未按名称终止其他进程".into());
                }
                killed = true;
                deadline = Instant::now() + GRACE;
            }
            if let Some(pipe) = child.stdout.as_mut() {
                let _ = read_available(pipe, &mut discarded);
            }
            if let Some(pipe) = child.stderr.as_mut() {
                let _ = read_available(pipe, &mut discarded);
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        self.child.take();
        self.writer.reap();
        let exit = Exit {
            code: status.code(),
            requested: true,
        };
        self.exit = Some(exit.clone());
        Ok(exit)
    }
}
#[cfg(windows)]
fn read_available(
    pipe: &mut (impl Read + std::os::windows::io::AsRawHandle),
    buffer: &mut [u8],
) -> std::io::Result<usize> {
    let count = super::available(pipe)?.min(buffer.len());
    if count == 0 {
        Ok(0)
    } else {
        pipe.read(&mut buffer[..count])
    }
}
#[cfg(not(windows))]
fn read_available(
    pipe: &mut (impl Read + std::os::fd::AsRawFd),
    buffer: &mut [u8],
) -> std::io::Result<usize> {
    unsafe extern "C" {
        fn fcntl(fd: i32, cmd: i32, ...) -> i32;
    }
    let fd = pipe.as_raw_fd();
    let flags = unsafe { fcntl(fd, 3) };
    #[cfg(target_os = "linux")]
    let nonblock = 2048;
    #[cfg(not(target_os = "linux"))]
    let nonblock = 4;
    if flags < 0 || unsafe { fcntl(fd, 4, flags | nonblock) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    match pipe.read(buffer) {
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(0),
        result => result,
    }
}

#[cfg(test)]
#[path = "resource_mcp_tests.rs"]
pub(super) mod tests;
