<script setup>
import { invoke } from "@tauri-apps/api/core";
import { useBooks } from "../store/loadBooks";
import { useSettings } from "../store/settings";
import { scanFavoriteTree } from "../utils/mediaScan";
import { IMAGE_EXTS, VIDEO_EXTS, extOf } from "../utils/media";
import { openImage as openImageRoute, openMediaPack, openVideo as openVideoRoute } from "../utils/open";
import { createScrollRestorer } from "../utils/scrollAnchor";
import { covers, canonKey, prefetchCovers, stopPrefetch } from "../store/browserCache";
import { useLazyCovers } from "../utils/lazyCovers";
import { closeContextMenu, openContextMenu, openGenericMenu } from "../utils/contextMenu";
import { buildItemMenu } from "../utils/itemMenu";
import { useItemActions } from "../utils/itemActions";
import { useCellLongPress } from "../utils/longPress";
import Icon from "./Icon.vue";
import MediaCover from "./MediaCover.vue";

defineOptions({ name: "MediaPack" });

const route = useRoute();
const router = useRouter();
const booksStore = useBooks();
const settings = useSettings();
const { copyPath, revealPath, requestDelete } = useItemActions({
  onDeleted: (item, path) => {
    // 删除后只做页面内定点移除，避免整棵子树重扫（scanFavoriteTree maxDepth=12）。
    // 物理删除/封面清理/收藏夹 DB 同步已由 itemActions.refreshLibraryForDelete 完成。
    dropDeletedFromView(item, path);
  },
});

const videos = ref([]);
const images = ref([]);
const loading = ref(true);
const error = ref("");
const allFilesOk = ref(true);
const node = ref(null);
const isGroup = computed(() => node.value?.kind === "group");
const isAndroid = computed(() => booksStore.platform === "android");
const children = computed(() => node.value?.children || []);

const dir = computed(() => route.query.dir);
const name = computed(() => {
  const n = route.query.name;
  if (typeof n === "string" && n) return n;
  const d = dir.value;
  return typeof d === "string" ? String(d).split(/[\\/]/).filter(Boolean).pop() || "图包" : "图包";
});
const hasContent = computed(() => videos.value.length || images.value.length || children.value.length);

const pad = (n) => String(n).padStart(2, "0");

// 分卷/季列表行的右侧元信息（与 MediaCover 的 label 语义一致）
const childMeta = (c) => {
  if (c.kind === "group") return `${c.childCount || c.count || 0} 项`;
  if (c.kind === "video-folder") return `${c.count || 0} 集`;
  if (c.kind === "image-folder") return `${c.count || 0} 张`;
  if (c.kind === "media-folder") return `视频 ${c.videoCount || 0} · 图片 ${c.imageCount || 0}`;
  return `${c.count || 0} 项`;
};

const init = async () => {
  loading.value = true;
  error.value = "";
  try {
    // Android 的媒体索引使用真实路径；没有“所有文件访问权限”时，
    // plugin-fs/read_dir 会返回空结果，不能把它误报成空图包。
    if (isAndroid.value) {
      allFilesOk.value = await invoke("check_all_files_access");
      if (!allFilesOk.value) return;
    } else {
      allFilesOk.value = true;
    }
    const d = dir.value;
    if (typeof d !== "string" || !d) {
      error.value = "缺少包路径";
      return;
    }
    const result = await scanFavoriteTree(d, name.value);
    const root = result.root;
    if (!root) {
      error.value = "这个文件夹里没有媒体";
      return;
    }
    node.value = root;
    const files = root.files || [];
    videos.value = files.filter((f) => VIDEO_EXTS.includes(f.ext));
    images.value = files.filter((f) => IMAGE_EXTS.includes(f.ext));
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
    // 数据就绪后再建立封面观察：可视区卡片/行走前台优先级（6 并发），
    // 其余由 prefetch 后台预热（2 并发），避免整包全量后台慢磨。
    observeCovers();
    // 数据就绪后恢复滚动位置（列表异步渲染，需等 DOM 出现）
    await restorePackScroll();
  }
};

