import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { NativeUiaSession } from './native-uia-client.mjs';
import { createPerformanceFixture } from './performance-fixture.mjs';
import { backgroundLoadVerdict, ownedForeground } from './performance-policy.mjs';

const source = 'bbd51752eec3d616203ee7a0529d0d935b7cc8ba';
const expectedSha256 = '54269857d8cdcd3b2d9ab52f9eb00949960abb98470e8c8a8c399e5db645c273';
const condition = 'native-accessibility-input-to-painted-result';
const attemptsPerCategory = 6;
const approved = 'D:\\03_github_projects\\Agent_Management\\Agent_Resource_Manager\\validation\\manager-data';
const isCheck = task => task.action === 'check_now';
const isActive = task => ['queued', 'running'].includes(task.status);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const { values } = parseArgs({ options: {
  candidate: { type: 'string' },
  'candidate-build-info': { type: 'string' },
  output: { type: 'string' },
} });
assert.ok(values.candidate && values['candidate-build-info'] && values.output,
  'Pass --candidate, --candidate-build-info and --output.');
const env = process.env;
assert.ok(process.platform === 'win32' && env.RUNNER_OS === 'Windows' && env.RUNNER_ENVIRONMENT === 'github-hosted'
  && env.GITHUB_ACTIONS === 'true' && /^zerozero05\/agent_resource_manager$/i.test(env.GITHUB_REPOSITORY ?? '')
  && /^\d+$/.test(env.GITHUB_RUN_ID ?? '') && /^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? '') && env.RUNNER_TEMP,
  'This bounded diagnostic requires a fresh GitHub-hosted Windows workflow for Agent Resource Manager.');

const executable = await realpath(resolve(values.candidate));
const buildPath = await realpath(resolve(values['candidate-build-info']));
assert.match(basename(executable), /^agent-resource-manager\.exe$/i);
const [exeBytes, buildBytes] = await Promise.all([readFile(executable), readFile(buildPath)]);
const build = JSON.parse(buildBytes.toString('utf8').replace(/^\uFEFF/, ''));
assert.equal(build.buildMode, 'release');
assert.equal(build.sourceIdentity ?? build.sourceCommit, source);
assert.equal((build.executableSha256 ?? build.sha256)?.toLowerCase(), expectedSha256);
assert.equal(sha256(exeBytes), expectedSha256);
assert.equal(exeBytes.readUInt16LE(0), 0x5a4d);
const peOffset = exeBytes.readUInt32LE(0x3c);
assert.equal(exeBytes.readUInt32LE(peOffset), 0x4550);
assert.equal(exeBytes.readUInt16LE(peOffset + 4), 0x8664);

const output = resolve(values.output);
const temp = await realpath(env.RUNNER_TEMP);
assert.match(output, /^D:\\/i, 'The synthetic fixture must remain on the hosted D drive.');
assert.equal(dirname(output).toLowerCase(), temp.toLowerCase(), 'Use a fresh direct child of RUNNER_TEMP.');
await mkdir(output);
const report = {
  format: 'arm-hosted-check-paired-diagnostic-v1',
  diagnosticOnly: true,
  acceptanceClaimed: false,
  status: 'diagnostic-incomplete',
  candidate: { source, sha256: expectedSha256, buildInfoSha256: sha256(buildBytes) },
  hosted: { runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, image: env.ImageVersion ?? null },
  startedAt: new Date().toISOString(),
  design: {
    attemptsPerCategory,
    condition,
    observationMode: 'synchronous-input-then-observation',
    order: 'Alternating idle/running order within category, same prepared target within each pair.',
    scope: 'Warm local explanation and search only. Full-task running overlap is verified using the original measurement rule.',
  },
  pairs: [],
};

let app;
let driverReport;
let lastFinish = 0;
const taskList = async () => (await app.call('tasks')).tasks;
const taskById = async id => {
  const { task } = await app.call('task', { taskId: id });
  assert.ok(task?.id === id && isCheck(task), 'The exact native check task changed during observation.');
  return task;
};
const verifyForeground = async () => {
  assert.ok(ownedForeground(await app.call('windowIdentity'), app.identity),
    'The exact owned native window must stay foreground. No focus recovery or alternate input.');
};
const operation = async (op, fields = {}) => {
  await verifyForeground();
  return app.call(op, fields);
};

async function waitForIdle() {
  const deadline = performance.now() + 60000;
  do {
    const tasks = await taskList();
    if (!tasks.some(isActive)) return tasks;
    await delay(50);
  } while (performance.now() < deadline);
  throw new Error('Active tasks did not settle before the next paired observation.');
}

async function startCheck(known) {
  const ids = new Set(known.filter(isCheck).map(task => task.id));
  await operation('check');
  const deadline = performance.now() + 8000;
  do {
    const created = (await taskList()).filter(task => isCheck(task) && !ids.has(task.id));
    assert.ok(created.length <= 1, 'A single native input produced multiple check tasks.');
    if (created.length === 1 && created[0].status !== 'queued') return created[0];
    await delay(30);
  } while (performance.now() < deadline);
  throw new Error('The new native check task was not observed leaving the queue.');
}

async function measure(category, index) {
  const sample = await operation(category === 'search' ? 'search' : 'openDocument', { index });
  await verifyForeground();
  assert.ok(sample.category === category && sample.condition === condition
    && sample.observationMode === report.design.observationMode
    && sample.foregroundBefore && sample.foregroundAfter
    && sample.pid === app.identity.pid && sample.windowHandle === app.identity.windowHandle
    && sample.creationFileTime === app.identity.creationFileTime
    && Number.isSafeInteger(sample.startedAtUtcMs) && Number.isSafeInteger(sample.finishedAtUtcMs)
    && sample.startedAtUtcMs >= lastFinish && sample.finishedAtUtcMs >= sample.startedAtUtcMs
    && ['durationMs', 'uiaQueryMs', 'inputDispatchMs', 'dwmPresentationWaitMs']
      .every(key => Number.isFinite(sample[key]) && sample[key] >= 0),
  'A measurement did not retain the original native identity, time interval or observation mode.');
  lastFinish = sample.finishedAtUtcMs;
  return sample;
}

