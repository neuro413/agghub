import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client'
import { Button, IconButton } from '../components/Button'
import { Card } from '../components/Card'
import { Field, Input, Select, Textarea } from '../components/Form'
import { IconCopy, IconExternal, IconGrip, IconPlus, IconTrash } from '../components/Icons'
import { PageHead } from '../components/PageHead'
import { Toggle } from '../components/Toggle'
import { useToast } from '../components/Toast'
import { channelModelNames } from '../lib/channelModels'
import { newId } from '../lib/id'
import type { ApiKeyView, Channel, RegexPack, RegexPackParam, RegexPackStep } from '../types'
import { LogPickerModal, ScopeFields, regexValid } from './preprocessShared'
import type { Opt } from './preprocessShared'
import { RegexPackHelp } from './RegexPackHelp'
import { StepList } from './RegexPackSteps'
import { RegexPackTest } from './RegexPackTest'

// 正则包（提示词预处理高级模式）：把一组正则 / 注入 / 脚本步骤打包成预设，可限定 UA 白名单与启用条件

const EXPORT_FORMAT = 'agghub-regex-pack'

function newPack(partial?: Partial<RegexPack>): RegexPack {
  return { id: newId(), enabled: true, name: '新正则包', params: [], steps: [], ...partial }
}

const FIELD_LABEL: Record<string, string> = {
  name: '名称', description: '说明', uaWhitelist: 'UA 白名单', when: '启用条件', pattern: '查找', replacement: '替换为', content: '内容', code: '脚本',
  condition: '执行条件', key: '变量名', value: '值', depth: '深度', roles: '作用角色', targets: '作用于', position: '位置',
}

/** 把服务端校验报错里的字段路径（regex_packs[0].steps[1].code）换成界面上的叫法 */
function describeError(message: string, packs: RegexPack[], current?: RegexPack): string {
  return message.replace(/(?:regex_packs\[\d+\]|steps\[\d+\]|params\[\d+\])[\w.[\]$]*/g, (path) => {
    const packIndex = /regex_packs\[(\d+)\]/.exec(path)
    const pack = packIndex ? packs[Number(packIndex[1])] : current
    const parts: string[] = []
    if (packIndex) parts.push(`包「${pack?.name || '未命名'}」`)
    const stepIndex = /steps\[(\d+)\]/.exec(path)
    if (stepIndex) {
      const name = pack?.steps[Number(stepIndex[1])]?.name
      parts.push(`步骤 ${Number(stepIndex[1]) + 1}${name ? `「${name}」` : ''}`)
    }
    const paramIndex = /params\[(\d+)\]/.exec(path)
    if (paramIndex) parts.push(`参数 ${Number(paramIndex[1]) + 1}`)
    const field = /\.(\w+)$/.exec(path)?.[1]
    if (field && FIELD_LABEL[field]) parts.push(FIELD_LABEL[field])
    return parts.join(' › ')
  })
}

/** 包里是否有会在网关上执行的代码（脚本、EJS、条件表达式） */
function hasCode(pack: RegexPack): boolean {
  if (pack.when?.mode === 'expr' && pack.when.source.trim()) return true
  return pack.steps.some((step) => !!step.condition?.trim() || step.type === 'script'
    || (step.type === 'regex' && step.replacement.includes('<%')) || (step.type === 'inject' && step.content.includes('<%')))
}

/** 渠道与 Key 的 id 只在本机有意义，导出和导入时都去掉 */
function portable(pack: RegexPack): RegexPack {
  const { channelIds: _channelIds, keyIds: _keyIds, ...rest } = pack
  return rest
}

/** 解析导入的文件：正则包导出文件、单个包、包数组，或预处理页导出的普通规则数组（转成一个包） */
function parseImport(parsed: any, fileName: string): RegexPack[] {
  const list: any[] = parsed?.format === EXPORT_FORMAT && Array.isArray(parsed.packs) ? parsed.packs : Array.isArray(parsed) ? parsed : [parsed]
  if (!list.length || list.some((item) => !item || typeof item !== 'object')) throw new Error('文件里没有可识别的正则包')
  if (list.every((item) => typeof item.pattern === 'string' && !Array.isArray(item.steps))) {
    const steps: RegexPackStep[] = list.map((rule) => ({
      id: newId(), enabled: rule.enabled !== false, type: 'regex', name: rule.name || undefined, pattern: rule.pattern, flags: rule.flags || 'g',
      replacement: String(rule.replacement ?? ''), action: rule.action === 'remove_message' ? 'remove_message' : undefined,
      roles: Array.isArray(rule.roles) && rule.roles.length ? rule.roles : undefined, depth: rule.depth || undefined,
    }))
    return [newPack({ name: fileName.replace(/\.json$/i, '') || '导入的规则', enabled: false, steps })]
  }
  return list.map((item) => {
    if (!Array.isArray(item.steps)) throw new Error('文件里没有可识别的正则包')
    return newPack({
      ...portable(item), id: newId(), enabled: false, name: String(item.name ?? '导入的正则包'),
      params: Array.isArray(item.params) ? item.params : [],
      steps: item.steps.map((step: any) => ({ ...step, id: newId() })),
    })
  })
}