const openAllFilesSettings = async () => {
  try {
    await invoke("open_all_files_access_settings");
  } catch (e) {
    console.error("打开设置失败:", e);
  }
};

const retryAllFiles = () => init();

// 删除后定点更新当前视图，语义与 scanFavoriteTree 保持一致：
// - 文件：从 files/videos/images 移除并重算 pack 计数；
// - 子分卷/季：从 children 移除；删光直接媒体后 pack 退化为 group。
const dropDeletedFromView = (item, path) => {
  const n = node.value;
  if (!n) return;
  const target = path || item.path || item.key;
  if (!target) return;

  const children = n.children || [];
  const files = n.files || [];
  if (files.some((f) => f.path === target)) {
    n.files = files.filter((f) => f.path !== target);
    videos.value = videos.value.filter((f) => f.path !== target);
    images.value = images.value.filter((f) => f.path !== target);
  } else if (children.some((c) => c.path === target || (c.key || c.path) === target)) {
    // 子分卷的 key 是 canonKey 后的规范化路径（大小写/分隔符已归一），原始 path 也要匹配
    n.children = children.filter((c) => c.path !== target && (c.key || c.path) !== target);
  } else {
    return; // 当前页面未展示该项，无需处理
  }

  if (n.kind !== "group" && !n.files.length && n.children.length) {
    n.kind = "group";
    n.ext = "group";
  }
  if (n.kind === "group") {
    n.count = n.children.reduce((s, c) => s + (c.count || 0), 0);
    n.videoCount = n.children.reduce((s, c) => s + (c.videoCount || 0), 0);
    n.imageCount = n.children.reduce((s, c) => s + (c.imageCount || 0), 0);
    n.childCount = n.children.length;
  } else {
    n.count = n.files.length;
    n.videoCount = videos.value.length;
    n.imageCount = images.value.length;
    n.childCount = n.children.length;
  }
};

// 封面懒加载：与 Home/Display/FileBrowser 同一套 IntersectionObserver。
// 可视区（+300px 预取）卡片/行走前台优先级 enqueueCover（6 并发），
// 其余在 prefetch 里后台批量预热（2 并发）——进包时第一屏封面秒出，
// 滚动到哪加载到哪，不用等整包全量提取完。
const lazyCovers = useLazyCovers({
  selector: ".pack-page .pack-card, .pack-page .pack-row",
  kindOf: (key, kind, node) => node.dataset.kind || kind || "comic",
  prefetch: () => {
    const all = [
      ...children.value.map((c) => ({ key: c.key || c.path, kind: c.kind || "group" })),
      ...videos.value.map((f) => ({ key: f.path, kind: "video" })),
      ...images.value.map((f) => ({ key: f.path, kind: "image" })),
    ];
    prefetchCovers(all);
  },
});
const observeCovers = () => lazyCovers.observe();

onMounted(init);
watch([dir, name], () => init());
// 列表/卡片视图切换后 DOM 重建，重新观察以保持可视区前台优先级
watch(() => settings.packFileView, () => observeCovers());

const goBack = () => {
  if (window.history.length > 1) router.back();
  else router.push("/");
};

const openVideo = (file) => {
  persistPackAnchorBeforeNav();
  return openVideoRoute(file, { dir: dir.value, playlist: true });
};

const openImage = (file) => {
  persistPackAnchorBeforeNav();
  return openImageRoute(file, { dir: dir.value });
};

const playAll = () => {
  if (videos.value.length) openVideo(videos.value[0]);
};

const viewImages = () => {
  if (!images.value.length) return;
  persistPackAnchorBeforeNav();
  return openImageRoute({ key: dir.value, path: dir.value, kind: "pack", name: name.value });
};

const openPack = (item) => {
  persistPackAnchorBeforeNav();
  return openMediaPack(item);
};

const openChild = (child) => openPack(child);

const rowMap = new Map();
const rebuildRowMap = () => {
  rowMap.clear();
  for (const f of videos.value) rowMap.set(f.path, f);
  for (const f of images.value) rowMap.set(f.path, f);
  for (const c of children.value) rowMap.set(c.key || c.path, c);
};
watch([videos, images, children], rebuildRowMap, { immediate: true });

