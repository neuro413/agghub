import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button } from './ui'
import { IconX } from './Icons'

function useEscape(onClose: () => void) {
  useEffect(() => {
    const handle = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  }, [onClose])
}

export function Dialog({ title, desc, children, footer, onClose, wide }: {
  title: ReactNode
  desc?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  onClose: () => void
  wide?: boolean
}) {
  useEscape(onClose)
  return createPortal(
    <>
      <div className="pt-overlay" onClick={onClose} />
      <div className={`pt-dialog${wide ? ' is-wide' : ''}`} role="dialog" aria-modal="true">
        <div className="pt-dialog-header">
          <div className="pt-dialog-title">{title}</div>
          {desc && <div className="pt-dialog-desc">{desc}</div>}
        </div>
        <Button variant="ghost" size="icon-sm" className="pt-dialog-close" onClick={onClose} aria-label="关闭"><IconX /></Button>
        {children}
        {footer && <div className="pt-dialog-footer">{footer}</div>}
      </div>
    </>,
    document.body,
  )
}

/** 二次确认（new-api 的 AlertDialog），确认按钮为红色 */
export function ConfirmDialog({ title, desc, confirmText = '确认删除', busy, onConfirm, onClose }: {
  title: ReactNode
  desc: ReactNode
  confirmText?: string
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Dialog
      title={title}
      desc={desc}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button variant="destructive" loading={busy} onClick={onConfirm}>{confirmText}</Button>
        </>
      }
    />
  )
}

/** 右侧抽屉（new-api 的 Sheet） */
export function Sheet({ title, desc, children, footer, onClose }: {
  title: ReactNode
  desc?: ReactNode
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
}) {
  useEscape(onClose)
  return createPortal(
    <>
      <div className="pt-overlay" onClick={onClose} />
      <aside className="pt-sheet" role="dialog" aria-modal="true">
        <div className="pt-sheet-header">
          <div className="pt-dialog-title" style={{ lineHeight: 1.4 }}>{title}</div>
          {desc && <div className="pt-dialog-desc">{desc}</div>}
          <Button variant="ghost" size="icon-sm" className="pt-dialog-close" onClick={onClose} aria-label="关闭"><IconX /></Button>
        </div>
        <div className="pt-sheet-body">{children}</div>
        {footer && <div className="pt-sheet-footer">{footer}</div>}
      </aside>
    </>,
    document.body,
  )
}
