import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, basename, toNamespacedPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeUiaSession } from './native-uia-client.mjs';

// Preparation writes generated initial fixtures only. Run-phase database access
// is strictly read-only: every tested mutation goes through the real native UI.
const format = 'agent-resource-manager-native-maintenance-v1';
const driverFormat = 'agent-resource-manager-native-performance-v1';
const approved = 'D:\\03_github_projects\\Agent_Resource_Manager\\validation';
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, index, all) => arg.startsWith('--') ? [...pairs, [arg.slice(2), all[index + 1]?.startsWith('--') || !all[index + 1] ? true : all[index + 1]]] : pairs, []));
if (Object.hasOwn(args, 'transport-file-sha256') && (typeof args['transport-file-sha256'] !== 'string' || !/^[a-f0-9]{64}$/i.test(args['transport-file-sha256']))) throw new Error('--transport-file-sha256 requires one exact SHA256 digest.');
const requestedTransportSha256 = args['transport-file-sha256']?.toLowerCase();
const phase = args.phase;
if (args.help) {
  console.log('Prepare only: --phase prepare [--variant service]. Explicit native run: --phase run --prepared <fixture.json> --candidate <release.exe> --candidate-build-info <json>. The default variant covers the existing scene and manual pause/resume flow. The separate service variant uses the existing Node runtime and one generated helper to check manual invocation outside a seeded maintenance window, UI-configured six-second idle release, explicit keepalive and a real dependent task. It runs only new synthetic resources, with no network or installation. Optional --foreground-select true permits guarded foreground keyboard selection only for the default pause-duration dropdown.');
  console.log('Optional --transport-file-sha256 <64hex> verifies the formal stdio executable independently of the selected release candidate. Omit it to retain the candidate-digest default; the strict ownership preflight and synthetic fixture checks remain unchanged.');
  process.exit(0);
}
assert.ok(['prepare', 'run'].includes(phase), 'Pass an explicit --phase prepare or --phase run.');
assert.ok(args.variant === undefined || ['scenes', 'service'].includes(args.variant), '--variant accepts scenes or service.');
assert.ok(args['foreground-select'] === undefined || [true, 'true', 'false'].includes(args['foreground-select']), '--foreground-select accepts only true or false.');
const foregroundSelection = args['foreground-select'] === true || args['foreground-select'] === 'true';
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = async path => hash(await readFile(path));
const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
const inside = (path, root) => { const rel = relative(resolve(root), resolve(path)); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
const sleep = ms => new Promise(done => setTimeout(done, ms));
const json = value => JSON.stringify(value, null, 2) + '\n';
const maintenanceScope = {
  scene: 'Create one definition with a selected generated Skill, activate it, edit its name/members, exit and remove it; compare exact task results and persisted scene rows after each mutation.',
  pause: 'Select until manual recovery, pause automatic maintenance, verify policy and status text, resume and verify persisted/UI policy.',
  resources: 'Two generated SKILL.md text files. No executable, tool action, GitHub source, client connection or automatic policy is seeded.',
  observations: 'Run-phase SQLite handles are read-only; task_list/task_get are existing read-only owner-bound bridge observations.',
};
const limitations = [
  'Not a performance, full scheduler, invocation, maintenance-window, multi-window conflict or complete-plan acceptance result.',
  'Source rebind is excluded: preview_resource_source and apply_resource_source verify GitHub repository identity over the network. This offline script does not replace that verification with a simulated database edit.',
  'Native accessibility control activation is used except an explicitly requested pause-duration foreground keyboard selection; physical pointer and visual theme acceptance require their own evidence.',
];
const serviceScope = {
  window: 'Seed a closed local-time maintenance window, invoke the owned service manually, observe idle suppression, then disable the window through the ordinary settings UI.',
  idle: 'Use the normal idle settings UI to select six seconds, verify explicit keepalive and an actual dependent task keep the service alive, then observe its scheduler-driven idle_released status.',
  resources: 'Two generated tool directories, one fixed copied helper and the existing shared Node executable. Runtime mutations use the ordinary native UI only.',
};
const serviceLimitations = [
  'The window is seeded before startup. This does not exercise native time-input editing, a clock transition, login leases, automatic downloads or full-plan acceptance.',
  'The short idle policy is an explicit setting on this synthetic service only. Production scheduler intervals and deadlines are unchanged.',
  'The helper has a separate 180-second service lifetime. Its natural exit cannot satisfy the required idle_released outcome.',
];

async function prepareService(resourcesRoot, createdAt) {
  const serviceRoot = join(resourcesRoot, 'service'), consumerRoot = join(resourcesRoot, 'consumer');
  await mkdir(serviceRoot); await mkdir(consumerRoot);
  const helperPath = join(serviceRoot, 'native-maintenance-service.mjs');
  const helper = await readFile(fileURLToPath(new URL('native-maintenance-service.mjs', import.meta.url)));
  await writeFile(helperPath, helper, { flag: 'wx' });
  const nodePath = await realpath(process.execPath), nodeSha256 = await digest(nodePath);
  const resources = ['service', 'consumer'].map(mode => {
    const rootPath = mode === 'service' ? serviceRoot : consumerRoot;
    const definition = {
      id: mode, label: mode === 'service' ? '维护验收服务' : '维护验收依赖调用', mode: mode === 'service' ? 'service' : 'task', cancellable: true, timeoutSeconds: null,
      executable: toNamespacedPath(nodePath), executableSha256: nodeSha256, workingDirectory: toNamespacedPath(rootPath),
      args: [{ type: 'literal', value: helperPath }, { type: 'literal', value: mode }], parameters: [],
      ...(mode === 'service' ? { idleReleaseSafe: false, idleUsageTracked: false, idleTimeoutSeconds: 0 } : {}),
    };
    return { id: `native-maintenance-${mode}`, name: `Native Maintenance ${mode === 'service' ? 'Service' : 'Consumer'}`, kind: 'cli', rootPath, repository: null, version: '1.0.0', sourceBinding: null, sourceHistory: [], alias: '', notes: 'Generated local maintenance acceptance resource.', enabled: true, ownership: 'external', managementScope: 'invoke', actions: [definition], capabilities: [], updatePolicy: { mode: 'manual', intervalHours: 24, pinnedVersion: null, skippedVersions: [] }, installation: null, revision: 1, createdAt, updatedAt: createdAt };
  });
  const local = new Date(), minute = local.getHours() * 60 + local.getMinutes();
  return { resources, files: [{ path: helperPath, sha256: hash(helper) }], nodePath, nodeSha256, serviceRoot, consumerRoot, idleSeconds: 6, protectedObservationMs: 8000, window: { startMinute: (minute + 120) % 1440, endMinute: (minute + 180) % 1440 } };
}

async function prepare() {
  const variant = args.variant || 'scenes';
  await mkdir(join(approved, 'manager-data'), { recursive: true });
  await mkdir(join(approved, 'resources'), { recursive: true });
  const root = await mkdtemp(join(approved, 'manager-data', 'native-maintenance-'));
  const resourcesRoot = await mkdtemp(join(approved, 'resources', 'native-maintenance-'));
  const dataDir = join(root, 'data'); await mkdir(dataDir);
  const skills = [], files = [], createdAt = new Date().toISOString();
  for (let index = 0; index < 2; index++) {
    const key = String(index).padStart(4, '0'), id = `perf-skill-${key}`, path = join(resourcesRoot, id);
    await mkdir(path);
    const bytes = Buffer.from(`---\nname: ${id}\ndescription: Inert generated native maintenance fixture.\nmetadata:\n  version: "1.0.0"\n---\n\n# Perf Skill ${key}\n\nGenerated text only. No external references, execution or network.\n`);
    await writeFile(join(path, 'SKILL.md'), bytes, { flag: 'wx' });
    files.push({ path: join(path, 'SKILL.md'), sha256: hash(bytes) });
    skills.push({ id, name: id, displayName: `Perf Skill ${key}`, description: 'Generated maintenance test content.', localPath: path, status: 'local_only', version: '1.0.0', runtimeFiles: ['SKILL.md'], runtimeConfirmed: true, runtimeAudit: { status: 'verified', warnings: [], checkedAt: createdAt }, runtimeWarnings: [], runtimeIssues: [], localHashes: { 'SKILL.md': hash(bytes) }, favorite: false, readOnly: false });
  }
  const settings = { checkIntervalMinutes: 30, uiTheme: 'dark', uiZoom: 100, uiFontSize: 18, uiDensity: 'comfortable', uiAccent: 'violet', uiMotion: 'none', libraryMode: 'list', libraryPageSize: 20, librarySort: 'name', categories: [], sidebarWidth: 224, sidebarCollapsed: false };
  const service = variant === 'service' ? await prepareService(resourcesRoot, createdAt) : null;
  if (service) { settings.maintenance = { revision: 1, pausedManually: false, pauseUntil: null, window: service.window }; files.push(...service.files); }
  const state = { skills, sources: [], connections: [], localRoots: [], ignoredLocalPaths: [], checkMode: 'manual', checkGeneration: 0, checkSummary: null, stateRevision: 1, settings };
  const dbPath = join(dataDir, 'manager.sqlite3'), db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE app_state(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,payload TEXT NOT NULL); CREATE TABLE workspace_state(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL); CREATE TABLE resource_catalog(id TEXT PRIMARY KEY,root_key TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL CHECK(revision>0),payload TEXT NOT NULL); CREATE TABLE resource_catalog_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL); BEGIN IMMEDIATE;');
    db.prepare('INSERT INTO app_state VALUES(1,1,?)').run(JSON.stringify(state));
    for (const resource of service?.resources || []) db.prepare('INSERT INTO resource_catalog VALUES(?,?,?,?)').run(resource.id, resource.rootPath.toLowerCase(), resource.revision, JSON.stringify(resource));
    db.prepare('INSERT INTO resource_catalog_meta VALUES(1,?)').run(service ? 1 : 0);
    if (service) {
      db.exec('CREATE TABLE resource_relations(id TEXT PRIMARY KEY,dependent_kind TEXT NOT NULL,dependent_id TEXT NOT NULL,dependency_kind TEXT NOT NULL,dependency_id TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(dependent_kind,dependent_id,dependency_kind,dependency_id)); CREATE TABLE resource_relations_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);');
      db.prepare('INSERT INTO resource_relations VALUES(?,?,?,?,?,?)').run('native-maintenance-dependency', 'tool', service.resources[1].id, 'tool', service.resources[0].id, createdAt);
      db.exec('INSERT INTO resource_relations_meta VALUES(1,1);');
    }
    db.exec('COMMIT;');
  } finally { db.close(); }
  const fixture = { format, variant, syntheticOnly: true, root, dataDir, dbPath, resourcesRoot, skillCount: 2, toolCount: service ? 2 : 0, ...(service ? { service } : {}), skills: skills.map(({ id, name, displayName, localPath, version, localHashes, runtimeFiles }) => ({ id, name, displayName, localPath, version, localHashes, runtimeFiles })), files, initialDatabaseSha256: await digest(dbPath), sceneName: 'Native Maintenance Review', editedSceneName: 'Native Maintenance Review Edited', createdAt };
  await writeFile(join(root, 'fixture-owner.json'), json({ format: driverFormat, purpose: format, syntheticOnly: true }));
  await writeFile(join(root, 'dataset.json'), json({ ...fixture, format: driverFormat }));
  await writeFile(join(root, 'fixture.json'), json(fixture));
  await writeFile(join(root, 'report.json'), json({ format, status: 'prepared-not-run', fixture: join(root, 'fixture.json'), scope: service ? serviceScope : maintenanceScope, limitations: service ? serviceLimitations : limitations, noNativeLaunch: true }));
  return fixture;
}
async function readFixture(path) {
  path = resolve(path); assert.ok(inside(path, join(approved, 'manager-data')));
  const fixture = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(fixture.format, format); assert.equal(fixture.syntheticOnly, true);
  assert.ok(inside(fixture.root, join(approved, 'manager-data')) && inside(fixture.resourcesRoot, join(approved, 'resources')));
  assert.ok(same(path, join(fixture.root, 'fixture.json')) && same(fixture.dataDir, join(fixture.root, 'data')) && same(fixture.dbPath, join(fixture.dataDir, 'manager.sqlite3')));
  for (const directory of [fixture.root, fixture.dataDir, fixture.resourcesRoot]) assert.ok(same(await realpath(directory), directory), 'No redirected synthetic directory.');
  const owner = JSON.parse(await readFile(join(fixture.root, 'fixture-owner.json'), 'utf8'));
  assert.deepEqual(owner, { format: driverFormat, purpose: format, syntheticOnly: true });
  assert.equal(fixture.skills.length, 2); assert.ok(['scenes', 'service'].includes(fixture.variant || 'scenes'));
  assert.equal(fixture.toolCount, fixture.variant === 'service' ? 2 : 0);
  if (args.variant !== undefined) assert.equal(args.variant, fixture.variant || 'scenes');
  if (fixture.variant === 'service') {
    const service = fixture.service;
    assert.ok(same(service.nodePath, await realpath(process.execPath))); assert.equal(await digest(service.nodePath), service.nodeSha256);
    for (const [mode, rootPath] of [['service', service.serviceRoot], ['consumer', service.consumerRoot]]) {
      assert.ok(same(rootPath, join(fixture.resourcesRoot, mode)) && same(await realpath(rootPath), rootPath));
      await assert.rejects(readFile(join(rootPath, 'started.json')), error => error.code === 'ENOENT', 'A service fixture is single-use.');
    }
    assert.equal(service.idleSeconds, 6); assert.equal(service.protectedObservationMs, 8000);
    const local = new Date(), minute = local.getHours() * 60 + local.getMinutes();
    const nextStartMinutes = (service.window.startMinute - minute + 1440) % 1440;
    assert.ok(nextStartMinutes >= 10 && nextStartMinutes <= 120, 'Prepare a fresh closed-window fixture near its run time.');
    assert.ok(Date.now() - Date.parse(fixture.createdAt) < 30 * 60 * 1000, 'The service fixture must be run within thirty minutes of preparation.');
  }
  await verifyFiles(fixture); return fixture;
}
async function verifyFiles(fixture) {
  for (const file of fixture.files) {
    assert.ok(inside(file.path, fixture.resourcesRoot)); assert.ok(same(await realpath(file.path), file.path));
    assert.equal(await digest(file.path), file.sha256, 'Generated runtime text changed.');
  }
}
function persisted(fixture) {
  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try {
    db.exec('BEGIN');
    const table = name => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    const state = JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload);
    const scenes = table('resource_scenes') ? db.prepare('SELECT id,name,members FROM resource_scenes ORDER BY id').all().map(row => ({ ...row, members: JSON.parse(row.members) })) : [];
    const sceneMeta = table('resource_scenes_meta') ? db.prepare('SELECT revision,active_scene_id FROM resource_scenes_meta WHERE id=1').get() || { revision: 0, active_scene_id: null } : { revision: 0, active_scene_id: null };
    const toolCount = db.prepare('SELECT COUNT(*) AS n FROM resource_catalog').get().n;
    const resources = db.prepare('SELECT payload FROM resource_catalog ORDER BY id').all().map(row => JSON.parse(row.payload));
    const relations = table('resource_relations') ? db.prepare('SELECT * FROM resource_relations ORDER BY id').all() : [];
    db.exec('COMMIT'); return { state, scenes, sceneMeta, toolCount, resources, relations };
  } finally { db.close(); }
}
async function candidate() {
  assert.equal(typeof args.candidate, 'string'); assert.equal(typeof args['candidate-build-info'], 'string');
  const path = resolve(args.candidate), buildInfoPath = resolve(args['candidate-build-info']);
  assert.equal(basename(path).toLowerCase(), 'agent-resource-manager.exe');
  const bytes = await readFile(path), offset = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.readUInt16LE(0), 0x5a4d); assert.equal(bytes.readUInt32LE(offset), 0x4550); assert.equal(bytes.readUInt16LE(offset + 4), 0x8664);
  const sha256 = hash(bytes), buildInfo = JSON.parse(await readFile(buildInfoPath, 'utf8'));
  assert.equal(buildInfo.buildMode, 'release'); assert.equal((buildInfo.executableSha256 || buildInfo.sha256)?.toLowerCase(), sha256); assert.ok(buildInfo.sourceIdentity || buildInfo.sourceCommit);
  return { path, sha256, buildInfoPath, buildInfoSha256: await digest(buildInfoPath), sourceIdentity: buildInfo.sourceIdentity || buildInfo.sourceCommit };
}
async function wait(read, expected, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) { const value = await read(); if (expected(value)) return value; if (Date.now() >= deadline) throw new Error('The exact native maintenance result did not become available; no action was replayed.'); await sleep(40); }
}
async function availableControl(app, name, type = 'ControlType.Button', scope) {
  const values = list(await app.call('state', { name, ...(scope ? { scope } : {}) }));
  const matches = values.filter(item => item.type === type && item.enabled);
  assert.ok(matches.length <= 1, 'Native maintenance control is ambiguous: ' + name); return matches.length === 1;
}
async function invoke(app, name, scope) {
  await wait(() => app.call('state', { name, ...(scope ? { scope } : {}) }), rows => {
    report.lastControlObservation = { name, scope: scope || null, rows: list(rows) };
    return list(rows).filter(row => row.type === 'ControlType.Button' && row.enabled).length === 1;
  });
  return app.call('invokeName', { name, ...(scope ? { scope } : {}) });
}
async function task(app, button, action, scope) {
  const before = new Set((await app.call('tasks')).tasks.map(item => item.id));
  await invoke(app, button, scope);
  const created = await wait(() => app.call('tasks'), value => value.tasks.some(item => !before.has(item.id) && item.action === action));
  const matches = created.tasks.filter(item => !before.has(item.id) && item.action === action);
  assert.equal(matches.length, 1, 'One native gesture must create exactly one expected task.');
  const done = (await wait(() => app.call('task', { taskId: matches[0].id }), value => value.task && !['queued', 'running'].includes(value.task.status), 45000)).task;
  assert.equal(done.status, 'succeeded', done.error || `Native ${action} failed.`);
  report.actions.push({ taskId: done.id, action, status: done.status }); await saveReport(); return done.result;
}
async function settings(app, group) {
  await invoke(app, '设置', '主要导航');
  if (!await availableControl(app, group)) {
    const toggles = list(await app.call('names')).filter(item => item.type === 'ControlType.Button' && item.name.startsWith('设置分类：'));
    assert.equal(toggles.length, 1, 'Settings navigation toggle must be unique.'); await invoke(app, toggles[0].name);
  }
  await invoke(app, group, '设置分类');
}
async function sceneFlow(app, fixture) {
  await settings(app, '场景'); await invoke(app, '管理场景'); await invoke(app, '新建场景');
  await app.call('setField', { name: '场景名称', value: fixture.sceneName });
  await app.call('toggle', { name: 'Skill Perf Skill 0000', checked: true });
  const saved = await task(app, '保存场景', 'resource_scene_save');
  const definition = saved.scenes.find(item => item.name === fixture.sceneName); assert.ok(definition);
  const members = [{ kind: 'skill', id: fixture.skills[0].id }];
  const stored = await wait(() => persisted(fixture), value => value.scenes.some(item => item.id === definition.id));
  assert.deepEqual(stored.scenes.find(item => item.id === definition.id).members, members); assert.equal(stored.sceneMeta.active_scene_id, null);
  await wait(() => app.call('comboState', { name: '场景定义' }), value => value.value === fixture.sceneName);
  const activated = await task(app, '启用此场景', 'resource_scene_activate'); assert.equal(activated.activeSceneId, definition.id);
  assert.equal(activated.candidates.find(item => item.id === fixture.skills[0].id).sceneEligible, true);
  assert.equal(activated.candidates.find(item => item.id === fixture.skills[1].id).sceneEligible, false);
  assert.equal(persisted(fixture).sceneMeta.active_scene_id, definition.id);
  await invoke(app, '编辑场景'); await app.call('setField', { name: '场景名称', value: fixture.editedSceneName });
  await app.call('toggle', { name: 'Skill Perf Skill 0001', checked: true });
  const edited = await task(app, '保存场景', 'resource_scene_save'); assert.equal(edited.activeSceneId, definition.id);
  const editedRow = persisted(fixture).scenes.find(item => item.id === definition.id); assert.equal(editedRow.name, fixture.editedSceneName); assert.deepEqual(editedRow.members, fixture.skills.map(item => ({ kind: 'skill', id: item.id })));
  const exited = await task(app, '退出当前场景', 'resource_scene_activate'); assert.equal(exited.activeSceneId, null); assert.equal(persisted(fixture).sceneMeta.active_scene_id, null);
  const removed = await task(app, '移除场景定义', 'resource_scene_remove'); assert.equal(removed.scenes.length, 0); assert.equal(persisted(fixture).scenes.length, 0);
  return { createdAndPersisted: true, selectedMembership: true, activationEligibilityObserved: true, editedAndPersisted: true, exited: true, removed: true };
}
async function pauseFlow(app, fixture) {
  await settings(app, '维护');
  const before = persisted(fixture).state.settings.maintenance;
  const selection = await app.call('selectCombo', { name: '暂停时长', option: '直到手动恢复', foreground: foregroundSelection });
  assert.equal(selection.selected, '直到手动恢复'); assert.equal(selection.functionalOnly, true);
  report.functionalSelections.push({ control: '暂停时长', option: '直到手动恢复', ...selection });
  const paused = await task(app, '暂停自动维护', 'set_maintenance');
  assert.equal(paused.maintenance.pausedManually, true); assert.equal(paused.maintenance.pauseUntil, null); assert.equal(paused.maintenance.automaticAllowed, false);
  const stored = persisted(fixture).state.settings.maintenance; assert.equal(stored.pausedManually, true); assert.equal(stored.pauseUntil, null); assert.equal(stored.revision, (before?.revision || 0) + 1);
  await wait(() => app.call('state', { name: '已暂停自动维护，等待手动恢复。' }), rows => list(rows).some(row => !row.offscreen));
  const resumed = await task(app, '恢复维护', 'set_maintenance'); assert.equal(resumed.maintenance.pausedManually, false); assert.equal(resumed.maintenance.pauseUntil, null); assert.equal(resumed.maintenance.automaticAllowed, true);
  const restored = persisted(fixture).state.settings.maintenance; assert.equal(restored.pausedManually, false); assert.equal(restored.pauseUntil, null); assert.equal(restored.window, null); assert.equal(restored.revision, stored.revision + 1);
  await wait(() => app.call('state', { name: '自动维护可按各项策略运行。' }), rows => list(rows).some(row => !row.offscreen));
  return { selectedManualRecovery: true, pausedPolicyAndUi: true, resumedPolicyAndUi: true, persistedRevisionAdvance: true, schedulerOrToolExecutionClaimed: false };
}

