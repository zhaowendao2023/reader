import { remove, mkdir, readFile, writeFile } from '@tauri-apps/plugin-fs';
import { openFile } from '../js/read';
import { basename, extname } from '@tauri-apps/api/path';
import { useBooks } from '../store/loadBooks';

export const getBookInfo = async (path) => {
  const ext = await extname(path)
  const title = await basename(path, `.${ext}`)
  return { title, ext }
}

// 封面：内存缓存 -> 磁盘缩略图缓存 -> 从源文件读取（读后自动落盘，透明无感）
const isWindows = /Windows/i.test(navigator.userAgent)
const coverKey = (path) => (isWindows ? path.toLowerCase() : path)

const coverCache = new Map()
const coverHashCache = new Map()
const coverPending = new Map()

const getCoverHashPath = async (path) => {
  const key = coverKey(path)
  let hash = coverHashCache.get(key)
  if (!hash) {
    hash = await calculateHash(key)
    coverHashCache.set(key, hash)
  }
  return `resource/data/${hash}`
}

export const loadDiskCover = async (path) => {
  try {
    const dir = await getCoverHashPath(path)
    const data = await readFile(dir + '/cover', { baseDir: useBooks().baseSrc })
    const url = URL.createObjectURL(new Blob([data]))
    coverCache.set(path, url)
    return url
  } catch (error) {
    return null
  }
}

const saveDiskCover = async (path, blob) => {
  const dir = await getCoverHashPath(path)
  await mkdir(dir, { baseDir: useBooks().baseSrc, recursive: true })
  await writeFile(dir + '/cover', new Uint8Array(await blob.arrayBuffer()), { baseDir: useBooks().baseSrc })
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
  await remove('resource/data', {
    baseDir: useBooks().baseSrc,
    recursive: true
  })
  await mkdir('resource/data', {
    baseDir: useBooks().baseSrc
  })
}

export const deleteFileData = async (id) => {
  const coverPath = "resource/data/" + id;
  await remove(coverPath, {
    baseDir: useBooks().baseSrc,
    recursive: true
  })
}

export const getTheme = async () => {
  return (await import('./theme')).theme
}
