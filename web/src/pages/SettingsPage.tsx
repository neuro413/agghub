import { useEffect, useRef, useState } from 'react'
import { api, setStoredToken } from '../api/client'
import { Button, IconButton } from '../components/Button'
import { Card } from '../components/Card'
import { Input, PointsInput, Slider } from '../components/Form'
import { copyText } from '../lib/clipboard'
import { setMoneyConfig } from '../lib/money'
import { IconBolt, IconCopy, IconExternal, IconSettings, IconSpark, IconTrash, IconUsers, IconWand, IconWarn } from '../components/Icons'
import { Toggle } from '../components/Toggle'
import { useToast } from '../components/Toast'
import type { Settings, SystemInfo } from '../types'

// 只提交本页 UI 涉及的字段：整份回写会用本页加载时的旧缓存覆盖预处理页的规则
const KEYS: (keyof Settings)[] = [
  'single_retry_times', 'channel_retry_times', 'retry_interval_ms', 'request_timeout_ms', 'request_max_duration_ms',
  'log_response_max_bytes', 'stream_buffer_max_bytes', 'image_max_bytes', 'auto_ban', 'auto_ban_codes',
  'auto_ban_threshold', 'auto_ban_cooldown_minutes', 'public_base_url',
  'log_retention_days', 'store_request_body', 'store_response_body', 'access_token', 'proxy_url',
  'portal_register_enabled', 'portal_initial_quota', 'portal_register_ip_daily', 'portal_max_keys',
  'portal_rpm', 'portal_concurrency', 'checkin_enabled', 'checkin_min_points', 'checkin_max_points',
  'currency_symbol', 'portal_brand_name', 'portal_brand_icon', 'portal_site_title',
]

type IntegerKey = 'portal_register_ip_daily' | 'portal_max_keys' | 'portal_rpm' | 'portal_concurrency'
type PointsKey = 'portal_initial_quota' | 'checkin_min_points' | 'checkin_max_points'

/** 与后端 BRAND_ICON_MAX_BYTES 一致 */
const BRAND_ICON_MAX_BYTES = 512 * 1024

