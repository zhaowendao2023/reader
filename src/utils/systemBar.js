import { invoke } from "@tauri-apps/api/core";

/**
 * Android 系统栏（状态栏 + 导航栏）控制。
 *
 * 需求：视频播放 / 图集放映 / 漫画阅读等沉浸式内容页隐藏系统栏，而其余
 * 普通界面显示「透明系统栏」——不是黑色封死的那种，而是 edge-to-edge
 * 内容延伸、图标颜色随主题明暗切换，与页面背景融为一体。
 *
 * 原生侧把系统栏固定为透明 + edge-to-edge。这里只负责：
 *   1. 切换显隐（enterSystemUIImmersive / exitSystemUIImmersive）；
 *   2. 把系统栏当前占用的 CSS 像素高度同步为 :root 上的
 *      --sys-top / --sys-bottom，布局据此让内容避让系统栏；
 *   3. 主题切换时刷新系统栏图标明暗。
 *
 * 桌面端 / 非 Android：命令是 no-op 且恒返回 {0,0}，无任何副作用。
 */
const IS_ANDROID = /Android/i.test(navigator.userAgent);

let desired = { immersive: false, isDark: true }; // 最新期望态
let sent = null; // 已成功下发的态
let busy = false;

// 系统栏占用高度的 CSS 变量（px）。普通页需要让内容从它们下方开始。
const setBarVars = (top, bottom) => {
  const root = document.documentElement;
  root.style.setProperty("--sys-top", `${Math.round(top || 0)}px`);
  root.style.setProperty("--sys-bottom", `${Math.round(bottom || 0)}px`);
};

// 重新读取系统栏 inset。显示态切过来后 inset 要一帧后才稳定，
// 所以 setImmersive 结束后稍等再读一次。
async function refreshInsets() {
  if (!IS_ANDROID) return;
  try {
    const r = await invoke("get_system_bar_insets");
    setBarVars(r?.top ?? 0, r?.bottom ?? 0);
  } catch (e) {
    // 桌面/桥未就绪：静默
  }
}

// 串行下发并总是收敛到最新期望态：连续切换（如快速进出内容页）时
// 不丢最后一下，最终系统栏状态与当前页面一致。
async function flush() {
  if (busy || !IS_ANDROID) return;
  busy = true;
  try {
    while (sent?.immersive !== desired.immersive || sent?.isDark !== desired.isDark) {
      const target = desired;
      try {
        await invoke("set_system_bars", target);
        sent = target;
      } catch (e) {
        // 无此命令/插件或桥尚未就绪：静默；不标记 sent，稍后重试
        return;
      }
    }
    // 状态已到位后同步 inset（切到显示态需等原生布局帧）
    await new Promise((r) => setTimeout(r, 60));
    await refreshInsets();
  } finally {
    busy = false;
    if (sent?.immersive !== desired.immersive || sent?.isDark !== desired.isDark) {
      void flush(); // 期间又有新请求，续跑
    }
  }
}

let bound = false;
// 旋转/窗口尺寸变化会让系统栏 inset 变化，重新拉取最新值
function bindResize() {
  if (bound || !IS_ANDROID) return;
  bound = true;
  window.addEventListener("resize", () => void refreshInsets());
  window.addEventListener("orientationchange", () => void refreshInsets());
  window.addEventListener("focus", () => void refreshInsets());
}

/** 主题切换：记录并刷新系统栏图标明暗（配合 App.vue 主题 watch 调用）。 */
export function syncSystemUiTheme(dark) {
  desired = { ...desired, isDark: Boolean(dark) };
  bindResize();
  void flush();
}

/** 进入沉浸式内容页（隐藏系统栏），重复调用幂等。 */
export function enterSystemUIImmersive() {
  desired = { ...desired, immersive: true };
  bindResize();
  void flush();
}

/** 离开沉浸式内容页（显示透明系统栏）。 */
export function exitSystemUIImmersive() {
  desired = { ...desired, immersive: false };
  bindResize();
  void flush();
}