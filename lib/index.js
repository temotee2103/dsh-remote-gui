/**
 * dsh-remote-gui — Node half.
 *
 * 用 SSH 隧道把远端 DSH 的 GUI 嵌进本地 DSH 界面，并把远端会话列进侧栏。
 * 独立实现，**不依赖 dsh-sev**：dsh-sev 0.3.4 是按 DSH 0.1.x 写的，在
 * 0.2.0-rc.2 上远程会话列表与内嵌 GUI 都不可用（服务端请求缺浏览器凭据 → 401，
 * RPC 信封过时 → 404/400，output.render 契约变了）。
 *
 * 本文件负责：
 *  - 主机注册表（$DSH_HOME/remote-gui-hosts.json）
 *  - SSH 隧道生命周期（spawn `ssh -L`，看门狗自动重连，重启后收养已有隧道）
 *  - /api/dsh-remote-gui 路由族（只允许 loopback）
 *  - 远端凭据 cookie 的获取与缓存（0.2.x 要求每个 /api 请求都带）
 *  - agent 工具 remote_gui_run_task
 *
 * 远端契约（实测于 DSH 0.2.0-rc.2）：
 *   兑换凭据  GET http://127.0.0.1:<隧道端口>/?token=<远端启动 token>
 *             → 303 + Set-Cookie: dsh-auth-<authority哈希>=<签名值>
 *   RPC       POST http://127.0.0.1:<隧道端口>/api/<ns>/<method>
 *             body {"type":"client-request","rpcId","method":"<ns>/<method>",
 *                   "payload":{"args":{"_request":{…}}}}
 *             数据在 result.value；method 必须与 endpoint 一致（斜杠形式）
 */
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

const PLUGIN_ID = 'dsh-remote-gui'
const BASE = '/api/dsh-remote-gui'

const API = {
  hosts: `${BASE}/hosts`,
  host: `${BASE}/host`,
  tunnel: `${BASE}/tunnel`,
  health: `${BASE}/health`,
  sessions: `${BASE}/sessions`,
  archive: `${BASE}/session-archive`,
  seed: `${BASE}/seed`,
}

const DEFAULT_REMOTE_PORT = 3080
const DEFAULT_LOCAL_PORT = 5640
const SWEEP_INTERVAL_MS = 15000
const HEADLESS_HOME_DEFAULT = '~/.dsh-headless'
const HEADLESS_TIMEOUT_MS = 300 * 1000

// ── 小工具 ─────────────────────────────────────────────────────────────────
function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 64 * 1024) req.destroy() })
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve(null) } })
    req.on('error', () => resolve(null))
  })
}

function queryParam(url, name) {
  try { return new URL(url, 'http://dsh.internal').searchParams.get(name) ?? undefined } catch { return undefined }
}

/** 只允许 loopback 访问（本机 GUI 自己的 origin）。 */
function isLoopbackRequest(req) {
  const addr = req.socket?.remoteAddress ?? req.connection?.remoteAddress
  if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') return false
  const host = String(req.headers?.host ?? '')
  const name = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '::1'
}

// ── 主机注册表 ─────────────────────────────────────────────────────────────
class Registry {
  constructor(file) {
    this.file = file
    this.hosts = []
    this.load()
  }

  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      this.hosts = Array.isArray(parsed?.hosts) ? parsed.hosts : []
    } catch { this.hosts = [] }
  }

  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify({ hosts: this.hosts }, null, 2), 'utf8')
    } catch { /* 注册表写不进去不该拖垮插件 */ }
  }

  find(id) {
    if (!id) return undefined
    return this.hosts.find((h) => h.id === id) ?? this.hosts.find((h) => h.alias === id)
  }

  upsert(host) {
    const at = this.hosts.findIndex((h) => h.id === host.id)
    if (at >= 0) this.hosts[at] = { ...this.hosts[at], ...host }
    else this.hosts.push(host)
    this.save()
    return this.find(host.id)
  }

  remove(id) {
    const before = this.hosts.length
    this.hosts = this.hosts.filter((h) => h.id !== id)
    this.save()
    return this.hosts.length !== before
  }
}

