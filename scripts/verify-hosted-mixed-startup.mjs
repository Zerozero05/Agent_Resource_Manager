import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { NativeUiaSession } from './native-uia-client.mjs';
import { createPerformanceFixture } from './performance-fixture.mjs';

assert.equal(process.platform, 'win32');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const { values: options } = parseArgs({ options: {
  candidate: { type: 'string' }, 'candidate-build-info': { type: 'string' },
} });
assert.ok(options.candidate && options['candidate-build-info']);
const executable = resolve(options.candidate);
const info = JSON.parse(await readFile(resolve(options['candidate-build-info']), 'utf8'));
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
assert.equal(basename(executable), 'agent-resource-manager.exe');
assert.equal(info.buildMode, 'release');
assert.equal(await digest(executable), info.executableSha256);
assert.ok(info.sourceCommit);

const parent = 'D:\\03_github_projects\\Agent_Management\\Agent_Resource_Manager\\validation\\manager-data';
await mkdir(parent, { recursive: true });
assert.equal((await realpath(parent)).toLowerCase(), parent.toLowerCase());
const output = await mkdtemp(join(parent, 'uia-performance-'));
const fixture = await createPerformanceFixture(output, 'mixed-native-fixture', 100);
const reportPath = join(output, 'mixed-startup-result.json');
const driverPath = join(output, 'candidate-mixed-1000-100-driver.json');
const report = {
  format: 'arm-hosted-mixed-startup-v1', status: 'running', syntheticOnly: true,
  candidate: { executable, sha256: info.executableSha256, source: info.sourceCommit },
  fixture: { dataDir: fixture.dataDir, dataFingerprint: fixture.dataFingerprint, skillCount: fixture.skillCount, toolCount: fixture.toolCount },
  host: { runnerImage: process.env.ImageOS, runnerImageVersion: process.env.ImageVersion, node: process.version },
  startedAt: new Date().toISOString(),
  limitations: ['WebView processes are sampled once after readiness or after the driver reports failure, so earlier exited processes may be absent. Profile markers show existence only. No failure screenshot is taken because the standard driver has no ready session in that case.'],
};
const save = async () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
await save();

async function observeWebView(identity) {
  if (!Number.isSafeInteger(identity?.pid) || !/^\d{16,20}$/.test(identity.creationFileTime)) return { status: 'no-driver-owned-identity' };
  const binding = Buffer.from(JSON.stringify({ pid: identity.pid, creationFileTime: identity.creationFileTime, executable })).toString('base64');
  // Read only exact owned WebView descendants. The command lines and paths used
  // to establish identity stay in the observer and are never emitted.
  const code = String.raw`
$ErrorActionPreference='Stop'
function Emit($value){[Console]::WriteLine(($value|ConvertTo-Json -Depth 6 -Compress))}
$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${binding}'))|ConvertFrom-Json
function Owned-Manager {
  $p=Get-Process -Id $s.pid -ErrorAction SilentlyContinue
  $p -and $p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ceq $s.creationFileTime -and
    [string]::Equals($p.MainModule.FileName,$s.executable,[StringComparison]::OrdinalIgnoreCase)
}
if(-not (Owned-Manager)){Emit @{status='manager-not-running-or-changed'};return}
$parents=@{}
$parents[[int]$s.pid]=[long]$s.creationFileTime
$result=@()
do {
  $found=$false
  $parentFilter=($parents.Keys|ForEach-Object{'ParentProcessId='+$_}) -join ' OR '
  $rows=@(Get-CimInstance Win32_Process -Filter ("Name='msedgewebview2.exe' AND ("+$parentFilter+")") -Property ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine)
  foreach($row in $rows) {
    $pidKey=[int]$row.ProcessId;$parentKey=[int]$row.ParentProcessId
    if($parents.ContainsKey($pidKey) -or -not $parents.ContainsKey($parentKey)){continue}
    $child=Get-Process -Id $pidKey -ErrorAction SilentlyContinue
    if(-not $child -or -not $row.CreationDate -or -not $row.ExecutablePath){continue}
    try {
      $created=$child.StartTime.ToUniversalTime().ToFileTimeUtc()
      $cimTime=$row.CreationDate.ToUniversalTime().ToFileTimeUtc()
      if($created -lt $parents[$parentKey] -or [Math]::Abs($created-$cimTime) -ge 10000 -or
        -not [string]::Equals($child.MainModule.FileName,$row.ExecutablePath,[StringComparison]::OrdinalIgnoreCase)){continue}
      $role='unknown'
      if($row.CommandLine) {
        $role='webview-browser'
        if($row.CommandLine -match '(?:^|\s)"?--type=([a-z-]+)"?(?:\s|$)'){$role='webview-'+$Matches[1]}
      }
      $result+=@{pid=$pidKey;parentPid=$parentKey;creationFileTime=$created.ToString();role=$role;runtimeProductVersion=$child.MainModule.FileVersionInfo.ProductVersion}
    } catch {continue}
    $found=$true;$parents[$pidKey]=$created
  }
} while($found)
if(-not (Owned-Manager)){Emit @{status='manager-exited-during-observation'};return}
Emit @{status='observed';processes=$result}
`;
  const { stdout } = await promisify(execFile)('pwsh.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(code, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024 });
  return JSON.parse(stdout.trim());
}

async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

let app;
try {
  app = await NativeUiaSession.launch({ executable, sha256: info.executableSha256, dataDir: fixture.dataDir,
    reportPath: driverPath, accessibilityInput: true });
  report.native = app.identity;
  report.status = 'ready';
} catch (error) {
  report.launchError = String(error);
  report.status = 'readiness-failed';
}
try {
  const profile = join(fixture.dataDir, 'webview'), engine = join(profile, 'EBWebView');
  report.profileMarkers = { directory: await exists(profile), engineDirectory: await exists(engine),
    defaultProfile: await exists(join(engine, 'Default')), localState: await exists(join(engine, 'Local State')) };
  const identity = app?.identity ?? JSON.parse(await readFile(driverPath, 'utf8'));
  report.webview = await observeWebView(identity);
} catch (error) {
  report.observationError = String(error);
} finally {
  if (app) {
    try { report.closedNormally = (await app.quit()).driverReport.closedNormally; }
    catch (error) { report.status = 'normal-exit-failed'; report.normalExitError = String(error); }
  }
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ status: report.status, report: reportPath, closedNormally: report.closedNormally ?? false }));
  if (report.status !== 'ready' || report.closedNormally !== true) process.exitCode = 1;
}
