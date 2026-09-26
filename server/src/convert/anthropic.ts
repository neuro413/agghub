import { contentToText, genId, hashIdentifier, nowSec, parseDataUrl, splitContent } from './ir'
import type { StreamDecoder, StreamEncoder } from './ir'
import { claudeStopToFinish, finishToClaudeStop } from './reasonmap'
import { claudeThinkingMode, effortForClaude, effortToBudget, reasoningFromClaude, reasoningItemsText } from './reasoning'
import { usageFromClaude, usageToClaude } from './usage'
import type { IRReasoningItem } from '../types'
import { serialToolBlocks } from './serialToolBlocks'

const DEFAULT_MAX_TOKENS = 4096
const MIN_THINKING_BUDGET = 1024

function warn(msg: string): void {
  console.warn(`[agghub][anthropic] ${msg}`)
}

function parseImageSource(u: string): any {
  const d = parseDataUrl(u)
  if (d) return { type: 'base64', media_type: d.media_type, data: d.data }
  return { type: 'url', url: u }
}

/** IR file 部件 → Claude document 块；无法构造时返回 null */
function fileToDocument(f: any): any | null {
  if (!f || typeof f !== 'object') return null
  if (f.file_data) {
    const d = parseDataUrl(f.file_data)
    const media_type = d?.media_type || f.media_type || 'application/pdf'
    const data = d?.data || f.file_data
    const doc: any = { type: 'document', source: { type: 'base64', media_type, data } }
    if (f.filename) doc.title = f.filename
    return doc
  }
  if (f.file_url) {
    const doc: any = { type: 'document', source: { type: 'url', url: f.file_url } }
    if (f.filename) doc.title = f.filename
    return doc
  }
  if (f.file_id) {
    const doc: any = { type: 'document', source: { type: 'file', file_id: f.file_id } }
    if (f.filename) doc.title = f.filename
    return doc
  }
  return null
}

/** IR reasoning_items → Claude thinking / redacted_thinking 块（缺签名的块无法回传，跳过）*/
function reasoningItemsToBlocks(items: IRReasoningItem[] | undefined): any[] {
  const blocks: any[] = []
  for (const it of items || []) {
    if (!it) continue
    if (it.redacted) {
      blocks.push({ type: 'redacted_thinking', data: it.redacted })
    } else if (it.signature) {
      blocks.push({ type: 'thinking', thinking: it.text || '', signature: it.signature })
    } else if (it.text) {
      warn('assistant 历史推理块缺少签名，无法回传给 Claude，已丢弃')
    }
  }
  return blocks
}

/** 是否为 Responses 形状的 web_search 工具定义 */
function isResponsesWebSearch(t: any): boolean {
  return typeof t?.type === 'string' && /^web_search(_preview)?(_\d{4}_\d{2}_\d{2})?$/.test(t.type)
}

/** Responses 形状的 web_search → Claude web_search_20250305 */
function hostedToolToClaude(t: any): any | null {
  if (!isResponsesWebSearch(t)) return null
  const out: any = { type: 'web_search_20250305', name: 'web_search' }
  const allowed = t.filters?.allowed_domains
  if (Array.isArray(allowed) && allowed.length) out.allowed_domains = allowed
  const loc = t.user_location
  if (loc && typeof loc === 'object') {
    const l: any = { type: 'approximate' }
    for (const k of ['city', 'region', 'country', 'timezone']) if (loc[k]) l[k] = loc[k]
    out.user_location = l
  }
  return out
}

export interface BuildOptions {
  /** 允许自动调整 max_tokens / 采样参数以满足 thinking 约束（默认 true）*/
  autoAdjust?: boolean
}

