<script setup>
import { invoke } from "@tauri-apps/api/core";
import { Window } from "@tauri-apps/api/window";
import { readDir } from "@tauri-apps/plugin-fs";
import { VIDEO_EXTS, extOf, joinPath } from "../utils/media";
import Icon from "./Icon.vue";

defineOptions({ name: "VideoPlayer" });

const route = useRoute();
const router = useRouter();
const appWindow = new Window("main");

const stage = ref(null);
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
let timer = null;
let idleTimer = null;
let alive = true;
let wasPlaying = false;

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

const play = async (path) => {
  try {
    wasPlaying = false;
    await invoke("mpv_play", { id: 0, path, ...rect() });
    currentFile.value = path;
    error.value = "";
  } catch (e) {
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
  const raw = await readDir(dirPath);
  const list = raw
    .filter((e) => e.isFile && VIDEO_EXTS.includes(extOf(e.name)))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map((e) => ({ name: e.name, path: joinPath(dirPath, e.name) }));
  if (!list.length) {
    error.value = "文件夹里没有视频";
    return;
  }
  files.value = list;
  // 若传入的是具体文件，优先从它开始播放
  const single = route.query.path;
  let start = 0;
  if (typeof single === "string" && single) {
    const norm = (p) => String(p).replace(/\//g, "\\").toLowerCase();
    const hit = list.findIndex((f) => norm(f.path) === norm(single));
    if (hit >= 0) start = hit;
  }
  index.value = start;
  await play(list[start].path);
};

const playIndex = async (nextIndex) => {
  if (!files.value.length) return;
  index.value = (nextIndex + files.value.length) % files.value.length;
  await play(files.value[index.value].path);
};

const next = () => playIndex(index.value + 1);
const prev = () => playIndex(index.value - 1);

const poll = async () => {
  if (!alive) return;
  try {
    const s = await invoke("mpv_get_state", { id: 0 });
    state.value = s || null;
    if (s) {
      if (s.playing && !s.paused) wasPlaying = true;
      // 一集播完自动续下一集（仅播放列表模式）
      if (wasPlaying && !s.playing && !s.paused && files.value.length > 1) {
        wasPlaying = false;
        next();
      }
    }
  } catch (e) {
    error.value = String(e);
  }
};

const togglePause = async () => {
  if (!state.value) return;
  try {
    await invoke("mpv_pause", { id: 0, paused: !state.value.paused });
  } catch (e) {
    error.value = String(e);
  }
  pokeChrome();
};

const seekTo = async (seconds) => {
  try {
    await invoke("mpv_seek", { id: 0, seconds });
  } catch (e) {
    error.value = String(e);
  }
};

const seekBy = (delta) => {
  const base = state.value?.position ?? 0;
  seekTo(Math.max(0, base + delta));
  pokeChrome();
};

const commitSeek = () => {
  if (dragPos.value != null) {
    seekTo(dragPos.value);
    dragPos.value = null;
  }
};

const onResize = () => {
  if (currentFile.value) {
    invoke("mpv_set_bounds", { id: 0, ...rect() }).catch((e) => (error.value = String(e)));
  }
};

const goBack = () => {
  if (window.history.length > 1) router.back();
  else router.push("/");
};

/* ===== 播放列表抽屉 ===== */
const togglePlaylist = async () => {
  playlistOpen.value = !playlistOpen.value;
  pokeChrome();
  await nextTick();
  setTimeout(onResize, 380);
};

/* ===== 全屏 ===== */
const toggleFullscreen = async () => {
  fullscreen.value = !fullscreen.value;
  try {
    await appWindow.setFullscreen(fullscreen.value);
  } catch (e) {
    fullscreen.value = false;
  }
  pokeChrome();
  await nextTick();
  setTimeout(onResize, 320);
};

/* ===== 自动隐藏控件 ===== */
const pokeChrome = () => {
  chromeVisible.value = true;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!playlistOpen.value) chromeVisible.value = false;
  }, 2800);
};

const onPointerMove = () => pokeChrome();

