<script setup>
import { invoke } from "@tauri-apps/api/core";
import { readDir } from "@tauri-apps/plugin-fs";
import { useBooks } from "../store/loadBooks";
import { useUI } from "../store/ui";
import {
  covers,
  coverFailed,
  dirCache,
  getDrivesCache,
  setDrivesCache,
  enqueueCover,
  canonKey,
  prefetchCovers,
  stopPrefetch,
} from "../store/browserCache";
import { calculateHash } from "../utils/utils";
import { extOf, isVideo } from "../utils/media";
import Icon from "./Icon.vue";

const router = useRouter();
const route = useRoute();
const booksStore = useBooks();
const ui = useUI();

const COMIC_EXTS = ["cbz", "zip", "epub", "mobi"];

const isAndroid = computed(() => booksStore.platform === "android");

const current = ref(null); // { name, key }，null = 根视图
const history = ref([]);
const entries = ref([]);
const loading = ref(false);

// 视图模式：auto = 收藏夹用网格，否则列表
const view = ref("auto");
const isFavorite = computed(() => {
  if (!current.value) return false;
  const key = booksStore.platform === "windows" ? current.value.key.toLowerCase() : current.value.key;
  return booksStore.favoriteDirs.some((d) =>
    booksStore.platform === "windows" ? d.path.toLowerCase() === key : d.path === current.value.key
  );
});
const effectiveView = computed(() =>
  view.value === "auto" ? (isFavorite.value ? "grid" : "list") : view.value
);

// Android：先通过“所有文件访问权限”门，再以路径方式浏览
const allFilesOk = ref(false);
const rootKey = ref(null);

const cacheKey = (key) => (booksStore.platform === "windows" ? key.toLowerCase() : key);
const joinPath = (base, name) => {
  const sep = booksStore.platform === "windows" ? "\\" : "/";
  return base.endsWith(sep) ? base + name : base + sep + name;
};

const isComicFile = (name) => {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return COMIC_EXTS.includes(name.slice(dot + 1).toLowerCase());
};

const loadRoot = async () => {
  const cached = getDrivesCache();
  if (cached) {
    entries.value = cached;
    observeCovers();
    return;
  }
  loading.value = true;
  try {
    const drives = await invoke("list_drives");
    const list = drives.map((p) => ({ name: p, key: p, isDir: true }));
    setDrivesCache(list);
    entries.value = list;
  } catch (error) {
    console.error("读取磁盘失败:", error);
    entries.value = [];
  } finally {
    loading.value = false;
    observeCovers();
  }
};

const loadDir = async (key) => {
  const ck = isAndroid.value ? key : cacheKey(key);
  if (dirCache.has(ck)) {
    entries.value = dirCache.get(ck);
    observeCovers();
    return;
  }
  loading.value = true;
  try {
    const raw = await readDir(key);
    const dirs = [];
    const files = [];
    for (const e of raw) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory) {
        dirs.push({ name: e.name, key: joinPath(key, e.name), isDir: true });
      } else if (isComicFile(e.name) || isVideo(e.name)) {
        const entryKey = canonKey(joinPath(key, e.name));
        const entry = {
          name: e.name,
          key: entryKey,
          path: joinPath(key, e.name),
          isDir: false,
          ext: extOf(e.name),
          kind: isVideo(e.name) ? "video" : "comic",
        };
        files.push(entry);
      }
    }
    const byName = (a, b) => a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true });
    dirs.sort(byName);
    files.sort(byName);
    const result = [...dirs, ...files];
    dirCache.set(ck, result);
    entries.value = result;
  } catch (error) {
    console.error("读取目录失败:", error);
    entries.value = [];
  } finally {
    loading.value = false;
    observeCovers();
  }
};

const enter = async (entry) => {
  history.value.push({ name: entry.name, key: entry.key });
  current.value = { name: entry.name, key: entry.key };
  view.value = "auto";
  await loadDir(entry.key);
};

const enterRoot = async () => {
  if (isAndroid.value) {
    if (!allFilesOk.value || !rootKey.value) return;
    history.value = [{ name: "内部存储", key: rootKey.value }];
    current.value = { name: "内部存储", key: rootKey.value };
    await loadDir(rootKey.value);
    return;
  }
  current.value = null;
  view.value = "auto";
  await loadRoot();
};

