import { remove, mkdir, readFile, writeFile, readTextFile, rename, stat, exists, readDir } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { openFile } from '../js/read';
import { basename, extname, BaseDirectory } from '@tauri-apps/api/path';
import { isImage, isVideo, joinPath, extOf } from './media';
import { workerDownscale } from './coverWorkerPool';
import { recordTiming, maybeFlushTiming } from './coverTiming';

export const getBookInfo = async (path) => {
  const ext = await extname(path)
  const title = await basename(path, `.${ext}`)
  return { title, ext }
}

// 封面：内存缓存 -> 磁盘缩略图缓存(v5, jpeg/webp + index.json) -> 从源文件读取（读后自动落盘，透明无感）
const isWindows = /Windows/i.test(navigator.userAgent)
const coverKey = (path) => (isWindows ? path.toLowerCase() : path)

const coverCache = new Map()
const coverHashCache = new Map()
const coverPending = new Map()

const CACHE_VERSION = 5
const COVER_BASE = BaseDirectory.AppData
const COVER_ROOT = 'cover-cache/v5'
const MANIFEST_FILE = 'cover-cache/index.json'
const LEGACY_COVER_DIR = 'resource/data'
const LEGACY_V2_COVER_DIR = 'cover-cache/v2'
const LEGACY_V3_COVER_DIR = 'cover-cache/v3'
const LEGACY_V4_COVER_DIR = 'cover-cache/v4'
// 封面卡片 CSS 宽通常 150~200px（auto-fill 网格），Windows 常见缩放 125%~150%：
// 需要锐利显示的物理宽度 = 卡片宽 × DPR，竖版封面长边 = 物理宽 × 1.414。
// 400 长边（283 宽）在 150% 屏上只够 ~189px 卡片，所以看着糊。
// 600 长边（424 宽）在 150% 屏上覆盖 ~283px 卡片、在 100% 屏上覆盖 ~424px 卡片，
// 像素量仅 400 的 2.25 倍（缓存约翻倍）；800 只对 200% 缩放 + 最宽卡片有必要。
const THUMB_MAX_EDGE = 600
const WEBP_QUALITY = 0.85
// v5 起缓存缩略图改用 JPEG：真机实测 WebView 解码 600px 时
// JPEG（libjpeg-turbo SIMD）比 WebP 快 ~3.3x（webp 4.9~8.1ms vs jpeg 1.3~2.3ms），
// 且 600px 下两者体积几乎相等（42~84KB vs 44~78KB），无大小代价。
// 热路径每次封面解码省 ~4ms，滚动时主线程解码卡顿明显减少。
const JPEG_QUALITY = 0.85
const COLLAGE_WIDTH = 400
const COLLAGE_HEIGHT = 566
const COLLAGE_MAX_ITEMS = 4
// 系列拼图素材收集深度：允许 group → … → 素材目录最多 4 层嵌套。
// 之前是 2，深层系列（系列 → 季 → 集 → 文件）的素材收集不到，
// 拼图结果为空导致三层以上文件夹没有封面。
const COLLAGE_DEPTH_LIMIT = 4
const COLLAGE_VISIT_LIMIT = 64

const byNameMedia = (a, b) => a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true });
const mimeForImage = (name) => {
  const ext = String(name).toLowerCase().split(".").pop()
  return {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    bmp: "image/bmp",
    svg: "image/svg+xml",
  }[ext] || ""
}

const getCoverId = async (path) => {
  const key = coverKey(path)
  let hash = coverHashCache.get(key)
  if (!hash) {
    hash = await calculateHash(key)
    coverHashCache.set(key, hash)
  }
  return hash
}
const coverDirFor = (id) => `${COVER_ROOT}/${id}`

let manifest = null
let manifestLoad = null
let manifestTimer = null
let manifestChain = Promise.resolve()

