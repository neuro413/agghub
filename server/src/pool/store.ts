import { db } from '../db'
import type { NodeView, ParsedNode, PoolNode, PoolSubscription } from './types'

db.exec(`
CREATE TABLE IF NOT EXISTS pool_nodes (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT    NOT NULL,
  type                 TEXT    NOT NULL,
  config               TEXT    NOT NULL,
  raw                  TEXT,
  identity             TEXT    NOT NULL UNIQUE,
  sources              TEXT    NOT NULL DEFAULT '[]',
  disabled             INTEGER NOT NULL DEFAULT 0,
  invalid_reason       TEXT,
  success_count        INTEGER NOT NULL DEFAULT 0,
  fail_count           INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  limit_count          INTEGER NOT NULL DEFAULT 0,
  last_delay_ms        INTEGER,
  last_error           TEXT,
  last_test_at         INTEGER,
  last_success_at      INTEGER,
  last_fail_at         INTEGER,
  cooldown_until       INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pool_subscriptions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  url             TEXT    NOT NULL,
  user_agent      TEXT    NOT NULL DEFAULT '',
  update_interval INTEGER NOT NULL DEFAULT 0,
  last_update_at  INTEGER,
  last_error      TEXT,
  node_count      INTEGER NOT NULL DEFAULT 0,
  userinfo        TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
`)

interface NodeRow extends Omit<PoolNode, 'config' | 'sources' | 'disabled' | 'inFlight' | 'lastSelectedAt'> {
  config: string
  sources: string
  disabled: number
}

const nodes = new Map<number, PoolNode>()
const byIdentity = new Map<string, PoolNode>()
const dirty = new Set<number>()
let loaded = false

// ── 变更通知：节点集合 / 启用状态变化时内核需要热重载 ──
const changeListeners: (() => void)[] = []
export function onNodesChanged(fn: () => void): void {
  changeListeners.push(fn)
}
function notifyChanged(): void {
  for (const fn of changeListeners) fn()
}

function parseJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T } catch { return fallback }
}

function rowToNode(r: NodeRow): PoolNode {
  return {
    ...r,
    config: parseJson<Record<string, unknown>>(r.config, {}),
    sources: parseJson<string[]>(r.sources, []),
    disabled: !!r.disabled,
    inFlight: 0,
    lastSelectedAt: 0,
  }
}

export function loadNodes(): void {
  if (loaded) return
  loaded = true
  for (const row of db.prepare('SELECT * FROM pool_nodes ORDER BY id').all() as NodeRow[]) {
    const node = rowToNode(row)
    nodes.set(node.id, node)
    byIdentity.set(node.identity, node)
  }
}

loadNodes()

export function allNodes(): PoolNode[] {
  return [...nodes.values()]
}

export function getNode(id: number): PoolNode | undefined {
  return nodes.get(id)
}

const updateStmt = db.prepare(`
UPDATE pool_nodes SET name = @name, type = @type, config = @config, raw = @raw, sources = @sources, disabled = @disabled,
  invalid_reason = @invalid_reason, success_count = @success_count, fail_count = @fail_count,
  consecutive_failures = @consecutive_failures, limit_count = @limit_count, last_delay_ms = @last_delay_ms,
  last_error = @last_error, last_test_at = @last_test_at, last_success_at = @last_success_at,
  last_fail_at = @last_fail_at, cooldown_until = @cooldown_until, updated_at = @updated_at
WHERE id = @id`)

function writeNode(node: PoolNode): void {
  updateStmt.run({
    id: node.id, name: node.name, type: node.type, config: JSON.stringify(node.config), raw: node.raw,
    sources: JSON.stringify(node.sources), disabled: node.disabled ? 1 : 0, invalid_reason: node.invalid_reason,
    success_count: node.success_count, fail_count: node.fail_count, consecutive_failures: node.consecutive_failures,
    limit_count: node.limit_count, last_delay_ms: node.last_delay_ms, last_error: node.last_error,
    last_test_at: node.last_test_at, last_success_at: node.last_success_at, last_fail_at: node.last_fail_at,
    cooldown_until: node.cooldown_until, updated_at: node.updated_at,
  })
  dirty.delete(node.id)
}

/** 健康数据批量落库（定时调用，退出前同步调用） */
export function flushNodes(): void {
  if (!dirty.size) return
  const ids = [...dirty]
  db.transaction(() => {
    for (const id of ids) {
      const node = nodes.get(id)
      if (node) writeNode(node)
      else dirty.delete(id)
    }
  })()
}

let flushTimer: NodeJS.Timeout | null = null
export function startFlushTimer(): void {
  if (flushTimer) return
  flushTimer = setInterval(() => {
    try { flushNodes() } catch (error) { console.warn('[pool] 节点健康数据落库失败:', error) }
  }, 2000)
  flushTimer.unref()
}

const insertStmt = db.prepare(`
INSERT INTO pool_nodes (name, type, config, raw, identity, sources, created_at, updated_at)
VALUES (@name, @type, @config, @raw, @identity, @sources, @now, @now)`)

