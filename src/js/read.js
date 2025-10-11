import { readFile } from "@tauri-apps/plugin-fs"
import { configure, TextWriter, BlobWriter, ZipReader, BlobReader } from '@zip.js/zip.js'
import { EPUB } from '../js/epub.js'
import { makeComicBook } from "./comic-book.js"
import { basename } from "@tauri-apps/api/path"

const makeZipLoader = async buffer => {
  configure({ useWebWorkers: false })
  const reader = new ZipReader(new BlobReader(new Blob([buffer])))
  // const reader = new ZipReader(new BlobReader(file))
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

export const openFile = async (path) => {
  const startTime = performance.now();
  const buffer = await readFile(path)
  console.log(`readFile函数执行耗时: ${(performance.now() - startTime).toFixed(3)} 毫秒`); // 保留3位小数
  const loader = await makeZipLoader(buffer)
  console.log(`makeZipLoader函数执行耗时: ${(performance.now() - startTime).toFixed(3)} 毫秒`); // 保留3位小数
  let book
  const parts = (await basename(path)).split(".");

  if (isCBZ(path) || isZIP(path)) {
    book = makeComicBook(loader, {
      name: parts[0]
    })
  } else if (isEPUB) {
    book = await new EPUB(loader).init()
  }
  console.log(`makeBook函数执行耗时: ${(performance.now() - startTime).toFixed(3)} 毫秒`); // 保留3位小数

  book.name = parts[0]
  book.ext = parts[1]
  return book
}
