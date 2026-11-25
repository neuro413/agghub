import './helpers/isolated'
import test, { after, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { db, getSettings, setSettings } from '../src/db'
import { compileTemplate } from '../src/core/promptTemplate'
import { applyRegexPacks, uaMatches, type PackContext } from '../src/core/regexPacks'
import { validateSettingsPatch } from '../src/core/settingsValidation'
import { handleRelay } from '../src/core/relay'
import type { EntryFormat, RegexPack, RegexPackStep } from '../src/types'
import { reset, channel, logs, jsonResponse, anthBody, oaiBody, FakeResponse } from './helpers/relay'

const originalFetch = globalThis.fetch
beforeEach(reset)
afterEach(() => { globalThis.fetch = originalFetch })
after(() => db.close())

let seq = 0
const step = (partial: Partial<RegexPackStep> & { type: RegexPackStep['type'] }): RegexPackStep => {
  const base = { id: `s${++seq}`, enabled: true }
  if (partial.type === 'regex') return { ...base, pattern: '', flags: 'g', replacement: '', ...partial } as RegexPackStep
  if (partial.type === 'inject') return { ...base, content: '', position: 'system_end', ...partial } as RegexPackStep
  return { ...base, code: '', ...partial } as RegexPackStep
}
const pack = (steps: RegexPackStep[], partial: Partial<RegexPack> = {}): RegexPack => ({ id: `p${++seq}`, enabled: true, name: '测试包', params: [], steps, ...partial })
const context = (entryFormat: EntryFormat, passthrough = true, extra: Partial<PackContext> = {}): PackContext => ({
  meta: { entryFormat, channelId: 1, model: 'alias', passthrough }, ua: 'claude-cli/2.1.0 (external, cli)', ...extra,
})
const render = (source: string, vars: Record<string, any> = {}, params: Record<string, any> = {}) =>
  compileTemplate(source).render({ env: { vars, params, values: { model: () => 'alias' }, seed: () => 'seed' }, scope: { vars, params } })

test('模板：宏、EJS 与变量；未知宏原样保留', async () => {
  const vars: Record<string, any> = {}
  assert.equal(await render('{{setvar::n::2}}{{addvar::n::3}}{{getvar::n}}-{{incvar::n}}-{{model}}-{{mode}}-{{unknown}}{{// 注释}}', vars, { mode: 'fast' }), '5-6-alias-fast-{{unknown}}')
  assert.equal(await render('<% for (const i of [1, 2]) { %>[<%= i * params.k %>]<% } %><%_ vars.done = await Promise.resolve(true) _%>', vars, { k: 10 }), '[10][20]')
  assert.equal(vars.done, true)
  assert.equal(await render('a\n\n{{trim}}\n\nb {{pick::x::y}}'), `ab ${await render('{{pick::x::y}}')}`.replace('ab ', 'ab ').replace(/^ab /, 'ab '))
  assert.equal(compileTemplate('纯文本 100% {} $x').static, '纯文本 100% {} $x')
  assert.throws(() => compileTemplate('<% if ( %>'), SyntaxError)
})

test('UA 白名单：关键词不区分大小写，/…/ 按正则，空名单不限', () => {
  assert.equal(uaMatches([], null), true)
  assert.equal(uaMatches(['Claude-CLI'], 'claude-cli/2.1.0'), true)
  assert.equal(uaMatches(['codex'], 'claude-cli/2.1.0'), false)
  assert.equal(uaMatches(['codex', '/^claude-cli\\/2\\./'], 'claude-cli/2.1.0'), true)
  assert.equal(uaMatches(['/^claude-cli\\/2\\./'], 'claude-cli/1.9.0'), false)
  assert.equal(uaMatches(['claude'], null), false)
})

test('Claude 直通：正则模板、工具描述、注入、脚本与变量按顺序生效', async () => {
  const body: any = {
    system: [{ type: 'text', text: '身份块' }, { type: 'text', text: 'Working directory: /repo\n{{getvar::cwd}} <%= 1 + 1 %>', cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'Bash', description: 'Run a command. IMPORTANT: be careful.', input_schema: { type: 'object', properties: { command: { type: 'string', description: 'IMPORTANT: the command' } } } }],
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, { role: 'user', content: 'go' }],
  }
  const traces = await applyRegexPacks(body, [pack([
    // 抓取工作目录存进变量，原文保留；请求里自带的 {{…}} 与 <% %> 不会被执行
    step({ type: 'regex', pattern: 'Working directory: (\\S+)', replacement: '{{setvar::cwd::$1}}$&', roles: ['system'] }),
    step({ type: 'regex', pattern: 'IMPORTANT: ', replacement: '<%= params.tone %>', targets: ['tools'] }),
    step({ type: 'inject', content: '目录 {{getvar::cwd}}，模型 {{model}}，上一句：{{lastUserMessage}}', position: 'system_end' }),
    step({ type: 'inject', content: '提醒', position: 'depth', depth: 1, role: 'system' }),
    step({ type: 'inject', content: '不会执行', position: 'system_start', condition: 'params.tone === "x"' }),
    step({ type: 'script', code: 'req.tool("Bash").description += ` [${vars.cwd}]`; req.messages[0].text = "HI"; setvar("count", req.messages.length)' }),
    step({ type: 'inject', content: '共 {{getvar::count}} 条', position: 'system_end' }),
  ], { params: [{ key: 'tone', type: 'text', value: 'Note: ' }] })], context('anthropic'))

  assert.deepEqual(traces[0].steps.map(s => s.status), ['unchanged', 'changed', 'changed', 'changed', 'skipped', 'changed', 'changed'])
  assert.equal(body.system[1].text, 'Working directory: /repo\n{{getvar::cwd}} <%= 1 + 1 %>')
  assert.deepEqual(body.system[1].cache_control, { type: 'ephemeral' })
  assert.equal(body.system[2].text, '目录 /repo，模型 alias，上一句：go')
  assert.equal(body.system[3].text, '共 4 条')
  assert.equal(body.tools[0].description, 'Run a command. Note: be careful. [/repo]')
  assert.equal(body.tools[0].input_schema.properties.command.description, 'Note: the command')
  assert.deepEqual(body.messages.map((m: any) => m.role), ['user', 'assistant', 'user', 'user'])
  assert.equal(body.messages[0].content, 'HI')
  assert.equal(body.messages[2].content, '提醒')
})

