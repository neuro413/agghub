import type { Response } from 'express'
import { getSettings, setChannelStatus } from '../db'
import { getAdaptor } from '../adapters'
import type { Adaptor, UpstreamRequest } from '../adapters'
import { resolveImageUrls } from '../convert/gemini'
import { getProxyAgent } from './proxy'
import { candidatesForModel, resolveUpstreamModel, selectChannel } from './selector'
import { UpstreamError, extractUpstreamMessage, isRequestError, parseAutoBanCodes, shouldDisable, shouldRetry } from './failover'
import { applyPreprocess } from './preprocess'
import { recordLog } from '../stats/recorder'
import { contentToText, estimatePromptTokens, parseSSEEvents } from '../convert/ir'
import * as oaiConv from '../convert/openai'
import * as anthConv from '../convert/anthropic'
import * as respConv from '../convert/responses'
import { cacheParts, emptyUsage, mergeUsage, usageFromClaude, usageFromOpenAI, usageFromResponses, usageToClaude } from '../convert/usage'
import type { Channel, EntryFormat, IRUsage, WireFormat } from '../types'
import { applyParamRules, matchParamRules } from './paramRules'
import { matchesPseudoThinking, applyPseudoThinkingRequest, createPseudoThinkingTransform, splitIRResponse } from './pseudoThinking'
import type { ChunkTransform, ThinkingInjectEntry } from './pseudoThinking'
import * as thinkingStore from './thinkingStore'

export type { EntryFormat }

// Responses 上游的推理密文暂存接到 SQLite（Anthropic 客户端思维链回传用）
respConv.setReasoningStore({
  save: (rec) => thinkingStore.saveReasoning(rec, getSettings().reasoning_store_max),
  lookup: (sig) => thinkingStore.lookupReasoning(sig),
})

export interface RelayContext {
  entryFormat: EntryFormat
  ir: any
  stream: boolean
  rawBody: any
  rawHeaders?: Record<string, any>
  res: Response
  /** 本次尝试经后处理实际改写后的请求体（未改动则为 undefined）*/
  preprocessedBody?: string
  pseudoThinking?: boolean
  thinkingInject?: ThinkingInjectEntry[]
  /** 本次尝试收到的上游原始回复（非流式 JSON 文本 / 流式 SSE 原文 / HTTP 错误体），供日志回看 */
  upstreamRaw?: string
  /** 客户端是否已断开（由 handleRelay 注入，流管道用于标注错误原因）*/
  isClientGone?: () => boolean
}

function entryBuildResponse(fmt: EntryFormat, ir: any, reqIr: any): any {
  if (fmt === 'anthropic') return anthConv.buildResponse(ir)
  if (fmt === 'responses') return respConv.buildResponse(ir, { model: reqIr?.model, customToolNames: reqIr?.custom_tool_names })
  return oaiConv.buildResponse(ir)
}

function entryEncoder(fmt: EntryFormat, ir: any) {
  if (fmt === 'anthropic') return anthConv.createStreamEncoder({ estimatePromptTokens: estimatePromptTokens(ir) })
  if (fmt === 'responses') return respConv.createStreamEncoder({ model: ir?.model, customToolNames: ir?.custom_tool_names })
  return oaiConv.createStreamEncoder()
}

export { getProxyAgent } from './proxy'

export interface UpstreamHandle {
  resp: globalThis.Response
  /** 重置超时计时（流式每收到数据调用一次，实现空闲超时）*/
  touch(): void
  /** 响应消费完毕，停止计时 */
  finish(): void
  /** 主动中止上游连接（客户端断开时调用）*/
  abort(): void
}

