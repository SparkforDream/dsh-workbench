/**
 * Mount the plugin's real components in a miniature React runtime and assert
 * observable behaviour: PowerToys-style modular settings page, per-feature live
 * toggles without page reload, persistence & zero-loss migration from legacy
 * `dsh-workbench` (`localStorage` + `IndexedDB`), `Ctrl/Cmd+Shift+F`
 * pass-through & highlight cleanup, timer lifecycles, and one-click reset.
 *
 * Usage: node test/client-render.mjs
 */
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/* ==================================================================== */
/* miniature React (supports multiple simultaneously mounted roots)     */
/* ==================================================================== */

function createMiniReact() {
  let current = null
  const mountedRoots = new Set()
  const dirtyRoots = new Set()
  let flushScheduled = false

  function flushSync() {
    let guard = 0
    while (dirtyRoots.size > 0 && guard < 32) {
      guard += 1
      const batch = [...dirtyRoots]
      dirtyRoots.clear()
      for (const root of batch) {
        if (mountedRoots.has(root)) root.render()
      }
    }
  }

  function scheduleRerender(slot) {
    dirtyRoots.add(slot)
    if (flushScheduled) return
    flushScheduled = true
    queueMicrotask(() => {
      flushScheduled = false
      flushSync()
    })
  }

  function sameDeps(left, right) {
    if (left === undefined || right === undefined) return left === right
    if (left.length !== right.length) return false
    for (let index = 0; index < left.length; index += 1) {
      if (!Object.is(left[index], right[index])) return false
    }
    return true
  }

  const React = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat() }
    },
    useState(initial) {
      const slot = current
      const index = slot.cursor++
      if (!(index in slot.state)) {
        slot.state[index] = typeof initial === 'function' ? initial() : initial
      }
      const set = value => {
        const next = typeof value === 'function' ? value(slot.state[index]) : value
        if (Object.is(next, slot.state[index])) return
        slot.state[index] = next
        scheduleRerender(slot)
      }
      return [slot.state[index], set]
    },
    useRef(initial) {
      const slot = current
      const index = slot.cursor++
      if (!(index in slot.refs)) slot.refs[index] = { current: initial }
      return slot.refs[index]
    },
    useMemo(factory, deps) {
      const slot = current
      const index = slot.cursor++
      const previous = slot.memo[index]
      if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.value
      const value = factory()
      slot.memo[index] = { value, deps }
      return value
    },
    useCallback(fn, deps) {
      const slot = current
      const index = slot.cursor++
      const previous = slot.memo[index]
      if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.value
      slot.memo[index] = { value: fn, deps }
      return fn
    },
    useEffect(fn, deps) {
      const slot = current
      const index = slot.cursor++
      const previous = slot.effectDeps[index]
      slot.effects[index] = { fn, run: previous === undefined || !sameDeps(previous, deps) }
      slot.effectDeps[index] = deps
    },
  }

  function mount(component, initialProps) {
    let props = initialProps
    let tree = null
    const instance = {
      state: {},
      refs: {},
      memo: {},
      effects: {},
      effectDeps: {},
      cursor: 0,
      cleanups: {},
      render() {
        instance.cursor = 0
        const previous = current
        current = instance
        try {
          tree = component(props)
        } finally {
          current = previous
        }
        for (const [index, effect] of Object.entries(instance.effects)) {
          if (effect.run !== true) continue
          const cleanup = instance.cleanups[index]
          if (typeof cleanup === 'function') cleanup()
          delete instance.cleanups[index]
          const produced = effect.fn()
          if (typeof produced === 'function') instance.cleanups[index] = produced
        }
      },
    }

    mountedRoots.add(instance)
    instance.render()
    return {
      get tree() { return tree },
      update(nextProps) { props = nextProps; instance.render() },
      unmount() {
        mountedRoots.delete(instance)
        dirtyRoots.delete(instance)
        for (const cleanup of Object.values(instance.cleanups)) {
          if (typeof cleanup === 'function') cleanup()
        }
        instance.cleanups = {}
      },
    }
  }

  async function flush() {
    for (let i = 0; i < 4; i += 1) {
      await new Promise(resolve => setImmediate(resolve))
      flushSync()
    }
  }

  return { React, mount, flush }
}

/* ==================================================================== */
/* fake IndexedDB (optional, for custom audio clip migration tests)     */
/* ==================================================================== */

