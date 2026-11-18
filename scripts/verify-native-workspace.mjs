import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { NativeUiaSession } from './native-uia-client.mjs';
import { createPerformanceFixture, FIXTURE_FORMAT } from './performance-fixture.mjs';

const format = 'agent-resource-manager-native-workspace-v1';
const approved = 'D:\\03_github_projects\\Agent_Management\\Agent_Resource_Manager\\validation';
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, index, all) => arg.startsWith('--') ? [...pairs, [arg.slice(2), all[index + 1]]] : pairs, []));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = async path => hash(await readFile(path));
const json = value => JSON.stringify(value, null, 2) + '\n';
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const same = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase();
const inside = (path, root) => { const rel = relative(root, path); return rel === '' || !rel.startsWith('..') && !isAbsolute(rel); };
const sleep = ms => new Promise(done => setTimeout(done, ms));
const execute = promisify(execFile);
const documentMarker = '仅用于隔离的本地性能验收，不调用外部程序，不连接远端。';
const limitations = ['Native semantic button invocation and actual cross-window draft values only; not pointer drag, keyboard shortcuts, IME or performance acceptance.', 'The original document marker is explicitly revealed before and after the draft round trip. This checks content reachability after ordinary scrolling, not reading-anchor or scroll-offset preservation.', 'No preview, scan, directory registration, permission grant, resource execution, installation, database mutation shortcut, clipboard, backup or cleanup is requested.'];

function stored(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const state = JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload);
    const row = db.prepare('SELECT payload FROM workspace_state WHERE id=1').get();
    return { state, workspace: row ? JSON.parse(row.payload) : null };
  } finally { db.close(); }
}
async function wait(read, accepts, description) {
  const started = Date.now(), end = started + 20000;
  let attempts = 0;
  for (;;) { const value = await read(); attempts++; if (accepts(value)) return value; assert.ok(Date.now() < end, `Native workspace observation unavailable: ${description}; ${attempts} observations in ${Date.now() - started} ms; last value ${JSON.stringify(value).slice(0, 2000)}. No action was replayed.`); await sleep(60); }
}
async function invoke(app, name, scope) {
  // Workbench readiness precedes the asynchronously loaded page navigation.
  // Observe the scope without a scoped query until it is actually present.
  if (scope) await wait(() => app.call('state', { name: scope }), rows => {
    const available = list(rows).filter(row => row.enabled && !row.offscreen);
    assert.ok(available.length <= 1, `The exact native observation scope is ambiguous: ${scope}.`);
    return available.length === 1;
  }, `exact observation scope ${scope}`);
  await wait(() => app.call('state', { name, ...(scope ? { scope } : {}) }), rows => list(rows).filter(row => row.type === 'ControlType.Button' && row.enabled && !row.offscreen).length === 1, name);
  await app.call('invokeName', { name, ...(scope ? { scope } : {}) });
}
async function prepare() {
  await mkdir(join(approved, 'manager-data'), { recursive: true });
  const root = await mkdtemp(join(approved, 'manager-data', 'native-workspace-'));
  const dataset = await createPerformanceFixture(root, 'workspace-fixture', 0);
  const fixture = { format, syntheticOnly: true, root, dataset, draftPath: dataset.skillsRoot, initialDatabaseSha256: await digest(dataset.dbPath), createdAt: new Date().toISOString() };
  await writeFile(join(root, 'workspace-fixture.json'), json(fixture), { flag: 'wx' });
  return fixture;
}
async function fixtureAt(path) {
  const descriptor = resolve(path), fixture = JSON.parse(await readFile(descriptor, 'utf8'));
  assert.equal(fixture.format, format); assert.equal(fixture.syntheticOnly, true); assert.ok(same(dirname(descriptor), fixture.root) && inside(fixture.root, join(approved, 'manager-data')));
  const dataset = fixture.dataset; assert.equal(dataset.format, FIXTURE_FORMAT); assert.ok(same(dataset.root, join(fixture.root, 'workspace-fixture'))); assert.ok(same(dataset.dataDir, join(dataset.root, 'data')) && same(dataset.dbPath, join(dataset.dataDir, 'manager.sqlite3')));
  for (const directory of [fixture.root, dataset.root, dataset.dataDir, dataset.skillsRoot]) assert.ok(same(await realpath(directory), directory));
  assert.equal(await digest(dataset.dbPath), fixture.initialDatabaseSha256, 'A previously launched workspace fixture may not be replayed.');
  assert.ok(same(fixture.draftPath, dataset.skillsRoot)); assert.equal(stored(dataset.dbPath).workspace, null);
  const marker = JSON.parse(await readFile(join(dataset.root, 'fixture-owner.json'), 'utf8')); assert.equal(marker.format, FIXTURE_FORMAT); assert.equal(marker.syntheticOnly, true);
  return fixture;
}

