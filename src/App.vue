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

const booksStore = useBooks();
const theme = ref({});

onBeforeMount(async () => {
  await booksStore.loadData();
  theme.value = await getTheme();
  console.log("环境变量平台:", booksStore.platform);
});
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
