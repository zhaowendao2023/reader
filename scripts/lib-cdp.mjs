// lib-cdp.mjs — 无依赖 CDP 驱动公共模块（裸 socket WebSocket + Chrome 启动）
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";

// Chrome 路径不再写死：优先环境变量，其次常见安装位置；都找不到就明确报错。
const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
];
export const CHROME = process.env.CHROME_PATH || CHROME_CANDIDATES.find((p) => existsSync(p)) || "";
if (!CHROME) {
  throw new Error("未找到 Chrome：请设置 CHROME_PATH 指向 chrome 可执行文件");
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString("base64");
    const sock = net.connect(Number(u.port), u.hostname);
    let buf = Buffer.alloc(0);
    let opened = false;
    let gotError = false;
    let msgId = 0;
    const pending = new Map();
    let eventHandler = null;
    const frameQueue = [];
    let parsing = false;

    const fail = (e) => {
      if (gotError) return;
      gotError = true;
      reject(e);
      sock.destroy();
    };

    const sendFrame = (opcode, payload) => {
      const len = payload.length;
      let header;
      if (len < 126) {
        header = Buffer.from([0x80 | opcode, 0x80 | len]);
      } else if (len < 65536) {
        header = Buffer.from([0x80 | opcode, 0x80 | 126]);
        const ext = Buffer.alloc(2);
        ext.writeUInt16BE(len, 0);
        header = Buffer.concat([header, ext]);
      } else {
        header = Buffer.from([0x80 | opcode, 0x80 | 127]);
        const ext = Buffer.alloc(8);
        ext.writeBigUInt64BE(BigInt(len), 0);
        header = Buffer.concat([header, ext]);
      }
      const mask = crypto.randomBytes(4);
      const masked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
      sock.write(Buffer.concat([header, mask, masked]));
    };

    const sendJson = (obj) => sendFrame(0x1, Buffer.from(JSON.stringify(obj), "utf8"));

    const processFrames = () => {
      if (parsing) return;
      parsing = true;
      try {
        while (frameQueue.length) {
          const { opcode, payload } = frameQueue.shift();
          if (opcode === 0x8) {
            sock.destroy();
            return;
          }
          if (opcode === 0x9) {
            sendFrame(0xa, payload);
            continue;
          }
          if (opcode !== 0x1 && opcode !== 0x0) continue;
          let msg;
          try {
            msg = JSON.parse(payload.toString("utf8"));
          } catch {
            continue;
          }
          if (msg.id && pending.has(msg.id)) {
            const { resolve: r, reject: j } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) j(new Error(JSON.stringify(msg.error)));
            else r(msg.result);
          } else if (eventHandler) {
            eventHandler(msg.method, msg.params);
          }
        }
      } finally {
        parsing = false;
      }
    };

    const handleData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        if (!opened) {
          const idx = buf.indexOf("\r\n\r\n");
          if (idx === -1) return;
          const head = buf.subarray(0, idx).toString("latin1");
          if (!/^HTTP\/1\.1 101/.test(head)) {
            fail(new Error("ws upgrade failed: " + head.split("\r\n")[0]));
            return;
          }
          opened = true;
          buf = buf.subarray(idx + 4);
          continue;
        }
        if (buf.length < 2) return;
        const b0 = buf[0];
        const b1 = buf[1];
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (buf.length < off + maskLen + len) return;
        let payload = buf.subarray(off + maskLen, off + maskLen + len);
        if (masked) {
          const m = buf.subarray(off, off + 4);
          const unm = Buffer.alloc(len);
          for (let i = 0; i < len; i++) unm[i] = payload[i] ^ m[i & 3];
          payload = unm;
        }
        buf = buf.subarray(off + maskLen + len);
        frameQueue.push({ opcode, payload });
        processFrames();
      }
    };

    sock.on("connect", () => {
      const req = [
        `GET ${u.pathname} HTTP/1.1`,
        `Host: ${u.hostname}:${u.port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n");
      sock.write(req);
    });
    sock.on("data", handleData);
    sock.on("error", fail);
    sock.on("close", () => {
      for (const [, p] of pending) p.reject(new Error("ws closed"));
      pending.clear();
    });

    const ready = setInterval(() => {
      if (!opened || gotError) return;
      clearInterval(ready);
      const api = {
        send(method, params = {}) {
          const id = ++msgId;
          return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            sendJson({ id, method, params });
          });
        },
        close() {
          try {
            sendFrame(0x8, Buffer.alloc(0));
          } catch {}
        },
        onEvent(fn) {
          eventHandler = fn;
        },
      };
      resolve(api);
    }, 10);
  });
}

const httpGetJson = (url) =>
  new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(2000, () => req.destroy(new Error("timeout")));
  });

export const waitForTarget = async (port) => {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await httpGetJson(`http://127.0.0.1:${port}/json/list`);
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error("no CDP target");
};

export const launchChrome = (port) =>
  spawn(
    CHROME,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--hide-scrollbars",
      "--window-size=1280,820",
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${path.resolve("scripts", ".cdp-chrome")}`,
      "about:blank",
    ],
    { stdio: "ignore", detached: true }
  );
