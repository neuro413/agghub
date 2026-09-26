import type { StreamEncoder } from './ir'

type Tool = { index: number; id: string; name: string; kind: 'function' | 'custom'; args: string }
type Segment = { tool: Tool } | { delta: any }

/** Anthropic 的块不能交错写入：首个工具之后按首次出现顺序有界排队，终态后串行输出。 */
export function serialToolBlocks(encoder: StreamEncoder): StreamEncoder {
  const tools = new Map<number, Tool>()
  const queue: Segment[] = []
  let ended = false
  let shell: any = {}
  const wrap = (delta: any): any => ({ ...shell, choices: [{ ...(shell.choices?.[0] || {}), delta, finish_reason: null }] })
  return {
    encode(chunk) {
      if (ended) return ''
      shell = chunk
      const delta = chunk.choices?.[0]?.delta || {}
      const { tool_calls, ...text } = delta
      let out = ''
      if (!queue.length) out += encoder.encode({ ...chunk, choices: [{ ...(chunk.choices?.[0] || {}), delta: text }] })
      else {
        // usage/finish 等元信息不改变块顺序；后续可见文本等待前面的工具完成。
        out += encoder.encode({ ...chunk, choices: [{ ...(chunk.choices?.[0] || {}), delta: {} }] })
        if (Object.keys(text).length) queue.push({ delta: text })
      }
      for (const call of Array.isArray(tool_calls) ? tool_calls : []) {
        if (!call) continue
        const index = call.index ?? 0
        if (!Number.isSafeInteger(index) || index < 0) throw new Error('工具调用 index 无效')
        let tool = tools.get(index)
        const kind = call.type === 'custom' || call.custom ? 'custom' : 'function'
        if (!tool) {
          tool = { index, id: '', name: '', kind, args: '' }
          tools.set(index, tool)
          queue.push({ tool })
        } else if ((call.type || call.custom) && kind !== tool.kind) throw new Error('同一工具调用的类型发生变化')
        const name = call.function?.name || call.custom?.name
        if (call.id && tool.id && call.id !== tool.id) throw new Error('同一工具调用的 ID 发生变化')
        if (name && tool.name && name !== tool.name) throw new Error('同一工具调用的名称发生变化')
        if (call.id && !tool.id) tool.id = call.id
        if (name && !tool.name) tool.name = name
        const args = tool.kind === 'custom' ? call.custom?.input : call.function?.arguments
        if (typeof args === 'string') tool.args += args
      }
      return out
    },
    finalize() {
      if (ended) return ''
      // 先验证全部工具，错误时不对外补发任何成功块。
      for (const tool of tools.values()) {
        if (!tool.id || !tool.name) throw new Error('上游工具调用缺少 ID 或名称')
        if (tool.kind === 'function') {
          try { JSON.parse(tool.args || '{}') } catch { throw new Error('上游工具调用参数 JSON 不完整') }
        }
      }
      let out = ''
      for (const segment of queue) {
        if ('delta' in segment) out += encoder.encode(wrap(segment.delta))
        else {
          const tool = segment.tool
          out += encoder.encode(wrap({ tool_calls: [{
            index: tool.index, id: tool.id, type: 'function',
            function: { name: tool.name, arguments: tool.kind === 'custom' ? JSON.stringify({ input: tool.args }) : tool.args || '{}' },
          }] }))
        }
      }
      out += encoder.finalize()
      ended = true
      return out
    },
    fail(message) {
      if (ended) return ''
      ended = true
      return encoder.fail(message)
    },
  }
}
