/**
 * dsh-remote-gui — remote credential + RPC layer.
 *
 * Everything that talks to a remote DSH *through* the tunnel:
 *  - reading the remote `dsh web` launch token over ssh (with a short cache),
 *  - exchanging that token for the browser-credential cookie DSH 0.2.x requires
 *    on every /api request, and caching the cookie per host,
 *  - calling the typert RPC with the right envelope, refreshing credentials once
 *    on 401/403,
 *  - fetching a remote page with the credential attached (proxy route).
 *
 * Contract (measured on DSH 0.2.0-rc.2):
 *   exchange  GET  http://127.0.0.1:<tunnelPort>/?token=<launch token>
 *             → 303 + Set-Cookie: dsh-auth-<authority hash>=<signed value>
 *   rpc       POST http://127.0.0.1:<tunnelPort>/api/<ns>/<method>
 *             body {"type":"client-request","rpcId","method":"<ns>/<method>",
 *                   "payload":{"args":{"_request":{…}}}}
 *             data lives in result.value; `method` must equal the endpoint (slash form)
 *
 *   ⚠️ payload.args 里那个 key 是**宿主方法的形参名**，不是固定字符串。
 *      判定依据在安装目录的 typert 描述符里（每个 RPC 一条 invocation）：
 *        resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-api-<ns>-controller/lib/typert.host.js
 *        → invocations[].parameters[].{ name, wire }   ← 这两个字段就是 key
 *      全量核对过（2026-10-14）：
 *        · session/list              → 形参名 `_request`（**唯一**用下划线前缀的方法）
 *        · workspace/archiveSession  → 形参名 `request`
 *        · session/{create,projections,page,follow,prompt,rename,cancel,search,selectModel,updateQueue,…}
 *          与 workspace/{create,delete,rename,pinSession,unpinSession,unarchiveSession,…}
 *          / schedule/* / job/* / messageFeedback/* / skills/list … → 全是 `request`
 *      用错 key 的症状是**静默失败**：远端结果形如
 *        result.ok=false, error.code='gateway/arguments-invalid'
 *        message: typert gateway: <ns>/<method>: args fields do not match the descriptor:
 *                 missing "request"; unexpected "_request"
 *      （2026-10-14 实测：归档会话就是这样静默失败的，界面上只看到"点了没反应"。）
 *      写新调用前先读对应 controller 的 typert.host.js，**不要照抄**别处的 key。
 *
 * `resolveToken` is injectable everywhere so tests can replace the ssh read and
 * stay completely offline.
 */
import { spawn } from 'node:child_process'

const remoteCookies = new Map() // host.id -> cookie header
const remoteTokens = new Map() // host.id -> { token, at } 远端启动 token（带时间戳）

/** 远端启动 token 的缓存寿命：超过就重读一次（远端重启会换 token）。 */
const TOKEN_TTL_MS = 5 * 60 * 1000

/** ssh 读远端 `dsh web` 打印的启动 token。maxAgeMs>0 时命中新鲜缓存就不走 ssh。 */
function remoteLaunchToken(host, maxAgeMs = 0) {
  const cached = remoteTokens.get(host.id)
  if (cached && maxAgeMs > 0 && Date.now() - cached.at < maxAgeMs) return Promise.resolve(cached.token)
  return readLaunchToken(host).then((token) => {
    // The first ssh read can come back empty right after a tunnel is
    // established, which used to surface as a missing seedUrl and therefore a
    // remote GUI stuck on the 401 page. One retry turns that blip into a short
    // delay; a real failure still ends up as '' on the second attempt.
    if (token) return token
    return new Promise((resolve) => setTimeout(resolve, 600)).then(() => readLaunchToken(host))
  })
}

