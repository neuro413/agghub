/**
 * 节点链接 → mihomo proxy map
 * 字段映射移植自 APS2api internal/transport/codec.go
 */
export interface ParsedUri {
  name: string
  /** mihomo proxy map（含 type，不含 name） */
  config: Record<string, unknown>
}

type Out = Record<string, unknown>

function padB64(s: string): string {
  s = s.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '')
  const pad = s.length % 4
  return pad ? s + '='.repeat(4 - pad) : s
}

/** 严格 base64 解码：字符集不合法返回 null（Node 自带解码会静默跳过非法字符） */
export function decodeB64(s: string): string | null {
  const padded = padB64(s.trim())
  if (!padded || !/^[A-Za-z0-9+/]+={0,2}$/.test(padded)) return null
  return Buffer.from(padded, 'base64').toString('utf8')
}

function decode(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}

function firstNonEmpty(...values: (string | null | undefined)[]): string {
  for (const v of values) {
    const t = (v ?? '').trim()
    if (t) return t
  }
  return ''
}

function queryFlag(q: URLSearchParams, ...keys: string[]): boolean {
  return keys.some(key => ['1', 'true', 'yes', 'on'].includes((q.get(key) ?? '').trim().toLowerCase()))
}

function splitList(value: string): string[] {
  return value.split(',').map(s => s.trim()).filter(Boolean)
}

function parseUrl(uri: string): URL | null {
  try { return new URL(uri) } catch { return null }
}

/** IPv6 去掉方括号 */
function hostOf(u: URL): string {
  return decode(u.hostname.replace(/^\[(.*)\]$/, '$1'))
}

