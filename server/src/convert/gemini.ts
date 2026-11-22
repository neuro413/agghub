import { contentToText, genId, nowSec, parseDataUrl, parseToolArgs } from './ir'
import type { IRFilePart, StreamDecoder } from './ir'
import { CandidateError } from '../core/failover'
import { decodeGeminiSignature, effortToBudget, encodeGeminiSignature } from './reasoning'
import { emptyUsage, usageFromGemini } from './usage'
import type { IRReasoningItem } from '../types'

// Gemini 仅作上游渠道（Vertex Gemini 与 AI Studio 渠道共用 generateContent 协议）。
// 入口只有 openai/anthropic，故此模块不实现入口方向。

function warn(msg: string): void {
  console.warn(`[agghub][gemini] ${msg}`)
}

const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
]

// ─────────────────────────── thoughtSignature ───────────────────────────
// Gemini 3+ 对「当前轮次」（最近一条非 functionResponse 的 user 消息之后）每一步的首个 functionCall
// 强制校验签名，缺失即 400；2.5 不校验但丢签名会断开工具调用之间的推理上下文。
// 往返路径：functionCall 上的签名 → reasoning_signature（封装进推理项，Anthropic / Responses 客户端随
// thinking 块带回）+ 服务端按工具调用 id 暂存（OpenAI 客户端只带回 tool_call id）→ 重建请求时挂回原位。

/** 工具调用 id ↔ thoughtSignature 的服务端暂存 */
export interface SignatureStore {
  save(callId: string, name: string, signature: string): void
  lookup(callId: string, name: string): string | null
}

let signatureStore: SignatureStore = { save: () => {}, lookup: () => null }

export function setSignatureStore(store: SignatureStore): void {
  signatureStore = store
}

/** 官方占位签名：历史来自其他模型或暂存已淘汰时跳过校验（会损失部分推理连贯性） */
const DUMMY_SIGNATURE = 'skip_thought_signature_validator'

/** 从模型名解析 Gemini 版本号（gemini-2.5-flash → 2.5）；无法识别返回 null */
function geminiVersion(model: string): { major: number; minor: number } | null {
  const m = /gemini-(\d+)(?:\.(\d+))?/i.exec(model || '')
  return m ? { major: Number(m[1]), minor: m[2] != null ? Number(m[2]) : 0 } : null
}

/** 沿用 Gemini 下发的 functionCall.id（需符合 Claude tool_use id 的字符约束），否则生成 */
function toolCallId(raw: unknown): string {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : genId('call')
}

// ─────────────────────────── 终止原因 ───────────────────────────

/** 因安全 / 版权 / 屏蔽词等策略停止生成的 finishReason */
const BLOCK_FINISH = new Set([
  'SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'OTHER',
  'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION', 'IMAGE_OTHER',
])
/** 工具调用失败类 finishReason：没有任何产出时直接报错，避免被当成空回复 */
const TOOL_FAILURE_FINISH = new Set(['MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL', 'TOO_MANY_TOOL_CALLS'])

export function isBlockFinish(fr: unknown): boolean {
  return typeof fr === 'string' && BLOCK_FINISH.has(fr)
}

function finishMap(fr: string | null | undefined, hasToolCalls: boolean): string | null {
  if (!fr) return null
  if (fr === 'MAX_TOKENS' || fr === 'CONTINUATION') return 'length'
  if (BLOCK_FINISH.has(fr)) return 'content_filter'
  // Gemini 发出函数调用时同样返回 STOP，按是否产出工具调用判断
  return hasToolCalls ? 'tool_calls' : 'stop'
}

const suffix = (msg: unknown): string => (typeof msg === 'string' && msg ? `：${msg}` : '')
const blockText = (pf: any): string => `请求被 Gemini 拦截（${pf.blockReason}）${suffix(pf.blockReasonMessage)}`
const finishText = (fr: string, msg: unknown): string => `Gemini 因 ${fr} 停止生成${suffix(msg)}`
const toolFailureText = (fr: string, msg: unknown): string => `Gemini 工具调用失败（${fr}）${suffix(msg)}`

// ─────────────────────────── 响应 part → IR ───────────────────────────

/**
 * 单个 Gemini part → IR delta：思考分流到 reasoning_content，内联媒体转 markdown 图片；
 * functionCall 上的 thoughtSignature 封装进 reasoning_signature 并按工具调用 id 暂存。
 * 纯文本回复末尾的签名不参与校验，不回传。
 */
