import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { IDLE_OBSERVER, idleObservation } from './diagnose-native-idle-memory.mjs';
import { assertNoUserManager, NativeUiaSession } from './native-uia-client.mjs';
import { createPerformanceFixture } from './performance-fixture.mjs';
import { referenceObservationRows, validBox, VisualSession } from './verify-native-visual-stability.mjs';

const execute = promisify(execFile);
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
const saveJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const sleep = delay => new Promise(done => setTimeout(done, Math.max(0, delay)));
const until = time => sleep(time - performance.now());
const approved = 'D:/03_github_projects/Agent_Management/Agent_Resource_Manager/validation/manager-data';
const relativeScript = name => fileURLToPath(new URL(name, import.meta.url));
const source = '2314ea88080a401be1acfa150d029f1a928b99aa';
const candidateRun = '44862742843';
const skillId = 'perf-skill-0000';
const skillTitle = 'Perf Skill 0000';
const paragraph = '仅用于隔离的本地性能验收，不调用外部程序，不连接远端。';
const tabScope = '工作区标签';
const actions = ['open', 'home', 'document', 'close'];
const policy = { cycles: 40, slotMs: 1500, waitBeforeTrainMs: 15000, sampleOffsetsMs: [0, 10000, 20000] };

function boxAt(bounds, frame) {
  const [x, y, width, height] = bounds.split(',').map(Number);
  const left = Math.floor(x) - frame.left;
  const top = Math.floor(y) - frame.top;
  const box = [left, top, Math.ceil(x + width) - frame.left - left, Math.ceil(y + height) - frame.top - top];
  assert.ok(validBox(box, frame), 'Required calibration control does not fit the owned view.');
  return box;
}

function center([x, y, width, height]) {
  return { x: x + Math.floor(width / 2), y: y + Math.floor(height / 2) };
}

function readWorkspace(statement) {
  const row = statement.get();
  if (!row) return { revision: -1, active: 'home', detail: null };
  const { revision, windows } = JSON.parse(row.payload);
  assert.ok(Number.isSafeInteger(revision) && revision >= 0);
  assert.equal(windows.length, 1);
  const { label, activePaneId, panes, splitView } = windows[0];
  assert.equal(label, 'main');
  assert.equal(splitView, undefined);
  assert.ok(panes.length >= 1 && panes.length <= 2);
  const home = panes.find(pane => pane.kind === 'home');
  assert.equal(home?.id, 'home');
  const detail = panes.find(pane => pane.kind === 'detail');
  if (panes.length === 2) {
    assert.equal(detail?.skillId, skillId);
    assert.equal(detail.title, skillTitle);
    assert.equal(detail.state.section, 'docs');
  }
  assert.ok(activePaneId === home.id || activePaneId === detail?.id);
  return { revision, active: activePaneId === home.id ? 'home' : 'document', detail: detail?.id ?? null };
}

async function verifyAction(openWorkspace, visual, point, action, deadline) {
  const before = openWorkspace();
  const input = await visual.call('click', point);
  do {
    const after = openWorkspace();
    const sameDocument = after.detail === before.detail;
    const expected = {
      open: before.active === 'home' && before.detail === null && after.active === 'document' && after.detail !== null,
      home: before.active === 'document' && after.active === 'home' && sameDocument,
      document: before.active === 'home' && after.active === 'document' && sameDocument,
      close: before.active === 'document' && after.active === 'home' && after.detail === null,
    }[action];
    if (after.revision > before.revision && expected) return { before, after, input };
    if (after.revision > before.revision && (after.active !== before.active || !sameDocument)) {
      throw new Error('Physical click changed the workspace to an unexpected selection. No input was replayed.');
    }
    await sleep(40);
  } while (performance.now() < deadline);
  throw new Error('Physical ' + action + ' did not persist the expected workspace transition. No input was replayed.');
}

