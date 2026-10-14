# 官方 Discussions 发帖草稿（照 [Plugin Category Guidelines #2004] 的模板）

**目标分类**：`🙌 Show Your Plugins!`（https://github.com/deepseek-ai/deepseek-harness/discussions/categories/show-your-plugins）

**官方硬性要求**（来自置顶帖 #2004，逐条对照）：
- 标题格式固定：`DSH | 项目名称 | 一句话说明用途`
- 正文必须包含：项目地址、简短介绍、**截图**、以及**与 DSH 的集成方式**
- 必须显著注明这是**非官方**项目
- 一个主题只介绍一个项目
- ⚠️ **截图是必需项** → 必须等插件在应用里跑起来之后拍（用户来拍，因为只有他能看到应用界面）

---

## 标题

```
DSH | dsh-remote-gui | 在本地 DSH 窗口里操作远端那台（SSH 隧道 + 内嵌 GUI + 本地/远端切换）
```

## 正文

> 非官方项目，由社区成员独立开发和维护。

**项目地址：**
https://github.com/temotee2103/dsh-remote-gui

**项目介绍：**

把 DSH 跑在 VPS 上（7×24、挂 WhatsApp）之后，在电脑上用它通常只剩两条路：开浏览器标签访问远端地址，或者开两个窗口各用各的。这个插件做了第三条 —— **一个窗口，多个实例**。

- 侧栏页脚一个入口 → 面板里是**远端那台 DSH 的真实界面**（iframe，直连 SSH 隧道）
- 面板同时列出**远端会话**，点开就能看
- 顶部在 **本地实例** 和**任意一台远端**之间切换：同一套界面，换的是"在跟谁说话"

也就是 OpenClaw 的 Remote Access 里 *Chat UI over SSH* 那种形态、以及 Hermes 桌面端通过 SSH 连远端实例的做法，把这个形态带给 DSH。

**与 DSH 的集成方式：**

- 宿主半边注册 `/api/dsh-remote-gui/*` 路由族（只允许 loopback），负责主机注册表、SSH 隧道生命周期（看门狗重连、重启收养）、以及**远端凭据的自动兑换**
- 客户端半边用 `ctx.slots.inject('sidebar.footer.action')` 注册页脚入口，面板是原生 React 组件
- 远端请求按 0.2.x 的真实契约走：`POST /api/<ns>/<method>`，`payload.args._request` 信封，数据在 `result.value`；每个请求都要带远端按 authority 绑定的浏览器 cookie（由远端 `dsh web` 的启动 token 经隧道兑换），插件自动缓存并在 401 时刷新
- 面板里的 iframe 首次加载用**带 token 的 seedUrl**：那一次 303 会把凭据 cookie 种进浏览器，之后长期可用
- 另注册 agent 工具 `remote_gui_run_task`：经 `ssh + dsh --profile headless` 在远端跑一次性任务

**为什么不用 dsh-sev：** 它是按 DSH 0.1.x 写的，在 `0.2.0-rc.2` 上实测四个缺陷让核心功能不可用 —— 服务端请求不带远端凭据（一律 401）、RPC 信封过时（404/`gateway/bad-request`）、`output.render` 返回字符串（`content.some is not a function`）、客户端 `inject` 里列了不存在的服务 `betterSidebar`（导致整个客户端半边不激活）。本插件用 0.2.x 的契约独立实现，不依赖它。

**截图：** ← 重启后补（面板总览、远端会话列表、iframe 里的远端 GUI、本地/远端切换）

---

## 待确认/待办（发帖前）

1. 等插件在应用里跑通并拍好截图（必需项）。
2. 帖子发出前给用户过一遍。发帖用 `gh` 或 API 都需要 `discussions` 权限的 token（PAT 勾 `write:discussion`，或用 gh 的 OAuth）。
3. 若维护者更希望这类内容只走 awesome-dsh-plugin 目录，则不发帖、只提 PR。
