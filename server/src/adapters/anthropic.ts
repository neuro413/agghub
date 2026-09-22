import * as anth from '../convert/anthropic'
import type { Adaptor } from './base'
import { trimSlash, withV1 } from './base'

export const anthropicAdaptor: Adaptor = {
  wireFormat: 'anthropic',
  buildRequest(channel, ir, upstreamModel, stream, opts) {
    const root = channel.base_url?.trim() ? trimSlash(channel.base_url) : 'https://api.anthropic.com'
    const url = withV1(root) + '/messages'
    const body = anth.buildRequest(ir, upstreamModel, { autoAdjust: opts?.autoAdjust })
    body.stream = stream
    return {
      url,
      headers: {
        'content-type': 'application/json',
        'x-api-key': channel.api_key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    }
  },
  parseResponse: anth.parseResponse,
  createStreamDecoder: anth.createStreamDecoder,
  buildPassthroughRequest(channel, rawBody, upstreamModel, stream, rawHeaders) {
    const root = channel.base_url?.trim() ? trimSlash(channel.base_url) : 'https://api.anthropic.com'
    const url = withV1(root) + '/messages'
    const body = { ...rawBody, model: upstreamModel, stream }
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': channel.api_key,
      'anthropic-version': '2023-06-01',
    }
    // 转发客户端的版本/beta 头（如 prompt caching、扩展思考等能力开关）；strip_headers 开启时只保留必要头
    if (!channel.strip_headers) {
      const ver = rawHeaders?.['anthropic-version']
      if (ver) headers['anthropic-version'] = String(ver)
      const beta = rawHeaders?.['anthropic-beta']
      if (beta) headers['anthropic-beta'] = String(beta)
    }
    return { url, headers, body: JSON.stringify(body) }
  },
}