const loadManifest = async () => {
  if (manifest) return manifest
  if (!manifestLoad) {
    manifestLoad = (async () => {
      const empty = { version: CACHE_VERSION, covers: {} }
      try {
        const text = await readTextFile(MANIFEST_FILE, { baseDir: COVER_BASE })
        const parsed = JSON.parse(text)
        return parsed?.version === CACHE_VERSION && parsed?.covers ? parsed : empty
      } catch (error) {
        return empty
      }
    })()
  }
  try {
    manifest = await manifestLoad
  } finally {
    manifestLoad = null
  }
  return manifest
}

const scheduleManifestWrite = () => {
  if (manifestTimer) return
  manifestTimer = setTimeout(() => {
    manifestTimer = null
    flushManifest()
  }, 300)
}

const flushManifest = () => {
  manifestChain = manifestChain.then(async () => {
    if (!manifest) return
    const baseDir = COVER_BASE
    try {
      const data = new TextEncoder().encode(JSON.stringify(manifest))
      await mkdir('cover-cache', { baseDir, recursive: true })
      const tmp = 'cover-cache/index.json.tmp'
      await writeFile(tmp, data, { baseDir })
      try {
        await rename(tmp, MANIFEST_FILE, { baseDir })
      } catch (error) {
        await writeFile(MANIFEST_FILE, data, { baseDir })
      }
    } catch (error) {
      console.error('封面索引写入失败:', error)
    }
  })
}

const updateManifestEntry = async (id, meta) => {
  const current = await loadManifest()
  current.covers[id] = meta
  scheduleManifestWrite()
}

const removeManifestEntry = async (id) => {
  const current = await loadManifest()
  if (current.covers[id]) {
    delete current.covers[id]
    scheduleManifestWrite()
  }
}

const safeStat = async (path) => {
  try {
    return await stat(path)
  } catch (error) {
    return null
  }
}

// 会话级 stat 缓存：源文件在短时间内不会变（外部修改由重扫/删除流程感知），
// 缓存 stat 结果避免每张封面都重复 stat 一次大文件——手机存储上 stat 很贵，
// 是「进入已缓存文件夹时封面加载慢」的主要开销之一。
const statCache = new Map(); // coverKey -> { value: Promise<stat|null>, expire }
const STAT_TTL_MS = 60_000;
const cachedStat = async (path) => {
  const key = coverKey(path)
  const hit = statCache.get(key)
  if (hit && hit.expire > Date.now()) return hit.value
  const p = safeStat(path)
  statCache.set(key, { value: p, expire: Date.now() + STAT_TTL_MS })
  return p
}

const matchesMeta = (statInfo, meta) => {
  // 目录的 size 在不同实现/时刻下不稳定（NTFS 目录索引大小 vs 0），
  // 用它校验会把所有目录封面缓存判失效，导致每次进页面都重新提取
  // （视频抓帧/系列拼图重、易超时）→ 封面永远显示不出来。目录只校验 mtime。
  if (statInfo?.isDirectory) {
    if (meta.mtime != null && statInfo.mtime != null && statInfo.mtime.getTime() !== meta.mtime) return false
    return true
  }
  if (meta.size != null && statInfo?.size != null && statInfo.size !== meta.size) return false
  if (meta.mtime != null && statInfo?.mtime != null && statInfo.mtime.getTime() !== meta.mtime) return false
  return true
}

// 校验封面文件魔数，防止把损坏/异常字节（如经 JSON IPC 落盘的
// 数字数组文本）当封面显示；无效时返回 false 触发重新提取。
const looksLikeImage = (data) => {
  if (!data || data.length < 12) return false
  const b = (i) => data[i]
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return true // PNG
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return true // JPEG
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46) return true // GIF
  if (b(0) === 0x42 && b(1) === 0x4d) return true // BMP
  if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46) {
    // WebP: RIFF....WEBP
    return b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50
  }
  if (b(0) === 0x3c || (b(0) === 0xef && b(1) === 0xbb && b(2) === 0xbf)) return true // SVG/XML
  return false
}

