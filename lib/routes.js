/**
 * dsh-remote-gui — the `/api/dsh-remote-gui` route family.
 *
 * Every route is loopback-only (the local DSH GUI's own origin) and answers JSON:
 *   GET    /hosts            → { hosts: [Host] }      (Host carries tunnel + seedUrl)
 *   POST   /hosts            ← { alias, name?, port?, localPort?, autoTunnel? }
 *   DELETE /host?<id>        → { ok: true }
 *   POST   /tunnel           ← { id, action: 'start'|'stop' }
 *   GET    /health?<id>      → { id, tunnel, hostUp, status }
 *   GET    /sessions?<id>    → { sessions: [Session] }
 *   POST   /session-archive  ← { id, sessionId }
 *   GET    /session-page?<id>&sessionId=&throughSeq=&maxMessages=&beforeSeq=
 *                            → { records, hasMore }   (远端 session/page：读会话正文)
 *   GET    /session-projection?<id>&sessionId=  → { projection }  (远端 session/projections)
 *   POST   /session-prompt   ← { id, sessionId, text, mode? }  → { ok, value }  ⚠️ 会真的花钱
 *   POST   /session-create   ← { id, cwd? }                    → { ok, sessionId }
 *   GET    /seed?<id>        → { url }                (index URL；原生视图不再用它嵌 iframe)
 *   GET    /proxy?<id>&path= → passthrough of a remote path (diagnostics)
 *
 * 远端 RPC 的 `payload.args` key 由 `remote.js` 的 ARGS_KEY_BY_METHOD 决定
 * （= 宿主方法形参名；`session/list` 是 `_request`，其余是 `request`）。
 *
 * `makeRoutes({ registry, allocatePort })` is the normal call. Tests may also inject
 * `tunnels` (a fake tunnel map) and `resolveToken` (a fake launch-token source), which
 * is what lets the suite drive these routes with no ssh and no network.
 */
import {
  DEFAULT_REMOTE_PORT,
  desired,
  startTunnel,
  stopTunnel,
  tunnelStatus,
  tunnels as defaultTunnels,
} from './tunnel.js'
import {
  TOKEN_TTL_MS,
  forgetCredentials,
  remoteCookieHeader,
  remoteFetchWithCredential,
  remoteLaunchToken,
  remoteRpc,
} from './remote.js'

const BASE = '/api/dsh-remote-gui'

const API = {
  hosts: `${BASE}/hosts`,
  host: `${BASE}/host`,
  tunnel: `${BASE}/tunnel`,
  health: `${BASE}/health`,
  sessions: `${BASE}/sessions`,
  archive: `${BASE}/session-archive`,
  page: `${BASE}/session-page`,
  projection: `${BASE}/session-projection`,
  prompt: `${BASE}/session-prompt`,
  create: `${BASE}/session-create`,
  seed: `${BASE}/seed`,
}

// ── HTTP helpers（仅本路由族使用）──────────────────────────────────────────
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

// ── 路由 ───────────────────────────────────────────────────────────────────
/**
 * 组装路由族。
 *
 * @param {object} deps
 * @param {Registry} deps.registry                     主机注册表
 * @param {(index:number)=>number} deps.allocatePort   端口分配
 * @param {Map} [deps.tunnels]        隧道表；默认是模块内那张真表。测试可注入一张假表，
 *                                    于是不需要真起 ssh 就能驱动 sessions/health/hosts 等路由。
 * @param {Function} [deps.resolveToken] 远端启动 token 的来源；默认 ssh 读 journal。
 *                                    测试可注入，从而完全不碰网络/ssh。
 *
 * 默认行为与以前完全一致：`makeRoutes({ registry, allocatePort })` 照常可用。
 */
