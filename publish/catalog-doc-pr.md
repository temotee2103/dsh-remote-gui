# 上游文档 PR 草稿 —— awesome-dsh-plugin/awesome-dsh-plugin

> 状态：**已写好，未提交**。是否真提由用户决定。
> 目标文件：`contributing.md`，§Screenshots（当前第 165-203 行）。
> 改动量：**只改 2 行**（英文段 1 行 + 中文段 1 行），纯文档，无代码、无行为变更。

---

## 建议标题

```
docs: say that screenshots.json elements must be plain strings, not objects
```

## 建议分支

```
docs/screenshots-json-string-elements
```

---

## 要改的那一句（逐字）

### 当前位置

- 英文段：`contributing.md` **第 179 行**
- 中文段：`contributing.md` **第 181 行**
（中间第 180 行是空行，不动）

### 改动前（原文，逐字）

第 179 行（英文）：

```
Paths are relative to that file, so they point at images already in your repository. `{"screenshots": [...]}` works too if you prefer a named field.
```

第 181 行（中文）：

```
路径相对于该文件本身，指向你仓库里已有的图片。若偏好带字段名，`{"screenshots": [...]}` 同样可用。
```

### 改动后（替换文本，逐字）

第 179 行（英文）—— 在句末**追加**一句：

```
Paths are relative to that file, so they point at images already in your repository. `{"screenshots": [...]}` works too if you prefer a named field. **Every element must be a plain string path** — an object such as `{"path": "assets/a.png", "caption": "…"}` is not supported (storefronts render the image and have nowhere to show a caption), and one object makes the whole declaration unusable: the entry falls back to README-extracted images, with one line in the build log as the only trace.
```

第 181 行（中文）—— 在句末**追加**一句：

```
路径相对于该文件本身，指向你仓库里已有的图片。若偏好带字段名，`{"screenshots": [...]}` 同样可用。**每个元素都必须是纯字符串路径**——像 `{"path": "assets/a.png", "caption": "…"}` 这样的对象不受支持（门面只渲染图片，没有显示说明文字的位置），只要出现一个对象，整份声明就无法使用：该条目会改为回退到从 README 抽取的图片，构建日志里只留一行提示。
```

### 为什么中英必须一起改

`contributing.md` 第 161 行把 **locale parity** 列为 CI 检查项（“`awesome-lint` 与站点构建：双语一致性、分隔符、日期、截图”），只加英文会让站点构建/awesome-lint 失败。

---

## PR 正文草稿（可直接粘贴）

```markdown
## What

One sentence added to §Screenshots, in both locales, saying that every element
of `screenshots.json` must be a plain string path — objects such as
`{"path": "assets/a.png", "caption": "…"}` are not supported.

Docs only: one file, two lines, no behaviour change.

## Why

The section currently says "listing 1-8 image paths" and shows an array of
strings, and that is exactly what `scripts/probe-screenshots.mjs` accepts — but
nothing says the *elements* have to be strings, and the App Store framing invites
captions. A plugin author who writes the object form gets no signal from this
document at all.

What the code does with that form, for the record:

- `scripts/probe-screenshots.mjs:120` — `if (list.some((s) => typeof s !== 'string' || !s.trim())) return { problem: 'every entry in screenshots.json must be a non-empty string' }`. One object rejects the whole declaration, not just that element.
- `:106-114` accepts four top-level shapes (bare array, `{"screenshots": [...]}`, a single-key map keyed by the entry URL, and any single-key object whose value is an array). The document only names two of them, which is fine — but it means the shape is more forgiving than the elements are.
- `:80-82` and `:187-190`: the problem is deliberately non-fatal (the entry falls back to the legacy file / README extraction) and the only trace is the malformed list printed by the probe. So from the author's side the shots simply do not appear.

The fix is to say the constraint in the place where the format is defined, so the
next author does not have to read the probe to find it.

## Scope note — what this PR does NOT ask for

I am deliberately not asking for the malformed case to become an error, and not
asking for object/caption support. The non-fatal fallback in `probe-screenshots.mjs`
is documented as intentional ("reported so the author can be told, but it never
promotes to an error"), and captions have nowhere to render: storefronts consume
`plugins.json`'s `screenshots` as a flat string array of URLs. Only the wording
changes.

## Where this is not the problem

Worth saying because it is the natural first guess: this is not a storefront bug.
dsh-market (or any storefront) never reads a plugin's `screenshots.json` — it
reads the resolved URL array from the published catalog. Resolving relative paths
against the author's repo at `HEAD` happens here, in `probe-screenshots.mjs:139`.
A quick check of the published catalog today: 987 entries carry `screenshots`, and
none of them contains a non-string element — so this is a clarity fix ahead of the
next author hitting it, not a live data defect. Saying so seemed better than
implying a bug.

## How I hit it

I wrote the object form (`{"path": ..., "caption": ...}`) in my own plugin's
`screenshots.json` while laying out an App-Store-style set, and the shots never
showed up anywhere with no message back to me; I only understood why after
reading `probe-screenshots.mjs`.
```