type Tab = 'basic' | 'params' | 'steps' | 'test' | 'help'

export function RegexPacksPage() {
  const toast = useToast()
  const [packs, setPacks] = useState<RegexPack[] | null>(null)
  const [channels, setChannels] = useState<Channel[]>([])
  const [keys, setKeys] = useState<ApiKeyView[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('steps')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const dragIndex = useRef<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    api.getSettings(controller.signal).then((value) => {
      if (controller.signal.aborted) return
      setPacks(value.regex_packs ?? [])
      setSelected(value.regex_packs?.[0]?.id ?? null)
    }).catch((e) => { if (!controller.signal.aborted) toast('err', e.message) })
    api.listChannels(controller.signal).then((value) => { if (!controller.signal.aborted) setChannels(value) }).catch(() => {})
    api.listKeys(controller.signal).then((value) => { if (!controller.signal.aborted) setKeys(value) }).catch(() => {})
    return () => controller.abort()
  }, [toast])

  const modelOptions = useMemo<Opt[]>(() => {
    const set = new Set<string>()
    for (const c of channels) for (const m of channelModelNames(c)) set.add(m)
    return [...set].sort().map((m) => ({ value: m, label: m }))
  }, [channels])
  const channelOptions = useMemo<Opt[]>(() => channels.map((c) => ({ value: String(c.id), label: c.name })), [channels])
  const keyOptions = useMemo<Opt[]>(() => keys.map((k) => ({ value: String(k.id), label: k.name })), [keys])

  const change = (next: RegexPack[]) => {
    setPacks(next)
    setDirty(true)
  }
  const current = packs?.find((pack) => pack.id === selected) ?? null
  const update = (patch: Partial<RegexPack>) => {
    if (packs && current) change(packs.map((pack) => (pack.id === current.id ? { ...pack, ...patch } : pack)))
  }
  const add = (pack: RegexPack) => {
    change([...(packs ?? []), pack])
    setSelected(pack.id)
  }

  const save = async () => {
    if (!packs || saving) return
    setSaving(true)
    try {
      const saved = await api.updateSettings({ regex_packs: packs })
      setPacks(saved.regex_packs)
      setDirty(false)
      toast('ok', '已保存')
    } catch (e: any) {
      toast('err', describeError(e.message, packs))
    } finally {
      setSaving(false)
    }
  }

  const exportPack = (pack: RegexPack) => {
    const blob = new Blob([JSON.stringify({ format: EXPORT_FORMAT, version: 1, packs: [portable(pack)] }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${pack.name.replace(/[\\/:*?"<>|]/g, '_') || 'regex-pack'}.json`
    a.click()
    URL.revokeObjectURL(url)
  }
  const importFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const imported = parseImport(JSON.parse(String(reader.result)), file.name)
        if (imported.some(hasCode) && !window.confirm('这个文件里的正则包带有会在网关上执行的代码（脚本、EJS 或条件表达式），效果等同于在这台机器上运行文件作者的程序。\n\n请只导入来源可信的包。继续导入吗？')) return
        change([...(packs ?? []), ...imported])
        setSelected(imported[0].id)
        setTab('steps')
        toast('ok', `已导入 ${imported.length} 个正则包，默认未启用，检查后再打开开关并保存`)
      } catch (e: any) {
        toast('err', '导入失败：' + e.message)
      }
    }
    reader.readAsText(file)
  }
  const remove = (pack: RegexPack) => {
    if (!packs || !window.confirm(`确认删除正则包「${pack.name || '未命名'}」？保存后生效。`)) return
    const next = packs.filter((item) => item.id !== pack.id)
    change(next)
    setSelected(next[0]?.id ?? null)
  }
  const drop = (to: number) => {
    const from = dragIndex.current
    dragIndex.current = null
    if (!packs || from == null || from === to) return
    const next = packs.slice()
    next.splice(to, 0, next.splice(from, 1)[0])
    change(next)
  }

  if (!packs) {
    return (
      <div className="ah-fade-up">
        <PageHead title="正则包" />
        <div className="ah-skel" style={{ height: 200 }} />
      </div>
    )
  }

  const TABS: [Tab, string][] = [['steps', `步骤（${current?.steps.length ?? 0}）`], ['basic', '基本与启用范围'], ['params', `参数（${current?.params.length ?? 0}）`], ['test', '试运行'], ['help', '语法速查']]

  return (
    <div className="ah-fade-up">
      <PageHead
        title="正则包"
        sub="提示词预处理的高级模式 · 把多步改写打包成预设 · 可限定 UA 白名单 · 支持宏模板、EJS 与脚本"
        actions={
          <Button variant="primary" loading={saving} disabled={!dirty} onClick={save}>
            {dirty ? '保存修改' : '已保存'}
          </Button>
        }
      />
      <fieldset disabled={saving} className="ah-set-fieldset">
        <div className="ah-pk-layout">
          <Card className="ah-pk-side">
            <div className="ah-pk-side-bar">
              <Button variant="primary" size="sm" icon={<IconPlus size={16} />} onClick={() => add(newPack())}>
                新建
              </Button>
              <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()}>
                导入
              </Button>
            </div>
            {!packs.length && <div className="ah-mini ah-faint ah-pk-side-empty">还没有正则包</div>}
            {packs.map((pack, index) => (
              <div
                key={pack.id}
                className={`ah-pk-item${pack.id === selected ? ' is-active' : ''}`}
                draggable
                onDragStart={() => {
                  dragIndex.current = index
                }}
                onDragOver={(e) => {
                  if (dragIndex.current != null) e.preventDefault()
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  drop(index)
                }}
              >
                <span className="ah-pp-grip" title="拖动排序（包按从上到下的顺序执行）">
                  <IconGrip size={15} />
                </span>
                <button type="button" className="ah-pk-item-main" onClick={() => setSelected(pack.id)}>
                  <span className="ah-pk-item-name ah-truncate">{pack.name || '未命名'}</span>
                  <span className="ah-mini ah-faint ah-truncate">
                    {pack.steps.length} 步 · {pack.uaWhitelist?.length ? `UA：${pack.uaWhitelist.join('、')}` : '不限 UA'}
                  </span>
                </button>
                <Toggle checked={pack.enabled} onChange={(enabled) => change(packs.map((item) => (item.id === pack.id ? { ...item, enabled } : item)))} />
              </div>
            ))}
            <div className="ah-mini ah-faint ah-pk-side-note">
              启用且命中范围的包都会执行，排在预处理页的普通规则之后。模板与脚本以网关进程的权限运行，可以访问网络和文件。
            </div>
          </Card>

          {!current ? (
            <Card className="ah-pk-main">
              <div className="ah-detail-empty">新建一个正则包，或导入别人分享的包文件（也可以导入预处理页导出的普通规则，会转成一个包）</div>
            </Card>
          ) : (
            <Card className="ah-pk-main">
              <div className="ah-pk-main-head">
                <Input className="ah-input ah-pk-name" value={current.name} onChange={(e) => update({ name: e.target.value })} placeholder="正则包名称" maxLength={128} />
                <IconButton title="复制一份" onClick={() => add(newPack({ ...current, id: newId(), name: `${current.name} 副本`, steps: current.steps.map((step) => ({ ...step, id: newId() })) }))}>
                  <IconCopy size={15} />
                </IconButton>
                <IconButton title="导出为文件" onClick={() => exportPack(current)}>
                  <IconExternal size={15} />
                </IconButton>
                <IconButton title="删除" danger onClick={() => remove(current)}>
                  <IconTrash size={15} />
                </IconButton>
              </div>
              <div className="ah-detail-tabs ah-tabs-line">
                {TABS.map(([key, label]) => (
                  <button key={key} type="button" className={`ah-detail-tab${tab === key ? ' is-active' : ''}`} onClick={() => setTab(key)}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="ah-pk-pane">
                {tab === 'steps' && <StepList key={current.id} steps={current.steps} onChange={(steps) => update({ steps })} />}
                {tab === 'basic' && <BasicPane pack={current} update={update} channelOptions={channelOptions} modelOptions={modelOptions} keyOptions={keyOptions} />}
                {tab === 'params' && <ParamsPane params={current.params} onChange={(params) => update({ params })} />}
                {tab === 'test' && <RegexPackTest key={current.id} pack={current} describeError={(message) => describeError(message, packs, current)} />}
                {tab === 'help' && <RegexPackHelp />}
              </div>
            </Card>
          )}
        </div>
      </fieldset>
      <input
        ref={fileRef}
        type="file"
        accept="application/json"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) importFile(file)
          e.target.value = ''
        }}
      />
    </div>
  )
}

function BasicPane({ pack, update, channelOptions, modelOptions, keyOptions }: {
  pack: RegexPack
  update: (patch: Partial<RegexPack>) => void
  channelOptions: Opt[]
  modelOptions: Opt[]
  keyOptions: Opt[]
}) {
  const toast = useToast()
  const [uaInput, setUaInput] = useState('')
  const [picking, setPicking] = useState(false)
  const list = pack.uaWhitelist ?? []
  const entry = uaInput.trim()
  // /…/flags 形式的条目按正则处理，输入时就检查能否编译
  const literal = /^\/(.+)\/([a-z]*)$/s.exec(entry)
  const entryValid = !literal || regexValid(literal[1], literal[2].replace(/[gy]/g, '') || 'i')
  const addUa = () => {
    if (!entry || !entryValid) return
    if (!list.includes(entry)) update({ uaWhitelist: [...list, entry] })
    setUaInput('')
  }
  const pickUa = async (id: number) => {
    setPicking(false)
    try {
      const log = await api.getLogFields(id, [])
      if (!log.user_agent) toast('err', '这条请求没有记录 User-Agent')
      else setUaInput(log.user_agent)
    } catch (e: any) {
      toast('err', e.message)
    }
  }
  const mode = pack.when?.mode ?? 'none'
  const whenValid = pack.when?.mode !== 'regex' || regexValid(pack.when.source, pack.when.flags || 'u')

  return (
    <div className="ah-pk-body">
      <Field label="说明（可选）">
        <Textarea value={pack.description ?? ''} onChange={(e) => update({ description: e.target.value || undefined })} rows={2} placeholder="这个包做什么、适用于哪个客户端，分享给别人时会一并带上" />
      </Field>
      <Field
        label="UA 白名单（不填 = 不限）"
        hint={
          <>
            只有客户端 User-Agent 命中其中任意一条时才启用这个包。默认按关键词包含匹配、不区分大小写，如 <code>claude-cli</code>；写成 <code>/正则/flags</code> 时按正则匹配，如{' '}
            <code>/^claude-cli\/2\./</code>。设置了白名单后，不带 User-Agent 的请求不会启用。
          </>
        }
      >
        <div className="ah-pp-chips" style={{ marginBottom: 8 }}>
          {list.map((item) => (
            <button type="button" key={item} className="ah-pp-chip is-on" title="点击移除" onClick={() => update({ uaWhitelist: list.length > 1 ? list.filter((x) => x !== item) : undefined })}>
              {item} ×
            </button>
          ))}
          {!list.length && <span className="ah-mini ah-faint">未设置，对所有客户端启用</span>}
        </div>
        <div className="ah-pk-inline">
          <Input
            className="ah-input ah-pk-mono"
            value={uaInput}
            onChange={(e) => setUaInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addUa()
              }
            }}
            placeholder="关键词或 /正则/，回车添加"
            spellCheck={false}
          />
          <Button variant="soft" size="sm" disabled={!entry || !entryValid} onClick={addUa}>
            添加
          </Button>
          <Button variant="soft" size="sm" icon={<IconExternal size={15} />} onClick={() => setPicking(true)}>
            从请求日志取 UA
          </Button>
        </div>
        {!entryValid && <div className="ah-mini ah-c-err" style={{ marginTop: 6 }}>正则表达式无效</div>}
      </Field>
      <Field
        label="启用条件（可选）"
        hint="与 UA 白名单及下面的范围同时满足才启用。UA 可以伪造，改版客户端也常沿用原来的 UA，用系统提示词里的特征文本识别会更准"
      >
        <div className="ah-pk-inline">
          <div style={{ flex: 'none', width: 220 }}>
            <Select
              value={mode}
              onChange={(e) => {
                const next = e.target.value
                update({ when: next === 'none' ? undefined : { mode: next as 'regex' | 'expr', source: pack.when?.source ?? '', flags: next === 'regex' ? pack.when?.flags ?? 'i' : undefined } })
              }}
            >
              <option value="none">不设条件</option>
              <option value="regex">系统提示词匹配正则</option>
              <option value="expr">JS 表达式为真</option>
            </Select>
          </div>
          {pack.when && (
            <Input
              className="ah-input ah-pk-mono"
              value={pack.when.source}
              onChange={(e) => update({ when: { ...pack.when!, source: e.target.value } })}
              placeholder={pack.when.mode === 'regex' ? 'You are Claude Code' : "req.tools.some(t => t.name === 'TodoWrite') && ctx.model.startsWith('claude')"}
              spellCheck={false}
            />
          )}
          {pack.when?.mode === 'regex' && (
            <div style={{ flex: 'none', width: 90 }}>
              <Input value={pack.when.flags ?? ''} onChange={(e) => update({ when: { ...pack.when!, flags: e.target.value } })} placeholder="flags" spellCheck={false} />
            </div>
          )}
        </div>
        {!whenValid && <div className="ah-mini ah-c-err" style={{ marginTop: 6 }}>正则表达式无效</div>}
      </Field>
      <ScopeFields rule={pack} onChange={update} channelOptions={channelOptions} modelOptions={modelOptions} keyOptions={keyOptions} />
      {picking && <LogPickerModal onPick={pickUa} onClose={() => setPicking(false)} />}
    </div>
  )
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

