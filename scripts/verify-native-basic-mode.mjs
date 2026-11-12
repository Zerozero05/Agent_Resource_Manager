import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { NativeUiaSession } from './native-uia-client.mjs';

// A valid legacy SQLite database is deliberately missing the optional tables.
// It is not a corrupt database, nor is a stored basicMode flag used as evidence.
const FORMAT = 'agent-resource-manager-native-basic-mode-v1';
const DRIVER_FORMAT = 'agent-resource-manager-native-performance-v1';
const validation = 'D:\\03_github_projects\\Agent_Resource_Manager\\validation';
const dataParent = join(validation, 'manager-data'), resourceParent = join(validation, 'resources');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, flag, index, all) => flag.startsWith('--') ? [...pairs, [flag.slice(2), all[index + 1]]] : pairs, []));
const phase = args.phase;
if (process.argv.includes('--help')) {
  console.log('Prepare: --phase prepare. Native run: --phase run --prepared <dataset.json> --candidate <release.exe> --candidate-build-info <json>. Explicitly launches --basic-mode via the shared native driver. Requires its basicModeRequested ready/report field. Verifies actual read-only mode, two registered Skills and document browsing, disabled maintenance/configuration writes, diagnostic content and unchanged legacy SQLite bytes/schema/payload/resources. No clipboard, network, mutation shortcut or corrupt-database recovery claim.');
  process.exit(0);
}
assert.ok(['prepare', 'run'].includes(phase), 'Use --phase prepare or --phase run.');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = async path => hash(await readFile(path));
const normalized = path => resolve(path.replace(/^\\\\\?\\(?=[a-z]:\\)/i, ''));
const same = (left, right) => normalized(left).toLowerCase() === normalized(right).toLowerCase();
const inside = (path, root) => { const value = relative(normalized(root), normalized(path)); return value === '' || !value.startsWith('..') && !isAbsolute(value); };
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const json = value => JSON.stringify(value, null, 2) + '\n';
const sleep = ms => new Promise(done => setTimeout(done, ms));
const execute = promisify(execFile);
const limitations = [
  'Real native basic-mode startup and read-only browsing of a valid old-schema database only; not formal migration or complete-plan acceptance.',
  'A physically corrupt SQLite file or invalid app_state JSON is expected to reject startup and cannot be browsed. Those failure-dialog and refusal flows are not run here.',
  'Disabled visible controls are observed without forcing invocation. Backend rejection of forged or nested writes is covered separately by existing Rust tests.',
  'No credential or clipboard access, tool invocation, network request, installation, file deletion or repair is requested.',
  'No timing, IME, multi-window conflict, real private data or unavailable-table repair claim.',
];