/** 发起上游请求。返回的 timer 覆盖到响应体消费完毕（finish），而非仅到响应头 —— 上游发完头就断流也能超时中止 */
async function doFetch(url: string, headers: Record<string, string>, body: string, timeoutMs: number, proxyUrl?: string): Promise<UpstreamHandle> {
  const ac = new AbortController()
  let timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const opts: any = { method: 'POST', headers, body, signal: ac.signal }
    if (proxyUrl) opts.dispatcher = getProxyAgent(proxyUrl)
    const resp = await fetch(url, opts)
    return {
      resp,
      touch() {
        clearTimeout(timer)
        timer = setTimeout(() => ac.abort(), timeoutMs)
      },
      finish() {
        clearTimeout(timer)
      },
      abort() {
        clearTimeout(timer)
        try {
          ac.abort()
        } catch {}
      },
    }
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 放弃上游响应流并释放底层连接（不再需要该响应、要换渠道重试时调用，避免连接堆积）*/
function cancelBody(resp: globalThis.Response): void {
  try {
    const body = resp.body as any
    if (body && typeof body.cancel === 'function') Promise.resolve(body.cancel()).catch(() => {})
  } catch {}
}

/** 注入 User-Agent：渠道开启覆写则用自定义值；否则透传客户端 UA（但 strip_headers 开启时不透传）*/
function applyUserAgent(headers: Record<string, string>, channel: Channel, rawHeaders?: Record<string, any>): void {
  if (channel.ua_override && channel.ua_value) {
    headers['user-agent'] = channel.ua_value
    return
  }
  if (channel.strip_headers) return
  const clientUA = rawHeaders?.['user-agent']
  if (clientUA) headers['user-agent'] = String(clientUA)
}

/**
 * 上游实际使用的线格式。Vertex 适配器声明为 gemini，但跑 Claude 模型时实际走 Anthropic 线格式
 * （rawPredict 接收的就是 Anthropic body）；其余适配器以声明为准。
 * 直通判定必须基于「实际线格式」而非模型名：openai 类型渠道也常挂 claude 命名的模型，
 * 把原始 Anthropic body 发到 chat/completions 必然出错。
 */
function upstreamWireFormat(adaptor: Adaptor, upstreamModel: string): WireFormat {
  if (adaptor.wireFormat === 'gemini' && upstreamModel.startsWith('claude')) return 'anthropic'
  return adaptor.wireFormat
}

export async function handleRelay(ctx: RelayContext): Promise<void> {
  const { ir, res, entryFormat, stream } = ctx
  const model = ir?.model
  const settings = getSettings()
  const autoBanCodes = parseAutoBanCodes(settings.auto_ban_codes)

  if (!model) {
    sendErrorMessage(res, entryFormat, 400, 'model is required')
    return
  }
  // 本次请求的候选渠道快照：一次查库，整个重试过程复用（避免每轮 selectChannel 都全量查库）
  const candidates = candidatesForModel(model)
  if (candidates.length === 0) {
    sendErrorMessage(res, entryFormat, 503, `没有可用渠道支持模型 ${model}`)
    return
  }

  const singleRetry = Math.max(0, settings.single_retry_times)
  const channelRetry = Math.max(0, settings.channel_retry_times)
  const intervalMs = Math.max(0, settings.retry_interval_ms)
  const tried = new Set<number>()
  let lastErr: any = null
  let retryCount = 0

  // 客户端断开侦测：断开后中止当前上游请求、停止后续重试（避免白烧 token 与空跑）
  // 注：res 'close' 在正常完成后也会触发，用 writableEnded 区分是否为提前断开
  let clientGone = false
  let activeUp: UpstreamHandle | null = null
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true
      activeUp?.abort()
    }
  })
  ctx.isClientGone = () => clientGone

  // 外层：多渠道。round=0 为首个渠道，1..channelRetry 为依次换到下一个渠道
  for (let round = 0; round <= channelRetry; round++) {
    const channel = selectChannel(candidates, tried)
    if (!channel) break // 候选渠道已耗尽
    const upstreamModel = resolveUpstreamModel(channel, model)
    const adaptor = getAdaptor(channel.type)

    // 内层：单渠道。attempt=0 为首次请求，1..singleRetry 为本渠道重试（仅瞬时错误重试，见 failover.shouldRetry）
    for (let attempt = 0; attempt <= singleRetry; attempt++) {
      if (clientGone) return
      const started = Date.now()
      try {
        // 异步前置：预热 token（Vertex JSON 凭证）+ 下载 HTTP 图片（Gemini 上游）
        if (adaptor.prepareChannel) await adaptor.prepareChannel(channel, settings.proxy_url || undefined)

        // 同格式直通：客户端线格式 == 上游实际线格式（含 Vertex 上的 Claude）才直通，其余一律走 IR 转换
        const upstreamWire = upstreamWireFormat(adaptor, upstreamModel)
        const passthrough = typeof adaptor.buildPassthroughRequest === 'function' && entryFormat === upstreamWire
        const pseudo = passthrough && matchesPseudoThinking(entryFormat, adaptor.wireFormat, channel.id, model, settings)
        const needPreprocess = settings.strip_top_p || settings.drop_thinking || settings.drop_redacted_thinking || (settings.preprocess_rules?.length ?? 0) > 0 || (settings.tool_filter_rules?.length ?? 0) > 0 || pseudo
        const preMeta = { entryFormat, channelId: channel.id, model, passthrough }
        ctx.preprocessedBody = undefined
        ctx.pseudoThinking = pseudo
        ctx.thinkingInject = undefined
        ctx.upstreamRaw = undefined
        let upReq: UpstreamRequest
        if (passthrough) {
          let body = ctx.rawBody
          if (needPreprocess) {
            const before = JSON.stringify(ctx.rawBody)
            body = JSON.parse(before)
            if (pseudo) {
              ctx.thinkingInject = applyPseudoThinkingRequest(body, settings, thinkingStore.lookup)
            }
            applyPreprocess(body, preMeta, settings)
            const after = JSON.stringify(body)
            if (after !== before) ctx.preprocessedBody = after
          }
          upReq = adaptor.buildPassthroughRequest!(channel, body, upstreamModel, stream, ctx.rawHeaders)
        } else {
          // Responses 入口跨格式：previous_response_id / conversation 等有状态字段无法转换，按请求级错误直接返回
          if (entryFormat === 'responses') {
            const why = respConv.conversionBlocker(ctx.rawBody)
            if (why) throw new UpstreamError(400, JSON.stringify({ error: { message: why, type: 'invalid_request_error' } }))
          }
          let irBody = ir
          if (needPreprocess) {
            const before = JSON.stringify(ir)
            irBody = JSON.parse(before)
            applyPreprocess(irBody, preMeta, settings)
            const after = JSON.stringify(irBody)
            if (after !== before) ctx.preprocessedBody = after
          }
          // Gemini 上游：将 HTTP URL 图片下载为 data URL（Gemini 不接受外部 URL；Vertex Claude 不需要）
          if (upstreamWire === 'gemini') await resolveImageUrls(irBody, settings.proxy_url || undefined)
          upReq = adaptor.buildRequest(channel, irBody, upstreamModel, stream, { autoAdjust: settings.reasoning_auto_adjust })
        }
        // 参数修改规则：作用于发往上游的最终请求体（直通 = 客户端 body；跨格式 = 转换后的上游 body），
        // 放在 adaptor 之后才能删掉其自动补的字段（如 stream_options）
        const paramRules = matchParamRules(settings, preMeta)
        if (paramRules.length) {
          const pr = applyParamRules(upReq.body, upstreamWire, paramRules)
          for (const msg of pr.errors) console.warn(`[agghub] 参数修改规则已跳过操作: ${msg}`)
          if (pr.body != null) {
            upReq.body = pr.body
            ctx.preprocessedBody = pr.body
          }
        }
        applyUserAgent(upReq.headers, channel, ctx.rawHeaders)
        const up = await doFetch(upReq.url, upReq.headers, upReq.body, channel.timeout_ms || settings.request_timeout_ms, settings.proxy_url || undefined)
        activeUp = up
        if (!up.resp.ok) {
          const text = await up.resp.text().catch(() => '')
          ctx.upstreamRaw = text
          throw new UpstreamError(up.resp.status, text)
        }
        if (stream) {
          if (pseudo) {
            const xform = createPseudoThinkingTransform(settings, (t) => thinkingStore.save(t, settings.pseudo_thinking_store_max))
            await pipeStream(ctx, channel, adaptor, up, upstreamModel, started, retryCount, xform)
          } else if (passthrough) {
            await pipeStreamPassthrough(ctx, channel, up, upstreamModel, started, retryCount)
          } else {
            await pipeStream(ctx, channel, adaptor, up, upstreamModel, started, retryCount)
          }
        } else {
          if (pseudo) {
            const xform = (ir: any) => splitIRResponse(ir, settings, (t) => thinkingStore.save(t, settings.pseudo_thinking_store_max))
            await sendNonStream(ctx, channel, adaptor, up, upstreamModel, started, retryCount, xform)
          } else if (passthrough) {
            await sendNonStreamPassthrough(ctx, channel, up, upstreamModel, started, retryCount)
          } else {
            await sendNonStream(ctx, channel, adaptor, up, upstreamModel, started, retryCount)
          }
        }
        activeUp = null
        return // 成功
      } catch (err: any) {
        activeUp?.finish()
        activeUp = null
        lastErr = err
        const code = err instanceof UpstreamError ? err.status : null

        // 判定后续是否还会尝试 → 决定本条日志是「最终结果」(计入统计) 还是中间重试尝试
        const requestErr = isRequestError(err)
        const canRetrySame = !clientGone && !requestErr && shouldRetry(err) && attempt < singleRetry
        const hasNextChannel =
          !clientGone && !requestErr && round < channelRetry && candidates.some((c) => c.id !== channel.id && !tried.has(c.id))
        const isFinal = !canRetrySame && !hasNextChannel

        recordLog({
          channel_id: channel.id,
          channel_name: channel.name,
          entry_format: entryFormat,
          model,
          upstream_model: upstreamModel,
          status: 'error',
          status_code: code,
          latency_ms: Date.now() - started,
          retry_count: retryCount,
          is_stream: stream,
          is_retry: !isFinal,
          error_message: clientGone
            ? '客户端中断了请求'
            : err instanceof UpstreamError
              ? extractUpstreamMessage(err.body)
              : String(err?.message || err),
          request_headers: JSON.stringify(ctx.rawHeaders),
          request_body: JSON.stringify(ctx.rawBody),
          preprocessed: !!ctx.preprocessedBody,
          preprocessed_body: ctx.preprocessedBody,
          pseudo_thinking: !!ctx.pseudoThinking,
          thinking_inject: ctx.thinkingInject?.length ? JSON.stringify(ctx.thinkingInject) : undefined,
          upstream_response_body: ctx.upstreamRaw,
        })
        if (shouldDisable(err, autoBanCodes) && settings.auto_ban) setChannelStatus(channel.id, 2)
        retryCount++

        // 客户端已断开：不再重试，也无人接收错误响应
        if (clientGone) {
          try {
            res.end()
          } catch {}
          return
        }
        // 流已开始输出则无法再切换渠道/重试
        if (res.headersSent) {
          try {
            res.end()
          } catch {}
          return
        }
        // 请求级错误（参数非法/过大/无法处理）：换任何渠道都会同样失败，直接返回原始错误
        if (requestErr) {
          sendError(res, entryFormat, err)
          return
        }
        if (isFinal) break // 本渠道与其余候选渠道均已用尽
        if (intervalMs > 0) await sleep(intervalMs)
        if (!canRetrySame) break // 本渠道不再重试（非瞬时错误或次数用尽）→ 换下一个渠道
        // 否则在本渠道继续下一次重试
      }
    }
    tried.add(channel.id)
  }
  sendError(res, entryFormat, lastErr)
}

