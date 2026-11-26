<script setup>
import { useBooks } from "../store/loadBooks";
import { useSettings } from "../store/settings";
import { useUI } from "../store/ui";
import {
  covers,
  canonKey,
  scrollMemory,
  prefetchCovers,
  libraryVersion,
} from "../store/browserCache";
import { byName, kindOfRow, nodeShape } from "../utils/libraryView";
import { openComic, openLibraryItem, openMediaPack } from "../utils/open";
import { scanAndSyncFavorite } from "../utils/mediaScan";
import { entranceActive, markEntrancePlayed } from "../utils/entranceOnce";
import { createScrollRestorer } from "../utils/scrollAnchor";
import { invoke } from "@tauri-apps/api/core";
import { closeContextMenu, openContextMenu, openGenericMenu } from "../utils/contextMenu";
import { buildItemMenu } from "../utils/itemMenu";
import { useItemActions } from "../utils/itemActions";
import { useCellLongPress } from "../utils/longPress";
import { useLazyCovers } from "../utils/lazyCovers";
import Icon from "./Icon.vue";
import MediaCover from "./MediaCover.vue";
import BookCover from "./BookCover.vue";

defineOptions({ name: "Home" });

const booksStore = useBooks();
const settings = useSettings();
const ui = useUI();
const router = useRouter();

const favoriteDirs = computed(() => booksStore.favoriteDirs);
const { copyPath, revealPath, requestDelete, editTags } = useItemActions();

// 聚合类型：hub = 双卡片主界面；comics = 全量漫画；media = 影视图集
const mode = ref("hub");
const comics = ref([]);
const media = ref([]);
const mediaGroups = ref([]);
const scanning = ref(false);
const pageRef = ref(null);
const homeScrollKey = () => `home:${mode.value}`;
const homeScroll = createScrollRestorer({
  element: () => pageRef.value,
  stateKey: () => mode.value,
  anchorKey: homeScrollKey,
  memory: scrollMemory,
  anchorSelector: ".book-cell[data-key]",
});
// 骨架屏/异步扫描会让 scrollHeight 暂时塌缩；快照必须在切换前冻结，不能事后回读。
const freezeHomeScroll = () => homeScroll.checkpoint();
const restorePageScroll = (snapshot) => homeScroll.restoreAfterRender({ snapshot });
// 首次进入时保留少量错峰动画作为视觉反馈，避免让整本书库同时运行动画。
const ENTRANCE_CARD_LIMIT = 24;
const shouldReveal = (index, key) => entranceActive(key) && index < ENTRANCE_CARD_LIMIT;

// 冷路径（空库/索引未初始化/读取失败）：重扫全部收藏夹写回索引，再统一从
// 索引行重建视图。视图模型只保留 applyLibrary 一份，扫描结果不再单独拼一遍，
// 避免两条路径的展开语义（收藏根为媒体包时展开子目录 + 直接媒体）各写一遍。
const scanAll = async () => {
  const dirs = favoriteDirs.value;
  let rows = null;
  try {
    rows = await invoke("list_items");
  } catch (error) {
    console.error("list_items failed:", error);
  }
  await Promise.all(
    dirs.map((dir) =>
      scanAndSyncFavorite(dir, rows).catch((error) => {
        console.error("scan failed:", dir.path, error);
      })
    )
  );
  // 这里只重建视图，不向上抛：scanAll 也是 loadLibrary 失败后的兜底路径，
  // 再抛会让兜底本身变成未捕获的 rejection。
  try {
    applyLibrary(await invoke("list_items"));
  } catch (error) {
    console.error("reload library rows failed:", error);
  }
};

