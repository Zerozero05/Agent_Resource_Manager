import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { assertNoUserManager, NativeUiaSession } from './native-uia-client.mjs';
import { createPerformanceFixture } from './performance-fixture.mjs';
import { ownedForeground } from './performance-policy.mjs';

const sourceCommit = 'c81fda47073b92938a45da1bfd5afd8b6e8fa4ce';
const candidateRunId = '45459930763';
const branch = 'codex/hosted-document-observer-c81fda4-20261125';
const fixtureParent = 'D:\\03_github_projects\\Agent_Management\\Agent_Resource_Manager\\validation\\manager-data';
const maxTrials = 20;
const samplesPerArm = 6;
const armOrder = ['uia', 'pixels', 'pixels', 'uia'];
const index = 0;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hashFile = async path => digest(await readFile(path));
const json = value => JSON.stringify(value, null, 2) + '\n';
const samePath = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase();
const active = task => task.status === 'queued' || task.status === 'running';
const date = value => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
const sha = /^[a-f0-9]{64}$/;

function inside(root, file) {
  const part = relative(root, file);
  return part && part !== '..' && !part.startsWith('..\\') && !isAbsolute(part);
}

async function ordinaryFile(path) {
  const metadata = await lstat(path);
  assert.ok(metadata.isFile() && metadata.nlink === 1 && samePath(path, await realpath(path)), 'A pinned file is missing, linked, or redirected.');
  return readFile(path);
}

function orderedJson(value) {
  if (Array.isArray(value)) return value.map(orderedJson);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, orderedJson(value[key])]));
  return value;
}

function protectedCatalog(fixture) {
  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try {
    const { skills, settings, sources, connections, localRoots, ignoredLocalPaths, checkMode } =
      JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload);
    const tools = db.prepare('SELECT id,revision,payload FROM resource_catalog ORDER BY id').all();
    assert.equal(skills.length, 1000);
    assert.equal(tools.length, 100);
    assert.equal(checkMode, 'manual');
    assert.ok([sources, connections, localRoots, ignoredLocalPaths].every(items => Array.isArray(items) && !items.length), 'Fixture acquired an outside source, connection, or watch scope.');
    return {
      // Re-saving the fixture can reorder nested settings keys without changing values.
      settings: orderedJson(settings), sources, connections, localRoots, ignoredLocalPaths, checkMode, tools,
      skills: skills.map(({ id, name, displayName, localPath, version, categoryId, favorite, runtimeFiles }) =>
        ({ id, name, displayName, localPath, version, categoryId, favorite, runtimeFiles })),
    };
  } finally {
    db.close();
  }
}

async function protectedFiles(fixture) {
  const manifest = createHash('sha256');
  for (const [root, prefix, count, width, file] of [
    [fixture.skillsRoot, 'perf-skill-', 1000, 4, 'SKILL.md'],
    [fixture.toolsRoot, 'perf-tool-', 100, 3, 'README.md'],
  ]) {
    for (let item = 0; item < count; item++) {
      const id = prefix + String(item).padStart(width, '0');
      manifest.update(id + '/' + file + '\0' + await hashFile(join(root, id, file)) + '\n');
    }
  }
  return manifest.digest('hex');
}

async function ownedWindow(app, waitMs = 0) {
  const deadline = Date.now() + waitMs;
  do {
    const owner = await app.call('windowIdentity');
    assert.equal(owner.capturedHandle, app.identity.windowHandle);
    assert.equal(owner.currentMainHandle, app.identity.windowHandle);
    assert.equal(owner.uiaProcessId, app.identity.pid);
    if (ownedForeground(owner, app.identity)) return owner;
    if (Date.now() < deadline) await delay(100);
  } while (Date.now() < deadline);
  throw new Error('The exact diagnostic window is not foreground. No focus or input retry was attempted.');
}

function taskSnapshot(task) {
  assert.ok(task && ['queued', 'running', 'succeeded'].includes(task.status) && task.action === 'check_now');
  assert.ok(typeof task.id === 'string' && task.id);
  return { id: task.id, action: task.action, status: task.status, startedAt: task.startedAt ?? null, finishedAt: task.finishedAt ?? null };
}

async function readCheck(app, id) {
  const { task } = await app.call('task', { taskId: id });
  const observedAtMs = Date.now();
  const check = taskSnapshot(task);
  assert.equal(check.id, id);
  return { ...check, observedAtMs };
}

