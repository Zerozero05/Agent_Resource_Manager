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
$candidateSource = '3536ca0e5cf7c897b860b5ce32d8b415904b9e45'
$candidateRun = '44866595695'
$candidateArtifact = '14692802883'
$candidateSha256 = 'aa4ddbf7317b1b5b559153841f8a5fb72c3589af7f267b74efae6211f1a87ed7'
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
if ($env:GITHUB_REF_NAME -cne 'codex/hosted-short-history-pair-930ec22-20261121' -or
    (git rev-parse HEAD) -cne $env:GITHUB_SHA -or $LASTEXITCODE -ne 0) {
    throw 'The exact paired diagnostic checkout is required.'
}
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

$measurements = Join-Path $env:RUNNER_TEMP 'arm-retention-result'
New-Item -ItemType Directory -Path $measurements | Out-Null
[IO.Directory]::CreateDirectory($approved) | Out-Null
foreach ($relative in $roiFiles.Keys) { Copy-Item -LiteralPath $roiFiles[$relative] -Destination (Join-Path $root $relative) }

$referenceRoot = $root
$module = Join-Path $workspace 'scripts/verify-native-visual-stability.mjs'
$pristineModule = [IO.File]::ReadAllText($module)
$quitHelper = Join-Path $PSScriptRoot 'quit-owned-history-pair.ps1'
foreach ($source in $descriptor.sources) {
    $name = Split-Path -Leaf $source.path
    if ($name -cnotmatch '^[a-z][a-z0-9-]+\.(mjs|ps1)$' -or $source.path -ine (Join-Path $workspace "scripts/$name")) {
        throw 'A frozen helper is outside the exact hosted checkout.'
    }
    if ($name -cne 'verify-native-visual-stability.mjs') { Assert-Digest $source.path $source.sha256 }
}
function Prepare-Arm($arm) {
    if (Get-Process -Name agent-resource-manager,skill-manager -ErrorAction SilentlyContinue) {
        throw 'An earlier manager still owns the isolated runner.'
    }
    $candidate = Join-Path $env:RUNNER_TEMP "arm-retention-$($arm.name)"
    $exe = Join-Path $candidate 'agent-resource-manager.exe'
    $build = Join-Path $candidate 'BUILD_INFO.json'
    $armValidation = Join-Path $candidate 'BUILD_INFO.native-validation.json'
    Assert-Digest $exe $arm.sha256
    Assert-Digest $build $arm.buildInfoSha256
    $info = Get-Content -Raw -LiteralPath $build | ConvertFrom-Json
    if ($info.sourceCommit -cne $arm.source -or $info.executableSha256 -cne $arm.sha256 -or
        $info.workflowRunId -ne $arm.run -or $info.workflowRunAttempt -ne 1 -or $info.repository -ine $env:GITHUB_REPOSITORY -or
        $info.version -cne '0.3.0-dev.1') {
        throw 'Build provenance does not bind to the independently pinned executable.'
    }
    $info | Add-Member -NotePropertyName buildMode -NotePropertyValue 'release'
    $info | Add-Member -NotePropertyName originalBuildInfoSha256 -NotePropertyValue $arm.buildInfoSha256
    Save-Json $armValidation $info
    $bindings = [ordered]@{ executable=$exe; buildInfo=$armValidation; candidateSha256=$arm.sha256
        buildInfoSha256=(Get-FileHash -LiteralPath $armValidation -Algorithm SHA256).Hash.ToLowerInvariant()
        transportSha256=$arm.sha256; hostedReferenceFrame=$receipt.referenceFrame; hostedFirstSearchReceipt=$receipt.hostedFirstSearchReceipt
        hostedRetentionReference=@{ sha256=$receipt.referenceSha256; candidateSha256=$candidateSha256; root=$referenceRoot } }
    $wrapped = $pristineModule
    foreach ($key in $bindings.Keys) {
        $pattern = "(?m)^const $key = [^\r\n]+;(?=\r?$)"
        if ([regex]::Matches($wrapped, $pattern).Count -ne 1) { throw "Missing exact paired harness constant: $key" }
        $literal = ConvertTo-Json -InputObject $bindings[$key] -Compress
        $wrapped = [regex]::Replace($wrapped, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($match) "const $key = $literal;" })
    }
    [IO.File]::WriteAllText($module, $wrapped, [Text.UTF8Encoding]::new($false))
    $preparedText = & node $module --prepare
    if ($LASTEXITCODE -ne 0) { throw 'Synthetic arm fixture preparation failed.' }
    $prepared = ($preparedText -join [Environment]::NewLine) | ConvertFrom-Json
    $local = Get-Item -LiteralPath $prepared.descriptor
    $armRoot = $local.Directory
    if ($prepared.status -cne 'prepared-no-gui-run' -or $local.Name -cne 'visual-dataset.json' -or
        $armRoot.Name -cnotmatch '^native-visual-[A-Za-z0-9]+$' -or $armRoot.Parent.FullName -ine $approved -or
        $armRoot.FullName -ieq $referenceRoot -or ($armRoot.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'The exact newly generated arm fixture could not be verified.'
    }
    $armDescriptor = Get-Content -LiteralPath $local.FullName -Raw | ConvertFrom-Json
    if ($armDescriptor.candidateSha256 -cne $arm.sha256 -or $armDescriptor.dataset.dataFingerprint -cne $reference.datasetFingerprint) {
        throw 'Arm fixture content differs from the reviewed workload.'
    }
    [IO.Directory]::CreateDirectory((Join-Path $armRoot.FullName 'references')) | Out-Null
    foreach ($relative in $roiFiles.Keys) {
        Copy-Item -LiteralPath $roiFiles[$relative] -Destination (Join-Path $armRoot.FullName $relative)
    }
    Copy-Item -LiteralPath $referencePath -Destination (Join-Path $armRoot.FullName 'visual-references.json')
    Copy-Item -LiteralPath $ApprovalFile -Destination (Join-Path $armRoot.FullName 'visual-approval.json')
    return @{root=$armRoot.FullName; executable=$exe; descriptor=$local.FullName}
}
function Run-Measurement($arm, $prepared) {
    $phase = 'retention-short'
    $maxMinutes = 7
    $root = $prepared.root
    $executable = $prepared.executable
    $candidateSha256 = $arm.sha256
    $reportFile = Join-Path $root "$phase-result.json"
    $proofFile = Join-Path $measurements "$($arm.name)-normal-quit.json"
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
    foreach ($arg in @($module, '--short-retention', $prepared.descriptor)) {
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
            $quitText = & pwsh.exe -NoProfile -NonInteractive -MTA -File $quitHelper -Spec $encoded -Arm $arm.name
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
        if (Test-Path -LiteralPath $reportFile -PathType Leaf) { Copy-Item -LiteralPath $reportFile -Destination (Join-Path $measurements "$($arm.name)-result.json") }
        if ($null -ne $stderr -and $stderr.IsCompletedSuccessfully -and $stderr.Result) {
            [IO.File]::WriteAllText((Join-Path $measurements "$($arm.name)-harness-stderr.txt"), $stderr.Result)
        }
        $process.Dispose()
    }
}

