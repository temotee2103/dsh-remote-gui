/**
 * dsh-remote-gui — plugin entry (assembly only).
 *
 * Wires the host half together and exposes the plugin's public surface:
 *   lib/registry.js  host registry ($DSH_HOME/remote-gui-hosts.json)
 *   lib/tunnel.js    ssh -L tunnel lifecycle + port allocation
 *   lib/remote.js    remote credential cookie + typert RPC
 *   lib/routes.js    the /api/dsh-remote-gui route family
 *   lib/tool.js      the remote_gui_run_task agent tool
 *
 * Everything else was moved out verbatim; this file only composes them, mounts the
 * effects (tunnel resume, watchdog, routes, guidance, agent tool) and re-exports the
 * names the plugin had before the split.
 *
 * Remote contract (measured on DSH 0.2.0-rc.2):
 *   exchange  GET  http://127.0.0.1:<tunnelPort>/?token=<launch token>
 *             → 303 + Set-Cookie: dsh-auth-<authority hash>=<signed value>
 *   rpc       POST http://127.0.0.1:<tunnelPort>/api/<ns>/<method>
 *             body {"type":"client-request","rpcId","method":"<ns>/<method>",
 *                   "payload":{"args":{"<参数名>":{…}}}}
 *             data lives in result.value; `method` must equal the endpoint (slash form)
 *             ⚠️ args 的 key 是**宿主方法的形参名**（见 lib/remote.js 的 ARGS_KEY_BY_METHOD）：
 *                session/list 是 `_request`，workspace/archiveSession 等其余方法是 `request`。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import { Registry } from './registry.js'
import {
  DEFAULT_LOCAL_PORT,
  DEFAULT_REMOTE_PORT,
  createPortAllocator,
  desired,
  startTunnel,
  stopTunnel,
  sweepOnce,
  tunnelStatus,
  tunnels,
} from './tunnel.js'
import { API, makeRoutes } from './routes.js'
import { loadDefineTool, remoteRunTaskTool } from './tool.js'

const PLUGIN_ID = 'dsh-remote-gui'
const SWEEP_INTERVAL_MS = 15000

function apply(ctx) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const registry = new Registry(join(dshHome, 'remote-gui-hosts.json'))
  const allocatePort = createPortAllocator()

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

  // agent 工具：peer 依赖 dsh-tools 惰性加载；拿不到就安静跳过（不抛错）
  ctx.effect(() => {
    let cancelled = false
    let dispose
    void loadDefineTool().then((defineTool) => {
      if (cancelled) return
      if (typeof defineTool !== 'function') return
      try {
        dispose = ctx.tools.register(remoteRunTaskTool(registry, defineTool))
      } catch (error) {
        try { console.error(`[${PLUGIN_ID}] tools.register error:`, error) } catch { /* noop */ }
      }
    })
    return () => {
      cancelled = true
      if (typeof dispose === 'function') { try { dispose() } catch { /* noop */ } }
    }
  }, `${PLUGIN_ID}: tools`)
}

const inject = ['webServer', 'systemPrompt', 'tools']

export {
  apply,
  inject,
  API,
  Registry,
  makeRoutes,
  startTunnel,
  stopTunnel,
  tunnelStatus,
  sweepOnce,
  remoteRunTaskTool,
  loadDefineTool,
  DEFAULT_LOCAL_PORT,
  DEFAULT_REMOTE_PORT,
}
