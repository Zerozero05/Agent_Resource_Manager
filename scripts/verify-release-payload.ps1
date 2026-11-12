param(
    [Parameter(Mandatory)][string]$InstallerContents,
    [Parameter(Mandatory)][string]$PortableZip,
    [Parameter(Mandatory)][string]$ExpectedProgram,
    [Parameter(Mandatory)][string]$ExpectedNotices,
    [Parameter(Mandatory)][string]$ExpectedGuide
)

$ErrorActionPreference = 'Stop'
function Get-PayloadHash([string]$Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
$programHash = Get-PayloadHash $ExpectedProgram
$noticesHash = Get-PayloadHash $ExpectedNotices
$guideHash = Get-PayloadHash $ExpectedGuide
$programs = @(Get-ChildItem -LiteralPath $InstallerContents -File -Recurse -Filter 'agent-resource-manager.exe')
$notices = @(Get-ChildItem -LiteralPath $InstallerContents -File -Recurse -Filter 'THIRD_PARTY_NOTICES.txt')
if ($programs.Count -ne 1 -or (Get-PayloadHash $programs[0].FullName) -ne $programHash) {
    throw 'Installer must contain exactly one copy of the verified executable'
}
if ($notices.Count -ne 1 -or $notices[0].DirectoryName -ne $programs[0].DirectoryName -or (Get-PayloadHash $notices[0].FullName) -ne $noticesHash) {
    throw 'Installer must contain the verified license notices beside the executable'
}

$expected = @{
    'app/agent-resource-manager.exe' = $programHash
    'app/THIRD_PARTY_NOTICES.txt' = $noticesHash
    'USER_GUIDE.md' = $guideHash
}
$archive = [IO.Compression.ZipFile]::OpenRead($PortableZip)
try {
    $files = @($archive.Entries | Where-Object Name)
    $allowed = @($expected.Keys) + 'app/data-directory.txt'
    if ($files.Count -ne 4 -or @($files | Where-Object { $_.FullName -cnotin $allowed }).Count) {
        throw 'Portable ZIP must contain exactly the four expected runtime files'
    }
    foreach ($name in $allowed) {
        $entries = @($files | Where-Object { $_.FullName -ceq $name })
        if ($entries.Count -ne 1) { throw "Portable ZIP member is missing or duplicated: $name" }
        $stream = $entries[0].Open()
        try {
            if ($name -eq 'app/data-directory.txt') {
                $memory = [IO.MemoryStream]::new()
                try {
                    $stream.CopyTo($memory)
                    if ([Convert]::ToHexString($memory.ToArray()) -ne '2E0A') {
                        throw 'Portable ZIP must use the fresh relative data-directory setting'
                    }
                } finally { $memory.Dispose() }
            } else {
                $actual = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant()
                if ($actual -ne $expected[$name]) { throw "Portable ZIP content differs from the verified input: $name" }
            }
        } finally { $stream.Dispose() }
    }
} finally { $archive.Dispose() }

[pscustomobject]@{
    installerExecutableSha256 = $programHash
    portableExecutableSha256 = $programHash
    installerNoticesSha256 = $noticesHash
    portableNoticesSha256 = $noticesHash
    portableGuideSha256 = $guideHash
    portableDataDirectoryVerified = $true
}
