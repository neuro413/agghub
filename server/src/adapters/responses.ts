import * as conv from '../convert/responses'
import type { Channel } from '../types'
import type { Adaptor, UpstreamRequest } from './base'
import { endpointUrl, isOfficialOpenAI } from './base'

function request(channel: Channel, body: any): UpstreamRequest {
  return {
    url: endpointUrl(channel, 'https://api.openai.com', '/responses'),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${channel.api_key}` },
    body: JSON.stringify(body),
  }
}

export const responsesAdaptor: Adaptor = {
  wireFormat: 'responses',
  buildRequest: (channel, ir, upstreamModel, stream) => request(channel, { ...conv.buildRequest(ir, upstreamModel, { official: isOfficialOpenAI(channel.base_url) }), stream }),
  parseResponse: (json, context) => conv.parseResponse(json, context.requestedModel),
  createStreamDecoder: context => conv.createStreamDecoder(context.requestedModel),
  // 同格式直通：原样转发客户端 body（含 previous_response_id / 内置工具 / reasoning.encrypted_content 等全部字段）
  buildPassthroughRequest: (channel, rawBody, upstreamModel, stream) => request(channel, { ...rawBody, model: upstreamModel, stream }),
}
