import test from 'node:test'
import assert from 'node:assert/strict'
import * as anthropic from '../src/convert/anthropic'
import * as responses from '../src/convert/responses'

const chunk = (delta: any, finish: string | null = null) => ({ id: 'synthetic', model: 'alias', choices: [{ index: 0, delta, finish_reason: finish }] })
const events = (text: string): any[] => text.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))

function checkBlocks(output: string) {
  const blocks = new Map<number, { type: string; id?: string; data: string; stopped: boolean }>()
  for (const event of events(output)) {
    if (event.type === 'content_block_start') {
      assert.equal(blocks.has(event.index), false, '每个块只能 start 一次')
      blocks.set(event.index, { type: event.content_block.type, id: event.content_block.id, data: '', stopped: false })
    } else if (event.type === 'content_block_delta') {
      const block = blocks.get(event.index)
      assert.ok(block && !block.stopped, 'delta 必须位于 start 与 stop 之间')
      block.data += event.delta.partial_json || event.delta.text || event.delta.thinking || ''
    } else if (event.type === 'content_block_stop') {
      const block = blocks.get(event.index)
      assert.ok(block && !block.stopped, '每个块只能 stop 一次')
      block.stopped = true
    }
  }
  assert.ok([...blocks.values()].every(block => block.stopped))
  return [...blocks.values()]
}

test('D05: 0→1→0→1 交错工具序列只写有效块，参数完全保留', () => {
  const encoder = anthropic.createStreamEncoder()
  const chunks = [
    chunk({ tool_calls: [{ index: 0, id: 'call0', type: 'function', function: { name: 'a', arguments: '{"a":' } }, { index: 1, id: 'call1', type: 'function', function: { name: 'b', arguments: '{"b":' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '1}' } }, { index: 1, function: { arguments: '2}' } }] }),
    chunk({}, 'tool_calls'),
  ]
  const blocks = checkBlocks(chunks.map(c => encoder.encode(c)).join('') + encoder.finalize())
  assert.deepEqual(blocks.map(b => [b.id, JSON.parse(b.data)]), [['call0', { a: 1 }], ['call1', { b: 2 }]])
})

test('D05: 工具之间夹文本/思考保持首次出现顺序，支持迟到 ID/name', () => {
  const encoder = anthropic.createStreamEncoder()
  const output = [
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"x":' } }] }),
    chunk({ content: '中间文本' }),
    chunk({ reasoning_content: '中间思考' }),
    chunk({ reasoning_signature: 'signature' }),
    chunk({ tool_calls: [{ index: 1, id: 'b', function: { name: 'B', arguments: '{}' } }] }),
    chunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'A', arguments: '1}' } }] }),
    chunk({}, 'tool_calls'),
  ].map(c => encoder.encode(c)).join('') + encoder.finalize()
  const blocks = checkBlocks(output)
  assert.deepEqual(blocks.map(b => b.type), ['tool_use', 'text', 'thinking', 'tool_use'])
  assert.equal(blocks[0].data, '{"x":1}')
  assert.equal(blocks[1].data, '中间文本')
})

test('D05/D22: native custom 后续不重复 type 时拼接完整文本后只包装一次，空输入保留', () => {
  for (const input of ['', '中文\n"quoted"\\path']) {
    const encoder = anthropic.createStreamEncoder()
    const first = encoder.encode(chunk({ tool_calls: [{ index: 0, id: 'c', type: 'custom', custom: { name: 'run', input: input.slice(0, 2) } }] }))
    const rest = encoder.encode(chunk({ tool_calls: [{ index: 0, custom: { input: input.slice(2) } }] }))
    const blocks = checkBlocks(first + rest + encoder.finalize())
    assert.deepEqual(JSON.parse(blocks[0].data), { input })
  }
})

test('D05: 缺少标识/半段 JSON 不能成功 finalize，错误后无成功终态', () => {
  for (const call of [{ index: 0, function: { arguments: '{}' } }, { index: 0, id: 'a', function: { name: 'A', arguments: '{' } }]) {
    const encoder = anthropic.createStreamEncoder()
    encoder.encode(chunk({ tool_calls: [call] }))
    assert.throws(() => encoder.finalize())
    const output = encoder.fail('合成失败')
    assert.match(output, /event: error/)
    assert.ok(!output.includes('message_stop'))
  }
})

test('D21: 多个推理项的 added/delta/done/completed ID 和 output_index 恒定', () => {
  const encoder = responses.createStreamEncoder()
  const output = [chunk({ reasoning_content: '推理一' }), chunk({ reasoning_signature: 'sig1' }), chunk({ content: '正文' }), chunk({ reasoning_content: '推理二' }), chunk({ reasoning_signature: 'sig2' })].map(c => encoder.encode(c)).join('') + encoder.finalize()
  const parsed = events(output)
  const final = parsed.find(e => e.type === 'response.completed').response.output
  const added = parsed.filter(e => e.type === 'response.output_item.added' && e.item.type === 'reasoning')
  assert.equal(added.length, 2)
  for (const event of added) {
    for (const related of parsed.filter(e => e.output_index === event.output_index)) assert.equal(related.item?.id || related.item_id, event.item.id)
    assert.equal(final[event.output_index].id, event.item.id)
    assert.ok(final[event.output_index].encrypted_content)
  }
})

