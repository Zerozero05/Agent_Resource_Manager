import { mkdir, mkdtemp, writeFile, readFile, lstat, realpath, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { NativeUiaSession } from './native-uia-client.mjs';
import { storedZip } from './performance-load-fixture.mjs';

// Generated text only. No installed tool, private database, registry value,
// client directory, trusted probe or production update receipt is copied.
const format = 'agent-resource-manager-native-lifecycle-v1';
const approved = 'D:\\03_github_projects\\Agent_Resource_Manager\\validation';
const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, index, args) => arg.startsWith('--') ? [...pairs, [arg.slice(2), args[index + 1]]] : pairs, []));
const accessibilityInput = process.argv.includes('--accessibility-input');
const foregroundSelection = process.argv.includes('--foreground-select');
const manualSelection = process.argv.includes('--manual-select');
const functionalSelections = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const sleep = ms => new Promise(done => setTimeout(done, ms));
const comparablePath = path => resolve(path.replace(/^\\\\\?\\(?=[a-z]:\\)/i, ''));
const same = (left, right) => comparablePath(left).toLowerCase() === comparablePath(right).toLowerCase();
const inside = (path, root) => { const rel = relative(comparablePath(root), comparablePath(path)); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function waitRead(read, predicate, ms = 60000) { const deadline = Date.now() + ms; for (;;) { const value = await read(); if (predicate(value)) return value; if (Date.now() >= deadline) throw new Error('The exact lifecycle UI/task state did not become ready. No write was replayed.'); await sleep(30); } }
async function readFixture(path) {
  const fixture = JSON.parse(await readFile(resolve(path), 'utf8'));
  if (fixture.format !== format || !fixture.syntheticOnly || !inside(fixture.root, join(approved, 'manager-data')) || !inside(fixture.resourcesRoot, join(approved, 'resources')) || !same(fixture.dataDir, join(fixture.root, 'data'))) throw new Error('An owned synthetic lifecycle descriptor is required.');
  for (const root of [fixture.root, fixture.dataDir, fixture.resourcesRoot]) { if (!same(await realpath(root), root)) throw new Error('Synthetic lifecycle scope may not be redirected through a link.'); }
  const owner = JSON.parse(await readFile(join(fixture.root, 'fixture-owner.json'), 'utf8'));
  if (owner.format !== format || !owner.syntheticOnly) throw new Error('Synthetic lifecycle ownership marker mismatch.');
  for (const file of fixture.archives) if (!inside(file.path, fixture.resourcesRoot) || hash(await readFile(file.path)) !== file.sha256) throw new Error('A generated package changed after preparation.');
  return fixture;
}
async function prepare() {
  await mkdir(join(approved, 'manager-data'), { recursive: true }); await mkdir(join(approved, 'resources'), { recursive: true });
  const root = await mkdtemp(join(approved, 'manager-data', 'native-lifecycle-'));
  const resourcesRoot = await mkdtemp(join(approved, 'resources', 'native-lifecycle-'));
  const dataDir = join(root, 'data'); await mkdir(dataDir);
  const files = [
    { path: 'LICENSE', role: 'license', bytes: Buffer.from('Original generated lifecycle fixture; no third-party code.\n') },
    { path: 'bin/runtime.txt', role: 'runtime', bytes: Buffer.from('Generated runtime version one, inert text.\n') },
    { path: 'private/dependency.txt', role: 'privateDependency', bytes: Buffer.from('Generated private dependency, inert text.\n') },
    { path: 'settings.json', role: 'configuration', bytes: Buffer.from('{"synthetic":true,"value":"original"}\n') },
    { path: 'data/user.txt', role: 'userData', bytes: Buffer.from('Generated original user data.\n') },
    { path: 'cache/cache.txt', role: 'cache', bytes: Buffer.from('Generated cache content.\n') },
    { path: 'local/edit.txt', role: 'localModification', bytes: Buffer.from('Generated retained local customization.\n') },
  ];
  const archives = [];
  for (const [name, contents] of [['v1', files], ['v2', files.filter(file => ['runtime', 'privateDependency', 'license'].includes(file.role)).map(file => ({ ...file, bytes: file.role === 'runtime' ? Buffer.from('Generated runtime version two, inert text.\n') : file.bytes }))]]) {
    const bytes = storedZip(contents), path = join(resourcesRoot, `${name}.zip`); await writeFile(path, bytes, { flag: 'wx' });
    archives.push({ name, path, sha256: hash(bytes), files: contents.map(file => ({ path: file.path, role: file.role, sha256: hash(file.bytes) })) });
  }
  const fixture = { format, syntheticOnly: true, root, dataDir, resourcesRoot, skillCount: 0, toolCount: 0, archives, createdAt: new Date().toISOString(), scope: 'local native install, missing-file repair, candidate staging and four removal extents; no invocation or version switch claim' };
  await writeFile(join(root, 'fixture-owner.json'), JSON.stringify({ format, syntheticOnly: true }, null, 2));
  await writeFile(join(root, 'dataset.json'), JSON.stringify(fixture, null, 2));
  return fixture;
}
async function invoke(app, name, scope) {
  await waitRead(() => app.call('state', { name }), rows => list(rows).filter(row => row.type === 'ControlType.Button' && row.enabled).length === 1);
  return app.call('invokeName', { name, ...(scope ? { scope } : {}) });
}
async function nameBy(app, prefix, type) {
  const values = await waitRead(() => app.call('fields'), rows => list(rows).some(row => row.enabled && row.type === type && row.name.startsWith(prefix)));
  const candidates = list(values).filter(row => row.enabled && row.type === type && row.name.startsWith(prefix));
  if (candidates.length !== 1) throw new Error(`Lifecycle UI field is not unique: ${prefix}`);
  return candidates[0].name;
}
async function field(app, prefix, value) { return app.call('setField', { name: await nameBy(app, prefix, 'ControlType.Edit'), value }); }
async function select(app, prefix, option) {
  const name = await nameBy(app, prefix, 'ControlType.ComboBox');
  if (!manualSelection) return app.call('selectCombo', { name, option, foreground: foregroundSelection });
  const initial = await app.call('comboState', { name });
  let observed = initial;
  if (initial.value !== option) {
    console.log(JSON.stringify({ event: 'manual-selection-required', control: name, desired: option, current: initial.value, pid: app.identity.pid, windowHandle: app.identity.windowHandle, timeoutMs: 120000 }));
    observed = await waitRead(async () => { await sleep(250); return app.call('comboState', { name }); }, value => value.value === option, 120000);
  }
  if (observed.value !== option) throw new Error(`The exact externally selected lifecycle option was not observed: ${name}`);
  const selection = { control: name, selected: observed.value, initialValue: initial.value, functionalOnly: true, selectionMethod: initial.value === option ? 'already-selected-no-input' : 'external-operator-observed-native-combo', observedAt: new Date().toISOString() };
  functionalSelections.push(selection);
  console.log(JSON.stringify({ event: 'manual-selection-observed', ...selection }));
  return selection;
}
async function toggle(app, prefix) { return app.call('toggle', { name: await nameBy(app, prefix, 'ControlType.CheckBox'), checked: true }); }
async function taskFrom(app, button, action, { allowFailure = false, scope } = {}) {
  const prior = new Set((await app.call('tasks')).tasks.map(task => task.id)); await invoke(app, button, scope);
  const observed = await waitRead(() => app.call('tasks'), value => value.tasks.some(task => !prior.has(task.id) && task.action === action));
  const created = observed.tasks.filter(task => !prior.has(task.id) && task.action === action);
  if (created.length !== 1) throw new Error('Native confirmation did not create exactly one expected lifecycle task.');
  const done = await waitRead(() => app.call('task', { taskId: created[0].id }), value => value.task && !['queued', 'running'].includes(value.task.status), 120000);
  if (!allowFailure && done.task.status !== 'succeeded') throw new Error(done.task.error || `Native lifecycle task ${done.task.status}`);
  return done.task;
}
async function hashes(root, files) { return Object.fromEntries(await Promise.all(files.map(async file => [file.path, hash(await readFile(join(root, file.path)))]))); }
async function verifyHashes(root, expected) { for (const [path, expectedHash] of Object.entries(expected)) if (hash(await readFile(join(root, path))) !== expectedHash) throw new Error(`Preserved generated content changed: ${join(root, path)}`); }
async function install(app, fixture, suffix, checkIndependence = false) {
  const archive = fixture.archives.find(file => file.name === 'v1'), target = join(fixture.resourcesRoot, suffix);
  await invoke(app, '安装发行包'); await field(app, '发行包', archive.path); await taskFrom(app, '读取清单', 'resource_package_inspect');
  for (const file of archive.files.filter(file => file.role !== 'license')) { await toggle(app, file.path); await select(app, `${file.path}用途`, ({ runtime: '运行文件', privateDependency: '专用依赖', configuration: '配置文件', userData: '用户数据', cache: '缓存', localModification: '本地改造' })[file.role]); }
  const name = `Native Lifecycle ${suffix}`; await field(app, '名称', name); await field(app, '固定版本', 'v1');
  if (checkIndependence) {
    const rejectedTarget = join(fixture.dataDir, 'must-not-install'); await field(app, '新版本保存目录', rejectedTarget);
    const rejected = await taskFrom(app, '预览安装', 'preview_resource_install', { allowFailure: true });
    if (rejected.status !== 'failed' || !/位置|目录|独立|重叠/.test(rejected.error || '') || await exists(rejectedTarget)) throw new Error('Native installation did not reject the overlapping manager-data root without creating files.');
  }
  await field(app, '新版本保存目录', target);
  const preview = (await taskFrom(app, '预览安装', 'preview_resource_install')).result;
  if (!preview?.canApply || !same(preview.targetPath, target) || preview.files.length !== archive.files.length) throw new Error('Native installation preview did not match the exact generated text package.');
  for (const expected of archive.files) if (!preview.files.some(file => file.path === expected.path && file.role === expected.role)) throw new Error('Native installation preview did not preserve each explicitly selected file role.');
  const result = (await taskFrom(app, '确认安装这些文件', 'apply_resource_install')).result;
  if (!result?.complete || !same(result.resource?.rootPath || '', target)) throw new Error('Native generated installation did not complete.');
  await verifyHashes(target, Object.fromEntries(archive.files.map(file => [file.path, file.sha256])));
  return { name, root: target, resourceId: result.resource.id, preview, result };
}
async function repairAndStage(app, fixture, installed) {
  const original = fixture.archives.find(file => file.name === 'v1'), next = fixture.archives.find(file => file.name === 'v2');
  // This is deliberate damage to a newly generated, never-executed text fixture,
  // not cleanup of an existing tool. The normal UI must restore this exact file.
  const missing = join(installed.root, 'bin/runtime.txt');
  if (!inside(missing, fixture.resourcesRoot) || hash(await readFile(missing)) !== original.files.find(file => file.path === 'bin/runtime.txt').sha256) throw new Error('Only the original generated runtime fixture may be removed to exercise repair.');
  const preservedPaths = original.files.filter(file => file.path !== 'bin/runtime.txt');
  await writeFile(join(installed.root, 'settings.json'), '{"synthetic":true,"value":"user-edited"}\n');
  await writeFile(join(installed.root, 'unknown-user.txt'), 'New original synthetic unknown file, must survive.\n', { flag: 'wx' });
  const preserved = await hashes(installed.root, [...preservedPaths, { path: 'unknown-user.txt' }]); await unlink(missing);
  await invoke(app, '修复缺失文件');
  const plan = (await taskFrom(app, '预览修复范围', 'preview_resource_repair')).result;
  if (!plan?.canApply || !plan.files.some(file => file.path === 'bin/runtime.txt' && file.decision === 'restore')) throw new Error('Native repair did not identify the generated missing runtime file.');
  const repaired = (await taskFrom(app, '确认补齐这些文件', 'apply_resource_repair')).result;
  if (!repaired?.complete || !repaired.ownershipSaved || hash(await readFile(missing)) !== original.files.find(file => file.path === 'bin/runtime.txt').sha256) throw new Error('Native missing-file repair did not complete with recorded ownership.');
  await verifyHashes(installed.root, preserved); await invoke(app, '关闭修复');
  await invoke(app, '更新运行版本'); await field(app, '候选版本 ZIP', next.path); await taskFrom(app, '读取文件清单', 'resource_package_inspect');
  const candidate = join(fixture.resourcesRoot, 'prepared-v2'); await field(app, '固定版本', 'v2'); await field(app, '候选保存目录（必须为未使用的新目录）', candidate); await invoke(app, '全选文件');
  for (const file of next.files.filter(file => file.role === 'privateDependency')) await select(app, `文件用途：${file.path}`, '专用依赖');
  const stagePlan = (await taskFrom(app, '预览候选版本', 'preview_resource_update')).result;
  if (!stagePlan?.canApply || !same(stagePlan.originalPath, installed.root) || !same(stagePlan.targetPath, candidate)) throw new Error('Native candidate preview scope differs from the generated original/new roots.');
  for (const expected of next.files) if (stagePlan.files?.[expected.path] !== expected.role) throw new Error('Native candidate preview did not preserve the selected runtime and private dependency roles.');
  const staged = (await taskFrom(app, '确认准备这些文件', 'apply_resource_update_stage')).result;
  if (!staged?.complete || !staged.staged || staged.switched || !same(staged.resource?.rootPath || '', installed.root)) throw new Error('Native stage failed or unexpectedly switched the original runtime.');
  await verifyHashes(candidate, Object.fromEntries(next.files.map(file => [file.path, file.sha256]))); await verifyHashes(installed.root, preserved);
  return { repairPlan: plan, repaired, stagePlan, staged, originalRetained: true, noExecutionOrSwitch: true };
}
const extents = { disable: '停用，保留全部文件', runtime: '卸载运行部分，保留个人资料', complete: '完整卸载已确认归属内容', custom: '自定义范围' };
async function remove(app, fixture, installed, extent) {
  const archive = fixture.archives.find(file => file.name === 'v1');
  const unknownPath = join(installed.root, 'unknown-user.txt'); await writeFile(unknownPath, 'New original synthetic unknown file, must survive removal.\n', { flag: 'wx' });
  const before = await hashes(installed.root, [...archive.files, { path: 'unknown-user.txt' }]);
  await invoke(app, '卸载或停用'); await select(app, '本次卸载程度', extents[extent]);
  let previewTask;
  if (extent === 'custom') {
    const scope = (await taskFrom(app, '读取可选择范围', 'preview_resource_remove')).result;
    const chosen = scope.entries.find(file => file.relative === 'cache/cache.txt'); if (!chosen?.expected) throw new Error('Generated custom removal target is not owned and selectable.');
    await toggle(app, chosen.path); previewTask = await taskFrom(app, '预览本次影响', 'preview_resource_remove');
  } else previewTask = await taskFrom(app, '预览本次影响', 'preview_resource_remove');
  const plan = previewTask.result;
  if (!plan?.canApply || plan.extent !== extent || !same(plan.targetPath, installed.root) || plan.systemEntries?.length) throw new Error('Synthetic native removal scope is not the exact new fixture, or unexpectedly includes a system entry.');
  const result = (await taskFrom(app, '确认按此清单处理', 'apply_resource_remove')).result;
  if (!result?.complete || result.resource?.enabled !== false) throw new Error('Native selected removal extent did not complete/disable the exact fixture.');
  for (const entry of plan.entries) { if (!inside(entry.path, installed.root)) throw new Error('Native removal plan escaped the exact generated resource root.'); if (entry.remove ? await exists(entry.path) : !(await exists(entry.path))) throw new Error('Native removal filesystem result differs from the selected preview.'); }
  for (const entry of plan.metadataEntries || []) if (entry.remove && await exists(entry.path)) throw new Error('Native metadata removal was not applied as previewed.');
  const retained = Object.fromEntries(Object.entries(before).filter(([path]) => !plan.entries.some(entry => entry.remove && same(entry.path, join(installed.root, path))))); await verifyHashes(installed.root, retained);
  if (extent === 'disable' && plan.entries.some(entry => entry.remove)) throw new Error('Disable unexpectedly selected file deletion.');
  if (extent === 'runtime' && ['bin/runtime.txt', 'private/dependency.txt'].some(path => !plan.entries.some(entry => entry.remove && entry.relative === path))) throw new Error('Runtime removal did not include the generated runtime/private dependency.');
  if (extent === 'custom' && (plan.entries.filter(entry => entry.remove).length !== 1 || !plan.entries.some(entry => entry.remove && entry.relative === 'cache/cache.txt'))) throw new Error('Custom removal selected more than the one generated cache file.');
  await invoke(app, '关闭卸载'); return { extent, preview: plan, result, retainedHashes: retained, confirmation: 'separate real UI invocation of the current preview for this extent; no confirmation flags or backend apply shortcut' };
}

if ((options.phase || 'prepare') === 'prepare') { const fixture = await prepare(); console.log(JSON.stringify({ status: 'prepared-not-run', fixture: join(fixture.root, 'dataset.json') })); }
else {
  if (options.phase !== 'run') throw new Error('Use --phase prepare or --phase run.');
  const fixture = await readFixture(options.fixture || ''), executable = resolve(options.candidate || ''), info = JSON.parse(await readFile(resolve(options['candidate-build-info'] || ''), 'utf8'));
  const sha256 = hash(await readFile(executable));
  if (info.buildMode !== 'release' || (info.executableSha256 || info.sha256)?.toLowerCase() !== sha256 || !(info.sourceIdentity || info.sourceCommit) || await exists(join(fixture.dataDir, 'manager.sqlite3'))) throw new Error('Native lifecycle requires exact release/source provenance and a fresh never-run synthetic database.');
  const reportPath = join(fixture.root, 'lifecycle-result.json'), report = { formatVersion: 1, status: 'incomplete', syntheticOnly: true, fixture: fixture.root, resourcesRoot: fixture.resourcesRoot, candidateSha256: sha256, candidateSourceIdentity: info.sourceIdentity || info.sourceCommit, startedAt: new Date().toISOString(), scope: fixture.scope, removals: [] };
  let app;
  try {
    app = await NativeUiaSession.launch({ executable, sha256, dataDir: fixture.dataDir, reportPath: join(fixture.root, 'native-driver.json'), accessibilityInput }); report.native = app.identity;
    report.inputMethod = accessibilityInput ? 'native-accessibility-patterns' : 'SendInput';
    report.foregroundSelectionRequested = foregroundSelection;
    report.manualSelectionRequested = manualSelection;
    if (manualSelection) { report.inputMethod += '+external-operator-combo-selection'; report.functionalSelections = functionalSelections; report.selectionScope = 'Functional native combo state observations only; external selections are not automated selection or performance acceptance.'; }
    await invoke(app, '工具', '主要导航');
    const installed = await install(app, fixture, 'repair-stage', true); report.install = installed; report.repairAndStage = await repairAndStage(app, fixture, installed);
    await invoke(app, '关闭工具详情');
    for (const extent of Object.keys(extents)) { const resource = await install(app, fixture, extent); report.removals.push(await remove(app, fixture, resource, extent)); await invoke(app, '关闭工具详情'); }
    await app.quit(); app = null; report.status = 'passed-synthetic-native-scope';
  } catch (error) {
    report.status = 'failed-or-blocked'; report.error = String(error); process.exitCode = 1;
    if (app) {
      try { report.failureInterface = await app.call('names'); } catch (observationError) { report.failureObservationError = String(observationError); }
      try { await app.call('screenshot', { path: join(fixture.root, 'failure.png') }); } catch (observationError) { report.failureScreenshotError = String(observationError); }
    }
  }
  finally { if (app) { try { await app.quit(); } catch (error) { report.normalExitError = String(error); report.status = 'failed-or-blocked'; process.exitCode = 1; } } report.finishedAt = new Date().toISOString(); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ status: report.status, report: reportPath, error: report.error || null })); }
}
