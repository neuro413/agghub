import { useEffect, useState } from 'react'
import { setStoredToken, setUnauthorizedHandler } from './api/client'
import { Button } from './components/Button'
import { Field, Input } from './components/Form'
import { Modal } from './components/Modal'
import { TopNav, type TabKey } from './components/TopNav'
import { ToastProvider } from './components/Toast'
import { ChannelsPage } from './pages/ChannelsPage'
import { KeysPage } from './pages/KeysPage'
import { StatsPage } from './pages/StatsPage'
import { LogsPage } from './pages/LogsPage'
import { PreprocessPage } from './pages/PreprocessPage'
import { SettingsPage } from './pages/SettingsPage'

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

export default function App() {
  const [tab, setTab] = useState<TabKey>('channels')
  const [needToken, setNeedToken] = useState(false)
  useEffect(() => {
    setUnauthorizedHandler(() => setNeedToken(true))
  }, [])
  return (
    <ToastProvider>
      <div className="ah-app">
        <TopNav tab={tab} onTab={setTab} />
        <main className="ah-main">
          {tab === 'channels' && <ChannelsPage />}
          {tab === 'keys' && <KeysPage />}
          {tab === 'stats' && <StatsPage onOpenLogs={() => setTab('logs')} />}
          {tab === 'logs' && <LogsPage />}
          {tab === 'preprocess' && <PreprocessPage />}
          {tab === 'settings' && <SettingsPage />}
        </main>
        {needToken && <TokenGate />}
      </div>
    </ToastProvider>
  )
}
