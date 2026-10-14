> **这是什么**：客户端半边（`client.js`）的实现交接说明 —— 插槽注册方式、目标切换（本地实例 ↔ 远端隧道）、轮询矩阵，以及尚未验证的项。
> **读者**：维护 `client.js` 的人。宿主半边的接口契约见同目录的 [SPEC.md](./SPEC.md)。

# dsh-remote-gui · 客户端半边 —— 交接说明

文件：`client.js`（本目录）。**只写了这一个文件**，没有安装插件、没有改 profile、没有动 dsh-sev。

## 注册方式（宿主怎么加载它）

1. `package.json` 已声明 `exports["./client"] = "./client.js"` 与
   `dsh.client = { platform: "web", inject: [...] }` —— 宿主扫描到根行 `dsh-remote-gui`
   （见 `cordis.patch.yml`，行名必须是**裸包名**）后读 `dsh.client`，把本文件当浏览器侧模块提供。
2. 文件形态与 dsh-sev 的客户端一致：

   ```js
   window.__ModuleLoader__.load({ id: "dsh-remote-gui", factory: (require) => {
     var module = { exports: {} }; var exports = module.exports;
     var React = require("react");
     var ReactDOM = require("react-dom/client");
     ...
     module.exports = { apply: apply, inject: inject };
     return module.exports;
   }});
   ```

3. **本文件导出的 `inject`（当前实际值，已在并行修改中修正）**：

   ```js
   var inject = ["slots", "connection", "locale"];
   ```

   ⚠️ 这一行**已被改动过**（不是我最初写的值）：
   - 我按 SPEC 最初写成 `["slots", "connection", "locale", "betterSidebar"]`。
   - 随后被改为**去掉 `betterSidebar`**，并在文件 L48-51 留下理由注释：
     *「不要在这里加 betterSidebar —— 本机整套插件与 harness 本体都没有提供这个服务」*
     （应当是 grep 了 app.asar 与已装插件得到的结论）。
   - 结论：**以 `["slots", "connection", "locale"]` 为准**；`client.js` 里对 `ctx.betterSidebar`
     的用法（L690-712 那段 `registerTab`）是**带守卫的可选降级**，服务不存在时静默跳过，
     不会抛错也不会注册任何东西 —— 属于死代码但无害，要不要删由你定。
   - 也就是说：**SPEC 第 71 行写的 4 项 inject 与本机实际不符**，SPEC 那一处需要更新。

   ⚠️ 另外注意有**两个不同的 inject**，不要混淆（已对着 dsh-sev 核实过）：
   - `package.json` 的 `dsh.client.inject` —— **包级**声明，列出要预加载的客户端模块包名
     （dsh-sev 写 `@deepseek-ai/dsh-client-runtime / -connection / -ui-slots`；本包当前写 5 个，含 runtime）。
   - **本文件导出的 `inject`** —— 插件**运行时依赖的服务名**（见上）。
   - `exports["./client"]` 指向客户端文件（dsh-sev 是 `"./lib/client.js"`；本包是 `"./client.js"`）。
4. `apply(ctx)` 里两次 `ctx.effect(fn, label)`：
   - `ctx.slots.inject("sidebar.footer.action", …)` —— **页脚图标按钮的正规注册**（见下节）
   - `betterSidebar.registerTab(...)` —— **在当前 inject 下不会生效**（服务未被注入），
     属于带守卫的死代码（`if (!sidebar || typeof sidebar.registerTab !== "function") return undefined;`，
     外层还有 try/catch）。保留是为了"宿主哪天提供了这个服务就自动启用"。

## 我用到的 API 路径与字段（逐条对照 SPEC）

| 用途 | 方法 + 路径 | 请求字段 | 读取的响应字段 |
|---|---|---|---|
| 列主机 / 定时刷新 | `GET /api/dsh-remote-gui/hosts` | — | `hosts[]` → `id, alias, name, port, localPort, autoTunnel, tunnel{localPort,remotePort,alias,state,exitCode}, seedUrl` |
| 添加主机 | `POST /api/dsh-remote-gui/hosts` | `{ alias }` | `host`（失败读 `error`） |
| 删除主机 | `DELETE /api/dsh-remote-gui/host?id=` | query `id` | `ok`（失败读 `error`） |
| 启动 / 停止隧道 | `POST /api/dsh-remote-gui/tunnel` | `{ id, action: "start"｜"stop" }` | `tunnel`（失败读 `error`） |
| 远端会话列表 | `GET /api/dsh-remote-gui/sessions?id=` | query `id` | `sessions[]` → `sessionId, title, running, blank, updatedAt, cwd, turns` |
| 归档远端会话 | `POST /api/dsh-remote-gui/session-archive` | `{ id, sessionId }` | `ok, archivedSessionIds` |
| 取 iframe 种子地址 | `GET /api/dsh-remote-gui/seed?id=` | query `id` | `url` |
| 在线探测 | `GET /api/dsh-remote-gui/health?id=` | query `id` | `hostUp, status` |

