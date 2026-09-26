import { once } from 'node:events'
import type { Response } from 'express'
import { AttemptLifecycle, RequestStopped } from './requestLifecycle'

/** 写满缓冲时等待 drain；客户端断开由 RequestLifecycle 转成 signal 中止。 */
export function createStreamWriter(res: Response, signal: AbortSignal, attempt: AttemptLifecycle) {
  return async (text: string): Promise<void> => {
    signal.throwIfAborted()
    if (res.destroyed || res.writableEnded) throw new RequestStopped('client_cancel')
    if (!text || res.write(text)) return
    attempt.pause()
    try {
      await once(res, 'drain', { signal })
    } catch (error) {
      throw signal.aborted ? signal.reason : error
    } finally { attempt.resume() }
  }
}
