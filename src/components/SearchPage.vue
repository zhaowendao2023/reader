<script setup>
import { useUI } from "../store/ui";
import { useSettings } from "../store/settings";
import { covers, scrollMemory } from "../store/browserCache";
import Icon from "./Icon.vue";
import MediaCover from "./MediaCover.vue";
import BookCover from "./BookCover.vue";
import { openSearchItem } from "../utils/open";
import { useLazyCovers } from "../utils/lazyCovers";
import { createScrollRestorer } from "../utils/scrollAnchor";
import { tagColor, hexToRgba } from "../utils/tagColor";
import { entranceActive, markEntrancePlayed } from "../utils/entranceOnce";
import { byName, kindOfRow, nodeShape } from "../utils/libraryView";

defineOptions({ name: "SearchPage" });

const ui = useUI();
const settings = useSettings();
const route = useRoute();
const router = useRouter();

const tagChipStyle = (name) => {
  const c = tagColor(name);
  return { color: c, background: hexToRgba(c, 0.12), borderColor: hexToRgba(c, 0.4) };
};

/* ===== 搜索结果分组 ===== */
const searchComics = computed(() =>
  ui.searchItems
    .filter((r) => r.kind === "comic")
    .map((r) => ({
      name: r.name,
      key: r.pathKey,
      path: r.pathKey,
      pathKey: r.pathKey,
      ext: r.ext || "",
      kind: "comic",
      folder: r.folder,
      dir: r.parentPath || r.pathKey,
      tags: r.matchedTags || [],
    }))
    .sort(byName)
);

const searchPacks = computed(() =>
  ui.searchItems
    .filter((r) => r.kind === "pack" || r.kind === "group")
    .map((r) => {
      const k = r.kind === "group" ? { kind: "group", ext: "group" } : kindOfRow(r);
      return nodeShape(r, r.folder || "", k.kind, k.ext);
    })
    .sort(byName)
);

// 单个视频/图片的命中按父目录聚合，避免一个目录几百个文件刷屏。
const searchFileGroups = computed(() => {
  const groups = new Map();
  for (const f of ui.searchItems) {
    if (f.kind !== "video" && f.kind !== "image") continue;
    const parentKey = f.parentPath || "";
    if (!groups.has(parentKey)) {
      const parent = ui.searchParents.find((p) => p.pathKey === parentKey);
      groups.set(parentKey, {
        parentPath: parentKey,
        parentName:
          parent?.name ||
          String(parentKey).split(/[\\/]/).filter(Boolean).pop() ||
          "未知目录",
        files: [],
      });
    }
    groups.get(parentKey).files.push(f);
  }
  const list = Array.from(groups.values());
  for (const g of list) g.files.sort(byName);
  return list.sort((a, b) =>
    a.parentName.localeCompare(b.parentName, "zh-Hans-CN", { numeric: true })
  );
});

/* ===== 与顶栏搜索联动 ===== */
// 首次进入或路由 query 变化时，把关键词同步到全局搜索框，
// 由 Header 的防抖 watcher 统一触发 runSearch。
const syncFromRoute = () => {
  const q = (route.query.q || "").toString();
  if (q !== ui.searchQuery) ui.searchQuery = q;
};

watch(
  () => route.query.q,
  () => {
    syncFromRoute();
    observeCovers();
  }
);

// 结果加载完成后重新观察封面，做懒加载。
watch(
  () => [ui.searching, ui.searchItems.length],
  () => {
    observeCovers();
    // 首批结果渲染后延后标记：首次搜索播入场动画，之后搜索直接出现
    if (!ui.searching && ui.searchItems.length) markEntrancePlayed("search");
  }
);

/* ===== 封面懒加载（与 Home 共用模块级观察器与封面队列） ===== */
const lazyCovers = useLazyCovers({
  selector: ".search-page .book-cover, .search-page .media-cover",
});
const observeCovers = () => lazyCovers.observe();

