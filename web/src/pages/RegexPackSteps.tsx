import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, IconButton } from '../components/Button'
import { Field, Input, Select } from '../components/Form'
import { IconGrip, IconPlus, IconTrash } from '../components/Icons'
import { Toggle } from '../components/Toggle'
import { newId } from '../lib/id'
import type { RegexPackInjectStep, RegexPackRegexStep, RegexPackScriptStep, RegexPackStep } from '../types'
import { MultiChips, regexValid } from './preprocessShared'
import type { Opt } from './preprocessShared'
import { STEP_TYPE_CLASS, STEP_TYPE_LABEL } from './RegexPackTest'

// 正则包的步骤编辑器：正则 / 注入 / 脚本三种步骤的列表与各自的表单

const ROLE_OPTIONS: Opt[] = ['system', 'user', 'assistant', 'tool'].map((value) => ({ value, label: value }))
const TARGET_OPTIONS: Opt[] = [
  { value: 'messages', label: '消息文本' },
  { value: 'tools', label: '工具定义（描述与参数说明）' },
]
const POSITION_LABEL: Record<RegexPackInjectStep['position'], string> = {
  system_start: '系统提示词开头',
  system_end: '系统提示词结尾',
  depth: '作为一条消息按深度插入',
}

export function newStep(type: RegexPackStep['type']): RegexPackStep {
  const base = { id: newId(), enabled: true }
  if (type === 'regex') return { ...base, type, pattern: '', flags: 'g', replacement: '' }
  if (type === 'inject') return { ...base, type, content: '', position: 'system_end' }
  return { ...base, type, code: '' }
}

/** 等宽的代码 / 模板输入框；Tab 键输入两个空格 */
export function CodeArea({ value, onChange, rows = 4, placeholder }: { value: string; onChange: (value: string) => void; rows?: number; placeholder?: string }) {
  return (
    <textarea
      className="ah-textarea ah-pk-code"
      value={value}
      rows={rows}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return
        e.preventDefault()
        const el = e.currentTarget
        el.setRangeText('  ', el.selectionStart, el.selectionEnd, 'end')
        onChange(el.value)
      }}
    />
  )
}

const firstLine = (text: string): string => text.split('\n').find((line) => line.trim())?.trim() ?? ''

function stepSummary(step: RegexPackStep): string {
  if (step.name) return step.name
  if (step.type === 'regex') {
    if (!step.pattern) return '（未填写查找内容）'
    return `${step.pattern}  →  ${step.action === 'remove_message' ? '（移除整条消息）' : firstLine(step.replacement) || '（删除）'}`
  }
  if (step.type === 'inject') return `${POSITION_LABEL[step.position]}：${firstLine(step.content) || '（空）'}`
  return firstLine(step.code) || '（空脚本）'
}