// 侧边栏点击「文件夹预览」：直接回到根目录（驱动器列表）
watch(
  () => ui.navReset,
  () => {
    savedScroll = 0;
    enterRoot();
    nextTick(() => {
      if (scrollRef.value) scrollRef.value.scrollTop = 0;
    });
  }
);

const goUp = async () => {
  if (!history.value.length) return;
  history.value.pop();
  if (history.value.length) {
    const parent = history.value[history.value.length - 1];
    current.value = { name: parent.name, key: parent.key };
    view.value = "auto";
    await loadDir(parent.key);
  } else {
    current.value = null;
    view.value = "auto";
    if (isAndroid.value) await enterRoot();
    else await loadRoot();
  }
};

const crumbs = computed(() => {
  const rootName = isAndroid.value ? "内部存储" : "根目录";
  if (!current.value) return [{ name: rootName, key: null }];
  return [{ name: rootName, key: null }, ...history.value];
});

const jumpCrumb = async (c) => {
  if (!c.key) {
    history.value = [];
    current.value = null;
    view.value = "auto";
    if (isAndroid.value) await enterRoot();
    else await loadRoot();
    return;
  }
  const idx = history.value.findIndex((h) => h.key === c.key);
  if (idx >= 0) {
    history.value = history.value.slice(0, idx + 1);
    current.value = { name: c.name, key: c.key };
    view.value = "auto";
    await loadDir(c.key);
  }
};

const scrollRef = ref(null);
let savedScroll = 0;

const onScroll = () => {
  if (scrollRef.value) savedScroll = scrollRef.value.scrollTop;
};

watch(scrollRef, (el, old) => {
  if (old) old.removeEventListener("scroll", onScroll);
  if (el) el.addEventListener("scroll", onScroll, { passive: true });
});

onActivated(() => {
  nextTick(() => {
    if (scrollRef.value && savedScroll) scrollRef.value.scrollTop = savedScroll;
  });
  observeCovers();
});

onDeactivated(() => {
  coverObserver?.disconnect();
  stopPrefetch();
});

let coverObserver = null;
const observedCovers = new Set();

const observeCovers = async () => {
  await nextTick();
  coverObserver?.disconnect();
  observedCovers.clear();
  const nodes = document.querySelectorAll(".browser .grid-card, .browser .entry");
  coverObserver = new IntersectionObserver(
    (list) => {
      for (const item of list) {
        if (!item.isIntersecting) continue;
        const key = item.target.dataset.key;
        if (item.target.dataset.kind === "video") continue;
        coverObserver?.unobserve(item.target);
        if (observedCovers.has(key)) continue;
        observedCovers.add(key);
        enqueueCover(key, true);
      }
    },
    { rootMargin: "300px" }
  );
  for (const node of nodes) coverObserver.observe(node);
  prefetchCovers(
    entries.value.filter((e) => !e.isDir && e.kind !== "video").map((e) => e.key)
  );
};

watch(entries, () => {
  observeCovers();
});

watch(effectiveView, () => {
  observeCovers();
});

const toggleFavorite = async () => {
  if (!current.value) return;
  if (isFavorite.value) {
    await booksStore.removeFavoriteDir(current.value.key);
  } else {
    await booksStore.addFavoriteDir(current.value.key, current.value.name);
  }
};

const openVideo = async (entry) => {
  const key = booksStore.platform === "windows" ? cacheKey(entry.key) : entry.key;
  const id = await calculateHash(key);
  router.push({
    path: `/video/${id}`,
    query: { path: entry.path || entry.key, name: entry.name },
  });
};

const entryIcon = (entry) => {
  if (entry.isDir) return "folder";
  return entry.kind === "video" ? "play" : "book-open";
};

