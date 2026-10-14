# dsh-remote-gui

**Operate the DSH that runs somewhere else — from inside your local DSH window.**
An SSH tunnel brings the remote GUI into your local UI, the remote sessions show up in
the panel, and a switch toggles between **the local instance** and **any registered remote**.

> 中文版见 [README.md](README.md)

---

## The problem it solves

Running DSH on a VPS is common: it stays up 24/7, it can host IM plugins
(WhatsApp / Telegram / …), and your phone can reach it any time. But **using it from a
computer** usually leaves you two options — open a browser tab to the remote address, or
run two windows side by side and keep track of which is which.

`dsh-remote-gui` adds a third option: **one window, many instances.**

- One entry in the sidebar footer opens a panel containing **the remote DSH's real GUI**
  (not a screenshot, not a read-only view)
- The same panel lists the **remote sessions**
- A selector at the top switches between the **local instance** and **any remote** —
  the same interface, pointed at a different machine

## Why not just use dsh-sev

`dsh-sev` is the closest existing plugin (SSH tunnel + in-panel GUI), but it was written
against **DSH 0.1.x**. On `0.2.0-rc.2` four defects make its core features unusable —
all measured, not inferred:

| Defect | What you actually see |
|---|---|
| Its server side requests the remote for you, but sends **no remote browser credential cookie** | Every remote request fails 401: `SyntaxError: Unexpected token 'u', "unauthorized" is not valid JSON` |
| **Stale RPC envelope** (`/api/session.list` + `method:"session.list"` + `payload:{}`) | `404 not found`; after fixing the path, `gateway/bad-request` |
| `output.render` returns a **string** (0.2.x requires a ContentBlock array) | On the agent side: `content.some is not a function` |
| Its client `inject` list names `betterSidebar`, a service that **does not exist** on this host | cordis treats `inject` as required dependencies, so the whole client half never activates and the panel never appears |

`dsh-remote-gui` is an **independent implementation** against the real 0.2.x contract.
It does not depend on dsh-sev, so dsh-sev updates cannot break it.

---

## Features

| Feature | Details |
|---|---|
| **SSH tunnel management** | `ssh -L <local port>:127.0.0.1:<remote port> <alias>`; a watchdog re-checks every 15s and reconnects as needed; after a host restart it **adopts** a tunnel that is still listening instead of spawning a duplicate |
| **Automatic remote credential exchange** | The remote `dsh web` requires an authority-bound browser cookie on every `/api` call. The plugin reads the remote launch token over ssh, exchanges it for a cookie through the tunnel, caches it per host, and refreshes + retries on 401/403 |
| **Remote session list** | Via `/api/session/list` (typert envelope): title, last activity, cwd, running state |
| **Embedded remote GUI** | An iframe pointed at the tunnel. First load uses a **token-bearing seedUrl**, whose 303 plants the credential cookie in the browser; after that the plain tunnel URL keeps working |
| **Local ↔ remote switch** | A selector at the top: `Local instance` or any registered remote. Local mode uses the same-origin `/api/session/list` and points the iframe at `location.origin` |
| **Session archive** | Archive a remote session from the panel (`workspace/archiveSession`) |
| **Agent tool `remote_gui_run_task`** | Lets the local agent run a one-shot task on a remote host through `ssh + dsh --profile headless` and bring the result back |
| **Diagnostic routes** | `/health` (tunnel + remote reachability) and `/proxy` (pass-through to any remote path) |

**Boundaries.** The remote must be running `dsh --profile web`, and its systemd user unit
must be named `dsh-web` (the launch-token lookup depends on it; rename it and you also
change `remoteLaunchToken()` in `lib/index.js`). Local ports are allocated from 5640
upwards, which avoids dsh-sev's 5636.

---

## Install

```sh
dsh plugin --profile desktop add dsh-remote-gui
```

From GitHub instead:

```sh
dsh plugin --profile desktop add github:temotee2103/dsh-remote-gui
```

