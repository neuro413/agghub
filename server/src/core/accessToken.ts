import crypto from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'

/** 从 Authorization: Bearer 或 x-api-key 取令牌（去首尾空白），没有则空串 */
export function extractToken(req: Request): string {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const raw = bearer || req.headers['x-api-key']
  return typeof raw === 'string' ? raw.trim() : ''
}

/** 时序安全比较：长度不同直接 false（仍执行一次等长比较以消除时间差），相同长度用 crypto.timingSafeEqual */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) {
    // 用自身做一次等长比较，削弱长度差异带来的时间特征
    crypto.timingSafeEqual(left, left)
    return false
  }
  return crypto.timingSafeEqual(left, right)
}

/** 令牌在保存时已规范化；空串表示关闭鉴权。获取设置通过参数注入，测试不必导入数据库模块。 */
export function createTokenGuard(getToken: () => string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = getToken()
    if (!token) return next()
    if (safeEqual(extractToken(req), token)) return next()
    res.status(401).json({ error: { message: 'invalid access token', type: 'auth_error' } })
  }
}