function createFakeIndexedDB(initialDbs = {}, { exposeDatabases = true } = {}) {
  const dbs = new Map()
  for (const [dbName, stores] of Object.entries(initialDbs)) {
    const storeMap = new Map()
    for (const [storeName, entries] of Object.entries(stores)) {
      storeMap.set(storeName, new Map(Object.entries(entries)))
    }
    dbs.set(dbName, storeMap)
  }
  const openedNames = []

  function makeDbHandle(storeMap) {
    return {
      objectStoreNames: {
        contains: name => storeMap.has(name),
      },
      createObjectStore(name) {
        if (!storeMap.has(name)) storeMap.set(name, new Map())
      },
      transaction(storeName) {
        const tx = {
          oncomplete: null,
          onerror: null,
          objectStore() {
            const entries = storeMap.get(storeName)
            return {
              get(key) {
                const req = { result: undefined, onsuccess: null, onerror: null }
                queueMicrotask(() => {
                  req.result = entries?.get(key)
                  req.onsuccess?.()
                })
                return req
              },
              put(value, key) {
                entries?.set(key, value)
                queueMicrotask(() => tx.oncomplete?.())
              },
              delete(key) {
                entries?.delete(key)
                queueMicrotask(() => tx.oncomplete?.())
              },
            }
          },
        }
        return tx
      },
      close() {},
    }
  }

  const indexedDB = {
    open(dbName) {
      openedNames.push(dbName)
      const isNew = !dbs.has(dbName)
      if (isNew) dbs.set(dbName, new Map())
      const storeMap = dbs.get(dbName)
      const handle = makeDbHandle(storeMap)
      const req = { result: handle, onupgradeneeded: null, onsuccess: null, onerror: null }
      queueMicrotask(() => {
        if (isNew) req.onupgradeneeded?.()
        req.onsuccess?.()
      })
      return req
    },
  }
  if (exposeDatabases) {
    indexedDB.databases = async () => [...dbs.keys()].map(name => ({ name, version: 1 }))
  }

  return { indexedDB, dbs, openedNames }
}

/* ==================================================================== */
/* reusable plugin host harness                                         */
/* ==================================================================== */

