import { Agent, ProxyAgent } from 'undici'
import { checkServerIdentity } from 'node:tls'
import { isIP } from 'node:net'
import { abortable, settleCleanup } from './requestLifecycle'
import { unbracket } from './imagePolicy'

export interface ImageTransportRequest {
  url: URL
  address: string
  signal: AbortSignal
  proxyUrl?: string
}
export interface ImageTransportResult {
  response: Response
  dispose(): Promise<void>
}
export type ImageTransport = (request: ImageTransportRequest) => Promise<ImageTransportResult>

/** URL 的连接目标改为已验证 IP，HTTP Host 和 TLS 校验仍使用原主机。
 * 代理 CONNECT 也使用该数字 IP，避免代理再次解析原域名引入 rebinding。
 */
export const pinnedImageTransport: ImageTransport = async ({ url, address, signal, proxyUrl }) => {
  signal.throwIfAborted()
  const target = new URL(url)
  target.hostname = isIP(address) === 6 ? `[${address}]` : address
  const hostname = unbracket(url.hostname)
  const tls = {
    servername: isIP(hostname) ? undefined : hostname,
    rejectUnauthorized: true,
    checkServerIdentity: (_host: string, certificate: Parameters<typeof checkServerIdentity>[1]) => checkServerIdentity(hostname, certificate),
  }
  const dispatcher = proxyUrl
    ? new ProxyAgent({ uri: proxyUrl, proxyTunnel: true, requestTls: tls })
    : new Agent({ connect: tls, connections: 1, pipelining: 1 })
  const dispose = async () => { await settleCleanup(dispatcher.destroy()) }
  try {
    const response = await abortable(fetch(target, {
      method: 'GET', redirect: 'manual', signal,
      headers: { host: url.host, accept: 'image/*,application/octet-stream;q=0.5' },
      // Node 内置 fetch 会覆盖 Host；在 dispatcher 边界恢复原 Host，连接 origin 仍是已验证 IP。
      dispatcher: {
        dispatch(options: any, handler: any) {
          const headers: string[] = []
          const source = options.headers
          if (Array.isArray(source)) {
            for (let i = 0; i < source.length; i += 2) if (String(source[i]).toLowerCase() !== 'host') headers.push(source[i], source[i + 1])
          } else for (const [key, value] of Object.entries(source || {})) if (key.toLowerCase() !== 'host') headers.push(key, String(value))
          headers.push('host', url.host)
          return dispatcher.dispatch({ ...options, headers }, handler)
        },
      },
    } as any), signal, late => { void late.body?.cancel().catch(() => {}) })
    return { response, dispose }
  } catch (error) { await dispose(); throw error }
}
