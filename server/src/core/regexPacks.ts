import util, { isDeepStrictEqual } from 'node:util'
import { createRequire } from 'node:module'
import type { PackStepTrace, PackTrace, RegexPack, RegexPackInjectStep, RegexPackRegexStep, RegexPackScriptStep, RegexPackStep } from '../types'
import { dropMessages, removeMatchedMessages, ruleMatchesMeta, transformMessageText, type PreprocessMeta } from './preprocess'
import { compileCode, compileTemplate, stringify, type MacroEnv, type TemplateMatch, type TemplateRuntime } from './promptTemplate'

/**
 * 正则包（提示词预处理高级模式）的执行引擎。
 *
 * 一个包 = 启用范围（UA 白名单 / 启用条件 / 渠道等）+ 参数 + 按顺序执行的步骤（正则 / 注入 / 脚本）。
 * 模板与脚本以网关进程的完整权限运行（可 fetch、读写文件），只有管理员能编辑。
 */

/** 单个步骤的执行上限；超时按出错处理，本步不生效 */
export const STEP_TIMEOUT_MS = 30_000
const MAX_LOG_LINES = 50
const MAX_LOG_CHARS = 2000
const MAX_ERROR_CHARS = 1000

export interface PackContext {
  meta: PreprocessMeta
  /** 客户端原始 User-Agent */
  ua: string | null
  headers?: Record<string, any>
  channelName?: string | null
  keyName?: string | null
  upstreamModel?: string
  stream?: boolean
  /** 本次上游尝试的取消信号；触发后中止执行并向上抛出 */
  signal?: AbortSignal
}

// ── UA 白名单 ────────────────────────────────────────────
const REGEX_LITERAL = /^\/(.+)\/([a-z]*)$/s

/** 把 /…/flags 形式的条目解析成正则；不是该形式返回 null，正则无效时抛错 */
export function parseRegexLiteral(entry: string): RegExp | null {
  const m = REGEX_LITERAL.exec(entry)
  // 去掉 g / y：匹配只关心是否命中，不能带 lastIndex 状态
  return m ? new RegExp(m[1], m[2].replace(/[gy]/g, '')) : null
}

const uaEntryCache = new Map<string, RegExp | null>()

function uaEntryRegex(entry: string): RegExp | null {
  let re = uaEntryCache.get(entry)
  if (re === undefined) {
    // 保存时已校验；库里的历史无效正则退回关键词匹配
    try { re = parseRegexLiteral(entry) } catch { re = null }
    if (uaEntryCache.size >= 500) uaEntryCache.clear()
    uaEntryCache.set(entry, re)
  }
  return re
}

/** UA 白名单是否放行：名单为空 = 不限；否则命中任一条目才放行，请求没有 UA 视为不命中 */
export function uaMatches(whitelist: string[] | undefined, ua: string | null | undefined): boolean {
  const entries = (whitelist ?? []).map(entry => entry.trim()).filter(Boolean)
  if (!entries.length) return true
  if (!ua) return false
  const lower = ua.toLowerCase()
  return entries.some((entry) => {
    const re = uaEntryRegex(entry)
    return re ? re.test(ua) : lower.includes(entry.toLowerCase())
  })
}

// ── 与格式无关的请求视图 ─────────────────────────────────
/**
 * 请求体的形状：anthropic = Claude 直通（顶层 system + messages）；responses = Responses 直通（instructions + input）；
 * chat = OpenAI Chat 直通或跨格式转换时的中间表示（system 在 messages 内）。
 */
export type BodyShape = 'anthropic' | 'responses' | 'chat'

export function shapeOf(meta: Pick<PreprocessMeta, 'passthrough' | 'entryFormat'>): BodyShape {
  if (meta.passthrough && meta.entryFormat === 'anthropic') return 'anthropic'
  if (meta.passthrough && meta.entryFormat === 'responses') return 'responses'
  return 'chat'
}

const TEXT_PART_TYPES = new Set(['text', 'input_text', 'output_text'])
const OUTPUT_ITEM_TYPES = new Set(['function_call_output', 'custom_tool_call_output'])
const CALL_ITEM_TYPES = new Set(['function_call', 'custom_tool_call', 'reasoning'])

