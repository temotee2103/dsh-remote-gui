# dsh-remote-gui

**在本地 DSH 窗口里，直接操作远端那台 DSH。** 通过 SSH 隧道把远端 GUI 嵌进本地界面，
把远端会话列进面板，并在 **本地实例 ↔ 远端** 之间一键切换。

**Embed a remote DeepSeek Harness GUI in your local DSH window over an SSH tunnel,
list the remote sessions, and switch between the local instance and any remote host.**

> English version: [README.en.md](README.en.md)

---

## 这个插件解决什么

把 DSH 跑在 VPS 上是常见的做法：7×24 不关机、能挂 IM 插件（WhatsApp / Telegram…）、
手机随时能用。但**在电脑上用它**通常只剩两条路：开一个浏览器标签去访问远端地址，
或者干脆开两个窗口各用各的。

`dsh-remote-gui` 把第三条路做出来：**一个窗口，多个实例**。

- 侧栏页脚一个入口 → 面板里是**远端那台 DSH 的真实界面**（不是截图、不是只读视图）
- 面板同时列出**远端会话**，点开就能看
- 顶部在 **本地实例** 和 **任意一台远端** 之间切换 —— 同一套界面，换的是"在跟谁说话"

### 为什么不是 dsh-sev

`dsh-sev` 是最接近的既有插件（SSH 隧道 + 面板内 GUI），但它是按 **DSH 0.1.x** 写的，
在 `0.2.0-rc.2` 上三个缺陷让它的核心功能不可用（实测）：

| 缺陷 | 现象 |
|---|---|
| 服务端替你去请求远端，但**不带远端浏览器凭据 cookie** | 一切远端请求 401：`SyntaxError: Unexpected token 'u', "unauthorized" is not valid JSON` |
| RPC **信封过时**（`/api/session.list` + `method:"session.list"` + `payload:{}`） | `404 not found`；改对路径后是 `gateway/bad-request` |
| `output.render` 返回**字符串**（0.2.x 要求 ContentBlock 数组） | agent 侧报 `content.some is not a function` |

（还有第四个：它的客户端 `inject` 里列了本机**不存在**的服务 `betterSidebar`，
而 cordis 的 `inject` 是必需依赖 —— 列一个永不出现的服务会让整个客户端半边不激活，
面板根本不会出现。）

本插件是用 0.2.x 的真实契约**独立实现**的，不依赖 dsh-sev，因此也不受它升级影响。

---

## 功能

| 功能 | 说明 |
|---|---|
| **SSH 隧道管理** | `ssh -L <本地端口>:127.0.0.1:<远端端口> <别名>`；看门狗每 15s 检查并按需重连；本机重启后自动"收养"还在监听的隧道，不重复起 |
| **远端凭据自动兑换** | 远端 `dsh web` 每个 `/api` 都要求按 authority 绑定的浏览器 cookie。插件用 ssh 读远端的启动 token，经隧道换一次 cookie 并按主机缓存，收到 401/403 自动刷新重试 |
| **远端会话列表** | 走 `/api/session/list`（typert 信封），显示标题 / 最后活动 / cwd / 运行中 |
| **面板内嵌远端 GUI** | iframe 直连隧道地址。首次加载用**带 token 的 seedUrl**：那一次 303 会把凭据 cookie 种进浏览器，之后长期可用 |
| **本地 ↔ 远端切换** | 顶部一个选择器：`本地实例` 或任意已注册远端。本地模式走同源 `/api/session/list`，iframe 指向 `location.origin` |
| **会话归档** | 在面板里把远端会话归档掉（走 `workspace/archiveSession`） |
| **agent 工具 `remote_gui_run_task`** | 让本地 agent 通过 `ssh + dsh --profile headless` 在远端跑一次性任务并把结果带回来 |
| **诊断路由** | `/health`（隧道 + 远端可达性）、`/proxy`（透传任意远端路径） |

**边界**：远端需要跑着 `dsh --profile web`，且其 systemd 用户单元名为 `dsh-web`
（读启动 token 的命令依赖它；换名字改 `lib/index.js` 的 `remoteLaunchToken()`）。
本地端口从 5640 起分配（避开 dsh-sev 的 5636）。

---

## 安装

```sh
dsh plugin --profile desktop add dsh-remote-gui
```

