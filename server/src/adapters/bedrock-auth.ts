import crypto from 'node:crypto'

export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  region?: string
}

/**
 * 解析 AWS IAM 凭证，支持以下格式：
 * 1. JSON 对象：兼容 accessKeyId / access_key_id / AccessKeyId / AWS_ACCESS_KEY_ID 等命名
 * 2. 分隔符文本：AK|SK、AK|SK|SessionToken、AK:SK、AK:SK:SessionToken
 *    （AWS AccessKeyId 为字母数字，SecretAccessKey 与 SessionToken 均为 base64，不含 | 或 :）
 */
export function parseAwsCredentials(raw: string): AwsCredentials | null {
  const trimmed = (raw || '').trim()
  if (!trimmed) return null

  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed)
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
      const accessKeyId = String(obj.accessKeyId ?? obj.access_key_id ?? obj.AccessKeyId ?? obj.AWS_ACCESS_KEY_ID ?? '').trim()
      const secretAccessKey = String(obj.secretAccessKey ?? obj.secret_access_key ?? obj.SecretAccessKey ?? obj.AWS_SECRET_ACCESS_KEY ?? '').trim()
      const sessionToken = String(obj.sessionToken ?? obj.session_token ?? obj.SessionToken ?? obj.AWS_SESSION_TOKEN ?? '').trim()
      const region = String(obj.region ?? obj.aws_region ?? obj.AWS_REGION ?? '').trim()
      if (!accessKeyId || !secretAccessKey) return null
      return {
        accessKeyId,
        secretAccessKey,
        ...(sessionToken ? { sessionToken } : {}),
        ...(region ? { region } : {}),
      }
    } catch {
      return null
    }
  }

  // 优先按 | 拆分，其次按 : 拆分
  const sep = trimmed.includes('|') ? '|' : trimmed.includes(':') ? ':' : null
  if (!sep) return null
  const parts = trimmed.split(sep)
  if (parts.length < 2 || parts.length > 3) return null
  const accessKeyId = parts[0].trim()
  const secretAccessKey = parts[1].trim()
  const sessionToken = parts[2]?.trim()
  if (!accessKeyId || !secretAccessKey) return null
  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
  }
}

/** 按 RFC 3986 编码单个字符序列（保留 A-Z a-z 0-9 - _ . ~） */
export function rfc3986Encode(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

/**
 * AWS SigV4 规范 URI（非 S3 服务需要双重编码）：
 * URL pathname 中的每段已经经过一次 URI 编码（例如 modelId 中的 : 已是 %3A），
 * 再对每段做一次 RFC 3986 编码（变成 %253A），与 AWS SDK 行为完全一致。
 */
export function canonicalUri(pathname: string): string {
  if (!pathname || pathname === '/') return '/'
  return pathname
    .split('/')
    .map((segment) => rfc3986Encode(segment))
    .join('/')
}

/** AWS SigV4 规范查询字符串：键与值分别 RFC 3986 编码后按键值字典序排列 */
export function canonicalQueryString(searchParams: URLSearchParams): string {
  const pairs: [string, string][] = []
  searchParams.forEach((value, key) => {
    pairs.push([rfc3986Encode(key), rfc3986Encode(value)])
  })
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
  return pairs.map(([k, v]) => `${k}=${v}`).join('&')
}

function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest()
}

function formatAmzDate(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { amzDate: iso, dateStamp: iso.slice(0, 8) }
}

/** 参与 SigV4 签名的稳定请求头判定（避免纳入易被代理改写的 user-agent / connection 等头） */
function shouldSignHeader(lowerName: string): boolean {
  return (
    lowerName === 'host' ||
    lowerName === 'content-type' ||
    lowerName === 'content-encoding' ||
    lowerName === 'accept' ||
    lowerName.startsWith('x-amz-') ||
    lowerName.startsWith('x-amzn-')
  )
}

export interface SignAwsV4Input {
  method: string
  url: string
  headers: Record<string, string>
  body: string | Buffer
  credentials: AwsCredentials
  region: string
  service?: string
  date?: Date
}

/**
 * 计算 AWS Signature Version 4 签名，返回带有 Authorization、x-amz-date、
 * x-amz-content-sha256（及可选 x-amz-security-token）的新请求头副本。
 */
export function signAwsV4(input: SignAwsV4Input): Record<string, string> {
  const method = input.method.toUpperCase()
  const parsed = new URL(input.url)
  const service = input.service || 'bedrock'
  const { amzDate, dateStamp } = formatAmzDate(input.date ?? new Date())
  const payloadHash = sha256Hex(input.body)

  // 规整请求头为小写键，清除可能残留的旧签名头
  const outHeaders: Record<string, string> = {}
  for (const [k, v] of Object.entries(input.headers)) {
    const lower = k.toLowerCase()
    if (
      lower === 'authorization' ||
      lower === 'x-amz-date' ||
      lower === 'x-amz-content-sha256' ||
      lower === 'x-amz-security-token' ||
      lower === 'host'
    ) {
      continue
    }
    outHeaders[lower] = v
  }
  outHeaders['x-amz-date'] = amzDate
  outHeaders['x-amz-content-sha256'] = payloadHash
  if (input.credentials.sessionToken) {
    outHeaders['x-amz-security-token'] = input.credentials.sessionToken
  }

  // host 仅用于签名计算，fetch 会按 URL 自动发送 Host 头
  const isDefaultPort =
    (parsed.protocol === 'https:' && (!parsed.port || parsed.port === '443')) ||
    (parsed.protocol === 'http:' && (!parsed.port || parsed.port === '80'))
  const hostValue = isDefaultPort ? parsed.hostname : parsed.host

  const signEntries: [string, string][] = [['host', hostValue]]
  for (const [k, v] of Object.entries(outHeaders)) {
    if (shouldSignHeader(k)) {
      signEntries.push([k, v.trim().replace(/\s+/g, ' ')])
    }
  }
  signEntries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))

  const canonicalHeaders = signEntries.map(([k, v]) => `${k}:${v}\n`).join('')
  const signedHeaders = signEntries.map(([k]) => k).join(';')

  const canonicalRequest = [
    method,
    canonicalUri(parsed.pathname),
    canonicalQueryString(parsed.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const credentialScope = `${dateStamp}/${input.region}/${service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n')

  const kDate = hmacSha256(`AWS4${input.credentials.secretAccessKey}`, dateStamp)
  const kRegion = hmacSha256(kDate, input.region)
  const kService = hmacSha256(kRegion, service)
  const kSigning = hmacSha256(kService, 'aws4_request')
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

  outHeaders.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return outHeaders
}