const isTextPart = (part: any): boolean => !!part && typeof part === 'object' && TEXT_PART_TYPES.has(part.type) && typeof part.text === 'string'

/** content（字符串或 part 数组）里的文本，多个文本块用换行连接 */
function readText(content: any): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(part => typeof part === 'string' || isTextPart(part)).map(part => (typeof part === 'string' ? part : part.text)).join('\n')
}

/** 改写 content 里的文本：写进第一个文本块，其余文本块移除，非文本块（图片、工具调用等）原样保留 */
function writeText(content: any, value: string, partType: string): any {
  if (!Array.isArray(content)) return value
  const next: any[] = []
  let placed = false
  for (const part of content) {
    if (typeof part === 'string' || isTextPart(part)) {
      if (!placed && value) next.push(typeof part === 'string' ? value : { ...part, text: value })
      placed = true
    } else next.push(part)
  }
  if (!placed && value) next.push({ type: partType, text: value })
  return next
}

export class MessageView {
  constructor(
    private readonly view: RequestView,
    /** 原始消息对象（Responses 的字符串 input 时为该字符串） */
    readonly raw: any,
    readonly index: number,
    /** Responses 的 input 为单个字符串 */
    readonly inline = false,
  ) {}

  /** system / user / assistant / tool；developer 归为 system，无法归类的输入项为 other */
  get role(): string {
    const item = this.raw
    if (this.inline) return 'user'
    if (!item || typeof item !== 'object') return 'other'
    if (OUTPUT_ITEM_TYPES.has(item.type)) return 'tool'
    if (item.role) return item.role === 'developer' ? 'system' : item.role
    return CALL_ITEM_TYPES.has(item.type) ? 'assistant' : 'other'
  }

  private get textKey(): 'output' | 'content' | null {
    const item = this.raw
    if (!item || typeof item !== 'object') return null
    if (OUTPUT_ITEM_TYPES.has(item.type)) return 'output'
    return item.role ? 'content' : null
  }

  /** 文本内容；Claude 消息里的 tool_result / tool_use 块不计入，需要时用 raw */
  get text(): string {
    if (this.inline) return typeof this.view.body.input === 'string' ? this.view.body.input : ''
    const key = this.textKey
    return key ? readText(this.raw[key]) : ''
  }

  set text(value: unknown) {
    const text = stringify(value)
    if (this.inline) {
      if (typeof this.view.body.input === 'string') this.view.body.input = text
      return
    }
    const key = this.textKey
    if (!key) return
    const partType = this.view.shape !== 'responses' ? 'text' : this.raw.role === 'assistant' ? 'output_text' : 'input_text'
    this.raw[key] = writeText(this.raw[key], text, partType)
  }

  /** 移除这条消息；带有的工具调用 / 结果连同配对的另一半一起移除 */
  remove(): void {
    this.view.remove(this)
  }
}

export class ToolView {
  constructor(readonly raw: any, private readonly parent: any[]) {}

  /** Chat 的定义在 function / custom 下，Claude 与 Responses 的在顶层 */
  private get holder(): any {
    const tool = this.raw
    return tool.function && typeof tool.function === 'object' ? tool.function : tool.custom && typeof tool.custom === 'object' ? tool.custom : tool
  }

  get name(): string {
    return typeof this.holder.name === 'string' ? this.holder.name : ''
  }

  get description(): string {
    return typeof this.holder.description === 'string' ? this.holder.description : ''
  }

  set description(value: unknown) {
    this.holder.description = stringify(value)
  }

  /** 参数 JSON Schema 对象（可直接修改）；没有时为 undefined */
  get schema(): any {
    return this.holder.parameters ?? this.holder.input_schema
  }

  /** 只移除工具定义；历史消息里的调用记录不处理（需要一并清理时用「工具过滤」规则） */
  remove(): void {
    const index = this.parent.indexOf(this.raw)
    if (index >= 0) this.parent.splice(index, 1)
  }
}

export class RequestView {
  constructor(readonly body: any, readonly shape: BodyShape) {}

