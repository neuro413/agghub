import { forwardRef, useEffect, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'
import { copyText } from '../lib/clipboard'
import { IconCheck, IconCopy, IconEye, IconEyeOff, IconLoader } from './Icons'
import { useToast } from './Toast'

type ButtonVariant = 'default' | 'outline' | 'secondary' | 'ghost' | 'destructive'
type ButtonSize = 'default' | 'sm' | 'lg' | 'icon' | 'icon-sm'

export function Button({
  variant = 'default',
  size = 'default',
  block,
  loading,
  className = '',
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize; block?: boolean; loading?: boolean }) {
  const classes = ['pt-btn', `pt-btn-${variant}`, size !== 'default' && `pt-btn-${size}`, block && 'pt-btn-block', className].filter(Boolean).join(' ')
  return (
    <button type="button" className={classes} disabled={disabled || loading} {...rest}>
      {loading && <IconLoader className="pt-spinner" />}
      {children}
    </button>
  )
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className = '', ...rest }, ref) {
  return <input ref={ref} className={`pt-input ${className}`.trim()} {...rest} />
})

export function PasswordInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const [visible, setVisible] = useState(false)
  return (
    <div className="pt-input-wrap">
      <Input {...props} type={visible ? 'text' : 'password'} />
      <button type="button" className="pt-input-trail" onClick={() => setVisible(v => !v)} aria-label={visible ? '隐藏密码' : '显示密码'} tabIndex={-1}>
        {visible ? <IconEyeOff size={16} /> : <IconEye size={16} />}
      </button>
    </div>
  )
}

export function Field({ label, hint, error, children, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="pt-field">
      <label className="pt-label" htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <div className="pt-field-error">{error}</div> : hint ? <div className="pt-hint">{hint}</div> : null}
    </div>
  )
}

type Tone = 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'outline'

export function Badge({ tone = 'primary', dot, children, className = '', ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone; dot?: boolean }) {
  return (
    <span className={`pt-badge${tone === 'primary' ? '' : ` pt-badge-${tone}`} ${className}`.trim()} {...rest}>
      {dot && <span className="pt-dot" />}
      {children}
    </span>
  )
}

export function IconBadge({ tone, size, children }: { tone?: string; size?: 'md' | 'lg'; children: ReactNode }) {
  return <span className={`pt-icon-badge${size ? ` is-${size}` : ''}${tone ? ` tone-${tone}` : ''}`}>{children}</span>
}

export function Card({ hover, className = '', ...rest }: HTMLAttributes<HTMLDivElement> & { hover?: boolean }) {
  return <div className={`pt-card${hover ? ' is-hover' : ''} ${className}`.trim()} {...rest} />
}

export function CardHeader({ title, desc, icon, extra }: { title: ReactNode; desc?: ReactNode; icon?: ReactNode; extra?: ReactNode }) {
  return (
    <div className="pt-card-header" style={extra ? { gridTemplateColumns: '1fr auto', alignItems: 'center' } : undefined}>
      <div>
        <div className="pt-card-title">{icon}{title}</div>
        {desc && <div className="pt-card-desc" style={{ marginTop: 4 }}>{desc}</div>}
      </div>
      {extra}
    </div>
  )
}

export function Empty({ icon, title, desc, action }: { icon?: ReactNode; title: string; desc?: ReactNode; action?: ReactNode }) {
  return (
    <div className="pt-empty">
      {icon && <IconBadge size="lg" tone="neutral">{icon}</IconBadge>}
      <div className="pt-empty-title">{title}</div>
      {desc && <div>{desc}</div>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  )
}

export function Skeleton({ width = '100%', height = 16, style }: { width?: number | string; height?: number | string; style?: CSSProperties }) {
  return <div className="pt-skeleton" style={{ width, height, ...style }} />
}

/** 复制按钮：复制成功后两秒内显示绿色对勾；text 可以是取值函数（例如先请求完整 Key） */
export function CopyButton({ text, size = 'icon-sm', label, title = '复制' }: { text: string | (() => Promise<string>); size?: ButtonSize; label?: string; title?: string }) {
  const toast = useToast()
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const timer = useRef<number>()
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = async () => {
    setBusy(true)
    try {
      const value = typeof text === 'string' ? text : await text()
      if (!(await copyText(value))) throw new Error('复制失败，请手动选择复制')
      setCopied(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 2000)
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const glyph = copied ? <IconCheck size={14} /> : <IconCopy size={14} />
  return (
    <Button variant={label ? 'outline' : 'ghost'} size={label ? 'sm' : size} onClick={copy} disabled={busy} title={copied ? '已复制' : title} aria-label={title}>
      <span style={{ display: 'inline-flex', color: copied ? '#16a34a' : undefined }}>{glyph}</span>
      {label && (copied ? '已复制' : label)}
    </Button>
  )
}
