import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { Button, IconButton } from '../components/Button'
import { IconTrash } from '../components/Icons'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'
import type { ThinkingDetail, ThinkingEntry } from '../types'
import { clampOffset } from '../lib/format'

const PAGE_SIZE = 30

export function ThinkingStoreModal({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const [items, setItems] = useState<ThinkingEntry[] | null>(null)
  const [total, setTotal] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [offset, setOffset] = useState(0)
  const [detail, setDetail] = useState<ThinkingDetail | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const [loadError, setLoadError] = useState('')
  const load = useCallback(async (signal: AbortSignal) => {
    setLoadError('')
    try {
      const r = await api.listThinking({ limit: PAGE_SIZE, offset }, signal)
      if (signal.aborted) return
      setTotal(r.total)
      const valid = clampOffset(offset, r.total, PAGE_SIZE)
      if (valid !== offset) { setOffset(valid); return }
      setItems(r.items)
      setSelected(prev => new Set([...prev].filter(sig => r.items.some(item => item.signature === sig))))
    } catch (e: any) {
      if (!signal.aborted) { setLoadError(e.message); toast('err', e.message) }
    }
  }, [offset, toast])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [load, refresh])

  const viewFull = (sig: string) => {
    api.getThinking(sig).then(setDetail).catch((e) => toast('err', e.message))
  }

  const deleteSel = async () => {
    if (!selected.size) return
    try {
      const r = await api.deleteThinking([...selected])
      toast('ok', `已删除 ${r.deleted} 条`)
      setSelected(new Set())
      setDetail(null)
      setRefresh(value => value + 1)
    } catch (e: any) {
      toast('err', e.message)
    }
  }

  const toggle = (sig: string) =>
    setSelected((prev) => {
      const n = new Set(prev)
      n.has(sig) ? n.delete(sig) : n.add(sig)
      return n
    })

  const page = Math.floor(offset / PAGE_SIZE) + 1
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <Modal title="已保存思维链" size="lg" onClose={onClose}>
      {detail ? (
        <div>
          <div style={{ marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button variant="ghost" size="sm" onClick={() => setDetail(null)}>
              &larr; 返回列表
            </Button>
            <span className="ah-mini ah-muted ah-num">{detail.length.toLocaleString()} 字</span>
            <span className="ah-mini ah-faint ah-truncate" style={{ maxWidth: 200 }} title={detail.signature}>
              {detail.signature.slice(0, 32)}&hellip;
            </span>
          </div>
          <pre className="ah-code ah-code-block" style={{ maxHeight: 500, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
            {detail.thinking}
          </pre>
        </div>
      ) : loadError ? <div role="alert">加载失败：{loadError}<Button onClick={() => setRefresh(value => value + 1)}>重试</Button></div> : !items ? (
        <div className="ah-logt-empty">
          <span className="ah-spin ah-spin-orange" /> 加载中&hellip;
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <span className="ah-mini ah-muted">共 {total} 条</span>
            <span style={{ flex: 1 }} />
            {selected.size > 0 && (
              <Button variant="danger" size="sm" icon={<IconTrash size={15} />} onClick={deleteSel}>
                删除所选 ({selected.size})
              </Button>
            )}
          </div>
          {!items.length && <div className="ah-detail-empty">暂无已保存的思维链</div>}
          <div className="ah-pp-picker">
            {items.map((e) => (
              <div
                key={e.signature}
                className="ah-pp-picker-row"
                style={{ cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'center' }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(e.signature)}
                  onChange={() => toggle(e.signature)}
                  onClick={(ev) => ev.stopPropagation()}
                />
                <span
                  className="ah-pp-picker-model ah-truncate"
                  style={{ flex: 1 }}
                  onClick={() => viewFull(e.signature)}
                >
                  {e.preview.replace(/\s+/g, ' ').slice(0, 80) || '(空)'}
                </span>
                <span className="ah-mini ah-muted ah-num">{e.length.toLocaleString()} 字</span>
                <span className="ah-mini ah-faint ah-num">
                  {new Date(e.created_at).toLocaleString('zh-CN', { hour12: false })}
                </span>
                <IconButton
                  title="删除"
                  danger
                  onClick={() =>
                    api
                      .deleteThinking([e.signature])
                      .then(() => {
                        toast('ok', '已删除')
                        setDetail(null)
                        setRefresh(value => value + 1)
                      })
                      .catch((err) => toast('err', err.message))
                  }
                >
                  <IconTrash size={14} />
                </IconButton>
              </div>
            ))}
          </div>
          {(total > PAGE_SIZE || offset > 0) && (
            <div className="ah-logt-pager">
              <Button variant="ghost" size="sm" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}>
                上一页
              </Button>
              <span className="ah-mini ah-muted ah-num">
                {page} / {pages}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset((o) => o + PAGE_SIZE)}
              >
                下一页
              </Button>
            </div>
          )}
        </>
      )}
    </Modal>
  )
}
