import './isolated'
import assert from 'node:assert/strict'
import { pinnedImageTransport } from '../../src/core/imageTransport'
const [port, proxy] = process.argv.slice(2)
for (const proxyUrl of [undefined, proxy]) {
  const result = await pinnedImageTransport({ url: new URL(`https://image.synthetic:${port}/image`), address: '127.0.0.1', signal: AbortSignal.timeout(5000), proxyUrl })
  try { assert.equal(await result.response.text(), 'secure-image') } finally { await result.dispose() }
  await assert.rejects(pinnedImageTransport({ url: new URL(`https://wrong.synthetic:${port}/image`), address: '127.0.0.1', signal: AbortSignal.timeout(5000), proxyUrl }))
}
console.log('TLS 主机校验、SNI 和代理通过')
