<script setup>
import { convertFileSrc } from "@tauri-apps/api/core";
import { useBooks } from "../store/loadBooks";

const index = inject("index");
const show = inject("show");
const toces = inject("toces");
const bookInfo = inject("bookInfo");
const moveMethods = inject("moveMethods");
const active = ref(false);
const now = computed(() => index.value.nowIndex + 1);
const iconSize = 20;
const lowHeight = ref("10vh");

watch(show, () => {
  lowHeight.value = "10vh";
});

const isActive = () => {
  show.value = false;
  active.value = !active.value;
};
const handleExpand = (keys) => {
  expandedKeys.value = keys;
};

const handleSelect = (keys) => {
  selectedKeys.value = keys;
};

const expandedKeys = ref([]); // 展开状态
const selectedKeys = ref([]); // 选中状态
</script>

<template>
  <div>
    <n-drawer
      v-model:show="show"
      :height="lowHeight"
      placement="bottom"
      :auto-focus="false"
      :show-mask="false"
      :mask-closable="false"
    >
      <BottomMore v-if="lowHeight === '40vh'" :height="'30vh'" />
      <div class="bottom-T">
        <n-button quaternary round @click="moveMethods.left">
          <n-icon :size="iconSize">
            <Icon id="icon-fanhui" />
          </n-icon>
        </n-button>
        <n-slider v-model:value="now" :step="1" :max="index.total" :min="1" />
        <n-button quaternary round @click="moveMethods.right">
          <n-icon :size="iconSize">
            <Icon id="icon-youjiantou" />
          </n-icon>
        </n-button>
      </div>
      <div class="bottom-B">
        <n-icon :size="iconSize" @click="isActive">
          <Icon id="icon-catalog" />
        </n-icon>
        <n-icon :size="iconSize" @click="lowHeight = '40vh'">
          <Icon id="icon-shezhi" />
        </n-icon>
        <n-icon
          :size="iconSize"
          @click="async () => await useBooks().changeTheme()"
        >
          <Icon
            :id="useBooks().theme ? 'icon-cubanrijian' : 'icon-yejianmoshi'"
          />
        </n-icon>
        <n-icon :size="iconSize">
          <Icon id="icon-cubanrijian" />
        </n-icon>
        <n-icon :size="iconSize">
          <Icon id="icon-cubanrijian" />
        </n-icon>
      </div>
    </n-drawer>
    <n-drawer
      v-model:show="active"
      :width="'40vh'"
      placement="left"
      :auto-focus="false"
    >
      <n-drawer-content
        body-content-style="padding: 0;"
        :native-scrollbar="false"
      >
        <template #header>
          <div
            style="
              display: flex;
              align-items: center;
              justify-content: space-between;
            "
          >
            <img
              class="min-cover"
              :src="convertFileSrc(bookInfo.cover)"
              alt=""
            />{{ bookInfo.title }}
            <n-icon size="20">
              <Icon id="icon-47" />
            </n-icon>
          </div>
        </template>
        <template #default>
          <div class="toces">
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
              style="
                --n-loading-color: #ddd;
                --n-node-color-active: #dddddd96;
                --n-drop-mark-color: #ddd;
              "
            />
          </div>
        </template>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<style scoped lang="scss">
.bottom-B {
  display: flex;
  justify-content: space-around;
}

.bottom-T {
  display: flex;
  align-items: center;
}

.toces {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  overflow-y: auto;
  scrollbar-width: 0;
}

.min-cover {
  height: 10vh;
  width: 8vh;
}

:deep(.n-slider .n-slider-rail .n-slider-rail__fill) {
  background-color: #00a0e9;
  height: 1vh;
}

:deep(.n-drawer .n-drawer-content .n-drawer-header) {
  padding: 12px 24px;
}
</style>
