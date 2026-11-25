import { useMemo, useState } from 'react'
import { api } from '../api/client'
import { Button } from '../components/Button'
import { Field, Input, Select, Textarea } from '../components/Form'
import { IconExternal, IconTest } from '../components/Icons'
import { Toggle } from '../components/Toggle'
import { useToast } from '../components/Toast'
import { prettyJson } from '../lib/format'
import { collapseDiff, diffLines } from '../lib/lineDiff'
import { parseConversation, roleClass } from '../lib/requestBody'
import type { PackStepTrace, PackTestResult, PackTrace, RegexPack } from '../types'
import { LogPickerModal } from './preprocessShared'

// 正则包试运行：把当前（可以未保存的）包应用到一份请求体上，查看改写前后的差异与各步骤状态

export const STEP_TYPE_LABEL: Record<PackStepTrace['type'], string> = { regex: '正则', inject: '注入', script: '脚本' }
export const STEP_TYPE_CLASS: Record<PackStepTrace['type'], string> = { regex: 'is-regex', inject: 'is-visual', script: 'is-param' }

const STATUS: Record<PackStepTrace['status'], { label: string; cls: string }> = {
  changed: { label: '已改写', cls: 'ah-tag-ok' },
  unchanged: { label: '无改动', cls: '' },
  skipped: { label: '条件不满足', cls: '' },
  error: { label: '出错', cls: 'ah-tag-err' },
}

/** 一个包的执行记录：各步骤状态、报错与脚本输出（试运行结果和日志详情共用） */
export function PackTraceView({ trace }: { trace: PackTrace }) {
  return (
    <div className="ah-pk-trace">
      {trace.error && <div className="ah-pp-test-err">启用条件求值出错，本次未启用：{trace.error}</div>}
      {trace.steps.map((step, index) => (
        <div key={index} className="ah-pk-trace-row">
          <span className={`ah-pp-src ${STEP_TYPE_CLASS[step.type]}`}>{STEP_TYPE_LABEL[step.type]}</span>
          <span className="ah-pk-trace-name ah-truncate">{step.name}</span>
          {step.ms != null && <span className="ah-mini ah-faint ah-num">{step.ms}ms</span>}
          <span className={`ah-tag ${STATUS[step.status].cls}`}>{STATUS[step.status].label}</span>
          {step.error && <div className="ah-pk-trace-err">{step.error}</div>}
        </div>
      ))}
      {!trace.steps.length && !trace.error && <span className="ah-mini ah-faint">这个包没有启用的步骤</span>}
      {!!trace.logs?.length && (
        <div>
          <div className="ah-mini ah-faint" style={{ margin: '6px 0 4px' }}>脚本输出（console.log）</div>
          <pre className="ah-code ah-code-block ah-pp-test-out">{trace.logs.join('\n')}</pre>
        </div>
      )}
    </div>
  )
}

/** 把请求体展开成便于逐行对比的文本：各条消息的文本，加上工具定义的描述与参数说明 */
function bodyLines(body: any): string[] {
  const lines: string[] = []
  for (const block of parseConversation(JSON.stringify(body))) lines.push(`━━ ${block.role.toUpperCase()} ━━`, ...block.text.split('\n'))
  const walk = (tools: any[]) => {
    for (const tool of tools) {
      if (!tool || typeof tool !== 'object') continue
      if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
        walk(tool.tools)
        continue
      }
      const holder = tool.function && typeof tool.function === 'object' ? tool.function : tool.custom && typeof tool.custom === 'object' ? tool.custom : tool
      lines.push(`━━ TOOL ${holder.name ?? tool.type ?? ''} ━━`)
      if (typeof holder.description === 'string') lines.push(...holder.description.split('\n'))
      const schema = holder.parameters ?? holder.input_schema
      if (schema) lines.push(...JSON.stringify(schema, null, 2).split('\n'))
    }
  }
  if (Array.isArray(body?.tools)) walk(body.tools)
  return lines
}

/** 差异视图最多渲染的行数，超出部分提示改看 JSON */
const MAX_DIFF_ROWS = 4000

function DiffView({ before, after }: { before: any; after: any }) {
  const rows = useMemo(() => collapseDiff(diffLines(bodyLines(before), bodyLines(after))), [before, after])
  if (!rows.some((row) => row.type === 'add' || row.type === 'del')) {
    return <div className="ah-detail-empty">消息文本与工具定义没有差异（其他字段的改动请看「改写后 JSON」）</div>
  }
  return (
    <div className="ah-pk-diff">
      {rows.slice(0, MAX_DIFF_ROWS).map((row, index) =>
        row.type === 'gap' ? (
          <div key={index} className="ah-pk-diff-gap">⋯ {row.count} 行未改动 ⋯</div>
        ) : (
          <div key={index} className={`ah-pk-diff-line is-${row.type}`} data-sign={row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' '}>
            {row.text || ' '}
          </div>
        ),
      )}
      {rows.length > MAX_DIFF_ROWS && <div className="ah-pk-diff-gap">差异过长，只显示前 {MAX_DIFF_ROWS} 行</div>}
    </div>
  )
}

type View = 'diff' | 'conv' | 'json'

