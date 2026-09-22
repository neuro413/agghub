import type { Channel, WireFormat } from '../types'
import type { StreamDecoder } from '../convert/ir'

export interface UpstreamRequest {
  url: string
  headers: Record<string, string>
  body: string
}

export interface BuildRequestOptions {
  /** 允许跨格式转换时自动调整 max_tokens / 采样参数以满足上游约束 */
  autoAdjust?: boolean
}

export interface Adaptor {
  wireFormat: WireFormat
  /** 可选的异步前置步骤：在 buildRequest 之前调用，用于预热 token 等需要网络的操作 */
  prepareChannel?(channel: Channel, proxyUrl?: string): Promise<void>
  buildRequest(channel: Channel, ir: any, upstreamModel: string, stream: boolean, opts?: BuildRequestOptions): UpstreamRequest
  /** 同格式透传：用客户端原始 body（仅替换 model），保留 cache_control 等全部特有字段 */
  buildPassthroughRequest?(
    channel: Channel,
    rawBody: any,
    upstreamModel: string,
    stream: boolean,
    rawHeaders?: Record<string, any>,
  ): UpstreamRequest
  parseResponse(json: any, model: string): any
  createStreamDecoder(model: string): StreamDecoder
}

export function trimSlash(s: string): string {
  return s.replace(/\/+$/, '')
}

export function withV1(root: string): string {
  return /\/v1$/.test(root) ? root : root + '/v1'
}
