import { createHash } from 'node:crypto'
import YAML from 'yaml'
import { decodeB64, parseProxyUri } from './uri'
import type { ParsedNode } from './types'

export const SUPPORTED_TYPES = new Set([
  'ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'tuic', 'anytls',
  'socks5', 'http', 'wireguard', 'snell', 'mieru', 'ssh',
])

const PLACEHOLDER_SERVERS = new Set(['', '127.0.0.1', '0.0.0.0', 'localhost', '::1'])

/** key 递归排序后的 JSON，用于 identity */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export function nodeIdentity(config: Record<string, unknown>): string {
  return createHash('sha1').update(stableStringify(config)).digest('hex')
}

function makeNode(name: string, config: Record<string, unknown>, raw: string | null): ParsedNode | null {
  const type = String(config.type ?? '').toLowerCase()
  if (!SUPPORTED_TYPES.has(type)) return null
  config.type = type
  const server = String(config.server ?? '').trim().toLowerCase()
  if (PLACEHOLDER_SERVERS.has(server)) return null
  const finalName = name.trim() || `${config.server}:${config.port}`
  return { name: finalName.slice(0, 200), type, config, raw, identity: nodeIdentity(config) }
}

/** Clash 风格对象（含 name / type） */
function fromClashObject(item: unknown): ParsedNode | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const { name, ...config } = item as Record<string, unknown>
  return makeNode(typeof name === 'string' ? name : String(name ?? ''), config, null)
}

/** SIP008 服务器项 */
function fromSip008(item: unknown): ParsedNode | null {
  if (!item || typeof item !== 'object') return null
  const s = item as Record<string, unknown>
  const config: Record<string, unknown> = {
    type: 'ss',
    server: s.server,
    port: Number(s.server_port),
    cipher: s.method,
    password: s.password,
  }
  if (typeof s.plugin === 'string' && s.plugin) {
    config.plugin = s.plugin === 'obfs-local' || s.plugin === 'simple-obfs' ? 'obfs' : s.plugin
    if (typeof s.plugin_opts === 'string' && s.plugin_opts) {
      const opts: Record<string, string> = {}
      for (const seg of s.plugin_opts.split(';')) {
        const idx = seg.indexOf('=')
        if (idx > 0) opts[seg.slice(0, idx).trim().replace(/^obfs$/, 'mode').replace(/^obfs-host$/, 'host')] = seg.slice(idx + 1).trim()
      }
      config['plugin-opts'] = opts
    }
  }
  if (!Number.isInteger(config.port)) return null
  return makeNode(typeof s.remarks === 'string' ? s.remarks : '', config, null)
}

function collect(list: unknown[], fn: (item: unknown) => ParsedNode | null): ParsedNode[] {
  const out: ParsedNode[] = []
  for (const item of list) {
    const node = fn(item)
    if (node) out.push(node)
  }
  return out
}

function parseYaml(text: string): ParsedNode[] | null {
  if (!/^proxies\s*:/m.test(text)) return null
  try {
    const doc = YAML.parse(text, { maxAliasCount: 1000, uniqueKeys: false })
    if (!doc || !Array.isArray(doc.proxies)) return null
    return collect(doc.proxies, fromClashObject)
  } catch {
    return null
  }
}

function parseJson(text: string): ParsedNode[] | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  let doc: unknown
  try { doc = JSON.parse(trimmed) } catch { return null }
  if (Array.isArray(doc)) return collect(doc, fromClashObject)
  if (doc && typeof doc === 'object') {
    const obj = doc as Record<string, unknown>
    if (Array.isArray(obj.servers)) return collect(obj.servers, fromSip008)
    if (Array.isArray(obj.proxies)) return collect(obj.proxies, fromClashObject)
    if (typeof obj.type === 'string') return collect([obj], fromClashObject)
  }
  return null
}

function parseLines(text: string, errors: string[]): ParsedNode[] {
  const nodes: ParsedNode[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('//')) continue
    const parsed = parseProxyUri(line)
    const node = parsed ? makeNode(parsed.name, parsed.config, line) : null
    if (node) nodes.push(node)
    else if (!parsed && errors.length < 20) errors.push(line.length > 80 ? `${line.slice(0, 80)}…` : line)
  }
  return nodes
}

/** 整段 base64 订阅：解码后像节点链接或 Clash YAML 才采用 */
function tryDecodeWhole(text: string): string | null {
  if (!/^[A-Za-z0-9+/=_\-\s]+$/.test(text)) return null
  const decoded = decodeB64(text)
  if (!decoded) return null
  if (/^proxies\s*:/m.test(decoded) || /^[a-z0-9]+:\/\//im.test(decoded)) return decoded
  return null
}

/** 任意订阅文本 → 节点列表（base64 / Clash YAML / SIP008 JSON / 逐行 URI），结果已按 identity 去重 */
export function parseSubscriptionText(input: string): { nodes: ParsedNode[]; errors: string[] } {
  // trim 会顺带去掉 BOM
  let text = input.trim()
  const errors: string[] = []
  if (!text) return { nodes: [], errors }
  const decoded = tryDecodeWhole(text)
  if (decoded) text = decoded.trim()
  const nodes = parseYaml(text) ?? parseJson(text) ?? parseLines(text, errors)
  const seen = new Set<string>()
  const unique = nodes.filter(n => (seen.has(n.identity) ? false : (seen.add(n.identity), true)))
  return { nodes: unique, errors }
}
