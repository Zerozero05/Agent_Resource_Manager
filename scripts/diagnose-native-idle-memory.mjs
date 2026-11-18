import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { cpus } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createPerformanceFixture, FIXTURE_FORMAT } from './performance-fixture.mjs';
import { PERFORMANCE_POLICY, freezeConvergenceBounds } from './performance-policy.mjs';

const approved = 'D:\\03_github_projects\\Agent_Management\\Agent_Resource_Manager\\validation\\manager-data';
const candidateRoot = fileURLToPath(new URL('../outputs/v1-validation/detached-task-summary-allocation-20261109/', import.meta.url));
const executable = join(candidateRoot, 'agent-resource-manager.exe');
const buildInfoPath = join(candidateRoot, 'candidate-build-info.json');
const candidateSha256 = 'd0b6551f5fd11125ec6f548b7239643f9076a6ccec0ccf54f6afca15e8ce87e0';
const format = 'agent-resource-manager-native-idle-memory-v1';
const execute = promisify(execFile);
const json = value => JSON.stringify(value, null, 2) + '\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = async path => hash(await readFile(path));
const same = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase();
const sleep = milliseconds => new Promise(done => setTimeout(done, Math.max(0, milliseconds)));
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const sourcePaths = ['diagnose-native-idle-memory.mjs', 'performance-fixture.mjs', 'performance-policy.mjs'].map(name => fileURLToPath(new URL(name, import.meta.url)));

export const IDLE_DIAGNOSTIC_POLICY = Object.freeze({
  preparationIdleMs: 120000,
  idleCalibrationSamples: PERFORMANCE_POLICY.idleCalibrationSamples,
  sampleIntervalMs: PERFORMANCE_POLICY.sampleIntervalMs,
  durationMs: PERFORMANCE_POLICY.stabilityDurationMs,
  sampleCount: 61,
  cpuWindowMs: 3000,
  normalQuitWaitMs: 180000,
});

export function idleOptions(args) {
  const mode = args[0] || '--prepare';
  assert.ok(['--prepare', '--validate', '--run', '--help'].includes(mode), 'Use prepare, validate or run explicitly.');
  assert.equal(args.length || 1, ['--validate', '--run'].includes(mode) ? 2 : 1, 'Pass one exact mode and its descriptor where required.');
  return { mode, descriptor: args[1] };
}

export function insideValidation(path) {
  const part = relative(approved, resolve(path));
  return part !== '' && !part.startsWith('..') && !isAbsolute(part);
}

async function ordinary(path, file = false) {
  const info = await lstat(path);
  assert.ok(!info.isSymbolicLink() && (file ? info.isFile() && info.nlink === 1 : info.isDirectory()), 'Require an ordinary, unlinked diagnostic path.');
  assert.ok(same(await realpath(path), path), 'A diagnostic path resolved elsewhere.');
}

async function ownedPath(path, file = false) {
  assert.ok(insideValidation(path), 'Diagnostic files must stay inside the approved validation directory.');
  for (let parent = dirname(path); !same(parent, approved); parent = dirname(parent)) await ordinary(parent);
  await ordinary(approved);
  await ordinary(path, file);
}

async function runtimeFiles(dataset) {
  const files = [];
  for (const [root, count, prefix, width, name] of [[dataset.skillsRoot, 1000, 'perf-skill-', 4, 'SKILL.md'], [dataset.toolsRoot, 100, 'perf-tool-', 3, 'README.md']]) {
    for (let index = 0; index < count; index++) {
      const path = join(root, prefix + String(index).padStart(width, '0'), name);
      await ownedPath(path, true);
      files.push({ path, sha256: await digest(path) });
    }
  }
  return files;
}

function protectedData(dataset) {
  const db = new DatabaseSync(dataset.dbPath, { readOnly: true });
  try {
    const state = JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload);
    return {
      settings: state.settings, sources: state.sources, connections: state.connections,
      localRoots: state.localRoots, ignoredLocalPaths: state.ignoredLocalPaths, checkMode: state.checkMode,
      skills: state.skills.map(skill => Object.fromEntries(['id', 'name', 'displayName', 'localPath', 'version', 'favorite', 'categoryId', 'localHashes', 'runtimeFiles'].map(key => [key, skill[key]]))),
      resources: db.prepare('SELECT id,revision,payload FROM resource_catalog ORDER BY id').all(),
    };
  } finally { db.close(); }
}

