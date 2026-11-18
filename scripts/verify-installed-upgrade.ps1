param(
    [Parameter(Mandatory)][string]$OldSetup,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$OldSetupSha256,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$OldExecutableSha256,
    [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')][string]$OldVersion,
    [Parameter(Mandatory)][string]$CurrentSetup,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$CurrentSetupSha256,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$CurrentExecutableSha256,
    [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')][string]$CurrentVersion,
    [Parameter(Mandatory)][string]$TestRoot,
    [ValidateRange(30, 300)][int]$InstallerTimeoutSeconds = 120,
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false)

function Get-UpgradePathAttributes([string]$Path) {
    try { [IO.File]::GetAttributes($Path) }
    catch [IO.FileNotFoundException] { return $null }
    catch [IO.DirectoryNotFoundException] { return $null }
}

function Assert-UpgradePlainPath([string]$Path) {
    if ($Path -notmatch '^[A-Za-z]:[\\/]' -or $Path -match '[\x00-\x1f"*?]' -or $Path.Substring(2).Contains(':') -or @($Path.Split([char[]]'\/') | Where-Object { $_ -in @('.', '..') }).Count) {
        throw 'Use an explicit local drive path without traversal, wildcards, streams or device prefixes.'
    }
    if (@($Path.Substring(3).Split([char[]]'\/') | Where-Object { $_ -match '[. ]$' }).Count) { throw 'Windows path components must not end in dots or spaces.' }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $drive = [IO.Path]::GetPathRoot($full)
    if ($full.TrimEnd('\') -eq $drive.TrimEnd('\')) { throw 'A drive root is not an isolated test directory or input file.' }
    $cursor = $drive
    foreach ($part in $full.Substring($drive.Length).Split('\')) {
        $cursor = [IO.Path]::Combine($cursor, $part)
        $attributes = Get-UpgradePathAttributes $cursor
        if ($null -ne $attributes -and ($attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Reparse points are not allowed: $cursor" }
    }
    $full
}

function Test-UpgradeWithin([string]$Path, [string]$Root) {
    $Path.Equals($Root, [StringComparison]::OrdinalIgnoreCase) -or $Path.StartsWith($Root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Assert-UpgradeEmptyRoot([string]$Root) {
    $attributes = Get-UpgradePathAttributes $Root
    if ($null -ne $attributes) {
        if (-not ($attributes -band [IO.FileAttributes]::Directory)) { throw 'The test root is an existing file.' }
        if (@([IO.Directory]::EnumerateFileSystemEntries($Root)).Count) { throw 'The test root must be absent or completely empty.' }
    }
    $parent = [IO.Path]::GetDirectoryName($Root)
    if (-not [IO.Directory]::Exists($parent)) { throw 'The test root must have an existing, explicitly selected parent directory.' }
}

function Get-UpgradeHash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

function Assert-UpgradeBinary([string]$Path, [string]$Hash, [string]$Version, [string]$ProductName) {
    $null = Assert-UpgradePlainPath $Path
    if (-not [IO.File]::Exists($Path) -or [IO.Path]::GetExtension($Path) -ine '.exe') { throw "Expected an existing EXE: $Path" }
    if ((Get-UpgradeHash $Path) -cne $Hash.ToLowerInvariant()) { throw "Executable SHA256 differs: $Path" }
    if ([Diagnostics.FileVersionInfo]::GetVersionInfo($Path).ProductVersion -cne $Version) { throw "Executable product version differs: $Path" }
    if ($ProductName -and [Diagnostics.FileVersionInfo]::GetVersionInfo($Path).ProductName -cne $ProductName) { throw "Executable product name differs: $Path" }
}

function Get-UpgradeProcesses {
    $names = @('skill-manager.exe', 'agent-resource-manager.exe', 'Skill Manager.exe', 'Agent Resource Manager.exe', [IO.Path]::GetFileName($OldSetup), [IO.Path]::GetFileName($CurrentSetup))
    @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -in $names } | Select-Object ProcessId, Name)
}

function Assert-UpgradeIdle {
    $active = @(Get-UpgradeProcesses)
    if ($active.Count) { throw "A related manager is running; no process will be closed. PIDs: $($active.ProcessId -join ', ')" }
}

function Get-UpgradeRegistrations {
    $rows = @()
    foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
        foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
            $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
            try {
                $uninstall = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall', $false)
                if ($null -ne $uninstall) {
                    try {
                        foreach ($name in $uninstall.GetSubKeyNames()) {
                            $key = $uninstall.OpenSubKey($name, $false)
                            try {
                                $display = [string]$key.GetValue('DisplayName')
                                if ($name -in @('Skill Manager', 'Agent Resource Manager') -or $display -in @('Skill Manager', 'Agent Resource Manager')) {
                                    $rows += [pscustomobject]@{
                                        kind = 'uninstall'; hive = [string]$hive; view = [string]$view; key = $name
                                        displayName = $display; version = [string]$key.GetValue('DisplayVersion')
                                        location = [string]$key.GetValue('InstallLocation'); mainBinary = [string]$key.GetValue('MainBinaryName')
                                        uninstallCommand = [string]$key.GetValue('UninstallString')
                                    }
                                }
                            } finally { if ($null -ne $key) { $key.Dispose() } }
                        }
                    } finally { $uninstall.Dispose() }
                }
                foreach ($name in @('Skill Manager', 'Agent Resource Manager')) {
                    $key = $base.OpenSubKey("Software\skillmanager\$name", $false)
                    if ($null -ne $key) {
                        try { $rows += [pscustomobject]@{ kind = 'manufacturer'; hive = [string]$hive; view = [string]$view; key = $name; location = [string]$key.GetValue('') } }
                        finally { $key.Dispose() }
                    }
                }
            } finally { $base.Dispose() }
        }
    }
    $rows
}

function Assert-UpgradeRegistration([object[]]$Rows, [string]$Directory, [string]$Version, [string]$Binary, [string]$DisplayName) {
    $installed = @($Rows | Where-Object kind -eq 'uninstall')
    if (-not $installed.Count) { throw 'Expected the installer to create its real uninstall registration.' }
    foreach ($row in $Rows) {
        if ($row.hive -ne 'CurrentUser' -or $row.key -cne 'Skill Manager' -or $row.location.Trim('"', '\') -ine $Directory.TrimEnd('\')) { throw 'Installer registration escaped the exact owned test installation.' }
        if ($row.kind -eq 'uninstall' -and ($row.version -cne $Version -or $row.mainBinary -cne $Binary -or $row.displayName -cne $DisplayName -or $row.uninstallCommand -cne ('"' + (Join-Path $Directory 'uninstall.exe') + '"'))) { throw 'Installed version, executable name or uninstall command differs.' }
    }
}

function Get-UpgradeShortcuts {
    $shell = New-Object -ComObject WScript.Shell
    try {
        foreach ($scope in @(@{ name = 'desktop'; path = [Environment]::GetFolderPath('DesktopDirectory') }, @{ name = 'programs'; path = [Environment]::GetFolderPath('Programs') })) {
            $folder = $scope.path
            if (-not [IO.Directory]::Exists($folder)) { throw 'Current-user desktop and Programs folders must both exist.' }
            $pending = [Collections.Generic.Stack[string]]::new()
            $pending.Push($folder)
            while ($pending.Count) {
                $directory = Assert-UpgradePlainPath $pending.Pop()
                foreach ($child in [IO.Directory]::EnumerateDirectories($directory)) { $pending.Push($child) }
                foreach ($path in [IO.Directory]::EnumerateFiles($directory, '*.lnk')) {
                    $null = Assert-UpgradePlainPath $path
                    $link = $shell.CreateShortcut($path)
                    try {
                        if ([IO.Path]::GetFileNameWithoutExtension($path) -in @('Skill Manager', 'Agent Resource Manager') -or [IO.Path]::GetFileName($link.TargetPath) -in @('skill-manager.exe', 'agent-resource-manager.exe')) {
                            [pscustomobject]@{ scope = $scope.name; path = $path; target = [string]$link.TargetPath; arguments = [string]$link.Arguments; description = [string]$link.Description; hotkey = [string]$link.Hotkey; windowStyle = $link.WindowStyle }
                        }
                    } finally { $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) }
                }
            }
        }
    } finally { $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
}

function Assert-UpgradeShortcuts([object[]]$Before, [object[]]$After, [string]$Target) {
    if (-not @($Before | Where-Object scope -eq 'desktop').Count -or -not @($Before | Where-Object scope -eq 'programs').Count -or $After.Count -ne $Before.Count) { throw 'Expected the existing desktop and Start menu shortcuts to be retained.' }
    foreach ($old in $Before) {
        $matches = @($After | Where-Object path -IEQ $old.path)
        if ($matches.Count -ne 1 -or $matches[0].target -ine $Target) { throw 'An existing shortcut was lost or points outside the verified executable.' }
        foreach ($field in @('arguments', 'description', 'hotkey', 'windowStyle')) {
            if ($matches[0].$field -cne $old.$field) { throw "An existing shortcut property changed: $field" }
        }
    }
}

function Write-UpgradeReport {
    $null = Assert-UpgradePlainPath $reportPath
    [IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 12) + "`n", $utf8)
}

function Wait-UpgradeUninstall([string[]]$ProgramFiles, [int]$TimeoutMilliseconds = 20000) {
    # NSIS can exit its launcher early and delete both executables before
    # the detached uninstaller finishes removing shortcuts and registry keys.
    $elapsed = [Diagnostics.Stopwatch]::StartNew()
    do {
        $filesRemain = @($ProgramFiles | Where-Object { [IO.File]::Exists($_) }).Count -gt 0
        $registrations = @(Get-UpgradeRegistrations)
        $uninstallRegistrationRemains = @($registrations | Where-Object kind -eq 'uninstall').Count -gt 0
        if (-not $filesRemain -and -not $uninstallRegistrationRemains -and -not @(Get-UpgradeShortcuts).Count) {
            return $registrations
        }
        $timeRemaining = $TimeoutMilliseconds - $elapsed.ElapsedMilliseconds
        if ($timeRemaining -le 0) { break }
        Start-Sleep -Milliseconds ([Math]::Min(200, $timeRemaining))
    } while ($true)
    if ($filesRemain) { throw 'Ordinary uninstall left an installed executable or uninstaller in the test target.' }
    if ($uninstallRegistrationRemains) { throw 'Ordinary uninstall did not remove its uninstall registration.' }
    throw 'Ordinary uninstall left a related shortcut.'
}

function Invoke-UpgradeSetup([string]$Label, [string]$Program, [string]$Arguments, [string]$ExpectedHash) {
    Assert-UpgradeIdle
    $null = Assert-UpgradePlainPath $TestRoot
    $null = Assert-UpgradePlainPath (Join-Path $TestRoot 'app')
    $null = Assert-UpgradePlainPath $Program
    if ((Get-UpgradeHash $Program) -cne $ExpectedHash.ToLowerInvariant()) { throw 'Installer bytes changed after validation.' }
    if ($Label -eq 'install-old' -and (@(Get-UpgradeRegistrations).Count -or @(Get-UpgradeShortcuts).Count)) { throw 'Registration or shortcuts changed before the first installation.' }
    $stdout = Assert-UpgradePlainPath (Join-Path $TestRoot "$Label.stdout.log")
    $stderr = Assert-UpgradePlainPath (Join-Path $TestRoot "$Label.stderr.log")
    if ([IO.File]::Exists($stdout) -or [IO.File]::Exists($stderr)) { throw 'Installer log paths already exist; they will not be overwritten.' }
    $step = [ordered]@{ name = $Label; program = $Program; arguments = $Arguments; startedAtUtc = [DateTime]::UtcNow.ToString('o'); status = 'starting' }
    $report.steps += $step
    Write-UpgradeReport
    $temp = Assert-UpgradePlainPath (Join-Path $TestRoot 'temp')
    [IO.Directory]::CreateDirectory($temp) | Out-Null
    # Windows PowerShell 5.1 has no per-child Environment parameter. Change only
    # this verifier process while creating the child, then immediately restore.
    $previousTemp = [Environment]::GetEnvironmentVariable('TEMP', 'Process')
    $previousTmp = [Environment]::GetEnvironmentVariable('TMP', 'Process')
    try {
        [Environment]::SetEnvironmentVariable('TEMP', $temp, 'Process')
        [Environment]::SetEnvironmentVariable('TMP', $temp, 'Process')
        $process = Start-Process -FilePath $Program -ArgumentList $Arguments -WorkingDirectory $TestRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    } finally {
        [Environment]::SetEnvironmentVariable('TEMP', $previousTemp, 'Process')
        [Environment]::SetEnvironmentVariable('TMP', $previousTmp, 'Process')
    }
    try {
        $step.pid = $process.Id
        $step.status = 'running'
        Write-UpgradeReport
        if (-not $process.WaitForExit($InstallerTimeoutSeconds * 1000)) { throw 'Installer timed out; it has been left running, without termination or cleanup.' }
        $step.exitCode = $process.ExitCode
        $step.finishedAtUtc = [DateTime]::UtcNow.ToString('o')
        if ($process.ExitCode -ne 0) { throw "Installer returned exit code $($process.ExitCode)." }
        $step.status = 'exited-zero'
        Write-UpgradeReport
    } catch {
        $step.status = if ($process.HasExited) { 'failed' } else { 'timed-out-process-retained' }
        $step.error = $_.Exception.Message
        throw
    } finally { $process.Dispose() }
}

$report = [ordered]@{
    formatVersion = 1; startedAtUtc = [DateTime]::UtcNow.ToString('o'); status = 'preflight'
    testRoot = $TestRoot; validateOnly = [bool]$ValidateOnly; installerExecuted = $false; guiVerified = $false
    oldSetup = $OldSetup; oldSetupSha256 = $OldSetupSha256; oldExecutableSha256 = $OldExecutableSha256; oldVersion = $OldVersion
    currentSetup = $CurrentSetup; currentSetupSha256 = $CurrentSetupSha256; currentExecutableSha256 = $CurrentExecutableSha256; currentVersion = $CurrentVersion
    expectedSystemWrites = @('Current-user installer registration', 'Current-user desktop and Start menu shortcuts')
    steps = @(); limits = @('Installer execution and installed-file protection only; application startup, database migration, interactive wizard and performance are not verified.', 'No downloads, backups, forced process termination or automatic filesystem/registry cleanup. Ordinary uninstall retains synthetic user data and may retain its manufacturer path record.')
}
$reportPath = $null
$reportOwned = $false
try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or [IntPtr]::Size -ne 8) { throw 'Run this verifier in 64-bit Windows PowerShell 5.1 or later on an isolated Windows x64 environment.' }
    $TestRoot = Assert-UpgradePlainPath $TestRoot
    $OldSetup = Assert-UpgradePlainPath $OldSetup
    $CurrentSetup = Assert-UpgradePlainPath $CurrentSetup
    if ((Test-UpgradeWithin $OldSetup $TestRoot) -or (Test-UpgradeWithin $CurrentSetup $TestRoot) -or $OldSetup -ieq $CurrentSetup) { throw 'Use two distinct installer inputs outside the test root.' }
    if ([Version]::Parse($CurrentVersion.Split('-')[0]) -le [Version]::Parse($OldVersion.Split('-')[0])) { throw 'The current three-part release version must be newer than the old version.' }
    Assert-UpgradeEmptyRoot $TestRoot
    $report.registrationsBefore = @(Get-UpgradeRegistrations)
    if ($report.registrationsBefore.Count) { throw 'Existing old or new installation registration was found; use a genuinely isolated Windows environment.' }
    Assert-UpgradeIdle
    $report.shortcutsBefore = @(Get-UpgradeShortcuts)
    if ($report.shortcutsBefore.Count) { throw 'Existing related shortcuts were found; they will not be replaced.' }
    Assert-UpgradeBinary $OldSetup $OldSetupSha256 $OldVersion 'Skill Manager'
    Assert-UpgradeBinary $CurrentSetup $CurrentSetupSha256 $CurrentVersion 'Agent Resource Manager'
    $report.testRoot = $TestRoot
    $report.oldSetup = $OldSetup
    $report.currentSetup = $CurrentSetup
    $report.plannedArguments = @("/S /D=$(Join-Path $TestRoot 'app')", "/S /UPDATE /D=$(Join-Path $TestRoot 'app')", '/S')
    if ($ValidateOnly) {
        $report.status = 'read-only-preflight-passed-installation-not-run'
        $report | ConvertTo-Json -Depth 12
        return
    }
    # Recheck immediately before claiming an empty scope. The first report is
    # created exclusively; a competing writer cannot silently replace it.
    Assert-UpgradeEmptyRoot $TestRoot
    if (@(Get-UpgradeRegistrations).Count) { throw 'Installation registration changed after preflight.' }
    Assert-UpgradeIdle
    [IO.Directory]::CreateDirectory($TestRoot) | Out-Null
    $reportPath = Join-Path $TestRoot 'installed-upgrade-report.json'
    $stream = [IO.File]::Open($reportPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $stream.Dispose()
    $reportOwned = $true
    Write-UpgradeReport
    $app = Join-Path $TestRoot 'app'
    $oldProgram = Join-Path $app 'skill-manager.exe'
    $currentProgram = Join-Path $app 'agent-resource-manager.exe'
    Invoke-UpgradeSetup 'install-old' $OldSetup "/S /D=$app" $OldSetupSha256
    $report.installerExecuted = $true
    Assert-UpgradeBinary $oldProgram $OldExecutableSha256 $OldVersion
    $report.oldRegistration = @(Get-UpgradeRegistrations)
    Assert-UpgradeRegistration $report.oldRegistration $app $OldVersion 'skill-manager.exe' 'Skill Manager'
    $oldLinks = @(Get-UpgradeShortcuts)
    Assert-UpgradeShortcuts $oldLinks $oldLinks $oldProgram
    $report.oldShortcuts = $oldLinks
    $sentinels = @(
        @{ path = (Join-Path $TestRoot 'manager-data\preferences.json'); content = '{"synthetic":true,"name":"installed-upgrade"}' },
        @{ path = (Join-Path $TestRoot 'external-resource\resource.txt'); content = 'Synthetic external resource must survive manager upgrade and uninstall.' },
        @{ path = (Join-Path $app 'unmanaged-test-file.txt'); content = 'Synthetic unowned file must survive ordinary uninstall.' },
        @{ path = (Join-Path $app 'data-directory.txt'); content = (Join-Path $TestRoot 'manager-data') + "`n" }
    )
    foreach ($file in $sentinels) {
        $null = Assert-UpgradePlainPath $file.path
        if ([IO.File]::Exists($file.path)) { throw 'An installed file collides with a synthetic sentinel.' }
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file.path)) | Out-Null
        [IO.File]::WriteAllText($file.path, $file.content, $utf8)
        $file.sha256 = Get-UpgradeHash $file.path
    }
    $report.sentinels = @($sentinels | ForEach-Object { [pscustomobject]@{ path = $_.path; sha256 = $_.sha256 } })
    Write-UpgradeReport
    Assert-UpgradeRegistration @(Get-UpgradeRegistrations) $app $OldVersion 'skill-manager.exe' 'Skill Manager'
    Invoke-UpgradeSetup 'upgrade-current' $CurrentSetup "/S /UPDATE /D=$app" $CurrentSetupSha256
    Assert-UpgradeBinary $currentProgram $CurrentExecutableSha256 $CurrentVersion
    if ([IO.File]::Exists($oldProgram)) { throw 'The renamed legacy executable was not removed by the current installer.' }
    $report.currentRegistration = @(Get-UpgradeRegistrations)
    Assert-UpgradeRegistration $report.currentRegistration $app $CurrentVersion 'agent-resource-manager.exe' 'Agent Resource Manager'
    $report.currentShortcuts = @(Get-UpgradeShortcuts)
    Assert-UpgradeShortcuts $oldLinks $report.currentShortcuts $currentProgram
    foreach ($file in $sentinels) {
        $null = Assert-UpgradePlainPath $file.path
        if ((Get-UpgradeHash $file.path) -cne $file.sha256) { throw 'A synthetic data or external-resource sentinel changed during upgrade.' }
    }
    $report.upgradeVerified = $true
    Write-UpgradeReport
    Assert-UpgradeRegistration @(Get-UpgradeRegistrations) $app $CurrentVersion 'agent-resource-manager.exe' 'Agent Resource Manager'
    Assert-UpgradeBinary $currentProgram $CurrentExecutableSha256 $CurrentVersion
    $uninstaller = Assert-UpgradePlainPath (Join-Path $app 'uninstall.exe')
    $uninstallerHash = Get-UpgradeHash $uninstaller
    Invoke-UpgradeSetup 'uninstall-current' $uninstaller '/S' $uninstallerHash
    try {
        $report.registrationsAfter = @(Wait-UpgradeUninstall @($currentProgram, $oldProgram, $uninstaller))
    } catch {
        $report.registrationsAfter = @(Get-UpgradeRegistrations)
        throw
    }
    foreach ($row in $report.registrationsAfter) {
        if ($row.kind -ne 'manufacturer' -or $row.hive -ne 'CurrentUser' -or $row.key -cne 'Skill Manager' -or $row.location.Trim('"', '\') -ine $app) { throw 'Uninstall left an unexpected related registration.' }
    }
    foreach ($file in $sentinels) {
        $null = Assert-UpgradePlainPath $file.path
        if ((Get-UpgradeHash $file.path) -cne $file.sha256) { throw 'Ordinary uninstall changed synthetic data or an external resource.' }
    }
    Assert-UpgradeIdle
    $report.status = 'real-silent-install-upgrade-uninstall-passed'
    $report.finishedAtUtc = [DateTime]::UtcNow.ToString('o')
    Write-UpgradeReport
    $report | ConvertTo-Json -Depth 12
} catch {
    $failure = $_
    $report.status = 'failed'
    $report.error = $_.Exception.Message
    $report.failedAtUtc = [DateTime]::UtcNow.ToString('o')
    if ($report.steps.Count) { $report.installerExecuted = @($report.steps | Where-Object { $_.Contains('pid') }).Count -gt 0 }
    if ($reportOwned) {
        try { Write-UpgradeReport }
        catch { $report.reportWriteError = $_.Exception.Message }
    }
    $report | ConvertTo-Json -Depth 12 | Write-Output
    throw $failure
}
