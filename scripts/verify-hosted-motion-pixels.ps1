param(
    [Parameter(Mandatory)][string]$Candidate,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedSha256
)

$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or
    -not [Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {
    throw 'This can run only in a fresh interactive GitHub-hosted Windows VM.'
}

$evidence = New-Item -ItemType Directory -Path (Join-Path $env:RUNNER_TEMP 'arm-motion-pixels-evidence')
$output = Join-Path $evidence.FullName 'motion-pixels.json'
$policy = [ordered]@{ trials=3; neutralSettleMs=250; beforeMs=95; afterMs=430; maxCaptureMs=15; maxGapMs=32; latestReducedEndpointMs=105;
    minimumEndpointSamples=4; minimumRgbDistance=12; minimumIntermediateColors=2 }
$report = [ordered]@{ candidateSha256=$ExpectedSha256; syntheticOnly=$true; status='incomplete'; phase='preflight'
    policy=$policy; arms=@(); attemptedSystemChange=$false; systemRestored=$false; closedNormally=$false
    scope='Native foreground hover pixels on one inactive sidebar control. No DOM or CSS readback and no display-DPI or whole-app animation claim.' }
function Write-Report { $report | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath $output -Encoding utf8NoBOM }
Write-Report

$session = $null
$original = $null
$pairedEndpoints = [ordered]@{ neutral=$null; hover=$null }
try {
    $base = 'D:\03_github_projects\Agent_Management\Agent_Resource_Manager\validation\manager-data'
    if (-not (Test-Path -LiteralPath 'D:\' -PathType Container) -or (Test-Path -LiteralPath $base) -or
        (Get-Process -Name agent-resource-manager,skill-manager -ErrorAction SilentlyContinue)) {
        throw 'Require a fresh test directory and a runner with no existing manager.'
    }
    $Candidate = (Resolve-Path -LiteralPath $Candidate).ProviderPath
    if ([IO.Path]::GetFileName($Candidate) -cne 'agent-resource-manager.exe' -or
        (Get-FileHash -LiteralPath $Candidate -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedSha256) {
        throw 'The exact candidate executable is required.'
    }

    # Compile the existing window/pipe guard and normal-quit path without launching it.
    & (Join-Path $PSScriptRoot 'verify-native-uia.ps1') -CompileOnly | Out-Null
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public sealed class HostedMotionPixels : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; public Point(int x,int y){X=x;Y=y;} }
    [StructLayout(LayoutKind.Sequential)] struct LastInput { public uint Size, Time; }
    [StructLayout(LayoutKind.Sequential)] struct Mouse { public int X,Y; public uint Data,Flags,Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public Mouse Mouse; }

    [DllImport("user32.dll", EntryPoint="SystemParametersInfoW", SetLastError=true)]
    static extern bool GetSetting(uint action, uint arg, out int value, uint flags);
    [DllImport("user32.dll", EntryPoint="SystemParametersInfoW", SetLastError=true)]
    static extern bool SetSetting(uint action, uint arg, IntPtr value, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput input);
    [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] input, int structSize);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("gdi32.dll")] static extern uint GetPixel(IntPtr dc, int x, int y);

    readonly Process owner;
    readonly IntPtr window;
    readonly long creation;
    IntPtr screen;
    uint inputTick;
    public HostedMotionPixels(int pid, long creationFileTime, long handle) {
        owner=Process.GetProcessById(pid);
        window=new IntPtr(handle);
        creation=creationFileTime;
        inputTick=InputTick();
        try {
            Guard();
            screen=GetDC(IntPtr.Zero);
            if(screen==IntPtr.Zero)throw new InvalidOperationException("The owned desktop pixels are unavailable.");
        } catch { owner.Dispose(); throw; }
    }
    public static bool AnimationsEnabled() {
        if(!GetSetting(0x1042,0,out int value,0))throw new Win32Exception(Marshal.GetLastWin32Error());
        return value!=0;
    }
    public static void SetAnimations(bool value) {
        // SPIF_SENDCHANGE only. Do not persist a change in the user profile.
        if(!SetSetting(0x1043,0,new IntPtr(value?1:0),2))throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    static uint InputTick() {
        var state=new LastInput {Size=(uint)Marshal.SizeOf<LastInput>()};
        if(!GetLastInputInfo(ref state))throw new InvalidOperationException("Cannot check desktop input ownership.");
        return state.Time;
    }
    void Guard() {
        if(owner.HasExited||owner.StartTime.ToUniversalTime().ToFileTimeUtc()!=creation||
           GetWindowThreadProcessId(window,out uint pid)==0||pid!=owner.Id||GetForegroundWindow()!=window||
           InputTick()!=inputTick)throw new InvalidOperationException("Owned foreground or expected input changed; no further visual input is permitted.");
    }
    void VerifyPoint(Point p) {
        if(GetAncestor(WindowFromPoint(p),2)!=window)throw new InvalidOperationException("The visual point is not on the exact owned window.");
    }
    void Move(Point p) {
        Guard(); VerifyPoint(p);
        int x=GetSystemMetrics(76), y=GetSystemMetrics(77), w=GetSystemMetrics(78),h=GetSystemMetrics(79);
        if(w<2||h<2||p.X<x||p.X>=x+w||p.Y<y||p.Y>=y+h)throw new InvalidOperationException("Owned pointer point lies outside the virtual screen.");
        var move=new Input { Type=0, Mouse=new Mouse {
            X=(int)Math.Round((p.X-x)*65535.0/(w-1)), Y=(int)Math.Round((p.Y-y)*65535.0/(h-1)), Flags=0xc001 }};
        if(SendInput(1,new[]{move},Marshal.SizeOf<Input>())!=1)throw new Win32Exception(Marshal.GetLastWin32Error());
        inputTick=InputTick();
        if(!GetCursorPos(out Point actual)||Math.Abs(actual.X-p.X)>2||Math.Abs(actual.Y-p.Y)>2)
            throw new InvalidOperationException("The isolated pointer move did not arrive at its exact point.");
    }
    public sealed class Sample {
        public double BeginMs {get;set;}
        public double EndMs {get;set;}
        public uint First {get;set;}
        public uint Second {get;set;}
    }
    public Sample[] Trace(int outX,int outY,int hoverX,int hoverY,int firstX,int firstY,int secondX,int secondY,
                         int settleMs,int beforeMs,int afterMs) {
        var target=new Point(hoverX,hoverY); var first=new Point(firstX,firstY); var second=new Point(secondX,secondY);
        Move(new Point(outX,outY)); Thread.Sleep(settleMs);
        var rows=new List<Sample>(); var timer=Stopwatch.StartNew();
        void Read() {
            double begin=timer.Elapsed.TotalMilliseconds;
            Guard(); VerifyPoint(first); VerifyPoint(second);
            uint a=GetPixel(screen,first.X,first.Y),b=GetPixel(screen,second.X,second.Y);
            Guard();
            if(a==uint.MaxValue||b==uint.MaxValue)throw new InvalidOperationException("The hosted desktop did not expose readable composited pixels.");
            rows.Add(new Sample {BeginMs=begin,EndMs=timer.Elapsed.TotalMilliseconds,First=a,Second=b});
            Thread.Sleep(4);
        }
        while(timer.Elapsed.TotalMilliseconds<beforeMs) Read();
        double zero=timer.Elapsed.TotalMilliseconds;
        Move(target);
        while(timer.Elapsed.TotalMilliseconds<zero+afterMs) Read();
        foreach(var row in rows){row.BeginMs-=zero;row.EndMs-=zero;}
        Move(new Point(outX,outY));
        return rows.ToArray();
    }
    public void Dispose() {
        if(screen!=IntPtr.Zero){ReleaseDC(IntPtr.Zero,screen);screen=IntPtr.Zero;}
        owner.Dispose();
    }
}
'@

    $fixtureCode = @'
import { mkdir } from 'node:fs/promises';
import { createPerformanceFixture } from './scripts/performance-fixture.mjs';
await mkdir(process.argv[2], { recursive: true });
console.log(JSON.stringify(await createPerformanceFixture(process.argv[2], 'motion-pixels', 0)));
'@
    $fixtureText = $fixtureCode | & node --input-type=module - $base
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the existing synthetic performance fixture.' }
    $dataset = $fixtureText | ConvertFrom-Json
    if ($dataset.syntheticOnly -ne $true -or $dataset.skillCount -ne 1000 -or $dataset.settings.uiMotion -cne 'light') {
        throw 'Unexpected synthetic fixture or initial visual control.'
    }
    $temporary = New-Item -ItemType Directory -Path (Join-Path $dataset.root 'temp')
    $report.fixtureSha256 = (Get-FileHash -LiteralPath (Join-Path $dataset.root 'dataset.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    $report.phase = 'owned-window'
    $session = [NativeUiMeasurement]::new($Candidate,[string]$dataset.dataDir,$temporary.FullName,$true,$false,$false,$false)
    $session.Ready(20)
    # Existing pipe guard checks that its exact launched owner is ready with this isolated database.
    $session.ReadObservation('task_list') | Out-Null
    $report.native = [ordered]@{ pid=$session.Pid; creationFileTime=$session.CreationFileTime; windowHandle=$session.Handle }
    $session.ClickNamed('设置','主要导航')
    if (-not @($session.InspectNamed('设置分类') | Where-Object { -not $_.offscreen }).Count) {
        $session.ClickNamed('设置分类：常规',$null)
    }
    $session.ClickNamed('外观','设置分类')
    $uia = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]$session.Handle)
    function Find-Exact($root,$name) {
        $match = $root.FindAll([Windows.Automation.TreeScope]::Descendants,
            [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,$name))
        if ($match.Count -ne 1 -or $match[0].Current.IsOffscreen -or -not $match[0].Current.IsEnabled) {
            throw "Cannot verify exact visible owned control $name."
        }
        return $match[0]
    }
    $nav = Find-Exact $uia '主要导航'
    $button = Find-Exact $nav '工具'
    if ($button.Current.ControlType -ne [Windows.Automation.ControlType]::Button) { throw 'The hover target is not the expected side navigation button.' }
    $geometry = $button.Current.BoundingRectangle
    $client = $uia.Current.BoundingRectangle
    if ($geometry.IsEmpty -or $geometry.Width -lt 170 -or $geometry.Height -lt 30 -or
        -not $client.Contains($geometry) -or $client.Right -le $geometry.Right + 70) {
        throw 'The wide, unoccluded navigation layout needed for separate pixel locations was not available.'
    }
    $report.target = '主要导航 / 工具（未选中）'
    $report.points = [ordered]@{ neutral=@([int]($geometry.Right+60),[int]($geometry.Top+$geometry.Height/2))
        hover=@([int]($geometry.Left+$geometry.Width/2),[int]($geometry.Top+$geometry.Height/2))
        background=@([int]($geometry.Left+7),[int]($geometry.Top+$geometry.Height/2),[int]($geometry.Right-9),[int]($geometry.Top+$geometry.Height/2)) }

    function Select-Motion([string]$option) {
        if ($session.SelectCombo('动效',$option,$false,$false) -cne $option) { throw 'The live motion option could not be retained.' }
    }

    function Distance-Rgb([uint32]$a,[uint32]$b) {
        $total = 0
        foreach ($shift in @(0,8,16)) { $total += [Math]::Abs([int](($a -shr $shift) -band 255)-[int](($b -shr $shift) -band 255)) }
        return $total
    }

    function Test-RgbPath([uint32]$color,[uint32]$from,[uint32]$to) {
        foreach ($shift in @(0,8,16)) {
            $channel = [int](($color -shr $shift) -band 255)
            $low = [int](($from -shr $shift) -band 255)
            $high = [int](($to -shr $shift) -band 255)
            if ($channel -lt ([Math]::Min($low,$high) - 1) -or $channel -gt ([Math]::Max($low,$high) + 1)) { return $false }
        }
        return $true
    }

    function Run-Arm([string]$name,[bool]$expectedEnabled,[bool]$expectTransition) {
        $report.phase = $name
        $arm = [ordered]@{ name=$name; osAnimationsEnabled=$expectedEnabled; expectTransition=$expectTransition; trials=@() }
        $report.arms += $arm
        if ([HostedMotionPixels]::AnimationsEnabled() -ne $expectedEnabled) { throw 'Unexpected OS setting before this arm.' }
        if ($button.Current.IsOffscreen -or $button.Current.BoundingRectangle -ne $geometry) { throw 'The original navigation target moved or became unavailable.' }
        # Setup changes use UIA. Create a new guarded observation only after those explicit test controls.
        $probe = [HostedMotionPixels]::new($session.Pid,[long]$session.CreationFileTime,$session.Handle)
        try {
            for ($attempt=1; $attempt -le $policy.trials; $attempt++) {
                $points = $report.points
                $trace = @($probe.Trace($points.neutral[0],$points.neutral[1],$points.hover[0],$points.hover[1],
                    $points.background[0],$points.background[1],$points.background[2],$points.background[3],
                    $policy.neutralSettleMs,$policy.beforeMs,$policy.afterMs))
                $early = @($trace | Where-Object { $_.EndMs -le -3 })
                $late = @($trace | Where-Object { $_.BeginMs -ge 290 })
                if ($early.Count -lt $policy.minimumEndpointSamples -or $late.Count -lt $policy.minimumEndpointSamples) {
                    $arm.trials += [ordered]@{attempt=$attempt;trace=$trace;status='insufficient-timing'}
                    throw 'The capture clock did not cover both hover endpoints.'
                }
                $baseColor=[uint32]$early[0].First
                $hoverColor=[uint32]$late[-1].First
                $badReads=@($trace | Where-Object { $_.First -ne $_.Second -or ($_.EndMs - $_.BeginMs) -gt $policy.maxCaptureMs })
                $maxGap=0.0
                for ($i=1; $i -lt $trace.Count; $i++) { $maxGap=[Math]::Max($maxGap,$trace[$i].BeginMs-$trace[$i-1].EndMs) }
                $mid = @($trace | Where-Object { $_.BeginMs -ge 0 -and (Distance-Rgb $_.First $baseColor) -gt 1 -and (Distance-Rgb $_.First $hoverColor) -gt 1 })
                $midColors = @($mid | ForEach-Object { $_.First } | Sort-Object -Unique)
                $firstHover = $trace | Where-Object { $_.BeginMs -ge 0 -and $_.First -eq $hoverColor } | Select-Object -First 1
                $backToNeutral = @($trace | Where-Object { $_.BeginMs -gt $firstHover.EndMs -and $_.First -eq $baseColor })
                $unexpectedColors = @($mid | Where-Object { -not (Test-RgbPath $_.First $baseColor $hoverColor) })
                if ($null -eq $pairedEndpoints.neutral) {
                    $pairedEndpoints.neutral = $baseColor
                    $pairedEndpoints.hover = $hoverColor
                }
                $valid = $badReads.Count -eq 0 -and $maxGap -le $policy.maxGapMs -and
                    $backToNeutral.Count -eq 0 -and $unexpectedColors.Count -eq 0 -and
                    $baseColor -eq $pairedEndpoints.neutral -and $hoverColor -eq $pairedEndpoints.hover -and
                    @(($early.First | Where-Object { $_ -ne $baseColor })).Count -eq 0 -and
                    @(($late.First | Where-Object { $_ -ne $hoverColor })).Count -eq 0 -and
                    (Distance-Rgb $baseColor $hoverColor) -ge $policy.minimumRgbDistance
                $arm.trials += [ordered]@{attempt=$attempt;trace=$trace;valid=$valid;maxGapMs=$maxGap
                    neutralColor=$baseColor;hoverColor=$hoverColor;intermediateColors=$midColors.Count
                    firstHoverSampleMs=$firstHover.EndMs;unexpectedColors=$unexpectedColors.Count }
                Write-Report
                if (-not $valid) { throw 'Visible pixels were noisy, discontinuous, occluded or missing an endpoint. This arm is inconclusive.' }
                if ($expectTransition -and $midColors.Count -lt $policy.minimumIntermediateColors) { throw 'Positive hover control did not show two measurable intermediate colors.' }
                if (-not $expectTransition) {
                    if ($firstHover.EndMs -gt $policy.latestReducedEndpointMs) { throw 'The endpoint arrived too late to distinguish absent motion from a delayed visual read.' }
                    if ($midColors.Count -ne 0) { throw 'Intermediate visible pixels remained in the reduced-motion observation.' }
                }
            }
        } finally { $probe.Dispose() }
        if ([HostedMotionPixels]::AnimationsEnabled() -ne $expectedEnabled) { throw 'OS setting changed during this arm.' }
        $arm.pairedObservationPassed = $true
    }

    $original = [HostedMotionPixels]::AnimationsEnabled()
    $report.originalAnimationsEnabled = $original
    Select-Motion '轻动效'
    Run-Arm 'explicit-light-preflight' $original $true

    Select-Motion '跟随系统（默认）'
    $report.attemptedSystemChange = $true
    [HostedMotionPixels]::SetAnimations($true)
    Start-Sleep -Milliseconds 550
    Run-Arm 'system-animations-enabled' $true $true
    [HostedMotionPixels]::SetAnimations($false)
    Start-Sleep -Milliseconds 550
    Run-Arm 'system-animations-disabled' $false $false
    Select-Motion '轻动效'
    Run-Arm 'explicit-light-with-os-disabled' $false $true
    $report.status = 'observed-visible-system-motion'
} catch {
    $report.error = $_.Exception.GetBaseException().Message
} finally {
    if ($report.attemptedSystemChange) {
        try {
            if ([HostedMotionPixels]::AnimationsEnabled() -ne $original) { [HostedMotionPixels]::SetAnimations($original) }
            $report.restoredAnimationsEnabled = [HostedMotionPixels]::AnimationsEnabled()
            $report.systemRestored = $report.restoredAnimationsEnabled -eq $original
        } catch { $report.restoreError = $_.Exception.GetBaseException().Message }
    }
    if ($session) {
        try {
            if ($session.Exited) { throw 'The owned manager exited before the normal shutdown command.' }
            $report.closedNormally = $session.RecoverQuit() -and $session.Exited
        }
        catch { $report.exitError = $_.Exception.GetBaseException().Message }
        finally { $session.Dispose() }
    }
    if (-not $report.systemRestored -or -not $report.closedNormally) { $report.status = 'incomplete' }
    $report.finishedAt = [DateTime]::UtcNow.ToString('o')
    Write-Report
}
[ordered]@{status=$report.status; phase=$report.phase; systemRestored=$report.systemRestored; closedNormally=$report.closedNormally;
    candidateSha256=$ExpectedSha256; error=$report.error} | ConvertTo-Json -Compress
if ($report.status -cne 'observed-visible-system-motion') { exit 1 }
