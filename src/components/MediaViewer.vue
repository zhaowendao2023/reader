<script setup>
import { readDir, readFile } from "@tauri-apps/plugin-fs";
import { useBooks } from "../store/loadBooks";
import { IMAGE_EXTS, extOf, joinPath } from "../utils/media";
import Icon from "./Icon.vue";

defineOptions({ name: "MediaViewer" });

const route = useRoute();
const router = useRouter();
const booksStore = useBooks();

const images = ref([]);
const index = ref(0);
const url = ref("");
const loading = ref(true);
const error = ref("");
const stageRef = ref(null);
let objectUrl = "";
let alive = true;

const fileName = computed(() => {
  const p = images.value[index.value]?.path || route.query.path || "";
  return String(p).split(/[\\/]/).pop() || "图包";
});

const loadImage = async (path) => {
  loading.value = true;
  error.value = "";
  try {
    const bytes = await readFile(path);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(new Blob([bytes]));
    if (!alive) return;
    url.value = objectUrl;
  } catch (e) {
    error.value = String(e);
  } finally {
    if (alive) loading.value = false;
  }
};

const pick = async (i) => {
  if (!images.value.length) return;
  index.value = (i + images.value.length) % images.value.length;
  await loadImage(images.value[index.value].path);
};

const next = () => pick(index.value + 1);
const prev = () => pick(index.value - 1);

const init = async () => {
  const single = route.query.path;
  const dir = route.query.dir;
  try {
    if (typeof dir === "string" && dir) {
      const raw = await readDir(dir);
      const list = raw
        .filter((e) => e.isFile && IMAGE_EXTS.includes(extOf(e.name)))
        .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true }))
        .map((e) => ({ name: e.name, path: joinPath(dir, e.name) }));
      images.value = list;
      const norm = (p) =>
        booksStore.platform === "windows" ? String(p).toLowerCase() : String(p);
      let idx = 0;
      if (typeof single === "string" && single) {
        const found = list.findIndex((it) => norm(it.path) === norm(single));
        if (found >= 0) idx = found;
      }
      index.value = idx;
      if (list.length) {
        await loadImage(list[idx].path);
        return;
      }
    }
    if (typeof single === "string" && single) {
      await loadImage(single);
      return;
    }
    error.value = "缺少图片路径";
  } catch (e) {
    error.value = String(e);
  } finally {
    if (alive) loading.value = false;
  }
};

const onKey = (e) => {
  if (e.key === "ArrowRight") {
    e.preventDefault();
    next();
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    prev();
  } else if (e.key === "Escape") {
    goBack();
  }
};

const goBack = () => {
  if (window.history.length > 1) router.back();
  else router.push("/");
};

const onStageClick = (e) => {
  const rect = stageRef.value?.getBoundingClientRect();
  if (!rect) return;
  const x = e.clientX - rect.left;
  const third = rect.width / 3;
  if (x > third * 2) next();
  else if (x < third) prev();
};

onMounted(async () => {
  alive = true;
  await init();
  window.addEventListener("keydown", onKey);
});

onUnmounted(() => {
  alive = false;
  window.removeEventListener("keydown", onKey);
  if (objectUrl) URL.revokeObjectURL(objectUrl);
});
</script>

<template>
  <div class="media-page">
    <span class="ghost-word">图</span>

    <header class="top-chrome">
      <button class="circle-btn" title="返回" @click="goBack">
        <Icon id="arrow-left" :size="18" />
      </button>
      <div class="head-titles">
        <div class="kicker">02 / IMAGE · 图包放映</div>
        <h1 class="head-title">{{ fileName }}</h1>
      </div>
      <div v-if="images.length > 1" class="head-meta mono">
        {{ index + 1 }} / {{ images.length }}
      </div>
    </header>

    <div ref="stageRef" class="stage" @click="onStageClick">
      <img
        v-if="url"
        :src="url"
        class="media-img"
        :class="{ show: !loading }"
        alt=""
        draggable="false"
      />
      <div v-else-if="loading" class="stage-note">
        <Icon id="loader-circle" :size="22" class="spin" />
        <span>正在载入图包…</span>
      </div>
      <div v-else-if="error" class="stage-note">{{ error }}</div>
      <div v-else class="stage-note">没有可显示的图片</div>

      <button v-if="images.length > 1" class="side-arrow side-arrow--prev" title="上一张" @click.stop="prev">
        <Icon id="chevron-left" :size="20" />
      </button>
      <button v-if="images.length > 1" class="side-arrow side-arrow--next" title="下一张" @click.stop="next">
        <Icon id="chevron-right" :size="20" />
      </button>
    </div>

    <footer class="bottom-chrome">
      <div class="glass pill">
        <button class="pill-btn" :disabled="images.length < 2" title="上一张" @click="prev">
          <Icon id="chevron-left" :size="17" />
        </button>
        <span class="pill-count mono">
          {{ images.length ? `${index + 1} / ${images.length}` : "—" }}
        </span>
        <button class="pill-btn" :disabled="images.length < 2" title="下一张" @click="next">
          <Icon id="chevron-right" :size="17" />
        </button>
      </div>
    </footer>
  </div>
