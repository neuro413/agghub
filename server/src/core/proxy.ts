import { ProxyAgent } from 'undici'

// 全局代理与代理池各节点的本地入站各用一个 agent；全局代理改地址后旧 agent 留在缓存里，数量很少可以忽略
const agents = new Map<string, ProxyAgent>()

export function getProxyAgent(url: string): ProxyAgent {
  let agent = agents.get(url)
  if (!agent) {
    agent = new ProxyAgent(url)
    agents.set(url, agent)
  }
  return agent
}

/** 优雅关闭：等进行中的请求结束 */
export function closeProxyAgent(url: string): void {
  const agent = agents.get(url)
  if (!agent) return
  agents.delete(url)
  agent.close().catch(() => {})
}
