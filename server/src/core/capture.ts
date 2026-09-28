/** 日志副本按 UTF-8 字节限制，关闭时完全不持有正文。 */
export class BoundedCapture {
  private chunks: Buffer[] = []
  private size = 0
  truncated = false
  constructor(readonly enabled: boolean, readonly maxBytes: number) {}
  append(value: string | Uint8Array): void {
    if (!this.enabled || this.truncated) return
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
    const room = this.maxBytes - this.size
    if (bytes.byteLength > room) this.truncated = true
    if (room <= 0) return
    const part = Buffer.from(bytes.subarray(0, room))
    this.chunks.push(part)
    this.size += part.length
  }
  /** 用改写后的完整副本替换已抓取内容，按同样的上限重新截断。 */
  replace(value: string): void {
    if (!this.enabled) return
    this.chunks = []
    this.size = 0
    this.truncated = false
    this.append(value)
  }
  text(): string | undefined {
    if (!this.enabled) return undefined
    const decoder = new TextDecoder()
    const text = decoder.decode(Buffer.concat(this.chunks, this.size), { stream: true })
    return this.truncated ? text : text + decoder.decode()
  }
}