// Rebuild the in-memory view model (comics / media / mediaGroups) from DB rows.
const applyLibrary = (rows) => {
  const comicMap = new Map();
  const groups = [];
  const favRows = rows.filter((r) => r.kind === "favorite");
  for (const dir of favoriteDirs.value) {
    const favKey = canonKey(dir.path);
    const favRow = favRows.find((r) => r.pathKey === favKey);
    if (!favRow) continue;
    if (favRow.mediaType) {
      // 收藏根自身直接含媒体（pack）：展开为 子目录 + 直接媒体文件 条目，
      // 与 scanAll 的展开语义一致（聚合内容而非收藏夹本身）
      const items = rows
        .filter(
          (r) =>
            r.parentPath === favKey &&
            (r.kind === "pack" || r.kind === "group" || r.kind === "video" || r.kind === "image")
        )
        .map((r) => {
          if (r.kind === "video" || r.kind === "image") {
            return nodeShape(r, dir.name, r.kind, r.ext || "video");
          }
          const k = kindOfRow(r);
          return nodeShape(r, dir.name, k.kind, k.ext);
        });
      if (!items.length) continue;
      groups.push({ path: dir.path, name: dir.name, items, compact: true });
      continue;
    }
    const items = rows
      .filter((r) => r.parentPath === favKey && (r.kind === "pack" || r.kind === "group"))
      .map((r) => {
        const k = kindOfRow(r);
        return nodeShape(r, dir.name, k.kind, k.ext);
      });
    if (!items.length) continue;
    groups.push({ path: dir.path, name: dir.name, items, compact: false });
  }
  for (const r of rows) {
    if (r.kind !== "comic" || !r.folder) continue;
    comicMap.set(r.pathKey, {
      name: r.name,
      key: r.pathKey,
      path: r.pathKey,
      ext: r.ext || "",
      kind: "comic",
      folder: r.folder,
      dir: r.parentPath || r.pathKey,
    });
  }
  comics.value = Array.from(comicMap.values()).sort(byName);
  mediaGroups.value = groups.sort(byName);
  media.value = groups.flatMap((g) => g.items).sort(byName);
};

// Startup: read the library from SQLite. Only scan + sync when the DB is
// empty or a favorite is not in it yet (e.g. right after adding one).
const loadLibrary = async () => {
  const restorePoint = freezeHomeScroll();
  scanning.value = true;
  try {
    const [rows, meta] = await Promise.all([invoke("list_items"), invoke("library_meta")]);
    // Empty DB, or a DB that only has the legacy import (never scanned yet):
    // do a full scan + sync. Otherwise restore straight from SQLite.
    if (!rows.length || !meta.synced) {
      await scanAll();
    } else {
      applyLibrary(rows);
      const favRows = rows.filter((r) => r.kind === "favorite");
      const stale = favoriteDirs.value.filter((d) => {
        const row = favRows.find((r) => r.pathKey === canonKey(d.path));
        // 收藏夹行不存在，或从未被扫描过（created_at == updated_at，比如刚
        // add_favorite 只建了行、还没扫内容）→ 需要补扫。
        return !row || row.updatedAt === row.createdAt;
      });
      if (stale.length) {
        // 只补扫新增的收藏夹，不要全库重扫：其余收藏夹 mtime 未变时
        // scanFavoriteTree 直接走 DB 快路径，不做深层 readDir。
        for (const dir of stale) {
          try {
            await scanAndSyncFavorite(dir);
          } catch (error) {
            console.error("scan failed:", dir.path, error);
          }
        }
        const freshRows = await invoke("list_items");
        applyLibrary(freshRows);
      }
    }
  } catch (error) {
    console.error("load library failed:", error);
    await scanAll();
  } finally {
    scanning.value = false;
  }
  observeCovers();
  await restorePageScroll(restorePoint);
};

watch(
  () => favoriteDirs.value.map((d) => d.path).join("\u0000"),
  () => loadLibrary(),
  { immediate: true }
);

let lastLibraryVersion = libraryVersion.value;
watch(
  () => libraryVersion.value,
  (v) => {
    if (v === lastLibraryVersion) return;
    lastLibraryVersion = v;
    loadLibrary();
  }
);

const enter = (kind) => {
  mode.value = kind;
  // 进入新模式从顶部开始，并清掉该模式此前可能残留的快照。
  homeScroll.clear();
  // 聚合列表只在首次进入该模式时播入场动画，之后切换/返回直接出现
  markEntrancePlayed("home." + kind);
  // observeCovers 内部会 unobserveAll + 重启对应模式的 prefetch，无需手动 reset
  nextTick(() => observeCovers());
};

const backToHub = () => {
  mode.value = "hub";
  homeScroll.clear();
  lazyCovers.reset();
};

