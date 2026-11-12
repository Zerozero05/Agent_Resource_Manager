#Requires -Version 7.2
param(
    [string]$Dataset = 'D:\03_github_projects\Agent_Resource_Manager\validation\manager-data\native-entrypoints-0heGph\dataset.json',
    [switch]$Run
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)

$fixedRoot = 'D:\03_github_projects\Agent_Resource_Manager\validation\manager-data\native-entrypoints-0heGph'
if ([IO.Path]::GetFullPath($Dataset) -ine (Join-Path $fixedRoot 'dataset.json')) {
    throw 'Use only the existing isolated native-entrypoints-0heGph dataset.'
}
$report = [ordered]@{
    format = 'agent-resource-manager-native-entrypoint-startup-v1'
    syntheticOnly = $true
    startedAt = [DateTime]::UtcNow.ToString('o')
    dataset = $Dataset
    status = 'preflight'
    actualGuiLaunches = 0
    phases = @()
    protections = @('Exact isolated dataset and executable digests', 'No data-directory argument',
        'Directory environment variable removed from actual child launch', 'D-drive temporary directories',
        'Owned PID, creation time, path and HWND', 'Pipe owner checked before status read',
        'No requested foreground activation, keyboard, clipboard, credentials or forced termination')
    visibleImpact = 'Starting a GUI may display or activate its window. CreateNoWindow hides only a console and does not guarantee zero desktop interference.'
}
$outputPath = $null
$previousTemporary = $env:TEMP
$previousTmp = $env:TMP
$driverTemporary = Join-Path $fixedRoot 'native-temp'
# These changes affect only this dedicated script process, never its parent.
$env:TEMP = $driverTemporary
$env:TMP = $driverTemporary
$report.driverTemporaryDirectory = $driverTemporary

