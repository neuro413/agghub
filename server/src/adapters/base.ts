import type { Channel, WireFormat } from '../types'
import type { StreamDecoder } from '../convert/ir'
import type { BufferBudget } from '../core/capture'

export interface UpstreamRequest {
  url: string
  headers: Record<string, string>
  body: string
}

export interface BuildRequestOptions {
  /** 允许跨格式转换时自动调整 max_tokens / 采样参数以满足上游约束 */
  autoAdjust?: boolean
}

export interface UpstreamContext {
  requestedModel: string
  upstreamModel: string
  upstreamWire: WireFormat
  budget?: BufferBudget
}

export interface Adaptor {
  wireFormat: WireFormat
  resolveWireFormat?(upstreamModel: string): WireFormat
  /** 预热属于当前尝试，必须接收取消/超时信号。 */
  prepareChannel?(channel: Channel, proxyUrl?: string, signal?: AbortSignal): Promise<void>
  buildRequest(channel: Channel, ir: any, upstreamModel: string, stream: boolean, opts?: BuildRequestOptions): UpstreamRequest
  /** 同格式透传：用客户端原始 body（仅替换 model），保留 cache_control 等全部特有字段 */
  buildPassthroughRequest?(
    channel: Channel,
    rawBody: any,
    upstreamModel: string,
    stream: boolean,
    rawHeaders?: Record<string, any>,
  ): UpstreamRequest
  parseResponse(json: any, context: UpstreamContext): any
  createStreamDecoder(context: UpstreamContext): StreamDecoder
}

export function trimSlash(s: string): string {
  return s.replace(/\/+$/, '')
}

export function withV1(root: string): string {
  return /\/v1$/.test(root) ? root : root + '/v1'
}
