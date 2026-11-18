import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { NativeUiaSession } from './native-uia-client.mjs';
import { createPerformanceFixture, FIXTURE_FORMAT } from './performance-fixture.mjs';

const FORMAT = 'agent-resource-manager-native-task-retention-v1';
const ROOT = 'D:\\03_github_projects\\Agent_Management\\Agent_Resource_Manager\\validation\\manager-data';
const POLICY = Object.freeze({ warmupChecks: 10, measuredChecks: 120, batchChecks: 30, sampleEveryChecks: 5, idleSamples: 5, idleIntervalMs: 2000, taskDeadlineMs: 60000, expectedSchedulingKeys: 2002 });
const options = {};
const allowed = new Set(['phase', 'prepared', 'variant', 'candidate', 'candidate-build-info', 'existing-stdio-proof', 'transport-file-sha256', 'help']);
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  assert.ok(flag.startsWith('--') && allowed.has(flag.slice(2)), 'Unknown argument; use --help.');
  const key = flag.slice(2);
  assert.ok(!Object.hasOwn(options, key), `Duplicate --${key}.`);
  if (key === 'help') options[key] = true;
  else {
    const value = process.argv[++index];
    assert.ok(value && !value.startsWith('--'), `Missing --${key}.`);
    options[key] = value;
  }
}
if (options.help) {
  console.log('Prepare: --phase prepare. Run one fresh variant: --phase run --prepared <dataset.json> --variant baseline|candidate --candidate <exe> --candidate-build-info <json>. Optional existing transports: --existing-stdio-proof <reviewed-manifest.json> --transport-file-sha256 <formal-app-digest>. Candidate and formal transport digests are independent. Both variants use independent fresh 1000-Skill/100-tool fixtures. UIA Invoke triggers ten warmup checks and four batches of thirty without system keyboard or pointer input. Process memory and fixed aggregate cache/task-retention counters are sampled every five measured checks, with five two-second idle observations before and after. Database observations are read-only. Final MCP task_list is tested explicitly and an oversized response remains a failure. UIA and observer effects remain included; this short diagnostic does not establish GUI latency, P95, thirty-minute convergence or React heap size. No download, tool execution, forced GC or forced process stop.');
  process.exit(0);
}
assert.ok(['prepare', 'run'].includes(options.phase), 'Use --phase prepare or --phase run.');
const sleep = ms => new Promise(done => setTimeout(done, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = async path => hash(await readFile(path));
const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
const inside = (path, root) => { const part = relative(resolve(root), resolve(path)); return part === '' || !part.startsWith('..') && !isAbsolute(part); };
async function plain(path) {
  const info = await lstat(path);
  assert.ok(info.isDirectory() && !info.isSymbolicLink() && same(await realpath(path), path), 'Only a plain owned generated directory may be used.');
}
function database(fixture, read) {
  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try { return read(db); } finally { db.close(); }
}
function tasks(fixture) {
  return database(fixture, db => db.prepare("SELECT json_extract(payload,'$.id') AS id,json_extract(payload,'$.action') AS action,json_extract(payload,'$.status') AS status,LENGTH(CAST(payload AS BLOB)) AS bytes,json_array_length(payload,'$.resources') AS schedulingKeys FROM task_history").all());
}
function catalogue(fixture) {
  return database(fixture, db => db.prepare('SELECT id,payload FROM resource_catalog ORDER BY id').all());
}
async function runtimeDigests(fixture) {
  const state = database(fixture, db => JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload));
  assert.equal(state.skills.length, 1000);
  const hashes = [];
  for (const skill of state.skills) {
    assert.ok(inside(skill.localPath, fixture.skillsRoot));
    const path = join(skill.localPath, 'SKILL.md'), sha256 = await digest(path);
    assert.equal(sha256, skill.localHashes['SKILL.md']);
    hashes.push({ path, sha256 });
  }
  return hashes;
}
async function prepare() {
  await mkdir(ROOT, { recursive: true });
  const root = await mkdtemp(join(ROOT, 'native-task-retention-'));
  const descriptor = { format: FORMAT, syntheticOnly: true, root, policy: POLICY, variants: {} };
  for (const variant of ['baseline', 'candidate']) {
    const fixture = await createPerformanceFixture(root, variant, 100);
    descriptor.variants[variant] = { fixture, databaseSha256: await digest(fixture.dbPath) };
    await writeFile(join(root, `${variant}-result.json`), JSON.stringify({ format: FORMAT, status: 'prepared-not-run', variant }, null, 2) + '\n', { flag: 'wx' });
  }
  const path = join(root, 'dataset.json');
  await writeFile(path, JSON.stringify(descriptor, null, 2) + '\n', { flag: 'wx' });
  return path;
}
async function prepared(path, variant) {
  assert.ok(inside(path, ROOT));
  const value = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(value.format, FORMAT); assert.equal(value.syntheticOnly, true); assert.deepEqual(value.policy, POLICY);
  assert.ok(same(path, join(value.root, 'dataset.json')) && inside(value.root, ROOT));
  await plain(value.root);
  const selected = value.variants[variant]; assert.ok(selected);
  const fixture = selected.fixture;
  assert.equal(fixture.format, FIXTURE_FORMAT); assert.equal(fixture.skillCount, 1000); assert.equal(fixture.toolCount, 100);
  assert.ok(same(fixture.root, join(value.root, variant)) && same(fixture.dataDir, join(fixture.root, 'data')) && same(fixture.dbPath, join(fixture.dataDir, 'manager.sqlite3')));
  for (const path of [fixture.root, fixture.dataDir, fixture.skillsRoot, fixture.toolsRoot]) await plain(path);
  const marker = JSON.parse(await readFile(join(fixture.root, 'fixture-owner.json'), 'utf8'));
  assert.equal(marker.syntheticOnly, true); assert.equal(marker.format, FIXTURE_FORMAT);
  assert.equal(await digest(fixture.dbPath), selected.databaseSha256, 'Each comparison must start from its never-run generated database.');
  const reportPath = join(value.root, `${variant}-result.json`);
  assert.equal(JSON.parse(await readFile(reportPath, 'utf8')).status, 'prepared-not-run', 'An attempted variant cannot be replayed.');
  return { descriptor: value, fixture, reportPath };
}
async function provenance() {
  assert.equal(typeof options.candidate, 'string'); assert.equal(typeof options['candidate-build-info'], 'string');
  const path = resolve(options.candidate), buildInfoPath = resolve(options['candidate-build-info']);
  assert.equal(basename(path).toLowerCase(), 'agent-resource-manager.exe');
  const bytes = await readFile(path), offset = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.readUInt16LE(0), 0x5a4d); assert.equal(bytes.readUInt32LE(offset), 0x4550); assert.equal(bytes.readUInt16LE(offset + 4), 0x8664);
  const sha256 = hash(bytes), info = JSON.parse(await readFile(buildInfoPath, 'utf8'));
  assert.equal(info.buildMode, 'release'); assert.equal((info.executableSha256 || info.sha256)?.toLowerCase(), sha256); assert.ok(info.sourceIdentity || info.sourceCommit);
  return { path, sha256, buildInfoPath, buildInfoSha256: await digest(buildInfoPath), sourceIdentity: info.sourceIdentity || info.sourceCommit, version: info.version };
}
async function transportProvenance(candidateSha256) {
  const sha256 = (options['transport-file-sha256'] || candidateSha256).toLowerCase();
  assert.match(sha256, /^[a-f0-9]{64}$/);
  if (options['existing-stdio-proof'] === undefined) {
    assert.equal(options['transport-file-sha256'], undefined, 'A separate formal-file digest requires the explicit reviewed transport manifest.');
    return { sha256, pinnedTransports: undefined, observation: { onDiskFormalFileSha256: sha256, pinnedProcessCount: 0, loadedImageDigestClaim: false } };
  }
  const path = resolve(options['existing-stdio-proof']);
  assert.ok(same(await realpath(path), path), 'The reviewed stdio proof must not be redirected.');
  const bytes = await readFile(path), manifestSha256 = hash(bytes);
  assert.equal(manifestSha256, '32d632fd686121efdec22fe281eddc17711f76ecd18854791a6aec2b7434d685', 'Use the exact separately reviewed existing-stdio manifest.');
  const proof = JSON.parse(bytes.toString('utf8'));
  assert.equal(proof.format, 'arm-pinned-existing-stdio-v1');
  assert.equal(proof.candidateSha256, sha256, 'The historical manifest binds the formal transport file, not the new diagnostic candidate.');
  assert.equal(proof.noResourceInvokeDuringNativeTests, true);
  assert.equal(proof.loadedImageDigestClaim, false);
  assert.equal(proof.formalBackendAbsentAtObservation, true);
  assert.equal(proof.semanticArgvOnly, true);
  assert.ok(Array.isArray(proof.transports) && proof.transports.length === 12);
  return { sha256, pinnedTransports: proof.transports, observation: { onDiskFormalFileSha256: sha256, manifestPath: path, manifestSha256, pinnedProcessCount: proof.transports.length, loadedImageDigestClaim: false } };
}
function trend(samples) {
  if (samples.length < 2) return null;
  const xs = samples.map(row => row.elapsedMs / 60000), ys = samples.map(row => row.privateBytes);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const denominator = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  return { count: samples.length, durationMs: samples.at(-1).elapsedMs - samples[0].elapsedMs, growthBytes: ys.at(-1) - ys[0], rangeBytes: Math.max(...ys) - Math.min(...ys), slopeBytesPerMinute: denominator ? xs.reduce((sum, x, index) => sum + (x - mx) * (ys[index] - my), 0) / denominator : 0 };
}
if (options.phase === 'prepare') {
  console.log(JSON.stringify({ status: 'prepared-not-run', dataset: await prepare(), nativeLaunch: false, downloads: false }));
} else {
  assert.ok(['baseline', 'candidate'].includes(options.variant), 'Run requires --variant baseline or candidate.');
  const variant = options.variant, { descriptor, fixture, reportPath } = await prepared(resolve(options.prepared || ''), variant);
  const report = { format: FORMAT, status: 'running', variant, policy: POLICY, fixture, startedAt: new Date().toISOString(), checkTrigger: 'native-UIA-Invoke-without-system-keyboard-or-pointer', samples: [], checks: [], fullOutcomes: [], limitations: ['Short check-retention diagnostic only. No GUI latency, P95 or thirty-minute convergence claim.', 'UIA provider, backend observation and database polling effects are included; this is not an accessibility-free workload.', 'Native process memory covers manager and descendants, excluding the external Node and PowerShell driver.', 'MCP/SQLite observations expose backend metadata. React retained-list bytes require the separate focused frontend evidence.', 'No remote-content cache pressure, forced collection, tool launch, download or production data.'] };
  const persist = async () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  let app, runtimeBefore, toolsBefore;
  const start = performance.now();
  async function sample(phase, completedChecks) {
    const observation = await app.call('memory'), cache = await app.call('cache'), rows = tasks(fixture);
    for (const field of ['bytes', 'entries', 'inFlight', 'limitBytes']) assert.ok(Number.isSafeInteger(cache[field]) && cache[field] >= 0, `Invalid aggregate cache counter ${field}.`);
    if (variant === 'candidate') assert.equal(cache.taskRetention?.formatVersion, 1, 'The diagnostic candidate must expose the reviewed task-owned retention counters.');
    assert.ok(rows.every(row => !['queued', 'running'].includes(row.status)), 'A memory sample requires actual completed checks.');
    assert.ok(rows.length <= 100, 'Durable task history exceeded its existing bound.');
    const row = { phase, completedChecks, totalCompletedChecks: report.checks.length, elapsedMs: performance.now() - start, ...observation, cache, taskCount: rows.length, checkCount: rows.filter(row => row.action === 'check_now').length, metadataBytes: rows.reduce((sum, row) => sum + row.bytes, 0), schedulingKeys: rows.reduce((sum, row) => sum + (row.schedulingKeys || 0), 0) };
    report.samples.push(row); await persist(); return row;
  }
  async function idle(phase, completedChecks) {
    for (let index = 0; index < POLICY.idleSamples; index++) { await sleep(POLICY.idleIntervalMs); await sample(phase, completedChecks); }
  }
  async function check(sequence, phase) {
    const known = new Set(tasks(fixture).map(row => row.id));
    const startedAt = new Date().toISOString(), started = performance.now();
    await app.call('check');
    const deadline = performance.now() + POLICY.taskDeadlineMs;
    let found;
    for (;;) {
      const created = tasks(fixture).filter(row => !known.has(row.id));
      assert.ok(created.length <= 1, 'A single native confirmation created unexpected extra tasks.');
      if (created.length) {
        found = created[0]; assert.equal(found.action, 'check_now');
        if (!['queued', 'running'].includes(found.status)) break;
      }
      assert.ok(performance.now() < deadline, 'The one native check did not finish; it was not replayed.');
      await sleep(100);
    }
    assert.equal(found.status, 'succeeded', 'A check failed; memory timing cannot hide a functional failure.');
    assert.equal(found.schedulingKeys, POLICY.expectedSchedulingKeys, 'The generated checks must exercise the actual thousand-Skill scheduling metadata.');
    const row = { sequence, phase, id: found.id, startedAt, durationMs: performance.now() - started, schedulingKeys: found.schedulingKeys };
    report.checks.push(row);
    if (sequence === 1 || phase === 'measured' && (sequence - POLICY.warmupChecks) % POLICY.batchChecks === 0) {
      const task = (await app.call('task', { taskId: found.id })).task;
      assert.equal(task.id, found.id); assert.equal(task.status, 'succeeded'); assert.equal(task.resultAvailable, true);
      assert.equal(task.result.skills.length, 1000); assert.equal(task.resources.length, found.schedulingKeys);
      report.fullOutcomes.push({ id: found.id, skills: task.result.skills.length, schedulingKeys: task.resources.length, fullResponseBytes: Buffer.byteLength(JSON.stringify(task)), originalOutcomeRead: true });
    }
    if (sequence % POLICY.sampleEveryChecks === 0) await persist();
  }
  try {
    report.candidate = await provenance();
    const transport = await transportProvenance(report.candidate.sha256);
    report.transportIdentity = transport.observation;
    report.harness = await Promise.all(['verify-native-task-retention.mjs', 'native-uia-client.mjs', 'verify-native-uia.ps1', 'performance-fixture.mjs'].map(async name => ({ name, sha256: await digest(fileURLToPath(new URL(name, import.meta.url))) })));
    runtimeBefore = await runtimeDigests(fixture); toolsBefore = catalogue(fixture); assert.equal(toolsBefore.length, 100);
    await persist();
    app = await NativeUiaSession.launch({ executable: report.candidate.path, sha256: report.candidate.sha256, transportSha256: transport.sha256, pinnedTransports: transport.pinnedTransports, dataDir: fixture.dataDir, reportPath: join(descriptor.root, `${variant}-native-driver.json`), accessibilityInput: true });
    assert.equal(app.identity.executableSha256, report.candidate.sha256); assert.ok(same(app.identity.dataDirectory, fixture.dataDir)); report.native = app.identity;
    const initial = await app.call('tasks'); report.initialTaskList = { count: initial.tasks.length, bytes: Buffer.byteLength(JSON.stringify(initial)) };
    await idle('no-check-control', 0);
    for (let index = 1; index <= POLICY.warmupChecks; index++) await check(index, 'warmup');
    await sample('warmup-ended', POLICY.warmupChecks);
    for (let index = 1; index <= POLICY.measuredChecks; index++) {
      await check(POLICY.warmupChecks + index, 'measured');
      if (index % POLICY.sampleEveryChecks === 0) await sample('measured', index);
      if (index % POLICY.batchChecks === 0) console.log(JSON.stringify({ phase: 'native-retention-batch', variant, completedChecks: index, reportPath }));
    }
    await idle('final-idle', POLICY.measuredChecks);
    const rows = tasks(fixture); assert.equal(rows.length, 100); assert.equal(rows.filter(row => row.action === 'check_now').length, 100);
    assert.equal(report.checks.length, POLICY.warmupChecks + POLICY.measuredChecks);
    assert.equal(report.fullOutcomes.length, 5);
    report.trends = Object.fromEntries(['no-check-control', 'measured', 'final-idle'].map(phase => [phase, trend(report.samples.filter(row => row.phase === phase))]));
    report.convergenceClaim = false; report.status = 'diagnostic-measurements-collected'; await persist();
    report.finalTaskList = { status: 'pending', expectedCount: 100 }; await persist();
    const final = await app.call('tasks');
    assert.equal(final.tasks.length, 100); assert.ok(final.tasks.every(row => row.action === 'check_now' && row.status === 'succeeded'));
    if (variant === 'candidate') {
      assert.ok(final.tasks.every(row => !Object.hasOwn(row, 'resources') && !Object.hasOwn(row, 'result')), 'Candidate task summaries must omit scheduling keys and full results; single-task outcomes remain complete.');
    } else {
      assert.ok(final.tasks.every(row => Array.isArray(row.resources) && row.resources.length === POLICY.expectedSchedulingKeys), 'The baseline retains its original full scheduling metadata contract.');
    }
    report.finalTaskList = { status: 'observed', count: final.tasks.length, bytes: Buffer.byteLength(JSON.stringify(final)), contract: variant === 'candidate' ? 'task-summary' : 'legacy-metadata', ...(variant === 'candidate' ? { schedulingKeysOmitted: true, resultsOmitted: true } : { rawSchedulingKeys: final.tasks.reduce((sum, row) => sum + row.resources.length, 0) }) };
  } catch (error) {
    report.status = 'failed-or-blocked'; report.failure = { message: String(error.message).slice(0, 1800), completedChecks: report.checks.length, finalTaskListPending: report.finalTaskList?.status === 'pending' };
  } finally {
    if (app) { try { report.normalExit = (await app.quit()).driverReport.closedNormally; } catch (error) { report.normalExit = false; report.exitError = String(error.message).slice(0, 600); } }
    if (runtimeBefore) { try { assert.deepEqual(await runtimeDigests(fixture), runtimeBefore); assert.deepEqual(catalogue(fixture), toolsBefore); report.runtimeAndToolsUnchanged = true; } catch (error) { report.runtimeAndToolsUnchanged = false; report.status = 'failed-or-blocked'; report.integrityError = String(error.message).slice(0, 600); } }
    report.finishedAt = new Date().toISOString(); await persist();
  }
  console.log(JSON.stringify({ status: report.status, variant, reportPath, completedChecks: report.checks.length, normalExit: report.normalExit, convergenceClaim: false }));
  if (report.status !== 'diagnostic-measurements-collected' || !report.normalExit || !report.runtimeAndToolsUnchanged) process.exitCode = 1;
}
