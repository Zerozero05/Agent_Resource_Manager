import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { PERFORMANCE_POLICY as policy, backgroundLoadVerdict } from './performance-policy.mjs';

const actions = { check: 'check_now', download: 'apply_resource_download', update: 'apply_resource_update_stage' };
const kinds = Object.keys(actions);
const conditions = { SendInput: 'native-ui-input-to-painted-result', 'native-accessibility-patterns': 'native-accessibility-input-to-painted-result' };
const synchronous = 'synchronous-input-then-observation';
const label = 'candidate-mixed-1000-100';
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
const payload = ({ observedAt, ...value }) => value;
const taskPayload = ({ kind, ...value }) => value;
const identityOf = ({ pid, windowHandle, creationFileTime }) => ({ pid, windowHandle, creationFileTime });
const candidateKey = ({ sha256, buildMode, source, buildInfoSha256 }) => ({ sha256, buildMode, source, buildInfoSha256 });
const machineFields = ['hostname', 'platform', 'release', 'logicalProcessors', 'cpuModel', 'node'];
const officialDownload = {
  repository: 'Panniantong/Agent-Reach', tag: 'v1.6.0', releaseId: 421526768,
  assetId: 668240314, assetName: 'agent-reach.zip', assetBytes: 676536, bytesPerSecond: 1024,
};
const officialSha256 = '59c37586e45e5e111a78686e98a9d11ae71a7b4b1a334c41aef82831ea5b0a05';

function requireEvidence(condition, reason) {
  if (!condition) throw new Error(reason);
}

async function readEvidence(path) {
  const root = dirname(path);
  const [report, driver, log, dataset] = await Promise.all([
    readFile(path, 'utf8'),
    readFile(join(root, label + '-driver.json'), 'utf8'),
    readFile(join(root, 'observations.jsonl'), 'utf8'),
    readFile(join(root, 'mixed-native-fixture', 'dataset.json')),
  ]);
  return { report: JSON.parse(report), driver: JSON.parse(driver),
    events: log.trim().split(/\r?\n/).map(line => JSON.parse(line)),
    dataset: JSON.parse(dataset), datasetDescriptorSha256: digest(dataset) };
}

function completedTask(report, kind, run) {
  const { receipt, startedAt, finishedAt } = run;
  const duration = timestamp(finishedAt) - timestamp(startedAt);
  if (run.status !== 'succeeded' || typeof run.taskId !== 'string' || !run.taskId || !(duration >= 0)) return false;
  if (kind === 'check') return receipt === null;
  if (receipt?.taskId !== run.taskId || receipt.complete !== true) return false;
  if (kind === 'download') {
    const spec = report.downloadSpecification?.specification;
    return Object.entries(officialDownload).every(([key, value]) => spec?.[key] === value)
      && report.downloadSpecification.assetSha256 === officialSha256 && spec.directory === run.generatedScope
      && win32.isAbsolute(spec.directory) && typeof receipt.downloadId === 'string' && /^[\w-]+$/.test(receipt.downloadId)
      && receipt.archivePath === win32.join(spec.directory, receipt.downloadId + '-' + spec.assetName)
      && receipt.sha256 === officialSha256 && receipt.bytes === spec.assetBytes && receipt.bytesPerSecond === spec.bytesPerSecond
      && receipt.durationMs === duration && duration >= Math.floor(spec.assetBytes / spec.bytesPerSecond * 1000);
  }
  const seed = report.stageFixtures?.find(item => item.resourceId === run.resourceId);
  return seed && typeof run.generatedScope === 'string' && win32.isAbsolute(run.generatedScope)
    && win32.dirname(seed.fixturePath) === run.generatedScope && win32.basename(seed.fixturePath) === 'load-fixture.json'
    && sha(seed.manifestSha256) && sha(seed.archiveSha256) && seed.fileCount === 4098
    && typeof seed.fixtureScopeId === 'string' && seed.fixtureScopeId === receipt.fixtureScopeId
    && receipt.resourceId === seed.resourceId && receipt.fileCount === seed.fileCount
    && receipt.staged === true && receipt.switched === false
    && receipt.destination === win32.join(run.generatedScope, 'candidates', 'native-uia-v2');
}

