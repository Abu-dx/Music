param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectDir,

  [Parameter(Mandatory = $true)]
  [string]$LogPath,

  [string]$SourceRoot = ""
)

$ErrorActionPreference = "Stop"
$script:Failures = @()

if (-not $SourceRoot -or $SourceRoot.Trim().Length -eq 0) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $SourceRoot = (Resolve-Path (Join-Path $scriptDir "..\\..")).Path
}

function Add-Failure {
  param([string]$Message)
  $script:Failures += $Message
  Write-Host "[FAIL] $Message" -ForegroundColor Red
}

function Assert-True {
  param(
    [bool]$Condition,
    [string]$PassMessage,
    [string]$FailMessage
  )
  if ($Condition) {
    Write-Host "[PASS] $PassMessage" -ForegroundColor Green
  } else {
    Add-Failure $FailMessage
  }
}

function Read-TextFile {
  param([string]$Path)
  if (-not (Test-Path $Path)) {
    Add-Failure "file not found: $Path"
    return ""
  }
  return Get-Content -Path $Path -Raw -Encoding UTF8
}

Write-Host "=== Phase 2 Gate Smoke Check ==="
Write-Host "ProjectDir: $ProjectDir"
Write-Host "LogPath:    $LogPath"
Write-Host "SourceRoot: $SourceRoot"

# -----------------------------------------------------------------------------
# Scenario A: main -> pilot -> restart consistency (manifest + log signals)
# -----------------------------------------------------------------------------
$manifestPath = Join-Path $ProjectDir "manifest.json"
$manifestRaw = Read-TextFile -Path $manifestPath
$manifest = $null
if ($manifestRaw.Length -gt 0) {
  try {
    $manifest = $manifestRaw | ConvertFrom-Json
  } catch {
    Add-Failure "manifest parse failed: $manifestPath"
  }
}

if ($manifest -ne $null) {
  $activeResultId = [string]$manifest.activeResultId
  $resultSets = @($manifest.resultSets)
  $stems = @($manifest.stems)

  $hasMainResultSet = ($resultSets | Where-Object { [string]$_.id -eq "main" }).Count -gt 0
  $pilotResultSets = @($resultSets | Where-Object { [string]$_.id -like "pilot_6s_*" })
  $pilotResultIds = @($pilotResultSets | ForEach-Object { [string]$_.id })

  Assert-True ($activeResultId -eq "main") `
    "manifest activeResultId is main" `
    "manifest activeResultId should be main, actual='$activeResultId'"

  Assert-True $hasMainResultSet `
    "manifest contains main result set" `
    "manifest missing main result set"

  Assert-True ($pilotResultSets.Count -gt 0) `
    "manifest contains pilot_6s_* result set" `
    "manifest missing pilot_6s_* result set"

  $mainStems = @($stems | Where-Object {
      $parent = [string]$_.parentResultId
      $parent.Trim().Length -eq 0 -or $parent -eq "main"
    })
  $pilotStems = @($stems | Where-Object {
      $parent = [string]$_.parentResultId
      $pilotResultIds -contains $parent
    })

  Assert-True ($mainStems.Count -gt 0) `
    "manifest has stems for main" `
    "manifest has no stems for main"

  Assert-True ($pilotStems.Count -gt 0) `
    "manifest has stems for pilot result sets" `
    "manifest has no stems for pilot result sets"

  $invalidMainRelativePath = @($mainStems | Where-Object {
      $relative = [string]$_.relativePath
      $relative -notlike "results/main/stems/*"
    })
  Assert-True ($invalidMainRelativePath.Count -eq 0) `
    "main stems relativePath are scoped to results/main/stems/" `
    "found main stems with invalid relativePath (not results/main/stems/*)"

  $invalidPilotRelativePath = @($pilotStems | Where-Object {
      $parent = [string]$_.parentResultId
      $relative = [string]$_.relativePath
      $relative -notlike "results/$parent/stems/*"
    })
  Assert-True ($invalidPilotRelativePath.Count -eq 0) `
    "pilot stems relativePath are scoped to results/<pilot>/stems/" `
    "found pilot stems with invalid relativePath (not results/<pilot>/stems/*)"
}