// ═══════════ 上游方向：IR(OpenAI) → Claude 请求 ═══════════
export function buildRequest(ir: any, upstreamModel: string, opts?: BuildOptions): any {
  const autoAdjust = opts?.autoAdjust !== false
  const systemParts: string[] = []
  const messages: any[] = []
  const customNames = new Set<string>(Array.isArray(ir.custom_tool_names) ? ir.custom_tool_names : [])

  // 把 blocks 追加进相邻同角色消息（合并），否则新建；content 统一规整为数组。
  // Claude 要求 user/assistant 严格交替，并行 tool_result / 连续 user 必须合并到
  // 同一条消息，否则上游会以 "roles must alternate" 报 400。
  const append = (role: 'user' | 'assistant', blocks: any[]): void => {
    if (!blocks.length) return
    const last = messages[messages.length - 1]
    if (last && last.role === role) {
      if (typeof last.content === 'string') {
        last.content = last.content ? [{ type: 'text', text: last.content }] : []
      }
      last.content.push(...blocks)
    } else {
      messages.push({ role, content: blocks })
    }
  }

  // 只有开头连续的 system 消息进入顶层 system；对话中途的 system 消息（Responses 入口的 developer
  // 项 / Claude Code 的中途系统提醒）折成 user 文本块原位保留，既不破坏缓存前缀，也不依赖 beta 头
  let leading = true
  for (const msg of ir.messages || []) {
    if (!msg) continue
    if (msg.role === 'system' || msg.role === 'developer') {
      const s = contentToText(msg.content)
      if (!s) continue
      if (leading) systemParts.push(s)
      else append('user', [{ type: 'text', text: s }])
      continue
    }
    leading = false
    if (msg.role === 'tool' || msg.role === 'function') {
      if (!msg.tool_call_id) {
        // 无法配对的工具结果：退化为 user 文本，避免发出 tool_use_id 为空的 tool_result
        append('user', [{ type: 'text', text: `[tool_output_missing_call_id] ${contentToText(msg.content)}` }])
        continue
      }
      const block: any = { type: 'tool_result', tool_use_id: msg.tool_call_id }
      if (Array.isArray(msg.content)) {
        const { text, images } = splitContent(msg.content)
        const inner: any[] = []
        if (text) inner.push({ type: 'text', text })
        for (const img of images) inner.push({ type: 'image', source: parseImageSource(img) })
        block.content = inner.length ? inner : ''
      } else {
        block.content = contentToText(msg.content)
      }
      if (msg.is_error === true) block.is_error = true
      append('user', [block])
      continue
    }
    if (msg.role === 'assistant') {
      // 顺序：thinking → text → tool_use。Claude 要求带 tool_use 的 assistant 消息以 thinking 开头
      const blocks: any[] = reasoningItemsToBlocks(msg.reasoning_items)
      const txt = contentToText(msg.content)
      if (txt) blocks.push({ type: 'text', text: txt })
      if (typeof msg.refusal === 'string' && msg.refusal) blocks.push({ type: 'text', text: msg.refusal })
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (!tc) continue
          const id = tc.id || genId('toolu')
          if (tc.type === 'custom') {
            const name = tc.custom?.name || tc.function?.name
            if (!name) continue
            blocks.push({ type: 'tool_use', id, name, input: { input: tc.custom?.input ?? tc.function?.arguments ?? '' } })
            continue
          }
          const name = tc.function?.name
          if (!name) continue
          let input: any = {}
          const raw = tc.function?.arguments
          if (customNames.has(name)) {
            input = { input: typeof raw === 'string' ? raw : JSON.stringify(raw ?? '') }
          } else {
            try {
              input = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw ?? {}
            } catch {
              input = {}
            }
            if (input === null || typeof input !== 'object' || Array.isArray(input)) input = { input }
          }
          blocks.push({ type: 'tool_use', id, name, input })
        }
      }
      // 空 assistant 用占位符兜底，Claude 不接受空文本块
      append('assistant', blocks.length ? blocks : [{ type: 'text', text: '...' }])
      continue
    }
    // user
    const { text, images, files } = splitContent(msg.content)
    const blocks: any[] = []
    if (text) blocks.push({ type: 'text', text })
    for (const img of images) blocks.push({ type: 'image', source: parseImageSource(img) })
    for (const f of files) {
      const doc = fileToDocument(f)
      if (doc) blocks.push(doc)
      else warn('user 消息中的文件部件缺少 file_data / file_url / file_id，已丢弃')
    }
    append('user', blocks.length ? blocks : [{ type: 'text', text: '...' }])
  }

  // Claude 要求首条消息必须是 user
  if (messages.length && messages[0].role !== 'user') {
    messages.unshift({ role: 'user', content: '...' })
  }

  // json_object 没有原生对应，退化为系统指令
  const rf = ir.response_format
  if (rf?.type === 'json_object') {
    systemParts.push('Respond with a single valid JSON object only, without markdown fences or any extra text.')
  }

  const out: any = {
    model: upstreamModel,
    max_tokens: ir.max_tokens || ir.max_completion_tokens || DEFAULT_MAX_TOKENS,
    messages,
  }
  if (systemParts.length) out.system = systemParts.join('\n\n')
  if (ir.temperature != null) out.temperature = ir.temperature
  if (ir.top_p != null) out.top_p = ir.top_p
  if (ir.top_k != null) out.top_k = ir.top_k
  if (ir.stop != null) out.stop_sequences = Array.isArray(ir.stop) ? ir.stop : [ir.stop]
  if (ir.stream) out.stream = true
  if (ir.metadata?.user_id) out.metadata = { user_id: String(ir.metadata.user_id) }
  else if (typeof ir.safety_identifier === 'string' && ir.safety_identifier) out.metadata = { user_id: ir.safety_identifier }

  // 结构化输出：原生 output_config.format（Sonnet 4.5+ / Opus 4.1+ / Haiku 4.5 支持）
  if (rf?.type === 'json_schema' && rf.json_schema?.schema) {
    out.output_config = { ...(out.output_config || {}), format: { type: 'json_schema', schema: rf.json_schema.schema } }
  }

  // 工具
  const tools: any[] = []
  for (const t of Array.isArray(ir.tools) ? ir.tools : []) {
    if (!t || typeof t !== 'object') continue
    if (t.type === 'custom' && t.custom?.name) {
      tools.push({
        name: t.custom.name,
        description: t.custom.description || 'Free-form text tool. Put the entire tool input into the "input" string field.',
        input_schema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
      })
      if (t.custom.format?.type === 'grammar') warn(`custom 工具 ${t.custom.name} 的 grammar 约束无法映射到 Claude，已忽略`)
      continue
    }
    if (t.type === 'function' && t.function?.name) {
      const def: any = {
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters || { type: 'object', properties: {} },
      }
      if (t.function.strict === true) def.strict = true
      tools.push(def)
    }
  }
  for (const h of Array.isArray(ir.hosted_tools) ? ir.hosted_tools : []) {
    const mapped = hostedToolToClaude(h)
    if (mapped) tools.push(mapped)
    else warn(`托管工具 ${h?.type} 没有 Claude 对应物，已丢弃`)
  }
  if (tools.length) out.tools = tools

  // tool_choice + 并行开关
  let toolChoice: any = null
  const tc = ir.tool_choice
  if (tc && tools.length) {
    if (tc === 'auto') toolChoice = { type: 'auto' }
    else if (tc === 'required') toolChoice = { type: 'any' }
    else if (tc === 'none') toolChoice = { type: 'none' }
    else if (typeof tc === 'object') {
      const name = tc.function?.name || tc.custom?.name || tc.name
      if (name && tools.some((x) => x.name === name)) toolChoice = { type: 'tool', name }
      else toolChoice = { type: 'auto' }
    }
  }
  if (typeof ir.parallel_tool_calls === 'boolean' && tools.length) {
    if (!toolChoice) toolChoice = { type: 'auto' }
    if (toolChoice.type !== 'none') toolChoice.disable_parallel_tool_use = !ir.parallel_tool_calls
  }
  if (toolChoice) out.tool_choice = toolChoice

  applyReasoning(out, ir, upstreamModel, autoAdjust)
  return out
}