// ── SSH 隧道 ───────────────────────────────────────────────────────────────
const tunnels = new Map() // id -> { proc, localPort, remotePort, alias, state, exitCode, startedAt }
const desired = new Map() // id -> boolean（期望隧道是开着的）

function probePort(localPort, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const sock = connect({ port: localPort, host: '127.0.0.1' })
    let done = false
    const finish = (v) => { if (!done) { done = true; try { sock.destroy() } catch { /* noop */ } resolve(v) } }
    sock.setTimeout(timeoutMs)
    sock.on('connect', () => finish(true))
    sock.on('timeout', () => finish(false))
    sock.on('error', () => finish(false))
  })
}

function sshArgs(host, localPort) {
  const remotePort = Number(host.port) || DEFAULT_REMOTE_PORT
  return [
    '-N',
    '-L', `${localPort}:127.0.0.1:${remotePort}`,
    host.alias,
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=10',
  ]
}

async function startTunnel(host, localPort) {
  const existing = tunnels.get(host.id)
  if (existing && (existing.state === 'running' || existing.state === 'starting')) return existing

  const port = Number(localPort) || host.localPort || DEFAULT_LOCAL_PORT
  const remotePort = Number(host.port) || DEFAULT_REMOTE_PORT

  // 本机重启后收养还在监听的同端口隧道（不重复 spawn）
  if (await probePort(port)) {
    const adopted = { proc: null, localPort: port, remotePort, alias: host.alias, state: 'running', exitCode: null, startedAt: Date.now() }
    tunnels.set(host.id, adopted)
    return adopted
  }

  const record = { proc: null, localPort: port, remotePort, alias: host.alias, state: 'starting', exitCode: null, startedAt: Date.now() }
  tunnels.set(host.id, record)
  try {
    const proc = spawn('ssh', sshArgs(host, port), { stdio: ['ignore', 'ignore', 'pipe'] })
    record.proc = proc
    proc.on('exit', (code) => {
      record.exitCode = code ?? 0
      record.state = 'stopped'
      record.proc = null
    })
    proc.on('error', () => { record.state = 'stopped'; record.proc = null })
  } catch {
    record.state = 'stopped'
  }

  // 端口通了才算 running
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500))
    if (record.state === 'stopped') break
    if (await probePort(port)) { record.state = 'running'; break }
  }
  return record
}

function stopTunnel(id) {
  const record = tunnels.get(id)
  if (!record) return
  try { record.proc?.kill('SIGTERM') } catch { /* noop */ }
  record.state = 'stopped'
  tunnels.delete(id)
}

function tunnelStatus(id) {
  const t = tunnels.get(id)
  if (!t) return undefined
  return { localPort: t.localPort, remotePort: t.remotePort, alias: t.alias, state: t.state, exitCode: t.exitCode ?? null }
}

/** 看门狗：把掉线的 autoTunnel 主机重新拉起来。 */
async function sweepOnce(registry) {
  for (const host of registry.hosts) {
    if (host.autoTunnel === false) continue
    if (desired.get(host.id) === false) continue
    const t = tunnels.get(host.id)
    const alive = t && t.state === 'running' && (await probePort(t.localPort))
    if (!alive) {
      if (t) stopTunnel(host.id)
      await startTunnel(host, host.localPort)
    }
  }
}

// ── 远端凭据（0.2.x 必需）─────────────────────────────────────────────────
const remoteCookies = new Map() // host.id -> cookie header
const remoteTokens = new Map() // host.id -> { token, at } 远端启动 token（带时间戳）

/** 远端启动 token 的缓存寿命：超过就重读一次（远端重启会换 token）。 */
const TOKEN_TTL_MS = 5 * 60 * 1000

