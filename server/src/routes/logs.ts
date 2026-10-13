import { Router } from 'express'
import { db } from '../db'
import { clearAllLogs, hydrateLogRow, LOG_BODY_FIELDS } from '../stats/recorder'
import type { LogBodyField } from '../types'

export const logsRouter = Router()

// 列表（不含大正文，节省流量；展开时再取详情）
logsRouter.get('/', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200)
  const offset = Number(req.query.offset) || 0

  const where: string[] = []
  const args: any[] = []
  // 默认只列每次请求的最终结果（与统计口径一致）；?include_retries=1 查看重试中的中间尝试
  if (req.query.include_retries !== '1') where.push('is_retry = 0')
  if (req.query.status === 'success' || req.query.status === 'error') {
    where.push('status = ?')
    args.push(req.query.status)
  }
  if (req.query.channel_id) {
    where.push('channel_id = ?')
    args.push(Number(req.query.channel_id))
  }
  if (req.query.model) {
    where.push('model = ?')
    args.push(String(req.query.model))
  }
  if (req.query.entry_format === 'openai' || req.query.entry_format === 'anthropic' || req.query.entry_format === 'responses') {
    where.push('entry_format = ?')
    args.push(req.query.entry_format)
  }
  if (req.query.is_stream === '0' || req.query.is_stream === '1') {
    where.push('is_stream = ?')
    args.push(Number(req.query.is_stream))
  }
  const keyId = Number(req.query.key_id)
  if (req.query.key_id && Number.isSafeInteger(keyId) && keyId > 0) {
    where.push('key_id = ?')
    args.push(keyId)
  }
  if (req.query.source === 'owner') {
    // 旧日志 source 为 NULL，视同 owner
    where.push("(source = 'owner' OR source IS NULL)")
  } else if (req.query.source === 'lan_key' || req.query.source === 'public_key') {
    where.push('source = ?')
    args.push(req.query.source)
  }
  if (req.query.q) {
    const kw = `%${String(req.query.q).trim()}%`
    where.push('(model LIKE ? OR channel_name LIKE ? OR upstream_model LIKE ? OR error_message LIKE ? OR key_name LIKE ?)')
    args.push(kw, kw, kw, kw, kw)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM request_logs ${whereSql}`).get(...args) as { n: number }).n

  const rows = db
    .prepare(
      `SELECT id, created_at, channel_id, channel_name, entry_format, model, upstream_model,
              status, status_code, latency_ms, request_id, attempt_latency_ms,
              response_body_truncated, upstream_response_body_truncated,
              prompt_tokens, completion_tokens, total_tokens,
              cache_read_tokens, cache_write_tokens,
              retry_count, is_stream, error_message, preprocessed, pseudo_thinking,
              source, key_id, key_name, client_ip, quota_points
       FROM request_logs ${whereSql}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset)

  res.json({ total, limit, offset, items: rows })
})

// 可选项（供前端筛选下拉：出现过的模型 / 渠道）
logsRouter.get('/facets', (_req, res) => {
  const models = db
    .prepare(`SELECT model, COUNT(*) AS n FROM request_logs WHERE model IS NOT NULL GROUP BY model ORDER BY n DESC LIMIT 100`)
    .all() as { model: string; n: number }[]
  const channels = db
    .prepare(
      `SELECT channel_id, channel_name, COUNT(*) AS n FROM request_logs
       WHERE channel_id IS NOT NULL GROUP BY channel_id ORDER BY n DESC LIMIT 100`,
    )
    .all() as { channel_id: number; channel_name: string; n: number }[]
  const keys = db
    .prepare(
      `SELECT key_id, MAX(key_name) AS key_name, COUNT(*) AS n FROM request_logs
       WHERE key_id IS NOT NULL GROUP BY key_id ORDER BY n DESC LIMIT 100`,
    )
    .all() as { key_id: number; key_name: string; n: number }[]
  res.json({ models, channels, keys })
})

// 单条详情：fields 为空时只取元数据，省略时维持完整详情接口。
logsRouter.get('/:id', (req, res) => {
  let fields: LogBodyField[] | undefined
  if (req.query.fields !== undefined) {
    if (typeof req.query.fields !== 'string') return res.status(400).json({ error: 'fields 必须为逗号分隔的字段名' })
    const names = req.query.fields === '' ? [] : req.query.fields.split(',')
    if (names.some(field => !LOG_BODY_FIELDS.includes(field as LogBodyField))) return res.status(400).json({ error: '未知日志正文字段' })
    fields = [...new Set(names)] as LogBodyField[]
  }
  const row = db.prepare('SELECT * FROM request_logs WHERE id = ?').get(Number(req.params.id))
  if (!row) return res.status(404).json({ error: 'not found' })
  res.json(hydrateLogRow(row, fields))
})

// 删除单条
logsRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM request_logs WHERE id = ?').run(Number(req.params.id))
  res.json({ ok: true })
})

// 清空日志
logsRouter.delete('/', (_req, res) => {
  clearAllLogs()
  res.json({ ok: true })
})
