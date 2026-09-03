import { Store } from '@tauri-apps/plugin-store';
import { invoke } from "@tauri-apps/api/core";

export const useBooks = defineStore('books', {
  state: () => ({
    favoriteDirs: [],
    cssVarsData: {},
    theme: true,
    platform: '',
    baseSrc: null,
  }),

  actions: {
    async loadData() {
      try {
        const storeInstance = await Store.load('store.bin');
        this.cssVarsData = (await storeInstance.get('cssVars')) || {
          fontSize: 16,
          marginBottom: 1.5,
          letterSpacing: 2,
          lineHeight: 1.6,
        };
        this.theme = await storeInstance.get('theme');
        // 收藏夹现在是 SQLite 里的数据源。DB 字段叫 pathKey，前端统一用 path。
        this.favoriteDirs = ((await invoke('get_favorites')) || []).map((f) => ({
          path: f.pathKey,
          name: f.name,
        }));
        if (/Android/i.test(navigator.userAgent)) {
          this.platform = 'android';
          this.baseSrc = 14;
        } else if (/Windows/i.test(navigator.userAgent)) {
          this.platform = 'windows';
          this.baseSrc = null;
        }
        // books / favoriteDirs 已归 SQLite 管，清掉 store.bin 里的旧键。
        await storeInstance.delete('books');
        await storeInstance.delete('favoriteDirs');
        await storeInstance.save();
      } catch (error) {
        console.error('loadData failed:', error);
        this.favoriteDirs = [];
      }
    },
    async clearAll() {
      await clearLoadDate();
      await invoke('clear_library');
      console.log('library cleared');
    },
    async addFavoriteDir(path, name) {
      const key = this.platform === 'windows' ? path.toLowerCase().replace(/\//g, '\\') : path;
      if (this.favoriteDirs.some((d) => d.path.toLowerCase() === key)) return;
      await invoke('add_favorite', { path, name });
      this.favoriteDirs.push({ path: key, name });
    },
    async removeFavoriteDir(path) {
      await invoke('remove_favorite', { path });
      this.favoriteDirs = this.favoriteDirs.filter((d) =>
        this.platform === 'windows' ? d.path.toLowerCase() !== path.toLowerCase() : d.path !== path
      );
    },
    async setCss() {
      const storeInstance = await Store.load('store.bin');
      await storeInstance.set('cssVars', this.cssVarsData);
      await storeInstance.save();
    },
    async changeTheme() {
      this.theme = !this.theme;
      const storeInstance = await Store.load('store.bin');
      await storeInstance.set('theme', this.theme);
      await storeInstance.save();
    },
  },
});