function ParamsPane({ params, onChange }: { params: RegexPackParam[]; onChange: (params: RegexPackParam[]) => void }) {
  const up = (index: number, patch: Partial<RegexPackParam>) => onChange(params.map((param, i) => (i === index ? { ...param, ...patch } : param)))
  const setType = (index: number, type: RegexPackParam['type']) => {
    const value = params[index].value
    up(index, { type, value: type === 'text' ? String(value) : type === 'boolean' ? value === true || value === 'true' : Number(value) || 0 })
  }
  const add = () => {
    let n = params.length + 1
    while (params.some((param) => param.key === `param${n}`)) n++
    onChange([...params, { key: `param${n}`, type: 'text', value: '' }])
  }
  return (
    <div className="ah-pk-body">
      <div className="ah-mini ah-muted">
        参数是这个包对外的设置项：步骤里用 <code>{'{{变量名}}'}</code> 或 <code>params.变量名</code> 读取，使用者只改这里的值，不用动正则和脚本。开关类参数适合放进步骤的「执行条件」里。
      </div>
      {params.map((param, index) => {
        const keyValid = IDENTIFIER.test(param.key) && params.findIndex((item) => item.key === param.key) === index
        return (
          <div key={index} className="ah-pp-op">
            <div className="ah-pk-param-head">
              <div className="ah-pk-param-key">
                <Input className="ah-input ah-pk-mono" value={param.key} onChange={(e) => up(index, { key: e.target.value })} placeholder="变量名" spellCheck={false} />
              </div>
              <Input value={param.label ?? ''} onChange={(e) => up(index, { label: e.target.value || undefined })} placeholder="显示名（可选）" />
              <div className="ah-pk-param-type">
                <Select value={param.type} onChange={(e) => setType(index, e.target.value as RegexPackParam['type'])}>
                  <option value="text">文本</option>
                  <option value="boolean">开关</option>
                  <option value="number">数字</option>
                </Select>
              </div>
              <IconButton title="删除参数" danger onClick={() => onChange(params.filter((_, i) => i !== index))}>
                <IconTrash size={14} />
              </IconButton>
            </div>
            {!keyValid && <div className="ah-mini ah-c-err">变量名须为不重复的字母、数字、下划线组合，且不以数字开头</div>}
            {param.type === 'text' && <Textarea value={String(param.value)} onChange={(e) => up(index, { value: e.target.value })} rows={2} placeholder="值" />}
            {param.type === 'number' && <Input type="number" step="any" value={Number(param.value)} onChange={(e) => up(index, { value: Number(e.target.value) || 0 })} />}
            {param.type === 'boolean' && (
              <div className="ah-pk-inline">
                <Toggle checked={param.value === true} onChange={(value) => up(index, { value })} />
                <span className="ah-mini ah-muted">{param.value === true ? '开' : '关'}</span>
              </div>
            )}
            <Input value={param.description ?? ''} onChange={(e) => up(index, { description: e.target.value || undefined })} placeholder="给使用者看的说明（可选）" />
          </div>
        )
      })}
      {!params.length && <div className="ah-detail-empty">这个包还没有参数</div>}
      <div>
        <Button variant="soft" size="sm" icon={<IconPlus size={15} />} onClick={add}>
          添加参数
        </Button>
      </div>
    </div>
  )
}
