import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeUiaSession } from './native-uia-client.mjs';
import { storedZip } from './performance-load-fixture.mjs';

// The installed target obtains its real ownership receipt through the UI.
// No source identity, installation receipt, execution proof or grant is seeded.
const FORMAT = 'agent-resource-manager-native-source-relations-v1';
const DRIVER_FORMAT = 'agent-resource-manager-native-performance-v1';
const validation = 'D:\\03_github_projects\\Agent_Resource_Manager\\validation';
const dataParent = join(validation, 'manager-data'), resourceParent = join(validation, 'resources');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, flag, index, all) => flag.startsWith('--') ? [...pairs, [flag.slice(2), all[index + 1]?.startsWith('--') || !all[index + 1] ? true : all[index + 1]]] : pairs, []));
const phase = args.phase, foregroundSelection = args['foreground-select'] === true || args['foreground-select'] === 'true';
if (args.help) {
  console.log('Prepare only: --phase prepare --old-repository <public GitHub HTTPS URL> --new-repository <different public GitHub HTTPS URL>. Run: --phase run --prepared <dataset.json> --candidate <release.exe> --candidate-build-info <json> [--foreground-select true]. Actual UI installs a three-file inert ZIP, checks live repository health, invalidates a source preview by saving a note, confirms a fresh rebind, and adds/removes dependencies. Removal is previewed; the only apply attempt must fail after a relation change. No successful removal, tool execution, credential access, third-party asset download or production data is requested.');
  process.exit(0);
}
assert.ok(['prepare', 'run'].includes(phase));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = async path => hash(await readFile(path));
const normalized = path => resolve(path.replace(/^\\\\\?\\(?=[a-z]:\\)/i, ''));
const same = (left, right) => normalized(left).toLowerCase() === normalized(right).toLowerCase();
const inside = (path, root) => { const value = relative(normalized(root), normalized(path)); return value === '' || !value.startsWith('..') && !isAbsolute(value); };
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const json = value => JSON.stringify(value, null, 2) + '\n';
const sleep = ms => new Promise(done => setTimeout(done, ms));
const targetName = 'Native Source Target', consumerName = 'Native Source Consumer';
const note = 'Generated personal note. Preserve this exact note across source rebind.';
const limitations = [
  'Focused actual native repository-level source health/rebind and dependency/removal-impact acceptance only; not all source mappings or complete-plan acceptance.',
  'The generated ZIP is original inert test text. Its entered repository/version are explicitly unverified registration metadata, never a claim that these bytes were published by either repository.',
  'Live GitHub repository metadata is read only during the native run. Authentication, network failure, rate limiting or changed repository identity fail this check without retries or substitution.',
  'A source preview invalidated by a real metadata revision cannot be confirmed in the UI. A removal preview is submitted after a real relation revision and must be rejected before any file write.',
  'No successful uninstall is attempted, no executable is installed or invoked, and no automatic maintenance grant is created. Existing lifecycle and backend tests cover additional removal/failure variants.',
  'Concrete release-asset/subdirectory mappings, Skill reassociation, stale capability execution evidence and cross-window mutation are outside this focused native fixture.',
];
function repository(value) {
  assert.equal(typeof value, 'string');
  assert.match(value, /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  return value.replace(/\.git$/i, '');
}
async function absent(path) { await assert.rejects(lstat(path), error => error.code === 'ENOENT', 'A generated destination must be unused.'); }
function persisted(fixture) {
  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try {
    const exists = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    const rows = table => exists(table) ? db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row })) : [];
    return { state: JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload), resources: rows('resource_catalog').map(row => JSON.parse(row.payload)), relations: rows('resource_relations'), grants: rows('resource_automation_grants'), downloads: rows('download_records') };
  } finally { db.close(); }
}
async function prepare() {
  const oldRepository = repository(args['old-repository']), newRepository = repository(args['new-repository']);
  assert.notEqual(oldRepository.toLowerCase(), newRepository.toLowerCase());
  await mkdir(dataParent, { recursive: true }); await mkdir(resourceParent, { recursive: true });
  const root = await mkdtemp(join(dataParent, 'native-source-relations-'));
  const resourcesRoot = await mkdtemp(join(resourceParent, 'native-source-relations-'));
  const dataDir = join(root, 'data'), dbPath = join(dataDir, 'manager.sqlite3'), consumerRoot = join(resourcesRoot, 'consumer');
  await mkdir(dataDir); await mkdir(consumerRoot);
  const createdAt = new Date().toISOString(), sourceFiles = [], skills = [];
  for (let index = 0; index < 2; index++) {
    const key = String(index).padStart(4, '0'), id = `perf-skill-${key}`, localPath = join(resourcesRoot, id); await mkdir(localPath);
    const text = `---\nname: ${id}\ndescription: Inert native source and relations fixture.\nmetadata:\n  version: "1.0.0"\n---\n\n# Perf Skill ${key}\n\nGenerated text only.\n`;
    const path = join(localPath, 'SKILL.md'); await writeFile(path, text, { flag: 'wx' }); sourceFiles.push({ path, sha256: hash(text) });
    skills.push({ id, name: id, displayName: `Perf Skill ${key}`, description: 'Generated source/relations acceptance text.', localPath, status: 'local_only', version: '1.0.0', runtimeFiles: ['SKILL.md'], runtimeConfirmed: true, runtimeAudit: { status: 'verified', warnings: [], checkedAt: createdAt }, runtimeWarnings: [], runtimeIssues: [], localHashes: { 'SKILL.md': hash(text) }, favorite: false, readOnly: false });
  }
  const consumerText = 'Original generated consumer text. No executable, installation receipt or permissions.\n';
  const consumerFile = join(consumerRoot, 'README.md'); await writeFile(consumerFile, consumerText, { flag: 'wx' }); sourceFiles.push({ path: consumerFile, sha256: hash(consumerText) });
  const files = [
    { path: 'LICENSE', role: 'license', bytes: Buffer.from('Original generated fixture text. No third-party code.\n') },
    { path: 'runtime.txt', role: 'runtime', bytes: Buffer.from('Generated inert runtime text; no execution.\n') },
    { path: 'settings.json', role: 'configuration', bytes: Buffer.from('{"synthetic":true,"personalValue":"keep-original"}\n') },
  ];
  const archivePath = join(resourcesRoot, 'original-generated-fixture.zip'), archiveBytes = storedZip(files); await writeFile(archivePath, archiveBytes, { flag: 'wx' });
  sourceFiles.push({ path: archivePath, sha256: hash(archiveBytes) });
  const consumer = { id: 'native-source-consumer', name: consumerName, kind: 'portable', rootPath: consumerRoot, repository: null, version: '1.0.0', alias: '', notes: 'Original generated consumer metadata.', enabled: true, ownership: 'external', managementScope: 'register', actions: [], capabilities: [], updatePolicy: { mode: 'manual', intervalHours: 24, pinnedVersion: null, skippedVersions: [] }, installation: null, revision: 1, createdAt, updatedAt: createdAt };
  const state = { skills, sources: [], connections: [], localRoots: [], ignoredLocalPaths: [], checkMode: 'manual', checkGeneration: 0, checkSummary: null, stateRevision: 1, settings: { checkIntervalMinutes: 30, uiTheme: 'dark', uiZoom: 100, uiFontSize: 18, uiDensity: 'comfortable', uiAccent: 'violet', uiMotion: 'none', libraryMode: 'list', libraryPageSize: 20, librarySort: 'name', categories: [], sidebarWidth: 224, sidebarCollapsed: false } };
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE app_state(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,payload TEXT NOT NULL); CREATE TABLE workspace_state(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL); CREATE TABLE resource_catalog(id TEXT PRIMARY KEY,root_key TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL CHECK(revision>0),payload TEXT NOT NULL); CREATE TABLE resource_catalog_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);');
    db.prepare('INSERT INTO app_state VALUES(1,1,?)').run(JSON.stringify(state));
    db.prepare('INSERT INTO resource_catalog VALUES(?,?,?,?)').run(consumer.id, consumer.rootPath.toLowerCase(), consumer.revision, JSON.stringify(consumer)); db.prepare('INSERT INTO resource_catalog_meta VALUES(1,1)').run();
  } finally { db.close(); }
  const fixture = { format: FORMAT, driverFormat: DRIVER_FORMAT, syntheticOnly: true, root, resourcesRoot, dataDir, dbPath, sourceFiles, skills, consumer, archivePath, archiveSha256: hash(archiveBytes), files: files.map(file => ({ path: file.path, role: file.role, sha256: hash(file.bytes) })), targetRoot: join(resourcesRoot, 'installed-target'), oldRepository, newRepository, skillCount: 2, toolCount: 1, createdAt, initialDatabaseSha256: await digest(dbPath) };
  fixture.initial = persisted(fixture);
  await writeFile(join(root, 'fixture-owner.json'), json({ format: DRIVER_FORMAT, sourceRelationsFormat: FORMAT, syntheticOnly: true }));
  await writeFile(join(resourcesRoot, 'fixture-owner.json'), json({ format: FORMAT, syntheticOnly: true, dataRoot: root }));
  await writeFile(join(root, 'dataset.json'), json(fixture)); return fixture;
}
async function verifyFiles(fixture, installed = false) {
  for (const file of fixture.sourceFiles) { assert.ok(inside(file.path, fixture.resourcesRoot) && same(await realpath(file.path), file.path)); assert.equal(await digest(file.path), file.sha256); }
  if (installed) for (const file of fixture.files) { const path = join(fixture.targetRoot, file.path); assert.ok(same(await realpath(path), path)); assert.equal(await digest(path), file.sha256, `An installed original file changed: ${file.path}`); }
}
async function readFixture(path) {
  const descriptor = resolve(path); assert.ok(inside(descriptor, dataParent) && basename(descriptor) === 'dataset.json');
  const fixture = JSON.parse(await readFile(descriptor, 'utf8')); assert.equal(fixture.format, FORMAT); assert.equal(fixture.driverFormat, DRIVER_FORMAT); assert.equal(fixture.syntheticOnly, true);
  assert.ok(same(dirname(descriptor), fixture.root) && inside(fixture.root, dataParent) && inside(fixture.resourcesRoot, resourceParent));
  for (const [key, value] of Object.entries({ dataDir: join(fixture.root, 'data'), dbPath: join(fixture.root, 'data', 'manager.sqlite3'), targetRoot: join(fixture.resourcesRoot, 'installed-target'), archivePath: join(fixture.resourcesRoot, 'original-generated-fixture.zip') })) assert.ok(same(fixture[key], value));
  for (const directory of [fixture.root, fixture.resourcesRoot, fixture.dataDir, fixture.consumer.rootPath]) assert.ok(same(await realpath(directory), directory));
  assert.equal(repository(fixture.oldRepository), fixture.oldRepository); assert.equal(repository(fixture.newRepository), fixture.newRepository); assert.notEqual(fixture.oldRepository.toLowerCase(), fixture.newRepository.toLowerCase());
  const owner = JSON.parse(await readFile(join(fixture.root, 'fixture-owner.json'), 'utf8')); assert.equal(owner.format, DRIVER_FORMAT); assert.equal(owner.sourceRelationsFormat, FORMAT); assert.equal(owner.syntheticOnly, true);
  const resourceOwner = JSON.parse(await readFile(join(fixture.resourcesRoot, 'fixture-owner.json'), 'utf8')); assert.equal(resourceOwner.format, FORMAT); assert.equal(resourceOwner.syntheticOnly, true); assert.ok(same(resourceOwner.dataRoot, fixture.root));
  assert.equal(fixture.skillCount, 2); assert.equal(fixture.toolCount, 1); assert.equal(await digest(fixture.dbPath), fixture.initialDatabaseSha256, 'A partially run fixture is not replayed.');
  assert.deepEqual(persisted(fixture), fixture.initial); await absent(fixture.targetRoot); await verifyFiles(fixture); return fixture;
}
async function candidate() {
  assert.equal(typeof args.candidate, 'string'); assert.equal(typeof args['candidate-build-info'], 'string');
  const path = resolve(args.candidate), buildInfoPath = resolve(args['candidate-build-info']); assert.equal(basename(path).toLowerCase(), 'agent-resource-manager.exe');
  const bytes = await readFile(path), offset = bytes.readUInt32LE(0x3c); assert.equal(bytes.readUInt16LE(0), 0x5a4d); assert.equal(bytes.readUInt32LE(offset), 0x4550); assert.equal(bytes.readUInt16LE(offset + 4), 0x8664);
  const sha256 = hash(bytes), info = JSON.parse(await readFile(buildInfoPath, 'utf8')); assert.equal(info.buildMode, 'release'); assert.equal((info.executableSha256 || info.sha256)?.toLowerCase(), sha256); assert.ok(info.sourceIdentity || info.sourceCommit);
  return { path, sha256, buildInfoPath, buildInfoSha256: await digest(buildInfoPath), sourceIdentity: info.sourceIdentity || info.sourceCommit };
}
async function wait(read, accepts, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) { const value = await read(); if (accepts(value)) return value; assert.ok(Date.now() < deadline, `Native source/relations observation unavailable: ${description}. No action was replayed.`); await sleep(50); }
}
async function control(app, name, type = 'ControlType.Button', scope) {
  const rows = list(await app.call('state', { name, ...(scope ? { scope } : {}) })).filter(row => row.type === type);
  assert.ok(rows.length <= 1, `Ambiguous native source/relations control: ${name}.`); return rows[0];
}
async function invoke(app, name, scope) {
  report.lastStep = name; await writeFile(reportPath, json(report));
  await wait(() => control(app, name, 'ControlType.Button', scope), value => value?.enabled, name); return app.call('invokeName', { name, ...(scope ? { scope } : {}) });
}
async function fieldName(app, prefix, type = 'ControlType.Edit') {
  const observed = await wait(() => app.call('fields'), value => list(value).some(row => row.type === type && row.enabled && row.name.startsWith(prefix)), prefix);
  const matches = list(observed).filter(row => row.type === type && row.enabled && row.name.startsWith(prefix)); assert.equal(matches.length, 1, `The exact field must be unique: ${prefix}`); return matches[0].name;
}
async function fill(app, prefix, value) { return app.call('setField', { name: await fieldName(app, prefix), value }); }
async function select(app, prefix, option) { const value = await app.call('selectCombo', { name: await fieldName(app, prefix, 'ControlType.ComboBox'), option, foreground: foregroundSelection }); report.functionalSelections.push({ control: prefix, ...value }); return value; }
async function taskAfter(app, old, action, expectedError) {
  const observed = await wait(() => app.call('tasks'), value => value.tasks.some(item => !old.has(item.id) && item.action === action), action);
  const matches = observed.tasks.filter(item => !old.has(item.id) && item.action === action); assert.equal(matches.length, 1);
  const done = (await wait(() => app.call('task', { taskId: matches[0].id }), value => value.task && !['queued', 'running'].includes(value.task.status), `${action} completion`, 120000)).task;
  report.actions.push({ id: done.id, action: done.action, status: done.status, error: done.error || null });
  if (expectedError) { assert.equal(done.status, 'failed'); assert.match(done.error || '', expectedError); return done; }
  assert.equal(done.status, 'succeeded', done.error || `Native ${action} failed.`); return done.result;
}
async function task(app, button, action, expectedError, scope) {
  const old = new Set((await app.call('tasks')).tasks.map(item => item.id)); await invoke(app, button, scope); return taskAfter(app, old, action, expectedError);
}
function record(fixture, id) { const found = persisted(fixture).resources.find(item => item.id === id); assert.ok(found, 'The generated resource disappeared.'); return found; }
async function openTool(app, name) {
  if (await control(app, '关闭工具详情')) await invoke(app, '关闭工具详情');
  await fill(app, '搜索工具', name); await invoke(app, name);
}
async function install(app, fixture) {
  await invoke(app, '工具', '主要导航'); await invoke(app, '安装发行包'); await fill(app, '发行包', fixture.archivePath);
  const inventory = await task(app, '读取清单', 'resource_package_inspect'); assert.equal(inventory.files.length, fixture.files.length);
  for (const file of fixture.files.filter(item => item.role !== 'license')) await app.call('toggle', { name: await fieldName(app, file.path, 'ControlType.CheckBox'), checked: true });
  await select(app, 'settings.json用途', '配置文件');
  await fill(app, '名称', targetName); await fill(app, '固定版本', 'generated-v1'); await fill(app, '原 GitHub 仓库', fixture.oldRepository); await fill(app, '新版本保存目录', fixture.targetRoot);
  const preview = await task(app, '预览安装', 'preview_resource_install'); assert.equal(preview.canApply, true); assert.ok(same(preview.targetPath, fixture.targetRoot));
  assert.equal(preview.source.repository, fixture.oldRepository); assert.equal(preview.source.verification, 'userProvided');
  for (const file of fixture.files) assert.ok(preview.files.some(item => item.path === file.path && item.role === file.role));
  const installed = await task(app, '确认安装这些文件', 'apply_resource_install'); assert.equal(installed.complete, true);
  const target = record(fixture, installed.resource.id); assert.ok(same(target.rootPath, fixture.targetRoot)); assert.equal(target.ownership, 'managedFiles'); assert.equal(target.version, 'generated-v1');
  assert.equal(target.installation.sourceRepository, fixture.oldRepository); assert.equal(target.installation.sourceVersion, 'generated-v1'); assert.equal(target.installation.archiveSha256, fixture.archiveSha256); assert.equal(target.installation.files.length, fixture.files.length);
  assert.deepEqual(target.actions, []); assert.equal(target.updatePolicy.mode, 'manual'); await verifyFiles(fixture, true);
  return target;
}
async function sourceFlow(app, fixture, installed) {
  const id = installed.id; await fill(app, '搜索工具', targetName);
  const initial = await task(app, '来源与健康', 'resource_source'); assert.equal(initial.id, id); assert.equal(initial.repository, fixture.oldRepository); assert.equal(initial.binding, null);
  assert.equal(initial.installationSource.repository, fixture.oldRepository); assert.equal(initial.installationSource.archiveSha256, fixture.archiveSha256);
  const healthy = await task(app, '检查来源健康', 'resource_source_health');
  assert.equal(healthy.id, id); assert.equal(healthy.health.status, 'reachable', `Live original repository check did not pass: ${healthy.health.message}`); assert.ok(Date.parse(healthy.health.checkedAt));
  await fill(app, '新的 GitHub 来源', fixture.newRepository);
  const obsolete = await task(app, '预览来源关联', 'preview_resource_source');
  assert.equal(obsolete.canApply, true); assert.equal(obsolete.previous.repository, fixture.oldRepository); assert.equal(obsolete.next.repository, fixture.newRepository); assert.equal(obsolete.next.asset, null); assert.ok(obsolete.next.repositoryId > 0);
  // A real catalogue edit changes the resource revision while the old preview
  // exists. The source component must discard that preview before confirmation.
  await invoke(app, '编辑'); await fill(app, '用途备注', note);
  const edited = await task(app, '保存', 'resource_update', null, '编辑工具信息'); assert.equal(edited.resource.id, id); assert.equal(edited.resource.notes, note);
  assert.ok(edited.resource.revision > obsolete.resourceRevision);
  await wait(() => control(app, '确认保存来源关联'), value => !value, 'source preview discarded after metadata revision');
  assert.equal((await app.call('tasks')).tasks.filter(item => item.action === 'apply_resource_source').length, 0);
  const before = record(fixture, id); assert.equal(before.repository, fixture.oldRepository); assert.deepEqual(before.installation, installed.installation);
  await wait(() => control(app, '预览来源关联'), value => value?.enabled, 'source read after the real metadata edit');
  await fill(app, '新的 GitHub 来源', fixture.newRepository);
  const current = await task(app, '预览来源关联', 'preview_resource_source'); assert.notEqual(current.previewId, obsolete.previewId); assert.equal(current.resourceRevision, before.revision);
  assert.equal(current.previous.id, id); assert.equal(current.previous.repository, fixture.oldRepository); assert.equal(current.next.repository, fixture.newRepository); assert.equal(current.mappingStatus, 'repositoryOnly'); assert.equal(current.canApply, true);
  const applied = await task(app, '确认保存来源关联', 'apply_resource_source'); assert.equal(applied.id, id); assert.equal(applied.repository, fixture.newRepository); assert.equal(applied.binding.repositoryId, current.next.repositoryId);
  const after = record(fixture, id); assert.equal(after.id, installed.id); assert.equal(after.rootPath, before.rootPath); assert.equal(after.notes, note); assert.equal(after.version, before.version); assert.equal(after.ownership, before.ownership); assert.equal(after.enabled, before.enabled);
  assert.deepEqual(after.installation, before.installation); assert.deepEqual(after.actions, before.actions); assert.deepEqual(after.updatePolicy, before.updatePolicy);
  assert.equal(after.sourceHistory.length, 1); assert.equal(after.sourceHistory[0].repository, fixture.oldRepository); assert.equal(after.sourceHistory[0].binding, null); assert.deepEqual(after.sourceHistory[0].capabilities, before.capabilities);
  for (const previous of before.capabilities) {
    const current = after.capabilities.find(item => item.id === previous.id); assert.ok(current);
    if (['registration', 'installation'].includes(previous.id)) assert.deepEqual(current, previous);
    else { assert.equal(current.status, 'needs_reverification'); assert.match(current.reason, /重新核验/); }
  }
  assert.equal(after.sourceBinding.asset, null); assert.equal(after.sourceBinding.repository, fixture.newRepository); assert.equal(after.updatePolicy.mode, 'manual'); assert.deepEqual(persisted(fixture).grants, []); assert.deepEqual(persisted(fixture).downloads, []);
  await wait(() => control(app, '检查来源健康'), value => value?.enabled, 'source reread after rebind');
  const nextHealth = await task(app, '检查来源健康', 'resource_source_health'); assert.equal(nextHealth.repository, fixture.newRepository); assert.equal(nextHealth.health.status, 'reachable', nextHealth.health.message);
  await verifyFiles(fixture, true);
  return { resourceId: id, originalSource: fixture.oldRepository, currentSource: fixture.newRepository, liveRepositoryId: current.next.repositoryId, obsoletePreviewDiscarded: true, originalInstallationPreserved: true, noteAndManualPolicyPreserved: true, noDownloadExecutionOrGrant: true, bindingScope: 'repositoryOnly', record: after };
}
async function relations(app, fixture, target) {
  await openTool(app, consumerName);
  const consumer = await task(app, '依赖关系', 'resource_relations'); assert.deepEqual(consumer.endpoint, { kind: 'tool', id: fixture.consumer.id, name: consumerName, exists: true, ownership: 'external', shared: false });
  assert.deepEqual(consumer.dependencies, []); assert.deepEqual(consumer.dependents, []);
  await select(app, '选择依赖资源', `工具 · ${targetName}`);
  const added = await task(app, '添加关系', 'resource_relation_add'); assert.equal(added.endpoint.id, fixture.consumer.id); assert.equal(added.dependencies.length, 1);
  const incoming = added.dependencies[0]; assert.equal(incoming.dependency.id, target.id); assert.equal(incoming.dependency.kind, 'tool'); assert.equal(incoming.dependency.ownership, 'managed'); assert.equal(incoming.dependent.id, fixture.consumer.id);
  assert.equal(persisted(fixture).relations.length, 1);
  await openTool(app, targetName);
  const targetRelations = await task(app, '依赖关系', 'resource_relations'); assert.equal(targetRelations.endpoint.id, target.id); assert.equal(targetRelations.dependents.length, 1); assert.equal(targetRelations.dependents[0].id, incoming.id);
  await invoke(app, '卸载或停用'); await select(app, '本次卸载程度', '卸载运行部分，保留个人资料');
  const blocked = await task(app, '预览本次影响', 'preview_resource_remove'); assert.equal(blocked.canApply, false); assert.equal(blocked.dependents.length, 1); assert.equal(blocked.dependents[0].dependent.id, fixture.consumer.id); assert.equal(blocked.relationsRevision, targetRelations.revision);
  assert.ok(blocked.warnings.some(value => value.includes(consumerName))); assert.ok(blocked.entries.some(value => value.relative === 'runtime.txt' && value.remove));
  await wait(() => control(app, '确认按此清单处理'), value => value && !value.enabled, 'known dependent disables removal confirmation'); await verifyFiles(fixture, true);
  const removed = await task(app, `移除来自${consumerName}的管理关系`, 'resource_relation_remove'); assert.equal(removed.endpoint.id, fixture.consumer.id); assert.deepEqual(removed.dependencies, []);
  assert.deepEqual(persisted(fixture).relations, []);
  // Incoming-edge removal rereads the same target instead of navigating to its
  // consumer. A new preview is required before the previously blocked action.
  await wait(() => control(app, '预览本次影响'), value => value?.enabled, 'removal preview after incoming-edge removal');
  assert.equal((await control(app, '确认按此清单处理')).enabled, false);
  const clean = await task(app, '预览本次影响', 'preview_resource_remove'); assert.equal(clean.canApply, true); assert.deepEqual(clean.dependents, []); assert.notEqual(clean.id, blocked.id);
  await select(app, '选择依赖资源', `工具 · ${consumerName}`);
  const outgoing = await task(app, '添加关系', 'resource_relation_add'); assert.equal(outgoing.endpoint.id, target.id); assert.equal(outgoing.dependencies.length, 1); assert.ok(outgoing.revision > clean.relationsRevision);
  // The metadata-only relation changed after the real removal confirmation was
  // prepared. This actual UI submission must reach and fail the live guard.
  const rejected = await task(app, '确认按此清单处理', 'apply_resource_remove', /依赖关系已变化/); await verifyFiles(fixture, true); assert.deepEqual(record(fixture, target.id), target);
  await wait(() => control(app, '确认按此清单处理'), value => !value, 'failed one-use removal preview discarded');
  await task(app, `移除对${consumerName}的依赖关系`, 'resource_relation_remove'); assert.deepEqual(persisted(fixture).relations, []);
  const final = await task(app, '预览本次影响', 'preview_resource_remove'); assert.equal(final.canApply, true); assert.deepEqual(final.dependents, []); assert.notEqual(final.id, clean.id); assert.ok(final.relationsRevision > clean.relationsRevision);
  await invoke(app, '关闭卸载'); await verifyFiles(fixture, true);
  return { targetId: target.id, consumerId: fixture.consumer.id, realAddAndIncomingRemove: true, knownUserBlockedRemoval: true, requiredFreshPreviewAfterRelationRemoval: true, staleApplyTaskId: rejected.id, staleApplyRejectedBeforeWriting: true, noSuccessfulRemoval: true, finalRelationsEmpty: true };
}

