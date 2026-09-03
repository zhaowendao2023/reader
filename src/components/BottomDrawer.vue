<script setup>
import { useBooks } from "../store/loadBooks";
import { getBookCover } from "../utils/bookData";
import Icon from "./Icon.vue";

const index = inject("index");
const show = inject("show");
const toces = inject("toces");
const bookInfo = inject("bookInfo");
const moveMethods = inject("moveMethods");
const coverUrl = ref(null);
onMounted(async () => {
  try {
    coverUrl.value = await getBookCover(bookInfo.value.path);
  } catch (error) {
    console.error("加载封面失败:", error);
  }
});

const active = ref(false); // TOC 目录面板
const expanded = ref(false); // 展开排版设置
// 可写 computed：滑块 v-model 需要 setter，拖动时经 moveMethods.slider 跳页（0 基索引）
const now = computed({
  get: () => index.value.nowIndex + 1,
  set: (val) => moveMethods.slider?.(Number(val) - 1),
});
const themeIcon = computed(() => (useBooks().theme ? "sun" : "moon"));

const isTextBook = computed(() =>
  bookInfo.value &&
  (bookInfo.value.ext.endsWith("epub") || bookInfo.value.ext.endsWith("mobi"))
);
const isComic = computed(() =>
  bookInfo.value && (bookInfo.value.ext.endsWith("cbz") || bookInfo.value.ext.endsWith("zip"))
);

watch(show, () => {
  if (!show.value) {
    expanded.value = false;
  }
});

const toggleToc = () => {
  expanded.value = false;
  active.value = !active.value;
};

const handleExpand = (keys) => {
  expandedKeys.value = keys;
};

const handleSelect = (keys) => {
  selectedKeys.value = keys;
};

const expandedKeys = ref([]);
const selectedKeys = ref([]);
</script>

<template>
  <div class="bottom-chrome">
    <!-- 排版设置（展开态） -->
    <transition name="grow">
      <div v-if="expanded && isTextBook" class="dock-settings glass">
        <BottomMore :height="'auto'" />
      </div>
    </transition>

    <!-- 底部悬浮坞 -->
    <transition name="bar">
      <div v-if="show" class="reader-dock glass" :class="{ 'reader-dock--comic': isComic }" data-tauri-drag-region>
        <!-- 目录 / 图片列表入口固定在最左侧，方便单手展开 -->
        <button class="dock-btn dock-toc-btn" :class="{ on: active }" title="目录" @click="toggleToc">
          <Icon id="list" :size="19" />
        </button>
        <!-- 翻页与进度属于同一组；漫画竖屏时整组上移到底栏按钮之上。 -->
        <div class="dock-navigation">
          <button class="dock-btn" title="上一页" @click="moveMethods.left">
            <Icon id="chevron-left" :size="20" />
          </button>
          <div class="dock-slider">
            <span class="dock-page mono">{{ String(now).padStart(2, "0") }}</span>
            <n-slider v-model:value="now" :step="1" :max="index.total" :min="1" />
            <span class="dock-page mono">{{ index.total }}</span>
          </div>
          <button class="dock-btn" title="下一页" @click="moveMethods.right">
            <Icon id="chevron-right" :size="20" />
          </button>
        </div>

        <span class="dock-divider"></span>

        <button
          v-if="isTextBook"
          class="dock-btn"
          :class="{ on: expanded }"
          title="排版"
          @click="expanded = !expanded"
        >
          <Icon id="type" :size="19" />
        </button>
        <button class="dock-btn" title="切换外观" @click="useBooks().changeTheme()">
          <Icon :id="themeIcon" :size="19" />
        </button>
      </div>
    </transition>

    <!-- 目录面板 -->
    <transition name="panel">
      <div v-if="active" class="toc-mask" @click="toggleToc">
        <aside class="toc-panel glass" @click.stop>
          <div class="toc-head">
            <img v-if="coverUrl" class="toc-cover" :src="coverUrl" alt="" />
            <div class="toc-meta">
              <div class="kicker">CONTENTS</div>
              <div class="toc-title"><n-ellipsis :tooltip="false">{{ bookInfo.title }}</n-ellipsis></div>
              <div class="toc-count mono">{{ toces.length }} 章节</div>
            </div>
          </div>
          <div class="toc-body">
            <n-tree
              v-if="toces"
              block-line
              :data="toces"
              :expanded-keys="expandedKeys"
              :selected-keys="selectedKeys"
              @update:expanded-keys="handleExpand"
              @update:selected-keys="handleSelect"
              key-field="href"
              label-field="label"
              children-field="subitems"
              selectable
              :node-props="moveMethods.jump"
            />
            <div v-else class="toc-empty">
              <Icon id="file-text" :size="26" />
              <span>暂无目录</span>
            </div>
          </div>
        </aside>
      </div>
    </transition>
  </div>
