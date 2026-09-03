# Tauri + Vue 3

根据自己需求，通过 tauri 与 vue 开发的桌面端与移动端通用的本地漫画与电子书阅读器

目前支持 cbz, zip, epub, mobi

## 设计系统

- 图标：统一使用 Lucide 线性图标（见 `src/components/Icon.vue`），界面不使用表情符号。
- 主题令牌：`src/assets/global.css` 定义了 `--bg-*`、`--text-*`、`--accent` 等 CSS 变量，`theme-light` / `theme-dark` 类驱动深色/浅色。
- 字体：`TangHan` 衬线字体用于展示标题，正文使用系统字体栈。

## UI 浏览器预览（开发调试）

不启动 Tauri 也能在浏览器里预览/调试界面：

1. `npm run dev` 启动 Vite（端口 1420）。
2. 打开 `http://localhost:1420/ui-test.html`。

`ui-test.html` 会先注入 `scripts/ui-mock.js`（模拟 Tauri 的 fs / store / dialog / window 等 API），
再加载应用本体；内置了 `scripts/testbook*.cbz` 与 `scripts/testbook.epub` 作为测试书籍，
可在书架、文件浏览、阅读三种视图之间完整走查 UI。`README` 与截图仅供调试，不会影响打包产物。

## 启动 Tauri 窗口（开发调试）

桌面窗口测试直接运行：

```powershell
npm run tauri dev *> tauri-dev.log 2>&1
```

窗口加载 `http://localhost:1420`。如果日志里 Vite 已就绪、Cargo 也编译完成，但窗口始终不出现，按下面的问题排查。

### 残留 Vite 占住 1420 端口

`vite.config.js` 里 `server.strictPort` 为 `true`，所以只要之前有独立的 `npm run dev`（例如浏览器预览）没有退出，新的 `tauri dev` 就绑不上 1420，窗口不会弹出。

排查：

```powershell
Get-NetTCPConnection -LocalPort 1420 -State Listen
```

释放端口：

```powershell
$conn = Get-NetTCPConnection -LocalPort 1420 -State Listen
if ($conn) { taskkill /PID $conn.OwningProcess /T /F }
```

### tauri-dev.log 被占用

启动时若提示 `The process cannot access the file ... tauri-dev.log`，说明有残留进程仍握着日志句柄。把旧日志改名或删除后再启动：

```powershell
Rename-Item tauri-dev.log tauri-dev.log.old
```

### 推荐流程

1. 结束占住 1420 端口的残留进程树。
2. 释放被占用的 `tauri-dev.log`（改名或删除）。
3. 重新执行 `npm run tauri dev *> tauri-dev.log 2>&1`。
4. 看到 `Running target\debug\reader.exe` 后，主窗口应已显示。

## 给 Agent / 新开发者的入口

- **项目结构速览**（组件职责 / 路由 / 数据流 / 关键坑）：**[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — 新会话第一份该读的文件。
- **测试指南**（三种路径 / CDP 驱动 / 踩坑清单 / 测试书选择）：**[`docs/TESTING.md`](docs/TESTING.md)**。

## 自动化测试（CDP 驱动真实窗口）

完整指南（三种路径、标准流程、全部踩坑与脚本用法）见 **[`docs/TESTING.md`](docs/TESTING.md)**，速览：

- **浏览器 mock 预览**（布局走查）：`npm run dev` → `http://localhost:1420/ui-test.html`（`scripts/ui-mock.js` 模拟 Tauri API + `scripts/testbook*.cbz` 测试书）。
- **编译验证**：`node node_modules/vite/bin/vite.js build`（沙箱下 `npm` 包装脚本有坑，绕过方式见指南）。
- **真实窗口 + CDP 驱动**（交互/状态类 bug 主路径，滑块修复即用此验证）：启动前临时在 `src-tauri/tauri.conf.json` 的 `app.windows[0]` 加 `"additionalBrowserArgs": "--remote-debugging-port=9222 --remote-allow-origins=*"`，然后 `node node_modules/@tauri-apps/cli/tauri.js dev`，用 `scripts/cdp-drive.mjs` / `cdp-verify.mjs` 驱动与断言。

> ⚠️ **两个必记的坑**：① `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 环境变量在本项目**无效**（wry 显式覆盖），只有 `tauri.conf.json` 的 `additionalBrowserArgs` 生效；② 该配置**测试后必须还原**，否则 release 包会带调试端口。

## 待实现

- 设置功能（设置页）就绪后，把侧边栏头像旁名字的进出动画做成用户可选，已有两套方案待接入：

  1. 淡入淡出 + 小幅靠拢：名字固定在头像右侧，收起/展开时 opacity 淡入淡出，并 translateX(-8px) 轻靠头像边缘。
  2. 宽度展开式：名字固定在头像右侧，容器宽度从 0 过渡到文字实际宽度，文字从头像右侧“长出来/缩回去”（当前 `src/components/LayOut.vue` 采用的方案）。

## 待完善缺口

> 封面缓存已统一迁到 `app_data_dir/cover-cache`，启动时会清理旧的 `resource/data`；测试计时 `timing.json` 也不再写入项目目录。以下仍是未处理项：

- 封面缓存没有容量上限与淘汰机制，目前只有 `clearLoadDate` 全量清空。
- 删书入口已覆盖主界面、收藏页、文件浏览页、影视图集列表与播放器播放列表：右键/长按菜单统一走 `useItemActions`（`fsRemove` 删源文件 + `deleteFileData` 清封面缓存 + 收藏夹重扫 SQLite），未走 `loadBooks.js` 的 `deleteBook`。
- Store 防爆未做：`loadBooks.js` 每个 action 都 `Store.load` 后立即 `set + save`，没有启动单次加载、debounce/批量写盘，也未引入 SQLite。
- 目录扫描已有持久化索引（`items.mtime` + `read_dir_meta`）：`scanFavoriteTree` 先比对根目录/子目录 mtime，未变的子树直接从 SQLite 行重建（零深层 readDir），变更分支才增量重扫；`dirty` 标记让 Home/删除流程跳过无谓写库。已知取舍：聚合视图（Home/Display 计数）只保证前两层 mtime 检测，更深层的外部变更在进入该目录时校正。
- 跨会话结构缓存没有：`read.js` 每次 `openFile` 都重新 `getEntries()`、重新解析 EPUB spine / MOBI，没有 zip central directory 或 manifest 缓存。
- Epub/Mobi 虚拟化没有：`EpubReading.vue` 与 `MobiReading.vue` 仍一次性把所有章节 append 进 DOM。
- 安全面没收紧：`tauri.conf.json` 的 `assetProtocol.scope.allow` 仍有 `"**"`，CSP 外部服务白名单过宽。
