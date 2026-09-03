<template>
  <div class="app-shell" :class="{ 'is-mobile': isAndroid, 'rail-open': !collapsed }">
    <!-- 侧边导航栏 -->
    <aside class="nav-rail">
      <div class="rail-inner">
        <div class="brand">
          <button class="brand-mark" title="返回主界面" @click="handleMenuSelect('home')">
            <Icon id="book-open" :size="20" :stroke-width="2" />
          </button>
          <div class="brand-name" :class="{ hidden: collapsed }">
            <span class="brand-title">朝闻道</span>
            <span class="brand-sub">READING ARCHIVE</span>
          </div>
        </div>

        <nav class="nav-list">
          <button
            v-for="item in mainNavItems"
            :key="item.key"
            class="nav-item"
            :class="{ active: menuValue === item.key }"
            @click="handleMenuSelect(item.key)"
          >
            <span class="nav-ico"><Icon :id="item.icon" :size="19" /></span>
            <span class="nav-label" :class="{ hidden: collapsed }">{{ item.label }}</span>
            <span v-if="!collapsed" class="nav-index mono">{{ item.index }}</span>
          </button>
        </nav>

        <div class="nav-foot">
          <button class="nav-item" title="切换外观" @click="booksStore.changeTheme()">
            <span class="nav-ico"><Icon :id="themeIcon" :size="19" /></span>
            <span class="nav-label" :class="{ hidden: collapsed }">外观</span>
          </button>
          <button
            class="nav-item"
            :class="{ active: menuValue === 'settings' }"
            title="设置"
            @click="handleMenuSelect('settings')"
          >
            <span class="nav-ico"><Icon id="settings" :size="19" /></span>
            <span class="nav-label" :class="{ hidden: collapsed }">设置</span>
          </button>
          <button class="nav-item" title="收起侧栏" @click="settings.toggleSider()">
            <span class="nav-ico"><Icon :id="collapsed ? 'panel-left-open' : 'panel-left-close'" :size="19" /></span>
            <span class="nav-label" :class="{ hidden: collapsed }">{{ collapsed ? '展开' : '收起' }}</span>
          </button>
        </div>
      </div>
    </aside>

    <!-- 主区域 -->
    <main class="main-area">
      <Header />
      <div class="view-stage">
        <keep-alive>
          <Home v-if="route.path === '/'" />
        </keep-alive>
        <keep-alive>
          <Display v-if="route.path === '/shelf'" />
        </keep-alive>
        <keep-alive>
          <FileBrowser v-if="route.path === '/browse'" />
        </keep-alive>
        <keep-alive>
          <SearchPage v-if="route.path === '/search'" />
        </keep-alive>
        <keep-alive>
          <TagBrowse v-if="route.path === '/tags'" />
        </keep-alive>
        <keep-alive>
          <Settings v-if="route.path === '/settings'" />
        </keep-alive>
      </div>
    </main>

    <!-- 移动端底部导航：窄屏时替换侧栏 -->
    <nav class="mobile-tabbar" aria-label="主导航">
      <button
        v-for="item in navItems"
        :key="item.key"
        class="tab-item"
        :class="{ active: menuValue === item.key }"
        @click="handleMenuSelect(item.key)"
      >
        <span class="tab-ico"><Icon :id="item.icon" :size="20" /></span>
        <span class="tab-label">{{ item.label }}</span>
      </button>
    </nav>
  </div>
</template>
<script setup>
defineOptions({ name: "LayOut" });
import Icon from "./Icon.vue";
import Home from "./Home.vue";
import Display from "./Display.vue";
import FileBrowser from "./FileBrowser.vue";
import SearchPage from "./SearchPage.vue";
import TagBrowse from "./TagBrowse.vue";
import Settings from "./Settings.vue";
import { useUI } from "../store/ui";
import { useBooks } from "../store/loadBooks";
import { useSettings } from "../store/settings";

const route = useRoute();
const router = useRouter();
const booksStore = useBooks();
const ui = useUI();
const settings = useSettings();
const isAndroid = computed(() => booksStore.platform === "android");
const collapsed = computed(() => settings.siderCollapsed);

const themeIcon = computed(() => (booksStore.theme ? "sun" : "moon"));

const navItems = [
  { label: "主界面", key: "home", icon: "home", index: "01" },
  { label: "收藏", key: "shelf", icon: "star", index: "02" },
  { label: "文件夹预览", key: "browse", icon: "folder", index: "03" },
  { label: "标签", key: "tags", icon: "tag", index: "04" },
  { label: "设置", key: "settings", icon: "settings", index: "05" },
];

// 桌面侧栏顶部只放三个主页面；设置挪到 nav-foot（底部），移动端底部栏仍含全部四项
const mainNavItems = computed(() => navItems.filter((i) => i.key !== "settings"));

const menuValue = computed(() => {
  if (route.path === "/shelf") return "shelf";
  if (route.path === "/browse") return "browse";
  if (route.path === "/tags") return "tags";
  if (route.path === "/settings") return "settings";
  return "home";
});

const handleMenuSelect = (key) => {
  const target =
    key === "home"
      ? "/"
      : key === "shelf"
        ? "/shelf"
        : key === "browse"
          ? "/browse"
          : key === "tags"
            ? "/tags"
            : "/settings";
  // 已在该路由也触发一次 reset，让视图直接回到本栏目的主界面
  if (route.path !== target) router.push(target);
  ui.resetView();
};
</script>

