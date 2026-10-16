import { enabledChannels } from '../db'
import type { Caller, Channel, ChannelGroup, ModelRatio } from '../types'
import { findRatio } from './billing'
import { OWNER_CALLER } from './caller'
import { channelModelNames, channelSupportsModel, listedModel } from './channelModels'
import { listGroups } from './groups'
import { matchesPattern } from './modelPattern'

/** 把请求模型解析为上游真实模型名：专属名先换回原名，再按 model_mapping 映射 */
export function resolveUpstreamModel(channel: Channel, requestedModel: string): string {
  const model = listedModel(channel, requestedModel) ?? requestedModel
  if (channel.model_mapping && Object.hasOwn(channel.model_mapping, model)) {
    const mapped = channel.model_mapping[model]
    if (typeof mapped === 'string' && mapped) return mapped
  }
  return model
}

/** Key 是否允许使用该模型：白名单为空不限，否则须命中其中一条（支持 * 通配符） */
export function keyAllowsModel(caller: Caller, model: string): boolean {
  const models = caller.key?.models
  return !models?.length || models.some(pattern => matchesPattern(pattern, model))
}

/** 调用方 Key 引用的分组（已删除的忽略）；owner 返回 null，表示不受分组限制 */
function callerGroups(caller: Caller): ChannelGroup[] | null {
  if (!caller.key) return null
  const names = caller.key.groups
  return listGroups().filter(g => names.includes(g.name))
}

/** 分组是否允许该渠道以该模型名服务：渠道和模型都须在分组里勾选 */
function groupAllows(group: ChannelGroup, channel: Channel, model: string): boolean {
  return group.channel_ids.includes(channel.id) && group.models.includes(model)
}

/** 调用方可见的模型名（升序）：Key 只看到所属分组允许的渠道 × 模型，再取模型白名单与倍率表的交集 */
export function modelsVisibleTo(caller: Caller, ratios: ModelRatio[]): string[] {
  const groups = callerGroups(caller)
  const set = new Set<string>()
  for (const c of enabledChannels()) {
    for (const m of channelModelNames(c)) {
      if (!groups || groups.some(g => groupAllows(g, c, m))) set.add(m)
    }
  }
  return [...set].filter(id => keyAllowsModel(caller, id) && (!caller.key || findRatio(ratios, id))).sort()
}

/** 所有能服务该模型、且调用方分组允许的启用渠道；Key 白名单不允许的模型视同无渠道 */
export function candidatesForModel(model: string, caller: Caller = OWNER_CALLER): Channel[] {
  if (!keyAllowsModel(caller, model)) return []
  const groups = callerGroups(caller)
  return enabledChannels().filter((c) => channelSupportsModel(c, model) && (!groups || groups.some(g => groupAllows(g, c, model))))
}

/** 每个候选渠道计费所用的分组：Key 有多个分组同时允许时取倍率最低的；owner 返回空表 */
export function candidateGroups(caller: Caller, channels: Channel[], model: string): Map<number, ChannelGroup> {
  const out = new Map<number, ChannelGroup>()
  const groups = callerGroups(caller)
  if (!groups) return out
  for (const channel of channels) {
    for (const group of groups) {
      const current = out.get(channel.id)
      if (groupAllows(group, channel, model) && (!current || group.ratio < current.ratio)) out.set(channel.id, group)
    }
  }
  return out
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
