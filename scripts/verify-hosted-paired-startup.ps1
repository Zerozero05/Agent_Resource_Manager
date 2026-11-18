param(
    [Parameter(Mandatory)][string]$Reference,
    [Parameter(Mandatory)][string]$Candidate
)

$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or
    -not [Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {
    throw 'This probe requires a fresh interactive hosted Windows runner.'
}
$base = 'D:\03_github_projects\Agent_Management\Agent_Resource_Manager\validation\manager-data'
if (-not (Test-Path -LiteralPath 'D:\' -PathType Container) -or (Test-Path -LiteralPath $base) -or
    @(Get-Process -Name agent-resource-manager,skill-manager -ErrorAction SilentlyContinue).Count) {
    throw 'Expected an unused D-drive fixture root and no existing manager.'
}
$cases = @(
    [ordered]@{ name='reference-371eb5d'; path=$Reference; sha='f33c6722446e8069414fb04c85c411e8a3c5c06999e93f3ebadcf27d42b779e9' }
    [ordered]@{ name='candidate-3f703b1'; path=$Candidate; sha='f8e240df74644942c929cc8d0ad699e1369c7a51cedab662620e8152c4ab41af' }
)
foreach ($case in $cases) {
    $case.path = (Resolve-Path -LiteralPath $case.path).ProviderPath
    if ([IO.Path]::GetFileName($case.path) -cne 'agent-resource-manager.exe' -or
        (Get-FileHash -LiteralPath $case.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $case.sha) {
        throw "Executable identity failed for $($case.name)."
    }
}

$output = Join-Path $env:RUNNER_TEMP 'arm-paired-startup.json'
$report = [ordered]@{
    syntheticOnly=$true
    status='incomplete'
    strictReadinessTimeoutMs=15000
    imageOS=$env:ImageOS
    imageVersion=$env:ImageVersion
    osBuild=[Environment]::OSVersion.Version.ToString()
    driverSha256=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'verify-native-uia.ps1') -Algorithm SHA256).Hash.ToLowerInvariant()
    referencePassedPreviously='44372461643/135042645538, strict startup and ordinary shutdown only'
    cases=@()
}
function Write-Receipt { $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $output -Encoding utf8NoBOM }
Write-Receipt

& (Join-Path $PSScriptRoot 'verify-native-uia.ps1') -CompileOnly | Out-Null
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class HostedPairedStartup {
    delegate bool EnumProc(IntPtr hwnd, IntPtr param);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr param);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd,StringBuilder result,int length);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    static void Confirm(Process owner,long created,IntPtr hwnd) {
        if(owner.HasExited||owner.StartTime.ToUniversalTime().ToFileTimeUtc()!=created||
            GetWindowThreadProcessId(hwnd,out uint pid)==0||pid!=owner.Id)
            throw new InvalidOperationException("The exact owned manager window no longer exists.");
    }
    public sealed class WindowInfo {
        public string ClassName {get;set;}
        public uint Pid {get;set;}
        public bool Visible {get;set;}
    }
    public static WindowInfo[] Read(int pid,long created,long hwnd) {
        using var owner=Process.GetProcessById(pid);
        var parent=new IntPtr(hwnd);
        Confirm(owner,created,parent);
        var children=new List<WindowInfo>();
        EnumChildWindows(parent,(child,_)=>{
            var name=new StringBuilder(256);
            if(GetClassName(child,name,name.Capacity)>0 && GetWindowThreadProcessId(child,out uint childPid)!=0)
                children.Add(new WindowInfo {ClassName=name.ToString(),Pid=childPid,Visible=IsWindowVisible(child)});
            return children.Count<32;
        },IntPtr.Zero);
        Confirm(owner,created,parent);
        return children.ToArray();
    }
}
'@

$fixtureCode = @'
import { mkdir, realpath } from 'node:fs/promises';
import { createPerformanceFixture } from './scripts/performance-fixture.mjs';
const [parent, ...names] = process.argv.slice(2);
await mkdir(parent, { recursive: true });
if ((await realpath(parent)).toLowerCase() !== parent.toLowerCase()) throw new Error('The fixture root is redirected.');
const fixtures = [];
for (const name of names) fixtures.push(await createPerformanceFixture(parent, name, 100));
console.log(JSON.stringify(fixtures));
'@
$fixtureJson = $fixtureCode | & node --input-type=module - $base $cases[0].name $cases[1].name
if ($LASTEXITCODE -ne 0) { throw 'Could not create the two independent synthetic workbench fixtures.' }
$fixtures = @($fixtureJson | ConvertFrom-Json)
if ($fixtures.Count -ne 2 -or @($fixtures | Where-Object {
    -not $_.syntheticOnly -or $_.skillCount -ne 1000 -or $_.toolCount -ne 100 -or $_.dataFingerprint -ne $fixtures[0].dataFingerprint
}).Count) { throw 'The two fixture settings and workload sizes must match exactly.' }
$report.fixtureFingerprint = $fixtures[0].dataFingerprint
$report.dataset = '1000 Skills + 100 tools each, identical generated settings with isolated paths'

