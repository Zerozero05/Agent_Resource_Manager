import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFile, writeFile, appendFile, mkdir, mkdtemp, realpath, lstat } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPerformanceFixture, FIXTURE_FORMAT } from './performance-fixture.mjs';
import { NativeUiaSession } from './native-uia-client.mjs';

const format = 'agent-resource-manager-native-frame-v3';
const approved = 'D:\\03_github_projects\\Agent_Resource_Manager\\validation\\manager-data';
const options = Object.fromEntries(process.argv.slice(2).reduce((entries, arg, index, args) => arg.startsWith('--') ? [...entries, [arg.slice(2), args[index + 1]]] : entries, []));
if (Object.hasOwn(options, 'transport-file-sha256') && (typeof options['transport-file-sha256'] !== 'string' || !/^[a-f0-9]{64}$/i.test(options['transport-file-sha256']))) throw new Error('--transport-file-sha256 requires one exact SHA256 digest.');
const requestedTransportSha256 = options['transport-file-sha256']?.toLowerCase();
const accessibilityInput = process.argv.includes('--accessibility-input');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = async path => hash(await readFile(path));
const same = (a, b) => resolve(a.replace(/^\\\\\?\\(?=[a-z]:\\)/i, '')).toLowerCase() === resolve(b.replace(/^\\\\\?\\(?=[a-z]:\\)/i, '')).toLowerCase();
const within = (path, root) => { const value = relative(resolve(root), resolve(path)); return value === '' || !value.startsWith('..') && !isAbsolute(value); };
const values = value => value == null ? [] : Array.isArray(value) ? value : [value];
const sleep = ms => new Promise(done => setTimeout(done, ms));
function assertion(condition, message) { if (!condition) throw new Error(message); }
function densities(value = 'comfortable') {
  const selected = typeof value === 'string' ? value.split(',') : [];
  assertion(selected.length > 0 && selected.length <= 2 && new Set(selected).size === selected.length && selected.every(density => ['comfortable', 'compact'].includes(density)), 'Use --densities comfortable,compact, comfortable or compact.');
  return selected;
}
function frameConditions(selectedDensities) {
  return selectedDensities.flatMap(density => [['light', 'light', 115], ['dark', 'dark', 115], ['eye', 'eye', 115], ['dark-narrow', 'dark', 160]].map(([base, theme, zoom]) => ({ name: density === 'comfortable' ? base : `${base}-${density}`, theme, zoom, density, narrow: base === 'dark-narrow' })));
}
function rect(value) { const parts = String(value).split(',').map(Number); assertion(parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0, 'The exact native control has no finite visible rectangle.'); return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] }; }
const visible = rows => values(rows).filter(row => row.enabled && !row.offscreen && row.bounds && row.bounds !== 'Empty');
async function ready(read, accepts, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) { const result = await read(); if (accepts(result)) return result; assertion(Date.now() < deadline, `Native frame state unavailable: ${description}. No action was replayed.`); await sleep(40); }
}
async function unique(app, name, type, scope) {
  const rows = await ready(() => app.call('state', { name, ...(scope ? { scope } : {}) }), result => visible(result).filter(row => !type || row.type === type).length > 0, name);
  const matches = visible(rows).filter(row => !type || row.type === type); assertion(matches.length === 1, `Native frame selector is ambiguous: ${name}`); return { ...matches[0], rectangle: rect(matches[0].bounds) };
}
async function present(app, name) { return visible(await app.call('state', { name })).length > 0; }
async function enabled(app, name, type) { return values(await app.call('state', { name })).some(row => row.enabled && (!type || row.type === type)); }
async function invoke(app, name, scope) { await ready(() => app.call('state', { name, ...(scope ? { scope } : {}) }), rows => values(rows).filter(row => row.enabled && row.type === 'ControlType.Button').length === 1, name); return app.call('invokeName', { name, ...(scope ? { scope } : {}) }); }
async function businessReady(app) {
  await ready(() => app.call('state', { name: 'Perf Skill 0000' }), rows => values(rows).some(row => row.type === 'ControlType.TabItem' && row.selected && !row.offscreen), 'the real business tab is active');
  await ready(() => app.call('state', { name: 'Skill 详情' }), rows => values(rows).some(row => row.enabled && row.type === 'ControlType.Tab'), 'the active Skill detail content exists even when its inner tabs are below the fold');
}
async function top(app, name) {
  const button = await unique(app, name, 'ControlType.Button'), tabs = await unique(app, '工作区标签');
  const center = button.rectangle.y + button.rectangle.height / 2;
  assertion(button.rectangle.x < tabs.rectangle.x && center >= tabs.rectangle.y && center <= tabs.rectangle.y + tabs.rectangle.height, 'The sidebar toggle is not before the tabs in the actual fixed top toolbar.');
  return button;
}
async function body(app, expanded) {
  await ready(() => present(app, 'Skill 分类'), result => result === expanded, expanded ? 'the one real category panel becomes visible' : 'collapsed sidebar categories are hidden');
  if (expanded) { const panel = await unique(app, 'Skill 分类'); assertion(panel.rectangle.height >= 60, 'The expanded category list has no usable visible area.'); }
  assertion(await present(app, '主要导航'), 'The real sidebar navigation is unavailable.');
}
async function navigationGeometry(app) {
  const items = [];
  for (const name of ['总览', '全部资源', 'Skills', '工具', '变化', '客户端', '设置']) {
    const control = await unique(app, name, 'ControlType.Button', '主要导航');
    items.push({ name, ...control.rectangle });
  }
  return items;
}
function assertNavigationStable(before, after) {
  for (const [index, item] of before.entries()) {
    const current = after[index];
    assertion(current?.name === item.name && ['x', 'y', 'height'].every(key => Math.abs(item[key] - current[key]) <= 1), `The ${item.name} navigation control moved after toggling the sidebar.`);
  }
}
async function cycle(app, context, emit, expanded = true) {
  const beforeName = expanded ? '收起侧栏' : '展开侧栏', afterName = expanded ? '展开侧栏' : '收起侧栏';
  const before = await top(app, beforeName); await body(app, expanded); const navigationBefore = await navigationGeometry(app); await invoke(app, beforeName);
  const after = await top(app, afterName); await body(app, !expanded);
  await emit('sidebar-position-observed', { context, initialExpanded: expanded, before: before.bounds, after: after.bounds });
  assertion(before.bounds === after.bounds, 'The top sidebar toggle moved after changing expansion.');
  const navigationAfter = await navigationGeometry(app); assertNavigationStable(navigationBefore, navigationAfter);
  await invoke(app, afterName); const restored = await top(app, beforeName); await body(app, expanded);
  assertion(before.bounds === restored.bounds, 'The restored top sidebar toggle changed its position.');
  const navigationRestored = await navigationGeometry(app); assertNavigationStable(navigationBefore, navigationRestored);
  const result = { context, initialExpanded: expanded, before, after, restored, navigationBefore, navigationAfter, navigationRestored, sameNativePosition: true, navigationPositionTolerancePixels: 1, realSidebarVisibilityChanged: true };
  await emit('sidebar-cycle', result); return result;
}
async function screenshot(app, fixture, name) { const path = join(fixture.root, `${name}.png`); assertion(within(path, fixture.root), 'Screenshot escaped the exact generated fixture.'); await app.call('screenshot', { path }); return { path, sha256: await digest(path), nativeOwnedWindowOnly: true }; }
function settings(path) { const db = new DatabaseSync(path, { readOnly: true }); try { return JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload).settings; } finally { db.close(); } }

