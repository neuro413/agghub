import * as anth from '../convert/anthropic'
import { parseSSEEvents } from '../convert/ir'
import type { Channel } from '../types'
import { CandidateError } from '../core/failover'
import type { Adaptor, UpstreamRequest } from './base'
import { trimSlash } from './base'
import { parseAwsCredentials, signAwsV4, type AwsCredentials } from './bedrock-auth'
import { parseBedrockEventStream } from './bedrock-stream'

export const BEDROCK_ANTHROPIC_VERSION = 'bedrock-2023-05-31'
export const DEFAULT_BEDROCK_REGION = 'us-east-1'

export function resolveBedrockRegion(channel: Pick<Channel, 'region'>, creds?: AwsCredentials | null): string {
  return channel.region?.trim() || creds?.region?.trim() || DEFAULT_BEDROCK_REGION
}

export function bedrockRuntimeRoot(channel: Pick<Channel, 'base_url' | 'region'>, region: string): string {
  const custom = channel.base_url?.trim()
  return custom ? trimSlash(custom) : `https://bedrock-runtime.${region}.amazonaws.com`
}

export function bedrockInvokeUrl(channel: Pick<Channel, 'base_url' | 'region'>, upstreamModel: string, stream: boolean, region: string): string {
  const root = bedrockRuntimeRoot(channel, region)
  const action = stream ? 'invoke-with-response-stream' : 'invoke'
  return `${root}/model/${encodeURIComponent(upstreamModel)}/${action}`
}

function requireCredentials(apiKey: string): AwsCredentials {
  const creds = parseAwsCredentials(apiKey)
  if (!creds) throw new CandidateError('AWS Bedrock 需要有效的 IAM 凭证（AccessKeyId|SecretAccessKey 或 JSON）')
  return creds
}

/** 合并客户端 anthropic-beta 请求头到 Bedrock 请求体的 anthropic_beta 数组中 */
function mergeAnthropicBeta(body: Record<string, any>, rawBeta: unknown): void {
  if (!rawBeta) return
  const fromHeader = String(rawBeta)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!fromHeader.length) return
  const existing = Array.isArray(body.anthropic_beta) ? body.anthropic_beta.map((s: any) => String(s).trim()).filter(Boolean) : []
  body.anthropic_beta = [...new Set([...existing, ...fromHeader])]
}

function buildBedrockRequest(channel: Channel, upstreamModel: string, stream: boolean, rawPayload: Record<string, any>): UpstreamRequest {
  const creds = requireCredentials(channel.api_key)
  const region = resolveBedrockRegion(channel, creds)
  // Bedrock InvokeModel 不允许在 body 中携带 model 与 stream，且必须指定 anthropic_version
  const { model: _model, stream: _stream, ...rest } = rawPayload
  const payload = { ...rest, anthropic_version: BEDROCK_ANTHROPIC_VERSION }
  const headers: Record<string, string> = stream
    ? {
        'content-type': 'application/json',
        accept: 'application/vnd.amazon.eventstream',
        'x-amzn-bedrock-accept': 'application/json',
      }
    : {
        'content-type': 'application/json',
        accept: 'application/json',
      }
  return {
    url: bedrockInvokeUrl(channel, upstreamModel, stream, region),
    headers,
    body: JSON.stringify(payload),
  }
}

export const bedrockAdaptor: Adaptor = {
  wireFormat: 'anthropic',

  buildRequest(channel, ir, upstreamModel, stream) {
    return buildBedrockRequest(channel, upstreamModel, stream, anth.buildRequest(ir, upstreamModel))
  },

  buildPassthroughRequest(channel, rawBody, upstreamModel, stream, rawHeaders) {
    anth.stripGeminiThinking(rawBody)
    const body = { ...rawBody }
    if (!channel.strip_headers && rawHeaders?.['anthropic-beta']) {
      mergeAnthropicBeta(body, rawHeaders['anthropic-beta'])
    }
    return buildBedrockRequest(channel, upstreamModel, stream, body)
  },

  signRequest(channel, url, headers, body) {
    const creds = requireCredentials(channel.api_key)
    const region = resolveBedrockRegion(channel, creds)
    return signAwsV4({
      method: 'POST',
      url,
      headers,
      body,
      credentials: creds,
      region,
      service: 'bedrock',
    })
  },

  parseStreamEvents(body, options, contentType) {
    // 兼容自定义反代将 EventStream 转回标准 SSE 的情况
    if (contentType && contentType.toLowerCase().includes('text/event-stream')) {
      return parseSSEEvents(body, undefined, options)
    }
    return parseBedrockEventStream(body, options)
  },

  parseResponse(json, context) {
    return anth.parseResponse(json, context.requestedModel)
  },

  createStreamDecoder(context) {
    return anth.createStreamDecoder(context.requestedModel)
  },
}
