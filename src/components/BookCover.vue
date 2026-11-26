/**
 * 书籍（漫画/电子书）封面卡。
 *
 * 四个页面（Home / 收藏 / 搜索 / 标签）各自复制过同一段「封面 + 占位图标 +
 * 格式/来源角标」模板与样式；样式统一放在 global.css，本组件只负责结构。
 * 属性（data-key / data-kind）会透传到根节点，供封面观察器与右键菜单寻址。
 */
<script setup>
import Icon from "./Icon.vue";

defineOptions({ name: "BookCover" });

defineProps({
  src: { type: String, default: "" },
  ext: { type: String, default: "" },
  folder: { type: String, default: "" },
  // 是否显示角标（格式后缀 + 所属收藏文件夹）
  meta: { type: Boolean, default: true },
});
</script>

<template>
  <div class="book-cover">
    <img v-if="src" :src="src" class="book-cover-img" alt="" loading="lazy" decoding="async" />
    <span v-else class="book-cover-ph"><Icon id="book-open" :size="34" /></span>
    <template v-if="meta">
      <span class="book-ext mono">{{ String(ext).toUpperCase() }}</span>
      <span v-if="folder" class="book-folder mono">{{ folder }}</span>
    </template>
  </div>
</template>
