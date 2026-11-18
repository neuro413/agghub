import { Router } from 'express'
import { db, getChannelById, getSettings, rowToChannel } from '../db'
import { getProxyAgent } from '../core/proxy'
import { resetChannelHealth } from '../core/channelHealth'
import { channelKeys, keyCounts, keyStatuses, pruneKeyStates, resetKeyStates } from '../core/channelKeys'
import { removeChannelFromGroups } from '../core/groups'
import { resolveUpstreamModel } from '../core/selector'
import { applyUserAgent } from '../core/relay'
import { readBodyText } from '../core/bodyReader'
import { ZSTD_AVAILABLE, algorithmPlan, clearUnsupported, compressBody, isCompressionRejection, unsupportedList } from '../core/upstreamCompression'
import { getAdaptor } from '../adapters'
import { acquireNode, noNodeMessage, type Lease } from '../pool/select'
import { trimSlash, withV1 } from '../adapters/base'
import { geminiApiRoot } from '../adapters/gemini'
import type { Channel, ChannelRow, ChannelType, CompressionAlgorithm, CompressionTestItem, CompressionTestResult, KeyMode, RequestCompression, SingleRoleMode } from '../types'

export const channelsRouter = Router()

const TYPES: ChannelType[] = ['openai', 'anthropic', 'vertex', 'responses', 'gemini']
/** 不支持完整地址模式的渠道：请求地址随模型与流式动作变化 */
const NO_FULL_URL: ChannelType[] = ['vertex', 'gemini']
const SINGLE_ROLE_MODES: SingleRoleMode[] = ['user', 'system']
const KEY_MODES: KeyMode[] = ['poll', 'race']
const REQUEST_COMPRESSIONS: RequestCompression[] = ['off', 'gzip', 'br', 'zstd']

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
  /** null = 跟随全局 */
  request_compression?: RequestCompression | null
  always_retry?: boolean
  fake_stream?: boolean
  proxy_pool?: boolean
  proxy_pool_include?: string | null
  proxy_pool_exclude?: string | null
}

/** 代理池字段：关键词 trim 后为空存 null */
function poolColumns(input: ChannelInput): { proxy_pool: number; proxy_pool_include: string | null; proxy_pool_exclude: string | null } {
  return {
    proxy_pool: input.proxy_pool ? 1 : 0,
    proxy_pool_include: input.proxy_pool_include?.trim() || null,
    proxy_pool_exclude: input.proxy_pool_exclude?.trim() || null,
  }
}

