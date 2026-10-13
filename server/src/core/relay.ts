import { randomUUID } from 'node:crypto'
import type { Response } from 'express'
import { getSettings } from '../db'
import { getAdaptor } from '../adapters'
import type { Adaptor, UpstreamRequest } from '../adapters'
import type { UpstreamContext } from '../adapters/base'
import { resolveImageUrls } from './imageResolver'
import { getProxyAgent } from './proxy'
import { candidatesForModel, resolveUpstreamModel, selectChannel } from './selector'
import { LocalRequestError, UpstreamError, errorKind, extractUpstreamMessage, parseAutoBanCodes, sanitizePublicError, shouldDisable, shouldRetry } from './failover'
import type { ErrorKind } from './failover'
import { applyPreprocess } from './preprocess'
import { safeRecordLog, type LogEntry } from '../stats/recorder'
import { estimatePromptTokens, parseSSEEvents } from '../convert/ir'
import * as oaiConv from '../convert/openai'
import * as anthConv from '../convert/anthropic'
import * as respConv from '../convert/responses'
import { cacheParts, emptyUsage } from '../convert/usage'
import type { Caller, Channel, EntryFormat, IRUsage, Settings } from '../types'
import { applyParamRules, matchParamRules } from './paramRules'
import { applySingleRole } from './singleRole'
import { matchesPseudoThinking, applyPseudoThinkingRequest, createPseudoThinkingTransform, splitIRResponse } from './pseudoThinking'
import type { ChunkTransform, ThinkingInjectEntry } from './pseudoThinking'
import * as thinkingStore from './thinkingStore'
import { AttemptLifecycle, RequestLifecycle, RequestStopped, sleep } from './requestLifecycle'
import { BoundedCapture } from './capture'
import { ResponsesSseLog, logResponsesBody } from './upstreamLog'
import { readBodyText } from './bodyReader'
import { createStreamWriter } from './streamWriter'
import { StreamState, meaningfulDelta } from './streamState'
import { accumulateUsage, isEmptyIRResponse, isEmptyPassthroughBody, passthroughUsage, streamDeltaText } from './responseSemantics'
import { OWNER_CALLER, callerSettings } from './caller'
import { OutputMeter, estimateIRPrompt, findRatio, settleRequest } from './billing'
import { onAttemptSuccess, onBanSignal } from './channelHealth'

respConv.setReasoningStore({
  save: items => thinkingStore.saveReasoning(items, getSettings().reasoning_store_max),
  lookup: sig => thinkingStore.lookupReasoning(sig),
})

export interface RelayContext {
  entryFormat: EntryFormat
  ir: any
  stream: boolean
  readonly rawBody: any
  rawHeaders?: Record<string, any>
  res: Response
  /** 鉴权中间件解析的调用方；缺省视为内网 owner */
  caller?: Caller
}

interface AttemptState extends UpstreamContext {
  channel: Channel
  adaptor: Adaptor
  passthrough: boolean
  lifecycle: AttemptLifecycle
  upstream: BoundedCapture
  response: BoundedCapture
  usage: IRUsage
  preprocessedBody?: string
  preprocessed?: boolean
  pseudo: boolean
  thinkingInject?: ThinkingInjectEntry[]
  /** 输出计量，usage 缺失时用于估算计费 */
  meter: OutputMeter
}

interface Outcome {
  status: 'success' | 'error'
  code: number
  error?: string
  /** 错误来源，公网脱敏按此区分 */
  kind?: ErrorKind
  usage: IRUsage
}

function errorOutcome(error: unknown): Outcome {
  const code = error instanceof UpstreamError || error instanceof LocalRequestError ? error.status
    : error instanceof RequestStopped ? error.reason === 'client_cancel' ? 499 : 504 : 502
  const message = error instanceof UpstreamError ? extractUpstreamMessage(error.body)
    : error instanceof Error ? error.message : String(error || 'relay failed')
  return { status: 'error', code, error: message, kind: errorKind(error), usage: emptyUsage() }
}

