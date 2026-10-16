import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, setUnauthorizedHandler } from './api'
import { navigate, useLocation } from './router'
import { SessionContext } from './session'
import type { Session } from './session'
import { setMoneyConfig } from './lib/format'
import { applyBranding } from './lib/brand'
import type { PortalStatus, Self } from './types'
import { ToastProvider } from './components/Toast'
import { ConsoleLayout } from './components/Layout'
import { Button } from './components/ui'
import { LoginPage, RegisterPage } from './pages/AuthPages'
import { DashboardPage } from './pages/DashboardPage'
import { KeysPage } from './pages/KeysPage'
import { LogsPage } from './pages/LogsPage'
import { ModelsPage } from './pages/ModelsPage'
import { ProfilePage } from './pages/ProfilePage'

const CONSOLE_PAGES: Record<string, () => JSX.Element> = {
  '/console': DashboardPage,
  '/console/models': ModelsPage,
  '/console/keys': KeysPage,
  '/console/logs': LogsPage,
  '/console/profile': ProfilePage,
}

/** 未登录访问控制台去登录页（带回跳地址），已登录访问登录页去控制台 */
function redirectTarget(pathname: string, location: string, loggedIn: boolean): string | null {
  const isAuth = pathname === '/login' || pathname === '/register'
  if (loggedIn) return isAuth || !CONSOLE_PAGES[pathname] ? '/console' : null
  if (isAuth) return null
  return pathname.startsWith('/console') ? `/login?redirect=${encodeURIComponent(location)}` : '/login'
}

export default function App() {
  const location = useLocation()
  const pathname = location.split('?')[0].replace(/\/+$/, '') || '/'
  const [status, setStatus] = useState<PortalStatus | null>(null)
  const [user, setUser] = useState<Self | null>(null)
  const [bootError, setBootError] = useState('')
  const [booted, setBooted] = useState(false)

  const boot = useCallback(async () => {
    setBootError('')
    try {
      const s = await api.status()
      setMoneyConfig(s.points_per_usd, s.currency_symbol)
      applyBranding(s)
      setStatus(s)
      try { setUser(await api.self()) } catch { setUser(null) }
      setBooted(true)
    } catch (e) {
      setBootError((e as Error).message || '无法连接服务')
    }
  }, [])

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null))
    void boot()
  }, [boot])

  const refreshUser = useCallback(async () => {
    try { setUser(await api.self()) } catch {}
  }, [])

  const target = booted ? redirectTarget(pathname, location, !!user) : null
  useEffect(() => {
    if (target) navigate(target, true)
  }, [target])

  const session = useMemo<Session | null>(() => status && { status, user, setUser, refreshUser }, [status, user, refreshUser])

  if (bootError) {
    return (
      <div className="pt-boot">
        <div className="pt-boot-title">无法连接服务</div>
        <div className="muted">{bootError}</div>
        <Button variant="outline" onClick={boot}>重试</Button>
      </div>
    )
  }
  if (!booted || !session || target) return null

  const ConsolePage = CONSOLE_PAGES[pathname]
  return (
    <SessionContext.Provider value={session}>
      <ToastProvider>
        {pathname === '/login' && <LoginPage />}
        {pathname === '/register' && <RegisterPage />}
        {ConsolePage && user && (
          <ConsoleLayout path={pathname}>
            <ConsolePage key={user.id} />
          </ConsoleLayout>
        )}
      </ToastProvider>
    </SessionContext.Provider>
  )
}
