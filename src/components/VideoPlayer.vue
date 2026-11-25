<script setup>
import { invoke } from "@tauri-apps/api/core";
import { Window } from "@tauri-apps/api/window";
import { readDir } from "@tauri-apps/plugin-fs";
import { useBooks } from "../store/loadBooks";
import { useSettings } from "../store/settings";
import { VIDEO_EXTS, extOf, joinPath } from "../utils/media";
import { covers, canonKey, dirCache, mediaDirKey, enqueueCover } from "../store/browserCache";
import { calculateHash } from "../utils/utils";
import { flushProgress, getVideoProgressEntry, getVideoProgressMap, setVideoProgress } from "../utils/progress";
import { closeContextMenu, openContextMenu, openGenericMenu } from "../utils/contextMenu";
import { useItemActions } from "../utils/itemActions";
import { useCellLongPress } from "../utils/longPress";
import { enterSystemUIImmersive, exitSystemUIImmersive } from "../utils/systemBar";
import Icon from "./Icon.vue";

defineOptions({ name: "VideoPlayer" });

const route = useRoute();
const router = useRouter();
const appWindow = new Window("main");
const booksStore = useBooks();
const settings = useSettings();
// 视频后端命令前缀：Android 走 VideoPlugin（video_*），桌面走 mpv（mpv_*）。
// 两边命令语义 1:1 对齐，UI/轮询逻辑完全复用。
const isAndroid = computed(() => booksStore.platform === "android");
const vcmd = (name) => (isAndroid.value ? `video_${name}` : `mpv_${name}`);

const stage = ref(null);
const hole = reactive({ x: 0, y: 0, w: 0, h: 0 });
const currentFile = ref("");
const files = ref([]);
const index = ref(0);
const state = ref(null);
const error = ref("");
const loading = ref(true);
const playlistOpen = ref(false);
const chromeVisible = ref(true);
const fullscreen = ref(false);
const dragPos = ref(null);
const volume = ref(100);
const volumeOpen = ref(false);
const speedOpen = ref(false);
const brightness = ref(100);
const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const playbackSpeed = ref(SPEED_OPTIONS.includes(settings.videoPlaybackSpeed) ? settings.videoPlaybackSpeed : 1);
// 移动端手势：横滑进度、左半屏上下滑亮度、右半屏上下滑音量、长按临时 2×。
const gesture = reactive({
  active: false,
  moved: false,
  direction: null, // horizontal | vertical
  type: "volume", // brightness | volume
  side: "left",
  value: 0,
  startX: 0,
  startY: 0,
  lastY: 0,
  startPosition: 0,
  previewPosition: null,
  pressTimer: null,
  longPressActive: false,
  restoreSpeed: 1,
});
const playbackHud = reactive({
  visible: false,
  type: "seek",
  side: "center",
  icon: "",
  primary: "",
  secondary: "",
  hideTimer: null,
});
const volumeIcon = computed(() =>
  volume.value === 0 ? "volume-x" : volume.value < 50 ? "volume-1" : "volume-2"
);
const speedLabel = computed(() => `${Number(playbackSpeed.value).toFixed(2).replace(/\.00$/, "").replace(/0$/, "")}×`);
const { copyPath, revealPath, requestDelete } = useItemActions({
  onDeleted: async (item) => {
    const removedKey = canonKey(item.path || item.key);
    const wasCurrent = canonKey(currentFile.value) === removedKey;
    const oldIndex = index.value;
    files.value = files.value.filter((f) => canonKey(f.path) !== removedKey);
    if (!files.value.length) {
      currentFile.value = "";
      state.value = null;
      await invoke(vcmd("stop"), { id: 0 }).catch(() => {});
      return;
    }
    if (wasCurrent) {
      index.value = Math.min(oldIndex, files.value.length - 1);
      await play(files.value[index.value].path);
    } else if (index.value >= files.value.length) {
      index.value = files.value.length - 1;
    }
  },
});
let timer = null;
let idleTimer = null;
let chromeResizeTimer = null;
let volumeTimer = null;
let brightnessTimer = null;
let volumeSynced = false;
let stageClickTimer = null;
let resizeRaf = null;
let stageObserver = null;
let alive = true;
let wasPlaying = false;
let lastNonZeroVolume = 100;
let speedCommandChain = Promise.resolve(1);

const RESUME_MIN_SECONDS = 5;
const RESUME_END_GUARD_SECONDS = 10;
const SAVE_DELTA_SECONDS = 2;
let resumeAt = null;
let resumeFor = null;
let lastSavedItem = null;
let lastSavedPos = null;
const itemIdCache = new Map();
const playlistMap = new Map();
const rebuildPlaylistMap = () => {
  playlistMap.clear();
  for (const f of files.value) playlistMap.set(f.path, f);
};
watch(files, rebuildPlaylistMap, { immediate: true });

const fileName = computed(() => {
  const p = currentFile.value;
  if (!p) return "";
  return p.split(/[\\/]/).pop() || p;
});

const seekFill = computed(() => {
  const dur = state.value?.duration || 0;
  const pos = dragPos.value ?? state.value?.position ?? 0;
  if (!dur) return 0;
  return Math.min(100, Math.max(0, (pos / dur) * 100));
});

const isPlaylist = computed(() => route.query.playlist === "1");

const showPlaybackHud = ({ type, side = "center", icon = "", primary, secondary = "", hold = false }) => {
  playbackHud.type = type;
  playbackHud.side = side;
  playbackHud.icon = icon;
  playbackHud.primary = primary;
  playbackHud.secondary = secondary;
  playbackHud.visible = true;
  clearTimeout(playbackHud.hideTimer);
  if (!hold) {
    playbackHud.hideTimer = setTimeout(() => {
      playbackHud.visible = false;
    }, 900);
  }
};

const hidePlaybackHud = () => {
  clearTimeout(playbackHud.hideTimer);
  playbackHud.visible = false;
};

// 串行倍速命令，保证“长按刚触发就松手”时恢复命令一定最后执行。
const invokeSpeed = (speed) => {
  const target = Math.max(0.5, Math.min(2, Number(speed) || 1));
  const task = speedCommandChain
    .catch(() => 1)
    .then(() => invoke(vcmd("set_speed"), { id: 0, speed: target }))
    .then((actual) => Math.max(0.5, Math.min(2, Number(actual) || target)));
  speedCommandChain = task;
  return task;
};

const rect = () => {
  const r = stage.value?.getBoundingClientRect();
  if (!r) return { x: 0, y: 0, width: 0, height: 0 };
  const dpr = window.devicePixelRatio || 1;
  return {
    x: Math.round(r.x * dpr),
    y: Math.round(r.y * dpr),
    width: Math.round(r.width * dpr),
    height: Math.round(r.height * dpr),
  };
};

const backdropStyle = computed(() => ({
  "--hole-x": `${hole.x}px`,
  "--hole-y": `${hole.y}px`,
  "--hole-w": `${hole.w}px`,
  "--hole-h": `${hole.h}px`,
}));

