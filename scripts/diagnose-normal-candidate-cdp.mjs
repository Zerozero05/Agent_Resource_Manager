import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createPerformanceFixture, FIXTURE_FORMAT } from './performance-fixture.mjs';
import { assertNoUserManager } from './native-uia-client.mjs';

// Reuse this project's synthetic fixture and CDP protocol approach. This is an
// independent short diagnostic. It cannot replace failed native acceptance.
const approved = 'D:\\03_github_projects\\Agent_Resource_Manager\\validation\\manager-data';
const candidateRoot = resolve(fileURLToPath(new URL('../outputs/v1-validation/detached-task-summary-allocation-20261109/', import.meta.url)));
const executable = join(candidateRoot, 'agent-resource-manager.exe');
const buildInfoPath = join(candidateRoot, 'candidate-build-info.json');
const candidateSha256 = 'd0b6551f5fd11125ec6f548b7239643f9076a6ccec0ccf54f6afca15e8ce87e0';
const format = 'agent-resource-manager-normal-cdp-diagnostic-v1';
const policy = Object.freeze({ skillCount: 1000, toolCount: 100, cycles: 40, cycleIntervalMs: 1000, settleMs: 5000, idleMs: 10000, loopbackPort: 65353 });
const args = process.argv.slice(2), mode = args[0] || '--prepare';
assert.ok(['--prepare', '--validate', '--run', '--help'].includes(mode));
assert.ok(args.length <= (['--validate', '--run'].includes(mode) ? 2 : 1), 'Pass one mode and, where required, its prepared descriptor.');
const json = value => JSON.stringify(value, null, 2) + '\n';
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const same = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase();
const inside = path => { const part = relative(approved, resolve(path)); return part !== '' && !part.startsWith('..') && !isAbsolute(part); };
const ps = value => "'" + String(value).replaceAll("'", "''") + "'";
const sleep = ms => new Promise(done => setTimeout(done, Math.max(0, ms)));
const execute = promisify(execFile);
async function ordinary(path, file = false) {
  const info = await lstat(path);
  assert.ok(!info.isSymbolicLink() && (file ? info.isFile() && info.nlink === 1 : info.isDirectory()), 'Require an ordinary unlinked path: ' + path);
  assert.ok(same(await realpath(path), path), 'Resolved path changed: ' + path);
}
async function ownedPath(path, file = false) {
  assert.ok(inside(path), 'Diagnostic path must stay inside the approved validation root.');
  for (let parent = dirname(path); !same(parent, approved); parent = dirname(parent)) await ordinary(parent);
  await ordinary(approved); await ordinary(path, file);
}
async function runtimeFiles(dataset) {
  const hashes = [];
  for (const [root, count, prefix, width, name] of [[dataset.skillsRoot, 1000, 'perf-skill-', 4, 'SKILL.md'], [dataset.toolsRoot, 100, 'perf-tool-', 3, 'README.md']]) {
    for (let index = 0; index < count; index++) {
      const path = join(root, prefix + String(index).padStart(width, '0'), name);
      await ownedPath(path, true); hashes.push({ path, sha256: await digest(path) });
    }
  }
  return hashes;
}
async function validate(path) {
  path = resolve(path); await ownedPath(path, true);
  const descriptor = JSON.parse(await readFile(path, 'utf8')), { dataset } = descriptor;
  assert.equal(descriptor.format, format); assert.equal(descriptor.syntheticOnly, true);
  assert.deepEqual(descriptor.policy, policy); assert.equal(descriptor.candidateSha256, candidateSha256);
  assert.ok(same(descriptor.root, dirname(path)) && basename(descriptor.root).startsWith('normal-cdp-'));
  assert.equal(dataset.format, FIXTURE_FORMAT); assert.equal(dataset.syntheticOnly, true);
  assert.equal(dataset.skillCount, 1000); assert.equal(dataset.toolCount, 100);
  for (const [key, suffix] of [['root', ''], ['dataDir', 'data'], ['dbPath', 'data/manager.sqlite3'], ['skillsRoot', 'skills'], ['toolsRoot', 'tools']]) {
    assert.ok(same(dataset[key], join(descriptor.root, 'churn-normal-cdp', suffix))); await ownedPath(dataset[key], key === 'dbPath');
  }
  const datasetPath = join(dataset.root, 'dataset.json'), ownerPath = join(dataset.root, 'fixture-owner.json');
  await ownedPath(datasetPath, true); await ownedPath(ownerPath, true);
  assert.deepEqual(JSON.parse(await readFile(datasetPath, 'utf8')), dataset);
  const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
  assert.equal(owner.format, FIXTURE_FORMAT); assert.equal(owner.syntheticOnly, true); assert.equal(owner.name, 'churn-normal-cdp');
  assert.deepEqual(await readdir(dataset.dataDir), ['manager.sqlite3'], 'Require a fresh unlaunched fixture.');
  assert.equal(await digest(dataset.dbPath), descriptor.initialDatabaseSha256);
  assert.deepEqual(await runtimeFiles(dataset), descriptor.runtimeFiles);
  await ordinary(executable, true); await ordinary(buildInfoPath, true);
  const build = JSON.parse(await readFile(buildInfoPath, 'utf8'));
  assert.equal(build.buildMode, 'release'); assert.ok(build.diagnosticOnly !== true && build.productionCandidate !== false);
  assert.ok(same(build.executablePath, executable)); assert.equal(build.executableSha256, candidateSha256);
  assert.equal(await digest(executable), candidateSha256); assert.equal(await digest(buildInfoPath), descriptor.buildInfoSha256);
  return { descriptor, descriptorPath: path, descriptorSha256: await digest(path) };
}
if (mode === '--help') {
  console.log('Default --prepare creates and validates a fresh D-drive synthetic fixture without starting any child process. --validate <descriptor> only reads it. Only --run <descriptor> starts the exact normal d0 EXE, potentially showing/activating its window, with child-only WebView2 loopback debugging, isolated profile and TEMP/TMP. Forty CDP input cycles are diagnostic only. UIA is restricted to failure-path normal Quit cleanup, which leaves the run failed. No OS keyboard/mouse input, app GC, downloads, forced kill or performance acceptance.');
  process.exit(0);
}
if (mode === '--prepare') {
  await mkdir(approved, { recursive: true }); await ordinary(approved);
  const root = await mkdtemp(join(approved, 'normal-cdp-'));
  const dataset = await createPerformanceFixture(root, 'churn-normal-cdp', 100);
  const path = join(root, 'normal-cdp-fixture.json');
  await writeFile(path, json({ format, syntheticOnly: true, root, dataset, policy, candidateSha256, buildInfoSha256: await digest(buildInfoPath), initialDatabaseSha256: await digest(dataset.dbPath), runtimeFiles: await runtimeFiles(dataset), createdAt: new Date().toISOString() }), { flag: 'wx' });
  await validate(path);
  console.log(json({ status: 'prepared-not-run', descriptor: path, candidateSha256, noChildProcessStarted: true, noGuiStarted: true, noCdpConnection: true }));
  process.exit(0);
}
assert.equal(process.platform, 'win32'); assert.equal(args.length, 2, 'Select the prepared descriptor explicitly.');
const prepared = await validate(args[1]);
if (mode === '--validate') {
  console.log(json({ status: 'validated-not-run', descriptor: prepared.descriptorPath, candidateSha256, noChildProcessStarted: true, noGuiStarted: true, noCdpConnection: true }));
  process.exit(0);
}

