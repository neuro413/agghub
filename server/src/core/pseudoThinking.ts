import type { Settings } from '../types'
import { matchesDropThinking } from './preprocess'
import { validateThinkingTags } from './settingsValidation'
import { BufferBudget } from './capture'

let lastInvalidTagWarning = -Infinity

// ── 命中判断 ──────────────────────────────────────────────

export function matchesPseudoThinking(
  entryFormat: string,
  wireFormat: string,
  channelId: number,
  model: string,
  settings: Settings,
): boolean {
  if (entryFormat !== 'anthropic' || wireFormat !== 'anthropic') return false
  if (!settings.pseudo_thinking_enabled || !settings.drop_thinking) return false
  try { validateThinkingTags(settings.pseudo_thinking_open_tag, settings.pseudo_thinking_close_tag) } catch {
    if (Date.now() - lastInvalidTagWarning > 60_000) {
      lastInvalidTagWarning = Date.now()
      console.warn('[agghub] 伪思考标签配置无效，本次跳过伪思考；请在预处理页修正标签')
    }
    return false
  }
  if (settings.drop_thinking_keep_last > 0) return false
  // 伪思考依赖丢弃 thinking：本请求未命中丢弃范围（渠道/模型限定）时不得附加伪思考
  if (!matchesDropThinking(channelId, model, settings)) return false
  const cIds = settings.pseudo_thinking_channel_ids
  if (cIds.length && !cIds.includes(channelId)) return false
  const models = settings.pseudo_thinking_models
  if (models.length && !models.includes(model)) return false
  return true
}

// ── 出向：请求体改写（在 dropThinking 之前调用）──────────

export interface ThinkingInjectEntry {
  messageIndex: number
  thinking: string
}

export function applyPseudoThinkingRequest(
  body: any,
  settings: Settings,
  storeLookup: (sig: string) => string | null,
): ThinkingInjectEntry[] {
  const open = settings.pseudo_thinking_open_tag
  const close = settings.pseudo_thinking_close_tag
  const injected: ThinkingInjectEntry[] = []

  if (Array.isArray(body.messages)) {
    for (let i = 0; i < body.messages.length; i++) {
      const msg = body.messages[i]
      if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
      const recovered: string[] = []
      for (const block of msg.content) {
        if (block?.type === 'thinking' && block.signature) {
          const saved = storeLookup(block.signature)
          if (saved) recovered.push(saved)
        }
      }
      if (!recovered.length) continue
      const prefix = recovered.map((t) => `${open}\n${t}\n${close}`).join('\n')
      const textIdx = msg.content.findIndex((b: any) => b?.type === 'text')
      if (textIdx >= 0) {
        msg.content[textIdx] = { ...msg.content[textIdx], text: prefix + '\n' + (msg.content[textIdx].text || '') }
      } else {
        msg.content.unshift({ type: 'text', text: prefix })
      }
      for (const t of recovered) injected.push({ messageIndex: i, thinking: t })
    }
  }

  delete body.thinking
  delete body.output_config
  delete body.context_management

  const prompt = settings.pseudo_thinking_prompt || defaultPrompt(open, close)
  if (typeof body.system === 'string') {
    body.system = body.system.trim() ? prompt + '\n\n' + body.system : prompt
  } else if (Array.isArray(body.system)) {
    body.system.unshift({ type: 'text', text: prompt })
  } else {
    body.system = prompt
  }

  return injected
}

function defaultPrompt(open: string, close: string): string {
  return `在正式回复前，请先在 ${open} 与 ${close} 之间完整写出你的思考过程：使用简体中文，详尽自然，长度随问题复杂度调整；思考结束后再给出正式回复。`
}

// ── 入向（响应）：非流式 IR 切分 ──────────────────────────

export function splitIRResponse(
  irResp: any,
  settings: Settings,
  storeSave: (text: string) => string,
): any {
  const msg = irResp?.choices?.[0]?.message
  if (!msg || typeof msg.content !== 'string') return irResp
  const text = msg.content
  const open = settings.pseudo_thinking_open_tag
  const close = settings.pseudo_thinking_close_tag

  const openIdx = text.indexOf(open)
  if (openIdx < 0) return irResp

  const closeIdx = text.indexOf(close, openIdx + open.length)
  let thinkingText: string
  let normalText: string
  if (closeIdx >= 0) {
    thinkingText = text.slice(openIdx + open.length, closeIdx).trim()
    normalText = (text.slice(0, openIdx) + text.slice(closeIdx + close.length)).trim()
  } else {
    thinkingText = text.slice(openIdx + open.length).trim()
    normalText = text.slice(0, openIdx).trim()
  }

  const sig = thinkingText ? storeSave(thinkingText) : ''
  const newMsg: any = { ...msg, content: normalText || null }
  if (thinkingText) newMsg.reasoning_content = thinkingText
  if (sig) newMsg.reasoning_signature = sig
  return { ...irResp, choices: [{ ...irResp.choices[0], message: newMsg }] }
}

// ── 入向（响应）：流式 ChunkTransform ────────────────────

