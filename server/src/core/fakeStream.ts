import type { EntryFormat } from '../types'

/** 假流式等待上游期间向客户端发送 SSE 空帧的间隔 */
export const FAKE_STREAM_PING_MS = 20_000

// 假流式：上游按非流式请求，拿到入口格式的完整响应后，一次性合成该入口协议的标准 SSE 事件序列。
// 每个内容块只发一个完整增量，事件骨架与真实流式保持一致，客户端按常规流式逻辑累积即可还原完整响应。

const data = (payload: any): string => `data: ${JSON.stringify(payload)}\n\n`
const event = (name: string, payload: any): string => `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`

/** OpenAI Chat：chat.completion → chat.completion.chunk 序列 + [DONE] */
function openaiEvents(json: any): string {
  const base = { id: json.id, object: 'chat.completion.chunk', created: json.created, model: json.model }
  if (json.system_fingerprint !== undefined) Object.assign(base, { system_fingerprint: json.system_fingerprint })
  let out = ''
  const choices: any[] = Array.isArray(json.choices) ? json.choices : []
  choices.forEach((choice, i) => {
    const index = choice?.index ?? i
    const { role, tool_calls, ...rest } = choice?.message || {}
    const delta: any = { role: role || 'assistant', ...rest }
    if (Array.isArray(tool_calls) && tool_calls.length) delta.tool_calls = tool_calls.map((call: any, n: number) => ({ index: n, ...call }))
    out += data({ ...base, choices: [{ index, delta, logprobs: choice?.logprobs ?? null, finish_reason: null }] })
    out += data({ ...base, choices: [{ index, delta: {}, logprobs: null, finish_reason: choice?.finish_reason ?? 'stop' }] })
  })
  if (json.usage) out += data({ ...base, choices: [], usage: json.usage })
  return out + 'data: [DONE]\n\n'
}

/** Anthropic Messages：message → message_start / content_block_* / message_delta / message_stop */
function anthropicEvents(json: any): string {
  const usage = json.usage && typeof json.usage === 'object' ? json.usage : { input_tokens: 0, output_tokens: 0 }
  let out = event('message_start', {
    type: 'message_start',
    message: { ...json, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } },
  })
  const blocks: any[] = Array.isArray(json.content) ? json.content : []
  blocks.forEach((block, index) => {
    const delta = (d: any) => { out += event('content_block_delta', { type: 'content_block_delta', index, delta: d }) }
    const start = (content_block: any) => { out += event('content_block_start', { type: 'content_block_start', index, content_block }) }
    if (block?.type === 'text') {
      start({ ...block, text: '' })
      if (block.text) delta({ type: 'text_delta', text: block.text })
    } else if (block?.type === 'thinking') {
      start({ type: 'thinking', thinking: '', signature: '' })
      if (block.thinking) delta({ type: 'thinking_delta', thinking: block.thinking })
      if (block.signature) delta({ type: 'signature_delta', signature: block.signature })
    } else if (block?.type === 'tool_use' || block?.type === 'server_tool_use') {
      start({ ...block, input: {} })
      const input = block.input && typeof block.input === 'object' ? block.input : {}
      if (Object.keys(input).length) delta({ type: 'input_json_delta', partial_json: JSON.stringify(input) })
    } else {
      // redacted_thinking、各类工具结果等：真实流式里同样是 start 携带完整块
      start(block)
    }
    out += event('content_block_stop', { type: 'content_block_stop', index })
  })
  out += event('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: json.stop_reason ?? 'end_turn', stop_sequence: json.stop_sequence ?? null },
    usage,
  })
  return out + event('message_stop', { type: 'message_stop' })
}

/** OpenAI Responses：response → response.created … output_item.* … response.completed */
function responsesEvents(json: any): string {
  let seq = 0
  let out = ''
  const ev = (type: string, payload: any) => { out += event(type, { type, sequence_number: seq++, ...payload }) }
  const shell = { ...json, status: 'in_progress', output: [], usage: null, incomplete_details: null, error: null }
  ev('response.created', { response: shell })
  ev('response.in_progress', { response: shell })
  const items: any[] = Array.isArray(json.output) ? json.output : []
  items.forEach((item, output_index) => {
    const item_id = item?.id
    const pending = (patch: any) => ({ ...item, ...patch, ...('status' in (item || {}) ? { status: 'in_progress' } : {}) })
    if (item?.type === 'message') {
      ev('response.output_item.added', { output_index, item: pending({ content: [] }) })
      const parts: any[] = Array.isArray(item.content) ? item.content : []
      parts.forEach((part, content_index) => {
        const at = { item_id, output_index, content_index }
        if (part?.type === 'output_text') {
          ev('response.content_part.added', { ...at, part: { ...part, text: '', annotations: [] } })
          if (part.text) ev('response.output_text.delta', { ...at, delta: part.text, logprobs: [] })
          ;(Array.isArray(part.annotations) ? part.annotations : []).forEach((annotation: any, annotation_index: number) => {
            ev('response.output_text.annotation.added', { ...at, annotation_index, annotation })
          })
          ev('response.output_text.done', { ...at, text: part.text ?? '', logprobs: [] })
        } else if (part?.type === 'refusal') {
          ev('response.content_part.added', { ...at, part: { type: 'refusal', refusal: '' } })
          if (part.refusal) ev('response.refusal.delta', { ...at, delta: part.refusal })
          ev('response.refusal.done', { ...at, refusal: part.refusal ?? '' })
        } else {
          ev('response.content_part.added', { ...at, part })
        }
        ev('response.content_part.done', { ...at, part })
      })
    } else if (item?.type === 'reasoning') {
      ev('response.output_item.added', { output_index, item: pending({ summary: [] }) })
      const summary: any[] = Array.isArray(item.summary) ? item.summary : []
      summary.forEach((part, summary_index) => {
        const at = { item_id, output_index, summary_index }
        ev('response.reasoning_summary_part.added', { ...at, part: { type: 'summary_text', text: '' } })
        if (part?.text) ev('response.reasoning_summary_text.delta', { ...at, delta: part.text })
        ev('response.reasoning_summary_text.done', { ...at, text: part?.text ?? '' })
        ev('response.reasoning_summary_part.done', { ...at, part })
      })
    } else if (item?.type === 'function_call') {
      ev('response.output_item.added', { output_index, item: pending({ arguments: '' }) })
      if (item.arguments) ev('response.function_call_arguments.delta', { item_id, output_index, delta: item.arguments })
      ev('response.function_call_arguments.done', { item_id, output_index, arguments: item.arguments ?? '' })
    } else if (item?.type === 'custom_tool_call') {
      ev('response.output_item.added', { output_index, item: pending({ input: '' }) })
      if (item.input) ev('response.custom_tool_call_input.delta', { item_id, output_index, delta: item.input })
      ev('response.custom_tool_call_input.done', { item_id, output_index, input: item.input ?? '' })
    } else {
      ev('response.output_item.added', { output_index, item: pending({}) })
    }
    ev('response.output_item.done', { output_index, item })
  })
  const final = json.status === 'incomplete' ? 'response.incomplete' : json.status === 'failed' ? 'response.failed' : 'response.completed'
  ev(final, { response: json })
  return out
}

/** 把入口格式的完整非流式响应合成为同一入口协议的 SSE 文本 */
export function fakeStreamEvents(format: EntryFormat, json: any): string {
  if (format === 'anthropic') return anthropicEvents(json)
  if (format === 'responses') return responsesEvents(json)
  return openaiEvents(json)
}
