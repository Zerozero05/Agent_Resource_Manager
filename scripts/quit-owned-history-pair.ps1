param([Parameter(Mandatory)][string]$Spec,[Parameter(Mandatory)][ValidateSet('before','after')][string]$Arm)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or
    $env:GITHUB_REPOSITORY -ine 'Zerozero05/Agent_Resource_Manager' -or
    -not [Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {
  throw 'Normal diagnostic exit is available only in the isolated hosted interactive job.'
}
$identity = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Spec)) | ConvertFrom-Json
$expected = Join-Path $env:RUNNER_TEMP "arm-retention-$Arm\agent-resource-manager.exe"
if ($identity.pid -le 0 -or $identity.creationFileTime -cnotmatch '^\d+$' -or $identity.executable -ine $expected -or
    $identity.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
    (Get-FileHash -LiteralPath $expected -Algorithm SHA256).Hash.ToLowerInvariant() -cne $identity.sha256) {
  throw 'Normal diagnostic exit requires the exact verified candidate.'
}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PhysicalMemoryQuit {
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool GetExitCodeProcess(Microsoft.Win32.SafeHandles.SafeProcessHandle process, out uint exitCode);
}
'@
$owned = [Diagnostics.Process]::GetProcessById([int]$identity.pid)
$ownedWindow = [IntPtr]::Zero

function Assert-OwnedWindow {
  $owned.Refresh()
  if ($owned.HasExited -or $owned.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -cne $identity.creationFileTime -or
      $owned.MainModule.FileName -ine $expected -or $owned.MainWindowHandle -ne $ownedWindow -or
      $owned.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId) {
    throw 'The normal exit target identity changed.'
  }
  [uint32]$foundPid = 0
  if ([PhysicalMemoryQuit]::GetWindowThreadProcessId($ownedWindow, [ref]$foundPid) -eq 0 -or $foundPid -ne $owned.Id) {
    throw 'The normal exit target window owner changed.'
  }
}

function Find-OwnedButton([string]$title) {
  Assert-OwnedWindow
  $root = [Windows.Automation.AutomationElement]::FromHandle($ownedWindow)
  $condition = [Windows.Automation.AndCondition]::new([Windows.Automation.Condition[]]@(
    [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $title),
    [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button),
    [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::IsOffscreenProperty, $false)
  ))
  try {
    $found = $root.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
    if ($null -ne $found -and $found.Current.IsEnabled) { return $found }
  } catch [Windows.Automation.ElementNotAvailableException] {
    # The detached UIA provider can replace initial elements. No action was sent.
  }
  return $null
}

function Wait-OwnedButton([string]$title) {
  $clock = [Diagnostics.Stopwatch]::StartNew()
  do {
    $button = Find-OwnedButton $title
    if ($button) { return $button }
    Start-Sleep -Milliseconds 50
  } while ($clock.ElapsedMilliseconds -lt 15000)
  throw "The owned normal exit button is unavailable: $title."
}

function Invoke-OwnedButton($button) {
  Assert-OwnedWindow
  $pattern = $null
  if (-not $button.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
    throw 'The exact normal exit control has no native Invoke pattern.'
  }
  $pattern.Invoke()
}

try {
  $ownedWindow = $owned.MainWindowHandle
  if ($ownedWindow -eq [IntPtr]::Zero -or ($identity.windowHandle -and $ownedWindow.ToInt64() -ne $identity.windowHandle)) {
    throw 'The exact diagnostic window is unavailable for normal exit.'
  }
  Assert-OwnedWindow
  $processHandle = $owned.SafeHandle
  $quit = Find-OwnedButton '完全退出管理器'
  if (-not $quit) {
    $help = Wait-OwnedButton '工作区快捷键'
    Invoke-OwnedButton $help
    $quit = Wait-OwnedButton '完全退出管理器'
  }
  Invoke-OwnedButton $quit
  if (-not $owned.WaitForExit(15000)) { throw 'Normal exit timed out. No forced termination was attempted.' }
  [uint32]$exitStatus = 0
  if (-not [PhysicalMemoryQuit]::GetExitCodeProcess($processHandle, [ref]$exitStatus)) {
    throw 'The kernel did not return the observed process exit code.'
  }
  @{exited=$true; exitCode=[long]$exitStatus; pid=[long]$identity.pid; creationFileTime=[string]$identity.creationFileTime;
    windowHandle=$ownedWindow.ToInt64(); method='post-measurement-owned-normal-quit'; osInputSent=$false} | ConvertTo-Json -Compress
} finally {
  $owned.Dispose()
}