/* ===== 键盘快捷键 ===== */
const onKey = (e) => {
  const tag = (e.target?.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea") return;
  switch (e.code) {
    case "Space":
    case "KeyK":
      e.preventDefault();
      togglePause();
      break;
    case "ArrowLeft":
      e.preventDefault();
      seekBy(-5);
      break;
    case "ArrowRight":
      e.preventDefault();
      seekBy(5);
      break;
    case "ArrowUp":
      e.preventDefault();
      prev();
      break;
    case "ArrowDown":
      e.preventDefault();
      next();
      break;
    case "KeyF":
      toggleFullscreen();
      break;
    case "Escape":
      if (playlistOpen.value) playlistOpen.value = false;
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
  appWindow.show().catch(() => {});
  appWindow.setFocus().catch(() => {});
  timer = setInterval(poll, 500);
  window.addEventListener("resize", onResize);
  window.addEventListener("mousemove", onPointerMove, { passive: true });
  window.addEventListener("keydown", onKey);
  pokeChrome();
  const dir = route.query.dir;
  const path = route.query.path;
  await loadPath(typeof path === "string" && path ? (isPlaylist.value && typeof dir === "string" && dir ? dir : path) : "");
});

watch(
  () => route.query.path,
  (path) => {
    if (typeof path === "string" && path && path !== currentFile.value) {
      loadPath(isPlaylist.value && route.query.dir ? route.query.dir : path);
    }
  }
);

onUnmounted(() => {
  alive = false;
  clearInterval(timer);
  clearTimeout(idleTimer);
  window.removeEventListener("resize", onResize);
  window.removeEventListener("mousemove", onPointerMove);
  window.removeEventListener("keydown", onKey);
  invoke("mpv_release", { id: 0 }).catch(() => {});
  invoke("mpv_stop_all").catch(() => {});
});
</script>

<template>
  <div class="video-page">
    <span class="ghost-word">映</span>

    <header class="top-chrome" :class="{ 'chrome-hidden': !chromeVisible }">
      <button class="circle-btn" title="返回" @click="goBack">
        <Icon id="arrow-left" :size="18" />
      </button>
      <div class="head-titles">
        <div class="kicker">02 / VIDEO · 放映室</div>
        <h1 class="head-title">{{ fileName || "未载入影片" }}</h1>
        <div v-if="state?.codec || files.length" class="head-meta mono">
          <span v-if="files.length">{{ index + 1 }} / {{ files.length }}</span>
          <i v-if="state?.codec"></i>
          <span v-if="state?.codec">{{ state.codec }}</span>
        </div>
      </div>
      <div class="head-actions">
        <button
          v-if="files.length > 1"
          class="circle-btn"
          :class="{ on: playlistOpen }"
          title="播放列表"
          @click="togglePlaylist"
        >
          <Icon id="list" :size="18" />
        </button>
        <button class="circle-btn" :title="fullscreen ? '退出全屏' : '全屏'" @click="toggleFullscreen">
          <Icon :id="fullscreen ? 'minimize' : 'maximize'" :size="18" />
        </button>
      </div>
    </header>

    <div class="stage-row">
      <div ref="stage" class="stage">
        <div v-if="loading" class="stage-note">
          <Icon id="loader-circle" :size="22" class="spin" />
          <span>正在载入影片…</span>
        </div>
        <div v-else-if="!currentFile" class="stage-note">{{ error || "未找到视频文件" }}</div>
        <div v-else-if="!state" class="stage-note">等待画面信号…</div>
        <div v-else-if="!state.playing && !state.paused && !state.duration" class="stage-note">
          {{ error || "播放已结束" }}
        </div>
      </div>

      <aside class="playlist" :class="{ open: playlistOpen }">
        <div class="pl-head">
          <div class="kicker">PLAYLIST · 播放列表</div>
          <button class="pl-close" title="收起" @click="playlistOpen = false">
            <Icon id="x" :size="16" />
          </button>
        </div>
        <ul class="pl-list">
          <li
            v-for="(f, i) in files"
            :key="f.path"
            class="pl-item"
            :class="{ active: i === index }"
            @click="playIndex(i)"
          >
            <span class="pl-idx mono">{{ String(i + 1).padStart(2, "0") }}</span>
            <span class="pl-name">{{ f.name }}</span>
            <Icon v-if="i === index" id="play" :size="13" class="pl-play" />
          </li>
        </ul>
      </aside>
    </div>

    <footer class="bottom-chrome" :class="{ 'chrome-hidden': !chromeVisible }">
      <div class="glass bar">
        <div class="bar-seek">
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
            @pointerup="commitSeek"
            @keyup="commitSeek"
          />
          <span class="seek-time mono">{{ state ? fmt(dragPos ?? state.position) : "--:--" }}</span>
          <span class="seek-time mono dim">{{ state ? fmt(state.duration) : "--:--" }}</span>
        </div>
        <div class="bar-controls">
          <button v-if="files.length > 1" class="ctrl-btn" title="上一个" @click="prev">
            <Icon id="skip-back" :size="19" />
          </button>
          <button v-if="state" class="play-btn" :title="state.paused ? '播放' : '暂停'" @click="togglePause">
            <Icon :id="state.paused ? 'play' : 'pause'" :size="20" />
          </button>
          <button v-else class="play-btn" disabled title="暂停">
            <Icon id="play" :size="20" />
          </button>
          <button v-if="files.length > 1" class="ctrl-btn" title="下一个" @click="next">
            <Icon id="skip-forward" :size="19" />
          </button>
          <span v-if="error" class="bar-err">{{ error }}</span>
          <span class="bar-spacer"></span>
          <span class="bar-tip mono">空格 暂停 · ←/→ 进退 · ↑/↓ 切集 · F 全屏</span>
          <span v-if="files.length > 1" class="bar-chip mono">{{ index + 1 }} / {{ files.length }}</span>
        </div>
      </div>
    </footer>
  </div>
</template>

<style scoped lang="scss">
.video-page {
  --p-bg: #050508;
  --p-panel: rgba(17, 17, 23, 0.78);
  --p-line: rgba(255, 255, 255, 0.1);
  --p-text: #f4f1e9;
  --p-text-2: rgba(244, 241, 233, 0.6);
  --p-text-3: rgba(244, 241, 233, 0.36);
  --p-accent: #ff4d2e;
  --p-accent-2: #ff9a3d;

  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background:
    radial-gradient(90% 60% at 85% -10%, rgba(255, 77, 46, 0.1), transparent 55%),
    radial-gradient(55% 45% at -10% 110%, rgba(90, 60, 255, 0.07), transparent 60%),
    var(--p-bg);
  color: var(--p-text);
}

.ghost-word {
  position: absolute;
  top: 24px;
  right: 3vw;
  z-index: 0;
  font-family: var(--serif);
  font-size: clamp(220px, 34vw, 520px);
  font-weight: 900;
  line-height: 0.9;
  color: transparent;
  -webkit-text-stroke: 1px rgba(244, 241, 233, 0.05);
  pointer-events: none;
  user-select: none;
}

.top-chrome,
.bottom-chrome {
  position: relative;
  z-index: 3;
  opacity: 1;
  transform: translateY(0);
  transition: opacity 0.4s var(--ease-out), transform 0.4s var(--ease-out);

  &.chrome-hidden {
    opacity: 0;
    transform: translateY(-8px);
    pointer-events: none;
  }
}

.top-chrome {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 26px 30px 18px;
}

.circle-btn {
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border: 1px solid var(--p-line);
  border-radius: 50%;
  background: var(--p-panel);
  color: var(--p-text);
  cursor: pointer;
  backdrop-filter: blur(14px);
  transition: transform 0.25s var(--ease-out), border-color 0.25s, color 0.25s;

  &:hover {
    color: var(--p-accent);
    border-color: var(--p-accent);
    transform: translateY(-2px);
  }

  &.on {
    color: var(--p-accent);
    border-color: var(--p-accent);
    box-shadow: 0 0 0 4px rgba(255, 77, 46, 0.12);
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

.head-title {
  font-family: var(--serif);
  font-size: clamp(18px, 2.2vw, 26px);
  font-weight: 800;
  letter-spacing: 0.06em;
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
  font-size: 10.5px;
  letter-spacing: 0.18em;
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
  position: relative;
  z-index: 1;
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 0;
}

.stage {
  position: relative;
  flex: 1;
  min-width: 0;
  margin: 0 0 0 30px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-lg);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent 30%),
    #000;
  border: 1px solid rgba(255, 255, 255, 0.06);
  box-shadow: 0 40px 90px rgba(0, 0, 0, 0.55);
  overflow: hidden;
}

.stage-note {
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
  width: 0;
  overflow: hidden;
  margin: 0 30px 0 14px;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--p-line);
  border-radius: var(--radius-lg);
  background: var(--p-panel);
  backdrop-filter: blur(18px);
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
  padding: 18px 18px 14px;
  border-bottom: 1px solid var(--p-line);
  white-space: nowrap;
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
    background: linear-gradient(100deg, rgba(255, 77, 46, 0.14), transparent 80%);
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
  padding: 16px 30px 22px;

  &.chrome-hidden {
    transform: translateY(8px);
  }
}