// ── 锚点滚动恢复 ─────────────────────────────────────────────
// MediaPack 是独立路由页：进入子文件夹（openChild/openVideo/openImage）时组件会销毁重建，
// 滚动位置默认丢失。用与 Home/Display/FileBrowser 同一套锚点机制恢复：
// 滚动时（节流）保存 + 导航进子项前强制保存一次，init 数据就绪后恢复。
const pageEl = ref(null);
const anchorKey = () => `mediapack:${dir.value || ""}`;
const packScroll = createScrollRestorer({
  element: () => pageEl.value,
  stateKey: anchorKey,
  anchorKey,
  anchorSelector: ".pack-card[data-key], .pack-row[data-key]",
});
const savePackAnchor = () => packScroll.capture();
// 导航进子项前强制保存：组件即将销毁，节流窗口可能吞掉最后一次滚动位置
const persistPackAnchorBeforeNav = () => packScroll.checkpoint();
const restorePackScroll = () => packScroll.restoreAfterRender();

// 滚动容器 .pack-page 出现后绑定滚动保存；卸载时移除
watch(pageEl, (el, old) => {
  if (old) old.removeEventListener("scroll", savePackAnchor);
  if (el) el.addEventListener("scroll", savePackAnchor, { passive: true });
});

onUnmounted(() => {
  closeContextMenu();
  pageEl.value?.removeEventListener("scroll", savePackAnchor);
  stopPrefetch();
});

const openPackRowMenu = (item, x, y) => {
  const isDir = Boolean(item.kind && item.kind !== "comic");
  openContextMenu({
    x,
    y,
    items: buildItemMenu({
      item,
      isAndroid: booksStore.platform === "android",
      isDir,
      showTags: false,
      actions: { copyPath, revealPath, requestDelete },
      open: {
        icon: isDir ? "folder" : item.kind === "image" ? "image" : "play",
        onOpen: () => (isDir ? openChild(item) : item.kind === "image" ? openImage(item) : openVideo(item)),
      },
    }),
  });
};

const onPackContextMenu = (e) => {
  e.preventDefault();
  e.stopPropagation();
  const cell = e.target?.closest?.(".pack-row, .pack-card");
  const hit = cell?.dataset?.key ? rowMap.get(cell.dataset.key) : null;
  if (hit) openPackRowMenu(hit, e.clientX, e.clientY);
  else openGenericMenu(e.clientX, e.clientY);
};

const longPress = useCellLongPress({
  selector: ".pack-row, .pack-card",
  resolveHit: (cell) => rowMap.get(cell.dataset.key) || null,
  onHit: (hit, x, y) => openPackRowMenu(hit, x, y),
  onEmpty: (x, y) => openGenericMenu(x, y),
});

const headerMeta = computed(() => {
  if (!node.value) return [];
  if (isGroup.value) {
    return [`${node.value.childCount} 个分卷`, `视频 ${node.value.videoCount}`, `图片 ${node.value.imageCount}`];
  }
  return [`视频 ${videos.value.length}`, `图片 ${images.value.length}`];
});
</script>

