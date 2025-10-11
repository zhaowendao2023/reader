<script setup>
const props = defineProps({
  id: String, // 图标名称（对应文件名）
  size: { type: [Number, String], default: 24 },
  fill: { type: String, default: "--icon-fill" },
});
</script>

<template>
  <svg class="icon" aria-hidden="true" :style="`fill: ${fill}`">
    <use :xlink:href="`#${id}`"></use>
  </svg>
</template>

<style></style>
