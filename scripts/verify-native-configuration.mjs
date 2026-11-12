import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { NativeUiaSession } from './native-uia-client.mjs';

const FORMAT = 'agent-resource-manager-native-configuration-v1';
const DRIVER_FORMAT = 'agent-resource-manager-native-performance-v1';
const validation = 'D:\\03_github_projects\\Agent_Resource_Manager\\validation';
const dataParent = join(validation, 'manager-data'), resourceParent = join(validation, 'resources');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, flag, index, all) => flag.startsWith('--') ? [...pairs, [flag.slice(2), all[index + 1]]] : pairs, []));
const phase = args.phase;
if (process.argv.includes('--help')) {
  console.log('Prepare: --phase prepare [--variant subset|references]. Native run: --phase run --prepared <dataset.json> --candidate <release.exe> --candidate-build-info <json>. Uses two new generated catalogues and real native Save/Open dialogs. Default subset covers preferences/category/annotation. The separate references variant adds sources/scenes/inert templates/dependencies, duplicate-edge blocking and invalid-path preview rejection. UIA dialogs are restricted to the exact owned process/window/title and generated D-drive files. No clipboard, backend mutation shortcut, download, installation or cleanup.');
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
const fileDialogHost = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const category = { id: 'native-config-category', name: 'Native Config Category', color: 'blue' };
const retainedCategory = { id: 'native-local-category', name: 'Retained Local Category', color: 'orange' };
// Synthetic aliases still exercise actual name overrides while preserving the
// shared readiness driver's explicit "Perf Skill " row-identity convention.
const incomingNote = { skill_id: 'perf-skill-0000', revision: 1, alias: 'Perf Skill 0000 Config Alias', notes: 'Generated exported note. NATIVE_CONFIGURATION_NOTE_MARKER.' };
const retainedNote = { skill_id: 'perf-skill-0001', revision: 2, alias: 'Perf Skill 0001 Local Alias', notes: 'Generated local note absent from the export; retain it.' };
const limitations = [
  'Real native transfer of selected preferences, one category and one annotation only; not all configuration item types or complete-plan acceptance.',
  'Both catalogues reference the same generated, inert Skill runtime files. No tool entity, source credential, executable action or automatic policy is imported.',
  'Native common dialogs must expose the observed Save filename edit 1001 or Open filename edit 1148 and confirm/cancel buttons 1/2, with the exact application-provided title and owner. Unsupported dialogs fail; no blind input fallback is used.',
  'Preview cancellation, Save-dialog cancellation and unselected data retention are covered. Stale preview, I/O failure and concurrency recovery remain separately tested behaviors.',
  'No clipboard read/write, network, download, installation, program invocation, deletion, backup or production data is requested.',
];

function userData(profile) {
  const db = new DatabaseSync(profile.dbPath, { readOnly: true });
  try {
    const table = name => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    const state = JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload);
    const annotations = table('skill_annotations') ? db.prepare('SELECT skill_id,revision,alias,notes FROM skill_annotations ORDER BY skill_id').all().map(row => ({ ...row })) : [];
    const payloads = name => table(name) ? db.prepare(`SELECT payload FROM ${name} ORDER BY id`).all().map(row => JSON.parse(row.payload)) : [];
    const scenes = table('resource_scenes') ? db.prepare('SELECT id,name,members FROM resource_scenes ORDER BY id').all().map(row => ({ ...row, members: JSON.parse(row.members) })) : [];
    const relations = table('resource_relations') ? db.prepare('SELECT id,dependent_kind,dependent_id,dependency_kind,dependency_id,created_at FROM resource_relations ORDER BY id').all().map(row => ({ ...row })) : [];
    const activeScene = table('resource_scenes_meta') ? db.prepare('SELECT active_scene_id FROM resource_scenes_meta WHERE id=1').get()?.active_scene_id || null : null;
    return { state, annotations, resources: payloads('resource_catalog'), templates: payloads('invocation_templates'), scenes, relations, activeScene };
  } finally { db.close(); }
}
async function prepare() {
  assert.ok(!args.prepared && !args.candidate && !args['candidate-build-info'], 'Preparation accepts no existing data or program.');
  const variant = args.variant || 'subset'; assert.ok(['subset', 'references'].includes(variant));
  await mkdir(dataParent, { recursive: true }); await mkdir(resourceParent, { recursive: true });
  const root = await mkdtemp(join(dataParent, 'native-configuration-'));
  const resourcesRoot = await mkdtemp(join(resourceParent, 'native-configuration-'));
  const exportsRoot = join(root, 'exports'); await mkdir(exportsRoot);
  const skills = [], sourceFiles = [], createdAt = new Date().toISOString();
  for (let index = 0; index < 2; index++) {
    const key = String(index).padStart(4, '0'), id = `perf-skill-${key}`, localPath = join(resourcesRoot, id); await mkdir(localPath);
    const bytes = Buffer.from(`---\nname: ${id}\ndescription: Inert native configuration fixture.\nmetadata:\n  version: "1.0.0"\n---\n\n# Perf Skill ${key}\n\nGenerated text only. NATIVE_CONFIGURATION_RUNTIME_${key}.\n`);
    const path = join(localPath, 'SKILL.md'); await writeFile(path, bytes, { flag: 'wx' }); sourceFiles.push({ path, bytes: bytes.length, sha256: hash(bytes) });
    skills.push({ id, name: id, displayName: `Perf Skill ${key}`, description: 'Generated local Skill for configuration acceptance.', localPath, status: 'local_only', version: '1.0.0', runtimeFiles: ['SKILL.md'], runtimeConfirmed: true, runtimeAudit: { status: 'verified', warnings: [], checkedAt: createdAt }, runtimeWarnings: [], runtimeIssues: [], localHashes: { 'SKILL.md': hash(bytes) }, favorite: false, categoryId: null, readOnly: false });
  }
  let references;
  if (variant === 'references') {
    const toolRoot = join(resourcesRoot, 'inert-tool'); await mkdir(toolRoot);
    const path = join(toolRoot, 'README.md'), bytes = Buffer.from('# Inert configuration reference\n\nNo executable, registered action or network behavior.\n');
    await writeFile(path, bytes, { flag: 'wx' }); sourceFiles.push({ path, bytes: bytes.length, sha256: hash(bytes) });
    references = {
      tool: { id: 'native-config-tool', name: 'Native Config Inert Tool', kind: 'cli', rootPath: toolRoot, repository: null, sourceBinding: null, version: '1.0.0', alias: '', notes: 'Synthetic configuration reference only.', enabled: false, ownership: 'external', managementScope: 'register', actions: [], capabilities: [], updatePolicy: { mode: 'manual', intervalHours: 24, pinnedVersion: null, skippedVersions: [] }, installation: null, revision: 1, createdAt, updatedAt: createdAt },
      source: { id: 'native-config-source', kind: 'github', repo: 'example/native-config-source', branch: 'main', roots: [], ignoredPaths: [] },
      retainedSource: { id: 'native-local-source', kind: 'github', repo: 'example/native-local-source', branch: 'main', roots: [], ignoredPaths: [] },
      template: { id: 'native-config-template', name: 'Native Config Template', resourceId: 'native-config-tool', actionId: 'unregistered-inert-action', parameters: { query: 'Generated portable parameter' }, revision: 1, binding: '' },
      retainedTemplate: { id: 'native-local-template', name: 'Retained Local Template', resourceId: 'native-config-tool', actionId: 'unregistered-inert-action', parameters: { query: 'Retain local parameter' }, revision: 2, binding: '' },
      scene: { id: 'native-config-scene', name: 'Native Config Scene', members: [{ kind: 'skill', id: 'perf-skill-0000' }, { kind: 'tool', id: 'native-config-tool' }] },
      retainedScene: { id: 'native-local-scene', name: 'Retained Local Scene', members: [{ kind: 'skill', id: 'perf-skill-0001' }] },
      relation: { id: 'native-config-dependency', dependent: { kind: 'skill', id: 'perf-skill-0000' }, dependency: { kind: 'tool', id: 'native-config-tool' } },
      retainedRelation: { id: 'native-local-dependency', dependent: { kind: 'skill', id: 'perf-skill-0001' }, dependency: { kind: 'tool', id: 'native-config-tool' } },
    };
  }
  const profiles = {};
  for (const role of ['source', 'target']) {
    const profileRoot = join(root, role), dataDir = join(profileRoot, 'data'), dbPath = join(dataDir, 'manager.sqlite3'); await mkdir(dataDir, { recursive: true });
    const originals = structuredClone(skills);
    if (role === 'source') { originals[0].favorite = true; originals[0].categoryId = category.id; }
    const state = { skills: originals, sources: [], connections: [], localRoots: [], ignoredLocalPaths: [], checkMode: 'manual', checkGeneration: 0, checkSummary: null, stateRevision: role === 'source' ? 2 : 3, settings: { checkIntervalMinutes: role === 'source' ? 45 : 30, uiTheme: 'dark', uiZoom: 100, uiFontSize: 18, uiDensity: 'comfortable', uiAccent: role === 'source' ? 'blue' : 'violet', uiMotion: 'none', libraryMode: 'list', libraryPageSize: 20, librarySort: 'name', categories: [role === 'source' ? category : retainedCategory], sidebarWidth: 224, sidebarCollapsed: false } };
    if (references) state.sources = [role === 'source' ? references.source : references.retainedSource];
    const db = new DatabaseSync(dbPath), note = role === 'source' ? incomingNote : retainedNote;
    try {
      db.exec('CREATE TABLE app_state(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,payload TEXT NOT NULL); CREATE TABLE workspace_state(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL); CREATE TABLE skill_annotations(skill_id TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>0),alias TEXT NOT NULL,notes TEXT NOT NULL); CREATE TABLE management_data_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);');
      db.prepare('INSERT INTO app_state VALUES(1,1,?)').run(JSON.stringify(state));
      db.prepare('INSERT INTO skill_annotations VALUES(?,?,?,?)').run(note.skill_id, note.revision, note.alias, note.notes);
      db.prepare('INSERT INTO management_data_meta VALUES(1,?)').run(note.revision);
      if (references) {
        db.exec('CREATE TABLE resource_catalog(id TEXT PRIMARY KEY,root_key TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL,payload TEXT NOT NULL); CREATE TABLE resource_catalog_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL); CREATE TABLE invocation_templates(id TEXT PRIMARY KEY,resource_id TEXT NOT NULL,action_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL); CREATE TABLE invocation_templates_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL); CREATE TABLE resource_scenes(id TEXT PRIMARY KEY,name TEXT NOT NULL,members TEXT NOT NULL); CREATE TABLE resource_scenes_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,active_scene_id TEXT); CREATE TABLE resource_relations(id TEXT PRIMARY KEY,dependent_kind TEXT NOT NULL,dependent_id TEXT NOT NULL,dependency_kind TEXT NOT NULL,dependency_id TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(dependent_kind,dependent_id,dependency_kind,dependency_id)); CREATE TABLE resource_relations_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);');
        const template = role === 'source' ? references.template : references.retainedTemplate, scene = role === 'source' ? references.scene : references.retainedScene, relation = role === 'source' ? references.relation : references.retainedRelation;
        db.prepare('INSERT INTO resource_catalog VALUES(?,?,1,?)').run(references.tool.id, references.tool.rootPath.toLowerCase(), JSON.stringify(references.tool));
        db.prepare('INSERT INTO resource_catalog_meta VALUES(1,1)').run();
        db.prepare('INSERT INTO invocation_templates VALUES(?,?,?,?,?)').run(template.id, template.resourceId, template.actionId, template.revision, JSON.stringify(template));
        db.prepare('INSERT INTO invocation_templates_meta VALUES(1,?)').run(template.revision);
        db.prepare('INSERT INTO resource_scenes VALUES(?,?,?)').run(scene.id, scene.name, JSON.stringify(scene.members));
        db.prepare('INSERT INTO resource_scenes_meta VALUES(1,1,?)').run(scene.id);
        db.prepare('INSERT INTO resource_relations VALUES(?,?,?,?,?,?)').run(relation.id, relation.dependent.kind, relation.dependent.id, relation.dependency.kind, relation.dependency.id, createdAt);
        db.prepare('INSERT INTO resource_relations_meta VALUES(1,1)').run();
      }
    } finally { db.close(); }
    profiles[role] = { role, root: profileRoot, dataDir, dbPath, skillCount: 2, toolCount: references ? 1 : 0, initialDatabaseSha256: await digest(dbPath), initial: userData({ dbPath }) };
    await writeFile(join(profileRoot, 'fixture-owner.json'), json({ format: DRIVER_FORMAT, configurationFormat: FORMAT, syntheticOnly: true, role }));
    await writeFile(join(profileRoot, 'dataset.json'), json({ format: DRIVER_FORMAT, syntheticOnly: true, skillCount: 2, toolCount: references ? 1 : 0 }));
  }
  const fixture = { format: FORMAT, variant, syntheticOnly: true, root, resourcesRoot, exportsRoot, exportPath: join(exportsRoot, 'native-manager-config.json'), profiles, skills, sourceFiles, category, retainedCategory, incomingNote, retainedNote, references, createdAt };
  if (references) fixture.previewPaths = { duplicateRelation: join(exportsRoot, 'duplicate-dependency-config.json'), invalidPath: join(exportsRoot, 'invalid-path-config.json') };
  await writeFile(join(root, 'fixture-owner.json'), json({ format: FORMAT, syntheticOnly: true }));
  await writeFile(join(resourcesRoot, 'fixture-owner.json'), json({ format: FORMAT, syntheticOnly: true, dataRoot: root }));
  await writeFile(join(root, 'dataset.json'), json(fixture)); return fixture;
}
async function verifyResources(fixture) {
  for (const file of fixture.sourceFiles) {
    assert.ok(inside(file.path, fixture.resourcesRoot)); assert.ok(same(await realpath(file.path), file.path));
    const bytes = await readFile(file.path); assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256);
  }
}
async function absent(path) { await assert.rejects(lstat(path), error => error.code === 'ENOENT', 'The generated export destination must not already exist.'); }
async function readFixture(path) {
  const descriptor = resolve(path); assert.ok(inside(descriptor, dataParent) && basename(descriptor) === 'dataset.json');
  const fixture = JSON.parse(await readFile(descriptor, 'utf8')); assert.equal(fixture.format, FORMAT); assert.equal(fixture.syntheticOnly, true);
  assert.ok(['subset', 'references'].includes(fixture.variant || 'subset')); if (args.variant) assert.equal(args.variant, fixture.variant || 'subset');
  assert.ok(same(dirname(descriptor), fixture.root) && inside(fixture.root, dataParent) && inside(fixture.resourcesRoot, resourceParent));
  assert.ok(same(fixture.exportsRoot, join(fixture.root, 'exports')) && same(fixture.exportPath, join(fixture.exportsRoot, 'native-manager-config.json')));
  for (const directory of [fixture.root, fixture.resourcesRoot, fixture.exportsRoot]) assert.ok(same(await realpath(directory), directory));
  for (const role of ['source', 'target']) {
    const profile = fixture.profiles[role]; assert.equal(profile.role, role); assert.ok(same(profile.root, join(fixture.root, role)) && same(profile.dataDir, join(profile.root, 'data')) && same(profile.dbPath, join(profile.dataDir, 'manager.sqlite3')));
    for (const item of [profile.root, profile.dataDir, profile.dbPath]) assert.ok(same(await realpath(item), item));
    assert.equal(await digest(profile.dbPath), profile.initialDatabaseSha256, 'A partially run catalogue must not be replayed.'); assert.deepEqual(userData(profile), { resources: [], templates: [], scenes: [], relations: [], activeScene: null, ...profile.initial });
    const owner = JSON.parse(await readFile(join(profile.root, 'fixture-owner.json'), 'utf8')); assert.equal(owner.format, DRIVER_FORMAT); assert.equal(owner.configurationFormat, FORMAT); assert.equal(owner.syntheticOnly, true); assert.equal(owner.role, role);
  }
  if (fixture.variant === 'references') {
    assert.ok(fixture.references && same(fixture.previewPaths.duplicateRelation, join(fixture.exportsRoot, 'duplicate-dependency-config.json')) && same(fixture.previewPaths.invalidPath, join(fixture.exportsRoot, 'invalid-path-config.json')));
    for (const path of Object.values(fixture.previewPaths)) await absent(path);
  }
  await absent(fixture.exportPath); await verifyResources(fixture); return fixture;
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
  for (;;) { const value = await read(); if (accepts(value)) return value; assert.ok(Date.now() < deadline, `Native configuration observation unavailable: ${description}. No action was replayed.`); await sleep(50); }
}
async function rows(app, name, scope) { return list(await app.call('state', { name, ...(scope ? { scope } : {}) })).filter(row => row.type === 'ControlType.Button'); }
async function invoke(app, name, scope) {
  await wait(() => rows(app, name, scope), value => value.length === 1 && value[0].enabled, name); return app.call('invokeName', { name, ...(scope ? { scope } : {}) });
}
async function settings(app) {
  await invoke(app, '设置', '主要导航');
  if (!(await rows(app, '配置导入导出')).length) await invoke(app, '设置分类：常规');
  await invoke(app, '配置导入导出', '设置分类'); await wait(() => rows(app, '预览导出配置'), value => value.length === 1 && value[0].enabled, 'configuration section');
}
async function taskAfter(app, before, action, expectedStatus = 'succeeded') {
  const current = await wait(() => app.call('tasks'), value => value.tasks.some(item => !before.has(item.id) && item.action === action), action);
  const matches = current.tasks.filter(item => !before.has(item.id) && item.action === action); assert.equal(matches.length, 1, 'One native confirmation must create exactly one expected task.');
  const done = (await wait(() => app.call('task', { taskId: matches[0].id }), value => value.task && !['queued', 'running'].includes(value.task.status), `${action} completion`, 45000)).task;
  report.actions.push({ taskId: done.id, action: done.action, status: done.status, error: done.error || null }); assert.equal(done.status, expectedStatus, done.error || `Native ${action} returned an unexpected status.`); return expectedStatus === 'succeeded' ? done.result : done;
}
async function task(app, button, action) { const before = new Set((await app.call('tasks')).tasks.map(item => item.id)); await invoke(app, button); return taskAfter(app, before, action); }

