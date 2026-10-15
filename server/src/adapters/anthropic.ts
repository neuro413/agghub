import * as anth from '../convert/anthropic'
import type { Channel } from '../types'
import type { Adaptor, UpstreamRequest } from './base'
import { endpointUrl } from './base'

function request(channel: Channel, body: any): UpstreamRequest {
  return {
    url: endpointUrl(channel, 'https://api.anthropic.com', '/messages'),
    headers: { 'content-type': 'application/json', 'x-api-key': channel.api_key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  }
}

export const anthropicAdaptor: Adaptor = {
  wireFormat: 'anthropic',
  buildRequest: (channel, ir, upstreamModel, stream) => request(channel, { ...anth.buildRequest(ir, upstreamModel), stream }),
  buildPassthroughRequest(channel, rawBody, upstreamModel, stream, rawHeaders) {
    const req = request(channel, { ...rawBody, model: upstreamModel, stream })
    // 转发客户端的版本/beta 头（如 prompt caching、扩展思考等能力开关）；strip_headers 开启时只保留必要头
    if (!channel.strip_headers) {
      for (const key of ['anthropic-version', 'anthropic-beta']) if (rawHeaders?.[key]) req.headers[key] = String(rawHeaders[key])
    }
    return req
  },
  parseResponse: (json, context) => anth.parseResponse(json, context.requestedModel),
  createStreamDecoder: context => anth.createStreamDecoder(context.requestedModel),
}
