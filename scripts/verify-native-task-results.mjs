import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { NativeUiaSession } from './native-uia-client.mjs';

// Consume a completed native export. This script never creates an export receipt,
// edits task history, or runs export_configuration to make the fixture pass.
const FORMAT = 'agent-resource-manager-native-task-results-v1';
const CONFIGURATION_FORMAT = 'agent-resource-manager-native-configuration-v1';
const validation = 'D:\\03_github_projects\\Agent_Management\\Agent_Resource_Manager\\validation';
const dataParent = join(validation, 'manager-data');
const resourceParent = join(validation, 'resources');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, flag, index, all) => flag.startsWith('--') ? [...pairs, [flag.slice(2), all[index + 1]]] : pairs, []));
if (process.argv.includes('--help')) {
  console.log('Run only after a real native configuration export has completed: --phase run --prepared <configuration dataset.json> --configuration-report <configuration-result.json> --candidate <release.exe> --candidate-build-info <json> [--open-system-results true|false]. The optional system-opening flag defaults to false and accepts only exact true/false. It clicks the real Open Result and Open Folder buttons only after missing-path recovery, observes completion without UI errors, and leaves all external windows open. Direct opened/path responses and default-viewer rendering are not observed. The default performs history/path/revalidation/missing-path checks only. No export replay, DB write, clipboard, download, cleanup or forced process termination.');
  process.exit(0);
}
assert.equal(args.phase, 'run', 'Only --phase run is supported. A real completed native export is required.');
assert.equal(process.platform, 'win32');
assert.ok(args['open-system-results'] === undefined || ['true', 'false'].includes(args['open-system-results']), '--open-system-results must be an explicit true or false.');
const openSystemResults = args['open-system-results'] === 'true';
const execute = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = async path => hash(await readFile(path));
const json = value => JSON.stringify(value, null, 2) + '\n';
const normalized = path => resolve(path.replace(/^\\\\\?\\(?=[a-z]:\\)/i, ''));
const same = (left, right) => normalized(left).toLowerCase() === normalized(right).toLowerCase();
const inside = (path, root) => { const part = relative(normalized(root), normalized(path)); return part === '' || !part.startsWith('..') && !isAbsolute(part); };
const sleep = ms => new Promise(done => setTimeout(done, ms));
const limitations = [
  'Existing real native export receipt and task-history/result-view behavior only; not complete-plan, full configuration transfer, performance or actual OS-opening acceptance.',
  'History is reached through the persistent Dashboard All Records entry. The sidebar operation-summary popup is not covered by this result-file workflow.',
  openSystemResults ? 'Explicit optional system opening invokes the actual result/folder buttons only after restoring the export. Completion is observed through enabled controls and empty UI alerts, not a captured opened/path response or a new task receipt. No external window is closed.' : 'System opening was not requested. Open-result and open-folder buttons are observed but never invoked; no Explorer or default viewer is claimed verified.',
  'task_open_result is a direct GUI control request, not a recorded task. Its opened/path return value is not exposed to this observer; no synthetic receipt or MCP bypass is used. Default-viewer rendering remains unverified.',
  'The generated export alone is renamed within its existing exports directory using MoveFileW without replacement, then restored in finally. No copy, backup or deletion is used.',
  'Available/missing UI evidence is the exact displayed path, reason and enabled buttons. No unexposed task_result_files response is fabricated.',
  'Error-region observation uses native UIA COM CurrentAriaRole and GetCurrentPropertyValueEx through pre-existing generated bindings. The missing-path phase must positively expose its actual reason in a native alert region before the workflow can pass. No Windows-MCP service or managed-property fallback is used.',
  'Persistent history and live task receipts are read-only observations. Navigation may save its normal workspace state; business data and generated resources must remain unchanged.',
];