/** 测试类接口的出口：渠道开启代理池时租一个节点（测试结果不计入节点健康），否则用全局代理 */
function testEgress(input: ChannelInput): { proxyUrl?: string; lease: Lease | null; error?: string } {
  if (!input.proxy_pool) return { proxyUrl: getSettings().proxy_url || undefined, lease: null }
  const lease = acquireNode({ include: input.proxy_pool_include, exclude: input.proxy_pool_exclude })
  return lease ? { proxyUrl: lease.url, lease } : { lease: null, error: noNodeMessage() }
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

/** 完整地址模式只对非 Vertex / Gemini 渠道生效；关闭时不保留模型列表地址 */
function fullUrlColumns(input: ChannelInput): { base_url_full: number; models_url: string | null } {
  const full = !!input.base_url_full && !NO_FULL_URL.includes(input.type!)
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
  if (!input.type || !TYPES.includes(input.type)) return '渠道类型必须是 openai / anthropic / vertex / responses / gemini'
  const models = normalizeModels(input.models)
  if (models.length === 0) return '至少配置一个模型'
  const aliases = Object.values(normalizeAlias(input) ?? {})
  if (new Set(aliases).size !== aliases.length || aliases.some((name) => models.includes(name))) {
    return '模型专属名不能重复，也不能与模型列表中的模型同名'
  }
  if (input.base_url_full && !NO_FULL_URL.includes(input.type) && !input.base_url?.trim()) return '完整地址模式下 Base URL 不能为空'
  if (input.single_role != null && !SINGLE_ROLE_MODES.includes(input.single_role)) return '单 role 兼容模式必须是 user / system'
  if (input.key_mode != null && !KEY_MODES.includes(input.key_mode)) return '多 key 模式必须是 poll / race'
  if (input.request_compression != null && !REQUEST_COMPRESSIONS.includes(input.request_compression)) return '请求体压缩必须是 off / gzip / br / zstd'
  const keyMode = keyColumns(input).key_mode
  if (keyMode && !channelKeys({ api_key: input.api_key || '', key_mode: keyMode }).length) return '多 key 模式下至少填写一个 key'
  return null
}

// 列表（附带今日请求数 / 成功数 / 成功请求平均延迟 / 按小时请求数）
channelsRouter.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM channels ORDER BY priority DESC, id ASC').all() as ChannelRow[]
  const since = startOfToday()
  // 一条分组语句查完所有渠道，避免每个渠道各查一次
  const stats = new Map(
    (db.prepare(
      `SELECT channel_id, COUNT(*) AS total, SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS ok,
              AVG(CASE WHEN status='success' THEN latency_ms END) AS avg_latency
       FROM request_logs WHERE created_at >= ? AND is_retry = 0 AND channel_id IS NOT NULL GROUP BY channel_id`,
    ).all(since) as { channel_id: number; total: number; ok: number; avg_latency: number | null }[]).map((s) => [s.channel_id, s]),
  )
  const hourly = new Map<number, number[]>()
  const hourRows = db.prepare(
    `SELECT channel_id, CAST((created_at - ?) / 3600000 AS INTEGER) AS h, COUNT(*) AS n
     FROM request_logs WHERE created_at >= ? AND is_retry = 0 AND channel_id IS NOT NULL GROUP BY channel_id, h`,
  ).all(since, since) as { channel_id: number; h: number; n: number }[]
  for (const r of hourRows) {
    let arr = hourly.get(r.channel_id)
    if (!arr) hourly.set(r.channel_id, (arr = Array(24).fill(0)))
    // 夏令时切换日可能多出一小时，并入最后一格
    arr[Math.min(23, Math.max(0, r.h))] += r.n
  }
  const list = rows.map((r) => {
    const ch = rowToChannel(r)
    const s = stats.get(r.id)
    const keys = keyCounts(ch)
    return {
      ...ch, today_requests: s?.total || 0, today_success: s?.ok || 0,
      today_avg_latency: s?.avg_latency == null ? null : Math.round(s.avg_latency),
      today_hourly: hourly.get(r.id) ?? Array(24).fill(0),
      key_total: keys?.total, key_available: keys?.available,
      compression_unsupported: unsupportedList(ch.id),
    }
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
      `INSERT INTO channels (name, type, base_url, base_url_full, models_url, api_key, models, model_mapping, model_alias, priority, weight, status, region, timeout_ms, ua_override, ua_value, strip_headers, single_role, single_role_merge_system, single_role_exclude_last_user, key_mode, key_concurrency, key_cooldown_seconds, request_compression, always_retry, fake_stream, proxy_pool, proxy_pool_include, proxy_pool_exclude, created_at, updated_at)
       VALUES (@name, @type, @base_url, @base_url_full, @models_url, @api_key, @models, @model_mapping, @model_alias, @priority, @weight, @status, @region, @timeout_ms, @ua_override, @ua_value, @strip_headers, @single_role, @single_role_merge_system, @single_role_exclude_last_user, @key_mode, @key_concurrency, @key_cooldown_seconds, @request_compression, @always_retry, @fake_stream, @proxy_pool, @proxy_pool_include, @proxy_pool_exclude, @created_at, @updated_at)`,
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
      request_compression: input.request_compression || null,
      always_retry: input.always_retry ? 1 : 0,
      fake_stream: input.fake_stream ? 1 : 0,
      ...poolColumns(input),
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
       request_compression=@request_compression, always_retry=@always_retry, fake_stream=@fake_stream, ban_until=@ban_until,
       proxy_pool=@proxy_pool, proxy_pool_include=@proxy_pool_include, proxy_pool_exclude=@proxy_pool_exclude,
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
    request_compression: input.request_compression !== undefined ? input.request_compression || null : existing.request_compression,
    always_retry: input.always_retry !== undefined ? (input.always_retry ? 1 : 0) : existing.always_retry ? 1 : 0,
    fake_stream: input.fake_stream !== undefined ? (input.fake_stream ? 1 : 0) : existing.fake_stream ? 1 : 0,
    ban_until: statusChanged ? null : existing.ban_until,
    ...poolColumns({ ...existing, ...input }),
    updated_at: Date.now(),
  })
  // 手动改状态视为恢复：清掉熔断恢复时间与内存计数；状态没变（如编辑名称时回传原状态）不影响自动恢复
  if (statusChanged) resetChannelHealth(id)
  // 保存渠道即清空该渠道的「压缩不支持」记忆
  clearUnsupported(id)
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
  clearUnsupported(id)
  res.json({ ok: true })
})

