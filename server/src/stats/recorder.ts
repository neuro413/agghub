import { db, getSettings } from '../db'
import { setImmediate as yieldTurn } from 'node:timers/promises'
import type { CallerSource, LogBodyField, Settings } from '../types'
import { blobEpoch, clearBlobs, createBlobReader, gcBlobs, packBlobs, putBlobAsync, putJsonBodyAsync, releaseBlobs, sanitizeHeaders, type BlobPins } from './blobstore'

export interface LogEntry {
  channel_id: number | null
  channel_name: string | null
  entry_format: string
  model: string | null
  upstream_model: string | null
  status: 'success' | 'error'
  status_code: number | null
  latency_ms: number | null
  request_id?: string | null
  attempt_latency_ms?: number | null
  response_body_truncated?: boolean
  upstream_response_body_truncated?: boolean
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  /** 缓存读取 / 写入 token（prompt_tokens 的子集）*/
  cache_read_tokens?: number
  cache_write_tokens?: number
  retry_count?: number
  is_stream?: boolean
  /** 1=本次为重试中的中间尝试（不计入请求统计）；0/缺省=最终结果 */
  is_retry?: boolean
  error_message?: string | null
  request_headers?: string | null
  request_body?: string | null
  response_body?: string | null
  /** 上游原始回复：非流式为原始 JSON 文本，流式为原始 SSE 帧，HTTP 错误为原始错误体（未经转换 / 改写）*/
  upstream_response_body?: string | null
  /** 请求体是否被后处理实际改动 */
  preprocessed?: boolean
  preprocessed_body?: string | null
  pseudo_thinking?: boolean
  thinking_inject?: string | null
  source?: CallerSource | null
  key_id?: number | null
  key_name?: string | null
  client_ip?: string | null
  /** 本次请求折算点数；未命中倍率时为 null */
  quota_points?: number | null
  /** 门户用户 id */
  user_id?: number | null
  /** 计费所用分组 */
  group_name?: string | null
  /** 多 key 渠道本次使用的上游 key（序号 + 脱敏值） */
  channel_key?: string | null
  /** 客户端请求头里的 User-Agent（渠道覆盖前的原值） */
  user_agent?: string | null
}

const MAX_USER_AGENT_LENGTH = 512

// UA 列晚于请求头存储加入：加列与从已存请求头回填放在同一事务，中途退出则下次启动整体重做；按 id 分页控制内存
if (!db.prepare("SELECT 1 FROM pragma_table_info('request_logs') WHERE name = 'user_agent'").get()) {
  const filled = db.transaction(() => {
    db.exec('ALTER TABLE request_logs ADD COLUMN user_agent TEXT')
    const page = db.prepare('SELECT id, request_headers_ref AS ref FROM request_logs WHERE id > ? AND request_headers_ref IS NOT NULL ORDER BY id LIMIT 1000')
    const update = db.prepare('UPDATE request_logs SET user_agent = ? WHERE id = ?')
    let count = 0
    for (let after = 0; ;) {
      const rows = page.all(after) as { id: number; ref: number }[]
      if (!rows.length) return count
      const reader = createBlobReader(rows.map(row => row.ref))
      for (const row of rows) {
        let value: unknown
        // 损坏的块跳过，不阻塞启动
        try { value = JSON.parse(reader.getBlob(row.ref) ?? 'null')?.['user-agent'] } catch { continue }
        if (typeof value === 'string' && value) {
          update.run(value.slice(0, MAX_USER_AGENT_LENGTH), row.id)
          count++
        }
      }
      after = rows[rows.length - 1].id
    }
  })()
  if (filled) console.log(`[agghub] 已从存储的请求头回填 ${filled} 条日志的 User-Agent`)
}