if (phase === 'prepare') {
  const fixture = await prepare(); console.log(JSON.stringify({ status: 'prepared-not-run', fixture: join(fixture.root, 'dataset.json'), noNativeLaunch: true, noNetwork: true, noExecutable: true })); process.exit(0);
}
assert.equal(typeof args.prepared, 'string');
const fixture = await readFixture(args.prepared), info = await candidate(), reportPath = join(fixture.root, 'source-relations-result.json');
let app;
const report = { format: FORMAT, status: 'running', startedAt: new Date().toISOString(), candidate: info, fixture: resolve(args.prepared), syntheticOnly: true, limitations, actions: [], results: {}, functionalSelections: [], foregroundSelectionRequested: foregroundSelection, inputMethod: 'native-accessibility-patterns' };
try {
  report.harness = await Promise.all(['verify-native-source-relations.mjs', 'native-uia-client.mjs', 'verify-native-uia.ps1', 'performance-load-fixture.mjs'].map(async name => ({ name, sha256: await digest(fileURLToPath(new URL(name, import.meta.url))) })));
  await writeFile(reportPath, json(report), { flag: 'wx' });
  app = await NativeUiaSession.launch({ executable: info.path, dataDir: fixture.dataDir, reportPath: join(fixture.root, 'native-driver.json'), sha256: info.sha256, accessibilityInput: true }); report.native = app.identity;
  assert.equal(app.identity.executableSha256, info.sha256); assert.ok(same(app.identity.dataDirectory, fixture.dataDir));
  const installed = await install(app, fixture); report.results.realInstallation = { resourceId: installed.id, originalReceiptFromUi: true, generatedArchiveOnly: true };
  report.results.source = await sourceFlow(app, fixture, installed); await writeFile(reportPath, json(report));
  report.results.relations = await relations(app, fixture, report.results.source.record); await writeFile(reportPath, json(report));
  await app.call('screenshot', { path: join(fixture.root, 'native-source-relations.png') });
  const allowed = ['management_data', 'resource_list', 'resource_runtime', 'resource_package_inspect', 'preview_resource_install', 'apply_resource_install', 'resource_update', 'resource_source', 'resource_source_health', 'preview_resource_source', 'apply_resource_source', 'resource_relations', 'resource_relation_add', 'resource_relation_remove', 'preview_resource_remove', 'apply_resource_remove'];
  for (const item of (await app.call('tasks')).tasks) {
    assert.ok(allowed.includes(item.action), `An unrelated native action was observed: ${item.action}`);
    const done = (await wait(() => app.call('task', { taskId: item.id }), value => value.task && !['queued', 'running'].includes(value.task.status), `${item.action} completion`)).task;
    if (item.id === report.results.relations.staleApplyTaskId) { assert.equal(done.status, 'failed'); assert.match(done.error || '', /依赖关系已变化/); }
    else assert.equal(done.status, 'succeeded', done.error || `Native ${item.action} failed.`);
    if (done.action === 'resource_runtime') assert.deepEqual(done.result.runs, []);
  }
  assert.equal(report.actions.filter(item => item.action === 'apply_resource_source').length, 1); assert.equal(report.actions.filter(item => item.action === 'apply_resource_remove').length, 1);
  report.normalExit = (await app.quit()).driverReport.closedNormally; app = null; assert.equal(report.normalExit, true);
  const after = persisted(fixture); assert.deepEqual(after.resources.find(item => item.id === fixture.consumer.id), fixture.consumer); assert.deepEqual(after.resources.find(item => item.id === installed.id), report.results.source.record);
  assert.deepEqual(after.relations, []); assert.deepEqual(after.grants, []); assert.deepEqual(after.downloads, []); assert.equal(after.state.checkMode, 'manual'); assert.equal(after.state.skills.length, fixture.skills.length);
  for (const original of fixture.skills) { const current = after.state.skills.find(item => item.id === original.id); for (const [key, value] of Object.entries(original)) assert.deepEqual(current[key], value); }
  await verifyFiles(fixture, true); report.status = 'passed';
} catch (error) {
  report.status = 'failed-or-blocked'; report.failure = { name: error.name, message: String(error.message).slice(0, 1800) };
  if (app && !app.exited) { try { await app.call('screenshot', { path: join(fixture.root, 'failure.png') }); } catch (cause) { report.failureScreenshotError = String(cause); } }
} finally {
  if (app) { try { report.normalExit = (await app.quit()).driverReport.closedNormally; } catch (cause) { report.normalExit = false; report.exitError = String(cause); } }
  report.finishedAt = new Date().toISOString(); await writeFile(reportPath, json(report));
}
console.log(JSON.stringify({ status: report.status, reportPath, results: report.results, normalExit: report.normalExit, failure: report.failure }));
if (report.status !== 'passed') process.exitCode = 1;