export function StepList({ steps, onChange }: { steps: RegexPackStep[]; onChange: (next: RegexPackStep[]) => void }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const dragIndex = useRef<number | null>(null)
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  const add = (type: RegexPackStep['type']) => {
    const step = newStep(type)
    onChange([...steps, step])
    setExpanded((prev) => new Set(prev).add(step.id))
  }
  const drop = (to: number) => {
    const from = dragIndex.current
    dragIndex.current = null
    if (from == null || from === to) return
    const next = steps.slice()
    next.splice(to, 0, next.splice(from, 1)[0])
    onChange(next)
  }

  return (
    <div className="ah-pp">
      <div className="ah-pp-toolbar" style={{ marginTop: 0 }}>
        <Button variant="primary" size="sm" icon={<IconPlus size={16} />} onClick={() => add('regex')}>
          正则步骤
        </Button>
        <Button variant="soft" size="sm" icon={<IconPlus size={16} />} onClick={() => add('inject')}>
          注入步骤
        </Button>
        <Button variant="soft" size="sm" icon={<IconPlus size={16} />} onClick={() => add('script')}>
          脚本步骤
        </Button>
        <span style={{ flex: 1 }} />
        <span className="ah-mini ah-faint">按从上到下的顺序执行，拖动左侧手柄排序</span>
      </div>
      {!steps.length ? (
        <div className="ah-detail-empty">还没有步骤。正则步骤做查找替换，注入步骤往请求里加一段话，脚本步骤用 JS 直接改写整个请求</div>
      ) : (
        <div className="ah-pp-list">
          {steps.map((step, index) => (
            <div
              key={step.id}
              className="ah-pp-rule"
              onDragOver={(e) => {
                if (dragIndex.current != null) e.preventDefault()
              }}
              onDrop={(e) => {
                e.preventDefault()
                drop(index)
              }}
            >
              <div className="ah-pp-rule-head">
                {/* 只有手柄可拖动：整行可拖动时输入框里无法用鼠标选中文本 */}
                <span
                  className="ah-pp-grip"
                  title="拖动排序"
                  draggable
                  onDragStart={() => {
                    dragIndex.current = index
                  }}
                  onDragEnd={() => {
                    dragIndex.current = null
                  }}
                >
                  <IconGrip size={16} />
                </span>
                <Toggle checked={step.enabled} onChange={(enabled) => onChange(steps.map((item) => (item.id === step.id ? { ...item, enabled } : item)))} />
                <button type="button" className="ah-pp-summary" onClick={() => toggle(step.id)}>
                  <span className="ah-mini ah-faint ah-num">{index + 1}</span>
                  <span className={`ah-pp-src ${STEP_TYPE_CLASS[step.type]}`}>{STEP_TYPE_LABEL[step.type]}</span>
                  {step.condition?.trim() && <span className="ah-pp-src">有条件</span>}
                  <span className="ah-pp-summary-text ah-truncate">{stepSummary(step)}</span>
                </button>
                <IconButton title="删除步骤" danger onClick={() => onChange(steps.filter((item) => item.id !== step.id))}>
                  <IconTrash size={15} />
                </IconButton>
              </div>
              {expanded.has(step.id) && (
                <StepBody step={step} onChange={(next) => onChange(steps.map((item) => (item.id === next.id ? next : item)))} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function StepBody({ step, onChange }: { step: RegexPackStep; onChange: (step: RegexPackStep) => void }) {
  return (
    <div className="ah-pp-rule-body">
      <Field label="名称（可选）">
        <Input value={step.name ?? ''} onChange={(e) => onChange({ ...step, name: e.target.value || undefined })} placeholder="便于识别，也会显示在请求日志的执行记录里" />
      </Field>
      {step.type === 'regex' && <RegexFields step={step} onChange={onChange} />}
      {step.type === 'inject' && <InjectFields step={step} onChange={onChange} />}
      {step.type === 'script' && <ScriptFields step={step} onChange={onChange} />}
      <Field label="执行条件（可选）" hint="JS 表达式，结果为假时跳过这一步；留空 = 总是执行。可用 params、vars、ctx、req，例如用包参数里的开关控制这一步">
        <Input
          className="ah-input ah-pk-mono"
          value={step.condition ?? ''}
          onChange={(e) => onChange({ ...step, condition: e.target.value || undefined })}
          placeholder="params.concise && ctx.model.includes('sonnet')"
          spellCheck={false}
        />
      </Field>
    </div>
  )
}

function Chips<T extends string>({ value, options, onChange }: { value: T; options: [T, ReactNode][]; onChange: (value: T) => void }) {
  return (
    <div className="ah-pp-chips">
      {options.map(([key, label]) => (
        <button type="button" key={key} className={`ah-pp-chip${value === key ? ' is-on' : ''}`} onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </div>
  )
}

function RegexFields({ step, onChange }: { step: RegexPackRegexStep; onChange: (step: RegexPackStep) => void }) {
  const up = (patch: Partial<RegexPackRegexStep>) => onChange({ ...step, ...patch })
  const removing = step.action === 'remove_message'
  const valid = regexValid(step.pattern, step.flags)
  const targets = step.targets?.length ? step.targets : ['messages']
  const onMessages = removing || targets.includes('messages')
  const find = (
    <Field label="查找（正则）" hint={!valid ? <span className="ah-c-err">正则表达式无效</span> : undefined}>
      <CodeArea value={step.pattern} onChange={(pattern) => up({ pattern })} rows={3} placeholder={removing ? '关键词或正则，多个关键词用 | 分隔' : '要匹配的正则'} />
    </Field>
  )
  return (
    <>
      <Field label="命中后" hint={removing ? '消息文本命中时整条消息不再发往上游；它带有的工具调用 / 结果会连同配对的另一半一起移除' : undefined}>
        <Chips
          value={removing ? 'remove_message' : 'replace'}
          options={[['replace', '替换文本'], ['remove_message', '移除整条消息']]}
          onChange={(action) => up({ action: action === 'replace' ? undefined : action })}
        />
      </Field>
      {removing ? (
        find
      ) : (
        <div className="ah-pp-grid2">
          {find}
          <Field label="替换为（模板，空 = 删除）" hint="每个匹配渲染一次，可用宏、EJS 与 $1 捕获组；写法见「语法速查」">
            <CodeArea value={step.replacement} onChange={(replacement) => up({ replacement })} rows={3} placeholder="{{setvar::cwd::$1}}$&" />
          </Field>
        </div>
      )}
      <div className="ah-pp-grid2">
        <Field label="flags">
          <Input value={step.flags} onChange={(e) => up({ flags: e.target.value })} placeholder="g / gi / gs…" spellCheck={false} />
        </Field>
        {onMessages && (
          <Field label="深度（只处理最后 N 条消息，0 = 全部）">
            <Input type="number" min={0} value={step.depth ?? 0} onChange={(e) => up({ depth: Math.max(0, Math.floor(Number(e.target.value)) || 0) || undefined })} />
          </Field>
        )}
      </div>
      {!removing && (
        <Field label="作用于">
          <MultiChips options={TARGET_OPTIONS} selected={targets} onChange={(value) => up({ targets: value.length ? (value as RegexPackRegexStep['targets']) : undefined })} />
        </Field>
      )}
      {onMessages && (
        <Field label="作用角色（不选 = 全部，仅对消息文本生效）">
          <MultiChips options={ROLE_OPTIONS} selected={step.roles ?? []} onChange={(roles) => up({ roles: roles.length ? roles : undefined })} />
        </Field>
      )}
    </>
  )
}

function InjectFields({ step, onChange }: { step: RegexPackInjectStep; onChange: (step: RegexPackStep) => void }) {
  const up = (patch: Partial<RegexPackInjectStep>) => onChange({ ...step, ...patch })
  return (
    <>
      <Field label="内容（模板）" hint="渲染结果为空时不注入，可以用 EJS 的 if 按条件决定是否输出">
        <CodeArea value={step.content} onChange={(content) => up({ content })} rows={8} placeholder={'<% if (params.concise) { %>回答尽量简短。<% } %>\n当前模型：{{model}}'} />
      </Field>
      <div className="ah-pk-grid3">
        <Field label="位置">
          <Select value={step.position} onChange={(e) => up({ position: e.target.value as RegexPackInjectStep['position'] })}>
            {(Object.keys(POSITION_LABEL) as RegexPackInjectStep['position'][]).map((position) => (
              <option key={position} value={position}>
                {POSITION_LABEL[position]}
              </option>
            ))}
          </Select>
        </Field>
        {step.position === 'depth' && (
          <>
            <Field label="深度（0 = 最末尾，1 = 最后一条之前）">
              <Input type="number" min={0} value={step.depth ?? 0} onChange={(e) => up({ depth: Math.max(0, Math.floor(Number(e.target.value)) || 0) })} />
            </Field>
            <Field label="角色" hint="Claude 直通的消息里没有 system 角色，会按 user 插入">
              <Select value={step.role ?? 'system'} onChange={(e) => up({ role: e.target.value as RegexPackInjectStep['role'] })}>
                <option value="system">system</option>
                <option value="user">user</option>
                <option value="assistant">assistant</option>
              </Select>
            </Field>
          </>
        )}
      </div>
    </>
  )
}

function ScriptFields({ step, onChange }: { step: RegexPackScriptStep; onChange: (step: RegexPackStep) => void }) {
  return (
    <Field label="脚本（异步 JS）" hint="可直接 await；用 req 读写系统提示词、消息与工具，用 body 直接改原始请求体。抛错或超过 30 秒时这一步不生效">
      <CodeArea
        value={step.code}
        onChange={(code) => onChange({ ...step, code })}
        rows={14}
        placeholder={"req.system = req.system.replace(/# Tone and style[\\s\\S]*?(?=\\n# )/, '')\nfor (const tool of req.tools) tool.description = tool.description.split('\\n\\n')[0]"}
      />
    </Field>
  )
}
