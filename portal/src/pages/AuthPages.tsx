import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { api } from '../api'
import { Link, navigate } from '../router'
import { useSession } from '../session'
import { useToast } from '../components/Toast'
import { Button, Field, Input, PasswordInput } from '../components/ui'
import { IconCircleAlert, IconLogIn, IconUserPlus } from '../components/Icons'

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/

function AuthLayout({ title, sub, children }: { title: string; sub: ReactNode; children: ReactNode }) {
  return (
    <div className="pt-auth">
      <Link to="/login" className="pt-auth-brand">
        <span className="pt-auth-logo">🍊</span>
        <h1>AggHub</h1>
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

export function LoginPage() {
  const { setUser } = useSession()
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
      const redirect = params.get('redirect')
      navigate(redirect?.startsWith('/console') ? redirect : '/console', true)
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

  const closed = !status.register_enabled
  return (
    <AuthLayout title="创建账号" sub={<>已有账号？<Link to="/login">登录</Link></>}>
      {closed && (
        <div className="pt-alert is-warning"><IconCircleAlert size={16} />管理员已关闭注册，请联系管理员获取账号。</div>
      )}
      <form className="pt-auth-form" onSubmit={submit} noValidate>
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
      </form>
    </AuthLayout>
  )
}
