import crypto from 'node:crypto'

/**
 * 正则包用的模板引擎：类酒馆宏 `{{…}}` + EJS `<% … %>` + 正则捕获组 `$1`。
 *
 * 安全约束：只有模板源码本身会被解析。宏的返回值、捕获组内容、EJS 的输出都直接拼进结果，
 * 不会再扫描一遍，所以请求里出现的 `{{…}}` / `<% … %>` 永远只是普通文本，不会被执行。
 */

/** 当前正则匹配，只在正则步骤的替换模板里存在 */
export interface TemplateMatch {
  /** groups[0] 为整个匹配，groups[n] 为第 n 个捕获组（未参与匹配为 undefined） */
  groups: (string | undefined)[]
  named?: Record<string, string | undefined>
}

/** 宏求值所需的环境 */
export interface MacroEnv {
  /** 请求级变量，同一次请求里各包各步骤共用 */
  vars: Record<string, any>
  /** 当前包的参数 */
  params: Record<string, any>
  /** 请求相关的只读宏（键为小写宏名），惰性求值 */
  values: Record<string, () => string>
  /** {{pick}} 的种子：同一段对话里保持不变，保证多轮请求选出同一项 */
  seed: () => string
  match?: TemplateMatch
}

export interface TemplateRuntime {
  env: MacroEnv
  /** EJS 代码的作用域（with 语句展开），即脚本 API */
  scope: Record<string, any>
}

export interface CompiledTemplate {
  /** 不含宏 / EJS / 捕获组引用时为模板原文，可直接使用，无须渲染 */
  readonly static: string | null
  render(runtime: TemplateRuntime): Promise<string>
}

// ── 字面量段：文本 + 宏 + 捕获组引用 ─────────────────────
type Node =
  | string
  | { kind: 'macro'; raw: string; parts: Node[][] }
  | { kind: 'group'; raw: string; ref: number | string }

/** 从 start（指向 `{{` 之后）起找到配对的 `}}`，返回其下标；找不到返回 -1 */
function findMacroEnd(text: string, start: number): number {
  let depth = 1
  for (let i = start; i < text.length - 1; i++) {
    if (text[i] === '{' && text[i + 1] === '{') { depth++; i++ } else if (text[i] === '}' && text[i + 1] === '}') {
      if (--depth === 0) return i
      i++
    }
  }
  return -1
}

/** 把宏的内部文本按顶层的 `::` 拆成若干段（嵌套宏内部的 `::` 不拆） */
function splitArgs(inner: string): string[] {
  const out: string[] = []
  let depth = 0
  let last = 0
  for (let i = 0; i < inner.length - 1; i++) {
    const pair = inner[i] + inner[i + 1]
    if (pair === '{{') { depth++; i++ } else if (pair === '}}') { depth = Math.max(0, depth - 1); i++ } else if (pair === '::' && depth === 0) {
      out.push(inner.slice(last, i))
      last = i + 2
      i++
    }
  }
  out.push(inner.slice(last))
  return out
}

const GROUP_REF = /^\$(\$|&|\d{1,2}|<[A-Za-z_$][\w$]*>)/

function parseLiteral(text: string): Node[] {
  const nodes: Node[] = []
  let buf = ''
  const flush = () => { if (buf) { nodes.push(buf); buf = '' } }
  for (let i = 0; i < text.length;) {
    if (text[i] === '{' && text[i + 1] === '{') {
      const end = findMacroEnd(text, i + 2)
      if (end >= 0) {
        flush()
        const inner = text.slice(i + 2, end)
        // 注释里的内容不解析，避免注释掉的宏仍被求值
        const parts = /^\s*\/\//.test(inner) ? [[inner]] : splitArgs(inner).map(parseLiteral)
        nodes.push({ kind: 'macro', raw: text.slice(i, end + 2), parts })
        i = end + 2
        continue
      }
    } else if (text[i] === '$') {
      const m = GROUP_REF.exec(text.slice(i, i + 64))
      if (m) {
        flush()
        const token = m[1]
        nodes.push({ kind: 'group', raw: m[0], ref: token === '$' ? '$' : token === '&' ? 0 : token[0] === '<' ? token.slice(1, -1) : Number(token) })
        i += m[0].length
        continue
      }
    }
    buf += text[i++]
  }
  flush()
  return nodes
}

export function stringify(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    try { return JSON.stringify(value) } catch { return String(value) }
  }
  return String(value)
}

