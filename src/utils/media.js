// Shared media-type detection. Video files go to the mpv player; images stay
// in the media aggregation until a proper image viewer is added.
export const VIDEO_EXTS = ["mp4", "mkv", "webm", "mov", "avi", "ts", "m2ts", "flv", "wmv"];
export const IMAGE_EXTS = ["jpg", "jpeg", "png", "webp", "gif"];
export const MEDIA_EXTS = [...VIDEO_EXTS, ...IMAGE_EXTS];
export const COMIC_EXTS = ["cbz", "zip", "epub", "mobi"];

export const extOf = (name) => {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
};

export const isVideo = (value) => {
  const ext = extOf(value) || String(value || "").toLowerCase();
  return VIDEO_EXTS.includes(ext);
};

export const isImage = (value) => {
  const ext = extOf(value) || String(value || "").toLowerCase();
  return IMAGE_EXTS.includes(ext);
};

export const isComicFile = (name) => {
  const ext = extOf(name);
  return COMIC_EXTS.includes(ext);
};

export const packKindFor = (videoCount, imageCount) => {
  if (videoCount && imageCount) return "media-folder";
  if (videoCount) return "video-folder";
  if (imageCount) return "image-folder";
  return "";
};

export const joinPath = (base, name) => {
  const sep = String(base).includes("\\") ? "\\" : "/";
  return base.endsWith(sep) ? base + name : base + sep + name;
};

export const mimeForImage = (name) => {
  const ext = extOf(name);
  return {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    bmp: "image/bmp",
    svg: "image/svg+xml",
  }[ext] || "";
};

/**
 * 从图片文件头部读取宽高（不解码整图），返回 { w, h } 或 null。
 * 用于「按像素判断是否需要下采样」：解码成本按像素走，不能按文件字节数判断。
 * 支持 PNG / GIF / BMP / JPEG（含 progressive）/ WebP（VP8X/VP8L/VP8）。
 */
export const imageDims = (bytes) => {
  if (!bytes || bytes.length < 24) return null;
  const b = bytes;
  const rd16 = (i) => (b[i] << 8) | b[i + 1];
  const rd32 = (i) => (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];

  // PNG: 8 字节签名 + 4 长度 + 4 "IHDR" + 宽(4) 高(4)
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    if (b.length < 24) return null;
    return { w: rd32(16), h: rd32(20) };
  }
  // GIF: "GIF8" + 宽(LE16) 高(LE16)
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { w: b[6] | (b[7] << 8), h: b[8] | (b[9] << 8) };
  }
  // BMP: "BM" + ... + 宽(i32) 高(i32)，高度可负（自顶向下）
  if (b[0] === 0x42 && b[1] === 0x4d) {
    const w = rd32(18);
    const h = rd32(22);
    return { w, h: h < 0 ? -h : h };
  }
  // JPEG: SOI + 逐段扫描找 SOF0~15（基线/扩展/渐进），排除 C4/C8/CC
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const m = b[i + 1];
      if (m === 0xd9 || m === 0xda) return null; // EOI / SOS（其后是熵数据）
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { h: rd16(i + 5), w: rd16(i + 7) };
      }
      if (i + 3 >= b.length) return null;
      i += 2 + rd16(i + 2);
    }
    return null;
  }
  // WebP: RIFF....WEBP + VP8X/VP8L/VP8
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) {
    const four = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (four === "VP8X" && b.length >= 30) {
      return {
        w: 1 + b[24] + (b[25] << 8) + (b[26] << 16),
        h: 1 + b[27] + (b[28] << 8) + (b[29] << 16),
      };
    }
    if (four === "VP8L" && b.length >= 25) {
      const v = rd32(21);
      return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 };
    }
    if (four === "VP8 " && b.length >= 30) {
      // VP8 帧头：9D 01 2A 起始码后两个 16 位字段为
      // [低14位尺寸 | 高2位缩放]，小端字节序
      return {
        w: (b[26] | (b[27] << 8)) & 0x3fff,
        h: (b[28] | (b[29] << 8)) & 0x3fff,
      };
    }
  }
  return null;
};
