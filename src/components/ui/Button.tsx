import React from 'react'

export type ButtonTone = 'primary' | 'secondary' | 'danger' | 'warning' | 'ghost'
export type ButtonSize = 'sm' | 'md'

const TONE_CLASSES: Record<ButtonTone, string> = {
  primary: 'bg-blue-500 text-white hover:bg-blue-600 dark:bg-blue-600 dark:hover:bg-blue-500',
  secondary:
    'border border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.06]',
  danger: 'bg-red-500 text-white hover:bg-red-600',
  warning: 'bg-orange-500 text-white hover:bg-orange-600',
  ghost:
    'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.06]',
}

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'px-2.5 py-1 text-xs',
  md: 'px-3.5 py-2 text-sm',
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone
  size?: ButtonSize
}

export function Button({ tone = 'primary', size = 'md', className, type = 'button', ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-60 ${TONE_CLASSES[tone]} ${SIZE_CLASSES[size]} ${className ?? ''}`}
      {...props}
    />
  )
}
