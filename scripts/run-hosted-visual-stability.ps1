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

$measurements = Join-Path $env:RUNNER_TEMP 'arm-visual-stability-result'
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

function Run-Measurement([string]$phase, [int]$maxMinutes) {
    $reportFile = Join-Path $root "$phase-result.json"
    $proofFile = Join-Path $measurements "$phase-normal-quit.json"
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
    foreach ($arg in @($module, $(if ($phase -eq 'pilot') { '--pilot' } else { '--run' }), $localDescriptor)) {
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
            if ($line.Trim() -cne '"phase": "ready-for-owned-normal-quit",') { continue }
            if ($null -ne $quitProof) { throw 'Duplicate normal-quit signal.' }
            $inProgress = Get-Content -Raw -LiteralPath $reportFile | ConvertFrom-Json
            $identity = $inProgress.identity
            if ($inProgress.mode -cne $phase -or $inProgress.candidateSha256 -cne $candidateSha256 -or
                $inProgress.referenceSha256 -cne $receipt.referenceSha256 -or $inProgress.approvalSha256 -cne $ApprovalSha256 -or
                $identity.pid -ne $inProgress.pid -or $identity.pid -le 0 -or $identity.windowHandle -le 0 -or
                $identity.creationFileTime -cnotmatch '^[0-9]+$') { throw 'The native report does not bind an exact normal-quit owner.' }
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
        if ($null -eq $quitProof -or $sourceReport.normalExit -ne $true -or $sourceReport.runtimeAndSourcesPreserved -ne $true -or
            $sourceReport.managementDataPreserved -ne $true -or $sourceReport.candidateSha256 -cne $candidateSha256 -or
            $sourceReport.datasetFingerprint -cne $reference.datasetFingerprint -or $sourceReport.referenceSha256 -cne $receipt.referenceSha256 -or
            $sourceReport.approvalSha256 -cne $ApprovalSha256 -or $sourceReport.measurementsUseAccessibility -ne $false) {
            throw 'The original native report failed its identity, data, or exit checks.'
        }
        if ($process.ExitCode -ne 0) { throw "$phase did not pass the original native verdict." }
        return $sourceReport
    } finally {
        if (Test-Path -LiteralPath $reportFile -PathType Leaf) { Copy-Item -LiteralPath $reportFile -Destination $measurements }
        if ($null -ne $stderr -and $stderr.IsCompletedSuccessfully -and $stderr.Result) {
            [IO.File]::WriteAllText((Join-Path $measurements "$phase-harness-stderr.txt"), $stderr.Result)
        }
        $process.Dispose()
    }
}

$pilot = Run-Measurement 'pilot' 8
if ($pilot.status -cne 'pilot-passed') { throw 'The original pilot did not pass.' }
$pilotSha256 = (Get-FileHash -LiteralPath (Join-Path $root 'pilot-result.json') -Algorithm SHA256).Hash.ToLowerInvariant()
Assert-Digest (Join-Path $measurements 'pilot-result.json') $pilotSha256
Save-Json (Join-Path $measurements 'wrapper-provenance.json') ([ordered]@{ candidateSource=$candidateSource; candidateSha256=$candidateSha256
    referenceRunId=$ReferenceRunId; referenceCommit=$ReferenceCommit; referenceSha256=$receipt.referenceSha256; referenceReceiptSha256=$ReferenceReceiptSha256
    approvalSha256=$ApprovalSha256; pilotSha256=$pilotSha256; runnerImage=$env:ImageOS; runnerImageVersion=$env:ImageVersion
    windowsVersion=[Environment]::OSVersion.Version.ToString(); nodeVersion=(& node --version)
    referenceEnvironment=$receipt.hostEnvironment; fixture=$reference.datasetFingerprint })
$formal = Run-Measurement 'stability' 44
if ($formal.status -cne 'visual-stability-passed' -or $formal.verdict.status -cne 'passed') { throw 'The original convergence gate did not pass.' }
