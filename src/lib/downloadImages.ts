import { ensureImageCached, useStore, type DownloadProgressState } from '../store'
import { zipSync } from 'fflate'
import type { TaskRecord } from '../types'
import { getSaasImageReadUrl, isSaasMode } from './saasApi'

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export interface DownloadImagesResult {
  successCount: number
  failCount: number
}

export interface DownloadImageZipEntry {
  imageId: string
  fileNameBase?: string
}

type TaskOutputZipTask = Pick<TaskRecord, 'id' | 'createdAt' | 'outputImages'>
type DownloadProgressPhase = DownloadProgressState['phase']

interface DownloadProgressRun {
  id: string
  title: string
  total: number
  zip: boolean
}

interface DownloadProgressPatch {
  phase: DownloadProgressPhase
  current: number
  successCount: number
  failCount: number
  percent: number
  currentFileName?: string
  loadedBytes?: number
  totalBytes?: number
}

interface BlobProgressOptions {
  onProgress?: (loadedBytes: number, totalBytes?: number) => void
}

export function formatExportFileTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

export async function downloadImageIds(imageIds: string[], fileNameBase = 'images'): Promise<DownloadImagesResult> {
  if (imageIds.length === 0) return { successCount: 0, failCount: 0 }

  let successCount = 0
  let failCount = 0
  const multiple = imageIds.length > 1
  const progress = beginDownloadProgress(fileNameBase, imageIds.length, false)

  for (let index = 0; index < imageIds.length; index++) {
    const order = String(index + 1).padStart(2, '0')
    const fileNameBaseForProgress = multiple ? `${fileNameBase}-${order}` : fileNameBase
    try {
      updateDownloadProgress(progress, {
        phase: 'downloading',
        current: index + 1,
        successCount,
        failCount,
        percent: getDownloadPercent(index, imageIds.length, 0, false),
        currentFileName: fileNameBaseForProgress,
      })
      const blob = await getImageBlob(imageIds[index], {
        onProgress: (loadedBytes, totalBytes) => updateDownloadProgress(progress, {
          phase: 'downloading',
          current: index + 1,
          successCount,
          failCount,
          percent: getDownloadPercent(index, imageIds.length, getItemFraction(loadedBytes, totalBytes), false),
          currentFileName: fileNameBaseForProgress,
          loadedBytes,
          totalBytes,
        }),
      })
      const fileName = multiple
        ? `${fileNameBase}-${order}.${getBlobExtension(blob)}`
        : `${fileNameBase}.${getBlobExtension(blob)}`
      updateDownloadProgress(progress, {
        phase: 'saving',
        current: index + 1,
        successCount,
        failCount,
        percent: getDownloadPercent(index, imageIds.length, 1, false),
        currentFileName: fileName,
        loadedBytes: blob.size,
        totalBytes: blob.size,
      })
      triggerDownload(blob, fileName)
      successCount++
      if (multiple) await delay(100)
    } catch (err) {
      console.error(err)
      failCount++
    }
  }

  finishDownloadProgress(progress, successCount, failCount)
  return { successCount, failCount }
}

export async function downloadImageEntriesAsZip(entries: DownloadImageZipEntry[], zipFileNameBase = 'images'): Promise<DownloadImagesResult> {
  if (entries.length === 0) return { successCount: 0, failCount: 0 }

  let successCount = 0
  let failCount = 0
  const zipFiles: Record<string, Uint8Array | [Uint8Array, { mtime: Date }]> = {}
  const usedNames = new Set<string>()
  const progress = beginDownloadProgress(zipFileNameBase, entries.length, true)

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    const order = String(index + 1).padStart(2, '0')
    const base = sanitizeFileNamePart(entry.fileNameBase || `image-${order}`) || `image-${order}`
    try {
      updateDownloadProgress(progress, {
        phase: 'downloading',
        current: index + 1,
        successCount,
        failCount,
        percent: getDownloadPercent(index, entries.length, 0, true),
        currentFileName: base,
      })
      const blob = await getImageBlob(entry.imageId, {
        onProgress: (loadedBytes, totalBytes) => updateDownloadProgress(progress, {
          phase: 'downloading',
          current: index + 1,
          successCount,
          failCount,
          percent: getDownloadPercent(index, entries.length, getItemFraction(loadedBytes, totalBytes), true),
          currentFileName: base,
          loadedBytes,
          totalBytes,
        }),
      })
      const ext = getBlobExtension(blob)
      let fileName = `${base}.${ext}`
      let duplicateIndex = 2
      while (usedNames.has(fileName)) {
        fileName = `${base}-${String(duplicateIndex).padStart(2, '0')}.${ext}`
        duplicateIndex++
      }
      usedNames.add(fileName)
      zipFiles[fileName] = [new Uint8Array(await blob.arrayBuffer()), { mtime: new Date() }]
      successCount++
    } catch (err) {
      console.error(err)
      failCount++
    }
  }

  if (successCount > 0) {
    updateDownloadProgress(progress, {
      phase: 'compressing',
      current: entries.length,
      successCount,
      failCount,
      percent: 92,
      currentFileName: `${zipFileNameBase}.zip`,
    })
    await delay(40)
    const zipped = zipSync(zipFiles, { level: 6 })
    const buffer = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer
    updateDownloadProgress(progress, {
      phase: 'saving',
      current: entries.length,
      successCount,
      failCount,
      percent: 98,
      currentFileName: `${zipFileNameBase}.zip`,
      loadedBytes: buffer.byteLength,
      totalBytes: buffer.byteLength,
    })
    triggerDownload(new Blob([buffer], { type: 'application/zip' }), `${sanitizeFileNamePart(zipFileNameBase) || 'images'}.zip`)
  }

  finishDownloadProgress(progress, successCount, failCount)
  return { successCount, failCount }
}