test('出错的步骤不生效且不留下半截改动，后续步骤照常执行', async () => {
  const body: any = { messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'secret' }] }
  const traces = await applyRegexPacks(body, [pack([
    step({ type: 'script', name: '半途出错', code: 'req.system = "改了一半"; body.messages.pop(); throw new Error("boom")' }),
    step({ type: 'regex', pattern: 'secret', replacement: '<%= nope %>' }),
    step({ type: 'regex', pattern: 'secret', replacement: '<%= $0.toUpperCase() %>!' }),
  ])], context('openai'))
  assert.deepEqual(traces[0].steps.map(s => s.status), ['error', 'error', 'changed'])
  assert.match(traces[0].steps[0].error!, /boom/)
  assert.deepEqual(body.messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'SECRET!' }])
})

test('Responses 直通与中间表示：统一接口在不同形状下行为一致', async () => {
  const code = 'req.system = req.system.replace("旧", "新"); req.remove(m => m.role === "assistant" && m.text.includes("废话")); req.append("user", "追加")'
  const responses: any = { instructions: '旧指令', input: [{ role: 'user', content: [{ type: 'input_text', text: 'q' }] }, { role: 'assistant', content: [{ type: 'output_text', text: '废话' }] }] }
  await applyRegexPacks(responses, [pack([step({ type: 'script', code })])], context('responses'))
  assert.deepEqual(responses, { instructions: '新指令', input: [{ role: 'user', content: [{ type: 'input_text', text: 'q' }] }, { role: 'user', content: '追加' }] })

  // 跨格式转换（passthrough = false）时是 Chat 形状的中间表示：system 在 messages 内，工具调用与结果成对移除
  const ir: any = { messages: [
    { role: 'system', content: '旧指令' }, { role: 'user', content: 'q' },
    { role: 'assistant', content: '废话', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'r' },
  ] }
  await applyRegexPacks(ir, [pack([step({ type: 'script', code })])], context('anthropic', false))
  assert.deepEqual(ir.messages, [{ role: 'system', content: '新指令' }, { role: 'user', content: 'q' }, { role: 'user', content: '追加' }])
})

