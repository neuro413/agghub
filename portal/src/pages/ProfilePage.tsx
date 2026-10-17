import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { api } from '../api'
import { navigate } from '../router'
import { useSession, useUser } from '../session'
import { date, num, money } from '../lib/format'
import { PageLayout } from '../components/Layout'
import { useToast } from '../components/Toast'
import { Button, Card, CardHeader, Field, IconBadge, PasswordInput } from '../components/ui'
import { IconActivity, IconChartColumn, IconDiscord, IconLock, IconLogOut, IconUser, IconWalletCards } from '../components/Icons'

function PasswordCard() {
  const toast = useToast()
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const length = [...newPassword].length
    if (!oldPassword) return setError('请输入原密码')
    if (length < 8 || length > 128) return setError('新密码须为 8～128 个字符')
    if (newPassword !== confirm) return setError('两次输入的新密码不一致')
    setBusy(true)
    setError('')
    try {
      await api.changePassword(oldPassword, newPassword)
      toast('success', '密码已修改，其他设备上的登录已失效')
      setOldPassword('')
      setNewPassword('')
      setConfirm('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader icon={<IconBadge tone="warning" size="md"><IconLock /></IconBadge>} title="修改密码" desc="修改后其他设备需要重新登录" />
      <form className="pt-card-content pt-form-grid" onSubmit={submit} noValidate>
        <Field label="原密码" htmlFor="old-password">
          <PasswordInput id="old-password" value={oldPassword} onChange={e => setOldPassword(e.target.value)} autoComplete="current-password" />
        </Field>
        <Field label="新密码" htmlFor="new-password">
          <PasswordInput id="new-password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="8～128 个字符" autoComplete="new-password" />
        </Field>
        <Field label="确认新密码" htmlFor="confirm-password" error={error}>
          <PasswordInput id="confirm-password" value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" />
        </Field>
        <div><Button type="submit" loading={busy}>保存修改</Button></div>
      </form>
    </Card>
  )
}

export function ProfilePage() {
  const user = useUser()
  const { setUser, refreshUser } = useSession()
  useEffect(() => { void refreshUser() }, [refreshUser])

  const logout = async () => {
    try { await api.logout() } catch {}
    setUser(null)
    navigate('/login', true)
  }

  const stats = [
    { label: '当前余额', value: money(user.quota), desc: '可用于调用的剩余额度', tone: 'success', Icon: IconWalletCards },
    { label: '历史消耗', value: money(user.used_quota), desc: '累计已消耗额度', tone: 'info', Icon: IconChartColumn },
    { label: '请求次数', value: num(user.request_count), desc: '累计调用次数', tone: 'chart-4', Icon: IconActivity },
  ]

  return (
    <PageLayout title="个人中心" desc="账户信息与安全设置">
      <section className="pt-card pt-profile">
        <div className="pt-profile-head">
          <div className="pt-profile-avatar">{user.username.slice(0, 1).toUpperCase()}</div>
          <div>
            <div className="pt-profile-name">{user.username}</div>
            <div className="pt-profile-meta"><IconUser size={13} />用户 ID {user.id} · 注册于 {date(user.created_at)}</div>
            {user.discord_username && <div className="pt-profile-meta"><IconDiscord size={13} />Discord：{user.discord_username}</div>}
          </div>
        </div>
        <div className="pt-profile-stats">
          {stats.map(({ label, value, desc, tone, Icon }) => (
            <div key={label}>
              <div className="pt-stat-label"><IconBadge tone={tone}><Icon size={14} /></IconBadge>{label}</div>
              <div className="pt-profile-value mono">{value}</div>
              <div className="pt-stat-desc">{desc}</div>
            </div>
          ))}
        </div>
      </section>
      <div className="pt-profile-grid">
        {user.has_password ? <PasswordCard /> : (
          <Card>
            <CardHeader icon={<IconBadge tone="info" size="md"><IconDiscord /></IconBadge>} title="登录方式" desc="该账号通过 Discord 登录，没有设置密码" />
            <div className="pt-card-content muted">请使用登录页的「使用 Discord 登录」进入控制台。</div>
          </Card>
        )}
        <Card>
          <CardHeader icon={<IconBadge tone="neutral" size="md"><IconLogOut /></IconBadge>} title="退出登录" desc="退出当前设备上的登录" />
          <div className="pt-card-content">
            <Button variant="destructive" onClick={logout}><IconLogOut size={14} />退出登录</Button>
          </div>
        </Card>
      </div>
    </PageLayout>
  )
}
