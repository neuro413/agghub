import { useState } from 'react'
import { api } from '../api/client'
import { Button } from '../components/Button'
import { Field, Input, Textarea } from '../components/Form'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'
import { Markdown } from '../lib/markdown'
import type { Announcement, AnnouncementType } from '../types'

/** 类型决定门户上公告前的颜色点（同 new-api） */
export const TYPE_OPTIONS: { value: AnnouncementType; label: string }[] = [
  { value: 'default', label: '默认' },
  { value: 'ongoing', label: '进行中' },
  { value: 'success', label: '成功' },
  { value: 'warning', label: '警告' },
  { value: 'error', label: '错误' },
]

const CONTENT_MAX = 5000
const EXTRA_MAX = 200

/** 时间戳 → datetime-local 的值（本地时区，精确到分钟） */
function toLocalInput(ts: number): string {
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export function AnnouncementModal({ item, onClose, onSaved }: { item: Announcement | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast()
  const [content, setContent] = useState(item?.content ?? '')
  const [extra, setExtra] = useState(item?.extra ?? '')
  const [type, setType] = useState<AnnouncementType>(item?.type ?? 'default')
  const [publishAt, setPublishAt] = useState(() => toLocalInput(item?.publish_at ?? Date.now()))
  const [preview, setPreview] = useState(false)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    const publish_at = new Date(publishAt).getTime()
    if (!content.trim()) return toast('err', '请填写公告内容')
    if (!Number.isFinite(publish_at)) return toast('err', '请选择发布时间')
    // 编辑时没改时间就保留原值，避免被截到分钟
    const data = { content, extra, type, publish_at: item && publishAt === toLocalInput(item.publish_at) ? item.publish_at : publish_at }
    setSaving(true)
    try {
      if (item) await api.updateAnnouncement(item.id, data)
      else await api.createAnnouncement(data)
      toast('ok', data.publish_at > Date.now() ? '已设为定时发布' : item ? '公告已保存' : '公告已发布')
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
      title={item ? '编辑公告' : '新建公告'}
      onClose={onClose}
      size="lg"
      dismissible={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={saving} onClick={save}>
            {item ? '保存' : '发布'}
          </Button>
        </>
      }
    >
      <Field label="内容" required hint={`支持 Markdown，${content.length} / ${CONTENT_MAX}`}>
        <div className="ah-md-switch">
          <button type="button" className={preview ? undefined : 'is-on'} onClick={() => setPreview(false)}>编辑</button>
          <button type="button" className={preview ? 'is-on' : undefined} onClick={() => setPreview(true)}>预览</button>
        </div>
        {preview ? (
          <div className="ah-md-preview is-modal">
            {content.trim() ? <Markdown content={content} /> : <span className="ah-mini ah-faint">还没有内容</span>}
          </div>
        ) : (
          <Textarea
            rows={8}
            value={content}
            maxLength={CONTENT_MAX}
            onChange={(e) => setContent(e.target.value)}
            placeholder={'例如：**新模型上线**：claude-opus 系列已开放，欢迎体验～\n详情见 [使用说明](https://example.com)'}
          />
        )}
      </Field>

      <div className="ah-grid2">
        <Field label="发布时间" hint="晚于现在的为定时发布，到点后门户才显示">
          <Input type="datetime-local" value={publishAt} onChange={(e) => setPublishAt(e.target.value)} />
        </Field>
        <Field label="类型" hint="门户上公告前的颜色点">
          <div className="ah-pp-chips">
            {TYPE_OPTIONS.map((o) => (
              <button type="button" key={o.value} className={`ah-pp-chip ah-ann-type${type === o.value ? ' is-on' : ''}`} onClick={() => setType(o.value)}>
                <span className={`ah-ann-dot is-${o.value}`} />
                {o.label}
              </button>
            ))}
          </div>
        </Field>
      </div>

      <Field label="附加说明" hint={`可选，显示在内容下方的小字，支持 Markdown，最多 ${EXTRA_MAX} 字`}>
        <Input value={extra} maxLength={EXTRA_MAX} onChange={(e) => setExtra(e.target.value)} placeholder="例如：维护期间请求可能失败，请稍后重试" />
      </Field>
    </Modal>
  )
}
