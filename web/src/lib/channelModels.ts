import type { Channel } from '../types'

/** 渠道对外可请求的模型名：模型列表（设了专属名的换成专属名）+ 重映射别名，与后端选路一致 */
export function channelModelNames(c: Channel): string[] {
  const alias = c.model_alias
  const listed = (c.models || []).map((m) => (alias && Object.hasOwn(alias, m) && alias[m]) || m)
  return [...listed, ...Object.keys(c.model_mapping || {})]
}
