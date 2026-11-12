param(
    [Parameter(Mandatory)][string]$CandidateDirectory,
    [Parameter(Mandatory)][string]$PreviousPackageDirectory,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][string]$ReportPath,
    [string]$SevenZip = 'D:\04_7-zip\7z.exe',
    [switch]$Resume,
    [string]$ReviewPayloadReport,
    [ValidateRange(1, 10)][int]$ReviewAttempt = 1
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$managerRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '..\..'))
$utf8 = [Text.UTF8Encoding]::new($false)
function Get-Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Replace-Once([string]$Text, [string]$Old, [string]$New) {
    if ($Text.Split([string[]]@($Old), [StringSplitOptions]::None).Length -ne 2) { throw "Expected one NSIS input: $Old" }
    $Text.Replace($Old, $New)
}
function Repair-KnownInstallerWarnings([string]$Text) {
    $eol = if ($Text.Contains("`r`n")) { "`r`n" } else { "`n" }
    $commentPatterns = @(
        '(?m)^  ; Read the install choice header through \$R5 so a custom language file that only\r?\n  ; defines the misspelled `choowHowToInstall` still shows its own text\r?\n  ; TODO: remove the `choowHowToInstall` fallback in a future major version\r?\n',
        '(?m)^; PageReinstall reads the misspelled `choowHowToInstall` as a fallback, and makensis warns\r?\n; about a language string that is read but never set, so default it to an empty string for\r?\n; every language\. This runs before the language files are included, so a custom language\r?\n; file that only defines the old spelling overrides the default and the fallback shows its\r?\n; text\. `0` as the language id means the language inserted right above\.\r?\n; TODO: remove the `choowHowToInstall` fallback in a future major version\r?\n'
    )
    foreach ($pattern in $commentPatterns) {
        if ([regex]::Matches($Text, $pattern).Count -ne 1) { throw 'Known NSIS fallback comments differ; regenerate the rendered input' }
        $Text = [regex]::Replace($Text, $pattern, '')
    }
    $Text = Replace-Once $Text ('  ${IfThen} $R5 == "" ${|} StrCpy $R5 "$(choowHowToInstall)" ${|}' + $eol) ''
    if ([regex]::Matches($Text, '(?m)^LangString choowHowToInstall 0 ""\r?\n').Count -ne 2) { throw 'Expected both rendered fallback language definitions' }
    $Text = [regex]::Replace($Text, '(?m)^LangString choowHowToInstall 0 ""\r?\n', '')
    if ([regex]::Matches($Text, '(?m)^        Goto install_webview2\r?$').Count -ne 3) { throw 'Expected all three WebView installer branches' }
    $Text = $Text.Replace('        Goto install_webview2', ('        Goto install_webview2' + $eol + '        !define HAS_WEBVIEW2_INSTALLER'))
    $Text = Replace-Once $Text '      install_webview2:' ('      !ifdef HAS_WEBVIEW2_INSTALLER' + $eol + '      install_webview2:')
    Replace-Once $Text '      webview2_done:' ('      !undef HAS_WEBVIEW2_INSTALLER' + $eol + '      !endif' + $eol + '      webview2_done:')
}
$CandidateDirectory = [IO.Path]::GetFullPath($CandidateDirectory)
$PreviousPackageDirectory = [IO.Path]::GetFullPath($PreviousPackageDirectory)
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$ReportPath = [IO.Path]::GetFullPath($ReportPath)
$review = -not [string]::IsNullOrEmpty($ReviewPayloadReport)
if ($review -and $Resume) { throw 'Review and Resume are separate explicit operations' }
$allowedRoot = Join-Path $managerRoot 'validation\manager-data'
if (-not $OutputDirectory.StartsWith($allowedRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Local packaging must use a new isolated validation directory' }
if (Test-Path -LiteralPath $ReportPath) { throw 'Local package evidence already exists; nothing was overwritten' }
if ((Test-Path -LiteralPath $OutputDirectory) -and -not ($Resume -or $review)) { throw 'Local package output already exists; use explicit Resume only for the exact failed packaging inputs' }
if ($Resume -and -not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) { throw 'Resume requires the exact existing packaging directory' }
$info = Get-Content -LiteralPath (Join-Path $CandidateDirectory 'candidate-build-info.json') -Raw | ConvertFrom-Json
$program = Join-Path $CandidateDirectory 'agent-resource-manager.exe'
$manifestPath = Join-Path $CandidateDirectory 'candidate-runtime-source-manifest.json'
if ($info.buildMode -ne 'release' -or (Get-Hash $program) -ne $info.executableSha256 -or (Get-Hash $manifestPath) -ne $info.runtimeSourceManifestSha256) { throw 'Candidate release identity or source manifest differs from its evidence' }
if ((Get-Item -LiteralPath $program).VersionInfo.ProductVersion -ne $info.version) { throw 'Candidate product version differs from build evidence' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$differences = @()
foreach ($row in $manifest) {
    $path = [IO.Path]::GetFullPath((Join-Path $projectRoot $row.path))
    if (-not $path.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Candidate manifest escaped the source directory' }
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Candidate source input is missing: $($row.path)" }
    if ((Get-Hash $path) -ne $row.sha256) {
        if ($row.path -cne 'src-tauri/src/startup_profile.rs') { throw "Runtime input changed after candidate build: $($row.path)" }
        # This whole module is excluded from the release compilation, not a
        # manually stripped subset of production functions.
        $lib = [IO.File]::ReadAllText((Join-Path $projectRoot 'src-tauri/src/lib.rs'))
        if (-not [regex]::IsMatch($lib, '(?m)^#\[cfg\(test\)\]\r?\nmod startup_profile;\s*$')) { throw 'The diagnosis module is no longer wholly cfg(test)' }
        $differences += [ordered]@{ path = $row.path; buildSha256 = $row.sha256; currentSha256 = Get-Hash $path; reason = 'Whole module excluded from release by cfg(test) in unchanged lib.rs' }
    }
}
$template = Join-Path $projectRoot 'src-tauri/installer.nsi'
$priorEvidence = Get-Content -LiteralPath (Join-Path $projectRoot 'outputs/v1-validation/installer-registration-preflight-20261103.json') -Raw | ConvertFrom-Json
$templateHash = Get-Hash $template
# This one reviewed template differs only by removing the obsolete misspelled
# language fallback and compiling the WebView installer label with its callers.
# Any further template change must regenerate the bundler inputs.
$knownReviewedTemplate = '2cad45b719ec6db6b86a4525601682614399da73565d0637a7917b828b0558b4'
if ($templateHash -ne $priorEvidence.installerTemplateSha256 -and $templateHash -ne $knownReviewedTemplate) { throw 'Installer template changed outside the two reviewed fixes; regenerate rendered NSIS inputs through the bundler' }
if ($review -and $templateHash -ne $knownReviewedTemplate) { throw 'Review requires the exact reviewed source template' }
$renderedDirectory = Join-Path $PreviousPackageDirectory 'release\nsis\x64'
$renderedPath = Join-Path $renderedDirectory 'installer.nsi'
$rendered = [IO.File]::ReadAllText($renderedPath)
$notices = Join-Path $projectRoot 'docs/THIRD_PARTY_NOTICES.txt'
$guide = Join-Path $projectRoot 'docs/USER_GUIDE.md'
$nsisRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '..\environment\target\.tauri\NSIS'))
$makensis = Join-Path $nsisRoot 'makensis.exe'
foreach ($inputFile in @($makensis, $SevenZip, $notices, $guide) + @('utils.nsh','FileAssociation.nsh','SimpChinese.nsh','English.nsh' | ForEach-Object { Join-Path $renderedDirectory $_ })) {
    if (-not (Test-Path -LiteralPath $inputFile -PathType Leaf)) { throw "Required existing packaging input is missing: $inputFile" }
}
$nsisWork = Join-Path $OutputDirectory 'nsis-input'
$installerName = if ($review) { "Agent_Resource_Manager_v$($info.version)_windows_x64_setup-reviewed.exe" } else { "Agent_Resource_Manager_v$($info.version)_windows_x64_setup.exe" }
$installer = Join-Path $OutputDirectory $installerName
$oldProgram = Join-Path $PreviousPackageDirectory 'release\agent-resource-manager.exe'
$oldPlugins = Join-Path $PreviousPackageDirectory '.tauri\NSIS\Plugins\x86-unicode\additional'
$plugins = Join-Path $nsisRoot 'Plugins\x86-unicode\additional'
$rendered = Replace-Once $rendered ('!define MAINBINARYSRCPATH "' + $oldProgram + '"') ('!define MAINBINARYSRCPATH "' + $program + '"')
$rendered = Replace-Once $rendered '!define OUTFILE "nsis-output.exe"' ('!define OUTFILE "' + $installer + '"')
$rendered = Replace-Once $rendered ('!define ADDITIONALPLUGINSPATH "' + $oldPlugins + '"') ('!define ADDITIONALPLUGINSPATH "' + $plugins + '"')
foreach ($language in @('SimpChinese.nsh','English.nsh')) {
    $rendered = Replace-Once $rendered ('!include "' + (Join-Path $renderedDirectory $language) + '"') ('!include "' + (Join-Path $nsisWork $language) + '"')
}
$sizeMatch = [regex]::Match($rendered, '(?m)^!define ESTIMATEDSIZE "([0-9]+)"\r?$')
if (-not $sizeMatch.Success) { throw 'Rendered installer lacks its uncompressed size' }
$estimatedKiB = [int64][Math]::Ceiling(((Get-Item -LiteralPath $program).Length + (Get-Item -LiteralPath $notices).Length) / 1024.0)
$rendered = Replace-Once $rendered $sizeMatch.Value ($sizeMatch.Value.Replace($sizeMatch.Groups[1].Value, [string]$estimatedKiB))
if ($templateHash -eq $knownReviewedTemplate) { $rendered = Repair-KnownInstallerWarnings $rendered }
$reviewSuffix = if ($ReviewAttempt -gt 1) { "-$ReviewAttempt" } else { '' }
$localNsi = Join-Path $nsisWork $(if ($review) { "installer-reviewed$reviewSuffix.nsi" } else { 'installer.nsi' })
$sessionPath = Join-Path $OutputDirectory $(if ($review) { "packaging-reviewed-session$reviewSuffix.json" } else { 'packaging-session.json' })
$sessionIdentity = [ordered]@{
    formatVersion = 1; outputDirectory = $OutputDirectory; candidate = $info.executableSha256
    candidateManifest = Get-Hash $manifestPath; installerTemplate = Get-Hash $template
    originalRenderedInput = Get-Hash $renderedPath
    localRenderedInput = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($utf8.GetBytes($rendered))).ToLowerInvariant()
    notices = Get-Hash $notices; guide = Get-Hash $guide
}
$sessionJson = ($sessionIdentity | ConvertTo-Json -Depth 3) + "`n"
$buildLog = Join-Path $OutputDirectory $(if ($review) { "nsis-build-reviewed$reviewSuffix.log" } elseif ($Resume) { 'nsis-build-utf8.log' } else { 'nsis-build.log' })
if ($review) {
    $ReviewPayloadReport = [IO.Path]::GetFullPath($ReviewPayloadReport)
    $priorPayload = Get-Content -LiteralPath $ReviewPayloadReport -Raw | ConvertFrom-Json
    if ($priorPayload.candidate -ne $info.executableSha256 -or [IO.Path]::GetDirectoryName($priorPayload.installer) -cne $OutputDirectory -or (Get-Hash $priorPayload.installer) -ne $priorPayload.installerSha256 -or (Get-Hash $priorPayload.portableZip) -ne $priorPayload.portableZipSha256) { throw 'Review package identity differs from the original verified payload' }
    if ($priorPayload.verification.portableGuideSha256 -ne (Get-Hash $guide) -or $priorPayload.verification.portableNoticesSha256 -ne (Get-Hash $notices)) { throw 'Review cannot reuse a ZIP with changed documentation or notices' }
    if ((Get-Hash (Join-Path $nsisWork 'installer.nsi')) -ne $priorPayload.localRenderedInstallerSha256) { throw 'Original reviewed NSIS input changed after the first package' }
    foreach ($name in @('utils.nsh','FileAssociation.nsh','SimpChinese.nsh','English.nsh')) {
        if ((Get-Hash (Join-Path $nsisWork $name)) -ne (Get-Hash (Join-Path $renderedDirectory $name))) { throw "Review helper differs: $name" }
    }
    if ((Test-Path -LiteralPath $localNsi) -or (Test-Path -LiteralPath $sessionPath)) { throw 'Reviewed NSIS input/evidence already exists; nothing was overwritten' }
    [IO.File]::WriteAllText($localNsi, $rendered, $utf8)
    [IO.File]::WriteAllText($sessionPath, $sessionJson, $utf8)
} elseif ($Resume) {
    # Resume only the compiler-preparation phase. A completed/partial binary or
    # any unrelated entry requires independent review, never silent overwrite.
    $owned = @('nsis-input','nsis-input/installer.nsi','nsis-input/utils.nsh','nsis-input/FileAssociation.nsh','nsis-input/SimpChinese.nsh','nsis-input/English.nsh','nsis-build.log','packaging-session.json')
    foreach ($entry in Get-ChildItem -LiteralPath $OutputDirectory -Force -Recurse) {
        $relative = [IO.Path]::GetRelativePath($OutputDirectory, $entry.FullName).Replace('\','/')
        if ($relative -cnotin $owned -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Resume found an unowned entry: $relative" }
    }
    if ((Get-Hash $localNsi) -ne $sessionIdentity.localRenderedInput) { throw 'Resume rendered input differs from this exact candidate/manifest' }
    foreach ($name in @('utils.nsh','FileAssociation.nsh','SimpChinese.nsh','English.nsh')) {
        if ((Get-Hash (Join-Path $nsisWork $name)) -ne (Get-Hash (Join-Path $renderedDirectory $name))) { throw "Resume helper differs: $name" }
    }
    if (Test-Path -LiteralPath $sessionPath) {
        if ([IO.File]::ReadAllText($sessionPath) -cne $sessionJson) { throw 'Resume session identity differs from the requested inputs' }
    } else {
        # Initial UTF-8 compiler failure predates the session file. Matching all
        # five exact generated inputs above establishes this one owned scope.
        [IO.File]::WriteAllText($sessionPath, $sessionJson, $utf8)
    }
} else {
    [IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
    [IO.Directory]::CreateDirectory($nsisWork) | Out-Null
    foreach ($name in @('utils.nsh','FileAssociation.nsh','SimpChinese.nsh','English.nsh')) { Copy-Item -LiteralPath (Join-Path $renderedDirectory $name) -Destination (Join-Path $nsisWork $name) }
    [IO.File]::WriteAllText($localNsi, $rendered, $utf8)
    [IO.File]::WriteAllText($sessionPath, $sessionJson, $utf8)
}
if ((Test-Path -LiteralPath $buildLog) -or (Test-Path -LiteralPath $installer)) { throw 'Build log or installer already exists; it was not overwritten' }
Push-Location -LiteralPath $nsisWork
try { & $makensis /INPUTCHARSET UTF8 /WX /V2 $localNsi *> $buildLog; if ($LASTEXITCODE -ne 0) { throw 'Existing NSIS compiler failed or reported a warning; see the exact build log' } }
finally { Pop-Location }
$expanded = Join-Path $OutputDirectory $(if ($review) { 'installer-contents-reviewed' } else { 'installer-contents' })
$integrityLog = Join-Path $OutputDirectory $(if ($review) { 'installer-integrity-reviewed.log' } else { 'installer-integrity.log' })
$extractLog = Join-Path $OutputDirectory $(if ($review) { 'installer-extract-reviewed.log' } else { 'installer-extract.log' })
& $SevenZip t $installer *> $integrityLog
if ($LASTEXITCODE -ne 0) { throw 'Installer archive integrity verification failed' }
& $SevenZip x $installer "-o$expanded" -y *> $extractLog
if ($LASTEXITCODE -ne 0) { throw 'Independent installer extraction failed' }
$portable = Join-Path $OutputDirectory 'portable'
$portableApp = Join-Path $portable 'app'
$portableZip = Join-Path $OutputDirectory "Agent_Resource_Manager_v$($info.version)_windows_x64_portable.zip"
if ($review) { $portableZip = $priorPayload.portableZip } else {
    [IO.Directory]::CreateDirectory($portableApp) | Out-Null
    Copy-Item -LiteralPath $program -Destination (Join-Path $portableApp 'agent-resource-manager.exe')
    Copy-Item -LiteralPath $notices -Destination (Join-Path $portableApp 'THIRD_PARTY_NOTICES.txt')
    Copy-Item -LiteralPath $guide -Destination (Join-Path $portable 'USER_GUIDE.md')
    [IO.File]::WriteAllText((Join-Path $portableApp 'data-directory.txt'), ".`n", $utf8)
    [IO.Compression.ZipFile]::CreateFromDirectory($portable, $portableZip, [IO.Compression.CompressionLevel]::Optimal, $false)
}
$verification = & "$PSScriptRoot/verify-release-payload.ps1" -InstallerContents $expanded -PortableZip $portableZip -ExpectedProgram $program -ExpectedNotices $notices -ExpectedGuide $guide
if ((Get-Hash $program) -ne $info.executableSha256) { throw 'Original candidate program changed during packaging' }
$report = [ordered]@{
    checkedAtUtc = [DateTime]::UtcNow.ToString('o'); candidate = $info.executableSha256; candidateSourceIdentity = $info.sourceIdentity
    manifestInputs = @($manifest).Count; manifestSha256 = Get-Hash $manifestPath; testOnlySourceDifferences = $differences
    installerTemplateSha256 = Get-Hash $template; renderedInstallerInputSha256 = Get-Hash $renderedPath; localRenderedInstallerSha256 = Get-Hash $localNsi
    installer = $installer; installerSha256 = Get-Hash $installer; installerBytes = (Get-Item -LiteralPath $installer).Length
    portableZip = $portableZip; portableZipSha256 = Get-Hash $portableZip; portableZipBytes = (Get-Item -LiteralPath $portableZip).Length
    verification = $verification; installerExecuted = $false; published = $false
    resumedCompilerPreparation = [bool]$Resume; packagingSessionSha256 = Get-Hash $sessionPath
    compilerWarningsRejected = $true; originalPayloadReport = $(if ($review) { $ReviewPayloadReport } else { $null })
    originalPayloadReportSha256 = $(if ($review) { Get-Hash $ReviewPayloadReport } else { $null })
    reviewedInstallerChanges = $(if ($templateHash -eq $knownReviewedTemplate) { @('Use the provided chooseHowToInstall language string; remove obsolete misspelled fallback','Compile install_webview2 label only when an installer branch targets it') } else { @() })
    reviewedAttempt = $(if ($review) { $ReviewAttempt } else { $null }); compilerLog = $buildLog
    toolReuse = "Existing NSIS at $nsisRoot; existing 7-Zip at $SevenZip; no bundler/dependency download or EXE rebuild"
}
[IO.File]::WriteAllText($ReportPath, ($report | ConvertTo-Json -Depth 7) + "`n", $utf8)
$report | ConvertTo-Json -Depth 7
