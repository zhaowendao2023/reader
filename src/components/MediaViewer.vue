<script setup>
import { invoke } from "@tauri-apps/api/core";
import { readDir, readFile } from "@tauri-apps/plugin-fs";
import { useBooks } from "../store/loadBooks";
import { dirCache, mediaDirKey, canonKey } from "../store/browserCache";
import { IMAGE_EXTS, extOf, joinPath, mimeForImage, imageDims } from "../utils/media";
import { getProgress, setProgress, flushProgress } from "../utils/progress";
import {
  displayCacheGet,
  displayCachePut,
  displayCacheSetDisplayed,
  displayCacheHas,
} from "../utils/displayCache";
import { enterSystemUIImmersive, exitSystemUIImmersive } from "../utils/systemBar";
import Icon from "./Icon.vue";

defineOptions({ name: "MediaViewer" });

const route = useRoute();
const router = useRouter();
const booksStore = useBooks();

// 移动端翻页靠滑动 + 底部 pill，画面上的侧边翻页箭头仅桌面端显示
const isAndroidViewer = computed(() => booksStore.platform === "android");

const images = ref([]);
const index = ref(0);
const url = ref("");
const loading = ref(true);
const error = ref("");
const permissionMissing = ref(false);
const stageRef = ref(null);
// 显示尺寸模型：applyFit 按图片宽高 + 舞台尺寸算出 zoom=1（contain 完整显示）的基准
// 宽高；缩放始终围绕舞台中心，fitStyle 综合缩放实时生成内联样式（绝对定位居中）。
const baseW = ref(0); // zoom=1 时图片显示宽（px）
const baseH = ref(0);
const stageW = ref(0);
const stageH = ref(0);
// 缩放：zoom=1 即最长边适应；双击 / Ctrl+滚轮 / 双指捏合调整。
// 放大后画面可能超出视口：单指/鼠标拖动平移（panX/panY 为相对居中位置的偏移）。
const zoom = ref(1);
const panX = ref(0);
const panY = ref(0);
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 8;
const fitStyle = computed(() => {
  if (!baseW.value || !baseH.value) return null;
  const w = baseW.value * zoom.value;
  const h = baseH.value * zoom.value;
  return {
    position: "absolute",
    left: `${(stageW.value - w) / 2 + panX.value}px`,
    top: `${(stageH.value - h) / 2 + panY.value}px`,
    width: `${w}px`,
    height: `${h}px`,
    maxWidth: "none",
    maxHeight: "none",
    objectFit: "contain",
  };
});
let lastNatural = null; // { w, h }，供窗口 resize 时重新铺满
let objectUrl = "";
let alive = true;
// 翻页竞态防护：连续快速滑动时，只应用最后一次 loadImage 的结果
let loadSeq = 0;
// 手势状态：单指滑动翻页（未放大）/ 拖动平移（放大后）+ 双指捏合缩放；单击仅用于双击检测
let swipeStart = null;
let pointers = new Map();
let pinchStart = null;
let suppressClick = false;
let gestureMoved = false; // 本次单指手势是否产生实际位移（滑动/平移）
let panStartX = 0;
let panStartY = 0;
// 连翻热态检测：2s 内再次翻页说明用户在看图间隙很短的连滑，多预取一张
let lastFlipAt = 0;
// ============ 原图直显模型 ============
// displayCache 直接缓存「原图」blob URL，不做任何下采样/重编码：
// Chrome 的 <img> 会按显示尺寸降采样解码（60MP 冷解码实测 ~18ms），
// 放大时用 blob URL 的 fragment 变体强制按新尺寸重解码（实测 ~15ms）→ 即时清晰。
const baseUrl = ref(""); // 当前图的无 fragment blob URL
const zoomBand = ref(""); // 当前已生效的缩放档位（'' / z2 / z4 / z8）
const dimsCache = new Map(); // path -> { w, h }（图片头部解析，1ms，不解码）
const dimsCacheMax = 1024;
let bandTimer = null;