function partToDelta(p: any): any | null {
  if (!p || typeof p !== 'object') return null
  if (p.thought === true) return p.text ? { reasoning_content: p.text } : null
  if (p.functionCall) {
    const id = toolCallId(p.functionCall.id)
    const name = p.functionCall.name
    const delta: any = { tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(p.functionCall.args ?? {}) } }] }
    if (typeof p.thoughtSignature === 'string' && p.thoughtSignature) {
      signatureStore.save(id, name, p.thoughtSignature)
      delta.reasoning_signature = encodeGeminiSignature(p.thoughtSignature, id)
    }
    return delta
  }
  if (p.inlineData) {
    const mime = p.inlineData.mimeType || ''
    return { content: `![${mime.startsWith('image') ? 'image' : 'media'}](data:${mime};base64,${p.inlineData.data})` }
  }
  if (p.text) return { content: p.text }
  return null
}

// ─────────────────────────── JSON Schema → Gemini Schema ───────────────────────────

// Gemini 的 Schema 是 OpenAPI 3.0 子集，未知关键字会以 400 拒绝，按白名单保留
const SCHEMA_KEYS = new Set([
  'type', 'format', 'description', 'nullable', 'enum', 'items', 'properties', 'required', 'propertyOrdering',
  'minItems', 'maxItems', 'minProperties', 'maxProperties', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum',
])

/** 各类型允许的 format：STRING 只接受 enum / date-time，其余取值会被 Gemini 拒绝 */
const SCHEMA_FORMATS: Record<string, string[]> = { string: ['enum', 'date-time'], number: ['float', 'double'], integer: ['int32', 'int64'] }

function appendDescription(out: any, note: string): void {
  out.description = out.description ? `${out.description} ${note}` : note
}

/** 内联节点自身的本地 $ref（可连续多层）；递归引用或无法解析时退化为宽松对象 */
function inlineRef(node: any, defs: Record<string, any>, refs: string[]): { node: any; refs: string[] } {
  let cur = node
  let path = refs
  while (cur && typeof cur === 'object' && typeof cur.$ref === 'string') {
    const name = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(cur.$ref)?.[1]
    const { $ref: _ref, ...rest } = cur
    if (!name || !defs[name] || path.includes(name)) return { node: { type: 'object', ...rest }, refs: path }
    cur = { ...defs[name], ...rest }
    path = [...path, name]
  }
  return { node: cur, refs: path }
}

