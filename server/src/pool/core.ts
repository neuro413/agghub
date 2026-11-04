import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { Readable } from 'node:stream'
import zlib from 'node:zlib'
import { DATA_DIR } from '../config'
import { getSettings } from '../db'
import { closeProxyAgent, getProxyAgent } from '../core/proxy'
import { getPoolSettings } from './settings'
import { allNodes, setInvalid } from './store'
import { parseProxyUri } from './uri'
import type { CoreState, CoreStatus, DelayResult } from './types'

export const CORE_HOME = path.join(DATA_DIR, 'mihomo')
const EXE_NAME = process.platform === 'win32' ? 'mihomo.exe' : 'mihomo'
const DEFAULT_BIN = path.join(CORE_HOME, EXE_NAME)
const PID_FILE = path.join(CORE_HOME, 'mihomo.pid')
const CONFIG_FILE = path.join(CORE_HOME, 'config.yaml')
export const ENTRY_NAME = 'agghub-entry'
const RESTART_DELAYS = [2, 5, 10, 30, 60]
const LOG_MAX = 200

export function corePath(): string {
  const custom = getPoolSettings().core_path
  return custom ? path.resolve(custom) : DEFAULT_BIN
}

let child: ChildProcess | null = null
let state: CoreState = 'stopped'
let lastError: string | null = null
let version: string | null = null
let versionPath: string | null = null
let entryError: string | null = null
let downloading = false
let manualStop = false
let restartTimer: NodeJS.Timeout | null = null
let restartAttempt = 0
let startedAt = 0
let lastReloadAt = 0
let startPromise: Promise<void> | null = null
/** 本次进程使用的控制端口与 secret（运行中改设置不影响，重启后生效） */
let runtime = { port: 0, secret: '' }
const logLines: string[] = []
/** 当前生效的节点 id → 本地入站端口 */
let activePorts = new Map<number, number>()

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const errMessage = (err: unknown) => (err instanceof Error ? (err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message) : String(err))

function pushLog(line: string): void {
  if (!line) return
  logLines.push(line.length > 2000 ? `${line.slice(0, 2000)}…` : line)
  if (logLines.length > LOG_MAX) logLines.splice(0, logLines.length - LOG_MAX)
}

function pipeLines(stream: Readable | null): void {
  if (!stream) return
  let buf = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buf += chunk
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      pushLog(buf.slice(0, idx).trimEnd())
      buf = buf.slice(idx + 1)
    }
    if (buf.length > 8192) {
      pushLog(buf)
      buf = ''
    }
  })
}

export function localUrl(port: number): string {
  return `http://127.0.0.1:${port}`
}

// ── 控制器 API（直连回环，不走任何代理）──
async function request(port: number, secret: string, pathname: string, init: { method?: string; body?: string; timeoutMs?: number } = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: init.method ?? 'GET',
    body: init.body,
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(init.timeoutMs ?? 5000),
  })
}

function api(pathname: string, init?: { method?: string; body?: string; timeoutMs?: number }): Promise<Response> {
  return request(runtime.port, runtime.secret, pathname, init)
}

async function probeController(port: number, secret: string): Promise<'ours' | 'other' | 'none'> {
  try {
    const res = await request(port, secret, '/version', { timeoutMs: 1500 })
    await res.body?.cancel().catch(() => {})
    return res.ok ? 'ours' : 'other'
  } catch {
    return 'none'
  }
}

async function waitReady(timeoutMs: number, proc?: ChildProcess): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (proc && child !== proc) return false
    if (await probeController(runtime.port, runtime.secret) === 'ours') return true
    await sleep(200)
  }
  return false
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

// ── 状态 ──
export function coreStatus(): CoreStatus {
  const bin = corePath()
  const installed = fs.existsSync(bin)
  return {
    state: !installed && !child ? 'not_installed' : state,
    version: versionPath === bin ? version : null,
    path: bin,
    installed,
    pid: child?.pid ?? null,
    error: lastError,
    entry_error: entryError,
    listeners: activePorts.size,
    downloading,
  }
}