</template>

<style scoped lang="scss">
.bottom-chrome {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 300;
  display: flex;
  flex-direction: column;
  align-items: center;
  pointer-events: none;
  padding: 0 20px 14px;
}

/* 排版设置扩展区 */
.dock-settings {
  pointer-events: auto;
  width: min(620px, 100%);
  margin-bottom: 10px;
  border-radius: 18px;
  padding: 18px 22px 16px;
  box-shadow: var(--shadow-2);
}

/* 悬浮坞 */
.reader-dock {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  width: min(760px, 100%);
  height: 58px;
  padding: 0 10px;
  border-radius: 18px;
  box-shadow: var(--shadow-2);
}

.dock-btn {
  width: 40px;
  height: 40px;
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

  &.on {
    color: var(--accent);
    background: var(--accent-soft);
  }
}

.dock-slider {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 0 8px;

  :deep(.n-slider) {
    flex: 1;
  }

  :deep(.n-slider .n-slider-rail__fill) {
    background: var(--accent);
  }

  :deep(.n-slider .n-slider-rail) {
    background: color-mix(in srgb, var(--text-1) 14%, transparent);
  }
}

.dock-navigation {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.dock-page {
  font-size: 11px;
  letter-spacing: 0.12em;
  color: var(--text-2);
  flex-shrink: 0;
  min-width: 30px;
  text-align: center;
}

.dock-divider {
  width: 1px;
  height: 24px;
  background: var(--line);
  margin: 0 8px;
  flex-shrink: 0;
}

/* 目录面板 */
.toc-mask {
  position: fixed;
  inset: 0;
  z-index: 350;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(4px);
  pointer-events: auto;
}

.toc-panel {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: min(360px, 88vw);
  border-radius: 0 22px 22px 0;
  border-left: none;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-2);
}

.toc-head {
  display: flex;
  gap: 14px;
  align-items: center;
  padding: 22px 22px 18px;
  border-bottom: 1px solid var(--line);
}

.toc-cover {
  width: 46px;
  height: 64px;
  object-fit: cover;
  border-radius: 8px;
  box-shadow: var(--shadow-1);
  flex-shrink: 0;
}

.toc-meta {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.toc-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1);
  max-width: 240px;
  overflow: hidden;
}

.toc-count {
  font-size: 9.5px;
  letter-spacing: 0.18em;
  color: var(--text-3);
}

.toc-body {
  flex: 1;
  overflow-y: auto;
  padding: 14px 12px 24px;
  scrollbar-width: thin;

  :deep(.n-tree-node) {
    border-radius: 8px;
  }
}

.toc-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 60px 20px;
  color: var(--text-3);
  font-size: 13px;
}

/* 移动端竖屏：将漫画翻页与进度整体放在操作栏上方，底栏只保留功能按钮。 */
@media (max-width: 899px) and (orientation: portrait) {
  .bottom-chrome {
    padding-bottom: max(14px, env(safe-area-inset-bottom));
  }

  .reader-dock--comic {
    .dock-navigation {
      position: absolute;
      left: 0;
      right: 0;
      bottom: calc(100% + 10px);
      min-height: 54px;
      padding: 7px 8px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: color-mix(in srgb, var(--panel) 92%, transparent);
      box-shadow: var(--shadow-1);
      backdrop-filter: blur(16px) saturate(1.2);

      .dock-slider {
        padding: 0 4px;
      }
    }

    .dock-divider {
      margin-left: auto;
    }
  }
}

/* 手机章节面板收窄，仍保留足够的标题和树形目录阅读空间。 */
@media (max-width: 640px) {
  .toc-panel {
    width: min(300px, 78vw);
    border-radius: 0 18px 18px 0;
  }

  .toc-head {
    gap: 11px;
    padding: 18px 16px 15px;
  }

  .toc-body {
    padding: 10px 8px 20px;
  }
}

/* 过渡 */
.bar-enter-active,
.bar-leave-active {
  transition: all 0.45s var(--ease-spring);
}
.bar-enter-from {
  opacity: 0;
  transform: translateY(24px) scale(0.96);
}
.bar-leave-to {
  opacity: 0;
  transform: translateY(24px) scale(0.96);
}

.grow-enter-active,
.grow-leave-active {
  transition: all 0.4s var(--ease-out);
}
.grow-enter-from,
.grow-leave-to {
  opacity: 0;
  transform: translateY(16px);
}

.panel-enter-active,
.panel-leave-active {
  transition: opacity 0.35s;
}
.panel-enter-active .toc-panel,
.panel-leave-active .toc-panel {
  transition: transform 0.45s var(--ease-out);
}
.panel-enter-from,
.panel-leave-to {
  opacity: 0;
}
.panel-enter-from .toc-panel,
.panel-leave-to .toc-panel {
  transform: translateX(-100%);
}
</style>