async function serviceFlow(app, fixture) {
  const service = fixture.service, [resource, consumer] = service.resources;
  const results = report.results.service = { observations: [] };
  async function stage(name) { report.currentStep = name; await saveReport(); }
  async function openTool(record, idle = false) {
    await invoke(app, '工具', '主要导航');
    if (!await availableControl(app, `使用${record.actions[0].label}`)) await invoke(app, record.name);
    if (idle && !await availableControl(app, '重新读取闲置状态')) await invoke(app, '闲置与保活');
  }
  async function observe(name) {
    const snapshot = await task(app, '重新读取闲置状态', 'resource_idle');
    assert.equal(snapshot.id, resource.id);
    const matches = snapshot.runs.filter(run => run.runId === results.run.runId);
    assert.equal(matches.length, 1); assert.equal(matches[0].pid, results.run.pid);
    results.observations.push({ name, observedAt: new Date().toISOString(), snapshot }); await saveReport();
    return matches[0];
  }
  function assertProtected(run, keepAlive, activeUses) {
    assert.equal(run.status, 'running'); assert.equal(run.keepAlive, keepAlive);
    assert.equal(run.activeUses, activeUses); assert.equal(run.loginUses, 0);
  }

  await stage('open-maintenance-settings');
  await settings(app, '维护');
  await stage('confirm-closed-window-presentation');
  const statusName = '当前不在自动维护时间窗口内。';
  const mountedStatus = await wait(() => app.call('state', { name: statusName }), rows => {
    results.closedWindowStatusObservation = list(rows);
    return list(rows).length > 0;
  });
  if (!list(mountedStatus).some(row => !row.offscreen)) {
    assert.equal(list(mountedStatus).length, 1, 'The offscreen closed-window status must identify one owned element.');
    results.closedWindowStatusReveal = await app.call('reveal', { name: statusName });
  }
  await wait(() => app.call('state', { name: statusName }), rows => {
    results.closedWindowStatusObservation = list(rows);
    return list(rows).some(row => !row.offscreen);
  });
  const policy = persisted(fixture).state.settings.maintenance;
  assert.deepEqual(policy.window, service.window); assert.equal(policy.pausedManually, false); assert.equal(policy.pauseUntil, null);
  const local = new Date(), minute = local.getHours() * 60 + local.getMinutes(), window = policy.window;
  const insideWindow = window.startMinute < window.endMinute ? minute >= window.startMinute && minute < window.endMinute : minute >= window.startMinute || minute < window.endMinute;
  assert.equal(insideWindow, false, 'Manual invocation requires the currently persisted maintenance window to be closed.');
  results.closedWindowPolicy = { policy, verifiedAt: local.toISOString(), localMinute: minute };
  await stage('manual-service-invocation-outside-window');
  await openTool(resource);
  await invoke(app, `使用${resource.actions[0].label}`);
  // The action button and its form share the same accessible name. The owned
  // resource detail uniquely contains both the selection and submit controls.
  const started = await task(app, '执行', 'resource_invoke', `${resource.name} 详情`);
  assert.equal(started.run.resourceId, resource.id); assert.equal(started.run.actionId, 'service');
  assert.equal(started.run.mode, 'service'); assert.equal(started.run.status, 'running');
  results.run = started.run;
  const marker = await wait(async () => { try { return JSON.parse(await readFile(join(service.serviceRoot, 'started.json'), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }, value => value?.pid === started.run.pid);
  assert.equal(marker.mode, 'service'); results.serviceProcessMarker = marker;

  await stage('configure-six-second-idle-through-ui');
  await invoke(app, '闲置与保活');
  await invoke(app, `调整${resource.actions[0].label}的闲置设置`);
  await app.call('setField', { name: '闲置分钟数', value: '0.1', numeric: true });
  await app.call('toggle', { name: '已确认此服务可以安全停止', checked: true });
  await app.call('toggle', { name: '此服务的调用都由管理器跟踪', checked: true });
  const configured = await task(app, '保存闲置设置', 'resource_idle_set');
  assert.equal(configured.id, resource.id);
  assert.deepEqual(configured.actions[0], { actionId: 'service', label: resource.actions[0].label, mode: 'service', idleReleaseSafe: true, idleUsageTracked: true, idleTimeoutSeconds: service.idleSeconds });
  results.configuredIdlePolicy = configured.actions[0];

  await stage('closed-window-suppresses-automatic-release');
  await sleep(service.protectedObservationMs);
  assertProtected(await observe('closed-window-after-idle-deadline'), false, 0);
  results.closedWindowRetainedService = true;

  await stage('keepalive-with-automatic-maintenance-enabled');
  const kept = await task(app, '保持此服务运行', 'resource_keep_alive');
  assertProtected(kept.run, true, 0);
  await settings(app, '维护');
  const windowFields = list(await app.call('fields')).filter(field => field.type === 'ControlType.CheckBox' && field.name.startsWith('每日维护时段'));
  assert.equal(windowFields.length, 1, 'The owned maintenance-window checkbox must be unique.');
  await app.call('toggle', { name: windowFields[0].name, checked: false });
  const opened = await task(app, '保存时间窗口', 'set_maintenance');
  assert.equal(opened.maintenance.window, null); assert.equal(opened.maintenance.automaticAllowed, true);
  assert.equal(persisted(fixture).state.settings.maintenance.window, null);
  await openTool(resource, true);
  await sleep(service.protectedObservationMs);
  assertProtected(await observe('explicit-keepalive-after-idle-deadline'), true, 0);
  results.keepAliveRetainedService = true;

  await stage('actual-dependent-task-protects-service');
  await openTool(consumer);
  await invoke(app, `使用${consumer.actions[0].label}`);
  const before = new Set((await app.call('tasks')).tasks.map(item => item.id));
  await invoke(app, '执行', `${consumer.name} 详情`);
  const created = await wait(() => app.call('tasks'), value => value.tasks.some(item => !before.has(item.id) && item.action === 'resource_invoke'));
  const matches = created.tasks.filter(item => !before.has(item.id) && item.action === 'resource_invoke');
  assert.equal(matches.length, 1); results.consumerTaskId = matches[0].id;
  const consumerMarker = await wait(async () => { try { return JSON.parse(await readFile(join(service.consumerRoot, 'started.json'), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }, value => value?.mode === 'consumer');
  results.consumerProcessMarker = consumerMarker;
  await openTool(resource, true);
  assertProtected(await observe('dependent-call-started'), true, 1);
  const unkept = await task(app, '解除明确保活', 'resource_keep_alive');
  assertProtected(unkept.run, false, 1);
  await sleep(service.protectedObservationMs);
  assertProtected(await observe('actual-call-after-idle-deadline'), false, 1);
  assert.equal((await app.call('task', { taskId: results.consumerTaskId })).task.status, 'running');
  results.activeCallRetainedService = true;

  await stage('dependent-completion-then-scheduler-idle-release');
  const done = (await wait(() => app.call('task', { taskId: results.consumerTaskId }), value => value.task && !['queued', 'running'].includes(value.task.status), 45000)).task;
  assert.equal(done.status, 'succeeded', done.error || 'The generated dependent task failed.');
  assert.equal(done.result.run.resourceId, consumer.id); assert.equal(done.result.run.pid, consumerMarker.pid);
  assert.equal(done.result.run.exitCode, 0); assert.equal(done.result.run.status, 'succeeded');
  const output = done.result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(output.length, 2); assert.equal(output[1].pid, consumerMarker.pid); assert.ok(output[1].finishedAt);
  report.actions.push({ taskId: done.id, action: done.action, status: done.status });
  const released = await wait(async () => { const run = await observe('post-call-idle-observation'); if (run.status === 'running') await sleep(500); return run; }, run => run.status !== 'running', 20000);
  assert.equal(released.status, 'idle_released', 'A helper natural exit or manual stop cannot establish automatic idle release.');
  assert.equal(released.activeUses, 0); assert.equal(released.loginUses, 0); assert.equal(released.keepAlive, false);
  assert.ok(Date.parse(released.finishedAt) - Date.parse(released.lastActivityAt) >= service.idleSeconds * 1000, 'Release preceded the recorded final activity deadline.');
  const finalUi = await wait(() => app.call('names'), rows => list(rows).some(row => row.type === 'ControlType.Text' && row.name.startsWith('闲置后已释放')));
  results.finalUiStatusName = list(finalUi).find(row => row.type === 'ControlType.Text' && row.name.startsWith('闲置后已释放')).name;
  results.schedulerReleasedAfterActualUse = true;
  const end = persisted(fixture);
  assert.deepEqual(end.resources.find(row => row.id === consumer.id), consumer);
  const expected = { ...resource, actions: [{ ...resource.actions[0], idleReleaseSafe: true, idleUsageTracked: true, idleTimeoutSeconds: 6 }] };
  const actual = end.resources.find(row => row.id === resource.id);
  assert.equal(actual.revision, resource.revision + 1);
  for (const key of Object.keys(expected).filter(key => !['revision', 'updatedAt'].includes(key))) assert.deepEqual(actual[key], expected[key], `Unexpected service record change: ${key}`);
  assert.equal(end.relations.length, 1); assert.equal(end.relations[0].dependent_id, consumer.id); assert.equal(end.relations[0].dependency_id, resource.id);
  assert.equal(await digest(service.nodePath), service.nodeSha256);
  await saveReport();
}

if (phase === 'prepare') {
  const fixture = await prepare();
  console.log(JSON.stringify({ status: 'prepared-not-run', fixture: join(fixture.root, 'fixture.json'), report: join(fixture.root, 'report.json'), dataDirectory: fixture.dataDir, resourcesRoot: fixture.resourcesRoot, noNativeLaunch: true }));
  process.exit(0);
}
assert.equal(typeof args.prepared, 'string', 'Native run requires an explicit prepared synthetic fixture.');
const fixture = await readFixture(args.prepared);
const serviceVariant = fixture.variant === 'service';
assert.equal(await digest(fixture.dbPath), fixture.initialDatabaseSha256, 'Run requires a fresh prepared database; partially executed writes are never replayed.');
const info = await candidate();
const transportSha256 = requestedTransportSha256 || info.sha256;
let report = { format, variant: fixture.variant || 'scenes', status: 'running', startedAt: new Date().toISOString(), fixture: resolve(args.prepared), candidate: info, transportFileSha256: transportSha256, scope: serviceVariant ? serviceScope : maintenanceScope, limitations: serviceVariant ? serviceLimitations : limitations, actions: [], results: {}, inputMethod: 'native-accessibility-patterns', foregroundSelectionRequested: foregroundSelection, functionalSelections: [] };
const reportPath = join(fixture.root, 'report.json');
async function saveReport() { await writeFile(reportPath, json(report)); }
let app;
try {
  report.harness = await Promise.all(['verify-native-maintenance.mjs', 'native-uia-client.mjs', 'verify-native-uia.ps1', ...(serviceVariant ? ['native-maintenance-service.mjs'] : [])].map(async name => ({ name, sha256: await digest(fileURLToPath(new URL(name, import.meta.url))) })));
  await saveReport();
  app = await NativeUiaSession.launch({ executable: info.path, dataDir: fixture.dataDir, reportPath: join(fixture.root, 'native-driver.json'), sha256: info.sha256, transportSha256, accessibilityInput: true });
  assert.equal(app.identity.executableSha256, info.sha256); assert.ok(same(app.identity.dataDirectory, fixture.dataDir)); report.native = app.identity;
  if (serviceVariant) await serviceFlow(app, fixture);
  else { report.results.scenes = await sceneFlow(app, fixture); report.results.maintenance = await pauseFlow(app, fixture); }
  const end = persisted(fixture); assert.equal(end.toolCount, serviceVariant ? 2 : 0); assert.equal(end.state.checkMode, 'manual');
  for (const original of fixture.skills) { const actual = end.state.skills.find(item => item.id === original.id); for (const [key, value] of Object.entries(original)) assert.deepEqual(actual[key], value, `Synthetic Skill ${key} changed.`); }
  for (const key of ['sources', 'connections', 'localRoots']) assert.equal(end.state[key].length, 0);
  const tasks = (await app.call('tasks')).tasks;
  if (serviceVariant) {
    assert.equal(tasks.filter(item => item.action === 'resource_invoke').length, 2);
    assert.ok(!tasks.some(item => /^(apply_resource_|resource_stop|check_now)/.test(item.action)), 'Unexpected lifecycle, manual stop or check task.');
  } else assert.ok(!tasks.some(item => /^(resource_invoke|apply_resource_|resource_stop|check_now)/.test(item.action)), 'Unexpected lifecycle, invocation or check task.');
  await verifyFiles(fixture); report.generatedResourcesUnchanged = true; report.noExecutionTasksObserved = !serviceVariant;
  report.normalExit = (await app.quit()).driverReport.closedNormally; app = null;
  for (const file of report.harness) assert.equal(await digest(fileURLToPath(new URL(file.name, import.meta.url))), file.sha256, 'Measurement helper changed during native run.');
  assert.equal(await digest(info.path), info.sha256); assert.equal(await digest(info.buildInfoPath), info.buildInfoSha256);
  report.status = serviceVariant ? 'passed-native-owned-service-window-keepalive-idle-scope' : 'passed-scenes-and-maintenance-native-synthetic-only';
} catch (error) {
  report.status = 'failed-or-blocked'; report.error = String(error); process.exitCode = 1;
  if (serviceVariant && app && !app.exited) {
    try {
      const names = list(await app.call('names', {}, 10000));
      report.failureUiNames = {
        namedElementCount: names.length,
        entries: names.filter(row => ['ControlType.Button', 'ControlType.Edit', 'ControlType.CheckBox', 'ControlType.ComboBox', 'ControlType.Spinner'].includes(row.type) || /维护|服务|执行|保活|闲置/.test(row.name)).slice(0, 120),
      };
    } catch (cause) { report.failureUiNamesError = String(cause); }
    try {
      const path = join(fixture.root, 'maintenance-failure.png');
      await app.call('screenshot', { path }, 10000); report.failureScreenshot = path;
    } catch (cause) { report.failureScreenshotError = String(cause); }
  }
}
finally {
  if (app) { try { report.normalExit = (await app.quit()).driverReport.closedNormally; } catch (error) { report.normalExit = false; report.closeError = String(error); } }
  report.finishedAt = new Date().toISOString(); await saveReport();
}
console.log(JSON.stringify({ status: report.status, report: reportPath, normalExit: report.normalExit }));