export function isRunning(): boolean {
  return state === 'running' && !!child
}

export function activePortOf(nodeId: number): number | undefined {
  return activePorts.get(nodeId)
}

/** 最近是否热重载过：重载瞬间 mihomo 会丢弃新连接，此时的网络错误不计入节点健康 */
export function reloadedWithin(ms: number): boolean {
  return Date.now() - lastReloadAt < ms
}

export function coreLogs(): string[] {
  return [...logLines]
}

export async function refreshVersion(): Promise<void> {
  const bin = corePath()
  if (!fs.existsSync(bin)) {
    version = null
    versionPath = null
    return
  }
  version = await new Promise<string | null>(resolve => {
    execFile(bin, ['-v'], { timeout: 10000, windowsHide: true }, (_err, stdout) => {
      const m = /v\d+\.\d+\.\d+[\w.-]*/.exec(String(stdout ?? ''))
      resolve(m ? m[0] : null)
    })
  })
  versionPath = bin
}

// ── 启停 ──
function baseConfig(): Record<string, unknown> {
  return {
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    mode: 'rule',
    'log-level': 'warning',
    ipv6: true,
    'find-process-mode': 'off',
    'external-controller': `127.0.0.1:${runtime.port}`,
    secret: runtime.secret,
    profile: { 'store-selected': false, 'store-fake-ip': false },
    proxies: [],
    rules: ['MATCH,REJECT'],
  }
}

function removePidFile(): void {
  try { fs.rmSync(PID_FILE, { force: true }) } catch { /* 忽略 */ }
}

/** 结束上次遗留的 mihomo（tsx watch 重启 / 强杀时 Windows 不会连带结束子进程） */
async function cleanupLeftover(): Promise<void> {
  let info: { pid?: number; port?: number; secret?: string } | null = null
  try { info = JSON.parse(fs.readFileSync(PID_FILE, 'utf8')) } catch { /* 没有遗留 */ }
  if (info?.pid && info.port && info.secret && await probeController(info.port, info.secret) === 'ours') {
    try { process.kill(info.pid) } catch { /* 已退出 */ }
    for (let i = 0; i < 25 && await probeController(info.port, info.secret) !== 'none'; i++) await sleep(200)
    pushLog(`[agghub] 已结束遗留的 mihomo 进程 ${info.pid}`)
  }
  removePidFile()
  if (!(await isPortFree(runtime.port))) throw new Error(`控制端口 ${runtime.port} 已被占用，请在代理池设置里换一个`)
}

function clearRestartTimer(): void {
  if (restartTimer) clearTimeout(restartTimer)
  restartTimer = null
}

function dropActivePorts(): void {
  for (const port of activePorts.values()) closeProxyAgent(localUrl(port))
  activePorts = new Map()
}

function onExit(proc: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
  if (child !== proc) return
  child = null
  dropActivePorts()
  removePidFile()
  pushLog(`[agghub] 内核已退出（code=${code ?? '-'} signal=${signal ?? '-'}）`)
  // 稳定运行过一分钟才重置退避
  if (startedAt && Date.now() - startedAt > 60_000) restartAttempt = 0
  startedAt = 0
  if (manualStop || !getPoolSettings().enabled) {
    state = 'stopped'
    return
  }
  state = 'error'
  lastError = lastError ?? `内核意外退出（code ${code ?? signal}）`
  const delay = RESTART_DELAYS[Math.min(restartAttempt, RESTART_DELAYS.length - 1)]
  restartAttempt++
  pushLog(`[agghub] ${delay} 秒后自动重启`)
  clearRestartTimer()
  restartTimer = setTimeout(() => {
    restartTimer = null
    if (getPoolSettings().enabled && !child) void start()
  }, delay * 1000)
  restartTimer.unref()
}