function cleanNode(raw: any, defs: Record<string, any>, refs: string[]): any {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  let { node, refs: path } = inlineRef(raw, defs, refs)
  // allOf 浅合并：properties / required 取并集，其余关键字后者覆盖前者
  if (Array.isArray(node.allOf)) {
    const { allOf, ...rest } = node
    const merged: any = {}
    for (const sub of [...allOf, rest]) {
      const r = inlineRef(sub, defs, path)
      path = r.refs
      if (!r.node || typeof r.node !== 'object') continue
      for (const [k, v] of Object.entries(r.node)) {
        if (k === 'properties' && v && typeof v === 'object') merged.properties = { ...merged.properties, ...v }
        else if (k === 'required' && Array.isArray(v)) merged.required = [...new Set([...(merged.required || []), ...v])]
        else merged[k] = v
      }
    }
    return cleanNode(merged, defs, path)
  }

  const out: any = {}
  for (const [k, v] of Object.entries(node)) {
    if (!SCHEMA_KEYS.has(k)) continue
    if (k === 'properties') {
      // 只清理属性值，属性名原样保留（参数名可能恰好是 title / default 等关键字）
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        out.properties = Object.fromEntries(Object.entries(v).map(([name, s]) => [name, cleanNode(s, defs, path)]))
      }
    } else if (k === 'items') {
      // 元组形式只能取第一项
      out.items = cleanNode(Array.isArray(v) ? v[0] : v, defs, path)
    } else {
      out[k] = v
    }
  }

  // type 数组：null 转 nullable，剩一种直接用，多种改写成 anyOf
  let variants: any[] | null = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : null
  if (Array.isArray(node.type)) {
    const types = node.type.filter((t: any) => typeof t === 'string' && t !== 'null')
    if (types.length < node.type.length) out.nullable = true
    if (types.length === 1) out.type = types[0]
    else {
      delete out.type
      if (types.length > 1 && !variants) variants = types.map((t: string) => ({ type: t }))
    }
  } else if (node.type === 'null') {
    delete out.type
    out.nullable = true
  }

  // anyOf / oneOf：null 分支转 nullable，只剩一个分支时并入当前节点（当前节点的关键字优先）
  if (variants) {
    const branches = variants.filter((b: any) => b?.type !== 'null')
    if (branches.length < variants.length) out.nullable = true
    const cleaned = branches.map((b: any) => cleanNode(b, defs, path))
    if (cleaned.length === 1) {
      for (const [k, v] of Object.entries(cleaned[0])) if (!(k in out)) out[k] = v
    } else if (cleaned.length > 1) {
      out.anyOf = cleaned
    }
  }

  if (node.const !== undefined && out.enum === undefined) {
    if (typeof node.const === 'string') out.enum = [node.const]
    else appendDescription(out, `Must be ${JSON.stringify(node.const)}.`)
  }
  if (Array.isArray(out.enum)) {
    const values = out.enum.filter((x: any) => x !== null)
    if (values.length < out.enum.length) out.nullable = true
    // Gemini 的 enum 只能是字符串，其余取值改写进描述
    if (values.length && values.every((x: any) => typeof x === 'string')) {
      out.enum = values
      out.type ??= 'string'
    } else {
      if (values.length) appendDescription(out, `Allowed values: ${values.map((x: any) => JSON.stringify(x)).join(', ')}.`)
      delete out.enum
    }
  }

  // 开区间近似为闭区间
  if (typeof node.exclusiveMinimum === 'number' && out.minimum === undefined) out.minimum = node.exclusiveMinimum
  if (typeof node.exclusiveMaximum === 'number' && out.maximum === undefined) out.maximum = node.exclusiveMaximum
  if (out.format !== undefined && !(SCHEMA_FORMATS[out.type] || []).includes(out.format)) delete out.format
  if (!out.type && !out.anyOf) {
    if (out.properties) out.type = 'object'
    else if (out.items) out.type = 'array'
  }
  if (Array.isArray(out.required)) {
    const declared = out.properties || {}
    out.required = out.required.filter((n: any) => typeof n === 'string' && Object.hasOwn(declared, n))
    if (!out.required.length) delete out.required
  }
  return out
}

/** 把 JSON Schema 收敛成 Gemini 接受的子集（函数参数与结构化输出共用）*/
function cleanSchema(schema: any): any {
  const root = schema && typeof schema === 'object' ? schema : {}
  const defs = { ...(root.definitions || {}), ...(root.$defs || {}) }
  return cleanNode(schema, defs, [])
}

// ─────────────────────────── 请求构造辅助 ───────────────────────────

/** 是否为 web_search 托管工具（Anthropic 入口为 web_search，Responses 入口可带 _preview / 日期后缀）*/
function isWebSearch(t: any): boolean {
  return typeof t?.type === 'string' && /^web_search(_preview)?(_\d{4}_\d{2}_\d{2})?$/.test(t.type)
}

/** OpenAI tool_choice → Gemini toolConfig.functionCallingConfig；指定的函数不存在时不发 */
function toolChoiceToConfig(tc: any, names: Set<string>): any | null {
  if (tc == null) return null
  if (tc === 'auto') return { functionCallingConfig: { mode: 'AUTO' } }
  if (tc === 'required') return { functionCallingConfig: { mode: 'ANY' } }
  if (tc === 'none') return { functionCallingConfig: { mode: 'NONE' } }
  if (typeof tc !== 'object') return null
  if (tc.type === 'allowed_tools') {
    // allowedFunctionNames 只能与 ANY 搭配
    const inner = tc.allowed_tools || tc
    if (inner.mode !== 'required') return { functionCallingConfig: { mode: 'AUTO' } }
    const allowed = (Array.isArray(inner.tools) ? inner.tools : []).map((x: any) => x?.function?.name || x?.name).filter((n: any) => names.has(n))
    return { functionCallingConfig: allowed.length ? { mode: 'ANY', allowedFunctionNames: allowed } : { mode: 'ANY' } }
  }
  const name = tc.function?.name || tc.name
  if (name && names.has(name)) return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [name] } }
  return null
}

