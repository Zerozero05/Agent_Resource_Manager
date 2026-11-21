param(
    [Parameter(Mandatory)][string]$ReviewBundle,
    [Parameter(Mandatory)][string]$RoiBundle,
    [Parameter(Mandatory)][string]$ApprovalFile,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ApprovalSha256,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ReferenceReceiptSha256,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$ReferenceCommit,
    [Parameter(Mandatory)][ValidatePattern('^[0-9]+$')][string]$ReferenceRunId
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$candidateSource = '37f83f135f9fd8facd90255fa33f58d534f8364d'
$candidateRun = '44889635017'
$candidateArtifact = $env:CANDIDATE_ARTIFACT_ID
$candidateSha256 = $env:CANDIDATE_SHA256
$candidateBuildInfoSha256 = $env:CANDIDATE_BUILD_INFO_SHA256
if ($candidateArtifact -cnotmatch '^[0-9]+$' -or $candidateSha256 -cnotmatch '^[a-f0-9]{64}$' -or
    $candidateBuildInfoSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Exact candidate provenance is required.' }
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or
    $env:GITHUB_REPOSITORY -ine 'Zerozero05/Agent_Resource_Manager' -or -not [Environment]::UserInteractive -or
    [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {
    throw 'The visual test requires an interactive disposable GitHub-hosted Windows job for this repository.'
}

function Assert-Digest([string]$path, [string]$expected) {
    if ($expected -cnotmatch '^[a-f0-9]{64}$') { throw 'A mandatory input digest is missing.' }
    $item = Get-Item -LiteralPath $path -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash -ine $expected) {
        throw "Unexpected visual input file: $($item.Name)"
    }
}

function Save-Json([string]$path, $value) {
    $value | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $path -Encoding utf8NoBOM
}

$workspace = (Resolve-Path -LiteralPath $env:GITHUB_WORKSPACE).ProviderPath
Set-Location -LiteralPath $workspace
if ((git rev-parse HEAD) -cne $ReferenceCommit -or $LASTEXITCODE -ne 0) { throw 'The exact reference harness checkout is required.' }
$receiptPath = Join-Path $ReviewBundle 'receipt.json'
Assert-Digest $receiptPath $ReferenceReceiptSha256
Assert-Digest $ApprovalFile $ApprovalSha256
$receipt = Get-Content -Raw -LiteralPath $receiptPath | ConvertFrom-Json
$approval = Get-Content -Raw -LiteralPath $ApprovalFile | ConvertFrom-Json
if ($receipt.status -cne 'references-generated-review-required' -or $receipt.candidateSource -cne $candidateSource -or
    $receipt.candidateSha256 -cne $candidateSha256 -or $receipt.candidateRunId -ne $candidateRun -or
    $receipt.candidateArtifactId -ne $candidateArtifact -or $receipt.normalExit -ne $true -or
    $receipt.referenceCount -ne 72 -or $receipt.roiCount -ne 210 -or $receipt.sheets -ne 9 -or
    $approval.reviewedBy -cne 'root' -or $approval.visualReviewConfirmed -ne $true -or
    $approval.referenceSha256 -cne $receipt.referenceSha256 -or @($approval.reviewedStates).Count -ne 72 -or
    $null -eq $receipt.hostedFirstSearchReceipt -or
    $receipt.referenceWorkflow.repository -cne $env:GITHUB_REPOSITORY -or
    $receipt.referenceWorkflow.headSha -cne $ReferenceCommit -or
    [string]$receipt.referenceWorkflow.runId -cne $ReferenceRunId -or $receipt.referenceWorkflow.attempt -ne 1) {
    throw 'Exact native reference provenance and completed visual review are required.'
}
$descriptorPath = Join-Path $ReviewBundle 'visual-dataset.json'
$referencePath = Join-Path $ReviewBundle 'visual-references.json'
$manifestPath = Join-Path $RoiBundle 'roi-files.json'
Assert-Digest $descriptorPath $receipt.descriptorSha256
Assert-Digest $referencePath $receipt.referenceSha256
Assert-Digest (Join-Path $ReviewBundle 'reference-driver.json') $receipt.driverSha256
Assert-Digest $manifestPath $receipt.roiTransportManifestSha256
$descriptor = Get-Content -Raw -LiteralPath $descriptorPath | ConvertFrom-Json
$reference = Get-Content -Raw -LiteralPath $referencePath | ConvertFrom-Json
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($descriptor.candidateSha256 -cne $candidateSha256 -or $reference.candidateSha256 -cne $candidateSha256 -or
    $reference.semanticReferencePhaseCompleted -ne $true -or $reference.root -cne $descriptor.root -or
    $reference.datasetFingerprint -cne $descriptor.dataset.dataFingerprint -or
    $manifest.format -cne 'agent-resource-manager-native-visual-roi-transport-v1' -or $manifest.syntheticOnly -ne $true -or
    $manifest.candidateSource -cne $candidateSource -or $manifest.candidateSha256 -cne $candidateSha256 -or
    $manifest.fixtureSha256 -cne $reference.datasetFingerprint -or $manifest.referenceSha256 -cne $receipt.referenceSha256 -or
    $manifest.roiCount -ne 210 -or @($manifest.files).Count -ne 210) {
    throw 'The visual descriptor, reviewed references, and transport manifest do not bind to the same candidate.'
}

$approved = 'D:\03_github_projects\Agent_Management\Agent_Resource_Manager\validation\manager-data'
$leaf = Split-Path -Leaf $descriptor.root
$root = Join-Path $approved $leaf
if ($leaf -cnotmatch '^native-visual-[A-Za-z0-9]+$' -or $root -ine $descriptor.root -or (Test-Path -LiteralPath $approved) -or
    (Get-Process -Name agent-resource-manager,skill-manager -ErrorAction SilentlyContinue)) {
    throw 'A fresh hosted fixture root and no existing manager are required.'
}
$states = @(0..65 | ForEach-Object { 'search-{0:D4}' -f $_ }) + @('all', 'github', 'document', 'homeDocument', 'documentTab', 'closed')
if (($states -join '|') -cne (@($approval.reviewedStates) -join '|') -or
    (($states | Sort-Object) -join '|') -cne (($reference.states.PSObject.Properties.Name | Sort-Object) -join '|') -or
    @($reference.reviewSheets).Count -ne 9) { throw 'The approval did not review these exact states and sheets.' }
foreach ($sheet in $reference.reviewSheets) {
    $name = Split-Path -Leaf $sheet.path
    if ($name -cnotmatch '^review-0[1-9]\.png$') { throw 'Unexpected review sheet name.' }
    Assert-Digest (Join-Path $ReviewBundle $name) $sheet.sha256
}
$roiFiles = @{}
foreach ($entry in $manifest.files) {
    if ($entry.state -cnotmatch '^(search-00[0-6][0-9]|all|github|document|homeDocument|documentTab|closed)$' -or
        $entry.index -isnot [long] -or $entry.index -lt 0 -or $entry.index -gt 2) { throw 'Invalid transported ROI identity.' }
    $relative = 'references/{0}-{1}.png' -f $entry.state, $entry.index
    $state = $reference.states.PSObject.Properties[$entry.state]
    $roi = if ($null -ne $state -and $entry.index -lt @($state.Value.rois).Count) { $state.Value.rois[$entry.index] }
    if ($entry.path -cne $relative -or $roiFiles.ContainsKey($relative) -or $null -eq $roi -or
        $roi.path -ine (Join-Path $root $relative) -or $roi.sha256 -cne $entry.sha256 -or
        $roi.role -cne $entry.role -or ($roi.box -join ',') -cne ($entry.box -join ',')) { throw 'A transported ROI diverged from the reviewed reference.' }
    $file = Join-Path $RoiBundle $relative
    Assert-Digest $file $entry.sha256
    $roiFiles[$relative] = $file
}
if (@(Get-ChildItem -LiteralPath $RoiBundle -Recurse -File -Force).Count -ne 211) { throw 'Unexpected ROI transport members.' }

$candidate = Join-Path $env:RUNNER_TEMP 'arm-native-performance'
$executable = Join-Path $candidate 'agent-resource-manager.exe'
$buildInfo = Join-Path $candidate 'BUILD_INFO.native-validation.json'
Assert-Digest $executable $candidateSha256
Assert-Digest $buildInfo $receipt.buildInfoSha256
$info = Get-Content -Raw -LiteralPath $buildInfo | ConvertFrom-Json
if ($info.buildMode -cne 'release' -or $info.sourceCommit -cne $candidateSource -or $info.executableSha256 -cne $candidateSha256 -or
    $info.originalBuildInfoSha256 -cne $candidateBuildInfoSha256 -or $info.workflowRunId -ne $candidateRun -or
    $info.workflowRunAttempt -ne 1 -or $info.repository -ine $env:GITHUB_REPOSITORY) {
    throw 'The verified release build metadata is not for the exact candidate.'
}

$module = Join-Path $workspace 'scripts/verify-native-visual-stability.mjs'
$bindings = [ordered]@{ executable=$executable; buildInfo=$buildInfo; candidateSha256=$candidateSha256
    buildInfoSha256=$receipt.buildInfoSha256; transportSha256=$candidateSha256
    hostedReferenceFrame=$receipt.referenceFrame; hostedFirstSearchReceipt=$receipt.hostedFirstSearchReceipt }
$text = [IO.File]::ReadAllText($module)
foreach ($key in $bindings.Keys) {
    $pattern = "(?m)^const $key = [^\r\n]+;(?=\r?$)"
    if ([regex]::Matches($text, $pattern).Count -ne 1) { throw "The exact native harness constant is missing: $key" }
    $literal = ConvertTo-Json -InputObject $bindings[$key] -Compress
    $text = [regex]::Replace($text, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($match) "const $key = $literal;" })
}
[IO.File]::WriteAllText($module, $text, [Text.UTF8Encoding]::new($false))
foreach ($source in $descriptor.sources) {
    $name = Split-Path -Leaf $source.path
    if ($name -cnotmatch '^[a-z][a-z0-9-]+\.(mjs|ps1)$' -or $source.path -ine (Join-Path $workspace "scripts/$name")) {
        throw 'Reference source paths do not match the hosted checkout.'
    }
    Assert-Digest $source.path $source.sha256
}
& node --check $module
if ($LASTEXITCODE -ne 0) { throw 'The bound native harness did not parse.' }

$measurements = Join-Path $env:RUNNER_TEMP 'arm-search-paint-result'
New-Item -ItemType Directory -Path $measurements | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $root 'references')) | Out-Null
foreach ($relative in $roiFiles.Keys) { Copy-Item -LiteralPath $roiFiles[$relative] -Destination (Join-Path $root $relative) }
Copy-Item -LiteralPath $descriptorPath, $referencePath -Destination $root
Copy-Item -LiteralPath $ApprovalFile -Destination (Join-Path $root 'visual-approval.json')
$fixture = @'
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPerformanceFixture } from './scripts/performance-fixture.mjs';
import { visualObserverSource } from './scripts/verify-native-visual-stability.mjs';
const root = process.argv[2];
await createPerformanceFixture(root, 'fixture', 100);
await writeFile(join(root, 'memory-observer.ps1'), visualObserverSource(), { flag: 'wx' });
'@
$fixture | & node --input-type=module - $root
if ($LASTEXITCODE -ne 0) { throw 'The deterministic synthetic fixture could not be rehydrated.' }
$localDescriptor = Join-Path $root 'visual-dataset.json'
$quitHelper = Join-Path $PSScriptRoot 'quit-physical-memory-session.ps1'
$overlayPath = Join-Path $PSScriptRoot 'diagnostic-inputs.json'
$overlay = Get-Content -Raw -LiteralPath $overlayPath | ConvertFrom-Json
if ($overlay.workflowCommit -cne $env:GITHUB_SHA -or $overlay.workflowCommit -cnotmatch '^[a-f0-9]{40}$') {
    throw 'The diagnostic helpers must be staged from this exact job commit.'
}
$diagnostic = Join-Path $workspace 'scripts/verify-native-search-paint.mjs'
$nativeHelper = Join-Path $workspace 'scripts/native-visual-input.ps1'
$stagedDriver = Join-Path $PSScriptRoot 'verify-native-search-paint.mjs'
$stagedNative = Join-Path $PSScriptRoot 'native-visual-input.ps1'
Assert-Digest $stagedDriver $overlay.driverSha256
Assert-Digest $stagedNative $overlay.nativeSha256
if (Test-Path -LiteralPath $diagnostic) { throw 'The frozen reference checkout unexpectedly contains the diagnostic driver.' }
# The exact preparation and stock sources above were checked before installing the
# separately identified diagnostic-only native operation. The reviewed fixture and
# original visual and latency modes retain their recorded identities.
Copy-Item -LiteralPath $stagedDriver -Destination $diagnostic
Copy-Item -LiteralPath $stagedNative -Destination $nativeHelper
Assert-Digest $diagnostic $overlay.driverSha256
Assert-Digest $nativeHelper $overlay.nativeSha256
& node --check $diagnostic
if ($LASTEXITCODE -ne 0) { throw 'The diagnostic driver did not parse.' }