function loadPlugin(initialStorage = {}, options = {}) {
  const { React, mount, flush } = createMiniReact()

  let nextTimerId = 1
  const timers = new Map()
  const setIntervalStub = (fn, ms) => {
    const id = nextTimerId++
    timers.set(id, { fn, ms, kind: 'interval' })
    return id
  }
  const setTimeoutStub = (fn, ms) => {
    const id = nextTimerId++
    timers.set(id, { fn, ms, kind: 'timeout' })
    return id
  }
  const clearTimerStub = id => { timers.delete(id) }

  const audioLog = []
  const playedAudioUrls = []
  class FakeParam {
    constructor(name) { this.name = name; this.value = 0 }
    setValueAtTime(v) { this.value = v; return this }
    exponentialRampToValueAtTime(v) { this.value = v; return this }
    linearRampToValueAtTime(v) { this.value = v; return this }
  }
  class FakeGain {
    constructor() { this.gain = new FakeParam('gain') }
    connect(node) { return node }
  }
  class FakeOsc {
    constructor(ctx) {
      this.ctx = ctx
      this.type = 'sine'
      this.frequency = new FakeParam('frequency')
    }
    connect(node) { return node }
    start(at) { audioLog.push({ kind: 'start', type: this.type, freq: this.frequency.value, at }) }
    stop() {}
  }
  class FakeAudioContext {
    constructor() {
      this.state = 'running'
      this.currentTime = 0
      this.destination = {}
    }
    createOscillator() { const osc = new FakeOsc(this); this.lastOsc = osc; return osc }
    createGain() { return new FakeGain() }
    resume() { this.state = 'running'; return Promise.resolve() }
  }
  class FakeAudio {
    constructor(src) { this.src = src; this.volume = 1 }
    play() { playedAudioUrls.push({ src: this.src, volume: this.volume }); return Promise.resolve() }
  }

  const registrations = []
  const shortcuts = []
  const storage = new Map(Object.entries(initialStorage))
  const windowListeners = new Map()
  const documentListeners = new Map()
  const highlights = new Map()
  const observers = []
  let reloadCalls = 0
  const idb = options.indexedDB !== undefined ? options.indexedDB : null

  function addListener(map, type, fn) {
    if (!map.has(type)) map.set(type, new Set())
    map.get(type).add(fn)
  }
  function removeListener(map, type, fn) {
    map.get(type)?.delete(fn)
  }
  function dispatchTo(map, event) {
    for (const fn of [...(map.get(event.type) ?? [])]) fn(event)
  }

  const textParent = {
    tagName: 'P',
    closest: () => null,
    checkVisibility: () => true,
    parentElement: null,
  }
  const textNode = {
    nodeValue: 'hello powertoys world and powertoys again',
    parentElement: textParent,
  }
  const chatColumn = {
    parentElement: null,
    getBoundingClientRect: () => ({ top: 0, bottom: 600, height: 600, width: 800 }),
    scrollTop: 0,
    scrollHeight: 600,
    clientHeight: 600,
    dispatchEvent() {},
    scrollTo() {},
    addEventListener() {},
    removeEventListener() {},
  }

  class FakeHighlight {
    constructor(...ranges) { this.ranges = ranges }
  }

  class FakeMutationObserver {
    constructor(cb) {
      this.cb = cb
      this.connected = false
      observers.push(this)
    }
    observe() { this.connected = true }
    disconnect() { this.connected = false }
  }

  class FakeCustomEvent {
    constructor(type, init) {
      this.type = type
      this.detail = init?.detail
    }
  }

  const windowStub = {
    localStorage: {
      getItem: key => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    },
    addEventListener: (type, fn) => addListener(windowListeners, type, fn),
    removeEventListener: (type, fn) => removeListener(windowListeners, type, fn),
    dispatchEvent: event => { dispatchTo(windowListeners, event); return true },
    getSelection: () => null,
    AudioContext: FakeAudioContext,
    Audio: FakeAudio,
    CSS: { highlights },
    Highlight: FakeHighlight,
    location: { reload() { reloadCalls += 1 } },
    innerWidth: 1440,
    innerHeight: 900,
    ...(idb !== null ? { indexedDB: idb.indexedDB } : {}),
  }
  windowStub.__ModuleLoader__ = {
    load(definition) { windowStub.__loaded = definition },
  }

  const documentStub = {
    head: null,
    body: chatColumn,
    documentElement: {},
    scrollingElement: chatColumn,
    getElementById: () => null,
    createElement: () => ({}),
    querySelector: () => chatColumn,
    addEventListener: (type, fn) => addListener(documentListeners, type, fn),
    removeEventListener: (type, fn) => removeListener(documentListeners, type, fn),
    createTreeWalker: () => {
      let yielded = false
      return {
        nextNode() {
          if (yielded) return null
          yielded = true
          return textNode
        },
      }
    },
    createRange: () => ({
      startContainer: textNode,
      selectNodeContents() {},
      setStart(node, offset) { this.startContainer = node; this.startOffset = offset },
      setEnd(node, offset) { this.endContainer = node; this.endOffset = offset },
      getClientRects: () => [{ width: 40, height: 16, top: 100, bottom: 116 }],
      getBoundingClientRect: () => ({ width: 40, height: 16, top: 100, bottom: 116 }),
    }),
  }

  const sandbox = {
    window: windowStub,
    document: documentStub,
    console,
    queueMicrotask,
    setTimeout: setTimeoutStub,
    clearTimeout: clearTimerStub,
    setInterval: setIntervalStub,
    clearInterval: clearTimerStub,
    CustomEvent: FakeCustomEvent,
    MutationObserver: FakeMutationObserver,
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    Element: class {},
    WheelEvent: class { constructor(type) { this.type = type } },
    getComputedStyle: () => ({ overflowY: 'visible' }),
    FileReader: class { readAsDataURL() { this.onerror?.() } },
    URL,
  }
  sandbox.globalThis = sandbox

  const context = createContext(sandbox)
  runInContext(source, context, { filename: 'client.js' })

  const definition = windowStub.__loaded
  const exported = definition.factory(name => {
    if (name === 'react') return React
    throw new Error(`unexpected require(${name})`)
  })

  function recordRegistration(options, component) {
    const entry = { ...options, component }
    registrations.push(entry)
    return entry
  }

  const ctx = {
    effect(factory) { const dispose = factory(); return () => { if (typeof dispose === 'function') dispose() } },
    inject(services, factory) {
      if (services.includes('shortcuts')) {
        factory({
          effect: ctx.effect,
          shortcuts: {
            register(spec) {
              shortcuts.push(spec)
              return { dispose() {} }
            },
          },
        })
        return
      }
      factory(ctx)
    },
    slots: {
      inject(name, factory) {
        const scope = { register: (options, component) => recordRegistration(options, component) }
        const produced = factory(scope)
        if (produced !== null && typeof produced === 'object' && typeof produced.next === 'function') {
          for (const _ of produced) { /* registration already recorded */ }
        }
        return produced
      },
      register(options, component) { return recordRegistration(options, component) },
    },
  }

  exported.apply(ctx)

  const byId = Object.fromEntries(registrations.map(entry => [entry.id, entry]))

  return {
    mount,
    flush,
    byId,
    shortcuts,
    storage,
    timers,
    audioLog,
    playedAudioUrls,
    windowListeners,
    documentListeners,
    highlights,
    observers,
    windowStub,
    idb,
    getReloadCalls: () => reloadCalls,
    dispatchFindOpen(seed = '') {
      windowStub.dispatchEvent(new FakeCustomEvent('dsh-powertoys:find-open', { detail: { seed } }))
    },
    dispatchKeyDown(init) {
      let prevented = false
      let stopped = false
      const event = {
        type: 'keydown',
        defaultPrevented: false,
        isComposing: false,
        repeat: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        code: '',
        ...init,
        preventDefault() { prevented = true; this.defaultPrevented = true },
        stopPropagation() { stopped = true },
      }
      dispatchTo(windowListeners, event)
      return { prevented, stopped }
    },
  }
}