/** 按模型能力把 IR reasoning 写成 Claude 的 thinking / output_config.effort */
function applyReasoning(out: any, ir: any, model: string, autoAdjust: boolean): void {
  const r = ir.reasoning
  if (!r || typeof r !== 'object') return
  const mode = claudeThinkingMode(model)

  if (r.disabled || r.effort === 'none') {
    // fable / mythos 显式 disabled 会 400，其余 adaptive 模型接受；budget 模式直接省略即可
    if (mode !== 'budget' && !/fable|mythos/.test(model.toLowerCase())) out.thinking = { type: 'disabled' }
    return
  }

  if (mode === 'adaptive' || mode === 'adaptive-legacy') {
    const thinking: any = { type: 'adaptive' }
    if (mode === 'adaptive') {
      // 4.7+ 默认不返回思考正文，客户端要看思维链必须显式打开
      thinking.display = 'summarized'
      if (autoAdjust && (out.temperature != null || out.top_p != null || out.top_k != null)) {
        warn(`模型 ${model} 不接受采样参数，已移除 temperature / top_p / top_k`)
        delete out.temperature
        delete out.top_p
        delete out.top_k
      }
    }
    out.thinking = thinking
    const effort = effortForClaude(r.effort)
    if (effort) out.output_config = { ...(out.output_config || {}), effort }
    return
  }

  // budget 模式：enabled + budget_tokens，附带三条硬约束
  let budget = typeof r.budget_tokens === 'number' && r.budget_tokens > 0 ? r.budget_tokens : effortToBudget(r.effort)
  if (budget == null) return
  if (budget < MIN_THINKING_BUDGET) budget = MIN_THINKING_BUDGET
  if (out.max_tokens <= budget) {
    if (!autoAdjust) {
      warn(`max_tokens(${out.max_tokens}) 不大于 thinking 预算(${budget})，上游可能拒绝；已关闭自动调整`)
    } else {
      const raised = budget + 1024
      warn(`max_tokens 从 ${out.max_tokens} 抬高到 ${raised} 以容纳 thinking 预算`)
      out.max_tokens = raised
    }
  }
  out.thinking = { type: 'enabled', budget_tokens: budget }
  if (autoAdjust) {
    const removed: string[] = []
    if (out.temperature != null) {
      delete out.temperature
      removed.push('temperature')
    }
    if (out.top_k != null) {
      delete out.top_k
      removed.push('top_k')
    }
    if (out.top_p != null && (out.top_p < 0.95 || out.top_p > 1)) {
      delete out.top_p
      removed.push('top_p')
    }
    if (removed.length) warn(`开启手动 thinking 后移除了 ${removed.join(' / ')}`)
  }
}