const fileName = computed(() => {
  const p = images.value[index.value]?.path || route.query.path || route.query.name || "";
  return String(p).split(/[\\/]/).pop() || "图包";
});

// ============ 原图直显 ============
// 取显示数据：优先命中缓存（复用同一 object URL，浏览器解码缓存直接命中），
// 否则读盘 + 原图 blob URL 入缓存（LRU + 字节预算，见 utils/displayCache）。
// 不做自建下采样：Chrome <img> 按显示尺寸降采样解码（60MP 实测 ~18ms），
// 比 worker 重采样（~700ms）快两个数量级，且 zoom=1 清晰度优于 2048 webp 重编码。
const getDisplay = async (path) => {
  const hit = displayCacheGet(path);
  if (hit) return { url: hit.url, dims: dimsCache.get(path) || null };
  const bytes = await readFile(path);
  const dims = imageDims(bytes);
  if (dims) {
    dimsCache.set(path, dims);
    if (dimsCache.size > dimsCacheMax) dimsCache.delete(dimsCache.keys().next().value);
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeForImage(path) || "" }));
  // gif 不入缓存（动图可能很大且每次都是新 URL）；其余按预算 LRU 缓存
  if (extOf(path) !== "gif") displayCachePut(path, url, bytes.length);
  return { url, dims };
};

// 后台预取后续图：读盘 + 原图 URL 入 displayCache（无解码成本，几乎零开销）。
// 翻页命中缓存 → 换 src 后 Chrome 按显示尺寸解码（~20ms）秒开。
// gif 跳过（不入缓存，预取了也是泄漏）。
const prefetchNext = () => {
  if (!alive || images.value.length < 2) return;
  const i = index.value;
  const list = images.value;
  const targets = [];
  for (let k = 1; k <= 2; k++) {
    const p = list[i + k];
    if (p && extOf(p.path) !== "gif") targets.push(p.path);
  }
  // 连翻热态：距上次翻页不足 2s → 多预取一张，保证快速连滑不断档
  if (Date.now() - lastFlipAt < 2000) {
    const p3 = list[i + 3];
    if (p3 && extOf(p3.path) !== "gif") targets.push(p3.path);
  }
  for (const path of targets) getDisplay(path).catch(() => {});
};

// ============ 缩放档位：fragment 强制重解码 ============
// Chrome 放大时不会自动重解码（<img> 保持首次显示尺寸的位图）。
// 缩放停止后，把 src 切到「同一 blob URL + 档位 fragment」→ 触发浏览器
// 按新显示尺寸重解码（实测 ~15ms），放大即时清晰，无需 worker。
// 档位按 zoom 分 4 级，避免 decode 缓存无限膨胀（每档一份位图）。
const ZOOM_BANDS = [
  { max: 1.6, band: "" }, // ≤1.6×：适应尺寸附近，用基础 URL
  { max: 3.2, band: "z2" }, // ~2×
  { max: 6.4, band: "z4" }, // ~4×
  { max: Infinity, band: "z8" }, // ~8×
];
const bandForZoom = (z) => (ZOOM_BANDS.find((b) => z <= b.max) || ZOOM_BANDS[ZOOM_BANDS.length - 1]).band;

// 缩放停止（250ms 防抖）后应用档位：档位变了才换 src（触发重解码）
const applyZoomBand = () => {
  if (!baseUrl.value) return;
  const band = bandForZoom(zoom.value);
  if (band === zoomBand.value) return;
  zoomBand.value = band;
  url.value = band ? `${baseUrl.value}#${band}` : baseUrl.value;
};
const onZoomSettle = () => {
  clearTimeout(bandTimer);
  bandTimer = setTimeout(applyZoomBand, 250);
};
watch(zoom, onZoomSettle);

