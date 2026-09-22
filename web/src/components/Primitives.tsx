import type { ReactNode } from 'react'
import type { ChannelType } from '../types'

const TYPE_LABEL: Record<ChannelType, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  vertex: 'Vertex',
  responses: 'Responses',
}

export function Badge({ type }: { type: ChannelType }) {
  return <span className={`ah-badge t-${type}`}>{TYPE_LABEL[type]}</span>
}

/** status: 1=启用(绿,呼吸) 2=自动禁用(橙) 0=手动禁用(灰) */
export function StatusDot({ status }: { status: number }) {
  const cls = status === 1 ? 'ok' : status === 2 ? 'warn' : 'err'
  return <span className={`ah-dot ${cls}`} />
}

export function statusText(status: number): string {
  return status === 1 ? '在线' : status === 2 ? '已熔断' : '已停用'
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className="ah-tag">{children}</span>
}

export function Chip({ children }: { children: ReactNode }) {
  return <span className="ah-chip">{children}</span>
}