async function absent(path) {
  await assert.rejects(lstat(path), error => error.code === 'ENOENT', `The rename destination must be unused: ${path}`);
}
async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function directPath(path, file = false) {
  assert.ok(same(await realpath(path), path), 'A generated path may not be redirected.');
  for (let part = resolve(path); ; part = dirname(part)) {
    assert.equal((await lstat(part)).isSymbolicLink(), false, 'A generated path may not traverse a link.');
    if (dirname(part) === part) break;
  }
  const info = await lstat(path, { bigint: true });
  assert.equal(file ? info.isFile() : info.isDirectory(), true);
  return { device: String(info.dev), inode: String(info.ino), bytes: String(info.size), modifiedNs: String(info.mtimeNs) };
}
function stored(profile) {
  const db = new DatabaseSync(profile.dbPath, { readOnly: true });
  try {
    const state = JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload);
    const annotations = db.prepare('SELECT skill_id,revision,alias,notes FROM skill_annotations ORDER BY skill_id').all().map(row => ({ ...row }));
    const history = db.prepare('SELECT payload FROM task_history ORDER BY id').all().map(row => JSON.parse(row.payload));
    return { state, annotations, history };
  } finally { db.close(); }
}
async function candidate() {
  assert.equal(typeof args.candidate, 'string'); assert.equal(typeof args['candidate-build-info'], 'string');
  const path = resolve(args.candidate), buildInfoPath = resolve(args['candidate-build-info']);
  assert.equal(basename(path).toLowerCase(), 'agent-resource-manager.exe');
  const bytes = await readFile(path), pe = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.readUInt16LE(0), 0x5a4d); assert.equal(bytes.readUInt32LE(pe), 0x4550); assert.equal(bytes.readUInt16LE(pe + 4), 0x8664);
  const sha256 = hash(bytes), info = JSON.parse(await readFile(buildInfoPath, 'utf8'));
  assert.equal(info.buildMode, 'release'); assert.equal((info.executableSha256 || info.sha256)?.toLowerCase(), sha256);
  assert.ok(info.sourceIdentity || info.sourceCommit);
  return { path, sha256, buildInfoPath, buildInfoSha256: await digest(buildInfoPath), sourceIdentity: info.sourceIdentity || info.sourceCommit };
}
async function resourcesUnchanged(fixture) {
  for (const file of fixture.sourceFiles) {
    assert.ok(inside(file.path, fixture.resourcesRoot)); await directPath(file.path, true);
    assert.equal(await digest(file.path), file.sha256, 'Generated resource contents changed.');
  }
}
async function input(info) {
  assert.equal(typeof args.prepared, 'string'); assert.equal(typeof args['configuration-report'], 'string');
  const descriptor = resolve(args.prepared), receiptPath = resolve(args['configuration-report']);
  assert.equal(basename(descriptor), 'dataset.json'); assert.ok(inside(descriptor, dataParent));
  const fixture = JSON.parse(await readFile(descriptor, 'utf8'));
  assert.equal(fixture.format, CONFIGURATION_FORMAT); assert.equal(fixture.syntheticOnly, true);
  assert.ok(same(dirname(descriptor), fixture.root) && inside(fixture.root, dataParent) && inside(fixture.resourcesRoot, resourceParent));
  assert.ok(same(receiptPath, join(fixture.root, 'configuration-result.json')));
  assert.ok(same(fixture.exportsRoot, join(fixture.root, 'exports')) && same(fixture.exportPath, join(fixture.exportsRoot, 'native-manager-config.json')));
  const profile = fixture.profiles.source;
  assert.equal(profile.role, 'source'); assert.equal(profile.skillCount, 2); assert.equal(profile.toolCount, 0);
  assert.ok(same(profile.root, join(fixture.root, 'source')) && same(profile.dataDir, join(profile.root, 'data')) && same(profile.dbPath, join(profile.dataDir, 'manager.sqlite3')));
  for (const path of [fixture.root, fixture.resourcesRoot, fixture.exportsRoot, profile.root, profile.dataDir]) await directPath(path);
  await directPath(profile.dbPath, true);
  const owner = JSON.parse(await readFile(join(fixture.root, 'fixture-owner.json'), 'utf8'));
  const profileOwner = JSON.parse(await readFile(join(profile.root, 'fixture-owner.json'), 'utf8'));
  assert.equal(owner.format, CONFIGURATION_FORMAT); assert.equal(owner.syntheticOnly, true);
  assert.equal(profileOwner.configurationFormat, CONFIGURATION_FORMAT); assert.equal(profileOwner.syntheticOnly, true); assert.equal(profileOwner.role, 'source');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  assert.equal(receipt.format, CONFIGURATION_FORMAT); assert.equal(receipt.syntheticOnly, true);
  assert.ok(same(receipt.fixture, descriptor)); assert.equal(receipt.candidate.sha256, info.sha256); assert.equal(receipt.sourceNormalExit, true);
  const exported = receipt.results.export;
  assert.equal(exported.realNativeSaveDialog, true); assert.equal(exported.exactPreviewDocumentWritten, true);
  assert.ok(same(exported.path, fixture.exportPath));
  const exportIdentity = await directPath(fixture.exportPath, true), exportBytes = await readFile(fixture.exportPath);
  assert.equal(hash(exportBytes), exported.sha256); assert.equal(exportBytes.length, exported.bytes);
  assert.equal(JSON.parse(exportBytes.toString('utf8')).format, 'agent-resource-manager-config');
  const action = receipt.actions.filter(item => item.action === 'export_configuration');
  assert.equal(action.length, 1, 'One real completed export task is required.'); assert.equal(action[0].status, 'succeeded');
  const before = stored(profile), completed = before.history.filter(item => item.id === action[0].taskId);
  assert.equal(completed.length, 1); const task = completed[0];
  assert.equal(task.action, 'export_configuration'); assert.equal(task.status, 'succeeded'); assert.notEqual(task.hidden, true);
  assert.equal(task.resultFiles.length, 1); const output = task.resultFiles[0];
  assert.equal(output.label, '配置导出文件'); assert.ok(same(output.path, fixture.exportPath)); assert.equal(output.bytes, exported.bytes); assert.equal(typeof output.id, 'string');
  assert.equal(before.history.filter(item => item.action === task.action && item.label === task.label).length, 1, 'The history label must identify this export uniquely.');
  await resourcesUnchanged(fixture);
  return { fixture, profile, receiptPath, receiptSha256: await digest(receiptPath), task, output, exported, exportIdentity, before };
}
async function wait(read, accepts, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) { const value = await read(); if (accepts(value)) return value; assert.ok(Date.now() < deadline, `${description} did not become ready. No action was replayed.`); await sleep(100); }
}
async function powershell(source, temporary) {
  try {
    const { stdout } = await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { windowsHide: true, timeout: 25000, maxBuffer: 256 * 1024, env: { ...process.env, TEMP: temporary, TMP: temporary } });
    return JSON.parse(stdout.trim());
  } catch (error) { throw new Error(`Owned native result observation failed. ${String(error.stderr || error.message).slice(-1400)}`); }
}
async function interfaceState(app, operation, temporary, expectedLabel) {
  assert.ok(['home', 'home-ready', 'history-scope', 'history-ready', 'inspect-history', 'read-results'].includes(operation));
  if (operation === 'read-results') {
    const observer = fileURLToPath(new URL('observe-native-result-errors.py', import.meta.url));
    const python = 'D:\\03_github_projects\\Desktop_Automation\\Windows-MCP\\.venv\\Scripts\\python.exe';
    try {
      const { stdout } = await execute(python, ['-B', observer, '--pid', String(app.identity.pid), '--creation-file-time', String(app.identity.creationFileTime), '--window-handle', String(app.identity.windowHandle)], {
        windowsHide: true,
        timeout: 25000,
        maxBuffer: 256 * 1024,
        env: { ...process.env, TEMP: temporary, TMP: temporary, PYTHONDONTWRITEBYTECODE: '1' },
      });
      const observed = JSON.parse(stdout.trim());
      report.lastObservation = { operation, observedAt: new Date().toISOString(), value: observed };
      return observed;
    } catch (error) {
      throw new Error(`Owned native COM result observation failed. ${String(error.stderr || error.message).slice(-1800)}`);
    }
  }
  if (['history-ready', 'inspect-history'].includes(operation)) {
    assert.equal(typeof expectedLabel, 'string', 'History observation requires the recorded task label.');
    assert.ok(expectedLabel.length > 0 && expectedLabel.length <= 512 && !expectedLabel.includes('\0'), 'The recorded history label must be bounded and nonempty.');
  }
  const payload = Buffer.from(JSON.stringify({ pid: app.identity.pid, created: app.identity.creationFileTime, handle: app.identity.windowHandle, operation, expectedLabel })).toString('base64');
  const observed = await powershell(`$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json
function Assert-Owned {
  $process=Get-Process -Id $p.pid
  if($process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne $p.created){throw 'Owned process identity changed.'}
  if($root.Current.ProcessId -ne $p.pid -or $root.Current.NativeWindowHandle -ne $p.handle){throw 'Owned window identity changed.'}
}
$root=[Windows.Automation.AutomationElement]::FromHandle([IntPtr]([long]$p.handle));Assert-Owned
function Named($within,$name,$type) {
  $condition=[Windows.Automation.AndCondition]::new([Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,$name),[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,$type))
  return $within.FindAll([Windows.Automation.TreeScope]::Descendants,$condition)
}
if($p.operation -in @('home','home-ready')){
  $tabs=@($root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::TabItem))|Where-Object {$_.Current.Name -eq '工作台' -or $_.Current.Name.StartsWith('工作台 ')})
  if($tabs.Count -ne 1 -or -not $tabs[0].Current.IsEnabled){
    if($p.operation -eq 'home'){throw 'The exact home tab is unavailable.'}
    [pscustomobject]@{homeSelected=$false;matchingTabs=$tabs.Count}|ConvertTo-Json -Compress;exit
  }
  Assert-Owned
  $selection=$tabs[0].GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)
  if($p.operation -eq 'home'){$selection.Select()}
  [pscustomobject]@{homeSelected=$selection.Current.IsSelected}|ConvertTo-Json -Compress;exit
}
$isHistory=$p.operation -in @('history-scope','history-ready','inspect-history');$scopeName=$(if($isHistory){'操作记录'}else{'结果文件'});$anchor=$(if($isHistory){'搜索操作记录'}else{'重新核对位置'});$anchorType=$(if($isHistory){[Windows.Automation.ControlType]::Edit}else{[Windows.Automation.ControlType]::Button})
$scopes=@($root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,$scopeName))|Where-Object {(Named $_ $anchor $anchorType).Count -eq 1})
if($scopes.Count -ne 1){[pscustomobject]@{ready=$false;scopeMatches=$scopes.Count}|ConvertTo-Json -Compress;exit}
$scope=$scopes[0]
if($isHistory){
  $search=Named $scope '搜索操作记录' ([Windows.Automation.ControlType]::Edit)
  $scopeReady=$search.Count -eq 1 -and $search[0].Current.IsEnabled
  if($p.operation -eq 'history-scope'){[pscustomobject]@{ready=$scopeReady;scopeReady=$scopeReady}|ConvertTo-Json -Compress;exit}
  if([string]::IsNullOrEmpty([string]$p.expectedLabel)){throw 'History matching requires the completed receipt label.'}
  $queryMatches=$false;$historyQueryValue=$null;$historyQueryPattern=$null
  $expectedTaskLabel=[string]$p.expectedLabel
  if($scopeReady){
    $historyQueryPattern=$search[0].GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
    $historyQueryValue=[string]$historyQueryPattern.Current.Value
    $queryMatches=$historyQueryValue -eq $expectedTaskLabel
  }
  $labels=$scope.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,[string]$p.expectedLabel))
  $buttons=Named $scope '查看结果' ([Windows.Automation.ControlType]::Button)
  $ready=$scopeReady -and $queryMatches -and $labels.Count -gt 0 -and $buttons.Count -eq 1 -and $buttons[0].Current.IsEnabled
  $snapshot=[ordered]@{ready=$ready;scopeReady=$scopeReady;queryMatchesExpected=$queryMatches;expectedLabelObserved=$labels.Count -gt 0;inspectableResultCount=$buttons.Count;inspectedOneHistoryResult=$false;expectedQuery=$expectedTaskLabel;observedQuery=$(if($null -ne $historyQueryValue){$historyQueryValue.Substring(0,[Math]::Min(512,$historyQueryValue.Length))}else{$null});observedQueryLength=$(if($null -ne $historyQueryValue){$historyQueryValue.Length}else{$null});historyScopeOffscreen=$scope.Current.IsOffscreen}
  if($scopeReady){$snapshot.searchField=[ordered]@{name=$search[0].Current.Name;type=$search[0].Current.ControlType.ProgrammaticName;automationId=$search[0].Current.AutomationId;bounds=$search[0].Current.BoundingRectangle.ToString();offscreen=$search[0].Current.IsOffscreen;focused=$search[0].Current.HasKeyboardFocus;valuePatternType=$historyQueryPattern.GetType().FullName}}
  if($p.operation -eq 'inspect-history' -and $ready){
    Assert-Owned
    $queryImmediatelyBeforeInvoke=[string]$historyQueryPattern.Current.Value
    if($queryImmediatelyBeforeInvoke -eq $expectedTaskLabel){
      $buttons[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
      $snapshot.inspectedOneHistoryResult=$true
    }else{
      $snapshot.ready=$false;$snapshot.queryMatchesExpected=$false;$snapshot.queryChangedBeforeInvocation=$true
      $snapshot.observedQuery=$queryImmediatelyBeforeInvoke.Substring(0,[Math]::Min(512,$queryImmediatelyBeforeInvoke.Length));$snapshot.observedQueryLength=$queryImmediatelyBeforeInvoke.Length
    }
  }
  [pscustomobject]$snapshot|ConvertTo-Json -Compress;exit
}
throw 'Result observation must use the dedicated native COM observer.'`, temporary);
  report.lastObservation = { operation, observedAt: new Date().toISOString(), value: observed };
  return observed;
}
async function matchingExplorerWindows(path, temporary) {
  const payload = Buffer.from(JSON.stringify({ path })).toString('base64');
  return powershell(`$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json
$expected=[IO.Path]::GetFullPath($p.path).TrimEnd([char]92)
$shell=$null;$windows=$null;$matching=[Collections.Generic.List[long]]::new()
try{
  $shell=New-Object -ComObject Shell.Application;$windows=$shell.Windows()
  foreach($window in $windows){
    try{
      $uri=[Uri]([string]$window.LocationURL)
      if($uri.IsAbsoluteUri -and $uri.IsFile -and [IO.Path]::GetFullPath($uri.LocalPath).TrimEnd([char]92).Equals($expected,[StringComparison]::OrdinalIgnoreCase)){$matching.Add([long]$window.HWND)}
    }catch{ }
  }
  [pscustomobject]@{matched=$matching.Count -gt 0;matchingWindowIds=@($matching|Sort-Object -Unique);otherWindowDetailsRecorded=$false}|ConvertTo-Json -Depth 3 -Compress
}finally{
  if($null -ne $windows){[void][Runtime.InteropServices.Marshal]::ReleaseComObject($windows)}
  if($null -ne $shell){[void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)}
}`, temporary);
}
async function moveWithoutReplacement(from, to, temporary) {
  const payload = Buffer.from(JSON.stringify({ from, to })).toString('base64');
  return powershell(`$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class NativeResultRename{[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool MoveFile(string oldPath,string newPath);}'
$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json
if(Test-Path -LiteralPath $p.to){throw 'Rename destination exists; no replacement is permitted.'}
if(-not [NativeResultRename]::MoveFile($p.from,$p.to)){throw ('MoveFile without replacement failed: '+[Runtime.InteropServices.Marshal]::GetLastWin32Error())}
[pscustomobject]@{renamed=$true;overwrite=$false}|ConvertTo-Json -Compress`, temporary);
}
function button(snapshot, name) {
  const matches = snapshot.buttons.filter(item => item.name === name); assert.equal(matches.length, 1, `Result button is ambiguous: ${name}`); return matches[0];
}
function resultView(snapshot, path, missing) {
  if (!snapshot?.ready) return false;
  assert.equal(snapshot.alertObservation?.observer, 'native-uia-com', 'The result error detector must use the owned native COM observer.');
  assert.equal(snapshot.alertObservation.propertyId, 30101, 'The result error detector must use the observed native ARIA-role property.');
  assert.ok(snapshot.alertObservation.supportedElements > 0, 'The result provider must expose a supported error-region observation.');
  const text = [...snapshot.names, snapshot.text].join('\n');
  return text.includes(path) && snapshot.names.includes('配置导出文件')
    && button(snapshot, '打开结果').enabled === !missing
    && button(snapshot, '打开所在目录').enabled
    && button(snapshot, '重新核对位置').enabled
    && !snapshot.names.includes('正在处理…')
    && (missing ? text.includes('结果位置已不存在') && snapshot.alerts.some(value => value?.includes('结果位置已不存在')) : snapshot.alerts.length === 0 && !text.includes('结果位置已不存在'));
}
async function exportIds(app) {
  return (await app.call('tasks')).tasks.filter(item => item.action === 'export_configuration').map(item => item.id).sort();
}