/* ==================================================================== */
/* assertion helpers                                                    */
/* ==================================================================== */

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`)
}

function find(node, predicate, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const child of node) find(child, predicate, out); return out }
  if (typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  for (const child of node.children ?? []) find(child, predicate, out)
  return out
}

function getModuleCheckbox(tree, moduleId) {
  return find(tree, n => n.type === 'input' && n.props.type === 'checkbox' && n.props['data-module'] === moduleId)[0]
}

/* ==================================================================== */
/* 1. settings page (PowerToys modular UI)                              */
/* ==================================================================== */

const host = loadPlugin()
const { mount, flush, byId, shortcuts, storage, timers, audioLog, highlights, observers } = host

console.log('settings page:')
const settingsEntry = byId['powertoys']
check('settings entry exists', settingsEntry !== undefined, true)

const settings = mount(settingsEntry.component, { close() {} })
const tree = settings.tree

const inputs = find(tree, n => n.type === 'input').map(n => n.props)
const checkboxes = inputs.filter(p => p.type === 'checkbox')
const moduleIds = ['duration', 'explorer', 'find', 'reload', 'alert']
check('has 5 module toggles (one per feature)', checkboxes.length, 5)
check('covers all 5 module ids', checkboxes.map(p => p['data-module']), moduleIds)
check('all 5 toggles default to on', checkboxes.every(p => p.checked === true), true)

const cards = find(tree, n => n.props?.className === 'dsh-powertoys-module')
check('renders 5 module cards', cards.length, 5)
check('every module card has a title and description', cards.every(card =>
  find(card, n => n.type === 'b').length >= 1 && find(card, n => n.type === 'small').length >= 1,
), true)

check('has two number fields (interval, max)', inputs.filter(p => p.type === 'number').length, 2)
check('has a volume slider', inputs.filter(p => p.type === 'range').length, 1)
check('interval defaults to 15s', inputs.find(p => p.type === 'number')?.value, 15)
check('volume defaults to 60%', inputs.find(p => p.type === 'range')?.value, 0.6)

const selects = find(tree, n => n.type === 'select')
check('sound picker present', selects.length, 1)
check('offers 4 sounds (3 built-in + custom)', selects[0].children.length, 4)

const buttons = find(tree, n => n.type === 'button').map(n => n.children[0])
check('has a preview button', buttons.includes('试听'), true)
check('has an import button', buttons.includes('导入音效'), true)
check('has a reset button', buttons.includes('恢复默认'), true)
check('has a hidden file input', inputs.filter(p => p.type === 'file').length, 1)

/* ==================================================================== */
/* 2. config persistence & clamping                                     */
/* ==================================================================== */

console.log('\nconfig persistence:')
const intervalInput = inputs.find(p => p.type === 'number')
intervalInput.onChange({ target: { value: '7' } })
await flush()
const storedNotify = JSON.parse(storage.get('dsh-powertoys:notify') ?? '{}')
check('interval is written to localStorage', storedNotify.intervalSec, 7)
check('other fields survive the write', storedNotify.volume, 0.6)
check('out-of-range interval is clamped', (() => {
  intervalInput.onChange({ target: { value: '99999' } })
  return JSON.parse(storage.get('dsh-powertoys:notify')).intervalSec
})(), 600)
await flush()

// Reset via the settings button before live toggle tests.
{
  const resetBtn = find(settings.tree, n => n.type === 'button' && n.children[0] === '恢复默认')[0]
  check('reset button is reachable', resetBtn !== undefined, true)
  resetBtn.props.onClick()
  await flush()
}

/* ==================================================================== */
/* 3. live toggle: duration (PowerToysBadge)                            */
/* ==================================================================== */

console.log('\nlive toggle — duration:')
timers.clear()
let requestedProjectionKey = null
const badgeProps = {
  useProjection: key => {
    requestedProjectionKey = key
    return {
      aiWorkingMs: 12000,
      busyMs: 12000,
      llmMs: 8000,
      toolMs: 4000,
      askMs: 0,
      asks: 0,
      toolCalls: 1,
      steps: 1,
      turns: 1,
      tools: { pwsh: { calls: 1, ms: 4000 } },
      approvals: 0,
      approvalMs: 0,
      approvalByTool: {},
      openStep: { start: Date.now() - 3000 },
    }
  },
  useChat: () => undefined,
}
const badge = mount(byId['powertoys:duration'].component, badgeProps)
check('badge queries powertoysStats projection', requestedProjectionKey, 'powertoysStats')
check('badge renders when enabled', find(badge.tree, n => n.props?.className === 'dsh-powertoys-badge').length, 1)
check('live 1s interval is running while openStep is active', timers.size, 1)

// Open popover before disabling.
find(badge.tree, n => n.props?.className === 'dsh-powertoys-badge')[0].props.onClick()
await flush()
check('popover dialog opens on click', find(badge.tree, n => n.props?.role === 'dialog').length, 1)

// Toggle duration OFF live.
getModuleCheckbox(settings.tree, 'duration').props.onChange({ target: { checked: false } })
await flush()
check('duration toggle persisted to dsh-powertoys:features', JSON.parse(storage.get('dsh-powertoys:features')).duration, false)
check('PowerToysBadge renders null when disabled', badge.tree, null)
check('1s setInterval cleared immediately when disabled', timers.size, 0)

// Toggle duration back ON live: badge returns, popover stays closed, interval resumes.
getModuleCheckbox(settings.tree, 'duration').props.onChange({ target: { checked: true } })
await flush()
check('PowerToysBadge reappears when re-enabled', find(badge.tree, n => n.props?.className === 'dsh-powertoys-badge').length, 1)
check('popover stays closed after re-enable', find(badge.tree, n => n.props?.role === 'dialog').length, 0)
check('1s setInterval resumes when re-enabled', timers.size, 1)
badge.unmount()
timers.clear()

/* ==================================================================== */
/* 4. live toggle: explorer & reload                                    */
/* ==================================================================== */

console.log('\nlive toggle — explorer & reload:')
const explorer = mount(byId['powertoys:explorer'].component, {
  useSessions: selector => selector({ byId: { s1: { cwd: 'D:\\workspace\\dsh-powertoys' } } }),
  sessionId: 's1',
})
const reload = mount(byId['powertoys:reload'].component, {})

check('ExplorerButton renders when enabled', find(explorer.tree, n => n.type === 'button').length, 1)
const reloadNodes = find(reload.tree, n => n.type === 'button')
check('ReloadButton renders one icon button', reloadNodes.length, 1)
check('ReloadButton class is dsh-powertoys-icon', reloadNodes[0].props.className, 'dsh-powertoys-icon')
check('does not reload until clicked', host.getReloadCalls(), 0)
reloadNodes[0].props.onClick()
check('clicking ReloadButton reloads the document', host.getReloadCalls(), 1)

getModuleCheckbox(settings.tree, 'explorer').props.onChange({ target: { checked: false } })
await flush()
check('ExplorerButton renders null when disabled', explorer.tree, null)
check('ReloadButton unaffected when only explorer is off', find(reload.tree, n => n.type === 'button').length, 1)

getModuleCheckbox(settings.tree, 'reload').props.onChange({ target: { checked: false } })
await flush()
check('ReloadButton renders null when disabled', reload.tree, null)

getModuleCheckbox(settings.tree, 'explorer').props.onChange({ target: { checked: true } })
getModuleCheckbox(settings.tree, 'reload').props.onChange({ target: { checked: true } })
await flush()
check('ExplorerButton reappears when re-enabled', find(explorer.tree, n => n.type === 'button').length, 1)
check('ReloadButton reappears when re-enabled', find(reload.tree, n => n.type === 'button').length, 1)
explorer.unmount()
reload.unmount()

/* ==================================================================== */
/* 5. live toggle: find (Button, Bar, Highlights, Observer, Keys)       */
/* ==================================================================== */

console.log('\nlive toggle — find:')
const findBtn = mount(byId['powertoys:find'].component, {})
const findBar = mount(byId['powertoys:find-bar'].component, {})
const findShortcut = shortcuts.find(s => s.id === 'powertoys.find')

check('FindButton renders when enabled', find(findBtn.tree, n => n.type === 'button').length, 1)
check('FindBar starts closed', findBar.tree, null)
check('powertoys.find shortcut resolves handled when enabled', findShortcut?.resolve?.()?.status, 'handled')

// Ctrl+Shift+F opens bar when enabled and consumes key event.
const keyWhileOn = host.dispatchKeyDown({ ctrlKey: true, shiftKey: true, code: 'KeyF' })
await flush()
check('Ctrl+Shift+F calls preventDefault when enabled', keyWhileOn.prevented, true)
check('Ctrl+Shift+F calls stopPropagation when enabled', keyWhileOn.stopped, true)
check('FindBar opens on Ctrl+Shift+F', find(findBar.tree, n => n.props?.role === 'search').length, 1)

// Seed a query so ranges are collected and highlights painted.
host.dispatchFindOpen('powertoys')
await flush()
check('CSS highlight all painted while open', highlights.has('dsh-powertoys-find'), true)
check('CSS highlight current painted while open', highlights.has('dsh-powertoys-find-current'), true)
check('MutationObserver is connected while FindBar is open', observers.some(o => o.connected), true)

// Toggle find OFF live.
getModuleCheckbox(settings.tree, 'find').props.onChange({ target: { checked: false } })
await flush()
check('FindButton renders null when disabled', findBtn.tree, null)
check('FindBar closes and renders null when disabled', findBar.tree, null)
check('CSS highlight all cleared on disable', highlights.has('dsh-powertoys-find'), false)
check('CSS highlight current cleared on disable', highlights.has('dsh-powertoys-find-current'), false)
check('all MutationObservers disconnected on disable', observers.every(o => !o.connected), true)
check('powertoys.find shortcut resolves unhandled when disabled', findShortcut?.resolve?.()?.status, 'unhandled')

// Ctrl+Shift+F and Cmd+Shift+F MUST pass through untouched when find is disabled.
const ctrlPass = host.dispatchKeyDown({ ctrlKey: true, shiftKey: true, code: 'KeyF' })
const metaPass = host.dispatchKeyDown({ metaKey: true, shiftKey: true, code: 'KeyF' })
await flush()
check('Ctrl+Shift+F does NOT preventDefault when find is off', ctrlPass.prevented, false)
check('Ctrl+Shift+F does NOT stopPropagation when find is off', ctrlPass.stopped, false)
check('Cmd+Shift+F does NOT preventDefault when find is off', metaPass.prevented, false)
check('Cmd+Shift+F does NOT stopPropagation when find is off', metaPass.stopped, false)
check('FindBar stays closed on shortcut while disabled', findBar.tree, null)

// Direct find-open event while disabled is ignored too.
host.dispatchFindOpen('powertoys')
await flush()
check('FindBar ignores find-open event while disabled', findBar.tree, null)

// Re-enable find live.
getModuleCheckbox(settings.tree, 'find').props.onChange({ target: { checked: true } })
await flush()
check('FindButton reappears when re-enabled', find(findBtn.tree, n => n.type === 'button').length, 1)
check('FindBar stays closed on re-enable until triggered', findBar.tree, null)
check('powertoys.find shortcut resolves handled again', findShortcut?.resolve?.()?.status, 'handled')
findBtn.unmount()
findBar.unmount()

/* ==================================================================== */
/* 6. live toggle: alert runtime & dsh-powertoys:notify sync            */
/* ==================================================================== */

console.log('\nalert runtime & live toggle:')
timers.clear()
audioLog.length = 0
const runtimeProps = pendingState => ({
  useSessionStatus: selector => selector(new Map([
    ['s1', { running: true, pendingInteraction: pendingState, completionUnread: false }],
  ])),
})

const alertEntry = byId['powertoys:alert']
const alertRuntime = mount(alertEntry.component, runtimeProps(undefined))
check('renders nothing', alertRuntime.tree, null)
check('no timer while idle', timers.size, 0)
check('no sound while idle', audioLog.length, 0)

alertRuntime.update(runtimeProps({ kind: 'approval' }))
await flush()
check('one repeating timer while a prompt is open', timers.size, 1)
const [, alertTimer] = [...timers.entries()][0]
check('timer interval matches the setting', alertTimer.ms, 15_000)
check('chime fired immediately (2 tones)', audioLog.length, 2)
check('chime is the rising two-note figure', audioLog.map(entry => entry.freq), [880, 1320])

alertRuntime.update(runtimeProps({ kind: 'approval' }))
check('unrelated re-render does not stack a second timer', timers.size, 1)

audioLog.length = 0
alertTimer.fn()
alertTimer.fn()
check('repeating alert keeps sounding', audioLog.length, 4)

// Live toggle alert OFF mid-wait: must immediately stop active timer & sync notify key.
audioLog.length = 0
getModuleCheckbox(settings.tree, 'alert').props.onChange({ target: { checked: false } })
await flush()
check('active alert timer cleared immediately when toggled off', timers.size, 0)
check('no sound played after alert toggled off', audioLog.length, 0)
check('dsh-powertoys:features records alert=false', JSON.parse(storage.get('dsh-powertoys:features')).alert, false)
check('dsh-powertoys:notify stays synced with enabled=false', JSON.parse(storage.get('dsh-powertoys:notify')).enabled, false)

// Alert sub-controls in settings should be disabled when alert is off.
const alertNumbersOff = find(settings.tree, n => n.type === 'input' && n.props.type === 'number')
const alertSelectOff = find(settings.tree, n => n.type === 'select')[0]
const alertRangeOff = find(settings.tree, n => n.type === 'input' && n.props.type === 'range')[0]
check('alert sub-settings number inputs disabled when off', alertNumbersOff.every(n => n.props.disabled === true), true)
check('alert sound select disabled when off', alertSelectOff.props.disabled, true)
check('alert volume slider disabled when off', alertRangeOff.props.disabled, true)

// Re-enabling alert while prompt is still open resumes immediately.
getModuleCheckbox(settings.tree, 'alert').props.onChange({ target: { checked: true } })
await flush()
check('alert timer resumes immediately when toggled back on', timers.size, 1)
check('alert chimes immediately on re-enable', audioLog.length, 2)

// Answering the prompt stops the timer.
alertRuntime.update(runtimeProps(undefined))
check('timer cleared once the prompt is answered', timers.size, 0)
alertRuntime.unmount()

/* ==================================================================== */
/* 7. one-click reset restores all 5 modules + alert settings           */
/* ==================================================================== */

console.log('\none-click reset:')
const reloadForReset = mount(byId['powertoys:reload'].component, {})
for (const id of moduleIds) {
  getModuleCheckbox(settings.tree, id).props.onChange({ target: { checked: false } })
}
find(settings.tree, n => n.type === 'input' && n.props.type === 'number')[0].props.onChange({ target: { value: '42' } })
await flush()
check('reload button hidden before reset', reloadForReset.tree, null)

const resetBtn = find(settings.tree, n => n.type === 'button' && n.children[0] === '恢复默认')[0]
resetBtn.props.onClick()
await flush()

const featuresAfterReset = JSON.parse(storage.get('dsh-powertoys:features'))
const notifyAfterReset = JSON.parse(storage.get('dsh-powertoys:notify'))
check('reset restores all 5 modules to true', moduleIds.every(id => featuresAfterReset[id] === true), true)
check('reset restores notify.enabled to true', notifyAfterReset.enabled, true)
check('reset restores notify.intervalSec to 15', notifyAfterReset.intervalSec, 15)
check('reset immediately restores mounted components', find(reloadForReset.tree, n => n.type === 'button').length, 1)
reloadForReset.unmount()
settings.unmount()

/* ==================================================================== */
/* 8. zero-loss migration from legacy dsh-workbench + corrupt storage   */
/* ==================================================================== */

console.log('\nlegacy dsh-workbench migration & corrupt storage:')
{
  // 8a. Legacy pre-modular `dsh-workbench:notify` only (`enabled: false`).
  const legacyHost = loadPlugin({
    'dsh-workbench:notify': JSON.stringify({ enabled: false, intervalSec: 25, volume: 0.4 }),
  })
  const legacySettings = legacyHost.mount(legacyHost.byId['powertoys'].component, { close() {} })
  check('legacy notify enabled=false sets alert toggle off on first load', getModuleCheckbox(legacySettings.tree, 'alert').props.checked, false)
  check('other 4 modules still default on with legacy notify', ['duration', 'explorer', 'find', 'reload'].every(
    id => getModuleCheckbox(legacySettings.tree, id).props.checked === true,
  ), true)
  check('legacy intervalSec preserved', find(legacySettings.tree, n => n.type === 'input' && n.props.type === 'number')[0].props.value, 25)
  check('migrated notify persisted under dsh-powertoys:notify', JSON.parse(legacyHost.storage.get('dsh-powertoys:notify')).intervalSec, 25)
  check('migrated alert state persisted under dsh-powertoys:features', JSON.parse(legacyHost.storage.get('dsh-powertoys:features')).alert, false)

  const legacyAlert = legacyHost.mount(legacyHost.byId['powertoys:alert'].component, {
    useSessionStatus: selector => selector(new Map([
      ['s1', { running: true, pendingInteraction: { kind: 'approval' }, completionUnread: false }],
    ])),
  })
  await legacyHost.flush()
  check('legacy disabled alert schedules nothing', legacyHost.timers.size, 0)
  check('legacy disabled alert stays silent', legacyHost.audioLog.length, 0)
  legacyAlert.unmount()
  legacySettings.unmount()
}

{
  // 8b. Legacy `dsh-workbench:features` + `dsh-workbench:notify` migration.
  const legacyModHost = loadPlugin({
    'dsh-workbench:features': JSON.stringify({ duration: false, explorer: true, find: false, reload: true, alert: true }),
    'dsh-workbench:notify': JSON.stringify({ enabled: true, intervalSec: 30, volume: 0.8 }),
  })
  const legacyModSettings = legacyModHost.mount(legacyModHost.byId['powertoys'].component, { close() {} })
  check('legacy features duration=false migrated', getModuleCheckbox(legacyModSettings.tree, 'duration').props.checked, false)
  check('legacy features find=false migrated', getModuleCheckbox(legacyModSettings.tree, 'find').props.checked, false)
  check('legacy features explorer=true migrated', getModuleCheckbox(legacyModSettings.tree, 'explorer').props.checked, true)
  check('migrated features persisted to dsh-powertoys:features', JSON.parse(legacyModHost.storage.get('dsh-powertoys:features')).find, false)
  legacyModSettings.unmount()
}

{
  // 8c. Legacy IndexedDB (`dsh-workbench-audio`) custom clip migration.
  const customDataUrl = 'data:audio/mpeg;base64,SUQzBAAAAAA='
  const fakeIdb = createFakeIndexedDB({
    'dsh-workbench-audio': { clips: { custom: customDataUrl } },
  })
  const clipHost = loadPlugin(
    { 'dsh-workbench:notify': JSON.stringify({ enabled: true, sound: 'file', fileName: 'my-ding.mp3', volume: 0.7 }) },
    { indexedDB: fakeIdb },
  )
  const clipSettings = clipHost.mount(clipHost.byId['powertoys'].component, { close() {} })
  await clipHost.flush()
  const fileLabels = find(clipSettings.tree, n => n.props?.className === 'dsh-powertoys-file')
  check('legacy custom clip migrated and displayed in settings', fileLabels[0]?.children?.[0], '当前音效：my-ding.mp3')
  check('legacy custom clip copied into dsh-powertoys-audio DB', fakeIdb.dbs.get('dsh-powertoys-audio')?.get('clips')?.get('custom'), customDataUrl)

  // Preview plays the migrated clip without reopening legacy DB.
  const openedBeforePreview = fakeIdb.openedNames.filter(n => n === 'dsh-workbench-audio').length
  const previewBtn = find(clipSettings.tree, n => n.type === 'button' && n.children[0] === '试听')[0]
  previewBtn.props.onClick()
  await clipHost.flush()
  check('preview plays migrated custom clip', clipHost.playedAudioUrls[0]?.src, customDataUrl)
  check('subsequent reads use dsh-powertoys-audio without reopening legacy DB',
    fakeIdb.openedNames.filter(n => n === 'dsh-workbench-audio').length,
    openedBeforePreview)
  clipSettings.unmount()
}

{
  // 8c-ii. Concurrent legacy clip migration (StrictMode mount-unmount-remount
  // overlapping with AlertRuntime.playAlert before migration finishes).
  const customDataUrl = 'data:audio/mpeg;base64,Q09OQ1VSUkVOVA=='
  const concIdb = createFakeIndexedDB({
    'dsh-workbench-audio': { clips: { custom: customDataUrl } },
  })
  const concHost = loadPlugin(
    { 'dsh-workbench:notify': JSON.stringify({ enabled: true, sound: 'file', fileName: 'strict-ding.mp3', volume: 0.7 }) },
    { indexedDB: concIdb },
  )
  // Simulate React StrictMode mount #1 -> immediate unmount -> mount #2, plus
  // simultaneous AlertRuntime firing on a pending prompt before any await settles.
  const firstMount = concHost.mount(concHost.byId['powertoys'].component, { close() {} })
  firstMount.unmount()
  const secondMount = concHost.mount(concHost.byId['powertoys'].component, { close() {} })
  const concurrentAlert = concHost.mount(concHost.byId['powertoys:alert'].component, {
    useSessionStatus: selector => selector(new Map([
      ['s1', { running: true, pendingInteraction: { kind: 'approval' }, completionUnread: false }],
    ])),
  })
  await concHost.flush()

  const concFileLabels = find(secondMount.tree, n => n.props?.className === 'dsh-powertoys-file')
  check('concurrent StrictMode remount still displays migrated custom clip', concFileLabels[0]?.children?.[0], '当前音效：strict-ding.mp3')
  check('concurrent AlertRuntime plays migrated custom clip instead of synth fallback', concHost.playedAudioUrls[0]?.src, customDataUrl)
  check('concurrent callers do not fall back to synth audio', concHost.audioLog.length, 0)
  check('legacy dsh-workbench-audio opened exactly once under concurrency', concIdb.openedNames.filter(n => n === 'dsh-workbench-audio').length, 1)
  concurrentAlert.unmount()
  secondMount.unmount()
}

{
  // 8d. Fresh install MUST NOT open or create empty `dsh-workbench-audio` DB.
  const freshIdb = createFakeIndexedDB({})
  const freshHost = loadPlugin({}, { indexedDB: freshIdb })
  const freshSettings = freshHost.mount(freshHost.byId['powertoys'].component, { close() {} })
  await freshHost.flush()
  check('fresh install does not open legacy dsh-workbench-audio DB', freshIdb.openedNames.includes('dsh-workbench-audio'), false)
  check('fresh install does not create legacy dsh-workbench-audio DB', freshIdb.dbs.has('dsh-workbench-audio'), false)
  freshSettings.unmount()
}

{
  // 8e. Corrupt JSON and non-boolean sanitization.
  const corruptHost = loadPlugin({
    'dsh-powertoys:features': '{not valid json',
    'dsh-powertoys:notify': '<<<broken>>>',
  })
  const corruptSettings = corruptHost.mount(corruptHost.byId['powertoys'].component, { close() {} })
  check('corrupt localStorage degrades cleanly: all 5 modules default on', moduleIds.every(
    id => getModuleCheckbox(corruptSettings.tree, id).props.checked === true,
  ), true)
  check('corrupt notify degrades cleanly: interval defaults to 15', find(
    corruptSettings.tree, n => n.type === 'input' && n.props.type === 'number',
  )[0].props.value, 15)
  corruptSettings.unmount()
}

{
  const partialHost = loadPlugin({
    'dsh-powertoys:features': JSON.stringify({ explorer: false, duration: 'yes', reload: 0, unknown: false }),
  })
  const partialSettings = partialHost.mount(partialHost.byId['powertoys'].component, { close() {} })
  check('valid boolean feature flag honored (explorer=false)', getModuleCheckbox(partialSettings.tree, 'explorer').props.checked, false)
  check('invalid non-boolean values sanitized to defaults', ['duration', 'find', 'reload', 'alert'].every(
    id => getModuleCheckbox(partialSettings.tree, id).props.checked === true,
  ), true)
  partialSettings.unmount()
}

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
if (failures !== 0) process.exitCode = 1
