import { Store } from '@tauri-apps/plugin-store';


export const useBooks = defineStore('books', {
  // 1. 初始 State：comics 默认是空数组（或其他占位值）
  state: () => ({
    books: {},
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
        if (/Android/i.test(navigator.userAgent)) {
          this.platform = 'android'
          this.baseSrc = 14
        } else if (/Windows/i.test(navigator.userAgent)) {
          this.platform = 'windows'
          this.baseSrc = null
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