/** ssh 读远端 `dsh web` 打印的启动 token。maxAgeMs>0 时命中新鲜缓存就不走 ssh。 */
function remoteLaunchToken(host, maxAgeMs = 0) {
  const cached = remoteTokens.get(host.id)
  if (cached && maxAgeMs > 0 && Date.now() - cached.at < maxAgeMs) return Promise.resolve(cached.token)
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const finish = (v) => { if (!settled) { settled = true; resolve(v) } }
    let proc
    try {
      proc = spawn('ssh', [
        '-o', 'BatchMode=yes', '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=10', host.alias,
        "journalctl --user -u dsh-web -n 400 --no-pager 2>/dev/null | grep -oE 'token=[A-Za-z0-9_-]+' | tail -1 | cut -d= -f2",
      ])
    } catch { return finish('') }
    const timer = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* noop */ } finish('') }, 8000)
    proc.stdout.on('data', (d) => { out += String(d) })
    proc.on('error', () => { clearTimeout(timer); finish('') })
    proc.on('close', () => {
      clearTimeout(timer)
      const token = out.trim()
      if (token) remoteTokens.set(host.id, { token, at: Date.now() })
      finish(token)
    })
  })
}

/** 取（并缓存）远端浏览器凭据 cookie：token → 经隧道兑换。 */
function remoteCookieHeader(host, tunnel, force = false) {
  if (!force && remoteCookies.has(host.id)) return Promise.resolve(remoteCookies.get(host.id))
  return (async () => {
    const token = await remoteLaunchToken(host)
    if (!token) return ''
    try {
      const r = await fetch(`http://127.0.0.1:${tunnel.localPort}/?token=${encodeURIComponent(token)}`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
      })
      const raw = typeof r.headers.getSetCookie === 'function'
        ? r.headers.getSetCookie()
        : [r.headers.get('set-cookie')].filter(Boolean)
      const jar = raw.map((c) => String(c).split(';')[0]).join('; ')
      if (jar) remoteCookies.set(host.id, jar)
      return jar
    } catch { return '' }
  })()
}

/** 带正确信封调一次远端 RPC；401/403 时刷新凭据重试一次。 */
async function remoteRpc(host, tunnel, endpoint, request = {}, retry = true) {
  const cookie = await remoteCookieHeader(host, tunnel)
  const headers = { 'content-type': 'application/json' }
  if (cookie) headers.cookie = cookie
  const r = await fetch(`http://127.0.0.1:${tunnel.localPort}/api/${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `rg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      method: endpoint,
      payload: { args: { _request: request } },
    }),
    signal: AbortSignal.timeout(20000),
  })
  if (retry && (r.status === 401 || r.status === 403)) {
    // 凭据过期大多是因为远端重启过（token 换了）—— 两个缓存一起清掉再试一次
    remoteCookies.delete(host.id)
    remoteTokens.delete(host.id)
    return remoteRpc(host, tunnel, endpoint, request, false)
  }
  return r
}

/** 带凭据取远端页面（代理路由用）。 */
async function remoteFetchWithCredential(host, tunnel, path, init = {}) {
  const cookie = await remoteCookieHeader(host, tunnel)
  const headers = { ...(init.headers ?? {}) }
  if (cookie) headers.cookie = cookie
  return fetch(`http://127.0.0.1:${tunnel.localPort}${path}`, { ...init, headers })
}

