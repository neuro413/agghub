import { createElement, useSyncExternalStore } from 'react'
import type { AnchorHTMLAttributes, MouseEvent } from 'react'

// 极简 history 路由：页面少、没有嵌套路由，不引入路由库

const listeners = new Set<() => void>()
const notify = () => listeners.forEach(fn => fn())
window.addEventListener('popstate', notify)

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function navigate(to: string, replace = false): void {
  if (to === location.pathname + location.search) return
  if (replace) history.replaceState(null, '', to)
  else history.pushState(null, '', to)
  window.scrollTo(0, 0)
  notify()
}

/** 当前 pathname + search */
export function useLocation(): string {
  return useSyncExternalStore(subscribe, () => location.pathname + location.search)
}

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e)
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate(to)
  }
  return createElement('a', { ...rest, href: to, onClick: handle })
}