export const IDLE_OBSERVER = String.raw`param([ValidateSet('status','sample','compile')][string]$Mode,[string]$Spec)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
public static class IdleMemoryRead {
  [StructLayout(LayoutKind.Sequential)] struct InputInfo { public uint size,tick; }
  [DllImport("user32.dll",SetLastError=true)] static extern bool GetLastInputInfo(ref InputInfo value);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder path,ref uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeServerProcessId(IntPtr pipe,out uint pid);
  public static uint InputTick() {
    var value=new InputInfo{size=8};
    if(!GetLastInputInfo(ref value))throw new InvalidOperationException("Desktop input metadata is unavailable.");
    return value.tick;
  }
  static void Check(Process process,JsonElement spec) {
    process.Refresh();if(process.HasExited)throw new InvalidOperationException("Owned process exited.");
    if(spec.TryGetProperty("creationFileTime",out var created)&&created.ValueKind==JsonValueKind.String&&process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()!=created.GetString())throw new InvalidOperationException("Owned creation identity changed.");
    var path=new StringBuilder(32768);uint size=(uint)path.Capacity;
    if(!QueryFullProcessImageName(process.Handle,0,path,ref size)||!String.Equals(Path.GetFullPath(path.ToString()),Path.GetFullPath(spec.GetProperty("executable").GetString()),StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Owned executable image changed.");
  }
  static JsonElement Request(Process process,string payload) {
    string sid=WindowsIdentity.GetCurrent().User.Value;
    string key=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("io.skillmanager.desktop\0"+sid))).ToLowerInvariant();
    using(var pipe=new NamedPipeClientStream(".","AgentResourceManager-"+key,PipeDirection.InOut,PipeOptions.Asynchronous)) {
      pipe.Connect(2000);uint owner;
      if(!GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out owner)||owner!=(uint)process.Id)throw new InvalidOperationException("Backend pipe owner differs from the exact diagnostic process.");
      using(var stop=new CancellationTokenSource(5000)) {
        byte[] request=Encoding.UTF8.GetBytes(payload);
        pipe.WriteAsync(BitConverter.GetBytes(request.Length),stop.Token).AsTask().GetAwaiter().GetResult();
        pipe.WriteAsync(request,stop.Token).AsTask().GetAwaiter().GetResult();
        byte[] length=new byte[4];pipe.ReadExactlyAsync(length,stop.Token).AsTask().GetAwaiter().GetResult();
        int count=BitConverter.ToInt32(length,0);if(count<2||count>8*1024*1024)throw new InvalidOperationException("Backend frame exceeds its bound.");
        byte[] response=new byte[count];pipe.ReadExactlyAsync(response,stop.Token).AsTask().GetAwaiter().GetResult();
        pipe.WriteAsync(new byte[]{1},stop.Token).AsTask().GetAwaiter().GetResult();
        using(var document=JsonDocument.Parse(response)) {
          if(!document.RootElement.GetProperty("ok").GetBoolean())throw new InvalidOperationException("Read-only backend request failed.");
          return document.RootElement.GetProperty("value").Clone();
        }
      }
    }
  }
  public static string Read(string encoded,string name) {
    if(name!="status"&&name!="task_list"&&name!="content_cache_stats")throw new ArgumentException("Only the fixed read-only observation tools are available.");
    using(var document=JsonDocument.Parse(Encoding.UTF8.GetString(Convert.FromBase64String(encoded))))
    using(var process=Process.GetProcessById(document.RootElement.GetProperty("pid").GetInt32())) {
      var spec=document.RootElement;Check(process,spec);
      var status=Request(process,"{\"protocol\":1,\"kind\":\"status\"}");
      if(!status.GetProperty("ready").GetBoolean())throw new TimeoutException("Owned backend readiness is pending.");
      if(status.GetProperty("processId").GetInt32()!=process.Id||!String.Equals(Path.GetFullPath(status.GetProperty("dataDir").GetString()),Path.GetFullPath(spec.GetProperty("dataDir").GetString()),StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Backend selected a different diagnostic data directory.");
      JsonElement value=name=="status"?status:Request(process,"{\"protocol\":1,\"kind\":\"tool\",\"name\":\""+name+"\",\"arguments\":{}}");
      Check(process,spec);
      return JsonSerializer.Serialize(new{pid=process.Id,creationFileTime=process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(),value=value});
    }
  }
}
'@
if($Mode -eq 'compile'){[pscustomobject]@{compiled=$true;observationInvoked=$false;temporaryDirectory=[IO.Path]::GetTempPath()}|ConvertTo-Json -Compress;exit 0}
try {
  $specValue=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Spec))|ConvertFrom-Json
  $status=[IdleMemoryRead]::Read($Spec,'status')|ConvertFrom-Json
  if($Mode -eq 'status') {
    [pscustomobject]@{ok=$true;identity=@{pid=$status.pid;creationFileTime=$status.creationFileTime};ready=$status.value.ready;dataDir=$status.value.dataDir;lastInputTick=[IdleMemoryRead]::InputTick()}|ConvertTo-Json -Depth 5 -Compress
    exit 0
  }
  if(-not $specValue.creationFileTime){throw 'Sampling requires an already pinned process creation identity.'}
  $inputTickBefore=[IdleMemoryRead]::InputTick()
  $tasks=([IdleMemoryRead]::Read($Spec,'task_list')|ConvertFrom-Json).value
  $active=@($tasks.tasks|Where-Object {$_.status -in @('running','queued')}).Count
  if($active){throw 'Actual active tasks prevent an idle observation.'}
  function Read-Memory {
    $all=@(Get-CimInstance Win32_Process)
    $ids=[Collections.Generic.HashSet[int]]::new();[void]$ids.Add([int]$status.pid)
    do{$added=$false;foreach($row in $all){if($ids.Contains([int]$row.ParentProcessId)-and $ids.Add([int]$row.ProcessId)){$added=$true}}}while($added)
    $rows=@(foreach($row in $all){
      if(-not $ids.Contains([int]$row.ProcessId)){continue}
      $process=Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue;if(-not $process){continue}
      $created=$process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
      if([long]$created -lt [long]$specValue.creationFileTime){throw 'A purported owned descendant predates the diagnostic process.'}
      $role=if($row.ProcessId -eq $status.pid){'manager'}elseif($row.Name -eq 'msedgewebview2.exe'){if($row.CommandLine -match '--type=([a-zA-Z-]+)'){'webview-'+$Matches[1]}else{'webview-browser'}}else{'native-child'}
      [pscustomobject]@{pid=[int]$row.ProcessId;parentPid=[int]$row.ParentProcessId;creationFileTime=$created;image=$row.Name;role=$role;privateBytes=$process.PrivateMemorySize64;workingSetBytes=$process.WorkingSet64;cpuMs=$process.TotalProcessorTime.TotalMilliseconds}
    })
    if(@($rows|Where-Object {$_.pid -eq $status.pid -and $_.creationFileTime -eq $specValue.creationFileTime}).Count -ne 1){throw 'Pinned manager process accounting disappeared.'}
    return $rows
  }
  $first=@(Read-Memory);$timer=[Diagnostics.Stopwatch]::StartNew();Start-Sleep -Milliseconds 3000;$second=@(Read-Memory);$windowMs=$timer.Elapsed.TotalMilliseconds
  $cache=([IdleMemoryRead]::Read($Spec,'content_cache_stats')|ConvertFrom-Json).value
  [pscustomobject]@{ok=$true;identity=@{pid=$status.pid;creationFileTime=$status.creationFileTime};first=$first;processes=$second;idleMeasurementWindowMs=$windowMs;cache=$cache;taskCount=@($tasks.tasks).Count;activeTaskCount=$active;inputTickBefore=$inputTickBefore;lastInputTick=[IdleMemoryRead]::InputTick();observerPrivateBytes=(Get-Process -Id $PID).PrivateMemorySize64}|ConvertTo-Json -Depth 7 -Compress
}catch {
  [pscustomobject]@{ok=$false;errorType=$_.Exception.GetBaseException().GetType().Name}|ConvertTo-Json -Compress
}
`;