const syncHole = () => {
  const r = stage.value?.getBoundingClientRect();
  if (!r) return;
  hole.x = Math.round(r.left);
  hole.y = Math.round(r.top);
  hole.w = Math.round(r.width);
  hole.h = Math.round(r.height);
};

const itemIdOf = async (path) => {
  const key = canonKey(path);
  if (itemIdCache.has(key)) return itemIdCache.get(key);
  const id = await calculateHash(key);
  itemIdCache.set(key, id);
  return id;
};

const currentStateMatches = (s) => {
  if (!s || typeof s.path !== "string" || !s.path) return false;
  return canonKey(s.path) === canonKey(currentFile.value);
};

const saveNow = async () => {
  const s = state.value;
  const path = currentFile.value;
  if (!path || !s || !currentStateMatches(s)) return;
  if (!s.duration || !Number.isFinite(s.position) || s.position <= 0) return;
  const id = await itemIdOf(path);
  if (lastSavedItem === id && lastSavedPos != null && Math.abs(s.position - lastSavedPos) < SAVE_DELTA_SECONDS) return;
  lastSavedItem = id;
  lastSavedPos = s.position;
  await setVideoProgress(id, s.position);
};

const play = async (path) => {
  try {
    wasPlaying = false;
    lastSavedItem = null;
    lastSavedPos = null;
    const id = await itemIdOf(path);
    const record = await getVideoProgressEntry(id);
    resumeAt = record && record.position >= RESUME_MIN_SECONDS ? record.position : null;
    resumeFor = resumeAt != null ? path : null;
    await invoke(vcmd("play"), { id: 0, path, ...rect() });
    currentFile.value = path;
    error.value = "";
    try {
      playbackSpeed.value = await invokeSpeed(settings.videoPlaybackSpeed);
    } catch (speedError) {
      playbackSpeed.value = 1;
      error.value = String(speedError);
    }
  } catch (e) {
    resumeAt = null;
    resumeFor = null;
    error.value = String(e);
  }
};

const loadPath = async (path) => {
  if (!path) {
    error.value = "缺少视频路径";
    loading.value = false;
    return;
  }
  loading.value = true;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    if (isPlaylist.value) {
      await loadPlaylist(path);
    } else {
      files.value = [];
      index.value = 0;
      await play(path);
    }
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
};

const loadPlaylist = async (dirPath) => {
  // 复用模块级 dirCache（与 MediaViewer 同一命名空间 key）：
  // 播放器生命周期内最多 readDir 一次，重复进入同一目录不再整目录重读。
  const ck = mediaDirKey(dirPath);
  let raw = dirCache.get(ck);
  if (!raw) {
    raw = await readDir(dirPath);
    dirCache.set(ck, raw);
  }
  const list = raw
    .filter((e) => e.isFile && VIDEO_EXTS.includes(extOf(e.name)))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map((e) => ({ name: e.name, path: joinPath(dirPath, e.name) }));
  if (!list.length) {
    error.value = "文件夹里没有视频";
    return;
  }
  files.value = list;
  // 播放列表行缩略图：后台低优先级提取
  for (const f of list) enqueueCover(f.path, false, "video");
  // 若传入的是具体文件，优先从它开始播放
  const single = route.query.path;
  const norm = (p) => String(p).replace(/\//g, "\\").toLowerCase();
  const explicitHit =
    typeof single === "string" && single ? list.findIndex((f) => norm(f.path) === norm(single)) : -1;
  let start = 0;
  if (explicitHit >= 0) {
    start = explicitHit;
  } else {
    const videoProgress = await getVideoProgressMap();
    const ids = await Promise.all(list.map((f) => itemIdOf(f.path)));
    let bestIdx = -1;
    let bestTs = -1;
    for (let i = 0; i < list.length; i++) {
      const rec = videoProgress[ids[i]];
      if (rec && rec.ts > bestTs) {
        bestTs = rec.ts;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) start = bestIdx;
  }
  index.value = start;
  await play(list[start].path);
};

const playIndex = async (nextIndex) => {
  if (!files.value.length) return;
  await saveNow();
  index.value = (nextIndex + files.value.length) % files.value.length;
  await play(files.value[index.value].path);
};

const next = () => playIndex(index.value + 1);
const prev = () => playIndex(index.value - 1);

const openPlaylistItemMenu = (file, x, y) => {
  const isAndroid = booksStore.platform === "android";
  openContextMenu({
    x,
    y,
    items: [
      {
        id: "play",
        label: "播放",
        icon: "play",
        onSelect: () => {
          closeContextMenu();
          const i = files.value.findIndex((f) => f.path === file.path);
          if (i >= 0) playIndex(i);
        },
      },
      {
        id: "copy",
        label: "复制路径",
        icon: "book-copy",
        onSelect: () => copyPath(file),
      },
      {
        id: "reveal",
        label: "在文件管理器中显示",
        icon: "folder-open",
        hidden: isAndroid,
        onSelect: () => revealPath(file),
      },
      {
        id: "delete",
        label: "删除",
        icon: "trash",
        danger: true,
        onSelect: () => requestDelete(file, false),
      },
    ],
  });
};

const onPlaylistContextMenu = (e) => {
  e.preventDefault();
  e.stopPropagation();
  const cell = e.target?.closest?.(".pl-item");
  const hit = cell?.dataset?.key ? playlistMap.get(cell.dataset.key) : null;
  if (hit) openPlaylistItemMenu(hit, e.clientX, e.clientY);
  else openGenericMenu(e.clientX, e.clientY);
};

const longPress = useCellLongPress({
  selector: ".pl-item",
  resolveHit: (cell) => playlistMap.get(cell.dataset.key) || null,
  onHit: (hit, x, y) => openPlaylistItemMenu(hit, x, y),
  onEmpty: (x, y) => openGenericMenu(x, y),
});

const poll = async () => {
  if (!alive) return;
  try {
    const s = await invoke(vcmd("get_state"), { id: 0 });
    state.value = s || null;
    if (s) {
      if (!gesture.longPressActive && Number.isFinite(Number(s.speed)) && Number(s.speed) > 0) {
        playbackSpeed.value = Number(s.speed);
      }
      if (s.playing && !s.paused) wasPlaying = true;
      if (
        resumeAt != null &&
        resumeFor === currentFile.value &&
        currentStateMatches(s) &&
        s.duration > 0 &&
        (s.playing || s.paused)
      ) {
        const target = resumeAt;
        resumeAt = null;
        resumeFor = null;
        if (target < s.duration - RESUME_END_GUARD_SECONDS) seekTo(target);
      }
      if (currentStateMatches(s) && s.duration > 0 && Number.isFinite(s.position) && s.position > 0) {
        void saveNow();
      }
      // 一集播完自动续下一集（仅播放列表模式）
      if (wasPlaying && !s.playing && !s.paused && files.value.length > 1) {
        wasPlaying = false;
        await saveNow();
        next();
      }
    }
  } catch (e) {
    error.value = String(e);
  }
};

const togglePause = async () => {
  if (!state.value) return;
  const paused = !state.value.paused;
  try {
    await invoke(vcmd("pause"), { id: 0, paused });
    state.value = { ...state.value, paused };
    showPlaybackHud({
      type: "transport",
      icon: paused ? "pause" : "play",
      primary: paused ? "已暂停" : "继续播放",
    });
    void saveNow();
  } catch (e) {
    error.value = String(e);
  }
  pokeChrome();
};

const seekTo = async (seconds) => {
  const duration = Number(state.value?.duration) || 0;
  const target = duration > 0
    ? Math.max(0, Math.min(duration, Number(seconds) || 0))
    : Math.max(0, Number(seconds) || 0);
  try {
    await invoke(vcmd("seek"), { id: 0, seconds: target });
    if (state.value) state.value = { ...state.value, position: target };
    return target;
  } catch (e) {
    error.value = String(e);
    return null;
  }
};

const seekBy = async (delta) => {
  const duration = Number(state.value?.duration) || 0;
  if (duration <= 0) return;
  const base = state.value?.position ?? 0;
  const target = Math.max(0, Math.min(duration, base + delta));
  const applied = await seekTo(target);
  if (applied == null) return;
  showPlaybackHud({
    type: "seek",
    icon: delta < 0 ? "skip-back" : "skip-forward",
    primary: `${delta < 0 ? "快退" : "快进"} ${Math.abs(delta)} 秒`,
    secondary: `${fmt(target)} / ${fmt(duration)}`,
  });
  pokeChrome();
};

const commitSeek = () => {
  if (dragPos.value != null) {
    resumeAt = null;
    resumeFor = null;
    seekTo(dragPos.value);
    dragPos.value = null;
    void saveNow();
  }
};

const loadVolume = async () => {
  try {
    volume.value = await invoke(vcmd("get_volume"), { id: 0 });
    volumeSynced = true;
  } catch (e) {
    error.value = String(e);
  }
};

const pushVolume = () => {
  clearTimeout(volumeTimer);
  volumeTimer = setTimeout(() => {
    invoke(vcmd("set_volume"), { id: 0, volume: volume.value }).catch((e) => (error.value = String(e)));
  }, 30);
};

const onVolumeInput = (e) => {
  volume.value = Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0)));
  if (volume.value > 0) lastNonZeroVolume = volume.value;
  pushVolume();
  showPlaybackHud({
    type: "volume",
    side: "right",
    icon: volumeIcon.value,
    primary: `音量 ${volume.value}`,
  });
  pokeChrome();
};