function assertCustom(output: string, expected: string) {
  const parsed = events(output)
  assert.equal(parsed.filter(e => e.type === 'response.custom_tool_call_input.delta').map(e => e.delta).join(''), expected)
  assert.equal(parsed.find(e => e.type === 'response.custom_tool_call_input.done').input, expected)
  assert.equal(parsed.find(e => e.type === 'response.output_item.done' && e.item.type === 'custom_tool_call').item.input, expected)
  assert.equal(parsed.find(e => e.type === 'response.completed').response.output.find((item: any) => item.type === 'custom_tool_call').input, expected)
}

test('D22: Responses→Anthropic→Responses 实际 custom 往返的四种表示完全相等', () => {
  const request = responses.parseRequest({ model: 'alias', input: 'hi', tools: [{ type: 'custom', name: 'run_script' }] }).ir
  assert.ok(anthropic.buildRequest(request, 'claude-synthetic').tools[0].input_schema.properties.input)
  for (const input of ['', 'print(1)', '中文🙂\n"引号"\\反斜杠']) {
    const wrapped = JSON.stringify({ input })
    for (let cut = 0; cut <= wrapped.length; cut++) {
      const decoder = anthropic.createStreamDecoder('alias')
      const encoder = responses.createStreamEncoder({ customToolNames: request.custom_tool_names })
      const source = [
        { type: 'message_start', message: { id: 'synthetic' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call', name: 'run_script', input: {} } },
        ...[wrapped.slice(0, cut), wrapped.slice(cut)].map(partial_json => ({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } })),
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { type: 'message_stop' },
      ]
      const output = source.flatMap(e => decoder.push({ event: e.type, data: JSON.stringify(e) })).map(c => encoder.encode(c)).join('') + encoder.finalize()
      assertCustom(output, input)
    }
  }
})

test('D22: 原生 custom 文本即使长得像包装 JSON 也保持原样，后续缺 type 不丢参', () => {
  const input = '{"input":"保持完整JSON文本"}'
  const encoder = responses.createStreamEncoder({ customToolNames: ['run'] })
  const output = encoder.encode(chunk({ tool_calls: [{ index: 0, id: 'call', type: 'custom', custom: { name: 'run', input: input.slice(0, 8) } }] }))
    + encoder.encode(chunk({ tool_calls: [{ index: 0, custom: { input: input.slice(8) } }] })) + encoder.finalize()
  assertCustom(output, input)
})

test('D22: 包装输入非法时明确失败，不能先发包装 delta 或成功 done', () => {
  for (const input of ['{', '{"input":123}']) {
    const encoder = responses.createStreamEncoder({ customToolNames: ['run'] })
    const initial = encoder.encode(chunk({ tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'run', arguments: input } }] }))
    assert.ok(!initial.includes('custom_tool_call_input.delta'))
    assert.throws(() => encoder.finalize(), /custom/)
    assert.match(encoder.fail('包装失败'), /response.failed/)
  }
})

test('Responses 编码：仅 refusal 时 output_text 固定 content_index 0，refusal 固定 1', () => {
  const encoder = responses.createStreamEncoder()
  const output = events([chunk({ refusal: '拒' }), chunk({ refusal: '绝' }), chunk({}, 'stop')].map(c => encoder.encode(c)).join('') + encoder.finalize())
  for (const event of output.filter(e => e.type.startsWith('response.refusal') || e.content_index !== undefined)) {
    assert.equal(event.content_index, event.type.includes('refusal') || event.part?.type === 'refusal' ? 1 : 0, event.type)
  }
  const final = output.find(e => e.type === 'response.completed').response.output[0]
  assert.deepEqual(final.content.map((part: any) => part.type), ['output_text', 'refusal'])
  assert.equal(final.content[1].refusal, '拒绝')
})

test('Responses 解码：空摘要密文写占位并签名，工具参数只在 done 给出时补发', () => {
  const saved: any[][] = []
  responses.setReasoningStore({ save: items => { saved.push(structuredClone(items)); return 'sig' }, lookup: () => null })
  try {
    const decoder = responses.createStreamDecoder('alias')
    const source = [
      { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [] } },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'enc' } },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call', name: 'run', arguments: '' } },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'call', name: 'run', arguments: '{"a":1}' } },
      { type: 'response.completed', response: { status: 'completed', output: [] } },
    ]
    const deltas = source.flatMap(e => decoder.push({ event: null, data: JSON.stringify(e) })).map(c => ({ delta: c.choices[0].delta, finish: c.choices[0].finish_reason }))
    assert.equal(deltas.map(d => d.delta.reasoning_content || '').join(''), 'null')
    assert.ok(deltas.some(d => d.delta.reasoning_signature === 'sig'))
    assert.ok(!deltas.some(d => d.delta.reasoning_redacted))
    const calls = deltas.flatMap(d => d.delta.tool_calls || [])
    assert.equal(calls[0].id, 'call')
    assert.equal(calls.map((c: any) => c.function.arguments).join(''), '{"a":1}')
    assert.equal(deltas.at(-1)!.finish, 'tool_calls')
    // 首次保存时 followers=0，见到后续 function_call 后补写为 1
    assert.deepEqual(saved.at(-1), [{ id: 'rs_1', encrypted: 'enc', followers: 1 }])
  } finally {
    responses.setReasoningStore({ save: () => '', lookup: () => null })
  }
})