function Run-Measurement {
    $phase = 'search-paint'
    $maxMinutes = 8
    $reportFile = Join-Path $measurements 'search-paint-detached.json'
    $proofFile = Join-Path $measurements 'search-paint-normal-quit.json'
    $lineCount = 0
    $quitProof = $null
    $node = Get-Command node.exe -CommandType Application | Select-Object -First 1
    $startInfo = [Diagnostics.ProcessStartInfo]::new($node.Source)
    $startInfo.WorkingDirectory = $workspace
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
    $startInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
    $startInfo.Environment['REFERENCE_SHA256'] = $receipt.referenceSha256
    $startInfo.Environment['APPROVAL_SHA256'] = $ApprovalSha256
    foreach ($arg in @($diagnostic, '--run', $localDescriptor, $executable, $buildInfo, $reportFile, 'detached')) {
        $startInfo.ArgumentList.Add($arg)
    }
    foreach ($name in @('GH_TOKEN', 'GITHUB_TOKEN')) { [void]$startInfo.Environment.Remove($name) }
    $process = [Diagnostics.Process]::Start($startInfo)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    try {
        $stderr = $process.StandardError.ReadToEndAsync()
        for (;;) {
            $read = $process.StandardOutput.ReadLineAsync()
            while (-not $read.Wait(1000)) {
                if ($clock.Elapsed.TotalMinutes -ge $maxMinutes) { throw "$phase timed out while waiting on the owned native harness." }
            }
            $line = $read.Result
            if ($null -eq $line) { break }
            $lineCount++
            if ($lineCount -gt 20000 -or $clock.Elapsed.TotalMinutes -ge $maxMinutes) { throw "$phase exceeded its output or runtime budget." }
            Write-Host $line
            if ($line -cnotmatch '^\{"phase":"ready-for-owned-normal-quit",') { continue }
            if ($null -ne $quitProof) { throw 'Duplicate normal-quit signal.' }
            $signal = $line | ConvertFrom-Json -ErrorAction Stop
            $inProgress = Get-Content -Raw -LiteralPath $reportFile | ConvertFrom-Json
            $identity = $inProgress.identity
            if ($signal.phase -cne 'ready-for-owned-normal-quit' -or $signal.arm -cne 'detached' -or
                $signal.reportPath -ine $reportFile -or $signal.executable -ine $executable -or $signal.waitMs -ne 120000 -or
                $inProgress.arm -cne 'detached' -or $inProgress.executableSha256 -cne $candidateSha256 -or
                $inProgress.referenceSha256 -cne $receipt.referenceSha256 -or $inProgress.approvalSha256 -cne $ApprovalSha256 -or
                $identity.pid -ne $signal.pid -or $identity.creationFileTime -cne $signal.creationFileTime -or
                $identity.pid -le 0 -or $identity.windowHandle -le 0 -or $identity.creationFileTime -cnotmatch '^[1-9][0-9]+$') {
                throw 'The detached diagnostic did not bind an exact normal-quit owner.'
            }
            $spec = [ordered]@{ pid=$identity.pid; creationFileTime=$identity.creationFileTime; windowHandle=$identity.windowHandle
                executable=$executable; sha256=$candidateSha256 }
            $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($spec | ConvertTo-Json -Compress)))
            $quitText = & pwsh.exe -NoProfile -NonInteractive -MTA -File $quitHelper -Spec $encoded
            if ($LASTEXITCODE -ne 0) { throw 'The exact normal quit did not complete.' }
            $quitProof = ($quitText -join "`n") | ConvertFrom-Json -ErrorAction Stop
            Save-Json $proofFile $quitProof
            if ($quitProof.exited -ne $true -or $quitProof.exitCode -ne 0 -or $quitProof.pid -ne $identity.pid -or
                $quitProof.creationFileTime -cne $identity.creationFileTime -or $quitProof.windowHandle -ne $identity.windowHandle) {
                throw 'The normal-exit receipt did not match the sampled owner.'
            }
        }
        if (-not $process.WaitForExit(5000)) { throw 'Native harness did not complete after output closed.' }
        $sourceReport = Get-Content -Raw -LiteralPath $reportFile | ConvertFrom-Json
        if ($null -eq $quitProof -or $sourceReport.normalExit -ne $true -or $sourceReport.runtimeFilesPreserved -ne $true -or
            $sourceReport.managementDataPreserved -ne $true -or $sourceReport.executableSha256 -cne $candidateSha256 -or
            $sourceReport.fixtureSha256 -cne $reference.datasetFingerprint -or $sourceReport.referenceSha256 -cne $receipt.referenceSha256 -or
            $sourceReport.approvalSha256 -cne $ApprovalSha256 -or $sourceReport.arm -cne 'detached') {
            throw 'The diagnostic report failed its identity, data, observer mode, or exit checks.'
        }
        if ($process.ExitCode -ne 0 -or $sourceReport.status -cne 'detached-paint-observed' -or @($sourceReport.samples).Count -ne 2) {
            throw 'Search-paint diagnostic did not collect sufficient valid observations.'
        }
        return $sourceReport
    } finally {
        try {
            $mismatch = Join-Path $root 'search-paint-mismatch.png'
            if (Test-Path -LiteralPath $mismatch) {
                $item = Get-Item -LiteralPath $mismatch -Force
                if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
                    $item.Length -lt 24 -or $item.Length -gt 2000000) { throw 'The bounded synthetic frame is not valid.' }
                $bytes = [IO.File]::ReadAllBytes($item.FullName)
                if (([Convert]::ToHexString($bytes,0,8)) -cne '89504E470D0A1A0A') { throw 'The diagnostic frame is not a PNG.' }
                $failure = Get-Content -Raw -LiteralPath $reportFile | ConvertFrom-Json
                if ($failure.status -cne 'detached-incomplete' -or $failure.arm -cne 'detached' -or
                    $failure.executableSha256 -cne $candidateSha256 -or
                    $failure.error -cnotmatch 'Saved search-paint-mismatch\.png at bounds=\[([0-9]+),([0-9]+),([0-9]+),([0-9]+)\]\.') {
                    throw 'The capture is not bound to the failed owned diagnostic.'
                }
                $actualBounds = @([int]$Matches[1],[int]$Matches[2],[int]$Matches[3],[int]$Matches[4])
                $visible = $receipt.captureBounds
                if ($actualBounds[2] -lt 2 -or $actualBounds[3] -lt 2 -or $actualBounds[0] -lt $visible[0] -or $actualBounds[1] -lt $visible[1] -or
                    ($actualBounds[0]+$actualBounds[2]) -gt ($visible[0]+$visible[2]) -or
                    ($actualBounds[1]+$actualBounds[3]) -gt ($visible[1]+$visible[3])) { throw 'The diagnostic frame leaves the approved client rectangle.' }
                $target = Join-Path $measurements 'search-paint-mismatch.png'
                if (Test-Path -LiteralPath $target) { throw 'A mismatch frame is already present.' }
                Copy-Item -LiteralPath $item.FullName -Destination $target
                Save-Json (Join-Path $measurements 'search-paint-mismatch-proof.json') ([ordered]@{
                    workflowCommit=$overlay.workflowCommit; candidateSha256=$candidateSha256; fixture=$reference.datasetFingerprint
                    gestureScope='two exact owned synthetic search actions'; originalLatencyGateEvaluated=$false
                    frameSha256=(Get-FileHash -LiteralPath $target).Hash.ToLowerInvariant()
                    frameBytes=$item.Length; bounds=$actualBounds
                })
            }
        } finally {
            if ($null -ne $stderr -and $stderr.IsCompletedSuccessfully -and $stderr.Result) {
                [IO.File]::WriteAllText((Join-Path $measurements "$phase-harness-stderr.txt"), $stderr.Result)
            }
            $process.Dispose()
        }
    }
}

$source = Run-Measurement
Save-Json (Join-Path $measurements 'diagnostic-provenance.json') ([ordered]@{
    candidateSource=$candidateSource; candidateSha256=$candidateSha256; candidateRunId=$candidateRun
    referenceRunId=$ReferenceRunId; referenceCommit=$ReferenceCommit; referenceSha256=$receipt.referenceSha256
    referenceReceiptSha256=$ReferenceReceiptSha256; approvalSha256=$ApprovalSha256; fixture=$reference.datasetFingerprint
    diagnosticWorkflowCommit=$overlay.workflowCommit; diagnosticDriverSha256=$overlay.driverSha256
    diagnosticNativeSha256=$overlay.nativeSha256; scope='owned native search paint with detached UIA'
    originalLatencyGateEvaluated=$false; originalStabilityGateEvaluated=$false
    reportSha256=(Get-FileHash -LiteralPath (Join-Path $measurements 'search-paint-detached.json')).Hash.ToLowerInvariant()
    runnerImage=$env:ImageOS; runnerImageVersion=$env:ImageVersion; windowsVersion=[Environment]::OSVersion.Version.ToString()
})
Write-Host 'Owned Windows paint diagnostic collected; this does not score the original latency or stability gates.'