**已与宿主半边 `lib/index.js` 逐条核对**：宿主用 `const BASE = '/api/dsh-remote-gui'` 拼出的 7 条路径
（`/hosts /host /tunnel /health /sessions /session-archive /seed`）与我上面用的完全一致；
宿主的 `GET /hosts` 也确实返回 `seedUrl`（`lib/index.js` L320-326）。宿主还多一条 `/proxy`，**客户端没有用**。

## 目标切换：本地实例 ↔ 远端（SSH 隧道）

面板顶部有「目标」选择器：`本地实例` + 每台已注册远端主机各一个 chip，右侧角标写清当前是哪一个
（`当前：本地实例` / `当前：远端 · <名字>`），会话区标题也随之写 `本地会话` / `远端会话`。
选择持久化在 `localStorage["dsh-remote-gui.target"]`。**默认目标：有远端主机就选第一台远端**
（2026-10-14 改；用户选过一次之后永远以那次为准，只有一台主机都没有时才落到「本地实例」）。
为什么改：默认本地会让下面的 iframe 用 `location.origin` 把**本实例嵌进本实例**，
用户看到的是「HARNESS / Loading plugins…」套娃，误以为面板卡死。

| | 本地实例 | 远端主机 |
|---|---|---|
| 会话来源 | `POST /api/session/list`（**相对路径**，`credentials: "same-origin"`） | `GET /api/dsh-remote-gui/sessions?id=`（宿主的隧道通道） |
| 信封 | `{type:"client-request", rpcId, method:"session/list", payload:{args:{_request:{}}}}` | 由宿主按同一信封代取 |
| 数据 | `result.value.items`，用 `mapSessionItem()` 映射 | 宿主已映射好的 `Session[]` |
| iframe src | **无**（2026-10-14 起不再嵌 `location.origin`；改显示提示文案） | `host.seedUrl` → `/seed` 现取 → `http://127.0.0.1:<隧道端口>/` |
| 归档按钮 | **不显示**（归档走宿主远端路由，本地分支不碰它） | 显示 |

> ⚠️ **归档的信封 key**（2026-10-14 修）：宿主 `workspace/archiveSession` 的形参名是 **`request`**，
> 不是 `session/list` 那样的 `_request`。插件原来的 `remoteRpc` 把 key 写死成 `_request`，
> 于是归档请求被远端判为 `gateway/arguments-invalid`
> （`missing "request"; unexpected "_request"`），**归档从未生效过**，界面上只表现为"点了没反应"。
> 现在 key 由 `lib/remote.js` 的 `ARGS_KEY_BY_METHOD` 按方法名决定，归档调用点再显式传
> `argsKey:'request'`；详情与全量核对结论见 `docs/SPEC.md` 的「远端契约」一节。

「本地实例」与「远端」共用同一套行渲染与同一个会话形状 —— `mapSessionItem()` 的字段与宿主半边
`lib/index.js` L431-439 的映射逐字一致（`sessionId` / `projections.values.title` / `running` /
`blank` / `updatedAt` / `cwd` / `projections.values.sessionStats.turns`）。

**CSS 已确认可嵌**：harness 的已认证响应里既没有 `X-Frame-Options` 也没有 CSP `frame-ancestors`
（父 agent 实测完整响应头），所以本地实例能安全地嵌进 iframe。

**目标被删除时的行为**：目标指向的主机不存在时，主机列表读完后自动回落到「本地实例」，
并把持久化值改掉（不会卡在空目标上）。主机列表**尚未读完**时不做这个判定 ——
避免开面板瞬间先嵌本地 iframe 再换成远端。

**轮询矩阵**（切换目标时不会有遗留轮询）：

| 轮询 | 何时跑 | 切走时的清理 |
|---|---|---|
| 本地会话（`/api/session/list`） | 仅当目标是「本地实例」且主机列表已读完 | effect 清理：`cancelled = true` + `clearInterval`（L385-388） |
| 远端会话（每台 running 主机） | 与目标无关（主机卡上要显示每台的会话数） | `clearInterval`（原有逻辑，未改） |
| 主机列表 / 健康检查 | 与目标无关 | `clearInterval`（原有逻辑，未改） |
| iframe | 当前目标 | iframe 的 `key` 里带目标（`local:<nonce>` / `<hostId>:<nonce>`）→ 切目标时 React **卸载旧 iframe** |

