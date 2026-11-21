param(
    [Parameter(Mandatory)][string]$Candidate,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedSha256
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or
    -not [Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {
    throw 'Require a fresh interactive GitHub-hosted Windows VM.'
}

$probe = Join-Path $env:RUNNER_TEMP 'arm-dxgi/bin/verify-hosted-dxgi-row.exe'
$evidence = New-Item -ItemType Directory -Path (Join-Path $env:RUNNER_TEMP 'arm-dxgi/evidence')
$output = Join-Path $evidence.FullName 'dxgi-capability.json'
$report = [ordered]@{
    candidateSha256 = $ExpectedSha256
    runnerImage = $env:ImageOS
    runnerImageVersion = $env:ImageVersion
    probeSourceSha256 = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'verify-hosted-dxgi-row.cpp')).Hash.ToLowerInvariant()
    probeExecutableSha256 = (Get-FileHash -LiteralPath $probe).Hash.ToLowerInvariant()
    syntheticOnly = $true
    status = 'incomplete'
    phase = 'preflight'
    maxCaptureMs = 15
    closedNormally = $false
    scope = 'One clipped navigation background row with a compositor timestamp. No input injection, system motion changes, display DPI validation or animation timing verdict.'
}
function Write-Report { $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $output -Encoding utf8NoBOM }
Write-Report