// ═══════════ 上游方向：Claude 响应 → IR(OpenAI) ═══════════
export function parseResponse(resp: any, model: string): any {
  let text = ''
  const items: IRReasoningItem[] = []
  const toolCalls: any[] = []
  for (const block of resp.content || []) {
    if (!block) continue
    if (block.type === 'text') text += block.text || ''
    else if (block.type === 'thinking') {
      const it: IRReasoningItem = { text: block.thinking || '' }
      if (block.signature) it.signature = block.signature
      items.push(it)
    } else if (block.type === 'redacted_thinking') {
      if (block.data) items.push({ redacted: block.data })
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      })
    }
  }
  const message: any = { role: 'assistant', content: text || null }
  if (items.length) {
    message.reasoning_items = items
    const rc = reasoningItemsText(items)
    if (rc) message.reasoning_content = rc
    const sig = items.find((x) => x.signature)?.signature
    if (sig) message.reasoning_signature = sig
  }
  if (toolCalls.length) message.tool_calls = toolCalls
  const finish = claudeStopToFinish(resp.stop_reason) || 'stop'
  if (finish === 'content_filter' && text) {
    message.refusal = text
    message.content = null
  }
  return {
    id: resp.id || genId(),
    object: 'chat.completion',
    created: nowSec(),
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: usageFromClaude(resp.usage),
  }
}

