import type { EntryFormat, IRUsage } from '../types'
import { contentToText } from '../convert/ir'
import * as responses from '../convert/responses'
import { mergeUsage, usageFromClaude, usageFromOpenAI, usageFromResponses, usageToClaude } from '../convert/usage'

export function passthroughUsage(format: EntryFormat, json: any): IRUsage {
  if (format === 'responses') return usageFromResponses(json?.usage)
  if (format === 'anthropic') return usageFromClaude(json?.usage)
  return usageFromOpenAI(json?.usage)
}

export function accumulateUsage(format: EntryFormat, data: any, acc: IRUsage): IRUsage {
  if (format === 'responses') return data?.response?.usage ? usageFromResponses(data.response.usage) : acc
  if (format === 'anthropic') {
    if (data?.type === 'message_start' && data.message?.usage) return usageFromClaude(data.message.usage)
    if (data?.type === 'message_delta' && data.usage) return usageFromClaude({ ...usageToClaude(acc), ...data.usage })
    return acc
  }
  return data?.usage ? mergeUsage(acc, usageFromOpenAI(data.usage)) : acc
}

export function streamDeltaText(format: EntryFormat, data: any): string {
  if (format === 'responses') return responses.streamEventText(data)
  if (format === 'anthropic') return data?.type === 'content_block_delta' && data.delta?.type === 'text_delta' ? data.delta.text || '' : ''
  return (data?.choices || []).map((choice: any) => choice.delta?.content || choice.delta?.refusal || '').join('')
}

export function isEmptyIRResponse(ir: any): boolean {
  return !(ir?.choices || []).some((choice: any) => {
    const message = choice.message
    return message && (contentToText(message.content).trim() || message.tool_calls?.length || message.reasoning_content?.trim() || message.refusal?.trim() || message.reasoning_items?.length)
  })
}

export function isEmptyPassthroughBody(format: EntryFormat, json: any): boolean {
  if (!json || typeof json !== 'object') return true
  if (format === 'responses') return responses.isEmptyResponseBody(json)
  if (format === 'anthropic') {
    for (const block of Array.isArray(json.content) ? json.content : []) {
      if (block?.type === 'text' && (block.text || '').trim()) return false
      if (['tool_use', 'redacted_thinking'].includes(block?.type)) return false
      if (block?.type === 'thinking' && ((block.thinking || '').trim() || block.signature)) return false
    }
    return json.stop_reason !== 'refusal'
  }
  return isEmptyIRResponse(json)
}
