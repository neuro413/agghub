import './helpers/isolated'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/db'
import * as thinkingStore from '../src/core/thinkingStore'

after(() => db.close())

test('思维链暂存只存 32 字节 digest，对外签名、查询、列表与删除保持不变', () => {
  const sig = thinkingStore.save('合成思考🙂'.repeat(20), 10)
  assert.equal(Buffer.from(sig, 'base64').length, 280)
  assert.equal(thinkingStore.save('合成思考🙂'.repeat(20), 10), sig)
  assert.equal(thinkingStore.lookup(sig), '合成思考🙂'.repeat(20))
  assert.deepEqual(db.prepare('SELECT length(digest) FROM thinking_store').pluck().all(), [32])
  const [item] = thinkingStore.list(0, 10)
  assert.equal(item.signature, sig)
  assert.equal(thinkingStore.count(), 1)
  assert.equal(thinkingStore.remove([sig, 'not-a-signature']), 1)
  assert.equal(thinkingStore.lookup(sig), null)
})

test('被改动的签名、非本网关签名与类型不符的记录都查不到', () => {
  const sig = thinkingStore.save('原始思考', 10)
  const bytes = Buffer.from(sig, 'base64')
  bytes[bytes.length - 1] ^= 1
  assert.equal(thinkingStore.lookup(bytes.toString('base64')), null)
  assert.equal(thinkingStore.lookup(''), null)
  assert.equal(thinkingStore.lookup('短签名'), null)
  const items = [{ id: 'rs_1', encrypted: '密文'.repeat(50), followers: 1 }]
  const reasoning = thinkingStore.saveReasoning(items, 10)
  assert.deepEqual(thinkingStore.lookupReasoning(reasoning), items)
  assert.equal(thinkingStore.lookup(reasoning), null)
  assert.equal(thinkingStore.lookupReasoning(sig), null)
  // 同一组密文重复保存覆盖 payload（流式时 followers 事后补写）
  assert.equal(thinkingStore.saveReasoning([{ ...items[0], followers: 2 }], 10), reasoning)
  assert.equal(thinkingStore.lookupReasoning(reasoning)![0].followers, 2)
})

test('按类型淘汰最早的记录', () => {
  db.exec('DELETE FROM thinking_store')
  const first = thinkingStore.save('第一条', 2)
  db.prepare('UPDATE thinking_store SET created_at = 1').run()
  thinkingStore.save('第二条', 2)
  thinkingStore.save('第三条', 2)
  assert.equal(thinkingStore.count(), 2)
  assert.equal(thinkingStore.lookup(first), null)
})
