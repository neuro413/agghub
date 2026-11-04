import { getProxyAgent } from '../core/proxy'
import { getSettings } from '../db'
import { parseSubscriptionText } from './importer'
import { getPoolSettings } from './settings'
import { getSubscription, listSubscriptions, replaceSubscriptionNodes, setSubscriptionResult } from './store'
import type { ParsedNode, PoolSubscription } from './types'

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const FALLBACK_UAS = ['clash-verge/v2.5.2', 'Clash.Meta', 'v2rayNG/1.8.5']
const MAX_BYTES = 10 * 1024 * 1024
const running = new Set<number>()

const errMessage = (err: unknown) => (err instanceof Error ? (err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message) : String(err))

async function fetchText(url: string, ua: string, proxy: string | null): Promise<{ status: number; text: string; userinfo: string | null }> {
  const options: Record<string, unknown> = {
    headers: { 'User-Agent': ua, Accept: '*/*' },
    signal: AbortSignal.timeout(30_000),
  }
  if (proxy) options.dispatcher = getProxyAgent(proxy)
  const res = await fetch(url, options as RequestInit)
  const chunks: Buffer[] = []
  let size = 0
  if (res.body) {
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength
      if (size > MAX_BYTES) throw new Error('订阅内容超过 10MB')
      chunks.push(Buffer.from(chunk))
    }
  }
  return { status: res.status, text: Buffer.concat(chunks).toString('utf8'), userinfo: res.headers.get('subscription-userinfo') }
}

/** 依次换 UA 拉取；直连网络错误时改走代理再试 */
async function fetchSubscription(sub: PoolSubscription): Promise<{ nodes: ParsedNode[]; userinfo: string | null }> {
  const uas = [...new Set([sub.user_agent.trim() || CHROME_UA, ...FALLBACK_UAS])]
  const proxy = getPoolSettings().download_proxy || getSettings().proxy_url || null
  let viaProxy = false
  let lastError = '拉取失败'
  for (const ua of uas) {
    let result: Awaited<ReturnType<typeof fetchText>>
    try {
      result = await fetchText(sub.url, ua, viaProxy ? proxy : null)
    } catch (err) {
      if (viaProxy || !proxy) {
        lastError = errMessage(err)
        continue
      }
      viaProxy = true
      try {
        result = await fetchText(sub.url, ua, proxy)
      } catch (err2) {
        lastError = `直连与代理均失败：${errMessage(err2)}`
        continue
      }
    }
    if (result.status < 200 || result.status >= 300) {
      lastError = `HTTP ${result.status}（UA ${ua}）`
      continue
    }
    const parsed = parseSubscriptionText(result.text)
    if (!parsed.nodes.length) {
      lastError = `UA ${ua} 拉到的内容里没有可识别的节点`
      continue
    }
    return { nodes: parsed.nodes, userinfo: result.userinfo }
  }
  throw new Error(lastError)
}

export async function refreshSubscription(id: number): Promise<boolean> {
  if (running.has(id)) return false
  const sub = getSubscription(id)
  if (!sub) return false
  running.add(id)
  try {
    const { nodes, userinfo } = await fetchSubscription(sub)
    // 拉取期间被删除
    if (!getSubscription(id)) return true
    replaceSubscriptionNodes(id, nodes)
    setSubscriptionResult(id, { ok: true, nodeCount: nodes.length, userinfo })
  } catch (err) {
    if (getSubscription(id)) setSubscriptionResult(id, { ok: false, error: errMessage(err) })
  } finally {
    running.delete(id)
  }
  return true
}

/** 后台触发更新；已在更新中返回 false */
export function triggerRefresh(id: number): boolean {
  if (running.has(id)) return false
  void refreshSubscription(id)
  return true
}

export function updatingIds(): number[] {
  return [...running]
}

let timer: NodeJS.Timeout | null = null
export function startSubscriptionScheduler(): void {
  if (timer) return
  timer = setInterval(() => {
    const now = Date.now()
    for (const sub of listSubscriptions()) {
      if (sub.update_interval > 0 && now >= (sub.last_update_at ?? 0) + sub.update_interval * 60_000) triggerRefresh(sub.id)
    }
  }, 60_000)
  timer.unref()
}
