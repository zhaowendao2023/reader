<script setup>
import { getComic } from "../utils/bookData";
import { getProgress } from "../utils/progress";
import { useSettings } from "../store/settings";

const index = inject("index");
const toces = inject("toces");
const containerRef = ref(null);
const bookInfo = inject("bookInfo");
const bookId = inject("bookId");
const progressReady = inject("progressReady");

const book = ref(null);
const pageSlots = ref([]);
const current = ref(0);
const loadedCount = ref(0);
const loadTiming = ref(null);
const maxPageMs = ref(0);

const settings = useSettings();

// 渲染窗口：当前页前后各 WINDOW 页；卸载阈值 BUFFER 稍大，避免来回滚动反复加载
const WINDOW = 3;
const BUFFER = 6;
// 解压 + 解码都在主线程，并发太高会让大图互相抢 CPU、挤掉解码缓存，反而拖慢第一帧
const MAX_CONCURRENT = 2;
// 长距离跳页直接瞬移：smooth 滚动 + 懒加载让目标页布局不断被推远，动画追不上会停在中间页。
// ≤ SMOOTH_MAX_DISTANCE 页的短距离（上一页/下一页/键盘步进）保留平滑动画。
const SMOOTH_MAX_DISTANCE = 5;
// 拖动滑块时值连续变化：防抖合并滚动，松手后才真正跳一次，避免每帧 scrollIntoView 互相打断
const SLIDER_DEBOUNCE_MS = 250;

let sliderTimer = null;
let sliderOrigin = 0;
let sliderActive = false;

let loadStart = 0;
let firstPageMs = null;
let observer = null;
const queue = [];
const queued = new Set();
const loading = new Set();
let active = 0;

const loadPage = async (i) => {
  const slot = pageSlots.value[i];
  const t0 = performance.now();
  try {
    const url = await book.value.sections[i].load();
    const keepLo = Math.max(0, current.value - BUFFER);
    const keepHi = Math.min(pageSlots.value.length - 1, current.value + BUFFER);
    // 加载期间窗口已经移走：直接回收，不写入界面
    if (i < keepLo || i > keepHi) {
      book.value.sections[i].unload();
      return;
    }
    slot.t0 = t0; // 供 img load 事件统计整页耗时（解压 + 解码）
    slot.src = url; // blob 就绪立即上屏，解码由 <img> 自身完成，避免二次解码
    loadedCount.value++;
  } catch (error) {
    console.error(`加载第 ${i} 页失败:`, error);
  }
};

// 尺寸来自真实上屏的 <img>：解码只发生一次，load 事件就是“这一页真的能看见”的时刻
const onImgLoad = (i, event) => {
  const slot = pageSlots.value[i];
  if (!slot || !slot.src) return;
  const img = event.target;
  slot.w = img.naturalWidth;
  slot.h = img.naturalHeight;
  if (slot.t0) {
    const pageMs = performance.now() - slot.t0;
    if (pageMs > maxPageMs.value) maxPageMs.value = pageMs;
  }
  if (firstPageMs === null) {
    firstPageMs = performance.now() - loadStart;
    requestAnimationFrame(() => {
      loadTiming.value = {
        ...loadTiming.value,
        firstPage: firstPageMs,
        maxPage: maxPageMs.value,
        loaded: loadedCount.value,
      };
    });
  }
};

const onImgError = (i, event) => {
  console.error(`第 ${i} 页图片解码失败:`, event);
};

const pump = () => {
  while (active < MAX_CONCURRENT && queue.length) {
    const i = queue.shift();
    queued.delete(i);
    loading.add(i);
    active++;
    loadPage(i).finally(() => {
      active--;
      loading.delete(i);
      pump();
    });
  }
};

const updateWindow = () => {
  if (!book.value || !pageSlots.value.length) return;
  const total = pageSlots.value.length;
  const lo = Math.max(0, current.value - WINDOW);
  const hi = Math.min(total - 1, current.value + WINDOW);
  const keepLo = Math.max(0, current.value - BUFFER);
  const keepHi = Math.min(total - 1, current.value + BUFFER);

  // 回收离开缓冲区的页面
  for (let i = 0; i < total; i++) {
    const slot = pageSlots.value[i];
    if (slot.src && (i < keepLo || i > keepHi)) {
      book.value.sections[i]?.unload();
      slot.src = null;
      slot.w = null;
      slot.h = null;
    }
  }

  // 按离当前页的距离排队加载，近的优先
  const need = [];
  for (let d = 0; d <= WINDOW; d++) {
    for (const i of [current.value - d, current.value + d]) {
      if (
        i >= lo && i <= hi && i >= 0 && i < total &&
        !pageSlots.value[i].src && !loading.has(i) && !queued.has(i)
      ) {
        need.push(i);
        queued.add(i);
      }
    }
  }
  queue.push(...need);
  pump();
};