async function doStart(): Promise<void> {
  if (child) return
  clearRestartTimer()
  manualStop = false
  const bin = corePath()
  if (!fs.existsSync(bin)) {
    state = 'not_installed'
    lastError = null
    return
  }
  state = 'starting'
  lastError = null
  const s = getPoolSettings()
  runtime = { port: s.controller_port, secret: s.secret }
  fs.mkdirSync(CORE_HOME, { recursive: true })
  try {
    await cleanupLeftover()
  } catch (err) {
    state = 'error'
    lastError = errMessage(err)
    return
  }
  if (versionPath !== bin) void refreshVersion()
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(baseConfig(), null, 2))
  const proc = spawn(bin, ['-d', CORE_HOME, '-f', CONFIG_FILE], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child = proc
  pipeLines(proc.stdout)
  pipeLines(proc.stderr)
  proc.on('error', err => {
    pushLog(`[agghub] 进程错误: ${err.message}`)
    lastError = err.message
    // 启动失败（找不到文件 / 无权限）时可能不会触发 exit
    if (!proc.pid && child === proc) {
      child = null
      state = 'error'
    }
  })
  proc.on('exit', (code, signal) => onExit(proc, code, signal))
  if (proc.pid) fs.writeFileSync(PID_FILE, JSON.stringify({ pid: proc.pid, port: runtime.port, secret: runtime.secret }))
  const ready = await waitReady(10_000, proc)
  if (child !== proc || manualStop) return
  if (!ready) {
    lastError = '内核启动超时（10 秒内控制接口无响应），详见内核日志'
    proc.kill()
    return
  }
  state = 'running'
  startedAt = Date.now()
  pushLog(`[agghub] 内核已启动（pid ${proc.pid}）`)
  await reloadNow()
}

export function start(): Promise<void> {
  if (!startPromise) startPromise = doStart().finally(() => { startPromise = null })
  return startPromise
}

export async function stop(): Promise<void> {
  manualStop = true
  clearRestartTimer()
  const proc = child
  if (!proc) {
    state = 'stopped'
    return
  }
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 5000)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    proc.kill()
  })
  // 超时没退出时也视为已停止
  if (child === proc) onExit(proc, null, null)
}

export async function restart(): Promise<void> {
  await startPromise?.catch(() => {})
  await stop()
  await start()
}

/** 进程退出时同步结束子进程 */
export function killSync(): void {
  manualStop = true
  if (child) {
    try { child.kill() } catch { /* 忽略 */ }
    removePidFile()
  }
}

// ── 配置生成与热重载 ──
async function allocatePorts(ids: number[]): Promise<Map<number, number>> {
  const base = getPoolSettings().listen_base_port
  const next = new Map<number, number>()
  const used = new Set<number>([runtime.port])
  for (const id of ids) {
    const port = activePorts.get(id)
    if (port !== undefined && port >= base) {
      next.set(id, port)
      used.add(port)
    }
  }
  let cursor = base
  for (const id of ids) {
    if (next.has(id)) continue
    while (cursor <= 65535 && (used.has(cursor) || !(await isPortFree(cursor)))) cursor++
    if (cursor > 65535) break
    next.set(id, cursor)
    used.add(cursor)
    cursor++
  }
  return next
}

async function putConfig(config: Record<string, unknown>, proxyNames: string[]): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const res = await api('/configs?force=true', { method: 'PUT', body: JSON.stringify({ path: '', payload: JSON.stringify(config) }), timeoutMs: 60_000 })
    if (res.ok) {
      await res.body?.cancel().catch(() => {})
      return { ok: true }
    }
    const body = await res.json().catch(() => ({})) as { message?: string }
    return { ok: false, message: body.message || `HTTP ${res.status}` }
  } catch (err) {
    // 应用配置时控制器可能被重建导致响应中断：等它恢复后核对节点是否已生效
    if (await waitReady(5000)) {
      try {
        const res = await api('/proxies', { timeoutMs: 10_000 })
        const body = await res.json() as { proxies?: Record<string, unknown> }
        if (proxyNames.every(name => body.proxies && name in body.proxies)) return { ok: true }
      } catch { /* 按失败处理 */ }
    }
    return { ok: false, message: errMessage(err) }
  }
}

