#Requires -Version 7.2
param([switch]$Run, [switch]$CompileOnly)
$ErrorActionPreference = 'Stop'
if ($Run -and $CompileOnly) { throw 'Choose either compilation or an actual run.' }
$fixture = 'D:\03_github_projects\Agent_Management\Agent_Resource_Manager\validation\resources\native-dragon-playback-8xPwcs'
$original = 'D:\03_github_projects\Interface_Tools\Dragon_Codex_Boot'
$temporary = 'D:\03_github_projects\Agent_Management\Agent_Resource_Manager\validation\manager-data\native-entrypoints-0heGph\native-temp'
$expectedHash = '38a16c973f44a413b4b175f5470592574c172a9232ff03c7ccccbf4d886fde31'
$previousTemp, $previousTmp = $env:TEMP, $env:TMP
$env:TEMP = $temporary
$env:TMP = $temporary
$child = $null
$reportStream = $null
$locks = @()

function Assert-Ordinary([string]$Path) {
    for ($current = [IO.Path]::GetFullPath($Path); $current; $current = [IO.Path]::GetDirectoryName($current)) {
        $item = Get-Item -LiteralPath $current -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint -or $item.LinkType -eq 'HardLink') { throw 'A validation path is linked.' }
    }
}
function Read-Manifest {
    Assert-Ordinary $original
    @(Get-ChildItem -LiteralPath $original -Force -Recurse | Sort-Object FullName | ForEach-Object {
        Assert-Ordinary $_.FullName
        [ordered]@{ path = [IO.Path]::GetRelativePath($original, $_.FullName); directory = $_.PSIsContainer; bytes = if ($_.PSIsContainer) { $null } else { $_.Length }; sha256 = if ($_.PSIsContainer) { $null } else { (Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant() } }
    })
}
function Save-Report {
    if ($reportStream) {
        $bytes = [Text.Encoding]::UTF8.GetBytes(($report | ConvertTo-Json -Depth 10))
        $reportStream.Position = 0
        $reportStream.SetLength(0)
        $reportStream.Write($bytes)
        $reportStream.Flush()
    }
}
function Capture-Frame([long]$Handle, [string]$Path) {
    $box = [DragonPlaybackNative]::CaptureBounds($Handle)
    $image = [Drawing.Bitmap]::new($box[2], $box[3])
    $graphics = $output = $null
    try {
        $graphics = [Drawing.Graphics]::FromImage($image)
        $output = [IO.File]::Open($Path, 'CreateNew', 'Write', 'Read')
        $graphics.CopyFromScreen($box[0], $box[1], 0, 0, [Drawing.Size]::new($box[2], $box[3]))
        $image.Save($output, [Drawing.Imaging.ImageFormat]::Png)
    } finally {
        if ($output) { $output.Dispose() }
        if ($graphics) { $graphics.Dispose() }
        $image.Dispose()
    }
}
try {
    Assert-Ordinary $temporary
    Add-Type -AssemblyName System.Drawing
    Add-Type -ReferencedAssemblies System.Diagnostics.Process, Microsoft.Win32.Primitives, System.Collections -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class DragonPlaybackNative {
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int L,T,R,B; }
  [StructLayout(LayoutKind.Sequential)] struct Point { public int X,Y; }
  [StructLayout(LayoutKind.Sequential)] struct LastInput { public uint Size,Time; }
  delegate bool EnumWindow(IntPtr window,IntPtr unused);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback,IntPtr unused);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,StringBuilder value,int length);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window,out Rect value);
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput value);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flag);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int metric);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder value,ref uint size);
  public static string Image(Process process) {
    var value=new StringBuilder(32768);uint size=(uint)value.Capacity;
    if(!QueryFullProcessImageName(process.Handle,0,value,ref size))throw new Win32Exception();
    return value.ToString();
  }
  public static uint InputTick() {
    var value=new LastInput { Size=(uint)Marshal.SizeOf(typeof(LastInput)) };
    if(!GetLastInputInfo(ref value))throw new InvalidOperationException("Input observation unavailable.");
    return value.Time;
  }
  public static long Window(int pid,string classPrefix) {
    var matches=new List<long>();
    EnumWindows((window,unused)=>{
      uint owner;GetWindowThreadProcessId(window,out owner);
      if(owner!=(uint)pid||!IsWindowVisible(window))return true;
      var name=new StringBuilder(256);GetClassName(window,name,name.Capacity);
      if(name.ToString().StartsWith(classPrefix,StringComparison.Ordinal))matches.Add(window.ToInt64());
      return true;
    },IntPtr.Zero);
    if(matches.Count>1)throw new InvalidOperationException("Owned visible windows are ambiguous.");
    return matches.Count==1?matches[0]:0;
  }
  public static int Owner(long handle) { uint pid;GetWindowThreadProcessId(new IntPtr(handle),out pid);return (int)pid; }
  public static int[] Bounds(long handle) {
    Rect value;if(!GetWindowRect(new IntPtr(handle),out value))throw new InvalidOperationException("Window bounds unavailable.");
    return new[]{value.L,value.T,value.R,value.B};
  }
  public static int[] CaptureBounds(long handle) {
    int[] box=Bounds(handle);int width=box[2]-box[0],height=box[3]-box[1];
    int left=GetSystemMetrics(76),top=GetSystemMetrics(77);
    if(width<500||width>2000||height<300||height>1200||box[0]<left||box[1]<top||box[2]>left+GetSystemMetrics(78)||box[3]>top+GetSystemMetrics(79))throw new InvalidOperationException("Playback bounds are outside the capture scope.");
    IntPtr hit=WindowFromPoint(new Point { X=box[0]+width/2,Y=box[1]+height/2 });
    if(GetAncestor(hit,2)!=new IntPtr(handle))throw new InvalidOperationException("Another window obscures the playback capture center.");
    return new[]{box[0],box[1],width,height};
  }
}
'@
    if ($CompileOnly) { [pscustomobject]@{ compiled = $true; targetStarted = $false; temporary = $temporary } | ConvertTo-Json -Compress; return }
    $executable = Join-Path $fixture 'DragonCodexBoot.exe'
    $configuration = Join-Path $fixture 'launcher.json'
    foreach ($path in @($executable, $configuration, (Join-Path $fixture 'logs\launcher.log'))) { Assert-Ordinary $path }
    foreach ($path in @($executable, $configuration)) { $locks += [IO.File]::Open($path, 'Open', 'Read', 'Read') }
    $configHash = (Get-FileHash -LiteralPath $configuration).Hash
    if ((Get-FileHash -LiteralPath $executable).Hash -ine $expectedHash -or (Get-FileHash -LiteralPath (Join-Path $original 'DragonCodexBoot.exe')).Hash -ine $expectedHash) { throw 'Fixture or installed executable changed.' }
    $cfg = Get-Content -Raw -LiteralPath $configuration | ConvertFrom-Json
    $expectedConfiguration = [ordered]@{
        AutoReplaceEntrypoints = $false
        ScanAllLocalDrives = $false
        MatchClientToPlayer = $false
        Volume = 0
        MaxWaitSeconds = 25
        PlayerWidth = 960
        PlayerHeight = 540
        AppLaunch = 'shell:AppsFolder\OpenAI.Codex_2p2nqsd0c76g0!App'
        Video = Join-Path $original 'media\startup.mp4'
        ProcessPathContains = 'OpenAI.Codex_'
        ProcessNames = @('ChatGPT', 'Codex')
        DisplayName = 'ARM Dragon Native Validation'
    }
    foreach ($key in $expectedConfiguration.Keys) {
        if (($cfg.$key | ConvertTo-Json -Compress) -cne ($expectedConfiguration[$key] | ConvertTo-Json -Compress)) { throw "Synthetic configuration changed at $key." }
    }
    Assert-Ordinary $cfg.Video
    if (-not (Test-Path -LiteralPath $cfg.Video -PathType Leaf) -or (Get-Item -LiteralPath $cfg.Video).Length -eq 0) { throw 'The existing video is unavailable.' }
    if (@(Get-CimInstance Win32_Process -Filter "Name='agent-resource-manager.exe' OR Name='skill-manager.exe' OR Name='DragonCodexBoot.exe'").Count) { throw 'A manager or Dragon process already exists.' }
    $clients = @(Get-Process -Name ChatGPT,Codex -ErrorAction SilentlyContinue | Where-Object { [DragonPlaybackNative]::Image($_) -like '*\OpenAI.Codex_*\app\*' -and [DragonPlaybackNative]::Window($_.Id, 'Chrome_WidgetWin_') })
    if ($clients.Count -ne 1) { throw 'Exactly one existing visible Codex client is required.' }
    $client = $clients[0]
    $clientWindow = [DragonPlaybackNative]::Window($client.Id, 'Chrome_WidgetWin_')
    if ([DragonPlaybackNative]::IsIconic([IntPtr]$clientWindow)) { throw 'The existing Codex window is minimized.' }
    $before = Read-Manifest
    $clientCreation = $client.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
    $clientBounds = [DragonPlaybackNative]::Bounds($clientWindow)
    if (-not $Run) { [pscustomobject]@{ status = 'preflight-passed-native-not-run'; executable = $executable; originalEntries = $before.Count; codexPid = $client.Id } | ConvertTo-Json -Compress; return }
    $id = [Guid]::NewGuid().ToString('N')
    $reportPath = Join-Path $fixture "native-playback-$id.json"
    $framePath = Join-Path $fixture "playback-frame-$id.png"
    $logPath = Join-Path $fixture 'logs\launcher.log'
    $logOffset = (Get-Item -LiteralPath $logPath).Length
    $inputTick = [DragonPlaybackNative]::InputTick()
    $report = [ordered]@{
        format = 'agent-resource-manager-native-dragon-playback-v1'
        status = 'running'
        startedAtUtc = [DateTime]::UtcNow.ToString('o')
        executable = $executable
        executableSha256 = $expectedHash
        configurationSha256 = $configHash
        originalRoot = $original
        originalBefore = $before
        managerCountBefore = 0
        codexPid = $client.Id
        codexCreation = $clientCreation
        codexWindow = $clientWindow
        codexBoundsBefore = $clientBounds
        inputTickBefore = $inputTick
        logByteOffset = $logOffset
        frame = $framePath
        frameRequiresVisualReview = $true
        forcedTermination = $false
    }
    $reportStream = [IO.File]::Open($reportPath, 'CreateNew', 'Write', 'Read')
    Save-Report
    try {
        $elapsed = [Diagnostics.Stopwatch]::StartNew()
        $child = Start-Process -FilePath $executable -WorkingDirectory $fixture -WindowStyle Normal -PassThru
        $report.pid = $child.Id
        Save-Report
        $created = $child.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
        $report.creationFileTime = $created
        Save-Report
        Start-Sleep -Milliseconds ([Math]::Max(0, 3000 - $elapsed.ElapsedMilliseconds))
        if ([DragonPlaybackNative]::InputTick() -ne $inputTick) { throw 'Desktop input changed before capture.' }
        $child.Refresh()
        if ($child.HasExited -or [DragonPlaybackNative]::Image($child) -ine $executable -or $child.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne $created) { throw 'Owned playback process changed before capture.' }
        $window = [DragonPlaybackNative]::Window($child.Id, 'HwndWrapper[')
        if (-not $window) { throw 'The owned playback window did not become visible.' }
        $report.playbackWindow = $window
        $report.playbackBounds = [DragonPlaybackNative]::Bounds($window)
        Capture-Frame $window $framePath
        $report.frameCapturedAtUtc = [DateTime]::UtcNow.ToString('o')
        while (-not $child.WaitForExit(250)) {
            if ([DragonPlaybackNative]::InputTick() -ne $inputTick) { throw 'Desktop input changed during playback.' }
            if ($elapsed.ElapsedMilliseconds -ge 50000) { throw 'Normal playback did not exit within fifty seconds.' }
        }
        $report.exitCode = $child.ExitCode
        if ($child.ExitCode -ne 0) { throw 'Normal playback returned an unsuccessful exit code.' }
        $log = [IO.File]::ReadAllBytes($logPath)
        if ($log.Length -lt $logOffset) { throw 'Playback log was replaced or truncated.' }
        $report.newLog = [Text.Encoding]::UTF8.GetString($log, $logOffset, $log.Length - $logOffset)
        foreach ($stage in @('media-opened', 'live-window-connected', 'handed-off-to-real-window')) { if (-not $report.newLog.Contains($stage)) { throw "Playback did not record $stage." } }
        $report.status = 'native-playback-completed-frame-review-pending'
    } catch {
        $report.status = 'failed-or-interrupted'
        $report.error = $_.Exception.GetBaseException().Message
        if ($child -and -not $child.HasExited -and [DragonPlaybackNative]::InputTick() -eq $inputTick) {
            if ([DragonPlaybackNative]::Image($child) -ieq $executable -and $child.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -eq $created) {
                $child.Refresh()
                if ($child.MainWindowHandle -ne [IntPtr]::Zero -and [DragonPlaybackNative]::Owner($child.MainWindowHandle.ToInt64()) -eq $child.Id) { $report.normalCloseRequested = $child.CloseMainWindow(); $report.cleanupExited = $child.WaitForExit(10000) }
            }
        }
    } finally {
        try {
            $report.originalAfter = Read-Manifest
            $report.originalRootUnchanged = ($before | ConvertTo-Json -Depth 5 -Compress) -ceq ($report.originalAfter | ConvertTo-Json -Depth 5 -Compress)
            $client.Refresh()
            if ($client.HasExited -or $client.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne $clientCreation -or [DragonPlaybackNative]::Owner($clientWindow) -ne $client.Id) { throw 'The original Codex process or window identity changed.' }
            $report.codexBoundsAfter = [DragonPlaybackNative]::Bounds($clientWindow)
            $report.codexPreserved = [DragonPlaybackNative]::IsWindowVisible([IntPtr]$clientWindow) -and -not [DragonPlaybackNative]::IsIconic([IntPtr]$clientWindow) -and ($clientBounds -join ',') -ceq ($report.codexBoundsAfter -join ',')
            $report.fixtureInputsUnchanged = (Get-FileHash -LiteralPath $configuration).Hash -eq $configHash -and (Get-FileHash -LiteralPath $executable).Hash -ieq $expectedHash
            $report.inputTickAfter = [DragonPlaybackNative]::InputTick()
            $report.inputUnchanged = $report.inputTickAfter -eq $inputTick
            if (-not $report.originalRootUnchanged -or -not $report.codexPreserved -or -not $report.fixtureInputsUnchanged -or -not $report.inputUnchanged) { $report.status = 'failed-or-interrupted' }
        } catch {
            $report.status = 'failed-or-interrupted'
            $report.verificationError = $_.Exception.GetBaseException().Message
        } finally {
            $report.remainingOwnedProcess = $null -ne $child -and -not $child.HasExited
            if ($report.remainingOwnedProcess) { $report.status = 'failed-or-interrupted' }
            if ($child -and $child.HasExited) { $report.exitCode = $child.ExitCode }
            $report.finishedAtUtc = [DateTime]::UtcNow.ToString('o')
            Save-Report
        }
    }
    [pscustomobject]@{ status = $report.status; report = $reportPath; frame = $framePath; exitCode = $report.exitCode; remainingOwnedProcess = $report.remainingOwnedProcess } | ConvertTo-Json -Compress
    if ($report.status -ne 'native-playback-completed-frame-review-pending') { exit 1 }
} finally {
    if ($reportStream) { $reportStream.Dispose() }
    if ($child) { $child.Dispose() }
    foreach ($handle in $locks) { $handle.Dispose() }
    $env:TEMP, $env:TMP = $previousTemp, $previousTmp
}