/** One ssh attempt. Separate so `remoteLaunchToken` can retry it once. */
function readLaunchToken(host) {
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

/**
 * 取（并缓存）远端浏览器凭据 cookie：token → 经隧道兑换。
 * `resolveToken` 可注入 —— 测试里替换掉"ssh 读 token"那一步（默认是真实现）。
 */
function remoteCookieHeader(host, tunnel, force = false, resolveToken = remoteLaunchToken) {
  if (!force && remoteCookies.has(host.id)) return Promise.resolve(remoteCookies.get(host.id))
  return (async () => {
    const token = await resolveToken(host)
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

/**
 * 方法名 → payload.args 里的形参名。
 *
 * 这个表**不是**约定俗成的花样，而是宿主 typert 描述符里的字面值
 * （invocations[].parameters[].name；见文件头注释给出的路径）。
 * 默认值 `_request` 只对 session/list 成立；新加远端调用时：
 *   ① 去 controller 的 typert.host.js 里读那个方法的 parameters[].name；
 *   ② 在这里补一行，或在调用点显式传 `{ argsKey: '…' }`。
 */
const ARGS_KEY_BY_METHOD = {
  'session/list': '_request',
  'workspace/archiveSession': 'request',
  // 原生会话视图用到的方法（2026-10-14 从 typert.host.js 的 parameters[].name 逐条读出并实测）
  'session/page': 'request',
  'session/prompt': 'request',
  'session/create': 'request',
  'session/projections': 'request',
}

/** 取该方法的形参名；未登记的方法退回 `_request`（历史上唯一用到的那一个）。 */
function argsKeyForMethod(method) {
  return ARGS_KEY_BY_METHOD[method] ?? '_request'
}

/**
 * 带正确信封调一次远端 RPC；401/403 时刷新凭据重试一次。
 * 第 5 个参数既接受旧式布尔（`retry`），也接受 `{ retry, resolveToken, argsKey }`。
 * `argsKey` 不传时按 `argsKeyForMethod(endpoint)` 决定 —— 也就是那个 key 会跟着方法名走，
 * 不会出现"归档请求套着 session/list 的 key"这种错。
 */
async function remoteRpc(host, tunnel, endpoint, request = {}, options = {}) {
  const opts = typeof options === 'boolean' ? { retry: options } : options
  const retry = opts.retry !== false
  const resolveToken = opts.resolveToken ?? remoteLaunchToken
  const argsKey = opts.argsKey ?? argsKeyForMethod(endpoint)
  const cookie = await remoteCookieHeader(host, tunnel, false, resolveToken)
  const headers = { 'content-type': 'application/json' }
  if (cookie) headers.cookie = cookie
  const r = await fetch(`http://127.0.0.1:${tunnel.localPort}/api/${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `rg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      method: endpoint,
      payload: { args: { [argsKey]: request } },
    }),
    signal: AbortSignal.timeout(20000),
  })
  if (retry && (r.status === 401 || r.status === 403)) {
    // 凭据过期大多是因为远端重启过（token 换了）—— 两个缓存一起清掉再试一次
    remoteCookies.delete(host.id)
    remoteTokens.delete(host.id)
    return remoteRpc(host, tunnel, endpoint, request, { retry: false, resolveToken, argsKey })
  }
  return r
}

/** 带凭据取远端页面（代理路由用）。`resolveToken` 同样可注入。 */
async function remoteFetchWithCredential(host, tunnel, path, init = {}, resolveToken = remoteLaunchToken) {
  const cookie = await remoteCookieHeader(host, tunnel, false, resolveToken)
  const headers = { ...(init.headers ?? {}) }
  if (cookie) headers.cookie = cookie
  return fetch(`http://127.0.0.1:${tunnel.localPort}${path}`, { ...init, headers })
}

/** 丢掉某台主机的凭据/令牌缓存（删除主机、或凭据已失效时用）。 */
function forgetCredentials(hostId) {
  remoteCookies.delete(hostId)
  remoteTokens.delete(hostId)
}

export {
  TOKEN_TTL_MS,
  ARGS_KEY_BY_METHOD,
  argsKeyForMethod,
  remoteLaunchToken,
  remoteCookieHeader,
  remoteRpc,
  remoteFetchWithCredential,
  forgetCredentials,
}
