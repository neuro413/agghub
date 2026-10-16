import { useState } from 'react'
import { api } from '../api/client'
import { Button, IconButton } from '../components/Button'
import { Dropdown, Field, Input, Select, Slider, Textarea } from '../components/Form'
import { IconCheck, IconPlus, IconRefresh, IconTest, IconTrash } from '../components/Icons'
import { Modal } from '../components/Modal'
import { Toggle } from '../components/Toggle'
import { useToast } from '../components/Toast'
import type { Channel, ChannelType, SingleRoleMode } from '../types'

const PLACEHOLDER: Record<ChannelType, string> = {
  openai: 'https://api.openai.com（留空用官方）',
  anthropic: 'https://api.anthropic.com（留空用官方）',
  vertex: '留空自动用 aiplatform.googleapis.com',
  responses: 'https://api.openai.com（留空用官方）',
}

/** 模型专属名的一行：模型列表原名 → 专属名 */
interface AliasRow {
  model: string
  alias: string
}

interface FormState {
  name: string
  type: ChannelType
  base_url: string
  base_url_full: boolean
  models_url: string
  api_key: string
  models: string
  mapping: string
  aliases: AliasRow[]
  priority: number
  weight: number
  region: string
  timeout: string
  ua_override: boolean
  ua_value: string
  strip_headers: boolean
  single_role: boolean
  single_role_mode: SingleRoleMode
  merge_system: boolean
  exclude_last_user: boolean
}

const FULL_PLACEHOLDER: Record<Exclude<ChannelType, 'vertex'>, string> = {
  openai: 'https://example.com/api/paas/v4/chat/completions',
  anthropic: 'https://example.com/api/anthropic/messages',
  responses: 'https://example.com/openai/responses',
}

function baseUrlHint(f: FormState): string {
  if (f.type === 'vertex' || !f.base_url_full) return '自定义反代地址，会自动补 /v1 和接口路径；留空用官方默认'
  return '填写完整的请求地址，原样请求不做任何拼接；拉取模型与测试连接使用下方的模型列表地址'
}

function singleRoleHint(f: FormState): string {
  if (!f.single_role) return '上游只接受单一角色消息时开启：把对话历史按原顺序打包成 JSON 文本发送'
  if (f.single_role_mode === 'system')
    return f.exclude_last_user
      ? '最后一条 user 消息原样保留为唯一的 user 消息（工具结果不算），其余消息（含系统提示）按原顺序打包进系统提示（JSON 文本）'
      : '全部消息（含系统提示）按原顺序打包进系统提示（JSON 文本），随后跟一条内容为换行加零宽空格的 user 消息'
  return f.merge_system
    ? '系统提示放在最前，与其余消息一起按原顺序打包为一条 user 消息（JSON 文本），原系统提示置空'
    : '系统提示保持原样，其余消息按原顺序打包为一条 user 消息（JSON 文本）'
}

function initForm(c: Channel | null): FormState {
  if (!c)
    return {
      name: '', type: 'openai', base_url: '', base_url_full: false, models_url: '', api_key: '', models: '', mapping: '', aliases: [], priority: 0, weight: 1, region: '', timeout: '',
      ua_override: false, ua_value: '', strip_headers: false, single_role: false, single_role_mode: 'user', merge_system: false,
      exclude_last_user: false,
    }
  return {
    name: c.name,
    type: c.type,
    base_url: c.base_url || '',
    base_url_full: c.base_url_full,
    models_url: c.models_url || '',
    api_key: c.api_key,
    models: c.models.join('\n'),
    mapping: c.model_mapping ? Object.entries(c.model_mapping).map(([k, v]) => `${k}=${v}`).join('\n') : '',
    aliases: c.model_alias ? Object.entries(c.model_alias).map(([model, alias]) => ({ model, alias })) : [],
    priority: c.priority,
    weight: c.weight,
    region: c.region || '',
    timeout: c.timeout_ms ? String(c.timeout_ms) : '',
    ua_override: !!c.ua_override,
    ua_value: c.ua_value || '',
    strip_headers: !!c.strip_headers,
    single_role: !!c.single_role,
    single_role_mode: c.single_role || 'user',
    merge_system: !!c.single_role_merge_system,
    exclude_last_user: !!c.single_role_exclude_last_user,
  }
}

