/** 日志副本按 UTF-8 字节限制，关闭时完全不持有正文。 */
export class BoundedCapture {
  private chunks: Buffer[] = []
  private lastUsed = 0
  capturedBytes = 0
  totalBytes = 0
  truncated = false
  constructor(readonly enabled: boolean, readonly maxBytes: number) {}
  append(value: string | Uint8Array): void {
    if (!this.enabled) return
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
    this.totalBytes += bytes.byteLength
    const available = Math.max(0, this.maxBytes - this.capturedBytes)
    const length = Math.min(available, bytes.byteLength)
    let offset = 0
    while (offset < length) {
      let last = this.chunks[this.chunks.length - 1]
      if (!last || this.lastUsed === last.byteLength) {
        last = Buffer.allocUnsafe(Math.min(4096, this.maxBytes - this.capturedBytes))
        this.chunks.push(last)
        this.lastUsed = 0
      }
      const count = Math.min(length - offset, last.byteLength - this.lastUsed)
      last.set(bytes.subarray(offset, offset + count), this.lastUsed)
      this.lastUsed += count
      this.capturedBytes += count
      offset += count
    }
    if (length < bytes.byteLength) this.truncated = true
  }
  buffer(): Buffer | undefined {
    return this.enabled ? Buffer.concat(this.chunks, this.capturedBytes) : undefined
  }
  text(): string | undefined {
    if (!this.enabled) return undefined
    const decoder = new TextDecoder()
    const text = decoder.decode(this.buffer(), { stream: true })
    return this.truncated ? text : text + decoder.decode()
  }
}

/** parser、待开流帧及转换器队列共用尝试级预算。 */
export class BufferBudget {
  private holds = new Map<symbol, number>()
  used = 0
  peak = 0
  constructor(readonly limit: number) {}
  hold(key: symbol, bytes: number): void {
    const next = this.used - (this.holds.get(key) || 0) + bytes
    if (next > this.limit) throw new Error(`流重组缓冲超过 ${this.limit} 字节限制`)
    this.holds.set(key, bytes)
    this.used = next
    this.peak = Math.max(this.peak, next)
  }
  release(key: symbol): void {
    this.used -= this.holds.get(key) || 0
    this.holds.delete(key)
  }
}
