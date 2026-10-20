import { Router } from 'express'
import { HOST, PORT, PUBLIC_HOST, PUBLIC_PORT, TRUST_PROXY } from '../config'
import { listGroups } from '../core/groups'
import { ZSTD_AVAILABLE } from '../core/upstreamCompression'
import { applyQuotaOp, createKey, deleteKey, keyUsage, keyView, listKeys, regenerateKey, updateKey, validateKeyInput } from '../core/keys'
import type { ApiKeyInput, KeyQuotaOp, SystemInfo } from '../types'

export const keysRouter = Router()

const validId = (raw: string): number | null => {
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

/** 引用了不存在的分组时返回错误信息 */
function unknownGroups(input: ApiKeyInput): string | null {
  if (!input.groups) return null
  const names = new Set(listGroups().map(g => g.name))
  const missing = input.groups.filter(g => !names.has(g))
  return missing.length ? `分组不存在：${missing.join('、')}` : null
}

keysRouter.get('/', (_req, res) => {
  res.json(listKeys().map(k => keyView(k)))
})

keysRouter.post('/', (req, res) => {
  const result = validateKeyInput(req.body, false)
  if (!result.ok) return res.status(400).json({ error: result.error })
  const groupError = unknownGroups(result.value)
  if (groupError) return res.status(400).json({ error: groupError })
  res.json(keyView(createKey(result.value)))
})

keysRouter.put('/:id', (req, res) => {
  const result = validateKeyInput(req.body, true)
  if (!result.ok) return res.status(400).json({ error: result.error })
  const groupError = unknownGroups(result.value)
  if (groupError) return res.status(400).json({ error: groupError })
  // 管理端显式启停时同步停用标记：停用 = enabled 0 + admin_disabled 1，启用则一并清掉
  if (result.value.enabled !== undefined) result.value.admin_disabled = !result.value.enabled
  const id = validId(req.params.id)
  const key = id ? updateKey(id, result.value) : null
  if (!key) return res.status(404).json({ error: 'not found' })
  res.json(keyView(key))
})

keysRouter.delete('/:id', (req, res) => {
  const id = validId(req.params.id)
  if (id) deleteKey(id)
  res.json({ ok: true })
})

keysRouter.post('/:id/regenerate', (req, res) => {
  const id = validId(req.params.id)
  const key = id ? regenerateKey(id) : null
  if (!key) return res.status(404).json({ error: 'not found' })
  res.json(keyView(key))
})

keysRouter.post('/:id/quota', (req, res) => {
  const body = req.body as Record<string, unknown> | undefined
  let op: KeyQuotaOp | null = null
  if (body?.op === 'reset_used') op = { op: 'reset_used' }
  else if (body?.op === 'add_total' && Number.isSafeInteger(body.value)) op = { op: 'add_total', value: body.value as number }
  if (!op) return res.status(400).json({ error: '额度操作无效' })
  const id = validId(req.params.id)
  const key = id ? applyQuotaOp(id, op) : null
  if (!key) return res.status(404).json({ error: 'not found' })
  res.json(keyView(key))
})

keysRouter.get('/:id/usage', (req, res) => {
  const id = validId(req.params.id) ?? 0
  res.json(keyUsage(id, Number(req.query.days) || 30))
})

// 挂在 /api 下的零散信息接口
export const metaRouter = Router()

metaRouter.get('/system', (_req, res) => {
  const info: SystemInfo = {
    lan_host: HOST ?? null,
    lan_port: PORT,
    public_enabled: PUBLIC_PORT > 0,
    public_host: PUBLIC_PORT ? PUBLIC_HOST : null,
    public_port: PUBLIC_PORT || null,
    trust_proxy: String(TRUST_PROXY),
    node_version: process.version,
    zstd_available: ZSTD_AVAILABLE,
  }
  res.json(info)
})
