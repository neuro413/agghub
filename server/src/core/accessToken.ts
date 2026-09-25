import type { Request, Response, NextFunction } from 'express'
import { normalizeAccessToken } from './settingsValidation'

let lastWarning = -Infinity

/** 获取设置通过参数注入，测试不必导入启动服务/数据库的模块。 */
export function createTokenGuard(getToken: () => string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    let token: string
    try { token = normalizeAccessToken(getToken()) } catch {
      if (Date.now() - lastWarning > 60_000) {
        lastWarning = Date.now()
        console.error('[agghub] access_token 配置无效，已拒绝访问；请在本地备份配置后修正令牌')
      }
      res.status(503).json({ error: { message: '访问令牌配置无效，请在本地修正配置', type: 'auth_config_error' } })
      return
    }
    if (!token) return next()
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    const auth = bearer || (req.headers['x-api-key'] as string) || ''
    if (typeof auth === 'string' && auth.trim() === token) return next()
    res.status(401).json({ error: { message: 'invalid access token', type: 'auth_error' } })
  }
}
