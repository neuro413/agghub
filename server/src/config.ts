import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** server/ 目录 */
export const SERVER_ROOT = path.resolve(__dirname, '..')
/** 项目根 agghub/ */
export const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..')
/** SQLite 数据目录；测试必须在进程启动前指定隔离位置。 */
export const DATA_DIR = path.resolve(process.env.AGGHUB_DATA_DIR || path.join(PROJECT_ROOT, 'data'))
if (process.env.AGGHUB_TESTING === '1' && DATA_DIR.toLowerCase() === path.join(PROJECT_ROOT, 'data').toLowerCase()) {
  throw new Error('测试禁止使用项目实际 data 目录，请通过隔离测试启动器运行')
}
/** 数据库文件 */
export const DB_PATH = path.join(DATA_DIR, 'agghub.db')
/** 前端构建产物（生产托管）*/
export const WEB_DIST = path.resolve(PROJECT_ROOT, 'web', 'dist')
/** 网关端口（默认 3210，避开常见代理端口）*/
export const PORT = Number(process.env.PORT) || 3210

/** settings 表的默认值（值统一以字符串存储）*/
export const DEFAULT_SETTINGS: Record<string, string> = {
  single_retry_times: '1',
  channel_retry_times: '2',
  retry_interval_ms: '0',
  request_timeout_ms: '120000',
  request_max_duration_ms: '1800000',
  log_response_max_bytes: '4194304',
  stream_buffer_max_bytes: '16777216',
  image_max_bytes: '20971520',
  failover_strategy: 'priority_descend',
  auto_ban: '1',
  auto_ban_codes: '401,403',
  log_retention_days: '30',
  store_request_body: '1',
  store_response_body: '1',
  access_token: '',
  drop_thinking: '0',
  drop_thinking_keep_last: '0',
  drop_thinking_channel_ids: '[]',
  drop_thinking_models: '[]',
  drop_redacted_thinking: '0',
  strip_top_p: '0',
  preprocess_rules: '[]',
  tool_filter_rules: '[]',
  param_rules: '[]',
  // 伪思考（伪原生思维链）：仅对 Anthropic 入口→Anthropic 上游直通生效，需 drop_thinking 先开启
  pseudo_thinking_enabled: '0',
  pseudo_thinking_channel_ids: '[]',
  pseudo_thinking_models: '[]',
  pseudo_thinking_open_tag: '<thinking>',
  pseudo_thinking_close_tag: '</thinking>',
  pseudo_thinking_prompt:
    '在正式回复前，请先在 <thinking> 与 </thinking> 之间完整写出你的思考过程：使用简体中文，详尽自然，长度随问题复杂程度调整；思考结束后再给出正式回复。',
  pseudo_thinking_store_max: '5000',
  // 跨格式思维链往返：Responses 上游密文暂存上限；是否允许自动调整 max_tokens / 采样参数
  reasoning_store_max: '2000',
  reasoning_auto_adjust: '1',
  proxy_url: '',
}
