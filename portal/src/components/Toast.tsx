import { createContext, useCallback, useContext, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconCheck, IconCircleAlert, IconInfo } from './Icons'

type ToastKind = 'success' | 'error' | 'info'
type ToastFn = (kind: ToastKind, message: string) => void

const ToastContext = createContext<ToastFn>(() => {})

export function useToast(): ToastFn {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; kind: ToastKind; message: string }[]>([])
  const seq = useRef(0)
  const push = useCallback<ToastFn>((kind, message) => {
    const id = ++seq.current
    setItems(list => [...list.slice(-3), { id, kind, message }])
    window.setTimeout(() => setItems(list => list.filter(t => t.id !== id)), kind === 'error' ? 4500 : 3000)
  }, [])
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pt-toasts" role="status" aria-live="polite">
        {items.map(t => (
          <div key={t.id} className={`pt-toast is-${t.kind}`}>
            {t.kind === 'success' ? <IconCheck size={16} /> : t.kind === 'error' ? <IconCircleAlert size={16} /> : <IconInfo size={16} />}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