> 说明：远端会话轮询是"按主机"而不是"按目标"跑的（它喂主机卡上的 `N 个远端会话 · M 运行中`），
> 所以选中本地时它仍在跑 —— 这是刻意的、也不是"切换遗留"。如果你希望选中本地时完全停掉远端轮询，
> 说一声，把 `refreshSessions` 的 effect 也按 `!isLocalTarget` 门控即可（代价是主机卡不再显示会话数）。

## iframe 的 src（对 SPEC / 任务描述的一处「超集」实现，请留意）

任务里给的字面表达式是：

```js
src = host.seedUrl ?? 'http://127.0.0.1:' + host.tunnel.localPort + '/'
```

我实现成：

```js
frameSrc = activeHost.seedUrl
        || seedByHost[activeHostKey]                    // 宿主没给 seedUrl 时，用 GET /seed 现取一次
        || ("http://127.0.0.1:" + activeHost.tunnel.localPort + "/")
```

- `host.seedUrl` 优先 —— 与要求一致；宿主既然在 `/hosts` 里给了 `seedUrl`，**正常情况下不会走后面两支**。
- 中间那一支用的是 SPEC 里登记的 `GET /seed?id=` 路由，纯粹是"宿主没给 seedUrl"时的兜底，
  避免 iframe 落到没有 token 的裸地址（那会显示远端的 401 页面）。
- 如果你希望严格只有两支，把 `|| seedByHost[...]` 删掉即可（其余不受影响）。

## 页脚入口（已改为正规插槽注册；DOM 注入那套已整段删除）

页脚是一个 30×30 的图标按钮（`aria-label="远程 GUI"`、`aria-expanded` 跟随面板开合、
`data-dsh-remote-gui-entry` 作为稳定测试钩子），**已改成注册进正规插槽**：

```js
ctx.effect(function () {
  var disposedEntry = null;
  var disposeInject = ctx.slots.inject("sidebar.footer.action", function () {
    disposedEntry = ctx.slots.register({ name: "sidebar.footer.action", id: "dsh-remote-gui" }, FooterEntry);
    return function () { if (typeof disposedEntry === "function") disposedEntry(); };
  });
  return function () { /* 两个方向都清理 */ };
}, "dsh-remote-gui: footer entry");
```

依据（由父 agent 提供的已验证样本）：`@linxin666/dsh-remote-web-ui` 的客户端
`lib/client.js` L5489-5510 —— 它就用同一个插槽名 `sidebar.footer.action`，签名是
`ctx.slots.register(descriptor, Component)` 返回 disposer，`descriptor` 至少 `{ name, id }`
（`locale` 可选）。父 agent 今晚亲眼用过那个插件的页脚按钮，所以这条路径是活的。

**已删除的死代码**（grep 计数均为 0）：`NAV_ICON`、`FOOTER_SELECTORS`、
`findFooterHost`、`findSidebarColumn`、`placeEntry`、`mountFooterEntry`、`syncEntryActive`、
`MutationObserver`、所有 `querySelector`、以及「新会话」按钮兜底插入。

**`locale` 我没有传**：本插件没有注册 i18n 命名空间（UI 串直接写中文），描述符只给
`{ name, id }`。要接语言包的话补一个 `locale: "<命名空间>"` 即可。

**页脚组件对 `ctx` 的依赖：零**。`FooterEntry` 只用 React（`useState` / `useEffect`）和
模块内的 `toggleOverlay` / `overlayListeners`，不读任何 `ctx.*`。用到 `ctx` 的只有 `apply()`：
`ctx.effect`（两处）与 `ctx.slots`（`inject` + `register`）。因此 **`inject` 里有 `slots` 就够**
（`connection` / `locale` 目前是声明但未实际读取——留着以符合契约）。

## 我验证了什么 / 没验证什么

**已验证（可复核）**
- `node --check`（复制成 `.cjs` 后）：**退出码 0**，无语法错误。
- 模块契约要素齐全：`window.__ModuleLoader__.load` / `factory: (require)` /
  `require("react")` / `require("react-dom/client")` / `module.exports = { apply: apply, inject: inject }` /
  `inject` 数组字面量与本文件顶部一致。
- 7 条 API 路径与宿主半边字面量逐条一致（见上表）。
- 只用了内联 style + CSS 变量（`var(--dsw-alias-*, …)` / `var(--dsh-*, …)` 都带 fallback），
  文件里 **0 处** 外部样式表引用；没有 JSX（全部 `React.createElement`）。
