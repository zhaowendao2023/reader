<script setup>
import { nextTick } from "vue";
import { useBooks } from "../store/loadBooks";
import { useUI } from "../store/ui";
import { useSettings } from "../store/settings";
import { Window } from "@tauri-apps/api/window";
import Icon from "./Icon.vue";
import { openSearchItem } from "../utils/open";

const appWindow = new Window("main");

const booksStore = useBooks();
const ui = useUI();
const settings = useSettings();
const router = useRouter();
const route = useRoute();
const isWindows = computed(() => booksStore.platform === "windows");
const searchInput = ref(null);
const searchExpanded = ref(false);
let searchTimer = null;

// 搜索是全局能力，但不应该在每个页面都占据完整输入框。
// 主界面和搜索页适合直接输入，其它资料浏览页用按钮按需展开，设置页隐藏。
const searchMode = computed(() => {
  if (route.path === "/" || route.path === "/search") return "full";
  if (["/shelf", "/browse", "/tags"].includes(route.path)) return "button";
  return "hidden";
});

const showSearchInput = computed(() => searchMode.value === "full" || searchExpanded.value);

const topItems = computed(() => ui.searchItems.slice(0, 8));

const itemIcon = (item) => {
  if (item.kind === "comic") return "book-open";
  if (item.kind === "video") return "film";
  if (item.kind === "image") return "image";
  if (item.kind === "group") return "folder";
  return item.mediaType === "video" ? "film" : item.mediaType === "image" ? "image" : "folder";
};

const itemMeta = (item) => {
  if (!settings.showSource) return "";
  let meta;
  if (item.kind === "comic") meta = (item.ext || "comic").toUpperCase();
  else if (item.kind === "video" || item.kind === "image") {
    const parent = ui.searchParents.find((p) => p.pathKey === item.parentPath);
    meta = parent ? parent.name : "文件";
  } else if (item.kind === "group") meta = "目录";
  else meta = item.mediaType === "video" ? "视频" : item.mediaType === "image" ? "图片" : "媒体";
  // 标签命中的条目在元信息前加 #标签 标记
  const tag = item.matchedTags?.[0];
  return tag ? `#${tag} · ${meta}` : meta;
};

const clearSearch = () => {
  ui.searchQuery = "";
  ui.searchOpen = false;
  searchInput.value?.focus();
};

const openSearch = async () => {
  if (searchMode.value === "hidden") return;
  searchExpanded.value = true;
  await nextTick();
  searchInput.value?.focus();
};

const pickItem = (item) => {
  ui.searchOpen = false;
  // 记录来源页：让查看器/阅读器的「返回」回到当前页面（搜索下拉可出现在任何顶层页上）
  const from = { "/": "home", "/shelf": "shelf", "/browse": "browse", "/tags": "tags", "/search": "search" }[route.path];
  // /search 页内直接点结果：回退需带上当前关键词，让搜索页恢复原结果与位置
  openSearchItem(item, from === "search" ? { back: "search", q: ui.searchQuery } : from ? { back: from } : {});
};

const showAllResults = () => {
  const q = ui.searchQuery.trim();
  if (!q) return;
  ui.searchOpen = false;
  if (route.path === "/search") {
    router.replace({ path: "/search", query: { q } });
  } else {
    router.push({ path: "/search", query: { q } });
  }
};

// 输入防抖 250ms 后走 SQL 搜索；清空时同步清掉结果。
watch(
  () => ui.searchQuery,
  () => {
    clearTimeout(searchTimer);
    if (!ui.searchQuery.trim()) {
      ui.searchItems = [];
      ui.searchParents = [];
      ui.searching = false;
      ui.searchOpen = false;
      return;
    }
    ui.searchOpen = true;
    searchTimer = setTimeout(() => ui.runSearch(), 250);
  }
);

// "/" 聚焦搜索框，Esc 关闭搜索状态。
const onGlobalKeydown = (e) => {
  const tag = e.target?.tagName;
  if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA" && !e.target?.isContentEditable) {
    e.preventDefault();
    openSearch();
  } else if (e.key === "Escape" && document.activeElement === searchInput.value) {
    ui.searchQuery = "";
    ui.searchOpen = false;
    searchInput.value?.blur();
    if (searchMode.value === "button") searchExpanded.value = false;
  } else if (e.key === "Escape" && searchExpanded.value && searchMode.value === "button") {
    ui.searchOpen = false;
    searchExpanded.value = false;
  }
};

