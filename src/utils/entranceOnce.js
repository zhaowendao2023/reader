// 入场动画只播一次（会话级）：
// 列表/板块首次挂载时保留 reveal 错峰上浮动画，之后（重进目录、切换模式、
// 页面重新激活、再次搜索）直接渲染、不再重播，避免每次进入都等一段渐入。
// 键按「页面.视图」区分；用定时器延后置位，保证首次动画完整跑完
// （rise 0.7s + 最大错峰延迟 0.6s + 余量）才关闭，避免中途被截断。
// 模块级单例：keep-alive 缓存或组件反复挂载时标记仍保留在同一会话内。
import { reactive } from "vue";

const played = reactive({});

// 首次动画完整时长：rise 0.7s + 最长 animationDelay 0.6s + 余量
const FIRST_PLAY_MS = 700 + 600 + 200;

/** 该视图是否还处于"首次可播动画"状态（尚未播过则为 true） */
export function entranceActive(key) {
  return !played[key];
}

/** 标记某视图的入场动画已播过一次；之后该视图不再重播 */
export function markEntrancePlayed(key, delay = FIRST_PLAY_MS) {
  setTimeout(() => {
    played[key] = true;
  }, delay);
}