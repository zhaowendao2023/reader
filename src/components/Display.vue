<script setup>
import { readDir } from "@tauri-apps/plugin-fs";
import { useBooks } from "../store/loadBooks";
import { useUI } from "../store/ui";
import { covers, canonKey, enqueueCover, prefetchCovers, stopPrefetch } from "../store/browserCache";
import { calculateHash } from "../utils/utils";
import { extOf, isVideo, isImage } from "../utils/media";
import Icon from "./Icon.vue";

const booksStore = useBooks();
const ui = useUI();
const router = useRouter();
const favoriteDirs = computed(() => booksStore.favoriteDirs);
const counts = reactive({});

const COMIC_EXTS = ["cbz", "zip", "epub", "mobi"];

const currentDir = ref(null);
const books = ref([]);
const loading = ref(false);

const loadCount = async (dir) => {
  if (counts[dir.path] !== undefined) return;
  try {
    const list = await readDir(dir.path);
    const n = list.filter(
      (e) =>
        e.isFile &&
        (isComicFile(e.name) || isVideo(e.name) || isImage(e.name))
    ).length;
    counts[dir.path] = n;
  } catch (error) {
    counts[dir.path] = 0;
  }
};

watch(
  () => booksStore.favoriteDirs.map((d) => d.path).join("\u0000"),
  () => {
    for (const d of booksStore.favoriteDirs) loadCount(d);
  },
  { immediate: true }
);

const joinPath = (base, name) => {
  const sep = booksStore.platform === "windows" ? "\\" : "/";
  return base.endsWith(sep) ? base + name : base + sep + name;
};

const isComicFile = (name) => {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return COMIC_EXTS.includes(name.slice(dot + 1).toLowerCase());
};

const openDir = async (dir) => {
  currentDir.value = { name: dir.name, path: dir.path };
  savedScroll = 0;
  loading.value = true;
  books.value = [];
  try {
    const raw = await readDir(dir.path);
    const list = [];
    for (const e of raw) {
      if (e.name.startsWith(".")) continue;
      const ext = extOf(e.name);
      if (e.isFile && (isComicFile(e.name) || isVideo(e.name) || isImage(e.name))) {
        list.push({
          name: e.name,
          key: canonKey(joinPath(dir.path, e.name)),
          path: joinPath(dir.path, e.name),
          ext,
          kind: isComicFile(e.name) ? "comic" : isVideo(e.name) ? "video" : "image",
        });
      }
    }
    list.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true }));
    books.value = list;
  } catch (error) {
    books.value = [];
  } finally {
    loading.value = false;
    observeCovers();
  }
};

const backToFavs = () => {
  currentDir.value = null;
  books.value = [];
  savedScroll = 0;
  coverObserver?.disconnect();
  stopPrefetch();
};

// 侧边栏点击「收藏」：直接回到收藏文件夹总览
watch(
  () => ui.navReset,
  () => {
    backToFavs();
    nextTick(() => {
      if (pageRef.value) pageRef.value.scrollTop = 0;
    });
  }
);

const openComic = async (book) => {
  const key = booksStore.platform === "windows" ? book.key.toLowerCase() : book.key;
  const id = await calculateHash(key);
  if (!booksStore.getBook(id)) {
    const title = book.name.slice(0, book.name.lastIndexOf("."));
    await booksStore.addBook({ [id]: { title, path: key, ext: book.ext } });
  }
  router.push({ path: `/reading/${id}`, query: { back: "shelf" } });
};

const openVideo = async (item) => {
  const key = booksStore.platform === "windows" ? item.key.toLowerCase() : item.key;
  const id = await calculateHash(key);
  router.push({
    path: `/video/${id}`,
    query: { dir: item.dir || currentDir.value?.path, path: item.path || item.key, name: item.name, playlist: "1" },
  });
};

const openImage = async (item) => {
  const key = booksStore.platform === "windows" ? item.key.toLowerCase() : item.key;
  const id = await calculateHash(key);
  router.push({
    path: `/media/${id}`,
    query: { dir: item.dir || currentDir.value?.path, path: item.path || item.key, name: item.name },
  });
};

const openBook = (book) => {
  if (book.kind === "video") return openVideo(book);
  if (book.kind === "image") return openImage(book);
  return openComic(book);
};

const removeDir = async (dir) => {
  await booksStore.removeFavoriteDir(dir.path);
  delete counts[dir.path];
};

let coverObserver = null;
const observedCovers = new Set();

const pageRef = ref(null);
let savedScroll = 0;

const onPageScroll = () => {
  if (pageRef.value) savedScroll = pageRef.value.scrollTop;
};