function buildPayload(f: FormState): Partial<Channel> {
  const models = f.models.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)
  const mapping: Record<string, string> = {}
  f.mapping.split('\n').forEach((line) => {
    const i = line.indexOf('=')
    if (i > 0) {
      const k = line.slice(0, i).trim()
      const v = line.slice(i + 1).trim()
      if (k && v) mapping[k] = v
    }
  })
  // 已从模型列表移除的模型，其专属名一并丢弃
  const aliases: Record<string, string> = {}
  for (const { model, alias } of f.aliases) {
    if (models.includes(model) && alias.trim()) aliases[model] = alias.trim()
  }
  return {
    name: f.name.trim(),
    type: f.type,
    base_url: f.base_url.trim() || null,
    base_url_full: f.type !== 'vertex' && f.base_url_full,
    models_url: f.type !== 'vertex' && f.base_url_full ? f.models_url.trim() || null : null,
    api_key: f.api_key.trim(),
    models,
    model_mapping: Object.keys(mapping).length ? mapping : null,
    model_alias: Object.keys(aliases).length ? aliases : null,
    priority: f.priority,
    weight: f.weight,
    region: f.type === 'vertex' ? f.region.trim() || null : null,
    timeout_ms: f.timeout ? Number(f.timeout) : null,
    ua_override: f.ua_override,
    ua_value: f.ua_override ? f.ua_value.trim() || null : null,
    strip_headers: f.strip_headers,
    single_role: f.single_role ? f.single_role_mode : null,
    single_role_merge_system: f.single_role && f.single_role_mode === 'user' && f.merge_system,
    single_role_exclude_last_user: f.single_role && f.single_role_mode === 'system' && f.exclude_last_user,
  }
}

