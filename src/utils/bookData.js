import { remove, mkdir, readFile, writeFile, readTextFile, rename, stat, exists } from '@tauri-apps/plugin-fs';
import { openFile } from '../js/read';
import { basename, extname, BaseDirectory } from '@tauri-apps/api/path';

export const getBookInfo = async (path) => {
  const ext = await extname(path)
  const title = await basename(path, `.${ext}`)
  return { title, ext }
}

// 封面：内存缓存 -> 磁盘缩略图缓存(v2, webp + index.json) -> 从源文件读取（读后自动落盘，透明无感）
const isWindows = /Windows/i.test(navigator.userAgent)
const coverKey = (path) => (isWindows ? path.toLowerCase() : path)

const coverCache = new Map()
const coverHashCache = new Map()
const coverPending = new Map()

const CACHE_VERSION = 2
const COVER_BASE = BaseDirectory.AppData
const COVER_ROOT = 'cover-cache/v2'
const MANIFEST_FILE = 'cover-cache/index.json'
const LEGACY_COVER_DIR = 'resource/data'
const THUMB_MAX_EDGE = 400
const WEBP_QUALITY = 0.8

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

const matchesMeta = (statInfo, meta) => {
  if (meta.size != null && statInfo?.size != null && statInfo.size !== meta.size) return false
  if (meta.mtime != null && statInfo?.mtime != null && statInfo.mtime.getTime() !== meta.mtime) return false
  return true
}

const makeCoverThumb = async (blob) => {
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
    ctx.drawImage(bitmap, 0, 0, width, height)
    const thumb = typeof canvas.convertToBlob === 'function'
      ? await canvas.convertToBlob({ type: 'image/webp', quality: WEBP_QUALITY })
      : await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', WEBP_QUALITY))
    if (!thumb || !thumb.size) throw new Error('webp thumbnail encode failed')
    return { blob: thumb, format: 'webp', width, height }
  } catch (error) {
    return { blob, format: 'raw', width: bitmap.width, height: bitmap.height }
  } finally {
    bitmap.close?.()
  }
}

export const loadDiskCover = async (path) => {
  try {
    const key = coverKey(path)
    const id = await getCoverId(path)
    const meta = (await loadManifest()).covers[id]
    if (!meta) return null
    const statInfo = await safeStat(path)
    if (!matchesMeta(statInfo, meta)) return null
    const fileName = meta.format === 'raw' ? 'cover.raw' : 'cover.webp'
    // 读缩略图加 5 秒超时：个别文件/磁盘异常可能让 readFile 永久挂起，
    // 不加超时会卡死整个磁盘预热泵，后面的封面全部加载不出来。
    const data = await Promise.race([
      readFile(`${coverDirFor(id)}/${fileName}`, { baseDir: COVER_BASE }),
      new Promise((res) => setTimeout(() => res(null), 5000)),
    ])
    if (!data) return null
    const url = URL.createObjectURL(new Blob([data], { type: meta.format === 'raw' ? undefined : 'image/webp' }))
    coverCache.set(key, url)
    return url
  } catch (error) {
    return null
  }
}

const saveDiskCover = async (path, blob) => {
  const id = await getCoverId(path)
  const thumb = await makeCoverThumb(blob)
  const statInfo = await safeStat(path)
  const dir = coverDirFor(id)
  const baseDir = COVER_BASE
  await mkdir(dir, { baseDir, recursive: true })
  const fileName = thumb.format === 'raw' ? 'cover.raw' : 'cover.webp'
  await writeFile(`${dir}/${fileName}`, new Uint8Array(await thumb.blob.arrayBuffer()), { baseDir })
  await updateManifestEntry(id, {
    size: statInfo?.size ?? null,
    mtime: statInfo?.mtime ? statInfo.mtime.getTime() : null,
    width: thumb.width ?? null,
    height: thumb.height ?? null,
    format: thumb.format,
  })
}

export const getBookCover = async (path) => {
  const key = coverKey(path)
  if (coverCache.has(key)) return coverCache.get(key)
  if (coverPending.has(key)) return coverPending.get(key)
  const pending = (async () => {
    const diskUrl = await loadDiskCover(path)
    if (diskUrl) return diskUrl
    const book = await openFile(path)
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
    } catch (error) {
      console.error('旧封面缓存清理失败:', error)
    }
  }
}

export const getTheme = async () => {
  return (await import('./theme')).theme
}
