//! Per-user Windows backend transport; never opens storage or starts a process.
//!
//! Keep InstanceGuard on the claiming thread until Server has stopped. Handlers
//! must return task IDs for long work; they cannot be forcibly interrupted here.
//! Sources (API use, no copied implementation):
//! https://learn.microsoft.com/windows/win32/ipc/named-pipe-security-and-access-rights
//! https://learn.microsoft.com/windows/win32/ipc/synchronous-and-overlapped-input-and-output
//! https://learn.microsoft.com/windows/win32/api/ioapiset/nf-ioapiset-cancelioex

#![cfg(windows)]

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    io::Write,
    marker::PhantomData,
    mem::size_of,
    ptr::{null, null_mut},
    rc::Rc,
    sync::{Arc, Mutex, OnceLock},
    thread::JoinHandle,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, LocalFree, ERROR_ALREADY_EXISTS, ERROR_BROKEN_PIPE,
        ERROR_INSUFFICIENT_BUFFER, ERROR_IO_PENDING, ERROR_NO_DATA, ERROR_PIPE_BUSY,
        ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE, WAIT_ABANDONED, WAIT_OBJECT_0,
        WAIT_TIMEOUT,
    },
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SDDL_REVISION_1,
        },
        GetTokenInformation, TokenUser, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    },
    Storage::FileSystem::{
        CreateFileW, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED,
        FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_WRITE_DATA, OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
        SYNCHRONIZE,
    },
    System::{
        Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeServerProcessId,
            WaitNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
            PIPE_WAIT,
        },
        Threading::{
            CreateEventW, CreateMutexW, GetCurrentProcess, OpenProcess, OpenProcessToken,
            ReleaseMutex, SetEvent, WaitForMultipleObjects, WaitForSingleObject, INFINITE,
            PROCESS_QUERY_LIMITED_INFORMATION,
        },
        IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
    },
};

pub(crate) const MAX_REQUEST_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const CONNECTIONS: usize = 8;
const IO_TIMEOUT: Duration = Duration::from_secs(30);
type Handler = Arc<dyn Fn(Value) -> Result<Value, String> + Send + Sync>;
// Windows mutex acquisition is recursive on the same thread. The process-local
// set prevents a second caller from receiving another Primary guard for it.
static HELD_INSTANCES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

struct OwnedHandle(HANDLE);
// Kernel handles are thread-safe. Mutex ownership has a separate !Send guard.
unsafe impl Send for OwnedHandle {}
unsafe impl Sync for OwnedHandle {}
impl OwnedHandle {
    fn new(value: HANDLE) -> Result<Self, String> {
        if value.is_null() || value == INVALID_HANDLE_VALUE {
            Err(os_error("Windows handle creation failed"))
        } else {
            Ok(Self(value))
        }
    }
    fn event() -> Result<Self, String> {
        Self::new(unsafe { CreateEventW(null(), 1, 0, null()) })
    }
    fn signalled(&self) -> bool {
        unsafe { WaitForSingleObject(self.0, 0) == WAIT_OBJECT_0 }
    }
}
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

fn os_error(context: &str) -> String {
    format!("{context}: {}", std::io::Error::last_os_error())
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn user_sid(process: HANDLE) -> Result<String, String> {
    let mut token = null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(os_error("Cannot verify backend user"));
    }
    let token = OwnedHandle::new(token)?;
    let mut bytes = 0;
    unsafe { GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut bytes) };
    if unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER || bytes == 0 || bytes > 64 * 1024 {
        return Err(os_error("Cannot read backend user identity"));
    }
    // TOKEN_USER contains pointers, so an aligned allocation is required.
    let mut data = vec![0usize; (bytes as usize).div_ceil(size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            data.as_mut_ptr().cast(),
            bytes,
            &mut bytes,
        )
    } == 0
    {
        return Err(os_error("Cannot read backend user identity"));
    }
    let sid = unsafe { (*(data.as_ptr().cast::<TOKEN_USER>())).User.Sid };
    let mut text = null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err(os_error("Cannot encode backend user identity"));
    }
    let result = unsafe {
        let mut length = 0;
        while *text.add(length) != 0 {
            length += 1;
        }
        let value = String::from_utf16(std::slice::from_raw_parts(text, length))
            .map_err(|_| "Invalid Windows user identity".to_owned());
        LocalFree(text.cast());
        value
    };
    result
}

