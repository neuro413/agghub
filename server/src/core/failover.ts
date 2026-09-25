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
  constructor(status: number, body: string) {
    super(`upstream ${status}`)
    this.name = 'UpstreamError'
    this.status = status
    this.body = body
  }
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

/** 是否为瞬时错误、值得在「本渠道」再试一次：网络/超时/5xx/429/402 额度池耗尽 → true；其余 4xx → false */
export function shouldRetry(err: any): boolean {
  if (err instanceof LocalRequestError || err instanceof CandidateError) return false
  if (err instanceof RequestStopped) return err.reason === 'upstream_idle'
  if (!(err instanceof UpstreamError)) return true // 网络错误 / 上游超时
  if (err.status === 429) return true
  if (err.status >= 500) return true
  if (isBudgetPoolExhausted(err)) return true
  return false
}

/** 只有本地确定的输入错误阻止跨渠道尝试；上游 400/413/422 仍可能由备用渠道处理。 */
export function isRequestError(err: any): boolean {
  return err instanceof LocalRequestError
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
