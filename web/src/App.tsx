import { useEffect, useState } from 'react'
import { api, setStoredToken, setUnauthorizedHandler } from './api/client'
import { setMoneyConfig } from './lib/money'
import { Button } from './components/Button'
import { Field, Input } from './components/Form'
import { Modal } from './components/Modal'
import { MobileBar, Sidebar, type TabKey } from './components/Sidebar'
import { useHashRoute } from './lib/route'
import { ToastProvider } from './components/Toast'
import { ChannelsPage } from './pages/ChannelsPage'
import { GroupsPage } from './pages/GroupsPage'
import { KeysPage } from './pages/KeysPage'
import { UsersPage } from './pages/UsersPage'
import { NoticesPage } from './pages/NoticesPage'
import { StatsPage } from './pages/StatsPage'
import { LogsPage } from './pages/LogsPage'
import { PreprocessPage } from './pages/PreprocessPage'
import { SettingsPage } from './pages/SettingsPage'
import { PoolPage } from './pages/PoolPage'

function TokenGate() {
  const [token, setToken] = useState('')
  const submit = () => {
    if (!token.trim()) return
    setStoredToken(token.trim())
    window.location.reload()
  }
  return (
    <Modal
      title="需要访问令牌"
      onClose={() => {}}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <Button variant="primary" disabled={!token.trim()} onClick={submit}>
            确定
          </Button>
        </>
      }
    >
      <Field label="访问令牌" hint="该网关已在设置中启用访问令牌，请输入后继续">
        <Input
          type="password"
          value={token}
          autoFocus
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          placeholder="access token"
          autoComplete="off"
        />
      </Field>
    </Modal>
  )
}

const SIDEBAR_KEY = 'agghub_admin_sidebar'

export default function App() {
  const { tab, query, go } = useHashRoute()
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_KEY) === '1')
  // 窄屏抽屉是否展开；宽屏下该状态不生效
  const [drawer, setDrawer] = useState(false)
  const [needToken, setNeedToken] = useState(false)
  // 金额换算比例和符号来自设置，读到之后再渲染页面；失败（如需要令牌）时按默认值继续
  const [moneyReady, setMoneyReady] = useState(false)
  useEffect(() => {
    setUnauthorizedHandler(() => setNeedToken(true))
    api.getSettings().then(setMoneyConfig, () => {}).finally(() => setMoneyReady(true))
  }, [])
  const toggleCollapse = () => {
    setCollapsed((c) => {
      localStorage.setItem(SIDEBAR_KEY, c ? '0' : '1')
      return !c
    })
  }
  // 从侧栏切页不带 query（统计页跳用户页时才带搜索词）
  const onTab = (t: TabKey) => {
    setDrawer(false)
    go(t)
  }
  return (
    <ToastProvider>
      <div className={`ah-app${collapsed ? ' is-collapsed' : ''}${drawer ? ' is-drawer-open' : ''}`}>
        <Sidebar tab={tab} onTab={onTab} collapsed={collapsed} onToggleCollapse={toggleCollapse} />
        <div className="ah-side-mask" onClick={() => setDrawer(false)} />
        <main className="ah-main">
          <MobileBar tab={tab} onOpen={() => setDrawer(true)} />
          {moneyReady && (
            <>
              {tab === 'channels' && <ChannelsPage />}
              {tab === 'groups' && <GroupsPage />}
              {tab === 'keys' && <KeysPage />}
              {tab === 'users' && <UsersPage initialQuery={query.get('q') ?? ''} />}
              {tab === 'notices' && <NoticesPage />}
              {tab === 'stats' && <StatsPage onOpenLogs={() => go('logs')} onSearchUsers={(q) => go('users', { q })} />}
              {tab === 'logs' && <LogsPage />}
              {tab === 'preprocess' && <PreprocessPage />}
              {tab === 'pool' && <PoolPage />}
              {tab === 'settings' && <SettingsPage />}
            </>
          )}
        </main>
        {needToken && <TokenGate />}
      </div>
    </ToastProvider>
  )
}