<template>
  <div
    class="pack-page"
    ref="pageEl"
    @contextmenu="onPackContextMenu"
    @touchstart="longPress.onTouchStart"
    @touchmove="longPress.onTouchMove"
    @touchend="longPress.onTouchEnd"
    @touchcancel="longPress.onTouchCancel"
  >
    <span class="ghost-word">包</span>

    <header class="top-chrome" data-tauri-drag-region>
      <button class="circle-btn" title="返回" @click="goBack">
        <Icon id="arrow-left" :size="18" />
      </button>
      <div class="head-titles" data-tauri-drag-region>
        <div class="kicker">02 / MEDIA · 影视图集</div>
        <h1 class="head-title" data-tauri-drag-region>{{ name }}</h1>
      </div>
      <div class="top-drag" data-tauri-drag-region></div>
      <div v-if="!loading" class="head-meta mono">
        <span v-for="(m, i) in headerMeta" :key="i"><i v-if="i"></i>{{ m }}</span>
      </div>
    </header>

    <div v-if="loading" class="stage-note">
      <Icon id="loader-circle" :size="22" class="spin" />
      <span>正在载入包…</span>
    </div>
    <div v-else-if="isAndroid && !allFilesOk" class="stage-note permission-note">
      <Icon id="scan" :size="40" />
      <strong>需要开启所有文件访问权限</strong>
      <span>开启后才能读取影视图集中的原图</span>
      <div class="permission-actions">
        <button class="permission-btn primary" @click="openAllFilesSettings">去开启</button>
        <button class="permission-btn" @click="retryAllFiles">我已开启，继续</button>
      </div>
    </div>
    <div v-else-if="error" class="stage-note">{{ error }}</div>
    <div v-else-if="!hasContent" class="stage-note">这个包里没有视频或图片</div>

    <template v-else>
      <div class="pack-actions">
        <button v-if="videos.length" class="action-btn" @click="playAll">
          <Icon id="play" :size="15" />
          <span>连续播放</span>
        </button>
        <button v-if="images.length" class="action-btn action-btn--image" @click="viewImages">
          <Icon id="scan" :size="15" />
          <span>图包放映</span>
        </button>
        <div class="view-toggle">
          <button
            class="toggle-btn"
            :class="{ on: settings.packFileView === 'list' }"
            title="列表视图"
            @click="settings.setPackFileView('list')"
          >
            <Icon id="list" :size="16" />
          </button>
          <button
            class="toggle-btn"
            :class="{ on: settings.packFileView === 'grid' }"
            title="卡片视图"
            @click="settings.setPackFileView('grid')"
          >
            <Icon id="grid-2x2" :size="16" />
          </button>
        </div>
      </div>

      <div class="pack-scroll">
        <section v-if="children.length" class="pack-section">
          <div class="section-title mono">{{ isGroup ? "SERIES · 季/卷" : "VOLUMES · 分卷" }} · {{ children.length }}</div>
          <ul v-if="settings.packFileView === 'grid'" class="pack-card-grid">
            <li
              v-for="(child, i) in children"
              :key="child.key"
              class="pack-card"
              :data-key="child.key || child.path"
              :data-kind="child.kind"
              @click="longPress.onCellClick(() => openChild(child))"
            >
              <MediaCover
                :kind="child.kind"
                :ext="child.ext"
                :count="child.kind === 'group' ? child.childCount : child.count"
                :child-count="child.childCount"
                :video-count="child.videoCount"
                :image-count="child.imageCount"
                :index="i"
                :folder="name"
                :src="covers[child.key]"
                :meta="settings.showSource"
              />
              <div class="pack-card-name">
                <n-ellipsis :tooltip="false">{{ child.name }}</n-ellipsis>
              </div>
            </li>
          </ul>
          <ul v-else class="pack-list">
            <li
              v-for="(child, i) in children"
              :key="child.key"
              class="pack-row"
              :data-key="child.key || child.path"
              :data-kind="child.kind"
              @click="longPress.onCellClick(() => openChild(child))"
            >
              <span class="row-index mono">{{ pad(i + 1) }}</span>
              <span class="row-icon row-icon--folder"><Icon id="folder" :size="15" /></span>
              <span class="row-name">{{ child.name }}</span>
              <span v-if="settings.showSource" class="row-ext mono">{{ childMeta(child) }}</span>
              <Icon id="chevron-right" :size="15" class="row-arrow" />
            </li>
          </ul>
        </section>

        <section v-if="videos.length" class="pack-section">
          <div class="section-title mono">VIDEOS · {{ videos.length }}</div>
          <ul v-if="settings.packFileView === 'grid'" class="pack-card-grid">
            <li
              v-for="(file, i) in videos"
              :key="file.path"
              class="pack-card"
              :data-key="file.path"
              data-kind="video"
              @click="longPress.onCellClick(() => openVideo(file))"
            >
              <MediaCover
                kind="video"
                :ext="file.ext"
                :index="i"
                :src="covers[canonKey(file.path)]"
                :meta="settings.showSource"
                :data-key="file.path"
                data-kind="video"
              />
              <div class="pack-card-name">
                <n-ellipsis :tooltip="false">{{ file.name }}</n-ellipsis>
              </div>
            </li>
          </ul>
          <ul v-else class="pack-list">
            <li
              v-for="(file, i) in videos"
              :key="file.path"
              class="pack-row"
              :data-key="file.path"
              data-kind="video"
              @click="longPress.onCellClick(() => openVideo(file))"
            >
              <span class="row-index mono">{{ pad(i + 1) }}</span>
              <span class="row-icon row-icon--video"><Icon id="play" :size="15" /></span>
              <span class="row-name">{{ file.name }}</span>
              <span v-if="settings.showSource" class="row-ext mono">{{ extOf(file.name).toUpperCase() }}</span>
              <Icon id="chevron-right" :size="15" class="row-arrow" />
            </li>
          </ul>
        </section>

        <section v-if="images.length" class="pack-section">
          <div class="section-title mono">IMAGES · {{ images.length }}</div>
          <ul v-if="settings.packFileView === 'grid'" class="pack-card-grid">
            <li
              v-for="(file, i) in images"
              :key="file.path"
              class="pack-card"
              :data-key="file.path"
              data-kind="image"
              @click="longPress.onCellClick(() => openImage(file))"
            >
              <MediaCover
                kind="image"
                :ext="file.ext"
                :index="i"
                :src="covers[canonKey(file.path)]"
                :meta="settings.showSource"
                :data-key="file.path"
                data-kind="image"
              />
              <div class="pack-card-name">
                <n-ellipsis :tooltip="false">{{ file.name }}</n-ellipsis>
              </div>
            </li>
          </ul>
          <ul v-else class="pack-list">
            <li
              v-for="(file, i) in images"
              :key="file.path"
              class="pack-row"
              :data-key="file.path"
              data-kind="image"
              @click="longPress.onCellClick(() => openImage(file))"
            >
              <span class="row-index mono">{{ pad(i + 1) }}</span>
              <span class="row-icon row-icon--image"><Icon id="image" :size="15" /></span>
              <span class="row-name">{{ file.name }}</span>
              <span v-if="settings.showSource" class="row-ext mono">{{ extOf(file.name).toUpperCase() }}</span>
              <Icon id="chevron-right" :size="15" class="row-arrow" />
            </li>
          </ul>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped lang="scss">
