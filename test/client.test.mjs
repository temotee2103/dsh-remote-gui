/**
 * 客户端半边（client.js）的加载、注册与消息流测试。
 *
 * client.js 不是 ESM 也不是普通 CommonJS —— 它是宿主浏览器侧的模块：
 *   window.__ModuleLoader__.load({ id, factory: (require) => module.exports })
 * 所以测试里桩掉 window / document / location，捕获 load() 的入参，
 * 再用一个假的 require 执行 factory，拿到导出的 { apply, inject }。
 *
 * 断言的是**宿主真正依赖的契约** + 面板的纯逻辑（消息流构建/合并）：
 *   1. 模块能加载、导出对、inject 对；
 *   2. 形态 = 中心列原生面板：sidebar.panellist(id) + main(key) 同 id，外加 sidebar.footer.action；
 *      **不再注册任何 iframe / 覆盖层**（那是被用户否掉的形态）；
 *   3. records → 消息条目（用户/助手/工具卡，工具调用与结果配对）；
 *   4. 轮询合并按 seq 去重且升序。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const clientSource = fs.readFileSync(path.join(repoRoot, 'client.js'), 'utf8')

/** 桩 React：只提供 apply/纯函数期间可能被读到的 API（本测试不渲染组件）。 */
function makeReactStub() {
  return {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useState(init) { return [typeof init === 'function' ? init() : init, () => {}] },
    useEffect() { /* 不执行 effect */ },
    useCallback(fn) { return fn },
    useRef(value) { return { current: value } },
  }
}

/** 执行 client.js，捕获 __ModuleLoader__.load 的入参，并把 factory 跑出来。 */
function loadClientModule() {
  let captured = null
  const windowStub = {
    __ModuleLoader__: { load(entry) { captured = entry } },
    localStorage: {
      _map: new Map(),
      getItem(k) { return this._map.has(k) ? this._map.get(k) : null },
      setItem(k, v) { this._map.set(k, String(v)) },
      removeItem(k) { this._map.delete(k) },
    },
    setInterval() { return 0 },
    clearInterval() {},
    confirm() { return true },
    addEventListener() {},
    removeEventListener() {},
  }
  const documentStub = {
    createElement() {
      return { style: {}, dataset: {}, appendChild() {}, addEventListener() {}, remove() {}, setAttribute() {} }
    },
    querySelector() { return null },
    querySelectorAll() { return [] },
    body: { appendChild() {}, style: {} },
    addEventListener() {},
    removeEventListener() {},
  }
  const locationStub = { origin: 'http://127.0.0.1:19387' }

  // client.js 末尾是 `}});` —— 整份源码可以当函数体跑；它只定义东西，
  // 唯一立即执行的是 window.__ModuleLoader__.load(...)。
  const run = new Function('window', 'document', 'location', 'console', clientSource)
  run(windowStub, documentStub, locationStub, console)

  assert.ok(captured, 'window.__ModuleLoader__.load 必须被调用')

  const requireShim = (name) => {
    if (name === 'react') return makeReactStub()
    throw new Error(`unexpected require: ${name}`)
  }

  return { entry: captured, exports: captured.factory(requireShim) }
}

