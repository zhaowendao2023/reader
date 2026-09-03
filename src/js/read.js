import { open, readFile, SeekMode } from "@tauri-apps/plugin-fs"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { configure, TextWriter, BlobWriter, ZipReader, Reader } from '@zip.js/zip.js'
import { EPUB } from '../js/epub.js'
import { makeComicBook } from "./comic-book.js"
import { basename, extname } from "@tauri-apps/api/path"
import { recordTiming } from "../utils/coverTiming"

// 按需读取文件局部内容的 Reader：zip.js 只在需要时才通过
// FileHandle 读取对应字节段，避免把整个压缩包一次性传到前端。
class TauriRangeReader extends Reader {
  constructor(file, size) {
    super();
    this._file = file;
    this.size = size;
    this._lock = Promise.resolve();
  }
  init() {
    return Promise.resolve();
  }
  async readUint8Array(index, length) {
    const remaining = Math.max(0, Math.min(length, this.size - index));
    if (remaining <= 0) return new Uint8Array(0);
    // FileHandle 的 seek/read 共享同一文件偏移，必须串行执行，
    // 否则并发解压时各次读取会互相穿插，读到错误的字节。
    const run = this._lock.then(async () => {
      const file = this._file;
      const buf = new Uint8Array(remaining);
      let pos = index;
      let filled = 0;
      while (filled < remaining) {
        await file.seek(pos, SeekMode.Start);
        const n = await file.read(buf.subarray(filled));
        if (n === null || n === 0) break;
        filled += n;
        pos += n;
      }
      return buf.subarray(0, filled);
    });
    this._lock = run.catch(() => {});
    return run;
  }
}

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.jxl', '.avif']

const isImageName = name => {
  const lower = name.toLowerCase()
  return IMAGE_EXTS.some(ext => lower.endsWith(ext))
}

const mimeForImage = name => {
  const ext = name.toLowerCase().split('.').pop()
  return {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    bmp: 'image/bmp',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    jxl: 'image/jxl',
    avif: 'image/avif',
  }[ext] || ''
}

// Tauri IPC 的二进制返回值在不同 WebView/版本中可能是 Uint8Array、
// ArrayBuffer、TypedArray 或普通数字数组。统一转换后再交给 Blob，避免
// `new Blob([object])` 把对象序列化成字符串，导致阅读页所有图片都是坏图。
const toUint8Array = value => {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (Array.isArray(value)) return new Uint8Array(value)
  if (value && Array.isArray(value.data)) return new Uint8Array(value.data)
  throw new TypeError(`unsupported binary response: ${Object.prototype.toString.call(value)}`)
}

