import { Router } from 'express'
import { db, getChannelById, getSettings, rowToChannel } from '../db'
import { getProxyAgent } from '../core/proxy'
import { resetChannelHealth } from '../core/channelHealth'
import { channelKeys, keyCounts, keyStatuses, pruneKeyStates, resetKeyStates } from '../core/channelKeys'
import { removeChannelFromGroups } from '../core/groups'
import { trimSlash, withV1 } from '../adapters/base'
import type { ChannelRow, ChannelType, KeyMode, SingleRoleMode } from '../types'

export const channelsRouter = Router()

const TYPES: ChannelType[] = ['openai', 'anthropic', 'vertex', 'responses']
const SINGLE_ROLE_MODES: SingleRoleMode[] = ['user', 'system']
const KEY_MODES: KeyMode[] = ['poll', 'race']

function startOfToday(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

interface ChannelInput {
  name?: string
  type?: ChannelType
  base_url?: string | null
  base_url_full?: boolean
  models_url?: string | null
  api_key?: string
  models?: string[] | string
  model_mapping?: Record<string, string> | null
  model_alias?: Record<string, string> | null
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
  key_mode?: KeyMode | null
  key_concurrency?: number
  key_cooldown_seconds?: number
}

function normalizeModels(m: string[] | string | undefined): string[] {
  if (Array.isArray(m)) return m.map((x) => String(x).trim()).filter(Boolean)
  if (typeof m === 'string') return m.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)
  return []
}

/** 专属名只保留模型列表里的模型，去掉空值和与原名相同的项 */
function normalizeAlias(input: ChannelInput): Record<string, string> | null {
  const alias = input.model_alias
  if (!alias || typeof alias !== 'object' || Array.isArray(alias)) return null
  const models = normalizeModels(input.models)
  const out: Record<string, string> = {}
  for (const [model, name] of Object.entries(alias)) {
    const value = String(name ?? '').trim()
    if (models.includes(model) && value && value !== model) out[model] = value
  }
  return Object.keys(out).length ? out : null
}

function aliasColumn(input: ChannelInput): string | null {
  const alias = normalizeAlias(input)
  return alias && JSON.stringify(alias)
}

/** 完整地址模式只对非 Vertex 渠道生效；关闭时不保留模型列表地址 */
function fullUrlColumns(input: ChannelInput): { base_url_full: number; models_url: string | null } {
  const full = !!input.base_url_full && input.type !== 'vertex'
  return { base_url_full: full ? 1 : 0, models_url: full ? input.models_url?.trim() || null : null }
}

/** 多 key 字段：Vertex 不支持；并发数限制在 2~20，冷却秒数至少 1 */
function keyColumns(input: ChannelInput): { key_mode: KeyMode | null; key_concurrency: number; key_cooldown_seconds: number } {
  const mode = input.type !== 'vertex' && input.key_mode && KEY_MODES.includes(input.key_mode) ? input.key_mode : null
  return {
    key_mode: mode,
    key_concurrency: Math.min(20, Math.max(2, Math.round(Number(input.key_concurrency) || 2))),
    key_cooldown_seconds: Math.max(1, Math.round(Number(input.key_cooldown_seconds) || 300)),
  }
}

/** 测试连接与拉取模型使用的 key：多 key 模式取第一个 */
function probeKey(input: ChannelInput): string {
  return (channelKeys({ api_key: input.api_key || '', key_mode: keyColumns(input).key_mode })[0] ?? '').trim()
}

/** 完整地址模式的模型列表地址：优先用填写的地址，否则把结尾的接口路径换成 /models */
function modelsUrlOf(input: ChannelInput): string | null {
  const custom = input.models_url?.trim()
  if (custom) return custom
  const base = trimSlash(input.base_url?.trim() || '')
  return /\/(chat\/completions|completions|messages|responses)$/.test(base)
    ? base.replace(/\/(chat\/completions|completions|messages|responses)$/, '/models')
    : null
}

