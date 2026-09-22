import { Router } from 'express'
import { applyParamRulesToObject } from '../core/paramRules'
import type { ParamRule, WireFormat } from '../types'

export const preprocessRouter = Router()

const WIRES: WireFormat[] = ['openai', 'anthropic', 'gemini', 'responses']

/** 按请求体形状猜测上游格式（仅影响受保护字段的判定）*/
function inferWire(body: any): WireFormat {
  if (Array.isArray(body?.contents)) return 'gemini'
  if (body?.input !== undefined && body?.messages === undefined) return 'responses'
  if (body?.system !== undefined || body?.anthropic_version !== undefined) return 'anthropic'
  return 'openai'
}

// 参数修改规则试运行：把一条规则应用到粘贴的请求体上并返回结果（不发请求、不落库）
preprocessRouter.post('/param-test', (req, res) => {
  const { rule, body, wireFormat } = (req.body || {}) as { rule?: ParamRule; body?: any; wireFormat?: WireFormat }
  if (!rule || !Array.isArray(rule.ops)) return res.status(400).json({ error: 'rule.ops 必填' })

  let parsed: any = body
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body)
    } catch {
      return res.status(400).json({ error: '请求体不是合法 JSON' })
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return res.status(400).json({ error: '请求体应为 JSON 对象' })
  }

  const wire = wireFormat && WIRES.includes(wireFormat) ? wireFormat : inferWire(parsed)
  const result = applyParamRulesToObject(parsed, wire, [{ ...rule, enabled: true }])
  res.json({ wireFormat: wire, changed: result.changed, body: result.body, errors: result.errors })
})
