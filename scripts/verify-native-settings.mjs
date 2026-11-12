import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { NativeUiaSession } from './native-uia-client.mjs';

// All runtime writes are real UI actions. SQLite is writable only while creating
// a new inert fixture. The auxiliary UIA read below never focuses or writes.
const FORMAT = 'agent-resource-manager-native-settings-v1';
const DRIVER_FORMAT = 'agent-resource-manager-native-performance-v1';
const validation = 'D:\\03_github_projects\\Agent_Resource_Manager\\validation';
const dataParent = join(validation, 'manager-data'), resourceParent = join(validation, 'resources');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, flag, index, all) => flag.startsWith('--') ? [...pairs, [flag.slice(2), all[index + 1]]] : pairs, []));
const phase = args.phase;
const extendedScenario = 'problems-shared-space';
assert.ok(args.scenario === undefined || args.scenario === extendedScenario, 'Unsupported settings scenario.');
if (process.argv.includes('--help')) {
  console.log('Prepare: --phase prepare [--scenario problems-shared-space]. Native run: --phase run --prepared <dataset.json> --candidate <release.exe> --candidate-build-info <json> [--scenario problems-shared-space]. The opt-in scenario adds failed-history grouping/redaction, two consumers of one shared dependency and a documented depth-limit partial scan. No clipboard, network, tool invocation, basic-mode, configuration-transfer or complete-plan claim.');
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
  'Native synthetic diagnostics preview and single-Skill space only; not complete-plan or performance acceptance.',
  'Basic mode is not launched by this script. No ordinary-mode fixture is treated as basic mode.',
  'Diagnostic copying is not invoked or verified; the shared clipboard is neither read nor overwritten.',
  'The diagnostic fixture has no failed task history; failed-task error redaction is not claimed.',
  'No configuration file dialogs, transfer round-trip, invocation templates, result-file opening, shared dependencies or system-owned resources are verified.',
];

