import { readBytes, type ReadOptions } from '../core/bodyReader'
import { UpstreamError } from '../core/failover'
import type { SSEEvent } from '../core/streamState'

// ── IEEE 802.3 CRC32（零外部依赖，兼容 Node 20/22）──────────
const CRC32_TABLE = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let j = 0; j < 8; j++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC32_TABLE[i] = c >>> 0
}

export function crc32(buf: Uint8Array, start = 0, end = buf.length): number {
  let crc = 0xffffffff
  for (let i = start; i < end; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** 单帧上限（Smithy 规范 payload 上限 24 MiB + headers 上限 128 KiB + 开销，留余量到 26 MiB） */
const MAX_FRAME_BYTES = 26 * 1024 * 1024
const PRELUDE_BYTES = 12
const MIN_FRAME_BYTES = 16

/** Bedrock 流内异常类型 → HTTP 状态码 */
function exceptionStatus(type: string): number {
  switch (type.toLowerCase()) {
    case 'throttlingexception':
      return 429
    case 'validationexception':
      return 400
    case 'accessdeniedexception':
      return 403
    case 'resourcenotfoundexception':
      return 404
    case 'modeltimeoutexception':
      return 408
    case 'modelstreamerrorexception':
    case 'modelerrorexception':
      return 424
    case 'serviceunavailableexception':
      return 503
    case 'internalserverexception':
      return 500
    default:
      return 502
  }
}

/** 解析单个 AWS EventStream 帧的 headers 区域，返回 string 类型头（其余类型按规范跳过对应字节数） */
function decodeHeaders(buf: Buffer, offset: number, length: number): Record<string, string> {
  const headers: Record<string, string> = {}
  const end = offset + length
  let pos = offset
  while (pos < end) {
    if (pos + 1 > end) throw new UpstreamError(502, 'AWS EventStream header 名称长度越界')
    const nameLen = buf[pos]
    pos += 1
    if (nameLen === 0 || pos + nameLen + 1 > end) throw new UpstreamError(502, 'AWS EventStream header 名称越界')
    const name = buf.subarray(pos, pos + nameLen).toString('utf8')
    pos += nameLen
    const type = buf[pos]
    pos += 1
    switch (type) {
      case 0: // bool true
      case 1: // bool false
        break
      case 2: // byte
        pos += 1
        break
      case 3: // short
        pos += 2
        break
      case 4: // integer
        pos += 4
        break
      case 5: // long
      case 8: // timestamp (8-byte ms)
        pos += 8
        break
      case 6: { // byte_array
        if (pos + 2 > end) throw new UpstreamError(502, 'AWS EventStream byte_array header 越界')
        const len = buf.readUInt16BE(pos)
        pos += 2 + len
        break
      }
      case 7: { // string
        if (pos + 2 > end) throw new UpstreamError(502, 'AWS EventStream string header 越界')
        const len = buf.readUInt16BE(pos)
        pos += 2
        if (pos + len > end) throw new UpstreamError(502, 'AWS EventStream string header 内容越界')
        headers[name] = buf.subarray(pos, pos + len).toString('utf8')
        pos += len
        break
      }
      case 9: // uuid
        pos += 16
        break
      default:
        throw new UpstreamError(502, `AWS EventStream 未知 header 类型: ${type}`)
    }
    if (pos > end) throw new UpstreamError(502, 'AWS EventStream header 长度越界')
  }
  return headers
}

/**
 * 解码 AWS Bedrock `InvokeModelWithResponseStream` 的 `application/vnd.amazon.eventstream` 二进制流，
 * 将每个 `chunk` 帧中的 base64 payload 还原为标准的 Anthropic SSE 事件对象 `{ event, data }`。
 */
export async function* parseBedrockEventStream(
  body: ReadableStream<Uint8Array>,
  options: ReadOptions = {},
): AsyncGenerator<SSEEvent> {
  let buffer = Buffer.alloc(0)

  for await (const chunk of readBytes(body, options)) {
    buffer = buffer.length ? Buffer.concat([buffer, Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)]) : Buffer.from(chunk)

    while (buffer.length >= PRELUDE_BYTES) {
      const totalLength = buffer.readUInt32BE(0)
      const headersLength = buffer.readUInt32BE(4)
      const preludeCrc = buffer.readUInt32BE(8)

      if (totalLength < MIN_FRAME_BYTES || totalLength > MAX_FRAME_BYTES) {
        throw new UpstreamError(502, `AWS EventStream 帧长度非法: ${totalLength}`)
      }
      if (headersLength > totalLength - MIN_FRAME_BYTES) {
        throw new UpstreamError(502, `AWS EventStream header 长度非法: ${headersLength}`)
      }
      if (crc32(buffer, 0, 8) !== preludeCrc) {
        throw new UpstreamError(502, 'AWS EventStream prelude CRC32 校验失败')
      }
      if (buffer.length < totalLength) break

      const messageCrc = buffer.readUInt32BE(totalLength - 4)
      if (crc32(buffer, 0, totalLength - 4) !== messageCrc) {
        throw new UpstreamError(502, 'AWS EventStream message CRC32 校验失败')
      }

      const headers = decodeHeaders(buffer, PRELUDE_BYTES, headersLength)
      const payload = buffer.subarray(PRELUDE_BYTES + headersLength, totalLength - 4)
      buffer = buffer.length === totalLength ? Buffer.alloc(0) : Buffer.from(buffer.subarray(totalLength))

      const messageType = headers[':message-type']
      if (messageType === 'exception') {
        const exceptionType = headers[':exception-type'] || 'exception'
        const payloadText = payload.toString('utf8')
        throw new UpstreamError(exceptionStatus(exceptionType), payloadText || exceptionType)
      }
      if (messageType === 'error') {
        const code = headers[':error-code'] || 'error'
        const msg = headers[':error-message'] || payload.toString('utf8') || code
        throw new UpstreamError(502, `${code}: ${msg}`)
      }
      if (messageType !== 'event') continue

      const eventType = headers[':event-type']
      if (eventType !== 'chunk' || !payload.length) continue

      let wrapper: any
      try {
        wrapper = JSON.parse(payload.toString('utf8'))
      } catch {
        throw new UpstreamError(502, 'AWS Bedrock chunk 帧不是合法 JSON')
      }
      if (typeof wrapper?.bytes !== 'string') continue
      const decoded = Buffer.from(wrapper.bytes, 'base64').toString('utf8')
      let parsedType: string | null = null
      try {
        const inner = JSON.parse(decoded)
        if (typeof inner?.type === 'string') parsedType = inner.type
      } catch {
        // 交由下游 StreamState 统一按非 JSON 报错
      }
      yield { event: parsedType, data: decoded }
    }
  }

  if (buffer.length > 0) {
    throw new UpstreamError(502, 'AWS EventStream 帧不完整（流已截断）')
  }
}

/** 构造单个 AWS EventStream 二进制帧（供单元测试合成 Bedrock 响应流使用） */
export function encodeEventStreamFrame(headers: Record<string, string>, payload: Buffer | string): Buffer {
  const headerChunks: Buffer[] = []
  for (const [name, value] of Object.entries(headers)) {
    const nameBuf = Buffer.from(name, 'utf8')
    const valBuf = Buffer.from(value, 'utf8')
    const entry = Buffer.alloc(1 + nameBuf.length + 1 + 2 + valBuf.length)
    let pos = 0
    entry[pos++] = nameBuf.length
    nameBuf.copy(entry, pos)
    pos += nameBuf.length
    entry[pos++] = 7 // string
    entry.writeUInt16BE(valBuf.length, pos)
    pos += 2
    valBuf.copy(entry, pos)
    headerChunks.push(entry)
  }
  const headersBuf = Buffer.concat(headerChunks)
  const payloadBuf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
  const totalLength = PRELUDE_BYTES + headersBuf.length + payloadBuf.length + 4
  const frame = Buffer.alloc(totalLength)
  frame.writeUInt32BE(totalLength, 0)
  frame.writeUInt32BE(headersBuf.length, 4)
  frame.writeUInt32BE(crc32(frame, 0, 8), 8)
  headersBuf.copy(frame, PRELUDE_BYTES)
  payloadBuf.copy(frame, PRELUDE_BYTES + headersBuf.length)
  frame.writeUInt32BE(crc32(frame, 0, totalLength - 4), totalLength - 4)
  return frame
}
