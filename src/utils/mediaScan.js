import { readDir } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { canonKey } from "../store/browserCache";
import { extOf, isComicFile, isImage, isVideo, joinPath, packKindFor } from "./media";

const byName = (a, b) => a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true });

const leafName = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || p;

// ============ 目录元数据读取（含 mtime 的 readDir 替代品） ============
// 走 Rust read_dir_meta：一次调用返回目录自身 mtime + 每个子项 mtime，
// 用来判定"这棵子树自上次扫描后是否变过"，没变就直接从 SQLite 索引重建，
// 不再递归 readDir。支持真实文件系统路径：桌面 / Android 全文件访问
// （收藏根是真实 /storage/emulated/0/... 路径），Rust 侧直接 std::fs，
// 带目录自身 mtime（快路径可用）。
// mock / 无该命令的环境回退 plugin-fs readDir（mtime 全 null → 全量扫描）。
const readDirMeta = async (path) => {
  try {
    const meta = await invoke("read_dir_meta", { path });
    if (meta && Array.isArray(meta.entries)) {
      return {
        selfMtime: typeof meta.selfMtime === "number" ? meta.selfMtime : null,
        entries: meta.entries.map((e) => ({
          name: e.name,
          isDir: !!e.isDir,
          mtime: typeof e.mtime === "number" ? e.mtime : null,
        })),
      };
    }
  } catch (error) {
    // fall through to plugin-fs readDir
  }
  try {
    const raw = await readDir(path);
    return {
      selfMtime: null,
      entries: raw.map((e) => ({ name: e.name, isDir: !!e.isDirectory, mtime: null })),
    };
  } catch {
    return null; // 目录不可读（已删除/被移除权限）
  }
};

// ============ DB 行 → 扫描树（持久化索引重建） ============
// items 表本身就是上次扫描的持久化索引：kind/parentPath/extra 聚合 + mtime。
// 当磁盘 mtime 未变时，直接从这些行重建与 scanFavoriteTree 形状一致的树，
// 零深层磁盘读。

const extraOf = (row) => (row && typeof row.extra === "object" ? row.extra : {});

// 行 → 节点 kind。favorite 行本身不是 group/pack 类型：
// mediaType 为 NULL → 收藏根是"子目录容器"（group 语义，子树由 pack/group 行组成）；
// mediaType 非 NULL → 收藏根自身是一个媒体包（pack 语义，flattenScan 合并进 favorite 行）。
const rowToNodeKind = (row) => {
  if (row.kind === "group" || (row.kind === "favorite" && row.mediaType == null)) return "group";
  return row.mediaType === "video"
    ? "video-folder"
    : row.mediaType === "image"
      ? "image-folder"
      : "media-folder";
};

const rowToNodeExt = (kind) =>
  kind === "group" ? "group" : kind === "video-folder" ? "video" : kind === "image-folder" ? "image" : "media";

const nodeFromRow = (row, favoriteName) => {
  const extra = extraOf(row);
  const kind = rowToNodeKind(row);
  return {
    name: row.name,
    key: row.pathKey,
    path: row.pathKey,
    dir: row.parentPath || row.pathKey,
    folder: favoriteName,
    kind,
    ext: rowToNodeExt(kind),
    count: extra.count ?? 0,
    videoCount: extra.videoCount ?? 0,
    imageCount: extra.imageCount ?? 0,
    childCount: extra.childCount ?? 0,
    mtime: row.mtime ?? null,
    children: [],
    files: [],
  };
};

const buildSubtreeFromRows = (row, rowsByParent, favoriteName) => {
  const node = nodeFromRow(row, favoriteName);
  const kids = (rowsByParent.get(row.pathKey) || [])
    .filter((r) => r.kind === "pack" || r.kind === "group")
    .sort(byName);
  for (const k of kids) node.children.push(buildSubtreeFromRows(k, rowsByParent, favoriteName));
  const files = (rowsByParent.get(row.pathKey) || [])
    .filter((r) => r.kind === "video" || r.kind === "image")
    .sort(byName);
  node.files = files.map((f) => ({ name: f.name, path: f.pathKey, ext: f.ext || "", mtime: f.mtime ?? null }));
  return node;
};