function Save-Report {
    if ($outputPath) {
        [IO.File]::WriteAllText($outputPath, ($report | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
    }
}
function Test-SamePath([string]$Left, [string]$Right) {
    return [IO.Path]::GetFullPath($Left).TrimEnd('\') -ieq [IO.Path]::GetFullPath($Right).TrimEnd('\')
}
function Assert-OrdinaryPath([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        $entry = Get-Item -LiteralPath $current -Force
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'An entrypoint input or ancestor became a reparse path.' }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
}
function Invoke-EntryInspection([string]$ExpectedDatasetHash) {
    Assert-OrdinaryPath $Dataset
    # Keep the existing reparse/single-link checks ahead of reading dataset
    # bytes, then bind the returned bytes to a second complete inspection.
    $inspectionSource = @'
import { open, lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [modulePath, root, expected] = process.argv.slice(2);
const { inspectEntrypoints } = await import(pathToFileURL(modulePath));
await inspectEntrypoints(root);
const path = join(root, 'dataset.json'), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const input = await open(path, 'r');
try {
  const stat = await input.stat(), named = await lstat(path);
  if (!stat.isFile() || stat.nlink !== 1 || !named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || stat.size > 65536) throw new Error('Dataset is not a bounded ordinary single-link file.');
  const bytes = await input.readFile(), sha256 = hash(bytes);
  if (expected && expected !== sha256) throw new Error('The dataset changed after initial inspection.');
  const inspection = await inspectEntrypoints(root);
  if (hash(await readFile(path)) !== sha256) throw new Error('The dataset changed during input inspection.');
  console.log(JSON.stringify({ inspection, sha256, datasetBase64: bytes.toString('base64') }));
} finally { await input.close(); }
'@
    $node = (Get-Command node.exe -CommandType Application).Source
    $start = [Diagnostics.ProcessStartInfo]::new($node)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.Environment['TEMP'] = Join-Path $fixedRoot 'native-temp'
    $start.Environment['TMP'] = Join-Path $fixedRoot 'native-temp'
    foreach ($argument in @('--input-type=module', '-e', $inspectionSource, 'entrypoint-inspection-wrapper', (Join-Path $PSScriptRoot 'verify-native-entrypoints.mjs'), $fixedRoot, $ExpectedDatasetHash)) { $start.ArgumentList.Add($argument) }
    $inspector = [Diagnostics.Process]::Start($start)
    try {
        $output = $inspector.StandardOutput.ReadToEndAsync()
        $errors = $inspector.StandardError.ReadToEndAsync()
        if (-not $inspector.WaitForExit(15000)) { throw 'The read-only entrypoint inspection timed out. No manager was started.' }
        if ($inspector.ExitCode -ne 0) { throw "Entrypoint inspection refused the fixture: $($errors.GetAwaiter().GetResult())" }
        $result = $output.GetAwaiter().GetResult() | ConvertFrom-Json
        if ($result.inspection.status -ne 'entrypoint-files-inspected-native-run-pending') { throw 'Unexpected entrypoint inspection result.' }
        return [pscustomobject]@{ inspection = $result.inspection; bytes = [Convert]::FromBase64String($result.datasetBase64); sha256 = $result.sha256 }
    } finally { $inspector.Dispose() }
}
function Get-Managers {
    return @(Get-CimInstance Win32_Process -Filter "Name='agent-resource-manager.exe' OR Name='skill-manager.exe'")
}
function Assert-NoManager {
    if ((Get-Managers).Count) { throw 'Another manager exists. No process was closed or reused.' }
}
function Assert-Owned($Process, $Identity, [string]$Executable) {
    $Process.Refresh()
    if ($Process.HasExited -or $Process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne $Identity.creationFileTime) {
        throw 'The exact owned process no longer exists.'
    }
    if (-not (Test-SamePath ([EntrypointNativeRead]::ImagePath($Process.Handle)) $Executable)) { throw 'The owned executable path changed.' }
    if ($Identity.windowHandle) {
        [uint32]$owner = 0
        [void][EntrypointNativeRead]::GetWindowThreadProcessId([IntPtr]$Identity.windowHandle, [ref]$owner)
        if ($owner -ne $Process.Id) { throw 'The recorded native window no longer belongs to this owned process.' }
    }
}
function Wait-Until([scriptblock]$Condition, [string]$Message, [int]$Seconds = 30) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while ($watch.Elapsed.TotalSeconds -lt $Seconds) {
        if (& $Condition) { return }
        Start-Sleep -Milliseconds 100
    }
    throw $Message
}
function Find-OwnedButton($Process, $Identity, [string]$Executable, [string]$Name) {
    Assert-Owned $Process $Identity $Executable
    $root = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]$Identity.windowHandle)
    $condition = [Windows.Automation.AndCondition]::new(
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $Name),
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button))
    $found = $root.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)
    if ($found.Count -gt 1) { throw "The owned button is ambiguous: $Name" }
    if ($found.Count -eq 1 -and $found[0].Current.IsEnabled) { return $found[0] }
    return $null
}
function Invoke-Owned($Process, $Identity, [string]$Executable, $Button) {
    Assert-Owned $Process $Identity $Executable
    $pattern = $null
    if (-not $Button.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        $details = [ordered]@{
            targetName = $Button.Current.Name
            controlType = $Button.Current.ControlType.ProgrammaticName
            supportedPatterns = @($Button.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName })
        }
        throw ('The exact owned control has no Invoke pattern. ' + ($details | ConvertTo-Json -Compress))
    }
    $pattern.Invoke()
}
function Expand-OwnedOutline($Process, $Identity, [string]$Executable, $Button) {
    Assert-Owned $Process $Identity $Executable
    if ($Button.Current.Name -ne '目录' -or $Button.Current.ControlType -ne [Windows.Automation.ControlType]::Button -or -not $Button.Current.IsEnabled) {
        throw 'Only the exact enabled directory disclosure may use native expansion.'
    }
    $pattern = $null
    if (-not $Button.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) {
        Invoke-Owned $Process $Identity $Executable $Button
        return [ordered]@{ targetName = '目录'; method = 'native-owned-outline-invoke' }
    }
    $before = $pattern.Current.ExpandCollapseState
    if ($before -eq [Windows.Automation.ExpandCollapseState]::Collapsed) {
        Assert-Owned $Process $Identity $Executable
        $pattern.Expand()
    } elseif ($before -ne [Windows.Automation.ExpandCollapseState]::Expanded) {
        throw ("The owned directory disclosure is not in a stable expansion state. targetName=目录; controlType=$($Button.Current.ControlType.ProgrammaticName); expansionState=$before; supportedPatterns=" + (($Button.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName }) -join ','))
    }
    Wait-Until {
        $current = Find-OwnedButton $Process $Identity $Executable '目录'
        if (-not $current) { return $false }
        $expansion = $null
        return $current.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$expansion) -and $expansion.Current.ExpandCollapseState -eq [Windows.Automation.ExpandCollapseState]::Expanded
    } 'The exact owned directory disclosure did not become expanded.' 10
    return [ordered]@{ targetName = '目录'; method = 'native-owned-outline-expand'; stateBefore = $before.ToString(); stateAfter = 'Expanded' }
}
function Stop-Normally($Process, $Identity, [string]$Executable, [string]$QuitName) {
    if ($Process.HasExited) { return [ordered]@{ exited = $true; exitCode = $Process.ExitCode; method = 'already-exited' } }
    $script:quitButton = $null
    $script:quitHelp = $null
    Wait-Until {
        $script:quitButton = Find-OwnedButton $Process $Identity $Executable $QuitName
        if ($script:quitButton) { return $true }
        $script:quitHelp = Find-OwnedButton $Process $Identity $Executable '工作区快捷键'
        return $null -ne $script:quitHelp
    } 'Normal Quit controls did not become available within thirty seconds.' 30
    $quit = $script:quitButton
    if (-not $quit) {
        Invoke-Owned $Process $Identity $Executable $script:quitHelp
        Wait-Until { $script:quitButton = Find-OwnedButton $Process $Identity $Executable $QuitName; $null -ne $script:quitButton } 'Normal Quit did not become available.' 10
        $quit = $script:quitButton
    }
    Invoke-Owned $Process $Identity $Executable $quit
    if (-not $Process.WaitForExit(15000)) { throw 'Normal Quit did not exit within fifteen seconds. No forced termination was attempted.' }
    return [ordered]@{ exited = $true; exitCode = $Process.ExitCode; method = 'native-owned-quit-invoke'; quitName = $QuitName }
}
function Read-LegacyStructureDiagnostic($Process, $Identity, [string]$Executable, [string]$Expected) {
    Assert-Owned $Process $Identity $Executable
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $sourcePrefix = '当前来源：启动路径文件'
    $allowedNames = @('管理数据', '新下载 Skill', '导出 ZIP', '界面缓存', '更新恢复材料', '上传恢复记录', '临时工作目录', '保存位置', '目录', '打开')
    function Test-ExpectedPathName([string]$Name) {
        try { return $Name -and [IO.Path]::IsPathFullyQualified($Name) -and (Test-SamePath $Name $Expected) }
        catch { return $false }
    }
    function Describe-LegacyElement($Element) {
        if (-not $Element) { return $null }
        Assert-Owned $Process $Identity $Executable
        $name = [string]$Element.Current.Name
        $safe = [ordered]@{
            controlType = $Element.Current.ControlType.ProgrammaticName
            offscreen = $Element.Current.IsOffscreen
            nameLength = $name.Length
            nameSha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($name))).ToLowerInvariant()
        }
        if ($name -in $allowedNames) { $safe.name = $name }
        elseif (Test-ExpectedPathName $name) { $safe.name = $Expected; $safe.expectedPathMatched = $true }
        elseif ($name.StartsWith($sourcePrefix, [StringComparison]::Ordinal)) { $safe.name = $sourcePrefix; $safe.expectedSourcePrefixMatched = $true }
        return $safe
    }
    $result = [ordered]@{
        status = 'bounded-owned-uia-structure-only'
        pid = $Identity.pid
        creationFileTime = $Identity.creationFileTime
        windowHandle = $Identity.windowHandle
        expectedTestPath = $Expected
        expectedSourcePrefix = $sourcePrefix
        maximumScannedElements = 800
        maximumAnchors = 4
        maximumAncestorLevelsPerView = 3
        softReadBudgetMs = 5000
        pageTextDumped = $false
        successCriterionChanged = $false
        matchingCounts = [ordered]@{ managementTitle = 0; expectedPathName = 0; expectedSourcePrefix = 0 }
        anchors = @()
        flatNeighbors = @()
    }
    try {
        $root = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]$Identity.windowHandle)
        $elements = $root.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
        $result.availableElementCount = $elements.Count
        $anchors = [Collections.Generic.List[object]]::new()
        $scanned = 0
        for ($index = 0; $index -lt [Math]::Min($elements.Count, 800); $index++) {
            if ($timer.ElapsedMilliseconds -gt 5000) { break }
            Assert-Owned $Process $Identity $Executable
            $name = [string]$elements[$index].Current.Name
            $kind = if ($name -eq '管理数据') { 'managementTitle' } elseif (Test-ExpectedPathName $name) { 'expectedPathName' } elseif ($name.StartsWith($sourcePrefix, [StringComparison]::Ordinal)) { 'expectedSourcePrefix' } else { $null }
            if ($kind) {
                $result.matchingCounts[$kind]++
                $sameKind = @($anchors | Where-Object { $_.kind -eq $kind }).Count
                if ($anchors.Count -lt 4 -and $sameKind -lt $(if ($kind -eq 'managementTitle') { 2 } else { 1 })) { $anchors.Add([pscustomobject]@{ index = $index; kind = $kind; element = $elements[$index] }) }
            }
            $scanned++
        }
        $result.scannedElementCount = $scanned
        $result.scanComplete = $scanned -eq $elements.Count
        $neighborIndices = [Collections.Generic.HashSet[int]]::new()
        foreach ($anchor in $anchors) {
            $entry = [ordered]@{ kind = $anchor.kind; flatIndex = $anchor.index; element = Describe-LegacyElement $anchor.element; ancestry = @() }
            foreach ($view in @('ControlViewWalker', 'RawViewWalker')) {
                $walker = if ($view -eq 'ControlViewWalker') { [Windows.Automation.TreeWalker]::ControlViewWalker } else { [Windows.Automation.TreeWalker]::RawViewWalker }
                $current = $anchor.element
                for ($depth = 0; $current -and $depth -lt 3; $depth++) {
                    if ($timer.ElapsedMilliseconds -gt 5000) { break }
                    Assert-Owned $Process $Identity $Executable
                    $entry.ancestry += [ordered]@{
                        view = $view; level = $depth
                        element = Describe-LegacyElement $current
                        previousSibling = Describe-LegacyElement ($walker.GetPreviousSibling($current))
                        nextSibling = Describe-LegacyElement ($walker.GetNextSibling($current))
                    }
                    $current = $walker.GetParent($current)
                }
            }
            $result.anchors += $entry
            foreach ($near in ([Math]::Max(0, $anchor.index - 2))..([Math]::Min($elements.Count - 1, $anchor.index + 2))) { [void]$neighborIndices.Add($near) }
        }
        foreach ($index in ($neighborIndices | Sort-Object | Select-Object -First 20)) {
            if ($timer.ElapsedMilliseconds -gt 5000) { break }
            $result.flatNeighbors += [ordered]@{ index = $index; element = Describe-LegacyElement $elements[$index] }
        }
        Assert-Owned $Process $Identity $Executable
    } catch { $result.status = 'partial-owned-uia-diagnostic'; $result.errorType = $_.Exception.GetBaseException().GetType().Name }
    $result.elapsedMs = $timer.ElapsedMilliseconds
    $result.softReadBudgetReached = $timer.ElapsedMilliseconds -gt 5000
    return $result
}
function Get-LegacyStorageRowEvidence([object[]]$Entries, [string]$Expected, [string]$NextTitle) {
    if ($NextTitle -ne '新下载 Skill' -or $Entries.Count -lt 5 -or $Entries.Count -gt 32) { return $null }
    if ($Entries[0].name -ne '管理数据' -or $Entries[0].controlType -ne 'ControlType.Text' -or $Entries[0].offscreen) { return $null }
    $paths = @()
    $openIndices = @()
    $sources = @()
    $sourceLabelCount = 0
    for ($index = 1; $index -lt $Entries.Count; $index++) {
        $entry = $Entries[$index]
        if ($entry.name -in @('管理数据', '新下载 Skill', '导出 ZIP', '界面缓存', '更新恢复材料', '上传恢复记录', '临时工作目录')) { return $null }
        $value = $null
        if ($entry.controlType -eq 'ControlType.Text') { $value = $entry.name }
        elseif ($entry.controlType -eq 'ControlType.Edit' -and $entry.readOnly) { $value = $entry.value }
        if ($value -and [IO.Path]::IsPathFullyQualified($value)) {
            if ($entry.offscreen) { return $null }
            $paths += [pscustomobject]@{ index = $index; value = $value }
        }
        if ($entry.controlType -eq 'ControlType.Button' -and $entry.name -eq '打开') {
            if ($entry.offscreen -or -not $entry.enabled) { return $null }
            $openIndices += $index
        }
        if ($entry.controlType -ne 'ControlType.Text' -or $entry.offscreen) { continue }
        if ($entry.name.StartsWith('当前来源：', [StringComparison]::Ordinal)) { $sourceLabelCount++ }
        if ($entry.name -in @('当前来源：启动路径文件', '当前来源：启动路径文件 · 已锁定')) {
            $sources += [pscustomobject]@{ index = $index; representation = 'combined-text' }
        } elseif ($entry.name -eq '当前来源：' -and $index + 1 -lt $Entries.Count) {
            $next = $Entries[$index + 1]
            if ($next.controlType -eq 'ControlType.Text' -and -not $next.offscreen -and $next.name -in @('启动路径文件', '启动路径文件 · 已锁定')) {
                $sources += [pscustomobject]@{ index = $index; representation = 'adjacent-text-parts' }
            }
        }
    }
    if ($paths.Count -ne 1 -or $openIndices.Count -ne 1 -or $sources.Count -ne 1 -or $sourceLabelCount -ne 1) { return $null }
    if (-not (Test-SamePath $paths[0].value $Expected) -or $openIndices[0] -le $paths[0].index -or $sources[0].index -le $openIndices[0]) { return $null }
    return [ordered]@{
        actualDataDirectory = $paths[0].value
        sourceLabel = '当前来源：启动路径文件'
        sourceRepresentation = $sources[0].representation
        rowEntryCount = $Entries.Count
        nextRowLabel = $NextTitle
    }
}
function Read-LegacyDirectory($Process, $Identity, [string]$Executable, [string]$Expected) {
    $script:settingsButton = $null
    Wait-Until { $script:settingsButton = Find-OwnedButton $Process $Identity $Executable '设置'; $null -ne $script:settingsButton } 'Legacy Settings is unavailable without foreground input.'
    Invoke-Owned $Process $Identity $Executable $script:settingsButton
    $script:storageButton = $null
    $script:legacyOutlineOpened = $false
    $script:legacyOutlineAction = $null
    Wait-Until {
        $script:storageButton = Find-OwnedButton $Process $Identity $Executable '保存位置'
        if ($script:storageButton) { return $true }
        $outline = Find-OwnedButton $Process $Identity $Executable '目录'
        if ($outline -and -not $script:legacyOutlineOpened) {
            $script:legacyOutlineAction = Expand-OwnedOutline $Process $Identity $Executable $outline
            $script:legacyOutlineOpened = $true
        }
        return $false
    } 'Legacy Settings did not expose its storage-location navigation.'
    Invoke-Owned $Process $Identity $Executable $script:storageButton
    $script:observedLegacyRow = $null
    Wait-Until {
        Assert-Owned $Process $Identity $Executable
        $root = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]$Identity.windowHandle)
        $labels = $root.FindAll([Windows.Automation.TreeScope]::Descendants,
            [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, '管理数据'))
        if ($labels.Count -gt 1) { throw 'Legacy Settings exposes multiple management-data row labels.' }
        if ($labels.Count -ne 1 -or $labels[0].Current.IsOffscreen) { return $false }
        # The real v0.2.11 accessibility tree flattens storage rows into this
        # content group. Bound the first row by its next JSX storage heading.
        $group = [Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($labels[0])
        if (-not $group -or $group.Current.ControlType -ne [Windows.Automation.ControlType]::Group) { return $false }
        $contents = $group.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
        $start = -1
        for ($index = 0; $index -lt $contents.Count; $index++) {
            if ([Windows.Automation.Automation]::Compare($contents[$index], $labels[0])) { $start = $index; break }
        }
        if ($start -lt 0) { return $false }
        $entries = @()
        $nextTitle = $null
        for ($index = $start; $index -lt [Math]::Min($contents.Count, $start + 33); $index++) {
            Assert-Owned $Process $Identity $Executable
            $element = $contents[$index]
            $current = $element.Current
            if ($index -gt $start -and $current.ControlType -eq [Windows.Automation.ControlType]::Text -and $current.Name -in @('管理数据', '新下载 Skill', '导出 ZIP', '界面缓存', '更新恢复材料', '上传恢复记录', '临时工作目录')) {
                $nextTitle = $current.Name
                break
            }
            if ($current.ControlType -notin @([Windows.Automation.ControlType]::Text, [Windows.Automation.ControlType]::Button, [Windows.Automation.ControlType]::Edit)) { continue }
            $entry = [pscustomobject]@{ name = $current.Name; controlType = $current.ControlType.ProgrammaticName; offscreen = $current.IsOffscreen; enabled = $current.IsEnabled; readOnly = $false; value = $null }
            if ($current.ControlType -eq [Windows.Automation.ControlType]::Edit) {
                $pattern = $null
                if ($element.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern) -and $pattern.Current.IsReadOnly) { $entry.readOnly = $true; $entry.value = $pattern.Current.Value }
            }
            if ($entry.name -or $entry.value) { $entries += $entry }
        }
        $script:observedLegacyRow = Get-LegacyStorageRowEvidence $entries $Expected $nextTitle
        return $null -ne $script:observedLegacyRow
    } 'Legacy Settings did not expose the actual expected data directory. No foreground fallback was attempted.'
    return [ordered]@{ method = 'native-owned-storage-management-data-row'; rowLabel = '管理数据'; actualDataDirectory = $script:observedLegacyRow.actualDataDirectory; sourceLabel = $script:observedLegacyRow.sourceLabel; sourceRepresentation = $script:observedLegacyRow.sourceRepresentation; rowEntryCount = $script:observedLegacyRow.rowEntryCount; nextRowLabel = $script:observedLegacyRow.nextRowLabel; outlineAction = $script:legacyOutlineAction; matched = $true }
}

