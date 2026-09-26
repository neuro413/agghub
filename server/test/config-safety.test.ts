import './helpers/isolated'
import test from 'node:test'
import { after } from 'node:test'
import { db, getSettings, setSettings } from '../src/db'
import { validateSettingsPatch, normalizeAccessToken, validateThinkingTags } from '../src/core/settingsValidation'
import { createTokenGuard } from '../src/core/accessToken'
import { candidatesForModel, resolveUpstreamModel } from '../src/core/selector'
import express from 'express'
import { settingsRouter } from '../src/routes/settings'
import { preprocessRouter } from '../src/routes/preprocess'
after(() => db.close())
import assert from 'node:assert/strict'
import { applyParamRulesToObject } from '../src/core/paramRules'
import { createPseudoThinkingTransform, matchesPseudoThinking } from '../src/core/pseudoThinking'
import type { ParamOp } from '../src/types'

function apply(body: any, ops: ParamOp[]) {
  return applyParamRulesToObject(body, 'openai', [{ id: 'test', enabled: true, ops }])
}

test('D02: 点路径不访问全局原型，非法操作不影响后续合法操作', () => {
  const result = apply({}, [
    { type: 'set', key: '__proto__.agghub_test_marker', value: '"polluted"' },
    { type: 'set', key: 'temperature', value: '0.7' },
  ])
  // 即使旧版本失败也清理测试进程中的标记，避免干扰其他断言。
  const marker = ({} as any).agghub_test_marker
  delete (Object.prototype as any).agghub_test_marker
  assert.equal(marker, undefined)
  assert.equal(result.errors.length, 1)
  assert.equal(result.body.temperature, 0.7)
})

test('D16: 正则不能回写受保护字段，失败时原子保留参数', () => {
  const body = { stream: true, messages: [{ role: 'user', content: 'hi' }], temperature: 0.4 }
  const before = structuredClone(body)
  const result = apply(body, [{ type: 'regex', pattern: '^.*$', replacement: '{"stream":false,"messages":[]}' }])
  assert.deepEqual(body, before)
  assert.equal(result.errors.length, 1)
  assert.equal(result.changed, false)
})

test('D01: 标签校验覆盖单空、空白、同值与超长，历史错误配置安全跳过', () => {
  for (const pair of [['', 'x'], ['x', ''], [' ', 'x'], ['x', 'x'], ['x'.repeat(257), 'y']]) {
    assert.throws(() => validateThinkingTags(...pair as [string, string]))
  }
  const settings = { ...getSettings(), pseudo_thinking_enabled: true, drop_thinking: true, pseudo_thinking_open_tag: '' }
  assert.equal(matchesPseudoThinking('anthropic', 'anthropic', 1, 'alias', settings), false)
})

test('D01: 有效标签每个切分边界的正文、思考与签名一致', () => {
  const input = '<thinking>中文思考🙂</thinking>正式回复'
  for (let cut = 0; cut <= input.length; cut++) {
    const saved: string[] = []
    const transform = createPseudoThinkingTransform(getSettings(), s => { saved.push(s); return 'sig' })
    const deltas = [input.slice(0, cut), input.slice(cut)].flatMap(content => transform.transform({ choices: [{ delta: { content } }] }))
    deltas.push(...transform.flush())
    const values = deltas.map(chunk => chunk.choices[0].delta)
    assert.equal(values.map(v => v.content || '').join(''), '正式回复')
    assert.equal(values.map(v => v.reasoning_content || '').join(''), '中文思考🙂')
    assert.deepEqual(saved, ['中文思考🙂'])
  }
})

test('D02: 所有点路径操作拒绝危险段、非下标数组属性和稀疏大下标', () => {
  for (const type of ['set', 'set_if_missing', 'set_if_present', 'delete'] as const) {
    for (const key of ['__proto__.x', 'safe.constructor.prototype.x', 'safe.prototype.x', 'tools.length', 'tools.10001', 'tools.-1', 'safe..x']) {
      const body = { tools: [], safe: {} }
      const result = apply(body, [{ type, key, value: 'true' }])
      assert.equal(result.errors.length, 1, `${type} ${key}`)
      assert.deepEqual(body, { tools: [], safe: {} })
    }
  }
  const inherited = Object.create({ old: { inherited: true } })
  const result = apply(inherited, [{ type: 'set', key: 'old.local', value: 'true' }])
  assert.equal(result.body.old.inherited, undefined)
  assert.equal(result.body.old.local, true)
})

