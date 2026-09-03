// 文件浏览器的模块级共享缓存。
// 目录列表、封面 URL、失败标记都放在模块作用域里，组件卸载/重新进入时不会丢失，
// 因此再次进入同一文件夹（包括收藏文件夹）时无需重新读取目录、重新读封面。
import { reactive } from "vue";
import { getCover } from "../utils/bookData";
import { recordTiming, maybeFlushTiming } from "../utils/coverTiming";

// ============ 目录列表缓存 ============
export const dirCache = new Map();

let drivesCache = null;
export const getDrivesCache = () => drivesCache;
export const setDrivesCache = (d) => {
  drivesCache = d;
};

// ============ 滚动位置记忆 ============
// 按视图键（文件浏览器的目录规范化 key / Home 的模式名）记住滚动位置。
// 删除文件后目录缓存被清空、列表重建时用来恢复原位，避免用户被弹回顶部、
// 要重新翻很久；模块级缓存跨组件存活、会话内不丢失。
export const scrollMemory = new Map();

// ============ 封面状态（模块级响应式，跨组件存活） ============
export const covers = reactive({});
// 删除文件/目录后递增，Home 等页面据此重新从 SQLite 加载，避免残留已删条目。
export const libraryVersion = reactive({ value: 0 });
export const touchLibrary = () => {
  libraryVersion.value++;
};
// coverFailed[key] = { at: timestamp }。失败不是永久的：超过冷却期后允许
// 重试，避免一次抓帧超时/失败（如 mpv 冷启动慢、目录首视频损坏）导致
// 该封面从此永远加载不出来。
export const coverFailed = reactive({});
// 导出给 lazyCovers：冷却中的节点据此登记「冷却结束后强制重试」的定时器
export const COVER_FAIL_COOLDOWN_MS = 120000;

const failedRecently = (nk) => {
  const f = coverFailed[nk];
  return Boolean(f) && (f.at || 0) + COVER_FAIL_COOLDOWN_MS > Date.now();
};

// ============ 封面加载队列 ============
// foreground（正在浏览的文件夹/可视区域）优先，最多 6 个并发；
// background（后台预热）只在没有前景任务时以 3 个并发运行。
const extractQueue = []; // { key, priority, kind }
const extractActive = new Set(); // 正在提取中的 key（并发数的唯一依据）
const queuedKeys = new Set(); // 已入队的规范化 key，避免重复入队
const FG_LIMIT = 8;
const BG_LIMIT = 3;

