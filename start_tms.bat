@echo off
chcp 65001 >nul
title Khởi Động Hệ Thống TMS Logistics
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_tms.ps1"
if %errorlevel% neq 0 (
    echo.
    echo [LỖI] Hệ thống gặp sự cố khi khởi động. Mã lỗi: %errorlevel%
    pause
)
