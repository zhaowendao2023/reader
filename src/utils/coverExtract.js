// 各类媒体的封面提取：视频抓帧、图片缩放、图包首图、系列/聚合目录取首个封面。
//
// 与 coverCache.js 的分工：这里只产出封面 Blob，缓存与落盘交给 coverCache。
// 提取全部是「打开文件/目录 → 解码 → 缩放」的重活，与缓存格式无关，
// 混在一起时改缓存版本号会牵动所有提取分支。
import { readFile, readDir } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { isImage, isVideo, joinPath, extOf, mimeForImage } from './media';
import { byName } from './libraryView';
import { workerDownscale } from './coverWorkerPool';
import {
  THUMB_MAX_EDGE,
  readDiskCoverBlob,
  seedCover,
} from './coverCache';

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
  const dirs = raw.filter((e) => e.isDirectory && !e.name.startsWith(".")).sort(byName)
  return {
    videos: files.filter((f) => isVideo(f.name)).sort(byName),
    images: files.filter((f) => isImage(f.name)).sort(byName),
    dirs,
  }
}

// 取目录内前几个视频的帧：第一个抓帧失败（损坏/特殊编码/冷启动超时）就
// 尝试下一个，避免「排在第一位的视频恰好失败」导致整个 pack/系列无封面。
const VIDEO_TRY_LIMIT = 3;

// 系列封面收集预算：允许 group → … → 素材目录最多 4 层嵌套、最多访问 64 个目录。
const COLLAGE_DEPTH_LIMIT = 4
const COLLAGE_VISIT_LIMIT = 64

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

// 按条目类型分派封面提取；comic 由 bookData 走开包解析，不在此列。
export const extractMediaCover = async (path, kind) => {
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
