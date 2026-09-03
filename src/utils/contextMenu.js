import { reactive } from "vue";
import router from "../router/index";

export const contextMenuState = reactive({
  visible: false,
  x: 0,
  y: 0,
  items: [],
  confirming: null, // { id, label, message, confirmLabel, onConfirm }
  busy: false,
  error: "",
});

export const openContextMenu = ({ x, y, items = [] } = {}) => {
  contextMenuState.x = x;
  contextMenuState.y = y;
  contextMenuState.items = items.filter((item) => !item.hidden);
  contextMenuState.confirming = null;
  contextMenuState.busy = false;
  contextMenuState.error = "";
  contextMenuState.visible = true;
};

export const closeContextMenu = () => {
  contextMenuState.visible = false;
  contextMenuState.items = [];
  contextMenuState.confirming = null;
  contextMenuState.busy = false;
  contextMenuState.error = "";
};

export const requestConfirm = ({ id, label, message, confirmLabel = "确认", onConfirm }) => {
  contextMenuState.confirming = { id, label, message, confirmLabel, onConfirm };
  contextMenuState.busy = false;
  contextMenuState.error = "";
};

export const cancelConfirm = () => {
  contextMenuState.confirming = null;
  contextMenuState.busy = false;
  contextMenuState.error = "";
};

export const setMenuBusy = (busy) => {
  contextMenuState.busy = busy;
};

export const setMenuError = (error) => {
  contextMenuState.error = error;
};

// 空白区域右键/长按的通用菜单，桌面与移动端行为一致。
export const openGenericMenu = (x, y) => {
  openContextMenu({
    x,
    y,
    items: [
      {
        id: "back",
        label: "返回上一页",
        icon: "arrow-left",
        onSelect: () => {
          closeContextMenu();
          if (window.history.length > 1) router.back();
          else router.push("/");
        },
      },
      {
        id: "refresh",
        label: "刷新",
        icon: "refresh-cw",
        onSelect: () => {
          closeContextMenu();
          window.location.reload();
        },
      },
    ],
  });
};