// 主线程兜底实现：Worker 不可用/失败时用 canvas 解码重编码（保持旧行为）。
const makeCoverThumbMainThread = async (blob) => {
  let bitmap
  try {
    bitmap = await createImageBitmap(blob)
  } catch (error) {
    return { blob, format: 'raw', width: null, height: null }
  }
  const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  try {
    let canvas
    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(width, height)
    } else {
      canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
    }
    const ctx = canvas.getContext('2d')
    // 默认 imageSmoothingQuality 是 "low"（双线性），缩略图明显发虚；
    // 显式升到 "high"（双三次），配合更高的 THUMB_MAX_EDGE 才有锐利观感。
    if (ctx.imageSmoothingEnabled !== false) {
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
    }
    ctx.drawImage(bitmap, 0, 0, width, height)
    const thumb = typeof canvas.convertToBlob === 'function'
      ? await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })
      : await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY))
    if (!thumb || !thumb.size) throw new Error('jpeg thumbnail encode failed')
    return { blob: thumb, format: 'jpeg', width, height }
  } catch (error) {
    return { blob, format: 'raw', width: bitmap.width, height: bitmap.height }
  } finally {
    bitmap.close?.()
  }
}

// 封面缩略统一入口：优先共享 Worker 池（浏览器 SIMD 解码，离开主线程），
// 失败回退主线程 canvas。漫画/图包/视频帧的缩略图生成全部走这里。
const makeCoverThumb = async (blob) => {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const r = await workerDownscale(bytes, blob.type || '', THUMB_MAX_EDGE, 'jpeg')
    if (r && r.blob && r.blob.size) {
      return { blob: r.blob, format: 'jpeg', width: r.width ?? null, height: r.height ?? null }
    }
    throw new Error('worker thumb returned empty')
  } catch (error) {
    console.warn('cover worker thumb failed, falling back to main thread:', error)
    return makeCoverThumbMainThread(blob)
  }
}

// ===== 批量磁盘封面读取收集器 =====
// 热路径每个封面要打一次 plugin-fs readFile IPC，Android WebView 的 bridge
// 每次往返固定开销很大（~90ms/槽）。把同一 tick 内到达的读取请求汇成一批，
// 用一次 Rust 批量命令（read_cover_cache_batch）把所有文件并行读完，
// 一次 IPC 分摊 N 个封面 → 8N 次 IPC 变成 ~N/24 次。
// 返回的二进制是「[u32 LE len][bytes]...」长度前缀拼接，缺失条目 len=0xFFFFFFFF。
const MISSING = 0xffffffff;
const BATCH_MAX = 24; // 单批上限：兼顾报文大小与攒批延迟
const pendingReads = new Map(); // key(index) -> { id, fileName }
const batchWaiters = []; // 未满批时挂起的 { entries, resolve, reject }
let batchTimer = null;

const readFilesBulk = async (entries) => {
  // 一次 invoke 读出全部文件字节（cache_root 带版本段，Rust 侧有白名单校验）
  // 批级 5 秒超时兜底：个别文件/磁盘异常不应卡死整批等待者
  const res = await Promise.race([
    invoke("read_cover_cache_batch", { cacheRoot: COVER_ROOT, entries }),
    new Promise((res) => setTimeout(() => res(null), 5000)),
  ]);
  if (res === null) return entries.map(() => null);
  const buf = res instanceof ArrayBuffer ? res : new Uint8Array(res).buffer;
  const u8 = new Uint8Array(buf);
  const out = [];
  let off = 0;
  for (let i = 0; i < entries.length; i++) {
    if (off + 4 > u8.length) { out.push(null); continue; }
    const len = u8[off] | (u8[off+1] << 8) | (u8[off+2] << 16) | (u8[off+3] << 24) >>> 0;
    off += 4;
    if (len === MISSING || off + len > u8.length) { out.push(null); continue; }
    out.push(u8.subarray(off, off + len));
    off += len;
  }
  return out;
};

