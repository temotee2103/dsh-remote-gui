/**
 * dsh-remote-gui — SSH tunnel lifecycle.
 *
 * Owns the `ssh -L <localPort>:127.0.0.1:<remotePort> <alias> -N` child processes:
 * starting and stopping them, adopting one that survived a local DSH restart,
 * the watchdog that re-establishes dropped auto-tunnels, and the tunnel snapshot
 * the routes read. Local-port allocation lives here too.
 *
 * `tunnelStatus(id, tunnelMap)` takes an optional map so tests can inject a fake
 * tunnel table and drive the routes without ever spawning ssh.
 */
import { spawn } from 'node:child_process'
import { connect } from 'node:net'

const DEFAULT_REMOTE_PORT = 3080
const DEFAULT_LOCAL_PORT = 5640

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

/**
 * 取隧道快照。`tunnelMap` 可注入（测试传假隧道表；默认就是模块内那张真表）。
 * 单参数调用 `tunnelStatus(id)` 的行为与以前完全一致。
 */
function tunnelStatus(id, tunnelMap = tunnels) {
  const t = tunnelMap.get(id)
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

/** 本地端口分配器：从 DEFAULT_LOCAL_PORT 起自增（避开 dsh-sev 的默认端口）。 */
function createPortAllocator() {
  let nextLocalPort = DEFAULT_LOCAL_PORT
  return () => { nextLocalPort += 1; return nextLocalPort }
}

export {
  DEFAULT_LOCAL_PORT,
  DEFAULT_REMOTE_PORT,
  tunnels,
  desired,
  probePort,
  startTunnel,
  stopTunnel,
  tunnelStatus,
  sweepOnce,
  createPortAllocator,
}
