// ui-mock.js — Tauri API 模拟，用于在浏览器中验证 UI（仅开发/测试用）
(() => {
  if (window.__TAURI_INTERNALS__) return;

  const norm = (p) => String(p).replace(/\//g, "\\").toLowerCase();
  const normEnd = (p) => {
    let s = norm(p);
    while (s.endsWith("\\")) s = s.slice(0, -1);
    return s;
  };

  // 虚拟文件系统：key 为规范化目录路径（小写反斜杠）
  const bytesRef = {
    testbook: "/scripts/testbook.cbz",
    testbook2: "/scripts/testbook2.cbz",
    testbook3: "/scripts/testbook3.cbz",
    epub: "/scripts/testbook.epub",
    artpack: "/scripts/art-pack.png",
    artcover: "/scripts/art-cover.png",
  };
  const FS = {
    "f:": [
      { name: "Comics", isDir: true },
      { name: "Documents", isDir: true },
      { name: "Manga", isDir: true },
    ],
    "f:\\comics": [
      { name: "Test Series 1", isDir: true },
      { name: "Test Series 2.cbz", isDir: false, ref: "testbook3" },
      { name: "Novel.epub", isDir: false, ref: "epub" },
      { name: "Making Of.mp4", isDir: false, ref: null },
      { name: "Making Of 2.mp4", isDir: false, ref: null },
      { name: "Art Pack.jpg", isDir: false, ref: "artpack" },
      { name: "Cover Art.png", isDir: false, ref: "artcover" },
    ],
    "f:\\comics\\test series 1": [
      { name: "Test Series 1 - Vol 01.cbz", isDir: false, ref: "testbook" },
      { name: "Test Series 1 - Vol 02.cbz", isDir: false, ref: "testbook2" },
    ],
    "f:\\documents": [],
    "f:\\manga": [{ name: "Other Book.cbz", isDir: false, ref: "testbook2" }],
  };

  if (window.__PREFETCH_TEST_FILES__) {
    const extra = [];
    const count = Number(window.__PREFETCH_TEST_FILES__) || 0;
    for (let i = 1; i <= count; i++) {
      extra.push({ name: `Prefetch Vol ${String(i).padStart(3, "0")}.cbz`, isDir: false, ref: "testbook" });
    }
    FS["f:\\comics"] = [...FS["f:\\comics"], ...extra];
  }

  // 懒加载字节
  const bytesCache = new Map();
  const getBytes = async (ref) => {
    if (!ref) return new Uint8Array(0);
    if (!bytesCache.has(ref)) {
      const url = bytesRef[ref];
      const res = await fetch(url);
      if (!res.ok) throw new Error("mock: fetch failed " + url);
      bytesCache.set(ref, new Uint8Array(await res.arrayBuffer()));
    }
    return bytesCache.get(ref);
  };

  const findDir = (path) => {
    const k = normEnd(path);
    return FS[k] || null;
  };

  // 资源句柄
  const resources = new Map();
  let ridSeq = 1000;
  const storeRids = new Map(); // rid -> store path
  let storeSeq = 9000;

  // 内存 store 数据（预置测试数据）
  const mockData = {
    books: {},
    cssVars: { fontSize: 16, marginBottom: 1.5, letterSpacing: 2, lineHeight: 1.6 },
    theme: true,
    favoriteDirs: [
      { path: "F:\\Comics", name: "Comics" },
      { path: "F:\\Manga", name: "Manga" },
    ],
    mobileRoot: null,
  };

  const callbacks = new Map();
  let cbSeq = 1;

  // ===== 库索引假数据：sync_favorite 写入，list_items 读出 =====
  // 与 Rust sync.rs 的 items 行保持同名字段（camelCase），Home 的
  // 「扫描 → 落库 → 读行建视图」链路才能在浏览器里走通。
  const itemsTable = new Map();
  const rowOf = (entry) => ({
    id: entry.pathKey,
    kind: entry.kind,
    mediaType: entry.mediaType ?? null,
    name: entry.name,
    ext: entry.ext ?? null,
    pathKey: entry.pathKey,
    parentPath: entry.parentPath ?? null,
    folder: entry.folder ?? null,
    size: entry.size ?? null,
    mtime: entry.mtime ?? null,
    extra: entry.extra ?? null,
    createdAt: 1,
    updatedAt: 2,
    matchedTags: [],
  });

  // ===== mpv 假状态：浏览器里也能完整渲染播放器 UI =====
  const mpvState = {
    playing: true,
    paused: false,
    position: 0,
    duration: 342.0,
    speed: 1,
    path: "",
    codec: "h264",
  };
  let mpvLastTick = Date.now();

  const invoke = async (cmd, args = {}, options = {}) => {
    switch (cmd) {
      // ===== 业务命令 =====
      case "list_drives":
        return ["F:\\"];

      // ===== 库索引（对应 sync.rs / tags.rs 的命令） =====
      case "get_favorites":
        return mockData.favoriteDirs.map((d) => ({ pathKey: normEnd(d.path), name: d.name }));
      case "add_favorite":
        mockData.favoriteDirs.push({ path: args.path, name: args.name });
        return null;
      case "remove_favorite":
        mockData.favoriteDirs = mockData.favoriteDirs.filter((d) => normEnd(d.path) !== normEnd(args.path));
        return null;
      case "clear_library":
        itemsTable.clear();
        return null;
      case "sync_favorite": {
        const { favorite, entries = [] } = args;
        if (favorite) itemsTable.set(favorite.pathKey, rowOf(favorite));
        for (const e of entries) itemsTable.set(e.pathKey, rowOf(e));
        return { favorites: 1, entries: entries.length, missing: 0 };
      }
      case "list_items":
        return Array.from(itemsTable.values()).map((r) => JSON.parse(JSON.stringify(r)));
      case "library_meta":
        return { synced: itemsTable.size > 0 };

      // ===== fs =====
      case "plugin:fs|read_dir": {
        const dir = findDir(args.path);
        if (!dir) throw new Error("mock: dir not found " + args.path);
        return dir.map((e) => ({
          name: e.name,
          isFile: !e.isDir,
          isDirectory: !!e.isDir,
          isSymlink: false,
        }));
      }
      case "plugin:fs|exists": {
        const p = args.path;
        const k = normEnd(p);
        if (FS[k] !== undefined) return true;
        // 文件是否存在（在父目录列表中查找）
        const parts = k.split("\\");
        parts.pop();
        const parent = parts.join("\\");
        const list = FS[parent];
        if (list) {
          const name = k.split("\\").pop();
          const hit = list.find((e) => !e.isDir && norm(e.name) === name);
          if (hit) return true;
        }
        return false;
      }
      case "plugin:fs|mkdir":
        return null;
      case "plugin:fs|remove":
        return null;
      case "plugin:fs|open": {
        const p = args.path;
        const k = normEnd(p);
        const parts = k.split("\\");
        const name = parts.pop();
        const parent = parts.join("\\");
        const list = FS[parent];
        const entry = list && list.find((e) => !e.isDir && norm(e.name) === name);
        if (!entry) throw new Error("mock: open failed " + p);
        const rid = ++ridSeq;
        resources.set(rid, { path: k, ref: entry.ref, offset: 0 });
        return rid;
      }
      case "plugin:fs|fstat": {
        const h = resources.get(args.rid);
        if (!h) throw new Error("mock: bad rid " + args.rid);
        const bytes = await getBytes(h.ref);
        return {
          isFile: true, isDirectory: false, isSymlink: false,
          size: bytes.byteLength, mtime: null, atime: null, birthtime: null,
          readonly: false, fileAttributes: 0, dev: 0, ino: 0, mode: 0, nlink: 1, uid: 0, gid: 0, rdev: 0, blksize: 0, blocks: 0,
        };
      }
      case "plugin:fs|read": {
        const h = resources.get(args.rid);
        if (!h) throw new Error("mock: bad rid " + args.rid);
        const bytes = await getBytes(h.ref);
        const start = h.offset;
        const len = Math.min(args.len, bytes.byteLength - start);
        const out = new Uint8Array(args.len);
        out.fill(0);
        if (len > 0) out.set(bytes.subarray(start, start + len), 0);
        h.offset = start + len;
        // 末尾追加 8 字节大端 nread
        const withCount = new Uint8Array(args.len + 8);
        withCount.set(out, 0);
        const dv = new DataView(withCount.buffer);
        dv.setBigUint64(args.len, BigInt(len), false);
        return withCount.buffer;
      }
      case "plugin:fs|seek": {
        const h = resources.get(args.rid);
        if (!h) throw new Error("mock: bad rid " + args.rid);
        const bytes = await getBytes(h.ref);
        const size = bytes.byteLength;
        let off = args.offset;
        if (args.whence === 1) off = h.offset + args.offset;      // Current
        else if (args.whence === 2) off = size + args.offset;     // End
        h.offset = Math.max(0, Math.min(off, size));
        return h.offset;
      }
      case "plugin:fs|read_file": {
        const p = args.path;
        const k = normEnd(p);
        const parts = k.split("\\");
        const name = parts.pop();
        const parent = parts.join("\\");
        const list = FS[parent];
        const entry = list && list.find((e) => !e.isDir && norm(e.name) === name);
        if (!entry) throw new Error("mock: read_file not found " + p);
        const bytes = await getBytes(entry.ref);
        return bytes.buffer;
      }
      case "plugin:fs|write_file":
        return null;

      // ===== path =====
      case "plugin:path|extname": {
        const p = args.path;
        const m = /\.([^.\\/]+)$/.exec(p);
        return m ? m[1] : "";
      }
      case "plugin:path|basename": {
        const p = String(args.path).replace(/\\/g, "/").split("/").pop();
        if (args.ext) return p.slice(0, -("." + args.ext).length);
        return p;
      }
      case "plugin:path|dirname": {
        const p = String(args.path).replace(/\\/g, "/");
        const i = p.lastIndexOf("/");
        return i < 0 ? "." : p.slice(0, i).replace(/\//g, "\\");
      }

      // ===== store =====
      case "plugin:store|load": {
        const rid = ++storeSeq;
        storeRids.set(rid, args.path);
        return rid;
      }
      case "plugin:store|get_store":
        return null;
      case "plugin:store|get": {
        const key = args.key;
        const v = mockData[key];
        return v === undefined ? [null, false] : [JSON.parse(JSON.stringify(v)), true];
      }
      case "plugin:store|set": {
        mockData[args.key] = args.value;
        return null;
      }
      case "plugin:store|save":
        return null;
      case "plugin:store|delete": {
        delete mockData[args.key];
        return null;
      }
      case "plugin:store|has":
        return mockData[args.key] !== undefined;
      case "plugin:store|keys":
        return Object.keys(mockData);

      // ===== dialog =====
      case "plugin:dialog|open":
        return null;

      // ===== window / event =====
      case "plugin:window|create":
      case "plugin:window|start_dragging":
      case "plugin:window|close":
      case "plugin:event|emit":
      case "plugin:event|listen":
      case "plugin:event|unlisten":
      case "plugin:resources|close":
        return null;

      // ===== mpv =====
      case "mpv_play":
        mpvState.playing = true;
        mpvState.paused = false;
        mpvState.position = 0;
        mpvState.duration = 342.0;
        mpvState.path = args.path || "";
        mpvLastTick = Date.now();
        return null;
      case "mpv_pause":
        mpvState.paused = !!args.paused;
        return null;
      case "mpv_seek":
        mpvState.position = Math.max(0, Number(args.seconds) || 0);
        return null;
      case "mpv_get_state": {
        const now = Date.now();
        // 模拟播放推进（30x，便于截图看到进度条填充）
        if (mpvState.playing && !mpvState.paused) {
          mpvState.position = Math.min(
            mpvState.duration,
            mpvState.position + ((now - mpvLastTick) / 1000) * 30
          );
        }
        mpvLastTick = now;
        return JSON.parse(JSON.stringify(mpvState));
      }
      case "mpv_set_bounds":
      case "mpv_stop":
      case "mpv_stop_all":
      case "mpv_release":
        return null;
      case "mpv_get_volume":
        return Number(mockData.volume ?? 100);
      case "mpv_set_volume":
        mockData.volume = Math.max(0, Math.min(100, Number(args.volume) || 0));
        return mockData.volume;
      case "mpv_set_speed":
        mpvState.speed = Math.max(0.5, Math.min(2, Number(args.speed) || 1));
        return mpvState.speed;

      default:
        console.warn("[mock] unhandled invoke", cmd, args);
        return null;
    }
  };

  window.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback(cb, once = false) {
      const id = cbSeq++;
      callbacks.set(id, { cb, once });
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    metadata: { currentWindow: { label: "main", width: 1080, height: 720 } },
    convertFileSrc: (p) => p,
  };
  window.__UI_MOCK__ = { ready: true };
  console.log("[mock] Tauri internals mocked");
})();