const flushBatch = async () => {
  batchTimer = null;
  const entries = batchWaiters.map((w) => w.entries).flat();
  const waiters = batchWaiters.splice(0);
  if (!entries.length) return;
  try {
    const chunks = await readFilesBulk(entries);
    let i = 0;
    for (const w of waiters) {
      const these = [];
      for (let k = 0; k < w.entries.length; k++) these.push(chunks[i++]);
      w.resolve(these);
    }
  } catch (error) {
    console.error("cover batch read failed:", error);
    for (const w of waiters) w.reject(error);
  }
};

const queueBatchRead = (entries) => {
  return new Promise((resolve, reject) => {
    batchWaiters.push({ entries, resolve, reject });
    if (batchWaiters.length >= BATCH_MAX) {
      // 攒满：立即冲刷
      if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
      flushBatch();
    } else if (!batchTimer) {
      // 攒批窗口：下一个宏任务（同一 tick 的并发请求全部汇总进来）
      batchTimer = setTimeout(flushBatch, 0);
    }
  });
};

// 读取单个封面缩略图文件字节（经由批量收集器）。
const readCacheFile = async (id, fileName) => {
  const chunks = await queueBatchRead([{ id, fileName }]);
  return chunks[0] || null;
};

const readDiskCoverBlob = async (path) => {
  try {
    const id = await getCoverId(path)
    const meta = (await loadManifest()).covers[id]
    if (!meta) return null
    const tS = performance.now()
    const statInfo = await cachedStat(path)
    recordTiming("disk.stat", performance.now() - tS)
    if (!matchesMeta(statInfo, meta)) return null
    const fileName = meta.format === 'raw' ? 'cover.raw' : meta.format === 'jpeg' ? 'cover.jpg' : 'cover.webp'
    // 读缩略图（批量命令 + 批级 5 秒超时兜底，防止异常把批卡死）
    const tR = performance.now()
    const data = await Promise.race([
      readCacheFile(id, fileName),
      new Promise((res) => setTimeout(() => res(null), 5000)),
    ])
    recordTiming("disk.readfile", performance.now() - tR)
    if (!data || !looksLikeImage(data)) return null
    const type = meta.format === 'raw' ? undefined : meta.format === 'jpeg' ? 'image/jpeg' : 'image/webp'
    return new Blob([data], { type })
  } catch (error) {
    return null
  }
}

export const loadDiskCover = async (path) => {
  try {
    const tE = performance.now()
    const blob = await readDiskCoverBlob(path)
    if (!blob) return null
    const key = coverKey(path)
    const url = URL.createObjectURL(blob)
    coverCache.set(key, url)
    recordTiming("enter.load", performance.now() - tE)
    maybeFlushTiming()
    return url
  } catch (error) {
    return null
  }
}

const saveDiskCover = async (path, blob) => {
  const id = await getCoverId(path)
  const statInfo = await safeStat(path)
  const dir = coverDirFor(id)
  const baseDir = COVER_BASE
  await mkdir(dir, { baseDir, recursive: true })
  // Rust 已出封面缩略图（webp 小图）的直接落盘，不在 JS 二次解码/编码；
  // 其余（漫画封面、gif、安卓 PNG 帧等）走 canvas 缩放重编码。
  // 阈值必须收紧到「真·缩略图」尺寸：漫画 CBZ 里的整页 webp 常达几百 KB，
  // 若原样落盘，磁盘缓存会存满整页大图——回读慢（设备实测峰值 554ms）、
  // 解码重、占内存，移动端滚动时封面弹入明显卡顿。>100KB 的 webp 一律
  // 走 worker 缩到 THUMB_MAX_EDGE（600px）再落盘。
  const PRE_THUMB_MAX_BYTES = 100 * 1024
  const preThumbed = blob.type === "image/webp" && blob.size < PRE_THUMB_MAX_BYTES
  let thumb = null
  if (!preThumbed) thumb = await makeCoverThumb(blob)
  const fileName = preThumbed ? "cover.webp" : thumb.format === "raw" ? "cover.raw" : "cover.jpg"
  const bytes = preThumbed ? await blob.arrayBuffer() : await thumb.blob.arrayBuffer()
  const tW = performance.now()
  await writeFile(`${dir}/${fileName}`, new Uint8Array(bytes), { baseDir })
  recordTiming("disk.write", performance.now() - tW)
  await updateManifestEntry(id, {
    // 目录 size 不稳定（NTFS 索引大小），存 null 避免下次读取时被
    // matchesMeta 判失效（matchesMeta 对目录本就只校验 mtime）。
    size: statInfo?.isDirectory ? null : (statInfo?.size ?? null),
    mtime: statInfo?.mtime ? statInfo.mtime.getTime() : null,
    width: preThumbed ? null : (thumb.width ?? null),
    height: preThumbed ? null : (thumb.height ?? null),
    format: preThumbed ? "webp" : thumb.format,
  })
}

