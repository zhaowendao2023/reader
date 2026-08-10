<template>
  <div class="app" :class="booksStore.theme ? 'theme-light' : 'theme-dark'">
    <n-config-provider
      :theme="booksStore.theme ? null : darkTheme"
      :theme-overrides="booksStore.theme ? theme.light : theme.dark"
    >
      <n-notification-provider>
        <RouterView v-slot="{ Component }">
          <keep-alive :include="['LayOut']">
            <component :is="Component" />
          </keep-alive>
        </RouterView>
      </n-notification-provider>
    </n-config-provider>
  </div>
</template>
<script setup>
import { useBooks } from "./store/loadBooks";
import { darkTheme } from "naive-ui";
import { exists, mkdir } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import router from "./router";
import { getBookInfo } from "./utils/bookData";
import { calculateHash } from "./utils/utils";

const booksStore = useBooks();
const theme = ref({});

// 同步主题类到 <html>，确保 body 及全局变量正确切换
watch(
  () => booksStore.theme,
  (v) => {
    document.documentElement.classList.toggle("theme-dark", !v);
    document.documentElement.classList.toggle("theme-light", !!v);
  },
  { immediate: true }
);

onBeforeMount(async () => {
  await booksStore.loadData();
  theme.value = await getTheme();
  await start();
  console.log("环境变量平台:", booksStore.platform);
  await autoOpenTestFile();
});

async function start() {
  const has = await exists("resource/data", {
    baseDir: useBooks().baseSrc,
  });

  if (!has) {
    const reHas = await exists("resource", {
      baseDir: useBooks().baseSrc,
    });
    if (!reHas) {
      await mkdir("resource", {
        baseDir: useBooks().baseSrc,
      });
    }
    await mkdir("resource/data", {
      baseDir: useBooks().baseSrc,
    });
  }
  console.log("startCreatePath");
}

async function autoOpenTestFile() {
  let testPath = null;
  try {
    testPath = await invoke("get_test_file");
  } catch (error) {
    console.error("获取测试文件失败:", error);
    return;
  }
  if (!testPath) return;

  try {
    const id = await calculateHash(testPath);
    if (!booksStore.getBook(id)) {
      const bookInfo = await getBookInfo(testPath);
      await booksStore.addBook({
        [id]: {
          title: bookInfo.title,
          path: testPath,
          ext: bookInfo.ext,
        },
      });
    }
    await router.push(`/reading/${id}`);
  } catch (error) {
    console.error("自动测试打开失败:", error);
  }
}
</script>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

:deep(img) {
  filter: v-bind("booksStore.theme ? 'brightness(1)' : 'brightness(0.86)'");
}
</style>
