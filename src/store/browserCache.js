// 文件浏览器的模块级共享缓存。
// 目录列表、封面 URL、失败标记都放在模块作用域里，组件卸载/重新进入时不会丢失，
// 因此再次进入同一文件夹（包括收藏文件夹）时无需重新读取目录、重新读封面。
import { reactive } from "vue";
import { getBookCover, loadDiskCover, peekCover } from "../utils/bookData";

// ============ 目录列表缓存 ============
export const dirCache = new Map();

let drivesCache = null;
export const getDrivesCache = () => drivesCache;
export const setDrivesCache = (d) => {
  drivesCache = d;
};

// ============ 封面状态（模块级响应式，跨组件存活） ============
export const covers = reactive({});
export const coverFailed = reactive({});

// ============ 封面加载队列 ============
// foreground（正在浏览的文件夹/可视区域）优先，最多 6 个并发；
// background（后台预热）只在没有前景任务时以 2 个并发运行。
const extractQueue = []; // { key, priority }
const extractActive = new Set(); // 正在提取中的 key（并发数的唯一依据）
const queuedKeys = new Set(); // 已入队的规范化 key，避免重复入队
const FG_LIMIT = 6;
const BG_LIMIT = 2;

// Windows 下路径大小写不敏感、斜杠可混用，统一成小写+反斜杠的规范化 key，
// 保证预热/浏览/队列各处拿到的键一致，避免封面显示不出来或重复加载。
export const canonKey = (key) => (isWindows ? key.toLowerCase().replace(/\//g, "\\") : key);

// 单个封面提取加超时保护：个别损坏/超大文件可能让 openFile 永久挂起，
// 若不加超时，会把前台/后台队列的并发槽位占死，后面的封面永远加载不出来。
const EXTRACT_TIMEOUT_MS = 15000;

const runExtract = async (key) => {
  let timedOut = false;
  try {
    const result = await Promise.race([
      getBookCover(key).then((u) => ({ u })),
      new Promise((res) =>
        setTimeout(() => {
          timedOut = true;
          res({ u: null });
        }, EXTRACT_TIMEOUT_MS)
      ),
    ]);
    if (timedOut) throw new Error("cover extraction timeout");
    if (result && result.u) covers[canonKey(key)] = result.u;
  } catch (error) {
    coverFailed[canonKey(key)] = true;
  } finally {
    extractActive.delete(key);
    pumpExtract();
  }
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
    extractActive.add(item.key);
    runExtract(item.key);
  }
};

export const enqueueCover = (key, priority = true) => {
  if (!key) return;
  const nk = canonKey(key);
  if (covers[nk] || coverFailed[nk] || extractActive.has(key)) return;
  const existing = extractQueue.find((q) => canonKey(q.key) === nk);
  if (existing) {
    // 可见区域的封面请求可以把后台任务升级为前台优先
    if (priority && !existing.priority) existing.priority = true;
    pumpExtract();
    return;
  }
  queuedKeys.add(nk);
  extractQueue.push({ key, priority });
  pumpExtract();
};

// 记录平台（Windows 下路径大小写不敏感），canonKey 使用
const isWindows = /Windows/i.test(navigator.userAgent);
