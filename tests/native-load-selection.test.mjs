import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERFORMANCE_POLICY as policy, backgroundLoadVerdict, localInteractionVerdict } from '../scripts/performance-policy.mjs';

const source = readFileSync(new URL('../scripts/verify-uia-performance.mjs', import.meta.url), 'utf8');
const validation = source.slice(source.indexOf('function validateLoadSelection('), source.indexOf('\nif (options.help)'));
const select = new Function(`${validation}; return validateLoadSelection;`)();
const selectInteraction = new Function(`${validation}; return validateInteractionSelection;`)();
const transportDigest = new Function(`${validation}; return transportDigest;`)();
const selectSampling = new Function(`${validation}; return validateOverlapSampling;`)();
const workloads = source.slice(source.indexOf('async function loadInteractions('), source.indexOf('\nasync function cycle('));
const makeWorkloads = new Function('dependencies', `
  const { loadKind, options, report, check, waitTasks, resolve, readFile, digest,
    beginUiaNativeDownload, beginUiaNativeStage, backgroundLoadVerdict,
    inputCondition, loadSample, interaction, emit } = dependencies;
  ${workloads}
  return backgroundLoads;
`);
const statusStart = source.indexOf('    const gates = ');
const statusEnd = source.indexOf('\n  }\n} catch (error)', statusStart);
assert.ok(statusStart >= 0 && statusEnd > statusStart);
const finalize = new Function('report', 'suite', 'loadKind', 'options', 'passedLoadsStatus', 'interactionKind', 'passedInteractionStatus',
  source.slice(statusStart, statusEnd) + '\nreturn report.status;');
const samplingSource = source.slice(source.indexOf('async function sampledLoads('), source.indexOf('\nasync function cycle('));
const sampleSource = source.slice(source.indexOf('async function loadSample('), source.indexOf('\nasync function loadInteractions('));
const sampledLoadActions = { check: 'check_now', download: 'apply_resource_download', update: 'apply_resource_update_stage' };
const makeSampledLoads = new Function('dependencies', `
  const { policy, report, backgroundLoadVerdict, ownedForeground, interaction,
    waitNativeTask, inputCondition, emit, sleep, Date, performance, sampledLoadActions } = dependencies;
  ${sampleSource}
  ${samplingSource}
  return sampledLoads;
`);
const sampledSetupSource = source.slice(source.indexOf('function exactOfficialDownload('), source.indexOf('\nasync function downloadRestartContinue('));
const pinnedConstants = source.slice(source.indexOf('const officialDownload = '), source.indexOf('await mkdir(approved'));
const makeSampledSetup = new Function('dependencies', `
  const { lstat, realpath, mkdtemp, join, resolve, basename, approvedResourceParent, report, emit, digest,
    beginUiaNativeDownload, sampledLoadActions, readNativeLoadFixture, attachNativeLoadResources, beginUiaNativeStage } = dependencies;
  ${pinnedConstants}
  ${sampledSetupSource}
  return { officialDownload, officialDownloadSha256, exactOfficialDownload, sampledDownload, prepareSampledStages, sampledStage };
`);
const interactionSource = source.slice(source.indexOf('async function interactionRun('), source.indexOf('\nasync function loadSample('));
const makeInteractionRun = new Function('dependencies', `
  const { interactionKind, check, interaction, recordBackground } = dependencies;
  ${interactionSource}
  return interactionRun;
`);

