/**
 * dsh-remote-gui —— 客户端半边（浏览器里跑）。
 *
 * 作用：在本地 DSH 界面里用 SSH 隧道把「远端 DSH 的 GUI」嵌进来，
 * 并把远端会话列在面板里。宿主半边（lib/index.js）负责隧道、凭据、RPC。
 *
 * ── 注册方式 ────────────────────────────────────────────────────────────────
 * 由宿主按 package.json 的 `dsh.client`（platform: web）扫描到，
 * 浏览器侧通过 `window.__ModuleLoader__.load({ id, factory })` 加载本文件，
 * 取 `module.exports = { apply, inject }`。`apply(ctx)` 里用 `ctx.effect(fn, label)`
 * 挂载带清理函数的副作用。
 *
 * ── 契约（与 SPEC.md 逐条对齐；不要改这里的路径）─────────────────────────────
 *   GET    /api/dsh-remote-gui/hosts            → { hosts: Host[] }
 *   POST   /api/dsh-remote-gui/hosts            ← { alias, name?, port?, localPort?, autoTunnel? }
 *                                               → { host: Host }
 *   DELETE /api/dsh-remote-gui/host?id=         → { ok: true }
 *   POST   /api/dsh-remote-gui/tunnel           ← { id, action: 'start'|'stop' }  → { tunnel: Tunnel }
 *   GET    /api/dsh-remote-gui/sessions?id=     → { sessions: Session[] }
 *   POST   /api/dsh-remote-gui/session-archive  ← { id, sessionId }               → { ok, archivedSessionIds }
 *   GET    /api/dsh-remote-gui/seed?id=         → { url: string }
 *   GET    /api/dsh-remote-gui/health?id=       → { id, tunnel, hostUp, status }
 *
 *   Host    = { id, alias, name, port, localPort, autoTunnel, tunnel?:Tunnel, seedUrl?:string }
 *   Tunnel  = { localPort, remotePort, alias, state:'starting'|'running'|'stopped', exitCode:number|null }
 *   Session = { sessionId, title:string|null, running:boolean, blank:boolean,
 *               updatedAt:number, cwd:string|null, turns:number|null }
 *
 * 说明：所有请求都是同源（本机 GUI 的 origin），不需要额外凭据。
 *      iframe 指向隧道端口 —— 那是**浏览器自己**发请求，所以要用带 token 的
 *      seedUrl 先加载一次，让远端把凭据 cookie 种进浏览器（详见 SPEC「seedUrl」）。
 */