async function prepare() {
  await mkdir(approved, { recursive: true });
  await ordinary(approved);
  const root = await mkdtemp(join(approved, 'native-idle-memory-'));
  const dataset = await createPerformanceFixture(root, 'idle-fixture', 100);
  const driver = join(root, 'idle-observer.ps1');
  await writeFile(driver, IDLE_OBSERVER, { flag: 'wx' });
  const descriptorPath = join(root, 'idle-dataset.json');
  const descriptor = { format, syntheticOnly: true, root, dataset, policy: IDLE_DIAGNOSTIC_POLICY, candidateSha256,
    buildInfoSha256: await digest(buildInfoPath), driver, driverSha256: hash(IDLE_OBSERVER),
    initialDatabaseSha256: await digest(dataset.dbPath), runtimeFiles: await runtimeFiles(dataset),
    sources: await Promise.all(sourcePaths.map(async path => ({ path, sha256: await digest(path) }))), createdAt: new Date().toISOString() };
  await writeFile(descriptorPath, json(descriptor), { flag: 'wx' });
  await validate(descriptorPath);
  console.log(json({ status: 'prepared-native-not-run', descriptor: descriptorPath, noManagerStarted: true, noObserverStarted: true }));
}

async function validate(path) {
  path = resolve(path);
  await ownedPath(path, true);
  const descriptor = JSON.parse(await readFile(path, 'utf8')), { dataset } = descriptor;
  assert.equal(basename(path), 'idle-dataset.json');
  assert.equal(descriptor.format, format); assert.equal(descriptor.syntheticOnly, true);
  assert.ok(same(descriptor.root, dirname(path)) && basename(descriptor.root).startsWith('native-idle-memory-'));
  assert.deepEqual(descriptor.policy, IDLE_DIAGNOSTIC_POLICY); assert.equal(descriptor.candidateSha256, candidateSha256);
  assert.equal(dataset.format, FIXTURE_FORMAT); assert.equal(dataset.syntheticOnly, true);
  assert.equal(dataset.skillCount, 1000); assert.equal(dataset.toolCount, 100);
  for (const [key, suffix] of [['root', ''], ['dataDir', 'data'], ['dbPath', 'data/manager.sqlite3'], ['skillsRoot', 'skills'], ['toolsRoot', 'tools']]) {
    assert.ok(same(dataset[key], join(descriptor.root, 'idle-fixture', suffix)));
    await ownedPath(dataset[key], key === 'dbPath');
  }
  await ownedPath(join(dataset.root, 'dataset.json'), true);
  assert.deepEqual(JSON.parse(await readFile(join(dataset.root, 'dataset.json'), 'utf8')), dataset);
  assert.deepEqual(await readdir(dataset.dataDir), ['manager.sqlite3'], 'Use an original unlaunched fixture.');
  assert.equal(await digest(dataset.dbPath), descriptor.initialDatabaseSha256);
  const initial = protectedData(dataset);
  assert.equal(initial.checkMode, 'manual');
  for (const key of ['sources', 'connections', 'localRoots', 'ignoredLocalPaths']) assert.deepEqual(initial[key], []);
  assert.equal(initial.skills.length, 1000); assert.equal(initial.resources.length, 100);
  for (let index = 0; index < initial.skills.length; index++) {
    const skill = initial.skills[index], id = 'perf-skill-' + String(index).padStart(4, '0');
    assert.equal(skill.id, id); assert.ok(same(skill.localPath, join(dataset.skillsRoot, id)));
  }
  for (const [index, row] of initial.resources.entries()) {
    const tool = JSON.parse(row.payload);
    assert.equal(tool.id, 'perf-tool-' + String(index).padStart(3, '0')); assert.equal(row.id, tool.id);
    assert.ok(same(tool.rootPath, join(dataset.toolsRoot, tool.id))); assert.deepEqual(tool.actions, []);
    assert.deepEqual(tool.capabilities, []); assert.equal(tool.installation, null);
    assert.equal(tool.repository, null); assert.equal(tool.updatePolicy.mode, 'manual');
  }
  assert.ok(same(descriptor.driver, join(descriptor.root, 'idle-observer.ps1')));
  await ownedPath(descriptor.driver, true);
  assert.equal(await digest(descriptor.driver), hash(IDLE_OBSERVER)); assert.equal(descriptor.driverSha256, hash(IDLE_OBSERVER));
  assert.deepEqual(descriptor.sources, await Promise.all(sourcePaths.map(async path => ({ path, sha256: await digest(path) }))));
  assert.deepEqual(descriptor.runtimeFiles, await runtimeFiles(dataset));
  await ordinary(executable, true); await ordinary(buildInfoPath, true);
  const build = JSON.parse(await readFile(buildInfoPath, 'utf8'));
  assert.equal(build.buildMode, 'release'); assert.ok(build.diagnosticOnly !== true && build.productionCandidate !== false);
  assert.ok(same(build.executablePath, executable)); assert.equal(build.executableSha256, candidateSha256);
  assert.equal(await digest(executable), candidateSha256); assert.equal(await digest(buildInfoPath), descriptor.buildInfoSha256);
  return { descriptor, descriptorPath: path, descriptorSha256: await digest(path) };
}