// Only the already launched manager's exact windows are inspected. The sole
// secondary-window action is its ordinary "return to main window" button.
async function nativeWindow(app, fixture, mode, { label = 'main', paneId, handle = app.identity.windowHandle } = {}) {
  assert.ok(['read', 'discover', 'return'].includes(mode));
  const payload = Buffer.from(JSON.stringify({ mode, pid: app.identity.pid, created: app.identity.creationFileTime, main: app.identity.windowHandle, handle, label, homeId: `tab-${encodeURIComponent(label === 'main' ? 'home' : `home:${label}`)}`, paneTabId: `tab-${encodeURIComponent(paneId)}` })).toString('base64');
  const command = `
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient;Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;using System.Collections.Generic;using System.Runtime.InteropServices;using System.Text;
public static class WorkspaceWindowOwner {
 delegate bool Visitor(IntPtr h,IntPtr state);
 [DllImport("user32.dll")] static extern bool EnumWindows(Visitor visitor,IntPtr state);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder name,int count);
 public static IntPtr[] Owned(uint expected){List<IntPtr> values=new List<IntPtr>();EnumWindows((h,s)=>{uint pid;GetWindowThreadProcessId(h,out pid);StringBuilder name=new StringBuilder(80);GetClassName(h,name,name.Capacity);if(pid==expected&&IsWindowVisible(h)&&name.ToString()=="Tauri Window")values.Add(h);return true;},IntPtr.Zero);return values.ToArray();}
}
'@
$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json
function Owned { $process=Get-Process -Id $p.pid;if($process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne $p.created){throw 'Owned workspace process identity changed.'};$actual=[uint32]0;[void][WorkspaceWindowOwner]::GetWindowThreadProcessId([IntPtr]([long]$p.main),[ref]$actual);if($actual -ne $p.pid){throw 'Original main-window identity changed.'} }
function Exact($root,$id,$type){$conditions=[Windows.Automation.Condition[]]@([Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty,$id),[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,$type));$found=$root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.AndCondition]::new($conditions));if($found.Count -gt 1){throw 'Exact workspace tab ID is ambiguous.'};if($found.Count -eq 1){return $found[0]};return $null}
$watch=[Diagnostics.Stopwatch]::StartNew();$window=[IntPtr]::Zero;$root=$null;$homeTabElement=$null;$pane=$null;$field=$null
while($watch.ElapsedMilliseconds -lt 15000){
 Owned;$ownedWindowMatches=@()
 foreach($candidate in [WorkspaceWindowOwner]::Owned([uint32]$p.pid)){
  if($p.mode -ne 'discover' -and $candidate.ToInt64() -ne $p.handle){continue};if($p.mode -eq 'discover' -and $candidate.ToInt64() -eq $p.main){continue}
  $candidateRoot=[Windows.Automation.AutomationElement]::FromHandle($candidate)
  $candidateHomeTabElement=Exact $candidateRoot $p.homeId ([Windows.Automation.ControlType]::TabItem);$candidatePane=Exact $candidateRoot $p.paneTabId ([Windows.Automation.ControlType]::TabItem)
  if($null -ne $candidateHomeTabElement -and $null -ne $candidatePane){$ownedWindowMatches+=,@{window=$candidate;root=$candidateRoot;home=$candidateHomeTabElement;pane=$candidatePane}}
 }
 if($ownedWindowMatches.Count -gt 1){throw 'More than one owned native window claims the exact workspace label and pane.'}
 if($ownedWindowMatches.Count -eq 1){
  $match=$ownedWindowMatches[0];$fields=$match.root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.AndCondition]::new([Windows.Automation.Condition[]]@([Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,'本地目录'),[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Edit))))
  if($fields.Count -gt 1){throw 'The exact draft input is ambiguous.'}
  if($fields.Count -eq 1 -and $fields[0].Current.IsEnabled -and -not $fields[0].Current.IsOffscreen){$window=$match.window;$root=$match.root;$homeTabElement=$match.home;$pane=$match.pane;$field=$fields[0];break}
 }
 Start-Sleep -Milliseconds 60
}
if($window -eq [IntPtr]::Zero){throw 'The exact owned workspace label, pane and draft input did not become ready.'}
Owned;if($root.Current.ProcessId -ne $p.pid){throw 'Native workspace root belongs to another process.'}
$selection=$pane.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern);if(-not $selection.Current.IsSelected){throw 'The transferred operation pane is not actually selected.'}
$value=$field.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value
$result=[ordered]@{pid=$p.pid;created=$p.created;window=$window.ToInt64();label=$p.label;labelProofHomeTabId=$homeTabElement.Current.AutomationId;paneTabId=$pane.Current.AutomationId;paneSelected=$true;fieldName=$field.Current.Name;fieldProviderProcessId=$field.Current.ProcessId;fieldValue=$value;fieldBounds=$field.Current.BoundingRectangle.ToString();noForegroundInput=$true;returned=$false}
if($p.mode -eq 'return'){
 $buttons=$root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.AndCondition]::new([Windows.Automation.Condition[]]@([Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,'将当前标签移回主窗口'),[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Button))))
 if($buttons.Count -ne 1 -or -not $buttons[0].Current.IsEnabled -or $buttons[0].Current.IsOffscreen){throw 'The exact owned return-to-main button is not uniquely available.'}
 Owned;$buttons[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke();$result.returned=$true
}
$result|ConvertTo-Json -Depth 5 -Compress`;
  const invocation = ['pwsh.exe', '-NoProfile', '-NonInteractive', '-Command', command];
  assert.ok(invocation.reduce((length, value, index) => length + (index ? 1 : 0) + value.length * 2 + 2, 1) < 32767, 'Native workspace helper command exceeds the bounded Windows invocation size.');
  let stdout;
  try { ({ stdout } = await execute(invocation[0], invocation.slice(1), { windowsHide: true, timeout: 30000, maxBuffer: 128 * 1024, env: { ...process.env, TEMP: join(fixture.dataset.root, 'driver-temp'), TMP: join(fixture.dataset.root, 'driver-temp') } })); }
  catch (error) { throw new Error(`Native workspace ${mode} observation failed. ${String(error.stderr || error.code || 'No error text returned.').slice(-5000)}`); }
  const result = JSON.parse(stdout.trim()); assert.equal(result.pid, app.identity.pid); assert.equal(String(result.created), app.identity.creationFileTime); assert.equal(result.label, label); assert.equal(result.labelProofHomeTabId, `tab-${encodeURIComponent(label === 'main' ? 'home' : `home:${label}`)}`); assert.equal(result.paneTabId, `tab-${encodeURIComponent(paneId)}`); assert.equal(result.paneSelected, true); assert.equal(result.fieldValue, fixture.draftPath);
  if (mode !== 'discover') assert.equal(result.window, handle); else assert.notEqual(result.window, app.identity.windowHandle);
  return result;
}