// ── 路由 ───────────────────────────────────────────────────────────────────
function makeRoutes({ registry, allocatePort }) {
  const withFence = (handler) => (req, res) => {
    if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'loopback only' })
    return handler(req, res)
  }

  const runningTunnel = (host) => {
    const t = tunnels.get(host.id)
    return t && t.state === 'running' ? t : undefined
  }

  const withSeed = async (host, tunnel) => {
    // 用带 TTL 的缓存（默认 5 分钟）：既不会每 12 秒轮询都去 ssh，又能在远端重启换了
    // token 之后自动拿到新的 —— 否则 iframe 的"种 cookie"那一次会 401，面板里就只剩
    // 远端 401 页面。
    const token = await remoteLaunchToken(host, TOKEN_TTL_MS)
    return token ? `http://127.0.0.1:${tunnel.localPort}/?token=${encodeURIComponent(token)}` : undefined
  }

  return [
    {
      path: API.hosts,
      handler: withFence(async (req, res) => {
        if (req.method === 'GET') {
          const hosts = await Promise.all(registry.hosts.map(async (h) => {
            const tunnel = tunnelStatus(h.id)
            let seedUrl
            if (tunnel && tunnel.state === 'running') seedUrl = await withSeed(h, tunnel)
            return { ...h, tunnel, seedUrl }
          }))
          return writeJson(res, 200, { hosts })
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req)
          if (!body || typeof body.alias !== 'string' || !body.alias.trim()) {
            return writeJson(res, 400, { error: 'alias required' })
          }
          const alias = body.alias.trim()
          const host = {
            id: String(body.id ?? alias).trim(),
            alias,
            name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : alias,
            port: Number(body.port) || DEFAULT_REMOTE_PORT,
            localPort: Number(body.localPort) || allocatePort(registry.hosts.length),
            autoTunnel: body.autoTunnel !== false,
          }
          registry.upsert(host)
          if (host.autoTunnel) {
            desired.set(host.id, true)
            void startTunnel(host, host.localPort)
          }
          return writeJson(res, 200, { host: { ...registry.find(host.id), tunnel: tunnelStatus(host.id) } })
        }
        return writeJson(res, 405, { error: 'method not allowed' })
      }),
    },
    {
      path: API.host,
      handler: withFence(async (req, res) => {
        const id = queryParam(req.url, 'id')
        const host = registry.find(id)
        if (!host) return writeJson(res, 404, { error: 'host not found' })
        if (req.method === 'DELETE') {
          stopTunnel(host.id)
          desired.set(host.id, false)
          remoteCookies.delete(host.id)
          remoteTokens.delete(host.id)
          registry.remove(host.id)
          return writeJson(res, 200, { ok: true })
        }
        return writeJson(res, 405, { error: 'method not allowed' })
      }),
    },
    {
      path: API.tunnel,
      handler: withFence(async (req, res) => {
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req)
        const host = registry.find(body?.id)
        if (!host) return writeJson(res, 404, { error: 'host not found' })
        if (body.action === 'stop') {
          desired.set(host.id, false)
          stopTunnel(host.id)
          return writeJson(res, 200, { ok: true, tunnel: tunnelStatus(host.id) ?? null })
        }
        desired.set(host.id, true)
        const tunnel = await startTunnel(host, host.localPort)
        return writeJson(res, 200, { tunnel: tunnelStatus(host.id) })
      }),
    },
    {
      path: API.health,
      handler: withFence(async (req, res) => {
        const host = registry.find(queryParam(req.url, 'id'))
        if (!host) return writeJson(res, 404, { error: 'host not found' })
        const tunnel = tunnelStatus(host.id)
        let hostUp = false
        let status = null
        if (tunnel && tunnel.state === 'running') {
          try {
            const cookie = await remoteCookieHeader(host, tunnel)
            const r = await fetch(`http://127.0.0.1:${tunnel.localPort}/`, {
              headers: cookie ? { cookie } : {},
              signal: AbortSignal.timeout(5000),
            })
            status = r.status
            hostUp = r.status < 500
          } catch { status = 'unreachable' }
        }
        return writeJson(res, 200, { id: host.id, tunnel, hostUp, status })
      }),
    },
    {
      path: API.sessions,
      handler: withFence(async (req, res) => {
        const host = registry.find(queryParam(req.url, 'id'))
        if (!host) return writeJson(res, 404, { error: 'host not found' })
        const tunnel = runningTunnel(host)
        if (!tunnel) return writeJson(res, 409, { error: 'tunnel not running' })
        try {
          const r = await remoteRpc(host, tunnel, 'session/list', {})
          const data = await r.json()
          if (data?.result?.ok !== true) {
            return writeJson(res, 502, { error: data?.result?.error ?? 'remote rpc failed' })
          }
          const sessions = (data.result.value?.items ?? []).map((s) => ({
            sessionId: s.sessionId,
            title: s.projections?.values?.title ?? null,
            running: !!s.running,
            blank: !!s.blank,
            updatedAt: s.updatedAt,
            cwd: s.cwd ?? null,
            turns: s.projections?.values?.sessionStats?.turns ?? null,
          }))
          return writeJson(res, 200, { sessions })
        } catch (error) {
          return writeJson(res, 502, { error: String(error) })
        }
      }),
    },
    {
      path: API.archive,
      handler: withFence(async (req, res) => {
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req)
        const host = registry.find(body?.id)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        if (!host) return writeJson(res, 404, { error: 'host not found' })
        if (!sessionId) return writeJson(res, 400, { error: 'sessionId required' })
        const tunnel = runningTunnel(host)
        if (!tunnel) return writeJson(res, 409, { error: 'tunnel not running' })
        try {
          const r = await remoteRpc(host, tunnel, 'workspace/archiveSession', { sessionId })
          const data = await r.json()
          if (data?.result?.ok !== true) return writeJson(res, 502, { error: data?.result?.error ?? 'archive failed' })
          const archivedSessionIds = data.result.value?.archivedSessionIds ?? []
          return writeJson(res, 200, { ok: true, archivedSessionIds })
        } catch (error) {
          return writeJson(res, 502, { error: String(error) })
        }
      }),
    },
    {
      path: API.seed,
      handler: withFence(async (req, res) => {
        const host = registry.find(queryParam(req.url, 'id'))
        if (!host) return writeJson(res, 404, { error: 'host not found' })
        const tunnel = runningTunnel(host)
        if (!tunnel) return writeJson(res, 409, { error: 'tunnel not running' })
        const url = await withSeed(host, tunnel)
        if (!url) return writeJson(res, 502, { error: 'could not read remote launch token' })
        return writeJson(res, 200, { url })
      }),
    },
    {
      // 透传远端路径（诊断用；iframe 本身直连隧道，不经过这里）
      path: `${BASE}/proxy`,
      handler: withFence(async (req, res) => {
        const url = new URL(req.url, 'http://dsh.internal')
        const host = registry.find(queryParam(url, 'id'))
        if (!host) return writeJson(res, 404, { error: 'host not found' })
        const tunnel = runningTunnel(host)
        if (!tunnel) return writeJson(res, 409, { error: 'tunnel not running' })
        const remotePath = queryParam(url, 'path') ?? '/'
        try {
          const r = await remoteFetchWithCredential(host, tunnel, remotePath, {
            headers: remotePath.startsWith('/api') ? { accept: 'application/json' } : {},
            signal: AbortSignal.timeout(10000),
          })
          const text = await r.text()
          res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json; charset=utf-8' })
          res.end(text)
        } catch (error) {
          return writeJson(res, 502, { error: String(error) })
        }
      }),
    },
  ]
}