function replay({ report, driver, events, dataset, datasetDescriptorSha256 }, expectedSha256) {
  const { candidate, loadSelection: selection, sampledLoad: stats, machine, harness } = report;
  const kind = selection?.kind, condition = conditions[report.inputMethod];
  requireEvidence(kinds.includes(kind) && report.formatVersion === 1 && report.suite === 'loads'
    && selection.scope === 'sampled-' + kind + '-only' && selection.fullLoadsAcceptanceClaimed === false
    && same(selection.omittedKinds, kinds.filter(value => value !== kind)) && selection.requiredSamplesPerCategory === policy.localSamplesPerCategory
    && stats?.kind === kind && ['sample-count', 'time-budget', 'attempt-budget', 'task-budget'].includes(stats.stopReason),
  'A completed single-workload sampling scope is required.');
  requireEvidence(!report.error && !report.foregroundFailure && Array.isArray(report.nativeErrors) && !report.nativeErrors.length
    && report.harnessChangedDuringRun === false && condition && report.observationMode === synchronous && same(report.policy, policy)
    && candidate?.sha256 === expectedSha256 && candidate.buildMode === 'release' && candidate.releaseProvenanceVerified === true
    && sha(candidate.buildInfoSha256) && typeof candidate.source === 'string' && candidate.source.length > 0,
  'The run does not bind an unchanged synchronous harness to the exact release binary.');
  const datasetKey = { skillCount: dataset.skillCount, toolCount: dataset.toolCount, template: 'static-skill-v1', settings: dataset.settings };
  requireEvidence(dataset.format === 'agent-resource-manager-native-performance-v1' && dataset.syntheticOnly === true
    && dataset.skillCount === 1000 && dataset.toolCount === 100 && dataset.settings && same(dataset, report.dataset)
    && dataset.dataFingerprint === digest(JSON.stringify(datasetKey)) && driver.datasetDescriptorSha256 === datasetDescriptorSha256
    && machine?.platform === 'win32' && machineFields.every(key => machine[key]) && driver.observationCostsIncluded === true,
  'The Windows machine and comparable synthetic dataset/layout are not evidenced.');
  const starts = events.filter(event => event.kind === 'native-startup');
  const exits = events.filter(event => event.kind === 'native-normal-exit');
  const startup = starts[0], exit = exits[0], identity = identityOf(driver);
  const from = timestamp(startup?.observedAt), to = timestamp(exit?.observedAt);
  const nativeHarness = harness?.find(item => win32.basename(item.path) === 'verify-native-uia.ps1');
  requireEvidence(starts.length === 1 && exits.length === 1 && startup.label === label && exit.label === label
    && startup.completeBackendStartup === true && exit.closedNormally === true && from < to
    && same(identityOf(startup), identity) && exit.pid === identity.pid && exit.creationFileTime === identity.creationFileTime
    && startup.executableSha256 === expectedSha256 && driver.executableSha256 === expectedSha256
    && startup.dataDirectory === dataset.dataDir && driver.dataDirectory === dataset.dataDir
    && startup.sourceIdentity === candidate.source && sha(nativeHarness?.sha256)
    && startup.harnessSha256 === nativeHarness.sha256 && driver.harnessSha256 === nativeHarness.sha256
    && driver.mode === 'bridge' && driver.status === 'measurements-collected' && driver.closedNormally === true
    && driver.observationMode === synchronous && driver.inputMethod === report.inputMethod && driver.readinessMode === 'strict-skill-list'
    && typeof startup.integrityLevel === 'string' && startup.integrityLevel === driver.integrityLevel,
  'The native startup, driver, or normal exit does not bind the measured session.');

  const rows = report.loadCoverage ?? [], taskRuns = stats.taskRuns;
  const observations = events.filter(event => event.kind === kind && event.sample);
  const measured = events.filter(event => event.kind === 'native-interaction').map(event => taskPayload(payload(event)));
  const completions = events.filter(event => event.kind === kind && event.status === 'succeeded' && !event.sample);
  requireEvidence(Array.isArray(rows) && stats.attempts === rows.length && rows.every(row => row.kind === kind)
    && same(rows, observations.map(payload)) && same(rows.map(row => row.sample), measured)
    && same(measured, report.interactions) && Array.isArray(taskRuns)
    && same(taskRuns, completions.map(event => taskPayload(payload(event)))),
  'A raw observation or native task completion differs from its event log.');
  const runs = new Map(taskRuns.map(run => [run.taskId, run]));
  const maximumTasks = { check: 96, download: 1, update: 12 }[kind];
  requireEvidence(runs.size === taskRuns.length && taskRuns.length <= maximumTasks
    && taskRuns.every((run, index) => completedTask(report, kind, run) && timestamp(run.startedAt) >= from
      && timestamp(run.finishedAt) <= timestamp(completions[index].observedAt) && timestamp(completions[index].observedAt) <= to),
  'Workload completion receipts are missing, repeated, or out of scope.');
  if (kind === 'update') {
    requireEvidence(new Set(taskRuns.map(run => run.resourceId)).size === taskRuns.length
      && new Set(taskRuns.map(run => run.receipt.fixtureScopeId)).size === taskRuns.length,
    'Repeated update inputs cannot establish separate completed stages.');
  }
  const contained = rows.filter(row => {
    const run = runs.get(row.taskId);
    return run && row.taskStartedAt === run.startedAt && row.sample?.finishedAtUtcMs <= timestamp(run.finishedAt)
      && (row.afterStatus !== 'succeeded' || row.taskFinishedAt === run.finishedAt);
  });
  const verdict = backgroundLoadVerdict(contained, identity.pid, condition, identity)[kind];
  const tolerance = summarize(Object.values(verdict.sampledOverlap.categories).map(value => value.limitedTolerance.status));
  return { kind, from, to, identity, comparisons: { candidate: candidateKey(candidate), condition, machine, harness,
    dataFingerprint: dataset.dataFingerprint, integrityLevel: driver.integrityLevel },
    result: { completedTasks: taskRuns.length, rowsOutsideCompletedTasks: rows.length - contained.length,
      originalP95: verdict.sampledOverlap.status, limitedTolerance: tolerance, sampleOverlap: verdict.sampledOverlap,
      smokeThresholdOnTheseRows: verdict.status } };
}

