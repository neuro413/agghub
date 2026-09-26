import type { Response } from 'express'

export type StopReason = 'client_cancel' | 'request_deadline' | 'upstream_idle'
export class RequestStopped extends Error {
  constructor(readonly reason: StopReason) {
    super({ client_cancel: '客户端中断了请求', request_deadline: '整次请求超过总时限', upstream_idle: '上游无数据超时' }[reason])
    this.name = 'RequestStopped'
  }
}

/** 给不响应 signal 的等待（如自定义 body 流的 read）加上取消能力。 */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason)
    if (signal.aborted) return stop()
    signal.addEventListener('abort', stop, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
  })
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
    signal.addEventListener('abort', stop, { once: true })
  })
}

export class RequestLifecycle {
  private controller = new AbortController()
  private timer?: ReturnType<typeof setTimeout>
  readonly signal = this.controller.signal
  readonly started = performance.now()
  private close = () => { if (!this.res.writableEnded) this.controller.abort(new RequestStopped('client_cancel')) }

  constructor(private res: Response, maxDuration: number) {
    res.on('close', this.close)
    if (res.destroyed && !res.writableEnded) this.close()
    if (maxDuration > 0) this.timer = setTimeout(() => this.controller.abort(new RequestStopped('request_deadline')), maxDuration)
  }
  get elapsed(): number { return Math.round(performance.now() - this.started) }
  dispose(): void {
    clearTimeout(this.timer)
    this.res.off('close', this.close)
  }
}

/** 单次尝试的上游空闲计时：收到字节即 touch 重置；等待客户端背压时暂停。 */
export class AttemptLifecycle {
  private controller = new AbortController()
  private timer?: ReturnType<typeof setTimeout>
  private paused = false
  readonly signal = this.controller.signal
  readonly started = performance.now()
  private stop = () => this.controller.abort(this.parent.reason)

  constructor(private parent: AbortSignal, private idleMs: number) {
    parent.addEventListener('abort', this.stop, { once: true })
    if (parent.aborted) this.stop()
    this.touch()
  }
  get elapsed(): number { return Math.round(performance.now() - this.started) }
  touch = (): void => {
    clearTimeout(this.timer)
    if (!this.paused && !this.signal.aborted) this.timer = setTimeout(() => this.controller.abort(new RequestStopped('upstream_idle')), this.idleMs)
  }
  pause(): void { this.paused = true; clearTimeout(this.timer) }
  resume(): void { this.paused = false; this.touch() }
  dispose(): void {
    clearTimeout(this.timer)
    this.parent.removeEventListener('abort', this.stop)
    this.controller.abort()
  }
}