/**
 * IR 推理意图 → thinkingConfig（Anthropic 入口为 ir.reasoning，OpenAI 入口为 reasoning_effort）。
 *   Gemini 3+  thinkingLevel：各型号档位不一，LOW / HIGH 全系可用，MEDIUM 仅 3 Pro 不支持，MINIMAL 多数型号会 400
 *   Gemini 2.5 thinkingBudget：Pro 128–32768 且无法关闭；Flash 0–24576；Flash-Lite 512–24576，0 为关闭
 * 两者互斥，Gemini 4 收到 thinkingBudget 会 400；无法识别版本的模型不发，避免非思考模型报错。
 */
function thinkingConfig(ir: any, model: string, version: { major: number; minor: number } | null): any | null {
  const r = ir.reasoning && typeof ir.reasoning === 'object' ? ir.reasoning : {}
  const effort: string | undefined = r.effort ?? (typeof ir.reasoning_effort === 'string' ? ir.reasoning_effort : undefined)
  const budget = typeof r.budget_tokens === 'number' && r.budget_tokens > 0 ? r.budget_tokens : undefined
  if (!version || (!effort && !budget && !r.disabled && !r.summary)) return null
  const disabled = r.disabled === true || effort === 'none'
  const name = model.toLowerCase()
  if (version.major >= 3) {
    if (disabled) return { thinkingLevel: 'LOW' }
    const out: any = { includeThoughts: true }
    if (effort) {
      out.thinkingLevel = effort === 'minimal' || effort === 'low' ? 'LOW'
        : effort === 'medium' && !/gemini-3-pro/.test(name) ? 'MEDIUM' : 'HIGH'
    }
    return out
  }
  if (version.major === 2 && version.minor >= 5) {
    const pro = name.includes('pro')
    if (disabled) return { thinkingBudget: pro ? 128 : 0 }
    const out: any = { includeThoughts: true }
    if (effort || budget) out.thinkingBudget = Math.min(pro ? 32768 : 24576, Math.max(pro ? 128 : 512, budget ?? effortToBudget(effort)))
    return out
  }
  return null
}

/** 图片部件 → inlineData；远程地址应已由 imageResolver 下载成 data URL */
function imagePart(url: string): any {
  const d = parseDataUrl(url)
  if (!d) throw new CandidateError('Gemini 图片尚未解析为有效 data URL，已停止发送缺图请求')
  return { inlineData: { mimeType: d.media_type, data: d.data } }
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/plain', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4',
}

/** 按文件名 / URL 扩展名猜 MIME；猜不出按 PDF 处理（Claude document 与 OpenAI file 部件的默认类型）*/
function guessMime(name?: string): string {
  const ext = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(name || '')?.[1]?.toLowerCase()
  return (ext && MIME_BY_EXT[ext]) || 'application/pdf'
}

/** IR file 部件 → inlineData / fileData；只有 file_id 的文件 Gemini 无从读取 */
function filePart(f: IRFilePart): any {
  if (f.file_data) {
    const d = parseDataUrl(f.file_data)
    return { inlineData: { mimeType: d?.media_type || f.media_type || guessMime(f.filename), data: d?.data || f.file_data } }
  }
  if (f.file_url) return { fileData: { mimeType: f.media_type || guessMime(f.filename || f.file_url), fileUri: f.file_url } }
  throw new CandidateError('Gemini 无法读取仅以 file_id 引用的文件')
}

/** 内容部件 → Gemini part（文本 / 图片 / 文件），不认识的部件返回 null */
function contentPart(p: any): any | null {
  if (typeof p === 'string') return p ? { text: p } : null
  if (p?.type === 'text') return p.text ? { text: p.text } : null
  if (p?.type === 'image_url') {
    const u = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url
    return u ? imagePart(u) : null
  }
  if (p?.type === 'file' && p.file && typeof p.file === 'object') return filePart(p.file)
  return null
}

/** user content → parts，保持文本与媒体的原始穿插顺序 */
function userParts(content: any): any[] {
  if (typeof content === 'string') return content ? [{ text: content }] : []
  if (!Array.isArray(content)) return []
  return content.map(contentPart).filter(Boolean)
}

/** Gemini 3+ 多模态函数结果只接受这些 MIME，其余媒体在工具结果之后单独追加 */
const FUNCTION_RESPONSE_MIME = /^(image\/(png|jpeg|webp)|application\/pdf|text\/plain)$/

