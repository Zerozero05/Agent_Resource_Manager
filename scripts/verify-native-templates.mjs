import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, toNamespacedPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { NativeUiaSession } from './native-uia-client.mjs';

// This fixture registers a real compiled, dedicated program but never invokes it.
// After preparation every template mutation must use the actual native UI.
const FORMAT = 'agent-resource-manager-native-templates-v1';
const DRIVER_FORMAT = 'agent-resource-manager-native-performance-v1';
const validation = 'D:\\03_github_projects\\Agent_Management\\Agent_Resource_Manager\\validation';
const dataParent = join(validation, 'manager-data'), resourceParent = join(validation, 'resources');
const rustc = 'D:\\03_github_projects\\Agent_Management\\Agent_Resource_Manager\\dev\\environment\\rust\\toolchain\\bin\\rustc.exe';
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, flag, index, all) => flag.startsWith('--') ? [...pairs, [flag.slice(2), all[index + 1]]] : pairs, []));
const phase = args.phase;
if (process.argv.includes('--help')) {
  console.log('Prepare source only: --phase prepare. Compile the inert generated probe and finish a fresh fixture: --phase compile --prepared <dataset.json>, with the existing project environment active. Native acceptance: --phase run --prepared <dataset.json> --candidate <release.exe> --candidate-build-info <json>. Covers actual UI template save/apply/edit/remove, prepared parameter values and untouched one-off fields. No tool invocation, network, clipboard, download, installation or production-data write. Compilation is a separate explicit phase.');
  process.exit(0);
}
assert.ok(['prepare', 'compile', 'run'].includes(phase), 'Use --phase prepare, compile or run.');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = async path => hash(await readFile(path));
const normalized = path => resolve(path.replace(/^\\\\\?\\(?=[a-z]:\\)/i, ''));
const same = (left, right) => normalized(left).toLowerCase() === normalized(right).toLowerCase();
const inside = (path, root) => { const value = relative(normalized(root), normalized(path)); return value === '' || !value.startsWith('..') && !isAbsolute(value); };
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const json = value => JSON.stringify(value, null, 2) + '\n';
const sleep = ms => new Promise(done => setTimeout(done, ms));
const execute = promisify(execFile);
const first = { name: 'Native reusable query', query: 'native ; $(literal) 中文', count: 3 };
const edited = { name: 'Native edited query', query: 'edited "two words" 中文', count: 7 };
const limitations = [
  'Focused actual native template save, prepare, replacement and deletion only; not complete-plan, invocation, result-file or performance acceptance.',
  'The fresh catalogue seeds one valid declarative parameter action because the existing action-registration form supports literal arguments only. Runtime template writes are exclusively actual UI operations.',
  'The dedicated generated Rust console program is compiled by the existing local compiler and identified by real PE/hash checks. It is never intentionally invoked.',
  'Expected argument vectors are resolved from the real prepared parameters and unchanged one-off field using the registered definition. No child process is executed and no executed argv claim is made.',
  'No template restart, incompatible-action revision, sensitive-field storage, concurrent edit or stale-template scenario is covered by this focused native check.',
];

