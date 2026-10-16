import { db } from '../db'
import type { ChannelGroup, ChannelGroupInput, ChannelGroupView, PortalUser } from '../types'

interface GroupRow {
  name: string
  description: string
  ratio: number
  is_public: number
  channel_ids: string
  models: string
  sort: number
  created_at: number
  updated_at: number
}

function parseArray(raw: string | null | undefined): unknown[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function rowToGroup(row: GroupRow): ChannelGroup {
  return {
    name: row.name,
    description: row.description,
    ratio: row.ratio,
    is_public: !!row.is_public,
    channel_ids: parseArray(row.channel_ids).filter((id): id is number => Number.isSafeInteger(id)),
    models: parseArray(row.models).map(String),
    sort: row.sort,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/** 全部分组，按排序、名称升序 */
export function listGroups(): ChannelGroup[] {
  return (db.prepare('SELECT * FROM channel_groups ORDER BY sort ASC, name ASC').all() as GroupRow[]).map(rowToGroup)
}

export function getGroup(name: string): ChannelGroup | null {
  const row = db.prepare('SELECT * FROM channel_groups WHERE name = ?').get(name) as GroupRow | undefined
  return row ? rowToGroup(row) : null
}

/** 门户用户可用的分组：公开分组 + 分配给该用户的分组 */
export function userGroups(user: Pick<PortalUser, 'groups'>): ChannelGroup[] {
  return listGroups().filter(g => g.is_public || user.groups.includes(g.name))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const NAME_ERROR = '分组名须为 1～32 字符且不含逗号'

/** 分组名校验；合法时返回去掉首尾空白的名称 */
export function groupName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  return name.length >= 1 && name.length <= 32 && !name.includes(',') ? name : null
}

/** 校验请求体；忽略未知字段，partial=true 时只校验出现的字段 */
export function validateGroupInput(input: unknown, partial: boolean): { ok: true; value: ChannelGroupInput } | { ok: false; error: string } {
  if (!isPlainObject(input)) return { ok: false, error: '请求体必须为 JSON 对象' }
  const value: ChannelGroupInput = {}

  if (input.name !== undefined || !partial) {
    const name = groupName(input.name)
    if (!name) return { ok: false, error: NAME_ERROR }
    value.name = name
  }

  if (input.description !== undefined) {
    if (typeof input.description !== 'string' || input.description.trim().length > 200) return { ok: false, error: '描述须为不超过 200 字符的字符串' }
    value.description = input.description.trim()
  }

  if (input.ratio !== undefined) {
    const ratio = input.ratio
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1000) return { ok: false, error: '分组倍率须为 0～1000 的数字' }
    value.ratio = ratio
  }

  if (input.is_public !== undefined) {
    if (typeof input.is_public !== 'boolean') return { ok: false, error: 'is_public 须为布尔值' }
    value.is_public = input.is_public
  }

  if (input.channel_ids !== undefined) {
    if (!Array.isArray(input.channel_ids) || !input.channel_ids.every(id => Number.isSafeInteger(id) && (id as number) > 0)) {
      return { ok: false, error: 'channel_ids 须为正整数渠道 ID 数组' }
    }
    value.channel_ids = [...new Set(input.channel_ids as number[])]
  }

  if (input.models !== undefined) {
    if (!Array.isArray(input.models)) return { ok: false, error: 'models 须为字符串数组' }
    const models: string[] = []
    for (const item of input.models) {
      if (typeof item !== 'string') return { ok: false, error: 'models 须为字符串数组' }
      const model = item.trim()
      if (!model) continue
      if (model.length > 128) return { ok: false, error: 'models 每项须不超过 128 字符' }
      if (!models.includes(model)) models.push(model)
    }
    value.models = models
  }

  if (input.sort !== undefined) {
    if (!Number.isSafeInteger(input.sort) || Math.abs(input.sort as number) > 1_000_000) return { ok: false, error: '排序须为 -1000000～1000000 的整数' }
    value.sort = input.sort as number
  }

  return { ok: true, value }
}

/** 同名分组已存在时返回 null */
export function createGroup(input: ChannelGroupInput): ChannelGroup | null {
  const now = Date.now()
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO channel_groups (name, description, ratio, is_public, channel_ids, models, sort, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.name!, input.description ?? '', input.ratio ?? 1, input.is_public ? 1 : 0,
      JSON.stringify(input.channel_ids ?? []), JSON.stringify(input.models ?? []), input.sort ?? 0, now, now,
    )
  return info.changes ? getGroup(input.name!) : null
}

/** 改写 users / api_keys 里引用的分组名 */
function rewriteRefs(table: 'users' | 'api_keys', map: (groups: string[]) => string[]): void {
  const update = db.prepare(`UPDATE ${table} SET groups = ? WHERE id = ?`)
  for (const row of db.prepare(`SELECT id, groups FROM ${table}`).all() as { id: number; groups: string }[]) {
    const before = parseArray(row.groups).map(String)
    const after = map(before)
    if (after.length !== before.length || after.some((g, i) => g !== before[i])) update.run(JSON.stringify(after), row.id)
  }
}

/** 改名时同步改写用户与 Key 的引用；不存在返回 'not_found'，新名称已被占用返回 'conflict' */
export function updateGroup(name: string, input: ChannelGroupInput): ChannelGroup | 'not_found' | 'conflict' {
  return db.transaction((): ChannelGroup | 'not_found' | 'conflict' => {
    const existing = getGroup(name)
    if (!existing) return 'not_found'
    const nextName = input.name ?? name
    if (nextName !== name && getGroup(nextName)) return 'conflict'
    db.prepare(
      `UPDATE channel_groups SET name = ?, description = ?, ratio = ?, is_public = ?, channel_ids = ?, models = ?, sort = ?, updated_at = ?
       WHERE name = ?`,
    ).run(
      nextName,
      input.description ?? existing.description,
      input.ratio ?? existing.ratio,
      (input.is_public ?? existing.is_public) ? 1 : 0,
      JSON.stringify(input.channel_ids ?? existing.channel_ids),
      JSON.stringify(input.models ?? existing.models),
      input.sort ?? existing.sort,
      Date.now(),
      name,
    )
    if (nextName !== name) {
      const rename = (groups: string[]) => [...new Set(groups.map(g => (g === name ? nextName : g)))]
      rewriteRefs('users', rename)
      rewriteRefs('api_keys', rename)
    }
    return getGroup(nextName)!
  })()
}

/** 删除分组并从用户与 Key 上移除；Key 因此没有分组时将无法调用，直到重新选择 */
export function deleteGroup(name: string): boolean {
  return db.transaction(() => {
    const removed = db.prepare('DELETE FROM channel_groups WHERE name = ?').run(name).changes > 0
    if (removed) {
      const drop = (groups: string[]) => groups.filter(g => g !== name)
      rewriteRefs('users', drop)
      rewriteRefs('api_keys', drop)
    }
    return removed
  })()
}

/** 渠道删除后从各分组里去掉它 */
export function removeChannelFromGroups(channelId: number): void {
  const update = db.prepare('UPDATE channel_groups SET channel_ids = ? WHERE name = ?')
  for (const group of listGroups()) {
    if (group.channel_ids.includes(channelId)) update.run(JSON.stringify(group.channel_ids.filter(id => id !== channelId)), group.name)
  }
}

function countRefs(table: 'users' | 'api_keys'): Map<string, number> {
  const counts = new Map<string, number>()
  for (const raw of db.prepare(`SELECT groups FROM ${table}`).pluck().all() as string[]) {
    for (const name of new Set(parseArray(raw).map(String))) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return counts
}

/** 管理端列表：附带引用该分组的用户数与 Key 数 */
export function groupViews(): ChannelGroupView[] {
  const users = countRefs('users')
  const keys = countRefs('api_keys')
  return listGroups().map(g => ({ ...g, user_count: users.get(g.name) ?? 0, key_count: keys.get(g.name) ?? 0 }))
}
