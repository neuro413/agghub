import { IconBell, IconChannels, IconKey, IconLayers, IconLogs, IconSettings, IconStats, IconUsers, IconWand } from './Icons'

export type TabKey = 'channels' | 'groups' | 'keys' | 'users' | 'notices' | 'stats' | 'logs' | 'preprocess' | 'settings'

const TABS: { key: TabKey; label: string; Icon: typeof IconChannels }[] = [
  { key: 'channels', label: '渠道', Icon: IconChannels },
  { key: 'groups', label: '分组', Icon: IconLayers },
  { key: 'keys', label: '令牌', Icon: IconKey },
  { key: 'users', label: '用户', Icon: IconUsers },
  { key: 'notices', label: '通知', Icon: IconBell },
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
