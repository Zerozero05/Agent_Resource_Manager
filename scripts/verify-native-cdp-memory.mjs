import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createPerformanceFixture, FIXTURE_FORMAT } from './performance-fixture.mjs';
import { assertNoUserManager } from './native-uia-client.mjs';

const format = 'agent-resource-manager-cdp-memory-v1';
const approved = 'D:\\03_github_projects\\Agent_Management\\Agent_Resource_Manager\\validation\\manager-data';
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, flag, index, all) => flag.startsWith('--') ? [...pairs, [flag.slice(2), all[index + 1]]] : pairs, []));
const cycleIntervalMs = args['cycle-interval-ms'] === undefined ? 1000 : Number(args['cycle-interval-ms']);
assert.ok(Number.isInteger(cycleIntervalMs) && cycleIntervalMs >= 1000 && cycleIntervalMs <= 10000, 'Diagnostic cycle cadence must be 1000–10000 milliseconds.');
assert.ok(!process.argv.includes('--uia-observer') || ['read-only', 'read-only-detach'].includes(args['uia-observer']), 'UIA observation requires explicit --uia-observer read-only or read-only-detach.');
const uiaObserverRequested = args['uia-observer'] !== undefined;
const detachObserverAfterIdle = args['uia-observer'] === 'read-only-detach';
const policy = { cycleCount: 40, cycleIntervalMs, settleMs: 5000, idleMs: 10000, ...(uiaObserverRequested ? { uiaObserver: 'read-only-owned-window' } : {}), ...(detachObserverAfterIdle ? { observerDetach: { after: 'original-two-idle-samples', sampleOffsetsMs: [0, 10000, 20000] } } : {}) };
const json = value => JSON.stringify(value, null, 2) + '\n';
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const sleep = ms => new Promise(done => setTimeout(done, Math.max(0, ms)));
const execute = promisify(execFile);
const samePath = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase();
const inside = (path, parent) => { const part = relative(parent, path); return part !== '' && !part.startsWith('..') && !isAbsolute(part); };
const ps = text => "'" + String(text).replaceAll("'", "''") + "'";
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];

async function runtimeFiles(dataset) {
  const files = [];
  for (const [root, count, prefix, width, name] of [[dataset.skillsRoot, 1000, 'perf-skill-', 4, 'SKILL.md'], [dataset.toolsRoot, 100, 'perf-tool-', 3, 'README.md']]) {
    for (let index = 0; index < count; index++) {
      const path = join(root, prefix + String(index).padStart(width, '0'), name);
      assert.ok(samePath(await realpath(path), path), 'Synthetic runtime files must resolve in place.');
      files.push({ path, sha256: await digest(path) });
    }
  }
  return files;
}

function stored(dataset) {
  const db = new DatabaseSync(dataset.dbPath, { readOnly: true });
  try {
    const state = JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload);
    return { settings: state.settings, sources: state.sources, connections: state.connections, localRoots: state.localRoots, categories: state.categories,
      skills: state.skills.map(skill => Object.fromEntries(['id', 'name', 'displayName', 'localPath', 'version', 'favorite', 'categoryId', 'localHashes', 'runtimeFiles'].map(key => [key, skill[key]]))),
      resources: db.prepare('SELECT id,revision,payload FROM resource_catalog ORDER BY id').all(),
      tasks: db.prepare("SELECT json_extract(payload,'$.id') AS id,json_extract(payload,'$.action') AS action,json_extract(payload,'$.status') AS status FROM task_history ORDER BY id").all() };
  } finally { db.close(); }
}

if (process.argv.includes('--help')) {
  console.log('Prepare --phase prepare. Run --phase run --prepared <cdp-fixture.json> --candidate <exe> --candidate-build-info <json> --diagnostic-config <json>. Optional --cycle-interval-ms 1000–10000 and --uia-observer read-only|read-only-detach must match in both phases and are fixed before launch. Isolated 1000-Skill/100-tool, 40-cycle CDP diagnostic. UIA is disabled by default. The opt-in observer attaches read-only to the same owned window; CDP remains the sole action driver. read-only-detach closes the observer after the original two idle samples, then uses CIM-only app samples at 0/10/20 seconds before normal app exit. No system input, app GC or performance/convergence acceptance.');
  process.exit(0);
}
assert.ok(['prepare', 'run'].includes(args.phase));
if (args.phase === 'prepare') {
  await mkdir(approved, { recursive: true });
  const root = await mkdtemp(join(approved, 'native-cdp-memory-'));
  const dataset = await createPerformanceFixture(root, 'churn-cdp', 100);
  const prepared = join(root, 'cdp-fixture.json');
  await writeFile(prepared, json({ format, syntheticOnly: true, root, dataset, policy, initialDatabaseSha256: await digest(dataset.dbPath), runtimeFiles: await runtimeFiles(dataset), createdAt: new Date().toISOString() }), { flag: 'wx' });
  console.log(JSON.stringify({ status: 'prepared-not-run', prepared, dataFingerprint: dataset.dataFingerprint, noNativeLaunch: true }));
  process.exit(0);
}

