# 架构速览

> 面向新会话/新开发者：先读这一份，再按“建议阅读顺序”下钻。
> 口径：本文件描述仓库当前代码（`dev` 分支），命令与路径均可在仓库内复现。

## 定位

「朝闻道」是一个本地媒体库应用：把收藏文件夹扫描成 SQLite 索引，再通过书架、文件浏览器、标签、搜索进入阅读/播放。

- 技术栈：Tauri 2（Rust）+ Vue 3 + Pinia + Vue Router（hash 路由）+ Vite。
- 平台：Windows 桌面、Android（同一套前端，按 `platform` 切视频后端）。
- 形态：不是“打开单本书”的阅读器，而是“收藏夹 → 索引 → 浏览 → 阅读/播放”的库应用。

## 目录地图

| 位置 | 职责 |
|---|---|
| `src/main.js` | 应用入口；Android 返回键路由栈逻辑 |
| `src/router/index.js` | 路由表 |
| `src/components/` | 视图与交互：`LayOut`（外壳/导航）、`Home`（全量聚合）、`Display`（收藏分组）、`FileBrowser`、`SearchPage`、`TagBrowse`、`Settings`、`ComicReading`/`EpubReading`/`MobiReading`、`VideoPlayer`、`MediaViewer`、`MediaPack`；`BookCover`/`MediaCover` 是列表页共用的封面卡 |
| `src/js/` | 格式解析：`read.js`（打开入口）、`comic-book.js`、`epub.js`、`mobi.js`；`vendor/fflate.js` 供 MOBI 解压 |
| `src/utils/` | 数据与性能：`itemKey.js`（路径 key 与 `items.id` 的唯一入口）、`libraryView.js`（`ItemRow` → 卡片节点/排序）、`open.js`（打开条目的路由入口）、`itemMenu.js`（右键/长按菜单）、`bookData.js`（书籍/封面对外入口）、`coverCache.js`（封面内存+磁盘缓存与批量读取）、`coverExtract.js`（按媒体类型提取封面）、`videoSession.js`（视频播放会话：命令/轮询/续播/音量倍速）、`mediaScan.js`（扫描 + 索引 + `scanAndSyncFavorite`）、`progress.js`、`itemActions.js` |
| `src/store/` | Pinia：`loadBooks`（书库/收藏夹/主题）、`settings`（偏好）、`tags`、`browserCache`（目录/封面/滚动缓存） |
| `src-tauri/src/` | `lib.rs`（命令注册）、`db.rs`（SQLite 与迁移）、`sync.rs`（索引/搜索）、`tags.rs`、`mpv.rs`（Windows 播放）、`video.rs`（Android 桥接）、`import.rs`（旧 `store.bin` 迁移）、`paths.rs` |
| `src-tauri/migrations/` | 迁移 SQL：items/progress（v1）、tags（v3）、tag kind（v4） |
| `scripts/` + `ui-test.html` | 浏览器 mock 预览与 CDP 验证脚本 |

## 核心数据流

1. **扫描建索引**：收藏夹存 SQLite（`items`，`kind` = comic/video/image/pack/group/favorite）。`Home` 启动 `list_items` + `library_meta`；库为空或未同步才走 `scanAll`（扫描 → `sync_favorite` → 重新读行建视图，视图模型只有 `applyLibrary` 一份）。扫描用 Rust `read_dir_meta` 读目录自 mtime + 子项 mtime：未变子树直接从 SQLite 行重建（零 `readDir`），变了才重扫并 `sync_favorite` upsert。
2. **打开一本书**：路由 `/reading/:id?path=&name=&ext=`，`Reading.vue` 按后缀分派；`read.js` 用 zip.js RangeReader 按需读，CBZ 图片优先走 Rust `read_cbz_entry` 原生解压；同路径 zip loader 单例 + 引用计数 + 60s 空闲释放。
3. **封面**：id = sha256(规范化路径)（与 DB 主键一致），缓存 `app_data/cover-cache/v5/<id>/cover.jpg` + `index.json`；前端队列（前台 8/后台 3 并发、失败 120s 冷却），批量 IPC 读取。视频封面走 mpv 抓帧（Android 走 MediaMetadataRetriever）。
4. **进度与标签**：`progress` 按 item_id，500ms debounce 批量 `save_progress_map`；`tags` + `item_tags`（含 `kind` 分组）。搜索为名称 LIKE + 标签命中，系列文件折叠进目录结果。
5. **视频双后端**：Windows 动态加载 libmpv（播放池 3、抓帧池 2、每实例专用消息泵线程）；Android 走 ExoPlayer 的 Kotlin 插件（`video_*`）。两套命令语义对齐，前端只切前缀。命令层各自收敛样板：`video.rs` 全部命令走 `android_call!`/`mobile_call`，`mpv.rs` 走 `with_player`（`mpv_get_state` 例外：500ms 轮询只读状态缓存，不进 `spawn_blocking`）。

## 持久化

| 存储 | 内容 |
|---|---|
| `reader.db`（SQLite，WAL） | items / progress / tags / item_tags / schema_migrations |
| `store.bin` | 主题与阅读排版（`theme` / `cssVars`） |
| `settings.bin` | 应用偏好（视图、侧栏、倍速、跳转步长等） |
| `cover-cache/` | 封面缩略图 + manifest |

迁移在启动时按 `schema_migrations` 版本号重放；v2 是一次性导入旧 `store.bin`/`progress.json` 的逻辑，旧文件不存在时只打日志并继续（属于正常现象）。

## 平台差异

- **Windows**：视频走 `src-tauri/src/mpv.rs`，需要 `libmpv-2.dll`（exe 同目录或 `READER_MPV_DLL`）。
- **Android**：视频走 `video.rs` → Kotlin `VideoPlugin`（ExoPlayer）；系统栏/返回键/全文件访问也是 Kotlin 插件。
- **Android 工程不在版本库内**：`src-tauri/gen/` 被 `.gitignore` 忽略，Kotlin 实现（`SystemUiPlugin` / `AllFilesPlugin` / `VideoPlugin`）只存在于本地生成的工程。新机器要构建 Android 端，需先 `tauri android init` 并补齐这些插件源码。

## 已知工程风险

1. `src-tauri/tauri.conf.json` 不再保留调试端口；CDP 调试必须走 `scripts/dev-launch.ps1`（临时注入、退出还原）。
2. `assetProtocol.scope.allow` 仍含 `"**"`，`capabilities/default.json` 是 `fs:read-all`/`write-all` + scope `"**"`，CSP 白名单偏宽（含模板残留域名）。
3. 无 CI；回归靠 `scripts/` 下的 CDP 脚本与人工走查。Rust 侧有单元测试（`cargo test`）。
4. 封面缓存无容量上限；EPUB/MOBI 未做虚拟化；跨会话无 zip/spine 缓存。

## 建议阅读顺序

1. `src-tauri/src/lib.rs` 的 `generate_handler!` 命令清单 + `src-tauri/migrations/001_init.sql`。
2. `src/utils/mediaScan.js` 的 mtime 快路径 + `src-tauri/src/sync.rs` 的 `sync_favorite_inner`。
3. `src/js/read.js` + `src/js/comic-book.js`。
4. `src/utils/bookData.js` → `coverCache.js` / `coverExtract.js` 的封面流水线。
5. `src/components/VideoPlayer.vue` + `src/utils/videoSession.js` + `mpv.rs` / `video.rs`。
6. `src/components/Reading.vue`。