  /** 消息列表：Chat / Claude 的 messages，Responses 的 input 项数组；create 时没有则创建（字符串 input 转成单条 user 消息） */
  private list(create = false): any[] | null {
    const body = this.body
    if (this.shape === 'responses') {
      if (Array.isArray(body.input)) return body.input
      if (!create) return null
      body.input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : []
      return body.input
    }
    if (Array.isArray(body.messages)) return body.messages
    if (!create) return null
    body.messages = []
    return body.messages
  }

  /** Chat 形状下开头连续的 system / developer 消息 */
  private leading(): any[] {
    const out: any[] = []
    for (const msg of this.list() ?? []) {
      if (msg?.role !== 'system' && msg?.role !== 'developer') break
      out.push(msg)
    }
    return out
  }

  /** 系统提示词文本：Claude 的顶层 system、Responses 的 instructions、Chat 开头的 system 消息 */
  get system(): string {
    const body = this.body
    if (this.shape === 'anthropic') return readText(body.system)
    if (this.shape === 'responses') return typeof body.instructions === 'string' ? body.instructions : ''
    return this.leading().map(msg => readText(msg.content)).join('\n')
  }

  /** 整体替换系统提示词；空串 = 移除。Claude 的多块 system 会合并成一块，保留最后一个 cache_control */
  set system(value: unknown) {
    const text = stringify(value)
    const body = this.body
    if (this.shape === 'anthropic') {
      if (!text) delete body.system
      else if (Array.isArray(body.system)) {
        let cache: any
        for (const part of body.system) if (part?.cache_control) cache = part.cache_control
        body.system = [{ type: 'text', text, ...(cache ? { cache_control: cache } : {}) }]
      } else body.system = text
    } else if (this.shape === 'responses') {
      if (text) body.instructions = text
      else delete body.instructions
    } else {
      const lead = this.leading()
      const list = this.list(!!text)
      if (list) list.splice(0, lead.length, ...(text ? [{ role: lead[0]?.role ?? 'system', content: text }] : []))
    }
  }

  private addSystem(value: unknown, start: boolean): void {
    const text = stringify(value)
    if (!text) return
    const body = this.body
    const join = (old: string): string => (!old ? text : start ? `${text}\n\n${old}` : `${old}\n\n${text}`)
    if (this.shape === 'anthropic') {
      // 多块 system 追加独立的文本块，不动已有块及其 cache_control
      if (Array.isArray(body.system)) {
        if (start) body.system.unshift({ type: 'text', text })
        else body.system.push({ type: 'text', text })
      } else body.system = join(typeof body.system === 'string' ? body.system : '')
    } else if (this.shape === 'responses') {
      body.instructions = join(typeof body.instructions === 'string' ? body.instructions : '')
    } else {
      const lead = this.leading()
      const msg = start ? lead[0] : lead[lead.length - 1]
      if (msg && typeof msg.content === 'string') msg.content = join(msg.content)
      else this.list(true)!.splice(start ? 0 : lead.length, 0, { role: 'system', content: text })
    }
  }

  /** 在系统提示词开头加一段文本 */
  prependSystem(text: unknown): void {
    this.addSystem(text, true)
  }

  /** 在系统提示词结尾加一段文本 */
  appendSystem(text: unknown): void {
    this.addSystem(text, false)
  }

  /** 当前消息列表的快照；增删消息后需重新读取 */
  get messages(): MessageView[] {
    if (this.shape === 'responses' && typeof this.body.input === 'string') return [new MessageView(this, this.body.input, 0, true)]
    return (this.list() ?? []).map((raw, index) => new MessageView(this, raw, index))
  }

  /** 最后一条有文本的消息；给出 role 时只看该角色 */
  lastMessage(role?: string): MessageView | undefined {
    const messages = this.messages
    for (let i = messages.length - 1; i >= 0; i--) {
      if ((!role || messages[i].role === role) && messages[i].text) return messages[i]
    }
    return undefined
  }