// ═══════════ 上游方向：Claude SSE 事件 → IR(OpenAI) chunks ═══════════
// 推理相关 delta 约定：
//   reasoning_content    thinking 正文增量
//   reasoning_signature  当前 thinking 块的签名（块结束）
//   reasoning_redacted   一个完整的 redacted_thinking 块的 data
export function createStreamDecoder(model: string): StreamDecoder {
  let id = genId()
  const created = nowSec()
  let started = false
  let usage: any = null
  let refusal = false
  const toolIndexMap = new Map<number, number>()
  let nextToolIndex = 0

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
      const t = evt.event || data.type
      const out: any[] = []

      if (t === 'message_start') {
        id = data.message?.id || id
        usage = usageFromClaude(data.message?.usage)
        if (!started) {
          started = true
          const c = mk({ role: 'assistant', content: '' })
          c.usage = usage
          out.push(c)
        }
      } else if (t === 'content_block_start') {
        const cb = data.content_block
        if (cb?.type === 'tool_use') {
          const tcIndex = nextToolIndex++
          toolIndexMap.set(data.index, tcIndex)
          out.push(mk({ tool_calls: [{ index: tcIndex, id: cb.id, type: 'function', function: { name: cb.name, arguments: '' } }] }))
        } else if (cb?.type === 'redacted_thinking' && cb.data) {
          out.push(mk({ reasoning_redacted: cb.data }))
        }
      } else if (t === 'content_block_delta') {
        const d = data.delta
        if (d?.type === 'text_delta') out.push(mk(refusal ? { refusal: d.text } : { content: d.text }))
        else if (d?.type === 'thinking_delta') out.push(mk({ reasoning_content: d.thinking }))
        else if (d?.type === 'signature_delta') out.push(mk({ reasoning_signature: d.signature }))
        else if (d?.type === 'input_json_delta') {
          const tcIndex = toolIndexMap.get(data.index) ?? 0
          out.push(mk({ tool_calls: [{ index: tcIndex, function: { arguments: d.partial_json || '' } }] }))
        }
      } else if (t === 'message_delta') {
        const finish = claudeStopToFinish(data.delta?.stop_reason) || 'stop'
        if (finish === 'content_filter') refusal = true
        // message_delta.usage 是累计值，含 output_tokens 与（新版 API）input_tokens / 缓存字段
        const merged = usageFromClaude({ ...(usage ? usageToClaude(usage) : {}), ...(data.usage || {}) })
        usage = merged
        const chunk = mk({}, finish)
        chunk.usage = merged
        out.push(chunk)
      }
      return out
    },
    flush() {
      return []
    },
  }
}

/** 从 metadata.user_id 派生缓存分桶种子：Claude Code 的 JSON 形态取稳定的 device_id，其余原样 */
function cacheKeySeed(userId: unknown): string {
  const s = String(userId)
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s)
      if (j && typeof j === 'object') {
        const stable = j.device_id || j.account_uuid
        if (typeof stable === 'string' && stable) return stable
      }
    } catch {}
  }
  return s
}

