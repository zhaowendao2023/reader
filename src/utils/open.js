// 条目打开路由的唯一入口：Header 下拉、Home、收藏、文件浏览、搜索、标签、
// 图集页都从这里进阅读/播放/看图/聚合页，避免每个页面自己算 id 和拼 query。
//
// item 可以是后端 ItemRow，也可以是页面节点（{ pathKey|key|path, name, kind, ext }）。
// 各页面的差异只体现在 options：
//   dir      目录上下文（视频/图片/图集页需要）
//   playlist 视频是否构建播放列表（=1）
//   back/q   返回来源页（"shelf" | "search" | "tags" …）与搜索词
//   from     文件浏览器来源目录
import router from "../router/index";
import { canonKey, itemId } from "./itemKey";

// 后端 ItemRow 只有 pathKey；页面节点用 path/key。三者按优先级归一。
const pathOf = (item) => item.path || item.pathKey || item.key || "";

const backQuery = ({ back, q } = {}) => ({
  ...(back ? { back } : {}),
  ...(q ? { q } : {}),
});

const navTo = (path, query) => router.push({ path, query });

// 漫画 / 电子书 → 阅读器
export const openComic = async (item, { back, q, from } = {}) => {
  const key = canonKey(pathOf(item));
  const id = await itemId(key);
  return navTo(`/reading/${id}`, {
    path: key,
    name: item.name,
    ext: item.ext || "",
    ...(from ? { from } : {}),
    ...backQuery({ back, q }),
  });
};

// 视频 → 播放页。playlist=true 时播放页按 dir 构建列表。
export const openVideo = async (item, { dir, playlist = false, back, q } = {}) => {
  const key = canonKey(pathOf(item));
  const id = await itemId(key);
  return navTo(`/video/${id}`, {
    ...(dir ? { dir } : {}),
    path: pathOf(item),
    name: item.name,
    ...(playlist ? { playlist: "1" } : {}),
    ...backQuery({ back, q }),
  });
};

// 图片 → 看图器。单张图片用 path；图包/系列目录用 dir + path 列出并定位。
export const openImage = async (item, { dir, back, q } = {}) => {
  const key = canonKey(pathOf(item));
  const id = await itemId(key);
  const p = pathOf(item);
  const single = item.kind === "image";
  return navTo(`/media/${id}`, {
    ...(single ? { path: p } : { dir: p, path: p }),
    ...(single && dir ? { dir } : {}),
    name: item.name,
    ...backQuery({ back, q }),
  });
};

// 图集 / 系列目录 → 聚合页
export const openMediaPack = async (item, { dir, back, q } = {}) => {
  const key = canonKey(pathOf(item));
  const id = await itemId(key);
  return navTo(`/media-pack/${id}`, {
    dir: dir || pathOf(item),
    name: item.name,
    ...backQuery({ back, q }),
  });
};

// 按节点 kind 分派，供「一个菜单/一次点击打开任意条目」的页面使用。
export const openLibraryItem = (item, options = {}) => {
  if (item.kind === "comic") return openComic(item, options);
  if (item.kind === "video") return openVideo(item, options);
  if (item.kind === "image") return openImage(item, options);
  return openMediaPack(item, options);
};

// 搜索结果/标签结果：单个视频/图片按父目录聚合，pack/group 进聚合页。
export const openSearchItem = (item, { back, q } = {}) => {
  const dir = item.parentPath || item.dir;
  return openLibraryItem(item, { back, q, dir: dir || undefined, playlist: true });
};