$session = $null
try {
    $base = 'D:\03_github_projects\Agent_Management\Agent_Resource_Manager\validation\manager-data'
    if (-not (Test-Path -LiteralPath 'D:\' -PathType Container) -or (Test-Path -LiteralPath $base) -or
        (Get-Process -Name agent-resource-manager,skill-manager -ErrorAction SilentlyContinue)) {
        throw 'Require a fresh D-drive fixture directory and no existing manager process.'
    }
    $Candidate = (Resolve-Path -LiteralPath $Candidate).ProviderPath
    if ([IO.Path]::GetFileName($Candidate) -cne 'agent-resource-manager.exe' -or
        (Get-FileHash -LiteralPath $Candidate).Hash.ToLowerInvariant() -cne $ExpectedSha256) {
        throw 'The exact candidate executable is required.'
    }
    & (Join-Path $PSScriptRoot 'verify-native-uia.ps1') -CompileOnly | Out-Null

    $report.phase = 'synthetic-fixture'
    $fixtureCode = @'
import { mkdir } from 'node:fs/promises';
import { createPerformanceFixture } from './scripts/performance-fixture.mjs';
await mkdir(process.argv[2], { recursive: true });
console.log(JSON.stringify(await createPerformanceFixture(process.argv[2], 'dxgi-capability', 0)));
'@
    $fixture = $fixtureCode | & node --input-type=module - $base
    if ($LASTEXITCODE -ne 0) { throw 'Could not generate the existing synthetic fixture.' }
    $dataset = $fixture | ConvertFrom-Json
    if ($dataset.syntheticOnly -ne $true -or $dataset.skillCount -ne 1000 -or $dataset.toolCount -ne 0 -or
        $dataset.settings.uiMotion -cne 'light' -or $dataset.settings.uiTheme -cne 'dark') {
        throw 'Unexpected synthetic fixture or initial appearance.'
    }
    $temporary = New-Item -ItemType Directory -Path (Join-Path $dataset.root 'temp')
    $report.fixtureSha256 = (Get-FileHash -LiteralPath (Join-Path $dataset.root 'dataset.json')).Hash.ToLowerInvariant()

    $report.phase = 'owned-window'
    $session = [NativeUiMeasurement]::new($Candidate, [string]$dataset.dataDir, $temporary.FullName, $true)
    $session.Ready(20)
    $session.ReadObservation('task_list') | Out-Null
    $report.native = [ordered]@{ pid = $session.Pid; creationFileTime = $session.CreationFileTime; windowHandle = $session.Handle }
    # Any foreground failure stops before the native desktop duplication call.
    if ($session.WindowIdentity().foregroundHandle -ne $session.Handle) { throw 'The isolated candidate did not open in the foreground.' }

    $report.phase = 'settings'
    $session.InvokeUnique('设置', '主要导航')
    $settingsReady = [Diagnostics.Stopwatch]::StartNew()
    do {
        $sections = @($session.InspectNamed('设置分类：常规', $null) | Where-Object {
            $_.type -ceq 'ControlType.Button' -and $_.enabled -and -not $_.offscreen
        })
        if ($sections.Count -gt 1) { throw 'The owned settings disclosure is ambiguous.' }
        if ($sections.Count -eq 1) { break }
        Start-Sleep -Milliseconds 50
    } while ($settingsReady.ElapsedMilliseconds -lt 10000)
    if ($sections.Count -ne 1) { throw 'The owned settings page did not appear.' }

    $uia = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]$session.Handle)
    function Find-VisibleExact($root, [string]$name) {
        $matches = $root.FindAll([Windows.Automation.TreeScope]::Descendants,
            [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $name))
        if ($matches.Count -ne 1 -or $matches[0].Current.IsOffscreen -or -not $matches[0].Current.IsEnabled) {
            throw "Cannot verify one visible owned control $name."
        }
        return $matches[0]
    }
    $nav = Find-VisibleExact $uia '主要导航'
    $button = Find-VisibleExact $nav '工具'
    $geometry = $button.Current.BoundingRectangle
    if ($button.Current.ControlType -ne [Windows.Automation.ControlType]::Button -or
        $geometry.IsEmpty -or $geometry.Width -lt 170 -or $geometry.Height -lt 30 -or
        -not $uia.Current.BoundingRectangle.Contains($geometry)) {
        throw 'The expected wide, visible owned navigation geometry is unavailable.'
    }
    $report.target = '主要导航 / 工具（未选中）'
    $left = [int]($geometry.Left + 7)
    $right = [int]($geometry.Right - 9)
    $row = [int]($geometry.Top + $geometry.Height / 2)
    $report.points = @($left, $row, $right, $row)
    # Endpoints observed in the exact build's independent native BitBlt trace, run 44399328599.
    $report.referenceColors = @(1775639, 3879984)

    $report.phase = 'desktop-duplication'
    $result = @(& $probe --hosted $session.Pid $session.CreationFileTime $session.Handle $left $row $right 2>&1)
    $report.probeExitCode = $LASTEXITCODE
    $json = @($result | Where-Object { $_ -is [string] })
    if ($json.Count -eq 1) {
        $report.frame = $json[0] | ConvertFrom-Json
    } else {
        $report.probeDiagnostic = @($result | ForEach-Object { $_.ToString() })
    }
    if ($report.probeExitCode -ne 0 -or $report.frame.status -cne 'one-compositor-row-within-budget') {
        throw 'DXGI did not return one clipped compositor row within the existing capture budget.'
    }
    $frame = $report.frame
    if ($frame.qpcFrequency -le 0 -or $frame.sampleBeginQpc -le 0 -or $frame.sampleEndQpc -lt $frame.sampleBeginQpc -or
        $frame.presentQpc -le 0 -or $frame.presentQpc -gt $frame.sampleEndQpc -or $frame.accumulatedFrames -lt 1 -or
        $frame.rowWidth -ne ($right - $left + 1)) {
        throw 'Invalid compositor timestamp or captured row metadata.'
    }
    $captureMs = ($frame.sampleEndQpc - $frame.sampleBeginQpc) * 1000.0 / $frame.qpcFrequency
    if ($captureMs -gt $report.maxCaptureMs -or [Math]::Abs($captureMs - $frame.sampleMs) -gt 0.000001) {
        throw 'The raw QPC values do not substantiate the claimed capture timing.'
    }
    if ($frame.first -ne $frame.second -or $frame.first -notin $report.referenceColors) {
        throw 'The two pixel colors did not match the known synthetic navigation row.'
    }
    $report.status = 'exercised-one-dxgi-row'
} catch {
    $report.error = $_.Exception.GetBaseException().Message
} finally {
    if ($session) {
        try { $report.closedNormally = -not $session.Exited -and $session.RecoverQuit() -and $session.Exited }
        catch { $report.exitError = $_.Exception.GetBaseException().Message }
        finally { $session.Dispose() }
    }
    if (-not $report.closedNormally) { $report.status = 'incomplete' }
    $report.finishedAt = [DateTime]::UtcNow.ToString('o')
    Write-Report
}
$report | ConvertTo-Json -Depth 8 -Compress
if ($report.status -cne 'exercised-one-dxgi-row') { exit 1 }