test('transport-file identity is explicit and independent of the measured candidate', () => {
  const candidate = '6'.repeat(64), transport = 'f'.repeat(64);
  assert.equal(transportDigest(undefined, candidate), candidate);
  assert.equal(transportDigest(transport.toUpperCase(), candidate), transport);
  for (const invalid of [true, null, '', 'f'.repeat(63), 'f'.repeat(65), 'z'.repeat(64)]) {
    assert.throws(() => transportDigest(invalid, candidate), /exact SHA256 digest/);
  }
  assert.match(source, /assertNoUserManager\(\{ transportSha256,/);
  assert.match(source, /NativeUiaSession\.launch\(\{ executable: info\.path, sha256: info\.sha256, transportSha256,/);
  assert.match(source, /manifest\.candidateSha256 !== report\.transportFileSha256/);
  assert.match(source, /app\.identity\.executableSha256 !== info\.sha256/);
});

function harness(loadKind, durationMs = 120) {
  const report = {}, calls = { check: 0, download: 0, update: 0, specificationReads: 0, waitTasks: 0, finished: [], overlap: [] };
  const app = { identity: { pid: 42 }, fixture: {}, call: async () => ({}) };
  const actions = { check: 'check_now', download: 'apply_resource_download', update: 'apply_resource_update_stage' };
  const begin = async kind => {
    calls[kind]++;
    return { kind, taskId: `${kind}-task`, finish: async () => { calls.finished.push(kind); return { complete: true }; } };
  };
  const run = makeWorkloads({
    loadKind, options: { 'download-spec': 'explicit-download.json', 'stage-fixture': 'explicit-stage.json' }, report,
    check: async () => { calls.check++; return { taskIds: ['check-task'] }; },
    waitTasks: async () => { calls.waitTasks++; }, resolve: value => value,
    readFile: async () => { calls.specificationReads++; return '{}'; }, digest: async () => 'fixed-spec-sha',
    beginUiaNativeDownload: async () => begin('download'), beginUiaNativeStage: async () => begin('update'),
    backgroundLoadVerdict, inputCondition: 'native-ui-input-to-painted-result',
    loadSample: async (_app, load, op, fields) => {
      calls.overlap.push({ kind: load.kind, op, fields });
      (report.loadCoverage ||= []).push({ kind: load.kind, taskId: load.taskId, taskAction: actions[load.kind],
        beforeStatus: 'running', afterStatus: 'running', beforeObservedAtMs: 100, afterObservedAtMs: 300,
        sample: { category: op === 'openDocument' ? 'document' : op, pid: 42, condition: 'native-ui-input-to-painted-result',
          durationMs, startedAtUtcMs: 150, finishedAtUtcMs: 270 } });
    }, interaction: async () => ({}), emit: async () => {},
  });
  return { report, calls, run: () => run(app) };
}
const expectedInputs = [
  { op: 'search', fields: { index: 17 } },
  { op: 'filter', fields: { github: true } },
  { op: 'filter', fields: { github: false } },
  { op: 'openDocument', fields: { index: 0 } },
  { op: 'tab', fields: { home: true } },
  { op: 'tab', fields: { home: false } },
];

test('single-workload selection is explicit and complete loads retains both required specifications', () => {
  assert.equal(select({ 'download-spec': 'download', 'stage-fixture': 'stage' }, 'loads'), undefined);
  for (const options of [{}, { 'download-spec': 'download' }, { 'stage-fixture': 'stage' }]) {
    assert.throws(() => select(options, 'loads'), /requires both/);
  }
  assert.equal(select({ 'load-kind': 'update', 'stage-fixture': 'stage' }, 'loads'), 'update');
  assert.equal(select({ 'load-kind': 'download', 'download-spec': 'download' }, 'loads'), 'download');
  assert.equal(select({ 'load-kind': 'check' }, 'loads'), 'check');
  for (const kind of [true, false, '', 'all', 'stage', 'unknown']) {
    assert.throws(() => select({ 'load-kind': kind }, 'loads'), /exactly check, download or update/);
  }
  for (const suite of ['prepare', 'probe', 'interactive', 'startup', 'stability', 'all']) {
    assert.throws(() => select({ 'load-kind': 'update', 'stage-fixture': 'stage' }, suite), /requires --suite loads/);
  }
  assert.throws(() => select({ 'load-kind': 'update' }, 'loads'), /requires --stage-fixture/);
  assert.throws(() => select({ 'load-kind': 'download' }, 'loads'), /requires --download-spec/);
});

test('update continuation uses the original six inputs and never reads or starts the supplied download', async () => {
  const value = harness('update');
  await value.run();
  assert.equal(value.calls.update, 1);
  assert.equal(value.calls.download, 0);
  assert.equal(value.calls.check, 0);
  assert.equal(value.calls.specificationReads, 0);
  assert.deepEqual(value.calls.finished, ['update']);
  assert.deepEqual(value.calls.overlap.map(({ op, fields }) => ({ op, fields })), expectedInputs);
  assert.equal(value.report.loadVerdict.update.status, 'passed');
  assert.equal(value.report.loadVerdict.download.status, 'incomplete');
  assert.equal(value.report.loadVerdict.check.status, 'incomplete');
});

test('the default complete workload order and all eighteen original overlap inputs remain unchanged', async () => {
  const value = harness(undefined);
  await value.run();
  assert.equal(value.calls.check, 1);
  assert.equal(value.calls.download, 1);
  assert.equal(value.calls.update, 1);
  assert.equal(value.calls.specificationReads, 1);
  assert.equal(value.calls.waitTasks, 1);
  assert.deepEqual(value.calls.finished, ['download', 'update']);
  for (const [index, kind] of ['check', 'download', 'update'].entries()) {
    const samples = value.calls.overlap.slice(index * 6, index * 6 + 6);
    assert.equal(samples.length, 6);
    assert.ok(samples.every(sample => sample.kind === kind));
    assert.deepEqual(samples.map(({ op, fields }) => ({ op, fields })), expectedInputs);
    assert.equal(value.report.loadVerdict[kind].status, 'passed');
  }
});

test('other explicit selections retain their original workload and the original overlap limit still rejects slow input', async () => {
  for (const kind of ['check', 'download']) {
    const value = harness(kind);
    await value.run();
    assert.equal(value.calls.overlap.length, 6);
    assert.ok(value.calls.overlap.every(sample => sample.kind === kind));
    assert.equal(value.report.loadVerdict[kind].status, 'passed');
    assert.equal(value.calls.update, 0);
  }
  const slow = harness('update', 201);
  await slow.run();
  assert.equal(slow.report.loadVerdict.update.status, 'failed');
  assert.equal(slow.report.loadVerdict.update.overLimitInputs, 6);
});

test('single-kind success is explicitly partial-limited and cannot be reported as a complete loads pass', async () => {
  const partialStatus = 'passed-partial-limited-background-loads-only';
  const value = harness('update');
  await value.run();
  assert.equal(finalize({ startup: {}, ...value.report }, 'loads', 'update', {}, partialStatus), partialStatus);
  const full = { check: { status: 'passed' }, download: { status: 'passed' }, update: { status: 'passed' } };
  assert.equal(finalize({ startup: {}, loadVerdict: full }, 'loads', undefined, {}, 'passed-background-loads-only'), 'passed-background-loads-only');
  assert.equal(finalize({ startup: {}, loadVerdict: full }, 'loads', 'update', {}, partialStatus), partialStatus);
  assert.equal(finalize({ startup: {}, loadVerdict: { update: { status: 'incomplete' } } }, 'loads', 'update', {}, partialStatus), 'incomplete');
  assert.equal(finalize({ startup: {}, loadVerdict: { update: { status: 'failed' } } }, 'loads', 'update', {}, partialStatus), 'failed');
  assert.equal(finalize({ startup: {}, ...value.report }, 'loads', 'update', { 'concurrent-observation': true }, partialStatus), 'diagnostic-only-concurrent-observation');
});

test('complete suite cannot pass on small background smoke samples alone', () => {
  const passed = { status: 'passed' };
  const base = { startup: { verdict: { cold: passed, warm: passed } }, stability: { verdict: passed },
    interactionVerdict: { search: passed, filter: passed, tab: passed, document: passed } };
  const loads = Object.fromEntries(['check', 'download', 'update'].map(kind => [kind, { status: 'passed' }]));
  const status = (loadVerdict, suite = 'all') => finalize({ ...base, loadVerdict }, suite, undefined, {}, 'passed-background-loads-only');
  assert.equal(status(loads), 'measured-gates-passed-load-samples-incomplete');
  assert.equal(status(loads, 'loads'), 'passed-background-loads-only');
  assert.equal(status({ ...loads, update: { status: 'incomplete' } }), 'measured-gates-passed-load-coverage-incomplete');
  const complete = Object.fromEntries(Object.keys(loads).map(kind => [kind, { ...loads[kind], sampledOverlap: passed }]));
  assert.equal(status(complete), 'passed');
  for (const statusName of ['failed', 'invalid']) {
    assert.equal(status({ ...complete, download: { ...loads.download, sampledOverlap: { status: statusName } } }), 'failed');
  }
  assert.equal(status({ ...complete, download: { ...complete.download, status: 'failed' } }), 'failed');
});

test('sampled overlap admits one explicit synchronous workload and only its own required specification', () => {
  const sample = { 'sample-overlap': 'true' };
  const download = { ...sample, 'download-spec': 'download.json' };
  const update = { ...sample, 'stage-fixture': 'last.json' };
  const choose = (options, suite, kind, stages = [], downloads = 0) => selectSampling(options, suite, kind, stages, downloads);
  assert.equal(choose({}, 'loads', 'check'), false);
  assert.equal(choose(sample, 'loads', 'check'), true);
  assert.equal(choose(download, 'loads', 'download', [], 1), true);
  assert.equal(choose(update, 'loads', 'update', ['first.json', 'last.json']), true);
  for (const value of [true, false, 'false', '']) {
    assert.throws(() => choose({ 'sample-overlap': value }, 'loads', 'check'), /sample-overlap true/);
  }
  assert.throws(() => choose(sample, 'loads', undefined), /one explicit --load-kind/);
  assert.throws(() => choose(sample, 'all', 'check'), /requires --suite loads/);
  assert.throws(() => choose({ ...sample, 'concurrent-observation': true }, 'loads', 'check'), /synchronous observation/);
  for (const [kind, arg] of [['check', 'download-spec'], ['check', 'stage-fixture'], ['update', 'download-spec'], ['download', 'stage-fixture']]) {
    assert.throws(() => choose({ ...sample, [arg]: 'chosen' }, 'loads', kind), /only the selected workload specification/);
  }
  for (const count of [0, 2]) assert.throws(() => choose(download, 'loads', 'download', [], count), /one explicit pinned/);
  assert.throws(() => choose({ ...download, 'download-spec': true }, 'loads', 'download', [], 1), /one explicit pinned/);
  for (const paths of [[], ['last.json'], ['first.json', true], Array(13).fill('other.json')]) {
    assert.throws(() => choose(update, 'loads', 'update', paths), /two to twelve separate/);
  }
  assert.throws(() => choose({}, 'loads', 'update', ['first.json', 'last.json']), /limited to sampled update/);
  const script = fileURLToPath(new URL('../scripts/verify-uia-performance.mjs', import.meta.url));
  for (const [args, error] of [
    [['--load-kind', 'check', '--sample-overlap'], /sample-overlap true/],
    [['--load-kind', 'download', '--sample-overlap', 'true', '--download-spec', 'one.json', '--download-spec', 'two.json'], /one explicit pinned/],
    [['--load-kind', 'update', '--sample-overlap', 'true', '--stage-fixture', 'one.json', '--stage-fixture'], /two to twelve separate/],
    [['--load-kind', 'update', '--stage-fixture', 'one.json', '--stage-fixture', 'two.json'], /limited to sampled update/],
  ]) {
    const invalid = spawnSync(process.execPath, [script, '--suite', 'loads', ...args], { windowsHide: true, timeout: 10000, encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, '');
    assert.match(invalid.stderr, error);
  }
});

function sampledHarness({ kind = 'check', retireDuringInput = false, noRunningWindow = false, wrongReceipt = false, replayTask = false,
  measuresPerTask = kind === 'download' ? 400 : kind === 'update' ? 50 : 5 } = {}) {
  let now = 10000, active, sequential = 0, search = '', filtered = false, document = null, home = true, measurements = 0;
  const report = { loadSelection: { scope: `sampled-${kind}-only` } };
  const identity = { pid: 123, windowHandle: 456, creationFileTime: '789' };
  const inputCondition = 'native-ui-input-to-painted-result';
  const event = (op, fields) => {
    if (op === 'search') {
      assert.equal(home, true); assert.equal(filtered, false); assert.notEqual(search, fields.index);
      search = fields.index;
    } else if (op === 'clear') { assert.equal(home, true); assert.notEqual(search, ''); search = ''; }
    else if (op === 'filter') { assert.equal(home, true); assert.equal(search, ''); assert.notEqual(filtered, fields.github); filtered = fields.github; }
    else if (op === 'openDocument') { assert.equal(home, true); assert.equal(search, fields.index); assert.equal(document, null); document = fields.index; home = false; }
    else if (op === 'closeDocument') { assert.equal(document, fields.index); document = null; home = true; }
    else if (op === 'tab') { assert.equal(document, 0); assert.notEqual(home, fields.home); home = fields.home; }
    else assert.fail(op);
  };
  const completed = [], taskStarts = [];
  const finish = () => { active.status = 'succeeded'; active.finishedAt = new globalThis.Date(now).toISOString(); };
  const complete = id => {
    assert.equal(active.id, id);
    now += 4;
    if (active.status !== 'succeeded') { active.startedAt ||= new globalThis.Date(now).toISOString(); finish(); }
    completed.push(active);
    return active;
  };
  const app = { identity, call: async (op, fields) => {
    now += 4;
    if (op === 'task') {
      assert.equal(fields.taskId, active.id);
      if (active.status === 'queued' && !noRunningWindow) { active.status = 'running'; active.startedAt = new globalThis.Date(now).toISOString(); }
      return { task: { ...active } };
    }
    if (op === 'windowIdentity') return { capturedHandle: identity.windowHandle, currentMainHandle: identity.windowHandle, uiaProcessId: identity.pid, foregroundHandle: identity.windowHandle };
    event(op, fields);
  } };
  const run = makeSampledLoads({
    policy, report, inputCondition, Date: { now: () => now }, performance: { now: () => now - 10000 },
    backgroundLoadVerdict, sampledLoadActions,
    ownedForeground: (value, expected) => value.foregroundHandle === expected.windowHandle && value.uiaProcessId === expected.pid,
    interaction: async (_app, op, fields, measured, deadline) => {
      assert.equal(active.status, 'running');
      assert.equal(measured, true);
      now += 4; // The final owned-window observation precedes its deadline check.
      if (now - 10000 >= deadline) return null;
      event(op, fields);
      const start = now += 4;
      if (retireDuringInput) finish();
      now += 120;
      if (++active.measured === measuresPerTask && !retireDuringInput) finish();
      measurements++;
      return { ...identity, condition: inputCondition, foregroundBefore: true, foregroundAfter: true,
        category: op === 'openDocument' ? 'document' : op, durationMs: 120, startedAtUtcMs: start, finishedAtUtcMs: now };
    },
    waitNativeTask: async (_app, id) => complete(id),
    emit: async () => {}, sleep: async ms => { now += ms; },
  });
  const startTask = async index => {
    assert.equal(completed.length, index, 'Finish and verify the exact prior task before starting the next');
    assert.ok(!active || completed.at(-1) === active);
    sequential++;
    const taskId = `${kind}-${replayTask ? 1 : sequential}`;
    const resourceId = kind === 'update' ? `perf-tool-${String(index).padStart(3, '0')}` : undefined;
    active = { id: taskId, action: sampledLoadActions[kind], status: 'queued', measured: 0, resourceId };
    taskStarts.push({ index, taskId, resourceId });
    return { kind, taskId, resourceId, ...(kind !== 'check' && { finish: async () => {
      complete(taskId);
      return wrongReceipt ? undefined : { taskId, complete: true };
    } }) };
  };
  return { report, completed, taskStarts, measures: () => measurements, run: (limits, maximumTasks = kind === 'download' ? 1 : kind === 'update' ? 12 : 96) =>
    run(app, kind, startTask, maximumTasks, { maximumAttempts: 560, maximumMeasurementMs: 720000, maximumQueuedObservationMs: 8, longTaskCategoryBurst: 5, ...limits }) };
}

test('sampled checks collect four balanced sets from real transitions and serialize successful task completion', async () => {
  const value = sampledHarness();
  await value.run();
  assert.equal(value.report.sampledLoad.stopReason, 'sample-count');
  assert.equal(value.measures(), 400);
  assert.equal(value.completed.length, 80);
  assert.deepEqual(Object.values(value.report.loadVerdict.check.sampledOverlap.categories).map(category => category.count), [100, 100, 100, 100]);
  assert.equal(finalize({ startup: {}, ...value.report }, 'loads', 'check', {}, 'passed-sampled-native-check-only'), 'passed-sampled-native-check-only');
});

test('sampled checks skip tasks without a running observation and preserve rejected early completions', async () => {
  const queued = sampledHarness({ noRunningWindow: true });
  await queued.run({}, 2);
  assert.equal(queued.measures(), 0);
  assert.equal(queued.completed.length, 2);
  assert.equal(queued.report.sampledLoad.stopReason, 'task-budget');
  const retired = sampledHarness({ retireDuringInput: true });
  await retired.run({ maximumAttempts: 2 });
  assert.equal(retired.measures(), 2);
  assert.equal(retired.report.sampledLoad.stopReason, 'attempt-budget');
  assert.equal(retired.report.loadVerdict.check.sampledOverlap.acceptedInputs, 0);
  assert.equal(retired.report.loadVerdict.check.sampledOverlap.rejected['not-contained-in-running-task'], 2);
  const timed = sampledHarness();
  await timed.run({ maximumMeasurementMs: 15 });
  assert.equal(timed.measures(), 0, 'No new sample enters after the deadline, including finalization');
  assert.equal(timed.completed.length, 1, 'The active task is still verified before closing');
  assert.equal(timed.report.sampledLoad.stopReason, 'time-budget');
  for (const value of [queued, retired, timed]) {
    assert.equal(finalize({ startup: {}, ...value.report }, 'loads', 'check', {}, 'passed-sampled-native-check-only'), 'native-check-overlap-samples-incomplete');
  }
});

test('sampled download and update rotate four real transitions and verify distinct native workloads serially', async () => {
  for (const [kind, taskCount] of [['download', 1], ['update', 8]]) {
    const value = sampledHarness({ kind });
    await value.run();
    assert.equal(value.report.sampledLoad.stopReason, 'sample-count');
    assert.equal(value.measures(), 400);
    assert.equal(value.completed.length, taskCount);
    assert.equal(new Set(value.completed.map(task => task.id)).size, taskCount);
    if (kind === 'update') assert.equal(new Set(value.completed.map(task => task.resourceId)).size, taskCount);
    assert.deepEqual(Object.values(value.report.loadVerdict[kind].sampledOverlap.categories).map(category => category.count), [100, 100, 100, 100]);
    assert.ok(value.report.loadCoverage.every(record => record.kind === kind));
    const status = `passed-sampled-native-${kind}-only`;
    assert.equal(finalize({ startup: {}, ...value.report }, 'loads', kind, {}, status), status);
  }
});

test('sampled workloads stop without replay when a real task is short, previously seen or unverified', async () => {
  const short = sampledHarness({ kind: 'download', measuresPerTask: 2 });
  await short.run();
  assert.equal(short.report.sampledLoad.stopReason, 'task-budget');
  assert.equal(short.taskStarts.length, 1);
  assert.equal(finalize({ startup: {}, ...short.report }, 'loads', 'download', {}, 'passed-sampled-native-download-only'), 'native-download-overlap-samples-incomplete');
  const replay = sampledHarness({ kind: 'update', replayTask: true, measuresPerTask: 2 });
  await assert.rejects(replay.run(), /distinct expected native task/);
  assert.equal(replay.completed.length, 1);
  assert.equal(replay.measures(), 2);
  const unverified = sampledHarness({ kind: 'update', wrongReceipt: true, measuresPerTask: 2 });
  await assert.rejects(unverified.run(), /verify the exact native task completion/);
  assert.equal(unverified.taskStarts.length, 1);
});

test('sampled download uses the pinned official asset once and checks the actual file and task duration', async () => {
  const approvedResourceParent = resolve('resources');
  const directory = join(approvedResourceParent, 'native-download-sampled-owned');
  const report = {}, dataset = { dataDir: 'generated-data' };
  const startedAt = '2026-11-18T00:00:00.000Z';
  const task = { id: 'expected-task', action: sampledLoadActions.download, status: 'succeeded', startedAt, finishedAt: '2026-11-18T00:11:02.000Z' };
  const source = { path: 'pinned-official.json', sha256: 'specification-file-hash' };
  let archives = 0, taskOp, actualHash, savedSpec;
  const app = { fixture: dataset, call: async (op, fields) => { taskOp = { op, fields }; return { task }; } };
  const setup = makeSampledSetup({ join, resolve, approvedResourceParent, sampledLoadActions, report, emit: async () => {},
    lstat: async path => path === approvedResourceParent ? { isDirectory: () => true, isSymbolicLink: () => false }
      : { isFile: () => true, isSymbolicLink: () => false, size: 676536 },
    realpath: async path => path,
    mkdtemp: async prefix => { assert.equal(prefix, join(approvedResourceParent, 'native-download-sampled-')); return directory; },
    digest: async () => actualHash,
    beginUiaNativeDownload: async (target, data, specification) => {
      archives++;
      assert.equal(app, target);
      assert.equal(dataset, data);
      savedSpec = specification;
      const targetPath = join(directory, 'fixed-download-agent-reach.zip');
      const receipt = { taskId: task.id, complete: true, archivePath: targetPath, downloadId: 'fixed-download' };
      return { ...receipt, targetPath, bytesPerSecond: specification.bytesPerSecond, expectedBytes: specification.assetBytes, finish: async () => receipt };
    },
  });
  const pinned = { repository: 'Panniantong/Agent-Reach', tag: 'v1.6.0', releaseId: 421526768, assetId: 668240314, assetName: 'agent-reach.zip', assetBytes: 676536 };
  assert.deepEqual(setup.officialDownload, pinned);
  assert.ok(setup.exactOfficialDownload({ ...pinned, directory: 'old-unused', bytesPerSecond: 16384 }));
  assert.ok(!setup.exactOfficialDownload({ ...pinned, assetId: 0 }));
  actualHash = setup.officialDownloadSha256;
  const load = await setup.sampledDownload(app, source);
  assert.deepEqual(savedSpec, { ...pinned, directory, bytesPerSecond: 1024 });
  assert.equal(report.downloadSpecification.sha256, source.sha256);
  const result = await load.finish();
  assert.equal(result.sha256, actualHash);
  assert.equal(result.minimumDurationMs, pinned.assetBytes / 1024 * 1000);
  assert.deepEqual(taskOp, { op: 'task', fields: { taskId: task.id } });
  task.finishedAt = '2026-11-18T00:00:41.000Z';
  await assert.rejects(load.finish(), /selected rate and asset size/);
  actualHash = 'changed-asset';
  await assert.rejects(load.finish(), /pinned ordinary asset bytes/);
  assert.equal(archives, 1);
});

test('sampled stage binds ordered canonical fixture manifests and refuses changes before invoking the native stage', async () => {
  const paths = ['first', 'second'].map(directory => resolve(directory, 'load-fixture.json'));
  const knownHashes = new Map(paths.map((path, index) => [path, `manifest-${index}`]));
  const dataset = { dataDir: 'generated-data' }, app = {}, starts = [];
  let attachments = 0, mutateDuringRead;
  const setup = makeSampledSetup({ resolve, basename, digest: async path => knownHashes.get(path),
    readNativeLoadFixture: async path => {
      if (mutateDuringRead === path) knownHashes.set(path, 'changed-during-read');
      return { manifestPath: path };
    },
    attachNativeLoadResources: async (data, fixtures) => {
      attachments++;
      assert.equal(data, dataset);
      return fixtures.map(({ manifestPath }, index) => ({ fixturePath: manifestPath, resourceId: `resource-${index}` }));
    },
    beginUiaNativeStage: async (target, data, path, seed) => {
      assert.equal(target, app);
      assert.equal(data, dataset);
      assert.equal(path, seed.fixturePath);
      starts.push(seed);
      return seed.resourceId;
    },
  });
  await assert.rejects(setup.prepareSampledStages(dataset, [paths[0], paths[0]]), /canonical load-fixture.json paths without repetition/);
  await assert.rejects(setup.prepareSampledStages(dataset, [paths[0], resolve('second', 'copy.json')]), /canonical load-fixture.json paths without repetition/);
  mutateDuringRead = paths[1];
  await assert.rejects(setup.prepareSampledStages(dataset, paths), /changed during preparation/);
  assert.equal(attachments, 0);
  mutateDuringRead = undefined;
  knownHashes.set(paths[1], 'manifest-1');
  const seeds = await setup.prepareSampledStages(dataset, paths);
  assert.deepEqual(seeds.map(seed => seed.manifestSha256), ['manifest-0', 'manifest-1']);
  assert.equal(await setup.sampledStage(app, dataset, seeds[0]), 'resource-0');
  knownHashes.set(paths[1], 'later-change');
  await assert.rejects(setup.sampledStage(app, dataset, seeds[1]), /changed since its binding/);
  assert.deepEqual(starts, [seeds[0]]);
});

test('partial selection preserves normal shutdown, fixed-harness checks and explicit result scope', () => {
  assert.match(source, /finally \{ await close\(app\); \}/);
  assert.match(source, /if \(report\.harnessChangedDuringRun\) \{ report\.status = 'failed'/);
  assert.match(source, /report\.status !== passedLoadsStatus/);
  assert.match(source, /scope: 'partial-limited'.*requiredOverlapInputs: 6, fullLoadsAcceptanceClaimed: false/);
  assert.match(source, /loadSelection: report\.loadSelection/);
  assert.match(source, /if \(\(!loadKind \|\| loadKind === 'update'\) && options\['stage-fixture'\]\)/);
});

test('document selection is explicit, interactive-only and rejects loads before fixture creation', () => {
  assert.equal(selectInteraction({}, 'interactive'), undefined);
  assert.equal(selectInteraction({ 'interaction-kind': 'document' }, 'interactive'), 'document');
  for (const kind of [true, false, '', 'all', 'search', 'filter', 'tab', 'unknown']) {
    assert.throws(() => selectInteraction({ 'interaction-kind': kind }, 'interactive'), /exactly document/);
  }
  const script = fileURLToPath(new URL('../scripts/verify-uia-performance.mjs', import.meta.url));
  const invalidSelections = [
    ...['prepare', 'probe', 'startup', 'loads', 'stability', 'all', 'download-resume'].map(suite => ['--suite', suite, '--interaction-kind', 'document']),
    ['--interaction-kind', 'document'],
    ...['load-kind', 'download-spec', 'stage-fixture'].map(name => ['--suite', 'interactive', '--interaction-kind', 'document', `--${name}`, 'fixture-only']),
  ];
  for (const args of invalidSelections) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /interaction-kind/);
    assert.equal(result.stdout, '');
  }
  assert.ok(source.indexOf('const interactionKind = validateInteractionSelection(options, suite);') < source.indexOf('await mkdir(approved'));
});

async function interactionTrace(interactionKind) {
  const trace = [], samples = [];
  const app = { call: async (op, fields) => { trace.push({ op, fields }); } };
  const run = makeInteractionRun({
    interactionKind,
    check: async () => { trace.push({ op: 'check' }); return { taskIds: ['fixture-check'] }; },
    interaction: async (_app, op, fields, measured = true) => {
      trace.push({ op, fields, measured });
      if (measured) samples.push({ category: op === 'openDocument' ? 'document' : op, condition: 'native-ui-input-to-painted-result', durationMs: 120 });
    },
    recordBackground: async (_app, _load, category) => { trace.push({ op: 'recordBackground', category }); },
  });
  await run(app, policy.localSamplesPerCategory);
  return { trace, samples };
}

test('document-only continuation preserves the original unmeasured preparation and exact hundred-input document path', async () => {
  const full = await interactionTrace(undefined), selected = await interactionTrace('document');
  const fullVerdict = localInteractionVerdict(full.samples), selectedVerdict = localInteractionVerdict(selected.samples);
  assert.equal(full.samples.length, 400);
  for (const category of ['search', 'filter', 'tab', 'document']) assert.equal(fullVerdict[category].count, 100);
  assert.equal(selected.samples.length, 100);
  assert.ok(selected.samples.every(sample => sample.category === 'document'));
  assert.deepEqual(selected.trace.slice(0, 2), [
    { op: 'search', fields: { index: 0 }, measured: false },
    { op: 'openDocument', fields: { index: 0 }, measured: false },
  ]);
  const documentStart = trace => trace.findIndex(event => event.op === 'closeDocument' && event.fields.index === 0);
  assert.deepEqual(selected.trace.slice(documentStart(selected.trace)), full.trace.slice(documentStart(full.trace)));
  assert.deepEqual(selected.trace.filter(event => event.op === 'openDocument' && event.measured).map(event => event.fields.index), Array.from({ length: 100 }, (_, index) => index + 10));
  assert.equal(full.trace.filter(event => event.op === 'check').length, 4);
  assert.equal(selected.trace.filter(event => event.op === 'check').length, 1);
  assert.equal(selectedVerdict.document.status, 'passed');
  for (const category of ['search', 'filter', 'tab']) assert.equal(selectedVerdict[category].status, 'incomplete');
});

test('document-only status stays partial and retains sample, strict-delay and diagnostic gates', async () => {
  const { samples } = await interactionTrace('document');
  const status = (values, options = {}) => finalize({ startup: {}, interactionVerdict: localInteractionVerdict(values) }, 'interactive', undefined, options, 'passed-background-loads-only', 'document', 'passed-partial-document-interactions-only');
  assert.equal(status(samples), 'passed-partial-document-interactions-only');
  assert.equal(status(samples.slice(0, 99)), 'incomplete');
  assert.equal(status(samples.map(sample => ({ ...sample, durationMs: 201 }))), 'failed');
  assert.equal(status(samples.map(sample => ({ ...sample, durationMs: NaN }))), 'failed');
  assert.equal(status(samples, { 'concurrent-observation': true }), 'diagnostic-only-concurrent-observation');
  assert.equal(finalize({ startup: {}, interactionVerdict: localInteractionVerdict(samples) }, 'interactive', undefined, {}, 'passed-background-loads-only'), 'incomplete');
  assert.match(source, /scope: 'partial-limited'.*omittedKinds: \['search', 'filter', 'tab'\], requiredSamples: policy\.localSamplesPerCategory, fullInteractiveAcceptanceClaimed: false/);
  assert.match(source, /interactionSelection: report\.interactionSelection/);
  assert.match(source, /else if \(interactionKind && report\.status !== passedInteractionStatus\) process\.exitCode = 2/);
});
