import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client'
import { Button, IconButton } from '../components/Button'
import { Card } from '../components/Card'
import { Field, Input, Textarea } from '../components/Form'
import { IconCheck, IconEdit, IconExternal, IconFilter, IconGrip, IconTrash, IconWand } from '../components/Icons'
import { Modal } from '../components/Modal'
import { Toggle } from '../components/Toggle'
import { useToast } from '../components/Toast'
import { parseConversation, parseTools, roleClass } from '../lib/requestBody'
import type { ToolInfo } from '../lib/requestBody'
import type { ApiKeyView, Channel, LogDetail, PreprocessRule, Settings, ToolFilterRule } from '../types'
import { ThinkingStoreModal } from './ThinkingStoreModal'
import { ParamRuleRow, newParamRule } from './ParamRuleEditor'
import { LogPickerModal, MultiChips, RuleList, ScopeFields, regexValid } from './preprocessShared'
import type { Opt, RuleRowProps } from './preprocessShared'
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

// 只提交本页 UI 涉及的字段，避免用本页的旧缓存覆盖设置页的字段
const KEYS: (keyof Settings)[] = [
  'strip_top_p', 'drop_thinking', 'drop_thinking_keep_last', 'drop_thinking_channel_ids', 'drop_thinking_models', 'drop_redacted_thinking',
  'preprocess_rules', 'tool_filter_rules', 'param_rules',
  'pseudo_thinking_enabled', 'pseudo_thinking_channel_ids', 'pseudo_thinking_models', 'pseudo_thinking_open_tag', 'pseudo_thinking_close_tag',
  'pseudo_thinking_prompt', 'pseudo_thinking_store_max',
]

export function PreprocessPage() {
  const toast = useToast()
  const [s, setS] = useState<Settings | null>(null)
  const [channels, setChannels] = useState<Channel[]>([])
  const [keys, setKeys] = useState<ApiKeyView[]>([])
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
    // Key 加载失败静默处理，不影响规则编辑
    api.listKeys(controller.signal).then(value => { if (!controller.signal.aborted) setKeys(value) }).catch(() => {})
    return () => controller.abort()
  }, [toast])

  const rules = s?.preprocess_rules ?? []
  const modelOptions = useMemo<Opt[]>(() => {
    const set = new Set<string>()
    for (const c of channels) for (const m of [...(c.models || []), ...Object.keys(c.model_mapping || {})]) set.add(m)
    return [...set].sort().map((m) => ({ value: m, label: m }))
  }, [channels])
  const channelOptions = useMemo<Opt[]>(() => channels.map((c) => ({ value: String(c.id), label: c.name })), [channels])
  const keyOptions = useMemo<Opt[]>(() => keys.map((k) => ({ value: String(k.id), label: k.name })), [keys])
  const anthChannelOptions = useMemo<Opt[]>(
    () => channels.filter((c) => c.type === 'anthropic' || c.type === 'vertex').map((c) => ({ value: String(c.id), label: c.name })),
    [channels],
  )

  const patch = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    setS((p) => (p ? { ...p, [k]: v } : p))
    setDirty(true)
  }
  // 可视化编辑器生成的规则：追加并展开
  const addRule = (r: PreprocessRule) => {
    patch('preprocess_rules', [...rules, r])
    setExpanded((prev) => new Set(prev).add(r.id))
  }
  const lists = { expanded, setExpanded, channelOptions, modelOptions, keyOptions }

  const tagError = s && (!s.pseudo_thinking_open_tag.trim() || !s.pseudo_thinking_close_tag.trim() || s.pseudo_thinking_open_tag === s.pseudo_thinking_close_tag || s.pseudo_thinking_open_tag.length > 256 || s.pseudo_thinking_close_tag.length > 256)
    ? '伪思考开始/结束标签须非空、不同且各不超过 256 字符，请在高级设置中修正。' : ''
  const save = async () => {
    if (!s || saving || tagError) return
    setSaving(true)
    try {
      const saved = await api.updateSettings(Object.fromEntries(KEYS.map((k) => [k, s[k]])))
      setS(saved)
      setDirty(false)
      toast('ok', '已保存')
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setSaving(false)
    }
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
        <RuleList
          {...lists}
          rules={s.param_rules}
          onChange={(next) => patch('param_rules', next)}
          create={newParamRule}
          Row={ParamRuleRow}
          sortable
          toolbar={<span className="ah-mini ah-faint">规则按顺序执行，可拖拽排序</span>}
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
                selected={s.drop_thinking_channel_ids.map(String)}
                onChange={(v) => patch('drop_thinking_channel_ids', v.map(Number))}
                empty="暂无 Anthropic 渠道"
              />
            </Field>
            <Field label="限定模型（不选 = 全部）">
              <MultiChips
                options={modelOptions}
                selected={s.drop_thinking_models}
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
                selected={s.pseudo_thinking_channel_ids.map(String)}
                onChange={(v) => patch('pseudo_thinking_channel_ids', v.map(Number))}
                empty="暂无 Anthropic 渠道"
              />
            </Field>
            <Field label="限定模型（不选 = 全部）">
              <MultiChips
                options={modelOptions}
                selected={s.pseudo_thinking_models}
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
        <RuleList
          {...lists}
          rules={s.tool_filter_rules}
          onChange={(next) => patch('tool_filter_rules', next)}
          create={newToolFilterRule}
          Row={ToolFilterRuleRow}
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
          <RuleList
            {...lists}
            rules={rules}
            onChange={(next) => patch('preprocess_rules', next)}
            create={newRule}
            Row={RuleRow}
            sortable
            toolbar={
              <>
                <span style={{ flex: 1 }} />
                <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()}>
                  导入
                </Button>
                <Button variant="ghost" size="sm" onClick={exportRules} disabled={!rules.length}>
                  导出
                </Button>
              </>
            }
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

