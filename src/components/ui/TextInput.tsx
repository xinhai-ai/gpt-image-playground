import React from 'react'

export interface TextInputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export const TextInput = React.forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={`w-full min-w-0 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-500/30 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-100 ${className ?? ''}`}
      {...props}
    />
  )
})
