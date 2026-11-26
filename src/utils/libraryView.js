// 库条目的视图模型：把后端 ItemRow 转成各页面共用的节点形状，并提供统一排序。
//
// 同一份转换曾在 Home / 搜索页 / 标签页各复制一遍，单文件行（video/image）与
// 目录行（pack/group）的计数语义一旦分叉，同一本书在不同入口会显示不同的
// 集数/张数。所有「ItemRow → 卡片节点」的换算都必须走这里。
export const byName = (a, b) => a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true });

// extra 是后端聚合字段的 JSON；旧行、扫描占位行或 mock 可能为 null，统一按空对象处理。
export const extraOf = (row) =>
  row && row.extra && typeof row.extra === "object" ? row.extra : {};

// 目录行的展示类型：group 是分卷系列，其余按 mediaType 细分视频/图片/混合。
export const kindOfRow = (row) =>
  row.kind === "group"
    ? { kind: "group", ext: "group" }
    : row.mediaType === "video"
      ? { kind: "video-folder", ext: "video" }
      : row.mediaType === "image"
        ? { kind: "image-folder", ext: "image" }
        : { kind: "media-folder", ext: "media" };

/**
 * ItemRow → 卡片节点。
 *
 * @param row     后端 ItemRow（extra 里是扫描聚合的计数）
 * @param favName 所属收藏夹显示名
 * @param kind    卡片类型（comic/video/image/pack/group/video-folder/…）
 * @param ext     展示用后缀
 * @returns {object} 页面渲染、路由与右键菜单共用同一形状
 */
export const nodeShape = (row, favName, kind, ext) => ({
  name: row.name,
  key: row.pathKey,
  path: row.pathKey,
  dir: row.parentPath || row.pathKey,
  folder: favName,
  kind,
  ext,
  count: extraOf(row).count ?? 0,
  // 单文件条目（video/image 行）没有聚合字段，计数直接定为 1
  videoCount: kind === "video" ? 1 : extraOf(row).videoCount ?? 0,
  imageCount: kind === "image" ? 1 : extraOf(row).imageCount ?? 0,
  childCount: extraOf(row).childCount ?? 0,
  tags: row.matchedTags || [],
  children: [],
  files: [],
});