async function prepare() {
  assert.ok(!args.prepared && !args.candidate && !args['candidate-build-info'], 'Preparation accepts no existing data or program.');
  await mkdir(dataParent, { recursive: true }); await mkdir(resourceParent, { recursive: true });
  const root = await mkdtemp(join(dataParent, 'native-settings-'));
  const resourcesRoot = await mkdtemp(join(resourceParent, 'native-settings-'));
  const dataDir = join(root, 'data'), dbPath = join(dataDir, 'manager.sqlite3'); await mkdir(dataDir);
  const extended = args.scenario === extendedScenario;
  const createdAt = new Date().toISOString(), skills = [], sourceFiles = [];
  for (let index = 0; index < (extended ? 3 : 2); index++) {
    const key = String(index).padStart(4, '0'), id = `perf-skill-${key}`, localPath = join(resourcesRoot, id); await mkdir(localPath);
    const contents = [{ relative: 'SKILL.md', text: `---\nname: ${id}\ndescription: Inert generated native settings fixture.\nmetadata:\n  version: "1.0.0"\n---\n\n# Perf Skill ${key}\n\nGenerated text only. NATIVE_SETTINGS_FILE_CONTENT_MARKER_${key}.\n` }];
    if (index === 0) contents.push({ relative: 'README.md', text: 'Generated optional description. NATIVE_SETTINGS_OPTIONAL_CONTENT_MARKER.\n' }, { relative: 'local.txt', text: 'Generated additional local text. NATIVE_SETTINGS_LOCAL_CONTENT_MARKER.\n' });
    for (const file of contents) {
      const bytes = Buffer.from(file.text), path = join(localPath, file.relative); await writeFile(path, bytes, { flag: 'wx' });
      sourceFiles.push({ path, skillId: id, relative: file.relative, bytes: bytes.length, sha256: hash(bytes) });
    }
    skills.push({ id, name: id, displayName: `Perf Skill ${key}`, description: 'Generated settings acceptance text; no execution or external source.', localPath, status: 'local_only', version: '1.0.0', runtimeFiles: ['SKILL.md'], runtimeConfirmed: true, runtimeAudit: { status: 'verified', warnings: [], checkedAt: createdAt }, runtimeWarnings: [], runtimeIssues: [], localHashes: { 'SKILL.md': hash(contents[0].text) }, favorite: false, readOnly: false });
  }
  const history = extended ? [0, 1, 2].map(index => ({
    id: `native-settings-history-${index}`, action: 'check_now',
    label: `NATIVE_SETTINGS_LABEL_MARKER_${index}`, status: index < 2 ? 'failed' : 'succeeded',
    stage: `读取 NATIVE_SETTINGS_STAGE_MARKER_${index}`,
    createdAt, startedAt: createdAt, finishedAt: createdAt,
    origin: { sourceId: 'synthetic-settings-source', view: 'changes', skillId: skills[index].id },
    cancellable: false, resources: [],
    ...(index < 2 ? { error: `HTTP 429 rate limit NATIVE_SETTINGS_ERROR_MARKER_${index} github_pat_SYNTHETIC_ONLY ${join(resourcesRoot, 'PRIVATE_PATH_MARKER')}` } : {}),
  })) : [];
  // Empty directories exercise the real depth bound without inaccessible ACLs,
  // reparse points, excessive file counts or additional file-content fixtures.
  const partialDirectory = extended ? join(skills[0].localPath, ...Array(65).fill('d')) : undefined;
  if (partialDirectory) await mkdir(partialDirectory, { recursive: true });
  const state = { skills, sources: [], connections: [], localRoots: [], ignoredLocalPaths: [], checkMode: 'manual', checkGeneration: 0, checkSummary: null, stateRevision: 1, settings: { checkIntervalMinutes: 30, uiTheme: 'dark', uiZoom: 100, uiFontSize: 18, uiDensity: 'comfortable', uiAccent: 'violet', uiMotion: 'off', libraryMode: 'list', libraryPageSize: 20, librarySort: 'name', categories: [], sidebarWidth: 224, sidebarCollapsed: false } };
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE app_state(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,payload TEXT NOT NULL); CREATE TABLE workspace_state(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);');
    db.prepare('INSERT INTO app_state VALUES(1,1,?)').run(JSON.stringify(state));
    if (extended) {
      db.exec('CREATE TABLE task_history(id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE resource_relations(id TEXT PRIMARY KEY,dependent_kind TEXT NOT NULL,dependent_id TEXT NOT NULL,dependency_kind TEXT NOT NULL,dependency_id TEXT NOT NULL,created_at TEXT NOT NULL); CREATE TABLE resource_relations_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);');
      const insertTask = db.prepare('INSERT INTO task_history VALUES(?,?)');
      for (const item of history) insertTask.run(item.id, JSON.stringify(item));
      const insertRelation = db.prepare('INSERT INTO resource_relations VALUES(?,?,?,?,?,?)');
      for (const skill of skills.slice(0, 2)) insertRelation.run(`settings-edge-${skill.id}`, 'skill', skill.id, 'skill', skills[2].id, createdAt);
      db.prepare('INSERT INTO resource_relations_meta VALUES(1,2)').run();
    }
  } finally { db.close(); }
  const fixture = { format: FORMAT, driverFormat: DRIVER_FORMAT, syntheticOnly: true, root, resourcesRoot, dataDir, dbPath, skillCount: skills.length, toolCount: 0, skills, sourceFiles, ...(extended ? { scenario: extendedScenario, history, partialDirectory } : {}), initialDatabaseSha256: await digest(dbPath), createdAt };
  await writeFile(join(root, 'fixture-owner.json'), json({ format: DRIVER_FORMAT, settingsFormat: FORMAT, syntheticOnly: true }));
  await writeFile(join(resourcesRoot, 'fixture-owner.json'), json({ format: FORMAT, syntheticOnly: true, dataRoot: root }));
  await writeFile(join(root, 'dataset.json'), json(fixture));
  return fixture;
}
async function verifyFiles(fixture) {
  for (const file of fixture.sourceFiles) {
    assert.ok(inside(file.path, fixture.resourcesRoot)); assert.ok(same(await realpath(file.path), file.path));
    const bytes = await readFile(file.path); assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256);
  }
}
function persisted(fixture) {
  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try { return JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload); } finally { db.close(); }
}
function relations(fixture) {
  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try { return db.prepare('SELECT dependent_kind AS dependentKind,dependent_id AS dependentId,dependency_kind AS dependencyKind,dependency_id AS dependencyId FROM resource_relations ORDER BY dependent_id').all().map(row => ({ ...row })); }
  finally { db.close(); }
}
async function readFixture(path) {
  const descriptor = resolve(path); assert.ok(inside(descriptor, dataParent) && basename(descriptor) === 'dataset.json');
  const fixture = JSON.parse(await readFile(descriptor, 'utf8'));
  assert.equal(fixture.format, FORMAT); assert.equal(fixture.driverFormat, DRIVER_FORMAT); assert.equal(fixture.syntheticOnly, true);
  assert.ok(same(dirname(descriptor), fixture.root) && inside(fixture.root, dataParent) && inside(fixture.resourcesRoot, resourceParent));
  assert.ok(same(fixture.dataDir, join(fixture.root, 'data')) && same(fixture.dbPath, join(fixture.dataDir, 'manager.sqlite3')));
  assert.equal(fixture.scenario, args.scenario, 'Prepare and run must select the same explicit scenario.');
  const extended = fixture.scenario === extendedScenario;
  assert.equal(fixture.skillCount, extended ? 3 : 2); assert.equal(fixture.toolCount, 0); assert.equal(fixture.skills.length, fixture.skillCount); assert.equal(fixture.sourceFiles.length, extended ? 5 : 4);
  for (const directory of [fixture.root, fixture.resourcesRoot, fixture.dataDir]) assert.ok(same(await realpath(directory), directory));
  const owner = JSON.parse(await readFile(join(fixture.root, 'fixture-owner.json'), 'utf8'));
  assert.equal(owner.format, DRIVER_FORMAT); assert.equal(owner.settingsFormat, FORMAT); assert.equal(owner.syntheticOnly, true);
  assert.equal(await digest(fixture.dbPath), fixture.initialDatabaseSha256, 'A partially run database is never replayed.');
  if (extended) {
    assert.ok(same(fixture.partialDirectory, join(fixture.skills[0].localPath, ...Array(65).fill('d'))));
    assert.ok(same(await realpath(fixture.partialDirectory), fixture.partialDirectory));
    assert.equal(fixture.history.length, 3);
    assert.deepEqual(relations(fixture), fixture.skills.slice(0, 2).map(skill => ({ dependentKind: 'skill', dependentId: skill.id, dependencyKind: 'skill', dependencyId: fixture.skills[2].id })));
  }
  assert.deepEqual(persisted(fixture).skills, fixture.skills); await verifyFiles(fixture); return fixture;
}
async function candidate() {
  assert.equal(typeof args.candidate, 'string'); assert.equal(typeof args['candidate-build-info'], 'string');
  const path = resolve(args.candidate), buildInfoPath = resolve(args['candidate-build-info']);
  assert.equal(basename(path).toLowerCase(), 'agent-resource-manager.exe');
  const bytes = await readFile(path), offset = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.readUInt16LE(0), 0x5a4d); assert.equal(bytes.readUInt32LE(offset), 0x4550); assert.equal(bytes.readUInt16LE(offset + 4), 0x8664);
  const sha256 = hash(bytes), info = JSON.parse(await readFile(buildInfoPath, 'utf8'));
  assert.equal(info.buildMode, 'release'); assert.equal((info.executableSha256 || info.sha256)?.toLowerCase(), sha256); assert.ok(info.sourceIdentity || info.sourceCommit);
  assert.equal(typeof info.version, 'string', 'Diagnostic version checks need the explicit candidate version.');
  return { path, sha256, buildInfoPath, buildInfoSha256: await digest(buildInfoPath), sourceIdentity: info.sourceIdentity || info.sourceCommit, version: info.version };
}
async function wait(read, accepts, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) { const value = await read(); if (accepts(value)) return value; assert.ok(Date.now() < deadline, `Native settings observation unavailable: ${description}. No action was replayed.`); await sleep(40); }
}
async function control(app, name, type = 'ControlType.Button', scope) {
  const rows = list(await app.call('state', { name, ...(scope ? { scope } : {}) })).filter(row => row.type === type && row.enabled);
  assert.ok(rows.length <= 1, `Ambiguous native control: ${name}.`); return rows.length === 1;
}
async function invoke(app, name, scope) {
  await wait(() => control(app, name, 'ControlType.Button', scope), value => value, name);
  return app.call('invokeName', { name, ...(scope ? { scope } : {}) });
}
let selectedSettingsGroup = '常规';
async function settings(app, group) {
  await invoke(app, '设置', '主要导航');
  // The narrow-window outline does not exist until its disclosure is opened.
  // Observe the group without that scope, then require the exact scoped action.
  if (!await control(app, group, 'ControlType.Button')) {
    await invoke(app, `设置分类：${selectedSettingsGroup}`);
  }
  await invoke(app, group, '设置分类');
  selectedSettingsGroup = group;
}
async function task(app, button, action) {
  const old = new Set((await app.call('tasks')).tasks.map(item => item.id)); await invoke(app, button);
  const created = await wait(() => app.call('tasks'), value => value.tasks.some(item => !old.has(item.id) && item.action === action), action);
  const matches = created.tasks.filter(item => !old.has(item.id) && item.action === action); assert.equal(matches.length, 1);
  const done = (await wait(() => app.call('task', { taskId: matches[0].id }), value => value.task && !['queued', 'running'].includes(value.task.status), `${action} completion`, 45000)).task;
  assert.equal(done.status, 'succeeded', done.error || `Native ${action} failed.`);
  report.actions.push({ taskId: done.id, action, status: done.status }); return done.result;
}