// 侧边栏点击「主界面」：无论当前在漫画/视频聚合页，直接回到双卡片
watch(
  () => ui.navReset,
  () => {
    mode.value = "hub";
    homeScroll.clear();
    lazyCovers.reset();
    nextTick(() => {
      if (pageRef.value) pageRef.value.scrollTop = 0;
    });
  }
);

const openBook = (book) => {
  freezeHomeScroll();
  return openComic(book);
};

const openMediaGroup = (group) => {
  freezeHomeScroll();
  return openMediaPack({ key: canonKey(group.path), path: group.path, name: group.name });
};

// 聚合内容里的条目可能是子文件夹（pack/group）、单文件视频或单张图片；
// 打开路由由 open.js 按 kind 分派。
const openMedia = (item) => {
  freezeHomeScroll();
  return openLibraryItem(item);
};

/* ===== 封面懒加载（与书架共用缓存队列） ===== */
/* ===== 右键/长按自定义菜单 ===== */
const cardMap = new Map();
const rebuildCardMap = () => {
  cardMap.clear();
  for (const book of comics.value) cardMap.set(book.key, { item: book, kind: "comic" });
  for (const m of media.value) cardMap.set(m.key, { item: m, kind: "media" });
};
watch([comics, media], rebuildCardMap);

const longPress = useCellLongPress({
  selector: ".book-cell",
  resolveHit: (cell) => cardMap.get(cell.dataset.key) || null,
  onHit: (hit, x, y) => openItemMenu(hit.item, hit.kind, x, y),
  onEmpty: (x, y) => openGenericMenu(x, y),
});

const onHomeContextMenu = (e) => {
  e.preventDefault();
  e.stopPropagation();
  const cell = e.target?.closest?.(".book-cell");
  const key = cell?.dataset?.key;
  const found = key ? cardMap.get(key) : null;
  if (found) openItemMenu(found.item, found.kind, e.clientX, e.clientY);
  else openGenericMenu(e.clientX, e.clientY);
};

const openItemMenu = (item, kind, x, y) => {
  openContextMenu({
    x,
    y,
    items: buildItemMenu({
      item,
      isAndroid: booksStore.platform === "android",
      isDir: kind === "media",
      actions: { copyPath, editTags, revealPath, requestDelete },
      open: {
        icon: kind === "comic" ? "book-open" : "play",
        onOpen: () => (kind === "comic" ? openBook(item) : openMedia(item)),
      },
    }),
  });
};

const lazyCovers = useLazyCovers({
  selector: ".home-page .book-cover, .home-page .media-cover",
  prefetch: () => {
    if (mode.value === "comics") prefetchCovers(comics.value);
    else if (mode.value === "media") prefetchCovers(media.value);
  },
});
const observeCovers = () => lazyCovers.observe();

const onPageScroll = () => homeScroll.capture();

onMounted(() => {
  pageRef.value?.addEventListener("scroll", onPageScroll, { passive: true });
  // 主界面（hub）入场动画只在首次挂载播一次，返回主界面时直接出现
  markEntrancePlayed("home.hub");
});

onActivated(() => {
  // 系统返回键接管：在漫画/媒体聚合视图时，返回键先回到 hub 双卡片
  // （由 main.js 的 __handleAndroidBack 优先调用）。
  window.__dirBack = () => {
    if (mode.value !== "hub") {
      backToHub();
      return true;
    }
    return false;
  };
  restorePageScroll();
  observeCovers();
});

onDeactivated(() => {
  closeContextMenu();
  // 如果点击入口时已保存过，checkpoint 会复用那份快照，避免隐藏后的 0 覆盖它。
  freezeHomeScroll();
  lazyCovers.reset();
  window.__dirBack = undefined;
});

onUnmounted(() => {
  pageRef.value?.removeEventListener("scroll", onPageScroll);
  cancelIdlePrefetch();
  lazyCovers.reset();
});

</script>

