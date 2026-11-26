<script setup>
import { useBooks } from "../store/loadBooks";
import { useSettings } from "../store/settings";
import { useUI } from "../store/ui";
import { invoke } from "@tauri-apps/api/core";
import { covers, canonKey, enqueueCover, prefetchCovers } from "../store/browserCache";
import { isVideo } from "../utils/media";
import { openComic, openImage, openMediaPack, openVideo } from "../utils/open";
import { scanFavoriteTree, flattenScan, syncFavoriteToDb } from "../utils/mediaScan";
import { entranceActive, markEntrancePlayed } from "../utils/entranceOnce";
import { createScrollRestorer } from "../utils/scrollAnchor";
import { closeContextMenu, openContextMenu, openGenericMenu } from "../utils/contextMenu";
import { buildItemMenu } from "../utils/itemMenu";
import { useItemActions } from "../utils/itemActions";
import { useCellLongPress } from "../utils/longPress";
import { useLazyCovers } from "../utils/lazyCovers";
import Icon from "./Icon.vue";
import MediaCover from "./MediaCover.vue";
import BookCover from "./BookCover.vue";

const booksStore = useBooks();
const settings = useSettings();
const ui = useUI();
const router = useRouter();
const favoriteDirs = computed(() => booksStore.favoriteDirs);
const { copyPath, revealPath, requestDelete, editTags } = useItemActions({
  onDeleted: async (item) => {
    if (currentDir.value) {
      const dir = favoriteDirs.value.find((d) => d.path === currentDir.value.path);
      // 统一用规范化 key 做身份比较，不再混用 b.key（comic 的 canonKey 路径）
      // 与 b.path（media 的原始路径）：Windows 下大小写/分隔符不一致时，
      // 混用比较会漏删条目，导致 books.length 计数残留。
      const removedKey = canonKey(item.path || item.key);
      books.value = books.value.filter((b) => canonKey(b.key || b.path) !== removedKey);
      if (dir) {
        delete counts[dir.path];
        delete dirCoverSource[dir.path];
        loadCount(dir, sharedRows);
      }
    } else {
      // 总览态没有 currentDir：按 refreshLibraryForDelete 的 roots 过滤语义，
      // 找出包含（或等于）被删路径的收藏根，失效并重扫其计数——
      // 否则删除后计数要么永久 "…"（键被删但无人重扫），要么陈旧（guard 挡住回填）。
      // 删除已由 itemActions 完成 DB 同步，这里刷新一次索引行让重扫拿到最新状态。
      const sep = booksStore.platform === "windows" ? "\\" : "/";
      const deletedKey = canonKey(item.path || item.key);
      const rows = await loadIndexRows();
      for (const d of favoriteDirs.value) {
        const rootKey = canonKey(d.path);
        if (
          rootKey === deletedKey ||
          deletedKey.startsWith(rootKey.endsWith(sep) ? rootKey : rootKey + sep)
        ) {
          delete counts[d.path];
          delete dirCoverSource[d.path];
          loadCount(d, rows);
        }
      }
    }
  },
});
const counts = reactive({});
// 每个收藏分组对应的封面来源（目录自身的 group/pack 封面，或漫画目录第一本书的封面）
const dirCoverSource = reactive({});

// 索引行共享：同一轮内多个收藏夹的 loadCount/openDir 复用同一份 list_items，
// 避免每个目录一次全量 IPC。删除/收藏变更等 DB 变化后由调用方刷新。
let sharedRows = null;
const loadIndexRows = async () => {
  try {
    sharedRows = await invoke("list_items");
  } catch (error) {
    console.error("list_items failed:", error);
    sharedRows = null;
  }
  return sharedRows;
};
const rowsFor = (rows) => rows ?? sharedRows;

const currentDir = ref(null);
const books = ref([]);
const loading = ref(false);