const insertStmt = db.prepare(
  `INSERT INTO request_logs
   (created_at, channel_id, channel_name, entry_format, model, upstream_model, status, status_code,
    latency_ms, prompt_tokens, completion_tokens, total_tokens, cache_read_tokens, cache_write_tokens,
    retry_count, is_stream, is_retry, error_message, preprocessed, pseudo_thinking,
    request_headers_ref, request_body_ref, response_body_ref, preprocessed_body_ref, thinking_inject_ref,
    upstream_response_body_ref, request_id, attempt_latency_ms, response_body_truncated, upstream_response_body_truncated,
    source, key_id, key_name, client_ip, quota_points, user_id, group_name, channel_key, user_agent)
   VALUES
   (@created_at, @channel_id, @channel_name, @entry_format, @model, @upstream_model, @status, @status_code,
    @latency_ms, @prompt_tokens, @completion_tokens, @total_tokens, @cache_read_tokens, @cache_write_tokens,
    @retry_count, @is_stream, @is_retry, @error_message, @preprocessed, @pseudo_thinking,
    @request_headers_ref, @request_body_ref, @response_body_ref, @preprocessed_body_ref, @thinking_inject_ref,
    @upstream_response_body_ref, @request_id, @attempt_latency_ms, @response_body_truncated, @upstream_response_body_truncated,
    @source, @key_id, @key_name, @client_ip, @quota_points, @user_id, @group_name, @channel_key, @user_agent)`,
)

type StorageSettings = Pick<Settings, 'store_request_body' | 'store_response_body'>

/**
 * 写一条日志；大正文写入块存储（去重 + 压缩）。
 * 压缩在线程池执行，块先于日志行落库：日志行写入失败只会留下无引用的块，由 GC 回收；
 * 写入期间持有的块在 GC 中视为存活，避免日志行落库前被回收。
 */
export async function recordLog(e: LogEntry, snapshot?: StorageSettings): Promise<void> {
  const s = snapshot ?? getSettings()
  const storeReq = s.store_request_body
  const storeRes = s.store_response_body
  const epoch = blobEpoch()
  const pins: BlobPins = []
  try {
    // 仅在本条日志内复用完全相同的正文，不把块 id 缓存到写入之外。
    const jsonRefs = new Map<string, number>()
    const putJson = async (text: string): Promise<number> => {
      let id = jsonRefs.get(text)
      if (id === undefined) { id = await putJsonBodyAsync(text, pins); jsonRefs.set(text, id) }
      return id
    }
    const putRaw = (text: string): Promise<number> => putBlobAsync(text, pins)
    const opt = async (text: string | null | undefined, put: (t: string) => Promise<number>): Promise<number | null> => (text == null ? null : put(text))
    // 逐个写入，一条日志不同时占用多个压缩线程
    const refs = {
      request_headers_ref: storeReq ? await opt(sanitizeHeaders(e.request_headers), putRaw) : null,
      request_body_ref: storeReq ? await opt(e.request_body, putJson) : null,
      preprocessed_body_ref: storeReq ? await opt(e.preprocessed_body, putJson) : null,
      thinking_inject_ref: storeReq ? await opt(e.thinking_inject, putRaw) : null,
      response_body_ref: storeRes ? await opt(e.response_body, putJson) : null,
      upstream_response_body_ref: storeRes ? await opt(e.upstream_response_body, putRaw) : null,
    }
    // 写入期间日志被清空：已拿到的块 id 失效，只保留日志行本身
    if (epoch !== blobEpoch()) for (const key of Object.keys(refs) as (keyof typeof refs)[]) refs[key] = null
    insertStmt.run({
      created_at: Date.now(),
      channel_id: e.channel_id ?? null,
      channel_name: e.channel_name ?? null,
      entry_format: e.entry_format,
      model: e.model ?? null,
      upstream_model: e.upstream_model ?? null,
      status: e.status,
      status_code: e.status_code ?? null,
      latency_ms: e.latency_ms ?? null,
      request_id: e.request_id ?? null,
      attempt_latency_ms: e.attempt_latency_ms ?? null,
      response_body_truncated: e.response_body_truncated ? 1 : 0,
      upstream_response_body_truncated: e.upstream_response_body_truncated ? 1 : 0,
      prompt_tokens: e.prompt_tokens ?? 0,
      completion_tokens: e.completion_tokens ?? 0,
      total_tokens: e.total_tokens ?? 0,
      cache_read_tokens: e.cache_read_tokens ?? 0,
      cache_write_tokens: e.cache_write_tokens ?? 0,
      retry_count: e.retry_count ?? 0,
      is_stream: e.is_stream ? 1 : 0,
      is_retry: e.is_retry ? 1 : 0,
      // 管理端与门户都读这一列，同时给公网脱敏留出稳定的输入上界
      error_message: e.error_message ? e.error_message.slice(0, 2000) : null,
      preprocessed: e.preprocessed ? 1 : 0,
      pseudo_thinking: e.pseudo_thinking ? 1 : 0,
      source: e.source ?? null,
      key_id: e.key_id ?? null,
      key_name: e.key_name ?? null,
      client_ip: e.client_ip || null,
      quota_points: e.quota_points ?? null,
      user_id: e.user_id ?? null,
      group_name: e.group_name ?? null,
      channel_key: e.channel_key ?? null,
      user_agent: e.user_agent ? e.user_agent.slice(0, MAX_USER_AGENT_LENGTH) : null,
      ...refs,
    })
  } finally {
    releaseBlobs(pins)
  }
}