const openBook = async (entry) => {
  if (entry.kind === "video") {
    await openVideo(entry);
    return;
  }
  const key = booksStore.platform === "windows" ? cacheKey(entry.key) : entry.key;
  const id = await calculateHash(key);
  if (!booksStore.getBook(id)) {
    const title = entry.name.slice(0, entry.name.lastIndexOf("."));
    await booksStore.addBook({ [id]: { title, path: key, ext: entry.ext } });
  }
  router.push({ path: `/reading/${id}`, query: { from: current.value.key } });
};

const setupAndroid = async () => {
  try {
    const ok = await invoke("check_all_files_access");
    if (!ok) {
      allFilesOk.value = false;
      return false;
    }
    allFilesOk.value = true;
    rootKey.value = await invoke("get_primary_storage_path");
    return true;
  } catch (error) {
    allFilesOk.value = false;
    return false;
  }
};

const openAllFilesSettings = async () => {
  try {
    await invoke("open_all_files_access_settings");
  } catch (error) {
    console.error("打开设置失败:", error);
  }
};

const retryAllFiles = async () => {
  if (await setupAndroid()) {
    await enterRoot();
  }
};

const openPath = async (q) => {
  if (isAndroid.value) {
    if (!(await setupAndroid())) return;
  }
  const name = q.split(/[\\/]/).filter(Boolean).pop() || q;
  current.value = { name, key: q };
  await loadDir(q);
};

onUnmounted(() => {
  scrollRef.value?.removeEventListener("scroll", onScroll);
  coverObserver?.disconnect();
  stopPrefetch();
});

onMounted(async () => {
  if (isAndroid.value) {
    if (!(await setupAndroid())) return;
  }
  const q = route.query.path;
  if (typeof q === "string" && q) {
    await openPath(q);
  } else if (isAndroid.value) {
    await enterRoot();
  } else {
    await loadRoot();
  }
});

watch(
  () => route.query.path,
  (q) => {
    if (typeof q === "string" && q) openPath(q);
  }
);
</script>

<template>
  <div class="browser">
    <!-- 面包屑工具栏 -->
    <div class="browser-bar glass">
      <button class="bar-btn" :disabled="!current" @click="goUp" title="上一级">
        <Icon id="arrow-up" :size="17" />
      </button>
      <div class="crumbs">
        <template v-for="(c, i) in crumbs" :key="c.key || 'root'">
          <span class="crumb" :class="{ active: i === crumbs.length - 1 }" @click="jumpCrumb(c)">
            {{ c.name }}
          </span>
          <Icon v-if="i < crumbs.length - 1" id="chevron-right" :size="12" class="sep" />
        </template>
      </div>
      <div class="bar-actions">
        <button class="bar-btn" :class="{ on: view !== 'grid' }" title="列表视图" @click="view = view === 'list' ? 'auto' : 'list'">
          <Icon id="list" :size="17" />
        </button>
        <button class="bar-btn" :class="{ on: view === 'grid' }" title="网格视图" @click="view = view === 'grid' ? 'auto' : 'grid'">
          <Icon id="grid-2x2" :size="17" />
        </button>
        <span class="bar-divider"></span>
        <button
          class="bar-btn star"
          :class="{ active: isFavorite }"
          :disabled="!current"
          @click="toggleFavorite"
          :title="isFavorite ? '取消收藏' : '收藏此文件夹'"
        >
          <Icon :id="isFavorite ? 'star' : 'star'" :size="18" :stroke-width="isFavorite ? 2.2 : 1.8" />
        </button>
      </div>
    </div>

    <div v-if="isAndroid && !allFilesOk" class="perm-panel">
      <Icon id="scan" :size="40" />
      <p class="perm-title">需要开启所有文件访问权限</p>
      <p class="perm-tip">在系统设置里开启一次，之后即可浏览整个存储并收藏任意漫画文件夹</p>
      <div class="perm-actions">
        <button class="perm-btn primary" @click="openAllFilesSettings">去开启</button>
        <button class="perm-btn ghost" @click="retryAllFiles">我已开启，继续</button>
      </div>
    </div>

    <template v-else>
      <div v-if="loading" class="browser-hint">
        <Icon id="loader-circle" :size="22" class="spin" />
        <span>正在载入…</span>
      </div>

      <ul v-else-if="effectiveView === 'list'" class="browser-list" ref="scrollRef">
        <li
          v-for="(entry, i) in entries"
          :key="entry.key"
          class="entry reveal"
          :style="{ animationDelay: `${Math.min(i * 24, 400)}ms` }"
          :data-key="entry.key"
          :data-kind="entry.isDir ? 'dir' : entry.kind"
          @click="entry.isDir ? enter(entry) : openBook(entry)"
        >
          <span class="entry-ico" :class="{ dir: entry.isDir }">
            <Icon :id="entryIcon(entry)" :size="19" />
          </span>
          <img v-if="!entry.isDir && covers[entry.key]" :src="covers[entry.key]" class="entry-cover" alt="" loading="lazy" decoding="async" />
          <span class="entry-name">{{ entry.name }}</span>
          <span v-if="!entry.isDir" class="entry-ext mono">{{ entry.ext.toUpperCase() }}</span>
          <Icon id="chevron-right" :size="15" class="entry-arrow" />
        </li>
      </ul>

      <ul v-else class="browser-grid" ref="scrollRef">
        <li
          v-for="(entry, i) in entries"
          :key="entry.key"
          class="grid-card reveal"
          :style="{ animationDelay: `${Math.min(i * 40, 500)}ms` }"
          :data-key="entry.key"
          :data-kind="entry.isDir ? 'dir' : entry.kind"
          @click="entry.isDir ? enter(entry) : openBook(entry)"
        >
          <div class="grid-cover-wrap">
            <img v-if="!entry.isDir && covers[entry.key]" :src="covers[entry.key]" class="grid-cover" alt="" loading="lazy" decoding="async" />
            <span v-else class="grid-icon" :class="{ dir: entry.isDir }">
              <Icon :id="entryIcon(entry)" :size="38" :stroke-width="1.75" />
            </span>
            <span v-if="!entry.isDir" class="grid-ext mono">{{ entry.ext.toUpperCase() }}</span>
          </div>
          <div class="grid-name"><n-ellipsis :tooltip="false">{{ entry.name }}</n-ellipsis></div>
        </li>
      </ul>

      <div v-if="!loading && !entries.length" class="browser-hint empty">
        <Icon id="folder-open" :size="34" />
        <span>这个文件夹里没有漫画或视频</span>
      </div>
    </template>
  </div>