// This helper interacts only with the application's real native common dialog.
// Filename/confirmation are semantic UIA operations, with no focus or clipboard.
async function fileDialog(app, fixture, mode, cancel = false, selectedPath = fixture.exportPath) {
  assert.ok(['save', 'open'].includes(mode)); assert.ok(same(fixture.exportPath, join(fixture.root, 'exports', 'native-manager-config.json')));
  assert.ok(same(selectedPath, fixture.exportPath) || mode === 'open' && Object.values(fixture.previewPaths || {}).some(path => same(path, selectedPath)));
  if (mode === 'save') await absent(selectedPath); else { assert.ok(same(await realpath(selectedPath), selectedPath)); assert.ok((await lstat(selectedPath)).isFile()); }
  const title = mode === 'save' ? '保存管理配置（不覆盖已有文件）' : '选择管理配置文件';
  const payload = Buffer.from(JSON.stringify({ pid: app.identity.pid, created: app.identity.creationFileTime, handle: app.identity.windowHandle, path: selectedPath, title, mode, cancel })).toString('base64');
  const command = `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$stage='initialize';$dialogObservation=$null;$controlObservation=$null;$providerObservation=$null;$controlSelections=@()
trap {
  [Console]::Error.WriteLine(([ordered]@{event='native-file-dialog-failure';stage=$stage;message=$_.Exception.GetBaseException().Message;providers=$providerObservation;dialog=$dialogObservation;control=$controlObservation}|ConvertTo-Json -Depth 8 -Compress))
  exit 1
}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName UIAutomationClientSideProviders
Add-Type -ReferencedAssemblies ([Windows.Automation.AutomationElement].Assembly.Location) -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
public static class ConfigurationDialogOwner {
  // UIA's default-provider loader inspects its caller's reflected type.
  // Keep an ordinary managed frame above PowerShell's dynamic call site.
  [MethodImpl(MethodImplOptions.NoInlining)]
  public static void RegisterProviders(AssemblyName assemblyName) { System.Windows.Automation.ClientSettings.RegisterClientSideProviderAssembly(assemblyName); }
  delegate bool Callback(IntPtr window,IntPtr state);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback,IntPtr state);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent,Callback callback,IntPtr state);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent,IntPtr child);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr dialog,int id);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flag);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,StringBuilder name,int size);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window,StringBuilder text,int size);
  [StructLayout(LayoutKind.Sequential)] struct RECT {public int left,top,right,bottom;}
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window,out RECT bounds);
  public static IntPtr[] Children(IntPtr dialog) {
    List<IntPtr> values=new List<IntPtr>();
    EnumChildWindows(dialog,(window,state)=>{values.Add(window);return true;},IntPtr.Zero);return values.ToArray();
  }
  public static object ChildState(IntPtr window) {
    uint pid;GetWindowThreadProcessId(window,out pid);StringBuilder name=new StringBuilder(128),text=new StringBuilder(512);GetClassName(window,name,name.Capacity);GetWindowText(window,text,text.Capacity);
    RECT bounds;bool hasBounds=GetWindowRect(window,out bounds);
    return new{window=window.ToInt64(),id=GetDlgCtrlID(window),className=name.ToString(),name=text.ToString(),pid=pid,visible=IsWindowVisible(window),enabled=IsWindowEnabled(window),hasBounds=hasBounds,left=bounds.left,top=bounds.top,width=bounds.right-bounds.left,height=bounds.bottom-bounds.top};
  }
  public static IntPtr[] Owned(IntPtr root,uint expectedPid) {
    List<IntPtr> values=new List<IntPtr>();
    EnumWindows((window,state)=>{uint pid;GetWindowThreadProcessId(window,out pid);StringBuilder name=new StringBuilder(64);GetClassName(window,name,name.Capacity);
      if(window!=root&&pid==expectedPid&&IsWindowVisible(window)&&GetAncestor(window,3)==root&&name.ToString()=="#32770")values.Add(window);return true;},IntPtr.Zero);
    return values.ToArray();
  }
}
'@
$stage='register-standard-providers'
$clientAssembly=[Windows.Automation.AutomationElement].Assembly;$typesAssembly=[Windows.Automation.ControlType].Assembly
$providerAssemblies=@([AppDomain]::CurrentDomain.GetAssemblies()|Where-Object {$_.GetName().Name -ieq 'UIAutomationClientSideProviders'})
if($providerAssemblies.Count -ne 1){throw 'One standard UIAutomation client-side provider assembly is required.'}
$providerAssembly=$providerAssemblies[0]
if($PSVersionTable.PSVersion.Major -ne 5 -or $clientAssembly.GetName().Version.Major -ne 4 -or $typesAssembly.GetName().Version -ne $clientAssembly.GetName().Version -or $providerAssembly.GetName().Version -ne $clientAssembly.GetName().Version){throw 'The common-dialog helper requires one consistent system Windows PowerShell / .NET Framework UIAutomation runtime.'}
$providerObservation=[ordered]@{hostPath=(Get-Process -Id $PID).Path;psVersion=$PSVersionTable.PSVersion.ToString();runtime=[Environment]::Version.ToString();client=$clientAssembly.FullName;clientPath=$clientAssembly.Location;types=$typesAssembly.FullName;typesPath=$typesAssembly.Location;provider=$providerAssembly.FullName;providerPath=$providerAssembly.Location;registrationMethod='ClientSettings.RegisterClientSideProviderAssembly through a non-inlined managed frame';registered=$false}
[ConfigurationDialogOwner]::RegisterProviders($providerAssembly.GetName())
$providerObservation.registered=$true
$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json
function Assert-Owned {
  $process=Get-Process -Id $p.pid
  if($process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne $p.created){throw 'Owned process identity changed.'}
  $actual=[uint32]0
  [void][ConfigurationDialogOwner]::GetWindowThreadProcessId([IntPtr]([long]$p.handle),[ref]$actual)
  if($actual -ne $p.pid){throw 'Original native window identity changed.'}
}
function Assert-Dialog {
  Assert-Owned
  $owned=@([ConfigurationDialogOwner]::Owned([IntPtr]([long]$p.handle),[uint32]$p.pid))
  $matching=@($owned|Where-Object {([Windows.Automation.AutomationElement]::FromHandle($_)).Current.Name -eq $p.title})
  if($matching.Count -ne 1 -or $matching[0] -ne $dialogHandle){throw 'The exact owned native file dialog identity or visibility changed.'}
  if($dialog.Current.ProcessId -ne $p.pid){throw 'The common dialog is not in the owned application process.'}
}
function Control-Observation($element) {
  $current=$element.Current;$bounds=$current.BoundingRectangle
  [ordered]@{id=$current.AutomationId;name=$current.Name;type=$current.ControlType.ProgrammaticName;pid=$current.ProcessId;enabled=$current.IsEnabled;offscreen=$current.IsOffscreen;bounds=$bounds.ToString();width=$bounds.Width;height=$bounds.Height;patterns=@($element.GetSupportedPatterns()|ForEach-Object {$_.ProgrammaticName})}
}
function Native-Controls($id,$type) {
  $expectedClass=if($type -eq [Windows.Automation.ControlType]::Button){'Button'}else{'Edit'}
  $children=@([ConfigurationDialogOwner]::Children($dialogHandle));$rows=@();$matches=@();$elements=@{}
  foreach($handle in $children){
    $native=[ConfigurationDialogOwner]::ChildState($handle)
    $row=[ordered]@{window=$native.window;id=$native.id;className=$native.className;name=$native.name;pid=$native.pid;visible=$native.visible;enabled=$native.enabled;hasBounds=$native.hasBounds;left=$native.left;top=$native.top;width=$native.width;height=$native.height;uia=$null}
    if($native.id -eq [int]$id){
      try{$element=[Windows.Automation.AutomationElement]::FromHandle($handle);$row.uia=Control-Observation $element;$elements[$handle.ToInt64()]=$element}catch{$row.uiaError=$_.Exception.GetBaseException().Message}
      if($native.pid -eq $p.pid -and $native.className -eq $expectedClass -and [ConfigurationDialogOwner]::IsChild($dialogHandle,$handle)){$matches+=,$handle}
    }
    $rows+=,$row
  }
  $direct=[ConfigurationDialogOwner]::GetDlgItem($dialogHandle,[int]$id)
  $script:controlObservation.nativeChildren=$rows;$script:controlObservation.nativeMatchCount=$matches.Count;$script:controlObservation.directDialogItem=$direct.ToInt64()
  if($matches.Count -gt 1){throw "Exact Win32 common-dialog control is ambiguous: $id"}
  if($matches.Count -ne 1){return $null}
  $handle=$matches[0]
  if($type -eq [Windows.Automation.ControlType]::Button -and $direct -ne $handle){return $null}
  $element=$elements[$handle.ToInt64()];if($null -eq $element){return $null}
  $current=$element.Current;$bounds=$current.BoundingRectangle
  if($current.ProcessId -ne $p.pid -or $current.ControlType -ne $type){return $null}
  if(-not [ConfigurationDialogOwner]::IsWindowVisible($handle) -or -not [ConfigurationDialogOwner]::IsWindowEnabled($handle) -or -not $current.IsEnabled -or $current.IsOffscreen -or $bounds.IsEmpty -or $bounds.Width -le 0 -or $bounds.Height -le 0){return $null}
  $method=if($type -eq [Windows.Automation.ControlType]::Button){'UIA.FromHandle-GetDlgItem'}else{'UIA.FromHandle-EnumChildWindows'}
  $script:controlSelections+=,[ordered]@{id=$id;method=$method;nativeWindow=$handle.ToInt64();nativeClass=$expectedClass;observed=Control-Observation $element}
  return $element
}
function Exact-Control($dialog,$id,$type) {
  $conditions=[Windows.Automation.Condition[]]@(
    [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty,$id),
    [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,$type))
  $controlWatch=[Diagnostics.Stopwatch]::StartNew()
  while($true){
    Assert-Dialog
    $matches=$dialog.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.AndCondition]::new($conditions))
    $available=$dialog.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,$type))
    $script:controlObservation=[ordered]@{id=$id;type=$type.ProgrammaticName;elapsedMs=$controlWatch.ElapsedMilliseconds;count=$matches.Count;matches=@($matches|ForEach-Object {Control-Observation $_});availableCount=$available.Count;available=@($available|Select-Object -First 40|ForEach-Object {Control-Observation $_});availableTruncated=$available.Count -gt 40}
    if($matches.Count -gt 1){throw "Exact common-dialog control is ambiguous: $id"}
    if($matches.Count -eq 1){
      $current=$matches[0].Current;$bounds=$current.BoundingRectangle
      if($current.ProcessId -ne $p.pid){throw "Exact common-dialog control belongs to another process: $id"}
      if($current.IsEnabled -and -not $current.IsOffscreen -and -not $bounds.IsEmpty -and $bounds.Width -gt 0 -and $bounds.Height -gt 0){$script:controlSelections+=,[ordered]@{id=$id;method='UIA-descendant-AutomationId';observed=Control-Observation $matches[0]};return $matches[0]}
    }
    if($matches.Count -eq 0){$native=Native-Controls $id $type;if($null -ne $native){return $native}}
    if($controlWatch.ElapsedMilliseconds -ge 15000){throw "Exact enabled common-dialog control did not become ready within 15000 ms: $id"}
    Start-Sleep -Milliseconds 50
  }
}
Assert-Owned
$stage='wait-owned-dialog'
$watch=[Diagnostics.Stopwatch]::StartNew();$dialog=$null;$dialogHandle=[IntPtr]::Zero
while($watch.ElapsedMilliseconds -lt 15000){
  Assert-Owned
  $owned=@([ConfigurationDialogOwner]::Owned([IntPtr]([long]$p.handle),[uint32]$p.pid))
  $matching=@($owned|Where-Object {([Windows.Automation.AutomationElement]::FromHandle($_)).Current.Name -eq $p.title})
  if($matching.Count -gt 1){throw 'The exact owned native file dialog is ambiguous.'}
  if($matching.Count -eq 1){$dialogHandle=$matching[0];$dialog=[Windows.Automation.AutomationElement]::FromHandle($dialogHandle);break}
  Start-Sleep -Milliseconds 50
}
if($null -eq $dialog){throw 'The exact owned native file dialog did not open.'}
$dialogObservation=[ordered]@{window=$dialogHandle.ToInt64();ownerWindow=$p.handle;pid=$dialog.Current.ProcessId;title=$dialog.Current.Name;bounds=$dialog.Current.BoundingRectangle.ToString();discoveredAfterMs=$watch.ElapsedMilliseconds}
Assert-Dialog
if(-not $p.cancel){
  if($p.mode -eq 'save' -and (Test-Path -LiteralPath $p.path)){throw 'Refusing to overwrite an existing export.'}
  if($p.mode -eq 'open' -and -not (Test-Path -LiteralPath $p.path -PathType Leaf)){throw 'The generated export is missing.'}
  $filenameId=if($p.mode -eq 'save'){'1001'}else{'1148'}
  $stage='wait-filename-control';$edit=Exact-Control $dialog $filenameId ([Windows.Automation.ControlType]::Edit)
  $value=$edit.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
  if($value.Current.IsReadOnly){throw 'The native filename field is read-only.'}
  $stage='set-exact-filename';Assert-Dialog
  $value.SetValue([string]$p.path)
  if($value.Current.Value -ne $p.path){throw 'The native filename field did not retain the exact generated path.'}
}
$stage='wait-confirmation-control'
$button=Exact-Control $dialog $(if($p.cancel){'2'}else{'1'}) ([Windows.Automation.ControlType]::Button)
$invoke=$button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
$stage='invoke-confirmation-once';Assert-Dialog
$invoke.Invoke()
$stage='wait-dialog-close'
$watch.Restart()
while([ConfigurationDialogOwner]::IsWindow($dialogHandle) -and [ConfigurationDialogOwner]::IsWindowVisible($dialogHandle)){
  Assert-Owned
  if($watch.ElapsedMilliseconds -ge 15000){throw 'The native file dialog did not close after its single confirmation; no confirmation was replayed.'}
  Start-Sleep -Milliseconds 50
}
[pscustomobject]@{pid=$p.pid;ownerWindow=$p.handle;dialogWindow=$dialogHandle.ToInt64();title=$p.title;mode=$p.mode;cancelled=[bool]$p.cancel;selectedPath=$(if($p.cancel){$null}else{$p.path});providers=$providerObservation;controls=$controlSelections;noForegroundInput=$true;noConfirmationReplay=$true}|ConvertTo-Json -Depth 8 -Compress`;
  const helperDirectory = join(dirname(app.identity.dataDirectory), 'driver-temp');
  assert.ok(inside(helperDirectory, fixture.root)); await mkdir(helperDirectory, { recursive: true }); assert.ok(same(await realpath(helperDirectory), helperDirectory));
  const helperPath = join(helperDirectory, `native-configuration-dialog-${randomUUID()}.ps1`), helperBytes = Buffer.from('\ufeff' + command, 'utf8');
  await writeFile(helperPath, helperBytes, { flag: 'wx' });
  const helperScript = { path: helperPath, sha256: hash(helperBytes), encoding: 'UTF-8 with BOM', auditOnly: true, executed: false };
  assert.equal(await digest(helperPath), helperScript.sha256, 'The retained helper audit file must match the exact generated command.');
  const invocation = [fileDialogHost, '-NoProfile', '-NonInteractive', '-Command', command];
  // Doubling every UTF-16 unit bounds Windows argument quoting and escaping.
  const commandLineUpperBoundUtf16Units = invocation.reduce((total, argument, index) => total + (index ? 1 : 0) + argument.length * 2 + 2, 1);
  const execution = { method: 'direct-interactive-command', host: fileDialogHost, commandLineUpperBoundUtf16Units, loadsAuditFile: false };
  assert.ok(commandLineUpperBoundUtf16Units < 32767, `The direct command exceeds the conservative Windows command-line bound (${commandLineUpperBoundUtf16Units} UTF-16 units). No helper was launched.`);
  let stdout;
  try {
    ({ stdout } = await execute(fileDialogHost, invocation.slice(1), { windowsHide: true, timeout: 65000, maxBuffer: 256 * 1024, env: { ...process.env, TEMP: helperDirectory, TMP: helperDirectory } }));
  } catch (error) {
    const stderr = String(error.stderr || '').trim();
    let diagnostic;
    for (const line of stderr.split(/\r?\n/)) { try { const parsed = JSON.parse(line); if (parsed.event === 'native-file-dialog-failure') diagnostic = parsed; } catch { /* Preserve the bounded text summary when PowerShell fails before the diagnostic handler. */ } }
    const stderrSummary = diagnostic?.message || stderr.replace(/<[^>]*>/g, '').replace(/_x000D_|_x000A_/g, '\n').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').slice(-4000) || 'No helper error text was returned.';
    report.dialogFailures.push({ mode, cancelled: cancel, title, helperScript, execution, code: error.code || null, signal: error.signal || null, stderrSummary, diagnostic: diagnostic || null });
    throw new Error(`Native ${mode} dialog helper failed. ${stderrSummary}`);
  }
  const observed = JSON.parse(stdout.trim()); assert.equal(observed.pid, app.identity.pid); assert.equal(observed.ownerWindow, app.identity.windowHandle); assert.equal(observed.title, title); assert.equal(observed.cancelled, cancel);
  assert.ok(same(observed.providers.hostPath, fileDialogHost)); assert.equal(observed.providers.registered, true);
  observed.helperScript = helperScript;
  observed.execution = execution;
  if (!cancel) assert.ok(same(observed.selectedPath, selectedPath)); report.dialogs.push(observed); return observed;
}
async function launch(profile, info) {
  const app = await NativeUiaSession.launch({ executable: info.path, dataDir: profile.dataDir, reportPath: join(profile.root, 'native-driver.json'), sha256: info.sha256, accessibilityInput: true });
  assert.equal(app.identity.executableSha256, info.sha256); assert.ok(same(app.identity.dataDirectory, profile.dataDir)); assert.equal(app.identity.basicModeRequested, false); return app;
}
async function openPreview(app, fixture, path = fixture.exportPath, expectedStatus = 'succeeded') {
  const before = new Set((await app.call('tasks')).tasks.map(item => item.id)); await invoke(app, '选择配置文件'); await fileDialog(app, fixture, 'open', false, path); return taskAfter(app, before, 'preview_configuration_import', expectedStatus);
}
async function rejectedReferencePreviews(app, fixture, document, targetBefore) {
  const duplicate = structuredClone(document), edge = duplicate.items.find(item => item.kind === 'relation' && item.id === fixture.references.relation.id);
  assert.ok(edge);
  duplicate.items.push({ kind: 'relation', id: 'native-config-duplicate-dependency', data: { ...edge.data, id: 'native-config-duplicate-dependency' } });
  await writeFile(fixture.previewPaths.duplicateRelation, json(duplicate), { flag: 'wx' });
  const blocked = await openPreview(app, fixture, fixture.previewPaths.duplicateRelation);
  for (const id of [edge.id, 'native-config-duplicate-dependency']) {
    const row = blocked.items.find(item => item.key === `relation:${id}`);
    assert.equal(row?.status, 'blocked'); assert.ok(row.reason.includes('相同依赖关系对应多个标识'));
    await wait(() => app.call('state', { name: `导入 ${id}` }), value => list(value).filter(item => item.type === 'ControlType.CheckBox').length === 1 && list(value).some(item => item.type === 'ControlType.CheckBox' && !item.enabled), 'blocked duplicate relation checkbox');
  }
  await invoke(app, '关闭预览'); assert.deepEqual(userData(fixture.profiles.target), targetBefore);
  const invalid = structuredClone(document); invalid.items.find(item => item.kind === 'skill').data.localPath = 'relative/invalid-skill';
  await writeFile(fixture.previewPaths.invalidPath, json(invalid), { flag: 'wx' });
  const rejected = await openPreview(app, fixture, fixture.previewPaths.invalidPath, 'failed');
  assert.ok(String(rejected.error).includes('配置位置必须是无上级跳转的完整路径'));
  await wait(() => rows(app, '选择配置文件'), value => value.length === 1 && value[0].enabled, 'invalid-path preview returned to the import form');
  assert.deepEqual(userData(fixture.profiles.target), targetBefore);
  assert.equal((await app.call('tasks')).tasks.filter(item => item.action === 'apply_configuration_import').length, 0);
  report.results.rejectedPreviews = { duplicateEdgeBlockedWithDisabledCheckboxes: true, relativePathRejected: true, noApplyTaskCreated: true, managementDataUnchanged: true };
}