const buildDbTree = (rows, favKey, favoriteName, rootRow) => {
  const rowsByParent = new Map();
  for (const r of rows) {
    if (!r.parentPath) continue;
    const list = rowsByParent.get(r.parentPath) || [];
    list.push(r);
    rowsByParent.set(r.parentPath, list);
  }
  const comics = [];
  for (const r of rows) {
    if (r.kind !== "comic" || r.folder !== favoriteName) continue;
    comics.push({
      name: r.name,
      key: r.pathKey,
      path: r.pathKey,
      ext: r.ext || "",
      kind: "comic",
      folder: r.folder,
      dir: r.parentPath || r.pathKey,
      mtime: r.mtime ?? null,
    });
  }
  comics.sort(byName);
  const root = buildSubtreeFromRows(rootRow, rowsByParent, favoriteName);
  const packs = root.kind === "group" ? root.children : [root];
  return {
    comics,
    packs,
    root,
    count: comics.length + (root.kind !== "group" ? 1 : root.children.length),
    rootMtime: rootRow.mtime ?? null,
    dirty: false,
  };
};

const indexRows = (rows) => {
  const rowsByKey = new Map();
  const rowsByParent = new Map();
  for (const r of rows) {
    rowsByKey.set(r.pathKey, r);
    if (!r.parentPath) continue;
    const list = rowsByParent.get(r.parentPath) || [];
    list.push(r);
    rowsByParent.set(r.parentPath, list);
  }
  return { rowsByKey, rowsByParent };
};

// ============ 增量扫描：只重读变更分支 ============
// 根目录 mtime 或某直接子目录 mtime 与上次同步不符 → 说明这层有增删改，
// 才真正 readDir 该目录；没变的子目录直接从 DB 行重建（零磁盘读）。
// 返回值 dirty=false 说明磁盘与索引一致，调用方可跳过 sync。

const nodeAggDiffers = (row, node) => {
  const extra = extraOf(row);
  return (
    node.kind !== rowToNodeKind(row) ||
    node.count !== (extra.count ?? 0) ||
    node.videoCount !== (extra.videoCount ?? 0) ||
    node.imageCount !== (extra.imageCount ?? 0) ||
    node.childCount !== (extra.childCount ?? 0)
  );
};

const sameAsMergedFavorite = (row, node) => {
  if (!node) return false;
  const packed = row.mediaType != null;
  if (!packed) return node.kind === "group";
  const extra = extraOf(row);
  return (
    node.kind !== "group" &&
    node.count === (extra.count ?? 0) &&
    node.videoCount === (extra.videoCount ?? 0) &&
    node.imageCount === (extra.imageCount ?? 0) &&
    node.childCount === (extra.childCount ?? 0)
  );
};

