import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile, realpath, lstat } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeUiaSession } from './native-uia-client.mjs';

// Preparation creates only this script's generated state. After launch all
// management mutations must come from real controls; SQLite is read-only.
const FORMAT = 'agent-resource-manager-native-management-v1';
const DRIVER_FORMAT = 'agent-resource-manager-native-performance-v1';
const managerRoot = 'D:\\03_github_projects\\Agent_Resource_Manager';
const dataParent = join(managerRoot, 'validation', 'manager-data');
const resourceParent = join(managerRoot, 'validation', 'resources');
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = async path => hash(await readFile(path));
const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
const within = (path, root) => { const key = relative(resolve(root), resolve(path)); return key === '' || (!key.startsWith('..') && !isAbsolute(key)); };
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
const sleep = ms => new Promise(done => setTimeout(done, ms));
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  assert(process.argv[i].startsWith('--') && process.argv[i + 1] && !process.argv[i + 1].startsWith('--'), 'Use explicit --option value arguments.');
  const key = process.argv[i].slice(2);
  assert(['phase', 'fixture', 'candidate', 'candidate-build-info', 'expected-sha256'].includes(key) && options[key] === undefined, `Unknown or repeated option: ${key}`);
  options[key] = process.argv[i + 1];
}
const phase = options.phase || 'prepare';
assert(['prepare', 'run'].includes(phase), 'Use --phase prepare or explicitly --phase run.');

async function regular(path, root, directory = false) {
  assert(within(path, root), `Generated scope escaped its declared root: ${path}`);
  const item = await lstat(path);
  assert(!item.isSymbolicLink() && (directory ? item.isDirectory() : item.isFile() && item.nlink === 1) && same(await realpath(path), path), `Generated path is missing, linked, redirected, or not the expected type: ${path}`);
}
async function wait(read, accepts, description, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await read();
    if (accepts(result)) return result;
    assert(Date.now() < deadline, `Native management result unavailable: ${description}. No write was replayed.`);
    await sleep(40);
  }
}
async function controls(app, name, scope) { return array(await app.call('state', { name, ...(scope ? { scope } : {}) })); }
async function enabled(app, name, scope) {
  return wait(() => controls(app, name, scope), rows => rows.filter(item => item.type === 'ControlType.Button' && item.enabled).length === 1, name);
}
async function invoke(app, name, scope) { await enabled(app, name, scope); await app.call('invokeName', { name, ...(scope ? { scope } : {}) }); }
async function text(app, name) { return wait(() => controls(app, name), rows => rows.some(item => item.type === 'ControlType.Text' && !item.offscreen), name); }
async function field(app, name, value) {
  await wait(() => app.call('fields'), rows => array(rows).filter(item => item.name === name && item.type === 'ControlType.Edit' && item.enabled).length === 1, name);
  const result = await app.call('setField', { name, value });
  assert(result.value === value, `The actual native value differs for ${name}.`);
}
async function listNames(app, expected) {
  await wait(async () => {
    const result = [];
    for (const name of expected) result.push((await controls(app, name, '可横向滚动的 Skill 列表')).filter(item => item.type === 'ControlType.Button' && !item.offscreen).length);
    return result;
  }, rows => rows.every(count => count === 1), 'expected real Skill rows');
}
function readState(fixture) {
  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try { return JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload); } finally { db.close(); }
}
function readAnnotation(fixture, id) {
  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try { return db.prepare('SELECT skill_id,revision,alias,notes FROM skill_annotations WHERE skill_id=?').get(id); } finally { db.close(); }
}
function readViews(fixture) {
  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try { return db.prepare('SELECT id,revision,name,view,filters FROM saved_views ORDER BY rowid').all().map(row => ({ ...row, filters: JSON.parse(row.filters) })); } finally { db.close(); }
}