/** 返回给客户端的错误信息：公网端口脱敏，日志仍记录原文 */
function clientError(caller: Caller, outcome: Outcome): string {
  return caller.surface === 'public' ? sanitizePublicError(outcome.kind ?? 'local', outcome.error!) : outcome.error!
}

/** 计量 IR 增量 / 消息里的全部输出文本（正文、拒绝、推理、工具参数） */
function meterIR(meter: OutputMeter, part: any): void {
  if (!part) return
  meter.append(part.content)
  meter.append(part.refusal)
  meter.append(part.reasoning_content)
  for (const call of Array.isArray(part.tool_calls) ? part.tool_calls : []) meter.append(call?.function?.arguments)
}

/** 计量直通 SSE 事件里的输出文本 */
function meterPassthrough(meter: OutputMeter, format: EntryFormat, data: any): void {
  if (format === 'anthropic') {
    const delta = data?.type === 'content_block_delta' ? data.delta : null
    meter.append(delta?.text)
    meter.append(delta?.thinking)
    meter.append(delta?.partial_json)
  } else if (format === 'responses') {
    if (typeof data?.type === 'string' && data.type.endsWith('.delta')) meter.append(data.delta)
  } else {
    for (const choice of data?.choices || []) meterIR(meter, choice.delta)
  }
}

function entryBuildResponse(format: EntryFormat, response: any, ir: any): any {
  if (format === 'anthropic') return anthConv.buildResponse(response)
  if (format === 'responses') return respConv.buildResponse(response, { model: ir?.model, customToolNames: ir?.custom_tool_names })
  return oaiConv.buildResponse(response)
}

function entryEncoder(format: EntryFormat, ir: any) {
  if (format === 'anthropic') return anthConv.createStreamEncoder({ estimatePromptTokens: estimatePromptTokens(ir) })
  if (format === 'responses') return respConv.createStreamEncoder({ model: ir?.model, customToolNames: ir?.custom_tool_names })
  return oaiConv.createStreamEncoder()
}

function applyUserAgent(headers: Record<string, string>, channel: Channel, rawHeaders?: Record<string, any>): void {
  if (channel.ua_override && channel.ua_value) headers['user-agent'] = channel.ua_value
  else if (!channel.strip_headers && rawHeaders?.['user-agent']) headers['user-agent'] = String(rawHeaders['user-agent'])
}

async function prepareRequest(ctx: RelayContext, state: AttemptState, settings: Settings, caller: Caller): Promise<UpstreamRequest> {
  const { channel, adaptor, upstreamModel, upstreamWire, lifecycle } = state
  if (adaptor.prepareChannel) {
    await adaptor.prepareChannel(channel, settings.proxy_url || undefined, lifecycle.signal)
    lifecycle.touch()
  }
  const meta = {
    entryFormat: ctx.entryFormat, channelId: channel.id, model: state.requestedModel, passthrough: state.passthrough,
    source: caller.source, keyId: caller.key?.id ?? null,
  }
  const source = state.passthrough ? ctx.rawBody : ctx.ir
  // 每次尝试独立复制；预处理与图片下载均不能回写原始请求或其他候选的输入。
  const body = structuredClone(source)
  const preprocess = settings.strip_top_p || settings.drop_thinking || settings.drop_redacted_thinking || settings.preprocess_rules.length || settings.tool_filter_rules.length || state.pseudo
  if (state.pseudo) state.thinkingInject = applyPseudoThinkingRequest(body, settings, thinkingStore.lookup)
  if (preprocess) applyPreprocess(body, meta, settings)
  const images = !state.passthrough && upstreamWire === 'gemini'
  if (images) await resolveImageUrls(body, settings, lifecycle.signal, { restrictPrivate: caller.surface === 'public' })
  let changed = (!!preprocess || images) && JSON.stringify(body) !== JSON.stringify(source)
  const request = state.passthrough
    ? adaptor.buildPassthroughRequest!(channel, body, upstreamModel, ctx.stream, ctx.rawHeaders)
    : adaptor.buildRequest(channel, body, upstreamModel, ctx.stream)
  if (channel.single_role) {
    const upstreamBody = JSON.parse(request.body)
    const options = { mergeSystem: channel.single_role_merge_system, excludeLastUser: channel.single_role_exclude_last_user }
    if (applySingleRole(upstreamBody, upstreamWire, channel.single_role, options)) {
      request.body = JSON.stringify(upstreamBody)
      changed = true
    }
  }
  const rules = matchParamRules(settings, meta)
  if (rules.length) {
    const result = applyParamRules(request.body, upstreamWire, rules)
    for (const message of result.errors) console.warn(`[agghub] 参数操作已跳过: ${message}`)
    if (result.body !== null) { request.body = result.body; changed = true }
  }
  state.preprocessed = changed
  if (changed && settings.store_request_body) state.preprocessedBody = request.body
  applyUserAgent(request.headers, channel, ctx.rawHeaders)
  return request
}