  private make(role: string, text: string): any {
    // Claude 的 messages 里只有 user / assistant
    const actual = role === 'assistant' ? 'assistant' : this.shape === 'anthropic' || role !== 'system' ? 'user' : 'system'
    return { role: actual, content: text }
  }

  /** 在下标 index 处插入一条消息（负数从末尾数起，同 Array.splice） */
  insert(index: number, role: string, text: unknown): void {
    const value = stringify(text)
    if (value) this.list(true)!.splice(index, 0, this.make(role, value))
  }

  /** 插到倒数第 depth 条消息之前；0 = 最末尾 */
  insertAtDepth(depth: number, role: string, text: unknown): void {
    const value = stringify(text)
    if (!value) return
    const list = this.list(true)!
    list.splice(Math.max(0, list.length - Math.max(0, depth)), 0, this.make(role, value))
  }

  append(role: string, text: unknown): void {
    this.insertAtDepth(0, role, text)
  }

  prepend(role: string, text: unknown): void {
    this.insert(0, role, text)
  }

  /** 移除一条消息，或所有让 predicate 返回真的消息；工具调用 / 结果成对移除。返回移除的条数 */
  remove(target: MessageView | ((message: MessageView) => unknown)): number {
    const views = typeof target === 'function' ? this.messages.filter(target) : [target]
    const removed = new Set<any>()
    let count = 0
    for (const view of views) {
      if (!view.inline) removed.add(view.raw)
      else if (typeof this.body.input === 'string') {
        delete this.body.input
        count++
      }
    }
    const before = this.list()?.length ?? 0
    if (removed.size) dropMessages(this.body, removed)
    return count + before - (this.list()?.length ?? 0)
  }

  /** 全部工具定义（Responses 命名空间内的工具已展开） */
  get tools(): ToolView[] {
    const out: ToolView[] = []
    const walk = (list: any[]): void => {
      for (const tool of list) {
        if (tool?.type === 'namespace' && Array.isArray(tool.tools)) walk(tool.tools)
        else if (tool && typeof tool === 'object') out.push(new ToolView(tool, list))
      }
    }
    if (Array.isArray(this.body.tools)) walk(this.body.tools)
    return out
  }

  tool(name: string): ToolView | undefined {
    return this.tools.find(tool => tool.name === name)
  }
}

/** 逐段改写工具定义里的说明文本：工具描述，以及参数 Schema 里各层的 description */
function transformToolText(body: any, apply: (s: string) => string): void {
  const walkSchema = (node: any): void => {
    if (Array.isArray(node)) node.forEach(walkSchema)
    else if (node && typeof node === 'object') {
      for (const key of Object.keys(node)) {
        if (key === 'description' && typeof node[key] === 'string') node[key] = apply(node[key])
        else walkSchema(node[key])
      }
    }
  }
  const walk = (list: any[]): void => {
    for (const tool of list) {
      if (!tool || typeof tool !== 'object') continue
      if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
        if (typeof tool.description === 'string') tool.description = apply(tool.description)
        walk(tool.tools)
        continue
      }
      const holder = tool.function && typeof tool.function === 'object' ? tool.function : tool.custom && typeof tool.custom === 'object' ? tool.custom : tool
      if (typeof holder.description === 'string') holder.description = apply(holder.description)
      walkSchema(holder.parameters ?? holder.input_schema)
    }
  }
  if (Array.isArray(body?.tools)) walk(body.tools)
}

// ── 执行环境 ─────────────────────────────────────────────
/** 一次请求（一次上游尝试）里所有包共用的状态 */
export interface PackRun {
  ctx: PackContext
  shape: BodyShape
  /** 请求级变量：各包各步骤共用，请求结束即丢弃 */
  vars: Record<string, any>
  /** 暴露给模板与脚本的只读请求信息 */
  info: Record<string, any>
}

export function createPackRun(ctx: PackContext): PackRun {
  const { meta } = ctx
  const shape = shapeOf(meta)
  return {
    ctx,
    shape,
    vars: Object.create(null),
    info: Object.freeze({
      model: meta.model, upstreamModel: ctx.upstreamModel ?? null, ua: ctx.ua ?? '', format: meta.entryFormat, shape, passthrough: meta.passthrough,
      channelId: meta.channelId, channelName: ctx.channelName ?? null, source: meta.source ?? 'owner', keyId: meta.keyId ?? null, keyName: ctx.keyName ?? null,
      stream: !!ctx.stream, headers: ctx.headers ?? {},
    }),
  }
}