async function absent(path) {
  await assert.rejects(lstat(path), error => error.code === 'ENOENT', `The generated path must be unused: ${path}`);
}
function pe64(bytes) {
  assert.ok(bytes.length > 128); const offset = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.readUInt16LE(0), 0x5a4d); assert.equal(bytes.readUInt32LE(offset), 0x4550); assert.equal(bytes.readUInt16LE(offset + 4), 0x8664);
}
async function prepare() {
  assert.ok(!args.prepared && !args.candidate && !args['candidate-build-info']);
  await mkdir(dataParent, { recursive: true }); await mkdir(resourceParent, { recursive: true });
  const root = await mkdtemp(join(dataParent, 'native-templates-'));
  const resourcesRoot = await mkdtemp(join(resourceParent, 'native-templates-'));
  const dataDir = join(root, 'data'), toolRoot = join(resourcesRoot, 'probe');
  await mkdir(dataDir); await mkdir(toolRoot);
  const marker = join(toolRoot, 'unexpected-invocation.txt');
  // A regression that unexpectedly starts the program leaves an owned sentinel.
  // No shell, network, external resource or inherited command is involved.
  const source = `fn main() {\n    let args: Vec<String> = std::env::args().collect();\n    if let Ok(program) = std::env::current_exe() {\n        if let Some(root) = program.parent() {\n            let _ = std::fs::write(root.join("unexpected-invocation.txt"), args.join("\\n"));\n        }\n    }\n}\n`;
  const sourcePath = join(toolRoot, 'native-template-probe.rs'); await writeFile(sourcePath, source, { flag: 'wx' });
  const fixture = { format: FORMAT, driverFormat: DRIVER_FORMAT, syntheticOnly: true, status: 'source-prepared', root, resourcesRoot, dataDir, dbPath: join(dataDir, 'manager.sqlite3'), toolRoot, sourcePath, sourceSha256: hash(source), executablePath: join(toolRoot, 'native-template-probe.exe'), marker, skillCount: 2, toolCount: 1, createdAt: new Date().toISOString() };
  await writeFile(join(root, 'fixture-owner.json'), json({ format: DRIVER_FORMAT, templatesFormat: FORMAT, syntheticOnly: true }));
  await writeFile(join(resourcesRoot, 'fixture-owner.json'), json({ format: FORMAT, syntheticOnly: true, dataRoot: root }));
  await writeFile(join(root, 'dataset.json'), json(fixture)); return fixture;
}
async function descriptor(path) {
  const location = resolve(path); assert.ok(inside(location, dataParent) && basename(location) === 'dataset.json');
  const fixture = JSON.parse(await readFile(location, 'utf8'));
  assert.equal(fixture.format, FORMAT); assert.equal(fixture.driverFormat, DRIVER_FORMAT); assert.equal(fixture.syntheticOnly, true);
  assert.ok(same(dirname(location), fixture.root) && inside(fixture.root, dataParent) && inside(fixture.resourcesRoot, resourceParent));
  for (const [field, expected] of Object.entries({ dataDir: join(fixture.root, 'data'), dbPath: join(fixture.root, 'data', 'manager.sqlite3'), toolRoot: join(fixture.resourcesRoot, 'probe'), sourcePath: join(fixture.resourcesRoot, 'probe', 'native-template-probe.rs'), executablePath: join(fixture.resourcesRoot, 'probe', 'native-template-probe.exe'), marker: join(fixture.resourcesRoot, 'probe', 'unexpected-invocation.txt') })) assert.ok(same(fixture[field], expected));
  for (const directory of [fixture.root, fixture.resourcesRoot, fixture.toolRoot, fixture.dataDir]) assert.ok(same(await realpath(directory), directory), 'Fixture roots may not be redirected.');
  const owner = JSON.parse(await readFile(join(fixture.root, 'fixture-owner.json'), 'utf8'));
  assert.equal(owner.format, DRIVER_FORMAT); assert.equal(owner.templatesFormat, FORMAT); assert.equal(owner.syntheticOnly, true);
  assert.equal(await digest(fixture.sourcePath), fixture.sourceSha256); await absent(fixture.marker); return fixture;
}
function persisted(fixture) {
  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try {
    const exists = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    return {
      state: JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload),
      resources: db.prepare('SELECT payload FROM resource_catalog ORDER BY id').all().map(row => JSON.parse(row.payload)),
      templates: exists('invocation_templates') ? db.prepare('SELECT payload FROM invocation_templates ORDER BY id').all().map(row => JSON.parse(row.payload)) : [],
      templateRevision: exists('invocation_templates_meta') ? db.prepare('SELECT revision FROM invocation_templates_meta WHERE id=1').get()?.revision || 0 : 0,
    };
  } finally { db.close(); }
}
async function compile(fixture) {
  assert.equal(fixture.status, 'source-prepared'); await absent(fixture.executablePath); await absent(fixture.dbPath);
  assert.equal(process.platform, 'win32'); assert.ok(same(await realpath(rustc), rustc));
  const linker = process.env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER;
  assert.equal(typeof linker, 'string', 'Activate the existing project compiler environment before this explicit compile phase.');
  assert.ok(inside(linker, 'D:\\03_github_projects\\Agent_Management\\Agent_Resource_Manager\\dev\\environment\\msvc-portable') && same(await realpath(linker), linker));
  const temporary = join(fixture.root, 'compiler-temp'); await mkdir(temporary);
  const command = [fixture.sourcePath, '--crate-name', 'native_template_probe', '--edition=2021', '-C', 'debuginfo=0', '-C', `linker=${linker}`, '-C', 'link-arg=/DEBUG:NONE', '-o', fixture.executablePath];
  const { stdout, stderr } = await execute(rustc, command, { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024, env: { ...process.env, TEMP: temporary, TMP: temporary } });
  await writeFile(join(fixture.root, 'probe-compile.log'), stdout + stderr, { flag: 'wx' });
  const bytes = await readFile(fixture.executablePath); pe64(bytes);
  fixture.compiler = { path: rustc, sha256: await digest(rustc), linker, args: command, executableSha256: hash(bytes), executed: false };
  fixture.sourceFiles = [{ path: fixture.sourcePath, sha256: fixture.sourceSha256 }, { path: fixture.executablePath, sha256: hash(bytes) }];
  const skills = [];
  for (let index = 0; index < 2; index++) {
    const key = String(index).padStart(4, '0'), id = `perf-skill-${key}`, localPath = join(fixture.resourcesRoot, id); await mkdir(localPath);
    const text = `---\nname: ${id}\ndescription: Inert native template fixture.\nmetadata:\n  version: "1.0.0"\n---\n\n# Perf Skill ${key}\n\nGenerated text only.\n`;
    const path = join(localPath, 'SKILL.md'); await writeFile(path, text, { flag: 'wx' }); fixture.sourceFiles.push({ path, sha256: hash(text) });
    skills.push({ id, name: id, displayName: `Perf Skill ${key}`, description: 'Generated native template acceptance text.', localPath, status: 'local_only', version: '1.0.0', runtimeFiles: ['SKILL.md'], runtimeConfirmed: true, runtimeAudit: { status: 'verified', warnings: [], checkedAt: fixture.createdAt }, runtimeWarnings: [], runtimeIssues: [], localHashes: { 'SKILL.md': hash(text) }, favorite: false, readOnly: false });
  }
  const definition = {
    id: 'native-query', label: '模板验收入口', mode: 'task', cancellable: false,
    executable: toNamespacedPath(await realpath(fixture.executablePath)), workingDirectory: toNamespacedPath(await realpath(fixture.toolRoot)), executableSha256: hash(bytes), timeoutSeconds: 5,
    args: [{ type: 'literal', value: '--query' }, { type: 'parameter', name: 'query' }, { type: 'literal', value: '--count' }, { type: 'parameter', name: 'count' }, { type: 'literal', value: '--context' }, { type: 'parameter', name: 'context' }],
    parameters: [
      { name: 'query', label: '测试文本', kind: 'text', required: true, maxLength: 512, templateAllowed: true },
      { name: 'count', label: '测试数量', kind: 'integer', required: true, min: 1, max: 20, templateAllowed: true },
      { name: 'context', label: '本次上下文', kind: 'text', required: false, maxLength: 128, templateAllowed: false },
    ],
  };
  const resource = { id: 'native-template-probe', name: 'Native Template Probe', kind: 'cli', rootPath: fixture.toolRoot, repository: null, version: '1.0.0', alias: '', notes: 'Generated inert template fixture. Do not execute.', enabled: true, ownership: 'external', managementScope: 'register', actions: [definition], capabilities: [], updatePolicy: { mode: 'manual', intervalHours: 24, pinnedVersion: null, skippedVersions: [] }, installation: null, revision: 1, createdAt: fixture.createdAt, updatedAt: fixture.createdAt };
  const state = { skills, sources: [], connections: [], localRoots: [], ignoredLocalPaths: [], checkMode: 'manual', checkGeneration: 0, checkSummary: null, stateRevision: 1, settings: { checkIntervalMinutes: 30, uiTheme: 'dark', uiZoom: 100, uiFontSize: 18, uiDensity: 'comfortable', uiAccent: 'violet', uiMotion: 'none', libraryMode: 'list', libraryPageSize: 20, librarySort: 'name', categories: [], sidebarWidth: 224, sidebarCollapsed: false } };
  const db = new DatabaseSync(fixture.dbPath);
  try {
    db.exec('CREATE TABLE app_state(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,payload TEXT NOT NULL); CREATE TABLE workspace_state(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL); CREATE TABLE resource_catalog(id TEXT PRIMARY KEY,root_key TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL CHECK(revision>0),payload TEXT NOT NULL); CREATE TABLE resource_catalog_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);');
    db.prepare('INSERT INTO app_state VALUES(1,1,?)').run(JSON.stringify(state));
    db.prepare('INSERT INTO resource_catalog VALUES(?,?,?,?)').run(resource.id, resource.rootPath.toLowerCase(), resource.revision, JSON.stringify(resource));
    db.prepare('INSERT INTO resource_catalog_meta VALUES(1,1)').run();
  } finally { db.close(); }
  fixture.skills = skills; fixture.resource = resource; fixture.initial = persisted(fixture);
  fixture.initialDatabaseSha256 = await digest(fixture.dbPath); fixture.status = 'prepared';
  await writeFile(join(fixture.root, 'dataset.json'), json(fixture)); return fixture;
}
async function verifyResources(fixture) {
  for (const file of fixture.sourceFiles) {
    assert.ok(inside(file.path, fixture.resourcesRoot) && same(await realpath(file.path), file.path));
    assert.equal(await digest(file.path), file.sha256, 'Generated runtime/source contents changed.');
  }
  await absent(fixture.marker);
}
async function candidate() {
  assert.equal(typeof args.candidate, 'string'); assert.equal(typeof args['candidate-build-info'], 'string');
  const path = resolve(args.candidate), buildInfoPath = resolve(args['candidate-build-info']); assert.equal(basename(path).toLowerCase(), 'agent-resource-manager.exe');
  const bytes = await readFile(path); pe64(bytes);
  const sha256 = hash(bytes), info = JSON.parse(await readFile(buildInfoPath, 'utf8'));
  assert.equal(info.buildMode, 'release'); assert.equal((info.executableSha256 || info.sha256)?.toLowerCase(), sha256); assert.ok(info.sourceIdentity || info.sourceCommit);
  return { path, sha256, buildInfoPath, buildInfoSha256: await digest(buildInfoPath), sourceIdentity: info.sourceIdentity || info.sourceCommit };
}
async function wait(read, accepts, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) { const value = await read(); if (accepts(value)) return value; assert.ok(Date.now() < deadline, `Native template observation unavailable: ${description}. No action was replayed.`); await sleep(50); }
}
async function control(app, name, type = 'ControlType.Button', scope) {
  const matches = list(await app.call('state', { name, ...(scope ? { scope } : {}) })).filter(row => row.type === type);
  assert.ok(matches.length <= 1, `Ambiguous native template control: ${name}.`); return matches[0];
}
async function invoke(app, name, scope) {
  report.lastStep = name; await writeFile(reportPath, json(report));
  await wait(() => control(app, name, 'ControlType.Button', scope), value => value?.enabled, name);
  return app.call('invokeName', { name, ...(scope ? { scope } : {}) });
}
async function taskAfter(app, old, action) {
  const observed = await wait(() => app.call('tasks'), value => value.tasks.some(item => !old.has(item.id) && item.action === action), action);
  const matches = observed.tasks.filter(item => !old.has(item.id) && item.action === action); assert.equal(matches.length, 1);
  const done = (await wait(() => app.call('task', { taskId: matches[0].id }), value => value.task && !['queued', 'running'].includes(value.task.status), `${action} completion`, 45000)).task;
  report.actions.push({ id: done.id, action: done.action, status: done.status, error: done.error || null });
  assert.equal(done.status, 'succeeded', done.error || `Native ${action} failed.`); return done.result;
}
async function task(app, button, action) {
  const old = new Set((await app.call('tasks')).tasks.map(item => item.id)); await invoke(app, button); return taskAfter(app, old, action);
}
async function fill(app, values, context) {
  await app.call('setField', { name: '测试文本', value: values.query });
  await app.call('setField', { name: '测试数量', value: String(values.count), numeric: true });
  await app.call('setField', { name: '本次上下文', value: context });
}
async function readParameters(app, fixture) {
  // Read exact owned controls using their native Value/RangeValue pattern.
  // This helper neither focuses a control nor writes to it or the clipboard.
  const payload = Buffer.from(JSON.stringify({ pid: app.identity.pid, created: app.identity.creationFileTime, handle: app.identity.windowHandle })).toString('base64');
  const command = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Add-Type -AssemblyName UIAutomationClient;Add-Type -AssemblyName UIAutomationTypes;$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json;$owned=Get-Process -Id $p.pid;if($owned.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne $p.created){throw 'Owned process identity changed.'};$root=[Windows.Automation.AutomationElement]::FromHandle([IntPtr]([long]$p.handle));if($root.Current.ProcessId -ne $p.pid){throw 'Owned window identity changed.'};$result=@{};foreach($item in @(@{key='query';name='测试文本';type=[Windows.Automation.ControlType]::Edit},@{key='count';name='测试数量';type=[Windows.Automation.ControlType]::Spinner},@{key='context';name='本次上下文';type=[Windows.Automation.ControlType]::Edit})){$conditions=[Windows.Automation.Condition[]]@([Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,$item.name),[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,$item.type));$fields=$root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.AndCondition]::new($conditions));if($fields.Count -ne 1 -or -not $fields[0].Current.IsEnabled){throw 'Exact owned template parameter is not unique and enabled.'};$pattern=$null;if($fields[0].TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)){$value=$pattern.Current.Value}elseif($item.key -eq 'count' -and $fields[0].TryGetCurrentPattern([Windows.Automation.RangeValuePattern]::Pattern,[ref]$pattern)){$value=$pattern.Current.Value.ToString([Globalization.CultureInfo]::InvariantCulture)}else{throw 'Native parameter value pattern unavailable.'};if($value.Length -gt 4096){throw 'Unexpected synthetic parameter length.'};$result[$item.key]=[string]$value};$result|ConvertTo-Json -Compress`;
  const { stdout } = await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, timeout: 20000, maxBuffer: 65536, env: { ...process.env, TEMP: join(fixture.root, 'driver-temp'), TMP: join(fixture.root, 'driver-temp') } });
  return JSON.parse(stdout.trim());
}
function savedTemplate(fixture, result, expected, previous) {
  assert.equal(result.resourceRevision, fixture.resource.revision); assert.equal(result.templates.length, 1);
  const item = result.templates[0]; assert.equal(item.id, result.templateId); assert.equal(item.resourceId, fixture.resource.id); assert.equal(item.actionId, fixture.resource.actions[0].id);
  assert.equal(item.name, expected.name); assert.equal(item.compatible, true); assert.deepEqual(item.parameterNames, ['count', 'query']);
  assert.equal(item.revision, previous ? previous.revision + 1 : 1); if (previous) assert.equal(item.id, previous.id);
  const rows = persisted(fixture).templates; assert.equal(rows.length, 1); assert.equal(rows[0].id, item.id); assert.equal(rows[0].revision, item.revision);
  assert.deepEqual(rows[0].parameters, { query: expected.query, count: expected.count }); assert.equal(rows[0].name, expected.name); assert.match(rows[0].binding, /^[a-f0-9]{64}$/);
  return item;
}
async function save(app, fixture, expected, previous) {
  await invoke(app, previous ? '编辑模板' : '保存当前为模板');
  await app.call('setField', { name: '模板名称', value: expected.name });
  for (const label of ['测试文本', '测试数量']) await app.call('toggle', { name: `保存参数：${label}`, checked: true });
  assert.equal(await control(app, '保存参数：本次上下文', 'ControlType.CheckBox'), undefined, 'An undeclared one-off field became template-saveable.');
  const result = await task(app, previous ? '保存并替换模板' : '保存模板', 'resource_template_save');
  return savedTemplate(fixture, result, expected, previous);
}
async function apply(app, fixture, item, expected, context) {
  await fill(app, { query: 'unsaved placeholder', count: 1 }, context);
  const result = await task(app, '填入参数', 'resource_template_prepare');
  assert.equal(result.resourceRevision, fixture.resource.revision); assert.equal(result.actionId, item.actionId); assert.equal(result.templateId, item.id);
  assert.deepEqual(result.parameters, { query: expected.query, count: expected.count });
  await wait(() => control(app, '填入参数'), value => value?.enabled, 'template application finished');
  const values = await readParameters(app, fixture); assert.deepEqual(values, { query: expected.query, count: String(expected.count), context });
  await absent(fixture.marker);
  assert.equal((await app.call('tasks')).tasks.filter(task => task.action === 'resource_invoke').length, 0, 'Applying a template executed the tool.');
  const parameters = { ...result.parameters, context: values.context };
  const resolvedArguments = fixture.resource.actions[0].args.map(argument => argument.type === 'literal' ? argument.value : String(parameters[argument.name]));
  assert.deepEqual(resolvedArguments, ['--query', expected.query, '--count', String(expected.count), '--context', context]);
  return { templateId: item.id, preparedRevision: item.revision, nativeFieldsMatch: true, oneOffFieldRetained: true, preparedParameters: result.parameters, resolvedArguments, toolExecuted: false };
}

if (phase === 'prepare') {
  const fixture = await prepare(); console.log(JSON.stringify({ status: fixture.status, fixture: join(fixture.root, 'dataset.json'), noCompile: true, noNativeLaunch: true })); process.exit(0);
}
assert.equal(typeof args.prepared, 'string');
const fixture = await descriptor(args.prepared);
if (phase === 'compile') {
  await compile(fixture); console.log(JSON.stringify({ status: fixture.status, fixture: join(fixture.root, 'dataset.json'), executableSha256: fixture.compiler.executableSha256, noProgramInvocation: true, noNativeLaunch: true })); process.exit(0);
}
assert.equal(fixture.status, 'prepared'); assert.equal(fixture.compiler.executed, false); assert.equal(fixture.skillCount, 2); assert.equal(fixture.toolCount, 1);
pe64(await readFile(fixture.executablePath)); await verifyResources(fixture);
assert.equal(await digest(fixture.dbPath), fixture.initialDatabaseSha256, 'A partially run catalogue must not be replayed.'); assert.deepEqual(persisted(fixture), fixture.initial);
const info = await candidate(), reportPath = join(fixture.root, 'templates-result.json');
let app;
const report = { format: FORMAT, status: 'running', startedAt: new Date().toISOString(), candidate: info, fixture: resolve(args.prepared), syntheticOnly: true, limitations, actions: [], results: {}, inputMethod: 'native-accessibility-patterns' };
try {
  report.harness = await Promise.all(['verify-native-templates.mjs', 'native-uia-client.mjs', 'verify-native-uia.ps1'].map(async name => ({ name, sha256: await digest(fileURLToPath(new URL(name, import.meta.url))) })));
  await writeFile(reportPath, json(report), { flag: 'wx' });
  app = await NativeUiaSession.launch({ executable: info.path, dataDir: fixture.dataDir, reportPath: join(fixture.root, 'native-driver.json'), sha256: info.sha256, accessibilityInput: true }); report.native = app.identity;
  assert.equal(app.identity.executableSha256, info.sha256); assert.ok(same(app.identity.dataDirectory, fixture.dataDir));
  await invoke(app, '工具', '主要导航'); await invoke(app, fixture.resource.name); await invoke(app, `使用${fixture.resource.actions[0].label}`);
  await fill(app, first, 'original one-off');
  const initial = await task(app, '常用模板', 'resource_templates'); assert.deepEqual(initial.templates, []); assert.equal(initial.resourceRevision, fixture.resource.revision);
  const created = await save(app, fixture, first); report.results.saved = { id: created.id, revision: created.revision, allowedParametersOnly: true };
  report.results.firstApply = await apply(app, fixture, created, first, 'one-off after first save');
  await fill(app, edited, 'one-off while editing');
  const replacement = await save(app, fixture, edited, created); report.results.edited = { id: replacement.id, revision: replacement.revision, replacedSameTemplate: true };
  report.results.editedApply = await apply(app, fixture, replacement, edited, 'one-off after replacement');
  const removed = await task(app, '删除模板', 'resource_template_remove'); assert.deepEqual(removed.templates, []); assert.equal(removed.resourceRevision, fixture.resource.revision);
  assert.deepEqual(persisted(fixture).templates, []);
  await wait(() => control(app, '填入参数'), value => value && !value.enabled, 'deleted template cannot be applied');
  const refreshed = await task(app, '刷新模板', 'resource_templates'); assert.deepEqual(refreshed.templates, []);
  report.results.removed = { noPersistedTemplate: true, noApplySelection: true, freshListEmpty: true };
  await app.call('screenshot', { path: join(fixture.root, 'native-templates.png') });
  const observed = (await app.call('tasks')).tasks, allowed = ['management_data', 'resource_list', 'resource_runtime', 'resource_templates', 'resource_template_save', 'resource_template_prepare', 'resource_template_remove'];
  assert.ok(observed.every(item => allowed.includes(item.action)), 'An unrelated action or tool invocation was observed.');
  for (const item of observed) {
    const completed = (await wait(() => app.call('task', { taskId: item.id }), value => value.task && !['queued', 'running'].includes(value.task.status), `${item.action} completion`)).task;
    assert.equal(completed.status, 'succeeded', completed.error || `Native ${item.action} failed.`);
    if (completed.action === 'resource_runtime') assert.deepEqual(completed.result.runs, []);
  }
  assert.equal(observed.filter(item => item.action === 'resource_template_save').length, 2); assert.equal(observed.filter(item => item.action === 'resource_template_prepare').length, 2); assert.equal(observed.filter(item => item.action === 'resource_template_remove').length, 1);
  report.results.noAutomaticExecution = { noInvokeTask: true, observedRuntimeEmpty: true, invocationSentinelAbsent: true };
  report.normalExit = (await app.quit()).driverReport.closedNormally; app = null; assert.equal(report.normalExit, true);
  const after = persisted(fixture); assert.deepEqual(after.resources, fixture.initial.resources); assert.equal(after.state.skills.length, fixture.initial.state.skills.length);
  for (const original of fixture.initial.state.skills) {
    const current = after.state.skills.find(item => item.id === original.id); assert.ok(current);
    for (const [key, value] of Object.entries(original)) assert.deepEqual(current[key], value, `Generated Skill ${key} changed.`);
  }
  for (const [key, value] of Object.entries(fixture.initial.state.settings)) assert.deepEqual(after.state.settings[key], value, `Original setting ${key} changed.`);
  for (const key of ['sources', 'connections', 'localRoots']) assert.deepEqual(after.state[key], fixture.initial.state[key]);
  assert.equal(after.state.checkMode, 'manual'); assert.deepEqual(after.templates, []); assert.ok(after.templateRevision > fixture.initial.templateRevision);
  await verifyResources(fixture); report.results.originalResourcesPreserved = true; report.status = 'passed';
} catch (error) {
  report.status = 'failed-or-blocked'; report.failure = { name: error.name, message: String(error.message).slice(0, 1800) };
  if (app && !app.exited) { try { await app.call('screenshot', { path: join(fixture.root, 'failure.png') }); } catch (cause) { report.failureScreenshotError = String(cause); } }
} finally {
  if (app) { try { report.normalExit = (await app.quit()).driverReport.closedNormally; } catch (cause) { report.normalExit = false; report.exitError = String(cause); } }
  report.finishedAt = new Date().toISOString(); await writeFile(reportPath, json(report));
}
console.log(JSON.stringify({ status: report.status, reportPath, results: report.results, normalExit: report.normalExit, failure: report.failure }));
if (report.status !== 'passed') process.exitCode = 1;