async function match(visual, region) {
  const deadline = performance.now() + 15000;
  let stable = 0;
  do {
    stable = (await visual.call('match', region)).matched ? stable + 1 : 0;
    if (stable === 2) return;
    await sleep(50);
  } while (performance.now() < deadline);
  throw new Error('The frozen owned calibration landmark did not match. No adaptive reference was used.');
}

async function environment(dataset) {
  const temporary = join(dataset.root, 'temp');
  await mkdir(temporary);
  const env = { ...process.env, TEMP: temporary, TMP: temporary };
  for (const key of Object.keys(env)) {
    if (/^(GH_TOKEN|GITHUB_TOKEN|SKILL_MANAGER_DATA_DIR|WEBVIEW2_(USER_DATA_FOLDER|ADDITIONAL_BROWSER_ARGUMENTS|WAIT_FOR_SCRIPT_DEBUGGER|PIPE_FOR_SCRIPT_DEBUGGER))$/i.test(key)) delete env[key];
  }
  return env;
}

async function runPowerShell(script, args, env, timeout = 20000) {
  const pending = execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', script, ...args], { env, windowsHide: true, timeout, maxBuffer: 256 * 1024 });
  pending.child.stdin.end();
  return JSON.parse((await pending).stdout.trim());
}

async function calibrate(dataset, context) {
  const { executable, sha256, frame, root, calibration } = context;
  const env = await environment(dataset);
  const db = new DatabaseSync(dataset.dbPath, { readOnly: true });
  const query = db.prepare('SELECT payload FROM workspace_state WHERE id=1');
  const workspace = () => readWorkspace(query);
  let app, visual, failure;
  try {
    calibration.stage = 'launch-isolated-reference-session';
    app = await NativeUiaSession.launch({ executable, sha256, dataDir: dataset.dataDir, reportPath: join(root, 'calibration-driver.json') });
    visual = await VisualSession.attach(app.identity, { root }, env, frame, executable);
    assert.equal(visual.identity.dpi, frame.dpi);
    await visual.call('prepareForeground');
    calibration.identity = visual.identity;
    const rows = (name, scope, deadline) => {
      const referenceReadBudgetMs = Math.floor(deadline - performance.now());
      assert.ok(referenceReadBudgetMs > 0);
      const scoped = scope ? { scope, referenceAllowPendingScope: true } : {};
      return app.call('state', { name, ...scoped, referenceReadBudgetMs }, referenceReadBudgetMs).then(referenceObservationRows);
    };
    async function element(name, scope, type, selected) {
      const deadline = performance.now() + 15000;
      do {
        const observed = (await rows(name, scope, deadline)).filter(row => row.type === type);
        calibration.lastNamedObservation = { name, scope, observed };
        const available = observed.filter(row => row.enabled && !row.offscreen);
        assert.ok(available.length <= 1, 'Ambiguous calibration control ' + name);
        if (available.length === 1 && (selected === undefined || available[0].selected === selected)) return available[0];
        await sleep(75);
      } while (performance.now() < deadline);
      throw new Error('Required native calibration control was not visibly presented: ' + name);
    }
    const rect = async (...selection) => boxAt((await element(...selection)).bounds, frame);
    const buttons = 'ControlType.Button';
    const tabs = 'ControlType.TabItem';
    async function freeze(name, box) {
      const path = join(root, name + '.png');
      await visual.call('save', { path, box });
      const roi = { path, box, sha256: await digest(path) };
      await match(visual, roi);
      return roi;
    }

    calibration.stage = 'verify-first-physical-search';
    const search = center(await rect('搜索 Skill', null, 'ControlType.Edit'));
    await visual.call('click', search);
    await visual.call('text', { value: skillId });
    const title = await rect(skillTitle, '可横向滚动的 Skill 列表', buttons);
    const searchValue = await app.call('firstSearchValue', { referenceReadBudgetMs: 12000 }, 12000);
    assert.equal(searchValue.matchesExpected, true);
    const result = await freeze('filtered-result', title);
    const open = center(title);
    calibration.stage = 'verify-persisted-open';
    calibration.openTransition = await verifyAction(workspace, visual, open, 'open', performance.now() + 12000);
    calibration.stage = 'wait-visible-selected-workspace-tab';
    calibration.selectedDetail = await element(skillTitle, tabScope, tabs, true);
    const document = center(boxAt(calibration.selectedDetail.bounds, frame));
    calibration.stage = 'wait-visible-selected-description';
    calibration.selectedDescription = await element('说明', 'Skill 详情', tabs, true);
    calibration.stage = 'freeze-visible-document-paragraph';
    const body = await freeze('document-body', await rect(paragraph, null, 'ControlType.Text'));
    calibration.stage = 'locate-exact-home-and-close-controls';
    const names = referenceObservationRows(await app.call('names', { referenceReadBudgetMs: 12000 }, 12000));
    const homeNames = [...new Set(names.filter(row => row.type === tabs && (row.name === '工作台' || row.name.startsWith('工作台 '))).map(row => row.name))];
    assert.equal(homeNames.length, 1);
    const home = center(await rect(homeNames[0], tabScope, tabs, false));
    const close = center(await rect('关闭 ' + skillTitle, null, buttons));

    calibration.points = { search, open, home, document, close };
    calibration.landmarks = { result, body };
    for (const action of ['home', 'document', 'close']) {
      calibration.stage = 'verify-calibration-' + action;
      await verifyAction(workspace, visual, calibration.points[action], action, performance.now() + 12000);
      if (action === 'document') await match(visual, body);
      if (action === 'close') await match(visual, result);
    }
    calibration.stage = 'complete';
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    if (visual) await visual.finish().catch(error => cleanupErrors.push(error.message));
    db.close();
    if (app) {
      let receipt;
      try {
        ({ driverReport: receipt } = await app.quit());
      } catch (error) {
        cleanupErrors.push(error.message);
        receipt = app.driverReport;
      }
      calibration.normalExit = receipt?.closedNormally === true && receipt.pid === app.identity.pid
        && receipt.creationFileTime === app.identity.creationFileTime && receipt.windowHandle === app.identity.windowHandle
        && receipt.executableSha256 === sha256 && receipt.dataDirectory?.toLowerCase() === dataset.dataDir.toLowerCase();
      calibration.quit = { driverStatus: receipt?.status, recoveryUsed: receipt?.recoveryExitUsedInvoke === true, closeError: receipt?.closeError };
      if (!calibration.normalExit) cleanupErrors.push('Calibration did not prove exact normal exit.');
    }
    if (cleanupErrors.length) {
      calibration.cleanupErrors = cleanupErrors;
      if (!failure) throw new Error(cleanupErrors.join(' / '));
    }
  }
}