// Read exactly one owned, visible, read-only UI field. Encoded fixed arguments
// avoid shell interpolation. This helper neither changes focus nor invokes UI.
async function readPreview(app, temporary) {
  const payload = Buffer.from(JSON.stringify({ pid: app.identity.pid, created: app.identity.creationFileTime, handle: app.identity.windowHandle })).toString('base64');
  const command = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Add-Type -AssemblyName UIAutomationClient;Add-Type -AssemblyName UIAutomationTypes;$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json;$owned=Get-Process -Id $p.pid;if($owned.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne $p.created){throw 'Owned native process identity changed.'};$root=[Windows.Automation.AutomationElement]::FromHandle([IntPtr]([long]$p.handle));if($root.Current.ProcessId -ne $p.pid){throw 'Owned native window identity changed.'};$conditions=[Windows.Automation.Condition[]]@([Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,'可复制的诊断摘要'),[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Edit),[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::IsOffscreenProperty,$false));$fields=$root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.AndCondition]::new($conditions));if($fields.Count -ne 1){throw 'Exact owned diagnostic preview is not unique and visible.'};$value=$fields[0].GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern);if(-not $value.Current.IsReadOnly){throw 'Diagnostic preview is not read-only.'};$text=$value.Current.Value;if($text.Length -gt 65536){throw 'Synthetic diagnostic preview is unexpectedly large.'};[pscustomobject]@{value=$text;readOnly=$true;pid=$p.pid;handle=$p.handle;noInput=$true}|ConvertTo-Json -Compress`;
  const { stdout } = await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, timeout: 20000, maxBuffer: 256 * 1024, env: { ...process.env, TEMP: temporary, TMP: temporary } });
  return JSON.parse(stdout.trim());
}
async function problems(app, fixture) {
  const group = '请求受到限流 · 同一来源或资源 2 项记录';
  const next = '等待限制解除后再检查，不连续重试。';
  await invoke(app, '操作记录'); await invoke(app, '查看全部记录');
  await wait(() => control(app, '搜索操作记录', 'ControlType.Edit'), value => value, 'full native history page');
  await invoke(app, group, '重复问题归并');
  await wait(() => app.call('state', { name: next, scope: '重复问题归并' }), rows => list(rows).some(row => !row.offscreen), 'group-specific next step');
  for (const item of fixture.history) {
    const rows = list(await app.call('state', { name: item.label }));
    assert.equal(rows.length, 1, 'The original history row must remain individually visible in the accessibility tree.');
    if (rows[0].offscreen) await app.call('reveal', { name: item.label });
    await wait(() => app.call('state', { name: item.label }), rows => list(rows).some(row => !row.offscreen), `retained task ${item.id}`);
  }
  const tasks = (await app.call('tasks')).tasks;
  for (const original of fixture.history) {
    const retained = tasks.find(item => item.id === original.id); assert.ok(retained);
    for (const key of ['action', 'label', 'status', 'stage', 'error', 'origin']) assert.deepEqual(retained[key], original[key]);
  }
  assert.equal(tasks.filter(item => fixture.history.some(original => original.id === item.id) && item.status === 'failed').length, 2);
  await invoke(app, '返回工作台');
  return { sameSourceFailureGroupSize: 2, successfulRecordExcludedFromGroup: true, exactNextStepVisible: true, originalFailuresAndSuccessRetained: true, networkRetryRequested: false };
}
async function diagnostics(app, fixture, info) {
  await settings(app, '诊断'); assert.equal(await control(app, '可复制的诊断摘要', 'ControlType.Edit'), false);
  const before = new Set((await app.call('tasks')).tasks.map(item => item.id)); await invoke(app, '生成诊断预览');
  await wait(() => control(app, '可复制的诊断摘要', 'ControlType.Edit'), value => value, 'diagnostic preview');
  const preview = await readPreview(app, join(fixture.root, 'driver-temp'));
  assert.equal(preview.pid, app.identity.pid); assert.equal(preview.readOnly, true); assert.equal(preview.noInput, true);
  assert.ok(preview.value.startsWith('Agent 资源管理器 · 诊断摘要\n'));
  assert.ok(preview.value.includes(`程序自报版本：${info.version}`)); assert.ok(preview.value.includes('运行模式：普通模式'));
  assert.ok(preview.value.includes(`已登记 Skill：${fixture.skillCount}；来源异常：0`));
  assert.ok(preview.value.includes('原生界面性能：此摘要未采样。'));
  assert.ok(!preview.value.includes('NATIVE_SETTINGS_') && !preview.value.includes(fixture.root) && !preview.value.includes(fixture.resourcesRoot));
  if (fixture.scenario === extendedScenario) {
    assert.ok(preview.value.includes('需核对：2'));
    assert.equal(preview.value.split('请求受到限流；阶段：读取或核对；等待限制解除后再检查，不连续重试。').length - 1, 2);
    assert.ok(!preview.value.includes('github_pat_SYNTHETIC_ONLY') && !preview.value.includes('PRIVATE_PATH_MARKER'));
  }
  assert.ok((await app.call('tasks')).tasks.every(item => before.has(item.id)), 'Generating a local diagnostic preview unexpectedly created a backend task.');
  assert.equal(await control(app, '复制当前摘要'), true);
  return { nativePreviewGenerated: true, nativeReadOnlyTextVerified: true, exactVersionAndCounts: true, fixturePathsAndContentExcluded: true, ...(fixture.scenario === extendedScenario ? { rawFailedTaskMarkersExcluded: true, bothSafeProblemCategoriesAndNextStepsIncluded: true } : {}), noBackendTaskCreated: true, copyAvailableNotInvoked: true, previewSha256: hash(preview.value) };
}
async function space(app, fixture, targetIndex = 0) {
  if (targetIndex > 0) await invoke(app, '返回工作台');
  await invoke(app, 'Skills', '主要导航'); await invoke(app, fixture.skills[targetIndex].displayName, '可横向滚动的 Skill 列表');
  const before = (await app.call('tasks')).tasks.filter(item => item.action === 'resource_space').length;
  assert.equal(before, targetIndex * 2, 'Space measurement ran before its explicit UI action.');
  await invoke(app, '空间明细'); await wait(() => control(app, '统计本目录空间'), value => value, 'expanded space panel');
  assert.equal((await app.call('tasks')).tasks.filter(item => item.action === 'resource_space').length, before, 'Expanding the space panel unexpectedly scanned files.');
  const target = fixture.skills[targetIndex], files = fixture.sourceFiles.filter(file => file.skillId === target.id);
  const extended = fixture.scenario === extendedScenario, partial = extended && targetIndex === 0;
  const check = value => {
    assert.deepEqual(value.endpoint, { kind: 'skill', id: target.id }); assert.ok(same(value.rootPath, target.localPath));
    assert.equal(value.scope, 'singleRoot'); assert.equal(value.rootCount, 1); assert.equal(value.partial, partial); assert.equal(value.skippedCount, partial ? 1 : 0);
    assert.equal(value.observedBytes, files.reduce((sum, file) => sum + file.bytes, 0)); assert.equal(value.fileCount, files.length);
    const runtime = value.categories.find(row => row.id === 'runtime'), unknown = value.categories.find(row => row.id === 'unknown'), previous = value.categories.find(row => row.id === 'previous');
    assert.equal(runtime.bytes, files.find(file => file.relative === 'SKILL.md').bytes); assert.equal(runtime.files, 1);
    assert.equal(unknown.bytes, files.filter(file => file.relative !== 'SKILL.md').reduce((sum, file) => sum + file.bytes, 0)); assert.equal(unknown.files, files.length - 1);
    assert.equal(previous.bytes, null); assert.equal(previous.files, null);
    assert.deepEqual(value.sharedDependencies, extended ? [{ kind: 'skill', id: fixture.skills[2].id, name: fixture.skills[2].displayName, exists: true }] : []);
    if (partial) assert.deepEqual(value.reasons, ['部分目录层级过深，未继续读取']);
  };
  const measured = await task(app, '统计本目录空间', 'resource_space'); check(measured);
  await wait(() => control(app, '重新统计'), value => value, 'space result refresh action');
  const labels = ['按已有用途记录分类', '当前运行文件与许可', '未识别用途'];
  if (partial) {
    labels.push('已读取部分', '部分目录层级过深，未继续读取');
  }
  // React interpolations are separate accessibility text nodes. Match their
  // actual boundaries rather than inventing one combined accessible name.
  if (extended) labels.push('共享依赖：', fixture.skills[2].displayName, '。只计量本次范围内实际读取的文件，共享目录不额外叠加。');
  for (const name of labels) {
    const current = list(await app.call('state', { name }));
    if (!current.some(row => !row.offscreen)) {
      assert.equal(current.length, 1, `The offscreen space target is not unique: ${name}.`);
      await app.call('reveal', { name });
    }
    await wait(() => app.call('state', { name }), rows => list(rows).some(row => !row.offscreen), name);
  }
  const repeated = await task(app, '重新统计', 'resource_space'); check(repeated);
  assert.equal((await app.call('tasks')).tasks.filter(item => item.action === 'resource_space').length, before + 2);
  const screenshot = join(fixture.root, targetIndex ? 'native-shared-space.png' : 'native-space.png');
  await app.call('screenshot', { path: screenshot });
  return { lazyUntilExplicitMeasure: true, exactRootBytesAndClassification: true, unknownPreviousVersionPreserved: true, explicitRefreshSameResult: true, ...(extended ? { sharedDependencyExcludedFromConsumerTotal: true, sharedDependencyId: fixture.skills[2].id, partialDepthLimitVerified: partial } : {}), measuredSkillId: target.id, observedBytes: measured.observedBytes, fileCount: measured.fileCount, screenshot };
}

if (phase === 'prepare') {
  const fixture = await prepare(); console.log(JSON.stringify({ status: 'prepared-not-run', fixture: join(fixture.root, 'dataset.json'), report: join(fixture.root, 'settings-result.json'), noNativeLaunch: true })); process.exit(0);
}
assert.equal(typeof args.prepared, 'string');
const fixture = await readFixture(args.prepared), info = await candidate(), reportPath = join(fixture.root, 'settings-result.json');
const extended = fixture.scenario === extendedScenario;
let app;
let report = { format: FORMAT, status: 'running', startedAt: new Date().toISOString(), candidate: info, fixture: resolve(args.prepared), syntheticOnly: true, limitations, actions: [], results: {}, inputMethod: 'native-accessibility-patterns' };
if (extended) {
  report.scenario = extendedScenario;
  report.limitations = limitations.filter(line => !line.startsWith('Native synthetic') && !line.startsWith('The diagnostic fixture') && !line.startsWith('No configuration'));
  report.limitations.push('Native historical failure grouping/redaction and two Skill consumers of one shared dependency only. Depth-limit partial accounting is covered, not ACL errors, links or directory races. No complete-plan or performance claim.', 'No configuration transfer, invocation templates, system-owned resources or clipboard copying are verified.');
}
try {
  report.harness = await Promise.all(['verify-native-settings.mjs', 'native-uia-client.mjs', 'verify-native-uia.ps1'].map(async name => ({ name, sha256: await digest(fileURLToPath(new URL(name, import.meta.url))) })));
  await writeFile(reportPath, json(report), { flag: 'wx' });
  app = await NativeUiaSession.launch({ executable: info.path, dataDir: fixture.dataDir, reportPath: join(fixture.root, 'native-driver.json'), sha256: info.sha256, accessibilityInput: true }); report.native = app.identity;
  assert.equal(app.identity.executableSha256, info.sha256); assert.ok(same(app.identity.dataDirectory, fixture.dataDir));
  if (extended) { report.results.problems = await problems(app, fixture); await writeFile(reportPath, json(report)); }
  report.results.diagnostics = await diagnostics(app, fixture, info); await writeFile(reportPath, json(report));
  report.results.space = await space(app, fixture); await writeFile(reportPath, json(report));
  if (extended) { report.results.secondConsumerSpace = await space(app, fixture, 1); await writeFile(reportPath, json(report)); }
  if (extended) {
    assert.deepEqual(relations(fixture), fixture.skills.slice(0, 2).map(skill => ({ dependentKind: 'skill', dependentId: skill.id, dependencyKind: 'skill', dependencyId: fixture.skills[2].id })));
    report.sharedRelationsUnchanged = true;
  }
  const after = persisted(fixture); assert.equal(after.checkMode, 'manual');
  for (const key of ['sources', 'connections', 'localRoots']) assert.equal(after[key].length, 0);
  for (const original of fixture.skills) { const value = after.skills.find(skill => skill.id === original.id); for (const [key, item] of Object.entries(original)) assert.deepEqual(value[key], item, `Synthetic Skill ${key} changed.`); }
  const observed = (await app.call('tasks')).tasks;
  const seededIds = new Set((fixture.history || []).map(item => item.id));
  assert.ok(observed.filter(item => !seededIds.has(item.id)).every(item => ['resource_space', 'management_data'].includes(item.action)), 'A mutable or unrelated backend action was observed.');
  for (const original of fixture.history || []) {
    const retained = observed.find(item => item.id === original.id); assert.ok(retained, 'A retained failure or unrelated success disappeared.');
    for (const key of ['action', 'label', 'status', 'stage', 'error', 'origin']) assert.deepEqual(retained[key], original[key]);
  }
  report.readOnlyManagementReads = [];
  for (const original of observed.filter(item => item.action === 'management_data')) {
    const done = (await wait(() => app.call('task', { taskId: original.id }), value => value.task && !['queued', 'running'].includes(value.task.status), 'read-only personal management information')).task;
    assert.equal(done.status, 'succeeded', done.error || 'The existing personal-information read did not succeed.');
    assert.equal(done.result.revision, 0); assert.deepEqual(done.result.skillAnnotations, []); assert.deepEqual(done.result.savedViews, []);
    report.readOnlyManagementReads.push({ taskId: done.id, status: done.status, revision: done.result.revision, skillAnnotationCount: 0, savedViewCount: 0 });
  }
  await verifyFiles(fixture); report.generatedResourceFilesUnchanged = true;
  report.normalExit = (await app.quit()).driverReport.closedNormally; app = null;
  await verifyFiles(fixture);
  for (const file of report.harness) assert.equal(await digest(fileURLToPath(new URL(file.name, import.meta.url))), file.sha256, 'A native helper changed during this run.');
  assert.equal(await digest(info.path), info.sha256); assert.equal(await digest(info.buildInfoPath), info.buildInfoSha256);
  report.status = extended ? 'passed-native-problem-grouping-redaction-and-shared-space-scope' : 'passed-native-diagnostics-preview-and-skill-space-only';
} catch (error) {
  report.status = 'failed-or-blocked'; report.error = String(error); process.exitCode = 1;
  if (app && !app.exited && !app.operationError) {
    try {
      const path = join(fixture.root, 'settings-failure.png');
      await app.call('screenshot', { path }); report.failureScreenshot = path;
    } catch (captureError) { report.failureScreenshotError = String(captureError); }
  }
}
finally {
  if (app) { try { report.normalExit = (await app.quit()).driverReport.closedNormally; } catch (error) { report.normalExit = false; report.closeError = String(error); } }
  report.finishedAt = new Date().toISOString(); await writeFile(reportPath, json(report));
}
console.log(JSON.stringify({ status: report.status, report: reportPath, normalExit: report.normalExit }));
