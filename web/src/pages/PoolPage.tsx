import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { api } from '../api/client'
import { Button, IconButton } from '../components/Button'
import { Card } from '../components/Card'
import { Dropdown, Input } from '../components/Form'
import {
  IconChevronLeft, IconChevronRight, IconCopy, IconEdit, IconGlobe, IconPlus, IconRefresh, IconSearch, IconTest, IconTrash,
} from '../components/Icons'
import { Modal } from '../components/Modal'
import { Loading } from '../components/Primitives'
import { useToast } from '../components/Toast'
import { Toggle } from '../components/Toggle'
import { copyText } from '../lib/clipboard'
import { fmtBytes, fmtTime } from '../lib/format'
import type { PoolCoreStatus, PoolNodeView, PoolSettings, PoolStatus, PoolSubscription } from '../types'
import { PoolImportModal } from './PoolImportModal'
import { PoolSubscriptionModal } from './PoolSubscriptionModal'
import { PageHead } from '../components/PageHead'

type SubTab = 'nodes' | 'subs' | 'settings'
type SubsState = { list: PoolSubscription[]; updating: number[] }

const PAGE_SIZE = 50

const CORE_STATE: Record<PoolCoreStatus['state'], { label: string; cls: string }> = {
  running: { label: '运行中', cls: 'ah-tag-ok' },
  starting: { label: '启动中', cls: 'ah-tag-warn' },
  stopped: { label: '已停止', cls: '' },
  not_installed: { label: '未安装', cls: 'ah-tag-warn' },
  error: { label: '出错', cls: 'ah-tag-err' },
}

