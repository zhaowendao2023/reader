import { invoke } from "@tauri-apps/api/core";
import { useUI } from "./ui";

// 标签系统状态：全部标签（含计数）、编辑弹窗的打开状态与目标条目。
// 标签挂在 pathKey 上（Rust 端 set_item_tags），编辑是整体替换式。
export const useTags = defineStore("tags", {
  state: () => ({
    allTags: [],
    editorOpen: false,
    editingItem: null, // { name, pathKey, kind }
  }),
  actions: {
    async loadTags() {
      try {
        this.allTags = (await invoke("list_tags")) || [];
      } catch (error) {
        console.error("TAGS-LIST-FAIL", error);
        this.allTags = [];
      }
    },
    async openEditor(item) {
      this.editingItem = {
        name: item?.name || "",
        pathKey: item?.pathKey || item?.key || item?.path || "",
        kind: item?.kind || "",
      };
      this.editorOpen = true;
      if (!this.allTags.length) await this.loadTags();
    },
    closeEditor() {
      this.editorOpen = false;
      this.editingItem = null;
    },
    async saveTags(names) {
      if (!this.editingItem?.pathKey) return;
      try {
        await invoke("set_item_tags", { pathKey: this.editingItem.pathKey, tags: names });
        await this.loadTags();
        // 正在搜索时刷新结果，让 matchedTags 标记随之更新。
        const ui = useUI();
        if (ui.searchQuery.trim()) ui.runSearch();
      } catch (error) {
        console.error("TAGS-SAVE-FAIL", error);
        throw error;
      }
    },
    async renameTag(id, name) {
      try {
        await invoke("rename_tag", { tagId: id, name });
        await this.loadTags();
      } catch (error) {
        console.error("TAGS-RENAME-FAIL", error);
        throw error;
      }
    },
    async deleteTag(id) {
      try {
        await invoke("delete_tag", { tagId: id });
        await this.loadTags();
      } catch (error) {
        console.error("TAGS-DELETE-FAIL", error);
        throw error;
      }
    },
    async setTagKind(id, kind) {
      try {
        await invoke("set_tag_kind", { tagId: id, kind });
        await this.loadTags();
      } catch (error) {
        console.error("TAGS-SET-KIND-FAIL", error);
        throw error;
      }
    },
  },
});
