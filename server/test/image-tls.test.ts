import './helpers/isolated'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

test('R03: 真实 TLS 直连与代理保留 SNI/Host，可信证书通过，错误主机证书拒绝', async () => {
  const dir = process.env.AGGHUB_DATA_DIR!
  const key = path.join(dir, 'synthetic.key'), cert = path.join(dir, 'synthetic.crt')
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=image.synthetic', '-addext', 'subjectAltName=DNS:image.synthetic'], { encoding: 'utf8', env: { ...process.env, MSYS2_ARG_CONV_EXCL: '*' } })
  assert.equal(generated.status, 0, generated.stderr)
  const seen: string[] = []
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => { seen.push(req.headers.host!); res.end('secure-image') })
  const proxy = http.createServer()
  const tunnels: string[] = []
  const sockets = new Set<net.Socket>()
  proxy.on('connect', (req, client, head) => {
    tunnels.push(req.url!)
    const [host, port] = req.url!.split(':')
    const upstream = net.connect(Number(port), host, () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); upstream.pipe(client); client.pipe(upstream) })
    sockets.add(upstream); sockets.add(client as net.Socket)
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy())
    client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy())
  })
  await Promise.all([new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)), new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))])
  const port = (server.address() as net.AddressInfo).port
  try {
    const require = createRequire(import.meta.url)
    const output = await new Promise<{ code: number | null; text: string }>(resolve => {
      const child = spawn(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, fileURLToPath(new URL('./helpers/tls-client.ts', import.meta.url)), String(port), `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`], { env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, stdio: ['ignore', 'pipe', 'pipe'] })
      let text = ''
      const timer = setTimeout(() => child.kill(), 20_000)
      child.stdout.on('data', data => { text += data }); child.stderr.on('data', data => { text += data })
      child.on('close', code => { clearTimeout(timer); resolve({ code, text }) })
    })
    assert.equal(output.code, 0, output.text)
    assert.deepEqual(seen, [`image.synthetic:${port}`, `image.synthetic:${port}`])
    assert.ok(tunnels.length >= 2 && tunnels.every(target => target === `127.0.0.1:${port}`))
  } finally {
    for (const socket of sockets) socket.destroy()
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => proxy.close(() => resolve()))])
  }
})
