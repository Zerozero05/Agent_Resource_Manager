param(
    [ValidatePattern('^[a-z0-9-]{1,64}$')][string]$Label = 'candidate',
    [switch]$Detached
)
$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $sourceRoot
. (Join-Path $sourceRoot '..\environment\activate.ps1')
$outputRoot = [IO.Path]::GetFullPath((Join-Path $sourceRoot 'outputs\v1-validation'))
if ($Detached) {
    $outputRoot = Join-Path $outputRoot ("detached-$Label")
    if (Test-Path -LiteralPath $outputRoot) { throw 'Detached candidate directory already exists; choose a new label' }
}
[IO.Directory]::CreateDirectory($outputRoot) | Out-Null
function Get-InputManifest {
    $paths = [Collections.Generic.List[string]]::new()
    foreach ($file in @('index.html','package.json','pnpm-lock.yaml','tsconfig.json','vite.config.ts','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/build.rs','src-tauri/tauri.conf.json','src-tauri/windows-app.manifest')) {
        $path = Join-Path $sourceRoot $file
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing build input: $file" }
        $paths.Add($path)
    }
    foreach ($directory in @('src','dist','src-tauri/src','src-tauri/capabilities','src-tauri/icons')) {
        Get-ChildItem -LiteralPath (Join-Path $sourceRoot $directory) -File -Recurse | ForEach-Object { $paths.Add($_.FullName) }
    }
    @($paths | Sort-Object -Unique | ForEach-Object {
        [pscustomobject]@{path=[IO.Path]::GetRelativePath($sourceRoot,$_).Replace('\','/');sha256=(Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()}
    }) | ConvertTo-Json -Depth 4
}
# Frontend tests/build must already have completed. A changing input invalidates
# this candidate rather than associating it with a later source tree.
$before = Get-InputManifest
$encoding = [Text.UTF8Encoding]::new($false)
$manifestHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($encoding.GetBytes($before))).ToLowerInvariant()
$commit = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') { throw 'Cannot bind candidate to source identity' }
$buildLog = Join-Path $outputRoot ("release-$Label.log")
$defaultExecutable = [IO.Path]::GetFullPath((Join-Path $env:CARGO_TARGET_DIR 'release\agent-resource-manager.exe'))
$originalHash = if ($Detached -and (Test-Path -LiteralPath $defaultExecutable)) { (Get-FileHash -LiteralPath $defaultExecutable -Algorithm SHA256).Hash } else { $null }
$executable = if ($Detached) { Join-Path $outputRoot 'agent-resource-manager.exe' } else { $defaultExecutable }
$buildCommand = 'cargo build --manifest-path src-tauri/Cargo.toml --locked --offline --release --features custom-protocol --bin agent-resource-manager'
if ($Detached) {
    # Keep the running preview in place while reusing the existing dependency cache.
    $buildCommand = 'cargo rustc --manifest-path src-tauri/Cargo.toml --locked --offline --release --features custom-protocol --bin agent-resource-manager -- --emit=link=' + $executable
    cargo rustc --manifest-path src-tauri/Cargo.toml --locked --offline --release --features custom-protocol --bin agent-resource-manager -- "--emit=link=$executable" *> $buildLog
} else {
    cargo build --manifest-path src-tauri/Cargo.toml --locked --offline --release --features custom-protocol --bin agent-resource-manager *> $buildLog
}
if ($LASTEXITCODE -ne 0) { Get-Content -LiteralPath $buildLog -Tail 65; throw 'Native candidate build failed' }
if ($originalHash -and (Get-FileHash -LiteralPath $defaultExecutable -Algorithm SHA256).Hash -ne $originalHash) { throw 'Existing preview changed; detached candidate was not certified' }
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Native build did not produce the expected executable' }
if ((Get-InputManifest) -cne $before) { throw 'Build inputs changed; candidate provenance was not published' }
$infoPath = Join-Path $outputRoot 'candidate-build-info.json'
$manifestPath = Join-Path $outputRoot 'candidate-runtime-source-manifest.json'
if (Test-Path -LiteralPath $infoPath) {
    $previous = Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json
    if ($previous.executableSha256 -notmatch '^[0-9a-f]{64}$' -or $previous.runtimeSourceManifestSha256 -notmatch '^[0-9a-f]{64}$') { throw 'Prior evidence identity is invalid; it was not moved' }
    $history = [IO.Path]::GetFullPath((Join-Path $outputRoot ("builds/"+$previous.executableSha256+'/'+$previous.runtimeSourceManifestSha256)))
    if (-not $history.StartsWith($outputRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Evidence destination escaped the validation directory' }
    $entries = @($infoPath,$manifestPath)
    foreach ($path in $entries) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Test-Path -LiteralPath (Join-Path $history ([IO.Path]::GetFileName($path))))) { throw 'Prior evidence is missing or would be overwritten' }
    }
    [IO.Directory]::CreateDirectory($history) | Out-Null
    foreach ($path in $entries) { Move-Item -LiteralPath $path -Destination (Join-Path $history ([IO.Path]::GetFileName($path))) }
}
[IO.File]::WriteAllText($manifestPath,$before,$encoding)
$information = [ordered]@{
    buildMode='release';version=(Get-Content -LiteralPath 'package.json' -Raw|ConvertFrom-Json).version
    sourceIdentity=$commit+'+dirty:'+$manifestHash;sourceCommit=$commit;runtimeSourceManifestSha256=$manifestHash
    executablePath=$executable;executableSha256=(Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
    buildCommand=$buildCommand;detached=[bool]$Detached;priorExecutableSha256=$originalHash
    nativeGuiVerified=$false;uncompiledWorkInProgressExcluded=@();builtAtUtc=[DateTime]::UtcNow.ToString('o')
}
[IO.File]::WriteAllText($infoPath,($information|ConvertTo-Json -Depth 5),$encoding)
node scripts/verify-mcp-stdio.mjs $executable *> (Join-Path $outputRoot ("mcp-$Label.log"))
if ($LASTEXITCODE -ne 0) { throw 'Native MCP smoke failed; this candidate is not approved' }
$information | ConvertTo-Json -Compress
