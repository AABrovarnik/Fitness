param(
  [string]$BaseUrl = "http://localhost:3010"
)

$ErrorActionPreference = "Stop"

$checks = @(
  @{ Name = "health"; Path = "/health"; Validate = { param($body) $body -match '"ok"\s*:\s*true' } },
  @{ Name = "home"; Path = "/"; Validate = { param($body) $body.Length -gt 0 } },
  @{ Name = "offers"; Path = "/offers"; Validate = { param($body) $body -match "/offers" } },
  @{ Name = "trainers"; Path = "/trainers"; Validate = { param($body) $body -match "/trainers" } },
  @{ Name = "schedule"; Path = "/schedule"; Validate = { param($body) $body -match "/schedule" } }
)

$failed = @()

foreach ($check in $checks) {
  $url = "$BaseUrl$($check.Path)"
  try {
    $resp = Invoke-WebRequest -Uri $url -TimeoutSec 10
    if ($resp.StatusCode -ne 200) {
      $failed += "[$($check.Name)] HTTP $($resp.StatusCode)"
      continue
    }

    $isValid = & $check.Validate $resp.Content
    if (-not $isValid) {
      $failed += "[$($check.Name)] content validation failed"
      continue
    }

    Write-Host "PASS  $($check.Name)  $url"
  }
  catch {
    $failed += "[$($check.Name)] $($_.Exception.Message)"
  }
}

if ($failed.Count -gt 0) {
  Write-Host "\nSMOKE RESULT: FAIL" -ForegroundColor Red
  $failed | ForEach-Object { Write-Host " - $_" -ForegroundColor Red }
  exit 1
}

Write-Host "\nSMOKE RESULT: PASS" -ForegroundColor Green
exit 0
