import type { SingleRoleMode, WireFormat } from '../types'

/**
 * 单 role 渠道兼容：把上游请求体里的对话历史按原顺序打包成一段 JSON 文本，供只认单条消息的上游使用。
 *  - user 模式：系统提示保持原样，其余消息打包为唯一一条 user 消息；
 *    合并 system 时系统提示作为首项一起打包，原系统提示置空
 *  - system 模式：系统提示与全部消息一起打包进系统提示，随后跟一条内容为 "\n\u200B" 的 user 消息；
 *    最后 user 除外时，最后一条 user 消息不参与打包，原样作为随后的那条 user 消息（没有时仍用填充内容）
 *
 * 在 adaptor 构造完上游请求之后执行，因此同格式直通与跨格式转换都作用于上游格式的消息数组。
 * 系统提示指顶层字段（system / systemInstruction / instructions）及消息数组开头连续的 system / developer 项；
 * 对话中途的 system 项视为普通消息原位打包。
 * 工具结果（tool_result / functionResponse）不算 user 消息：单独留在消息数组里会缺少对应的工具调用而被上游拒绝。
 */

export const SINGLE_ROLE_FILLER = '\n\u200B'

interface Conversation {
  /** 顶层系统提示字段，转成 { role: 'system' } 项 */
  system: any[]
  /** 消息数组开头连续的 system / developer 项 */
  inline: any[]
  messages: any[]
}

interface Codec {
  /** 没有消息数组时返回 null，不做处理 */
  read(body: any): Conversation | null
  /** system：undefined = 保持原样，null = 删除，字符串 = 改写为该文本 */
  write(body: any, system: string | null | undefined, messages: any[]): void
  user(text: string): any
  /** 可以单独留作 user 消息的普通 user 项 */
  isUser(item: any): boolean
}

export interface SingleRoleOptions {
  /** user 模式：系统提示一起打包进 user 消息 */
  mergeSystem?: boolean
  /** system 模式：最后一条 user 消息不打包，原样作为随后的 user 消息 */
  excludeLastUser?: boolean
}

const isEmpty = (value: any): boolean => value == null || value === '' || (Array.isArray(value) && !value.length)
const isSystemItem = (item: any): boolean => item?.role === 'system' || item?.role === 'developer'

function findLastIndex(items: any[], predicate: (item: any) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i])) return i
  return -1
}

function splitLeading(items: any[]): { inline: any[]; messages: any[] } {
  let count = 0
  while (count < items.length && isSystemItem(items[count])) count++
  return { inline: items.slice(0, count), messages: items.slice(count) }
}

const CODECS: Record<WireFormat, Codec> = {
  openai: {
    read: body => Array.isArray(body.messages) ? { system: [], ...splitLeading(body.messages) } : null,
    write(body, system, messages) {
      body.messages = typeof system === 'string' ? [{ role: 'system', content: system }, ...messages] : messages
    },
    user: text => ({ role: 'user', content: text }),
    isUser: item => item?.role === 'user',
  },
  anthropic: {
    read: body => Array.isArray(body.messages)
      ? { system: isEmpty(body.system) ? [] : [{ role: 'system', content: body.system }], inline: [], messages: body.messages }
      : null,
    write(body, system, messages) {
      if (system === null) delete body.system
      else if (system !== undefined) body.system = system
      body.messages = messages
    },
    user: text => ({ role: 'user', content: text }),
    isUser: item => item?.role === 'user' && !(Array.isArray(item.content) && item.content.some((block: any) => block?.type === 'tool_result')),
  },
  gemini: {
    read: body => Array.isArray(body.contents)
      ? { system: isEmpty(body.systemInstruction?.parts) ? [] : [{ role: 'system', parts: body.systemInstruction.parts }], inline: [], messages: body.contents }
      : null,
    write(body, system, messages) {
      if (system === null) delete body.systemInstruction
      else if (system !== undefined) body.systemInstruction = { parts: [{ text: system }] }
      body.contents = messages
    },
    user: text => ({ role: 'user', parts: [{ text }] }),
    isUser: item => item?.role === 'user' && !(Array.isArray(item.parts) && item.parts.some((part: any) => part?.functionResponse)),
  },
  responses: {
    read(body) {
      const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input
      if (!Array.isArray(input)) return null
      return { system: isEmpty(body.instructions) ? [] : [{ role: 'system', content: body.instructions }], ...splitLeading(input) }
    },
    write(body, system, messages) {
      if (system === null) delete body.instructions
      else if (system !== undefined) body.instructions = system
      body.input = messages
    },
    user: text => ({ type: 'message', role: 'user', content: text }),
    isUser: item => item?.role === 'user',
  },
}

/** 就地改写已解析的上游请求体；没有可打包的消息时不改动并返回 false */
export function applySingleRole(body: any, wire: WireFormat, mode: SingleRoleMode, options: SingleRoleOptions = {}): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const codec = CODECS[wire]
  const conversation = codec.read(body)
  if (!conversation) return false
  const system = [...conversation.system, ...conversation.inline]
  if (mode === 'system') {
    const all = [...system, ...conversation.messages]
    const last = options.excludeLastUser ? findLastIndex(all, codec.isUser) : -1
    const user = last >= 0 ? all.splice(last, 1)[0] : codec.user(SINGLE_ROLE_FILLER)
    if (!all.length) return false
    codec.write(body, JSON.stringify(all), [user])
  } else if (options.mergeSystem) {
    const all = [...system, ...conversation.messages]
    if (!all.length) return false
    codec.write(body, null, [codec.user(JSON.stringify(all))])
  } else {
    if (!conversation.messages.length) return false
    codec.write(body, undefined, [...conversation.inline, codec.user(JSON.stringify(conversation.messages))])
  }
  return true
}
