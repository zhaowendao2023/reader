<template>
  <div class="settings-page">
    <div class="settings-inner">
      <header class="settings-hero">
        <h2 class="settings-title">设置</h2>
        <span class="kicker">SETTINGS · 偏好与数据</span>
      </header>

      <!-- ===== 外观 ===== -->
      <section class="set-group glass">
        <div class="group-head">
          <span class="group-ico"><Icon id="sun" :size="15" /></span>
          <h3>外观</h3>
          <span class="group-sub mono">APPEARANCE</span>
        </div>

        <div class="set-row">
          <div class="set-info">
            <span class="set-name">深色主题</span>
            <span class="set-desc">深色下封面自动压暗，护眼更沉浸</span>
          </div>
          <n-switch :value="!booksStore.theme" @update:value="booksStore.changeTheme()" />
        </div>

        <div class="set-row">
          <div class="set-info">
            <span class="set-name">图包默认视图</span>
            <span class="set-desc">进入图包时视频/图片的展示形态</span>
          </div>
          <n-radio-group :value="settings.packFileView" @update:value="settings.setPackFileView" size="small">
            <n-radio-button value="grid">卡片</n-radio-button>
            <n-radio-button value="list">列表</n-radio-button>
          </n-radio-group>
        </div>

        <div class="set-row">
          <div class="set-info">
            <span class="set-name">显示来源</span>
            <span class="set-desc">在书架卡片与条目上显示格式/类型与所属收藏文件夹</span>
          </div>
          <n-switch :value="settings.showSource" @update:value="settings.setShowSource" />
        </div>

        <div class="set-row set-row--desktop">
          <div class="set-info">
            <span class="set-name">侧栏默认收起</span>
            <span class="set-desc">启动时侧边栏保持折叠，留出更多阅读空间</span>
          </div>
          <n-switch :value="settings.siderCollapsed" @update:value="settings.toggleSider()" />
        </div>

        <div class="set-row">
          <div class="set-info">
            <span class="set-name">显示解析耗时</span>
            <span class="set-desc">漫画阅读时在页面右下角显示打开/解析耗时小窗</span>
          </div>
          <n-switch :value="settings.showParseTiming" @update:value="settings.setShowParseTiming" />
        </div>
      </section>

      <!-- ===== 视频播放 ===== -->
      <section class="set-group glass">
        <div class="group-head">
          <span class="group-ico"><Icon id="play" :size="15" /></span>
          <h3>视频播放</h3>
          <span class="group-sub mono">VIDEO</span>
        </div>

        <div class="set-row">
          <div class="set-info">
            <span class="set-name">快进快退步长</span>
            <span class="set-desc">键盘方向键与移动端双击统一跳转时长</span>
          </div>
          <n-radio-group
            :value="settings.videoSeekSeconds"
            @update:value="settings.setVideoSeekSeconds"
            size="small"
          >
            <n-radio-button v-for="seconds in [5, 10, 15, 30]" :key="seconds" :value="seconds">
              {{ seconds }} 秒
            </n-radio-button>
          </n-radio-group>
        </div>
      </section>

      <!-- ===== 数据维护 ===== -->
      <section class="set-group glass">
        <div class="group-head">
          <span class="group-ico"><Icon id="layers" :size="15" /></span>
          <h3>数据维护</h3>
          <span class="group-sub mono">MAINTENANCE</span>
        </div>

        <div class="set-row">
          <div class="set-info">
            <span class="set-name">清空封面缓存</span>
            <span class="set-desc">删除磁盘上的封面缩略图，下次访问时重新生成</span>
          </div>
          <button class="act-btn" :disabled="busy" @click="clearCoverCache">
            <Icon id="trash" :size="14" />
            <span>清空</span>
          </button>
        </div>

        <div class="set-row">
          <div class="set-info">
            <span class="set-name">强制重新扫描</span>
            <span class="set-desc">忽略 mtime 快路径，主界面重建收藏索引</span>
          </div>
          <button class="act-btn" :disabled="busy" @click="forceRescan">
            <Icon id="refresh-cw" :size="14" />
            <span>重扫</span>
          </button>
        </div>

        <div class="set-row">
          <div class="set-info">
            <span class="set-name">清空文件库</span>
            <span class="set-desc">删除所有已扫描条目与封面缓存，收藏夹保留</span>
          </div>
          <n-popconfirm @positive-click="clearLibrary">
            <template #trigger>
              <button class="act-btn act-btn--danger" :disabled="busy">
                <Icon id="zap" :size="14" />
                <span>清空</span>
              </button>
            </template>
            将删除全部已索引条目与封面缓存，确定继续？
          </n-popconfirm>
        </div>
      </section>

      <!-- ===== 关于 ===== -->
      <section class="set-group glass">
        <div class="group-head">
          <span class="group-ico"><Icon id="info" :size="15" /></span>
          <h3>关于</h3>
          <span class="group-sub mono">ABOUT</span>
        </div>

        <div class="set-row">
          <div class="set-info">
            <span class="set-name">版本</span>
            <span class="set-desc">朝闻道 · READING ARCHIVE</span>
          </div>
          <span class="about-val mono">V0.1</span>
        </div>

        <div class="set-row">
          <div class="set-info">
            <span class="set-name">数据目录</span>
            <span class="set-desc">SQLite 索引、设置与封面缓存所在位置</span>
          </div>
          <span class="about-val mono path-val" :title="dataDir">{{ dataDir || "读取中…" }}</span>
        </div>
      </section>

      <!-- 操作反馈 -->
      <transition name="toast">
        <div v-if="notice" class="toast glass" :class="'toast--' + notice.type">
          <Icon :id="notice.type === 'ok' ? 'circle-dot' : 'info'" :size="15" />
          <span>{{ notice.text }}</span>
        </div>
      </transition>
    </div>
  </div>
