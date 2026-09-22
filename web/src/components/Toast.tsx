import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { IconBolt, IconCheck, IconClose } from './Icons'

type ToastType = 'ok' | 'err' | 'info'
interface ToastItem {
  id: number
  type: ToastType
  msg: string
}

const ToastCtx = createContext<(type: ToastType, msg: string) => void>(() => {})
export const useToast = () => useContext(ToastCtx)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const push = useCallback((type: ToastType, msg: string) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, type, msg }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600)
  }, [])

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="ah-toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`ah-toast ${t.type}`}>
            <span className="i">
              {t.type === 'ok' ? <IconCheck size={14} /> : t.type === 'err' ? <IconClose size={14} /> : <IconBolt size={13} />}
            </span>
            {t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}