</template>

<style scoped lang="scss">
.browser {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 148px 18px 0;
  background:
    radial-gradient(50% 40% at 10% 0%, color-mix(in srgb, var(--accent-2) 7%, transparent), transparent 60%),
    var(--bg-0);
}

/* 面包屑 */
.browser-bar {
  position: absolute;
  top: 78px;
  left: 18px;
  right: 18px;
  z-index: 5;
  height: 50px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 10px;
  border-radius: 16px;
  box-shadow: var(--shadow-1);
}

.bar-btn {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border: none;
  background: transparent;
  color: var(--text-3);
  border-radius: 9px;
  cursor: pointer;
  transition: all 0.22s var(--ease-out);
  flex-shrink: 0;

  &:hover:not(:disabled) {
    background: color-mix(in srgb, var(--text-1) 8%, transparent);
    color: var(--text-1);
  }

  &:disabled {
    opacity: 0.3;
    cursor: default;
  }

  &.on {
    color: var(--accent);
    background: var(--accent-soft);
  }

  &.star.active {
    color: #ffb400;
    background: rgba(255, 180, 0, 0.12);
  }
}

.crumbs {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

.crumb {
  font-size: 13px;
  color: var(--text-2);
  cursor: pointer;
  padding: 5px 8px;
  border-radius: 8px;
  transition: all 0.2s;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;

  &:hover {
    color: var(--accent);
    background: var(--accent-soft);
  }

  &.active {
    color: var(--text-1);
    font-weight: 600;
  }
}

.sep {
  color: var(--text-3);
  flex-shrink: 0;
}

.bar-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.bar-divider {
  width: 1px;
  height: 20px;
  background: var(--line);
  margin: 0 6px;
}

/* 列表视图 */
.browser-list {
  list-style: none;
  margin: 0;
  padding: 6px 0 40px;
  overflow-y: auto;
  scrollbar-width: none;
  &::-webkit-scrollbar {
    display: none;
  }
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.entry {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-radius: 12px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.25s var(--ease-out);
  /* 屏外条目跳过布局/绘制，侧栏伸缩、大量条目时避免整屏 reflow */
  content-visibility: auto;
  contain-intrinsic-size: auto 66px;

  &:hover {
    background: var(--panel);
    border-color: var(--line);
    transform: translateX(3px);
    .entry-arrow {
      opacity: 1;
      transform: translateX(0);
    }
  }
}

.entry-ico {
  width: 38px;
  height: 46px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent);
  flex-shrink: 0;

  &.dir {
    background: color-mix(in srgb, var(--accent-2) 14%, transparent);
    color: var(--accent-2);
  }
}

.entry-cover {
  width: 34px;
  height: 46px;
  object-fit: cover;
  border-radius: 8px;
  flex-shrink: 0;
  box-shadow: var(--shadow-1);
}

.entry-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  color: var(--text-1);
}

