import express from 'express'
import path from 'node:path'
import { PORT, WEB_DIST } from './config'
import { getSettings } from './db'
import { channelsRouter } from './routes/channels'
import { settingsRouter } from './routes/settings'
import { statsRouter } from './routes/stats'
import { logsRouter } from './routes/logs'
import { thinkingRouter } from './routes/thinking'
import { preprocessRouter } from './routes/preprocess'
import { openaiEntry } from './entry/openai'
import { anthropicEntry } from './entry/anthropic'
import { responsesEntry } from './entry/responses'
import { cleanupOldLogs } from './stats/recorder'
import { createTokenGuard } from './core/accessToken'

const app = express()
app.use(express.json({ limit: '50mb' }))

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, name: 'AggHub', ts: Date.now() })
})

// ── 访问令牌校验（内网默认 access_token 为空 = 不校验）──
// /api 与 /v1 共用同一令牌：不然设置了令牌也能从管理 API 拿到全部渠道 key，形同虚设
const requireToken = createTokenGuard(() => getSettings().access_token)

app.use('/api', requireToken)

// ── 管理 API ──
app.use('/api/channels', channelsRouter)
app.use('/api/settings', settingsRouter)
app.use('/api/stats', statsRouter)
app.use('/api/logs', logsRouter)
app.use('/api/thinking', thinkingRouter)
app.use('/api/preprocess', preprocessRouter)

// ── 对外双入口 ──
app.use('/v1', requireToken)
app.use('/v1', openaiEntry) // /v1/chat/completions, /v1/models
app.use('/v1', anthropicEntry) // /v1/messages
app.use('/v1', responsesEntry) // /v1/responses

// ── 托管前端 + SPA 回退 ──
app.use(express.static(WEB_DIST))
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/v1')) return next()
  res.sendFile(path.join(WEB_DIST, 'index.html'), (err) => {
    if (err) res.status(404).end()
  })
})

// ── 全局错误兜底：JSON 解析失败及任何漏网的同步错误，统一返回 JSON（而非默认 HTML / 挂起）──
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (res.headersSent) return
  const status = err?.status || err?.statusCode || 400
  const message = err?.type === 'entity.parse.failed' ? '请求体不是合法 JSON' : String(err?.message || err || 'bad request')
  if (req.path.startsWith('/v1/messages')) {
    res.status(status).json({ type: 'error', error: { type: 'invalid_request_error', message } })
  } else {
    res.status(status).json({ error: { message, type: 'invalid_request_error', code: status } })
  }
})

// ── 定时清理过期日志 ──
const cleanup = () => {
  void cleanupOldLogs().catch(error => console.warn('[agghub] 清理过期日志失败:', error))
}
// 启动监听后再分批维护；小包尾部仍沿用一天等待期，GC 至少每六小时执行。
setImmediate(cleanup)
setInterval(cleanup, 60_000).unref()

app.listen(PORT, () => {
  console.log(`🍊 AggHub 网关已启动: http://localhost:${PORT}`)
})
