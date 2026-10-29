param(
  [string]$EnvFile = ".env"
)

$ErrorActionPreference = "Stop"
$errors = @()

function Add-ErrorMessage {
  param([string]$Message)
  $script:errors += $Message
}

Write-Host "==> Sandbox preflight"

try {
  $nodeVersion = (node -v).Trim()
  Write-Host "Node: $nodeVersion"
}
catch {
  Add-ErrorMessage "Node.js not found in PATH"
}

try {
  $npmVersion = (npm -v).Trim()
  Write-Host "npm: $npmVersion"
}
catch {
  Add-ErrorMessage "npm not found in PATH"
}

$requiredFiles = @(
  "package.json",
  "tsconfig.json",
  "src/server.ts",
  "src/db/db.ts",
  "src/db/seed.ts",
  "scripts/sandbox-reset.ps1",
  "scripts/sandbox-smoke.ps1"
)

foreach ($file in $requiredFiles) {
  if (-not (Test-Path $file)) {
    Add-ErrorMessage "Required file is missing: $file"
  }
}

if (-not (Test-Path $EnvFile)) {
  Add-ErrorMessage "Environment file is missing: $EnvFile"
}
else {
  $content = Get-Content $EnvFile -Raw
  $requiredKeys = @("PORT", "DB_PATH", "SESSION_SECRET", "CLUB_TIMEZONE")
  foreach ($key in $requiredKeys) {
    if ($content -notmatch "(?m)^$key=") {
      Add-ErrorMessage "Missing env key in ${EnvFile}: $key"
    }
  }
}

if ($errors.Count -gt 0) {
  Write-Host "`nPREFLIGHT RESULT: FAIL" -ForegroundColor Red
  $errors | ForEach-Object { Write-Host " - $_" -ForegroundColor Red }
  exit 1
}

Write-Host "`nPREFLIGHT RESULT: PASS" -ForegroundColor Green
exit 0
