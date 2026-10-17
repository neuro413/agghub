import crypto from 'node:crypto'
import type { Request } from 'express'
import { getProxyAgent } from './proxy'
import type { DiscordGuild, Settings } from '../types'

// 门户 Discord 登录：授权码模式，请求 Discord 一律走设置里的全局代理

const API = 'https://discord.com/api/v10'
const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize'
/** Discord 回跳到门户的页面，需要原样登记到 Discord 应用的 Redirects */
export const DISCORD_CALLBACK_PATH = '/oauth/discord'
/** 发起授权时写入的 state，只发往门户的 Discord 接口 */
export const DISCORD_STATE_COOKIE = 'agh_oauth_state'
const STATE_COOKIE_PATH = '/api/user/oauth/discord'
const STATE_TTL_SECONDS = 600
const TIMEOUT_MS = 15_000

/** 可以直接展示给用户的失败原因 */
export class DiscordError extends Error {}

export interface DiscordProfile {
  id: string
  username: string
  /** 用户所在的服务器；没拿到时为 null，不影响登录 */
  guilds: DiscordGuild[] | null
}

/** 开关打开且凭据齐全才算启用 */
export function discordReady(s: Settings): boolean {
  return s.discord_enabled && !!s.discord_client_id && !!s.discord_client_secret
}

/** 回调地址：优先用公网 Base URL，留空时按本次请求的地址；发起与回调两步算法相同，保证与授权时一致 */
export function discordRedirectUri(s: Settings, req: Request): string {
  const base = s.public_base_url.trim().replace(/\/+$/, '') || `${req.protocol}://${req.get('host') ?? ''}`
  return base + DISCORD_CALLBACK_PATH
}

export function newDiscordState(): string {
  return crypto.randomBytes(24).toString('base64url')
}

/** guilds 用来记录用户所在的服务器供管理端排查；设了服务器门槛时多要 guilds.members.read，用来查成员身份和身份组 */
export function discordAuthorizeUrl(s: Settings, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: s.discord_client_id,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: s.discord_guild_id ? 'identify guilds guilds.members.read' : 'identify guilds',
    state,
    // 授权过同样权限的用户直接跳回，首次授权仍会显示确认页
    prompt: 'none',
  })
  return `${AUTHORIZE_URL}?${params}`
}