function RuleRow({ rule, channelOptions, modelOptions, keyOptions, expanded, onToggleExpand, onChange, onDelete, drag }: RuleRowProps<PreprocessRule>) {
  const [test, setTest] = useState('')
  const reValid = regexValid(rule.pattern, rule.flags)
  const tested = test && reValid && rule.pattern ? test.replace(new RegExp(rule.pattern, rule.flags || 'g'), rule.replacement ?? '') : null

  const up = (p: Partial<PreprocessRule>) => onChange({ ...rule, ...p })
  const summary = rule.name || (rule.pattern ? `${rule.pattern}  →  ${rule.replacement || '（删除）'}` : '（空规则）')

  return (
    <div className="ah-pp-rule" {...drag}>
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
          <ScopeFields rule={rule} onChange={up} channelOptions={channelOptions} modelOptions={modelOptions} keyOptions={keyOptions} />
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

function ToolFilterRuleRow({ rule, channelOptions, modelOptions, keyOptions, expanded, onToggleExpand, onChange, onDelete }: RuleRowProps<ToolFilterRule>) {
  const toast = useToast()
  const [picking, setPicking] = useState(false)
  const [importable, setImportable] = useState<ToolInfo[] | null>(null)
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
  const pickLog = async (id: number) => {
    try {
      const tools = parseTools((await api.getLog(id)).request_body)
      if (!tools.length) {
        toast('err', '该请求中没有工具定义')
        return
      }
      setPicking(false)
      setImportable(tools)
    } catch (e: any) {
      toast('err', e.message)
    }
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
              <Button variant="soft" size="sm" icon={<IconExternal size={15} />} onClick={() => setPicking(true)}>
                从日志导入
              </Button>
            </div>
          </Field>
          <ScopeFields rule={rule} onChange={up} channelOptions={channelOptions} modelOptions={modelOptions} keyOptions={keyOptions} />
        </div>
      )}
      {picking && <LogPickerModal onPick={pickLog} onClose={() => setPicking(false)} />}
      {importable && (
        <ToolImportModal
          tools={importable}
          existing={new Set(rule.tools)}
          onImport={(names) => {
            addTools(names)
            setImportable(null)
          }}
          onBack={() => {
            setImportable(null)
            setPicking(true)
          }}
          onClose={() => setImportable(null)}
        />
      )}
    </div>
  )
}

function ToolImportModal({
  tools,
  existing,
  onImport,
  onBack,
  onClose,
}: {
  tools: ToolInfo[]
  existing: Set<string>
  onImport: (names: string[]) => void
  onBack: () => void
  onClose: () => void
}) {
  const newTools = () => new Set(tools.filter((t) => !existing.has(t.name)).map((t) => t.name))
  const [selected, setSelected] = useState(newTools)

  const toggleTool = (name: string) => {
    setSelected((prev) => {
      const n = new Set(prev)
      n.has(name) ? n.delete(name) : n.add(name)
      return n
    })
  }

  return (
    <Modal title={`选择要屏蔽的工具（${tools.length} 个）`} size="lg" onClose={onClose} dismissible={false}>
      <div className="ah-pp-toolbar" style={{ marginBottom: 8 }}>
        <Button variant="ghost" size="sm" onClick={() => setSelected(newTools())}>
          全选新工具
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
          全不选
        </Button>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" size="sm" onClick={onBack}>
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
    </Modal>
  )
}