const loadImage = async (path) => {
  const seq = ++loadSeq;
  // 首图：无旧图可展示，显示加载态；翻页：旧图保持到新图位图就绪再瞬间替换。
  // 原图直显：换 src 后 Chrome 按显示尺寸降采样解码（~20ms），无需预解码。
  const first = !url.value;
  if (first) loading.value = true;
  error.value = "";
  try {
    const display = await getDisplay(path);
    // 期间又翻页了：丢弃这次过期结果（仍在缓存中的 URL 交给缓存，gif/被淘汰的才释放）
    if (!alive || seq !== loadSeq) {
      if (!displayCacheHas(display.url)) URL.revokeObjectURL(display.url);
      return;
    }
    // 释放上一张：仍被缓存（回看可复用）的保留；gif/被淘汰的由我们释放
    if (objectUrl && !displayCacheHas(objectUrl)) URL.revokeObjectURL(objectUrl);
    objectUrl = display.url;
    displayCacheSetDisplayed(display.url);
    // 尺寸来自图片头部解析（1ms，不解码）；applyFit 与换 src 在同一同步块，
    // Vue 同帧应用 → 元素尺寸和新图同时就位，无"旧图套新尺寸"的跳变。
    if (display.dims) {
      lastNatural = display.dims;
      applyFit();
    } else {
      lastNatural = null;
      baseW.value = 0;
      baseH.value = 0;
    }
    baseUrl.value = display.url;
    zoomBand.value = ""; // 翻页回到适应尺寸（zoom 已复位 1），用基础 URL
    url.value = display.url;
  } catch (e) {
    if (alive && seq === loadSeq) error.value = String(e);
  } finally {
    if (alive && seq === loadSeq) {
      if (first) loading.value = false;
      // 当前图已就绪，后台预取后续图（翻页命中缓存秒开）
      prefetchNext();
    }
  }
};

const pick = async (i) => {
  if (!images.value.length) return;
  lastFlipAt = Date.now();
  index.value = (i + images.value.length) % images.value.length;
  // 每张图从适应尺寸（zoom=1）开始
  resetZoom();
  await loadImage(images.value[index.value].path);
  savePackPosition();
};

// 图包模式才记进度（键 = 路由 id；单图无目录不记）。读到末尾由 getProgress 归零。
const packMode = computed(() => Boolean(route.query.dir));
const savePackPosition = () => {
  if (packMode.value && images.value.length > 1) {
    void setProgress(route.params.id, index.value);
  }
};

const next = () => pick(index.value + 1);
const prev = () => pick(index.value - 1);

const init = async () => {
  const single = route.query.path;
  const dir = route.query.dir;
  try {
    if (isAndroidViewer.value) {
      const ok = await invoke("check_all_files_access");
      permissionMissing.value = !ok;
      if (!ok) return;
    }
    if (typeof dir === "string" && dir) {
      // 复用模块级 dirCache：同一图包目录再次进入（返回再打开、重复路由）
      // 不再整目录 readDir；命名空间 key 与文件浏览器缓存互不覆盖。
      const ck = mediaDirKey(dir);
      let raw = dirCache.get(ck);
      if (!raw) {
        raw = await readDir(dir);
        dirCache.set(ck, raw);
      }
      const list = raw
        .filter((e) => e.isFile && IMAGE_EXTS.includes(extOf(e.name)))
        .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true }))
        .map((e) => ({ name: e.name, path: joinPath(dir, e.name) }));
      images.value = list;
      const norm = (p) =>
        booksStore.platform === "windows" ? String(p).toLowerCase() : String(p);
      let idx = 0;
      let singleHit = false;
      if (typeof single === "string" && single) {
        const found = list.findIndex((it) => norm(it.path) === norm(single));
        if (found >= 0) {
          idx = found;
          singleHit = true;
        }
      }
      if (!singleHit) {
        // 未指定具体图，或指定的 single 是目录/未命中（如从图包卡片打开整包）：
        // 从上次看到的图继续（读完自动归零，与漫画一致）
        const saved = await getProgress(route.params.id, list.length);
        if (saved > 0 && saved < list.length) idx = saved;
      }
      index.value = idx;
      if (list.length) {
        // 若定位到「继续看」页，立即写回一次，避免旧进度残留覆盖首次进入的 0
        savePackPosition();
        await loadImage(list[idx].path);
        return;
      }
    }
    if (typeof single === "string" && single) {
      await loadImage(single);
      return;
    }
    error.value = "缺少图片路径";
  } catch (e) {
    error.value = String(e);
  } finally {
    if (alive) loading.value = false;
  }
};

