<script setup>
import MobiReading from "./MobiReading.vue";
import { flushProgress, setProgress } from "../utils/progress";
import { enterSystemUIImmersive, exitSystemUIImmersive } from "../utils/systemBar";

const containerRef = ref(null);
const route = useRoute();
const show = ref(false);
const indexState = ref({
  nowIndex: 0,
  total: 0,
});
provide("index", indexState);
const progressReady = ref(false);
provide("progressReady", progressReady);
const bookId = ref(null);
provide("bookId", bookId);
provide("toces", ref([]));
provide("show", show);
const bookInfo = ref(null);
onBeforeMount(() => {
  bookId.value = route.params.id;
  const q = route.query;
  const path = String(q.path || "");
  const name = String(q.name || "");
  bookInfo.value = {
    title: name.replace(/\.[^.]+$/, "") || path.split(/[\\/]/).filter(Boolean).pop() || "",
    path,
    ext: String(q.ext || ""),
  };
});

provide("bookInfo", bookInfo);
watch(
  () => indexState.value.nowIndex,
  (page) => {
    if (progressReady.value) setProgress(bookId.value, page);
  }
);
const boxShow = (e) => {
  const x = e.clientX;
  const y = e.clientY;
  const centerX = window.innerWidth * 0.3;
  const centerY = window.innerHeight * 0.3;
  const centerWidth = window.innerWidth * 0.6;
  const centerHeight = window.innerHeight * 0.6;
  const isInCenter =
    x >= centerX &&
    x <= centerX + centerWidth &&
    y >= centerY &&
    y <= centerY + centerHeight;
  if (isInCenter) {
    show.value = !show.value;
  }
};

const moveMethods = {
  left: () => {
    containerRef.value?.left();
  },
  right: () => {
    containerRef.value?.right();
  },
  jump: ({ option }) => {
    return {
      onClick() {
        const href = option.href;
        containerRef.value?.jump(href);
      },
    };
  },
  slider: (n) => containerRef.value?.slider?.(n),
};
provide("moveMethods", moveMethods);
onMounted(() => {
  enterSystemUIImmersive();
});
onUnmounted(() => {
  exitSystemUIImmersive();
  void flushProgress();
});
</script>

<template>
  <div class="reader-root">
    <div class="reader-drag" data-tauri-drag-region></div>
    <TopDrawer />
    <div class="reader-stage" @click="boxShow">
      <ComicReading
        v-if="bookInfo && (bookInfo.ext.endsWith('cbz') || bookInfo.ext.endsWith('zip'))"
        ref="containerRef"
      />
      <EpubReading v-else-if="bookInfo && bookInfo.ext.endsWith('epub')" ref="containerRef" />
      <MobiReading v-else-if="bookInfo && bookInfo.ext.endsWith('mobi')" ref="containerRef" />
    </div>
    <BottomDrawer />
  </div>
</template>

<style scoped>
.reader-root {
  position: relative;
  height: 100vh;
  overflow: hidden;
  background: var(--bgc, #0b0b0e);
  transition: background-color 0.3s var(--ease-in-out);
}

.reader-stage {
  display: contents;
}

.reader-drag {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 16px;
  z-index: 299;
}
</style>
