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
                 "payload":{"args":{"<参数名>":{…params…}}}}
          响应：{"type":"server-response","rpcId":"…","result":{"ok":true,"value":…}}
          失败：result.ok=false，result.error={code,message,details}
          ⚠️ 校验失败仍是 **HTTP 200**，只有 body 里 ok=false（别用 HTTP 状态判成功）
          ⚠️ endpoint 必须真实存在：未注册的方法回 HTTP 404 "not found"
          ⚠️ method 与 endpoint 必须一致（都用斜杠形式）

会话列表：/api/session/list   `_request` = {}   → result.value.items[]
读会话正文：/api/session/page  `request` =
              {address:{kind:'session',sessionId}, throughSeq:<≤该会话 cursor>, maxMessages:N, beforeSeq?}
            → result.value = {records:[{type:'event',event:{…}}], hasMore}
            ⚠️ throughSeq 超过 cursor 会被拒：
               gateway/bad-request: session page through seq N is past cursor M
            cursor 从 /api/session/projections（`request`={sessionId}）的 asOfSeq 拿
发一条消息：/api/session/prompt  `request` =
              {requestId, sessionId, mode:'queue'|'steer', content:[{type:'text',text}]}
            ⚠️ **会真的花钱**（远端跑一轮模型）。空 content 会被远端在解析 Agent/写会话事件之前拒掉：
               gateway/bad-request: prompt content must include non-whitespace text or an attachment
               —— 这条正是"零费用链路探针"（本插件路由的 `{probe:true}`）
新建会话：/api/session/create  `request` = {sessionId?, cwd?, agentPreset?}
            → result.value = {sessionId, agentPreset}（不传 sessionId 时由远端生成）
流式（本插件未用）：session/follow、session/control、workspace/follow 是 `mode:'stream'`，
            一元 POST 会被拒：gateway/signature-invalid:
            "stream Remote methods must be opened through the stream carrier"
            ⇒ 真流式必须开远端网关 WebSocket `/api/remote.mux`（2026-10-14 实测可通：
               `new WebSocket('ws://127.0.0.1:<port>/api/remote.mux')`，带 cookie + Origin，
               发 `{type:'open',streamId,endpoint:'session/follow',payload:{args:{request:{…}}}}`
               即收到 `{type:'item',…}`）。本插件当前用**轮询**（见客户端一节的说明）。

远端启动 token：ssh <alias> journalctl --user -u dsh-web -n 400 --no-pager | grep -oE 'token=…' | tail -1