// Windows 下路径大小写不敏感、斜杠可混用，统一成小写+反斜杠的规范化 key，
// 保证预热/浏览/队列各处拿到的键一致，避免封面显示不出来或重复加载。
export const canonKey = (key) => (isWindows ? key.toLowerCase().replace(/\//g, "\\") : key);

// 图包查看器 / 播放列表共用的原始 readDir 缓存 key：与文件浏览器共用同一个
// Map（删除文件后 itemActions 的 dirCache.clear() 一并失效），但用命名空间
// 前缀区分——文件浏览器缓存的是加工后的条目（{name,key,isDir,...}），
// 图包/播放列表缓存的是 plugin-fs 原始条目，形状不同，不能互相覆盖。
export const mediaDirKey = (dir) => `media\0${canonKey(dir)}`;

// 单个封面提取加超时保护：个别损坏/超大文件可能让提取永久挂起，
// 若不加超时，会把前台/后台队列的并发槽位占死，后面的封面永远加载不出来。
// 视频帧与系列拼图较重，给更宽的预算；失败后仍回退渐变占位。
const EXTRACT_TIMEOUT_MS = 15000;
const KIND_TIMEOUT_MS = {
  video: 25000,
  "video-folder": 25000,
  group: 35000,
};
const timeoutFor = (kind) => KIND_TIMEOUT_MS[kind] || EXTRACT_TIMEOUT_MS;

// 后台封面预加载：列表出现后按 DOM 顺序持续推进，直到全部封面入队。
// 并发数和批处理间隔仍然把磁盘/CPU 占用限制在后台档位；
// 滚动时可见区域仍会通过 enqueueCover(key, true) 插队到前台。
// 批越大、间隔越紧，入队越快——移动端 requestIdleCallback 常被 UI 线程
// 饿死，实测 8 本/批 × 100ms timeout 时整页 489 本要 ~10s 才入完队。
const PREFETCH_BATCH = 16;
const PREFETCH_INTERVAL_MS = 30;

let prefetchRun = 0;
let prefetchCursor = 0;
let prefetchKeys = [];
let prefetchTimer = null;
let prefetchCancel = null;

const waitIdle = (ms) =>
  new Promise((res) => {
    const done = () => {
      prefetchTimer = null;
      prefetchCancel = null;
      res();
    };
    if (typeof requestIdleCallback === "function") {
      // timeout 收紧到 ms（不再 2x）：idle 不来时按固定节拍走，防入队被饿死
      prefetchTimer = requestIdleCallback(done, { timeout: ms });
      prefetchCancel = () => cancelIdleCallback(prefetchTimer);
    } else {
      prefetchTimer = setTimeout(done, ms);
      prefetchCancel = () => clearTimeout(prefetchTimer);
    }
  });

const clearPrefetchTimer = () => {
  if (prefetchTimer) {
    prefetchCancel?.();
    prefetchTimer = null;
    prefetchCancel = null;
  }
};

export const stopPrefetch = () => {
  prefetchRun++;
  prefetchKeys = [];
  prefetchCursor = 0;
  clearPrefetchTimer();
};

export const prefetchCovers = (entries) => {
  stopPrefetch();
  const run = ++prefetchRun;
  prefetchKeys = (entries || [])
    .map((e) => (typeof e === "string" ? { key: e, kind: "comic" } : e))
    .filter((e) => {
      const nk = canonKey(e.key);
      return !covers[nk] && !failedRecently(nk) && !queuedKeys.has(nk);
    });
  prefetchCursor = 0;

  const tick = async () => {
    if (run !== prefetchRun) return;
    const batch = prefetchKeys.slice(prefetchCursor, prefetchCursor + PREFETCH_BATCH);
    prefetchCursor += batch.length;
    for (const entry of batch) enqueueCover(entry.key, false, entry.kind);
    if (run !== prefetchRun || prefetchCursor >= prefetchKeys.length) return;
    await waitIdle(PREFETCH_INTERVAL_MS);
    tick();
  };
  tick();
};

const runExtract = async (key, kind) => {
  const nk = canonKey(key);
  const t0 = performance.now();
  // 这里必须把 reject 也变成正常结果。之前 getCover() 一旦因权限、损坏压缩包
  // 或 Android 文件读取短暂失败而 reject，runExtract 会在 finally 之前中断，
  // extractActive 中的槽位永远不释放；累计到并发上限后，后续封面只能等刷新重置。
  const extract = Promise.resolve().then(() => getCover(key, kind));
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    extractActive.delete(nk);
    pumpExtract();
  };
  const result = await Promise.race([
    extract.then(
      (u) => ({ u, timedOut: false, failed: false }),
      (error) => ({ u: null, timedOut: false, failed: true, error })
    ),
    new Promise((res) =>
      setTimeout(() => res({ u: null, timedOut: true, failed: false }), timeoutFor(kind))
    ),
  ]);
  if (result.timedOut) {
    // 超时：释放并发槽位并记录冷却失败（不永久标记）。getCover 的提取
    // 仍在后台进行，完成后若成功直接写回 covers，无需等冷却重试。
    coverFailed[nk] = { at: Date.now() };
    extract
      .then((u) => {
        if (u) {
          covers[nk] = u;
          delete coverFailed[nk];
        }
      })
      .catch(() => {});
    release();
    return;
  }
  recordTiming("cover.total", performance.now() - t0);
  maybeFlushTiming();
  if (result.u) {
    covers[nk] = result.u;
    delete coverFailed[nk];
  } else {
    // reject 与返回空封面都进入冷却和 lazyCovers 的重试流程，不能让一个
    // 临时失败永久占住队列，也不能静默丢掉该封面。
    if (result.failed) console.warn("cover extraction failed:", key, result.error);
    coverFailed[nk] = { at: Date.now() };
  }
  release();
};

const pumpExtract = () => {
  while (true) {
    if (!extractQueue.length) break;
    const fgIdx = extractQueue.findIndex((q) => q.priority);
    const hasFg = fgIdx >= 0;
    const limit = hasFg ? FG_LIMIT : BG_LIMIT;
    if (extractActive.size >= limit) break;
    const idx = fgIdx >= 0 ? fgIdx : 0;
    if (idx === -1) break;
    const item = extractQueue.splice(idx, 1)[0];
    queuedKeys.delete(canonKey(item.key));
    extractActive.add(canonKey(item.key));
    runExtract(item.key, item.kind);
  }
};

// 入队封面提取。返回状态供调用方（lazyCovers）决定是否保留观察：
//   "loaded"   —— 封面已就绪，无需再入队
//   "queued"   —— 已接受（新入队 / 已在队列并升级优先）
//   "inflight" —— 提取正在进行中，稍后可能成功或失败
//   "cooling"  —— 之前失败、处于冷却期，冷却结束后才允许重试
//   "none"     —— key 为空
export const enqueueCover = (key, priority = true, kind = "comic") => {
  if (!key) return "none";
  const nk = canonKey(key);
  if (covers[nk]) return "loaded";
  if (extractActive.has(nk)) return "inflight";
  if (failedRecently(nk)) return "cooling";
  const existing = extractQueue.find((q) => canonKey(q.key) === nk);
  if (existing) {
    // 可见区域的封面请求可以把后台任务升级为前台优先
    if (priority && !existing.priority) existing.priority = true;
    pumpExtract();
    return "queued";
  }
  queuedKeys.add(nk);
  extractQueue.push({ key, priority, kind });
  pumpExtract();
  return "queued";
};

// 记录平台（Windows 下路径大小写不敏感），canonKey 使用
const isWindows = /Windows/i.test(navigator.userAgent);
