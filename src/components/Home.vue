<script setup>
import { readDir } from "@tauri-apps/plugin-fs";
import { useBooks } from "../store/loadBooks";
import { useUI } from "../store/ui";
import { covers, canonKey, enqueueCover, prefetchCovers, stopPrefetch } from "../store/browserCache";
import { calculateHash } from "../utils/utils";
import { MEDIA_EXTS, extOf, isVideo } from "../utils/media";
import Icon from "./Icon.vue";

defineOptions({ name: "Home" });

const booksStore = useBooks();
const ui = useUI();
const router = useRouter();

const favoriteDirs = computed(() => booksStore.favoriteDirs);

// 聚合类型：hub = 双卡片主界面；comics = 全量漫画；media = 视频图包
const mode = ref("hub");
const comics = ref([]);
const media = ref([]);
const scanning = ref(false);

const COMIC_EXTS = ["cbz", "zip", "epub", "mobi"];

const joinPath = (base, name) => {
  const sep = booksStore.platform === "windows" ? "\\" : "/";
  return base.endsWith(sep) ? base + name : base + sep + name;
};

const collectVideoPacks = async (baseDir, favoriteName, target) => {
  let raw;
  try {
    raw = await readDir(baseDir);
  } catch {
    return;
  }
  for (const e of raw) {
    if (e.name.startsWith(".")) continue;
    const full = joinPath(baseDir, e.name);
    if (e.isDirectory) {
      await collectVideoPacks(full, favoriteName, target);
    } else if (e.isFile && isVideo(e.name)) {
      const key = canonKey(baseDir);
      let pack = target.get(key);
      if (!pack) {
        const name = baseDir.split(/[\\/]/).filter(Boolean).pop() || baseDir;
        pack = {
          name,
          key,
          path: baseDir,
          folder: favoriteName,
          kind: "video-folder",
          count: 0,
        };
        target.set(key, pack);
      }
      pack.count++;
    }
  }
};

// 打平所有收藏文件夹：漫画包进全量书架，视频按目录聚成系列，图包单文件进媒体
const scanAll = async () => {
  const dirs = favoriteDirs.value;
  scanning.value = true;
  const comicMap = new Map();
  const mediaMap = new Map();
  const videoPackMap = new Map();
  const tasks = dirs.map(async (dir) => {
    try {
      const raw = await readDir(dir.path);
      await collectVideoPacks(dir.path, dir.name, videoPackMap);
      for (const e of raw) {
        if (!e.isFile || e.name.startsWith(".")) continue;
        const ext = extOf(e.name);
        const item = {
          name: e.name,
          key: canonKey(joinPath(dir.path, e.name)),
          path: joinPath(dir.path, e.name),
          ext,
          folder: dir.name,
          dir: dir.path,
          kind: COMIC_EXTS.includes(ext) ? "comic" : isVideo(e.name) ? "video" : "image",
        };
        if (COMIC_EXTS.includes(ext)) comicMap.set(item.key, item);
        else if (MEDIA_EXTS.includes(ext) && !isVideo(e.name)) mediaMap.set(item.key, item);
      }
    } catch (error) {
      // 单个文件夹读取失败不影响其它收藏夹聚合
    }
  });
  await Promise.all(tasks);
  const byName = (a, b) => a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true });
  comics.value = Array.from(comicMap.values()).sort(byName);
  media.value = [...videoPackMap.values(), ...mediaMap.values()].sort(byName);
  scanning.value = false;
  observeCovers();
};

watch(
  () => favoriteDirs.value.map((d) => d.path).join("\u0000"),
  () => scanAll(),
  { immediate: true }
);

const enter = (kind) => {
  mode.value = kind;
  savedScroll = 0;
  if (kind !== "comics") stopPrefetch();
  nextTick(() => observeCovers());
};

const backToHub = () => {
  mode.value = "hub";
  savedScroll = 0;
  coverObserver?.disconnect();
  stopPrefetch();
};