const openAllFilesSettings = async () => {
  try {
    await invoke("open_all_files_access_settings");
  } catch (e) {
    console.error("打开设置失败:", e);
  }
};

const retryPermission = () => init();

const onKey = (e) => {
  if (e.key === "ArrowRight") {
    e.preventDefault();
    next();
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    prev();
  } else if (e.key === "Escape") {
    goBack();
  }
};

const goBack = () => {
  if (window.history.length > 1) router.back();
  else router.push("/");
};

// 最长边适应：横图（宽>高）宽度撑满舞台、竖图/方图高度撑满舞台；
// 算出 zoom=1 时的基准宽高，缩放（围绕舞台中心）在此之上进行。
const applyFit = () => {
  const stage = stageRef.value;
  if (!stage || !lastNatural) return;
  const rect = stage.getBoundingClientRect();
  const sw = rect.width;
  const sh = rect.height;
  if (sw <= 0 || sh <= 0) return;
  stageW.value = sw;
  stageH.value = sh;
  // contain 适配：整图完整可见（等比缩放到两条边都不超出），而不是最长边顶满裁边。
  // 竖屏手机看竖图时若按高度顶满，宽度会超出视口被左右裁切（高度顶满的观感）；
  // contain 保证整张图完整显示，需要看细节再双击/捏合放大。
  const scale = Math.min(sw / lastNatural.w, sh / lastNatural.h);
  baseW.value = lastNatural.w * scale;
  baseH.value = lastNatural.h * scale;
  clampPan();
};

const onImgLoad = (e) => {
  const img = e.currentTarget;
  if (!img || !img.naturalWidth || !img.naturalHeight) return;
  // 预解码路径已按已知尺寸铺满；此处理论上幂等（同尺寸），作为解码失败时的兜底
  lastNatural = { w: img.naturalWidth, h: img.naturalHeight };
  applyFit();
};

// ============ 缩放（双击 / Ctrl+滚轮 / 双指捏合）与平移（放大后拖动）============
// 缩放围绕舞台中心；放大后画面可能超出视口，单指/鼠标拖动平移查看其余部分。
const clampPan = () => {
  const w = baseW.value * zoom.value;
  const h = baseH.value * zoom.value;
  // 该轴未溢出时锁定居中；溢出时允许在 [居中-溢出/2, 居中+溢出/2] 内平移，
  // 保证画面始终覆盖视口、不露出空白边缘。
  if (w <= stageW.value) panX.value = 0;
  else panX.value = Math.min((w - stageW.value) / 2, Math.max((stageW.value - w) / 2, panX.value));
  if (h <= stageH.value) panY.value = 0;
  else panY.value = Math.min((h - stageH.value) / 2, Math.max((stageH.value - h) / 2, panY.value));
};

const setZoom = (z) => {
  zoom.value = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  clampPan();
};
const resetZoom = () => {
  zoom.value = 1;
  panX.value = 0;
  panY.value = 0;
};

// 双击判定：不依赖原生 dblclick（部分环境/触摸不触发该事件），由两次 click 时序
// 手动判定。画面单击不翻页（翻页走左右滑动/箭头按钮/侧边按钮），单击无副作用。
const DBL_WINDOW = 300; // 双击判定窗口（ms）
let lastClick = null; // { t, x, y }

// 双击：zoom=1 时放大到 2.5 倍，否则回到适应尺寸（围绕舞台中心）
const applyDoubleClick = () => {
  if (zoom.value === 1) setZoom(2.5);
  else resetZoom();
};

// 悬浮栏显隐：上下栏（顶栏/底部翻页 pill）默认隐藏，单击画面切换显示/消失。
// 与双击放大并存：单击有延迟判定，若命中双击窗口则不再切换悬浮栏。
const showChrome = ref(false);
const toggleChrome = () => {
  showChrome.value = !showChrome.value;
};

