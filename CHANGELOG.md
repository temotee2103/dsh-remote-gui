# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-10-14

### Fixed

- **Archiving a remote session never worked.** `remoteRpc()` hard-coded the RPC envelope as
  `payload.args._request`, but `_request` is the parameter name of `session/list` only —
  `workspace/archiveSession` declares `request`. The remote answered
  `result.ok=false`, `error.code='gateway/arguments-invalid'`,
  `missing "request"; unexpected "_request"`, the route turned that into 502, and the panel
  just looked unresponsive. The key is now chosen per method: `lib/remote.js` carries
  `ARGS_KEY_BY_METHOD` (+ an `argsKey` option) and the archive call site passes
  `argsKey: 'request'` explicitly. Verified against a real remote over the tunnel:
  wrong key → `gateway/arguments-invalid`; right key → `ok=true` with `archivedSessionIds`;
  `POST /api/dsh-remote-gui/session-archive` → HTTP 200 instead of 502.
  The docs had taught the wrong rule (`args` must contain `_request`) — SPEC.md, both READMEs
  and docs/client-notes.md now state the real contract and where to read it.
- **The panel could not be dismissed** (users had to restart the app). The overlay was a
  full-screen modal whose only exit was a small borderless `✕ 关闭` button that inherited its
  colour from a theme variable it could not rely on. It is now a non-modal right-hand drawer:
  an explicit, ≥32px-tall, outlined close button with a visible label, `Esc`, click-on-scrim,
  and the footer icon toggles it. Closing removes the drawer and the scrim, drops the keydown
  listener, and restores the body's inline `overflow` to exactly what it was.
- **The「添加」button rendered as a blank white block.** `primaryBtn` hard-coded
  `color: "#fff"` while its background came from the theme variable
  `--dsw-alias-brand-primary`, and the disabled state had no styling of its own — in a theme
  where that variable resolves pale (and with the browser's default disabled grey), white text
  landed on a white fill. The disabled state now has an explicit pair (translucent chip fill +
  secondary label colour) and a border; the input's text colour no longer relies on `inherit`.
- **Nested-instance startup.** The default target was `local`, so the panel embedded the local
  instance inside itself via `location.origin`, showing a frozen "Loading plugins…" page.
  The default is now the first registered remote host (a previous choice still wins, and only
  a hostless install falls back to local), and local mode no longer embeds anything — it shows
  a note instead. The local session list is unchanged.

## [0.1.2] - 2026-10-14

### Fixed

- **The panel never rendered.** `client.js` read a `loading` variable that was never
  declared, so `RemoteGuiPanel` threw `ReferenceError: loading is not defined` while
  evaluating the dependency array of a `useEffect` — on every render, for every target,
  leaving the overlay with a title bar and an empty body. Found by loading the plugin in a
  throwaway profile and actually opening the panel; the test suite calls `apply()` but never
  renders the component, so it could not catch this.
- `screenshots.json` lists raw.githubusercontent URLs instead of `{path, caption}` objects:
  dsh-market's renderer only accepts strings and silently drops anything else.

### Added

- Screenshots of the footer entry, the panel, and the panel pointed at a remote host.

## [0.1.1] - 2026-10-14

Packaging and documentation only -- no behaviour change beyond one retry.

### Added

- Test suite (`node --test`, no dependencies) covering the RPC envelope, the
  credential exchange and its 401 refresh, the loopback fence, the session field
  mapping and the client half's slot registration — 15 tests against a local mock
  remote, plus a CI workflow that runs them on push and pull request.
- English README, this changelog, and `docs/` for the remote contract and the
  client handoff notes.
- `.github/workflows/ci.yml`.

### Fixed

- The npm tarball listed a `SPEC.md` that had moved to `docs/`, so the contract
  document referenced from both READMEs would have been missing from the next
  release.
- A remote launch-token read that comes back empty right after a tunnel is
  established is retried once instead of leaving the embedded GUI on the remote's
  401 page.
- The test invocation used the directory form of `node --test`, which Node 22
  rejects; the suite now uses auto-discovery.

### Changed

- The host half is split into `registry` / `tunnel` / `remote` / `routes` /
  `tool` modules behind an unchanged public export set; `lib/index.js` is now
  just the composition root.
- Remote session polling slows to once a minute while the local instance is
  selected, instead of a remote RPC per host every 8 seconds.

## [0.1.0] - 2026-10-14

First release.

### Added

- **SSH tunnel management** — starts `ssh -L <local port>:127.0.0.1:<remote port> <alias>`
  per registered host, with a 15-second watchdog that reconnects a dropped tunnel, and
  adoption of a tunnel that is still listening after a host restart instead of spawning a
  duplicate.
- **Automatic remote credential exchange** — reads the remote `dsh web` launch token over
  ssh, exchanges it through the tunnel for the authority-bound browser cookie the remote
  requires on every `/api` call, caches it per host, and refreshes + retries once on
  401/403.
- **Remote session list** — renders the remote sessions returned by `/api/session/list`
  (title, last activity, `cwd`, running state) in the panel.
- **Embedded remote GUI** — an iframe pointed at the tunnel, where the first load uses a
  token-bearing `seedUrl` so the remote's 303 plants the credential cookie in the browser
  and subsequent loads use the plain tunnel URL.
- **Local ↔ remote switching** — a target selector for the local instance or any registered
  remote, persisted in `localStorage`; local mode calls the same-origin
  `/api/session/list` and points the iframe at `location.origin`.
- **Session archive** from the panel, through the remote's `workspace/archiveSession`.
- **Agent tool `remote_gui_run_task`** — runs a one-shot task on a remote host over
  `ssh + dsh --profile headless` and returns its result, with `output.render` returning a
  ContentBlock array as the 0.2.x tool contract requires.
- **Eight distinct loopback-only routes** under `/api/dsh-remote-gui/` (hosts, host, tunnel,
  health, sessions, session-archive, seed, proxy) — nine table rows, since `/hosts` serves both
  GET and POST — plus the host registry at `$DSH_HOME/remote-gui-hosts.json`.
- **Implements the DSH 0.2.x credential and typert RPC contract** — the authority-bound
  browser cookie, the `/api/<ns>/<method>` path with the `payload.args._request` envelope,
  and data read from `result.value`.

### Fixed

- The remote launch token is cached with a TTL and cleared together with the credential
  cookie on 401/403, so a remote restart no longer leaves a stale `seedUrl` whose token the
  remote rejects (which showed up as a 401 page inside the panel's iframe).
- The sidebar entry registers through the `sidebar.footer.action` slot instead of injecting
  DOM nodes and watching the sidebar with a `MutationObserver`.
- The client `inject` list no longer names a service that is absent on the host, which
  otherwise prevents the entire client half from activating.