function evalNodes(nodes: Node[], env: MacroEnv, trim: string): string {
  let out = ''
  for (const node of nodes) {
    if (typeof node === 'string') out += node
    else if (node.kind === 'group') out += evalGroup(node, env.match)
    else out += evalMacro(node, env, trim)
  }
  return out
}

function evalGroup(node: { raw: string; ref: number | string }, match: TemplateMatch | undefined): string {
  // 不在正则替换里：`$1` 只是普通文本
  if (!match) return node.raw
  if (node.ref === '$') return '$'
  if (typeof node.ref === 'string') return match.named && node.ref in match.named ? match.named[node.ref] ?? '' : node.raw
  // 与 String.replace 一致：引用了不存在的捕获组时保留原文
  return node.ref < match.groups.length ? match.groups[node.ref] ?? '' : node.raw
}

const isNumeric = (value: unknown): boolean => value !== '' && value != null && Number.isFinite(Number(value))

const pad = (n: number): string => String(n).padStart(2, '0')

function roll(spec: string): string {
  const m = /^\s*(\d*)\s*d?\s*(\d+)\s*([+-]\s*\d+)?\s*$/i.exec(spec)
  if (!m) return ''
  const count = Math.min(Number(m[1] || 1), 1000)
  const sides = Number(m[2])
  if (!sides) return ''
  let total = Number((m[3] || '0').replace(/\s/g, ''))
  for (let i = 0; i < count; i++) total += crypto.randomInt(sides) + 1
  return String(total)
}

/** 列表类宏的选项：`{{random::a::b}}` 用 `::` 分隔；旧写法 `{{random:a,b}}` 用逗号分隔 */
function listOf(args: string[], legacy: boolean): string[] {
  return legacy ? (args[0] ?? '').split(',').map(item => item.trim()) : args
}

function evalMacro(node: { raw: string; parts: Node[][] }, env: MacroEnv, trim: string): string {
  const head = evalNodes(node.parts[0], env, trim).trim()
  if (head.startsWith('//')) return ''
  let name = head
  let args = node.parts.slice(1).map(part => evalNodes(part, env, trim))
  // 单冒号旧写法：{{random:a,b}} / {{roll:d6}}
  let legacy = false
  const colon = head.indexOf(':')
  if (colon > 0 && !args.length) {
    name = head.slice(0, colon)
    args = [head.slice(colon + 1)]
    legacy = true
  }
  const key = name.toLowerCase()
  const vars = env.vars
  const varName = (args[0] ?? '').trim()
  switch (key) {
    case 'noop': return ''
    case 'newline': return '\n'
    case 'trim': return trim
    case 'setvar': vars[varName] = args.slice(1).join('::'); return ''
    case 'getvar': return stringify(vars[varName])
    case 'addvar': {
      const add = args.slice(1).join('::')
      const current = vars[varName]
      vars[varName] = isNumeric(current ?? 0) && isNumeric(add) ? Number(current ?? 0) + Number(add) : stringify(current) + add
      return ''
    }
    case 'incvar': case 'decvar': {
      vars[varName] = (Number(vars[varName]) || 0) + (key === 'incvar' ? 1 : -1)
      return String(vars[varName])
    }
    case 'param': return stringify(env.params[varName])
    case 'random': {
      const list = listOf(args, legacy)
      return list.length ? list[crypto.randomInt(list.length)] : ''
    }
    case 'pick': {
      const list = listOf(args, legacy)
      if (!list.length) return ''
      const hash = crypto.createHash('sha256').update(env.seed()).update('\0').update(node.raw).digest()
      return list[hash.readUInt32BE(0) % list.length]
    }
    case 'roll': return roll(args[0] ?? '')
    case 'time': return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date())
    case 'date': return new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date())
    case 'weekday': return new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(new Date())
    case 'isotime': { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
    case 'isodate': { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
    case 'match': return env.match ? env.match.groups[0] ?? '' : node.raw
    case 'group': {
      if (!env.match) return node.raw
      const ref = varName
      return (/^\d+$/.test(ref) ? env.match.groups[Number(ref)] : env.match.named?.[ref]) ?? ''
    }
  }
  // {{time_UTC+8}}：指定时区偏移的时间
  const utc = /^time_utc([+-]\d{1,2})$/.exec(key)
  if (utc) {
    const d = new Date(Date.now() + Number(utc[1]) * 3_600_000)
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  }
  if (!legacy && Object.hasOwn(env.values, key)) return env.values[key]()
  // 包参数可直接用 {{参数名}} 读取
  if (!legacy && !args.length && Object.hasOwn(env.params, name)) return stringify(env.params[name])
  // 未知宏原样保留
  return node.raw
}

