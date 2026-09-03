import { nextTick } from "vue";

// 列表卡片使用 content-visibility 后，未出现在视口附近的内容高度只是估算值。
// 因此不能只记 scrollTop：要同时记住视口内第一张卡片及其相对位置，并在
// DOM 重建后重新对齐它。这里保存的是纯数据，页面只负责声明「何时会重建」。
const anchors = new Map();

const cloneAnchor = (anchor) => (anchor ? { ...anchor } : null);

const findAnchor = (container, selector = "[data-key]") => {
  if (!container) return null;
  const rect = container.getBoundingClientRect();
  for (const card of container.querySelectorAll(selector)) {
    const cardRect = card.getBoundingClientRect();
    if (cardRect.bottom > rect.top && cardRect.top < rect.bottom) {
      return { key: card.dataset.key, offset: cardRect.top - rect.top };
    }
  }
  return null;
};

const alignAnchor = (container, anchor, selector = "[data-key]") => {
  if (!container || !anchor) return false;
  const card = [...container.querySelectorAll(selector)].find(
    (node) => node.dataset.key === anchor.key
  );
  if (!card) return false;
  const containerRect = container.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  container.scrollTop += cardRect.top - containerRect.top - anchor.offset;
  return true;
};

const saveAnchor = (container, anchorKey, selector) => {
  const anchor = findAnchor(container, selector);
  if (anchor) anchors.set(anchorKey, anchor);
  return cloneAnchor(anchor);
};

/**
 * 统一保存/恢复一个或多个滚动容器。
 *
 * entry 可声明 element、stateKey、anchorKey、memory 与 anchor:false；三个 key 都可为函数。
 * checkpoint() 返回不可变快照并暂停采集，适合路由离开或骨架屏替换前调用；
 * restoreAfterRender() 会在 nextTick 后恢复，并在短暂稳定窗口内用同一份冻结锚点校正，
 * 以覆盖 content-visibility 或异步布局晚到造成的高度变化；用户开始操作时立即停止。
 */
