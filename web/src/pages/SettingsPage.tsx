import { useEffect, useRef, useState } from 'react'
import { api, setStoredToken } from '../api/client'
import { Button, IconButton } from '../components/Button'
import { Card } from '../components/Card'
import { Input, PointsInput, Select, Slider } from '../components/Form'
import { copyText } from '../lib/clipboard'
import { fmtBytes } from '../lib/format'
import { loadWebpPrefs, saveWebpPrefs, toWebp, type WebpPrefs } from '../lib/imageWebp'
import { setMoneyConfig } from '../lib/money'
import { IconBolt, IconCopy, IconDiscord, IconExternal, IconSettings, IconSpark, IconTrash, IconUsers, IconWand, IconWarn } from '../components/Icons'
import { Toggle } from '../components/Toggle'
import { useToast } from '../components/Toast'
import type { CompressionAlgorithm, Settings, SystemInfo } from '../types'
import { DiscordRulesEditor } from './DiscordRulesEditor'
import { PageHead } from '../components/PageHead'

// 只提交本页 UI 涉及的字段：整份回写会用本页加载时的旧缓存覆盖预处理页的规则
const KEYS: (keyof Settings)[] = [
  'single_retry_times', 'channel_retry_times', 'retry_interval_ms', 'request_timeout_ms', 'request_max_duration_ms',
  'stream_keepalive_ms', 'log_response_max_bytes', 'stream_buffer_max_bytes', 'image_max_bytes', 'auto_ban', 'auto_ban_codes',
  'mask_upstream_errors', 'mask_upstream_errors_exclude_codes',
  'auto_ban_threshold', 'auto_ban_cooldown_minutes', 'probe_enabled', 'public_base_url',
  'log_retention_days', 'store_request_body', 'store_response_body', 'access_token', 'proxy_url',
  'portal_register_enabled', 'portal_initial_quota', 'portal_register_ip_daily', 'portal_max_keys',
  'portal_rpm', 'portal_concurrency', 'checkin_enabled', 'checkin_min_points', 'checkin_max_points',
  'currency_symbol', 'portal_brand_name', 'portal_brand_icon', 'portal_site_title',
  'portal_background', 'portal_background_opacity', 'portal_background_blur', 'portal_background_dim',
  'portal_password_register_enabled', 'discord_enabled', 'discord_client_id', 'discord_client_secret', 'discord_rules',
  'upstream_compression_enabled', 'upstream_compression_default', 'upstream_compression_gzip_level', 'upstream_compression_br_quality',
  'upstream_compression_zstd_level', 'upstream_compression_zstd_window_log', 'upstream_compression_min_bytes', 'upstream_compression_fallback',
  'upstream_compression_fallback_codes', 'upstream_compression_fallback_pattern', 'upstream_compression_unsupported_minutes',
  'response_compression_enabled', 'response_compression_level', 'response_compression_br_quality', 'response_compression_threshold',
  'static_assets_max_age_days', 'static_precompressed',
]

type IntegerKey = 'portal_register_ip_daily' | 'portal_max_keys' | 'portal_rpm' | 'portal_concurrency'
type PointsKey = 'portal_initial_quota' | 'checkin_min_points' | 'checkin_max_points'

/** 与后端 BRAND_ICON_MAX_BYTES 一致 */
const BRAND_ICON_MAX_BYTES = 512 * 1024

/** 与后端 BACKGROUND_MAX_BYTES 一致 */
const BACKGROUND_MAX_BYTES = 5 * 1024 * 1024

/** zstd 窗口只允许 0（级别默认）或 10～23 */
const ZSTD_WINDOWS = [0, ...Array.from({ length: 14 }, (_, i) => i + 10)]