const hasImageSignature = (bytes, name) => {
  if (!bytes || bytes.byteLength < 4) return false
  const ext = name.toLowerCase().split('.').pop()
  if (ext === 'jpg' || ext === 'jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8
  if (ext === 'png') return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  if (ext === 'gif') return bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46
  if (ext === 'bmp') return bytes[0] === 0x42 && bytes[1] === 0x4d
  if (ext === 'webp') return bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
  // SVG/JXL/AVIF have several legal headers; non-empty data is sufficient here,
  // because the browser remains the final decoder of these less common formats.
  return bytes.byteLength > 0
}

// 真正执行 zip 打开/解析/关闭的构建函数（无缓存语义）。
const buildZipLoader = async (path, options = {}) => {
  configure({ useWebWorkers: false })
  const file = await open(path, { read: true })
  let zipReader = null
  let closed = false
  try {
    const info = await file.stat()
    zipReader = new ZipReader(new TauriRangeReader(file, info.size))
    const entries = await zipReader.getEntries()
    const map = new Map(entries.map(entry => [entry.filename, entry]))
    const load = f => (name, ...args) =>
      map.has(name) ? f(map.get(name), ...args) : null
    const loadText = load(entry => entry.getData(new TextWriter()))
    // Android 与桌面同为真实路径模型（MANAGE_EXTERNAL_STORAGE），
    // 走 Rust 原生解压（read_cbz_entry）比 WebView 内 zip.js 解压更快；
    // 失败时下方 catch 会自动回退 entry.getData，不会中断。
    const nativeImages = options.nativeImages && isTauri()
    const loadBlob = load(async (entry, type) => {
      if (nativeImages && isImageName(entry.filename)) {
        try {
          const t0 = performance.now()
          const buffer = await invoke('read_cbz_entry', {
            path,
            name: entry.filename,
          })
          recordTiming("arch.read", performance.now() - t0)
          const bytes = toUint8Array(buffer)
          if (!hasImageSignature(bytes, entry.filename)) {
            throw new TypeError(`native zip read returned invalid image data for ${entry.filename}`)
          }
          return new Blob([bytes], { type: mimeForImage(entry.filename) })
        } catch (error) {
          console.warn(`native zip read failed, falling back for ${entry.filename}`, error)
        }
      }
      return entry.getData(new BlobWriter(type))
    })
    const getSize = name => map.get(name)?.uncompressedSize ?? 0
    return {
      entries,
      loadText,
      loadBlob,
      getSize,
      destroy: async () => {
        if (closed) return
        closed = true
        try { await zipReader.close() } catch (error) { /* ignore */ }
        try { await file.close() } catch (error) { /* ignore */ }
      },
    }
  } catch (error) {
    try { await file.close() } catch (error2) { /* ignore */ }
    throw error
  }
}

const isWindows = /Windows/i.test(navigator.userAgent)
// Windows 下路径大小写不敏感、斜杠可混用：缓存 key 统一成小写 + 反斜杠
// （与 browserCache.canonKey 同构），避免同一文件两种写法生成两个缓存项、
// 双份文件句柄。
const zipCacheKey = (path) => (isWindows ? path.toLowerCase().replace(/\//g, "\\") : path)

// 按 path 单例化 zip 解析结果（引用计数 + 空闲延迟释放）：
// 大 CBZ（几千条目）的 central directory 只解析一次，同一路径的多位持有者
// （阅读页 getComic、封面提取 getBookCover）共享文件句柄与 entries/map，
// 避免每次开书重读目录、重建 Map。ZipReader 的 Entry.getData 闭包绑定到
// 同一个 reader，共享天然成立；TauriRangeReader._lock 把 seek/read 串行化，
// 多持有者并发读取同一个文件句柄也是安全的。
// 引用计数归零后延迟 ZIP_CACHE_IDLE_MS 才真正关闭文件：覆盖「阅读页 → 列表
// → 再打开同一本」的复用窗口；窗口内再次打开直接命中缓存，命中时取消定时器。
// options.cache 未开启时行为与原实现一致（EPUB 等暂不共享）。
const ZIP_CACHE_IDLE_MS = 60_000
const ZIP_CACHE_MAX = 32 // 缓存项上限：防止大批量封面预取时句柄堆积
const zipLoaderCache = new Map() // key -> { refs, loader, timer, promise, close }

// 缓存项超限时按插入顺序驱逐最旧的空闲项（refs 归零、仅剩 TTL 定时器的），
// 被阅读页持有的激活项不会被驱逐。Map 迭代顺序即插入顺序。
const evictIdleZipLoader = () => {
  if (zipLoaderCache.size <= ZIP_CACHE_MAX) return
  for (const [key, entry] of zipLoaderCache) {
    if (entry.refs > 0) continue
    if (entry.timer) clearTimeout(entry.timer)
    zipLoaderCache.delete(key)
    entry.close?.().catch(() => {})
    if (zipLoaderCache.size <= ZIP_CACHE_MAX) return
  }
}

const makeZipLoader = async (path, options = {}) => {
  if (!options.cache) return buildZipLoader(path, options)

  const key = zipCacheKey(path)
  const cached = zipLoaderCache.get(key)
  if (cached) {
    // 命中缓存：取消待释放定时器，复用同一解析结果
    cached.refs += 1
    if (cached.timer) {
      clearTimeout(cached.timer)
      cached.timer = null
    }
    return cached.promise
  }

  evictIdleZipLoader()
  const entry = { refs: 1, loader: null, timer: null, promise: null, close: null }
  zipLoaderCache.set(key, entry)
  entry.promise = buildZipLoader(path, options).then(loader => {
    entry.loader = loader
    entry.close = loader.destroy // 原始关闭（供驱逐/TTL 直接调用，绕过引用计数）
    loader.destroy = async () => {
      if (entry.refs <= 0) return
      entry.refs -= 1
      if (entry.refs > 0) return
      // 归零后延迟释放：短暂空闲内再次打开直接命中缓存
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = setTimeout(async () => {
        entry.timer = null
        if (entry.refs > 0) return
        zipLoaderCache.delete(key)
        try {
          await entry.close()
        } catch (error) {
          console.warn(`zip loader 释放失败: ${path}`, error)
        }
      }, ZIP_CACHE_IDLE_MS)
    }
    return loader
  })
  try {
    return await entry.promise
  } catch (error) {
    // 构建失败：清理缓存项，允许后续重新尝试
    zipLoaderCache.delete(key)
    throw error
  }
}

const isCBZ = (path) => {
  return path.toLowerCase().endsWith('.cbz')
}
const isZIP = (path) => {
  return path.toLowerCase().endsWith('.zip')
}

const isEPUB = (path) => {
  return path.toLowerCase().endsWith('.epub')
}

const isFB2 = ({ name, type }) => {
  return type === 'application/x-fictionbook+xml' || name.endsWith('.fb2')
}

export const openFile = async (path) => {
  const startTime = performance.now();

  let book
  let loader = null
  const ext = await extname(path)
  const name = await basename(path, `.${ext}`)

  if (isCBZ(path) || isZIP(path)) {
    loader = await makeZipLoader(path, { nativeImages: true, cache: true })
    book = makeComicBook(loader, {
      name: name
    })
  } else if (isEPUB(path)) {
    loader = await makeZipLoader(path)

    book = await new EPUB(loader).init()
  } else {
    const buffer = await readFile(path)
    const file = new File(
      [buffer], // 二进制数据（用数组包裹 Uint8Array）
      name, // 文件名（必须带 .mobi 后缀，方便识别）
      {
        lastModified: Date.now() // 最后修改时间（可选，默认当前时间）
      }
    );
    const { isMOBI, MOBI } = await import('./mobi.js')
    if (await isMOBI(path)) {
      const fflate = await import('./vendor/fflate.js')
      book = await new MOBI({ unzlib: fflate.unzlibSync }).open(file)
    }
    else if (isFB2(file)) {
      const { makeFB2 } = await import('./fb2.js')
      book = await makeFB2(file)
    }
  }

  book.name = name
  book.ext = ext
  if (loader) {
    const origDestroy = book.destroy
    book.destroy = () => {
      origDestroy?.()
      return loader.destroy?.()
    }
  }
  return book
}
