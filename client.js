/**
 * dsh-remote-gui —— 客户端半边（浏览器里跑）。
 *
 * 作用：在**本地这个正常界面里**用远端 DSH 的会话 —— 列远端会话、点开读它的
 * 对话正文、在里面输入并发送、新建远端会话。**没有任何 iframe / 嵌套网页。**
 * 宿主半边（lib/index.js / lib/routes.js）负责隧道、凭据、远端 RPC。
 *
 * ── 形态 ────────────────────────────────────────────────────────────────────
 * 中心列的原生面板，走宿主自己的两个插槽（与 @linxin666/dsh-task-board、
 * @linxin666/dsh-ssh 用的是同一套、已被验证的形态）：
 *   sidebar.panellist  id = 'dsh-remote-gui'   ← 侧栏图标行（外壳拥有按钮/高亮/收起态）
 *   main              key = 'dsh-remote-gui'   ← 中心列页面（同 key 才会被切到）
 *   sidebar.footer.action id = 'dsh-remote-gui' ← 页脚小入口（点它也是切到上面的主面板）
 * 所以它**不盖住左侧栏、没有遮罩、没有滚动锁**；关闭 = 让主列切回 'conversation'
 * （✕ / Esc / 或直接点侧栏里的会话）。切走时就地卸载，不留任何东西。
 *
 * ── 注册方式 ────────────────────────────────────────────────────────────────
 * 浏览器侧通过 `window.__ModuleLoader__.load({ id, factory })` 加载本文件，
 * 取 `module.exports = { apply, inject }`；`apply(ctx)` 里用 `ctx.effect(fn, label)`
 * 挂带清理函数的副作用，用 `ctx.slots.inject(key, cb)` 等宿主声明插槽后再 register。
 *
 * ── 契约（宿主半边 /api/dsh-remote-gui/*；同源，不需要额外凭据）──────────────
 *   GET    /hosts                      → { hosts: Host[] }
 *   POST   /hosts                      ← { alias, name?, port?, localPort?, autoTunnel? }
 *   DELETE /host?id=                   → { ok: true }
 *   POST   /tunnel                     ← { id, action:'start'|'stop' }
 *   GET    /health?id=                 → { id, tunnel, hostUp, status }
 *   GET    /sessions?id=               → { sessions: Session[] }
 *   POST   /session-archive            ← { id, sessionId }
 *   GET    /session-page?id=&sessionId=&throughSeq=&maxMessages=&beforeSeq=
 *                                      → { records:[{type:'event',event:{…}}], hasMore }
 *   GET    /session-projection?id=&sessionId=  → { projection }
 *   POST   /session-prompt             ← { id, sessionId, text, mode?, probe? }
 *   POST   /session-create             ← { id, cwd? }   → { ok, sessionId }
 *
 * ⚠️ 远端 `session/page` 的 `throughSeq` **不能超过该会话的 cursor**（= projection.asOfSeq），
 *    否则远端回 `gateway/bad-request: session page through seq N is past cursor M`。
 *    本文件的做法：每轮先读 projection 拿 asOfSeq，再按它取 page。
 * ⚠️ 刷新是**轮询**（默认 3 秒），不是 WebSocket 实时流 —— 界面上如实写着"轮询"。
 *    真流式要开远端网关的 `/api/remote.mux` WebSocket（`session/follow`），那是下一步的事。
 */

