<template>
  <div class="app-shell" :class="{ 'is-mobile': isAndroid, 'rail-open': !collapsed }">
    <!-- 侧边导航栏 -->
    <aside class="nav-rail" :class="{ 'is-collapsed': collapsed }">
      <div class="rail-inner">
        <div class="brand">
          <button class="brand-mark" title="返回书架" @click="router.push('/')">
            <Icon id="book-open" :size="20" :stroke-width="2" />
          </button>
          <div class="brand-name" :class="{ hidden: collapsed }">
            <span class="brand-title">朝闻道</span>
            <span class="brand-sub">READING ARCHIVE</span>
          </div>
        </div>

        <nav class="nav-list">
          <button
            v-for="item in navItems"
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
          <button class="nav-item" title="收起侧栏" @click="ui.toggleSider()">
            <span class="nav-ico"><Icon :id="collapsed ? 'panel-left-open' : 'panel-left-close'" :size="19" /></span>
            <span class="nav-label" :class="{ hidden: collapsed }">{{ collapsed ? '展开' : '收起' }}</span>
          </button>
          <div v-if="!collapsed" class="rail-ver mono">V0.1 · ZHAOWENDAO</div>
        </div>
      </div>
    </aside>

    <!-- 主区域 -->
    <main class="main-area">
      <Header />
      <div class="view-stage">
        <keep-alive>
          <Display v-if="route.path === '/'" />
        </keep-alive>
        <keep-alive>
          <FileBrowser v-if="route.path === '/browse'" />
        </keep-alive>
      </div>
    </main>
  </div>
</template>
<script setup>
defineOptions({ name: "LayOut" });
import Icon from "./Icon.vue";
import Display from "./Display.vue";
import FileBrowser from "./FileBrowser.vue";
import { useUI } from "../store/ui";
import { useBooks } from "../store/loadBooks";

const route = useRoute();
const router = useRouter();
const booksStore = useBooks();
const ui = useUI();
const isAndroid = computed(() => booksStore.platform === "android");
const collapsed = computed(() => ui.siderCollapsed);

const themeIcon = computed(() => (booksStore.theme ? "sun" : "moon"));

const navItems = [
  { label: "书架", key: "shelf", icon: "library", index: "01" },
  { label: "文件", key: "browse", icon: "folder", index: "02" },
];

const menuValue = computed(() => (route.path === "/browse" ? "browse" : "shelf"));

const handleMenuSelect = (key) => {
  if (key === "shelf") router.push("/");
  else if (key === "browse") router.push("/browse");
};
</script>

<style scoped lang="scss">
.app-shell {
  --rail-w: 66px;
  position: relative;
  height: 100vh;
  overflow: hidden;
  background: var(--bg-0);
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
  transition: width 0.32s var(--ease-out);
  overflow: hidden;
  will-change: width;
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
  padding: 0 6px;
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
  transition: all 0.35s var(--ease-spring);
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
  overflow: hidden;
  white-space: nowrap;
  max-width: 180px;
  transition: opacity 0.18s, transform 0.25s var(--ease-out), max-width 0.25s var(--ease-out);

  &.hidden {
    opacity: 0;
    transform: translateX(-10px);
    max-width: 0;
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
    transition: opacity 0.18s, transform 0.25s var(--ease-out), max-width 0.25s var(--ease-out);
    &.hidden {
      opacity: 0;
      transform: translateX(-8px);
      max-width: 0;
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

.rail-ver {
  margin-top: 14px;
  padding: 0 14px;
  font-size: 8.5px;
  letter-spacing: 0.24em;
  color: var(--text-3);
  white-space: nowrap;
  animation: fadeIn 0.6s both;
}


/* 收起态：图标居中、文字折叠 */
.nav-rail.is-collapsed {
  .rail-inner {
    padding-left: 13px;
    padding-right: 13px;
  }

  .brand,
  .nav-item {
    padding: 0;
    justify-content: center;
    gap: 0;
  }
}

/* ===== 主区域 ===== */
.main-area {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: var(--rail-w);
  overflow: hidden;
  transition: left 0.32s var(--ease-out);
  background: var(--bg-0);
  will-change: left;
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
</style>