test('D02/D16: 合法 schema 的同名数据保留，正则危险顶层键拒绝', () => {
  const body: any = { stream: true, messages: ['保留'] }
  const schema = '{"type":"object","properties":{"constructor":{"type":"string"},"__proto__":{"type":"string"}}}'
  const result = apply(body, [{ type: 'set', key: 'tools.0.schema', value: schema }])
  assert.deepEqual(result.body.tools['0'].schema, JSON.parse(schema))
  for (const key of ['__proto__', 'constructor', 'prototype', 'messages', 'stream']) {
    const before = JSON.stringify(body)
    assert.equal(apply(body, [{ type: 'regex', pattern: '^.*$', replacement: `{"${key}":{}}` }]).errors.length, 1)
    assert.equal(JSON.stringify(body), before)
  }
  assert.equal(apply({}, [{ type: 'regex', pattern: '^.*$', replacement: '{"messages":[]}' }]).changed, false)
})

test('D26: 令牌保存时规范化，非法历史配置保持拒绝访问', () => {
  assert.equal(normalizeAccessToken(' token '), 'token')
  assert.equal(normalizeAccessToken(''), '')
  for (const token of ['   ', 'a\nb', '\ttoken', '中文', 'x'.repeat(1025)]) assert.throws(() => normalizeAccessToken(token))
  for (const [stored, expected] of [['token', 200], ['   ', 401], ['中文', 401], ['', 200]]) {
    let status = 200
    const response = { status(n: number) { status = n; return this }, json() {} }
    createTokenGuard(() => stored as string)({ headers: { authorization: 'Bearer token' } } as any, response as any, () => {})
    assert.equal(status, expected)
  }
  assert.equal(validateSettingsPatch(getSettings(), { access_token: ' token ' }).access_token, 'token')
})

test('设置结构拒绝 NaN、非整数、错误数组、危险操作，合法部分 patch 不覆盖其他字段', () => {
  const settings = getSettings()
  for (const patch of [
    { single_retry_times: 1.5 }, { request_timeout_ms: Infinity }, { store_request_body: 'false' },
    { drop_thinking_channel_ids: ['1'] }, { pseudo_thinking_models: [2] },
    { param_rules: [{ id: 'x', enabled: true, ops: [{ type: 'set', key: '__proto__.x', value: '1' }] }] },
    { preprocess_rules: [{ id: 'x', enabled: true, source: 'regex', pattern: '[', flags: 'g', replacement: '' }] },
  ]) assert.throws(() => validateSettingsPatch(settings, patch))
  assert.deepEqual(validateSettingsPatch(settings, { single_retry_times: 3 }), { single_retry_times: 3 })
})

test('D02: 模型映射不识别继承属性', () => {
  db.prepare(`INSERT INTO channels(name,type,models,model_mapping,created_at,updated_at) VALUES ('test','openai','[]','{}',0,0)`).run()
  assert.equal(candidatesForModel('toString').length, 0)
  assert.equal(resolveUpstreamModel({ model_mapping: {} } as any, 'toString'), 'toString')
})

test('D01/D02/D16/D26: 实际设置及预览接口验证原子失败与规范化结果', async () => {
  const app = express()
  app.use(express.json())
  app.use('/settings', settingsRouter)
  app.use('/preprocess', preprocessRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address() as { port: number }
  const url = `http://127.0.0.1:${address.port}`
  const put = (body: any) => fetch(url + '/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    const before = getSettings()
    assert.equal((await put({ pseudo_thinking_open_tag: '', single_retry_times: 5 })).status, 400)
    assert.equal(getSettings().single_retry_times, before.single_retry_times)
    assert.equal((await put({ access_token: ' token ' })).status, 200)
    assert.equal(getSettings().access_token, 'token')
    setSettings({ pseudo_thinking_open_tag: '' })
    assert.equal((await fetch(url + '/settings')).status, 200)
    assert.equal((await put({ pseudo_thinking_open_tag: '<thinking>' })).status, 200)
    const response = await fetch(url + '/preprocess/param-test', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        body: { messages: ['hi'], stream: true }, rule: { ops: [{ type: 'set', key: '__proto__.x', value: '1' }, { type: 'regex', pattern: '^.*$', replacement: '{"stream":false}' }] },
      }),
    })
    const preview = await response.json() as any
    assert.equal(preview.errors.length, 2)
    assert.equal(preview.body.stream, true)
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