// 侧边栏点击「主界面」：无论当前在漫画/视频聚合页，直接回到双卡片
watch(
  () => ui.navReset,
  () => {
    mode.value = "hub";
    savedScroll = 0;
    coverObserver?.disconnect();
    stopPrefetch();
    nextTick(() => {
      if (pageRef.value) pageRef.value.scrollTop = 0;
    });
  }
);

const openBook = async (book) => {
  const key = booksStore.platform === "windows" ? book.key.toLowerCase() : book.key;
  const id = await calculateHash(key);
  if (!booksStore.getBook(id)) {
    const title = book.name.slice(0, book.name.lastIndexOf("."));
    await booksStore.addBook({ [id]: { title, path: key, ext: book.ext } });
  }
  router.push(`/reading/${id}`);
};

const openVideo = async (item) => {
  const key = booksStore.platform === "windows" ? item.key.toLowerCase() : item.key;
  const id = await calculateHash(key);
  router.push({
    path: `/video/${id}`,
    query: { path: item.path || item.key, name: item.name },
  });
};

const openVideoFolder = async (item) => {
  const key = booksStore.platform === "windows" ? item.key.toLowerCase() : item.key;
  const id = await calculateHash(key);
  router.push({
    path: `/video/${id}`,
    query: { path: item.path || item.key, name: item.name, playlist: "1" },
  });
};

const openImage = async (item) => {
  const key = booksStore.platform === "windows" ? item.key.toLowerCase() : item.key;
  const id = await calculateHash(key);
  router.push({
    path: `/media/${id}`,
    query: { dir: item.dir || item.path, path: item.path || item.key, name: item.name },
  });
};

const openMedia = (item) => {
  if (item.kind === "video-folder") openVideoFolder(item);
  else if (isVideo(item.ext)) openVideo(item);
  else openImage(item);
};

/* ===== 封面懒加载（与书架共用缓存队列） ===== */
let coverObserver = null;
const observedCovers = new Set();

const observeCovers = async () => {
  await nextTick();
  coverObserver?.disconnect();
  observedCovers.clear();
  const nodes = document.querySelectorAll(".home-page .book-cover");
  coverObserver = new IntersectionObserver(
    (list) => {
      for (const item of list) {
        if (!item.isIntersecting) continue;
        const key = item.target.dataset.key;
        const kind = item.target.dataset.kind;
        if (kind === "video" || kind === "video-folder" || kind === "image") continue;
        coverObserver?.unobserve(item.target);
        if (observedCovers.has(key)) continue;
        observedCovers.add(key);
        enqueueCover(key, true);
      }
    },
    { rootMargin: "300px" }
  );
  for (const node of nodes) coverObserver.observe(node);
  if (mode.value === "comics") prefetchCovers(comics.value.map((b) => b.key));
};

const pageRef = ref(null);
let savedScroll = 0;

const onPageScroll = () => {
  if (pageRef.value) savedScroll = pageRef.value.scrollTop;
};

onMounted(() => {
  pageRef.value?.addEventListener("scroll", onPageScroll, { passive: true });
});

onActivated(() => {
  nextTick(() => {
    if (pageRef.value && savedScroll) pageRef.value.scrollTop = savedScroll;
  });
  observeCovers();
});

onDeactivated(() => {
  coverObserver?.disconnect();
  stopPrefetch();
});

onUnmounted(() => {
  pageRef.value?.removeEventListener("scroll", onPageScroll);
  coverObserver?.disconnect();
  stopPrefetch();
});

const mediaIcon = (item) =>
  item.kind === "video-folder" || isVideo(item.ext) ? "play" : "image";
</script>