function validate(input: ChannelInput): string | null {
  if (!input.name || !input.name.trim()) return '渠道名称不能为空'
  if (!input.type || !TYPES.includes(input.type)) return '渠道类型必须是 openai / anthropic / vertex / responses'
  const models = normalizeModels(input.models)
  if (models.length === 0) return '至少配置一个模型'
  const aliases = Object.values(normalizeAlias(input) ?? {})
  if (new Set(aliases).size !== aliases.length || aliases.some((name) => models.includes(name))) {
    return '模型专属名不能重复，也不能与模型列表中的模型同名'
  }
  if (input.base_url_full && input.type !== 'vertex' && !input.base_url?.trim()) return '完整地址模式下 Base URL 不能为空'
  if (input.single_role != null && !SINGLE_ROLE_MODES.includes(input.single_role)) return '单 role 兼容模式必须是 user / system'
  if (input.key_mode != null && !KEY_MODES.includes(input.key_mode)) return '多 key 模式必须是 poll / race'
  const keyMode = keyColumns(input).key_mode
  if (keyMode && !channelKeys({ api_key: input.api_key || '', key_mode: keyMode }).length) return '多 key 模式下至少填写一个 key'
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
    const keys = keyCounts(ch)
    return { ...ch, today_requests: s.total || 0, today_success: s.ok || 0, key_total: keys?.total, key_available: keys?.available }
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
      `INSERT INTO channels (name, type, base_url, base_url_full, models_url, api_key, models, model_mapping, model_alias, priority, weight, status, region, timeout_ms, ua_override, ua_value, strip_headers, single_role, single_role_merge_system, single_role_exclude_last_user, key_mode, key_concurrency, key_cooldown_seconds, created_at, updated_at)
       VALUES (@name, @type, @base_url, @base_url_full, @models_url, @api_key, @models, @model_mapping, @model_alias, @priority, @weight, @status, @region, @timeout_ms, @ua_override, @ua_value, @strip_headers, @single_role, @single_role_merge_system, @single_role_exclude_last_user, @key_mode, @key_concurrency, @key_cooldown_seconds, @created_at, @updated_at)`,
    )
    .run({
      name: input.name!.trim(),
      type: input.type!,
      base_url: input.base_url?.trim() || null,
      ...fullUrlColumns(input),
      api_key: (input.api_key || '').trim(),
      models: JSON.stringify(normalizeModels(input.models)),
      model_mapping: input.model_mapping ? JSON.stringify(input.model_mapping) : null,
      model_alias: aliasColumn(input),
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
      ...keyColumns(input),
      created_at: now,
      updated_at: now,
    })
  const created = getChannelById(Number(info.lastInsertRowid))!
  pruneKeyStates(created)
  res.json(created)
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
       name=@name, type=@type, base_url=@base_url, base_url_full=@base_url_full, models_url=@models_url, api_key=@api_key, models=@models,
       model_mapping=@model_mapping, model_alias=@model_alias, priority=@priority, weight=@weight, status=@status,
       region=@region, timeout_ms=@timeout_ms, ua_override=@ua_override, ua_value=@ua_value, strip_headers=@strip_headers,
       single_role=@single_role, single_role_merge_system=@single_role_merge_system, single_role_exclude_last_user=@single_role_exclude_last_user,
       key_mode=@key_mode, key_concurrency=@key_concurrency, key_cooldown_seconds=@key_cooldown_seconds,
       ban_until=@ban_until,
       updated_at=@updated_at
     WHERE id=@id`,
  ).run({
    id,
    name: (input.name ?? existing.name).trim(),
    type: input.type ?? existing.type,
    base_url: input.base_url !== undefined ? input.base_url?.trim() || null : existing.base_url,
    ...fullUrlColumns({ ...existing, ...input }),
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
    model_alias: aliasColumn({ ...existing, ...input }),
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
    ...keyColumns({ ...existing, ...input }),
    ban_until: statusChanged ? null : existing.ban_until,
    updated_at: Date.now(),
  })
  // 手动改状态视为恢复：清掉熔断恢复时间与内存计数；状态没变（如编辑名称时回传原状态）不影响自动恢复
  if (statusChanged) resetChannelHealth(id)
  const updated = getChannelById(id)!
  pruneKeyStates(updated)
  res.json(updated)
})

// 多 key 渠道的 key 状态（脱敏）
channelsRouter.get('/:id/keys', (req, res) => {
  const channel = getChannelById(Number(req.params.id))
  if (!channel) return res.status(404).json({ error: 'not found' })
  res.json(keyStatuses(channel))
})

// 手动重置 key 熔断：带 fingerprint 只重置一个，否则全部重置
channelsRouter.post('/:id/keys/reset', (req, res) => {
  const channel = getChannelById(Number(req.params.id))
  if (!channel) return res.status(404).json({ error: 'not found' })
  const fingerprint = typeof req.body?.fingerprint === 'string' ? req.body.fingerprint : undefined
  resetKeyStates(channel.id, fingerprint)
  res.json(keyStatuses(channel))
})

channelsRouter.delete('/:id', (req, res) => {
  const id = Number(req.params.id)
  db.prepare('DELETE FROM channels WHERE id = ?').run(id)
  removeChannelFromGroups(id)
  resetChannelHealth(id)
  resetKeyStates(id)
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
  const key = probeKey(input)
  const base = input.base_url?.trim() ? trimSlash(input.base_url.trim()) : ''
  const dispatcher = proxyUrl ? getProxyAgent(proxyUrl) : undefined

  // openai / responses / anthropic：GET /v1/models；完整地址模式用模型列表地址
  if (input.type !== 'vertex') {
    const anthropic = input.type === 'anthropic'
    const root = base || (anthropic ? 'https://api.anthropic.com' : 'https://api.openai.com')
    const headers = anthropic ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${key}` }
    const url = input.base_url_full && base ? modelsUrlOf(input) : withV1(root) + '/models'
    if (!url) return { ok: false, message: '无法从完整地址推导模型列表地址，请填写「模型列表地址」' }
    const r = await fetch(url, { headers, signal, dispatcher } as any)
    if (!r.ok) return failure(r)
    const data: any = await r.json().catch(() => ({}))
    const models = Array.isArray(data?.data) ? data.data.map((m: any) => m.id) : undefined
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
