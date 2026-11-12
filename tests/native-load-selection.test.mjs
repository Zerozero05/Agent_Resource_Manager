import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PERFORMANCE_POLICY as policy, backgroundLoadVerdict, localInteractionVerdict } from '../scripts/performance-policy.mjs';

const source = readFileSync(new URL('../scripts/verify-uia-performance.mjs', import.meta.url), 'utf8');
const validation = source.slice(source.indexOf('function validateLoadSelection('), source.indexOf('\nif (options.help)'));
const select = new Function(`${validation}; return validateLoadSelection;`)();
const selectInteraction = new Function(`${validation}; return validateInteractionSelection;`)();
const transportDigest = new Function(`${validation}; return transportDigest;`)();
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
