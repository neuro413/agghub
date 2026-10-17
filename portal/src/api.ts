import type { CheckinInfo, LogPage, Notices, PortalGroup, PortalKey, PortalStatus, PricingData, Self, UsageDay } from './types'

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

// 会话失效时由 App 跳回登录页
let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn
}

/** 后端统一返回 { success, message, data }；写操作一律带 JSON 体（服务端据此防 CSRF） */
async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const r = await fetch('/api/user' + path, {
    method,
    signal,
    credentials: 'same-origin',
    headers: method === 'GET' ? undefined : { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  })
  let payload: { success?: boolean; message?: string; data?: T }
  try {
    payload = await r.json()
  } catch {
    throw new ApiError(`服务器返回异常（HTTP ${r.status}）`, r.status)
  }
  if (r.status === 401 && !path.startsWith('/login')) onUnauthorized?.()
  if (!payload.success) throw new ApiError(payload.message || `HTTP ${r.status}`, r.status)
  return payload.data as T
}

export const api = {
  status: () => request<PortalStatus>('/status'),
  register: (username: string, password: string) => request<null>('/register', 'POST', { username, password }),
  login: (username: string, password: string) => request<Self>('/login', 'POST', { username, password }),
  logout: () => request<null>('/logout', 'POST'),
  /** 返回 Discord 授权地址，state 同时写进 Cookie */
  discordStart: () => request<{ url: string; state: string }>('/oauth/discord/start', 'POST'),
  discordCallback: (code: string, state: string) => request<Self>('/oauth/discord/callback', 'POST', { code, state }),
  self: (signal?: AbortSignal) => request<Self>('/self', 'GET', undefined, signal),
  changePassword: (old_password: string, new_password: string) => request<null>('/password', 'POST', { old_password, new_password }),
  usage: (days: number, signal?: AbortSignal) => request<UsageDay[]>(`/usage?days=${days}`, 'GET', undefined, signal),
  groups: (signal?: AbortSignal) => request<PortalGroup[]>('/groups', 'GET', undefined, signal),
  /** 可用分组与模型基础价格 */
  pricing: (signal?: AbortSignal) => request<PricingData>('/pricing', 'GET', undefined, signal),
  notices: (signal?: AbortSignal) => request<Notices>('/notices', 'GET', undefined, signal),

  keys: (signal?: AbortSignal) => request<PortalKey[]>('/keys', 'GET', undefined, signal),
  createKey: (name: string, group: string, expires_at: number | null) => request<PortalKey>('/keys', 'POST', { name, group, expires_at }),
  fullKey: (id: number) => request<{ key: string }>(`/keys/${id}/key`, 'POST'),
  setKeyEnabled: (id: number, enabled: boolean) => request<PortalKey>(`/keys/${id}`, 'PUT', { enabled }),
  setKeyGroup: (id: number, group: string) => request<PortalKey>(`/keys/${id}`, 'PUT', { group }),
  deleteKey: (id: number) => request<null>(`/keys/${id}`, 'DELETE'),

  logs: (query: { page: number; size: number; key_id?: number; model?: string }, signal?: AbortSignal) => {
    const params = new URLSearchParams({ page: String(query.page), size: String(query.size) })
    if (query.key_id) params.set('key_id', String(query.key_id))
    if (query.model) params.set('model', query.model)
    return request<LogPage>(`/logs?${params}`, 'GET', undefined, signal)
  },

  checkinInfo: (month: string, signal?: AbortSignal) => request<CheckinInfo>(`/checkin?month=${month}`, 'GET', undefined, signal),
  checkin: () => request<{ day: string; points: number; quota: number }>('/checkin', 'POST'),
}
