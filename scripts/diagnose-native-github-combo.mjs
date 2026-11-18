import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { NativeUiaSession } from './native-uia-client.mjs';
import { createPerformanceFixture, FIXTURE_FORMAT } from './performance-fixture.mjs';
import { ownedForeground } from './performance-policy.mjs';

const format = 'agent-resource-manager-github-combo-diagnostic-v1';
const approved = 'D:\\03_github_projects\\Agent_Management\\Agent_Resource_Manager\\validation\\manager-data';
const expectedExe = 'b8eab75020d4ebac7ea10fa96cdc1255ab68f3f242f34d4078c6c52ed6532f73';
const source = { repository: 'Panniantong/Agent-Reach', tag: 'v1.6.0', releaseId: 421526768, assetId: 668240314, assetName: 'agent-reach.zip', assetBytes: 676536 };
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, flag, index, all) => flag.startsWith('--') ? [...pairs, [flag.slice(2), all[index + 1]]] : pairs, []));
const selectionMode = Object.hasOwn(args, 'selection-mode') ? args['selection-mode'] : 'foreground';
assert.ok(['foreground', 'accessibility', 'keyboard'].includes(selectionMode), '--selection-mode requires foreground, accessibility or keyboard.');
const foregroundSelection = selectionMode === 'foreground';
const selectionPolicy = selectionMode === 'keyboard'
  ? { accessibilityInput: false, keyboardInput: true, prepareKeyboardForeground: false, awaitForeground: true,
    foregroundPreparationMethod: 'existing-native-launch-single-activation', selectCombo: { foreground: false } }
  : { accessibilityInput: true, keyboardInput: foregroundSelection, prepareKeyboardForeground: foregroundSelection, awaitForeground: foregroundSelection,
    selectCombo: foregroundSelection ? { foreground: true } : { foreground: false, focusBeforeExpand: true } };
const json = value => JSON.stringify(value, null, 2) + '\n';
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const sleep = ms => new Promise(done => setTimeout(done, ms));
const execute = promisify(execFile);
const same = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase();
const inside = (path, parent) => { const part = relative(parent, path); return part !== '' && !part.startsWith('..') && !isAbsolute(part); };
async function shell(command) { const result = await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 20000, maxBuffer: 256 * 1024 }); return JSON.parse(result.stdout.trim()); }

async function runtimeFiles(dataset) {
  const files = [];
  for (const [root, count, prefix, width, name] of [[dataset.skillsRoot, 1000, 'perf-skill-', 4, 'SKILL.md'], [dataset.toolsRoot, 100, 'perf-tool-', 3, 'README.md']]) {
    for (let index = 0; index < count; index++) {
      const path = join(root, prefix + String(index).padStart(width, '0'), name);
      assert.ok(same(await realpath(path), path)); files.push({ path, sha256: await digest(path) });
    }
  }
  return files;
}
function durable(dataset) {
  const db = new DatabaseSync(dataset.dbPath, { readOnly: true });
  try {
    const state = JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload);
    const skills = state.skills.map(skill => Object.fromEntries(['id', 'name', 'displayName', 'localPath', 'version', 'favorite', 'categoryId', 'localHashes', 'runtimeFiles'].map(key => [key, skill[key]])));
    return { settings: state.settings, sources: state.sources, connections: state.connections, localRoots: state.localRoots, skills, resources: db.prepare('SELECT id,revision,payload FROM resource_catalog ORDER BY id').all() };
  } finally { db.close(); }
}
if (process.argv.includes('--help')) {
  console.log('Prepare --phase prepare [--selection-mode foreground|accessibility|keyboard]. Run --phase run --prepared <combo-fixture.json> --candidate <b8 diagnostic exe> --candidate-build-info <json> --diagnostic-config <json> [--selection-mode foreground|accessibility|keyboard]. Use the same mode for prepare and run. Default foreground retains guarded native foreground dropdown setup. Explicit accessibility uses UIA focus-before-expand selection with keyboard input disabled, and skips foreground preparation/waiting. Explicit keyboard uses the existing native-input dropdown branch, the native launch single activation and a sixty-second read-only owned-foreground wait. CDP only observes the fixed GitHub form and disabled/fieldset/option state. No asset download or production GUI/performance acceptance claim.');
  process.exit(0);
}
assert.ok(['prepare', 'run'].includes(args.phase));
if (args.phase === 'prepare') {
  await mkdir(approved, { recursive: true });
  const root = await mkdtemp(join(approved, 'native-github-combo-'));
  const dataset = await createPerformanceFixture(root, 'combo', 100);
  const prepared = join(root, 'combo-fixture.json');
  await writeFile(prepared, json({ format, syntheticOnly: true, selectionMode, selectionPolicy, root, dataset, source, initialDatabaseSha256: await digest(dataset.dbPath), runtimeFiles: await runtimeFiles(dataset), createdAt: new Date().toISOString() }), { flag: 'wx' });
  console.log(json({ status: 'prepared-not-run', prepared, selectionMode, noNativeLaunch: true })); process.exit(0);
}

