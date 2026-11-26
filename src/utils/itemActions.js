import { remove as fsRemove } from "@tauri-apps/plugin-fs";
import { useNotification } from "naive-ui";
import { invoke } from "@tauri-apps/api/core";
import { useBooks } from "../store/loadBooks";
import { useTags } from "../store/tags";
import {
  covers,
  coverFailed,
  dirCache,
  canonKey,
  touchLibrary,
} from "../store/browserCache";
import { itemId } from "./itemKey";
import { deleteFileData } from "./bookData";
import { scanAndSyncFavorite } from "./mediaScan";
import {
  closeContextMenu,
  requestConfirm,
  setMenuBusy,
  setMenuError,
} from "./contextMenu";

const pathOf = (item) => item.path || item.key || "";

const copyText = async (text) => {
  // 优先用传统 execCommand：同步、不触发 WebView2 原生剪贴板权限框。
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (ok) return true;
  } catch (error) {
    // fall through
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    return false;
  }
};

// 删除源文件后，把 SQLite 里的收藏夹重新扫一遍，保证 Home/搜索不再出现已删内容。
const refreshLibraryForDelete = async (path) => {
  const booksStore = useBooks();
  const deletedKey = canonKey(path);
  const sep = booksStore.platform === "windows" ? "\\" : "/";
  const roots = booksStore.favoriteDirs.filter((d) => {
    const rootKey = canonKey(d.path);
    if (rootKey === deletedKey) return true;
    return deletedKey.startsWith(rootKey.endsWith(sep) ? rootKey : rootKey + sep);
  });
  for (const dir of roots) {
    if (canonKey(dir.path) === deletedKey) {
      try {
        await booksStore.removeFavoriteDir(dir.path);
      } catch (error) {
        console.error("remove favorite failed:", dir.path, error);
      }
      continue;
    }
    try {
      // 目录 mtime 未变（dirty=false）时 scanAndSyncFavorite 内部跳过写库
      await scanAndSyncFavorite(dir);
    } catch (error) {
      console.error("rescan favorite failed:", dir.path, error);
    }
  }
  touchLibrary();
};

export const useItemActions = ({ onDeleted } = {}) => {
  const notification = useNotification();

  const copyPath = async (item) => {
    const path = pathOf(item);
    const ok = await copyText(path);
    closeContextMenu();
    if (ok) {
      notification.success({ title: "已复制", content: `「${item.name}」的路径已复制`, duration: 2000 });
    } else {
      notification.error({ title: "复制失败", content: "未能写入剪贴板", duration: 2500 });
    }
  };

  // 打开标签编辑弹窗（弹窗由 App.vue 挂载的 TagEditor 渲染）。
  const editTags = (item) => {
    closeContextMenu();
    useTags().openEditor(item);
  };

  const revealPath = async (item) => {
    const path = pathOf(item);
    try {
      await invoke("plugin:opener|reveal_item_in_dir", { paths: [path] });
      closeContextMenu();
    } catch (error) {
      console.error("reveal failed:", error);
      notification.error({ title: "定位失败", content: "无法在文件管理器中显示", duration: 2500 });
    }
  };

  const requestDelete = (item, isDir = false) => {
    requestConfirm({
      id: "delete",
      label: "删除",
      message: isDir
        ? `确认永久删除「${item.name}」及其全部内容？此操作不可恢复。`
        : `确认永久删除「${item.name}」？此操作不可恢复。`,
      confirmLabel: "永久删除",
      onConfirm: () => deleteItem(item, isDir),
    });
  };

  const deleteItem = async (item, isDir = false) => {
    const path = pathOf(item);
    setMenuBusy(true);
    setMenuError("");
    try {
      await fsRemove(path, { recursive: true });
      const coverCacheKey = canonKey(item.key || path);
      const id = await itemId(path);
      try {
        await deleteFileData(id);
      } catch (error) {
        console.error("cover cache cleanup failed:", error);
      }
      delete covers[coverCacheKey];
      delete coverFailed[coverCacheKey];
      dirCache.clear();
      closeContextMenu();
      notification.success({ title: "已删除", content: `「${item.name}」已永久删除`, duration: 2200 });
      await refreshLibraryForDelete(path);
      if (onDeleted) await onDeleted(item, path);
    } catch (error) {
      console.error("delete failed:", error);
      setMenuBusy(false);
      setMenuError(error?.message ? `删除失败：${error.message}` : "删除失败，请重试");
    }
  };

  return { copyPath, revealPath, requestDelete, deleteItem, editTags };
};
