import crypto from 'node:crypto'
import { contentToText, genId, hashIdentifier, nowSec } from './ir'
import type { StreamDecoder, StreamEncoder } from './ir'
import { finishToResponsesStatus, responsesStatusToFinish } from './reasonmap'
import { decodeReasoningItem, encodeReasoningItem, reasoningFromResponses, reasoningItemsText, stableReasoningId } from './reasoning'
import { usageFromResponses, usageToResponses } from './usage'
import type { IRReasoningItem } from '../types'

// OpenAI Responses API：既可作上游渠道（POST /v1/responses），也可作对外入口（/v1/responses）。
// IR 仍以 OpenAI Chat 结构为枢纽，本模块负责 Responses ↔ IR 的双向转换。
//
// 术语：Responses 的 input/output 都是「项（item）」数组，用 type 判别：
//   message / function_call / function_call_output / custom_tool_call / custom_tool_call_output / reasoning / ...
// Chat 的 messages 则以 role 划分：system / user / assistant(+tool_calls) / tool。

function warn(msg: string): void {
  console.warn(`[agghub][responses] ${msg}`)
}

const HOSTED_CALL_TYPES = new Set([
  'web_search_call',
  'file_search_call',
  'code_interpreter_call',
  'image_generation_call',
  'computer_call',
  'shell_call',
  'local_shell_call',
  'apply_patch_call',
  'mcp_call',
  'mcp_list_tools',
  'mcp_approval_request',
  'tool_search_call',
  'program',
  'program_output',
])

/** 有状态的输入项：跨格式无法表达 */
const STATEFUL_INPUT_TYPES = new Set(['item_reference', 'compaction', 'compaction_trigger'])

/** 有状态字段：跨格式转换时无法表达（换渠道也没用），直接拒绝 */
export function conversionBlocker(body: any): string | null {
  if (!body || typeof body !== 'object') return null
  const bad: string[] = []
  if (body.previous_response_id) bad.push('previous_response_id')
  if (body.conversation != null) bad.push('conversation')
  if (body.prompt != null) bad.push('prompt')
  if (body.context_management != null) bad.push('context_management')
  if (Array.isArray(body.input)) {
    const seen = new Set<string>()
    for (const it of body.input) {
      const t = it?.type
      if (typeof t === 'string' && STATEFUL_INPUT_TYPES.has(t) && !seen.has(t)) {
        seen.add(t)
        bad.push(`input[].${t}`)
      }
    }
  }
  if (bad.length) return `跨格式转换不支持有状态字段：${bad.join(', ')}（仅 Responses 直通渠道可用）`
  return null
}

// ─────────────────────────── 推理项暂存（可注入） ───────────────────────────
// Responses 上游 → Anthropic 客户端：Claude 的 thinking 签名容量放不下 encrypted_content
// （gAAAA 开头的 base64 密文，动辄几 KB 到几十 KB），用合成签名做键把推理项暂存起来，
// 客户端回传签名时再查回。
//
// 一次上游响应里可能有多个 reasoning 项（多段摘要 / 工具调用之间的交错推理），Claude 客户端
// 只认一个 thinking 块，所以把「相邻的一组」reasoning 项合并成一条记录 items[]，对应一个签名；
// 回传时展开成多个 reasoning 项，并按 followers 重新插回 message / function_call 之间
// （OpenAI 校验要求每个 reasoning 项后面必须紧跟一个非 reasoning 项，相邻两个 reasoning 会 400）。

export interface ReasoningStoreItem {
  /** 上游 reasoning 项 id（rs_xxx），回传时必须一并带上 */
  id?: string
  encrypted: string
  /** 该项之后、下一个 reasoning 项之前的可转换输出项数（message / function_call / custom_tool_call）*/
  followers: number
}

export interface ReasoningStoreRecord {
  /** 旧版单项记录字段（保留以兼容库里已有的记录）*/
  id?: string
  encrypted?: string
  summary?: string
  /** 合并组内的推理项，按上游原始顺序 */
  items?: ReasoningStoreItem[]
}

export interface ReasoningStore {
  save(rec: ReasoningStoreRecord): string
  lookup(signature: string): ReasoningStoreRecord | null
}

/** 签名派生种子：只由密文决定，同一组多次 save 得到同一个签名（followers 可以事后补写）*/
export function reasoningRecordSeed(rec: ReasoningStoreRecord): string {
  if (Array.isArray(rec.items) && rec.items.length) return rec.items.map((it) => it.encrypted).join('\n')
  return rec.encrypted || rec.id || rec.summary || ''
}

/** 把记录展开成 { id, encrypted, followers } 列表（兼容旧版单项记录）*/
function recordItems(rec: ReasoningStoreRecord): ReasoningStoreItem[] {
  if (Array.isArray(rec.items) && rec.items.length) return rec.items
  if (rec.encrypted) return [{ id: rec.id, encrypted: rec.encrypted, followers: Number.POSITIVE_INFINITY }]
  return []
}

function memoryStore(max = 500): ReasoningStore {
  const map = new Map<string, ReasoningStoreRecord>()
  return {
    save(rec) {
      const seed = reasoningRecordSeed(rec)
      if (!seed) return ''
      const sig = 'agghub-mem:' + crypto.createHash('sha256').update(seed, 'utf8').digest('base64')
      map.set(sig, rec)
      if (map.size > max) map.delete(map.keys().next().value as string)
      return sig
    },
    lookup(sig) {
      return map.get(sig) || null
    },
  }
}

let reasoningStore: ReasoningStore = memoryStore()

export function setReasoningStore(store: ReasoningStore): void {
  reasoningStore = store
}

// ─────────────────────────── 通用小工具 ───────────────────────────

