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

const approved = 'D:\\03_github_projects\\Agent_Management\\Agent_Resource_Manager\\validation\\manager-data';
const format = 'agent-resource-manager-native-workspace-final-state-v1';
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const same = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase();
const inside = (path, root) => { const part = relative(root, path); return part === '' || !part.startsWith('..') && !isAbsolute(part); };
const execute = promisify(execFile);
const sleep = ms => new Promise(done => setTimeout(done, ms));

export function finalStateArguments(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    assert.ok(['--help', '--phase', '--fixture', '--candidate', '--candidate-build-info'].includes(key), 'Unknown final-state argument.');
    assert.ok(!Object.hasOwn(args, key), 'Duplicate final-state argument.');
    if (key === '--help') args[key] = true;
    else { const value = argv[++index]; assert.ok(value && !value.startsWith('--'), `Missing value for ${key}.`); args[key] = value; }
  }
  if (args['--help']) return { help: true };
  assert.ok(['prepare', 'run'].includes(args['--phase']), 'Use explicit --phase prepare or run.');
  if (args['--phase'] === 'prepare') assert.equal(Object.keys(args).length, 1, 'Prepare accepts no existing fixture or program.');
  else for (const key of ['--fixture', '--candidate', '--candidate-build-info']) assert.ok(args[key], `Run requires ${key}.`);
  return { phase: args['--phase'], fixture: args['--fixture'], candidate: args['--candidate'], info: args['--candidate-build-info'] };
}

function matchingBounds(actual, expected) {
  return actual && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(actual[key]) && Number.isFinite(expected[key]) && Math.abs(actual[key] - expected[key]) <= 1) && actual.maximized === false;
}

export function assertFinalWorkspace(workspace, expected) {
  assert.equal(expected.length, 2, 'Two exact window expectations are required.');
  assert.equal(new Set(expected.map(target => target.label)).size, 2);
  assert.equal(new Set(expected.map(target => target.paneId)).size, 2);
  assert.equal(workspace?.windows?.length, 2, 'Exactly two saved native windows are required.');
  for (const target of expected) {
    const windows = workspace.windows.filter(window => window.label === target.label);
    assert.equal(windows.length, 1, 'A saved native window is missing or duplicated.');
    const owner = windows[0], panes = owner.panes.filter(pane => pane.id === target.paneId);
    assert.equal(panes.length, 1, 'The exact transferred pane is missing or duplicated.');
    assert.equal(owner.activePaneId, target.paneId, 'The last selected pane was lost.');
    assert.equal(panes[0].kind, 'detail'); assert.equal(panes[0].skillId, target.skillId);
    assert.equal(panes[0].state?.section, target.section, 'The last detail section was lost.');
    assert.ok(matchingBounds(owner.bounds, target.bounds), 'Final native geometry was not saved.');
    assert.equal(workspace.windows.flatMap(window => window.panes).filter(pane => pane.id === target.paneId).length, 1, 'Two windows claim the same pane.');
  }
  return true;
}

export function pendingFinalBounds(workspace, expected) {
  return expected.some(target => !matchingBounds(workspace?.windows?.find(window => window.label === target.label)?.bounds, target.bounds));
}

function stored(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const state = JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload);
    const row = db.prepare('SELECT payload FROM workspace_state WHERE id=1').get();
    return { state, workspace: row ? JSON.parse(row.payload) : null };
  } finally { db.close(); }
}

async function wait(read, accepts, label) {
  const deadline = Date.now() + 20000;
  for (;;) {
    const value = await read(); if (accepts(value)) return value;
    assert.ok(Date.now() < deadline, `Final-state observation timed out: ${label}. No action was replayed.`);
    await sleep(75);
  }
}

async function invoke(app, name, scope) {
  if (scope) await wait(() => app.call('state', { name: scope }), value => {
    const available = list(value).filter(row => row.enabled && !row.offscreen);
    assert.ok(available.length <= 1, `The exact native observation scope is ambiguous: ${scope}.`);
    return available.length === 1;
  }, `exact observation scope ${scope}`);
  await wait(() => app.call('state', { name, ...(scope ? { scope } : {}) }), value => list(value).filter(row => row.type === 'ControlType.Button' && row.enabled && !row.offscreen).length === 1, name);
  await app.call('invokeName', { name, ...(scope ? { scope } : {}) });
}

