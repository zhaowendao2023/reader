/**
 * 条目右键/长按菜单的唯一构造入口。
 *
 * 同一组「打开 / 复制路径 / 编辑标签 / 在文件管理器中显示 / 删除」曾在
 * Home、收藏、文件浏览、图集、标签、播放器里各写一遍；文案、图标与危险项
 * 样式一旦分叉，长按菜单和右键菜单就会出现两种行为。差异项统一走 options：
 *
 *   open        { icon, label?, onOpen } —— 不传则不出「打开」
 *   showTags    是否显示「编辑标签」；tagHidden 控制其禁用条件
 *   show        子集开关 { copy, reveal, delete }，默认全开
 *   extra       插在「删除」之前的附加项（如收藏页的「取消收藏」）
 *   isDir       删除时是否按目录递归
 *   isAndroid   隐藏「在文件管理器中显示」
 *   actions     useItemActions() 返回的动作集合
 */
import { closeContextMenu } from "./contextMenu";

const openItem = (open) => ({
  id: "open",
  label: open.label || "打开",
  icon: open.icon || "play",
  onSelect: () => {
    closeContextMenu();
    open.onOpen();
  },
});

export const buildItemMenu = ({
  item,
  open = null,
  showTags = true,
  tagHidden = false,
  isAndroid = false,
  isDir = false,
  actions,
  extra = [],
  show = {},
  deleteLabel = "删除",
}) => {
  const { copyPath, editTags, revealPath, requestDelete } = actions;
  const visible = { copy: true, reveal: true, delete: true, ...show };
  const items = [];

  if (open) items.push(openItem(open));
  if (visible.copy) {
    items.push({ id: "copy", label: "复制路径", icon: "book-copy", onSelect: () => copyPath(item) });
  }
  if (showTags) {
    items.push({ id: "tags", label: "编辑标签", icon: "tag", hidden: tagHidden, onSelect: () => editTags(item) });
  }
  if (visible.reveal) {
    items.push({
      id: "reveal",
      label: "在文件管理器中显示",
      icon: "folder-open",
      hidden: isAndroid,
      onSelect: () => revealPath(item),
    });
  }
  items.push(...extra);
  if (visible.delete) {
    items.push({ id: "delete", label: deleteLabel, icon: "trash", danger: true, onSelect: () => requestDelete(item, isDir) });
  }
  return items;
};