let lastLogWarning = -Infinity

/** 包含日志构造/序列化的完整故障边界，绝不因此再次请求上游。 */
export async function safeRecordLog(build: () => LogEntry, snapshot?: StorageSettings, requestId?: string): Promise<boolean> {
  try {
    await recordLog(build(), snapshot)
    return true
  } catch (error) {
    if (Date.now() - lastLogWarning > 60_000) {
      lastLogWarning = Date.now()
      console.error('[agghub] 请求日志未能持久化', { request_id: requestId, category: error instanceof Error ? error.name : 'unknown' })
    }
    return false
  }
}

export const LOG_BODY_FIELDS: LogBodyField[] = ['request_headers', 'request_body', 'response_body', 'preprocessed_body', 'thinking_inject', 'upstream_response_body']
const JSON_BODY_FIELDS = new Set<LogBodyField>(['request_body', 'response_body', 'preprocessed_body'])

/** 不传 fields 时保持完整详情兼容；按需读取时额外返回 available_fields，未加载字段不冒充 null。 */
export function hydrateLogRow(row: any, fields: readonly LogBodyField[] = LOG_BODY_FIELDS): any {
  const result = { ...row }
  const available = LOG_BODY_FIELDS.filter(field => row[`${field}_ref`] != null)
  for (const field of LOG_BODY_FIELDS) {
    delete result[`${field}_ref`]
    delete result[field]
  }
  const reader = createBlobReader(fields.map(field => row[`${field}_ref`]))
  for (const field of fields) result[field] = JSON_BODY_FIELDS.has(field)
    ? reader.getJsonBody(row[`${field}_ref`]) : reader.getBlob(row[`${field}_ref`])
  result.available_fields = available
  return result
}

let cleaning: Promise<void> | undefined
let lastGc = -Infinity

/** 小批删除、定期原子 GC；每轮只压两个包并限制维护时间，积压留给下一轮。 */
async function runCleanup(): Promise<void> {
  const s = getSettings()
  const cutoff = Date.now() - s.log_retention_days * 86_400_000
  const remove = db.prepare('DELETE FROM request_logs WHERE id IN (SELECT id FROM request_logs WHERE created_at < ? ORDER BY created_at LIMIT 500)')
  let removed = 0
  for (let batch = 0; batch < 10; batch++) {
    const n = remove.run(cutoff).changes
    removed += n
    if (n < 500) break
    await yieldTurn()
  }
  let freed = 0
  if (removed || Date.now() - lastGc >= 6 * 3_600_000) {
    freed = gcBlobs()
    lastGc = Date.now()
    await yieldTurn()
  }
  const packed = await packBlobs(Date.now(), { maxPacks: 2, maxMs: 250 })
  if (removed || freed || packed) {
    db.pragma('incremental_vacuum(128)')
    db.pragma('wal_checkpoint(PASSIVE)')
  }
}

export function cleanupOldLogs(): Promise<void> {
  if (!cleaning) cleaning = runCleanup().finally(() => { cleaning = undefined })
  return cleaning
}

/** 清空全部日志与块（管理接口用）*/
export function clearAllLogs(): void {
  db.transaction(() => {
    db.exec('DELETE FROM request_logs')
    clearBlobs()
  })()
  // 清空后整库重建，把文件立刻缩回去
  db.exec('VACUUM')
}
