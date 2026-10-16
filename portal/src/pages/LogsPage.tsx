import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useSession } from '../session'
import { dateTime, num, seconds, money } from '../lib/format'
import type { LogPage, PortalKey } from '../types'
import { PageLayout } from '../components/Layout'
import { Pagination } from '../components/Pagination'
import { useToast } from '../components/Toast'
import { Badge, Button, Empty, Input, Skeleton } from '../components/ui'
import { IconFileText, IconKeyRound, IconRefresh, IconSearch } from '../components/Icons'

const FORMAT_LABEL: Record<string, string> = { openai: 'Chat', anthropic: 'Messages', responses: 'Responses' }

export function LogsPage() {
  const toast = useToast()
  const { status } = useSession()
  const [keys, setKeys] = useState<PortalKey[]>([])
  const [keyId, setKeyId] = useState(0)
  const [modelInput, setModelInput] = useState('')
  const [model, setModel] = useState('')
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  const [data, setData] = useState<LogPage | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    api.keys().then(setKeys, () => {})
  }, [])

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    try {
      const result = await api.logs({ page, size, key_id: keyId || undefined, model: model || undefined }, signal)
      if (!signal?.aborted) setData(result)
    } catch (e) {
      if (!signal?.aborted) toast('error', (e as Error).message)
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [page, size, keyId, model, toast])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  // 模型输入停顿后再查询
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setModel(modelInput.trim())
      setPage(1)
    }, 350)
    return () => window.clearTimeout(timer)
  }, [modelInput])

  const actions = (
    <>
      <select className="pt-input pt-filter-select" value={keyId} onChange={e => { setKeyId(Number(e.target.value)); setPage(1) }} aria-label="按令牌筛选">
        <option value={0}>全部令牌</option>
        {keys.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}
      </select>
      <div className="pt-input-wrap has-lead pt-filter-search">
        <span className="pt-input-lead"><IconSearch size={14} /></span>
        <Input value={modelInput} onChange={e => setModelInput(e.target.value)} placeholder="搜索模型" />
      </div>
      <Button variant="outline" size="icon" onClick={() => load()} disabled={loading} title="刷新" aria-label="刷新">
        <IconRefresh size={14} className={loading ? 'pt-spinner' : undefined} />
      </Button>
    </>
  )

  const footer = data && data.total > 0
    ? <Pagination page={page} size={size} total={data.total} onPage={setPage} onSize={n => { setSize(n); setPage(1) }} />
    : undefined

  return (
    <PageLayout title="使用日志" desc={`每次调用的模型、Token 与花费，记录保留 ${status.log_retention_days} 天`} actions={actions} footer={footer}>
      {data == null ? (
        <div style={{ display: 'grid', gap: 8 }}>{[0, 1, 2, 3].map(i => <Skeleton key={i} height={52} />)}</div>
      ) : data.items.length === 0 ? (
        <div className="pt-table-wrap">
          <Empty icon={<IconFileText size={20} />} title="暂无调用记录" desc={keyId || model ? '换个筛选条件试试' : '用令牌发起调用后，记录会显示在这里'} />
        </div>
      ) : (
        <div className="pt-table-wrap">
          <table className="pt-table pt-log-table">
            <thead>
              <tr>
                <th>时间</th><th>令牌</th><th>模型</th><th>Token（输入 / 输出）</th><th className="num">花费</th><th className="num">耗时</th><th>状态</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((log, i) => (
                <tr key={log.id} style={{ animationDelay: `${Math.min(i, 10) * 25}ms` }}>
                  <td>
                    <div className="pt-cell-stack">
                      <span className="mono" style={{ fontSize: 12 }}>{dateTime(log.created_at)}</span>
                      <span className="pt-cell-sub">{FORMAT_LABEL[log.entry_format] ?? log.entry_format} · {log.is_stream ? '流式' : '非流式'}</span>
                    </div>
                  </td>
                  <td>
                    <div className="pt-cell-stack">
                      <span className="pt-chip"><IconKeyRound size={12} />{log.key_name ?? '已删除'}</span>
                      {log.group_name && <span className="pt-cell-sub">分组 {log.group_name}</span>}
                    </div>
                  </td>
                  <td><span className="pt-chip mono">{log.model ?? '-'}</span></td>
                  <td>
                    <div className="pt-cell-stack">
                      <span className="mono" style={{ fontSize: 12, fontWeight: 500 }}>{num(log.prompt_tokens)} / {num(log.completion_tokens)}</span>
                      {(log.cache_read_tokens > 0 || log.cache_write_tokens > 0) && (
                        <span className="pt-cell-sub mono" style={{ fontSize: 11 }}>缓存读 {num(log.cache_read_tokens)} · 写 {num(log.cache_write_tokens)}</span>
                      )}
                    </div>
                  </td>
                  <td className="num"><span className="pt-chip pt-chip-strong">{money(log.quota_points)}</span></td>
                  <td className="num mono" style={{ fontSize: 12 }}>{seconds(log.latency_ms)}</td>
                  <td>
                    {log.status === 'success'
                      ? <Badge tone="success" dot>成功</Badge>
                      : <Badge tone="danger" dot title={log.error_message ?? undefined}>失败{log.status_code ? ` ${log.status_code}` : ''}</Badge>}
                    {log.status === 'error' && log.error_message && <div className="pt-log-error" title={log.error_message}>{log.error_message}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageLayout>
  )
}