// Ctrl+滚轮缩放（非被动监听，见 onMounted；Chrome 轨迹板双指捏合也走此事件）
const onStageWheel = (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const factor = Math.pow(1.15, -Math.sign(e.deltaY || 0));
  setZoom(zoom.value * factor);
};

// ============ 指针手势：单指滑动翻页 + 双指捏合缩放 ============
const pointerDist = () => {
  const [a, b] = [...pointers.values()];
  return Math.hypot(a.x - b.x, a.y - b.y);
};

const onStagePointerDown = (e) => {
  if (e.target.closest?.("button")) {
    swipeStart = null; // 从箭头按钮上起手的手势交给按钮本身
    return;
  }
  // 捕获指针：拖出舞台再松手也能收到 pointerup
  try {
    e.currentTarget.setPointerCapture?.(e.pointerId);
  } catch {
    /* 指针已失效时忽略 */
  }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    pinchStart = { dist: pointerDist(), zoom: zoom.value };
    swipeStart = null;
    gestureMoved = false;
  } else if (pointers.size === 1) {
    swipeStart = { x: e.clientX, y: e.clientY, t: Date.now() };
    panStartX = panX.value;
    panStartY = panY.value;
    gestureMoved = false;
  }
};

const onStagePointerMove = (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  p.x = e.clientX;
  p.y = e.clientY;
  // 双指捏合：按起始距离比缩放（围绕舞台中心）
  if (pointers.size === 2 && pinchStart && pinchStart.dist > 0) {
    setZoom(pinchStart.zoom * (pointerDist() / pinchStart.dist));
    return;
  }
  // 单指：放大后拖动 = 平移画面；未放大保持原样，松手时判定滑动翻页
  if (pointers.size === 1 && swipeStart) {
    const dx = e.clientX - swipeStart.x;
    const dy = e.clientY - swipeStart.y;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) gestureMoved = true;
    if (zoom.value > 1 && gestureMoved) {
      panX.value = panStartX + dx;
      panY.value = panStartY + dy;
      clampPan();
    }
  }
};

const onStagePointerUp = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size === 0) {
    if (!pinchStart && swipeStart) {
      if (zoom.value > 1) {
        // 放大态：本次手势是平移（或轻点）；有位移则抑制后续 click
        if (gestureMoved) {
          suppressClick = true;
          setTimeout(() => (suppressClick = false), 400);
        }
      } else {
        // 适应态：单指水平滑动翻页（左滑下一张/右滑上一张）
        const dx = e.clientX - swipeStart.x;
        const dy = e.clientY - swipeStart.y;
        const dt = Date.now() - swipeStart.t;
        if (images.value.length > 1 && dt <= 900 && Math.abs(dx) >= 56 && Math.abs(dx) > Math.abs(dy)) {
          suppressClick = true;
          setTimeout(() => (suppressClick = false), 400);
          if (dx < 0) next();
          else prev();
        }
      }
    }
    pinchStart = null;
    swipeStart = null;
    gestureMoved = false;
  } else if (pointers.size === 1 && pinchStart) {
    // 捏合中一根手指抬起：本次捏合结束，剩余手指不再触发翻页/平移起点重置
    pinchStart = null;
    swipeStart = null;
    gestureMoved = false;
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 400);
  }
};

const onStagePointerCancel = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size === 0) {
    pinchStart = null;
    swipeStart = null;
    gestureMoved = false;
  }
};

// 画面单击不翻页：仅用于双击检测（滑动/捏合后的遗留 click 被 suppressClick 抑制）
const onStageClick = (e) => {
  if (e.target.closest?.("button")) return;
  if (suppressClick) {
    suppressClick = false;
    lastClick = null;
    return;
  }
  const now = Date.now();
  const x = e.clientX;
  const y = e.clientY;
  if (lastClick && now - lastClick.t <= DBL_WINDOW && Math.abs(x - lastClick.x) <= 12 && Math.abs(y - lastClick.y) <= 12) {
    lastClick = null;
    applyDoubleClick();
    return;
  }
  lastClick = { t: now, x, y };
  // 延迟到双击窗口结束后判定为"单击"：命中双击则本次不切换悬浮栏
  setTimeout(() => {
    if (lastClick && now === lastClick.t) {
      lastClick = null;
      toggleChrome();
    }
  }, DBL_WINDOW + 30);
};