export interface ChunkTransform {
  transform(chunk: any): any[]
  flush(): any[]
  dispose?(): void
}

export function createPseudoThinkingTransform(
  settings: Settings,
  storeSave: (text: string) => string,
  budget?: BufferBudget,
): ChunkTransform {
  const splitter = new ThinkingTextSplitter(
    settings.pseudo_thinking_open_tag,
    settings.pseudo_thinking_close_tag,
    storeSave,
    budget,
  )
  let shell: any = null

  return {
    transform(chunk) {
      const fr = chunk.choices?.[0]?.finish_reason
      if (fr) {
        const flushed = splitter.flush().map((d) => wrapDelta(shell || chunk, d))
        return [...flushed, chunk]
      }
      const delta = chunk.choices?.[0]?.delta
      if (!delta || typeof delta.content !== 'string' || !delta.content) return [chunk]
      shell = chunk
      const deltas = splitter.feed(delta.content)
      return deltas.length ? deltas.map((d) => wrapDelta(chunk, d)) : []
    },
    flush() {
      return splitter.flush().map((d) => wrapDelta(shell || {}, d))
    },
    dispose() { splitter.dispose(); shell = null },
  }
}

function wrapDelta(shell: any, delta: any): any {
  return {
    ...shell,
    choices: [{ ...(shell.choices?.[0] || {}), delta, finish_reason: null }],
  }
}

// ── 流式文本切分状态机（移植 bridge ThinkingStreamSplitter）─

function safeEmitLen(buf: string, tag: string): number {
  const maxK = Math.min(tag.length - 1, buf.length)
  for (let k = maxK; k > 0; k--) {
    if (buf.endsWith(tag.slice(0, k))) return buf.length - k
  }
  return buf.length
}

class ThinkingTextSplitter {
  private open: string
  private close: string
  private onClose: (thinking: string) => string
  private buf = ''
  private inThink = false
  private lstripThink = false
  private lstripText = true
  private thinkParts: string[] = []
  private thinkBytes = 0
  private budgetKey = Symbol('pseudo-thinking')

  constructor(open: string, close: string, onClose: (thinking: string) => string, private budget = new BufferBudget(16 * 1024 * 1024)) {
    validateThinkingTags(open, close)
    this.open = open
    this.close = close
    this.onClose = onClose
  }

  feed(text: string): any[] {
    if (!text) return []
    this.buf += text
    const out: any[] = []
    let previousLength = this.buf.length + 1
    for (;;) {
      if (this.buf.length >= previousLength) throw new Error('伪思考切分器未推进')
      previousLength = this.buf.length
      if (this.inThink) {
        const idx = this.buf.indexOf(this.close)
        if (idx >= 0) {
          this.pushReasoning(this.buf.slice(0, idx), out)
          this.buf = this.buf.slice(idx + this.close.length)
          this.inThink = false
          this.lstripText = true
          this.emitSignature(out)
          continue
        }
        const safe = safeEmitLen(this.buf, this.close)
        if (safe > 0) {
          this.pushReasoning(this.buf.slice(0, safe), out)
          this.buf = this.buf.slice(safe)
        }
        break
      }
      const idx = this.buf.indexOf(this.open)
      if (idx >= 0) {
        this.pushText(this.buf.slice(0, idx), out)
        this.buf = this.buf.slice(idx + this.open.length)
        this.inThink = true
        this.lstripThink = true
        continue
      }
      const safe = safeEmitLen(this.buf, this.open)
      if (safe > 0) {
        this.pushText(this.buf.slice(0, safe), out)
        this.buf = this.buf.slice(safe)
      }
      break
    }
    return out
  }

  flush(): any[] {
    const out: any[] = []
    if (this.buf) {
      if (this.inThink) this.pushReasoning(this.buf, out)
      else this.pushText(this.buf, out)
      this.buf = ''
    }
    if (this.inThink || this.thinkParts.length) this.emitSignature(out)
    return out
  }

  private pushText(t: string, out: any[]): void {
    if (!t) return
    if (this.lstripText) {
      t = t.replace(/^\s+/, '')
      if (!t) return
      this.lstripText = false
    }
    out.push({ content: t })
  }

  private pushReasoning(t: string, out: any[]): void {
    if (!t) return
    if (this.lstripThink) {
      t = t.replace(/^\s+/, '')
      if (!t) return
      this.lstripThink = false
    }
    this.thinkBytes += Buffer.byteLength(t) + 32
    this.budget.hold(this.budgetKey, this.thinkBytes + 512)
    this.thinkParts.push(t)
    out.push({ reasoning_content: t })
  }

  dispose(): void {
    this.buf = ''
    this.thinkParts = []
    this.thinkBytes = 0
    this.budget.release(this.budgetKey)
  }

  private emitSignature(out: any[]): void {
    const full = this.thinkParts.join('')
    this.thinkParts = []
    this.thinkBytes = 0
    this.budget.release(this.budgetKey)
    if (!full) return
    const sig = this.onClose(full)
    if (sig) out.push({ reasoning_signature: sig })
  }
}
