import * as gem from '../convert/gemini'
import * as anth from '../convert/anthropic'
import type { Adaptor } from './base'
import { trimSlash } from './base'
import type { Channel } from '../types'
import { parseCredentials, getAccessToken, getCachedToken } from './vertex-auth'

function isClaudeModel(model: string): boolean {
  return model.startsWith('claude')
}

function buildBaseUrl(baseUrl: string | null, region: string): string {
  if (baseUrl?.trim()) return trimSlash(baseUrl)
  const host = region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`
  return `https://${host}`
}

function ensureV1(root: string): string {
  return /\/v1$/.test(root) ? root : root + '/v1'
}

function buildGeminiUrl(baseUrl: string | null, region: string, projectId: string | null, model: string, stream: boolean): string {
  const v1 = ensureV1(buildBaseUrl(baseUrl, region))
  const action = stream ? 'streamGenerateContent' : 'generateContent'
  if (projectId) {
    const suffix = stream ? `${action}?alt=sse` : action
    return `${v1}/projects/${projectId}/locations/${region}/publishers/google/models/${model}:${suffix}`
  }
  return `${v1}/publishers/google/models/${model}:${action}`
}

function buildClaudeUrl(baseUrl: string | null, region: string, projectId: string, model: string, stream: boolean): string {
  const v1 = ensureV1(buildBaseUrl(baseUrl, region))
  const action = stream ? 'streamRawPredict' : 'rawPredict'
  return `${v1}/projects/${projectId}/locations/${region}/publishers/anthropic/models/${model}:${action}`
}

export const vertexAdaptor: Adaptor = {
  wireFormat: 'gemini',

  resolveWireFormat: model => isClaudeModel(model) ? 'anthropic' : 'gemini',

  async prepareChannel(channel: Channel, proxyUrl?: string, signal?: AbortSignal) {
    const creds = parseCredentials(channel.api_key)
    if (!creds) return
    await getAccessToken(creds, proxyUrl, signal)
  },

  buildRequest(channel, ir, upstreamModel, stream) {
    const region = channel.region?.trim() || 'global'
    const creds = parseCredentials(channel.api_key)
    const claude = isClaudeModel(upstreamModel)

    if (claude) {
      const body = anth.buildRequest(ir, upstreamModel)
      delete body.model
      body.anthropic_version = 'vertex-2023-10-16'
      body.stream = stream
      const headers: Record<string, string> = { 'content-type': 'application/json' }

      if (creds) {
        const url = buildClaudeUrl(channel.base_url, region, creds.project_id, upstreamModel, stream)
        headers.authorization = `Bearer ${getCachedToken(creds) || ''}`
        return { url, headers, body: JSON.stringify(body) }
      }
      // API key 模式（不太常见但兼容）
      const url = buildClaudeUrl(channel.base_url, region, '', upstreamModel, stream)
      const sep = url.includes('?') ? '&' : '?'
      return { url: `${url}${sep}key=${encodeURIComponent(channel.api_key)}`, headers, body: JSON.stringify(body) }
    }

    // Gemini 模式
    const body = gem.buildRequest(ir, upstreamModel)
    const headers: Record<string, string> = { 'content-type': 'application/json' }

    if (creds) {
      const url = buildGeminiUrl(channel.base_url, region, creds.project_id, upstreamModel, stream)
      headers.authorization = `Bearer ${getCachedToken(creds) || ''}`
      return { url, headers, body: JSON.stringify(body) }
    }

    const url = buildGeminiUrl(channel.base_url, region, null, upstreamModel, stream)
    const finalUrl = stream ? `${url}?alt=sse&key=${encodeURIComponent(channel.api_key)}` : `${url}?key=${encodeURIComponent(channel.api_key)}`
    return { url: finalUrl, headers, body: JSON.stringify(body) }
  },

  buildPassthroughRequest(channel, rawBody, upstreamModel, stream, rawHeaders) {
    if (!isClaudeModel(upstreamModel)) return this.buildRequest(channel, rawBody, upstreamModel, stream)

    const region = channel.region?.trim() || 'global'
    const creds = parseCredentials(channel.api_key)
    const body = { ...rawBody, anthropic_version: 'vertex-2023-10-16', stream }
    delete body.model
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (!channel.strip_headers) {
      const beta = rawHeaders?.['anthropic-beta']
      if (beta) headers['anthropic-beta'] = String(beta)
    }

    if (creds) {
      const url = buildClaudeUrl(channel.base_url, region, creds.project_id, upstreamModel, stream)
      headers.authorization = `Bearer ${getCachedToken(creds) || ''}`
      return { url, headers, body: JSON.stringify(body) }
    }
    const url = buildClaudeUrl(channel.base_url, region, '', upstreamModel, stream)
    const sep = url.includes('?') ? '&' : '?'
    return { url: `${url}${sep}key=${encodeURIComponent(channel.api_key)}`, headers, body: JSON.stringify(body) }
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