const loadCount = async (dir, rows) => {
  if (counts[dir.path] !== undefined) return;
  try {
    const result = await scanFavoriteTree(dir.path, dir.name, 12, rowsFor(rows));
    // 扫描结果写回 SQLite 索引（含目录 mtime）：旧库没有 mtime 时首次全扫，
    // 写回后下次进入同一收藏夹即走 DB 快路径，不再整树 readDir。
    if (result.dirty) {
      try {
        const entries = flattenScan(result, dir);
        await syncFavoriteToDb(dir, entries);
      } catch (error) {
        console.error("loadCount sync failed:", dir.path, error);
      }
    }
    counts[dir.path] = result.count;
    const root = result.root;
    let source = null;
    if (root) {
      if (root.kind === "group") source = { key: root.path, kind: "group" };
      else if (root.kind === "video-folder" || root.kind === "image-folder" || root.kind === "media-folder") {
        source = { key: root.path, kind: root.kind };
      }
    }
    if (!source && result.comics.length) {
      source = { key: result.comics[0].key, kind: "comic" };
    }
    dirCoverSource[dir.path] = source;
    if (source) enqueueCover(source.key, true, source.kind);
  } catch (error) {
    console.error("LOADCOUNT-FAIL", dir.path, error);
    counts[dir.path] = 0;
  }
};

const dirCoverKey = (dir) => {
  const source = dirCoverSource[dir.path];
  return source ? canonKey(source.key) : "";
};

watch(
  () => booksStore.favoriteDirs.map((d) => d.path).join("\u0000"),
  async () => {
    // 只拉一次索引行，所有收藏夹的 loadCount 共享，避免每目录一次全量 list_items IPC
    const rows = await loadIndexRows();
    for (const d of booksStore.favoriteDirs) loadCount(d, rows);
  },
  { immediate: true }
);

const openDir = async (dir) => {
  // 进入收藏夹：先把总览位置/锚点固化（供「返回收藏」时恢复），再清掉该目录残留
  // 快照，让每次进入目录从顶部开始。capture 只写记忆不停采，不影响目录内滚动记录。
  displayScroll.capture({ forceAnchor: true });
  displayScroll.clear({ stateKey: "display:dir", anchorKey: "display:dir" });
  loading.value = true;
  books.value = [];
  try {
    const result = await scanFavoriteTree(dir.path, dir.name, 12, sharedRows);
    // 与 loadCount 相同：扫描结果写回索引（mtime），让下次进入走 DB 快路径
    if (result.dirty) {
      try {
        const entries = flattenScan(result, dir);
        await syncFavoriteToDb(dir, entries);
      } catch (error) {
        console.error("openDir sync failed:", dir.path, error);
      }
    }
    const root = result.root;
    currentDir.value = { name: dir.name, path: dir.path };
    displayScroll.clear({ stateKey: "display:dir", anchorKey: "display:dir" });
    // 收藏根自身直接含媒体文件时（pack）：把文件展开成列表条目，与子目录、
    // 漫画一起展示——收藏页一律列表化展示，不再整包跳图包查看器。
    const fileNodes = (root?.files || []).map((f) => ({
      name: f.name,
      key: canonKey(f.path),
      path: f.path,
      dir: root.path,
      folder: dir.name,
      kind: isVideo(f.name) ? "video" : "image",
      ext: f.ext || "",
      count: 0,
      videoCount: isVideo(f.name) ? 1 : 0,
      imageCount: isVideo(f.name) ? 0 : 1,
      childCount: 0,
      children: [],
      files: [],
    }));
    const list = [...(root?.children || []), ...fileNodes];
    list.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true }));
    books.value = [...list, ...result.comics];
  } catch (error) {
    console.error("OPENDIR-FAIL", dir.path, error);
    books.value = [];
  } finally {
    loading.value = false;
    // 进入新收藏夹从顶部开始：总览滚深时浏览器按内容长度 clamp 的 scrollTop 不可靠，
    // 显式归零（后续 onActivated / backToFavs 的恢复不经过这里）。
    nextTick(() => {
      if (pageRef.value) pageRef.value.scrollTop = 0;
    });
    observeCovers();
  }
};

const backToFavs = ({ restore = true } = {}) => {
  currentDir.value = null;
  books.value = [];
  lazyCovers.reset();
  if (restore) {
    // 从目录返回总览：恢复到进入目录前浏览到的位置（openDir 时已固化 overview 锚点）
    void displayScroll.restoreAfterRender();
  }
};

// 侧边栏点击「收藏」：直接回到收藏文件夹总览顶部（清掉上次位置，不恢复）
watch(
  () => ui.navReset,
  () => {
    backToFavs({ restore: false });
    displayScroll.clear();
    nextTick(() => {
      if (pageRef.value) pageRef.value.scrollTop = 0;
    });
  }
);

