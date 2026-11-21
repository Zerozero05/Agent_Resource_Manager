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
$candidateSource = '5480977711719efadcb79c322931b7d2066a6f84'
$candidateRun = '44907287993'
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

# Keep the verified module at its original path so the pilot can still check
# the frozen source inventory. Add evidence collection to a separate entry point.
function Replace-One([string]$content, [string]$original, [string]$replacement) {
    $first = $content.IndexOf($original, [StringComparison]::Ordinal)
    if ($first -lt 0 -or $first -ne $content.LastIndexOf($original, [StringComparison]::Ordinal)) {
        throw 'The exact pilot diagnostic patch anchor is absent or ambiguous.'
    }
    return $content.Substring(0, $first) + $replacement + $content.Substring($first + $original.Length)
}
$overlay = Join-Path $workspace 'scripts/hosted-visual-pilot-failure.generated.mjs'
if (Test-Path -LiteralPath $overlay) { throw 'The pilot diagnostic entry point already exists.' }
$diagnostic = Replace-One $text 'async function main() { const selected = options(process.argv.slice(2));' @'
async function main() { const selected = options(process.argv.slice(2));
    assert.equal(selected.mode, '--pilot', 'Only the diagnostic pilot is available.');
'@
$diagnostic = Replace-One $diagnostic '    const save = () => writeFile(reportPath, json(report));' @'
    report.diagnosticPilotOnly = true;
    report.startupStage = 'admission';
    report.diagnosticScriptSha256 = await digest(fileURLToPath(import.meta.url));
    const save = () => writeFile(reportPath, json(report));
'@
$diagnostic = Replace-One $diagnostic '        report.pid = child.pid;' @'
        report.pid = child.pid;
        report.startupStage = 'awaiting-native-backend';
'@
$diagnostic = Replace-One $diagnostic "        assert.ok(identity, 'Owner-checked backend readiness failed.');" @'
        assert.ok(identity, 'Owner-checked backend readiness failed.');
        report.startupStage = 'attaching-visual-observer';
        await save();
'@
$diagnostic = Replace-One $diagnostic '        report.identity = visual.identity;' @'
        report.identity = visual.identity;
        report.startupStage = 'ready-for-pilot-input';
'@
$diagnostic = Replace-One $diagnostic '        report.error = error.message;' @'
        report.error = error.message;
        await save();
'@
$diagnostic = Replace-One $diagnostic '            let consecutive = 0;' @'
            let consecutive = 0;
            let lastGitHubMatch;
            async function captureGitHubMismatch() {
                if (name !== 'github') return;
                const box = [...visual.identity.captureBounds];
                const fileName = 'pilot-github-no-match.png';
                const witness = report.failureWitness = { state: name, box, lastMatch: lastGitHubMatch ?? null };
                const path = join(root, fileName);
                try {
                    const image = await visual.call('save', { path, box }, 2500);
                    assert.equal(image.saved, true);
                    assert.deepEqual(image.box, box);
                    witness.image = { fileName, sha256: await digest(path), pixelSha256: image.pixelSha256 };
                } catch (error) {
                    witness.captureError = error.message;
                }
            }
'@
$diagnostic = Replace-One $diagnostic '                    if (remaining < 1) throw new Error(`Frozen visible state ${name} exceeded its observation deadline.`);' @'
                    if (remaining < 1) {
                        if (name === 'github') {
                            if (performance.now() < deadline) await sleep(1);
                            await captureGitHubMismatch();
                        }
                        throw new Error(`Frozen visible state ${name} exceeded its observation deadline.`);
                    }
'@
$diagnostic = Replace-One $diagnostic "                    if (!(await visual.call('match', roi, remaining)).matched) allMatch = false;" @'
                    const observed = await visual.call('match', roi, remaining);
                    if (name === 'github') lastGitHubMatch = { role: roi.role, box: roi.box, ...observed };
                    if (!observed.matched) allMatch = false;
'@
$diagnostic = Replace-One $diagnostic '            throw new Error(`Frozen visible state ${name} did not match. References were not adapted.`);' @'
            if (name === 'github') await captureGitHubMismatch();
            throw new Error(`Frozen visible state ${name} did not match. References were not adapted.`);
'@
[IO.File]::WriteAllText($overlay, $diagnostic, [Text.UTF8Encoding]::new($false))
& node --check $overlay
if ($LASTEXITCODE -ne 0) { throw 'The guarded diagnostic entry point did not parse.' }

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

function Run-Pilot {
    $phase = 'pilot'
    $maxMinutes = 8
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
    foreach ($arg in @($overlay, '--pilot', $localDescriptor)) {
        $startInfo.ArgumentList.Add($arg)
    }
    foreach ($name in @('GH_TOKEN', 'GITHUB_TOKEN')) { [void]$startInfo.Environment.Remove($name) }
    $process = [Diagnostics.Process]::Start($startInfo)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $stderr = $process.StandardError.ReadToEndAsync()
    try {
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
            $sourceReport.approvalSha256 -cne $ApprovalSha256 -or $sourceReport.measurementsUseAccessibility -ne $false -or
            $sourceReport.diagnosticPilotOnly -ne $true -or $sourceReport.mode -cne 'pilot') {
            throw 'The original native report failed its identity, data, or exit checks.'
        }
        Assert-Digest $overlay $sourceReport.diagnosticScriptSha256
        if ($null -ne $sourceReport.failureWitness.image) {
            $image = $sourceReport.failureWitness.image
            if ($sourceReport.failureWitness.state -cne 'github' -or $sourceReport.status -cne 'failed-or-blocked' -or
                $image.fileName -cne 'pilot-github-no-match.png') { throw 'Unexpected diagnostic witness scope.' }
            $imagePath = Join-Path $root $image.fileName
            Assert-Digest $imagePath $image.sha256
            Copy-Item -LiteralPath $imagePath -Destination $measurements
        }
        if ($process.ExitCode -ne 0) { throw "$phase did not pass the original native verdict." }
        return $sourceReport
    } finally {
        if (Test-Path -LiteralPath $reportFile -PathType Leaf) { Copy-Item -LiteralPath $reportFile -Destination $measurements }
        if ($process.HasExited) {
            $detail = if ($stderr.IsCompletedSuccessfully) {
                ($stderr.Result -replace 'https?://[^\s]+', '[URL]' -replace '[A-Za-z0-9+/_=-]{80,}', '[opaque]' -replace '[\x00-\x08\x0b-\x1f]', '').Trim()
            } else { '' }
            if ($detail.Length -gt 1600) { $detail = $detail.Substring(0, 1600) }
            Save-Json (Join-Path $measurements 'pilot-process.json') ([ordered]@{
                exitCode=$process.ExitCode; stdoutLines=$lineCount; normalQuitReceipt=($null -ne $quitProof); stderr=$detail
            })
        }
        $process.Dispose()
    }
}

$pilot = Run-Pilot
if ($pilot.status -cne 'pilot-passed') { throw 'The original pilot did not pass.' }