// 与 Home/Display/FileBrowser/TagBrowse 同一套锚点滚动恢复：
// 从搜索结果打开作品再返回时，保持原关键词的列表位置（锚点为当前可视卡片）。
const pageRef = ref(null);
const searchScroll = createScrollRestorer({
  element: () => pageRef.value,
  stateKey: () => `search:${route.query.q || ""}`,
  anchorKey: () => `search:${route.query.q || ""}`,
  memory: scrollMemory,
  anchorSelector: ".search-page .book-cell[data-key], .search-page .file-hit[data-key]",
});
const saveSearchScroll = () => searchScroll.capture();

const openItem = (item) => {
  // 路由离开前冻结位置，避免 keep-alive 隐藏后 scrollTop 被复位
  searchScroll.checkpoint();
  return openSearchItem(item, { back: "search", q: String(route.query.q || "") });
};

const goBack = () => {
  if (window.history.length > 1) router.back();
  else router.push("/");
};

onMounted(() => {
  syncFromRoute();
  observeCovers();
});

onActivated(async () => {
  // 从作品返回：搜索关键词可能变化（带 q 返回时）或未变，等待结果渲染后恢复位置
  await searchScroll.restoreAfterRender();
  observeCovers();
});

onDeactivated(() => {
  // 离开前冻结当前位置；滚动事件已在持续采集，checkpoint 复用最新快照
  searchScroll.checkpoint();
  lazyCovers.reset();
});

onUnmounted(() => {
  lazyCovers.reset();
});
</script>

<template>
  <div
    class="search-page"
    ref="pageRef"
    @scroll.passive="saveSearchScroll"
  >
    <!-- 搜索结果：漫画/目录走封面网格，单文件按父目录聚合 -->
    <section class="shelf-hero shelf-hero--inner" :class="{ reveal: entranceActive('search') }">
      <button class="back-btn" @click="goBack">
        <Icon id="arrow-left" :size="16" />
        <span>返回</span>
      </button>
      <div class="hero-titles">
        <div class="kicker">01 / SEARCH · 名称与标签模糊搜索</div>
        <h1 class="hero-title">「{{ ui.searchQuery }}」</h1>
        <p class="hero-sub">共 {{ ui.searchItems.length }} 条匹配</p>
      </div>
    </section>

    <div v-if="ui.searching" class="grid-loading">
      <div v-for="i in 8" :key="i" class="cover-skeleton"></div>
    </div>

    <template v-else-if="ui.searchItems.length">
      <div v-if="searchComics.length" class="search-section-title mono">
        漫画 · {{ searchComics.length }}
      </div>
      <ul class="book-grid">
        <li
          v-for="(book, i) in searchComics"
          :key="book.key"
          class="book-cell"
          :class="{ reveal: entranceActive('search') }"
          :style="entranceActive('search') ? { animationDelay: `${Math.min(i * 36, 500)}ms` } : undefined"
          @click="openItem(book)"
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
            <n-ellipsis :tooltip="false">{{ book.name }}</n-ellipsis>
          </div>
          <div v-if="book.tags?.length" class="book-tags">
            <span v-for="t in book.tags" :key="t" class="hit-tag" :style="tagChipStyle(t)">#{{ t }}</span>
          </div>
        </li>
      </ul>

      <div v-if="searchPacks.length" class="search-section-title mono">
        目录 · {{ searchPacks.length }}
      </div>
      <ul class="book-grid">
        <li
          v-for="(item, i) in searchPacks"
          :key="item.key"
          class="book-cell"
          :class="{ reveal: entranceActive('search') }"
          :style="entranceActive('search') ? { animationDelay: `${Math.min(i * 36, 500)}ms` } : undefined"
          @click="openItem(item)"
        >
          <MediaCover
            :kind="item.kind"
            :ext="item.ext"
            :count="item.count"
            :child-count="item.childCount"
            :video-count="item.videoCount"
            :image-count="item.imageCount"
            :index="i"
            :folder="item.folder"
            :src="covers[item.key]"
            :meta="settings.showSource"
            :data-key="item.key"
            :data-kind="item.kind"
          />
          <div class="book-name">
            <n-ellipsis :tooltip="false">{{ item.name }}</n-ellipsis>
          </div>
          <div v-if="item.tags?.length" class="book-tags">
            <span v-for="t in item.tags" :key="t" class="hit-tag" :style="tagChipStyle(t)">#{{ t }}</span>
          </div>
        </li>
      </ul>

      <template v-for="(group, g) in searchFileGroups" :key="group.parentPath">
        <div class="search-section-title mono">
          文件 · 在「{{ group.parentName }}」中找到 {{ group.files.length }} 个匹配
        </div>
        <ul class="file-hit-list">
          <li
            v-for="f in group.files"
            :key="f.pathKey"
            class="file-hit"
            :data-key="f.pathKey"
            @click="openItem(f)"
          >
            <span class="file-hit-ico">
              <Icon :id="f.kind === 'video' ? 'film' : 'image'" :size="16" />
            </span>
            <span class="file-hit-name">{{ f.name }}</span>
            <span v-if="f.matchedTags?.length" class="hit-tag" :style="tagChipStyle(f.matchedTags[0])">
              #{{ f.matchedTags[0] }}
            </span>
            <span v-if="settings.showSource" class="file-hit-ext mono">{{ (f.ext || '').toUpperCase() }}</span>
            <Icon id="chevron-right" :size="14" class="file-hit-arrow" />
          </li>
        </ul>
      </template>
    </template>

    <div v-else class="empty-state">
      <Icon id="search" :size="38" />
      <p class="empty-title">没有匹配「{{ ui.searchQuery }}」的结果</p>
      <p class="empty-sub">换个关键词试试，搜索匹配作品名称、文件夹名或标签</p>
    </div>
  </div>
