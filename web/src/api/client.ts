import type {
  Channel,
  LogDetail,
  LogFacets,
  LogItem,
  ParamRule,
  ParamTestResult,
  Settings,
  Stats,
  TestResult,
  ThinkingDetail,
  ThinkingEntry,
} from '../types'

const BASE = '/api'
const TOKEN_KEY = 'agghub_token'

export function getStoredToken(): string {
  return localStorage.getItem(TOKEN_KEY) || ''
}

export function setStoredToken(token: string): void {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

// 服务端设置了访问令牌而本地没有/不对时，由 App 弹出令牌输入
let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn
}

async function req<T>(path: string, opts?: RequestInit): Promise<T> {
  const token = getStoredToken()
  const r = await fetch(BASE + path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-api-key': token } : {}),
      ...(opts?.headers as Record<string, string> | undefined),
    },
  })
  if (r.status === 401) {
    onUnauthorized?.()
    throw new Error('需要访问令牌')
  }
  if (!r.ok) {
    let msg = `HTTP ${r.status}`
    try {
      const j: any = await r.json()
      msg = typeof j.error === 'string' ? j.error : j.error?.message || j.message || msg
    } catch {}
    throw new Error(msg)
  }
  if (r.status === 204) return undefined as T
  return r.json()
}

export const api = {
  // ── 渠道 ──
  listChannels: () => req<Channel[]>('/channels'),
  createChannel: (data: Partial<Channel>) => req<Channel>('/channels', { method: 'POST', body: JSON.stringify(data) }),
  updateChannel: (id: number, data: Partial<Channel>) =>
    req<Channel>(`/channels/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteChannel: (id: number) => req<{ ok: boolean }>(`/channels/${id}`, { method: 'DELETE' }),
  testChannel: (data: Partial<Channel>) =>
    req<TestResult>('/channels/test', { method: 'POST', body: JSON.stringify(data) }),

  // ── 设置 ──
  getSettings: () => req<Settings>('/settings'),
  updateSettings: (data: Partial<Settings>) => req<Settings>('/settings', { method: 'PUT', body: JSON.stringify(data) }),

  // ── 统计 ──
  getStats: (range: string) => req<Stats>(`/stats?range=${range}`),

  // ── 日志 ──
  listLogs: (
    p: {
      limit?: number
      offset?: number
      status?: string
      channel_id?: number
      model?: string
      entry_format?: string
      is_stream?: string
      q?: string
    } = {},
  ) => {
    const query = new URLSearchParams()
    if (p.limit != null) query.set('limit', String(p.limit))
    if (p.offset != null) query.set('offset', String(p.offset))
    if (p.status) query.set('status', p.status)
    if (p.channel_id != null) query.set('channel_id', String(p.channel_id))
    if (p.model) query.set('model', p.model)
    if (p.entry_format) query.set('entry_format', p.entry_format)
    if (p.is_stream) query.set('is_stream', p.is_stream)
    if (p.q) query.set('q', p.q)
    return req<{ total: number; limit: number; offset: number; items: LogItem[] }>(`/logs?${query.toString()}`)
  },
  getLog: (id: number) => req<LogDetail>(`/logs/${id}`),
  getLogFacets: () => req<LogFacets>('/logs/facets'),
  deleteLog: (id: number) => req<{ ok: boolean }>(`/logs/${id}`, { method: 'DELETE' }),
  clearLogs: () => req<{ ok: boolean }>('/logs', { method: 'DELETE' }),

  // ── 思维链存储 ──
  listThinking: (p: { limit?: number; offset?: number } = {}) => {
    const query = new URLSearchParams()
    if (p.limit != null) query.set('limit', String(p.limit))
    if (p.offset != null) query.set('offset', String(p.offset))
    return req<{ total: number; items: ThinkingEntry[] }>(`/thinking?${query.toString()}`)
  },
  getThinking: (sig: string) => req<ThinkingDetail>(`/thinking/${encodeURIComponent(sig)}`),
  deleteThinking: (sigs: string[]) =>
    req<{ ok: boolean; deleted: number }>('/thinking', { method: 'DELETE', body: JSON.stringify({ signatures: sigs }) }),

  // ── 参数修改规则试运行 ──
  testParamRule: (data: { rule: ParamRule; body: string; wireFormat?: string }) =>
    req<ParamTestResult>('/preprocess/param-test', { method: 'POST', body: JSON.stringify(data) }),
}
