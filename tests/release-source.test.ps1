param([string]$EvidenceRoot = (Join-Path $PSScriptRoot '../outputs/release-source-tests'))
$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetFullPath($EvidenceRoot)) ([Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
$verifier = Join-Path $PSScriptRoot '../scripts/verify-release-source.ps1'
$utf8 = [Text.UTF8Encoding]::new($false)
function Invoke-FixtureGit {
    $result = & git -C $root @args 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Fixture git failed: $result" }
    $result
}
function Commit-Fixture([string]$Name) {
    Invoke-FixtureGit add --all | Out-Null
    Invoke-FixtureGit -c user.name=Fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false commit -m $Name | Out-Null
    [string](Invoke-FixtureGit rev-parse HEAD)
}
Invoke-FixtureGit init | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $root 'src')) | Out-Null
[IO.File]::WriteAllText((Join-Path $root 'src/main.txt'), 'runtime-v1', $utf8)
[IO.File]::WriteAllText((Join-Path $root 'README.md'), 'guide-v1', $utf8)
$base = Commit-Fixture 'candidate'
[IO.File]::WriteAllText((Join-Path $root 'README.md'), 'guide-v2', $utf8)
$docs = Commit-Fixture 'documentation'
[IO.File]::WriteAllText((Join-Path $root 'src/main.txt'), 'runtime-v2', $utf8)
$runtime = Commit-Fixture 'runtime'
Invoke-FixtureGit switch --detach $docs | Out-Null
# Model an application file renamed to an allowed documentation path.
Invoke-FixtureGit mv src/main.txt CHANGELOG.md | Out-Null
$rename = Commit-Fixture 'rename'
Invoke-FixtureGit switch --detach $base | Out-Null
[IO.File]::WriteAllText((Join-Path $root 'README.md'), 'other-branch', $utf8)
$diverged = Commit-Fixture 'diverged'
$cases = @(
    @{ name='identical'; candidate=$base; release=$base; error=$null },
    @{ name='documentation'; candidate=$base; release=$docs; error=$null },
    @{ name='runtime'; candidate=$base; release=$runtime; error='Application input changed*src/main.txt' },
    @{ name='rename'; candidate=$base; release=$rename; error='Application input changed*src/main.txt' },
    @{ name='behind'; candidate=$docs; release=$base; error='Release source must contain*' },
    @{ name='diverged'; candidate=$docs; release=$diverged; error='Release source must contain*' }
)
$results = foreach ($case in $cases) {
    $message = $null
    try { $null = & $verifier -RepositoryPath $root -CandidateCommit $case.candidate -ReleaseCommit $case.release -AllowedPaths @('README.md','CHANGELOG.md') }
    catch { $message = $_.Exception.Message }
    if (($null -eq $case.error -and $null -ne $message) -or ($null -ne $case.error -and $message -notlike $case.error)) {
        throw "Unexpected result for $($case.name): $message"
    }
    [pscustomobject]@{ name=$case.name; passed=$true; rejection=$message }
}
# Exercise the actual preparation guard without downloading or packaging.
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../scripts/prepare-release.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Release preparation script does not parse' }
$guards = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Extent.Text.Contains("throw 'Candidate build identity differs from the successful workflow attempt'") }, $true))
if ($guards.Count -ne 1) { throw 'Workflow identity guard must be unique' }
$guard = [scriptblock]::Create($guards[0].Extent.Text)
$info = [pscustomobject]@{sourceCommit=$base; workflowRunAttempt='2'}
foreach ($case in @(
    @{name='workflow-matches'; sha=$base; attempt=2; rejected=$false},
    @{name='workflow-other-source'; sha=$docs; attempt=2; rejected=$true},
    @{name='workflow-other-attempt'; sha=$base; attempt=3; rejected=$true}
)) {
    $run = [pscustomobject]@{head_sha=$case.sha; run_attempt=$case.attempt}
    $message = $null
    try { & $guard } catch { $message = $_.Exception.Message }
    if (($case.rejected -and $message -cne 'Candidate build identity differs from the successful workflow attempt') -or (-not $case.rejected -and $null -ne $message)) {
        throw "Unexpected workflow guard result for $($case.name): $message"
    }
    $results += [pscustomobject]@{name=$case.name; passed=$true; rejection=$message}
}
# Evaluate the actual manifest field and serialize it as the preparation script does.
# The helper runs in a child scope; its internal $changed variable is not available here.
$manifests = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -ceq '$manifest' }, $true))
if ($manifests.Count -ne 1) { throw 'Release manifest must be unique' }
$tables = @($manifests[0].Right.FindAll({ param($node) $node -is [Management.Automation.Language.HashtableAst] }, $true))
$fields = @($tables[0].KeyValuePairs | Where-Object { $_.Item1.Value -ceq 'postCandidateFiles' })
if ($fields.Count -ne 1) { throw 'Post-candidate file field must be unique' }
$serialize = [scriptblock]::Create('[ordered]@{postCandidateFiles = ' + $fields[0].Item2.Extent.Text + '} | ConvertTo-Json -Depth 4')
foreach ($paths in @(@(), @('README.md'), @('README.md', 'CHANGELOG.md'))) {
    $sourceComparison = [pscustomobject]@{ changedPaths = [string[]]$paths }
    $json = & {
        Set-StrictMode -Version Latest
        # A stale ambient variable must not affect the authoritative comparison result.
        $changed = @('unrelated-stale-file')
        & $serialize
    }
    $document = [Text.Json.JsonDocument]::Parse($json)
    try {
        $array = $document.RootElement.GetProperty('postCandidateFiles')
        if ($array.ValueKind -ne [Text.Json.JsonValueKind]::Array -or $array.GetArrayLength() -ne $paths.Count) {
            throw "Manifest must retain an array for $($paths.Count) changed paths"
        }
        $index = 0
        foreach ($item in $array.EnumerateArray()) {
            if ($item.GetString() -cne $paths[$index]) { throw 'Manifest lost or replaced a changed path' }
            $index++
        }
    } finally { $document.Dispose() }
    $results += [pscustomobject]@{name="manifest-paths-$($paths.Count)"; passed=$true; rejection=$null}
}
[IO.File]::WriteAllText((Join-Path $root 'results.json'), ($results | ConvertTo-Json -Depth 4), $utf8)
$results | Format-Table -AutoSize
"Evidence: $root"
# Expected rejection cases leave a native nonzero code; all assertions above passed.
exit 0