$arms = @(
    @{name='before'; source=$env:BEFORE_SOURCE; run=$env:BEFORE_RUN_ID; sha256=$env:BEFORE_EXE_SHA256; buildInfoSha256=$env:BEFORE_BUILD_INFO_SHA256},
    @{name='after'; source=$env:AFTER_SOURCE; run=$env:AFTER_RUN_ID; sha256=$env:AFTER_EXE_SHA256; buildInfoSha256=$env:AFTER_BUILD_INFO_SHA256}
)
$reports = @{}
$locations = @{}
try {
    foreach ($arm in $arms) {
        if ($arm.source -cnotmatch '^[a-f0-9]{40}$' -or $arm.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
            $arm.buildInfoSha256 -cnotmatch '^[a-f0-9]{64}$' -or $arm.run -cnotmatch '^[0-9]+$') {
            throw "Missing independently verified candidate pins for $($arm.name)."
        }
        $prepared = Prepare-Arm $arm
        $locations[$arm.name] = $prepared.root
        $reports[$arm.name] = Run-Measurement $arm $prepared
    }
} finally {
    [IO.File]::WriteAllText($module, $pristineModule, [Text.UTF8Encoding]::new($false))
}

$before = $reports.before
$after = $reports.after
if ($locations.before -ieq $locations.after -or $arms[0].sha256 -ceq $arms[1].sha256 -or
    ($before.cycles.index -join ',') -cne ($after.cycles.index -join ',') -or
    $before.history.normalizedKeySha256 -cne $after.history.normalizedKeySha256 -or
    $before.history.keysPerJob -ne $after.history.keysPerJob -or
    $before.finishedAt -gt $after.startedAt) {
    throw 'The two completed arms did not reproduce the same independent physical workload and fixture.'
}
function Summarize-Arm($report) {
    if ($report.status -cne 'retention-short-completed' -or $report.normalExit -ne $true -or
        $report.measurementsUseAccessibility -ne $false -or $report.samples.Count -ne 14 -or
        $report.cycles.Count -ne 13 -or $report.checks.Count -ne 12 -or $report.history.jobs -ne 12) {
        throw 'An arm was incomplete or escaped its explicit short scope.'
    }
    $first, $last = $report.samples[0], $report.samples[-1]
    $startKeys = $first.cache.taskRetention.byAction.check_now
    $endKeys = $last.cache.taskRetention.byAction.check_now
    if ($null -eq $report.samples[-1].cache.taskRetention -or $null -eq $endKeys -or $endKeys.activeJobs -ne 0 -or
        [long]$endKeys.recordedJobs - [long]$startKeys.recordedJobs -ne 12 -or
        [long]$endKeys.schedulingKeys - [long]$startKeys.schedulingKeys -ne 12 * $report.history.keysPerJob) {
        throw 'The process-side metrics do not account for all durable measured checks.'
    }
    $roleDeltas = [ordered]@{}
    foreach ($role in 'manager','webview-browser','webview-renderer') {
        $firstRole = @($first.ownedProcesses | Where-Object role -ceq $role)
        $lastRole = @($last.ownedProcesses | Where-Object role -ceq $role)
        if (!$firstRole.Count -or !$lastRole.Count) { throw "Missing process role $role." }
        $roleDeltas[$role] = ($lastRole | Measure-Object -Property privateBytes -Sum).Sum -
            ($firstRole | Measure-Object -Property privateBytes -Sum).Sum
    }
    $growth = [long]$endKeys.keyBufferCapacityBytes + [long]$endKeys.keyVectorCapacityBytes -
        [long]$startKeys.keyBufferCapacityBytes - [long]$startKeys.keyVectorCapacityBytes
    return [ordered]@{
        candidateSha256=$report.candidateSha256; normalExit=$true; logicalCheckKeys=$endKeys.schedulingKeys
        uniqueCheckKeySets=$endKeys.uniqueKeySets; uniqueCheckKeys=$endKeys.uniqueSchedulingKeys
        uniqueCheckKeysGrowth=if ($null -ne $endKeys.uniqueSchedulingKeys) {
            [long]$endKeys.uniqueSchedulingKeys - [long]$startKeys.uniqueSchedulingKeys
        } else { $null }
        keyCapacityGrowthBytes=$growth; processFamilyPrivateStartBytes=$first.privateBytes
        processFamilyPrivateEndBytes=$last.privateBytes; processFamilyPrivateGrowthBytes=[long]$last.privateBytes - [long]$first.privateBytes
        privateGrowthByRole=$roleDeltas; elapsedMs=$last.elapsedMs; checks=$report.history.jobs
    }
}
$beforeStats = Summarize-Arm $before
$afterStats = Summarize-Arm $after
$sharingObserved = $null -eq $beforeStats.uniqueCheckKeys -and $null -ne $afterStats.uniqueCheckKeys -and
    $afterStats.uniqueCheckKeySets -ge 1 -and $afterStats.uniqueCheckKeysGrowth -ge 0 -and
    $afterStats.uniqueCheckKeysGrowth -le $after.history.keysPerJob -and
    $afterStats.keyCapacityGrowthBytes -lt $beforeStats.keyCapacityGrowthBytes
Save-Json (Join-Path $measurements 'comparison.json') ([ordered]@{
    status=if ($sharingObserved) {'paired-short-diagnostic-completed'} else {'key-sharing-unverified'}
    historyRetentionOnly=$true; convergenceGateEvaluated=$false; previousFailureReplaced=$false
    sameHost=[ordered]@{runnerImage=$env:ImageOS; runnerImageVersion=$env:ImageVersion; node=(& node --version); windows=[Environment]::OSVersion.Version.ToString()}
    referenceSha256=$receipt.referenceSha256; referenceSource=$candidateSource; approvalSha256=$ApprovalSha256
    fixtureSha256=$reference.datasetFingerprint; checkKeySha256=$before.history.normalizedKeySha256
    before=[ordered]@{sourceCommit=$arms[0].source; workflowRunId=$arms[0].run; observations=$beforeStats}
    after=[ordered]@{sourceCommit=$arms[1].source; workflowRunId=$arms[1].run; observations=$afterStats}
})
if (!$sharingObserved) { throw 'Durable repeated checks completed, but the target runtime did not prove reduced key retention.' }
