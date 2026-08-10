# 合并启动：同一真实桌面会话内拉起 Vite 与 reader，避免沙箱回收
$ErrorActionPreference = 'SilentlyContinue'

# 1) 确保 Vite 就绪
$conn = Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue
if (-not $conn) {
  Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-Command','npm run dev *> E:\code\reader\reader\vite-dev.log 2>&1' -WorkingDirectory 'E:\code\reader\reader' -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(40)
  do {
    try { $null = Invoke-WebRequest -Uri 'http://localhost:1420/ui-test.html' -UseBasicParsing -TimeoutSec 2; break } catch {}
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
}

# 2) 停掉旧实例
Get-Process -Name reader -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# 3) 启动应用
Start-Process -FilePath 'E:\code\reader\reader\src-tauri\target\debug\reader.exe' -WorkingDirectory 'E:\code\reader\reader\src-tauri'
Start-Sleep -Seconds 4

$up = Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue
$reader = Get-Process -Name reader -ErrorAction SilentlyContinue
Write-Output ("vite=" + [bool]$up + " reader=" + [bool]$reader)