onMounted(async () => {
  alive = true;
  enterSystemUIImmersive();
  await init();
  window.addEventListener("keydown", onKey);
  window.addEventListener("resize", applyFit);
  // Ctrl+滚轮缩放需要 preventDefault（非被动），用命令式监听
  stageRef.value?.addEventListener("wheel", onStageWheel, { passive: false });
});

onUnmounted(() => {
  alive = false;
  clearTimeout(bandTimer);
  exitSystemUIImmersive();
  // 保存当前看图位置（防抖定时器可能还没触发写盘）
  savePackPosition();
  void flushProgress();
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("resize", applyFit);
  stageRef.value?.removeEventListener("wheel", onStageWheel);
  // 释放组件自持的 URL（gif/被淘汰的）；缓存内（回看可复用）的交给 displayCache
  if (objectUrl && !displayCacheHas(objectUrl)) URL.revokeObjectURL(objectUrl);
  objectUrl = "";
  displayCacheSetDisplayed("");
});
</script>

<template>
  <div class="media-page" :class="{ 'show-chrome': showChrome }">
    <span class="ghost-word">图</span>

    <header class="top-chrome" data-tauri-drag-region>
      <button class="circle-btn" title="返回" @click="goBack">
        <Icon id="arrow-left" :size="18" />
      </button>
      <div class="head-titles" data-tauri-drag-region>
        <div class="kicker">02 / IMAGE · 图包放映</div>
        <h1 class="head-title" data-tauri-drag-region>{{ fileName }}</h1>
      </div>
      <div class="top-drag" data-tauri-drag-region></div>
      <div v-if="images.length" class="head-meta mono">
        {{ String(index + 1).padStart(2, "0") }} / {{ String(images.length).padStart(2, "0") }}
      </div>
    </header>

    <div
      ref="stageRef"
      class="stage"
      :class="{ zoomed: zoom > 1 }"
      @click="onStageClick"
      @pointerdown="onStagePointerDown"
      @pointermove="onStagePointerMove"
      @pointerup="onStagePointerUp"
      @pointercancel="onStagePointerCancel"
    >
      <img
        v-if="url"
        :src="url"
        class="media-img"
        :style="fitStyle"
        alt=""
        draggable="false"
        @load="onImgLoad"
      />
      <div v-else-if="loading" class="stage-note">
        <Icon id="loader-circle" :size="22" class="spin" />
        <span>正在载入图包</span>
      </div>
      <div v-else-if="permissionMissing" class="stage-note permission-note">
        <Icon id="scan" :size="40" />
        <strong>需要开启所有文件访问权限</strong>
        <span>开启后才能读取影视图集中的原图</span>
        <div class="permission-actions">
          <button class="permission-btn primary" @click.stop="openAllFilesSettings">去开启</button>
          <button class="permission-btn" @click.stop="retryPermission">我已开启，继续</button>
        </div>
      </div>
      <div v-else-if="error" class="stage-note">{{ error }}</div>
      <div v-else class="stage-note">没有可显示的图片</div>

      <button v-if="images.length > 1 && !isAndroidViewer" class="side-arrow side-arrow--prev" title="上一张" @click.stop="prev">
        <Icon id="chevron-left" :size="20" />
      </button>
      <button v-if="images.length > 1 && !isAndroidViewer" class="side-arrow side-arrow--next" title="下一张" @click.stop="next">
        <Icon id="chevron-right" :size="20" />
      </button>
    </div>

    <footer class="bottom-chrome">
      <div class="pill">
        <button class="pill-btn" :disabled="images.length < 2" title="上一张" @click="prev">
          <Icon id="chevron-left" :size="17" />
        </button>
        <span class="pill-divider"></span>
        <div class="pill-center">
          <span class="pill-label mono">IMAGE PACK</span>
          <span class="pill-count mono">
            {{ images.length ? `${String(index + 1).padStart(2, "0")} / ${String(images.length).padStart(2, "0")}` : "-- / --" }}
          </span>
        </div>
        <span class="pill-divider"></span>
        <button class="pill-btn" :disabled="images.length < 2" title="下一张" @click="next">
          <Icon id="chevron-right" :size="17" />
        </button>
      </div>
    </footer>
  </div>
