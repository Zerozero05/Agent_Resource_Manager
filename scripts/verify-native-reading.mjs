import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { NativeUiaSession } from './native-uia-client.mjs';

const FORMAT = 'agent-resource-manager-native-reading-v1';
const DRIVER_FORMAT = 'agent-resource-manager-native-performance-v1';
const validation = 'D:\\03_github_projects\\Agent_Management\\Agent_Resource_Manager\\validation';
const dataParent = join(validation, 'manager-data'), resourceParent = join(validation, 'resources');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, flag, index, all) => flag.startsWith('--') ? [...pairs, [flag.slice(2), all[index + 1]]] : pairs, []));
const POLICY = Object.freeze({ coordinateTolerancePx: 24, savedScrollTolerancePx: 2, minimumSavedScroll: 1200, taskDeadlineMs: 60000 });
const standardMarker = '仅用于隔离的本地性能验收，不调用外部程序，不连接远端。';
const heading = 'NATIVE_READING_MIDDLE_ANCHOR';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = async path => hash(await readFile(path));
const json = value => JSON.stringify(value, null, 2) + '\n';
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const same = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase();
const inside = (path, root) => { const rel = relative(root, path); return rel === '' || !rel.startsWith('..') && !isAbsolute(rel); };
const sleep = ms => new Promise(done => setTimeout(done, ms));
const execute = promisify(execFile);

function stored(fixture) {
  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try {
    const state = JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload);
    const row = db.prepare('SELECT payload FROM workspace_state WHERE id=1').get();
    const tasks = db.prepare("SELECT json_extract(payload,'$.id') AS id,json_extract(payload,'$.action') AS action,json_extract(payload,'$.status') AS status FROM task_history").all();
    return { state, workspace: row ? JSON.parse(row.payload) : null, tasks };
  } finally { db.close(); }
}
function navigation(fixture, paneId) {
  const workspace = stored(fixture).workspace;
  const window = workspace?.windows?.find(item => item.label === 'main');
  const pane = window?.panes?.find(item => item.id === paneId);
  return pane ? { activePaneId: window.activePaneId, pane } : null;
}
async function wait(read, accepts, description, timeout = 20000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await read(); if (accepts(value)) return value;
    assert.ok(Date.now() < end, `Reading observation unavailable: ${description}; last ${JSON.stringify(value).slice(0, 1500)}. No action was replayed.`);
    await sleep(80);
  }
}
async function invoke(app, name, scope) {
  if (scope) await wait(() => app.call('state', { name: scope }), rows => list(rows).filter(row => row.enabled && !row.offscreen).length === 1, scope);
  await wait(() => app.call('state', { name, ...(scope ? { scope } : {}) }), rows => list(rows).filter(row => row.type === 'ControlType.Button' && row.enabled && !row.offscreen).length === 1, name);
  await app.call('invokeName', { name, ...(scope ? { scope } : {}) });
}

