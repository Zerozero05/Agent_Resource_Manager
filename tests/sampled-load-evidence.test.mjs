import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import test from 'node:test';
import { MAX_NATIVE_UPDATE_FIXTURES } from '../scripts/performance-load-fixture.mjs';
import { PERFORMANCE_POLICY } from '../scripts/performance-policy.mjs';
import { consolidateSampledLoads } from '../scripts/verify-sampled-load-evidence.mjs';

const candidate = 'a'.repeat(64), driverHash = 'b'.repeat(64);
const assetSha256 = '59c37586e45e5e111a78686e98a9d11ae71a7b4b1a334c41aef82831ea5b0a05';
const kinds = ['check', 'download', 'update'];
const label = 'candidate-mixed-1000-100';
const synchronous = 'synchronous-input-then-observation';
const iso = value => new Date(value).toISOString();
const digest = value => createHash('sha256').update(value).digest('hex');

function scope(kind, duration = () => 70, count = 100) {
  const index = kinds.indexOf(kind), offset = Date.parse('2026-11-18T00:00:00Z') + index * 720000;
  const identity = { pid: 123 + index, windowHandle: 41234 + index, creationFileTime: '13440000000000000' + index };
  const root = win32.join('D:/validation', kind), dataDir = win32.join(root, 'data'), generatedScope = win32.join('D:/test-resources', kind);
  const comparable = { skillCount: 1000, toolCount: 100, template: 'static-skill-v1', settings: { uiTheme: 'dark', uiZoom: 115 } };
  const { template, ...shape } = comparable;
  const dataset = { ...shape, root, dataDir, format: 'agent-resource-manager-native-performance-v1', syntheticOnly: true,
    dataFingerprint: digest(JSON.stringify(comparable)) };
  const datasetDescriptorSha256 = digest(JSON.stringify(dataset));
  const report = {
    formatVersion: 1, suite: 'loads', policy: PERFORMANCE_POLICY, nativeErrors: [], harnessChangedDuringRun: false,
    inputMethod: 'native-accessibility-patterns', observationMode: synchronous, dataset,
    machine: { hostname: 'test-host', platform: 'win32', release: 'test-os', logicalProcessors: 8, cpuModel: 'test CPU', node: 'v24.0.0' },
    candidate: { sha256: candidate, buildMode: 'release', releaseProvenanceVerified: true, source: 'test-source', buildInfoSha256: 'c'.repeat(64) },
    harness: [{ path: win32.join('D:/test-sources', 'verify-native-uia.ps1'), sha256: driverHash }],
    loadSelection: { kind, scope: 'sampled-' + kind + '-only', omittedKinds: kinds.filter(value => value !== kind),
      fullLoadsAcceptanceClaimed: false, requiredSamplesPerCategory: 100 },
  };
  const driver = { ...identity, datasetDescriptorSha256, inputMethod: report.inputMethod, observationMode: synchronous,
    observationCostsIncluded: true, executableSha256: candidate, harnessSha256: driverHash, dataDirectory: dataDir,
    mode: 'bridge', status: 'measurements-collected', closedNormally: true, readinessMode: 'strict-skill-list', integrityLevel: 'high' };
  const taskId = kind + '-native-task', startedAt = iso(offset + 10), finishedAt = iso(offset + 661010);
  let receipt = kind === 'check' ? null : { taskId, complete: true };
  const run = { taskId, status: 'succeeded', startedAt, finishedAt, ...(kind === 'check' ? {} : { generatedScope }) };
  if (kind === 'download') {
    const spec = { repository: 'Panniantong/Agent-Reach', tag: 'v1.6.0', releaseId: 421526768, assetId: 668240314,
      assetName: 'agent-reach.zip', assetBytes: 676536, directory: generatedScope, bytesPerSecond: 1024 };
    report.downloadSpecification = { specification: spec, assetSha256 };
    Object.assign(receipt, { downloadId: 'test-id', archivePath: win32.join(spec.directory, 'test-id-agent-reach.zip'),
      sha256: assetSha256, bytes: spec.assetBytes, bytesPerSecond: spec.bytesPerSecond, durationMs: 661000 });
  }
  if (kind === 'update') {
    const seed = { resourceId: 'perf-tool-000', fixturePath: win32.join(generatedScope, 'load-fixture.json'),
      manifestSha256: 'd'.repeat(64), archiveSha256: 'e'.repeat(64), fileCount: 4098, fixtureScopeId: 'sampled-stage-scope' };
    run.resourceId = seed.resourceId;
    report.stageFixtures = [seed];
    Object.assign(receipt, { staged: true, switched: false, destination: win32.join(generatedScope, 'candidates', 'native-uia-v2'),
      resourceId: seed.resourceId, fileCount: seed.fileCount, fixtureScopeId: seed.fixtureScopeId });
  }
  run.receipt = receipt;
  const taskAction = ['check_now', 'apply_resource_download', 'apply_resource_update_stage'][index], rows = [];
  for (const category of ['search', 'filter', 'tab', 'document']) {
    for (let index = 0; index < count; index++) {
      const startedAtUtcMs = offset + 100 + rows.length * 1500, durationMs = duration(category, index);
      const sample = { category, durationMs, ...identity, condition: 'native-accessibility-input-to-painted-result',
        foregroundBefore: true, foregroundAfter: true, startedAtUtcMs, finishedAtUtcMs: startedAtUtcMs + durationMs };
      rows.push({ kind, taskId, taskAction, beforeStatus: 'running', afterStatus: 'running', taskStartedAt: startedAt,
        beforeObservedAtMs: startedAtUtcMs - 1, afterObservedAtMs: sample.finishedAtUtcMs + 1, sample });
    }
  }
  report.sampledLoad = { kind, stopReason: count === 100 ? 'sample-count' : 'task-budget', attempts: rows.length, taskRuns: [run] };
  report.loadCoverage = rows;
  report.interactions = rows.map(row => structuredClone(row.sample));
  const events = [{ observedAt: iso(offset), kind: 'native-startup', label, ...identity, dataDirectory: dataDir,
    completeBackendStartup: true, executableSha256: candidate, sourceIdentity: report.candidate.source, harnessSha256: driverHash, integrityLevel: 'high' },
  ...rows.flatMap(row => [
    { observedAt: iso(row.sample.finishedAtUtcMs), kind: 'native-interaction', ...structuredClone(row.sample) },
    { observedAt: iso(row.afterObservedAtMs), ...structuredClone(row) },
  ]),
  { observedAt: iso(offset + 661030), kind, ...structuredClone(run) },
  { observedAt: iso(offset + 661040), kind: 'native-normal-exit', label, ...identity, closedNormally: true }];
  return { report, driver, dataset, datasetDescriptorSha256, events };
}

