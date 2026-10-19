import { EventEmitter } from 'node:events'
import type { Response } from 'express'
import { allChannels, db, getSettings } from '../db'
import { findRatio } from './billing'
import { channelModelNames } from './channelModels'
import { listGroups } from './groups'
import { handleRelay } from './relay'
import { USER_ENABLED } from './users'
import type { Caller, Channel, ChannelGroup, ModelRatio } from '../types'

// 门户可用性页面：最近 6 小时按 10 分钟一格统计各模型的错误率；10 分钟内没有结果的模型自动测活一次

export const CELL_MS = 10 * 60_000
export const CELL_COUNT = 36
/** 当前格子只剩这么久仍没有结果时补测一次，避免测活间隔逐轮漂移、跳过整格 */
const COVER_MS = 60_000
const PROBE_TICK_MS = 30_000
const PROBE_CONCURRENCY = 3
/** 推理模型在过小的输出上限下可能只出推理、被判为空回复，留一点余量 */
const PROBE_MAX_TOKENS = 32

/**
 * 计入可用性的最终结果：测活全部计入；真实请求排除客户端自己造成的失败——
 * 客户端断开（499）、请求本身不合法（400 / 413 / 422），以及没走到渠道就被拒绝的 4xx（额度、限流、未定价等）。
 */
const COUNTED = `is_retry = 0 AND (source IS 'probe' OR status = 'success'
  OR NOT (IFNULL(status_code, 0) IN (400, 413, 422, 499) OR (channel_id IS NULL AND IFNULL(status_code, 0) < 500)))`

interface CountRow {
  model: string
  channel_id: number | null
  cell: number
  total: number
  errors: number
  probes: number
  last: number
}

const countStmt = db.prepare(
  `SELECT model, channel_id, CAST(created_at / ${CELL_MS} AS INTEGER) AS cell, COUNT(*) AS total,
          SUM(status = 'error') AS errors, SUM(source IS 'probe') AS probes, MAX(created_at) AS last
   FROM request_logs
   WHERE created_at >= ? AND ${COUNTED} AND model IN (SELECT value FROM json_each(?))
   GROUP BY model, channel_id, cell`,
)

/** since 之后计入可用性的结果，按模型 × 渠道 × 格子汇总 */
function countRows(models: string[], since: number): CountRow[] {
  return countStmt.all(since, JSON.stringify(models)) as CountRow[]
}

interface ModelChannels {
  /** 能以该模型名服务的渠道 */
  channels: Set<number>
  /** 提供该模型的分组 */
  groups: string[]
}

/** 结果是否属于这组渠道：本组渠道的结果，以及没走到渠道的失败（如无可用渠道） */
const belongs = (row: CountRow, entry: { channels: Set<number> }) => row.channel_id == null || entry.channels.has(row.channel_id)

/** 手动停用以外的渠道：熔断停用的照样算，模型显示为故障、测活如实失败 */
const listedChannels = () => allChannels().filter(c => c.status !== 0)

/** 分组里各模型由哪些渠道服务：渠道和模型都须在分组里勾选，且模型已定价 */
function modelChannels(groups: ChannelGroup[], ratios: ModelRatio[], channels: Channel[]): Map<string, ModelChannels> {
  const out = new Map<string, ModelChannels>()
  for (const group of groups) {
    for (const channel of channels) {
      if (!group.channel_ids.includes(channel.id)) continue
      for (const model of channelModelNames(channel)) {
        if (!group.models.includes(model) || !findRatio(ratios, model)) continue
        const entry = out.get(model) ?? { channels: new Set<number>(), groups: [] }
        entry.channels.add(channel.id)
        if (!entry.groups.includes(group.name)) entry.groups.push(group.name)
        out.set(model, entry)
      }
    }
  }
  return out
}

export interface AvailabilityCell {
  total: number
  errors: number
  /** 其中自动测活的次数 */
  probes: number
}

/** 这些分组提供的模型在最近 CELL_COUNT 格里的结果数；最后一格是当前尚未结束的格子 */
export function availabilityView(groups: ChannelGroup[], now = Date.now()) {
  const entries = modelChannels(groups, getSettings().model_ratios, listedChannels())
  const firstCell = Math.floor(now / CELL_MS) - CELL_COUNT + 1
  const models = [...entries.keys()].sort()
  const cells = new Map(models.map(model => [model, Array.from({ length: CELL_COUNT }, (): AvailabilityCell => ({ total: 0, errors: 0, probes: 0 }))]))
  if (models.length) {
    for (const row of countRows(models, firstCell * CELL_MS)) {
      const index = row.cell - firstCell
      if (index >= CELL_COUNT || !belongs(row, entries.get(row.model)!)) continue
      const cell = cells.get(row.model)![index]
      cell.total += row.total
      cell.errors += row.errors
      cell.probes += row.probes
    }
  }
  return {
    cell_ms: CELL_MS,
    start: firstCell * CELL_MS,
    models: models.map(model => ({ model, groups: entries.get(model)!.groups, cells: cells.get(model)! })),
  }
}

