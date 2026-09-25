import { useEffect, useMemo } from 'react'

/** AbortSignal 加代际检查，卸载与 StrictMode 清理后均不能提交旧响应。 */
export function useLatestRequest() {
  const requests = useMemo(() => {
    let current: AbortController | undefined
    let generation = 0
    return {
      cancel() { generation++; current?.abort() },
      begin() {
        current?.abort()
        const controller = new AbortController()
        current = controller
        const id = ++generation
        return { signal: controller.signal, current: () => !controller.signal.aborted && generation === id }
      },
    }
  }, [])
  useEffect(() => () => requests.cancel(), [requests])
  return requests
}

export function clampOffset(offset: number, total: number, size: number): number {
  return Math.min(Math.max(0, offset), total > 0 ? Math.floor((total - 1) / size) * size : 0)
}
