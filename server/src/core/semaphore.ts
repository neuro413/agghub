import { CandidateError } from './failover'

/** 进程级下载队列也有上限；取消会立即移除等待项。 */
export class Semaphore {
  active = 0
  private queue: { signal: AbortSignal; grant: () => void; cancel: () => void }[] = []
  constructor(readonly limit: number, readonly queueLimit = 256) {}
  get waiting(): number { return this.queue.length }
  acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    if (this.active >= this.limit && this.queue.length >= this.queueLimit) throw new CandidateError('图片下载等待队列已满')
    return new Promise((resolve, reject) => {
      const item = {
        signal,
        grant: () => {
          signal.removeEventListener('abort', item.cancel)
          this.active++
          let released = false
          resolve(() => {
            if (released) return
            released = true
            this.active--
            this.queue.shift()?.grant()
          })
        },
        cancel: () => {
          const index = this.queue.indexOf(item)
          if (index >= 0) this.queue.splice(index, 1)
          signal.removeEventListener('abort', item.cancel)
          reject(signal.reason)
        },
      }
      if (this.active < this.limit) item.grant()
      else { this.queue.push(item); signal.addEventListener('abort', item.cancel, { once: true }); if (signal.aborted) item.cancel() }
    })
  }
}