// entryMtime：当前目录作为父列表子项时报告的 mtime。桌面端 selfMtime（目录自身
// mtime）权威；个别场景（mock/无 mtime 的环境）用父列表里的子项 mtime 当指纹持久化，
// 父级的"子目录未变 → 从 DB 行重建"判断（row.mtime === e.mtime）才能命中。
const scanTree = async (base, favoriteName, maxDepth, rowsByKey, rowsByParent, depth, entryMtime = null) => {
  const comics = [];
  if (depth > maxDepth) return { node: null, comics, dirty: false, rootMtime: null };
  const meta = await readDirMeta(base);
  if (!meta) return { node: null, comics, dirty: false, rootMtime: null };

  const directFiles = [];
  const children = [];
  let dirty = false;
  const diskDirNames = new Set();
  const diskFileNames = new Set();

  for (const e of meta.entries) {
    if (e.name.startsWith(".")) continue;
    const full = joinPath(base, e.name);
    if (e.isDir) {
      diskDirNames.add(e.name);
      const childKey = canonKey(full);
      const row = rowsByKey.get(childKey);
      // 子目录 mtime 与索引一致 → 整棵子树没变，从 DB 行重建
      if (row && row.mtime != null && e.mtime != null && row.mtime === e.mtime) {
        const sub = buildSubtreeFromRows(row, rowsByParent, favoriteName);
        if (sub) children.push(sub);
        continue;
      }
      const res = await scanTree(full, favoriteName, maxDepth, rowsByKey, rowsByParent, depth + 1, e.mtime ?? null);
      if (res.node) children.push(res.node);
      dirty = dirty || res.dirty;
      for (const c of res.comics) comics.push(c);
      continue;
    }
    diskFileNames.add(e.name);
    if (isComicFile(e.name)) {
      comics.push({
        name: e.name,
        key: canonKey(full),
        path: full,
        ext: extOf(e.name),
        kind: "comic",
        folder: favoriteName,
        dir: base,
        mtime: e.mtime ?? null,
      });
      continue;
    }
    if (isVideo(e.name) || isImage(e.name)) directFiles.push(e.name);
  }

  // 删除检测：索引里有、磁盘 listing 里没有的直接子条目 → 脏，交给 sync 标记 missing
  const baseKey = canonKey(base);
  const known = rowsByParent.get(baseKey) || [];
  for (const r of known) {
    if (r.kind === "pack" || r.kind === "group") {
      if (!diskDirNames.has(r.name)) dirty = true;
    } else if (r.kind === "comic") {
      if (!diskFileNames.has(r.name)) dirty = true;
    }
  }

  children.sort(byName);
  // directFiles 是文件名（字符串）数组，不能复用对象比较器 byName（a.name 会崩）
  directFiles.sort((a, b) => a.localeCompare(b, "zh-Hans-CN", { numeric: true }));
  const dirName = leafName(base);
  const videoCount = directFiles.filter(isVideo).length;
  const imageCount = directFiles.length - videoCount;

  const nodeMtime = meta.selfMtime ?? entryMtime ?? null;

  let node = null;
  if (directFiles.length) {
    const kind = packKindFor(videoCount, imageCount);
    node = {
      name: dirName,
      key: baseKey,
      path: base,
      dir: base,
      folder: favoriteName,
      kind,
      ext: kind === "video-folder" ? "video" : kind === "image-folder" ? "image" : "media",
      count: directFiles.length,
      videoCount,
      imageCount,
      childCount: children.length,
      children,
      files: directFiles
        .map((n) => ({ name: n, path: joinPath(base, n), ext: extOf(n), mtime: null }))
        .sort(byName),
      mtime: nodeMtime,
    };
  } else if (children.length) {
    node = {
      name: dirName,
      key: baseKey,
      path: base,
      dir: base,
      folder: favoriteName,
      kind: "group",
      ext: "group",
      count: children.reduce((sum, c) => sum + c.count, 0),
      videoCount: children.reduce((sum, c) => sum + c.videoCount, 0),
      imageCount: children.reduce((sum, c) => sum + c.imageCount, 0),
      childCount: children.length,
      children,
      files: [],
      mtime: nodeMtime,
    };
  }

  // 与索引行比对：新节点（无行）或形状/计数变化 → 脏
  const row = rowsByKey.get(baseKey);
  if (node) {
    if (!row) dirty = true;
    else if (row.kind === "favorite") {
      if (!sameAsMergedFavorite(row, node)) dirty = true;
    } else if (nodeAggDiffers(row, node)) dirty = true;
    // 结构一致但 mtime 索引缺失/过期（旧库 mtime 为 NULL）→ 仍需 sync 写回，
    // 否则下次扫描永远进不了 DB 快路径，每次进出都全量 readDir。
    // 注意 row 可能为 undefined（磁盘新目录尚无索引行）：上面已置 dirty，
    // 这里必须跳过 mtime 比较，否则读 undefined.mtime 抛 TypeError，
    // 导致含新子目录的收藏（如 Movies/Telegram）扫描整体失败、计数归 0。
    if (row && row.mtime !== node.mtime) dirty = true;
  } else if (row) {
    // 磁盘上该目录已无媒体但也未见空目录本身 → 目录消失/变空，索引有残留
    dirty = true;
  }

  return { node, comics, dirty, rootMtime: meta.selfMtime ?? null };
};