const adjustVolume = async (delta) => {
  if (!volumeSynced) await loadVolume();
  volume.value = Math.max(0, Math.min(100, volume.value + delta));
  if (volume.value > 0) lastNonZeroVolume = volume.value;
  pushVolume();
  showPlaybackHud({
    type: "volume",
    side: "right",
    icon: volumeIcon.value,
    primary: `音量 ${volume.value}`,
  });
  pokeChrome();
};

const toggleMute = async () => {
  if (!volumeSynced) await loadVolume();
  if (volume.value > 0) {
    lastNonZeroVolume = volume.value;
    volume.value = 0;
  } else {
    volume.value = Math.max(1, lastNonZeroVolume || 100);
  }
  pushVolume();
  showPlaybackHud({
    type: "volume",
    side: "right",
    icon: volumeIcon.value,
    primary: volume.value === 0 ? "已静音" : `音量 ${volume.value}`,
  });
  pokeChrome();
};

const setFixedSpeed = async (speed) => {
  const previous = playbackSpeed.value;
  speedOpen.value = false;
  try {
    const actual = await invokeSpeed(speed);
    playbackSpeed.value = actual;
    settings.setVideoPlaybackSpeed(actual);
    showPlaybackHud({ type: "speed", primary: `${speedLabel.value} 播放` });
  } catch (e) {
    playbackSpeed.value = previous;
    error.value = String(e);
  }
  pokeChrome();
};

/* ===== 移动端手势：横滑进度 / 纵滑亮度音量 / 长按 2× ===== */
const TOUCH_MOVE_THRESHOLD = 12;
const TOUCH_DIRECTION_RATIO = 1.2;
const LONG_PRESS_MS = 450;
// 手势后短暂抑制合成 click/dblclick，避免滑动/长按结束时误触控制栏。
let gestureSuppressUntil = 0;

const pushBrightness = () => {
  clearTimeout(brightnessTimer);
  brightnessTimer = setTimeout(() => {
    invoke(vcmd("set_screen_brightness"), { brightness: brightness.value }).catch((e) => (error.value = String(e)));
  }, 40);
};

const clearLongPressTimer = () => {
  clearTimeout(gesture.pressTimer);
  gesture.pressTimer = null;
};

const startTemporarySpeed = () => {
  if (!gesture.active || gesture.moved || gesture.longPressActive || !currentFile.value) return;
  gesture.longPressActive = true;
  gesture.restoreSpeed = playbackSpeed.value;
  gestureSuppressUntil = Date.now() + 600;
  clearTimeout(stageClickTimer);
  stageClickTimer = null;
  showPlaybackHud({ type: "speed", primary: "2× 加速播放", hold: true });
  invokeSpeed(2)
    .then((actual) => {
      if (gesture.longPressActive) playbackSpeed.value = actual;
    })
    .catch((e) => {
      gesture.longPressActive = false;
      hidePlaybackHud();
      error.value = String(e);
    });
};

const stopTemporarySpeed = () => {
  if (!gesture.longPressActive) return;
  const restore = gesture.restoreSpeed;
  gesture.longPressActive = false;
  showPlaybackHud({ type: "speed", primary: `恢复 ${restore}×` });
  invokeSpeed(restore)
    .then((actual) => (playbackSpeed.value = actual))
    .catch((e) => (error.value = String(e)));
};

const onStageTouchStart = (e) => {
  if (!isAndroid.value) return;
  if (e.target?.closest?.("button, input, a, .playlist, .top-chrome, .bottom-chrome")) return;
  if (e.touches?.length !== 1) {
    onStageTouchCancel();
    return;
  }
  const t = e.touches?.[0];
  if (!t) return;
  const r = stage.value?.getBoundingClientRect();
  if (!r) return;
  gesture.active = true;
  gesture.moved = false;
  gesture.direction = null;
  gesture.startX = t.clientX;
  gesture.startY = t.clientY;
  gesture.lastY = t.clientY;
  gesture.startPosition = Number(state.value?.position) || 0;
  gesture.previewPosition = null;
  gesture.side = t.clientX < r.left + r.width / 2 ? "left" : "right";
  gesture.type = gesture.side === "left" ? "brightness" : "volume";
  gesture.value = gesture.type === "brightness" ? brightness.value : volume.value;
  clearLongPressTimer();
  gesture.pressTimer = setTimeout(startTemporarySpeed, LONG_PRESS_MS);
};

