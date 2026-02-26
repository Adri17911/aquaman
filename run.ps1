# Aquarium Automation - All-in-one startup script
# Run from Backend 3.0 folder: .\run.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

Write-Host "=== Aqua Backend - Setup & Run ===" -ForegroundColor Cyan

# 1. Install Python dependencies
Write-Host "`n[1/3] Checking Python dependencies..." -ForegroundColor Yellow
& py -m pip install -q -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }
Write-Host "  OK" -ForegroundColor Green

# 2. Build frontend
Write-Host "`n[2/3] Building frontend..." -ForegroundColor Yellow
Push-Location (Join-Path $Root "frontend")
if (-not (Test-Path "node_modules")) {
    Write-Host "  Installing npm packages..."
    npm install
}
npm run build
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "npm run build failed" }
Pop-Location
Write-Host "  OK" -ForegroundColor Green

# 3. Start backend
Write-Host "`n[3/3] Starting backend on http://0.0.0.0:8080" -ForegroundColor Yellow
Write-Host "  Press Ctrl+C to stop`n" -ForegroundColor Gray
& py -m uvicorn main:app --host 0.0.0.0 --port 8080