- 页脚入口**不再依赖外层 DOM**：`FooterEntry` 区间内 `document.*` / `querySelector` /
  `MutationObserver` 命中数为 **0**（纯 React 元素 + 内联 style）；那些 DOM 注入的死代码已清空。
- 文件里仅剩的 DOM 调用（5 处 `document.createElement`）**全在未改动的 `toggleOverlay`** 里
  （覆盖层外壳，按要求没动）。
- **目标切换**：本地分支只打 `/api/session/list`（相对路径，全文 1 处，且**不是**宿主那 7 条之一）；
  宿主 7 条路由的计数与加功能前**完全一致**（hosts 3 / host 2 … 见上表），说明没有多用远端通道。
  `location.origin` 只有一处真实使用（**L562**，另一处在注释里）。旧的 `activeId` / `setActiveId` /
  `activeSessions` 残留为 **0**。

**没验证（需要把插件装起来、GUI 跑起来才能验）**
- **`mapSessionItem` 对本地实例真实返回值的适配**：本地分支的信封与远端同一份服务端代码（父 agent 已
  实测远端同形状），字段映射也照宿主半边 L431-439 逐字复刻，但"本地 `/api/session/list` 从 GUI 自己的
  origin 打是否一次就 200"我没法在没有运行 GUI 的情况下证。要看的：本地会话区是否列出会话、
  是否出现"读取本地会话失败：…"。
- **`localStorage` 持久化**：刷新后目标是否保持（隐私模式下会静默退回默认值，这是有意的）。
- `ctx.slots.inject("sidebar.footer.action", …)` 在本机宿主里的实际行为 —— 插槽名与签名来自
  父 agent 提供的、**已被真人用过**的 `@linxin666/dsh-remote-web-ui` 样本，但我没有运行环境可复现。
  具体要看的：`inject` 的返回值是否也是 disposer（我把两个方向的清理都做了，幂等）、
  以及 `locale` 缺省是否会被判为必填（若报错，补一个 `locale` 命名空间即可）。
- `betterSidebar.registerTab` 的实际签名/行为（服务未注入 → 现在是死代码，已 try/catch）。
- iframe 首次带 `?token=` 加载后，凭据 cookie 是否确实种进**宿主 Electron 会话**
  （这是整条链路唯一的架构性未知，SPEC 的 seedUrl 就是为它设计的）。
- 定时轮询的实际开销：`GET /hosts` 在宿主里会对每台 running 主机做一次 `withSeed`
  （可能含一次 ssh 读 token）。客户端按 12s 轮询 hosts、8s 轮询 sessions、5s 轮询 health；
  如果宿主那边 `withSeed` 不做缓存，这里会偏吵 —— 建议宿主把 token 缓存住（dsh-sev 就是缓存的）。

## 我**没有**做的（按 SPEC 的「客户端半边」一节收了口，等你决定）

- SPEC 开头那句"并把远端会话列进侧栏"——侧栏里那份**常驻会话列表**（dsh-sev 的
  `mountRemoteSessionsSection`）**没有实现**，因为「客户端半边」小节枚举的 UI 只有
  "页脚入口 + 覆盖层面板"，而面板里已经含"远端会话列表"。要侧栏常驻列表的话说一声，我照着加。
- `settings.section` 设置页区块（dsh-sev 有）也没做 —— SPEC 没要求。

## 冒烟测试建议（装好之后）

1. 页脚出现「远程 GUI」图标 → 点开覆盖层。
2. **默认应是「本地实例」**：角标显示 `当前：本地实例`，会话区标题 `本地会话`，
   下面 iframe 里是本机这个 DSH（不是 401、不是空白）。
3. 点「远端」chip（或先填 SSH 别名 `100.69.133.94` → 添加）→ 角标变 `当前：远端 · <名字>`，
   会话区变 `远端会话`。
4. 卡片状态从 `连接中` → `已连接`；同一行显示 `远端 :3080 → 本地 :56xx` 与 `· 在线`。
5. 「远端会话」区应列出远端会话（标题/相对时间/cwd/运行中标记 + 归档按钮）。
6. 下方 iframe 应加载出远端 GUI（不是 `dsh web authentication required`）。
   如果是 401 页面，说明 seedUrl 那次带 token 的加载没把 cookie 种进 Electron 会话 —— 回来告诉我。
7. **来回切换** 本地 ↔ 远端：iframe 每次都应整块重载成对应实例（旧的不该留在后台），
   且切回本地后远端轮询不受影响、本地列表照常刷新。刷新页面后目标应保持上次选择。
8. 排错用：删掉目标主机那台，面板应自动回落成 `当前：本地实例`。
