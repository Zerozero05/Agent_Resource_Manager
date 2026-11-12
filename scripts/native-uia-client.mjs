import childProcess from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const formalApp = 'D:\\03_github_projects\\Agent_Resource_Manager\\app\\agent-resource-manager.exe';
const codexBin = 'C:\\Users\\Administrator\\AppData\\Local\\OpenAI\\Codex\\bin\\';
const fileTime = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
function validPin(pin) {
  return pin?.role === 'mcpTransport' && Number.isSafeInteger(pin.pid) && pin.pid > 0
    && fileTime(pin.createdFileTime) && Number.isSafeInteger(pin.parentPid) && pin.parentPid > 0 && pin.parentPid !== pin.pid
    && fileTime(pin.hostCreatedFileTime) && BigInt(pin.hostCreatedFileTime) <= BigInt(pin.createdFileTime)
    && pin.executable === formalApp && typeof pin.hostExecutable === 'string'
    && pin.hostExecutable.toLowerCase().startsWith(codexBin.toLowerCase())
    && /^[a-f0-9]{16}\\codex\.exe$/i.test(pin.hostExecutable.slice(codexBin.length))
    && pin.exactMcpArgv === true && pin.loadedImageSha256 === null;
}
const pinFields = ['pid', 'createdFileTime', 'parentPid', 'hostCreatedFileTime', 'hostExecutable', 'executable', 'role', 'exactMcpArgv', 'loadedImageSha256'];
export async function runManagerPreflightCli(arguments_) {
  if (arguments_.length !== 5 || arguments_[0] !== '--manager-preflight' || arguments_[1] !== '--sha256' || arguments_[3] !== '--pinned-transports-base64') throw new Error('Only the fixed manager preflight arguments are accepted.');
  const [, , sha256, , encoded] = arguments_;
  if (!/^[a-f0-9]{64}$/i.test(sha256) || typeof encoded !== 'string' || encoded.length > 16384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('Invalid bounded transport proof.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new Error('Invalid transport proof encoding.');
  let proof;
  try { proof = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid transport proof JSON.'); }
  if (!proof || Object.keys(proof).sort().join(',') !== 'candidateSha256,transports' || proof.candidateSha256 !== sha256.toLowerCase() || !Array.isArray(proof.transports) || proof.transports.length > 12 || proof.transports.some(pin => !validPin(pin) || Object.keys(pin).sort().join(',') !== [...pinFields].sort().join(','))) throw new Error('Transport proof must contain only bound process identity metadata.');
  return assertNoUserManager({ transportSha256: sha256, pinnedTransports: proof.transports });
}
function verifiedTransport(manager, expectedSha256, pinnedTransports) {
  const proof = manager.transportProof;
  const pin = pinnedTransports.find(entry => entry.pid === manager.pid);
  const roleEvidence = pinnedTransports.length
    ? pin && proof?.roleEvidence === 'pinned-existing-stdio' && pin.createdFileTime === proof.createdFileTime
      && pin.parentPid === proof.hostPid && pin.hostCreatedFileTime === proof.hostCreatedFileTime
      && pin.hostExecutable.toLowerCase() === proof.hostExecutable?.toLowerCase() && proof.loadedImageSha256 === null
    : proof?.roleEvidence === 'current-file-start-identity' && fileTime(proof.createdFileTime) && fileTime(proof.appWriteFileTime)
      && BigInt(proof.createdFileTime) >= BigInt(proof.appWriteFileTime) && proof.loadedImageSha256 === null;
  return !!expectedSha256 && manager.name === 'agent-resource-manager.exe' && manager.ownership === 'sameUser'
    && manager.role === 'mcpTransport' && proof?.currentFileSha256 === expectedSha256 && roleEvidence
    && typeof proof.executable === 'string' && proof.executable.toLowerCase() === formalApp.toLowerCase()
    && fileTime(proof.createdFileTime) && fileTime(proof.appWriteFileTime)
    && Number.isSafeInteger(proof.hostPid) && proof.hostPid > 0 && proof.hostPid !== manager.pid && proof.parentPid === proof.hostPid
    && fileTime(proof.hostCreatedFileTime) && BigInt(proof.hostCreatedFileTime) <= BigInt(proof.createdFileTime)
    && typeof proof.hostExecutable === 'string' && proof.hostExecutable.toLowerCase().startsWith(codexBin.toLowerCase())
    && /^[a-f0-9]{16}\\codex\.exe$/i.test(proof.hostExecutable.slice(codexBin.length))
    && proof.physicalPathVerified === true && proof.exactMcpArgv === true && proof.hostSameUser === true && proof.identityRechecked === true;
}

export async function assertNoUserManager({ pwsh = 'pwsh.exe', transportSha256, pinnedTransports = [] } = {}) {
  if (typeof pwsh !== 'string' || !pwsh.trim() || pwsh.includes('\0')) throw new Error('Manager ownership checks require a PowerShell executable path.');
  if (transportSha256 !== undefined && (typeof transportSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(transportSha256))) throw new Error('Transport classification requires the verified candidate SHA256.');
  const expectedSha256 = transportSha256?.toLowerCase();
  if (!Array.isArray(pinnedTransports) || pinnedTransports.length > 12 || pinnedTransports.some(pin => !validPin(pin)) || new Set(pinnedTransports.map(pin => pin.pid)).size !== pinnedTransports.length || pinnedTransports.length && !expectedSha256) throw new Error('Pinned transports require explicit verified process identities and a candidate SHA256.');
  const pinData = Buffer.from(JSON.stringify(pinnedTransports), 'utf8').toString('base64');
  // This exception is available only to a caller already bound to a candidate.
  // No process command line is queried by the default strict preflight.
  const transportSetup = expectedSha256 ? String.raw`
    $formalApp='D:\03_github_projects\Agent_Resource_Manager\app\agent-resource-manager.exe'
    $expectedSha256='${expectedSha256}'
    $codexBin='C:\Users\Administrator\AppData\Local\OpenAI\Codex\bin\'
    $pinnedTransportMap=@{}
    foreach($pin in @([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${pinData}'))|ConvertFrom-Json)){$pinnedTransportMap[[int]$pin.pid]=$pin}
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NativeStdioArgvGuard {
 [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CommandLineToArgvW(string command, out int count);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr address);
 public static string[] Parse(string command) {int count;IntPtr pointer=CommandLineToArgvW(command,out count);if(pointer==IntPtr.Zero)throw new InvalidOperationException("Argument parsing failed");try{var values=new string[count];for(int i=0;i<count;i++)values[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer,i*IntPtr.Size));return values;}finally{LocalFree(pointer);}}
}
'@
    function Assert-PhysicalFile([string]$path) {
      $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
      if($item -isnot [IO.FileInfo]){throw 'Expected an ordinary file.'}
      $current=$item
      while($null -ne $current){
        if(($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Redirected executable path.'}
        $current=if($current -is [IO.DirectoryInfo]){$current.Parent}else{$current.Directory}
      }
      if(-not [string]::Equals([IO.Path]::GetFullPath($item.FullName),$path,[StringComparison]::OrdinalIgnoreCase)){throw 'Executable path mismatch.'}
      return $item
    }
    $appProof=$null
    try {
      $file=Assert-PhysicalFile $formalApp
      $hash=(Get-FileHash -LiteralPath $formalApp -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
      if($hash -eq $expectedSha256){$appProof=@{sha256=$hash;writeTime=$file.LastWriteTimeUtc.ToFileTimeUtc().ToString();length=$file.Length}}
    } catch { }
    $hostProofs=@{}
    $transportPids=@{}
    function Get-TransportProof($process) {
      if($null -eq $appProof -or -not [string]::Equals([string]$process.ExecutablePath,$formalApp,[StringComparison]::OrdinalIgnoreCase)){return $null}
      # Only this fixed, verified image is queried for its command line. Use the
      # OS argument parser; path separator spelling is not extra authority.
      $identity=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$process.ProcessId) -Property ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate,CommandLine -ErrorAction Stop
      if($null -eq $identity -or $null -eq $identity.CreationDate -or $null -eq $process.CreationDate){return $null}
      $created=$identity.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()
      if($created -ne $process.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString() -or $identity.ParentProcessId -ne $process.ParentProcessId -or -not [string]::Equals([string]$identity.ExecutablePath,$formalApp,[StringComparison]::OrdinalIgnoreCase)){return $null}
      $argv=[NativeStdioArgvGuard]::Parse([string]$identity.CommandLine)
      if($argv.Count -ne 2 -or $argv[1] -cne '--mcp' -or -not [string]::Equals($argv[0].Replace('/','\'),$formalApp,[StringComparison]::OrdinalIgnoreCase)){return $null}
      $pinnedIdentity=$pinnedTransportMap[[int]$identity.ProcessId]
      if($pinnedTransportMap.Count -gt 0){
        if($null -eq $pinnedIdentity -or $pinnedIdentity.createdFileTime -ne $created -or $pinnedIdentity.parentPid -ne $identity.ParentProcessId){return $null}
      }elseif([long]$created -lt [long]$appProof.writeTime){return $null}
      $parentPid=[int]$identity.ParentProcessId
      if(-not $hostProofs.ContainsKey($parentPid)){
        $codexHostIdentity=Get-CimInstance Win32_Process -Filter ('ProcessId='+$parentPid) -Property ProcessId,Name,ExecutablePath,CreationDate -ErrorAction Stop
        if($null -eq $codexHostIdentity -or $null -eq $codexHostIdentity.CreationDate -or $codexHostIdentity.Name -ine 'codex.exe' -or -not ([string]$codexHostIdentity.ExecutablePath).StartsWith($codexBin,[StringComparison]::OrdinalIgnoreCase)){return $null}
        if(([string]$codexHostIdentity.ExecutablePath).Substring($codexBin.Length) -notmatch '^[a-fA-F0-9]{16}\\codex\.exe$'){return $null}
        $null=Assert-PhysicalFile ([string]$codexHostIdentity.ExecutablePath)
        $hostOwner=Invoke-CimMethod -InputObject $codexHostIdentity -MethodName GetOwnerSid -ErrorAction Stop
        if($hostOwner.ReturnValue -ne 0 -or $hostOwner.Sid -ne $currentSid){return $null}
        $hostProofs[$parentPid]=@{pid=$parentPid;created=$codexHostIdentity.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString();executable=[string]$codexHostIdentity.ExecutablePath}
      }
      $codexHostIdentity=$hostProofs[$parentPid]
      if([long]$codexHostIdentity.created -gt [long]$created){return $null}
      if($pinnedTransportMap.Count -gt 0 -and ($pinnedIdentity.hostCreatedFileTime -ne $codexHostIdentity.created -or -not [string]::Equals([string]$pinnedIdentity.hostExecutable,[string]$codexHostIdentity.executable,[StringComparison]::OrdinalIgnoreCase))){return $null}
      $transportPids[[int]$identity.ProcessId]=@{created=$created;parent=$parentPid}
      $roleEvidence=if($pinnedTransportMap.Count -gt 0){'pinned-existing-stdio'}else{'current-file-start-identity'}
      return [pscustomobject]@{currentFileSha256=$appProof.sha256;executable=$formalApp;createdFileTime=$created;appWriteFileTime=$appProof.writeTime;hostPid=$parentPid;parentPid=$parentPid;hostCreatedFileTime=$codexHostIdentity.created;hostExecutable=$codexHostIdentity.executable;physicalPathVerified=$true;exactMcpArgv=$true;hostSameUser=$true;identityRechecked=$true;roleEvidence=$roleEvidence;loadedImageSha256=$null}
    }
  ` : '';
  const transportClassification = expectedSha256 ? String.raw`
      if($ownership -eq 'sameUser' -and $record.name -eq 'agent-resource-manager.exe'){
        try {$proof=Get-TransportProof $process;if($null -ne $proof){$record|Add-Member -NotePropertyName role -NotePropertyValue 'mcpTransport';$record|Add-Member -NotePropertyName transportProof -NotePropertyValue $proof}} catch { }
      }
  ` : '';
  const transportRecheck = expectedSha256 ? String.raw`
    if($transportPids.Count -gt 0){
      $file=Assert-PhysicalFile $formalApp
      if($file.Length -ne $appProof.length -or $file.LastWriteTimeUtc.ToFileTimeUtc().ToString() -ne $appProof.writeTime -or (Get-FileHash -LiteralPath $formalApp -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() -ne $expectedSha256){throw 'Transport executable changed during preflight.'}
      foreach($entry in $transportPids.GetEnumerator()){
        $again=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$entry.Key) -Property ProcessId,ParentProcessId,ExecutablePath,CreationDate -ErrorAction Stop
        if($null -eq $again -or $null -eq $again.CreationDate -or $again.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString() -ne $entry.Value.created -or $again.ParentProcessId -ne $entry.Value.parent -or -not [string]::Equals([string]$again.ExecutablePath,$formalApp,[StringComparison]::OrdinalIgnoreCase)){throw 'Transport process identity changed during preflight.'}
      }
      foreach($entry in $hostProofs.GetEnumerator()){
        $again=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$entry.Key) -Property ProcessId,ExecutablePath,CreationDate -ErrorAction Stop
        if($null -eq $again -or $null -eq $again.CreationDate -or $again.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString() -ne $entry.Value.created -or -not [string]::Equals([string]$again.ExecutablePath,$entry.Value.executable,[StringComparison]::OrdinalIgnoreCase)){throw 'Codex host identity changed during preflight.'}
      }
      $after=@(Get-CimInstance Win32_Process -Filter "Name='agent-resource-manager.exe' OR Name='skill-manager.exe'" -Property ProcessId,CreationDate -ErrorAction Stop)
      $beforeKeys=@($processes|ForEach-Object {[string]$_.ProcessId+':'+$(if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()}else{'unknown'})}|Sort-Object)
      $afterKeys=@($after|ForEach-Object {[string]$_.ProcessId+':'+$(if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()}else{'unknown'})}|Sort-Object)
      if(($beforeKeys -join '|') -cne ($afterKeys -join '|')){throw 'Manager process inventory changed during preflight.'}
    }
  ` : '';
  const command = `
    $ErrorActionPreference='Stop'
    $currentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if([string]::IsNullOrWhiteSpace($currentSid)){throw 'Current user identity is unavailable.'}
    ${transportSetup}
    $processes=@(Get-CimInstance Win32_Process -Filter "Name='agent-resource-manager.exe' OR Name='skill-manager.exe'" -Property ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate -ErrorAction Stop)
    $managers=@(foreach($process in $processes){
      $ownership='unknown'
      try {
        $owner=Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop
        if($owner.ReturnValue -eq 0 -and -not [string]::IsNullOrWhiteSpace($owner.Sid)){
          $ownership=if($owner.Sid -eq $currentSid){'sameUser'}else{'otherUser'}
        }
      } catch { }
      $record=[pscustomobject]@{name=$process.Name.ToLowerInvariant();pid=[int]$process.ProcessId;ownership=$ownership}
      ${transportClassification}
      $record
    })
    ${transportRecheck}
    [pscustomobject]@{checked=$true;managers=$managers}|ConvertTo-Json -Depth 5 -Compress`;
  const stdout = await new Promise((done, reject) => {
    childProcess.execFile(pwsh, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024 }, (error, output) => {
      if (error) reject(new Error('Could not verify manager process ownership before native launch.'));
      else done(output);
    });
  });
  let result;
  try { result = JSON.parse(stdout); } catch { throw new Error('Manager ownership check returned invalid JSON.'); }
  if (result?.checked !== true || !Array.isArray(result.managers)) throw new Error('Manager ownership check returned an incomplete result.');
  const seen = new Set();
  for (const manager of result.managers) {
    if (!manager || !['agent-resource-manager.exe', 'skill-manager.exe'].includes(manager.name) || !Number.isSafeInteger(manager.pid) || manager.pid <= 0 || seen.has(manager.pid) || !['sameUser', 'otherUser', 'unknown'].includes(manager.ownership)) throw new Error('Manager ownership check returned an invalid process record.');
    seen.add(manager.pid);
  }
  const blocked = result.managers.filter(manager => manager.ownership !== 'otherUser' && !verifiedTransport(manager, expectedSha256, pinnedTransports));
  if (blocked.length) {
    const details = blocked.map(manager => `${manager.name} (PID ${manager.pid}, ${manager.ownership === 'sameUser' ? 'same user' : 'ownership unknown'})`).join(', ');
    throw new Error('Native launch is blocked by an existing manager process. ' + details);
  }
  return { checked: true, managers: result.managers.map(manager => ({ name: manager.name, pid: manager.pid, ownership: manager.ownership, ...(verifiedTransport(manager, expectedSha256, pinnedTransports) ? { role: 'mcpTransport', createdFileTime: manager.transportProof.createdFileTime, hostPid: manager.transportProof.hostPid, roleEvidence: manager.transportProof.roleEvidence, loadedImageSha256: null } : {}) })) };
}

// The child driver owns the real native process and validates PID, creation
// identity and HWND before every input. This class never terminates by name.
export class NativeUiaSession {
  constructor(child, reportPath) {
    this.child = child; this.reportPath = reportPath; this.nextId = 1; this.pending = new Map(); this.stderr = ''; this.exited = false;
    this.driverMemoryDiagnostic = false; this.inputEnded = false;
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.closed = new Promise(resolve => { this.closeResolve = resolve; });
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', line => {
      let value; try { value = JSON.parse(line); } catch { return; }
      if (value.event === 'ready') { this.identity = value; this.readyResolve(value); }
      else if (value.id !== undefined) {
        const pending = this.pending.get(value.id); if (!pending) return;
        this.pending.delete(value.id); clearTimeout(pending.timer);
        if (value.ok) pending.resolve(value.value); else {
          this.operationError ??= value.error;
          pending.reject(this.rejectAll(new Error(`Native UIA ${pending.op}: ${value.error}`)));
          this.endInput();
        }
      } else this.driverReport = value;
    });
    child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-1024 * 1024); });
    child.stdin.on('error', error => { this.rejectAll(error); this.endInput(); });
    child.once('error', error => { this.rejectAll(error); this.endInput(); });
    // The GUI can inherit the driver's pipe handles. Its lifetime must not
    // prevent observing that the driver itself has already exited.
    child.once('exit', async code => {
      this.exited = true; this.exitCode = code;
      try { this.driverReport = JSON.parse(await readFile(this.reportPath, 'utf8')); } catch { /* The explicit missing-report check remains in quit. */ }
      if (!this.identity || this.pending.size) this.rejectAll(new Error(`Native UIA driver exited (${code}): ${this.stderr.slice(-3000)}`));
      child.stdout.destroy(); child.stderr.destroy();
      this.closeResolve({ code, driverReport: this.driverReport });
    });
  }
  rejectAll(error) {
    this.failure ??= error;
    this.readyReject(this.failure);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.failure); }
    this.pending.clear();
    return this.failure;
  }
  endInput() {
    if (this.inputEnded || this.child.stdin.writableEnded || this.child.stdin.destroyed) return;
    this.inputEnded = true;
    try { this.child.stdin.end(); } catch (error) { this.rejectAll(error); }
  }
  static async launch({ executable, dataDir, reportPath, sha256, transportSha256 = sha256, pinnedTransports, pwsh = 'pwsh.exe', privateUi = false, accessibilityInput = false, concurrentObservation = false, basicMode = false, workbenchOnlyReadiness = false, keyboardInput = false, driverMemoryDiagnostic = false }) {
    if (sha256 !== undefined && (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256))) throw new Error('Native launch requires a verified candidate SHA256 when provided.');
    if (typeof basicMode !== 'boolean') throw new Error('Native basic mode requires an explicit boolean.');
    if (typeof workbenchOnlyReadiness !== 'boolean') throw new Error('Functional workbench-only readiness requires an explicit boolean.');
    if (typeof keyboardInput !== 'boolean') throw new Error('Functional keyboard input requires an explicit boolean.');
    if (typeof driverMemoryDiagnostic !== 'boolean') throw new Error('Driver memory diagnostics require an explicit boolean.');
    if (driverMemoryDiagnostic && (accessibilityInput !== true || keyboardInput || privateUi)) throw new Error('Driver memory diagnostics require an explicitly enabled non-private accessibility-only session without keyboard input.');
    if (keyboardInput && privateUi) throw new Error('Functional keyboard input is unavailable for a private UI session.');
    if (concurrentObservation && !accessibilityInput) throw new Error('Concurrent observation requires explicit native accessibility input.');
    await assertNoUserManager({ pwsh, ...(transportSha256 !== undefined ? { transportSha256 } : {}), ...(pinnedTransports !== undefined ? { pinnedTransports } : {}) });
    const script = fileURLToPath(new URL('verify-native-uia.ps1', import.meta.url));
    const temporary = join(dirname(dataDir), 'driver-temp'); await mkdir(temporary, { recursive: true });
    const arguments_ = ['-NoProfile', '-NonInteractive', '-File', script, '-Executable', executable, '-DataDirectory', dataDir, '-OutputFile', reportPath, '-ExpectedSha256', sha256, '-Mode', 'bridge'];
    if (privateUi) arguments_.push('-PrivateUi');
    if (accessibilityInput) arguments_.push('-AccessibilityInput');
    if (concurrentObservation) arguments_.push('-ConcurrentObservation');
    if (basicMode) arguments_.push('-BasicMode');
    if (workbenchOnlyReadiness) arguments_.push('-WorkbenchOnlyReadiness');
    if (keyboardInput) arguments_.push('-KeyboardInput');
    if (driverMemoryDiagnostic) arguments_.push('-DriverMemoryDiagnostic');
    if (sha256 !== undefined) {
      const transports = (pinnedTransports ?? []).map(pin => Object.fromEntries(pinFields.map(field => [field, pin[field]])));
      const encoded = Buffer.from(JSON.stringify({ candidateSha256: transportSha256.toLowerCase(), transports }), 'utf8').toString('base64');
      if (encoded.length > 16384) throw new Error('Transport proof exceeds the bounded native launch argument.');
      arguments_.push('-PinnedTransportProofBase64', encoded, '-GuardNodeExecutable', process.execPath);
      arguments_.push('-TransportFileSha256', transportSha256.toLowerCase());
    }
    const child = childProcess.spawn(pwsh, arguments_, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TEMP: temporary, TMP: temporary } });
    const session = new NativeUiaSession(child, reportPath);
    session.privateUi = privateUi;
    session.accessibilityInput = accessibilityInput;
    session.keyboardInput = keyboardInput;
    session.driverMemoryDiagnostic = driverMemoryDiagnostic;
    const deadline = setTimeout(() => { session.rejectAll(new Error('Native UIA readiness exceeded sixty seconds. The driver was asked to close normally.')); session.endInput(); }, 60000);
    try { await session.ready; return session; } finally { clearTimeout(deadline); }
  }
  call(op, fields = {}, timeoutMs = 20000) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.exited) return Promise.reject(new Error('The owned native UIA driver is no longer running.'));
    if (this.inputEnded || this.child.stdin.writableEnded || this.child.stdin.destroyed || this.child.stdin.writable === false) return Promise.reject(this.rejectAll(new Error('The owned native UIA driver input pipe is closed; no command was sent or replayed.')));
    if (['driverMemory', 'collectDriverMemory'].includes(op) && (this.driverMemoryDiagnostic !== true || this.accessibilityInput !== true || this.keyboardInput || this.privateUi)) return Promise.reject(new Error('Driver memory diagnostics require an explicitly enabled non-private accessibility-only session without keyboard input.'));
    if (this.privateUi && ['snapshot', 'names', 'screenshot', 'comboState'].includes(op)) return Promise.reject(new Error('Whole-interface observations are disabled for the private UI session.'));
    if (op === 'keyboardSelectPopupCombo') {
      if (this.privateUi || this.keyboardInput !== true || this.accessibilityInput !== true) return Promise.reject(new Error('Popup combo keyboard selection requires an explicitly enabled non-private functional keyboard session.'));
      if (!['发行版本', '发行文件'].includes(fields.name)) return Promise.reject(new Error('Popup combo keyboard selection is restricted to the two GitHub release fields.'));
      if (typeof fields.option !== 'string' || !fields.option || fields.option.length > 512 || /[\u0000-\u001f\u007f-\u009f]/.test(fields.option)) return Promise.reject(new Error('Popup combo selection requires one exact bounded ordinary option name.'));
      const labels = fields.catalogueOptions;
      const placeholder = fields.name === '发行版本' ? '请选择版本' : '请选择发行文件';
      if (!Array.isArray(labels) || labels.length < 1 || labels.length > 100 || labels[0] !== placeholder || labels.some(label => typeof label !== 'string' || !label || label.length > 512 || /[\u0000-\u001f\u007f-\u009f]/.test(label)) || new Set(labels).size !== labels.length || labels.filter(label => label === fields.option).length !== 1) return Promise.reject(new Error('Popup combo catalogue requires up to 100 unique ordinary labels, its exact first placeholder and the exact target once.'));
    }
    if (op === 'keyboardSelectClosedCombo') {
      if (this.privateUi || this.keyboardInput !== true || this.accessibilityInput !== true) return Promise.reject(new Error('Closed combo keyboard selection requires an explicitly enabled non-private functional keyboard session.'));
      if (!['发行版本', '发行文件'].includes(fields.name)) return Promise.reject(new Error('Closed combo keyboard selection is restricted to the two GitHub release fields.'));
      if (typeof fields.option !== 'string' || !fields.option || fields.option.length > 512 || /[\u0000-\u001f\u007f-\u009f]/.test(fields.option)) return Promise.reject(new Error('Closed combo selection requires one exact bounded ordinary option name.'));
      if (fields.catalogueOptions !== undefined) {
        const labels = fields.catalogueOptions;
        if (!Array.isArray(labels) || labels.length < 1 || labels.length > 100 || labels.some(label => typeof label !== 'string' || !label || label.length > 512 || /[\u0000-\u001f\u007f-\u009f]/.test(label)) || new Set(labels).size !== labels.length || labels.filter(label => label === fields.option).length !== 1) return Promise.reject(new Error('Closed combo catalogue requires up to 100 unique ordinary labels containing the exact target once.'));
      }
    }
    if (op === 'selectCombo' && fields.focusBeforeExpand !== undefined) {
      if (typeof fields.focusBeforeExpand !== 'boolean') return Promise.reject(new Error('Focus before combo expansion requires an explicit boolean.'));
      if (fields.focusBeforeExpand && (this.privateUi || this.accessibilityInput !== true || fields.foreground === true)) return Promise.reject(new Error('Focus before expansion requires a non-private accessibility-only functional selection.'));
    }
    if (op === 'prepareKeyboardForeground' && (this.privateUi || this.keyboardInput !== true)) return Promise.reject(new Error('Keyboard operations require an explicitly enabled non-private functional session.'));
    if (['keyboardShortcut', 'keyboardEdit', 'keyboardField', 'keyboardIme'].includes(op)) {
      if (this.privateUi || this.keyboardInput !== true) return Promise.reject(new Error('Keyboard operations require an explicitly enabled non-private functional session.'));
      if (typeof fields.name !== 'string' || !fields.name || fields.name.length > 160) return Promise.reject(new Error('Keyboard operations require one exact named input.'));
      if (op === 'keyboardIme' && fields.name !== '搜索 Skill') return Promise.reject(new Error('Physical IME verification is restricted to the isolated Skill search field.'));
      if (op === 'keyboardIme' && fields.prepareChineseIme !== undefined && typeof fields.prepareChineseIme !== 'boolean') return Promise.reject(new Error('Chinese IME preparation requires an explicit boolean.'));
      if (op === 'keyboardIme' && fields.observeChineseIme !== undefined && typeof fields.observeChineseIme !== 'boolean') return Promise.reject(new Error('Chinese IME observation requires an explicit boolean.'));
      if (op === 'keyboardIme' && fields.observeChineseIme === true && fields.prepareChineseIme === true) return Promise.reject(new Error('Chinese IME observation cannot also request a mode switch.'));
      if (op === 'keyboardIme' && fields.modeToggleKey !== undefined && !['shift', 'ctrl'].includes(fields.modeToggleKey)) return Promise.reject(new Error('IME mode toggle supports only the explicit shift or ctrl key.'));
      if (op === 'keyboardShortcut' && !['CtrlK', 'CtrlZ', 'CtrlY', 'CtrlShiftZ', 'Escape', 'Enter', 'Space'].includes(fields.gesture)) return Promise.reject(new Error('Unsupported native keyboard gesture.'));
      if (op === 'keyboardEdit' && (typeof fields.value !== 'string' || fields.value.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(fields.value))) return Promise.reject(new Error('Keyboard edit requires at most 256 ordinary single-line characters.'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.rejectAll(new Error(`Native UIA ${op} exceeded its observation deadline; no command was replayed.`)); this.endInput(); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, op });
      try {
        this.child.stdin.write(JSON.stringify({ ...fields, id, op }) + '\n', error => {
          if (error) { this.rejectAll(error); this.endInput(); }
        });
      } catch (error) { this.rejectAll(error); this.endInput(); }
    });
  }
  async quit() {
    if (!this.exited && !this.failure && !this.operationError) {
      try { await this.call('quit'); } catch (error) { this.rejectAll(error); }
    }
    this.endInput();
    let deadline;
    const result = await Promise.race([
      this.closed,
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('The owned UIA driver did not exit within twenty-five seconds. The native app may remain open; no process was forcibly stopped.')), 25000); }),
    ]).catch(error => { throw this.failure ?? error; }).finally(() => clearTimeout(deadline));
    if (this.failure) throw this.failure;
    if (!result.driverReport?.closedNormally) throw new Error('The owned native app did not finish the real normal exit handshake. No forced stop was attempted.');
    return result;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runManagerPreflightCli(process.argv.slice(2));
    process.stdout.write('native-manager-preflight-ok-v1\n');
  } catch {
    process.stderr.write('Native manager preflight was not verified; no product was started.\n');
    process.exitCode = 1;
  }
}
