/**
 * dsh-remote-gui — the `remote_gui_run_task` agent tool.
 *
 * Runs a one-shot task on a registered remote host with
 * `ssh <alias> dsh --profile headless "<task>"` (the task text travels over stdin
 * into a temp file on the server, so arbitrary quoting is safe) and returns the
 * remote agent's single reply.
 *
 * `@deepseek-ai/dsh-tools` is a **peer dependency** (the host provides it, the repo
 * does not install it), so it is imported lazily here and its absence is not an
 * error: `remoteRunTaskTool` still builds a plain definition object, and the caller
 * simply skips registration when `loadDefineTool()` yields nothing.
 */
import { spawn } from 'node:child_process'

const HEADLESS_HOME_DEFAULT = '~/.dsh-headless'
const HEADLESS_TIMEOUT_MS = 300 * 1000

/**
 * 惰性获取 peer 依赖 `@deepseek-ai/dsh-tools` 的 `defineTool`。
 * 拿不到（宿主没提供 / 解析失败）就返回 undefined —— 调用方跳过工具注册，**绝不抛错**。
 */
async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    return typeof mod?.defineTool === 'function' ? mod.defineTool : undefined
  } catch { return undefined }
}

/** ssh 到远端跑一次 headless 任务，拿回它的最终回答。 */
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

/**
 * 构造 agent 工具定义（**同步**、纯对象）。
 *
 * `defineTool` 可选注入：宿主里它是"校验 + 原样返回"的包装；这里即便拿不到它也能返回一个
 * 可用的定义对象 —— 独立验证脚本就是同步调用它、再读 `.output.render` 的。
 * 真正的注册路径在 apply()：只有 loadDefineTool() 成功时才注册。
 */
function remoteRunTaskTool(registry, defineTool) {
  const definition = {
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
  }
  return typeof defineTool === 'function' ? defineTool(definition) : definition
}

export {
  HEADLESS_HOME_DEFAULT,
  HEADLESS_TIMEOUT_MS,
  loadDefineTool,
  runRemoteHeadless,
  remoteRunTaskTool,
}
