import { randomBytes } from 'node:crypto'
import { db } from '../db'
import { parseProxyUri } from './uri'
import type { PoolSettings } from './types'

const KEY = 'proxy_pool'

export const DEFAULT_POOL_SETTINGS: PoolSettings = {
  enabled: false,
  core_path: '',
  controller_port: 19090,
  listen_base_port: 19100,
  secret: '',
  test_url: 'https://www.gstatic.com/generate_204',
  test_timeout_ms: 5000,
  test_concurrency: 20,
  probe_enabled: false,
  probe_interval_minutes: 30,
  auto_disable_failures: 3,
  node_retry_times: 3,
  limit_cooldown_seconds: 60,
  entry_proxy: '',
  download_proxy: '',
}

let cached: PoolSettings | null = null

function load(): PoolSettings {
  const raw = db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(KEY) as string | undefined
  let stored: Partial<PoolSettings> = {}
  if (raw) {
    try {
      const value = JSON.parse(raw)
      if (value && typeof value === 'object') stored = value
    } catch { /* 损坏时按默认值 */ }
  }
  const settings = { ...DEFAULT_POOL_SETTINGS }
  for (const key of Object.keys(DEFAULT_POOL_SETTINGS) as (keyof PoolSettings)[]) {
    if (typeof stored[key] === typeof DEFAULT_POOL_SETTINGS[key]) (settings as Record<string, unknown>)[key] = stored[key]
  }
  if (!settings.secret) {
    settings.secret = randomBytes(16).toString('hex')
    persist(settings)
  }
  return settings
}

function persist(settings: PoolSettings): void {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY, JSON.stringify(settings))
}

export function getPoolSettings(): PoolSettings {
  if (!cached) cached = load()
  return cached
}

function intIn(value: unknown, min: number, max: number, label: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label}须为 ${min}~${max} 的整数`)
  return n
}

function checkProxyUrl(value: string, label: string): void {
  if (!value) return
  let url: URL
  try { url = new URL(value) } catch { throw new Error(`${label}不是有效地址`) }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${label}只支持 http / https`)
}

/** 校验并合并补丁，返回新设置与实际变化的字段 */
export function updatePoolSettings(patch: Record<string, unknown>): { settings: PoolSettings; changed: Set<keyof PoolSettings> } {
  const current = getPoolSettings()
  const next: PoolSettings = { ...current }
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  for (const [key, value] of Object.entries(patch)) {
    switch (key as keyof PoolSettings) {
      case 'enabled': next.enabled = !!value; break
      case 'probe_enabled': next.probe_enabled = !!value; break
      case 'core_path': next.core_path = str(value); break
      case 'controller_port': next.controller_port = intIn(value, 1024, 65535, '控制端口'); break
      case 'listen_base_port': next.listen_base_port = intIn(value, 1024, 65000, '监听起始端口'); break
      case 'test_url': {
        const url = str(value)
        if (!/^https?:\/\/\S+$/.test(url)) throw new Error('测速 URL 须为 http(s) 地址')
        next.test_url = url
        break
      }
      case 'test_timeout_ms': next.test_timeout_ms = intIn(value, 500, 60000, '测速超时'); break
      case 'test_concurrency': next.test_concurrency = intIn(value, 1, 100, '测速并发'); break
      case 'probe_interval_minutes': next.probe_interval_minutes = intIn(value, 1, 1440, '拨测间隔'); break
      case 'auto_disable_failures': next.auto_disable_failures = intIn(value, 0, 100, '自动禁用阈值'); break
      case 'node_retry_times': next.node_retry_times = intIn(value, 0, 20, '换节点上限'); break
      case 'limit_cooldown_seconds': next.limit_cooldown_seconds = intIn(value, 0, 86400, '429/403 冷却秒数'); break
      case 'entry_proxy': {
        const entry = str(value)
        if (entry && !parseProxyUri(entry)) throw new Error('入口代理无法解析，请填节点链接或 http(s)/socks5 地址')
        next.entry_proxy = entry
        break
      }
      case 'download_proxy': {
        const proxy = str(value)
        checkProxyUrl(proxy, '下载代理')
        next.download_proxy = proxy
        break
      }
      default: break
    }
  }
  if (next.controller_port >= next.listen_base_port && next.controller_port < next.listen_base_port + 5000) {
    throw new Error('控制端口不能落在节点监听端口段内（起始端口往后 5000 个）')
  }
  const changed = new Set<keyof PoolSettings>()
  for (const key of Object.keys(next) as (keyof PoolSettings)[]) {
    if (next[key] !== current[key]) changed.add(key)
  }
  if (changed.size) {
    persist(next)
    cached = next
  }
  return { settings: next, changed }
}
