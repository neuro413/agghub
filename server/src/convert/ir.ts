import crypto from 'node:crypto'
import type { IRUsage } from '../types'
import { emptyUsage as _emptyUsage } from './usage'

/** OpenAI 对 safety_identifier / prompt_cache_key 的官方长度上限 */
export const MAX_IDENTIFIER_LEN = 64

/**
 * 把任意用户标识压成可安全传给 OpenAI 的稳定标识。
 * 长度不超过 64 的原样返回；超过则取 sha256 十六进制（恰好 64 字符），
 * 同一输入始终得到同一输出，缓存分桶语义不变。
 */
export function hashIdentifier(raw: unknown): string {
  const s = String(raw)
  if (s.length <= MAX_IDENTIFIER_LEN) return s
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex')
}

export function genId(prefix = 'chatcmpl'): string {
  const r = Math.random().toString(36).slice(2, 14)
  return `${prefix}-${r}`
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

export function emptyUsage(): IRUsage {
  return _emptyUsage()
}

/** 把 OpenAI 消息 content（string | parts[]）提取为纯文本 */
export function contentToText(content: any): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p
        if (p && p.type === 'text') return p.text || ''
        return ''
      })
      .join('')
  }
  return ''
}

/** IR 里的文件部件：{ type:'file', file:{ file_data | file_url | file_id, filename?, media_type? } } */
export interface IRFilePart {
  file_data?: string
  file_url?: string
  file_id?: string
  filename?: string
  media_type?: string
}

/** 把 OpenAI content 拆成 {text, images[], files[]}（images 为 data URL 或 http URL）*/
export function splitContent(content: any): { text: string; images: string[]; files: IRFilePart[] } {
  if (content == null) return { text: '', images: [], files: [] }
  if (typeof content === 'string') return { text: content, images: [], files: [] }
  const images: string[] = []
  const files: IRFilePart[] = []
  let text = ''
  if (Array.isArray(content)) {
    for (const p of content) {
      if (typeof p === 'string') text += p
      else if (p?.type === 'text') text += p.text || ''
      else if (p?.type === 'image_url') {
        const u = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url
        if (u) images.push(u)
      } else if (p?.type === 'file' && p.file && typeof p.file === 'object') {
        files.push(p.file)
      }
    }
  }
  return { text, images, files }
}

/** 从 data URL 里解析 media_type 与 base64 数据；不是 data URL 返回 null */
export function parseDataUrl(u: string): { media_type: string; data: string } | null {
  const m = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s.exec(u)
  if (!m) return null
  return { media_type: m[1], data: m[2] }
}

/** 粗略估算 prompt tokens（约 4 字符/token），仅用于流式首包 usage 占位 */
export function estimatePromptTokens(ir: any): number {
  let chars = 0
  for (const m of ir?.messages || []) {
    chars += contentToText(m.content).length
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        chars += (tc.function?.name || '').length + (tc.function?.arguments || '').length
      }
    }
  }
  return chars > 0 ? Math.ceil(chars / 4) : 0
}

/** 逐行读取 SSE 流（Web ReadableStream）*/
export async function* parseSSELines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        yield buffer.slice(0, idx).replace(/\r$/, '')
        buffer = buffer.slice(idx + 1)
      }
    }
    buffer += decoder.decode()
    if (buffer) yield buffer.replace(/\r$/, '')
  } finally {
    reader.releaseLock()
  }
}

/** 标准 SSE 事件解析：累积 event:/data: 行，空行作为一个事件边界；onLine 可旁路收集原始行（含注释 / id 等非事件行）*/
export async function* parseSSEEvents(
  body: ReadableStream<Uint8Array>,
  onLine?: (line: string) => void,
): AsyncGenerator<{ event: string | null; data: string }> {
  let ev: string | null = null
  let dataLines: string[] = []
  for await (const line of parseSSELines(body)) {
    onLine?.(line)
    if (line === '') {
      if (dataLines.length) {
        yield { event: ev, data: dataLines.join('\n') }
      }
      ev = null
      dataLines = []
      continue
    }
    if (line.startsWith('event:')) ev = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
  }
  if (dataLines.length) yield { event: ev, data: dataLines.join('\n') }
}

export type StreamDecoder = {
  /** 喂入一个上游 SSE 事件，产出 0+ 个 IR(OpenAI) chunk */
  push(ev: { event: string | null; data: string }): any[]
  /** 流结束时补发（如最后的 usage chunk）*/
  flush(): any[]
}

export type StreamEncoder = {
  /** 把一个 IR(OpenAI) chunk 编码为入口 wire 的 SSE 文本 */
  encode(chunk: any): string
  /** 流结束标记 */
  finalize(): string
  /** 流中途失败：发协议原生的终态错误事件（不再伪装成正常结束）*/
  fail(message: string): string
}
