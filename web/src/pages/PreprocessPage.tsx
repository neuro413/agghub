import { useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { api } from '../api/client'
import { Button, IconButton } from '../components/Button'
import { Card } from '../components/Card'
import { Field, Input, Textarea } from '../components/Form'
import { IconCheck, IconEdit, IconExternal, IconFilter, IconGrip, IconPlus, IconTrash, IconWand } from '../components/Icons'
import { Modal } from '../components/Modal'
import { Toggle } from '../components/Toggle'
import { useToast } from '../components/Toast'
import { parseConversation, parseTools, roleClass } from '../lib/requestBody'
import type { Channel, LogDetail, LogItem, ParamRule, PreprocessRule, Settings, ToolFilterRule } from '../types'
import { ThinkingStoreModal } from './ThinkingStoreModal'
import { ParamRuleEditor, newParamRule } from './ParamRuleEditor'
import { FORMAT_OPTIONS, LogPickerModal, MultiChips, fmtLabel } from './preprocessShared'
import type { Opt } from './preprocessShared'
import { newId } from '../lib/id'

const ROLE_OPTIONS: Opt[] = [
  { value: 'system', label: 'system' },
  { value: 'user', label: 'user' },
  { value: 'assistant', label: 'assistant' },
  { value: 'tool', label: 'tool' },
]

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function newRule(partial?: Partial<PreprocessRule>): PreprocessRule {
  return { id: newId(), enabled: true, source: 'regex', pattern: '', flags: 'g', replacement: '', ...partial }
}

function newToolFilterRule(partial?: Partial<ToolFilterRule>): ToolFilterRule {
  return { id: newId(), enabled: true, tools: [], ...partial }
}

export function PreprocessPage() {
  const toast = useToast()
  const [s, setS] = useState<Settings | null>(null)
  const [channels, setChannels] = useState<Channel[]>([])
  const [subtab, setSubtab] = useState<'visual' | 'regex'>('regex')
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showStore, setShowStore] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    api.getSettings(controller.signal).then(value => { if (!controller.signal.aborted) setS(value) }).catch(e => { if (!controller.signal.aborted) toast('err', e.message) })
    api.listChannels(controller.signal).then(value => { if (!controller.signal.aborted) setChannels(value) }).catch(() => {})
    return () => controller.abort()
  }, [toast])

  const rules = s?.preprocess_rules ?? []
  const toolFilterRules = s?.tool_filter_rules ?? []
  const modelOptions = useMemo<Opt[]>(() => {
    const set = new Set<string>()
    for (const c of channels) for (const m of [...(c.models || []), ...Object.keys(c.model_mapping || {})]) set.add(m)
    return [...set].sort().map((m) => ({ value: m, label: m }))
  }, [channels])
  const channelOptions = useMemo<Opt[]>(() => channels.map((c) => ({ value: String(c.id), label: c.name })), [channels])
  const anthChannelOptions = useMemo<Opt[]>(
    () => channels.filter((c) => c.type === 'anthropic' || c.type === 'vertex').map((c) => ({ value: String(c.id), label: c.name })),
    [channels],
  )

  const patch = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    setS((p) => (p ? { ...p, [k]: v } : p))
    setDirty(true)
  }
  const setRules = (next: PreprocessRule[]) => patch('preprocess_rules', next)
  const updateRule = (r: PreprocessRule) => setRules(rules.map((x) => (x.id === r.id ? r : x)))
  const addRule = (r: PreprocessRule) => {
    setRules([...rules, r])
    setExpanded((prev) => new Set(prev).add(r.id))
  }
  const deleteRule = (id: string) => setRules(rules.filter((x) => x.id !== id))
  const setToolRules = (next: ToolFilterRule[]) => patch('tool_filter_rules', next)
  const updateToolRule = (r: ToolFilterRule) => setToolRules(toolFilterRules.map((x) => (x.id === r.id ? r : x)))
  const addToolRule = (r: ToolFilterRule) => {
    setToolRules([...toolFilterRules, r])
    setExpanded((prev) => new Set(prev).add(r.id))
  }
  const deleteToolRule = (id: string) => setToolRules(toolFilterRules.filter((x) => x.id !== id))
  const paramRules = s?.param_rules ?? []
  const setParamRules = (next: ParamRule[]) => patch('param_rules', next)
  const updateParamRule = (r: ParamRule) => setParamRules(paramRules.map((x) => (x.id === r.id ? r : x)))
  const addParamRule = (r: ParamRule) => {
    setParamRules([...paramRules, r])
    setExpanded((prev) => new Set(prev).add(r.id))
  }
  const deleteParamRule = (id: string) => setParamRules(paramRules.filter((x) => x.id !== id))
  const paramDragIndex = useRef<number | null>(null)
  const reorderParamRules = (from: number, to: number) => {
    const next = paramRules.slice()
    const [m] = next.splice(from, 1)
    next.splice(to, 0, m)
    setParamRules(next)
  }
  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const n = new Set(prev)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })

  const tagError = s && (!s.pseudo_thinking_open_tag.trim() || !s.pseudo_thinking_close_tag.trim() || s.pseudo_thinking_open_tag === s.pseudo_thinking_close_tag || s.pseudo_thinking_open_tag.length > 256 || s.pseudo_thinking_close_tag.length > 256)
    ? '伪思考开始/结束标签须非空、不同且各不超过 256 字符，请在高级设置中修正。' : ''
  const save = async () => {
    if (!s || saving || tagError) return
    setSaving(true)
    try {
      const saved = await api.updateSettings({
        strip_top_p: s.strip_top_p,
        drop_thinking: s.drop_thinking,
        drop_thinking_keep_last: s.drop_thinking_keep_last,
        drop_thinking_channel_ids: s.drop_thinking_channel_ids,
        drop_thinking_models: s.drop_thinking_models,
        drop_redacted_thinking: s.drop_redacted_thinking,
        preprocess_rules: s.preprocess_rules,
        tool_filter_rules: s.tool_filter_rules,
        param_rules: s.param_rules,
        pseudo_thinking_enabled: s.pseudo_thinking_enabled,
        pseudo_thinking_channel_ids: s.pseudo_thinking_channel_ids,
        pseudo_thinking_models: s.pseudo_thinking_models,
        pseudo_thinking_open_tag: s.pseudo_thinking_open_tag,
        pseudo_thinking_close_tag: s.pseudo_thinking_close_tag,
        pseudo_thinking_prompt: s.pseudo_thinking_prompt,
        pseudo_thinking_store_max: s.pseudo_thinking_store_max,
      })
      setS(saved)
      setDirty(false)
      toast('ok', '已保存')
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setSaving(false)
    }
  }

  const dragIndex = useRef<number | null>(null)
  const reorder = (from: number, to: number) => {
    const next = rules.slice()
    const [m] = next.splice(from, 1)
    next.splice(to, 0, m)
    setRules(next)
  }

  const exportRules = () => {
    const blob = new Blob([JSON.stringify(rules, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'agghub-preprocess-rules.json'
    a.click()
    URL.revokeObjectURL(url)
  }
  const fileRef = useRef<HTMLInputElement>(null)
  const importRules = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result))
        if (!Array.isArray(parsed)) throw new Error('格式应为规则数组')
        const imported = parsed.map((r: any) => newRule({ ...r, id: newId() }))
        setS(current => current ? { ...current, preprocess_rules: [...current.preprocess_rules, ...imported] } : current)
        setDirty(true)
        toast('ok', `已导入 ${imported.length} 条规则`)
      } catch (e: any) {
        toast('err', '导入失败：' + e.message)
      }
    }
    reader.readAsText(file)
  }

  if (!s) {
    return (
      <div className="ah-fade-up">
        <div className="ah-page-head">
          <div>
            <div className="ah-page-title">提示词预处理</div>
          </div>
        </div>
        <div className="ah-skel" style={{ height: 200 }} />
      </div>
    )
  }

  return (
    <div className="ah-fade-up">
      <div className="ah-page-head">
        <div>
          <div className="ah-page-title">提示词预处理</div>
          <div className="ah-page-sub">发往上游前改写请求体 · 丢弃 thinking · 正则替换 · 参数修改</div>
        </div>
        <Button variant="primary" loading={saving} disabled={!dirty || !!tagError} onClick={save}>
          {dirty ? '保存修改' : '已保存'}
        </Button>
      </div>

      {tagError && <div role="alert" className="ah-detail-empty">{tagError}</div>}
      <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      {/* 通用参数预处理 */}
      <Card className="ah-set-card">
        <div className="ah-set-title">
          <IconFilter size={18} /> 参数过滤
        </div>
        <div className="ah-set-desc">对所有方向生效（OpenAI/Anthropic 同向、OpenAI⇄Anthropic 互转）</div>
        <div className="ah-set-row">
          <div className="ah-set-row-info">
            <div className="ah-set-row-label">去除 top_p</div>
            <div className="ah-set-row-desc">
              从发往上游的请求中删除 top_p 采样参数。适用于上游不支持或不希望传递 top_p 的场景。
            </div>
          </div>
          <div className="ah-set-row-control">
            <Toggle checked={s.strip_top_p} onChange={(v) => patch('strip_top_p', v)} />
          </div>
        </div>
      </Card>

      {/* 卡片 A0：参数修改规则 */}
      <Card className="ah-set-card">
        <div className="ah-set-title">
          <IconEdit size={18} /> 参数修改
        </div>
        <div className="ah-set-desc">
          对发往上游的最终请求体增删改参数（top_p / temperature / thinking …），或对排除消息后的请求体 JSON 做正则替换 · 可按渠道 / 入口格式 /
          模型限定 · 给兼容性欠佳的上游扫地
        </div>
        <ParamRuleEditor
          rules={paramRules}
          channelOptions={channelOptions}
          modelOptions={modelOptions}
          expanded={expanded}
          onToggleExpand={toggleExpand}
          onUpdate={updateParamRule}
          onDelete={deleteParamRule}
          onAdd={() => addParamRule(newParamRule())}
          dragIndex={paramDragIndex}
          reorder={reorderParamRules}
        />
      </Card>

      {/* 卡片 A：Claude 同向丢弃 thinking */}
      <Card className="ah-set-card">
        <div className="ah-set-title">
          <IconWand size={18} /> Claude 同向转换
        </div>
        <div className="ah-set-desc">对 Anthropic 入口 → Anthropic 上游的直通请求生效</div>
        <div className="ah-set-row">
          <div className="ah-set-row-info">
            <div className="ah-set-row-label">丢弃 thinking 块</div>
            <div className="ah-set-row-desc">
              删除请求中 assistant 的 thinking / redacted_thinking 块（含思维链签名与思考文本）。仅对 Anthropic 同向直通有效，跨格式路径本就不含 thinking。
            </div>
          </div>
          <div className="ah-set-row-control">
            <Toggle checked={s.drop_thinking} onChange={(v) => {
              patch('drop_thinking', v)
              if (!v) {
                patch('drop_thinking_keep_last', 0)
              }
            }} />
          </div>
        </div>
        {s.drop_thinking && (
          <>
            <Field label="限定渠道（不选 = 全部 Anthropic 渠道）">
              <MultiChips
                options={anthChannelOptions}
                selected={(s.drop_thinking_channel_ids ?? []).map(String)}
                onChange={(v) => patch('drop_thinking_channel_ids', v.length ? v.map(Number) : ([] as number[]))}
                empty="暂无 Anthropic 渠道"
              />
            </Field>
            <Field label="限定模型（不选 = 全部）">
              <MultiChips
                options={modelOptions}
                selected={s.drop_thinking_models ?? []}
                onChange={(v) => patch('drop_thinking_models', v)}
                empty="暂无模型"
              />
            </Field>
            <div className="ah-set-row">
              <div className="ah-set-row-info">
                <div className="ah-set-row-label">自定义去除深度</div>
                <div className="ah-set-row-desc">
                  开启后可保留最近 N 个 thinking 块，而非全部去除。
                  {s.drop_thinking_keep_last > 0 && s.pseudo_thinking_enabled && (
                    <span style={{ color: 'var(--err)' }}> 保留模式下伪思考将自动失效</span>
                  )}
                </div>
              </div>
              <div className="ah-set-row-control" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Toggle
                  checked={s.drop_thinking_keep_last > 0}
                  onChange={(v) => patch('drop_thinking_keep_last', v ? 1 : 0)}
                />
                {s.drop_thinking_keep_last > 0 && (
                  <Input
                    type="number"
                    min={1}
                    style={{ width: 80 }}
                    value={s.drop_thinking_keep_last}
                    onChange={(e) => patch('drop_thinking_keep_last', Math.max(1, Number(e.target.value) || 1))}
                  />
                )}
              </div>
            </div>
          </>
        )}
        <div className="ah-set-row">
          <div className="ah-set-row-info">
            <div className="ah-set-row-label">丢弃 redacted_thinking 块</div>
            <div className="ah-set-row-desc">
              单独去除 redacted_thinking 块（被安全编辑的加密思维块），不影响普通 thinking 块。用于处理部分下游客户端不兼容 redacted_thinking 的情况。
            </div>
          </div>
          <div className="ah-set-row-control">
            <Toggle checked={s.drop_redacted_thinking} onChange={(v) => patch('drop_redacted_thinking', v)} />
          </div>
        </div>
      </Card>

      {/* 卡片 B：伪思考（伪原生思维链） */}
      <Card className="ah-set-card">
        <div className="ah-set-title">
          <IconWand size={18} /> 伪思考（伪原生思维链）
        </div>
        <div className="ah-set-desc">不开原生 thinking，用指令诱导完整思维链，网关切回 thinking block · 仅 Anthropic 同向 · 仅对命中上方「丢弃 thinking 块」渠道/模型范围的请求生效</div>
        <div className="ah-set-row">
          <div className="ah-set-row-info">
            <div className="ah-set-row-label">启用伪思考</div>
            <div className="ah-set-row-desc">
              {!s.drop_thinking && <span style={{ color: 'var(--err)' }}>需先开启上方「丢弃 thinking 块」</span>}
              {s.drop_thinking && s.drop_thinking_keep_last > 0 && <span style={{ color: 'var(--err)' }}>需关闭「自定义去除深度」（须全部去除才可用）</span>}
            </div>
          </div>
          <div className="ah-set-row-control">
            <Toggle
              checked={s.pseudo_thinking_enabled}
              onChange={(v) => {
                if (!s.drop_thinking) {
                  toast('err', '请先开启「丢弃 thinking 块」')
                  return
                }
                if (s.drop_thinking_keep_last > 0) {
                  toast('err', '请先关闭「自定义去除深度」，伪思考仅在全部去除时可用')
                  return
                }
                patch('pseudo_thinking_enabled', v)
              }}
            />
          </div>
        </div>
        {s.pseudo_thinking_enabled && s.drop_thinking && s.drop_thinking_keep_last === 0 && (
          <>
            <Field label="限定渠道（不选 = 全部 Anthropic 渠道）">
              <MultiChips
                options={anthChannelOptions}
                selected={(s.pseudo_thinking_channel_ids ?? []).map(String)}
                onChange={(v) => patch('pseudo_thinking_channel_ids', v.length ? v.map(Number) : ([] as number[]))}
                empty="暂无 Anthropic 渠道"
              />
            </Field>
            <Field label="限定模型（不选 = 全部）">
              <MultiChips
                options={modelOptions}
                selected={s.pseudo_thinking_models ?? []}
                onChange={(v) => patch('pseudo_thinking_models', v)}
                empty="暂无模型"
              />
            </Field>
            <div className="ah-pp-toolbar">
              <Button variant="ghost" size="sm" onClick={() => setShowAdvanced(!showAdvanced)}>
                {showAdvanced ? '收起高级选项' : '高级选项'}
              </Button>
              <span style={{ flex: 1 }} />
              <Button variant="soft" size="sm" onClick={() => setShowStore(true)}>
                管理已保存思维链
              </Button>
            </div>
            {showAdvanced && (
              <div className="ah-pp-rule-body">
                <div className="ah-pp-grid2">
                  <Field label="开始标签">
                    <Input value={s.pseudo_thinking_open_tag} onChange={(e) => patch('pseudo_thinking_open_tag', e.target.value)} />
                  </Field>
                  <Field label="结束标签">
                    <Input value={s.pseudo_thinking_close_tag} onChange={(e) => patch('pseudo_thinking_close_tag', e.target.value)} />
                  </Field>
                </div>
                <Field label="思考指令（注入 system 开头，留空则按标签自动生成）">
                  <Textarea
                    value={s.pseudo_thinking_prompt}
                    onChange={(e) => patch('pseudo_thinking_prompt', e.target.value)}
                    rows={3}
                  />
                </Field>
              </div>
            )}
          </>
        )}
      </Card>

      {/* 卡片 C：工具过滤 */}
      <Card className="ah-set-card">
        <div className="ah-set-title">
          <IconFilter size={18} /> 工具过滤
        </div>
        <div className="ah-set-desc">从请求中移除指定工具定义及关联的 tool_use / tool_result 消息 · 用于屏蔽客户端发送的不需要的工具</div>
        <ToolFilterEditor
          rules={toolFilterRules}
          channelOptions={channelOptions}
          modelOptions={modelOptions}
          expanded={expanded}
          onToggleExpand={toggleExpand}
          onUpdate={updateToolRule}
          onDelete={deleteToolRule}
          onAdd={() => addToolRule(newToolFilterRule())}
        />
      </Card>

      {/* 卡片 D：正则请求体修改 */}
      <Card className="ah-set-card">
        <div className="ah-set-title">
          <IconWand size={18} /> 正则请求体修改
        </div>
        <div className="ah-set-desc">对请求消息文本做查找 / 替换 / 删除，可视化与正则共用同一份规则</div>
        <div className="ah-detail-tabs">
          <button className={`ah-detail-tab${subtab === 'visual' ? ' is-active' : ''}`} onClick={() => setSubtab('visual')}>
            可视化
          </button>
          <button className={`ah-detail-tab${subtab === 'regex' ? ' is-active' : ''}`} onClick={() => setSubtab('regex')}>
            正则
          </button>
        </div>

        {subtab === 'regex' && (
          <RegexEditor
            rules={rules}
            channelOptions={channelOptions}
            modelOptions={modelOptions}
            expanded={expanded}
            onToggleExpand={toggleExpand}
            onUpdate={updateRule}
            onDelete={deleteRule}
            onAdd={() => addRule(newRule())}
            onExport={exportRules}
            onImportClick={() => fileRef.current?.click()}
            dragIndex={dragIndex}
            reorder={reorder}
          />
        )}
        {subtab === 'visual' && (
          <VisualEditor
            onAddRule={(r) => {
              addRule(r)
              toast('ok', '已添加规则，记得点保存')
            }}
          />
        )}
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) importRules(f)
            e.target.value = ''
          }}
        />
      </Card>
      </fieldset>
      {showStore && <ThinkingStoreModal onClose={() => setShowStore(false)} />}
    </div>
  )
}

