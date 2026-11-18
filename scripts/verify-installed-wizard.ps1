param(
    [Parameter(Mandatory)][string]$Setup,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$SetupSha256,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExecutableSha256,
    [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')][string]$Version
)

$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or
    -not [Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {
    throw 'A GitHub-hosted Windows VM with an interactive session is required.'
}
$temp = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).ProviderPath
$root = Join-Path $temp 'arm-installed-wizard'
$setupFile = Get-Item -LiteralPath $Setup
if ($setupFile.PSIsContainer -or ($setupFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
    (Get-FileHash -LiteralPath $setupFile.FullName -Algorithm SHA256).Hash -ine $SetupSha256 -or
    $setupFile.VersionInfo.ProductName -cne 'Agent Resource Manager' -or $setupFile.VersionInfo.ProductVersion -cne $Version) {
    throw 'The wizard installer differs from the verified candidate.'
}
foreach ($path in @($temp, $setupFile.DirectoryName)) {
    for ($parent = $path; $parent; $parent = Split-Path -Parent $parent) {
        if ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Wizard paths must be ordinary local paths.' }
    }
}
if (Test-Path -LiteralPath $root) { throw 'The wizard fixture must be fresh.' }

$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Skill Manager'
$expectedDefault = 'D:\03_github_projects\Agent_Management\Agent_Resource_Manager\app'
$app = Join-Path $root 'custom-app'
$installedExe = Join-Path $app 'agent-resource-manager.exe'
$shortcut = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Agent Resource Manager.lnk'
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Agent Resource Manager.lnk'
if (@(Get-Process -Name 'agent-resource-manager','skill-manager' -ErrorAction SilentlyContinue).Count -or
    (Test-Path -LiteralPath $key) -or (Test-Path -LiteralPath $expectedDefault) -or (Test-Path -LiteralPath $shortcut) -or
    (Test-Path -LiteralPath $startMenu)) {
    throw 'A previous application, registration or shortcut exists. Wizard test will not replace it.'
}
[void][IO.Directory]::CreateDirectory($root)
$report = [ordered]@{ format = 'arm-hosted-interactive-installer-v1'; status = 'running'; setupSha256 = $SetupSha256
    executableSha256 = $ExecutableSha256; version = $Version; sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
    pages = @(); customTarget = $app; guiVerified = $false; applicationStartupVerified = $false }
$reportPath = Join-Path $root 'wizard-report.json'

$wizardApi = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class ArmWizardControls {
    private delegate bool EnumChildProc(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr window, EnumChildProc callback, IntPtr parameter);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int max);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", CharSet=CharSet.Unicode)] private static extern IntPtr SendWithBuffer(IntPtr window, uint message, IntPtr w, StringBuilder l, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", CharSet=CharSet.Unicode)] private static extern IntPtr SendWithText(IntPtr window, uint message, IntPtr w, string l, uint flags, uint timeout, out IntPtr result);

    public static bool Owned(IntPtr window, int pid) {
        uint owner;
        return window != IntPtr.Zero && GetWindowThreadProcessId(window, out owner) != 0 && owner == (uint)pid;
    }

    public static IntPtr[] VisibleChildren(IntPtr window, int pid) {
        var children = new List<IntPtr>();
        EnumChildWindows(window, (child, state) => {
            if (Owned(child, pid) && IsWindowVisible(child)) children.Add(child);
            return true;
        }, IntPtr.Zero);
        return children.ToArray();
    }

    public static string Class(IntPtr window) {
        var buffer = new StringBuilder(128);
        GetClassName(window, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    public static string Caption(IntPtr window) {
        var buffer = new StringBuilder(1024);
        IntPtr result;
        if (SendWithBuffer(window, 0x000D, (IntPtr)buffer.Capacity, buffer, 2, 1000, out result) == IntPtr.Zero)
            throw new InvalidOperationException("The selected wizard control did not return its text.");
        return buffer.ToString();
    }

    public static void SetEdit(IntPtr window, string value) {
        IntPtr result;
        if (SendWithText(window, 0x000C, IntPtr.Zero, value, 2, 1000, out result) == IntPtr.Zero || result == IntPtr.Zero)
            throw new InvalidOperationException("The wizard did not accept the chosen directory.");
    }

    public static int CheckState(IntPtr window) {
        return Send(window, 0x00F0, IntPtr.Zero, IntPtr.Zero).ToInt32();
    }

    public static void ClearCheck(IntPtr window) {
        Send(window, 0x00F1, IntPtr.Zero, IntPtr.Zero);
    }

    public static void Advance(IntPtr dialog, IntPtr next) {
        if (!PostMessage(dialog, 0x0111, (IntPtr)GetDlgCtrlID(next), next))
            throw new InvalidOperationException("The wizard did not accept the navigation command.");
    }

    private static IntPtr Send(IntPtr window, uint message, IntPtr w, IntPtr l) {
        IntPtr result;
        if (SendMessageTimeout(window, message, w, l, 2, 3000, out result) == IntPtr.Zero)
            throw new InvalidOperationException("The scoped wizard message did not complete.");
        return result;
    }
}
'@

$process = $null
function Read-WizardPage {
    $process.Refresh()
    if ($process.HasExited) { throw "The wizard exited before verification with code $($process.ExitCode)." }
    $window = $process.MainWindowHandle
    if (-not [ArmWizardControls]::Owned($window, $process.Id) -or -not [ArmWizardControls]::IsWindowVisible($window) -or
        [ArmWizardControls]::Class($window) -cne '#32770' -or [ArmWizardControls]::Caption($window) -notmatch 'Agent Resource Manager') { return }
    $controls = @([ArmWizardControls]::VisibleChildren($window, $process.Id) | ForEach-Object {
        $class = [ArmWizardControls]::Class($_)
        [pscustomobject]@{ handle = $_; id = [ArmWizardControls]::GetDlgCtrlID($_); class = $class
            enabled = [ArmWizardControls]::IsWindowEnabled($_)
            caption = if ($class -in @('Button', 'Static', 'Edit')) { [ArmWizardControls]::Caption($_) } }
    })
    [pscustomobject]@{ window = $window; controls = $controls }
}

function Wait-WizardPage([string]$Name, [scriptblock]$MatchesPage) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    do {
        $page = Read-WizardPage
        if ($page -and (& $MatchesPage $page.controls)) {
            $report.pages += $Name
            return $page
        }
        Start-Sleep -Milliseconds 150
    } while ($watch.ElapsedMilliseconds -lt 25000)
    if ($page) { $report.lastObservedControls = @($page.controls | Select-Object id,class,enabled,caption) }
    throw "The expected wizard page did not appear: $Name."
}

