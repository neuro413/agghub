import { delay, ENTRY_NAME, isRunning } from './core'
import { getPoolSettings } from './settings'
import { allNodes, disableNodes, getNode, recordNetworkFailure, recordSuccess } from './store'
import type { DelayResult, TestProgress } from './types'

const progress: TestProgress = { running: false, paused: false, kind: null, total: 0, done: 0, ok: 0, fail: 0, started_at: null, finished_at: null }
let stopFlag = false
let resumeWaiters: (() => void)[] = []

export function testProgress(): TestProgress {
  return { ...progress }
}

/** 单节点测速并记入健康数据；内核未运行时不记账 */
export async function testNode(id: number): Promise<DelayResult> {
  const node = getNode(id)
  if (!node) return { ok: false, error: '节点不存在' }
  if (node.invalid_reason) return { ok: false, error: `配置无效：${node.invalid_reason}` }
  if (!isRunning()) return { ok: false, error: '内核未运行' }
  const s = getPoolSettings()
  const result = await delay(`n${id}`, s.test_url, s.test_timeout_ms)
  if (!getNode(id) || !isRunning()) return result
  if (result.ok) recordSuccess(id, result.delay)
  else recordNetworkFailure(id, result.error || '测速失败', true)
  return result
}

function wakeAll(): void {
  const waiters = resumeWaiters
  resumeWaiters = []
  for (const fn of waiters) fn()
}

/**
 * 并发测一批节点
 * disable：always = 失败即禁用（手动批量）；threshold = 连续失败达到阈值才禁用（定时拨测）；never
 */
async function run(ids: number[], kind: 'batch' | 'probe', disable: 'always' | 'threshold' | 'never'): Promise<void> {
  Object.assign(progress, { running: true, paused: false, kind, total: ids.length, done: 0, ok: 0, fail: 0, started_at: Date.now(), finished_at: null })
  stopFlag = false
  const s = getPoolSettings()
  const failed: number[] = []
  let cursor = 0
  const worker = async () => {
    while (!stopFlag && cursor < ids.length) {
      if (progress.paused) {
        await new Promise<void>(resolve => resumeWaiters.push(resolve))
        continue
      }
      if (!isRunning()) {
        stopFlag = true
        break
      }
      const id = ids[cursor++]
      const result = await testNode(id)
      if (!isRunning()) continue
      progress.done++
      if (result.ok) progress.ok++
      else {
        progress.fail++
        failed.push(id)
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(s.test_concurrency, ids.length)) }, worker))
    const toDisable = disable === 'always'
      ? failed
      : disable === 'threshold' && s.auto_disable_failures > 0
        ? failed.filter(id => (getNode(id)?.consecutive_failures ?? 0) >= s.auto_disable_failures)
        : []
    if (toDisable.length) disableNodes(toDisable)
  } finally {
    progress.running = false
    progress.paused = false
    progress.finished_at = Date.now()
  }
}

/** 手动批量测速；ids 为空测全部启用节点。已有任务时返回 null */
export function startBatch(ids: number[] | undefined, disableFailed: boolean): TestProgress | null {
  if (progress.running) return null
  if (!isRunning()) throw new Error('内核未运行')
  const source = ids?.length ? ids.map(id => getNode(id)).filter(n => !!n) : allNodes().filter(n => !n.disabled)
  const targets = source.filter(n => !n.invalid_reason).map(n => n.id)
  void run(targets, 'batch', disableFailed ? 'always' : 'never')
  return testProgress()
}

export function pauseBatch(): TestProgress {
  if (progress.running) progress.paused = true
  return testProgress()
}

export function resumeBatch(): TestProgress {
  progress.paused = false
  wakeAll()
  return testProgress()
}

export function stopBatch(): TestProgress {
  stopFlag = true
  progress.paused = false
  wakeAll()
  return testProgress()
}

/** 入口代理测速（未保存的修改不生效） */
export async function testEntry(): Promise<DelayResult> {
  const s = getPoolSettings()
  if (!s.entry_proxy) return { ok: false, error: '未设置入口代理' }
  return delay(ENTRY_NAME, s.test_url, s.test_timeout_ms)
}

let lastProbeAt = Date.now()
let timer: NodeJS.Timeout | null = null
/** 定时拨测：与手动批量测速互斥，批量进行中本轮跳过 */
export function startProbeScheduler(): void {
  if (timer) return
  timer = setInterval(() => {
    const s = getPoolSettings()
    if (!s.enabled || !s.probe_enabled || progress.running || !isRunning()) return
    if (Date.now() - lastProbeAt < s.probe_interval_minutes * 60_000) return
    lastProbeAt = Date.now()
    const ids = allNodes().filter(n => !n.disabled && !n.invalid_reason).map(n => n.id)
    if (ids.length) void run(ids, 'probe', 'threshold')
  }, 60_000)
  timer.unref()
}
