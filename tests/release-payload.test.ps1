param([string]$EvidenceRoot = (Join-Path $PSScriptRoot '../outputs/release-payload-tests'))
$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetFullPath($EvidenceRoot)) ([Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
$utf8 = [Text.UTF8Encoding]::new($false)
$verifier = Join-Path $PSScriptRoot '../scripts/verify-release-payload.ps1'
$cases = @('valid', 'installer-program', 'installer-notices', 'installer-missing-notices', 'installer-misplaced-notices', 'portable-program', 'portable-notices', 'portable-guide', 'portable-data-path', 'portable-extra', 'portable-duplicate')
$results = @()
foreach ($case in $cases) {
    $dir = Join-Path $root $case
    $installer = Join-Path $dir 'installer'
    [IO.Directory]::CreateDirectory($installer) | Out-Null
    $program = Join-Path $dir 'expected-program.bin'
    $notice = Join-Path $dir 'expected-notices.txt'
    $guide = Join-Path $dir 'expected-guide.md'
    [IO.File]::WriteAllText($program, 'synthetic program; never execute', $utf8)
    [IO.File]::WriteAllText($notice, 'original third-party notices', $utf8)
    [IO.File]::WriteAllText($guide, 'current guide', $utf8)
    [IO.File]::WriteAllText((Join-Path $installer 'agent-resource-manager.exe'), $(if ($case -eq 'installer-program') { 'stale program' } else { [IO.File]::ReadAllText($program) }), $utf8)
    if ($case -ne 'installer-missing-notices') {
        $noticeDir = $installer
        if ($case -eq 'installer-misplaced-notices') { $noticeDir = Join-Path $installer 'wrong'; [IO.Directory]::CreateDirectory($noticeDir) | Out-Null }
        [IO.File]::WriteAllText((Join-Path $noticeDir 'THIRD_PARTY_NOTICES.txt'), $(if ($case -eq 'installer-notices') { 'stale notices' } else { [IO.File]::ReadAllText($notice) }), $utf8)
    }
    $members = [ordered]@{
        'app/agent-resource-manager.exe' = [IO.File]::ReadAllText($program)
        'app/THIRD_PARTY_NOTICES.txt' = [IO.File]::ReadAllText($notice)
        'USER_GUIDE.md' = [IO.File]::ReadAllText($guide)
        'app/data-directory.txt' = ".`n"
    }
    switch ($case) {
        'portable-program' { $members['app/agent-resource-manager.exe'] = 'stale program' }
        'portable-notices' { $members['app/THIRD_PARTY_NOTICES.txt'] = 'stale notices' }
        'portable-guide' { $members['USER_GUIDE.md'] = 'stale guide' }
        'portable-data-path' { $members['app/data-directory.txt'] = 'C:/unexpected/data' }
        'portable-extra' { $members['private.sqlite3'] = 'synthetic unexpected member' }
        'portable-duplicate' { $members.Remove('USER_GUIDE.md') }
    }
    $zipPath = Join-Path $dir 'portable.zip'
    $zip = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($name in $members.Keys) {
            $entry = $zip.CreateEntry($name)
            $stream = $entry.Open()
            try { $bytes = $utf8.GetBytes($members[$name]); $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
        }
        if ($case -eq 'portable-duplicate') {
            $entry = $zip.CreateEntry('app/THIRD_PARTY_NOTICES.txt')
            $stream = $entry.Open()
            try { $bytes = $utf8.GetBytes($members['app/THIRD_PARTY_NOTICES.txt']); $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
        }
    } finally { $zip.Dispose() }
    $failure = $null
    try {
        $result = & $verifier -InstallerContents $installer -PortableZip $zipPath -ExpectedProgram $program -ExpectedNotices $notice -ExpectedGuide $guide
        if ($case -eq 'valid' -and (-not $result.portableDataDirectoryVerified -or $result.installerNoticesSha256 -ne (Get-FileHash $notice).Hash.ToLowerInvariant())) { throw 'Verifier returned incorrect evidence' }
    } catch { $failure = $_.Exception.Message }
    if (($case -eq 'valid') -eq [bool]$failure) { throw "Unexpected result for ${case}: $failure" }
    $expectedFailure = switch ($case) {
        'installer-program' { 'exactly one copy of the verified executable' }
        { $_ -in @('installer-notices', 'installer-missing-notices', 'installer-misplaced-notices') } { 'verified license notices beside the executable' }
        'portable-program' { 'content differs from the verified input: app/agent-resource-manager.exe' }
        'portable-notices' { 'content differs from the verified input: app/THIRD_PARTY_NOTICES.txt' }
        'portable-guide' { 'content differs from the verified input: USER_GUIDE.md' }
        'portable-data-path' { 'fresh relative data-directory setting' }
        'portable-extra' { 'exactly the four expected runtime files' }
        'portable-duplicate' { 'member is missing or duplicated' }
    }
    if ($expectedFailure -and -not $failure.Contains($expectedFailure)) { throw "Wrong rejection for ${case}: $failure" }
    $results += [pscustomobject]@{ case = $case; passed = $true; rejection = $failure }
}
$results | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'results.json') -Encoding utf8NoBOM
Write-Output "$($results.Count) release payload checks passed. Synthetic fixtures retained at $root"
