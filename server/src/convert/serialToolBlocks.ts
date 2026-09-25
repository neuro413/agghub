import type { StreamEncoder } from './ir'
import { BufferBudget } from '../core/capture'

type Tool = { index: number; id: string; name: string; kind: 'function' | 'custom'; args: string }
type Segment = { tool: Tool } | { delta: any }

/** Anthropic 的块不能交错写入：首个工具之后按首次出现顺序有界排队，终态后串行输出。 */
export function serialToolBlocks(encoder: StreamEncoder, budget = new BufferBudget(16 * 1024 * 1024)): StreamEncoder {
  const tools = new Map<number, Tool>()
  const queue: Segment[] = []
  const key = Symbol('anthropic-tool-queue')
  let bytes = 0
  let ended = false
  let shell: any = {}
  const reserve = (amount: number) => { budget.hold(key, bytes + amount); bytes += amount }
  const clear = () => { queue.length = 0; tools.clear(); bytes = 0; budget.release(key) }
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
        if (Object.keys(text).length) {
          reserve(Buffer.byteLength(JSON.stringify(text)) + 64)
          queue.push({ delta: structuredClone(text) })
        }
      }
      for (const call of Array.isArray(tool_calls) ? tool_calls : []) {
        if (!call) continue
        const index = call.index ?? 0
        if (!Number.isSafeInteger(index) || index < 0) throw new Error('工具调用 index 无效')
        let tool = tools.get(index)
        const kind = call.type === 'custom' || call.custom ? 'custom' : 'function'
        if (!tool) {
          reserve(128)
          tool = { index, id: '', name: '', kind, args: '' }
          tools.set(index, tool)
          queue.push({ tool })
        } else if ((call.type || call.custom) && kind !== tool.kind) throw new Error('同一工具调用的类型发生变化')
        const name = call.function?.name || call.custom?.name
        if (call.id && tool.id && call.id !== tool.id) throw new Error('同一工具调用的 ID 发生变化')
        if (name && tool.name && name !== tool.name) throw new Error('同一工具调用的名称发生变化')
        if (call.id && !tool.id) { reserve(Buffer.byteLength(call.id)); tool.id = call.id }
        if (name && !tool.name) { reserve(Buffer.byteLength(name)); tool.name = name }
        const args = tool.kind === 'custom' ? call.custom?.input : call.function?.arguments
        if (typeof args === 'string') { reserve(Buffer.byteLength(args)); tool.args += args }
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
      clear()
      return out
    },
    fail(message) {
      if (ended) return ''
      ended = true
      clear()
      return encoder.fail(message)
    },
    dispose() { ended = true; clear(); encoder.dispose?.() },
  }
}