<style scoped lang="scss">
.app-shell {
  --rail-w: 72px;
  position: relative;
  height: 100vh;
  overflow: hidden;
  background: var(--bg-0);
  transition: background-color 0.3s var(--ease-out);
  &.rail-open {
    --rail-w: 216px;
  }
}

/* ===== 侧栏 ===== */
.nav-rail {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  z-index: 20;
  width: var(--rail-w);
  display: flex;
  flex-direction: column;
  background: var(--bg-1);
  border-right: 1px solid var(--line);
  transition: width 0.24s var(--ease-out), background-color 0.3s var(--ease-out), border-color 0.3s var(--ease-out);
  overflow: hidden;
}

.rail-inner {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 18px 12px 14px;
  gap: 26px;
  overflow: hidden;
}

/* 品牌 */
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 4px;
}

.brand-mark {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  color: var(--text-1);
  background: linear-gradient(140deg, var(--accent-soft), transparent 60%);
  cursor: pointer;
  transition: transform 0.25s var(--ease-out), border-color 0.25s var(--ease-out), color 0.25s, box-shadow 0.25s var(--ease-out);
  position: relative;
  overflow: hidden;

  &:hover {
    transform: translateY(-2px) rotate(-3deg);
    border-color: var(--accent);
    color: var(--accent);
    box-shadow: var(--glow);
  }
}

.brand-name {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  max-width: 180px;
  transition: opacity 0.18s;

  &.hidden {
    opacity: 0;
    pointer-events: none;
  }
}

.brand-title {
  font-family: var(--serif);
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: var(--text-1);
}

.brand-sub {
  font-family: var(--mono);
  font-size: 8.5px;
  letter-spacing: 0.28em;
  color: var(--text-3);
}

/* 导航项 */
.nav-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  height: 46px;
  padding: 0 14px;
  border: none;
  background: transparent;
  color: var(--text-2);
  border-radius: 12px;
  cursor: pointer;
  font-size: 14px;
  transition: background 0.3s, color 0.3s;
  overflow: hidden;
  white-space: nowrap;

  .nav-ico {
    display: grid;
    place-items: center;
    width: 20px;
    flex-shrink: 0;
    transition: transform 0.3s var(--ease-spring);
  }

  .nav-label {
    flex: 1;
    min-width: 0;
    max-width: 200px;
    text-align: left;
    letter-spacing: 0.06em;
    overflow: hidden;
    white-space: nowrap;
    transition: opacity 0.18s;
    &.hidden {
      opacity: 0;
    }
  }

  .nav-index {
    font-size: 9px;
    color: var(--text-3);
  }

  &:hover {
    background: color-mix(in srgb, var(--text-1) 6%, transparent);
    color: var(--text-1);
    .nav-ico {
      transform: translateX(2px);
    }
  }

  &.active {
    background: var(--accent-soft);
    color: var(--accent);
    .nav-ico,
    .nav-index {
      color: var(--accent);
    }
    &::before {
      content: "";
      position: absolute;
      left: 0;
      top: 50%;
      transform: translateY(-50%);
      width: 3px;
      height: 22px;
      border-radius: 0 3px 3px 0;
      background: var(--accent-grad);
    }
  }
}

.nav-foot {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* 收起态：无额外规则——折叠时唯一的几何变化就是 --rail-w 收窄。
   行内布局（rail-inner/行的 padding、gap、justify）两态完全一致，图标锚点固定：
   之前折叠态会把图标 justify-content:center + 收 padding 重新居中，与宽度动画叠加导致左右晃动。 */

/* ===== 主区域 ===== */
.main-area {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: var(--rail-w);
  overflow: hidden;
  transition: left 0.24s var(--ease-out), background-color 0.3s var(--ease-out);
  background: var(--bg-0);
}

.view-stage {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

/* 移动端：瞬时切换，避免卡顿 */
.is-mobile .nav-rail,
.is-mobile .main-area {
  transition: none !important;
}

/* ===== 移动端底部导航（窄屏，替代侧栏）===== */
.mobile-tabbar {
  display: none;
}

@media (max-width: 899px) {
  /* 窄屏：侧栏隐藏，内容区占满全宽 */
  .nav-rail {
    display: none;
  }

  .main-area {
    left: 0;
    transition: none !important;
  }

  /* 底部 Tab 栏 */
  .mobile-tabbar {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 25;
    display: flex;
    align-items: stretch;
    height: 58px;
    background: color-mix(in srgb, var(--bg-1) 92%, transparent);
    border-top: 1px solid var(--line);
    box-shadow: 0 -6px 24px rgba(0, 0, 0, 0.06);
    backdrop-filter: blur(14px);
  }

  .tab-item {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    border: none;
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
    padding: 0;
    transition: color 0.2s;

    .tab-ico {
      display: grid;
      place-items: center;
      transition: transform 0.25s var(--ease-spring);
    }

    .tab-label {
      font-size: 10.5px;
      letter-spacing: 0.04em;
      white-space: nowrap;
    }

    &.active {
      color: var(--accent);
      .tab-ico {
        transform: translateY(-1px);
      }
      .tab-label {
        font-weight: 600;
      }
    }

    &:active {
      opacity: 0.7;
    }
  }
}

/* 触屏无悬停语义：侧栏/导航 hover 位移在窄屏底部 Tab 上无意义。
   侧栏本身只在触屏平板横向可能显示；统一在触屏下禁用其位移反馈。 */
@media (hover: none) {
  .brand-mark:hover,
  .nav-item:hover .nav-ico {
    transform: none;
  }
}
</style>
