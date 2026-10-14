# PR: 收录 dsh-remote-gui（category: remote）

> 提交时用这份作为 PR 正文。目标仓库：`awesome-dsh-plugin/awesome-dsh-plugin`
> 分支：`add-dsh-remote-gui`　文件：`data/plugins/temotee2103__dsh-remote-gui.yml`（+ 重新生成的两个 README）

## 这个插件做什么

`dsh-remote-gui` 把**远端那台 DSH 的完整 GUI** 通过 SSH 隧道嵌进本地 DSH 窗口，并把远端会话列进面板；
面板顶部可以在**本地实例**与**任意一台远端**之间切换。

也就是 OpenClaw 的 Remote Access 文档里 *Chat UI over SSH* 那一节、以及 Hermes 桌面端经 SSH 连远端实例的做法 ——
把这个形态带给 DSH：本地这台当控制台，远端 `dsh web` 当长驻执行体，中间是 SSH。

- 仓库：https://github.com/temotee2103/dsh-remote-gui
- npm：https://www.npmjs.com/package/dsh-remote-gui （`dsh-remote-gui@0.1.0`，`repository` 字段指回仓库）
- 安装：`dsh plugin --profile desktop add dsh-remote-gui`

## 为什么不是 dsh-sev

`dsh-sev` 是最接近的既有插件（SSH 隧道 + 面板内 GUI），但它是按 DSH **0.1.x** 写的，
在 `0.2.0-rc.2` 上实测四个缺陷让核心功能不可用：服务端请求不带远端凭据（一律 401）、
RPC 信封过时（404 / `gateway/bad-request`）、`output.render` 返回字符串（`content.some is not a function`）、
客户端 `inject` 里列了不存在的服务 `betterSidebar`（导致客户端半边不激活）。

本插件用 0.2.x 的真实契约**独立实现**，不依赖 dsh-sev，因此也不受它升级影响。
分类我选了 `remote`（插件做的事就是远端访问）；若维护者认为 `tools` 更合适，直接改即可。

## 满足收录要求（逐条自查）

| 要求 | 状态 |
|---|---|
| `package.json` 声明 `dsh.bundle` | ✅ `"bundle": { "patch": "./cordis.patch.yml" }`，且 `cordis.patch.yml` 在仓库根 |
| 真实可用的代码（非占位） | ✅ 宿主半边 9 条路由 + 客户端半边（`sidebar.footer.action` 插槽注册）；有测试与 CI |
| 仓库创建满 1 天 | ✅ 提 PR 时已满 |
| ≥10 个提交（CI 的 `MIN_COMMITS`） | ✅ 提 PR 时满足 |
| 加 `dsh-plugin` topic | ✅ 已加（另有 `dsh`、`deepseek-harness`、`ssh-tunnel`） |
| 描述属实、不带营销词 | ✅ 只写了代码里真实存在的能力；无数字宣称 |
| 官方 `@deepseek-ai/*` 用 `peerDependencies` | ✅ `@deepseek-ai/dsh`、`@deepseek-ai/dsh-tools` 均为 peer，且范围带显式预发布分支（避免 node-semver 静默排除 `0.2.0-rc.*`） |
| 一个 PR 只加一条 | ✅ 只加了 `temotee2103__dsh-remote-gui.yml` |

**关于两个 README**：CI 的 `generate-readme.mjs --check` 要求 README 与 `data/plugins/` 一致，
所以我按 `contributing.md` 允许的方式在本地跑了 `node scripts/generate-readme.mjs` 并把结果一起提交。
除我自己那一行外没有改动任何既有条目（可用 `git diff --stat` 复核）。

## 条目内容

```yaml
url: https://github.com/temotee2103/dsh-remote-gui
name: temotee2103/dsh-remote-gui
category: remote
description:
  en: Embeds a remote DeepSeek Harness GUI in the local DSH window over an SSH tunnel, lists the remote sessions, and switches between the local instance and any remote host.
  zh: 通过 SSH 隧道把远端 DSH 的 GUI 嵌进本地 DSH 界面，列出远端会话，并在本地实例与任意远端主机之间切换。
```

## 提交前我在本地跑过的校验

```
node scripts/generate-readme.mjs            → README.md / README.zh.md 均重新生成
node scripts/check-submission.mjs --only-list … --pr-created <now>
  → 除"仓库年龄 / 提交数"外无其他问题（这两项在提 PR 时已满足）
```

## 自述（可选，供维护者快速判断）

- 插件的核心难点是 0.2.x 的远端凭据与 RPC 契约，仓库 `docs/SPEC.md` 里记了实测出来的完整形状
  （`POST /api/<ns>/<method>`、`payload.args._request`、数据在 `result.value`、以及
  cookie 按 authority 绑定、iframe 必须用带 token 的 seedUrl 才能种下凭据）。
- 维护者若发现描述与代码不符之处，欢迎直接指出，我改。
