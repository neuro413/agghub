import * as oai from '../convert/openai'
import type { Adaptor } from './base'
import { trimSlash, withV1 } from './base'

export const openaiAdaptor: Adaptor = {
  wireFormat: 'openai',
  buildRequest(channel, ir, upstreamModel, stream) {
    const root = channel.base_url?.trim() ? trimSlash(channel.base_url) : 'https://api.openai.com'
    const url = withV1(root) + '/chat/completions'
    const body = oai.buildRequest(ir, upstreamModel)
    body.stream = stream
    if (stream) body.stream_options = { include_usage: true }
    return {
      url,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${channel.api_key}` },
      body: JSON.stringify(body),
    }
  },
  parseResponse: oai.parseResponse,
  createStreamDecoder: oai.createStreamDecoder,
  buildPassthroughRequest(channel, rawBody, upstreamModel, stream) {
    const root = channel.base_url?.trim() ? trimSlash(channel.base_url) : 'https://api.openai.com'
    const url = withV1(root) + '/chat/completions'
    const body: any = { ...rawBody, model: upstreamModel, stream }
    if (stream) body.stream_options = { include_usage: true }
    return {
      url,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${channel.api_key}` },
      body: JSON.stringify(body),
    }
  },
}