async function attachObserver(identity, executable, env) {
  const { pid, creationFileTime, windowHandle } = identity;
  const child = spawn('pwsh.exe', ['-NoProfile', '-NonInteractive', '-MTA', '-File', relativeScript('observe-physical-memory-uia.ps1'), '-Spec', encode({ pid, creationFileTime, windowHandle, executable })], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const observer = new VisualSession(child);
  const deadline = setTimeout(() => { observer.readyReject(new Error('Separate read-only observer did not become ready.')); child.stdin.end(); }, 15000);
  try {
    const ready = await observer.ready;
    for (const key of ['pid', 'creationFileTime', 'windowHandle']) assert.equal(ready[key], identity[key]);
    assert.equal(ready.readOnly, true);
    return observer;
  } finally { clearTimeout(deadline); }
}

async function measure(dataset, context, arm, observeUia, checkpoint) {
  const { executable, sha256, root, frame, calibration } = context;
  const { points, landmarks } = calibration;
  const env = await environment(dataset);
  const { managers } = await assertNoUserManager({ transportSha256: sha256 });
  assert.deepEqual(managers, []);
  const child = spawn(executable, ['--data-dir', dataset.dataDir], { cwd: dirname(executable), env, stdio: 'ignore' });
  let exit, identity, visual, observer, db, mainFailure;
  const exited = new Promise(done => {
    child.once('exit', (code, signal) => { exit = { code, signal }; done(exit); });
  });
  const numeric = (spec, mode) => runPowerShell(join(root, 'numeric-observer.ps1'), ['-Mode', mode, '-Spec', encode({ ...spec, executable, dataDir: dataset.dataDir })], env);
  try {
    arm.stage = 'start';
    await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); });
    const deadline = performance.now() + 45000;
    do {
      const status = await numeric({ pid: child.pid }, 'status');
      if (status.ok) {
        assert.equal(status.identity.pid, child.pid);
        assert.equal(status.dataDir.toLowerCase(), dataset.dataDir.toLowerCase());
        identity = status.identity;
        break;
      }
      assert.equal(status.errorType, 'TimeoutException');
      assert.equal(exit, undefined);
      await sleep(150);
    } while (performance.now() < deadline);
    assert.ok(identity, 'Exact synthetic backend readiness expired.');
    visual = await VisualSession.attach(identity, { root }, env, frame, executable);
    assert.equal(visual.identity.dpi, frame.dpi);
    arm.identity = visual.identity;
    arm.stage = 'prepare-identical-physical-search';
    await visual.call('prepareForeground');
    db = new DatabaseSync(dataset.dbPath, { readOnly: true });
    const query = db.prepare('SELECT payload FROM workspace_state WHERE id=1');
    const workspace = () => readWorkspace(query);
    await visual.call('click', points.search);
    await visual.call('text', { value: skillId });
    await match(visual, landmarks.result);
    for (const action of actions) {
      await verifyAction(workspace, visual, points[action], action, performance.now() + 12000);
      if (action === 'open') await match(visual, landmarks.body);
      if (action === 'close') await match(visual, landmarks.result);
    }
    async function sample(phase, offsetMs) {
      const before = await visual.call('identity');
      const raw = await numeric(identity, 'sample');
      const after = await visual.call('identity');
      assert.equal(raw.inputTickBefore, before.lastInputTick);
      assert.equal(raw.lastInputTick, after.lastInputTick);
      const sample = idleObservation(raw, identity, cpus().length);
      const browsers = sample.ownedProcesses.filter(row => row.role === 'webview-browser');
      assert.equal(browsers.length, 1);
      const browser = browsers[0];
      const browserIdentity = { pid: browser.pid, creationFileTime: browser.creationFileTime };
      if (arm.browser) assert.deepEqual(arm.browser, browserIdentity);
      else arm.browser = browserIdentity;
      arm.samples.push({ phase, offsetMs, browserPrivateBytes: browser.privateBytes, ...sample });
      await checkpoint();
    }
    arm.stage = 'baseline';
    await sample('baseline', null);
    const start = performance.now() + policy.waitBeforeTrainMs;
    if (observeUia) {
      observer = await attachObserver(arm.identity, executable, env);
      arm.observerIdentity = observer.identity;
    }
    assert.ok(performance.now() < start, 'Optional observer could not attach within the common preparation interval.');

    arm.stage = 'same-fixed-timing-physical-clicks';
    for (let cycle = 0; cycle < policy.cycles; cycle++) {
      for (const [index, action] of actions.entries()) {
        const due = start + (cycle * actions.length + index) * policy.slotMs;
        await until(due);
        const dispatched = performance.now();
        assert.ok(dispatched - due <= 150, 'Physical action missed its shared dispatch tolerance.');
        const transition = await verifyAction(workspace, visual, points[action], action, due + policy.slotMs);
        await until(due + 250);
        const uia = observer ? await observer.call('read') : null;
        if (uia) {
          for (const key of ['pid', 'creationFileTime', 'windowHandle']) assert.equal(uia[key], arm.identity[key]);
          assert.equal(uia.workspaceScopeCount, 1);
          assert.equal(uia.tabCount, transition.after.detail === null ? 1 : 2);
          assert.equal(uia.selectedTabCount, 1);
          assert.equal(uia.workbenchSelected, transition.after.active === 'home');
          assert.equal(uia.fixtureDocumentSelected, transition.after.active === 'document');
        }
        assert.ok(performance.now() < due + policy.slotMs, 'Observation exceeded the shared action slot.');
        arm.trace.push({ cycle, action, dispatchDelayMs: dispatched - due, finishedMsWithinSlot: performance.now() - due, transition, uia });
      }
      if ((cycle + 1) % 10 === 0) {
        await checkpoint();
        console.log(JSON.stringify({ phase: arm.name, cycles: cycle + 1, of: policy.cycles }));
      }
    }
    arm.stage = 'post-train-idle';
    const end = start + policy.cycles * actions.length * policy.slotMs;
    for (const offset of policy.sampleOffsetsMs) {
      await until(end + offset);
      assert.ok(performance.now() - end - offset <= 350, 'Numeric memory observation missed its common start tolerance.');
      await sample('post-train', offset);
    }
    arm.stage = 'samples-complete';
  } catch (error) {
    mainFailure = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    if (observer) await observer.finish().catch(error => cleanupErrors.push(error.message));
    if (visual) await visual.finish().catch(error => cleanupErrors.push(error.message));
    if (db) db.close();
    if (identity && !exit) {
      try {
        arm.quit = await runPowerShell(relativeScript('quit-physical-memory-session.ps1'), ['-Spec', encode({ ...identity, windowHandle: arm.identity?.windowHandle, executable, sha256 })], env, 45000);
        assert.equal(arm.quit.exited, true);
        assert.equal(arm.quit.exitCode, 0);
        assert.equal((await exited).code, 0);
      } catch (error) { cleanupErrors.push(error.message); }
    }
    arm.normalExit = exit?.code === 0 && arm.quit?.exited === true;
    if (!exit) child.unref();
    if (cleanupErrors.length) {
      arm.cleanupErrors = cleanupErrors;
      if (!mainFailure) throw new Error(cleanupErrors.join(' / '));
    }
    assert.ok(mainFailure || arm.normalExit, 'Owned measured session did not verify normal exit.');
  }
}