/** 四条响应路径只负责业务及元数据；请求级 finally 统一提交唯一最终日志。 */
export async function handleRelay(ctx: RelayContext): Promise<void> {
  const caller = ctx.caller ?? OWNER_CALLER
  const settings = callerSettings(getSettings(), caller)
  const lifecycle = new RequestLifecycle(ctx.res, settings.request_max_duration_ms)
  const requestId = randomUUID()
  const model = ctx.ir?.model
  const autoBanCodes = parseAutoBanCodes(settings.auto_ban_codes)
  let final = errorOutcome(new Error('没有成功的上游尝试'))
  let last: AttemptState | undefined
  let attempts = 0
  let attemptMs: number | null = null
  let rawJson: string | undefined
  let headersJson: string | undefined
  const isClientGone = () => lifecycle.signal.reason instanceof RequestStopped && lifecycle.signal.reason.reason === 'client_cancel'

  const record = (outcome: Outcome, intermediate: boolean, points: number | null = null): void => {
    safeRecordLog((): LogEntry => {
      if (settings.store_request_body) {
        rawJson ??= JSON.stringify(ctx.rawBody)
        headersJson ??= JSON.stringify(ctx.rawHeaders)
      }
      return {
        request_id: requestId, channel_id: last?.channel.id ?? null, channel_name: last?.channel.name ?? null,
        entry_format: ctx.entryFormat, model: typeof model === 'string' ? model : null, upstream_model: last?.upstreamModel ?? null,
        status: outcome.status, status_code: outcome.code, error_message: outcome.error,
        latency_ms: intermediate ? attemptMs : lifecycle.elapsed, attempt_latency_ms: attemptMs,
        ...outcome.usage, ...cacheParts(outcome.usage), retry_count: Math.max(0, attempts - 1), is_stream: ctx.stream, is_retry: intermediate,
        request_body: rawJson, request_headers: headersJson,
        preprocessed: last?.preprocessed, preprocessed_body: last?.preprocessedBody,
        pseudo_thinking: last?.pseudo, thinking_inject: settings.store_request_body && last?.thinkingInject?.length ? JSON.stringify(last.thinkingInject) : undefined,
        response_body: last?.response.text(), upstream_response_body: last?.upstream.text(),
        response_body_truncated: last?.response.truncated, upstream_response_body_truncated: last?.upstream.truncated,
        source: caller.source, key_id: caller.key?.id ?? null, key_name: caller.key?.name ?? null, client_ip: caller.ip, quota_points: points,
      }
    }, settings, requestId)
  }

  try {
    lifecycle.signal.throwIfAborted()
    if (typeof model !== 'string' || !model.trim()) throw new LocalRequestError('model is required')
    if (caller.key && !findRatio(settings.model_ratios, model)) throw new LocalRequestError('该模型未配置倍率', 403)
    const modelCandidates = candidatesForModel(model, caller)
    if (!modelCandidates.length) throw new LocalRequestError(`没有可用渠道支持模型 ${model}`, 503)
    const blocker = ctx.entryFormat === 'responses' ? respConv.conversionBlocker(ctx.rawBody) : null
    const descriptions = new Map(modelCandidates.map(channel => {
      const adaptor = getAdaptor(channel.type)
      const upstreamModel = resolveUpstreamModel(channel, model)
      const upstreamWire = adaptor.resolveWireFormat?.(upstreamModel) ?? adaptor.wireFormat
      return [channel.id, { adaptor, upstreamModel, upstreamWire, passthrough: !!adaptor.buildPassthroughRequest && upstreamWire === ctx.entryFormat }]
    }))
    const candidates = modelCandidates.filter(channel => !blocker || descriptions.get(channel.id)!.passthrough)
    if (!candidates.length) throw new LocalRequestError(blocker || '没有兼容请求能力的渠道')
    const tried = new Set<number>()
    // 本次请求中被熔断的渠道；候选快照在请求开始时确定，不再逐轮查库
    const banned = new Set<number>()
    const available = () => candidates.filter(c => !banned.has(c.id))
    for (let round = 0; round <= settings.channel_retry_times; round++) {
      const channel = selectChannel(available(), tried)
      if (!channel) break
      const description = descriptions.get(channel.id)!
      for (let index = 0; index <= settings.single_retry_times; index++) {
        lifecycle.signal.throwIfAborted()
        const attempt = new AttemptLifecycle(lifecycle.signal, channel.timeout_ms || settings.request_timeout_ms)
        const state: AttemptState = {
          ...description, requestedModel: model, channel, lifecycle: attempt,
          usage: emptyUsage(),
          upstream: new BoundedCapture(settings.store_response_body, settings.log_response_max_bytes),
          response: new BoundedCapture(settings.store_response_body, settings.log_response_max_bytes),
          pseudo: description.passthrough && matchesPseudoThinking(ctx.entryFormat, description.upstreamWire, channel.id, model, settings),
          meter: new OutputMeter(),
        }
        last = state
        attempts++
        let response: globalThis.Response | undefined
        let retrySame = false
        try {
          const request = await prepareRequest(ctx, state, settings, caller)
          attempt.touch()
          const options: any = { method: 'POST', headers: request.headers, body: request.body, signal: attempt.signal }
          if (settings.proxy_url) options.dispatcher = getProxyAgent(settings.proxy_url)
          response = await fetch(request.url, options)
          if (!response.ok) {
            const text = await readBodyText(response.body, {
              signal: attempt.signal, maxBytes: 64 * 1024, truncate: true,
              onTruncate: () => { state.upstream.truncated = settings.store_response_body },
              onBytes: bytes => { attempt.touch(); state.upstream.append(bytes) },
            })
            throw new UpstreamError(response.status, text)
          }
          final = ctx.stream
            ? await pipeResponse(ctx, state, response, settings, lifecycle.signal, caller)
            : await sendResponse(ctx, state, response, settings)
          onAttemptSuccess(channel.id)
          return
        } catch (caught) {
          const error = attempt.signal.aborted ? attempt.signal.reason : caught
          final = { ...errorOutcome(error), usage: state.usage }
          attemptMs = attempt.elapsed
          if (!lifecycle.signal.aborted && settings.auto_ban && shouldDisable(error, autoBanCodes) && onBanSignal(channel.id, settings)) {
            banned.add(channel.id)
          }
          // 只有本地确定的输入错误阻止跨渠道尝试；上游 400/413/422 仍可能由备用渠道处理
          const canContinue = !lifecycle.signal.aborted && !ctx.res.headersSent && !(error instanceof LocalRequestError)
          retrySame = canContinue && !banned.has(channel.id) && shouldRetry(error) && index < settings.single_retry_times
          const nextChannel = canContinue && round < settings.channel_retry_times && available().some(c => c.id !== channel.id && !tried.has(c.id))
          if (!retrySame && !nextChannel) {
            if (!isClientGone()) sendErrorMessage(ctx.res, ctx.entryFormat, final.code, clientError(caller, final))
            return
          }
          record(final, true)
        } finally {
          attemptMs = attempt.elapsed
          attempt.dispose()
          if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {})
        }
        if (settings.retry_interval_ms > 0) await sleep(settings.retry_interval_ms, lifecycle.signal)
        if (!retrySame) break
      }
      tried.add(channel.id)
    }
    lifecycle.signal.throwIfAborted()
    sendErrorMessage(ctx.res, ctx.entryFormat, final.code, clientError(caller, final))
  } catch (error) {
    final = errorOutcome(lifecycle.signal.aborted ? lifecycle.signal.reason : error)
    if (!isClientGone()) sendErrorMessage(ctx.res, ctx.entryFormat, final.code, clientError(caller, final))
  } finally {
    const points = settleRequest({
      caller, model: typeof model === 'string' ? model : null, ratios: settings.model_ratios, usage: final.usage,
      meter: last?.meter ?? null, estimatePrompt: () => estimateIRPrompt(ctx.ir), success: final.status === 'success',
    })
    record(final, false, points)
    lifecycle.dispose()
  }
}