struct UserSecurity(*mut std::ffi::c_void);
impl UserSecurity {
    fn new(sid: &str) -> Result<Self, String> {
        // Protected DACL: only this exact account, not Everyone/Administrators.
        let descriptor = wide(&format!("D:P(A;;GA;;;{sid})"));
        let mut security = null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                descriptor.as_ptr(),
                SDDL_REVISION_1,
                &mut security,
                null_mut(),
            )
        } == 0
        {
            return Err(os_error("Cannot protect local backend endpoint"));
        }
        Ok(Self(security))
    }
    fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0,
            bInheritHandle: 0,
        }
    }
}
impl Drop for UserSecurity {
    fn drop(&mut self) {
        unsafe { LocalFree(self.0) };
    }
}

#[derive(Clone)]
pub(crate) struct Endpoint {
    sid: String,
    mutex_name: String,
    pipe_name: String,
}
pub(crate) enum Claim {
    Primary(InstanceGuard),
    Existing,
}
/// Windows mutexes must be released by their acquiring thread. Do not move this
/// into Tauri managed state; retain it in run() until after the event loop exits.
pub(crate) struct InstanceGuard {
    handle: OwnedHandle,
    name: String,
    _same_thread: PhantomData<Rc<()>>,
}
impl Drop for InstanceGuard {
    fn drop(&mut self) {
        let mut held = HELD_INSTANCES.get().and_then(|held| held.lock().ok());
        unsafe { ReleaseMutex(self.handle.0) };
        if let Some(held) = held.as_mut() {
            held.remove(&self.name);
        }
    }
}
impl Endpoint {
    pub(crate) fn current_user(scope: &str) -> Result<Self, String> {
        if scope.is_empty() || scope.len() > 256 || scope.chars().any(char::is_control) {
            return Err("Invalid backend application identity".into());
        }
        let sid = user_sid(unsafe { GetCurrentProcess() })?;
        let key = format!("{:x}", Sha256::digest(format!("{scope}\0{sid}").as_bytes()));
        Ok(Self {
            sid,
            mutex_name: format!("Global\\AgentResourceManager-{key}"),
            pipe_name: format!(r"\\.\pipe\AgentResourceManager-{key}"),
        })
    }

    /// Call before Storage::load or Manager initialization. No filesystem writes.
    pub(crate) fn claim(&self) -> Result<Claim, String> {
        let mut held = HELD_INSTANCES
            .get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
            .map_err(|_| "Backend instance ownership lock failed")?;
        if held.contains(&self.mutex_name) {
            return Ok(Claim::Existing);
        }
        let security = UserSecurity::new(&self.sid)?;
        let name = wide(&self.mutex_name);
        let handle = unsafe { CreateMutexW(&security.attributes(), 1, name.as_ptr()) };
        let already_exists = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        let handle = OwnedHandle::new(handle)?;
        if already_exists {
            // Do not acquire/release an existing mutex owned by another thread.
            // An abandoned mutex can be acquired; normal startup recovery runs
            // only after this ownership is established.
            match unsafe { WaitForSingleObject(handle.0, 0) } {
                WAIT_TIMEOUT => return Ok(Claim::Existing),
                WAIT_OBJECT_0 | WAIT_ABANDONED => {}
                _ => return Err(os_error("Cannot claim backend instance")),
            }
        }
        held.insert(self.mutex_name.clone());
        Ok(Claim::Primary(InstanceGuard {
            handle,
            name: self.mutex_name.clone(),
            _same_thread: PhantomData,
        }))
    }

