import { useMemo, useState } from 'react'
import { api } from '../api/client'
import { Button } from '../components/Button'
import { Field, Input, Textarea } from '../components/Form'
import { IconSearch } from '../components/Icons'
import { Modal } from '../components/Modal'
import { Toggle } from '../components/Toggle'
import { useToast } from '../components/Toast'
import { channelModelNames } from '../lib/channelModels'
import type { Channel, ChannelGroup } from '../types'

interface FormState {
  name: string
  description: string
  ratio: string
  sort: string
  isPublic: boolean
  channelIds: number[]
  models: string[]
  uaBlacklist: string[]
  uaBlockMessage: string
}

function initForm(g: ChannelGroup | null): FormState {
  if (!g) return { name: '', description: '', ratio: '1', sort: '0', isPublic: false, channelIds: [], models: [], uaBlacklist: [], uaBlockMessage: '' }
  return {
    name: g.name,
    description: g.description,
    ratio: String(g.ratio),
    sort: String(g.sort),
    isPublic: g.is_public,
    channelIds: g.channel_ids,
    models: g.models,
    uaBlacklist: g.ua_blacklist ?? [],
    uaBlockMessage: g.ua_block_message ?? '',
  }
}

const toggleIn = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

export function GroupModal({
  group,
  channels,
  onClose,
  onSaved,
}: {
  group: ChannelGroup | null
  channels: Channel[]
  onClose: () => void
  onSaved: () => void
}) {
  const toast = useToast()
  const [f, setF] = useState<FormState>(() => initForm(group))
  const [q, setQ] = useState('')
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((p) => ({ ...p, [k]: v }))

  // 可选模型 = 已勾选渠道对外的模型名并集
  const options = useMemo(() => {
    const names = new Set<string>()
    for (const c of channels) if (f.channelIds.includes(c.id)) for (const m of channelModelNames(c)) names.add(m)
    return [...names].sort()
  }, [channels, f.channelIds])
  const invalid = f.models.filter((m) => !options.includes(m))
  const keyword = q.trim().toLowerCase()
  const shown = keyword ? options.filter((m) => m.toLowerCase().includes(keyword)) : options

  const validate = (): string | null => {
    const name = f.name.trim()
    if (!name || name.length > 32 || name.includes(',')) return '分组名须为 1～32 字符且不含逗号'
    const ratio = Number(f.ratio)
    if (f.ratio.trim() === '' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1000) return '分组倍率须为 0～1000 的数字'
    if (!/^-?\d+$/.test(f.sort.trim())) return '排序须为整数'
    return null
  }

  const save = async () => {
    const err = validate()
    if (err) return toast('err', err)
    const data = {
      name: f.name.trim(),
      description: f.description.trim(),
      ratio: Number(f.ratio),
      sort: Number(f.sort),
      is_public: f.isPublic,
      channel_ids: f.channelIds,
      models: f.models,
      ua_blacklist: f.uaBlacklist,
      ua_block_message: f.uaBlockMessage.trim(),
    }
    setSaving(true)
    try {
      if (group) await api.updateGroup(group.name, data)
      else await api.createGroup(data)
      toast('ok', group ? '分组已保存' : '分组已创建')
      onSaved()
      onClose()
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={group ? `编辑分组「${group.name}」` : '新建分组'}
      onClose={onClose}
      size="lg"
      dismissible={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={saving} onClick={save}>
            保存
          </Button>
        </>
      }
    >
      <div className="ah-grid2">
        <Field label="分组名" required hint={group ? '改名会同步更新引用它的用户和 Key' : '用户和 Key 按名称引用分组'}>
          <Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="例如：vip" maxLength={32} />
        </Field>
        <Field label="分组倍率" required hint="扣费 = 模型倍率算出的点数 × 分组倍率">
          <Input type="number" min={0} step={0.01} value={f.ratio} onChange={(e) => set('ratio', e.target.value)} />
        </Field>
      </div>

      <Field label="描述" hint="门户用户选择分组时显示">
        <Textarea value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="例如：稳定线路，价格略高" rows={2} />
      </Field>

      <Field
        label={`UA 黑名单${f.uaBlacklist.length ? `（已设 ${f.uaBlacklist.length} 个）` : ''}`}
        hint="对客户端 User-Agent 做不区分大小写的关键词包含匹配，命中即拒绝本分组的调用；每行一个，留空不启用。内网 owner 调用与可用性测活不受限制"
      >
        <Textarea
          value={f.uaBlacklist.join('\n')}
          onChange={(e) => set('uaBlacklist', e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))}
          placeholder={'每行一个关键词，例如：\nSillyTavern\ncurl'}
          rows={3}
        />
      </Field>

      {f.uaBlacklist.length > 0 && (
        <Field label="拦截提示" hint="命中黑名单时返回给客户端的错误信息；留空使用默认的「不支持的客户端」">
          <Input value={f.uaBlockMessage} onChange={(e) => set('uaBlockMessage', e.target.value)} placeholder="不支持的客户端" maxLength={500} />
        </Field>
      )}

      <div className="ah-grid2">
        <Field label="公开分组" hint="公开分组所有门户用户都能选；非公开分组需要在用户页分配">
          <div className="ah-row">
            <Toggle checked={f.isPublic} onChange={(v) => set('isPublic', v)} />
            <span className="ah-mini ah-muted">{f.isPublic ? '所有用户可用' : '仅分配的用户可用'}</span>
          </div>
        </Field>
        <Field label="排序" hint="越小越靠前，也是门户里的显示顺序">
          <Input type="number" step={1} value={f.sort} onChange={(e) => set('sort', e.target.value)} />
        </Field>
      </div>

      <Field label={`允许的渠道（已选 ${f.channelIds.length} / ${channels.length}）`} hint="只有勾选的渠道会为本组请求服务；之后新增的渠道需要回来勾选">
        <div className="ah-group-tools">
          <button type="button" className="ah-btn is-ghost is-sm" onClick={() => set('channelIds', channels.map((c) => c.id))}>全选</button>
          <button type="button" className="ah-btn is-ghost is-sm" onClick={() => set('channelIds', [])}>清空</button>
        </div>
        {channels.length ? (
          <div className="ah-pp-chips ah-group-pick">
            {channels.map((c) => (
              <button
                type="button"
                key={c.id}
                className={`ah-pp-chip${f.channelIds.includes(c.id) ? ' is-on' : ''}`}
                onClick={() => set('channelIds', toggleIn(f.channelIds, c.id))}
              >
                {c.name}
                {c.status !== 1 && '（已停用）'}
              </button>
            ))}
          </div>
        ) : (
          <span className="ah-mini ah-faint">还没有渠道</span>
        )}
      </Field>

      <Field label={`允许的模型（已选 ${f.models.length - invalid.length} / ${options.length}）`} hint="选项为已勾选渠道对外的模型名（含专属名和重映射别名）；未勾选的模型本组不能调用">
        <div className="ah-group-tools">
          <div className="ah-search">
            <IconSearch size={15} />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="筛选模型" />
          </div>
          <button type="button" className="ah-btn is-ghost is-sm" onClick={() => set('models', [...new Set([...f.models, ...shown])])}>
            {keyword ? '全选筛选结果' : '全选'}
          </button>
          <button type="button" className="ah-btn is-ghost is-sm" onClick={() => set('models', f.models.filter((m) => !shown.includes(m)))}>
            {keyword ? '取消筛选结果' : '清空'}
          </button>
          {invalid.length > 0 && (
            <button type="button" className="ah-btn is-ghost is-sm" onClick={() => set('models', f.models.filter((m) => options.includes(m)))}>
              移除失效（{invalid.length}）
            </button>
          )}
        </div>
        {options.length || invalid.length ? (
          <div className="ah-pp-chips ah-group-pick">
            {shown.map((m) => (
              <button
                type="button"
                key={m}
                className={`ah-pp-chip${f.models.includes(m) ? ' is-on' : ''}`}
                onClick={() => set('models', toggleIn(f.models, m))}
              >
                {m}
              </button>
            ))}
            {invalid.map((m) => (
              <button type="button" key={m} className="ah-pp-chip is-on is-invalid" title="已勾选渠道中没有这个模型，点击移除" onClick={() => set('models', toggleIn(f.models, m))}>
                {m}（已失效，可移除）
              </button>
            ))}
            {keyword && !shown.length && <span className="ah-mini ah-faint">没有匹配的模型</span>}
          </div>
        ) : (
          <span className="ah-mini ah-faint">先勾选渠道</span>
        )}
      </Field>
    </Modal>
  )
}
