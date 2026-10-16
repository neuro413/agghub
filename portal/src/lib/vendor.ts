// 门户没有模型元数据，按模型名推断供应商，用于模型列表的筛选与图标；先匹配特征明显的，OpenAI 的短前缀放最后

export const OTHER_VENDOR = '其他'

const VENDORS: [string, RegExp][] = [
  ['Anthropic', /claude/],
  ['Google', /gemini|gemma|imagen|veo-|learnlm/],
  ['DeepSeek', /deepseek/],
  ['xAI', /grok/],
  ['通义千问', /qwen|qwq|qvq/],
  ['智谱', /glm|zhipu|cogview|cogvideo/],
  ['Moonshot', /kimi|moonshot/],
  ['MiniMax', /minimax|abab/],
  ['豆包', /doubao|^seed/],
  ['Meta', /llama/],
  ['Mistral', /mistral|mixtral|codestral|magistral|devstral|pixtral/],
  ['腾讯混元', /hunyuan/],
  ['文心', /ernie/],
  ['Cohere', /command-|cohere/],
  ['OpenAI', /(^|[^a-z])(gpt|chatgpt|o\d|codex|dall-e|whisper|tts-|text-embedding|omni-moderation|sora)/],
]

/** 只看最后一段，兼容 openai/gpt-4o 这类带前缀的名字 */
export function vendorOf(model: string): string {
  const name = model.toLowerCase().split('/').pop() ?? ''
  return VENDORS.find(([, pattern]) => pattern.test(name))?.[0] ?? OTHER_VENDOR
}

const TONES = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5']

/** 同一供应商固定一种颜色 */
export function vendorTone(vendor: string): string {
  if (vendor === OTHER_VENDOR) return 'neutral'
  let hash = 0
  for (const ch of vendor) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return TONES[Math.abs(hash) % TONES.length]
}
