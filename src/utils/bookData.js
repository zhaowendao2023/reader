import { writeFile, remove, mkdir } from '@tauri-apps/plugin-fs';
import { openFile } from '../js/read';
import { appDataDir } from '@tauri-apps/api/path';
import { useBooks } from '../store/loadBooks';

export const getBookInfo = async (path) => {
  const startTime = performance.now();
  const book = await openFile(path)
  console.log(`openFile函数执行耗时: ${(performance.now() - startTime).toFixed(3)} 毫秒`); // 保留3位小数
  const data = await book.getCover()
  console.log(`getCover函数执行耗时: ${(performance.now() - startTime).toFixed(3)} 毫秒`); // 保留3位小数
  const turePath = await writeFileData(path, 'cover', await data.arrayBuffer())
  console.log(`getBookInfo函数执行耗时: ${(performance.now() - startTime).toFixed(3)} 毫秒`); // 保留3位小数
  return {
    coverPath: turePath,
    title: book.name,
    ext: book.ext
  }
}

export const getComic = async (path) => {
  const images = []
  const book = await openFile(path)
  for (const section of book.sections) {
    const name = section.id
    const image = await section.load()
    images.push({ name, image })
  }
  return { images, toces: book.toc }
}

export const getEPUB = async (path) => {
  const book = await openFile(path)
  return book
}

export const getMOBI = async (path) => {
  const book = await openFile(path)
  return book
}

export const clearLoadDate = async () => {
  await remove('resource/data', {
    baseDir: useBooks().baseSrc,
    recursive: true
  })
  await mkdir('resource/data', {
    baseDir: useBooks().baseSrc
  })
}

const writeFileData = async (path, name, arrayBuffer) => {
  const hash = await calculateHash(path)
  const coverPath = "resource/data/" + hash;
  await mkdir(coverPath, {
    baseDir: useBooks().baseSrc
  })
  const turePath = coverPath + '/' + name;
  await writeFile(turePath, arrayBuffer, {
    baseDir: useBooks().baseSrc
  })
  return !useBooks().baseSrc ? turePath : `${(await appDataDir())}/${turePath}`
}

export const deleteFileData = async (id) => {
  const coverPath = "resource/data/" + id;
  await remove(coverPath, {
    baseDir: useBooks().baseSrc,
    recursive: true
  })
}

export const getTheme = async () => {
  return (await import('./theme')).theme
}
