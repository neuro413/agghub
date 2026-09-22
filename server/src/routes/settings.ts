import { Router } from 'express'
import { getSettings, setSettings } from '../db'

export const settingsRouter = Router()

settingsRouter.get('/', (_req, res) => {
  res.json(getSettings())
})

settingsRouter.put('/', (req, res) => {
  const allowed = [
    'single_retry_times',
    'channel_retry_times',
    'retry_interval_ms',
    'request_timeout_ms',
    'failover_strategy',
    'auto_ban',
    'auto_ban_codes',
    'log_retention_days',
    'store_request_body',
    'store_response_body',
    'access_token',
    'drop_thinking',
    'drop_thinking_keep_last',
    'drop_thinking_channel_ids',
    'drop_thinking_models',
    'drop_redacted_thinking',
    'strip_top_p',
    'preprocess_rules',
    'tool_filter_rules',
    'param_rules',
    'pseudo_thinking_enabled',
    'pseudo_thinking_channel_ids',
    'pseudo_thinking_models',
    'pseudo_thinking_open_tag',
    'pseudo_thinking_close_tag',
    'pseudo_thinking_prompt',
    'pseudo_thinking_store_max',
    'reasoning_store_max',
    'reasoning_auto_adjust',
    'proxy_url',
  ]
  const patch: Record<string, string | number | boolean> = {}
  for (const k of allowed) {
    if (k in req.body) {
      const v = req.body[k]
      // 复杂结构（如 preprocess_rules 数组）须先 JSON 序列化，否则 setSettings 的 String(v) 会写成 [object Object]
      patch[k] = v !== null && typeof v === 'object' ? JSON.stringify(v) : v
    }
  }
  setSettings(patch)
  res.json(getSettings())
})