// ═══════════ 入口方向：Claude 请求 → IR(OpenAI) ═══════════
export function parseRequest(body: any): { ir: any; stream: boolean } {
  body = body || {}
  const messages: any[] = []
  if (body.system) {
    const sys =
      typeof body.system === 'string'
        ? body.system
        : Array.isArray(body.system)
          ? body.system.map((b: any) => (typeof b === 'string' ? b : b?.text || '')).filter(Boolean).join('\n\n')
          : ''
    if (sys) messages.push({ role: 'system', content: sys })
  }

  for (const m of body.messages || []) {
    if (!m) continue
    const content = m.content
    if (m.role === 'system') {
      // 对话中途的 system 消息（Claude Code 的 mid-conversation-system beta）：无论 string / 块数组，
      // 都按 system 角色原位保留。之前块数组形态会落到 user 分支，同一条消息在相邻两轮里
      // 角色来回变，破坏上游提示词缓存前缀。
      const txt =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.map((b: any) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text || '' : '')).filter(Boolean).join('\n\n')
            : ''
      if (txt) messages.push({ role: 'system', content: txt })
      continue
    }
    if (typeof content === 'string') {
      messages.push({ role: m.role, content })
      continue
    }
    if (!Array.isArray(content)) continue

    const parts: any[] = []
    const toolCalls: any[] = []
    const items: IRReasoningItem[] = []
    for (const block of content) {
      if (!block) continue
      if (block.type === 'text') parts.push({ type: 'text', text: block.text || '' })
      else if (block.type === 'image') {
        const src = block.source
        const url = src?.type === 'base64' ? `data:${src.media_type};base64,${src.data}` : src?.url
        if (url) parts.push({ type: 'image_url', image_url: { url } })
      } else if (block.type === 'document') {
        const src = block.source || {}
        const file: any = {}
        if (src.type === 'base64' && src.data) {
          file.file_data = `data:${src.media_type || 'application/pdf'};base64,${src.data}`
          file.media_type = src.media_type
        } else if (src.type === 'url' && src.url) file.file_url = src.url
        else if (src.type === 'file' && src.file_id) file.file_id = src.file_id
        else if (src.type === 'text' && src.data) {
          parts.push({ type: 'text', text: src.data })
          continue
        }
        if (block.title) file.filename = block.title
        if (Object.keys(file).length) parts.push({ type: 'file', file })
      } else if (block.type === 'thinking') {
        const it: IRReasoningItem = { text: block.thinking || '' }
        if (block.signature) it.signature = block.signature
        items.push(it)
      } else if (block.type === 'redacted_thinking') {
        if (block.data) items.push({ redacted: block.data })
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        })
      } else if (block.type === 'tool_result') {
        const toolMsg: any = { role: 'tool', tool_call_id: block.tool_use_id }
        if (Array.isArray(block.content)) {
          const inner: any[] = []
          let onlyText = true
          for (const x of block.content) {
            if (typeof x === 'string') inner.push({ type: 'text', text: x })
            else if (x?.type === 'text') inner.push({ type: 'text', text: x.text || '' })
            else if (x?.type === 'image') {
              const src = x.source
              const url = src?.type === 'base64' ? `data:${src.media_type};base64,${src.data}` : src?.url
              if (url) {
                onlyText = false
                inner.push({ type: 'image_url', image_url: { url } })
              }
            }
          }
          toolMsg.content = onlyText ? inner.map((p) => p.text).join('') : inner
        } else {
          toolMsg.content = typeof block.content === 'string' ? block.content : ''
        }
        if (block.is_error === true) toolMsg.is_error = true
        messages.push(toolMsg)
      }
    }

    if (m.role === 'assistant') {
      const msg: any = { role: 'assistant', content: parts.map((p) => (p.type === 'text' ? p.text : '')).join('') || null }
      if (items.length) {
        msg.reasoning_items = items
        const rc = reasoningItemsText(items)
        if (rc) msg.reasoning_content = rc
      }
      if (toolCalls.length) msg.tool_calls = toolCalls
      messages.push(msg)
    } else if (parts.length) {
      const onlyText = parts.every((p) => p.type === 'text')
      messages.push({ role: 'user', content: onlyText ? parts.map((p) => p.text).join('') : parts })
    }
  }

  const ir: any = { model: body.model, messages, max_tokens: body.max_tokens, stream: !!body.stream }
  if (body.temperature != null) ir.temperature = body.temperature
  if (body.top_p != null) ir.top_p = body.top_p
  if (body.top_k != null) ir.top_k = body.top_k
  if (body.stop_sequences) ir.stop = body.stop_sequences
  if (body.metadata?.user_id) {
    ir.metadata = { user_id: body.metadata.user_id }
    // Claude Code 会把 device_id / session_id 打包成 JSON 塞进 user_id（150 字符左右），
    // 超过 OpenAI 对 safety_identifier / prompt_cache_key 的长度上限，统一哈希到 64 位。
    // prompt_cache_key 只取 device_id：session_id 每个会话都变，混进 key 会让跨会话的
    // 系统提示词 + 工具定义前缀无法复用（诊断原因 prompt_cache_key_changed）
    ir.safety_identifier = hashIdentifier(body.metadata.user_id)
    ir.prompt_cache_key = hashIdentifier(cacheKeySeed(body.metadata.user_id))
  }
  const reasoning = reasoningFromClaude(body)
  if (reasoning) ir.reasoning = reasoning

  if (Array.isArray(body.tools) && body.tools.length) {
    const tools: any[] = []
    const hosted: any[] = []
    for (const t of body.tools) {
      if (!t || typeof t !== 'object') continue
      const type = typeof t.type === 'string' ? t.type : ''
      if (!type || type === 'custom') {
        if (!t.name) continue
        const fn: any = { name: t.name, description: t.description, parameters: t.input_schema }
        if (t.strict === true) fn.strict = true
        tools.push({ type: 'function', function: fn })
        continue
      }
      if (/^web_search_\d{8}$/.test(type)) {
        const h: any = { type: 'web_search' }
        if (Array.isArray(t.allowed_domains) && t.allowed_domains.length) h.filters = { allowed_domains: t.allowed_domains }
        if (Array.isArray(t.blocked_domains) && t.blocked_domains.length) warn('web_search 的 blocked_domains 在 Responses 侧没有对应物，已忽略')
        if (t.user_location && typeof t.user_location === 'object') {
          const l: any = { type: 'approximate' }
          for (const k of ['city', 'region', 'country', 'timezone']) if (t.user_location[k]) l[k] = t.user_location[k]
          h.user_location = l
        }
        hosted.push(h)
        continue
      }
      warn(`Claude 服务端工具 ${type} 无法跨格式转换，已丢弃`)
    }
    if (tools.length) ir.tools = tools
    if (hosted.length) ir.hosted_tools = hosted
  }
  if (body.tool_choice && typeof body.tool_choice === 'object') {
    const tc = body.tool_choice
    if (tc.type === 'auto') ir.tool_choice = 'auto'
    else if (tc.type === 'any') ir.tool_choice = 'required'
    else if (tc.type === 'none') ir.tool_choice = 'none'
    else if (tc.type === 'tool' && tc.name) ir.tool_choice = { type: 'function', function: { name: tc.name } }
    if (typeof tc.disable_parallel_tool_use === 'boolean') ir.parallel_tool_calls = !tc.disable_parallel_tool_use
  }
  return { ir, stream: !!body.stream }
}

