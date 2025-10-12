<script setup>
import { Window } from "@tauri-apps/api/window";
import { useRouter } from "vue-router";

const appWindow = new Window("main");
const index = inject("index");
const show = inject("show");
const now = computed(() => index.value.nowIndex + 1);
const iconSize = 18;
const router = useRouter();
const showModal = ref(false);
const quit = async () => {
  try {
    await router.push(`/`); // 使用 await 等待 Promise 完成
  } catch (err) {
    console.error("路由跳转失败:", err);
  }
};
const OverwriteFonts = ref(false);
const options = [
  {
    label: "Thanghan",
    value: "song0",
    // disabled: true,
  },
  {
    label: "11111111111111111",
    value: "song1",
    // disabled: true,
  },
];
</script>

<template>
  <div class="111">
    <n-drawer
      v-model:show="show"
      height="8vh"
      placement="top"
      :auto-focus="false"
    >
      <div class="top">
        <div class="content">
          <n-button quaternary round @click="quit">
            <n-icon :size="iconSize">
              <Icon id="icon-fanhui" />
            </n-icon>
          </n-button>
          <div style="width: 6rem">{{ now }} / {{ index.total }}</div>
        </div>
        <div
          @mousedown="appWindow.startDragging"
          style="height: 100%; width: -webkit-fill-available"
        ></div>
        <div class="content">
          <n-button quaternary round @click="showModal = true">
            <n-icon :size="iconSize">
              <Icon id="icon-zitidaxiao" />
            </n-icon>
          </n-button>
        </div>
      </div>
    </n-drawer>
    <n-modal v-model:show="showModal">
      <n-el>
        <n-card
          style="width: 500px; height: 500px"
          :bordered="false"
          size="huge"
          role="dialog"
          aria-modal="true"
          content-style="padding: 0;"
        >
          <div class="top-buttons">
            <n-button quaternary round>
              <n-icon :size="iconSize">
                <Icon id="icon-zitidaxiao" />
              </n-icon>
            </n-button>
            <n-button quaternary round>
              <n-icon :size="iconSize">
                <Icon id="icon-duoshebei" />
              </n-icon>
            </n-button>
            <n-button quaternary round>
              <n-icon :size="iconSize">
                <Icon id="icon-zitidaxiao" />
              </n-icon>
            </n-button>
            <n-button quaternary round>
              <n-icon :size="iconSize">
                <Icon id="icon-zitidaxiao" />
              </n-icon>
            </n-button>
            <n-button quaternary round>
              <n-icon :size="iconSize">
                <Icon id="icon-zitidaxiao" />
              </n-icon>
            </n-button>
            <n-button quaternary round>
              <n-icon :size="iconSize">
                <Icon id="icon-zitidaxiao" />
              </n-icon>
            </n-button>
          </div>
          <div class="car-content">
            <div class="set-item">
              覆盖默认字体<n-switch v-model:value="OverwriteFonts" />
            </div>
            <div>
              <div>字号</div>
              <div class="card">
                <div class="set-item">
                  默认字号<n-switch v-model:value="OverwriteFonts" />
                </div>
                <hr />
                <div class="set-item">
                  默认字号<n-switch v-model:value="OverwriteFonts" />
                </div>
              </div>
            </div>
            <div>
              <div>字体</div>
              <div class="card">
                <div class="set-item">
                  默认字体<n-select
                    v-model:value="options[0].label"
                    :options="options"
                  />
                </div>
                <hr />
                <div class="set-item">
                  中文字体<n-switch v-model:value="OverwriteFonts" />
                </div>
              </div>
            </div>
          </div>
          <template #footer> 尾部 </template>
        </n-card>
      </n-el>
    </n-modal>
  </div>
</template>

<style scoped lang="scss">
.top {
  height: -webkit-fill-available;
  display: flex;
  align-items: center;
  justify-content: space-between;

  .content {
    display: flex;
    align-items: center;
  }
}

.set-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

:deep(.card) {
  border-radius: 10px;
  box-shadow: 0 0 0 1px var(--xy-color);

  hr {
    color: var(--xy-color);
  }

  .set-item {
    padding: 10px;
    margin-bottom: 0;
  }
  .n-select {
    margin-bottom: 0;
  }
}

.car-content {
  padding: 10px 50px;
  font-size: 16px;
  div {
    margin-bottom: 15px;
    width: auto;
  }
}

:deep([role="switch"]) {
  display: contents;
}

.qqq {
  :deep(.n-card > .n-card__content, .n-card > .n-card__footer) {
    padding: 0;
  }
}
</style>
