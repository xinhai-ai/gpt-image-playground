export function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-gray-200 p-8 text-center text-sm text-gray-500 dark:border-white/[0.08] dark:text-gray-400">
      {text}
    </div>
  )
}