type Runtime = TemplateRuntime & { view: RequestView }

const nodeRequire = createRequire(import.meta.url)

/** 给一个请求体建立模板 / 脚本的运行环境（宏取值 + 代码作用域） */
function buildRuntime(run: PackRun, params: Record<string, any>, body: any, logs: string[]): Runtime {
  const { ctx, vars } = run
  const view = new RequestView(body, run.shape)
  const last = (role?: string) => (): string => view.lastMessage(role)?.text ?? ''
  const values: Record<string, () => string> = {
    model: () => ctx.meta.model,
    upstreammodel: () => ctx.upstreamModel ?? '',
    ua: () => ctx.ua ?? '',
    useragent: () => ctx.ua ?? '',
    channel: () => ctx.channelName ?? '',
    channelid: () => String(ctx.meta.channelId),
    key: () => ctx.keyName ?? '',
    keyid: () => (ctx.meta.keyId == null ? '' : String(ctx.meta.keyId)),
    source: () => ctx.meta.source ?? 'owner',
    format: () => ctx.meta.entryFormat,
    system: () => view.system,
    lastmessage: last(),
    lastusermessage: last('user'),
    lastcharmessage: last('assistant'),
    lastassistantmessage: last('assistant'),
    firstusermessage: () => view.messages.find(message => message.role === 'user' && message.text)?.text ?? '',
    messagecount: () => String(view.messages.length),
  }
  const env: MacroEnv = {
    vars, params, values,
    seed: () => `${ctx.meta.model}\0${values.firstusermessage().slice(0, 4000)}`,
  }
  const log = (...args: any[]): void => {
    if (logs.length < MAX_LOG_LINES) logs.push(util.format(...args).slice(0, MAX_LOG_CHARS))
  }
  const add = (name: string, by: number): number => (vars[name] = (Number(vars[name]) || 0) + by)
  const runtime: Runtime = {
    env, view,
    scope: {
      body, req: view, vars, params, ctx: run.info,
      getvar: (name: string, fallback?: any) => vars[name] ?? fallback,
      setvar: (name: string, value: any): void => { vars[name] = value },
      incvar: (name: string, by = 1) => add(name, Number(by)),
      decvar: (name: string, by = 1) => add(name, -Number(by)),
      // 渲染一段模板文本（宏 + EJS）
      render: (template: unknown) => compileTemplate(String(template)).render(runtime),
      console: { log, info: log, warn: log, error: log, debug: log },
      log,
      require: nodeRequire,
      signal: ctx.signal,
      match: undefined,
    },
  }
  return runtime
}

function setMatch(runtime: Runtime, match: TemplateMatch | undefined): void {
  runtime.env.match = match
  runtime.scope.match = match ? Object.assign([...match.groups], { groups: match.named }) : undefined
  // $0 / $1 … 可直接在 EJS 代码里当变量用
  if (match) match.groups.forEach((value, index) => { runtime.scope[`$${index}`] = value })
}

/** 等待 work 完成，超时或请求被取消时拒绝；之后 work 的结果不再被使用 */
async function guarded<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`执行超过 ${STEP_TIMEOUT_MS / 1000} 秒`)), STEP_TIMEOUT_MS)
      if (!signal) return
      onAbort = () => reject(signal.reason)
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })])
  } finally {
    clearTimeout(timer)
    if (onAbort) signal!.removeEventListener('abort', onAbort)
  }
}

// ── 步骤 ─────────────────────────────────────────────────
/**
 * 步骤分两段：异步的准备（渲染模板、跑脚本，可能超时或出错）与同步的提交（把结果写进请求体）。
 * 准备阶段不改动请求体，出错或超时的步骤因此不会留下改了一半的结果。提交返回是否有改动。
 */
type Commit = () => boolean
const NOOP: Commit = () => false

