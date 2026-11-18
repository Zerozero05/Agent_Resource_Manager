param(
    [Parameter(Mandatory)][string]$Candidate,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedSha256
)

$ErrorActionPreference = 'Stop'
if ($env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or
    -not [Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0 -or
    -not (Test-Path -LiteralPath 'D:\' -PathType Container)) { throw 'This test is restricted to a fresh interactive GitHub-hosted Windows VM.' }

$approved = 'D:\03_github_projects\Agent_Management\Agent_Resource_Manager\validation\manager-data'
$evidence = New-Item -ItemType Directory -Path (Join-Path $env:RUNNER_TEMP 'arm-system-motion-evidence')
$receipt = [ordered]@{formatVersion=1; syntheticOnly=$true; status='blocked'; phase='preflight'; candidateSha256=$ExpectedSha256
    samples=@(); normalExit=$false; restorationVerified=$false; restoredUiVerified=$false}
$report = Join-Path $evidence.FullName 'system-motion.json'
function Save-Report { $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $report -Encoding utf8NoBOM }
$launcher = $started = $socket = $initial = $boundWindow = $null
$changed = $false
$port = 65353
Save-Report

try {
    if (Test-Path -LiteralPath $approved) { throw 'Expected a fresh test data root in the isolated VM.' }
    if (Get-Process -Name 'agent-resource-manager','skill-manager' -ErrorAction SilentlyContinue) { throw 'Another manager already exists in this runner.' }
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) { throw 'The dedicated loopback port is already in use.' }
    $Candidate = (Resolve-Path -LiteralPath $Candidate).ProviderPath
    if ([IO.Path]::GetFileName($Candidate) -cne 'agent-resource-manager.exe' -or
        (Get-FileHash -LiteralPath $Candidate -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedSha256) { throw 'Candidate executable identity differs.' }

    $probeText = & pwsh.exe -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot 'native-test-launcher.ps1') -Probe
    if ($LASTEXITCODE -ne 0) { throw 'Medium-token probe failed.' }
    $receipt.probe = $probeText | ConvertFrom-Json
    if ($receipt.probe.type -cne 'probe' -or $receipt.probe.standardTokenAvailable -ne $true -or
        $receipt.probe.sameUser -ne $true -or $receipt.probe.sameSession -ne $true -or
        $receipt.probe.integrityLevel -cne 'medium') { throw 'No verified same-user, same-session medium token. Test stopped before launching the app or writing system preferences.' }

    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;

public static class HostedMotion {
    [DllImport("user32.dll", EntryPoint="SystemParametersInfoW", SetLastError=true)]
    private static extern bool ReadParameter(uint action, uint parameter, out int value, uint flags);
    [DllImport("user32.dll", EntryPoint="SystemParametersInfoW", SetLastError=true)]
    private static extern bool SetParameter(uint action, uint parameter, IntPtr value, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool GetNamedPipeServerProcessId(IntPtr handle, out uint processId);

    public static bool AnimationsEnabled() {
        if (!ReadParameter(0x1042, 0, out int enabled, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return enabled != 0;
    }
    public static void SetAnimationsEnabled(bool enabled) {
        // Send WM_SETTINGCHANGE without SPIF_UPDATEINIFILE.
        if (!SetParameter(0x1043, 0, new IntPtr(enabled ? 1 : 0), 2)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    public static string ReadOwnedStatus(int processId) {
        using var identity = WindowsIdentity.GetCurrent();
        string key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("io.skillmanager.desktop\0" + identity.User.Value))).ToLowerInvariant();
        using var pipe = new NamedPipeClientStream(".", "AgentResourceManager-" + key, PipeDirection.InOut, PipeOptions.Asynchronous);
        pipe.Connect(1500);
        if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out uint owner) || owner != (uint)processId)
            throw new InvalidOperationException("The read-only backend endpoint is not owned by the launched candidate.");
        using var deadline = new CancellationTokenSource(3000);
        byte[] request = Encoding.UTF8.GetBytes("{\"protocol\":1,\"kind\":\"status\"}");
        pipe.WriteAsync(BitConverter.GetBytes(request.Length), 0, 4, deadline.Token).GetAwaiter().GetResult();
        pipe.WriteAsync(request, 0, request.Length, deadline.Token).GetAwaiter().GetResult();
        byte[] header = new byte[4];
        pipe.ReadExactlyAsync(header, deadline.Token).AsTask().GetAwaiter().GetResult();
        int length = BitConverter.ToInt32(header, 0);
        if (length < 2 || length > 65536) throw new InvalidOperationException("Unexpected bounded backend frame.");
        byte[] response = new byte[length];
        pipe.ReadExactlyAsync(response, deadline.Token).AsTask().GetAwaiter().GetResult();
        pipe.WriteAsync(new byte[]{1}, 0, 1, deadline.Token).GetAwaiter().GetResult();
        return Encoding.UTF8.GetString(response);
    }
}
'@

    $receipt.phase = 'fixture'
    $root = New-Item -ItemType Directory -Path (Join-Path $approved ('hosted-motion-' + [Guid]::NewGuid().ToString('N')))
    $fixtureCode = @'
import { realpath, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { createPerformanceFixture } from './scripts/performance-fixture.mjs';
const parent = process.argv[2];
if ((await realpath(parent)).toLowerCase() !== parent.toLowerCase()) throw new Error('The synthetic root is redirected.');
const fixture = await createPerformanceFixture(parent, 'motion', 0);
const db = new DatabaseSync(fixture.dbPath);
try {
    const state = JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id = 1').get().payload);
    state.settings.uiMotion = 'system';
    db.prepare('UPDATE app_state SET payload = ? WHERE id = 1').run(JSON.stringify(state));
    fixture.settings = state.settings;
} finally { db.close(); }
fixture.databaseBytes = (await stat(fixture.dbPath)).size;
fixture.dataFingerprint = createHash('sha256').update(JSON.stringify({
    skillCount: fixture.skillCount, toolCount: fixture.toolCount, template: 'static-skill-v1', settings: fixture.settings,
})).digest('hex');
await writeFile(join(fixture.root, 'dataset.json'), JSON.stringify(fixture, null, 2) + '\n');
console.log(JSON.stringify(fixture));
'@
    $fixtureText = $fixtureCode | & node --input-type=module - $root.FullName
    if ($LASTEXITCODE -ne 0) { throw 'Synthetic system-mode fixture creation failed.' }
    $dataset = $fixtureText | ConvertFrom-Json
    if ($dataset.syntheticOnly -ne $true -or $dataset.settings.uiMotion -cne 'system') { throw 'Expected an unlaunched synthetic system-mode fixture.' }
    $profile = New-Item -ItemType Directory -Path (Join-Path $dataset.dataDir 'webview')
    $temporary = New-Item -ItemType Directory -Path (Join-Path $root.FullName 'temp')
    $receipt.dataset = [ordered]@{dataDir=$dataset.dataDir; skillCount=$dataset.skillCount; toolCount=$dataset.toolCount; preference=$dataset.settings.uiMotion
        descriptorSha256=(Get-FileHash -LiteralPath (Join-Path $dataset.root 'dataset.json') -Algorithm SHA256).Hash.ToLowerInvariant()}

    $receipt.phase = 'launch'
    $start = [Diagnostics.ProcessStartInfo]::new((Get-Command pwsh.exe).Source)
    foreach ($argument in @('-NoProfile','-NonInteractive','-File',(Join-Path $PSScriptRoot 'native-test-launcher.ps1'))) { $start.ArgumentList.Add($argument) }
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $launcher = [Diagnostics.Process]::Start($start)
    $launchSpec = [ordered]@{executable=$Candidate; arguments=@('--data-dir',$dataset.dataDir); environmentOverrides=[ordered]@{
        WEBVIEW2_USER_DATA_FOLDER=$profile.FullName
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$port --remote-debugging-address=127.0.0.1"
        TEMP=$temporary.FullName; TMP=$temporary.FullName
    }}
    $launcher.StandardInput.WriteLine(($launchSpec | ConvertTo-Json -Depth 4 -Compress))
    $launch = $launcher.StandardOutput.ReadLineAsync().WaitAsync([TimeSpan]::FromSeconds(15)).GetAwaiter().GetResult() | ConvertFrom-Json
    if ($launch.type -cne 'started') { throw "No owned candidate was started: $($launch.error)" }
    $started = $launch
    $receipt.launch = $started
    if ($started.integrityLevel -cne 'medium' -or $started.sameUser -ne $true -or $started.sameSession -ne $true -or
        $started.environmentPersisted -ne $false) { throw 'Launcher did not establish the required isolated scope.' }
    Save-Report

    function Get-OwnedWindow([switch]$RequireForeground) {
        $owner = Get-Process -Id $started.pid
        $owner.Refresh()
        $hwnd = $owner.MainWindowHandle
        if ($owner.HasExited -or $owner.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -cne $started.createdFileTime -or
            $owner.MainModule.FileName -ne $Candidate -or $owner.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId -or
            $hwnd -eq [IntPtr]::Zero -or ($null -ne $boundWindow -and $hwnd -ne $boundWindow)) { throw 'Exact owned window is unavailable.' }
        [uint32]$ownerId = 0
        [void][HostedMotion]::GetWindowThreadProcessId($hwnd,[ref]$ownerId)
        if ($ownerId -ne $started.pid -or ($RequireForeground -and [HostedMotion]::GetForegroundWindow() -ne $hwnd)) {
            throw 'The expected candidate window is not the owned foreground.'
        }
        return $hwnd
    }
    function Get-LoopbackOwner {
        $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
        if ($listeners.Count -eq 0) { return }
        if (@($listeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1','::1') }).Count -or
            @($listeners.OwningProcess | Sort-Object -Unique).Count -ne 1) { throw 'Unexpected listener on the dedicated port.' }
        $browser = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$listeners[0].OwningProcess)
        $liveBrowser = Get-Process -Id $listeners[0].OwningProcess
        $created = $liveBrowser.StartTime.ToUniversalTime()
        if ($browser.Name -ine 'msedgewebview2.exe' -or $browser.ParentProcessId -ne $started.pid -or
            $liveBrowser.MainModule.FileName -ne $browser.ExecutablePath -or -not $browser.CreationDate -or
            [Math]::Abs($created.Ticks - $browser.CreationDate.ToUniversalTime().Ticks) -ge 10000 -or
            $created.ToFileTimeUtc() -lt [int64]$started.createdFileTime -or
            $browser.CommandLine -match '(?:^|\s)"?--type=' -or
            $browser.CommandLine -notmatch "(?:^|\s)`"?--remote-debugging-port=$port(?:`"?\s|`"?$)") { throw 'The listener is not the expected owned WebView2 browser.' }
        if ($browser.CommandLine -notmatch '(?:^|\s)"?--user-data-dir=(?:"([^"]+)"|([^"\s]+))') { throw 'No exact owned browser profile was proven.' }
        $actualProfile = [IO.Path]::GetFullPath($(if ($Matches[1]) { $Matches[1] } else { $Matches[2] }))
        if ($actualProfile -notin @($profile.FullName,(Join-Path $profile.FullName 'EBWebView')) -or
            ((Get-Item -LiteralPath $actualProfile).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'The WebView2 browser profile differs from the isolated path.' }
        [pscustomobject]@{pid=$liveBrowser.Id; creationFileTime=$created.ToFileTimeUtc().ToString(); version=$liveBrowser.MainModule.FileVersionInfo.ProductVersion}
    }

    $receipt.phase = 'owned-window-backend-and-loopback'
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    while ($deadline.Elapsed.TotalSeconds -lt 15) {
        $p = Get-Process -Id $started.pid
        if ($p.MainWindowHandle -ne [IntPtr]::Zero) { $boundWindow = Get-OwnedWindow; break }
        Start-Sleep -Milliseconds 120
    }
    if ($null -eq $boundWindow) { throw 'Candidate did not create its own window.' }
    $receipt.windowHandle = $boundWindow.ToInt64()
    $deadline.Restart()
    do {
        $browserOwner = Get-LoopbackOwner
        if ($browserOwner) { break }
        Start-Sleep -Milliseconds 180
    } while ($deadline.Elapsed.TotalSeconds -lt 10)
    if (-not $browserOwner) { throw 'The owned WebView2 loopback endpoint was not established. No Windows setting was changed.' }
    $receipt.browser = $browserOwner
    $pages = @(Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -NoProxy -MaximumRedirection 0 -TimeoutSec 4 |
        ForEach-Object { $_ } | Where-Object { $_.type -ceq 'page' })
    if ($pages.Count -ne 1) { throw 'Require exactly one owned app page.' }
    $page = [Uri]$pages[0].url
    $endpoint = [Uri]$pages[0].webSocketDebuggerUrl
    if ((($page.Scheme -notin @('http','https') -or $page.Host -cne 'tauri.localhost') -and
         ($page.Scheme -cne 'tauri' -or $page.Host -cne 'localhost')) -or
        $endpoint.Scheme -cne 'ws' -or $endpoint.Host -cne '127.0.0.1' -or $endpoint.Port -ne $port -or
        $endpoint.AbsolutePath -cne ('/devtools/page/' + $pages[0].id) -or $endpoint.UserInfo -or $endpoint.Query) { throw 'Unexpected target or socket address.' }
    $receipt.target = [ordered]@{id=$pages[0].id; origin=$page.GetLeftPart([UriPartial]::Authority)}
    $socket = [Net.WebSockets.ClientWebSocket]::new()
    $socket.Options.Proxy = $null
    $connectDeadline = [Threading.CancellationTokenSource]::new(5000)
    try { [void]$socket.ConnectAsync($endpoint,$connectDeadline.Token).GetAwaiter().GetResult() }
    finally { $connectDeadline.Dispose() }

    function Read-Motion {
        [void](Get-OwnedWindow -RequireForeground)
        $current = Get-LoopbackOwner
        if ($current.pid -ne $browserOwner.pid -or $current.creationFileTime -cne $browserOwner.creationFileTime) { throw 'The loopback owner changed.' }
        $expression = @'
(() => {
  const root = document.documentElement;
  const control = document.querySelector('button.nav-item[aria-label="Skills"]');
  const style = control && getComputedStyle(control);
  return { focused: document.hasFocus(), visible: !document.hidden,
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, motion: root.dataset.motion,
    controlPresent: !!control && control.getBoundingClientRect().width > 0,
    token: getComputedStyle(root).getPropertyValue('--motion-duration').trim(),
    property: style?.transitionProperty, duration: style?.transitionDuration };
})()
'@
        $request = [Text.Encoding]::UTF8.GetBytes((@{id=1;method='Runtime.evaluate';params=@{expression=$expression;returnByValue=$true}} | ConvertTo-Json -Depth 5 -Compress))
        $ioDeadline = [Threading.CancellationTokenSource]::new(4000)
        $message = [IO.MemoryStream]::new()
        try {
            [void]$socket.SendAsync([ArraySegment[byte]]::new($request),[Net.WebSockets.WebSocketMessageType]::Text,$true,$ioDeadline.Token).GetAwaiter().GetResult()
            $buffer = [byte[]]::new(4096)
            do {
                $frame = $socket.ReceiveAsync([ArraySegment[byte]]::new($buffer),$ioDeadline.Token).GetAwaiter().GetResult()
                if ($frame.MessageType -ne [Net.WebSockets.WebSocketMessageType]::Text -or $message.Length + $frame.Count -gt 65536) { throw 'Unexpected WebView2 response frame.' }
                $message.Write($buffer,0,$frame.Count)
            } until ($frame.EndOfMessage)
            $answer = [Text.Encoding]::UTF8.GetString($message.ToArray()) | ConvertFrom-Json
            if ($answer.id -ne 1 -or $answer.error -or $answer.result.exceptionDetails -or -not $answer.result.result.value) { throw 'Fixed WebView2 read did not return a value.' }
            return $answer.result.result.value
        } finally { $message.Dispose(); $ioDeadline.Dispose() }
    }

    function Observe-Motion([bool]$Enabled) {
        $expectMotion = if ($enabled) { 'light' } else { 'none' }
        $wait = [Diagnostics.Stopwatch]::StartNew()
        do {
            $observed = Read-Motion
            if (-not $observed.focused -or -not $observed.visible -or -not $observed.controlPresent) { throw 'The app lost the owned visible control during the observation.' }
            if ($observed.reduced -eq (-not $enabled) -and $observed.motion -ceq $expectMotion) { break }
            Start-Sleep -Milliseconds 180
        } while ($wait.Elapsed.TotalSeconds -lt 8)
        $positiveStyle = $observed.token -ceq '150ms' -and $observed.property -match 'background-color' -and $observed.duration -match '(?:^|,\s*)0\.15s(?:,|$)'
        $reducedStyle = $observed.token -ceq '0ms' -and $observed.property -ceq 'none' -and $observed.duration -ceq '0s'
        $observed | Add-Member -NotePropertyName osAnimationsEnabled -NotePropertyValue ([HostedMotion]::AnimationsEnabled())
        $valid = $observed.osAnimationsEnabled -eq $enabled -and $observed.reduced -eq (-not $enabled) -and
            $observed.motion -ceq $expectMotion -and (($enabled -and $positiveStyle) -or (-not $enabled -and $reducedStyle))
        $observed | Add-Member -NotePropertyName matchesExpected -NotePropertyValue $valid
        return $observed
    }
    $receipt.phase = 'system-readback'
    $initial = [HostedMotion]::AnimationsEnabled()
    $receipt.initialEnabled = $initial
    $before = Read-Motion
    $receipt.before = $before
    if (-not $before.focused -or -not $before.visible -or -not $before.controlPresent -or
        $before.reduced -ne (-not $initial) -or $before.motion -cnotin @('light','none')) {
        throw 'The foreground app did not prove an unmodified system-motion baseline. No setting was changed.'
    }
    $ipc = [HostedMotion]::ReadOwnedStatus($started.pid) | ConvertFrom-Json
    if ($ipc.ok -ne $true -or $ipc.value.ready -ne $true -or $ipc.value.basicMode -eq $true -or
        [IO.Path]::GetFullPath($ipc.value.dataDir) -ne $dataset.dataDir) { throw 'Candidate backend did not confirm readiness using the synthetic database.' }
    $receipt.backend = [ordered]@{ownerPid=$started.pid; ready=$true; dataDir=$dataset.dataDir}
    foreach ($enabled in @($true,$false)) {
        $receipt.phase = if ($enabled) { 'system-animations-enabled' } else { 'system-animations-disabled' }
        $changed = $true
        [HostedMotion]::SetAnimationsEnabled($enabled)
        if ([HostedMotion]::AnimationsEnabled() -ne $enabled) { throw 'Windows did not report the requested native animation preference.' }
        $observed = Observe-Motion $enabled
        $receipt.samples += $observed
        Save-Report
        if (-not $observed.matchesExpected) { throw 'The real Windows preference and rendered app motion did not produce the expected paired readbacks.' }
    }
    $receipt.status = 'observed-system-motion'
} catch {
    $receipt.error = $_.Exception.GetBaseException().Message
} finally {
    if ($changed) {
        try {
            if ([HostedMotion]::AnimationsEnabled() -ne $initial) { [HostedMotion]::SetAnimationsEnabled($initial) }
            $receipt.restoredEnabled = [HostedMotion]::AnimationsEnabled()
            $receipt.restorationVerified = $receipt.restoredEnabled -eq $initial
            if ($receipt.restorationVerified -and $receipt.status -ceq 'observed-system-motion') {
                $receipt.restoredMotion = Observe-Motion $initial
                $receipt.restoredUiVerified = $receipt.restoredMotion.matchesExpected
            }
        } catch { $receipt.restoreError = $_.Exception.GetBaseException().Message }
    }
    if ($socket) { $socket.Dispose() }
    if ($started) {
        try {
            function Get-QuitButton([string]$Name) {
                $hwnd = Get-OwnedWindow
                $rootElement = [Windows.Automation.AutomationElement]::FromHandle($hwnd)
                $filter = [Windows.Automation.AndCondition]::new([Windows.Automation.Condition[]]@(
                    [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,$Name),
                    [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Button),
                    [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::IsOffscreenProperty,$false)))
                $matches = $rootElement.FindAll([Windows.Automation.TreeScope]::Descendants,$filter)
                if ($matches.Count -gt 1) { throw 'Expected one exact visible normal-exit control.' }
                if ($matches.Count -eq 1 -and $matches[0].Current.IsEnabled) { return $matches[0] }
            }
            function Invoke-QuitButton($element) {
                [void](Get-OwnedWindow)
                if (-not $element) { throw 'The exact normal-exit control is unavailable.' }
                $element.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
            }
            if ((Get-Process -Id $started.pid -ErrorAction SilentlyContinue)) {
                $quit = Get-QuitButton '完全退出管理器'
                if (-not $quit) {
                    Invoke-QuitButton (Get-QuitButton '工作区快捷键')
                    $quitDeadline = [Diagnostics.Stopwatch]::StartNew()
                    do {
                        $quit = Get-QuitButton '完全退出管理器'
                        if ($quit) { break }
                        Start-Sleep -Milliseconds 100
                    } while ($quitDeadline.Elapsed.TotalSeconds -lt 5)
                }
                Invoke-QuitButton $quit
                $exit = $launcher.StandardOutput.ReadLineAsync().WaitAsync([TimeSpan]::FromSeconds(15)).GetAwaiter().GetResult() | ConvertFrom-Json
                $receipt.normalExit = $exit.type -ceq 'exited' -and $exit.pid -eq $started.pid -and
                    $exit.createdFileTime -ceq $started.createdFileTime -and $exit.exitCode -eq 0
                $receipt.exit = $exit
            }
        } catch { $receipt.exitError = $_.Exception.GetBaseException().Message }
    }
    if ($launcher) {
        $launcher.StandardInput.Close()
        $launcher.Dispose()
    }
    $receipt.finishedAt = [DateTime]::UtcNow.ToString('o')
    if (-not $receipt.normalExit -or -not $receipt.restorationVerified -or -not $receipt.restoredUiVerified) { $receipt.status = 'blocked' }
    Save-Report
}
$receipt | ConvertTo-Json -Depth 8 -Compress
if ($receipt.status -cne 'observed-system-motion') { exit 1 }
