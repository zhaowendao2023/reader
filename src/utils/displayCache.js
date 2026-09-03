// 放映器显示结果缓存（模块级，跨进入存活）：key=规范化路径，value=压缩字节的 object URL。
//
// 设计要点：
//  - 存「压缩字节的 object URL」而非解码位图/字节数组——回看复用同一 URL，
//    浏览器图片解码缓存直接命中（零解码、秒开）；内存占用 ≈ 压缩字节。
//  - LRU：命中即续命（Map 删除重插）。
//  - 字节预算 + 条数上限双保险：超限从最旧开始淘汰并 revoke，防止 URL 泄漏。
//  - 正在显示的 URL 不在此处 revoke（屏幕上的图会消失），由组件在切换/卸载时
//    用 displayCacheHas 判断后释放；被淘汰但仍在显示的 URL 由组件在切换时兜底释放。
//  - GIF 不入缓存（动图可能很大，且每次都是新 URL）。

const cache = new Map();
let bytes = 0;
const BUDGET = 128 * 1024 * 1024; // 128MB 压缩字节封顶
const MAX_ITEMS = 512;

let displayedUrl = "";

/** 命中并续命（LRU）。返回 { url, size } 或 null。 */
export const displayCacheGet = (path) => {
  const e = cache.get(path);
  if (!e) return null;
  cache.delete(path);
  cache.set(path, e);
  return e;
};

/** 只查不改（缩略图占位判断用，不产生续命副作用）。 */
export const displayCachePeek = (path) => cache.get(path) || null;

/** 写入（覆盖旧条目并续命），超预算自动淘汰。 */
export const displayCachePut = (path, url, size) => {
  const prev = cache.get(path);
  if (prev) {
    cache.delete(path);
    bytes += size - prev.size;
    if (prev.url !== url) revokeUnlessDisplayed(prev.url);
  } else {
    bytes += size;
  }
  cache.set(path, { url, size });
  evict();
};

/** 组件切换显示时告知当前 URL，淘汰逻辑据此跳过屏幕上的图。 */
export const displayCacheSetDisplayed = (url) => {
  displayedUrl = url;
};

/** 该 URL 是否仍在缓存中（组件据此决定切换/卸载时要不要自己释放）。 */
export const displayCacheHas = (url) => {
  for (const e of cache.values()) if (e.url === url) return true;
  return false;
};

function revokeUnlessDisplayed(url) {
  if (url !== displayedUrl) URL.revokeObjectURL(url);
}

function evict() {
  while (cache.size > MAX_ITEMS || bytes > BUDGET) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    const e = cache.get(oldest);
    cache.delete(oldest);
    bytes -= e.size;
    revokeUnlessDisplayed(e.url);
  }
}