export const getBookCover = async (path) => {
  const key = coverKey(path)
  if (coverCache.has(key)) return coverCache.get(key)
  if (coverPending.has(key)) return coverPending.get(key)
  const pending = (async () => {
    const diskUrl = await loadDiskCover(path)
    if (diskUrl) return diskUrl
    const tO = performance.now()
    const book = await openFile(path)
    recordTiming("cover.open", performance.now() - tO)
    let blob
    try {
      blob = await book.getCover()
      const url = URL.createObjectURL(blob)
      coverCache.set(key, url)
      saveDiskCover(path, blob).catch((error) => {
        console.error("封面缓存写入失败:", error)
      })
      return url
    } finally {
      await book.destroy?.()
    }
  })()
  coverPending.set(key, pending)
  try {
    return await pending
  } finally {
    coverPending.delete(key)
  }
}

/* ===== 媒体封面提取（视频帧 / 图包首图 / 系列拼图） ===== */

const readImageBlob = async (path) => {
  const bytes = await readFile(path)
  return new Blob([bytes], { type: mimeForImage(path) })
}

// 单张图片的封面：gif 保留动图走原链路；其余在共享 Worker 池里出
// jpeg 缩略图（v5 起与漫画/视频封面统一 jpeg，避免 webp 中间体双编码），
// 失败回退整图读取（主线程）。
const extractImageCover = async (path) => {
  if (extOf(path) === "gif") return readImageBlob(path);
  try {
    const bytes = await readFile(path);
    const r = await workerDownscale(bytes, mimeForImage(path), THUMB_MAX_EDGE, "jpeg");
    return r.blob;
  } catch (error) {
    console.warn("cover worker thumb failed:", path, error);
    return readImageBlob(path);
  }
};

const isAndroid = /Android/i.test(navigator.userAgent)

const grabVideoBlob = async (path) => {
  try {
    // Android 走 VideoPlugin（MediaMetadataRetriever），桌面走 mpv_grab_frame。
    // 两边都返回 PNG 字节数组。
    // seek：封面只取靠前的帧，跳过深 seek（桌面 mpv seek=0 走首帧快速路径，
    // 首帧黑场会自动回退 3s 采样；安卓 MMR 无黑场回退，直接取 1s 帧）。
    const cmd = isAndroid ? "video_grab_frame" : "mpv_grab_frame";
    const bytes = await invoke(cmd, { path, seek: isAndroid ? 1 : 0 })
    // Tauri 经 JSON IPC 返回 Vec<u8> 时是普通数字数组，必须转回
    // Uint8Array，否则 Blob 会把每个数字当字符串拼成垃圾字节。
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    return new Blob([u8], { type: "image/png" })
  } catch (error) {
    console.warn(`${isAndroid ? "video" : "mpv"} frame grab failed:`, path, error)
    return null
  }
}

