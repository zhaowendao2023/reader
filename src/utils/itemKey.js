// 条目路径的唯一入口：DB 主键 items.id = sha256(path_key)，与 Rust 侧 sync.rs
// 的写入必须一致，否则同一文件会出现两个 id（封面写到一个、删除清另一个）。
//
// Windows 路径大小写不敏感、斜杠可混用，统一成小写 + 反斜杠；其它平台保持原样。
// 前端所有「路径 → key / id」的换算都必须走这里，不要再各写一套 toLowerCase。
const isWindows = /Windows/i.test(navigator.userAgent);

export const canonKey = (path) => {
  const raw = String(path ?? "");
  return isWindows ? raw.toLowerCase().replace(/\//g, "\\") : raw;
};

const sha256Hex = async (text) => {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
};

// 同一进程内路径不会变，缓存 Promise 避免每次打开/预取都重算摘要。
const idCache = new Map();

export const itemId = (path) => {
  const key = canonKey(path);
  let pending = idCache.get(key);
  if (!pending) {
    pending = sha256Hex(key);
    idCache.set(key, pending);
  }
  return pending;
};
