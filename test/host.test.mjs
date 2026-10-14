/**
 * 宿主半边（lib/index.js）的单元测试 —— 用本机 mock 远端，零外部依赖、不碰 ssh/外网。
 *
 * 覆盖的契约（都是真机实测出来的形状）：
 *   - 凭据兑换：GET /?token=<tok>  → 303 + Set-Cookie
 *   - RPC 信封：POST /api/<ns>/<method>，method 用斜杠形式，payload.args._request
 *   - 每个 /api 请求必须带凭据 cookie，否则远端 401
 *   - 401/403 时自动重新兑换并重试一次
 *   - loopback 围栏：非 loopback 一律 403
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(path.join(repoRoot, 'lib', 'index.js')).href)

const TOKEN = 'tok-test-1'
const COOKIE_NAME = 'dsh-auth-test'

/** 远端 mock 返回的一条会话（形状与真远端一致，含 projections 嵌套）。 */
const SESSION_ITEM = {
  sessionId: 's1',
  updatedAt: 1,
  running: false,
  blank: false,
  cwd: '/tmp',
  projections: { values: { title: 'T1', sessionStats: { turns: 3 } } },
}

/** 起一个模拟真远端行为的 HTTP 服务（随机端口，只绑 127.0.0.1）。 */
function startMockRemote({ rotateCookieOnFirstRpc = false } = {}) {
  const state = {
    token: TOKEN,
    cookie: 'abc',
    exchanges: 0,
    rpcs: [],
    rotateCookieOnFirstRpc,
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const cookieHeader = req.headers.cookie ?? ''

    // 凭据兑换（带 ?token=）与"已带凭据取页面"（health 探测走这条，无 token 参数）
    if (req.method === 'GET' && url.pathname === '/') {
      const token = url.searchParams.get('token')
      if (token !== null) {
        state.exchanges += 1
        if (token !== state.token) {
          res.writeHead(401, { 'content-type': 'text/plain' })
          res.end('bad token')
          return
        }
        res.writeHead(303, {
          location: './',
          'set-cookie': `${COOKIE_NAME}=${state.cookie}; Path=/; HttpOnly`,
        })
        res.end()
        return
      }
      if (!cookieHeader.includes(`${COOKIE_NAME}=${state.cookie}`)) {
        res.writeHead(401, { 'content-type': 'text/plain' })
        res.end('dsh web authentication required')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>DeepSeek Harness</title>')
      return
    }

    // typert RPC
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        let parsed = null
        try { parsed = JSON.parse(body) } catch { /* 留 null，后面断言会抓到 */ }
        state.rpcs.push({
          path: url.pathname,
          method: parsed?.method,
          args: parsed?.payload?.args,
          cookie: cookieHeader,
        })

        // 第一次 RPC 直接 401 **并且换掉** cookie 值：
        // 只有"重新兑换拿到新 cookie"的实现才能最终成功。
        if (state.rotateCookieOnFirstRpc && state.rpcs.length === 1) {
          state.cookie = 'rotated'
          res.writeHead(401, { 'content-type': 'text/plain' })
          res.end('unauthorized')
          return
        }

        if (!cookieHeader.includes(`${COOKIE_NAME}=${state.cookie}`)) {
          res.writeHead(401, { 'content-type': 'text/plain' })
          res.end('unauthorized')
          return
        }

        res.writeHead(200, { 'content-type': 'application/json' })
        // 按方法回不同形状 —— 每个形状都是 2026-10-14 从真远端读到的（见 docs/SPEC.md）。
        const method = parsed?.method
        const args = parsed?.payload?.args ?? {}
        let value = { items: [SESSION_ITEM] }
        if (method === 'session/page') {
          value = { records: [{ type: 'event', event: { type: 'user/message', seq: 7, time: 1, data: { content: [{ type: 'text', text: 'hi' }] } } }], hasMore: true }
        } else if (method === 'session/projections') {
          value = { asOfSeq: 42, values: { title: 'T1' } }
        } else if (method === 'session/create') {
          value = { sessionId: 's-new', agentPreset: 'standard' }
        } else if (method === 'session/prompt') {
          // 远端对空 content 的真实拒绝（零费用路径）；有文本才算受理
          const content = args?.request?.content
          if (!Array.isArray(content) || content.length === 0) {
            res.end(JSON.stringify({
              type: 'server-response',
              rpcId: 'mock-1',
              result: {
                ok: false,
                error: {
                  code: 'gateway/bad-request',
                  message: 'prompt content must include non-whitespace text or an attachment',
                  details: {},
                },
              },
            }))
            return
          }
          value = { accepted: true }
        } else if (method === 'workspace/archiveSession') {
          value = { archivedSessionIds: ['s1'] }
        }
        res.end(JSON.stringify({
          type: 'server-response',
          rpcId: 'mock-1',
          result: { ok: true, value },
        }))
      })
      return
    }

    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, state, port: server.address().port })
    })
  })
}

