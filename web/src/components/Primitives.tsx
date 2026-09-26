import type { ChannelType, LogItem } from '../types'

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

/** 请求日志状态：成功显示状态码（缺省 200），失败显示状态码或 ERR */
export function StatusPill({ log }: { log: Pick<LogItem, 'status' | 'status_code'> }) {
  const ok = log.status === 'success'
  return <span className={`ah-log-pill ${ok ? 'ok' : 'err'}`}>{log.status_code || (ok ? 200 : 'ERR')}</span>
}

export function Loading() {
  return (
    <div className="ah-logt-empty">
      <span className="ah-spin ah-spin-orange" /> 加载中…
    </div>
  )
}