/** Responses 风格的项 id：resp_ / msg_ / rs_ / fc_ + 48 位十六进制 */
function rid(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(24).toString('hex')}`
}

function argsToString(v: any): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function imageUrlOf(v: any): string {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object' && typeof v.url === 'string') return v.url
  return ''
}

/** Chat 的 url_citation 注解 {type, url_citation:{...}} ↔ Responses 扁平注解 {type, url, title, ...} */
function annotationToResponses(a: any): any {
  if (a?.type === 'url_citation' && a.url_citation && typeof a.url_citation === 'object') {
    return { type: 'url_citation', ...a.url_citation }
  }
  return a
}

function annotationToChat(a: any): any {
  if (a?.type === 'url_citation' && !a.url_citation) {
    const { type: _t, ...rest } = a
    return { type: 'url_citation', url_citation: rest }
  }
  return a
}

/** 多段推理摘要之间用空行分隔 */
function joinSeparated(parts: string[]): string {
  return parts.filter((p) => p).join('\n\n')
}

/**
 * gpt-5.5+ 为防蒸馏会返回「有 encrypted_content 但 summary 为空」的推理项。
 * 这类项用占位文本 null 表示，保证 Claude 客户端拿到的是带正文的 thinking 块而不是 redacted 块：
 * 单段直接写 null，多段拼合时以「换行 + null」接在前文后面。
 */
const EMPTY_REASONING_PLACEHOLDER = 'null'

function joinReasoningTexts(parts: string[]): string {
  let out = ''
  for (const p of parts) {
    if (!p) continue
    if (!out) out = p
    else out += (p === EMPTY_REASONING_PLACEHOLDER ? '\n' : '\n\n') + p
  }
  return out
}

function isWebSearchTool(t: any): boolean {
  return typeof t?.type === 'string' && /^web_search(_preview)?(_\d{4}_\d{2}_\d{2})?$/.test(t.type)
}

// ═══════════ 上游方向：IR(OpenAI Chat) → Responses 请求体 ═══════════

/** Chat content parts → Responses 输入内容块 */
function chatPartsToInput(content: any, role: string): any {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content)
  const textType = role === 'assistant' ? 'output_text' : 'input_text'
  const parts: any[] = []
  for (const p of content) {
    if (typeof p === 'string') {
      parts.push({ type: textType, text: p })
      continue
    }
    if (!p || typeof p !== 'object') continue
    switch (p.type) {
      case 'text':
      case 'input_text':
      case 'output_text':
        parts.push({ type: textType, text: p.text || '' })
        break
      case 'image_url': {
        const url = imageUrlOf(p.image_url)
        if (!url) break
        const part: any = { type: 'input_image', image_url: url }
        const detail = typeof p.image_url === 'object' ? p.image_url?.detail : undefined
        if (detail) part.detail = detail
        parts.push(part)
        break
      }
      case 'input_image':
        parts.push(p)
        break
      case 'file': {
        const f = p.file || {}
        const part: any = { type: 'input_file' }
        if (f.file_id) part.file_id = f.file_id
        if (f.file_data) part.file_data = f.file_data
        if (f.filename) part.filename = f.filename
        if (f.file_url) part.file_url = f.file_url
        parts.push(part)
        break
      }
      case 'input_file':
        parts.push(p)
        break
      case 'refusal':
        parts.push({ type: textType, text: p.refusal || '' })
        break
      default:
        // input_audio 等：保持原样交给上游
        parts.push(p)
    }
  }
  // 纯文本退化为字符串
  if (parts.length && parts.every((x) => x.type === textType)) return parts.map((x) => x.text).join('')
  return parts
}

function chatToolToResponses(t: any): any | null {
  if (!t || typeof t !== 'object') return null
  if (t.type === 'function' && t.function?.name) {
    const out: any = { type: 'function', name: t.function.name }
    if (t.function.description != null) out.description = t.function.description
    out.parameters = t.function.parameters ?? { type: 'object', properties: {} }
    // Responses 省略 strict 会自动尝试严格模式，普通 JSON Schema 不满足严格子集会被 400 拒绝；客户端未指定时显式关闭
    out.strict = typeof t.function.strict === 'boolean' ? t.function.strict : false
    return out
  }
  if (t.type === 'custom' && t.custom?.name) {
    const out: any = { type: 'custom', name: t.custom.name }
    if (t.custom.description != null) out.description = t.custom.description
    if (t.custom.format != null) out.format = t.custom.format
    return out
  }
  // 已是 Responses 形状（{type:'function', name} / 内置工具）→ 原样
  if (typeof t.type === 'string') return t
  return null
}

function chatToolChoiceToResponses(tc: any): any {
  if (tc == null) return undefined
  if (tc === 'auto' || tc === 'none' || tc === 'required') return tc
  if (typeof tc !== 'object') return undefined
  if (tc.type === 'function') {
    const name = tc.name || tc.function?.name
    return name ? { type: 'function', name } : undefined
  }
  if (tc.type === 'custom') {
    const name = tc.name || tc.custom?.name
    return name ? { type: 'custom', name } : undefined
  }
  if (tc.type === 'allowed_tools') {
    const inner = tc.allowed_tools || tc
    const tools = (inner.tools || []).map((x: any) => (x?.function?.name ? { type: 'function', name: x.function.name } : x))
    return { type: 'allowed_tools', mode: inner.mode || 'auto', tools }
  }
  return tc
}

/** IR reasoning_items → 可回传的 Responses reasoning 项列表（每项附带 followers 用于重新插回顺序）*/
function reasoningItemsToInput(items: IRReasoningItem[] | undefined): { item: any; followers: number }[] {
  const out: { item: any; followers: number }[] = []
  for (const it of items || []) {
    if (!it) continue
    let expanded: ReasoningStoreItem[] = []
    if (it.encrypted) expanded = [{ id: it.id, encrypted: it.encrypted, followers: Number.POSITIVE_INFINITY }]
    else {
      // 来自 Anthropic 客户端：签名 / redacted data 是本网关暂存的键，一条记录可展开成多个推理项
      const key = it.signature || it.redacted
      const rec = key ? reasoningStore.lookup(key) : null
      if (rec) expanded = recordItems(rec)
    }
    if (!expanded.length) {
      if (it.text || it.signature || it.redacted) warn('assistant 历史推理块没有可回传的 encrypted_content，已丢弃')
      continue
    }
    for (const x of expanded) {
      const item: any = { type: 'reasoning', encrypted_content: x.encrypted, summary: [] }
      if (x.id) item.id = x.id
      out.push({ item, followers: x.followers })
    }
  }
  return out
}

/**
 * 把推理项按 followers 插回后续输出项之间：
 *   reasoning(followers=1) → fc1 → reasoning(followers=1) → fc2
 * followers 为 0（原本只跟着被丢弃的托管工具项）或后面已无输出项可配对的推理项会被丢弃，
 * 避免上游返回 "reasoning ... without its required following item"。
 */
function interleaveReasoning(reasons: { item: any; followers: number }[], followers: any[]): any[] {
  if (!reasons.length) return followers
  const out: any[] = []
  let fi = 0
  for (let i = 0; i < reasons.length; i++) {
    const r = reasons[i]
    const remain = followers.length - fi
    const last = i === reasons.length - 1
    const take = last ? remain : Math.min(r.followers, remain)
    if (take <= 0) {
      warn('assistant 历史推理项后面没有可配对的输出项，已丢弃')
      continue
    }
    out.push(r.item, ...followers.slice(fi, fi + take))
    fi += take
  }
  out.push(...followers.slice(fi))
  return out
}

export interface ResponsesBuildOptions {
  /** 上游是否为 OpenAI 官方端点（官方端点拒绝 stop / penalty 等非官方字段）*/
  official?: boolean
}

export function buildRequest(ir: any, upstreamModel: string, opts?: ResponsesBuildOptions): any {
  const official = opts?.official !== false
  const input: any[] = []
  const instructions: string[] = []
  // 只有开头连续的 system / developer 消息进入顶层 instructions；对话中途出现的（如 Claude Code
  // 每轮追加的 <total_tokens> 系统提醒）原位输出为 developer 项。instructions 位于渲染上下文最前，
  // 每轮跟着变会让整个提示词缓存前缀作废（官方诊断原因 input_changed）。
  let leading = true

  for (const msg of ir.messages || []) {
    if (!msg) continue
    if (msg.role === 'system' || msg.role === 'developer') {
      const s = contentToText(msg.content)
      if (!s) continue
      if (leading) instructions.push(s)
      else input.push({ type: 'message', role: 'developer', content: s })
      continue
    }
    leading = false
    if (msg.role === 'tool' || msg.role === 'function') {
      const callId = msg.tool_call_id
      let output: any = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? chatPartsToInput(msg.content, 'user') : argsToString(msg.content)
      if (msg.is_error === true) {
        // Responses 没有 is_error 字段，用文本前缀提示模型
        if (typeof output === 'string') output = `[error] ${output}`
        else if (Array.isArray(output)) output = [{ type: 'input_text', text: '[error]' }, ...output]
      }
      if (!callId) {
        input.push({ type: 'message', role: 'user', content: `[tool_output_missing_call_id] ${typeof output === 'string' ? output : contentToText(msg.content)}` })
        continue
      }
      input.push({ type: 'function_call_output', call_id: callId, output })
      continue
    }
    if (msg.role === 'assistant') {
      // 顺序：reasoning → message → function_call；多个推理项按 followers 插回各输出项之间
      const followers: any[] = []
      const content = chatPartsToInput(msg.content, 'assistant')
      const hasText = typeof content === 'string' ? content.length > 0 : Array.isArray(content) && content.length > 0
      if (hasText) followers.push({ type: 'message', role: 'assistant', content })
      if (typeof msg.refusal === 'string' && msg.refusal) followers.push({ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: msg.refusal }] })
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (!tc) continue
          const callId = tc.id || genId('call')
          if (tc.type === 'custom') {
            followers.push({ type: 'custom_tool_call', call_id: callId, name: tc.custom?.name || tc.function?.name, input: tc.custom?.input ?? tc.function?.arguments ?? '' })
            continue
          }
          if (!tc.function?.name) continue
          followers.push({ type: 'function_call', call_id: callId, name: tc.function.name, arguments: tc.function.arguments || '{}' })
        }
      }
      input.push(...interleaveReasoning(reasoningItemsToInput(msg.reasoning_items), followers))
      continue
    }
    // user / 其它角色
    input.push({ type: 'message', role: msg.role === 'user' ? 'user' : msg.role || 'user', content: chatPartsToInput(msg.content, 'user') })
  }

  const out: any = { model: upstreamModel, input }
  if (instructions.length) out.instructions = instructions.join('\n\n')

  if (ir.temperature != null) out.temperature = ir.temperature
  if (ir.top_p != null) out.top_p = ir.top_p
  if (ir.top_logprobs != null) out.top_logprobs = ir.top_logprobs
  if (ir.parallel_tool_calls != null) out.parallel_tool_calls = ir.parallel_tool_calls
  if (ir.metadata != null && typeof ir.metadata === 'object') {
    const meta: Record<string, string> = {}
    for (const [k, v] of Object.entries(ir.metadata)) if (v != null) meta[k] = String(v)
    if (Object.keys(meta).length) out.metadata = meta
  }
  if (ir.truncation != null) out.truncation = ir.truncation
  if (ir.service_tier != null) out.service_tier = ir.service_tier
  if (ir.max_tool_calls != null) out.max_tool_calls = ir.max_tool_calls
  // 官方对 prompt_cache_key / safety_identifier 有长度上限，超长的统一哈希兜底
  if (ir.prompt_cache_key != null) out.prompt_cache_key = hashIdentifier(ir.prompt_cache_key)
  if (ir.safety_identifier != null) out.safety_identifier = hashIdentifier(ir.safety_identifier)
  else if (ir.user != null) out.user = ir.user
  // 非官方字段：vLLM / SGLang 等兼容实现接受，官方端点会 400
  const nonOfficial: string[] = []
  for (const k of ['frequency_penalty', 'presence_penalty', 'stop', 'top_k'] as const) {
    if (ir[k] == null) continue
    if (official) nonOfficial.push(k)
    else out[k] = ir[k]
  }
  if (nonOfficial.length) warn(`官方 Responses 端点不接受 ${nonOfficial.join(' / ')}，已丢弃（第三方兼容上游可在渠道 base_url 中体现）`)
  const maxT = ir.max_completion_tokens ?? ir.max_tokens
  if (maxT != null) out.max_output_tokens = maxT

  // 无状态代理：默认不落库，并要求带回加密推理内容以便多轮续接
  out.store = typeof ir.store === 'boolean' ? ir.store : false
  const include = new Set<string>(Array.isArray(ir.include) ? ir.include : [])
  if (!out.store) include.add('reasoning.encrypted_content')
  if (ir.logprobs === true || ir.top_logprobs != null) include.add('message.output_text.logprobs')
  if (include.size) out.include = [...include]

  // reasoning：统一从 ir.reasoning 读取（Claude thinking / Responses reasoning 都已归一化）；兼容旧字段
  const r = ir.reasoning
  if (r && typeof r === 'object') {
    if (!r.disabled && r.effort !== 'none') {
      const reasoning: any = { summary: r.summary || 'auto' }
      if (r.effort) reasoning.effort = r.effort
      out.reasoning = reasoning
    }
  } else if (ir.reasoning_effort != null) {
    out.reasoning = { effort: ir.reasoning_effort, summary: 'auto' }
  }

  // response_format → text.format；verbosity → text.verbosity
  const text: any = {}
  const rf = ir.response_format
  if (rf?.type === 'json_schema' && rf.json_schema) {
    text.format = {
      type: 'json_schema',
      name: rf.json_schema.name || 'response',
      schema: rf.json_schema.schema,
      ...(rf.json_schema.strict != null ? { strict: rf.json_schema.strict } : {}),
      ...(rf.json_schema.description ? { description: rf.json_schema.description } : {}),
    }
  } else if (rf?.type === 'json_object' || rf?.type === 'text') {
    text.format = { type: rf.type }
  }
  if (ir.verbosity != null) text.verbosity = ir.verbosity
  if (Object.keys(text).length) out.text = text

  const tools: any[] = []
  for (const t of Array.isArray(ir.tools) ? ir.tools : []) {
    const m = chatToolToResponses(t)
    if (m) tools.push(m)
  }
  for (const h of Array.isArray(ir.hosted_tools) ? ir.hosted_tools : []) {
    if (h && typeof h === 'object') tools.push(h)
  }
  if (tools.length) out.tools = tools
  const tc = chatToolChoiceToResponses(ir.tool_choice)
  if (tc !== undefined && tools.length) out.tool_choice = tc

  return out
}

// ═══════════ 上游方向：Responses 响应 → IR(OpenAI Chat) ═══════════

type ParsedOutput = {
  content: string | null
  reasoning_content?: string
  reasoning_signature?: string
  reasoning_items?: IRReasoningItem[]
  tool_calls?: any[]
  annotations?: any[]
  refusal?: string
}

function reasoningItemText(item: any): string {
  const content = (item?.content || []).map((c: any) => c?.text || '').filter(Boolean)
  if (content.length) return joinSeparated(content)
  return joinSeparated((item?.summary || []).map((s: any) => s?.text || ''))
}

const CONVERTIBLE_OUTPUT_TYPES = new Set(['message', 'function_call', 'custom_tool_call'])

/** 能转成 IR 的非推理输出项（assistant message / function_call / custom_tool_call），是 reasoning 项的合法后继 */
function isFollowerItem(item: any): boolean {
  if (!item || !CONVERTIBLE_OUTPUT_TYPES.has(item.type)) return false
  if (item.type === 'message' && item.role && item.role !== 'assistant') return false
  return true
}

/** 一组相邻的 reasoning 项（中间只隔着会被丢弃的托管工具项）*/
interface ReasoningGroup {
  items: ReasoningStoreItem[]
  texts: string[]
}

/**
 * 把 output[] 里的 reasoning 项分组：遇到 message / function_call / custom_tool_call 就切一组，
 * 同时给每个推理项记下它后面紧跟的可转换输出项数（followers），供回传时重新插回。
 */
function groupReasoning(output: any[]): ReasoningGroup[] {
  const groups: ReasoningGroup[] = []
  let cur: ReasoningGroup | null = null
  let lastItem: ReasoningStoreItem | null = null
  for (const item of output || []) {
    if (!item) continue
    if (item.type === 'reasoning') {
      if (!cur) {
        cur = { items: [], texts: [] }
        groups.push(cur)
      }
      const text = reasoningItemText(item)
      const hasEnc = typeof item.encrypted_content === 'string' && !!item.encrypted_content
      if (text) cur.texts.push(text)
      else if (hasEnc) cur.texts.push(EMPTY_REASONING_PLACEHOLDER)
      lastItem = null
      if (hasEnc) {
        lastItem = { id: item.id, encrypted: item.encrypted_content, followers: 0 }
        cur.items.push(lastItem)
      }
    } else if (isFollowerItem(item)) {
      cur = null
      if (lastItem) lastItem.followers++
    }
  }
  return groups
}

/** 一组 reasoning 项 → 一个 IR 推理块（合并文本，暂存密文，返回合成签名）*/
function groupToItem(g: ReasoningGroup): IRReasoningItem | null {
  const it: IRReasoningItem = {}
  const text = joinReasoningTexts(g.texts)
  if (text) it.text = text
  if (g.items.length) {
    const sig = reasoningStore.save({ items: g.items, summary: text })
    if (sig) it.signature = sig
    if (g.items.length === 1 && g.items[0].id) it.id = g.items[0].id
  }
  if (!it.text && !it.signature) return null
  // 没有任何可读文本但有密文：以 redacted 块承载签名，Claude 客户端会原样回传 data
  if (!it.text && it.signature) {
    it.redacted = it.signature
    delete it.signature
  }
  return it
}

/** 把 Responses output[] 归并成 IR message 字段 */
function outputToMessage(output: any[]): ParsedOutput {
  const texts: string[] = []
  const annotations: any[] = []
  const toolCalls: any[] = []
  let refusal = ''
  for (const item of output || []) {
    if (!item) continue
    if (item.type === 'message') {
      if (item.role && item.role !== 'assistant') continue
      let t = ''
      for (const c of item.content || []) {
        if (c?.type === 'output_text') {
          t += c.text || ''
          for (const a of c.annotations || []) annotations.push(annotationToChat(a))
        } else if (c?.type === 'refusal') refusal += c.refusal || ''
      }
      if (t) texts.push(t)
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id || item.id || genId('call'),
        type: 'function',
        function: { name: item.name, arguments: argsToString(item.arguments) || '{}' },
      })
    } else if (item.type === 'custom_tool_call') {
      toolCalls.push({
        id: item.call_id || item.id || genId('call'),
        type: 'custom',
        custom: { name: item.name, input: argsToString(item.input) },
      })
    }
  }
  const items: IRReasoningItem[] = []
  for (const g of groupReasoning(output)) {
    const it = groupToItem(g)
    if (it) items.push(it)
  }
  const msg: ParsedOutput = { content: texts.length ? joinSeparated(texts) : null }
  if (items.length) {
    msg.reasoning_items = items
    const rc = reasoningItemsText(items)
    if (rc) msg.reasoning_content = rc
    const sig = items.find((x) => x.signature)?.signature
    if (sig) msg.reasoning_signature = sig
  }
  if (toolCalls.length) msg.tool_calls = toolCalls
  if (annotations.length) msg.annotations = annotations
  if (refusal) msg.refusal = refusal
  return msg
}

/** 非流式 Responses 响应 → IR(OpenAI Chat) 响应 */
export function parseResponse(resp: any, model: string): any {
  if (resp?.status === 'failed') throw new Error(resp.error?.message || '上游返回 status=failed')
  const m = outputToMessage(resp?.output || [])
  const message: any = { role: 'assistant', content: m.content }
  if (m.reasoning_items) message.reasoning_items = m.reasoning_items
  if (m.reasoning_content) message.reasoning_content = m.reasoning_content
  if (m.reasoning_signature) message.reasoning_signature = m.reasoning_signature
  if (m.tool_calls) message.tool_calls = m.tool_calls
  if (m.annotations) message.annotations = m.annotations
  if (m.refusal) message.refusal = m.refusal
  return {
    id: resp?.id || genId(),
    object: 'chat.completion',
    created: typeof resp?.created_at === 'number' ? resp.created_at : nowSec(),
    model,
    choices: [{ index: 0, message, finish_reason: responsesStatusToFinish(resp, !!m.tool_calls?.length) }],
    usage: usageFromResponses(resp?.usage),
  }
}

// ═══════════ 上游方向：Responses SSE 事件 → IR(OpenAI Chat) chunks ═══════════
export function createStreamDecoder(model: string): StreamDecoder {
  const id = genId()
  const created = nowSec()
  let started = false
  let hasToolCall = false
  let textSeen = false
  let refusalSeen = false
  let reasoningSeen = false
  let nextToolIndex = 0

  type Tool = { index: number; callId: string; name: string; args: string; nameSent: boolean; kind: 'function' | 'custom' }
  // 事件按 output_index（首选）或 item_id 定位到工具 / 推理项
  const tools = new Map<string, Tool>()
  const keyOf = (d: any): string => {
    if (d?.output_index != null) return `o:${d.output_index}`
    const itemId = d?.item_id || d?.item?.id
    return itemId ? `i:${itemId}` : ''
  }

  // 推理项：按 key 记录已流出的文本，output_item.done 时补齐并结算签名
  type Reason = { text: string; parts: number; closed: boolean }
  const reasons = new Map<string, Reason>()
  const ensureReason = (d: any): Reason => {
    const key = keyOf(d) || 'r:last'
    let r = reasons.get(key)
    if (!r) {
      r = { text: '', parts: 0, closed: false }
      reasons.set(key, r)
      if (d?.item_id && d.output_index != null) reasons.set(`i:${d.item_id}`, r)
    }
    return r
  }

  const mk = (delta: any, finish: string | null = null): any => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })

  const start = (out: any[]): void => {
    if (!started) {
      started = true
      out.push(mk({ role: 'assistant', content: '' }))
    }
  }

  const ensureTool = (d: any, item: any, kind: 'function' | 'custom'): Tool => {
    const key = keyOf(d) || `c:${item?.call_id || genId('call')}`
    let t = tools.get(key)
    if (!t) {
      t = { index: nextToolIndex++, callId: '', name: '', args: '', nameSent: false, kind }
      tools.set(key, t)
      if (d?.item_id && d.output_index != null) tools.set(`i:${d.item_id}`, t)
    }
    if (item?.call_id) t.callId = item.call_id
    else if (!t.callId && item?.id) t.callId = item.id
    if (item?.name) t.name = item.name
    return t
  }

  /** 发工具增量：首包带 id/name，后续只带 arguments */
  const emitTool = (out: any[], t: Tool, argsDelta: string): void => {
    if (!argsDelta && t.nameSent) return
    start(out)
    hasToolCall = true
    const tc: any = { index: t.index }
    if (t.kind === 'custom') tc.custom = { input: argsDelta }
    else tc.function = { arguments: argsDelta }
    if (!t.nameSent) {
      tc.id = t.callId || genId('call')
      tc.type = t.kind
      if (t.kind === 'custom') tc.custom.name = t.name
      else tc.function.name = t.name
      t.nameSent = true
    }
    t.args += argsDelta
    out.push(mk({ tool_calls: [tc] }))
  }

  const emitText = (out: any[], s: string): void => {
    if (!s) return
    textSeen = true
    start(out)
    out.push(mk({ content: s }))
  }

  const emitRefusal = (out: any[], s: string): void => {
    if (!s) return
    refusalSeen = true
    start(out)
    out.push(mk({ refusal: s }))
  }

  // 相邻的多个 reasoning 项合并成一个 thinking 块：文本连续流出，签名等到第一个非推理输出项
  // （或流结束）时才结算一次；之后到达的 message / function_call 计入组内末项的 followers
  type Group = { items: ReasoningStoreItem[]; text: string; lastItem: ReasoningStoreItem | null }
  let group: Group | null = null
  let closedGroup: Group | null = null
  const followerKeys = new Set<string>()

  const emitReasoningText = (out: any[], r: Reason, s: string, raw = false): void => {
    if (!s || r.closed) return
    reasoningSeen = true
    if (!group) group = { items: [], text: '', lastItem: null }
    // 组内不同推理项之间补空行（raw：调用方已自行处理分隔）
    if (!raw && !r.text && group.text && !group.text.endsWith('\n\n')) s = '\n\n' + s.replace(/^\n{1,2}/, '')
    r.text += s
    group.text += s
    start(out)
    out.push(mk({ reasoning_content: s }))
  }

  /** 推理项结束：补齐未流出的文本，把密文挂到当前合并组（签名延后到 flushGroup 结算）*/
  const closeReason = (out: any[], r: Reason, item: any): void => {
    if (r.closed) return
    const full = reasoningItemText(item)
    if (full) {
      if (!r.text) emitReasoningText(out, r, full)
      else if (full.length > r.text.length && full.startsWith(r.text)) emitReasoningText(out, r, full.slice(r.text.length))
    }
    if (!full && !r.text && typeof item?.encrypted_content === 'string' && item.encrypted_content) {
      // 空摘要但有密文：写占位 null（多段时换行接在前文后）
      const s = group?.text ? '\n' + EMPTY_REASONING_PLACEHOLDER : EMPTY_REASONING_PLACEHOLDER
      emitReasoningText(out, r, s, true)
    }
    r.closed = true
    if (typeof item?.encrypted_content === 'string' && item.encrypted_content) {
      reasoningSeen = true
      if (!group) group = { items: [], text: '', lastItem: null }
      const it: ReasoningStoreItem = { id: item.id, encrypted: item.encrypted_content, followers: 0 }
      group.items.push(it)
      group.lastItem = it
    }
  }

  /** 结算当前合并组：暂存整组密文，产出一个签名（无正文时用 redacted 承载）*/
  const flushGroup = (out: any[]): void => {
    if (!group) return
    const g = group
    group = null
    closedGroup = g
    if (!g.items.length) return
    const sig = reasoningStore.save({ items: g.items, summary: g.text })
    if (!sig) return
    start(out)
    if (g.text) out.push(mk({ reasoning_signature: sig }))
    else out.push(mk({ reasoning_redacted: sig }))
  }

  /** 见到一个可转换的非推理输出项：先结算推理组，再给上一组末项的 followers 计数并补写记录 */
  const noteFollower = (out: any[], key: string): void => {
    flushGroup(out)
    if (!key || followerKeys.has(key)) return
    followerKeys.add(key)
    const g = closedGroup
    if (g?.lastItem) {
      g.lastItem.followers++
      reasoningStore.save({ items: g.items, summary: g.text })
    }
  }

  return {
    push(evt) {
      let d: any
      try {
        d = JSON.parse(evt.data)
      } catch {
        return []
      }
      const out: any[] = []
      const type = d?.type

      switch (type) {
        case 'response.created':
        case 'response.in_progress':
          start(out)
          break
        case 'response.output_text.delta':
          noteFollower(out, keyOf(d))
          emitText(out, d.delta || '')
          break
        case 'response.refusal.delta':
          noteFollower(out, keyOf(d))
          emitRefusal(out, d.delta || '')
          break
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta': {
          const r = ensureReason(d)
          let s = d.delta || ''
          // 同一推理项的多段摘要之间补空行
          if (r.parts > 0 && r.text && !r.text.endsWith('\n\n') && s) {
            s = '\n\n' + s.replace(/^\n{1,2}/, '')
            r.parts = 0
          }
          emitReasoningText(out, r, s)
          break
        }
        case 'response.reasoning_summary_text.done':
        case 'response.reasoning_text.done': {
          const r = ensureReason(d)
          const full = typeof d.text === 'string' ? d.text : ''
          if (full && !r.text.endsWith(full) && !r.text) emitReasoningText(out, r, full)
          r.parts++
          break
        }
        case 'response.output_text.annotation.added':
          if (d.annotation) {
            start(out)
            out.push(mk({ annotations: [annotationToChat(d.annotation)] }))
          }
          break
        case 'response.output_item.added': {
          const item = d.item
          if (isFollowerItem(item)) noteFollower(out, keyOf(d))
          if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
            const t = ensureTool(d, item, item.type === 'custom_tool_call' ? 'custom' : 'function')
            const full = argsToString(item.type === 'custom_tool_call' ? item.input : item.arguments)
            const rest = full.length > t.args.length && full.startsWith(t.args) ? full.slice(t.args.length) : ''
            emitTool(out, t, rest)
          } else if (item?.type === 'reasoning') {
            ensureReason(d)
          }
          break
        }
        case 'response.output_item.done': {
          const item = d.item
          if (isFollowerItem(item)) noteFollower(out, keyOf(d))
          if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
            const t = ensureTool(d, item, item.type === 'custom_tool_call' ? 'custom' : 'function')
            const full = argsToString(item.type === 'custom_tool_call' ? item.input : item.arguments)
            // done 事件带完整参数：补发尚未流出的部分（上游可能不发 arguments.delta）
            const rest = full.length > t.args.length && full.startsWith(t.args) ? full.slice(t.args.length) : ''
            emitTool(out, t, rest)
          } else if (item?.type === 'reasoning') {
            closeReason(out, ensureReason(d), item)
          }
          break
        }
        case 'response.function_call_arguments.delta':
        case 'response.custom_tool_call_input.delta': {
          if (!d.delta) break
          const kind = type === 'response.custom_tool_call_input.delta' ? 'custom' : 'function'
          noteFollower(out, keyOf(d))
          const t = tools.get(keyOf(d)) || ensureTool(d, null, kind)
          emitTool(out, t, d.delta)
          break
        }
        case 'response.function_call_arguments.done':
        case 'response.custom_tool_call_input.done': {
          const kind = type === 'response.custom_tool_call_input.done' ? 'custom' : 'function'
          noteFollower(out, keyOf(d))
          const t = tools.get(keyOf(d)) || ensureTool(d, null, kind)
          const full = argsToString(d.arguments ?? d.input)
          const rest = full.length > t.args.length && full.startsWith(t.args) ? full.slice(t.args.length) : ''
          if (d.name && !t.name) t.name = d.name
          emitTool(out, t, rest)
          break
        }
        case 'response.completed':
        case 'response.incomplete':
        case 'response.done': {
          const resp = d.response || {}
          // 上游没走增量事件、只在终态给完整 output 时，从终态补齐
          const output: any[] = resp.output || []
          if (!reasoningSeen) {
            // 终态补齐：按非流式规则分组，每组一段文本 + 一个签名
            for (const g of groupReasoning(output)) {
              const text = joinReasoningTexts(g.texts)
              if (text) {
                start(out)
                out.push(mk({ reasoning_content: text }))
              }
              if (!g.items.length) continue
              const sig = reasoningStore.save({ items: g.items, summary: text })
              if (!sig) continue
              start(out)
              if (text) out.push(mk({ reasoning_signature: sig }))
              else out.push(mk({ reasoning_redacted: sig }))
            }
          } else flushGroup(out)
          const m = outputToMessage(output.filter((it: any) => it?.type !== 'reasoning'))
          if (!textSeen && m.content) emitText(out, m.content)
          if (!refusalSeen && m.refusal) emitRefusal(out, m.refusal)
          if (!tools.size && m.tool_calls?.length) {
            for (const tc of m.tool_calls) {
              const kind = tc.type === 'custom' ? 'custom' : 'function'
              const t: Tool = { index: nextToolIndex++, callId: tc.id, name: kind === 'custom' ? tc.custom.name : tc.function.name, args: '', nameSent: false, kind }
              tools.set(`c:${tc.id}`, t)
              emitTool(out, t, (kind === 'custom' ? tc.custom.input : tc.function.arguments) || '')
            }
          }
          start(out)
          const chunk = mk({}, responsesStatusToFinish(resp, hasToolCall))
          chunk.usage = usageFromResponses(resp.usage)
          out.push(chunk)
          break
        }
        case 'response.failed':
          throw new Error(d.response?.error?.message || '上游返回 response.failed')
        case 'error':
        case 'response.error':
          throw new Error(d.message || d.error?.message || '上游返回 error 事件')
        default:
          break
      }
      return out
    },
    flush() {
      return []
    },
  }
}

// ═══════════ 入口方向：Responses 请求 → IR(OpenAI Chat) ═══════════

/** Responses 输入内容块 → Chat content（纯文本退化为字符串）*/
function inputContentToChat(content: any): any {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return argsToString(content)
  const parts: any[] = []
  let onlyText = true
  for (const p of content) {
    if (typeof p === 'string') {
      parts.push({ type: 'text', text: p })
      continue
    }
    if (!p || typeof p !== 'object') continue
    switch (p.type) {
      case 'input_text':
      case 'output_text':
      case 'text':
        parts.push({ type: 'text', text: p.text || '' })
        break
      case 'refusal':
        parts.push({ type: 'text', text: p.refusal || '' })
        break
      case 'input_image': {
        onlyText = false
        const url = imageUrlOf(p.image_url)
        const image_url: any = url ? { url } : { file_id: p.file_id }
        if (p.detail) image_url.detail = p.detail
        parts.push({ type: 'image_url', image_url })
        break
      }
      case 'input_file': {
        onlyText = false
        const file: any = {}
        for (const k of ['file_id', 'file_data', 'filename', 'file_url']) if (p[k] != null) file[k] = p[k]
        parts.push({ type: 'file', file })
        break
      }
      default:
        onlyText = false
        parts.push(p)
    }
  }
  if (onlyText) return parts.map((x) => x.text).join('')
  return parts
}

function responsesToolToChat(t: any): any | null {
  if (!t || typeof t !== 'object') return null
  if (t.type === 'function' && t.name) {
    const fn: any = { name: t.name }
    if (t.description != null) fn.description = t.description
    if (t.parameters != null) fn.parameters = t.parameters
    if (typeof t.strict === 'boolean') fn.strict = t.strict
    return { type: 'function', function: fn }
  }
  if (t.type === 'custom' && t.name) {
    const custom: any = { name: t.name }
    if (t.description != null) custom.description = t.description
    if (t.format != null) custom.format = t.format
    return { type: 'custom', custom }
  }
  // 命名空间：展开其中的函数
  if (t.type === 'namespace' && Array.isArray(t.tools)) {
    return t.tools.map(responsesToolToChat).filter(Boolean)
  }
  return null
}

function responsesToolChoiceToChat(tc: any): any {
  if (tc == null) return undefined
  if (tc === 'auto' || tc === 'none' || tc === 'required') return tc
  if (typeof tc !== 'object') return undefined
  if (tc.type === 'function' && tc.name) return { type: 'function', function: { name: tc.name } }
  if (tc.type === 'custom' && tc.name) return { type: 'custom', custom: { name: tc.name } }
  if (tc.type === 'allowed_tools') return tc.mode === 'required' ? 'required' : 'auto'
  // 强制内置工具：Chat 无对应，退化为 auto
  return 'auto'
}

export function parseRequest(body: any): { ir: any; stream: boolean } {
  body = body || {}
  const messages: any[] = []

  // instructions → system
  if (body.instructions != null) {
    const s = typeof body.instructions === 'string' ? body.instructions : Array.isArray(body.instructions) ? body.instructions.map((it: any) => contentToText(inputContentToChat(it?.content))).join('\n\n') : ''
    if (s) messages.push({ role: 'system', content: s })
  }

  const pushToolCall = (tc: any): void => {
    const last = messages[messages.length - 1]
    if (last && last.role === 'assistant') {
      last.tool_calls = [...(last.tool_calls || []), tc]
    } else {
      messages.push({ role: 'assistant', content: null, tool_calls: [tc] })
    }
  }

  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input })
  } else if (Array.isArray(body.input)) {
    body.input.forEach((item: any, idx: number) => {
      if (!item || typeof item !== 'object') return
      const type = item.type || (item.role ? 'message' : '')
      switch (type) {
        case 'message': {
          const role = item.role === 'developer' ? 'system' : item.role || 'user'
          const content = inputContentToChat(item.content)
          if (role === 'assistant') {
            const txt = typeof content === 'string' ? content : contentToText(content)
            messages.push({ role: 'assistant', content: txt || null })
          } else {
            messages.push({ role, content })
          }
          break
        }
        case 'function_call':
          pushToolCall({
            id: item.call_id || item.id || genId('call'),
            type: 'function',
            function: { name: item.name, arguments: argsToString(item.arguments) || '{}' },
          })
          break
        case 'custom_tool_call':
          pushToolCall({
            id: item.call_id || item.id || genId('call'),
            type: 'custom',
            custom: { name: item.name, input: argsToString(item.input) },
          })
          break
        case 'function_call_output':
        case 'custom_tool_call_output': {
          if (!item.call_id) throw new Error(`input[${idx}] (${type}) 缺少 call_id，无法与工具调用配对`)
          const output = item.output
          const content = typeof output === 'string' ? output : Array.isArray(output) ? inputContentToChat(output) : argsToString(output)
          messages.push({ role: 'tool', tool_call_id: item.call_id, content })
          break
        }
        case 'reasoning': {
          // 推理项：本网关产出的 encrypted_content 可解回 thinking 块；其它来源只保留可读摘要
          const decoded = decodeReasoningItem(item.encrypted_content)
          const text = reasoningItemText(item)
          const it: IRReasoningItem = decoded ? { ...decoded } : {}
          if (!decoded) {
            if (item.encrypted_content) warn('input 中的 reasoning 项 encrypted_content 不是本网关产出，跨格式无法回传，仅保留摘要')
            if (text) it.text = text
          } else if (!it.text && text) it.text = text
          if (item.id) it.id = item.id
          if (it.text || it.signature || it.redacted) {
            const msg: any = { role: 'assistant', content: null, reasoning_items: [it] }
            if (it.text) msg.reasoning_content = it.text
            messages.push(msg)
          }
          break
        }
        default:
          if (HOSTED_CALL_TYPES.has(type) || type.endsWith('_output') || type === 'mcp_approval_response') {
            warn(`input[${idx}] 托管工具项 ${type} 跨格式无对应，已忽略`)
          }
          break
      }
    })
  }

  // 相邻的「仅 reasoning 的 assistant」与后续 assistant 合并，避免出现空 assistant
  for (let i = 0; i < messages.length - 1; i++) {
    const a = messages[i]
    const b = messages[i + 1]
    if (a.role === 'assistant' && a.content == null && !a.tool_calls && a.reasoning_items && b.role === 'assistant') {
      b.reasoning_items = [...a.reasoning_items, ...(b.reasoning_items || [])]
      const rc = reasoningItemsText(b.reasoning_items)
      if (rc) b.reasoning_content = rc
      messages.splice(i, 1)
      i--
    }
  }

  const ir: any = { model: body.model, messages, stream: !!body.stream }
  if (body.temperature != null) ir.temperature = body.temperature
  if (body.top_p != null) ir.top_p = body.top_p
  if (body.top_logprobs != null) {
    ir.top_logprobs = body.top_logprobs
    ir.logprobs = true
  }
  if (body.max_output_tokens != null) ir.max_tokens = body.max_output_tokens
  if (typeof body.parallel_tool_calls === 'boolean') ir.parallel_tool_calls = body.parallel_tool_calls
  if (body.metadata != null) ir.metadata = body.metadata
  if (body.store != null) ir.store = body.store
  if (body.user != null) ir.user = body.user
  if (body.safety_identifier != null) ir.safety_identifier = body.safety_identifier
  if (body.prompt_cache_key != null) ir.prompt_cache_key = body.prompt_cache_key
  if (body.service_tier != null) ir.service_tier = body.service_tier
  if (body.frequency_penalty != null) ir.frequency_penalty = body.frequency_penalty
  if (body.presence_penalty != null) ir.presence_penalty = body.presence_penalty
  if (body.stop != null) ir.stop = body.stop
  if (body.stream) ir.stream_options = { include_usage: true }
  const reasoning = reasoningFromResponses(body)
  if (reasoning) {
    ir.reasoning = reasoning
    if (reasoning.effort && reasoning.effort !== 'none') ir.reasoning_effort = reasoning.effort
  }

  // text.format → response_format；verbosity 透传
  const fmt = body.text?.format
  if (fmt?.type === 'json_schema') {
    const js: any = { name: fmt.name || 'response', schema: fmt.schema }
    if (fmt.strict != null) js.strict = fmt.strict
    if (fmt.description) js.description = fmt.description
    ir.response_format = { type: 'json_schema', json_schema: js }
  } else if (fmt?.type === 'json_object') {
    ir.response_format = { type: 'json_object' }
  }
  if (body.text?.verbosity != null) ir.verbosity = body.text.verbosity

  if (Array.isArray(body.tools) && body.tools.length) {
    const tools: any[] = []
    const hosted: any[] = []
    for (const t of body.tools) {
      const r = responsesToolToChat(t)
      if (r) {
        tools.push(...(Array.isArray(r) ? r : [r]))
        continue
      }
      if (isWebSearchTool(t)) {
        hosted.push(t)
        continue
      }
      if (t && typeof t === 'object' && typeof t.type === 'string' && t.type !== 'namespace') {
        warn(`托管工具 ${t.type} 跨格式无对应，已丢弃`)
      }
    }
    if (tools.length) ir.tools = tools
    if (hosted.length) ir.hosted_tools = hosted
    const customNames = tools.filter((t) => t.type === 'custom').map((t) => t.custom.name)
    if (customNames.length) ir.custom_tool_names = customNames
  }
  const tc = responsesToolChoiceToChat(body.tool_choice)
  if (tc !== undefined && (ir.tools || ir.hosted_tools)) ir.tool_choice = tc

  return { ir, stream: !!body.stream }
}

// ═══════════ 入口方向：IR(OpenAI Chat) 响应 → Responses 响应 ═══════════

/** 响应对象的公共回显字段（客户端 SDK 会读取其中部分字段，给出保守默认值）*/
function responseShell(id: string, created: number, model: string): any {
  return {
    id,
    object: 'response',
    created_at: created,
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model,
    output: [],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: null,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    truncation: 'disabled',
    usage: null,
    user: null,
    metadata: {},
  }
}

/** IR 推理块 → Responses reasoning 输出项 */
function reasoningItemToOutput(it: IRReasoningItem, status: string): any {
  const seed = it.signature || it.redacted || it.encrypted || ''
  const out: any = {
    id: it.id || (seed ? stableReasoningId(seed) : rid('rs')),
    type: 'reasoning',
    status,
    summary: it.text ? [{ type: 'summary_text', text: it.text }] : [],
  }
  if (it.encrypted) out.encrypted_content = it.encrypted
  else if (it.signature || it.redacted) out.encrypted_content = encodeReasoningItem(it)
  return out
}

export interface ResponsesEncodeOptions {
  model?: string
  /** 请求侧声明的 custom 工具名，用于把同名 tool_call 还原为 custom_tool_call */
  customToolNames?: string[]
}

function isCustomCall(tc: any, customNames: Set<string>): boolean {
  if (tc?.type === 'custom') return true
  const name = tc?.function?.name
  return !!name && customNames.has(name)
}

function toolCallToOutput(tc: any, respId: string, i: number, status: string, customNames: Set<string>): any {
  const callId = tc.id || `${respId}_call_${i}`
  if (isCustomCall(tc, customNames)) {
    const name = tc.custom?.name || tc.function?.name
    let input = tc.custom?.input ?? tc.function?.arguments ?? ''
    // Claude 侧的 custom 工具以 { input: "..." } 承载文本
    if (tc.type !== 'custom' && typeof input === 'string') {
      try {
        const parsed = JSON.parse(input)
        if (parsed && typeof parsed === 'object' && typeof parsed.input === 'string') input = parsed.input
      } catch {}
    }
    return { id: rid('ctc'), type: 'custom_tool_call', status, call_id: callId, name, input: typeof input === 'string' ? input : argsToString(input) }
  }
  return {
    id: rid('fc'),
    type: 'function_call',
    status,
    call_id: callId,
    name: tc.function?.name,
    arguments: tc.function?.arguments || '{}',
  }
}

function irMessageToOutput(msg: any, respId: string, status: string, customNames: Set<string>): any[] {
  const output: any[] = []
  if (Array.isArray(msg.reasoning_items) && msg.reasoning_items.length) {
    for (const it of msg.reasoning_items as IRReasoningItem[]) output.push(reasoningItemToOutput(it, status))
  } else if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) {
    const it: IRReasoningItem = { text: msg.reasoning_content }
    if (msg.reasoning_signature) it.signature = msg.reasoning_signature
    output.push(reasoningItemToOutput(it, status))
  }
  const text = contentToText(msg.content)
  const content: any[] = []
  if (text) {
    content.push({
      type: 'output_text',
      text,
      annotations: Array.isArray(msg.annotations) ? msg.annotations.map(annotationToResponses) : [],
      logprobs: [],
    })
  }
  if (typeof msg.refusal === 'string' && msg.refusal) content.push({ type: 'refusal', refusal: msg.refusal })
  if (content.length) {
    output.push({ id: rid('msg'), type: 'message', status, role: 'assistant', content })
  }
  if (Array.isArray(msg.tool_calls)) {
    msg.tool_calls.forEach((tc: any, i: number) => {
      if (!tc) return
      output.push(toolCallToOutput(tc, respId, i, status, customNames))
    })
  }
  return output
}

export function buildResponse(ir: any, opts?: ResponsesEncodeOptions): any {
  const choice = ir?.choices?.[0] || {}
  const msg = choice.message || {}
  const id = rid('resp')
  const out = responseShell(id, ir?.created || nowSec(), ir?.model || opts?.model || '')
  const { status, incomplete_details } = finishToResponsesStatus(choice.finish_reason)
  out.status = status
  out.incomplete_details = incomplete_details
  out.output = irMessageToOutput(msg, id, status === 'incomplete' ? 'incomplete' : 'completed', new Set(opts?.customToolNames || []))
  out.usage = usageToResponses(ir?.usage)
  return out
}

// ═══════════ 入口方向：IR(OpenAI Chat) chunks → Responses SSE 事件 ═══════════
// 事件骨架：response.created → output_item.added → (content_part.added → output_text.delta… → output_text.done
// → content_part.done) → output_item.done → response.completed。推理与工具调用各自是独立的 output item。
export function createStreamEncoder(opts?: ResponsesEncodeOptions): StreamEncoder {
  let seq = 0
  let started = false
  let finalized = false
  const respId = rid('resp')
  const created = nowSec()
  let model = opts?.model || ''
  let finishReason: string | null = null
  let usage: any = null
  const customNames = new Set(opts?.customToolNames || [])

  type Item = {
    kind: 'message' | 'reasoning' | 'tool'
    outputIndex: number
    id: string
    text: string
    refusal: string
    encrypted?: string
    callId?: string
    name?: string
    custom?: boolean
    sourceKind?: 'function' | 'custom'
    wrapped?: boolean
    added?: boolean
    emitted?: number
    done: boolean
  }
  const order: Item[] = []
  let nextOutputIndex = 0
  let curMsg: Item | null = null
  let curReason: Item | null = null
  const tools = new Map<number, Item>()

  const ev = (type: string, data: any): string => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`

  const responseObj = (status: string): any => {
    const out = responseShell(respId, created, model)
    out.status = status
    return out
  }

  const ensureStart = (): string => {
    if (started) return ''
    started = true
    return ev('response.created', { response: responseObj('in_progress') }) + ev('response.in_progress', { response: responseObj('in_progress') })
  }

  const itemStatus = (): string => (finishReason === 'length' || finishReason === 'content_filter' ? 'incomplete' : 'completed')

  const messageItem = (it: Item, status: string): any => {
    const content: any[] = []
    if (it.text || !it.refusal) content.push({ type: 'output_text', text: it.text, annotations: [], logprobs: [] })
    if (it.refusal) content.push({ type: 'refusal', refusal: it.refusal })
    return { id: it.id, type: 'message', status, role: 'assistant', content }
  }
  const reasoningItem = (it: Item, status: string): any => {
    const out: any = { id: it.id, type: 'reasoning', status, summary: it.text ? [{ type: 'summary_text', text: it.text }] : [] }
    if (it.encrypted) out.encrypted_content = it.encrypted
    return out
  }
  const toolItem = (it: Item, status: string): any =>
    it.custom
      ? { id: it.id, type: 'custom_tool_call', status, call_id: it.callId, name: it.name || '', input: it.text }
      : { id: it.id, type: 'function_call', status, call_id: it.callId, name: it.name || '', arguments: it.text || '{}' }

  const closeMsg = (): string => {
    if (!curMsg) return ''
    const it = curMsg
    curMsg = null
    it.done = true
    const status = itemStatus()
    let out = ''
    if (it.text || !it.refusal) {
      out +=
        ev('response.output_text.done', { item_id: it.id, output_index: it.outputIndex, content_index: 0, text: it.text, logprobs: [] }) +
        ev('response.content_part.done', { item_id: it.id, output_index: it.outputIndex, content_index: 0, part: { type: 'output_text', text: it.text, annotations: [], logprobs: [] } })
    }
    if (it.refusal) {
      const ci = it.text || !it.refusal ? 1 : 0
      out +=
        ev('response.refusal.done', { item_id: it.id, output_index: it.outputIndex, content_index: ci, refusal: it.refusal }) +
        ev('response.content_part.done', { item_id: it.id, output_index: it.outputIndex, content_index: ci, part: { type: 'refusal', refusal: it.refusal } })
    }
    out += ev('response.output_item.done', { output_index: it.outputIndex, item: messageItem(it, status) })
    return out
  }
  const closeReason = (encrypted?: string): string => {
    if (!curReason) return ''
    const it = curReason
    curReason = null
    it.done = true
    if (encrypted) it.encrypted = encrypted
    let out = ''
    if (it.text) {
      out +=
        ev('response.reasoning_summary_text.done', { item_id: it.id, output_index: it.outputIndex, summary_index: 0, text: it.text }) +
        ev('response.reasoning_summary_part.done', { item_id: it.id, output_index: it.outputIndex, summary_index: 0, part: { type: 'summary_text', text: it.text } })
    }
    out += ev('response.output_item.done', { output_index: it.outputIndex, item: reasoningItem(it, itemStatus()) })
    return out
  }
  const addTool = (it: Item): string => {
    if (it.added || !it.callId || !it.name) return ''
    it.custom = it.sourceKind === 'custom' || customNames.has(it.name)
    it.wrapped = it.custom && it.sourceKind !== 'custom'
    it.added = true
    const item = it.custom
      ? { id: it.id, type: 'custom_tool_call', status: 'in_progress', call_id: it.callId, name: it.name, input: '' }
      : { id: it.id, type: 'function_call', status: 'in_progress', call_id: it.callId, name: it.name, arguments: '' }
    return ev('response.output_item.added', { output_index: it.outputIndex, item })
  }
  const emitToolInput = (it: Item): string => {
    if (!it.added || it.wrapped) return ''
    const delta = it.text.slice(it.emitted || 0)
    it.emitted = it.text.length
    if (!delta) return ''
    return ev(it.custom ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta', { item_id: it.id, output_index: it.outputIndex, delta })
  }
  const closeTool = (it: Item): string => {
    if (it.done) return ''
    let out = addTool(it)
    if (!it.added) throw new Error('上游工具调用缺少 ID 或名称')
    if (it.wrapped) {
      let parsed: any
      try { parsed = JSON.parse(it.text) } catch { throw new Error('custom 工具的包装 JSON 不完整') }
      if (!parsed || typeof parsed.input !== 'string') throw new Error('custom 工具包装缺少字符串 input')
      it.text = parsed.input
      it.wrapped = false
    }
    if (!it.custom && !it.text) it.text = '{}'
    out += emitToolInput(it)
    it.done = true
    const doneEv = it.custom
      ? ev('response.custom_tool_call_input.done', { item_id: it.id, output_index: it.outputIndex, input: it.text })
      : ev('response.function_call_arguments.done', { item_id: it.id, output_index: it.outputIndex, name: it.name || '', arguments: it.text })
    return out + doneEv + ev('response.output_item.done', { output_index: it.outputIndex, item: toolItem(it, itemStatus()) })
  }

  const openMsg = (): string => {
    if (curMsg) return ''
    let out = closeReason()
    const it: Item = { kind: 'message', outputIndex: nextOutputIndex++, id: rid('msg'), text: '', refusal: '', done: false }
    order.push(it)
    curMsg = it
    out += ev('response.output_item.added', { output_index: it.outputIndex, item: { id: it.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] } })
    out += ev('response.content_part.added', { item_id: it.id, output_index: it.outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [], logprobs: [] } })
    return out
  }
  const openReason = (): string => {
    if (curReason) return ''
    let out = closeMsg()
    const it: Item = { kind: 'reasoning', outputIndex: nextOutputIndex++, id: rid('rs'), text: '', refusal: '', done: false }
    order.push(it)
    curReason = it
    out += ev('response.output_item.added', { output_index: it.outputIndex, item: { id: it.id, type: 'reasoning', status: 'in_progress', summary: [] } })
    out += ev('response.reasoning_summary_part.added', { item_id: it.id, output_index: it.outputIndex, summary_index: 0, part: { type: 'summary_text', text: '' } })
    return out
  }

  return {
    encode(chunk) {
      if (finalized) return ''
      let out = ''
      model = chunk.model || model
      if (chunk.usage) usage = chunk.usage
      const delta = chunk.choices?.[0]?.delta || {}
      const fr = chunk.choices?.[0]?.finish_reason
      out += ensureStart()

      // 整块 redacted_thinking：独立的 reasoning 项，密文承载 data
      if (typeof delta.reasoning_redacted === 'string' && delta.reasoning_redacted) {
        out += closeMsg() + closeReason()
        const encrypted = encodeReasoningItem({ redacted: delta.reasoning_redacted })
        const it: Item = { kind: 'reasoning', outputIndex: nextOutputIndex++, id: stableReasoningId(delta.reasoning_redacted), text: '', refusal: '', encrypted, done: true }
        order.push(it)
        out += ev('response.output_item.added', { output_index: it.outputIndex, item: { id: it.id, type: 'reasoning', status: 'in_progress', summary: [] } })
        out += ev('response.output_item.done', { output_index: it.outputIndex, item: reasoningItem(it, 'completed') })
      }
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length) {
        out += openReason()
        curReason!.text += delta.reasoning_content
        out += ev('response.reasoning_summary_text.delta', { item_id: curReason!.id, output_index: curReason!.outputIndex, summary_index: 0, delta: delta.reasoning_content })
      }
      if (typeof delta.reasoning_signature === 'string' && delta.reasoning_signature.length) {
        // 签名到达 = 一个 thinking 块结束：把正文 + 签名打包成 encrypted_content 并关闭该项
        out += openReason()
        out += closeReason(encodeReasoningItem({ text: curReason!.text, signature: delta.reasoning_signature }))
      }
      if (typeof delta.content === 'string' && delta.content.length) {
        out += openMsg()
        curMsg!.text += delta.content
        out += ev('response.output_text.delta', { item_id: curMsg!.id, output_index: curMsg!.outputIndex, content_index: 0, delta: delta.content, logprobs: [] })
      }
      if (typeof delta.refusal === 'string' && delta.refusal.length) {
        out += openMsg()
        const it = curMsg!
        const ci = it.text || !it.refusal ? 1 : 0
        if (!it.refusal) out += ev('response.content_part.added', { item_id: it.id, output_index: it.outputIndex, content_index: ci, part: { type: 'refusal', refusal: '' } })
        it.refusal += delta.refusal
        out += ev('response.refusal.delta', { item_id: it.id, output_index: it.outputIndex, content_index: ci, delta: delta.refusal })
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          if (!tc) continue
          const idx = tc.index ?? 0
          if (!Number.isSafeInteger(idx) || idx < 0) throw new Error('工具调用 index 无效')
          let it = tools.get(idx)
          if (!it) {
            out += closeMsg() + closeReason()
            const custom = isCustomCall(tc, customNames)
            it = {
              kind: 'tool', outputIndex: nextOutputIndex++, id: rid(custom ? 'ctc' : 'fc'),
              text: '', refusal: '', callId: '', name: '', custom, done: false,
              sourceKind: tc.type === 'custom' || tc.custom ? 'custom' : 'function', emitted: 0,
            }
            tools.set(idx, it)
            order.push(it)
          }
          const name = tc.function?.name || tc.custom?.name
          if (tc.id && it.callId && tc.id !== it.callId) throw new Error('同一工具调用的 ID 发生变化')
          if (name && it.name && name !== it.name) throw new Error('同一工具调用的名称发生变化')
          if (tc.id) it.callId = tc.id
          if (name) it.name = name
          const args = it.sourceKind === 'custom' ? tc.custom?.input : tc.function?.arguments
          if (typeof args === 'string') it.text += args
          out += addTool(it)
          out += emitToolInput(it)
        }
      }
      if (fr) finishReason = fr
      return out
    },
    finalize() {
      if (finalized) return ''
      let out = ensureStart()
      out += closeMsg() + closeReason()
      for (const it of tools.values()) out += closeTool(it)
      if (!finishReason && tools.size) finishReason = 'tool_calls'
      const { status, incomplete_details } = finishToResponsesStatus(finishReason)
      const resp = responseObj(status)
      resp.incomplete_details = incomplete_details
      const st = status === 'incomplete' ? 'incomplete' : 'completed'
      resp.output = order.map((it) => (it.kind === 'message' ? messageItem(it, st) : it.kind === 'reasoning' ? reasoningItem(it, st) : toolItem(it, st)))
      resp.usage = usageToResponses(usage)
      out += ev(status === 'incomplete' ? 'response.incomplete' : 'response.completed', { response: resp })
      finalized = true
      return out
    },
    fail(message) {
      if (finalized) return ''
      finalized = true
      let out = ensureStart()
      const resp = responseObj('failed')
      resp.error = { code: 'server_error', message }
      resp.output = order.map((it) => (it.kind === 'message' ? messageItem(it, 'incomplete') : it.kind === 'reasoning' ? reasoningItem(it, 'incomplete') : toolItem(it, 'incomplete')))
      resp.usage = usageToResponses(usage)
      out += ev('response.failed', { response: resp })
      return out
    },
  }
}

