import type { ApiKey } from '../types'

// 【签名桩】由「计费与限流」任务实现；导出名称和参数类型不得修改，鉴权中间件已按此调用。

export type Admission =
  | { ok: true; release: () => void }
  | { ok: false; reason: 'rpm' | 'concurrency'; retryAfterSeconds: number }

/**
 * 生成接口进入时调用：先查 RPM（滑动 60 秒窗口），再占并发名额。
 * 成功返回 release，调用方在响应关闭时调用一次（重复调用必须无副作用）。
 * rpm / concurrency 为 null 表示不限。
 */
export function admitRequest(_key: ApiKey, _now = Date.now()): Admission {
  return { ok: true, release: () => {} }
}

/** 清空全部计数（测试用） */
export function resetLimiter(): void {}
