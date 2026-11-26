import { createApp } from 'vue'
import { createPinia } from 'pinia'; // 导入 Pinia
import App from './App.vue';
import router from './router'

import './assets/global.css'

const pinia = createPinia();
const app = createApp(App);
app.use(pinia)

app.use(router)
app.mount('#app');

/* ===== Android 系统返回键 =====
 * MainActivity 已把实体返回键和 Android 13+ 预测性返回手势都转发到这里。
 *
 * 原始缺陷：模板生成的 WryActivity 在 WebView canGoBack() 为 false 时直接
 * finish() 退出整个 App；而本应用是 hash 路由 SPA，WebView 原生历史不可靠，
 * 且预测性返回手势根本不走 onKeyDown，导致在子页面按返回就直接退出软件。
 *
 * 这里由 Vue Router 判断：
 *   - 主界面（/）→ 返回 "exit" 让原生真正退出；
 *   - 其它顶层页（收藏/文件夹/搜索/标签/设置）→ 回主界面；
 *   - 子页面（阅读/视频/图集等）→ 沿显式维护的路由栈回退。
 * 不依赖 WebView 原生历史，所以回退行为与页面栈严格一致。
 */
const TOP_PAGES = new Set(['/', '/shelf', '/browse', '/search', '/tags', '/settings']);
const backStack = [];
let backActive = false;

router.afterEach((to, from) => {
  if (backActive) return;
  if (!from.name) return; // 首次进入，无来源
  if (from.fullPath === to.fullPath) return;
  // 顶层页之间的切换（底部 Tab / 搜索）不压栈，避免 Tab 跳转污染回退历史
  if (TOP_PAGES.has(from.path) && TOP_PAGES.has(to.path)) return;
  backStack.push(from.fullPath);
  if (backStack.length > 64) backStack.shift();
});

const goHome = () => {
  backActive = true;
  router.push('/').finally(() => { backActive = false; });
};

window.__handleAndroidBack = () => {
  const cur = router.currentRoute.value.path;
  // 文件浏览器/收藏页的内部目录层级优先：有子层级时先逐级回退
  if (typeof window.__dirBack === "function" && window.__dirBack()) return;
  if (cur === '/') {
    // 已到最初的界面（主界面）→ 退出应用
    backStack.length = 0;
    return 'exit';
  }
  if (TOP_PAGES.has(cur)) {
    // 顶层页（收藏/文件夹/搜索/标签/设置）→ 回主界面
    backStack.length = 0;
    goHome();
    return;
  }
  // 子页面 → 沿栈回退；栈空（如深链接直达）则回主界面
  const target = backStack.pop();
  if (target && target !== cur) {
    backActive = true;
    router.push(target).finally(() => { backActive = false; });
  } else {
    backStack.length = 0;
    goHome();
  }
};
