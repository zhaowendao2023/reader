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
    <ContextMenu />
    <TagEditor />
  </div>
</template>
<script setup>
import { useBooks } from "./store/loadBooks";
import { useSettings } from "./store/settings";
import { darkTheme } from "naive-ui";
import { invoke } from "@tauri-apps/api/core";
import router from "./router";
import { getBookInfo, ensureCoverCache, cleanupLegacyCoverCache } from "./utils/bookData";
import { calculateHash } from "./utils/utils";
import { openGenericMenu } from "./utils/contextMenu";
import { syncSystemUiTheme } from "./utils/systemBar";
import ContextMenu from "./components/ContextMenu.vue";
import TagEditor from "./components/TagEditor.vue";

const booksStore = useBooks();
const settings = useSettings();
const theme = ref({});

// 全局拦截系统右键/长按菜单：卡片上已由 Home 打开条目菜单并 stopPropagation，
// 其余区域一律改为自定义通用菜单。
const onGlobalContextMenu = (e) => {
  e.preventDefault();
  openGenericMenu(e.clientX, e.clientY);
};

onMounted(() => {
  document.addEventListener("contextmenu", onGlobalContextMenu);
});

onBeforeUnmount(() => {
  document.removeEventListener("contextmenu", onGlobalContextMenu);
});

// 同步主题类到 <html>，确保 body 及全局变量正确切换
watch(
  () => booksStore.theme,
  (v) => {
    document.documentElement.classList.toggle("theme-dark", !v);
    document.documentElement.classList.toggle("theme-light", !!v);
    // 系统栏图标颜色随主题明暗切换（授予透明系统栏）
    syncSystemUiTheme(!v);
  },
  { immediate: true }
);

onBeforeMount(async () => {
  // 先恢复持久化设置（侧栏/图包视图等），再加载库数据
  await settings.load();
  await booksStore.loadData();
  theme.value = await getTheme();
  await start();
  console.log("环境变量平台:", booksStore.platform);
  await autoOpenTestFile();
});

async function start() {
  await cleanupLegacyCoverCache();
  await ensureCoverCache();
  console.log("cover cache initialized");
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
    const bookInfo = await getBookInfo(testPath);
    const name = testPath.split(/[\\/]/).filter(Boolean).pop() || testPath;
    await router.push({ path: `/reading/${id}`, query: { path: testPath, name, ext: bookInfo.ext } });
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
  /* 深色主题压暗封面：保留静态透明度，避免主题切换时所有封面同时做淡入淡出。 */
  opacity: v-bind("booksStore.theme ? '1' : '0.86'");
}
</style>