// 清除渠道的「压缩不支持」记忆
channelsRouter.post('/:id/compression/reset', (req, res) => {
  const channel = getChannelById(Number(req.params.id))
  if (!channel) return res.status(404).json({ error: 'not found' })
  clearUnsupported(channel.id)
  res.json({ unsupported: [] })
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
  const egress = testEgress(input)
  try {
    if (egress.error) {
      res.json({ ok: false, message: egress.error, latency_ms: 0 })
      return
    }
    const result = await probe(input, ac.signal, egress.proxyUrl)
    if (egress.lease) result.message += ` · 节点 ${egress.lease.node.name}`
    if (!res.destroyed) res.json({ ...result, latency_ms: Date.now() - started })
  } catch (e: any) {
    const node = egress.lease ? `（节点 ${egress.lease.node.name}）` : ''
    if (!res.destroyed) res.json({ ok: false, message: (e?.name === 'AbortError' ? '请求超时' : String(e?.message || e)) + node, latency_ms: Date.now() - started })
  } finally {
    egress.lease?.release()
    clearTimeout(timer)
    res.off('close', close)
    ac.abort()
  }
})

/** 用请求体里的配置组装渠道对象（未保存的渠道也能测），多 key 取第一个 */
function channelFromInput(input: ChannelInput): Channel {
  const now = Date.now()
  const full = fullUrlColumns(input)
  return {
    id: 0, name: input.name?.trim() || '', type: input.type!,
    base_url: input.base_url?.trim() || null, base_url_full: !!full.base_url_full, models_url: full.models_url,
    api_key: probeKey(input), models: normalizeModels(input.models),
    model_mapping: input.model_mapping || null, model_alias: normalizeAlias(input),
    priority: 0, weight: 1, status: 1, region: input.region?.trim() || null, timeout_ms: null,
    ua_override: !!input.ua_override, ua_value: input.ua_value?.trim() || null, strip_headers: !!input.strip_headers,
    single_role: null, single_role_merge_system: false, single_role_exclude_last_user: false,
    key_mode: null, key_concurrency: 2, key_cooldown_seconds: 300, ban_until: null,
    request_compression: null, always_retry: false, fake_stream: false, ...poolFields(input), created_at: now, updated_at: now,
  }
}

function poolFields(input: ChannelInput): Pick<Channel, 'proxy_pool' | 'proxy_pool_include' | 'proxy_pool_exclude'> {
  const columns = poolColumns(input)
  return { ...columns, proxy_pool: !!columns.proxy_pool }
}

const COMPRESSION_TEST_TIMEOUT_MS = 20_000