async function sendNonStream(
  ctx: RelayContext,
  channel: Channel,
  adaptor: Adaptor,
  up: UpstreamHandle,
  upstreamModel: string,
  started: number,
  retryCount: number,
  responseSplitter?: (ir: any) => any,
): Promise<void> {
  const rawText = await up.resp.text()
  up.finish()
  ctx.upstreamRaw = rawText
  const json = JSON.parse(rawText)
  let irResp = adaptor.parseResponse(json, ctx.ir.model)
  if (responseSplitter) irResp = responseSplitter(irResp)
  if (isEmptyIRResponse(irResp)) throw new UpstreamError(502, '上游返回空回复')
  const out = entryBuildResponse(ctx.entryFormat, irResp, ctx.ir)
  recordLog({
    channel_id: channel.id,
    channel_name: channel.name,
    entry_format: ctx.entryFormat,
    model: ctx.ir.model,
    upstream_model: upstreamModel,
    status: 'success',
    status_code: 200,
    latency_ms: Date.now() - started,
    prompt_tokens: irResp.usage?.prompt_tokens,
    completion_tokens: irResp.usage?.completion_tokens,
    total_tokens: irResp.usage?.total_tokens,
    ...cacheParts(irResp.usage),
    retry_count: retryCount,
    is_stream: false,
    request_headers: JSON.stringify(ctx.rawHeaders),
    request_body: JSON.stringify(ctx.rawBody),
    preprocessed: !!ctx.preprocessedBody,
    preprocessed_body: ctx.preprocessedBody,
    pseudo_thinking: !!ctx.pseudoThinking,
    thinking_inject: ctx.thinkingInject?.length ? JSON.stringify(ctx.thinkingInject) : undefined,
    response_body: JSON.stringify(out),
    upstream_response_body: rawText,
  })
  ctx.res.json(out)
}