---

## 备选：如果维护者更想要「作者能被通知」而不是文档

不改文档、改可见性的方案（**本次不提交，供讨论**）：让投稿 PR 的检查把 malformed 的
`screenshots.json` 直接说给作者 —— 目前 `probe-screenshots.mjs` 的 malformed 列表只出现在
探针运行的日志里，而 `scripts/check-submission.mjs` 才是作者会看到的那个 gate。
注意上游注释明确写了「不升级为 error」是刻意的，所以这一条要不要做、做成什么形式，应由维护者判断。

---

## 附：本次核对中额外发现的一条（可选，未写进上面那句）

用移植版校验器跑负对照时发现：**markdown 图片语法不会被拒绝，而是被当成相对路径原样拼进去**。

```
输入  ["![shot](assets/a.png)"]
上游  ACCEPTED → "https://raw.githubusercontent.com/<owner>/<repo>/HEAD/!%5Bshot%5D(assets/a.png)"
```

`:120` 只要求「非空字符串」，`:125` 只认 `^https?://` 前缀，于是任何「看起来像图片但其实是 markdown/其他写法」的字符串都会通过校验、拼出一个必然 404 的地址，再被 `build-site.mjs:415` 按 404 静默丢掉——症状和对象形式一样（截图不见了），但**连构建日志里的 malformed 提示都没有**（它不算 malformed）。

如果维护者愿意，同一句里可以再补半句「元素会被当作路径原样使用，markdown 图片语法不适用」；本 PR 草稿按「最小改动」只写了对象那一条，是否一起加由维护者/用户定。

---

## 事实依据（写文档时的核对记录，2026-10-14 实测）

- `contributing.md` §Screenshots 自 **2026-08-26** 的 `f3abe301`（"Let a plugin declare its own screenshots, and start draining the shared file"）加入后内容未变，本文引用的是当前 `main`。
- `probe-screenshots.mjs:53` `MAX_SHOTS = 8`（**8**，不是 dsh-market 客户端那个 6）。
- 元素处理：`:125` 以 `/^https?:\/\//i` 判定绝对 URL → `:128` 必须 `https:` 且主机在 `raw.githubusercontent.com` / `user-images.githubusercontent.com` / `camo.githubusercontent.com` / `github.com` 之内 → `:131` **原样收下**；否则按相对路径处理，`:136` 禁止前导 `/` 与 `..`，`:139` 拼成 `<raw.githubusercontent.com>/<owner>/<repo>/HEAD/<path>`。
- `build-site.mjs` 侧：`:364-366` + `:376` 旧格式 `data/screenshots.json` 里出现非字符串会 `complain()` 并 `process.exit(1)`（硬失败）；`:398-405` 采用探针产出的 `data/screenshots-declared.json`；`:415` 只丢弃被探针确认 404/410 的图；`:1138` 发布 `shotsMap[e.url]`。