try {
    # Reuse the existing file/reparse/hash/schema guards before reading the dataset.
    $initial = Invoke-EntryInspection ''
    $report.inspection = $initial.inspection
    $datasetValue = [Text.Encoding]::UTF8.GetString($initial.bytes) | ConvertFrom-Json
    $report.datasetSha256 = $initial.sha256
    if (-not $Run) {
        $report.status = 'preflight-passed-native-not-run'
        $report.finishedAt = [DateTime]::UtcNow.ToString('o')
        $report | ConvertTo-Json -Depth 12
        exit 0
    }
    Assert-NoManager
    $outputPath = Join-Path $fixedRoot ("entrypoint-startup-{0}.json" -f [Guid]::NewGuid().ToString('N'))
    $createdReport = [IO.File]::Open($outputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $createdReport.Dispose()
    $report.status = 'running'
    Save-Report
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
using System.Text.Json;
using System.Threading;
public static class EntrypointNativeRead {
  delegate bool WindowCallback(IntPtr window,IntPtr state);
  public sealed class WindowInfo { public long Handle;public string Title;public string ClassName; }
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll",SetLastError=true)] static extern bool EnumWindows(WindowCallback callback,IntPtr state);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window,StringBuilder text,int maximum);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,StringBuilder text,int maximum);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder path,ref uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeServerProcessId(IntPtr pipe,out uint pid);
  public static string ImagePath(IntPtr process) {
    var path=new StringBuilder(32768);uint size=(uint)path.Capacity;
    if(!QueryFullProcessImageName(process,0,path,ref size))throw new Win32Exception(Marshal.GetLastWin32Error(),"Cannot query the owned executable image.");
    if(size==0||!Path.IsPathFullyQualified(path.ToString()))throw new InvalidOperationException("The owned process has no absolute executable image path.");
    return path.ToString();
  }
  public static WindowInfo VisibleWindow(int expectedPid,string expectedTitle) {
    if(expectedPid<=0||(expectedTitle!="Skill Manager"&&expectedTitle!="Agent Resource Manager"))throw new ArgumentException("A fixed owned manager window is required.");
    WindowInfo found=null;int count=0;
    if(!EnumWindows((window,state)=>{
      uint owner;GetWindowThreadProcessId(window,out owner);
      if(owner!=(uint)expectedPid||!IsWindowVisible(window))return true;
      var title=new StringBuilder(512);var name=new StringBuilder(512);
      if(GetWindowText(window,title,title.Capacity)==0||GetClassName(window,name,name.Capacity)==0)return true;
      if(title.ToString()==expectedTitle&&name.ToString()=="Tauri Window"){
        count++;found=new WindowInfo{Handle=window.ToInt64(),Title=title.ToString(),ClassName=name.ToString()};
      }
      return true;
    },IntPtr.Zero))throw new Win32Exception(Marshal.GetLastWin32Error(),"Cannot enumerate the owned manager window.");
    if(count>1)throw new InvalidOperationException("Multiple exact visible manager windows appeared.");
    return found;
  }
  public static string Status(int expectedPid) {
    string sid=WindowsIdentity.GetCurrent().User.Value;
    string key=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("io.skillmanager.desktop\0"+sid))).ToLowerInvariant();
    using(var pipe=new NamedPipeClientStream(".","AgentResourceManager-"+key,PipeDirection.InOut,PipeOptions.Asynchronous)) {
      pipe.Connect(2000); uint owner;
      if(!GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out owner)||owner!=(uint)expectedPid)
        throw new InvalidOperationException("The backend pipe is not owned by this exact isolated process.");
      using(var stop=new CancellationTokenSource(5000)) {
        byte[] request=Encoding.UTF8.GetBytes("{\"protocol\":1,\"kind\":\"status\"}");
        pipe.WriteAsync(BitConverter.GetBytes(request.Length),stop.Token).AsTask().GetAwaiter().GetResult();
        pipe.WriteAsync(request,stop.Token).AsTask().GetAwaiter().GetResult();
        byte[] length=new byte[4];pipe.ReadExactlyAsync(length,stop.Token).AsTask().GetAwaiter().GetResult();
        int count=BitConverter.ToInt32(length,0);if(count<2||count>8*1024*1024)throw new InvalidOperationException("Invalid bounded backend frame.");
        byte[] response=new byte[count];pipe.ReadExactlyAsync(response,stop.Token).AsTask().GetAwaiter().GetResult();
        pipe.WriteAsync(new byte[]{1},stop.Token).AsTask().GetAwaiter().GetResult();
        using(var document=JsonDocument.Parse(response)) {
          if(!document.RootElement.GetProperty("ok").GetBoolean())throw new InvalidOperationException("The backend status request failed.");
          return document.RootElement.GetProperty("value").GetRawText();
        }
      }
    }
  }
}
'@
    foreach ($phase in $datasetValue.phases) {
        Assert-NoManager
        $item = [ordered]@{ name = $phase.name; executable = $phase.executable; expectedDataDirectory = $phase.dataDirectory; startedAt = [DateTime]::UtcNow.ToString('o'); status = 'starting'; childEnvironmentVariableRemoved = $false }
        $report.phases += $item
        Save-Report
        $owned = $null
        $identity = $null
        $launcher = $null
        $inputHandles = [Collections.Generic.List[IDisposable]]::new()
        try {
            # Pin the exact inspected entry files against writes and replacement
            # throughout startup, observation and normal exit. No data DB is pinned.
            foreach ($path in @($Dataset, $datasetValue.legacy.executable, $datasetValue.candidate.executable,
                (Join-Path (Split-Path -Parent $datasetValue.legacy.executable) 'data-directory.txt'),
                (Join-Path (Split-Path -Parent $datasetValue.candidate.executable) 'data-directory.txt'),
                (Join-Path (Split-Path -Parent $datasetValue.candidate.executable) 'storage-paths.json'),
                $datasetValue.phases[2].launcher)) {
                Assert-OrdinaryPath $path
                $inputHandles.Add([IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read))
            }
            $phaseInspection = Invoke-EntryInspection $report.datasetSha256
            $item.inputInspectionMatched = $phaseInspection.sha256 -eq $report.datasetSha256
            if ((Get-FileHash -LiteralPath $phase.executable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $phase.sha256) { throw 'The prepared executable changed before launch.' }
            $start = [Diagnostics.ProcessStartInfo]::new()
            $start.UseShellExecute = $false
            $start.CreateNoWindow = $true
            $start.WorkingDirectory = Split-Path -Parent $phase.executable
            $start.Environment['SKILL_MANAGER_DATA_DIR'] = $datasetValue.sentinel
            $item.conflictingChildSentinelInserted = $start.Environment['SKILL_MANAGER_DATA_DIR'] -eq $datasetValue.sentinel
            foreach ($name in @($start.Environment.Keys)) {
                if ($name -ieq 'SKILL_MANAGER_DATA_DIR') { [void]$start.Environment.Remove($name) }
            }
            if (@($start.Environment.Keys | Where-Object { $_ -ieq 'SKILL_MANAGER_DATA_DIR' }).Count) { throw 'The application child still has a data-directory environment override.' }
            $start.Environment['TEMP'] = $datasetValue.temporary
            $start.Environment['TMP'] = $datasetValue.temporary
            $item.childEnvironmentVariableRemoved = $true
            $item.temporaryDirectory = $datasetValue.temporary
            if ($phase.name -eq 'legacy-launcher-forwarding') {
                if ($phase.launcher -match '[%!&|<>\r\n"]') { throw 'The fixed CMD launcher path contains shell metacharacters.' }
                $start.FileName = Join-Path ([Environment]::GetFolderPath('System')) 'cmd.exe'
                $start.Arguments = '/d /s /c ""' + $phase.launcher + '""'
                $start.WorkingDirectory = Split-Path -Parent $phase.launcher
                $launcher = [Diagnostics.Process]::Start($start)
                $launcherCreated = $launcher.StartTime.ToUniversalTime()
                $item.launcher = [ordered]@{ pid = $launcher.Id; creationTime = $launcherCreated.ToString('o'); path = $phase.launcher }
                Wait-Until {
                    $rows = Get-Managers
                    if ($rows.Count -gt 1) { throw 'Multiple manager processes appeared during the isolated launcher test.' }
                    if (-not $rows.Count) { return $false }
                    $row = $rows[0]
                    if (-not $row.ExecutablePath -or -not (Test-SamePath $row.ExecutablePath $phase.executable) -or $row.ParentProcessId -ne $launcher.Id) { throw 'The launcher did not create the unique expected manager child.' }
                    $script:forwardedPid = [int]$row.ProcessId
                    return $true
                } 'The old launcher did not create the expected new executable.'
                $owned = [Diagnostics.Process]::GetProcessById($script:forwardedPid)
                if ($owned.StartTime.ToUniversalTime() -lt $launcherCreated) { throw 'The forwarded process predates its launcher.' }
            } else {
                $start.FileName = $phase.executable
                $owned = [Diagnostics.Process]::Start($start)
            }
            $report.actualGuiLaunches++
            $identity = [ordered]@{ pid = $owned.Id; creationFileTime = $owned.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(); windowHandle = 0 }
            $item.identity = $identity
            Assert-Owned $owned $identity $phase.executable
            $actualImagePath = [EntrypointNativeRead]::ImagePath($owned.Handle)
            $actualHash = (Get-FileHash -LiteralPath $actualImagePath -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actualHash -ne $phase.sha256) { throw 'The started executable digest differs from the prepared candidate.' }
            $identity.executableSha256 = $actualHash
            $identity.executablePath = $actualImagePath
            $row = Get-CimInstance Win32_Process -Filter "ProcessId=$($owned.Id)"
            if ($row.CommandLine.Trim() -notin @($phase.executable, ('"' + $phase.executable + '"'))) { throw 'The actual manager command line is not the exact no-argument executable.' }
            $item.actualNoArgumentsVerified = $true
            $expectedTitle = if ($phase.name -eq 'legacy-sidecar') { 'Skill Manager' } else { 'Agent Resource Manager' }
            Wait-Until {
                Assert-Owned $owned $identity $phase.executable
                $window = [EntrypointNativeRead]::VisibleWindow($owned.Id, $expectedTitle)
                if (-not $window) { return $false }
                $element = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]$window.Handle)
                if ($element.Current.ControlType -ne [Windows.Automation.ControlType]::Window -or $element.Current.IsOffscreen -or [string]::IsNullOrEmpty($element.Current.Name)) { return $false }
                if ($element.Current.ProcessId -ne $owned.Id -or $element.Current.Name -ne $expectedTitle) { throw 'The exact visible manager window has inconsistent native accessibility identity.' }
                $identity.windowHandle = $window.Handle
                $identity.windowTitle = $window.Title
                $identity.windowClass = $window.ClassName
                Assert-Owned $owned $identity $phase.executable
                return $true
            } 'The exact owned process did not expose its visible titled Tauri Window.'
            if ($phase.requireBackendStatus) {
                $script:entryStatus = $null
                Wait-Until {
                    Assert-Owned $owned $identity $phase.executable
                    try { $script:entryStatus = [EntrypointNativeRead]::Status($owned.Id) | ConvertFrom-Json }
                    catch { if ($_.Exception.GetBaseException() -is [TimeoutException]) { return $false }; throw }
                    if ($script:entryStatus.ready -ne $true) { return $false }
                    if ($script:entryStatus.processId -ne $owned.Id -or -not (Test-SamePath $script:entryStatus.dataDir $phase.dataDirectory)) { throw 'The real backend did not select this phase data directory.' }
                    return $true
                } 'The owned backend did not report readiness and its expected data directory.'
                $item.dataDirectoryEvidence = [ordered]@{ method = 'owner-checked-native-pipe-status'; processId = $script:entryStatus.processId; ready = $script:entryStatus.ready; actualDataDirectory = $script:entryStatus.dataDir }
            } else {
                $item.dataDirectoryEvidence = Read-LegacyDirectory $owned $identity $phase.executable $phase.dataDirectory
            }
            if (-not (Test-Path -LiteralPath (Join-Path $phase.dataDirectory 'manager.sqlite3') -PathType Leaf)) { throw 'The selected data directory has no real initialized database.' }
            if ((Get-ChildItem -LiteralPath $datasetValue.sentinel -Force).Count) { throw 'The unused environment sentinel directory was written.' }
            $quitName = if ($phase.name -eq 'legacy-sidecar') { '退出全部窗口' } else { '完全退出管理器' }
            $item.normalExit = Stop-Normally $owned $identity $phase.executable $quitName
            if ($item.normalExit.exitCode -ne 0) { throw 'The exact owned manager exited with an unsuccessful code.' }
            Assert-NoManager
            $item.status = 'passed'
        } catch {
            $item.status = 'failed'
            $item.error = $_.Exception.GetBaseException().Message
            if ($owned -and -not $owned.HasExited -and $identity -and $identity.windowHandle) {
                if ($phase.name -eq 'legacy-sidecar') {
                    $item.legacyOutlineAction = $script:legacyOutlineAction
                    try { $item.legacyDirectoryDiagnostic = Read-LegacyStructureDiagnostic $owned $identity $phase.executable $phase.dataDirectory }
                    catch { $item.legacyDirectoryDiagnostic = [ordered]@{ status = 'owned-diagnostic-unavailable'; errorType = $_.Exception.GetBaseException().GetType().Name } }
                }
                try {
                    $quitName = if ($phase.name -eq 'legacy-sidecar') { '退出全部窗口' } else { '完全退出管理器' }
                    $item.failureNormalExit = Stop-Normally $owned $identity $phase.executable $quitName
                } catch {
                    $item.failureNormalExitError = $_.Exception.GetBaseException().Message
                }
            }
            $item.ownedProcessStillRunning = $null -ne $owned -and -not $owned.HasExited
            $item.remainingManagers = @(Get-Managers | Select-Object ProcessId, ParentProcessId, ExecutablePath)
            throw
        } finally {
            $item.finishedAt = [DateTime]::UtcNow.ToString('o')
            Save-Report
            if ($owned) { $owned.Dispose() }
            if ($launcher) { $launcher.Dispose() }
            foreach ($handle in $inputHandles) { $handle.Dispose() }
        }
    }
    $report.status = 'passed'
} catch {
    $report.status = 'failed'
    $report.error = $_.Exception.GetBaseException().Message
} finally {
    $report.finishedAt = [DateTime]::UtcNow.ToString('o')
    Save-Report
    $env:TEMP = $previousTemporary
    $env:TMP = $previousTmp
}
$report | ConvertTo-Json -Depth 12
if ($outputPath) { [Console]::Out.WriteLine("Report saved to $outputPath") }
if ($report.status -eq 'failed') { exit 1 }