// ── EJS ──────────────────────────────────────────────────
const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (...args: any[]) => Promise<any>

type Chunk = { literal: Node[] } | { code: string } | { output: string }

function parseTemplate(source: string): Chunk[] {
  const chunks: Chunk[] = []
  let text = ''
  let slurpNext: 'newline' | 'space' | null = null
  const pushText = () => {
    if (slurpNext === 'newline') text = text.replace(/^[ \t]*\r?\n/, '')
    else if (slurpNext === 'space') text = text.replace(/^\s+/, '')
    slurpNext = null
    if (text) chunks.push({ literal: parseLiteral(text) })
    text = ''
  }
  for (let i = 0; i < source.length;) {
    const open = source.indexOf('<%', i)
    if (open < 0) { text += source.slice(i); break }
    text += source.slice(i, open)
    // <%% 输出字面量 <%
    if (source[open + 2] === '%') { text += '<%'; i = open + 3; continue }
    const close = source.indexOf('%>', open + 2)
    if (close < 0) throw new SyntaxError('EJS 标签未闭合：缺少 %>')
    let body = source.slice(open + 2, close)
    const mark = body[0]
    if (mark === '_') text = text.replace(/[ \t]+$/, '')
    if (mark === '_' || mark === '=' || mark === '-' || mark === '#') body = body.slice(1)
    const tail = body.at(-1)
    if (tail === '-' || tail === '_') body = body.slice(0, -1)
    pushText()
    slurpNext = tail === '-' ? 'newline' : tail === '_' ? 'space' : null
    if (mark === '=' || mark === '-') chunks.push({ output: body })
    else if (mark !== '#') chunks.push({ code: body })
    i = close + 2
  }
  pushText()
  return chunks
}

const cache = new Map<string, CompiledTemplate>()
const CACHE_MAX = 500

/** 编译模板；语法错误（EJS 未闭合、JS 语法错误）在这里抛出 */
export function compileTemplate(source: string): CompiledTemplate {
  const hit = cache.get(source)
  if (hit) return hit
  const chunks = parseTemplate(source)
  const literals: Node[][] = []
  let compiled: CompiledTemplate
  if (chunks.every(chunk => 'literal' in chunk && chunk.literal.every(node => typeof node === 'string'))) {
    const value = chunks.map(chunk => ('literal' in chunk ? chunk.literal.join('') : '')).join('')
    compiled = { static: value, render: async () => value }
  } else {
    // 每次渲染单独的占位符，{{trim}} 在最后统一处理
    const body = chunks.map((chunk) => {
      if ('literal' in chunk) return `__o += __lit(${literals.push(chunk.literal) - 1});`
      if ('output' in chunk) return `__o += __str(await (${chunk.output}\n));`
      return `${chunk.code}\n`
    }).join('\n')
    const hasCode = chunks.some(chunk => !('literal' in chunk))
    const fn = hasCode
      ? new AsyncFunction('__scope', '__lit', '__str', `with (__scope) { let __o = ''; const print = (...__a) => { __o += __a.map(__str).join('') }; const echo = print;\n${body}\nreturn __o }`)
      : null
    compiled = {
      static: null,
      async render(runtime) {
        const trim = `${crypto.randomBytes(6).toString('hex')}`
        const lit = (index: number): string => evalNodes(literals[index], runtime.env, trim)
        const out = fn ? await fn(runtime.scope, lit, stringify) : literals.map((_, index) => lit(index)).join('')
        return out.includes(trim) ? out.replace(new RegExp(`(?:[ \\t]*\\r?\\n)*${trim}(?:[ \\t]*\\r?\\n)*`, 'g'), '') : out
      },
    }
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
  cache.set(source, compiled)
  return compiled
}

const codeCache = new Map<string, (scope: Record<string, any>) => Promise<any>>()

/** 编译一段异步 JS（脚本步骤，或 asExpression 时的条件表达式）；作用域对象用 with 展开 */
export function compileCode(code: string, asExpression = false): (scope: Record<string, any>) => Promise<any> {
  const key = (asExpression ? 'e:' : 's:') + code
  let fn = codeCache.get(key)
  if (!fn) {
    fn = new AsyncFunction('__scope', asExpression ? `with (__scope) { return (${code}\n) }` : `with (__scope) {\n${code}\n}`)
    if (codeCache.size >= CACHE_MAX) codeCache.delete(codeCache.keys().next().value!)
    codeCache.set(key, fn)
  }
  return fn
}