/** 与 String.replace 的匹配语义一致，替换内容逐个匹配异步渲染 */
async function replaceAsync(text: string, re: RegExp, render: (match: TemplateMatch) => Promise<string>): Promise<string> {
  const found: { index: number; length: number; match: TemplateMatch }[] = []
  re.lastIndex = 0
  text.replace(re, (...args: any[]) => {
    const named = typeof args[args.length - 1] === 'object' ? args.pop() : undefined
    args.pop()
    const index = args.pop() as number
    found.push({ index, length: args[0].length, match: { groups: args, named } })
    return ''
  })
  if (!found.length) return text
  let out = ''
  let last = 0
  for (const item of found) {
    out += text.slice(last, item.index) + await render(item.match)
    last = item.index + item.length
  }
  return out + text.slice(last)
}

async function prepareRegex(step: RegexPackRegexStep, body: any, runtime: Runtime): Promise<Commit> {
  if (!step.pattern) return NOOP
  const targets = step.targets?.length ? step.targets : ['messages']
  if (step.action === 'remove_message') return () => removeMatchedMessages(body, step)
  const re = new RegExp(step.pattern, step.flags || 'g')
  const template = compileTemplate(step.replacement)
  const visit = (apply: (s: string) => string): void => {
    if (targets.includes('messages')) transformMessageText(body, step, apply)
    if (targets.includes('tools')) transformToolText(body, apply)
  }
  // 替换文本里没有宏、代码和捕获组引用：直接替换
  if (template.static !== null) {
    const value = template.static
    return () => {
      let changed = false
      visit((s) => {
        re.lastIndex = 0
        const out = s.replace(re, () => value)
        if (out !== s) changed = true
        return out
      })
      return changed
    }
  }
  const segments: string[] = []
  visit((s) => {
    segments.push(s)
    return s
  })
  const results: string[] = []
  let changed = false
  for (const segment of segments) {
    const out = await replaceAsync(segment, re, (match) => {
      setMatch(runtime, match)
      return template.render(runtime)
    })
    if (out !== segment) changed = true
    results.push(out)
  }
  if (!changed) return NOOP
  return () => {
    // 模板里的代码若改动了请求结构，文本段会对不上；此时放弃，避免把结果写到错误的位置
    let index = 0
    let aligned = true
    visit((s) => {
      if (s !== segments[index++]) aligned = false
      return s
    })
    if (!aligned || index !== segments.length) throw new Error('替换模板执行期间请求结构被改动，本步骤未生效')
    index = 0
    visit(() => results[index++])
    return true
  }
}

async function prepareInject(step: RegexPackInjectStep, runtime: Runtime): Promise<Commit> {
  if (!step.content) return NOOP
  const text = await compileTemplate(step.content).render(runtime)
  if (!text.trim()) return NOOP
  const view = runtime.view
  return () => {
    if (step.position === 'depth') view.insertAtDepth(step.depth ?? 0, step.role ?? 'system', text)
    else if (step.position === 'system_start') view.prependSystem(text)
    else view.appendSystem(text)
    return true
  }
}

/** 脚本在请求体的副本上运行，成功后才整体写回；失败或超时的脚本改不到真正的请求体 */
async function prepareScript(step: RegexPackScriptStep, body: any, run: PackRun, params: Record<string, any>, logs: string[]): Promise<Commit> {
  if (!step.code.trim()) return NOOP
  const work = structuredClone(body)
  await compileCode(step.code)(buildRuntime(run, params, work, logs).scope)
  return () => {
    if (isDeepStrictEqual(work, body)) return false
    for (const key of Object.keys(body)) delete body[key]
    Object.assign(body, work)
    return true
  }
}

function prepareStep(step: RegexPackStep, body: any, run: PackRun, params: Record<string, any>, logs: string[], runtime: Runtime): Promise<Commit> {
  if (step.type === 'regex') return prepareRegex(step, body, runtime)
  if (step.type === 'inject') return prepareInject(step, runtime)
  return prepareScript(step, body, run, params, logs)
}

const errorText = (error: unknown): string => (error instanceof Error ? `${error.name === 'Error' ? '' : `${error.name}: `}${error.message}` : String(error)).slice(0, MAX_ERROR_CHARS)

