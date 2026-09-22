// 把存储的请求体解析成 role 对话块（日志详情与提示词预处理可视化共用）

export interface Block {
  role: string
  text: string
  chars: number
}

export function contentToText(content: any): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return typeof content === 'object' ? JSON.stringify(content) : String(content)
  const parts: string[] = []
  for (const p of content) {
    if (typeof p === 'string') {
      parts.push(p)
      continue
    }
    if (!p || typeof p !== 'object') {
      parts.push(String(p))
      continue
    }
    switch (p.type) {
      case 'text':
      case 'input_text':
      case 'output_text':
        parts.push(p.text || '')
        break
      case 'refusal':
        parts.push(p.refusal || '')
        break
      case 'input_image': {
        const u = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url || p.file_id || ''
        parts.push(`[image ${u.startsWith('data:') ? u.slice(0, 40) + '…' : u}]`)
        break
      }
      case 'input_file':
        parts.push(`[file ${p.filename || p.file_id || p.file_url || ''}]`)
        break
      case 'thinking':
        parts.push(p.thinking || '')
        break
      case 'image':
        parts.push(`[image ${p.source?.media_type || p.source?.type || ''}]`)
        break
      case 'image_url': {
        const u = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url || ''
        parts.push(`[image ${u.startsWith('data:') ? u.slice(0, 40) + '…' : u}]`)
        break
      }
      case 'tool_use':
        parts.push(`[tool_use ${p.name || ''}] ${JSON.stringify(p.input ?? {})}`)
        break
      case 'tool_result':
        parts.push(`[tool_result]\n${contentToText(p.content)}`)
        break
      case 'document':
        parts.push('[document]')
        break
      default:
        parts.push(JSON.stringify(p))
    }
  }
  return parts.join('\n')
}

export function parseConversation(rawBody: string | null): Block[] {
  if (!rawBody) return []
  let body: any
  try {
    body = JSON.parse(rawBody)
  } catch {
    return [{ role: 'raw', text: rawBody, chars: rawBody.length }]
  }
  const blocks: Block[] = []
  if (body.system) {
    const t = contentToText(body.system)
    blocks.push({ role: 'system', text: t, chars: t.length })
  }
  // Responses：instructions 视作 system，input 为字符串或项数组
  if (typeof body.instructions === 'string' && body.instructions) {
    blocks.push({ role: 'system', text: body.instructions, chars: body.instructions.length })
  }
  if (typeof body.input === 'string') {
    blocks.push({ role: 'user', text: body.input, chars: body.input.length })
  } else if (Array.isArray(body.input)) {
    for (const it of body.input) {
      if (!it || typeof it !== 'object') continue
      let role = it.role === 'developer' ? 'system' : it.role
      let t = ''
      switch (it.type) {
        case 'function_call':
          role = 'assistant'
          t = `[function_call ${it.name || ''}] ${typeof it.arguments === 'string' ? it.arguments : JSON.stringify(it.arguments ?? {})}`
          break
        case 'custom_tool_call':
          role = 'assistant'
          t = `[custom_tool_call ${it.name || ''}] ${typeof it.input === 'string' ? it.input : JSON.stringify(it.input ?? '')}`
          break
        case 'function_call_output':
        case 'custom_tool_call_output':
          role = 'tool'
          t = `[${it.type}]\n${contentToText(it.output)}`
          break
        case 'reasoning':
          role = 'assistant'
          t = `[reasoning] ${[...(it.summary || []), ...(it.content || [])].map((x: any) => x?.text || '').join('\n')}`
          break
        default:
          if (!role) {
            role = 'other'
            t = JSON.stringify(it)
          } else t = contentToText(it.content)
      }
      blocks.push({ role: role || 'user', text: t, chars: t.length })
    }
  }
  for (const m of body.messages || []) {
    if (!m || typeof m !== 'object') continue
    const t = contentToText(m.content)
    blocks.push({ role: m.role || 'user', text: t, chars: t.length })
  }
  return blocks
}

export function paramsOf(rawBody: string | null): Record<string, any> | null {
  if (!rawBody) return null
  try {
    const body = JSON.parse(rawBody)
    if (!body || typeof body !== 'object') return null
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(body)) {
      if (k === 'messages' || k === 'system' || k === 'input' || k === 'instructions') continue
      out[k] = v
    }
    return out
  } catch {
    return null
  }
}

export function roleClass(r: string): string {
  return ['system', 'user', 'assistant', 'tool'].includes(r) ? r : 'other'
}

export interface ToolInfo {
  name: string
  description?: string
}

export function parseTools(rawBody: string | null): ToolInfo[] {
  if (!rawBody) return []
  try {
    const body = JSON.parse(rawBody)
    if (!body || !Array.isArray(body.tools)) return []
    return body.tools
      .map((t: any) => {
        if (t?.function?.name) return { name: t.function.name, description: t.function.description }
        if (t?.name) return { name: t.name, description: t.description }
        return null
      })
      .filter(Boolean)
  } catch {
    return []
  }
}
