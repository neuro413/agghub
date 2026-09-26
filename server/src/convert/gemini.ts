import { contentToText, genId, nowSec, parseDataUrl, parseToolArgs, splitContent } from './ir'
import type { StreamDecoder } from './ir'
import { CandidateError } from '../core/failover'
import { emptyUsage, usageFromGemini } from './usage'

// Gemini 仅作上游渠道（vertex API key 模式走 Gemini generateContent 协议）。
// 入口只有 openai/anthropic，故此模块不实现入口方向。

const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
]

function finishMap(fr: string | null | undefined): string | null {
  switch (fr) {
    case 'STOP':
      return 'stop'
    case 'MAX_TOKENS':
      return 'length'
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'OTHER':
      return 'content_filter'
    default:
      return fr ? 'stop' : null
  }
}

/** 单个 Gemini part → IR delta：思考分流到 reasoning_content，内联媒体转 markdown 图片 */
function partToDelta(p: any): any | null {
  if (p.thought === true) return p.text ? { reasoning_content: p.text } : null
  if (p.inlineData) {
    const mime = p.inlineData.mimeType || ''
    return { content: `![${mime.startsWith('image') ? 'image' : 'media'}](data:${mime};base64,${p.inlineData.data})` }
  }
  if (p.text) return { content: p.text }
  if (p.functionCall) {
    return { tool_calls: [{ id: genId('call'), type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) } }] }
  }
  return null
}

// Gemini 的 functionDeclarations 仅接受 OpenAPI 3.0 Schema 子集，
// 透传 OpenAI/JSON-Schema 的这些关键字会被 Gemini 以 400 拒绝。
const SCHEMA_UNSUPPORTED_KEYS = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'definitions',
  'additionalProperties',
  'patternProperties',
  'title',
  'default',
  'examples',
  'const',
  'if',
  'then',
  'else',
])

/** 递归清理 JSON Schema，移除 Gemini 不支持的关键字 */
function cleanSchema(schema: any): any {
  if (Array.isArray(schema)) return schema.map(cleanSchema)
  if (!schema || typeof schema !== 'object') return schema
  const out: any = {}
  for (const [k, v] of Object.entries(schema)) {
    if (SCHEMA_UNSUPPORTED_KEYS.has(k)) continue
    out[k] = cleanSchema(v)
  }
  return out
}

/** OpenAI tool_choice → Gemini toolConfig.functionCallingConfig */
function toolChoiceToConfig(tc: any): any | null {
  if (tc == null) return null
  if (tc === 'auto') return { functionCallingConfig: { mode: 'AUTO' } }
  if (tc === 'required') return { functionCallingConfig: { mode: 'ANY' } }
  if (tc === 'none') return { functionCallingConfig: { mode: 'NONE' } }
  if (typeof tc === 'object' && tc.function?.name) {
    return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [tc.function.name] } }
  }
  return null
}

