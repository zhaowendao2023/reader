// verify-dom.mjs — 无头 Chrome 中逐视图断言 DOM 状态（逻辑验证，无视觉依赖）
import { launchChrome, waitForTarget, wsConnect, sleep } from "./lib-cdp.mjs";

const PORT = 9334;
const APP_URL = "http://localhost:1420/ui-test.html";

const chrome = launchChrome(PORT);
let cdp;
const report = {};
const fail = (name, detail) => {
  report[name] = { ok: false, detail };
};
const pass = (name, detail) => {
  report[name] = { ok: true, detail };
};

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

  const waitFor = async (expr, timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        if (await evalJs(expr)) return true;
      } catch {}
      await sleep(400);
    }
    return false;
  };

  // ===== 主界面 hub =====
  const hubReady = await waitFor(
    `!!document.querySelector('.home-page .hub-grid') && !document.querySelector('.home-page .hub-meta')?.textContent?.includes('…')`
  );
  if (!hubReady) throw new Error("hub not ready");

  const hub = await evalJs(`({
    title: document.querySelector('.home-page .hero-title')?.textContent,
    cards: [...document.querySelectorAll('.home-page .hub-card .hub-name')].map(n => n.textContent.replace(/\\s+/g,' ').trim()),
    meta: document.querySelector('.home-page .hero-meta')?.textContent.replace(/\\s+/g,' ').trim(),
    nav: [...document.querySelectorAll('.nav-list .nav-item .nav-label')].map(n => n.textContent.trim()),
    activeNav: document.querySelector('.nav-item.active .nav-label')?.textContent.trim()
  })`);
  if (hub.title === "主界面" && hub.cards.length === 2 && hub.nav.join('|') === '主界面|收藏|文件夹预览')
    pass("hub", hub);
  else fail("hub", hub);

  // ===== 漫画全量聚合 =====
  await evalJs(`document.querySelector('.hub-card--comic')?.click(); true`);
  await waitFor(`!!document.querySelector('.home-page .book-grid')`);
  await sleep(1500);
  const comics = await evalJs(`({
    title: document.querySelector('.home-page .hero-title')?.textContent,
    count: document.querySelectorAll('.home-page .book-cell').length,
    folders: [...new Set([...document.querySelectorAll('.home-page .book-folder')].map(n => n.textContent.trim()))],
    names: [...document.querySelectorAll('.home-page .book-name')].map(n => n.textContent.trim())
  })`);
  if (comics.title === "漫画" && comics.count === 3 && comics.folders.length === 2)
    pass("comics", comics);
  else fail("comics", comics);

  // ===== 侧边栏「主界面」→ 回到双卡片 =====
  await evalJs(`document.querySelectorAll('.nav-item')[0]?.click(); true`);
  const resetHome = await waitFor(`document.querySelector('.home-page .hero-title')?.textContent === '主界面'`);
  if (resetHome && (await evalJs(`document.querySelectorAll('.home-page .hub-card').length`)) === 2)
    pass("reset-home", "点击主界面从漫画聚合页回到双卡片");
  else fail("reset-home", "未回到双卡片");

  // ===== 视频图包聚合 =====
  await evalJs(`document.querySelector('.back-btn')?.click(); true`);
  await sleep(500);
  await evalJs(`document.querySelector('.hub-card--media')?.click(); true`);
  await waitFor(`document.querySelector('.home-page .hero-title')?.textContent === '视频图包'`);
  await sleep(1200);
  const media = await evalJs(`({
    title: document.querySelector('.home-page .hero-title')?.textContent,
    count: document.querySelectorAll('.home-page .book-cell').length,
    names: [...document.querySelectorAll('.home-page .book-name')].map(n => n.textContent.trim()),
    extTags: [...document.querySelectorAll('.home-page .book-ext')].map(n => n.textContent.trim())
  })`);
  if (media.title === "视频图包" && media.count === 3 && media.extTags.some((t) => t.includes("集")) && media.names.some((n) => n.includes("Art Pack")))
    pass("media", media);
  else fail("media", media);

  // ===== 主界面视频图包：视频系列卡片 + 图包卡片均可点 =====
  await evalJs(`[...document.querySelectorAll('.home-page .book-cell')].find(n => n.textContent.includes('Art Pack'))?.click(); true`);
  const mediaViewerFromHome = await waitFor(`!!document.querySelector('.media-page img') && document.querySelector('.media-page img').src.startsWith('blob:')`);
  if (mediaViewerFromHome && (await evalJs(`document.querySelector('.media-page .pill-count')?.textContent.trim()`)) === "1 / 2")
    pass("media-viewer-home", "主界面图包卡片点击进入图包查看器");
  else fail("media-viewer-home", "图包查看器未打开");
  await evalJs(`history.back(); true`);
  await waitFor(`document.querySelector('.home-page .hero-title')?.textContent === '视频图包'`);

  // ===== 收藏 =====
  await evalJs(`location.hash = '#/shelf'; true`);
  await waitFor(`!!document.querySelector('.fav-page .plate-grid')`);
  await sleep(1500);
  const shelf = await evalJs(`({
    title: document.querySelector('.fav-page .hero-title')?.textContent,
    plates: document.querySelectorAll('.fav-page .plate').length,
    activeNav: document.querySelector('.nav-item.active .nav-label')?.textContent.trim()
  })`);
  if (shelf.title === "收藏" && shelf.plates === 2 && shelf.activeNav === "收藏")
    pass("shelf", shelf);
  else fail("shelf", shelf);

  // ===== 收藏夹内：漫画 + 视频 + 图包一起展示 =====
  await evalJs(`document.querySelector('.fav-page .plate')?.click(); true`);
  await waitFor(`!!document.querySelector('.fav-page .book-grid')`);
  await sleep(800);
  const folderItems = await evalJs(`({
    count: document.querySelectorAll('.fav-page .book-cell').length,
    names: [...document.querySelectorAll('.fav-page .book-name')].map(n => n.textContent.trim()),
    exts: [...document.querySelectorAll('.fav-page .book-ext')].map(n => n.textContent.trim())
  })`);
  if (
    folderItems.count === 6 &&
    folderItems.names.some((n) => n.includes("Making Of.mp4")) &&
    folderItems.names.some((n) => n.includes("Art Pack.jpg")) &&
    folderItems.exts.includes("MP4")
  )
    pass("shelf-folder-media", folderItems);
  else fail("shelf-folder-media", folderItems);

  // 点击视频 → 播放器（含播放列表）
  await evalJs(`[...document.querySelectorAll('.fav-page .book-cell')].find(n => n.textContent.includes('Making Of.mp4'))?.click(); true`);
  await waitFor(`!!document.querySelector('.video-page .bar-seek .seek')`);
  await sleep(900);
  const player = await evalJs(`({
    title: document.querySelector('.video-page .head-title')?.textContent.trim(),
    hasSeek: !!document.querySelector('.video-page .seek'),
    hasPlaylist: !!document.querySelector('.video-page .pl-list'),
    hasTime: (document.querySelector('.video-page .seek-time')?.textContent.trim() || "").includes(":")
  })`);
  if (player.hasSeek && player.hasPlaylist && player.hasTime && player.title.includes("Making Of"))
    pass("player", player);
  else fail("player", player);
  await evalJs(`history.back(); true`);
  await waitFor(`!!document.querySelector('.fav-page .book-grid')`);

  // 点击图包 → 图包查看器（同文件夹可翻页）
  await evalJs(`[...document.querySelectorAll('.fav-page .book-cell')].find(n => n.textContent.includes('Art Pack'))?.click(); true`);
  await waitFor(`!!document.querySelector('.media-page img') && document.querySelector('.media-page img').src.startsWith('blob:')`);
  await sleep(700);
  const viewer = await evalJs(`({
    counter: document.querySelector('.media-page .pill-count')?.textContent.trim(),
    title: document.querySelector('.media-page .head-title')?.textContent.trim(),
    imgOk: (document.querySelector('.media-page img')?.naturalWidth || 0) > 0
  })`);
  if (viewer.counter === "1 / 2" && viewer.imgOk)
    pass("media-viewer", viewer);
  else fail("media-viewer", viewer);
  await evalJs(`history.back(); true`);
  await waitFor(`!!document.querySelector('.fav-page .book-grid')`);

  // ===== 侧边栏「收藏」→ 回到文件夹总览 =====
  await evalJs(`document.querySelectorAll('.nav-item')[1]?.click(); true`);
  const resetShelf = await waitFor(`!!document.querySelector('.fav-page .plate-grid')`);
  if (resetShelf) pass("reset-shelf", "点击收藏从文件夹内回到收藏总览");
  else fail("reset-shelf", "未回到收藏总览");

  // ===== 文件夹预览 =====
  await evalJs(`location.hash = '#/browse'; true`);
  await waitFor(`!!document.querySelector('.browser .browser-list, .browser .browser-grid')`);
  await sleep(1200);
  const browse = await evalJs(`({
    root: document.querySelector('.browser .crumb.active')?.textContent.trim(),
    drives: [...document.querySelectorAll('.browser .entry-name, .browser .grid-name')].map(n => n.textContent.trim()),
    activeNav: document.querySelector('.nav-item.active .nav-label')?.textContent.trim()
  })`);
  if (browse.root === "根目录" && browse.drives.length === 1 && browse.drives[0] === "F:\\" && browse.activeNav === "文件夹预览")
    pass("browse", browse);
  else fail("browse", browse);

  // ===== 侧边栏「文件夹预览」→ 回到根目录 =====
  const clickEntry = (name) =>
    evalJs(`[...document.querySelectorAll('.browser .entry, .browser .grid-card')].find(n => n.textContent.includes(${JSON.stringify(name)}))?.click(); true`);
  await clickEntry("F:\\");
  await waitFor(`document.querySelector('.browser .crumb.active')?.textContent === 'F:\\'`);
  const driveEntries = await evalJs(`document.querySelectorAll('.browser .entry-name, .browser .grid-name').length`);
  await clickEntry("Comics");
  await waitFor(`document.querySelector('.browser .crumb.active')?.textContent === 'Comics'`);
  await evalJs(`document.querySelectorAll('.nav-item')[2]?.click(); true`);
  const resetBrowse = await waitFor(`document.querySelector('.browser .crumb.active')?.textContent === '根目录'`);
  if (resetBrowse && driveEntries === 3) pass("reset-browse", "点击文件夹预览从子目录回到根目录");
  else fail("reset-browse", { reset: resetBrowse, driveEntries });

  console.log(JSON.stringify(report, null, 2));
  const allOk = Object.values(report).every((r) => r.ok);
  process.exit(allOk ? 0 : 1);
} finally {
  if (cdp) cdp.close();
  chrome.kill();
}
