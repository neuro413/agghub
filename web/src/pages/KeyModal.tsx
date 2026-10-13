import { useState } from 'react'
import { api } from '../api/client'
import { Button, IconButton } from '../components/Button'
import { Dropdown, Field, Input, Textarea } from '../components/Form'
import { IconCopy } from '../components/Icons'
import { Modal } from '../components/Modal'
import { Toggle } from '../components/Toggle'
import { useToast } from '../components/Toast'
import { copyText } from '../lib/clipboard'
import type { ApiKeyInput, ApiKeyView } from '../types'
import { MultiChips } from './preprocessShared'

interface FormState {
  name: string
  enabled: boolean
  groups: string[]
  models: string
  rpm: string
  concurrency: string
  quotaTotal: string
  quotaDaily: string
  expires: string
  logBodies: string
  note: string
}

/** 毫秒时间戳 → datetime-local 用的本地时间字符串（不要用 toISOString，会算成 UTC） */
function toLocalInput(ts: number): string {
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

function initForm(k: ApiKeyView | null, groups: string[]): FormState {
  if (!k)
    return {
      name: '',
      enabled: true,
      groups: groups.includes('public') ? ['public'] : [],
      models: '',
      rpm: '',
      concurrency: '',
      quotaTotal: '',
      quotaDaily: '',
      expires: '',
      logBodies: '',
      note: '',
    }
  return {
    name: k.name,
    enabled: k.enabled,
    groups: k.groups,
    models: k.models.join('\n'),
    rpm: k.rpm != null ? String(k.rpm) : '',
    concurrency: k.concurrency != null ? String(k.concurrency) : '',
    quotaTotal: k.quota_total != null ? String(k.quota_total) : '',
    quotaDaily: k.quota_daily != null ? String(k.quota_daily) : '',
    expires: k.expires_at != null ? toLocalInput(k.expires_at) : '',
    logBodies: k.log_bodies == null ? '' : k.log_bodies ? 'true' : 'false',
    note: k.note ?? '',
  }
}

const isNonNegInt = (v: string) => /^\d+$/.test(v.trim())

export function KeyModal({
  keyItem,
  groups,
  onClose,
  onSaved,
}: {
  keyItem: ApiKeyView | null
  groups: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const toast = useToast()
  const [f, setF] = useState<FormState>(() => initForm(keyItem, groups))
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }))

  const copyKey = async () => {
    if (!keyItem) return
    if (await copyText(keyItem.key)) toast('ok', 'Key 已复制')
    else toast('err', '复制失败，请手动复制')
  }

  const validate = (): string | null => {
    if (!f.name.trim()) return '请填写名称'
    if (!f.groups.length) return '至少要选择一个分组'
    for (const [label, v] of [
      ['RPM', f.rpm],
      ['并发上限', f.concurrency],
      ['总额度', f.quotaTotal],
      ['每日额度', f.quotaDaily],
    ] as const) {
      if (v.trim() === '') continue
      if (!isNonNegInt(v)) return `${label}必须是不小于 0 的整数`
    }
    if (f.rpm.trim() !== '' && Number(f.rpm) < 1) return 'RPM 若填写必须 ≥ 1'
    if (f.concurrency.trim() !== '' && Number(f.concurrency) < 1) return '并发上限若填写必须 ≥ 1'
    return null
  }

  const save = async () => {
    const err = validate()
    if (err) {
      toast('err', err)
      return
    }
    const parseOptInt = (v: string): number | null => (v.trim() === '' ? null : parseInt(v, 10))
    const input: ApiKeyInput = {
      name: f.name.trim(),
      enabled: f.enabled,
      groups: f.groups,
      models: f.models.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
      rpm: parseOptInt(f.rpm),
      concurrency: parseOptInt(f.concurrency),
      quota_total: parseOptInt(f.quotaTotal),
      quota_daily: parseOptInt(f.quotaDaily),
      log_bodies: f.logBodies === '' ? null : f.logBodies === 'true',
      expires_at: f.expires ? new Date(f.expires).getTime() : null,
      note: f.note.trim() || null,
    }
    setSaving(true)
    try {
      if (keyItem) {
        await api.updateKey(keyItem.id, input)
        toast('ok', '已保存')
      } else {
        const created = await api.createKey(input)
        if (await copyText(created.key)) toast('ok', 'Key 已创建并复制')
        else toast('ok', 'Key 已创建')
      }
      onSaved()
      onClose()
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setSaving(false)
    }
  }

  const groupOptions = groups.map((g) => ({ value: g, label: g }))

  return (
    <Modal
      title={keyItem ? '编辑 Key' : '新建 Key'}
      onClose={onClose}
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
      {keyItem && (
        <Field label="Key">
          <div className="ah-row">
            <Input value={keyItem.key} readOnly style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }} onFocus={(e) => e.target.select()} />
            <IconButton title="复制" onClick={copyKey}>
              <IconCopy size={17} />
            </IconButton>
          </div>
        </Field>
      )}

      <Field label="名称" required>
        <Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="例如：给朋友的 Key" />
      </Field>

      <Field label="启用">
        <div className="ah-row">
          <Toggle checked={f.enabled} onChange={(v) => set('enabled', v)} />
          <span className="ah-mini ah-muted">{f.enabled ? '启用中' : '已停用'}</span>
        </div>
      </Field>

      <Field label="可用分组" required hint="Key 只能使用这些分组里的渠道。分组在渠道编辑里设置">
        <MultiChips options={groupOptions} selected={f.groups} onChange={(v) => set('groups', v)} empty="暂无分组（请先在渠道里配置分组）" />
      </Field>

      <Field label="模型白名单" hint="每行一个或逗号分隔，支持 * 通配符；留空 = 不限">
        <Textarea value={f.models} onChange={(e) => set('models', e.target.value)} placeholder={'claude-opus-*\ngpt-4o'} rows={3} />
      </Field>

      <div className="ah-grid2">
        <Field label="RPM（每分钟请求）" hint="留空 = 不限">
          <Input type="number" min={1} value={f.rpm} onChange={(e) => set('rpm', e.target.value)} placeholder="留空不限" />
        </Field>
        <Field label="并发上限" hint="留空 = 不限">
          <Input type="number" min={1} value={f.concurrency} onChange={(e) => set('concurrency', e.target.value)} placeholder="留空不限" />
        </Field>
      </div>

      <div className="ah-grid2">
        <Field label="总额度（点）" hint="留空 = 不限">
          <Input type="number" min={0} value={f.quotaTotal} onChange={(e) => set('quotaTotal', e.target.value)} placeholder="留空不限" />
        </Field>
        <Field label="每日额度（点）" hint="服务器本地时间 0 点重置；留空 = 不限">
          <Input type="number" min={0} value={f.quotaDaily} onChange={(e) => set('quotaDaily', e.target.value)} placeholder="留空不限" />
        </Field>
      </div>

      <Field label="过期时间" hint="留空 = 永不过期">
        <Input type="datetime-local" value={f.expires} onChange={(e) => set('expires', e.target.value)} />
      </Field>

      <Field label="正文记录" hint="覆盖全局的正文存储开关；跟随全局 = 用设置页的配置">
        <Dropdown
          value={f.logBodies}
          onChange={(v) => set('logBodies', v)}
          options={[
            { value: '', label: '跟随全局' },
            { value: 'true', label: '记录正文' },
            { value: 'false', label: '不记录正文' },
          ]}
        />
      </Field>

      <Field label="备注">
        <Textarea value={f.note} onChange={(e) => set('note', e.target.value)} placeholder="可选" rows={2} />
      </Field>
    </Modal>
  )
}
