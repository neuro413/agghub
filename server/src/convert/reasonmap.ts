// 停止原因 / 完成状态的三方映射表。各 convert 模块只调用，不再各自维护 switch。
//
//   Claude stop_reason  ⇄  IR(Chat) finish_reason  ⇄  Responses status + incomplete_details.reason

/** Claude stop_reason → Chat finish_reason */
export function claudeStopToFinish(sr: string | null | undefined): string | null {
  switch (sr) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'tool_calls'
    case 'refusal':
      return 'content_filter'
    case 'pause_turn':
      // 服务端循环暂停，Chat / Responses 没有对应语义，按未完成处理
      return 'length'
    default:
      return sr ? 'stop' : null
  }
}

/** Chat finish_reason → Claude stop_reason */
export function finishToClaudeStop(fr: string | null | undefined): string {
  switch (fr) {
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
      return 'tool_use'
    case 'content_filter':
      return 'refusal'
    default:
      return 'end_turn'
  }
}

interface ResponsesStatus {
  status: 'completed' | 'incomplete'
  incomplete_details: { reason: string } | null
}

/** Chat finish_reason → Responses status / incomplete_details */
export function finishToResponsesStatus(fr: string | null | undefined): ResponsesStatus {
  if (fr === 'length') return { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }
  if (fr === 'content_filter') return { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }
  return { status: 'completed', incomplete_details: null }
}

/** Responses 响应 status / incomplete_details → Chat finish_reason */
export function responsesStatusToFinish(resp: any, hasToolCalls: boolean): string {
  if (resp?.status === 'incomplete') {
    const r = resp.incomplete_details?.reason
    if (r === 'content_filter') return 'content_filter'
    return 'length'
  }
  if (hasToolCalls) return 'tool_calls'
  return 'stop'
}
