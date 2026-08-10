# Tauri dev 启动脚本（供 Codex 提权运行；批准 prefix_rule 后可反复使用）
# 幂等：dev 服务器 + reader 已在运行则直接跳过，避免重复实例占端口
$env:READER_TEST_FILE = ""
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"

$listening = Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue
$reader = Get-Process -Name reader -ErrorAction SilentlyContinue
if ($listening -and $reader) {
  Write-Output 'already running'
  exit 0
}

Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-Command','npm run tauri dev *> E:\code\reader\reader\tauri-dev.log 2>&1' -WorkingDirectory 'E:\code\reader\reader' -WindowStyle Hidden
Write-Output 'launched'