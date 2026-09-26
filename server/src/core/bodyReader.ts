import { abortable, settleCleanup } from './requestLifecycle'
import { BoundedCapture } from './capture'

export interface ReadOptions {
  signal?: AbortSignal
  onBytes?: (bytes: Uint8Array) => void
}

/** 自然 EOF 释放锁；取消、错误和提前退出同时取消底层 body。 */
export async function* readBytes(body: ReadableStream<Uint8Array>, options: ReadOptions = {}): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  let complete = false
  try {
    for (;;) {
      options.signal?.throwIfAborted()
      const pending = reader.read()
      const { done, value } = options.signal ? await abortable(pending, options.signal) : await pending
      options.signal?.throwIfAborted()
      if (done) { complete = true; break }
      if (!value.byteLength) continue
      options.onBytes?.(value)
      yield value
    }
  } finally {
    if (!complete) await settleCleanup(reader.cancel().catch(() => {}))
    reader.releaseLock()
  }
}

export async function readBodyText(
  body: ReadableStream<Uint8Array> | null,
  options: ReadOptions & { maxBytes: number; truncate?: boolean; onTruncate?: () => void },
): Promise<string> {
  if (!body) return ''
  const capture = new BoundedCapture(true, options.maxBytes)
  for await (const chunk of readBytes(body, options)) {
    capture.append(chunk)
    if (capture.truncated) {
      options.onTruncate?.()
      if (!options.truncate) throw new Error(`响应体超过 ${options.maxBytes} 字节限制`)
      break
    }
  }
  return capture.text()!
}
