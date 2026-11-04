import { killSync, scheduleReload, start } from './core'
import { getPoolSettings } from './settings'
import { flushNodes, loadNodes, onNodesChanged, startFlushTimer } from './store'
import { startSubscriptionScheduler } from './subscriptions'
import { startProbeScheduler } from './tester'

let initialized = false

/** 加载节点、启动调度器，总开关开着时拉起 mihomo */
export function initPool(): void {
  if (initialized) return
  initialized = true
  loadNodes()
  startFlushTimer()
  onNodesChanged(scheduleReload)
  startSubscriptionScheduler()
  startProbeScheduler()
  installExitHooks()
  if (getPoolSettings().enabled) {
    void start().catch(error => console.warn('[pool] 启动 mihomo 失败:', error))
  }
}

function installExitHooks(): void {
  process.on('exit', () => {
    try { flushNodes() } catch { /* 退出阶段忽略 */ }
    killSync()
  })
  // 注册信号处理器后默认的退出行为会消失，这里立即退出以保持原行为；exit 钩子负责收尾
  const signals: [NodeJS.Signals, number][] = [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]
  for (const [signal, code] of signals) process.once(signal, () => process.exit(code))
}
