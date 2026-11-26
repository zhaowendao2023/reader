// 视频播放会话：命令层（mpv_* / video_*）+ 轮询 + 进度续播 + 音量/倍速状态。
//
// 从 VideoPlayer.vue 抽出的原因：这些是「与平台后端对话」的逻辑，和手势、控制栏、
// 全屏等视图状态无关。此前它们与 12 个模块级计时器/标志位混在一个 SFC 里，
// 任何播放时序调整（续播、自动续集、倍速串行）都要在模板噪音里找代码。
//
// 依赖由调用方注入：HUD 展示、控制栏唤醒、舞台矩形（播放器窗口定位）都属视图层，
// 会话只通过回调通知，不自己碰 DOM。
import { computed, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { readDir } from "@tauri-apps/plugin-fs";
import { VIDEO_EXTS, extOf, joinPath } from "./media";
import { dirCache, mediaDirKey, enqueueCover } from "../store/browserCache";
import { canonKey, itemId } from "./itemKey";
import { getVideoProgressEntry, getVideoProgressMap, setVideoProgress } from "./progress";

export const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];

const RESUME_MIN_SECONDS = 5;
const RESUME_END_GUARD_SECONDS = 10;
const SAVE_DELTA_SECONDS = 2;

export const fmt = (seconds) => {
  if (!Number.isFinite(seconds)) return "0:00";
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

/**
 * @param vcmd            命令名映射（Android: video_*, 桌面: mpv_*）
 * @param rect            舞台在屏幕上的像素矩形（播放器窗口定位用）
 * @param route           当前路由 query（playlist/dir/path）
 * @param hud             { show, hide } 播放 HUD
 * @param pokeChrome      唤醒控制栏
 * @param isLongPressing  长按临时倍速是否进行中（轮询不覆盖倍速显示）
 * @param speedSetting    持久化的默认倍速（getter）
 * @param saveSpeedSetting 记住用户选择的倍速
 */
export const useVideoSession = ({
  vcmd,
  rect,
  route = { query: {} },
  hud,
  pokeChrome,
  isLongPressing = () => false,
  speedSetting = () => 1,
  saveSpeedSetting = () => {},
}) => {
  const currentFile = ref("");
  const files = ref([]);
  const index = ref(0);
  const state = ref(null);
  const error = ref("");
  const loading = ref(true);
  const volume = ref(100);
  const playbackSpeed = ref(SPEED_OPTIONS.includes(speedSetting()) ? speedSetting() : 1);

  let alive = true;
  let wasPlaying = false;
  let volumeSynced = false;
  let volumeTimer = null;
  let lastNonZeroVolume = 100;
  let speedCommandChain = Promise.resolve(1);
  let resumeAt = null;
  let resumeFor = null;
  let lastSavedItem = null;
  let lastSavedPos = null;

  const isPlaylist = computed(() => route.query.playlist === "1");
  const volumeIcon = computed(() =>
    volume.value === 0 ? "volume-x" : volume.value < 50 ? "volume-1" : "volume-2"
  );
  const speedLabel = computed(() => `${Number(playbackSpeed.value).toFixed(2).replace(/\.00$/, "").replace(/0$/, "")}×`);

  const itemIdOf = (path) => itemId(path);

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
        playbackSpeed.value = await invokeSpeed(speedSetting());
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

  const togglePause = async () => {
    if (!state.value) return;
    const paused = !state.value.paused;
    try {
      await invoke(vcmd("pause"), { id: 0, paused });
      state.value = { ...state.value, paused };
      hud.show({
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

  // 任意显式跳转都会取消待生效的续播位置，否则轮询会把用户刚拖到的位置又拽回去。
  const seekTo = async (seconds) => {
    resumeAt = null;
    resumeFor = null;
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
    hud.show({
      type: "seek",
      icon: delta < 0 ? "skip-back" : "skip-forward",
      primary: `${delta < 0 ? "快退" : "快进"} ${Math.abs(delta)} 秒`,
      secondary: `${fmt(target)} / ${fmt(duration)}`,
    });
    pokeChrome();
  };

  const playIndex = async (nextIndex) => {
    if (!files.value.length) return;
    await saveNow();
    index.value = (nextIndex + files.value.length) % files.value.length;
    await play(files.value[index.value].path);
  };

  const next = () => playIndex(index.value + 1);
  const prev = () => playIndex(index.value - 1);

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
    const target = typeof single === "string" && single ? canonKey(single) : "";
    const explicitHit = target ? list.findIndex((f) => canonKey(f.path) === target) : -1;
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

  const loadPath = async (path) => {
    if (!path) {
      error.value = "缺少视频路径";
      loading.value = false;
      return;
    }
    loading.value = true;
    // 等两帧让 stage 完成布局，播放器窗口才能按真实矩形定位。
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

  const poll = async () => {
    if (!alive) return;
    try {
      const s = await invoke(vcmd("get_state"), { id: 0 });
      state.value = s || null;
      if (s) {
        if (!isLongPressing() && Number.isFinite(Number(s.speed)) && Number(s.speed) > 0) {
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

  // 设置音量并同步 HUD：滑杆、滚轮、手势、静音四处入口共用，
  // 避免每个入口各写一遍「记非零值 + 推送 + 提示」。
  const applyVolume = (next, { primary, quiet = false } = {}) => {
    volume.value = Math.max(0, Math.min(100, Math.round(Number(next) || 0)));
    if (volume.value > 0) lastNonZeroVolume = volume.value;
    pushVolume();
    hud.show({
      type: "volume",
      side: "right",
      icon: volumeIcon.value,
      primary: primary ?? `音量 ${volume.value}`,
    });
    // 手势滑动时只弹 HUD，不唤醒整个控制栏。
    if (!quiet) pokeChrome();
  };

  const onVolumeInput = (e) => applyVolume(e.target?.value);

  const adjustVolume = async (delta) => {
    if (!volumeSynced) await loadVolume();
    applyVolume(volume.value + delta);
  };

  const toggleMute = async () => {
    if (!volumeSynced) await loadVolume();
    if (volume.value > 0) {
      lastNonZeroVolume = volume.value;
      applyVolume(0, { primary: "已静音" });
    } else {
      applyVolume(Math.max(1, lastNonZeroVolume || 100));
    }
  };

  const setFixedSpeed = async (speed) => {
    const previous = playbackSpeed.value;
    try {
      const actual = await invokeSpeed(speed);
      playbackSpeed.value = actual;
      saveSpeedSetting(actual);
      hud.show({ type: "speed", primary: `${speedLabel.value} 播放` });
    } catch (e) {
      playbackSpeed.value = previous;
      error.value = String(e);
    }
    pokeChrome();
  };

  const loadFromQuery = () => {
    const dir = route.query.dir;
    const path = route.query.path;
    const target = typeof path === "string" && path
      ? (isPlaylist.value && typeof dir === "string" && dir ? dir : path)
      : "";
    return loadPath(target);
  };

  const dispose = () => {
    alive = false;
    clearTimeout(volumeTimer);
  };

  return {
    currentFile,
    files,
    index,
    state,
    error,
    loading,
    volume,
    playbackSpeed,
    volumeIcon,
    speedLabel,
    isPlaylist,
    loadFromQuery,
    loadPath,
    play,
    playIndex,
    next,
    prev,
    poll,
    togglePause,
    seekTo,
    seekBy,
    saveNow,
    invokeSpeed,
    setFixedSpeed,
    loadVolume,
    pushVolume,
    applyVolume,
    onVolumeInput,
    adjustVolume,
    toggleMute,
    dispose,
  };
};
