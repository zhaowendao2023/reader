// 标签自动配色：按标签名哈希从固定调色板取色，同一标签永远同色。
// 纯前端推导，不落库；新增调色板颜色时旧标签颜色会变，属可接受行为。
// 编辑画廊风格的 12 色调色板：明暗主题下均有足够对比与低饱和质感。
const PALETTE = [
  "#e5484d", // 朱砂
  "#f76b15", // 柿子
  "#eab308", // 金
  "#46a758", // 苔绿
  "#12a594", // 青瓷
  "#0090ff", // 天青
  "#6e56cf", // 紫檀
  "#d6409f", // 洋红
  "#0ea5e9", // 湖蓝
  "#e93d82", // 玫红
  "#ca8a04", // 琥珀
  "#8b5cf6", // 藤紫
];

export const tagColor = (name = "") => {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return PALETTE[h % PALETTE.length];
};

// 辅助：hex 色 → rgba，供 chip 背景/边框半透明混色。
export const hexToRgba = (hex, alpha) => {
  const h = String(hex).replace("#", "");
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};