const onStageTouchMove = (e) => {
  if (!isAndroid.value || !gesture.active) return;
  const t = e.touches?.[0];
  if (!t || e.touches.length !== 1) {
    onStageTouchCancel();
    return;
  }
  const dx = t.clientX - gesture.startX;
  const dy = t.clientY - gesture.startY;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (!gesture.direction) {
    if (Math.max(ax, ay) < TOUCH_MOVE_THRESHOLD) return;
    if (ax >= ay * TOUCH_DIRECTION_RATIO) gesture.direction = "horizontal";
    else if (ay >= ax * TOUCH_DIRECTION_RATIO) gesture.direction = "vertical";
    else return;
    gesture.moved = true;
    clearLongPressTimer();
    gestureSuppressUntil = Date.now() + 500;
    clearTimeout(stageClickTimer);
    stageClickTimer = null;
  }

  if (gesture.direction === "horizontal") {
    const duration = Number(state.value?.duration) || 0;
    const r = stage.value?.getBoundingClientRect();
    if (duration > 0 && r?.width) {
      const span = Math.max(15, Math.min(120, duration * 0.25));
      const target = Math.max(0, Math.min(duration, gesture.startPosition + (dx / r.width) * span));
      gesture.previewPosition = target;
      dragPos.value = target;
      showPlaybackHud({
        type: "seek-preview",
        icon: dx < 0 ? "skip-back" : "skip-forward",
        primary: dx < 0 ? "向后滑动" : "向前滑动",
        secondary: `${fmt(target)} / ${fmt(duration)}`,
        hold: true,
      });
    }
    e.preventDefault();
    return;
  }

  const delta = (-(t.clientY - gesture.lastY) / (window.innerHeight || 720)) * 200;
  gesture.lastY = t.clientY;
  gesture.value = Math.max(0, Math.min(100, gesture.value + delta));
  const v = Math.round(gesture.value);
  if (gesture.type === "brightness") {
    brightness.value = v;
    pushBrightness();
    showPlaybackHud({ type: "brightness", side: "left", icon: "sun", primary: `亮度 ${v}` });
  } else {
    volume.value = v;
    if (v > 0) lastNonZeroVolume = v;
    pushVolume();
    showPlaybackHud({ type: "volume", side: "right", icon: volumeIcon.value, primary: `音量 ${v}` });
  }
  e.preventDefault();
};

const onStageTouchEnd = () => {
  if (!gesture.active) return;
  clearLongPressTimer();
  const wasLongPress = gesture.longPressActive;
  stopTemporarySpeed();
  if (gesture.direction === "horizontal" && gesture.previewPosition != null) {
    resumeAt = null;
    resumeFor = null;
    const target = gesture.previewPosition;
    dragPos.value = null;
    void seekTo(target).then((applied) => {
      if (applied != null) void saveNow();
    });
    showPlaybackHud({
      type: "seek",
      icon: target < gesture.startPosition ? "skip-back" : "skip-forward",
      primary: target < gesture.startPosition ? "已快退" : "已快进",
      secondary: `${fmt(target)} / ${fmt(state.value?.duration || 0)}`,
    });
  }
  gesture.active = false;
  if (gesture.moved || wasLongPress) {
    gestureSuppressUntil = Date.now() + 400;
  }
  gesture.moved = false;
  gesture.direction = null;
  gesture.previewPosition = null;
};

const onStageTouchCancel = () => {
  clearLongPressTimer();
  stopTemporarySpeed();
  dragPos.value = null;
  gesture.active = false;
  gesture.moved = false;
  gesture.direction = null;
  gesture.previewPosition = null;
  gestureSuppressUntil = Date.now() + 400;
};

const gestureSuppressed = () => Date.now() < gestureSuppressUntil;

const onWheel = (e) => {
  if (!e.deltaY || e.target?.closest?.(".playlist, .volume-pop, .speed-pop")) return;
  const step = Math.max(1, Math.round(Math.abs(e.deltaY) / 20));
  adjustVolume(e.deltaY < 0 ? step : -step);
  e.preventDefault();
};

const toggleVolume = () => {
  volumeOpen.value = !volumeOpen.value;
  if (volumeOpen.value) speedOpen.value = false;
  if (volumeOpen.value) loadVolume();
  pokeChrome();
};

const toggleSpeed = () => {
  speedOpen.value = !speedOpen.value;
  if (speedOpen.value) volumeOpen.value = false;
  pokeChrome();
};

const onStageClick = (e) => {
  if (gestureSuppressed()) return;
  const tag = (e.target?.tagName || "").toLowerCase();
  if (
    tag === "button" ||
    tag === "input" ||
    tag === "a" ||
    e.target?.closest?.(".playlist, .speed-wrap, .volume-wrap")
  ) return;
  if (speedOpen.value || volumeOpen.value) {
    speedOpen.value = false;
    volumeOpen.value = false;
    pokeChrome();
    return;
  }
  clearTimeout(stageClickTimer);
  stageClickTimer = setTimeout(() => {
    stageClickTimer = null;
    if (isAndroid.value) {
      // 移动端：单击切换悬浮栏显示/隐藏，不暂停
      if (chromeVisible.value) {
        // 已显示 → 立即隐藏（不等 idle 自动隐藏）
        chromeVisible.value = false;
        clearTimeout(idleTimer);
        clearTimeout(chromeResizeTimer);
        chromeResizeTimer = setTimeout(onResize, 360);
      } else {
        pokeChrome();
      }
    } else {
      togglePause();
      pokeChrome();
    }
  }, 300);
};

const onStageDblClick = (e) => {
  if (gestureSuppressed()) return;
  clearTimeout(stageClickTimer);
  stageClickTimer = null;
  if (isAndroid.value) {
    const r = stage.value?.getBoundingClientRect();
    const x = r?.width ? (e.clientX - r.left) / r.width : 0.5;
    if (x < 1 / 3) seekBy(-settings.videoSeekSeconds);
    else if (x > 2 / 3) seekBy(settings.videoSeekSeconds);
    else togglePause();
    pokeChrome();
  } else {
    toggleFullscreen();
  }
};

const onResize = () => {
  if (resizeRaf != null) return;
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = null;
    syncHole();
    if (!currentFile.value) return;
    invoke(vcmd("set_bounds"), { id: 0, ...rect() }).catch((e) => (error.value = String(e)));
  });
};

const goBack = async () => {
  if (fullscreen.value) {
    fullscreen.value = false;
    try {
      await appWindow.setFullscreen(false);
    } catch (e) {
      // ignore exit-fullscreen failure and continue navigation
    }
  }
  await saveNow();
  await flushProgress();
  if (window.history.length > 1) router.back();
  else router.push("/");
};

