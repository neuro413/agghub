import type { Channel, WireFormat } from '../types'
import type { StreamDecoder } from '../convert/ir'

export interface UpstreamRequest {
  url: string
  headers: Record<string, string>
  body: string
}

export interface UpstreamContext {
  requestedModel: string
  upstreamModel: string
  upstreamWire: WireFormat
}

export interface Adaptor {
  wireFormat: WireFormat
  resolveWireFormat?(upstreamModel: string): WireFormat
  /** 预热属于当前尝试，必须接收取消/超时信号。 */
  prepareChannel?(channel: Channel, proxyUrl?: string, signal?: AbortSignal): Promise<void>
  buildRequest(channel: Channel, ir: any, upstreamModel: string, stream: boolean): UpstreamRequest
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

/** 上游请求地址：完整地址模式下 Base URL 原样使用，否则补 /v1 再拼接口路径 */
export function endpointUrl(channel: Channel, defaultRoot: string, path: string): string {
  const base = channel.base_url?.trim()
  if (base && channel.base_url_full) return base
  return withV1(base ? trimSlash(base) : defaultRoot) + path
}
