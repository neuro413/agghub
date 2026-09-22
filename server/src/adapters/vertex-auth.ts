import crypto from 'node:crypto'
import { getProxyAgent } from '../core/proxy'

export interface Credentials {
  project_id: string
  private_key_id?: string
  private_key: string
  client_email: string
  client_id?: string
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

export async function getAccessToken(creds: Credentials, proxyUrl?: string): Promise<string> {
  const key = creds.client_email
  const now = Date.now()
  const cached = cache.get(key)
  if (cached && cached.expiresAt > now) return cached.token

  const jwt = createSignedJWT(creds.client_email, creds.private_key)
  const token = await exchangeJwtForAccessToken(jwt, proxyUrl)
  cache.set(key, { token, expiresAt: now + 50 * 60 * 1000 })
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
async function exchangeJwtForAccessToken(jwt: string, proxyUrl?: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  })

  const opts: any = {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }
  if (proxyUrl) opts.dispatcher = getProxyAgent(proxyUrl)

  const resp = await fetch('https://www.googleapis.com/oauth2/v4/token', opts)
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Google OAuth token exchange failed (${resp.status}): ${text.slice(0, 300)}`)
  }
  const json: any = await resp.json()
  if (!json.access_token) throw new Error(`Google OAuth response missing access_token: ${JSON.stringify(json).slice(0, 300)}`)
  return json.access_token
}