function Advance-Wizard($Page) {
    $buttons = @($Page.controls | Where-Object { $_.class -ceq 'Button' -and $_.id -eq 1 -and $_.enabled })
    if ($buttons.Count -ne 1 -or -not [ArmWizardControls]::Owned($Page.window, $process.Id) -or
        -not [ArmWizardControls]::Owned($buttons[0].handle, $process.Id) -or
        -not [ArmWizardControls]::IsWindowVisible($buttons[0].handle) -or -not [ArmWizardControls]::IsWindowEnabled($buttons[0].handle)) {
        throw 'The selected wizard page no longer has its expected Next/Install/Finish button.'
    }
    [ArmWizardControls]::Advance($Page.window, $buttons[0].handle)
}

try {
    Add-Type -TypeDefinition $wizardApi
    $process = Start-Process -FilePath $setupFile.FullName -WorkingDirectory $root -PassThru
    $report.installerPid = $process.Id
    if ($process.SessionId -ne $report.sessionId) { throw 'The wizard was launched in another session.' }
    $welcome = Wait-WizardPage 'welcome' { param($items) @($items | Where-Object { $_.class -ceq 'Static' -and $_.caption -match 'Welcome to|欢迎使用' }).Count -gt 0 }
    Advance-Wizard $welcome
    $directory = Wait-WizardPage 'directory' { param($items) @($items | Where-Object { $_.class -ceq 'Edit' -and $_.id -eq 1019 }).Count -eq 1 }
    $pathEdit = $directory.controls | Where-Object { $_.class -ceq 'Edit' -and $_.id -eq 1019 }
    $report.defaultDirectory = $pathEdit.caption
    if ($pathEdit.caption -ine $expectedDefault -or -not [ArmWizardControls]::Owned($pathEdit.handle, $process.Id)) { throw 'The fresh wizard displayed a different default directory.' }
    [ArmWizardControls]::SetEdit($pathEdit.handle, $app)
    $report.customDirectoryReadBack = [ArmWizardControls]::Caption($pathEdit.handle)
    if ($report.customDirectoryReadBack -ine $app) { throw 'The chosen directory did not appear in the actual wizard edit control.' }
    Advance-Wizard $directory
    $progress = Wait-WizardPage 'installation-complete' { param($items)
        @($items | Where-Object { $_.id -eq 1004 -and $_.class -ieq 'msctls_progress32' }).Count -eq 1 -and
        @($items | Where-Object { $_.id -eq 1 -and $_.class -ceq 'Button' -and $_.enabled }).Count -eq 1
    }
    if ((Get-FileHash -LiteralPath $installedExe -Algorithm SHA256).Hash -ine $ExecutableSha256) { throw 'The wizard installed different program bytes.' }
    Advance-Wizard $progress
    $finish = Wait-WizardPage 'finish' { param($items)
        @($items | Where-Object { $_.id -eq 1 -and $_.class -ceq 'Button' -and $_.caption -match 'Finish|完成' }).Count -eq 1
    }
    $runBox = @($finish.controls | Where-Object { $_.class -ceq 'Button' -and $_.caption -match 'Run.*Agent Resource Manager|运行.*Agent Resource Manager' })
    if ($runBox.Count -ne 1 -or -not [ArmWizardControls]::Owned($runBox[0].handle, $process.Id)) { throw 'The final launch option could not be verified.' }
    [ArmWizardControls]::ClearCheck($runBox[0].handle)
    if ([ArmWizardControls]::CheckState($runBox[0].handle) -ne 0) { throw 'Unexpected automatic application launch checkbox state.' }
    $report.runOnFinishDisabled = $true
    Advance-Wizard $finish
    if (-not $process.WaitForExit(25000) -or $process.ExitCode -ne 0) { throw 'The graphical installer did not exit successfully.' }
    $report.exitCode = $process.ExitCode
    $registration = Get-ItemProperty -LiteralPath $key
    if ($registration.DisplayName -cne 'Agent Resource Manager' -or $registration.DisplayVersion -cne $Version -or
        $registration.InstallLocation.Trim('"','\') -ine $app -or $registration.MainBinaryName -cne 'agent-resource-manager.exe') {
        throw 'The wizard did not register the chosen directory and exact application.'
    }
    if (-not (Test-Path -LiteralPath $shortcut -PathType Leaf) -or -not (Test-Path -LiteralPath $startMenu -PathType Leaf)) {
        throw 'The wizard did not create its desktop and Start menu shortcuts.'
    }
    $shell = New-Object -ComObject WScript.Shell
    $report.desktopShortcutTarget = $shell.CreateShortcut($shortcut).TargetPath
    $report.startMenuShortcutTarget = $shell.CreateShortcut($startMenu).TargetPath
    if ($report.desktopShortcutTarget -ine $installedExe -or $report.startMenuShortcutTarget -ine $installedExe -or (Test-Path -LiteralPath $expectedDefault) -or
        (Get-FileHash -LiteralPath $installedExe -Algorithm SHA256).Hash -ine $ExecutableSha256) {
        throw 'The desktop shortcut, default location or final executable differs from the wizard choices.'
    }
    $report.guiVerified = $true
    $report.status = 'graphical-wizard-custom-install-passed'
} catch {
    $report.status = 'failed'
    $report.error = $_.Exception.Message
    throw
} finally {
    $report.completedAt = [DateTime]::UtcNow.ToString('o')
    $json = $report | ConvertTo-Json -Depth 7
    [IO.File]::WriteAllText($reportPath, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    $json | Write-Output
    if ($process) { $process.Dispose() }
}