async function sendResponse(ctx: RelayContext, state: AttemptState, response: globalThis.Response, settings: Settings): Promise<Outcome> {
  const raw = await readBodyText(response.body, {
    signal: state.lifecycle.signal, maxBytes: settings.stream_buffer_max_bytes,
    onTruncate: () => { state.upstream.truncated = settings.store_response_body },
    onBytes: bytes => { state.lifecycle.touch(); state.upstream.append(bytes) },
  })
  state.lifecycle.signal.throwIfAborted()
  const json = JSON.parse(raw)
  if (state.upstreamWire === 'responses') logResponsesBody(state.upstream, json)
  let output: any
  if (state.passthrough && !state.pseudo) {
    if (isEmptyPassthroughBody(ctx.entryFormat, json)) throw new UpstreamError(502, '上游返回空回复')
    json.model = state.requestedModel
    state.usage = passthroughUsage(ctx.entryFormat, json)
    // 直通 JSON 不逐字段解析，usage 缺失时按整段文本保守估算
    state.meter.append(raw)
    output = json
  } else {
    let ir = state.adaptor.parseResponse(json, state)
    if (state.pseudo) ir = splitIRResponse(ir, settings, text => thinkingStore.save(text, settings.pseudo_thinking_store_max))
    if (isEmptyIRResponse(ir)) throw new UpstreamError(502, '上游返回空回复')
    for (const choice of ir.choices || []) meterIR(state.meter, choice.message)
    ir.model = state.requestedModel
    state.usage = ir.usage || emptyUsage()
    output = entryBuildResponse(ctx.entryFormat, ir, ctx.ir)
  }
  const text = JSON.stringify(output)
  state.response.append(text)
  state.lifecycle.signal.throwIfAborted()
  ctx.res.type('json').send(text)
  return { status: 'success', code: 200, usage: state.usage }
}