$logText = Read-TextFile -Path $LogPath
Assert-True ($logText -match "handlers\.project:getResult active_context") `
  "restart/read path emits active_context log" `
  "missing active_context log after reopen/read"
Assert-True ($logText -match 'activeResolved="main"') `
  "active result resolved to main in logs" `
  'missing activeResolved="main" log for restart consistency'

# -----------------------------------------------------------------------------
# Scenario B: missing source path must fail explicitly
# -----------------------------------------------------------------------------
Assert-True ($logText -match "PILOT_SOURCE_PATH_REQUIRED") `
  "missing source path error is explicit (PILOT_SOURCE_PATH_REQUIRED)" `
  "missing explicit PILOT_SOURCE_PATH_REQUIRED error in logs"

# -----------------------------------------------------------------------------
# Scenario C: pilot missing dependency must expose module name
# -----------------------------------------------------------------------------
$hasMissingModuleSignal = ($logText -match "required_modules_missing:") -or ($logText -match "ModuleNotFoundError:\s+No module named")
Assert-True $hasMissingModuleSignal `
  "pilot runtime missing-module signal is present in logs" `
  "missing required_modules_missing / ModuleNotFoundError signal in logs"

$hasDemucsModuleSignal = ($logText -match "required_modules_missing:.*demucs") -or ($logText -match "No module named 'demucs'")
Assert-True $hasDemucsModuleSignal `
  "missing module name is diagnosable (demucs)" `
  "missing module name 'demucs' not found in logs"

# -----------------------------------------------------------------------------
# Scenario D: failed project re-enter should recover (source guards)
# -----------------------------------------------------------------------------
$homePagePath = Join-Path $SourceRoot "src\\renderer\\pages\\HomePage.tsx"
$progressPagePath = Join-Path $SourceRoot "src\\renderer\\pages\\ProgressPage.tsx"
$resultPagePath = Join-Path $SourceRoot "src\\renderer\\pages\\ResultPage.tsx"
$handlersPath = Join-Path $SourceRoot "src\\app\\main\\ipc\\handlers.ts"

$homeCode = Read-TextFile -Path $homePagePath
$progressCode = Read-TextFile -Path $progressPagePath
$resultCode = Read-TextFile -Path $resultPagePath
$handlersCode = Read-TextFile -Path $handlersPath

Assert-True ($homeCode -match "await store\.loadProject\(project\.id\)") `
  "HomePage refreshes project status before routing" `
  "HomePage missing pre-route status refresh"
Assert-True ($homeCode -match "if \(latestStatus === 'processing'\)") `
  "HomePage routes to ProgressPage only when latest status is processing" `
  "HomePage routing guard for processing status is missing"

Assert-True ($progressCode -match "shouldRecoverFromIdle && hasReadableResult") `
  "ProgressPage recovers to ResultPage for ended non-running projects with readable results" `
  "ProgressPage missing idle->result recovery guard"
Assert-True ($progressCode -match "shouldRecoverFromIdle && !hasReadableResult") `
  "ProgressPage shows explicit non-running failure/recover block when no readable result exists" `
  "ProgressPage missing explicit no-readable-result recovery block"

Assert-True ($resultCode -match "showFailedNoReadableResult") `
  "ResultPage has explicit failed+no-readable-result state gate" `
  "ResultPage missing failed+no-readable-result state gate"
Assert-True ($resultCode -match "failedResultTitle") `
  "ResultPage renders explicit failed-state block" `
  "ResultPage missing explicit failed-state block"

Assert-True ($handlersCode -match "handlers\.export:stems active_gate") `
  "main-side export active gate log is present" `
  "handlers export active gate log marker is missing"
Assert-True ($handlersCode -match "filterStemsForResultSet\(allStems, activeResultId\)") `
  "main-side export filters stems by activeResultId" `
  "handlers export path missing activeResultId stem filter"

Write-Host ""
if ($script:Failures.Count -gt 0) {
  Write-Host "=== SUMMARY: FAILED ($($script:Failures.Count)) ===" -ForegroundColor Red
  $script:Failures | ForEach-Object { Write-Host " - $_" -ForegroundColor Red }
  exit 1
}

Write-Host "=== SUMMARY: PASSED ===" -ForegroundColor Green
exit 0
