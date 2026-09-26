import * as conv from '../convert/responses'
import type { Channel } from '../types'
import type { Adaptor, UpstreamRequest } from './base'
import { trimSlash, withV1 } from './base'

function request(channel: Channel, body: any): UpstreamRequest {
  const root = channel.base_url?.trim() ? trimSlash(channel.base_url) : 'https://api.openai.com'
  return {
    url: withV1(root) + '/responses',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${channel.api_key}` },
    body: JSON.stringify(body),
  }
}

/** 官方端点拒绝 stop / penalty 等非官方字段；第三方兼容上游（vLLM / SGLang）接受 */
function isOfficial(baseUrl: string | null): boolean {
  const b = (baseUrl || '').trim()
  return !b || /api\.openai\.com/i.test(b)
}

export const responsesAdaptor: Adaptor = {
  wireFormat: 'responses',
  buildRequest: (channel, ir, upstreamModel, stream) => request(channel, { ...conv.buildRequest(ir, upstreamModel, { official: isOfficial(channel.base_url) }), stream }),
  parseResponse: (json, context) => conv.parseResponse(json, context.requestedModel),
  createStreamDecoder: context => conv.createStreamDecoder(context.requestedModel),
  // 同格式直通：原样转发客户端 body（含 previous_response_id / 内置工具 / reasoning.encrypted_content 等全部字段）
  buildPassthroughRequest: (channel, rawBody, upstreamModel, stream) => request(channel, { ...rawBody, model: upstreamModel, stream }),
}