/* ===== 播放列表抽屉 ===== */
const togglePlaylist = async () => {
  playlistOpen.value = !playlistOpen.value;
  if (playlistOpen.value) {
    speedOpen.value = false;
    volumeOpen.value = false;
  }
  pokeChrome();
  await nextTick();
  setTimeout(onResize, 380);
};

/* ===== 全屏 ===== */
const toggleFullscreen = async () => {
  const target = !fullscreen.value;
  fullscreen.value = target;
  try {
    await appWindow.setFullscreen(target);
  } catch (e) {
    fullscreen.value = !target;
  }
  pokeChrome();
  onResize();
  await nextTick();
  setTimeout(onResize, 420);
};

/* ===== 自动隐藏控件 ===== */
const pokeChrome = () => {
  chromeVisible.value = true;
  clearTimeout(idleTimer);
  clearTimeout(chromeResizeTimer);
  chromeResizeTimer = setTimeout(onResize, 360);
  idleTimer = setTimeout(() => {
    if (!playlistOpen.value && !volumeOpen.value && !speedOpen.value) {
      chromeVisible.value = false;
      clearTimeout(chromeResizeTimer);
      chromeResizeTimer = setTimeout(onResize, 360);
    }
  }, 3000);
};

// 鼠标移动显示控制条仅桌面有效：Android 触摸的微小移动会触发 pointermove
// 干扰单击切换逻辑（显示后又被单击立即隐藏），移动端无需此行为。
const onPointerMove = () => {
  if (isAndroid.value) return;
  pokeChrome();
};

/* ===== 键盘快捷键 ===== */
const onKey = (e) => {
  const tag = (e.target?.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || e.target?.isContentEditable) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.code) {
    case "Space":
    case "KeyK":
      e.preventDefault();
      togglePause();
      break;
    case "ArrowLeft":
    case "KeyJ":
      e.preventDefault();
      seekBy(-settings.videoSeekSeconds);
      break;
    case "ArrowRight":
    case "KeyL":
      e.preventDefault();
      seekBy(settings.videoSeekSeconds);
      break;
    case "ArrowUp":
      e.preventDefault();
      adjustVolume(5);
      break;
    case "ArrowDown":
      e.preventDefault();
      adjustVolume(-5);
      break;
    case "PageUp":
    case "KeyP":
      e.preventDefault();
      prev();
      break;
    case "PageDown":
    case "KeyN":
      e.preventDefault();
      next();
      break;
    case "KeyM":
      e.preventDefault();
      toggleMute();
      break;
    case "KeyF":
      e.preventDefault();
      toggleFullscreen();
      break;
    case "Escape":
      if (playlistOpen.value || volumeOpen.value || speedOpen.value) {
        playlistOpen.value = false;
        volumeOpen.value = false;
        speedOpen.value = false;
        pokeChrome();
        setTimeout(onResize, 380);
      } else if (fullscreen.value) {
        toggleFullscreen();
      }
      break;
  }
};