/** assistant 消息 → model parts：正文 → functionCall；签名按工具调用 id 挂回对应 functionCall */
function assistantParts(msg: any, toolCallNames: Map<string, string>, modern: boolean): any[] {
  const parts: any[] = []
  const txt = contentToText(msg.content)
  if (txt) parts.push({ text: txt })
  if (typeof msg.refusal === 'string' && msg.refusal) parts.push({ text: msg.refusal })
  const calls = (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).filter((tc: any) => tc?.function?.name)
  if (!calls.length) return parts
  const signatures = new Map<string, string>()
  const items: IRReasoningItem[] = Array.isArray(msg.reasoning_items) ? msg.reasoning_items : []
  for (const value of [...items.map((it) => it?.signature), msg.reasoning_signature]) {
    const d = decodeGeminiSignature(value)
    if (d) signatures.set(d.callId, d.signature)
  }
  calls.forEach((tc: any, i: number) => {
    const name = tc.function.name
    const fc: any = { name, args: parseToolArgs(tc.function.arguments) }
    if (tc.id) {
      fc.id = tc.id
      toolCallNames.set(tc.id, name)
    }
    const part: any = { functionCall: fc }
    // 并行调用只有首个 functionCall 带签名；Gemini 3+ 的首个 functionCall 缺签名时用占位值
    const sig = (tc.id && (signatures.get(tc.id) || signatureStore.lookup(tc.id, name))) || (i === 0 && modern ? DUMMY_SIGNATURE : null)
    if (sig) part.thoughtSignature = sig
    parts.push(part)
  })
  return parts
}

/** tool 消息 → functionResponse part 与需要另行追加的媒体 parts */
function toolResultParts(msg: any, toolCallNames: Map<string, string>, modern: boolean): { part: any; media: any[] } {
  const name = msg.name || toolCallNames.get(msg.tool_call_id) || msg.tool_call_id
  let text = ''
  let media: any[] = []
  if (Array.isArray(msg.content)) {
    for (const p of msg.content) {
      if (typeof p === 'string' || p?.type === 'text') text += typeof p === 'string' ? p : p.text || ''
      else {
        const part = contentPart(p)
        if (part) media.push(part)
      }
    }
  } else {
    text = contentToText(msg.content)
  }
  let value: any
  try {
    value = JSON.parse(text)
  } catch {
    value = text
  }
  // Gemini 的 functionResponse.response 必须是对象；数组/标量需包装，失败结果按惯例放进 error
  const response = msg.is_error === true ? { error: value }
    : value !== null && typeof value === 'object' && !Array.isArray(value) ? value : { result: value }
  const fr: any = { name, response }
  if (msg.tool_call_id) fr.id = msg.tool_call_id
  if (modern) {
    const nested = media.filter((m) => FUNCTION_RESPONSE_MIME.test(m.inlineData?.mimeType || m.fileData?.mimeType || ''))
    if (nested.length) {
      fr.parts = nested
      media = media.filter((m) => !nested.includes(m))
    }
  }
  return { part: { functionResponse: fr }, media }
}