const onDocClick = (e) => {
  if (!e.target?.closest?.(".tb-search-wrap, .tb-search-launcher")) {
    ui.searchOpen = false;
    if (searchMode.value === "button") searchExpanded.value = false;
  }
};

watch(
  () => route.path,
  () => {
    ui.searchOpen = false;
    searchExpanded.value = false;
  }
);

onMounted(() => {
  window.addEventListener("keydown", onGlobalKeydown);
  document.addEventListener("click", onDocClick);
});

onUnmounted(() => {
  window.removeEventListener("keydown", onGlobalKeydown);
  document.removeEventListener("click", onDocClick);
  clearTimeout(searchTimer);
});
</script>

<template>
  <div class="topbar-wrap">
    <header class="topbar" data-tauri-drag-region>
      <div class="tb-left">
        <div v-if="showSearchInput" class="tb-search-wrap">
          <div class="tb-search">
            <Icon id="search" :size="16" class="tb-search-ico" />
            <input
              ref="searchInput"
              v-model="ui.searchQuery"
              class="tb-search-input"
              placeholder="搜索书架与文件"
              spellcheck="false"
              @focus="ui.searchOpen = true"
              @keydown.enter="showAllResults"
            />
            <button v-if="ui.searchQuery" class="tb-search-clear" title="清空" @click="clearSearch">
              <Icon id="x" :size="13" />
            </button>
            <span v-else class="tb-search-key mono">/</span>
          </div>

          <transition name="drop">
            <div v-if="ui.searchOpen && ui.searchQuery.trim()" class="search-drop glass">
              <div v-if="ui.searching" class="search-drop-empty">搜索中…</div>
              <template v-else-if="topItems.length">
                <button
                  v-for="item in topItems"
                  :key="item.pathKey"
                  class="search-drop-item"
                  @click="pickItem(item)"
                >
                  <span class="sdi-ico"><Icon :id="itemIcon(item)" :size="15" /></span>
                  <span class="sdi-name">{{ item.name }}</span>
                  <span class="sdi-meta mono">{{ itemMeta(item) }}</span>
                </button>
                <button class="search-drop-all" @click="showAllResults">
                  <span>查看全部 {{ ui.searchItems.length }} 条结果</span>
                  <Icon id="chevron-right" :size="14" />
                </button>
              </template>
              <div v-else class="search-drop-empty">无匹配结果</div>
            </div>
          </transition>
        </div>
        <button
          v-else-if="searchMode === 'button'"
          class="tb-btn tb-search-launcher"
          title="搜索"
          aria-label="搜索"
          @click="openSearch"
        >
          <Icon id="search" :size="19" />
        </button>
      </div>

      <div v-if="isWindows" class="tb-drag" data-tauri-drag-region @mousedown="appWindow.startDragging"></div>

      <div class="tb-right">
        <button v-if="isWindows" class="tb-btn" title="最小化" @click="appWindow.minimize()">
          <Icon id="minus" :size="18" />
        </button>
        <button v-if="isWindows" class="tb-btn tb-close" title="关闭" @click="appWindow.close()">
          <Icon id="x" :size="18" />
        </button>
      </div>
    </header>
  </div>
</template>

<style scoped lang="scss">
.topbar-wrap {
  position: absolute;
  top: 14px;
  left: 18px;
  right: 18px;
  z-index: 30;
  pointer-events: none;
}

.topbar {
  pointer-events: none;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0;
}

.tb-left,
.tb-right {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 100%;
}

.tb-btn {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border: none;
  background: transparent;
  color: var(--text-2);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.25s var(--ease-out);

  &:hover {
    background: color-mix(in srgb, var(--text-1) 8%, transparent);
    color: var(--text-1);
    transform: translateY(-1px);
  }

  &.tb-close:hover {
    background: rgba(229, 72, 77, 0.14);
    color: #ff5c4d;
  }
}

