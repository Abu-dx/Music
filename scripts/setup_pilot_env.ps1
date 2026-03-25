param(
  [string]$PythonCmd = "python",
  [switch]$Recreate
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-Step {
  param(
    [string]$Title,
    [scriptblock]$Action
  )
  Write-Host "==> $Title"
  & $Action
}

try {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $repoRoot = (Resolve-Path (Join-Path $scriptDir "..")).Path
  $venvDir = Join-Path $repoRoot ".venv_pilot"
  $requirementsPath = Join-Path $repoRoot "python\\requirements.txt"

  if (-not (Test-Path $requirementsPath)) {
    throw "requirements not found: $requirementsPath"
  }

  if ($Recreate -and (Test-Path $venvDir)) {
    Write-Host "==> Removing existing pilot env: $venvDir"
    Remove-Item -Recurse -Force $venvDir
  }

  if (-not (Test-Path $venvDir)) {
    Invoke-Step "Create .venv_pilot" {
      & $PythonCmd -m venv $venvDir
      if ($LASTEXITCODE -ne 0) {
        throw "failed to create venv with '$PythonCmd'"
      }
    }
  } else {
    Write-Host "==> Reuse existing env: $venvDir"
  }

  $venvPython = Join-Path $venvDir "Scripts\\python.exe"
  if (-not (Test-Path $venvPython)) {
    throw "venv python not found: $venvPython"
  }

  Invoke-Step "Upgrade pip" {
    & $venvPython -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) {
      throw "pip upgrade failed"
    }
  }

  Invoke-Step "Install python/requirements.txt" {
    & $venvPython -m pip install -r $requirementsPath
    if ($LASTEXITCODE -ne 0) {
      throw "requirements install failed"
    }
  }

  Invoke-Step "Health check: import demucs" {
    & $venvPython -c "import demucs; print(getattr(demucs, '__version__', 'unknown'))"
    if ($LASTEXITCODE -ne 0) {
      throw "demucs import health check failed"
    }
  }

  Write-Host ""
  Write-Host "[SUCCESS] pilot env is ready."
  Write-Host "  DEMUCS_6S_PILOT_ENV_ROOT=$venvDir"
  Write-Host "  DEMUCS_6S_PILOT_PYTHON_EXE=$venvPython"
  exit 0
} catch {
  Write-Host ""
  Write-Host "[FAILED] setup_pilot_env.ps1" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
