import type { BoundedCapture } from './capture'

// Responses 上游在 created / in_progress / 终态事件里原样回显请求的 instructions 与 tools，内容与日志中的上游请求相同。
// 推理密文在 output_item.added、output_item.done 和终态 output 里各有一份独立加密的版本，网关只使用 done 那份。
// 日志副本省略这两类数据，其余帧逐字保留。
const ECHO_KEYS = ['instructions', 'tools']
const ECHO_OMITTED = '[agghub 日志省略：同上游请求]'
const TRIM_TYPES = new Set([
  'response.created', 'response.in_progress', 'response.completed', 'response.incomplete', 'response.failed',
  'response.output_item.added', 'response.output_item.done',
])
const TYPE_PATTERN = /"type":\s*"(response\.[a-z_.]+)"/

function omitCipher(item: any): boolean {
  if (typeof item?.encrypted_content !== 'string' || !item.encrypted_content) return false
  item.encrypted_content = `[agghub 日志省略：${item.encrypted_content.length} 字符密文]`
  return true
}

/** 就地省略回显参数；doneIds 给出已在 output_item.done 中完整记录过的推理项，终态 output 里的副本密文一并省略。 */
export function trimResponseObject(response: any, doneIds?: ReadonlySet<string>): boolean {
  let changed = false
  for (const key of ECHO_KEYS) {
    const value = response[key]
    if (value == null || value === '' || (Array.isArray(value) && !value.length)) continue
    response[key] = ECHO_OMITTED
    changed = true
  }
  if (doneIds?.size && Array.isArray(response.output)) {
    for (const item of response.output) if (doneIds.has(item?.id)) changed = omitCipher(item) || changed
  }
  return changed
}

/** 非流式 Responses 回复：浅拷贝后省略回显，不影响返回给客户端的对象。 */
export function logResponsesBody(capture: BoundedCapture, body: any): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return
  const copy = { ...body }
  if (trimResponseObject(copy)) capture.replace(JSON.stringify(copy))
}

/** Responses 上游 SSE 的日志副本：按帧切分，只改写需要省略的帧，其余字节原样写入。 */
export class ResponsesSseLog {
  private readonly decoder = new TextDecoder()
  private pending = ''
  private scanned = 0
  private readonly doneIds = new Set<string>()
  constructor(private readonly capture: BoundedCapture) {}

  append(bytes: Uint8Array): void {
    if (!this.capture.enabled || this.capture.truncated) return
    this.pending += this.decoder.decode(bytes, { stream: true })
    const boundary = /\r?\n\r?\n/g
    // 大帧分多次到达时从上次扫描处附近继续找分隔符（回退 3 字符覆盖跨块的 \r\n\r\n）
    boundary.lastIndex = Math.max(0, this.scanned - 3)
    let start = 0
    for (let match; (match = boundary.exec(this.pending));) {
      this.capture.append(this.rewrite(this.pending.slice(start, match.index)) + match[0])
      start = match.index + match[0].length
    }
    this.pending = this.pending.slice(start)
    this.scanned = this.pending.length
    // 迟迟不结束的帧不再等待改写，原样写入，暂存不超过日志上限
    if (this.pending.length > this.capture.maxBytes) {
      this.capture.append(this.pending)
      this.pending = ''
      this.scanned = 0
    }
  }

  flush(): void {
    this.pending += this.decoder.decode()
    if (this.pending && this.capture.enabled && !this.capture.truncated) this.capture.append(this.rewrite(this.pending))
    this.pending = ''
  }

  private rewrite(frame: string): string {
    const type = TYPE_PATTERN.exec(frame)?.[1]
    if (!type || !TRIM_TYPES.has(type)) return frame
    const lines = frame.split(/\r?\n/)
    let data: any
    try {
      data = JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n'))
    } catch { return frame }
    if (data?.type !== type) return frame
    let changed = false
    if (type === 'response.output_item.done') {
      if (data.item?.type === 'reasoning' && typeof data.item.id === 'string') this.doneIds.add(data.item.id)
    } else if (type === 'response.output_item.added') changed = omitCipher(data.item)
    else if (data.response && typeof data.response === 'object') changed = trimResponseObject(data.response, this.doneIds)
    if (!changed) return frame
    return [...lines.filter(line => !line.startsWith('data:')), `data: ${JSON.stringify(data)}`].join('\n')
  }
}
