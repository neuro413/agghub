import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { Button, IconButton } from '../components/Button'
import { Card } from '../components/Card'
import { Input } from '../components/Form'
import { IconPlus, IconTrash } from '../components/Icons'
import { useToast } from '../components/Toast'
import { newId } from '../lib/id'
import type { ModelRatio } from '../types'

const DESC =
  '点数 = 未缓存输入 × 输入 + 缓存读 × 缓存读 + 缓存写 × 缓存写 + 输出 × 输出 + 按次（仅在产生输出时计入）。按客户端请求的模型名匹配：精确名优先，其次是非通配部分最长的 * 通配符，再按列表顺序。没有命中的模型不允许 Key 调用，建议保留一条 * 作为默认。'

function newRow(): ModelRatio {
  return { id: newId(), pattern: '', input: 1, output: 1, cache_read: 1, cache_write: 1, per_request: 0 }
}

export function ModelRatioCard({ ratios, onSaved }: { ratios: ModelRatio[]; onSaved: () => void }) {
  const toast = useToast()
  const [rows, setRows] = useState<ModelRatio[]>(ratios)
  const [saving, setSaving] = useState(false)

  // props 变化时同步本地副本（保存后刷新、切换页面回到最新）
  useEffect(() => {
    setRows(ratios)
  }, [ratios])

  const patch = (id: string, p: Partial<ModelRatio>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)))

  const save = async () => {
    for (const r of rows) {
      if (!r.pattern.trim()) {
        toast('err', '模型模式不能为空')
        return
      }
      const nums = [r.input, r.output, r.cache_read, r.cache_write, r.per_request]
      if (nums.some((n) => !Number.isFinite(n) || n < 0)) {
        toast('err', `「${r.pattern}」的倍率必须是不小于 0 的数字`)
        return
      }
    }
    const seen = new Set<string>()
    for (const r of rows) {
      const p = r.pattern.trim()
      if (seen.has(p)) {
        toast('err', `模型模式重复：${p}`)
        return
      }
      seen.add(p)
    }
    setSaving(true)
    try {
      const payload = rows.map((r) => ({ ...r, pattern: r.pattern.trim() }))
      await api.updateSettings({ model_ratios: payload })
      toast('ok', '倍率已保存')
      onSaved()
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="ah-set-card ah-ratio-card">
      <div className="ah-set-title">模型倍率</div>
      <div className="ah-set-desc">{DESC}</div>

      <div className="ah-ratio-table">
        <div className="ah-ratio-head">
          <span>模型模式</span>
          <span>输入</span>
          <span>输出</span>
          <span>缓存读</span>
          <span>缓存写</span>
          <span>按次</span>
          <span />
        </div>
        {rows.map((r) => (
          <div className="ah-ratio-row" key={r.id}>
            <Input
              value={r.pattern}
              onChange={(e) => patch(r.id, { pattern: e.target.value })}
              placeholder="如 claude-opus-* 或 *"
            />
            <Input type="number" min={0} step="any" value={r.input} onChange={(e) => patch(r.id, { input: Number(e.target.value) })} />
            <Input type="number" min={0} step="any" value={r.output} onChange={(e) => patch(r.id, { output: Number(e.target.value) })} />
            <Input type="number" min={0} step="any" value={r.cache_read} onChange={(e) => patch(r.id, { cache_read: Number(e.target.value) })} />
            <Input type="number" min={0} step="any" value={r.cache_write} onChange={(e) => patch(r.id, { cache_write: Number(e.target.value) })} />
            <Input type="number" min={0} step="any" value={r.per_request} onChange={(e) => patch(r.id, { per_request: Number(e.target.value) })} />
            <IconButton title="删除此行" danger onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}>
              <IconTrash size={16} />
            </IconButton>
          </div>
        ))}
        {!rows.length && <div className="ah-detail-empty">还没有倍率规则，点「添加一行」开始；建议保留一条 * 作为默认。</div>}
      </div>

      <div className="ah-ratio-actions">
        <Button variant="soft" size="sm" icon={<IconPlus size={15} />} onClick={() => setRows((rs) => [...rs, newRow()])}>
          添加一行
        </Button>
        <span style={{ flex: 1 }} />
        <Button variant="primary" loading={saving} onClick={save}>
          保存倍率
        </Button>
      </div>

      <TrialPanel />
    </Card>
  )
}

function TrialPanel() {
  const toast = useToast()
  const [model, setModel] = useState('')
  // 用字符串保存，留空时能显示占位说明；提交时按非负整数解析
  const [prompt, setPrompt] = useState('')
  const [cacheRead, setCacheRead] = useState('')
  const [cacheWrite, setCacheWrite] = useState('')
  const [completion, setCompletion] = useState('')
  const toTokens = (v: string) => Math.max(0, Math.floor(Number(v) || 0))
  const [previewing, setPreviewing] = useState(false)
  const [result, setResult] = useState<{ pattern: string | null; points: number | null } | null>(null)

  const run = async () => {
    if (!model.trim()) {
      toast('err', '请填写要试算的模型名')
      return
    }
    setPreviewing(true)
    try {
      const r = await api.billingPreview({
        model: model.trim(),
        prompt_tokens: toTokens(prompt),
        completion_tokens: toTokens(completion),
        cache_read_tokens: toTokens(cacheRead),
        cache_write_tokens: toTokens(cacheWrite),
      })
      setResult({ pattern: r.ratio?.pattern ?? null, points: r.points })
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setPreviewing(false)
    }
  }

  return (
    <div className="ah-ratio-trial">
      <div className="ah-set-row-label">倍率试算</div>
      <div className="ah-set-row-desc">试算使用已保存的倍率，改完倍率请先点「保存倍率」再试算。</div>
      <div className="ah-ratio-trial-grid">
        <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="模型名，如 claude-opus-4-1" />
        <Input type="number" min={0} step={1} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="输入 Token（含缓存）" title="输入 Token（含缓存读写）" />
        <Input type="number" min={0} step={1} value={cacheRead} onChange={(e) => setCacheRead(e.target.value)} placeholder="其中缓存读" title="其中缓存读取" />
        <Input type="number" min={0} step={1} value={cacheWrite} onChange={(e) => setCacheWrite(e.target.value)} placeholder="其中缓存写" title="其中缓存写入" />
        <Input type="number" min={0} step={1} value={completion} onChange={(e) => setCompletion(e.target.value)} placeholder="输出 Token" title="输出 Token" />
        <Button variant="soft" size="sm" loading={previewing} onClick={run}>
          试算
        </Button>
      </div>
      {result && (
        <div className={`ah-ratio-trial-out${result.points == null ? ' is-empty' : ''}`}>
          {result.points == null
            ? '没有命中任何倍率，Key 无法调用该模型'
            : `命中「${result.pattern}」：${result.points.toLocaleString()} 点`}
        </div>
      )}
    </div>
  )
}
