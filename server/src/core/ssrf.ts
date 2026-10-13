import dns from 'node:dns'
import net from 'node:net'
import { Agent } from 'undici'
import { CandidateError } from './failover'

/** 禁止公网调用方访问的 IPv4 网段：[网络地址, 前缀长度] */
const BLOCKED_V4: Array<[number, number]> = [
  [0x00000000, 8],   // 0.0.0.0/8 未指定
  [0x0a000000, 8],   // 10.0.0.0/8
  [0x64400000, 10],  // 100.64.0.0/10 CGNAT
  [0x7f000000, 8],   // 127.0.0.0/8 回环
  [0xa9fe0000, 16],  // 169.254.0.0/16 链路本地（含云元数据）
  [0xac100000, 12],  // 172.16.0.0/12
  [0xc0000000, 24],  // 192.0.0.0/24
  [0xc0000200, 24],  // 192.0.2.0/24 文档
  [0xc0a80000, 16],  // 192.168.0.0/16
  [0xc6120000, 15],  // 198.18.0.0/15 基准测试
  [0xc6336400, 24],  // 198.51.100.0/24 文档
  [0xcb007100, 24],  // 203.0.113.0/24 文档
  [0xe0000000, 4],   // 224.0.0.0/4 组播
  [0xf0000000, 4],   // 240.0.0.0/4 保留（含 255.255.255.255）
]

/** IPv4 点分字符串转 32 位无符号整数；非法返回 null */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const v = Number(p)
    if (v > 255) return null
    n = n * 256 + v
  }
  return n >>> 0
}

/** 两个 16 位组还原成点分 IPv4（用于 IPv4 映射 / NAT64 / 兼容地址） */
function groupsToIpv4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
}

/** IPv6 的单个组转 16 位数字；点分 IPv4 形式返回两个组。非法返回 null */
function parseGroup(g: string): number[] | null {
  if (g.includes('.')) {
    const int = ipv4ToInt(g)
    if (int === null) return null
    return [int >>> 16, int & 0xffff]
  }
  if (!/^[0-9a-f]{1,4}$/.test(g)) return null
  return [parseInt(g, 16)]
}

/** 展开 IPv6 为 8 个 16 位组；非法或无法压缩到 8 组返回 null */
function expandIpv6(ip: string): number[] | null {
  const d = ip.indexOf('::')
  const parseList = (list: string[]): number[] | null => {
    const out: number[] = []
    for (let i = 0; i < list.length; i++) {
      if (list[i] === '') return null
      // 点分 IPv4 只能出现在最后一段
      const gs = parseGroup(list[i])
      if (!gs || (list[i].includes('.') && i !== list.length - 1)) return null
      out.push(...gs)
    }
    return out
  }
  if (d === -1) {
    const g = parseList(ip.split(':'))
    return g && g.length === 8 ? g : null
  }
  if (ip.indexOf('::', d + 1) !== -1) return null
  const headStr = ip.slice(0, d)
  const tailStr = ip.slice(d + 2)
  const head = headStr ? parseList(headStr.split(':')) : []
  const tail = tailStr ? parseList(tailStr.split(':')) : []
  if (head === null || tail === null) return null
  const fill = 8 - head.length - tail.length
  if (fill < 1) return null
  return [...head, ...new Array<number>(fill).fill(0), ...tail]
}

function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip)
  if (n === null) return true
  // & 运算结果是有符号 32 位，需要 >>> 0 转回无符号再和网络地址比较
  return BLOCKED_V4.some(([base, bits]) => ((n & ((0xffffffff << (32 - bits)) >>> 0)) >>> 0) === base)
}

/** IP 是否属于禁止公网调用方访问的地址（回环、私有、链路本地、CGNAT、组播、未指定、IPv6 ULA / 链路本地、IPv4 映射地址按内部 IPv4 判断） */
export function isBlockedAddress(ip: string): boolean {
  // 去掉方括号与 IPv6 zone（%eth0）
  let t = ip.trim()
  if (t.startsWith('[') && t.endsWith(']')) t = t.slice(1, -1)
  const zone = t.indexOf('%')
  if (zone !== -1) t = t.slice(0, zone)
  if (net.isIPv4(t)) return isBlockedIpv4(t)
  if (!net.isIPv6(t)) return true
  const g = expandIpv6(t.toLowerCase())
  if (!g) return true
  // :: 全 0 与 ::1
  if (g.every(x => x === 0)) return true
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && g[6] === 0 && g[7] === 1) return true
  if ((g[0] & 0xfe00) === 0xfc00) return true // fc00::/7 ULA
  if ((g[0] & 0xffc0) === 0xfe80) return true // fe80::/10 链路本地
  if ((g[0] & 0xff00) === 0xff00) return true // ff00::/8 组播
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true // 2001:db8::/32 文档
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return isBlockedIpv4(groupsToIpv4(g[6], g[7])) // ::ffff:0:0/96
  }
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return isBlockedIpv4(groupsToIpv4(g[6], g[7])) // 64:ff9b::/96 NAT64
  }
  // IPv4 兼容地址：前 6 组全 0，且不是 :: 和 ::1
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && !(g[6] === 0 && (g[7] === 0 || g[7] === 1))) {
    return isBlockedIpv4(groupsToIpv4(g[6], g[7]))
  }
  return false
}

/** 公网模式下校验图片 URL：仅允许 http(s)，且域名解析出的全部 IP 均为公网地址 */
export async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new CandidateError('图片地址无效')
  let host = url.hostname
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new CandidateError('图片地址指向内网或保留地址，已拒绝')
    return
  }
  let addresses: dns.LookupAddress[]
  try {
    addresses = await dns.promises.lookup(host, { all: true, verbatim: true })
  } catch {
    throw new CandidateError('图片域名解析失败')
  }
  if (!addresses.length || addresses.some(a => isBlockedAddress(a.address))) throw new CandidateError('图片地址指向内网或保留地址，已拒绝')
}

/** undici 连接时的 lookup：建立连接前再校验一次，防 DNS 重绑定 */
export function safeLookup(hostname: string, options: dns.LookupOptions, callback: (...args: any[]) => void): void {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error)
    const list = addresses as dns.LookupAddress[]
    if (!list.length || list.some(a => isBlockedAddress(a.address))) return callback(new Error('目标地址属于内网或保留地址'))
    if (options.all) callback(null, list)
    else callback(null, list[0].address, list[0].family)
  })
}

let safeAgent: Agent | null = null

/** 公网下载用 undici Agent（懒加载单例），连接阶段套用 safeLookup */
export function getSafeAgent(): Agent {
  safeAgent ??= new Agent({ connect: { lookup: safeLookup } as any })
  return safeAgent
}