const fmt = (seconds) => {
  if (!Number.isFinite(seconds)) return "0:00";
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

onMounted(async () => {
  alive = true;
  enterSystemUIImmersive();
  document.documentElement.classList.add("video-mode");
  appWindow.setBackgroundColor([0, 0, 0, 0]).catch(() => {});
  appWindow.show().catch(() => {});
  appWindow.setFocus().catch(() => {});
  appWindow.isFullscreen().then((v) => (fullscreen.value = v)).catch(() => {});
  timer = setInterval(poll, 500);
  window.addEventListener("resize", onResize);
  window.addEventListener("mousemove", onPointerMove, { passive: true });
  window.addEventListener("keydown", onKey);
  window.addEventListener("wheel", onWheel, { passive: false });
  stageObserver = new ResizeObserver(onResize);
  if (stage.value) stageObserver.observe(stage.value);
  pokeChrome();
  const dir = route.query.dir;
  const path = route.query.path;
  await loadPath(typeof path === "string" && path ? (isPlaylist.value && typeof dir === "string" && dir ? dir : path) : "");
  onResize();
});

watch(
  () => route.query.path,
  async (path) => {
    if (typeof path === "string" && path && path !== currentFile.value) {
      await saveNow();
      loadPath(isPlaylist.value && route.query.dir ? route.query.dir : path);
    }
  }
);

onUnmounted(() => {
  alive = false;
  closeContextMenu();
  exitSystemUIImmersive();
  void (async () => {
    await saveNow();
    await flushProgress();
  })();
  document.documentElement.classList.remove("video-mode");
  appWindow
    .isFullscreen()
    .then((v) => {
      if (v) appWindow.setFullscreen(false).catch(() => {});
    })
    .catch(() => {});
  clearInterval(timer);
  clearTimeout(idleTimer);
  clearTimeout(chromeResizeTimer);
  clearTimeout(volumeTimer);
  clearTimeout(brightnessTimer);
  clearTimeout(stageClickTimer);
  clearLongPressTimer();
  hidePlaybackHud();
  gesture.active = false;
  gesture.longPressActive = false;
  stageObserver?.disconnect();
  if (resizeRaf != null) cancelAnimationFrame(resizeRaf);
  window.removeEventListener("resize", onResize);
  window.removeEventListener("mousemove", onPointerMove);
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("wheel", onWheel);
  invoke(vcmd("release"), { id: 0 }).catch(() => {});
  invoke(vcmd("stop_all")).catch(() => {});
  // 离开播放页：恢复被手势调整过的屏幕亮度
  invoke(vcmd("reset_screen_brightness")).catch(() => {});
});
</script>

<template>
  <div class="video-page" :class="{ 'is-idle': !chromeVisible, 'has-video': !!currentFile && !!state }">
    <div class="video-backdrop" :style="backdropStyle"></div>
    <span class="ghost-word">影</span>

    <header class="top-chrome" data-tauri-drag-region :class="{ 'chrome-hidden': !chromeVisible }">
      <button class="circle-btn" title="返回" @click="goBack">
        <Icon id="arrow-left" :size="18" />
      </button>
      <div class="head-titles" data-tauri-drag-region>
        <div class="kicker">02 / VIDEO · 放映室</div>
        <h1 class="head-title" data-tauri-drag-region>{{ fileName || "未载入影片" }}</h1>
        <div v-if="state?.codec || files.length" class="head-meta mono">
          <span v-if="files.length">{{ index + 1 }} / {{ files.length }}</span>
          <i v-if="state?.codec"></i>
          <span v-if="state?.codec">{{ state.codec }}</span>
        </div>
      </div>
      <div class="top-drag" data-tauri-drag-region></div>
      <div class="head-actions">
        <button
          v-if="files.length > 1"
          class="circle-btn"
          :class="{ on: playlistOpen }"
          title="播放列表"
          @click="togglePlaylist"
        >
          <Icon id="list" :size="17" />
        </button>
      </div>
    </header>

    <div class="stage-row">
      <div
        ref="stage"
        class="stage"
        @click="onStageClick"
        @dblclick="onStageDblClick"
        @touchstart="onStageTouchStart"
        @touchmove="onStageTouchMove"
        @touchend="onStageTouchEnd"
        @touchcancel="onStageTouchCancel"
      >
        <div v-if="loading" class="stage-note">
          <Icon id="loader-circle" :size="22" class="spin" />
          <span>正在载入影片</span>
        </div>
        <div v-else-if="!currentFile" class="stage-note">{{ error || "未找到视频文件" }}</div>
        <div v-else-if="!state" class="stage-note">等待画面信号</div>
        <div v-else-if="!state.playing && !state.paused && !state.duration" class="stage-note">
          {{ error || "播放已结束" }}
        </div>
      </div>

      <!-- 统一播放 HUD：进退、播放、倍速、亮度与音量 -->
      <transition name="hud">
        <div
          v-if="playbackHud.visible"
          class="playback-hud"
          :class="['is-' + playbackHud.type, 'is-' + playbackHud.side]"
        >
          <Icon v-if="playbackHud.icon" :id="playbackHud.icon" :size="24" />
          <span class="hud-primary">{{ playbackHud.primary }}</span>
          <span v-if="playbackHud.secondary" class="hud-secondary mono">{{ playbackHud.secondary }}</span>
        </div>
      </transition>

      <aside
        class="playlist"
        :class="{ open: playlistOpen }"
        @contextmenu="onPlaylistContextMenu"
        @touchstart="longPress.onTouchStart"
        @touchmove="longPress.onTouchMove"
        @touchend="longPress.onTouchEnd"
        @touchcancel="longPress.onTouchCancel"
      >
        <div class="pl-head">
          <div class="pl-title">
            <div class="kicker">PLAYLIST · 播放列表</div>
            <span class="pl-count mono">{{ files.length }}</span>
          </div>
          <button class="pl-close" title="收起" @click="togglePlaylist">
            <Icon id="x" :size="15" />
          </button>
        </div>
        <ul class="pl-list">
          <li
            v-for="(f, i) in files"
            :key="f.path"
            class="pl-item"
            :class="{ active: i === index }"
            :data-key="f.path"
            @click="longPress.onCellClick(() => playIndex(i))"
          >
            <span class="pl-idx mono">{{ String(i + 1).padStart(2, "0") }}</span>
            <img
              v-if="covers[canonKey(f.path)]"
              :src="covers[canonKey(f.path)]"
              class="pl-thumb"
              alt=""
              loading="lazy"
              decoding="async"
            />
            <span class="pl-name">{{ f.name }}</span>
            <Icon v-if="i === index" id="play" :size="13" class="pl-play" />
          </li>
        </ul>
      </aside>
    </div>

    <footer class="bottom-chrome" :class="{ 'chrome-hidden': !chromeVisible }">
      <div class="bar">
        <div class="bar-seek">
          <span class="seek-time mono">{{ state ? fmt(dragPos ?? state.position) : "--:--" }}</span>
          <input
            v-if="state"
            type="range"
            class="seek"
            :min="0"
            :max="state.duration || 0"
            :value="dragPos ?? state.position"
            step="0.1"
            :style="{ '--fill': seekFill + '%' }"
            @input="dragPos = Number($event.target.value)"
            @change="commitSeek"
            @pointerup="commitSeek"
            @keyup="commitSeek"
          />
          <span class="seek-time mono dim">{{ state ? fmt(state.duration) : "--:--" }}</span>
        </div>
        <div class="bar-controls">
          <div class="bar-info">
            <span v-if="error" class="bar-err">{{ error }}</span>
            <span v-else-if="files.length > 1" class="bar-chip mono">
              {{ index + 1 }} / {{ files.length }}
            </span>
          </div>
          <div class="bar-center">
            <button v-if="files.length > 1" class="ctrl-btn" title="上一个" @click="prev">
              <Icon id="skip-back" :size="17" />
            </button>
            <button v-if="state" class="play-btn" :title="state.paused ? '播放' : '暂停'" @click="togglePause">
              <Icon :id="state.paused ? 'play' : 'pause'" :size="20" />
            </button>
            <button v-else class="play-btn" disabled title="暂停">
              <Icon id="play" :size="20" />
            </button>
            <button v-if="files.length > 1" class="ctrl-btn" title="下一个" @click="next">
              <Icon id="skip-forward" :size="17" />
            </button>
          </div>
          <div class="bar-side">
            <div class="speed-wrap">
              <button
                class="ctrl-btn speed-btn mono"
                :class="{ on: speedOpen }"
                :title="speedOpen ? '收起倍速' : '播放倍速'"
                @click="toggleSpeed"
              >
                {{ speedLabel }}
              </button>
              <div v-if="speedOpen" class="speed-pop" @pointerdown.stop>
                <button
                  v-for="speed in SPEED_OPTIONS"
                  :key="speed"
                  class="speed-option mono"
                  :class="{ active: playbackSpeed === speed }"
                  @click="setFixedSpeed(speed)"
                >
                  {{ speed }}×
                </button>
              </div>
            </div>
            <div class="volume-wrap">
              <button
                class="ctrl-btn"
                :title="volumeOpen ? '收起音量' : '音量'"
                @click="toggleVolume"
              >
                <Icon :id="volumeIcon" :size="17" />
              </button>
              <div v-if="volumeOpen" class="volume-pop" @pointerdown.stop>
                <span class="volume-num mono">{{ volume }}</span>
                <div class="volume-slider-box">
                  <input
                    type="range"
                    class="volume-slider"
                    min="0"
                    max="100"
                    step="1"
                    :value="volume"
                    :style="{ '--fill': volume + '%' }"
                    @input="onVolumeInput"
                  />
                </div>
              </div>
            </div>
            <button class="ctrl-btn" :title="fullscreen ? '退出全屏' : '全屏'" @click="toggleFullscreen">
              <Icon :id="fullscreen ? 'minimize' : 'maximize'" :size="17" />
            </button>
          </div>
        </div>
      </div>
    </footer>
  </div>
</template>

<style scoped lang="scss">
.video-page {
  --p-bg: #050506;
  --p-panel: rgba(10, 10, 14, 0.72);
  --p-line: rgba(255, 255, 255, 0.09);
  --p-text: #f4f1e9;
  --p-text-2: rgba(244, 241, 233, 0.58);
  --p-text-3: rgba(244, 241, 233, 0.32);
  --p-accent: #ff5c39;
  --p-accent-2: #ffb36b;

  position: fixed;
  inset: 0;
  overflow: hidden;
  background: transparent;
  color: var(--p-text);
}

.video-backdrop {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background:
    radial-gradient(70% 52% at 82% -8%, rgba(255, 92, 57, 0.07), transparent 58%),
    radial-gradient(48% 42% at -6% 108%, rgba(214, 255, 63, 0.035), transparent 60%),
    var(--p-bg);
  -webkit-mask-image: linear-gradient(#000 0 0), linear-gradient(#000 0 0);
  -webkit-mask-size: 100% 100%, var(--hole-w, 0px) var(--hole-h, 0px);
  -webkit-mask-position: 0 0, var(--hole-x, 0px) var(--hole-y, 0px);
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-composite: xor;
  mask-image: linear-gradient(#000 0 0), linear-gradient(#000 0 0);
  mask-size: 100% 100%, var(--hole-w, 0px) var(--hole-h, 0px);
  mask-position: 0 0, var(--hole-x, 0px) var(--hole-y, 0px);
  mask-repeat: no-repeat;
  mask-composite: exclude;
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

.video-page.has-video .video-backdrop {
  /* Android 上 TextureView 在 WebView 之下，靠这里透明露出视频；
     直接整层透明，不依赖 -webkit-mask 挖洞（Android WebView 上
     mask-composite 支持不可靠，且会被 dark 主题的 body 背景干扰）。 */
  background: transparent;
  -webkit-mask-image: none;
  mask-image: none;
}

.video-page.has-video .ghost-word {
  opacity: 0;
}

.top-chrome,
.bottom-chrome {
  position: absolute;
  z-index: 6;
  opacity: 1;
  transform: translateY(0);
  transition: opacity 0.3s var(--ease-out), transform 0.35s var(--ease-out);

  &.chrome-hidden {
    opacity: 0;
    transform: translateY(-14px);
    pointer-events: none;
  }
}

.top-chrome {
  top: 14px;
  left: 22px;
  right: 22px;
  height: 60px;
  margin: 0;
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

  &.on {
    color: var(--p-accent);
    border-color: var(--p-accent);
    box-shadow: 0 0 0 3px rgba(255, 92, 57, 0.12);
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
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 9.5px;
  letter-spacing: 0.16em;
  color: var(--p-text-3);

  i {
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: var(--p-accent);
  }
}

.head-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
}

.stage-row {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: block;
  /* 一直全屏铺满：避免载入→播放时舞台从内嵌小框跳成全屏，
     也避免透明“洞”位置跟着变动而被看到桌面（造成“透明→冒出”的闪烁）。 */
  padding: 0;
}

.video-page.is-idle .stage-row {
  padding: 0;
}

.video-page.is-idle .stage {
  border-radius: 0;
  border: none;
}

.stage {
  position: relative;
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  /* 默认即全屏黑底（载入中），播放时切透明露出 mpv；布局不变、无跳变 */
  border-radius: 0;
  transition: border-radius 0.35s var(--ease-out), border-color 0.35s var(--ease-out);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent 30%),
    #000;
  border: none;
  box-shadow: none;
  overflow: hidden;
  touch-action: none;

  &::after {
    content: "";
    position: absolute;
    inset: 0;
    z-index: 1;
    pointer-events: none;
    background: radial-gradient(130% 100% at 50% 50%, transparent 74%, rgba(0, 0, 0, 0.22) 100%);
  }
}

.video-page.has-video .stage-row {
  padding: 0;
  gap: 0;
}

.video-page.has-video .stage {
  background: transparent;
  border: none;
  border-radius: 0;
  box-shadow: none;
}

.video-page.has-video .stage::after {
  display: none;
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
  padding: 0 24px;
  text-align: center;
}

/* ===== 播放列表 ===== */
.playlist {
  position: absolute;
  top: 84px;
  right: 22px;
  bottom: 96px;
  z-index: 5;
  width: 0;
  overflow: hidden;
  margin: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--p-line);
  border-radius: 18px;
  background: var(--p-panel);
  backdrop-filter: blur(22px) saturate(1.3);
  opacity: 0;
  transform: translateX(16px);
  transition: width 0.38s var(--ease-out), opacity 0.3s var(--ease-out), transform 0.38s var(--ease-out);

  &.open {
    width: 320px;
    opacity: 1;
    transform: translateX(0);
  }
}

.pl-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 16px 18px 14px;
  border-bottom: 1px solid var(--p-line);
  white-space: nowrap;
}

.pl-title {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.pl-count {
  flex-shrink: 0;
  padding: 3px 9px;
  border: 1px solid var(--p-line);
  border-radius: 999px;
  font-size: 9.5px;
  letter-spacing: 0.16em;
  color: var(--p-text-3);
}

.pl-close {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--p-text-2);
  cursor: pointer;

  &:hover {
    color: var(--p-accent);
    background: rgba(255, 77, 46, 0.1);
  }
}

.pl-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  list-style: none;
  padding: 8px;
}

