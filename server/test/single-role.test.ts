import './helpers/isolated'
import test, { after, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { db, getChannelById, setSettings } from '../src/db'
import { channelsRouter } from '../src/routes/channels'
import { SINGLE_ROLE_FILLER, applySingleRole } from '../src/core/singleRole'
import { channel, reset, relay, logs, sse, jsonResponse, anthBody, anthEvents } from './helpers/relay'

const originalFetch = globalThis.fetch
beforeEach(reset)
afterEach(() => { globalThis.fetch = originalFetch })
after(() => db.close())

const pack = (items: any[]) => JSON.stringify(items)
const u1 = { role: 'user', content: 'u1' }
const a1 = { role: 'assistant', content: 'a1' }
const u2 = { role: 'user', content: 'u2' }

test('SINGLE_ROLE_FILLER 为换行加零宽空格', () => {
  assert.equal(SINGLE_ROLE_FILLER, '\n' + String.fromCharCode(0x200b))
})

test('OpenAI：开头 system 为系统提示，中途 system 原位打包', () => {
  const system = { role: 'system', content: 'S' }
  const mid = { role: 'system', content: 'mid' }
  const source = () => ({ model: 'm', temperature: 0.5, messages: [system, u1, a1, mid, u2] })

  const user = source()
  assert.equal(applySingleRole(user, 'openai', 'user'), true)
  assert.deepEqual(user, { model: 'm', temperature: 0.5, messages: [system, { role: 'user', content: pack([u1, a1, mid, u2]) }] })

  const merged = source()
  applySingleRole(merged, 'openai', 'user', { mergeSystem: true })
  assert.deepEqual(merged.messages, [{ role: 'user', content: pack([system, u1, a1, mid, u2]) }])

  const asSystem = source()
  applySingleRole(asSystem, 'openai', 'system')
  assert.deepEqual(asSystem.messages, [{ role: 'system', content: pack([system, u1, a1, mid, u2]) }, { role: 'user', content: SINGLE_ROLE_FILLER }])
})

test('Anthropic：顶层 system 打包为首项，合并时删除原字段', () => {
  const blocks = [{ type: 'text', text: 'S', cache_control: { type: 'ephemeral' } }]
  const source = () => ({ system: blocks, messages: [u1, a1, u2], max_tokens: 10 })

  const user = source()
  applySingleRole(user, 'anthropic', 'user')
  assert.deepEqual(user, { system: blocks, messages: [{ role: 'user', content: pack([u1, a1, u2]) }], max_tokens: 10 })

  const merged: any = source()
  applySingleRole(merged, 'anthropic', 'user', { mergeSystem: true })
  assert.ok(!('system' in merged))
  assert.deepEqual(merged.messages, [{ role: 'user', content: pack([{ role: 'system', content: blocks }, u1, a1, u2]) }])

  const asSystem = source()
  applySingleRole(asSystem, 'anthropic', 'system', { mergeSystem: true })
  assert.equal(asSystem.system, pack([{ role: 'system', content: blocks }, u1, a1, u2]))
  assert.deepEqual(asSystem.messages, [{ role: 'user', content: SINGLE_ROLE_FILLER }])

  const noSystem = { system: '', messages: [u1] }
  applySingleRole(noSystem, 'anthropic', 'user', { mergeSystem: true })
  assert.deepEqual(noSystem, { messages: [{ role: 'user', content: pack([u1]) }] })
})

test('Gemini：systemInstruction 与 contents', () => {
  const parts = [{ text: 'S' }]
  const contents = [{ role: 'user', parts: [{ text: 'u1' }] }, { role: 'model', parts: [{ text: 'a1' }] }]
  const merged: any = { systemInstruction: { parts }, contents }
  applySingleRole(merged, 'gemini', 'user', { mergeSystem: true })
  assert.deepEqual(merged, { contents: [{ role: 'user', parts: [{ text: pack([{ role: 'system', parts }, ...contents]) }] }] })

  const asSystem: any = { systemInstruction: { parts }, contents }
  applySingleRole(asSystem, 'gemini', 'system')
  assert.deepEqual(asSystem.systemInstruction, { parts: [{ text: pack([{ role: 'system', parts }, ...contents]) }] })
  assert.deepEqual(asSystem.contents, [{ role: 'user', parts: [{ text: SINGLE_ROLE_FILLER }] }])
})

test('Responses：instructions、开头 developer 项与字符串 input', () => {
  const short: any = { instructions: 'S', input: 'hi' }
  applySingleRole(short, 'responses', 'user')
  assert.deepEqual(short, { instructions: 'S', input: [{ type: 'message', role: 'user', content: pack([{ role: 'user', content: 'hi' }]) }] })

  const developer = { role: 'developer', content: 'D' }
  const call = { type: 'function_call', call_id: 'c1', name: 'run', arguments: '{}' }
  const user: any = { input: [developer, u1, call] }
  applySingleRole(user, 'responses', 'user')
  assert.deepEqual(user.input, [developer, { type: 'message', role: 'user', content: pack([u1, call]) }])

  const asSystem: any = { instructions: 'S', input: [developer, u1, call] }
  applySingleRole(asSystem, 'responses', 'system')
  assert.equal(asSystem.instructions, pack([{ role: 'system', content: 'S' }, developer, u1, call]))
  assert.deepEqual(asSystem.input, [{ type: 'message', role: 'user', content: SINGLE_ROLE_FILLER }])
})

test('没有可打包的消息时不改动', () => {
  const onlySystem = { messages: [{ role: 'system', content: 'S' }] }
  assert.equal(applySingleRole(onlySystem, 'openai', 'user'), false)
  assert.deepEqual(onlySystem, { messages: [{ role: 'system', content: 'S' }] })
  assert.equal(applySingleRole({ messages: [] }, 'anthropic', 'system'), false)
  assert.equal(applySingleRole({ prompt: 'x' }, 'openai', 'user', { mergeSystem: true }), false)
})

test('system 模式最后 user 除外：最后一条 user 原样保留，其余打包进系统提示', () => {
  const system = { role: 'system', content: 'S' }
  const image = { role: 'user', content: [{ type: 'text', text: 'u2' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }
  const excluded: any = { messages: [system, u1, a1, image] }
  assert.equal(applySingleRole(excluded, 'openai', 'system', { excludeLastUser: true }), true)
  assert.deepEqual(excluded.messages, [{ role: 'system', content: pack([system, u1, a1]) }, image])

  // 末尾是 assistant 预填充时取其前面最近的 user，预填充仍按原位打包
  const prefill = { role: 'assistant', content: '好的，' }
  const withPrefill: any = { messages: [system, u1, a1, u2, prefill] }
  applySingleRole(withPrefill, 'openai', 'system', { excludeLastUser: true })
  assert.deepEqual(withPrefill.messages, [{ role: 'system', content: pack([system, u1, a1, prefill]) }, u2])

  // 没有 user 消息时仍用填充内容
  const noUser: any = { messages: [system, a1] }
  applySingleRole(noUser, 'openai', 'system', { excludeLastUser: true })
  assert.deepEqual(noUser.messages, [{ role: 'system', content: pack([system, a1]) }, { role: 'user', content: SINGLE_ROLE_FILLER }])

  // 除去最后 user 后没有可打包的内容时不改动
  const single = { messages: [u1] }
  assert.equal(applySingleRole(single, 'openai', 'system', { excludeLastUser: true }), false)
  assert.deepEqual(single, { messages: [u1] })

  // user 模式忽略该选项
  const userMode: any = { messages: [u1, a1, u2] }
  applySingleRole(userMode, 'openai', 'user', { excludeLastUser: true })
  assert.deepEqual(userMode.messages, [{ role: 'user', content: pack([u1, a1, u2]) }])
})

test('最后 user 除外：工具结果不算 user 消息', () => {
  const toolUse = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'run', input: {} }] }
  const toolResult = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }
  const anthropic: any = { system: 'S', messages: [u1, toolUse, toolResult] }
  applySingleRole(anthropic, 'anthropic', 'system', { excludeLastUser: true })
  assert.equal(anthropic.system, pack([{ role: 'system', content: 'S' }, toolUse, toolResult]))
  assert.deepEqual(anthropic.messages, [u1])

  const ask = { role: 'user', parts: [{ text: 'u1' }] }
  const call = { role: 'model', parts: [{ functionCall: { name: 'run', args: {} } }] }
  const response = { role: 'user', parts: [{ functionResponse: { name: 'run', response: { ok: true } } }] }
  const gemini: any = { contents: [ask, call, response] }
  applySingleRole(gemini, 'gemini', 'system', { excludeLastUser: true })
  assert.deepEqual(gemini, { systemInstruction: { parts: [{ text: pack([call, response]) }] }, contents: [ask] })

  const output = { type: 'function_call_output', call_id: 'c1', output: 'ok' }
  const responses: any = { instructions: 'S', input: 'hi' }
  applySingleRole(responses, 'responses', 'system', { excludeLastUser: true })
  assert.deepEqual(responses, { instructions: pack([{ role: 'system', content: 'S' }]), input: [{ role: 'user', content: 'hi' }] })
  const withOutput: any = { input: [u1, output] }
  applySingleRole(withOutput, 'responses', 'system', { excludeLastUser: true })
  assert.deepEqual(withOutput, { instructions: pack([output]), input: [u1] })
})