⚠️ args 的 key 是**宿主方法的形参名**，不是固定字符串（这里以前写成"必须有 _request"，
   是错的，并误导了实现：归档会话因此静默失败过）。判定依据在安装目录的 typert 描述符里：
     resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-api-<ns>-controller/lib/typert.host.js
     → invocations[].parameters[].{ name, wire }   ← 这两个字段就是 key
   已知（2026-10-14 全量核对 26 个 typert.host.js / 140 条 invocation）：
     · session/list              → `_request`（**唯一**用下划线前缀的方法）
     · workspace/archiveSession  → `request`
     · 其余 session/*（create/projections/page/follow/prompt/rename/cancel/search/selectModel/updateQueue…）、
       workspace/*（create/delete/rename/pinSession/unpinSession/unarchiveSession…）、
       schedule/*、job/*、messageFeedback/*、skills/list … → 全是 `request`
   用错 key 的症状：result.ok=false，
     error.code='gateway/arguments-invalid'，
     error.message='… args fields do not match the descriptor: missing "request"; unexpected "_request"'
   写新调用前先读对应 controller 的 typert.host.js；实现里的登记表在 lib/remote.js 的
   ARGS_KEY_BY_METHOD（remoteRpc 的 argsKey 选项可覆盖）。

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
| GET | `/api/dsh-remote-gui/session-page?id=&sessionId=&throughSeq=&maxMessages=&beforeSeq=` | — | `{records:[…], hasMore}` |
| GET | `/api/dsh-remote-gui/session-projection?id=&sessionId=` | — | `{projection}` |
| POST | `/api/dsh-remote-gui/session-prompt` | `{id, sessionId, text, mode?, probe?}` | `{ok:true, requestId, value}` ⚠️花钱 |
| POST | `/api/dsh-remote-gui/session-create` | `{id, cwd?, sessionId?, agentPreset?}` | `{ok:true, sessionId, agentPreset}` |
| GET | `/api/dsh-remote-gui/seed?id=` | — | `{url:string}` |
| GET | `/api/dsh-remote-gui/health?id=` | — | `{id, tunnel, hostUp, status}` |

```
Host    = { id, alias, name, port, localPort, autoTunnel, tunnel?:Tunnel, seedUrl?:string }
Tunnel  = { localPort, remotePort, alias, state:'starting'|'running'|'stopped', exitCode:number|null }
Session = { sessionId, title:string|null, running:boolean, blank:boolean,
            updatedAt:number, cwd:string|null, turns:number|null,
            parentSessionId:string|null, origin:'subagent'|null }
```

要点：
- 主机注册表持久化在 `$DSH_HOME/remote-gui-hosts.json`。
- 隧道：spawn `ssh -L <localPort>:127.0.0.1:<port> <alias> -N -o ExitOnForwardFailure=yes …`；
  自动重连（看门狗定时扫描 autoTunnel 主机）；本机重启后收养已存在的隧道（先 connect 探测端口）。
- **凭据**：`remoteCookieHeader(host, tunnel)` —— ssh 读启动 token → 经隧道兑换 → 按 host 缓存；
  收到 401/403 时强制刷新并重试一次。
- **seedUrl**：带 token 的 `http://127.0.0.1:<localPort>/?token=<token>`（`GET /seed` 也会现取一次）。
  它是"让浏览器把远端凭据 cookie 种进去"的入口。**客户端半边现在不再嵌 iframe**，
  所以这个地址只对"想在浏览器里单独打开远端 GUI"的场景有意义；原生面板不需要它
  （面板的每个请求都由宿主半边带 cookie 转发）。
- 端口分配从 5636 起自增，避开 dsh-sev 的默认端口。
- 会话列表走 `/api/session/list`，`_request = {}`，读 `result.value.items`。
- agent 工具 `remote_gui_run_task`：ssh + `dsh --profile headless` 跑一次性任务；
  `output.render` 必须返回 **ContentBlock 数组**（0.2.x 契约）。

## 客户端半边（client.js）

`window.__ModuleLoader__.load({ id:'dsh-remote-gui', factory })`，导出 `{ apply, inject }`，
`inject = ['slots','layout','connection','locale']`。

> ⚠️ **用到哪个服务就必须在 `inject` 里声明**：cordis 的服务代理在未声明时会抛
> `cannot get property "layout" without inject`。2026-10-14 实测踩到：面板能打开，
> 但 ✕ / Esc 全部静默失效 —— 因为 `closePanel()` 里的 `ctx.layout` 抛错，又被 `try/catch` 吞了。
> 所以 `layout` 必须列进去（它由 ui-layout 提供，而 `sidebar.panellist` / `main`
> 这两个座位本来就由 ui-layout + ui-sidebar 声明）。
>
> ⚠️ 反过来，**不要往 inject 里加不存在的服务**。本机整套已装插件与 harness 本体（app.asar 命中 0 次）
> 都没有注册 `betterSidebar`；cordis 的 `inject` 是**必需**依赖，列一个永不出现的服务会让整个客户端半边
> 永远不激活 —— 面板根本不会出现（这也是 dsh-sev 在本机不可用的第三个原因）。
> 代码里对 `ctx.betterSidebar` 的用法保留为带 `typeof` 守卫 + `try/catch` 的可选增强。

UI：**中心列的原生面板**（与 `@linxin666/dsh-task-board`、`@linxin666/dsh-ssh` 同一形态），
**没有 iframe、没有覆盖层、没有遮罩、没有滚动锁**：

1. `ctx.slots.inject('sidebar.panellist', …)` 注册侧栏图标行，`id = 'dsh-remote-gui'`；
2. `ctx.slots.inject('main', …)` 注册中心列页面，`key = 'dsh-remote-gui'`
   —— **两处必须是同一个字符串**（sidebar 那一行就是靠这个 id 去寻址 main 的 key）；
3. `ctx.slots.inject('sidebar.footer.action', …)` 保留页脚小入口，点它 = `ctx.layout.selectPanel('dsh-remote-gui')`；
4. 关闭 = `ctx.layout.selectPanel('conversation')`（✕ / Esc）。
   面板只占据中心列，**左侧栏照旧可见可用**；切走时组件就地卸载，不残留任何 DOM 或样式。
   Esc 的唯一例外是焦点在**草稿输入框**里（先让它失焦，别把打了一半的内容连面板一起关掉）；
   在过滤框/按钮/列表行上按 Esc 一律关闭（第一版写成"焦点在 input 里就不关"，结果在过滤框里
   按 Esc 完全没反应 —— 那是缺陷不是保护）。
5. 面板内容：
   - 顶部：SSH 别名输入框 + 「添加」；主机 chips（状态点/隧道连接/删除主机）+ 「✕ 关闭」
   - 左列：远端会话列表（`GET /sessions`）＋ 过滤框（标题/路径/会话 id），点一行 → 读正文；
     「＋ 新建」= `POST /session-create`；行内「归档」只在悬停或选中时出现
   - 右列：对话正文（`GET /session-page`，把 `records[].event` 渲染成 用户 / 助手 / 工具卡）
     + 输入框 + 「发送到远端」（`POST /session-prompt`）
     + 「RPC 探针（0 费用）」= `POST /session-prompt {probe:true}`，给远端发空 content，
       远端在调模型之前拒掉 → 用来验证链路而不产生任何费用
6. **花钱的动作一律两步确认**（面板内，不用 `window.confirm`）：
   「发送到远端」第一下只把按钮变成「确认发送（会花钱）」（5 秒内不确认自动解除，草稿不丢），
   第二下才真的调 `session/prompt`；「归档」「删除主机」同理。
   不用 `window.confirm` 的原因：它是模态原生对话框，**会阻塞页面**
   （实测：自动化点击卡在 dialog 上 30 秒超时），样式也不受主题控制。
   除此之外没有任何自动重试、自动补发；Ctrl/Cmd+Enter 也走同一条两步确认。
7. 刷新是**轮询**：打开一条会话后每 3 秒先读 `session/projection` 拿 `asOfSeq`，
   只有 cursor 前进了才拉 `session/page`（避免重复拉整页，也避免踩 "past cursor" 报错）。
   界面上如实写着"轮询刷新 · 每 3 秒"，**不假装是实时流**；真流式要开远端
   `/api/remote.mux` WebSocket（本节上面的契约里有实测记录），是后续工作。
8. **归档的显示是"本机视图过滤"，不是远端权威状态**：
   远端 `session/list` 的条目里**没有归档字段**，真正的归档状态在 `workspace/*` 那条**流式**通道里。
   所以归档 RPC 成功之后，那一行还会被远端列表重新列出来 —— 看起来像"点了没反应"。
   本插件把"我归档过哪些"记在浏览器 `localStorage['dsh-remote-gui.archived']`，
   默认隐藏这些行，并提供「显示已归档 N」勾选框可以调回来。界面上写明是**本机记录**。
8b. **主会话 / 子会话折叠（2026-10-14 加）**：`session/list` 的条目里**有权威判据**
   —— `parentSessionId`（由哪条会话派生）与 `origin:'subagent'`（宿主标的子代理来源），
   见 `@deepseek-ai/dsh-api-session-controller/lib/types/list.js` 的 `listFields()`。
   ⚠️ 宿主半边曾经只挑 title/cwd/running/blank/updatedAt/turns，把这两个字段**丢掉**了
   （旧版 SPEC 在这里写"keys 只有 sessionId/updatedAt/agentAvailable/running/blank/cwd/projections"，
   **那个结论是错的**，已按真机实测更正）。丢掉判据的后果：面板是平铺列表，
   346 条里 317 条是子代理会话，真正的主会话被埋掉。
   现在默认「只显示主会话」（选择记在 `localStorage['dsh-remote-gui.subagents']`，`all`/`roots`），
   列表头给出一行「已隐藏 N 条子会话 · 显示全部」可一键切回。
   规则是**两段**、且界面如实分开说明（纯函数 `classifySession` / `selectVisibleSessions`，有单测）：
   - 权威段：`parentSessionId` 非空 或 `origin === 'subagent'`（实测 346 条里 317 条，两字段同时出现）；
   - 启发式段：id **不是**宿主生成的 `session-<uuid>` 形状 **且** 无标题、无轮次、`blank` 的空壳会话
     （`session/create` 允许调用方自带 id，而那种会话在字段上与主会话同形；实测这一类就是
     `probe-route-*` / `probe-archive-*` / `session-probe-*` 那批探针）。
     代价写在这里：真有人用自带 id 建一条正经会话、且它当时还是空的，会被折叠；
     但发出第一条消息（turns>0 / blank=false）后立刻重新出现。
   过滤只影响**显示**：归档、读正文、发送、新建都不碰；**正被打开的那条会话永不折叠**。

9. 所有请求走同源 `/api/dsh-remote-gui/...`（本机 GUI 的 origin），不需要额外凭据。
10. 样式用内联 style + CSS 变量，不引入外部 CSS。**前景色一律 `inherit`、层次用 `opacity`**，
    只有强调色写死 —— 避免"背景取主题变量 + 前景写死白"在浅色主题下变成隐形文字（曾经踩过）。

可参考（同目录已安装的插件，只读参考）：
- `~/.dsh/profiles/desktop/node_modules/@linxin666/dsh-client-ui-task-board/src/client/native-panel.tsx`
  （原生面板的插槽用法，本插件形态的来源）
- `~/.dsh/profiles/desktop/node_modules/@linxin666/dsh-ssh/src/client/native-panel.tsx`（同上）
- `~/.dsh/profiles/desktop/node_modules/dsh-sev/lib/client.js`（旧形态：侧栏入口 + 覆盖层 + iframe，**已被否掉**）
