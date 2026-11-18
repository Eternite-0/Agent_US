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
    Checked docker @('build','--platform','linux/amd64','--build-arg',"BASE=$baseImage",'-f',"$build/Dockerfile.git",'-t','agent-us/git-base:latest',$build)
    Checked docker @('build','--platform','linux/amd64','--build-arg','BASE=agent-us/git-base:latest','-t','agent-us/worker:1',$build)
}
if($Target -in 'Magpie','All') {
    $build=Join-Path $cache 'magpie-build'
    New-Item -ItemType Directory -Path $build -Force | Out-Null
    $release=Get-Content -Raw "$basePath/docs/magpie-release.json" | ConvertFrom-Json
    Asset $release.url (Join-Path $build 'magpie') SHA256 $release.digest.Substring(7)
    Copy-Item "$basePath/sidecar/*" $build -Force
    Checked docker @('build','--platform','linux/amd64','--build-arg',"BASE=$baseImage",'-t',"agent-us/magpie:$($release.tag)",$build)
}
