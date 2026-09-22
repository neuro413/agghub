import { IconChannels, IconLogs, IconSettings, IconStats, IconWand } from './Icons'

export type TabKey = 'channels' | 'stats' | 'logs' | 'preprocess' | 'settings'

const TABS: { key: TabKey; label: string; Icon: typeof IconChannels }[] = [
  { key: 'channels', label: '渠道', Icon: IconChannels },
  { key: 'stats', label: '统计', Icon: IconStats },
  { key: 'logs', label: '请求日志', Icon: IconLogs },
  { key: 'preprocess', label: '预处理', Icon: IconWand },
  { key: 'settings', label: '设置', Icon: IconSettings },
]

export function TopNav({ tab, onTab }: { tab: TabKey; onTab: (t: TabKey) => void }) {
  return (
    <nav className="ah-nav">
      <div className="ah-nav-inner">
        <div className="ah-brand">
          <div className="ah-brand-logo">🍊</div>
          <div>
            AggHub
            <small>渠道聚合网关</small>
          </div>
        </div>
        <div className="ah-tabs">
          {TABS.map(({ key, label, Icon }) => (
            <button key={key} className={`ah-tab${tab === key ? ' is-active' : ''}`} onClick={() => onTab(key)}>
              <Icon size={17} />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </div>
    </nav>
  )
}
