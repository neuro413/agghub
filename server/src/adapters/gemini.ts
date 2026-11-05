import * as gem from '../convert/gemini'
import type { Channel } from '../types'
import type { Adaptor, UpstreamRequest } from './base'
import { trimSlash } from './base'

export const GEMINI_DEFAULT_ROOT = 'https://generativelanguage.googleapis.com'

/** Gemini API 根地址：Base URL 已带版本段（/v1、/v1beta、/v1alpha）时原样使用，否则补 /v1beta */
export function geminiApiRoot(baseUrl: string | null | undefined): string {
  const root = baseUrl?.trim() ? trimSlash(baseUrl.trim()) : GEMINI_DEFAULT_ROOT
  return /\/v1(beta|alpha)?\d*$/i.test(root) ? root : root + '/v1beta'
}

/**
 * Google AI Studio（Gemini API）：请求体与 Vertex Gemini 同一套 generateContent 协议，
 * 直接复用 convert/gemini（含 thoughtSignature 往返、thinkingConfig、Schema 清洗），只是地址与鉴权不同。
 */
function request(channel: Channel, model: string, stream: boolean, body: any): UpstreamRequest {
  const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent'
  // 模型名允许带 models/ 前缀（直接从模型列表复制的原名）
  const name = model.replace(/^models\//, '')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (channel.api_key) headers['x-goog-api-key'] = channel.api_key
  return { url: `${geminiApiRoot(channel.base_url)}/models/${name}:${action}`, headers, body: JSON.stringify(body) }
}

export const geminiAdaptor: Adaptor = {
  wireFormat: 'gemini',
  buildRequest: (channel, ir, upstreamModel, stream) => request(channel, upstreamModel, stream, gem.buildRequest(ir, upstreamModel)),
  parseResponse: (json, context) => gem.parseResponse(json, context.requestedModel),
  createStreamDecoder: context => gem.createStreamDecoder(context.requestedModel),
}
