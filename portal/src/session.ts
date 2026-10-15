import { createContext, useContext } from 'react'
import type { PortalStatus, Self } from './types'

export interface Session {
  status: PortalStatus
  /** 已登录用户；控制台页面里一定存在 */
  user: Self | null
  setUser: (user: Self | null) => void
  /** 重新拉取余额等信息（签到、调用后） */
  refreshUser: () => Promise<void>
}

export const SessionContext = createContext<Session | null>(null)

export function useSession(): Session {
  const session = useContext(SessionContext)
  if (!session) throw new Error('SessionContext 未初始化')
  return session
}

/** 控制台内使用：已登录用户 */
export function useUser(): Self {
  const { user } = useSession()
  if (!user) throw new Error('未登录')
  return user
}
