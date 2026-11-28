$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or $env:GITHUB_REPOSITORY -cne 'Zerozero05/Agent_Resource_Manager' -or -not [Environment]::UserInteractive){throw 'Requires an isolated hosted Windows runner.'}
$root='D:\arm-renderer-probe-6239'
if(Test-Path -LiteralPath $root){throw 'Existing diagnostic directory.'}
if(Get-Process -Name 'agent-resource-manager','skill-manager' -ErrorAction SilentlyContinue){throw 'Existing manager on the runner.'}
New-Item -ItemType Directory -Path $root | Out-Null
$report=New-Item -ItemType Directory -Path (Join-Path $env:RUNNER_TEMP 'arm-owned-renderer-evidence')
$exe=(Resolve-Path 'src-tauri\target\release\agent-resource-manager.exe').ProviderPath
if([Environment]::GetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS') -or [Environment]::GetEnvironmentVariable('WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER')){throw 'Unanticipated WebView2 diagnostic environment'}
Get-FileHash -LiteralPath $exe -Algorithm SHA256 | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $report.FullName 'diagnostic-binary-sha.json')
$sha=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
$version = [ordered]@{status='running';source='6239e8ed54714105cc5da455a3c0d2be1cd9eed2';head=$env:GITHUB_SHA;build='diagnostic-only';softwarePublished=$false;diagnosticExeSHA256=$sha;windows=[Environment]::OSVersion.Version.ToString();host=$env:COMPUTERNAME;runnerImage=$env:ImageVersion;node=(node --version);order=@('navigation','check');scenarios=@()}
function Save($path,$obj){$obj|ConvertTo-Json -Depth 18|Set-Content -LiteralPath $path -Encoding utf8NoBOM}
function Read-Processes($owner,$born,$dir) {
    if($owner.HasExited -or $owner.StartTime.ToUniversalTime().ToFileTimeUtc() -ne $born){throw 'Lost the test process'}
    $rows=@(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'")
    $browser=@($rows | Where-Object { $_.ParentProcessId -eq $owner.Id -and $_.CommandLine -notmatch '(?:^|\s)--type=' })
    if($browser.Count -ne 1 -or $browser[0].CommandLine.IndexOf($dir,[StringComparison]::OrdinalIgnoreCase) -lt 0){throw 'Missing unique owned browser with the synthetic path'}
    $children=@($rows|Where-Object {$_.ParentProcessId -eq $browser[0].ProcessId -and $_.CommandLine -match '(?:^|\s)--type=renderer(?:\s|$)'})
    if($children.Count -ne 1){throw 'Expected one owned renderer'}
    $answer=@()
    foreach($item in @(@('manager',$owner.Id),@('browser',$browser[0].ProcessId),@('renderer',$children[0].ProcessId))){
        $proc=Get-Process -Id $item[1] -ErrorAction Stop
        $answer+=[ordered]@{role=$item[0];pid=$proc.Id;born=$proc.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();privateBytes=$proc.PrivateMemorySize64;workingSet=$proc.WorkingSet64;virtualBytes=$proc.VirtualMemorySize64;handles=$proc.HandleCount;cpuMs=$proc.TotalProcessorTime.TotalMilliseconds;version=$proc.ProductVersion}
        $proc.Dispose()
    }
    return $answer
}
$sampleNames=@('baseline','pair2','pair4','pair6','final')
try{
    foreach($variant in $version.order){
        $dir=Join-Path $root $variant
        $target=New-Item -ItemType Directory -Path (Join-Path $report.FullName $variant)
        node ./scripts/owned-renderer-fixture.mjs prepare $variant
        if($LASTEXITCODE -ne 0){throw 'Synthetic prepare failed'}
        $info=[Diagnostics.ProcessStartInfo]::new($exe)
        $info.WorkingDirectory=(Split-Path -Parent $exe)
        $info.UseShellExecute=$false
        $info.ArgumentList.Add('--data-dir');$info.ArgumentList.Add((Join-Path $dir 'data'))
        $info.Environment['ARM_RENDERER_PROBE_VARIANT']=$variant
        foreach($key in @('GH_TOKEN','GITHUB_TOKEN','WEBVIEW2_USER_DATA_FOLDER','SKILL_MANAGER_DATA_DIR')){[void]$info.Environment.Remove($key)}
        $owner=[Diagnostics.Process]::Start($info);$born=$owner.StartTime.ToUniversalTime().ToFileTimeUtc()
        $seen=@{};$pendingFailure=$null
        $watch=[Diagnostics.Stopwatch]::StartNew()
        try{
            while(-not $owner.HasExited){
                if($watch.Elapsed.TotalMinutes -gt 5){throw 'Timed out waiting for the owned diagnostic. No second session will start.'}
                foreach($stage in $sampleNames){
                    $file=Join-Path $dir "probe-$stage.json"
                    if($seen.ContainsKey($stage) -or -not (Test-Path -LiteralPath $file)){continue}
                    $record=Get-Content -Raw -LiteralPath $file|ConvertFrom-Json
                    if($record.pid -ne $owner.Id -or $record.variant -cne $variant -or $record.stage -cne $stage -or $null -eq $record.heap.usedSize -or $record.heap.usedSize -le 0 -or $null -eq $record.dom.nodes -or $record.dom.nodes -le 0 -or $record.tabs -ne 1){throw 'Incomplete or mismatched WebView2 snapshot'}
                    $observedAt=[DateTimeOffset]::UtcNow
                    $counter=@(Read-Processes $owner $born $dir)
                    $seen[$stage]=$true
                    Save (Join-Path $target.FullName "native-$stage.json") ([ordered]@{observedAt=$observedAt.ToString('o');afterPageMs=($observedAt-[DateTimeOffset]::Parse($record.time)).TotalMilliseconds;processes=$counter})
                    Copy-Item -LiteralPath $file -Destination $target.FullName
                }
                $failFile=Join-Path $dir 'probe-failure.json'
                if(Test-Path -LiteralPath $failFile){$pendingFailure=(Get-Content -Raw -LiteralPath $failFile|ConvertFrom-Json).reason;Copy-Item -LiteralPath $failFile -Destination $target.FullName -Force}
                Start-Sleep -Milliseconds 140
                $owner.Refresh()
            }
            $owner.WaitForExit()
            if($pendingFailure -or $owner.ExitCode -ne 0 -or $seen.Count -ne 5){throw "Incomplete sampling or exit (code=$($owner.ExitCode),samples=$($seen.Count)): $pendingFailure"}
            node ./scripts/owned-renderer-fixture.mjs verify $variant
            if($LASTEXITCODE -ne 0){throw 'Protected fixture or check receipts invalid'}
            Copy-Item -LiteralPath (Join-Path $dir 'db-readback.json') -Destination $target.FullName
            $version.scenarios+=@([ordered]@{variant=$variant;samples=$seen.Count;normalExit=$true;exitCode=$owner.ExitCode;owner=$owner.Id})
            Write-Host "Finished $variant with five memory boundaries and a normal exit."
        }finally{$owner.Dispose()}
    }
    $version.status='complete'
} catch{
    $version.error=$_.Exception.Message;throw
}finally{Save (Join-Path $report.FullName 'manifest.json') $version}
