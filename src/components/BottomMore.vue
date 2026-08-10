<script setup>
import { useBooks } from "../store/loadBooks";
import Icon from "./Icon.vue";
const booksStore = useBooks();
const cssVars = booksStore.cssVarsData;
defineProps({
  height: String,
});

watch(
  cssVars,
  () => {
    booksStore.setCss();
  },
  { deep: true }
);

const rows = computed(() => [
  { label: "字号", value: cssVars.fontSize, unit: "px", min: 12, max: 28, step: 1, key: "fontSize" },
  { label: "段距", value: cssVars.marginBottom, unit: "em", min: 0.5, max: 3, step: 0.1, key: "marginBottom" },
  { label: "字距", value: cssVars.letterSpacing, unit: "px", min: 0, max: 6, step: 1, key: "letterSpacing" },
  { label: "行高", value: cssVars.lineHeight, unit: "", min: 1.2, max: 2.4, step: 0.1, key: "lineHeight" },
]);

const dec = (row) => {
  const v = cssVars[row.key];
  cssVars[row.key] = Math.max(row.min, +(v - row.step).toFixed(2));
};
const inc = (row) => {
  const v = cssVars[row.key];
  cssVars[row.key] = Math.min(row.max, +(v + row.step).toFixed(2));
};
const fmt = (v) => (Number.isInteger(v) ? v : v.toFixed(1));
</script>

<template>
  <div class="type-grid">
    <div v-for="row in rows" :key="row.key" class="type-cell">
      <div class="type-label">{{ row.label }}</div>
      <div class="type-ctrl">
        <button class="step-btn" @click="dec(row)"><Icon id="minus" :size="14" /></button>
        <div class="type-val mono">{{ fmt(row.value) }}<i>{{ row.unit }}</i></div>
        <button class="step-btn" @click="inc(row)"><Icon id="plus" :size="14" /></button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.type-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.type-cell {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: color-mix(in srgb, var(--bg-1) 50%, transparent);
}

.type-label {
  font-size: 12px;
  color: var(--text-2);
  letter-spacing: 0.08em;
}

.type-ctrl {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.step-btn {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  transition: all 0.2s;
  flex-shrink: 0;

  &:hover {
    color: var(--accent);
    border-color: var(--accent);
  }
}

.type-val {
  font-size: 14px;
  color: var(--text-1);
  font-weight: 600;
  text-align: center;
  min-width: 56px;

  i {
    font-style: normal;
    font-size: 10px;
    color: var(--text-3);
    margin-left: 3px;
    font-weight: 400;
  }
}
</style>
