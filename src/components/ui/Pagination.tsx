import { Button } from './Button'

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
}) {
  if (total <= pageSize) return null
  const maxPage = Math.max(1, Math.ceil(total / pageSize))
  return (
    <div className="flex items-center justify-between gap-3 text-sm text-gray-500 dark:text-gray-400">
      <span>
        共 {total} 条，第 {page} / {maxPage} 页
      </span>
      <div className="flex gap-2">
        <Button tone="secondary" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          上一页
        </Button>
        <Button tone="secondary" size="sm" disabled={page >= maxPage} onClick={() => onPageChange(page + 1)}>
          下一页
        </Button>
      </div>
    </div>
  )
}