// ═══════════ 入口方向：IR(OpenAI) 响应 → Claude 响应 ═══════════
export function buildResponse(ir: any): any {
  const choice = ir.choices?.[0] || {}
  const msg = choice.message || {}
  const content: any[] = []
  if (Array.isArray(msg.reasoning_items) && msg.reasoning_items.length) {
    for (const it of msg.reasoning_items as IRReasoningItem[]) {
      if (it.redacted) content.push({ type: 'redacted_thinking', data: it.redacted })
      else content.push({ type: 'thinking', thinking: it.text || '', signature: it.signature || '' })
    }
  } else if (msg.reasoning_content) {
    const tb: any = { type: 'thinking', thinking: msg.reasoning_content, signature: msg.reasoning_signature || '' }
    content.push(tb)
  }
  const txt = contentToText(msg.content)
  if (txt) content.push({ type: 'text', text: txt })
  if (typeof msg.refusal === 'string' && msg.refusal) content.push({ type: 'text', text: msg.refusal })
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (!tc) continue
      let input: any = {}
      if (tc.type === 'custom') {
        input = { input: tc.custom?.input ?? tc.function?.arguments ?? '' }
      } else {
        try {
          input = JSON.parse(tc.function?.arguments || '{}')
        } catch {
          input = {}
        }
      }
      content.push({ type: 'tool_use', id: tc.id || genId('toolu'), name: tc.function?.name || tc.custom?.name, input })
    }
  }
  let stop = finishToClaudeStop(choice.finish_reason)
  if (stop === 'end_turn' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) stop = 'tool_use'
  return {
    id: ir.id || genId('msg'),
    type: 'message',
    role: 'assistant',
    model: ir.model,
    content: content.length ? content : [{ type: 'text', text: '' }],
    stop_reason: stop,
    stop_sequence: null,
    usage: usageToClaude(ir.usage),
  }
}

// ═══════════ 入口方向：IR(OpenAI) chunks → Claude SSE 事件 ═══════════
// 覆盖文本 / 扩展思考 / 工具调用的流式重组：每路 IR delta 映射到一个 Claude
// content block，按出现顺序分配 index，切换块类型前先发 content_block_stop。
export function createStreamEncoder(opts?: { estimatePromptTokens?: number }): StreamEncoder {
  return serialToolBlocks(createSequentialEncoder(opts))
}