export function getTaskOutputImageZipEntries(tasks: TaskOutputZipTask[]): DownloadImageZipEntry[] {
  return [...tasks]
    .sort((a, b) => b.createdAt - a.createdAt)
    .flatMap((task) => getImageZipEntries(task.outputImages || [], `task-${task.id}`))
}

export function getImageZipEntries(imageIds: string[], fileNameBase = 'image'): DownloadImageZipEntry[] {
  const multiple = imageIds.length > 1
  return imageIds.map((imageId, index) => ({
    imageId,
    fileNameBase: multiple ? `${fileNameBase}-${String(index + 1).padStart(2, '0')}` : fileNameBase,
  }))
}

async function getImageBlob(imageIdOrUrl: string, options: BlobProgressOptions = {}): Promise<Blob> {
  let src = imageIdOrUrl
  if (!imageIdOrUrl.startsWith('data:') && !imageIdOrUrl.startsWith('http://') && !imageIdOrUrl.startsWith('https://')) {
    if (isSaasMode()) {
      const signed = await getSaasImageReadUrl(imageIdOrUrl, 'original')
      const response = await fetch(signed.readUrl, { cache: 'no-store' })
      if (!response.ok) throw new Error(`读取图片失败：${imageIdOrUrl}`)
      return readResponseBlob(response, signed.contentType || 'image/png', signed.byteSize ?? undefined, options.onProgress)
    }
    src = await ensureImageCached(imageIdOrUrl) ?? imageIdOrUrl
  }

  const res = await fetch(src)
  if (!res.ok && !src.startsWith('data:')) throw new Error(`读取图片失败：${imageIdOrUrl}`)
  return readResponseBlob(res, 'image/png', undefined, options.onProgress)
}

async function readResponseBlob(
  response: Response,
  fallbackContentType: string,
  totalBytesHint?: number,
  onProgress?: (loadedBytes: number, totalBytes?: number) => void,
): Promise<Blob> {
  const headerContentType = response.headers.get('content-type')?.split(';')[0]?.trim()
  const contentType = headerContentType || fallbackContentType || 'image/png'
  const headerTotalBytes = Number(response.headers.get('content-length'))
  const totalBytes = Number.isFinite(totalBytesHint) && totalBytesHint && totalBytesHint > 0
    ? totalBytesHint
    : Number.isFinite(headerTotalBytes) && headerTotalBytes > 0
      ? headerTotalBytes
      : undefined

  if (!response.body) {
    const buffer = await response.arrayBuffer()
    onProgress?.(buffer.byteLength, totalBytes ?? buffer.byteLength)
    return new Blob([buffer], { type: contentType })
  }

  const reader = response.body.getReader()
  const chunks: ArrayBuffer[] = []
  let loadedBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    const buffer = new ArrayBuffer(value.byteLength)
    new Uint8Array(buffer).set(value)
    chunks.push(buffer)
    loadedBytes += value.byteLength
    onProgress?.(loadedBytes, totalBytes)
  }

  if (loadedBytes) onProgress?.(loadedBytes, totalBytes ?? loadedBytes)
  else onProgress?.(0, totalBytes)
  return new Blob(chunks, { type: contentType })
}

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function getBlobExtension(blob: Blob): string {
  return MIME_EXTENSIONS[blob.type.toLowerCase()] ?? blob.type.split('/')[1] ?? 'png'
}

function sanitizeFileNamePart(value: string): string {
  return value.trim().replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-').replace(/\s+/g, ' ').slice(0, 120)
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function beginDownloadProgress(title: string, total: number, zip: boolean): DownloadProgressRun {
  const run = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title: sanitizeFileNamePart(title) || 'images',
    total,
    zip,
  }
  updateDownloadProgress(run, {
    phase: 'preparing',
    current: total > 0 ? 1 : 0,
    successCount: 0,
    failCount: 0,
    percent: 0,
  })
  return run
}

function updateDownloadProgress(run: DownloadProgressRun, patch: DownloadProgressPatch) {
  useStore.getState().setDownloadProgress({
    id: run.id,
    title: run.title,
    total: run.total,
    ...patch,
    percent: Math.max(0, Math.min(100, patch.percent)),
  })
}

function finishDownloadProgress(run: DownloadProgressRun, successCount: number, failCount: number) {
  updateDownloadProgress(run, {
    phase: 'done',
    current: run.total,
    successCount,
    failCount,
    percent: 100,
    currentFileName: run.zip ? `${run.title}.zip` : undefined,
  })
  window.setTimeout(() => {
    if (useStore.getState().downloadProgress?.id === run.id) {
      useStore.getState().setDownloadProgress(null)
    }
  }, 1_200)
}

function getItemFraction(loadedBytes: number, totalBytes: number | undefined) {
  if (!totalBytes || totalBytes <= 0) return loadedBytes > 0 ? 0.5 : 0
  return Math.max(0, Math.min(1, loadedBytes / totalBytes))
}

function getDownloadPercent(completedItems: number, totalItems: number, currentItemFraction: number, zip: boolean) {
  if (totalItems <= 0) return 0
  const downloadWeight = zip ? 90 : 96
  return ((completedItems + currentItemFraction) / totalItems) * downloadWeight
}