function Read-WindowDiagnostic([NativeUiMeasurement]$session) {
    $diagnostic = [ordered]@{}
    $created = [long]$session.CreationFileTime
    try {
        $diagnostic.childWindows = @([HostedPairedStartup]::Read($session.Pid,$created,$session.Handle))
    } catch { $diagnostic.windowError = $_.Exception.GetBaseException().Message }
    try {
        $diagnostic.window = $session.WindowIdentity()
        $named = @($session.Names())
        $diagnostic.namedControlCount = $named.Count
        $diagnostic.expectedControls = @($named | Where-Object { $_.name -in @('工作台','工作区标签','搜索 Skill','主要导航','工作区快捷键') } | Select-Object name,type)
        $diagnostic.namedControlTypes = @($named | Group-Object -Property type | Select-Object Name,Count)
    } catch { $diagnostic.uiaError = $_.Exception.GetBaseException().Message }
    try {
        $browser = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -OperationTimeoutSec 3 -Property ProcessId,ParentProcessId,Name,CreationDate,ExecutablePath)
        $family = [Collections.Generic.HashSet[uint32]]::new()
        [void]$family.Add([uint32]$session.Pid)
        do {
            $before = $family.Count
            foreach ($row in $browser) {
                if ($row.CreationDate -and $row.CreationDate.ToUniversalTime().ToFileTimeUtc() -ge $created -and $family.Contains([uint32]$row.ParentProcessId)) {
                    [void]$family.Add([uint32]$row.ProcessId)
                }
            }
        } until ($before -eq $family.Count)
        $diagnostic.webviewProcesses = @($browser | Where-Object { $family.Contains([uint32]$_.ProcessId) } | ForEach-Object {
            $version = if ($_.ExecutablePath) { [Diagnostics.FileVersionInfo]::GetVersionInfo($_.ExecutablePath).FileVersion }
            [ordered]@{ pid=$_.ProcessId; parentPid=$_.ParentProcessId; runtimeFileVersion=$version }
        })
    } catch { $diagnostic.webviewError = $_.Exception.GetBaseException().Message }
    return $diagnostic
}

for ($i=0; $i -lt $cases.Count; $i++) {
    $case = $cases[$i]
    $dataset = $fixtures[$i]
    $temp = (New-Item -ItemType Directory -Path (Join-Path $dataset.root 'native-temp')).FullName
    $record = [ordered]@{ case=$case.name; sha256=$case.sha; launched=$false; strictReady=$false; normalExit=$false }
    $report.cases += $record
    $session = $null
    try {
        if (@(Get-Process -Name agent-resource-manager,skill-manager -ErrorAction SilentlyContinue).Count) { throw 'An unexpected manager already exists; launch was stopped.' }
        $session = [NativeUiMeasurement]::new($case.path,$dataset.dataDir,$temp,$true,$false,$false,$false)
        $record.launched = $true
        $record.pid = $session.Pid
        $record.creationFileTime = $session.CreationFileTime
        $record.handle = $session.Handle
        $clock = [Diagnostics.Stopwatch]::StartNew()
        try {
            $session.Ready(20)
            $record.strictReady = $true
            $record.strictStartupMs = $session.StartupMs
        } catch { $record.strictError = $_.Exception.GetBaseException().Message }
        $record.strictProbeElapsedMs = $clock.Elapsed.TotalMilliseconds
        $record.diagnostic = Read-WindowDiagnostic $session
        if (-not $session.Exited) {
            $backendClock = [Diagnostics.Stopwatch]::StartNew()
            try {
                $tasks = $session.ReadObservation('task_list') | ConvertFrom-Json
                if ($null -eq $tasks.tasks) { throw 'The exact backend did not return a task list.' }
                $record.isolatedBackendVerified = $true
            } catch { $record.backendError = $_.Exception.GetBaseException().Message }
            finally { $record.backendObservationMs = $backendClock.Elapsed.TotalMilliseconds }
        }
    } catch { $record.launchOrProbeError = $_.Exception.GetBaseException().Message }
    finally {
        if ($session) {
            try {
                if ($session.Exited) { throw 'The owned process exited before the ordinary shutdown command.' }
                $record.normalExit = $session.RecoverQuit() -and $session.Exited
            } catch { $record.shutdownError = $_.Exception.GetBaseException().Message }
            finally { $session.Dispose() }
        }
        Write-Receipt
    }
    if (-not $record.normalExit) {
        $report.stopReason = 'The exact preceding manager did not verify ordinary shutdown. Any further launch was withheld.'
        break
    }
}

if ($report.cases.Count -eq 2 -and @($report.cases | Where-Object { -not $_.strictReady -or -not $_.isolatedBackendVerified -or -not $_.normalExit }).Count -eq 0) {
    $report.status = 'both-strict-startups-verified'
}
Write-Receipt
$report | ConvertTo-Json -Depth 12 -Compress
if ($report.status -cne 'both-strict-startups-verified') { exit 1 }
