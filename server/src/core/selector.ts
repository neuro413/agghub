import { enabledChannels } from '../db'
import type { Channel } from '../types'

/** 渠道是否支持该模型（直接列出 或 通过 model_mapping 的别名 key）*/
function channelSupportsModel(channel: Channel, model: string): boolean {
  if (channel.models.includes(model)) return true
  if (channel.model_mapping && Object.hasOwn(channel.model_mapping, model)) return true
  return false
}

/** 把请求模型解析为上游真实模型名 */
export function resolveUpstreamModel(channel: Channel, requestedModel: string): string {
  if (channel.model_mapping && Object.hasOwn(channel.model_mapping, requestedModel)) {
    const mapped = channel.model_mapping[requestedModel]
    if (typeof mapped === 'string' && mapped) return mapped
  }
  return requestedModel
}

/** 所有能服务该模型的启用渠道 */
export function candidatesForModel(model: string): Channel[] {
  return enabledChannels().filter((c) => channelSupportsModel(c, model))
}

/**
 * 选一个满足条件的渠道（参考 new-api channel_cache.go 的优先级分层 + 平滑加权随机）。
 * 采用「现存候选里最高优先级层」策略：excludeIds 排除已试渠道，
 * 当高优先级层被试光后，下一层自然成为最高 → 实现按优先级降级的故障转移。
 * candidates 为本次请求开始时的候选快照（由调用方一次性查出复用，避免每轮重试都查库）。
 */
export function selectChannel(candidates: Channel[], excludeIds: Set<number>): Channel | null {
  const avail = candidates.filter((c) => !excludeIds.has(c.id))
  if (avail.length === 0) return null
  if (avail.length === 1) return avail[0]

  const maxPriority = Math.max(...avail.map((c) => c.priority))
  const layer = avail.filter((c) => c.priority === maxPriority)
  if (layer.length === 1) return layer[0]

  // 平滑加权随机
  let sumWeight = layer.reduce((s, c) => s + c.weight, 0)
  let smoothingFactor = 1
  let smoothingAdjust = 0
  if (sumWeight === 0) {
    sumWeight = layer.length * 100
    smoothingAdjust = 100
  } else if (sumWeight / layer.length < 10) {
    smoothingFactor = 100
  }
  const total = sumWeight * smoothingFactor
  let r = Math.floor(Math.random() * total)
  for (const c of layer) {
    r -= c.weight * smoothingFactor + smoothingAdjust
    if (r < 0) return c
  }
  return layer[0]
}
