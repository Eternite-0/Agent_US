$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendDir = Join-Path $Root 'backend'
$FrontendDir = Join-Path $Root 'frontend'
$VarDir = Join-Path $BackendDir 'var'
$TokenFile = Join-Path $VarDir '.dev-token'

New-Item -ItemType Directory -Force -Path $VarDir | Out-Null

if ($env:BACKEND_TOKEN -and $env:BACKEND_TOKEN.Length -ge 24) {
  $Token = $env:BACKEND_TOKEN
} elseif (Test-Path $TokenFile) {
  $Token = (Get-Content -Raw $TokenFile).Trim()
} else {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $Token = ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
  Set-Content -NoNewline -Path $TokenFile -Value $Token
}

$Port = if ($env:PORT) { $env:PORT } else { '8787' }
$BackendUrl = "http://127.0.0.1:$Port"

Write-Host "[Agent_US] Starting backend on $BackendUrl ..."
$env:BACKEND_TOKEN = $Token
$env:BACKEND_DATA = $VarDir
$env:PORT = $Port
$env:BACKEND_URL = $BackendUrl

$ConfigFile = Join-Path $VarDir 'config.json'
if (-not $env:BACKEND_CONFIG -and (Test-Path $ConfigFile)) {
  $env:BACKEND_CONFIG = $ConfigFile
}
$ProviderEnvFile = Join-Path $VarDir '.provider-env.json'
if (Test-Path $ProviderEnvFile) {
  $pEnv = Get-Content -Raw $ProviderEnvFile | ConvertFrom-Json
  foreach ($prop in $pEnv.PSObject.Properties) {
    if (-not (Get-Item -Path "Env:$($prop.Name)" -ErrorAction SilentlyContinue)) {
      Set-Item -Path "Env:$($prop.Name)" -Value ([string]$prop.Value)
    }
  }
}

$backendProc = Start-Process -FilePath 'node' -ArgumentList 'src/main.js' -WorkingDirectory $BackendDir -NoNewWindow -PassThru

try {
  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $res = Invoke-RestMethod -Uri "$BackendUrl/health" -TimeoutSec 2
      if ($res.ok -eq $true) {
        $ready = $true
        break
      }
    } catch {
      Start-Sleep -Milliseconds 300
    }
  }
  if (-not $ready) {
    throw "Backend failed to become healthy at $BackendUrl/health"
  }

  Write-Host "[Agent_US] Backend healthy! Starting frontend on http://127.0.0.1:5173 (proxied -> $BackendUrl) ..."
  Push-Location $FrontendDir
  try {
    & npm run dev
  } finally {
    Pop-Location
  }
} finally {
  if ($backendProc -and -not $backendProc.HasExited) {
    Write-Host "[Agent_US] Stopping backend (PID $($backendProc.Id)) ..."
    Stop-Process -Id $backendProc.Id -Force -ErrorAction SilentlyContinue
  }
}