</template>

<style scoped lang="scss">
.media-page {
  --p-bg: #050506;
  --p-panel: rgba(10, 10, 14, 0.72);
  --p-line: rgba(255, 255, 255, 0.09);
  --p-text: #f4f1e9;
  --p-text-2: rgba(244, 241, 233, 0.58);
  --p-text-3: rgba(244, 241, 233, 0.32);
  --p-accent: #5b8cff;
  --p-accent-2: #9db8ff;

  position: fixed;
  inset: 0;
  overflow: hidden;
  background:
    radial-gradient(70% 52% at 82% -8%, rgba(91, 140, 255, 0.08), transparent 58%),
    radial-gradient(48% 42% at -6% 108%, rgba(255, 92, 57, 0.035), transparent 60%),
    var(--p-bg);
  color: var(--p-text);
}

.ghost-word {
  position: absolute;
  top: 18px;
  right: 2vw;
  z-index: 0;
  font-family: var(--serif);
  font-size: clamp(180px, 26vw, 420px);
  font-weight: 900;
  line-height: 0.9;
  color: transparent;
  -webkit-text-stroke: 1px rgba(244, 241, 233, 0.04);
  pointer-events: none;
  user-select: none;
}

.top-chrome {
  position: absolute;
  top: 16px;
  left: 22px;
  right: 22px;
  height: 64px;
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 10px 0 12px;
  border: 1px solid var(--p-line);
  border-radius: 18px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.045), rgba(255, 255, 255, 0.012)),
    rgba(8, 8, 12, 0.58);
  backdrop-filter: blur(22px) saturate(1.3);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
  opacity: 0;
  transform: translateY(-12px);
  pointer-events: none;
  transition: opacity 0.3s var(--ease-out), transform 0.3s var(--ease-out);

  .show-chrome & {
    opacity: 1;
    transform: translateY(0);
    pointer-events: auto;
  }
}

.circle-btn {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border: 1px solid var(--p-line);
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.045);
  color: var(--p-text-2);
  cursor: pointer;
  backdrop-filter: blur(10px);
  transition: transform 0.25s var(--ease-out), border-color 0.25s, color 0.25s;

  &:hover {
    color: #fff;
    border-color: rgba(255, 255, 255, 0.34);
    background: rgba(255, 255, 255, 0.08);
    transform: translateY(-1px);
  }
}

.head-titles {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;

  .kicker {
    color: var(--p-text-3);
  }
}

.top-drag {
  flex: 1 1 auto;
  align-self: stretch;
  min-width: 48px;
  height: 100%;
}

.head-title {
  font-family: var(--serif);
  font-size: clamp(16px, 1.8vw, 22px);
  font-weight: 800;
  letter-spacing: 0.04em;
  line-height: 1.15;
  color: var(--p-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.head-meta {
  margin-left: auto;
  padding: 6px 12px;
  border: 1px solid var(--p-line);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.03);
  color: var(--p-text-2);
  font-size: 10px;
  letter-spacing: 0.16em;
  backdrop-filter: blur(10px);
}

.stage {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: grid;
  /* 确定轨道尺寸：place-items 居中时，超出舞台的图片上下/左右对称裁切 */
  grid-template-columns: 100%;
  grid-template-rows: 100%;
  place-items: center;
  overflow: hidden;
  /* 手势全权交给 JS：单指滑动翻页/拖动平移、双指捏合缩放（舞台本身不滚动，无损失） */
  touch-action: none;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent 30%),
    #000;

  &.zoomed {
    cursor: grab;
  }

  &::after {
    content: "";
    position: absolute;
    inset: 0;
    z-index: 1;
    pointer-events: none;
    background: radial-gradient(130% 100% at 50% 50%, transparent 76%, rgba(0, 0, 0, 0.2) 100%);
  }
}