const observeCovers = async () => {
  await nextTick();
  coverObserver?.disconnect();
  observedCovers.clear();
  const nodes = document.querySelectorAll(".fav-page .book-cover");
  coverObserver = new IntersectionObserver(
    (list) => {
      for (const item of list) {
        if (!item.isIntersecting) continue;
        const key = item.target.dataset.key;
        coverObserver?.unobserve(item.target);
        if (observedCovers.has(key)) continue;
        observedCovers.add(key);
        enqueueCover(key, true);
      }
    },
    { rootMargin: "300px" }
  );
  for (const node of nodes) coverObserver.observe(node);
  prefetchCovers(books.value.map((b) => b.key));
};

watch(books, () => observeCovers());

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

const totalBooks = computed(() =>
  favoriteDirs.value.reduce((acc, d) => acc + (counts[d.path] || 0), 0)
);

// 装饰性渐变（收藏夹封面占位）
const plateStyles = [
  "linear-gradient(150deg, #ff4d2e 0%, #ff9a3d 55%, #ffd166 100%)",
  "linear-gradient(150deg, #7a9e00 0%, #a3c92a 55%, #d6ff3f 100%)",
  "linear-gradient(150deg, #1f6feb 0%, #5b8cff 60%, #9db8ff 100%)",
  "linear-gradient(150deg, #9b5de5 0%, #c77dff 55%, #e0aaff 100%)",
];
</script>

<template>
  <div class="fav-page" ref="pageRef">
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
          class="book-cell reveal"
          :style="{ animationDelay: `${Math.min(i * 40, 500)}ms` }"
          @click="openBook(book)"
        >
          <div class="book-cover" :class="{ 'book-cover--media': book.kind !== 'comic' }" :data-key="book.key">
            <img
              v-if="book.kind === 'comic' && covers[book.key]"
              :src="covers[book.key]"
              class="book-cover-img"
              alt=""
              loading="lazy"
              decoding="async"
            />
            <span v-else class="book-cover-ph">
              <Icon :id="book.kind === 'video' ? 'play' : book.kind === 'image' ? 'image' : 'book-open'" :size="34" />
            </span>
            <span class="book-ext mono">{{ book.ext.toUpperCase() }}</span>
            <span v-if="book.kind !== 'comic'" class="media-overlay">
              <span class="media-glyph" :class="{ video: book.kind === 'video' }">
                <Icon :id="book.kind === 'video' ? 'play' : 'scan'" :size="20" />
              </span>
            </span>
          </div>
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
          class="plate reveal"
          :style="{ animationDelay: `${Math.min(i * 60, 600)}ms` }"
          @click="openDir(dir)"
        >
          <div class="plate-art" :style="{ background: plateStyles[i % plateStyles.length] }">
            <span class="plate-art-no mono">{{ String(i + 1).padStart(2, "0") }}</span>
            <Icon id="folder" :size="34" class="plate-ico" :stroke-width="1.75" />
            <span class="plate-art-line"></span>
          </div>
          <button class="plate-remove" title="取消收藏" @click.stop="removeDir(dir)">
            <Icon id="x" :size="14" />
          </button>
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
  border: 1px solid var(--line);
  overflow: hidden;
  transition: transform 0.45s var(--ease-spring), box-shadow 0.45s var(--ease-out), border-color 0.3s;

  &:hover {
    transform: translateY(-8px);
    border-color: var(--line-strong);
    box-shadow: var(--shadow-2);
    .plate-art {
      transform: scale(1.05);
    }
    .plate-remove {
      opacity: 1;
      transform: translateY(0);
    }
  }
}

.plate-art {
  position: relative;
  aspect-ratio: 1 / 1.08;
  display: grid;
  place-items: center;
  overflow: hidden;
  transition: transform 0.6s var(--ease-out);

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

.plate-remove {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 2;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  backdrop-filter: blur(8px);
  cursor: pointer;
  opacity: 0;
  transform: translateY(-4px);
  transition: all 0.3s var(--ease-out);

  &:hover {
    background: var(--accent);
  }
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

.book-cover--media {
  background:
    radial-gradient(80% 60% at 30% 20%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 60%),
    var(--bg-2);
}

.media-overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(5, 5, 8, 0.28);
  opacity: 0;
  transition: opacity 0.35s var(--ease-out);
  backdrop-filter: blur(1.5px);
}

.media-glyph {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.12);
  border: 1px solid rgba(255, 255, 255, 0.28);
  color: #fff;
  transform: scale(0.82);
  transition: transform 0.3s var(--ease-spring), background 0.3s;

  &.video {
    background: linear-gradient(135deg, #ff4d2e, #ff9a3d);
    border: none;
    box-shadow: 0 8px 26px rgba(255, 77, 46, 0.4);
  }
}

.book-cell:hover .media-overlay {
  opacity: 1;

  .media-glyph {
    transform: scale(1);
  }
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
</style>