assert.ok(args.prepared && args.candidate && args['candidate-build-info'] && args['diagnostic-config']);
const descriptorPath = resolve(args.prepared), fixture = JSON.parse(await readFile(descriptorPath, 'utf8'));
const dataset = fixture.dataset, executable = resolve(args.candidate), buildInfoPath = resolve(args['candidate-build-info']);
const diagnosticPath = resolve(args['diagnostic-config']), diagnostic = JSON.parse(await readFile(diagnosticPath, 'utf8'));
const build = JSON.parse(await readFile(buildInfoPath, 'utf8'));
assert.equal(fixture.format, format); assert.equal(fixture.syntheticOnly, true); assert.deepEqual(fixture.policy, policy);
assert.ok(samePath(dirname(descriptorPath), fixture.root) && inside(fixture.root, approved) && basename(fixture.root).startsWith('native-cdp-memory-'));
assert.equal(dataset.format, FIXTURE_FORMAT); assert.equal(dataset.syntheticOnly, true);
assert.equal(dataset.skillCount, 1000); assert.equal(dataset.toolCount, 100);
for (const [field, suffix] of [['root', ''], ['dataDir', 'data'], ['dbPath', 'data/manager.sqlite3'], ['skillsRoot', 'skills'], ['toolsRoot', 'tools']]) {
  assert.ok(samePath(dataset[field], join(fixture.root, 'churn-cdp', suffix)));
  assert.ok(samePath(await realpath(dataset[field]), dataset[field]));
}
assert.ok(samePath(await realpath(fixture.root), fixture.root));
for (const path of [descriptorPath, join(dataset.root, 'fixture-owner.json'), join(dataset.root, 'dataset.json')]) assert.ok(samePath(await realpath(path), path));
const owner = JSON.parse(await readFile(join(dataset.root, 'fixture-owner.json'), 'utf8'));
assert.equal(owner.format, FIXTURE_FORMAT); assert.equal(owner.syntheticOnly, true); assert.equal(owner.name, 'churn-cdp');
assert.deepEqual(JSON.parse(await readFile(join(dataset.root, 'dataset.json'), 'utf8')), dataset);
assert.deepEqual(await readdir(dataset.dataDir), ['manager.sqlite3'], 'Run requires a fresh unlaunched synthetic profile.');
assert.equal(await digest(dataset.dbPath), fixture.initialDatabaseSha256); assert.deepEqual(await runtimeFiles(dataset), fixture.runtimeFiles);
assert.equal(build.buildMode, 'release'); assert.equal(build.diagnosticOnly, true); assert.equal(build.productionCandidate, false); assert.ok(build.sourceIdentity);
assert.ok(samePath(build.executablePath, executable)); assert.equal(await digest(executable), build.executableSha256);
assert.equal(diagnostic.format, 'agent-resource-manager-native-cdp-diagnostic-v1'); assert.equal(diagnostic.diagnosticOnly, true); assert.equal(diagnostic.productionCandidate, false);
assert.equal(diagnostic.host, '127.0.0.1'); assert.ok(Number.isInteger(diagnostic.port) && diagnostic.port > 1024 && diagnostic.port <= 65535);
assert.equal(diagnostic.executableSha256, build.executableSha256); assert.equal(diagnostic.buildInfoSha256, await digest(buildInfoPath));
assert.ok(isAbsolute(diagnostic.overridePath)); assert.equal(await digest(diagnostic.overridePath), diagnostic.overrideSha256);
assert.ok(build.sourceIdentity.endsWith('+diagnostic-config:' + diagnostic.overrideSha256));
const override = JSON.parse(await readFile(diagnostic.overridePath, 'utf8')), windows = override.app?.windows;
assert.equal(windows?.length, 1);
const browserArgs = windows[0].additionalBrowserArgs?.split(/\s+/) || [];
assert.ok(browserArgs.includes('--remote-debugging-address=127.0.0.1') && browserArgs.includes('--remote-debugging-port=' + diagnostic.port));
assert.equal(browserArgs.filter(flag => flag.startsWith('--remote-debugging-port=')).length, 1);
assert.equal(browserArgs.filter(flag => flag.startsWith('--remote-debugging-address=')).length, 1);
await writeFile(join(dataset.root, 'cdp-run-owner.json'), json({ descriptorSha256: await digest(descriptorPath), executableSha256: build.executableSha256, createdAt: new Date().toISOString() }), { flag: 'wx' });
const reportPath = join(dataset.root, 'cdp-result.json'), temporary = join(dataset.root, 'driver-temp');
await mkdir(temporary);
const harness = await Promise.all(['verify-native-cdp-memory.mjs', 'native-uia-client.mjs', 'performance-fixture.mjs'].map(async name => { const path = fileURLToPath(new URL(name, import.meta.url)); return { path, sha256: await digest(path) }; }));
const report = { format, status: 'running', diagnosticOnly: true, convergenceClaim: false, nativeGuiAcceptanceClaim: false, startedAt: new Date().toISOString(),
  candidate: { executable, sha256: build.executableSha256, sourceIdentity: build.sourceIdentity, buildInfoPath, buildInfoSha256: diagnostic.buildInfoSha256, diagnosticPath, diagnosticSha256: await digest(diagnosticPath) },
  fixture: { descriptorPath, descriptorSha256: await digest(descriptorPath), dataset, owner }, policy, harness, temporary,
  systemKeyboardOrMouseInput: false, uiaUsed: uiaObserverRequested, applicationGcRequested: false, samples: [], completedCycles: 0, normalExit: false,
  limitations: ['CDP DOM observation changes observer work and is not equivalent in CPU cost to UIA.', 'Private bytes include allocator capacity and do not establish retained live objects or a leak.', 'Synthetic local navigation may refresh file-read metadata. No external network, installation, backup or cleanup.'] };
const save = () => writeFile(reportPath, json(report));
let child, client, managerIdentity, exitResult, baselineState, uiaObserver;

