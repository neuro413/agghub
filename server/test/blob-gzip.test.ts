import './helpers/isolated'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'

const original = zlib.zstdCompressSync
;(zlib as any).zstdCompressSync = undefined
const { db } = await import('../src/db')
const { putJsonBody, getJsonBody, packBlobs, compressText, decompressText } = await import('../src/stats/blobstore')
after(() => { zlib.zstdCompressSync = original; db.close() })

test('无 Zstd 运行时回退 gzip，保持正文还原且跳过冷包', async () => {
  const body = JSON.stringify({ system: '不依赖 Zstd 的正文'.repeat(300) })
  assert.equal(getJsonBody(putJsonBody(body)), body)
  assert.equal(decompressText(compressText(body)), body)
  assert.equal(compressText(body)[0], 2)
  assert.equal(await packBlobs(Date.now() + 2 * 86_400_000), 0)
  assert.ok(db.prepare('SELECT 1 FROM blobs WHERE codec=2').get())
})