async function prepare() {
  assert.ok(!args.prepared && !args.candidate && !args['candidate-build-info']);
  await mkdir(dataParent, { recursive: true }); await mkdir(resourceParent, { recursive: true });
  const root = await mkdtemp(join(dataParent, 'native-reading-'));
  const resourcesRoot = await mkdtemp(join(resourceParent, 'native-reading-'));
  const dataDir = join(root, 'data'), dbPath = join(dataDir, 'manager.sqlite3'); await mkdir(dataDir);
  const createdAt = new Date().toISOString(), skills = [], sourceFiles = [];
  for (let index = 0; index < 2; index++) {
    const key = String(index).padStart(4, '0'), id = `perf-skill-${key}`, localPath = join(resourcesRoot, id); await mkdir(localPath);
    const paragraphs = Array.from({ length: 90 }, (_, row) => `Generated reading paragraph ${String(row + 1).padStart(3, '0')}. This inert text establishes a long real document without scripts, images, external links or private content.`).join('\n\n');
    const body = index === 0 ? `## BEFORE_THE_MIDDLE\n\n${paragraphs}\n\n## ${heading}\n\nThe unique middle heading is the reading position under test.\n\n${paragraphs}\n\n## AFTER_THE_MIDDLE\n\nEnd of generated long document.` : '## Short document\n\nSecond inert generated Skill.';
    const bytes = Buffer.from(`---\nname: ${id}\ndescription: Generated local native reading acceptance.\nmetadata:\n  version: "1.0.0"\n---\n\n# Perf Skill ${key}\n\n${standardMarker}\n\n${body}\n`);
    const path = join(localPath, 'SKILL.md'); await writeFile(path, bytes, { flag: 'wx' });
    sourceFiles.push({ path, bytes: bytes.length, sha256: hash(bytes) });
    skills.push({ id, name: id, displayName: `Perf Skill ${key}`, description: 'Generated inert reading fixture.', localPath, status: 'local_only', version: '1.0.0', runtimeFiles: ['SKILL.md'], runtimeConfirmed: true, runtimeAudit: { status: 'verified', warnings: [], checkedAt: createdAt }, runtimeWarnings: [], runtimeIssues: [], localHashes: { 'SKILL.md': hash(bytes) }, favorite: false, readOnly: false });
  }
  const state = { skills, sources: [], connections: [], localRoots: [], ignoredLocalPaths: [], checkMode: 'manual', checkGeneration: 0, checkSummary: null, stateRevision: 1, settings: { checkIntervalMinutes: 30, uiTheme: 'dark', uiZoom: 100, uiFontSize: 18, uiDensity: 'comfortable', uiAccent: 'violet', uiMotion: 'none', libraryMode: 'list', libraryPageSize: 20, librarySort: 'name', categories: [], sidebarWidth: 224, sidebarCollapsed: false } };
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE app_state(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,payload TEXT NOT NULL); CREATE TABLE workspace_state(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL); CREATE TABLE resource_catalog(id TEXT PRIMARY KEY,root_key TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL CHECK(revision>0),payload TEXT NOT NULL); CREATE TABLE resource_catalog_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);');
    db.prepare('INSERT INTO app_state VALUES(1,1,?)').run(JSON.stringify(state)); db.exec('INSERT INTO resource_catalog_meta VALUES(1,0);');
  } finally { db.close(); }
  const fixture = { format: FORMAT, driverFormat: DRIVER_FORMAT, syntheticOnly: true, root, resourcesRoot, dataDir, dbPath, skillCount: 2, toolCount: 0, sourceFiles, originalState: state, heading, policy: POLICY, initialDatabaseSha256: await digest(dbPath), createdAt };
  await writeFile(join(root, 'fixture-owner.json'), json({ format: DRIVER_FORMAT, readingFormat: FORMAT, syntheticOnly: true }));
  await writeFile(join(resourcesRoot, 'fixture-owner.json'), json({ format: FORMAT, syntheticOnly: true, dataRoot: root }));
  await writeFile(join(root, 'dataset.json'), json(fixture), { flag: 'wx' }); return fixture;
}
async function readFixture(path) {
  const descriptor = resolve(path || ''), fixture = JSON.parse(await readFile(descriptor, 'utf8'));
  assert.equal(fixture.format, FORMAT); assert.equal(fixture.driverFormat, DRIVER_FORMAT); assert.equal(fixture.syntheticOnly, true); assert.deepEqual(fixture.policy, POLICY); assert.equal(fixture.heading, heading);
  assert.ok(same(descriptor, join(fixture.root, 'dataset.json')) && inside(fixture.root, dataParent) && inside(fixture.resourcesRoot, resourceParent));
  assert.ok(same(fixture.dataDir, join(fixture.root, 'data')) && same(fixture.dbPath, join(fixture.dataDir, 'manager.sqlite3')));
  for (const directory of [fixture.root, fixture.resourcesRoot, fixture.dataDir]) assert.ok(same(await realpath(directory), directory));
  assert.equal(await digest(fixture.dbPath), fixture.initialDatabaseSha256, 'Use a fresh fixture. An attempted reading fixture cannot be replayed.');
  const marker = JSON.parse(await readFile(join(fixture.root, 'fixture-owner.json'), 'utf8')); assert.equal(marker.format, DRIVER_FORMAT); assert.equal(marker.readingFormat, FORMAT); assert.equal(marker.syntheticOnly, true);
  await verifyResources(fixture); return fixture;
}
async function verifyResources(fixture) {
  assert.equal(fixture.sourceFiles.length, 2);
  for (const file of fixture.sourceFiles) { assert.ok(inside(file.path, fixture.resourcesRoot) && same(await realpath(file.path), file.path)); const bytes = await readFile(file.path); assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256); }
}

