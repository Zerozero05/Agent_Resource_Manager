import { mkdir, writeFile, readFile, access, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';

const approved = 'D:\\03_github_projects\\Agent_Resource_Manager\\validation\\manager-data';
export const MIGRATION_FIXTURE_FORMAT = 'agent-resource-manager-native-migration-v1';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function within(path, parent) { const rel = relative(resolve(parent), resolve(path)); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); }
async function owned(root) {
  root = await realpath(root);
  if (!within(root, approved)) throw new Error('Native migration fixtures must stay in the approved isolated validation directory.');
  const owner = JSON.parse(await readFile(join(root, 'fixture-owner.json'), 'utf8'));
  if (owner.format !== MIGRATION_FIXTURE_FORMAT || owner.syntheticOnly !== true) throw new Error('A fresh synthetic migration fixture marker is required.');
  const descriptor = JSON.parse(await readFile(join(root, 'dataset.json'), 'utf8'));
  if (resolve(descriptor.root).toLowerCase() !== resolve(root).toLowerCase() || resolve(descriptor.dataDir).toLowerCase() !== resolve(join(root, 'data')).toLowerCase()) throw new Error('Synthetic migration fixture ownership does not match its exact data directory.');
  return descriptor;
}

// Creates original synthetic inputs only. The old executable must create its
// SQLite schema natively; this helper never manufactures an old-version DB.
export async function createMigrationInputs(name) {
  if (!/^[a-z0-9-]{1,64}$/.test(name)) throw new Error('Use a simple unique migration fixture name.');
  const root = join(approved, name); await mkdir(root);
  const dataDir = join(root, 'data'), skillsRoot = join(root, 'skills');
  await mkdir(dataDir); await mkdir(skillsRoot);
  await writeFile(join(root, 'fixture-owner.json'), JSON.stringify({ format: MIGRATION_FIXTURE_FORMAT, syntheticOnly: true, createdAt: new Date().toISOString() }, null, 2));
  const files = [], skills = [];
  for (let index = 0; index < 2; index++) {
    const name = ['migration-skill-one', 'migration-skill-two'][index], directory = join(skillsRoot, name);
    await mkdir(directory); await mkdir(join(directory, 'references'));
    const content = { 'SKILL.md': `---\nname: ${name}\ndescription: Synthetic native migration fixture.\nmetadata:\n  version: "1.2.${index + 3}"\n---\n\n# Perf Skill ${String(index).padStart(4, '0')}\n\nOnly generated migration test material. See [runtime](references/runtime.txt).\n`, 'references/runtime.txt': `Synthetic runtime reference ${index}; contains no code, credentials or user documents.\n`, 'LICENSE': 'Synthetic migration fixture content, created for local validation.\n', 'README.md': `# Migration optional explanation ${index}\n` };
    const localHashes = {};
    for (const [path, text] of Object.entries(content)) { await writeFile(join(directory, path), text); localHashes[path] = hash(text); files.push({ path: join(directory, path), sha256: hash(text) }); }
    skills.push({ id: `migration-stable-id-${index}`, name, displayName: `Perf Skill ${String(index).padStart(4, '0')}`, description: `Original generated description ${index}.`, localPath: directory, version: `1.2.${index + 3}`, status: index ? 'local_only' : 'synced', categoryId: `migration-category-${index}`, favorite: index === 0, runtimeFiles: ['LICENSE', 'SKILL.md', 'references/runtime.txt'], runtimeConfirmed: true, localHashes, baseHashes: localHashes, readOnly: false, ...(index ? {} : { sourceId: 'migration-source-one', remotePath: 'skills/migration-skill-one', repo: 'synthetic/migration-fixture', branch: 'main', installedCommit: 'a'.repeat(40), commit: 'a'.repeat(40) }) });
  }
  const ignored = join(skillsRoot, 'migration-ignored'); await mkdir(ignored); await writeFile(join(ignored, 'SKILL.md'), '---\nname: migration-ignored\ndescription: Generated ignored Skill.\n---\n');
  const desired = {
    skills,
    sources: [{ id: 'migration-source-one', kind: 'github', repo: 'synthetic/migration-fixture', branch: 'main', commit: 'a'.repeat(40), private: false, ignoredPaths: ['skills/remote-ignored'], roots: ['skills'] }],
    // This is an isolated direct entry, not a real Codex/Claude/Cursor directory.
    connections: [{ id: 'migration-client-entry', skillId: skills[0].id, client: 'codex', path: skills[0].localPath, target: skills[0].localPath, origin: 'existing', kind: 'direct', linked: true, verified: false, discovered: true }],
    localRoots: [{ id: 'migration-root-one', name: '迁移验证目录', path: skillsRoot, resolvedPath: skillsRoot, enabled: false }],
    ignoredLocalPaths: [ignored], checkMode: 'manual', checkGeneration: 1, checkSummary: null,
    settings: { uiTheme: 'dark', uiAccent: 'violet', uiDensity: 'comfortable', uiMotion: 'light', uiZoom: 115, uiFontSize: 18, sidebarWidth: 224, sidebarCollapsed: false, libraryMode: 'list', libraryPageSize: 20, librarySort: 'name', editorPath: '', checkIntervalMinutes: 30, categories: [{ id: 'migration-category-0', name: '迁移分类甲', color: 'blue' }, { id: 'migration-category-1', name: '迁移分类乙', color: 'rose' }] },
  };
  const descriptor = { format: MIGRATION_FIXTURE_FORMAT, syntheticOnly: true, root, dataDir, dbPath: join(dataDir, 'manager.sqlite3'), skillCount: 0, desiredSkillCount: 2, toolCount: 0, skillsRoot, files, phases: ['native-old-empty-initialize', 'offline-synthetic-seed', 'native-old-round-trip', 'native-candidate-upgrade', 'field-and-original-file-comparison'] };
  await writeFile(join(root, 'desired-state.json'), JSON.stringify(desired, null, 2));
  await writeFile(join(root, 'dataset.json'), JSON.stringify(descriptor, null, 2));
  return descriptor;
}

