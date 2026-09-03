// 封面懒加载 composable：模块级共享一个 IntersectionObserver，
// Home / Display / FileBrowser / SearchPage 不再各自创建/销毁观察器、
// 各自维护 observedCovers 集合，统一收敛到这里。
//
// 观察器回调按节点查 handler（WeakMap），命中可视区即入队封面提取
// （browserCache.enqueueCover）。页面切换/数据刷新时只摘除本实例观察的
// 节点，避免旧页面节点残留在观察器里反复回调。
//
// 防漏加载设计（修复「移动端中间连排封面不加载，直接往下加载」）：
// 1) 节点在封面真正加载完成前保持被观察。enqueueCover 可能因「提取中 /
//    冷却中 / 已在队列」静默拒绝本次入队，旧实现命中即 unobserve，
//    会让这些封面在本次页面会话里永远失去第二次入队机会——同批入队的
//    俩封面同时竞争磁盘、同时超时/失败，就恰好缺俩，下面的继续加载。
// 2) 冷却中的节点登记一个定时重试：冷却结束后 unobserve+observe 强制
//    IO 立即重算相交状态，命中即可再次入队。
// 3) 模块级兜底重扫：周期性对仍缺封面的节点做 unobserve+observe。
//    治疗 content-visibility:auto 估算几何在快速滚动下漏触发 IO
//    （目标一直停在可视区、不再有滚动事件触发）的静止失败。
import { nextTick, onScopeDispose } from "vue";
import {
  enqueueCover,
  stopPrefetch,
  covers,
  coverFailed,
  canonKey,
  COVER_FAIL_COOLDOWN_MS,
} from "../store/browserCache";

let sharedObserver = null;
// node -> (entry) => keepObserving:boolean。返回 true 表示该节点继续被观察
// （FileBrowser 列表视图跳过 video/image 行但保留观察，行为与旧实现一致）。
const nodeHandler = new WeakMap();

const getObserver = () => {
  if (typeof IntersectionObserver === "undefined") return null;
  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver(
      (list) => {
        for (const item of list) {
          if (!item.isIntersecting) continue;
          const handler = nodeHandler.get(item.target);
          if (!handler) continue;
          const keep = handler(item);
          if (!keep) {
            sharedObserver.unobserve(item.target);
            nodeHandler.delete(item.target);
          }
        }
      },
      { rootMargin: "300px" }
    );
  }
  return sharedObserver;
};

// ===== 模块级兜底重扫 =====
// 所有活跃实例共享一个定时器；每轮对「仍缺封面」的节点 unobserve+observe，
// 强制 IO 在下一次 update 立即重算相交状态（新观察目标会立刻回发当前状态）。
const SWEEP_INTERVAL_MS = 8000;
const activeInstances = new Set();
let sweepTimer = null;

const startSweep = () => {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const obs = getObserver();
    for (const inst of activeInstances) {
      for (const node of inst.seen) {
        const key = node.dataset?.key;
        if (!node.isConnected || !key || covers[key]) {
          // 已加载 / 已卸载 / 无 key：摘除观察，不再反复计算
          obs?.unobserve(node);
          nodeHandler.delete(node);
          inst.seen.delete(node);
          continue;
        }
        obs?.unobserve(node);
        obs?.observe(node);
      }
    }
  }, SWEEP_INTERVAL_MS);
};

const stopSweep = () => {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
};

/**
 * 观察页面内的封面节点，进入可视区（+300px 预取余量）即入队封面提取。
 *
 * options:
 *   selector: string              // 页面作用域的选择器（如 ".home-page .book-cover, .home-page .media-cover"）
 *   kindOf?: (key, kind, node) => string   // kind 转换（FileBrowser: dir → group）
 *   skip?:   (key, kind, node) => boolean  // 命中但跳过入队，节点保持观察
 *   prefetch?: () => void         // 观察完成后调用（后台批量预取，如 prefetchCovers）
 *
 * 返回 { observe, reset }：
 *   observe —— 数据就绪/激活后调用（内部 nextTick 后重建观察）；
 *   reset   —— 失活/卸载/返回总览时调用（摘除节点 + stopPrefetch）。
 */
export const useLazyCovers = (options = {}) => {
  const inst = {}; // 模块级重扫引用的实例句柄（inst.seen）
  const seen = new Set(); // 本实例当前观察的节点
  const retryNodes = new Set(); // 冷却重试待执行的节点（reset/unobserve 时取消）
  const retryTimers = new WeakMap(); // node -> timer

  // 冷却中的节点：登记冷却结束后的强制重试（重观察会立刻回发相交状态，
  // 命中即再次入队；此时冷却已过，enqueueCover 会接受）。
  const scheduleCooldownRetry = (node, key, kind) => {
    if (retryNodes.has(node)) return;
    retryNodes.add(node);
    const nk = canonKey(key);
    const f = coverFailed[nk];
    const remaining = Math.max(0, (f?.at || 0) + COVER_FAIL_COOLDOWN_MS - Date.now());
    retryTimers.set(
      node,
      setTimeout(() => {
        retryNodes.delete(node);
        const obs = getObserver();
        if (!node.isConnected || covers[key]) {
          obs?.unobserve(node);
          nodeHandler.delete(node);
          seen.delete(node);
          return;
        }
        obs?.unobserve(node);
        obs?.observe(node);
      }, remaining + 50)
    );
  };

  const unobserveAll = () => {
    const obs = getObserver();
    for (const node of seen) {
      obs?.unobserve(node);
      nodeHandler.delete(node);
    }
    for (const node of retryNodes) {
      const t = retryTimers.get(node);
      if (t) clearTimeout(t);
      retryTimers.delete(node);
    }
    retryNodes.clear();
    seen.clear();
  };

  const observe = async () => {
    await nextTick();
    unobserveAll();
    const nodes = Array.from(document.querySelectorAll(options.selector));
    const obs = getObserver();
    if (!obs) {
      // 无 IntersectionObserver 的环境（罕见）：直接全量入队，保持封面可用。
      for (const node of nodes) {
        const key = node.dataset.key;
        if (!key) continue;
        const kind = node.dataset.kind || "comic";
        const finalKind = options.kindOf ? options.kindOf(key, kind, node) : kind;
        enqueueCover(key, true, finalKind);
      }
    } else {
      for (const node of nodes) {
        const key = node.dataset.key;
        if (!key) continue;
        seen.add(node);
        nodeHandler.set(node, () => {
          const kind = node.dataset.kind || "comic";
          const finalKind = options.kindOf ? options.kindOf(key, kind, node) : kind;
          if (options.skip && options.skip(key, finalKind, node)) return true;
          if (covers[key]) return false; // 封面已就绪：摘除观察
          const status = enqueueCover(key, true, finalKind);
          if (status === "cooling") scheduleCooldownRetry(node, key, finalKind);
          // queued / inflight / cooling 都保留观察：提取失败、IO 漏触发、
          // 或入队被拒时，后续滚动进出可视区 / 冷却重试 / 兜底重扫
          // 还会再次触发入队，封面不会永久停在占位符。
          return true;
        });
        obs.observe(node);
      }
    }
    activeInstances.add(inst);
    startSweep();
    if (options.prefetch) options.prefetch();
  };

  const reset = () => {
    unobserveAll();
    stopPrefetch();
    activeInstances.delete(inst);
    if (!activeInstances.size) stopSweep();
  };

  onScopeDispose(reset);
  inst.seen = seen;
  inst.observe = observe;
  inst.reset = reset;
  return inst;
};
