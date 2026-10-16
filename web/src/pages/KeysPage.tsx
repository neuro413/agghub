import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { Button, IconButton } from '../components/Button'
import { Card } from '../components/Card'
import { EmptyState } from '../components/EmptyState'
import { IconCopy, IconEdit, IconExternal, IconKey, IconPlus, IconRefresh, IconTrash } from '../components/Icons'
import { useToast } from '../components/Toast'
import { Toggle } from '../components/Toggle'
import { copyText } from '../lib/clipboard'
import { fmtTime } from '../lib/format'
import { currencySymbol, money, toPoints } from '../lib/money'
import type { ApiKeyView, ChannelGroupView, ModelRatio, SystemInfo } from '../types'
import { KeyModal } from './KeyModal'
import { ModelRatioCard } from './ModelRatioCard'

/** sk-agh-XXXX…YYYY，前 4 位 + 后 4 位 */
function maskKey(key: string): string {
  if (key.length <= 14) return key
  return `${key.slice(0, 11)}…${key.slice(-4)}`
}

function pct(used: number, total: number | null): number {
  if (!total || total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((used / total) * 100)))
}

export function KeysPage() {
  const toast = useToast()
  const [keys, setKeys] = useState<ApiKeyView[]>([])
  const [groups, setGroups] = useState<ChannelGroupView[]>([])
  const [ratios, setRatios] = useState<ModelRatio[]>([])
  const [publicBaseUrl, setPublicBaseUrl] = useState('')
  const [system, setSystem] = useState<SystemInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<ApiKeyView | 'new' | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [k, g, settings, sys] = await Promise.all([
        api.listKeys(signal),
        api.listGroups(signal),
        api.getSettings(signal),
        api.getSystem(signal),
      ])
      if (signal?.aborted) return
      setKeys(k)
      setGroups(g)
      // 内容没变时保留原数组，避免倍率卡片里未保存的编辑被其他操作的刷新覆盖
      setRatios(prev => JSON.stringify(prev) === JSON.stringify(settings.model_ratios) ? prev : settings.model_ratios)
      setPublicBaseUrl(settings.public_base_url)
      setSystem(sys)
    } catch (e: any) {
      if (!signal?.aborted) toast('err', e.message)
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [load])

  const refresh = useCallback(() => load(), [load])

  const toggle = async (k: ApiKeyView) => {
    try {
      await api.updateKey(k.id, { enabled: !k.enabled })
      refresh()
    } catch (e: any) {
      toast('err', e.message)
    }
  }

  const copyInfo = async (k: ApiKeyView) => {
    const base = (publicBaseUrl || window.location.origin).replace(/\/+$/, '')
    const text = `OpenAI 兼容 Base URL：${base}/v1\nAnthropic Base URL：${base}\nAPI Key：${k.key}`
    if (await copyText(text)) toast('ok', '接入信息已复制')
    else toast('err', '复制失败，请手动复制')
  }

  const resetUsed = async (k: ApiKeyView) => {
    if (!window.confirm(`确认把「${k.name}」的已用额度清零？`)) return
    try {
      await api.keyQuota(k.id, { op: 'reset_used' })
      toast('ok', '已清零')
      refresh()
    } catch (e: any) {
      toast('err', e.message)
    }
  }

  const addTotal = async (k: ApiKeyView) => {
    const raw = window.prompt(`增加多少总额度？（单位 ${currencySymbol()}，可填负数减少）`)
    if (raw == null) return
    const value = toPoints(Number(raw.trim()))
    if (raw.trim() === '' || !Number.isSafeInteger(value) || value === 0) {
      toast('err', '请输入非零金额')
      return
    }
    try {
      await api.keyQuota(k.id, { op: 'add_total', value })
      toast('ok', '额度已更新')
      refresh()
    } catch (e: any) {
      toast('err', e.message)
    }
  }

  const regenerate = async (k: ApiKeyView) => {
    if (!window.confirm('重新生成后旧 Key 立即失效，确认？')) return
    try {
      const next = await api.regenerateKey(k.id)
      if (await copyText(next.key)) toast('ok', '已生成新 Key 并复制')
      else toast('ok', '已生成新 Key')
      refresh()
    } catch (e: any) {
      toast('err', e.message)
    }
  }

  const del = async (k: ApiKeyView) => {
    if (!window.confirm(`确认删除「${k.name}」？日志会保留，但该 Key 立即失效。`)) return
    try {
      await api.deleteKey(k.id)
      toast('ok', 'Key 已删除')
      refresh()
    } catch (e: any) {
      toast('err', e.message)
    }
  }

  return (
    <div className="ah-fade-up">
      <div className="ah-page-head">
        <div>
          <div className="ah-page-title">令牌</div>
          <div className="ah-page-sub">分发 Key · 额度 · 模型定价</div>
        </div>
        <div className="ah-row">
          <IconButton title="刷新" onClick={refresh}>
            <IconRefresh size={18} />
          </IconButton>
          <Button variant="primary" icon={<IconPlus size={18} />} onClick={() => setEditing('new')}>
            新建 Key
          </Button>
        </div>
      </div>

      <Card className="ah-set-card">
        <div className="ah-set-title">
          <IconExternal size={18} /> 公网分发状态
        </div>
        {system && !system.public_enabled ? (
          <div className="ah-set-desc">
            公网端口未开启：设置环境变量 AGGHUB_PUBLIC_PORT 后重启服务生效；Key 也可以在内网端口使用（按 Key 的权限和额度限制）
          </div>
        ) : system ? (
          <>
            <div className="ah-set-desc">
              公网端口已开启：监听 {system.public_host}:{system.public_port}
            </div>
            <div className="ah-endpoint">
              <span className="ah-endpoint-label">对外 Base URL</span>
              <code className="ah-endpoint-url ah-truncate">{publicBaseUrl || '未设置（在设置页填写）'}</code>
            </div>
          </>
        ) : (
          <div className="ah-set-desc">读取中…</div>
        )}
      </Card>

      {loading ? (
        <div className="ah-key-list">
          {[0, 1, 2].map((i) => (
            <div key={i} className="ah-skel" />
          ))}
        </div>
      ) : keys.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconKey size={34} />}
            title="还没有分发 Key"
            desc="新建一个 Key，发给需要调用的朋友吧～"
            action={
              <Button variant="primary" icon={<IconPlus size={18} />} onClick={() => setEditing('new')}>
                新建 Key
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="ah-key-list">
          {keys.map((k) => (
            <KeyCard
              key={k.id}
              k={k}
              onToggle={() => toggle(k)}
              onEdit={() => setEditing(k)}
              onCopyInfo={() => copyInfo(k)}
              onResetUsed={() => resetUsed(k)}
              onAddTotal={() => addTotal(k)}
              onRegenerate={() => regenerate(k)}
              onDelete={() => del(k)}
            />
          ))}
        </div>
      )}

      <ModelRatioCard ratios={ratios} onSaved={refresh} />

      {editing && (
        <KeyModal
          keyItem={editing === 'new' ? null : editing}
          groups={groups}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
    </div>
  )
}

