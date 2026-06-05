import React, { useRef } from 'react'
import { useCloseOnEscape } from '../../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../../hooks/usePreventBackgroundScroll'
import { CloseIcon } from '../icons'

export type ModalSize = 'sm' | 'md' | 'lg'

const SIZE_CLASSES: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-2xl',
}

export interface ModalProps {
  open: boolean
  onClose: () => void
  title?: React.ReactNode
  icon?: React.ReactNode
  size?: ModalSize
  /** Disable closing on overlay click / Escape. */
  dismissible?: boolean
  footer?: React.ReactNode
  children: React.ReactNode
}

export function Modal({ open, onClose, title, icon, size = 'md', dismissible = true, footer, children }: ModalProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  useCloseOnEscape(open && dismissible, onClose)
  usePreventBackgroundScroll(open, scrollRef)

  if (!open) return null

  return (
    <div
      data-no-drag-select
      className="fixed inset-0 z-[110] flex items-center justify-center p-4"
      onClick={dismissible ? onClose : undefined}
    >
      <div className="absolute inset-0 bg-black/20 backdrop-blur-md animate-overlay-in dark:bg-black/40" />
      <div
        className={`relative z-10 flex max-h-[85vh] w-full flex-col overflow-hidden rounded-3xl border border-white/50 bg-white/90 shadow-[0_8px_40px_rgb(0,0,0,0.12)] ring-1 ring-black/5 backdrop-blur-xl animate-confirm-in dark:border-white/[0.08] dark:bg-gray-900/90 dark:shadow-[0_8px_40px_rgb(0,0,0,0.4)] dark:ring-white/10 ${SIZE_CLASSES[size]}`}
        onClick={(event) => event.stopPropagation()}
      >
        {(title || dismissible) && (
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-100 px-5 py-4 dark:border-white/[0.08]">
            <h3 className="flex items-center gap-2 text-base font-bold text-gray-800 dark:text-gray-100">
              {icon}
              {title}
            </h3>
            {dismissible && (
              <button
                onClick={onClose}
                className="rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
                aria-label="关闭"
              >
                <CloseIcon className="h-5 w-5" />
              </button>
            )}
          </div>
        )}
        <div ref={scrollRef} className="custom-scrollbar min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain p-5 [-webkit-overflow-scrolling:touch]">{children}</div>
        {footer && <div className="shrink-0 border-t border-gray-100 px-5 py-4 dark:border-white/[0.08]">{footer}</div>}
      </div>
    </div>
  )
}
