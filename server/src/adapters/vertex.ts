import * as gem from '../convert/gemini'
import * as anth from '../convert/anthropic'
import type { Adaptor, UpstreamRequest } from './base'
import { trimSlash, withV1 } from './base'
import type { Channel } from '../types'
import { CandidateError } from '../core/failover'
import { parseCredentials, getAccessToken, getCachedToken } from './vertex-auth'

function isClaudeModel(model: string): boolean {
  return model.startsWith('claude')
}

/**
 * Gemini 支持服务账号或 API Key（express 模式）；Vertex Claude 只能用服务账号。
 * 服务账号 token 由 prepareChannel 预先换好，这里同步读缓存。
 */
function vertexRequest(channel: Channel, model: string, stream: boolean, body: any): UpstreamRequest {
  const region = channel.region?.trim() || 'global'
  const host = region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`
  const v1 = withV1(channel.base_url?.trim() ? trimSlash(channel.base_url) : `https://${host}`)
  const claude = isClaudeModel(model)
  const action = claude ? (stream ? 'streamRawPredict' : 'rawPredict') : stream ? 'streamGenerateContent' : 'generateContent'
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const creds = parseCredentials(channel.api_key)
  let url: string
  if (creds) {
    url = `${v1}/projects/${creds.project_id}/locations/${region}/publishers/${claude ? 'anthropic' : 'google'}/models/${model}:${action}${!claude && stream ? '?alt=sse' : ''}`
    headers.authorization = `Bearer ${getCachedToken(creds) || ''}`
  } else if (claude) {
    throw new CandidateError('Vertex Claude 需要服务账号 JSON 凭证')
  } else {
    url = `${v1}/publishers/google/models/${model}:${action}?${stream ? 'alt=sse&' : ''}key=${encodeURIComponent(channel.api_key)}`
  }
  return { url, headers, body: JSON.stringify(body) }
}

export const vertexAdaptor: Adaptor = {
  wireFormat: 'gemini',

  resolveWireFormat: model => isClaudeModel(model) ? 'anthropic' : 'gemini',

  async prepareChannel(channel: Channel, proxyUrl?: string, signal?: AbortSignal) {
    const creds = parseCredentials(channel.api_key)
    if (creds) await getAccessToken(creds, proxyUrl, signal)
  },

  buildRequest(channel, ir, upstreamModel, stream) {
    if (!isClaudeModel(upstreamModel)) return vertexRequest(channel, upstreamModel, stream, gem.buildRequest(ir, upstreamModel))
    const { model: _model, ...body } = anth.buildRequest(ir, upstreamModel)
    return vertexRequest(channel, upstreamModel, stream, { ...body, anthropic_version: 'vertex-2023-10-16', stream })
  },

  // 只有 Claude 会走直通（Gemini 不是入口格式）
  buildPassthroughRequest(channel, rawBody, upstreamModel, stream, rawHeaders) {
    const { model: _model, ...body } = rawBody
    const request = vertexRequest(channel, upstreamModel, stream, { ...body, anthropic_version: 'vertex-2023-10-16', stream })
    const beta = rawHeaders?.['anthropic-beta']
    if (!channel.strip_headers && beta) request.headers['anthropic-beta'] = String(beta)
    return request
  },

  parseResponse(json, context) {
    if (context.upstreamWire === 'anthropic') return anth.parseResponse(json, context.requestedModel)
    return gem.parseResponse(json, context.requestedModel)
  },

  createStreamDecoder(context) {
    if (context.upstreamWire === 'anthropic') return anth.createStreamDecoder(context.requestedModel)
    return gem.createStreamDecoder(context.requestedModel)
  },
}
