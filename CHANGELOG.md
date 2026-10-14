# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
