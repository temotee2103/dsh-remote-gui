# dsh-remote-gui —— 接口契约（宿主半边 ↔ 客户端半边）

一个独立插件：用 SSH 隧道把远端 DSH 的 GUI 嵌进本地 DSH 界面，并把远端会话列进侧栏。
**不依赖 dsh-sev**；按 DSH `0.2.0-rc.2` 的真实契约实现（下面形状都是实测出来的，见 README）。

## 为什么要有它

`dsh-sev@0.3.4` 是按 DSH 0.1.x 写的，在 0.2.0-rc.2 上远程会话列表与内嵌 GUI 都不可用
（服务端请求缺浏览器凭据 → 401；RPC 信封过时 → 404/400；`output.render` 契约变了）。
本插件用 0.2.x 的正确契约重做这件事，因此不受 dsh-sev 升级影响。

## 远端契约（0.2.0-rc.2，实测）

```
兑换凭据：GET http://127.0.0.1:<隧道端口>/?token=<远端启动 token>
          → 303 + Set-Cookie: dsh-auth-<authority哈希>=<签名值>
          cookie 按 authority 绑定；远端重启后 cookie 仍有效（token 会变）

RPC：     POST http://127.0.0.1:<隧道端口>/api/<ns>/<method>
          content-type: application/json
          cookie: dsh-auth-…（必须，否则 401 "unauthorized"）
          body: {"type":"client-request","rpcId":"…","method":"<ns>/<method>",
                 "payload":{"args":{"_request":{…params…}}}}
          响应：{"type":"server-response","rpcId":"…","result":{"ok":true,"value":…}}
          失败：result.ok=false，result.error={code,message,details}

会话列表：/api/session/list   _request = {}      → result.value.items[]
列出错误：method 必须与 endpoint 一致（斜杠形式）；args 里必须有 _request
远端启动 token：ssh <alias> journalctl --user -u dsh-web -n 400 --no-pager | grep -oE 'token=…' | tail -1
```

## 宿主半边（lib/index.js）—— 路由

所有路由都只允许 loopback 访问（非 loopback 返回 403），并在每个响应里带 `content-type: application/json`。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/dsh-remote-gui/hosts` | — | `{hosts:[Host]}` |
| POST | `/api/dsh-remote-gui/hosts` | `{alias, name?, port?, localPort?, autoTunnel?}` | `{host:Host}` |
| DELETE | `/api/dsh-remote-gui/host?id=` | — | `{ok:true}` |
| POST | `/api/dsh-remote-gui/tunnel` | `{id, action:'start'\|'stop'}` | `{tunnel:Tunnel}` |
| GET | `/api/dsh-remote-gui/sessions?id=` | — | `{sessions:[Session]}` |
| POST | `/api/dsh-remote-gui/session-archive` | `{id, sessionId}` | `{ok:true, archivedSessionIds:[…]}` |
| GET | `/api/dsh-remote-gui/seed?id=` | — | `{url:string}` |
| GET | `/api/dsh-remote-gui/health?id=` | — | `{id, tunnel, hostUp, status}` |

```
Host    = { id, alias, name, port, localPort, autoTunnel, tunnel?:Tunnel, seedUrl?:string }
Tunnel  = { localPort, remotePort, alias, state:'starting'|'running'|'stopped', exitCode:number|null }
Session = { sessionId, title:string|null, running:boolean, blank:boolean,
            updatedAt:number, cwd:string|null, turns:number|null }
```

要点：
- 主机注册表持久化在 `$DSH_HOME/remote-gui-hosts.json`。
- 隧道：spawn `ssh -L <localPort>:127.0.0.1:<port> <alias> -N -o ExitOnForwardFailure=yes …`；
  自动重连（看门狗定时扫描 autoTunnel 主机）；本机重启后收养已存在的隧道（先 connect 探测端口）。
- **凭据**：`remoteCookieHeader(host, tunnel)` —— ssh 读启动 token → 经隧道兑换 → 按 host 缓存；
  收到 401/403 时强制刷新并重试一次。
- **seedUrl**：带 token 的 `http://127.0.0.1:<localPort>/?token=<token>`。
  客户端 iframe 首次加载它，远端就会把凭据 cookie 种进浏览器（303 + Set-Cookie），
  之后 iframe 直接开 `http://127.0.0.1:<localPort>/` 即可（否则是 401 页面）。
- 端口分配从 5636 起自增，避开 dsh-sev 的默认端口。
- 会话列表走 `/api/session/list`，`_request = {}`，读 `result.value.items`。
- agent 工具 `remote_gui_run_task`：ssh + `dsh --profile headless` 跑一次性任务；
  `output.render` 必须返回 **ContentBlock 数组**（0.2.x 契约）。

## 客户端半边（client.js）

`window.__ModuleLoader__.load({ id:'dsh-remote-gui', factory })`，导出 `{ apply, inject }`，
`inject = ['slots','connection','locale']`。

> ⚠️ **不要往 inject 里加 `betterSidebar`。** 本机整套已装插件与 harness 本体（app.asar 命中 0 次）
> 都没有注册这个服务；cordis 的 `inject` 是**必需**依赖，列一个永不出现的服务会让整个客户端半边
> 永远不激活 —— 面板根本不会出现（这也是 dsh-sev 在本机不可用的第三个原因）。
> 代码里对 `ctx.betterSidebar` 的用法保留为带 `typeof` 守卫 + `try/catch` 的可选增强。

UI（照 dsh-sev 客户端的做法：侧栏页脚加一个入口 + 一个覆盖层面板）：
1. 页脚按钮（图标）打开/关闭覆盖层面板。
2. 面板内容：
   - 顶部：**远端地址**（SSH 别名）输入框 + 「添加」；主机切换（下拉或标签）
   - 主机行：名字 / 隧道状态（running/stopped/starting）/ 「启动隧道」「停止」「删除」
   - 远端会话列表：`GET /api/dsh-remote-gui/sessions?id=`，每行显示标题/时间/cwd/运行中标记
   - 下方：`<iframe>` 嵌远端 GUI，`src = host.seedUrl ?? http://127.0.0.1:<localPort>/`
3. 所有请求走同源 `/api/dsh-remote-gui/...`（本机 GUI 的 origin），不需要额外凭据。
4. 样式用内联 style + CSS 变量（`var(--dsw-alias-bg-base, #101014)` 之类），不引入外部 CSS。

可参考（同目录已安装的插件，只读参考）：
- `~/.dsh/profiles/desktop/node_modules/dsh-sev/lib/client.js`（侧栏入口 + 覆盖层 + iframe，已打补丁）
- `~/.dsh/profiles/desktop/node_modules/@linxin666/dsh-web-all/`（同族插件的插槽用法）
