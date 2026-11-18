[CmdletBinding()]
param([ValidateSet('All','Worker','Magpie')][string]$Target='All')
$ErrorActionPreference='Stop'
$basePath=Split-Path $PSScriptRoot -Parent
$cache=Join-Path $basePath 'var'
$baseImage='python@sha256:07d4824036af339fa1b6ef769cc99d9c10a141769538b52b3b597c84f7a7b535'
function Checked([string]$Program,[string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed ($LASTEXITCODE)" }
}
function Asset([string]$Uri,[string]$File,[string]$Algorithm,[string]$Expected) {
    if ((Test-Path -LiteralPath $File) -and (Get-FileHash -LiteralPath $File -Algorithm $Algorithm).Hash -eq $Expected) { return }
    $part="$File.download"
    Checked curl.exe @('-fLsS','--retry','2','--max-time','600','-o',$part,$Uri)
    if ((Get-FileHash -LiteralPath $part -Algorithm $Algorithm).Hash -ne $Expected) { throw "Digest mismatch for $Uri" }
    Copy-Item -LiteralPath $part -Destination $File -Force
    Remove-Item -LiteralPath $part
}
# Bind cached layers to the pinned Python digest before reusing any local tag.
$baseId = docker image inspect $baseImage --format '{{.Id}}' 2>$null
if ($LASTEXITCODE -ne 0) {
    Checked docker @('pull','--platform','linux/amd64',$baseImage)
    $baseId = docker image inspect $baseImage --format '{{.Id}}'
}
$localBase = 'agent-us/python:' + $baseId.Substring(7,16)
Checked docker @('tag',$baseImage,$localBase)
function HasGitBase {
    $layers = docker image inspect agent-us/git-base:latest --format '{{json .RootFS.Layers}}' 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }
    $expected = (docker image inspect $localBase --format '{{json .RootFS.Layers}}') | ConvertFrom-Json
    $actual = $layers | ConvertFrom-Json
    if ($actual.Count -ne $expected.Count+1) { return $false }
    for ($i=0; $i -lt $expected.Count; $i++) { if ($expected[$i] -ne $actual[$i]) { return $false } }
    $version = docker run --rm --network=none --read-only --cap-drop=ALL --user=65534:65534 --entrypoint dpkg-query agent-us/git-base:latest -W '-f=${Version}' git
    return ($LASTEXITCODE -eq 0 -and $version -eq '1:2.47.3-0+deb13u1')
}
if($Target -in 'Worker','All') {
    $bits=Join-Path $cache 'codex-build'
    $build=Join-Path $cache 'worker-image'
    New-Item -ItemType Directory -Path $bits,$build -Force | Out-Null
    $tgz=Join-Path $bits 'codex.tgz'
    $digest=[Convert]::ToHexString([Convert]::FromBase64String('14UgzDS+X4crkvdt6S02A/ZZOrS8ZyWiuTRpguCtnhNamb7unSuDxy86BWgpAl3sqiTaN2CP8VLyp2ohQ8Nbzw=='))
    Asset 'https://registry.npmjs.org/@openai/codex/-/codex-0.139.0-linux-x64.tgz' $tgz SHA512 $digest
    $bin='package/vendor/x86_64-unknown-linux-musl/bin/codex'
    Checked tar @('-xf',$tgz,'-C',$bits,$bin)
    Copy-Item -LiteralPath (Join-Path $bits $bin) -Destination (Join-Path $build 'codex') -Force
    Copy-Item "$basePath/sandbox/*" $build -Force
    if (-not (HasGitBase)) {
        Checked docker @('build','--platform','linux/amd64','--build-arg',"BASE=$localBase",'-f',"$build/Dockerfile.git",'-t','agent-us/git-base:latest',$build)
    }
    Checked docker @('build','--platform','linux/amd64','--build-arg','BASE=agent-us/git-base:latest','-t','agent-us/worker:1',$build)
}
if($Target -in 'Magpie','All') {
    $build=Join-Path $cache 'magpie-build'
    New-Item -ItemType Directory -Path $build -Force | Out-Null
    $release=Get-Content -Raw "$basePath/docs/magpie-release.json" | ConvertFrom-Json
    Asset $release.url (Join-Path $build 'magpie') SHA256 $release.digest.Substring(7)
    Copy-Item "$basePath/sidecar/*" $build -Force
    Checked docker @('build','--platform','linux/amd64','--build-arg',"BASE=$localBase",'-t',"agent-us/magpie:$($release.tag)",$build)
}