function useSingleRole(id: number, mode: string, merge = false, excludeLastUser = false) {
  db.prepare('UPDATE channels SET single_role=?, single_role_merge_system=?, single_role_exclude_last_user=? WHERE id=?')
    .run(mode, merge ? 1 : 0, excludeLastUser ? 1 : 0, id)
}

test('中继：OpenAI 入口跨格式到 Anthropic 渠道的 system 格式，参数规则仍在其后执行', async () => {
  useSingleRole(channel('anthropic'), 'system')
  setSettings({ param_rules: [{ id: 'rule', enabled: true, ops: [{ type: 'set', key: 'temperature', value: '0.3' }] }] })
  let sent: any
  globalThis.fetch = (async (_url: any, options: any) => { sent = JSON.parse(options.body); return jsonResponse(anthBody) }) as typeof fetch
  const request = relay('openai', false, undefined, { messages: [{ role: 'system', content: 'S' }, u1, a1, u2] })
  await request.run()
  assert.equal(request.res.statusCode, 200)
  assert.deepEqual(JSON.parse(sent.system).map((item: any) => item.role), ['system', 'user', 'assistant', 'user'])
  assert.deepEqual(sent.messages, [{ role: 'user', content: SINGLE_ROLE_FILLER }])
  assert.equal(sent.temperature, 0.3)
  const [log] = logs()
  assert.equal(log.preprocessed, 1)
  assert.deepEqual(JSON.parse(log.preprocessed_body), sent)
})