// ── agent 工具：在远端跑一次性任务 ────────────────────────────────────────
function runRemoteHeadless(alias, task, headlessHome, cwd) {
  return new Promise((resolve) => {
    const cd = cwd ? `cd "${cwd}" && ` : ''
    const remote = `${cd}cat > /tmp/.dsh-remote-gui-task.txt && env DSH_HOME=${headlessHome} dsh --profile headless "$(cat /tmp/.dsh-remote-gui-task.txt)"`
    const proc = spawn('ssh', [alias, remote], { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    let stderr = ''
    const timer = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* noop */ } }, HEADLESS_TIMEOUT_MS)
    proc.stdout.on('data', (d) => { output += String(d) })
    proc.stderr.on('data', (d) => { stderr += String(d) })
    proc.on('error', (e) => { clearTimeout(timer); resolve({ output: `ssh error: ${e.message}`, exitCode: 1 }) })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      const combined = (output + (stderr ? `\n[stderr] ${stderr.trim()}` : '')).trim()
      resolve({ output: combined, exitCode: code ?? 1 })
    })
    proc.stdin.write(task)
    proc.stdin.end()
  })
}

function remoteRunTaskTool(registry) {
  return defineTool({
    name: 'remote_gui_run_task',
    description: 'Run a one-shot task on a registered remote DSH host through its headless CLI (ssh + `dsh --profile headless`). The remote agent executes tools on that server and replies once. Use when the user wants a task executed on a remote server / the remote DSH instance. Long monitored tasks should use a persistent remote session instead.',
    parameters: {
      host: { type: 'string', description: 'Remote host id or SSH alias registered in dsh-remote-gui (e.g. my-server).' },
      task: { type: 'string', description: 'The task text for the remote agent to perform, e.g. "run uname -a and summarize".' },
      cwd: { type: 'string', description: 'Optional working directory on the server (a "remote project" folder).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          output: { type: 'string', required: true },
          exitCode: { type: 'integer', required: true },
        },
      },
      // 0.2.x：render 必须返回 ContentBlock 数组（返回字符串会让 harness 报
      // "content.some is not a function"）。
      render: (_args, value) => [{ type: 'text', text: `exit ${value.exitCode}\n${value.output}` }],
    },
    execute: async (args) => {
      const host = registry.find(args.host)
      if (!host) return { output: `host not found: ${args.host} (register it in the Remote GUI panel first)`, exitCode: 1 }
      return runRemoteHeadless(host.alias, args.task, host.headlessHome ?? HEADLESS_HOME_DEFAULT, args.cwd)
    },
  })
}