export function idleObservation(raw, identity, processors) {
  assert.equal(raw.ok, true, 'The fixed owner-checked observation failed.');
  assert.equal(raw.identity.pid, identity.pid); assert.equal(raw.identity.creationFileTime, identity.creationFileTime);
  assert.ok(Number.isInteger(processors) && processors > 0 && raw.idleMeasurementWindowMs >= 3000);
  assert.equal(raw.activeTaskCount, 0);
  assert.ok(Array.isArray(raw.first) && Array.isArray(raw.processes));
  for (const group of [raw.first, raw.processes]) {
    assert.equal(new Set(group.map(row => row.pid)).size, group.length, 'A process must be counted once per observation.');
    for (const row of group) {
      assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0 && BigInt(row.creationFileTime) >= BigInt(identity.creationFileTime));
      for (const key of ['privateBytes', 'workingSetBytes', 'cpuMs']) assert.ok(Number.isFinite(row[key]) && row[key] >= 0);
    }
  }
  const first = new Map(raw.first.map(row => [`${row.pid}:${row.creationFileTime}`, row.cpuMs]));
  const rows = raw.processes;
  assert.ok(rows.length > 0 && rows.filter(row => row.pid === identity.pid && row.creationFileTime === identity.creationFileTime).length === 1);
  assert.equal(raw.cache.limitBytes, PERFORMANCE_POLICY.contentCacheLimitBytes);
  assert.ok(Number.isFinite(raw.cache.bytes) && raw.cache.bytes >= 0);
  return { privateBytes: rows.reduce((sum, row) => sum + row.privateBytes, 0), workingSetBytes: rows.reduce((sum, row) => sum + row.workingSetBytes, 0),
    idleCpuPercent: rows.reduce((sum, row) => sum + Math.max(0, row.cpuMs - (first.get(`${row.pid}:${row.creationFileTime}`) ?? 0)), 0) / raw.idleMeasurementWindowMs / processors * 100,
    idleMeasurementWindowMs: raw.idleMeasurementWindowMs, cache: raw.cache, ownedProcesses: rows, taskCount: raw.taskCount,
    observerPrivateBytes: raw.observerPrivateBytes, inputTickBefore: raw.inputTickBefore, lastInputTick: raw.lastInputTick };
}

