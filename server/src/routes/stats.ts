import { Router } from 'express'
import { db } from '../db'

export const statsRouter = Router()

type Range = '24h' | '7d' | '30d'

function rangeToParams(range: Range): { since: number; bucketMs: number; now: number } {
  const now = Date.now()
  const H = 3600_000
  const D = 86_400_000
  switch (range) {
    case '7d':
      return { since: now - 7 * D, bucketMs: D, now }
    case '30d':
      return { since: now - 30 * D, bucketMs: D, now }
    case '24h':
    default:
      return { since: now - 24 * H, bucketMs: H, now }
  }
}

statsRouter.get('/', (req, res) => {
  const range = (['24h', '7d', '30d'].includes(String(req.query.range)) ? req.query.range : '24h') as Range
  const { since, bucketMs, now } = rangeToParams(range)

  // 统计口径：只算每次客户端请求的「最终结果」(is_retry=0)，重试中的中间尝试不计入
  const overview = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success,
         COALESCE(SUM(total_tokens), 0) AS tokens,
         COALESCE(AVG(latency_ms), 0) AS avg_latency
       FROM request_logs WHERE created_at >= ? AND created_at <= ? AND is_retry = 0`,
    )
    .get(since, now) as { total: number; success: number; tokens: number; avg_latency: number }

  const total = overview.total || 0
  const success = overview.success || 0

  const trendRows = db
    .prepare(
      `SELECT CAST(created_at / ? AS INTEGER) * ? AS bucket,
              COUNT(*) AS requests,
              COALESCE(SUM(total_tokens), 0) AS tokens
       FROM request_logs WHERE created_at >= ? AND created_at <= ? AND is_retry = 0
       GROUP BY bucket ORDER BY bucket ASC`,
    )
    .all(bucketMs, bucketMs, since, now) as { bucket: number; requests: number; tokens: number }[]

  // 补齐零值桶：查询仅返回有数据的桶，按真实时间轴铺满空桶，避免折线图等距绘制时时间失真
  const trendMap = new Map(trendRows.map((r) => [r.bucket, r]))
  const startBucket = Math.floor(since / bucketMs) * bucketMs
  const endBucket = Math.floor(now / bucketMs) * bucketMs
  const trend: { bucket: number; requests: number; tokens: number }[] = []
  for (let b = startBucket; b <= endBucket; b += bucketMs) {
    const r = trendMap.get(b)
    trend.push({ bucket: b, requests: r?.requests || 0, tokens: r?.tokens || 0 })
  }

  const byChannel = db
    .prepare(
      `SELECT channel_id, channel_name,
              COUNT(*) AS count,
              SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success
       FROM request_logs WHERE created_at >= ? AND created_at <= ? AND is_retry = 0
       GROUP BY channel_id ORDER BY count DESC`,
    )
    .all(since, now) as { channel_id: number; channel_name: string; count: number; success: number }[]

  const byModel = db
    .prepare(
      `SELECT model, COUNT(*) AS count
       FROM request_logs WHERE created_at >= ? AND created_at <= ? AND is_retry = 0
       GROUP BY model ORDER BY count DESC LIMIT 20`,
    )
    .all(since, now) as { model: string; count: number }[]

  res.json({
    range,
    bucketMs,
    since,
    overview: {
      total,
      success,
      error: total - success,
      success_rate: total > 0 ? success / total : 1,
      total_tokens: overview.tokens || 0,
      avg_latency: Math.round(overview.avg_latency || 0),
    },
    trend,
    by_channel: byChannel,
    by_model: byModel,
  })
})