// ═══════════ 上游方向：IR(OpenAI) → Gemini 请求体（model 在 URL，不含于 body）═══════════
export function buildRequest(ir: any, upstreamModel: string): any {
  const version = geminiVersion(upstreamModel)
  const modern = !!version && version.major >= 3
  const contents: any[] = []
  const systemParts: any[] = []
  // 记录 toolCallId → 函数名，供后续 tool 消息回填 functionResponse.name
  const toolCallNames = new Map<string, string>()
  // 无法嵌进 functionResponse 的工具结果媒体，等这一串工具结果结束后再追加，保持 functionResponse 连续
  let deferredMedia: any[] = []

  // 判断是否为纯 functionResponse 的 user turn（与普通文本 / 媒体 user turn 区分）
  const isFunctionResponseTurn = (c: any): boolean =>
    c?.role === 'user' && Array.isArray(c.parts) && c.parts.length > 0 && 'functionResponse' in c.parts[0]

  // 把非 functionResponse 的 parts 追加进相邻普通 user content；若前一条是 functionResponse turn，
  // 则另起一条 user content，避免 functionResponse 后紧跟 text / 媒体混装在同一 turn 中：
  // Vertex AI Gemini 3.6+ / 4 会拒绝该形态并误报 400 "Requests ending with a model turn are not supported."。
  // 全历史统一拆分，保证多轮前缀稳定、不破坏提示词缓存。
  const appendUser = (parts: any[]): void => {
    if (!parts.length) return
    const last = contents[contents.length - 1]
    if (last && last.role === 'user' && !isFunctionResponseTurn(last)) last.parts.push(...parts)
    else contents.push({ role: 'user', parts: [...parts] })
  }
  // 并行工具结果合并到同一条纯 functionResponse 的 user content
  const appendFunctionResponse = (part: any): void => {
    const last = contents[contents.length - 1]
    if (isFunctionResponseTurn(last)) last.parts.push(part)
    else contents.push({ role: 'user', parts: [part] })
  }
  const flushMedia = (): void => {
    appendUser(deferredMedia)
    deferredMedia = []
  }

  // 只有开头连续的 system / developer 消息进入 systemInstruction；对话中途的折成 user 文本原位保留
  let leading = true
  for (const msg of ir.messages || []) {
    if (!msg) continue
    if (msg.role === 'system' || msg.role === 'developer') {
      const s = contentToText(msg.content)
      if (!s) continue
      if (leading) systemParts.push({ text: s })
      else {
        flushMedia()
        appendUser([{ text: s }])
      }
      continue
    }
    leading = false
    if (msg.role === 'tool' || msg.role === 'function') {
      const { part, media } = toolResultParts(msg, toolCallNames, modern)
      appendFunctionResponse(part)
      deferredMedia.push(...media)
      continue
    }
    flushMedia()
    if (msg.role === 'assistant') {
      const parts = assistantParts(msg, toolCallNames, modern)
      // 空 assistant 跳过（Gemini 不接受空 parts）
      if (parts.length) contents.push({ role: 'model', parts })
      continue
    }
    appendUser(userParts(msg.content))
  }
  flushMedia()

  const out: any = { contents }
  if (systemParts.length) out.systemInstruction = { parts: systemParts }

  const functionDeclarations = (Array.isArray(ir.tools) ? ir.tools : [])
    .filter((t: any) => t?.function?.name)
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
  const tools: any[] = []
  if (functionDeclarations.length) tools.push({ functionDeclarations })
  // 托管 web_search → googleSearch；与函数调用混用需要 Gemini 3 的额外开关，此时只保留函数工具
  for (const h of Array.isArray(ir.hosted_tools) ? ir.hosted_tools : []) {
    if (!isWebSearch(h)) warn(`托管工具 ${h?.type} 没有 Gemini 对应物，已丢弃`)
    else if (functionDeclarations.length) warn('googleSearch 无法与函数调用同时使用，已丢弃 web_search')
    else if (!tools.length) tools.push({ googleSearch: {} })
  }
  if (tools.length) out.tools = tools
  // toolConfig 只约束函数调用，没有函数声明时发出会被拒绝
  if (functionDeclarations.length) {
    const toolConfig = toolChoiceToConfig(ir.tool_choice, new Set(functionDeclarations.map((d: any) => d.name)))
    if (toolConfig) out.toolConfig = toolConfig
  }

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
  if (typeof ir.seed === 'number') gc.seed = ir.seed
  // 惩罚项部分型号不支持，只在客户端显式给出非零值时透传
  if (typeof ir.presence_penalty === 'number' && ir.presence_penalty !== 0) gc.presencePenalty = ir.presence_penalty
  if (typeof ir.frequency_penalty === 'number' && ir.frequency_penalty !== 0) gc.frequencyPenalty = ir.frequency_penalty
  // 结构化输出；Gemini 2.x 不支持 JSON 输出与函数调用同时使用，此时只保留工具
  const rf = ir.response_format
  if (rf?.type === 'json_object' || rf?.type === 'json_schema') {
    if (functionDeclarations.length && !modern) warn('Gemini 2.x 不支持 JSON 输出与函数调用同时使用，已忽略 response_format')
    else {
      gc.responseMimeType = 'application/json'
      const schema = rf.type === 'json_schema' ? rf.json_schema?.schema : null
      if (schema && typeof schema === 'object') gc.responseSchema = cleanSchema(schema)
    }
  }
  const thinking = thinkingConfig(ir, upstreamModel, version)
  if (thinking) gc.thinkingConfig = thinking
  if (Object.keys(gc).length) out.generationConfig = gc

  out.safetySettings = SAFETY_SETTINGS

  return out
}

