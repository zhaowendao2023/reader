#!/usr/bin/env node
// 下载 Windows 端依赖的 libmpv-2.dll 到 src-tauri/。
// 入库策略：DLL 不进 Git，由 pnpm 的 postinstall 自动拉取一次（也可手动 pnpm mpv:fetch）。
// 版本与哈希写死在下面；升级 libmpv 时同步改这里、src-tauri/NOTICE.md 和 docs 里的文档。
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { get } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_DIR = join(REPO_ROOT, 'src-tauri');
const TARGET_DLL = join(TARGET_DIR, 'libmpv-2.dll');

// zhongfly/mpv-winbuild 的 LGPL 变体（不含 GPL-only 组件），见 src-tauri/NOTICE.md。
const BUILD_TAG = '2026-11-26-1eab28e7b5';
const ARCHIVE_NAME = 'mpv-dev-lgpl-x86_64-20261126-git-1eab28e7b5.7z';
const ARCHIVE_SHA256 = '11a3542196c377fc2e8a1e9aa86acfd3b82ed2b738d057c238bd93e39d4847e9';
const DLL_SHA256 = '483a40e44c163984afb18155af5a1dfcdbb3bb462626362fd40dfbb251e2575e';

// 国内网络直连 github.com / gh-proxy 常常超时，把实测可用的镜像放在前面，直连兜底。
// 单个源空闲 30s 就换下一个，避免初始化阶段长时间空等。
const SOURCES = [
  `https://ghfast.top/https://github.com/zhongfly/mpv-winbuild/releases/download/${BUILD_TAG}/${ARCHIVE_NAME}`,
  `https://gh-proxy.com/https://github.com/zhongfly/mpv-winbuild/releases/download/${BUILD_TAG}/${ARCHIVE_NAME}`,
  `https://github.com/zhongfly/mpv-winbuild/releases/download/${BUILD_TAG}/${ARCHIVE_NAME}`,
];

// --force 重下；--soft 供 postinstall 用（失败只警告，不阻断 pnpm install）。
const force = process.argv.includes('--force');
const soft = process.argv.includes('--soft');

const log = (msg) => console.log(`[mpv] ${msg}`);
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

// 进度显示：TTY 下单行刷新进度条；管道/CI 下按里程碑打行，避免刷屏。
function createProgress(label) {
  const isTTY = process.stdout.isTTY === true;
  let startedAt = Date.now();
  let lastAt = startedAt;
  let lastBytes = 0;
  let lastRender = 0;
  let nextMilestone = 10;
  let finished = false;

  function speed(received, now) {
    const dt = (now - lastAt) / 1000;
    if (dt < 0.4) return null;
    const value = (received - lastBytes) / dt;
    lastAt = now;
    lastBytes = received;
    return value;
  }

  return {
    begin(total) {
      startedAt = lastAt = Date.now();
      lastBytes = 0;
      lastRender = 0;
      nextMilestone = 10;
      log(`${label} 开始（${total ? `共 ${mb(total)} MB` : '大小未知'}）`);
    },
    update(received, total) {
      const now = Date.now();
      const rate = speed(received, now);
      const ratio = total ? Math.min(received / total, 1) : null;

      if (isTTY) {
        if (now - lastRender < 150) return;
        lastRender = now;
        const width = 28;
        const filled = ratio === null ? 0 : Math.round(ratio * width);
        const bar = '#'.repeat(filled) + '-'.repeat(width - filled);
        const pct = ratio === null ? '  ?  ' : (ratio * 100).toFixed(1).padStart(5);
        const rateText = rate === null ? '' : `  ${mb(rate)} MB/s`;
        process.stdout.write(
          `\r  [${bar}] ${pct}%  ${mb(received)}/${total ? mb(total) : '?'} MB${rateText}`,
        );
        return;
      }

      // 非 TTY：只在整数里程碑打一行，日志里能看出节奏。
      if (ratio !== null) {
        if (ratio >= 0.999) finished = true;
        if (ratio * 100 < nextMilestone) return;
        nextMilestone = Math.min(100, Math.floor(ratio * 100 / 10) * 10 + 10);
        log(`  ${(ratio * 100).toFixed(0).padStart(3)}%  ${mb(received)}/${mb(total)} MB`);
      } else if (received >= nextMilestone * 1024 * 1024) {
        nextMilestone += 8;
        log(`  ${mb(received)} MB`);
      }
    },
    end(total) {
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (isTTY) {
        const width = 28;
        process.stdout.write(`\r  [${'#'.repeat(width)}] 100.0%  ${mb(total)}/${mb(total)} MB\n`);
      } else if (!finished) {
        log(`  100%  ${mb(total)} MB`);
      }
      log(`${label} 完成，用时 ${seconds}s`);
    },
  };
}

