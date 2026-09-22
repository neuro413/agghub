import { useMemo, useState } from 'react'
import type { DragEvent } from 'react'
import { api } from '../api/client'
import { Button, IconButton } from '../components/Button'
import { Field, Input, Select, Textarea } from '../components/Form'
import { IconExternal, IconGrip, IconPlus, IconTrash } from '../components/Icons'
import { Toggle } from '../components/Toggle'
import { useToast } from '../components/Toast'
import type { ParamOp, ParamOpType, ParamRule, ParamTestResult } from '../types'
import { FORMAT_OPTIONS, LogPickerModal, MultiChips } from './preprocessShared'
import type { Opt } from './preprocessShared'

// ── 参数修改规则编辑器：增删改上游请求体参数 / 对排除消息的请求体 JSON 做正则替换 ──

const OP_TYPE_OPTIONS: { value: ParamOpType; label: string }[] = [
  { value: 'set', label: '设置（存在则覆盖，不存在则添加）' },
  { value: 'set_if_missing', label: '仅不存在时添加' },
  { value: 'set_if_present', label: '仅存在时修改' },
  { value: 'delete', label: '删除' },
  { value: 'regex', label: '正则替换（排除消息的请求体 JSON）' },
]

const WIRE_LABEL: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', responses: 'Responses' }

/** 预览输出里折叠掉的受保护字段（规则不会改动它们，折叠后只看参数）*/
const COLLAPSE_KEYS = new Set(['messages', 'contents', 'input', 'system', 'instructions', 'systemInstruction'])

export function newParamOp(type: ParamOpType = 'set'): ParamOp {
  return type === 'regex' ? { type, pattern: '', flags: 'g', replacement: '' } : { type, key: '', value: '' }
}

export function newParamRule(partial?: Partial<ParamRule>): ParamRule {
  return { id: crypto.randomUUID(), enabled: true, ops: [newParamOp()], ...partial }
}

function regexValid(pattern: string | undefined, flags: string | undefined): boolean {
  if (!pattern) return true
  try {
    new RegExp(pattern, flags || 'g')
    return true
  } catch {
    return false
  }
}

