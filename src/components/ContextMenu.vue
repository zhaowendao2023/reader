<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  cancelConfirm,
  closeContextMenu,
  contextMenuState,
} from "../utils/contextMenu";
import Icon from "./Icon.vue";

const MARGIN = 8;
const menuRef = ref(null);
const pos = ref({ x: 0, y: 0 });

const layout = async () => {
  await nextTick();
  const el = menuRef.value;
  if (!el) return;
  let x = contextMenuState.x;
  let y = contextMenuState.y;
  const rect = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (x + rect.width > vw - MARGIN) x = Math.max(MARGIN, vw - rect.width - MARGIN);
  if (y + rect.height > vh - MARGIN) y = Math.max(MARGIN, vh - rect.height - MARGIN);
  pos.value = { x: Math.round(x), y: Math.round(y) };
};

watch(
  () => ({
    visible: contextMenuState.visible,
    items: contextMenuState.items,
    confirming: contextMenuState.confirming,
    busy: contextMenuState.busy,
    error: contextMenuState.error,
  }),
  () => {
    if (contextMenuState.visible) {
      pos.value = { x: contextMenuState.x, y: contextMenuState.y };
      layout();
    }
  }
);

const onPointerDown = (e) => {
  if (!contextMenuState.visible) return;
  if (menuRef.value && menuRef.value.contains(e.target)) return;
  closeContextMenu();
};

const onKeydown = (e) => {
  if (e.key === "Escape") closeContextMenu();
};

const onScrollCapture = () => {
  if (contextMenuState.visible) closeContextMenu();
};

const onWindowBlur = () => {
  closeContextMenu();
};

const onResize = () => {
  if (contextMenuState.visible) layout();
};

onMounted(() => {
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeydown, true);
  document.addEventListener("scroll", onScrollCapture, true);
  window.addEventListener("blur", onWindowBlur);
  window.addEventListener("resize", onResize);
  if (contextMenuState.visible) layout();
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onPointerDown, true);
  document.removeEventListener("keydown", onKeydown, true);
  document.removeEventListener("scroll", onScrollCapture, true);
  window.removeEventListener("blur", onWindowBlur);
  window.removeEventListener("resize", onResize);
});

const onItemSelect = (item) => {
  if (contextMenuState.busy) return;
  item.onSelect?.();
};

const onConfirm = async () => {
  const confirm = contextMenuState.confirming;
  if (!confirm || contextMenuState.busy) return;
  await confirm.onConfirm?.();
};
</script>

<template>
  <Teleport to="body">
    <div
      v-if="contextMenuState.visible"
      ref="menuRef"
      class="ctx-menu"
      :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
      role="menu"
    >
      <div v-if="contextMenuState.confirming" class="ctx-confirm">
        <div class="ctx-confirm-title">{{ contextMenuState.confirming.label }}</div>
        <p class="ctx-confirm-msg">{{ contextMenuState.confirming.message }}</p>
        <div v-if="contextMenuState.error" class="ctx-error">{{ contextMenuState.error }}</div>
        <div class="ctx-confirm-actions">
          <button class="ctx-btn" :disabled="contextMenuState.busy" @click="cancelConfirm">
            取消
          </button>
          <button
            class="ctx-btn ctx-btn--danger"
            :disabled="contextMenuState.busy"
            @click="onConfirm"
          >
            {{ contextMenuState.busy ? "处理中…" : contextMenuState.confirming.confirmLabel }}
          </button>
        </div>
      </div>

      <template v-else>
        <button
          v-for="item in contextMenuState.items"
          :key="item.id"
          class="ctx-item"
          :class="{ 'ctx-item--danger': item.danger }"
          role="menuitem"
          @click="onItemSelect(item)"
        >
          <Icon v-if="item.icon" :id="item.icon" :size="16" :stroke-width="1.8" />
          <span class="ctx-label">{{ item.label }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped lang="scss">
.ctx-menu {
  position: fixed;
  z-index: 10000;
  min-width: 210px;
  max-width: min(300px, calc(100vw - 16px));
  padding: 6px;
  background: var(--panel-solid);
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  box-shadow: var(--shadow-2);
  animation: ctx-pop 0.14s ease-out;
  user-select: none;
  -webkit-user-select: none;
}

.ctx-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  padding: 9px 12px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--text-1);
  font-size: 14px;
  font-family: inherit;
  line-height: 1.4;
  text-align: left;
  cursor: pointer;

  &:hover {
    background: var(--bg-3);
  }

  &:active {
    background: var(--accent-soft);
  }

  &--danger {
    color: var(--accent);
  }

  &--danger:hover {
    background: var(--accent-soft);
  }
}

.ctx-confirm {
  padding: 10px 12px 12px;
}

.ctx-confirm-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
  margin-bottom: 6px;
}

.ctx-confirm-msg {
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-2);
  margin-bottom: 12px;
}

.ctx-error {
  font-size: 12px;
  line-height: 1.4;
  color: var(--accent);
  margin-bottom: 10px;
}

.ctx-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.ctx-btn {
  min-height: 40px;
  padding: 0 16px;
  border-radius: 10px;
  border: 1px solid var(--line-strong);
  background: var(--bg-2);
  color: var(--text-1);
  font-size: 14px;
  font-family: inherit;
  cursor: pointer;

  &--danger {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }

  &:disabled {
    opacity: 0.55;
    cursor: default;
  }
}

@keyframes ctx-pop {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
</style>
