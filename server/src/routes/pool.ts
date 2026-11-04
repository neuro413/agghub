import { Router } from 'express'
import { activePortOf, coreLogs, coreStatus, downloadCore, reloadNow, restart, start, stop } from '../pool/core'
import { parseSubscriptionText } from '../pool/importer'
import { matchCount } from '../pool/select'
import { getPoolSettings, updatePoolSettings } from '../pool/settings'
import {
  allNodes, batchNodes, createSubscription, deleteDisabledNodes, getNode, getSubscription, importNodes,
  listSubscriptions, nodeView, removeSubscription, updateSubscription, type BatchAction, type SubscriptionInput,
} from '../pool/store'
import { triggerRefresh, updatingIds } from '../pool/subscriptions'
import { pauseBatch, resumeBatch, startBatch, stopBatch, testEntry, testNode, testProgress } from '../pool/tester'

export const poolRouter = Router()

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

function publicSettings() {
  const { secret: _secret, ...rest } = getPoolSettings()
  return rest
}

function statusPayload() {
  const now = Date.now()
  let enabled = 0
  let available = 0
  let cooling = 0
  let invalid = 0
  const nodes = allNodes()
  for (const node of nodes) {
    if (node.invalid_reason) invalid++
    if (node.disabled) continue
    enabled++
    const isCooling = !!node.cooldown_until && node.cooldown_until > now
    if (isCooling) cooling++
    if (!node.invalid_reason && !isCooling && activePortOf(node.id) !== undefined) available++
  }
  return {
    settings: publicSettings(),
    core: coreStatus(),
    counts: { total: nodes.length, enabled, available, cooling, invalid },
    test: testProgress(),
  }
}

poolRouter.get('/status', (_req, res) => {
  res.json(statusPayload())
})

poolRouter.put('/settings', async (req, res) => {
  let result: ReturnType<typeof updatePoolSettings>
  try {
    result = updatePoolSettings(req.body ?? {})
  } catch (err) {
    return res.status(400).json({ error: errMessage(err) })
  }
  const { settings, changed } = result
  if (changed.has('enabled')) {
    if (settings.enabled) await start()
    else await stop()
  } else if (settings.enabled && (changed.has('core_path') || changed.has('controller_port') || changed.has('listen_base_port'))) {
    await restart()
  } else if (changed.has('entry_proxy')) {
    await reloadNow()
  }
  res.json(statusPayload())
})

poolRouter.post('/core/download', async (_req, res) => {
  try {
    const version = await downloadCore()
    res.json({ version, core: coreStatus() })
  } catch (err) {
    res.status(502).json({ error: errMessage(err) })
  }
})

poolRouter.post('/core/restart', async (_req, res) => {
  if (!getPoolSettings().enabled) return res.status(400).json({ error: '请先打开代理池总开关' })
  await restart()
  res.json(coreStatus())
})

poolRouter.get('/core/logs', (_req, res) => {
  res.json({ lines: coreLogs() })
})

// ── 节点 ──
poolRouter.get('/nodes', (_req, res) => {
  res.json({ nodes: allNodes().map(n => nodeView(n, activePortOf(n.id) ?? null)) })
})

poolRouter.get('/nodes/:id/raw', (req, res) => {
  const node = getNode(Number(req.params.id))
  if (!node) return res.status(404).json({ error: '节点不存在' })
  res.json({ raw: node.raw, config: { name: node.name, ...node.config } })
})

poolRouter.post('/nodes/import', (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text : ''
  if (!text.trim()) return res.status(400).json({ error: '内容为空' })
  const parsed = parseSubscriptionText(text)
  const result = importNodes(parsed.nodes, 'manual')
  res.json({ ...result, total: parsed.nodes.length, errors: parsed.errors })
})

const BATCH_ACTIONS: BatchAction[] = ['enable', 'disable', 'delete', 'reset']

