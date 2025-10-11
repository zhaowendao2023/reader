<script setup>
import { open } from "@tauri-apps/plugin-dialog";
import { useBooks } from "../store/loadBooks";
import { useNotification } from "naive-ui";
import { Window } from "@tauri-apps/api/window";
import { readDir } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";

const appWindow = new Window("main");

const booksStore = useBooks();
const notification = useNotification();
// 添加本地文件
const handleAddFile = async () => {
  try {
    const selected = await open({
      multiple: true,
      filters: [
        {
          name: "book Files",
          extensions: ["zip", "cbz", "epub"],
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
        meta: title,
        duration: 2500,
        keepAliveOnHover: true,
      });
      continue;
    }
    const bookInfo = await getBookInfo(file.path);

    newBooks[id] = {
      title: bookInfo.title,
      path: file.path,
      cover: bookInfo.coverPath,
      ext: bookInfo.ext,
    };
    notification["success"]({
      content: "书籍添加成功",
      meta: bookInfo.title,
      duration: 2000,
      keepAliveOnHover: true,
    });
  }
  console.log(
    `excuteFiles普通部分函数执行耗时: ${(performance.now() - startTime).toFixed(
      3
    )} 毫秒`
  ); // 保留3位小数
  await booksStore.addBook(newBooks);
  const endTime = performance.now();
  const executionTime = endTime - startTime;
  console.log(`excuteFiles函数执行耗时: ${executionTime.toFixed(3)} 毫秒`); // 保留3位小数
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
      (name.endsWith("cbz") || name.endsWith("zip") || name.endsWith("epub"))
    ) {
      files.push({
        path: `${selected}\\${name}`,
      });
      i++;
    }
    if (i === 9) {
      i = 0;
      await excuteFiles(files);
      files = [];
    }
  }
  await excuteFiles(files);
};

const handleSelectClick = async () => {
  try {
    // 调用我们在 Rust 中定义的命令 ‘pick_file’
    const fileContent = await invoke("pick_file");
    await excuteFiles([
      {
        path: fileContent,
      },
    ]);
  } catch (error) {
    // 捕获错误（例如用户取消选择或读取文件失败）
    console.error("操作失败:", error);
    alert(`错误: ${error}`);
  }
};

const options = [
  {
    label: "添加文件",
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
    props: {
      onClick: async () => {
        await selectDirectory();
      },
    },
  },
  {
    label: "清空文件",
    props: {
      onClick: async () => {
        await handleClearAll();
      },
    },
  },
];
</script>

<template>
  <n-affix
    :top="0"
    :trigger-top="40"
    style="width: -webkit-fill-available; z-index: 2"
  >
    <div class="header">
      <n-input round placeholder="搜索" style="width: 50%; height: 40px">
        <template #suffix>
          <n-icon :size="18">
            <Icon id="icon-sousuo" />
          </n-icon>
        </template>
      </n-input>
      <div
        style="
          width: 50%;
          height: 100%;
          display: flex;
          justify-content: flex-end;
        "
      >
        <div
          v-if="booksStore.platform === 'windows'"
          style="width: -webkit-fill-available; height: 100%"
          @mousedown="appWindow.startDragging"
        ></div>

        <div
          style="width: auto; height: 100%; display: flex; align-items: center"
        >
          <n-button
            quaternary
            circle
            @click="async () => await booksStore.changeTheme()"
          >
            <n-icon :size="25">
              <Icon
                :id="booksStore.theme ? 'icon-cubanrijian' : 'icon-yejianmoshi'"
              />
            </n-icon>
          </n-button>
          <n-button quaternary circle>
            <n-dropdown trigger="click" :options="options" size="large">
              <n-icon :size="25">
                <Icon id="icon-androidgengduo" />
              </n-icon>
            </n-dropdown>
          </n-button>
          <n-button
            v-if="booksStore.platform === 'windows'"
            quaternary
            circle
            @click="appWindow.close()"
          >
            <n-icon :size="25">
              <Icon id="icon-dengluzhuceguanbi" />
            </n-icon>
          </n-button>
        </div>
      </div>
    </div>
  </n-affix>
</template>

<style scoped>
.header {
  height: 55px;
  width: auto;
  display: flex;
  justify-content: space-between;
  padding: 0 0 0px 16px;
  align-items: center;
}

:deep(.n-button) {
  margin: 0 6px;
}
</style>
