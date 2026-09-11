# ========================================================================
#          HỆ THỐNG QUẢN TRỊ & ĐIỀU PHỐI VẬN TẢI (TMS LOGISTICS)
# ========================================================================
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
    $host.UI.RawUI.WindowTitle = "[TMS Logistics] Trình Quản Lý Dịch Vụ"
} catch {}

Write-Host "========================================================================" -ForegroundColor Cyan
Write-Host "       HỆ THỐNG QUẢN TRỊ & ĐIỀU PHỐI VẬN TẢI - TMS LOGISTICS            " -ForegroundColor Yellow
Write-Host "========================================================================" -ForegroundColor Cyan
Write-Host ""

$ROOT_DIR = if ($PSScriptRoot) { $PSScriptRoot } else { "e:\HocTap\Project-Logictists" }
$PORTS = @(4000, 5173, 8000)

function Stop-TMSPorts {
    foreach ($port in $PORTS) {
        try {
            $connections = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
            if ($connections) {
                $pids = $connections | Select-Object -ExpandProperty OwningProcess -Unique
                foreach ($procId in $pids) {
                    if ($procId -and $procId -ne 0 -and $procId -ne $PID) {
                        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
                        $procName = if ($proc) { $proc.ProcessName } else { "Unknown" }
                        Write-Host "  -> Cổng $port đang bị chiếm bởi [$procName] (PID: $procId). Đang ngắt..." -ForegroundColor Yellow
                        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
                    }
                }
            }
        } catch {
            $netstatOutput = netstat -ano | Select-String ":$port\s+"
            foreach ($line in $netstatOutput) {
                $parts = $line.ToString().Trim() -split '\s+'
                $pidToKill = $parts[-1]
                if ($pidToKill -and $pidToKill -match '^\d+$' -and [int]$pidToKill -ne 0 -and [int]$pidToKill -ne $PID) {
                    Write-Host "  -> Cổng $port bị chiếm bởi PID $pidToKill. Đang ngắt..." -ForegroundColor Yellow
                    taskkill /F /PID $pidToKill 2>$null
                }
            }
        }
    }
}