async function prepare() {
  assert(!options.fixture && !options.candidate && !options['candidate-build-info'] && !options['expected-sha256'], 'Preparation takes no existing data or executable input.');
  await mkdir(dataParent, { recursive: true }); await mkdir(resourceParent, { recursive: true });
  await regular(dataParent, dataParent, true); await regular(resourceParent, resourceParent, true);
  const root = await mkdtemp(join(dataParent, 'native-management-'));
  const resourcesRoot = await mkdtemp(join(resourceParent, 'native-management-'));
  const dataDir = join(root, 'data'), dbPath = join(dataDir, 'manager.sqlite3');
  await mkdir(dataDir);
  const createdAt = new Date().toISOString(), skills = [], files = [];
  for (let index = 0; index < 3; index++) {
    const key = String(index).padStart(4, '0'), id = `perf-skill-${key}`, localPath = join(resourcesRoot, id);
    await mkdir(localPath);
    const markdown = `---\nname: ${id}\ndescription: Generated native management fixture.\nmetadata:\n  version: "1.0.0"\n---\n\n# Perf Skill ${key}\n\n仅用于隔离的本地性能验收，不调用外部程序，不连接远端。\n\n## 使用方法\n\n验证管理记录，不执行脚本或工具。\n`;
    const path = join(localPath, 'SKILL.md'); await writeFile(path, markdown);
    files.push({ path, sha256: hash(markdown) });
    skills.push({ id, name: id, displayName: `Perf Skill ${key}`, description: 'Generated local management fixture; no executable or network source.', localPath, status: 'local_only', version: '1.0.0', runtimeFiles: ['SKILL.md'], runtimeConfirmed: true, runtimeAudit: { status: 'verified', warnings: [], checkedAt: createdAt }, runtimeWarnings: [], runtimeIssues: [], localHashes: { 'SKILL.md': hash(markdown) }, favorite: false, readOnly: false });
  }
  const state = { skills, sources: [], connections: [], localRoots: [], ignoredLocalPaths: [], checkMode: 'manual', checkGeneration: 0, checkSummary: null, stateRevision: 1, settings: { checkIntervalMinutes: 30, uiTheme: 'dark', uiZoom: 100, uiFontSize: 18, uiDensity: 'comfortable', uiAccent: 'violet', uiMotion: 'off', libraryMode: 'list', libraryPageSize: 20, librarySort: 'name', categories: [], sidebarWidth: 224, sidebarCollapsed: false } };
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE app_state (id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,payload TEXT NOT NULL); CREATE TABLE workspace_state (id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);');
    db.prepare('INSERT INTO app_state VALUES(1,1,?)').run(JSON.stringify(state));
  } finally { db.close(); }
  const fixture = { format: FORMAT, driverFormat: DRIVER_FORMAT, syntheticOnly: true, root, resourcesRoot, dataDir, dbPath, skillCount: skills.length, toolCount: 0, skills: skills.map(({ id, displayName, localPath }) => ({ id, displayName, localPath })), sourceFiles: files, createdAt };
  await writeFile(join(root, 'fixture-owner.json'), JSON.stringify({ format: DRIVER_FORMAT, managementFormat: FORMAT, syntheticOnly: true, createdAt }, null, 2));
  await writeFile(join(resourcesRoot, 'fixture-owner.json'), JSON.stringify({ format: FORMAT, syntheticOnly: true, dataRoot: root, createdAt }, null, 2));
  await writeFile(join(root, 'dataset.json'), JSON.stringify(fixture, null, 2));
  return fixture;
}
async function readFixture(path) {
  const descriptor = resolve(path); assert(within(descriptor, dataParent) && descriptor.endsWith('dataset.json'), 'Use the exact generated management dataset descriptor.');
  await regular(descriptor, dataParent);
  const fixture = JSON.parse(await readFile(descriptor, 'utf8'));
  assert(fixture.format === FORMAT && fixture.driverFormat === DRIVER_FORMAT && fixture.syntheticOnly === true && same(dirname(descriptor), fixture.root) && fixture.skillCount === 3 && fixture.toolCount === 0 && fixture.skills?.length === 3 && fixture.sourceFiles?.length === 3, 'The generated management identity does not match.');
  for (const [path, root, directory] of [[fixture.root, dataParent, true], [fixture.dataDir, fixture.root, true], [fixture.dbPath, fixture.dataDir, false], [fixture.resourcesRoot, resourceParent, true]]) await regular(path, root, directory);
  assert(same(fixture.dataDir, join(fixture.root, 'data')) && same(fixture.dbPath, join(fixture.dataDir, 'manager.sqlite3')) && !within(fixture.resourcesRoot, fixture.root) && !within(fixture.root, fixture.resourcesRoot), 'Manager data and generated resources must stay independent.');
  const marker = JSON.parse(await readFile(join(fixture.root, 'fixture-owner.json'), 'utf8'));
  const resourceMarker = JSON.parse(await readFile(join(fixture.resourcesRoot, 'fixture-owner.json'), 'utf8'));
  assert(marker.managementFormat === FORMAT && marker.syntheticOnly && resourceMarker.format === FORMAT && resourceMarker.syntheticOnly && same(resourceMarker.dataRoot, fixture.root), 'Generated ownership markers differ.');
  const state = readState(fixture);
  assert(state.skills.length === 3 && !state.sources.length && !state.connections.length && !state.localRoots.length && state.checkMode === 'manual', 'The management fixture gained unapproved sources, connections or scan roots.');
  for (const [index, skill] of fixture.skills.entries()) {
    assert(skill.id === `perf-skill-${String(index).padStart(4, '0')}` && skill.displayName === `Perf Skill ${String(index).padStart(4, '0')}` && same(skill.localPath, join(fixture.resourcesRoot, skill.id)), 'Generated Skill identity differs.');
    await regular(skill.localPath, fixture.resourcesRoot, true);
    const actual = state.skills.find(item => item.id === skill.id);
    assert(actual && same(actual.localPath, skill.localPath) && !actual.repo && !actual.remotePath && !actual.readOnly, 'The fixture contains an unexpected Skill binding.');
    const file = fixture.sourceFiles[index]; assert(same(file.path, join(skill.localPath, 'SKILL.md')), 'The original fixture file differs.');
    await regular(file.path, skill.localPath); assert(await digest(file.path) === file.sha256, 'Generated Skill source changed.');
  }
  return fixture;
}

