param(
    [Parameter(Mandatory)][string]$Candidate,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedSha256
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or
    $env:ImageOS -cne 'win25-vs2026' -or $env:ImageVersion -cne '20261116.315.1' -or
    -not [Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {
    throw 'This can run only in a fresh interactive GitHub-hosted Windows VM.'
}

$evidence = New-Item -ItemType Directory -Path (Join-Path $env:RUNNER_TEMP 'arm-motion-pixels-evidence')
$output = Join-Path $evidence.FullName 'motion-pixels.json'
$policy = [ordered]@{ trials=3; neutralSettleMs=250; beforeMs=95; afterMs=430; maxCaptureMs=15; maxGapMs=32; latestReducedEndpointMs=105;
    minimumEndpointSamples=4; minimumRgbDistance=12; minimumIntermediateColors=2 }
$report = [ordered]@{ candidateSha256=$ExpectedSha256; syntheticOnly=$true; status='incomplete'; phase='preflight'
    policy=$policy; arms=@(); attemptedSystemChange=$false; systemRestored=$false; closedNormally=$false
    previousRun=[ordered]@{id='44854495440'; status='inconclusive'; reason='A two-update DXGI batch interrupted the first positive control under that run''s policy.'}
    previousR2=[ordered]@{id='44855333628'; status='incomplete'; passedArms=2; totalArms=4}
    previousR3=[ordered]@{id='44857754039'; status='incomplete'; qualifiedTrialsPerArm=@(1,1,3,0); reason='Coalesced updates and over-budget compositor gaps in seven positive trials.'}
    notificationProbe=[ordered]@{id='44857288176'; setterFlags=2; stateChanged=$true; matchingNotifications=0}
    setterFlags=3; motionChanges=@()
    notificationScope='A separate hidden top-level window observes real settings broadcasts in the hosted session. WebView-specific receipt is not inferred.'
    capture='One DXGI duplication over each trial. Successful acquisitions are followed immediately by another poll; only no-update polls use a 1 ms high-resolution wait. No-update and pointer-only polls retain the last timestamped desktop row. Raw QPC timestamps identify acquisition, row read and release.'
    runnerImage=$env:ImageOS; runnerImageVersion=$env:ImageVersion
    scope='Native foreground hover pixels on one inactive sidebar control. No DOM or CSS readback and no display-DPI or whole-app animation claim.' }
function Write-Report { $report | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath $output -Encoding utf8NoBOM }
Write-Report

$session = $null
$receiver = $null
$original = $null
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

    $probe = Join-Path $env:RUNNER_TEMP 'arm-dxgi/bin/verify-hosted-dxgi-row.exe'
    $report.probeSourceSha256 = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'verify-hosted-dxgi-row.cpp')).Hash.ToLowerInvariant()
    $report.probeExecutableSha256 = (Get-FileHash -LiteralPath $probe).Hash.ToLowerInvariant()

    # Compile the existing window/pipe guard and normal-quit path without launching it.
    & (Join-Path $PSScriptRoot 'verify-native-uia.ps1') -CompileOnly | Out-Null
    $receiverSource = Join-Path $PSScriptRoot 'HostedMotionNotifications.cs'
    Add-Type -LiteralPath $receiverSource
    $report.notificationSourceSha256 = (Get-FileHash -LiteralPath $receiverSource).Hash.ToLowerInvariant()

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
    function Wait-VisibleControl([string]$name,[string]$type) {
        $clock = [Diagnostics.Stopwatch]::StartNew()
        do {
            $rows = @($session.InspectNamed($name,$null) | Where-Object { $_.type -ceq $type -and $_.enabled -and -not $_.offscreen })
            if ($rows.Count -gt 1) { throw "The visible owned control is ambiguous: $name." }
            if ($rows.Count -eq 1) { return }
            Start-Sleep -Milliseconds 50
        } while ($clock.ElapsedMilliseconds -lt 10000)
        throw "The visible owned control did not appear: $name."
    }

    $report.phase = 'settings-navigation'
    $session.InvokeUnique('设置','主要导航')
    $report.phase = 'settings-classification'
    Wait-VisibleControl '设置分类：常规' 'ControlType.Button'
    if (-not @($session.InspectNamed('外观',$null) | Where-Object { $_.type -ceq 'ControlType.Button' -and $_.enabled -and -not $_.offscreen }).Count) {
        $session.InvokeUnique('设置分类：常规',$null)
    }
    $report.phase = 'settings-appearance'
    $session.InvokeUnique('外观','设置分类')
    Wait-VisibleControl '设置分类：外观' 'ControlType.Button'
    $report.phase = 'settings-motion-control'
    # SelectCombo resolves the unique owned control and presents it via its native scroll pattern if needed.
    $report.motionControlBeforeSelection = @($session.InspectNamed('动效',$null) | Select-Object type,enabled,offscreen)
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

    function Set-ObservedMotion([bool]$requested, [string]$reason, [switch]$Restore) {
        if (-not $Restore -and $session.WindowIdentity().foregroundHandle -ne $session.Handle) {
            throw 'The owned test window is no longer in the foreground.'
        }
        $before = [HostedMotionNotifications]::AnimationsEnabled()
        if ($before -eq $requested) { throw 'A real setting change is required for fresh broadcast evidence.' }
        $change = [ordered]@{ number=1+$report.motionChanges.Count; reason=$reason; before=$before
            requested=$requested; confirmed=$false }
        $report.motionChanges += $change
        $report.attemptedSystemChange = $true
        Write-Report
        $change.requestQpc = [Diagnostics.Stopwatch]::GetTimestamp()
        [HostedMotionNotifications]::SetAnimations($requested)
        $change.observedValue = [HostedMotionNotifications]::AnimationsEnabled()
        $clock = [Diagnostics.Stopwatch]::StartNew()
        do {
            $change.notifications = @($receiver.Snapshot() | Where-Object Qpc -GE $change.requestQpc)
            $matching = @($change.notifications | Where-Object Action -EQ 0x1043)
            if ($matching.Count) { break }
            Start-Sleep -Milliseconds 50
        } while ($clock.ElapsedMilliseconds -lt 2000)
        $change.confirmed = $change.observedValue -eq $requested -and $matching.Count -gt 0
        Write-Report
        if (-not $change.confirmed) {
            throw 'No matching WM_SETTINGCHANGE (0x1043) arrived after a confirmed Windows animation-state change.'
        }
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

    function Read-DxgiTrace($raw, $points) {
        $frequency = [long]$raw.qpcFrequency
        $trigger = [long]$raw.triggerBeginQpc
        $anchor = $raw.baseline
        if ($frequency -le 0 -or $trigger -le 0 -or $raw.triggerEndQpc -lt $trigger -or
            $raw.neutralArrivedQpc -le 0 -or $anchor.begin -lt $raw.neutralArrivedQpc -or
            $raw.baselineStartedQpc -lt $anchor.end -or $raw.observationEndQpc -lt $raw.triggerEndQpc -or
            ($anchor.begin - $raw.neutralArrivedQpc) * 1000.0 / $frequency -lt $policy.neutralSettleMs -or
            ($trigger - $raw.baselineStartedQpc) * 1000.0 / $frequency -lt $policy.beforeMs -or
            ($raw.observationEndQpc - $trigger) * 1000.0 / $frequency -lt $policy.afterMs -or
            $anchor.kind -cne 'desktop' -or $anchor.begin -le 0 -or $anchor.end -lt $anchor.begin -or
            $anchor.present -le 0 -or $anchor.present -gt $anchor.end -or $anchor.accumulated -lt 1 -or
            ($anchor.end - $anchor.begin) * 1000.0 / $frequency -gt $policy.maxCaptureMs -or
            $anchor.first -ne 1775639 -or $anchor.second -ne 1775639 -or
            $raw.rowWidth -ne ($points.background[2] - $points.background[0] + 1)) {
            throw 'The exact synthetic baseline row or raw trigger timestamps did not verify.'
        }
        $lastEnd = [long]$anchor.end
        $lastPresent = [long]$anchor.present
        $first = [uint32]$anchor.first
        $second = [uint32]$anchor.second
        foreach ($sample in $raw.samples) {
            if ($sample.begin -lt $lastEnd -or $sample.end -lt $sample.begin -or
                ($sample.end - $sample.begin) * 1000.0 / $frequency -gt $policy.maxCaptureMs) {
                throw 'The ordered sample timestamps exceeded the capture budget.'
            }
            $lastEnd = [long]$sample.end
            if ($sample.kind -ceq 'desktop') {
                if ($sample.accumulated -lt 1 -or $sample.present -le $lastPresent -or $sample.present -gt $sample.end) {
                    throw 'The desktop update metadata is invalid or out of order.'
                }
                $lastPresent = [long]$sample.present
                $first = [uint32]$sample.first
                $second = [uint32]$sample.second
            } elseif ($sample.kind -cnotin @('pointer-only', 'no-update') -or $sample.present -ne 0 -or
                $sample.accumulated -ne 0 -or $sample.first -ne 0 -or $sample.second -ne 0) {
                throw 'A sample did not prove either a new desktop image or an unchanged desktop image.'
            }
            [pscustomobject]@{
                BeginMs = ($sample.begin - $trigger) * 1000.0 / $frequency
                EndMs = ($sample.end - $trigger) * 1000.0 / $frequency
                PresentQpc = $lastPresent
                Kind = $sample.kind
                Accumulated = [int]$sample.accumulated
                First = $first
                Second = $second
            }
        }
        if ($lastEnd -gt $raw.observationEndQpc -or
            ($raw.observationEndQpc - $lastEnd) * 1000.0 / $frequency -gt $policy.maxGapMs) {
            throw 'The trace did not cover the end of the observation window.'
        }
    }

    function Score-DxgiTrial($trial, $points, [bool]$expectTransition) {
        $raw = $trial.rawDxgi
        $trace = @(Read-DxgiTrace $raw $points)
        $trial.trace = $trace
        $early = @($trace | Where-Object { $_.EndMs -le -3 })
        $late = @($trace | Where-Object { $_.BeginMs -ge 290 })
        if ($early.Count -lt $policy.minimumEndpointSamples -or $late.Count -lt $policy.minimumEndpointSamples) {
            throw 'The capture clock did not cover both hover endpoints.'
        }
        $baseColor = [uint32]$early[0].First
        $hoverColor = [uint32]$late[-1].First
        $badReads = @($trace | Where-Object { $_.First -ne $_.Second -or ($_.EndMs - $_.BeginMs) -gt $policy.maxCaptureMs })
        $badTimeline = @($trace | Where-Object {
            $_.First -ne $baseColor -and ($_.BeginMs -lt 0 -or $_.PresentQpc -lt $raw.triggerBeginQpc)
        })

        $sampleGapMs = 0.0
        for ($i=1; $i -lt $trace.Count; $i++) {
            $sampleGapMs = [Math]::Max($sampleGapMs, $trace[$i].BeginMs - $trace[$i-1].EndMs)
        }
        $postTriggerFrames = @($trace | Where-Object {
            $_.Kind -ceq 'desktop' -and $_.BeginMs -ge 0 -and $_.PresentQpc -ge $raw.triggerBeginQpc
        })
        $batches = @($trace | Where-Object { $_.Accumulated -gt 1 })
        $batchesAfterTrigger = @($batches | Where-Object { $_.PresentQpc -ge $raw.triggerBeginQpc })
        $mid = @($postTriggerFrames | Where-Object {
            (Distance-Rgb $_.First $baseColor) -gt 1 -and (Distance-Rgb $_.First $hoverColor) -gt 1
        })
        $midColors = @($mid | ForEach-Object { $_.First } | Sort-Object -Unique)
        $firstHover = $postTriggerFrames | Where-Object { $_.First -eq $hoverColor } | Select-Object -First 1
        $backToNeutral = @($trace | Where-Object { $_.BeginMs -gt $firstHover.EndMs -and $_.First -eq $baseColor })
        $unexpectedColors = @($mid | Where-Object { -not (Test-RgbPath $_.First $baseColor $hoverColor) })
        $presentGapMs = 0.0
        if ($mid.Count -gt 0 -and $firstHover) {
            $moving = @($postTriggerFrames | Where-Object {
                $_.PresentQpc -ge $mid[0].PresentQpc -and $_.PresentQpc -le $firstHover.PresentQpc
            })
            for ($i=1; $i -lt $moving.Count; $i++) {
                $elapsed = ($moving[$i].PresentQpc - $moving[$i-1].PresentQpc) * 1000.0 / $raw.qpcFrequency
                $presentGapMs = [Math]::Max($presentGapMs, $elapsed)
            }
        }

        $trial.maxGapMs = $sampleGapMs
        $trial.maxTransitionPresentGapMs = $presentGapMs
        $trial.neutralColor = $baseColor
        $trial.hoverColor = $hoverColor
        $trial.intermediateColors = $midColors.Count
        $trial.firstHoverSampleMs = $firstHover.EndMs
        $trial.unexpectedColors = $unexpectedColors.Count
        $trial.unexpectedTimelineSamples = $badTimeline.Count
        $trial.coalescedSamples = $batches.Count
        $trial.postTriggerCoalescedSamples = $batchesAfterTrigger.Count
        $trial.additionalCoalescedUpdates = [int](($batches | ForEach-Object { $_.Accumulated - 1 } | Measure-Object -Sum).Sum)

        $valid = $null -ne $firstHover -and $badReads.Count -eq 0 -and $badTimeline.Count -eq 0 -and
            $sampleGapMs -le $policy.maxGapMs -and $presentGapMs -le $policy.maxGapMs -and
            $baseColor -eq 1775639 -and $hoverColor -eq 3879984 -and
            $backToNeutral.Count -eq 0 -and $unexpectedColors.Count -eq 0 -and
            @(($early.First | Where-Object { $_ -ne $baseColor })).Count -eq 0 -and
            @(($late.First | Where-Object { $_ -ne $hoverColor })).Count -eq 0 -and
            (Distance-Rgb $baseColor $hoverColor) -ge $policy.minimumRgbDistance
        $trial.valid = $valid
        if (-not $valid) { throw 'Visible pixels were noisy, discontinuous, occluded or missing an endpoint.' }

        if ($expectTransition) {
            # Only actual post-trigger presents can establish visible positive motion.
            $intermediateBeforeEndpoint = @($mid | Where-Object { $_.PresentQpc -lt $firstHover.PresentQpc } |
                ForEach-Object { $_.First } | Sort-Object -Unique)
            $trial.intermediateColorsBeforeEndpoint = $intermediateBeforeEndpoint.Count
            if ($intermediateBeforeEndpoint.Count -lt $policy.minimumIntermediateColors) {
                throw 'Positive hover control did not show two measurable intermediate colors before the endpoint.'
            }
        } else {
            # The newest timestamp cannot establish where each constituent frame occurred.
            if ($batchesAfterTrigger.Count) { throw 'Coalesced updates during the post-trigger window make absent motion inconclusive.' }
            if ($firstHover.EndMs -gt $policy.latestReducedEndpointMs) {
                throw 'The endpoint arrived too late to distinguish absent motion from a delayed visual read.'
            }
            if ($midColors.Count -ne 0) {
                $trial.status = 'unexpected-visible-motion'
                throw 'Intermediate visible pixels remained in the reduced-motion observation.'
            }
        }
    }

    function Run-Arm([string]$name,[bool]$expectedEnabled,[bool]$expectTransition) {
        $report.phase = $name
        $arm = [ordered]@{ name=$name; osAnimationsEnabled=$expectedEnabled; expectTransition=$expectTransition; trials=@() }
        $report.arms += $arm
        $verified = $report.motionChanges[-1]
        if (-not $verified.confirmed -or $verified.requested -ne $expectedEnabled -or
            [HostedMotionNotifications]::AnimationsEnabled() -ne $expectedEnabled) {
            throw 'The current OS state lacks verified broadcast evidence before this arm.'
        }
        $arm.osNotification = $verified.number
        $points = $report.points
        for ($attempt=1; $attempt -le $policy.trials; $attempt++) {
            if ($button.Current.IsOffscreen -or $button.Current.BoundingRectangle -ne $geometry) {
                throw 'The original navigation target moved or became unavailable.'
            }
            $trial = [ordered]@{ attempt=$attempt; status='started' }
            $arm.trials += $trial
            $probeArguments = @($session.Pid, $session.CreationFileTime, $session.Handle,
                $points.background[0], $points.background[1], $points.background[2],
                $points.neutral[0], $points.neutral[1], $points.hover[0], $points.hover[1])
            $raw = @(& $probe --hosted-hover @probeArguments 2>&1)
            $trial.exitCode = $LASTEXITCODE
            if ($trial.exitCode -ne 0 -or $raw.Count -ne 1 -or $raw[0] -isnot [string]) {
                $trial.diagnostic = @($raw | ForEach-Object { $_.ToString() })
                throw 'The native DXGI hover probe stopped before it could provide a valid trace.'
            }
            $trial.rawDxgi = $raw[0] | ConvertFrom-Json
            try {
                Score-DxgiTrial $trial $points $expectTransition
                $trial.status = 'observed'
            } catch {
                if ($trial.status -ceq 'started') { $trial.status = 'inconclusive' }
                $trial.error = $_.Exception.GetBaseException().Message
            }
            Write-Report
        }

        if ([HostedMotionNotifications]::AnimationsEnabled() -ne $expectedEnabled) { throw 'OS setting changed during this arm.' }
        $arm.pairedObservationPassed = ($arm.trials.Count -eq $policy.trials -and
            @($arm.trials | Where-Object { $_.status -cne 'observed' }).Count -eq 0)
        Write-Report
    }

    $report.phase = 'preflight-motion-notification'
    $receiver = [HostedMotionNotifications]::new()
    $original = [HostedMotionNotifications]::AnimationsEnabled()
    $report.originalAnimationsEnabled = $original
    Select-Motion '轻动效'
    Set-ObservedMotion (-not $original) 'preflight-opposite'
    Set-ObservedMotion $original 'preflight-original'
    Start-Sleep -Milliseconds 550
    Run-Arm 'explicit-light-preflight' $original $true

    $report.phase = 'system-enabled-notification'
    Select-Motion '跟随系统（默认）'
    if (-not $original) { Set-ObservedMotion $true 'system-enabled' }
    Start-Sleep -Milliseconds 550
    Run-Arm 'system-animations-enabled' $true $true
    $report.phase = 'system-disabled-notification'
    Set-ObservedMotion $false 'system-disabled'
    Start-Sleep -Milliseconds 550
    Run-Arm 'system-animations-disabled' $false $false
    Select-Motion '轻动效'
    Run-Arm 'explicit-light-with-os-disabled' $false $true
    if ($report.arms.Count -eq 4 -and @($report.arms | Where-Object { -not $_.pairedObservationPassed }).Count -eq 0) {
        $report.status = 'observed-visible-system-motion'
    } else {
        $report.error = 'At least one of the four conditions lacked three qualifying trials.'
    }
} catch {
    $report.error = $_.Exception.GetBaseException().Message
} finally {
    if ($report.attemptedSystemChange) {
        try {
            if ([HostedMotionNotifications]::AnimationsEnabled() -ne $original) {
                Set-ObservedMotion $original 'restore-initial-state' -Restore
            }
        } catch { $report.restoreError = $_.Exception.GetBaseException().Message }
        finally {
            try {
                $report.restoredAnimationsEnabled = [HostedMotionNotifications]::AnimationsEnabled()
                $report.systemRestored = $report.restoredAnimationsEnabled -eq $original
            } catch { $report.restoreReadbackError = $_.Exception.GetBaseException().Message }
        }
    }
    if ($receiver) {
        try { $receiver.Dispose() } catch { $report.notificationCloseError = $_.Exception.GetBaseException().Message }
    }
    if ($session) {
        try {
            if ($session.Exited) { throw 'The owned manager exited before the normal shutdown command.' }
            $report.closedNormally = $session.RecoverQuit() -and $session.Exited
        }
        catch { $report.exitError = $_.Exception.GetBaseException().Message }
        finally { $session.Dispose() }
    }
    if (-not $report.systemRestored -or -not $report.closedNormally -or $report.restoreError -or
        $report.notificationCloseError) { $report.status = 'incomplete' }
    $report.finishedAt = [DateTime]::UtcNow.ToString('o')
    Write-Report
}
$outcomes = @($report.arms | ForEach-Object {
    [ordered]@{ name=$_.name; passed=$_.pairedObservationPassed
        trials=@($_.trials | ForEach-Object { [ordered]@{status=$_.status; error=$_.error; batches=$_.postTriggerCoalescedSamples} }) }
})
[ordered]@{status=$report.status; phase=$report.phase; systemRestored=$report.systemRestored; closedNormally=$report.closedNormally; arms=$outcomes;
    setterFlags=$report.setterFlags; motionChanges=$report.motionChanges; candidateSha256=$ExpectedSha256; error=$report.error} |
    ConvertTo-Json -Depth 8 -Compress
if ($report.status -cne 'observed-visible-system-motion') { exit 1 }
