import { once } from 'node:events'
import type { Response } from 'express'
import { AttemptLifecycle, RequestStopped } from './requestLifecycle'

/** 设置 SSE 响应头并立即发出；保活与首个有效内容都可能先到，只设置一次 */
export function openEventStream(res: Response): void {
  if (res.headersSent) return
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
}

/**
 * 流式保活：超过 intervalMs 没有向客户端写出数据就补一行 SSE 注释（客户端按规范忽略），
 * 防止 Cloudflare 隧道等反代在长时间等待上游时断开。首次保活会提前提交 200 响应头，
 * 此后的失败只能写成 SSE 错误事件；尚未输出内容时仍可重试与换渠道。
 */
export class StreamKeepAlive {
  private timer: ReturnType<typeof setInterval>
  constructor(private res: Response, intervalMs: number) {
    this.timer = setInterval(this.ping, intervalMs)
  }
  /** 刚写出数据，重新计时 */
  touch = (): void => { this.timer.refresh() }
  private ping = (): void => {
    const res = this.res
    if (res.destroyed || res.writableEnded || res.writableNeedDrain) return
    openEventStream(res)
    res.write(': keepalive\n\n')
  }
  dispose(): void { clearInterval(this.timer) }
}

/** 写满缓冲时等待 drain；客户端断开由 RequestLifecycle 转成 signal 中止。 */
export function createStreamWriter(res: Response, signal: AbortSignal, attempt: AttemptLifecycle, keepAlive?: StreamKeepAlive) {
  return async (text: string): Promise<void> => {
    signal.throwIfAborted()
    if (res.destroyed || res.writableEnded) throw new RequestStopped('client_cancel')
    if (!text) return
    keepAlive?.touch()
    if (res.write(text)) return
    attempt.pause()
    try {
      await once(res, 'drain', { signal })
    } catch (error) {
      throw signal.aborted ? signal.reason : error
    } finally { attempt.resume() }
  }
}