async function pipeStream(
  ctx: RelayContext,
  channel: Channel,
  adaptor: Adaptor,
  up: UpstreamHandle,
  upstreamModel: string,
  started: number,
  retryCount: number,
  transform?: ChunkTransform,
): Promise<void> {
  const resp = up.resp
  if (!resp.body) throw new UpstreamError(502, 'no response body from upstream')
  const { res, entryFormat, ir } = ctx

  const decoder = adaptor.createStreamDecoder(ir.model)
  const encoder = entryEncoder(entryFormat, ir)
  let usage: any = null
  let responseText = ''
  let streamError: string | null = null
  let opened = false // 是否已发响应头并开始向客户端输出
  const pending: string[] = [] // opened 之前先缓冲，确认有实质内容再 flush
  const rawLines: string[] = [] // 上游 SSE 原文（逐行），供日志回看
  const flushRaw = (): void => {
    ctx.upstreamRaw = rawLines.join('\n')
  }

  const open = (): void => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()
    opened = true
    for (const s of pending) res.write(s)
    pending.length = 0
  }
  const emit = (s: string): void => {
    if (opened) res.write(s)
    else pending.push(s)
  }
  // 统一处理一个 IR chunk：累计 usage/正文、遇实质内容开流、编码输出。
  // 主循环与 decoder/transform 的 flush 都走这里，flush 阶段吐出的内容同样能触发 open，
  // 否则缓冲在 transform 里的实质内容会被误判为「上游返回空回复」而丢弃重试。
  const emitChunk = (chunk: any): void => {
    if (chunk.usage) usage = chunk.usage
    const delta = chunk.choices?.[0]?.delta
    if (typeof delta?.content === 'string') responseText += delta.content
    if (typeof delta?.refusal === 'string') responseText += delta.refusal
    if (!opened && isMeaningfulDelta(delta)) open()
    emit(encoder.encode(chunk))
  }

  try {
    for await (const ev of parseSSEEvents(resp.body as ReadableStream<Uint8Array>, (l) => rawLines.push(l))) {
      up.touch()
      if (ev.event === 'error') {
        streamError = extractUpstreamMessage(ev.data)
        break
      }
      for (const rawChunk of decoder.push(ev)) {
        const chunks = transform ? transform.transform(rawChunk) : [rawChunk]
        for (const chunk of chunks) emitChunk(chunk)
      }
    }
    for (const chunk of decoder.flush()) emitChunk(chunk)
    if (transform) {
      for (const chunk of transform.flush()) emitChunk(chunk)
    }
    // 全程无实质内容（空回复）或开头即报错 —— 尚未向客户端输出，抛回中继循环换渠道重试
    if (!opened) {
      cancelBody(resp)
      throw new UpstreamError(502, streamError || '上游返回空回复')
    }
    emit(streamError ? encoder.fail(streamError) : encoder.finalize())
  } catch (e: any) {
    if (!opened) {
      cancelBody(resp)
      throw e instanceof UpstreamError ? e : new UpstreamError(502, String(e?.message || e))
    }
    streamError = streamError || (ctx.isClientGone?.() ? '客户端中断了请求' : String(e?.message || e))
    // 已向客户端开流：发协议原生的失败事件，不能伪装成正常结束
    try {
      res.write(encoder.fail(streamError))
    } catch {}
  } finally {
    up.finish()
    flushRaw()
    if (opened) res.end()
  }

  recordLog({
    channel_id: channel.id,
    channel_name: channel.name,
    entry_format: entryFormat,
    model: ir.model,
    upstream_model: upstreamModel,
    status: streamError ? 'error' : 'success',
    status_code: streamError ? 502 : 200,
    latency_ms: Date.now() - started,
    prompt_tokens: usage?.prompt_tokens,
    completion_tokens: usage?.completion_tokens,
    total_tokens: usage?.total_tokens,
    ...cacheParts(usage),
    retry_count: retryCount,
    is_stream: true,
    error_message: streamError || undefined,
    request_headers: JSON.stringify(ctx.rawHeaders),
    request_body: JSON.stringify(ctx.rawBody),
    preprocessed: !!ctx.preprocessedBody,
    preprocessed_body: ctx.preprocessedBody,
    pseudo_thinking: !!ctx.pseudoThinking,
    thinking_inject: ctx.thinkingInject?.length ? JSON.stringify(ctx.thinkingInject) : undefined,
    response_body: responseText,
    upstream_response_body: ctx.upstreamRaw,
  })
}

