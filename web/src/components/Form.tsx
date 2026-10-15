import { useEffect, useRef, useState } from 'react'
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { amountText, currencySymbol, toPoints } from '../lib/money'
import { IconChevron, IconCheck } from './Icons'

export function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string
  required?: boolean
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="ah-field">
      <label className="ah-flabel">
        {label}
        {required && <span className="req">*</span>}
      </label>
      {children}
      {hint && <div className="ah-hint">{hint}</div>}
    </div>
  )
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="ah-input" {...props} />
}

/** 金额输入框：左侧显示余额符号 */
export function MoneyInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="ah-money-input">
      <span className="ah-money-sym">{currencySymbol()}</span>
      <input type="number" min={0} step="any" {...props} />
    </div>
  )
}

/** 以点数为值的金额输入框：保留正在输入的文本，只把换算后的整数点数交给上层 */
export function PointsInput({
  value,
  onChange,
  ...rest
}: { value: number; onChange: (points: number) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [text, setText] = useState(() => amountText(value))
  // 外部改值（如保存后回写）时同步；与当前文本等价时保留原文本，避免打断输入
  useEffect(() => {
    setText((t) => (toPoints(Number(t) || 0) === value ? t : amountText(value)))
  }, [value])
  return (
    <MoneyInput
      {...rest}
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        onChange(toPoints(Number(e.target.value) || 0))
      }}
    />
  )
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className="ah-textarea" {...props} />
}

export function Select({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="ah-select-wrap">
      <select className="ah-select" {...props}>
        {children}
      </select>
      <IconChevron className="ah-chev" size={16} />
    </div>
  )
}

/** 自写下拉框（替代原生 select，外观可控）*/
export function Dropdown({
  value,
  options,
  onChange,
}: {
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', h)
    return () => window.removeEventListener('mousedown', h)
  }, [open])
  const current = options.find((o) => o.value === value)
  return (
    <div className={`ah-dd${open ? ' is-open' : ''}`} ref={ref}>
      <button type="button" className="ah-dd-trigger" onClick={() => setOpen((o) => !o)}>
        <span>{current?.label ?? '请选择'}</span>
        <IconChevron className={`ah-dd-chev${open ? ' is-open' : ''}`} size={16} />
      </button>
      {open && (
        <div className="ah-dd-menu">
          {options.map((o) => (
            <button
              type="button"
              key={o.value}
              className={`ah-dd-item${o.value === value ? ' is-active' : ''}`}
              onClick={() => {
                onChange(o.value)
                setOpen(false)
              }}
            >
              <span>{o.label}</span>
              {o.value === value && <IconCheck size={15} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  suffix,
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  suffix?: string
}) {
  // 这些滑块对应的设置都是整数，取整后回传，避免手输小数被服务端校验拒绝
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)))
  const [text, setText] = useState(String(clamp(value)))
  const focused = useRef(false)
  // 拖动滑块改变外部 value 时，输入框未聚焦则同步显示
  useEffect(() => {
    if (!focused.current) setText(String(clamp(value)))
  }, [value])
  return (
    <div className="ah-slider-row">
      <input
        type="range"
        className="ah-slider"
        value={value}
        min={min}
        max={max}
        step={step || 1}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <div className="ah-slider-val">
        <input
          className="ah-slider-input ah-num"
          type="text"
          inputMode="numeric"
          value={text}
          onFocus={() => {
            focused.current = true
          }}
          onChange={(e) => {
            const raw = e.target.value
            setText(raw)
            const n = Number(raw)
            if (raw.trim() !== '' && Number.isFinite(n)) onChange(clamp(n))
          }}
          onBlur={() => {
            focused.current = false
            const n = Number(text)
            const v = text.trim() === '' || !Number.isFinite(n) ? min : clamp(n)
            onChange(v)
            setText(String(v))
          }}
        />
        {suffix && <span className="ah-slider-suffix">{suffix}</span>}
      </div>
    </div>
  )
}