const listDirMedia = async (dir) => {
  const raw = await readDir(dir)
  const files = raw.filter((e) => e.isFile && !e.name.startsWith("."))
  const dirs = raw.filter((e) => e.isDirectory && !e.name.startsWith(".")).sort(byNameMedia)
  return {
    videos: files.filter((f) => isVideo(f.name)).sort(byNameMedia),
    images: files.filter((f) => isImage(f.name)).sort(byNameMedia),
    dirs,
  }
}

// 取目录内前几个视频的帧：第一个抓帧失败（损坏/特殊编码/冷启动超时）就
// 尝试下一个，避免「排在第一位的视频恰好失败」导致整个 pack/系列无封面。
const VIDEO_TRY_LIMIT = 3;

const extractFirstImageInDir = async (dir) => {
  const { images } = await listDirMedia(dir)
  if (!images.length) return null
  return extractImageCover(joinPath(dir, images[0].name))
}

const extractFirstVideoInDir = async (dir) => {
  const { videos } = await listDirMedia(dir)
  if (!videos.length) return null
  for (const v of videos.slice(0, VIDEO_TRY_LIMIT)) {
    const blob = await grabVideoBlob(joinPath(dir, v.name))
    if (blob) return blob
  }
  return null
}

const extractFirstMediaInDir = async (dir) => {
  const { images, videos } = await listDirMedia(dir)
  if (images.length) return readImageBlob(joinPath(dir, images[0].name))
  for (const v of videos.slice(0, VIDEO_TRY_LIMIT)) {
    const blob = await grabVideoBlob(joinPath(dir, v.name))
    if (blob) return blob
  }
  return null
}

// 写入内存缓存并落盘，供拼图内联提取子项封面时复用。
const seedCover = (path, blob) => {
  if (!blob) return
  const key = coverKey(path)
  if (!coverCache.has(key)) coverCache.set(key, URL.createObjectURL(blob))
  saveDiskCover(path, blob).catch((error) => {
    console.error("封面缓存写入失败:", error)
  })
}

// 系列封面：不拼接，直接取第一个有封面的子文件夹封面（观感更接近真实封面）。
const collectFirstGroupCover = async (dir, depth, budget) => {
  if (depth > COLLAGE_DEPTH_LIMIT || budget.used >= COLLAGE_VISIT_LIMIT) return null
  budget.used++
  const { images, videos, dirs } = await listDirMedia(dir)
  // 优先第一个子文件夹：已有缓存封面直接用，否则向下递归找
  for (const d of dirs) {
    const child = joinPath(dir, d.name)
    const cached = await readDiskCoverBlob(child)
    if (cached) return cached
    const blob = await collectFirstGroupCover(child, depth + 1, budget)
    if (blob) return blob
  }
  // 没有子文件夹封面时退回直接媒体（首图 / 首视频帧）
  if (images.length) {
    const blob = await extractImageCover(joinPath(dir, images[0].name))
    if (blob) {
      seedCover(dir, blob)
      return blob
    }
  }
  if (videos.length) {
    // 首视频抓帧失败时尝试后续几个，避免坏文件/特殊编码堵死整个系列封面
    for (const v of videos.slice(0, VIDEO_TRY_LIMIT)) {
      const blob = await grabVideoBlob(joinPath(dir, v.name))
      if (blob) {
        seedCover(dir, blob)
        return blob
      }
    }
  }
  return null
}

const makeGroupCover = async (dir) => collectFirstGroupCover(dir, 0, { used: 0 })

const extractMediaCover = async (path, kind) => {
  switch (kind) {
    case "image":
      return extractImageCover(path)
    case "video":
      return grabVideoBlob(path)
    case "image-folder":
      return extractFirstImageInDir(path)
    case "video-folder":
      return extractFirstVideoInDir(path)
    case "media-folder":
      return extractFirstMediaInDir(path)
    case "group":
      return makeGroupCover(path)
    default:
      return null
  }
}