window.__ModuleLoader__.load({ id: "dsh-remote-gui", factory: (require) => {
  var module = { exports: {} };
  var exports = module.exports;

  var React = require("react");
  var ReactDOM = require("react-dom/client");

  var h = React.createElement;
  var useState = React.useState;
  var useEffect = React.useEffect;
  var useCallback = React.useCallback;
  var useRef = React.useRef;

  /**
   * 宿主声明的依赖面：插槽 / 连接 / 语言。
   * ⚠️ 不要在这里加 betterSidebar —— 本机整套插件与 harness 本体都没有提供这个服务
   * （实测：app.asar 里 0 次命中，已装插件里无人注册）。cordis 的 inject 是**必需**
   * 依赖，列一个不存在的服务会让整个客户端半边永远不激活（面板根本不出现）。
   * 代码里对 ctx.betterSidebar 的用法已经做了可选降级。
   */
  var inject = ["slots", "connection", "locale"];

  var API = {
    hosts: "/api/dsh-remote-gui/hosts",
    host: "/api/dsh-remote-gui/host",
    tunnel: "/api/dsh-remote-gui/tunnel",
    sessions: "/api/dsh-remote-gui/sessions",
    archive: "/api/dsh-remote-gui/session-archive",
    seed: "/api/dsh-remote-gui/seed",
    health: "/api/dsh-remote-gui/health"
  };

  var HOSTS_POLL_MS = 12000;
  var SESSIONS_POLL_MS = 8000;
  var HEALTH_POLL_MS = 5000;

  // ── 小工具 ─────────────────────────────────────────────────────────────────

  function qs(url, params) {
    var pairs = [];
    for (var k in params) if (Object.prototype.hasOwnProperty.call(params, k)) {
      pairs.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
    }
    return pairs.length ? url + "?" + pairs.join("&") : url;
  }

  function getJson(url) {
    return fetch(url).then(function (r) { return r.json(); });
  }

  function sendJson(url, method, body) {
    return fetch(url, {
      method: method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) { return r.json(); });
  }

  /** 主机的稳定标识（契约里 id 必有，退路用 alias）。 */
  function hostId(host) {
    return host && (host.id || host.alias) || "";
  }

  function tunnelState(host) {
    return host && host.tunnel && host.tunnel.state || "stopped";
  }

  function stateLabel(state) {
    if (state === "running") return "已连接";
    if (state === "starting") return "连接中";
    return "未连接";
  }

  function stateColor(state) {
    if (state === "running") return "#3ecf6a";
    if (state === "starting") return "#e8b339";
    return "#9a9a9a";
  }

  function relTime(ts) {
    if (!ts) return "";
    var m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return "刚刚";
    if (m < 60) return m + " 分钟前";
    var hh = Math.floor(m / 60);
    if (hh < 24) return hh + " 小时前";
    var d = Math.floor(hh / 24);
    if (d < 7) return d + " 天前";
    return new Date(ts).toLocaleDateString();
  }

  /** 会话标题：title → cwd 末段 → sessionId 前 8 位。 */
  function sessionTitle(s) {
    if (s && s.title) return s.title;
    if (s && s.cwd) {
      var parts = String(s.cwd).split("/").filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
    return s && s.sessionId ? String(s.sessionId).slice(0, 8) : "(未知会话)";
  }

  function shortCwd(cwd) {
    if (!cwd) return "";
    var parts = String(cwd).split("/").filter(Boolean);
    if (parts.length <= 2) return "/" + parts.join("/");
    return "…/" + parts.slice(-2).join("/");
  }

  /** 错误对象 → 可读文字（宿主在失败时返回 {error}）。 */
  function errText(data, fallback) {
    if (!data) return fallback;
    if (typeof data.error === "string") return data.error;
    if (data.error && typeof data.error.message === "string") return data.error.message;
    return fallback;
  }

  // ── 目标：本地实例 ↔ 远端（SSH 隧道）────────────────────────────────────────
  // 同一个面板既能看本机这个 DSH，也能看经隧道的那台。差别只有两处：
  // 会话列表从哪取、iframe 指哪。

  var TARGET_LOCAL = "local";
  var TARGET_STORAGE_KEY = "dsh-remote-gui.target";

  /** 读回上次选择的目标；storage 不可用（隐私模式等）时退回「本地实例」。 */
  function readStoredTarget() {
    try {
      var v = window.localStorage.getItem(TARGET_STORAGE_KEY);
      return v ? String(v) : TARGET_LOCAL;
    } catch (e) {
      return TARGET_LOCAL;
    }
  }

  /** 记住选择；storage 不可用时静默忽略。 */
  function writeStoredTarget(value) {
    try { window.localStorage.setItem(TARGET_STORAGE_KEY, String(value)); } catch (e) { /* 忽略 */ }
  }

  /**
   * 服务端会话条目 → 面板统一形状。
   * 字段与宿主半边（lib/index.js 的 session/list 映射）逐字一致：
   * 远端和本地是同一份服务端代码，所以两边可以共用这一个映射与同一套行渲染。
   */
  function mapSessionItem(s) {
    var values = s && s.projections && s.projections.values;
    return {
      sessionId: s && s.sessionId,
      title: (values && values.title) || null,
      running: !!(s && s.running),
      blank: !!(s && s.blank),
      updatedAt: s && s.updatedAt,
      cwd: (s && s.cwd) || null,
      turns: (values && values.sessionStats && values.sessionStats.turns) || null
    };
  }

  /**
   * 本地实例的会话列表：**相对路径**打 GUI 自己的 origin（同源，凭据天然带着），
   * 信封与远端完全一致，数据同样在 result.value.items。
   * ⚠️ 本地分支不碰宿主的远端路由（那些 /api/dsh-remote-gui/* 是隧道通道）。
   */
  function fetchLocalSessions() {
    return fetch("/api/session/list", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "local-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
        method: "session/list",
        payload: { args: { _request: {} } }
      })
    }).then(function (r) {
      return r.json();
    }).then(function (data) {
      var result = data && data.result;
      if (!result || result.ok !== true) {
        throw new Error(errText({ error: result && result.error }, "本地会话 RPC 失败"));
      }
      var items = (result.value && result.value.items) || [];
      return items.map(mapSessionItem);
    });
  }

  // ── 面板 ───────────────────────────────────────────────────────────────────

  function RemoteGuiPanel() {
    var hostsState = useState([]);
    var hosts = hostsState[0];
    var setHosts = hostsState[1];

    var loadingState = useState(true);
    var setLoading = loadingState[1];

    var errorState = useState(null);
    var error = errorState[0];
    var setError = errorState[1];

    var aliasState = useState("");
    var alias = aliasState[0];
    var setAlias = aliasState[1];

    var sessionsState = useState({});
    var sessionsByHost = sessionsState[0];
    var setSessionsByHost = sessionsState[1];

    var healthState = useState({});
    var healthByHost = healthState[0];
    var setHealthByHost = healthState[1];

    var seedState = useState({});
    var seedByHost = seedState[0];
    var setSeedByHost = seedState[1];

    var busyState = useState(null);
    var busy = busyState[0];
    var setBusy = busyState[1];

    var frameNonceState = useState(0);
    var frameNonce = frameNonceState[0];
    var setFrameNonce = frameNonceState[1];

    // 目标：TARGET_LOCAL 或某台远端主机的 id（持久化在 localStorage）
    var targetState = useState(readStoredTarget);
    var target = targetState[0];
    var setTarget = targetState[1];

    var localSessionsState = useState([]);
    var localSessions = localSessionsState[0];
    var setLocalSessions = localSessionsState[1];

    var localErrorState = useState(null);
    var localError = localErrorState[0];
    var setLocalError = localErrorState[1];

    /** 切换目标并记住它。 */
    var selectTarget = useCallback(function (next) {
      setTarget(next);
      writeStoredTarget(next);
    }, []);

    var mountedRef = useRef(true);
    useEffect(function () {
      mountedRef.current = true;
      return function () { mountedRef.current = false; };
    }, []);

    // 主机列表：挂载时拉一次，之后定时刷新
    var refreshHosts = useCallback(function () {
      return getJson(API.hosts).then(function (data) {
        if (!mountedRef.current) return;
        if (Array.isArray(data && data.hosts)) {
          setHosts(data.hosts);
          setError(null);
        } else {
          setError(errText(data, "读取主机列表失败"));
        }
      }).catch(function (e) {
        if (mountedRef.current) setError(String(e));
      }).then(function () {
        if (mountedRef.current) setLoading(false);
      });
    }, []);

    useEffect(function () {
      void refreshHosts();
      var timer = window.setInterval(function () { void refreshHosts(); }, HOSTS_POLL_MS);
      return function () { window.clearInterval(timer); };
    }, [refreshHosts]);

    // 目标解析：
    //   目标 = local            → 本地模式
    //   目标指向仍存在的主机     → 远端模式（就那台）
    //   目标指向已删除的主机     → 主机列表读完后回落到本地模式（下面用 effect 纠正持久化值）
    var targetIsRemote = target !== TARGET_LOCAL;
    var activeHost = null;
    if (targetIsRemote) {
      for (var i = 0; i < hosts.length; i++) {
        if (hostId(hosts[i]) === target) { activeHost = hosts[i]; break; }
      }
    }
    // 主机列表还没读完时不要急着判定"目标不见了"，避免开面板瞬间先嵌本地再换远端
    var isLocalTarget = !targetIsRemote || (!loading && activeHost === null);
    var activeHostKey = activeHost ? hostId(activeHost) : "";

    // 目标主机已被删除 → 把持久化值纠正回「本地实例」（只会在确定后触发一次）
    useEffect(function () {
      if (targetIsRemote && !loading && activeHost === null) selectTarget(TARGET_LOCAL);
    }, [targetIsRemote, loading, activeHost, selectTarget]);

    // 健康检查：只查隧道在跑的主机
    useEffect(function () {
      var timer = window.setInterval(function () {
        hosts.forEach(function (host) {
          if (tunnelState(host) !== "running") return;
          var id = hostId(host);
          getJson(qs(API.health, { id: id })).then(function (d) {
            if (!mountedRef.current) return;
            setHealthByHost(function (prev) {
              var next = {};
              for (var k in prev) if (Object.prototype.hasOwnProperty.call(prev, k)) next[k] = prev[k];
              next[id] = { hostUp: !!(d && d.hostUp), status: d && d.status };
              return next;
            });
          }).catch(function () { /* 健康检查失败不影响主流程 */ });
        });
      }, HEALTH_POLL_MS);
      return function () { window.clearInterval(timer); };
    }, [hosts]);

    // 远端会话：Tunnel 在跑的主机都拉一次
    var refreshSessions = useCallback(function () {
      hosts.forEach(function (host) {
        if (tunnelState(host) !== "running") return;
        var id = hostId(host);
        getJson(qs(API.sessions, { id: id })).then(function (d) {
          if (!mountedRef.current) return;
          if (d && Array.isArray(d.sessions)) {
            setSessionsByHost(function (prev) {
              var next = {};
              for (var k in prev) if (Object.prototype.hasOwnProperty.call(prev, k)) next[k] = prev[k];
              next[id] = d.sessions;
              return next;
            });
          }
        }).catch(function () { /* 会话列表失败：面板显示"读取中/不可用"，不打断 UI */ });
      });
    }, [hosts]);

    useEffect(function () {
      void refreshSessions();
      var timer = window.setInterval(function () { void refreshSessions(); }, SESSIONS_POLL_MS);
      return function () { window.clearInterval(timer); };
    }, [refreshSessions]);

    // 本地实例的会话：**只在选中「本地实例」且主机列表已读完时**轮询；
    // 切走时把定时器清掉并置 cancelled，保证不会有留在后台跑的本地轮询。
    useEffect(function () {
      if (!isLocalTarget || loading) return undefined;
      var cancelled = false;
      var load = function () {
        fetchLocalSessions().then(function (list) {
          if (cancelled || !mountedRef.current) return;
          setLocalSessions(list);
          setLocalError(null);
        }).catch(function (e) {
          if (cancelled || !mountedRef.current) return;
          setLocalError(e && e.message ? e.message : String(e));
        });
      };
      load();
      var timer = window.setInterval(load, SESSIONS_POLL_MS);
      return function () {
        cancelled = true;
        window.clearInterval(timer);
      };
    }, [isLocalTarget, loading]);

    // iframe 的种子地址：宿主在 hosts 里给 seedUrl 时直接用；
    // 万一没给（或过期），用 /seed 现取一次，让远端把凭据 cookie 种进浏览器。
    useEffect(function () {
      if (!activeHost) return;
      if (tunnelState(activeHost) !== "running") return;
      if (activeHost.seedUrl) return;
      var id = hostId(activeHost);
      if (seedByHost[id]) return;
      getJson(qs(API.seed, { id: id })).then(function (d) {
        if (!mountedRef.current) return;
        if (d && typeof d.url === "string" && d.url) {
          setSeedByHost(function (prev) {
            var next = {};
            for (var k in prev) if (Object.prototype.hasOwnProperty.call(prev, k)) next[k] = prev[k];
            next[id] = d.url;
            return next;
          });
        }
      }).catch(function () { /* 拿不到种子地址就退回裸地址 */ });
    }, [activeHostKey, activeHost && activeHost.seedUrl, activeHost && tunnelState(activeHost)]);

    function withBusy(key, fn) {
      setBusy(key);
      return Promise.resolve()
        .then(fn)
        .catch(function (e) { if (mountedRef.current) setError(String(e)); })
        .then(function () { if (mountedRef.current) setBusy(null); });
    }

    function addHost() {
      var value = alias.trim();
      if (!value) return;
      void withBusy("add", function () {
        return sendJson(API.hosts, "POST", { alias: value }).then(function (d) {
          if (!mountedRef.current) return;
          if (d && d.host) {
            setAlias("");
            setError(null);
            selectTarget(hostId(d.host));
            return refreshHosts();
          }
          setError(errText(d, "添加主机失败"));
        });
      });
    }

    function toggleTunnel(host) {
      var id = hostId(host);
      var running = tunnelState(host) === "running" || tunnelState(host) === "starting";
      void withBusy("tunnel:" + id, function () {
        return sendJson(API.tunnel, "POST", { id: id, action: running ? "stop" : "start" })
          .then(function (d) {
            if (!mountedRef.current) return;
            if (d && d.error) setError(errText(d, "隧道操作失败"));
            return refreshHosts();
          });
      });
    }

    function removeHost(host) {
      var label = host.name || host.alias;
      if (!window.confirm("删除远程主机「" + label + "」？\n（隧道会断开；主机记录从注册表移除）")) return;
      var id = hostId(host);
      void withBusy("remove:" + id, function () {
        return sendJson(qs(API.host, { id: id }), "DELETE").then(function (d) {
          if (!mountedRef.current) return;
          if (d && d.ok === false) setError(errText(d, "删除失败"));
          if (target === id) selectTarget(TARGET_LOCAL);
          return refreshHosts();
        });
      });
    }

    function archiveSession(host, session) {
      var id = hostId(host);
      if (!window.confirm("归档远端会话「" + sessionTitle(session) + "」？")) return;
      void withBusy("archive:" + session.sessionId, function () {
        return sendJson(API.archive, "POST", { id: id, sessionId: session.sessionId }).then(function (d) {
          if (!mountedRef.current) return;
          if (d && d.ok) {
            setSessionsByHost(function (prev) {
              var next = {};
              for (var k in prev) if (Object.prototype.hasOwnProperty.call(prev, k)) next[k] = prev[k];
              next[id] = (prev[id] || []).filter(function (s) { return s.sessionId !== session.sessionId; });
              return next;
            });
            return refreshSessions();
          }
          setError(errText(d, "归档失败"));
        });
      });
    }

    // ── 样式（只用内联 style + CSS 变量，不引外部 CSS）──────────────────────
    var sep = "var(--dsw-alias-separator-primary, rgba(128,128,128,.22))";
    var labelPrimary = "var(--dsw-alias-label-primary, #e6e6e6)";
    var labelSecond = "var(--dsw-alias-label-secondary, #9aa4b2)";
    var labelThird = "var(--dsw-alias-label-tertiary, #8a93a6)";
    var accent = "var(--dsw-alias-brand-primary, var(--dsh-accent, #4a7dff))";
    var hoverBg = "var(--dsw-specific-sidebar-nav-item-hover, rgba(128,128,128,.12))";

    var styles = {
      wrap: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, color: labelPrimary },
      bar: { display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "1px solid " + sep, flexWrap: "wrap" },
      input: {
        flex: "1 1 200px", minWidth: 0, padding: "6px 9px", borderRadius: 7,
        border: "1px solid " + sep, background: "transparent", color: "inherit", font: "inherit"
      },
      primaryBtn: { padding: "6px 12px", borderRadius: 7, border: "none", background: accent, color: "#fff", cursor: "pointer", font: "inherit", flexShrink: 0 },
      ghostBtn: { padding: "5px 10px", borderRadius: 6, border: "1px solid " + sep, background: "transparent", color: "inherit", cursor: "pointer", font: "inherit", fontSize: 12 },
      dangerBtn: { padding: "5px 10px", borderRadius: 6, border: "1px solid " + sep, background: "transparent", color: "#e07171", cursor: "pointer", font: "inherit", fontSize: 12 },
      sectionTitle: { display: "flex", alignItems: "center", gap: 8, padding: "8px 14px 4px", fontSize: 12, color: labelSecond },
      hostsBox: { padding: "4px 10px 8px", overflow: "auto", maxHeight: "34%", borderBottom: "1px solid " + sep },
      card: { border: "1px solid " + sep, borderRadius: 9, padding: "8px 10px", marginBottom: 6, cursor: "pointer" },
      row: { display: "flex", alignItems: "center", gap: 8 },
      dot: { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 },
      name: { fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      alias: { fontSize: 11, color: labelThird, flexShrink: 0 },
      meta: { fontSize: 11, color: labelThird, marginTop: 3 },
      actions: { display: "flex", gap: 6, marginTop: 7, flexWrap: "wrap" },
      sessionsBox: { padding: "2px 10px 8px", overflow: "auto", maxHeight: "30%", borderBottom: "1px solid " + sep },
      sessionRow: { display: "flex", alignItems: "center", gap: 8, padding: "6px 6px", borderRadius: 7, fontSize: 12 },
      sessionTitle: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      sessionMeta: { fontSize: 11, color: labelThird, flexShrink: 0 },
      frameWrap: { flex: 1, minHeight: 0, display: "flex", position: "relative", background: "#fff" },
      frame: { flex: 1, border: 0, minHeight: 0, width: "100%" },
      hint: { fontSize: 11, color: labelThird, padding: "10px 14px" },
      chip: {
        padding: "4px 10px",
        borderRadius: 999,
        border: "1px solid " + sep,
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        font: "inherit",
        fontSize: 12,
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        gap: 5
      },
      chipOn: {
        borderColor: accent,
        background: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16))",
        fontWeight: 600
      },
      badge: {
        marginLeft: "auto",
        flexShrink: 0,
        fontSize: 11,
        padding: "2px 9px",
        borderRadius: 999,
        background: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16))",
        color: labelSecond,
        whiteSpace: "nowrap"
      },
      err: { color: "#e07171", fontSize: 12, padding: "8px 14px 0" },
      empty: { fontSize: 12, color: labelThird, padding: "10px 6px" }
    };

    // 会话数据源：本地模式取本地列表；远端模式取宿主代取的远端列表
    var currentSessions = isLocalTarget
      ? localSessions
      : ((activeHost && sessionsByHost[activeHostKey]) || []);

    // iframe 目标：
    //   本地模式 → location.origin（同源，不需要隧道、也不需要凭据兑换）
    //   远端模式 → seedUrl（带 token，先把凭据 cookie 种进浏览器）→ /seed 现取 → 裸隧道地址
    //   （主机列表还没读完且目标是远端时，frameSrc 保持空 —— 避免先嵌本地再换成远端）
    var frameSrc = "";
    if (isLocalTarget) {
      frameSrc = location.origin;
    } else if (activeHost && tunnelState(activeHost) === "running") {
      frameSrc = activeHost.seedUrl || seedByHost[activeHostKey] ||
        ("http://127.0.0.1:" + activeHost.tunnel.localPort + "/");
    }

    /** 当前目标的显示名（面板里一眼看出本地还是远端）。 */
    var targetLabel = isLocalTarget
      ? "本地实例"
      : ("远端 · " + ((activeHost && (activeHost.name || activeHost.alias)) || "…"));

    return h("div", { style: styles.wrap },

      // 顶部：添加主机 + 刷新
      h("div", { style: styles.bar },
        h("input", {
          style: styles.input,
          placeholder: "远端地址（SSH 别名，如 my-server）",
          value: alias,
          spellCheck: false,
          onChange: function (e) { setAlias(e.target.value); },
          onKeyDown: function (e) { if (e.key === "Enter") addHost(); }
        }),
        h("button", {
          style: styles.primaryBtn,
          onClick: addHost,
          disabled: busy === "add" || !alias.trim()
        }, busy === "add" ? "添加中…" : "添加"),
        h("button", {
          style: styles.ghostBtn,
          onClick: function () { void refreshHosts(); void refreshSessions(); }
        }, "刷新")
      ),

      // 目标选择器：本地实例 / 每台已注册的远端主机（选择持久化在 localStorage）
      h("div", { style: styles.bar },
        h("span", { style: { fontSize: 12, color: labelSecond, flexShrink: 0 } }, "目标"),
        h("button", {
          type: "button",
          style: Object.assign({}, styles.chip, isLocalTarget ? styles.chipOn : null),
          title: "本机这个 DSH 实例（同源，不需要隧道）",
          onClick: function () { selectTarget(TARGET_LOCAL); }
        }, "本地实例"),
        hosts.map(function (host) {
          var id = hostId(host);
          var on = !isLocalTarget && activeHostKey === id;
          return h("button", {
            key: id,
            type: "button",
            style: Object.assign({}, styles.chip, on ? styles.chipOn : null),
            title: "远端 · " + host.alias + "（经 SSH 隧道）",
            onClick: function () { selectTarget(id); }
          },
            h("span", { style: Object.assign({}, styles.dot, { background: stateColor(tunnelState(host)) }) }),
            host.name || host.alias
          );
        }),
        h("span", { style: styles.badge }, "当前：" + targetLabel)
      ),

      error ? h("div", { style: styles.err }, error) : null,

      // 主机列表
      h("div", { style: styles.sectionTitle },
        h("span", null, "远端主机"),
        h("span", { style: { color: labelThird } }, hosts.length ? "共 " + hosts.length + " 台" : "")
      ),
      h("div", { style: styles.hostsBox },
        hosts.map(function (host) {
          var id = hostId(host);
          var state = tunnelState(host);
          var running = state === "running";
          var up = healthByHost[id] && healthByHost[id].hostUp;
          var isActive = !isLocalTarget && activeHostKey === id;
          var hostSessions = sessionsByHost[id] || [];
          var runningCount = hostSessions.filter(function (s) { return s.running; }).length;
          var healthText = "";
          if (running) {
            healthText = up ? " · 在线" : " · 隧道通（HTTP " + ((healthByHost[id] && healthByHost[id].status) || "…") + "）";
          }
          return h("div", {
            key: id,
            style: Object.assign({}, styles.card, {
              borderColor: isActive ? accent : sep,
              background: isActive ? hoverBg : "transparent"
            }),
            onClick: function () { selectTarget(id); }
          },
            h("div", { style: styles.row },
              h("span", { style: Object.assign({}, styles.dot, { background: stateColor(state) }) }),
              h("span", { style: styles.name }, host.name || host.alias),
              h("span", { style: styles.alias }, host.alias),
              h("span", { style: { marginLeft: "auto", fontSize: 11, color: labelSecond, flexShrink: 0 } }, stateLabel(state))
            ),
            h("div", { style: styles.meta },
              "远端 :" + host.port + " → 本地 :" + host.localPort + healthText
            ),
            running ? h("div", { style: styles.meta },
              hostSessions.length ? hostSessions.length + " 个远端会话 · " + runningCount + " 运行中" : "正在读取远端会话…"
            ) : null,
            h("div", { style: styles.actions },
              h("button", {
                style: styles.ghostBtn,
                disabled: busy === "tunnel:" + id,
                onClick: function (e) { e.stopPropagation(); toggleTunnel(host); }
              }, busy === "tunnel:" + id ? "处理中…" : (running || state === "starting" ? "停止隧道" : "启动隧道")),
              h("button", {
                style: styles.ghostBtn,
                disabled: !running,
                onClick: function (e) { e.stopPropagation(); setFrameNonce(frameNonce + 1); }
              }, "重载界面"),
              h("button", {
                style: styles.dangerBtn,
                disabled: busy === "remove:" + id,
                onClick: function (e) { e.stopPropagation(); removeHost(host); }
              }, "删除")
            )
          );
        }),
        hosts.length === 0 && !loading ? h("div", { style: styles.empty }, "还没有远端主机 —— 在上面填 SSH 别名后点「添加」") : null,
        hosts.length === 0 && loading ? h("div", { style: styles.empty }, "读取中…") : null
      ),

      // 会话列表（当前目标：本地实例 或 远端主机）
      h("div", { style: styles.sectionTitle },
        h("span", null, isLocalTarget ? "本地会话" : "远端会话"),
        h("span", { style: { color: labelThird } }, targetLabel + " · " + currentSessions.length + " 个")
      ),
      h("div", { style: styles.sessionsBox },
        // —— 本地实例 ——
        isLocalTarget && localError ? h("div", { style: styles.empty }, "读取本地会话失败：" + localError) : null,
        isLocalTarget && !localError && currentSessions.length === 0
          ? h("div", { style: styles.empty }, "本地还没有会话") : null,
        // —— 远端主机 ——
        !isLocalTarget && !activeHost ? h("div", { style: styles.empty }, "先添加并连接一台远端主机") : null,
        !isLocalTarget && activeHost && tunnelState(activeHost) !== "running"
          ? h("div", { style: styles.empty }, "隧道未启动 —— 点上面的「启动隧道」") : null,
        !isLocalTarget && activeHost && tunnelState(activeHost) === "running" && currentSessions.length === 0
          ? h("div", { style: styles.empty }, "没有读到远端会话（或远端还没有会话）") : null,
        currentSessions.map(function (s) {
          return h("div", { key: s.sessionId, style: styles.sessionRow },
            h("span", { style: Object.assign({}, styles.dot, { background: s.running ? "#3ecf6a" : "#9a9a9a" }) }),
            h("span", { style: styles.sessionTitle, title: (s.cwd || "") + "\n" + s.sessionId }, sessionTitle(s)),
            s.cwd ? h("span", { style: styles.sessionMeta }, shortCwd(s.cwd)) : null,
            h("span", { style: styles.sessionMeta }, s.running ? "运行中" : relTime(s.updatedAt)),
            // 归档走的是宿主的远端通道，所以只在远端模式给按钮（本地分支不碰那条路由）
            isLocalTarget ? null : h("button", {
              style: Object.assign({}, styles.ghostBtn, { border: "none", color: "#e07171", padding: "0 4px" }),
              title: "归档此会话",
              disabled: busy === "archive:" + s.sessionId,
              onClick: function () { archiveSession(activeHost, s); }
            }, "归档")
          );
        })
      ),

      // 内嵌 GUI：本地实例 = 本机 origin；远端 = 隧道（seedUrl → /seed 兜底 → 裸地址）
      frameSrc
        ? h("div", { style: styles.frameWrap },
            h("iframe", {
              // key 里带上目标：切换目标时 React 会把旧 iframe 卸载掉，不留后台页面
              key: (isLocalTarget ? "local" : activeHostKey) + ":" + frameNonce,
              style: styles.frame,
              src: frameSrc,
              title: targetLabel + " GUI"
            })
          )
        : h("div", { style: styles.hint },
            isLocalTarget
              ? "准备本地界面…"
              : (activeHost && tunnelState(activeHost) === "running"
                  ? "准备远端界面…"
                  : "隧道启动后，远端的 DSH 界面会嵌在这里"))
    );
  }

  // ── 覆盖层面板（纯 DOM 外壳 + React 内容）───────────────────────────────────

  var overlay = null;      // { el, root }
  var overlayListeners = [];   // 页脚按钮订阅"面板开关"，用来同步自己的高亮态

  /** 通知所有页脚订阅者：覆盖层面板开了/关了。 */
  function notifyOverlayChanged() {
    for (var i = 0; i < overlayListeners.length; i++) {
      try { overlayListeners[i](overlay !== null); } catch (e) { /* 单个订阅者出错不影响其它 */ }
    }
  }

  function toggleOverlay(open) {
    if (typeof document === "undefined") return;
    if (open && overlay === null) {
      var el = document.createElement("div");
      el.dataset.dshRemoteGuiOverlay = "";
      el.style.cssText = "position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;" +
        "background:var(--dsw-alias-bg-base, var(--dsh-bg, #101014));color:var(--dsw-alias-label-primary, #e6e6e6)";

      var head = document.createElement("div");
      head.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;" +
        "padding:10px 16px;border-bottom:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,.22));font-weight:600";
      var title = document.createElement("span");
      title.textContent = "远程 GUI（SSH 隧道）";
      var close = document.createElement("button");
      close.type = "button";
      close.textContent = "✕ 关闭";
      close.style.cssText = "background:transparent;border:none;color:inherit;font:inherit;font-size:13px;cursor:pointer;padding:4px 10px;border-radius:6px";
      close.addEventListener("click", function () { toggleOverlay(false); });
      head.appendChild(title);
      head.appendChild(close);

      var body = document.createElement("div");
      body.style.cssText = "flex:1;min-height:0;display:flex;flex-direction:column";

      el.appendChild(head);
      el.appendChild(body);
      document.body.appendChild(el);

      var root = ReactDOM.createRoot(body);
      root.render(h(RemoteGuiPanel));
      overlay = { el: el, root: root };
    } else if (!open && overlay !== null) {
      try { overlay.root.unmount(); } catch (e) { /* 忽略卸载异常 */ }
      overlay.el.remove();
      overlay = null;
    }
    notifyOverlayChanged();
  }

  // ── 侧栏页脚入口（图标按钮）─────────────────────────────────────────────────

  /** 页脚那个小图标（用 React 元素画的内联 SVG；不注入 HTML、不依赖外层 DOM）。 */
  function footerIcon() {
    return h("svg", {
      viewBox: "0 0 16 16",
      width: 15,
      height: 15,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.3,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true"
    },
      h("rect", { x: 2.2, y: 2.8, width: 11.6, height: 8, rx: 1.2 }),
      h("path", { d: "M6.2 13.6h3.6M8 10.8v2.8" })
    );
  }

  /**
   * 页脚入口按钮 —— 由 apply() 注册进 `sidebar.footer.action` 插槽。
   * 只渲染自己这一个图标按钮：不读也不写外层 DOM，样式全部内联。
   * 点击开/关覆盖层面板；面板打开时通过 overlayListeners 订阅来高亮自己。
   */
  function FooterEntry() {
    var activeState = useState(overlay !== null);
    var active = activeState[0];
    var setActive = activeState[1];

    useEffect(function () {
      var listener = function (open) { setActive(open); };
      overlayListeners.push(listener);
      setActive(overlay !== null);
      return function () {
        var i = overlayListeners.indexOf(listener);
        if (i >= 0) overlayListeners.splice(i, 1);
      };
    }, []);

    return h("button", {
      type: "button",
      "data-dsh-remote-gui-entry": "",
      "data-active": active ? "true" : undefined,
      "aria-label": "远程 GUI",
      "aria-expanded": active ? "true" : "false",
      title: "远程 GUI（SSH 隧道）",
      onClick: function () { toggleOverlay(overlay === null); },
      style: {
        width: 30,
        height: 30,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        flex: "none",
        border: "none",
        borderRadius: 8,
        cursor: "pointer",
        color: "inherit",
        background: active
          ? "var(--dsw-specific-sidebar-nav-item-hover, rgba(128,128,128,.18))"
          : "transparent"
      }
    }, footerIcon());
  }

  // ── 插件入口 ───────────────────────────────────────────────────────────────

  function apply(ctx) {
    function fail(phase, error) {
      // 只记录，不抛出：客户端半边挂掉不应该影响本地 GUI 其它部分
      try { console.error("[dsh-remote-gui] " + phase + " error:", error); } catch (e) { /* noop */ }
    }

    // 页脚入口：注册进正规插槽 `sidebar.footer.action`（不再做 DOM 注入）。
    // 形态照已验证可用的 @linxin666/dsh-remote-web-ui：
    //   ctx.slots.inject(slotName, () => ctx.slots.register({ name, id }, Component))
    try {
      ctx.effect(function () {
        var disposedEntry = null;
        var disposeInject = ctx.slots.inject("sidebar.footer.action", function () {
          try {
            disposedEntry = ctx.slots.register({
              name: "sidebar.footer.action",
              id: "dsh-remote-gui"
            }, FooterEntry);
          } catch (error) {
            fail("slots.register sidebar.footer.action", error);
            disposedEntry = null;
          }
          return function () {
            if (typeof disposedEntry === "function") {
              try { disposedEntry(); } catch (e) { /* noop */ }
              disposedEntry = null;
            }
          };
        });
        return function () {
          if (typeof disposedEntry === "function") {
            try { disposedEntry(); } catch (e) { /* noop */ }
            disposedEntry = null;
          }
          if (typeof disposeInject === "function") {
            try { disposeInject(); } catch (e) { /* noop */ }
          }
        };
      }, "dsh-remote-gui: footer entry");
    } catch (error) {
      fail("footer entry", error);
    }

    // 侧栏标签页（可选增强）：宿主提供 betterSidebar 时把面板挂成一个真正的标签页
    try {
      ctx.effect(function () {
        var sidebar = ctx.betterSidebar;
        if (!sidebar || typeof sidebar.registerTab !== "function") return undefined;
        try {
          return sidebar.registerTab({
            id: "dsh-remote-gui",
            title: function () { return "远程 GUI"; },
            order: 91,
            single: true,
            component: function () { return h(RemoteGuiPanel); }
          });
        } catch (error) {
          fail("registerTab", error);
          return undefined;
        }
      }, "dsh-remote-gui: register tab");
    } catch (error) {
      fail("betterSidebar", error);
    }
  }

  module.exports = { apply: apply, inject: inject };
  return module.exports;
}});