.pack-page {
  /* 调色板派生自全局主题令牌（--bg-* / --text-* / --accent / --line），
     跟随浅色/深色主题切换，而不是写死黑色。 */
  --p-bg: var(--bg-0);
  --p-panel: var(--bg-1);
  --p-line: var(--line);
  --p-text: var(--text-1);
  --p-text-2: var(--text-2);
  --p-text-3: var(--text-3);
  --p-accent: var(--accent);
  --p-accent-2: #3b6fd6;

  position: fixed;
  inset: 0;
  overflow-y: auto;
  scrollbar-width: none;
  background:
    radial-gradient(70% 52% at 82% -8%, color-mix(in srgb, var(--p-accent-2) 8%, transparent), transparent 58%),
    radial-gradient(48% 42% at -6% 108%, color-mix(in srgb, var(--p-accent) 5%, transparent), transparent 60%),
    var(--p-bg);
  color: var(--p-text);
}

.ghost-word {
  position: absolute;
  top: 18px;
  right: 2vw;
  z-index: 0;
  font-family: var(--serif);
  font-size: clamp(180px, 26vw, 420px);
  font-weight: 900;
  line-height: 0.9;
  color: transparent;
  -webkit-text-stroke: 1px color-mix(in srgb, var(--p-text) 5%, transparent);
  pointer-events: none;
  user-select: none;
}

