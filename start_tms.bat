@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_tms.ps1" %*
if errorlevel 1 (
    echo.
    echo Khoi dong that bai. Xem thong bao loi phia tren.
    pause
)