function summarize(statuses) {
  if (statuses.includes('invalid')) return 'invalid';
  if (statuses.includes('failed')) return 'failed';
  return statuses.every(status => status === 'passed') ? 'passed' : 'incomplete';
}

export function consolidateSampledLoads(evidence, expectedSha256) {
  requireEvidence(sha(expectedSha256), 'Provide the exact lower-case release executable SHA256.');
  const workloads = Object.fromEntries(kinds.map(kind => [kind, null]));
  const reasons = [], sessions = [];
  for (const input of evidence) {
    try {
      if (input.error) throw new Error(input.error);
      const run = replay(input, expectedSha256);
      requireEvidence(!workloads[run.kind], 'Repeated workload: ' + run.kind);
      requireEvidence(sessions.every(session => same(session.comparisons, run.comparisons)
        && !same(session.identity, run.identity) && (session.to <= run.from || run.to <= session.from)),
      'Reports must use the same release, machine, input, harness, and configured layout in separate sessions.');
      sessions.push(run);
      workloads[run.kind] = run.result;
    } catch (error) {
      reasons.push(error.message);
    }
  }
  const results = Object.values(workloads);
  const originalP95 = summarize(results.map(value => value?.originalP95));
  const limitedTolerance = summarize(results.map(value => value?.limitedTolerance));
  const enoughSamples = results.every(value => value && Object.values(value.sampleOverlap.categories)
    .every(category => category.count >= policy.localSamplesPerCategory));
  return { status: reasons.length || !enoughSamples ? 'incomplete' : summarize([originalP95, limitedTolerance]),
    candidateSha256: expectedSha256, originalP95, limitedTolerance, workloads, reasons,
    missingWorkloads: kinds.filter(kind => !workloads[kind]),
    scope: 'sampled-mixed-loads-only', fullPlanVerified: false,
    layoutEvidence: 'same configured fixture settings; physical window geometry, display scaling, and monitor are not recorded',
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [expectedSha256, ...paths] = process.argv.slice(2);
  if (!sha(expectedSha256) || paths.length > kinds.length) {
    console.error('Usage: node scripts/verify-sampled-load-evidence.mjs <release-sha256> [check-report.json] [download-report.json] [update-report.json]');
    process.exitCode = 1;
  } else {
    const evidence = await Promise.all(paths.map(async path => {
      try { return await readEvidence(path); }
      catch (error) { return { error: 'Cannot read the report and its native evidence: ' + error.message }; }
    }));
    const result = consolidateSampledLoads(evidence, expectedSha256);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === 'passed' ? 0 : result.status === 'incomplete' ? 2 : 1;
  }
}