.top-chrome {
  position: sticky;
  top: 0;
  z-index: 5;
  margin: 16px 22px 0;
  min-height: 64px;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 12px;
  border: 1px solid var(--p-line);
  border-radius: 18px;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--p-text) 4%, transparent), color-mix(in srgb, var(--p-text) 1%, transparent)),
    var(--p-panel);
  backdrop-filter: blur(22px) saturate(1.3);
  box-shadow: var(--shadow-1);
}

.circle-btn {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border: 1px solid var(--p-line);
  border-radius: 50%;
  background: color-mix(in srgb, var(--p-text) 5%, transparent);
  color: var(--p-text-2);
  cursor: pointer;
  backdrop-filter: blur(10px);
  transition: transform 0.25s var(--ease-out), border-color 0.25s, color 0.25s;

  &:hover {
    color: var(--p-text);
    border-color: var(--p-accent);
    transform: translateY(-2px);
  }
}

.head-titles {
  min-width: 0;
  flex: 0 1 auto;
  display: flex;
  flex-direction: column;
  gap: 6px;

  .kicker {
    font-size: 9px;
    letter-spacing: 0.24em;
    color: var(--p-text-3);
  }
}

.top-drag {
  flex: 1 1 auto;
  align-self: stretch;
  min-width: 48px;
  height: 100%;
}

.head-title {
  font-family: var(--serif);
  font-size: clamp(22px, 3vw, 34px);
  font-weight: 800;
  line-height: 1.05;
  letter-spacing: 0.04em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.head-meta {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 10px;
  letter-spacing: 0.16em;
  color: var(--p-text-2);

  i {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--p-accent-2);
  }
}

.pack-actions {
  position: relative;
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding: 22px 26px 6px;
}

.action-btn {
  height: 40px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 18px;
  border: 1px solid color-mix(in srgb, var(--p-accent) 42%, transparent);
  border-radius: 999px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--p-accent) 22%, var(--p-panel)), color-mix(in srgb, var(--p-accent) 12%, var(--p-panel)));
  color: var(--p-text);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  backdrop-filter: blur(12px);
  transition: transform 0.25s var(--ease-out), border-color 0.25s, box-shadow 0.25s;

  &:hover {
    transform: translateY(-2px);
    border-color: var(--p-accent);
    box-shadow: 0 10px 30px color-mix(in srgb, var(--p-accent) 22%, transparent);
  }

  &--image {
    border-color: color-mix(in srgb, var(--p-accent-2) 42%, transparent);
    background: linear-gradient(135deg, color-mix(in srgb, var(--p-accent-2) 22%, var(--p-panel)), color-mix(in srgb, var(--p-accent-2) 10%, var(--p-panel)));

    &:hover {
      border-color: var(--p-accent-2);
      box-shadow: 0 10px 30px color-mix(in srgb, var(--p-accent-2) 22%, transparent);
    }
  }
}

.view-toggle {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px;
  border: 1px solid var(--p-line);
  border-radius: 12px;
  background: color-mix(in srgb, var(--p-text) 3%, transparent);
  backdrop-filter: blur(10px);

  .toggle-btn {
    width: 32px;
    height: 32px;
    display: grid;
    place-items: center;
    border: none;
    border-radius: 9px;
    background: transparent;
    color: var(--p-text-3);
    cursor: pointer;
    transition: background 0.2s, color 0.2s;

    &:hover {
      color: var(--p-text);
    }

    &.on {
      background: color-mix(in srgb, var(--p-text) 9%, transparent);
      color: var(--p-accent);
    }
  }
}

.pack-scroll {
  position: relative;
  z-index: 1;
  width: min(960px, calc(100% - 44px));
  margin: 0 auto;
  padding: 26px 0 60px;
}

.pack-section + .pack-section {
  margin-top: 36px;
}

.section-title {
  margin-bottom: 12px;
  font-size: 10px;
  letter-spacing: 0.28em;
  color: var(--p-text-3);
}

.pack-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pack-card-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 18px 14px;
}

.pack-card {
  cursor: pointer;
  /* 屏外卡片跳过布局/绘制：大量分卷/文件时避免快速滚动整屏 reflow/白屏 */
  content-visibility: auto;
  contain-intrinsic-size: auto 300px;
}

