import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeUiaSession } from './native-uia-client.mjs';
import { createPerformanceFixture, FIXTURE_FORMAT } from './performance-fixture.mjs';

const format = 'agent-resource-manager-native-keyboard-v1';
const parent = 'D:\\03_github_projects\\Agent_Management\\Agent_Resource_Manager\\validation\\manager-data';
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, flag, index, all) => flag.startsWith('--') ? [...pairs, [flag.slice(2), all[index + 1]]] : pairs, []));
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const same = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase();
const inside = (path, root) => { const part = relative(root, path); return part === '' || !part.startsWith('..') && !isAbsolute(part); };
const sleep = ms => new Promise(done => setTimeout(done, ms));
const limitations = [
  'Real Ctrl+K, Space routing, Escape, input Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z in one owned native window only. No performance or complete-plan claim.',
  'Ordinary text is sent through the existing guarded SendInput Unicode path. Chinese IME composition, phonetic candidates and IME Enter behavior are not tested.',
  'Each replacement contains one character, so exact undo assertions cover one native input event. Multi-character SendInput batches do not define a single browser undo transaction.',
  'One synthetic Skill is intentionally favorited through its ordinary UI to create a real available management undo. Input undo must preserve that favorite and produce no additional tasks.',
  'The initial management-data read and the first palette resource-catalogue read are verified separately as ordinary read-only UI requests, with their exact origins and successful completion.',
  'The same driver makes one owned-window foreground preparation attempt without keyboard or mouse input. The original desktop-input tick must remain unchanged. No clipboard, external input sender, preview, installation, permission grant, backup, cleanup or database write shortcut is used.',
];

function stored(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload); }
  finally { db.close(); }
}
async function wait(read, accepts, description, milliseconds = 20000) {
  const started = Date.now(); let attempts = 0;
  for (;;) {
    const value = await read(); attempts++;
    if (accepts(value)) return value;
    assert.ok(Date.now() - started < milliseconds, `${description} unavailable after ${attempts} read-only observations. Last value ${JSON.stringify(value).slice(0, 2000)}. No action was replayed.`);
    await sleep(60);
  }
}
async function button(app, name, scope) {
  if (scope) await wait(() => app.call('state', { name: scope }), rows => list(rows).filter(row => row.enabled && !row.offscreen).length === 1, `Exact scope ${scope}`);
  await wait(() => app.call('state', { name, ...(scope ? { scope } : {}) }), rows => list(rows).filter(row => row.type === 'ControlType.Button' && row.enabled && !row.offscreen).length === 1, `Exact button ${name}`);
  await app.call('invokeName', { name, ...(scope ? { scope } : {}) });
}
async function prepare() {
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'native-keyboard-'));
  const dataset = await createPerformanceFixture(root, 'keyboard-fixture', 0);
  const fixture = { format, syntheticOnly: true, root, dataset, initialDatabaseSha256: await digest(dataset.dbPath), createdAt: new Date().toISOString() };
  await writeFile(join(root, 'keyboard-fixture.json'), json(fixture), { flag: 'wx' });
  return fixture;
}
async function fixtureAt(path) {
  const descriptor = resolve(path), fixture = JSON.parse(await readFile(descriptor, 'utf8'));
  assert.equal(fixture.format, format); assert.equal(fixture.syntheticOnly, true);
  assert.ok(same(dirname(descriptor), fixture.root) && inside(fixture.root, parent));
  const dataset = fixture.dataset; assert.equal(dataset.format, FIXTURE_FORMAT);
  assert.ok(same(dataset.root, join(fixture.root, 'keyboard-fixture')) && same(dataset.dataDir, join(dataset.root, 'data')) && same(dataset.dbPath, join(dataset.dataDir, 'manager.sqlite3')));
  for (const directory of [fixture.root, dataset.root, dataset.dataDir, dataset.skillsRoot]) assert.ok(same(await realpath(directory), directory));
  const marker = JSON.parse(await readFile(join(dataset.root, 'fixture-owner.json'), 'utf8')); assert.equal(marker.format, FIXTURE_FORMAT); assert.equal(marker.syntheticOnly, true);
  assert.equal(await digest(dataset.dbPath), fixture.initialDatabaseSha256, 'A previously launched keyboard fixture may not be replayed.');
  return fixture;
}
function taskSummary(value) {
  assert.ok(Array.isArray(value.tasks));
  return value.tasks.map(task => ({ id: task.id, action: task.action, status: task.status })).sort((left, right) => left.id.localeCompare(right.id));
}

