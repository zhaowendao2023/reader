// 封面缩略图 Worker（模块 worker）：
// 图片封面的解码/缩放/编码全部在 Worker 里完成——
// 用浏览器原生 SIMD 解码（比任何纯 Rust 解码器快），
// 且完全离开 JS 主线程（主线程只做队列调度，不卡 UI）。
// 输入：{ id, bytes, maxEdge, mime, fmt }（bytes 经 transferable 零拷贝传入）
// 输出：{ id, ok, bytes, width, height }（fmt='jpeg' 出 JPEG，否则 WebP，零拷贝返回）

let inFlight = 0;

self.onmessage = async (e) => {
  const { id, bytes, maxEdge, mime, fmt } = e.data || {};
  inFlight++;
  try {
    if (!bytes || !bytes.byteLength) throw new Error("empty bytes");
    const blob = new Blob([bytes], { type: mime || "image/jpeg" });
    const tDec = Date.now();
    const bitmap = await createImageBitmap(blob);
    const decodeMs = Date.now() - tDec;
    try {
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0, w, h);
      const tEnc = Date.now();
      const out = fmt === "jpeg"
        ? await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 })
        : await canvas.convertToBlob({ type: "image/webp", quality: 0.92 });
      const encodeMs = Date.now() - tEnc;
      const buf = await out.arrayBuffer();
      self.postMessage({ id, ok: true, bytes: buf, width: w, height: h, decodeMs, encodeMs }, [buf]);
    } finally {
      bitmap.close?.();
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  } finally {
    inFlight--;
  }
};