export function unchangedInputTick(expected, observed) {
  return Number.isSafeInteger(expected) && expected >= 0 && Number.isSafeInteger(observed) && observed >= 0 && expected === observed;
}

function boundedFailure(error) {
  if (error && typeof error === 'object' && ('cmd' in error || 'stderr' in error)) return { message: 'The bounded read-only observer process failed.', code: error.code ?? null, signal: error.signal ?? null, stderr: String(error.stderr || '').replace(/[A-Za-z0-9+/=]{160,}/g, '[encoded output omitted]').slice(0, 1200) };
  return { message: String(error?.message || error).slice(0, 1200) };
}

async function run(prepared) {
  const { descriptor, descriptorPath, descriptorSha256 } = prepared, { dataset } = descriptor;
  const temporary = join(descriptor.root, 'observer-temp'), reportPath = join(descriptor.root, 'idle-result.json');
  await writeFile(join(descriptor.root, 'run-owner.json'), json({ descriptorSha256, candidateSha256 }), { flag: 'wx' });
  await mkdir(temporary);
  const environment = { ...process.env, TEMP: temporary, TMP: temporary };
  for (const name of Object.keys(environment)) if (/^(SKILL_MANAGER_DATA_DIR|WEBVIEW2_(USER_DATA_FOLDER|ADDITIONAL_BROWSER_ARGUMENTS|WAIT_FOR_SCRIPT_DEBUGGER|PIPE_FOR_SCRIPT_DEBUGGER))$/i.test(name)) delete environment[name];
  const report = { format, status: 'running-idle-diagnostic', diagnosticOnly: true, nativeAcceptanceClaim: false, replacesPriorFailure: false,
    candidate: { executable, candidateSha256, buildInfoPath, buildInfoSha256: descriptor.buildInfoSha256 }, descriptorPath, descriptorSha256,
    policy: IDLE_DIAGNOSTIC_POLICY, sources: descriptor.sources, driverSha256: descriptor.driverSha256, temporary,
    startedAt: new Date().toISOString(), uiAutomationUsed: false, inputSent: false, appGcRequested: false,
    localChecksTriggered: false, navigationCycles: 0, calibration: [], samples: [], normalExit: false,
    limitations: ['Static idle and the existing owner-checked task_list/content_cache_stats tools only. No local check, navigation, download, update or cache-pressure workload.',
      'No accessibility API is used by this script. Other desktop observers and user interaction are outside its control.',
      'The initial real LastInputInfo tick is pinned once. Any change after readiness invalidates the idle condition and stops collection without resetting its baseline.',
      'Private bytes include retained allocation capacity and do not establish a retained-object leak.',
      'The original interactive thirty-minute failure and its gates remain unchanged. No convergence or native acceptance pass is issued.',
      'GUI startup may display or activate a window. After the final sample, the operator must perform normal Quit within three minutes.'] };
  const save = () => writeFile(reportPath, json(report));
  let child, exited, identity, baseline, initialInputTick;
  async function observe(mode) {
    assert.ok(child && !exited, 'The owned diagnostic process exited before observation.');
    assert.equal(await digest(descriptor.driver), descriptor.driverSha256);
    const spec = Buffer.from(JSON.stringify({ pid: child.pid, creationFileTime: identity?.creationFileTime, executable, dataDir: dataset.dataDir }), 'utf8').toString('base64');
    const pending = execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', descriptor.driver, '-Mode', mode, '-Spec', spec], { windowsHide: true, timeout: 20000, maxBuffer: 256 * 1024, env: environment });
    pending.child.stdin.end();
    const { stdout } = await pending, value = JSON.parse(stdout.trim());
    assert.ok(!exited, 'The owned process exited during observation.');
    if (value.ok && initialInputTick !== undefined) {
      if (!unchangedInputTick(initialInputTick, value.lastInputTick) || mode === 'sample' && !unchangedInputTick(initialInputTick, value.inputTickBefore)) {
        report.idleConditionInvalidated = true;
        report.inputChange = { initialInputTick, beforeSample: value.inputTickBefore, observed: value.lastInputTick };
        throw new Error('Desktop input changed after the pinned idle baseline. Sampling stopped.');
      }
    }
    return value;
  }
  try {
    await save();
    const { stdout } = await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', "@(Get-CimInstance Win32_Process -Filter \"Name='agent-resource-manager.exe' OR Name='skill-manager.exe'\").Count|ConvertTo-Json -Compress"], { windowsHide: true, timeout: 10000, env: environment });
    assert.equal(JSON.parse(stdout.trim()), 0, 'Another manager already exists.');
    assert.equal(await digest(executable), candidateSha256);
    child = spawn(executable, ['--data-dir', dataset.dataDir], { cwd: candidateRoot, env: environment, stdio: 'ignore', windowsHide: false });
    child.on('error', error => { exited = { spawnError: error.code || 'spawn-failed' }; });
    child.on('exit', (code, signal) => { exited = { code, signal }; });
    await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); });
    report.launchedPid = child.pid; await save();
    for (const deadline = performance.now() + 30000; performance.now() < deadline;) {
      const status = await observe('status');
      if (status.ok) {
        assert.equal(status.identity.pid, child.pid); assert.ok(BigInt(status.identity.creationFileTime) > 0n);
        assert.equal(status.ready, true); assert.ok(same(status.dataDir, dataset.dataDir));
        assert.ok(Number.isSafeInteger(status.lastInputTick) && status.lastInputTick >= 0);
        initialInputTick = status.lastInputTick; report.initialInputTick = initialInputTick;
        identity = status.identity; report.identity = identity; report.ownerCheckedBackendDataDirectory = status.dataDir;
        break;
      }
      assert.equal(status.errorType, 'TimeoutException', 'Readiness failed with a non-transient observation error.');
      await sleep(100);
    }
    assert.ok(identity, 'The exact owner-checked backend did not become ready.');
    await save(); await sleep(IDLE_DIAGNOSTIC_POLICY.preparationIdleMs);
    assert.equal((await observe('status')).ok, true, 'The owned backend could not be observed after preparation.');
    report.preparationInputTickVerified = true;
    baseline = protectedData(dataset);
    const calibrationStart = performance.now();
    for (let index = 0; index < IDLE_DIAGNOSTIC_POLICY.idleCalibrationSamples; index++) {
      await sleep(calibrationStart + index * IDLE_DIAGNOSTIC_POLICY.sampleIntervalMs - performance.now());
      report.calibration.push({ elapsedMs: performance.now() - calibrationStart, observedAt: new Date().toISOString(), ...idleObservation(await observe('sample'), identity, cpus().length) });
      await save(); console.log(JSON.stringify({ phase: 'idle-calibration', sample: index + 1, of: 11 }));
    }
    report.bounds = freezeConvergenceBounds(report.calibration);
    await writeFile(join(descriptor.root, 'idle-bounds-before-samples.json'), json(report.bounds), { flag: 'wx' });
    let started = performance.now();
    for (let index = 0; index < IDLE_DIAGNOSTIC_POLICY.sampleCount; index++) {
      await sleep(started + index * IDLE_DIAGNOSTIC_POLICY.sampleIntervalMs - performance.now());
      const sample = { ...idleObservation(await observe('sample'), identity, cpus().length), observedAt: new Date().toISOString(), elapsedMs: performance.now() - started };
      if (!index) { started = performance.now(); sample.elapsedMs = 0; }
      report.samples.push(sample); await save();
      console.log(JSON.stringify({ phase: 'idle-memory-sample', sample: index + 1, of: 61, privateMiB: sample.privateBytes / 1048576 }));
    }
    assert.deepEqual(protectedData(dataset), baseline);
    assert.deepEqual(await runtimeFiles(dataset), descriptor.runtimeFiles);
    report.measurementsCollected = true; report.status = 'idle-diagnostic-measurements-collected';
  } catch (error) { report.status = 'failed-idle-diagnostic'; report.error = boundedFailure(error); process.exitCode = 1; }
  finally {
    if (child && !exited) {
      report.readyForOwnedNormalQuit = true; await save();
      console.log(JSON.stringify({ phase: 'ready-for-owned-normal-quit', pid: child.pid, creationFileTime: identity?.creationFileTime, executable, reportPath, waitMs: IDLE_DIAGNOSTIC_POLICY.normalQuitWaitMs }));
      for (const deadline = performance.now() + IDLE_DIAGNOSTIC_POLICY.normalQuitWaitMs; !exited && performance.now() < deadline;) await sleep(100);
    }
    report.exit = exited || null; report.normalExit = Boolean(exited?.code === 0);
    report.remainingOwnedProcessRequiresAttention = Boolean(child && !exited);
    if (child && !exited) child.unref();
    if (baseline) {
      try { assert.deepEqual(protectedData(dataset), baseline); report.protectedDataPreserved = true; }
      catch (error) { report.status = 'failed-idle-diagnostic'; report.dataError = boundedFailure(error); process.exitCode = 1; }
    }
    try {
      assert.deepEqual(await runtimeFiles(dataset), descriptor.runtimeFiles);
      assert.equal(await digest(executable), candidateSha256);
      assert.deepEqual(descriptor.sources, await Promise.all(sourcePaths.map(async path => ({ path, sha256: await digest(path) }))));
      report.runtimeAndInputDigestsPreserved = true;
    } catch (error) { report.status = 'failed-idle-diagnostic'; report.integrityError = boundedFailure(error); process.exitCode = 1; }
    if (child && !report.normalExit) { report.status = 'failed-idle-diagnostic'; process.exitCode = 1; }
    report.finishedAt = new Date().toISOString(); await save();
  }
  console.log(json({ status: report.status, reportPath, normalExit: report.normalExit, diagnosticOnly: true, nativeAcceptanceClaim: false }));
}

async function main() {
  const options = idleOptions(process.argv.slice(2));
  if (options.mode === '--help') {
    console.log('Prepare with --prepare. Read-only validation with --validate <idle-dataset.json>. Only --run <descriptor> starts fixed normal d0. It records 11 calibration and 61 thirty-second static idle/IPC samples without UIA, input or GC. After ready-for-owned-normal-quit, the operator has three minutes to perform the actual normal Quit. No forced application termination or native convergence pass.');
  } else if (options.mode === '--prepare') await prepare();
  else {
    const prepared = await validate(options.descriptor);
    if (options.mode === '--validate') console.log(json({ status: 'validated-native-not-run', descriptor: prepared.descriptorPath, descriptorSha256: prepared.descriptorSha256, noManagerStarted: true }));
    else await run(prepared);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(json(boundedFailure(error))); process.exitCode = 1; });
}