/** 造一套"假隧道 + 假 token 来源"的依赖，于是完全不需要 ssh。 */
async function makeHarness({ rotateCookieOnFirstRpc = false, hostId = 'mock-host' } = {}) {
  const mock = await startMockRemote({ rotateCookieOnFirstRpc })
  const host = {
    id: hostId,
    alias: 'mock-alias',
    name: 'Mock remote',
    port: 3080,
    localPort: mock.port,
    autoTunnel: false,
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-gui-test-'))
  const registry = new mod.Registry(path.join(tmp, 'hosts.json'))
  registry.upsert(host)

  // 注入一张假隧道表：state=running、localPort 指向 mock 端口
  const tunnelMap = new Map([[host.id, {
    localPort: mock.port,
    remotePort: 3080,
    alias: host.alias,
    state: 'running',
    exitCode: null,
  }]])

  let tokenReads = 0
  const resolveToken = async () => { tokenReads += 1; return TOKEN }

  const routes = mod.makeRoutes({
    registry,
    allocatePort: () => 5699,
    tunnels: tunnelMap,
    resolveToken,
  })

  return {
    host,
    mock,
    routes,
    tunnelMap,
    get tokenReads() { return tokenReads },
    async close() {
      await new Promise((resolve) => mock.server.close(resolve))
      fs.rmSync(tmp, { recursive: true, force: true })
    },
  }
}

/** 直接调用路由处理器（不出网）：可指定 remoteAddress / Host 来测围栏，也可带请求体。 */
function call(routes, routePath, { method = 'GET', url, remoteAddress = '127.0.0.1', host = '127.0.0.1:19387', payload: requestBody } = {}) {
  const route = routes.find((r) => r.path === routePath)
  if (!route) throw new Error(`no route ${routePath}`)
  let status = 0
  let payload = ''
  const res = {
    writeHead(code) { status = code; return this },
    end(chunk) { if (chunk !== undefined) payload += String(chunk) },
  }
  const req = {
    method,
    url,
    headers: { host, 'content-type': 'application/json' },
    socket: { remoteAddress },
    connection: { remoteAddress },
    // 最小的事件目标：readJsonBody 用 on('data'/'end'/'error') 读请求体。
    // 同步把整块 body 发出去 —— 监听器是在路由处理器里同步注册的，所以不会丢事件。
    on(event, fn) {
      if (event === 'data' && requestBody !== undefined) fn(String(requestBody))
      if (event === 'end') fn()
      return this
    },
    destroy() {},
  }
  // 注意：围栏拒绝是**同步**返回的（没有 promise），所以这里要 Promise.resolve 包一层
  return Promise.resolve(route.handler(req, res)).then(() => ({ status, payload }))
}

test('GET /hosts：带 seedUrl，且 seedUrl 指向该主机的隧道端口', async () => {
  const h = await makeHarness({ hostId: 'host-seed' })
  try {
    const out = await call(h.routes, '/api/dsh-remote-gui/hosts', { url: '/api/dsh-remote-gui/hosts' })
    assert.equal(out.status, 200)
    const body = JSON.parse(out.payload)
    assert.equal(body.hosts.length, 1)
    const host = body.hosts[0]
    assert.equal(host.tunnel.state, 'running')
    assert.equal(host.seedUrl, `http://127.0.0.1:${h.mock.port}/?token=${TOKEN}`)
  } finally {
    await h.close()
  }
})

test('GET /sessions：字段映射正确（title/turns 取自 projections.values）', async () => {
  const h = await makeHarness({ hostId: 'host-sessions' })
  try {
    const out = await call(h.routes, '/api/dsh-remote-gui/sessions', {
      url: `/api/dsh-remote-gui/sessions?id=${h.host.id}`,
    })
    assert.equal(out.status, 200)
    const body = JSON.parse(out.payload)
    assert.equal(Array.isArray(body.sessions), true)
    assert.equal(body.sessions.length, 1)
    const s = body.sessions[0]
    assert.equal(s.sessionId, 's1')
    assert.equal(s.title, 'T1')            // ← projections.values.title
    assert.equal(s.turns, 3)               // ← projections.values.sessionStats.turns
    assert.equal(s.cwd, '/tmp')
    assert.equal(s.running, false)
    assert.equal(s.updatedAt, 1)
  } finally {
    await h.close()
  }
})

test('RPC 信封：method 必须是斜杠形式，且 payload.args._request 必须存在', async () => {
  const h = await makeHarness({ hostId: 'host-envelope' })
  try {
    await call(h.routes, '/api/dsh-remote-gui/sessions', {
      url: `/api/dsh-remote-gui/sessions?id=${h.host.id}`,
    })
    assert.equal(h.mock.state.rpcs.length, 1)
    const rpc = h.mock.state.rpcs[0]
    assert.equal(rpc.path, '/api/session/list')   // 路径也是斜杠形式
    assert.equal(rpc.method, 'session/list')      // ← 写成 session.list 会被真远端拒
    assert.ok(rpc.args, 'payload.args 必须存在')
    assert.ok(rpc.args._request, 'payload.args._request 必须存在')
    assert.deepEqual(rpc.args._request, {})
    // session/list 是**唯一**形参名带下划线前缀的方法，别的 key 都是错的
    assert.deepEqual(Object.keys(rpc.args), ['_request'])
  } finally {
    await h.close()
  }
})

test('RPC 信封：归档用的 key 是 `request`（不是 session/list 的 `_request`）', async () => {
  // 这里是 2026-10-14 那个静默失败缺陷的回归测试：
  // workspace/archiveSession 的宿主形参名是 `request`（typert 描述符实测），
  // 写成 `_request` 会让远端回 gateway/arguments-invalid，归档永远不生效。
  const h = await makeHarness({ hostId: 'host-archive-key' })
  try {
    const out = await call(h.routes, '/api/dsh-remote-gui/session-archive', {
      method: 'POST',
      url: '/api/dsh-remote-gui/session-archive',
      payload: JSON.stringify({ id: h.host.id, sessionId: 's1' }),
      headers: { 'content-type': 'application/json' },
    })
    assert.equal(h.mock.state.rpcs.length, 1)
    const rpc = h.mock.state.rpcs[0]
    assert.equal(rpc.path, '/api/workspace/archiveSession')
    assert.equal(rpc.method, 'workspace/archiveSession')
    assert.deepEqual(Object.keys(rpc.args), ['request'], 'args 的 key 必须正好是 request')
    assert.deepEqual(rpc.args.request, { sessionId: 's1' })
    assert.equal(out.status, 200, '插件路由应当回 200，而不是把 arguments-invalid 变成 502')
  } finally {
    await h.close()
  }
})

// ── 原生会话视图用到的路由（读正文 / 发消息 / 新建会话）─────────────────────────
// 这三个都是 2026-10-14 真机实测出来的契约，回归测试锁住形状：
//   · 信封 key 必须是宿主形参名 `request`
//   · session/page 的 throughSeq 必须是安全整数（超过 cursor 会被远端拒）
//   · session/prompt 的正文必须非空白；只有显式 probe:true 才发空 content（零费用链路探针）

test('GET /session-page：走 session/page，信封 key 是 request，records 原样透传', async () => {
  const h = await makeHarness({ hostId: 'host-page' })
  try {
    const out = await call(h.routes, '/api/dsh-remote-gui/session-page', {
      url: `/api/dsh-remote-gui/session-page?id=${h.host.id}&sessionId=s1&throughSeq=42&maxMessages=5`,
    })
    assert.equal(out.status, 200)
    const body = JSON.parse(out.payload)
    assert.equal(body.records.length, 1)
    assert.equal(body.records[0].event.type, 'user/message')
    assert.equal(body.hasMore, true)

    const rpc = h.mock.state.rpcs[0]
    assert.equal(rpc.path, '/api/session/page')
    assert.equal(rpc.method, 'session/page')     // 斜杠形式
    assert.deepEqual(Object.keys(rpc.args), ['request'], 'session/page 的形参名是 request')
    assert.deepEqual(rpc.args.request.address, { kind: 'session', sessionId: 's1' })
    assert.equal(rpc.args.request.throughSeq, 42)
    assert.equal(rpc.args.request.maxMessages, 5)
  } finally {
    await h.close()
  }
})

test('GET /session-page：throughSeq 缺失/非法 → 400，且**不打**远端 RPC', async () => {
  const h = await makeHarness({ hostId: 'host-page-bad' })
  try {
    const missing = await call(h.routes, '/api/dsh-remote-gui/session-page', {
      url: `/api/dsh-remote-gui/session-page?id=${h.host.id}&sessionId=s1`,
    })
    assert.equal(missing.status, 400)
    const notInt = await call(h.routes, '/api/dsh-remote-gui/session-page', {
      url: `/api/dsh-remote-gui/session-page?id=${h.host.id}&sessionId=s1&throughSeq=abc`,
    })
    assert.equal(notInt.status, 400)
    assert.equal(h.mock.state.rpcs.length, 0, '参数不合法就不应该碰远端')
  } finally {
    await h.close()
  }
})

test('GET /session-projection：走 session/projections（key=request），回投影原文', async () => {
  const h = await makeHarness({ hostId: 'host-proj' })
  try {
    const out = await call(h.routes, '/api/dsh-remote-gui/session-projection', {
      url: `/api/dsh-remote-gui/session-projection?id=${h.host.id}&sessionId=s1`,
    })
    assert.equal(out.status, 200)
    assert.equal(JSON.parse(out.payload).projection.asOfSeq, 42)
    const rpc = h.mock.state.rpcs[0]
    assert.equal(rpc.method, 'session/projections')
    assert.deepEqual(rpc.args, { request: { sessionId: 's1' } })
  } finally {
    await h.close()
  }
})

test('POST /session-prompt：信封 key=request，正文进 content[0].text，mode 默认 queue', async () => {
  const h = await makeHarness({ hostId: 'host-prompt' })
  try {
    const out = await call(h.routes, '/api/dsh-remote-gui/session-prompt', {
      method: 'POST',
      url: '/api/dsh-remote-gui/session-prompt',
      payload: JSON.stringify({ id: h.host.id, sessionId: 's1', text: 'hello remote' }),
    })
    assert.equal(out.status, 200)
    const rpc = h.mock.state.rpcs[0]
    assert.equal(rpc.method, 'session/prompt')
    assert.deepEqual(Object.keys(rpc.args), ['request'])
    const req = rpc.args.request
    assert.equal(req.sessionId, 's1')
    assert.equal(req.mode, 'queue')
    assert.deepEqual(req.content, [{ type: 'text', text: 'hello remote' }])
    assert.equal(typeof req.requestId, 'string')
  } finally {
    await h.close()
  }
})

test('POST /session-prompt：空白正文 → 400 且不打远端（花钱的动作必须有非空正文）', async () => {
  const h = await makeHarness({ hostId: 'host-prompt-blank' })
  try {
    const blank = await call(h.routes, '/api/dsh-remote-gui/session-prompt', {
      method: 'POST',
      url: '/api/dsh-remote-gui/session-prompt',
      payload: JSON.stringify({ id: h.host.id, sessionId: 's1', text: '   \n ' }),
    })
    assert.equal(blank.status, 400)
    assert.match(blank.payload, /text required/)
    assert.equal(h.mock.state.rpcs.length, 0)
  } finally {
    await h.close()
  }
})

test('POST /session-prompt probe:true：发空 content 验证链路，远端拒绝被原样回显（零费用）', async () => {
  const h = await makeHarness({ hostId: 'host-prompt-probe' })
  try {
    const out = await call(h.routes, '/api/dsh-remote-gui/session-prompt', {
      method: 'POST',
      url: '/api/dsh-remote-gui/session-prompt',
      payload: JSON.stringify({ id: h.host.id, sessionId: 's1', probe: true }),
    })
    // 远端拒绝 → 插件路由把它变成 502 + error（界面据此显示"链路通 ✅ + 远端原话"）
    assert.equal(out.status, 502)
    const body = JSON.parse(out.payload)
    assert.equal(body.error.code, 'gateway/bad-request')
    assert.match(body.error.message, /non-whitespace text or an attachment/)
    const rpc = h.mock.state.rpcs[0]
    assert.deepEqual(rpc.args.request.content, [], 'probe 必须发空 content（远端在调模型前就拒）')
  } finally {
    await h.close()
  }
})

test('POST /session-create：不传 sessionId 时 args 里就没有它，返回值带新会话 id', async () => {
  const h = await makeHarness({ hostId: 'host-create' })
  try {
    const out = await call(h.routes, '/api/dsh-remote-gui/session-create', {
      method: 'POST',
      url: '/api/dsh-remote-gui/session-create',
      payload: JSON.stringify({ id: h.host.id, cwd: '/tmp' }),
    })
    assert.equal(out.status, 200)
    const body = JSON.parse(out.payload)
    assert.equal(body.ok, true)
    assert.equal(body.sessionId, 's-new')
    const rpc = h.mock.state.rpcs[0]
    assert.equal(rpc.method, 'session/create')
    assert.deepEqual(rpc.args, { request: { cwd: '/tmp' } })
  } finally {
    await h.close()
  }
})

test('凭据：RPC 请求必须带兑换来的 cookie', async () => {
  const h = await makeHarness({ hostId: 'host-cookie' })
  try {
    const out = await call(h.routes, '/api/dsh-remote-gui/sessions', {
      url: `/api/dsh-remote-gui/sessions?id=${h.host.id}`,
    })
    assert.equal(out.status, 200)
    assert.equal(h.mock.state.exchanges, 1, '应先兑换一次凭据')
    const rpc = h.mock.state.rpcs[0]
    assert.match(rpc.cookie, new RegExp(`${COOKIE_NAME}=abc`), 'RPC 必须带上兑换来的 cookie')
  } finally {
    await h.close()
  }
})

test('loopback 围栏：非 loopback 请求一律 403', async () => {
  const h = await makeHarness({ hostId: 'host-fence' })
  try {
    const out = await call(h.routes, '/api/dsh-remote-gui/hosts', {
      url: '/api/dsh-remote-gui/hosts',
      remoteAddress: '10.0.0.5',
      host: 'evil.example.com',
    })
    assert.equal(out.status, 403)
    assert.match(out.payload, /loopback only/)
  } finally {
    await h.close()
  }
})

test('401 自动刷新：远端换掉 cookie 后，插件重新兑换并最终拿到 200', async () => {
  const h = await makeHarness({ hostId: 'host-refresh', rotateCookieOnFirstRpc: true })
  try {
    const out = await call(h.routes, '/api/dsh-remote-gui/sessions', {
      url: `/api/dsh-remote-gui/sessions?id=${h.host.id}`,
    })
    assert.equal(out.status, 200, '重试后应当成功')
    const body = JSON.parse(out.payload)
    assert.equal(body.sessions.length, 1)

    // 两次 RPC：第一次 401，第二次带新 cookie 成功
    assert.equal(h.mock.state.rpcs.length, 2)
    assert.match(h.mock.state.rpcs[0].cookie, new RegExp(`${COOKIE_NAME}=abc`))
    assert.match(h.mock.state.rpcs[1].cookie, new RegExp(`${COOKIE_NAME}=rotated`))
    // 兑换了两次（第二次才拿到 rotated）——证明走的是"重新兑换"而不是"拿旧 cookie 硬重试"
    assert.equal(h.mock.state.exchanges, 2)
    assert.ok(h.tokenReads >= 2, '应当重新读一次远端启动 token')
  } finally {
    await h.close()
  }
})

test('health 路由：隧道在跑时报告 hostUp 与真实 HTTP 状态', async () => {
  const h = await makeHarness({ hostId: 'host-health' })
  try {
    const out = await call(h.routes, '/api/dsh-remote-gui/health', {
      url: `/api/dsh-remote-gui/health?id=${h.host.id}`,
    })
    assert.equal(out.status, 200)
    const body = JSON.parse(out.payload)
    assert.equal(body.hostUp, true)
    assert.equal(body.status, 200)
    assert.equal(body.tunnel.state, 'running')
  } finally {
    await h.close()
  }
})

test('peer 依赖缺失：loadDefineTool() 返回 undefined，模块照常加载', async () => {
  // 仓库里没装 @deepseek-ai/dsh-tools（peer 依赖），所以 import 应当失败并被兜住。
  const defineTool = await mod.loadDefineTool()
  assert.equal(defineTool, undefined)
})

test('remoteRunTaskTool：没有 defineTool 也返回可用定义，render 仍是 ContentBlock 数组', () => {
  const tool = mod.remoteRunTaskTool({ hosts: [], find: () => undefined }, undefined)
  assert.equal(tool.name, 'remote_gui_run_task')
  assert.equal(typeof tool.execute, 'function')
  // 0.2.x 契约：render 必须返回数组（返回字符串会让 harness 报 content.some is not a function）
  const rendered = tool.output.render({}, { output: 'hello', exitCode: 0 })
  assert.ok(Array.isArray(rendered))
  assert.deepEqual(rendered, [{ type: 'text', text: 'exit 0\nhello' }])
})

test('remoteRunTaskTool：注入 defineTool 时会被套用（宿主里的真实路径）', () => {
  let seen = null
  const defineTool = (def) => { seen = def; return { ...def, wrapped: true } }
  const tool = mod.remoteRunTaskTool({ hosts: [], find: () => undefined }, defineTool)
  assert.equal(tool.wrapped, true)
  assert.equal(seen.name, 'remote_gui_run_task')
})

test('apply()：peer 依赖缺失 + 空注册表时不抛错，并跳过 agent 工具注册', async () => {
  // 必须把 DSH_HOME 指到临时目录：否则会读用户真实注册表，
  // autoTunnel 主机可能真的去起 ssh。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-gui-apply-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = tmp

  const registered = []
  const disposers = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    tools: { register(tool) { registered.push(tool); return () => {} } },
    webServer: { register() { return () => {} } },
    systemPrompt: { section() { return () => {} } },
  }

  try {
    assert.doesNotThrow(() => mod.apply(ctx))
    // 给惰性 import 的失败路径一点时间跑完
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(registered.length, 0, '拿不到 dsh-tools 就应当跳过注册，而不是抛错')
  } finally {
    for (const dispose of disposers) { try { dispose() } catch { /* noop */ } }
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
