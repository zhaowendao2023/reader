// 全局持久化偏好（设置模块）。
// 与 books store（store.bin 里的 theme / cssVars 阅读排版）分开管理：
// 这里统一放"应用级设置"，落在独立的 settings.bin，跨重启保留。
// 以前 packFileView / siderCollapsed 只存在 ui store 内存里，重启即丢，现已收编到这里。
import { Store } from "@tauri-apps/plugin-store";

const SETTINGS_FILE = "settings.bin";
const VIDEO_SEEK_SECONDS = [5, 10, 15, 30];
// 播放倍速档位的唯一来源：videoSession 也引用它渲染倍速面板，避免两处各写一份而漂移。
// 1× 必须留在档位里——它是默认值与「回到原速」的唯一入口。
export const VIDEO_PLAYBACK_SPEEDS = [1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export const useSettings = defineStore("settings", {
  state: () => ({
    // 图包内视频/图片的展示形态：'grid' 卡片 / 'list' 列表
    packFileView: "grid",
    // 书架卡片（漫画/影视图集等）是否显示来源信息（收藏文件夹 + 类型/后缀），默认关闭
    showSource: false,
    // 侧栏默认折叠状态
    siderCollapsed: true,
    // 漫画阅读时是否显示解析耗时小窗（timing-overlay）。默认开，保留现有行为。
    showParseTiming: true,
    // 视频快进/快退的统一步长（键盘、双击共用）。
    videoSeekSeconds: 15,
    // 视频固定倍速，全局记忆；长按临时倍速不会修改它。
    videoPlaybackSpeed: 1,
    // 是否已从磁盘恢复（App 启动时 load() 置位）
    loaded: false,
  }),
  actions: {
    async load() {
      try {
        const s = await Store.load(SETTINGS_FILE);
        const prefs = await s.get("prefs");
        if (prefs && typeof prefs === "object") {
          if (prefs.packFileView === "grid" || prefs.packFileView === "list") {
            this.packFileView = prefs.packFileView;
          }
          if (typeof prefs.showSource === "boolean") {
            this.showSource = prefs.showSource;
          } else if (typeof prefs.showComicMeta === "boolean") {
            // 兼容旧版字段名：漫画专用开关升级为全局「显示来源」
            this.showSource = prefs.showComicMeta;
          }
          if (typeof prefs.siderCollapsed === "boolean") {
            this.siderCollapsed = prefs.siderCollapsed;
          }
          if (typeof prefs.showParseTiming === "boolean") {
            this.showParseTiming = prefs.showParseTiming;
          }
          if (VIDEO_SEEK_SECONDS.includes(prefs.videoSeekSeconds)) {
            this.videoSeekSeconds = prefs.videoSeekSeconds;
          }
          if (VIDEO_PLAYBACK_SPEEDS.includes(prefs.videoPlaybackSpeed)) {
            this.videoPlaybackSpeed = prefs.videoPlaybackSpeed;
          }
        }
      } catch (error) {
        console.error("settings load failed:", error);
      } finally {
        this.loaded = true;
      }
    },
    async persist() {
      try {
        const s = await Store.load(SETTINGS_FILE);
        await s.set("prefs", {
          packFileView: this.packFileView,
          showSource: this.showSource,
          siderCollapsed: this.siderCollapsed,
          showParseTiming: this.showParseTiming,
          videoSeekSeconds: this.videoSeekSeconds,
          videoPlaybackSpeed: this.videoPlaybackSpeed,
        });
        await s.save();
      } catch (error) {
        console.error("settings save failed:", error);
      }
    },
    toggleSider() {
      this.siderCollapsed = !this.siderCollapsed;
      this.persist();
    },
    setPackFileView(v) {
      if (v !== "grid" && v !== "list") return;
      this.packFileView = v;
      this.persist();
    },
    setShowSource(v) {
      this.showSource = !!v;
      this.persist();
    },
    setShowParseTiming(v) {
      this.showParseTiming = !!v;
      this.persist();
    },
    setVideoSeekSeconds(v) {
      const value = Number(v);
      if (!VIDEO_SEEK_SECONDS.includes(value)) return;
      this.videoSeekSeconds = value;
      this.persist();
    },
    setVideoPlaybackSpeed(v) {
      const value = Number(v);
      if (!VIDEO_PLAYBACK_SPEEDS.includes(value)) return;
      this.videoPlaybackSpeed = value;
      this.persist();
    },
  },
});
