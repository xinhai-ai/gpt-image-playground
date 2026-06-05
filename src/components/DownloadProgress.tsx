import { useStore, type DownloadProgressPhase } from '../store'

function phaseLabel(phase: DownloadProgressPhase) {
  switch (phase) {
    case 'preparing':
      return '准备下载'
    case 'downloading':
      return '下载原图'
    case 'compressing':
      return '打包 ZIP'
    case 'saving':
      return '保存文件'
    case 'done':
      return '下载完成'
  }
}

function formatBytes(value: number | undefined) {
  if (!value || value <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }
  return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`
}

export default function DownloadProgress() {
  const progress = useStore((s) => s.downloadProgress)
  if (!progress) return null

  const percent = Math.max(0, Math.min(100, Math.round(progress.percent)))
  const byteText = progress.totalBytes
    ? `${formatBytes(progress.loadedBytes)} / ${formatBytes(progress.totalBytes)}`
    : formatBytes(progress.loadedBytes)
  const countText = progress.total > 1
    ? `${Math.min(progress.current, progress.total)} / ${progress.total}`
    : ''

  return (
    <div className="fixed bottom-24 left-1/2 z-[119] w-[calc(100vw-32px)] max-w-md -translate-x-1/2 pointer-events-none">
      <div className="rounded-lg border border-gray-200/70 bg-white/95 p-3.5 shadow-[0_10px_32px_rgba(15,23,42,0.16)] ring-1 ring-black/5 backdrop-blur-xl dark:border-white/[0.08] dark:bg-gray-900/95 dark:shadow-[0_10px_32px_rgba(0,0,0,0.35)] dark:ring-white/10">
        <div className="mb-2 flex items-center justify-between gap-3 text-sm">
          <div className="min-w-0">
            <div className="font-medium text-gray-800 dark:text-gray-100">{phaseLabel(progress.phase)}</div>
            <div className="truncate text-xs text-gray-500 dark:text-gray-400">
              {[countText, progress.currentFileName, byteText].filter(Boolean).join(' · ')}
            </div>
          </div>
          <div className="shrink-0 tabular-nums text-xs font-medium text-gray-500 dark:text-gray-400">
            {percent}%
          </div>
        </div>
        <div className="h-2 overflow-hidden rounded bg-gray-200 dark:bg-gray-800">
          <div
            className="h-full rounded bg-blue-500 transition-[width] duration-200 ease-out"
            style={{ width: `${percent}%` }}
          />
        </div>
        {progress.failCount > 0 && (
          <div className="mt-2 text-xs text-red-500 dark:text-red-400">
            已失败 {progress.failCount} 张，继续处理剩余图片
          </div>
        )}
      </div>
    </div>
  )
}