</template>

<script setup>
defineOptions({ name: "Settings" });
import { invoke } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";
import { useBooks } from "../store/loadBooks";
import { useSettings } from "../store/settings";
import { libraryVersion } from "../store/browserCache";
import Icon from "./Icon.vue";

const booksStore = useBooks();
const settings = useSettings();

const busy = ref(false);
const notice = ref(null);
const dataDir = ref("");
let noticeTimer = null;

const flash = (type, text) => {
  clearTimeout(noticeTimer);
  notice.value = { type, text };
  noticeTimer = setTimeout(() => (notice.value = null), 2200);
};

// 清空封面缓存：删除 cover-cache 目录并重建（manifest 一并重置）
const clearCoverCache = async () => {
  busy.value = true;
  try {
    await clearLoadDate();
    flash("ok", "封面缓存已清空，下次访问重新生成");
  } catch (error) {
    console.error("清空封面缓存失败:", error);
    flash("err", "清空封面缓存失败");
  } finally {
    busy.value = false;
  }
};

// 强制重扫：把 favorite 行标记为未同步，Home 的 loadLibrary 检测到后走 scanAll
const forceRescan = async () => {
  busy.value = true;
  try {
    await invoke("force_rescan");
    libraryVersion.value++;
    flash("ok", "已标记重扫，主界面将重建索引");
  } catch (error) {
    console.error("强制重新扫描失败:", error);
    flash("err", "强制重新扫描失败");
  } finally {
    busy.value = false;
  }
};

const clearLibrary = async () => {
  busy.value = true;
  try {
    await booksStore.clearAll();
    libraryVersion.value++;
    flash("ok", "文件库已清空");
  } catch (error) {
    console.error("清空文件库失败:", error);
    flash("err", "清空文件库失败");
  } finally {
    busy.value = false;
  }
};

onMounted(async () => {
  try {
    dataDir.value = await appDataDir();
  } catch (error) {
    console.error("读取数据目录失败:", error);
  }
});

onUnmounted(() => clearTimeout(noticeTimer));
</script>

<style scoped lang="scss">
.settings-page {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  padding: 26px clamp(20px, 6vw, 64px) 60px;
}

.settings-inner {
  max-width: 720px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.settings-hero {
  display: flex;
  align-items: baseline;
  gap: 14px;
  padding: 2px 6px;
}

.settings-title {
  font-family: var(--serif);
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--text-1);
  margin: 0;
}

/* ===== 分组面板 ===== */
.set-group {
  border-radius: var(--radius-lg);
  padding: 6px 18px 4px;
}

.group-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 2px 10px;
  border-bottom: 1px solid var(--line);

  .group-ico {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 8px;
    color: var(--accent);
    background: var(--accent-soft);
  }

  h3 {
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: var(--text-1);
    margin: 0;
  }

  .group-sub {
    margin-left: auto;
    font-size: 9px;
    letter-spacing: 0.26em;
    color: var(--text-3);
  }
}

/* ===== 设置行 ===== */
.set-row {
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 58px;
  padding: 10px 2px;
  border-bottom: 1px solid var(--line);

  &:last-child {
    border-bottom: none;
  }
}

.set-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;

  .set-name {
    font-size: 13.5px;
    color: var(--text-1);
  }

  .set-desc {
    font-size: 11.5px;
    color: var(--text-3);
  }
}

/* 操作按钮 */
.act-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: color-mix(in srgb, var(--text-1) 4%, transparent);
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s var(--ease-out);
  white-space: nowrap;

  &:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
    transform: translateY(-1px);
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  &--danger:hover:not(:disabled) {
    border-color: #ff5c4d;
    color: #ff5c4d;
    background: rgba(229, 72, 77, 0.1);
  }
}

.about-val {
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
}

.path-val {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
  font-size: 11px;
}

/* ===== 反馈浮层 ===== */
.toast {
  position: fixed;
  bottom: 28px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 90;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-radius: 12px;
  font-size: 12.5px;
  color: var(--text-1);
  box-shadow: var(--shadow-2);

  &--ok .lucide {
    color: var(--accent-2);
  }
  &--err .lucide {
    color: #ff5c4d;
  }
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.22s var(--ease-out), transform 0.22s var(--ease-out);
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}

/* ===== 移动端适配 ===== */
@media (max-width: 900px) {
  .settings-page {
    padding: 20px 16px 84px;
  }
  .settings-title {
    font-size: 22px;
  }
  .set-desc {
    display: none;
  }
  .path-val {
    max-width: 150px;
  }
  /* 移动端没有侧栏，「侧栏默认收起」无意义 */
  .set-row--desktop {
    display: none;
  }
}
</style>
