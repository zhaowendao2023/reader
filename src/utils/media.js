// Shared media-type detection. Video files go to the mpv player; images stay
// in the media aggregation until a proper image viewer is added.
export const VIDEO_EXTS = ["mp4", "mkv", "webm", "mov", "avi", "ts", "m2ts", "flv", "wmv"];
export const IMAGE_EXTS = ["jpg", "jpeg", "png", "webp", "gif"];
export const MEDIA_EXTS = [...VIDEO_EXTS, ...IMAGE_EXTS];

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

export const joinPath = (base, name) => {
  const sep = String(base).includes("\\") ? "\\" : "/";
  return base.endsWith(sep) ? base + name : base + sep + name;
};