function clock(ts: number): string {
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function sourceLabel(source: string, subs: PoolSubscription[]): string {
  if (source === 'manual') return '手动'
  const id = Number(source.replace(/^sub:/, ''))
  return subs.find((s) => s.id === id)?.name ?? `订阅#${id}`
}

interface NodeState {
  key: 'invalid' | 'disabled' | 'cooling' | 'idle' | 'sub' | 'ok'
  label: string
  cls: string
  title?: string
}

function nodeState(n: PoolNodeView, now: number): NodeState {
  if (n.invalid_reason) return { key: 'invalid', label: '无效', cls: 'ah-tag-err', title: n.invalid_reason }
  if (n.disabled) return { key: 'disabled', label: '已禁用', cls: '' }
  if (n.cooldown_until && n.cooldown_until > now) {
    return { key: 'cooling', label: `冷却至 ${clock(n.cooldown_until)}`, cls: 'ah-tag-warn', title: n.last_error ?? undefined }
  }
  if (n.local_port == null) return { key: 'idle', label: '未监听', cls: '', title: '内核未运行或还没加载到该节点' }
  if (n.sub_healthy) return { key: 'sub', label: '亚健康', cls: 'ah-tag-warn', title: n.last_error ?? '最近一次失败晚于最近一次成功' }
  return { key: 'ok', label: '可用', cls: 'ah-tag-ok', title: `本地端口 ${n.local_port}` }
}

function delayCell(n: PoolNodeView): { text: string; cls: string; title?: string } {
  if (!n.last_test_at) return { text: '—', cls: 'ah-faint' }
  if (n.last_delay_ms == null) return { text: '失败', cls: 'is-err', title: n.last_error ?? undefined }
  const cls = n.last_delay_ms < 300 ? 'is-ok' : n.last_delay_ms < 1000 ? 'is-warn' : 'is-err'
  return { text: `${n.last_delay_ms}ms`, cls, title: `测于 ${fmtTime(n.last_test_at, true)}` }
}

/** subscription-userinfo：upload=..; download=..; total=..; expire=.. */
function parseUserinfo(raw: string | null): string | null {
  if (!raw) return null
  const map: Record<string, number> = {}
  for (const part of raw.split(';')) {
    const [k, v] = part.split('=').map((s) => s.trim())
    if (k && v && Number.isFinite(Number(v))) map[k.toLowerCase()] = Number(v)
  }
  const parts: string[] = []
  if (map.total) parts.push(`已用 ${fmtBytes((map.upload ?? 0) + (map.download ?? 0))} / ${fmtBytes(map.total)}`)
  if (map.expire) parts.push(`到期 ${new Date(map.expire * 1000).toLocaleDateString()}`)
  return parts.length ? parts.join(' · ') : null
}

export function PoolPage() {
  const toast = useToast()
  const [status, setStatus] = useState<PoolStatus | null>(null)
  const [nodes, setNodes] = useState<PoolNodeView[] | null>(null)
  const [subs, setSubs] = useState<SubsState>({ list: [], updating: [] })
  const [tab, setTab] = useState<SubTab>('nodes')
  const [toggling, setToggling] = useState(false)

  const loadStatus = useCallback(() => api.poolStatus().then(setStatus).catch(() => {}), [])
  const loadNodes = useCallback(() => api.poolNodes().then((r) => setNodes(r.nodes)).catch(() => {}), [])
  const loadSubs = useCallback(() => api.poolSubscriptions().then(setSubs).catch(() => {}), [])
  const reloadAll = useCallback(() => {
    loadStatus()
    loadNodes()
    loadSubs()
  }, [loadStatus, loadNodes, loadSubs])

  useEffect(reloadAll, [reloadAll])

  // 测速 / 订阅更新 / 内核启动或下载时加快轮询
  const busy = !!status && (status.test.running || status.core.state === 'starting' || status.core.downloading) || subs.updating.length > 0
  useEffect(() => {
    const t1 = setInterval(loadStatus, busy ? 1500 : 10_000)
    const t2 = setInterval(() => {
      loadNodes()
      loadSubs()
    }, busy ? 3000 : 10_000)
    return () => {
      clearInterval(t1)
      clearInterval(t2)
    }
  }, [busy, loadStatus, loadNodes, loadSubs])

  // 测速结束后立即刷新一次节点
  const testRunning = !!status?.test.running
  const prevRunning = useRef(testRunning)
  useEffect(() => {
    if (prevRunning.current && !testRunning) loadNodes()
    prevRunning.current = testRunning
  }, [testRunning, loadNodes])

  const toggleEnabled = async (value: boolean) => {
    setToggling(true)
    try {
      setStatus(await api.poolSaveSettings({ enabled: value }))
      toast('ok', value ? '代理池已启用' : '代理池已停用')
      loadNodes()
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setToggling(false)
    }
  }

  const core = status?.core
  const counts = status?.counts
  const stateInfo = core ? CORE_STATE[core.state] : null

  return (
    <div className="ah-fade-up">
      <PageHead
        title="代理池"
        sub={<>内置 mihomo · 内核 {stateInfo?.label ?? '…'}{core?.version ? ` ${core.version}` : ''} · 节点 {counts?.total ?? 0} 个 · 可用 {counts?.available ?? 0} 个</>}
        actions={
          <>
            <IconButton title="刷新" onClick={reloadAll}>
              <IconRefresh size={18} />
            </IconButton>
            <span className="ah-mini ah-muted">{status?.settings.enabled ? '已启用' : '未启用'}</span>
            {toggling ? <span className="ah-spin ah-spin-orange" /> : <Toggle checked={!!status?.settings.enabled} onChange={toggleEnabled} />}
          </>
        }
      />

      {status ? <CoreCard status={status} onChanged={setStatus} /> : <Loading />}

      <div className="ah-pp-chips ah-pool-tabs">
        {([
          ['nodes', `节点 ${counts?.total ?? 0}`],
          ['subs', `订阅 ${subs.list.length}`],
          ['settings', '设置'],
        ] as [SubTab, string][]).map(([key, label]) => (
          <button key={key} type="button" className={`ah-pp-chip${tab === key ? ' is-on' : ''}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'nodes' && status && (
        <NodesPanel nodes={nodes} status={status} subs={subs.list} onReload={loadNodes} onStatus={setStatus} reloadStatus={loadStatus} />
      )}
      {tab === 'subs' && <SubsPanel subs={subs} onReload={() => { loadSubs(); loadNodes() }} />}
      {tab === 'settings' && status && <SettingsPanel status={status} onSaved={setStatus} />}
    </div>
  )
}

// ── 内核卡 ──
function CoreCard({ status, onChanged }: { status: PoolStatus; onChanged: (s: PoolStatus) => void }) {
  const toast = useToast()
  const { core, settings } = status
  const [downloading, setDownloading] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [logs, setLogs] = useState<string[] | null>(null)
  const info = CORE_STATE[core.state]

  const loadLogs = () => api.poolCoreLogs().then((r) => setLogs(r.lines)).catch((e) => toast('err', e.message))

  const download = async () => {
    setDownloading(true)
    try {
      const r = await api.poolDownloadCore()
      toast('ok', `内核已更新到 ${r.version}`)
      onChanged(await api.poolStatus())
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setDownloading(false)
      if (logs) loadLogs()
    }
  }

  const restart = async () => {
    setRestarting(true)
    try {
      await api.poolRestartCore()
      onChanged(await api.poolStatus())
      toast('ok', '内核已重启')
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setRestarting(false)
      if (logs) loadLogs()
    }
  }

  return (
    <Card className="ah-set-card">
      <div className="ah-set-title">
        <IconGlobe size={18} /> mihomo 内核
        <span className={`ah-tag ${info.cls}`}>{info.label}</span>
      </div>
      <div className="ah-set-desc">
        版本 {core.version ?? (core.installed ? '读取中' : '—')} · 监听节点 {core.listeners} 个{core.pid ? ` · pid ${core.pid}` : ''}
        <br />
        <span className="ah-faint">{core.path}</span>
        {settings.core_path && <span className="ah-faint">（自定义路径，「下载内核」只会写到默认位置 data/mihomo/）</span>}
      </div>
      {core.error && <div className="ah-pool-alert">{core.error}</div>}
      {core.entry_error && <div className="ah-pool-alert">{core.entry_error}</div>}
      {!settings.enabled && core.installed && <div className="ah-mini ah-muted" style={{ marginBottom: 10 }}>打开右上角总开关后启动内核</div>}
      <div className="ah-row" style={{ flexWrap: 'wrap' }}>
        <Button size="sm" variant="primary" loading={downloading || core.downloading} onClick={download}>
          {core.installed ? '更新内核' : '下载内核'}
        </Button>
        <Button size="sm" loading={restarting} disabled={!settings.enabled || !core.installed} onClick={restart}>
          重启
        </Button>
        <Button size="sm" variant="ghost" onClick={() => (logs ? setLogs(null) : loadLogs())}>
          {logs ? '收起日志' : '内核日志'}
        </Button>
        {logs && (
          <Button size="sm" variant="ghost" onClick={loadLogs}>
            刷新日志
          </Button>
        )}
      </div>
      {logs && <pre className="ah-code-block ah-pool-logs">{logs.length ? logs.join('\n') : '暂无日志'}</pre>}
    </Card>
  )
}

// ── 节点 ──
function NodesPanel({
  nodes,
  status,
  subs,
  onReload,
  onStatus,
  reloadStatus,
}: {
  nodes: PoolNodeView[] | null
  status: PoolStatus
  subs: PoolSubscription[]
  onReload: () => void
  onStatus: (s: PoolStatus) => void
  reloadStatus: () => void
}) {
  const toast = useToast()
  const [q, setQ] = useState('')
  const [stateFilter, setStateFilter] = useState('')
  const [sourceFilter, setSourceFilter] = useState('')
  const [sort, setSort] = useState('')
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [testing, setTesting] = useState<Set<number>>(new Set())
  const [disableFailed, setDisableFailed] = useState(true)
  const [importing, setImporting] = useState(false)
  const [busy, setBusy] = useState(false)
  const now = Date.now()

  const filtered = useMemo(() => {
    if (!nodes) return []
    const kw = q.trim().toLowerCase()
    const list = nodes.filter((n) => {
      if (kw && !n.name.toLowerCase().includes(kw) && !n.server.toLowerCase().includes(kw)) return false
      if (sourceFilter && !n.sources.includes(sourceFilter)) return false
      if (!stateFilter) return true
      const key = nodeState(n, now).key
      if (stateFilter === 'available') return key === 'ok' || key === 'sub'
      return key === stateFilter
    })
    const delay = (n: PoolNodeView) => (n.last_delay_ms == null ? Number.POSITIVE_INFINITY : n.last_delay_ms)
    if (sort === 'delay_asc') list.sort((a, b) => delay(a) - delay(b))
    else if (sort === 'delay_desc') list.sort((a, b) => (b.last_delay_ms ?? -1) - (a.last_delay_ms ?? -1))
    else if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name))
    return list
    // now 只用于状态筛选，跟随节点刷新即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, q, stateFilter, sourceFilter, sort])

  useEffect(() => setPage(0), [q, stateFilter, sourceFilter, sort])
  // 节点被删后去掉失效的勾选
  useEffect(() => {
    if (!nodes) return
    const ids = new Set(nodes.map((n) => n.id))
    setSelected((s) => (([...s].every((id) => ids.has(id))) ? s : new Set([...s].filter((id) => ids.has(id)))))
  }, [nodes])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const current = Math.min(page, pageCount - 1)
  const pageItems = filtered.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE)
  const allOnPage = pageItems.length > 0 && pageItems.every((n) => selected.has(n.id))
  const test = status.test
  const coreRunning = status.core.state === 'running'

  const toggleSel = (id: number) =>
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const togglePage = () =>
    setSelected((s) => {
      const next = new Set(s)
      for (const n of pageItems) {
        if (allOnPage) next.delete(n.id)
        else next.add(n.id)
      }
      return next
    })

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setBusy(false)
      onReload()
      reloadStatus()
    }
  }

  const batch = (action: 'enable' | 'disable' | 'delete' | 'reset', ids = [...selected]) =>
    run(async () => {
      if (action === 'delete' && !window.confirm(`确认删除选中的 ${ids.length} 个节点？`)) return
      const r = await api.poolBatch(ids, action)
      toast('ok', `已处理 ${r.count} 个节点`)
      if (action === 'delete') setSelected(new Set())
    })

  const startTest = () =>
    run(async () => {
      const ids = selected.size ? [...selected] : filtered.map((n) => n.id)
      if (!ids.length) return
      await api.poolStartTest(ids, disableFailed)
      onStatus(await api.poolStatus())
    })

  const control = (action: 'pause' | 'resume' | 'stop') => run(async () => { await api.poolTestControl(action) })

  const testOne = async (n: PoolNodeView) => {
    setTesting((s) => new Set(s).add(n.id))
    try {
      const r = await api.poolTestNode(n.id)
      if (r.ok) toast('ok', `${n.name}：${r.delay}ms`)
      else toast('err', `${n.name}：${r.error}`)
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setTesting((s) => {
        const next = new Set(s)
        next.delete(n.id)
        return next
      })
      onReload()
    }
  }

  const copyLink = async (n: PoolNodeView) => {
    try {
      const r = await api.poolNodeRaw(n.id)
      const text = r.raw ?? JSON.stringify(r.config)
      if (await copyText(text)) toast('ok', r.raw ? '节点链接已复制' : '节点配置（JSON）已复制')
      else toast('err', '复制失败')
    } catch (e: any) {
      toast('err', e.message)
    }
  }

  const deleteDisabled = () =>
    run(async () => {
      if (!window.confirm('确认删除全部已禁用的节点？')) return
      const r = await api.poolDeleteDisabled()
      toast('ok', `已删除 ${r.deleted} 个节点`)
    })

  return (
    <>
      <Card className="ah-log-filters">
        <div className="ah-log-search">
          <IconSearch size={17} className="ah-log-search-icon" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索节点名 / 服务器…" />
        </div>
        <Dropdown
          value={stateFilter}
          onChange={setStateFilter}
          options={[
            { value: '', label: '全部状态' },
            { value: 'available', label: '可用' },
            { value: 'cooling', label: '冷却中' },
            { value: 'sub', label: '亚健康' },
            { value: 'disabled', label: '已禁用' },
            { value: 'invalid', label: '无效' },
            { value: 'idle', label: '未监听' },
          ]}
        />
        <Dropdown
          value={sourceFilter}
          onChange={setSourceFilter}
          options={[
            { value: '', label: '全部来源' },
            { value: 'manual', label: '手动导入' },
            ...subs.map((s) => ({ value: `sub:${s.id}`, label: s.name })),
          ]}
        />
        <Dropdown
          value={sort}
          onChange={setSort}
          options={[
            { value: '', label: '默认排序' },
            { value: 'delay_asc', label: '延迟从低到高' },
            { value: 'delay_desc', label: '延迟从高到低' },
            { value: 'name', label: '按名称' },
          ]}
        />
      </Card>

      <div className="ah-pool-toolbar">
        <Button size="sm" variant="primary" icon={<IconPlus size={16} />} onClick={() => setImporting(true)}>
          导入节点
        </Button>
        <Button size="sm" icon={<IconTest size={16} />} disabled={busy || test.running || !coreRunning} onClick={startTest}
          title={coreRunning ? undefined : '内核未运行'}>
          {selected.size ? `测速选中 ${selected.size} 个` : `测速当前列表 ${filtered.length} 个`}
        </Button>
        <label className="ah-pool-check" title="测速失败的节点直接禁用，不再参与选路">
          <input type="checkbox" checked={disableFailed} onChange={(e) => setDisableFailed(e.target.checked)} />
          失败自动禁用
        </label>
        <span className="ah-pool-sep" />
        <Button size="sm" disabled={busy || !selected.size} onClick={() => batch('enable')}>启用</Button>
        <Button size="sm" disabled={busy || !selected.size} onClick={() => batch('disable')}>禁用</Button>
        <Button size="sm" disabled={busy || !selected.size} onClick={() => batch('reset')} title="清除冷却、连续失败与无效标记">
          重置健康
        </Button>
        <Button size="sm" variant="danger" disabled={busy || !selected.size} onClick={() => batch('delete')}>删除</Button>
        <span style={{ flex: 1 }} />
        <Button size="sm" variant="ghost" disabled={busy} onClick={deleteDisabled}>删除禁用节点</Button>
      </div>

      {test.running && (
        <Card className="ah-set-card ah-pool-progress">
          <div className="ah-row" style={{ justifyContent: 'space-between' }}>
            <span className="ah-mini">
              {test.kind === 'probe' ? '定时拨测中' : test.paused ? '测速已暂停' : '测速中'} · {test.done}/{test.total} · 成功 {test.ok} · 失败 {test.fail}
            </span>
            {test.kind === 'batch' && (
              <span className="ah-row">
                {test.paused ? (
                  <Button size="sm" onClick={() => control('resume')}>继续</Button>
                ) : (
                  <Button size="sm" onClick={() => control('pause')}>暂停</Button>
                )}
                <Button size="sm" variant="danger" onClick={() => control('stop')}>终止</Button>
              </span>
            )}
          </div>
          <div className="ah-bar" style={{ marginTop: 8 }}>
            <i style={{ width: `${test.total ? Math.round((test.done / test.total) * 100) : 0}%` }} />
          </div>
        </Card>
      )}

      <Card className="ah-logs-table-card">
        <div className="ah-logt-head">
          <span className="c-pool-check">
            <input type="checkbox" checked={allOnPage} onChange={togglePage} title="全选当前页" />
          </span>
          <span className="c-pool-name">节点</span>
          <span className="c-pool-src">来源</span>
          <span className="c-pool-delay">延迟</span>
          <span className="c-pool-state">状态</span>
          <span className="c-pool-count">成功 / 失败</span>
          <span className="c-pool-flight">并发</span>
          <span className="c-pool-act" />
        </div>
        {!nodes ? (
          <Loading />
        ) : pageItems.length === 0 ? (
          <div className="ah-logt-empty">
            <IconGlobe size={30} style={{ opacity: 0.4, display: 'block', margin: '0 auto 10px' }} />
            {nodes.length ? '没有符合条件的节点' : '还没有节点，点「导入节点」或在「订阅」页添加订阅'}
          </div>
        ) : (
          pageItems.map((n) => {
            const st = nodeState(n, now)
            const d = delayCell(n)
            return (
              <div key={n.id} className="ah-logt-row ah-pool-row">
                <span className="c-pool-check">
                  <input type="checkbox" checked={selected.has(n.id)} onChange={() => toggleSel(n.id)} />
                </span>
                <span className="c-pool-name">
                  <span className="ah-logt-model ah-truncate" title={n.name}>
                    <span className="ah-fmt-badge ah-pool-type">{n.type}</span>
                    {n.name}
                  </span>
                  <span className="ah-mini ah-faint ah-truncate">
                    {n.server}:{n.server_port ?? '?'}
                  </span>
                </span>
                <span className="c-pool-src ah-truncate">
                  {n.sources.map((s) => (
                    <span key={s} className="ah-tag" style={{ marginRight: 4 }}>
                      {sourceLabel(s, subs)}
                    </span>
                  ))}
                </span>
                <span className={`c-pool-delay ah-mini ah-num ah-pool-delay ${d.cls}`} title={d.title}>
                  {d.text}
                </span>
                <span className="c-pool-state">
                  <span className={`ah-tag ${st.cls}`} title={st.title}>
                    {st.label}
                  </span>
                </span>
                <span className="c-pool-count ah-mini ah-muted ah-num" title={n.limit_count ? `429/403 共 ${n.limit_count} 次` : undefined}>
                  {n.success_count} / {n.fail_count + n.limit_count}
                </span>
                <span className="c-pool-flight ah-mini ah-muted ah-num">{n.in_flight}</span>
                <span className="c-pool-act">
                  {testing.has(n.id) ? (
                    <span className="ah-spin ah-spin-orange" style={{ margin: '0 8px' }} />
                  ) : (
                    <IconButton title="测速" onClick={() => testOne(n)}>
                      <IconTest size={16} />
                    </IconButton>
                  )}
                  <IconButton title="复制链接" onClick={() => copyLink(n)}>
                    <IconCopy size={16} />
                  </IconButton>
                  <Toggle checked={!n.disabled} onChange={(v) => batch(v ? 'enable' : 'disable', [n.id])} />
                  <IconButton title="删除" danger onClick={() => batch('delete', [n.id])}>
                    <IconTrash size={16} />
                  </IconButton>
                </span>
              </div>
            )
          })
        )}
        {pageCount > 1 && (
          <div className="ah-logt-pager">
            <IconButton title="上一页" onClick={() => setPage(Math.max(0, current - 1))}>
              <IconChevronLeft size={18} />
            </IconButton>
            <span className="ah-mini ah-muted ah-num">
              {current + 1} / {pageCount} · 共 {filtered.length} 个
            </span>
            <IconButton title="下一页" onClick={() => setPage(Math.min(pageCount - 1, current + 1))}>
              <IconChevronRight size={18} />
            </IconButton>
          </div>
        )}
      </Card>

      {importing && <PoolImportModal onClose={() => setImporting(false)} onImported={() => { onReload(); reloadStatus() }} />}
    </>
  )
}

// ── 订阅 ──
function SubsPanel({ subs, onReload }: { subs: SubsState; onReload: () => void }) {
  const toast = useToast()
  const [editing, setEditing] = useState<PoolSubscription | 'new' | null>(null)
  const [deleting, setDeleting] = useState<PoolSubscription | null>(null)

  const refreshOne = async (s: PoolSubscription) => {
    try {
      const r = await api.poolRefreshSubscription(s.id)
      toast(r.triggered ? 'ok' : 'info', r.triggered ? `正在更新「${s.name}」` : '该订阅正在更新中')
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      onReload()
    }
  }

  const refreshAll = async () => {
    try {
      const r = await api.poolRefreshAll()
      toast('ok', `已触发 ${r.triggered} 个订阅更新`)
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      onReload()
    }
  }

  return (
    <>
      <div className="ah-pool-toolbar">
        <Button size="sm" variant="primary" icon={<IconPlus size={16} />} onClick={() => setEditing('new')}>
          新增订阅
        </Button>
        <Button size="sm" icon={<IconRefresh size={16} />} disabled={!subs.list.length} onClick={refreshAll}>
          全部更新
        </Button>
      </div>
      <Card className="ah-logs-table-card">
        <div className="ah-logt-head">
          <span className="c-sub-name">订阅</span>
          <span className="c-sub-count">节点</span>
          <span className="c-sub-auto">自动更新</span>
          <span className="c-sub-last">上次更新</span>
          <span className="c-pool-act" />
        </div>
        {subs.list.length === 0 ? (
          <div className="ah-logt-empty">还没有订阅，点「新增订阅」添加机场订阅链接</div>
        ) : (
          subs.list.map((s) => {
            const updating = subs.updating.includes(s.id)
            const traffic = parseUserinfo(s.userinfo)
            return (
              <div key={s.id} className="ah-logt-row ah-pool-row">
                <span className="c-sub-name">
                  <span className="ah-logt-model ah-truncate">{s.name}</span>
                  <span className="ah-mini ah-faint ah-truncate" title={s.url}>{s.url}</span>
                  {traffic && <span className="ah-mini ah-muted">{traffic}</span>}
                </span>
                <span className="c-sub-count ah-mini ah-num">{s.node_count}</span>
                <span className="c-sub-auto ah-mini ah-muted">{s.update_interval ? `每 ${s.update_interval} 分钟` : '仅手动'}</span>
                <span className="c-sub-last ah-mini">
                  {updating ? (
                    <span className="ah-row" style={{ gap: 6 }}>
                      <span className="ah-spin ah-spin-orange" /> 更新中
                    </span>
                  ) : s.last_error ? (
                    <span className="ah-pool-delay is-err ah-truncate" title={s.last_error}>
                      失败：{s.last_error}
                    </span>
                  ) : s.last_update_at ? (
                    <span className="ah-muted">{fmtTime(s.last_update_at)}</span>
                  ) : (
                    <span className="ah-faint">从未</span>
                  )}
                </span>
                <span className="c-pool-act">
                  <IconButton title="立即更新" onClick={() => refreshOne(s)}>
                    <IconRefresh size={16} />
                  </IconButton>
                  <IconButton title="编辑" onClick={() => setEditing(s)}>
                    <IconEdit size={16} />
                  </IconButton>
                  <IconButton title="删除" danger onClick={() => setDeleting(s)}>
                    <IconTrash size={16} />
                  </IconButton>
                </span>
              </div>
            )
          })
        )}
      </Card>
      {editing && (
        <PoolSubscriptionModal sub={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={onReload} />
      )}
      {deleting && <SubDeleteModal sub={deleting} onClose={() => setDeleting(null)} onDeleted={onReload} />}
    </>
  )
}

function SubDeleteModal({ sub, onClose, onDeleted }: { sub: PoolSubscription; onClose: () => void; onDeleted: () => void }) {
  const toast = useToast()
  const [deleteNodes, setDeleteNodes] = useState(false)
  const [saving, setSaving] = useState(false)
  const submit = async () => {
    setSaving(true)
    try {
      await api.poolDeleteSubscription(sub.id, deleteNodes)
      toast('ok', '订阅已删除')
      onDeleted()
      onClose()
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      title={`删除订阅「${sub.name}」`}
      onClose={onClose}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <Button onClick={onClose}>取消</Button>
          <Button variant="danger" loading={saving} onClick={submit}>
            删除
          </Button>
        </>
      }
    >
      <label className="ah-pool-check">
        <input type="checkbox" checked={deleteNodes} onChange={(e) => setDeleteNodes(e.target.checked)} />
        同时删除该订阅的节点
      </label>
      <div className="ah-hint" style={{ marginTop: 8 }}>
        不勾选时，该订阅的节点保留并转为手动节点；同时属于其他订阅的节点不会被删除
      </div>
    </Modal>
  )
}

// ── 设置 ──
type SettingsForm = Omit<PoolSettings, 'secret' | 'enabled'>

function Row({ label, desc, children, wide }: { label: string; desc?: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className="ah-set-row">
      <div className="ah-set-row-info">
        <div className="ah-set-row-label">{label}</div>
        {desc && <div className="ah-set-row-desc">{desc}</div>}
      </div>
      <div className="ah-set-row-control" style={wide ? { width: 360 } : undefined}>
        {children}
      </div>
    </div>
  )
}

function SettingsPanel({ status, onSaved }: { status: PoolStatus; onSaved: (s: PoolStatus) => void }) {
  const toast = useToast()
  const pick = (s: PoolStatus['settings']): SettingsForm => {
    const { enabled: _enabled, ...rest } = s
    return rest
  }
  const [form, setForm] = useState<SettingsForm>(() => pick(status.settings))
  const [saving, setSaving] = useState(false)
  const [testingEntry, setTestingEntry] = useState(false)
  const set = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) => setForm((f) => ({ ...f, [key]: value }))
  const num = (key: keyof SettingsForm) => ({
    type: 'number',
    value: String(form[key]),
    onChange: (e: ChangeEvent<HTMLInputElement>) => set(key, Number(e.target.value) as never),
  })
  const dirty = JSON.stringify(form) !== JSON.stringify(pick(status.settings))

  const save = async () => {
    setSaving(true)
    try {
      const next = await api.poolSaveSettings(form)
      onSaved(next)
      setForm(pick(next.settings))
      toast('ok', '代理池设置已保存')
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setSaving(false)
    }
  }

  const testEntry = async () => {
    setTestingEntry(true)
    try {
      const r = await api.poolTestEntry()
      if (r.ok) toast('ok', `入口代理可用：${r.delay}ms`)
      else toast('err', `入口代理测试失败：${r.error}`)
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setTestingEntry(false)
    }
  }

  return (
    <>
      <Card className="ah-set-card">
        <div className="ah-set-title">测速与拨测</div>
        <Row label="测速 URL" desc="mihomo 延迟测试访问的地址" wide>
          <Input value={form.test_url} onChange={(e) => set('test_url', e.target.value)} />
        </Row>
        <Row label="测速超时（毫秒）">
          <Input {...num('test_timeout_ms')} min={500} max={60000} />
        </Row>
        <Row label="测速并发" desc="批量测速同时进行的节点数，1~100">
          <Input {...num('test_concurrency')} min={1} max={100} />
        </Row>
        <Row label="定时拨测" desc="定期测一遍全部启用节点，结果计入节点健康">
          <Toggle checked={form.probe_enabled} onChange={(v) => set('probe_enabled', v)} />
        </Row>
        <Row label="拨测间隔（分钟）">
          <Input {...num('probe_interval_minutes')} min={1} max={1440} />
        </Row>
        <Row label="拨测自动禁用阈值" desc="拨测时连续失败达到该次数自动禁用节点，0 为不自动禁用">
          <Input {...num('auto_disable_failures')} min={0} max={100} />
        </Row>
      </Card>

      <Card className="ah-set-card">
        <div className="ah-set-title">请求重试</div>
        <Row label="单次尝试最多换几个节点" desc="节点网络错误或上游返回 429/403 时冷却该节点并换下一个，不消耗渠道的同渠道重试次数">
          <Input {...num('node_retry_times')} min={0} max={20} />
        </Row>
        <Row label="429 / 403 冷却秒数" desc="上游带 Retry-After 且更长时取它；网络错误的冷却从 30 秒起按连续失败次数翻倍，最长 30 分钟">
          <Input {...num('limit_cooldown_seconds')} min={0} max={86400} />
        </Row>
      </Card>

      <Card className="ah-set-card">
        <div className="ah-set-title">入口代理</div>
        <Row label="入口代理" desc="链式代理的第一跳：所有节点都先经过它再连接。可填节点链接或 http(s)/socks5 地址，留空不启用" wide>
          <div className="ah-row" style={{ width: '100%' }}>
            <Input value={form.entry_proxy} onChange={(e) => set('entry_proxy', e.target.value)} placeholder="socks5://127.0.0.1:1080" />
            <Button size="sm" loading={testingEntry} disabled={!status.settings.entry_proxy || dirty} onClick={testEntry}
              title={dirty ? '先保存再测试' : undefined}>
              测试
            </Button>
          </div>
        </Row>
      </Card>

      <Card className="ah-set-card">
        <div className="ah-set-title">内核与网络</div>
        <Row label="内核路径" desc="留空使用 data/mihomo/ 下自动下载的内核" wide>
          <Input value={form.core_path} onChange={(e) => set('core_path', e.target.value)} placeholder="默认路径" />
        </Row>
        <Row label="控制端口" desc="mihomo 控制接口，只监听 127.0.0.1">
          <Input {...num('controller_port')} min={1024} max={65535} />
        </Row>
        <Row label="监听起始端口" desc="每个启用节点占用一个本地端口，从这里往后分配">
          <Input {...num('listen_base_port')} min={1024} max={65000} />
        </Row>
        <Row label="下载代理" desc="下载内核与拉取订阅时使用（订阅先直连，失败才走代理），留空用全局代理" wide>
          <Input value={form.download_proxy} onChange={(e) => set('download_proxy', e.target.value)} placeholder="http://127.0.0.1:7890" />
        </Row>
      </Card>

      <div className="ah-row" style={{ justifyContent: 'flex-end', marginBottom: 24 }}>
        {dirty && <span className="ah-mini ah-muted">有未保存的修改</span>}
        <Button variant="primary" loading={saving} disabled={!dirty} onClick={save}>
          保存
        </Button>
      </div>
    </>
  )
}