.media-img {
  position: relative;
  z-index: 2;
  /* 回落态：完整显示；图片加载完成并由 applyFit 写入内联像素样式后覆盖 */
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 4px;
  /* 翻页不做淡入淡出/缩放动画：新图就绪后瞬间替换，避免看起来卡顿 */
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);
  user-select: none;
}

.stage-note {
  position: relative;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 12px;
  color: var(--p-text-3);
  font-family: var(--mono);
  font-size: 13px;
  letter-spacing: 0.12em;
}

.permission-note {
  flex-direction: column;
  gap: 10px;
  text-align: center;

  strong {
    color: var(--p-text);
    font-size: 16px;
  }

  span {
    max-width: 320px;
    line-height: 1.6;
  }
}

.permission-actions {
  display: flex;
  gap: 10px;
  margin-top: 8px;
}

.permission-btn {
  height: 38px;
  padding: 0 16px;
  border: 1px solid var(--p-line);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--p-text-2);
  cursor: pointer;

  &.primary {
    border-color: rgba(91, 140, 255, 0.55);
    background: rgba(91, 140, 255, 0.2);
    color: var(--p-text);
  }
}

.side-arrow {
  position: absolute;
  top: 50%;
  z-index: 3;
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border: 1px solid var(--p-line);
  border-radius: 50%;
  background: rgba(8, 8, 12, 0.5);
  color: var(--p-text-2);
  cursor: pointer;
  opacity: 0;
  transform: translateY(-50%) scale(0.9);
  transition: opacity 0.3s var(--ease-out), transform 0.3s var(--ease-out), color 0.25s, border-color 0.25s;
  backdrop-filter: blur(12px);

  &--prev {
    left: 18px;
  }
  &--next {
    right: 18px;
  }

  &:hover {
    color: #fff;
    border-color: rgba(255, 255, 255, 0.32);
    background: rgba(255, 255, 255, 0.08);
  }
}

/* 侧边翻页箭头跟随悬浮栏显隐（不再依赖 hover，手机端同样可点） */
.show-chrome .side-arrow {
  opacity: 1;
  transform: translateY(-50%) scale(1);
}

.bottom-chrome {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 18px;
  z-index: 4;
  display: flex;
  justify-content: center;
  opacity: 0;
  transform: translateY(12px);
  pointer-events: none;
  transition: opacity 0.3s var(--ease-out), transform 0.3s var(--ease-out);

  .show-chrome & {
    opacity: 1;
    transform: translateY(0);
    pointer-events: auto;
  }
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 999px;
  border: 1px solid var(--p-line);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.045), rgba(255, 255, 255, 0.012)),
    rgba(8, 8, 12, 0.58);
  backdrop-filter: blur(22px) saturate(1.3);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
}

.pill-btn {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--p-text-2);
  cursor: pointer;
  transition: color 0.25s, background 0.25s, transform 0.25s var(--ease-out);

  &:hover:not(:disabled) {
    color: #fff;
    background: rgba(255, 255, 255, 0.08);
    transform: translateY(-1px);
  }

  &:disabled {
    opacity: 0.35;
    cursor: default;
  }
}

.pill-divider {
  width: 1px;
  height: 20px;
  background: var(--p-line);
}

.pill-center {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 6px;
}

.pill-label {
  font-size: 8.5px;
  letter-spacing: 0.24em;
  color: var(--p-text-3);
  white-space: nowrap;
}

.pill-count {
  min-width: 64px;
  text-align: center;
  font-size: 11px;
  letter-spacing: 0.16em;
  color: var(--p-text-2);
}
</style>
