# 官方 Discussions 帖 —— 可直接粘贴的成品

> 用法：打开 https://github.com/deepseek-ai/deepseek-harness/discussions/new?category=show-your-plugins
> （或 Discussions 页 → `🙌 Show Your Plugins!` → New discussion）
> 标题粘下面第一段；正文从分隔线后粘到结尾。**截图**在我抓完之后补进「截图」那一节。

**分类**：`🙌 Show Your Plugins!`（categoryId `DIC_kwDOT3T1g84DDSUe`）
**标题（整行复制）**：

```
DSH | dsh-remote-gui | 在本地 DSH 窗口里操作远端那台（SSH 隧道 + 内嵌 GUI + 本地/远端切换）
```

---

> 非官方项目，由社区成员独立开发和维护。

**项目地址：**
https://github.com/temotee2103/dsh-remote-gui

**项目介绍：**

把 DSH 跑在 VPS 上（7×24、挂 WhatsApp）之后，在电脑上用它通常只剩两条路：开浏览器标签访问远端地址，或者开两个窗口各用各的。这个插件做了第三条 —— **一个窗口，多个实例**。

- 侧栏页脚一个入口 → 面板里是**远端那台 DSH 的真实界面**（iframe，直连 SSH 隧道）
- 面板同时列出**远端会话**，点开就能看
- 顶部在 **本地实例** 和**任意一台远端**之间切换：同一套界面，换的是"在跟谁说话"

也就是 OpenClaw 的 Remote Access 文档里 *Chat UI over SSH* 那种形态、以及 Hermes 桌面端通过 SSH 连远端实例的做法，把这个形态带给 DSH。

**与 DSH 的集成方式：**

- 宿主半边注册 `/api/dsh-remote-gui/*` 路由族（8 个不同路径、只允许 loopback），负责主机注册表、SSH 隧道生命周期（15 秒看门狗重连、重启后收养仍在监听的隧道），以及**远端凭据的自动兑换**
- 客户端半边用 `ctx.slots.inject('sidebar.footer.action')` 注册页脚入口，面板是原生 React 组件
- 远端请求按 0.2.x 的真实契约走：`POST /api/<ns>/<method>`、`payload.args._request` 信封、数据在 `result.value`；每个请求都带远端按 authority 绑定的浏览器 cookie（由远端 `dsh web` 的启动 token 经隧道兑换而成），插件按主机缓存并在收到 401/403 时刷新重试一次
- 面板里的 iframe 首次加载使用**带 token 的 seedUrl**：那一次 303 会把凭据 cookie 种进浏览器，之后长期可用
- 另注册 agent 工具 `remote_gui_run_task`：经 `ssh + dsh --profile headless` 在远端跑一次性任务并把结果带回来
- 仓库里有一份 `docs/SPEC.md`，把上面这套实测契约（含三个易踩点）逐条记下来了

**为什么不是 dsh-sev：** 它是按 DSH 0.1.x 写的，在 `0.2.0-rc.2` 上实测有四个缺陷让核心功能不可用 —— 服务端替用户请求远端时**不带远端凭据**（一律 401，报 `SyntaxError: Unexpected token 'u', "unauthorized" is not valid JSON`）、RPC **信封过时**（`/api/session.list` + `method:"session.list"` + `payload:{}` → 404 / `gateway/bad-request`）、`output.render` **返回字符串**（0.2.x 要 ContentBlock 数组 → `content.some is not a function`）、客户端 `inject` 里列了本机不存在的服务 `betterSidebar`（cordis 的 inject 是必需依赖 ⇒ 整个客户端半边不激活、面板不出现）。本插件用 0.2.x 的契约独立实现，不依赖它。

**安装：**

```
dsh plugin --profile desktop add dsh-remote-gui
```

（宿主半边改完需重启 DSH；客户端半边热加载。）

**截图：**

<!-- 待补：面板总览（页脚入口已展开，显示本地/远端切换与远端会话列表）；
     面板里 iframe 加载出远端 DSH 真实界面那一屏。抓完由我插入这里。 -->

---

## 发出前要做的两件事（我给命令）

1. **补截图**：我抓好后插入上面的「截图」节（这是官方模板的硬性要求）。
2. **权限**：当前 gh token 的 scope 是 `gist, read:org, repo`，**不含 `write:discussion`**。
   要么跑一次（浏览器授权）：
   ```
   gh auth refresh -s write:discussion
   ```
   要么你把我贴好的标题+正文手工提交到该分类。
