param(
    [Parameter(Mandatory)][string]$Candidate,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedSha256
)

$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or
    $env:ImageOS -cne 'win25-vs2026' -or $env:ImageVersion -cne '20261116.315.1' -or
    -not [Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {
    throw 'Require the approved interactive GitHub-hosted Windows image.'
}

$evidence = New-Item -ItemType Directory -Path (Join-Path $env:RUNNER_TEMP 'arm-motion-notification-evidence')
$output = Join-Path $evidence.FullName 'motion-notifications.json'
$report = [ordered]@{
    status = 'incomplete'
    phase = 'preflight'
    diagnosticOnly = $true
    replacesPreviousAcceptance = $false
    runnerImageVersion = $env:ImageVersion
    candidateSha256 = $ExpectedSha256
    qpcFrequency = [Diagnostics.Stopwatch]::Frequency
    notificationScope = 'The owned hidden top-level receiver observes session broadcasts. Receipt by the WebView process is not inferred.'
    attemptedSystemChange = $false
    systemRestored = $false
    closedNormally = $false
    flips = @()
}
function Save-Report { $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $output -Encoding utf8NoBOM }
Save-Report

$session = $null
$reader = $null
$receiver = $null
$original = $null
try {
    $base = 'D:\03_github_projects\Agent_Management\Agent_Resource_Manager\validation\manager-data'
    $port = 65352
    if (-not (Test-Path -LiteralPath 'D:\' -PathType Container) -or (Test-Path -LiteralPath $base) -or
        (Get-Process -Name agent-resource-manager,skill-manager -ErrorAction SilentlyContinue) -or
        (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) -or
        (Get-ChildItem Env: | Where-Object Name -Match '^WEBVIEW2_(USER_DATA_FOLDER|ADDITIONAL_BROWSER_ARGUMENTS|WAIT_FOR_SCRIPT_DEBUGGER|PIPE_FOR_SCRIPT_DEBUGGER)$')) {
        throw 'Require a fresh D-drive fixture, a free loopback port, and no prior manager or WebView diagnostic overrides.'
    }
    $Candidate = (Resolve-Path -LiteralPath $Candidate).ProviderPath
    if ([IO.Path]::GetFileName($Candidate) -cne 'agent-resource-manager.exe' -or
        (Get-FileHash -LiteralPath $Candidate).Hash.ToLowerInvariant() -cne $ExpectedSha256) {
        throw 'The pinned candidate executable does not match.'
    }
    & (Join-Path $PSScriptRoot 'verify-native-uia.ps1') -CompileOnly | Out-Null
    Add-Type -LiteralPath (Join-Path $PSScriptRoot 'HostedMotionNotifications.cs')
    $fixtureCode = @'
import { mkdir } from 'node:fs/promises';
import { createPerformanceFixture } from './scripts/performance-fixture.mjs';
await mkdir(process.argv[2], { recursive: true });
console.log(JSON.stringify(await createPerformanceFixture(process.argv[2], 'motion-notification', 0)));
'@
    $fixture = $fixtureCode | & node --input-type=module - $base
    if ($LASTEXITCODE -ne 0) { throw 'The synthetic fixture could not be generated.' }
    $dataset = $fixture | ConvertFrom-Json
    if ($dataset.syntheticOnly -ne $true -or $dataset.skillCount -ne 1000) { throw 'Unexpected fixture.' }
    $temporary = New-Item -ItemType Directory -Path (Join-Path $dataset.root 'temp')
    $profile = New-Item -ItemType Directory -Path (Join-Path $dataset.root 'webview-profile')
    $report.fixtureSha256 = (Get-FileHash -LiteralPath (Join-Path $dataset.root 'dataset.json')).Hash.ToLowerInvariant()

    $report.phase = 'owned-window'
    try {
        $env:WEBVIEW2_USER_DATA_FOLDER = $profile.FullName
        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port --remote-debugging-address=127.0.0.1"
        $session = [NativeUiMeasurement]::new($Candidate, [string]$dataset.dataDir, $temporary.FullName, $true)
    } finally {
        Remove-Item Env:WEBVIEW2_USER_DATA_FOLDER,Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
    }
    $session.Ready(20)
    $session.ReadObservation('task_list') | Out-Null
    $report.native = [ordered]@{ pid=$session.Pid; creationFileTime=$session.CreationFileTime; windowHandle=$session.Handle }
    function Assert-OwnedForeground {
        if ($session.WindowIdentity().foregroundHandle -ne $session.Handle) { throw 'The exact owned window is not the foreground window.' }
    }
    Assert-OwnedForeground

    $report.phase = 'bind-webview'
    $binding = [Diagnostics.Stopwatch]::StartNew()
    do {
        $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
        if ($listeners.Count) { break }
        Start-Sleep -Milliseconds 100
    } while ($binding.ElapsedMilliseconds -lt 5000)
    $browserIds = @($listeners.OwningProcess | Sort-Object -Unique)
    if ($browserIds.Count -ne 1 -or '127.0.0.1' -notin $listeners.LocalAddress -or
        @($listeners | Where-Object LocalAddress -NotIn @('127.0.0.1', '::1')).Count) {
        throw 'No exclusive owned IPv4 loopback CDP listener was available. Windows motion was untouched.'
    }
    $browserId = [int]$browserIds[0]
    $ownedBrowser = @($session.MemorySample().processes | Where-Object pid -EQ $browserId)
    $browser = Get-CimInstance Win32_Process -Filter "ProcessId=$browserId"
    if ($ownedBrowser.Count -ne 1 -or $browser.Name -ine 'msedgewebview2.exe' -or $browser.CommandLine -match '(?:^|\s)--type=' -or
        $browser.CommandLine -notmatch "(?:^|\s)--remote-debugging-port=$port(?:\s|$)" -or
        $browser.CommandLine -notmatch '--user-data-dir=(?:"([^"]+)"|([^\s]+))') {
        throw 'The CDP listener does not belong to the exact owned WebView browser.'
    }
    $profileArgument = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
    $actualProfile = Get-Item -LiteralPath ([IO.Path]::GetFullPath($profileArgument))
    if ($actualProfile.FullName -notin @($profile.FullName, (Join-Path $profile.FullName 'EBWebView')) -or
        ($actualProfile.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        ($profile.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'The WebView browser profile is outside the exact synthetic profile.'
    }
    $report.browser = [ordered]@{ pid=$browserId; creationFileTime=$ownedBrowser[0].creationFileTime
        version=(Get-Item -LiteralPath $browser.ExecutablePath).VersionInfo.ProductVersion; port=$port }

    $readerStart = [Diagnostics.ProcessStartInfo]::new((Get-Command node -CommandType Application).Source)
    $readerStart.UseShellExecute = $false
    $readerStart.CreateNoWindow = $true
    $readerStart.RedirectStandardInput = $true
    $readerStart.RedirectStandardOutput = $true
    $readerStart.ArgumentList.Add((Join-Path $PSScriptRoot 'read-hosted-motion-state.mjs'))
    $readerStart.ArgumentList.Add([string]$port)
    $reader = [Diagnostics.Process]::Start($readerStart)
    function Read-CdpLine {
        $pending = $reader.StandardOutput.ReadLineAsync()
        if (-not $pending.Wait(5000) -or [string]::IsNullOrWhiteSpace($pending.Result)) {
            throw 'The owned read-only CDP client did not reply.'
        }
        return $pending.Result | ConvertFrom-Json
    }
    $attachment = Read-CdpLine
    if ($attachment.attached -ne $true) { throw 'The expected app page did not attach.' }
    $report.browser.target = $attachment.target

    $report.phase = 'select-follow-system'
    $session.InvokeUnique('设置', '主要导航')
    $settings = [Diagnostics.Stopwatch]::StartNew()
    do {
        $sections = @($session.InspectNamed('设置分类：常规', $null) | Where-Object {
            $_.type -ceq 'ControlType.Button' -and $_.enabled -and -not $_.offscreen
        })
        if ($sections.Count -gt 1) { throw 'The owned settings disclosure is ambiguous.' }
        if ($sections.Count -eq 1) { break }
        Start-Sleep -Milliseconds 50
    } while ($settings.ElapsedMilliseconds -lt 10000)
    if ($sections.Count -ne 1) { throw 'The owned settings page did not appear.' }
    if (-not @($session.InspectNamed('外观', $null) | Where-Object {
        $_.type -ceq 'ControlType.Button' -and $_.enabled -and -not $_.offscreen
    }).Count) { $session.InvokeUnique('设置分类：常规', $null) }
    $session.InvokeUnique('外观', '设置分类')
    if ($session.SelectCombo('动效', '跟随系统（默认）', $false, $false) -cne '跟随系统（默认）') {
        throw 'The owned Follow system preference did not take effect.'
    }

    function Read-DiagnosticState {
        Assert-OwnedForeground
        $reader.StandardInput.WriteLine('snapshot')
        $reader.StandardInput.Flush()
        $state = Read-CdpLine
        if ($state.preference -cne 'system' -or $state.reduced -isnot [bool] -or $state.focused -isnot [bool] -or
            $state.motion -cnotin @('light', 'none') -or $state.basic -ceq 'true') {
            throw 'The exact active Follow system document did not report usable state.'
        }
        return [ordered]@{ qpc=[Diagnostics.Stopwatch]::GetTimestamp(); web=$state
            osAnimationsEnabled=[HostedMotionNotifications]::AnimationsEnabled() }
    }

    $report.phase = 'motion-notifications'
    $receiver = [HostedMotionNotifications]::new()
    $original = [HostedMotionNotifications]::AnimationsEnabled()
    $report.originalAnimationsEnabled = $original
    $report.baseline = Read-DiagnosticState
    Save-Report
    foreach ($requested in @((-not $original), $original)) {
        $flip = [ordered]@{ requested=$requested; samples=@() }
        $report.flips += $flip
        $report.attemptedSystemChange = $true
        Assert-OwnedForeground
        $flip.requestQpc = [Diagnostics.Stopwatch]::GetTimestamp()
        [HostedMotionNotifications]::SetAnimations($requested)
        $flip.readbackQpc = [Diagnostics.Stopwatch]::GetTimestamp()
        $clock = [Diagnostics.Stopwatch]::StartNew()
        foreach ($delay in @(0, 100, 500, 1500, 3000)) {
            $remaining = $delay - $clock.ElapsedMilliseconds
            if ($remaining -gt 0) { Start-Sleep -Milliseconds $remaining }
            $observation = Read-DiagnosticState
            $flip.samples += $observation
            if ($observation.osAnimationsEnabled -ne $requested) {
                throw 'Windows motion state changed unexpectedly during observation.'
            }
            Save-Report
        }
        $flip.notifications = @($receiver.Snapshot() | Where-Object Qpc -GE $flip.requestQpc)
        $flip.matchingBroadcast = @($flip.notifications | Where-Object Action -EQ 0x1043).Count -gt 0
        Save-Report
    }
    $report.status = 'diagnostic-collected'
} catch {
    $report.error = $_.Exception.GetBaseException().Message
} finally {
    if ($report.attemptedSystemChange) {
        try {
            if ([HostedMotionNotifications]::AnimationsEnabled() -ne $original) {
                [HostedMotionNotifications]::SetAnimations($original)
            }
            $report.restoredAnimationsEnabled = [HostedMotionNotifications]::AnimationsEnabled()
            $report.systemRestored = $report.restoredAnimationsEnabled -eq $original
        } catch { $report.restoreError = $_.Exception.GetBaseException().Message }
    }
    if ($receiver) {
        try {
            $report.allNotifications = @($receiver.Snapshot())
        } catch { $report.notificationError = $_.Exception.GetBaseException().Message }
        try { $receiver.Dispose() } catch { $report.notificationCloseError = $_.Exception.GetBaseException().Message }
    }
    if ($reader) {
        try {
            if (-not $reader.HasExited) { $reader.StandardInput.WriteLine('close'); $reader.StandardInput.Close() }
            $report.cdpClosed = $reader.WaitForExit(5000) -and $reader.ExitCode -eq 0
        } catch { $report.cdpCloseError = $_.Exception.GetBaseException().Message }
        finally { $reader.Dispose() }
    }
    if ($session) {
        try { $report.closedNormally = -not $session.Exited -and $session.RecoverQuit() -and $session.Exited }
        catch { $report.exitError = $_.Exception.GetBaseException().Message }
        finally { $session.Dispose() }
    }
    if (-not $report.systemRestored -or -not $report.closedNormally -or -not $report.cdpClosed -or
        $report.notificationError -or $report.notificationCloseError) { $report.status = 'incomplete' }
    Save-Report
}
[ordered]@{status=$report.status; phase=$report.phase; baseline=$report.baseline; flips=$report.flips
    systemRestored=$report.systemRestored; closedNormally=$report.closedNormally; error=$report.error} | ConvertTo-Json -Depth 9 -Compress
if ($report.status -cne 'diagnostic-collected') { exit 1 }
