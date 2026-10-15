import { enabledChannels } from '../db'
import type { Caller, Channel, ModelRatio } from '../types'
import { findRatio } from './billing'
import { OWNER_CALLER } from './caller'
import { matchesPattern } from './modelPattern'

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

/** Key 是否允许使用该模型：白名单为空不限，否则须命中其中一条（支持 * 通配符） */
export function keyAllowsModel(caller: Caller, model: string): boolean {
  const models = caller.key?.models
  return !models?.length || models.some(pattern => matchesPattern(pattern, model))
}

/** 渠道是否对该调用方可见：owner 不受限；Key 须与渠道分组有交集 */
export function channelVisibleTo(channel: Channel, caller: Caller): boolean {
  const groups = caller.key?.groups
  return !caller.key || !!groups?.some(group => channel.groups.includes(group))
}

/** 调用方可见的模型名（升序）：Key 只看到自己分组内渠道的模型，再取模型白名单与倍率表的交集 */
export function modelsVisibleTo(caller: Caller, ratios: ModelRatio[]): string[] {
  const set = new Set<string>()
  for (const c of enabledChannels()) {
    if (!channelVisibleTo(c, caller)) continue
    for (const m of c.models) set.add(m)
    if (c.model_mapping) for (const k of Object.keys(c.model_mapping)) set.add(k)
  }
  return [...set].filter(id => keyAllowsModel(caller, id) && (!caller.key || findRatio(ratios, id))).sort()
}

/** 所有能服务该模型、且对调用方可见的启用渠道；Key 白名单不允许的模型视同无渠道 */
export function candidatesForModel(model: string, caller: Caller = OWNER_CALLER): Channel[] {
  if (!keyAllowsModel(caller, model)) return []
  return enabledChannels().filter((c) => channelVisibleTo(c, caller) && channelSupportsModel(c, model))
}

/**
 * 选一个满足条件的渠道（参考 new-api 的优先级分层 + 加权随机）。
 * 采用「现存候选里最高优先级层」策略：excludeIds 排除已试渠道，
 * 当高优先级层被试光后，下一层自然成为最高 → 实现按优先级降级的故障转移。
 */
export function selectChannel(candidates: Channel[], excludeIds: Set<number>): Channel | null {
  const avail = candidates.filter((c) => !excludeIds.has(c.id))
  if (avail.length === 0) return null
  if (avail.length === 1) return avail[0]

  const maxPriority = Math.max(...avail.map((c) => c.priority))
  const layer = avail.filter((c) => c.priority === maxPriority)
  if (layer.length === 1) return layer[0]

  // 加权随机；权重全为 0 时均匀随机
  const total = layer.reduce((s, c) => s + c.weight, 0)
  if (total <= 0) return layer[Math.floor(Math.random() * layer.length)]
  let r = Math.random() * total
  for (const c of layer) {
    r -= c.weight
    if (r < 0) return c
  }
  return layer[layer.length - 1]
}
