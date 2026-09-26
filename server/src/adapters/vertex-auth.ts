import crypto from 'node:crypto'
import { getProxyAgent } from '../core/proxy'

export interface Credentials {
  project_id: string
  private_key: string
  client_email: string
}

export function parseCredentials(raw: string): Credentials | null {
  try {
    const obj = JSON.parse(raw)
    if (obj?.project_id && obj?.private_key && obj?.client_email) return obj
  } catch {}
  return null
}

// ── token 缓存 ──────────────────────────────────────────
interface CacheEntry {
  token: string
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

export async function getAccessToken(creds: Credentials, proxyUrl?: string, signal?: AbortSignal): Promise<string> {
  const cached = getCachedToken(creds)
  if (cached) return cached
  const token = await exchangeJwtForAccessToken(createSignedJWT(creds.client_email, creds.private_key), proxyUrl, signal)
  cache.set(creds.client_email, { token, expiresAt: Date.now() + 50 * 60 * 1000 })
  return token
}

/** 同步读缓存中的 token（prepareChannel 保证已填充），缓存未命中返回 null */
export function getCachedToken(creds: Credentials): string | null {
  const entry = cache.get(creds.client_email)
  if (entry && entry.expiresAt > Date.now()) return entry.token
  return null
}

// ── JWT 签发 ──────────────────────────────────────────────
function createSignedJWT(email: string, privateKeyPEM: string): string {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = {
    iss: email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://www.googleapis.com/oauth2/v4/token',
    iat: now,
    exp: now + 55 * 60,
  }

  const segments = [base64url(JSON.stringify(header)), base64url(JSON.stringify(payload))]
  const signingInput = segments.join('.')

  const normalizedKey = normalizePEM(privateKeyPEM)
  const sign = crypto.createSign('RSA-SHA256')
  sign.update(signingInput)
  const signature = sign.sign(normalizedKey, 'base64url')

  return `${signingInput}.${signature}`
}

function normalizePEM(raw: string): string {
  let body = raw
    .replace(/-----BEGIN [\w ]+-----/g, '')
    .replace(/-----END [\w ]+-----/g, '')
    .replace(/\\n/g, '')
    .replace(/\r?\n/g, '')
    .trim()
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`
}

function base64url(str: string): string {
  return Buffer.from(str).toString('base64url')
}

// ── token 交换 ────────────────────────────────────────────
async function exchangeJwtForAccessToken(jwt: string, proxyUrl?: string, signal?: AbortSignal): Promise<string> {
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(new Error('OAuth 交换超过 15 秒时限')), 15_000)
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  const opts: any = {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(),
    signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
  }
  if (proxyUrl) opts.dispatcher = getProxyAgent(proxyUrl)
  try {
    const resp = await fetch('https://www.googleapis.com/oauth2/v4/token', opts)
    const text = await resp.text()
    if (!resp.ok) throw new Error(`Google OAuth token exchange failed (${resp.status}): ${text.slice(0, 300)}`)
    const json: any = JSON.parse(text)
    if (typeof json.access_token !== 'string' || !json.access_token) throw new Error('Google OAuth response missing access_token')
    return json.access_token
  } finally { clearTimeout(timer) }
}
