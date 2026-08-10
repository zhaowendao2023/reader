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

## 待实现

- 设置功能（设置页）就绪后，把侧边栏头像旁名字的进出动画做成用户可选，已有两套方案待接入：

  1. 淡入淡出 + 小幅靠拢：名字固定在头像右侧，收起/展开时 opacity 淡入淡出，并 translateX(-8px) 轻靠头像边缘。
  2. 宽度展开式：名字固定在头像右侧，容器宽度从 0 过渡到文字实际宽度，文字从头像右侧“长出来/缩回去”（当前 `src/components/LayOut.vue` 采用的方案）。