test('three separate workloads on one bound release independently pass both thresholds', () => {
  const reports = kinds.map(kind => scope(kind));
  for (const { report } of reports) report.loadVerdict = { intentionallyIgnored: 'failed' };
  const result = consolidateSampledLoads(reports, candidate);
  assert.deepEqual([result.status, result.originalP95, result.limitedTolerance], ['passed', 'passed', 'passed']);
  assert.deepEqual(Object.values(result.workloads).map(workload => workload.sampleOverlap.acceptedInputs), [400, 400, 400]);
  assert.equal(result.fullPlanVerified, false);
});

test('original P95 and limited tolerance are separately recomputed', () => {
  const cases = [
    [(category) => category === 'document' ? 300 : 70, 'failed', 'passed'],
    [(category, index) => category === 'document' && index === 0 ? 1200 : 70, 'passed', 'failed'],
  ];
  for (const [duration, p95, tolerance] of cases) {
    const result = consolidateSampledLoads([scope('check'), scope('download', duration), scope('update')], candidate);
    assert.deepEqual([result.status, result.originalP95, result.limitedTolerance], ['failed', p95, tolerance]);
  }
});

test('update replay uses the same completed-task cap as the native sampler', () => {
  const update = scope('update');
  const { report, events } = update;
  const exit = events.pop();
  const [seed] = report.stageFixtures;
  const [firstRun] = report.sampledLoad.taskRuns;
  const firstFinish = Date.parse(firstRun.finishedAt);
  const appendStage = index => {
    const generatedScope = win32.join(firstRun.generatedScope, String(index));
    const resourceId = 'perf-tool-' + String(index).padStart(3, '0');
    const fixtureScopeId = 'sampled-stage-scope-' + index;
    const taskId = 'update-native-task-' + index;
    const startedAt = iso(firstFinish + index * 100), finishedAt = iso(firstFinish + index * 100 + 20);
    const receipt = { ...firstRun.receipt, taskId, resourceId, fixtureScopeId,
      destination: win32.join(generatedScope, 'candidates', 'native-uia-v2') };
    const run = { ...firstRun, taskId, resourceId, generatedScope, startedAt, finishedAt, receipt };
    report.stageFixtures.push({ ...seed, resourceId, fixtureScopeId, fixturePath: win32.join(generatedScope, 'load-fixture.json') });
    report.sampledLoad.taskRuns.push(run);
    events.splice(events.length - 1, 0, { kind: 'update', ...structuredClone(run), observedAt: iso(Date.parse(finishedAt) + 1) });
  };
  exit.observedAt = iso(firstFinish + (MAX_NATIVE_UPDATE_FIXTURES + 1) * 100);
  events.push(exit);
  for (let index = 1; index < MAX_NATIVE_UPDATE_FIXTURES; index++) appendStage(index);
  const reports = [scope('check'), scope('download'), update];
  const atCap = consolidateSampledLoads(reports, candidate);
  assert.equal(atCap.status, 'passed');
  assert.equal(atCap.workloads.update.completedTasks, MAX_NATIVE_UPDATE_FIXTURES);
  appendStage(MAX_NATIVE_UPDATE_FIXTURES);
  const beyondCap = consolidateSampledLoads(reports, candidate);
  assert.equal(beyondCap.status, 'incomplete');
  assert.match(beyondCap.reasons[0], /completion receipts/);
});