function createSequentialEncoder(opts?: { estimatePromptTokens?: number }): StreamEncoder {
  let started = false
  let msgId = genId('msg')
  let model = ''
  let finishReason: string | null = null
  let hasToolCall = false
  // 跨格式流式时上游 usage 在流末才到，而 message_start 必须首发：
  // 用预估值占位，avoid Claude 客户端在 message_start 看到 input_tokens=0。
  let usage: any = { prompt_tokens: opts?.estimatePromptTokens || 0, completion_tokens: 0 }

  let openKind: 'text' | 'thinking' | 'tool' | null = null
  let openIndex = -1
  let blockCounter = 0
  const toolIndexMap = new Map<number, number>()

  const ev = (event: string, data: any): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

  const ensureStart = (): string => {
    if (started) return ''
    started = true
    return ev('message_start', {
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: 0 },
      },
    })
  }

  const closeBlock = (): string => {
    if (openKind === null) return ''
    const out = ev('content_block_stop', { type: 'content_block_stop', index: openIndex })
    openKind = null
    openIndex = -1
    return out
  }

  const openTextLike = (kind: 'text' | 'thinking'): string => {
    if (openKind === kind) return ''
    let out = closeBlock()
    openIndex = blockCounter++
    openKind = kind
    const content_block = kind === 'thinking' ? { type: 'thinking', thinking: '', signature: '' } : { type: 'text', text: '' }
    out += ev('content_block_start', { type: 'content_block_start', index: openIndex, content_block })
    return out
  }

  return {
    encode(chunk) {
      let out = ''
      model = chunk.model || model
      msgId = chunk.id || msgId
      const delta = chunk.choices?.[0]?.delta || {}
      const fr = chunk.choices?.[0]?.finish_reason
      if (chunk.usage) usage = { ...usage, ...chunk.usage }
      out += ensureStart()

      if (typeof delta.reasoning_redacted === 'string' && delta.reasoning_redacted) {
        out += closeBlock()
        const idx = blockCounter++
        out += ev('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'redacted_thinking', data: delta.reasoning_redacted } })
        out += ev('content_block_stop', { type: 'content_block_stop', index: idx })
      }
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length) {
        out += openTextLike('thinking')
        out += ev('content_block_delta', { type: 'content_block_delta', index: openIndex, delta: { type: 'thinking_delta', thinking: delta.reasoning_content } })
      }
      if (typeof delta.reasoning_signature === 'string' && delta.reasoning_signature.length) {
        out += openTextLike('thinking')
        out += ev('content_block_delta', { type: 'content_block_delta', index: openIndex, delta: { type: 'signature_delta', signature: delta.reasoning_signature } })
        // 签名标志 thinking 块结束；下一段推理正文会开新块
        out += closeBlock()
      }
      const textDelta = (typeof delta.content === 'string' ? delta.content : '') + (typeof delta.refusal === 'string' ? delta.refusal : '')
      if (textDelta.length) {
        out += openTextLike('text')
        out += ev('content_block_delta', { type: 'content_block_delta', index: openIndex, delta: { type: 'text_delta', text: textDelta } })
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          if (!tc) continue
          hasToolCall = true
          const oaiIdx = tc.index ?? 0
          if (!toolIndexMap.has(oaiIdx)) {
            out += closeBlock()
            openIndex = blockCounter++
            openKind = 'tool'
            toolIndexMap.set(oaiIdx, openIndex)
            out += ev('content_block_start', {
              type: 'content_block_start',
              index: openIndex,
              content_block: { type: 'tool_use', id: tc.id || genId('toolu'), name: tc.function?.name || tc.custom?.name || '', input: {} },
            })
          }
          const claudeIdx = toolIndexMap.get(oaiIdx)!
          const args = tc.type === 'custom' ? tc.custom?.input : tc.function?.arguments
          if (typeof args === 'string' && args.length) {
            const partial = tc.type === 'custom' ? JSON.stringify({ input: args }) : args
            out += ev('content_block_delta', { type: 'content_block_delta', index: claudeIdx, delta: { type: 'input_json_delta', partial_json: partial } })
          }
        }
      }

      if (fr) finishReason = fr
      return out
    },
    finalize() {
      let out = ensureStart()
      out += closeBlock()
      let stop = finishToClaudeStop(finishReason)
      if (stop === 'end_turn' && hasToolCall) stop = 'tool_use'
      const cu = usageToClaude(usage)
      out += ev('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stop, stop_sequence: null },
        usage: cu,
      })
      out += ev('message_stop', { type: 'message_stop' })
      return out
    },
    fail(message) {
      let out = ensureStart()
      out += closeBlock()
      out += ev('error', { type: 'error', error: { type: 'api_error', message } })
      return out
    },
  }
}
