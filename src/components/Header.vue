<script setup>
import { open } from "@tauri-apps/plugin-dialog";
import { useBooks } from "../store/loadBooks";
import { useUI } from "../store/ui";
import { useNotification } from "naive-ui";
import { Window } from "@tauri-apps/api/window";
import { readDir } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import Icon from "./Icon.vue";

const appWindow = new Window("main");

const booksStore = useBooks();
const ui = useUI();
const notification = useNotification();
const isWindows = computed(() => booksStore.platform === "windows");
const themeIcon = computed(() => (booksStore.theme ? "sun" : "moon"));

const renderIcon = (id) => () => h(Icon, { id, size: 15 });

// 添加本地文件
const handleAddFile = async () => {
  try {
    const selected = await open({
      multiple: true,
      filters: [
        {
          name: "book Files",
          extensions: ["zip", "cbz", "epub", "mobi"],
        },
      ],
    });
    if (!selected || selected.length === 0) return;
    const files = selected.map((path) => ({ path }));
    await excuteFiles(files);
  } catch (error) {
    console.error("文件选择失败:", error);
  }
};

const excuteFiles = async (files) => {
  const startTime = performance.now();
  const books = booksStore.books;
  const newBooks = {};
  for (const file of files) {
    const id = await calculateHash(file.path);

    if (books[id]) {
      notification["warning"]({
        content: "书籍已存在",
        duration: 2500,
        keepAliveOnHover: true,
      });
      continue;
    }
    const bookInfo = await getBookInfo(file.path);

    newBooks[id] = {
      title: bookInfo.title,
      path: file.path,
      ext: bookInfo.ext,
    };
    notification["success"]({
      content: "书籍添加成功",
      meta: bookInfo.title,
      duration: 2000,
      keepAliveOnHover: true,
    });
  }
  console.log(`excuteFiles函数执行耗时: ${(performance.now() - startTime).toFixed(3)} 毫秒`);
  await booksStore.addBook(newBooks);
};

const handleClearAll = async () => {
  try {
    if (booksStore.platform === "android") {
      await invoke("clear_all_url");
    }
    await clearLoadDate();
    booksStore.clearAll();
    console.log("clear");
  } catch (error) {
    console.error("清除漫画列表失败:", error);
  }
};

const selectDirectory = async () => {
  const selected = await open({
    multiple: false,
    directory: true,
  });
  const entries = await readDir(selected);

  let files = [];
  let i = 0;
  for (const entry of entries) {
    const name = entry.name;
    if (
      entry.isFile &&
      (name.toLowerCase().endsWith("cbz") ||
        name.toLowerCase().endsWith("zip") ||
        name.toLowerCase().endsWith("epub"))
    ) {
      files.push({
        path: `${selected}\\${name}`,
      });
      i++;
    }
    if (i === 5) {
      i = 0;
      await excuteFiles(files);
      files = [];
    }
  }
  await excuteFiles(files);
};

const handleSelectClick = async () => {
  try {
    const fileContent = await invoke("pick_file");
    await excuteFiles([{ path: fileContent }]);
  } catch (error) {
    console.error("操作失败:", error);
    alert(`错误: ${error}`);
  }
};

const options = computed(() => [
  {
    label: "添加文件",
    icon: renderIcon("file-plus"),
    props: {
      onClick: async () => {
        booksStore.platform === "android"
          ? await handleSelectClick()
          : await handleAddFile();
      },
    },
  },
  {
    label: "添加文件夹",
    icon: renderIcon("folder-plus"),
    props: {
      onClick: async () => {
        await selectDirectory();
      },
    },
  },
  {
    label: "清空文件",
    icon: renderIcon("trash-2"),
    props: {
      onClick: async () => {
        await handleClearAll();
      },
    },
  },
]);
</script>

<template>
  <div class="topbar-wrap">
    <header class="topbar glass">
      <div class="tb-left">
        <button class="tb-btn" title="切换侧栏" @click="ui.toggleSider()">
          <Icon :id="ui.siderCollapsed ? 'panel-left-open' : 'panel-left-close'" :size="19" />
        </button>
        <div class="tb-search">
          <Icon id="search" :size="16" class="tb-search-ico" />
          <input class="tb-search-input" placeholder="搜索书架与文件" spellcheck="false" />
          <span class="tb-search-key mono">/</span>
        </div>
      </div>

      <div class="tb-right">
        <div v-if="isWindows" class="drag-region" @mousedown="appWindow.startDragging"></div>
        <button class="tb-btn" title="切换外观" @click="booksStore.changeTheme()">
          <Icon :id="themeIcon" :size="19" />
        </button>
        <n-dropdown trigger="click" :options="options" size="large">
          <button class="tb-btn" title="更多操作">
            <Icon id="more-horizontal" :size="19" />
          </button>
        </n-dropdown>
        <button v-if="isWindows" class="tb-btn tb-close" title="关闭" @click="appWindow.close()">
          <Icon id="x" :size="18" />
        </button>
      </div>
    </header>
  </div>
</template>

<style scoped lang="scss">
.topbar-wrap {
  position: absolute;
  top: 14px;
  left: 18px;
  right: 18px;
  z-index: 30;
  pointer-events: none;
}

.topbar {
  pointer-events: auto;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 10px 0 8px;
  border-radius: 16px;
  box-shadow: var(--shadow-1);
}

.tb-left,
.tb-right {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 100%;
}

.tb-btn {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border: none;
  background: transparent;
  color: var(--text-2);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.25s var(--ease-out);

  &:hover {
    background: color-mix(in srgb, var(--text-1) 8%, transparent);
    color: var(--text-1);
    transform: translateY(-1px);
  }

  &.tb-close:hover {
    background: rgba(229, 72, 77, 0.14);
    color: #ff5c4d;
  }
}

.tb-search {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  width: min(320px, 30vw);
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: color-mix(in srgb, var(--bg-1) 55%, transparent);
  transition: border-color 0.25s, box-shadow 0.25s;

  &:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
}

.tb-search-ico {
  color: var(--text-3);
  flex-shrink: 0;
}

.tb-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-1);
  font-size: 13.5px;
  font-family: inherit;

  &::placeholder {
    color: var(--text-3);
  }
}

.tb-search-key {
  font-size: 11px;
  color: var(--text-3);
  padding: 1px 7px;
  border: 1px solid var(--line);
  border-radius: 6px;
}

.drag-region {
  flex: 1;
  min-width: 40px;
  height: 100%;
}
</style>
