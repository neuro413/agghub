import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../api'
import { Link, navigate } from '../router'
import { useSession, useUser } from '../session'
import { isImageIcon } from '../lib/brand'
import { money } from '../lib/format'
import { Button } from './ui'
import { IconFileText, IconKeyRound, IconLayoutDashboard, IconLogOut, IconPanelLeft, IconUser } from './Icons'

const NAV = [
  {
    group: '控制台',
    items: [
      { to: '/console', label: '概览', Icon: IconLayoutDashboard },
      { to: '/console/keys', label: '令牌', Icon: IconKeyRound },
      { to: '/console/logs', label: '使用日志', Icon: IconFileText },
    ],
  },
  {
    group: '个人',
    items: [{ to: '/console/profile', label: '个人中心', Icon: IconUser }],
  },
]

const COLLAPSE_KEY = 'agh_portal_sidebar'
const mobileQuery = window.matchMedia('(max-width: 767px)')

/** 品牌图标：链接按图片显示，否则当作 emoji / 文字；留空不显示 */
export function BrandLogo({ className }: { className: string }) {
  const icon = useSession().status.brand_icon
  if (!icon) return null
  return <span className={className}>{isImageIcon(icon) ? <img src={icon} alt="" /> : icon}</span>
}

function UserMenu() {
  const user = useUser()
  const { setUser } = useSession()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const logout = async () => {
    try { await api.logout() } catch {}
    setUser(null)
    navigate('/login', true)
  }
  const initial = user.username.slice(0, 1).toUpperCase()
  return (
    <div className="pt-menu-anchor" ref={ref}>
      <button className="pt-avatar-btn" onClick={() => setOpen(v => !v)} aria-label="账户菜单">{initial}</button>
      {open && (
        <div className="pt-menu" role="menu">
          <div className="pt-menu-user">
            <span className="pt-avatar-btn" style={{ width: 28, height: 28, fontSize: 12 }}>{initial}</span>
            <div>
              <div className="name">{user.username}</div>
              <div className="quota">余额 <span className="mono">{money(user.quota)}</span></div>
            </div>
          </div>
          <div className="pt-menu-sep" />
          <button className="pt-menu-item" onClick={() => { setOpen(false); navigate('/console/profile') }}><IconUser />个人中心</button>
          <button className="pt-menu-item is-danger" onClick={logout}><IconLogOut />退出登录</button>
        </div>
      )}
    </div>
  )
}

export function ConsoleLayout({ path, children }: { path: string; children: ReactNode }) {
  const { status } = useSession()
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === '1')
  const [mobileOpen, setMobileOpen] = useState(false)
  useEffect(() => setMobileOpen(false), [path])
  const toggle = () => {
    if (mobileQuery.matches) return setMobileOpen(v => !v)
    setCollapsed(v => {
      localStorage.setItem(COLLAPSE_KEY, v ? '0' : '1')
      return !v
    })
  }
  return (
    <div className="pt-shell">
      <header className="pt-header">
        <Button variant="ghost" size="icon" onClick={toggle} aria-label="切换侧边栏"><IconPanelLeft /></Button>
        <Link to="/console" className="pt-brand">
          <BrandLogo className="pt-brand-logo" />
          {status.brand_name}
        </Link>
        <span className="spacer" />
        <UserMenu />
      </header>
      <div className="pt-body">
        {mobileOpen && <div className="pt-sidebar-mask" onClick={() => setMobileOpen(false)} />}
        <aside className={`pt-sidebar${collapsed ? ' is-collapsed' : ''}${mobileOpen ? ' is-open' : ''}`}>
          {NAV.map(({ group, items }) => (
            <nav key={group} className="pt-nav-group">
              <div className="pt-nav-label">{group}</div>
              <div className="pt-nav-list">
                {items.map(({ to, label, Icon }) => (
                  <Link key={to} to={to} className={`pt-nav-item${path === to ? ' is-active' : ''}`} title={collapsed ? label : undefined}>
                    <Icon />
                    <span>{label}</span>
                  </Link>
                ))}
              </div>
            </nav>
          ))}
        </aside>
        <main className="pt-inset">{children}</main>
      </div>
    </div>
  )
}

/** 页面骨架：标题 + 右侧操作 + 内容 + 可选页脚 */
export function PageLayout({ title, desc, actions, children, footer }: { title: string; desc?: ReactNode; actions?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <>
      <div className="pt-page-head">
        <div>
          <h2 className="pt-page-title">{title}</h2>
          {desc && <div className="pt-page-desc">{desc}</div>}
        </div>
        {actions && <div className="pt-page-actions">{actions}</div>}
      </div>
      <div className="pt-page-body">{children}</div>
      {footer && <div className="pt-page-foot">{footer}</div>}
    </>
  )
}
