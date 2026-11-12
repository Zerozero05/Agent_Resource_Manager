param(
    [Parameter(Mandatory)][string]$RepositoryPath,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$CandidateCommit,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$ReleaseCommit,
    [Parameter(Mandatory)][string[]]$AllowedPaths
)
$ErrorActionPreference = 'Stop'
# Compare both actual trees, including both sides of a rename. A merge-base
# comparison alone could omit divergent changes.
& git -C $RepositoryPath merge-base --is-ancestor $CandidateCommit $ReleaseCommit
if ($LASTEXITCODE -ne 0) { throw 'Release source must contain the verified candidate commit' }
$changed = @(& git -C $RepositoryPath -c core.quotePath=true diff --no-ext-diff --no-renames --name-only $CandidateCommit $ReleaseCommit --)
if ($LASTEXITCODE -ne 0) { throw 'Cannot compare release and candidate source trees' }
foreach ($path in $changed) {
    if ($path -cnotin $AllowedPaths) { throw "Application input changed after the verified candidate: $path" }
}
[pscustomobject]@{ candidateCommit = $CandidateCommit; releaseCommit = $ReleaseCommit; changedPaths = $changed }
