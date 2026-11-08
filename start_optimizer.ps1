param(
    [int]$Port = 8000,
    [string]$BindAddress = '0.0.0.0',
    [switch]$Check
)

$optimizerDir = Join-Path $PSScriptRoot 'optimizer'
$python = Join-Path $optimizerDir '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw 'Optimizer requires Python 3.11+ in optimizer\.venv. See README.md.'
}

Push-Location -LiteralPath $optimizerDir
try {
    & $python -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'
    if ($LASTEXITCODE -ne 0) { throw 'Recreate optimizer\.venv with Python 3.11 or later.' }
    if ($Check) {
        & $python -c 'from app.main import app; print(app.title)'
    } else {
        & $python -m uvicorn app.main:app --host $BindAddress --port $Port
    }
    if ($LASTEXITCODE -ne 0) { throw "Optimizer exited with code $LASTEXITCODE." }
} finally {
    Pop-Location
}