async function savedViewFlow(app, fixture) {
  const query = fixture.skills[1].id, name = 'Native saved view', renamed = 'Native saved view reviewed';
  await field(app, '搜索 Skill', query); await listNames(app, [fixture.skills[1].displayName]);
  assert(!(await controls(app, fixture.skills[0].displayName, '可横向滚动的 Skill 列表')).length, 'Search did not remove the unmatched real row.');
  await invoke(app, '保存当前视图'); await field(app, '视图名称', name); await invoke(app, '保存视图'); await text(app, '视图已保存。');
  const created = await wait(() => readViews(fixture), rows => rows.filter(row => row.name === name && row.view === 'skills' && row.filters.query === query).length === 1, 'saved view persisted from UI');
  const view = created.find(row => row.name === name);
  await field(app, '搜索 Skill', ''); await listNames(app, fixture.skills.map(skill => skill.displayName));
  await invoke(app, '应用视图'); await listNames(app, [fixture.skills[1].displayName]);
  assert(!(await controls(app, fixture.skills[0].displayName, '可横向滚动的 Skill 列表')).length, 'Applying a saved view did not restore the real filter.');
  await invoke(app, '编辑视图'); await field(app, '视图名称', renamed); await invoke(app, '保存视图'); await text(app, '视图已保存。');
  const rows = await wait(() => readViews(fixture), rows => rows.some(row => row.id === view.id && row.name === renamed && row.revision > view.revision), 'renamed view persisted');
  const after = rows.find(row => row.id === view.id);
  assert(JSON.stringify(after.filters) === JSON.stringify(view.filters), 'Renaming the saved view changed its preserved filters.');
  await field(app, '搜索 Skill', ''); await listNames(app, fixture.skills.map(skill => skill.displayName));
  return { id: view.id, query, nameBefore: name, nameAfter: renamed, revisionBefore: view.revision, revisionAfter: after.revision, appliedFilterObservedInRealList: true, renamePreservedFilters: true };
}
async function annotationFlow(app, fixture) {
  const skill = fixture.skills[0], alias = 'Native alias 0000', notes = '生成的个人备注；验证保存与搜索，不修改 Skill 源文。';
  await invoke(app, skill.displayName, '可横向滚动的 Skill 列表');
  await wait(() => controls(app, 'Skill 详情'), rows => rows.some(row => row.type === 'ControlType.Tab'), 'real Skill detail');
  await invoke(app, '别名与备注', 'Skill 别名与备注');
  await field(app, 'Skill 别名', alias); await field(app, 'Skill 备注', notes); await invoke(app, '保存别名与备注'); await text(app, '别名与备注已保存。');
  const row = await wait(() => readAnnotation(fixture, skill.id), row => row?.alias === alias && row.notes === notes && row.revision > 0, 'alias and complete note persisted from UI');
  await app.call('tab', { home: true }); await listNames(app, [alias, ...fixture.skills.slice(1).map(item => item.displayName)]);
  await field(app, '搜索 Skill', notes); await listNames(app, [alias]);
  assert(!(await controls(app, fixture.skills[1].displayName, '可横向滚动的 Skill 列表')).length, 'Persisted personal note did not drive actual list search.');
  await field(app, '搜索 Skill', ''); await listNames(app, [alias, ...fixture.skills.slice(1).map(item => item.displayName)]);
  return { skillId: skill.id, alias: row.alias, notes: row.notes, revision: row.revision, aliasObservedInRealList: true, noteSearchObservedInRealList: true };
}
async function favoriteHistoryFlow(app, fixture) {
  const skill = fixture.skills[2], before = readState(fixture);
  assert(!before.skills.find(item => item.id === skill.id).favorite, 'Favorite round trip requires the prepared false starting value.');
  async function observe(value) {
    await wait(() => readState(fixture).skills.find(item => item.id === skill.id).favorite, result => result === value, 'favorite state committed');
    await enabled(app, `${value ? '取消收藏' : '收藏'} ${skill.displayName}`, '可横向滚动的 Skill 列表');
  }
  await invoke(app, `收藏 ${skill.displayName}`, '可横向滚动的 Skill 列表'); await observe(true);
  await invoke(app, '撤销管理操作', '管理操作历史'); await observe(false);
  await invoke(app, '重做管理操作', '管理操作历史'); await observe(true);
  const after = readState(fixture);
  assert(after.skills.filter(item => item.id !== skill.id).every(item => item.favorite === before.skills.find(prior => prior.id === item.id).favorite), 'Favorite undo/redo affected another Skill.');
  return { skillId: skill.id, states: [false, true, false, true], undoAndRedoThroughRealButtons: true, otherSkillsUnchanged: true, keyboardShortcutVerified: false };
}

