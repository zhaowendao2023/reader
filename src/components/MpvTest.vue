<script setup>
import { invoke } from "@tauri-apps/api/core";
import { Window } from "@tauri-apps/api/window";
import { readDir } from "@tauri-apps/plugin-fs";
import { VIDEO_EXTS } from "../utils/media";

defineOptions({ name: "MpvTest" });

const VIDEO_DIR = "F:\\video\\第1季";
const appWindow = new Window("main");
const stage = ref(null);
const files = ref([]);
const index = ref(0);
const currentFile = ref("");
const state = ref(null);
const error = ref("");
const loading = ref(true);
let timer = null;
let alive = true;

const rect = () => {
  // 强制布局，确保 stage 尺寸已就绪（首次挂载时 getBoundingClientRect 可能为 0）
  const r = stage.value.getBoundingClientRect();
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
    await invoke("mpv_play", { id: 0, path, ...rect() });
    currentFile.value = path;
    error.value = "";
  } catch (e) {
    error.value = String(e);
  }
};

const playIndex = async (next) => {
  if (!files.value.length) return;
  index.value = (next + files.value.length) % files.value.length;
  await play(files.value[index.value].path);
};

const next = () => playIndex(index.value + 1);
const prev = () => playIndex(index.value - 1);

const poll = async () => {
  if (!alive) return;
  try {
    state.value = await invoke("mpv_get_state", { id: 0 });
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
};

const seekTo = async (event) => {
  try {
    await invoke("mpv_seek", { id: 0, seconds: Number(event.target.value) });
  } catch (e) {
    error.value = String(e);
  }
};

const onResize = () => {
  invoke("mpv_set_bounds", { id: 0, ...rect() }).catch((e) => (error.value = String(e)));
};

const fmt = (seconds) => {
  if (!Number.isFinite(seconds)) return "0:00";
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

onMounted(async () => {
  alive = true;
  appWindow.show().catch(() => {});
  appWindow.setFocus().catch(() => {});
  timer = setInterval(poll, 500);
  window.addEventListener("resize", onResize);

  try {
    // 等待一帧 + 布局稳定，确保 stage 有真实尺寸
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const entries = await readDir(VIDEO_DIR);
    files.value = entries
      .filter((entry) => {
        const ext = entry.name.split(".").pop()?.toLowerCase() || "";
        return entry.isFile && VIDEO_EXTS.includes(ext);
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((entry) => ({
        name: entry.name,
        path: `${VIDEO_DIR}\\${entry.name}`,
      }));
    if (files.value.length) {
      await play(files.value[0].path);
    }
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
});

onUnmounted(() => {
  alive = false;
  clearInterval(timer);
  window.removeEventListener("resize", onResize);
  invoke("mpv_stop_all").catch(() => {});
});
</script>

<template>
  <div class="mpv-page">
    <div class="window-drag" data-tauri-drag-region></div>
    <div class="stage" ref="stage">
      <div v-if="loading" class="note">正在扫描视频…</div>
      <div v-else-if="!currentFile" class="note">没有找到视频</div>
      <div v-else class="note">{{ currentFile.split("\\").pop() }}</div>
    </div>

    <div class="toolbar">
      <button @click="prev">上一集</button>
      <button @click="next">下一集</button>
      <button v-if="state" @click="togglePause">{{ state.paused ? "继续" : "暂停" }}</button>
      <input
        v-if="state"
        type="range"
        class="seek"
        :min="0"
        :max="state.duration || 0"
        :value="state.position"
        step="0.1"
        @input="seekTo"
      />
      <span v-if="state" class="time">{{ fmt(state.position) }} / {{ fmt(state.duration) }}</span>
      <span v-if="files.length" class="index">{{ index + 1 }} / {{ files.length }}</span>
      <span class="err">{{ error }}</span>
    </div>
  </div>
</template>

<style scoped>
.mpv-page {
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: #0b0d12;
}

.window-drag {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 26px;
  z-index: 5;
}

.stage {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 82px;
  display: grid;
  place-items: center;
}

.note {
  max-width: 80%;
  color: rgba(255, 255, 255, 0.28);
  font-family: ui-monospace, monospace;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toolbar {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 8px;
  background: rgba(10, 12, 16, 0.9);
  color: #e8ecf3;
  font-size: 13px;
}

button {
  padding: 6px 12px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 6px;
  background: #1b2230;
  color: #e8ecf3;
  cursor: pointer;
  white-space: nowrap;
}

button:hover {
  background: #263147;
}

.seek {
  flex: 1;
  min-width: 80px;
  accent-color: #5b8cff;
}

.time,
.index,
.err {
  font-family: ui-monospace, monospace;
  white-space: nowrap;
}

.err {
  color: #ff7a7a;
}
</style>
