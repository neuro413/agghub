import type { Response } from 'express'
import { AttemptLifecycle, RequestStopped } from './requestLifecycle'

export function createStreamWriter(res: Response, signal: AbortSignal, attempt: AttemptLifecycle, timeoutMs: number) {
  return async (text: string): Promise<void> => {
    signal.throwIfAborted()
    if (res.destroyed || res.writableEnded) throw new RequestStopped('client_cancel')
    if (!text || res.write(text)) return
    attempt.pause()
    try {
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const cleanup = () => {
          clearTimeout(timer)
          res.off('drain', drain)
          res.off('close', close)
          res.off('error', error)
          signal.removeEventListener('abort', abort)
        }
        const drain = () => { cleanup(); resolve() }
        const error = (reason: unknown) => { cleanup(); reject(reason) }
        const close = () => error(new RequestStopped('client_cancel'))
        const abort = () => error(signal.reason)
        res.once('drain', drain)
        res.once('close', close)
        res.once('error', error)
        signal.addEventListener('abort', abort, { once: true })
        timer = setTimeout(() => {
          const reason = new RequestStopped('downstream_timeout')
          attempt.abort(reason)
          error(reason)
        }, timeoutMs)
        if (signal.aborted) abort()
        else if (res.destroyed || res.writableEnded) close()
      })
    } finally { attempt.resume() }
  }
}
