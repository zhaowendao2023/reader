export const useUI = defineStore('ui', {
  state: () => ({
    siderCollapsed: true,
    navReset: 0,
  }),
  actions: {
    toggleSider() {
      this.siderCollapsed = !this.siderCollapsed;
    },
    // 侧边栏导航点击：目标视图回到自身主界面（主界面=双卡片、收藏=文件夹总览、文件夹预览=根目录）
    resetView() {
      this.navReset++;
    },
  },
});