async function pipeResponse(ctx: RelayContext, state: AttemptState, response: globalThis.Response, settings: Settings, requestSignal: AbortSignal, caller: Caller): Promise<Outcome> {
  if (!response.body) throw new UpstreamError(502, 'no response body from upstream')
  const passthrough = state.passthrough && !state.pseudo
  const decoder = passthrough ? null : state.adaptor.createStreamDecoder(state)
  const encoder = entryEncoder(ctx.entryFormat, ctx.ir)
  const transform: ChunkTransform | undefined = state.pseudo
    ? createPseudoThinkingTransform(settings, text => thinkingStore.save(text, settings.pseudo_thinking_store_max)) : undefined
  const observer = new StreamState(state.upstreamWire)
  const write = createStreamWriter(ctx.res, requestSignal, state.lifecycle)
  const upstreamLog = state.upstreamWire === 'responses' ? new ResponsesSseLog(state.upstream) : state.upstream
  let pending: string[] = []
  let opened = false
  let errorForwarded = false
  const open = async (): Promise<void> => {
    if (opened) return
    requestSignal.throwIfAborted()
    ctx.res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    ctx.res.setHeader('Cache-Control', 'no-cache')
    ctx.res.setHeader('Connection', 'keep-alive')
    ctx.res.setHeader('X-Accel-Buffering', 'no')
    ctx.res.flushHeaders?.()
    opened = true
    for (const frame of pending) await write(frame)
    pending = []
  }
  const emit = async (frame: string): Promise<void> => {
    if (!frame) return
    if (opened) await write(frame)
    else pending.push(frame)
  }
  const emitChunk = async (chunk: any): Promise<void> => {
    if (chunk.usage) state.usage = chunk.usage
    chunk.model = state.requestedModel
    for (const choice of chunk.choices || []) {
      const delta = choice.delta
      if (typeof delta?.content === 'string') state.response.append(delta.content)
      if (typeof delta?.refusal === 'string') state.response.append(delta.refusal)
      meterIR(state.meter, delta)
      if (meaningfulDelta(delta)) await open()
    }
    await emit(encoder.encode(chunk))
  }
  try {
    for await (const event of parseSSEEvents(response.body, undefined, {
      signal: state.lifecycle.signal,
      onBytes: bytes => { state.lifecycle.touch(); upstreamLog.append(bytes) },
    })) {
      const data = observer.observe(event)
      if (observer.failed) {
        // 公网端口不原样转发上游错误事件，统一走下方脱敏后的 encoder.fail
        if (opened && passthrough && caller.surface !== 'public') {
          await write((event.event ? `event: ${event.event}\n` : '') + `data: ${event.data.replace(/\n/g, '\ndata: ')}\n\n`)
          errorForwarded = true
        }
        throw new UpstreamError(502, observer.failed)
      }
      if (passthrough) {
        state.usage = accumulateUsage(ctx.entryFormat, data, state.usage)
        state.response.append(streamDeltaText(ctx.entryFormat, data))
        meterPassthrough(state.meter, ctx.entryFormat, data)
        if (observer.content) await open()
        await emit((event.event ? `event: ${event.event}\n` : '') + `data: ${event.data.replace(/\n/g, '\ndata: ')}\n\n`)
      } else {
        for (const rawChunk of decoder!.push(event)) {
          for (const chunk of transform ? transform.transform(rawChunk) : [rawChunk]) await emitChunk(chunk)
        }
      }
      if (observer.closed) break
    }
    observer.assertComplete()
    if (decoder) for (const chunk of decoder.flush()) await emitChunk(chunk)
    if (transform) for (const chunk of transform.flush()) await emitChunk(chunk)
    if (!opened) await open()
    if (!passthrough) await emit(encoder.finalize())
    return { status: 'success', code: 200, usage: state.usage }
  } catch (caught) {
    const error = state.lifecycle.signal.aborted ? state.lifecycle.signal.reason : caught
    if (opened && !errorForwarded && !requestSignal.aborted) {
      try { await write(encoder.fail(clientError(caller, errorOutcome(error)))) } catch {}
    }
    throw error
  } finally {
    if (upstreamLog instanceof ResponsesSseLog) upstreamLog.flush()
    if (opened && !ctx.res.writableEnded) ctx.res.end()
  }
}

function sendErrorMessage(res: Response, entryFormat: EntryFormat, status: number, message: string): void {
  if (res.destroyed || res.writableEnded) return
  if (res.headersSent) { res.end(); return }
  if (entryFormat === 'anthropic') res.status(status).json({ type: 'error', error: { type: 'api_error', message } })
  else res.status(status).json({ error: { message, type: 'upstream_error', code: status } })
}
