import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { cpus } from 'node:os';
import { NativeUiaSession } from './native-uia-client.mjs';
import { createPerformanceFixture, FIXTURE_FORMAT } from './performance-fixture.mjs';
import { IDLE_OBSERVER, idleObservation } from './diagnose-native-idle-memory.mjs';

const format = 'agent-resource-manager-observer-memory-v1';
const approved = 'D:\\03_github_projects\\Agent_Management\\Agent_Resource_Manager\\validation\\manager-data';
const staticVariants = ['ipc-control', 'uia-control', 'uia-driver-collection'];
const churnVariants = ['churn-control', 'churn-driver-collection'];
const variants = [...staticVariants, ...churnVariants];
const policy = Object.freeze({ queryCount: 400, intervalMs: 100, sampleEvery: 100, cycleCount: 40, cycleIntervalMs: 1000, settleMs: 5000, idleMs: 10000 });
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, flag, index, all) => flag.startsWith('--') ? [...pairs, [flag.slice(2), all[index + 1]]] : pairs, []));
const releaseClientRequested = process.argv.includes('--release-client');
if (releaseClientRequested && (args['release-client'] !== 'public-quit' || args.phase !== 'run' || args.variant !== 'churn-control')) throw new Error('Client release is restricted to explicit churn-control --release-client public-quit.');
const requestedTransportSha256 = args['transport-file-sha256'];
const rolesOnly = args['roles-only'] !== undefined;
if (rolesOnly && (args['roles-only'] !== 'true' || args.phase !== 'run'
  || !['ipc-control', 'churn-control'].includes(args.variant) || releaseClientRequested
  || process.platform !== 'win32' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.GITHUB_ACTIONS !== 'true')) {
  throw new Error('Standard process-role observation is limited to the two isolated GitHub-hosted control runs.');
}
if (requestedTransportSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(requestedTransportSha256)) throw new Error('--transport-file-sha256 requires one exact SHA256 digest.');
const json = value => JSON.stringify(value, null, 2) + '\n';
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const sleep = ms => new Promise(done => setTimeout(done, Math.max(0, ms)));
const execute = promisify(execFile);
const inside = (path, parent) => { const part = relative(parent, path); return part === '' || !part.startsWith('..') && !isAbsolute(part); };
const samePath = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase();
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];