function KeyCard({
  k,
  onToggle,
  onEdit,
  onCopyInfo,
  onResetUsed,
  onAddTotal,
  onRegenerate,
  onDelete,
}: {
  k: ApiKeyView
  onToggle: () => void
  onEdit: () => void
  onCopyInfo: () => void
  onResetUsed: () => void
  onAddTotal: () => void
  onRegenerate: () => void
  onDelete: () => void
}) {
  const toast = useToast()
  const expired = k.expires_at != null && k.expires_at <= Date.now()
  const copyKey = async () => {
    if (await copyText(k.key)) toast('ok', 'Key 已复制')
    else toast('err', '复制失败，请手动复制')
  }

  return (
    <Card hover className="ah-key-card">
      <div className="ah-chan-top">
        <div>
          <div className="ah-chan-name ah-truncate">
            <IconKey size={16} />
            {k.name}
          </div>
          <div className="ah-mini ah-muted ah-truncate">
            最近使用：{k.last_used_at ? fmtTime(k.last_used_at) : '从未使用'}
          </div>
        </div>
        <Toggle checked={k.enabled} onChange={onToggle} />
      </div>

      <div className="ah-key-secret">
        <code className="ah-key-secret-val">{maskKey(k.key)}</code>
        <IconButton title="复制完整 Key" onClick={copyKey}>
          <IconCopy size={16} />
        </IconButton>
        {!k.enabled && <span className="ah-tag">已停用</span>}
      </div>

      <div className="ah-pp-chips">
        {k.groups.map((g) => (
          <span key={g} className="ah-tag">
            {g}
          </span>
        ))}
        {!k.groups.length && <span className="ah-mini ah-faint">未设分组</span>}
      </div>

      <div className="ah-key-quota">
        <div className="ah-key-quota-row">
          <span className="ah-mini ah-muted">总额度</span>
          {k.quota_total == null ? (
            <span className="ah-mini ah-num">已用 {money(k.quota_used)} · 不限</span>
          ) : (
            <span className="ah-mini ah-num">
              {money(k.quota_used)} / {money(k.quota_total)}
            </span>
          )}
        </div>
        {k.quota_total != null && (
          <div className="ah-bar">
            <i style={{ width: `${pct(k.quota_used, k.quota_total)}%` }} />
          </div>
        )}
      </div>

      <div className="ah-key-quota">
        <div className="ah-key-quota-row">
          <span className="ah-mini ah-muted">今日</span>
          {k.quota_daily == null ? (
            <span className="ah-mini ah-num">
              今日 {money(k.today_points)} · 不限 · {k.today_requests} 次
            </span>
          ) : (
            <span className="ah-mini ah-num">
              {money(k.today_points)} / {money(k.quota_daily)} · {k.today_requests} 次
            </span>
          )}
        </div>
        {k.quota_daily != null && (
          <div className="ah-bar">
            <i style={{ width: `${pct(k.today_points, k.quota_daily)}%` }} />
          </div>
        )}
      </div>

      <div className="ah-key-meta">
        <span>限流：RPM {k.rpm ?? '不限'} · 并发 {k.concurrency ?? '不限'}</span>
        <span className={expired ? 'is-err' : ''}>
          过期：{k.expires_at == null ? '永不过期' : expired ? '已过期' : fmtTime(k.expires_at)}
        </span>
        <span>正文：{k.log_bodies == null ? '跟随全局' : k.log_bodies ? '记录正文' : '不记录正文'}</span>
      </div>

      <div className="ah-chan-actions">
        <Button variant="soft" size="sm" icon={<IconEdit size={15} />} onClick={onEdit}>
          编辑
        </Button>
        <Button variant="ghost" size="sm" icon={<IconCopy size={15} />} onClick={onCopyInfo}>
          复制接入信息
        </Button>
        <Button variant="ghost" size="sm" onClick={onResetUsed}>
          重置用量
        </Button>
        {k.quota_total != null && (
          <Button variant="ghost" size="sm" onClick={onAddTotal}>
            增加额度
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onRegenerate}>
          重新生成
        </Button>
        <span className="sp" />
        <IconButton title="删除" danger onClick={onDelete}>
          <IconTrash size={17} />
        </IconButton>
      </div>
    </Card>
  )
}
