param(
    [switch]$Stop,
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$taskRoot = $PSScriptRoot
$taskEnv = Join-Path $taskRoot 'backend/.env'
$taskCompose = Join-Path $taskRoot 'compose.yaml'
$taskComposeArgs = @('compose', '--env-file', $taskEnv, '-f', $taskCompose)

try {
    if (-not (Test-Path -LiteralPath $taskEnv)) { throw 'Missing backend/.env: this is the main configuration file.' }
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Install and open Docker Desktop first.' }
    docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Docker Engine is not ready. Open Docker Desktop and try again.' }

    if ($Stop) {
        & docker @taskComposeArgs stop frontend backend optimizer redis
        if ($LASTEXITCODE -ne 0) { throw 'Could not stop all services.' }
        Write-Host 'Main services stopped. Containers and data are preserved.' -ForegroundColor Green
        exit 0
    }

    $taskPublicToken = Get-Content -LiteralPath $taskEnv | Where-Object { $_ -match '^VITE_MAPBOX_TOKEN\s*=' } | Select-Object -First 1
    if ($taskPublicToken -match '=\s*["'']?sk\.') { throw 'VITE_MAPBOX_TOKEN must be a public pk. token. Never expose an sk. token in the frontend.' }
    & docker @taskComposeArgs config --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Invalid compose.yaml or backend/.env configuration.' }

    Write-Host 'Starting main application: project-logictists in Docker Desktop.' -ForegroundColor Cyan
    $taskPreviousParallel = $env:COMPOSE_PARALLEL_LIMIT
    try {
        $env:COMPOSE_PARALLEL_LIMIT = '1'
        & docker @taskComposeArgs build backend frontend optimizer
        if ($LASTEXITCODE -ne 0) { throw 'Build failed. See the error above. No migration or seed was run.' }
        & docker @taskComposeArgs up -d --wait --wait-timeout 180 frontend backend optimizer redis
        if ($LASTEXITCODE -ne 0) { throw 'A service is not ready. Check docker compose logs as described in README.' }
    } finally {
        $env:COMPOSE_PARALLEL_LIMIT = $taskPreviousParallel
    }
    & docker @taskComposeArgs ps
    Write-Host 'Main web: http://localhost:5173' -ForegroundColor Green
    Write-Host 'Configuration: backend/.env. No automatic migration or test-account seed.'
    Write-Host 'Stop: powershell -ExecutionPolicy Bypass -File .\start_tms.ps1 -Stop'
    if (-not $NoBrowser) { Start-Process 'http://localhost:5173' }
} catch {
    Write-Host ('Error: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
