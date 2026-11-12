$ErrorActionPreference = 'Stop'
$verifier = Join-Path $PSScriptRoot '../scripts/verify-installed-upgrade.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($verifier, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw "Installed-upgrade script does not parse: $($errors.Message -join '; ')" }
# Only load pure helper definitions. The script body, installers, COM, registry
# and process queries are never invoked by these background boundary checks.
$needed = @('Assert-UpgradePlainPath', 'Test-UpgradeWithin', 'Assert-UpgradeEmptyRoot', 'Assert-UpgradeRegistration', 'Assert-UpgradeShortcuts', 'Assert-UpgradeIdle')
foreach ($name in $needed) {
    $definitions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name }, $true))
    if ($definitions.Count -ne 1) { throw "Expected one verifier helper: $name" }
    . ([scriptblock]::Create($definitions[0].Extent.Text))
}
function Get-UpgradePathAttributes([string]$Path) {
    if ($Path -ieq 'D:\linked') { return [IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint }
    if ($Path -ieq 'D:\file-target') { return [IO.FileAttributes]::Normal }
    if ($Path -ieq $PSScriptRoot) { return [IO.FileAttributes]::Directory }
    return $null
}
function Get-UpgradeProcesses { @($fakeProcesses) }
function Assert-Case([string]$Name, [scriptblock]$Action, [string]$ExpectedError) {
    $failure = $null
    try { & $Action | Out-Null } catch { $failure = $_.Exception.Message }
    if (($ExpectedError -and $failure -notlike $ExpectedError) -or (-not $ExpectedError -and $failure)) { throw "Unexpected boundary result for ${Name}: $failure" }
    $script:results += [pscustomobject]@{ name = $Name; passed = $true; rejection = $failure }
}
$results = @()
Assert-Case 'plain-local-path' { if ((Assert-UpgradePlainPath 'D:\isolated\test') -cne 'D:\isolated\test') { throw 'Path changed' } }
foreach ($path in @('relative', 'D:relative', '\\server\share\test', '\\?\D:\test', 'D:\', 'D:\test\..\escape', 'D:\test\file:stream', 'D:\test\*.exe', "D:\test`nother", 'D:\test\.. \escape', 'D:\test.\case')) {
    Assert-Case "reject-path-$path" { Assert-UpgradePlainPath $path } '*'
}
Assert-Case 'reject-reparse-ancestor' { Assert-UpgradePlainPath 'D:\linked\test' } '*Reparse points*'
Assert-Case 'reject-file-root' { Assert-UpgradeEmptyRoot 'D:\file-target' } '*existing file*'
Assert-Case 'reject-nonempty-root-read-only' { Assert-UpgradeEmptyRoot $PSScriptRoot } '*completely empty*'
Assert-Case 'containment-is-directory-bounded' {
    if (-not (Test-UpgradeWithin 'D:\scope\child.exe' 'D:\scope') -or -not (Test-UpgradeWithin 'd:\SCOPE' 'D:\scope') -or (Test-UpgradeWithin 'D:\scope-other\file.exe' 'D:\scope')) { throw 'Containment boundary differs' }
}
$fakeProcesses = @()
Assert-Case 'no-related-process' { Assert-UpgradeIdle }
$fakeProcesses = @([pscustomobject]@{ ProcessId = 123; Name = 'agent-resource-manager.exe' })
Assert-Case 'running-manager-refused-without-termination' { Assert-UpgradeIdle } '*no process will be closed*123*'
$row = [pscustomobject]@{ kind = 'uninstall'; hive = 'CurrentUser'; view = 'Registry64'; key = 'Skill Manager'; displayName = 'Agent Resource Manager'; version = '0.3.0-dev.1'; location = '"D:\test\app"'; mainBinary = 'agent-resource-manager.exe'; uninstallCommand = '"D:\test\app\uninstall.exe"' }
Assert-Case 'owned-current-registration' { Assert-UpgradeRegistration @($row) 'D:\test\app' '0.3.0-dev.1' 'agent-resource-manager.exe' 'Agent Resource Manager' }
Assert-Case 'missing-registration-refused' { Assert-UpgradeRegistration @() 'D:\test\app' '0.3.0-dev.1' 'agent-resource-manager.exe' 'Agent Resource Manager' } '*real uninstall registration*'
foreach ($change in @(
    @{ field = 'hive'; value = 'LocalMachine' },
    @{ field = 'location'; value = 'D:\unrelated' },
    @{ field = 'key'; value = 'Agent Resource Manager' },
    @{ field = 'version'; value = '0.2.11' },
    @{ field = 'mainBinary'; value = 'other.exe' },
    @{ field = 'uninstallCommand'; value = '"D:\unrelated\uninstall.exe" /S' }
)) {
    $changed = $row.PSObject.Copy()
    $changed.($change.field) = $change.value
    Assert-Case "reject-registration-$($change.field)" { Assert-UpgradeRegistration @($changed) 'D:\test\app' '0.3.0-dev.1' 'agent-resource-manager.exe' 'Agent Resource Manager' } '*'
}
$before = @('D:\desktop\Skill Manager.lnk', 'D:\programs\Skill Manager.lnk') | ForEach-Object { [pscustomobject]@{ scope = $(if ($_.Contains('\desktop\')) { 'desktop' } else { 'programs' }); path = $_; target = 'D:\test\app\skill-manager.exe'; arguments = ''; description = 'kept'; hotkey = ''; windowStyle = 1 } }
$after = @($before | ForEach-Object { $copy = $_.PSObject.Copy(); $copy.target = 'D:\test\app\agent-resource-manager.exe'; $copy })
Assert-Case 'legacy-shortcuts-retargeted' { Assert-UpgradeShortcuts $before $after 'D:\test\app\agent-resource-manager.exe' }
Assert-Case 'missing-shortcut-refused' { Assert-UpgradeShortcuts $before @($after[0]) 'D:\test\app\agent-resource-manager.exe' } '*retained*'
$wrong = @($after | ForEach-Object { $_.PSObject.Copy() }); $wrong[0].target = 'D:\unrelated.exe'
Assert-Case 'wrong-shortcut-target-refused' { Assert-UpgradeShortcuts $before $wrong 'D:\test\app\agent-resource-manager.exe' } '*outside the verified executable*'
$wrong = @($after | ForEach-Object { $_.PSObject.Copy() }); $wrong[0].arguments = '--changed'
Assert-Case 'changed-shortcut-arguments-refused' { Assert-UpgradeShortcuts $before $wrong 'D:\test\app\agent-resource-manager.exe' } '*property changed*'
# Run the actual preflight body with read-only queries replaced by synthetic
# observations. The refusal must occur before any COM, setup or filesystem write.
$preflight = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.TryStatementAst] -and $node.Body.Extent.Text.Contains('if ([Environment]::OSVersion.Platform') }, $true))
if ($preflight.Count -ne 1) { throw 'Expected one actual top-level preflight' }
$preflightBody = [scriptblock]::Create($preflight[0].Body.Extent.Text.TrimStart('{').TrimEnd('}'))
Assert-Case 'existing-registration-refuses-before-any-install' {
    function Assert-UpgradeEmptyRoot { }
    function Get-UpgradeRegistrations { [pscustomobject]@{ kind = 'uninstall'; key = 'Skill Manager'; location = 'D:\existing' } }
    function Get-UpgradeShortcuts { throw 'COM must not be queried after registration rejection' }
    function Assert-UpgradeBinary { throw 'Input EXEs must not be queried after registration rejection' }
    $OldSetup = 'D:\inputs\old.exe'; $CurrentSetup = 'D:\inputs\current.exe'; $TestRoot = 'D:\isolated\case'
    $OldVersion = '0.2.11'; $CurrentVersion = '0.3.0-dev.1'; $report = [ordered]@{}
    & $preflightBody
} '*Existing old or new installation registration*'
Assert-Case 'validate-only-returns-before-output-creation' {
    function Assert-UpgradeEmptyRoot { }
    function Get-UpgradeRegistrations { @() }
    function Get-UpgradeProcesses { @() }
    function Get-UpgradeShortcuts { @() }
    function Assert-UpgradeBinary { }
    function Write-UpgradeReport { throw 'ValidateOnly must not write a report' }
    function Invoke-UpgradeSetup { throw 'ValidateOnly must not run an installer' }
    $OldSetup = 'D:\inputs\old.exe'; $CurrentSetup = 'D:\inputs\current.exe'; $TestRoot = 'D:\isolated\case'
    $OldVersion = '0.2.11'; $CurrentVersion = '0.3.0-dev.1'; $report = [ordered]@{}; $ValidateOnly = $true
    $value = & $preflightBody | ConvertFrom-Json
    if ($value.status -cne 'read-only-preflight-passed-installation-not-run') { throw 'ValidateOnly did not return its exact result' }
}
$binding = [scriptblock]::Create($ast.ParamBlock.Extent.Text + "`n 'parameters-bound'")
$valid = @{ OldSetup = 'D:\inputs\old.exe'; OldSetupSha256 = ('a' * 64); OldExecutableSha256 = ('b' * 64); OldVersion = '0.2.11'; CurrentSetup = 'D:\inputs\current.exe'; CurrentSetupSha256 = ('c' * 64); CurrentExecutableSha256 = ('d' * 64); CurrentVersion = '0.3.0-dev.1'; TestRoot = 'D:\isolated\case'; ValidateOnly = $true }
Assert-Case 'explicit-parameter-contract' { & $binding @valid }
$bad = $valid.Clone(); $bad.CurrentExecutableSha256 = 'not-a-sha256'
Assert-Case 'invalid-digest-refused' { & $binding @bad } '*CurrentExecutableSha256*'
$bad = $valid.Clone(); $bad.InstallerTimeoutSeconds = 1
Assert-Case 'unbounded-timeout-refused' { & $binding @bad } '*InstallerTimeoutSeconds*'
[pscustomobject]@{ checks = $results.Count; passed = $true; installerExecuted = $false; registryRead = $false; registryModified = $false; filesystemWritten = $false; cases = $results } | ConvertTo-Json -Depth 5