type GeminiMessage = { content: string | null; reasoning_content?: string; reasoning_items?: IRReasoningItem[]; tool_calls?: any[]; refusal?: string }

/** 把一组 Gemini parts 归并成 IR(OpenAI) message 字段；思考摘要与其后到达的签名组成一个推理项 */
function partsToMessage(parts: any[]): GeminiMessage {
  let text = ''
  let reasoning = ''
  let pending = ''
  const items: IRReasoningItem[] = []
  const toolCalls: any[] = []
  for (const p of parts) {
    const d = partToDelta(p)
    if (!d) continue
    if (d.reasoning_content) {
      reasoning += d.reasoning_content
      pending += d.reasoning_content
    }
    if (d.reasoning_signature) {
      items.push({ text: pending, signature: d.reasoning_signature })
      pending = ''
    }
    if (d.content) text += d.content
    if (d.tool_calls) toolCalls.push(d.tool_calls[0])
  }
  const msg: GeminiMessage = { content: text || null }
  if (reasoning) msg.reasoning_content = reasoning
  if (items.length) msg.reasoning_items = pending ? [...items, { text: pending }] : items
  if (toolCalls.length) msg.tool_calls = toolCalls
  return msg
}

// ═══════════ 上游方向：Gemini 响应 → IR(OpenAI) ═══════════
export function parseResponse(resp: any, model: string): any {
  const cand = resp.candidates?.[0]
  const m = partsToMessage(cand?.content?.parts || [])
  const fr = cand?.finishReason
  const produced = !!(m.content || m.tool_calls?.length)
  let finish = finishMap(fr, !!m.tool_calls?.length) || 'stop'
  if (!cand && resp.promptFeedback?.blockReason) {
    // 请求整体被拦截：没有候选，只有 promptFeedback
    m.refusal = blockText(resp.promptFeedback)
    finish = 'content_filter'
  } else if (!produced && TOOL_FAILURE_FINISH.has(fr)) {
    throw new Error(toolFailureText(fr, cand.finishMessage))
  } else if (!produced && BLOCK_FINISH.has(fr)) {
    m.refusal = finishText(fr, cand.finishMessage)
  }
  return {
    id: genId(),
    object: 'chat.completion',
    created: nowSec(),
    model,
    choices: [{ index: 0, message: { role: 'assistant', ...m }, finish_reason: finish }],
    usage: usageFromGemini(resp.usageMetadata),
  }
}

// ═══════════ 上游方向：Gemini SSE chunk → IR(OpenAI) chunks ═══════════
export function createStreamDecoder(model: string): StreamDecoder {
  const id = genId()
  const created = nowSec()
  let started = false
  let toolIndex = 0
  // 是否已产出正文 / 工具调用（思考不算）
  let produced = false
  let finished = false
  // 流式各 chunk 的 usageMetadata 为累计值，以最后一次为准；终态之后才到的 usage 由 flush 补发
  let usage: any = null
  let lateUsage = false

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
      if (data.usageMetadata) {
        usage = usageFromGemini(data.usageMetadata)
        if (finished) lateUsage = true
      }
      if (!started) {
        started = true
        out.push(mk({ role: 'assistant', content: '' }))
      }
      for (const p of cand?.content?.parts || []) {
        const delta = partToDelta(p)
        if (!delta) continue
        if (delta.tool_calls) delta.tool_calls[0].index = toolIndex++
        if (delta.content || delta.tool_calls) produced = true
        out.push(mk(delta))
      }
      const fr = cand?.finishReason
      const blocked = !cand && data.promptFeedback?.blockReason
      if ((fr || blocked) && !finished) {
        finished = true
        if (!produced) {
          if (TOOL_FAILURE_FINISH.has(fr)) throw new Error(toolFailureText(fr, cand.finishMessage))
          const refusal = blocked ? blockText(data.promptFeedback) : BLOCK_FINISH.has(fr) ? finishText(fr, cand.finishMessage) : ''
          if (refusal) out.push(mk({ refusal }))
        }
        const chunk = mk({}, blocked ? 'content_filter' : finishMap(fr, toolIndex > 0))
        chunk.usage = usage || emptyUsage()
        out.push(chunk)
      }
      return out
    },
    flush() {
      return lateUsage ? [{ id, object: 'chat.completion.chunk', created, model, choices: [], usage }] : []
    },
  }
}
