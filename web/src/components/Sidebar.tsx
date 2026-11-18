import {
  IconBell,
  IconChannels,
  IconGlobe,
  IconKey,
  IconLayers,
  IconLogs,
  IconMenu,
  IconSettings,
  IconSidebar,
  IconStats,
  IconUsers,
  IconWand,
} from './Icons'

export type TabKey = 'channels' | 'groups' | 'keys' | 'users' | 'notices' | 'stats' | 'logs' | 'preprocess' | 'pool' | 'settings'

type TabDef = { key: TabKey; label: string; Icon: typeof IconChannels }

/** 侧栏分组；导航项的可访问名称即 label，e2e 测试按名称查找，不要加角标 */
export const TAB_GROUPS: { label: string; tabs: TabDef[] }[] = [
  {
    label: '运行',
    tabs: [
      { key: 'channels', label: '渠道', Icon: IconChannels },
      { key: 'groups', label: '分组', Icon: IconLayers },
      { key: 'pool', label: '代理池', Icon: IconGlobe },
    ],
  },
  {
    label: '分发',
    tabs: [
      { key: 'keys', label: '令牌', Icon: IconKey },
      { key: 'users', label: '用户', Icon: IconUsers },
      { key: 'notices', label: '通知', Icon: IconBell },
    ],
  },
  {
    label: '观测',
    tabs: [
      { key: 'stats', label: '统计', Icon: IconStats },
      { key: 'logs', label: '请求日志', Icon: IconLogs },
    ],
  },
  {
    label: '配置',
    tabs: [
      { key: 'preprocess', label: '预处理', Icon: IconWand },
      { key: 'settings', label: '设置', Icon: IconSettings },
    ],
  },
]

export const TABS: TabDef[] = TAB_GROUPS.flatMap((g) => g.tabs)
export const TAB_KEYS: TabKey[] = TABS.map((t) => t.key)
export const tabLabel = (k: TabKey) => TABS.find((t) => t.key === k)?.label ?? ''

export function Sidebar({
  tab,
  onTab,
  collapsed,
  onToggleCollapse,
}: {
  tab: TabKey
  onTab: (t: TabKey) => void
  collapsed: boolean
  onToggleCollapse: () => void
}) {
  return (
    <aside className="ah-side">
      <div className="ah-brand">
        <div className="ah-brand-logo">🍊</div>
        <div className="ah-brand-text">
          <b>AggHub</b>
          <small>渠道聚合网关</small>
        </div>
      </div>
      <nav className="ah-side-nav">
        {TAB_GROUPS.map((g) => (
          <div key={g.label} className="ah-nav-group">
            <div className="ah-nav-label">{g.label}</div>
            {g.tabs.map(({ key, label, Icon }) => (
              <button
                key={key}
                type="button"
                className={`ah-nav-item${tab === key ? ' is-active' : ''}`}
                aria-label={label}
                aria-current={tab === key ? 'page' : undefined}
                title={label}
                onClick={() => onTab(key)}
              >
                <Icon size={17} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>
      <button
        type="button"
        className="ah-side-collapse"
        aria-label={collapsed ? '展开侧栏' : '折叠侧栏'}
        title={collapsed ? '展开侧栏' : '折叠侧栏'}
        onClick={onToggleCollapse}
      >
        <IconSidebar size={17} />
        <span>收起侧栏</span>
      </button>
    </aside>
  )
}

/** 窄屏（< 900px）时出现在内容区顶部的栏：汉堡按钮 + 当前页面名 */
export function MobileBar({ tab, onOpen }: { tab: TabKey; onOpen: () => void }) {
  return (
    <div className="ah-mobilebar">
      <button type="button" className="ah-iconbtn" aria-label="打开导航" title="打开导航" onClick={onOpen}>
        <IconMenu size={18} />
      </button>
      <span className="ah-mobilebar-title">{tabLabel(tab)}</span>
    </div>
  )
}