/* 顶栏本身不可见，只让独立操作保留轻量玻璃底。 */
.tb-right .tb-btn,
.tb-search-launcher {
  border: 1px solid var(--line);
  background: color-mix(in srgb, var(--bg-1) 72%, transparent);
  backdrop-filter: blur(14px) saturate(1.25);
  box-shadow: 0 4px 16px color-mix(in srgb, #000 10%, transparent);
}

.tb-search {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  width: min(320px, 30vw);
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: color-mix(in srgb, var(--bg-1) 55%, transparent);
  backdrop-filter: blur(14px) saturate(1.25);
  box-shadow: var(--shadow-1);
  transition: border-color 0.25s, box-shadow 0.25s;

  &:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
}

.tb-search-ico {
  color: var(--text-3);
  flex-shrink: 0;
}

.tb-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-1);
  font-size: 13.5px;
  font-family: inherit;

  &::placeholder {
    color: var(--text-3);
  }
}

.tb-search-key {
  font-size: 11px;
  color: var(--text-3);
  padding: 1px 7px;
  border: 1px solid var(--line);
  border-radius: 6px;
}

.tb-search-wrap {
  position: relative;
}

.tb-search-clear {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  transition: all 0.2s;

  &:hover {
    background: color-mix(in srgb, var(--text-1) 10%, transparent);
    color: var(--text-1);
  }
}

.search-drop {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  width: min(400px, 68vw);
  max-height: 420px;
  overflow-y: auto;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--bg-1);
  box-shadow: var(--shadow-2);
  z-index: 60;
}

.search-drop-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 42px;
  padding: 0 12px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  text-align: left;
  transition: background 0.2s, color 0.2s;

  &:hover {
    background: var(--accent-soft);
    color: var(--accent);
  }
}

.sdi-ico {
  display: grid;
  place-items: center;
  color: var(--text-3);
  flex-shrink: 0;
}

.sdi-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sdi-meta {
  font-size: 10px;
  color: var(--text-3);
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search-drop-all {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  height: 40px;
  margin-top: 6px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent-soft) 35%, transparent);
  color: var(--accent);
  font-size: 12.5px;
  cursor: pointer;
  transition: border-color 0.2s, transform 0.2s var(--ease-out);

  &:hover {
    border-color: var(--accent);
    transform: translateY(-1px);
  }
}

.search-drop-empty {
  padding: 18px 12px;
  font-size: 12.5px;
  color: var(--text-3);
  text-align: center;
}

.drop-enter-active,
.drop-leave-active {
  transition: opacity 0.18s var(--ease-out), transform 0.18s var(--ease-out);
}

.drop-enter-from,
.drop-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

.tb-drag {
  pointer-events: auto;
  flex: 1 1 auto;
  align-self: stretch;
  min-width: 48px;
  height: 100%;
}

/* ===== 手机断点：搜索撑满、按钮加大、隐藏键盘提示 ===== */
@media (max-width: 900px) {
  .topbar {
    height: 56px;
    gap: 8px;
  }

  .tb-left {
    flex: 1 1 auto;
    min-width: 0;
    gap: 6px;
  }

  .tb-right {
    gap: 4px;
  }

  /* 搜索框占满剩余宽度（替代固定的 min(320px,30vw)） */
  .tb-search-wrap {
    flex: 1 1 auto;
    min-width: 0;
  }

  .tb-search {
    width: 100%;
    height: 42px;
  }

  /* 触屏无键盘，隐藏 "/" 快捷键徽标 */
  .tb-search-key {
    display: none;
  }

  .tb-btn {
    width: 42px;
    height: 42px;
  }

  /* 手机端结果下拉尽量贴近全宽 */
  .search-drop {
    width: calc(100vw - 36px);
    left: 0;
  }
}

/* 纯触屏（手机/平板）：强制各按钮达到 44px 触控目标 */
@media (hover: none) and (max-width: 900px) {
  .tb-btn {
    width: 44px;
    height: 44px;
  }

  .tb-search {
    height: 44px;
  }
}

/* 触屏无悬停语义：禁用顶栏按钮的位移反馈（颜色/背景反馈保留） */
@media (hover: none) {
  .tb-btn:hover,
  .search-drop-all:hover {
    transform: none;
  }
}
</style>
