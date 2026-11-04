import { useState } from 'react'
import { api } from '../api/client'
import { Button } from '../components/Button'
import { Field, Textarea } from '../components/Form'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'

export function PoolImportModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const toast = useToast()
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<string[]>([])

  const submit = async () => {
    setSaving(true)
    try {
      const r = await api.poolImport(text)
      onImported()
      if (!r.total) {
        setErrors(r.errors)
        toast('err', '没有识别出可用节点')
        return
      }
      toast('ok', `新增 ${r.added} 个 · 更新 ${r.updated} 个`)
      if (r.errors.length) setErrors(r.errors)
      else onClose()
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="导入节点"
      size="lg"
      dismissible={!text.trim()}
      onClose={onClose}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <Button onClick={onClose}>关闭</Button>
          <Button variant="primary" loading={saving} disabled={!text.trim()} onClick={submit}>
            导入
          </Button>
        </>
      }
    >
      <Field
        label="节点内容"
        hint="支持：节点链接（每行一个，vless / vmess / trojan / ss / ssr / hysteria2 / tuic / anytls / socks5 / http）、base64 订阅内容、Clash YAML（含 proxies:）、SIP008 JSON。与已有节点配置相同的会合并，不会重复"
      >
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={14}
          placeholder={'vless://...\ntrojan://...\nss://...'}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}
        />
      </Field>
      {errors.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="ah-mini ah-muted" style={{ marginBottom: 6 }}>以下行无法识别（最多显示 20 条）：</div>
          <pre className="ah-code-block ah-code-err" style={{ maxHeight: 180 }}>{errors.join('\n')}</pre>
        </div>
      )}
    </Modal>
  )
}
