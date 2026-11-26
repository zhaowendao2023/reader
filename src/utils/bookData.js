// 阅读器与封面的对外入口。
//
// 具体实现分三层，本文件只做门面与编排：
//   coverCache.js    封面内存/磁盘缓存、批量读取、缓存清理
//   coverExtract.js  按媒体类型提取封面 Blob
//   本文件           统一 getCover（缓存 → 磁盘 → 提取 → 落盘）与书籍打开
import { openFile } from '../js/read';
import { basename, extname } from '@tauri-apps/api/path';
import {
  coverCache,
  coverPending,
  loadDiskCover,
  cacheAndSaveCover,
} from './coverCache';
import { recordTiming } from './coverTiming';
import { extractMediaCover } from './coverExtract';
import { canonKey } from './itemKey';

export {
  clearLoadDate,
  deleteFileData,
  ensureCoverCache,
  cleanupLegacyCoverCache,
} from './coverCache';

export const getBookInfo = async (path) => {
  const ext = await extname(path)
  const title = await basename(path, `.${ext}`)
  return { title, ext }
}

// 漫画/EPUB 封面：打开压缩包取封面，随后立即释放打开器。
const extractBookCover = async (path, key) => {
  const tO = performance.now()
  const book = await openFile(path)
  recordTiming("cover.open", performance.now() - tO)
  try {
    return cacheAndSaveCover(path, key, await book.getCover())
  } finally {
    await book.destroy?.()
  }
}

// 通用封面入口：comic 走开包解析，其余媒体按 kind 分发提取；
// 内存缓存、pending 去重与磁盘落盘对所有类型共用同一套流程。
export const getCover = async (path, kind = "comic") => {
  const key = canonKey(path)
  if (coverCache.has(key)) return coverCache.get(key)
  if (coverPending.has(key)) return coverPending.get(key)
  const pending = (async () => {
    const diskUrl = await loadDiskCover(path)
    if (diskUrl) return diskUrl
    if (kind === "comic") return await extractBookCover(path, key)
    const blob = await extractMediaCover(path, kind)
    return blob ? cacheAndSaveCover(path, key, blob) : null
  })()
  coverPending.set(key, pending)
  try {
    return await pending
  } finally {
    coverPending.delete(key)
  }
}

export const getBookCover = (path) => getCover(path, "comic")

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
export const getEPUB = (path) => openFile(path)
export const getMOBI = getEPUB

export const getTheme = async () => {
  return (await import('./theme')).theme
}