</template>

<style scoped lang="scss">
.search-page {
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
:global(.theme-dark) .search-page {
  background: var(--bg-0);
}

/* 幽灵石印 */
.search-page::before {
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
  overflow-wrap: anywhere;
}

.hero-sub {
  margin-top: 6px;
  font-size: 13px;
  letter-spacing: 0.34em;
  color: var(--text-3);
  text-transform: uppercase;
  font-family: var(--mono);
}

.kicker {
  font-size: 11px;
  letter-spacing: 0.24em;
  color: var(--text-3);
  text-transform: uppercase;
  font-family: var(--mono);
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
    max-width: 380px;
    line-height: 1.7;
  }
}

/* ===== 搜索结果 ===== */
.search-section-title {
  position: relative;
  z-index: 1;
  margin: 10px 0 18px;
  font-size: 11px;
  letter-spacing: 0.2em;
  color: var(--text-3);
  text-transform: uppercase;
}

/* 标签命中的徽标（只在搜索结果出现，书架卡片保持干净） */
.book-tags {
  position: relative;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 5px;
  min-height: 18px;
}

.hit-tag {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid transparent;
  font-size: 10.5px;
  line-height: 1;
  white-space: nowrap;
}

.file-hit-list {
  position: relative;
  z-index: 1;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0;
  max-width: 720px;
  margin-bottom: 40px;
}

.file-hit {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 46px;
  padding: 0 16px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--bg-2);
  cursor: pointer;
  transition: border-color 0.25s, background 0.25s, transform 0.25s var(--ease-out);

  &:hover {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent-soft) 45%, var(--bg-2));
    transform: translateY(-2px);
  }
}

.file-hit-ico {
  display: grid;
  place-items: center;
  color: var(--text-3);
  flex-shrink: 0;
}

.file-hit-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-hit-ext {
  font-size: 10px;
  letter-spacing: 0.1em;
  color: var(--text-3);
}

.file-hit-arrow {
  color: var(--text-3);
  flex-shrink: 0;
}

@media (max-width: 900px) {
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
   触屏无悬停态，位移只会在按下瞬间抖动并与滚动恢复锚点重叠；
   颜色/描边反馈、:active 与骨架屏保留。 */
@media (hover: none) {
  .file-hit:hover,
  .back-btn:hover {
    transform: none;
  }
}
</style>