function makeRoutes({ registry, allocatePort, tunnels: tunnelMap = defaultTunnels, resolveToken = remoteLaunchToken }) {
  const withFence = (handler) => (req, res) => {
    if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'loopback only' })
    return handler(req, res)
  }

  // 本路由族统一从注入的隧道表取状态。
  // 刻意不叫 `status`：health 路由里有个局部 `let status`，同名会被 TDZ 遮蔽。
  const tunnelOf = (id) => tunnelStatus(id, tunnelMap)

  const runningTunnel = (host) => {
    const t = tunnelMap.get(host.id)
    return t && t.state === 'running' ? t : undefined
  }

  const withSeed = async (host, tunnel) => {
    // 用带 TTL 的缓存（默认 5 分钟）：既不会每 12 秒轮询都去 ssh，又能在远端重启换了
    // token 之后自动拿到新的 —— 否则 iframe 的"种 cookie"那一次会 401，面板里就只剩
    // 远端 401 页面。
    const token = await resolveToken(host, TOKEN_TTL_MS)
    return token ? `http://127.0.0.1:${tunnel.localPort}/?token=${encodeURIComponent(token)}` : undefined
  }

  return [
    {
      path: API.hosts,
      handler: withFence(async (req, res) => {
        if (req.method === 'GET') {
          const hosts = await Promise.all(registry.hosts.map(async (h) => {
            const tunnel = tunnelOf(h.id)
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
          return writeJson(res, 200, { host: { ...registry.find(host.id), tunnel: tunnelOf(host.id) } })
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
          forgetCredentials(host.id)
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
          return writeJson(res, 200, { ok: true, tunnel: tunnelOf(host.id) ?? null })
        }
        desired.set(host.id, true)
        const tunnel = await startTunnel(host, host.localPort)
        return writeJson(res, 200, { tunnel: tunnelOf(host.id) })
      }),
    },
    {
      path: API.health,
      handler: withFence(async (req, res) => {
        const host = registry.find(queryParam(req.url, 'id'))
        if (!host) return writeJson(res, 404, { error: 'host not found' })
        const tunnel = tunnelOf(host.id)
        let hostUp = false
        let status = null
        if (tunnel && tunnel.state === 'running') {
          try {
            const cookie = await remoteCookieHeader(host, tunnel, false, resolveToken)
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
          // 信封 key 跟着方法走：session/list 的宿主形参名是 `_request`
          // （全量核对见 lib/remote.js 头部的 ARGS_KEY_BY_METHOD 说明）。
          const r = await remoteRpc(host, tunnel, 'session/list', {}, { resolveToken })
          const data = await r.json()
          if (data?.result?.ok !== true) {
            return writeJson(res, 502, { error: data?.result?.error ?? 'remote rpc failed' })
          }
          // ⚠️ `parentSessionId` / `origin` 必须**原样带出去**：它们是「主会话 vs 子代理/子任务会话」
          //    的权威判据（见 lib/types/list.js 的 listFields + typert.host.js 的 SessionSummary）。
          //    2026-10-14 之前这里只挑了 title/cwd/running/blank/updatedAt/turns，
          //    判据字段被丢掉 ⇒ 客户端只能靠猜（用户看到的就是"左栏混着几百条子会话"）。
          const sessions = (data.result.value?.items ?? []).map((s) => ({
            sessionId: s.sessionId,
            title: s.projections?.values?.title ?? null,
            running: !!s.running,
            blank: !!s.blank,
            updatedAt: s.updatedAt,
            cwd: s.cwd ?? null,
            turns: s.projections?.values?.sessionStats?.turns ?? null,
            // 宿主清单里的**权威**子会话标记：两者同时出现（实测 346 条里 317 条如此），
            // 缺省（undefined）表示这是根会话。
            parentSessionId: s.parentSessionId ?? null,
            origin: s.origin ?? null,
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
          // ⚠️ 这里以前写死信封 key = `_request`，但 workspace/archiveSession 的宿主形参名是
          // `request`（typert 描述符：dsh-api-workspace-controller/lib/typert.host.js 里
          // parameters[0] = { name: 'request', wire: 'request' }）。
          // 用错 key 时远端回 result.ok=false / gateway/arguments-invalid
          // （`missing "request"; unexpected "_request"`），归档**永不生效** —— 界面只表现为"点了没反应"。
          // 现在显式传 argsKey，不再依赖任何默认值。
          const r = await remoteRpc(host, tunnel, 'workspace/archiveSession', { sessionId }, { resolveToken, argsKey: 'request' })
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
      // 读一条远端会话的正文：远端 session/page（一元 HTTP，不需要 WebSocket）。
      //   request = { address:{kind:'session',sessionId}, throughSeq, maxMessages, beforeSeq? }
      //   ⚠️ throughSeq 不能超过该会话的 cursor（当前 asOfSeq），否则远端回
      //      gateway/bad-request: session page through seq N is past cursor M
      //   返回原样透传 { records:[{type:'event',event:{…}}], hasMore }，
      //   客户端自己把 event 渲染成消息流（不做任何语义裁剪，免得又变成"只能看"）。
      path: API.page,
      handler: withFence(async (req, res) => {
        const host = registry.find(queryParam(req.url, 'id'))
        const sessionId = queryParam(req.url, 'sessionId') ?? ''
        if (!host) return writeJson(res, 404, { error: 'host not found' })
        if (!sessionId) return writeJson(res, 400, { error: 'sessionId required' })
        const tunnel = runningTunnel(host)
        if (!tunnel) return writeJson(res, 409, { error: 'tunnel not running' })
        const throughSeq = Number(queryParam(req.url, 'throughSeq'))
        if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) {
          return writeJson(res, 400, { error: 'throughSeq (non-negative integer) required' })
        }
        const maxMessages = Number(queryParam(req.url, 'maxMessages'))
        const beforeSeqRaw = queryParam(req.url, 'beforeSeq')
        const beforeSeq = beforeSeqRaw === undefined ? undefined : Number(beforeSeqRaw)
        const request = {
          address: { kind: 'session', sessionId },
          throughSeq,
          ...(Number.isSafeInteger(maxMessages) && maxMessages > 0 ? { maxMessages } : {}),
          ...(Number.isSafeInteger(beforeSeq) && beforeSeq > 0 ? { beforeSeq } : {}),
        }
        try {
          const r = await remoteRpc(host, tunnel, 'session/page', request, { resolveToken })
          const data = await r.json()
          if (data?.result?.ok !== true) {
            return writeJson(res, 502, { error: data?.result?.error ?? 'remote rpc failed' })
          }
          return writeJson(res, 200, {
            records: data.result.value?.records ?? [],
            hasMore: !!(data.result.value && data.result.value.hasMore),
          })
        } catch (error) {
          return writeJson(res, 502, { error: String(error) })
        }
      }),
    },
    {
      // 一条会话的投影（标题/用量/turns/contextPressure…），也用来拿 asOfSeq（= page 的 cursor 上限）。
      path: API.projection,
      handler: withFence(async (req, res) => {
        const host = registry.find(queryParam(req.url, 'id'))
        const sessionId = queryParam(req.url, 'sessionId') ?? ''
        if (!host) return writeJson(res, 404, { error: 'host not found' })
        if (!sessionId) return writeJson(res, 400, { error: 'sessionId required' })
        const tunnel = runningTunnel(host)
        if (!tunnel) return writeJson(res, 409, { error: 'tunnel not running' })
        try {
          const r = await remoteRpc(host, tunnel, 'session/projections', { sessionId }, { resolveToken })
          const data = await r.json()
          if (data?.result?.ok !== true) {
            return writeJson(res, 502, { error: data?.result?.error ?? 'remote rpc failed' })
          }
          return writeJson(res, 200, { projection: data.result.value ?? null })
        } catch (error) {
          return writeJson(res, 502, { error: String(error) })
        }
      }),
    },
    {
      // ⚠️ 花钱的：远端 session/prompt 会让**远端**真的跑一轮模型。
      //    所以这里没有任何自动重试/自动补发：只在用户按下「发送」（并经前端二次确认）后调用一次。
      //    requestId 由调用方给出（没有就现生成），远端用它去重：同 requestId 重复提交只算一次。
      //
      //    `{ probe: true }` 是**零费用**链路探针：发一条 content=[] 的 prompt，
      //    远端会在"解析 Agent / 写会话事件之前"拒掉它
      //    （gateway/bad-request: prompt content must include non-whitespace text or an attachment），
      //    于是"本地路由 → 隧道 → 远端 RPC → 错误原样回显"整条链被验证，且不产生任何模型调用。
      path: API.prompt,
      handler: withFence(async (req, res) => {
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req)
        const probe = body?.probe === true
        const host = registry.find(body?.id)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        const text = typeof body?.text === 'string' ? body.text : ''
        if (!host) return writeJson(res, 404, { error: 'host not found' })
        if (!sessionId) return writeJson(res, 400, { error: 'sessionId required' })
        if (!probe && !text.trim()) return writeJson(res, 400, { error: 'text required (非空白文本)' })
        const mode = body?.mode === 'steer' ? 'steer' : 'queue'
        const tunnel = runningTunnel(host)
        if (!tunnel) return writeJson(res, 409, { error: 'tunnel not running' })
        const request = {
          requestId: typeof body?.requestId === 'string' && body.requestId ? body.requestId : `rg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          sessionId,
          mode,
          content: probe ? [] : [{ type: 'text', text }],
        }
        try {
          const r = await remoteRpc(host, tunnel, 'session/prompt', request, { resolveToken })
          const data = await r.json()
          if (data?.result?.ok !== true) {
            // 远端的业务错误（例如 content 不合法）原样回给界面 —— 这正是"发送链路通了"的证据
            return writeJson(res, 502, { error: data?.result?.error ?? 'prompt failed', requestId: request.requestId, probe })
          }
          return writeJson(res, 200, { ok: true, requestId: request.requestId, probe, value: data.result.value ?? null })
        } catch (error) {
          return writeJson(res, 502, { error: String(error) })
        }
      }),
    },
    {
      // 新建一条远端会话。不传 sessionId 时由远端生成（实测 value.sessionId 返回新 id）。
      path: API.create,
      handler: withFence(async (req, res) => {
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req)
        const host = registry.find(body?.id)
        if (!host) return writeJson(res, 404, { error: 'host not found' })
        const tunnel = runningTunnel(host)
        if (!tunnel) return writeJson(res, 409, { error: 'tunnel not running' })
        const request = {}
        if (typeof body?.sessionId === 'string' && body.sessionId) request.sessionId = body.sessionId
        if (typeof body?.cwd === 'string' && body.cwd) request.cwd = body.cwd
        if (typeof body?.agentPreset === 'string' && body.agentPreset) request.agentPreset = body.agentPreset
        try {
          const r = await remoteRpc(host, tunnel, 'session/create', request, { resolveToken })
          const data = await r.json()
          if (data?.result?.ok !== true) return writeJson(res, 502, { error: data?.result?.error ?? 'create failed' })
          return writeJson(res, 200, {
            ok: true,
            sessionId: data.result.value?.sessionId ?? null,
            agentPreset: data.result.value?.agentPreset ?? null,
          })
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
          }, resolveToken)
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

export { API, BASE, makeRoutes, writeJson, readJsonBody, queryParam, isLoopbackRequest }