/** 桩 ctx：记录 effect / slots.inject / slots.register，并提供一个 layout.selectPanel。 */
function makeCtx() {
  const calls = { effects: [], injects: [], registered: [], panels: [], disposers: [] }
  const ctx = {
    effect(fn, label) {
      calls.effects.push(label)
      const dispose = fn()
      if (typeof dispose === 'function') calls.disposers.push(dispose)
      return () => {}
    },
    slots: {
      inject(name, factory) {
        calls.injects.push(name)
        const dispose = factory()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register(desc, component) {
        calls.registered.push({ desc, component })
        return () => {}
      },
    },
    layout: { selectPanel(id) { calls.panels.push(id) } },
    tools: { register(tool) { return () => {} } },
    systemPrompt: { section() { return () => {} } },
    webServer: { register() { return () => {} } },
    // betterSidebar 故意不提供（真实宿主也没有）——验证降级不抛错
  }
  return { ctx, calls }
}

// ── 加载与注册契约 ─────────────────────────────────────────────────────────

test('client.js 能加载：__ModuleLoader__.load 收到正确的 id', () => {
  const { entry } = loadClientModule()
  assert.equal(entry.id, 'dsh-remote-gui')
  assert.equal(typeof entry.factory, 'function')
})

test('导出契约：module.exports = { apply, inject }', () => {
  const { exports } = loadClientModule()
  assert.equal(typeof exports.apply, 'function')
  assert.ok(Array.isArray(exports.inject))
  // `layout` 必须在 inject 里：cordis 未声明就取 ctx.layout 会抛
  // "cannot get property \"layout\" without inject"（关闭按钮/Esc 会静默失效）
  assert.deepEqual(exports.inject, ['slots', 'layout', 'connection', 'locale'])
})

test('apply(ctx)：注册「侧栏图标行 + 中心列页面 + 页脚入口」三处，且都用宿主插槽', () => {
  const { exports } = loadClientModule()
  const { ctx, calls } = makeCtx()

  assert.doesNotThrow(() => exports.apply(ctx))

  // 形态契约：id 与 main 的 key 必须是同一个字符串，否则侧栏点了不会切到面板
  assert.deepEqual(calls.injects.sort(), ['main', 'sidebar.footer.action', 'sidebar.panellist'])

  const panelRow = calls.registered.find((r) => r.desc.name === 'sidebar.panellist')
  const mainPage = calls.registered.find((r) => r.desc.name === 'main')
  const footer = calls.registered.find((r) => r.desc.name === 'sidebar.footer.action')
  assert.ok(panelRow, '必须注册 sidebar.panellist')
  assert.ok(mainPage, '必须注册 main')
  assert.ok(footer, '必须注册 sidebar.footer.action')

  assert.equal(panelRow.desc.id, 'dsh-remote-gui')
  assert.equal(mainPage.desc.key, 'dsh-remote-gui', 'main 的 key 必须等于 panellist 的 id')
  assert.equal(typeof panelRow.component, 'function')
  assert.equal(typeof mainPage.component, 'function')
  assert.equal(typeof footer.component, 'function')
  assert.ok(calls.effects.length >= 2, '应当通过 ctx.effect 挂载可清理的注册')
})

test('形态契约：没有覆盖层/iframe —— 面板不往 body 注入元素，也没有滚动锁', () => {
  const { exports } = loadClientModule()
  const { ctx, calls } = makeCtx()
  exports.apply(ctx)
  // 新形态靠宿主插槽渲染；旧形态会 createElement div + appendChild 到 body 并锁 body.style.overflow
  assert.equal(calls.panels.length, 0, 'apply 期间不应切换主面板（切换是用户点图标时发生）')
  assert.equal(/document\.body\.appendChild/.test(clientSource), false, '不应当有 DOM 注入式覆盖层')
  assert.equal(/body\.style\.overflow/.test(clientSource), false, '不应当有滚动锁')
  assert.equal(/createElement\("iframe"/.test(clientSource), false, '不应当有 iframe')
})

test('关闭面板 = 把主列切回 conversation（不留下任何遮罩/状态）', () => {
  const { exports } = loadClientModule()
  const { ctx, calls } = makeCtx()
  exports.apply(ctx)
  const mainPage = calls.registered.find((r) => r.desc.name === 'main')
  const injected = mainPage.desc.inject()
  assert.equal(typeof injected.closePanel, 'function')
  injected.closePanel()
  assert.deepEqual(calls.panels, ['conversation'])
})

test('页脚入口打开面板（layout.selectPanel 用与 main key 相同的 id）', () => {
  const { exports } = loadClientModule()
  const { ctx, calls } = makeCtx()
  exports.apply(ctx)
  const footer = calls.registered.find((r) => r.desc.name === 'sidebar.footer.action')
  footer.desc.inject().openPanel()
  assert.deepEqual(calls.panels, ['dsh-remote-gui'])
})

test('layout 服务缺失时不抛错（旧宿主/其它客户端形态的降级）', () => {
  const { exports } = loadClientModule()
  const { ctx, calls } = makeCtx()
  delete ctx.layout
  assert.doesNotThrow(() => exports.apply(ctx))
  const mainPage = calls.registered.find((r) => r.desc.name === 'main')
  assert.doesNotThrow(() => mainPage.desc.inject().closePanel())
})

test('反复 apply 不累积状态（每次注册一条面板行）', () => {
  const { exports } = loadClientModule()
  const first = makeCtx()
  const second = makeCtx()
  exports.apply(first.ctx)
  exports.apply(second.ctx)
  assert.equal(first.calls.registered.filter((r) => r.desc.name === 'sidebar.panellist').length, 1)
  assert.equal(second.calls.registered.filter((r) => r.desc.name === 'sidebar.panellist').length, 1)
})

// ── 消息流纯逻辑（远端 records → 面板条目）────────────────────────────────
// 事件形状取自真远端 session/page 的真实响应（2026-10-14 实测）。

const R_USER = { type: 'event', event: { type: 'user/message', seq: 10, time: 1000, data: { content: [{ type: 'text', text: '你好' }] } } }
const R_CALL = { type: 'event', event: { type: 'tool/call', seq: 11, time: 1001, data: { callId: 'c1', name: 'pwsh', arguments: '{"command":"ls"}' } } }
const R_RESULT = {
  type: 'event',
  event: {
    type: 'tool/result', seq: 12, time: 1002,
    data: { toolCallId: 'c1', message: { role: 'tool', content: [{ type: 'text', text: 'file-a\nfile-b' }], isError: false }, sourceEventSeqs: [11] },
  },
}
const R_ASSISTANT = {
  type: 'event',
  event: {
    type: 'assistant/message', seq: 13, time: 1003,
    data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '' }, { type: 'text', text: '看完了' }, { type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{}' }] } },
  },
}
const R_NOISE = { type: 'event', event: { type: 'step/start', seq: 14, time: 1004, data: { turn: 1, step: 1 } } }

test('buildItems：用户/助手正文成条目，工具调用与结果配成一张卡，结构事件被丢掉', () => {
  const { exports } = loadClientModule()
  const items = exports.__buildItemsForTest([R_USER, R_CALL, R_RESULT, R_ASSISTANT, R_NOISE])
  const kinds = items.map((i) => i.kind)
  assert.deepEqual(kinds, ['user', 'tool', 'assistant'], '结构事件不产生条目；工具只出一张卡')
  assert.equal(items[0].text, '你好')
  assert.equal(items[1].name, 'pwsh')
  assert.equal(items[1].args, '{"command":"ls"}')
  assert.equal(items[1].result, 'file-a\nfile-b', '结果按 toolCallId 配到同一张卡上')
  assert.equal(items[2].text, '看完了', 'assistant/message 只取正文块（工具块由 tool/call 代表）')
})

test('buildItems：只有工具调用没有正文的 assistant 消息不产生空条目', () => {
  const { exports } = loadClientModule()
  const onlyTool = {
    type: 'event',
    event: { type: 'assistant/message', seq: 20, time: 1, data: { message: { content: [{ type: 'reasoning', text: '想' }, { type: 'tool-call', id: 'x', name: 't', arguments: '{}' }] } } },
  }
  assert.deepEqual(exports.__buildItemsForTest([onlyTool]), [])
})

test('buildItems：孤立 tool/result（没有配对的 call）也单独成卡，不丢内容', () => {
  const { exports } = loadClientModule()
  const orphan = {
    type: 'event',
    event: { type: 'tool/result', seq: 30, time: 1, data: { toolCallId: 'nope', message: { content: [{ type: 'text', text: '结果原文' }], isError: true } } },
  }
  const items = exports.__buildItemsForTest([orphan])
  assert.equal(items.length, 1)
  assert.equal(items[0].result, '结果原文')
  assert.equal(items[0].isError, true)
})

test('mergeBySeq：轮询整窗 + 加载更早 都按 seq 去重并升序（不重复、不丢）', () => {
  const { exports } = loadClientModule()
  const a = [{ type: 'event', event: { type: 'user/message', seq: 5 } }, { type: 'event', event: { type: 'user/message', seq: 6 } }]
  const b = [{ type: 'event', event: { type: 'user/message', seq: 3 } }, { type: 'event', event: { type: 'user/message', seq: 6 } }]
  const merged = exports.__mergeBySeqForTest(a, b)
  assert.deepEqual(merged.map((r) => r.event.seq), [3, 5, 6], '去重 + 升序')
  assert.equal(exports.__mergeBySeqForTest([], []).length, 0)
})

test('textBlocks：只拼 text，图片给占位，reasoning/tool-call 不混进正文', () => {
  const { exports } = loadClientModule()
  const text = exports.__textBlocksForTest([
    { type: 'reasoning', text: '不该出现' },
    { type: 'text', text: '正文' },
    { type: 'image', mediaType: 'image/png' },
    { type: 'tool-call', name: 'x' },
  ])
  assert.equal(text, '正文\n[图片]')
})

test('describeRouteFailure：401/404 必须说清"要重启应用"，其它状态带上状态码', () => {
  // 为什么这条重要：本插件的路由是"精确路由"，已注册的不走浏览器鉴权（实测无 cookie 也 200），
  // 未注册的会掉进连接层 → 401（不是 404）。所以 401/404 恰好就是
  // "客户端半边已热加载、宿主半边还是旧代码"这个真实场景，必须给出可执行的提示。
  const { exports } = loadClientModule()
  const f = exports.__describeRouteFailureForTest
  const a = f(401, '读取远端会话正文失败')
  const b = f(404, '读取远端会话正文失败')
  assert.match(a, /重启 DSH 应用/)
  assert.match(b, /重启 DSH 应用/)
  assert.match(a, /HTTP 401/)
  const c = f(502, '读取远端会话正文失败')
  assert.equal(c, '读取远端会话正文失败（HTTP 502）')
  assert.equal(f(undefined, '兜底'), '兜底')
})

// ── 主会话 / 子会话折叠（判据来自远端 session/list 的权威字段）──────────────
// 形状全部取自 2026-10-14 真远端 session/list 的实测条目（346 条）。

/** 根会话（VPS DSH / Medisync 这种）：没有 parentSessionId / origin。 */
const ROOT = { sessionId: 'session-4d6e059e-3e17-4d6e-059e-3e1700000000', title: 'VPS DSH', blank: false, turns: 19, origin: null, parentSessionId: null }
/** 子代理会话：origin='subagent' 且带 parentSessionId（实测两者总是同时出现）。 */
const SUBAGENT = { sessionId: 'a5bd3dc4-7320-4745-b012-5498cca32342', title: '## Evaluator人格:评估者', blank: false, turns: 1, origin: 'subagent', parentSessionId: 'a6d7d443dc50' }
/** 探针空壳：宿主自己生成的 id 形状**不是**这样 —— 它是调用方自带 id 建的，字段上看不出父子关系。 */
const SHELL = { sessionId: 'probe-route-mv7wtsx0', title: null, blank: true, turns: 0, origin: null, parentSessionId: null }
/** 用户刚新建、还没说话的空会话：同样是空壳形状，但 id 是宿主生成的 ⇒ 必须保持可见。 */
const EMPTY_ROOT = { sessionId: 'session-0f07cc46-1fe6-4da5-b143-2b405f110fe1', title: null, blank: true, turns: 0, origin: null, parentSessionId: null }

test('classifySession：parentSessionId / origin=subagent 是权威判据，缺省即主会话', () => {
  const { exports } = loadClientModule()
  const c = exports.__classifySessionForTest
  assert.equal(c(ROOT), 'root')
  assert.equal(c(SUBAGENT), 'subagent')
  // 只有其中一个字段也要认（fork 出来的会话只有 parentSessionId，没有 origin）
  assert.equal(c({ sessionId: 'x', parentSessionId: 'p' }), 'subagent')
  assert.equal(c({ sessionId: 'x', origin: 'subagent' }), 'subagent')
  // null / undefined / 空串都算"没有父"（宿主半边把缺省统一成 null）
  assert.equal(c({ sessionId: 'x', parentSessionId: null, origin: null }), 'root')
  assert.equal(c(undefined), 'root')
})

test('classifySession：空壳探针按**启发式**折叠，但绝不误杀"宿主生成的空会话"', () => {
  const { exports } = loadClientModule()
  const c = exports.__classifySessionForTest
  assert.equal(c(SHELL), 'shell', 'probe-route-* 这类自带 id 的空壳要折叠')
  assert.equal(c(EMPTY_ROOT), 'root', '用户新建的空会话（id 是 session-<uuid>）必须留着')
  // 一旦有标题或跑过一轮，即使 id 是自带的也不再是空壳
  assert.equal(c({ ...SHELL, title: '正经标题' }), 'root')
  assert.equal(c({ ...SHELL, turns: 1 }), 'root')
  assert.equal(c({ ...SHELL, blank: false }), 'root')
  assert.equal(c({ ...SHELL, blank: undefined }), 'root')
})

test('selectVisibleSessions：默认只显示主会话，计数分开，正打开的那条永不折叠', () => {
  const { exports } = loadClientModule()
  const f = exports.__selectVisibleSessionsForTest
  const all = [ROOT, SUBAGENT, SHELL, EMPTY_ROOT]

  const filtered = f(all, false, null)
  assert.deepEqual(filtered.shown.map((s) => s.sessionId), [ROOT.sessionId, EMPTY_ROOT.sessionId])
  assert.equal(filtered.hidden, 2)
  assert.equal(filtered.hiddenSubagent, 1, '子代理按权威字段计数')
  assert.equal(filtered.hiddenShell, 1, '空壳探针单独计数（界面上要区别说明）')

  // 正在打开的子会话即使被判成子会话也要留在列表里（否则正文还开着、左栏却没了那一行）
  const kept = f(all, false, SUBAGENT.sessionId)
  assert.ok(kept.shown.some((s) => s.sessionId === SUBAGENT.sessionId))
  assert.equal(kept.hidden, 1, '被 keepId 保住的就不算"已隐藏"')
  assert.equal(kept.hiddenSubagent, 0)
  assert.equal(kept.subagentTotal, 1, '但分类总数不变（开关的渲染条件用它）')

  // 显示全部 = 原样返回，但**分类计数必须照旧**：2026-10-14 真界面上踩到的缺陷 ——
  // 第一版在 showAll 时把隐藏数归零，开关于是自己消失，切到全部后再也切不回"只看主会话"。
  const everything = f(all, true, null)
  assert.deepEqual(everything.shown.map((s) => s.sessionId), all.map((s) => s.sessionId))
  assert.equal(everything.subagentTotal, 1)
  assert.equal(everything.shellTotal, 1)
  assert.equal(everything.hidden, 0, '"当前没显示"的数才是 0')

  assert.equal(f([], false, null).hidden, 0)
  assert.equal(f([], true, null).shown.length, 0)
})

test('默认值与持久化：默认只显示主会话，选择记在 dsh-remote-gui.subagents', () => {
  const { exports } = loadClientModule()
  assert.equal(typeof exports.__RemoteSessionsPanelForTest, 'function')
  // 源码级契约（与 dsh-remote-gui.archived 同一约定）：
  assert.match(clientSource, /dsh-remote-gui\.subagents/)
  assert.match(clientSource, /localStorage\.getItem\(SUBAGENT_VIEW_KEY\) === "all"/, '默认必须是"只显示主会话"')
  assert.match(clientSource, /localStorage\.setItem\(SUBAGENT_VIEW_KEY/)
  // 界面上必须写明判据，不能只靠猜
  assert.match(clientSource, /data-dsh-remote-subagent-toggle/)
  assert.match(clientSource, /origin=subagent/)
})

test('hostSendsLineage：能认出"宿主半边还是旧代码"（没有 parentSessionId 键）', () => {
  // 客户端半边是热加载的、宿主半边要重启应用才换 —— 这个判据决定要不要提示用户重启。
  const { exports } = loadClientModule()
  const f = exports.__hostSendsLineageForTest
  assert.equal(f([ROOT]), true, '新宿主：根会话也会显式带 parentSessionId: null 这个键')
  assert.equal(f([ROOT, SUBAGENT]), true)
  assert.equal(f([{ sessionId: 's1', title: 'T1', blank: false, turns: 3 }]), false, '旧宿主：键整个不存在')
  assert.equal(f([]), true, '没有会话时不做判断（不该凭空报警）')
  assert.equal(f(undefined), true)
})