const openBook = (book) => {
  displayScroll.checkpoint();
  if (book.kind === "comic") return openComic(book, { back: "shelf" });
  if (book.kind === "video") {
    return openVideo(book, { dir: book.dir || currentDir.value?.path, playlist: true });
  }
  if (book.kind === "image") return openImage(book);
  return openMediaPack(book);
};

const removeDir = async (dir) => {
  try {
    await booksStore.removeFavoriteDir(dir.path);
  } catch (error) {
    // 移除收藏失败（如 DB 忙）：收藏仍保留，不能丢计数
    console.error("remove favorite failed:", dir.path, error);
  }
  delete counts[dir.path];
  delete dirCoverSource[dir.path];
  // 移除失败时收藏仍在列表里：重扫回填计数，避免总览永久 "…"
  if (booksStore.favoriteDirs.some((d) => d.path === dir.path)) loadCount(dir, sharedRows);
};

const bookMap = new Map();
const plateMap = new Map();
const rebuildMaps = () => {
  bookMap.clear();
  plateMap.clear();
  for (const b of books.value) bookMap.set(b.key, b);
  for (const d of favoriteDirs.value) plateMap.set(d.path, d);
};
watch([books, favoriteDirs], rebuildMaps, { immediate: true });

const openPlateMenu = (dir, x, y) => {
  openContextMenu({
    x,
    y,
    items: buildItemMenu({
      item: dir,
      isAndroid: booksStore.platform === "android",
      isDir: true,
      actions: { copyPath, editTags, revealPath, requestDelete },
      open: { icon: "folder", onOpen: () => openDir(dir) },
      extra: [
        {
          id: "unfav",
          label: "取消收藏",
          icon: "star",
          onSelect: () => {
            closeContextMenu();
            removeDir(dir);
          },
        },
      ],
    }),
  });
};

const openBookMenu = (book, x, y) => {
  // 只有目录类条目（收藏分组/图包/媒体夹）删除时按整目录递归删，
  // 单文件视频/图片按文件删
  const isDir = ["group", "pack", "video-folder", "image-folder", "media-folder"].includes(book.kind);
  openContextMenu({
    x,
    y,
    items: buildItemMenu({
      item: book,
      isAndroid: booksStore.platform === "android",
      isDir,
      actions: { copyPath, editTags, revealPath, requestDelete },
      open: {
        icon: book.kind === "comic" ? "book-open" : "play",
        onOpen: () => openBook(book),
      },
    }),
  });
};

const onFavContextMenu = (e) => {
  e.preventDefault();
  e.stopPropagation();
  const cell = e.target?.closest?.(".plate, .book-cell");
  const key = cell?.dataset?.key;
  const hit = key ? (cell?.classList.contains("plate") ? plateMap.get(key) : bookMap.get(key)) : null;
  if (hit) {
    if (currentDir.value) openBookMenu(hit, e.clientX, e.clientY);
    else openPlateMenu(hit, e.clientX, e.clientY);
  } else {
    openGenericMenu(e.clientX, e.clientY);
  }
};

const longPress = useCellLongPress({
  selector: ".plate, .book-cell",
  resolveHit: (cell) =>
    cell.classList.contains("plate") ? plateMap.get(cell.dataset.key) : bookMap.get(cell.dataset.key),
  onHit: (hit, x, y) => {
    if (currentDir.value) openBookMenu(hit, x, y);
    else openPlateMenu(hit, x, y);
  },
  onEmpty: (x, y) => openGenericMenu(x, y),
});

// 目录类条目（收藏分组/图包/媒体夹）不做后台批量预取：group 提取成本高，
// 滚动到可视区时由 IntersectionObserver 按需入队（与 FileBrowser 的 !isDir 过滤一致）。
const DIR_KINDS = new Set(["group", "pack", "video-folder", "image-folder", "media-folder"]);

const lazyCovers = useLazyCovers({
  selector: ".fav-page .book-cover, .fav-page .media-cover",
  prefetch: () => {
    prefetchCovers(books.value.filter((b) => !DIR_KINDS.has(b.kind)));
  },
});
const observeCovers = () => lazyCovers.observe();

const pageRef = ref(null);

// 锚点按上下文区分：收藏夹总览（overview）与文件夹内书架（dir）各自独立记录，
// 避免切换上下文时错位。
const scrollAnchorKey = () => (currentDir.value ? "display:dir" : "display:overview");
const displayScroll = createScrollRestorer({
  element: () => pageRef.value,
  stateKey: scrollAnchorKey,
  anchorKey: scrollAnchorKey,
  anchorSelector: ".plate[data-key], .book-cell[data-key]",
});
const onPageScroll = () => displayScroll.capture();

