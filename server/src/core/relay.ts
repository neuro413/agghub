import { randomUUID } from 'node:crypto'
import type { Response } from 'express'
import { getSettings } from '../db'
import { getAdaptor } from '../adapters'
import type { Adaptor, UpstreamRequest } from '../adapters'
import type { UpstreamContext } from '../adapters/base'
import { resolveImageUrls } from './imageResolver'
import { getProxyAgent } from './proxy'
import { candidateGroups, candidatesForModel, resolveUpstreamModel, selectChannel, uaBlacklistBlock } from './selector'
import { acquireNode, noNodeMessage, type Lease } from '../pool/select'
import { getPoolSettings } from '../pool/settings'
import { CandidateError, LocalRequestError, UpstreamError, UpstreamResponseError, errorKind, extractUpstreamMessage, parseAutoBanCodes, parseRetryAfter, sanitizePublicError, shouldDisable, shouldRetry, statusOnlyMessage } from './failover'
import type { ErrorKind } from './failover'
import { applyPreprocess } from './preprocess'
import { safeRecordLog, type LogEntry } from '../stats/recorder'
import { estimatePromptTokens, parseSSEEvents } from '../convert/ir'
import * as oaiConv from '../convert/openai'
import * as anthConv from '../convert/anthropic'
import * as respConv from '../convert/responses'
import * as gemConv from '../convert/gemini'
import { cacheParts, emptyUsage, maxUsage, rawWireUsage, sumUsage } from '../convert/usage'
import type { Caller, Channel, ChannelGroup, EntryFormat, IRUsage, Settings } from '../types'
import { applyParamRules, matchParamRules } from './paramRules'
import { applySingleRole } from './singleRole'
import { matchesPseudoThinking, applyPseudoThinkingRequest, createPseudoThinkingTransform, splitIRResponse } from './pseudoThinking'
import type { ChunkTransform, ThinkingInjectEntry } from './pseudoThinking'
import * as thinkingStore from './thinkingStore'
import { AttemptLifecycle, RequestLifecycle, RequestStopped, sleep } from './requestLifecycle'
import { BoundedCapture } from './capture'
import { ResponsesSseLog, logResponsesBody } from './upstreamLog'
import { readBodyText } from './bodyReader'
import { StreamKeepAlive, createStreamWriter, openEventStream } from './streamWriter'
import { StreamState, meaningfulDelta } from './streamState'
import { accumulateUsage, isEmptyIRResponse, isEmptyPassthroughBody, passthroughUsage, streamDeltaText } from './responseSemantics'
import { OWNER_CALLER, callerSettings } from './caller'
import { OutputMeter, accountOf, estimateIRPrompt, estimateReservePoints, findRatio, settleRequest } from './billing'
import type { BillingAccount } from './billing'
import { reserveQuota, reservedPoints } from './quotaLedger'
import { getKeyById } from './keys'
import { getUserById } from './users'
import { onAttemptSuccess, onBanSignal } from './channelHealth'
import { availableKeys, keyLabel, onKeyFailure, onKeySuccess, pickRaceKeys } from './channelKeys'
import { createRequestCompressor, isCompressionRejection, markUnsupported } from './upstreamCompression'
import type { CompressionInfo, RequestCompressor } from './upstreamCompression'
import { FAKE_STREAM_PING_MS, fakeStreamEvents } from './fakeStream'