async function startCheck(app, seenChecks) {
  await ownedWindow(app);
  const before = await app.call('tasks');
  assert.ok(Array.isArray(before.tasks) && before.tasks.every(task => !active(task)), 'Another task was active before a diagnostic check.');
  const existing = new Set(before.tasks.map(task => task.id));
  assert.deepEqual(await app.call('check'), { clicked: true });
  const deadline = Date.now() + 8000;
  do {
    const state = await app.call('tasks');
    const created = state.tasks.filter(task => !existing.has(task.id));
    assert.ok(created.length <= 1 && created.every(task => task.action === 'check_now'), 'The check action did not create a unique native check.');
    if (created.length) {
      const check = taskSnapshot(created[0]);
      assert.ok(!seenChecks.has(check.id), 'A check ID was reused.');
      seenChecks.add(check.id);
      return check.id;
    }
    await delay(20);
  } while (Date.now() < deadline);
  throw new Error('The native check was not observed. The action was not repeated.');
}

async function waitCheck(app, id, predicate, timeoutMs, initial) {
  const deadline = Date.now() + timeoutMs;
  let result = initial ?? await readCheck(app, id);
  while (!predicate(result) && Date.now() < deadline) {
    await delay(25);
    result = await readCheck(app, id);
  }
  assert.ok(predicate(result), 'The exact native check did not reach the required state in time.');
  return result;
}

function validateSample(sample, identity, arm, reference) {
  assert.equal(sample.category, 'document');
  assert.equal(sample.condition, 'native-accessibility-input-to-painted-result');
  assert.equal(sample.observationMode, arm === 'uia' ? 'synchronous-input-then-observation' : 'pixels-then-semantic-confirmation');
  assert.equal(sample.pid, identity.pid);
  assert.equal(sample.creationFileTime, identity.creationFileTime);
  assert.equal(sample.windowHandle, identity.windowHandle);
  assert.ok(sample.foregroundBefore === true && sample.foregroundAfter === true, 'Native foreground identity changed during the input.');
  assert.ok(Number.isSafeInteger(sample.startedAtUtcMs) && Number.isSafeInteger(sample.finishedAtUtcMs) && sample.finishedAtUtcMs > sample.startedAtUtcMs);
  assert.ok(Number.isFinite(sample.durationMs) && sample.durationMs > 0);
  if (arm === 'pixels') {
    const { firstMatchUpperMs, firstMatchAtUtcMs, captureCount, reconfirmedAtMs, firstCaptureSha256s, repeatedCaptureSha256s } = sample.pixels;
    assert.ok(Number.isFinite(firstMatchUpperMs) && firstMatchUpperMs > 0 && Number.isFinite(reconfirmedAtMs) &&
      reconfirmedAtMs > firstMatchUpperMs && reconfirmedAtMs < sample.durationMs);
    assert.ok(Number.isSafeInteger(firstMatchAtUtcMs) && firstMatchAtUtcMs >= sample.startedAtUtcMs && firstMatchAtUtcMs <= sample.finishedAtUtcMs);
    assert.ok(Number.isSafeInteger(captureCount) && captureCount >= 2);
    const expectedHashes = [reference.titleSha256, reference.tabSha256, reference.bodySha256];
    assert.deepEqual(firstCaptureSha256s, expectedHashes);
    assert.deepEqual(repeatedCaptureSha256s, expectedHashes);
  }
}

function overlap(attempt) {
  const { before, sample, after, completed } = attempt;
  const start = date(completed.startedAt), end = date(completed.finishedAt);
  assert.ok(start <= end && end <= completed.observedAtMs, 'Invalid completion times for the exact check.');
  assert.equal(before.startedAt, completed.startedAt);
  if (after.status === 'succeeded') assert.equal(after.finishedAt, completed.finishedAt);
  const admittedWindow = before.status === 'running' && start <= before.observedAtMs &&
    before.observedAtMs <= sample.startedAtUtcMs && sample.finishedAtUtcMs <= after.observedAtMs &&
    ['running', 'succeeded'].includes(after.status);
  return {
    fullSample: admittedWindow && sample.finishedAtUtcMs < end,
    firstVisibleMatch: attempt.arm === 'pixels' ? admittedWindow && sample.pixels.firstMatchAtUtcMs < end : null,
  };
}

