import { useState } from 'react'
import { api } from '../api/client'
import { Button } from '../components/Button'
import { Field, Input } from '../components/Form'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'
import type { PoolSubscription, PoolSubscriptionInput } from '../types'

const UA_PRESETS = ['clash-verge/v2.5.2', 'Clash.Meta', 'mihomo', 'v2rayNG/1.8.5']

export function PoolSubscriptionModal({ sub, onClose, onSaved }: { sub: PoolSubscription | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast()
  const [form, setForm] = useState<PoolSubscriptionInput>(() => ({
    name: sub?.name ?? '',
    url: sub?.url ?? '',
    user_agent: sub?.user_agent ?? '',
    update_interval: sub?.update_interval ?? 360,
  }))
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof PoolSubscriptionInput>(key: K, value: PoolSubscriptionInput[K]) => setForm((f) => ({ ...f, [key]: value }))

  const submit = async () => {
    setSaving(true)
    try {
      if (sub) {
        await api.poolUpdateSubscription(sub.id, form)
        toast('ok', '订阅已保存')
      } else {
        await api.poolCreateSubscription(form)
        toast('ok', '订阅已添加，正在拉取节点')
      }
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
      title={sub ? '编辑订阅' : '新增订阅'}
      dismissible={false}
      onClose={onClose}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={saving} disabled={!form.name.trim() || !form.url.trim()} onClick={submit}>
            保存
          </Button>
        </>
      }
    >
      <Field label="名称" required>
        <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="我的机场" maxLength={64} />
      </Field>
      <Field label="订阅链接" required>
        <Input value={form.url} onChange={(e) => set('url', e.target.value)} placeholder="https://..." />
      </Field>
      <Field label="User-Agent" hint="留空使用浏览器 UA；拉取失败或拉到的内容没有节点时会依次换成 clash-verge、Clash.Meta、v2rayNG 再试">
        <Input value={form.user_agent} onChange={(e) => set('user_agent', e.target.value)} list="ah-pool-ua" placeholder="留空为浏览器 UA" />
        <datalist id="ah-pool-ua">
          {UA_PRESETS.map((ua) => (
            <option key={ua} value={ua} />
          ))}
        </datalist>
      </Field>
      <Field label="自动更新间隔（分钟）" hint="0 为仅手动更新；更新时整体替换该订阅的节点，已不在订阅里的节点会被删除">
        <Input
          type="number"
          min={0}
          max={10080}
          value={String(form.update_interval)}
          onChange={(e) => set('update_interval', Math.max(0, Math.round(Number(e.target.value) || 0)))}
        />
      </Field>
    </Modal>
  )
}
