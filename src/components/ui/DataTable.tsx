import React from 'react'
import { EmptyState } from './EmptyState'

export interface DataTableColumn<T> {
  /** Unique key for the column. */
  key: string
  /** Header label (also used as the mobile field label). */
  header: React.ReactNode
  /** Cell renderer. */
  render: (row: T) => React.ReactNode
  /** Hide the label in the mobile card view (e.g. for a primary title cell). */
  mobileHideLabel?: boolean
  /** Prevent the cell content from wrapping in the desktop table. */
  nowrap?: boolean
  /** Extra class applied to the desktop <td>. */
  cellClassName?: string
}

export interface DataTableProps<T> {
  columns: Array<DataTableColumn<T>>
  rows: T[]
  rowKey: (row: T) => string
  emptyText: string
}

/**
 * Responsive table: renders a real <table> on >=sm screens and a stacked card
 * list on small screens so wide admin tables never overflow horizontally.
 */
export function DataTable<T>({ columns, rows, rowKey, emptyText }: DataTableProps<T>) {
  if (!rows.length) return <EmptyState text={emptyText} />

  return (
    <>
      {/* Desktop / tablet: table */}
      <div className="hidden overflow-x-auto rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.03] sm:block">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-gray-200 text-xs text-gray-500 dark:border-white/[0.08] dark:text-gray-400">
            <tr>
              {columns.map((column) => (
                <th key={column.key} className="px-3 py-2 font-medium">
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={rowKey(row)} className="border-b border-gray-100 last:border-b-0 dark:border-white/[0.06]">
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={`px-3 py-2 align-top ${column.nowrap ? 'whitespace-nowrap' : ''} ${column.cellClassName ?? ''}`}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: stacked cards */}
      <div className="space-y-3 sm:hidden">
        {rows.map((row) => (
          <div
            key={rowKey(row)}
            className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm dark:border-white/[0.08] dark:bg-white/[0.03]"
          >
            <dl className="space-y-1.5">
              {columns.map((column) => (
                <div key={column.key} className="flex items-start justify-between gap-3 text-sm">
                  {!column.mobileHideLabel && (
                    <dt className="shrink-0 text-xs text-gray-500 dark:text-gray-400">{column.header}</dt>
                  )}
                  <dd className={`min-w-0 ${column.mobileHideLabel ? 'w-full' : 'text-right'}`}>{column.render(row)}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </>
  )
}