从 GitHub 装（未发 npm 时）：

```sh
dsh plugin --profile desktop add github:temotee2103/dsh-remote-gui
```

**宿主半边改完必须重启 DSH**（Node 的 ESM 缓存持有宿主模块）。客户端半边是热加载的。

---

## 用法

1. 侧栏**页脚**出现一个「远程」图标 → 点开面板
2. 填 **SSH 别名**（要在 `~/.ssh/config` 里配好，例如 `my-vps` 或 `100.69.133.94`）→ 添加
3. 主机行会从 `连接中` 变成 `已连接`；远端会话列表出现
4. 顶部切换 **本地实例 / 远端**；远端模式下 iframe 里就是那台机器的完整 GUI，可以直接在里面打字、点按钮

---

## 像 Hermes Agent / OpenClaw 那样用

这两个产品的共同形态是：**agent 跑在某台机器上，你在另一台机器上用完整界面控制它**。

- **OpenClaw** 的 Remote Access 文档里有一节就是 *Chat UI over SSH* ——
  把 gateway 留在远端，本地通过 SSH 用它的 Chat UI
  （[docs.openclaw.ai/gateway/remote](https://docs.openclaw.ai/gateway/remote)）。
- **Hermes Agent** 的桌面端同样支持通过 SSH 连到远端实例。

`dsh-remote-gui` 把同样的形态带给 DSH：

| 角色 | 在 DSH 上怎么落地 |
|---|---|
| **控制台**（你手边这台） | 本地 DSH Desktop —— 你日常用、看得见的那个窗口 |
| **长驻执行体**（VPS / 家里的机器 / 云主机） | 远端 `dsh web`（systemd 常驻）+ 挂 IM 插件 |
| **两者之间的通道** | SSH（本插件自动维护隧道与凭据） |

于是可以做这几件以前要开好几个窗口的事：

- **一台控制台管 N 台**：把开发机、VPS、家里的迷你主机都注册进来，顶部切换即可，
  不用再记每个实例的地址、端口和 token
- **远端跑长的、本地看短的**：让远端挂着爬取 / 构建 / 定时任务，你在同一个窗口里
  顺手看它的会话，不用切窗口
- **随时接管**：远端 agent 卡住了，切过去直接在那个 iframe 里操作 —— 那是真界面，不是回放

---

## 和其它插件配合

| 配合对象 | 怎么配合 |
|---|---|
| **IM 插件**（`@xmanrui/dsh-im` 的 WhatsApp、Telegram 等） | **装在远端**。远端 7×24 接消息、自动回复；本地面板嵌着远端 GUI，于是**手机上的对话和你眼前的界面是同一个会话** —— 要接管、要改 prompt、要看它调了什么工具，直接在面板里操作 |
| **`dsh-remote-web-ui`**（扫码配对 + 手机适配） | 互补：那个给**手机/平板**（配对后竖屏适配层），这个给**桌面**（SSH 隧道 + 面板）。两个装同一台远端并不冲突 |
| **`@linxin666/dsh-ssh`** | 互补：那个给的是 **Web 终端 / SFTP / 端口转发**（"我要在远端敲命令"），这个给的是 **把远端 GUI 嵌进来 + 列远端会话**（"我要在远端用 DSH"）。端口段与路由都不同 |
| **`dsh-task-board`** | 远端装它 → 定时/子任务在远端跑；本地通过面板看远处那块看板 |
| 任何**只装在远端**的插件 | 都自动变得可用 —— 因为这个面板给的是远端的完整界面，不是本插件翻译过的子集 |

---

## 远端契约（0.2.x，全部实测）

```
兑换凭据   GET http://127.0.0.1:<隧道端口>/?token=<远端启动 token>
           → 303 + Set-Cookie: dsh-auth-<authority哈希>=<签名值>
           cookie 按 authority 绑定；远端重启后 cookie 仍有效（token 会变）

RPC        POST http://127.0.0.1:<隧道端口>/api/<ns>/<method>
           cookie: dsh-auth-…                      ← 必须，否则 401 "unauthorized"
           body: {"type":"client-request","rpcId":"…","method":"<ns>/<method>",
                  "payload":{"args":{"<参数名>":{…params…}}}}
           数据在 result.value；method 必须与 endpoint 完全一致（斜杠形式）

会话列表   /api/session/list，_request = {}   →   result.value.items[]
归档会话   /api/workspace/archiveSession，request = {sessionId}  →  result.value.archivedSessionIds[]

远端启动 token
           ssh <alias> journalctl --user -u dsh-web -n 400 --no-pager \
             | grep -oE 'token=[A-Za-z0-9_-]+' | tail -1 | cut -d= -f2
```

四条容易踩的：

1. `method` 用**斜杠**形式（`session/list`），与 URL 末段一致；写成 `session.list` 会被拒：
   `method "session.list" does not match endpoint "session/list"`。
2. `payload` 必须是 `{"args":{…}}` —— 少一层就是
   `Remote payload must contain exactly one plain-object args field`。
3. ⚠️ **args 里那个 key 是"宿主方法的形参名"，不是固定字符串。** 曾经把这条写成"必须有
   `_request`"，结果归档会话静默失败。判定依据是安装目录里的 typert 描述符：
   `resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-api-<ns>-controller/lib/typert.host.js`
   的 `invocations[].parameters[].{name,wire}`。实测（2026-10-14，26 个 typert.host.js / 140 条
   invocation 全量核对）：`session/list` 是 `_request`（**唯一**带下划线的方法），
   `workspace/archiveSession` 与其余 `session/*` / `workspace/*` / `schedule/*` / `job/*` 等全是 `request`。
   用错的表现是 `result.ok=false` + `error.code='gateway/arguments-invalid'` +
   `missing "request"; unexpected "_request"`。插件里的登记表：`lib/remote.js` 的 `ARGS_KEY_BY_METHOD`。
4. **iframe 是浏览器自己发请求**，所以"把凭据 cookie 种进浏览器"这一步不能省 ——
   这就是 seedUrl 存在的理由（服务端拿不到浏览器那次请求的 cookie）。

---

## 路由（全部只允许 loopback，非 loopback 一律 403）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/dsh-remote-gui/hosts` | 主机列表（含 `tunnel`、`seedUrl`） |
| POST | `/api/dsh-remote-gui/hosts` | `{alias, name?, port?, localPort?, autoTunnel?}` |
| DELETE | `/api/dsh-remote-gui/host?id=` | 删除主机并停隧道 |
| POST | `/api/dsh-remote-gui/tunnel` | `{id, action:'start'\|'stop'}` |
| GET | `/api/dsh-remote-gui/sessions?id=` | 远端会话列表 |
| POST | `/api/dsh-remote-gui/session-archive` | `{id, sessionId}` |
| GET | `/api/dsh-remote-gui/seed?id=` | 带 token 的 iframe 入口地址 |
| GET | `/api/dsh-remote-gui/health?id=` | 隧道 + 远端可达性 |
| GET | `/api/dsh-remote-gui/proxy?id=&path=` | 透传远端路径（诊断用） |

主机注册表：`$DSH_HOME/remote-gui-hosts.json`。

---

## 验证记录

宿主半边用**独立进程加载 + 真实隧道 + 真实远端**直接调用它的路由处理器
（不依赖应用重启，见 [`docs/SPEC.md`](docs/SPEC.md) 的复现方式）：

```
隧道      1 秒起好 state=running                                   ✓
hosts     seedUrl=http://127.0.0.1:<端口>/?token=…                 ✓
sessions  HTTP 200 / 337 个远端会话                                ✓
health    HTTP 200 status=200                                      ✓
seed      HTTP 200 + 带 token 的地址                               ✓
非 loopback 请求 → 403 被拒                                        ✓
工具 render 返回 ContentBlock 数组（0.2.x 契约）                    ✓
```

客户端半边用桩 window/document/react 在 Node 里加载并调用 `apply(ctx)`：
模块加载无异常、`inject` 正确、注册进真实插槽 `sidebar.footer.action`。

未知项（诚实列出）：iframe 里的远端 GUI **需要浏览器允许同站 iframe** ——
harness 的已认证响应里既没有 `X-Frame-Options` 也没有 CSP `frame-ancestors`（实测），
所以这一层没问题；剩下的是宿主 Electron 会话是否会把那次 seed 的 cookie 存下 —— 
若你遇到 iframe 里显示 `dsh web authentication required`，告诉我，改用"隐藏 iframe 预热"的办法。

---

## License

MIT