function windowSize(log: number): string {
  return log >= 20 ? `${2 ** (log - 20)} MB` : `${2 ** (log - 10)} KB`
}

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
  const [uploadingBg, setUploadingBg] = useState(false)
  const [webp, setWebp] = useState(loadWebpPrefs)
  const iconFile = useRef<HTMLInputElement>(null)
  const bgFile = useRef<HTMLInputElement>(null)
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

  // WebP 选项只存本地，不进服务端设置
  const updateWebp = (patch: Partial<WebpPrefs>) => setWebp((p) => {
    const next = { ...p, ...patch }
    saveWebpPrefs(next)
    return next
  })

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

  // 上传后服务端立即把背景设置指向上传地址，这里同步快照，不算作未保存的改动
  const uploadBackground = async (file: File) => {
    let target = file
    let converted = false
    // GIF 跳过转换，避免丢失动画；转换失败或体积没变小时用原图
    if (webp.enabled && file.type !== 'image/gif') {
      try {
        const blob = await toWebp(file, webp)
        if (blob.size < file.size) {
          target = new File([blob], file.name.replace(/\.[^.]+$/, '') + '.webp', { type: 'image/webp' })
          converted = true
        }
      } catch {
        // 浏览器不支持 WebP 编码等情况直接回退原图
      }
    }
    if (target.size > BACKGROUND_MAX_BYTES) {
      toast('err', `背景图不能超过 ${BACKGROUND_MAX_BYTES / 1024 / 1024} MB`)
      return
    }
    setUploadingBg(true)
    try {
      const saved = await api.uploadBackground(await readAsDataUrl(target))
      if (loaded.current) loaded.current = { ...loaded.current, portal_background: saved.portal_background }
      set('portal_background', saved.portal_background)
      toast('ok', converted ? `背景图已上传并生效（${fmtBytes(file.size)} → ${fmtBytes(target.size)}）` : '背景图已上传并生效')
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setUploadingBg(false)
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
        <PageHead title="设置" />
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
  // 与后端 discordRedirectUri 一致：Base URL 留空时跟随用户访问门户的地址
  const publicBase = s.public_base_url.trim().replace(/\/+$/, '')
  const discordCallback = publicBase ? `${publicBase}/oauth/discord` : ''

  return (
    <div className="ah-fade-up">
      <PageHead
        title="设置"
        sub="对外入口 · 故障转移 · 数据留存"
        actions={
          <>
            <Button variant="primary" loading={saving} onClick={save}>
              保存设置
            </Button>
          </>
        }
      />

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
        <SettingRow label="脱敏上游报错信息" desc="公网端口的上游与网络错误只向客户端返回 HTTP 状态码（如 503 Service Unavailable）；请求日志仍保存原文">
          <Toggle checked={s.mask_upstream_errors} onChange={(v) => set('mask_upstream_errors', v)} />
        </SettingRow>
        {s.mask_upstream_errors && (
          <SettingRow label="排除的状态码" desc="逗号分隔，命中的状态码照常返回上游报错原文；留空 = 全部脱敏">
            <Input value={s.mask_upstream_errors_exclude_codes} onChange={(e) => set('mask_upstream_errors_exclude_codes', e.target.value)} placeholder="400" />
          </SettingRow>
        )}
      </Card>

      {/* 用户门户 */}
      <Card className="ah-set-card">
        <div className="ah-set-title">
          <IconUsers size={18} /> 用户门户
        </div>
        <div className="ah-set-desc">
          {system?.public_enabled
            ? '公网端口上的自助门户：用户名密码或 Discord 注册登录、自建 Key、签到领额度、查看调用记录；用户 Key 直接扣用户余额'
            : '门户随公网端口一起开放，当前公网端口未开启'}
        </div>
        <SettingRow label="开放注册" desc="注册总开关，关闭后用户名密码和 Discord 都不能新建账号；已有用户仍可登录">
          <Toggle checked={s.portal_register_enabled} onChange={(v) => set('portal_register_enabled', v)} />
        </SettingRow>
        <SettingRow label="允许用户名密码注册" desc="关闭后只能通过 Discord 注册；已有账号仍可用密码登录">
          <Toggle checked={s.portal_password_register_enabled} onChange={(v) => set('portal_password_register_enabled', v)} />
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
        <SettingRow label="可用性自动测活" desc="可用性页为 10 分钟内无人调用的模型自动发起一次探活；关闭后只统计真实请求，错过的时段会缺少数据">
          <Toggle checked={s.probe_enabled} onChange={(v) => set('probe_enabled', v)} />
        </SettingRow>
      </Card>

      {/* Discord 登录 */}
      <Card className="ah-set-card">
        <div className="ah-set-title">
          <IconDiscord size={18} /> Discord 登录
        </div>
        <div className="ah-set-desc">
          门户登录注册页显示「使用 Discord 登录」；没注册过的 Discord 账号首次登录时自动建号（受开放注册和同 IP 每日上限约束），这类账号没有密码，只能用 Discord 登录。
          在 Discord 开发者后台 → 应用 → OAuth2 里取得 Client ID / Secret，并把下方回调地址加入 Redirects；请求 Discord 走「HTTP 代理」设置
        </div>
        {discordCallback ? (
          <EndpointRow label="回调地址" url={discordCallback} />
        ) : (
          <SettingRow label="回调地址" desc="未填写公网 Base URL，回调地址跟随用户访问门户的地址；建议先在「公网分发」里填写">
            <code className="ah-mini ah-muted">{'<门户地址>/oauth/discord'}</code>
          </SettingRow>
        )}
        <SettingRow label="允许 Discord 登录注册" desc="开启前须先填写 Client ID 和 Client Secret">
          <Toggle checked={s.discord_enabled} onChange={(v) => set('discord_enabled', v)} />
        </SettingRow>
        <SettingRow label="Client ID" desc="应用的 Client ID（纯数字）">
          <Input value={s.discord_client_id} onChange={(e) => set('discord_client_id', e.target.value)} placeholder="123456789012345678" autoComplete="off" />
        </SettingRow>
        <SettingRow label="Client Secret" desc="只保存在服务端，门户不会下发">
          <Input value={s.discord_client_secret} onChange={(e) => set('discord_client_secret', e.target.value)} type="password" autoComplete="new-password" />
        </SettingRow>
        <div className="ah-set-block">
          <div className="ah-set-row-label">服务器与身份组门槛</div>
          <div className="ah-set-row-desc">
            满足任一规则组即可登录，组内的服务器条件需全部满足；每个条件要求用户是该服务器成员（服务器开启成员审核时须已通过），三类身份组留空不检查，多个 ID 用逗号或空格分隔。
            只在登录时检查。Discord 设置 → 高级 → 打开开发者模式后，右键服务器图标「复制服务器 ID」、右键身份组「复制身份组 ID」
          </div>
          <DiscordRulesEditor rules={s.discord_rules} onChange={(v) => set('discord_rules', v)} />
        </div>
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

      {/* 门户背景 */}
      <Card className="ah-set-card">
        <div className="ah-set-title">
          <IconWand size={18} /> 门户背景
        </div>
        <div className="ah-set-desc">给用户门户（登录注册页与控制台）铺一张背景图，内容面板随之变为半透明毛玻璃；未设置背景图时门户保持原来的纯白外观</div>
        <SettingRow
          label="背景图片"
          desc={`留空不启用；可填 http(s) 图片链接（门户走 HTTPS 时请用 https 链接），也可以上传 PNG / JPEG / GIF / WebP（不超过 ${BACKGROUND_MAX_BYTES / 1024 / 1024} MB，上传后立即生效）`}
        >
          <Input value={s.portal_background} onChange={(e) => set('portal_background', e.target.value)} placeholder="https://…" />
          <Button variant="soft" size="sm" loading={uploadingBg} onClick={() => bgFile.current?.click()}>
            上传
          </Button>
          {s.portal_background && (
            <IconButton title="清除（保存后生效）" onClick={() => set('portal_background', '')}>
              <IconTrash size={16} />
            </IconButton>
          )}
          <input
            ref={bgFile}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) uploadBackground(file)
            }}
          />
        </SettingRow>
        <SettingRow label="上传前转 WebP" desc="在浏览器里转成 WebP 再上传，体积通常只有原图的几分之一；GIF 不转换">
          <Toggle checked={webp.enabled} onChange={(v) => updateWebp({ enabled: v })} />
        </SettingRow>
        {webp.enabled && (
          <>
            <SettingRow label="WebP 质量" desc="默认 85">
              <Slider value={webp.quality} min={50} max={95} onChange={(v) => updateWebp({ quality: v })} />
            </SettingRow>
            <SettingRow label="最大宽度（像素）" desc="超过则等比缩小；0 = 不缩放">
              <Input
                aria-label="最大宽度（像素）"
                type="number"
                min="0"
                step="1"
                value={webp.maxWidth}
                onChange={(e) => updateWebp({ maxWidth: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
              />
            </SettingRow>
          </>
        )}
        {s.portal_background && (
          <div className="ah-bg-preview">
            <img src={s.portal_background} alt="背景预览" />
          </div>
        )}
        <SettingRow label="面板不透明度" desc="有背景图时内容面板与卡片白底的不透明度；越低背景越清楚，文字越难看清">
          <Slider value={s.portal_background_opacity} min={0} max={100} onChange={(v) => set('portal_background_opacity', v)} suffix=" %" />
        </SettingRow>
        <SettingRow label="毛玻璃模糊" desc="内容面板对背后图片的模糊程度，0 为不模糊">
          <Slider value={s.portal_background_blur} min={0} max={40} onChange={(v) => set('portal_background_blur', v)} suffix=" px" />
        </SettingRow>
        <SettingRow label="背景遮罩" desc="在背景图上叠一层白色；图片较花时调高，保证顶栏与侧栏文字可读">
          <Slider value={s.portal_background_dim} min={0} max={90} onChange={(v) => set('portal_background_dim', v)} suffix=" %" />
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
        <SettingRow label="流式保活间隔" desc="流式请求超过这么久没向客户端输出，就发一行 SSE 注释，防止 Cloudflare 隧道等反代断开；0 = 关闭">
          <Slider
            value={Math.round(s.stream_keepalive_ms / 1000)}
            min={0}
            max={90}
            step={5}
            onChange={(v) => set('stream_keepalive_ms', v * 1000)}
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
        <SettingRow label="HTTP 代理" desc="上游请求和 Discord 登录经此代理转发，留空不使用代理">
          <Input
            value={s.proxy_url}
            onChange={(e) => set('proxy_url', e.target.value)}
            placeholder="http://127.0.0.1:7890"
          />
        </SettingRow>
      </Card>

      {/* 上游请求体压缩 */}
      <Card className="ah-set-card">
        <div className="ah-set-title">
          <IconBolt size={18} /> 上游请求体压缩
        </div>
        <div className="ah-set-desc">只压缩发往上游的请求体；上游不支持会返回 400/415，开启自动回退后会明文重发并在记忆期内对该渠道发明文</div>
        <SettingRow label="运行环境" desc="zstd 需要 Node ≥ 22.15">
          <code className="ah-mini ah-muted">
            {system ? `Node ${system.node_version} · zstd ${system.zstd_available ? '可用' : '不可用（需 Node ≥ 22.15）'}` : '—'}
          </code>
        </SettingRow>
        <SettingRow label="启用压缩" desc="总开关，关闭时所有渠道都发明文；建议先在渠道里点「压缩测试」确认上游支持再开启">
          <Toggle checked={s.upstream_compression_enabled} onChange={(v) => set('upstream_compression_enabled', v)} />
        </SettingRow>
        <SettingRow label="默认算法" desc="渠道设为「跟随全局」时使用">
          <Select value={s.upstream_compression_default} onChange={(e) => set('upstream_compression_default', e.target.value as CompressionAlgorithm)}>
            <option value="zstd">zstd{system && !system.zstd_available ? '（当前 Node 不支持）' : ''}</option>
            <option value="br">br</option>
            <option value="gzip">gzip</option>
          </Select>
        </SettingRow>
        <SettingRow label="zstd 级别" desc="手机推荐 2；3 级以上的哈希表超出 A53 的 L2 缓存">
          <Slider value={s.upstream_compression_zstd_level} min={1} max={19} onChange={(v) => set('upstream_compression_zstd_level', v)} />
        </SettingRow>
        <SettingRow label="zstd 窗口" desc="放大窗口几乎不增加耗时，长对话收益明显；上限 8 MB（RFC 9659）">
          <Select value={s.upstream_compression_zstd_window_log} onChange={(e) => set('upstream_compression_zstd_window_log', Number(e.target.value))}>
            {ZSTD_WINDOWS.map((log) => (
              <option key={log} value={log}>{log ? `${log} = ${windowSize(log)}` : '0 = 级别默认'}</option>
            ))}
          </Select>
        </SettingRow>
        <SettingRow label="br 质量" desc="手机推荐 2">
          <Slider value={s.upstream_compression_br_quality} min={0} max={11} onChange={(v) => set('upstream_compression_br_quality', v)} />
        </SettingRow>
        <SettingRow label="gzip 级别" desc="手机推荐 1">
          <Slider value={s.upstream_compression_gzip_level} min={1} max={9} onChange={(v) => set('upstream_compression_gzip_level', v)} />
        </SettingRow>
        <SettingRow label="最小压缩体积（KB）" desc="请求体小于该值不压缩；0 = 全部压缩">
          <Input
            aria-label="最小压缩体积（KB）"
            type="number"
            min="0"
            step="1"
            value={s.upstream_compression_min_bytes / 1024}
            onChange={(e) => set('upstream_compression_min_bytes', Math.max(0, Math.round(Number(e.target.value) * 1024)))}
          />
        </SettingRow>
        <SettingRow label="自动回退" desc="压缩被拒时在同一次尝试内明文重发，不占用重试次数">
          <Toggle checked={s.upstream_compression_fallback} onChange={(v) => set('upstream_compression_fallback', v)} />
        </SettingRow>
        {s.upstream_compression_fallback && (
          <>
            <SettingRow label="回退状态码" desc="逗号分隔；状态码命中且错误体匹配下方正则，才判定为压缩被拒">
              <Input value={s.upstream_compression_fallback_codes} onChange={(e) => set('upstream_compression_fallback_codes', e.target.value)} placeholder="400,415" />
            </SettingRow>
            <SettingRow label="匹配正则" desc="不区分大小写，只匹配错误体前 2000 字符，留空只看状态码；默认值不会让「prompt is too long」这类真实错误触发重发">
              <Input value={s.upstream_compression_fallback_pattern} onChange={(e) => set('upstream_compression_fallback_pattern', e.target.value)} />
            </SettingRow>
            <SettingRow
              label="记忆时长"
              desc={`明文重发成功后，这段时间内对该渠道直接发明文；0 = 直到重启${s.upstream_compression_unsupported_minutes ? `（约 ${+(s.upstream_compression_unsupported_minutes / 60).toFixed(1)} 小时）` : '（当前：直到重启）'}`}
            >
              <Slider
                value={s.upstream_compression_unsupported_minutes}
                min={0}
                max={10080}
                step={30}
                onChange={(v) => set('upstream_compression_unsupported_minutes', v)}
                suffix=" 分钟"
              />
            </SettingRow>
          </>
        )}
      </Card>

      {/* 响应压缩与静态缓存 */}
      <Card className="ah-set-card">
        <div className="ah-set-title">
          <IconBolt size={18} /> 响应压缩与静态缓存
        </div>
        <div className="ah-set-desc">压缩管理端 / 门户的接口响应与静态资源；/v1 与 SSE 流式响应永远不压缩</div>
        <SettingRow label="响应压缩" desc="对接口 JSON 与页面资源启用 gzip（可选 br）">
          <Toggle checked={s.response_compression_enabled} onChange={(v) => set('response_compression_enabled', v)} />
        </SettingRow>
        {s.response_compression_enabled && (
          <>
            <SettingRow label="gzip 级别" desc="默认 6">
              <Slider value={s.response_compression_level} min={1} max={9} onChange={(v) => set('response_compression_level', v)} />
            </SettingRow>
            <SettingRow label="br 质量" desc="0 = 不用 br，只用 gzip，CPU 开销可预期">
              <Slider value={s.response_compression_br_quality} min={0} max={11} onChange={(v) => set('response_compression_br_quality', v)} />
            </SettingRow>
            <SettingRow label="压缩阈值（字节）" desc="响应小于该值不压缩">
              <Input aria-label="压缩阈值（字节）" type="number" min="0" step="1" value={s.response_compression_threshold} onChange={(e) => set('response_compression_threshold', Number(e.target.value))} />
            </SettingRow>
          </>
        )}
        <SettingRow label="静态资源缓存（天）" desc="/assets 下带哈希的文件按 immutable 长期缓存；0 = 保持默认">
          <Input aria-label="静态资源缓存（天）" type="number" min="0" step="1" value={s.static_assets_max_age_days} onChange={(e) => set('static_assets_max_age_days', Number(e.target.value))} />
        </SettingRow>
        <SettingRow label="预压缩文件" desc="构建时生成的 .br / .gz 存在时直接返回，不占运行时 CPU">
          <Toggle checked={s.static_precompressed} onChange={(v) => set('static_precompressed', v)} />
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