const { descriptor, descriptorPath, descriptorSha256 } = prepared, { dataset } = descriptor;
const reportPath = join(descriptor.root, 'normal-cdp-result.json'), temporary = join(descriptor.root, 'temp'), profile = join(descriptor.root, 'webview-profile');
await writeFile(join(descriptor.root, 'run-owner.json'), json({ descriptorSha256, candidateSha256, createdAt: new Date().toISOString() }), { flag: 'wx' });
await mkdir(temporary); await mkdir(profile);
const report = { format, status: 'running', diagnosticOnly: true, nativeAcceptanceClaim: false, replacesPriorFailure: false, candidate: { executable, candidateSha256, buildInfoPath, buildInfoSha256: descriptor.buildInfoSha256 }, fixture: { descriptorPath, descriptorSha256, dataFingerprint: dataset.dataFingerprint }, policy, scriptSha256: await digest(fileURLToPath(import.meta.url)), profile, temporary, startedAt: new Date().toISOString(), uiaUsed: false, osInputSent: false, applicationGcRequested: false, externalNetworkRequested: false, samples: [], cycles: [], inputCalls: {}, normalExit: false, limitations: ['Child GUI startup may show or activate a window. No zero-desktop-interference claim.', 'CDP input is browser input, not native Windows keyboard/mouse, Chinese IME or clipboard acceptance.', 'Two animation frames and DOM hit tests do not establish DWM presentation or native interactive latency.', 'Forty short navigation cycles exclude real download/update/check overlap and do not establish thirty-minute convergence.', 'Remote debugging changes the process environment. Prior normal-candidate failure remains unchanged.'] };
const save = () => writeFile(reportPath, json(report));
const childEnvironment = { ...process.env, TEMP: temporary, TMP: temporary };
for (const key of Object.keys(childEnvironment)) if (/^(SKILL_MANAGER_DATA_DIR|WEBVIEW2_(USER_DATA_FOLDER|ADDITIONAL_BROWSER_ARGUMENTS|WAIT_FOR_SCRIPT_DEBUGGER|PIPE_FOR_SCRIPT_DEBUGGER))$/i.test(key)) delete childEnvironment[key];
Object.assign(childEnvironment, { WEBVIEW2_USER_DATA_FOLDER: profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${policy.loopbackPort} --remote-debugging-address=127.0.0.1` });
const powershell = async command => {
  const { stdout } = await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop';" + command], { windowsHide: true, timeout: 20000, maxBuffer: 256 * 1024, env: childEnvironment });
  return JSON.parse(stdout.trim() || 'null');
};
let child, exit, identity, client, baseline;
const oldTemp = process.env.TEMP, oldTmp = process.env.TMP;
process.env.TEMP = temporary; process.env.TMP = temporary;
function stored() {
  const db = new DatabaseSync(dataset.dbPath, { readOnly: true });
  try {
    const state = JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload);
    return { settings: state.settings, sources: state.sources, connections: state.connections, localRoots: state.localRoots, categories: state.categories, skills: state.skills.map(skill => Object.fromEntries(['id', 'name', 'displayName', 'localPath', 'version', 'favorite', 'categoryId', 'localHashes', 'runtimeFiles'].map(key => [key, skill[key]]))), resources: db.prepare('SELECT id,revision,payload FROM resource_catalog ORDER BY id').all(), tasks: db.prepare("SELECT json_extract(payload,'$.id') id,json_extract(payload,'$.action') action,json_extract(payload,'$.status') status FROM task_history ORDER BY id").all() };
  } finally { db.close(); }
}
async function processSample() {
  const rows = await powershell(`
    $all=@(Get-CimInstance Win32_Process);$ids=[Collections.Generic.HashSet[int]]::new();[void]$ids.Add(${child.pid})
    do{$added=$false;foreach($row in $all){if($ids.Contains([int]$row.ParentProcessId)-and $ids.Add([int]$row.ProcessId)){$added=$true}}}while($added)
    @(foreach($row in $all){if(-not $ids.Contains([int]$row.ProcessId)){continue};$p=Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue;if(-not $p){continue}
      $role=if($row.ProcessId -eq ${child.pid}){'manager'}elseif($row.Name -eq 'msedgewebview2.exe'){if($row.CommandLine -match '--type=([a-zA-Z-]+)'){'webview-'+$Matches[1]}else{'webview-browser'}}else{'native-child'}
      $profileMatch=$false;$profilePresent=$false;$profileInside=$false;$ebProfileMatch=$false;$ownedBrowserProfile=$null
      if($role -eq 'webview-browser' -and $row.CommandLine -match '--user-data-dir=(?:"([^"]+)"|([^\\s]+))'){
        $profilePresent=$true;$value=$Matches[1];if(-not $value){$value=$Matches[2]};$actualProfile=[IO.Path]::GetFullPath($value)
        $profileMatch=$actualProfile.Equals(${ps(profile)},[StringComparison]::OrdinalIgnoreCase)
        $profileInside=$profileMatch -or $actualProfile.StartsWith(${ps(profile + '\\')},[StringComparison]::OrdinalIgnoreCase)
        $ebProfileMatch=$actualProfile.Equals(${ps(join(profile, 'EBWebView'))},[StringComparison]::OrdinalIgnoreCase)
        if($profileInside){$ownedBrowserProfile=$actualProfile}
      }
      $debugPortValue=$null;if($row.CommandLine -match '(?:^|\\s)--remote-debugging-port=(\\d{1,5})(?:\\s|$)'){$number=[int]$Matches[1];if($number -le 65535){$debugPortValue=$number}}
      [pscustomobject]@{pid=[int]$row.ProcessId;parentPid=[int]$row.ParentProcessId;creationFileTime=$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();path=$row.ExecutablePath;role=$role;profileMatch=$profileMatch;profilePresent=$profilePresent;profileInside=$profileInside;ebProfileMatch=$ebProfileMatch;ownedBrowserProfile=$ownedBrowserProfile;debugPortFlagPresent=($row.CommandLine -match '(?:^|\\s)--remote-debugging-port(?:=|\\s|$)');debugPortValue=$debugPortValue;addressFlagPresent=($row.CommandLine -match '(?:^|\\s)--remote-debugging-address(?:=|\\s|$)');portMatch=($row.CommandLine -match '(?:^|\\s)--remote-debugging-port=${policy.loopbackPort}(?:\\s|$)');addressMatch=($row.CommandLine -match '(?:^|\\s)--remote-debugging-address=127\\.0\\.0\\.1(?:\\s|$)');privateBytes=$p.PrivateMemorySize64;workingSetBytes=$p.WorkingSet64;cpuMs=$p.TotalProcessorTime.TotalMilliseconds}
    })|ConvertTo-Json -Compress`);
  const processes = Array.isArray(rows) ? rows : rows ? [rows] : [], manager = processes.find(row => row.pid === child.pid);
  assert.ok(manager && same(manager.path, executable), 'Owned candidate process disappeared or changed.');
  if (!identity) { identity = manager; report.native = manager; }
  assert.equal(manager.creationFileTime, identity.creationFileTime);
  assert.ok(processes.every(row => BigInt(row.creationFileTime) >= BigInt(identity.creationFileTime)));
  return { observedAt: new Date().toISOString(), privateBytes: processes.reduce((sum, row) => sum + row.privateBytes, 0), workingSetBytes: processes.reduce((sum, row) => sum + row.workingSetBytes, 0), processes, measuringNode: process.memoryUsage() };
}
class Cdp {
  constructor(socket) {
    this.socket = socket; this.nextId = 1; this.pending = new Map();
    socket.addEventListener('message', event => { const message = JSON.parse(event.data), pending = this.pending.get(message.id); if (!pending) return; clearTimeout(pending.timer); this.pending.delete(message.id); if (message.error) pending.reject(new Error(JSON.stringify(message.error))); else pending.resolve(message.result); });
    socket.addEventListener('close', () => { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Owned CDP connection closed.')); } this.pending.clear(); });
  }
  call(method, params = {}) {
    if (method.startsWith('Input.')) report.inputCalls[method] = (report.inputCalls[method] || 0) + 1;
    return new Promise((resolveCall, reject) => { const id = this.nextId++, timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout ' + method)); }, 15000); this.pending.set(id, { resolve: resolveCall, reject, timer }); try { this.socket.send(JSON.stringify({ id, method, params })); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
  }
  async read(expression) { const value = await this.call('Runtime.evaluate', { expression: `(() => {${dom};return (${expression});})()`, returnByValue: true, awaitPromise: true }); assert.ok(!value.exceptionDetails, JSON.stringify(value.exceptionDetails)); return value.result.value; }
}
const dom = `
  const visible=e=>!e.closest('[hidden]')&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
  const name=e=>e.getAttribute('aria-label')||e.textContent.trim();
  const all=s=>[...document.querySelectorAll(s)].filter(visible);
  const one=(s,n)=>{const es=all(s).filter(e=>n===undefined||name(e)===n);if(es.length!==1||es[0].disabled)throw Error('Expected unique enabled visible control '+s+' '+n);return es[0]};
  const rows=()=>all('[aria-label="可横向滚动的 Skill 列表"] button').filter(e=>/^Perf Skill \\d{4}$/.test(name(e))).map(name);
  const doc=()=>all('.detail-title h2').filter(e=>name(e)==='Perf Skill 0000').length===1&&all('[aria-label="Skill 详情"] [role="tab"]').some(e=>name(e)==='说明'&&e.getAttribute('aria-selected')==='true')&&all('article.markdown p').some(e=>name(e)==='仅用于隔离的本地性能验收，不调用外部程序，不连接远端。');
`;
async function ready(condition) {
  await client.read(`new Promise((done,fail)=>{let frames=0;const end=performance.now()+15000;const tick=()=>{if(${condition}){if(++frames===2)return done(true)}else frames=0;if(performance.now()>end)return fail(Error('DOM readiness timeout'));requestAnimationFrame(tick)};requestAnimationFrame(tick)})`);
}
async function click(selector, label) {
  const point = await client.read(`(()=>{const e=one(${JSON.stringify(selector)},${JSON.stringify(label)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);if(x<0||y<0||x>=innerWidth||y>=innerHeight||!(h===e||e.contains(h)))throw Error('Control is clipped or covered');return{x,y}})()`);
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await client.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...point });
  await client.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...point });
}
async function step(label, action, condition) { report.lastOperation = label; await action(); await ready(condition); }
async function search(index) {
  const key = String(index).padStart(4, '0'), value = 'perf-skill-' + key;
  await step('search-' + key, async () => {
    await click('input[aria-label="搜索 Skill"]');
    await client.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 });
    await client.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await client.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await client.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 0 });
    await client.call('Input.insertText', { text: value });
  }, `one('input[aria-label="搜索 Skill"]').value===${JSON.stringify(value)}&&rows().length===1&&rows()[0]===${JSON.stringify('Perf Skill ' + key)}`);
}
const clear = () => step('clear', () => click('button', '清空搜索'), `one('input[aria-label="搜索 Skill"]').value===''&&rows().length===20`);
async function navigate(index) {
  await search(index); await clear();
  await step('filter-github', () => click('[aria-label="来源筛选"] button', 'GitHub'), `one('[aria-label="来源筛选"] button','GitHub').getAttribute('aria-pressed')==='true'&&rows().length===0&&all('h2,h3,strong').some(e=>name(e)==='当前筛选无结果')`);
  await step('filter-all', () => click('[aria-label="来源筛选"] button', '全部'), `one('[aria-label="来源筛选"] button','全部').getAttribute('aria-pressed')==='true'&&rows().length===20`);
  await search(0);
  await step('open-document', () => click('[aria-label="可横向滚动的 Skill 列表"] button', 'Perf Skill 0000'), 'doc()');
  await step('tab-home', () => click('[aria-label="工作区标签"] [data-home="true"] [role="tab"]'), `one('[aria-label="工作区标签"] [data-home="true"] [role="tab"]').getAttribute('aria-selected')==='true'&&all('input[aria-label="搜索 Skill"]').length===1`);
  await step('tab-detail', () => click('[aria-label="工作区标签"] [role="tab"]', 'Perf Skill 0000'), 'doc()');
  await step('close-document', () => click('button[aria-label="关闭 Perf Skill 0000"]'), `document.querySelectorAll('button[aria-label="关闭 Perf Skill 0000"]').length===0&&all('input[aria-label="搜索 Skill"]').length===1`);
  await clear();
}
async function sample(phase) { report.samples.push({ phase, ...await processSample() }); await save(); }
async function quitFailedOwnedWindow() {
  assert.ok(identity, 'No pinned creation identity is available for safe native cleanup.');
  const spec = Buffer.from(JSON.stringify({ ...identity, candidateSha256 }), 'utf8').toString('base64');
  const command = String.raw`
    $spec=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${spec}'))|ConvertFrom-Json
    Add-Type -AssemblyName UIAutomationClient;Add-Type -AssemblyName UIAutomationTypes
    Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class NormalDiagnosticQuit{[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr handle,out uint pid);}'
    $owned=[Diagnostics.Process]::GetProcessById([int]$spec.pid);$script:ownedWindow=[IntPtr]::Zero
    function Assert-Owned {
      $owned.Refresh()
      if($owned.HasExited -or $owned.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne $spec.creationFileTime){throw 'Pinned process identity changed.'}
      if(-not [string]::Equals([IO.Path]::GetFullPath($owned.MainModule.FileName),[IO.Path]::GetFullPath($spec.path),[StringComparison]::OrdinalIgnoreCase)){throw 'Pinned executable path changed.'}
      if((Get-FileHash -LiteralPath $owned.MainModule.FileName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $spec.candidateSha256){throw 'Pinned executable content changed.'}
      if($script:ownedWindow -ne [IntPtr]::Zero){[uint32]$owner=0;[void][NormalDiagnosticQuit]::GetWindowThreadProcessId($script:ownedWindow,[ref]$owner);if($owner -ne $owned.Id){throw 'Pinned window owner changed.'}}
    }
    function Wait-Until([scriptblock]$condition,[string]$message){$timer=[Diagnostics.Stopwatch]::StartNew();while($timer.ElapsedMilliseconds -lt 10000){if(& $condition){return};Start-Sleep -Milliseconds 100};throw $message}
    function Find-Owned([string]$name){
      Assert-Owned
      $root=[Windows.Automation.AutomationElement]::FromHandle($script:ownedWindow)
      $condition=[Windows.Automation.AndCondition]::new([Windows.Automation.Condition[]]@(
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,$name),
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Button),
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::IsOffscreenProperty,$false)))
      $found=$root.FindAll([Windows.Automation.TreeScope]::Descendants,$condition)
      if($found.Count -gt 1){throw 'Ambiguous owned cleanup button.'};if($found.Count -eq 1 -and $found[0].Current.IsEnabled){return $found[0]};return $null
    }
    function Invoke-Owned($button){Assert-Owned;$pattern=$null;if(-not $button.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){throw 'Owned cleanup button has no native Invoke pattern.'};$pattern.Invoke()}
    try{
      Wait-Until {Assert-Owned;$owned.Refresh();if($owned.MainWindowHandle -eq [IntPtr]::Zero){return $false};$script:ownedWindow=$owned.MainWindowHandle;Assert-Owned;return $true} 'Owned cleanup window unavailable.'
      $quit=Find-Owned '完全退出管理器'
      if(-not $quit){$help=Find-Owned '工作区快捷键';if(-not $help){throw 'Owned normal Quit is unavailable without desktop input.'};Invoke-Owned $help;Wait-Until {$script:quit=Find-Owned '完全退出管理器';$null -ne $script:quit} 'Owned normal Quit did not appear.';$quit=$script:quit}
      Invoke-Owned $quit
      if(-not $owned.WaitForExit(15000)){throw 'Owned normal Quit did not exit. No forced termination was attempted.'}
      [pscustomobject]@{exited=$true;exitCode=$owned.ExitCode;method='failure-only-owned-native-quit-invoke';pid=$spec.pid;creationFileTime=$spec.creationFileTime;executableSha256=$spec.candidateSha256;windowHandle=$script:ownedWindow.ToInt64();foregroundActivation=$false;osInputSent=$false}|ConvertTo-Json -Compress
    }finally{$owned.Dispose()}
  `;
  const encoded = Buffer.from("$ErrorActionPreference='Stop';" + command, 'utf16le').toString('base64');
  assert.ok(encoded.length < 28000, 'Bounded native cleanup exceeds the Windows command-line limit.');
  const { stdout } = await execute('pwsh.exe', ['-STA', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 50000, maxBuffer: 32 * 1024, env: childEnvironment });
  return JSON.parse(stdout.trim());
}
try {
  await save(); await assertNoUserManager();
  const listeners = await powershell(`@((Get-NetTCPConnection -State Listen -LocalPort ${policy.loopbackPort} -ErrorAction SilentlyContinue))|Measure-Object|Select-Object -ExpandProperty Count|ConvertTo-Json`);
  assert.equal(listeners, 0, 'The chosen loopback port is occupied.');
  assert.equal(await digest(executable), candidateSha256);
  child = spawn(executable, ['--data-dir', dataset.dataDir], { cwd: candidateRoot, env: childEnvironment, stdio: 'ignore', windowsHide: false });
  child.on('error', error => { exit = { spawnError: String(error) }; }); child.on('exit', (code, signal) => { exit = { code, signal }; });
  await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); }); report.launchedPid = child.pid; await save();
  let target, previousStartupSignature, previousListenerSignature;
  report.startupObservations = [];
  report.listenerObservations = [];
  for (const deadline = performance.now() + 30000; performance.now() < deadline;) {
    if (exit) throw new Error('Owned candidate exited before CDP attachment.');
    const observed = await processSample();
    const ownBrowserRows = observed.processes.filter(row => row.role === 'webview-browser');
    for (const browser of ownBrowserRows) {
      browser.profileAllowed = browser.profileMatch || browser.ebProfileMatch;
      if (browser.profileAllowed) {
        assert.ok(typeof browser.ownedBrowserProfile === 'string' && (same(browser.ownedBrowserProfile, profile) || same(browser.ownedBrowserProfile, join(profile, 'EBWebView'))), 'Browser profile is not the exact configured root or its fixed EBWebView directory.');
        await ownedPath(profile); await ownedPath(browser.ownedBrowserProfile);
        browser.profileRealpathVerified = true;
      }
    }
    const profileBrowsers = ownBrowserRows.filter(row => row.profileAllowed && row.profileRealpathVerified);
    const browsers = profileBrowsers.filter(row => row.portMatch);
    const ownBrowsers = ownBrowserRows.map(({ pid, creationFileTime, profilePresent, profileMatch, profileInside, ebProfileMatch, profileAllowed, profileRealpathVerified, ownedBrowserProfile, debugPortFlagPresent, debugPortValue, addressFlagPresent, portMatch, addressMatch }) => ({ pid, creationFileTime, profilePresent, profileMatch, profileInside, ebProfileMatch, profileAllowed, profileRealpathVerified: !!profileRealpathVerified, ownedBrowserProfile, debugPortFlagPresent, debugPortValue, addressFlagPresent, portMatch, addressMatch }));
    const signature = JSON.stringify(ownBrowsers);
    if (signature !== previousStartupSignature) { report.startupObservations.push({ observedAt: observed.observedAt, browsers: ownBrowsers }); previousStartupSignature = signature; }
    await save();
    if (profileBrowsers.length === 1) {
      const owners = await powershell(`@(Get-NetTCPConnection -State Listen -LocalPort ${policy.loopbackPort} -ErrorAction SilentlyContinue|Select-Object LocalAddress,OwningProcess)|ConvertTo-Json -Compress`), current = Array.isArray(owners) ? owners : owners ? [owners] : [];
      const listeners = current.map(row => ({ ownerPid: row.OwningProcess, address: ['127.0.0.1', '::1'].includes(row.LocalAddress) ? row.LocalAddress : 'non-loopback', ownerMatchesBoundBrowser: row.OwningProcess === profileBrowsers[0].pid, ownerCreationFileTime: observed.processes.find(process => process.pid === row.OwningProcess)?.creationFileTime || null }));
      const listenerState = { boundBrowserPid: profileBrowsers[0].pid, boundBrowserCreationFileTime: profileBrowsers[0].creationFileTime, expectedPort: policy.loopbackPort, requiredCommandLinePortMatches: browsers.length === 1, listeners };
      const listenerSignature = JSON.stringify(listenerState);
      if (listenerSignature !== previousListenerSignature) { report.listenerObservations.push({ observedAt: new Date().toISOString(), ...listenerState }); previousListenerSignature = listenerSignature; }
      await save();
      if (browsers.length === 1 && current.length) {
        assert.ok(current.every(row => ['127.0.0.1', '::1'].includes(row.LocalAddress) && row.OwningProcess === browsers[0].pid), 'CDP listener is not exclusively owned loopback.');
        const response = await fetch(`http://127.0.0.1:${policy.loopbackPort}/json/list`, { redirect: 'error', signal: AbortSignal.timeout(1500) }); assert.ok(response.ok);
        const pages = (await response.json()).filter(page => page.type === 'page');
        assert.ok(pages.length <= 1, 'Require at most one owned app page during startup.');
        if (!pages.length || pages[0].url === 'about:blank') { await sleep(250); continue; }
        const url = new URL(pages[0].url), socket = new URL(pages[0].webSocketDebuggerUrl);
        assert.ok(['http:', 'https:'].includes(url.protocol) && url.hostname === 'tauri.localhost' || url.protocol === 'tauri:' && url.hostname === 'localhost');
        assert.equal(socket.protocol, 'ws:'); assert.equal(socket.hostname, '127.0.0.1'); assert.equal(Number(socket.port), policy.loopbackPort); assert.ok(socket.pathname.startsWith('/devtools/page/'));
        target = pages[0]; report.connection = { browser: browsers[0], listeners: current, targetId: target.id, url: target.url }; break;
      }
    }
    await sleep(250);
  }
  assert.ok(target, 'No exact owned normal-candidate CDP target was confirmed.');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, reject) => { const timer = setTimeout(() => { socket.close(); reject(new Error('CDP open timeout')); }, 10000); socket.addEventListener('open', () => { clearTimeout(timer); done(); }, { once: true }); socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }, { once: true }); });
  client = new Cdp(socket);
  await ready(`all('input[aria-label="搜索 Skill"]').length===1&&rows().length===20`); await sleep(policy.settleMs);
  baseline = stored(); assert.ok(baseline.tasks.every(task => !['running', 'queued'].includes(task.status)));
  await sample('before-cycles');
  const started = performance.now();
  for (let index = 0; index < policy.cycles; index++) {
    await sleep(started + index * policy.cycleIntervalMs - performance.now());
    const before = performance.now(); await navigate(index + 1); report.cycles.push({ cycle: index + 1, startedElapsedMs: before - started, finishedElapsedMs: performance.now() - started, logicalSteps: 10 });
    if ((index + 1) % 10 === 0) await sample('cycles-' + (index + 1));
  }
  await sleep(policy.idleMs); await sample('idle-10s'); await sleep(policy.idleMs); await sample('idle-20s');
  assert.deepEqual(stored(), baseline); assert.deepEqual(await runtimeFiles(dataset), descriptor.runtimeFiles);
  report.managedDataUnchanged = true; report.runtimeFilesUnchanged = true; report.status = 'short-diagnostic-measurements-collected';
} catch (error) { report.status = 'failed'; report.error = String(error.stack || error); process.exitCode = 1; }
finally {
  if (child && !exit && client) {
    try {
      if (!await client.read(`all('button').some(e=>name(e)==='完全退出管理器')`)) { await click('button', '工作区快捷键'); await ready(`all('button').some(e=>name(e)==='完全退出管理器')`); }
      await click('button', '完全退出管理器');
      for (const deadline = performance.now() + 15000; !exit && performance.now() < deadline;) await sleep(100);
      report.normalExit = Boolean(exit && exit.code === 0); if (report.normalExit) report.quitMethod = 'cdp-browser-input-quit';
    } catch (error) { report.quitError = String(error); }
  }
  if (child && !exit) {
    report.status = 'failed'; process.exitCode = 1; report.uiaUsed = true; report.mixedFailureCleanup = true;
    try {
      report.nativeFailureCleanup = await quitFailedOwnedWindow();
      for (const deadline = performance.now() + 2000; !exit && performance.now() < deadline;) await sleep(50);
      report.normalExit = Boolean(report.nativeFailureCleanup.exited && report.nativeFailureCleanup.exitCode === 0 && exit?.code === 0);
      if (report.normalExit) report.quitMethod = report.nativeFailureCleanup.method;
    } catch (error) { report.nativeFailureCleanupError = String(error); }
  }
  client?.socket.close();
  report.exit = exit || null; report.remainingOwnedProcessRequiresAttention = Boolean(child && !exit); if (child && !exit) child.unref();
  if (baseline && report.normalExit) {
    try { assert.deepEqual(stored(), baseline); report.managedDataUnchangedAfterExit = true; }
    catch (error) { report.status = 'failed'; report.persistedDataError = String(error); process.exitCode = 1; }
  }
  if (!report.normalExit && child) { report.status = 'failed'; process.exitCode = 1; }
  report.cdpOnlyShortDiagnosticCompleted = report.status === 'short-diagnostic-measurements-collected' && report.normalExit && !report.uiaUsed;
  report.finishedAt = new Date().toISOString(); await save();
  if (oldTemp === undefined) delete process.env.TEMP; else process.env.TEMP = oldTemp;
  if (oldTmp === undefined) delete process.env.TMP; else process.env.TMP = oldTmp;
}
console.log(json({ status: report.status, reportPath, normalExit: report.normalExit, nativeAcceptanceClaim: false }));