// ═══════════ 直通辅助：供 relay 在 Responses 入口 → Responses 上游直通时判定内容 / 统计 ═══════════

/** 非流式直通响应体是否为空回复 */
export function isEmptyResponseBody(json: any): boolean {
  if (!json || typeof json !== 'object') return true
  for (const item of Array.isArray(json.output) ? json.output : []) {
    if (!item) continue
    if (item.type === 'message') {
      for (const c of item.content || []) {
        if (c?.type === 'output_text' && (c.text || '').trim()) return false
        if (c?.type === 'refusal' && (c.refusal || '').trim()) return false
      }
    } else if (item.type === 'reasoning') {
      if (reasoningItemText(item).trim() || item.encrypted_content) return false
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call' || HOSTED_CALL_TYPES.has(item.type)) {
      return false
    }
  }
  return true
}

/** 流式直通事件是否含实质内容（决定何时向客户端开流）*/
export function streamEventHasContent(d: any): boolean {
  if (!d) return false
  switch (d.type) {
    case 'response.output_text.delta':
    case 'response.refusal.delta':
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta':
    case 'response.function_call_arguments.delta':
    case 'response.custom_tool_call_input.delta':
    case 'response.mcp_call_arguments.delta':
    case 'response.code_interpreter_call_code.delta':
      return typeof d.delta === 'string' && d.delta.length > 0
    case 'response.image_generation_call.partial_image':
      return true
    case 'response.output_item.added':
    case 'response.output_item.done': {
      const t = d.item?.type
      return t === 'function_call' || t === 'custom_tool_call' || HOSTED_CALL_TYPES.has(t)
    }
    case 'response.completed':
    case 'response.incomplete':
      return !isEmptyResponseBody(d.response)
    default:
      return false
  }
}

/** 流式直通事件中的文本增量（用于日志正文）*/
export function streamEventText(d: any): string {
  if (d?.type === 'response.output_text.delta' || d?.type === 'response.refusal.delta') return d.delta || ''
  return ''
}

/** 流式直通事件中的终态错误信息（response.failed / error）*/
export function streamEventError(d: any): string | null {
  if (!d) return null
  if (d.type === 'response.failed') return d.response?.error?.message || d.response?.error?.code || 'response.failed'
  if (d.type === 'error' || d.type === 'response.error') return d.message || d.error?.message || 'error'
  return null
}