async function observe(category, index, mode) {
  if (category === 'document') await operation('search', { index });
  const beforeTasks = await waitForIdle();
  const beforeCheckAt = Date.now();
  const started = mode === 'running' ? await startCheck(beforeTasks) : null;
  const beforeObservedAtMs = Date.now();
  let sample = null;
  let proof;
  if (!started || started.status === 'running') sample = await measure(category, index);

  if (!started) {
    const afterTasks = await taskList();
    const afterObservedAtMs = Date.now();
    const checks = afterTasks.filter(isCheck);
    const beforeIds = new Set(beforeTasks.filter(isCheck).map(task => task.id));
    const afterIds = new Set(checks.map(task => task.id));
    const valid = beforeCheckAt <= sample.startedAtUtcMs && sample.finishedAtUtcMs <= afterObservedAtMs
      && !afterTasks.some(isActive) && beforeIds.size === afterIds.size && checks.every(task => beforeIds.has(task.id));
    proof = { valid, beforeObservedAtMs: beforeCheckAt, afterObservedAtMs, checkCount: checks.length };
  } else {
    const after = await taskById(started.id);
    const afterObservedAtMs = Date.now();
    const record = {
      kind: 'check',
      taskId: started.id,
      taskAction: started.action,
      beforeStatus: started.status,
      afterStatus: after.status,
      beforeObservedAtMs,
      afterObservedAtMs,
      taskStartedAt: started.startedAt ?? after.startedAt,
      taskFinishedAt: after.finishedAt,
      sample,
    };
    const valid = sample !== null && backgroundLoadVerdict([record], app.identity.pid, condition, app.identity)
      .check.sampledOverlap.acceptedInputs === 1;
    const terminal = (await waitForIdle()).find(task => task.id === started.id);
    assert.equal(terminal?.status, 'succeeded', 'The exact check must finish successfully before the next condition.');
    proof = { valid, record, terminal: { id: terminal.id, status: terminal.status, startedAt: terminal.startedAt, finishedAt: terminal.finishedAt } };
  }

  if (category === 'document' && sample) await operation('closeDocument', { index });
  await operation('clear');
  return { mode, sample, proof };
}

try {
  await mkdir(approved, { recursive: true });
  assert.equal((await realpath(approved)).toLowerCase(), approved.toLowerCase());
  const isolated = await mkdtemp(join(approved, 'hosted-check-paired-'));
  driverReport = join(isolated, 'driver.json');
  report.dataset = await createPerformanceFixture(isolated, 'mixed-native-fixture', 100);
  app = await NativeUiaSession.launch({
    executable, sha256: expectedSha256, dataDir: report.dataset.dataDir,
    reportPath: driverReport, accessibilityInput: true,
  });
  assert.equal(app.identity.executableSha256, expectedSha256);
  assert.equal(resolve(app.identity.dataDirectory).toLowerCase(), resolve(report.dataset.dataDir).toLowerCase());
  report.window = { pid: app.identity.pid, creationFileTime: app.identity.creationFileTime, windowHandle: app.identity.windowHandle };

  const measurementDeadline = performance.now() + 180000;
  for (let attempt = 0; attempt < attemptsPerCategory; attempt++) {
    for (const category of ['search', 'document']) {
      if (performance.now() >= measurementDeadline) break;
      const index = (category === 'search' ? 100 : 200) + attempt;
      if (category === 'document') {
        // Warm the exact target before either half of the pair. This is not a cold-open test.
        await operation('search', { index });
        await operation('openDocument', { index });
        await operation('closeDocument', { index });
        await operation('clear');
      }
      const order = (attempt + Number(category === 'document')) % 2 ? ['running', 'idle'] : ['idle', 'running'];
      const pair = { category, index, order, observations: [] };
      report.pairs.push(pair);
      for (const mode of order) pair.observations.push(await observe(category, index, mode));
      pair.valid = pair.observations.every(value => value.proof.valid);
    }
  }
  report.validPairCounts = Object.fromEntries(['search', 'document'].map(category => [
    category, report.pairs.filter(pair => pair.category === category && pair.valid).length,
  ]));
  if (Object.values(report.validPairCounts).every(count => count === attemptsPerCategory)) {
    report.status = 'diagnostic-collected';
  }
} catch (error) {
  report.status = 'diagnostic-error';
  report.error = String(error);
} finally {
  try {
    if (app) {
      const exit = await app.quit();
      report.closedNormally = exit.driverReport.closedNormally === true;
      assert.ok(report.closedNormally, 'The native diagnostic window did not close normally.');
    }
    assert.equal(sha256(await readFile(executable)), expectedSha256);
    assert.equal(sha256(await readFile(buildPath)), report.candidate.buildInfoSha256);
  } catch (error) {
    report.status = 'diagnostic-error';
    report.finalizationError = String(error);
  }
  if (driverReport) {
    try {
      await copyFile(driverReport, join(output, 'driver.json'), constants.COPYFILE_EXCL);
    } catch (error) {
      if (app || error.code !== 'ENOENT') {
        report.status = 'diagnostic-error';
        report.driverReportError = String(error);
      }
    }
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}

console.log(JSON.stringify({ status: report.status, output, validPairCounts: report.validPairCounts }));
process.exitCode = report.status === 'diagnostic-collected' ? 0 : report.status === 'diagnostic-incomplete' ? 2 : 1;