// A numeric observer takes ownership before release; it has no UIA/input API.
async function prepareClientHandoff(app, dataset, report, reportPath) {
  const observerScript = join(dataset.root, 'independent-idle-observer.ps1');
  await writeFile(observerScript, IDLE_OBSERVER, { flag: 'wx' });
  const spec = { ...app.identity, executable: report.candidate.executable, executableSha256: report.candidate.sha256, dataDir: dataset.dataDir, observerScript, controllerPid: process.pid };
  const encoded = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64');
  const command = String.raw`
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$spec=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json
$held=$null;$released=$false;$failed=$false
function Send($value){[Console]::WriteLine(($value|ConvertTo-Json -Depth 12 -Compress))}
function Check-Owned {
  $held.Refresh()
  if($held.HasExited -or $held.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -cne $spec.creationFileTime -or -not [string]::Equals($held.MainModule.FileName,$spec.executable,[StringComparison]::OrdinalIgnoreCase)){throw 'Independent observer application identity changed.'}
}
function Read-Independent($mode){
  $start=[Diagnostics.ProcessStartInfo]::new('pwsh.exe');$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.WindowStyle='Hidden';$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  foreach($argument in @('-NoProfile','-NonInteractive','-File',$spec.observerScript,'-Mode',$mode,'-Spec','${encoded}')){$start.ArgumentList.Add($argument)}
  $reader=[Diagnostics.Process]::Start($start)
  try {
    $output=$reader.StandardOutput.ReadToEndAsync();$errorOutput=$reader.StandardError.ReadToEndAsync()
    if(-not $reader.WaitForExit(20000)) {
      Send @{event='numeric-observer-requires-attention';pid=$reader.Id;creationFileTime=$reader.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();forcedStop=$false}
      throw 'Independent numeric observer exceeded twenty seconds; no process was stopped.'
    }
    if($reader.ExitCode -ne 0){throw 'Independent numeric observer failed.'}
    $raw=$output.GetAwaiter().GetResult().Trim()|ConvertFrom-Json
  } finally {$reader.Dispose()}
  if(-not $raw.ok -or $raw.identity.pid -ne $spec.pid -or $raw.identity.creationFileTime -cne $spec.creationFileTime){throw 'Independent numeric observation failed its exact identity check.'}
  return $raw
}
try {
  $held=[Diagnostics.Process]::GetProcessById([int]$spec.pid);$null=$held.Handle;Check-Owned
  if((Get-FileHash -LiteralPath $spec.executable -Algorithm SHA256).Hash.ToLowerInvariant() -cne $spec.executableSha256 -or $held.MainWindowHandle.ToInt64() -ne $spec.windowHandle){throw 'Independent handoff image/window changed.'}
  $self=Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID)
  if($self.ParentProcessId -ne $spec.controllerPid){throw 'Independent observer has a different controller.'}
  $status=Read-Independent 'status'
  if(-not [string]::Equals($status.dataDir,$spec.dataDir,[StringComparison]::OrdinalIgnoreCase)){throw 'Independent handoff selected another database.'}
  $proof=@{pid=$spec.pid;creationFileTime=$spec.creationFileTime;windowHandle=$spec.windowHandle;controllerPid=$spec.controllerPid;observerPid=$PID;observerCreationFileTime=(Get-Process -Id $PID).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()}
  Send @{event='handoff-ready';proof=$proof}
  if([Console]::ReadLine() -cne 'observe-after-client-exit'){return}
  $released=$true;$clock=[Diagnostics.Stopwatch]::StartNew()
  try {
    foreach($offset in @(0,10000,20000)) {
      $wait=$offset-$clock.Elapsed.TotalMilliseconds;if($wait -gt 0){Start-Sleep -Milliseconds ([int]$wait)}
      Check-Owned;$started=$clock.Elapsed.TotalMilliseconds;$raw=Read-Independent 'sample';Check-Owned
      if($raw.inputTickBefore -ne $status.lastInputTick -or $raw.lastInputTick -ne $status.lastInputTick){throw 'Desktop input changed; post-release sampling stopped.'}
      Send @{event='post-client-exit-sample';scheduledOffsetMs=$offset;startedSinceReleaseMs=$started;finishedSinceReleaseMs=$clock.Elapsed.TotalMilliseconds;raw=$raw}
    }
  } catch {$failed=$true;Send @{event='independent-observation-failed';error=$_.Exception.Message}}
} catch {$failed=$true;Send @{event='handoff-failed';error=$_.Exception.Message}}
finally {
  if($held -and $released) {
    Send @{event='ready-for-public-quit';pid=$spec.pid;creationFileTime=$spec.creationFileTime;windowHandle=$spec.windowHandle;waitMs=180000}
    if(-not $held.WaitForExit(180000)){$failed=$true;Send @{event='public-quit-result';normalExit=$false;requiresAttention=$true}}
    else {Send @{event='public-quit-result';normalExit=($held.ExitCode -eq 0);exitCode=$held.ExitCode;requiresAttention=$false}}
  }
  if($held){$held.Dispose()}
}
if($failed){exit 1}
`;
  const observer = spawn('pwsh.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TEMP: join(dataset.root, 'driver-temp'), TMP: join(dataset.root, 'driver-temp') } });
  const lines = createInterface({ input: observer.stdout }); let stderr = '', readyResolve, readyReject, writes = Promise.resolve();
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const readyDeadline = setTimeout(() => { readyReject(new Error('Independent handoff readiness exceeded thirty seconds. No release was sent.')); observer.stdin.end(); }, 30000);
  void ready.finally(() => clearTimeout(readyDeadline)).catch(() => undefined);
  observer.stderr.on('data', value => { stderr = (stderr + value).slice(-3000); });
  observer.stdin.on('error', error => { report.handoffError = String(error); readyReject(error); });
  lines.on('line', line => {
    try {
      const value = JSON.parse(line);
      if (value.event === 'handoff-ready') readyResolve(value.proof);
      else if (value.event === 'post-client-exit-sample') {
        const sample = idleObservation(value.raw, app.identity, cpus().length);
        (report.postClientExitSamples ||= []).push({ ...value, raw: undefined, sample });
      } else if (value.event === 'public-quit-result') { report.normalExit = value.normalExit; report.publicQuitResult = value; }
      else if (value.event === 'numeric-observer-requires-attention') report.numericObserverRequiresAttention = value;
      else if (value.event.endsWith('failed')) { report.handoffError = value.error; readyReject(new Error(value.error)); }
      (report.handoffEvents ||= []).push({ ...value, raw: undefined });
      writes = writes.then(() => writeFile(reportPath, json(report)));
      console.log(JSON.stringify({ ...value, raw: undefined }));
    } catch (error) { report.handoffError = String(error); readyReject(error); }
  });
  const done = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      report.independentObserverRequiresAttention = { pid: observer.pid, forcedStop: false };
      observer.unref(); observer.stdin.unref(); observer.stdout.unref(); observer.stderr.unref();
      reject(new Error('Independent observer exceeded its four-minute soft bound; public cleanup ownership remains external. No process was stopped.'));
    }, 240000);
    observer.once('error', error => { readyReject(error); reject(error); });
    observer.once('close', async (code, signal) => {
      clearTimeout(deadline);
      lines.close(); readyReject(new Error(`Independent observer exited before handoff (${code}): ${stderr}`));
      try { await writes; resolve({ code, signal }); } catch (error) { reject(error); }
    });
  });
  void done.catch(() => undefined);
  return { observer, ready, done };
}