async function main() {
  assert.equal(process.platform, 'win32');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(process.env.GITHUB_REPOSITORY?.toLowerCase(), 'zerozero05/agent_resource_manager');
  assert.equal(process.env.GITHUB_REF_NAME, 'codex/hosted-physical-memory-2314ea8-r2-20261121');
  const [givenExe, givenInfo, sha256, artifactId, frameJson, reportPath] = process.argv.slice(2);
  assert.match(sha256, /^[a-f0-9]{64}$/);
  assert.match(artifactId, /^\d+$/);
  const executable = await realpath(givenExe);
  const buildPath = await realpath(givenInfo);
  assert.equal(executable.toLowerCase(), resolve(process.env.RUNNER_TEMP, 'arm-native-performance', 'agent-resource-manager.exe').toLowerCase());
  assert.equal(buildPath.toLowerCase(), resolve(dirname(executable), 'BUILD_INFO.native-validation.json').toLowerCase());
  assert.equal(resolve(reportPath).toLowerCase(), resolve(process.env.RUNNER_TEMP, 'arm-physical-memory.json').toLowerCase());
  const frame = JSON.parse(frameJson);
  assert.deepEqual(frame, { left: 60, top: 60, width: 960, height: 650, dpi: 96 });
  const firstSearch = {
    run: process.env.FIRST_SEARCH_RUN_ID,
    head: process.env.FIRST_SEARCH_HEAD,
    artifactId: process.env.FIRST_SEARCH_ARTIFACT_ID,
    archiveSha256: process.env.FIRST_SEARCH_ARCHIVE_SHA256,
    independentlyVerifiedReceiptSha256: process.env.FIRST_SEARCH_REPORT_SHA256,
  };
  assert.equal(firstSearch.run, '44864093902');
  assert.equal(firstSearch.head, '7afeb8841d90ba055577fbb3590b094835707a1f');
  assert.match(firstSearch.artifactId, /^\d+$/);
  assert.match(firstSearch.archiveSha256, /^[a-f0-9]{64}$/);
  assert.match(firstSearch.independentlyVerifiedReceiptSha256, /^[a-f0-9]{64}$/);
  const build = JSON.parse(await readFile(buildPath, 'utf8'));
  assert.equal(build.sourceCommit, source);
  assert.equal(String(build.workflowRunId), candidateRun);
  assert.equal(Number(build.workflowRunAttempt), 1);
  assert.equal(build.repository.toLowerCase(), process.env.GITHUB_REPOSITORY.toLowerCase());
  assert.equal(build.buildMode, 'release');
  assert.equal(build.version, '0.3.0-dev.1');
  assert.equal(build.executableSha256, sha256);
  assert.equal(await digest(executable), sha256);
  await mkdir(approved, { recursive: true });
  assert.ok(!(await lstat(approved)).isSymbolicLink());
  assert.equal((await realpath(approved)).toLowerCase(), resolve(approved).toLowerCase());
  const root = await mkdtemp(join(approved, 'native-visual-'));
  await writeFile(join(root, 'numeric-observer.ps1'), IDLE_OBSERVER, { flag: 'wx' });
  const report = {
    format: 'agent-resource-manager-hosted-paired-physical-memory-v1',
    status: 'running', syntheticOnly: true, source, candidateRun, artifactId, sha256, firstSearch, frame, policy,
    startedAt: new Date().toISOString(), calibration: {}, arms: [],
    limitations: ['This matched document-switch subset does not replace the original thirty-minute run, UIA regression, visual review, pilot, or convergence gate.', 'The independent observer attaches after baseline and stays alive through the last sample. A new owned Quit UIA client is used only after each measured arm ends.', 'One ordered pair on a single hosted runner. Results cannot establish a general machine-independent cause.'],
  };
  const checkpoint = () => saveJson(reportPath, report);
  const context = { root, executable, sha256, frame, calibration: report.calibration };
  await checkpoint();
  try {
    const [reference, control, exposed] = await Promise.all(['calibration', 'physical-control', 'physical-with-uia'].map(name => createPerformanceFixture(root, name)));
    for (const dataset of [control, exposed]) assert.equal(dataset.dataFingerprint, reference.dataFingerprint);
    report.fixture = { sha256: reference.dataFingerprint, skills: reference.skillCount, tools: reference.toolCount };
    await calibrate(reference, context);
    await checkpoint();
    for (const [dataset, observeUia] of [[control, false], [exposed, true]]) {
      const arm = { name: observeUia ? 'physical-with-uia' : 'physical-control', observeUia, trace: [], samples: [] };
      report.arms.push(arm);
      await checkpoint();
      await measure(dataset, context, arm, observeUia, checkpoint);
      await checkpoint();
    }
    const [first, second] = report.arms;
    const signature = arm => arm.trace.map(({ cycle, action, transition }) => [cycle, action, transition.after.active, transition.after.detail !== null]);
    assert.equal(first.trace.length, policy.cycles * actions.length);
    assert.deepEqual(signature(first), signature(second));
    assert.equal(first.trace.filter(item => item.uia !== null).length, 0);
    assert.equal(second.trace.filter(item => item.uia !== null).length, second.trace.length);
    assert.equal(await digest(executable), sha256);
    const deltas = arm => arm.samples.slice(1).map(sample => ({
      offsetMs: sample.offsetMs,
      browserPrivateBytes: sample.browserPrivateBytes - arm.samples[0].browserPrivateBytes,
      processFamilyPrivateBytes: sample.privateBytes - arm.samples[0].privateBytes,
    }));
    report.memoryDeltas = Object.fromEntries(report.arms.map(arm => [arm.name, deltas(arm)]));
    report.status = 'paired-diagnostic-completed';
    report.previousFailureReplaced = false;
  } catch (error) {
    report.status = 'failed-or-blocked';
    report.error = error.message;
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await checkpoint();
    console.log(JSON.stringify({ status: report.status, reportPath }));
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
