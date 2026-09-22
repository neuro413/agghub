import * as conv from '../convert/responses'
import type { Adaptor } from './base'
import { trimSlash, withV1 } from './base'

function endpoint(baseUrl: string | null): string {
  const root = baseUrl?.trim() ? trimSlash(baseUrl) : 'https://api.openai.com'
  return withV1(root) + '/responses'
}

/** 官方端点拒绝 stop / penalty 等非官方字段；第三方兼容上游（vLLM / SGLang）接受 */
function isOfficial(baseUrl: string | null): boolean {
  const b = (baseUrl || '').trim()
  return !b || /api\.openai\.com/i.test(b)
}

export const responsesAdaptor: Adaptor = {
  wireFormat: 'responses',
  buildRequest(channel, ir, upstreamModel, stream) {
    const body = conv.buildRequest(ir, upstreamModel, { official: isOfficial(channel.base_url) })
    body.stream = stream
    return {
      url: endpoint(channel.base_url),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${channel.api_key}` },
      body: JSON.stringify(body),
    }
  },
  parseResponse: conv.parseResponse,
  createStreamDecoder: conv.createStreamDecoder,
  // 同格式直通：原样转发客户端 body（含 previous_response_id / 内置工具 / reasoning.encrypted_content 等全部字段）
  buildPassthroughRequest(channel, rawBody, upstreamModel, stream) {
    const body: any = { ...rawBody, model: upstreamModel, stream }
    return {
      url: endpoint(channel.base_url),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${channel.api_key}` },
      body: JSON.stringify(body),
    }
  },
}
