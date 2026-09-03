# Tauri dev 启动脚本（幂等版，供提权运行；批准后可直接使用）
# 作用：临时把 WebView2 调试参数注入 tauri.conf.json → 启动 tauri dev → 退出后自动还原。
#
# 为什么必须这样注入：
#   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 环境变量在本项目无效——wry 0.53.3 总是显式
#   set_additional_browser_arguments（默认 --disable-features=...），按 WebView2 优先级
#   「应用显式 options > 环境变量」覆盖掉环境变量。只有 tauri.conf.json 里
#   app.windows[].additionalBrowserArgs 才会在编译期生效（调试端口 9222 可用）。
#
# 实现要点（两个真实踩坑，缺一不可）：
#   1) 备份/还原/注入一律用 [IO.File]::WriteAllText，绝不 Copy-Item 配置文件：
#      实测在本机沙箱下，Copy-Item 配置文件后再 WriteAllText，写入会被静默丢弃
#      （连同进程读回都看不到），表现为"注入总是不生效/被还原"。
#   2) 启动前预检杀掉残留 tauri dev 进程树（tauri.js / vite / cargo / reader.exe）：
#      旧链的 watcher 会在配置变更时重建/回写，造成同样的"配置被还原"假象。
#
# 行为：
#   - 预检清理残留 dev 链（按项目特征命令行匹配，不影响 DSH 宿主自身的 node 进程）。
#   - 幂等：reader.exe 已运行且 1420 已监听（健康会话）→ 跳过。
#   - 注入前备份为 tauri.conf.json.inject-backup；tauri dev 退出后自动还原（byte-identical）；
#     脚本被强杀（taskkill /F）时残留备份会在下一次运行开头自动还原（自愈）。
#   - 日志写到 tauri-dev.log（惯例），旧日志自动改名 tauri-dev.log.old。
#
# 停止方式：taskkill /PID <启动时打印的隐藏 powershell pid> /T /F，
# 脚本检测到子进程退出 → 自动还原配置 → 结束。

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$conf = Join-Path $root 'src-tauri\tauri.conf.json'
$backup = "$conf.inject-backup"
$debugArgs = '--remote-debugging-port=9222 --remote-allow-origins=*'

function Restore-Config {
  if (Test-Path $backup) {
    [System.IO.File]::WriteAllText($conf, [System.IO.File]::ReadAllText($backup))
    Remove-Item $backup -Force
    Write-Output "restored: $conf"
  }
}

# 匹配本项目 tauri dev 链的特征命令行（旧链残留检测/清理用）
function Get-DevChainProcesses {
  $patterns = 'tauri\.js|node_modules\\vite\\bin\\vite|target\\debug\\reader|reader\.exe|cargo\s+run|npm-cli\.js.{0,60}run tauri'
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match $patterns }
}

# 0) 自愈：上次强杀残留的备份先还原
Restore-Config

# 1) 幂等检查：健康会话（vite:1420 + reader.exe）在跑就直接跳过
$listening = Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$reader = Get-Process -Name reader -ErrorAction SilentlyContinue
if ($listening -and $reader) {
  Write-Output 'already running (vite:1420 + reader.exe) — skip'
  exit 0
}

# 2) 预检清理：杀掉残留 dev 链（旧 tauri dev 的 watcher 会回写配置、反复重建）
$stale = Get-DevChainProcesses
foreach ($p in $stale) {
  taskkill /PID $p.ProcessId /T /F 2>&1 | Out-Null
  Write-Output "killed stale dev-chain process: $($p.Name)($($p.ProcessId))"
}
Get-Process -Name reader -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800

# 3) 注入调试参数（字符串级替换；备份/写入都用 WriteAllText，不用 Copy-Item）
$injected = $false
$content = [System.IO.File]::ReadAllText($conf)
if ($content -match 'additionalBrowserArgs') {
  Write-Output 'tauri.conf.json already has additionalBrowserArgs — keep as-is (will not auto-remove)'
} else {
  [System.IO.File]::WriteAllText($backup, $content)
  $injected = $true
  $indent = '        '
  $insert = "$indent`"additionalBrowserArgs`": `"$debugArgs`","
  $replacement = '$1' + [Environment]::NewLine + $insert
  $new = $content -replace '("windows"\s*:\s*\[\s*\{)', $replacement
  if ($new -ceq $content) { throw 'injection pattern did not match tauri.conf.json' }
  $null = $new | ConvertFrom-Json   # 注入后校验 JSON 合法性
  [System.IO.File]::WriteAllText($conf, $new)
  Write-Output "injected debug args -> $conf"
}

# 4) 启动 tauri dev（隐藏 powershell + 日志重定向），阻塞等待退出后自动还原
$env:READER_TEST_FILE = ''
try {
  $log = Join-Path $root 'tauri-dev.log'
  if (Test-Path $log) {
    $stale = "$log.old"
    if (Test-Path $stale) { Remove-Item $stale -Force }
    Rename-Item $log $stale -Force -ErrorAction SilentlyContinue
  }
  $cmd = "npm run tauri dev *> '$log' 2>&1"
  $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', $cmd) -WorkingDirectory $root -WindowStyle Hidden -PassThru
  Write-Output "tauri dev launched (pid $($proc.Id)); waiting for exit..."
  $proc.WaitForExit()
  Write-Output 'tauri dev exited'
} finally {
  if ($injected) { Restore-Config }
}
