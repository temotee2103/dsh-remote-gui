# Feature request: let the Desktop shell attach to a **remote Harness Host** (first-class connection target)

> Status: **draft — not submitted.** Post to **GitHub Discussions** (`deepseek-ai/deepseek-harness` → *Ideas* / *Feature requests*);
> the repository has **issues disabled** (`has_issues: false`, `has_discussions: true`, verified via `gh api repos/deepseek-ai/deepseek-harness`).
> Before posting, read the "Prior art" section: **#9529 already asks almost exactly this and has zero replies** — this draft should be
> posted as *additional evidence + a concrete blocker analysis* (ideally as a comment on #9529), not as a duplicate.
>
> Verified against: **DSH Desktop `0.2.0-rc.2`** (`%LOCALAPPDATA%\Programs\DeepSeek Harness`, `resources/app.asar`), plus the current
> `master` docs and source on GitHub. Everything below marked **[measured]** was produced by running a command on that install;
> **[read]** means I read the shipped code; **[inferred]** is reasoning I did not execute.

---

## Conclusion first

**There is no supported way to make the local DSH UI attach to a remote Harness Host.**

- Not a config key, not a CLI flag, not an environment variable, not a profile field, not a plugin seam — the Desktop shell's
  backend URL and its authentication cookie are **local variables inside `main()`** that only ever receive values from a child process
  the shell itself spawned on `127.0.0.1`.
- **What *does* work today** is the adjacent pattern: run the Harness where the work lives, then open **its own** Web UI through a
  forwarded address in a normal browser. I verified the full credential handshake and an authenticated RPC over a *tunnel-shaped*
  authority (`127.0.0.1:<other port>`) on a throwaway instance. The official README documents exactly this
  ("An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address").
- The gap is therefore **not** reachability. It is that the *shell* has no notion of a connection target, and the browser-trust fence
  makes "retarget a locally-served UI at a remote authority" impossible by construction — not merely unimplemented.

This is the same shape Hermes Agent solves with a first-class connection record. DSH has no equivalent.

---

## 1. What the Desktop shell does today (all **[read]**, line numbers from `resources/app.asar/lib/main.js`)

| Step | Evidence |
|---|---|
| The controller owns *lifecycle only*; the child is supplied by the caller | `DesktopBackendController`, `main.js:6322-6449` — fields are `createHost`/`publish`, states are `starting`/`ready`/`error` |
| The one construction site | `main.js:11318-11325` — `new DesktopHostProcess(resources.node, resources.dsh, activeProject, hostInspectPort, {...hostEnvironment, DSH_CLIENT_VERSION}, …)` |
| What is spawned | `runtimeResources()`, `main.js:11030-11038`: `node = process.execPath`, `dsh = join(app.getAppPath(), "dsh")` |
| Where it runs | `main.js:11186-11189` → `resolveDesktopPaths()` → `join(dshHome, "profiles", "desktop")`; `dshHome` = configured ?? `$DSH_HOME` ?? `~/.dsh` (`main.js:25-58`) |
| Child argv | `main.js:3673-3691` — `node --expose-internals <runtimeDir>/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js <runtimeDir> <projectDir> <primaryRuntime> <pnpm> <nodeBin>` |
| The URL is decided **by the child** | `dsh-desktop-host/lib/index.js:217-245` boots `runProfile({ profile: "desktop", args: ["--no-open", "--port", "19387"] })`; `index.js:337` builds `ctx.connection.authenticatedUrl(\`http://127.0.0.1:${String(ctx.webServer.port)}\`)` — **the hostname is the literal `127.0.0.1`** |
| The shell adopts it verbatim | `main.js:11328-11333` — `const ready = await host.start(); hostCookie = await authenticateWebHost(ready.url); hostUrl = ready.url;` |
| The cookie is exchanged against *that* URL | `authenticateWebHost(url)`, `main.js:7422-7429` — `fetch(url, {redirect:"manual"})`, requires `303` + `set-cookie` |
| The renderer's transport base | `main.js:11560-11568` — `DESKTOP_IPC.boot` returns `{ injections, streamBaseUrl: new URL(hostUrl).origin }` |
| Every `/api` request | `main.js:11542-11551` — the `dsh-app://app` protocol handler calls `forwardWebRequest(request, hostUrl, hostCookie)`; `forwardWebRequest`, `main.js:7461-7492`, **deletes `origin`/`cookie`/`host`** and sets `cookie: hostCookie` |
| WebSocket | `main.js:11583-11604` — `webRequest.onBeforeSendHeaders({ urls: ["ws://127.0.0.1/*"] })`, rewrites `origin`→`target.origin` and `cookie`→`hostCookie` **only when the WS host equals the local `hostUrl` host** |

### Every external input `main.js` reads (**[measured]** — full `process.env.` grep, 11 hits)

`DSH_DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS` (6996), `DSH_DESKTOP_PNPM_ENTRY` (11035, dev only), `DSH_DESKTOP_DSH_DIR` (11036, dev only),
`DSH_DESKTOP_PRIMARY_RUNTIME_DIR` (11040, unpackaged only), `DSH_DESKTOP_HOST_INSPECT_PORT` (11045, dev only),
`DSH_DESKTOP_UPDATE_JOURNAL_DIR` (11183), `DSH_DESKTOP_OPEN_DEVTOOLS` (12089, 12315), `DSH_DESKTOP_DEV_APP` (12189),
`DSH_DESKTOP_MANDATORY_UPDATE_CONFIG` (12265), `DSH_DESKTOP_DIAGNOSTIC_FILE` (12323).
The only `process.argv` use is `--updated` (`main.js:11209`).

> **None of them is a backend address. There is no such key, and no IPC that writes `hostUrl`/`hostCookie` after startup.**

## 2. CLI surface (**[measured]** — real output from the installed `0.2.0-rc.2`)

```
$ dsh --help
Usage: dsh [--profile] <name> [options] [app-args...]
       dsh plugin --profile <name> <pnpm-args...>
…
Options:
  -V, --version                  output the version number
  --profile <name>               the profile under $DSH_HOME/profiles to boot
  --from-default-profile <name>  initialize a new custom profile from a shipped profile template
  --patch <path>                 extra patch-list overlay applied after the profile layer (repeatable)
  --dump-config                  print the composed profile tree and exit
  --dump-config-schema           print JSON Schema for profile entries and patches without mounting
  --dump-default-config          print the profile tree without its user layer or --patch overlays and exit

$ dsh web --help
Usage: dsh --profile web [options]
Serve the DeepSeek Harness browser UI.
Options:
  --host <host>                  bind host
  --no-open                      do not open the Web UI in the default browser
  --port <port>                  listen port; pass 0 to let the OS pick a free one
  --trusted-host <authority...>  extra authority the /api browser-trust fence accepts (host or host:port; repeatable)
  -h, --help                     show this help
```

The launcher grammar in `@deepseek-ai/dsh/lib/bin.js:105` declares exactly `--profile`, `--from-default-profile`, `--patch`,
`--dump-config`, `--dump-config-schema`, `--dump-default-config`, plus the `plugin` subcommand — and `bin.js:35-37` **rejects
`--profile desktop` for CLI boot**. The Web flags come from `@deepseek-ai/dsh-web-app/lib/startup.js:22`.

There is **no** `--backend`, `--remote`, `--connect`, `--attach`, `--host-url`, `--url`, or `--token` anywhere.
`master`'s generated `docs/cli-help.md` adds `--public-url`, `--tls-cert`, `--tls-key` and a concrete-local-interface `--host`
(not present in `0.2.0-rc.2`) — i.e. the official direction is *serve remotely and reach it*, never *retarget the client*.

## 3. Config files: no `connections.json` analogue exists (**[measured]**)

Searched `~/.dsh`, `%APPDATA%\dsh-desktop\harness`, `%APPDATA%\@deepseek-ai\dsh-desktop`, and the packaged runtime.

| Search | Result |
|---|---|
| Top-level config files in both harness homes | only `cordis.patch.yml`, `.credentials.yaml`, plugin-owned stores (`dsh-ssh.json`, `remote-gui-hosts.json`, `desktop-host-plugins.json`) — **no** `settings.yaml`, no backend key |
| `Select-String` for `backend\|endpoint\|connection\|remote` across both homes' top-level `*.yml/*.yaml/*.json` | 5 hits: two comments, `client-connection/browser-session` in `.credentials.yaml` (the cookie-signing secret), and a plugin comment |
| Composed config schema, `dsh --profile web --dump-config-schema` (28,984 lines) | `backend` (5113) / `endpoint` (10682) belong to unrelated loader rows; **zero** `baseUrl` / `hostUrl` / `connections` / `remoteHost` |
| runtime grep `launchMode\|keyPath\|"connections"` | 1 hit — a Swift syntax-highlighting JSON in the frontend bundle. Nothing else |
| runtime grep `backendUrl\|DSH_BACKEND\|remoteHostUrl` | **0 hits** |
| `%APPDATA%\@deepseek-ai\dsh-desktop` | Electron/Chromium user data only (`Cache`, `Local Storage`, `Preferences`, `Network`, …); no harness config |

(That last path is the Electron *user-data* directory, not a second harness home. The live Desktop host process confirms it:
`--user-data-dir="…\AppData\Roaming\@deepseek-ai\dsh-desktop"`, and its argv names the **active profile** as
`C:\Users\Temo Tee\.dsh\profiles\desktop`.)

## 4. Profile mechanism (**[read]** — local dump + official source)

A profile is a directory holding `package.json` (`dependencies` + the manifest `dsh.profile.bundles`) and `cordis.patch.yml`.
The manifest type is `ProfileTemplate { bundles: readonly string[] }` and `dsh.profile` carries an **ordered bundle list** plus
version exemptions — nothing else (`packages/boot/app-boot/src/profile.ts`, `master`;
`PROFILE_TEMPLATES` / `initProfile` / `loadProfileDirectory`). Verified locally in `@deepseek-ai/dsh/lib/profile-boot-*.js` and in both
installs' `profiles/*/package.json`, which contain only `dsh.profile.bundles`.

A profile can therefore add plugins and patch **any plugin's config** — but no plugin in the shipped tree exposes a "backend host"
field, so there is nothing to patch into existence.

## 5. Official docs & Discussions

- `README.md` (master): *"The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a
  local launch. **An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address.** Pass
  `--no-open` to run the server without opening a browser."*
  → the documented remote story is **remote server + a forwarded address + your own client**.
- `.agents/notes/archived/feature/2026-08-25-promote-open-anywhere-plugin.md`: *"**SSH port forwarding changes HTTP reachability, not
  which machine owns the workspace or applications.**"*
- Repository code search: `multi-host` → 0 hits; `"connect to another"` → 0; `"remote backend"` → only filesystem-backend hits;
  `--backend`/`--remote` → only the SSH helper runtime and browser-use dev scripts. **No feature or doc for client-side Host retargeting.**
- **Equally important — the Discussions search says this is already asked and unanswered:**
  - [#9529 "Idea: DSH Desktop as a client for a remote Host (the seam looks already prepared)"](https://github.com/deepseek-ai/deepseek-harness/discussions/9529)
    (2026-10-12, **0 comments**) — reaches the same two conclusions I did, independently.
  - [#8057 "Remote workspaces in the Desktop app — and the remote side must keep running on its own"](https://github.com/deepseek-ai/deepseek-harness/discussions/8057) (**0 comments**)
  - [#5530 `dsh-remote-tunnel`](https://github.com/deepseek-ai/deepseek-harness/discussions/5530) — a shipped community plugin doing "remote `dsh web` + local browser over an auto-reconnecting SSH tunnel", i.e. the supported pattern.
  - [#9029 "Web UI on a trusted remote host: model settings are loopback-only"](https://github.com/deepseek-ai/deepseek-harness/discussions/9029) — the remote-origin client seat problem.

**So this is not a new idea. What is missing is a concrete blocker analysis and a decision.** That is what this post adds.

## 6. Community plugins: none of them retarget the local UI (**[read]**)

| Plugin | What it actually does | Does it point the local UI at a remote backend? |
|---|---|---|
| `@linxin666/dsh-remote-web-ui` (`~/.dsh/profiles/desktop/node_modules/…`, README lines 18-32, 45, 50) | Exposes **this** harness to phones/other PCs: LAN bind toggle, optional Cloudflare tunnel, QR pairing, gated `/remote` channel | **No** — it is the *server* side of remote access |
| `@linxin666/dsh-ssh` (README lines 24, 30, 38, 41) | SSH host inventory in `~/.dsh/dsh-ssh.json`, xterm terminal, SFTP, **port forwards that listen on `127.0.0.1` only**, 6 `ssh_*` agent tools | **No** — it never touches the GUI transport |
| `dsh-sev` 0.3.4 | 0.1.x-era "remote GUI in a panel" | **No** (broken on 0.2.x) |
| `dsh-remote-gui` (this plugin) | SSH tunnel + remote launch-token → remote browser cookie, native side panel, remote session list, `remote_gui_run_task` | **No** — see §7 |

## 7. **Where a plugin is stuck** (the part I think is worth a maintainer decision)

A plugin *can* hold a remote cookie and *can* proxy for itself — `dsh-remote-gui` does exactly that, and its own routes are
deliberately loopback-only (`lib/routes.js:80-87,105` → `403 {"error":"loopback only"}`), because it is an add-on surface, not the
UI. It cannot move the UI, for two independent reasons:

### (a) The transport bootstrap is not reachable from a client plugin

- The renderer is served from `dsh-app://app/` (`main.js:11272`) and its `/api` traffic is intercepted by the shell's protocol
  handler, which **hardcodes the local `hostUrl` + local `hostCookie`** (`main.js:11542-11551`, `7461-7492`).
- `hostUrl`/`hostCookie` are `let` bindings inside `main()` (`main.js:11273-11274`) written only from the child's `ready` message
  (`11328-11330`). There is no IPC to change them.
- The documented client seam carries **only the WebSocket origin**: *"A static desktop page can provide
  `__DSH_TRANSPORT__.streamBaseUrl` for the HTTP origin of its owned Host. The Gateway uses that origin for its WebSocket while
  **HTTP transport remains independently selected**. The desktop carrier owns authentication; **setting the origin alone grants no access**."*
  (`@deepseek-ai/dsh-client-connection/README.md:28`). The consumer is `lib/client.js:1483-1491`.
- `installConnection` *does* accept a full transport override — `transport.rpc`, or `transport.fetch` + `transport.openStream`, and
  `transport.ownsHost` (`@deepseek-ai/dsh-client-connection/lib/client.js:1367-1369, 1404`) — **[inferred]** this is the seam a fix
  would use, but in the Desktop shell it is installed by the shell's own boot, and the fence below still applies.

### (b) The browser-trust fence rejects the Desktop renderer's origin outright (**[measured]**)

`@deepseek-ai/dsh-client-connection/lib/index.js:205-219` (`isTrustedApiRequest`): the `Host` must be loopback or a declared
`trustedHosts` authority; an attached `Origin` must equal that `Host`; `sec-fetch-site: cross-site` is refused. Failure is **403**;
trusted-but-unauthenticated is 401.

Measured against the live Desktop host (`127.0.0.1:19387`, read-only requests):

| Request | Status |
|---|---|
| `Host: 127.0.0.1:19387`, no cookie | 401 |
| `Host: 127.0.0.1:3099` (a *different* loopback port — the tunnel shape) | **401, not 403** |
| `Host: 192.168.1.50:19387` | 403 |
| `Host: attacker.example.com:19387` | 403 |
| `Host: 127.0.0.1:19387, Origin: http://evil.example.com` | 403 |
| `Host: 127.0.0.1:19387, Origin: http://127.0.0.1:19387` | 401 |
| `Host: 127.0.0.1:19387, sec-fetch-site: cross-site` | 403 |
| **`Host: 127.0.0.1:19387, Origin: dsh-app://app`** (what the Desktop renderer sends) | **403** |
| `Host: 127.0.0.1:19387, Origin: file://` | 403 |

**Correction to a common assumption:** a tunnel to a *loopback* port is **not** blocked by the fence (row 2 → 401, i.e. it passes
trust and only lacks a cookie). What is blocked is any request whose `Origin` is not the target authority — and the Desktop
renderer's origin is the immutable `dsh-app://app`. So a plugin that bypasses the shell's proxy to reach a remote/tunnelled
authority gets **403 from the fence**, while the shell's own proxy path can only ever reach the *local* host.

### (c) …and the browser path already works (**[measured]**, throwaway instance, no credentials, no model calls)

I booted a disposable `dsh web --no-open --port 3099` under a temporary `DSH_HOME` and simulated a tunnel by presenting
`Host: 127.0.0.1:3999` (exactly what `ssh -L 3999:127.0.0.1:3099` makes the server see):

```
token exchange at 127.0.0.1:3099        -> 303, Set-Cookie: dsh-auth-3BwAN0Jz…   (authority-bound cookie)
token exchange at 127.0.0.1:3999        -> 303, Set-Cookie: dsh-auth-iRuosmQt…   (different name: bound to 3999)
POST /api/session/list   (cookie, 3999) -> 200 {"result":{"ok":true,"value":{"items":[]}}}
POST /api/session/list   (no cookie)    -> 401 unauthorized
GET  /api/session/list   Host: 192.168.1.50:3099 (valid cookie) -> 403
GET  /api/session/list   cross Origin + valid cookie           -> 403
```

So: **a plain browser + an SSH port forward is a fully supported remote path today.** The missing capability is specifically
"*make the Desktop app / a locally-served UI be the client of a Host that is not the one it spawned*".

## 8. Comparison with Hermes Agent

| | Hermes Agent | DSH (`0.2.0-rc.2`) |
|---|---|---|
| First-class connection record | `%APPDATA%\Hermes\connections.json`: `{primary, launchMode, connections:[{kind:"local"},{kind:"ssh",host,user,keyPath,token}]}` | none |
| Local UI as a client of a remote backend | yes — same UI, transport swapped per connection | **no** — the shell spawns a local child and adopts its URL |
| Port forwarding | owned by the app, driven by the connection record | manual `ssh -L` (or a plugin), then open the URL in a browser |
| Credentials | per-connection `token` in the record | one-time `?token=` → authority-bound cookie; the shell mints it from the **local** child only |

## 9. Proposed minimal design (for discussion, not a demand)

The seam looks genuinely small — the discussion #9529 argues the same, and the Gateway/Remote layer is already transport-agnostic.

1. **A connection target on the shell side.** A `$DSH_HOME/desktop-connections.json` (or a profile field) with
   `{ id, kind: "local" | "ssh", host/alias, remotePort, localPort?, trustedAuthority? }`, plus a launcher flag such as
   `--connect <id>`; `DesktopBackendController` keeps its lifecycle contract, but `createHost` may return a **forwarding** host
   instead of a spawned one.
2. **Make the forwarded authority explicit.** When the target is remote, the shell must (a) own the forward
   (`ssh -L <localPort>:127.0.0.1:<remotePort>` as `dsh-remote-gui`/`dsh-ssh` already do), (b) present itself to the remote with a
   `Host` that the remote's fence accepts — i.e. the forward must be **loopback on the client side** (verified to pass, §7b row 2) —
   and (c) perform the remote's one-time token exchange (`GET /?token=…` → 303 → authority-bound cookie) instead of the current
   loopback-trust `fetch`.
3. **Keep the fence authoritative.** No new trust bypass: the remote must remain the one deciding who may attach. A remote Desktop
   host should keep binding `127.0.0.1` and be reached through the forward, not by loosening `--trusted-host`.
4. **Surface which Host the window is attached to.** `RemoteHostFacts` already carries the Host home for path display — a title-bar
   or settings indicator would make the local/remote state legible and prevent "I thought I was editing my laptop".
5. **Optional, later:** the same target list shared by the CLI (`dsh --connect <id> headless "…"`) so scripts do not re-implement
   tunnel + token handling.

**Non-goals:** no `0.0.0.0` bind, no change to the fence defaults, no server-side push, no multi-tenant hosting.

## 10. How to reproduce every claim here

```sh
# 1. CLI surface (installed 0.2.0-rc.2)
dsh --help ; dsh web --help

# 2. no backend key anywhere in the composed config
dsh --profile web --dump-config-schema | grep -nE 'backend|endpoint|baseUrl|hostUrl|connections|remoteHost'

# 3. the shell's own transport wiring (inside app.asar; readable with Electron in Node mode)
#    node --expose-internals .../dsh-desktop-host/lib/cli.js is how `dsh` itself runs, so:
#    ELECTRON_RUN_AS_NODE=1 "…\DeepSeek Harness.exe" -e "console.log(require('fs').readFileSync('…\\app.asar\\lib\\main.js','utf8').split('\n').slice(11542,11551).join('\n'))"

# 4. the fence, measured (any harness host; 19387 is the Desktop host)
#    GET /api/probe with Host: 127.0.0.1:19387            -> 401
#    same with Host: 127.0.0.1:3099                       -> 401   (loopback tunnel shape is NOT 403)
#    same with Host: 192.168.1.50:19387                   -> 403
#    same with Origin: dsh-app://app                      -> 403   <-- the Desktop renderer's origin

# 5. the browser+tunnel path works (disposable instance, temp DSH_HOME)
DSH_HOME=<tmp> dsh web --no-open --port 3099
# then: GET /?token=<printed token> with Host: 127.0.0.1:3999 -> 303 + Set-Cookie
#       POST /api/session/list with that cookie               -> 200 ok:true
```

## 11. Why I am filing this instead of shipping a plugin around it

`dsh-remote-gui` already implements everything a plugin can implement: SSH tunnel lifecycle, remote launch-token retrieval, the
authority-bound cookie exchange with 401/403 refresh, remote session list/read/prompt/create/archive, and a native panel. Making
the *whole window* the remote's client needs exactly the two things a plugin cannot own — where the page's HTTP transport points,
and what `Origin` the renderer presents to the fence. Both live in the Electron shell (`main.js`), which no plugin can patch.

If the intended answer is "always use a browser over a tunnel, and the Desktop app stays local", that is a legitimate position —
please say so in #9529 and in the Web UI guide, and I will document it in `dsh-remote-gui` and close this line of work.