// 压缩测试：依次发送明文基线与 gzip / br / zstd 的最小请求，级别用当前全局设置；不受阈值影响，也不修改内存记忆
channelsRouter.post('/test-compression', async (req, res) => {
  const input = req.body as ChannelInput & { test_model?: string }
  if (!input.type || !TYPES.includes(input.type)) return res.status(400).json({ error: '渠道类型无效' })
  const model = (typeof input.test_model === 'string' && input.test_model.trim()) || normalizeModels(input.models)[0]
  if (!model) return res.status(400).json({ error: '至少配置一个模型' })

  const egress = testEgress(input)
  if (egress.error) return res.status(400).json({ error: egress.error })
  const ac = new AbortController()
  const close = () => { if (!res.writableEnded) ac.abort() }
  res.on('close', close)
  try {
    const settings = getSettings()
    const proxyUrl = egress.proxyUrl
    const dispatcher = egress.lease ? egress.lease.dispatcher : proxyUrl ? getProxyAgent(proxyUrl) : undefined
    const channel = channelFromInput(input)
    const adaptor = getAdaptor(channel.type)
    const upstreamModel = resolveUpstreamModel(channel, model)
    if (adaptor.prepareChannel) {
      await adaptor.prepareChannel(channel, proxyUrl, AbortSignal.any([ac.signal, AbortSignal.timeout(COMPRESSION_TEST_TIMEOUT_MS)]))
    }
    // Responses API 要求 max_output_tokens 至少 16
    const request = adaptor.buildRequest(channel, { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }, upstreamModel, false)
    applyUserAgent(request.headers, channel)
    const rawBytes = Buffer.byteLength(request.body)

    const send = async (algorithm: CompressionTestItem['algorithm'], label: string, body: string | Buffer): Promise<CompressionTestItem> => {
      const item: CompressionTestItem = {
        algorithm, label, verdict: 'error', status: null, latency_ms: 0, raw_bytes: rawBytes, sent_bytes: Buffer.byteLength(body), message: '',
      }
      const started = Date.now()
      const timeout = AbortSignal.timeout(COMPRESSION_TEST_TIMEOUT_MS)
      const signal = AbortSignal.any([ac.signal, timeout])
      try {
        const headers = algorithm === 'plain' ? request.headers : { ...request.headers, 'content-encoding': algorithm }
        const r = await fetch(request.url, { method: 'POST', headers, body, signal, dispatcher } as any)
        item.status = r.status
        if (r.ok) {
          item.verdict = 'ok'
          await r.body?.cancel()
        } else {
          const text = await readBodyText(r.body, { signal, maxBytes: 64 * 1024, truncate: true })
          if (algorithm !== 'plain' && isCompressionRejection(r.status, text, settings)) item.verdict = 'rejected'
          item.message = text.slice(0, 300)
        }
      } catch (e: any) {
        ac.signal.throwIfAborted()
        item.message = timeout.aborted ? '请求超时' : String(e?.message || e).slice(0, 300)
      }
      item.latency_ms = Date.now() - started
      return item
    }
    const skip = (algorithm: CompressionAlgorithm, label: string, message: string): CompressionTestItem => ({
      algorithm, label, verdict: 'skipped', status: null, latency_ms: 0, raw_bytes: rawBytes, sent_bytes: 0, message,
    })

    const baseline = await send('plain', 'plain', request.body)
    const items = [baseline]
    for (const algorithm of ['gzip', 'br', 'zstd'] as const) {
      const plan = algorithmPlan(algorithm, settings)
      if (algorithm === 'zstd' && !ZSTD_AVAILABLE) items.push(skip(algorithm, plan.label, '当前 Node 不支持 zstd'))
      else if (baseline.verdict !== 'ok') items.push(skip(algorithm, plan.label, '基线请求失败，无法判断'))
      else items.push(await send(algorithm, plan.label, await compressBody(request.body, plan)))
    }
    const result: CompressionTestResult = { model, items }
    if (!res.destroyed) res.json(result)
  } catch (e: any) {
    if (!res.destroyed && !ac.signal.aborted) res.status(400).json({ error: String(e?.message || e).slice(0, 300) })
  } finally {
    egress.lease?.release()
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

  // gemini（AI Studio）：分页拉取 GET /v1beta/models，只保留支持 generateContent 的模型
  if (input.type === 'gemini') {
    const root = geminiApiRoot(input.base_url)
    const headers: Record<string, string> = key ? { 'x-goog-api-key': key } : {}
    const models: string[] = []
    let pageToken = ''
    for (let page = 0; page < 20; page++) {
      const url = `${root}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
      const r = await fetch(url, { headers, signal, dispatcher } as any)
      if (!r.ok) return failure(r)
      const data: any = await r.json().catch(() => ({}))
      for (const m of Array.isArray(data?.models) ? data.models : []) {
        const methods = Array.isArray(m?.supportedGenerationMethods) ? m.supportedGenerationMethods : null
        if (typeof m?.name === 'string' && (!methods || methods.includes('generateContent'))) models.push(m.name.replace(/^models\//, ''))
      }
      pageToken = typeof data?.nextPageToken === 'string' ? data.nextPageToken : ''
      if (!pageToken) break
    }
    return { ok: true, message: '连接成功', models }
  }

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