const setupObserver = () => {
  observer = new IntersectionObserver(
    (entries) => {
      let first = -1;
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const key = Number(entry.target.dataset.key);
          if (key >= 0 && (first === -1 || key < first)) first = key;
        }
      }
      if (first !== -1 && first !== current.value) {
        current.value = first;
        index.value.nowIndex = first;
        updateWindow();
      }
    },
    { root: containerRef.value, threshold: 0.05 }
  );
  for (const child of containerRef.value.children) observer.observe(child);
};

const jump = (id) => {
  const prev = current.value;
  const far = Math.abs(id - prev) > SMOOTH_MAX_DISTANCE;
  current.value = id;
  index.value.nowIndex = id;
  updateWindow();
  containerRef.value.children[id]?.scrollIntoView({ behavior: far ? "auto" : "smooth" });
};

const left = () => {
  const i = current.value - 1;
  if (i >= 0) jump(i);
};

const right = () => {
  const i = current.value + 1;
  if (i < pageSlots.value.length) jump(i);
};

// 底部滑块跳页：id 为 0 基页码。拖动过程中值连续变化，
// 只更新索引（dock 页码跟随），防抖后按最终目标一次性加载窗口并跳页，
// 避免每帧 smooth 滚动互相打断、以及目标页被 updateWindow 卸载导致滚不到。
const slider = (id) => {
  if (!sliderActive) {
    sliderActive = true;
    sliderOrigin = current.value; // 拖动/点击开始时的真实页（滚动起点）
  }
  current.value = id;
  index.value.nowIndex = id;
  if (sliderTimer) clearTimeout(sliderTimer);
  sliderTimer = setTimeout(() => {
    sliderTimer = null;
    sliderActive = false;
    updateWindow(); // 按最终目标页加载窗口（目标页 ± WINDOW）
    const far = Math.abs(id - sliderOrigin) > SMOOTH_MAX_DISTANCE;
    containerRef.value.children[id]?.scrollIntoView({ behavior: far ? "auto" : "smooth" });
  }, SLIDER_DEBOUNCE_MS);
};

onMounted(async () => {
  loadStart = performance.now();
  try {
    const result = await getComic(bookInfo.value.path);
    book.value = result.book;
    toces.value = result.toces;
    index.value.total = book.value.sections.length;
    pageSlots.value = book.value.sections.map((s) => ({ id: s.id, src: null, w: null, h: null, t0: 0 }));
    loadTiming.value = { ...result.timing, loaded: 0 };
    await nextTick();
    setupObserver();
    updateWindow();
    const start = await getProgress(bookId.value, index.value.total);
    if (start > 0) jump(start);
    progressReady.value = true;
  } catch (error) {
    console.error("打开漫画失败:", error);
  }
});

onUnmounted(() => {
  observer?.disconnect();
  if (sliderTimer) clearTimeout(sliderTimer);
  book.value?.destroy?.();
});

defineExpose({ left, right, jump, slider });
</script>

<template>
  <div ref="containerRef" class="img-list">
    <div
      v-for="(slot, i) in pageSlots"
      :key="slot.id"
      class="page-slot"
      :class="{ 'page-slot--loaded': slot.w }"
      :data-key="i"
      :style="slot.w ? { aspectRatio: `${slot.w} / ${slot.h}` } : null"
    >
      <img
        v-if="slot.src"
        :src="slot.src"
        decoding="async"
        alt=""
        @load="onImgLoad(i, $event)"
        @error="onImgError(i, $event)"
      />
    </div>
  </div>
  <div v-if="loadTiming && settings.showParseTiming" class="timing-overlay">
    <div>打开总耗时(首帧): {{ (loadTiming.firstPage ?? loadTiming.total).toFixed(0) }} ms</div>
    <div>
      解析 {{ loadTiming.open.toFixed(0) }} ms · 已加载 {{ loadedCount }}/{{ pageSlots.length }} 页 ·
      单页最慢 {{ maxPageMs.toFixed(0) }} ms
    </div>
  </div>
</template>

<style scoped lang="scss">
.img-list {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow-y: auto;
  scrollbar-width: none;
  background: var(--bgc, #0d0d10);
  transition: background-color 0.3s var(--ease-in-out);
}

.page-slot {
  width: 100%;
  flex-shrink: 0;
  min-height: 100vh;
  content-visibility: auto;
  contain-intrinsic-size: auto 100vh;
  background-color: var(--bgc, #0d0d10);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}

.page-slot--loaded {
  min-height: 0;
}

.page-slot img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  filter: drop-shadow(0 10px 40px rgba(0, 0, 0, 0.45));
}

.timing-overlay {
  position: fixed;
  top: 74px;
  right: 16px;
  z-index: 200;
  padding: 8px 12px;
  background: var(--panel);
  backdrop-filter: blur(14px);
  border: 1px solid var(--line);
  color: var(--text-2);
  border-radius: 12px;
  font-size: 11px;
  line-height: 1.6;
  font-family: var(--mono);
  letter-spacing: 0.04em;
  pointer-events: none;
  text-align: right;
}
</style>
