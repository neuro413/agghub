import { ProxyAgent } from 'undici'

let cachedProxy: { url: string; agent: ProxyAgent } | null = null
export function getProxyAgent(url: string): ProxyAgent {
  if (cachedProxy?.url !== url) {
    cachedProxy?.agent.close().catch(() => {})
    cachedProxy = { url, agent: new ProxyAgent(url) }
  }
  return cachedProxy.agent
}
