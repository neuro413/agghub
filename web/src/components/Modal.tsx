import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconClose } from './Icons'

export function Modal({
  title,
  onClose,
  children,
  footer,
  size = 'md',
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  size?: 'md' | 'lg' | 'xl'
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    // 打开时锁定背景滚动
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', h)
      document.body.style.overflow = prev
    }
  }, [onClose])

  return createPortal(
    <div
      className="ah-overlay"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className={`ah-modal is-${size}`}>
        <div className="ah-modal-head">
          <div className="ah-modal-title">{title}</div>
          <button type="button" className="ah-iconbtn" onClick={onClose}>
            <IconClose size={18} />
          </button>
        </div>
        <div className="ah-modal-body">{children}</div>
        {footer && <div className="ah-modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