<template>
  <div class="home-page" ref="pageRef">
    <!-- 主界面：全量聚合中心入口 -->
    <template v-if="mode === 'hub'">
      <section class="shelf-hero reveal">
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
        <button class="hub-card hub-card--comic reveal" @click="enter('comics')">
          <div class="hub-art">
            <span class="hub-art-no mono">A</span>
            <Icon id="book-open" :size="44" class="hub-ico" :stroke-width="1.6" />
            <span class="hub-art-line"></span>
          </div>
          <div class="hub-body">
            <div class="hub-name">
              漫画
              <span class="hub-tag mono">全集</span>
            </div>
            <p class="hub-desc">所有收藏的漫画，在这里一册不落</p>
            <div class="hub-meta mono">
              <span class="hub-num">{{ scanning ? "…" : comics.length }}</span>
              <span>部作品 · {{ favoriteDirs.length }} 个收藏夹</span>
            </div>
          </div>
        </button>

        <button class="hub-card hub-card--media reveal" @click="enter('media')">
          <div class="hub-art">
            <span class="hub-art-no mono">B</span>
            <Icon id="film" :size="44" class="hub-ico" :stroke-width="1.6" />
            <span class="hub-art-line"></span>
          </div>
          <div class="hub-body">
            <div class="hub-name">
              视频图包
              <span class="hub-tag mono">放映</span>
            </div>
            <p class="hub-desc">影像与图集，一页尽览</p>
            <div class="hub-meta mono">
              <span class="hub-num">{{ scanning ? "…" : media.length }}</span>
              <span>视频 / 图包 · {{ favoriteDirs.length }} 个收藏夹</span>
            </div>
          </div>
        </button>
      </div>
    </template>

    <!-- 聚合视图 -->
    <template v-else>
      <section class="shelf-hero shelf-hero--inner reveal">
        <button class="back-btn" @click="backToHub">
          <Icon id="arrow-left" :size="16" />
          <span>返回主界面</span>
        </button>
        <div class="hero-titles">
          <div class="kicker">
            {{ mode === "comics" ? "01 / COMICS · 全量书库" : "01 / MEDIA · 影像图集" }}
          </div>
          <h1 class="hero-title">{{ mode === "comics" ? "漫画" : "视频图包" }}</h1>
        </div>
        <div class="hero-meta mono" v-if="!scanning">
          <span>{{ (mode === "comics" ? comics : media).length }} {{ mode === "comics" ? "部作品" : "个视频 / 图包" }}</span>
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
          class="book-cell reveal"
          :style="{ animationDelay: `${Math.min(i * 36, 500)}ms` }"
          @click="openBook(book)"
        >
          <div class="book-cover" :data-key="book.key">
            <img
              v-if="covers[book.key]"
              :src="covers[book.key]"
              class="book-cover-img"
              alt=""
              loading="lazy"
              decoding="async"
            />
            <span v-else class="book-cover-ph"><Icon id="book-open" :size="34" /></span>
            <span class="book-ext mono">{{ book.ext.toUpperCase() }}</span>
            <span v-if="book.folder" class="book-folder mono">{{ book.folder }}</span>
          </div>
          <div class="book-name">
            <n-ellipsis :tooltip="false">{{ book.name }}</n-ellipsis>
          </div>
        </li>
      </ul>

      <!-- 视频图包聚合 -->
      <ul v-else-if="mode === 'media' && media.length" class="book-grid">
        <li
          v-for="(item, i) in media"
          :key="item.key"
          class="book-cell reveal"
          :style="{ animationDelay: `${Math.min(i * 36, 500)}ms` }"
          @click="openMedia(item)"
        >
          <div class="book-cover book-cover--media" :data-key="item.key" :data-kind="item.kind">
            <span class="book-cover-ph"><Icon :id="mediaIcon(item)" :size="34" /></span>
            <span class="book-ext mono">{{ item.kind === "video-folder" ? item.count + " 集" : item.ext.toUpperCase() }}</span>
            <span v-if="item.folder" class="book-folder mono">{{ item.folder }}</span>
          </div>
          <div class="book-name">
            <n-ellipsis :tooltip="false">{{ item.name }}</n-ellipsis>
          </div>
        </li>
      </ul>

      <!-- 空状态 -->
      <div v-else class="empty-state">
        <Icon :id="mode === 'comics' ? 'book-open' : 'film'" :size="38" />
        <p class="empty-title">{{ mode === "comics" ? "还没有收藏的漫画" : "还没有视频图包" }}</p>
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
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 28px;
  padding: 0;
}

