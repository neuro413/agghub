import type { WireFormat } from '../types'
import { extractUpstreamMessage, UpstreamError } from './failover'
import { streamEventError, streamEventHasContent } from '../convert/responses'

export interface SSEEvent { event: string | null; data: string }

export function meaningfulDelta(delta: any): boolean {
  if (!delta) return false
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) return true
  return ['content', 'reasoning_content', 'reasoning_signature', 'reasoning_redacted', 'refusal'].some(key => typeof delta[key] === 'string' && delta[key].length > 0)
}

/** 直通和跨格式复用同一终态观察器，失败状态只允许单向变化。 */
export class StreamState {
  content = false
  failed: string | null = null
  private explicitEnd = false
  /** OpenAI / Gemini 以 finish_reason 为终态（部分兼容上游不发 [DONE]） */
  private finished = false
  constructor(readonly wire: WireFormat) {}
  get terminal(): boolean {
    return this.failed !== null || this.explicitEnd || this.finished
  }
  get closed(): boolean { return this.explicitEnd || this.failed !== null }

  observe(event: SSEEvent): any {
    if (this.failed) return null
    if (event.event === 'error') {
      this.failed = extractUpstreamMessage(event.data)
      return null
    }
    if (this.wire === 'openai' && event.data.trim() === '[DONE]') { this.explicitEnd = true; return null }
    if (!event.data.trim()) return null
    let data: any
    try { data = JSON.parse(event.data) } catch { throw new UpstreamError(502, '上游 SSE 事件不是有效 JSON') }
    if (data?.error) {
      this.failed = extractUpstreamMessage(event.data)
      return data
    }
    if (this.wire === 'openai') {
      for (const choice of data?.choices || []) {
        this.finished ||= !!choice.finish_reason
        this.content ||= meaningfulDelta(choice.delta)
      }
    } else if (this.wire === 'anthropic') {
      const type = data?.type || event.event
      if (type === 'error') this.failed = extractUpstreamMessage(event.data)
      if (type === 'message_stop') this.explicitEnd = true
      if (type === 'content_block_start') {
        const block = data.content_block
        this.content ||= ['tool_use', 'redacted_thinking'].includes(block?.type) || !!block?.text || !!block?.thinking || !!block?.signature
      }
      if (type === 'content_block_delta') this.content ||= !!(data.delta?.text || data.delta?.thinking || data.delta?.partial_json || data.delta?.signature)
      if (type === 'message_delta' && data.delta?.stop_reason === 'refusal') this.content = true
    } else if (this.wire === 'responses') {
      if (!data.type && event.event) data = { ...data, type: event.event }
      this.failed = streamEventError(data)
      if (['response.completed', 'response.incomplete', 'response.done'].includes(data.type)) {
        this.explicitEnd = true
        if (data.response?.status === 'failed') this.failed = data.response.error?.message || 'response.failed'
      }
      this.content ||= streamEventHasContent(data)
    } else {
      for (const candidate of data?.candidates || []) {
        this.finished ||= !!candidate.finishReason
        this.content ||= !!candidate.content?.parts?.some((part: any) => part.text || part.functionCall || part.inlineData)
      }
    }
    return data
  }
  assertComplete(): void {
    if (this.failed) throw new UpstreamError(502, this.failed)
    if (!this.terminal) throw new UpstreamError(502, '上游响应提前结束，未收到合法终态（流已截断）')
    if (!this.content) throw new UpstreamError(502, '上游返回空回复')
  }
}