/** 图标是 http(s) 链接或上传地址时按图片显示，否则当作 emoji / 文字 */
function isImageIcon(icon: string): boolean {
  return /^(https?:\/\/|\/)/i.test(icon)
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

export function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null)
  const [system, setSystem] = useState<SystemInfo | null>(null)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const iconFile = useRef<HTMLInputElement>(null)
  /** 上次加载 / 保存成功的快照，用于算出本次真正改动过的字段 */
  const loaded = useRef<Settings | null>(null)
  const toast = useToast()

  useEffect(() => {
    const controller = new AbortController()
    api.getSettings(controller.signal).then(value => {
      if (controller.signal.aborted) return
      loaded.current = value
      setS(value)
    }).catch(e => { if (!controller.signal.aborted) toast('err', e.message) })
    api.getSystem(controller.signal).then(value => { if (!controller.signal.aborted) setSystem(value) }).catch(() => {})
    return () => controller.abort()
  }, [toast])

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((p) => (p ? { ...p, [k]: v } : p))

  const save = async () => {
    if (!s) return
    // 只提交真正改动过的字段：服务端只校验本次提交涉及的字段，把加载时的旧值原样回写，
    // 会被自身校验拦下（早期版本允许的越界值），导致整页怎么都保存不了
    const changed = KEYS.filter((k) => !Object.is(s[k], loaded.current?.[k]))
    if (!changed.length) {
      toast('ok', '没有改动，无需保存')
      return
    }
    setSaving(true)
    try {
      const saved = await api.updateSettings(Object.fromEntries(changed.map((k) => [k, s[k]])))
      loaded.current = saved
      setS(saved)
      // 管理 API 与 /v1 共用该令牌，保存后同步本地凭证，避免下一个请求就 401
      setStoredToken(saved.access_token)
      setMoneyConfig(saved)
      toast('ok', '设置已保存')
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setSaving(false)
    }
  }

  // 上传后服务端立即把图标设置指向上传地址，这里同步快照，不算作未保存的改动
  const uploadIcon = async (file: File) => {
    if (file.size > BRAND_ICON_MAX_BYTES) {
      toast('err', `图标不能超过 ${BRAND_ICON_MAX_BYTES / 1024} KB`)
      return
    }
    setUploading(true)
    try {
      const saved = await api.uploadBrandIcon(await readAsDataUrl(file))
      if (loaded.current) loaded.current = { ...loaded.current, portal_brand_icon: saved.portal_brand_icon }
      set('portal_brand_icon', saved.portal_brand_icon)
      toast('ok', '图标已上传并生效')
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setUploading(false)
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
  const intInput = (key: IntegerKey, label: string) => (
    <Input aria-label={label} type="number" min="0" step="1" value={s[key]} onChange={e => set(key, Number(e.target.value))} />
  )
  const pointsInput = (key: PointsKey, label: string) => (
    <PointsInput aria-label={label} value={s[key]} onChange={v => set(key, v)} />
  )

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

      <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      {/* 对外入口 */}
      <Card className="ah-set-card">
        <div className="ah-set-title">
          <IconBolt size={18} /> 对外入口地址
        </div>
        <div className="ah-set-desc">内网地址，填进客户端（SillyTavern 等）即可使用；带分发 Key 调用时按 Key 的权限和额度限制</div>
        <EndpointRow label="OpenAI 兼容" url={`${origin}/v1`} />
        <EndpointRow label="Anthropic 原生" url={`${origin}`} />
        <EndpointRow label="OpenAI Responses" url={`${origin}/v1/responses`} />
        <SettingRow label="管理令牌" desc="保护本管理界面和内网 /v1 匿名调用（Bearer / x-api-key）；公网端口不接受管理令牌，只接受分发 Key。留空 = 内网免鉴权">
          <Input
            value={s.access_token}
            onChange={(e) => set('access_token', e.target.value)}
            placeholder="留空免鉴权"
            type="password"
            autoComplete="off"
          />
        </SettingRow>
      </Card>

      {/* 公网分发 */}
      <Card className="ah-set-card">
        <div className="ah-set-title">
          <IconExternal size={18} /> 公网分发
        </div>
        <div className="ah-set-desc">
          {system?.public_enabled
            ? `公网端口已开启：监听 ${system.public_host}:${system.public_port}`
            : '公网端口未开启：设置环境变量 AGGHUB_PUBLIC_PORT 后重启生效'}
        </div>
        <SettingRow label="trust proxy" desc="公网端口从 X-Forwarded-For 取客户端 IP 的策略">
          <code className="ah-mini ah-muted">{system?.trust_proxy ?? '—'}</code>
        </SettingRow>
        <SettingRow label="公网 Base URL" desc="用于令牌页复制接入信息和门户里显示的接入地址；留空时门户按用户访问的地址显示">
          <Input value={s.public_base_url} onChange={(e) => set('public_base_url', e.target.value)} placeholder="https://api.example.com" />
        </SettingRow>
      </Card>

      {/* 用户门户 */}
      <Card className="ah-set-card">
        <div className="ah-set-title">
          <IconUsers size={18} /> 用户门户
        </div>
        <div className="ah-set-desc">
          {system?.public_enabled
            ? '公网端口上的自助门户：用户名密码注册登录、自建 Key、签到领额度、查看调用记录；用户 Key 直接扣用户余额'
            : '门户随公网端口一起开放，当前公网端口未开启'}
        </div>
        <SettingRow label="开放注册" desc="关闭后已有用户仍可登录">
          <Toggle checked={s.portal_register_enabled} onChange={(v) => set('portal_register_enabled', v)} />
        </SettingRow>
        <SettingRow label="新用户赠送额度" desc="注册时发放到用户余额">
          {pointsInput('portal_initial_quota', '新用户赠送额度')}
        </SettingRow>
        <SettingRow label="同 IP 每日注册上限" desc="按服务器日期计，0 = 不限">
          {intInput('portal_register_ip_daily', '同 IP 每日注册上限')}
        </SettingRow>
        <SettingRow label="每用户 Key 上限" desc="每个用户最多可以创建的 Key 数">
          {intInput('portal_max_keys', '每用户 Key 上限')}
        </SettingRow>
        <SettingRow label="每用户 RPM" desc="同一用户名下所有 Key 共用，0 = 不限">
          {intInput('portal_rpm', '每用户 RPM')}
        </SettingRow>
        <SettingRow label="每用户并发" desc="同一用户名下所有 Key 共用，0 = 不限">
          {intInput('portal_concurrency', '每用户并发')}
        </SettingRow>
        <SettingRow label="每日签到" desc="用户每天可签到一次，随机领取额度">
          <Toggle checked={s.checkin_enabled} onChange={(v) => set('checkin_enabled', v)} />
        </SettingRow>
        {s.checkin_enabled && (
          <>
            <SettingRow label="签到最小奖励" desc="每次签到随机发放的下限">
              {pointsInput('checkin_min_points', '签到最小奖励')}
            </SettingRow>
            <SettingRow label="签到最大奖励" desc="每次签到随机发放的上限">
              {pointsInput('checkin_max_points', '签到最大奖励')}
            </SettingRow>
          </>
        )}
      </Card>

      {/* 品牌与金额显示 */}
      <Card className="ah-set-card">
        <div className="ah-set-title">
          <IconWand size={18} /> 品牌与金额显示
        </div>
        <div className="ah-set-desc">门户顶栏、登录注册页和浏览器标签页显示的名称与图标；余额符号对管理端和门户同时生效</div>
        <SettingRow label="余额符号" desc="显示金额时放在数字前，只改变显示，不做汇率换算">
          <Input value={s.currency_symbol} onChange={(e) => set('currency_symbol', e.target.value)} placeholder="$" maxLength={8} />
        </SettingRow>
        <SettingRow label="站点名称" desc="门户顶栏和登录注册页的品牌名称">
          <Input value={s.portal_brand_name} onChange={(e) => set('portal_brand_name', e.target.value)} placeholder="AggHub" maxLength={64} />
        </SettingRow>
        <SettingRow label="网页标题" desc="门户浏览器标签页上的标题">
          <Input value={s.portal_site_title} onChange={(e) => set('portal_site_title', e.target.value)} placeholder="AggHub 控制台" maxLength={128} />
        </SettingRow>
        <SettingRow
          label="站点图标"
          desc={`emoji / 文字（最多 16 个字符）或图片链接，同时用作标签页图标；也可以上传 PNG / JPEG / GIF / WebP / SVG / ICO（不超过 ${BRAND_ICON_MAX_BYTES / 1024} KB，上传后立即生效）`}
        >
          <span className="ah-brand-preview" title="预览">
            {isImageIcon(s.portal_brand_icon) ? <img src={s.portal_brand_icon} alt="" /> : s.portal_brand_icon || '—'}
          </span>
          <Input value={s.portal_brand_icon} onChange={(e) => set('portal_brand_icon', e.target.value)} placeholder="🍊" />
          <Button variant="soft" size="sm" loading={uploading} onClick={() => iconFile.current?.click()}>
            上传
          </Button>
          <input
            ref={iconFile}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/x-icon,.ico"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) uploadIcon(file)
            }}
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
          <Slider value={s.channel_retry_times} min={0} max={20} onChange={(v) => set('channel_retry_times', v)} suffix=" 个" />
        </SettingRow>
        <SettingRow label="失败间隔" desc="每次请求失败后，等待多久再发起下一次重试">
          <Slider value={Math.round(s.retry_interval_ms / 1000)} min={0} max={30} onChange={(v) => set('retry_interval_ms', v * 1000)} suffix=" 秒" />
        </SettingRow>
        <SettingRow label="上游空闲超时" desc="含等待响应头；收到字节即刷新，心跳有效。整次总时限另行配置。">
          <Slider
            value={Math.round(s.request_timeout_ms / 1000)}
            min={5}
            max={900}
            step={5}
            onChange={(v) => set('request_timeout_ms', v * 1000)}
            suffix=" 秒"
          />
        </SettingRow>
        <SettingRow label="自动熔断" desc="命中熔断状态码时自动停用该渠道（多为凭证失效）">
          <Toggle checked={s.auto_ban} onChange={(v) => set('auto_ban', v)} />
        </SettingRow>
        {s.auto_ban && (
          <>
            <SettingRow label="熔断状态码" desc="逗号分隔，命中即自动停用渠道">
              <Input value={s.auto_ban_codes} onChange={(e) => set('auto_ban_codes', e.target.value)} placeholder="401,403" />
            </SettingRow>
            <SettingRow label="连续失败次数" desc="连续命中熔断状态码达到次数才停用渠道；公网分发建议 3">
              <Slider value={s.auto_ban_threshold} min={1} max={20} onChange={(v) => set('auto_ban_threshold', v)} suffix=" 次" />
            </SettingRow>
            <SettingRow label="自动恢复" desc="自动停用后多少分钟恢复启用，0 = 只能手动恢复；恢复后再命中一次会立即停用">
              <Slider value={s.auto_ban_cooldown_minutes} min={0} max={240} step={5} onChange={(v) => set('auto_ban_cooldown_minutes', v)} suffix=" 分钟" />
            </SettingRow>
          </>
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

      <Card className="ah-set-card">
        <div className="ah-set-title">高级资源限制</div>
        <div className="ah-set-desc">日志限额只影响保存副本；非流式响应超限将明确失败。整次时限涵盖准备、重试和等待。</div>
        {([
          ['request_max_duration_ms', '整次请求总时限（毫秒）', '默认 1800000（30分钟）；0 明确关闭'],
          ['log_response_max_bytes', '每字段日志上限（字节）', '默认 4194304（4MiB）；超限标记截断'],
          ['stream_buffer_max_bytes', '非流式响应上限（字节）', '默认 16777216（16MiB）'],
          ['image_max_bytes', '单张图片上限（字节）', '默认 20971520（20MiB）；仅 Gemini 上游下载远程图片时使用'],
        ] as const).map(([key, label, desc]) => <SettingRow key={key} label={label} desc={desc}>
          <Input aria-label={label} type="number" min="0" step="1" value={s[key]} onChange={e => set(key, Number(e.target.value))} />
        </SettingRow>)}
      </Card>
      </fieldset>
      <div className="ah-mini ah-faint" style={{ textAlign: 'center', padding: 'var(--sp-4)' }}>
        <IconSettings size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
        AggHub · 渠道聚合网关
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
        onClick={async () => {
          if (await copyText(url)) toast('ok', '地址已复制')
          else toast('err', '复制失败，请选择左侧地址手动复制')
        }}
      >
        <IconCopy size={16} />
      </IconButton>
    </div>
  )
}
