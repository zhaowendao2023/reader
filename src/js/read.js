import { open, readFile, SeekMode } from "@tauri-apps/plugin-fs"
import { configure, TextWriter, BlobWriter, ZipReader, Reader } from '@zip.js/zip.js'
import { EPUB } from '../js/epub.js'
import { makeComicBook } from "./comic-book.js"
import { basename, extname } from "@tauri-apps/api/path"

// 按需读取文件局部内容的 Reader：zip.js 只在需要时才通过
// FileHandle 读取对应字节段，避免把整个压缩包一次性传到前端。
class TauriRangeReader extends Reader {
  constructor(file, size) {
    super();
    this._file = file;
    this.size = size;
    this._lock = Promise.resolve();
  }
  init() {
    return Promise.resolve();
  }
  async readUint8Array(index, length) {
    const remaining = Math.max(0, Math.min(length, this.size - index));
    if (remaining <= 0) return new Uint8Array(0);
    // FileHandle 的 seek/read 共享同一文件偏移，必须串行执行，
    // 否则并发解压时各次读取会互相穿插，读到错误的字节。
    const run = this._lock.then(async () => {
      const file = this._file;
      const buf = new Uint8Array(remaining);
      let pos = index;
      let filled = 0;
      while (filled < remaining) {
        await file.seek(pos, SeekMode.Start);
        const n = await file.read(buf.subarray(filled));
        if (n === null || n === 0) break;
        filled += n;
        pos += n;
      }
      return buf.subarray(0, filled);
    });
    this._lock = run.catch(() => {});
    return run;
  }
}

const makeZipLoader = async path => {
  configure({ useWebWorkers: false })
  const file = await open(path, { read: true })
  let zipReader = null
  let closed = false
  try {
    const info = await file.stat()
    zipReader = new ZipReader(new TauriRangeReader(file, info.size))
    const entries = await zipReader.getEntries()
    const map = new Map(entries.map(entry => [entry.filename, entry]))
    const load = f => (name, ...args) =>
      map.has(name) ? f(map.get(name), ...args) : null
    const loadText = load(entry => entry.getData(new TextWriter()))
    const loadBlob = load((entry, type) => entry.getData(new BlobWriter(type)))
    const getSize = name => map.get(name)?.uncompressedSize ?? 0
    return {
      entries,
      loadText,
      loadBlob,
      getSize,
      destroy: async () => {
        if (closed) return
        closed = true
        try { await zipReader.close() } catch (error) { /* ignore */ }
        try { await file.close() } catch (error) { /* ignore */ }
      },
    }
  } catch (error) {
    try { await file.close() } catch (error2) { /* ignore */ }
    throw error
  }
}

const isCBZ = (path) => {
  return path.toLowerCase().endsWith('.cbz')
}
const isZIP = (path) => {
  return path.toLowerCase().endsWith('.zip')
}

const isEPUB = (path) => {
  return path.toLowerCase().endsWith('.epub')
}

const isFB2 = ({ name, type }) => {
  return type === 'application/x-fictionbook+xml' || name.endsWith('.fb2')
}

export const openFile = async (path) => {
  console.log('path', path);
  const startTime = performance.now();

  let book
  let loader = null
  const ext = await extname(path)
  const name = await basename(path, `.${ext}`)

  if (isCBZ(path) || isZIP(path)) {
    loader = await makeZipLoader(path)
    book = makeComicBook(loader, {
      name: name
    })
  } else if (isEPUB(path)) {
    loader = await makeZipLoader(path)

    book = await new EPUB(loader).init()
  } else {
    const buffer = await readFile(path)
    const file = new File(
      [buffer], // 二进制数据（用数组包裹 Uint8Array）
      name, // 文件名（必须带 .mobi 后缀，方便识别）
      {
        lastModified: Date.now() // 最后修改时间（可选，默认当前时间）
      }
    );
    const { isMOBI, MOBI } = await import('./mobi.js')
    if (await isMOBI(path)) {
      const fflate = await import('./vendor/fflate.js')
      book = await new MOBI({ unzlib: fflate.unzlibSync }).open(file)
    }
    else if (isFB2(file)) {
      const { makeFB2 } = await import('./fb2.js')
      book = await makeFB2(file)
    }
  }

  book.name = name
  book.ext = ext
  if (loader) {
    const origDestroy = book.destroy
    book.destroy = () => {
      origDestroy?.()
      return loader.destroy?.()
    }
  }
  return book
}