function stored(dataset) {
  const db = new DatabaseSync(dataset.dbPath, { readOnly: true });
  try {
    return {
      state: db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload,
      resources: db.prepare('SELECT id,revision,payload FROM resource_catalog ORDER BY id').all(),
      tasks: db.prepare("SELECT json_extract(payload,'$.id') AS id,json_extract(payload,'$.action') AS action,json_extract(payload,'$.status') AS status FROM task_history ORDER BY id").all(),
    };
  } finally { db.close(); }
}

function navigationInvariants(snapshot) {
  const state = JSON.parse(snapshot.state);
  return {
    settings: state.settings, sources: state.sources, connections: state.connections, localRoots: state.localRoots, categories: state.categories,
    skills: state.skills.map(skill => Object.fromEntries(['id', 'name', 'displayName', 'localPath', 'version', 'favorite', 'categoryId', 'localHashes', 'runtimeFiles'].map(key => [key, skill[key]]))),
    resources: snapshot.resources,
  };
}

async function navigate(app, index) {
  await app.call('search', { index }); await app.call('clear');
  await app.call('filter', { github: true }); await app.call('filter', { github: false });
  await app.call('search', { index: 0 }); await app.call('openDocument', { index: 0 });
  await app.call('tab', { home: true }); await app.call('tab', { home: false });
  await app.call('closeDocument', { index: 0 }); await app.call('clear');
}

async function roles(memory, managerPid) {
  const ids = memory.processes.map(item => Number(item.pid));
  assert.ok(ids.every(Number.isSafeInteger));
  const command = `$ErrorActionPreference='Stop';$taskIds=@(${ids.join(',')});$taskRows=Get-CimInstance Win32_Process -Filter '${ids.map(id => `ProcessId=${id}`).join(' OR ')}';@(foreach($taskRow in $taskRows){$taskRole='unknown';if($taskRow.ProcessId -eq ${managerPid}){$taskRole='manager'}elseif($taskRow.Name -eq 'msedgewebview2.exe'){$taskRole=if($taskRow.CommandLine){'webview-browser'}else{'webview-type-unavailable'};if($taskRow.CommandLine -match '--type=([a-zA-Z-]+)'){$taskRole='webview-'+$Matches[1]}};[pscustomobject]@{pid=$taskRow.ProcessId;parentPid=$taskRow.ParentProcessId;creationFileTime=(Get-Process -Id $taskRow.ProcessId -ErrorAction Stop).StartTime.ToUniversalTime().ToFileTimeUtc().ToString();image=$taskRow.Name;role=$taskRole}})|ConvertTo-Json -Compress`;
  const { stdout } = await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 20000, maxBuffer: 128 * 1024 });
  const observed = list(JSON.parse(stdout.trim()));
  for (const row of observed) assert.ok(memory.processes.some(item => item.pid === row.pid && String(item.creationFileTime) === String(row.creationFileTime)), 'Observed process identity must belong to this exact native session.');
  return observed;
}

if (process.argv.includes('--help')) {
  console.log('Prepare --phase prepare [--workload churn]. Run --phase run --prepared <observer-fixture.json> --variant ipc-control|uia-control|uia-driver-collection|churn-control|churn-driver-collection --candidate <exe> --candidate-build-info <json> [--transport-file-sha256 <verified formal transport digest>]. Static queries or synthetic search/filter/document/tab navigation, no system input. The explicit collection variant collects the measuring driver only. This diagnostic does not replace native performance or memory-convergence acceptance.');
  process.exit(0);
}
assert.ok(['prepare', 'run'].includes(args.phase));
if (args.phase === 'prepare') {
  await mkdir(approved, { recursive: true });
  const root = await mkdtemp(join(approved, 'native-observer-memory-'));
  const datasets = {};
  assert.ok(args.workload === undefined || args.workload === 'churn');
  for (const variant of args.workload === 'churn' ? churnVariants : staticVariants) {
    const dataset = await createPerformanceFixture(root, variant, 100);
    datasets[variant] = { ...dataset, initialDatabaseSha256: await digest(dataset.dbPath) };
  }
  assert.equal(new Set(Object.values(datasets).map(item => item.dataFingerprint)).size, 1);
  const prepared = join(root, 'observer-fixture.json');
  await writeFile(prepared, json({ format, syntheticOnly: true, root, datasets, policy, createdAt: new Date().toISOString() }), { flag: 'wx' });
  console.log(JSON.stringify({ status: 'prepared-not-run', prepared, noNativeLaunch: true }));
  process.exit(0);
}