// This bounded helper operates only on a live HWND belonging to the exact
// launched process, workspace label and selected pane. It never focuses a window.
async function windowState(app, fixture, target, mode = 'read') {
  assert.ok(['read', 'select', 'resize'].includes(mode));
  const payload = Buffer.from(JSON.stringify({ ...target, mode, pid: app.identity.pid, created: app.identity.creationFileTime, main: app.identity.windowHandle, homeId: `tab-${encodeURIComponent(target.label === 'main' ? 'home' : `home:${target.label}`)}`, tabId: `tab-${encodeURIComponent(target.paneId)}` })).toString('base64');
  const command = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class FinalStateWindow
{
    public delegate bool Visitor(IntPtr window, IntPtr state);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr window);

    [DllImport("user32.dll")]
    public static extern bool IsZoomed(IntPtr window);

    [DllImport("user32.dll")]
    public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    [DllImport("user32.dll")]
    static extern bool EnumWindows(Visitor visitor, IntPtr state);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetClassName(IntPtr window, StringBuilder name, int count);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr window, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool GetClientRect(IntPtr window, out RECT rect);

    [DllImport("user32.dll")]
    public static extern uint GetDpiForWindow(IntPtr window);

    public static IntPtr[] Owned(uint expectedProcessId)
    {
        var result = new List<IntPtr>();
        EnumWindows((window, state) =>
        {
            uint ownerProcessId;
            GetWindowThreadProcessId(window, out ownerProcessId);
            var className = new StringBuilder(80);
            GetClassName(window, className, className.Capacity);
            if (ownerProcessId == expectedProcessId && IsWindowVisible(window) && className.ToString() == "Tauri Window")
            {
                result.Add(window);
            }
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }
}
'@
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$previousDpiContext = [FinalStateWindow]::SetThreadDpiAwarenessContext([IntPtr](-4))
if ($previousDpiContext -eq [IntPtr]::Zero) {
    throw 'Native geometry DPI context could not be established.'
}

function Identity {
    $ownedProcess = Get-Process -Id $request.pid
    if ($ownedProcess.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne $request.created) {
        throw 'Final-state process identity changed.'
    }
    $ownerProcessId = [uint32]0
    [void][FinalStateWindow]::GetWindowThreadProcessId([IntPtr]([long]$request.main), [ref]$ownerProcessId)
    if ($ownerProcessId -ne $request.pid) {
        throw 'Main window identity changed.'
    }
}

function Exact($controlRoot, $property, $value, $controlType) {
    $conditions = [Windows.Automation.Condition[]]@(
        [Windows.Automation.PropertyCondition]::new($property, $value),
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, $controlType)
    )
    $foundControls = $controlRoot.FindAll(
        [Windows.Automation.TreeScope]::Descendants,
        [Windows.Automation.AndCondition]::new($conditions)
    )
    $availableControls = @($foundControls | Where-Object { -not $_.Current.IsOffscreen -and $_.Current.IsEnabled })
    if ($availableControls.Count -gt 1) {
        throw 'Final-state exact native control is ambiguous.'
    }
    if ($availableControls.Count -eq 1) {
        return $availableControls[0]
    }
    return $null
}

$clock = [Diagnostics.Stopwatch]::StartNew()
$windowMatches = @()
while ($clock.ElapsedMilliseconds -lt 15000) {
    Identity
    $windowMatches = @()
    foreach ($candidateWindow in [FinalStateWindow]::Owned([uint32]$request.pid)) {
        $candidateRoot = [Windows.Automation.AutomationElement]::FromHandle($candidateWindow)
        $homeTabElement = Exact $candidateRoot ([Windows.Automation.AutomationElement]::AutomationIdProperty) $request.homeId ([Windows.Automation.ControlType]::TabItem)
        $paneTabElement = Exact $candidateRoot ([Windows.Automation.AutomationElement]::AutomationIdProperty) $request.tabId ([Windows.Automation.ControlType]::TabItem)
        if ($null -ne $homeTabElement -and $null -ne $paneTabElement) {
            $windowMatches += ,@{ window = $candidateWindow; root = $candidateRoot; pane = $paneTabElement }
        }
    }
    if ($windowMatches.Count -gt 1) {
        throw 'Two native windows claim the same workspace label and pane.'
    }
    if ($windowMatches.Count -eq 1) {
        break
    }
    Start-Sleep -Milliseconds 75
}
if ($windowMatches.Count -ne 1) {
    throw 'The exact native workspace window was not found.'
}
$ownedWindow = $windowMatches[0]
$windowHandle = $ownedWindow.window
if ([FinalStateWindow]::IsIconic($windowHandle)) {
    throw 'The owned final-state window is minimized; it was not restored.'
}
if ([FinalStateWindow]::IsZoomed($windowHandle)) {
    throw 'The owned final-state window is unexpectedly maximized.'
}
if (-not $ownedWindow.pane.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected) {
    throw 'The expected workspace pane is not selected.'
}
$sectionTab = Exact $ownedWindow.root ([Windows.Automation.AutomationElement]::NameProperty) $request.sectionName ([Windows.Automation.ControlType]::TabItem)
if ($null -eq $sectionTab) {
    throw 'The exact detail section tab is not available.'
}
Identity
if ($request.mode -eq 'select') {
    $sectionTab.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select()
}
if ($request.mode -eq 'resize') {
    if (-not [FinalStateWindow]::SetWindowPos($windowHandle, [IntPtr]::Zero, 260, 160, 1000, 720, 0x0004 -bor 0x0010)) {
        throw 'Owned secondary window resize failed.'
    }
}
$clock.Restart()
while (-not $sectionTab.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected) {
    if ($clock.ElapsedMilliseconds -gt 10000) {
        throw 'The detail section did not become selected.'
    }
    Start-Sleep -Milliseconds 50
}
Identity
$outerRect = [FinalStateWindow+RECT]::new()
$clientRect = [FinalStateWindow+RECT]::new()
if (-not [FinalStateWindow]::GetWindowRect($windowHandle, [ref]$outerRect) -or -not [FinalStateWindow]::GetClientRect($windowHandle, [ref]$clientRect)) {
    throw 'Actual native geometry could not be read.'
}
$windowDpi = [FinalStateWindow]::GetDpiForWindow($windowHandle)
if ($windowDpi -eq 0) {
    throw 'Actual native window DPI is unavailable.'
}
$windowScale = $windowDpi / 96.0
[void][FinalStateWindow]::SetThreadDpiAwarenessContext($previousDpiContext)
[ordered]@{
    pid = $request.pid
    created = $request.created
    window = $windowHandle.ToInt64()
    label = $request.label
    paneId = $request.paneId
    sectionName = $request.sectionName
    sectionSelected = $true
    bounds = @{
        x = $outerRect.Left / $windowScale
        y = $outerRect.Top / $windowScale
        width = ($clientRect.Right - $clientRect.Left) / $windowScale
        height = ($clientRect.Bottom - $clientRect.Top) / $windowScale
        maximized = $false
    }
    noForegroundInput = $true
} | ConvertTo-Json -Depth 4 -Compress`;
  assert.ok(command.length * 2 < 30000, 'The bounded native helper command is too long.');
  const { stdout } = await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 30000, maxBuffer: 128 * 1024, env: { ...process.env, TEMP: join(fixture.dataset.root, 'driver-temp'), TMP: join(fixture.dataset.root, 'driver-temp') } });
  const result = JSON.parse(stdout.trim()); assert.equal(result.pid, app.identity.pid); assert.equal(String(result.created), app.identity.creationFileTime); assert.equal(result.label, target.label); assert.equal(result.paneId, target.paneId); assert.equal(result.sectionName, target.sectionName); assert.equal(result.sectionSelected, true);
  if (target.label === 'main') assert.equal(result.window, app.identity.windowHandle); else assert.notEqual(result.window, app.identity.windowHandle);
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Number.isFinite(result.bounds[key]));
  assert.ok(result.bounds.width >= 640 && result.bounds.height >= 480);
  return result;
}

async function main() {
  const args = finalStateArguments(process.argv.slice(2));
  if (args.help) { console.log('Prepare --phase prepare. Run --phase run --fixture <final-state-fixture.json> --candidate <normal-release.exe> --candidate-build-info <json>. Two exact native windows, different final detail sections and geometry, normal full quit and same-data reopen. Pending geometry is observed only. No draft-across-exit, IME or performance claim.'); return; }
  if (args.phase === 'prepare') {
    await mkdir(approved, { recursive: true }); const root = await mkdtemp(join(approved, 'native-workspace-final-state-'));
    const dataset = await createPerformanceFixture(root, 'workspace-fixture', 0);
    const fixture = { format, syntheticOnly: true, root, dataset, initialDatabaseSha256: await digest(dataset.dbPath) };
    const path = join(root, 'final-state-fixture.json'); await writeFile(path, json(fixture), { flag: 'wx' });
    console.log(json({ status: 'prepared-not-run', fixture: path, noNativeLaunch: true })); return;
  }
  const descriptor = resolve(args.fixture), fixture = JSON.parse(await readFile(descriptor, 'utf8'));
  assert.equal(fixture.format, format); assert.equal(fixture.syntheticOnly, true); assert.ok(same(dirname(descriptor), fixture.root) && inside(fixture.root, approved));
  assert.equal(fixture.dataset.format, FIXTURE_FORMAT); assert.ok(same(fixture.dataset.root, join(fixture.root, 'workspace-fixture')) && same(fixture.dataset.dataDir, join(fixture.dataset.root, 'data')) && same(fixture.dataset.dbPath, join(fixture.dataset.dataDir, 'manager.sqlite3')));
  assert.ok(same(fixture.dataset.skillsRoot, join(fixture.dataset.root, 'skills')) && same(fixture.dataset.toolsRoot, join(fixture.dataset.root, 'tools')));
  for (const path of [fixture.root, fixture.dataset.root, fixture.dataset.dataDir, fixture.dataset.dbPath, fixture.dataset.skillsRoot]) assert.ok(same(await realpath(path), path), 'A synthetic fixture path resolves elsewhere.');
  const marker = JSON.parse(await readFile(join(fixture.dataset.root, 'fixture-owner.json'), 'utf8')); assert.equal(marker.format, FIXTURE_FORMAT); assert.equal(marker.syntheticOnly, true);
  assert.equal(await digest(fixture.dataset.dbPath), fixture.initialDatabaseSha256, 'A previously used fixture cannot be replayed.');
  const original = stored(fixture.dataset.dbPath).state; assert.equal(stored(fixture.dataset.dbPath).workspace, null);
  assert.equal(original.sources.length, 0); assert.equal(original.connections.length, 0);
  for (const skill of original.skills) {
    assert.ok(inside(skill.localPath, fixture.dataset.skillsRoot)); assert.ok(same(await realpath(skill.localPath), skill.localPath));
    assert.ok(!skill.sourceId, 'The synthetic fixture cannot access a remote source.');
  }
  const executable = resolve(args.candidate), infoPath = resolve(args.info), info = JSON.parse(await readFile(infoPath, 'utf8'));
  assert.equal(basename(executable), 'agent-resource-manager.exe'); assert.equal(info.buildMode, 'release'); assert.equal(await digest(executable), info.executableSha256); assert.ok(info.sourceIdentity || info.sourceCommit);
  const reportPath = join(fixture.root, 'final-state-result.json');
  const report = { format, status: 'running', syntheticOnly: true, fixture: fixture.root, startedAt: new Date().toISOString(), candidate: { executable, sha256: info.executableSha256, sourceIdentity: info.sourceIdentity || info.sourceCommit }, results: {}, limitations: ['Actual detail navigation and final window geometry only; no pointer drag, keyboard, IME or performance acceptance.', 'Operation drafts are session-only and are not required or allowed to persist across a full process exit.', 'No public network, resource execution, registration, backup, cleanup, direct state write or private user data is used.'] };
  report.harness = await Promise.all(['verify-native-workspace-final-state.mjs', 'native-uia-client.mjs', 'verify-native-uia.ps1', 'performance-fixture.mjs'].map(async name => ({ name, sha256: await digest(fileURLToPath(new URL(name, import.meta.url))) })));
  await writeFile(reportPath, json(report), { flag: 'wx' });
  let app;
  try {
    const launch = async phase => NativeUiaSession.launch({ executable, sha256: info.executableSha256, dataDir: fixture.dataset.dataDir, reportPath: join(fixture.dataset.root, `${phase}-driver.json`), accessibilityInput: true, workbenchOnlyReadiness: true });
    app = await launch('initial'); report.initialNative = app.identity;
    report.step = 'open-two-distinct-details'; await invoke(app, 'Skills', '主要导航');
    await wait(() => app.call('state', { name: '搜索 Skill' }), value => list(value).some(row => row.type === 'ControlType.Edit' && !row.offscreen && row.enabled), 'Skills search');
    await app.call('search', { index: 0 }); await app.call('openDocument', { index: 0 });
    const first = await wait(() => stored(fixture.dataset.dbPath).workspace, state => state?.windows?.find(window => window.label === 'main')?.panes?.some(pane => pane.kind === 'detail'), 'first detail navigation');
    const mainPane = first.windows.find(window => window.label === 'main').panes.filter(pane => pane.kind === 'detail'); assert.equal(mainPane.length, 1);
    await app.call('tab', { home: true }); await app.call('search', { index: 1 }); await app.call('openDocument', { index: 1 });
    const second = await wait(() => stored(fixture.dataset.dbPath).workspace, state => state?.windows?.find(window => window.label === 'main')?.panes?.filter(pane => pane.kind === 'detail').length === 2, 'second detail navigation');
    const secondPane = second.windows.find(window => window.label === 'main').panes.filter(pane => pane.kind === 'detail' && pane.id !== mainPane[0].id); assert.equal(secondPane.length, 1);
    report.step = 'detach-second-detail'; await invoke(app, '将当前标签移至独立窗口');
    const moved = await wait(() => stored(fixture.dataset.dbPath).workspace, state => state?.windows?.some(window => window.label !== 'main' && window.panes.some(pane => pane.id === secondPane[0].id)), 'committed secondary ownership');
    const owners = moved.windows.filter(window => window.label !== 'main' && window.panes.some(pane => pane.id === secondPane[0].id)); assert.equal(owners.length, 1); assert.match(owners[0].label, /^workspace-[a-f0-9-]{36}$/);
    const targets = [{ label: 'main', paneId: mainPane[0].id, skillId: mainPane[0].skillId, section: 'files', sectionName: '文件' }, { label: owners[0].label, paneId: secondPane[0].id, skillId: secondPane[0].skillId, section: 'source', sectionName: '来源与连接' }];
    report.step = 'set-distinct-final-sections'; await app.call('selectTab', { name: 'Perf Skill 0000' }); await windowState(app, fixture, targets[0], 'select');
    await windowState(app, fixture, targets[1], 'select');
    await wait(() => stored(fixture.dataset.dbPath).workspace, state => targets.every(target => state?.windows?.find(window => window.label === target.label)?.panes?.find(pane => pane.id === target.paneId)?.state?.section === target.section), 'both final detail sections');
    report.step = 'set-pending-native-geometry'; await app.call('resize', { width: 1100, height: 780 }); await windowState(app, fixture, targets[1], 'resize');
    report.results.beforeClose = [];
    for (const target of targets) { const actual = await windowState(app, fixture, target); target.bounds = actual.bounds; report.results.beforeClose.push(actual); }
    assert.notEqual(report.results.beforeClose[0].window, report.results.beforeClose[1].window);
    report.results.pendingFinalGeometryObserved = pendingFinalBounds(stored(fixture.dataset.dbPath).workspace, targets);
    report.step = 'first-full-normal-quit'; report.firstNormalExit = (await app.quit()).driverReport.closedNormally; app = null;
    const saved = stored(fixture.dataset.dbPath).workspace; assertFinalWorkspace(saved, targets); report.results.savedAfterFullExit = saved;
    report.step = 'reopen-same-data'; app = await launch('reopen'); report.reopenedNative = app.identity;
    assert.notEqual(app.identity.creationFileTime, report.initialNative.creationFileTime);
    report.results.reopenedWindows = [];
    for (const target of targets) { const actual = await windowState(app, fixture, target); assert.ok(matchingBounds(actual.bounds, target.bounds), 'The reopened actual native geometry differs.'); report.results.reopenedWindows.push(actual); }
    assertFinalWorkspace(stored(fixture.dataset.dbPath).workspace, targets);
    const tasks = (await app.call('tasks')).tasks;
    assert.deepEqual(tasks.filter(task => /^(scan_local|register_|apply_|preview_resource_|grant_|run_resource|resource_invoke|import_configuration)/.test(task.action)), []);
    const after = stored(fixture.dataset.dbPath).state; assert.equal(after.skills.length, original.skills.length);
    for (const key of ['localRoots', 'sources', 'connections']) assert.deepEqual(after[key], original[key]);
    for (const skill of original.skills) { const current = after.skills.find(item => item.id === skill.id); for (const key of ['name', 'localPath', 'runtimeFiles', 'localHashes', 'favorite', 'categoryId']) assert.deepEqual(current[key], skill[key]); assert.equal(await digest(join(skill.localPath, 'SKILL.md')), skill.localHashes['SKILL.md']); }
    report.results.resourceFilesAndStateUnchanged = true; report.results.noResourceMutationTasks = true;
    report.step = 'second-full-normal-quit'; report.secondNormalExit = (await app.quit()).driverReport.closedNormally; app = null;
    assertFinalWorkspace(stored(fixture.dataset.dbPath).workspace, targets); assert.equal(await digest(executable), info.executableSha256);
    report.status = 'passed-two-native-windows-final-navigation-and-geometry';
  } catch (error) { report.status = 'failed-or-blocked'; report.error = String(error); report.errorStack = error.stack; process.exitCode = 1; }
  finally {
    if (app) { try { report.cleanupNormalExit = (await app.quit()).driverReport.closedNormally; } catch (error) { report.cleanupError = String(error); } }
    report.finishedAt = new Date().toISOString(); await writeFile(reportPath, json(report)); console.log(json({ status: report.status, report: reportPath, firstNormalExit: report.firstNormalExit || false, secondNormalExit: report.secondNormalExit || false, error: report.error || null }));
  }
}

if (process.argv[1] && same(process.argv[1], fileURLToPath(import.meta.url))) await main();
