import React from 'react'

export function StatTile({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm dark:border-white/[0.08] dark:bg-white/[0.03]">
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className="mt-1 text-xl font-semibold text-gray-900 dark:text-gray-100">{value}</div>
    </div>
  )
}