export function RegexPackTest({ pack, describeError }: { pack: RegexPack; describeError: (message: string) => string }) {
  const toast = useToast()
  const [body, setBody] = useState('')
  const [ua, setUa] = useState('')
  const [model, setModel] = useState('')
  const [format, setFormat] = useState('auto')
  const [converted, setConverted] = useState(false)
  const [picking, setPicking] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<PackTestResult | null>(null)
  const [view, setView] = useState<View>('diff')

  const pickLog = async (id: number) => {
    setPicking(false)
    try {
      const log = await api.getLogFields(id, ['request_body'])
      if (!log.request_body) {
        toast('err', '该请求未存储正文')
        return
      }
      setBody(prettyJson(log.request_body))
      setUa(log.user_agent ?? '')
      setModel(log.model ?? '')
      setFormat(['openai', 'anthropic', 'responses'].includes(log.entry_format) ? log.entry_format : 'auto')
      setResult(null)
    } catch (e: any) {
      toast('err', e.message)
    }
  }

  const run = async () => {
    setRunning(true)
    try {
      setResult(await api.testPack({ pack, body, ua, model, entryFormat: format === 'auto' ? undefined : format, passthrough: !converted }))
    } catch (e: any) {
      toast('err', describeError(e.message))
    } finally {
      setRunning(false)
    }
  }

  const blocks = useMemo(() => (result && view === 'conv' ? parseConversation(JSON.stringify(result.after)) : []), [result, view])
  const vars = result ? Object.keys(result.vars) : []

  return (
    <div className="ah-pk-body">
      <Field label="请求体 JSON" hint="粘贴客户端发来的请求体，或从请求日志里选一条（会一并带出它的 User-Agent、模型与入口格式）">
        <Textarea
          className="ah-textarea ah-pk-code"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder='{"model":"claude-sonnet-4-5","system":[…],"tools":[…],"messages":[…]}'
          rows={5}
          spellCheck={false}
        />
      </Field>
      <div className="ah-pk-grid3">
        <Field label="模拟 User-Agent">
          <Input value={ua} onChange={(e) => setUa(e.target.value)} placeholder="claude-cli/2.1.0 (external, cli)" spellCheck={false} />
        </Field>
        <Field label="模拟模型（空 = 取请求体里的 model）">
          <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="claude-sonnet-4-5" spellCheck={false} />
        </Field>
        <Field label="入口格式">
          <Select value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="auto">自动判断</option>
            <option value="openai">OpenAI Chat</option>
            <option value="anthropic">Anthropic</option>
            <option value="responses">Responses</option>
          </Select>
        </Field>
      </div>
      <div className="ah-pp-test-bar" style={{ marginTop: 0 }}>
        <Button variant="soft" size="sm" icon={<IconExternal size={15} />} onClick={() => setPicking(true)}>
          从请求日志选择
        </Button>
        <Button variant="primary" size="sm" icon={<IconTest size={15} />} loading={running} disabled={!body.trim()} onClick={run}>
          试运行
        </Button>
        <span style={{ flex: 1 }} />
        <span className="ah-mini ah-muted" title="请求被路由到其他协议的渠道时，包拿到的是 OpenAI Chat 结构的中间表示（system 在 messages 内）。打开后按这种形状试运行，用来确认脚本在两种链路下都能工作">
          按跨格式转换的链路
        </span>
        <Toggle checked={converted} onChange={setConverted} />
      </div>
      <div className="ah-mini ah-faint">试运行会在网关上真实执行包里的模板与脚本（fetch 等操作同样会发生），但不会请求上游，也不写入日志。</div>

      {result && (
        <>
          {result.inactiveReason && (
            <div className="ah-pk-warn">
              按当前的模拟条件，这个包在真实请求里不会启用：{result.inactiveReason}。下面是忽略启用范围后强制执行的结果。
            </div>
          )}
          <div className="ah-mini ah-muted">
            按 {result.passthrough ? `${result.entryFormat} 直通` : `${result.entryFormat} 入口的中间表示`} 执行 · {result.changed ? '请求体有改动' : '请求体无改动'}
            {!result.inactiveReason && ' · 渠道 / 调用来源 / Key 的限定在试运行中不检查'}
          </div>
          <PackTraceView trace={result.trace} />
          {vars.length > 0 && (
            <div>
              <div className="ah-mini ah-faint" style={{ marginBottom: 4 }}>执行结束时的变量</div>
              <pre className="ah-code ah-code-block ah-pp-test-out">{JSON.stringify(result.vars, null, 2)}</pre>
            </div>
          )}
          <div className="ah-detail-tabs ah-tabs-line">
            {([['diff', '改写前后对比'], ['conv', '改写后对话'], ['json', '改写后 JSON']] as [View, string][]).map(([key, label]) => (
              <button key={key} type="button" className={`ah-detail-tab${view === key ? ' is-active' : ''}`} onClick={() => setView(key)}>
                {label}
              </button>
            ))}
          </div>
          {view === 'diff' && <DiffView before={result.before} after={result.after} />}
          {view === 'conv' && (
            <div className="ah-pp-conv">
              {blocks.map((block, index) => (
                <div key={index} className={`ah-blk role-${roleClass(block.role)}`}>
                  <div className="ah-blk-head">
                    <span className="ah-blk-role">{block.role.toUpperCase()}</span>
                    <span className="ah-blk-chars ah-mini ah-num">{block.chars.toLocaleString()} 字</span>
                  </div>
                  <div className="ah-blk-body ah-pp-blk-body">{block.text || '(空)'}</div>
                </div>
              ))}
              {!blocks.length && <div className="ah-detail-empty">改写后的请求里没有对话内容</div>}
            </div>
          )}
          {view === 'json' && <pre className="ah-code ah-code-block">{JSON.stringify(result.after, null, 2)}</pre>}
        </>
      )}
      {picking && <LogPickerModal onPick={pickLog} onClose={() => setPicking(false)} />}
    </div>
  )
}
