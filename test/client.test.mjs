/**
 * 客户端半边（client.js）的加载与注册测试。
 *
 * client.js 不是 ESM 也不是普通 CommonJS —— 它是宿主浏览器侧的模块：
 *   window.__ModuleLoader__.load({ id, factory: (require) => module.exports })
 * 所以测试里桩掉 window / document / MutationObserver / location，捕获 load() 的入参，
 * 再用一个假的 require 执行 factory，拿到导出的 { apply, inject }。
 *
 * 断言的是**宿主真正依赖的契约**：模块能加载、导出对、inject 对、apply 不抛错、
 * 并且确实把页脚入口注册进 `sidebar.footer.action` 插槽。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const clientSource = fs.readFileSync(path.join(repoRoot, 'client.js'), 'utf8')

/** 桩 React：只提供 apply 期间可能被读到的 API（本测试不渲染组件）。 */
function makeReactStub() {
  return {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useState(init) { return [typeof init === 'function' ? init() : init, () => {}] },
    useEffect() { /* 不执行 effect */ },
    useCallback(fn) { return fn },
    useRef(value) { return { current: value } },
  }
}

function makeReactDomClientStub() {
  return { createRoot() { return { render() {}, unmount() {} } } }
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
    body: { appendChild() {} },
  }
  class MutationObserverStub {
    observe() {}
    disconnect() {}
  }
  const locationStub = { origin: 'http://127.0.0.1:19387' }

  // client.js 末尾是 `}});` —— 整份源码可以当函数体跑；它只定义东西，
  // 唯一立即执行的是 window.__ModuleLoader__.load(...)。
  const run = new Function('window', 'document', 'MutationObserver', 'location', 'console', clientSource)
  run(windowStub, documentStub, MutationObserverStub, locationStub, console)

  assert.ok(captured, 'window.__ModuleLoader__.load 必须被调用')

  const requireShim = (name) => {
    if (name === 'react') return makeReactStub()
    if (name === 'react-dom/client') return makeReactDomClientStub()
    throw new Error(`unexpected require: ${name}`)
  }

  return { entry: captured, exports: captured.factory(requireShim) }
}

/** 桩 ctx：记录 effect / slots.inject / slots.register / tools.register 的调用。 */
function makeCtx() {
  const calls = { effects: [], injects: [], registered: [], tools: [], disposers: [] }
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
    tools: { register(tool) { calls.tools.push(tool); return () => {} } },
    systemPrompt: { section() { return () => {} } },
    webServer: { register() { return () => {} } },
    // betterSidebar 故意不提供（真实宿主也没有）——验证降级不抛错
  }
  return { ctx, calls }
}

test('client.js 能加载：__ModuleLoader__.load 收到正确的 id', () => {
  const { entry } = loadClientModule()
  assert.equal(entry.id, 'dsh-remote-gui')
  assert.equal(typeof entry.factory, 'function')
})

test('导出契约：module.exports = { apply, inject }', () => {
  const { exports } = loadClientModule()
  assert.equal(typeof exports.apply, 'function')
  assert.ok(Array.isArray(exports.inject))
  assert.deepEqual(exports.inject, ['slots', 'connection', 'locale'])
})

test('apply(ctx) 不抛错，并把页脚入口注册进 sidebar.footer.action', () => {
  const { exports } = loadClientModule()
  const { ctx, calls } = makeCtx()

  assert.doesNotThrow(() => exports.apply(ctx))

  // 页脚入口：ctx.slots.inject("sidebar.footer.action", …) + ctx.slots.register(desc, Component)
  assert.ok(calls.injects.includes('sidebar.footer.action'), '必须 inject sidebar.footer.action 插槽')
  assert.equal(calls.registered.length, 1, '应当注册恰好一个页脚条目')
  assert.equal(calls.registered[0].desc.name, 'sidebar.footer.action')
  assert.equal(calls.registered[0].desc.id, 'dsh-remote-gui')
  assert.equal(typeof calls.registered[0].component, 'function', '第二个参数应当是 React 组件')

  // 注册的组件本身不该在 apply 期间被调用（不渲染）；也不该依赖 ctx
  assert.ok(calls.effects.length >= 1, '应当通过 ctx.effect 挂载')
})

test('反复 apply 不累积状态（每次注册一个条目）', () => {
  const { exports } = loadClientModule()
  const first = makeCtx()
  const second = makeCtx()
  exports.apply(first.ctx)
  exports.apply(second.ctx)
  assert.equal(first.calls.registered.length, 1)
  assert.equal(second.calls.registered.length, 1)
})
