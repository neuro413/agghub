import { STATUS_CODES } from 'node:http'
import net from 'node:net'
import { RequestStopped } from './requestLifecycle'

export class LocalRequestError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = 'LocalRequestError' }
}

/** 当前渠道无法处理输入，可切换渠道，重复尝试当前渠道没有帮助。 */
export class CandidateError extends Error {
  constructor(message: string) { super(message); this.name = 'CandidateError' }
}

/** 上游返回的 HTTP 错误（非 2xx）*/
export class UpstreamError extends Error {
  status: number
  body: string
  /** 上游 Retry-After 头折算的等待毫秒数 */
  retryAfterMs?: number
  constructor(status: number, body: string, retryAfterMs?: number) {
    super(`upstream ${status}`)
    this.name = 'UpstreamError'
    this.status = status
    this.body = body
    this.retryAfterMs = retryAfterMs
  }
}

/** 上游返回 2xx，但网关在解析/转换/校验阶段失败；上游通常已计费，不再重试也不换渠道 */
export class UpstreamResponseError extends Error {
  constructor(message: string, readonly status = 502) { super(message); this.name = 'UpstreamResponseError' }
}

/** 解析 Retry-After 头（秒数或 HTTP 日期）为毫秒；缺失或无法解析返回 undefined */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  const text = value?.trim()
  if (!text) return undefined
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000)
  const at = Date.parse(text)
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined
}

export function parseAutoBanCodes(s: string): number[] {
  return (s || '')
    .split(',')
    .map((x) => parseInt(x.trim(), 10))
    .filter((n) => Number.isFinite(n))
}

/**
 * 402 且错误体为「Budget pool quota has been exhausted.」：
 * 某些逆向/共享额度渠道在额度池瞬时耗尽时返回此错误，通常几秒内即恢复，视同 429 值得在本渠道重试。
 * 其余 402（如账户余额不足）仍视为非瞬时错误，直接换渠道。
 */
export function isBudgetPoolExhausted(err: any): boolean {
  if (!(err instanceof UpstreamError)) return false
  if (err.status !== 402) return false
  return /budget\s+pool\s+quota\s+has\s+been\s+exhausted/i.test(err.body || '')
}

/**
 * 是否为瞬时错误、值得在「本渠道」再试一次：网络/超时/5xx/429/402 额度池耗尽 → true；其余 4xx → false。
 * alwaysRetry（渠道开启「一律重试」）时上游任何 HTTP 错误都返回 true；本地错误、2xx 后的处理失败与取消仍不重试。
 */
export function shouldRetry(err: any, alwaysRetry = false): boolean {
  if (err instanceof LocalRequestError || err instanceof CandidateError || err instanceof UpstreamResponseError) return false
  if (err instanceof RequestStopped) return err.reason === 'upstream_idle'
  if (!(err instanceof UpstreamError)) return true // 网络错误 / 上游超时
  if (alwaysRetry) return true
  if (err.status === 429) return true
  if (err.status >= 500) return true
  if (isBudgetPoolExhausted(err)) return true
  return false
}

/** 是否应自动禁用该渠道：命中熔断状态码（默认 401/403，多为凭证失效）*/
export function shouldDisable(err: any, autoBanCodes: number[]): boolean {
  if (err instanceof UpstreamError) return autoBanCodes.includes(err.status)
  return false
}

/** 从上游错误体里尽量提取人类可读的 message */
export function extractUpstreamMessage(body: string): string {
  try {
    const j = JSON.parse(body)
    return j?.error?.message || j?.error?.type || j?.message || body.slice(0, 300)
  } catch {
    return (body || '').slice(0, 300)
  }
}

/** 错误来源：上游 HTTP 错误 / 网络与未知错误 / 本地判定（参数、无渠道、取消、超时） */
export type ErrorKind = 'upstream' | 'network' | 'local'

export function errorKind(error: unknown): ErrorKind {
  if (error instanceof UpstreamError || error instanceof UpstreamResponseError) return 'upstream'
  if (error instanceof LocalRequestError || error instanceof CandidateError || error instanceof RequestStopped) return 'local'
  return 'network'
}

/** 只保留状态码与标准短语，如「503 Service Unavailable」；非标准状态码只留数字 */
export function statusOnlyMessage(code: number): string {
  return STATUS_CODES[code] ? `${code} ${STATUS_CODES[code]}` : String(code)
}

/** 公网端口返回给客户端前的错误信息脱敏；日志仍记录原文 */
export function sanitizePublicError(kind: ErrorKind, message: string): string {
  if (kind === 'network') return '上游连接失败'
  if (kind === 'local') return message
  // 上游错误：抹掉 URL、IP 与疑似密钥，再截断；正则逐条至少 O(n)，先截断，避免超长文本拖住主线程
  let text = message.slice(0, 2000)
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
  text = text.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, m => net.isIPv4(m.split(':')[0]) ? '[ip]' : m)
  // 每段都有上界，最坏 O(n)；原来的 [0-9a-f]*:[0-9a-f:]*:[0-9a-f]* 在无冒号长串上是 O(n²)。段内允许 0 位以覆盖 :: 缩写
  text = text.replace(/(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}/gi, m => net.isIPv6(m) ? '[ip]' : m)
  text = text.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
  text = text.replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
  const trimmed = text.slice(0, 300).trim()
  return trimmed || '上游返回错误'
}
