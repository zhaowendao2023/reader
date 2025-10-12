import { readFile } from "@tauri-apps/plugin-fs"
import { configure, TextWriter, BlobWriter, ZipReader, BlobReader } from '@zip.js/zip.js'
import { EPUB } from '../js/epub.js'
import { makeComicBook } from "./comic-book.js"
import { basename } from "@tauri-apps/api/path"

const makeZipLoader = async buffer => {
  configure({ useWebWorkers: false })
  const reader = new ZipReader(new BlobReader(new Blob([buffer])))
  const entries = await reader.getEntries()
  const map = new Map(entries.map(entry => [entry.filename, entry]))
  const load = f => (name, ...args) =>
    map.has(name) ? f(map.get(name), ...args) : null
  const loadText = load(entry => entry.getData(new TextWriter()))
  const loadBlob = load((entry, type) => entry.getData(new BlobWriter(type)))
  const getSize = name => map.get(name)?.uncompressedSize ?? 0
  return { entries, loadText, loadBlob, getSize }
}

const isCBZ = (path) => {
  return path.endsWith('.cbz')
}
const isZIP = (path) => {
  return path.endsWith('.zip')
}

const isEPUB = (path) => {
  return path.endsWith('.epub')
}

const isFB2 = ({ name, type }) =>
  type === 'application/x-fictionbook+xml' || name.endsWith('.fb2')

export const openFile = async (path) => {
  console.log('path', path);

  const startTime = performance.now();
  const buffer = await readFile(path)

  let book
  const name = await basename(path)
  const parts = name.split(".");


  if (isCBZ(path) || isZIP(path)) {
    const loader = await makeZipLoader(buffer)

    book = makeComicBook(loader, {
      name: parts[0]
    })
  } else if (isEPUB(path)) {
    const loader = await makeZipLoader(buffer)

    book = await new EPUB(loader).init()
  } else {
    const file = new File(
      [buffer], // 二进制数据（用数组包裹 Uint8Array）
      name, // 文件名（必须带 .mobi 后缀，方便识别）
      {
        // type: 'application/x-mobipocket-ebook', // MOBI 的 MIME 类型（可选但推荐）
        lastModified: Date.now() // 最后修改时间（可选，默认当前时间）
      }
    );
    console.log('file', file);

    const { isMOBI, MOBI } = await import('./mobi.js')
    if (await isMOBI(path)) {
      const fflate = await import('./vendor/fflate.js')
      book = await new MOBI({ unzlib: fflate.unzlibSync }).open(file)
      console.log('book', book);

    }
    else if (isFB2(file)) {
      const { makeFB2 } = await import('./fb2.js')
      book = await makeFB2(file)
    }
  }

  book.name = parts[0]
  book.ext = parts[1]
  return book
}