// ============ 对外入口 ============
// A folder with direct media files is a pack; a folder made of media subfolders is a group.
// rows 可选：多目录循环调用方（Display 收藏总览、Home scanAll）先 invoke("list_items")
// 一次，把所有收藏夹的扫描共享同一份索引行，避免每目录一次全量 IPC。
export const scanFavoriteTree = async (root, favoriteName, maxDepth = 12, rows = null) => {
  // 1) 先读索引行 + 根目录元数据（一次 IPC + 一次 readDir root，绝不深层递归）
  if (rows == null) {
    try {
      rows = await invoke("list_items");
    } catch (error) {
      console.error("list_items failed:", error);
    }
  }
  const { rowsByKey, rowsByParent } = indexRows(rows);
  const favKey = canonKey(root);
  const rootRow = rowsByKey.get(favKey);
  const meta = await readDirMeta(root);
  if (!meta) {
    // 根目录不可读：返回空结果，dirty=true 让调用方 sync 把子树标记 missing
    return { comics: [], packs: [], root: null, count: 0, rootMtime: null, dirty: true };
  }

  // 2) 快路径：根 mtime 一致 且 直接子目录 mtime 全一致 → 整棵树从 DB 重建
  if (
    rootRow &&
    rootRow.kind === "favorite" &&
    rootRow.mtime != null &&
    meta.selfMtime != null &&
    rootRow.mtime === meta.selfMtime
  ) {
    let fresh = true;
    // 校验根的直接媒体文件数与 favorite 行的合并形状一致（防止历史残留的
    // mediaType：根目录已无直接媒体但行里还标记为 pack）→ 不一致则放弃快路径
    const diskMediaCount = meta.entries.filter((e) => !e.isDir && (isVideo(e.name) || isImage(e.name))).length;
    const favMerged = rootRow.mediaType != null;
    if (favMerged !== diskMediaCount > 0) fresh = false;
    if (fresh) {
      for (const e of meta.entries) {
        if (!e.isDir) continue;
        // 隐藏子目录（如 Syncthing .stversions）不参与索引，快路径也跳过，
        // 否则它没有 DB 行 → 永远 fresh=false → 每次退化成全量扫描。
        if (e.name.startsWith(".")) continue;
        const childRow = rowsByKey.get(canonKey(joinPath(root, e.name)));
        if (!childRow || childRow.mtime == null || e.mtime == null || childRow.mtime !== e.mtime) {
          fresh = false;
          break;
        }
      }
    }
    if (fresh) {
      return buildDbTree(rows, favKey, favoriteName, rootRow);
    }
  }

  // 3) 增量/全量路径：按 mtime 逐层判定，未变子树从行重建，变更分支才真正读盘
  const res = await scanTree(root, favoriteName, maxDepth, rowsByKey, rowsByParent, 0);
  const rootNode = res.node;
  const packs = rootNode ? (rootNode.kind === "group" ? rootNode.children : [rootNode]) : [];
  const entries = rootNode ? (rootNode.kind !== "group" ? 1 : rootNode.children.length) : 0;
  return {
    comics: res.comics,
    packs,
    root: rootNode,
    count: res.comics.length + entries,
    rootMtime: meta.selfMtime ?? null,
    dirty: res.dirty,
  };
};

const packExtra = (node) => ({
  count: node.count ?? 0,
  videoCount: node.videoCount ?? 0,
  imageCount: node.imageCount ?? 0,
  childCount: node.childCount ?? 0,
});

// Flatten one favorite scan into DB item rows. The favorite root is always
// entry[0]. If the favorite root itself is a media pack (compact view), the
// pack fields are merged into the favorite row instead of emitting a second
// row with the same pathKey.
export const flattenScan = (result, favDir) => {
  const favPathKey = canonKey(favDir.path);
  const favName = favDir.name;
  const entries = [
    {
      pathKey: favPathKey,
      kind: "favorite",
      name: favName,
      mediaType: null,
      ext: null,
      parentPath: null,
      folder: null,
      size: null,
      mtime: result.rootMtime ?? null,
      extra: null,
    },
  ];

  const pushNode = (node, parentPath) => {
    const isPack = node.kind !== "group";
    const mediaType = !isPack
      ? null
      : node.kind === "video-folder"
        ? "video"
        : node.kind === "image-folder"
          ? "image"
          : "media";
    const nodeKey = canonKey(node.path) === favPathKey ? favPathKey : node.key;

    if (isPack && canonKey(node.path) === favPathKey) {
      const fav = entries[0];
      fav.mediaType = mediaType;
      fav.ext = node.ext;
      fav.mtime = node.mtime ?? result.rootMtime ?? null;
      fav.extra = packExtra(node);
    } else {
      entries.push({
        pathKey: nodeKey,
        kind: isPack ? "pack" : "group",
        mediaType,
        name: node.name,
        ext: node.ext ?? null,
        parentPath,
        folder: favName,
        size: null,
        mtime: node.mtime ?? null,
        extra: packExtra(node),
      });
    }

    for (const child of node.children ?? []) pushNode(child, nodeKey);
    for (const f of node.files ?? []) {
      entries.push({
        pathKey: canonKey(f.path),
        kind: isVideo(f.name) ? "video" : "image",
        name: f.name,
        ext: f.ext ?? null,
        parentPath: nodeKey,
        folder: favName,
        size: null,
        mtime: f.mtime ?? null,
        extra: null,
      });
    }
  };

  for (const p of result.packs) pushNode(p, favPathKey);
  for (const c of result.comics) {
    entries.push({
      pathKey: c.key,
      kind: "comic",
      name: c.name,
      ext: c.ext,
      parentPath: canonKey(c.dir),
      folder: favName,
      size: null,
      mtime: c.mtime ?? null,
      extra: null,
    });
  }
  return entries;
};

// Entries[0] is the favorite row; the rest are the scanned items.
export const syncFavoriteToDb = async (favDir, entries) => {
  const [favorite, ...items] = entries;
  return invoke("sync_favorite", { favorite, entries: items });
};