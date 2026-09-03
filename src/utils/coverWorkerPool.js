// 封面/放映图共用的缩略 Worker 池（模块级共享）：
// 解码/缩放/编码全部在 Worker 里完成——浏览器原生 SIMD 解码
// （比任何纯 Rust 解码器快），且完全离开 JS 主线程。
// 图包页封面（600px）与放映器大图下采样（≤4096px）复用同一批 Worker；
// 字节经 transferable 零拷贝往返。
//
// 使用：const { blob, width, height } = await workerDownscale(bytes, mime, maxEdge, fmt)
// maxEdge = 目标长边（≤maxEdge 的图不会被放大，只会按比例缩小）。
// fmt = 'jpeg' | 'webp'（默认 webp）。封面缩略图用 'jpeg'：真机实测
// WebView 解 600px JPEG 比 WebP 快 ~3.3x，且体积相当。

import { recordTiming } from "./coverTiming";

const WORKER_COUNT = 4;
const coverWorkers = [];
let workerRR = 0;
let workerSeq = 0;
const workerPending = new Map();

const makeCoverWorker = () => {
  const w = new Worker(new URL("./coverWorker.js", import.meta.url), { type: "module" });
  w.onmessage = (e) => {
    const { id, ok, bytes, width, height, error, decodeMs, encodeMs } = e.data || {};
    const p = workerPending.get(id);
    if (!p) return;
    workerPending.delete(id);
    if (ok) {
      recordTiming("worker.decode", decodeMs);
      recordTiming("worker.encode", encodeMs);
      if (p.startedAt) recordTiming("worker.total", Date.now() - p.startedAt);
      p.resolve({
        blob: new Blob([bytes], { type: p.fmt === "jpeg" ? "image/jpeg" : "image/webp" }),
        width: width ?? null,
        height: height ?? null,
      });
    } else {
      p.reject(new Error(error || "cover worker failed"));
    }
  };
  w.onerror = () => {
    // Worker 崩溃：拒绝它名下所有挂起请求并移出池子，之后按需重建
    for (const [id, p] of [...workerPending]) {
      if (p.worker === w) {
        workerPending.delete(id);
        p.reject(new Error("cover worker crashed"));
      }
    }
    const idx = coverWorkers.indexOf(w);
    if (idx >= 0) coverWorkers.splice(idx, 1);
    try {
      w.terminate();
    } catch {
      /* ignore */
    }
  };
  return w;
};

const getCoverWorker = () => {
  if (coverWorkers.length < WORKER_COUNT) coverWorkers.push(makeCoverWorker());
  if (!coverWorkers.length) coverWorkers.push(makeCoverWorker());
  const w = coverWorkers[workerRR % coverWorkers.length];
  workerRR++;
  return w;
};

/**
 * 在 Worker 里把图片缩放为长边 ≤ maxEdge 的缩略图。
 * @param {Uint8Array} bytes 原始图片字节
 * @param {string} mime 原图 MIME（createImageBitmap 用）
 * @param {number} maxEdge 目标长边
 * @param {'jpeg'|'webp'} [fmt] 输出格式，默认 webp
 * @returns {Promise<{blob: Blob, width: number|null, height: number|null}>}
 */
export const workerDownscale = (bytes, mime, maxEdge, fmt = "webp") =>
  new Promise((resolve, reject) => {
    const id = ++workerSeq;
    const w = getCoverWorker();
    workerPending.set(id, { resolve, reject, worker: w, startedAt: Date.now(), fmt });
    // 尽量零拷贝传输：视图与底层 buffer 对齐时直接 transfer
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
      w.postMessage({ id, bytes, maxEdge, mime, fmt }, [bytes.buffer]);
    } else {
      w.postMessage({ id, bytes: bytes.slice(), maxEdge, mime, fmt });
    }
  });
