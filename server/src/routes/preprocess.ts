import { Router } from 'express'
import { applyParamRulesToObject } from '../core/paramRules'
import { createPackRun, executePack, packInactiveReason } from '../core/regexPacks'
import { getSettings } from '../db'
import { SettingsValidationError, validateSettingsPatch } from '../core/settingsValidation'
import * as anthConv from '../convert/anthropic'
import * as oaiConv from '../convert/openai'
import * as respConv from '../convert/responses'
import type { EntryFormat, PackTestResult, ParamRule, RegexPack, WireFormat } from '../types'

export const preprocessRouter = Router()

// 正则包试运行：把一个（可以是尚未保存的）包应用到给定请求体上，返回改写结果与各步骤状态。
// 不发请求、不落库，但包里的模板与脚本会真实执行，fetch 等副作用同样会发生。
preprocessRouter.post('/pack-test', async (req, res, next) => {
  try {
    const input = (req.body || {}) as { pack?: RegexPack; body?: any; ua?: string; model?: string; entryFormat?: EntryFormat; passthrough?: boolean }
    const pack = input.pack
    if (!pack || typeof pack !== 'object') return res.status(400).json({ error: 'pack 必填' })
    try {
      validateSettingsPatch(getSettings(), { regex_packs: [pack] })
    } catch (error) {
      if (error instanceof SettingsValidationError) return res.status(400).json({ error: error.message.replaceAll('regex_packs[0].', '') })
      throw error
    }
    let body: any = input.body
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body)
      } catch {
        return res.status(400).json({ error: '请求体不是合法 JSON' })
      }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: '请求体应为 JSON 对象' })

    const inferred = inferWire(body)
    const entryFormat: EntryFormat = input.entryFormat && ['openai', 'anthropic', 'responses'].includes(input.entryFormat)
      ? input.entryFormat : inferred === 'anthropic' || inferred === 'responses' ? inferred : 'openai'
    const passthrough = input.passthrough !== false
    // 跨格式转换的链路里，包看到的是中间表示
    const convert = entryFormat === 'anthropic' ? anthConv : entryFormat === 'responses' ? respConv : oaiConv
    const before = passthrough ? body : convert.parseRequest(body).ir
    const after = structuredClone(before)
    const model = typeof input.model === 'string' && input.model ? input.model : typeof body.model === 'string' ? body.model : ''
    const run = createPackRun({
      meta: { entryFormat, channelId: 0, model, passthrough, source: 'owner', keyId: null },
      ua: typeof input.ua === 'string' && input.ua ? input.ua : null, headers: {}, channelName: '试运行', stream: !!body.stream,
    })
    let inactiveReason: string | null
    try {
      inactiveReason = await packInactiveReason(run, pack, after, true)
    } catch (error) {
      inactiveReason = `启用条件求值出错：${(error as Error).message}`
    }
    const trace = await executePack(run, pack, after)
    const result: PackTestResult = {
      entryFormat, passthrough, inactiveReason, changed: JSON.stringify(before) !== JSON.stringify(after), before, after, trace, vars: { ...run.vars },
    }
    res.json(result)
  } catch (error) {
    next(error)
  }
})

/** 按请求体形状猜测上游格式（仅影响受保护字段的判定）*/
function inferWire(body: any): WireFormat {
  if (Array.isArray(body?.contents)) return 'gemini'
  if (body?.input !== undefined && body?.messages === undefined) return 'responses'
  if (body?.system !== undefined || body?.anthropic_version !== undefined) return 'anthropic'
  return 'openai'
}

// 参数修改规则试运行：把一条规则应用到粘贴的请求体上并返回结果（不发请求、不落库）
preprocessRouter.post('/param-test', (req, res) => {
  const { rule, body } = (req.body || {}) as { rule?: ParamRule; body?: any }
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

  const wire = inferWire(parsed)
  const result = applyParamRulesToObject(parsed, wire, [{ ...rule, enabled: true }])
  res.json({ wireFormat: wire, changed: result.changed, body: result.body, errors: result.errors })
})