test('中继：Anthropic 直通流式 user 模式合并 system', async () => {
  useSingleRole(channel('anthropic'), 'user', true)
  let sent: any
  globalThis.fetch = (async (_url: any, options: any) => { sent = JSON.parse(options.body); return sse(anthEvents()) }) as typeof fetch
  const messages = [u1, a1, u2]
  const request = relay('anthropic', true, undefined, { system: 'S', messages })
  await request.run()
  assert.equal(request.res.statusCode, 200)
  assert.ok(!('system' in sent))
  assert.deepEqual(sent.messages, [{ role: 'user', content: pack([{ role: 'system', content: 'S' }, ...messages]) }])
  assert.ok(request.res.chunks.join('').includes('你好'))
})

test('中继：Anthropic 直通 system 格式最后 user 除外', async () => {
  useSingleRole(channel('anthropic'), 'system', false, true)
  let sent: any
  globalThis.fetch = (async (_url: any, options: any) => { sent = JSON.parse(options.body); return jsonResponse(anthBody) }) as typeof fetch
  const request = relay('anthropic', false, undefined, { system: 'S', messages: [u1, a1, u2] })
  await request.run()
  assert.equal(request.res.statusCode, 200)
  assert.equal(sent.system, pack([{ role: 'system', content: 'S' }, u1, a1]))
  assert.deepEqual(sent.messages, [u2])
})

test('中继：未开启时请求体保持原结构', async () => {
  channel('anthropic')
  let sent: any
  globalThis.fetch = (async (_url: any, options: any) => { sent = JSON.parse(options.body); return jsonResponse(anthBody) }) as typeof fetch
  await relay('anthropic', false, undefined, { system: 'S', messages: [u1, a1, u2] }).run()
  assert.equal(sent.system, 'S')
  assert.deepEqual(sent.messages, [u1, a1, u2])
  assert.equal(logs()[0].preprocessed, 0)
})

test('渠道接口保存、清除并校验单 role 设置', async () => {
  const app = express(); app.use(express.json()); app.use('/channels', channelsRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/channels`
  const call = (path: string, method: string, body: any) =>
    originalFetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    const created = await (await call('', 'POST', { name: 'x', type: 'openai', models: ['m'], single_role: 'user', single_role_merge_system: true })).json() as any
    assert.equal(created.single_role, 'user')
    assert.equal(created.single_role_merge_system, true)

    assert.equal(created.single_role_exclude_last_user, false)

    const updated = await (await call(`/${created.id}`, 'PUT', {
      single_role: 'system', single_role_merge_system: false, single_role_exclude_last_user: true,
    })).json() as any
    assert.equal(updated.single_role, 'system')
    assert.equal(updated.single_role_merge_system, false)
    assert.equal(updated.single_role_exclude_last_user, true)

    // 只改其他字段时保留原设置
    await call(`/${created.id}`, 'PUT', { name: 'y' })
    assert.equal(getChannelById(created.id)!.single_role, 'system')
    assert.equal(getChannelById(created.id)!.single_role_exclude_last_user, true)

    await call(`/${created.id}`, 'PUT', { single_role: null })
    assert.equal(getChannelById(created.id)!.single_role, null)

    const invalid = await call(`/${created.id}`, 'PUT', { single_role: 'assistant' })
    assert.equal(invalid.status, 400)
    assert.equal(getChannelById(created.id)!.single_role, null)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