if (process.argv.includes('--help')) {
  console.log('Prepare --phase prepare. Run --phase run --fixture <keyboard-fixture.json> --candidate <release.exe> --candidate-build-info <json> [--await-foreground-seconds 60]. Real owned-window shortcuts and input undo only. The driver prepares its exact owned window once without keyboard or mouse input, verifies the unchanged input tick and foreground identity, then clicks only its exact edit. No IME composition or performance claim.');
  process.exit(0);
}
assert.ok(['prepare', 'run'].includes(args.phase), 'Use explicit --phase prepare or --phase run.');
if (args.phase === 'prepare') { const fixture = await prepare(); console.log(JSON.stringify({ status: 'prepared-not-run', fixture: join(fixture.root, 'keyboard-fixture.json'), noNativeLaunch: true })); process.exit(0); }
const foregroundSeconds = args['await-foreground-seconds'] === undefined ? 60 : Number(args['await-foreground-seconds']);
assert.ok(Number.isInteger(foregroundSeconds) && foregroundSeconds >= 1 && foregroundSeconds <= 120);
const fixture = await fixtureAt(args.fixture || '');
const executable = resolve(args.candidate || ''), info = JSON.parse(await readFile(resolve(args['candidate-build-info'] || ''), 'utf8'));
assert.equal(basename(executable), 'agent-resource-manager.exe'); assert.equal(info.buildMode, 'release'); assert.equal(await digest(executable), info.executableSha256); assert.ok(info.sourceIdentity || info.sourceCommit);
const original = stored(fixture.dataset.dbPath);
assert.equal(original.skills.length, 1000); assert.deepEqual(original.sources, []); assert.deepEqual(original.localRoots, []); assert.deepEqual(original.connections, []);
const reportPath = join(fixture.root, 'keyboard-result.json');
const report = { format, status: 'running', syntheticOnly: true, startedAt: new Date().toISOString(), fixture: fixture.root, candidate: { executable, sha256: info.executableSha256, sourceIdentity: info.sourceIdentity || info.sourceCommit }, limitations, steps: [], results: { imeCompositionVerified: false } };
report.harness = await Promise.all(['verify-native-keyboard.mjs', 'native-uia-client.mjs', 'verify-native-uia.ps1', 'performance-fixture.mjs'].map(async name => ({ name, sha256: await digest(fileURLToPath(new URL(name, import.meta.url))) })));
await writeFile(reportPath, json(report), { flag: 'wx' });
function step(name) { report.currentStep = name; report.steps.push({ name, startedAt: new Date().toISOString() }); }
let app;
try {
  step('launch-native-workbench');
  app = await NativeUiaSession.launch({ executable, sha256: info.executableSha256, dataDir: fixture.dataset.dataDir, reportPath: join(fixture.dataset.root, 'native-driver.json'), accessibilityInput: true, workbenchOnlyReadiness: true, keyboardInput: true });
  report.native = app.identity; assert.equal(app.identity.functionalKeyboardInputRequested, true);
  step('seed-real-available-management-undo');
  await button(app, 'Skills', '主要导航');
  await wait(() => app.call('state', { name: '搜索 Skill' }), rows => list(rows).filter(row => row.type === 'ControlType.Edit' && row.enabled && !row.offscreen).length === 1, 'Skills search input');
  await app.call('search', { index: 1 });
  assert.equal(original.skills.find(skill => skill.id === 'perf-skill-0001').favorite, false);
  await button(app, '收藏 Perf Skill 0001');
  await wait(() => stored(fixture.dataset.dbPath), state => state.skills.find(skill => skill.id === 'perf-skill-0001').favorite === true, 'Actual UI favorite persisted');
  const undoBefore = await wait(() => app.call('state', { name: '撤销管理操作' }), rows => list(rows).filter(row => row.type === 'ControlType.Button' && row.enabled && !row.offscreen).length === 1, 'Real management undo available before input editing');
  report.results.managementUndoBeforeInput = undoBefore;
  const tasksBefore = await wait(() => app.call('tasks'), value => {
    const tasks = value.tasks || [];
    const favorite = tasks.filter(task => task.action === 'set_favorite');
    const managementRead = tasks.filter(task => task.action === 'management_data');
    return tasks.length === 2 && favorite.length === 1 && managementRead.length === 1
      && tasks.every(task => task.status === 'succeeded' && task.origin?.paneId === 'home' && task.origin?.windowLabel === 'main')
      && favorite[0].origin?.skillId === 'perf-skill-0001';
  }, 'One completed exact-origin UI favorite and the initial management-data read');
  const stateBefore = stored(fixture.dataset.dbPath);
  report.results.tasksBeforeInput = taskSummary(tasksBefore);
  step('prepare-exact-owned-foreground-without-input');
  report.results.foregroundPreparation = await app.call('prepareKeyboardForeground');
  assert.equal(report.results.foregroundPreparation.inputTickBefore, report.results.foregroundPreparation.inputTickAfter);
  assert.equal(report.results.foregroundPreparation.sentKeyboardOrMouseInput, false);
  step('await-exact-owned-foreground');
  console.log(JSON.stringify({ event: 'await-owned-foreground', pid: app.identity.pid, windowHandle: app.identity.windowHandle, seconds: foregroundSeconds }));
  report.results.foreground = await wait(() => app.call('windowIdentity'), identity => identity.capturedHandle === app.identity.windowHandle && identity.currentMainHandle === app.identity.windowHandle && identity.uiaProcessId === app.identity.pid && identity.foregroundHandle === app.identity.windowHandle, 'Exact owned foreground window', foregroundSeconds * 1000);
  const fieldName = '搜索 Skill', first = 'a', second = 'b';
  step('ordinary-native-keyboard-edit');
  report.results.firstEdit = await app.call('keyboardEdit', { name: fieldName, value: first });
  report.results.secondEdit = await app.call('keyboardEdit', { name: fieldName, value: second });
  step('input-ctrl-z-preserves-management-undo');
  report.results.inputUndo = await app.call('keyboardShortcut', { name: fieldName, gesture: 'CtrlZ' });
  report.results.valueAfterUndo = await wait(() => app.call('keyboardField', { name: fieldName }), value => value.value === first && value.hasKeyboardFocus && !value.offscreen, 'Actual input value after Ctrl+Z');
  assert.deepEqual(stored(fixture.dataset.dbPath), stateBefore, 'Input undo may not undo the real management favorite.');
  step('input-ctrl-y-redo');
  report.results.inputRedo = await app.call('keyboardShortcut', { name: fieldName, gesture: 'CtrlY' });
  report.results.valueAfterRedo = await wait(() => app.call('keyboardField', { name: fieldName }), value => value.value === second && value.hasKeyboardFocus && !value.offscreen, 'Actual input value after Ctrl+Y');
  step('input-ctrl-shift-z-redo');
  await app.call('keyboardShortcut', { name: fieldName, gesture: 'CtrlZ' });
  await wait(() => app.call('keyboardField', { name: fieldName }), value => value.value === first, 'Input undo before Ctrl+Shift+Z');
  report.results.inputAlternateRedo = await app.call('keyboardShortcut', { name: fieldName, gesture: 'CtrlShiftZ' });
  report.results.valueAfterAlternateRedo = await wait(() => app.call('keyboardField', { name: fieldName }), value => value.value === second && value.hasKeyboardFocus && !value.offscreen, 'Actual input value after Ctrl+Shift+Z');
  report.results.tasksAfterInput = taskSummary(await app.call('tasks'));
  assert.deepEqual(report.results.tasksAfterInput, report.results.tasksBeforeInput, 'Keyboard input undo/redo must not start a management task.');
  assert.deepEqual(stored(fixture.dataset.dbPath), stateBefore);
  step('real-ctrl-k-palette-and-focus');
  report.results.commandShortcut = await app.call('keyboardShortcut', { name: fieldName, gesture: 'CtrlK' });
  const paletteInput = '搜索资源、动作、能力或设置';
  await wait(() => app.call('state', { name: paletteInput }), rows => list(rows).filter(row => row.type === 'ControlType.ComboBox' && row.enabled && !row.offscreen).length === 1, 'Ctrl+K palette input mounted');
  report.results.paletteInput = await wait(() => app.call('keyboardField', { name: paletteInput }), value => value.type === 'ControlType.ComboBox' && value.keyboardFocusOwned && !value.offscreen && value.value === '', 'Actual Ctrl+K palette input or its exact owned active option focus');
  report.results.paletteTyping = await app.call('keyboardShortcut', { name: paletteInput, gesture: 'Space' });
  report.results.paletteTypedValue = await wait(() => app.call('keyboardField', { name: paletteInput }), value => value.value === ' ' && value.keyboardFocusOwned, 'Actual Space routed to the palette input without clicking or refocusing');
  report.results.originalInputWhilePaletteOpen = await app.call('keyboardField', { name: fieldName });
  assert.equal(report.results.originalInputWhilePaletteOpen.value, second);
  report.results.paletteContainer = await wait(() => app.call('state', { name: '快捷入口' }), rows => list(rows).filter(row => row.type !== 'ControlType.Text' && row.enabled && !row.offscreen).length === 1, 'Exact visible command palette container');
  step('real-escape-and-focus-return');
  report.results.escape = await app.call('keyboardShortcut', { name: paletteInput, gesture: 'Escape' });
  await wait(() => app.call('state', { name: paletteInput }), rows => list(rows).length === 0, 'Actual palette dismissal after Escape');
  await wait(() => app.call('state', { name: fieldName }), rows => list(rows).filter(row => row.type === 'ControlType.Edit' && row.hasKeyboardFocus && !row.offscreen).length === 1, 'Original native edit refocused after Escape');
  report.results.returnedInput = await wait(() => app.call('keyboardField', { name: fieldName }), value => value.value === second && value.hasKeyboardFocus && !value.offscreen, 'Original input focus and value restored after Escape');
  step('verify-no-extra-tasks-or-resource-changes');
  const tasksAfterPalette = await wait(() => app.call('tasks'), value => {
    const tasks = value.tasks || [], catalogueReads = tasks.filter(task => task.action === 'resource_list');
    return tasks.length === tasksBefore.tasks.length + 1 && catalogueReads.length === 1
      && catalogueReads[0].status === 'succeeded' && catalogueReads[0].origin?.paneId === 'home'
      && catalogueReads[0].origin?.windowLabel === 'main' && catalogueReads[0].origin?.view === 'tools';
  }, 'The one exact-origin read-only catalogue request from the first command palette');
  assert.deepEqual(taskSummary({ tasks: tasksAfterPalette.tasks.filter(task => task.action !== 'resource_list') }), report.results.tasksBeforeInput);
  report.results.tasksAfterPalette = taskSummary(tasksAfterPalette);
  assert.deepEqual(stored(fixture.dataset.dbPath), stateBefore);
  report.results.managementUndoAfterInput = await wait(() => app.call('state', { name: '撤销管理操作' }), rows => list(rows).filter(row => row.type === 'ControlType.Button' && row.enabled && !row.offscreen).length === 1, 'Real management undo remains available');
  for (const skill of original.skills) assert.equal(await digest(join(skill.localPath, 'SKILL.md')), skill.localHashes['SKILL.md']);
  report.results.generatedSkillFilesUnchanged = true;
  step('quit-normally'); report.normalExit = (await app.quit()).driverReport.closedNormally; app = null;
  report.status = 'passed-native-shortcuts-and-input-undo-scope';
} catch (error) {
  report.status = 'failed-or-blocked'; report.error = String(error); report.errorStack = error.stack; process.exitCode = 1;
  if (app && !app.operationError) {
    try {
      report.focusDiagnostic = await app.call('windowIdentity');
      if (report.currentStep === 'real-ctrl-k-palette-and-focus') report.paletteFocusDiagnostic = await app.call('keyboardField', { name: '搜索资源、动作、能力或设置' });
    } catch (diagnosticError) { report.focusDiagnosticError = String(diagnosticError); }
  }
}
finally {
  if (app) try { report.normalExit = (await app.quit()).driverReport.closedNormally; } catch (error) { report.normalExitError = String(error); report.status = 'failed-or-blocked'; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString(); await writeFile(reportPath, json(report));
  console.log(JSON.stringify({ status: report.status, currentStep: report.currentStep, report: reportPath, normalExit: report.normalExit || false, error: report.error || null }));
}