async function run() {
  const env = process.env;
  const { CANDIDATE_SHA256: candidateSha256, CANDIDATE_BUILD_INFO_SHA256: originalBuildInfoSha256,
    CANDIDATE_ARCHIVE_SHA256: candidateArchiveSha256, CANDIDATE_ARTIFACT_ID: candidateArtifactId,
    CANDIDATE_JOB_ID: candidateJobId } = env;
  assert.equal(process.platform, 'win32');
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(env.RUNNER_OS, 'Windows');
  assert.equal(env.GITHUB_REPOSITORY, 'Zerozero05/Agent_Resource_Manager');
  assert.equal(env.GITHUB_REF_TYPE, 'branch');
  assert.equal(env.GITHUB_REF_NAME, branch);
  assert.match(env.GITHUB_RUN_ID ?? '', /^\d+$/);
  assert.match(env.GITHUB_RUN_ATTEMPT ?? '', /^\d+$/);
  assert.equal(env.CANDIDATE_SOURCE, sourceCommit);
  assert.equal(env.CANDIDATE_RUN_ID, candidateRunId);
  for (const value of [candidateSha256, originalBuildInfoSha256, candidateArchiveSha256])
    assert.match(value ?? '', sha, 'The exact EXE, archive and original build info must be pinned.');
  for (const value of [candidateJobId, candidateArtifactId]) assert.match(value ?? '', /^[1-9]\d*$/);
  assert.equal(process.argv.length, 5, 'Pass the verified x64 executable, native build-info file, and new evidence directory.');
  assert.ok(isAbsolute(env.RUNNER_TEMP ?? ''), 'The hosted runner temporary root is missing.');

  const [executable, buildInfoPath, evidenceDirectory] = process.argv.slice(2).map(path => resolve(path));
  const runnerTemp = await realpath(env.RUNNER_TEMP);
  assert.ok(inside(runnerTemp, executable) && inside(runnerTemp, evidenceDirectory) && dirname(evidenceDirectory) !== dirname(executable));
  assert.equal(basename(executable), 'agent-resource-manager.exe');
  assert.ok(samePath(buildInfoPath, join(dirname(executable), 'BUILD_INFO.native-validation.json')));
  const binary = await ordinaryFile(executable);
  const peOffset = binary.readUInt32LE(0x3c);
  assert.ok(binary.readUInt16LE(0) === 0x5a4d && binary.readUInt32LE(peOffset) === 0x4550 && binary.readUInt16LE(peOffset + 4) === 0x8664, 'Only the actual Windows x64 app may be observed.');
  assert.equal(digest(binary), candidateSha256);
  const buildInfoBytes = await ordinaryFile(buildInfoPath);
  const buildInfo = JSON.parse(buildInfoBytes);
  assert.equal(buildInfo.sourceCommit, sourceCommit);
  assert.equal(buildInfo.executableSha256, candidateSha256);
  assert.equal(String(buildInfo.workflowRunId), candidateRunId);
  assert.equal(String(buildInfo.workflowRunAttempt), '1');
  assert.equal(buildInfo.repository, env.GITHUB_REPOSITORY);
  assert.equal(buildInfo.originalBuildInfoSha256, originalBuildInfoSha256);
  assert.equal(buildInfo.buildMode, 'release');

  await mkdir(evidenceDirectory);
  assert.ok(samePath(await realpath(evidenceDirectory), evidenceDirectory));
  const report = {
    format: 'agent-resource-manager-hosted-document-body-observer-v2',
    status: 'incomplete',
    provenance: {
      sourceCommit, candidateSha256, candidateRunId, candidateJobId, candidateArtifactId, candidateArchiveSha256,
      originalBuildInfoSha256, buildInfoSha256: digest(buildInfoBytes),
      diagnosticCommit: env.GITHUB_SHA, hostedRunId: env.GITHUB_RUN_ID, imageOs: env.ImageOS, imageVersion: env.ImageVersion,
    },
    scope: 'One fixed warmed synthetic document at its normal initial scroll position, one exact global check per trial, two observers in one native session.',
    limitations: [
      'The pixel endpoint bounds the first observed exact match of a distinctive visible Markdown crop and both document controls. It does not time all Markdown content.',
      'Calibration reports visible candidates without scrolling. If no distinctive body crop is visible, the diagnostic ends before any measured check.',
      'A previous mismatch completion time is an observation timestamp, not a proven lower bound for presentation.',
      'The pixel probe separately requires the original semantic predicate and repeat confirmation. Only samples fully inside a successful check are admitted.',
      'Six warmed trials per observer do not establish a P95, cold opening, or result under other viewport or workload conditions. The original 200 ms criterion remains separate.',
    ],
    plan: { index, samplesPerArm, maxTrials, armOrder },
    attempts: [],
    groupCounts: { uia: 0, pixels: 0 },
    protectedState: null,
    normalExit: false,
  };
  const save = () => writeFile(join(evidenceDirectory, 'document-observer.json'), json(report));
  let app, fixture, baselineState, baselineFiles;
  try {
    await save();
    const before = await assertNoUserManager({ transportSha256: candidateSha256 });
    assert.equal(before.managers.length, 0, 'Expected an empty hosted runner.');
    await mkdir(fixtureParent, { recursive: true });
    assert.ok(samePath(await realpath(fixtureParent), fixtureParent), 'The approved fixture parent is redirected.');
    fixture = await createPerformanceFixture(fixtureParent, 'native-document-observer-' + env.GITHUB_RUN_ID + '-' + env.GITHUB_RUN_ATTEMPT);
    baselineFiles = await protectedFiles(fixture);
    const skillHash = await hashFile(join(fixture.skillsRoot, 'perf-skill-0000', 'SKILL.md'));
    report.fixture = {
      syntheticOnly: fixture.syntheticOnly, skillCount: fixture.skillCount, toolCount: fixture.toolCount,
      fingerprint: fixture.dataFingerprint, descriptorSha256: await hashFile(join(fixture.root, 'dataset.json')),
      sourceSha256: await hashFile(fileURLToPath(new URL('performance-fixture.mjs', import.meta.url))),
      documentSha256: skillHash, diskFileManifestBeforeSha256: baselineFiles,
    };
    assert.equal(report.fixture.fingerprint, 'bd3bb8c680b1b7578d376583ab4b416c88ee47b66ae66b813bee455ca31ba3a1');
    assert.equal(report.fixture.sourceSha256, '770ee3547318be4c8053e595b389726c43868e73e2f9a7b4043341961b16706e');
    const seed = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      const state = JSON.parse(seed.prepare('SELECT payload FROM app_state WHERE id=1').get().payload);
      assert.equal(state.skills.find(skill => skill.id === 'perf-skill-0000').localHashes['SKILL.md'], skillHash);
    } finally {
      seed.close();
    }
    const driverPath = join(fixture.root, 'document-observer-driver.json');
    app = await NativeUiaSession.launch({ executable, sha256: candidateSha256, dataDir: fixture.dataDir, reportPath: driverPath, accessibilityInput: true });
    assert.equal(app.identity.executableSha256, candidateSha256);
    assert.equal(app.identity.readinessMode, 'strict-skill-list');
    assert.ok(app.identity.startupMs > 0 && samePath(app.identity.dataDirectory, fixture.dataDir));
    report.nativeSession = app.identity;
    await ownedWindow(app, 15000);
    await app.call('search', { index });
    await app.call('openDocument', { index });
    report.reference = await app.call('captureDocumentReference', { index });
    assert.ok(Array.isArray(report.reference.bodyObservations), 'Native Markdown elements were not recorded.');
    await save();
    await ownedWindow(app);
    await app.call('closeDocument', { index });
    baselineState = protectedCatalog(fixture);
    if (report.reference.status === 'no-verified-visible-markdown-body-at-open') {
      report.status = 'no-verified-visible-markdown-body-at-open';
      throw new Error('No uniquely identified Markdown body glyph fit the initial native viewport; the document was not scrolled.');
    }
    assert.equal(report.reference.status, 'visible-markdown-body-reference');
    const { body } = report.reference;
    assert.ok(['markdown-h1', 'markdown-h2', 'markdown-paragraph'].includes(body?.kind) && typeof body.name === 'string');
    assert.ok(['native-heading-level', 'rendered-article-anchor', 'exact-paragraph-text'].includes(body.identification));
    for (const value of [...['titleBounds', 'selectedTabBounds', 'windowBounds', 'viewportBounds', 'captureBounds'].map(key => report.reference[key]), body.bounds])
      assert.ok(Array.isArray(value) && value.length === 4 && value.every(Number.isSafeInteger) &&
        value[2] > 0 && value[3] > 0, 'The exact native pixel reference geometry is incomplete.');
    for (const key of ['titleSha256', 'tabSha256', 'bodySha256']) assert.match(report.reference[key], sha);
    await save();

    const seenChecks = new Set();
    const deadline = Date.now() + 180000;
    for (let trial = 0; trial < maxTrials && Date.now() < deadline; trial++) {
      const preferred = armOrder[trial % armOrder.length];
      const other = preferred === 'uia' ? 'pixels' : 'uia';
      const arm = report.groupCounts[preferred] < samplesPerArm ? preferred : other;
      if (report.groupCounts[arm] >= samplesPerArm) break;
      const attempt = { trial: trial + 1, arm, admitted: false };
      report.attempts.push(attempt);
      const id = await startCheck(app, seenChecks);
      attempt.taskId = id;
      await waitCheck(app, id, task => task.status !== 'queued', 8000);
      await ownedWindow(app);
      attempt.before = await readCheck(app, id);
      if (attempt.before.status === 'running') {
        attempt.sample = await app.call(arm === 'uia' ? 'openDocument' : 'openDocumentPixels', { index });
        attempt.after = await readCheck(app, id);
        validateSample(attempt.sample, app.identity, arm, report.reference);
        await ownedWindow(app);
      }
      attempt.completed = await waitCheck(app, id, task => task.status === 'succeeded', 20000, attempt.after);
      if (attempt.sample) {
        attempt.overlap = overlap(attempt);
        if (attempt.overlap.fullSample) {
          attempt.admitted = true;
          report.groupCounts[arm]++;
        }
        await ownedWindow(app);
        await app.call('closeDocument', { index });
      }
      await save();
    }
    assert.deepEqual(report.groupCounts, { uia: samplesPerArm, pixels: samplesPerArm }, 'The bounded run did not collect six fully overlapped samples per observer.');
    report.status = 'measurements-collected';
  } catch (error) {
    report.error = error.message;
  } finally {
    if (app) {
      let driver;
      try {
        driver = (await app.quit()).driverReport;
      } catch (error) {
        report.exitError = error.message;
        driver = app.driverReport;
      }
      try {
        if (driver) {
          await writeFile(join(evidenceDirectory, 'native-driver.json'), json(driver), { flag: 'wx' });
          assert.equal(driver.pid, app.identity.pid);
          assert.equal(driver.creationFileTime, app.identity.creationFileTime);
          assert.equal(driver.windowHandle, app.identity.windowHandle);
          assert.equal(driver.executableSha256, candidateSha256);
          assert.equal(driver.datasetDescriptorSha256, report.fixture.descriptorSha256);
          assert.equal(driver.closedNormally, true);
          report.normalExit = true;
        }
      } catch (error) {
        report.exitError ??= error.message;
      }
    }
    try {
      if (baselineFiles) {
        const diskFileManifestAfterSha256 = await protectedFiles(fixture);
        const catalogAfter = baselineState && report.normalExit ? protectedCatalog(fixture) : null;
        const catalogBeforeSha256 = baselineState ? digest(json(baselineState)) : null;
        const catalogAfterSha256 = catalogAfter ? digest(json(catalogAfter)) : null;
        report.protectedState = { diskFileManifestAfterSha256, catalogBeforeSha256, catalogAfterSha256,
          filesUnchanged: diskFileManifestAfterSha256 === baselineFiles,
          catalogUnchanged: catalogAfterSha256 !== null && catalogAfterSha256 === catalogBeforeSha256 };
      }
      assert.equal(await hashFile(executable), candidateSha256);
      assert.equal(await hashFile(buildInfoPath), report.provenance.buildInfoSha256);
    } catch (error) {
      report.readbackError = error.message;
    }
    if (report.status === 'measurements-collected') {
      report.status = report.normalExit && report.protectedState?.filesUnchanged && report.protectedState?.catalogUnchanged &&
        !report.exitError && !report.readbackError ? 'paired-observers-observed' : 'incomplete';
    }
    const admitted = report.attempts.filter(attempt => attempt.admitted);
    const summarize = values => {
      if (!values.length) return null;
      const sorted = values.sort((left, right) => left - right);
      const lower = sorted[Math.floor((sorted.length - 1) / 2)], upper = sorted[Math.ceil((sorted.length - 1) / 2)];
      return { count: sorted.length, minMs: sorted[0], medianMs: (lower + upper) / 2, maxMs: sorted.at(-1) };
    };
    report.results = {
      originalUiaMs: summarize(admitted.filter(attempt => attempt.arm === 'uia').map(attempt => attempt.sample.durationMs)),
      firstVisibleMarkdownAndControlsUpperMs: summarize(admitted.filter(attempt => attempt.arm === 'pixels').map(attempt => attempt.sample.pixels.firstMatchUpperMs)),
      pixelObserverWithSemanticConfirmationMs: summarize(admitted.filter(attempt => attempt.arm === 'pixels').map(attempt => attempt.sample.durationMs)),
    };
    report.finishedAt = new Date().toISOString();
    await save();
  }
  console.log(JSON.stringify({ status: report.status, groupCounts: report.groupCounts, normalExit: report.normalExit }));
  if (report.status !== 'paired-observers-observed') process.exitCode = 1;
}

await run();