if (process.argv.includes('--help')) { console.log('Prepare --phase prepare. Run --phase run --fixture <workspace-fixture.json> --candidate <release.exe> --candidate-build-info <json>. Actual semantic UI detach/return, exact owned windows and unsaved synthetic local-directory draft. No reading-anchor or physical-input claim.'); process.exit(0); }
assert.ok(['prepare', 'run'].includes(args.phase), 'Use explicit --phase prepare or --phase run.');
if (args.phase === 'prepare') { const fixture = await prepare(); console.log(JSON.stringify({ status: 'prepared-not-run', fixture: join(fixture.root, 'workspace-fixture.json'), noNativeLaunch: true })); process.exit(0); }
const fixture = await fixtureAt(args.fixture || ''), executable = resolve(args.candidate || ''), infoPath = resolve(args['candidate-build-info'] || ''), info = JSON.parse(await readFile(infoPath, 'utf8'));
assert.equal(basename(executable), 'agent-resource-manager.exe'); assert.equal(info.buildMode, 'release'); assert.equal(await digest(executable), info.executableSha256); assert.ok(info.sourceIdentity || info.sourceCommit);
const reportPath = join(fixture.root, 'workspace-result.json');
const report = { format, status: 'running', syntheticOnly: true, startedAt: new Date().toISOString(), fixture: fixture.root, candidate: { executable, sha256: info.executableSha256, sourceIdentity: info.sourceIdentity || info.sourceCommit }, limitations, actions: [], results: {} };
const original = stored(fixture.dataset.dbPath).state;
report.harness = await Promise.all(['verify-native-workspace.mjs', 'native-uia-client.mjs', 'verify-native-uia.ps1', 'performance-fixture.mjs'].map(async name => ({ name, sha256: await digest(fileURLToPath(new URL(name, import.meta.url))) })));
await writeFile(reportPath, json(report), { flag: 'wx' });
let app;
try {
  report.currentStep = 'launch-native-workbench';
  app = await NativeUiaSession.launch({ executable, sha256: info.executableSha256, dataDir: fixture.dataset.dataDir, reportPath: join(fixture.dataset.root, 'native-driver.json'), accessibilityInput: true, workbenchOnlyReadiness: true }); report.native = app.identity;
  report.currentStep = 'enter-skills-through-main-navigation';
  await invoke(app, 'Skills', '主要导航');
  report.currentStep = 'find-original-skill';
  await wait(() => app.call('state', { name: '搜索 Skill' }), rows => list(rows).filter(row => row.type === 'ControlType.Edit' && row.enabled && !row.offscreen).length === 1, 'loaded Skills search input');
  await app.call('search', { index: 0 });
  report.currentStep = 'open-original-document';
  await app.call('openDocument', { index: 0 });
  report.currentStep = 'reveal-original-document-marker';
  await app.call('reveal', { name: documentMarker });
  const initialMarker = await wait(() => app.call('state', { name: documentMarker }), rows => list(rows).filter(row => row.type === 'ControlType.Text' && !row.offscreen).length === 1, 'original document marker visible after explicit reveal');
  report.results.initialDocumentMarker = list(initialMarker).find(row => row.type === 'ControlType.Text' && !row.offscreen);
  const initialMarkerBounds = report.results.initialDocumentMarker.bounds.split(',').map(Number);
  assert.ok(initialMarkerBounds.length === 4 && initialMarkerBounds.every(Number.isFinite) && initialMarkerBounds[2] > 0 && initialMarkerBounds[3] > 0, 'The initial document marker must have actual positive native bounds.');
  report.currentStep = 'return-to-workbench';
  await app.call('tab', { home: true });
  report.currentStep = 'open-add-skill-menu';
  await invoke(app, '添加 Skill');
  report.currentStep = 'open-local-directory-pane';
  const menu = await wait(() => app.call('names'), rows => list(rows).filter(row => row.type === 'ControlType.Button' && row.name.startsWith('添加本地目录')).length === 1, 'local-directory menu entry');
  await invoke(app, list(menu).find(row => row.type === 'ControlType.Button' && row.name.startsWith('添加本地目录')).name);
  report.currentStep = 'enter-synthetic-local-draft';
  await wait(() => app.call('state', { name: '本地目录' }), rows => list(rows).filter(row => row.type === 'ControlType.Edit' && row.enabled && !row.offscreen).length === 1, 'local-directory draft input');
  await app.call('setField', { name: '本地目录', value: fixture.draftPath });
  report.currentStep = 'observe-local-operation-navigation';
  const before = await wait(() => stored(fixture.dataset.dbPath).workspace, workspace => workspace?.windows?.find(window => window.label === 'main')?.panes?.some(pane => pane.kind === 'operation' && pane.state?.operation === 'local'), 'the actual local operation pane metadata');
  const panes = before.windows.find(window => window.label === 'main').panes.filter(pane => pane.kind === 'operation' && pane.state?.operation === 'local'); assert.equal(panes.length, 1); const paneId = panes[0].id;
  report.currentStep = 'read-main-draft';
  report.results.initialDraft = await nativeWindow(app, fixture, 'read', { paneId });
  report.currentStep = 'detach-draft-through-native-button';
  await invoke(app, '将当前标签移至独立窗口'); report.actions.push('native UI detach button invoked once');
  report.currentStep = 'observe-detached-owner';
  const moved = await wait(() => stored(fixture.dataset.dbPath).workspace, workspace => workspace?.windows?.some(window => window.label !== 'main' && window.panes.some(pane => pane.id === paneId)), 'actual detached workspace ownership');
  const owners = moved.windows.filter(window => window.panes.some(pane => pane.id === paneId)); assert.equal(owners.length, 1); const label = owners[0].label; assert.match(label, /^workspace-[a-f0-9-]{36}$/);
  report.currentStep = 'read-detached-draft';
  const detached = await nativeWindow(app, fixture, 'discover', { label, paneId }); report.results.detachedDraft = detached;
  report.currentStep = 'return-draft-through-secondary-native-button';
  report.results.returnInvocation = await nativeWindow(app, fixture, 'return', { label, paneId, handle: detached.window }); report.actions.push('exact secondary window return button invoked once');
  report.currentStep = 'observe-returned-owner';
  await wait(() => stored(fixture.dataset.dbPath).workspace, workspace => { const owners = workspace?.windows?.filter(window => window.panes.some(pane => pane.id === paneId)) || []; return owners.length === 1 && owners[0].label === 'main'; }, 'actual pane returned to main');
  report.currentStep = 'read-returned-main-draft';
  report.results.returnedDraft = await nativeWindow(app, fixture, 'read', { paneId });
  report.currentStep = 'close-local-draft';
  await invoke(app, '关闭 添加本地 Skill');
  report.currentStep = 'restore-original-document';
  await app.call('selectTab', { name: 'Perf Skill 0000' });
  report.currentStep = 'reveal-returned-document-marker';
  await app.call('reveal', { name: documentMarker });
  const returnedMarker = await wait(() => app.call('state', { name: documentMarker }), rows => list(rows).filter(row => row.type === 'ControlType.Text' && !row.offscreen).length === 1, 'returned document marker visible after explicit reveal');
  const returnedMarkerObservation = list(returnedMarker).find(row => row.type === 'ControlType.Text' && !row.offscreen);
  const returnedMarkerBounds = returnedMarkerObservation.bounds.split(',').map(Number);
  assert.ok(returnedMarkerBounds.length === 4 && returnedMarkerBounds.every(Number.isFinite) && returnedMarkerBounds[2] > 0 && returnedMarkerBounds[3] > 0, 'The returned document marker must have actual positive native bounds.');
  report.results.documentContext = { originalSkillTabAndDocumentReachableAgain: true, explicitRevealBeforeAndAfter: true, markerObservation: returnedMarkerObservation, readingAnchorVerified: false, scrollOffsetPreservationVerified: false };
  report.currentStep = 'verify-resource-state-unchanged';
  const tasks = (await app.call('tasks')).tasks; const prohibited = tasks.filter(task => /^(scan_local|register_|apply_|preview_resource_|grant_|run_resource|import_configuration)/.test(task.action)); assert.deepEqual(prohibited, []); report.results.noResourceMutationTasks = true;
  const after = stored(fixture.dataset.dbPath).state; assert.equal(after.skills.length, original.skills.length); assert.deepEqual(after.localRoots, original.localRoots); assert.deepEqual(after.sources, original.sources); assert.deepEqual(after.connections, original.connections);
  for (const skill of original.skills) { const actual = after.skills.find(item => item.id === skill.id); for (const key of ['name', 'localPath', 'runtimeFiles', 'localHashes', 'favorite', 'categoryId']) assert.deepEqual(actual[key], skill[key]); assert.equal(await digest(join(skill.localPath, 'SKILL.md')), skill.localHashes['SKILL.md']); }
  report.results.allGeneratedSkillFilesUnchanged = true;
  report.currentStep = 'quit-normally';
  report.normalExit = (await app.quit()).driverReport.closedNormally; app = null; report.status = 'passed-native-cross-window-draft-scope';
} catch (error) { report.status = 'failed-or-blocked'; report.error = String(error); report.errorStack = error.stack; process.exitCode = 1; }
finally { if (app) { try { report.normalExit = (await app.quit()).driverReport.closedNormally; } catch (error) { report.normalExitError = String(error); report.status = 'failed-or-blocked'; process.exitCode = 1; } } report.finishedAt = new Date().toISOString(); await writeFile(reportPath, json(report)); console.log(JSON.stringify({ status: report.status, report: reportPath, normalExit: report.normalExit || false, error: report.error || null })); }
