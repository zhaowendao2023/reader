// 搜索结果打开跳转的公共逻辑：Header 下拉与 Home 结果页共用。
// item 可以是后端 search_items 返回的 ItemRow，或包含
// { pathKey|key|path, name, kind, ext, parentPath, mediaType } 的节点对象。
import { calculateHash } from "./utils";
import { useBooks } from "../store/loadBooks";
import router from "../router/index";

const normKey = (key) => {
  const booksStore = useBooks();
  return booksStore.platform === "windows" ? String(key).toLowerCase() : key;
};

export const openSearchItem = async (item, { back, q } = {}) => {
  const pkey = item.pathKey || item.key || item.path;
  const key = normKey(pkey);
  const id = await calculateHash(key);
  const name = item.name;
  // back 记录来源页（让查看器/阅读器的「返回」回对地方）；q 供「回搜索页」时重新触发原关键词
  const backQuery = { ...(back ? { back } : {}), ...(q ? { q } : {}) };

  if (item.kind === "comic") {
    router.push({
      path: `/reading/${id}`,
      query: { path: key, name, ext: item.ext || "", ...backQuery },
    });
  } else if (item.kind === "video") {
    // 单个视频：进所在目录的播放列表并定位到该文件
    router.push({
      path: `/video/${id}`,
      query: { dir: item.parentPath || undefined, path: key, name, playlist: "1", ...backQuery },
    });
  } else if (item.kind === "image") {
    // 单张图片：进所在目录的看图器并定位到该文件
    router.push({
      path: `/media/${id}`,
      query: { dir: item.parentPath || undefined, path: key, name, ...backQuery },
    });
  } else {
    // pack / group：打开聚合目录页
    router.push({ path: `/media-pack/${id}`, query: { dir: key, name, ...backQuery } });
  }
};