// This separate observer has no activation, input, application launch or quit
// operation. Its only attachment target is the already-created CDP manager.
const attachedUiaScript = String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$taskOwner=$null
$taskWindow=[IntPtr]::Zero
function Read-OwnedProcess {
  $taskProcess=Get-Process -Id $taskOwner.pid -ErrorAction Stop
  $taskProcess.Refresh()
  if($taskProcess.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -cne $taskOwner.creationFileTime -or
     -not $taskProcess.Path.Equals($taskOwner.executable,[StringComparison]::OrdinalIgnoreCase) -or
     $taskProcess.MainWindowHandle -eq [IntPtr]::Zero -or
     ($taskWindow -ne [IntPtr]::Zero -and $taskProcess.MainWindowHandle -ne $taskWindow)) {
    throw 'The exact owned observer process or window changed.'
  }
  return $taskProcess
}
function Read-OwnedRoot {
  $taskProcess=Read-OwnedProcess
  $taskRoot=[System.Windows.Automation.AutomationElement]::FromHandle($taskProcess.MainWindowHandle)
  if($taskRoot.Current.ProcessId -ne $taskOwner.pid) {throw 'The observed UIA root does not belong to the owned manager.'}
  return $taskRoot
}
function Read-ObserverMemory {
  $taskObserver=Get-Process -Id $PID -ErrorAction Stop
  return @{pid=$PID;creationFileTime=$taskObserver.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();privateBytes=$taskObserver.PrivateMemorySize64;workingSetBytes=$taskObserver.WorkingSet64;cpuMs=$taskObserver.TotalProcessorTime.TotalMilliseconds}
}
function Read-ElementSummary($element) {
  if($null -eq $element) {return $null}
  $heading=$element.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::HeadingLevelProperty,$true)
  $supported=$heading -ne [System.Windows.Automation.AutomationElement]::NotSupported
  $name=$element.Current.Name
  $identifier=$element.Current.AutomationId
  return @{name=$name.Substring(0,[Math]::Min(160,$name.Length));type=$element.Current.ControlType.ProgrammaticName;automationId=$identifier.Substring(0,[Math]::Min(200,$identifier.Length));headingPropertySupported=[bool]$supported;headingLevel=if($supported){[int]$heading}else{$null};offscreen=$element.Current.IsOffscreen}
}
function Find-Named($scope,[string]$name,$type=$null) {
  $script:taskQueries++
  $condition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,$name)
  if($null -ne $type) {
    $condition=[System.Windows.Automation.AndCondition]::new($condition,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,$type))
  }
  $taskElements=$scope.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition)
  if($taskElements.Count -gt 1) {
    $script:taskFailureDetail=@{name=$name;type=$type.ProgrammaticName;count=$taskElements.Count;scope=(Read-ElementSummary $scope);candidates=@(for($index=0;$index -lt [Math]::Min(12,$taskElements.Count);$index++){Read-ElementSummary $taskElements[$index]})}
    throw "The exact read-only UIA observation is ambiguous. name=$name; type=$($type.ProgrammaticName); count=$($taskElements.Count)"
  }
  if($taskElements.Count -eq 0) {return $null}
  return $taskElements[0]
}
function Read-NavigationState($root,$request) {
  if($request.view -eq 'document') {
    $workspaceTabs=Find-Named $root '工作区标签' ([System.Windows.Automation.ControlType]::Tab)
    $resourceTab=if($null -ne $workspaceTabs){Find-Named $workspaceTabs 'Perf Skill 0000' ([System.Windows.Automation.ControlType]::TabItem)}else{$null}
    $tabs=Find-Named $root 'Skill 详情' ([System.Windows.Automation.ControlType]::Tab)
    $description=if($null -ne $tabs){Find-Named $tabs '说明' ([System.Windows.Automation.ControlType]::TabItem)}else{$null}
    $paragraph=Find-Named $root '仅用于隔离的本地性能验收，不调用外部程序，不连接远端。' ([System.Windows.Automation.ControlType]::Text)
    $resourceSelection=$null
    $resourceSelected=$null -ne $resourceTab -and $resourceTab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$resourceSelection) -and $resourceSelection.Current.IsSelected
    $selection=$null
    $selected=$null -ne $description -and $description.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$selection) -and $selection.Current.IsSelected
    $matched=$resourceSelected -and $selected -and $null -ne $paragraph
    $snapshot=@{matched=[bool]$matched;view='document';workspaceScope=(Read-ElementSummary $workspaceTabs);resourceTab=(Read-ElementSummary $resourceTab);resourceSelected=[bool]$resourceSelected;detailScope=(Read-ElementSummary $tabs);descriptionSelected=[bool]$selected;paragraph=(Read-ElementSummary $paragraph)}
    if(-not $matched) {
      $script:taskQueries++
      $condition=[System.Windows.Automation.AndCondition]::new([System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,'Perf Skill 0000'),[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Text))
      $titles=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition)
      $snapshot.titleCandidateCount=$titles.Count
      $snapshot.titleCandidates=@(for($index=0;$index -lt [Math]::Min(12,$titles.Count);$index++){Read-ElementSummary $titles[$index]})
    }
    return $snapshot
  }
  $edit=Find-Named $root '搜索 Skill' ([System.Windows.Automation.ControlType]::Edit)
  $pattern=$null
  $value=if($null -ne $edit -and $edit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)){$pattern.Current.Value}else{$null}
  $table=Find-Named $root '可横向滚动的 Skill 列表'
  $rowNames=@()
  if($null -ne $table) {
    $script:taskQueries++
    $buttons=$table.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button))
    $rowNames=@(foreach($button in $buttons){$name=$button.Current.Name;if($name -match '^Perf Skill [0-9]{4}$'){$name}})
  }
  $empty=if($request.view -eq 'empty'){Find-Named $root '当前筛选无结果'}else{$null}
  $matched=$null -ne $edit -and $value -ceq $request.value -and $rowNames.Count -eq $request.rows
  if($request.skill) {$matched=$matched -and $rowNames -ccontains $request.skill}
  if($request.view -eq 'empty') {$matched=$matched -and $null -ne $empty}
  return @{matched=[bool]$matched;view=$request.view;searchValue=$value;rowCount=$rowNames.Count;targetFound=($request.skill -and $rowNames -ccontains $request.skill)}
}
while($null -ne ($line=[Console]::ReadLine())) {
  $request=$null
  $snapshot=$null
  $script:taskFailureDetail=$null
  try {
    $request=$line|ConvertFrom-Json
    if($null -eq $taskOwner) {
      if($request.op -ne 'attach' -or $request.pid -le 0 -or -not [IO.Path]::IsPathFullyQualified($request.executable) -or $request.creationFileTime -notmatch '^[0-9]+$') {throw 'An exact existing manager identity is required.'}
      $taskOwner=$request
      $null=Read-OwnedRoot
      $taskWindow=(Get-Process -Id $taskOwner.pid -ErrorAction Stop).MainWindowHandle
      $null=Read-OwnedRoot
      $result=@{pid=[int]$taskOwner.pid;creationFileTime=$taskOwner.creationFileTime;windowHandle=$taskWindow.ToInt64();readOnly=$true;systemInput=$false;observerMemory=(Read-ObserverMemory)}
    } elseif($request.op -eq 'memory') {
      $null=Read-OwnedProcess
      $result=Read-ObserverMemory
    } else {
      if($request.op -ne 'observe' -or $request.view -notin @('list','empty','document') -or
         ($request.view -ne 'document' -and ($request.rows -notin @(0,1,20) -or $request.value -notmatch '^(|perf-skill-[0-9]{4})$')) -or
         ($request.skill -and $request.skill -notmatch '^Perf Skill [0-9]{4}$')) {throw 'Only the fixed synthetic read-only navigation observations are supported.'}
      $timer=[Diagnostics.Stopwatch]::StartNew()
      $script:taskQueries=0
      $attempts=0
      do {
        $root=Read-OwnedRoot
        $snapshot=Read-NavigationState $root $request
        $attempts++
        if($snapshot.matched) {break}
        Start-Sleep -Milliseconds 25
      } while($timer.ElapsedMilliseconds -lt 15000)
      $null=Read-OwnedRoot
      if(-not $snapshot.matched) {$script:taskFailureDetail=$snapshot;throw 'The exact read-only UIA navigation result did not become available.'}
      $result=@{pid=[int]$taskOwner.pid;creationFileTime=$taskOwner.creationFileTime;windowHandle=$taskWindow.ToInt64();readOnly=$true;systemInput=$false;durationMs=$timer.Elapsed.TotalMilliseconds;queryCount=$script:taskQueries;attempts=$attempts;snapshot=$snapshot;observerMemory=(Read-ObserverMemory)}
    }
    [Console]::WriteLine((@{id=$request.id;result=$result}|ConvertTo-Json -Compress -Depth 6))
  } catch {
    [Console]::WriteLine((@{id=$request.id;error=$_.Exception.Message;details=$script:taskFailureDetail}|ConvertTo-Json -Compress -Depth 9))
    exit 1
  }
}
`;

class ReadOnlyUiaObserver {
  constructor(process) {
    this.process = process; this.nextId = 0; this.pending = null; this.stderr = '';
    this.lines = createInterface({ input: process.stdout });
    this.lines.on('line', line => {
      try {
        const value = JSON.parse(line), request = this.pending;
        assert.ok(request && value.id === request.id, 'Unexpected read-only UIA response identity.');
        clearTimeout(request.timer); this.pending = null;
        if (value.error) { const error = new Error(value.error); error.observationDetails = value.details; request.reject(error); }
        else request.resolve(value.result);
      } catch (error) { this.fail(error); }
    });
    process.stderr.on('data', value => { this.stderr = (this.stderr + value).slice(-3000); });
    process.stdin.on('error', error => this.fail(error));
    process.once('error', error => this.fail(error));
    this.closed = new Promise(resolve => process.once('close', (code, signal) => {
      this.exit = { code, signal }; this.lines.close();
      this.fail(new Error(`Read-only UIA observer exited (${code}): ${this.stderr}`)); resolve(this.exit);
    }));
  }
  fail(error) {
    this.error = error;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null; }
    if (!this.process.stdin.writableEnded && !this.process.stdin.destroyed) this.process.stdin.end();
  }
  call(fields) {
    if (this.error) return Promise.reject(this.error);
    assert.equal(this.pending, null, 'Read-only UIA requests must be serial.');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('Read-only UIA observation exceeded twenty seconds.')), 20000);
      this.pending = { id, resolve, reject, timer };
      this.process.stdin.write(JSON.stringify({ ...fields, id }) + '\n', error => { if (error) this.fail(error); });
    });
  }
  async close() {
    if (!this.process.stdin.writableEnded && !this.process.stdin.destroyed) this.process.stdin.end();
    let timer;
    const result = await Promise.race([this.closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Read-only UIA observer did not exit after closing its input. No process was forcibly stopped.')), 10000); })]).finally(() => clearTimeout(timer));
    assert.ok(result.code === 0 && !result.signal, 'Read-only UIA observer must exit normally.');
    return result;
  }
}

async function observeUia(label, expected) {
  if (!uiaObserver) return;
  report.uiaObserver.lastRequestedObservation = { label, expected, requestedAt: new Date().toISOString() };
  let observation;
  try { observation = await uiaObserver.call({ op: 'observe', ...expected }); }
  catch (error) { report.uiaObserver.failedObservation = { label, expected, details: error.observationDetails || null }; throw error; }
  assert.equal(observation.pid, child.pid); assert.equal(observation.creationFileTime, managerIdentity.creationFileTime);
  assert.equal(observation.windowHandle, report.uiaObserver.identity.windowHandle);
  assert.equal(observation.readOnly, true); assert.equal(observation.systemInput, false);
  assert.equal(observation.observerMemory.pid, report.uiaObserver.observerPid);
  assert.equal(observation.observerMemory.creationFileTime, report.uiaObserver.identity.observerMemory.creationFileTime);
  assert.equal(observation.snapshot.matched, true);
  report.uiaObserver.observations.push({ label, observedAt: new Date().toISOString(), ...observation });
}

async function closeUiaObserver(reason) {
  const observer = uiaObserver;
  assert.ok(observer, 'The attached observer must exist before closing.');
  uiaObserver = null;
  report.uiaObserver.closeReason = reason; report.uiaObserver.closeRequestedAt = new Date().toISOString();
  try {
    report.uiaObserver.exit = await observer.close(); report.uiaObserver.closedNormally = true;
    report.uiaObserver.closedAt = new Date().toISOString();
    return performance.now();
  } catch (error) {
    report.uiaObserver.exitError = String(error); report.uiaObserver.closedNormally = false;
    report.uiaObserver.processRequiresAttention = !observer.exit;
    observer.process.unref(); observer.process.stdin.unref(); observer.process.stdout.unref(); observer.process.stderr.unref();
    throw error;
  }
}

async function processes(allowExited = false) {
  const command = String.raw`
    $ErrorActionPreference='Stop'
    $taskAll=@(Get-CimInstance Win32_Process)
    $taskIds=[Collections.Generic.HashSet[int]]::new()
    [void]$taskIds.Add(${child.pid})
    do {
      $taskAdded=$false
      foreach($taskRow in $taskAll) {
        if($taskIds.Contains([int]$taskRow.ParentProcessId) -and $taskIds.Add([int]$taskRow.ProcessId)) {$taskAdded=$true}
      }
    } while($taskAdded)
    @(foreach($taskRow in $taskAll) {
      if(-not $taskIds.Contains([int]$taskRow.ProcessId)) {continue}
      $taskProcess=Get-Process -Id $taskRow.ProcessId -ErrorAction SilentlyContinue
      if(-not $taskProcess) {continue}
      $taskRole='native-child'
      if($taskRow.ProcessId -eq ${child.pid}) {$taskRole='manager'}
      elseif($taskRow.Name -eq 'msedgewebview2.exe') {
        $taskRole='webview-browser'
        if($taskRow.CommandLine -match '--type=([a-zA-Z-]+)') {$taskRole='webview-'+$Matches[1]}
      }
      $taskProfile=$null
      if($taskRow.CommandLine -match '--user-data-dir=(?:"([^"]+)"|([^\s]+))') {
        $taskProfile=$Matches[1]
        if(-not $taskProfile) {$taskProfile=$Matches[2]}
      }
      $taskProfileRoot=${ps(join(dataset.dataDir, 'webview'))}
      $taskProfileInside=$false
      if($taskProfile) {
        $taskProfilePath=[IO.Path]::GetFullPath($taskProfile)
        $taskProfileInside=$taskProfilePath.Equals($taskProfileRoot,[StringComparison]::OrdinalIgnoreCase) -or $taskProfilePath.StartsWith($taskProfileRoot+'\',[StringComparison]::OrdinalIgnoreCase)
      }
      $taskBound=$taskRole -eq 'webview-browser' -and $taskRow.CommandLine -match '(?:^|\s)--remote-debugging-port=${diagnostic.port}(?:\s|$)' -and $taskProfileInside
      [pscustomobject]@{pid=[int]$taskRow.ProcessId;parentPid=[int]$taskRow.ParentProcessId;creationFileTime=$taskProcess.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();image=$taskRow.Name;executablePath=$taskRow.ExecutablePath;role=$taskRole;privateBytes=$taskProcess.PrivateMemorySize64;workingSetBytes=$taskProcess.WorkingSet64;cpuMs=$taskProcess.TotalProcessorTime.TotalMilliseconds;productVersion=$taskProcess.FileVersionInfo.ProductVersion;fileVersion=$taskProcess.FileVersionInfo.FileVersion;diagnosticProfileBound=[bool]$taskBound}
    })|ConvertTo-Json -Compress`;
  const { stdout } = await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 20000, maxBuffer: 256 * 1024 });
  const rows = list(stdout.trim() ? JSON.parse(stdout) : null), manager = rows.find(row => row.pid === child.pid);
  if (!allowExited) assert.ok(manager && samePath(manager.executablePath, executable), 'Exact owned manager must still be running.');
  if (managerIdentity && manager) assert.equal(manager.creationFileTime, managerIdentity.creationFileTime, 'PID identity changed.');
  if (managerIdentity) assert.ok(rows.every(row => BigInt(row.creationFileTime) >= BigInt(managerIdentity.creationFileTime)), 'Observed descendants must have started within this exact owned lifetime.');
  return rows;
}

async function sample(phase, metadata = {}) {
  const rows = await processes(), application = { privateBytes: rows.reduce((sum, row) => sum + row.privateBytes, 0), workingSetBytes: rows.reduce((sum, row) => sum + row.workingSetBytes, 0), cpuMs: rows.reduce((sum, row) => sum + row.cpuMs, 0), processes: rows };
  const observerMemory = uiaObserver ? await uiaObserver.call({ op: 'memory' }) : null;
  if (observerMemory) {
    assert.equal(observerMemory.pid, report.uiaObserver.observerPid);
    assert.equal(observerMemory.creationFileTime, report.uiaObserver.identity.observerMemory.creationFileTime);
  }
  report.samples.push({ phase, observedAt: new Date().toISOString(), application, driver: { pid: process.pid, ...process.memoryUsage(), cpuUsage: process.cpuUsage() }, ...(observerMemory ? { uiaObserver: observerMemory } : {}), ...metadata });
  await save(); console.log(JSON.stringify({ phase, applicationMiB: application.privateBytes / 1048576 }));
}

class CdpClient {
  constructor(socket) {
    this.socket = socket; this.nextId = 0; this.pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data), request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Owned CDP session closed.')); }
      this.pending.clear();
    });
  }
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout ' + method)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  async evaluate(body) {
    const result = await this.call('Runtime.evaluate', { expression: '(() => {' + domHelpers + body + '})()', returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); return result.result.value;
  }
}

const domHelpers = `
  const visible = element => !element.closest('[hidden]') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const name = element => element.getAttribute('aria-label') || element.textContent.trim();
  const all = selector => [...document.querySelectorAll(selector)].filter(visible);
  const one = (selector, label) => { const matches = all(selector).filter(element => label === undefined || name(element) === label); if(matches.length !== 1 || matches[0].disabled) throw Error('Expected one enabled visible ' + selector + ' ' + label + ', found ' + matches.length); return matches[0]; };
  const rows = () => all('[aria-label="可横向滚动的 Skill 列表"] button').filter(element => /^Perf Skill \\d{4}$/.test(name(element))).map(name);
  const documentReady = () => all('.detail-title h2').filter(element => name(element) === 'Perf Skill 0000').length === 1 && all('[aria-label="Skill 详情"] [role="tab"]').filter(element => name(element) === '说明' && element.getAttribute('aria-selected') === 'true').length === 1 && all('article.markdown p').some(element => name(element) === '仅用于隔离的本地性能验收，不调用外部程序，不连接远端。');
`;
async function waitFor(condition, label) {
  report.lastOperation = label;
  const deadline = performance.now() + 15000;
  while (performance.now() < deadline) { if (await client.evaluate('return Boolean(' + condition + ');')) return; await sleep(50); }
  throw new Error('DOM result timeout ' + label);
}
async function click(selector, label) { report.lastOperation = 'click ' + (label || selector); await client.evaluate(`one(${JSON.stringify(selector)}, ${JSON.stringify(label)}).click(); return true;`); }
async function search(index) {
  const key = String(index).padStart(4, '0'), value = 'perf-skill-' + key;
  await client.evaluate('const input = one(\'input[aria-label="搜索 Skill"]\'); input.focus({preventScroll:true}); input.select(); return document.activeElement === input;').then(assert.ok);
  await client.call('Input.insertText', { text: value });
  await waitFor(`one('input[aria-label="搜索 Skill"]').value === ${JSON.stringify(value)} && rows().length === 1 && rows()[0] === ${JSON.stringify('Perf Skill ' + key)}`, 'search-' + key);
  await observeUia('search-' + key, { view: 'list', value, rows: 1, skill: 'Perf Skill ' + key });
}
async function clear() {
  await click('button', '清空搜索'); await waitFor(`one('input[aria-label="搜索 Skill"]').value === '' && rows().length === 20`, 'clear');
  await observeUia('clear', { view: 'list', value: '', rows: 20 });
}
async function navigate(index) {
  await search(index); await clear();
  await click('[aria-label="来源筛选"] button', 'GitHub');
  await waitFor(`one('[aria-label="来源筛选"] button', 'GitHub').getAttribute('aria-pressed') === 'true' && rows().length === 0 && all('h2,h3,strong').some(element => name(element) === '当前筛选无结果')`, 'filter-github');
  await observeUia('filter-github', { view: 'empty', value: '', rows: 0 });
  await click('[aria-label="来源筛选"] button', '全部');
  await waitFor(`one('[aria-label="来源筛选"] button', '全部').getAttribute('aria-pressed') === 'true' && rows().length === 20`, 'filter-all');
  await observeUia('filter-all', { view: 'list', value: '', rows: 20 });
  await search(0); await click('[aria-label="可横向滚动的 Skill 列表"] button', 'Perf Skill 0000'); await waitFor('documentReady()', 'open-document');
  await observeUia('open-document', { view: 'document' });
  await click('[aria-label="工作区标签"] [data-home="true"] [role="tab"]');
  await waitFor(`one('[aria-label="工作区标签"] [data-home="true"] [role="tab"]').getAttribute('aria-selected') === 'true' && all('input[aria-label="搜索 Skill"]').length === 1`, 'tab-home');
  await observeUia('tab-home', { view: 'list', value: 'perf-skill-0000', rows: 1, skill: 'Perf Skill 0000' });
  await click('[aria-label="工作区标签"] [role="tab"]', 'Perf Skill 0000'); await waitFor('documentReady()', 'tab-detail');
  await observeUia('tab-detail', { view: 'document' });
  await click('button', '关闭 Perf Skill 0000');
  await waitFor(`all('button[aria-label="关闭 Perf Skill 0000"]').length === 0 && all('input[aria-label="搜索 Skill"]').length === 1`, 'close-document');
  await observeUia('close-document', { view: 'list', value: 'perf-skill-0000', rows: 1, skill: 'Perf Skill 0000' });
  await clear();
}

try {
  await save();
  const { stdout } = await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop';@(Get-NetTCPConnection -State Listen -LocalPort ${diagnostic.port} -ErrorAction SilentlyContinue).Count`], { windowsHide: true, timeout: 20000 });
  assert.equal(Number(stdout.trim()), 0, 'Fixed diagnostic port is already occupied.');
  const childEnvironment = { ...process.env, TEMP: temporary, TMP: temporary };
  for (const key of Object.keys(childEnvironment)) if (/^WEBVIEW2_(USER_DATA_FOLDER|ADDITIONAL_BROWSER_ARGUMENTS|WAIT_FOR_SCRIPT_DEBUGGER|PIPE_FOR_SCRIPT_DEBUGGER)$/i.test(key)) delete childEnvironment[key];
  report.launchPreflight = { ...await assertNoUserManager(), checkedAtUtc: new Date().toISOString() };
  child = spawn(executable, ['--data-dir', dataset.dataDir], { cwd: dirname(executable), env: childEnvironment, stdio: 'ignore', windowsHide: false });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { exitResult = { code, signal }; resolve(exitResult); }); });
  exited.catch(() => {});
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  report.launchedPid = child.pid; await save();
  const initialRows = await processes(); managerIdentity = initialRows.find(row => row.pid === child.pid); report.native = managerIdentity; await save();
  let target;
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    const rows = await processes();
    if (rows.some(row => row.diagnosticProfileBound)) {
      try {
        const { stdout } = await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', `@(Get-NetTCPConnection -State Listen -LocalPort ${diagnostic.port} -ErrorAction Stop|Select-Object LocalAddress,OwningProcess)|ConvertTo-Json -Compress`], { windowsHide: true, timeout: 20000 });
        const listeners = list(JSON.parse(stdout));
        assert.ok(listeners.length && listeners.every(listener => ['127.0.0.1', '::1'].includes(listener.LocalAddress) && rows.some(row => row.pid === listener.OwningProcess && row.diagnosticProfileBound)), 'Loopback listener must belong to this owned synthetic-profile WebView.');
        const response = await fetch(`http://127.0.0.1:${diagnostic.port}/json`, { redirect: 'error', signal: AbortSignal.timeout(1500) }); assert.ok(response.ok);
        const pages = (await response.json()).filter(page => page.type === 'page');
        assert.equal(pages.length, 1, 'Diagnostic requires one unique app page.');
        const url = new URL(pages[0].url);
        assert.ok((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname === 'tauri.localhost' || url.protocol === 'tauri:' && url.hostname === 'localhost');
        const socket = new URL(pages[0].webSocketDebuggerUrl);
        assert.equal(socket.protocol, 'ws:'); assert.equal(socket.hostname, '127.0.0.1'); assert.equal(Number(socket.port), diagnostic.port); assert.ok(socket.pathname.startsWith('/devtools/page/'));
        target = pages[0]; break;
      } catch (error) { report.connectionLastError = String(error); }
    }
    await sleep(250);
  }
  assert.ok(target, 'Owned isolated-profile CDP target was not confirmed.');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { const timer = setTimeout(() => { socket.close(); reject(new Error('CDP WebSocket open timeout.')); }, 10000); socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true }); socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP WebSocket failed.')); }, { once: true }); });
  client = new CdpClient(socket); report.cdp = { targetId: target.id, url: target.url, host: diagnostic.host, port: diagnostic.port };
  await waitFor(`all('input[aria-label="搜索 Skill"]').length === 1 && rows().length === 20`, 'initial-workbench'); await sleep(policy.settleMs);
  baselineState = stored(dataset); assert.ok(baselineState.tasks.every(task => !['running', 'queued'].includes(task.status)));
  if (uiaObserverRequested) {
    await sample('before-uia-observer-attachment');
    const observerProcess = spawn('pwsh.exe', ['-NoProfile', '-NonInteractive', '-MTA', '-EncodedCommand', Buffer.from(attachedUiaScript, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: childEnvironment });
    uiaObserver = new ReadOnlyUiaObserver(observerProcess);
    report.uiaObserver = { mode: 'read-only-owned-window', actionDriver: 'CDP-only', inputOrActivationSupported: false, documentObservation: 'The unchanged CDP documentReady condition verifies the unique detail-title h2. UIA independently verifies the exact selected resource TabItem within workspace tabs, the selected description TabItem within detail tabs and the exact document paragraph. Heading properties are diagnostic only.', observerPid: observerProcess.pid, observations: [], cycles: [] };
    const identity = await uiaObserver.call({ op: 'attach', pid: child.pid, creationFileTime: managerIdentity.creationFileTime, executable });
    assert.equal(identity.pid, child.pid); assert.equal(identity.creationFileTime, managerIdentity.creationFileTime);
    assert.ok(Number.isSafeInteger(identity.windowHandle) && identity.windowHandle > 0);
    assert.equal(identity.readOnly, true); assert.equal(identity.systemInput, false);
    assert.equal(identity.observerMemory.pid, observerProcess.pid);
    report.uiaObserver.identity = identity;
    report.limitations.push('The opt-in UIA process reads only this existing owned window after CDP actions. Its query work and delays differ from the original UIA action driver. A visible native window is still created by the unchanged CDP launcher.');
    await observeUia('initial-workbench', { view: 'list', value: '', rows: 20 });
  }
  await sample('before-queries'); const started = performance.now();
  for (let index = 0; index < policy.cycleCount; index++) {
    await sleep(started + index * policy.cycleIntervalMs - performance.now());
    const cycleStarted = performance.now(), observedBefore = report.uiaObserver?.observations.length;
    await navigate(index + 1); report.completedCycles++;
    if (uiaObserver) {
      const observations = report.uiaObserver.observations.slice(observedBefore);
      assert.equal(observations.length, 10, 'Each CDP navigation cycle requires all ten read-only UIA observations.');
      report.uiaObserver.cycles.push({ cycle: report.completedCycles, startedElapsedMs: cycleStarted - started, finishedElapsedMs: performance.now() - started, observationCount: observations.length, uiaQueryCount: observations.reduce((sum, value) => sum + value.queryCount, 0), uiaDurationMs: observations.reduce((sum, value) => sum + value.durationMs, 0) });
    }
    if (report.completedCycles % 10 === 0) await sample('cycles-' + report.completedCycles);
  }
  report.queryElapsedMs = performance.now() - started;
  await sleep(policy.idleMs); await sample('idle-before-optional-driver-collection');
  await sleep(policy.idleMs); await sample('idle-after-optional-driver-collection');
  if (detachObserverAfterIdle) {
    assert.equal(report.uiaObserver.observations.length, 1 + policy.cycleCount * 10, 'The initial state and all fixed read-only observations must finish before detaching.');
    const detachedAt = await closeUiaObserver('after-original-two-idle-samples'); await save();
    for (const offsetMs of policy.observerDetach.sampleOffsetsMs) {
      await sleep(detachedAt + offsetMs - performance.now());
      assert.equal(uiaObserver, null, 'Post-detach samples must not query the UIA observer.');
      await sample(`observer-detached-${offsetMs / 1000}s`, { observerDetached: true, scheduledOffsetMs: offsetMs, sampleStartedSinceObserverExitMs: performance.now() - detachedAt });
      report.samples.at(-1).elapsedSinceObserverExitMs = performance.now() - detachedAt; await save();
    }
    report.limitations.push('The explicit observer exited before the three post-detach CIM samples. This tests its client-lifetime effect only; other accessibility clients, allocator retention and sustained convergence are not established.');
  }
  assert.deepEqual(stored(dataset), baselineState, 'Navigation must preserve managed identities, settings, runtime hashes, resources and task history.');
  assert.deepEqual(await runtimeFiles(dataset), fixture.runtimeFiles); report.navigationInvariantsAndTaskHistoryUnchanged = true; report.runtimeFileBytesUnchanged = true;
  if (uiaObserver) assert.equal(report.uiaObserver.observations.length, 1 + policy.cycleCount * 10, 'The initial state and all fixed read-only observations must be recorded.');
  report.status = 'diagnostic-measurements-collected';
} catch (error) { report.status = 'failed-or-blocked'; report.error = String(error); report.errorStack = error.stack; process.exitCode = 1; }
finally {
  if (child?.pid && !exitResult && client) {
    try {
      const quitVisible = await client.evaluate(`return all('button').filter(element => name(element) === '完全退出管理器').length === 1;`);
      if (!quitVisible) { await click('button', '工作区快捷键'); await waitFor(`all('button').filter(element => name(element) === '完全退出管理器').length === 1`, 'normal-quit-menu'); }
      report.normalQuitRequested = true; await click('button', '完全退出管理器');
    } catch (error) { report.normalExitError = String(error); }
    if (report.normalQuitRequested) {
      const deadline = performance.now() + 15000; while (!exitResult && performance.now() < deadline) await sleep(100);
      report.normalExit = Boolean(exitResult && exitResult.code === 0 && !exitResult.signal);
    }
  }
  client?.socket.close(); report.exitResult = exitResult || null;
  if (child?.pid) try {
    const deadline = performance.now() + (report.normalExit ? 10000 : 0);
    do { report.remainingOwnedProcesses = await processes(true); if (report.remainingOwnedProcesses.length) await sleep(250); } while (report.remainingOwnedProcesses.length && performance.now() < deadline);
    if (baselineState) { assert.deepEqual(stored(dataset), baselineState); assert.deepEqual(await runtimeFiles(dataset), fixture.runtimeFiles); report.finalDurableInvariantsUnchanged = true; }
  } catch (error) { report.finalStateError = String(error); report.status = 'failed-or-blocked'; process.exitCode = 1; }
  if (child?.pid && (!report.normalExit || report.remainingOwnedProcesses?.length)) { report.status = 'failed-or-blocked'; report.ownedProcessRequiresAttention = !exitResult || Boolean(report.remainingOwnedProcesses?.length); process.exitCode = 1; }
  if (uiaObserver) try { await closeUiaObserver('after-native-app-exit'); }
  catch { report.status = 'failed-or-blocked'; process.exitCode = 1; }
  report.harnessChangedDuringRun = (await Promise.all(harness.map(async file => await digest(file.path) !== file.sha256))).some(Boolean);
  if (report.harnessChangedDuringRun || await digest(executable) !== build.executableSha256 || await digest(buildInfoPath) !== diagnostic.buildInfoSha256 || await digest(diagnostic.overridePath) !== diagnostic.overrideSha256 || await digest(diagnosticPath) !== report.candidate.diagnosticSha256 || await digest(descriptorPath) !== report.fixture.descriptorSha256) { report.status = 'failed-or-blocked'; report.integrityError = 'Fixed diagnostic inputs changed.'; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString(); await save(); console.log(JSON.stringify({ status: report.status, report: reportPath, normalExit: report.normalExit, pid: child?.pid, error: report.error || null }));
  if (child?.pid && !exitResult) child.unref();
}
