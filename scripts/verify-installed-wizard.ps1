param(
    [Parameter(Mandatory)][string]$Setup,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$SetupSha256,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExecutableSha256,
    [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')][string]$Version,
    [switch]$VerifyFirstLaunch
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

function Wait-InstalledButton($Manager, [string]$Name) {
    $condition = [Windows.Automation.AndCondition]::new(
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $Name),
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button))
    $watch = [Diagnostics.Stopwatch]::StartNew()
    do {
        $Manager.Refresh()
        if ($Manager.HasExited) { throw "The installed application exited before exposing $Name." }
        $window = $Manager.MainWindowHandle
        if ([ArmWizardControls]::Owned($window, $Manager.Id) -and [ArmWizardControls]::IsWindowVisible($window) -and
            [ArmWizardControls]::Class($window) -ceq 'Tauri Window' -and [ArmWizardControls]::Caption($window) -ceq 'Agent Resource Manager') {
            $rootElement = [Windows.Automation.AutomationElement]::FromHandle($window)
            if ($rootElement.Current.ProcessId -ne $Manager.Id) { throw 'The installed window accessibility root does not belong to the launched application.' }
            $buttons = $rootElement.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)
            if ($buttons.Count -gt 1) { throw "The installed application exposes more than one $Name control." }
            if ($buttons.Count -eq 1 -and $buttons[0].Current.IsEnabled -and -not $buttons[0].Current.IsOffscreen) {
                $pattern = $null
                if (-not $buttons[0].TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { throw "The $Name control has no native Invoke pattern." }
                return $pattern
            }
        }
        Start-Sleep -Milliseconds 150
    } while ($watch.ElapsedMilliseconds -lt 30000)
    throw "The installed application did not expose an enabled $Name control."
}

function Read-InstalledBackend([string]$DataDirectory) {
    $start = [Diagnostics.ProcessStartInfo]::new($installedExe)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WorkingDirectory = $app
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.ArgumentList.Add('--mcp')
    $start.ArgumentList.Add('--data-dir')
    $start.ArgumentList.Add($DataDirectory)
    $bridge = [Diagnostics.Process]::Start($start)
    try {
        $stdout = $bridge.StandardOutput.ReadToEndAsync()
        $stderr = $bridge.StandardError.ReadToEndAsync()
        $bridge.StandardInput.WriteLine('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"arm-hosted-installed-startup","version":"1"}}}')
        $bridge.StandardInput.WriteLine('{"jsonrpc":"2.0","method":"notifications/initialized"}')
        $bridge.StandardInput.WriteLine('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"content_cache_stats","arguments":{}}}')
        $bridge.StandardInput.Close()
        if (-not $bridge.WaitForExit(15000) -or $bridge.ExitCode -ne 0 -or $stderr.GetAwaiter().GetResult()) { throw 'The installed read-only MCP bridge did not complete cleanly.' }
        $replies = @($stdout.GetAwaiter().GetResult() -split '\r?\n' | Where-Object { $_ } | ConvertFrom-Json)
        $service = $replies | Where-Object id -eq 1
        $query = $replies | Where-Object id -eq 2
        if ($replies.Count -ne 2 -or $service.result.serverInfo.version -cne $Version -or
            $null -eq $query.result -or $query.result.isError -ne $false -or $query.result.content.Count -ne 1) {
            throw 'The running installed backend did not accept the scoped read for its expected data directory.'
        }
        $cache = $query.result.content[0].text | ConvertFrom-Json
        if (-not $cache.PSObject.Properties['taskRetention']) { throw 'The installed backend did not return real cache diagnostics.' }
    } finally { $bridge.Dispose() }
}

function Verify-InstalledFirstLaunch {
    foreach ($relative in @('data-directory.txt','storage-paths.json','data','cache','manager.sqlite3','manager.sqlite3-wal','manager.sqlite3-shm','Skill_Manager_Data')) {
        if (Test-Path -LiteralPath (Join-Path $app $relative)) { throw "Fresh installation unexpectedly contains $relative." }
    }
    $start = [Diagnostics.ProcessStartInfo]::new($installedExe)
    $start.UseShellExecute = $false
    $start.WorkingDirectory = $app
    [void]$start.Environment.Remove('SKILL_MANAGER_DATA_DIR')
    $manager = [Diagnostics.Process]::Start($start)
    try {
        $dataDirectory = Join-Path $app 'data'
        $report.applicationStartup = [ordered]@{ pid = $manager.Id; expectedDataDirectory = $dataDirectory; actualNoArguments = $false; normalExit = $false }
        $row = Get-CimInstance Win32_Process -Filter "ProcessId=$($manager.Id)"
        if ($manager.SessionId -ne $report.sessionId -or $row.ExecutablePath -ine $installedExe -or
            $row.CommandLine.Trim() -notin @($installedExe, ('"' + $installedExe + '"'))) {
            throw 'The installed process is not the exact no-argument application launched for this test.'
        }
        $report.applicationStartup.actualNoArguments = $true
        $help = Wait-InstalledButton $manager '工作区快捷键'
        if (@(Get-Process -Name 'agent-resource-manager','skill-manager' -ErrorAction SilentlyContinue |
            Where-Object Id -ne $manager.Id).Count) { throw 'Another manager appeared during startup.' }
        $database = Join-Path $dataDirectory 'manager.sqlite3'
        $webview = Join-Path $app 'cache/webview'
        $storage = Get-Content -LiteralPath (Join-Path $app 'storage-paths.json') -Raw | ConvertFrom-Json
        if ($storage.config.managedRoot -ine $app -or $storage.config.overrides.state -ine $dataDirectory -or
            $storage.config.overrides.webview -ine $webview -or -not (Test-Path -LiteralPath $database -PathType Leaf) -or
            (Test-Path -LiteralPath (Join-Path $app 'manager.sqlite3'))) {
            throw 'First launch did not initialize the expected isolated data and cache layout.'
        }
        Read-InstalledBackend $dataDirectory
        $report.applicationStartup.database = $database
        $report.applicationStartup.configuredWebviewDirectory = $storage.config.overrides.webview
        $report.applicationStartup.backendReadInExpectedDirectory = $true
        $help.Invoke()
        $quit = Wait-InstalledButton $manager '完全退出管理器'
        $quit.Invoke()
        if (-not $manager.WaitForExit(15000) -or $manager.ExitCode -ne 0) { throw 'The installed application did not quit normally.' }
        $report.applicationStartup.normalExit = $true
        $report.applicationStartup.exitCode = $manager.ExitCode
        $report.applicationStartupVerified = $true
    } finally { $manager.Dispose() }
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
    if ($VerifyFirstLaunch) {
        Add-Type -AssemblyName UIAutomationClient
        Add-Type -AssemblyName UIAutomationTypes
        Verify-InstalledFirstLaunch
        $report.status = 'graphical-wizard-and-installed-first-launch-passed'
    }
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
