<script setup>
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useBooks } from "../store/loadBooks";
import Icon from "./Icon.vue";
import { NIcon } from "naive-ui";

const booksStore = useBooks();
const books = computed(() => booksStore.books);
const router = useRouter();
const goToReader = async (id) => {
  try {
    await router.push(`/reading/${id}`); // 使用 await 等待 Promise 完成
  } catch (err) {
    console.error("路由跳转失败:", err);
  }
};

const deleteBook = async (id) => {
  await deleteFileData(id);
  if (booksStore.platform === "android") {
    await invoke("clear_url", { url: books.value[id].path });
  }
  await booksStore.deleteBook(id);
};

const renderLabel = (option) => {
  return [
    h(
      NIcon,
      {
        style: {
          verticalAlign: "-0.15em",
          marginRight: "4px",
        },
      },
      {
        default: () =>
          h(Icon, {
            id: option.value,
          }),
      }
    ),
    option.label,
  ];
};
const renderOption = ({ node, option }) => {
  return h(node, {
    onClick: () => {
      option.onClick(option.bookId);
    },
  });
};
</script>

<template>
  <ul class="list">
    <li v-for="(book, id) in books" :key="id" class="comic-cover">
      <div class="img">
        <img @click="goToReader(id)" :src="convertFileSrc(book.cover)" />
      </div>
      <div class="bottom">
        <n-ellipsis style="max-width: 160px">
          {{ book.title }}
        </n-ellipsis>

        <n-popselect
          trigger="click"
          :options="[
            {
              label: '删除',
              value: 'icon-delete-line',
              bookId: id,
              onClick: deleteBook,
            },
          ]"
          :render-label="renderLabel"
          :render-option="renderOption"
        >
          <n-icon :size="18">
            <Icon id="icon-androidgengduo" />
          </n-icon>
        </n-popselect>
      </div>
    </li>
  </ul>
  <n-back-top :right="10" />
</template>

<style scoped>
.list {
  display: flex;
  flex-wrap: wrap;
  overflow-y: auto;
  padding-top: 50px;
  padding-left: 0;
  scrollbar-width: none;
}

li {
  list-style: none;
  margin: 10px 0;
}

.img {
  aspect-ratio: 1 / 1.414;
  width: 80%;
  overflow: hidden; /* 隐藏超出部分 */
  position: relative;
}

img {
  width: 100%;
  height: 100%;
  object-fit: cover; /* 关键属性：保持比例裁剪 */
  object-position: center; /* 可选：居中显示裁剪区域 */
  cursor: pointer;
}

.comic-cover {
  width: 20%;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.bottom {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 80%;
  flex-direction: row;
}
</style>
