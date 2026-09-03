// 封面链路耗时埋点（诊断用，采集完可整体移除）。
// 两种场景都量：
//  1) 冷提取：从源文件读解封面（JS 开包解析 / Rust 解压 / worker 解码 / worker 编码 / 写盘 / 单张总时长）；
//  2) 进入加载：已缓存封面从磁盘读回（disk.read / diskReadBlob）。
// 周期性写入 AppData/cover-cache/timing.json，手机端：
//   adb shell run-as com.tauri_app.reader cat cover-cache/timing.json
import { writeFile } from "@tauri-apps/plugin-fs";
import { BaseDirectory } from "@tauri-apps/api/path";

const agg = {}; // name -> { sum, count, max }
export const recordTiming = (name, ms) => {
  if (!Number.isFinite(ms) || ms < 0) return;
  const a = agg[name] || (agg[name] = { sum: 0, count: 0, max: 0 });
  a.sum += ms;
  a.count++;
  if (ms > a.max) a.max = ms;
};

let flushTimer = null;
let dirty = false;

export const maybeFlushTiming = () => {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    dirty = false;
    const out = {};
    for (const [k, a] of Object.entries(agg)) {
      out[k] = { avg: +(a.sum / a.count).toFixed(1), count: a.count, max: +a.max.toFixed(1) };
    }
    const data = new TextEncoder().encode(JSON.stringify(out, null, 2));
    try {
      // 与封面同一目录、同一种写入方式（Uint8Array + baseDir），确定可写
      await writeFile("cover-cache/timing.json", data, { baseDir: BaseDirectory.AppData });
    } catch (e) {
      /* 埋点失败不影响主流程 */
    }
  }, 1200);
};
