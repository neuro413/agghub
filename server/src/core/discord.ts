import crypto from 'node:crypto'
import type { Request } from 'express'
import { getProxyAgent } from './proxy'
import type { DiscordGuild, DiscordGuildCondition, Settings } from '../types'

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
    scope: s.discord_rules.length ? 'identify guilds guilds.members.read' : 'identify guilds',
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

interface GuildMember {
  roles: string[]
  pending: boolean
}

/** 用户在某个服务器的成员信息；不是成员时返回 null，查询失败时抛出 DiscordError */
async function fetchMember(s: Settings, token: string, guildId: string): Promise<GuildMember | null> {
  const r = await discordFetch(`/users/@me/guilds/${guildId}/member`, { headers: { authorization: `Bearer ${token}` } }, s)
  const body: any = await r.json().catch(() => null)
  if (r.status === 404) return null
  if (r.status === 429) throw new DiscordError('Discord 请求过于频繁，请稍后再试')
  if (!r.ok || !body || typeof body !== 'object') {
    console.warn(`[agghub] 查询 Discord 服务器成员失败: HTTP ${r.status} ${body?.message ?? ''}`)
    throw new DiscordError('查询 Discord 服务器成员身份失败，请稍后再试')
  }
  return { roles: Array.isArray(body.roles) ? body.roles.filter((id: unknown) => typeof id === 'string') : [], pending: body.pending === true }
}

/** 服务器条件不满足的原因，满足时返回 null */
function conditionFailure(condition: DiscordGuildCondition, member: GuildMember | null): string | null {
  if (!member) return '需要先加入指定的 Discord 服务器才能登录'
  // 服务器开启了成员审核时，没通过审核的成员 pending 为 true
  if (member.pending) return '请先在 Discord 服务器中完成成员验证'
  const has = (id: string) => member.roles.includes(id)
  if (condition.deny_roles.some(has)) return '你在 Discord 服务器中的身份组不允许登录'
  if (!condition.all_roles.every(has) || (condition.any_roles.length && !condition.any_roles.some(has))) {
    return '你在 Discord 服务器中没有登录所需的身份组'
  }
  return null
}

/**
 * 服务器与身份组门槛：满足任一规则组即可，组内每个服务器条件都要满足；没有规则时直接通过。
 * 拿到了服务器列表时，不在列表里的服务器直接按非成员处理，只查询用户加入了的服务器
 */
async function checkMembership(s: Settings, token: string, guilds: DiscordGuild[] | null): Promise<void> {
  if (!s.discord_rules.length) return
  const joined = guilds && new Set(guilds.map(g => g.id))
  const guildIds = [...new Set(s.discord_rules.flatMap(group => group.conditions.map(c => c.guild_id)))]
  const members = new Map(await Promise.all(guildIds.map(async (id): Promise<[string, GuildMember | null | DiscordError]> => {
    if (joined && !joined.has(id)) return [id, null]
    try {
      return [id, await fetchMember(s, token, id)]
    } catch (error) {
      if (error instanceof DiscordError) return [id, error]
      throw error
    }
  })))
  const reasons: string[] = []
  let queryError: DiscordError | null = null
  for (const group of s.discord_rules) {
    let failure: string | null = null
    let error: DiscordError | null = null
    for (const condition of group.conditions) {
      const member = members.get(condition.guild_id) ?? null
      if (member instanceof DiscordError) error ??= member
      else if ((failure = conditionFailure(condition, member))) break
    }
    if (failure) reasons.push(failure)
    else if (error) queryError ??= error
    else return
  }
  // 有规则组因查询失败没法判断时报告查询失败，不能当作不满足条件
  if (queryError) throw queryError
  throw new DiscordError(new Set(reasons).size === 1 ? reasons[0] : '你的 Discord 账号不满足任何一组登录条件（服务器或身份组）')
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

/** 用授权码换取 Discord 用户，并检查服务器与身份组门槛；门槛检查用服务器列表减少成员查询，所以先取列表 */
export async function authorizeDiscord(s: Settings, code: string, redirectUri: string): Promise<DiscordProfile> {
  const token = await exchangeCode(s, code, redirectUri)
  const profile = await fetchProfile(s, token)
  const guilds = await fetchGuilds(s, token)
  await checkMembership(s, token, guilds)
  return { ...profile, guilds }
}