</template>

<style scoped lang="scss">
.media-page {
  --p-bg: #050508;
  --p-panel: rgba(17, 17, 23, 0.78);
  --p-line: rgba(255, 255, 255, 0.1);
  --p-text: #f4f1e9;
  --p-text-2: rgba(244, 241, 233, 0.6);
  --p-text-3: rgba(244, 241, 233, 0.36);
  --p-accent: #ff4d2e;
  --p-accent-2: #ff9a3d;

  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background:
    radial-gradient(90% 70% at 85% -10%, rgba(255, 77, 46, 0.12), transparent 55%),
    radial-gradient(60% 50% at -10% 100%, rgba(90, 60, 255, 0.08), transparent 60%),
    var(--p-bg);
  color: var(--p-text);
}

.ghost-word {
  position: absolute;
  top: 30px;
  right: 3vw;
  z-index: 0;
  font-family: var(--serif);
  font-size: clamp(220px, 34vw, 520px);
  font-weight: 900;
  line-height: 0.9;
  color: transparent;
  -webkit-text-stroke: 1px rgba(244, 241, 233, 0.05);
  pointer-events: none;
  user-select: none;
}

.top-chrome {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 26px 30px 16px;
}

.circle-btn {
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border: 1px solid var(--p-line);
  border-radius: 50%;
  background: var(--p-panel);
  color: var(--p-text);
  cursor: pointer;
  backdrop-filter: blur(14px);
  transition: transform 0.25s var(--ease-out), border-color 0.25s, color 0.25s;

  &:hover {
    color: var(--p-accent);
    border-color: var(--p-accent);
    transform: translateY(-2px);
  }
}

.head-titles {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;

  .kicker {
    color: var(--p-text-3);
  }
}

.head-title {
  font-family: var(--serif);
  font-size: clamp(18px, 2.2vw, 26px);
  font-weight: 800;
  letter-spacing: 0.06em;
  line-height: 1.15;
  color: var(--p-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.head-meta {
  margin-left: auto;
  padding: 8px 14px;
  border: 1px solid var(--p-line);
  border-radius: 999px;
  background: var(--p-panel);
  color: var(--p-text-2);
  font-size: 11px;
  letter-spacing: 0.2em;
  backdrop-filter: blur(14px);
}

.stage {
  position: relative;
  z-index: 1;
  flex: 1;
  min-height: 0;
  margin: 0 30px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-lg);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent 30%),
    #000;
  border: 1px solid rgba(255, 255, 255, 0.06);
  box-shadow: 0 40px 90px rgba(0, 0, 0, 0.55);
  overflow: hidden;
}

.media-img {
  max-width: calc(100% - 90px);
  max-height: calc(100% - 70px);
  object-fit: contain;
  border-radius: 6px;
  opacity: 0;
  transform: scale(0.985);
  transition: opacity 0.5s var(--ease-out), transform 0.5s var(--ease-out);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.6);
  user-select: none;

  &.show {
    opacity: 1;
    transform: scale(1);
  }
}

.stage-note {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  color: var(--p-text-3);
  font-family: var(--mono);
  font-size: 13px;
  letter-spacing: 0.12em;
}

.side-arrow {
  position: absolute;
  top: 50%;
  width: 46px;
  height: 46px;
  display: grid;
  place-items: center;
  border: 1px solid var(--p-line);
  border-radius: 50%;
  background: rgba(10, 10, 14, 0.55);
  color: rgba(244, 241, 233, 0.7);
  cursor: pointer;
  opacity: 0;
  transform: translateY(-50%) scale(0.9);
  transition: opacity 0.3s var(--ease-out), transform 0.3s var(--ease-out), color 0.25s, border-color 0.25s;
  backdrop-filter: blur(10px);

  &--prev {
    left: 18px;
  }
  &--next {
    right: 18px;
  }

  &:hover {
    color: var(--p-accent);
    border-color: var(--p-accent);
  }
}

.stage:hover .side-arrow {
  opacity: 1;
  transform: translateY(-50%) scale(1);
}

.bottom-chrome {
  position: relative;
  z-index: 2;
  display: flex;
  justify-content: center;
  padding: 18px 30px 26px;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px;
  border-radius: 999px;
}

.pill-btn {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--p-text-2);
  cursor: pointer;
  transition: color 0.25s, background 0.25s;

  &:hover:not(:disabled) {
    color: var(--p-accent);
    background: rgba(255, 77, 46, 0.1);
  }

  &:disabled {
    opacity: 0.35;
    cursor: default;
  }
}

.pill-count {
  min-width: 76px;
  text-align: center;
  font-size: 11px;
  letter-spacing: 0.22em;
  color: var(--p-text-2);
}

@media (max-width: 640px) {
  .stage {
    margin: 0 12px;
  }
  .top-chrome {
    padding: 18px 16px 12px;
  }
}
</style>
