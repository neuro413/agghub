import express from 'express'
import path from 'node:path'
import type { ErrorRequestHandler, Express, RequestHandler } from 'express'
import { PORTAL_DIST, TRUST_PROXY, WEB_DIST } from './config'
import { getSettings } from './db'
import { channelsRouter } from './routes/channels'
import { settingsRouter } from './routes/settings'
import { statsRouter } from './routes/stats'
import { logsRouter } from './routes/logs'
import { thinkingRouter } from './routes/thinking'
import { preprocessRouter } from './routes/preprocess'
import { billingRouter } from './routes/billing'
import { keysRouter, metaRouter } from './routes/keys'
import { usersRouter } from './routes/users'
import { portalRouter } from './routes/portal'
import { openaiEntry } from './entry/openai'
import { anthropicEntry } from './entry/anthropic'
import { responsesEntry } from './entry/responses'
import { createTokenGuard } from './core/accessToken'
import { createAdmission, createCallerResolver } from './core/caller'
import { sendEntryError } from './core/entryError'
import type { Surface } from './types'

/** 只在这三个路径上做额度预检与限流 */
const GENERATION_PATHS = ['/v1/chat/completions', '/v1/messages', '/v1/responses']

/** 三个对外入口 */
function mountEntries(app: Express): void {
  app.use('/v1', openaiEntry)
  app.use('/v1', anthropicEntry)
  app.use('/v1', responsesEntry)
}

/** 全局错误兜底：JSON 解析失败及任何漏网的同步错误，按入口格式统一返回 JSON */
const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) return
  const status = err?.status || err?.statusCode || 400
  const message = err?.type === 'entity.parse.failed' ? '请求体不是合法 JSON' : String(err?.message || err || 'bad request')
  sendEntryError(req, res, status, 'invalid_request_error', 'invalid_request_error', message)
}

/** 组装内网 app：管理 API + WebUI + 可匿名的 /v1 */
function createLanApp(): Express {
  const app = express()
  app.use(express.json({ limit: '50mb' }))

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, name: 'AggHub', ts: Date.now() })
  })

  // ── 访问令牌校验（内网默认 access_token 为空 = 不校验）──
  app.use('/api', createTokenGuard(() => getSettings().access_token))

  // ── 管理 API ──
  app.use('/api/channels', channelsRouter)
  app.use('/api/settings', settingsRouter)
  app.use('/api/stats', statsRouter)
  app.use('/api/logs', logsRouter)
  app.use('/api/thinking', thinkingRouter)
  app.use('/api/preprocess', preprocessRouter)
  app.use('/api/keys', keysRouter)
  app.use('/api/users', usersRouter)
  app.use('/api/billing', billingRouter)
  app.use('/api', metaRouter)

  // ── 对外入口：先解析调用方，再在生成接口上做额度预检与限流 ──
  app.use('/v1', createCallerResolver('lan', () => getSettings().access_token))
  app.post(GENERATION_PATHS, createAdmission())
  mountEntries(app)

  // ── 托管前端 + SPA 回退 ──
  app.use(express.static(WEB_DIST))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/v1')) return next()
    res.sendFile(path.join(WEB_DIST, 'index.html'), (err) => {
      if (err) res.status(404).end()
    })
  })

  app.use(errorHandler)
  return app
}

/** 门户页面与接口的基础安全响应头 */
const portalHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'same-origin')
  next()
}

/** 组装公网 app：/v1 强制 Key、先鉴权后解析请求体；/api/user 与静态页面是用户门户 */
function createPublicApp(): Express {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', TRUST_PROXY)

  // 鉴权走请求头、不用 Cookie，开放来源是安全的，方便浏览器端客户端直接调用
  app.use('/v1', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'authorization, x-api-key, content-type, anthropic-version, anthropic-beta')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Max-Age', '86400')
    if (req.method === 'OPTIONS') return res.status(204).end()
    next()
  })

  app.use('/v1', createCallerResolver('public', () => ''))
  app.post(GENERATION_PATHS, createAdmission())
  // 先鉴权后解析：未鉴权的请求不会触发 50MB 的 JSON 解析
  app.use('/v1', express.json({ limit: '50mb' }))
  mountEntries(app)

  // ── 用户门户：会话走 Cookie，不开放跨域 ──
  app.use('/api/user', portalHeaders, portalRouter)
  app.use(portalHeaders, express.static(PORTAL_DIST))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/v1')) return next()
    res.sendFile(path.join(PORTAL_DIST, 'index.html'), (err) => {
      if (err) res.status(404).type('text/plain').send('用户门户未构建，请先执行 npm run build')
    })
  })

  app.use((req, res) => sendEntryError(req, res, 404, 'not_found', 'not_found_error', 'not found'))
  app.use(errorHandler)
  return app
}

export function createApp(surface: Surface): Express {
  return surface === 'public' ? createPublicApp() : createLanApp()
}
