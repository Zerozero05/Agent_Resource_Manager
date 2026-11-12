import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { NativeUiaSession } from './native-uia-client.mjs';
import { createPerformanceFixture, FIXTURE_FORMAT } from './performance-fixture.mjs';

const format = 'agent-resource-manager-observer-memory-v1';
const approved = 'D:\\03_github_projects\\Agent_Resource_Manager\\validation\\manager-data';
const staticVariants = ['ipc-control', 'uia-control', 'uia-driver-collection'];
const churnVariants = ['churn-control', 'churn-driver-collection'];
const variants = [...staticVariants, ...churnVariants];
const policy = Object.freeze({ queryCount: 400, intervalMs: 100, sampleEvery: 100, cycleCount: 40, cycleIntervalMs: 1000, settleMs: 5000, idleMs: 10000 });
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, flag, index, all) => flag.startsWith('--') ? [...pairs, [flag.slice(2), all[index + 1]]] : pairs, []));
const json = value => JSON.stringify(value, null, 2) + '\n';
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const sleep = ms => new Promise(done => setTimeout(done, Math.max(0, ms)));
const execute = promisify(execFile);
const inside = (path, parent) => { const part = relative(parent, path); return part === '' || !part.startsWith('..') && !isAbsolute(part); };
const samePath = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase();
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];

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
  const command = `$ErrorActionPreference='Stop';$taskIds=@(${ids.join(',')});$taskRows=Get-CimInstance Win32_Process -Filter '${ids.map(id => `ProcessId=${id}`).join(' OR ')}';@(foreach($taskRow in $taskRows){$taskRole='unknown';if($taskRow.ProcessId -eq ${managerPid}){$taskRole='manager'}elseif($taskRow.Name -eq 'msedgewebview2.exe'){$taskRole='webview-browser';if($taskRow.CommandLine -match '--type=([a-zA-Z-]+)'){$taskRole='webview-'+$Matches[1]}};[pscustomobject]@{pid=$taskRow.ProcessId;parentPid=$taskRow.ParentProcessId;creationFileTime=(Get-Process -Id $taskRow.ProcessId -ErrorAction Stop).StartTime.ToUniversalTime().ToFileTimeUtc().ToString();image=$taskRow.Name;role=$taskRole}})|ConvertTo-Json -Compress`;
  const { stdout } = await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 20000, maxBuffer: 128 * 1024 });
  const observed = list(JSON.parse(stdout.trim()));
  for (const row of observed) assert.ok(memory.processes.some(item => item.pid === row.pid && String(item.creationFileTime) === String(row.creationFileTime)), 'Observed process identity must belong to this exact native session.');
  return observed;
}

if (process.argv.includes('--help')) {
  console.log('Prepare --phase prepare [--workload churn]. Run --phase run --prepared <observer-fixture.json> --variant ipc-control|uia-control|uia-driver-collection|churn-control|churn-driver-collection --candidate <exe> --candidate-build-info <json>. Static queries or synthetic search/filter/document/tab navigation, no system input. The explicit collection variant collects the measuring driver only. This diagnostic does not replace native performance or memory-convergence acceptance.');
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
const reportPath = join(dataset.root, 'observer-result.json');
const report = {
  format, status: 'running', diagnosticOnly: true, convergenceClaim: false, variant: args.variant, startedAt: new Date().toISOString(),
  candidate: { executable, sha256: build.executableSha256, buildInfoPath, buildInfoSha256: await digest(buildInfoPath), sourceIdentity: build.sourceIdentity || build.sourceCommit },
  fixture: { root: dataset.root, dataFingerprint: dataset.dataFingerprint, skillCount: dataset.skillCount, toolCount: dataset.toolCount }, policy,
  systemKeyboardOrMouseInput: false, applicationGcRequested: false, samples: [], completedQueries: 0, completedCycles: 0,
  limitations: ['Read-only UIA queries and read-only IPC calls have different internal work; their cadence and call count are fixed, not their CPU cost.', 'Only the explicit collection variant requests collection in the measuring driver. Finalizer completion is asynchronous.', 'Process private bytes include allocator capacity and do not by themselves establish retained live objects or a leak.', 'No production data, external network, browser login, resource execution, installation, backup or cleanup.'],
};
const harnessPaths = ['verify-native-observer-memory.mjs', 'native-uia-client.mjs', 'verify-native-uia.ps1', 'performance-fixture.mjs'].map(name => fileURLToPath(new URL(name, import.meta.url)));
report.harness = await Promise.all(harnessPaths.map(async path => ({ path, sha256: await digest(path) })));
await writeFile(reportPath, json(report), { flag: 'wx' });
let app;
async function sample(phase) {
  const value = { phase, observedAt: new Date().toISOString(), application: await app.call('memory'), driver: await app.call('driverMemory') };
  report.samples.push(value); await writeFile(reportPath, json(report));
  console.log(JSON.stringify({ phase, applicationMiB: value.application.privateBytes / 1048576, driverMiB: value.driver.privateBytes / 1048576 }));
  return value;
}
try {
  app = await NativeUiaSession.launch({ executable, sha256: build.executableSha256, dataDir: dataset.dataDir, reportPath: join(dataset.root, 'native-driver.json'), accessibilityInput: true, driverMemoryDiagnostic: true });
  report.native = app.identity;
  await sleep(policy.settleMs);
  const initial = stored(dataset);
  assert.ok(initial.tasks.every(task => !['running', 'queued'].includes(task.status)), 'Initial native work must finish before the query-only diagnostic.');
  const baseline = await sample('before-queries');
  report.processRoles = await roles(baseline.application, app.identity.pid);
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
  report.normalExit = (await app.quit()).driverReport.closedNormally; app = null;
  report.status = 'diagnostic-measurements-collected';
} catch (error) { report.status = 'failed-or-blocked'; report.error = String(error); report.errorStack = error.stack; process.exitCode = 1; }
finally {
  if (app) try { report.normalExit = (await app.quit()).driverReport.closedNormally; } catch (error) { report.normalExitError = String(error); report.status = 'failed-or-blocked'; process.exitCode = 1; }
  report.harnessChangedDuringRun = (await Promise.all(report.harness.map(async file => await digest(file.path) !== file.sha256))).some(Boolean);
  if (report.harnessChangedDuringRun || await digest(executable) !== build.executableSha256) { report.status = 'failed-or-blocked'; report.integrityError = 'Native bytes or the fixed diagnostic harness changed.'; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString(); await writeFile(reportPath, json(report));
  console.log(JSON.stringify({ status: report.status, report: reportPath, normalExit: report.normalExit || false, error: report.error || null }));
}
