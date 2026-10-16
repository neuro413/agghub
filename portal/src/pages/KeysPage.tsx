import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { api } from '../api'
import { ago, dateTime, money } from '../lib/format'
import type { KeyStatus, PortalGroup, PortalKey } from '../types'
import { PageLayout } from '../components/Layout'
import { GroupPicker } from '../components/GroupPicker'
import { ConfirmDialog, Dialog, Sheet } from '../components/Overlay'
import { useToast } from '../components/Toast'
import { Badge, Button, CopyButton, Empty, Field, IconBadge, Input, Skeleton } from '../components/ui'
import { IconClock, IconEye, IconEyeOff, IconInfo, IconKeyRound, IconLayers, IconPlus, IconPower, IconPowerOff, IconRefresh, IconTrash } from '../components/Icons'

const STATUS: Record<KeyStatus, { tone: 'success' | 'neutral' | 'warning'; label: string }> = {
  enabled: { tone: 'success', label: '已启用' },
  disabled: { tone: 'neutral', label: '已停用' },
  expired: { tone: 'warning', label: '已过期' },
}

const QUICK_EXPIRY = [
  { label: '永不过期', ms: 0 },
  { label: '1 个月', ms: 30 * 86_400_000 },
  { label: '1 天', ms: 86_400_000 },
  { label: '1 小时', ms: 3_600_000 },
]

/** datetime-local 输入框的值（本地时间） */
function toLocalInput(ts: number): string {
  const d = new Date(ts - new Date(ts).getTimezoneOffset() * 60_000)
  return d.toISOString().slice(0, 16)
}

function KeyCell({ item }: { item: PortalKey }) {
  const toast = useToast()
  const [full, setFull] = useState<string | null>(null)
  const reveal = async () => {
    if (full) return setFull(null)
    try { setFull((await api.fullKey(item.id)).key) } catch (e) { toast('error', (e as Error).message) }
  }
  return (
    <div className="pt-key-cell">
      <code className="mono">{full ?? item.key}</code>
      <Button variant="ghost" size="icon-sm" onClick={reveal} title={full ? '隐藏' : '显示完整令牌'} aria-label={full ? '隐藏' : '显示完整令牌'}>
        {full ? <IconEyeOff size={14} /> : <IconEye size={14} />}
      </Button>
      <CopyButton text={async () => full ?? (await api.fullKey(item.id)).key} title="复制令牌" />
    </div>
  )
}

function CreateKeySheet({ groups, onClose, onCreated }: { groups: PortalGroup[]; onClose: () => void; onCreated: (key: PortalKey) => void }) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [group, setGroup] = useState(groups[0]?.name ?? '')
  // 分组列表晚于抽屉打开到达时补上默认选中
  useEffect(() => { if (!group && groups.length) setGroup(groups[0].name) }, [group, groups])
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [quick, setQuick] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const pickQuick = (index: number) => {
    setQuick(index)
    const ms = QUICK_EXPIRY[index].ms
    setExpiresAt(ms ? Date.now() + ms : null)
  }

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > 50) return setError('名称须为 1～50 个字符')
    if (!group) return toast('error', '请选择令牌分组')
    if (expiresAt != null && expiresAt <= Date.now()) return setError('过期时间须晚于当前时间')
    setBusy(true)
    try {
      onCreated(await api.createKey(trimmed, group, expiresAt))
    } catch (err) {
      toast('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      title="创建令牌"
      desc="令牌用于调用 API，消耗直接从账户余额扣除"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>关闭</Button>
          <Button onClick={() => submit()} loading={busy} disabled={!groups.length}>创建</Button>
        </>
      }
    >
      <form onSubmit={submit} className="pt-sheet-section">
        <div className="pt-section-head">
          <IconBadge size="md" tone="primary"><IconKeyRound /></IconBadge>
          <div>
            <div className="pt-section-title">基本信息</div>
            <div className="pt-section-desc">给令牌起个好认的名字，例如所用的客户端</div>
          </div>
        </div>
        <Field label="名称" htmlFor="key-name" error={error}>
          <Input id="key-name" value={name} onChange={e => { setName(e.target.value); setError('') }} placeholder="例如：SillyTavern" maxLength={50} autoFocus />
        </Field>
      </form>
      <div className="pt-sheet-section">
        <div className="pt-section-head">
          <IconBadge size="md" tone="info"><IconLayers /></IconBadge>
          <div>
            <div className="pt-section-title">令牌分组</div>
            <div className="pt-section-desc">分组决定可用的模型和计费倍率，创建后也可以修改</div>
          </div>
        </div>
        <Field label="分组" htmlFor="key-group" hint={groups.length ? '扣费 = 模型价格 × 分组倍率' : '暂无可用分组，请联系管理员'}>
          <GroupPicker id="key-group" groups={groups} value={group} onChange={setGroup} />
        </Field>
      </div>
      <div className="pt-sheet-section">
        <div className="pt-section-head">
          <IconBadge size="md" tone="warning"><IconClock /></IconBadge>
          <div>
            <div className="pt-section-title">过期时间</div>
            <div className="pt-section-desc">到期后令牌自动失效，可以随时删除后重新创建</div>
          </div>
        </div>
        <div className="pt-quick-row">
          {QUICK_EXPIRY.map((q, i) => (
            <Button key={q.label} variant="outline" size="sm" className={quick === i ? 'is-active' : ''} onClick={() => pickQuick(i)}>{q.label}</Button>
          ))}
        </div>
        <Field label="自定义" htmlFor="key-expiry" hint={expiresAt ? `将于 ${dateTime(expiresAt, false)} 过期` : '永不过期'}>
          <Input
            id="key-expiry"
            type="datetime-local"
            value={expiresAt ? toLocalInput(expiresAt) : ''}
            onChange={e => {
              setQuick(-1)
              setExpiresAt(e.target.value ? new Date(e.target.value).getTime() : null)
            }}
          />
        </Field>
      </div>
    </Sheet>
  )
}

