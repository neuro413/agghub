import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { Button, IconButton } from '../components/Button'
import { Dropdown, Field, Input, Select, Slider, Textarea } from '../components/Form'
import { IconCheck, IconPlus, IconRefresh, IconTest, IconTrash } from '../components/Icons'
import { Modal } from '../components/Modal'
import { Toggle } from '../components/Toggle'
import { useToast } from '../components/Toast'
import { fmtBytes } from '../lib/format'
import type { Channel, ChannelKeyStatus, PoolMatch, ChannelType, CompressionTestItem, CompressionTestResult, CompressionUnsupported, KeyMode, RequestCompression, SingleRoleMode } from '../types'

const PLACEHOLDER: Record<ChannelType, string> = {
  openai: 'https://api.openai.com（留空用官方）',
  anthropic: 'https://api.anthropic.com（留空用官方）',
  vertex: '留空自动用 aiplatform.googleapis.com',
  responses: 'https://api.openai.com（留空用官方）',
  gemini: 'https://generativelanguage.googleapis.com（留空用官方）',
}

/** Vertex / Gemini 的请求地址随模型与流式动作变化，不支持完整地址模式 */
type FullUrlType = Exclude<ChannelType, 'vertex' | 'gemini'>
function supportsFullUrl(type: ChannelType): type is FullUrlType {
  return type !== 'vertex' && type !== 'gemini'
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
  multi_key: boolean
  key_mode: KeyMode
  key_concurrency: string
  key_cooldown: string
  /** '' = 跟随全局 */
  request_compression: '' | RequestCompression
  always_retry: boolean
  fake_stream: boolean
  proxy_pool: boolean
  proxy_pool_include: string
  proxy_pool_exclude: string
}

/** 多 key 模式下按行拆分并去重的 key 列表（与后端规则一致） */
function splitKeys(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map((k) => k.trim()).filter(Boolean))]
}

function keyModeHint(f: FormState): string {
  if (!f.multi_key) return '开启后 API Key 改为每行一个，在多个 key 之间轮询或并发请求；key 失效（熔断状态码、429、402）时自动熔断该 key'
  if (f.key_mode === 'poll')
    return '每次请求先用排在最前的可用 key；key 失效时熔断它并立即换下一个，不消耗同渠道重试次数。全部 key 熔断时选路自动跳过本渠道'
  return '每次请求轮流取 N 个可用 key 同时请求上游，最先产出内容（流式）或最先完整返回（非流式）的结果转发给客户端，其余请求立即中断；上游实际被调用 N 次，落选请求也可能计费'
}

const FULL_PLACEHOLDER: Record<FullUrlType, string> = {
  openai: 'https://example.com/api/paas/v4/chat/completions',
  anthropic: 'https://example.com/api/anthropic/messages',
  responses: 'https://example.com/openai/responses',
}

function baseUrlHint(f: FormState): string {
  if (f.type === 'gemini') return '自定义反代地址，未以 /v1、/v1beta 结尾时自动补 /v1beta 和接口路径；留空用官方默认'
  if (!supportsFullUrl(f.type) || !f.base_url_full) return '自定义反代地址，会自动补 /v1 和接口路径；留空用官方默认'
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
      exclude_last_user: false, multi_key: false, key_mode: 'poll', key_concurrency: '2', key_cooldown: '300', request_compression: '', always_retry: false, fake_stream: false,
      proxy_pool: false, proxy_pool_include: '', proxy_pool_exclude: '',
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
    multi_key: !!c.key_mode,
    key_mode: c.key_mode || 'poll',
    key_concurrency: String(c.key_concurrency ?? 2),
    key_cooldown: String(c.key_cooldown_seconds ?? 300),
    request_compression: c.request_compression ?? '',
    always_retry: !!c.always_retry,
    fake_stream: !!c.fake_stream,
    proxy_pool: !!c.proxy_pool,
    proxy_pool_include: c.proxy_pool_include || '',
    proxy_pool_exclude: c.proxy_pool_exclude || '',
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
  const multiKey = f.type !== 'vertex' && f.multi_key
  return {
    name: f.name.trim(),
    type: f.type,
    base_url: f.base_url.trim() || null,
    base_url_full: supportsFullUrl(f.type) && f.base_url_full,
    models_url: supportsFullUrl(f.type) && f.base_url_full ? f.models_url.trim() || null : null,
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
    key_mode: multiKey ? f.key_mode : null,
    key_concurrency: Number(f.key_concurrency) || 2,
    key_cooldown_seconds: Number(f.key_cooldown) || 300,
    request_compression: f.request_compression || null,
    always_retry: f.always_retry,
    fake_stream: f.fake_stream,
    proxy_pool: f.proxy_pool,
    proxy_pool_include: f.proxy_pool_include.trim() || null,
    proxy_pool_exclude: f.proxy_pool_exclude.trim() || null,
  }
}