<template>
  <div
    class="home-page"
    ref="pageRef"
    @contextmenu="onHomeContextMenu"
    @touchstart="longPress.onTouchStart"
    @touchmove="longPress.onTouchMove"
    @touchend="longPress.onTouchEnd"
    @touchcancel="longPress.onTouchCancel"
  >
    <!-- 主界面：全量聚合中心入口 -->
    <template v-if="mode === 'hub'">
      <section class="shelf-hero" :class="{ reveal: entranceActive('home.hub') }">
        <div class="hero-titles">
          <div class="kicker">01 / HOME · 聚合中心</div>
          <h1 class="hero-title">主界面</h1>
          <p class="hero-sub">朝闻道 · 私人阅读档案</p>
        </div>
        <div class="hero-meta mono">
          <span>{{ favoriteDirs.length }} 收藏</span>
          <i></i>
          <span>{{ scanning ? "…" : comics.length }} 部作品</span>
        </div>
      </section>

      <div class="hub-grid">
        <button
          class="hub-card hub-card--comic"
          :class="{ reveal: entranceActive('home.hub') }"
          :style="entranceActive('home.hub') ? { animationDelay: '0ms' } : undefined"
          @click="enter('comics')"
        >
          <div class="hub-art">
            <span class="hub-art-no mono">A — 01</span>
            <span class="hub-art-glyph" aria-hidden="true">漫</span>
            <span class="hub-art-tile">
              <Icon id="book-open" :size="38" class="hub-ico" :stroke-width="1.5" />
            </span>
            <span class="hub-art-line"></span>
          </div>
          <div class="hub-body">
            <div class="hub-kicker mono">
              <span>COMICS</span>
              <i></i>
              <span>全集</span>
            </div>
            <div class="hub-name">漫画</div>
            <p class="hub-desc">所有收藏的漫画，在这里一册不落</p>
            <div class="hub-foot">
              <div class="hub-stats mono">
                <span class="hub-num">{{ scanning ? "…" : comics.length }}</span>
                <span class="hub-stat-label">部作品</span>
                <i></i>
                <span class="hub-num">{{ favoriteDirs.length }}</span>
                <span class="hub-stat-label">个收藏夹</span>
              </div>
              <span class="hub-go"><Icon id="arrow-right" :size="17" /></span>
            </div>
          </div>
        </button>

        <button
          class="hub-card hub-card--media"
          :class="{ reveal: entranceActive('home.hub') }"
          :style="entranceActive('home.hub') ? { animationDelay: '110ms' } : undefined"
          @click="enter('media')"
        >
          <div class="hub-art">
            <span class="hub-art-no mono">B — 02</span>
            <span class="hub-art-glyph" aria-hidden="true">影</span>
            <span class="hub-art-tile">
              <Icon id="film" :size="38" class="hub-ico" :stroke-width="1.5" />
            </span>
            <span class="hub-art-line"></span>
          </div>
          <div class="hub-body">
            <div class="hub-kicker mono">
              <span>MEDIA</span>
              <i></i>
              <span>放映</span>
            </div>
            <div class="hub-name">影视图集</div>
            <p class="hub-desc">影像与图集，一页尽览</p>
            <div class="hub-foot">
              <div class="hub-stats mono">
                <span class="hub-num">{{ scanning ? "…" : media.length }}</span>
                <span class="hub-stat-label">部作品</span>
                <i></i>
                <span class="hub-num">{{ mediaGroups.length }}</span>
                <span class="hub-stat-label">个目录</span>
              </div>
              <span class="hub-go"><Icon id="arrow-right" :size="17" /></span>
            </div>
          </div>
        </button>
      </div>
    </template>

    <!-- 聚合视图 -->
    <template v-else>
      <section class="shelf-hero shelf-hero--inner" :class="{ reveal: entranceActive('home.' + mode) }">
        <button class="back-btn" @click="backToHub">
          <Icon id="arrow-left" :size="16" />
          <span>返回主界面</span>
        </button>
        <div class="hero-titles">
          <div class="kicker">
            {{ mode === "comics" ? "01 / COMICS · 全量书库" : "01 / MEDIA · 影像图集" }}
          </div>
          <h1 class="hero-title">{{ mode === "comics" ? "漫画" : "影视图集" }}</h1>
        </div>
        <div class="hero-meta mono" v-if="!scanning">
          <span>{{ (mode === "comics" ? comics : media).length }} {{ mode === "comics" ? "部作品" : "个作品" }}</span>
          <i></i>
          <span>来自 {{ favoriteDirs.length }} 个收藏夹</span>
        </div>
      </section>

      <div v-if="scanning" class="grid-loading">
        <div v-for="i in 10" :key="i" class="cover-skeleton"></div>
      </div>

      <!-- 漫画全量网格 -->
      <ul v-else-if="mode === 'comics' && comics.length" class="book-grid">
        <li
          v-for="(book, i) in comics"
          :key="book.key"
          class="book-cell"
          :class="{ reveal: shouldReveal(i, 'home.comics') }"
          :data-key="book.key"
          :style="shouldReveal(i, 'home.comics') ? { animationDelay: `${Math.min(i * 36, 500)}ms` } : undefined"
          @click="longPress.onCellClick(() => openBook(book))"
        >
          <BookCover
            :src="covers[book.key]"
            :ext="book.ext"
            :folder="book.folder"
            :meta="settings.showSource"
            :data-key="book.key"
            data-kind="comic"
          />
          <div class="book-name">
            {{ book.name }}
          </div>
        </li>
      </ul>

      <!-- 影视图集聚合：按收藏夹分组展示 -->
      <div v-else-if="mode === 'media' && mediaGroups.length" class="media-grouped">
        <section
          v-for="(group, g) in mediaGroups"
          :key="group.path"
          class="media-group"
          :class="{ 'is-compact': group.compact }"
        >
          <div v-if="!group.compact" class="media-group-head">
            <button class="media-group-folder" @click="openMediaGroup(group)">
              <Icon id="folder" :size="18" />
              <span class="media-group-name">{{ group.name }}</span>
              <span class="media-group-count mono">{{ group.items.length }} 个作品</span>
              <Icon id="chevron-right" :size="16" />
            </button>
          </div>
          <ul class="book-grid">
            <li
              v-for="(item, i) in group.items"
              :key="item.key"
              class="book-cell"
              :class="{ reveal: entranceActive('home.media') }"
              :data-key="item.key"
              :style="entranceActive('home.media') ? { animationDelay: `${Math.min((g * 8 + i) * 36, 500)}ms` } : undefined"
              @click="longPress.onCellClick(() => openMedia(item))"
            >
              <MediaCover
                :kind="item.kind"
                :ext="item.ext"
                :count="item.count"
                :child-count="item.childCount"
                :video-count="item.videoCount"
                :image-count="item.imageCount"
                :index="i"
                :folder="group.name"
                :src="covers[item.key]"
                :meta="settings.showSource"
                :data-key="item.key"
                :data-kind="item.kind"
              />
              <div class="book-name">
                <n-ellipsis :tooltip="false">{{ item.name }}</n-ellipsis>
              </div>
            </li>
          </ul>
        </section>
      </div>

      <!-- 空状态 -->
      <div v-else class="empty-state">
        <Icon :id="mode === 'comics' ? 'book-open' : 'film'" :size="38" />
        <p class="empty-title">{{ mode === "comics" ? "还没有收藏的漫画" : "还没有影视图集" }}</p>
        <p class="empty-sub">
          {{
            mode === "comics"
              ? "前往「文件夹预览」浏览漫画目录，点亮收藏后会自动出现在这里"
              : "在「文件夹预览」收藏包含影像或图包的目录，它们便会出现在这里"
          }}
        </p>
        <button class="empty-cta" @click="router.push('/browse')">
          <span>去浏览</span>
          <Icon id="arrow-right" :size="15" />
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped lang="scss">
.home-page {
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
:global(.theme-dark) .home-page {
  background: var(--bg-0);
}

/* 幽灵水印 */
.home-page::before {
  content: "阅";
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

/* ===== 主界面双卡片 ===== */
.hub-grid {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
  gap: 30px;
  padding: 0;
}

.hub-card {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius-xl);
  background: var(--bg-2);
  overflow: hidden;
  cursor: pointer;
  text-align: left;
  isolation: isolate;
  transition: transform 0.5s var(--ease-spring), box-shadow 0.5s var(--ease-out), border-color 0.3s var(--ease-out);

  &:hover {
    transform: translateY(-8px);
    border-color: var(--line-strong);
    box-shadow: var(--shadow-2);
  }

  &:active {
    transform: scale(0.985);
  }
}

/* 色带舞台：漫画 = 朱砂橙，影视 = 靛蓝 */
.hub-card--comic .hub-art {
  background:
    radial-gradient(130% 100% at 86% 6%, rgba(255, 255, 255, 0.28), transparent 52%),
    linear-gradient(150deg, #b91f0e 0%, #e6391f 36%, #ff7a45 72%, #ffb45c 100%);
}

.hub-card--media .hub-art {
  background:
    radial-gradient(130% 100% at 86% 6%, rgba(255, 255, 255, 0.26), transparent 52%),
    linear-gradient(150deg, #103a8c 0%, #1f6feb 36%, #5b8cff 72%, #93b4ff 100%);
}

.hub-art {
  position: relative;
  aspect-ratio: 16 / 9;
  display: grid;
  place-items: center;
  overflow: hidden;
  isolation: isolate;

  /* 噪点 + 斜向高光（纯 alpha，不叠加 blend，避免合成降帧） */
  &::before {
    content: "";
    position: absolute;
    inset: 0;
    z-index: 1;
    pointer-events: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    opacity: 0.12;
  }

  &::after {
    content: "";
    position: absolute;
    inset: 0;
    z-index: 1;
    pointer-events: none;
    background:
      linear-gradient(112deg, rgba(255, 255, 255, 0.2) 0%, rgba(255, 255, 255, 0) 40%),
      repeating-linear-gradient(-45deg, rgba(255, 255, 255, 0.045) 0 1px, transparent 1px 15px);
  }
}

/* 幽灵字：漫 / 影 大号描边字，藏在色带右下 */
.hub-art-glyph {
  position: absolute;
  z-index: 0;
  right: -4%;
  bottom: -26%;
  font-family: var(--serif);
  font-size: clamp(130px, 16vw, 210px);
  font-weight: 900;
  line-height: 1;
  color: transparent;
  -webkit-text-stroke: 1px rgba(255, 255, 255, 0.3);
  user-select: none;
  pointer-events: none;
  transform: rotate(-7deg);
}

/* 编号索引：A — 01 / B — 02 */
.hub-art-no {
  position: absolute;
  z-index: 2;
  top: 16px;
  left: 18px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 10.5px;
  letter-spacing: 0.22em;
  color: rgba(255, 255, 255, 0.75);

  &::after {
    content: "";
    width: 26px;
    height: 1px;
    background: currentColor;
    opacity: 0.55;
  }
}

/* 悬浮玻璃图标砖 */
.hub-art-tile {
  position: relative;
  z-index: 2;
  width: 78px;
  height: 78px;
  display: grid;
  place-items: center;
  border-radius: 24px;
  border: 1px solid rgba(255, 255, 255, 0.3);
  background: rgba(255, 255, 255, 0.13);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.35);
  animation: hubFloat 6.5s var(--ease-in-out) infinite;

  .hub-ico {
    color: #fff;
    filter: drop-shadow(0 6px 14px rgba(0, 0, 0, 0.34));
    transition: transform 0.45s var(--ease-spring);
  }
}

.hub-card:hover .hub-art-tile .hub-ico {
  transform: translateY(-3px) scale(1.12);
}

.hub-art-line {
  position: absolute;
  z-index: 2;
  bottom: 0;
  left: 18px;
  right: 18px;
  height: 1px;
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.7), transparent);
}