window.__ModuleLoader__.load({ id: "dsh-remote-gui", factory: (require) => {
  var module = { exports: {} };
  var exports = module.exports;

  var React = require("react");

  var h = React.createElement;
  var useState = React.useState;
  var useEffect = React.useEffect;
  var useCallback = React.useCallback;
  var useRef = React.useRef;

  /**
   * 宿主声明的依赖面：插槽 / 布局 / 连接 / 语言。
   * ⚠️ **用到哪个服务就必须在这里声明**：cordis 的服务代理在未声明时抛
   * `cannot get property "layout" without inject`（2026-10-14 实测踩到：
   * 面板能开但关闭按钮/Esc 全部静默失效，因为 closePanel 里的 ctx.layout 抛错被 catch 吞了）。
   * ⚠️ 但也**不要**在这里加不存在的服务 —— inject 是**必需**依赖，列一个永不出现的服务
   * （如 betterSidebar：本机整套已装插件与 harness 本体里 0 次命中）会让整个客户端半边
   * 永远不激活，面板根本不出现（这也是 dsh-sev 在本机不可用的原因之一）。
   * `layout` 由 ui-layout 提供，而 `sidebar.panellist` / `main` 这两个座位本来就由
   * ui-layout + ui-sidebar 声明 —— 没有它们的组合里，本插件本来也无处可挂。
   * 代码里对 ctx.betterSidebar 的用法仍保留 typeof 守卫 + try/catch 的可选增强。
   */
  var inject = ["slots", "layout", "connection", "locale"];

  /** 侧栏行 id 与中心列 key 必须**是同一个字符串**（sidebar.panellist 的 id 寻址 main 的 key）。 */
  var PANEL_ID = "dsh-remote-gui";
  /** 关闭时切回的宿主主面板 key（ui-conversation 占的就是这个 key）。 */
  var CONVERSATION_PANEL_ID = "conversation";

  var API = {
    hosts: "/api/dsh-remote-gui/hosts",
    host: "/api/dsh-remote-gui/host",
    tunnel: "/api/dsh-remote-gui/tunnel",
    sessions: "/api/dsh-remote-gui/sessions",
    archive: "/api/dsh-remote-gui/session-archive",
    page: "/api/dsh-remote-gui/session-page",
    projection: "/api/dsh-remote-gui/session-projection",
    prompt: "/api/dsh-remote-gui/session-prompt",
    create: "/api/dsh-remote-gui/session-create",
    health: "/api/dsh-remote-gui/health"
  };

  var HOSTS_POLL_MS = 12000;
  var SESSIONS_POLL_MS = 8000;
  /** 打开一条会话时的轮询周期（projection → 有新事件才拉 page）。 */
  var TRANSCRIPT_POLL_MS = 3000;
  /** 每次 page 请求的最大消息数（远端会连带返回周边事件，实测 40 条 ≈ 230 条记录）。 */
  var PAGE_MAX_MESSAGES = 40;

  var TARGET_STORAGE_KEY = "dsh-remote-gui.target";

  // ── 小工具 ─────────────────────────────────────────────────────────────────

  function qs(url, params) {
    var pairs = [];
    for (var k in params) if (Object.prototype.hasOwnProperty.call(params, k)) {
      if (params[k] === undefined || params[k] === null) continue;
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

  function clockTime(ts) {
    if (!ts) return "";
    try { return new Date(ts).toLocaleTimeString(); } catch (e) { return ""; }
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

  /** 错误对象 → 可读文字（宿主在失败时返回 {error}；远端错误是 {code,message} 对象）。 */
  function errText(data, fallback) {
    if (!data) return fallback;
    if (typeof data.error === "string") return data.error;
    if (data.error && typeof data.error.message === "string") {
      return (data.error.code ? data.error.code + ": " : "") + data.error.message;
    }
    return fallback;
  }

  /** 供标题/占位用：截断长文本。 */
  function clip(text, n) {
    var s = String(text === undefined || text === null ? "" : text);
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  /** 目标主机的持久化选择（只存主机 id；不再有"本地实例"这个目标）。 */
  function readStoredTarget() {
    try {
      var v = window.localStorage.getItem(TARGET_STORAGE_KEY);
      return v ? String(v) : "";
    } catch (e) {
      return "";
    }
  }

  function writeStoredTarget(value) {
    try { window.localStorage.setItem(TARGET_STORAGE_KEY, String(value)); } catch (e) { /* 忽略 */ }
  }

  function hasStoredTarget() {
    try {
      var v = window.localStorage.getItem(TARGET_STORAGE_KEY);
      return v !== null && v !== undefined && String(v) !== "";
    } catch (e) {
      return false;
    }
  }

  /** 带 HTTP 状态码的 GET（用来区分"路由还没加载"和"远端出错"）。 */
  function getJsonEx(url) {
    return fetch(url).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (body) {
        return { status: r.status, body: body };
      });
    });
  }

  /**
   * 把一次插件路由调用的失败翻译成给人看的话。
   *
   * 为什么要专门认 401/404：本插件的 `/api/dsh-remote-gui/*` 是宿主"精确路由"，
   * 已注册的路由**不走浏览器鉴权**（实测：/hosts 无 cookie 也 200），
   * 而未注册的路径会掉进连接层 → **401**（不是 404）。
   * 所以"客户端半边已经热加载、宿主半边还是旧代码"这个很常见的情况，
   * 表现就是 401/404，而不是任何有意义的业务错误 —— 必须直说是要重启应用。
   */
  function describeRouteFailure(status, fallback) {
    if (status === 401 || status === 404) {
      return "本插件的会话路由还没就绪（HTTP " + status + "）—— 客户端半边已热加载、"
        + "宿主半边还是旧代码。请重启 DSH 应用（或重启 dsh web）后重试。";
    }
    return fallback + (status ? "（HTTP " + status + "）" : "");
  }

  // ── 消息流：把远端 session/page 的 records 变成可读条目 ─────────────────────
  //
  // 事件形状（2026-10-14 从真远端 session/page 的响应里读出来的，逐条实测）：
  //   user/message      data.content[]                    ← 用户输入（text/image）
  //   assistant/message data.message.content[]            ← text / reasoning / tool-call 三种块
  //                     data.usage
  //   tool/call         data.callId, data.name, data.arguments(JSON 字符串)
  //   tool/result       data.message.content[] + data.message.isError, data.toolCallId
  //                     data.sourceEventSeqs[]（指向那条 tool/call 的 seq，用来配对）
  //   turn/start|end, step/start|end, todo/write, …       ← 结构噪声，不渲染
  //
  // 去重规则：tool-call 块在 assistant/message 里也会出现一次，所以工具卡只从
  // **tool/call 事件**生成，assistant/message 只取 text（避免同一调用画两遍）。

  /** 把 content 块数组里的纯文本拼起来（跳过 reasoning / tool-call / image）。 */
  function textBlocks(content) {
    var out = [];
    if (!content || !content.length) return "";
    for (var i = 0; i < content.length; i++) {
      var b = content[i];
      if (b && b.type === "text" && typeof b.text === "string") out.push(b.text);
      else if (b && b.type === "image") out.push("[图片]");
    }
    return out.join("\n");
  }

  function hasImageBlock(content) {
    if (!content || !content.length) return false;
    for (var i = 0; i < content.length; i++) if (content[i] && content[i].type === "image") return true;
    return false;
  }

  /** records → 渲染条目（按 seq 升序；工具卡与它的 result 配成一张）。 */
  function buildItems(records) {
    var items = [];
    var byCallId = {};      // callId → items 下标
    var list = (records || []).slice();
    list.sort(function (a, b) {
      var sa = a && a.event && typeof a.event.seq === "number" ? a.event.seq : 0;
      var sb = b && b.event && typeof b.event.seq === "number" ? b.event.seq : 0;
      return sa - sb;
    });
    for (var i = 0; i < list.length; i++) {
      var ev = list[i] && list[i].event;
      if (!ev || !ev.type) continue;
      var data = ev.data || {};
      var seq = typeof ev.seq === "number" ? ev.seq : i;
      if (ev.type === "user/message") {
        var utext = textBlocks(data.content);
        if (!utext && !hasImageBlock(data.content)) continue;
        items.push({ key: "u" + seq, kind: "user", seq: seq, time: ev.time, text: utext });
      } else if (ev.type === "assistant/message") {
        var msg = data.message || {};
        var atext = textBlocks(msg.content);
        if (!atext) continue;   // 只有工具调用/思考、没有正文 → 由 tool/call 卡片代表
        items.push({ key: "a" + seq, kind: "assistant", seq: seq, time: ev.time, text: atext });
      } else if (ev.type === "tool/call") {
        var callId = data.callId || ("seq" + seq);
        var args = data.arguments;
        items.push({
          key: "c" + seq,
          kind: "tool",
          seq: seq,
          time: ev.time,
          callId: callId,
          name: data.name || "(未知工具)",
          args: typeof args === "string" ? args : (args === undefined ? "" : JSON.stringify(args)),
          result: null,
          isError: false
        });
        byCallId[callId] = items.length - 1;
      } else if (ev.type === "tool/result") {
        var rmsg = data.message || {};
        var rtext = textBlocks(rmsg.content);
        var rid = data.toolCallId || rmsg.toolCallId;
        var at = rid !== undefined && rid !== null ? byCallId[rid] : undefined;
        if (at !== undefined && items[at] && items[at].result === null) {
          items[at] = Object.assign({}, items[at], { result: rtext, isError: !!rmsg.isError });
        } else {
          items.push({
            key: "r" + seq,
            kind: "tool",
            seq: seq,
            time: ev.time,
            callId: rid || ("seq" + seq),
            name: "(工具结果)",
            args: "",
            result: rtext,
            isError: !!rmsg.isError
          });
        }
      }
      // 其余事件（turn/step/session-log/…）不渲染：它们是结构记录，不是对话内容
    }
    return items;
  }

  /** 按 seq 去重合并（轮询整窗替换 + "加载更早"向前拼接都走这里）。 */
  function mergeBySeq(existing, incoming) {
    var seen = {};
    var all = (existing || []).concat(incoming || []);
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var ev = all[i] && all[i].event;
      var seq = ev && typeof ev.seq === "number" ? ev.seq : null;
      if (seq === null) { out.push(all[i]); continue; }
      if (seen[seq]) continue;
      seen[seq] = true;
      out.push(all[i]);
    }
    out.sort(function (a, b) {
      var sa = a && a.event && typeof a.event.seq === "number" ? a.event.seq : 0;
      var sb = b && b.event && typeof b.event.seq === "number" ? b.event.seq : 0;
      return sa - sb;
    });
    return out;
  }

  /**
   * 本机记住"我归档过哪些远端会话"。
   *
   * 为什么需要它（2026-10-14 实测）：远端 `session/list` 返回的条目里**根本没有归档字段**
   * （keys 只有 sessionId/updatedAt/agentAvailable/running/blank/cwd/projections；归档过的会话
   * 与没归档的形状完全一样）。真正的归档状态在 `workspace/*` 那条**流式**通道里
   * （`workspace/follow` 是 mode:'stream'，要开 WebSocket）。
   * 所以：归档 RPC 是真调了、远端也真归档了，但列表里那一行会照旧出现 ——
   * 看起来就像"点了没反应"。这里用一份**本机视图过滤**把这个差别补上，
   * 并在界面上如实写明"本机记录"，不假装是远端权威状态。
   */
  var ARCHIVED_KEY = "dsh-remote-gui.archived";

  function readArchivedMap() {
    try {
      var raw = window.localStorage.getItem(ARCHIVED_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function writeArchivedMap(map) {
    try { window.localStorage.setItem(ARCHIVED_KEY, JSON.stringify(map)); } catch (e) { /* 忽略 */ }
  }

  // ── 主面板（中心列；同 key 才被切到）────────────────────────────────────────

  /**
   * @param props.closePanel 由注册时的 inject face 注入：把主列切回会话页。
   */
  function RemoteSessionsPanel(props) {
    var closePanel = props && props.closePanel;

    var hostsState = useState([]);
    var hosts = hostsState[0];
    var setHosts = hostsState[1];

    var loadingState = useState(true);
    var loading = loadingState[0];
    var setLoading = loadingState[1];

    var errorState = useState(null);
    var error = errorState[0];
    var setError = errorState[1];

    var aliasState = useState("");
    var alias = aliasState[0];
    var setAlias = aliasState[1];

    var sessionsState = useState([]);
    var sessions = sessionsState[0];
    var setSessions = sessionsState[1];

    var busyState = useState(null);
    var busy = busyState[0];
    var setBusy = busyState[1];

    var targetState = useState(readStoredTarget);
    var target = targetState[0];
    var setTarget = targetState[1];

    /** 打开的会话：{sessionId,title,cwd,records,hasMore,asOf,loading,error,updatedAt} */
    var openState = useState(null);
    var open = openState[0];
    var setOpen = openState[1];

    var draftState = useState("");
    var draft = draftState[0];
    var setDraft = draftState[1];

    var sendState = useState(null);   // { kind:'ok'|'err'|'info', text }
    var sendMsg = sendState[0];
    var setSendMsg = sendState[1];

    var steerState = useState(false);
    var steer = steerState[0];
    var setSteer = steerState[1];

    /** 会话列表过滤词（远端常有几百条会话，没有过滤就只能靠眼睛找）。 */
    var filterState = useState("");
    var filter = filterState[0];
    var setFilter = filterState[1];

    /**
     * 鼠标悬停/选中的会话行 —— 行内动作（归档）只在这一行显示。
     * 与宿主自己的侧栏会话行同一约定（`sidebar.workspaces.session.row.action` 也是悬停才出现）：
     * 几百条会话各挂一个常驻按钮，无障碍树里就是几百个同名动作，谁也挑不出是哪一条。
     */
    var hoverState = useState(null);
    var hoverId = hoverState[0];
    var setHoverId = hoverState[1];

    /** 本机记录的"我归档过"的集合（见 readArchivedMap 的说明）＋ 是否显示它们。 */
    var archivedState = useState(readArchivedMap);
    var archivedMap = archivedState[0];
    var setArchivedMap = archivedState[1];
    var showArchivedState = useState(false);
    var showArchived = showArchivedState[0];
    var setShowArchived = showArchivedState[1];

    var mountedRef = useRef(true);
    useEffect(function () {
      mountedRef.current = true;
      return function () { mountedRef.current = false; };
    }, []);

    var selectTarget = useCallback(function (next) {
      setTarget(next);
      writeStoredTarget(next);
    }, []);

    /**
     * 默认目标：用户上次选过就尊重它；从没选过时有主机就自动选**第一台远端**
     * （只有一台主机都没有才停在没有目标的状态）。
     * 为什么这么默认：用户要的是"连上远端就用远端会话"，让面板一打开就是空的、
     * 还要手动选一次主机，等于把最常走的路放到了最后。ref 保证一辈子只套用一次。
     */
    var defaultTargetAppliedRef = useRef(false);
    useEffect(function () {
      if (defaultTargetAppliedRef.current) return;
      if (loading) return;
      defaultTargetAppliedRef.current = true;
      if (!hasStoredTarget() && hosts.length > 0) selectTarget(hostId(hosts[0]));
    }, [loading, hosts, selectTarget]);

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

    // 目标解析（目标不见了就回落，等主机列表读完再判定，避免闪一下）
    var activeHost = null;
    for (var hi = 0; hi < hosts.length; hi++) {
      if (hostId(hosts[hi]) === target) { activeHost = hosts[hi]; break; }
    }
    var activeHostKey = activeHost ? hostId(activeHost) : "";
    var tunnelRunning = !!activeHost && tunnelState(activeHost) === "running";

    useEffect(function () {
      if (loading) return;
      if (target && activeHost === null) selectTarget(hosts.length > 0 ? hostId(hosts[0]) : "");
    }, [loading, target, activeHostKey, hosts, selectTarget]);

    // 当前目标的远端会话列表
    var refreshSessions = useCallback(function () {
      if (!activeHostKey) return Promise.resolve();
      return getJson(qs(API.sessions, { id: activeHostKey })).then(function (d) {
        if (!mountedRef.current) return;
        if (d && Array.isArray(d.sessions)) {
          setSessions(d.sessions);
          setError(null);
        } else if (d && d.error) {
          setError(errText(d, "读取远端会话失败"));
        }
      }).catch(function () { /* 列表失败不打断界面 */ });
    }, [activeHostKey]);

    useEffect(function () {
      void refreshSessions();
      if (!activeHostKey) return undefined;
      var timer = window.setInterval(function () { void refreshSessions(); }, SESSIONS_POLL_MS);
      return function () { window.clearInterval(timer); };
    }, [refreshSessions, activeHostKey]);

    var openSession = useCallback(function (session) {
      setSendMsg(null);
      setDraft("");
      setOpen({
        sessionId: session.sessionId,
        title: sessionTitle(session),
        cwd: session.cwd || null,
        records: [],
        hasMore: false,
        asOf: null,
        loading: true,
        error: null,
        updatedAt: null
      });
    }, []);

    /**
     * 正文字幕的轮询：**先读 projection 拿 cursor（asOfSeq），再按它取 page**。
     * 这样既不会踩 "through seq N is past cursor M"，又能在没有新事件时只花一次
     * 小请求（projection）而不重复拉整页记录。
     * 这是**轮询**，不是实时流 —— 界面上如实标注。
     */
    useEffect(function () {
      var sessionId = open && open.sessionId;
      if (!sessionId || !activeHostKey || !tunnelRunning) return undefined;
      var cancelled = false;
      var loadPage = function (asOf) {
        return getJsonEx(qs(API.page, {
          id: activeHostKey,
          sessionId: sessionId,
          throughSeq: asOf,
          maxMessages: PAGE_MAX_MESSAGES
        })).then(function (res) {
          var p = res.body;
          if (cancelled || !mountedRef.current) return;
          if (p && Array.isArray(p.records)) {
            setOpen(function (prev) {
              if (!prev || prev.sessionId !== sessionId) return prev;
              return Object.assign({}, prev, {
                records: prev.records.length ? mergeBySeq(prev.records, p.records) : p.records,
                hasMore: !!p.hasMore,
                asOf: asOf,
                loading: false,
                error: null,
                updatedAt: Date.now()
              });
            });
          } else {
            setOpen(function (prev) {
              if (!prev || prev.sessionId !== sessionId) return prev;
              return Object.assign({}, prev, {
                loading: false,
                error: describeRouteFailure(res.status, errText(p, "读取远端会话正文失败"))
              });
            });
          }
        });
      };
      var tick = function () {
        return getJsonEx(qs(API.projection, { id: activeHostKey, sessionId: sessionId })).then(function (res) {
          var d = res.body;
          if (cancelled || !mountedRef.current) return;
          var proj = d && d.projection;
          var asOf = proj && typeof proj.asOfSeq === "number" ? proj.asOfSeq : null;
          if (asOf === null) {
            setOpen(function (prev) {
              if (!prev || prev.sessionId !== sessionId || prev.records.length) return prev;
              return Object.assign({}, prev, {
                loading: false,
                error: describeRouteFailure(res.status, errText(d, "读取远端会话投影失败"))
              });
            });
            return;
          }
          var needPage = true;
          if (mountedRef.current) {
            setOpen(function (prev) {
              if (!prev || prev.sessionId !== sessionId) return prev;
              if (prev.asOf === asOf && prev.records.length) { needPage = false; return prev; }
              return Object.assign({}, prev, { asOf: asOf });
            });
          }
          if (!needPage) {
            setOpen(function (prev) {
              if (!prev || prev.sessionId !== sessionId) return prev;
              return Object.assign({}, prev, { updatedAt: Date.now() });
            });
            return;
          }
          return loadPage(asOf);
        }).catch(function (e) {
          if (cancelled || !mountedRef.current) return;
          setOpen(function (prev) {
            if (!prev || prev.sessionId !== sessionId) return prev;
            return Object.assign({}, prev, { loading: false, error: String(e) });
          });
        });
      };
      void tick();
      var timer = window.setInterval(function () { void tick(); }, TRANSCRIPT_POLL_MS);
      return function () { cancelled = true; window.clearInterval(timer); };
      // open.sessionId 是这里的真正依赖；open.asOf 变化不重挂（否则每轮都重建定时器）
    }, [open && open.sessionId, activeHostKey, tunnelRunning]);

    /** 加载更早：以当前最老的 seq 为 beforeSeq 再取一页。 */
    var loadOlder = useCallback(function () {
      var sessionId = open && open.sessionId;
      if (!sessionId || !activeHostKey) return;
      var records = open.records || [];
      var oldest = null;
      for (var i = 0; i < records.length; i++) {
        var sq = records[i] && records[i].event && records[i].event.seq;
        if (typeof sq === "number" && (oldest === null || sq < oldest)) oldest = sq;
      }
      if (oldest === null || open.asOf === null) return;
      setBusy("older");
      getJson(qs(API.page, {
        id: activeHostKey,
        sessionId: sessionId,
        throughSeq: open.asOf,
        beforeSeq: oldest,
        maxMessages: PAGE_MAX_MESSAGES
      })).then(function (p) {
        if (!mountedRef.current) return;
        setOpen(function (prev) {
          if (!prev || prev.sessionId !== sessionId) return prev;
          if (!p || !Array.isArray(p.records)) return Object.assign({}, prev, { error: errText(p, "加载更早的消息失败") });
          return Object.assign({}, prev, {
            records: mergeBySeq(prev.records, p.records),
            hasMore: !!p.hasMore,
            error: null
          });
        });
      }).catch(function (e) {
        if (mountedRef.current) setOpen(function (prev) { return prev ? Object.assign({}, prev, { error: String(e) }) : prev; });
      }).then(function () {
        if (mountedRef.current) setBusy(null);
      });
    }, [open && open.sessionId, open && open.asOf, open && open.records, activeHostKey]);

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

    /**
     * 两步确认（面板内，不用 window.confirm）。
     * 为什么不用 window.confirm：它是**模态原生对话框**，会阻塞页面（实测：自动化点击
     * 卡在 dialog 上 30 秒超时），而且样式不受主题控制。
     * 这里的语义完全一样：第一次点只是"武装"，第二次点才真做；点别处或 5 秒不动就自动解除。
     */
    var pendingState = useState(null);   // 待确认的动作 key
    var pending = pendingState[0];
    var setPending = pendingState[1];
    var pendingTimerRef = useRef(null);

    /** 第一次调用只是武装（返回 false），第二次同 key 调用才放行（返回 true）。 */
    function armThenRun(key) {
      if (pending === key) {
        if (pendingTimerRef.current) { window.clearTimeout(pendingTimerRef.current); pendingTimerRef.current = null; }
        setPending(null);
        return true;
      }
      setPending(key);
      if (pendingTimerRef.current) window.clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = window.setTimeout(function () { setPending(null); pendingTimerRef.current = null; }, 5000);
      return false;
    }

    function removeHost(host) {
      var id = hostId(host);
      if (!armThenRun("remove:" + id)) return;
      void withBusy("remove:" + id, function () {
        return sendJson(qs(API.host, { id: id }), "DELETE").then(function (d) {
          if (!mountedRef.current) return;
          if (d && d.ok === false) setError(errText(d, "删除失败"));
          if (target === id) selectTarget("");
          return refreshHosts();
        });
      });
    }

    function archiveSession(host, session) {
      var id = hostId(host);
      if (!armThenRun("archive:" + session.sessionId)) return;
      void withBusy("archive:" + session.sessionId, function () {
        return sendJson(API.archive, "POST", { id: id, sessionId: session.sessionId }).then(function (d) {
          if (!mountedRef.current) return;
          if (d && d.ok) {
            // 远端已归档；但 session/list 不带归档标记（见 readArchivedMap 说明），
            // 所以同时记进本机过滤表，否则下一轮刷新这一行又回来了。
            setArchivedMap(function (prev) {
              var next = {};
              for (var k in prev) if (Object.prototype.hasOwnProperty.call(prev, k)) next[k] = prev[k];
              var list = (next[id] || []).slice();
              if (list.indexOf(session.sessionId) < 0) list.push(session.sessionId);
              next[id] = list;
              writeArchivedMap(next);
              return next;
            });
            setSessions(function (prev) {
              return (prev || []).filter(function (s) { return s.sessionId !== session.sessionId; });
            });
            if (open && open.sessionId === session.sessionId) setOpen(null);
            return refreshSessions();
          }
          setError(errText(d, "归档失败"));
        });
      });
    }

    function createSession() {
      if (!activeHostKey) return;
      var cwd = open && open.cwd ? open.cwd : undefined;
      void withBusy("create", function () {
        return sendJson(API.create, "POST", { id: activeHostKey, cwd: cwd }).then(function (d) {
          if (!mountedRef.current) return;
          if (d && d.ok && d.sessionId) {
            // openSession 会清空 sendMsg（新会话=干净状态），所以这条提示必须在它之后再写，
            // 否则用户看不到"新建成功"这一句（第一版就是这个顺序，提示一闪即没）。
            return refreshSessions().then(function () {
              if (!mountedRef.current) return;
              openSession({ sessionId: d.sessionId, title: null, cwd: cwd || null });
              setSendMsg({ kind: "ok", text: "已在远端新建会话：" + d.sessionId + "（尚未花任何额度；发第一条消息才会跑模型）" });
            });
          }
          setError(errText(d, "新建远端会话失败"));
        });
      });
    }

    /**
     * 真发送。⚠️ 这一步会让**远端**真的跑一轮模型并消耗额度，
     * 所以：① 必须再点一次「确认发送」（两步确认，见 armThenRun）；
     * ② 只有用户显式点「发送」或按 Ctrl/Cmd+Enter 才会走到这里；
     * ③ 没有任何自动重试/自动补发。发送后立刻拉一次正文，之后交给轮询。
     */
    function sendPrompt() {
      var sessionId = open && open.sessionId;
      var text = draft;
      if (!sessionId || !activeHostKey || !text.trim()) return;
      if (!armThenRun("send:" + sessionId)) return;
      setBusy("send");
      setSendMsg({ kind: "info", text: "已发送，等待远端受理…" });
      sendJson(API.prompt, "POST", {
        id: activeHostKey,
        sessionId: sessionId,
        text: text,
        mode: steer ? "steer" : "queue"
      }).then(function (d) {
        if (!mountedRef.current) return;
        if (d && d.ok) {
          setDraft("");
          setSendMsg({ kind: "ok", text: "远端已受理（requestId " + clip(d.requestId, 26) + "）—— 正在轮询远端输出" });
          return getJson(qs(API.projection, { id: activeHostKey, sessionId: sessionId })).then(function (p) {
            if (!mountedRef.current) return;
            var asOf = p && p.projection && typeof p.projection.asOfSeq === "number" ? p.projection.asOfSeq : null;
            if (asOf === null) return undefined;
            return getJson(qs(API.page, {
              id: activeHostKey,
              sessionId: sessionId,
              throughSeq: asOf,
              maxMessages: PAGE_MAX_MESSAGES
            })).then(function (pg) {
              if (!mountedRef.current) return;
              setOpen(function (prev) {
                if (!prev || prev.sessionId !== sessionId) return prev;
                if (!pg || !Array.isArray(pg.records)) return Object.assign({}, prev, { asOf: asOf });
                return Object.assign({}, prev, {
                  records: mergeBySeq(prev.records, pg.records),
                  hasMore: !!pg.hasMore,
                  asOf: asOf,
                  updatedAt: Date.now()
                });
              });
            });
          });
        }
        setSendMsg({ kind: "err", text: "发送失败：" + errText(d, "远端拒绝") });
      }).catch(function (e) {
        if (mountedRef.current) setSendMsg({ kind: "err", text: "发送失败：" + String(e) });
      }).then(function () {
        if (mountedRef.current) setBusy(null);
      });
    }

    /**
     * 零费用链路探针：`probe:true` 让宿主给远端发一条 content=[] 的 prompt。
     * 远端会在"解析 Agent / 写会话事件之前"拒掉它（gateway/bad-request），
     * 于是这条链路（本地路由 → 隧道 → 远端 RPC → 错误回显）被验证，且不产生任何模型调用。
     */
    function probePrompt() {
      var sessionId = open && open.sessionId;
      if (!sessionId || !activeHostKey) return;
      setBusy("probe");
      setSendMsg({ kind: "info", text: "探针发送中（0 费用）…" });
      sendJson(API.prompt, "POST", { id: activeHostKey, sessionId: sessionId, probe: true })
        .then(function (d) {
          if (!mountedRef.current) return;
          if (d && d.ok) {
            setSendMsg({ kind: "ok", text: "探针：远端**接受**了空内容（意外）—— 返回值 " + clip(JSON.stringify(d.value), 80) });
            return;
          }
          setSendMsg({ kind: "ok", text: "探针链路通 ✅ 远端原样回显：" + errText(d, "（无错误文本）") });
        })
        .catch(function (e) {
          if (mountedRef.current) setSendMsg({ kind: "err", text: "探针失败：" + String(e) });
        })
        .then(function () {
          if (mountedRef.current) setBusy(null);
        });
    }

    /**
     * Esc 关闭面板。
     * 只在一处例外：焦点在**草稿输入框**里（正在打字）—— 那种情况先让它失焦，别把已输入的草稿连面板一起关掉。
     * 其余任何位置（包括过滤框、按钮、列表某一行）都关。
     * （第一版写成"焦点在 input 里就不关"，结果在过滤框里按 Esc 完全没反应 —— 那是缺陷不是保护。）
     */
    var draftRef = useRef(null);
    useEffect(function () {
      var onKey = function (e) {
        if (e.key !== "Escape" && e.key !== "Esc") return;
        if (draftRef.current && e.target === draftRef.current) {
          try { draftRef.current.blur(); } catch (err) { /* noop */ }
          return;
        }
        if (typeof closePanel === "function") closePanel();
      };
      document.addEventListener("keydown", onKey, true);
      return function () { document.removeEventListener("keydown", onKey, true); };
    }, [closePanel]);

    // ── 样式 ────────────────────────────────────────────────────────────────
    // 颜色策略（吃过一次亏，见 git 历史里的"白字白底空块"）：
    //   面板长在宿主的 React 树里，所以**前景色一律 inherit**，层次用 opacity 表达；
    //   只有强调色（accent / 错误红 / 状态点）写死，并且背景与前景成对出现，
    //   不出现"背景靠主题变量、前景写死白"的组合 —— 那种组合在浅色主题下会隐形。
    // 危险色（归档 / 错误文字）用宿主自己的语义 token，不写死红：
    // 实测对底色的对比度 —— dark rgb(242,90,90) 5.55:1；light rgb(236,19,19) 4.50:1。
    // 写死的 #e07171 是 dark 4.49:1 / light 2.79:1（浅色主题下"归档"和错误文字几乎看不清）。
    var dangerColor = "var(--dsw-alias-state-error-primary, #e07171)";
    /**
     * 行内动作（"归档"按钮）只出现在**悬停或选中**的行上，所以它永远压在行的底色上，
     * 而不是应用底色：纯 token 在那种底色上只有 dark 4.24:1 / light 4.04:1（低于 AA 的 4.5）。
     * 往正文字色方向混 30% 就能同时满足两个主题，而且仍然是主题 token（不是写死两套值）：
     * 实测 dark 5.88:1 / light 6.74:1。`color-mix` 不被支持时该声明无效 → 回退到继承色（17:1）。
     */
    var dangerOnRow = "color-mix(in srgb, " + dangerColor + " 70%, var(--dsw-alias-label-primary, currentColor))";
    var sep = "var(--dsw-alias-separator-primary, rgba(128,128,128,.22))";
    var softBg = "var(--dsw-specific-sidebar-nav-item-hover, var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)))";
    var accent = "var(--dsw-alias-brand-primary, var(--dsh-accent, #4a7dff))";

    var styles = {
      wrap: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, color: "inherit" },
      bar: {
        display: "flex", alignItems: "center", gap: 8, padding: "10px 14px",
        borderBottom: "1px solid " + sep, flexWrap: "wrap", flexShrink: 0
      },
      title: { fontWeight: 600, fontSize: 14, flexShrink: 0 },
      sub: { fontSize: 12, opacity: 0.7 },
      input: {
        flex: "1 1 200px", minWidth: 0, padding: "6px 9px", borderRadius: 7,
        border: "1px solid " + sep, background: "transparent", color: "inherit", font: "inherit"
      },
      btn: {
        padding: "5px 10px", borderRadius: 6, border: "1px solid " + sep,
        background: "transparent", color: "inherit", cursor: "pointer", font: "inherit", fontSize: 12, flexShrink: 0
      },
      btnOn: {
        padding: "5px 10px", borderRadius: 6, border: "1px solid " + accent,
        background: softBg, color: "inherit", cursor: "pointer", font: "inherit", fontSize: 12, fontWeight: 600, flexShrink: 0
      },
      btnPrimary: {
        padding: "6px 14px", borderRadius: 7, border: "1px solid " + accent,
        background: softBg, color: "inherit", cursor: "pointer", font: "inherit", fontSize: 13, fontWeight: 600, flexShrink: 0
      },
      btnQuiet: {
        padding: "4px 8px", borderRadius: 6, border: "1px solid transparent",
        background: "transparent", color: "inherit", cursor: "pointer", font: "inherit", fontSize: 12, flexShrink: 0, opacity: 0.85
      },
      btnOff: {
        padding: "6px 14px", borderRadius: 7, border: "1px solid " + sep,
        background: "transparent", color: "inherit", cursor: "not-allowed", font: "inherit", fontSize: 13, opacity: 0.5, flexShrink: 0
      },
      dangerBtn: {
        padding: "4px 8px", borderRadius: 6, border: "1px solid " + sep,
        background: "transparent", color: dangerOnRow, cursor: "pointer", font: "inherit", fontSize: 12, flexShrink: 0
      },
      chip: {
        padding: "4px 10px", borderRadius: 999, border: "1px solid " + sep,
        background: "transparent", color: "inherit", cursor: "pointer", font: "inherit", fontSize: 12,
        flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 5
      },
      err: { color: dangerColor, fontSize: 12, padding: "8px 14px 0", flexShrink: 0 },
      body: { flex: 1, minHeight: 0, display: "flex" },
      listCol: {
        width: 260, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0,
        borderRight: "1px solid " + sep
      },
      listHead: { display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", borderBottom: "1px solid " + sep, flexShrink: 0 },
      listBox: { flex: 1, minHeight: 0, overflow: "auto", padding: "4px 6px" },
      sessionRow: {
        display: "flex", alignItems: "center", gap: 7, padding: "6px 7px", borderRadius: 7,
        fontSize: 12, cursor: "pointer", border: "1px solid transparent"
      },
      sessionRowOn: { background: softBg, borderColor: accent },
      sessionTitle: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      sessionMeta: { fontSize: 11, opacity: 0.65, flexShrink: 0 },
      detail: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 },
      detailHead: {
        display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
        borderBottom: "1px solid " + sep, flexWrap: "wrap", flexShrink: 0
      },
      transcript: { flex: 1, minHeight: 0, overflow: "auto", padding: "10px 14px" },
      msg: { marginBottom: 10, fontSize: 13, lineHeight: 1.65, whiteSpace: "pre-wrap", wordBreak: "break-word" },
      msgUser: { borderLeft: "3px solid " + accent, paddingLeft: 10, background: softBg, borderRadius: 6, padding: "7px 10px" },
      msgAssistant: { borderLeft: "3px solid transparent", paddingLeft: 10 },
      roleLabel: { fontSize: 11, opacity: 0.6, marginBottom: 2 },
      toolCard: { border: "1px solid " + sep, borderRadius: 8, padding: "7px 9px", marginBottom: 10, fontSize: 12 },
      toolHead: { display: "flex", alignItems: "center", gap: 6, fontWeight: 600 },
      mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 11.5, whiteSpace: "pre-wrap", wordBreak: "break-word", opacity: 0.9, marginTop: 5 },
      toolResult: { marginTop: 6, paddingTop: 6, borderTop: "1px dashed " + sep },
      composer: { borderTop: "1px solid " + sep, padding: "8px 12px", flexShrink: 0 },
      textarea: {
        width: "100%", minHeight: 64, maxHeight: 200, resize: "vertical", padding: "8px 9px",
        borderRadius: 8, border: "1px solid " + sep, background: "transparent", color: "inherit",
        font: "inherit", fontSize: 13, boxSizing: "border-box"
      },
      composerRow: { display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" },
      notice: {
        flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
        padding: "18px 24px", textAlign: "center", fontSize: 13, lineHeight: 1.8, opacity: 0.8
      },
      empty: { fontSize: 12, opacity: 0.65, padding: "10px 6px" },
      badge: {
        marginLeft: "auto", flexShrink: 0, fontSize: 11, padding: "2px 9px", borderRadius: 999,
        background: softBg, color: "inherit", whiteSpace: "nowrap"
      },
      dot: { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 },
      infoLine: { fontSize: 11.5, padding: "4px 0 0", opacity: 0.85 }
    };

    var items = buildItems(open ? open.records : []);

    /** 过滤后的会话列表（先按本机归档表隐藏，再按过滤词匹配；大小写不敏感）。 */
    var archivedHere = (activeHostKey && archivedMap[activeHostKey]) || [];
    var shownSessions = sessions || [];
    if (archivedHere.length && !showArchived) {
      shownSessions = shownSessions.filter(function (s) { return archivedHere.indexOf(s.sessionId) < 0; });
    }
    if (filter.trim()) {
      var needle = filter.trim().toLowerCase();
      shownSessions = shownSessions.filter(function (s) {
        return (sessionTitle(s) + " " + (s.cwd || "") + " " + s.sessionId).toLowerCase().indexOf(needle) >= 0;
      });
    }

    function renderTranscript() {
      if (!open) {
        return h("div", { style: styles.notice },
          h("div", null,
            h("div", { style: { fontWeight: 600, marginBottom: 6 } }, "从左边选一条远端会话"),
            h("div", { style: styles.sub }, "点会话标题即读取它的对话正文（远端 session/page），可以直接在下面输入发送。")
          )
        );
      }
      return h("div", { style: styles.detail },
        h("div", { style: styles.detailHead },
          h("span", { style: { fontWeight: 600, fontSize: 13, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
            open.title || String(open.sessionId).slice(0, 12)),
          open.cwd ? h("span", { style: styles.sessionMeta, title: open.cwd }, shortCwd(open.cwd)) : null,
          h("span", { style: styles.sessionMeta, title: open.sessionId }, String(open.sessionId).slice(0, 20) + "…"),
          h("span", { style: styles.sessionMeta },
            open.updatedAt ? ("轮询刷新 · 每 " + (TRANSCRIPT_POLL_MS / 1000) + " 秒 · 上次 " + clockTime(open.updatedAt))
              : ("读取中… 轮询周期 " + (TRANSCRIPT_POLL_MS / 1000) + " 秒")),
          open.hasMore ? h("button", {
            type: "button", style: styles.btn, disabled: busy === "older", onClick: loadOlder
          }, busy === "older" ? "加载中…" : "加载更早") : null,
          h("button", { type: "button", style: styles.btn, onClick: function () { setOpen(null); } }, "返回列表")
        ),
        open.error ? h("div", { style: styles.err }, open.error) : null,
        h("div", { style: styles.transcript },
          open.loading && items.length === 0 ? h("div", { style: styles.empty }, "读取远端会话正文…") : null,
          !open.loading && items.length === 0 ? h("div", { style: styles.empty }, "这条会话没有可显示的消息正文（空会话或只有结构事件）") : null,
          items.map(function (it) {
            if (it.kind === "user") {
              return h("div", { key: it.key, style: Object.assign({}, styles.msg, styles.msgUser) },
                h("div", { style: styles.roleLabel }, "用户 · " + clockTime(it.time)),
                h("div", null, it.text)
              );
            }
            if (it.kind === "assistant") {
              return h("div", { key: it.key, style: Object.assign({}, styles.msg, styles.msgAssistant) },
                h("div", { style: styles.roleLabel }, "助手 · " + clockTime(it.time)),
                h("div", null, it.text)
              );
            }
            // 工具卡：name + 入参 + （配对上的）结果
            return h("div", { key: it.key, style: styles.toolCard },
              h("div", { style: styles.toolHead },
                h("span", null, "🔧 " + it.name),
                h("span", { style: styles.sessionMeta }, clockTime(it.time)),
                it.isError ? h("span", { style: { color: dangerColor, fontSize: 11 } }, "失败") : null
              ),
              it.args ? h("div", { style: styles.mono }, clip(it.args, 1200)) : null,
              it.result !== null && it.result !== undefined
                ? h("div", { style: Object.assign({}, styles.toolResult, it.isError ? { color: dangerColor } : null) },
                    h("div", { style: styles.roleLabel }, "结果"),
                    h("div", { style: styles.mono }, clip(it.result, 2000)))
                : h("div", { style: styles.roleLabel }, "（本轮没有可见结果）")
            );
          })
        ),
        h("div", { style: styles.composer },
          h("textarea", {
            ref: draftRef,
            "data-dsh-remote-draft": "",
            style: styles.textarea,
            placeholder: "在这里输入，然后点「发送」（或 Ctrl/Cmd+Enter）。发送会让远端真的跑一轮模型、消耗额度。",
            value: draft,
            spellCheck: false,
            onChange: function (e) { setDraft(e.target.value); },
            onKeyDown: function (e) {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); sendPrompt(); }
            }
          }),
          h("div", { style: styles.composerRow },
            h("button", {
              type: "button",
              "data-dsh-remote-send": "",
              // 两步确认的第二态：第一次点变成"确认发送（会花钱）"，再点才真的发
              style: (!draft.trim() || busy === "send") ? styles.btnOff : (pending === "send:" + (open && open.sessionId) ? styles.btnPrimary : styles.btnPrimary),
              disabled: !draft.trim() || busy === "send",
              onClick: sendPrompt
            }, busy === "send"
              ? "发送中…"
              : (pending === "send:" + (open && open.sessionId) ? "确认发送（会花钱）" : "发送到远端")),
            h("label", { style: Object.assign({}, styles.sub, { display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }) },
              h("input", {
                type: "checkbox",
                checked: steer,
                // 包在 label 里并不保证无障碍名（实测快照里这个 checkbox 是匿名的），显式给一个
                "aria-label": "插话（steer）：远端正在跑时用它插入当前步骤",
                onChange: function (e) { setSteer(!!e.target.checked); }
              }),
              "插话 (steer)"
            ),
            h("button", {
              type: "button",
              style: styles.btnQuiet,
              title: "给远端发一条空内容 prompt：远端会在调用模型之前拒掉它，用来验证链路（不产生费用）",
              disabled: busy === "probe",
              onClick: probePrompt
            }, busy === "probe" ? "探针中…" : "RPC 探针（0 费用）")
          ),
          sendMsg ? h("div", {
            style: Object.assign({}, styles.infoLine, sendMsg.kind === "err" ? { color: dangerColor } : null)
          }, sendMsg.text) : null
        )
      );
    }

    return h("div", { style: styles.wrap, "data-dsh-remote-gui-panel": "" },

      // 顶栏：标题 + 关闭（关闭 = 主列切回会话页，没有遮罩可点，因为压根没有遮罩）
      h("div", { style: styles.bar },
        h("span", { style: styles.title }, "远端会话"),
        h("span", { style: styles.sub }, "SSH 隧道 · 原生面板（无 iframe）"),
        h("span", { style: styles.badge }, activeHost ? ("当前：" + (activeHost.name || activeHost.alias)) : "没有远端主机"),
        h("button", {
          type: "button",
          "data-dsh-remote-gui-close": "",
          "aria-label": "关闭远端会话面板（回到会话）",
          title: "关闭（Esc）— 回到当前会话",
          style: styles.btn,
          onClick: function () { if (typeof closePanel === "function") closePanel(); }
        }, "✕ 关闭")
      ),

      // 主机管理与目标选择
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
          type: "button",
          style: (busy === "add" || !alias.trim()) ? styles.btnOff : styles.btnPrimary,
          onClick: addHost,
          disabled: busy === "add" || !alias.trim()
        }, busy === "add" ? "添加中…" : "添加"),
        h("button", { type: "button", style: styles.btn, onClick: function () { void refreshHosts(); void refreshSessions(); } }, "刷新")
      ),

      h("div", { style: styles.bar },
        h("span", { style: styles.sub }, "目标"),
        hosts.map(function (host) {
          var id = hostId(host);
          var on = activeHostKey === id;
          return h("button", {
            key: id,
            type: "button",
            style: on ? styles.btnOn : styles.btn,
            title: "远端 · " + host.alias + "（经 SSH 隧道）",
            onClick: function () { selectTarget(id); }
          },
            h("span", { style: Object.assign({}, styles.dot, { background: stateColor(tunnelState(host)) }) }),
            host.name || host.alias
          );
        }),
        hosts.length === 0 && !loading ? h("span", { style: styles.sub }, "还没登记主机 —— 在上面填 SSH 别名后点「添加」") : null,
        hosts.length === 0 && loading ? h("span", { style: styles.sub }, "读取中…") : null,
        activeHost ? h("span", { style: styles.sub },
          "远端 :" + activeHost.port + " → 本地 :" + activeHost.localPort + " · " + stateLabel(tunnelState(activeHost))) : null,
        activeHost ? h("button", {
          type: "button",
          style: styles.btn,
          disabled: busy === "tunnel:" + activeHostKey,
          onClick: function () { toggleTunnel(activeHost); }
        }, busy === "tunnel:" + activeHostKey ? "处理中…" : (tunnelRunning ? "断开隧道" : "连接隧道")) : null,
        activeHost ? h("button", {
          type: "button",
          style: styles.dangerBtn,
          disabled: busy === "remove:" + activeHostKey,
          onClick: function () { removeHost(activeHost); }
        }, (pending === "remove:" + activeHostKey) ? "确认删除主机" : "删除主机") : null
      ),

      error ? h("div", { style: styles.err }, error) : null,

      // 主体：左=会话列表，右=对话正文 + 输入
      h("div", { style: styles.body },
        h("div", { style: styles.listCol },
          h("div", { style: styles.listHead },
            h("span", { style: styles.sub }, "远端会话 · " + shownSessions.length + (filter.trim() ? "/" + sessions.length : "") + " 条"),
            archivedHere.length ? h("label", {
              style: Object.assign({}, styles.sub, { display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }),
              title: "远端 session/list 不返回归档标记，这份隐藏名单记在本机浏览器里"
            },
              h("input", {
                type: "checkbox",
                checked: showArchived,
                "aria-label": "显示已归档的会话（本机记录，共 " + archivedHere.length + " 条）",
                onChange: function (e) { setShowArchived(!!e.target.checked); }
              }),
              "显示已归档 " + archivedHere.length
            ) : null,
            h("button", {
              type: "button",
              style: styles.btn,
              title: "在远端新建一条会话（不消耗额度；会真的在远端创建一个新会话）",
              disabled: !tunnelRunning || busy === "create",
              onClick: createSession
            }, busy === "create" ? "新建中…" : "＋ 新建")
          ),
          h("div", { style: { padding: "0 8px 6px", flexShrink: 0 } },
            h("input", {
              type: "search",
              "data-dsh-remote-filter": "",
              "aria-label": "过滤远端会话（标题 / 路径 / 会话 id）",
              placeholder: "过滤：标题 / 路径 / 会话 id",
              value: filter,
              spellCheck: false,
              onChange: function (e) { setFilter(e.target.value); },
              style: Object.assign({}, styles.input, { flex: "1 1 auto", width: "100%", fontSize: 12, padding: "5px 8px" })
            })
          ),
          h("div", { style: styles.listBox },
            !activeHost ? h("div", { style: styles.empty }, "先添加并连接一台远端主机") : null,
            activeHost && !tunnelRunning ? h("div", { style: styles.empty }, "隧道未连接 —— 点上面的「连接隧道」") : null,
            tunnelRunning && sessions.length === 0 ? h("div", { style: styles.empty }, "没有读到远端会话（或远端还没有会话）") : null,
            tunnelRunning && sessions.length > 0 && shownSessions.length === 0
              ? h("div", { style: styles.empty }, "没有匹配「" + filter.trim() + "」的会话") : null,
            shownSessions.map(function (s) {
              var on = !!open && open.sessionId === s.sessionId;
              var title = sessionTitle(s);
              return h("div", {
                key: s.sessionId,
                // 稳定的语义锚点（与 task-board / dsh-ssh 的 data-dsh-* 约定一致）：
                // 让"这一行是哪条远端会话"可以只用 CSS/测试选择器定位，不靠文案。
                "data-dsh-remote-session": s.sessionId,
                "data-dsh-remote-session-selected": on ? "true" : undefined,
                // 行本身是可点开的动作：给它 button 语义 + 键盘可达 + 唯一可访问名，
                // 否则整张会话列表在无障碍树里完全是空的（只有一堆"归档"按钮漂着）。
                role: "button",
                tabIndex: 0,
                "aria-pressed": on ? "true" : "false",
                "aria-label": "打开远端会话：" + title + (s.cwd ? "（" + s.cwd + "）" : ""),
                style: Object.assign({}, styles.sessionRow, on ? styles.sessionRowOn : null),
                title: (s.cwd || "") + "\n" + s.sessionId,
                onClick: function () { openSession(s); },
                onKeyDown: function (e) {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSession(s); }
                },
                onMouseEnter: function () { setHoverId(s.sessionId); },
                onMouseLeave: function () { setHoverId(function (prev) { return prev === s.sessionId ? null : prev; }); }
              },
                h("span", { style: Object.assign({}, styles.dot, { background: s.running ? "#3ecf6a" : "#9a9a9a" }) }),
                h("span", { style: styles.sessionTitle }, title),
                h("span", { style: styles.sessionMeta }, s.running ? "运行中" : relTime(s.updatedAt)),
                // 归档按钮只在悬停或该行已选中时出现（见 hoverId 的说明）；键盘用户选中该行后同样能用
                (on || hoverId === s.sessionId) ? h("button", {
                  type: "button",
                  "data-dsh-remote-archive": s.sessionId,
                  "aria-label": "归档会话：" + title,
                  title: "归档此会话（远端 workspace/archiveSession）",
                  style: styles.dangerBtn,
                  disabled: busy === "archive:" + s.sessionId,
                  onClick: function (e) { e.stopPropagation(); archiveSession(activeHost, s); }
                }, (pending === "archive:" + s.sessionId) ? "确认归档" : "归档") : null
              );
            })
          )
        ),
        renderTranscript()
      )
    );
  }

  // ── 插槽里的小组件 ──────────────────────────────────────────────────────────

  /** 侧栏面板行 / 页脚入口共用的图标（外壳给尺寸与选中态，只画字形）。 */
  function panelIcon(size) {
    var s = size || 15;
    return h("svg", {
      viewBox: "0 0 16 16",
      width: s,
      height: s,
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

  /** `sidebar.panellist` 的行字形：外壳拥有按钮/标签/高亮/收起态，这里只给图标。 */
  function SidebarPanelIcon(props) {
    return h("span", { "data-dsh-panel-entry": PANEL_ID }, panelIcon(props && props.size));
  }

  /** `sidebar.footer.action` 的小入口：点它切到中心列面板（不再是覆盖层）。 */
  function FooterEntry(props) {
    var openPanel = props && props.openPanel;
    return h("button", {
      type: "button",
      "data-dsh-remote-gui-entry": "",
      "aria-label": "远端会话",
      title: "远端会话（SSH 隧道）",
      onClick: function () { if (typeof openPanel === "function") openPanel(); },
      style: {
        width: 30, height: 30, display: "inline-flex", alignItems: "center", justifyContent: "center",
        padding: 0, flex: "none", border: "none", borderRadius: 8, cursor: "pointer",
        color: "inherit", background: "transparent"
      }
    }, panelIcon(15));
  }

  // ── 插件入口 ───────────────────────────────────────────────────────────────

  function apply(ctx) {
    function fail(phase, error) {
      // 只记录，不抛出：客户端半边挂掉不应该影响本地 GUI 其它部分
      try { console.error("[dsh-remote-gui] " + phase + " error:", error); } catch (e) { /* noop */ }
    }

    /** 切到本插件的主面板（侧栏图标被点时由外壳自己切，这里给页脚入口用）。 */
    function openPanel() {
      try {
        if (ctx.layout && typeof ctx.layout.selectPanel === "function") ctx.layout.selectPanel(PANEL_ID);
      } catch (error) {
        fail("layout.selectPanel(" + PANEL_ID + ")", error);
      }
    }

    /** 关闭 = 把主列切回会话页（宿主 ui-conversation 占的 key 就是 'conversation'）。 */
    function closePanel() {
      try {
        // 诊断计数器：面板/宿主出问题时，"点没点到 closePanel"与"selectPanel 有没有生效"要能分开看
        try {
          var g = window;
          g.__dshRemoteGuiCloseCalls = (g.__dshRemoteGuiCloseCalls || 0) + 1;
        } catch (e) { /* noop */ }
        if (ctx.layout && typeof ctx.layout.selectPanel === "function") {
          ctx.layout.selectPanel(CONVERSATION_PANEL_ID);
          try { window.__dshRemoteGuiLastSelect = CONVERSATION_PANEL_ID; } catch (e) { /* noop */ }
        } else {
          try { window.__dshRemoteGuiNoLayout = true; } catch (e) { /* noop */ }
        }
      } catch (error) {
        fail("layout.selectPanel(" + CONVERSATION_PANEL_ID + ")", error);
      }
    }

    /**
     * 中心的原生面板：侧栏图标行（sidebar.panellist，id = PANEL_ID）
     * ＋ 中心列页面（main，key = PANEL_ID）。
     * 两处都用 ctx.slots.inject：宿主声明了这两个座位才注册；声明顺序无所谓。
     */
    try {
      ctx.effect(function () {
        var disposers = [];

        // 侧栏图标行：外壳拥有按钮/标签/高亮/收起栏，插件只画字形
        disposers.push(ctx.slots.inject("sidebar.panellist", function () {
          return ctx.slots.register({
            name: "sidebar.panellist",
            id: PANEL_ID,
            order: 50,
            label: function () { return "远端会话"; }
          }, SidebarPanelIcon);
        }));

        // 中心列页面：同 key 才会被侧栏那一行切到；关闭靠 closePanel()
        disposers.push(ctx.slots.inject("main", function () {
          return ctx.slots.register({
            name: "main",
            key: PANEL_ID,
            inject: function () { return { closePanel: closePanel }; }
          }, RemoteSessionsPanel);
        }));

        return function () {
          for (var i = 0; i < disposers.length; i++) {
            try { if (typeof disposers[i] === "function") disposers[i](); } catch (e) { /* noop */ }
          }
          disposers.length = 0;
        };
      }, "dsh-remote-gui: sidebar panellist + main panel");
    } catch (error) {
      fail("main panel registration", error);
    }

    // 页脚入口（次要入口，保留用户原有的位置习惯）：点它切到同一个主面板
    try {
      ctx.effect(function () {
        var disposeInject = ctx.slots.inject("sidebar.footer.action", function () {
          return ctx.slots.register({
            name: "sidebar.footer.action",
            id: PANEL_ID,
            inject: function () { return { openPanel: openPanel }; }
          }, FooterEntry);
        });
        return function () {
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
            id: PANEL_ID,
            title: function () { return "远端会话"; },
            order: 91,
            single: true,
            component: function () { return h(RemoteSessionsPanel, { closePanel: closePanel }); }
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
  /**
   * 仅供离线自检 / 单元测试使用（不参与宿主加载）：
   * 面板组件本身、以及纯函数（消息流构建 / 合并 / 序号工具）。
   */
  module.exports.__RemoteSessionsPanelForTest = RemoteSessionsPanel;
  module.exports.__buildItemsForTest = buildItems;
  module.exports.__mergeBySeqForTest = mergeBySeq;
  module.exports.__textBlocksForTest = textBlocks;
  module.exports.__describeRouteFailureForTest = describeRouteFailure;
  return module.exports;
}});