async function applyConfig(): Promise<void> {
  if (!isRunning()) return
  const s = getPoolSettings()
  let entry: Record<string, unknown> | null = null
  entryError = null
  if (s.entry_proxy) {
    const parsed = parseProxyUri(s.entry_proxy)
    if (parsed) entry = { ...parsed.config, name: ENTRY_NAME }
    else entryError = '入口代理无法解析'
  }
  let candidates = allNodes().filter(n => !n.invalid_reason).sort((a, b) => a.id - b.id)
  const ports = await allocatePorts(candidates.filter(n => !n.disabled).map(n => n.id))
  for (let round = 0; round < 50; round++) {
    if (!isRunning()) return
    const proxies: Record<string, unknown>[] = []
    const order: (number | null)[] = []
    if (entry) {
      proxies.push(entry)
      order.push(null)
    }
    for (const node of candidates) {
      const proxy: Record<string, unknown> = { ...node.config, name: `n${node.id}` }
      if (entry) proxy['dialer-proxy'] = ENTRY_NAME
      else delete proxy['dialer-proxy']
      proxies.push(proxy)
      order.push(node.id)
    }
    const listeners = candidates
      .filter(n => !n.disabled && ports.has(n.id))
      .map(n => ({ name: `l${n.id}`, type: 'mixed', listen: '127.0.0.1', port: ports.get(n.id)!, proxy: `n${n.id}`, udp: false }))
    const config = { ...baseConfig(), proxies, listeners }
    const result = await putConfig(config, proxies.map(p => String(p.name)))
    if (result.ok) {
      const next = new Map(listeners.map(l => [Number(l.name.slice(1)), l.port]))
      for (const [id, port] of activePorts) if (next.get(id) !== port) closeProxyAgent(localUrl(port))
      activePorts = next
      lastReloadAt = Date.now()
      lastError = null
      return
    }
    const m = /proxy (\d+):/.exec(result.message)
    const target = m ? order[Number(m[1])] : undefined
    if (target === undefined) {
      lastError = `应用配置失败：${result.message}`
      pushLog(`[agghub] ${lastError}`)
      return
    }
    if (target === null) {
      entryError = `入口代理配置无效：${result.message}`
      pushLog(`[agghub] ${entryError}`)
      entry = null
      continue
    }
    pushLog(`[agghub] 节点 #${target} 配置无效，已剔除：${result.message}`)
    setInvalid(target, result.message)
    candidates = candidates.filter(n => n.id !== target)
  }
  lastError = '无效节点过多，本次只剔除了前 50 个，请重新应用'
}

let applyChain: Promise<void> = Promise.resolve()
let reloadTimer: NodeJS.Timeout | null = null

/** 立即热重载（串行执行） */
export function reloadNow(): Promise<void> {
  applyChain = applyChain.then(applyConfig).catch(err => {
    lastError = `应用配置失败：${errMessage(err)}`
    pushLog(`[agghub] ${lastError}`)
  })
  return applyChain
}

/** 300ms 防抖后热重载 */
export function scheduleReload(): void {
  if (reloadTimer) clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => {
    reloadTimer = null
    void reloadNow()
  }, 300)
}

