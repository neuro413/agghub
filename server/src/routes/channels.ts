import { Router } from 'express'
import { db, getChannelById, getSettings, rowToChannel } from '../db'
import { getProxyAgent } from '../core/proxy'
import { resetChannelHealth } from '../core/channelHealth'
import { trimSlash, withV1 } from '../adapters/base'
import type { ChannelRow, ChannelType, SingleRoleMode } from '../types'

export const channelsRouter = Router()

const TYPES: ChannelType[] = ['openai', 'anthropic', 'vertex', 'responses']
const SINGLE_ROLE_MODES: SingleRoleMode[] = ['user', 'system']

function startOfToday(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

interface ChannelInput {
  name?: string
  type?: ChannelType
  base_url?: string | null
  api_key?: string
  models?: string[] | string
  model_mapping?: Record<string, string> | null
  priority?: number
  weight?: number
  status?: number
  region?: string | null
  timeout_ms?: number | null
  ua_override?: boolean
  ua_value?: string | null
  strip_headers?: boolean
  single_role?: SingleRoleMode | null
  single_role_merge_system?: boolean
  single_role_exclude_last_user?: boolean
  groups?: string[] | string
}

function normalizeModels(m: string[] | string | undefined): string[] {
  if (Array.isArray(m)) return m.map((x) => String(x).trim()).filter(Boolean)
  if (typeof m === 'string') return m.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)
  return []
}

/** 数组或逗号/换行分隔的字符串 → 去空去重；为空时归入 default */
function normalizeGroups(g: string[] | string | undefined): string[] {
  const list = Array.isArray(g) ? g.map((x) => String(x)) : typeof g === 'string' ? g.split(/[,\n]/) : []
  const out: string[] = []
  for (const item of list) {
    const name = item.trim()
    if (name && !out.includes(name)) out.push(name)
  }
  return out.length ? out : ['default']
}

function validate(input: ChannelInput): string | null {
  if (!input.name || !input.name.trim()) return '渠道名称不能为空'
  if (!input.type || !TYPES.includes(input.type)) return '渠道类型必须是 openai / anthropic / vertex / responses'
  if (normalizeModels(input.models).length === 0) return '至少配置一个模型'
  if (input.single_role != null && !SINGLE_ROLE_MODES.includes(input.single_role)) return '单 role 兼容模式必须是 user / system'
  if (input.groups !== undefined && !normalizeGroups(input.groups).every((g) => g.length <= 32 && !g.includes(','))) {
    return '分组名须为 1～32 字符且不含逗号'
  }
  return null
}