export function ChannelModal({
  channel,
  onClose,
  onSaved,
}: {
  channel: Channel | null
  onClose: () => void
  onSaved: () => void
}) {
  const toast = useToast()
  const [f, setF] = useState<FormState>(() => initForm(channel))
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [fetchedModels, setFetchedModels] = useState<string[] | null>(null)
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }))

  const currentModels = (): Set<string> => new Set(f.models.split(/[,\n]/).map((s) => s.trim()).filter(Boolean))

  const listedModels = [...currentModels()]
  const freeModels = listedModels.filter((m) => !f.aliases.some((a) => a.model === m))
  const setAlias = (i: number, row: AliasRow): void => set('aliases', f.aliases.map((a, j) => (j === i ? row : a)))

  const addModel = (m: string): void => {
    const cur = currentModels()
    if (cur.has(m)) return
    set('models', [...cur, m].join('\n'))
  }

  const fetchModels = async (): Promise<void> => {
    setFetching(true)
    try {
      const r = await api.testChannel(buildPayload(f))
      if (r.models && r.models.length) {
        setFetchedModels(r.models)
      } else if (r.ok) {
        setFetchedModels(null)
        toast('info', '该渠道连通，但未返回模型列表，请手动填写')
      } else {
        setFetchedModels(null)
        toast('err', r.message)
      }
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setFetching(false)
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      const payload = buildPayload(f)
      if (channel) await api.updateChannel(channel.id, payload)
      else await api.createChannel(payload)
      toast('ok', channel ? '渠道已更新' : '渠道已创建')
      onSaved()
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    try {
      const r = await api.testChannel(buildPayload(f))
      toast(r.ok ? 'ok' : 'err', r.ok ? `连接成功 · ${r.latency_ms}ms` : r.message)
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setTesting(false)
    }
  }

  return (
    <Modal
      title={channel ? '编辑渠道' : '新增渠道'}
      onClose={onClose}
      dismissible={false}
      footer={
        <>
          <Button variant="ghost" icon={<IconTest size={17} />} loading={testing} onClick={test}>
            测试连接
          </Button>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={saving} onClick={save}>
            保存
          </Button>
        </>
      }
    >
      <Field label="渠道名称" required>
        <Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="例如：我的 GPT 主力" />
      </Field>

      <div className="ah-grid2">
        <Field label="渠道类型" required>
          <Dropdown
            value={f.type}
            options={[
              { value: 'openai', label: 'OpenAI 格式' },
              { value: 'anthropic', label: 'Anthropic 格式' },
              { value: 'vertex', label: 'Vertex AI' },
              { value: 'responses', label: 'OpenAI Responses' },
            ]}
            onChange={(v) => set('type', v as ChannelType)}
          />
        </Field>
        {f.type === 'vertex' && (
          <Field label="区域 Region" hint="留空 = global">
            <Input value={f.region} onChange={(e) => set('region', e.target.value)} placeholder="us-central1 / global" />
          </Field>
        )}
      </div>

      <Field label={f.type === 'vertex' ? 'API Key / JSON 凭证' : 'API Key'} hint={f.type === 'vertex' ? '粘贴 API Key 或服务账号 JSON 全文' : '可选 · 不鉴权的渠道可留空'}>
        {f.type === 'vertex' ? (
          <Textarea
            value={f.api_key}
            onChange={(e) => set('api_key', e.target.value)}
            placeholder="粘贴 API Key，或粘贴服务账号 JSON 全文（含 project_id、private_key、client_email）"
            rows={4}
            style={{ fontFamily: 'monospace', fontSize: 12 }}
          />
        ) : (
          <Input type="password" value={f.api_key} onChange={(e) => set('api_key', e.target.value)} placeholder="可留空（不鉴权渠道）" autoComplete="off" />
        )}
      </Field>

      <Field label="Base URL" hint={baseUrlHint(f)}>
        <Input
          value={f.base_url}
          onChange={(e) => set('base_url', e.target.value)}
          placeholder={f.type !== 'vertex' && f.base_url_full ? FULL_PLACEHOLDER[f.type] : PLACEHOLDER[f.type]}
        />
        {f.type !== 'vertex' && (
          <div className="ah-row" style={{ marginTop: 8 }}>
            <Toggle checked={f.base_url_full} onChange={(v) => set('base_url_full', v)} />
            <span className="ah-mini ah-muted">完整地址（不附加 /v1 与接口路径）</span>
          </div>
        )}
        {f.type !== 'vertex' && f.base_url_full && (
          <Input
            value={f.models_url}
            onChange={(e) => set('models_url', e.target.value)}
            placeholder="模型列表地址（可选）：留空时把结尾的接口路径换成 /models"
            style={{ marginTop: 8 }}
          />
        )}
      </Field>

      <Field label="渠道超时（毫秒）" hint="仅对本渠道生效；留空 = 跟随设置页的全局「请求超时」">
        <Input
          type="number"
          min={0}
          value={f.timeout}
          onChange={(e) => set('timeout', e.target.value)}
          placeholder="留空跟随全局"
        />
      </Field>

      <Field label="支持的模型" required hint="逗号或换行分隔，例如 gpt-4o, gpt-4o-mini">
        <Textarea value={f.models} onChange={(e) => set('models', e.target.value)} placeholder={'gpt-4o\ngpt-4o-mini'} rows={3} />
        <div className="ah-model-fetch">
          <Button size="sm" variant="soft" icon={<IconRefresh size={15} />} loading={fetching} onClick={fetchModels}>
            拉取模型
          </Button>
          <span className="ah-mini ah-faint">从上游 /models 拉取可用模型</span>
        </div>
        {fetchedModels && (
          <div className="ah-model-pick">
            {fetchedModels.map((m) => {
              const added = currentModels().has(m)
              return (
                <div className="ah-model-pick-item" key={m}>
                  <span className="ah-truncate">{m}</span>
                  <button
                    type="button"
                    className="ah-model-pick-add"
                    disabled={added}
                    onClick={() => addModel(m)}
                    title={added ? '已加入' : '加入模型列表'}
                  >
                    {added ? <IconCheck size={15} /> : <IconPlus size={15} />}
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </Field>

      <Field label="模型重映射" hint="可选 · 每行一条「别名=上游真实模型」">
        <Textarea value={f.mapping} onChange={(e) => set('mapping', e.target.value)} placeholder={'gpt-4=gpt-4o\nclaude=claude-3-7-sonnet'} rows={2} />
      </Field>

      <Field
        label="模型专属名"
        hint="可选 · 给列表中的模型换一个专属名：只有专属名会路由到本渠道，原名的请求不再分配到这里，适合把不稳定的渠道单独隔离出来按需调用"
      >
        {f.aliases.length > 0 && (
          <div className="ah-alias-list">
            {f.aliases.map((a, i) => (
              <div className="ah-alias-row" key={i}>
                <Select value={a.model} onChange={(e) => setAlias(i, { ...a, model: e.target.value })}>
                  {listedModels
                    .filter((m) => m === a.model || freeModels.includes(m))
                    .map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                </Select>
                <span className="ah-alias-arrow">→</span>
                <Input
                  value={a.alias}
                  onChange={(e) => setAlias(i, { ...a, alias: e.target.value })}
                  placeholder="专属名，例如 gpt-4o-backup"
                  spellCheck={false}
                />
                <IconButton title="删除专属名" danger onClick={() => set('aliases', f.aliases.filter((_, j) => j !== i))}>
                  <IconTrash size={14} />
                </IconButton>
              </div>
            ))}
          </div>
        )}
        <Button
          size="sm"
          variant="soft"
          icon={<IconPlus size={15} />}
          disabled={!freeModels.length}
          onClick={() => set('aliases', [...f.aliases, { model: freeModels[0], alias: '' }])}
        >
          添加专属名
        </Button>
      </Field>

      <Field
        label="UA 覆写"
        hint={f.ua_override ? '请求此渠道时，把客户端 User-Agent 覆写为下方自定义值' : '关闭时透传客户端原始 User-Agent'}
      >
        <div className="ah-row">
          <Toggle checked={f.ua_override} onChange={(v) => set('ua_override', v)} />
          <span className="ah-mini ah-muted">{f.ua_override ? '覆写为自定义 UA' : '透传客户端 UA'}</span>
        </div>
        {f.ua_override && (
          <Input
            value={f.ua_value}
            onChange={(e) => set('ua_value', e.target.value)}
            placeholder="例如 Mozilla/5.0 或 MyApp/1.0"
            autoComplete="off"
            style={{ marginTop: 8 }}
          />
        )}
      </Field>

      <Field
        label="去除非必要请求头"
        hint={
          f.strip_headers
            ? '无论同协议还是跨协议，请求上游时仅保留必要头（Content-Type 与鉴权头）'
            : '默认会透传客户端 UA、Anthropic 直通时还转发 anthropic-version / anthropic-beta'
        }
      >
        <div className="ah-row">
          <Toggle checked={f.strip_headers} onChange={(v) => set('strip_headers', v)} />
          <span className="ah-mini ah-muted">{f.strip_headers ? '仅保留必要请求头' : '透传/转发非必要头'}</span>
        </div>
      </Field>

      <Field label="单 role 渠道兼容" hint={singleRoleHint(f)}>
        <div className="ah-row">
          <Toggle checked={f.single_role} onChange={(v) => set('single_role', v)} />
          <span className="ah-mini ah-muted">{f.single_role ? '打包对话历史' : '保持原消息结构'}</span>
        </div>
        {f.single_role && (
          <div className="ah-pp-chips" style={{ marginTop: 8 }}>
            {(['user', 'system'] as const).map((mode) => (
              <button
                type="button"
                key={mode}
                className={`ah-pp-chip${f.single_role_mode === mode ? ' is-on' : ''}`}
                onClick={() => set('single_role_mode', mode)}
              >
                {mode === 'user' ? '使用 user 模式' : '使用 system 格式'}
              </button>
            ))}
          </div>
        )}
        {f.single_role && f.single_role_mode === 'user' && (
          <div className="ah-row" style={{ marginTop: 8 }}>
            <Toggle checked={f.merge_system} onChange={(v) => set('merge_system', v)} />
            <span className="ah-mini ah-muted">合并 system</span>
          </div>
        )}
        {f.single_role && f.single_role_mode === 'system' && (
          <div className="ah-row" style={{ marginTop: 8 }}>
            <Toggle checked={f.exclude_last_user} onChange={(v) => set('exclude_last_user', v)} />
            <span className="ah-mini ah-muted">最后 user 除外</span>
          </div>
        )}
      </Field>

      <div className="ah-grid2">
        <Field label="优先级" hint="越大越优先（主备梯队）">
          <Slider value={f.priority} min={0} max={100} onChange={(v) => set('priority', v)} />
        </Field>
        <Field label="权重" hint="同优先级内的流量配比">
          <Slider value={f.weight} min={0} max={100} onChange={(v) => set('weight', v)} />
        </Field>
      </div>
    </Modal>
  )
}
