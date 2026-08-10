import { Store } from '@tauri-apps/plugin-store';
import { dirname } from '@tauri-apps/api/path';


export const useBooks = defineStore('books', {
  // 1. 初始 State：comics 默认是空数组（或其他占位值）
  state: () => ({
    books: {},
    favoriteDirs: [],
    mobileRoot: null,
    cssVarsData: {},
    theme: true,
    platform: '',
    baseSrc: null
  }),

  // 2. 异步 Action：负责加载数据并更新 State
  actions: {
    async loadData() {
      try {
        const storeInstance = await Store.load('store.bin');
        this.books = await storeInstance.get('books') || {};
        this.cssVarsData = await storeInstance.get('cssVars') || {
          fontSize: 16,
          marginBottom: 1.5,
          letterSpacing: 2,
          lineHeight: 1.6,
        };
        this.theme = await storeInstance.get('theme')
        this.favoriteDirs = await storeInstance.get('favoriteDirs') || [];
        this.mobileRoot = await storeInstance.get('mobileRoot') || null;
        if (/Windows/i.test(navigator.userAgent) && this.favoriteDirs.length) {
          const seen = new Set();
          this.favoriteDirs = this.favoriteDirs.filter((d) => {
            const key = d.path.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }
        if (/Android/i.test(navigator.userAgent)) {
          this.platform = 'android'
          this.baseSrc = 14
        } else if (/Windows/i.test(navigator.userAgent)) {
          this.platform = 'windows'
          this.baseSrc = null
        }
        // 迁移：老版本手动添加的书，自动收藏其所在文件夹（仅桌面端）
        if (this.platform !== 'android' && !this.favoriteDirs.length && Object.keys(this.books).length) {
          const dirMap = new Map();
          for (const book of Object.values(this.books)) {
            try {
              const dir = await dirname(book.path);
              const key = this.platform === 'windows' ? dir.toLowerCase() : dir;
              if (dir && !dirMap.has(key)) {
                const parts = dir.split(/[\\/]+/).filter(Boolean);
                dirMap.set(key, { path: dir, name: parts[parts.length - 1] || dir });
              }
            } catch (error) { /* ignore */ }
          }
          this.favoriteDirs = Array.from(dirMap.values());
          this.favoriteDirs = Array.from(dirMap, ([path, name]) => ({ path, name }));
          if (this.favoriteDirs.length) {
            await storeInstance.set('favoriteDirs', this.favoriteDirs);
            await storeInstance.save();
          }
        }
      } catch (error) {
        this.books = {};
      }
    },
    async addBook(newBooks) {
      const storeInstance = await Store.load('store.bin');
      for (let id in newBooks) {
        // 直接修改 Store 的 state（自动触发组件响应式更新）
        this.books[id] = newBooks[id]
      }
      await storeInstance.set(`books`, this.books);
      await storeInstance.save();
    },
    async clearAll() {
      this.books = {};
      // 清除Tauri Store
      const storeInstance = await Store.load('store.bin');
      await storeInstance.delete('books');
      await storeInstance.save(); // 确保数据保存到磁盘
    },
    getBook(id) {
      return this.books[id]
    },
    async deleteBook(id) {
      delete this.books[id]
      const storeInstance = await Store.load('store.bin');
      await storeInstance.set('books', this.books);
      await storeInstance.save();
    },
    async setMobileRoot(root) {
      this.mobileRoot = root;
      const storeInstance = await Store.load('store.bin');
      await storeInstance.set('mobileRoot', root);
      await storeInstance.save();
    },
    async addFavoriteDir(path, name) {
      const key = this.platform === 'windows' ? path.toLowerCase() : path;
      if (this.favoriteDirs.some((d) => (this.platform === 'windows' ? d.path.toLowerCase() === key : d.path === path))) return;
      this.favoriteDirs.push({ path, name });
      const storeInstance = await Store.load('store.bin');
      await storeInstance.set('favoriteDirs', this.favoriteDirs);
      await storeInstance.save();
    },
    async removeFavoriteDir(path) {
      this.favoriteDirs = this.favoriteDirs.filter((d) =>
        this.platform === 'windows' ? d.path.toLowerCase() !== path.toLowerCase() : d.path !== path
      );
      const storeInstance = await Store.load('store.bin');
      await storeInstance.set('favoriteDirs', this.favoriteDirs);
      await storeInstance.save();
    },
    async setCss() {
      const storeInstance = await Store.load('store.bin');
      await storeInstance.set('cssVars', this.cssVarsData)
      await storeInstance.save()
    },
    async changeTheme() {
      this.theme = !this.theme
      const storeInstance = await Store.load('store.bin');
      await storeInstance.set('theme', this.theme)
      await storeInstance.save()
    }
  }
});