    fn connect(&self, deadline: Instant) -> Result<OwnedHandle, String> {
        let name = wide(&self.pipe_name);
        loop {
            if Instant::now() >= deadline {
                return Err("Local backend connection timed out".into());
            }
            let handle = unsafe {
                CreateFileW(
                    name.as_ptr(),
                    FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                    0,
                    null(),
                    OPEN_EXISTING,
                    FILE_FLAG_OVERLAPPED,
                    null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE {
                let handle = OwnedHandle::new(handle)?;
                let mut pid = 0;
                if unsafe { GetNamedPipeServerProcessId(handle.0, &mut pid) } == 0 {
                    return Err(os_error("Cannot verify local backend owner"));
                }
                let process = OwnedHandle::new(unsafe {
                    OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
                })?;
                if user_sid(process.0)? != self.sid {
                    return Err("Local backend belongs to a different Windows user".into());
                }
                return Ok(handle);
            }
            if unsafe { GetLastError() } != ERROR_PIPE_BUSY {
                return Err(os_error(
                    "Local backend is unavailable; no process was started",
                ));
            }
            // Waiting is bounded by the caller's one overall I/O deadline.
            if unsafe { WaitNamedPipeW(name.as_ptr(), milliseconds(deadline)?) } == 0 {
                return Err(os_error("Local backend connection timed out or closed"));
            }
        }
    }

    /// Connect only. A failed read is not permission to replay a mutation or
    /// spawn a replacement backend. Caller must inspect the task/instance state.
    pub(crate) fn request(&self, request: &Value, timeout: Duration) -> Result<Value, String> {
        if timeout.is_zero() || timeout > IO_TIMEOUT {
            return Err(
                "Backend request timeout must be greater than zero and at most 30 seconds".into(),
            );
        }
        let bytes = encode(request, MAX_REQUEST_BYTES)?;
        let deadline = Instant::now() + timeout;
        let pipe = self.connect(deadline)?;
        write_frame(&pipe, None, deadline, &bytes)?;
        let response = read_frame(&pipe, None, deadline, MAX_RESPONSE_BYTES)?;
        // Acknowledge only after consuming the whole response; otherwise
        // DisconnectNamedPipe could discard a completed but unread write.
        write_all(&pipe, None, deadline, &[1])?;
        let response: Value =
            serde_json::from_slice(&response).map_err(|_| "Invalid local backend response")?;
        match response["ok"].as_bool() {
            Some(true) => Ok(response["value"].clone()),
            Some(false) => Err(response["error"]
                .as_str()
                .unwrap_or("Local backend request failed")
                .to_owned()),
            None => Err("Invalid local backend response envelope".into()),
        }
    }
}

fn milliseconds(deadline: Instant) -> Result<u32, String> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err("Local backend I/O timed out".into());
    }
    Ok(remaining.as_millis().clamp(1, (u32::MAX - 1) as u128) as u32)
}