function packParams(pack: RegexPack): Record<string, any> {
  const params: Record<string, any> = Object.create(null)
  for (const param of pack.params ?? []) params[param.key] = param.value
  return params
}

/**
 * 这个包对本次请求不启用的原因；启用时返回 null。启用条件求值出错时抛出。
 * trial（试运行）时不检查渠道 / 调用来源 / Key，这些在试运行里没有对应的值。
 */
export async function packInactiveReason(run: PackRun, pack: RegexPack, body: any, trial = false): Promise<string | null> {
  const { meta, ua, signal } = run.ctx
  if (pack.formats?.length && !pack.formats.includes(meta.entryFormat)) return `入口格式 ${meta.entryFormat} 不在限定范围内`
  if (pack.models?.length && !pack.models.includes(meta.model)) return `模型 ${meta.model || '（空）'} 不在限定范围内`
  if (!trial && !ruleMatchesMeta(pack, meta)) return '渠道 / 调用来源 / Key 不在限定范围内'
  if (!uaMatches(pack.uaWhitelist, ua)) return ua ? `User-Agent「${ua}」不在白名单内` : '请求没有 User-Agent，而包设置了 UA 白名单'
  const source = pack.when?.source?.trim()
  if (!source) return null
  const runtime = buildRuntime(run, packParams(pack), body, [])
  if (pack.when!.mode === 'regex') {
    const re = new RegExp(pack.when!.source, (pack.when!.flags ?? '').replace(/[gy]/g, ''))
    return re.test(runtime.view.system) ? null : '系统提示词未命中启用条件的正则'
  }
  return (await guarded(compileCode(source, true)(runtime.scope), signal)) ? null : '启用条件表达式的结果为假'
}

/** 按顺序执行一个包的全部步骤；单个步骤出错只跳过该步，请求被取消时向上抛出 */
export async function executePack(run: PackRun, pack: RegexPack, body: any): Promise<PackTrace> {
  const { signal } = run.ctx
  const logs: string[] = []
  const params = packParams(pack)
  const steps: PackStepTrace[] = []
  const name = pack.name || '（未命名）'
  for (const [index, step] of (pack.steps ?? []).entries()) {
    if (!step.enabled) continue
    const started = performance.now()
    const entry: PackStepTrace = { name: step.name || `步骤 ${index + 1}`, type: step.type, status: 'unchanged' }
    try {
      const runtime = buildRuntime(run, params, body, logs)
      if (step.condition?.trim() && !(await guarded(compileCode(step.condition, true)(runtime.scope), signal))) entry.status = 'skipped'
      else if ((await guarded(prepareStep(step, body, run, params, logs, runtime), signal))()) entry.status = 'changed'
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      entry.status = 'error'
      entry.error = errorText(error)
      console.warn(`[agghub] 正则包「${name}」的「${entry.name}」已跳过: ${entry.error}`)
    }
    entry.ms = Math.round((performance.now() - started) * 10) / 10
    steps.push(entry)
  }
  return { pack: name, steps, ...(logs.length ? { logs } : {}) }
}

/**
 * 对发往上游的请求体依次执行所有启用且命中范围的正则包（在普通预处理规则之后调用），就地修改 body。
 * 返回命中的包的执行记录；没有包命中时为空数组。
 */
export async function applyRegexPacks(body: any, packs: RegexPack[], ctx: PackContext): Promise<PackTrace[]> {
  const run = createPackRun(ctx)
  const traces: PackTrace[] = []
  for (const pack of packs) {
    if (!pack.enabled) continue
    try {
      if (await packInactiveReason(run, pack, body)) continue
    } catch (error) {
      if (ctx.signal?.aborted) throw ctx.signal.reason
      const message = errorText(error)
      console.warn(`[agghub] 正则包「${pack.name}」的启用条件求值出错，本次未启用: ${message}`)
      traces.push({ pack: pack.name || '（未命名）', error: message, steps: [] })
      continue
    }
    traces.push(await executePack(run, pack, body))
  }
  return traces
}