watch(books, (list) => {
  // 列表首次填充后延后标记，其余进入文件夹时列表直接出现、不再重播入场动画
  if (list.length) markEntrancePlayed("display.folder");
  observeCovers();
});

onMounted(() => {
  pageRef.value?.addEventListener("scroll", onPageScroll, { passive: true });
  // 收藏夹总览的入场动画只在首次挂载播一次，返回总览时直接出现
  markEntrancePlayed("display.overview");
});

onActivated(async () => {
  // 系统返回键接管：打开某个收藏夹子目录时，返回键先回到收藏总览
  // （由 main.js 的 __handleAndroidBack 优先调用）。
  window.__dirBack = () => {
    if (currentDir.value) {
      backToFavs();
      return true;
    }
    return false;
  };
  await displayScroll.restoreAfterRender();
  observeCovers();
});

onDeactivated(() => {
  closeContextMenu();
  // 已由入口预先冻结时会复用快照；其它离开路径在仍可见时补存一次。
  displayScroll.checkpoint();
  lazyCovers.reset();
  window.__dirBack = undefined;
});

onUnmounted(() => {
  pageRef.value?.removeEventListener("scroll", onPageScroll);
  lazyCovers.reset();
});

const totalBooks = computed(() =>
  favoriteDirs.value.reduce((acc, d) => acc + (counts[d.path] || 0), 0)
);

</script>

<template>
  <div
    class="fav-page"
    ref="pageRef"
    @contextmenu="onFavContextMenu"
    @touchstart="longPress.onTouchStart"
    @touchmove="longPress.onTouchMove"
    @touchend="longPress.onTouchEnd"
    @touchcancel="longPress.onTouchCancel"
  >
    <!-- 文件夹内的书架 -->
    <template v-if="currentDir">
      <section class="shelf-hero shelf-hero--inner reveal">
        <button class="back-btn" @click="backToFavs">
          <Icon id="arrow-left" :size="16" />
          <span>返回收藏</span>
        </button>
        <div class="hero-titles">
          <div class="kicker">COLLECTION / {{ String(favoriteDirs.findIndex(d => d.name === currentDir.name) + 1).padStart(2, "0") }}</div>
          <h1 class="hero-title">{{ currentDir.name }}</h1>
        </div>
        <div class="hero-meta mono" v-if="!loading">
          {{ books.length }} 个条目
        </div>
      </section>

      <div v-if="loading" class="grid-loading">
        <div v-for="i in 10" :key="i" class="cover-skeleton"></div>
      </div>
      <ul v-else-if="books.length" class="book-grid">
        <li
          v-for="(book, i) in books"
          :key="book.key"
          class="book-cell"
          :class="{ reveal: entranceActive('display.folder') }"
          :data-key="book.key"
          :style="entranceActive('display.folder') ? { animationDelay: `${Math.min(i * 40, 500)}ms` } : undefined"
          @click="longPress.onCellClick(() => openBook(book))"
        >
          <BookCover
            v-if="book.kind === 'comic'"
            :src="covers[book.key]"
            :ext="book.ext"
            :folder="book.folder"
            :meta="settings.showSource"
            :data-key="book.key"
            data-kind="comic"
          />
          <MediaCover
            v-else
            :kind="book.kind"
            :ext="book.ext"
            :count="book.count"
            :child-count="book.childCount"
            :video-count="book.videoCount"
            :image-count="book.imageCount"
            :index="i"
            :src="covers[book.key]"
            :meta="settings.showSource"
            :data-key="book.key"
            :data-kind="book.kind"
          />
          <div class="book-name">
            <n-ellipsis :tooltip="false">{{ book.name }}</n-ellipsis>
          </div>
        </li>
      </ul>
      <div v-else class="empty-state">
        <Icon id="book-open" :size="36" />
        <p>这个文件夹里没有内容</p>
      </div>
    </template>

    <!-- 收藏夹总览 -->
    <template v-else>
      <section class="shelf-hero reveal">
        <div class="hero-titles">
          <div class="kicker">02 / COLLECTION · 收藏</div>
          <h1 class="hero-title">收藏</h1>
          <p class="hero-sub">朝闻道 · 私人阅读档案</p>
        </div>
        <div class="hero-meta mono">
          <span>{{ favoriteDirs.length }} 收藏</span>
          <i></i>
          <span>{{ totalBooks }} 部作品</span>
        </div>
      </section>

      <div v-if="!favoriteDirs.length" class="empty-state">
        <Icon id="star" :size="40" />
        <p class="empty-title">还没有收藏</p>
        <p class="empty-sub">前往「文件夹预览」浏览漫画文件夹，点亮收藏后会出现在这里</p>
        <button class="empty-cta" @click="router.push('/browse')">
          <span>去文件夹预览</span>
          <Icon id="arrow-right" :size="15" />
        </button>
      </div>

      <ul v-else class="plate-grid">
        <li
          v-for="(dir, i) in favoriteDirs"
          :key="dir.path"
          class="plate"
          :class="{ reveal: entranceActive('display.overview') }"
          :data-key="dir.path"
          :style="entranceActive('display.overview') ? { animationDelay: `${Math.min(i * 60, 600)}ms` } : undefined"
          @click="longPress.onCellClick(() => openDir(dir))"
        >
          <div class="plate-art">
            <img
              v-if="covers[dirCoverKey(dir)]"
              :src="covers[dirCoverKey(dir)]"
              class="plate-cover"
              alt=""
              loading="lazy"
              decoding="async"
            />
            <template v-else>
              <span class="plate-art-no mono">{{ String(i + 1).padStart(2, "0") }}</span>
              <Icon id="folder" :size="34" class="plate-ico" :stroke-width="1.75" />
              <span class="plate-art-line"></span>
            </template>
          </div>
          <div class="plate-body">
            <div class="plate-name"><n-ellipsis :tooltip="false">{{ dir.name }}</n-ellipsis></div>
            <div class="plate-count mono">{{ counts[dir.path] === undefined ? "…" : counts[dir.path] }} ENTRIES</div>
          </div>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped lang="scss">
