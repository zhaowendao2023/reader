# 第三方组件与许可证

本程序在 Windows 上通过动态加载 `libmpv-2.dll` 播放视频。该库不是本项目的代码，
其许可证要求随分发提供声明，内容如下。

## libmpv（MPV 播放核心）

| 项 | 值 |
| --- | --- |
| 组件 | libmpv（mpv 的可嵌入库构建） |
| 上游项目 | https://github.com/mpv-player/mpv |
| 构建来源 | https://github.com/zhongfly/mpv-winbuild |
| 构建版本 | tag `2026-11-26-1eab28e7b5`，mpv commit `1eab28e7b5`，构建于 2026-11-26 |
| 构建变体 | `mpv-dev-lgpl-x86_64`（LGPL 构建，不含 GPL-only 组件） |
| 分发文件 | `libmpv-2.dll`，与 `reader.exe` 同目录 |
| 许可证 | GNU Lesser General Public License v2.1 or later |
| 许可证全文 | [`licenses/LGPL-2.1.txt`](licenses/LGPL-2.1.txt) |

### 可替换性说明

`libmpv-2.dll` 以**独立动态库**形式分发，位于 `reader.exe` 同目录，由程序在运行时
按该位置加载。用户可以自行删除或替换为任意 ABI 兼容的 libmpv 构建（包括自己编译的
版本），无需修改、重新链接或重新签名本程序。

本项目未修改 libmpv 源码。若需要构建上述 DLL 的完整源码，可从上表的 commit 与
构建仓库获取；本项目不额外分发修改后的 libmpv。

### 许可证影响范围

LGPL-2.1 的上述义务仅适用于 `libmpv-2.dll` 及其上游代码。本程序自身的代码保持原有
授权，不因加载该动态库而被要求开源。

## 其他第三方组件

Rust 与前端依赖的许可证信息以各自 `Cargo.lock` / `pnpm-lock.yaml` 中的包为准。