/// On every cancellation/error, keep OVERLAPPED and the caller's buffer alive
/// until the kernel has completed cancellation. CancelIoEx alone is not enough.
fn finish_io(
    pipe: &OwnedHandle,
    overlap: &mut OVERLAPPED,
    started: i32,
    stop: Option<&OwnedHandle>,
    deadline: Option<Instant>,
) -> Result<usize, String> {
    if started == 0 && unsafe { GetLastError() } != ERROR_IO_PENDING {
        return Err(os_error("Local backend I/O failed"));
    }
    let timeout = match deadline.map(milliseconds).transpose() {
        Ok(value) => value.unwrap_or(INFINITE),
        Err(error) => {
            cancel_io(pipe, overlap);
            return Err(error);
        }
    };
    let handles = if let Some(stop) = stop {
        vec![stop.0, overlap.hEvent]
    } else {
        vec![overlap.hEvent]
    };
    let completed = WAIT_OBJECT_0 + (handles.len() - 1) as u32;
    let result =
        unsafe { WaitForMultipleObjects(handles.len() as u32, handles.as_ptr(), 0, timeout) };
    if result != completed {
        cancel_io(pipe, overlap);
        return Err(if result == WAIT_TIMEOUT {
            "Local backend I/O timed out".into()
        } else if stop.is_some() && result == WAIT_OBJECT_0 {
            "Local backend is stopping".into()
        } else {
            os_error("Local backend I/O wait failed")
        });
    }
    let mut transferred = 0;
    if unsafe { GetOverlappedResult(pipe.0, overlap, &mut transferred, 0) } == 0 {
        return Err(os_error("Local backend I/O failed"));
    }
    Ok(transferred as usize)
}
fn cancel_io(pipe: &OwnedHandle, overlap: &OVERLAPPED) {
    unsafe {
        CancelIoEx(pipe.0, overlap);
        let mut ignored = 0;
        GetOverlappedResult(pipe.0, overlap, &mut ignored, 1);
    }
}
fn read_exact(
    pipe: &OwnedHandle,
    stop: Option<&OwnedHandle>,
    deadline: Instant,
    mut bytes: &mut [u8],
) -> Result<(), String> {
    while !bytes.is_empty() {
        let event = OwnedHandle::event()?;
        let mut overlap = OVERLAPPED {
            hEvent: event.0,
            ..Default::default()
        };
        let started = unsafe {
            ReadFile(
                pipe.0,
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                null_mut(),
                &mut overlap,
            )
        };
        let count = finish_io(pipe, &mut overlap, started, stop, Some(deadline))?;
        if count == 0 {
            return Err("Local backend connection closed".into());
        }
        bytes = &mut bytes[count..];
    }
    Ok(())
}
fn write_all(
    pipe: &OwnedHandle,
    stop: Option<&OwnedHandle>,
    deadline: Instant,
    mut bytes: &[u8],
) -> Result<(), String> {
    while !bytes.is_empty() {
        let event = OwnedHandle::event()?;
        let mut overlap = OVERLAPPED {
            hEvent: event.0,
            ..Default::default()
        };
        let started = unsafe {
            WriteFile(
                pipe.0,
                bytes.as_ptr(),
                bytes.len() as u32,
                null_mut(),
                &mut overlap,
            )
        };
        let count = finish_io(pipe, &mut overlap, started, stop, Some(deadline))?;
        if count == 0 {
            return Err("Local backend connection closed".into());
        }
        bytes = &bytes[count..];
    }
    Ok(())
}
fn read_frame(
    pipe: &OwnedHandle,
    stop: Option<&OwnedHandle>,
    deadline: Instant,
    limit: usize,
) -> Result<Vec<u8>, String> {
    let mut length = [0; 4];
    read_exact(pipe, stop, deadline, &mut length)?;
    let length = u32::from_le_bytes(length) as usize;
    if length == 0 || length > limit {
        return Err("Local backend message exceeds its size limit".into());
    }
    let mut bytes = vec![0; length];
    read_exact(pipe, stop, deadline, &mut bytes)?;
    Ok(bytes)
}
fn write_frame(
    pipe: &OwnedHandle,
    stop: Option<&OwnedHandle>,
    deadline: Instant,
    bytes: &[u8],
) -> Result<(), String> {
    write_all(pipe, stop, deadline, &(bytes.len() as u32).to_le_bytes())?;
    write_all(pipe, stop, deadline, bytes)
}
fn encode(value: &Value, limit: usize) -> Result<Vec<u8>, String> {
    struct Bounded {
        bytes: Vec<u8>,
        limit: usize,
    }
    impl Write for Bounded {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
                return Err(std::io::Error::other(
                    "Local backend message exceeds its size limit",
                ));
            }
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = Bounded {
        bytes: Vec::new(),
        limit,
    };
    serde_json::to_writer(&mut writer, value).map_err(|e| e.to_string())?;
    Ok(writer.bytes)
}

