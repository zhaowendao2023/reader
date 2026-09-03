import { invoke } from "@tauri-apps/api/core";

const SAVE_DEBOUNCE_MS = 500;

let progressMap = null;
let progressLoad = null;
let saveTimer = null;
let saveChain = Promise.resolve();

const loadProgress = () => {
  if (progressMap) return Promise.resolve(progressMap);
  if (!progressLoad) {
    progressLoad = invoke("get_progress")
      .then((rows) => {
        const map = {};
        for (const r of rows || []) {
          map[r.itemId] = {
            kind: r.kind || (typeof r.page === "number" ? "comic" : "video"),
            page: typeof r.page === "number" ? r.page : null,
            position: typeof r.position === "number" ? r.position : null,
            ts: r.updatedAt,
          };
        }
        return map;
      })
      .catch(() => ({}))
      .then((map) => {
        progressMap = map;
        return progressMap;
      });
  }
  return progressLoad;
};

const writeProgress = () => {
  const entries = Object.entries(progressMap).map(([itemId, v]) => ({
    itemId,
    kind: v.kind || (typeof v.page === "number" ? "comic" : "video"),
    page: typeof v.page === "number" ? v.page : null,
    position: typeof v.position === "number" ? v.position : null,
    ts: v.ts,
  }));
  saveChain = saveChain
    .then(() => invoke("save_progress_map", { entries }))
    .catch((error) => console.error("progress save failed:", error));
  return saveChain;
};

const scheduleWrite = () => {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeProgress();
  }, SAVE_DEBOUNCE_MS);
};

export const getProgress = async (bookId, total) => {
  const map = await loadProgress();
  const entry = map[bookId];
  const page = typeof entry?.page === "number" ? entry.page : 0;
  // 看完（进度满：已到最后一页/最后一屏）后，下次打开直接从初始页开始
  if (typeof total === "number" && total > 1 && page >= total - 1) return 0;
  return page;
};

export const setProgress = async (bookId, page) => {
  const map = await loadProgress();
  if (!map[bookId] || map[bookId].page !== page) {
    map[bookId] = { kind: "comic", page, position: null, ts: Date.now() };
  }
  scheduleWrite();
};

export const getVideoProgressEntry = async (itemId) => {
  const map = await loadProgress();
  const entry = map[itemId];
  if (!entry || entry.kind !== "video" || typeof entry.position !== "number") return null;
  return { position: entry.position, ts: entry.ts };
};

export const getVideoProgressMap = async () => {
  const map = await loadProgress();
  const out = {};
  for (const [itemId, v] of Object.entries(map)) {
    if (v.kind === "video" && typeof v.position === "number") {
      out[itemId] = { position: v.position, ts: v.ts };
    }
  }
  return out;
};

export const setVideoProgress = async (itemId, position) => {
  const map = await loadProgress();
  const value = Math.max(0, Number(position) || 0);
  if (!map[itemId] || map[itemId].position !== value) {
    map[itemId] = { kind: "video", page: null, position: value, ts: Date.now() };
  }
  scheduleWrite();
};

export const flushProgress = () => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!progressMap) return Promise.resolve();
  return writeProgress();
};

window.addEventListener("pagehide", () => {
  void flushProgress();
});
