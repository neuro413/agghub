import type { Caller, Settings } from '../types'

/** 未经鉴权中间件的调用（测试、内部调用）一律视为内网 owner，保持旧行为 */
export const OWNER_CALLER: Caller = Object.freeze({ surface: 'lan', source: 'owner', key: null, ip: '' }) as Caller

/** 按 Key 的正文开关覆盖本次请求的设置快照；null 跟随全局 */
export function callerSettings(settings: Settings, caller: Caller): Settings {
  const flag = caller.key?.log_bodies
  if (flag == null) return settings
  return { ...settings, store_request_body: flag, store_response_body: flag }
}