function keyStateTag(k: ChannelKeyStatus): { cls: string; text: string } {
  if (k.state === 'ok') return { cls: 'ah-tag-ok', text: '正常' }
  if (k.state === 'banned') return { cls: 'ah-tag-err', text: '已熔断' }
  const until = new Date(k.until!).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return { cls: 'ah-tag-warn', text: `冷却至 ${until}` }
}

/** 渠道的代理池开关与节点关键词；关键词变化后防抖查询匹配节点数 */
function PoolField({
  enabled,
  include,
  exclude,
  onChange,
}: {
  enabled: boolean
  include: string
  exclude: string
  onChange: (patch: Partial<Pick<FormState, 'proxy_pool' | 'proxy_pool_include' | 'proxy_pool_exclude'>>) => void
}) {
  const [match, setMatch] = useState<PoolMatch | null>(null)
  useEffect(() => {
    if (!enabled) return
    const ac = new AbortController()
    const timer = setTimeout(() => {
      api.poolMatch(include, exclude, ac.signal).then(setMatch).catch(() => {})
    }, 400)
    return () => {
      clearTimeout(timer)
      ac.abort()
    }
  }, [enabled, include, exclude])

  return (
    <Field
      label="启用代理池"
      hint={
        enabled
          ? `关键词逗号分隔，命中任一即可，不区分大小写。节点网络错误或上游返回 429/403 时冷却该节点并换下一个，单次尝试最多换 ${match?.node_retry_times ?? 3} 个（在代理池设置里修改）；池中没有可用节点时本次尝试失败并换渠道`
          : '开启后该渠道的上游请求经内置 mihomo 代理池的节点发出，全局代理对该渠道不再生效'
      }
    >
      <div className="ah-row">
        <Toggle checked={enabled} onChange={(v) => onChange({ proxy_pool: v })} />
        <span className="ah-mini ah-muted">{enabled ? '经代理池节点请求上游' : '使用全局代理设置'}</span>
      </div>
      {enabled && (
        <>
          <div className="ah-grid2" style={{ marginTop: 8 }}>
            <Input value={include} onChange={(e) => onChange({ proxy_pool_include: e.target.value })} placeholder="包含关键词，如 美国, US, 日本" />
            <Input value={exclude} onChange={(e) => onChange({ proxy_pool_exclude: e.target.value })} placeholder="排除关键词，如 香港, 0.1x" />
          </div>
          {match && (
            <div className={`ah-mini ${match.running ? 'ah-muted' : 'ah-pool-warn'}`} style={{ marginTop: 6 }}>
              {match.running
                ? `匹配 ${match.matched} 个启用节点，当前可用 ${match.available} 个`
                : `代理池内核未运行（匹配 ${match.matched} 个启用节点），请到「代理池」页启动`}
            </div>
          )}
        </>
      )}
    </Field>
  )
}