const info = await candidate(), input_ = await input(info);
const { fixture, profile, task, output, exported, before, exportIdentity } = input_;
const root = await mkdtemp(join(fixture.root, 'task-results-')), temporary = join(root, 'driver-temp'); await mkdir(temporary);
const reportPath = join(root, 'task-results-result.json');
const heldPath = join(fixture.exportsRoot, `${basename(fixture.exportPath)}.native-missing-${randomUUID()}`);
const harnessNames = ['verify-native-task-results.mjs', 'observe-native-result-errors.py', 'native-uia-client.mjs', 'verify-native-uia.ps1'];
const report = { format: FORMAT, status: 'running', syntheticOnly: true, startedAt: new Date().toISOString(), candidate: info, fixture: resolve(args.prepared), sourceReceipt: { path: input_.receiptPath, sha256: input_.receiptSha256, taskId: task.id, action: task.action, resultId: output.id, pathRecordedByCompletedTask: output.path, exportSha256: exported.sha256 }, limitations, results: {}, osOpening: { requested: openSystemResults, openedResponseDirectlyObserved: false, defaultViewerRenderingVerified: false, closedExternalWindows: [], operations: [] }, rename: { source: fixture.exportPath, temporary: heldPath, method: 'MoveFileW-no-replacement', copied: false, deleted: false, restored: false } };
let app, renameAttempted = false;
async function step(name, action) {
  report.lastStep = name; await writeFile(reportPath, json(report));
  return action();
}
try {
  report.harness = await Promise.all(harnessNames.map(async name => ({ name, sha256: await digest(fileURLToPath(new URL(name, import.meta.url))) })));
  await writeFile(reportPath, json(report), { flag: 'wx' });
  app = await step('launch-recorded-export-source', () => NativeUiaSession.launch({ executable: info.path, dataDir: profile.dataDir, reportPath: join(root, 'native-driver.json'), sha256: info.sha256, accessibilityInput: true, workbenchOnlyReadiness: true }));
  report.native = app.identity;
  assert.equal(app.identity.executableSha256, info.sha256); assert.ok(same(app.identity.dataDirectory, profile.dataDir));
  const live = (await app.call('task', { taskId: task.id })).task;
  assert.equal(live.action, 'export_configuration'); assert.equal(live.status, 'succeeded'); assert.deepEqual(live.resultFiles, task.resultFiles);
  const originalExportIds = await exportIds(app); assert.ok(originalExportIds.includes(task.id));
  await step('select-home-once', () => interfaceState(app, 'home', temporary));
  await step('observe-home-selection', () => wait(() => interfaceState(app, 'home-ready', temporary), value => value.homeSelected === true, 'Selected home tab'));
  await step('open-dashboard-once', () => app.call('invokeName', { name: '总览', scope: '主要导航' }));
  await step('open-persistent-history-once', () => app.call('invokeName', { name: '全部记录', scope: '近期操作' }));
  await step('observe-history-search-ready', () => wait(() => interfaceState(app, 'history-scope', temporary), value => value.ready === true, 'History search scope'));
  await step('filter-history-by-recorded-label-once', () => app.call('setField', { name: '搜索操作记录', value: task.label }));
  await step('observe-exact-filtered-history-entry', () => wait(() => interfaceState(app, 'history-ready', temporary, task.label), value => value.ready === true, 'Unique filtered completed export history entry'));
  // Not-ready observations perform no invocation. Once Invoke is attempted,
  // transport errors propagate immediately and are never retried by wait.
  const inspected = await step('inspect-filtered-history-result', () => wait(() => interfaceState(app, 'inspect-history', temporary, task.label), value => value.inspectedOneHistoryResult === true, 'Exact history result invocation'));
  assert.equal(inspected.inspectedOneHistoryResult, true, 'The exact recorded export history entry was not invoked.');
  const available = await step('observe-available-export-result', () => wait(() => interfaceState(app, 'read-results', temporary), value => resultView(value, output.path, false), 'Exact available exported result'));
  report.results.history = { entry: ['主要导航', '总览', '近期操作', '全部记录'], selectedRecordedTaskId: task.id, liveCompletedReceiptMatched: true, uniqueFilteredHistoryResult: true, operationSummaryPopupVerified: false };
  report.results.available = { exactPath: output.path, label: '配置导出文件', openResultEnabled: button(available, '打开结果').enabled, openFolderEnabled: button(available, '打开所在目录').enabled, reasonMissing: false };
  await step('revalidate-available-result-once', () => app.call('invokeName', { name: '重新核对位置', scope: '结果文件' }));
  await step('observe-revalidated-available-result', () => wait(() => interfaceState(app, 'read-results', temporary), value => resultView(value, output.path, false), 'Available result revalidation'));
  assert.deepEqual(await exportIds(app), originalExportIds, 'Viewing/revalidating a result started another export.');
  report.results.revalidationWithoutExportReplay = true;
  assert.ok(inside(heldPath, fixture.exportsRoot) && same(dirname(heldPath), fixture.exportsRoot));
  await directPath(fixture.exportsRoot); assert.deepEqual(await directPath(fixture.exportPath, true), exportIdentity);
  assert.equal(await digest(fixture.exportPath), exported.sha256); await absent(heldPath);
  await writeFile(reportPath, json(report));
  // Record intent before the atomic move. A transport failure after MoveFileW
  // succeeds must still enter recovery by inspecting both actual locations.
  renameAttempted = true;
  await step('rename-generated-export-without-replacement', () => moveWithoutReplacement(fixture.exportPath, heldPath, temporary));
  await absent(fixture.exportPath); assert.deepEqual(await directPath(heldPath, true), exportIdentity); assert.equal(await digest(heldPath), exported.sha256);
  await step('revalidate-missing-result-once', () => app.call('invokeName', { name: '重新核对位置', scope: '结果文件' }));
  const missing = await step('observe-missing-result-and-disabled-open', () => wait(() => interfaceState(app, 'read-results', temporary), value => resultView(value, output.path, true), 'Missing result reason and disabled open-result button'));
  report.results.missing = { exactOriginalPathRetained: output.path, reason: '结果位置已不存在', openResultDisabled: !button(missing, '打开结果').enabled, openFolderStillEnabled: button(missing, '打开所在目录').enabled, alertPositiveControl: { ...missing.alertObservation, actualReasonObserved: true } };
  await app.call('screenshot', { path: join(root, 'native-missing-result.png') });
  assert.deepEqual(await exportIds(app), originalExportIds);
  await step('restore-original-export-without-replacement', () => moveWithoutReplacement(heldPath, fixture.exportPath, temporary));
  assert.deepEqual(await directPath(fixture.exportPath, true), exportIdentity); assert.equal(await digest(fixture.exportPath), exported.sha256); await absent(heldPath);
  report.rename.restored = true;
  await step('revalidate-restored-result-once', () => app.call('invokeName', { name: '重新核对位置', scope: '结果文件' }));
  await step('observe-restored-result', () => wait(() => interfaceState(app, 'read-results', temporary), value => resultView(value, output.path, false), 'Restored original result'));
  assert.deepEqual(await exportIds(app), originalExportIds);
  report.results.restoredAvailability = true;
  if (openSystemResults) {
    // External programs can retain a file lock. Finish all rename/recovery work
    // before requesting an OS open and leave every external window untouched.
    for (const [label, folder] of [['打开结果', false], ['打开所在目录', true]]) {
      await directPath(fixture.exportPath, true); assert.equal(await digest(fixture.exportPath), exported.sha256);
      const explorerBefore = folder ? await matchingExplorerWindows(fixture.exportsRoot, temporary) : undefined;
      await step(`invoke-system-open-${folder ? 'folder' : 'result'}-once`, () => app.call('invokeName', { name: label, scope: '结果文件' }));
      const completed = await step(`observe-system-open-${folder ? 'folder' : 'result'}-completion`, () => wait(() => interfaceState(app, 'read-results', temporary), value => resultView(value, output.path, false), `Actual ${label} request completion without a result-section error`));
      assert.equal(completed.alerts.length, 0); assert.deepEqual(await exportIds(app), originalExportIds);
      const operation = { button: label, requestedFolder: folder, expectedPathFromOriginalReceipt: folder ? dirname(output.path) : output.path, actualUiInvocation: true, busyStateEndedAndControlsEnabled: true, resultSectionAlerts: [], noExportReplay: true, rawOpenedResponseObserved: false, viewerRenderingVerified: false };
      if (folder) {
        const deadline = Date.now() + 5000;
        let observed = await matchingExplorerWindows(fixture.exportsRoot, temporary);
        while (!observed.matched && Date.now() < deadline) { await sleep(100); observed = await matchingExplorerWindows(fixture.exportsRoot, temporary); }
        operation.explorer = { exactDirectoryMatched: observed.matched, matchingWindowIds: observed.matchingWindowIds, newMatchingWindowIds: observed.matchingWindowIds.filter(id => !explorerBefore.matchingWindowIds.includes(id)), otherWindowDetailsRecorded: false, windowsClosed: false };
      }
      report.osOpening.operations.push(operation); await writeFile(reportPath, json(report));
    }
  }
  report.normalExit = (await step('normal-native-quit', () => app.quit())).driverReport.closedNormally; app = null; assert.equal(report.normalExit, true);
  const after = stored(profile); assert.deepEqual(after.state, before.state); assert.deepEqual(after.annotations, before.annotations);
  assert.deepEqual(after.history.find(item => item.id === task.id).resultFiles, task.resultFiles);
  assert.deepEqual(after.history.filter(item => item.action === 'export_configuration').map(item => item.id).sort(), before.history.filter(item => item.action === 'export_configuration').map(item => item.id).sort());
  await resourcesUnchanged(fixture); assert.equal(await digest(fixture.exportPath), exported.sha256);
  for (const file of report.harness) assert.equal(await digest(fileURLToPath(new URL(file.name, import.meta.url))), file.sha256, 'A native helper changed during this run.');
  report.results.businessDataResourcesAndOriginalExportPreserved = true;
  report.status = 'passed-native-completed-export-result-history-and-missing-path-only';
} catch (error) {
  report.status = 'failed-or-blocked'; report.error = String(error); report.errorStack = String(error.stack || error).slice(0, 6000); process.exitCode = 1;
} finally {
  if (renameAttempted) {
    try {
      await directPath(fixture.exportsRoot);
      const originalPresent = await exists(fixture.exportPath), heldPresent = await exists(heldPath);
      assert.notEqual(originalPresent, heldPresent, 'The two rename locations are ambiguous. Neither location may be overwritten.');
      if (heldPresent) {
        assert.deepEqual(await directPath(heldPath, true), exportIdentity); assert.equal(await digest(heldPath), exported.sha256);
        await moveWithoutReplacement(heldPath, fixture.exportPath, temporary);
      }
      assert.deepEqual(await directPath(fixture.exportPath, true), exportIdentity);
      assert.equal(await digest(fixture.exportPath), exported.sha256); await absent(heldPath); report.rename.restored = true;
    } catch (error) { report.rename.restoreError = String(error); report.rename.retainedAt = heldPath; report.status = 'failed-or-blocked'; process.exitCode = 1; }
  }
  if (app) {
    try { report.failureNormalExit = (await app.quit()).driverReport.closedNormally; }
    catch (error) { report.failureNormalExit = false; report.closeError = String(error); }
  }
  report.finishedAt = new Date().toISOString(); await writeFile(reportPath, json(report));
}
console.log(JSON.stringify({ status: report.status, report: reportPath, originalExportRestored: report.rename.restored, normalExit: report.normalExit ?? report.failureNormalExit, systemUiOpenOperationsObserved: report.osOpening.operations.length, directOpenedResponseVerified: false, defaultViewerRenderingVerified: false }));
