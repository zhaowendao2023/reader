import { onUnmounted } from "vue";

// 桌面右键 / 移动端长按共用的单元格识别逻辑。
// resolveHit(cell) 返回当前条目，onHit(item, x, y) 打开该条目的自定义菜单。
export const useCellLongPress = ({ selector, resolveHit, onHit, onEmpty } = {}) => {
  let longPressTimer = null;
  let longPressStart = null;
  let suppressNextClick = false;
  let suppressResetTimer = null;

  const clearLongPress = () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    longPressStart = null;
  };

  const resetSuppressClick = () => {
    suppressNextClick = false;
    if (suppressResetTimer) {
      clearTimeout(suppressResetTimer);
      suppressResetTimer = null;
    }
  };

  const onTouchStart = (e) => {
    clearLongPress();
    const touch = e.touches?.[0] || e.changedTouches?.[0];
    if (!touch) return;
    longPressStart = { x: touch.clientX, y: touch.clientY };
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      suppressNextClick = true;
      const cell = e.target?.closest?.(selector);
      const hit = cell ? resolveHit?.(cell) : null;
      if (hit && onHit) onHit(hit, touch.clientX, touch.clientY);
      else onEmpty?.(touch.clientX, touch.clientY);
    }, 500);
  };

  const onTouchMove = (e) => {
    if (!longPressTimer || !longPressStart) return;
    const touch = e.touches?.[0];
    if (!touch) return;
    if (Math.hypot(touch.clientX - longPressStart.x, touch.clientY - longPressStart.y) > 10) {
      clearLongPress();
    }
  };

  const onTouchEnd = () => {
    clearLongPress();
    // 长按触发后若用户拖离松开、系统没有合成 click，标志会残留；
    // 延迟复位避免吞掉下一次正常点击。
    if (suppressNextClick && !suppressResetTimer) {
      suppressResetTimer = setTimeout(() => {
        suppressNextClick = false;
        suppressResetTimer = null;
      }, 800);
    }
  };

  const onTouchCancel = () => clearLongPress();

  const onCellClick = (fn) => {
    if (suppressNextClick) {
      resetSuppressClick();
      return;
    }
    fn();
  };

  onUnmounted(() => {
    clearLongPress();
    resetSuppressClick();
  });

  return { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel, onCellClick };
};
