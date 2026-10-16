import './helpers/isolated'
import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import { db } from '../src/db'
import { createApp } from '../src/app'

let server: Server
let base = ''

before(async () => {
  server = createApp('lan').listen(0)
  await new Promise<void>(resolve => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.close()
})
beforeEach(() => {
  db.exec('DELETE FROM announcements')
})

async function call(path: string, options: { method?: string; body?: unknown } = {}) {
  const method = options.method ?? 'GET'
  const r = await fetch(base + path, {
    method,
    headers: method === 'GET' ? {} : { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}),
  })
  return { status: r.status, json: await r.json() as any }
}

test('创建公告：去空白、默认值与发布时间倒序', async () => {
  const first = await call('/api/announcements', { method: 'POST', body: { content: '  第一条  ', extra: ' 备注 ', type: 'warning', publish_at: 2000 } })
  assert.equal(first.status, 200)
  assert.equal(first.json.content, '第一条')
  assert.equal(first.json.extra, '备注')
  assert.equal(first.json.type, 'warning')
  assert.equal(first.json.publish_at, 2000)

  const second = await call('/api/announcements', { method: 'POST', body: { content: '第二条', publish_at: 1000 } })
  assert.equal(second.status, 200)
  assert.equal(second.json.type, 'default')
  assert.equal(second.json.extra, '')

  // 缺省发布时间为现在
  const third = await call('/api/announcements', { method: 'POST', body: { content: '第三条' } })
  assert.ok(Number.isSafeInteger(third.json.publish_at) && third.json.publish_at > 0)

  const list = await call('/api/announcements')
  assert.deepEqual(list.json.map((a: any) => a.content), ['第三条', '第一条', '第二条'])
})

test('更新公告：部分更新、刷新 updated_at、不存在返回 404', async () => {
  const created = (await call('/api/announcements', { method: 'POST', body: { content: '原文', extra: 'a', type: 'success' } })).json
  // 人为压低时间，验证更新会刷新 updated_at
  db.prepare('UPDATE announcements SET updated_at = 1 WHERE id = ?').run(created.id)

  const updated = await call(`/api/announcements/${created.id}`, { method: 'PUT', body: { content: '新文' } })
  assert.equal(updated.status, 200)
  assert.equal(updated.json.content, '新文')
  assert.equal(updated.json.extra, 'a')
  assert.equal(updated.json.type, 'success')
  assert.ok(updated.json.updated_at > 1)

  assert.equal((await call(`/api/announcements/${created.id}`, { method: 'PUT', body: { type: 'nope' } })).status, 400)
  assert.equal((await call('/api/announcements/999999', { method: 'PUT', body: { content: 'x' } })).status, 404)
})

test('删除公告', async () => {
  const id = (await call('/api/announcements', { method: 'POST', body: { content: '待删' } })).json.id
  assert.equal((await call(`/api/announcements/${id}`, { method: 'DELETE' })).json.ok, true)
  assert.deepEqual((await call('/api/announcements')).json, [])
})

test('创建与更新的字段校验失败返回 400', async () => {
  const bodies = [
    {},
    { content: '   ' },
    { content: 'x'.repeat(5001) },
    { content: 'ok', extra: 'x'.repeat(201) },
    { content: 'ok', type: 'info' },
    { content: 'ok', publish_at: 0 },
    { content: 'ok', publish_at: 1.5 },
  ]
  for (const body of bodies) {
    const res = await call('/api/announcements', { method: 'POST', body })
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.equal(typeof res.json.error, 'string')
  }

  const id = (await call('/api/announcements', { method: 'POST', body: { content: 'ok' } })).json.id
  assert.equal((await call(`/api/announcements/${id}`, { method: 'PUT', body: { content: '' } })).status, 400)
})

test('公告总数上限 100 条', async () => {
  const insert = db.prepare('INSERT INTO announcements (content, extra, type, publish_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
  for (let i = 0; i < 100; i++) insert.run(`第 ${i} 条`, '', 'default', 1000 + i, 0, 0)

  const res = await call('/api/announcements', { method: 'POST', body: { content: '超出' } })
  assert.equal(res.status, 400)
  assert.match(res.json.error, /最多 100 条/)
})

test('设置接口拒绝超长的 portal_notice', async () => {
  assert.equal((await call('/api/settings', { method: 'PUT', body: { portal_notice: 'x'.repeat(20_001) } })).status, 400)
  const ok = await call('/api/settings', { method: 'PUT', body: { portal_notice: '正常通知' } })
  assert.equal(ok.status, 200)
  assert.equal(ok.json.portal_notice, '正常通知')
})