.pl-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 10px;
  border-radius: 10px;
  color: var(--p-text-2);
  cursor: pointer;
  position: relative;
  transition: background 0.2s, color 0.2s;

  &:hover {
    background: rgba(255, 255, 255, 0.05);
    color: var(--p-text);
  }

  &.active {
    background: linear-gradient(90deg, rgba(255, 92, 57, 0.13), transparent 85%);
    color: var(--p-text);

    &::before {
      content: "";
      position: absolute;
      left: 0;
      top: 9px;
      bottom: 9px;
      width: 2px;
      border-radius: 2px;
      background: var(--p-accent);
    }

    .pl-idx {
      color: var(--p-accent);
    }
  }
}

.pl-idx {
  flex-shrink: 0;
  font-size: 10px;
  letter-spacing: 0.14em;
  color: var(--p-text-3);
}

.pl-thumb {
  width: 40px;
  height: 54px;
  flex-shrink: 0;
  border-radius: 8px;
  object-fit: cover;
  display: block;
  background: rgba(255, 255, 255, 0.05);
}

.pl-name {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pl-play {
  flex-shrink: 0;
  color: var(--p-accent);
}

/* ===== 底部控制条 ===== */
.bottom-chrome {
  bottom: 14px;
  left: 22px;
  right: 22px;
  padding: 0;

  &.chrome-hidden {
    transform: translateY(14px);
  }
}

.bar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 14px 8px;
  border: 1px solid var(--p-line);
  border-radius: 14px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.045), rgba(255, 255, 255, 0.012)),
    rgba(8, 8, 12, 0.58);
  backdrop-filter: blur(22px) saturate(1.3);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
}

.bar-seek {
  display: flex;
  align-items: center;
  gap: 10px;
}

.seek {
  flex: 1;
  height: 3px;
  -webkit-appearance: none;
  appearance: none;
  border-radius: 999px;
  background:
    linear-gradient(
      90deg,
      var(--p-accent) 0%,
      var(--p-accent) var(--fill, 0%),
      rgba(255, 255, 255, 0.14) var(--fill, 0%)
    );
  outline: none;
  cursor: pointer;

  &::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: #f4f1e9;
    border: none;
    box-shadow: 0 0 0 3px rgba(244, 241, 233, 0.14), 0 2px 8px rgba(0, 0, 0, 0.5);
    transition: transform 0.2s var(--ease-out);
  }

  &:hover::-webkit-slider-thumb {
    transform: scale(1.25);
  }

  &::-moz-range-thumb {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: #f4f1e9;
    border: none;
    box-shadow: 0 0 0 3px rgba(244, 241, 233, 0.14);
  }
}

