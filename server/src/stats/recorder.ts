import { db, getSettings } from '../db'
import type { Settings } from '../types'
import { clearBlobs, gcBlobs, getBlob, getJsonBody, packBlobs, putBlob, putJsonBody, sanitizeHeaders } from './blobstore'

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
}

const insertStmt = db.prepare(
  `INSERT INTO request_logs
   (created_at, channel_id, channel_name, entry_format, model, upstream_model, status, status_code,
    latency_ms, prompt_tokens, completion_tokens, total_tokens, cache_read_tokens, cache_write_tokens,
    retry_count, is_stream, is_retry, error_message, preprocessed, pseudo_thinking,
    request_headers_ref, request_body_ref, response_body_ref, preprocessed_body_ref, thinking_inject_ref,
    upstream_response_body_ref, request_id, attempt_latency_ms, response_body_truncated, upstream_response_body_truncated)
   VALUES
   (@created_at, @channel_id, @channel_name, @entry_format, @model, @upstream_model, @status, @status_code,
    @latency_ms, @prompt_tokens, @completion_tokens, @total_tokens, @cache_read_tokens, @cache_write_tokens,
    @retry_count, @is_stream, @is_retry, @error_message, @preprocessed, @pseudo_thinking,
    @request_headers_ref, @request_body_ref, @response_body_ref, @preprocessed_body_ref, @thinking_inject_ref,
    @upstream_response_body_ref, @request_id, @attempt_latency_ms, @response_body_truncated, @upstream_response_body_truncated)`,
)

const opt = (s: string | null | undefined, put: (t: string) => number): number | null => (s == null ? null : put(s))
type StorageSettings = Pick<Settings, 'store_request_body' | 'store_response_body'>

/** 写一条日志；大正文写入块存储（去重 + 压缩），整个过程在一个事务内。 */
export const recordLog = db.transaction((e: LogEntry, snapshot?: StorageSettings): void => {
  const s = snapshot ?? getSettings()
  const storeReq = s.store_request_body
  const storeRes = s.store_response_body
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
    error_message: e.error_message ?? null,
    preprocessed: e.preprocessed ? 1 : 0,
    pseudo_thinking: e.pseudo_thinking ? 1 : 0,
    request_headers_ref: storeReq ? opt(sanitizeHeaders(e.request_headers), putBlob) : null,
    request_body_ref: storeReq ? opt(e.request_body, putJsonBody) : null,
    preprocessed_body_ref: storeReq ? opt(e.preprocessed_body, putJsonBody) : null,
    thinking_inject_ref: storeReq ? opt(e.thinking_inject, putBlob) : null,
    response_body_ref: storeRes ? opt(e.response_body, putJsonBody) : null,
    upstream_response_body_ref: storeRes ? opt(e.upstream_response_body, putBlob) : null,
  })
})

let lastLogWarning = -Infinity

/** 包含日志构造/序列化的完整故障边界，绝不因此再次请求上游。 */
export function safeRecordLog(build: () => LogEntry, snapshot?: StorageSettings, requestId?: string): boolean {
  try {
    recordLog(build(), snapshot)
    return true
  } catch (error) {
    if (Date.now() - lastLogWarning > 60_000) {
      lastLogWarning = Date.now()
      console.error('[agghub] 请求日志未能持久化', { request_id: requestId, category: error instanceof Error ? error.name : 'unknown' })
    }
    return false
  }
}

/** 日志行 → 对外 API 形状（把 *_ref 解开成原来的正文字段，接口对前端保持不变）*/
export function hydrateLogRow(row: any): any {
  const {
    request_headers_ref,
    request_body_ref,
    response_body_ref,
    preprocessed_body_ref,
    thinking_inject_ref,
    upstream_response_body_ref,
    ...rest
  } = row
  return {
    ...rest,
    request_headers: getBlob(request_headers_ref),
    request_body: getJsonBody(request_body_ref),
    response_body: getJsonBody(response_body_ref),
    preprocessed_body: getJsonBody(preprocessed_body_ref),
    thinking_inject: getBlob(thinking_inject_ref),
    upstream_response_body: getBlob(upstream_response_body_ref),
  }
}

/** 清理超过保留期的日志，随后回收无引用的块、把冷块打包并归还空闲页 */
export function cleanupOldLogs(): void {
  const s = getSettings()
  const cutoff = Date.now() - s.log_retention_days * 86_400_000
  const r = db.prepare('DELETE FROM request_logs WHERE created_at < ?').run(cutoff)
  const freed = gcBlobs()
  const packed = packBlobs()
  if (r.changes || freed || packed) {
    db.pragma('incremental_vacuum')
    db.pragma('wal_checkpoint(TRUNCATE)')
  }
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