/** 修改令牌分组，保存后立即生效 */
function GroupDialog({ item, groups, onClose, onSaved }: { item: PortalKey; groups: PortalGroup[]; onClose: () => void; onSaved: (key: PortalKey) => void }) {
  const toast = useToast()
  const [group, setGroup] = useState(item.group_available && item.group ? item.group : groups[0]?.name ?? '')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (!group) return toast('error', '请选择令牌分组')
    setBusy(true)
    try {
      onSaved(await api.setKeyGroup(item.id, group))
      toast('success', '分组已修改')
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      title="修改令牌分组"
      desc={`「${item.name}」切换分组后立即生效，令牌本身不变`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={save} loading={busy} disabled={!groups.length}>保存</Button>
        </>
      }
    >
      <GroupPicker groups={groups} value={group} onChange={setGroup} />
    </Dialog>
  )
}

export function KeysPage() {
  const toast = useToast()
  const [keys, setKeys] = useState<PortalKey[] | null>(null)
  const [groups, setGroups] = useState<PortalGroup[]>([])
  const [regrouping, setRegrouping] = useState<PortalKey | null>(null)
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<PortalKey | null>(null)
  const [deleting, setDeleting] = useState<PortalKey | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [list, groupList] = await Promise.all([api.keys(signal), api.groups(signal)])
      if (signal?.aborted) return
      setKeys(list)
      setGroups(groupList)
    } catch (e) {
      if (!signal?.aborted) toast('error', (e as Error).message)
    }
  }, [toast])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const toggle = async (item: PortalKey) => {
    setBusyId(item.id)
    try {
      const updated = await api.setKeyEnabled(item.id, item.status === 'disabled')
      setKeys(list => list?.map(k => (k.id === item.id ? updated : k)) ?? null)
      toast('success', updated.status === 'disabled' ? '令牌已停用' : '令牌已启用')
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  const remove = async () => {
    if (!deleting) return
    setBusyId(deleting.id)
    try {
      await api.deleteKey(deleting.id)
      setKeys(list => list?.filter(k => k.id !== deleting.id) ?? null)
      toast('success', '令牌已删除')
      setDeleting(null)
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  const actions = (
    <>
      <Button variant="outline" size="sm" onClick={() => load()}><IconRefresh size={14} />刷新</Button>
      <Button size="sm" onClick={() => setCreating(true)}><IconPlus size={14} />创建令牌</Button>
    </>
  )

  return (
    <PageLayout title="令牌管理" desc="管理调用 API 用的令牌，所有令牌共用账户余额" actions={actions}>
      {keys == null ? (
        <div style={{ display: 'grid', gap: 8 }}>{[0, 1, 2].map(i => <Skeleton key={i} height={52} />)}</div>
      ) : keys.length === 0 ? (
        <div className="pt-table-wrap">
          <Empty icon={<IconKeyRound size={20} />} title="还没有令牌" desc="创建一个令牌，填进客户端就能开始调用" action={<Button size="sm" onClick={() => setCreating(true)}><IconPlus size={14} />创建令牌</Button>} />
        </div>
      ) : (
        <div className="pt-table-wrap">
          <table className="pt-table">
            <thead>
              <tr>
                <th>名称</th><th>状态</th><th>分组</th><th>令牌</th><th className="num">已用额度</th><th>创建 / 最近使用</th><th>过期时间</th><th className="num">操作</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k, i) => (
                <tr key={k.id} style={{ animationDelay: `${Math.min(i, 10) * 25}ms` }}>
                  <td style={{ fontWeight: 500 }}>{k.name}</td>
                  <td><Badge tone={STATUS[k.status].tone} dot>{STATUS[k.status].label}</Badge></td>
                  <td>
                    {k.group_available
                      ? <span className="pt-chip"><IconLayers size={12} />{k.group}</span>
                      : <Badge tone="warning" title="分组已删除或不再开放，令牌无法调用，请修改分组">{k.group ? `${k.group} 不可用` : '未选分组'}</Badge>}
                  </td>
                  <td><KeyCell item={k} /></td>
                  <td className="num mono">{money(k.used_quota)}</td>
                  <td>
                    <div className="pt-cell-stack">
                      <span className="mono" style={{ fontSize: 12 }}>{dateTime(k.created_at, false)}</span>
                      <span className="pt-cell-sub">{ago(k.last_used_at)}</span>
                    </div>
                  </td>
                  <td>
                    {k.expires_at == null
                      ? <Badge tone="outline">永不过期</Badge>
                      : <span className="mono" style={{ fontSize: 12, color: k.status === 'expired' ? 'var(--destructive)' : undefined }}>{dateTime(k.expires_at, false)}</span>}
                  </td>
                  <td className="num">
                    <div className="pt-row-actions">
                      {k.status !== 'expired' && (
                        <Button variant="ghost" size="icon-sm" disabled={busyId === k.id} onClick={() => toggle(k)} title={k.status === 'disabled' ? '启用' : '停用'} aria-label={k.status === 'disabled' ? '启用' : '停用'}>
                          {k.status === 'disabled' ? <IconPower size={14} /> : <IconPowerOff size={14} />}
                        </Button>
                      )}
                      <Button variant="ghost" size="icon-sm" onClick={() => setRegrouping(k)} title="修改分组" aria-label="修改分组"><IconLayers size={14} /></Button>
                      <Button variant="ghost" size="icon-sm" className="pt-btn-danger-text" onClick={() => setDeleting(k)} title="删除" aria-label="删除"><IconTrash size={14} /></Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <CreateKeySheet
          groups={groups}
          onClose={() => setCreating(false)}
          onCreated={key => {
            setCreating(false)
            setCreated(key)
            void load()
          }}
        />
      )}

      {created?.full_key && (
        <Dialog
          title="令牌已创建"
          desc={`「${created.name}」已可以使用，之后也能在列表里随时复制`}
          onClose={() => setCreated(null)}
          wide
          footer={<Button onClick={() => setCreated(null)}>完成</Button>}
        >
          <div className="pt-created-key">
            <Input readOnly value={created.full_key} className="mono" onFocus={e => e.currentTarget.select()} />
            <CopyButton text={created.full_key} label="复制" />
          </div>
          <div className="pt-alert"><IconInfo size={14} />请妥善保管令牌，泄露后他人可以消耗你的余额；发现泄露请立即删除。</div>
        </Dialog>
      )}

      {regrouping && (
        <GroupDialog
          item={regrouping}
          groups={groups}
          onClose={() => setRegrouping(null)}
          onSaved={updated => {
            setKeys(list => list?.map(k => (k.id === updated.id ? updated : k)) ?? null)
            setRegrouping(null)
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title="确定删除这个令牌？"
          desc={<>令牌「{deleting.name}」将被永久删除，使用它的客户端会立即无法调用。此操作不可撤销。</>}
          busy={busyId === deleting.id}
          onConfirm={remove}
          onClose={() => setDeleting(null)}
        />
      )}
    </PageLayout>
  )
}
