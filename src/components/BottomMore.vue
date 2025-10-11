<script setup>
import { useBooks } from "../store/loadBooks";
const booksStore = useBooks();
const cssVars = booksStore.cssVarsData;
defineProps({
  height: String,
});

watch(
  cssVars,
  () => {
    console.log(11);

    booksStore.setCss();
  },
  { deep: true }
);
</script>

<template>
  <div :style="`height: ${height}`">
    <div>
      字号
      <n-button @click="cssVars.fontSize--">-</n-button> {{ cssVars.fontSize }}
      <n-button @click="cssVars.fontSize++">+</n-button>
    </div>
    <div>
      段距
      <n-button
        @click="cssVars.marginBottom = (cssVars.marginBottom * 10 - 1) / 10"
        >-</n-button
      >
      {{ cssVars.marginBottom }}
      <n-button
        @click="cssVars.marginBottom = (cssVars.marginBottom * 10 + 1) / 10"
        >+</n-button
      >
    </div>
    <div>
      字距
      <n-button @click="cssVars.letterSpacing--">-</n-button>
      {{ cssVars.letterSpacing }}
      <n-button @click="cssVars.letterSpacing++">+</n-button>
    </div>
    <div>
      行高
      <n-button @click="cssVars.lineHeight = (cssVars.lineHeight * 10 - 1) / 10"
        >-</n-button
      >
      {{ cssVars.lineHeight }}
      <n-button @click="cssVars.lineHeight = (cssVars.lineHeight * 10 + 1) / 10"
        >+</n-button
      >
    </div>
  </div>
</template>

<style scoped lang="scss"></style>