.seek-time {
  flex-shrink: 0;
  min-width: 40px;
  text-align: right;
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--p-text);
  font-variant-numeric: tabular-nums;

  &.dim {
    color: var(--p-text-3);
    text-align: left;
  }
}

.bar-controls {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 10px;
}

.bar-info {
  justify-self: start;
  min-width: 0;
}

.bar-center {
  justify-self: center;
  display: flex;
  align-items: center;
  gap: 8px;
}

.bar-side {
  justify-self: end;
  display: flex;
  align-items: center;
  gap: 8px;
}

.speed-wrap,
.volume-wrap {
  position: relative;
  display: flex;
}

.speed-btn {
  width: auto !important;
  min-width: 42px;
  padding: 0 8px;
  border-radius: 999px !important;
  font-size: 10px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;

  &.on {
    color: var(--p-accent);
    border-color: rgba(255, 92, 57, 0.5);
  }
}

.speed-pop {
  position: absolute;
  right: 0;
  bottom: calc(100% + 10px);
  z-index: 8;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 78px;
  padding: 6px;
  border: 1px solid var(--p-line);
  border-radius: 14px;
  background: rgba(8, 8, 12, 0.9);
  backdrop-filter: blur(22px) saturate(1.3);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.42);
}

.speed-option {
  height: 30px;
  padding: 0 10px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--p-text-2);
  font-size: 11px;
  text-align: center;
  cursor: pointer;

  &:hover,
  &.active {
    color: #fff;
    background: rgba(255, 255, 255, 0.09);
  }

  &.active {
    color: var(--p-accent);
  }
}

.volume-pop {
  position: absolute;
  right: -4px;
  bottom: calc(100% + 10px);
  z-index: 8;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 40px;
  padding: 8px 4px 4px;
  border: 1px solid var(--p-line);
  border-radius: 14px;
  background: rgba(8, 8, 12, 0.82);
  backdrop-filter: blur(22px) saturate(1.3);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.4);
}

.volume-num {
  font-size: 9px;
  letter-spacing: 0.08em;
  color: var(--p-text-2);
  font-variant-numeric: tabular-nums;
}

.volume-slider-box {
  width: 34px;
  height: 116px;
  display: grid;
  place-content: center;
  place-items: center;
}

.volume-slider {
  width: 116px;
  height: 3px;
  transform: rotate(-90deg);
  -webkit-appearance: none;
  appearance: none;
  border-radius: 999px;
  background: linear-gradient(
    90deg,
    var(--p-accent) 0%,
    var(--p-accent) var(--fill, 100%),
    rgba(255, 255, 255, 0.14) var(--fill, 100%)
  );
  outline: none;
  cursor: pointer;
  margin: 0;

  &::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: #f4f1e9;
    border: none;
    box-shadow: 0 0 0 3px rgba(244, 241, 233, 0.14), 0 2px 8px rgba(0, 0, 0, 0.5);
    transition: transform 0.2s var(--ease-out);
  }

  &:hover::-webkit-slider-thumb {
    transform: scale(1.2);
  }

  &::-moz-range-thumb {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: #f4f1e9;
    border: none;
    box-shadow: 0 0 0 3px rgba(244, 241, 233, 0.14);
  }
}

.ctrl-btn {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border: 1px solid var(--p-line);
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.04);
  color: var(--p-text-2);
  cursor: pointer;
  transition: color 0.25s, border-color 0.25s, transform 0.25s var(--ease-out), background 0.25s;

  &:hover {
    color: #fff;
    border-color: rgba(255, 255, 255, 0.3);
    background: rgba(255, 255, 255, 0.08);
    transform: translateY(-1px);
  }
}

.play-btn {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 50%;
  background: #f4f1e9;
  color: #0a0a0e;
  cursor: pointer;
  box-shadow: 0 10px 34px rgba(244, 241, 233, 0.18);
  transition: transform 0.3s var(--ease-spring), box-shadow 0.3s;

  &:hover:not(:disabled) {
    transform: scale(1.07);
    box-shadow: 0 14px 40px rgba(244, 241, 233, 0.26);
  }

  &:disabled {
    opacity: 0.35;
    cursor: default;
  }
}

.bar-err {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: #ff7a7a;
}

/* ===== 统一播放 HUD ===== */
.playback-hud {
  position: absolute;
  top: 50%;
  z-index: 9;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  min-width: 92px;
  max-width: min(300px, calc(100vw - 40px));
  padding: 14px 12px;
  border: 1px solid var(--p-line);
  border-radius: 16px;
  background: rgba(8, 8, 12, 0.72);
  backdrop-filter: blur(18px) saturate(1.3);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.4);
  color: #fff;
  pointer-events: none;

  &.is-left {
    left: 26px;
  }

  &.is-right {
    right: 26px;
  }

  &.is-center {
    left: 50%;
    transform: translate(-50%, -50%);
  }
}

.hud-primary {
  font-size: 13px;
  font-weight: 650;
  line-height: 1.3;
  color: #fff;
  white-space: nowrap;
}

.hud-secondary {
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--p-text-2);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.hud-enter-active,
.hud-leave-active {
  transition: opacity 0.25s var(--ease-out), transform 0.25s var(--ease-out);
}

.hud-enter-from,
.hud-leave-to {
  opacity: 0;
  transform: translateY(-50%) scale(0.88);
}

.playback-hud.is-center.hud-enter-from,
.playback-hud.is-center.hud-leave-to {
  transform: translate(-50%, -50%) scale(0.88);
}

.bar-chip {
  padding: 5px 12px;
  border: 1px solid var(--p-line);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.03);
  font-size: 10px;
  letter-spacing: 0.14em;
  color: var(--p-text-2);
  white-space: nowrap;
}

@media (max-width: 820px) {
  .top-chrome {
    top: 10px;
    left: 12px;
    right: 12px;
    height: 56px;
    padding: 0 8px;
  }

  .stage-row {
    padding: 72px 12px 68px;
  }

  .video-page.is-idle .stage-row {
    padding: 0;
  }

  .playlist {
    top: 72px;
    right: 12px;
    bottom: 88px;
  }

  .playlist.open {
    width: min(320px, calc(100vw - 24px));
  }

  .bottom-chrome {
    bottom: 10px;
    left: 12px;
    right: 12px;
    padding: 0;
  }

  .bar {
    padding: 5px 12px 7px;
  }

  .head-meta {
    display: none;
  }
}

:global(html.video-mode),
:global(html.video-mode body) {
  background: transparent !important;
}

/* Android：视频期间任何容器层都不得带不透明背景，否则会盖住
   WebView 之下的 TextureView（dark 主题 body 背景 #0b0b0e 尤其致命）。 */
:global(html.video-mode #app),
:global(html.video-mode .app) {
  background: transparent !important;
}

:global(html.video-mode body::before),
:global(html.video-mode body::after) {
  display: none !important;
}
</style>