// This independent helper observes the exact owned HWND and exact document pane.
// Its only activation mode selects the ordinary existing workspace tab by its ID.
function nativeCommand(payload, compileOnly = false) {
  const encoded = Buffer.from(JSON.stringify(payload || {})).toString('base64');
  return `
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient;Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class ReadingWindowOwner {
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
}
'@
if(${compileOnly ? '$true' : '$false'}){'{"compiled":true,"enumeratedWindows":false,"sentInput":false}'|Write-Output;exit}
$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json
function Owned { $process=Get-Process -Id $p.pid;if($process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne $p.created){throw 'Owned reading process identity changed.'};$actual=[uint32]0;[void][ReadingWindowOwner]::GetWindowThreadProcessId([IntPtr]([long]$p.handle),[ref]$actual);if($actual -ne $p.pid){throw 'Owned reading HWND identity changed.'} }
function ExactId($scope,$id){$items=$scope.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty,$id));if($items.Count -gt 1){throw 'The exact reading element ID is ambiguous.'};if($items.Count -eq 1){return $items[0]};return $null}
Owned;$root=[Windows.Automation.AutomationElement]::FromHandle([IntPtr]([long]$p.handle));if($root.Current.ProcessId -ne $p.pid){throw 'Reading window UIA root belongs to another process.'}
$tab=ExactId $root $p.tabId;if($null -eq $tab -or $tab.Current.ControlType -ne [Windows.Automation.ControlType]::TabItem -or -not $tab.Current.IsEnabled -or $tab.Current.IsOffscreen){throw 'Exact reading tab is unavailable.'}
$selection=$tab.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)
if($p.mode -eq 'select'){
 Owned;$selectionWatch=[Diagnostics.Stopwatch]::StartNew();$selection.Select()
 while($selectionWatch.ElapsedMilliseconds -lt 15000){
  Owned;$selectionRoot=[Windows.Automation.AutomationElement]::FromHandle([IntPtr]([long]$p.handle));if($selectionRoot.Current.ProcessId -ne $p.pid){throw 'Reading window UIA root belongs to another process.'}
  $selectedTabElement=ExactId $selectionRoot $p.tabId
  if($null -ne $selectedTabElement -and $selectedTabElement.Current.ControlType -eq [Windows.Automation.ControlType]::TabItem -and $selectedTabElement.Current.IsEnabled -and -not $selectedTabElement.Current.IsOffscreen){
   $selectedTabPattern=$selectedTabElement.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)
   $tabIsSelected=$selectedTabPattern.Current.IsSelected
   if($tabIsSelected){Owned;[ordered]@{pid=$p.pid;created=$p.created;handle=$p.handle;tabId=$selectedTabElement.Current.AutomationId;selected=$tabIsSelected;nativeTabSelection=$true;selectionObservationElapsedMs=$selectionWatch.Elapsed.TotalMilliseconds}|ConvertTo-Json -Compress;exit}
  }
  Start-Sleep -Milliseconds 80
 }
 throw 'The exact owned reading tab was not selected within fifteen seconds. The selection was not replayed.'
}
$watch=[Diagnostics.Stopwatch]::StartNew();$panel=$null;$target=$null
while($watch.ElapsedMilliseconds -lt 15000){
 Owned;$panel=ExactId $root $p.panelId
 if($selection.Current.IsSelected -and $null -ne $panel -and -not $panel.Current.IsOffscreen){
  $matches=$panel.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.AndCondition]::new([Windows.Automation.Condition[]]@([Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,$p.heading),[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Text))))
  if($matches.Count -gt 1){throw 'The exact middle heading is ambiguous within the document pane.'}
  if($matches.Count -eq 1){$candidate=$matches[0];$box=$candidate.Current.BoundingRectangle;$viewport=$panel.Current.BoundingRectangle;if(-not $candidate.Current.IsOffscreen -and $box.Width -gt 0 -and $box.Height -gt 0 -and $box.Top -ge $viewport.Top -and $box.Bottom -le $viewport.Bottom -and $box.Right -gt $viewport.Left -and $box.Left -lt $viewport.Right){$target=$candidate;break}}
 }
 Start-Sleep -Milliseconds 80
}
if($null -eq $target){throw 'The middle heading is not visibly rendered in the selected owned pane. No reveal or scroll correction was attempted.'}
Owned;$box=$target.Current.BoundingRectangle;$viewport=$panel.Current.BoundingRectangle
[ordered]@{pid=$p.pid;created=$p.created;handle=$p.handle;tabId=$tab.Current.AutomationId;panelId=$panel.Current.AutomationId;selected=$selection.Current.IsSelected;heading=$target.Current.Name;headingType=$target.Current.ControlType.ProgrammaticName;headingOffscreen=$target.Current.IsOffscreen;headingBounds=@($box.X,$box.Y,$box.Width,$box.Height);paneBounds=@($viewport.X,$viewport.Y,$viewport.Width,$viewport.Height);offsetTop=$box.Top-$viewport.Top;noRevealOrScroll=$true;noForegroundInput=$true}|ConvertTo-Json -Depth 4 -Compress`;
}
async function nativeReading(app, fixture, paneId, mode = 'read') {
  assert.ok(['read', 'select'].includes(mode));
  const command = nativeCommand({ mode, pid: app.identity.pid, created: app.identity.creationFileTime, handle: app.identity.windowHandle, tabId: `tab-${encodeURIComponent(paneId)}`, panelId: `panel-${encodeURIComponent(paneId)}`, heading });
  assert.ok(command.length * 2 + 200 < 32767);
  const { stdout } = await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 30000, maxBuffer: 128 * 1024, env: { ...process.env, TEMP: join(fixture.root, 'driver-temp'), TMP: join(fixture.root, 'driver-temp') } });
  const result = JSON.parse(stdout.trim()); assert.equal(result.pid, app.identity.pid); assert.equal(String(result.created), app.identity.creationFileTime); assert.equal(result.handle, app.identity.windowHandle); assert.equal(result.tabId, `tab-${encodeURIComponent(paneId)}`); assert.equal(result.selected, true);
  return result;
}
function compareAnchor(before, after, savedBefore, savedAfter) {
  assert.equal(after.heading, heading); assert.equal(after.headingOffscreen, false); assert.equal(after.noRevealOrScroll, true);
  assert.deepEqual(after.paneBounds.slice(2), before.paneBounds.slice(2), 'The fixed pane viewport changed size during the focused reading check.');
  const coordinateDeltaPx = after.offsetTop - before.offsetTop, savedScrollDeltaPx = savedAfter.pane.state.scrollTop - savedBefore.pane.state.scrollTop;
  assert.ok(Math.abs(coordinateDeltaPx) <= POLICY.coordinateTolerancePx, `The visible middle heading moved by ${coordinateDeltaPx}px.`);
  assert.ok(Math.abs(savedScrollDeltaPx) <= POLICY.savedScrollTolerancePx, `The persisted reading scroll moved by ${savedScrollDeltaPx}px.`);
  return { coordinateDeltaPx, savedScrollDeltaPx, actualHeadingVisible: true, noSecondRevealOrScroll: true };
}