async function prepare() {
  await mkdir(approved, { recursive: true }); assertion(same(await realpath(approved), approved), 'Validation parent may not be a redirected link.');
  const root = await mkdtemp(join(approved, 'native-frame-'));
  await writeFile(join(root, 'fixture-owner.json'), JSON.stringify({ format, syntheticOnly: true, createdAt: new Date().toISOString() }, null, 2));
  const fixtures = [], selectedDensities = densities(options.densities);
  for (const { name, theme, zoom, density } of frameConditions(selectedDensities)) {
    const fixture = await createPerformanceFixture(root, name, 100), db = new DatabaseSync(fixture.dbPath);
    try { const state = JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload); Object.assign(state.settings, { uiTheme: theme, uiZoom: zoom, uiFontSize: 18, uiDensity: density }); db.prepare('UPDATE app_state SET payload=? WHERE id=1').run(JSON.stringify(state)); fixture.settings = state.settings; }
    finally { db.close(); }
    fixture.dataFingerprint = hash(JSON.stringify({ generatedSkills: fixture.skillCount, settings: fixture.settings, format }));
    await writeFile(join(fixture.root, 'dataset.json'), JSON.stringify(fixture, null, 2));
    fixtures.push({ name, theme, zoom, density, dataset: join(fixture.root, 'dataset.json'), initialDatabaseSha256: await digest(fixture.dbPath) });
  }
  const descriptor = { format, syntheticOnly: true, root, densities: selectedDensities, fixtures, createdAt: new Date().toISOString(), scope: 'real native fixed toolbar, one shared sidebar, business and split visibility, actual navigation, theme/density screenshots and narrow flyout; synthetic initial display settings, no settings-save or performance claim' };
  await writeFile(join(root, 'dataset.json'), JSON.stringify(descriptor, null, 2)); return descriptor;
}
async function readFixture(path) {
  const descriptor = JSON.parse(await readFile(resolve(path), 'utf8'));
  const selectedDensities = densities(descriptor.densities?.join(',') ?? 'comfortable'), expected = frameConditions(selectedDensities);
  assertion(descriptor.format === format && descriptor.syntheticOnly === true && within(descriptor.root, approved) && basename(descriptor.root).startsWith('native-frame-') && descriptor.fixtures?.length === expected.length, 'Pass the exact generated native-frame descriptor.');
  if (options.densities !== undefined) assertion(JSON.stringify(densities(options.densities)) === JSON.stringify(selectedDensities), 'The requested density matrix differs from the prepared fixture.');
  assertion(same(await realpath(descriptor.root), descriptor.root), 'The generated frame root may not be a directory link.');
  const owner = JSON.parse(await readFile(join(descriptor.root, 'fixture-owner.json'), 'utf8')); assertion(owner.format === format && owner.syntheticOnly, 'Frame ownership marker mismatch.');
  for (const [index, record] of descriptor.fixtures.entries()) {
    const condition = expected[index], density = record.density ?? 'comfortable';
    assertion(record.name === condition.name && record.theme === condition.theme && record.zoom === condition.zoom && density === condition.density && same(record.dataset, join(descriptor.root, record.name, 'dataset.json')), 'Generated frame dataset identity mismatch.');
    const fixture = JSON.parse(await readFile(record.dataset, 'utf8'));
    assertion(fixture.format === FIXTURE_FORMAT && fixture.syntheticOnly && fixture.toolCount === 100 && fixture.skillCount === 1000 && same(fixture.root, join(descriptor.root, record.name)) && same(fixture.dataDir, join(fixture.root, 'data')) && same(fixture.dbPath, join(fixture.dataDir, 'manager.sqlite3')), 'Only original isolated generated performance data may be opened.');
    for (const location of [fixture.root, fixture.dataDir, fixture.skillsRoot, fixture.toolsRoot]) assertion(within(location, descriptor.root) && same(await realpath(location), location), 'A generated fixture location was redirected.');
    assertion(!(await lstat(fixture.dbPath)).isSymbolicLink() && await digest(fixture.dbPath) === record.initialDatabaseSha256, 'The frame fixture has already run or changed; prepare a fresh isolated fixture.');
    const current = settings(fixture.dbPath); assertion(current.uiTheme === record.theme && current.uiZoom === record.zoom && current.uiFontSize === 18 && current.uiDensity === density, 'Generated display settings do not match this native acceptance condition.');
  }
  return descriptor;
}
async function candidate() {
  assertion(typeof options.candidate === 'string' && typeof options['candidate-build-info'] === 'string', 'Pass --candidate <actual exe> and --candidate-build-info <bound release JSON>.');
  const executable = resolve(options.candidate), infoPath = resolve(options['candidate-build-info']), bytes = await readFile(executable), info = JSON.parse(await readFile(infoPath, 'utf8'));
  const offset = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : -1;
  assertion(offset >= 0 && offset + 6 <= bytes.length && bytes.readUInt16LE(0) === 0x5a4d && bytes.readUInt32LE(offset) === 0x4550 && bytes.readUInt16LE(offset + 4) === 0x8664, 'Frame acceptance requires the actual native Windows x64 executable.');
  const sha256 = hash(bytes); assertion(info.buildMode === 'release' && (info.executableSha256 || info.sha256)?.toLowerCase() === sha256 && (info.sourceIdentity || info.sourceCommit), 'Release provenance does not bind the exact native candidate.');
  return { executable, sha256, infoPath, infoSha256: await digest(infoPath), sourceIdentity: info.sourceIdentity || info.sourceCommit, version: info.version };
}
async function run(descriptor, info) {
  const transportSha256 = requestedTransportSha256 || info.sha256;
  const reportPath = join(descriptor.root, 'frame-result.json'), events = join(descriptor.root, 'frame-events.jsonl');
  const harness = await Promise.all(['verify-native-frame.mjs', 'native-uia-client.mjs', 'verify-native-uia.ps1', 'performance-fixture.mjs'].map(async name => { const path = fileURLToPath(new URL(name, import.meta.url)); return { path, sha256: await digest(path) }; }));
  const report = { format, status: 'incomplete', syntheticOnly: true, candidate: info, transportFileSha256: transportSha256, harness, accessibilityInput, densities: descriptor.densities ?? ['comfortable'], startedAt: new Date().toISOString(), cases: [], limitations: ['Owned-window UIAutomation Invoke/SelectionItem controls are functional evidence; physical mouse/keyboard latency remains a separate performance check. This script does not sample user windows.', 'Each selected density has light/dark/eye cases at 115%, 18px and a separate dark narrow flyout at 160%, 18px and the unchanged 960px minimum window width. This is application zoom, not system DPI coverage.', 'Theme, density, font and zoom are synthetic initial database settings; this does not verify saving changed settings through the UI. IME, physical keyboard shortcuts and monitor/DPI changes are not covered.', 'Accessibility input avoids an explicit foreground/focus request by the launcher, but native windows and menus are visible. Screenshots capture only the owned window and still require actual visual review.'] };
  const emit = async (kind, value) => appendFile(events, JSON.stringify({ observedAt: new Date().toISOString(), kind, ...value }) + '\n');
  let app;
  try {
    for (const record of descriptor.fixtures) {
      assertion(await digest(info.executable) === info.sha256 && await digest(info.infoPath) === info.infoSha256, 'Candidate or bound build information changed before launch.');
      const density = record.density ?? 'comfortable';
      const fixture = JSON.parse(await readFile(record.dataset, 'utf8')), item = { name: record.name, configuredTheme: record.theme, configuredZoom: record.zoom, fontSize: 18, density, cycles: [], screenshots: [] }; report.cases.push(item);
      app = await NativeUiaSession.launch({ executable: info.executable, sha256: info.sha256, transportSha256, dataDir: fixture.dataDir, reportPath: join(fixture.root, 'native-driver.json'), accessibilityInput });
      assertion(app.identity.executableSha256 === info.sha256 && same(app.identity.dataDirectory, fixture.dataDir), 'Native identity differs from the bound candidate or exact synthetic data.');
      item.native = app.identity; await emit('native-startup', { name: record.name, ...app.identity }); console.log(JSON.stringify({ event: 'native-startup', name: record.name, pid: app.identity.pid, windowHandle: app.identity.windowHandle, fixture: fixture.root }));
      const narrow = record.name.startsWith('dark-narrow'); await app.call('resize', { width: narrow ? 960 : 1280, height: 850 });
      item.cycles.push(await cycle(app, 'home', emit, !narrow));
      item.screenshots.push(await screenshot(app, fixture, narrow ? 'narrow-collapsed' : 'wide'));
      if (!narrow) { await invoke(app, '收起侧栏'); await top(app, '展开侧栏'); item.screenshots.push(await screenshot(app, fixture, 'collapsed')); await invoke(app, '展开侧栏'); await body(app, true); }
      await invoke(app, 'Perf Skill 0000'); await businessReady(app);
      item.cycles.push(await cycle(app, 'business-single', emit, !narrow)); await businessReady(app);
      if (!narrow) { await invoke(app, '左右分栏'); await unique(app, '调整工作台与业务页宽度'); item.cycles.push(await cycle(app, 'split', emit, true)); await invoke(app, '恢复单页'); }
      if (narrow) { await invoke(app, '展开侧栏'); await body(app, true); item.screenshots.push(await screenshot(app, fixture, 'narrow-flyout')); await invoke(app, '收起侧栏'); await body(app, false); }
      await invoke(app, 'Skills', '主要导航'); await ready(() => enabled(app, '搜索 Skill', 'ControlType.Edit'), Boolean, 'the retained Home search control is enabled');
      assertion(visible(await app.call('state', { name: 'Perf Skill 0000' })).some(row => row.type === 'ControlType.TabItem'), 'Navigation removed the business tab rather than retaining it.');
      await app.call('selectTab', { name: 'Perf Skill 0000' }); await businessReady(app);
      if (narrow) { await invoke(app, '展开侧栏'); await body(app, true); }
      const categoryNames = values(await app.call('names')).filter(row => row.type === 'ControlType.Button' && /^论文研究\s*200$/.test(row.name)); assertion(categoryNames.length === 1, 'The generated category button is not unique.');
      await invoke(app, categoryNames[0].name); await ready(() => enabled(app, '搜索 Skill', 'ControlType.Edit'), Boolean, 'the retained Home search control is enabled');
      await ready(async () => ({ expected: await enabled(app, 'Perf Skill 0005'), excluded: await enabled(app, 'Perf Skill 0001') }), result => result.expected && !result.excluded, 'real category navigation returns to Home and applies its existing filter');
      item.navigation = { homeActivatedFromBusiness: true, businessTabRetained: true, categoryFilterApplied: true };
      await invoke(app, '工具', '主要导航');
      await ready(() => enabled(app, '搜索工具', 'ControlType.Edit'), Boolean, 'the actual mixed tool catalogue is enabled');
      await ready(() => enabled(app, 'Perf Tool 000', 'ControlType.Button'), Boolean, 'the real 100-tool fixture has loaded');
      item.screenshots.push(await screenshot(app, fixture, 'tools'));
      await invoke(app, '保存当前视图'); await ready(() => enabled(app, '视图名称', 'ControlType.Edit'), Boolean, 'saved-view editing remains available within its toolbar');
      await app.call('setField', { name: '视图名称', value: '布局验收草稿' });
      item.screenshots.push(await screenshot(app, fixture, 'saved-view-editor')); await invoke(app, '取消');
      await invoke(app, '总览', '主要导航');
      await unique(app, '资源总览');
      item.screenshots.push(await screenshot(app, fixture, 'dashboard'));
      await app.call('reveal', { name: 'GitHub 来源状态' });
      await unique(app, 'GitHub 来源状态');
      item.screenshots.push(await screenshot(app, fixture, 'dashboard-sources'));
      await invoke(app, '全部资源', '主要导航');
      await unique(app, '搜索全部资源', 'ControlType.Edit');
      await app.call('setField', { name: '搜索全部资源', value: 'Perf Tool 000' });
      await unique(app, 'Perf Tool 000', 'ControlType.Button');
      item.screenshots.push(await screenshot(app, fixture, 'unified-tools'));
      await app.call('reveal', { name: '资源分页' });
      await app.call('reveal', { name: info.version });
      const pagination = await unique(app, '资源分页');
      const footer = await unique(app, info.version, 'ControlType.Text');
      assertion(pagination.rectangle.y + pagination.rectangle.height <= footer.rectangle.y + 1, 'The unified resource list overlaps the application footer.');
      item.screenshots.push(await screenshot(app, fixture, 'unified-bottom'));
      await invoke(app, '总览', '主要导航');
      await invoke(app, '全部资源', '主要导航');
      await unique(app, 'Perf Tool 000', 'ControlType.Button');
      assertion(!await enabled(app, 'Perf Tool 001', 'ControlType.Button'), 'Unified search was lost when returning from Dashboard.');
      await app.call('setField', { name: '搜索全部资源', value: 'Perf Skill 0005' });
      await invoke(app, 'Perf Skill 0005');
      await ready(() => app.call('state', { name: 'Perf Skill 0005' }), rows => values(rows).some(row => row.type === 'ControlType.TabItem' && row.selected && !row.offscreen), 'unified library opens the original Skill detail');
      item.unifiedLibrary = { toolSearchVisible: true, searchRetainedAfterDashboard: true, originalSkillDetailOpened: true };
      await invoke(app, '设置', '主要导航'); await unique(app, '设置分类：常规', 'ControlType.Button');
      item.screenshots.push(await screenshot(app, fixture, 'settings'));
      if (!(await present(app, '设置分类'))) await invoke(app, '设置分类：常规');
      await invoke(app, '外观', '设置分类');
      await unique(app, '设置分类：外观', 'ControlType.Button');
      item.screenshots.push(await screenshot(app, fixture, 'display'));
      await app.call('selectCombo', { name: '界面密度', option: density === 'compact' ? '紧凑（默认）' : '舒适' });
      item.screenshots.push(await screenshot(app, fixture, 'appearance-rows'));
      item.additionalReview = { mixedTools: 100, savedViewEditorOpenedAndCancelled: true, settingsOutlineNavigated: true, selectedDensityUnchanged: true };
      const closed = await app.quit(); item.closedNormally = closed.driverReport.closedNormally; app = null;
      const saved = settings(fixture.dbPath); assertion(saved.uiTheme === record.theme && saved.uiZoom === record.zoom && saved.uiFontSize === 18 && saved.uiDensity === density, 'Native sidebar operations changed the selected display preferences.');
      item.displayPreferencesRetained = true; await emit('native-normal-exit', { name: record.name, pid: item.native.pid, closedNormally: item.closedNormally });
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    }
    report.status = 'passed-synthetic-native-frame';
  } catch (error) { report.status = 'failed-or-blocked'; report.error = String(error); process.exitCode = 1; }
  finally {
    if (app) { try { const result = await app.quit(); report.cases.at(-1).closedNormally = result.driverReport.closedNormally; } catch (error) { report.normalExitError = String(error); report.status = 'failed-or-blocked'; process.exitCode = 1; } }
    report.finishedAt = new Date().toISOString(); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ status: report.status, report: reportPath, error: report.error || null }));
  }
}

if (process.argv.includes('--help')) {
  console.log('Prepare only: --phase prepare [--densities comfortable,compact]. Native run: --phase run --fixture <dataset.json> --candidate <release.exe> --candidate-build-info <json> [--accessibility-input].');
  console.log('Optional --transport-file-sha256 <64hex> verifies the formal stdio executable independently of the selected release candidate. Omit it to retain the candidate-digest default; the strict ownership preflight and synthetic fixture checks remain unchanged.');
}
else if ((options.phase || 'prepare') === 'prepare') { const descriptor = await prepare(); console.log(JSON.stringify({ status: 'prepared-not-run', fixture: join(descriptor.root, 'dataset.json') })); }
else { assertion(options.phase === 'run' && typeof options.fixture === 'string', 'Use --phase prepare, or --phase run --fixture <generated dataset.json>.'); await run(await readFixture(options.fixture), await candidate()); }