test('启用范围：UA 白名单与启用条件同时满足才执行；条件出错只记录不执行', async () => {
  const run = async (partial: Partial<RegexPack>, ua: string | null = 'claude-cli/2.1.0') => {
    const body = { system: 'You are Claude Code', messages: [{ role: 'user', content: 'a' }] }
    const traces = await applyRegexPacks(body, [pack([step({ type: 'regex', pattern: 'a', replacement: 'b' })], partial)], context('anthropic', true, { ua }))
    return { text: body.messages[0].content, traces }
  }
  assert.equal((await run({ uaWhitelist: ['claude-cli'] })).text, 'b')
  assert.equal((await run({ uaWhitelist: ['claude-cli'] }, 'curl/8')).text, 'a')
  assert.equal((await run({ uaWhitelist: ['claude-cli'] }, null)).text, 'a')
  assert.equal((await run({ when: { mode: 'regex', source: 'claude code', flags: 'i' } })).text, 'b')
  assert.equal((await run({ when: { mode: 'regex', source: 'Codex' } })).text, 'a')
  assert.equal((await run({ when: { mode: 'expr', source: 'req.tools.length === 0 && ctx.ua.startsWith("claude")' } })).text, 'b')
  assert.equal((await run({ formats: ['openai'] })).traces.length, 0)
  const failed = await run({ when: { mode: 'expr', source: 'missing.value' } })
  assert.equal(failed.text, 'a')
  assert.match(failed.traces[0].error!, /missing/)
})

test('设置校验：拒绝语法错误的模板 / 脚本 / 正则与重复参数名', () => {
  const settings = getSettings()
  const ok = pack([step({ type: 'regex', pattern: 'a', replacement: '{{model}} <%= 1 %>' }), step({ type: 'script', code: 'await fetch; return 1' })], { uaWhitelist: ['claude-cli', '/^codex/i'] })
  assert.deepEqual(validateSettingsPatch(settings, { regex_packs: [ok] }), { regex_packs: [ok] })
  for (const bad of [
    pack([step({ type: 'regex', pattern: '[', replacement: '' })]),
    pack([step({ type: 'regex', pattern: 'a', replacement: '<% if ( %>' })]),
    pack([step({ type: 'script', code: 'const = 1' })]),
    pack([step({ type: 'inject', content: 'x', condition: 'a +' })]),
    pack([], { uaWhitelist: ['/[/'] }),
    pack([], { params: [{ key: 'a', type: 'text', value: '' }, { key: 'a', type: 'number', value: 1 }] }),
    pack([], { params: [{ key: 'a', type: 'number', value: 'x' as any }] }),
  ]) assert.throws(() => validateSettingsPatch(settings, { regex_packs: [bad] }))
})

test('经 relay：按 UA 启用，改写后的请求发往上游，执行记录写入日志', async () => {
  channel('anthropic')
  setSettings({ regex_packs: [pack([
    step({ type: 'regex', pattern: 'hi', replacement: 'hello from {{ua}}' }),
    step({ type: 'script', name: '坏脚本', code: 'console.log("调试", req.messages.length); throw new Error("oops")' }),
  ], { name: 'CC 预设', uaWhitelist: ['claude-cli'] })] })
  const sent: any[] = []
  globalThis.fetch = (async (_url: any, init: any) => { sent.push(JSON.parse(init.body)); return jsonResponse(anthBody) }) as typeof fetch
  const send = (ua: string) => {
    const raw = { model: 'alias', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }
    return handleRelay({ entryFormat: 'anthropic', stream: false, ir: { model: 'alias', messages: [{ role: 'user', content: 'hi' }] }, rawBody: raw, rawHeaders: { 'user-agent': ua }, res: new FakeResponse() as any })
  }
  await send('claude-cli/2.1.0')
  await send('curl/8.0')
  assert.equal(sent[0].messages[0].content, 'hello from claude-cli/2.1.0')
  assert.equal(sent[1].messages[0].content, 'hi')
  const [hit, miss] = logs()
  assert.equal(hit.preprocessed, 1)
  const trace = JSON.parse(hit.pack_trace)
  assert.equal(trace[0].pack, 'CC 预设')
  assert.deepEqual(trace[0].steps.map((s: any) => [s.name, s.status]), [['步骤 1', 'changed'], ['坏脚本', 'error']])
  assert.deepEqual(trace[0].logs, ['调试 1'])
  assert.equal(miss.pack_trace, null)
  assert.equal(miss.preprocessed, 0)
  void oaiBody
})