function RegexEditor({
  rules,
  channelOptions,
  modelOptions,
  expanded,
  onToggleExpand,
  onUpdate,
  onDelete,
  onAdd,
  onExport,
  onImportClick,
  dragIndex,
  reorder,
}: {
  rules: PreprocessRule[]
  channelOptions: Opt[]
  modelOptions: Opt[]
  expanded: Set<string>
  onToggleExpand: (id: string) => void
  onUpdate: (r: PreprocessRule) => void
  onDelete: (id: string) => void
  onAdd: () => void
  onExport: () => void
  onImportClick: () => void
  dragIndex: { current: number | null }
  reorder: (from: number, to: number) => void
}) {
  return (
    <div className="ah-pp">
      <div className="ah-pp-toolbar">
        <Button variant="primary" size="sm" icon={<IconPlus size={16} />} onClick={onAdd}>
          新增规则
        </Button>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" size="sm" onClick={onImportClick}>
          导入
        </Button>
        <Button variant="ghost" size="sm" onClick={onExport} disabled={!rules.length}>
          导出
        </Button>
      </div>
      {!rules.length ? (
        <div className="ah-detail-empty">还没有规则，点「新增规则」开始</div>
      ) : (
        <div className="ah-pp-list">
          {rules.map((r, i) => (
            <RuleRow
              key={r.id}
              rule={r}
              channelOptions={channelOptions}
              modelOptions={modelOptions}
              expanded={expanded.has(r.id)}
              onToggleExpand={() => onToggleExpand(r.id)}
              onChange={onUpdate}
              onDelete={() => onDelete(r.id)}
              onDragStart={() => {
                dragIndex.current = i
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                const from = dragIndex.current
                if (from != null && from !== i) reorder(from, i)
                dragIndex.current = null
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function RuleRow({
  rule,
  channelOptions,
  modelOptions,
  expanded,
  onToggleExpand,
  onChange,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  rule: PreprocessRule
  channelOptions: Opt[]
  modelOptions: Opt[]
  expanded: boolean
  onToggleExpand: () => void
  onChange: (r: PreprocessRule) => void
  onDelete: () => void
  onDragStart: () => void
  onDragOver: (e: DragEvent) => void
  onDrop: (e: DragEvent) => void
}) {
  const [test, setTest] = useState('')
  const reValid = useMemo(() => {
    if (!rule.pattern) return true
    try {
      new RegExp(rule.pattern, rule.flags || 'g')
      return true
    } catch {
      return false
    }
  }, [rule.pattern, rule.flags])
  const tested = useMemo(() => {
    if (!test || !reValid || !rule.pattern) return null
    try {
      return test.replace(new RegExp(rule.pattern, rule.flags || 'g'), rule.replacement ?? '')
    } catch {
      return null
    }
  }, [test, rule.pattern, rule.flags, rule.replacement, reValid])

  const up = (p: Partial<PreprocessRule>) => onChange({ ...rule, ...p })
  const summary = rule.name || (rule.pattern ? `${rule.pattern}  →  ${rule.replacement || '（删除）'}` : '（空规则）')

  return (
    <div className="ah-pp-rule" draggable onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop}>
      <div className="ah-pp-rule-head">
        <span className="ah-pp-grip" title="拖拽排序">
          <IconGrip size={16} />
        </span>
        <Toggle checked={rule.enabled} onChange={(v) => up({ enabled: v })} />
        <button type="button" className="ah-pp-summary" onClick={onToggleExpand}>
          <span className={`ah-pp-src is-${rule.source}`}>{rule.source === 'visual' ? '可视化' : '正则'}</span>
          <span className="ah-pp-summary-text ah-truncate">{summary}</span>
        </button>
        {!reValid && (
          <span className="ah-pp-invalid" title="正则表达式无效">
            ⚠
          </span>
        )}
        <IconButton title="删除" danger onClick={onDelete}>
          <IconTrash size={15} />
        </IconButton>
      </div>
      {expanded && (
        <div className="ah-pp-rule-body">
          <Field label="名称（可选）">
            <Input value={rule.name ?? ''} onChange={(e) => up({ name: e.target.value })} placeholder="便于识别" />
          </Field>
          <div className="ah-pp-grid2">
            <Field
              label="查找（正则）"
              hint={!reValid ? <span style={{ color: 'var(--err)' }}>正则表达式无效</span> : undefined}
            >
              <Textarea value={rule.pattern} onChange={(e) => up({ pattern: e.target.value })} placeholder="要匹配的正则" rows={2} />
            </Field>
            <Field label="替换为（空 = 删除）">
              <Textarea
                value={rule.replacement}
                onChange={(e) => up({ replacement: e.target.value })}
                placeholder="留空即删除匹配内容，支持 $1 捕获组"
                rows={2}
              />
            </Field>
          </div>
          <div className="ah-pp-grid2">
            <Field label="flags">
              <Input value={rule.flags} onChange={(e) => up({ flags: e.target.value })} placeholder="g / gi / gm…" />
            </Field>
            <Field label="深度（只处理最后 N 条消息，0 = 全部）">
              <Input
                type="number"
                min={0}
                value={rule.depth ?? 0}
                onChange={(e) => up({ depth: Math.max(0, Number(e.target.value) || 0) })}
              />
            </Field>
          </div>
          <Field label="作用角色（不选 = 全部）">
            <MultiChips options={ROLE_OPTIONS} selected={rule.roles ?? []} onChange={(v) => up({ roles: v.length ? v : undefined })} />
          </Field>
          <Field label="入口格式（不选 = 全部）">
            <MultiChips
              options={FORMAT_OPTIONS}
              selected={rule.formats ?? []}
              onChange={(v) => up({ formats: v.length ? (v as PreprocessRule['formats']) : undefined })}
            />
          </Field>
          <Field label="限定渠道（不选 = 全部）">
            <MultiChips
              options={channelOptions}
              selected={(rule.channelIds ?? []).map(String)}
              onChange={(v) => up({ channelIds: v.length ? v.map(Number) : undefined })}
              empty="暂无渠道"
            />
          </Field>
          <Field label="限定模型（不选 = 全部）">
            <MultiChips
              options={modelOptions}
              selected={rule.models ?? []}
              onChange={(v) => up({ models: v.length ? v : undefined })}
              empty="暂无模型（渠道未配置 models）"
            />
          </Field>
          <Field label="测试预览">
            <Textarea value={test} onChange={(e) => setTest(e.target.value)} placeholder="粘贴一段文本，实时查看替换效果" rows={2} />
            {test && <pre className="ah-code ah-code-block ah-pp-test-out">{reValid ? tested ?? '' : '（正则无效）'}</pre>}
          </Field>
        </div>
      )}
    </div>
  )
}

function VisualEditor({ onAddRule }: { onAddRule: (r: PreprocessRule) => void }) {
  const toast = useToast()
  const [picking, setPicking] = useState(false)
  const [detail, setDetail] = useState<LogDetail | null>(null)
  const [sel, setSel] = useState<{ text: string; role: string } | null>(null)
  const [action, setAction] = useState<'delete' | 'replace'>('delete')
  const [replaceText, setReplaceText] = useState('')

  const blocks = useMemo(() => (detail ? parseConversation(detail.request_body) : []), [detail])

  const pick = async (id: number) => {
    setPicking(false)
    try {
      const d = await api.getLog(id)
      setDetail(d)
      setSel(null)
    } catch (e: any) {
      toast('err', e.message)
    }
  }

  const onMouseUp = () => {
    const s = window.getSelection()
    if (!s || s.isCollapsed) return
    const text = s.toString()
    if (!text.trim()) return
    let node: Node | null = s.anchorNode
    let role = ''
    while (node) {
      if (node instanceof HTMLElement && node.dataset.ppRole) {
        role = node.dataset.ppRole
        break
      }
      node = node.parentNode
    }
    setSel({ text, role })
  }

  const addRule = () => {
    if (!sel) return
    const roles = ['system', 'user', 'assistant', 'tool'].includes(sel.role) ? [sel.role] : undefined
    onAddRule(
      newRule({
        source: 'visual',
        name: `可视化：${sel.text.slice(0, 24).replace(/\s+/g, ' ')}`,
        pattern: escapeRegExp(sel.text),
        flags: 'g',
        replacement: action === 'replace' ? replaceText : '',
        roles,
      }),
    )
    setSel(null)
    setReplaceText('')
  }

  return (
    <div className="ah-pp-visual">
      <div className="ah-pp-toolbar">
        <Button variant="soft" size="sm" icon={<IconExternal size={15} />} onClick={() => setPicking(true)}>
          {detail ? '换一条请求' : '从请求日志选择'}
        </Button>
        {detail && (
          <span className="ah-mini ah-faint">
            来自日志 #{detail.id} · {detail.model || '-'}
          </span>
        )}
      </div>

      {!detail ? (
        <div className="ah-detail-empty">从历史请求里选一条，划选文本即可生成删除 / 替换规则</div>
      ) : !blocks.length ? (
        <div className="ah-detail-empty">该请求未存储正文或无对话内容</div>
      ) : (
        <div className="ah-pp-conv" onMouseUp={onMouseUp}>
          {blocks.map((b, i) => (
            <div key={i} className={`ah-blk role-${roleClass(b.role)}`} data-pp-role={b.role}>
              <div className="ah-blk-head">
                <span className="ah-blk-role">{b.role.toUpperCase()}</span>
                <span className="ah-blk-chars ah-mini ah-num">{b.chars.toLocaleString()} 字</span>
              </div>
              <div className="ah-blk-body ah-pp-blk-body">{b.text || '(空)'}</div>
            </div>
          ))}
        </div>
      )}

      {sel && (
        <div className="ah-pp-genbar">
          <div className="ah-pp-gen-sel">
            <span className="ah-mini ah-faint">已选（{sel.role || '未知角色'}）：</span>
            <span className="ah-pp-gen-text ah-truncate">{sel.text.replace(/\s+/g, ' ')}</span>
          </div>
          <div className="ah-pp-gen-act">
            <button type="button" className={`ah-pp-chip${action === 'delete' ? ' is-on' : ''}`} onClick={() => setAction('delete')}>
              删除
            </button>
            <button type="button" className={`ah-pp-chip${action === 'replace' ? ' is-on' : ''}`} onClick={() => setAction('replace')}>
              替换
            </button>
            {action === 'replace' && (
              <Input value={replaceText} onChange={(e) => setReplaceText(e.target.value)} placeholder="替换为…" />
            )}
            <Button variant="primary" size="sm" icon={<IconCheck size={15} />} onClick={addRule}>
              添加为规则
            </Button>
          </div>
        </div>
      )}

      {picking && <LogPickerModal onPick={pick} onClose={() => setPicking(false)} />}
    </div>
  )
}

function ToolFilterEditor({
  rules,
  channelOptions,
  modelOptions,
  expanded,
  onToggleExpand,
  onUpdate,
  onDelete,
  onAdd,
}: {
  rules: ToolFilterRule[]
  channelOptions: Opt[]
  modelOptions: Opt[]
  expanded: Set<string>
  onToggleExpand: (id: string) => void
  onUpdate: (r: ToolFilterRule) => void
  onDelete: (id: string) => void
  onAdd: () => void
}) {
  return (
    <div className="ah-pp">
      <div className="ah-pp-toolbar">
        <Button variant="primary" size="sm" icon={<IconPlus size={16} />} onClick={onAdd}>
          新增规则
        </Button>
      </div>
      {!rules.length ? (
        <div className="ah-detail-empty">还没有规则，点「新增规则」开始</div>
      ) : (
        <div className="ah-pp-list">
          {rules.map((r) => (
            <ToolFilterRuleRow
              key={r.id}
              rule={r}
              channelOptions={channelOptions}
              modelOptions={modelOptions}
              expanded={expanded.has(r.id)}
              onToggleExpand={() => onToggleExpand(r.id)}
              onChange={onUpdate}
              onDelete={() => onDelete(r.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ToolFilterRuleRow({
  rule,
  channelOptions,
  modelOptions,
  expanded,
  onToggleExpand,
  onChange,
  onDelete,
}: {
  rule: ToolFilterRule
  channelOptions: Opt[]
  modelOptions: Opt[]
  expanded: boolean
  onToggleExpand: () => void
  onChange: (r: ToolFilterRule) => void
  onDelete: () => void
}) {
  const [showImport, setShowImport] = useState(false)
  const [toolInput, setToolInput] = useState('')
  const up = (p: Partial<ToolFilterRule>) => onChange({ ...rule, ...p })
  const addTools = (names: string[]) => {
    const existing = new Set(rule.tools)
    const next = [...rule.tools, ...names.filter((n) => !existing.has(n))]
    up({ tools: next })
  }
  const removeToolName = (name: string) => up({ tools: rule.tools.filter((t) => t !== name) })
  const handleAddManual = () => {
    const name = toolInput.trim()
    if (!name) return
    addTools([name])
    setToolInput('')
  }
  const summary = rule.name || (rule.tools.length ? `屏蔽 ${rule.tools.length} 个工具` : '（空规则）')

  return (
    <div className="ah-pp-rule">
      <div className="ah-pp-rule-head">
        <Toggle checked={rule.enabled} onChange={(v) => up({ enabled: v })} />
        <button type="button" className="ah-pp-summary" onClick={onToggleExpand}>
          <span className="ah-pp-src is-regex">工具</span>
          <span className="ah-pp-summary-text ah-truncate">{summary}</span>
        </button>
        <IconButton title="删除" danger onClick={onDelete}>
          <IconTrash size={15} />
        </IconButton>
      </div>
      {expanded && (
        <div className="ah-pp-rule-body">
          <Field label="名称（可选）">
            <Input value={rule.name ?? ''} onChange={(e) => up({ name: e.target.value })} placeholder="便于识别" />
          </Field>
          <Field label="屏蔽工具列表（黑名单）">
            <div className="ah-pp-chips" style={{ marginBottom: 8 }}>
              {rule.tools.map((t) => (
                <span key={t} className="ah-pp-chip is-on" style={{ cursor: 'pointer' }} onClick={() => removeToolName(t)}>
                  {t} ×
                </span>
              ))}
              {!rule.tools.length && <span className="ah-mini ah-faint">未添加工具，点下方输入或从日志导入</span>}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Input
                value={toolInput}
                onChange={(e) => setToolInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleAddManual()
                  }
                }}
                placeholder="输入工具名，回车添加"
                style={{ flex: 1 }}
              />
              <Button variant="soft" size="sm" onClick={handleAddManual} disabled={!toolInput.trim()}>
                添加
              </Button>
              <Button variant="soft" size="sm" icon={<IconExternal size={15} />} onClick={() => setShowImport(true)}>
                从日志导入
              </Button>
            </div>
          </Field>
          <Field label="入口格式（不选 = 全部）">
            <MultiChips
              options={FORMAT_OPTIONS}
              selected={rule.formats ?? []}
              onChange={(v) => up({ formats: v.length ? (v as ToolFilterRule['formats']) : undefined })}
            />
          </Field>
          <Field label="限定渠道（不选 = 全部）">
            <MultiChips
              options={channelOptions}
              selected={(rule.channelIds ?? []).map(String)}
              onChange={(v) => up({ channelIds: v.length ? v.map(Number) : undefined })}
              empty="暂无渠道"
            />
          </Field>
          <Field label="限定模型（不选 = 全部）">
            <MultiChips
              options={modelOptions}
              selected={rule.models ?? []}
              onChange={(v) => up({ models: v.length ? v : undefined })}
              empty="暂无模型（渠道未配置 models）"
            />
          </Field>
        </div>
      )}
      {showImport && (
        <ToolImportModal
          existing={new Set(rule.tools)}
          onImport={(names) => {
            addTools(names)
            setShowImport(false)
          }}
          onClose={() => setShowImport(false)}
        />
      )}
    </div>
  )
}

function ToolImportModal({
  existing,
  onImport,
  onClose,
}: {
  existing: Set<string>
  onImport: (names: string[]) => void
  onClose: () => void
}) {
  const toast = useToast()
  const [step, setStep] = useState<'pick' | 'select'>('pick')
  const [items, setItems] = useState<LogItem[] | null>(null)
  const [tools, setTools] = useState<{ name: string; description?: string }[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => {
    api
      .listLogs({ limit: 40 })
      .then((r) => setItems(r.items))
      .catch((e) => toast('err', e.message))
  }, [toast])

  const pickLog = async (id: number) => {
    try {
      const d = await api.getLog(id)
      const parsed = parseTools(d.request_body)
      if (!parsed.length) {
        toast('err', '该请求中没有工具定义')
        return
      }
      setTools(parsed)
      setSelected(new Set(parsed.filter((t) => !existing.has(t.name)).map((t) => t.name)))
      setStep('select')
    } catch (e: any) {
      toast('err', e.message)
    }
  }

  const toggleTool = (name: string) => {
    setSelected((prev) => {
      const n = new Set(prev)
      n.has(name) ? n.delete(name) : n.add(name)
      return n
    })
  }

  return (
    <Modal title={step === 'pick' ? '选择历史请求' : `选择要屏蔽的工具（${tools.length} 个）`} size="lg" onClose={onClose}>
      {step === 'pick' ? (
        !items ? (
          <div className="ah-logt-empty">
            <span className="ah-spin ah-spin-orange" /> 加载中…
          </div>
        ) : !items.length ? (
          <div className="ah-detail-empty">暂无请求日志</div>
        ) : (
          <div className="ah-pp-picker">
            {items.map((l) => (
              <button type="button" key={l.id} className="ah-pp-picker-row" onClick={() => pickLog(l.id)}>
                <span className={`ah-log-pill ${l.status === 'success' ? 'ok' : 'err'}`}>
                  {l.status === 'success' ? l.status_code || 200 : 'ERR'}
                </span>
                <span className={`ah-fmt-badge ${l.entry_format}`}>{fmtLabel(l.entry_format)}</span>
                <span className="ah-pp-picker-model ah-truncate">{l.model || '-'}</span>
                <span className="ah-mini ah-muted ah-truncate">{l.channel_name || '—'}</span>
                <span className="ah-mini ah-faint ah-num">{new Date(l.created_at).toLocaleString('zh-CN', { hour12: false })}</span>
              </button>
            ))}
          </div>
        )
      ) : (
        <div>
          <div className="ah-pp-toolbar" style={{ marginBottom: 8 }}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set(tools.filter((t) => !existing.has(t.name)).map((t) => t.name)))}
            >
              全选新工具
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              全不选
            </Button>
            <span style={{ flex: 1 }} />
            <Button variant="ghost" size="sm" onClick={() => setStep('pick')}>
              换一条日志
            </Button>
          </div>
          <div className="ah-pp-picker" style={{ maxHeight: 400 }}>
            {tools.map((t) => (
              <button
                type="button"
                key={t.name}
                className={`ah-pp-picker-row${selected.has(t.name) ? ' is-selected' : ''}`}
                onClick={() => toggleTool(t.name)}
                style={{ alignItems: 'flex-start' }}
              >
                <span
                  className={`ah-pp-chip${selected.has(t.name) ? ' is-on' : ''}`}
                  style={{ flexShrink: 0, cursor: 'pointer', minWidth: 20, textAlign: 'center' }}
                >
                  {selected.has(t.name) ? '✓' : '　'}
                </span>
                <span style={{ fontWeight: 500, flexShrink: 0 }}>{t.name}</span>
                {existing.has(t.name) && <span className="ah-mini ah-faint">（已添加）</span>}
                {t.description && (
                  <span className="ah-mini ah-muted ah-truncate" style={{ flex: 1 }}>
                    {t.description}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" disabled={selected.size === 0} onClick={() => onImport([...selected])}>
              添加 {selected.size} 个工具到黑名单
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