/** 按 identity 新增或合并，返回节点与是否新增；需在事务内调用 */
function upsert(p: ParsedNode, source: string, now: number): { node: PoolNode; added: boolean } {
  const existing = byIdentity.get(p.identity)
  if (existing) {
    existing.name = p.name
    existing.type = p.type
    existing.config = p.config
    if (p.raw) existing.raw = p.raw
    if (!existing.sources.includes(source)) existing.sources = [...existing.sources, source]
    existing.updated_at = now
    writeNode(existing)
    return { node: existing, added: false }
  }
  const sources = [source]
  const info = insertStmt.run({ name: p.name, type: p.type, config: JSON.stringify(p.config), raw: p.raw, identity: p.identity, sources: JSON.stringify(sources), now })
  const node: PoolNode = {
    id: Number(info.lastInsertRowid), name: p.name, type: p.type, config: p.config, raw: p.raw, identity: p.identity,
    sources, disabled: false, invalid_reason: null, success_count: 0, fail_count: 0, consecutive_failures: 0,
    limit_count: 0, last_delay_ms: null, last_error: null, last_test_at: null, last_success_at: null,
    last_fail_at: null, cooldown_until: null, created_at: now, updated_at: now, inFlight: 0, lastSelectedAt: 0,
  }
  nodes.set(node.id, node)
  byIdentity.set(node.identity, node)
  return { node, added: true }
}

function removeNode(id: number): void {
  const node = nodes.get(id)
  if (!node) return
  db.prepare('DELETE FROM pool_nodes WHERE id = ?').run(id)
  nodes.delete(id)
  byIdentity.delete(node.identity)
  dirty.delete(id)
}

/** 手动导入 */
export function importNodes(parsed: ParsedNode[], source = 'manual'): { added: number; updated: number } {
  let added = 0
  let updated = 0
  const now = Date.now()
  db.transaction(() => {
    for (const p of parsed) {
      if (upsert(p, source, now).added) added++
      else updated++
    }
  })()
  if (parsed.length) notifyChanged()
  return { added, updated }
}

/** 订阅更新：整体替换该订阅来源的节点，只属于该订阅且不再出现的节点删除 */
export function replaceSubscriptionNodes(subId: number, parsed: ParsedNode[]): { added: number; removed: number } {
  const tag = `sub:${subId}`
  const now = Date.now()
  let added = 0
  let removed = 0
  db.transaction(() => {
    const keep = new Set<number>()
    for (const p of parsed) {
      const result = upsert(p, tag, now)
      keep.add(result.node.id)
      if (result.added) added++
    }
    for (const node of [...nodes.values()]) {
      if (keep.has(node.id) || !node.sources.includes(tag)) continue
      node.sources = node.sources.filter(s => s !== tag)
      if (node.sources.length) {
        node.updated_at = now
        writeNode(node)
      } else {
        removeNode(node.id)
        removed++
      }
    }
  })()
  notifyChanged()
  return { added, removed }
}

/** 删除订阅：deleteNodes 时移除只属于它的节点，否则转为手动节点 */
export function removeSubscription(subId: number, deleteNodes: boolean): void {
  const tag = `sub:${subId}`
  const now = Date.now()
  db.transaction(() => {
    for (const node of [...nodes.values()]) {
      if (!node.sources.includes(tag)) continue
      const rest = node.sources.filter(s => s !== tag)
      if (deleteNodes && !rest.length) {
        removeNode(node.id)
        continue
      }
      node.sources = deleteNodes || rest.includes('manual') ? rest : [...rest, 'manual']
      node.updated_at = now
      writeNode(node)
    }
    db.prepare('DELETE FROM pool_subscriptions WHERE id = ?').run(subId)
  })()
  notifyChanged()
}

export type BatchAction = 'enable' | 'disable' | 'delete' | 'reset'

export function batchNodes(ids: number[], action: BatchAction): number {
  const now = Date.now()
  let count = 0
  db.transaction(() => {
    for (const id of ids) {
      const node = nodes.get(id)
      if (!node) continue
      count++
      if (action === 'delete') {
        removeNode(id)
        continue
      }
      if (action === 'disable') node.disabled = true
      else {
        if (action === 'enable') node.disabled = false
        node.cooldown_until = null
        node.consecutive_failures = 0
        node.invalid_reason = null
        if (action === 'reset') node.last_fail_at = null
      }
      node.updated_at = now
      writeNode(node)
    }
  })()
  if (count) notifyChanged()
  return count
}

export function deleteDisabledNodes(): number {
  const ids = allNodes().filter(n => n.disabled).map(n => n.id)
  return ids.length ? batchNodes(ids, 'delete') : 0
}