try {
    # ------------------------------------------------------------------------
    # BƯỚC 1: GIẢI PHÓNG CÁC CỔNG MẠNG
    # ------------------------------------------------------------------------
    Write-Host "[1/4] Đang kiểm tra và giải phóng các cổng mạng (4000, 5173, 8000)..." -ForegroundColor Cyan
    Stop-TMSPorts
    Start-Sleep -Seconds 1
    Write-Host "  [OK] Các cổng mạng đã sẵn sàng!" -ForegroundColor Green
    Write-Host ""

    # ------------------------------------------------------------------------
    # BƯỚC 2: KHỞI ĐỘNG PYTHON OPTIMIZATION ENGINE (PORT 8000)
    # ------------------------------------------------------------------------
    Write-Host "[2/4] Khởi động Python Optimization Engine (Port 8000)..." -ForegroundColor Cyan
    $optimizerCmd = "cd '$ROOT_DIR\optimizer'; `$host.UI.RawUI.WindowTitle='[TMS] Optimization Engine - Port 8000'; python -m uvicorn app.main:app --host 0.0.0.0 --port 8000"
    Start-Process powershell.exe -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", $optimizerCmd -WindowStyle Normal

    # ------------------------------------------------------------------------
    # BƯỚC 3: KHỞI ĐỘNG BACKEND NESTJS (PORT 4000)
    # ------------------------------------------------------------------------
    Write-Host "[3/4] Khởi động TMS Backend NestJS (Port 4000)..." -ForegroundColor Cyan
    $backendCmd = "cd '$ROOT_DIR\backend'; `$host.UI.RawUI.WindowTitle='[TMS] Backend API - Port 4000'; npm run start:dev"
    Start-Process powershell.exe -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", $backendCmd -WindowStyle Normal

    # ------------------------------------------------------------------------
    # BƯỚC 4: KHỞI ĐỘNG FRONTEND VITE + REACT (PORT 5173)
    # ------------------------------------------------------------------------
    Write-Host "[4/4] Khởi động TMS Frontend Vite + React (Port 5173)..." -ForegroundColor Cyan
    $frontendCmd = "cd '$ROOT_DIR\frontend'; `$host.UI.RawUI.WindowTitle='[TMS] Frontend Web - Port 5173'; npm run dev"
    Start-Process powershell.exe -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", $frontendCmd -WindowStyle Normal

    # ------------------------------------------------------------------------
    # CHỜ CÁC DỊCH VỤ KHỞI ĐỘNG
    # ------------------------------------------------------------------------
    Write-Host ""
    Write-Host "Đang kiểm tra kết nối các dịch vụ..." -ForegroundColor Yellow

    $services = @(
        @{ Name = "Python Optimizer"; Port = 8000; Ready = $false },
        @{ Name = "Backend API";     Port = 4000; Ready = $false },
        @{ Name = "Frontend Web";    Port = 5173; Ready = $false }
    )

    $maxWaitSec = 40
    $startTime = Get-Date

    while (((Get-Date) - $startTime).TotalSeconds -lt $maxWaitSec) {
        $allReady = $true
        foreach ($s in $services) {
            if (-not $s.Ready) {
                try {
                    $tcp = Test-NetConnection -ComputerName 127.0.0.1 -Port $s.Port -InformationLevel Quiet -WarningAction SilentlyContinue
                    if ($tcp) {
                        $s.Ready = $true
                        Write-Host ("`n  [OK] " + $s.Name + " (Port " + $s.Port + ") đã sẵn sàng!") -ForegroundColor Green
                    } else {
                        $allReady = $false
                    }
                } catch {
                    $allReady = $false
                }
            }
        }

        if ($allReady) {
            break
        }
        Write-Host -NoNewline "."
        Start-Sleep -Seconds 1
    }

    Write-Host ""
    Write-Host ""
    Write-Host "========================================================================" -ForegroundColor Green
    Write-Host "       TẤT CẢ CÁC DỊCH VỤ ĐÃ KHỞI ĐỘNG THÀNH CÔNG!                      " -ForegroundColor Green
    Write-Host "========================================================================" -ForegroundColor Green
    Write-Host "  - Frontend:   http://localhost:5173" -ForegroundColor White
    Write-Host "  - Backend:    http://localhost:4000" -ForegroundColor White
    Write-Host "  - Optimizer:  http://localhost:8000" -ForegroundColor White
    Write-Host "========================================================================" -ForegroundColor Green
    Write-Host "Đang tự động mở trình duyệt..." -ForegroundColor Cyan

    Start-Process "http://localhost:5173"

    Write-Host ""
    Write-Host "Hệ thống đang hoạt động trong các cửa sổ riêng biệt." -ForegroundColor Green
    Write-Host "Nhấn [Q] tại đây để tắt toàn bộ hệ thống khi làm việc xong." -ForegroundColor Yellow
    Write-Host "========================================================================" -ForegroundColor Cyan

    while ($true) {
        try {
            if (-not [Console]::IsInputRedirected -and [Console]::KeyAvailable) {
                $key = [Console]::ReadKey($true)
                if ($key.Key -eq [ConsoleKey]::Q) {
                    Write-Host ""
                    Write-Host "Đang dừng các cổng mạng và dịch vụ TMS..." -ForegroundColor Yellow
                    Stop-TMSPorts
                    Write-Host "Đã dừng toàn bộ dịch vụ! Tạm biệt." -ForegroundColor Green
                    Start-Sleep -Seconds 2
                    break
                }
            }
        } catch {}
        Start-Sleep -Milliseconds 500
    }

} catch {
    Write-Host ""
    Write-Host "[LỖI KHỞI ĐỘNG] $_" -ForegroundColor Red
    Write-Host "Chi tiết lỗi:" -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor Red
    Write-Host ""
    Write-Host "Nhấn phím bất kỳ để đóng cửa sổ..." -ForegroundColor Yellow
    try {
        if (-not [Console]::IsInputRedirected) {
            $null = [Console]::ReadKey($true)
        } else {
            Start-Sleep -Seconds 10
        }
    } catch {
        Start-Sleep -Seconds 10
    }
}