assert.ok(args.prepared && args.candidate && args['candidate-build-info'] && args['diagnostic-config']);
const prepared = resolve(args.prepared), fixture = JSON.parse(await readFile(prepared, 'utf8')), dataset = fixture.dataset;
assert.equal(fixture.format, format); assert.equal(fixture.syntheticOnly, true); assert.deepEqual(fixture.source, source);
if (fixture.selectionMode === undefined && fixture.selectionPolicy === undefined) {
  assert.equal(selectionMode, 'foreground', 'Legacy fixtures support their original foreground policy.');
} else {
  assert.equal(fixture.selectionMode, selectionMode, 'Run selection mode must match the prepared fixture.');
  assert.deepEqual(fixture.selectionPolicy, selectionPolicy, 'Run selection policy must match the prepared fixture.');
}
assert.ok(inside(fixture.root, approved) && same(dirname(prepared), fixture.root));
assert.equal(dataset.format, FIXTURE_FORMAT); assert.equal(dataset.syntheticOnly, true); assert.equal(dataset.skillCount, 1000); assert.equal(dataset.toolCount, 100);
for (const [field, suffix] of [['root', ''], ['dataDir', 'data'], ['dbPath', 'data/manager.sqlite3'], ['skillsRoot', 'skills'], ['toolsRoot', 'tools']]) {
  assert.ok(same(dataset[field], join(fixture.root, 'combo', suffix)) && same(await realpath(dataset[field]), dataset[field]));
}
assert.ok(same(await realpath(fixture.root), fixture.root));
assert.deepEqual(JSON.parse(await readFile(join(dataset.root, 'dataset.json'), 'utf8')), dataset);
const owner = JSON.parse(await readFile(join(dataset.root, 'fixture-owner.json'), 'utf8'));
assert.equal(owner.format, FIXTURE_FORMAT); assert.equal(owner.syntheticOnly, true); assert.equal(owner.name, 'combo');
assert.deepEqual(await readdir(dataset.dataDir), ['manager.sqlite3']); assert.equal(await digest(dataset.dbPath), fixture.initialDatabaseSha256);
assert.deepEqual(await runtimeFiles(dataset), fixture.runtimeFiles);
const executable = resolve(args.candidate), buildPath = resolve(args['candidate-build-info']), diagnosticPath = resolve(args['diagnostic-config']);
const build = JSON.parse(await readFile(buildPath, 'utf8')), diagnostic = JSON.parse(await readFile(diagnosticPath, 'utf8'));
assert.equal(build.buildMode, 'release'); assert.equal(build.diagnosticOnly, true); assert.equal(build.productionCandidate, false);
assert.ok(same(build.executablePath, executable)); assert.equal(build.executableSha256, expectedExe); assert.equal(await digest(executable), expectedExe);
assert.equal(diagnostic.format, 'agent-resource-manager-native-cdp-diagnostic-v1'); assert.equal(diagnostic.diagnosticOnly, true); assert.equal(diagnostic.productionCandidate, false);
assert.equal(diagnostic.host, '127.0.0.1'); assert.equal(diagnostic.port, 65352); assert.equal(diagnostic.executableSha256, expectedExe);
assert.equal(diagnostic.buildInfoSha256, await digest(buildPath)); assert.equal(await digest(diagnostic.overridePath), diagnostic.overrideSha256);
assert.ok(build.sourceIdentity.endsWith('+diagnostic-config:' + diagnostic.overrideSha256));
const override = JSON.parse(await readFile(diagnostic.overridePath, 'utf8'));
assert.equal(override.app?.windows?.length, 1);
const browserArgs = override.app.windows[0].additionalBrowserArgs.split(/\s+/);
for (const flag of ['--remote-debugging-port=65352', '--remote-debugging-address=127.0.0.1']) assert.equal(browserArgs.filter(value => value === flag).length, 1);
assert.equal(browserArgs.filter(value => value.startsWith('--remote-debugging-port=')).length, 1);
assert.equal(browserArgs.filter(value => value.startsWith('--remote-debugging-address=')).length, 1);
for (const key of Object.keys(process.env)) assert.ok(!/^WEBVIEW2_(USER_DATA_FOLDER|ADDITIONAL_BROWSER_ARGUMENTS|WAIT_FOR_SCRIPT_DEBUGGER|PIPE_FOR_SCRIPT_DEBUGGER)$/i.test(key), 'External WebView overrides must be absent.');
const harness = await Promise.all(['diagnose-native-github-combo.mjs', 'native-uia-client.mjs', 'verify-native-uia.ps1', 'performance-fixture.mjs', 'performance-policy.mjs'].map(async name => { const path = fileURLToPath(new URL(name, import.meta.url)); return { path, sha256: await digest(path) }; }));
const reportPath = join(dataset.root, 'combo-result.json');
const report = { format, status: 'running', diagnosticOnly: true, productionGuiAcceptanceClaim: false, performanceAcceptanceClaim: false, startedAt: new Date().toISOString(), source, dataset, harness, selectionMode, selectionPolicy, domSamples: [], normalExit: false, downloadsRequested: false,
  observationScope: { nativeControls: ['发行版本', '发行文件'], cdpReadOnly: true, cdpForm: '从 GitHub 下载发行包', cdpFields: ['disabled', ':disabled', 'parent fieldset disabled', 'options', 'selected value', 'focus'], systemKeyboardOrMouseInputAllowed: selectionPolicy.keyboardInput },
  fixtureDescriptor: { path: prepared, sha256: await digest(prepared) },
  candidate: { executable, sha256: expectedExe, buildPath, buildSha256: await digest(buildPath), diagnosticPath, diagnosticSha256: await digest(diagnosticPath), overridePath: diagnostic.overridePath, overrideSha256: diagnostic.overrideSha256 },
  limitations: ['CDP changes the observation environment. This diagnostic does not pass normal candidate performance or GUI acceptance.', 'CDP uses only fixed read-only Runtime.evaluate expressions. Native selection retains the existing exact-option and enabled guards.', 'No asset download, resource execution, backup, cleanup or user-data changes.'] };