if (process.argv.includes('--help')) { console.log('Prepare --phase prepare. Compile-only --phase compile-helper. Native run --phase run --prepared <dataset.json> --candidate <release.exe> --candidate-build-info <json>. Long generated document, ordinary outline jump, one real check, home/tab round trip, exact owned native heading bounds plus persisted scrollTop. No reveal/scroll after initial outline jump. No GUI is launched by preparation or compile-helper.'); process.exit(0); }
assert.ok(['prepare', 'compile-helper', 'run'].includes(args.phase));
if (args.phase === 'compile-helper') { const { stdout } = await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', nativeCommand({}, true)], { windowsHide: true, timeout: 30000, maxBuffer: 128 * 1024 }); console.log(stdout.trim()); process.exit(0); }
if (args.phase === 'prepare') { const fixture = await prepare(); console.log(JSON.stringify({ status: 'prepared-not-run', prepared: join(fixture.root, 'dataset.json'), resources: fixture.resourcesRoot, noNativeLaunch: true })); process.exit(0); }
const fixture = await readFixture(args.prepared), executable = resolve(args.candidate || ''), buildInfoPath = resolve(args['candidate-build-info'] || ''), buildInfoBytes = await readFile(buildInfoPath), info = JSON.parse(buildInfoBytes.toString('utf8'));
assert.equal(basename(executable), 'agent-resource-manager.exe'); assert.equal(info.buildMode, 'release'); assert.equal(await digest(executable), info.executableSha256); assert.ok(info.sourceIdentity || info.sourceCommit);
const reportPath = join(fixture.root, 'reading-result.json');
const report = { format: FORMAT, status: 'running', startedAt: new Date().toISOString(), fixture: fixture.root, candidate: { executable, sha256: info.executableSha256, buildInfoPath, buildInfoSha256: hash(buildInfoBytes), sourceIdentity: info.sourceIdentity || info.sourceCommit }, policy: POLICY, results: {}, actions: [], limitations: ['Local Markdown only, fixed current theme/zoom and viewport; not remote image settling, IME, dragging, split view, detach/return or relaunch restoration.', 'Native relative coordinates are measured against the actual selected document panel bounds including its fixed toolbar. No DOM evaluation or React-state inference is used.', 'One ordinary outline activation establishes the anchor. All subsequent observations are read-only and never reveal or scroll the heading.', 'No mutation of source files, backend shortcuts, network, resource execution, installation, backup or cleanup.'] };
report.harness = await Promise.all(['verify-native-reading.mjs', 'native-uia-client.mjs', 'verify-native-uia.ps1'].map(async name => ({ name, sha256: await digest(fileURLToPath(new URL(name, import.meta.url))) })));
await writeFile(reportPath, json(report), { flag: 'wx' });
let app;
try {
  report.currentStep = 'launch-native-workbench';
  app = await NativeUiaSession.launch({ executable, sha256: info.executableSha256, dataDir: fixture.dataDir, reportPath: join(fixture.root, 'native-driver.json'), accessibilityInput: true, workbenchOnlyReadiness: true }); report.native = app.identity;
  await invoke(app, 'Skills', '主要导航');
  await wait(() => app.call('state', { name: '搜索 Skill' }), rows => list(rows).some(row => row.type === 'ControlType.Edit' && !row.offscreen), 'Skills search');
  await app.call('search', { index: 0 }); await app.call('openDocument', { index: 0 });
  const workspace = await wait(() => stored(fixture).workspace, value => value?.windows?.find(item => item.label === 'main')?.panes?.some(pane => pane.kind === 'detail' && pane.skillId === 'perf-skill-0000'), 'actual reading detail pane');
  const panes = workspace.windows.find(item => item.label === 'main').panes.filter(pane => pane.kind === 'detail' && pane.skillId === 'perf-skill-0000'); assert.equal(panes.length, 1); const paneId = panes[0].id; report.paneId = paneId;
  report.currentStep = 'jump-to-middle-through-ordinary-outline';
  await invoke(app, '目录'); await invoke(app, heading, '当前页面目录'); report.actions.push('one ordinary outline middle-heading invocation');
  await sleep(1500);
  const savedBefore = await wait(() => navigation(fixture, paneId), value => value?.activePaneId === paneId && value.pane.state.scrollTop > POLICY.minimumSavedScroll, 'persisted non-top reading position');
  const baseline = await nativeReading(app, fixture, paneId); report.results.baseline = { observation: baseline, navigation: savedBefore };
  assert.ok(baseline.offsetTop >= 0 && baseline.offsetTop < baseline.paneBounds[3] / 2, 'The ordinary outline jump must place the heading in the upper half of the actual pane.');
  report.currentStep = 'one-real-check-without-moving-the-reading-position';
  const known = new Set(stored(fixture).tasks.map(task => task.id)); await app.call('check'); report.actions.push('one real native check button invocation');
  const completed = await wait(() => stored(fixture).tasks.filter(task => !known.has(task.id)), rows => rows.length === 1 && !['queued', 'running'].includes(rows[0].status), 'single check completion', POLICY.taskDeadlineMs);
  assert.equal(completed[0].action, 'check_now'); assert.equal(completed[0].status, 'succeeded');
  const outcome = (await app.call('task', { taskId: completed[0].id })).task; assert.equal(outcome.result.skills.length, 2); report.results.realCheck = { id: outcome.id, status: outcome.status, skillCount: outcome.result.skills.length };
  await sleep(700);
  const afterCheck = await nativeReading(app, fixture, paneId), savedAfterCheck = navigation(fixture, paneId);
  assert.equal(savedAfterCheck.activePaneId, paneId); report.results.afterCheck = { observation: afterCheck, navigation: savedAfterCheck, comparison: compareAnchor(baseline, afterCheck, savedBefore, savedAfterCheck) };
  report.currentStep = 'ordinary-home-and-reading-tab-round-trip';
  await invoke(app, '返回工作台'); await wait(() => navigation(fixture, paneId), value => value?.activePaneId === 'home', 'actual home tab selected');
  report.results.returnSelection = await nativeReading(app, fixture, paneId, 'select'); report.actions.push('ordinary return-to-workbench button and exact existing reading tab selection');
  await sleep(700);
  const returned = await nativeReading(app, fixture, paneId), savedReturned = await wait(() => navigation(fixture, paneId), value => value?.activePaneId === paneId, 'actual original reading tab active');
  report.results.afterTabRoundTrip = { observation: returned, navigation: savedReturned, comparison: compareAnchor(baseline, returned, savedBefore, savedReturned) };
  report.currentStep = 'verify-original-generated-files-and-management-state';
  await verifyResources(fixture); const after = stored(fixture);
  for (const key of ['sources', 'connections', 'localRoots', 'ignoredLocalPaths']) assert.deepEqual(after.state[key], fixture.originalState[key]);
  assert.equal(after.state.skills.length, 2);
  for (const skill of fixture.originalState.skills) { const actual = after.state.skills.find(item => item.id === skill.id); for (const key of ['id', 'name', 'localPath', 'runtimeFiles', 'localHashes', 'favorite']) assert.deepEqual(actual[key], skill[key]); }
  assert.deepEqual(after.tasks.filter(task => /^(scan_local|register_|apply_|preview_resource_|grant_|run_resource|import_configuration)/.test(task.action)), []);
  report.results.originalResourceFilesAndRecordsUnchanged = true;
  await app.call('screenshot', { path: join(fixture.root, 'native-reading.png') }); report.screenshot = join(fixture.root, 'native-reading.png');
  report.currentStep = 'quit-normally'; report.normalExit = (await app.quit()).driverReport.closedNormally; app = null; report.status = 'passed-native-local-reading-anchor-scope';
} catch (error) {
  report.status = 'failed-or-blocked'; report.error = String(error); report.errorStack = error.stack; process.exitCode = 1;
  if (app) { try { const path = join(fixture.root, 'native-reading-failure.png'); await app.call('screenshot', { path }); report.failureScreenshot = path; } catch (captureError) { report.failureScreenshotError = String(captureError); } }
} finally {
  if (app) { try { report.normalExit = (await app.quit()).driverReport.closedNormally; } catch (error) { report.normalExitError = String(error); report.status = 'failed-or-blocked'; process.exitCode = 1; } }
  try {
    report.harnessAfter = await Promise.all(report.harness.map(async item => ({ name: item.name, sha256: await digest(fileURLToPath(new URL(item.name, import.meta.url))) })));
    report.harnessChanged = report.harnessAfter.some((item, index) => item.sha256 !== report.harness[index].sha256);
    report.candidateAfter = { sha256: await digest(executable), buildInfoSha256: await digest(buildInfoPath) };
    assert.equal(report.harnessChanged, false, 'The reading harness changed during acceptance.');
    assert.equal(report.candidateAfter.sha256, report.candidate.sha256, 'The accepted executable changed during acceptance.');
    assert.equal(report.candidateAfter.buildInfoSha256, report.candidate.buildInfoSha256, 'The candidate build information changed during acceptance.');
  } catch (error) { report.integrityError = String(error); report.status = 'failed-or-blocked'; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString(); await writeFile(reportPath, json(report)); console.log(JSON.stringify({ status: report.status, report: reportPath, normalExit: report.normalExit || false, error: report.error || null }));
}
