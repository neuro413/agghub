import type { Request, Response, NextFunction } from 'express'

/** 令牌在保存时已规范化；空串表示关闭鉴权。获取设置通过参数注入，测试不必导入数据库模块。 */
export function createTokenGuard(getToken: () => string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = getToken()
    if (!token) return next()
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    const auth = bearer || (req.headers['x-api-key'] as string) || ''
    if (typeof auth === 'string' && auth.trim() === token) return next()
    res.status(401).json({ error: { message: 'invalid access token', type: 'auth_error' } })
  }
}