**The host half requires a DSH restart** (Node's ESM cache holds host modules). The client
half hot-loads.

---

## Usage

1. A **Remote** icon appears in the sidebar **footer** — click it to open the panel
2. Enter an **SSH alias** (configured in `~/.ssh/config`, e.g. `my-vps` or an IP) → Add
3. The host row goes from *connecting* to *connected*; the remote session list appears
4. Switch targets at the top (**local instance / remote**). In remote mode the iframe holds
   that machine's full GUI — you can type and click directly in it

---

## Use it the way Hermes Agent / OpenClaw do

Both products share one shape: **the agent runs on one machine, and you drive it from
another machine through the full interface.**

- **OpenClaw**'s Remote Access documentation has a section called *Chat UI over SSH* —
  keep the gateway on the remote machine and use its Chat UI locally over SSH
  ([docs.openclaw.ai/gateway/remote](https://docs.openclaw.ai/gateway/remote)).
- **Hermes Agent**'s desktop app likewise supports connecting to a remote instance over SSH.

`dsh-remote-gui` brings that same shape to DSH:

| Role | How it maps onto DSH |
|---|---|
| **Console** (the machine in front of you) | Local DSH Desktop — the window you already live in |
| **Always-on worker** (VPS / home box / cloud host) | Remote `dsh web` under systemd, with IM plugins attached |
| **The channel between them** | SSH (the plugin maintains the tunnel and the credentials) |

Which makes a few things possible that used to need several windows:

- **One console, N workers** — register your dev box, your VPS and a home mini-PC; switch at
  the top instead of remembering each address, port and token
- **Long work remote, short work local** — let the remote host carry crawls, builds and
  other long-running work while you watch its sessions from the same window
- **Take over at any moment** — if a remote agent gets stuck, switch to it and operate the
  real interface, not a replay

---

## Working with other plugins

| Plugin | How they fit together |
|---|---|
| **IM plugins** (`@xmanrui/dsh-im` WhatsApp, Telegram, …) | Install them **on the remote**. It answers messages 24/7; because the panel embeds the remote GUI, **the conversation on your phone and the interface in front of you are the same session** — take over, change a prompt, or inspect the tool calls right there |
| **`dsh-remote-web-ui`** (QR pairing + phone adaptation) | Complementary: that one targets **phones/tablets** (paired, portrait-touch adaptation), this one targets the **desktop** (SSH tunnel + panel). Installing both on one remote is fine |
| **`@linxin666/dsh-ssh`** | Complementary: that one gives you **web terminal / SFTP / port forwarding** ("I want to run commands over there"), this one gives you **the remote GUI embedded plus the remote session list** ("I want to *use DSH* over there"). Different routes and port ranges |
| **`dsh-task-board`** | Install it on the remote and its scheduled/subtask work runs there; you watch that board from the panel |
| **Anything installed only on the remote** | Becomes usable automatically — the panel hands you the remote's complete interface, not a subset this plugin knows how to translate |

---

## The remote contract (0.2.x, all measured)

```
Credential exchange
           GET http://127.0.0.1:<tunnel port>/?token=<remote launch token>
           -> 303 + Set-Cookie: dsh-auth-<authority hash>=<signed value>
           The cookie is bound to the authority; it survives a remote restart
           (the token does not)

RPC        POST http://127.0.0.1:<tunnel port>/api/<ns>/<method>
           cookie: dsh-auth-...            <- required, otherwise 401 "unauthorized"
           body: {"type":"client-request","rpcId":"...","method":"<ns>/<method>",
                  "payload":{"args":{"<parameter name>":{...params...}}}}
           Data lives in result.value; method must match the endpoint exactly
           (slash form)

Session list
           /api/session/list with _request = {}   ->   result.value.items[]
Archive
           /api/workspace/archiveSession with request = {sessionId}
             -> result.value.archivedSessionIds[]

Remote launch token
           ssh <alias> journalctl --user -u dsh-web -n 400 --no-pager \
             | grep -oE 'token=[A-Za-z0-9_-]+' | tail -1 | cut -d= -f2
```

Four things that are easy to get wrong:

1. `method` uses the **slash** form (`session/list`) and must match the URL's last segment.
   The dotted form is rejected:
   `method "session.list" does not match endpoint "session/list"`.
2. `payload` must be `{"args":{...}}`. One level less gives
   `Remote payload must contain exactly one plain-object args field`.
3. ⚠️ **The key inside `args` is the host method's *parameter name*, not a fixed string.**
   This document used to claim it is always `_request`, which is wrong and made archive fail
   silently. Read the authoritative descriptor in the install tree:
   `resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-api-<ns>-controller/lib/typert.host.js`
   -> `invocations[].parameters[].{name,wire}`. Measured on 2026-10-14 across 26
   `typert.host.js` files / 140 invocations: `session/list` uses `_request` (the **only**
   underscore-prefixed one) while `workspace/archiveSession` and every other
   `session/*` / `workspace/*` / `schedule/*` / `job/*` method uses `request`.
   A wrong key yields `result.ok=false`, `error.code='gateway/arguments-invalid'`,
   `missing "request"; unexpected "_request"`. The plugin's registry lives in
   `lib/remote.js` (`ARGS_KEY_BY_METHOD`).
4. **The iframe issues its own browser request**, so planting the credential cookie in the
   browser cannot be skipped — that is exactly why `seedUrl` exists. A server-side exchange
   does not help the browser's own request.

---

## Routes (all loopback-only; anything else gets 403)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/dsh-remote-gui/hosts` | Host list (with `tunnel` and `seedUrl`) |
| POST | `/api/dsh-remote-gui/hosts` | `{alias, name?, port?, localPort?, autoTunnel?}` |
| DELETE | `/api/dsh-remote-gui/host?id=` | Remove a host and stop its tunnel |
| POST | `/api/dsh-remote-gui/tunnel` | `{id, action:'start'\|'stop'}` |
| GET | `/api/dsh-remote-gui/sessions?id=` | Remote session list |
| POST | `/api/dsh-remote-gui/session-archive` | `{id, sessionId}` |
| GET | `/api/dsh-remote-gui/seed?id=` | Token-bearing iframe entry URL |
| GET | `/api/dsh-remote-gui/health?id=` | Tunnel + remote reachability |
| GET | `/api/dsh-remote-gui/proxy?id=&path=` | Pass-through to a remote path (diagnostics) |

Host registry: `$DSH_HOME/remote-gui-hosts.json`.

---

## Verification

The host half was exercised by loading it in a **standalone process** with a **real tunnel**
to a **real remote** and calling its route handlers directly (no app restart involved; the
reproduction method is in [`docs/SPEC.md`](docs/SPEC.md)):

```
tunnel     up in ~1s, state=running                                 OK
hosts      seedUrl=http://127.0.0.1:<port>/?token=...               OK
sessions   HTTP 200 / 337 remote sessions                           OK
health     HTTP 200, status=200                                     OK
seed       HTTP 200 with the token-bearing URL                      OK
non-loopback request -> 403 rejected                                OK
tool render returns a ContentBlock array (0.2.x contract)           OK
```

The client half was loaded in Node against stubbed `window` / `document` / `react` and had
`apply(ctx)` called on it: it loads cleanly, declares the right `inject`, and registers into
the real `sidebar.footer.action` slot.

Honest unknowns: the embedded remote GUI **needs the browser to allow a same-site iframe** —
the harness's authenticated response carries neither `X-Frame-Options` nor a CSP
`frame-ancestors` (measured), so that layer is fine; what remains is whether the host
Electron session stores the cookie from that seed load. If you ever see
`dsh web authentication required` inside the iframe, report it — the fallback is a hidden
priming iframe followed by the real one.

---

## License

MIT