// ═══════════ 上游方向：IR(OpenAI) → Gemini 请求体（model 在 URL，不含于 body）═══════════
export function buildRequest(ir: any, _upstreamModel: string): any {
  const contents: any[] = []
  const systemParts: any[] = []
  // 记录 toolCallId → 函数名，供后续 tool 消息回填 functionResponse.name
  const toolCallNames = new Map<string, string>()

  // 把 parts 追加进相邻 user content（合并并行 functionResponse / 连续 user），
  // 否则新建一条 user content，避免 Gemini 收到连续 user role。
  const appendUser = (parts: any[]): void => {
    if (!parts.length) return
    const last = contents[contents.length - 1]
    if (last && last.role === 'user') last.parts.push(...parts)
    else contents.push({ role: 'user', parts })
  }

  // 只有开头连续的 system 消息进入 systemInstruction；对话中途的 system 消息折成 user 文本原位保留
  let leading = true
  for (const msg of ir.messages || []) {
    if (msg.role === 'system') {
      const s = contentToText(msg.content)
      if (!s) continue
      if (leading) systemParts.push({ text: s })
      else appendUser([{ text: s }])
      continue
    }
    leading = false
    if (msg.role === 'tool') {
      const name = msg.name || toolCallNames.get(msg.tool_call_id) || msg.tool_call_id
      let response: any
      try {
        const parsed = JSON.parse(msg.content)
        // Gemini 的 functionResponse.response 必须是对象；数组/标量需包装
        response =
          parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { result: parsed }
      } catch {
        response = { result: contentToText(msg.content) }
      }
      appendUser([{ functionResponse: { name, response } }])
      continue
    }
    if (msg.role === 'assistant') {
      const parts: any[] = []
      const txt = contentToText(msg.content)
      if (txt) parts.push({ text: txt })
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          parts.push({ functionCall: { name: tc.function?.name, args: parseToolArgs(tc.function?.arguments) } })
          if (tc.id && tc.function?.name) toolCallNames.set(tc.id, tc.function.name)
        }
      }
      // 空 assistant 跳过（Gemini 不接受空 parts）
      if (parts.length) contents.push({ role: 'model', parts })
      continue
    }
    // user
    const { text, images } = splitContent(msg.content)
    const parts: any[] = []
    if (text) parts.push({ text })
    for (const img of images) {
      const d = parseDataUrl(img)
      if (!d) throw new CandidateError('Gemini 图片尚未解析为有效 data URL，已停止发送缺图请求')
      parts.push({ inlineData: { mimeType: d.media_type, data: d.data } })
    }
    appendUser(parts)
  }

  const out: any = { contents }
  if (systemParts.length) out.systemInstruction = { parts: systemParts }

  const gc: any = {}
  if (ir.temperature != null) gc.temperature = ir.temperature
  if (ir.top_p != null) gc.topP = ir.top_p
  if (ir.top_k != null) gc.topK = ir.top_k
  const maxT = ir.max_tokens ?? ir.max_completion_tokens
  if (maxT != null) gc.maxOutputTokens = maxT
  if (ir.stop != null) {
    const seq = Array.isArray(ir.stop) ? ir.stop : [ir.stop]
    // Gemini 最多支持 5 个 stop sequence
    gc.stopSequences = seq.slice(0, 5)
  }
  if (Object.keys(gc).length) out.generationConfig = gc

  if (Array.isArray(ir.tools) && ir.tools.length) {
    const functionDeclarations = ir.tools
      .filter((t: any) => t.function?.name)
      .map((t: any) => {
        const decl: any = { name: t.function.name, description: t.function.description }
        const params = t.function.parameters
        if (params && typeof params === 'object') {
          const cleaned = cleanSchema(params)
          const props = cleaned.properties
          // 仅在确有参数时附带 parameters，空 properties 会被 Gemini 拒绝
          if (props && typeof props === 'object' && Object.keys(props).length > 0) {
            decl.parameters = cleaned
          }
        }
        return decl
      })
    if (functionDeclarations.length) out.tools = [{ functionDeclarations }]
  }

  const toolConfig = toolChoiceToConfig(ir.tool_choice)
  if (toolConfig) out.toolConfig = toolConfig

  out.safetySettings = SAFETY_SETTINGS

  return out
}

type GeminiMessage = { content: string | null; reasoning_content?: string; tool_calls?: any[] }

/** 把一组 Gemini parts 归并成 IR(OpenAI) message 字段 */
function partsToMessage(parts: any[]): GeminiMessage {
  let text = ''
  let reasoning = ''
  const toolCalls: any[] = []
  for (const p of parts) {
    const d = partToDelta(p)
    if (d?.reasoning_content) reasoning += d.reasoning_content
    else if (d?.content) text += d.content
    else if (d?.tool_calls) toolCalls.push(d.tool_calls[0])
  }
  const msg: GeminiMessage = { content: text || null }
  if (reasoning) msg.reasoning_content = reasoning
  if (toolCalls.length) msg.tool_calls = toolCalls
  return msg
}

// ═══════════ 上游方向：Gemini 响应 → IR(OpenAI) ═══════════
export function parseResponse(resp: any, model: string): any {
  const cand = resp.candidates?.[0] || {}
  const m = partsToMessage(cand.content?.parts || [])
  return {
    id: genId(),
    object: 'chat.completion',
    created: nowSec(),
    model,
    choices: [{ index: 0, message: { role: 'assistant', ...m }, finish_reason: finishMap(cand.finishReason) || 'stop' }],
    usage: usageFromGemini(resp.usageMetadata),
  }
}

// ═══════════ 上游方向：Gemini SSE chunk → IR(OpenAI) chunks ═══════════
export function createStreamDecoder(model: string): StreamDecoder {
  const id = genId()
  const created = nowSec()
  let started = false
  let toolIndex = 0
  // 流式各 chunk 的 usageMetadata 为累计值，以最后一次为准
  let usage: any = null

  const mk = (delta: any, finish: string | null = null): any => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })

  return {
    push(evt) {
      let data: any
      try {
        data = JSON.parse(evt.data)
      } catch {
        return []
      }
      const out: any[] = []
      const cand = data.candidates?.[0]
      if (data.usageMetadata) usage = usageFromGemini(data.usageMetadata)
      if (!started) {
        started = true
        out.push(mk({ role: 'assistant', content: '' }))
      }
      for (const p of cand?.content?.parts || []) {
        const delta = partToDelta(p)
        if (!delta) continue
        if (delta.tool_calls) delta.tool_calls[0].index = toolIndex++
        out.push(mk(delta))
      }
      if (cand?.finishReason) {
        const chunk = mk({}, finishMap(cand.finishReason) || 'stop')
        chunk.usage = usage || emptyUsage()
        out.push(chunk)
      }
      return out
    },
    flush() {
      return usage ? [{ id, object: 'chat.completion.chunk', created, model, choices: [], usage }] : []
    },
  }
}
