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
  if (!(err instanceof UpstreamError)) return true // 网络错误 / 超时 / abort
  if (err.status === 429) return true
  if (err.status >= 500) return true
  if (isBudgetPoolExhausted(err)) return true
  return false
}

/**
 * 是否为「请求级」错误：请求本身有问题（参数非法/过大/无法处理），换任何渠道都会同样失败。
 * 命中则直接把原始错误返回客户端，不再重试、不再换渠道，避免空跑拖延。
 * 注意 401/403（凭证失效）/404（该渠道无此模型）不算请求级 —— 换个渠道仍可能成功。
 */
export function isRequestError(err: any): boolean {
  if (!(err instanceof UpstreamError)) return false // 网络/超时归为可换渠道重试
  const s = err.status
  return s === 400 || s === 413 || s === 422
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
