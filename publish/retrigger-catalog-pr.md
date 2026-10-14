# dsh-remote-gui 收录 PR 的重触发说明（PR #7374）

> 目标仓库：`awesome-dsh-plugin/awesome-dsh-plugin`　PR：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/7374
> 分支：`temotee2103:add-dsh-remote-gui`　文件：`data/plugins/temotee2103__dsh-remote-gui.yml`

## 结论优先

**正常情况下什么都不用做。** 上游有一条 `regate.yml`，每 6 小时自动重跑一次，专门认「repository is N days old」这种**只靠时间就能过**的失败。PR 会自己变绿。

下面第 3 节是「万一到 2026-10-16 还是红的」时，你**唯一有权限**按的那个按钮；第 4 节是最后的兜底留言。

---

## 1. 时间点（两个不同的时钟，取较晚的那个）

| 时钟 | 什么时候到 |
|---|---|
| 仓库年龄满 1 天 | 建仓于 `2026-10-14T08:25:15Z` → **2026-10-15T08:25:15Z**（本地 16:25:15）之后 |
| regate 的 24h 冷却 | 从**最近一次 gate 判定时间**起算（不是建仓时间）。本 PR 首次判定约 `2026-10-14T12:35Z` → 冷却到约 `2026-10-15T12:35Z` |

regate 的 cron 是 `19 */6 * * *`（UTC），即每天 **00:19 / 06:19 / 12:19 / 18:19 UTC = 本地 08:19 / 14:19 / 20:19 / 02:19**。

按上面两个时钟取较晚者推算：约 `2026-10-15T12:35Z` 才同时满足 → 之后第一个 regate 时点是 **`2026-10-15T18:19Z`（本地 2026-10-16 02:19）**。那一刻仓库已 1.4 天，应自动转绿。

> 注意：如果你手动推了一次空提交，gate 会**重新判定一次**，24h 冷却也跟着重置——所以别没事就推，会把这个自动时刻往后推。

## 2. CI 是怎么串起来的（决定了"重跑哪一个"）

- `pr-check.yml` — `on: pull_request`。推送到分支 = 新一次运行。
- `pr-gate.yml` — `on: workflow_run`（`workflows: ['PR check']`, `types: [completed]`）。也就是那句 "**pr-gate.yml 是 workflow_run 触发的**"：它**没有** `pull_request` 触发，只能靠 pr-check 跑完把它带起来，或被 regate 重跑 pr-check 后带起来。
- `regate.yml` — `on: schedule`（`cron: '19 */6 * * *'`）+ `workflow_dispatch`。判定规则（源码里）：`aged = gate 判定为 failure && summary 匹配 /days old|commit\(s\)/ && 距离上次判定 ≥ 24h`，命中就重跑那条 PR check。注释里明确写了：**不要叫作者 resubmit，这个失败会自己清掉**。
- `pr-guard.yml` — 每小时一次的守卫：抓「PR 完全没有 check」和「PR 动了 `.github/`」两种状态。

因此：**不需要、也不能只重跑 `Submission gate` 这一个 job**；正确的最小动作是让 `PR check` 再跑一次（push 一个提交，或等 regate）。

## 3. 手动重触发（你唯一有权限的方式：往分支推一个提交）

空提交就够（`pull_request` 事件会把 `PR check` 重新跑一遍，gate 随后自动跟上）：

```powershell
$d = Join-Path $env:TEMP "awesome-retrigger"
if (Test-Path $d) { Remove-Item -Recurse -Force $d }
git clone --depth 1 --branch add-dsh-remote-gui https://github.com/temotee2103/awesome-dsh-plugin.git "$d"
git -C "$d" commit --allow-empty -m "re-trigger submission gate (repository is past the 1-day bar)"
git -C "$d" push origin add-dsh-remote-gui
```

> 核验状态：**这套命令已在本机实测通过**（在临时分支 `tmp-retrigger-probe` 上原样跑了一遍：`--depth 1` 克隆 → `--allow-empty` 提交 → push 成功；随后该探针分支已删除）。唯一前提是本机 git 全局有 `user.name` / `user.email`（本机已有）。

### 做不到的事（已实测，别浪费时间）

- `gh workflow run regate.yml --repo awesome-dsh-plugin/awesome-dsh-plugin`
  → `HTTP 403: Must have admin rights to Repository`（fork 作者没有上游写权限，2026-10-14 实测）。
- `gh run rerun <run-id>`、Actions 页面上的 "Re-run jobs" 按钮：同理，需要上游写权限。
- 关闭 PR 再重开：不要。regate 的注释专门写过，旧文案曾把作者引去「关掉重开 / force-push 空提交」来买一个他本来就有的东西。

## 4. 兜底：在 PR 下留言

到 **2026-10-16（本地）** CI 仍是红的，且**除了那句 "days old" 之外没有别的报错**，就在 PR 下留言（英文，照抄）：

```
@maintainers — the repository reached one day old at 2026-10-15T08:25:15Z, could the gate be re-run?
```

## 5. 这次踩到的坑（改条目之前先读）

- **别再从这个 fork 的 `main` 拉分支。** fork main 停在 2026-08-16，上面还压着 3 个本地提交（`Add dsh-overdrive#gateway-core`、`Clarify dsh-overdrive…`、`ci: only run Build site from README on upstream repo`）。从它拉分支，PR 会莫名其妙多出 `.github/workflows/build-site.yml` 和别人的条目（PR #7374 第一版就是这样，5 个文件、`mergeable: CONFLICTING`）。本条目的分支是从**当前上游 main** 重建的。
- **`gh` 的 token 没有 `workflow` scope。** 任何会改动 `.github/workflows/` 的 HTTPS 推送都会被拒：
  `! [remote rejected] … (refusing to allow an OAuth App to create or update workflow '.github/workflows/build-site.yml' without 'workflow' scope)`。
  只有两条路能推这类改动：`gh auth refresh -s workflow`（设备码，需要浏览器登录 GitHub），或**改用 SSH**（`git@github.com:temotee2103/awesome-dsh-plugin.git`；本机 SSH 已实测认证为 `temotee2103`）。
- **fork 与上游同步会冲突。** `POST /repos/temotee2103/awesome-dsh-plugin/merge-upstream {"branch":"main"}` → `409 There are merge conflicts`（README 两边都改过）。所以在 fork main 被同步好之前，不要指望"一键 Sync fork"。
- **`%TEMP%\awesome-dsh-plugin-pr` 是浅克隆**（depth 50），历史不完整，不要直接拿它 push。要动这个 PR，用第 3 节那种 `--depth 1` 的分支克隆，或重新完整克隆。

## 6. 条目本身（复核用）

```yaml
url: https://github.com/temotee2103/dsh-remote-gui
name: temotee2103/dsh-remote-gui
category: remote
description:
  en: Embeds a remote DeepSeek Harness GUI in the local DSH window over an SSH tunnel, lists the remote sessions, and switches between the local instance and any remote host.
  zh: 通过 SSH 隧道把远端 DSH 的 GUI 嵌进本地 DSH 界面，列出远端会话，并在本地实例与任意远端主机之间切换。
```