const save = () => writeFile(reportPath, json(report));
await writeFile(join(dataset.root, 'combo-run-owner.json'), json({ descriptorSha256: await digest(prepared), candidateSha256: expectedExe, createdAt: report.startedAt }), { flag: 'wx' });
let app, client, baseline;

async function waitRead(read, predicate, label, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (predicate(value)) return value; await sleep(100); }
  throw new Error('Diagnostic state timed out: ' + label);
}
async function bindCdp() {
  const memory = await app.call('memory'), ids = memory.processes.map(row => Number(row.pid));
  assert.ok(ids.every(Number.isSafeInteger));
  const rows = list(await shell(`
    $ErrorActionPreference='Stop'
    $rows=Get-CimInstance Win32_Process -Filter '${ids.map(id => `ProcessId=${id}`).join(' OR ')}'
    @(foreach($row in $rows) {
      $p=Get-Process -Id $row.ProcessId -ErrorAction Stop
      [pscustomobject]@{
        pid=$row.ProcessId
        parentPid=$row.ParentProcessId
        creationFileTime=$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
        image=$row.Name
        executable=$row.ExecutablePath
        command=$row.CommandLine
      }
    })|ConvertTo-Json -Compress`));
  for (const row of rows) assert.ok(memory.processes.some(value => value.pid === row.pid && String(value.creationFileTime) === row.creationFileTime));
  const manager = rows.find(row => row.pid === app.identity.pid);
  assert.ok(manager && same(manager.executable, executable)); assert.equal(manager.creationFileTime, app.identity.creationFileTime);
  const browsers = rows.filter(row => row.image === 'msedgewebview2.exe' && !/--type=/.test(row.command || '') && /(?:^|\s)--remote-debugging-port=65352(?:\s|$)/.test(row.command || ''));
  assert.equal(browsers.length, 1);
  const profileMatch = browsers[0].command.match(/--user-data-dir=(?:"([^"]+)"|([^\s]+))/), profile = profileMatch?.[1] || profileMatch?.[2];
  assert.ok(profile && (same(profile, join(dataset.dataDir, 'webview')) || inside(resolve(profile), join(dataset.dataDir, 'webview'))));
  const listeners = list(await shell('@(Get-NetTCPConnection -State Listen -LocalPort 65352 -ErrorAction Stop | Select-Object LocalAddress,OwningProcess)|ConvertTo-Json -Compress'));
  assert.ok(listeners.length && listeners.every(row => ['127.0.0.1', '::1'].includes(row.LocalAddress) && row.OwningProcess === browsers[0].pid));
  const response = await fetch('http://127.0.0.1:65352/json', { redirect: 'error', signal: AbortSignal.timeout(2000) }); assert.ok(response.ok);
  const pages = (await response.json()).filter(page => page.type === 'page'); assert.equal(pages.length, 1);
  const target = pages[0], url = new URL(target.url), socketUrl = new URL(target.webSocketDebuggerUrl);
  assert.ok(['http:', 'https:'].includes(url.protocol) && url.hostname === 'tauri.localhost' || url.protocol === 'tauri:' && url.hostname === 'localhost');
  assert.equal(socketUrl.protocol, 'ws:'); assert.equal(socketUrl.hostname, '127.0.0.1'); assert.equal(socketUrl.port, '65352'); assert.ok(socketUrl.pathname.startsWith('/devtools/page/'));
  const socket = new WebSocket(socketUrl);
  await new Promise((done, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('CDP open timeout')); }, 10000);
    socket.addEventListener('open', () => { clearTimeout(timer); done(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); socket.close(); reject(new Error('CDP connection failed')); }, { once: true });
  });
  report.cdp = { manager, browser: { pid: browsers[0].pid, creationFileTime: browsers[0].creationFileTime, profile }, listeners, target: { id: target.id, url: target.url }, observedAt: new Date().toISOString() };
  return new ReadOnlyCdp(socket);
}
class ReadOnlyCdp {
  constructor(socket) {
    this.socket = socket; this.nextId = 0; this.pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data), request = this.pending.get(message.id); if (!request) return;
      this.pending.delete(message.id); clearTimeout(request.timer);
      if (message.error || message.result?.exceptionDetails) request.reject(new Error(json(message)));
      else request.resolve(message.result.result.value);
    });
    socket.addEventListener('close', () => { for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('CDP closed')); } this.pending.clear(); });
  }
  observe() {
    const expression = `(() => {
      const sections = [...document.querySelectorAll('section[aria-label="从 GitHub 下载发行包"]')]
        .filter(element => !element.closest('[hidden]') && element.getClientRects().length);
      if (sections.length !== 1) throw Error('Exact visible Github form missing');
      return [...sections[0].querySelectorAll('select')].map(element => ({
        label: element.closest('label').childNodes[0].textContent.trim(),
        value: element.value,
        disabled: element.disabled,
        effectivelyDisabled: element.matches(':disabled'),
        fieldsetDisabled: element.closest('fieldset')?.disabled ?? null,
        focused: document.activeElement === element,
        options: [...element.options].map(option => ({
          value: option.value,
          text: option.textContent,
          disabled: option.disabled,
          effectivelyDisabled: option.matches(':disabled'),
          selected: option.selected,
        })),
      }));
    })()`;
    return new Promise((done, reject) => {
      const id = ++this.nextId, timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Read-only DOM observation timed out')); }, 3000);
      this.pending.set(id, { resolve: done, reject, timer }); this.socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
  }
}
async function sample(label) {
  const startedAt = new Date().toISOString(), values = await client.observe();
  report.domSamples.push({ label, startedAt, finishedAt: new Date().toISOString(), values }); await save(); return values;
}
try {
  await save(); assert.equal(Number(await shell('@(Get-NetTCPConnection -State Listen -LocalPort 65352 -ErrorAction SilentlyContinue).Count | ConvertTo-Json')), 0);
  app = await NativeUiaSession.launch({ executable, sha256: expectedExe, dataDir: dataset.dataDir, reportPath: join(dataset.root, 'native-driver.json'), accessibilityInput: selectionPolicy.accessibilityInput, keyboardInput: selectionPolicy.keyboardInput });
  report.native = app.identity; assert.ok(same(app.identity.dataDirectory, dataset.dataDir)); baseline = durable(dataset);
  if (selectionPolicy.prepareKeyboardForeground) {
    report.foregroundPreparation = await app.call('prepareKeyboardForeground');
    assert.equal(report.foregroundPreparation.pid, app.identity.pid);
    assert.equal(report.foregroundPreparation.windowHandle, app.identity.windowHandle);
    assert.equal(report.foregroundPreparation.sentKeyboardOrMouseInput, false);
    await save();
  } else if (selectionMode === 'keyboard') {
    report.foregroundPreparation = { method: selectionPolicy.foregroundPreparationMethod, pid: app.identity.pid, windowHandle: app.identity.windowHandle, verifiedBy: 'following-read-only-owned-foreground-wait' };
    await save();
  }
  if (selectionPolicy.awaitForeground) {
    console.log(json({ status: 'await-owned-foreground', selectionMode, pid: app.identity.pid, windowHandle: app.identity.windowHandle, timeoutMs: 60000 }));
    report.foreground = await waitRead(() => app.call('windowIdentity'), value => ownedForeground(value, app.identity), 'owned foreground');
  } else {
    report.windowIdentity = await app.call('windowIdentity');
    assert.equal(report.windowIdentity.capturedHandle, app.identity.windowHandle);
    assert.equal(report.windowIdentity.currentMainHandle, app.identity.windowHandle);
    assert.equal(report.windowIdentity.uiaProcessId, app.identity.pid);
  }
  client = await bindCdp(); await save();
  await app.call('invokeName', { name: '工具', scope: '主要导航' });
  await waitRead(() => app.call('fields'), rows => list(rows).some(row => row.name === '搜索工具'), 'tools');
  await app.call('invokeName', { name: '安装发行包' }); await app.call('invokeName', { name: 'GitHub 发行版', scope: '发行包来源' });
  await app.call('setField', { name: 'GitHub 仓库或发行链接', value: 'https://github.com/' + source.repository });
  await app.call('setField', { name: '固定版本（可选）', value: source.tag });
  const prior = new Set((await app.call('tasks')).tasks.map(task => task.id));
  await app.call('invokeName', { name: '查询发行版本' });
  const tasks = await waitRead(() => app.call('tasks'), value => value.tasks.some(task => !prior.has(task.id) && task.action === 'resource_github_releases'), 'query task');
  const created = tasks.tasks.filter(task => !prior.has(task.id) && task.action === 'resource_github_releases'); assert.equal(created.length, 1);
  const terminal = await waitRead(() => app.call('task', { taskId: created[0].id }), value => !['queued', 'running'].includes(value.task.status), 'query result', 120000);
  report.queryTask = terminal.task; await save(); assert.equal(terminal.task.status, 'succeeded', terminal.task.error);
  const release = terminal.task.result.releases.find(value => value.id === source.releaseId && value.tag === source.tag);
  assert.ok(release); const asset = release.assets.find(value => value.id === source.assetId); assert.ok(asset && asset.name === source.assetName && asset.size === source.assetBytes);
  await waitRead(() => app.call('fields'), rows => list(rows).some(row => row.name === '发行版本' && row.enabled), 'enabled release form');
  await sample('before-version-selection');
  let versionSettled = false;
  const pendingVersion = app.call('selectCombo', { name: '发行版本', option: source.tag, ...selectionPolicy.selectCombo })
    .then(value => ({ value }), error => ({ error })).finally(() => { versionSettled = true; });
  while (!versionSettled) {
    try { await sample('during-version-selection'); }
    catch (error) { report.versionDomObservationError = String(error); break; }
    await sleep(250);
  }
  const version = await pendingVersion;
  if (version.error) { report.versionSelection = { error: String(version.error) }; throw version.error; }
  report.versionSelection = version.value; assert.equal(report.versionSelection.selected, source.tag);
  await sample('before-asset-expansion'); report.assetUiaBefore = await app.call('state', { name: '发行文件' }); await save();
  let settled = false;
  const selection = app.call('selectCombo', { name: '发行文件', option: 'agent-reach.zip · 660.7 KiB', ...selectionPolicy.selectCombo }).then(value => ({ value }), error => ({ error: String(error) })).finally(() => { settled = true; });
  while (!settled) { try { await sample('during-asset-expansion'); } catch (error) { report.domObservationError = String(error); break; } await sleep(250); }
  report.assetSelection = await selection;
  if (selectionMode === 'keyboard') {
    assert.ok(report.assetSelection.value, report.assetSelection.error || 'Native keyboard selection returned no result.');
    assert.equal(report.assetSelection.value.selected, 'agent-reach.zip · 660.7 KiB');
  }
  assert.ok(report.domSamples.some(row => row.label === 'during-asset-expansion')); report.status = 'diagnostic-observations-collected';
} catch (error) { report.status = 'failed-or-blocked'; report.error = String(error); report.errorStack = error.stack; process.exitCode = 1; }
finally {
  if (app) {
    try {
      const result = await app.quit();
      report.nativeDriver = result.driverReport;
      report.normalExit = result.driverReport.closedNormally === true;
    } catch (error) {
      report.nativeDriver = app.driverReport || null;
      report.normalExit = report.nativeDriver?.closedNormally === true;
      report.normalExitError = String(error);
      report.status = 'failed-or-blocked'; process.exitCode = 1;
    }
  }
  client?.socket.close();
  try {
    if (baseline) { assert.deepEqual(durable(dataset), baseline); assert.deepEqual(await runtimeFiles(dataset), fixture.runtimeFiles); report.durableDataAndRuntimeFilesPreserved = true; }
    assert.ok((await Promise.all(harness.map(async file => await digest(file.path) === file.sha256))).every(Boolean));
    for (const [path, hash] of [[executable, expectedExe], [buildPath, report.candidate.buildSha256], [diagnosticPath, report.candidate.diagnosticSha256], [diagnostic.overridePath, diagnostic.overrideSha256]]) assert.equal(await digest(path), hash);
    assert.equal(await digest(prepared), report.fixtureDescriptor.sha256);
  } catch (error) { report.integrityError = String(error); report.status = 'failed-or-blocked'; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString(); await save(); console.log(json({ status: report.status, reportPath, normalExit: report.normalExit, error: report.error || null }));
}
