# 测试指南

> 三种验证路径：浏览器 mock、前端编译、真实窗口 + CDP。先选最轻的，能覆盖问题即可。

## 1. 浏览器 mock 预览（布局/交互走查）

```powershell
pnpm dev
```

打开 `http://localhost:1420/ui-test.html`。该页先注入 `scripts/ui-mock.js`（模拟 Tauri 的 fs / store / dialog / window 等 API），再加载 `/src/main.js`；内置虚拟磁盘 `F:\\` 与 `scripts/testbook*.cbz` / `scripts/testbook.epub` 作为测试书。库索引相关命令（`get_favorites` / `sync_favorite` / `list_items` / `library_meta`）也有一份内存实现，因此「扫描 → 落库 → 读行建视图」的 Home 全链路可以在浏览器里跑通。

适合：布局、主题、列表/卡片交互、路由与返回栈、Home/收藏页的数据链路。
不适合：真实文件系统、SQLite、mpv、Android 系统栏。

## 2. 前端编译验证

```powershell
pnpm exec vite build
```

只验证打包是否通过（模板/语法/引用错误）。`npm` 包装脚本在部分沙箱下有坑，直接用 `pnpm exec vite build` 最稳。

## 3. 真实窗口 + CDP 驱动（交互/状态类 bug 主路径）

```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev-launch.ps1
```

脚本行为：

1. 预检并清理残留 dev 进程链（tauri.js / vite / cargo / reader.exe）。
2. 若 `tauri.conf.json` 没有 `additionalBrowserArgs`，临时注入 `--remote-debugging-port=9222 --remote-allow-origins=*` 并备份原文件。
3. 启动 `pnpm tauri dev`，日志写入 `tauri-dev.log`（旧日志改名 `.old`）。
4. 退出后按字节还原配置；被强杀时下次运行开头自愈还原。

启动后可用：

```powershell
node scripts/cdp-shot.mjs      # 逐视图截图
node scripts/verify-dom.mjs    # DOM 断言
```

`scripts/lib-cdp.mjs` 是公共 CDP 模块，Chrome 路径优先读 `CHROME_PATH` 环境变量。

## 坑清单

- `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 环境变量在本项目无效（wry 显式覆盖），只有 `tauri.conf.json` 的 `additionalBrowserArgs` 生效——所以必须走 `scripts/dev-launch.ps1`，不要手工把调试端口写回配置。
- `vite.config.js` 的 `server.strictPort = true`：1420 被旧 `pnpm dev` 占住时，`tauri dev` 起不来。用 `Get-NetTCPConnection -LocalPort 1420 -State Listen` 查，`taskkill /PID <pid> /T /F` 清。
- `tauri-dev.log` 被残留进程占用时，先改名再启动。
- Windows 视频链路需要 `libmpv-2.dll`（运行时找 exe 同目录；本地开发放在 `src-tauri/libmpv-2.dll`，debug 构建会回退到该路径）；没有 DLL 时视频命令报错，`cargo test` 中相关用例会跳过。
- `pnpm.ps1` 若被执行策略拦截，改用 `pnpm.cmd` 或 `corepack enable`。

## 测试书与夹具

| 文件 | 用途 |
|---|---|
| `scripts/testbook.cbz` / `testbook2.cbz` / `testbook3.cbz` | 漫画（CBZ）阅读与列表 |
| `scripts/testbook.epub` | EPUB 阅读与目录 |
| `scripts/art-pack.png` / `art-cover.png` | 图包/封面 mock 数据 |

`scripts/_*.mjs` 为本地临时脚本，已被 `.gitignore` 忽略，不属于仓库测试资产。
