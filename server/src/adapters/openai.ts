import * as oai from '../convert/openai'
import type { Channel } from '../types'
import type { Adaptor, UpstreamRequest } from './base'
import { endpointUrl } from './base'

function request(channel: Channel, body: any, stream: boolean): UpstreamRequest {
  body.stream = stream
  if (stream) body.stream_options = { include_usage: true }
  return {
    url: endpointUrl(channel, 'https://api.openai.com', '/chat/completions'),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${channel.api_key}` },
    body: JSON.stringify(body),
  }
}

export const openaiAdaptor: Adaptor = {
  wireFormat: 'openai',
  buildRequest: (channel, ir, upstreamModel, stream) => request(channel, oai.buildRequest(ir, upstreamModel), stream),
  buildPassthroughRequest: (channel, rawBody, upstreamModel, stream) => request(channel, { ...rawBody, model: upstreamModel }, stream),
  parseResponse: (json, context) => oai.parseResponse(json, context.requestedModel),
  createStreamDecoder: context => oai.createStreamDecoder(context.requestedModel),
}