/* ===== 卡片正文 ===== */
.hub-body {
  position: relative;
  z-index: 1;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 22px 24px 20px;
}

.hub-kicker {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-size: 10px;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--text-3);

  i {
    width: 24px;
    height: 1px;
    background: var(--accent);
  }
}

.hub-name {
  font-family: var(--serif);
  font-size: clamp(27px, 2.8vw, 36px);
  font-weight: 900;
  line-height: 1.04;
  letter-spacing: 0.1em;
  color: var(--text-1);
}

.hub-desc {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-3);
  max-width: 30em;
}

.hub-foot {
  margin-top: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}

.hub-stats {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 10.5px;
  letter-spacing: 0.12em;
  color: var(--text-3);
  flex-wrap: wrap;
  min-width: 0;

  i {
    width: 3px;
    height: 3px;
    flex-shrink: 0;
    border-radius: 50%;
    background: var(--accent);
    align-self: center;
  }

  .hub-num {
    font-size: 21px;
    font-weight: 700;
    color: var(--text-1);
    transition: color 0.3s;
  }

  .hub-stat-label {
    margin-right: 3px;
  }
}

.hub-card:hover .hub-num {
  color: var(--accent);
}

/* 圆形进入按钮 */
.hub-go {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  color: var(--text-2);
  transition: background 0.35s var(--ease-out), color 0.35s var(--ease-out), border-color 0.35s var(--ease-out), transform 0.4s var(--ease-spring), box-shadow 0.35s var(--ease-out);
}