fn create_pipe(endpoint: &Endpoint, first: bool) -> Result<OwnedHandle, String> {
    let security = UserSecurity::new(&endpoint.sid)?;
    let name = wide(&endpoint.pipe_name);
    OwnedHandle::new(unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX
                | FILE_FLAG_OVERLAPPED
                | if first {
                    FILE_FLAG_FIRST_PIPE_INSTANCE
                } else {
                    0
                },
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            CONNECTIONS as u32,
            64 * 1024,
            64 * 1024,
            5000,
            &security.attributes(),
        )
    })
}
fn accept(pipe: &OwnedHandle, stop: &OwnedHandle) -> Result<bool, String> {
    let event = OwnedHandle::event()?;
    let mut overlap = OVERLAPPED {
        hEvent: event.0,
        ..Default::default()
    };
    let started = unsafe { ConnectNamedPipe(pipe.0, &mut overlap) };
    if started == 0 && unsafe { GetLastError() } == ERROR_PIPE_CONNECTED {
        return Ok(true);
    }
    let result = finish_io(pipe, &mut overlap, started, Some(stop), None);
    // A client may connect and immediately close before the accepting worker is
    // scheduled. Reuse that slot rather than letting disconnects exhaust it.
    if result.is_err() && matches!(unsafe { GetLastError() }, ERROR_NO_DATA | ERROR_BROKEN_PIPE) {
        return Ok(false);
    }
    result.map(|_| true)
}
fn serve_one(
    pipe: &OwnedHandle,
    stop: &OwnedHandle,
    handler: &Handler,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let result = read_frame(pipe, Some(stop), deadline, MAX_REQUEST_BYTES)
        .and_then(|bytes| {
            serde_json::from_slice(&bytes).map_err(|_| "Invalid local backend JSON request".into())
        })
        .and_then(|request| {
            if stop.signalled() {
                Err("Local backend is stopping".into())
            } else {
                handler(request)
            }
        });
    let response = match result {
        Ok(value) => json!({"ok":true,"value":value}),
        Err(error) => json!({"ok":false,"error":error}),
    };
    let bytes = encode(&response, MAX_RESPONSE_BYTES).unwrap_or_else(|_| {
        b"{\"ok\":false,\"error\":\"Local backend response exceeds its size limit\"}".to_vec()
    });
    write_frame(pipe, Some(stop), deadline, &bytes)?;
    let mut ack = [0];
    read_exact(pipe, Some(stop), deadline, &mut ack)?;
    if ack != [1] {
        return Err("Invalid local backend response acknowledgement".into());
    }
    Ok(())
}

