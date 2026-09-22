import { useEffect, useState } from 'react'
import { api, setStoredToken } from '../api/client'
import { Button, IconButton } from '../components/Button'
import { Card } from '../components/Card'
import { Input, Select, Slider } from '../components/Form'
import { IconBolt, IconCopy, IconSettings, IconSpark, IconTrash, IconWarn } from '../components/Icons'
import { Toggle } from '../components/Toggle'
import { useToast } from '../components/Toast'
import type { Settings } from '../types'

export function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null)
  const [saving, setSaving] = useState(false)
  const toast = useToast()

  useEffect(() => {
    api.getSettings().then(setS).catch((e) => toast('err', e.message))
  }, [toast])

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((p) => (p ? { ...p, [k]: v } : p))

  const save = async () => {
    if (!s) return
    setSaving(true)
    try {
      // 只提交本页 UI 涉及的字段：整份回写会用本页加载时的旧缓存覆盖预处理页的规则
      const saved = await api.updateSettings({
        single_retry_times: s.single_retry_times,
        channel_retry_times: s.channel_retry_times,
        retry_interval_ms: s.retry_interval_ms,
        request_timeout_ms: s.request_timeout_ms,
        failover_strategy: s.failover_strategy,
        auto_ban: s.auto_ban,
        auto_ban_codes: s.auto_ban_codes,
        log_retention_days: s.log_retention_days,
        store_request_body: s.store_request_body,
        store_response_body: s.store_response_body,
        access_token: s.access_token,
        proxy_url: s.proxy_url,
      })
      setS(saved)
      // 管理 API 与 /v1 共用该令牌，保存后同步本地凭证，避免下一个请求就 401
      setStoredToken(saved.access_token)
      toast('ok', '设置已保存')
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setSaving(false)
    }
  }

  const clearLogs = async () => {
    if (!window.confirm('确认清空全部请求日志？此操作不可撤销。')) return
    try {
      await api.clearLogs()
      toast('ok', '日志已清空')
    } catch (e: any) {
      toast('err', e.message)
    }
  }

  if (!s) {
    return (
      <div className="ah-fade-up">
        <div className="ah-page-head">
          <div>
            <div className="ah-page-title">设置</div>
          </div>
        </div>
        <div className="ah-skel" style={{ height: 200 }} />
      </div>
    )
  }

  const origin = window.location.origin

  return (
    <div className="ah-fade-up">
      <div className="ah-page-head">
        <div>
          <div className="ah-page-title">设置</div>
          <div className="ah-page-sub">对外入口 · 故障转移 · 数据留存</div>
        </div>
        <Button variant="primary" loading={saving} onClick={save}>
          保存设置
        </Button>
      </div>

      {/* 对外入口 */}
      <Card className="ah-set-card">
        <div className="ah-set-title">
          <IconBolt size={18} /> 对外入口地址
        </div>
        <div className="ah-set-desc">把下面地址填进客户端(SillyTavern 等)即可使用，内网默认免鉴权</div>
        <EndpointRow label="OpenAI 兼容" url={`${origin}/v1`} />
        <EndpointRow label="Anthropic 原生" url={`${origin}`} />
        <EndpointRow label="OpenAI Responses" url={`${origin}/v1/responses`} />
        <SettingRow label="访问令牌" desc="可选 · 同时保护对外入口与本管理界面（Bearer / x-api-key）；留空 = 内网免鉴权">
          <Input
            value={s.access_token}
            onChange={(e) => set('access_token', e.target.value)}
            placeholder="留空免鉴权"
            type="password"
            autoComplete="off"
          />
        </SettingRow>
      </Card>

      {/* 故障转移与重试 */}
      <Card className="ah-set-card">
        <div className="ah-set-title">
          <IconWarn size={18} /> 故障转移与重试
        </div>
        <div className="ah-set-desc">请求失败时如何自动重试、切换渠道与熔断坏渠道</div>
        <SettingRow label="单渠道重试次数" desc="同一个渠道请求失败后，最多在本渠道重试几次">
          <Slider value={s.single_retry_times} min={0} max={100} onChange={(v) => set('single_retry_times', v)} suffix=" 次" />
        </SettingRow>
        <SettingRow label="多渠道重试次数" desc="本渠道重试用尽后，最多再切换到下几个渠道继续重试">
          <Slider value={s.channel_retry_times} min={0} max={10} onChange={(v) => set('channel_retry_times', v)} suffix=" 个" />
        </SettingRow>
        <SettingRow label="失败间隔" desc="每次请求失败后，等待多久再发起下一次重试">
          <Slider value={Math.round(s.retry_interval_ms / 1000)} min={0} max={30} onChange={(v) => set('retry_interval_ms', v * 1000)} suffix=" 秒" />
        </SettingRow>
        <SettingRow label="请求超时" desc="等待上游响应的最长时间">
          <Slider
            value={Math.round(s.request_timeout_ms / 1000)}
            min={5}
            max={600}
            step={5}
            onChange={(v) => set('request_timeout_ms', v * 1000)}
            suffix=" 秒"
          />
        </SettingRow>
        <SettingRow label="故障转移策略" desc="优先级越高的渠道越先被选中，失败后自动降级">
          <Select value={s.failover_strategy} onChange={(e) => set('failover_strategy', e.target.value as any)}>
            <option value="priority_descend">优先级降级 + 同级加权随机</option>
          </Select>
        </SettingRow>
        <SettingRow label="自动熔断" desc="命中熔断状态码时自动停用该渠道（多为凭证失效）">
          <Toggle checked={s.auto_ban} onChange={(v) => set('auto_ban', v)} />
        </SettingRow>
        {s.auto_ban && (
          <SettingRow label="熔断状态码" desc="逗号分隔，命中即自动停用渠道">
            <Input value={s.auto_ban_codes} onChange={(e) => set('auto_ban_codes', e.target.value)} placeholder="401,403" />
          </SettingRow>
        )}
        <SettingRow label="HTTP 代理" desc="上游请求经此代理转发，留空不使用代理">
          <Input
            value={s.proxy_url}
            onChange={(e) => set('proxy_url', e.target.value)}
            placeholder="http://127.0.0.1:7890"
          />
        </SettingRow>
      </Card>

      {/* 数据留存 */}
      <Card className="ah-set-card">
        <div className="ah-set-title">
          <IconSpark size={18} /> 数据留存
        </div>
        <div className="ah-set-desc">统计日志的保留时长与正文存储</div>
        <SettingRow label="日志保留天数" desc="超过天数的请求日志会被自动清理">
          <Slider value={s.log_retention_days} min={1} max={90} onChange={(v) => set('log_retention_days', v)} suffix=" 天" />
        </SettingRow>
        <SettingRow label="记录请求正文" desc="统计页可回看每次请求的 prompt（占用空间）">
          <Toggle checked={s.store_request_body} onChange={(v) => set('store_request_body', v)} />
        </SettingRow>
        <SettingRow label="记录响应正文" desc="统计页可回看每次响应内容与上游原始回复（占用空间）">
          <Toggle checked={s.store_response_body} onChange={(v) => set('store_response_body', v)} />
        </SettingRow>
        <SettingRow label="清空日志" desc="立即删除全部请求日志记录">
          <Button variant="danger" size="sm" icon={<IconTrash size={16} />} onClick={clearLogs}>
            清空全部
          </Button>
        </SettingRow>
      </Card>

      <div className="ah-mini ah-faint" style={{ textAlign: 'center', padding: 'var(--sp-4)' }}>
        <IconSettings size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
        AggHub · 轻量内网渠道聚合网关
      </div>
    </div>
  )
}

function SettingRow({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="ah-set-row">
      <div className="ah-set-row-info">
        <div className="ah-set-row-label">{label}</div>
        {desc && <div className="ah-set-row-desc">{desc}</div>}
      </div>
      <div className="ah-set-row-control">{children}</div>
    </div>
  )
}

function EndpointRow({ label, url }: { label: string; url: string }) {
  const toast = useToast()
  return (
    <div className="ah-endpoint">
      <span className="ah-endpoint-label">{label}</span>
      <code className="ah-endpoint-url ah-truncate">{url}</code>
      <IconButton
        title="复制"
        onClick={() => {
          navigator.clipboard?.writeText(url)
          toast('ok', '地址已复制')
        }}
      >
        <IconCopy size={16} />
      </IconButton>
    </div>
  )
}