.bar {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 16px 14px;
  border-radius: var(--radius-lg);
}

.bar-seek {
  display: flex;
  align-items: center;
  gap: 14px;
}

.seek {
  flex: 1;
  height: 4px;
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
    width: 13px;
    height: 13px;
    border-radius: 50%;
    background: #fff;
    border: none;
    box-shadow: 0 0 0 4px rgba(255, 77, 46, 0.22), 0 2px 8px rgba(0, 0, 0, 0.5);
    transition: transform 0.2s var(--ease-out);
  }

  &:hover::-webkit-slider-thumb {
    transform: scale(1.25);
  }

  &::-moz-range-thumb {
    width: 13px;
    height: 13px;
    border-radius: 50%;
    background: #fff;
    border: none;
    box-shadow: 0 0 0 4px rgba(255, 77, 46, 0.22);
  }
}

.seek-time {
  flex-shrink: 0;
  min-width: 46px;
  text-align: right;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--p-text);
  font-variant-numeric: tabular-nums;

  &.dim {
    color: var(--p-text-3);
    text-align: left;
  }
}

.bar-controls {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ctrl-btn {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border: 1px solid var(--p-line);
  border-radius: 50%;
  background: transparent;
  color: var(--p-text-2);
  cursor: pointer;
  transition: color 0.25s, border-color 0.25s, transform 0.25s var(--ease-out);

  &:hover {
    color: var(--p-accent);
    border-color: var(--p-accent);
    transform: translateY(-1px);
  }
}

.play-btn {
  width: 46px;
  height: 46px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--p-accent), var(--p-accent-2));
  color: #fff;
  cursor: pointer;
  box-shadow: 0 6px 24px rgba(255, 77, 46, 0.35);
  transition: transform 0.3s var(--ease-spring), box-shadow 0.3s;

  &:hover:not(:disabled) {
    transform: scale(1.08);
    box-shadow: 0 10px 30px rgba(255, 77, 46, 0.45);
  }

  &:disabled {
    opacity: 0.4;
    cursor: default;
  }
}

.bar-err {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: #ff7a7a;
}

.bar-spacer {
  flex: 1;
}

.bar-tip {
  font-size: 10px;
  letter-spacing: 0.14em;
  color: var(--p-text-3);
  white-space: nowrap;
}

.bar-chip {
  padding: 5px 12px;
  border: 1px solid var(--p-line);
  border-radius: 999px;
  font-size: 10.5px;
  letter-spacing: 0.18em;
  color: var(--p-text-2);
  white-space: nowrap;
}

@media (max-width: 820px) {
  .stage {
    margin-left: 12px;
  }
  .playlist {
    margin-right: 12px;
  }
  .top-chrome,
  .bottom-chrome {
    padding-left: 14px;
    padding-right: 14px;
  }
  .bar-tip {
    display: none;
  }
  .head-meta {
    display: none;
  }
}
</style>