export const createScrollRestorer = (containers, { anchorInterval = 120, settleMs = 1600 } = {}) => {
  const entries = Array.isArray(containers) ? containers : [containers];
  const localMemory = new Map();
  let captureActive = true;
  let lastAnchorSave = 0;
  let lastCheckpoint = null;
  let restoreVersion = 0;

  const resolve = (value) => (typeof value === "function" ? value() : value);
  const stateKeyOf = (entry) => resolve(entry.stateKey ?? entry.anchorKey ?? entry.id);
  const anchorKeyOf = (entry) => resolve(entry.anchorKey ?? entry.stateKey ?? entry.id);
  const anchorSelectorOf = (entry) => resolve(entry.anchorSelector ?? "[data-key]");
  const memoryOf = (entry) => entry.memory || localMemory;

  const readEntries = () =>
    entries.map((entry) => ({
      entry,
      element: resolve(entry.element),
      stateKey: stateKeyOf(entry),
      anchorKey: anchorKeyOf(entry),
      memory: memoryOf(entry),
    }));

  // key 在此时就解析，不能拖到 nextTick；否则目录/模式已变化时会恢复到错误上下文。
  const snapshot = ({ forceAnchor = false, position = true, allowWhenSuspended = false } = {}) => {
    if (!captureActive && !allowWhenSuspended) return null;
    const now = Date.now();
    const shouldSaveAnchor = forceAnchor || now - lastAnchorSave > anchorInterval;
    if (shouldSaveAnchor) lastAnchorSave = now;

    return readEntries().map(({ entry, element, stateKey, anchorKey, memory }) => {
      if (position && element) memory.set(stateKey, element.scrollTop);
      let anchor = entry.anchor === false ? null : cloneAnchor(anchors.get(anchorKey));
      if (entry.anchor !== false && element && shouldSaveAnchor) {
        anchor = saveAnchor(element, anchorKey, anchorSelectorOf(entry));
      }
      return {
        entry,
        stateKey,
        anchorKey,
        memory,
        position: element?.scrollTop ?? memory.get(stateKey) ?? 0,
        anchor,
      };
    });
  };

  const capture = (options = {}) => snapshot(options);

  const checkpoint = () => {
    // 已在导航/重建前冻结过时，keep-alive 隐藏阶段的 scrollTop 可能已被钳到 0；
    // 此处必须返回原快照，不能再读取 DOM 覆写它。
    if (!captureActive && lastCheckpoint) return lastCheckpoint;
    try {
      // 使尚未执行的恢复校正失效；即将离开时不能再改动滚动容器。
      restoreVersion += 1;
      const point = snapshot({ forceAnchor: true, allowWhenSuspended: true });
      lastCheckpoint = point;
      captureActive = false;
      return point;
    } catch (error) {
      // 滚动恢复是体验增强，不能让读取失效的 DOM 阻断打开漫画/视频等导航。
      console.warn("scroll checkpoint skipped:", error);
      return lastCheckpoint;
    }
  };

  const stateSnapshot = () =>
    readEntries().map(({ entry, element, stateKey, anchorKey, memory }) => ({
      entry,
      stateKey,
      anchorKey,
      memory,
      position: memory.get(stateKey) ?? element?.scrollTop ?? 0,
      anchor: entry.anchor === false ? null : cloneAnchor(anchors.get(anchorKey)),
    }));

  const fallbackFor = (point, fallback) => {
    const value = typeof fallback === "function" ? fallback(point.entry, point) : fallback;
    return value ?? point.position ?? point.memory.get(point.stateKey) ?? 0;
  };

  const restore = ({ snapshot: point = stateSnapshot(), fallback } = {}) => {
    const apply = () => {
      for (const saved of point || []) {
        const element = resolve(saved.entry.element);
        if (!element) continue;
        const restoredByAnchor =
          saved.entry.anchor !== false && alignAnchor(element, saved.anchor, anchorSelectorOf(saved.entry));
        if (!restoredByAnchor) element.scrollTop = fallbackFor(saved, fallback);
      }
    };

    const version = ++restoreVersion;
    apply();
    captureActive = true;
    lastCheckpoint = null;

    // 校正循环：布局（封面懒加载 / content-visibility 估算高度）异步到位时，
    // 需要把卡片重新对齐到冻结锚点。但不能每帧无条件 apply——那会把
    // 「估算布局→真实布局」的两段变化渲染成肉眼可见的中间位跳动
    // （手机端封面逐张懒加载时尤其明显）。这里只在探测到实际偏差时才 apply，
    // 偏差归零（布局稳定）即收敛停止，不再制造无谓的中间帧。
    if (typeof requestAnimationFrame === "function") {
      const targets = [...new Set((point || []).map((saved) => resolve(saved.entry.element)).filter(Boolean))];
      const inputEvents = ["wheel", "touchstart", "pointerdown", "keydown"];
      const cancel = () => {
        if (version === restoreVersion) restoreVersion += 1;
      };
      const cleanup = () =>
        targets.forEach((target) => inputEvents.forEach((event) => target.removeEventListener(event, cancel)));
      targets.forEach((target) =>
        inputEvents.forEach((event) => target.addEventListener(event, cancel, { passive: true }))
      );

      // 某容器相对冻结锚点的当前偏差（像素）。null 表示锚点卡已不在 DOM
      // （列表被清空/条目被删），这种情况不应再校正。
      const driftOf = (saved) => {
        if (saved.entry.anchor === false || !saved.anchor) return 0;
        const element = resolve(saved.entry.element);
        if (!element) return null;
        const selector = anchorSelectorOf(saved.entry);
        const card = [...element.querySelectorAll(selector)].find(
          (node) => node.dataset.key === saved.anchor.key
        );
        if (!card) return null;
        const er = element.getBoundingClientRect();
        const cr = card.getBoundingClientRect();
        return cr.top - er.top - saved.anchor.offset;
      };
      const needsCorrection = () => {
        if (captureActive === false) return false;
        return (point || []).some((saved) => {
          const drift = driftOf(saved);
          return drift !== null && Math.abs(drift) > 0.5;
        });
      };

      let startedAt;
      const correct = (now) => {
        startedAt ??= now;
        if (version !== restoreVersion || now - startedAt >= settleMs) return cleanup();
        // 只在实际偏离锚点时校正一次；校正后布局若已稳定，下一帧自然归零收敛。
        if (needsCorrection()) apply();
        requestAnimationFrame(correct);
      };
      requestAnimationFrame(correct);
    }
    return true;
  };

  const restoreAfterRender = (options = {}) => {
    // 调用时冻结上下文及位置；nextTick 后只处理这份快照。
    const point = options.snapshot ?? stateSnapshot();
    return nextTick(() => restore({ ...options, snapshot: point }));
  };

  const clear = ({ stateKey, anchorKey } = {}) => {
    restoreVersion += 1;
    for (const { entry, stateKey: resolvedStateKey, anchorKey: resolvedAnchorKey, memory } of readEntries()) {
      const targetStateKey = stateKey ?? resolvedStateKey;
      const targetAnchorKey = anchorKey ?? resolvedAnchorKey;
      memory.delete(targetStateKey);
      if (entry.anchor !== false) anchors.delete(targetAnchorKey);
    }
  };

  return {
    capture,
    checkpoint,
    restore,
    restoreAfterRender,
    snapshot: stateSnapshot,
    suspend: () => {
      captureActive = false;
    },
    resume: () => {
      captureActive = true;
    },
    clear,
  };
};
