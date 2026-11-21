$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:GITHUB_REPOSITORY -cne 'Zerozero05/Agent_Resource_Manager' -or
    $env:GITHUB_EVENT_NAME -cne 'create' -or $env:GITHUB_REF -cne 'refs/heads/codex/hosted-display-change-0ac5e79-20261121' -or
    $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or
    $env:ImageOS -cne 'win25-vs2026' -or $env:ImageVersion -cne '20261116.315.1' -or
    -not [Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {
    throw 'This temporary display transition is restricted to the pinned hosted Windows job.'
}
$candidate = Join-Path $env:RUNNER_TEMP 'arm-physical-display-candidate/agent-resource-manager.exe'
$sha256 = 'ff646e533f23749f96f09f6d79b7fad650bd035931b851b2710315eda64fdd24'
if ((Get-FileHash -LiteralPath $candidate).Hash -ine $sha256 -or
    @(Get-Process -Name 'agent-resource-manager','skill-manager' -ErrorAction SilentlyContinue).Count) {
    throw 'The candidate is unverified or an existing manager session is present.'
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class HostedDisplayTransition {
    public const string DeviceName = @"\\.\DISPLAY1";
    private const uint Attached = 1, Primary = 4, Mirroring = 8;
    private const uint CurrentSettings = 0xffffffff, TestOnly = 2;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Device {
        public uint size;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string description;
        public uint state;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string id;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string key;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct Mode {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string driver;
        public ushort specVersion, driverVersion, size, driverExtra;
        public uint fields;
        public int x, y;
        public uint orientation, fixedOutput;
        public short color, duplex, resolution, ttOption, collate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string form;
        public ushort logPixels;
        public uint bits, width, height, flags, hz, icmMethod, icmIntent, mediaType,
            ditherType, reserved1, reserved2, panningWidth, panningHeight;
        public string Key {
            get { return String.Join("/", x, y, orientation, fixedOutput, bits, width, height, flags, hz); }
        }
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect {
        public int left, top, right, bottom;
        public string Key { get { return String.Join("/", left, top, right, bottom); } }
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern bool EnumDisplayDevicesW(string device, uint index, ref Device result, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern bool EnumDisplaySettingsExW(string device, uint index, ref Mode mode, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int ChangeDisplaySettingsExW(string device, ref Mode mode,
        IntPtr reservedWindow, uint flags, IntPtr reservedParameters);
    [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW", ExactSpelling = true)]
    private static extern bool SystemParametersInfo(uint action, uint parameter, out Rect area, uint flags);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr handle, out uint exitCode);

    public static void SinglePrimary() {
        if (Marshal.SizeOf<Device>() != 840 || Marshal.SizeOf<Mode>() != 220 ||
            Marshal.OffsetOf<Mode>("width").ToInt32() != 172) throw new InvalidOperationException("Unexpected Win32 layout.");
        int matches = 0;
        for (uint index = 0; index < 32; index++) {
            var device = new Device { size = (uint)Marshal.SizeOf<Device>() };
            if (!EnumDisplayDevicesW(null, index, ref device, 0)) {
                if (matches == 1) return;
                break;
            }
            if ((device.state & Attached) == 0 || (device.state & Mirroring) != 0) continue;
            if (device.name != DeviceName || (device.state & Primary) == 0 || ++matches != 1)
                throw new InvalidOperationException("Only the selected single primary display is allowed.");
        }
        throw new InvalidOperationException("Could not verify that only DISPLAY1 is attached.");
    }
    private static bool Read(uint index, out Mode mode) {
        mode = new Mode { size = (ushort)Marshal.SizeOf<Mode>() };
        return EnumDisplaySettingsExW(DeviceName, index, ref mode, 0);
    }
    public static Mode Current() {
        if (!Read(CurrentSettings, out var mode)) throw new InvalidOperationException("Cannot read current display mode.");
        return mode;
    }
    public static Mode Target(Mode initial) {
        if (initial.width != 1024 || initial.height != 768 || initial.bits != 32 || initial.hz != 64)
            throw new InvalidOperationException("Unexpected starting display mode.");
        for (uint index = 0; index < 4096 && Read(index, out var mode); index++) {
            if (mode.width == 1152 && mode.height == 864 && mode.bits == initial.bits && mode.hz == initial.hz &&
                mode.orientation == initial.orientation && mode.flags == initial.flags && mode.fixedOutput == initial.fixedOutput) {
                mode.x = initial.x;
                mode.y = initial.y;
                mode.driverExtra = 0;
                if (ChangeDisplaySettingsExW(DeviceName, ref mode, IntPtr.Zero, TestOnly, IntPtr.Zero) == 0) return mode;
                break;
            }
        }
        throw new InvalidOperationException("Required 1152x864 mode was absent or failed CDS_TEST.");
    }
    public static int Apply(Mode mode) {
        mode.driverExtra = 0;
        // Zero flags requests a temporary dynamic change, with no registry update or reset.
        return ChangeDisplaySettingsExW(DeviceName, ref mode, IntPtr.Zero, 0, IntPtr.Zero);
    }
    public static Rect WorkArea() {
        if (!SystemParametersInfo(0x0030, 0, out var area, 0)) throw new InvalidOperationException("Cannot read work area.");
        return area;
    }
    public static Rect OwnedWindow(long hwnd, int pid) {
        IntPtr handle = new IntPtr(hwnd);
        if (GetWindowThreadProcessId(handle, out var owner) == 0 || owner != pid || !GetWindowRect(handle, out var rect))
            throw new InvalidOperationException("The original HWND no longer belongs to its PID.");
        return rect;
    }
    public static uint ExitCode(IntPtr handle) {
        if (!GetExitCodeProcess(handle, out var code)) throw new InvalidOperationException("Cannot read retained process exit code.");
        return code;
    }
}
'@

$reportDirectory = Join-Path $env:RUNNER_TEMP 'arm-hosted-display-audit'
$null = New-Item -ItemType Directory -Path $reportDirectory
$reportPath = Join-Path $reportDirectory 'display-transition.json'
$approved = 'D:\03_github_projects\Agent_Management\Agent_Resource_Manager\validation\manager-data'
$report = [ordered]@{
    format = 'hosted-display-transition-v1'
    syntheticOnly = $true
    candidateSource = '0ac5e79b7a3d1184e7602f241793f240b0609d44'
    candidateSha256 = $sha256
    image = "$env:ImageOS/$env:ImageVersion"
    device = [HostedDisplayTransition]::DeviceName
    status = 'failed'
    scope = 'One hosted display resolution and work-area transition; no physical monitor or DPI transition and no performance result.'
    transitionAttempted = $false
    restored = $false
    normalExit = $false
}

function Wait-Mode($expected, [string]$workAreaKey) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        $mode = [HostedDisplayTransition]::Current()
        $area = [HostedDisplayTransition]::WorkArea()
        if ($mode.Key -ceq $expected.Key -and
            $(if ($workAreaKey) { $area.Key -ceq $workAreaKey } else { $area.Key -cne $originalArea.Key })) {
            return $area
        }
        Start-Sleep -Milliseconds 100
    } while ($timer.Elapsed.TotalSeconds -lt 8)
    throw 'Windows did not confirm the exact mode and expected work area during the bounded observation.'
}

function Visible-Control([string]$name, [string]$type, [string]$scope, $window) {
    $controls = @($session.InspectNamed($name,$scope) | Where-Object { $_.enabled -and -not $_.offscreen -and $_.type -ceq $type })
    if ($controls.Count -ne 1 -or $controls[0].bounds -notmatch '^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?,\d+(?:\.\d+)?,\d+(?:\.\d+)?$') {
        throw "The visible native control is unavailable or ambiguous: $name."
    }
    $x, $y, $width, $height = @($controls[0].bounds.Split(',') | ForEach-Object {
        [double]::Parse($_,[Globalization.CultureInfo]::InvariantCulture)
    })
    if ($width -le 0 -or $height -le 0 -or $x -lt $window.left -or $y -lt $window.top -or
        ($x + $width) -gt $window.right -or ($y + $height) -gt $window.bottom) { throw "Control exceeds owned window: $name." }
    return $controls[0].bounds
}

function Observe-Search([string]$label, [int]$index, [string]$retainedSearch, $workArea) {
    $identity = $session.WindowIdentity()
    if ($session.CreationFileTime -cne $owner.created -or $identity['capturedHandle'] -ne $owner.hwnd -or
        $identity['currentMainHandle'] -ne $owner.hwnd -or $identity['uiaProcessId'] -ne $owner.pid) {
        throw 'The live application no longer matches the original native owner.'
    }
    if ($retainedSearch -and $identity['searchValue'] -cne $retainedSearch) { throw 'The previous query was not retained across the mode change.' }
    $window = [HostedDisplayTransition]::OwnedWindow($owner.hwnd,$owner.pid)
    if ($window.left -lt $workArea.left -or $window.top -lt $workArea.top -or
        $window.right -gt $workArea.right -or $window.bottom -gt $workArea.bottom) { throw 'Owned test window is clipped by the work area.' }
    $null = $session.Search($index)
    $after = $session.WindowIdentity()
    $expected = 'perf-skill-{0:D4}' -f $index
    if ($after['searchValue'] -cne $expected -or $after['capturedHandle'] -ne $owner.hwnd -or
        $after['currentMainHandle'] -ne $owner.hwnd -or $after['uiaProcessId'] -ne $owner.pid) {
        throw 'The exact owned search did not complete.'
    }
    $edit = Visible-Control '搜索 Skill' 'ControlType.Edit' '' $window
    $result = Visible-Control ('Perf Skill {0:D4}' -f $index) 'ControlType.Button' '可横向滚动的 Skill 列表' $window
    $image = Join-Path $dataset.root "$label.png"
    $session.Capture($image)
    Copy-Item -LiteralPath $image -Destination $reportDirectory
    return [ordered]@{
        pid = $owner.pid; created = $owner.created; hwnd = $owner.hwnd
        frame = $window.Key; workArea = $workArea.Key
        retainedSearch = $retainedSearch; search = $expected; edit = $edit; result = $result
        screenshotSha256 = (Get-FileHash -LiteralPath $image).Hash.ToLowerInvariant()
    }
}

$session = $null
$process = $null
$failure = $null
try {
    [HostedDisplayTransition]::SinglePrimary()
    $initial = [HostedDisplayTransition]::Current()
    $originalArea = [HostedDisplayTransition]::WorkArea()
    $target = [HostedDisplayTransition]::Target($initial)
    $report.initialMode = $initial.Key
    $report.proposedMode = $target.Key
    $report.initialWorkArea = $originalArea.Key
    if (([HostedDisplayTransition]::Current()).Key -cne $initial.Key) { throw 'Original mode changed during preflight.' }
    if (Test-Path -LiteralPath $approved) { throw 'The hosted validation directory must be fresh.' }
    $null = New-Item -ItemType Directory -Path $approved
    $fixtureCode = @'
import { createPerformanceFixture } from './scripts/performance-fixture.mjs';
console.log(JSON.stringify(await createPerformanceFixture(process.argv[2], 'display-transition', 100)));
'@
    $datasetJson = $fixtureCode | & node --input-type=module - $approved
    if ($LASTEXITCODE -ne 0) { throw 'Could not generate the isolated display fixture.' }
    $dataset = $datasetJson | ConvertFrom-Json
    $expectedRoot = Join-Path $approved 'display-transition'
    if ($dataset.syntheticOnly -ne $true -or $dataset.skillCount -ne 1000 -or $dataset.toolCount -ne 100 -or
        $dataset.root -ine $expectedRoot -or $dataset.dataDir -ine (Join-Path $expectedRoot 'data')) {
        throw 'The synthetic fixture is not bound to its expected isolated directory.'
    }
    foreach ($path in @($candidate,$dataset.root,$dataset.dataDir,$dataset.dbPath)) {
        for ($parent = $path; $parent; $parent = Split-Path -Parent $parent) {
            if ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Validation paths must be ordinary.' }
        }
    }
    $source = Join-Path $dataset.skillsRoot 'perf-skill-0000/SKILL.md'
    $sourceSha256 = (Get-FileHash -LiteralPath $source).Hash
    $temporary = (New-Item -ItemType Directory -Path (Join-Path $dataset.root 'native-temp')).FullName
    $null = & (Join-Path $PSScriptRoot 'verify-native-uia.ps1') -CompileOnly
    $session = [NativeUiMeasurement]::new($candidate,$dataset.dataDir,$temporary,$true,$false,$false,$false)
    $process = [Diagnostics.Process]::GetProcessById($session.Pid)
    $handle = $process.Handle
    $owner = @{pid = $session.Pid; created = $session.CreationFileTime; hwnd = $session.Handle}
    if ($process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -cne $owner.created -or
        $process.MainModule.FileName -ine $candidate) { throw 'Could not retain the exact candidate process handle.' }
    $session.Ready(20)
    $null = $session.ReadObservation('task_list')
    $report.exactOwnedBackendVerified = $true
    $session.Resize(960,650)
    $report.before = Observe-Search 'before' 0 '' $originalArea

    try {
        if (([HostedDisplayTransition]::Current()).Key -cne $initial.Key) { throw 'The initial mode changed before the test.' }
        $report.transitionAttempted = $true
        $report.applyCode = [HostedDisplayTransition]::Apply($target)
        if ($report.applyCode -ne 0) { throw 'The driver rejected the temporary mode change.' }
        $changedArea = Wait-Mode $target ''
        [HostedDisplayTransition]::SinglePrimary()
        $report.changedMode = ([HostedDisplayTransition]::Current()).Key
        $report.changed = Observe-Search 'changed' 1 'perf-skill-0000' $changedArea
    } finally {
        if ($report.transitionAttempted) {
            $report.restoreCode = [HostedDisplayTransition]::Apply($initial)
            if ($report.restoreCode -ne 0) { throw 'Could not restore the saved original display mode.' }
            $restoredArea = Wait-Mode $initial $originalArea.Key
            [HostedDisplayTransition]::SinglePrimary()
            $report.restoredMode = ([HostedDisplayTransition]::Current()).Key
            $report.restoredWorkArea = $restoredArea.Key
            $report.restored = $true
        }
    }
    $report.afterRestore = Observe-Search 'restored' 0 'perf-skill-0001' $restoredArea
    if ((Get-FileHash -LiteralPath $source).Hash -cne $sourceSha256) { throw 'The generated source changed.' }
    $report.syntheticSourcePreserved = $true
} catch {
    $failure = $_
    $report.error = $_.Exception.Message
} finally {
    if ($session) {
        try {
            $report.normalExit = $session.RecoverQuit()
            if ($report.normalExit -and $handle) { $report.exitCode = [HostedDisplayTransition]::ExitCode($handle) }
        } catch {
            $report.exitError = $_.Exception.Message
        }
    }
    if ($process) { $process.Dispose() }
    if (-not $failure -and $report.transitionAttempted -and $report.restored -and $report.normalExit -and
        $report.Contains('exitCode') -and $report.exitCode -eq 0) { $report.status = 'passed' }
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8NoBOM
}
if ($failure) { throw $failure }
if ($report.status -cne 'passed') { throw 'The transition, restoration or normal exit is incomplete.' }
