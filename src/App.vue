<template>
  <div class="app">
    <n-config-provider
      :theme="booksStore.theme ? null : darkTheme"
      :theme-overrides="booksStore.theme ? theme.light : theme.dark"
    >
      <n-notification-provider>
        <RouterView />
      </n-notification-provider>
    </n-config-provider>
  </div>
</template>
<script setup>
import { useBooks } from "./store/loadBooks";
import { darkTheme } from "naive-ui";
import {exists, mkdir} from "@tauri-apps/plugin-fs";

const booksStore = useBooks();
const theme = ref({});

onBeforeMount(async () => {
  await booksStore.loadData();
  theme.value = await getTheme();
  await start()
  console.log("环境变量平台:", booksStore.platform);
});

async function start() {
  const has = await exists("resource/data", {
    baseDir: useBooks().baseSrc
  });

  if (!has) {
    const reHas = await exists("resource", {
      baseDir: useBooks().baseSrc
    });
    if (!reHas) {
      await mkdir('resource', {
        baseDir: useBooks().baseSrc
      })
    }
    await mkdir('resource/data', {
      baseDir: useBooks().baseSrc
    })
  }
  console.log('startCreatePath');
}
</script>

<style scoped>
/* 全局样式重置 */
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen",
    "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue",
    "TangHan", sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

:deep(img) {
  filter: v-bind("`brightness(${booksStore.theme? 100: 70}%)`");
}
</style>