// 列表（附带今日请求数 / 成功数）
channelsRouter.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM channels ORDER BY priority DESC, id ASC').all() as ChannelRow[]
  const since = startOfToday()
  const statStmt = db.prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS ok
     FROM request_logs WHERE channel_id = ? AND created_at >= ? AND is_retry = 0`,
  )
  const list = rows.map((r) => {
    const ch = rowToChannel(r)
    const s = statStmt.get(r.id, since) as { total: number; ok: number }
    return { ...ch, today_requests: s.total || 0, today_success: s.ok || 0 }
  })
  res.json(list)
})

channelsRouter.post('/', (req, res) => {
  const input = req.body as ChannelInput
  const err = validate(input)
  if (err) return res.status(400).json({ error: err })

  const now = Date.now()
  const info = db
    .prepare(
      `INSERT INTO channels (name, type, base_url, api_key, models, model_mapping, priority, weight, status, region, timeout_ms, ua_override, ua_value, strip_headers, single_role, single_role_merge_system, single_role_exclude_last_user, groups, created_at, updated_at)
       VALUES (@name, @type, @base_url, @api_key, @models, @model_mapping, @priority, @weight, @status, @region, @timeout_ms, @ua_override, @ua_value, @strip_headers, @single_role, @single_role_merge_system, @single_role_exclude_last_user, @groups, @created_at, @updated_at)`,
    )
    .run({
      name: input.name!.trim(),
      type: input.type!,
      base_url: input.base_url?.trim() || null,
      api_key: (input.api_key || '').trim(),
      models: JSON.stringify(normalizeModels(input.models)),
      model_mapping: input.model_mapping ? JSON.stringify(input.model_mapping) : null,
      priority: Number.isFinite(input.priority) ? Number(input.priority) : 0,
      weight: Number.isFinite(input.weight) ? Number(input.weight) : 1,
      status: input.status === 0 ? 0 : 1,
      region: input.region?.trim() || null,
      timeout_ms: input.timeout_ms ? Number(input.timeout_ms) : null,
      ua_override: input.ua_override ? 1 : 0,
      ua_value: input.ua_value?.trim() || null,
      strip_headers: input.strip_headers ? 1 : 0,
      single_role: input.single_role || null,
      single_role_merge_system: input.single_role_merge_system ? 1 : 0,
      single_role_exclude_last_user: input.single_role_exclude_last_user ? 1 : 0,
      groups: JSON.stringify(normalizeGroups(input.groups)),
      created_at: now,
      updated_at: now,
    })
  res.json(getChannelById(Number(info.lastInsertRowid)))
})

channelsRouter.put('/:id', (req, res) => {
  const id = Number(req.params.id)
  const existing = getChannelById(id)
  if (!existing) return res.status(404).json({ error: 'not found' })

  const input = req.body as ChannelInput
  const err = validate({ ...existing, ...input })
  if (err) return res.status(400).json({ error: err })
  const statusChanged = input.status !== undefined && Number(input.status) !== existing.status

  db.prepare(
    `UPDATE channels SET
       name=@name, type=@type, base_url=@base_url, api_key=@api_key, models=@models,
       model_mapping=@model_mapping, priority=@priority, weight=@weight, status=@status,
       region=@region, timeout_ms=@timeout_ms, ua_override=@ua_override, ua_value=@ua_value, strip_headers=@strip_headers,
       single_role=@single_role, single_role_merge_system=@single_role_merge_system, single_role_exclude_last_user=@single_role_exclude_last_user,
       groups=@groups, ban_until=@ban_until,
       updated_at=@updated_at
     WHERE id=@id`,
  ).run({
    id,
    name: (input.name ?? existing.name).trim(),
    type: input.type ?? existing.type,
    base_url: input.base_url !== undefined ? input.base_url?.trim() || null : existing.base_url,
    api_key: (input.api_key ?? existing.api_key).trim(),
    models: JSON.stringify(input.models !== undefined ? normalizeModels(input.models) : existing.models),
    model_mapping:
      input.model_mapping !== undefined
        ? input.model_mapping
          ? JSON.stringify(input.model_mapping)
          : null
        : existing.model_mapping
          ? JSON.stringify(existing.model_mapping)
          : null,
    priority: input.priority !== undefined ? Number(input.priority) : existing.priority,
    weight: input.weight !== undefined ? Number(input.weight) : existing.weight,
    status: input.status !== undefined ? Number(input.status) : existing.status,
    region: input.region !== undefined ? input.region?.trim() || null : existing.region,
    timeout_ms: input.timeout_ms !== undefined ? (input.timeout_ms ? Number(input.timeout_ms) : null) : existing.timeout_ms,
    ua_override: input.ua_override !== undefined ? (input.ua_override ? 1 : 0) : existing.ua_override ? 1 : 0,
    ua_value: input.ua_value !== undefined ? input.ua_value?.trim() || null : existing.ua_value,
    strip_headers: input.strip_headers !== undefined ? (input.strip_headers ? 1 : 0) : existing.strip_headers ? 1 : 0,
    single_role: input.single_role !== undefined ? input.single_role || null : existing.single_role,
    single_role_merge_system:
      input.single_role_merge_system !== undefined ? (input.single_role_merge_system ? 1 : 0) : existing.single_role_merge_system ? 1 : 0,
    single_role_exclude_last_user:
      input.single_role_exclude_last_user !== undefined
        ? (input.single_role_exclude_last_user ? 1 : 0)
        : existing.single_role_exclude_last_user ? 1 : 0,
    groups: input.groups !== undefined ? JSON.stringify(normalizeGroups(input.groups)) : JSON.stringify(existing.groups),
    ban_until: statusChanged ? null : existing.ban_until,
    updated_at: Date.now(),
  })
  // 手动改状态视为恢复：清掉熔断恢复时间与内存计数；状态没变（如编辑名称时回传原状态）不影响自动恢复
  if (statusChanged) resetChannelHealth(id)
  res.json(getChannelById(id))
})

channelsRouter.delete('/:id', (req, res) => {
  const id = Number(req.params.id)
  db.prepare('DELETE FROM channels WHERE id = ?').run(id)
  resetChannelHealth(id)
  res.json({ ok: true })
})

// 连通性测试（用请求体里的配置，未保存也能测）
channelsRouter.post('/test', async (req, res) => {
  const input = req.body as ChannelInput
  if (!input.type || !TYPES.includes(input.type)) return res.status(400).json({ ok: false, message: '渠道类型无效' })

  const started = Date.now()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 10_000)
  const close = () => { if (!res.writableEnded) ac.abort() }
  res.on('close', close)
  try {
    const proxyUrl = getSettings().proxy_url || undefined
    const result = await probe(input, ac.signal, proxyUrl)
    if (!res.destroyed) res.json({ ...result, latency_ms: Date.now() - started })
  } catch (e: any) {
    if (!res.destroyed) res.json({ ok: false, message: e?.name === 'AbortError' ? '请求超时' : String(e?.message || e), latency_ms: Date.now() - started })
  } finally {
    clearTimeout(timer)
    res.off('close', close)
    ac.abort()
  }
})

async function failure(r: Response): Promise<{ ok: false; message: string }> {
  return { ok: false, message: `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` }
}

async function probe(input: ChannelInput, signal: AbortSignal, proxyUrl?: string): Promise<{ ok: boolean; message: string; models?: string[] }> {
  const key = (input.api_key || '').trim()
  const base = input.base_url?.trim() ? trimSlash(input.base_url.trim()) : ''
  const dispatcher = proxyUrl ? getProxyAgent(proxyUrl) : undefined

  // openai / responses / anthropic：GET /v1/models
  if (input.type !== 'vertex') {
    const anthropic = input.type === 'anthropic'
    const root = base || (anthropic ? 'https://api.anthropic.com' : 'https://api.openai.com')
    const headers = anthropic ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${key}` }
    const r = await fetch(withV1(root) + '/models', { headers, signal, dispatcher } as any)
    if (!r.ok) return failure(r)
    const data: any = await r.json().catch(() => ({}))
    const models = Array.isArray(data?.data) ? data.data.map((m: any) => m.id).slice(0, 50) : undefined
    return { ok: true, message: '连接成功', models }
  }

  // vertex：发一个 1 token 的生成请求
  const { parseCredentials, getAccessToken } = await import('../adapters/vertex-auth')
  const creds = parseCredentials(key)
  const region = input.region?.trim() || 'global'
  const host = region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`
  const v1 = withV1(base || `https://${host}`)
  const model = normalizeModels(input.models)[0] || 'gemini-2.0-flash'
  const isClaude = model.startsWith('claude')
  const geminiBody = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 1 } })
  const claudeBody = JSON.stringify({ anthropic_version: 'vertex-2023-10-16', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] })
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  let url: string
  if (creds) {
    try {
      headers.authorization = `Bearer ${await getAccessToken(creds, proxyUrl, signal)}`
    } catch (e: any) {
      return { ok: false, message: `获取 access_token 失败: ${e.message?.slice(0, 200)}` }
    }
    url = isClaude
      ? `${v1}/projects/${creds.project_id}/locations/${region}/publishers/anthropic/models/${model}:rawPredict`
      : `${v1}/projects/${creds.project_id}/locations/${region}/publishers/google/models/${model}:generateContent`
  } else {
    // API Key 模式（仅 Gemini 支持）
    url = `${v1}/publishers/google/models/${model}:generateContent?key=${encodeURIComponent(key)}`
  }
  const r = await fetch(url, { method: 'POST', headers, body: creds && isClaude ? claudeBody : geminiBody, signal, dispatcher } as any)
  if (!r.ok) return failure(r)
  await r.body?.cancel()
  return { ok: true, message: creds ? '连接成功（JSON 凭证）' : '连接成功' }
}