.fav-page {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  scrollbar-width: none;
  &::-webkit-scrollbar {
    display: none;
  }
  padding: 108px clamp(22px, 4vw, 56px) 60px;
  background:
    radial-gradient(60% 45% at 85% -5%, var(--accent-soft), transparent 60%),
    radial-gradient(45% 40% at -10% 30%, color-mix(in srgb, var(--accent-2) 8%, transparent), transparent 60%),
    var(--bg-0);
}

/* 深色模式：去掉暖橙/荧光绿柔光，只保留全局暗角降亮度，避免焦黄滤镜感 */
:global(.theme-dark) .fav-page {
  background: var(--bg-0);
}

/* 幽灵水印 */
.fav-page::before {
  content: "书";
  position: absolute;
  top: 40px;
  right: 4vw;
  z-index: 0;
  font-family: var(--serif);
  font-size: clamp(180px, 30vw, 420px);
  font-weight: 900;
  line-height: 1;
  color: transparent;
  -webkit-text-stroke: 1px color-mix(in srgb, var(--text-1) 7%, transparent);
  pointer-events: none;
  user-select: none;
}

/* 英雄区 */
.shelf-hero {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 44px;

  &.shelf-hero--inner {
    align-items: flex-start;
    flex-direction: column;
    gap: 22px;
  }
}

.hero-titles {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.hero-title {
  font-family: var(--serif);
  font-size: clamp(44px, 6.4vw, 84px);
  font-weight: 900;
  line-height: 0.98;
  letter-spacing: 0.06em;
  color: var(--text-1);
  text-shadow: 0 2px 30px color-mix(in srgb, var(--text-1) 12%, transparent);
}

.hero-sub {
  margin-top: 6px;
  font-size: 13px;
  letter-spacing: 0.34em;
  color: var(--text-3);
  text-transform: uppercase;
  font-family: var(--mono);
}

.hero-meta {
  display: flex;
  align-items: center;
  gap: 14px;
  padding-bottom: 8px;
  font-size: 11px;
  letter-spacing: 0.16em;
  color: var(--text-2);
  white-space: nowrap;

  i {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--accent);
    display: inline-block;
  }
}

/* 返回按钮 */
.back-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 16px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--panel);
  color: var(--text-2);
  font-size: 13px;
  cursor: pointer;
  backdrop-filter: blur(12px);
  transition: all 0.25s var(--ease-out);

  &:hover {
    color: var(--accent);
    border-color: var(--accent);
    transform: translateX(-2px);
  }
}

