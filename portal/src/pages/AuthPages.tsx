import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { api } from '../api'
import { Link, navigate } from '../router'
import { useSession } from '../session'
import { useToast } from '../components/Toast'
import { BrandLogo } from '../components/Layout'
import { Button, Field, Input, PasswordInput } from '../components/ui'
import { IconCircleAlert, IconDiscord, IconInfo, IconLoader, IconLogIn, IconUserPlus } from '../components/Icons'

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/
/** 登录前要回到的页面，按 state 暂存到 Discord 回调 */
const REDIRECT_KEY = 'agh_oauth_redirect:'

const safeRedirect = (redirect: string | null | undefined) => (redirect?.startsWith('/console') ? redirect : '/console')

function AuthLayout({ title, sub, children }: { title: string; sub: ReactNode; children: ReactNode }) {
  const { status } = useSession()
  return (
    <div className="pt-auth">
      <Link to="/login" className="pt-auth-brand">
        <BrandLogo className="pt-auth-logo" />
        <h1>{status.brand_name}</h1>
      </Link>
      <div className="pt-auth-main">
        <div className="pt-auth-col">
          <div>
            <h2 className="pt-auth-title">{title}</h2>
            <p className="pt-auth-sub">{sub}</p>
          </div>
          {children}
        </div>
      </div>
    </div>
  )
}

/** Discord 按钮：取得授权地址后整页跳转，失败原因显示在按钮下方 */
function DiscordSection({ label, redirect, divider = true }: { label: string; redirect?: string | null; divider?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const start = async () => {
    setBusy(true)
    setError('')
    try {
      const { url, state } = await api.discordStart()
      if (redirect) {
        try { sessionStorage.setItem(REDIRECT_KEY + state, redirect) } catch {}
      }
      // 跳转期间保持加载状态
      location.href = url
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="pt-auth-alt">
      {divider && <div className="pt-auth-divider">或</div>}
      <Button variant="outline" block loading={busy} onClick={start} className="pt-btn-discord">
        {!busy && <IconDiscord />}
        {label}
      </Button>
      {error && <div className="pt-field-error">{error}</div>}
    </div>
  )
}

export function LoginPage() {
  const { status, setUser } = useSession()
  const toast = useToast()
  const params = new URLSearchParams(location.search)
  const [username, setUsername] = useState(params.get('username') ?? '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!username.trim() || !password) return setError('请输入用户名和密码')
    setBusy(true)
    setError('')
    try {
      const user = await api.login(username.trim(), password)
      setUser(user)
      toast('success', '登录成功')
      navigate(safeRedirect(params.get('redirect')), true)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout title="登录" sub={<>还没有账号？<Link to="/register">注册</Link></>}>
      <form className="pt-auth-form" onSubmit={submit} noValidate>
        <Field label="用户名" htmlFor="username">
          <Input id="username" value={username} onChange={e => setUsername(e.target.value)} placeholder="请输入用户名" autoComplete="username" autoFocus />
        </Field>
        <Field label="密码" htmlFor="password" error={error}>
          <PasswordInput id="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="请输入密码" autoComplete="current-password" />
        </Field>
        <Button type="submit" block loading={busy}>
          {!busy && <IconLogIn />}
          登录
        </Button>
      </form>
      {status.discord_enabled && <DiscordSection label="使用 Discord 登录" redirect={params.get('redirect')} />}
    </AuthLayout>
  )
}

export function RegisterPage() {
  const { status } = useSession()
  const toast = useToast()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<{ username?: string; password?: string; confirm?: string; form?: string }>({})

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const next: typeof errors = {}
    if (!USERNAME_RE.test(username)) next.username = '用户名须为 3～20 位字母、数字或下划线'
    const length = [...password].length
    if (length < 8 || length > 128) next.password = '密码须为 8～128 个字符'
    if (password !== confirm) next.confirm = '两次输入的密码不一致'
    setErrors(next)
    if (Object.keys(next).length) return
    setBusy(true)
    try {
      await api.register(username, password)
      toast('success', '注册成功，请登录')
      navigate(`/login?username=${encodeURIComponent(username)}`, true)
    } catch (err) {
      setErrors({ form: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const closed = !status.register_enabled || (!status.password_register_enabled && !status.discord_enabled)
  // 全部关闭时保留禁用的表单；只关了密码注册时只留 Discord
  const passwordForm = closed || status.password_register_enabled
  const discord = status.register_enabled && status.discord_enabled
  return (
    <AuthLayout title="创建账号" sub={<>已有账号？<Link to="/login">登录</Link></>}>
      {closed && (
        <div className="pt-alert is-warning"><IconCircleAlert size={16} />管理员已关闭注册，请联系管理员获取账号。</div>
      )}
      {!passwordForm && (
        <div className="pt-alert"><IconInfo size={16} />本站通过 Discord 注册，首次登录时自动创建账号。</div>
      )}
      {passwordForm && <form className="pt-auth-form" onSubmit={submit} noValidate>
        <Field label="用户名" htmlFor="username" error={errors.username} hint="3～20 位字母、数字或下划线">
          <Input id="username" value={username} onChange={e => setUsername(e.target.value)} placeholder="请输入用户名" autoComplete="username" disabled={closed} autoFocus />
        </Field>
        <Field label="密码" htmlFor="password" error={errors.password}>
          <PasswordInput id="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="请输入密码（8～128 个字符）" autoComplete="new-password" disabled={closed} />
        </Field>
        <Field label="确认密码" htmlFor="confirm" error={errors.confirm ?? errors.form}>
          <PasswordInput id="confirm" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="请再次输入密码" autoComplete="new-password" disabled={closed} />
        </Field>
        <Button type="submit" block loading={busy} disabled={closed}>
          {!busy && <IconUserPlus />}
          创建账号
        </Button>
      </form>}
      {discord && <DiscordSection label="使用 Discord 注册" divider={passwordForm} />}
    </AuthLayout>
  )
}

/** Discord 授权后回跳的页面：把授权码交给后端换登录态 */
export function DiscordCallbackPage() {
  const { setUser } = useSession()
  const toast = useToast()
  const [error, setError] = useState('')
  const started = useRef(false)

  useEffect(() => {
    // 授权码只能用一次，StrictMode 重复执行 effect 时跳过
    if (started.current) return
    started.current = true
    const params = new URLSearchParams(location.search)
    const code = params.get('code') ?? ''
    const state = params.get('state') ?? ''
    let redirect: string | null = null
    try {
      redirect = sessionStorage.getItem(REDIRECT_KEY + state)
      sessionStorage.removeItem(REDIRECT_KEY + state)
    } catch {}
    const denied = params.get('error')
    if (denied) return setError(denied === 'access_denied' ? '已取消 Discord 授权' : params.get('error_description') || 'Discord 授权失败')
    if (!code || !state) return setError('回调参数不完整，请重新发起 Discord 登录')
    api.discordCallback(code, state).then(
      user => {
        setUser(user)
        toast('success', '登录成功')
        navigate(safeRedirect(redirect), true)
      },
      err => setError((err as Error).message),
    )
  }, [setUser, toast])

  return (
    <AuthLayout title="Discord 登录" sub={error ? '登录没有完成' : '正在完成登录，请稍候…'}>
      {error ? (
        <div className="pt-auth-form">
          <div className="pt-alert is-warning"><IconCircleAlert size={16} />{error}</div>
          <Button block onClick={() => navigate('/login', true)}><IconLogIn />返回登录</Button>
        </div>
      ) : (
        <div className="pt-auth-pending"><IconLoader size={24} className="pt-spinner" /></div>
      )}
    </AuthLayout>
  )
}