respConv.setReasoningStore({
  save: items => thinkingStore.saveReasoning(items, getSettings().reasoning_store_max),
  lookup: sig => thinkingStore.lookupReasoning(sig),
})
gemConv.setSignatureStore({
  save: (callId, name, signature) => thinkingStore.saveGeminiSignature(callId, name, signature, getSettings().reasoning_store_max),
  lookup: (callId, name) => thinkingStore.lookupGeminiSignature(callId, name),
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
  /** 是否已通过生成接口的准入中间件；缺省表示未经准入 */
  admitted?: boolean
}

/** 模型名会写进错误信息与日志并参与脱敏，长度必须设上界 */
const MAX_MODEL_LENGTH = 256

/** 预扣时的可用额度：现查库，避免鉴权时的快照漏掉期间已结算的扣费；不限额返回 Infinity */
function availableQuota(caller: Caller, account: BillingAccount): number {
  if (account.type === 'user') return getUserById(account.id)?.quota ?? 0
  const key = getKeyById(account.id) ?? caller.key!
  return key.quota_total == null ? Number.POSITIVE_INFINITY : key.quota_total - key.quota_used
}

interface AttemptState extends UpstreamContext {
  /** 多 key 渠道为替换成本次 key 的副本 */
  channel: Channel
  /** 本次使用的上游 key */
  key: string
  /** 写进日志的 key 标识；单 key 渠道为 null */
  keyLabel: string | null
  /** 并发竞速时向下游输出前调用：返回 false 表示其他 key 已胜出 */
  claim?: () => boolean
  /** 本次尝试结束时的耗时 */
  elapsedMs?: number
  /** 首个有效内容（含思考）开始向客户端输出的时刻（performance.now） */
  firstTokenAt?: number
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
  /** 请求是否已经发往上游 */
  sent?: boolean
  /** 上游请求体压缩明细，写进日志 */
  compression?: CompressionInfo
  /** 代理池节点名；本次尝试换过节点时按顺序用「 → 」连接 */
  proxyNode?: string
  /** 假流式：客户端要流式、渠道开启假流式，本次尝试按非流式请求上游 */
  fakeStream: boolean
}

type Description = Pick<AttemptState, 'adaptor' | 'upstreamModel' | 'upstreamWire' | 'passthrough'>

interface Outcome {
  status: 'success' | 'error'
  code: number
  error?: string
  /** 错误来源，公网脱敏按此区分 */
  kind?: ErrorKind
  usage: IRUsage
}

function errorOutcome(error: unknown): Outcome {
  const code = error instanceof UpstreamError || error instanceof LocalRequestError || error instanceof UpstreamResponseError ? error.status
    : error instanceof RequestStopped ? error.reason === 'client_cancel' ? 499 : 504 : 502
  const message = error instanceof UpstreamError ? extractUpstreamMessage(error.body)
    : error instanceof Error ? error.message : String(error || 'relay failed')
  return { status: 'error', code, error: message, kind: errorKind(error), usage: emptyUsage() }
}

/** 返回给客户端的错误信息：公网端口脱敏，开启「脱敏上游报错」后上游与网络错误只留状态码；日志仍记录原文 */
function clientError(caller: Caller, outcome: Outcome, settings: Settings): string {
  if (caller.surface !== 'public') return outcome.error!
  const kind = outcome.kind ?? 'local'
  if (settings.mask_upstream_errors && kind !== 'local' && !parseAutoBanCodes(settings.mask_upstream_errors_exclude_codes).includes(outcome.code)) {
    return statusOnlyMessage(outcome.code)
  }
  return sanitizePublicError(kind, outcome.error!)
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

/** 多 key 并发竞速：第一个准备向下游输出的尝试胜出，其余尝试立即中断 */
function startRace(states: AttemptState[]): void {
  let winner: AttemptState | null = null
  for (const state of states) {
    state.claim = () => {
      if (winner) return winner === state
      winner = state
      for (const other of states) if (other !== state) other.lifecycle.cancel(new RequestStopped('race_lost'))
      return true
    }
  }
}

function isRaceLost(error: unknown): boolean {
  return error instanceof RequestStopped && error.reason === 'race_lost'
}

export function applyUserAgent(headers: Record<string, string>, channel: Channel, rawHeaders?: Record<string, any>): void {
  if (channel.ua_override && channel.ua_value) headers['user-agent'] = channel.ua_value
  else if (!channel.strip_headers && rawHeaders?.['user-agent']) headers['user-agent'] = String(rawHeaders['user-agent'])
}

async function prepareRequest(ctx: RelayContext, state: AttemptState, settings: Settings, caller: Caller, proxyUrl: string | undefined): Promise<UpstreamRequest> {
  const { channel, adaptor, upstreamModel, upstreamWire, lifecycle } = state
  if (adaptor.prepareChannel) {
    // Vertex 换 token 与正式请求走同一出口（代理池节点或全局代理）
    await adaptor.prepareChannel(channel, proxyUrl, lifecycle.signal)
    lifecycle.touch()
  }
  const meta = {
    entryFormat: ctx.entryFormat, channelId: channel.id, model: state.requestedModel, passthrough: state.passthrough,
    source: caller.source, keyId: caller.key?.id ?? null,
  }
  const source = state.passthrough ? ctx.rawBody : ctx.ir
  // 每次尝试独立复制；预处理与图片下载均不能回写原始请求或其他候选的输入。
  const body = structuredClone(source)
  const preprocess = settings.drop_thinking || settings.drop_redacted_thinking || settings.preprocess_rules.length || settings.tool_filter_rules.length || state.pseudo
  if (state.pseudo) state.thinkingInject = applyPseudoThinkingRequest(body, settings, thinkingStore.lookup)
  if (preprocess) applyPreprocess(body, meta, settings)
  const images = !state.passthrough && upstreamWire === 'gemini'
  if (images) await resolveImageUrls(body, settings, lifecycle.signal, { restrictPrivate: caller.surface === 'public' })
  let changed = (!!preprocess || images) && JSON.stringify(body) !== JSON.stringify(source)
  const upstreamStream = ctx.stream && !state.fakeStream
  const request = state.passthrough
    ? adaptor.buildPassthroughRequest!(channel, body, upstreamModel, upstreamStream, ctx.rawHeaders)
    : adaptor.buildRequest(channel, body, upstreamModel, upstreamStream)
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
  const keepAlive = ctx.stream && settings.stream_keepalive_ms > 0 ? new StreamKeepAlive(ctx.res, settings.stream_keepalive_ms) : undefined
  const requestId = randomUUID()
  const model = ctx.ir?.model
  // 超长模型名只截断写日志，不参与计费匹配
  const loggedModel = typeof model === 'string' ? model.slice(0, MAX_MODEL_LENGTH) : null
  const billedModel = typeof model === 'string' && model.length <= MAX_MODEL_LENGTH ? model : null
  const autoBanCodes = parseAutoBanCodes(settings.auto_ban_codes)
  let final = errorOutcome(new Error('没有成功的上游尝试'))
  let last: AttemptState | undefined
  let attempts = 0
  let rawJson: string | undefined
  let headersJson: string | undefined
  // 候选渠道 → 计费分组；owner 调用为空
  let groupOf = new Map<number, ChannelGroup>()
  // 计费累计：每次到达结算的尝试只计一次；竞速落选的尝试不会进到这里（README「竞速落选不计费」）
  const billed = new Set<AttemptState>()
  let billedUsage = emptyUsage()
  const bill = (state: AttemptState | undefined, usage: IRUsage): void => {
    if (!state || billed.has(state)) return
    billed.add(state)
    billedUsage = sumUsage(billedUsage, usage)
  }
  let releaseReserve: (() => void) | undefined
  // 重试、换渠道与多 key 竞速共用：请求体相同时只压缩一次
  const compressor = createRequestCompressor()
  const isClientGone = () => lifecycle.signal.reason instanceof RequestStopped && lifecycle.signal.reason.reason === 'client_cancel'

  const record = (outcome: Outcome, intermediate: boolean, state = last, points: number | null = null): Promise<boolean> => {
    bill(state, outcome.usage)
    const attemptMs = state?.elapsedMs ?? null
    return safeRecordLog((): LogEntry => {
      if (settings.store_request_body) {
        rawJson ??= JSON.stringify(ctx.rawBody)
        headersJson ??= JSON.stringify(ctx.rawHeaders)
      }
      // 最终结果的错误被脱敏改写时记下客户端实际收到的文本，日志页据此标「已改写」
      const shown = !intermediate && outcome.status === 'error' ? clientError(caller, outcome, settings) : undefined
      return {
        request_id: requestId, channel_id: state?.channel.id ?? null, channel_name: state?.channel.name ?? null,
        entry_format: ctx.entryFormat, model: loggedModel, upstream_model: state?.upstreamModel ?? null,
        status: outcome.status, status_code: outcome.code, error_message: outcome.error,
        client_error: shown !== undefined && shown !== outcome.error ? shown : null,
        latency_ms: intermediate ? attemptMs : lifecycle.elapsed, attempt_latency_ms: attemptMs,
        first_token_ms: state?.firstTokenAt === undefined ? null : Math.round(state.firstTokenAt - lifecycle.started),
        ...outcome.usage, ...cacheParts(outcome.usage), retry_count: Math.max(0, attempts - 1), is_stream: ctx.stream, is_retry: intermediate,
        request_body: rawJson, request_headers: headersJson,
        preprocessed: state?.preprocessed, preprocessed_body: state?.preprocessedBody,
        pseudo_thinking: state?.pseudo, thinking_inject: settings.store_request_body && state?.thinkingInject?.length ? JSON.stringify(state.thinkingInject) : undefined,
        response_body: state?.response.text(), upstream_response_body: state?.upstream.text(),
        response_body_truncated: state?.response.truncated, upstream_response_body_truncated: state?.upstream.truncated,
        source: caller.source, key_id: caller.key?.id ?? null, key_name: caller.key?.name ?? null, client_ip: caller.ip, quota_points: points,
        user_id: caller.user?.id ?? null, group_name: (state && groupOf.get(state.channel.id)?.name) ?? null, channel_key: state?.keyLabel ?? null,
        proxy_node: state?.proxyNode ?? null,
        user_agent: typeof ctx.rawHeaders?.['user-agent'] === 'string' ? ctx.rawHeaders['user-agent'] : null,
        upstream_encoding: state?.compression?.encoding, upstream_raw_bytes: state?.compression?.raw_bytes, upstream_sent_bytes: state?.compression?.sent_bytes,
        compress_ms: state?.compression?.ms, compress_status: state?.compression?.status, compress_note: state?.compression?.note,
      }
    }, settings, requestId)
  }

  const newState = (channel: Channel, description: Description, key: string): AttemptState => ({
    ...description, requestedModel: model, key, keyLabel: keyLabel(channel, key),
    channel: channel.key_mode ? { ...channel, api_key: key } : channel,
    lifecycle: new AttemptLifecycle(lifecycle.signal, channel.timeout_ms || settings.request_timeout_ms),
    usage: emptyUsage(),
    upstream: new BoundedCapture(settings.store_response_body, settings.log_response_max_bytes),
    response: new BoundedCapture(settings.store_response_body, settings.log_response_max_bytes),
    pseudo: description.passthrough && matchesPseudoThinking(ctx.entryFormat, description.upstreamWire, channel.id, model, settings),
    meter: new OutputMeter(),
    fakeStream: ctx.stream && channel.fake_stream,
  })

  try {
    // 准入中间件按精确路径挂载；任何绕过它到达这里的 Key 调用一律拒绝
    if (caller.key && ctx.admitted !== true) throw new LocalRequestError('请求未经过准入检查', 429)
    lifecycle.signal.throwIfAborted()
    if (typeof model !== 'string' || !model.trim()) throw new LocalRequestError('model is required')
    // 不回显模型名本身
    if (model.length > MAX_MODEL_LENGTH) throw new LocalRequestError('model 名称过长', 400)
    if (caller.key && !findRatio(settings.model_ratios, model)) throw new LocalRequestError('该模型未配置倍率', 403)
    const modelCandidates = candidatesForModel(model, caller)
    if (!modelCandidates.length) throw new LocalRequestError(`没有可用渠道支持模型 ${model}`, 503)
    // 分组 UA 黑名单：按客户端原始 User-Agent 做关键词包含匹配，命中直接拒绝，不进入选路
    const uaBlocked = uaBlacklistBlock(caller, model, ctx.rawHeaders?.['user-agent'] ? String(ctx.rawHeaders['user-agent']) : null)
    if (uaBlocked !== null) throw new LocalRequestError(uaBlocked, 403)
    groupOf = candidateGroups(caller, modelCandidates, model)
    const account = accountOf(caller)
    if (account) {
      // 预扣：输入估算 + 声明的输出上限，按候选分组的最大倍率保守计算；结算时按实际 usage 扣费后释放
      const ratio = findRatio(settings.model_ratios, model)!
      const groupRatio = groupOf.size ? Math.max(...[...groupOf.values()].map(g => g.ratio)) : 1
      const points = estimateReservePoints(ratio, ctx.ir, groupRatio)
      if (availableQuota(caller, account) - reservedPoints(account) < points) {
        throw new LocalRequestError('余额不足以支付本次请求的预估费用，可调小 max_tokens 后重试', 429)
      }
      releaseReserve = reserveQuota(account, points)
    }
    const blocker = ctx.entryFormat === 'responses' ? respConv.conversionBlocker(ctx.rawBody) : null
    const descriptions = new Map(modelCandidates.map((channel): [number, Description] => {
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
    // 多 key 渠道本次请求中已失效的 key；可用 key 用尽的渠道不再参与选路
    const failedKeys = new Map<number, Set<string>>()
    const keysLeft = (c: Channel) => availableKeys(c, failedKeys.get(c.id))
    const available = () => candidates.filter(c => !banned.has(c.id) && keysLeft(c).length > 0)
    if (!available().length) throw new LocalRequestError('可用渠道的 key 已全部熔断', 503)
    for (let round = 0; round <= settings.channel_retry_times; round++) {
      const channel = selectChannel(available(), tried)
      if (!channel) break
      const description = descriptions.get(channel.id)!
      const failed = failedKeys.get(channel.id) ?? new Set<string>()
      failedKeys.set(channel.id, failed)
      // 一律重试：熔断状态码（如把限流返回成 403 的上游）不停用渠道也不熔断 key，交给同渠道重试；429/402 的 key 冷却照常
      const banCodes = channel.always_retry ? [] : autoBanCodes
      // 轮询模式换 key 不消耗同渠道重试次数；并发模式整组失败后再来一组要消耗
      for (let index = 0; index <= settings.single_retry_times;) {
        lifecycle.signal.throwIfAborted()
        const usable = keysLeft(channel)
        const keys = channel.key_mode === 'race' ? pickRaceKeys(channel, usable, channel.key_concurrency) : usable.slice(0, 1)
        const states = keys.map(key => newState(channel, description, key))
        if (states.length > 1) startRace(states)
        last = states[states.length - 1]
        attempts++
        let winner: { state: AttemptState; outcome: Outcome } | undefined
        // 按结束先后排列；竞速落选的尝试不算失败
        const failures: { state: AttemptState; error: unknown }[] = []
        await Promise.all(states.map(state => runAttempt(ctx, state, settings, caller, lifecycle.signal, compressor, keepAlive).then(
          outcome => { winner = { state, outcome } },
          error => { if (!isRaceLost(error)) failures.push({ state, error }) },
        )))
        let keyFailed = false
        for (const { state, error } of failures) {
          if (lifecycle.signal.aborted) break
          if (channel.key_mode) {
            if (onKeyFailure(channel, state.key, error, banCodes, settings)) {
              failed.add(state.key)
              keyFailed = true
            }
          } else if (settings.auto_ban && shouldDisable(error, banCodes) && onBanSignal(channel.id, settings)) {
            banned.add(channel.id)
          }
        }
        const recordFailures = async (list: typeof failures) => {
          for (const f of list) await record({ ...errorOutcome(f.error), usage: f.state.usage }, true, f.state)
        }
        if (winner) {
          await recordFailures(failures)
          last = winner.state
          final = winner.outcome
          onAttemptSuccess(channel.id)
          onKeySuccess(channel, winner.state.key)
          return
        }
        const { state: lastFailed, error } = failures[failures.length - 1]
        last = lastFailed
        final = { ...errorOutcome(error), usage: lastFailed.usage }
        // 本地确定的输入错误、以及上游已返回 2xx 后的处理失败阻止跨渠道尝试；上游 400/413/422 仍可能由备用渠道处理。
        // 输出内容后响应必然已结束；流式保活只提交了响应头，仍可继续尝试
        const canContinue = !lifecycle.signal.aborted && !ctx.res.writableEnded
          && !failures.some(f => f.error instanceof LocalRequestError || f.error instanceof UpstreamResponseError)
        const hasKey = canContinue && keysLeft(channel).length > 0
        const switchKey = channel.key_mode === 'poll' && hasKey && keyFailed
        const retrySame = !switchKey && hasKey && !banned.has(channel.id) && index < settings.single_retry_times
          && (failures.some(f => shouldRetry(f.error, channel.always_retry)) || (channel.key_mode === 'race' && keyFailed))
        const nextChannel = canContinue && round < settings.channel_retry_times && available().some(c => c.id !== channel.id && !tried.has(c.id))
        if (!switchKey && !retrySame && !nextChannel) {
          await recordFailures(failures.slice(0, -1))
          if (!isClientGone()) sendErrorMessage(ctx, final.code, clientError(caller, final, settings))
          return
        }
        await recordFailures(failures)
        if (switchKey) continue
        if (settings.retry_interval_ms > 0) await sleep(settings.retry_interval_ms, lifecycle.signal)
        if (!retrySame) break
        index++
      }
      tried.add(channel.id)
    }
    lifecycle.signal.throwIfAborted()
    sendErrorMessage(ctx, final.code, clientError(caller, final, settings))
  } catch (error) {
    final = errorOutcome(lifecycle.signal.aborted ? lifecycle.signal.reason : error)
    if (!isClientGone()) sendErrorMessage(ctx, final.code, clientError(caller, final, settings))
  } finally {
    keepAlive?.dispose()
    bill(last, final.usage)
    // 按所有到达结算的尝试累计计费：重试与换渠道中已消耗的上游 Token 同样计入
    const points = settleRequest({
      caller, model: billedModel, ratios: settings.model_ratios, usage: billedUsage,
      meter: last?.meter ?? null, estimatePrompt: () => estimateIRPrompt(ctx.ir), success: final.status === 'success',
      groupRatio: (last && groupOf.get(last.channel.id)?.ratio) ?? 1,
      reachedUpstream: [...billed].some(state => state.sent),
    })
    // 先落账再放开预扣，避免出现「预扣已释放、扣费尚未写入」的间隙
    releaseReserve?.()
    const logged = record(final, false, last, points)
    lifecycle.dispose()
    await logged
  }
}

/** 单次上游尝试：准备请求 → 发送 → 按流式 / 非流式转发；失败时抛出，超时与中断换成 signal 的原因 */
async function runAttempt(
  ctx: RelayContext, state: AttemptState, settings: Settings, caller: Caller, requestSignal: AbortSignal, compressor: RequestCompressor, keepAlive?: StreamKeepAlive,
): Promise<Outcome> {
  const attempt = state.lifecycle
  let response: globalThis.Response | undefined
  // 代理池租约；换节点时整体替换，放在对象里便于闭包读取当前值
  const pool: { lease: Lease | null } = { lease: null }
  // 假流式等待上游完整响应期间定时发 SSE 空帧，防止客户端或反代超时断开
  const fakePing = state.fakeStream ? new StreamKeepAlive(ctx.res, FAKE_STREAM_PING_MS) : undefined
  try {
    const { channel } = state
    const triedNodes = new Set<number>()
    const nodeNames: string[] = []
    const takeNode = (): boolean => {
      pool.lease?.release()
      pool.lease = acquireNode({ include: channel.proxy_pool_include, exclude: channel.proxy_pool_exclude }, triedNodes)
      if (!pool.lease) return false
      triedNodes.add(pool.lease.node.id)
      nodeNames.push(pool.lease.node.name)
      state.proxyNode = nodeNames.join(' → ').slice(0, 500)
      return true
    }
    // 池里没有可用节点：本次尝试失败，按原逻辑换渠道（不回退直连）
    if (channel.proxy_pool && !takeNode()) throw new CandidateError(noNodeMessage())
    const nodeRetries = channel.proxy_pool ? getPoolSettings().node_retry_times : 0
    // 压缩放在参数规则、单 role、UA 覆盖都执行完之后
    const request = await prepareRequest(ctx, state, settings, caller, pool.lease ? pool.lease.url : settings.proxy_url || undefined)
    const encoded = await compressor.encode(state.channel, request.body, settings)
    const compression = state.compression = encoded.info
    attempt.touch()
    const send = (body: string | Buffer, encoding: string | null) => {
      const headers = encoding ? { ...request.headers, 'content-encoding': encoding } : request.headers
      const options: any = { method: 'POST', headers, body, signal: attempt.signal }
      if (pool.lease) options.dispatcher = pool.lease.dispatcher
      else if (settings.proxy_url) options.dispatcher = getProxyAgent(settings.proxy_url)
      return fetch(request.url, options)
    }
    state.sent = true
    // 节点网络错误 / 上游 429、403：节点冷却并换下一个节点重发，不消耗同渠道重试次数
    for (let n = 0; ; n++) {
      try {
        response = await send(encoded.body, encoded.encoding)
      } catch (error) {
        const current = pool.lease
        if (!current || attempt.signal.aborted) throw error
        current.fail('network', { message: error instanceof Error ? error.message : String(error) })
        if (n >= nodeRetries || !takeNode()) throw error
        attempt.touch()
        continue
      }
      const current = pool.lease
      if (current && (response.status === 429 || response.status === 403)) {
        current.fail('limit', { status: response.status, retryAfterMs: parseRetryAfter(response.headers.get('retry-after')) })
        if (n < nodeRetries && takeNode()) {
          await response.body?.cancel().catch(() => {})
          attempt.touch()
          continue
        }
      } else current?.success()
      break
    }
    let errorText: string | undefined
    let errorTruncated = false
    if (!response.ok && encoded.algorithm) {
      // 先读错误体但不写入上游原始回复：若触发回退，这段错误只进压缩备注
      errorText = await readBodyText(response.body, {
        signal: attempt.signal, maxBytes: 64 * 1024, truncate: true,
        onTruncate: () => { errorTruncated = true }, onBytes: () => attempt.touch(),
      })
      if (isCompressionRejection(response.status, errorText, settings)) {
        compression.note = errorText.slice(0, 300)
        if (settings.upstream_compression_fallback) {
          // 同一次尝试内明文重发，不占用重试次数
          compression.status = 'fallback_failed'
          compression.sent_bytes += compression.raw_bytes
          response = await send(request.body, null)
          errorText = undefined
          if (response.ok) {
            markUnsupported(state.channel.id, encoded.algorithm, settings)
            compression.status = 'fallback_ok'
          }
        } else compression.status = 'rejected'
      }
    }
    if (!response.ok) {
      let text = errorText
      if (text === undefined) {
        text = await readBodyText(response.body, {
          signal: attempt.signal, maxBytes: 64 * 1024, truncate: true,
          onTruncate: () => { state.upstream.truncated = settings.store_response_body },
          onBytes: bytes => { attempt.touch(); state.upstream.append(bytes) },
        })
      } else {
        state.upstream.append(text)
        if (errorTruncated) state.upstream.truncated = settings.store_response_body
      }
      throw new UpstreamError(response.status, text, parseRetryAfter(response.headers.get('retry-after')))
    }
    return ctx.stream && !state.fakeStream
      ? await pipeResponse(ctx, state, response, settings, requestSignal, caller, keepAlive)
      : await sendResponse(ctx, state, response, settings, requestSignal, keepAlive)
  } catch (caught) {
    // 流式中途断开等网络错误也记到节点上（同一租约只记一次）
    if (pool.lease && !attempt.signal.aborted && errorKind(caught) === 'network') {
      pool.lease.fail('network', { message: caught instanceof Error ? caught.message : String(caught) })
    }
    throw attempt.signal.aborted ? attempt.signal.reason : caught
  } finally {
    fakePing?.dispose()
    pool.lease?.release()
    state.elapsedMs = attempt.elapsed
    attempt.dispose()
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {})
  }
}

/**
 * 非流式响应。上游已返回 2xx，此后的失败（超限、非 JSON、空回复、转换异常）一律抛 UpstreamResponseError：
 * 上游通常已经计费，不再重试也不换渠道；usage 在判定之前先行解析，保证失败也能按实际用量结算。
 */
async function sendResponse(
  ctx: RelayContext, state: AttemptState, response: globalThis.Response, settings: Settings, requestSignal: AbortSignal, keepAlive?: StreamKeepAlive,
): Promise<Outcome> {
  let overflow = false
  let raw: string
  try {
    raw = await readBodyText(response.body, {
      signal: state.lifecycle.signal, maxBytes: settings.stream_buffer_max_bytes,
      onTruncate: () => { overflow = true; state.upstream.truncated = settings.store_response_body },
      onBytes: bytes => { state.lifecycle.touch(); state.upstream.append(bytes) },
    })
  } catch (error) {
    if (overflow && !state.lifecycle.signal.aborted) throw new UpstreamResponseError(`上游响应体超过 ${settings.stream_buffer_max_bytes} 字节限制`)
    throw error
  }
  state.lifecycle.signal.throwIfAborted()
  let json: any
  try { json = JSON.parse(raw) } catch { throw new UpstreamResponseError('上游响应不是合法 JSON') }
  // 先计量：即便后面判定空回复或转换失败，上游费用也已经产生
  state.usage = rawWireUsage(state.upstreamWire, json)
  if (state.upstreamWire === 'responses') logResponsesBody(state.upstream, json)
  let output: any
  if (state.passthrough && !state.pseudo) {
    if (isEmptyPassthroughBody(ctx.entryFormat, json)) throw new UpstreamResponseError('上游返回空回复')
    // 直通 JSON 不逐字段解析，usage 缺失时按整段文本保守估算；空回复的外壳不算输出
    state.meter.append(raw)
    json.model = state.requestedModel
    state.usage = maxUsage(state.usage, passthroughUsage(ctx.entryFormat, json))
    output = json
  } else {
    let ir: any
    try {
      ir = state.adaptor.parseResponse(json, state)
      if (state.pseudo) ir = splitIRResponse(ir, settings, text => thinkingStore.save(text, settings.pseudo_thinking_store_max))
    } catch (error) {
      if (error instanceof UpstreamError || error instanceof CandidateError || error instanceof LocalRequestError) throw error
      throw new UpstreamResponseError(error instanceof Error ? error.message : '上游响应转换失败')
    }
    if (isEmptyIRResponse(ir)) throw new UpstreamResponseError('上游返回空回复')
    for (const choice of ir.choices || []) meterIR(state.meter, choice.message)
    ir.model = state.requestedModel
    state.usage = maxUsage(state.usage, ir.usage || emptyUsage())
    output = entryBuildResponse(ctx.entryFormat, ir, ctx.ir)
  }
  const text = JSON.stringify(output)
  state.response.append(text)
  state.lifecycle.signal.throwIfAborted()
  if (state.claim && !state.claim()) throw new RequestStopped('race_lost')
  if (state.fakeStream) {
    // 假流式：完整响应合成为入口协议的 SSE 一次写出；响应头可能已被空帧提前提交
    openEventStream(ctx.res)
    state.firstTokenAt = performance.now()
    await createStreamWriter(ctx.res, requestSignal, state.lifecycle, keepAlive)(fakeStreamEvents(ctx.entryFormat, output))
    ctx.res.end()
  } else ctx.res.type('json').send(text)
  return { status: 'success', code: 200, usage: state.usage }
}

async function pipeResponse(ctx: RelayContext, state: AttemptState, response: globalThis.Response, settings: Settings, requestSignal: AbortSignal, caller: Caller, keepAlive?: StreamKeepAlive): Promise<Outcome> {
  if (!response.body) throw new UpstreamError(502, 'no response body from upstream')
  const passthrough = state.passthrough && !state.pseudo
  const decoder = passthrough ? null : state.adaptor.createStreamDecoder(state)
  const encoder = entryEncoder(ctx.entryFormat, ctx.ir)
  const transform: ChunkTransform | undefined = state.pseudo
    ? createPseudoThinkingTransform(settings, text => thinkingStore.save(text, settings.pseudo_thinking_store_max)) : undefined
  const observer = new StreamState(state.upstreamWire)
  const write = createStreamWriter(ctx.res, requestSignal, state.lifecycle, keepAlive)
  const upstreamLog = state.upstreamWire === 'responses' ? new ResponsesSseLog(state.upstream) : state.upstream
  let pending: string[] = []
  let opened = false
  let errorForwarded = false
  const open = async (): Promise<void> => {
    if (opened) return
    requestSignal.throwIfAborted()
    if (state.claim && !state.claim()) throw new RequestStopped('race_lost')
    openEventStream(ctx.res)
    opened = true
    state.firstTokenAt = performance.now()
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
      try { await write(encoder.fail(clientError(caller, errorOutcome(error), settings))) } catch {}
    }
    throw error
  } finally {
    if (upstreamLog instanceof ResponsesSseLog) upstreamLog.flush()
    if (opened && !ctx.res.writableEnded) ctx.res.end()
  }
}

function sendErrorMessage(ctx: RelayContext, status: number, message: string): void {
  const { res, entryFormat } = ctx
  if (res.destroyed || res.writableEnded) return
  // 响应头已提交但未结束只会是流式保活：状态码无法再改，按入口格式写 SSE 错误事件
  if (res.headersSent) { res.end(entryEncoder(entryFormat, ctx.ir).fail(message)); return }
  if (entryFormat === 'anthropic') res.status(status).json({ type: 'error', error: { type: 'api_error', message } })
  else res.status(status).json({ error: { message, type: 'upstream_error', code: status } })
}