function databaseSnapshot(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all().map(row => ({ ...row }));
    const payload = db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload;
    assert.deepEqual(db.prepare('PRAGMA quick_check').all().map(row => Object.values(row)[0]), ['ok']);
    return { schema, payload };
  } finally { db.close(); }
}
async function prepare() {
  assert.ok(!args.prepared && !args.candidate && !args['candidate-build-info'], 'Preparation accepts no existing data or executable.');
  await mkdir(dataParent, { recursive: true }); await mkdir(resourceParent, { recursive: true });
  const root = await mkdtemp(join(dataParent, 'native-basic-mode-'));
  const resourcesRoot = await mkdtemp(join(resourceParent, 'native-basic-mode-'));
  const dataDir = join(root, 'data'), dbPath = join(dataDir, 'manager.sqlite3'); await mkdir(dataDir);
  const createdAt = new Date().toISOString(), skills = [], sourceFiles = [];
  for (let index = 0; index < 2; index++) {
    const key = String(index).padStart(4, '0'), id = `perf-skill-${key}`, localPath = join(resourcesRoot, id); await mkdir(localPath);
    const contentMarker = `NATIVE_BASIC_MODE_DOCUMENT_${key}`;
    const bytes = Buffer.from(`---\nname: ${id}\ndescription: Generated native basic-mode fixture.\nmetadata:\n  version: "1.0.0"\n---\n\n# Perf Skill ${key}\n\n${contentMarker}\n\nGenerated inert text. No execution, network, shared rules or external references.\n`);
    const path = join(localPath, 'SKILL.md'); await writeFile(path, bytes, { flag: 'wx' });
    sourceFiles.push({ path, skillId: id, bytes: bytes.length, sha256: hash(bytes), contentMarker });
    skills.push({ id, name: id, displayName: `Perf Skill ${key}`, description: 'Generated original legacy Skill data.', localPath, status: 'local_only', version: '1.0.0', runtimeFiles: ['SKILL.md'], runtimeConfirmed: true, runtimeAudit: { status: 'verified', warnings: [], checkedAt: createdAt }, runtimeWarnings: [], runtimeIssues: [], localHashes: { 'SKILL.md': hash(bytes) }, favorite: false, readOnly: false });
  }
  const state = { skills, sources: [], connections: [], localRoots: [], ignoredLocalPaths: [], checkMode: 'auto', checkGeneration: 7, checkSummary: null, stateRevision: 9, settings: { checkIntervalMinutes: 30, uiTheme: 'dark', uiZoom: 100, uiFontSize: 18, uiDensity: 'comfortable', uiAccent: 'violet', uiMotion: 'off', libraryMode: 'list', libraryPageSize: 20, librarySort: 'name', categories: [], sidebarWidth: 224, sidebarCollapsed: false } };
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE app_state(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);');
    db.prepare('INSERT INTO app_state VALUES(1,?)').run(JSON.stringify(state));
  } finally { db.close(); }
  const fixture = { format: FORMAT, driverFormat: DRIVER_FORMAT, syntheticOnly: true, root, resourcesRoot, dataDir, dbPath, skillCount: 2, toolCount: 0, skills, sourceFiles, initialDatabaseSha256: await digest(dbPath), initialSnapshot: databaseSnapshot(dbPath), createdAt };
  assert.equal(fixture.initialSnapshot.schema.length, 1); assert.equal(fixture.initialSnapshot.schema[0].name, 'app_state');
  await writeFile(join(root, 'fixture-owner.json'), json({ format: DRIVER_FORMAT, basicModeFormat: FORMAT, syntheticOnly: true }));
  await writeFile(join(resourcesRoot, 'fixture-owner.json'), json({ format: FORMAT, syntheticOnly: true, dataRoot: root }));
  await writeFile(join(root, 'dataset.json'), json(fixture)); return fixture;
}
async function verifyInputs(fixture) {
  assert.equal(await digest(fixture.dbPath), fixture.initialDatabaseSha256, 'Basic mode changed the original SQLite bytes.');
  assert.deepEqual(databaseSnapshot(fixture.dbPath), fixture.initialSnapshot, 'Basic mode changed the legacy schema or state payload.');
  for (const suffix of ['-wal', '-shm', '-journal']) {
    await assert.rejects(lstat(fixture.dbPath + suffix), error => error.code === 'ENOENT', 'The old DELETE-mode fixture gained a SQLite write sidecar.');
  }
  for (const file of fixture.sourceFiles) {
    assert.ok(inside(file.path, fixture.resourcesRoot)); assert.ok(same(await realpath(file.path), file.path));
    const bytes = await readFile(file.path); assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256);
  }
}
async function readFixture(path) {
  const descriptor = resolve(path); assert.ok(inside(descriptor, dataParent) && basename(descriptor) === 'dataset.json');
  const fixture = JSON.parse(await readFile(descriptor, 'utf8'));
  assert.equal(fixture.format, FORMAT); assert.equal(fixture.driverFormat, DRIVER_FORMAT); assert.equal(fixture.syntheticOnly, true);
  assert.ok(same(dirname(descriptor), fixture.root) && inside(fixture.root, dataParent) && inside(fixture.resourcesRoot, resourceParent));
  assert.ok(same(fixture.dataDir, join(fixture.root, 'data')) && same(fixture.dbPath, join(fixture.dataDir, 'manager.sqlite3')));
  assert.equal(fixture.skillCount, 2); assert.equal(fixture.toolCount, 0); assert.equal(fixture.skills.length, 2); assert.equal(fixture.sourceFiles.length, 2);
  for (const directory of [fixture.root, fixture.resourcesRoot, fixture.dataDir]) assert.ok(same(await realpath(directory), directory));
  assert.ok(same(await realpath(fixture.dbPath), fixture.dbPath));
  const owner = JSON.parse(await readFile(join(fixture.root, 'fixture-owner.json'), 'utf8'));
  assert.equal(owner.format, DRIVER_FORMAT); assert.equal(owner.basicModeFormat, FORMAT); assert.equal(owner.syntheticOnly, true);
  assert.equal(JSON.parse(fixture.initialSnapshot.payload).checkMode, 'auto'); await verifyInputs(fixture); return fixture;
}
async function candidate() {
  assert.equal(typeof args.candidate, 'string'); assert.equal(typeof args['candidate-build-info'], 'string');
  const path = resolve(args.candidate), buildInfoPath = resolve(args['candidate-build-info']); assert.equal(basename(path).toLowerCase(), 'agent-resource-manager.exe');
  const bytes = await readFile(path), offset = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.readUInt16LE(0), 0x5a4d); assert.equal(bytes.readUInt32LE(offset), 0x4550); assert.equal(bytes.readUInt16LE(offset + 4), 0x8664);
  const sha256 = hash(bytes), info = JSON.parse(await readFile(buildInfoPath, 'utf8'));
  assert.equal(info.buildMode, 'release'); assert.equal((info.executableSha256 || info.sha256)?.toLowerCase(), sha256); assert.ok(info.sourceIdentity || info.sourceCommit); assert.equal(typeof info.version, 'string');
  return { path, sha256, buildInfoPath, buildInfoSha256: await digest(buildInfoPath), sourceIdentity: info.sourceIdentity || info.sourceCommit, version: info.version };
}
async function wait(read, accepts, description) {
  const deadline = Date.now() + 20000;
  for (;;) { const value = await read(); if (accepts(value)) return value; assert.ok(Date.now() < deadline, `Native basic-mode observation unavailable: ${description}. No action was replayed.`); await sleep(40); }
}
async function rows(app, name, type = 'ControlType.Button', scope) {
  return list(await app.call('state', { name, ...(scope ? { scope } : {}) })).filter(row => row.type === type);
}
async function invoke(app, name, scope) {
  await wait(() => rows(app, name, 'ControlType.Button', scope), value => value.length === 1 && value[0].enabled, name);
  return app.call('invokeName', { name, ...(scope ? { scope } : {}) });
}
async function disabled(app, name) {
  const values = await wait(() => rows(app, name), value => value.length > 0, name);
  assert.equal(values.length, 1, `Native basic-mode control is ambiguous: ${name}.`); assert.equal(values[0].enabled, false, `Basic-mode write control is enabled: ${name}.`);
}
let selectedSettingsGroup = '常规';
async function settings(app, group) {
  await invoke(app, '设置', '主要导航');
  if (!(await rows(app, group)).length) {
    await invoke(app, `设置分类：${selectedSettingsGroup}`);
  }
  await invoke(app, group, '设置分类');
  selectedSettingsGroup = group;
}
async function previewValue(app, temporary) {
  const encoded = Buffer.from(JSON.stringify({ pid: app.identity.pid, created: app.identity.creationFileTime, handle: app.identity.windowHandle })).toString('base64');
  const command = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json
$owned=Get-Process -Id $p.pid
if($owned.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne $p.created){throw 'Owned native process identity changed.'}
$root=[Windows.Automation.AutomationElement]::FromHandle([IntPtr]([long]$p.handle))
if($root.Current.ProcessId -ne $p.pid){throw 'Owned native window identity changed.'}
$conditions=[Windows.Automation.Condition[]]@(
  [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,'可复制的诊断摘要'),
  [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Edit),
  [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::IsOffscreenProperty,$false))
$fields=$root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.AndCondition]::new($conditions))
if($fields.Count -ne 1){throw 'Exact owned diagnostic preview is not unique and visible.'}
$value=$fields[0].GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
if(-not $value.Current.IsReadOnly){throw 'Diagnostic preview is not read-only.'}
$text=$value.Current.Value
if($text.Length -gt 65536){throw 'Synthetic diagnostic preview is unexpectedly large.'}
[pscustomobject]@{value=$text;readOnly=$true;pid=$p.pid;noInput=$true}|ConvertTo-Json -Compress`;
  const { stdout } = await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, timeout: 20000, maxBuffer: 256 * 1024, env: { ...process.env, TEMP: temporary, TMP: temporary } });
  return JSON.parse(stdout.trim());
}
async function verifyReadTasks(app) {
  const observed = (await app.call('tasks')).tasks;
  report.observedActions = observed.map(item => item.action);
  assert.ok(observed.every(item => ['get_document', 'management_data'].includes(item.action)), 'Unexpected automatic maintenance, mutable action or tool invocation in basic mode.');
  const evidence = new Map((report.readTaskEvidence || []).map(item => [item.taskId, item]));
  for (const original of observed) {
    const done = (await wait(() => app.call('task', { taskId: original.id }), value => value.task && !['queued', 'running'].includes(value.task.status), `${original.action} read-only completion`)).task;
    const record = { taskId: done.id, action: done.action, status: done.status, error: done.error || null };
    evidence.set(done.id, record); report.readTaskEvidence = [...evidence.values()];
    assert.equal(done.status, 'succeeded', done.error || `Basic-mode ${done.action} did not succeed.`);
    assert.ok(done.result && typeof done.result === 'object', 'The read-only task did not retain its actual result.');
    if (done.action === 'management_data') {
      assert.equal(done.result.revision, 0); assert.deepEqual(done.result.skillAnnotations, []); assert.deepEqual(done.result.savedViews, []);
      record.managementRevision = done.result.revision; record.skillAnnotationCount = 0; record.savedViewCount = 0;
    }
  }
}

if (phase === 'prepare') {
  const fixture = await prepare(); console.log(JSON.stringify({ status: 'prepared-not-run', fixture: join(fixture.root, 'dataset.json'), report: join(fixture.root, 'basic-mode-result.json'), noNativeLaunch: true })); process.exit(0);
}
assert.equal(typeof args.prepared, 'string');
const fixture = await readFixture(args.prepared), info = await candidate(), reportPath = join(fixture.root, 'basic-mode-result.json');
let app;
let report = { format: FORMAT, status: 'running', startedAt: new Date().toISOString(), candidate: info, fixture: resolve(args.prepared), syntheticOnly: true, basicModeRequested: true, limitations, results: {}, inputMethod: 'native-accessibility-patterns' };
try {
  report.harness = await Promise.all(['verify-native-basic-mode.mjs', 'native-uia-client.mjs', 'verify-native-uia.ps1'].map(async name => ({ name, sha256: await digest(fileURLToPath(new URL(name, import.meta.url))) })));
  await writeFile(reportPath, json(report), { flag: 'wx' });
  app = await NativeUiaSession.launch({ executable: info.path, dataDir: fixture.dataDir, reportPath: join(fixture.root, 'native-driver.json'), sha256: info.sha256, accessibilityInput: true, basicMode: true }); report.native = app.identity;
  assert.equal(app.identity.basicModeRequested, true, 'The shared native launcher did not confirm the requested --basic-mode flag.');
  assert.equal(app.identity.executableSha256, info.sha256); assert.ok(same(app.identity.dataDirectory, fixture.dataDir));
  for (const name of ['基本模式', '当前数据库没有工具目录；基本模式不会创建新表。']) {
    await wait(() => rows(app, name, 'ControlType.Text'), value => value.length === 1 && !value[0].offscreen, `actual basic-mode banner: ${name}`);
  }
  await disabled(app, '检查本地与 GitHub 变化'); await disabled(app, '检查方式');
  for (const skill of fixture.skills) {
    const values = await rows(app, skill.displayName, 'ControlType.Button', '可横向滚动的 Skill 列表'); assert.equal(values.length, 1); assert.equal(values[0].enabled, true);
  }
  await verifyInputs(fixture); report.results.startup = { actualBasicModeBanner: true, optionalCatalogueUnavailableExplicitly: true, originalAutoPolicyRetained: true, twoRegisteredRowsReadable: true, globalChecksDisabled: true, databaseUnchangedAfterStartup: true };
  await invoke(app, fixture.skills[0].displayName, '可横向滚动的 Skill 列表');
  const marker = fixture.sourceFiles[0].contentMarker;
  const documentText = await wait(() => rows(app, marker, 'ControlType.Text'), value => value.length === 1, 'rendered original local Skill document');
  if (documentText[0].offscreen) await app.call('reveal', { name: marker });
  await wait(() => rows(app, marker, 'ControlType.Text'), value => value.length === 1 && !value[0].offscreen, 'visible original local Skill document');
  report.results.browse = { originalLocalDocumentRendered: true, contentMarker: fixture.sourceFiles[0].contentMarker };
  await verifyReadTasks(app); await writeFile(reportPath, json(report));
  await invoke(app, '返回工作台'); await settings(app, '维护');
  for (const name of ['暂停自动维护', '恢复维护', '保存时间窗口']) await disabled(app, name);
  await settings(app, '配置导入导出'); await disabled(app, '预览导出配置'); await disabled(app, '选择配置文件');
  report.results.disabledWrites = { maintenancePauseResumeAndWindow: true, configurationImportExport: true, noForcedDisabledInvocation: true };
  await settings(app, '诊断'); await invoke(app, '生成诊断预览');
  await wait(() => rows(app, '可复制的诊断摘要', 'ControlType.Edit'), value => value.length === 1, 'read-only diagnostic field');
  const preview = await previewValue(app, join(fixture.root, 'driver-temp'));
  assert.equal(preview.pid, app.identity.pid); assert.equal(preview.readOnly, true); assert.equal(preview.noInput, true);
  assert.ok(preview.value.includes('运行模式：基本模式（只读）')); assert.ok(preview.value.includes(`程序自报版本：${info.version}`)); assert.ok(preview.value.includes('已登记 Skill：2；来源异常：0'));
  assert.ok(!preview.value.includes(fixture.root) && !preview.value.includes(fixture.resourcesRoot) && !preview.value.includes('NATIVE_BASIC_MODE_DOCUMENT_'));
  report.results.diagnostics = { actualBasicModeContentVerified: true, versionAndCountsVerified: true, previewSha256: hash(preview.value), clipboardNotAccessed: true };
  await verifyReadTasks(app);
  await verifyInputs(fixture); report.results.noAutomaticTasksObserved = true;
  await app.call('screenshot', { path: join(fixture.root, 'native-basic-mode.png') });
  const exit = await app.quit(); report.normalExit = exit.driverReport.closedNormally; assert.equal(exit.driverReport.basicModeRequested, true); app = null;
  await verifyInputs(fixture); report.databaseSchemaPayloadAndResourceBytesUnchanged = true;
  for (const file of report.harness) assert.equal(await digest(fileURLToPath(new URL(file.name, import.meta.url))), file.sha256, 'A native helper changed during this run.');
  assert.equal(await digest(info.path), info.sha256); assert.equal(await digest(info.buildInfoPath), info.buildInfoSha256);
  report.status = 'passed-native-basic-mode-legacy-readonly-synthetic-only';
} catch (error) {
  report.status = 'failed-or-blocked'; report.error = String(error); process.exitCode = 1;
  if (app && !app.exited && !app.operationError) {
    try {
      const path = join(fixture.root, 'basic-mode-failure.png');
      await app.call('screenshot', { path }); report.failureScreenshot = path;
    } catch (captureError) { report.failureScreenshotError = String(captureError); }
  }
}
finally {
  if (app) { try { report.normalExit = (await app.quit()).driverReport.closedNormally; } catch (error) { report.normalExit = false; report.closeError = String(error); } }
  report.finishedAt = new Date().toISOString(); await writeFile(reportPath, json(report));
}
console.log(JSON.stringify({ status: report.status, report: reportPath, normalExit: report.normalExit }));