.entry-ext {
  font-size: 9.5px;
  letter-spacing: 0.14em;
  color: var(--text-3);
  padding: 3px 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  flex-shrink: 0;
}

.entry-arrow {
  color: var(--text-3);
  opacity: 0;
  transform: translateX(-4px);
  transition: all 0.25s var(--ease-out);
  flex-shrink: 0;
}

/* 网格视图 */
.browser-grid {
  list-style: none;
  margin: 0;
  padding: 6px 0 40px;
  overflow-y: auto;
  scrollbar-width: none;
  &::-webkit-scrollbar {
    display: none;
  }
  flex: 1;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 28px 16px;
  align-content: start;
}

.grid-card {
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  /* 屏外卡片跳过布局/绘制：侧栏伸缩、封面批量加载时不再整屏 reflow */
  content-visibility: auto;
  contain-intrinsic-size: auto 300px;
}

.grid-cover-wrap {
  position: relative;
  aspect-ratio: 1 / 1.414;
  border-radius: 10px;
  overflow: hidden;
  background: var(--bg-2);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-1);
  display: grid;
  place-items: center;
  transition: transform 0.45s var(--ease-spring), box-shadow 0.45s var(--ease-out);
}

.grid-card:hover .grid-cover-wrap {
  transform: translateY(-6px) scale(1.02);
  box-shadow: var(--shadow-2);
}

.grid-cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.grid-icon {
  color: var(--text-3);
  &.dir {
    color: color-mix(in srgb, var(--accent-2) 70%, var(--text-3));
  }
}

.grid-ext {
  position: absolute;
  right: 8px;
  bottom: 8px;
  padding: 3px 7px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.55);
  color: rgba(255, 255, 255, 0.9);
  font-size: 9px;
  letter-spacing: 0.12em;
  backdrop-filter: blur(6px);
}

.grid-name {
  text-align: center;
  font-size: 12.5px;
  color: var(--text-2);
  line-height: 1.35;
  padding: 0 2px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* 提示 */
.browser-hint {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-3);
  font-size: 14px;

  &.empty {
    gap: 14px;
  }
}

.spin {
  animation: spin 1s linear infinite;
}

/* 权限面板 */
.perm-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-3);
  text-align: center;
  padding: 30px;

  .perm-title {
    font-size: 17px;
    font-weight: 600;
    color: var(--text-1);
  }

  .perm-tip {
    font-size: 13px;
    max-width: 360px;
    line-height: 1.7;
  }
}

.perm-actions {
  display: flex;
  gap: 10px;
  margin-top: 12px;
}

.perm-btn {
  height: 42px;
  padding: 0 22px;
  border-radius: 999px;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.25s var(--ease-out);

  &.primary {
    border: none;
    background: var(--accent-grad);
    color: #fff;
    box-shadow: var(--glow);
    &:hover {
      transform: translateY(-2px);
    }
  }

  &.ghost {
    background: transparent;
    color: var(--text-2);
    border: 1px solid var(--line-strong);
    &:hover {
      color: var(--accent);
      border-color: var(--accent);
    }
  }
}
</style>