/** 已保存渠道的 key 熔断状态，可逐个或全部手动重置 */
function KeyStatusList({ channelId }: { channelId: number }) {
  const toast = useToast()
  const [keys, setKeys] = useState<ChannelKeyStatus[] | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.channelKeys(channelId).then(setKeys).catch((e) => toast('err', e.message))
  }, [channelId, toast])

  const reset = async (fingerprint?: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      setKeys(await api.resetChannelKeys(channelId, fingerprint))
      toast('ok', fingerprint ? '已重置该 key' : '已重置全部 key')
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setBusy(false)
    }
  }

  if (!keys?.length) return null
  const broken = keys.filter((k) => k.state !== 'ok').length
  return (
    <div style={{ marginTop: 10 }}>
      <div className="ah-row">
        <span className="ah-mini ah-muted">
          已保存的 key：可用 <b className="ah-num">{keys.length - broken}</b>/{keys.length}
        </span>
        <span style={{ flex: 1 }} />
        {broken > 0 && (
          <Button size="sm" variant="soft" icon={<IconRefresh size={15} />} loading={busy} onClick={() => reset()}>
            全部重置
          </Button>
        )}
      </div>
      <div className="ah-key-list">
        {keys.map((k) => {
          const tag = keyStateTag(k)
          return (
            <div className="ah-key-row" key={k.fingerprint}>
              <span className="ah-mini ah-faint ah-num">#{k.index + 1}</span>
              <span className="ah-key-mask">{k.masked}</span>
              <span className={`ah-tag ${tag.cls}`}>{tag.text}</span>
              <span className="ah-mini ah-faint ah-truncate ah-key-msg" title={k.message || undefined}>
                {k.message ? `${k.status_code ?? ''} ${k.message}` : ''}
              </span>
              {k.state !== 'ok' && (
                <IconButton title="重置该 key" onClick={() => reset(k.fingerprint)}>
                  <IconRefresh size={14} />
                </IconButton>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const VERDICT_TEXT: Record<CompressionTestItem['verdict'], string> = { ok: '✅ 支持', rejected: '❌ 拒绝', error: '⚠️ 其他错误', skipped: '跳过' }

function unsupportedText(u: CompressionUnsupported): string {
  if (u.until === null) return `已判定不支持 ${u.algorithm}，直到重启`
  return `已判定不支持 ${u.algorithm}，剩余 ${Math.max(0.1, (u.until - Date.now()) / 3_600_000).toFixed(1)} 小时`
}

/** 请求体压缩：渠道算法、压缩测试（未保存的配置也能测）与已保存渠道的「不支持」记忆 */
function CompressionField({
  value,
  onChange,
  models,
  payload,
  channel,
  onCleared,
}: {
  value: FormState['request_compression']
  onChange: (v: FormState['request_compression']) => void
  models: string[]
  payload: () => Partial<Channel>
  channel: Channel | null
  onCleared?: () => void
}) {
  const toast = useToast()
  const [model, setModel] = useState('')
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<CompressionTestResult | null>(null)
  const [unsupported, setUnsupported] = useState<CompressionUnsupported[]>(channel?.compression_unsupported ?? [])
  const [clearing, setClearing] = useState(false)
  const testModel = models.includes(model) ? model : models[0] ?? ''

  const runTest = async (): Promise<void> => {
    setTesting(true)
    try {
      setResult(await api.testChannelCompression({ ...payload(), test_model: testModel }))
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setTesting(false)
    }
  }

  const clear = async (): Promise<void> => {
    if (!channel) return
    setClearing(true)
    try {
      setUnsupported((await api.resetChannelCompression(channel.id)).unsupported)
      toast('ok', '已清除压缩回退记忆')
      onCleared?.()
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setClearing(false)
    }
  }

  return (
    <Field label="请求体压缩" hint="压缩发往上游的请求体，需在设置页打开总开关才生效；压缩测试使用设置页的级别与窗口，结果为 ✅ 的算法才能放心使用">
      <Select value={value} onChange={(e) => onChange(e.target.value as FormState['request_compression'])}>
        <option value="">跟随全局</option>
        <option value="off">关闭</option>
        <option value="gzip">gzip</option>
        <option value="br">br</option>
        <option value="zstd">zstd</option>
      </Select>
      {unsupported.length > 0 && (
        <div className="ah-row" style={{ marginTop: 8 }}>
          <span className="ah-mini" style={{ color: 'var(--warn)' }}>{unsupported.map(unsupportedText).join('；')}</span>
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="soft" icon={<IconRefresh size={15} />} loading={clearing} onClick={clear}>
            清除
          </Button>
        </div>
      )}
      <div className="ah-model-fetch">
        <div style={{ flex: 1, minWidth: 0 }}>
          <Select aria-label="测试模型" value={testModel} disabled={!models.length} onChange={(e) => setModel(e.target.value)}>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </div>
        <Button size="sm" variant="soft" icon={<IconTest size={15} />} loading={testing} disabled={!testModel} onClick={runTest}>
          压缩测试
        </Button>
      </div>
      <div className="ah-mini ah-faint" style={{ marginTop: 6 }}>会发送 4 个最小请求，约消耗几十 token</div>
      {result && (
        <table className="ah-htable ah-ctest">
          <thead>
            <tr>
              <th>算法</th>
              <th>HTTP</th>
              <th>耗时</th>
              <th>原始 → 发送</th>
              <th>结论</th>
              <th>错误摘要</th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((item) => (
              <tr key={item.algorithm}>
                <td className="ah-num">{item.label}</td>
                <td className="ah-num">{item.status ?? '—'}</td>
                <td className="ah-num">{item.verdict === 'skipped' ? '—' : `${item.latency_ms}ms`}</td>
                <td className="ah-num">
                  {item.verdict === 'skipped' ? '—' : item.algorithm === 'plain' ? fmtBytes(item.raw_bytes) : `${fmtBytes(item.raw_bytes)} → ${fmtBytes(item.sent_bytes)}`}
                </td>
                <td>{VERDICT_TEXT[item.verdict]}</td>
                <td className="ah-mini ah-faint">{item.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Field>
  )
}

export function ChannelModal({
  channel,
  onClose,
  onSaved,
  onChanged,
}: {
  channel: Channel | null
  onClose: () => void
  onSaved: () => void
  /** 不关闭弹窗、但渠道列表需要刷新时调用（如清除压缩回退记忆） */
  onChanged?: () => void
}) {
  const toast = useToast()
  const [f, setF] = useState<FormState>(() => initForm(channel))
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [fetchedModels, setFetchedModels] = useState<string[] | null>(null)
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }))

  const keyCount = splitKeys(f.api_key).length
  const apiKeyHint =
    f.type === 'vertex'
      ? '粘贴 API Key 或服务账号 JSON 全文'
      : f.multi_key
        ? '每行一个 key，重复的自动去除；测试连接与拉取模型使用第一个 key'
        : '可选 · 不鉴权的渠道可留空'

  // 关闭多 key 模式只保留第一个 key：单行密码框无法承载多行内容
  const toggleMultiKey = (on: boolean): void => {
    if (on) return set('multi_key', true)
    const keys = splitKeys(f.api_key)
    if (keys.length > 1 && !window.confirm(`关闭多 key 模式只会保留第一个 key（共 ${keys.length} 个），确定吗？`)) return
    setF((s) => ({ ...s, multi_key: false, api_key: keys[0] ?? '' }))
  }

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
              { value: 'gemini', label: 'Gemini（AI Studio）' },
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

      <Field label={f.type === 'vertex' ? 'API Key / JSON 凭证' : 'API Key'} hint={apiKeyHint}>
        {f.type === 'vertex' ? (
          <Textarea
            value={f.api_key}
            onChange={(e) => set('api_key', e.target.value)}
            placeholder="粘贴 API Key，或粘贴服务账号 JSON 全文（含 project_id、private_key、client_email）"
            rows={4}
            style={{ fontFamily: 'monospace', fontSize: 12 }}
          />
        ) : f.multi_key ? (
          <Textarea
            value={f.api_key}
            onChange={(e) => set('api_key', e.target.value)}
            placeholder={'每行一个 key\nsk-aaa…\nsk-bbb…'}
            rows={5}
            spellCheck={false}
            style={{ fontFamily: 'monospace', fontSize: 12 }}
          />
        ) : (
          <Input type="password" value={f.api_key} onChange={(e) => set('api_key', e.target.value)} placeholder="可留空（不鉴权渠道）" autoComplete="off" />
        )}
      </Field>

      {f.type !== 'vertex' && (
        <Field label="多 key 模式" hint={keyModeHint(f)}>
          <div className="ah-row">
            <Toggle checked={f.multi_key} onChange={toggleMultiKey} />
            <span className="ah-mini ah-muted">{f.multi_key ? `已识别 ${keyCount} 个 key` : '单个 key'}</span>
          </div>
          {f.multi_key && (
            <div className="ah-pp-chips" style={{ marginTop: 8 }}>
              {(['poll', 'race'] as const).map((mode) => (
                <button
                  type="button"
                  key={mode}
                  className={`ah-pp-chip${f.key_mode === mode ? ' is-on' : ''}`}
                  onClick={() => set('key_mode', mode)}
                >
                  {mode === 'poll' ? '多 key 轮询' : '多 key 并发'}
                </button>
              ))}
            </div>
          )}
          {f.multi_key && (
            <div className="ah-grid2" style={{ marginTop: 8 }}>
              {f.key_mode === 'race' && (
                <Field label="并发 key 数" hint="2~20；可用 key 不足时按实际数量">
                  <Input type="number" min={2} max={20} value={f.key_concurrency} onChange={(e) => set('key_concurrency', e.target.value)} />
                </Field>
              )}
              <Field label="限流冷却（秒）" hint="429/402 时冷却该 key；上游带 Retry-After 时以它为准">
                <Input type="number" min={1} value={f.key_cooldown} onChange={(e) => set('key_cooldown', e.target.value)} />
              </Field>
            </div>
          )}
          {f.multi_key && channel?.key_mode && <KeyStatusList channelId={channel.id} />}
        </Field>
      )}

      <Field label="Base URL" hint={baseUrlHint(f)}>
        <Input
          value={f.base_url}
          onChange={(e) => set('base_url', e.target.value)}
          placeholder={supportsFullUrl(f.type) && f.base_url_full ? FULL_PLACEHOLDER[f.type] : PLACEHOLDER[f.type]}
        />
        {supportsFullUrl(f.type) && (
          <div className="ah-row" style={{ marginTop: 8 }}>
            <Toggle checked={f.base_url_full} onChange={(v) => set('base_url_full', v)} />
            <span className="ah-mini ah-muted">完整地址（不附加 /v1 与接口路径）</span>
          </div>
        )}
        {supportsFullUrl(f.type) && f.base_url_full && (
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

      <Field
        label="一律重试"
        hint={
          f.always_retry
            ? '上游返回任何 HTTP 错误（含 401、403）都在本渠道重试，次数跟随设置页「单渠道重试次数」，用完才换渠道；本渠道命中熔断状态码时不再自动停用，多 key 模式下也不熔断 key（429/402 冷却照常）。适合把限流返回成 403 的上游'
            : '关闭时 401、403 等错误不在本渠道重试，直接换渠道；命中熔断状态码时按全局设置自动停用渠道'
        }
      >
        <div className="ah-row">
          <Toggle checked={f.always_retry} onChange={(v) => set('always_retry', v)} />
          <span className="ah-mini ah-muted">{f.always_retry ? '任何上游错误都在本渠道重试' : '仅瞬时错误在本渠道重试'}</span>
        </div>
      </Field>

      <Field
        label="假流式"
        hint={
          f.fake_stream
            ? '客户端流式请求本渠道时改用非流式请求上游，等待期间每 20 秒向客户端发送一个 SSE 空帧防止超时，拿到完整响应后一次性按流式格式下发。适合流式不稳定或不支持流式的上游；渠道超时此时按「等到完整响应」计算'
            : '关闭时按客户端的请求方式原样流式 / 非流式请求上游'
        }
      >
        <div className="ah-row">
          <Toggle checked={f.fake_stream} onChange={(v) => set('fake_stream', v)} />
          <span className="ah-mini ah-muted">{f.fake_stream ? '流式请求以非流式发往上游' : '关闭'}</span>
        </div>
      </Field>

      <PoolField
        enabled={f.proxy_pool}
        include={f.proxy_pool_include}
        exclude={f.proxy_pool_exclude}
        onChange={(patch) => setF((prev) => ({ ...prev, ...patch }))}
      />

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

      <CompressionField
        value={f.request_compression}
        onChange={(v) => set('request_compression', v)}
        models={listedModels}
        payload={() => buildPayload(f)}
        channel={channel}
        onCleared={onChanged}
      />

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
