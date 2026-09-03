import { invoke } from "@tauri-apps/api/core";

export const useUI = defineStore('ui', {
  state: () => ({
    navReset: 0,
    // 顶部搜索：查询词、命中行（ItemRow）、命中的单个视频/图片的父目录行
    searchQuery: '',
    searchItems: [],
    searchParents: [],
    searching: false,
    searchOpen: false, // 顶栏下拉是否展开
  }),
  actions: {
    // 侧边栏导航点击：目标视图回到自身主界面（主界面=双卡片、收藏=文件夹总览、文件夹预览=根目录）
    resetView() {
      this.navReset++;
      this.searchOpen = false;
    },
    // SQL 名称模糊搜索；空查询直接清空结果。
    async runSearch() {
      const q = this.searchQuery.trim();
      if (!q) {
        this.searchItems = [];
        this.searchParents = [];
        this.searching = false;
        return;
      }
      this.searching = true;
      try {
        const res = await invoke('search_items', { query: q, limit: 60 });
        this.searchItems = res.items || [];
        this.searchParents = res.parents || [];
      } catch (error) {
        console.error('search failed:', error);
        this.searchItems = [];
        this.searchParents = [];
      } finally {
        this.searching = false;
      }
    },
  },
});
