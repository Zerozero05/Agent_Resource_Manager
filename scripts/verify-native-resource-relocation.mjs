import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { NativeUiaSession } from './native-uia-client.mjs';
import { createPerformanceFixture, FIXTURE_FORMAT } from './performance-fixture.mjs';

// Reuses the generated Agent Reach layout in resource_relocation/tests.rs and
// the existing native accessibility/task observation driver. No fixture runs.
const FORMAT = 'agent-resource-manager-native-resource-relocation-v1';
const VALIDATION = 'D:\\03_github_projects\\Agent_Management\\Agent_Resource_Manager\\validation';
const FORMAL = 'D:\\03_github_projects\\Agent_Management\\Agent_Resource_Manager\\app\\agent-resource-manager.exe';
const SOURCE = fileURLToPath(new URL('../', import.meta.url));
const options = {};
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  assert.ok(['--prepare', '--prepared', '--candidate', '--candidate-build-info', '--transport-file-sha256', '--help'].includes(flag), 'Unknown option; use --help.');
  const key = flag.slice(2); assert.ok(!Object.hasOwn(options, key), `Duplicate ${flag}.`);
  if (key === 'prepare' || key === 'help') options[key] = true;
  else { const value = process.argv[++index]; assert.ok(value && !value.startsWith('--'), `Missing ${flag}.`); options[key] = value; }
}
if (options.help) {
  console.log('Prepare only: --prepare. Focused native acceptance: --prepared <dataset.json> --candidate <exe> --candidate-build-info <json> --transport-file-sha256 <verified formal F9 SHA256>. Creates only fresh synthetic data. Through the real GUI it adopts one inert Agent Reach fixture, moves only that generated directory, previews/cancels/previews/applies relocation, and verifies preserved IDs, policies, neighbouring rows, files and task receipts. No synthetic or real tool is executed. No existing data is changed.');
  process.exit(0);
}
const execute = promisify(execFile), list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const json = value => JSON.stringify(value, null, 2) + '\n';
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const key = value => resolve(value.replace(/^\\\\\?\\(?=[a-z]:\\)/i, '')).toLowerCase();
const same = (left, right) => key(left) === key(right);
const inside = (path, root) => { const value = relative(resolve(root), resolve(path)); return value === '' || !value.startsWith('..') && !isAbsolute(value); };
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function absent(path) { await assert.rejects(lstat(path), error => error.code === 'ENOENT', `The generated destination must be unused: ${path}`); }
async function plain(path, file = false) {
  const metadata = await lstat(path); assert.ok(!metadata.isSymbolicLink() && (file ? metadata.isFile() : metadata.isDirectory()));
  assert.ok(same(await realpath(path), path), 'Generated paths must not be redirected.');
}
async function tree(root) {
  const hashes = {};
  async function visit(path) {
    for (const name of (await readdir(path)).sort()) {
      const target = join(path, name), metadata = await lstat(target);
      assert.ok(!metadata.isSymbolicLink(), 'Generated resources must not contain redirected entries.');
      if (metadata.isDirectory()) await visit(target);
      else { assert.ok(metadata.isFile()); hashes[relative(root, target).replaceAll('\\', '/')] = await digest(target); }
    }
  }
  await plain(root); await visit(root); return hashes;
}
function stored(fixture) {
  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try {
    return { state: JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload), resources: db.prepare('SELECT payload FROM resource_catalog ORDER BY rowid').all().map(row => JSON.parse(row.payload)) };
  } finally { db.close(); }
}
async function prepare() {
  assert.equal(Object.keys(options).length, 1, '--prepare creates fresh data only.');
  const dataParent = join(VALIDATION, 'manager-data'), resourceParent = join(VALIDATION, 'resources');
  await mkdir(dataParent, { recursive: true }); await mkdir(resourceParent, { recursive: true });
  const output = await mkdtemp(join(dataParent, 'native-resource-relocation-'));
  const resourcesRoot = await mkdtemp(join(resourceParent, 'native-resource-relocation-'));
  const fixture = await createPerformanceFixture(output, 'catalogue', 0);
  const oldRoot = join(resourcesRoot, 'reach-old'), newRoot = join(resourcesRoot, 'reach-new');
  async function write(path, contents) { const target = join(oldRoot, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, contents, { flag: 'wx' }); }
  for (const file of ['Scripts/agent-reach.exe', 'Scripts/python.exe', 'pyvenv.cfg', 'Lib/site-packages/agent_reach/cli.py', 'Lib/site-packages/agent_reach/runtime/manage.py']) await write(file, 'Synthetic non-executable fixture; never run.\n');
  await write('Lib/site-packages/agent_reach/__init__.py', '__version__ = "1.6.0"\n');
  await write('Lib/site-packages/agent_reach/runtime/cli.py', '_cmd_channels\n_cmd_doctor\nversion\n');
  await write('Lib/site-packages/agent_reach-1.6.0.dist-info/METADATA', 'Name: agent-reach\nVersion: 1.6.0\nLicense: MIT\nProject-URL: Repository, https://github.com/Panniantong/agent-reach\n');
  await write('Lib/site-packages/agent_reach-1.6.0.dist-info/licenses/LICENSE', 'MIT License\n');
  await write('agent-reach.cmd', '@echo off\nset "PYTHONDONTWRITEBYTECODE=1"\nset "PATH=%~dp0Scripts;%PATH%"\n"%~dp0Scripts\\agent-reach.exe" %*\n');
  await write('data/private.json', '{"synthetic":true,"keep":"identical"}\n'); await write('records/kept.txt', 'Generated local customization; retain exact bytes.\n');
  const timestamp = new Date().toISOString(), neighbors = [];
  for (const suffix of ['A', 'B']) {
    const rootPath = join(resourcesRoot, `neighbor-${suffix}`); await mkdir(rootPath); await writeFile(join(rootPath, 'README.txt'), `Generated inert neighbour ${suffix}.\n`, { flag: 'wx' });
    neighbors.push({ id: `native-relocation-neighbor-${suffix}`, name: `Native Relocation Neighbor ${suffix}`, kind: 'portable', rootPath, repository: null, version: null, alias: '', notes: 'Generated neighbour; no executable action.', enabled: true, ownership: 'external', managementScope: 'register', actions: [], capabilities: [], updatePolicy: { mode: 'manual', intervalHours: 24, pinnedVersion: null, skippedVersions: [] }, installation: null, revision: 1, createdAt: timestamp, updatedAt: timestamp });
  }
  const db = new DatabaseSync(fixture.dbPath);
  try {
    const insert = db.prepare('INSERT INTO resource_catalog(id,root_key,revision,payload) VALUES(?,?,1,?)');
    for (const resource of neighbors) insert.run(resource.id, key(resource.rootPath), JSON.stringify(resource));
    db.prepare('UPDATE resource_catalog_meta SET revision=? WHERE id=1').run(neighbors.length);
  } finally { db.close(); }
  fixture.toolCount = neighbors.length;
  fixture.relocation = { format: FORMAT, resourcesRoot, oldRoot, newRoot, neighbors, files: await tree(oldRoot), createdAt: timestamp };
  fixture.relocation.initial = stored(fixture); fixture.relocation.databaseSha256 = await digest(fixture.dbPath);
  await writeFile(join(resourcesRoot, 'fixture-owner.json'), json({ format: FORMAT, syntheticOnly: true, fixtureRoot: fixture.root }), { flag: 'wx' });
  await writeFile(join(fixture.root, 'dataset.json'), json(fixture));
  console.log(JSON.stringify({ status: 'prepared-not-launched', prepared: join(fixture.root, 'dataset.json'), dataDir: fixture.dataDir, resourcesRoot, noGui: true, noToolExecution: true }));
}
async function descriptor(path) {
  const location = resolve(path), fixture = JSON.parse(await readFile(location, 'utf8'));
  assert.equal(fixture.format, FIXTURE_FORMAT); assert.equal(fixture.syntheticOnly, true); assert.equal(fixture.relocation?.format, FORMAT);
  assert.ok(inside(fixture.root, join(VALIDATION, 'manager-data')) && same(location, join(fixture.root, 'dataset.json')));
  assert.ok(same(fixture.dataDir, join(fixture.root, 'data')) && same(fixture.dbPath, join(fixture.dataDir, 'manager.sqlite3')));
  const relocation = fixture.relocation;
  assert.ok(inside(relocation.resourcesRoot, join(VALIDATION, 'resources')));
  assert.ok(same(relocation.oldRoot, join(relocation.resourcesRoot, 'reach-old')) && same(relocation.newRoot, join(relocation.resourcesRoot, 'reach-new')));
  for (const directory of [fixture.root, fixture.dataDir, relocation.resourcesRoot, relocation.oldRoot]) await plain(directory);
  const owner = JSON.parse(await readFile(join(fixture.root, 'fixture-owner.json'), 'utf8'));
  const resourceOwner = JSON.parse(await readFile(join(relocation.resourcesRoot, 'fixture-owner.json'), 'utf8'));
  assert.equal(owner.format, FIXTURE_FORMAT); assert.equal(owner.syntheticOnly, true);
  assert.equal(resourceOwner.format, FORMAT); assert.equal(resourceOwner.syntheticOnly, true); assert.ok(same(resourceOwner.fixtureRoot, fixture.root));
  assert.equal(await digest(fixture.dbPath), relocation.databaseSha256, 'A previously changed fixture cannot be replayed.');
  assert.deepEqual(stored(fixture), relocation.initial); assert.deepEqual(await tree(relocation.oldRoot), relocation.files); await absent(relocation.newRoot);
  return fixture;
}
async function candidate() {
  const executable = resolve(options.candidate), buildInfoPath = resolve(options['candidate-build-info']);
  assert.ok(inside(executable, SOURCE) && inside(buildInfoPath, SOURCE)); assert.equal(basename(executable), 'agent-resource-manager.exe');
  const info = JSON.parse(await readFile(buildInfoPath, 'utf8')), manifestPath = join(dirname(buildInfoPath), 'candidate-runtime-source-manifest.json');
  const manifestBytes = await readFile(manifestPath), manifest = JSON.parse(manifestBytes);
  assert.equal(info.buildMode, 'release'); assert.notEqual(info.diagnosticOnly, true); assert.ok(info.sourceIdentity);
  assert.ok(same(info.executablePath, executable)); assert.equal(await digest(executable), info.executableSha256);
  assert.equal(createHash('sha256').update(manifestBytes).digest('hex'), info.runtimeSourceManifestSha256);
  assert.ok(Array.isArray(manifest) && manifest.length > 0 && new Set(manifest.map(entry => entry.path)).size === manifest.length);
  for (const required of ['src/ResourceRelocation.tsx', 'src-tauri/src/resource_relocation.rs', 'dist/index.html']) assert.ok(manifest.some(entry => entry.path === required));
  for (const entry of manifest) {
    const path = resolve(SOURCE, entry.path); assert.ok(inside(path, SOURCE)); await plain(path, true); assert.equal(await digest(path), entry.sha256, `Current runtime source differs: ${entry.path}`);
  }
  const bytes = await readFile(executable), pe = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.readUInt16LE(0), 0x5a4d); assert.equal(bytes.readUInt32LE(pe), 0x4550); assert.equal(bytes.readUInt16LE(pe + 4), 0x8664);
  assert.match(options['transport-file-sha256'], /^[a-f0-9]{64}$/i, 'Pass the explicit verified formal transport F9 hash.');
  const transportSha256 = options['transport-file-sha256'].toLowerCase(); assert.equal(await digest(FORMAL), transportSha256);
  return { executable, sha256: info.executableSha256, buildInfoPath, buildInfoSha256: await digest(buildInfoPath), manifestPath, manifestSha256: info.runtimeSourceManifestSha256, sourceIdentity: info.sourceIdentity, transportSha256 };
}
async function wait(read, accepts, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  for (;;) { const value = await read(); if (accepts(value)) return value; assert.ok(Date.now() < deadline, `Exact native state unavailable: ${label}; no operation was replayed.`); await sleep(80); }
}
let report, reportPath;
async function step(label, operation) { report.lastStep = label; await writeFile(reportPath, json(report)); return operation(); }
async function invoke(app, name, scope) {
  const selector = { name, ...(scope ? { scope } : {}) };
  await wait(() => app.call('state', selector), values => list(values).filter(item => item.type === 'ControlType.Button' && item.enabled).length === 1, name);
  return app.call('invokeName', selector);
}
async function task(app, button, action, scope) {
  const before = new Set((await app.call('tasks')).tasks.map(item => item.id)); await invoke(app, button, scope);
  const observed = await wait(() => app.call('tasks'), value => value.tasks.some(item => !before.has(item.id) && item.action === action), action);
  const created = observed.tasks.filter(item => !before.has(item.id) && item.action === action); assert.equal(created.length, 1);
  const complete = (await wait(() => app.call('task', { taskId: created[0].id }), value => value.task && !['queued', 'running'].includes(value.task.status), `${action} completion`)).task;
  report.tasks.push({ id: complete.id, action: complete.action, status: complete.status }); assert.equal(complete.status, 'succeeded', complete.error || action); return complete;
}
async function rowOrder(app, names) { return list(await app.call('snapshot')).filter(item => item.type === 'ControlType.Button' && names.includes(item.name)).map(item => item.name); }
async function moveGenerated(fixture) {
  const { oldRoot: from, newRoot: to, resourcesRoot: root } = fixture.relocation;
  assert.ok(inside(from, root) && inside(to, root) && same(dirname(from), root) && same(dirname(to), root));
  await plain(root); await plain(from); await absent(to); assert.deepEqual(await tree(from), fixture.relocation.files);
  const payload = Buffer.from(JSON.stringify({ from, to, root }), 'utf8').toString('base64');
  const command = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json
$root=[IO.Path]::GetFullPath($p.root);$from=[IO.Path]::GetFullPath($p.from);$to=[IO.Path]::GetFullPath($p.to)
foreach($path in @($from,$to)){if(-not [string]::Equals([IO.Path]::GetDirectoryName($path),$root,[StringComparison]::OrdinalIgnoreCase)){throw 'Move escapes the exact synthetic fixture root.'}}
foreach($path in @($root,$from)){if(-not [string]::Equals((Resolve-Path -LiteralPath $path).ProviderPath,$path,[StringComparison]::OrdinalIgnoreCase)){throw 'Synthetic move path resolves elsewhere.'};$item=Get-Item -LiteralPath $path -Force;if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Synthetic move requires ordinary directories.'}}
if(Test-Path -LiteralPath $to){throw 'Synthetic new root already exists; no replacement.'}
Move-Item -LiteralPath $from -Destination $to -ErrorAction Stop
[pscustomobject]@{moved=$true;from=$from;to=$to;replacement=$false}|ConvertTo-Json -Compress`;
  const temporary = join(fixture.root, 'driver-temp');
  const { stdout } = await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000, maxBuffer: 32768, env: { ...process.env, TEMP: temporary, TMP: temporary } });
  const result = JSON.parse(stdout); assert.equal(result.moved, true); await absent(from); assert.deepEqual(await tree(to), fixture.relocation.files); return result;
}
function compareResource(before, after, plan) {
  assert.equal(after.id, before.id); assert.equal(after.revision, before.revision + 1); assert.ok(same(after.rootPath, plan.newRootPath));
  const stable = value => Object.fromEntries(Object.entries(value).filter(([field]) => !['rootPath', 'actions', 'capabilities', 'revision', 'updatedAt'].includes(field)));
  assert.deepEqual(stable(after), stable(before)); assert.equal(after.actions.length, before.actions.length);
  for (const original of before.actions) {
    const changed = after.actions.find(item => item.id === original.id), mapping = plan.actions.find(item => item.id === original.id); assert.ok(changed && mapping);
    const unchanged = value => Object.fromEntries(Object.entries(value).filter(([field]) => !['executable', 'workingDirectory', 'adapterBinding'].includes(field)));
    assert.deepEqual(unchanged(changed), unchanged(original)); assert.ok(same(changed.executable, mapping.newExecutable) && same(changed.workingDirectory, mapping.newWorkingDirectory));
    assert.equal(changed.adapterBinding.adapter, original.adapterBinding.adapter); assert.ok(same(changed.adapterBinding.rootPath, after.rootPath));
  }
  assert.equal(after.capabilities.length, before.capabilities.length);
  for (const original of before.capabilities) {
    const changed = after.capabilities.find(item => item.id === original.id); assert.ok(changed);
    if (original.id === 'versionMetadata') { assert.ok(same(changed.entry, after.rootPath)); for (const field of ['id', 'label', 'status', 'method', 'version']) assert.deepEqual(changed[field], original[field]); }
    else assert.deepEqual(changed, original);
  }
}
if (options.prepare) { await prepare(); process.exit(0); }
assert.equal(process.platform, 'win32');
for (const field of ['prepared', 'candidate', 'candidate-build-info', 'transport-file-sha256']) assert.equal(typeof options[field], 'string', `Supply --${field}.`);
const fixture = await descriptor(options.prepared), info = await candidate();
reportPath = join(fixture.root, 'resource-relocation-result.json'); await absent(reportPath);
const harness = await Promise.all(['verify-native-resource-relocation.mjs', 'native-uia-client.mjs', 'verify-native-uia.ps1', 'performance-fixture.mjs'].map(async name => { const path = fileURLToPath(new URL(name, import.meta.url)); return { path, sha256: await digest(path) }; }));
report = { format: FORMAT, status: 'running', syntheticOnly: true, startedAt: new Date().toISOString(), fixture: resolve(options.prepared), candidate: info, harness, tasks: [], checks: {}, normalExit: false, limitations: ['One Agent Reach representative native relocation only; Dragon and Playwright adapter boundaries are covered separately by backend and component tests.', 'No tool invocation, version/doctor/platform call, download, installation, production database, backup, cleanup or browser operation.', 'Task receipts/results remain observable; preservation of an already displayed real runtime stdout result is covered by the component regression, not manufactured by this inert native fixture.', 'Native accessibility input is functional acceptance only; no keyboard, pointer, performance or memory-acceptance claim.'] };
await writeFile(reportPath, json(report), { flag: 'wx' });
let app;
try {
  app = await step('launch-exact-isolated-candidate', () => NativeUiaSession.launch({ executable: info.executable, sha256: info.sha256, transportSha256: info.transportSha256, dataDir: fixture.dataDir, reportPath: join(fixture.root, 'native-driver.json'), accessibilityInput: true }));
  report.native = app.identity; assert.equal(app.identity.executableSha256, info.sha256); assert.ok(same(app.identity.dataDirectory, fixture.dataDir));
  await invoke(app, '工具', '主要导航'); await invoke(app, '登记现有工具');
  const fields = list(await app.call('fields')), roots = fields.filter(item => item.type === 'ControlType.Edit' && item.name.startsWith('原目录') && item.enabled); assert.equal(roots.length, 1);
  await app.call('setField', { name: roots[0].name, value: fixture.relocation.oldRoot }); await invoke(app, '接管现有工具');
  const adoptedPreview = (await task(app, '预览接管', 'preview_resource_adapter')).result;
  assert.equal(adoptedPreview.adapter, 'agentReach'); assert.equal(adoptedPreview.canApply, true);
  const adoptedTask = await task(app, '保存接管', 'apply_resource_adapter'), adopted = adoptedTask.result.resource;
  assert.equal(adoptedTask.result.executed, false); assert.equal(adoptedTask.result.filesChanged, false); assert.equal(adopted.actions.length, 4);
  await invoke(app, '关闭编辑');
  if (!list(await app.call('state', { name: '关闭工具详情' })).some(item => item.type === 'ControlType.Button')) await invoke(app, adopted.name);
  const before = stored(fixture), original = before.resources.find(item => item.id === adopted.id); assert.ok(original);
  const names = [...fixture.relocation.neighbors.map(item => item.name), adopted.name], order = await rowOrder(app, names); assert.deepEqual(order, names);
  report.move = await step('move-only-generated-old-root-to-new-root', () => moveGenerated(fixture));
  const disclosure = '重新定位目录…', scope = '工具目录重新定位';
  assert.equal(list(await app.call('state', { name: '工具现在所在目录' })).length, 0, 'Relocation must initially be folded.');
  await invoke(app, disclosure); await app.call('setField', { name: '工具现在所在目录', value: fixture.relocation.newRoot });
  const first = await step('preview-generated-relocation-before-cancellation', () => task(app, '预览目录变化', 'preview_resource_relocate', scope));
  assert.equal(first.result.resourceId, original.id); assert.equal(first.result.resourceRevision, original.revision);
  assert.ok(same(first.result.oldRootPath, original.rootPath) && same(first.result.newRootPath, fixture.relocation.newRoot));
  const previewNames = list(await app.call('snapshot')).map(item => item.name);
  for (const path of [first.result.oldRootPath, first.result.newRootPath, ...first.result.actions.flatMap(item => [item.oldExecutable, item.newExecutable, item.oldWorkingDirectory, item.newWorkingDirectory])]) assert.ok(previewNames.includes(path), `Complete path must be exposed by native UIA: ${path}`);
  await invoke(app, disclosure, scope);
  assert.equal(list(await app.call('state', { name: '确认重新定位' })).length, 0); assert.deepEqual(stored(fixture), before);
  assert.equal((await app.call('tasks')).tasks.filter(item => item.action === 'apply_resource_relocate').length, 0); report.checks.previewCancelledWithoutCatalogueWrite = true;
  await invoke(app, disclosure, scope);
  const second = await step('fresh-preview-after-cancellation', () => task(app, '预览目录变化', 'preview_resource_relocate', scope));
  assert.notEqual(second.result.previewId, first.result.previewId);
  const applied = await step('confirm-exact-fresh-relocation-preview', () => task(app, '确认重新定位', 'apply_resource_relocate', scope));
  for (const field of ['complete']) assert.equal(applied.result[field], true);
  for (const field of ['filesChanged', 'executed']) assert.equal(applied.result[field], false); assert.equal(applied.result.actionsAdded, 0);
  compareResource(original, applied.result.resource, second.result);
  const after = stored(fixture); assert.deepEqual(after.state, before.state); assert.deepEqual(after.resources.map(item => item.id), before.resources.map(item => item.id));
  for (const neighbor of fixture.relocation.neighbors) assert.deepEqual(after.resources.find(item => item.id === neighbor.id), before.resources.find(item => item.id === neighbor.id));
  assert.deepEqual(after.resources.find(item => item.id === original.id), applied.result.resource); assert.deepEqual(await rowOrder(app, names), order);
  const visible = list(await app.call('snapshot')); assert.ok(visible.some(item => item.name === '关闭工具详情')); assert.ok(visible.some(item => item.name.includes('目录已更新，原管理记录已保留')));
  assert.equal(list(await app.call('state', { name: '确认重新定位' })).length, 0);
  assert.deepEqual(await tree(fixture.relocation.newRoot), fixture.relocation.files); await absent(fixture.relocation.oldRoot);
  const tasks = (await app.call('tasks')).tasks; assert.equal(tasks.filter(item => ['resource_invoke', 'resource_stop'].includes(item.action)).length, 0);
  assert.equal(tasks.filter(item => item.action === 'preview_resource_relocate').length, 2); assert.equal(tasks.filter(item => item.action === 'apply_resource_relocate').length, 1);
  for (const previous of [adoptedTask, first, second, applied]) assert.deepEqual((await app.call('task', { taskId: previous.id })).task.result, previous.result);
  report.checks = { ...report.checks, freshConfirmationAppliedOnce: true, resourceAndActionIdentitiesPreserved: true, policiesAndSourcePreserved: true, neighboringRowsAndOrderPreserved: true, detailKeptOpen: true, taskReceiptsRetained: true, toolExecutionCount: 0, generatedFilesByteIdentical: true };
  report.normalExit = (await app.quit()).driverReport.closedNormally; app = null; assert.equal(report.normalExit, true);
  report.status = 'passed-native-synthetic-resource-relocation';
} catch (error) { report.status = 'failed-or-blocked'; report.error = String(error); process.exitCode = 1; }
finally {
  if (app) try { report.normalExit = (await app.quit()).driverReport.closedNormally; } catch (error) { report.normalExitError = String(error); process.exitCode = 1; }
  const changed = (await Promise.all(harness.map(async file => await digest(file.path) !== file.sha256))).some(Boolean);
  if (changed || await digest(info.executable) !== info.sha256) { report.status = 'failed-or-blocked'; report.integrityError = 'Native candidate or fixed harness changed during the run.'; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString(); await writeFile(reportPath, json(report));
  console.log(JSON.stringify({ status: report.status, reportPath, normalExit: report.normalExit, error: report.error || null }));
}