async function run(fixture) {
  assert(process.platform === 'win32', 'Native management verification requires Windows.');
  for (const key of ['candidate', 'candidate-build-info', 'expected-sha256']) assert(options[key], `Run requires --${key}.`);
  const executable = resolve(options.candidate), infoPath = resolve(options['candidate-build-info']);
  assert(/^[a-f0-9]{64}$/i.test(options['expected-sha256']), 'Pass the independently selected exact candidate SHA256.');
  const info = JSON.parse(await readFile(infoPath, 'utf8')), sha256 = await digest(executable);
  assert(info.buildMode === 'release' && sha256 === options['expected-sha256'].toLowerCase() && sha256 === info.executableSha256 && typeof info.sourceIdentity === 'string' && info.sourceIdentity.length > 40, 'Candidate release bytes/source identity differ.');
  const reportPath = join(fixture.root, 'management-result.json');
  try { await lstat(reportPath); throw new Error('This generated management fixture already has a run report; prepare a fresh fixture.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const harnessPaths = [fileURLToPath(import.meta.url), fileURLToPath(new URL('./native-uia-client.mjs', import.meta.url)), fileURLToPath(new URL('./verify-native-uia.ps1', import.meta.url))];
  const harness = await Promise.all(harnessPaths.map(async path => ({ path, sha256: await digest(path) })));
  const report = { formatVersion: 1, status: 'incomplete', syntheticOnly: true, fixture: fixture.root, candidate: { executable, sha256, sourceIdentity: info.sourceIdentity, infoPath, infoSha256: await digest(infoPath) }, harness, startedAt: new Date().toISOString(), flows: {}, limitations: ['Three management workflows only; not complete plan acceptance.', 'Native UIAutomation functional evidence; no latency, physical keyboard/IME, multiwindow, configuration file-dialog/import-export or invocation-template claim.', 'All post-launch SQLite access is read-only; no network sources, runnable tools, installation or cleanup.'] };
  let app;
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  try {
    app = await NativeUiaSession.launch({ executable, dataDir: fixture.dataDir, reportPath: join(fixture.root, 'native-driver.json'), sha256, accessibilityInput: true });
    report.native = app.identity;
    await listNames(app, fixture.skills.map(skill => skill.displayName));
    report.flows.savedView = await savedViewFlow(app, fixture); await writeFile(reportPath, JSON.stringify(report, null, 2));
    report.flows.annotation = await annotationFlow(app, fixture); await writeFile(reportPath, JSON.stringify(report, null, 2));
    report.flows.favoriteHistory = await favoriteHistoryFlow(app, fixture);
    const result = await app.quit(); report.closedNormally = result.driverReport.closedNormally; app = null;
    for (const file of fixture.sourceFiles) assert(await digest(file.path) === file.sha256, 'A management workflow changed generated Skill runtime contents.');
    report.runtimeSourceFilesUnchanged = true; report.status = 'passed-three-synthetic-native-management-workflows';
  } catch (error) { report.status = 'failed-or-blocked'; report.error = String(error); process.exitCode = 1; }
  finally {
    if (app) { try { const result = await app.quit(); report.closedNormally = result.driverReport.closedNormally; } catch (error) { report.normalExitError = String(error); report.status = 'failed-or-blocked'; process.exitCode = 1; } }
    report.harnessChangedDuringRun = (await Promise.all(harness.map(async item => await digest(item.path) !== item.sha256))).some(Boolean);
    if (report.harnessChangedDuringRun) { report.status = 'failed'; report.error = 'The native management harness changed during this run.'; process.exitCode = 1; }
    report.finishedAt = new Date().toISOString(); await writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, report: reportPath, error: report.error || null }));
  }
}

if (phase === 'prepare') {
  const fixture = await prepare();
  console.log(JSON.stringify({ status: 'synthetic-management-inputs-prepared-no-GUI-run', fixture: join(fixture.root, 'dataset.json'), skillCount: fixture.skillCount, sourceFiles: fixture.sourceFiles.length }));
} else {
  assert(options.fixture, 'Run requires the exact --fixture dataset.json.');
  await run(await readFixture(options.fixture));
}