/** Set-Cookie 值；state 为空时生成立即过期的清除指令 */
export function discordStateCookie(state: string, secure: boolean): string {
  const maxAge = state ? STATE_TTL_SECONDS : 0
  return `${DISCORD_STATE_COOKIE}=${state}; Path=${STATE_COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
}

/** 回调带回的 state 与 Cookie 里的一致 */
export function discordStateMatches(received: unknown, expected: string): boolean {
  if (typeof received !== 'string' || !received || !expected) return false
  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

async function discordFetch(path: string, init: RequestInit, s: Settings): Promise<Response> {
  try {
    return await fetch(API + path, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      dispatcher: s.proxy_url ? getProxyAgent(s.proxy_url) : undefined,
    } as any)
  } catch (error) {
    console.error('[agghub] 请求 Discord 失败:', (error as Error).message)
    throw new DiscordError('连接 Discord 失败，请稍后再试')
  }
}

async function exchangeCode(s: Settings, code: string, redirectUri: string): Promise<string> {
  const r = await discordFetch('/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      client_id: s.discord_client_id,
      client_secret: s.discord_client_secret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }).toString(),
  }, s)
  const body: any = await r.json().catch(() => null)
  if (r.ok && typeof body?.access_token === 'string' && body.access_token) return body.access_token
  console.warn(`[agghub] Discord 换取令牌失败: HTTP ${r.status} ${body?.error ?? ''} ${body?.error_description ?? ''}`)
  // invalid_grant 是授权码过期或已用过；其余多半是 Client ID / Secret / 回调地址配置不对
  throw new DiscordError(body?.error === 'invalid_grant' ? '授权已过期，请重新发起 Discord 登录' : 'Discord 授权失败，请联系管理员检查 Discord 登录配置')
}

async function fetchProfile(s: Settings, token: string): Promise<Omit<DiscordProfile, 'guilds'>> {
  const r = await discordFetch('/users/@me', { headers: { authorization: `Bearer ${token}` } }, s)
  const body: any = await r.json().catch(() => null)
  if (!r.ok || typeof body?.id !== 'string' || !/^\d{1,20}$/.test(body.id) || typeof body?.username !== 'string') {
    console.warn(`[agghub] 获取 Discord 用户信息失败: HTTP ${r.status}`)
    throw new DiscordError('获取 Discord 用户信息失败，请稍后再试')
  }
  return { id: body.id, username: body.username }
}

/** 服务器与身份组门槛；没有设置服务器时直接通过 */
async function checkMembership(s: Settings, token: string): Promise<void> {
  if (!s.discord_guild_id) return
  const r = await discordFetch(`/users/@me/guilds/${s.discord_guild_id}/member`, { headers: { authorization: `Bearer ${token}` } }, s)
  const body: any = await r.json().catch(() => null)
  if (r.status === 404) throw new DiscordError('需要先加入指定的 Discord 服务器才能登录')
  if (r.status === 429) throw new DiscordError('Discord 请求过于频繁，请稍后再试')
  if (!r.ok || !body || typeof body !== 'object') {
    console.warn(`[agghub] 查询 Discord 服务器成员失败: HTTP ${r.status} ${body?.message ?? ''}`)
    throw new DiscordError('查询 Discord 服务器成员身份失败，请稍后再试')
  }
  // 服务器开启了成员审核时，没通过审核的成员 pending 为 true
  if (body.pending === true) throw new DiscordError('请先在 Discord 服务器中完成成员验证')
  const roles: unknown[] = Array.isArray(body.roles) ? body.roles : []
  if (s.discord_role_ids.length && !s.discord_role_ids.some(id => roles.includes(id))) {
    throw new DiscordError('你在 Discord 服务器中没有登录所需的身份组')
  }
}

/** 用户所在的服务器（Discord 一次最多返回 200 个，普通用户上限 100、Nitro 200，一次取完）；失败时返回 null */
async function fetchGuilds(s: Settings, token: string): Promise<DiscordGuild[] | null> {
  let r: Response
  try {
    r = await discordFetch('/users/@me/guilds?with_counts=true', { headers: { authorization: `Bearer ${token}` } }, s)
  } catch {
    return null
  }
  const body: any = await r.json().catch(() => null)
  if (!r.ok || !Array.isArray(body)) {
    console.warn(`[agghub] 获取 Discord 服务器列表失败: HTTP ${r.status} ${body?.message ?? ''}`)
    return null
  }
  return body
    .filter(g => typeof g?.id === 'string' && /^\d{1,20}$/.test(g.id) && typeof g.name === 'string')
    .map(g => ({
      id: g.id,
      name: g.name.slice(0, 100),
      // 图标哈希要拼进 CDN 地址，只收十六进制（动图带 a_ 前缀）
      icon: typeof g.icon === 'string' && /^(a_)?[0-9a-f]{1,64}$/.test(g.icon) ? g.icon : null,
      owner: g.owner === true,
      member_count: Number.isSafeInteger(g.approximate_member_count) ? g.approximate_member_count : null,
    }))
}

/** 用授权码换取 Discord 用户，并检查服务器与身份组门槛；服务器列表与门槛检查并行请求 */
export async function authorizeDiscord(s: Settings, code: string, redirectUri: string): Promise<DiscordProfile> {
  const token = await exchangeCode(s, code, redirectUri)
  const profile = await fetchProfile(s, token)
  const [, guilds] = await Promise.all([checkMembership(s, token), fetchGuilds(s, token)])
  return { ...profile, guilds }
}