// Requires the old binary's real driver report and natively created empty DB.
// The app is closed before enriching this wholly generated fixture offline.
export async function seedNativeLegacyDatabase(root, initializationReportPath) {
  const descriptor = await owned(root), run = JSON.parse(await readFile(initializationReportPath, 'utf8'));
  if (run.closedNormally !== true || !['startup-observed', 'measurements-collected'].includes(run.status) || !/^0\.2\.11(?:\D|$)/.test(run.productVersion || '') || resolve(run.dataDirectory).toLowerCase() !== resolve(descriptor.dataDir).toLowerCase() || !/skill-manager\.exe$/i.test(run.executable)) throw new Error('A successful real v0.2.11 native initialize/normal-exit report is required before synthetic seeding.');
  try { process.kill(run.pid, 0); throw new Error('The old native process identity is still alive or was reused; no offline synthetic state edit was made.'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  await access(descriptor.dbPath);
  const db = new DatabaseSync(descriptor.dbPath);
  try {
    const row = db.prepare('SELECT schema_version,payload FROM app_state WHERE id=1').get();
    // The real old app can create its schema and close without ever saving a
    // state row. Inserting generated inputs there does not fabricate a schema;
    // the next old-native round trip must still prove it can read these inputs.
    const prior = row ? JSON.parse(row.payload) : { skills: [], sources: [], connections: [], settings: {} };
    if ((row && row.schema_version !== 1) || (!row && db.prepare('SELECT count(*) AS count FROM app_state').get().count !== 0) || prior.skills.length || prior.sources.length || prior.connections.length) throw new Error('Only the old app-created, empty synthetic schema may be seeded.');
    const desired = JSON.parse(await readFile(join(root, 'desired-state.json'), 'utf8'));
    for (const skill of desired.skills) if (!within(skill.localPath, descriptor.root)) throw new Error('A synthetic source escaped its owned fixture.');
    const next = { ...prior, ...desired, settings: { ...prior.settings, ...desired.settings } };
    db.exec('BEGIN IMMEDIATE');
    if (row) db.prepare('UPDATE app_state SET payload=? WHERE id=1').run(JSON.stringify(next));
    else db.prepare('INSERT INTO app_state(id,schema_version,payload) VALUES(1,1,?)').run(JSON.stringify(next));
    db.exec('COMMIT');
    descriptor.skillCount = descriptor.desiredSkillCount; await writeFile(join(root, 'dataset.json'), JSON.stringify(descriptor, null, 2));
    await writeFile(join(root, 'legacy-seed-provenance.json'), JSON.stringify({ syntheticOnly: true, method: 'old binary created empty schema, then offline original synthetic inputs saved for an old-native round trip', oldInitializeReport: resolve(initializationReportPath), oldExecutableSha256: run.executableSha256, nativeStateRowPreviouslyPresent: !!row, schemaVersion: row?.schema_version ?? 1, createdAt: new Date().toISOString() }, null, 2));
  } finally { db.close(); }
  return descriptor;
}

const skillKeys = ['id', 'name', 'displayName', 'description', 'localPath', 'sourceId', 'remotePath', 'repo', 'branch', 'version', 'categoryId', 'favorite', 'runtimeFiles', 'runtimeConfirmed', 'installedCommit'];
const settingsKeys = ['uiTheme', 'uiAccent', 'uiDensity', 'uiMotion', 'uiZoom', 'uiFontSize', 'sidebarWidth', 'sidebarCollapsed', 'libraryMode', 'libraryPageSize', 'librarySort', 'editorPath', 'categories'];
const project = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const ordered = (items, keys) => items.map(value => project(value, keys)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
export async function readMigrationState(root) {
  const descriptor = await owned(root), db = new DatabaseSync(descriptor.dbPath, { readOnly: true });
  let state; try { state = JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload); } finally { db.close(); }
  const originals = await Promise.all(descriptor.files.map(async file => ({ path: file.path, sha256: hash(await readFile(file.path)) })));
  return { skills: ordered(state.skills, skillKeys), sources: ordered(state.sources, ['id', 'kind', 'repo', 'branch', 'commit', 'private', 'ignoredPaths', 'roots']), connections: ordered(state.connections, ['id', 'skillId', 'client', 'path', 'target', 'origin', 'kind']), localRoots: ordered(state.localRoots || [], ['id', 'name', 'path', 'resolvedPath', 'enabled']), ignoredLocalPaths: [...(state.ignoredLocalPaths || [])].sort(), checkMode: state.checkMode, settings: project(state.settings, settingsKeys), originalFiles: originals };
}
export function compareMigrationState(oldNativeState, newNativeState) {
  const fields = ['skills', 'sources', 'connections', 'localRoots', 'ignoredLocalPaths', 'checkMode', 'settings', 'originalFiles'];
  const differences = fields.filter(field => JSON.stringify(oldNativeState[field]) !== JSON.stringify(newNativeState[field])).map(field => ({ field, before: oldNativeState[field], after: newNativeState[field] }));
  return { passed: differences.length === 0, verifiedFields: fields, differences };
}

const recoveryTables = ['resource_catalog', 'resource_catalog_meta', 'skill_annotations', 'management_data_meta', 'invocation_templates', 'invocation_templates_meta', 'resource_scenes', 'resource_scenes_meta', 'resource_relations', 'resource_relations_meta', 'workspace_state', 'task_history'];
export const recoveryLimitations = [
  'Synthetic nonempty representative rows only. No production database, credentials, physical migration or formal downgrade approval.',
  'saved_views, download_records, resource_version_checks and resource_automation_grants/attempts are not seeded in this variant.',
  'One native window is used. Cross-window final flush is not exercised.',
  'Workspace revision and native geometry may change. The home view identity and full non-home navigation metadata are compared; no runtime draft or secret is seeded.',
  'Only pane.state may gain previously absent derived UI keys. Every seeded state key and its complete value, including arrays and nested objects, remains an exact comparison input; other pane metadata stays strict.',
  'The app_state stateRevision is checked separately as a nondecreasing save counter. All other app_state fields remain exact comparison inputs.',
  'Only management_data and the four explicit read-only MCP observations may create additional task rows. Seeded unfinished writes must never run.',
];
function recoveryRows(db, table) {
  assert.ok(recoveryTables.includes(table));
  return db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, ['payload', 'members'].includes(key) && typeof value === 'string' ? JSON.parse(value) : value])));
}
export async function readRecoveryMigrationState(root) {
  const descriptor = await owned(root);
  assert.equal(descriptor.variant, 'recovery-downgrade');
  const seed = JSON.parse(await readFile(join(root, 'recovery-seed.json'), 'utf8'));
  const db = new DatabaseSync(descriptor.dbPath, { readOnly: true });
  try {
    assert.deepEqual(db.prepare('PRAGMA quick_check').all().map(row => Object.values(row)[0]), ['ok']);
    const tables = Object.fromEntries(recoveryTables.map(table => [table, recoveryRows(db, table)]));
    const appState = JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload);
    const files = await Promise.all(seed.files.map(async file => ({ path: file.path, sha256: hash(await readFile(file.path)) })));
    return { appState, tables, files };
  } finally { db.close(); }
}
export async function seedRecoveryDowngradeDatabase(root) {
  const descriptor = await owned(root);
  assert.equal(descriptor.variant, 'recovery-downgrade');
  const run = JSON.parse(await readFile(join(root, 'candidate-driver.json'), 'utf8'));
  assert.equal(run.closedNormally, true); assert.ok(resolve(run.dataDirectory).toLowerCase() === resolve(descriptor.dataDir).toLowerCase());
  assert.match(run.productVersion, /^0\.3\.0-dev\.1/);
  try { process.kill(run.pid, 0); throw new Error('The bootstrap native process remains alive or its PID was reused.'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  const comparison = JSON.parse(await readFile(join(root, 'native-migration-comparison.json'), 'utf8'));
  assert.equal(comparison.passed, true);
  await assert.rejects(access(join(root, 'recovery-seed.json')), error => error.code === 'ENOENT');
  const toolRoot = join(root, 'inert-tool'); await mkdir(toolRoot);
  const toolFile = join(toolRoot, 'README.md'), toolText = '# Synthetic recovery tool\n\nNo executable, registered action or network behavior.\n';
  await writeFile(toolFile, toolText, { flag: 'wx' });
  const createdAt = new Date().toISOString(), skillId = 'migration-stable-id-0';
  const tool = { id: 'migration-inert-tool', name: 'Migration Inert Tool', kind: 'cli', rootPath: toolRoot, repository: null, sourceBinding: null, version: '1.0.0', alias: '', notes: 'Original generated recovery metadata.', enabled: false, ownership: 'external', managementScope: 'register', actions: [], capabilities: [], updatePolicy: { mode: 'manual', intervalHours: 24, pinnedVersion: null, skippedVersions: [] }, installation: null, revision: 1, createdAt, updatedAt: createdAt };
  const annotation = { skillId, revision: 2, alias: 'Recovery Alias', notes: 'Original generated annotation, including 中文。' };
  const template = { id: 'migration-template', name: 'Recovery Template', resourceId: tool.id, actionId: 'unregistered-inert-action', parameters: { query: 'Original generated parameter' }, revision: 1, binding: '' };
  const scene = { id: 'migration-scene', name: 'Recovery Scene', members: [{ kind: 'skill', id: skillId }, { kind: 'tool', id: tool.id }] };
  const relation = { id: 'migration-relation', dependent: { kind: 'skill', id: skillId }, dependency: { kind: 'tool', id: tool.id } };
  const tasks = ['queued', 'running'].map((status, index) => ({ id: `migration-unfinished-${status}`, action: index ? 'apply_update' : 'apply_push', label: `Synthetic unfinished ${status}`, status, stage: 'Synthetic pre-restart stage', createdAt, ...(index ? { startedAt: createdAt } : {}), origin: { kind: 'synthetic-recovery', view: 'skills', skillId, paneId: 'home', windowLabel: 'main' }, progress: { completed: index, total: 2 }, cancellable: true, cancelRequested: false, resultAvailable: false, resultExpired: false, resources: [`skill:${skillId}`] }));
  const workspace = { revision: 7, windows: [{ label: 'main', activePaneId: 'home', panes: [{ id: 'home', kind: 'home', title: '工作台', state: { view: 'skills' } }, { id: 'migration-history', kind: 'history', title: '操作记录', state: { scrollTop: 73 } }] }] };
  const nonDefaultSettings = { uiDensity: 'compact', uiMotion: 'none', uiAccent: 'teal', maintenance: { revision: 5, pausedManually: true, pauseUntil: null, window: { startMinute: 60, endMinute: 120 } } };
  const seed = { syntheticOnly: true, variant: descriptor.variant, createdAt, candidateExecutableSha256: run.executableSha256, annotation, tool, template, scene, relation, tasks, nonDefaultSettings, files: [...descriptor.files, { path: toolFile, sha256: hash(toolText) }], limitations: recoveryLimitations };
  const db = new DatabaseSync(descriptor.dbPath);
  try {
    for (const table of recoveryTables) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), `Native bootstrap did not create ${table}.`);
    for (const table of ['resource_catalog', 'skill_annotations', 'invocation_templates', 'resource_scenes', 'resource_relations']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, 'Only the fresh isolated bootstrap may be enriched.');
    db.exec('BEGIN IMMEDIATE');
    const state = JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload);
    assert.equal(state.checkMode, 'manual'); Object.assign(state.settings, nonDefaultSettings);
    db.prepare('UPDATE app_state SET payload=? WHERE id=1').run(JSON.stringify(state));
    db.prepare('INSERT INTO resource_catalog VALUES(?,?,1,?)').run(tool.id, toolRoot.toLowerCase(), JSON.stringify(tool));
    db.prepare('INSERT INTO resource_catalog_meta VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=1').run();
    db.prepare('INSERT INTO skill_annotations VALUES(?,?,?,?)').run(skillId, annotation.revision, annotation.alias, annotation.notes);
    db.prepare('INSERT INTO management_data_meta VALUES(1,2) ON CONFLICT(id) DO UPDATE SET revision=2').run();
    db.prepare('INSERT INTO invocation_templates VALUES(?,?,?,?,?)').run(template.id, tool.id, template.actionId, template.revision, JSON.stringify(template));
    db.prepare('INSERT INTO invocation_templates_meta VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=1').run();
    db.prepare('INSERT INTO resource_scenes VALUES(?,?,?)').run(scene.id, scene.name, JSON.stringify(scene.members));
    db.prepare('INSERT INTO resource_scenes_meta VALUES(1,1,?) ON CONFLICT(id) DO UPDATE SET revision=1,active_scene_id=excluded.active_scene_id').run(scene.id);
    db.prepare('INSERT INTO resource_relations VALUES(?,?,?,?,?,?)').run(relation.id, 'skill', skillId, 'tool', tool.id, createdAt);
    db.prepare('INSERT INTO resource_relations_meta VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=1').run();
    for (const task of tasks) db.prepare('INSERT INTO task_history VALUES(?,?)').run(task.id, JSON.stringify(task));
    db.prepare('INSERT INTO workspace_state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(workspace));
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch { /* A pre-transaction failure has nothing to roll back. */ } throw error; }
  finally { db.close(); }
  await writeFile(join(root, 'recovery-seed.json'), JSON.stringify(seed, null, 2), { flag: 'wx' });
  const baseline = await readRecoveryMigrationState(root);
  await writeFile(join(root, 'recovery-baseline.json'), JSON.stringify(baseline, null, 2), { flag: 'wx' });
  return seed;
}
const stableJson = value => JSON.stringify(value, (key, item) => item && !Array.isArray(item) && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
function navigationWorkspace(rows, seededRows = []) {
  return rows.map(row => ({
    id: row.id,
    windows: row.payload.windows.map(window => ({
      label: window.label,
      activePaneId: window.activePaneId,
      ...(window.splitView ? { splitView: window.splitView } : {}),
      panes: window.panes.map(pane => {
        const seeded = seededRows.find(value => value.id === row.id)?.payload.windows.find(value => value.label === window.label)?.panes.find(value => value.id === pane.id);
        const value = structuredClone(pane);
        if (seeded?.state && value.state && typeof value.state === 'object' && !Array.isArray(value.state)) {
          value.state = Object.fromEntries(Object.keys(seeded.state)
            .filter(key => Object.hasOwn(value.state, key))
            .map(key => [key, value.state[key]]));
        }
        return value;
      }),
    })),
  }));
}
function restoredTask(task) {
  const value = structuredClone(task);
  value.cancellable = false; value.resultAvailable = false; value.resultExpired = true; delete value.result;
  return value;
}
export function compareRecoveryMigrationState(baseline, actual, seed, recovered = null, legacySave = null) {
  const differences = [], record = (field, expected, received) => { if (stableJson(expected) !== stableJson(received)) differences.push({ field, expected, actual: received }); };
  const { stateRevision: beforeRevision, ...beforeState } = baseline.appState, { stateRevision: afterRevision, ...afterState } = actual.appState;
  record('app_state.payload', beforeState, afterState); record('original-files', baseline.files, actual.files);
  // Manager::with_storage_mode explicitly treats an absent old save counter as zero.
  if (!Number.isSafeInteger(afterRevision ?? 0) || (afterRevision ?? 0) < (beforeRevision ?? 0)) differences.push({ field: 'app_state.stateRevision', expected: `An integer at least ${beforeRevision ?? 0}`, actual: afterRevision });
  for (const table of recoveryTables.filter(name => !['task_history', 'workspace_state'].includes(name))) record(table, baseline.tables[table], actual.tables[table]);
  record('workspace_state.navigation', navigationWorkspace(baseline.tables.workspace_state), navigationWorkspace(actual.tables.workspace_state, baseline.tables.workspace_state));
  const expectedRows = recovered?.tables.task_history || baseline.tables.task_history;
  for (const row of expectedRows) {
    const received = actual.tables.task_history.find(value => value.id === row.id);
    if (!received) { differences.push({ field: `task_history.${row.id}`, expected: row, actual: null }); continue; }
    const expected = restoredTask(row.payload);
    if (!recovered && seed.tasks.some(task => task.id === row.id)) {
      expected.status = 'interrupted'; expected.stage = '上次运行已中断，请检查当前状态后重新操作'; expected.error = '程序在任务完成前关闭；不会自动重放操作';
      const finished = Date.parse(received.payload.finishedAt);
      if (!Number.isFinite(finished) || finished < Date.parse(seed.createdAt) || finished > Date.now() + 1000) differences.push({ field: `task_history.${row.id}.finishedAt`, expected: 'A real post-seed recovery time', actual: received.payload.finishedAt });
      expected.finishedAt = received.payload.finishedAt;
    }
    record(`task_history.${row.id}.payload`, expected, received.payload);
  }
  const permittedReads = ['management_data', 'resource_list', 'resource_scenes', 'resource_relations', 'resource_templates'];
  for (const row of actual.tables.task_history.filter(row => !expectedRows.some(value => value.id === row.id))) {
    if (legacySave?.row.id === row.id) record(`task_history.legacy-save.${row.id}`, legacySave.restored ? restoredTask(legacySave.row.payload) : legacySave.row.payload, row.payload);
    else if (!permittedReads.includes(row.payload.action)) differences.push({ field: `task_history.new.${row.id}`, expected: permittedReads, actual: row.payload });
  }
  if (legacySave && !actual.tables.task_history.some(row => row.id === legacySave.row.id)) differences.push({ field: 'task_history.legacy-save', expected: legacySave.row, actual: null });
  return { passed: differences.length === 0, differences, comparedTables: recoveryTables, permittedAdditionalReadActions: permittedReads, limitations: recoveryLimitations };
}