test('sample shortages and absent or incomparable evidence stay incomplete', () => {
  const results = [
    [scope('check'), scope('download'), scope('update', undefined, 99)],
    [scope('check'), scope('update')],
    [scope('check'), scope('check'), scope('download')],
    [],
  ].map(reports => consolidateSampledLoads(reports, candidate));
  assert.ok(results.every(result => result.status === 'incomplete'));
  assert.equal(results[0].workloads.update.sampleOverlap.categories.document.count, 99);
  assert.equal(results[0].workloads.update.sampleOverlap.categories.document.p95Ms, null);
  assert.deepEqual(results[1].missingWorkloads, ['download']);
  assert.match(results[2].reasons[0], /Repeated workload/);
  const changed = scope('update');
  changed.report.machine.hostname = 'other-machine';
  assert.match(consolidateSampledLoads([scope('check'), scope('download'), changed], candidate).reasons[0], /same release, machine/);
});

test('old release, changed layout, altered event evidence and incomplete task receipts cannot pass', () => {
  const mutations = [
    [value => { value.report.candidate.sha256 = 'f'.repeat(64); }, /exact release binary/],
    [value => { value.dataset.settings.uiZoom = 130; }, /dataset\/layout/],
    [value => { value.report.loadCoverage[0].sample.durationMs = 1; }, /differs from its event log/],
    [value => { value.report.sampledLoad.taskRuns[0].receipt.switched = true;
      value.events.at(-2).receipt.switched = true; }, /completion receipts/],
    [value => { value.driver.closedNormally = false; }, /normal exit/],
  ];
  for (const [mutate, reason] of mutations) {
    const update = scope('update');
    mutate(update);
    const result = consolidateSampledLoads([scope('check'), scope('download'), update], candidate);
    assert.equal(result.status, 'incomplete');
    assert.match(result.reasons[0], reason);
  }
});
