import { useCallback, useEffect, useState } from 'react'
import { TAB_KEYS, type TabKey } from '../components/Sidebar'

interface Route {
  tab: TabKey
  query: URLSearchParams
}

/** 解析形如 #/users?q=123456 的 hash；非法或为空时落到 channels */
function parse(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '')
  const i = raw.indexOf('?')
  const path = decodeURIComponent(i < 0 ? raw : raw.slice(0, i))
  const query = new URLSearchParams(i < 0 ? '' : raw.slice(i + 1))
  const tab = (TAB_KEYS as string[]).includes(path) ? (path as TabKey) : 'channels'
  return { tab, query }
}

function build(tab: TabKey, query?: Record<string, string>): string {
  const qs = query ? new URLSearchParams(query).toString() : ''
  return `#/${tab}${qs ? '?' + qs : ''}`
}

/** hash 路由：刷新后停留在当前页，服务端无需改动 */
export function useHashRoute(): { tab: TabKey; query: URLSearchParams; go: (tab: TabKey, query?: Record<string, string>) => void } {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash))

  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  const go = useCallback((tab: TabKey, query?: Record<string, string>) => {
    const next = build(tab, query)
    if (window.location.hash !== next) window.location.hash = next
    // hash 未变（重复点击当前页）时也同步一次，保证 query 被清掉
    setRoute(parse(next))
  }, [])

  return { tab: route.tab, query: route.query, go }
}