// 通用封面入口：漫画保持原链路，其余媒体按 kind 分发提取。
export const getCover = async (path, kind = "comic") => {
  if (kind === "comic") return getBookCover(path)
  const key = coverKey(path)
  if (coverCache.has(key)) return coverCache.get(key)
  if (coverPending.has(key)) return coverPending.get(key)
  const pending = (async () => {
    const diskUrl = await loadDiskCover(path)
    if (diskUrl) return diskUrl
    const blob = await extractMediaCover(path, kind)
    if (!blob) return null
    const url = URL.createObjectURL(blob)
    coverCache.set(key, url)
    saveDiskCover(path, blob).catch((error) => {
      console.error("封面缓存写入失败:", error)
    })
    return url
  })()
  coverPending.set(key, pending)
  try {
    return await pending
  } finally {
    coverPending.delete(key)
  }
}

export const peekCover = (path) => coverCache.get(coverKey(path)) || null;

export const clearCoverCache = () => {
  for (const url of coverCache.values()) URL.revokeObjectURL(url)
  coverCache.clear()
}

export const getComic = async (path) => {
  const startTime = performance.now();
  const book = await openFile(path)
  const openTime = performance.now();
  return {
    book,
    toces: book.toc,
    timing: {
      open: openTime - startTime,
      total: performance.now() - startTime,
      pages: book.sections.length,
    }
  }
}
export const getEPUB = async (path) => {
  const book = await openFile(path)
  return book
}

export const getMOBI = async (path) => {
  const book = await openFile(path)
  return book
}

export const clearLoadDate = async () => {
  if (manifestTimer) {
    clearTimeout(manifestTimer)
    manifestTimer = null
  }
  await manifestChain
  manifest = null
  manifestLoad = null
  manifestChain = Promise.resolve()
  await remove('cover-cache', {
    baseDir: COVER_BASE,
    recursive: true
  })
  await mkdir('cover-cache', {
    baseDir: COVER_BASE
  })
}

export const deleteFileData = async (id) => {
  await removeManifestEntry(id)
  const coverPath = `${COVER_ROOT}/${id}`;
  await remove(coverPath, {
    baseDir: COVER_BASE,
    recursive: true
  })
}

export const ensureCoverCache = async () => {
  await mkdir('cover-cache', { baseDir: COVER_BASE, recursive: true })
}

export const cleanupLegacyCoverCache = async () => {
  const legacyBases = new Set([null, COVER_BASE])
  for (const baseDir of legacyBases) {
    try {
      if (await exists(LEGACY_COVER_DIR, { baseDir })) {
        await remove(LEGACY_COVER_DIR, { baseDir, recursive: true })
      }
      // v2 缓存（400px 长边）在升到 v3（800px）后作废：文件与
      // index.json（version 字段不匹配会被丢弃）都无效，直接清掉避免残留。
      if (await exists(LEGACY_V2_COVER_DIR, { baseDir })) {
        await remove(LEGACY_V2_COVER_DIR, { baseDir, recursive: true })
      }
    } catch (error) {
      console.error('旧封面缓存清理失败:', error)
    }
  }
  // 版本不符 → 旧缓存目录整体作废，避免残留占用存储。
  try {
    const text = await readTextFile(MANIFEST_FILE, { baseDir: COVER_BASE })
    const parsed = JSON.parse(text)
    if (parsed && parsed.version !== CACHE_VERSION) {
      for (const legacy of [LEGACY_V3_COVER_DIR, LEGACY_V4_COVER_DIR]) {
        if (await exists(legacy, { baseDir: COVER_BASE })) {
          await remove(legacy, { baseDir: COVER_BASE, recursive: true })
        }
      }
      console.log(`封面缓存升级（v${parsed.version}→v${CACHE_VERSION}），旧缓存已清理`)
    }
  } catch (error) {
    // 无 manifest（全新安装）→ 无需清理
  }
}

export const getTheme = async () => {
  return (await import('./theme')).theme
}