assert.ok(variants.includes(args.variant));
const descriptorPath = resolve(args.prepared || '');
const fixture = JSON.parse(await readFile(descriptorPath, 'utf8'));
assert.equal(fixture.format, format); assert.equal(fixture.syntheticOnly, true);
assert.ok(samePath(dirname(descriptorPath), fixture.root) && inside(fixture.root, approved));
assert.deepEqual(fixture.policy, policy);
const dataset = fixture.datasets[args.variant];
assert.equal(dataset.format, FIXTURE_FORMAT);
assert.ok(samePath(dataset.root, join(fixture.root, args.variant)) && samePath(dataset.dataDir, join(dataset.root, 'data')));
for (const path of [fixture.root, dataset.root, dataset.dataDir, dataset.skillsRoot, dataset.toolsRoot]) assert.ok(samePath(await realpath(path), path));
assert.equal(await digest(dataset.dbPath), dataset.initialDatabaseSha256, 'Each diagnostic variant must use its original unlaunched fixture.');
const executable = resolve(args.candidate || ''), buildInfoPath = resolve(args['candidate-build-info'] || '');
const build = JSON.parse(await readFile(buildInfoPath, 'utf8'));
assert.equal(build.buildMode, 'release'); assert.ok(build.sourceIdentity || build.sourceCommit);
assert.equal(await digest(executable), build.executableSha256);
const transportSha256 = requestedTransportSha256?.toLowerCase() || build.executableSha256;
const reportPath = join(dataset.root, 'observer-result.json');
const report = {
  format, status: 'running', diagnosticOnly: true, convergenceClaim: false, variant: args.variant, startedAt: new Date().toISOString(),
  candidate: { executable, sha256: build.executableSha256, buildInfoPath, buildInfoSha256: await digest(buildInfoPath), sourceIdentity: build.sourceIdentity || build.sourceCommit },
  transportFileSha256: transportSha256,
  fixture: { root: dataset.root, dataFingerprint: dataset.dataFingerprint, skillCount: dataset.skillCount, toolCount: dataset.toolCount }, policy,
  systemKeyboardOrMouseInput: false, applicationGcRequested: false, samples: [], completedQueries: 0, completedCycles: 0,
  limitations: ['Read-only UIA queries and read-only IPC calls have different internal work; their cadence and call count are fixed, not their CPU cost.', 'Only the explicit collection variant requests collection in the measuring driver. Finalizer completion is asynchronous.', 'Process private bytes include allocator capacity and do not by themselves establish retained live objects or a leak.', 'No production data, external network, browser login, resource execution, installation, backup or cleanup.'],
};
const harnessPaths = ['verify-native-observer-memory.mjs', 'native-uia-client.mjs', 'verify-native-uia.ps1', 'performance-fixture.mjs'].map(name => fileURLToPath(new URL(name, import.meta.url)));
if (releaseClientRequested) harnessPaths.push(fileURLToPath(new URL('diagnose-native-idle-memory.mjs', import.meta.url)));
report.harness = await Promise.all(harnessPaths.map(async path => ({ path, sha256: await digest(path) })));
await writeFile(reportPath, json(report), { flag: 'wx' });
let app, handoff;
async function sample(phase) {
  const value = { phase, observedAt: new Date().toISOString(), application: await app.call('memory'), driver: rolesOnly ? null : await app.call('driverMemory') };
  if (rolesOnly) value.processRoles = await roles(value.application, app.identity.pid);
  report.samples.push(value); await writeFile(reportPath, json(report));
  console.log(JSON.stringify({ phase, applicationMiB: value.application.privateBytes / 1048576, driverMiB: value.driver ? value.driver.privateBytes / 1048576 : null }));
  return value;
}
try {
  app = await NativeUiaSession.launch({ executable, sha256: build.executableSha256, transportSha256, dataDir: dataset.dataDir, reportPath: join(dataset.root, 'native-driver.json'), accessibilityInput: true, driverMemoryDiagnostic: !rolesOnly, releaseDiagnosticClient: releaseClientRequested });
  report.native = app.identity;
  await sleep(policy.settleMs);
  const initial = stored(dataset);
  assert.ok(initial.tasks.every(task => !['running', 'queued'].includes(task.status)), 'Initial native work must finish before the query-only diagnostic.');
  report.rolesOnly = rolesOnly;
  const baseline = await sample('before-queries');
  report.processRoles = baseline.processRoles ?? await roles(baseline.application, app.identity.pid);
  const started = performance.now(), churn = churnVariants.includes(args.variant);
  if (churn) {
    report.limitations.push('Navigation intentionally changes synthetic workspace state and may refresh file-read metadata. Managed identities, settings, runtime file hashes and resources must remain equal.');
    for (let index = 0; index < policy.cycleCount; index++) {
      await sleep(started + index * policy.cycleIntervalMs - performance.now());
      await navigate(app, index + 1); report.completedCycles++;
      if (report.completedCycles % 10 === 0) await sample(`cycles-${report.completedCycles}`);
    }
  } else {
    for (let index = 0; index < policy.queryCount; index++) {
      await sleep(started + index * policy.intervalMs - performance.now());
      if (args.variant === 'ipc-control') await app.call('cache');
      else {
        const rows = list(await app.call('state', { name: 'Perf Skill 0000' }));
        assert.equal(rows.filter(row => row.type === 'ControlType.Button' && row.enabled).length, 1);
      }
      report.completedQueries++;
      if (report.completedQueries % policy.sampleEvery === 0) await sample(`queries-${report.completedQueries}`);
    }
  }
  report.queryElapsedMs = performance.now() - started;
  await sleep(policy.idleMs); await sample('idle-before-optional-driver-collection');
  if (args.variant.endsWith('driver-collection')) {
    report.driverCollection = await app.call('collectDriverMemory');
    assert.equal(report.driverCollection.diagnosticOnly, true); assert.equal(report.driverCollection.appGcRequested, false);
  }
  await sleep(policy.idleMs); await sample('idle-after-optional-driver-collection');
  const finalState = stored(dataset);
  if (churn) {
    assert.deepEqual(navigationInvariants(finalState), navigationInvariants(initial), 'Navigation must preserve managed identities, settings, runtime file hashes and resources.');
    assert.deepEqual(finalState.tasks, initial.tasks, 'Synthetic navigation must not execute a new management task.');
    report.navigationInvariantsAndTaskHistoryUnchanged = true;
  } else {
    assert.deepEqual(finalState, initial, 'Read-only observation must preserve managed state, resources and task history.');
    report.managedStateResourcesAndTaskHistoryUnchanged = true;
  }
  if (releaseClientRequested) {
    handoff = await prepareClientHandoff(app, dataset, report, reportPath);
    const proof = await handoff.ready;
    report.clientHandoff = proof;
    await app.releaseClient(proof);
    report.clientExitedNormally = true;
    handoff.observer.stdin.end('observe-after-client-exit\n');
    const result = await handoff.done;
    assert.equal(result.code, 0); assert.equal(result.signal, null);
    assert.equal(report.postClientExitSamples?.length, 3); assert.equal(report.normalExit, true);
    assert.ok(!report.handoffError, 'Independent handoff observation failed.');
    app = null;
  } else { report.normalExit = (await app.quit()).driverReport.closedNormally; app = null; }
  report.status = 'diagnostic-measurements-collected';
} catch (error) { report.status = 'failed-or-blocked'; report.error = String(error); report.errorStack = error.stack; process.exitCode = 1; }
finally {
  if (handoff && app?.releaseAttempted) {
    if (!handoff.observer.stdin.writableEnded && !handoff.observer.stdin.destroyed) handoff.observer.stdin.end('observe-after-client-exit\n');
    try { await handoff.done; } catch (error) { report.handoffError = String(error); }
  } else {
    handoff?.observer.stdin.end();
    if (handoff) await handoff.done.catch(() => undefined);
    if (app) try { report.normalExit = (await app.quit()).driverReport.closedNormally; } catch (error) { report.normalExitError = String(error); report.status = 'failed-or-blocked'; process.exitCode = 1; }
  }
  report.harnessChangedDuringRun = (await Promise.all(report.harness.map(async file => await digest(file.path) !== file.sha256))).some(Boolean);
  if (report.harnessChangedDuringRun || await digest(executable) !== build.executableSha256) { report.status = 'failed-or-blocked'; report.integrityError = 'Native bytes or the fixed diagnostic harness changed.'; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString(); await writeFile(reportPath, json(report));
  console.log(JSON.stringify({ status: report.status, report: reportPath, normalExit: report.normalExit || false, error: report.error || null }));
}
