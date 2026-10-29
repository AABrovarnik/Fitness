param(
  [int]$Port = 3010,
  [string]$BaseUrl = "http://localhost:3010",
  [switch]$SkipInstall,
  [switch]$SkipBuild,
  [switch]$SkipSeed,
  [switch]$SkipSmoke
)

$ErrorActionPreference = "Stop"

function Invoke-Step {
  param(
    [string]$Title,
    [scriptblock]$Action
  )

  Write-Host "==> $Title"
  & $Action
}

function Wait-Health {
  param(
    [string]$Url,
    [int]$Attempts = 15
  )

  for ($i = 1; $i -le $Attempts; $i++) {
    try {
      $resp = Invoke-WebRequest -Uri "$Url/health" -TimeoutSec 3
      if ($resp.StatusCode -eq 200 -and $resp.Content -match '"ok"\s*:\s*true') {
        return $true
      }
    }
    catch {
      Start-Sleep -Seconds 1
    }
  }

  return $false
}

Invoke-Step -Title "Остановка процесса на порту $Port (если запущен)" -Action {
  $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($listeners) {
    $pids = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($pid in $pids) {
      Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
      Write-Host "Stopped PID $pid"
    }
  }
  else {
    Write-Host "Нет активного слушателя на порту $Port"
  }
}

if (-not $SkipInstall) {
  Invoke-Step -Title "npm install" -Action {
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
  }
}

if (-not $SkipBuild) {
  Invoke-Step -Title "npm run build" -Action {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
  }
}

if (-not $SkipSeed) {
  Invoke-Step -Title "seed базы" -Action {
    node dist/src/db/seed.js
    if ($LASTEXITCODE -ne 0) { throw "seed failed" }
  }
}

Invoke-Step -Title "Запуск сервера" -Action {
  Start-Process -FilePath powershell -ArgumentList '-NoProfile','-Command',"`$env:PORT='$Port'; node dist/src/server.js" -WorkingDirectory (Get-Location).Path -WindowStyle Hidden
}

Invoke-Step -Title "Проверка /health" -Action {
  if (-not (Wait-Health -Url $BaseUrl)) {
    throw "Сервер не поднялся на $BaseUrl"
  }
  Write-Host "Health OK: $BaseUrl/health"
}

if (-not $SkipSmoke) {
  Invoke-Step -Title "Smoke-прогон" -Action {
    powershell -ExecutionPolicy Bypass -File .\scripts\sandbox-smoke.ps1 -BaseUrl $BaseUrl
    if ($LASTEXITCODE -ne 0) { throw "Smoke failed" }
  }
}

Write-Host "`nSandbox reset completed." -ForegroundColor Green

