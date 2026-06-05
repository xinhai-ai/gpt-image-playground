import React from 'react'

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  padded?: boolean
}

export function Card({ padded = true, className, children, ...props }: CardProps) {
  return (
    <div
      className={`rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.03] ${padded ? 'p-4' : ''} ${className ?? ''}`}
      {...props}
    >
      {children}
    </div>
  )
}