// ── 自动测活 ──────────────────────────────────────────────

/**
 * 中继只用到 Express Response 的这几个成员；测活固定非流式，响应体直接丢弃。
 * 写完即触发 close，与真实连接一样让请求生命周期收尾。
 */
class ProbeResponse extends EventEmitter {
  headersSent = false
  writableEnded = false
  destroyed = false
  status(_code: number) { return this }
  type(_value: string) { return this }
  setHeader(_name: string, _value: unknown) { return this }
  json(_body: unknown) { return this.end() }
  send(_body: unknown) { return this.end() }
  end() {
    this.headersSent = true
    this.writableEnded = true
    this.emit('close')
    return this
  }
}

/** 以「测活」来源走一遍完整中继：只在 groups 允许的渠道里选路、重试与换渠道，不计费，结果照常写进请求日志 */
export async function probeModel(model: string, groups: string[]): Promise<void> {
  const body = { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: PROBE_MAX_TOKENS, stream: false }
  const caller: Caller = { surface: 'public', source: 'probe', key: null, groups, ip: '' }
  await handleRelay({ entryFormat: 'openai', ir: body, stream: false, rawBody: body, rawHeaders: {}, res: new ProbeResponse() as unknown as Response, caller })
}

interface ProbeTarget extends ModelChannels {
  model: string
}

/**
 * 需要测活的目标：门户用户能看到的分组（公开分组 + 分配给启用用户的分组）里的模型。
 * 同一模型在不同分组里由不同渠道服务时分开测，保证每个用户看到的格子里都有自己渠道的结果。
 */
function probeTargets(ratios: ModelRatio[]): Map<string, ProbeTarget> {
  const assigned = new Set(db
    .prepare('SELECT DISTINCT j.value FROM users u, json_each(u.groups) j WHERE u.status = ? AND json_valid(u.groups)')
    .pluck().all(USER_ENABLED) as string[])
  const channels = listedChannels()
  const targets = new Map<string, ProbeTarget>()
  for (const group of listGroups()) {
    if (!group.is_public && !assigned.has(group.name)) continue
    for (const [model, entry] of modelChannels([group], ratios, channels)) {
      const id = `${model}\n${[...entry.channels].sort((a, b) => a - b).join(',')}`
      const target = targets.get(id)
      if (target) target.groups.push(group.name)
      else targets.set(id, { model, ...entry })
    }
  }
  return targets
}

/** 目标 → 最近一次测活的开始时间；测活日志在请求结束才落库，靠它避免进行中重复测 */
const lastProbe = new Map<string, number>()
const queue: { id: string; target: ProbeTarget }[] = []
/** 排队或进行中的目标 */
const pending = new Set<string>()
let running = 0

function pump(): void {
  while (running < PROBE_CONCURRENCY && queue.length) {
    const { id, target } = queue.shift()!
    running++
    lastProbe.set(id, Date.now())
    probeModel(target.model, target.groups)
      .catch(error => console.warn('[agghub] 模型测活异常:', error))
      .finally(() => {
        running--
        pending.delete(id)
        pump()
      })
  }
}

/** 10 分钟内没有结果的目标测活一次；当前格子快结束仍没有结果的也补测一次 */
export function probeIdleModels(now = Date.now()): void {
  const targets = probeTargets(getSettings().model_ratios)
  for (const id of lastProbe.keys()) if (!targets.has(id)) lastProbe.delete(id)
  if (!targets.size) return
  const cellStart = Math.floor(now / CELL_MS) * CELL_MS
  const rows = countRows([...new Set([...targets.values()].map(t => t.model))], now - CELL_MS)
  for (const [id, target] of targets) {
    if (pending.has(id)) continue
    let last = lastProbe.get(id) ?? 0
    for (const row of rows) if (row.model === target.model && belongs(row, target)) last = Math.max(last, row.last)
    const idle = now - last >= CELL_MS
    const uncovered = last < cellStart && cellStart + CELL_MS - now <= COVER_MS
    if (!idle && !uncovered) continue
    pending.add(id)
    queue.push({ id, target })
  }
  pump()
}

/** 公网门户开启时启动测活：立即检查一轮，之后每 30 秒检查一次 */
export function startProbes(): void {
  const tick = () => {
    try {
      probeIdleModels()
    } catch (error) {
      console.warn('[agghub] 模型测活调度失败:', error)
    }
  }
  setImmediate(tick)
  setInterval(tick, PROBE_TICK_MS).unref()
}
