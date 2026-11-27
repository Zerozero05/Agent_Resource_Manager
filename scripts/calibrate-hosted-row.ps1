$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:RUNNER_OS -cne 'Windows' -or -not [Environment]::UserInteractive -or
    [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) { throw 'Hosted interactive VM required.' }
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PatternWindow {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls,string title);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd,uint msg,IntPtr w,IntPtr l);
}
"@
$probe=Join-Path $env:RUNNER_TEMP 'arm-dxgi/bin/verify-hosted-dxgi-row.exe'
$out=New-Item -ItemType Directory -Path (Join-Path $env:RUNNER_TEMP 'arm-motion-pixels-evidence')
$report=[ordered]@{status='incomplete';phase='pattern-window';attemptedSystemChange=$false;closedNormally=$false
    runnerImage=$env:ImageOS;runnerImageVersion=$env:ImageVersion
    policy=@{maxCaptureMs=15;maxGapMs=32;minimumIntermediateColors=2;minimumEndpointSamples=4}
    rowMethodTrials=@(); windowGeometry=@(150,130,360,160);sampledPoints=@(210,192,330);neutralPoint=@(170,153);hoverPoint=@(275,197)}
function Save { $report | ConvertTo-Json -Depth 12 | Set-Content -Encoding utf8NoBOM -LiteralPath (Join-Path $out.FullName 'motion-pixels.json') }
Save
$h=[IntPtr]::Zero
$p=Start-Process -FilePath $probe -ArgumentList '--hosted-pattern' -WindowStyle Hidden -PassThru
try {
    $clock=[Diagnostics.Stopwatch]::StartNew()
    do {
        $h=[PatternWindow]::FindWindow('ARMClippedRowMotionPattern','ARM isolated row pattern')
        [uint32]$ownerId=0
        if($h -ne [IntPtr]::Zero){[void][PatternWindow]::GetWindowThreadProcessId($h,[ref]$ownerId)}
        if($ownerId -eq $p.Id -and [PatternWindow]::GetForegroundWindow() -eq $h){break}
        if($p.HasExited -or $clock.ElapsedMilliseconds -gt 5000){throw 'Pattern window did not own the foreground.'}
        Start-Sleep -Milliseconds 50
    }while($true)
    $creation=$p.StartTime.ToUniversalTime().ToFileTimeUtc()
    $report.phase='compare-row-methods'
    foreach($method in @('system-memory-map','staging-after-release','staging-after-release','system-memory-map')){
        $mode=if($method -eq 'system-memory-map'){'--hosted-hover-map'}else{'--hosted-hover-early-release'}
        $raw=@(& $probe $mode $p.Id $creation $h.ToInt64() 210 192 330 170 153 275 197 2>&1)
        $trial=[ordered]@{requestedMethod=$method;exitCode=$LASTEXITCODE;diagnostic=$null}
        if($trial.exitCode -eq 0 -and $raw.Count -eq 1){
            $trial.rawDxgi=$raw[0] | ConvertFrom-Json
        }else{
            $trial.diagnostic=@($raw | ForEach-Object {$_.ToString()})
        }
        $report.rowMethodTrials+= $trial
        Save
        if($trial.diagnostic -match 'foreground|ownership|cursor|outside'){throw 'Owned capture window or input changed.'}
    }
    $report.status='collected-method-diagnostic'
} catch { $report.error=$_.Exception.GetBaseException().Message }
finally {
    if(-not $p.HasExited -and $h -ne [IntPtr]::Zero){
        [uint32]$ownerId=0
        [void][PatternWindow]::GetWindowThreadProcessId($h,[ref]$ownerId)
        if($ownerId -eq $p.Id){[void][PatternWindow]::PostMessage($h,0x10,[IntPtr]::Zero,[IntPtr]::Zero)}
    }
    $report.closedNormally=$p.WaitForExit(5000) -and $p.ExitCode -eq 0
    Save
}
if(-not $report.closedNormally -or $report.status -ne 'collected-method-diagnostic'){throw 'No complete capture-method observation.'}
