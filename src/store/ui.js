export const useUI = defineStore('ui', {
  state: () => ({
    siderCollapsed: true,
  }),
  actions: {
    toggleSider() {
      this.siderCollapsed = !this.siderCollapsed;
    },
  },
});