// 跟随重定向，把响应体写入 dest；空闲 120s 视为超时，避免卡死无提示。
function download(url, dest, progress, redirectsLeft = 5) {
  return new Promise((done, fail) => {
    const req = get(url, { headers: { 'user-agent': 'reader-fetch-mpv' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return fail(new Error('重定向次数过多'));
        const next = new URL(res.headers.location, url).toString();
        return download(next, dest, progress, redirectsLeft - 1).then(done, fail);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return fail(new Error(`HTTP ${res.statusCode}`));
      }

      const total = Number(res.headers['content-length'] || 0) || null;
      let received = 0;
      progress.begin(total);
      const out = createWriteStream(dest);
      res.on('data', (chunk) => {
        received += chunk.length;
        progress.update(received, total);
      });
      res.on('error', fail);
      res.pipe(out);
      out.on('finish', () => out.close(() => {
        progress.end(received);
        done();
      }));
      out.on('error', fail);
    });
    req.setTimeout(30_000, () => req.destroy(new Error('连接超时')));
    req.on('error', fail);
  });
}

async function main() {
  if (process.platform !== 'win32') {
    log('非 Windows 平台，无需 libmpv-2.dll，跳过。');
    return;
  }

  const existing = await stat(TARGET_DLL).catch(() => null);
  if (existing && !force) {
    log('发现已有 src-tauri/libmpv-2.dll，校验中…');
    const hash = await sha256File(TARGET_DLL);
    if (hash === DLL_SHA256) {
      log('已是指定构建，跳过。强制重下：pnpm mpv:fetch -- --force');
      return;
    }
    log(`哈希不符（现有 ${hash.slice(0, 12)}…），重新下载。`);
  }

  const workDir = await mkdtemp(join(tmpdir(), 'reader-mpv-'));
  const archive = join(workDir, ARCHIVE_NAME);
  try {
    let lastError;
    for (const url of SOURCES) {
      log(`源 ${url}`);
      try {
        await download(url, archive, createProgress('下载压缩包'));
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
        log(`  失败：${err.message}`);
        await rm(archive, { force: true });
      }
    }
    if (lastError) throw new Error(`所有源都失败，最后错误：${lastError.message}`);

    log('校验压缩包 sha256…');
    const archiveHash = await sha256File(archive);
    if (archiveHash !== ARCHIVE_SHA256) {
      throw new Error(`压缩包校验失败：期望 ${ARCHIVE_SHA256}，实际 ${archiveHash}`);
    }

    log('解压 libmpv-2.dll…');
    // Windows 自带 bsdtar（libarchive）能直接读 7z，省掉引入第三方解压依赖。
    const tar = spawnSync('tar', ['-C', TARGET_DIR, '-xf', archive, 'libmpv-2.dll'], {
      stdio: 'inherit',
    });
    if (tar.error) throw new Error(`调用 tar 失败：${tar.error.message}`);
    if (tar.status !== 0) throw new Error(`tar 解压失败，退出码 ${tar.status}`);

    log('校验 DLL sha256…');
    const dllHash = await sha256File(TARGET_DLL);
    if (dllHash !== DLL_SHA256) {
      throw new Error(`DLL 校验失败：期望 ${DLL_SHA256}，实际 ${dllHash}`);
    }
    const size = (await stat(TARGET_DLL)).size;
    log(`完成：src-tauri/libmpv-2.dll（${mb(size)} MB）。该文件已被 .gitignore 忽略。`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  if (soft) {
    console.warn(`[mpv] 跳过：${err.message}`);
    console.warn('[mpv] 视频功能会在缺 DLL 时不可用；联网后执行 pnpm mpv:fetch 补下。');
    return;
  }
  console.error(`[mpv] 失败：${err.message}`);
  process.exitCode = 1;
});
