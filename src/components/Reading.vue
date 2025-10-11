<script setup>
import { useBooks } from "../store/loadBooks";

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
  console.log("path", book.path);
});

provide("bookInfo", bookInfo);
const boxShow = (e) => {
  const x = e.clientX; // 点击的 X 坐标
  const y = e.clientY; // 点击的 Y 坐标
  // 定义中间区域（示例：屏幕宽度的 60% 居中，高度的 80% 居中）
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
  <div class="img-container" style="background-color: --n-color">
    <TopDrawer />
    <n-el
      tag="body"
      style="
        color: var(--color) !important;
        background-color: var(--bgc);
        transition: 0.3s var(--cubic-bezier-ease-in-out);
      "
    >
      <ComicReading
        v-if="bookInfo.ext.endsWith('cbz') || bookInfo.ext.endsWith('zip')"
        ref="containerRef"
        @click="boxShow"
      />
      <EpubReading
        v-else-if="bookInfo.ext.endsWith('epub')"
        ref="containerRef"
        @click="boxShow"
      />
    </n-el>
    <BottomDrawer />
  </div>
</template>

<style scoped>
.img-container {
  display: flex;
  flex-direction: column;
}
</style>