.pack-card-name {
  margin-top: 8px;
  font-size: 13px;
  color: var(--p-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
}

.pack-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 52px;
  padding: 0 14px;
  border: 1px solid var(--p-line);
  border-radius: 14px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--p-text) 3.5%, transparent), color-mix(in srgb, var(--p-text) 1%, transparent));
  cursor: pointer;
  transition: transform 0.25s var(--ease-out), border-color 0.25s, background 0.25s;

  &:hover {
    transform: translateX(4px);
    border-color: color-mix(in srgb, var(--p-text) 18%, transparent);
    background: color-mix(in srgb, var(--p-text) 5%, transparent);

    .row-arrow {
      transform: translateX(2px);
      color: var(--p-text);
    }
  }
}

.row-index {
  width: 30px;
  flex-shrink: 0;
  font-size: 10px;
  letter-spacing: 0.14em;
  color: var(--p-text-3);
}

.row-icon {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: 9px;

  &--video {
    background: linear-gradient(135deg, #ff4d2e, #ff9a3d);
    box-shadow: 0 8px 20px rgba(255, 77, 46, 0.28);
  }

  &--image {
    background: linear-gradient(135deg, #1f6feb, #5b8cff);
    box-shadow: 0 8px 20px rgba(31, 111, 235, 0.28);
  }

  &--folder {
    background: linear-gradient(135deg, #7a9e00, #a3c92a);
    box-shadow: 0 8px 20px rgba(122, 158, 0, 0.28);
  }
}

.row-name {
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
  color: var(--p-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-ext {
  flex-shrink: 0;
  padding: 3px 8px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--p-text) 6%, transparent);
  color: var(--p-text-3);
  font-size: 9px;
  letter-spacing: 0.14em;
}

.row-arrow {
  flex-shrink: 0;
  color: var(--p-text-3);
  transition: transform 0.25s var(--ease-out), color 0.25s;
}

.stage-note {
  min-height: 50vh;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--p-text-3);
  font-size: 13px;
  letter-spacing: 0.08em;
}

.permission-note {
  flex-direction: column;
  gap: 10px;
  text-align: center;

  strong {
    color: var(--p-text);
    font-size: 16px;
  }

  span {
    max-width: 320px;
    line-height: 1.6;
  }
}

.permission-actions {
  display: flex;
  gap: 10px;
  margin-top: 8px;
}

.permission-btn {
  height: 38px;
  padding: 0 16px;
  border: 1px solid var(--p-line);
  border-radius: 999px;
  background: color-mix(in srgb, var(--p-text) 6%, transparent);
  color: var(--p-text-2);
  cursor: pointer;

  &.primary {
    border-color: color-mix(in srgb, var(--p-accent) 55%, transparent);
    background: color-mix(in srgb, var(--p-accent) 20%, transparent);
    color: var(--p-text);
  }
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 640px) {
  .head-meta {
    display: none;
  }

  .pack-scroll {
    width: calc(100% - 28px);
  }

  .pack-actions {
    padding: 18px 14px 4px;
  }
}

/* 手机宽度：卡片网格流式列数（≥3 列，随宽度自动算），卡片变小、默认隐藏名字 */
@media (max-width: 480px) {
  .pack-card-grid {
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
    gap: 14px 8px;
  }

  .pack-card-name {
    display: none;
  }
}

/* ===== 触屏（hover:none）：删除无 hover 语义的悬浮/位移动画 =====
   触屏无悬停态，位移会在按下瞬间抖动并与滚动恢复锚点重叠；
   MediaCover 的悬浮覆盖层由其组件内 @media (hover: none) 关闭。
   颜色/描边/背景反馈与加载指示保留。 */
@media (hover: none) {
  .circle-btn:hover,
  .action-btn:hover,
  .pack-row:hover,
  .pack-row:hover .row-arrow,
  .toggle-btn:hover,
  .permission-btn:hover {
    transform: none;
  }
}
</style>
