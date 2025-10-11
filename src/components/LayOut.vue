<template>
  <n-flex>
    <n-layout
      has-sider
      :embedded="true"
      :native-scrollbar="true"
      position="absolute"
    >
      <n-layout-sider
        bordered
        collapse-mode="width"
        :collapsed-width="64"
        :collapsed="collapsed"
        show-trigger="bar"
        :width="150"
        @collapse="collapsed = true"
        @expand="collapsed = false"
      >
        <div>
          <div style="margin: 10px; align-items: center">
            <n-avatar :size="44" src="src/assets/evil.jpg" />

            <div :class="['box']">朝闻道</div>
          </div>
          <n-menu
            :collapsed="collapsed"
            :collapsed-width="64"
            :collapsed-icon-size="22"
            :options="menuOptions"
            key-field="key"
            label-field="label"
            children-field="children"
          />
        </div>

        <n-menu
          :collapsed="collapsed"
          :collapsed-width="64"
          :collapsed-icon-size="22"
          :options="bottomMenu"
          key-field="key"
          label-field="label"
          children-field="children"
        />
      </n-layout-sider>
      <n-layout>
        <Header />
        <Display />
      </n-layout>
    </n-layout>
  </n-flex>
</template>
<script setup>
import Icon from "./Icon.vue";

function renderIcon(id, onClick) {
  return () => h(Icon, { id, onClick });
}

const menuOptions = [
  {
    label: "且听风吟",
    key: "hear-the-wind-sing",
    icon: renderIcon("icon-a-fenxiang2"),
  },
  {
    label: "1973年的弹珠玩具",
    key: "pinball-1973",
    icon: renderIcon("icon-a-fenxiang2"),
    disabled: true,
    children: [
      {
        label: "鼠",
        key: "rat",
      },
    ],
  },
];

const bottomMenu = [
  {
    label: "主页",
    key: "主页",
    icon: renderIcon("icon-home-line"),
  },
  {
    label: "设置",
    key: "设置",
    icon: renderIcon("icon-shezhi"),
  },
];

const collapsed = ref(true);
const boxSet = computed(() => {
  return {
    left: collapsed.value ? "-100px" : "64px",
    display: collapsed.value ? "hidden" : "visible",
  };
});
</script>
<style scoped>
:deep(.n-layout .n-layout-scroll-container) {
  scrollbar-width: none;
}

.box {
  position: absolute;
  height: 44px;
  display: flex;
  visibility: v-bind("boxSet.display");
  top: 10px;
  left: v-bind("boxSet.left");
  transition: all 0.3s ease;
  align-items: center;
}

:deep(.n-avatar img) {
  object-fit: cover;
  object-position: top;
}

:deep(.n-layout-sider-scroll-container) {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}
</style>