/** 直通场景的 usage 归一化：按入口线格式解析上游响应体里的 usage（含缓存读写明细）*/
function passthroughUsage(fmt: EntryFormat, json: any): IRUsage {
  if (fmt === 'responses') return usageFromResponses(json?.usage)
  if (fmt === 'anthropic') return usageFromClaude(json?.usage)
  return usageFromOpenAI(json?.usage)
}

/** 直通流式的 usage 累计：返回合并后的新 usage */
function accStreamUsage(fmt: EntryFormat, d: any, acc: IRUsage): IRUsage {
  if (fmt === 'responses') {
    // 终态事件（response.completed / incomplete）携带最终 usage
    if (d?.response?.usage) return usageFromResponses(d.response.usage)
    return acc
  }
  if (fmt === 'anthropic') {
    if (d?.type === 'message_start' && d.message?.usage) return usageFromClaude(d.message.usage)
    // message_delta.usage 为累计值：output_tokens 必有，新版 API 还会带 input_tokens / 缓存字段，以其覆盖 message_start 的值
    if (d?.type === 'message_delta' && d.usage) return usageFromClaude({ ...usageToClaude(acc), ...d.usage })
    return acc
  }
  // OpenAI Chat：stream_options.include_usage 下 usage 在末尾 chunk；部分兼容上游中间 chunk 也带（累计值），逐次合并
  if (d?.usage && typeof d.usage === 'object') return mergeUsage(acc, usageFromOpenAI(d.usage))
  return acc
}

