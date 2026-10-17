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

  // 按 Key / 来源筛选：拼成额外 WHERE 片段，追加到全部统计查询的过滤条件之后
  const extra: string[] = []
  const extraArgs: any[] = []
  const keyId = Number(req.query.key_id)
  if (req.query.key_id && Number.isSafeInteger(keyId) && keyId > 0) {
    extra.push('key_id = ?')
    extraArgs.push(keyId)
  }
  if (req.query.source === 'owner') {
    extra.push("(source = 'owner' OR source IS NULL)")
  } else if (req.query.source === 'lan_key' || req.query.source === 'public_key' || req.query.source === 'user') {
    extra.push('source = ?')
    extraArgs.push(req.query.source)
  }
  const extraSql = extra.length ? ` AND ${extra.join(' AND ')}` : ''

  // 统计口径：只算每次客户端请求的「最终结果」(is_retry=0)，重试中的中间尝试不计入
  const overview = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success,
         COALESCE(SUM(total_tokens), 0) AS tokens,
         COALESCE(SUM(quota_points), 0) AS points,
         COALESCE(AVG(latency_ms), 0) AS avg_latency
       FROM request_logs WHERE created_at >= ? AND created_at <= ? AND is_retry = 0${extraSql}`,
    )
    .get(since, now, ...extraArgs) as { total: number; success: number; tokens: number; points: number; avg_latency: number }

  const total = overview.total || 0
  const success = overview.success || 0

  const trendRows = db
    .prepare(
      `SELECT CAST(created_at / ? AS INTEGER) * ? AS bucket,
              COUNT(*) AS requests,
              COALESCE(SUM(total_tokens), 0) AS tokens,
              COALESCE(SUM(quota_points), 0) AS points
       FROM request_logs WHERE created_at >= ? AND created_at <= ? AND is_retry = 0${extraSql}
       GROUP BY bucket ORDER BY bucket ASC`,
    )
    .all(bucketMs, bucketMs, since, now, ...extraArgs) as { bucket: number; requests: number; tokens: number; points: number }[]

  // RPM / TPM：按自然分钟分桶（日志在请求结束时写入，即按完成时间计），再归到趋势桶取每桶内的峰值分钟
  const minuteRows = db
    .prepare(
      `SELECT CAST(created_at / 60000 AS INTEGER) * 60000 AS minute,
              COUNT(*) AS requests,
              COALESCE(SUM(total_tokens), 0) AS tokens
       FROM request_logs WHERE created_at >= ? AND created_at <= ? AND is_retry = 0${extraSql}
       GROUP BY minute`,
    )
    .all(since, now, ...extraArgs) as { minute: number; requests: number; tokens: number }[]
  const peaks = new Map<number, { rpm: number; tpm: number }>()
  let peakRpm = { value: 0, at: null as number | null }
  let peakTpm = { value: 0, at: null as number | null }
  for (const m of minuteRows) {
    const bucket = Math.floor(m.minute / bucketMs) * bucketMs
    const p = peaks.get(bucket) ?? { rpm: 0, tpm: 0 }
    p.rpm = Math.max(p.rpm, m.requests)
    p.tpm = Math.max(p.tpm, m.tokens)
    peaks.set(bucket, p)
    if (m.requests > peakRpm.value) peakRpm = { value: m.requests, at: m.minute }
    if (m.tokens > peakTpm.value) peakTpm = { value: m.tokens, at: m.minute }
  }
  const current = db
    .prepare(
      `SELECT COUNT(*) AS requests, COALESCE(SUM(total_tokens), 0) AS tokens
       FROM request_logs WHERE created_at > ? AND created_at <= ? AND is_retry = 0${extraSql}`,
    )
    .get(now - 60_000, now, ...extraArgs) as { requests: number; tokens: number }

  // 补齐零值桶：查询仅返回有数据的桶，按真实时间轴铺满空桶，避免折线图等距绘制时时间失真
  const trendMap = new Map(trendRows.map((r) => [r.bucket, r]))
  const startBucket = Math.floor(since / bucketMs) * bucketMs
  const endBucket = Math.floor(now / bucketMs) * bucketMs
  const trend: { bucket: number; requests: number; tokens: number; points: number; peak_rpm: number; peak_tpm: number }[] = []
  for (let b = startBucket; b <= endBucket; b += bucketMs) {
    const r = trendMap.get(b)
    const p = peaks.get(b)
    trend.push({ bucket: b, requests: r?.requests || 0, tokens: r?.tokens || 0, points: r?.points || 0, peak_rpm: p?.rpm || 0, peak_tpm: p?.tpm || 0 })
  }

  const byChannel = db
    .prepare(
      `SELECT channel_id, channel_name,
              COUNT(*) AS count,
              SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success
       FROM request_logs WHERE created_at >= ? AND created_at <= ? AND is_retry = 0${extraSql}
       GROUP BY channel_id ORDER BY count DESC`,
    )
    .all(since, now, ...extraArgs) as { channel_id: number; channel_name: string; count: number; success: number }[]

  const byModel = db
    .prepare(
      `SELECT model, COUNT(*) AS count
       FROM request_logs WHERE created_at >= ? AND created_at <= ? AND is_retry = 0${extraSql}
       GROUP BY model ORDER BY count DESC LIMIT 20`,
    )
    .all(since, now, ...extraArgs) as { model: string; count: number }[]

  const byKey = db
    .prepare(
      `SELECT key_id, MAX(key_name) AS key_name, COUNT(*) AS count,
              SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success,
              COALESCE(SUM(quota_points), 0) AS points
       FROM request_logs WHERE created_at >= ? AND created_at <= ? AND is_retry = 0 AND key_id IS NOT NULL${extraSql}
       GROUP BY key_id ORDER BY points DESC, count DESC LIMIT 50`,
    )
    .all(since, now, ...extraArgs) as { key_id: number; key_name: string; count: number; success: number; points: number }[]

  // IP 分布：按 (IP, Key) 聚合后在内存归并，同时得到每个 IP 用过的 Key / 用户；未知 IP 归为 null 一组
  const ipKeyRows = db
    .prepare(
      `SELECT g.*, u.username AS user_name FROM (
         SELECT client_ip AS ip, key_id, MAX(key_name) AS key_name, MAX(user_id) AS user_id,
                COUNT(*) AS count,
                SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success,
                COALESCE(SUM(total_tokens), 0) AS tokens,
                COALESCE(SUM(quota_points), 0) AS points
         FROM request_logs WHERE created_at >= ? AND created_at <= ? AND is_retry = 0${extraSql}
         GROUP BY client_ip, key_id
       ) g LEFT JOIN users u ON u.id = g.user_id`,
    )
    .all(since, now, ...extraArgs) as {
    ip: string | null; key_id: number | null; key_name: string | null; user_id: number | null; user_name: string | null
    count: number; success: number; tokens: number; points: number
  }[]
  type IpKey = { key_id: number | null; key_name: string | null; user_id: number | null; user_name: string | null; count: number }
  const ipMap = new Map<string | null, { ip: string | null; count: number; success: number; tokens: number; points: number; keys: IpKey[] }>()
  for (const r of ipKeyRows) {
    const item = ipMap.get(r.ip) ?? { ip: r.ip, count: 0, success: 0, tokens: 0, points: 0, keys: [] }
    item.count += r.count
    item.success += r.success
    item.tokens += r.tokens
    item.points += r.points
    item.keys.push({ key_id: r.key_id, key_name: r.key_name, user_id: r.user_id, user_name: r.user_name, count: r.count })
    ipMap.set(r.ip, item)
  }
  const byIp = [...ipMap.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 50)
    .map(({ keys, ...item }) => ({ ...item, key_count: keys.length, keys: keys.sort((a, b) => b.count - a.count).slice(0, 5) }))

  const byUa = db
    .prepare(
      `SELECT user_agent AS ua, COUNT(*) AS count,
              SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success,
              COALESCE(SUM(total_tokens), 0) AS tokens,
              COALESCE(SUM(quota_points), 0) AS points
       FROM request_logs WHERE created_at >= ? AND created_at <= ? AND is_retry = 0${extraSql}
       GROUP BY user_agent ORDER BY count DESC LIMIT 50`,
    )
    .all(since, now, ...extraArgs) as { ua: string | null; count: number; success: number; tokens: number; points: number }[]

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
      total_points: overview.points || 0,
      avg_latency: Math.round(overview.avg_latency || 0),
    },
    throughput: {
      current_rpm: current.requests || 0,
      current_tpm: current.tokens || 0,
      peak_rpm: peakRpm.value,
      peak_rpm_at: peakRpm.at,
      peak_tpm: peakTpm.value,
      peak_tpm_at: peakTpm.at,
    },
    trend,
    by_channel: byChannel,
    by_model: byModel,
    by_key: byKey,
    by_ip: byIp,
    by_ua: byUa,
  })
})