// ── 测速 ──
export async function delay(name: string, url: string, timeoutMs: number): Promise<DelayResult> {
  if (!isRunning()) return { ok: false, error: '内核未运行' }
  try {
    const res = await api(`/proxies/${encodeURIComponent(name)}/delay?url=${encodeURIComponent(url)}&timeout=${timeoutMs}`, { timeoutMs: timeoutMs + 3000 })
    const body = await res.json().catch(() => ({})) as { delay?: number; message?: string }
    if (res.ok && typeof body.delay === 'number' && body.delay > 0) return { ok: true, delay: body.delay }
    return { ok: false, error: body.message || `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, error: errMessage(err) }
  }
}

// ── 下载内核 ──
interface ReleaseAsset { name: string; browser_download_url: string }

/** 最小 zip 读取：取出第一个 .exe */
function extractExeFromZip(buf: Buffer): Buffer {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('下载的 zip 格式无效')
  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('下载的 zip 目录损坏')
    const method = buf.readUInt16LE(offset + 10)
    const compSize = buf.readUInt32LE(offset + 20)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen)
    offset += 46 + nameLen + extraLen + commentLen
    if (!name.toLowerCase().endsWith('.exe')) continue
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28)
    const data = buf.subarray(start, start + compSize)
    if (method === 0) return Buffer.from(data)
    if (method === 8) return zlib.inflateRawSync(data)
    throw new Error(`zip 压缩方式 ${method} 不支持`)
  }
  throw new Error('压缩包里没有找到 mihomo.exe')
}

/** 从 GitHub releases 下载最新内核到 data/mihomo/，返回版本号 */
export async function downloadCore(): Promise<string> {
  if (downloading) throw new Error('内核正在下载中')
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : null
  const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : null
  if (!os || !arch) throw new Error(`不支持的平台：${process.platform}-${process.arch}`)
  downloading = true
  try {
    const proxy = getPoolSettings().download_proxy || getSettings().proxy_url
    const base: Record<string, unknown> = { headers: { 'User-Agent': 'agghub', Accept: 'application/vnd.github+json' } }
    if (proxy) base.dispatcher = getProxyAgent(proxy)
    const relRes = await fetch('https://api.github.com/repos/MetaCubeX/mihomo/releases/latest', { ...base, signal: AbortSignal.timeout(30_000) } as RequestInit)
    if (!relRes.ok) throw new Error(`查询 GitHub 版本失败：HTTP ${relRes.status}`)
    const rel = await relRes.json() as { tag_name: string; assets: ReleaseAsset[] }
    const ext = os === 'windows' ? 'zip' : 'gz'
    const tag = rel.tag_name
    const names = arch === 'amd64'
      ? [`mihomo-${os}-amd64-compatible-${tag}.${ext}`, `mihomo-${os}-amd64-v1-${tag}.${ext}`, `mihomo-${os}-amd64-${tag}.${ext}`]
      : [`mihomo-${os}-arm64-${tag}.${ext}`]
    const asset = names.map(n => rel.assets.find(a => a.name === n)).find(Boolean)
    if (!asset) throw new Error(`最新版本 ${tag} 里没有找到 ${names[0]}`)
    pushLog(`[agghub] 开始下载 ${asset.name}`)
    const res = await fetch(asset.browser_download_url, { ...base, signal: AbortSignal.timeout(300_000) } as RequestInit)
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)
    const archive = Buffer.from(await res.arrayBuffer())
    const binary = ext === 'zip' ? extractExeFromZip(archive) : zlib.gunzipSync(archive)
    fs.mkdirSync(CORE_HOME, { recursive: true })
    const tmp = `${DEFAULT_BIN}.download`
    fs.writeFileSync(tmp, binary, { mode: 0o755 })
    // Windows 下运行中的 exe 无法覆盖，先停再换
    const replacingRunning = !!child && corePath() === DEFAULT_BIN
    if (replacingRunning) await stop()
    fs.renameSync(tmp, DEFAULT_BIN)
    if (os === 'linux') fs.chmodSync(DEFAULT_BIN, 0o755)
    versionPath = null
    await refreshVersion()
    pushLog(`[agghub] 内核已更新到 ${tag}`)
    if (getPoolSettings().enabled && !child) await start()
    return version ?? tag
  } catch (err) {
    pushLog(`[agghub] 下载内核失败：${errMessage(err)}`)
    throw err
  } finally {
    downloading = false
  }
}