pub(crate) struct Server {
    stop: Arc<OwnedHandle>,
    workers: Vec<JoinHandle<()>>,
}
impl Server {
    pub(crate) fn start(
        endpoint: &Endpoint,
        guard: &InstanceGuard,
        handler: Handler,
    ) -> Result<Self, String> {
        Self::start_with_timeout(endpoint, guard, handler, IO_TIMEOUT)
    }
    fn start_with_timeout(
        endpoint: &Endpoint,
        guard: &InstanceGuard,
        handler: Handler,
        timeout: Duration,
    ) -> Result<Self, String> {
        if guard.name != endpoint.mutex_name {
            return Err("Backend instance ownership does not match the endpoint".into());
        }
        // All slots stay open for the lifetime of the server. No unbounded
        // per-client threads, polling loops, or gap in ownership of the pipe name.
        let pipes: Vec<_> = (0..CONNECTIONS)
            .map(|i| create_pipe(endpoint, i == 0))
            .collect::<Result<_, _>>()?;
        let stop = Arc::new(OwnedHandle::event()?);
        let mut server = Self {
            stop,
            workers: Vec::new(),
        };
        for pipe in pipes {
            let stop = server.stop.clone();
            let handler = handler.clone();
            let worker = std::thread::Builder::new()
                .name("resource-manager-ipc".into())
                .spawn(move || {
                    while !stop.signalled() {
                        match accept(&pipe, &stop) {
                            Ok(true) => {
                                let _ = serve_one(&pipe, &stop, &handler, timeout);
                            }
                            Ok(false) => {}
                            Err(_) => {
                                unsafe { SetEvent(stop.0) };
                                break;
                            }
                        }
                        unsafe { DisconnectNamedPipe(pipe.0) };
                    }
                })
                .map_err(|e| e.to_string())?;
            server.workers.push(worker);
        }
        Ok(server)
    }
    /// Stop admission and wake all pending I/O, then join workers. Active handler
    /// calls are allowed to return; drain TaskSystem first and do not call this
    /// synchronously from inside a handler. Keep InstanceGuard alive throughout.
    pub(crate) fn stop(&mut self) {
        unsafe { SetEvent(self.stop.0) };
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn endpoint() -> Endpoint {
        Endpoint::current_user(&format!("synthetic-ipc-{}", uuid::Uuid::new_v4())).unwrap()
    }
    fn primary(endpoint: &Endpoint) -> InstanceGuard {
        match endpoint.claim().unwrap() {
            Claim::Primary(guard) => guard,
            Claim::Existing => panic!("unexpected existing synthetic backend"),
        }
    }

    #[test]
    fn separate_threads_cannot_claim_one_backend_and_release_restores_claimability() {
        let endpoint = endpoint();
        let guard = primary(&endpoint);
        assert!(matches!(endpoint.claim().unwrap(), Claim::Existing));
        let other = endpoint.clone();
        assert!(
            std::thread::spawn(move || matches!(other.claim().unwrap(), Claim::Existing))
                .join()
                .unwrap()
        );
        drop(guard);
        let _guard = primary(&endpoint);
    }

    #[test]
    #[ignore = "subprocess fixture used only by the isolated instance test"]
    fn synthetic_existing_instance() {
        let scope =
            std::env::var("RESOURCE_MANAGER_IPC_TEST_SCOPE").expect("synthetic parent required");
        let endpoint = Endpoint::current_user(&scope).unwrap();
        assert!(matches!(endpoint.claim().unwrap(), Claim::Existing));
        assert_eq!(
            endpoint
                .request(&json!({"ping":"child"}), Duration::from_secs(5))
                .unwrap()["ping"],
            "child"
        );
    }

    #[test]
    fn another_process_uses_the_existing_backend_instead_of_becoming_a_writer() {
        use std::os::windows::process::CommandExt;
        let scope = format!("synthetic-ipc-process-{}", uuid::Uuid::new_v4());
        let endpoint = Endpoint::current_user(&scope).unwrap();
        let guard = primary(&endpoint);
        let _server = Server::start(&endpoint, &guard, Arc::new(Ok)).unwrap();
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "backend_ipc::tests::synthetic_existing_instance",
                "--ignored",
                "--nocapture",
            ])
            .env("RESOURCE_MANAGER_IPC_TEST_SCOPE", scope)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(String::from_utf8_lossy(&result.stdout).contains("1 passed"));
    }

    #[test]
    fn actual_pipe_dacl_grants_only_the_current_account() {
        use windows_sys::Win32::Security::{
            Authorization::{GetSecurityInfo, SE_KERNEL_OBJECT},
            GetAce, ACCESS_ALLOWED_ACE, DACL_SECURITY_INFORMATION,
        };
        let endpoint = endpoint();
        let _guard = primary(&endpoint);
        let pipe = create_pipe(&endpoint, true).unwrap();
        let mut acl = null_mut();
        let mut descriptor = null_mut();
        let status = unsafe {
            GetSecurityInfo(
                pipe.0,
                SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut acl,
                null_mut(),
                &mut descriptor,
            )
        };
        assert_eq!(status, 0);
        let descriptor = UserSecurity(descriptor);
        assert!(!acl.is_null());
        assert_eq!(unsafe { (*acl).AceCount }, 1);
        let mut ace = null_mut();
        assert_ne!(unsafe { GetAce(acl, 0, &mut ace) }, 0);
        let ace = ace.cast::<ACCESS_ALLOWED_ACE>();
        assert_eq!(
            unsafe { (*ace).Header.AceType },
            0,
            "ACCESS_ALLOWED_ACE_TYPE"
        );
        let mut sid = null_mut();
        assert_ne!(
            unsafe {
                ConvertSidToStringSidW(std::ptr::addr_of_mut!((*ace).SidStart).cast(), &mut sid)
            },
            0
        );
        let actual_sid = unsafe {
            let mut length = 0;
            while *sid.add(length) != 0 {
                length += 1;
            }
            let text = String::from_utf16(std::slice::from_raw_parts(sid, length)).unwrap();
            LocalFree(sid.cast());
            text
        };
        assert_eq!(actual_sid, endpoint.sid);
        drop(descriptor);
    }

    #[test]
    fn local_pipe_round_trip_preserves_values_and_business_errors_without_storage() {
        let endpoint = endpoint();
        let guard = primary(&endpoint);
        let mut server = Server::start(
            &endpoint,
            &guard,
            Arc::new(|request| {
                if request["fail"] == true {
                    Err("synthetic rejected action".into())
                } else {
                    Ok(request)
                }
            }),
        )
        .unwrap();
        let request = json!({"action":"synthetic","text":"中文\nUnicode","nested":[1,true,null]});
        assert_eq!(
            endpoint.request(&request, Duration::from_secs(5)).unwrap(),
            request
        );
        assert_eq!(
            endpoint
                .request(&json!({"fail":true}), Duration::from_secs(5))
                .unwrap_err(),
            "synthetic rejected action"
        );
        server.stop();
        assert!(endpoint
            .request(&request, Duration::from_millis(100))
            .is_err());
    }

    #[test]
    fn oversized_and_malformed_messages_never_reach_the_handler() {
        let endpoint = endpoint();
        let guard = primary(&endpoint);
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let _server = Server::start(
            &endpoint,
            &guard,
            Arc::new(move |_| {
                observed.fetch_add(1, Ordering::SeqCst);
                Ok(Value::Null)
            }),
        )
        .unwrap();
        assert!(endpoint
            .request(
                &json!("x".repeat(MAX_REQUEST_BYTES)),
                Duration::from_secs(1)
            )
            .is_err());
        for invalid in [b"not json".to_vec(), vec![]] {
            let deadline = Instant::now() + Duration::from_secs(2);
            let pipe = endpoint.connect(deadline).unwrap();
            write_frame(&pipe, None, deadline, &invalid).unwrap();
            let response: Value = serde_json::from_slice(
                &read_frame(&pipe, None, deadline, MAX_RESPONSE_BYTES).unwrap(),
            )
            .unwrap();
            assert_eq!(response["ok"], false);
            write_all(&pipe, None, deadline, &[1]).unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        let pipe = endpoint.connect(deadline).unwrap();
        write_all(
            &pipe,
            None,
            deadline,
            &((MAX_REQUEST_BYTES + 1) as u32).to_le_bytes(),
        )
        .unwrap();
        let response: Value =
            serde_json::from_slice(&read_frame(&pipe, None, deadline, MAX_RESPONSE_BYTES).unwrap())
                .unwrap();
        assert_eq!(response["ok"], false);
        write_all(&pipe, None, deadline, &[1]).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn connection_slots_time_out_and_stop_wakes_idle_and_partial_reads() {
        let endpoint = endpoint();
        let guard = primary(&endpoint);
        let mut server =
            Server::start_with_timeout(&endpoint, &guard, Arc::new(Ok), Duration::from_millis(150))
                .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let clients: Vec<_> = (0..CONNECTIONS)
            .map(|_| endpoint.connect(deadline).unwrap())
            .collect();
        // Filling the fixed slots cannot create more worker threads or hang a
        // legitimate request forever: abandoned request reads have a deadline.
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(
            endpoint
                .request(&json!({"ready":true}), Duration::from_secs(2))
                .unwrap()["ready"],
            true
        );
        drop(clients);
        let client = endpoint
            .connect(Instant::now() + Duration::from_secs(2))
            .unwrap();
        write_all(
            &client,
            None,
            Instant::now() + Duration::from_secs(2),
            &[10, 0],
        )
        .unwrap();
        let started = Instant::now();
        server.stop();
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn response_limit_is_reported_and_a_second_server_cannot_replace_the_endpoint() {
        let endpoint = endpoint();
        let guard = primary(&endpoint);
        let _server = Server::start(
            &endpoint,
            &guard,
            Arc::new(|_| Ok(json!("x".repeat(MAX_RESPONSE_BYTES)))),
        )
        .unwrap();
        assert!(Server::start(&endpoint, &guard, Arc::new(Ok)).is_err());
        assert!(endpoint
            .request(&Value::Null, Duration::from_secs(5))
            .unwrap_err()
            .contains("size limit"));
    }

    #[test]
    fn disappearing_clients_do_not_permanently_consume_connection_slots() {
        let endpoint = endpoint();
        let guard = primary(&endpoint);
        let _server = Server::start(&endpoint, &guard, Arc::new(Ok)).unwrap();
        for _ in 0..24 {
            drop(
                endpoint
                    .connect(Instant::now() + Duration::from_secs(2))
                    .unwrap(),
            );
        }
        assert_eq!(
            endpoint
                .request(&json!({"live":true}), Duration::from_secs(5))
                .unwrap()["live"],
            true
        );
    }
}
