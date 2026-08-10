<script setup>
import { useBooks } from "../store/loadBooks";
import MobiReading from "./MobiReading.vue";

const booksStore = useBooks();
const containerRef = ref(null);
const route = useRoute();
const show = ref(false);
provide(
  "index",
  ref({
    nowIndex: 0,
    total: 0,
  })
);
provide("toces", ref([]));
provide("show", show);
const bookInfo = ref(null);
onBeforeMount(() => {
  const book = booksStore.getBook(route.params.id);
  bookInfo.value = book;
  console.log("path", book);
});

provide("bookInfo", bookInfo);
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
};
provide("moveMethods", moveMethods);
</script>

<template>
  <div class="reader-root">
    <TopDrawer />
    <div class="reader-stage" @click="boxShow">
      <ComicReading
        v-if="bookInfo.ext.endsWith('cbz') || bookInfo.ext.endsWith('zip')"
        ref="containerRef"
      />
      <EpubReading v-else-if="bookInfo.ext.endsWith('epub')" ref="containerRef" />
      <MobiReading v-else-if="bookInfo.ext.endsWith('mobi')" ref="containerRef" />
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
</style>