function streamDeltaText(fmt: EntryFormat, d: any): string {
  if (fmt === 'responses') return respConv.streamEventText(d)
  if (fmt === 'anthropic') {
    if (d?.type === 'content_block_delta' && d.delta?.type === 'text_delta') return d.delta.text || ''
    return ''
  }
  const c = d?.choices?.[0]?.delta?.content
  return typeof c === 'string' ? c : ''
}

// 同格式直通：上游响应原样回客户端，仅把 model 名还原成入口请求值
async function sendNonStreamPassthrough(
  ctx: RelayContext,
  channel: Channel,
  up: UpstreamHandle,
  upstreamModel: string,
  started: number,
  retryCount: number,
): Promise<void> {
  const rawText = await up.resp.text()
  up.finish()
  ctx.upstreamRaw = rawText
  const json = JSON.parse(rawText)
  if (isEmptyPassthroughBody(ctx.entryFormat, json)) throw new UpstreamError(502, '上游返回空回复')
  if (json && typeof json === 'object') json.model = ctx.ir.model
  const usage = passthroughUsage(ctx.entryFormat, json)
  recordLog({
    channel_id: channel.id,
    channel_name: channel.name,
    entry_format: ctx.entryFormat,
    model: ctx.ir.model,
    upstream_model: upstreamModel,
    status: 'success',
    status_code: 200,
    latency_ms: Date.now() - started,
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    ...cacheParts(usage),
    retry_count: retryCount,
    is_stream: false,
    request_headers: JSON.stringify(ctx.rawHeaders),
    request_body: JSON.stringify(ctx.rawBody),
    preprocessed: !!ctx.preprocessedBody,
    preprocessed_body: ctx.preprocessedBody,
    pseudo_thinking: !!ctx.pseudoThinking,
    thinking_inject: ctx.thinkingInject?.length ? JSON.stringify(ctx.thinkingInject) : undefined,
    response_body: JSON.stringify(json),
    upstream_response_body: rawText,
  })
  ctx.res.json(json)
}