/** 测速 / 拨测自动禁用，不清健康数据 */
export function disableNodes(ids: number[]): void {
  const now = Date.now()
  let changed = false
  db.transaction(() => {
    for (const id of ids) {
      const node = nodes.get(id)
      if (!node || node.disabled) continue
      node.disabled = true
      node.updated_at = now
      writeNode(node)
      changed = true
    }
  })()
  if (changed) notifyChanged()
}

/** mihomo 拒绝该节点配置；由内核在热重载中调用，不触发变更通知 */
export function setInvalid(id: number, reason: string): void {
  const node = nodes.get(id)
  if (!node) return
  node.invalid_reason = reason.slice(0, 500)
  node.updated_at = Date.now()
  writeNode(node)
}

// ── 健康记录：只改内存，定时批量落库 ──
export function networkCooldownMs(consecutive: number): number {
  return Math.min(1800, 30 * 2 ** Math.min(Math.max(consecutive, 1) - 1, 6)) * 1000
}

export function recordSuccess(id: number, delayMs?: number): void {
  const node = nodes.get(id)
  if (!node) return
  const now = Date.now()
  node.success_count++
  node.consecutive_failures = 0
  node.cooldown_until = null
  node.last_success_at = now
  if (delayMs !== undefined) {
    node.last_delay_ms = delayMs
    node.last_test_at = now
    node.last_error = null
  }
  dirty.add(id)
}

export function recordNetworkFailure(id: number, error: string, fromTest = false): void {
  const node = nodes.get(id)
  if (!node) return
  const now = Date.now()
  node.fail_count++
  node.consecutive_failures++
  node.last_fail_at = now
  node.last_error = error.slice(0, 300)
  node.cooldown_until = now + networkCooldownMs(node.consecutive_failures)
  if (fromTest) {
    node.last_test_at = now
    node.last_delay_ms = null
  }
  dirty.add(id)
}

export function recordLimit(id: number, status: number, cooldownMs: number): void {
  const node = nodes.get(id)
  if (!node) return
  const now = Date.now()
  node.limit_count++
  node.last_fail_at = now
  node.last_error = `上游返回 ${status}`
  node.cooldown_until = now + cooldownMs
  dirty.add(id)
}

export function isSubHealthy(node: PoolNode): boolean {
  return (node.last_fail_at ?? 0) > (node.last_success_at ?? 0)
}

export function nodeView(node: PoolNode, localPort: number | null): NodeView {
  const port = Number(node.config.port)
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    server: String(node.config.server ?? ''),
    server_port: Number.isFinite(port) ? port : null,
    sources: node.sources,
    disabled: node.disabled,
    invalid_reason: node.invalid_reason,
    local_port: localPort,
    in_flight: node.inFlight,
    success_count: node.success_count,
    fail_count: node.fail_count,
    consecutive_failures: node.consecutive_failures,
    limit_count: node.limit_count,
    last_delay_ms: node.last_delay_ms,
    last_error: node.last_error,
    last_test_at: node.last_test_at,
    last_success_at: node.last_success_at,
    last_fail_at: node.last_fail_at,
    cooldown_until: node.cooldown_until,
    sub_healthy: isSubHealthy(node),
  }
}

// ── 订阅表 ──
export function listSubscriptions(): PoolSubscription[] {
  return db.prepare('SELECT * FROM pool_subscriptions ORDER BY id').all() as PoolSubscription[]
}

export function getSubscription(id: number): PoolSubscription | undefined {
  return db.prepare('SELECT * FROM pool_subscriptions WHERE id = ?').get(id) as PoolSubscription | undefined
}

export interface SubscriptionInput {
  name: string
  url: string
  user_agent: string
  update_interval: number
}

export function createSubscription(input: SubscriptionInput): PoolSubscription {
  const now = Date.now()
  const info = db.prepare(`
    INSERT INTO pool_subscriptions (name, url, user_agent, update_interval, created_at, updated_at)
    VALUES (@name, @url, @user_agent, @update_interval, @now, @now)`).run({ ...input, now })
  return getSubscription(Number(info.lastInsertRowid))!
}

export function updateSubscription(id: number, input: SubscriptionInput): PoolSubscription | undefined {
  db.prepare(`
    UPDATE pool_subscriptions SET name = @name, url = @url, user_agent = @user_agent, update_interval = @update_interval, updated_at = @now
    WHERE id = @id`).run({ ...input, id, now: Date.now() })
  return getSubscription(id)
}

export function setSubscriptionResult(id: number, result: { ok: true; nodeCount: number; userinfo: string | null } | { ok: false; error: string }): void {
  const now = Date.now()
  if (result.ok) {
    db.prepare('UPDATE pool_subscriptions SET last_update_at = ?, last_error = NULL, node_count = ?, userinfo = ? WHERE id = ?')
      .run(now, result.nodeCount, result.userinfo, id)
  } else {
    // 失败也记更新时间，避免自动更新每分钟重复拉取
    db.prepare('UPDATE pool_subscriptions SET last_update_at = ?, last_error = ? WHERE id = ?').run(now, result.error.slice(0, 500), id)
  }
}