function opSummary(o: ParamOp): string {
  const k = o.key?.trim() || '?'
  switch (o.type) {
    case 'set':
      return `设 ${k}=${o.value ?? ''}`
    case 'set_if_missing':
      return `补 ${k}=${o.value ?? ''}`
    case 'set_if_present':
      return `改 ${k}=${o.value ?? ''}`
    case 'delete':
      return `删 ${k}`
    case 'regex':
      return `正则 /${o.pattern || ''}/${o.flags ?? 'g'}`
    default:
      return String((o as any).type)
  }
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

/** 预览输出：受保护字段折叠成占位文本，只看参数部分 */
function previewBody(body: any): string {
  if (!body || typeof body !== 'object') return JSON.stringify(body, null, 2)
  const out: any = {}
  for (const [k, v] of Object.entries(body)) {
    if (!COLLAPSE_KEYS.has(k)) {
      out[k] = v
    } else if (Array.isArray(v)) {
      out[k] = `[… ${v.length} 项，受保护未改动]`
    } else if (typeof v === 'string') {
      out[k] = `[… ${v.length} 字，受保护未改动]`
    } else {
      out[k] = '[… 受保护未改动]'
    }
  }
  return JSON.stringify(out, null, 2)
}

export function ParamRuleEditor({
  rules,
  channelOptions,
  modelOptions,
  expanded,
  onToggleExpand,
  onUpdate,
  onDelete,
  onAdd,
  dragIndex,
  reorder,
}: {
  rules: ParamRule[]
  channelOptions: Opt[]
  modelOptions: Opt[]
  expanded: Set<string>
  onToggleExpand: (id: string) => void
  onUpdate: (r: ParamRule) => void
  onDelete: (id: string) => void
  onAdd: () => void
  dragIndex: { current: number | null }
  reorder: (from: number, to: number) => void
}) {
  return (
    <div className="ah-pp">
      <div className="ah-pp-toolbar">
        <Button variant="primary" size="sm" icon={<IconPlus size={16} />} onClick={onAdd}>
          新增规则
        </Button>
        <span className="ah-mini ah-faint">规则按顺序执行，可拖拽排序</span>
      </div>
      {!rules.length ? (
        <div className="ah-detail-empty">还没有规则，点「新增规则」开始</div>
      ) : (
        <div className="ah-pp-list">
          {rules.map((r, i) => (
            <ParamRuleRow
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

function ParamRuleRow({
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
  rule: ParamRule
  channelOptions: Opt[]
  modelOptions: Opt[]
  expanded: boolean
  onToggleExpand: () => void
  onChange: (r: ParamRule) => void
  onDelete: () => void
  onDragStart: () => void
  onDragOver: (e: DragEvent) => void
  onDrop: (e: DragEvent) => void
}) {
  const toast = useToast()
  const [testInput, setTestInput] = useState('')
  const [testOut, setTestOut] = useState<ParamTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [picking, setPicking] = useState(false)

  const ops = rule.ops ?? []
  const up = (p: Partial<ParamRule>) => onChange({ ...rule, ...p })
  const updateOp = (i: number, op: ParamOp) => up({ ops: ops.map((o, j) => (j === i ? op : o)) })
  const removeOp = (i: number) => up({ ops: ops.filter((_, j) => j !== i) })
  const moveOp = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= ops.length) return
    const next = ops.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    up({ ops: next })
  }

  const invalid = useMemo(() => ops.some((o) => o.type === 'regex' && !regexValid(o.pattern, o.flags)), [ops])
  const summary = rule.name || (ops.length ? ops.map(opSummary).join(' · ') : '（空规则）')

  const runTest = async () => {
    if (!testInput.trim()) return
    setTesting(true)
    try {
      setTestOut(await api.testParamRule({ rule, body: testInput }))
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setTesting(false)
    }
  }

  const pickLog = async (id: number) => {
    setPicking(false)
    try {
      const d = await api.getLog(id)
      if (!d.request_body) {
        toast('err', '该请求未存储正文')
        return
      }
      setTestInput(prettyJson(d.request_body))
      setTestOut(null)
    } catch (e: any) {
      toast('err', e.message)
    }
  }

  return (
    <div className="ah-pp-rule" draggable onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop}>
      <div className="ah-pp-rule-head">
        <span className="ah-pp-grip" title="拖拽排序">
          <IconGrip size={16} />
        </span>
        <Toggle checked={rule.enabled} onChange={(v) => up({ enabled: v })} />
        <button type="button" className="ah-pp-summary" onClick={onToggleExpand}>
          <span className="ah-pp-src is-param">参数</span>
          <span className="ah-pp-summary-text ah-truncate">{summary}</span>
        </button>
        {invalid && (
          <span className="ah-pp-invalid" title="存在无效的正则表达式">
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
            <Input value={rule.name ?? ''} onChange={(e) => up({ name: e.target.value })} placeholder="便于识别，如「给 xx 中转清理采样参数」" />
          </Field>
          <Field
            label="操作（按顺序执行）"
            hint={
              <>
                参数名支持点路径，如 <code>thinking.budget_tokens</code>、<code>tools.0.function.strict</code>；值按 JSON 解析（0.7 / true / null / 对象 /
                数组），解析失败按字符串处理。messages、system、stream 为受保护字段，规则不会改动。
              </>
            }
          >
            <div className="ah-pp-ops">
              {ops.map((op, i) => (
                <ParamOpRow
                  key={i}
                  op={op}
                  index={i}
                  count={ops.length}
                  onChange={(o) => updateOp(i, o)}
                  onRemove={() => removeOp(i)}
                  onMove={(d) => moveOp(i, d)}
                />
              ))}
              {!ops.length && <span className="ah-mini ah-faint">还没有操作，点下方「添加操作」</span>}
            </div>
            <div style={{ marginTop: 8 }}>
              <Button variant="soft" size="sm" icon={<IconPlus size={15} />} onClick={() => up({ ops: [...ops, newParamOp()] })}>
                添加操作
              </Button>
            </div>
          </Field>
          <Field label="入口格式（不选 = 全部）">
            <MultiChips
              options={FORMAT_OPTIONS}
              selected={rule.formats ?? []}
              onChange={(v) => up({ formats: v.length ? (v as ParamRule['formats']) : undefined })}
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
          <Field
            label="测试预览"
            hint="粘贴一份请求体 JSON 或从日志里选一条，查看本条规则应用后的参数部分。实际运行时规则作用于发往上游的最终请求体，同格式直通时与此一致"
          >
            <Textarea
              value={testInput}
              onChange={(e) => setTestInput(e.target.value)}
              placeholder='{"model":"gpt-4o","temperature":1,"top_p":0.9,"messages":[…]}'
              rows={4}
              spellCheck={false}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}
            />
            <div className="ah-pp-test-bar">
              <Button variant="soft" size="sm" icon={<IconExternal size={15} />} onClick={() => setPicking(true)}>
                从请求日志选择
              </Button>
              <Button variant="primary" size="sm" loading={testing} disabled={!testInput.trim()} onClick={runTest}>
                运行测试
              </Button>
              {testOut && (
                <span className="ah-mini ah-faint">
                  按 {WIRE_LABEL[testOut.wireFormat] || testOut.wireFormat} 格式处理 · {testOut.changed ? '有改动' : '无改动'}
                </span>
              )}
            </div>
            {testOut?.errors?.length ? <div className="ah-pp-test-err">{testOut.errors.join('\n')}</div> : null}
            {testOut && <pre className="ah-code ah-code-block ah-pp-test-out ah-pp-test-out-lg">{previewBody(testOut.body)}</pre>}
          </Field>
        </div>
      )}
      {picking && <LogPickerModal onPick={pickLog} onClose={() => setPicking(false)} />}
    </div>
  )
}

function ParamOpRow({
  op,
  index,
  count,
  onChange,
  onRemove,
  onMove,
}: {
  op: ParamOp
  index: number
  count: number
  onChange: (op: ParamOp) => void
  onRemove: () => void
  onMove: (dir: -1 | 1) => void
}) {
  const reOk = op.type !== 'regex' || regexValid(op.pattern, op.flags)
  const setType = (t: ParamOpType) => onChange({ ...op, type: t, flags: op.flags ?? 'g' })
  const isRegex = op.type === 'regex'

  return (
    <div className={`ah-pp-op${reOk ? '' : ' is-invalid'}`}>
      <div className="ah-pp-op-head">
        <span className="ah-pp-op-idx ah-mini ah-faint ah-num">{index + 1}</span>
        <Select value={op.type} onChange={(e) => setType(e.target.value as ParamOpType)}>
          {OP_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        {!isRegex && (
          <Input
            value={op.key ?? ''}
            onChange={(e) => onChange({ ...op, key: e.target.value })}
            placeholder="参数名，如 top_p / thinking.type"
            spellCheck={false}
            style={{ flex: '1 1 180px' }}
          />
        )}
        {!isRegex && op.type !== 'delete' && (
          <Input
            value={op.value ?? ''}
            onChange={(e) => onChange({ ...op, value: e.target.value })}
            placeholder='值，如 0.7 / true / {"type":"enabled","budget_tokens":1024}'
            spellCheck={false}
            style={{ flex: '2 1 240px' }}
          />
        )}
        {isRegex && <span className="ah-mini ah-faint" style={{ flex: 1 }}>对紧凑 JSON 文本（无空格）做替换，结果须仍为合法 JSON</span>}
        <div className="ah-pp-op-actions">
          <IconButton title="上移" onClick={() => index > 0 && onMove(-1)}>
            ▲
          </IconButton>
          <IconButton title="下移" onClick={() => index < count - 1 && onMove(1)}>
            ▼
          </IconButton>
          <IconButton title="删除操作" danger onClick={onRemove}>
            <IconTrash size={14} />
          </IconButton>
        </div>
      </div>
      {isRegex && (
        <>
          <div className="ah-pp-grid2">
            <Field label="查找（正则）" hint={!reOk ? <span style={{ color: 'var(--err)' }}>正则表达式无效</span> : undefined}>
              <Textarea
                value={op.pattern ?? ''}
                onChange={(e) => onChange({ ...op, pattern: e.target.value })}
                placeholder='例如 "top_p":[\d.]+,?  或  "additionalProperties":(true|false),?'
                rows={2}
                spellCheck={false}
                style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}
              />
            </Field>
            <Field label="替换为（空 = 删除）">
              <Textarea
                value={op.replacement ?? ''}
                onChange={(e) => onChange({ ...op, replacement: e.target.value })}
                placeholder="留空即删除匹配内容，支持 $1 捕获组"
                rows={2}
                spellCheck={false}
                style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}
              />
            </Field>
          </div>
          <Field label="flags">
            <Input value={op.flags ?? 'g'} onChange={(e) => onChange({ ...op, flags: e.target.value })} placeholder="g / gi" style={{ width: 120 }} />
          </Field>
        </>
      )}
    </div>
  )
}
