@echo off
chcp 65001 >nul
title Khởi Động Hệ Thống TMS Logistics
cd /d "%~dp0"
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8000 " ^| findstr "LISTENING"') do taskkill /F /T /PID %%a >nul 2>&1
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and ($_.CommandLine -like '*uvicorn*app.main:app*' -or $_.CommandLine -like '*Project-Logictists*optimizer*') } | ForEach-Object { taskkill /F /T /PID $_.ProcessId 2>$null }" >nul 2>&1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_tms.ps1"
if %errorlevel% neq 0 (
    echo.
    echo [LỖI] Hệ thống gặp sự cố khi khởi động. Mã lỗi: %errorlevel%
    pause
)
