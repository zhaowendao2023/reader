// cdp-shot.mjs — 无头 Chrome 加载 ui-test.html 并逐视图截图
import fs from "node:fs";
import path from "node:path";
import { launchChrome, waitForTarget, wsConnect, sleep } from "./lib-cdp.mjs";

const PORT = 9333;
const OUT = process.argv[2] || path.resolve("scripts");
const APP_URL = "http://localhost:1420/ui-test.html";

const chrome = launchChrome(PORT);
let cdp;
try {
  const target = await waitForTarget(PORT);
  cdp = await wsConnect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Page.navigate", { url: APP_URL });

  const evalJs = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  const shot = async (name) => {
    const r = await cdp.send("Page.captureScreenshot", { format: "png" });
    const file = path.join(OUT, name);
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
    console.log("saved", file);
  };

  const waitFor = async (expr, timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        if (await evalJs(expr)) return;
      } catch {}
      await sleep(400);
    }
    throw new Error("timeout waiting: " + expr);
  };

  // 等应用挂载 + 首页扫描完成（计数不再是 …）
  await waitFor(`!!document.querySelector('.home-page') && !!document.querySelector('.hub-grid') && !document.querySelector('.hub-meta')?.textContent?.includes('…')`);
  await sleep(1200);

  // 展开侧边栏，展示三大入口
  await evalJs(`document.querySelectorAll('.tb-btn')[0]?.click(); true`);
  await sleep(700);
  await shot("shot-home-hub.png");

  // 漫画全量聚合
  await evalJs(`document.querySelector('.hub-card--comic')?.click(); true`);
  await waitFor(`!!document.querySelector('.home-page .book-grid')`);
  await sleep(2500);
  await shot("shot-home-comics.png");

  // 返回 + 视频图包聚合
  await evalJs(`document.querySelector('.back-btn')?.click(); true`);
  await sleep(500);
  await evalJs(`document.querySelector('.hub-card--media')?.click(); true`);
  await waitFor(`document.querySelector('.home-page .hero-title')?.textContent === '视频图包'`);
  await sleep(1500);
  await shot("shot-home-media.png");

  // 收藏视图
  await evalJs(`location.hash = '#/shelf'; true`);
  await waitFor(`!!document.querySelector('.fav-page .plate-grid')`);
  await sleep(2000);
  await shot("shot-shelf.png");

  // 文件夹预览（根目录）
  await evalJs(`location.hash = '#/browse'; true`);
  await waitFor(`!!document.querySelector('.browser .browser-list, .browser .browser-grid')`);
  await sleep(1200);
  await shot("shot-browse.png");

  console.log("DONE");
} finally {
  if (cdp) cdp.close();
  chrome.kill();
}