// ── 插件入口 ───────────────────────────────────────────────────────────────
function apply(ctx) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const registry = new Registry(join(dshHome, 'remote-gui-hosts.json'))
  let nextLocalPort = DEFAULT_LOCAL_PORT
  const allocatePort = () => { nextLocalPort += 1; return nextLocalPort }

  const routes = makeRoutes({ registry, allocatePort })

  // 启动时给 autoTunnel 主机拉起隧道（已有隧道会被收养）
  ctx.effect(() => {
    for (const h of registry.hosts) {
      if (h.autoTunnel === false) continue
      desired.set(h.id, true)
      void startTunnel(h, h.localPort)
    }
  }, `${PLUGIN_ID}: resume tunnels`)

  const sweeper = setInterval(() => { void sweepOnce(registry) }, SWEEP_INTERVAL_MS)
  ctx.effect(() => () => clearInterval(sweeper), `${PLUGIN_ID}: tunnel sweeper`)

  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) { try { dispose() } catch { /* noop */ } }
      for (const id of [...tunnels.keys()]) stopTunnel(id)
    }
  }, `${PLUGIN_ID}: routes`)

  ctx.effect(() => {
    try {
      return ctx.systemPrompt.section({
        name: `plugin:${PLUGIN_ID}`,
        order: 165,
        text: [
          '本机已安装 dsh-remote-gui 插件：侧栏「远程」入口，用 SSH 隧道把远端 DSH 的 GUI 嵌进本地界面，并列出远端会话。',
          '主机注册表在 $DSH_HOME/remote-gui-hosts.json；隧道 = ssh -L <本地端口>:127.0.0.1:<远端端口> <SSH 别名>。',
          '远端请求需要浏览器凭据 cookie（由远端 dsh web 的启动 token 经隧道兑换），插件已自动处理。',
          'agent 工具 remote_gui_run_task 可经 ssh + `dsh --profile headless` 在远端跑一次性任务。',
        ].join('\n'),
      })
    } catch { return undefined }
  }, `${PLUGIN_ID}: guidance`)

  ctx.effect(() => {
    const disposers = [ctx.tools.register(remoteRunTaskTool(registry))]
    return () => { for (const d of disposers) { try { d() } catch { /* noop */ } } }
  }, `${PLUGIN_ID}: tools`)
}

const inject = ['webServer', 'systemPrompt', 'tools']

export { apply, inject, API, Registry, makeRoutes, startTunnel, stopTunnel, tunnelStatus, sweepOnce, remoteRunTaskTool, DEFAULT_LOCAL_PORT, DEFAULT_REMOTE_PORT }
