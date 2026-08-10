<script setup>
import { Window } from "@tauri-apps/api/window";
import { useRouter } from "vue-router";
import { useBooks } from "../store/loadBooks";
import Icon from "./Icon.vue";

const appWindow = new Window("main");
const index = inject("index");
const show = inject("show");
const bookInfo = inject("bookInfo");
const now = computed(() => index.value.nowIndex + 1);
const router = useRouter();
const route = useRoute();
const showModal = ref(false);
const booksStore = useBooks();
const cssVars = booksStore.cssVarsData;

// 排版设置仅对文本类（epub/mobi）生效
const isTextBook = computed(() =>
  bookInfo.value &&
  (bookInfo.value.ext.endsWith("epub") || bookInfo.value.ext.endsWith("mobi"))
);

const saveCss = () => booksStore.setCss();

const quit = async () => {
  try {
    const from = route.query.from;
    if (typeof from === "string" && from) {
      await router.push({ path: "/browse", query: { path: from } });
    } else {
      await router.push(`/`);
    }
  } catch (err) {
    console.error("路由跳转失败:", err);
  }
};
</script>

<template>
  <transition name="bar">
    <header v-if="show" class="reader-bar top glass">
      <button class="bar-ico" title="返回" @click="quit">
        <Icon id="arrow-left" :size="19" />
      </button>
      <div class="bar-title">
        <n-ellipsis :tooltip="false">{{ bookInfo.title }}</n-ellipsis>
      </div>
      <div class="bar-drag" @mousedown="appWindow.startDragging"></div>
      <div class="bar-page mono">{{ String(now).padStart(2, "0") }}<i>/</i>{{ index.total }}</div>
      <button class="bar-ico" title="阅读设置" @click="showModal = true">
        <Icon id="sliders-horizontal" :size="19" />
      </button>
    </header>
  </transition>

  <transition name="fade">
    <div v-if="showModal" class="settings-mask" @click="showModal = false">
      <section class="settings-panel glass" @click.stop>
        <div class="settings-head">
          <div>
            <div class="kicker">READER SETTINGS</div>
            <h3 class="settings-title">阅读设置</h3>
          </div>
          <button class="settings-close" @click="showModal = false">
            <Icon id="x" :size="17" />
          </button>
        </div>

        <template v-if="isTextBook">
          <div class="set-row">
            <div class="set-info"><span class="set-name">字号</span><span class="set-val mono">{{ cssVars.fontSize }} px</span></div>
            <n-slider v-model:value="cssVars.fontSize" :min="12" :max="28" :step="1" @update:value="saveCss" />
          </div>
          <div class="set-row">
            <div class="set-info"><span class="set-name">段距</span><span class="set-val mono">{{ cssVars.marginBottom }} em</span></div>
            <n-slider v-model:value="cssVars.marginBottom" :min="0.5" :max="3" :step="0.1" @update:value="saveCss" />
          </div>
          <div class="set-row">
            <div class="set-info"><span class="set-name">字距</span><span class="set-val mono">{{ cssVars.letterSpacing }} px</span></div>
            <n-slider v-model:value="cssVars.letterSpacing" :min="0" :max="6" :step="1" @update:value="saveCss" />
          </div>
          <div class="set-row">
            <div class="set-info"><span class="set-name">行高</span><span class="set-val mono">{{ cssVars.lineHeight }}</span></div>
            <n-slider v-model:value="cssVars.lineHeight" :min="1.2" :max="2.4" :step="0.1" @update:value="saveCss" />
          </div>
        </template>
        <div v-else class="set-note">
          <Icon id="info" :size="18" />
          <span>排版设置仅对 EPUB / MOBI 文本书籍生效</span>
        </div>

        <div class="settings-foot">
          <button class="set-btn" @click="booksStore.changeTheme()">
            <Icon :id="booksStore.theme ? 'sun' : 'moon'" :size="16" />
            <span>{{ booksStore.theme ? '浅色' : '深色' }}模式</span>
          </button>
        </div>
      </section>
    </div>
  </transition>
</template>

<style scoped lang="scss">
/* 顶部悬浮条 */
.reader-bar {
  position: fixed;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 300;
  display: flex;
  align-items: center;
  gap: 10px;
  width: min(760px, calc(100vw - 40px));
  height: 54px;
  padding: 0 8px 0 10px;
  border-radius: 16px;
  box-shadow: var(--shadow-2);

  &.top {
    top: 14px;
  }
}

.bar-ico {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border: none;
  background: transparent;
  color: var(--text-2);
  border-radius: 11px;
  cursor: pointer;
  transition: all 0.22s var(--ease-out);
  flex-shrink: 0;

  &:hover {
    background: color-mix(in srgb, var(--text-1) 8%, transparent);
    color: var(--text-1);
  }
}

.bar-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
  min-width: 0;
  max-width: 300px;
  overflow: hidden;
}

.bar-drag {
  flex: 1;
  height: 100%;
  min-width: 40px;
}

.bar-page {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  font-size: 11px;
  letter-spacing: 0.14em;
  color: var(--text-2);
  white-space: nowrap;

  i {
    font-style: normal;
    color: var(--text-3);
  }
}

/* 设置面板 */
.settings-mask {
  position: fixed;
  inset: 0;
  z-index: 400;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(6px);
  display: grid;
  place-items: center;
}

.settings-panel {
  width: min(520px, calc(100vw - 40px));
  border-radius: 22px;
  padding: 26px 28px 24px;
  box-shadow: var(--shadow-2);
}

.settings-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 24px;
}

.settings-title {
  font-family: var(--serif);
  font-size: 24px;
  font-weight: 700;
  margin-top: 8px;
  color: var(--text-1);
}

.settings-close {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  transition: all 0.22s;

  &:hover {
    color: var(--accent);
    border-color: var(--accent);
  }
}

.set-row {
  padding: 14px 0;
  border-bottom: 1px solid var(--line);
  &:last-of-type {
    border-bottom: none;
  }
}

.set-info {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.set-name {
  font-size: 14px;
  color: var(--text-1);
  font-weight: 500;
}

.set-val {
  font-size: 11px;
  color: var(--accent);
  letter-spacing: 0.08em;
}

.set-note {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 18px;
  border: 1px dashed var(--line-strong);
  border-radius: 14px;
  color: var(--text-2);
  font-size: 13.5px;
}

.settings-foot {
  display: flex;
  justify-content: flex-end;
  margin-top: 20px;
}

.set-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 18px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: transparent;
  color: var(--text-2);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.22s;

  &:hover {
    color: var(--accent);
    border-color: var(--accent);
  }
}

/* 过渡 */
.bar-enter-active,
.bar-leave-active {
  transition: all 0.45s var(--ease-spring);
}
.bar-enter-from {
  opacity: 0;
  transform: translateX(-50%) translateY(-24px) scale(0.96);
}
.bar-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-24px) scale(0.96);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