if (phase === 'prepare') {
  const fixture = await prepare(); console.log(JSON.stringify({ status: 'prepared-not-run', fixture: join(fixture.root, 'dataset.json'), report: join(fixture.root, 'configuration-result.json'), noNativeLaunch: true })); process.exit(0);
}
assert.equal(typeof args.prepared, 'string');
const fixture = await readFixture(args.prepared), info = await candidate(), reportPath = join(fixture.root, 'configuration-result.json');
let app;
const referenceVariant = fixture.variant === 'references';
const actualLimitations = referenceVariant ? ['References variant covers native selective configuration transfer of sources, scenes, templates and dependency records, plus duplicate-edge blocking and invalid-path preview rejection.', 'The shared inert tool has no executable or actions. Template parameter transport is checked, while actual invocation compatibility remains outside this run.', ...limitations.slice(2)] : limitations;
let report = { format: FORMAT, variant: fixture.variant || 'subset', status: 'running', startedAt: new Date().toISOString(), fixture: resolve(args.prepared), candidate: info, syntheticOnly: true, limitations: actualLimitations, actions: [], dialogs: [], dialogFailures: [], results: {}, native: {} };
try {
  report.harness = await Promise.all(['verify-native-configuration.mjs', 'native-uia-client.mjs', 'verify-native-uia.ps1'].map(async name => ({ name, sha256: await digest(fileURLToPath(new URL(name, import.meta.url))) })));
  await writeFile(reportPath, json(report), { flag: 'wx' });
  app = await launch(fixture.profiles.source, info); report.native.source = app.identity; await settings(app);
  const sourceBefore = userData(fixture.profiles.source);
  await task(app, '预览导出配置', 'preview_configuration_export');
  const beforeCancel = new Set((await app.call('tasks')).tasks.map(item => item.id)); await invoke(app, '选择位置并导出'); await fileDialog(app, fixture, 'save', true);
  await wait(() => rows(app, '选择位置并导出'), value => value.length === 1 && value[0].enabled, 'cancelled Save dialog returns to the same preview');
  assert.ok((await app.call('tasks')).tasks.every(item => beforeCancel.has(item.id) || item.action !== 'export_configuration'));
  await absent(fixture.exportPath); await invoke(app, '关闭预览'); assert.deepEqual(userData(fixture.profiles.source), sourceBefore);
  report.results.exportCancellation = { realSaveDialogCancelled: true, noExportTaskOrFileCreated: true, managementDataUnchanged: true };
  const preview = await task(app, '预览导出配置', 'preview_configuration_export'); assert.equal(preview.document.format, 'agent-resource-manager-config'); assert.equal(preview.document.formatVersion, 1);
  const exportBefore = new Set((await app.call('tasks')).tasks.map(item => item.id)); await invoke(app, '选择位置并导出'); await fileDialog(app, fixture, 'save');
  const exported = await taskAfter(app, exportBefore, 'export_configuration'); assert.ok(same(exported.path, fixture.exportPath));
  const exportBytes = await readFile(fixture.exportPath), document = JSON.parse(exportBytes.toString('utf8')); assert.deepEqual(document, preview.document);
  assert.ok(document.items.some(item => item.kind === 'annotation' && item.id === incomingNote.skill_id && item.data.notes === incomingNote.notes));
  if (referenceVariant) for (const kind of ['source', 'template', 'scene', 'relation']) {
    const expected = fixture.references[kind], item = document.items.find(item => item.kind === kind && item.id === expected.id);
    assert.ok(item, `Nonempty exported ${kind} is missing.`);
    for (const [key, value] of Object.entries(expected)) if (!['revision', 'binding'].includes(key)) assert.deepEqual(item.data[key], value);
  }
  assert.deepEqual(userData(fixture.profiles.source), sourceBefore); report.results.export = { realNativeSaveDialog: true, exactPreviewDocumentWritten: true, path: fixture.exportPath, sha256: hash(exportBytes), bytes: exportBytes.length };
  assert.ok((await app.call('tasks')).tasks.every(item => ['management_data', 'preview_configuration_export', 'export_configuration'].includes(item.action)), 'An unrelated or automatic source task was observed.');
  report.sourceNormalExit = (await app.quit()).driverReport.closedNormally; app = null; await writeFile(reportPath, json(report));
  app = await launch(fixture.profiles.target, info); report.native.target = app.identity; await settings(app);
  const targetBefore = userData(fixture.profiles.target), cancelled = await openPreview(app, fixture); assert.ok(cancelled.items.some(item => item.status === 'conflict'));
  await invoke(app, '关闭预览'); assert.deepEqual(userData(fixture.profiles.target), targetBefore);
  assert.equal((await app.call('tasks')).tasks.filter(item => item.action === 'apply_configuration_import').length, 0);
  report.results.importCancellation = { realNativeOpenDialog: true, previewContainedConflict: true, noApplyTaskCreated: true, managementDataUnchanged: true };
  if (referenceVariant) await rejectedReferencePreviews(app, fixture, document, targetBefore);
  const incoming = await openPreview(app, fixture);
  const expectedKeys = ['settings:preferences', `category:${category.id}`, `annotation:${incomingNote.skill_id}`];
  if (referenceVariant) {
    for (const kind of ['source', 'template', 'scene', 'relation']) expectedKeys.push(`${kind}:${fixture.references[kind].id}`);
    const expectedReferences = { template: [`tool:${fixture.references.tool.id}`], scene: ['skill:perf-skill-0000', `tool:${fixture.references.tool.id}`], relation: ['skill:perf-skill-0000', `tool:${fixture.references.tool.id}`] };
    for (const [kind, keys] of Object.entries(expectedReferences)) {
      const row = incoming.items.find(item => item.key === `${kind}:${fixture.references[kind].id}`);
      assert.deepEqual(row.references.map(reference => reference.key).sort(), keys.sort());
      assert.ok(row.references.every(reference => reference.status === 'local'), 'Imported references must resolve to the exact retained local identities.');
    }
  }
  for (const key of expectedKeys) assert.ok(incoming.items.some(item => item.key === key && ['new', 'conflict'].includes(item.status)));
  assert.deepEqual(incoming.items.filter(item => item.status === 'new').map(item => item.key).sort(), expectedKeys.filter(key => !key.startsWith('settings:')).sort());
  await invoke(app, '取消选择'); await invoke(app, '只选新增'); await app.call('toggle', { name: '导入 preferences', checked: true });
  const applied = await task(app, '导入所选管理信息', 'apply_configuration_import'); assert.equal(applied.applied, expectedKeys.length);
  const after = userData(fixture.profiles.target), preferences = document.items.find(item => item.kind === 'settings' && item.id === 'preferences').data;
  for (const [key, value] of Object.entries(preferences)) assert.deepEqual(after.state.settings[key], value, `Imported preference ${key} differs.`);
  assert.deepEqual(after.state.settings.categories, [retainedCategory, category]); assert.deepEqual(after.state.skills, targetBefore.state.skills);
  assert.equal(after.state.checkMode, 'manual');
  if (referenceVariant) assert.deepEqual(after.state.sources, [...targetBefore.state.sources, fixture.references.source]);
  else assert.equal(after.state.sources.length, 0);
  assert.equal(after.state.connections.length, 0); assert.equal(after.state.localRoots.length, 0);
  const note = after.annotations.find(item => item.skill_id === incomingNote.skill_id); assert.equal(note.alias, incomingNote.alias); assert.equal(note.notes, incomingNote.notes); assert.ok(note.revision > 0);
  assert.deepEqual(after.annotations.find(item => item.skill_id === retainedNote.skill_id), retainedNote);
  if (referenceVariant) {
    const references = fixture.references, template = after.templates.find(item => item.id === references.template.id);
    assert.equal(after.templates.length, targetBefore.templates.length + 1);
    for (const key of ['id', 'name', 'resourceId', 'actionId', 'parameters']) assert.deepEqual(template[key], references.template[key]);
    assert.ok(template.revision > 0); assert.equal(template.binding, '');
    assert.deepEqual(after.templates.find(item => item.id === references.retainedTemplate.id), targetBefore.templates[0]);
    assert.deepEqual(after.scenes, [...targetBefore.scenes, references.scene].sort((left, right) => left.id.localeCompare(right.id)));
    assert.equal(after.activeScene, targetBefore.activeScene); assert.equal(after.activeScene, references.retainedScene.id);
    assert.equal(after.relations.length, targetBefore.relations.length + 1);
    const relation = after.relations.find(item => item.id === references.relation.id);
    assert.deepEqual([relation.dependent_kind, relation.dependent_id, relation.dependency_kind, relation.dependency_id], [references.relation.dependent.kind, references.relation.dependent.id, references.relation.dependency.kind, references.relation.dependency.id]);
    assert.deepEqual(after.relations.find(item => item.id === references.retainedRelation.id), targetBefore.relations[0]);
    assert.deepEqual(after.resources, targetBefore.resources);
    report.results.references = { selectedKinds: ['source', 'template', 'scene', 'relation'], exactLocalReferencesRetained: true, portableTemplateParametersPersisted: true, existingTemplateSceneAndDependencyRetained: true, activeLocalSceneUnchanged: true, unselectedToolAndActionsUnchanged: true };
  }
  assert.ok(applied.state && applied.state.skills.length === 2); assert.equal(await digest(fixture.exportPath), hash(exportBytes));
  report.results.import = { explicitSelectedKeys: expectedKeys, applied: applied.applied, preferencesCategoryAndAnnotationPersisted: true, unselectedSkillAndFavoriteUnchanged: true, absentExistingLocalNoteRetained: true, originalManualPolicyAndResourceBindingsRetained: true };
  const allowed = ['management_data', 'preview_configuration_import', 'apply_configuration_import'];
  assert.ok((await app.call('tasks')).tasks.every(item => allowed.includes(item.action)), 'An unrelated or automatic task was observed.');
  await verifyResources(fixture); await app.call('screenshot', { path: join(fixture.root, 'native-configuration-result.png') });
  report.targetNormalExit = (await app.quit()).driverReport.closedNormally; app = null;
  assert.deepEqual(userData(fixture.profiles.source), sourceBefore); assert.deepEqual(userData(fixture.profiles.target), after); await verifyResources(fixture);
  for (const file of report.harness) assert.equal(await digest(fileURLToPath(new URL(file.name, import.meta.url))), file.sha256, 'A native helper changed during this run.');
  assert.equal(await digest(info.path), info.sha256); assert.equal(await digest(info.buildInfoPath), info.buildInfoSha256);
  report.status = referenceVariant ? 'passed-native-configuration-references-roundtrip-synthetic-only' : 'passed-native-configuration-subset-roundtrip-synthetic-only';
} catch (error) {
  report.status = 'failed-or-blocked'; report.error = String(error); process.exitCode = 1;
  if (app && !app.exited && !app.operationError) {
    try { const path = join(fixture.root, 'configuration-failure.png'); await app.call('screenshot', { path }); report.failureScreenshot = path; }
    catch (captureError) { report.failureScreenshotError = String(captureError); }
  }
} finally {
  if (app) { try { report.failureNormalExit = (await app.quit()).driverReport.closedNormally; } catch (error) { report.failureNormalExit = false; report.closeError = String(error); } }
  report.finishedAt = new Date().toISOString(); await writeFile(reportPath, json(report));
}
console.log(JSON.stringify({ status: report.status, report: reportPath, sourceNormalExit: report.sourceNormalExit, targetNormalExit: report.targetNormalExit }));
