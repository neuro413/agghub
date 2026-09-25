import { BlockList, isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { domainToASCII } from 'node:url'
import { abortable } from './requestLifecycle'
import { CandidateError } from './failover'

const privateAddresses = new BlockList()
const forbiddenAddresses = new BlockList()
const publicV6 = new BlockList()
publicV6.addSubnet('2000::', 3, 'ipv6')
const mappedV4 = new BlockList()
mappedV4.addSubnet('::ffff:0:0', 96, 'ipv6')
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['192.88.99.0', 24],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) privateAddresses.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [['::', 96], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16]] as const) privateAddresses.addSubnet(address, prefix, 'ipv6')
for (const [address, prefix] of [['0.0.0.0', 8], ['169.254.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4], ['100.100.100.200', 32]] as const) forbiddenAddresses.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [['::', 128], ['fe80::', 10], ['ff00::', 8], ['fd00:ec2::254', 128]] as const) forbiddenAddresses.addSubnet(address, prefix, 'ipv6')

export function unbracket(host: string): string { return host.replace(/^\[|\]$/g, '').toLowerCase() }
export function normalizedHost(host: string): string {
  const value = unbracket(host).replace(/\.$/, '')
  return isIP(value) ? value : domainToASCII(value).toLowerCase()
}

/** 白名单只接受精确主机/IP/CIDR，禁止含协议、端口、路径或通配符。 */
export function validateImageAllowEntry(entry: string): void {
  if (!entry || entry !== entry.trim() || entry.length > 253) throw new Error('图片白名单须为精确主机、IP 或 CIDR')
  const [address, prefix, extra] = entry.split('/')
  if (prefix !== undefined) {
    const family = isIP(unbracket(address))
    if (extra !== undefined || !family || !/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)) throw new Error('图片白名单 CIDR 无效')
    return
  }
  if (isIP(unbracket(entry))) return
  const hostname = domainToASCII(entry)
  if (!hostname || !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.?$/i.test(hostname) || hostname.split('.').some(label => label.length > 63 || label.startsWith('-') || label.endsWith('-')) || hostname.includes('..')) throw new Error('图片白名单主机名无效')
}

function isAllowed(host: string, address: string, entries: string[]): boolean {
  const family = isIP(address) === 6 ? 'ipv6' : 'ipv4'
  return entries.some(entry => {
    validateImageAllowEntry(entry)
    const [network, prefix] = entry.split('/')
    if (prefix !== undefined) {
      const list = new BlockList()
      list.addSubnet(unbracket(network), Number(prefix), isIP(unbracket(network)) === 6 ? 'ipv6' : 'ipv4')
      return list.check(address, family)
    }
    return normalizedHost(entry) === host || normalizedHost(entry) === normalizedHost(address)
  })
}

export type ImageLookup = (host: string) => Promise<{ address: string; family: number }[]>
export const lookupImageHost: ImageLookup = host => lookup(host, { all: true, verbatim: true })

export async function validateImageTarget(raw: string, allowed: string[], signal: AbortSignal, resolver: ImageLookup = lookupImageHost): Promise<{ url: URL; address: string }> {
  let url: URL
  try { url = new URL(raw) } catch { throw new CandidateError('图片地址无效') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new CandidateError('图片仅允许不含凭证的 HTTP/HTTPS 地址')
  const host = normalizedHost(url.hostname)
  if (!host || host.includes('%')) throw new CandidateError('图片主机地址无效')
  signal.throwIfAborted()
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await abortable(resolver(host), signal)
  if (!addresses.length) throw new CandidateError('图片域名没有可用地址')
  for (const result of addresses) {
    const address = unbracket(result.address)
    const version = isIP(address)
    if (!version) throw new CandidateError('图片域名解析结果无效')
    const family = version === 6 ? 'ipv6' : 'ipv4'
    // BlockList 同时识别 IPv4-mapped IPv6，不能用地址表示形式绕过限制。
    if (forbiddenAddresses.check(address, family)) throw new CandidateError('图片目标属于禁止访问的保留/元数据地址')
    const reservedV6 = version === 6 && !publicV6.check(address, 'ipv6') && !mappedV4.check(address, 'ipv6')
    if ((reservedV6 || privateAddresses.check(address, family)) && !isAllowed(host, address, allowed)) throw new CandidateError('图片目标属于内网或保留地址，请配置可信图片白名单')
  }
  signal.throwIfAborted()
  return { url, address: unbracket(addresses[0].address) }
}