function nameOf(u: URL): string {
  return decode(u.hash.replace(/^#/, '')).trim()
}

/** 端口：缺省用默认值，非法返回 null */
function portOf(u: URL, defaultPort: number): number | null {
  if (!u.port) return defaultPort
  const port = Number(u.port)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
}

function isCertPinningFingerprint(fp: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(fp.trim().replace(/:/g, ''))
}

function parseSimple(uri: string, type: string): Out | null {
  const u = parseUrl(uri)
  if (!u) return null
  const server = hostOf(u)
  const port = portOf(u, 443)
  if (!server || port === null) return null
  const q = u.searchParams
  const username = decode(u.username)
  const out: Out = { name: nameOf(u), type, server, port }

  if (type === 'tuic') {
    out.uuid = username
    if (u.password) out.password = decode(u.password)
  } else if (type === 'trojan' || type === 'hysteria2') {
    out.password = u.password ? `${username}:${decode(u.password)}` : username
  } else {
    out.uuid = username
  }

  const sec = (q.get('security') ?? '').toLowerCase()
  if (sec === 'reality' || sec === 'tls' || type === 'trojan' || type === 'hysteria2' || type === 'tuic') {
    out.tls = true
    const sni = firstNonEmpty(q.get('sni'), server)
    out.sni = sni
    out.servername = firstNonEmpty(q.get('servername'), sni)
    if (sec !== 'reality' && queryFlag(q, 'allowInsecure', 'insecure', 'allow_insecure')) out['skip-cert-verify'] = true
  }

  if (sec === 'reality') {
    const publicKey = firstNonEmpty(q.get('pbk'), q.get('public-key'))
    if (publicKey) out['reality-opts'] = { 'public-key': publicKey, 'short-id': firstNonEmpty(q.get('sid'), q.get('short-id')) }
    if (!firstNonEmpty(q.get('fp'), q.get('client-fingerprint'), q.get('fingerprint'))) out['client-fingerprint'] = 'chrome'
  }

  if (type === 'vless' || type === 'trojan') {
    const flow = q.get('flow')
    if (flow) out.flow = flow
    const fp = firstNonEmpty(q.get('fp'), q.get('client-fingerprint'), q.get('fingerprint'))
    if (fp) out['client-fingerprint'] = fp
    else if (out.tls === true) out['client-fingerprint'] = 'chrome'
    const network = q.get('type') ?? ''
    if (['ws', 'grpc', 'http', 'h2', 'xhttp'].includes(network)) {
      out.network = network
      const path = q.get('path') || '/'
      const host = q.get('host') ?? ''
      switch (network) {
        case 'ws': {
          const wsOpts: Out = { path }
          if (host) wsOpts.headers = { Host: host }
          out['ws-opts'] = wsOpts
          break
        }
        case 'grpc': {
          const serviceName = q.get('serviceName')
          if (serviceName) out['grpc-opts'] = { 'grpc-service-name': serviceName }
          break
        }
        case 'http':
          out['http-opts'] = { method: 'GET', path: [path], headers: { Host: [host] } }
          break
        case 'h2':
          out['h2-opts'] = { path, host: host ? [host] : [] }
          break
        case 'xhttp': {
          const xhttpOpts: Out = { path }
          if (host) xhttpOpts.host = host
          const mode = q.get('mode')
          if (mode) xhttpOpts.mode = mode
          out['xhttp-opts'] = xhttpOpts
          break
        }
      }
    }
    const alpn = q.get('alpn')
    if (alpn) out.alpn = splitList(alpn)
    if (q.get('packetAddr') === 'true') out['packet-addr'] = true
    if (q.get('xudp') === 'true') out.xudp = true
  }

  if (type === 'hysteria2') {
    const sni = firstNonEmpty(q.get('sni'), q.get('peer'), server)
    if (sni) {
      out.sni = sni
      out.servername = sni
    }
    const ports = firstNonEmpty(q.get('ports'), q.get('mport'))
    if (ports) out.ports = ports
    const obfs = q.get('obfs')
    if (obfs) out.obfs = obfs
    const obfsPassword = firstNonEmpty(q.get('obfs-password'), q.get('obfsPassword'))
    if (obfsPassword) out['obfs-password'] = obfsPassword
    const fp = firstNonEmpty(q.get('fp'), q.get('fingerprint'), q.get('pinSHA256'))
    if (fp && isCertPinningFingerprint(fp)) out.fingerprint = fp
    const alpn = q.get('alpn')
    if (alpn) out.alpn = splitList(alpn)
  }

  if (type === 'tuic') {
    const alpn = q.get('alpn')
    if (alpn) out.alpn = splitList(alpn)
    const cc = firstNonEmpty(q.get('congestion_control'), q.get('congestion-controller'))
    if (cc) out['congestion-controller'] = cc
    const relay = firstNonEmpty(q.get('udp_relay_mode'), q.get('udp-relay-mode'))
    if (relay) out['udp-relay-mode'] = relay
  }
  return out
}

function parseVmess(uri: string): Out | null {
  const body = uri.slice(8).split(/[?#]/)[0]
  const text = decodeB64(body)
  if (!text) return null
  let d: Record<string, unknown>
  try { d = JSON.parse(text) } catch { return null }
  if (!d || typeof d !== 'object') return null
  const str = (v: unknown) => (v === undefined || v === null ? '' : String(v)).trim()
  const port = Number(str(d.port))
  const server = str(d.add)
  if (!server || !Number.isInteger(port) || port <= 0 || port > 65535) return null
  const scy = str(d.scy)
  const out: Out = {
    name: str(d.ps), type: 'vmess', server, port, uuid: str(d.id),
    cipher: scy && scy.toLowerCase() !== 'auto' ? scy : 'auto',
  }
  const aid = Number(str(d.aid))
  if (str(d.aid) && Number.isInteger(aid)) out.alterId = aid

  const tlsRaw = d.tls
  const tlsOn = typeof tlsRaw === 'string'
    ? ['tls', 'true', '1'].includes(tlsRaw.toLowerCase())
    : typeof tlsRaw === 'boolean' ? tlsRaw : typeof tlsRaw === 'number' ? tlsRaw !== 0 : false
  const host = str(d.host)
  if (tlsOn) {
    const sni = str(d.sni) || host || server
    out.tls = true
    out.sni = sni
    out.servername = sni
    out['client-fingerprint'] = str(d.fp) || 'chrome'
    if (str(d.alpn)) out.alpn = splitList(str(d.alpn))
    if (typeof d['skip-cert-verify'] === 'boolean') out['skip-cert-verify'] = d['skip-cert-verify']
    else out['skip-cert-verify'] = ['1', 'true'].includes(str(d.allowInsecure).toLowerCase())
  }

  const net = str(d.net).toLowerCase()
  if (net && net !== 'tcp') {
    const path = str(d.path)
    out.network = net
    switch (net) {
      case 'ws':
        out['ws-opts'] = { path, headers: { Host: host } }
        break
      case 'grpc':
        out['grpc-opts'] = { 'grpc-service-name': path }
        break
      case 'http':
        out['http-opts'] = { method: 'GET', path: [path || '/'], headers: { Host: [host] } }
        break
      case 'h2':
        out['h2-opts'] = { path: path || '/', host: host ? [host] : [] }
        break
    }
  }
  return out
}

function normalizeSSCipher(method: string): string {
  return method.trim().toLowerCase() === 'chacha20-poly1305' ? 'chacha20-ietf-poly1305' : method.trim()
}

/** base64(method:password)；method 只允许常见加密名字符，避免把明文误当 base64 */
function decodeSSCredentials(userInfo: string): [string, string] | null {
  const text = decodeB64(userInfo)
  if (!text) return null
  const idx = text.indexOf(':')
  if (idx <= 0) return null
  const method = text.slice(0, idx)
  if (!/^[\w.+-]+$/.test(method)) return null
  return [method, text.slice(idx + 1)]
}

function applySSPlugin(out: Out, pluginRaw: string): void {
  pluginRaw = pluginRaw.trim()
  if (!pluginRaw) return
  const segments = pluginRaw.split(';')
  const plugin = segments[0].trim().toLowerCase()
  const rawOpts: Record<string, string> = {}
  for (let segment of segments.slice(1)) {
    segment = segment.trim()
    if (!segment) continue
    const idx = segment.indexOf('=')
    if (idx < 0) rawOpts[segment.toLowerCase()] = 'true'
    else rawOpts[segment.slice(0, idx).trim().toLowerCase()] = segment.slice(idx + 1).trim()
  }
  if (plugin === 'simple-obfs' || plugin === 'obfs-local' || plugin === 'obfs') {
    out.plugin = 'obfs'
    const opts: Out = {}
    const mode = firstNonEmpty(rawOpts.obfs, rawOpts.mode)
    if (mode) opts.mode = mode
    const host = firstNonEmpty(rawOpts['obfs-host'], rawOpts.host)
    if (host) opts.host = host
    if (Object.keys(opts).length) out['plugin-opts'] = opts
  } else if (plugin === 'v2ray-plugin') {
    out.plugin = plugin
    const opts: Out = { mode: rawOpts.mode || 'websocket' }
    for (const key of ['host', 'path', 'fingerprint']) if (rawOpts[key]) opts[key] = rawOpts[key]
    for (const key of ['tls', 'mux', 'skip-cert-verify']) if (rawOpts[key] === 'true' || rawOpts[key] === '1') opts[key] = true
    out['plugin-opts'] = opts
  } else {
    out.plugin = plugin
    if (Object.keys(rawOpts).length) out['plugin-opts'] = { ...rawOpts }
  }
}

/** 旧式：ss://base64(method:password)@host:port 或整串 ss://base64(method:password@host:port) */
function parseLegacySS(uri: string): Out | null {
  const hashIdx = uri.indexOf('#')
  const name = hashIdx >= 0 ? decode(uri.slice(hashIdx + 1)).trim() : ''
  let body = (hashIdx >= 0 ? uri.slice(5, hashIdx) : uri.slice(5)).split('?')[0].replace(/\/$/, '')
  if (!body.includes('@')) {
    const decoded = decodeB64(body)
    if (!decoded || !decoded.includes('@')) return null
    body = decoded.trim()
  }
  const at = body.lastIndexOf('@')
  const userInfo = body.slice(0, at)
  const hostPort = body.slice(at + 1)
  const colon = hostPort.lastIndexOf(':')
  if (colon <= 0) return null
  const server = hostPort.slice(0, colon).replace(/^\[(.*)\]$/, '$1')
  const port = Number(hostPort.slice(colon + 1))
  if (!server || !Number.isInteger(port) || port <= 0 || port > 65535) return null
  let creds = decodeSSCredentials(userInfo)
  if (!creds) {
    const idx = userInfo.indexOf(':')
    if (idx > 0) creds = [decode(userInfo.slice(0, idx)), decode(userInfo.slice(idx + 1))]
  }
  if (!creds || !creds[0] || !creds[1]) return null
  return { name, type: 'ss', server, port, cipher: normalizeSSCipher(creds[0]), password: creds[1] }
}

function parseShadowsocks(uri: string): Out | null {
  const u = parseUrl(uri)
  if (!u || !u.username || !u.hostname) return parseLegacySS(uri)
  let creds: [string, string] | null
  if (u.password) creds = [decode(u.username), decode(u.password)]
  else creds = decodeSSCredentials(decode(u.username))
  if (!creds) return parseLegacySS(uri)
  const port = portOf(u, 0)
  if (!port) return null
  const out: Out = {
    name: nameOf(u), type: 'ss', server: hostOf(u), port,
    cipher: normalizeSSCipher(creds[0]), password: creds[1],
  }
  applySSPlugin(out, u.searchParams.get('plugin') ?? '')
  return out
}

function parseSocks(uri: string): Out | null {
  const u = parseUrl(uri)
  if (!u || !u.hostname) return null
  const port = portOf(u, 1080)
  if (port === null) return null
  const out: Out = { name: nameOf(u), type: 'socks5', server: hostOf(u), port, udp: true }
  if (u.username) {
    out.username = decode(u.username)
    if (u.password) out.password = decode(u.password)
  }
  return out
}

function parseHttp(uri: string): Out | null {
  const u = parseUrl(uri)
  if (!u || !u.hostname) return null
  const https = u.protocol === 'https:'
  const port = portOf(u, https ? 443 : 80)
  if (port === null) return null
  const out: Out = { name: nameOf(u), type: 'http', server: hostOf(u), port }
  if (u.username) {
    out.username = decode(u.username)
    if (u.password) out.password = decode(u.password)
  }
  if (https) {
    out.tls = true
    out.sni = firstNonEmpty(u.searchParams.get('sni'), hostOf(u))
    if (queryFlag(u.searchParams, 'allowInsecure', 'insecure')) out['skip-cert-verify'] = true
  }
  return out
}

function decodeSSRParam(value: string | null): string {
  if (!value) return ''
  return (decodeB64(value) ?? decode(value)).trim()
}

function parseSSR(uri: string): Out | null {
  const prefix = uri.startsWith('shadowsocksr://') ? 'shadowsocksr://' : 'ssr://'
  let body = uri.slice(prefix.length).trim()
  const hash = body.indexOf('#')
  if (hash >= 0) body = body.slice(0, hash)
  let decoded = decodeB64(body)
  if (!decoded) return null
  let params = ''
  const q1 = decoded.indexOf('/?')
  if (q1 >= 0) {
    params = decoded.slice(q1 + 2)
    decoded = decoded.slice(0, q1)
  } else {
    const q2 = decoded.indexOf('?')
    if (q2 >= 0) {
      params = decoded.slice(q2 + 1)
      decoded = decoded.slice(0, q2).replace(/\/$/, '')
    }
  }
  // server:port:protocol:method:obfs:password_base64，server 可能是 IPv6，从右往左切
  const parts = decoded.split(':')
  if (parts.length < 6) return null
  const tail = parts.splice(parts.length - 5, 5)
  const server = parts.join(':').trim()
  const port = Number(tail[0])
  if (!server || !Number.isInteger(port) || port <= 0 || port > 65535) return null
  const password = decodeB64(tail[4].replace(/\/$/, ''))
  if (password === null) return null
  const out: Out = {
    name: '', type: 'ssr', server, port,
    protocol: tail[1], cipher: tail[2], obfs: tail[3], password, udp: true,
  }
  if (params) {
    const query = new URLSearchParams(params)
    const obfsParam = decodeSSRParam(query.get('obfsparam'))
    if (obfsParam) out['obfs-param'] = obfsParam
    const protoParam = decodeSSRParam(query.get('protoparam'))
    if (protoParam) out['protocol-param'] = protoParam
    const remarks = decodeSSRParam(query.get('remarks'))
    if (remarks) out.name = remarks
  }
  return out
}

function normalizeHysteriaSpeed(value: string): string {
  value = value.trim()
  if (!value) return ''
  return /^\d+$/.test(value) ? `${value} Mbps` : value
}

function parseHysteria(uri: string): Out | null {
  const u = parseUrl(uri)
  if (!u || !u.hostname) return null
  const port = portOf(u, 443)
  if (port === null) return null
  const q = u.searchParams
  const up = normalizeHysteriaSpeed(firstNonEmpty(q.get('up'), q.get('upmbps'), q.get('up-speed')))
  const down = normalizeHysteriaSpeed(firstNonEmpty(q.get('down'), q.get('downmbps'), q.get('down-speed')))
  if (!up || !down) return null
  const server = hostOf(u)
  const out: Out = {
    name: nameOf(u), type: 'hysteria', server, port, up, down,
    'auth-str': u.username ? decode(u.username) : (q.get('auth') ?? ''),
    sni: firstNonEmpty(q.get('sni'), q.get('peer'), server),
  }
  if (queryFlag(q, 'allowInsecure', 'insecure')) out['skip-cert-verify'] = true
  const obfs = q.get('obfs')
  if (obfs) out.obfs = obfs
  const alpn = q.get('alpn')
  if (alpn) out.alpn = splitList(alpn)
  return out
}

function parseAnyTLS(uri: string): Out | null {
  const u = parseUrl(uri)
  if (!u || !u.hostname) return null
  const port = portOf(u, 443)
  const password = decode(u.username)
  if (port === null || !password) return null
  const q = u.searchParams
  const server = hostOf(u)
  const out: Out = {
    name: nameOf(u), type: 'anytls', server, port, password,
    sni: firstNonEmpty(q.get('sni'), server), udp: true,
  }
  if (queryFlag(q, 'allowInsecure', 'insecure')) out['skip-cert-verify'] = true
  const fp = firstNonEmpty(q.get('fp'), q.get('fingerprint'))
  if (fp) out['client-fingerprint'] = fp
  const alpn = q.get('alpn')
  if (alpn) out.alpn = splitList(alpn)
  return out
}

function dispatch(uri: string): Out | null {
  const lower = uri.slice(0, 16).toLowerCase()
  if (lower.startsWith('vless://')) return parseSimple(uri, 'vless')
  if (lower.startsWith('trojan://')) return parseSimple(uri, 'trojan')
  if (lower.startsWith('vmess://')) return parseVmess(uri)
  if (lower.startsWith('ss://')) return parseShadowsocks(uri)
  if (lower.startsWith('hysteria2://') || lower.startsWith('hy2://')) return parseSimple(uri, 'hysteria2')
  if (lower.startsWith('tuic://')) return parseSimple(uri, 'tuic')
  if (lower.startsWith('socks5://') || lower.startsWith('socks5h://') || lower.startsWith('socks://')) return parseSocks(uri)
  if (lower.startsWith('http://') || lower.startsWith('https://')) return parseHttp(uri)
  if (lower.startsWith('ssr://') || lower.startsWith('shadowsocksr://')) return parseSSR(uri)
  if (lower.startsWith('hysteria://')) return parseHysteria(uri)
  if (lower.startsWith('anytls://')) return parseAnyTLS(uri)
  return null
}

/** 解析单条节点链接；不支持或字段不全返回 null */
export function parseProxyUri(line: string): ParsedUri | null {
  const uri = line.trim()
  if (!uri) return null
  const out = dispatch(uri)
  if (!out || !out.server || !out.port) return null
  const { name, ...config } = out
  const fallback = `${config.server}:${config.port}`
  return { name: (typeof name === 'string' && name.trim()) || fallback, config }
}