poolRouter.post('/nodes/batch', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : []
  const action = req.body?.action as BatchAction
  if (!BATCH_ACTIONS.includes(action)) return res.status(400).json({ error: '操作无效' })
  if (!ids.length) return res.status(400).json({ error: '没有选中节点' })
  res.json({ ok: true, count: batchNodes(ids, action) })
})

poolRouter.post('/nodes/delete-disabled', (_req, res) => {
  res.json({ deleted: deleteDisabledNodes() })
})

poolRouter.post('/nodes/:id/test', async (req, res) => {
  res.json(await testNode(Number(req.params.id)))
})

// ── 批量测速 ──
poolRouter.get('/test', (_req, res) => {
  res.json(testProgress())
})

poolRouter.post('/test', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : undefined
  try {
    const progress = startBatch(ids, !!req.body?.disable_failed)
    if (!progress) return res.status(409).json({ error: '已有测速任务在进行' })
    res.json(progress)
  } catch (err) {
    res.status(400).json({ error: errMessage(err) })
  }
})

poolRouter.post('/test/pause', (_req, res) => {
  res.json(pauseBatch())
})

poolRouter.post('/test/resume', (_req, res) => {
  res.json(resumeBatch())
})

poolRouter.post('/test/stop', (_req, res) => {
  res.json(stopBatch())
})

poolRouter.post('/entry/test', async (_req, res) => {
  res.json(await testEntry())
})

poolRouter.get('/match', (req, res) => {
  const include = typeof req.query.include === 'string' ? req.query.include : ''
  const exclude = typeof req.query.exclude === 'string' ? req.query.exclude : ''
  res.json({ ...matchCount({ include, exclude }), node_retry_times: getPoolSettings().node_retry_times })
})

// ── 订阅 ──
function subscriptionInput(body: Record<string, unknown> | undefined): SubscriptionInput | string {
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const url = typeof body?.url === 'string' ? body.url.trim() : ''
  const userAgent = typeof body?.user_agent === 'string' ? body.user_agent.trim() : ''
  const interval = Number(body?.update_interval ?? 0)
  if (!name || name.length > 64) return '名称须为 1~64 个字符'
  if (!/^https?:\/\/\S+$/i.test(url)) return '订阅链接须为 http(s) 地址'
  if (userAgent.length > 200) return 'User-Agent 过长'
  if (!Number.isInteger(interval) || interval < 0 || interval > 10080) return '自动更新间隔须为 0~10080 分钟'
  return { name, url, user_agent: userAgent, update_interval: interval }
}

poolRouter.get('/subscriptions', (_req, res) => {
  res.json({ list: listSubscriptions(), updating: updatingIds() })
})

poolRouter.post('/subscriptions', (req, res) => {
  const input = subscriptionInput(req.body)
  if (typeof input === 'string') return res.status(400).json({ error: input })
  const sub = createSubscription(input)
  triggerRefresh(sub.id)
  res.json(sub)
})

poolRouter.put('/subscriptions/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!getSubscription(id)) return res.status(404).json({ error: '订阅不存在' })
  const input = subscriptionInput(req.body)
  if (typeof input === 'string') return res.status(400).json({ error: input })
  res.json(updateSubscription(id, input))
})

poolRouter.delete('/subscriptions/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!getSubscription(id)) return res.status(404).json({ error: '订阅不存在' })
  removeSubscription(id, req.query.delete_nodes === '1')
  res.json({ ok: true })
})

poolRouter.post('/subscriptions/update-all', (_req, res) => {
  let triggered = 0
  for (const sub of listSubscriptions()) if (triggerRefresh(sub.id)) triggered++
  res.json({ triggered })
})

poolRouter.post('/subscriptions/:id/update', (req, res) => {
  const id = Number(req.params.id)
  if (!getSubscription(id)) return res.status(404).json({ error: '订阅不存在' })
  res.json({ triggered: triggerRefresh(id) })
})
