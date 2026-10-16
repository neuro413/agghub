import type { Channel } from '../types'

/** 模型列表里的模型在本渠道对外的名字：设了专属名用专属名，否则用原名 */
function exposedName(channel: Channel, model: string): string {
  const alias = channel.model_alias && Object.hasOwn(channel.model_alias, model) ? channel.model_alias[model] : ''
  return typeof alias === 'string' && alias ? alias : model
}

/** 请求名对应的模型列表原名；设了专属名的模型只认专属名 */
export function listedModel(channel: Channel, model: string): string | undefined {
  return channel.models.find((m) => exposedName(channel, m) === model)
}

/** 渠道对外的模型名：模型列表（专属名替换原名）+ model_mapping 的别名 key */
export function channelModelNames(channel: Channel): string[] {
  return [...channel.models.map((m) => exposedName(channel, m)), ...Object.keys(channel.model_mapping ?? {})]
}

/** 渠道是否支持该模型（模型列表 或 通过 model_mapping 的别名 key）*/
export function channelSupportsModel(channel: Channel, model: string): boolean {
  if (listedModel(channel, model) !== undefined) return true
  if (channel.model_mapping && Object.hasOwn(channel.model_mapping, model)) return true
  return false
}