.hub-card:hover .hub-go {
  background: var(--accent-grad);
  border-color: transparent;
  color: #fff;
  transform: translateX(4px) rotate(-45deg);
  box-shadow: var(--glow);
}

/* 图标砖悬浮动效 */
@keyframes hubFloat {
  0%,
  100% {
    transform: translateY(0) rotate(-2deg);
  }
  50% {
    transform: translateY(-9px) rotate(2deg);
  }
}

/* ===== 按收藏夹分组的媒体作品 ===== */
.media-grouped {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 46px;
}

.media-group {
  &.is-compact {
    .book-grid {
      grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
    }
  }
}

.media-group-head {
  display: flex;
  align-items: center;
  margin-bottom: 20px;
}

.media-group-folder {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  height: 42px;
  padding: 0 16px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--panel);
  color: var(--text-2);
  font-size: 13px;
  cursor: pointer;
  backdrop-filter: blur(12px);
  transition: color 0.25s var(--ease-out), border-color 0.25s var(--ease-out), transform 0.25s var(--ease-out);

  &:hover {
    color: var(--accent);
    border-color: var(--accent);
    transform: translateY(-2px);
  }
}

.media-group-name {
  font-weight: 600;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.media-group-count {
  font-size: 10px;
  letter-spacing: 0.16em;
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
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
}

/* 夜间模式只保留一层界面级暗角，避免为每张封面单独绘制阴影。 */
:global(.theme-dark) .home-page {
  box-shadow: inset 0 0 52px rgba(0, 0, 0, 0.3);
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
    max-width: 380px;
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

/* ===== 横屏 / 矮视口：压缩 hero + 卡片改横向，保证一屏展示完毕 =====
   覆盖横屏平板（1152×720）与桌面矮窗口（1080×720）：垂直大卡 + 大标题
   会撑到 ~800px 高被迫滚动；这里把色带挪到左侧、收紧留白，整页 ~540px。 */
@media (min-width: 900px) and (max-height: 840px) {
  .home-page {
    padding-top: 96px;
    padding-bottom: 40px;
  }

  .shelf-hero {
    margin-bottom: 22px;
  }

  .hero-title {
    font-size: clamp(36px, 3.6vw, 48px);
  }

  .hub-grid {
    gap: 18px;
  }

  .hub-card {
    flex-direction: row;
    align-items: stretch;
    border-radius: 18px;
    min-height: 0;
  }

  .hub-art {
    aspect-ratio: auto;
    flex: 0 0 38%;
    min-height: 0;
  }

  .hub-art-no {
    top: 12px;
    left: 14px;
  }

  .hub-art-glyph {
    font-size: clamp(90px, 9vw, 150px);
  }

  .hub-art-tile {
    width: 60px;
    height: 60px;
    border-radius: 18px;
  }

  .hub-body {
    padding: 16px 18px 14px;
    gap: 7px;
  }

  .hub-name {
    font-size: clamp(24px, 2.2vw, 30px);
  }

  .hub-desc {
    font-size: 12px;
  }

  .hub-foot {
    padding-top: 10px;
  }

  .hub-stats .hub-num {
    font-size: 18px;
  }

  .hub-go {
    width: 34px;
    height: 34px;
  }
}

/* ===== 竖屏 / 窄屏：双卡片改为纵向堆叠的横向编辑面板 =====
   桌面 auto-fit 的细长列在竖屏下会挤成 130px 窄卡，形状惨不忍睹；
   这里改成一列通栏，色带在左、正文在右，手机上再转回上下结构。 */
@media (max-width: 900px) {
  /* 书/漫画网格保持多列紧凑排布 */
  .book-grid {
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  }

  /* 主界面入口卡片：全宽堆叠 */
  .hub-grid {
    grid-template-columns: 1fr;
    gap: 20px;
  }

  .shelf-hero {
    margin-bottom: 30px;
  }

  .hero-title {
    font-size: clamp(38px, 8vw, 54px);
  }

  .hub-card {
    flex-direction: row;
    align-items: stretch;
    border-radius: 20px;
    min-height: 200px;
  }

  .hub-art {
    aspect-ratio: auto;
    flex: 0 0 42%;
    min-height: 200px;
  }

  .hub-art-glyph {
    font-size: clamp(110px, 24vw, 190px);
  }

  .hub-body {
    padding: 20px 22px 18px;
    gap: 9px;
  }

  .hub-name {
    font-size: clamp(28px, 6.4vw, 40px);
  }

  /* 手机窄屏：保持紧凑横向入口，避免两张入口退化成占据半屏的大卡。 */
  @media (max-width: 560px) {
    .home-page {
      padding: 84px 14px 104px;
    }

    .shelf-hero {
      margin-bottom: 18px;
    }

    .hero-title {
      font-size: clamp(34px, 10vw, 42px);
    }

    .hero-sub {
      margin-top: 1px;
      font-size: 10px;
      letter-spacing: 0.2em;
    }

    .hub-grid {
      gap: 12px;
    }

    .hub-card {
      flex-direction: row;
      min-height: 132px;
      border-radius: 16px;
    }

    .hub-art {
      flex: 0 0 36%;
      width: auto;
      aspect-ratio: auto;
      min-height: 132px;
    }

    .hub-art-no {
      top: 10px;
      left: 11px;
      gap: 5px;
      font-size: 8px;

      &::after {
        width: 16px;
      }
    }

    .hub-art-glyph {
      right: -10%;
      bottom: -18%;
      font-size: clamp(82px, 25vw, 112px);
    }

    .hub-art-tile {
      width: 50px;
      height: 50px;
      border-radius: 15px;

      .hub-ico {
        width: 26px !important;
        height: 26px !important;
      }
    }

    .hub-art-line {
      left: 11px;
      right: 11px;
    }

    .hub-body {
      padding: 14px 15px 12px;
      gap: 5px;
    }

    .hub-kicker {
      font-size: 8px;
      letter-spacing: 0.2em;

      i {
        width: 14px;
      }
    }

    .hub-name {
      font-size: clamp(23px, 6.8vw, 28px);
    }

    .hub-desc {
      display: none;
    }

    .hub-foot {
      gap: 8px;
      padding-top: 7px;
    }

    .hub-stats {
      gap: 5px;
      font-size: 9px;

      .hub-num {
        font-size: 17px;
      }
    }

    .hub-go {
      width: 32px;
      height: 32px;
    }
  }
}

/* 手机宽度（正常手机约 360-430px）：卡片网格流式列数（≥3 列，随宽度自动算），
   卡片自动变小、默认隐藏名字 */
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
   触屏没有「悬停」状态，这些位移只会在按下瞬间抖动、长按时把卡片
   钉在浮起态，并与滚动恢复的锚点校正重叠。:hover 的颜色/描边反馈
   保留（瞬时无害），:active 按压与骨架屏加载指示不动。 */
@media (hover: none) {
  .hub-card:hover {
    transform: none;
  }

  .hub-card:hover .hub-go {
    transform: none;
  }

  .hub-card:hover .hub-art-tile .hub-ico,
  .hub-card:hover .hub-num {
    transform: none;
  }

  .hub-art-tile {
    animation: none;
  }

  .media-group-folder:hover,
  .back-btn:hover,
  .empty-cta:hover {
    transform: none;
  }

  .media-cover:hover {
    transform: none;
  }
}
</style>
