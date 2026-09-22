import type { StreamDecoder, StreamEncoder } from './ir'
import { usageFromOpenAI } from './usage'

// OpenAI 既是 IR 枢纽：作为入口/上游都近乎透传，仅做 model 名替换与字段清理。

/** 上游 usage 归一化：各家兼容实现的缓存字段（cached_tokens / cache_write_tokens / DeepSeek / 网关附加的 Claude 字段）统一到 IR 约定 */
function normalizeUsage(json: any): any {
  if (json && typeof json === 'object' && json.usage && typeof json.usage === 'object') {
    return { ...json, usage: usageFromOpenAI(json.usage) }
  }
  return json
}

// ── 作为上游渠道（IR → OpenAI 请求 / OpenAI 响应 → IR）──
export function buildRequest(ir: any, upstreamModel: string): any {
  const out: any = { ...ir, model: upstreamModel }
  // Anthropic 入口带来的 Claude 特有参数，OpenAI 官方 API 收到未知字段会报 400
  delete out.top_k
  // IR 扩展字段：Chat 上游没有对应物
  delete out.custom_tool_names
  delete out.hosted_tools
  if (out.reasoning && typeof out.reasoning === 'object') {
    const effort = out.reasoning.effort
    if (effort && effort !== 'none' && out.reasoning_effort == null) out.reasoning_effort = effort
    delete out.reasoning
  }
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((m: any) => {
      if (!m || typeof m !== 'object') return m
      const { reasoning_items: _ri, reasoning_signature: _rs, is_error: _ie, ...rest } = m
      return rest
    })
  }
  return out
}

export function parseResponse(json: any, _model: string): any {
  return normalizeUsage(json)
}

export function createStreamDecoder(_model: string): StreamDecoder {
  return {
    push(ev) {
      const d = ev.data.trim()
      if (!d || d === '[DONE]') return []
      try {
        return [normalizeUsage(JSON.parse(d))]
      } catch {
        return []
      }
    },
    flush() {
      return []
    },
  }
}

// ── 作为对外入口（入口请求 → IR / IR 响应 → 入口响应）──
export function parseRequest(body: any): { ir: any; stream: boolean } {
  body = body || {}
  return { ir: body, stream: !!body.stream }
}

export function buildResponse(ir: any): any {
  return ir
}

export function createStreamEncoder(): StreamEncoder {
  return {
    encode(chunk) {
      return `data: ${JSON.stringify(chunk)}\n\n`
    },
    finalize() {
      return 'data: [DONE]\n\n'
    },
    fail(message) {
      return `data: ${JSON.stringify({ error: { message, type: 'upstream_error', code: 502 } })}\n\ndata: [DONE]\n\n`
    },
  }
}