async function pipeStreamPassthrough(
  ctx: RelayContext,
  channel: Channel,
  up: UpstreamHandle,
  upstreamModel: string,
  started: number,
  retryCount: number,
): Promise<void> {
  const resp = up.resp
  if (!resp.body) throw new UpstreamError(502, 'no response body from upstream')
  const { res, entryFormat, ir } = ctx

  let acc: IRUsage = emptyUsage()
  let responseText = ''
  let streamError: string | null = null
  let opened = false // 是否已发响应头并开始向客户端输出
  const pending: string[] = [] // opened 之前先缓冲，确认有实质内容再 flush
  const rawLines: string[] = [] // 上游 SSE 原文（逐行），供日志回看
  const flushRaw = (): void => {
    ctx.upstreamRaw = rawLines.join('\n')
  }

  const open = (): void => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()
    opened = true
    for (const s of pending) res.write(s)
    pending.length = 0
  }
  const emit = (s: string): void => {
    if (opened) res.write(s)
    else pending.push(s)
  }

  try {
    for await (const ev of parseSSEEvents(resp.body as ReadableStream<Uint8Array>, (l) => rawLines.push(l))) {
      up.touch()
      // 原样转发上游事件，完整保留 cache_control / thinking / citations 等字段
      const frame = (ev.event ? `event: ${ev.event}\n` : '') + `data: ${ev.data}\n\n`
      if (ev.event === 'error') {
        streamError = extractUpstreamMessage(ev.data)
        emit(frame)
        continue
      }
      try {
        const d = JSON.parse(ev.data)
        // Responses 流的错误以 response.failed / error 事件表达而非 HTTP 状态：未开流时抛回换渠道，已开流则原样转发并标记
        if (entryFormat === 'responses') {
          const errMsg = respConv.streamEventError(d)
          if (errMsg) {
            streamError = errMsg
            if (!opened) break
          }
        }
        acc = accStreamUsage(entryFormat, d, acc)
        responseText += streamDeltaText(entryFormat, d)
        if (!opened && passthroughChunkHasContent(entryFormat, d)) open()
      } catch {}
      emit(frame)
    }
    // 全程无实质内容（空回复）或开头即报错 —— 尚未向客户端输出，抛回中继循环换渠道重试
    if (!opened) {
      cancelBody(resp)
      throw new UpstreamError(502, streamError || '上游返回空回复')
    }
  } catch (e: any) {
    if (!opened) {
      cancelBody(resp)
      throw e instanceof UpstreamError ? e : new UpstreamError(502, String(e?.message || e))
    }
    streamError = streamError || (ctx.isClientGone?.() ? '客户端中断了请求' : String(e?.message || e))
  } finally {
    up.finish()
    flushRaw()
    if (opened) res.end()
  }

  recordLog({
    channel_id: channel.id,
    channel_name: channel.name,
    entry_format: entryFormat,
    model: ir.model,
    upstream_model: upstreamModel,
    status: streamError ? 'error' : 'success',
    status_code: streamError ? 502 : 200,
    latency_ms: Date.now() - started,
    prompt_tokens: acc.prompt_tokens,
    completion_tokens: acc.completion_tokens,
    total_tokens: acc.total_tokens,
    ...cacheParts(acc),
    retry_count: retryCount,
    is_stream: true,
    error_message: streamError || undefined,
    request_headers: JSON.stringify(ctx.rawHeaders),
    request_body: JSON.stringify(ctx.rawBody),
    preprocessed: !!ctx.preprocessedBody,
    preprocessed_body: ctx.preprocessedBody,
    pseudo_thinking: !!ctx.pseudoThinking,
    thinking_inject: ctx.thinkingInject?.length ? JSON.stringify(ctx.thinkingInject) : undefined,
    response_body: responseText,
    upstream_response_body: ctx.upstreamRaw,
  })
}