.hub-card {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--bg-2);
  overflow: hidden;
  cursor: pointer;
  text-align: left;
  transition: transform 0.45s var(--ease-spring), box-shadow 0.45s var(--ease-out), border-color 0.3s;

  &:hover {
    transform: translateY(-8px);
    border-color: var(--line-strong);
    box-shadow: var(--shadow-2);

    .hub-art {
      transform: scale(1.04);
    }
    .hub-ico {
      transform: translateY(-4px) scale(1.08);
    }
    .hub-num {
      color: var(--accent);
    }
  }
}

.hub-card--comic .hub-art {
  background: linear-gradient(150deg, #e6391f 0%, #ff7a45 55%, #ffd166 100%);
}

.hub-card--media .hub-art {
  background: linear-gradient(150deg, #1f6feb 0%, #5b8cff 60%, #9db8ff 100%);
}

.hub-art {
  position: relative;
  aspect-ratio: 16 / 9;
  display: grid;
  place-items: center;
  overflow: hidden;
  transition: transform 0.6s var(--ease-out);

  .hub-art-no {
    position: absolute;
    top: 14px;
    left: 16px;
    font-size: 11px;
    letter-spacing: 0.2em;
    color: rgba(255, 255, 255, 0.78);
  }

  .hub-ico {
    color: rgba(255, 255, 255, 0.95);
    filter: drop-shadow(0 8px 20px rgba(0, 0, 0, 0.35));
    transition: transform 0.45s var(--ease-spring);
  }

  .hub-art-line {
    position: absolute;
    bottom: 0;
    left: 16px;
    right: 16px;
    height: 1px;
    background: linear-gradient(90deg, rgba(255, 255, 255, 0.65), transparent);
  }
}

.hub-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 20px 22px 22px;
}

.hub-name {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--serif);
  font-size: 24px;
  font-weight: 800;
  letter-spacing: 0.08em;
  color: var(--text-1);
}

.hub-tag {
  font-size: 9px;
  letter-spacing: 0.24em;
  padding: 3px 8px;
  border-radius: 999px;
  color: var(--accent);
  background: var(--accent-soft);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
}

.hub-desc {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-3);
}

.hub-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 10.5px;
  letter-spacing: 0.14em;
  color: var(--text-3);

  .hub-num {
    font-size: 22px;
    font-weight: 700;
    color: var(--text-1);
    transition: color 0.3s;
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
}

.book-cover {
  position: relative;
  aspect-ratio: 1 / 1.414;
  border-radius: 10px;
  overflow: hidden;
  background: var(--bg-2);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-1);
  transition: transform 0.45s var(--ease-spring), box-shadow 0.45s var(--ease-out);
  display: grid;
  place-items: center;

  &::after {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, transparent 60%, rgba(0, 0, 0, 0.18));
    opacity: 0;
    transition: opacity 0.35s;
    pointer-events: none;
  }
}

.book-cover--media {
  aspect-ratio: 1 / 1.414;
}

.book-cell:hover .book-cover {
  transform: translateY(-6px) scale(1.02);
  box-shadow: var(--shadow-2);
  &::after {
    opacity: 1;
  }
}

.book-cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.book-cover-ph {
  color: var(--text-3);
  display: grid;
  place-items: center;
}

.book-ext {
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

.book-folder {
  position: absolute;
  left: 8px;
  bottom: 8px;
  max-width: 55%;
  padding: 3px 7px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.45);
  color: rgba(255, 255, 255, 0.82);
  font-size: 9px;
  letter-spacing: 0.1em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  backdrop-filter: blur(6px);
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

@media (max-width: 900px) {
  .hub-grid,
  .book-grid {
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  }
}
</style>
