<script setup>
const index = inject("index");
const toces = inject("toces");
const containerRef = ref(null);
const images = ref([]);

const bookInfo = inject("bookInfo");
const loadComic = async (archivePath) => {
  try {
    const book = await getComic(archivePath);
    images.value = book.images;
    index.value.total = images.value.length;
    toces.value = book.toces;
  } catch (error) {
    console.error("解压失败:", error);
  }
};
onMounted(async () => {
  await loadComic(bookInfo.value.path);
  const container = containerRef.value;
  const visibilityMap = new Map();
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const key = parseInt(entry.target.dataset.key);

        const prevVisible = visibilityMap.get(key) || false;
        if (entry.isIntersecting) {
          if (!prevVisible) {
            visibilityMap.set(key, true);
            if (!visibilityMap.get(key - 1)) {
              index.value.nowIndex = key;
            }
          }
        } else {
          if (prevVisible) {
            visibilityMap.set(key, false);
            if (visibilityMap.get(key + 1)) {
              index.value.nowIndex = key + 1;
            }
          }
        }
      });
    },
    {
      threshold: 0.1, // 当元素可见比例 <10% 时触发
    }
  );
  Array.from(container.children).forEach((child) => observer.observe(child));
});
// 释放 Blob URL（避免内存泄漏）
onUnmounted(() => {
  images.value.forEach((url) => URL.revokeObjectURL(url));
});

const left = () => {
  const i = index.value.nowIndex - 1;
  jump(i);
};
const right = () => {
  const i = index.value.nowIndex + 1;
  jump(i);
};

const jump = (id) => {
  containerRef.value.children[id]?.scrollIntoView({ behavior: "smooth" });
  index.value.nowIndex = id;
};
defineExpose({
  left,
  right,
  jump,
});
</script>

<template>
  <div ref="containerRef" class="img-list" @click="boxShow">
    <img
      v-for="(image, index) in images"
      :key="image.name"
      :src="image.image"
      :data-key="index"
    />
  </div>
</template>

<style scoped lang="scss">
.img-list {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow-y: auto;
  scrollbar-width: none;
}
</style>