/** 流式 IR(OpenAI) delta 是否含实质内容（文本 / 工具调用 / 思考）*/
function isMeaningfulDelta(delta: any): boolean {
  if (!delta) return false
  if (typeof delta.content === 'string' && delta.content.length > 0) return true
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) return true
  if (typeof delta.refusal === 'string' && delta.refusal.length > 0) return true
  if (typeof delta.reasoning_redacted === 'string' && delta.reasoning_redacted.length > 0) return true
  return false
}

/** 非流式 IR(OpenAI) 响应是否为空回复（拒绝回复也是实质内容，不能当空回复重试）*/
function isEmptyIRResponse(ir: any): boolean {
  const msg = ir?.choices?.[0]?.message
  if (!msg) return true
  if (contentToText(msg.content).trim().length > 0) return false
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return false
  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim().length > 0) return false
  if (typeof msg.refusal === 'string' && msg.refusal.trim().length > 0) return false
  if (Array.isArray(msg.reasoning_items) && msg.reasoning_items.length > 0) return false
  return true
}

/** 同格式直通：非流式响应体是否为空回复 */
function isEmptyPassthroughBody(fmt: EntryFormat, json: any): boolean {
  if (!json || typeof json !== 'object') return true
  if (fmt === 'responses') return respConv.isEmptyResponseBody(json)
  if (fmt === 'anthropic') {
    for (const b of Array.isArray(json.content) ? json.content : []) {
      if (b?.type === 'text' && (b.text || '').trim().length > 0) return false
      if (b?.type === 'tool_use') return false
      if (b?.type === 'thinking' && (b.thinking || '').trim().length > 0) return false
      if (b?.type === 'redacted_thinking') return false
    }
    return json.stop_reason !== 'refusal'
  }
  const msg = json.choices?.[0]?.message
  if (!msg) return true
  if (contentToText(msg.content).trim().length > 0) return false
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return false
  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim().length > 0) return false
  if (typeof msg.refusal === 'string' && msg.refusal.trim().length > 0) return false
  return true
}

/** 同格式直通：流式事件是否含实质内容 */
function passthroughChunkHasContent(fmt: EntryFormat, d: any): boolean {
  if (!d) return false
  if (fmt === 'responses') return respConv.streamEventHasContent(d)
  if (fmt === 'anthropic') {
    if (d.type === 'content_block_start') return d.content_block?.type === 'tool_use'
    if (d.type === 'content_block_delta') {
      const dt = d.delta?.type
      if (dt === 'text_delta') return (d.delta.text || '').length > 0
      if (dt === 'thinking_delta') return (d.delta.thinking || '').length > 0
      if (dt === 'input_json_delta') return true
    }
    return false
  }
  return isMeaningfulDelta(d.choices?.[0]?.delta)
}

function sendError(res: Response, entryFormat: EntryFormat, err: any): void {
  const status = err instanceof UpstreamError ? err.status : 502
  const message = err instanceof UpstreamError ? extractUpstreamMessage(err.body) : String(err?.message || err || 'relay failed')
  sendErrorMessage(res, entryFormat, status, message)
}

function sendErrorMessage(res: Response, entryFormat: EntryFormat, status: number, message: string): void {
  if (res.headersSent) {
    try {
      res.end()
    } catch {}
    return
  }
  if (entryFormat === 'anthropic') {
    res.status(status).json({ type: 'error', error: { type: 'api_error', message } })
  } else {
    res.status(status).json({ error: { message, type: 'upstream_error', code: status } })
  }
}
