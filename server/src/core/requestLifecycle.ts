import type { Response } from 'express'

export type StopReason = 'client_cancel' | 'request_deadline' | 'upstream_idle' | 'downstream_timeout'
export class RequestStopped extends Error {
  constructor(readonly reason: StopReason) {
    super({ client_cancel: '客户端中断了请求', request_deadline: '整次请求超过总时限', upstream_idle: '上游无数据超时', downstream_timeout: '等待客户端接收数据超时' }[reason])
    this.name = 'RequestStopped'
  }
}

/** 不依赖被等待任务自行处理 signal；迟到的响应交给调用者释放。 */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal, onLate?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const stop = () => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', stop)
      reject(signal.reason ?? new DOMException('请求已取消', 'AbortError'))
    }
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
    promise.then(value => {
      if (settled) { onLate?.(value); return }
      settled = true
      signal.removeEventListener('abort', stop)
      resolve(value)
    }, error => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', stop)
      reject(error)
    })
  })
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
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

/** 尝试空闲计时从 OAuth/图片准备前开始；背压等待暂时暂停该计时。 */
export class AttemptLifecycle {
  private controller = new AbortController()
  private timer?: ReturnType<typeof setTimeout>
  private paused = false
  private disposed = false
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
    if (!this.paused && !this.disposed && !this.signal.aborted) this.timer = setTimeout(() => this.controller.abort(new RequestStopped('upstream_idle')), this.idleMs)
  }
  pause(): void { this.paused = true; clearTimeout(this.timer) }
  resume(): void { this.paused = false; this.touch() }
  abort(reason?: unknown): void { this.controller.abort(reason); clearTimeout(this.timer) }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    clearTimeout(this.timer)
    this.parent.removeEventListener('abort', this.stop)
    this.controller.abort()
  }
}

/** 流关闭回调属于外部实现，给清理等待设上限，避免清理本身挂起请求。 */
export async function settleCleanup(promise: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([promise.catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, 100) })])
  } finally { clearTimeout(timer) }
}
