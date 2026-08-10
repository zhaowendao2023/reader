<script setup>
import { writeFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { useBooks } from "../store/loadBooks";
import { getComic } from "../utils/bookData";

const index = inject("index");
const toces = inject("toces");
const containerRef = ref(null);
const bookInfo = inject("bookInfo");

const book = ref(null);
const pageSlots = ref([]);
const current = ref(0);
const loadedCount = ref(0);
const loadTiming = ref(null);
const maxPageMs = ref(0);

// 渲染窗口：当前页前后各 WINDOW 页；卸载阈值 BUFFER 稍大，避免来回滚动反复加载
const WINDOW = 3;
const BUFFER = 6;
const MAX_CONCURRENT = 4;

let loadStart = 0;
let firstPageMs = null;
let observer = null;
const queue = [];
const queued = new Set();
const loading = new Set();
let active = 0;

const getImageSize = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error("图片解码失败"));
    img.src = src;
  });

const loadPage = async (i) => {
  const slot = pageSlots.value[i];
  const t0 = performance.now();
  try {
    const url = await book.value.sections[i].load();
    const dim = await getImageSize(url);
    const keepLo = Math.max(0, current.value - BUFFER);
    const keepHi = Math.min(pageSlots.value.length - 1, current.value + BUFFER);
    // 加载期间窗口已经移走：直接回收，不写入界面
    if (i < keepLo || i > keepHi) {
      book.value.sections[i].unload();
      return;
    }
    slot.src = url;
    slot.w = dim.w;
    slot.h = dim.h;
    loadedCount.value++;
    const pageMs = performance.now() - t0;
    if (pageMs > maxPageMs.value) maxPageMs.value = pageMs;
    if (firstPageMs === null) {
      firstPageMs = performance.now() - loadStart;
      requestAnimationFrame(() => {
        loadTiming.value = {
          ...loadTiming.value,
          firstPage: firstPageMs,
          maxPage: maxPageMs.value,
          loaded: loadedCount.value,
        };
        saveTiming({ ...loadTiming.value });
      });
    }
  } catch (error) {
    console.error(`加载第 ${i} 页失败:`, error);
  }
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
  current.value = id;
  index.value.nowIndex = id;
  updateWindow();
  containerRef.value.children[id]?.scrollIntoView({ behavior: "smooth" });
};

const left = () => {
  const i = current.value - 1;
  if (i >= 0) jump(i);
};

const right = () => {
  const i = current.value + 1;
  if (i < pageSlots.value.length) jump(i);
};

onMounted(async () => {
  loadStart = performance.now();
  try {
    const result = await getComic(bookInfo.value.path);
    book.value = result.book;
    toces.value = result.toces;
    index.value.total = book.value.sections.length;
    pageSlots.value = book.value.sections.map((s) => ({ id: s.id, src: null, w: null, h: null }));
    loadTiming.value = { ...result.timing, loaded: 0 };
    await nextTick();
    setupObserver();
    updateWindow();
  } catch (error) {
    console.error("打开漫画失败:", error);
  }
});

onUnmounted(() => {
  observer?.disconnect();
  book.value?.destroy?.();
});

const saveTiming = async (timing) => {
  try {
    const testPath = await invoke("get_test_file");
    if (!testPath) return;
    const content = new TextEncoder().encode(
      JSON.stringify({ file: testPath, ...timing, at: new Date().toISOString() })
    );
    await writeFile("resource/data/timing.json", content, { baseDir: useBooks().baseSrc });
  } catch (error) {
    console.error("写入计时失败:", error);
  }
};

defineExpose({ left, right, jump });
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
      <img v-if="slot.src" :src="slot.src" decoding="async" alt="" />
    </div>
  </div>
  <div v-if="loadTiming" class="timing-overlay">
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