/* ===== 收藏夹版块（Plate 卡） ===== */
.plate-grid {
  position: relative;
  z-index: 1;
  list-style: none;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 26px 20px;
  padding: 0;
}

.plate {
  position: relative;
  cursor: pointer;
  border-radius: var(--radius-lg);
  background: var(--bg-2);
  overflow: hidden;
  transition: transform 0.45s var(--ease-spring), box-shadow 0.45s var(--ease-out);

  &:hover {
    transform: translateY(-8px);
    box-shadow: var(--shadow-2);
    .plate-art {
      transform: scale(1.05);
    }
  }
}

.plate-art {
  position: relative;
  aspect-ratio: 1 / 1.08;
  display: grid;
  place-items: center;
  overflow: hidden;
  background: var(--bg-2);
  transition: transform 0.6s var(--ease-out);

  .plate-cover {
    position: absolute;
    inset: 0;
    z-index: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .plate-art-no {
    position: absolute;
    top: 12px;
    left: 14px;
    font-size: 10px;
    letter-spacing: 0.2em;
    color: rgba(255, 255, 255, 0.75);
  }

  .plate-ico {
    color: rgba(255, 255, 255, 0.94);
    filter: drop-shadow(0 6px 16px rgba(0, 0, 0, 0.35));
    transition: transform 0.4s var(--ease-spring);
  }

  .plate-art-line {
    position: absolute;
    bottom: 0;
    left: 14px;
    right: 14px;
    height: 1px;
    background: linear-gradient(90deg, rgba(255, 255, 255, 0.6), transparent);
  }
}

.plate:hover .plate-ico {
  transform: translateY(-3px) scale(1.08);
}

.plate-body {
  padding: 14px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.plate-name {
  font-size: 14.5px;
  font-weight: 600;
  color: var(--text-1);
  line-height: 1.3;
}

.plate-count {
  font-size: 9.5px;
  letter-spacing: 0.22em;
  color: var(--text-3);
}

/* ===== 书籍网格 ===== */
.book-grid {
  position: relative;
  z-index: 1;
  list-style: none;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 30px 18px;
  padding: 0;
}

.book-cell {
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  /* 屏外卡片跳过布局/绘制：封面数量多时避免快速滚动整屏 reflow/白屏 */
  content-visibility: auto;
  contain-intrinsic-size: auto 300px;
}

.book-name {
  font-size: 12.5px;
  color: var(--text-2);
  line-height: 1.35;
  text-align: center;
  padding: 0 2px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* 骨架屏 */
.grid-loading {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 30px 18px;
}

.cover-skeleton {
  aspect-ratio: 1 / 1.414;
  border-radius: 10px;
  background: linear-gradient(100deg, var(--bg-2) 40%, color-mix(in srgb, var(--bg-2) 40%, var(--text-1) 8%) 50%, var(--bg-2) 60%);
  background-size: 200% 100%;
  animation: shimmer 1.6s infinite linear;
}

/* 空状态 */
.empty-state {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 40vh;
  color: var(--text-3);
  text-align: center;

  .empty-title {
    font-size: 17px;
    font-weight: 600;
    color: var(--text-2);
    margin-top: 6px;
  }

  .empty-sub {
    font-size: 13px;
    max-width: 320px;
    line-height: 1.7;
  }
}

.empty-cta {
  margin-top: 12px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 42px;
  padding: 0 22px;
  border: none;
  border-radius: 999px;
  background: var(--accent-grad);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: var(--glow);
  transition: transform 0.3s var(--ease-spring);

  &:hover {
    transform: translateY(-2px) scale(1.03);
  }
}

@media (max-width: 900px) {
  .plate-grid,
  .book-grid {
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  }
}

/* 手机宽度：卡片网格流式列数（≥3 列，随宽度自动算），卡片变小、默认隐藏名字 */
@media (max-width: 480px) {
  .book-grid {
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
    gap: 14px 8px;
  }

  .book-name {
    display: none;
  }
}

/* ===== 触屏（hover:none）：删除无 hover 语义的悬浮/位移动画 =====
   同 Home：触屏无悬停态，位移只会在按下瞬间抖动、长按时钉住卡片，
   并与滚动恢复锚点重叠。颜色反馈、:active、骨架屏保留。 */
@media (hover: none) {
  .plate:hover,
  .plate:hover .plate-art,
  .plate:hover .plate-ico {
    transform: none;
  }

  .back-btn:hover,
  .empty-cta:hover {
    transform: none;
  }
}
</style>
