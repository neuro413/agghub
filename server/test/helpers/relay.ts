import './isolated'
import { EventEmitter } from 'node:events'
import { db, setSettings } from '../../src/db'
import { DEFAULT_SETTINGS } from '../../src/config'
import { handleRelay } from '../../src/core/relay'
import { hydrateLogRow } from '../../src/stats/recorder'
import * as anthropic from '../../src/convert/anthropic'
import * as responses from '../../src/convert/responses'
import type { ChannelType, EntryFormat } from '../../src/types'

export class FakeResponse extends EventEmitter {
  headersSent = false
  writableEnded = false
  destroyed = false
  statusCode = 200
  headers: Record<string, string> = {}
  chunks: string[] = []
  jsonBody: any
  writeResult = true
  setHeader(key: string, value: string) { this.headers[key] = value; return this }
  status(code: number) { this.statusCode = code; return this }
  flushHeaders() { this.headersSent = true }
  write(text: string) { if (this.destroyed) throw new Error('写入已关闭响应'); this.headersSent = true; this.chunks.push(text); return this.writeResult }
  json(value: any) { this.jsonBody = value; this.headersSent = true; this.end(); return this }
  type(_value: string) { return this }
  send(text: string) { return this.json(JSON.parse(text)) }
  end() { this.writableEnded = true; this.emit('close'); return this }
  disconnect() { this.destroyed = true; this.emit('close') }
}

export function reset() {
  db.exec('DELETE FROM request_logs; DELETE FROM channels')
  setSettings({ ...DEFAULT_SETTINGS, request_timeout_ms: 1000, single_retry_times: 0, channel_retry_times: 2, request_max_duration_ms: 10_000 })
}

export function channel(type: ChannelType, priority = 0, mapping: Record<string, string> = {}, key = 'synthetic-key'): number {
  return Number(db.prepare(`INSERT INTO channels(name,type,base_url,api_key,models,model_mapping,priority,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(`synthetic-${type}-${priority}`, type, 'http://synthetic.invalid', key, JSON.stringify(['alias']), JSON.stringify(mapping), priority, 0, 0).lastInsertRowid)
}

export function relay(format: EntryFormat, stream: boolean, res = new FakeResponse(), extra: Record<string, any> = {}) {
  const raw = { model: 'alias', stream, ...(format === 'responses' ? { input: 'hi' } : { messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }), ...extra }
  const ir = format === 'anthropic' ? anthropic.parseRequest(raw).ir : format === 'responses' ? responses.parseRequest(raw).ir : raw
  return { raw, res, run: () => handleRelay({ entryFormat: format, stream, ir, rawBody: raw, rawHeaders: { 'x-synthetic': 'yes' }, res: res as any }) }
}

export function logs() { return (db.prepare('SELECT * FROM request_logs ORDER BY id').all() as any[]).map(hydrateLogRow) }
export const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
export const oaiBody = { id: 'synthetic', model: 'actual', choices: [{ index: 0, message: { role: 'assistant', content: '你好🙂' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }
export const anthBody = { id: 'synthetic', type: 'message', role: 'assistant', model: 'actual', content: [{ type: 'text', text: '你好🙂' }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 3 } }
export const gemBody = { candidates: [{ content: { parts: [{ text: '你好🙂' }], role: 'model' }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } }
export const respBody = { id: 'resp_synthetic', object: 'response', model: 'actual', status: 'completed', output: [{ id: 'msg_synthetic', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好🙂' }] }], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } }

export function sse(events: any[], close = true, cancel?: () => void) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(new TextEncoder().encode(typeof event === 'string' ? event : `data: ${JSON.stringify(event)}\n\n`))
      if (close) controller.close()
    }, cancel,
  }), { headers: { 'content-type': 'text/event-stream' } })
}
export function oaiEvents(complete = true) {
  return [
    { choices: [{ index: 0, delta: { content: '你好🙂' }, finish_reason: null }] },
    ...(complete ? [{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: oaiBody.usage }, 'data: [DONE]\n\n'] : []),
  ]
}
export function anthEvents(complete = true) {
  return [
    { type: 'message_start', message: { id: 'synthetic', model: 'actual', usage: { input_tokens: 2, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好🙂' } },
    ...(complete ? [{ type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }, { type: 'message_stop' }] : []),
  ]
}
