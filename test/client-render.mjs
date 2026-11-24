/**
 * Mount the plugin's real components in a miniature React runtime and assert
 * observable behaviour: what the settings page renders, whether the alert timer
 * starts and stops with `pendingInteraction`, and whether the synthesiser
 * actually produces oscillators.
 *
 * Why not a browser: the GUI is served behind a cookie gate and, on this
 * machine, a proxy that answers for a different app. A harness that runs the
 * real component functions is both deterministic and closer to the contract
 * under test (props in → tree out, effects in → timers out).
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
/* miniature React                                                      */
/* ==================================================================== */

/**
 * Hooks are keyed by call order in a per-instance slot array, which is exactly
 * how React keys them; that is enough to make `useState` and `useEffect` behave
 * correctly across re-renders of these components.
 */
let current = null
let rerenderScheduled = false
let renderRoot = null

function scheduleRerender() {
  if (rerenderScheduled) return
  rerenderScheduled = true
  queueMicrotask(() => {
    rerenderScheduled = false
    if (renderRoot !== null) renderRoot()
  })
}

const React = {
  Fragment: 'Fragment',
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() }
  },
  useState(initial) {
    const slot = current;
    const index = slot.cursor++
    if (!(index in slot.state)) {
      slot.state[index] = typeof initial === 'function' ? initial() : initial
    }
    const set = value => {
      const next = typeof value === 'function' ? value(slot.state[index]) : value
      if (Object.is(next, slot.state[index])) return
      slot.state[index] = next
      scheduleRerender()
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
    // React semantics: no dep array = every render; a dep array = only when it
    // changes. Honouring this is what makes "the alert repeats from setInterval
    // rather than from a re-render" a meaningful assertion.
    slot.effects[index] = { fn, run: previous === undefined || !sameDeps(previous, deps) }
    slot.effectDeps[index] = deps
  },
}

/** Shallow compare, which is what React does for dependency arrays. */
function sameDeps(left, right) {
  if (left === undefined || right === undefined) return left === right
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (!Object.is(left[index], right[index])) return false
  }
  return true
}

/** Render one component instance, running its effects after the tree is built. */
function mount(component, props) {
  const instance = { state: {}, refs: {}, memo: {}, effects: {}, effectDeps: {}, cursor: 0, cleanups: {} }
  let tree = null

  const render = () => {
    instance.cursor = 0
    const previous = current
    current = instance
    try {
      tree = component(props)
    } finally {
      current = previous
    }
    // Run only the effects whose dependencies changed, replacing the previous
    // one; that is the whole basis for asserting "no duplicate timer".
    for (const [index, effect] of Object.entries(instance.effects)) {
      if (effect.run !== true) continue
      const cleanup = instance.cleanups[index]
      if (typeof cleanup === 'function') cleanup()
      delete instance.cleanups[index]
      const produced = effect.fn()
      if (typeof produced === 'function') instance.cleanups[index] = produced
    }
  }

  renderRoot = render
  render()
  return {
    get tree() { return tree },
    /** Re-render with new props (the slot passes fresh standardProps). */
    update(nextProps) { props = nextProps; render() },
    unmount() {
      for (const cleanup of Object.values(instance.cleanups)) {
        if (typeof cleanup === 'function') cleanup()
      }
      instance.cleanups = {}
      renderRoot = null
    },
  }
}

/* ==================================================================== */
/* fake timers                                                          */
/* ==================================================================== */

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

/* ==================================================================== */
/* fake Web Audio                                                       */
/* ==================================================================== */

const audioLog = []
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

/* ==================================================================== */
/* host stubs                                                           */
/* ==================================================================== */

const registrations = []
const storage = new Map()
let reloadCalls = 0

/** `ctx.slots.register(options, component)` stores the component alongside. */
function recordRegistration(options, component) {
  const entry = { ...options, component }
  registrations.push(entry)
  return entry
}

const windowStub = {
  localStorage: {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  getSelection: () => null,
  AudioContext: FakeAudioContext,
  // `ReloadButton` calls window.location.reload(); count the calls rather than
  // stubbing the whole Location object.
  location: { reload() { reloadCalls += 1 } },
  innerWidth: 1440,
  innerHeight: 900,
  // No indexedDB in the stub: the custom-clip path must degrade, not throw.
}

windowStub.__ModuleLoader__ = {
  load(definition) { windowStub.__loaded = definition },
}

const sandbox = {
  window: windowStub,
  document: { head: null, getElementById: () => null, createElement: () => ({}) },
  console,
  queueMicrotask,
  setTimeout: setTimeoutStub,
  clearTimeout: clearTimerStub,
  setInterval: setIntervalStub,
  clearInterval: clearTimerStub,
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail } },
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

const ctx = {
  effect(factory) { const dispose = factory(); return () => { if (typeof dispose === 'function') dispose() } },
  inject(services, factory) { if (services.includes('shortcuts')) return; factory(ctx) },
  slots: {
    inject(name, factory) {
      // The real slot API is `register(options, component)`; the scope object
      // the factory receives forwards both arguments.
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

/* ==================================================================== */
/* assertions                                                           */
/* ==================================================================== */

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`)
}

/** Flatten a rendered tree into tag names, for structure assertions. */
function tags(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const child of node) tags(child, out); return out }
  if (typeof node !== 'object') return out
  if (typeof node.type === 'string') out.push(node.type)
  for (const child of node.children ?? []) tags(child, out)
  return out
}

/** Collect every node matching a predicate. */
function find(node, predicate, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const child of node) find(child, predicate, out); return out }
  if (typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  for (const child of node.children ?? []) find(child, predicate, out)
  return out
}

const text = node => (find(node, n => typeof n.children?.[0] === 'string')
  .map(n => n.children[0]).join(' '))

/* ---------------- 1. settings page ---------------- */

console.log('settings page:')
const settingsEntry = byId['workbench']
check('settings entry exists', settingsEntry !== undefined, true)

const settings = mount(settingsEntry.component, { close() {} })
const tree = settings.tree

const inputs = find(tree, n => n.type === 'input').map(n => n.props)
check('has an enabled checkbox', inputs.filter(p => p.type === 'checkbox').length, 1)
check('checkbox defaults to on', inputs.find(p => p.type === 'checkbox')?.checked, true)
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

/* ---------------- 2. store persistence ---------------- */

console.log('\nconfig persistence:')
const intervalInput = inputs.find(p => p.type === 'number')
intervalInput.onChange({ target: { value: '7' } })
const stored = JSON.parse(storage.get('dsh-workbench:notify') ?? '{}')
check('interval is written to localStorage', stored.intervalSec, 7)
check('other fields survive the write', stored.volume, 0.6)
check('out-of-range interval is clamped', (() => {
  intervalInput.onChange({ target: { value: '99999' } })
  return JSON.parse(storage.get('dsh-workbench:notify')).intervalSec
})(), 600)

/* ---------------- 3. alert runtime ---------------- */

console.log('\nalert runtime:')
const alertEntry = byId['workbench:alert']
check('alert entry exists', alertEntry !== undefined, true)

// The persistence test above left the shared store clamped at 600s. Reset it
// through the page's own button rather than poking storage: the store is a
// module singleton, so a localStorage write alone would not reach it.
{
  const buttonsAfter = find(settings.tree, n => n.type === 'button')
  const resetButton = buttonsAfter.find(n => n.children[0] === '恢复默认')
  check('reset button is reachable', resetButton !== undefined, true)
  resetButton.props.onClick()
}
timers.clear()
audioLog.length = 0
const runtimeProps = pendingState => ({
  useSessionStatus: selector => selector(new Map([
    ['s1', { running: true, pendingInteraction: pendingState, completionUnread: false }],
  ])),
})

const alertRuntime = mount(alertEntry.component, runtimeProps(undefined))
check('renders nothing', alertRuntime.tree, null)
check('no timer while idle', timers.size, 0)
check('no sound while idle', audioLog.length, 0)

alertRuntime.update(runtimeProps({ kind: 'approval' }))
// Fire the immediate chime's microtasks so the synth path runs.
await new Promise(resolve => queueMicrotask(resolve))
check('one repeating timer while a prompt is open', timers.size, 1)
const [timerId, timer] = [...timers.entries()][0]
check('timer interval matches the setting', timer.ms, 15_000)
check('chime fired immediately (2 tones)', audioLog.length, 2)
check('chime is the rising two-note figure', audioLog.map(entry => entry.freq), [880, 1320])

// Re-render with the SAME state: the effect must not re-arm, or two timers
// would stack and the alert would double up.
alertRuntime.update(runtimeProps({ kind: 'approval' }))
check('an unrelated re-render does not stack a second timer', timers.size, 1)

// Let the interval fire twice and confirm it repeats rather than staying silent.
audioLog.length = 0
timer.fn()
timer.fn()
check('repeating alert keeps sounding', audioLog.length, 4)

// Answering the prompt must stop the timer.
alertRuntime.update(runtimeProps(undefined))
check('timer cleared once the prompt is answered', timers.size, 0)

/* ---------------- 4. reload button ---------------- */

console.log('\nreload button:')
const reloadEntry = byId['workbench:reload']
check('reload cell is registered', reloadEntry !== undefined, true)
check('reload sits last in the header row', reloadEntry.order, 80)

const reload = mount(reloadEntry.component, {})
const reloadNodes = find(reload.tree, n => n.type === 'button')
check('renders one button', reloadNodes.length, 1)
check('button is an icon cell', reloadNodes[0].props.className, 'dsh-workbench-icon')
check('has an accessible label', typeof reloadNodes[0].props['aria-label'] === 'string', true)
check('does not reload until clicked', reloadCalls, 0)

reloadNodes[0].props.onClick()
check('clicking reloads the document', reloadCalls, 1)

/* ---------------- 5. disabled switch ---------------- */

console.log('\nmaster switch:')
const checkbox = find(tree, n => n.type === 'input' && n.props.type === 'checkbox')[0]
checkbox.props.onChange({ target: { checked: false } })
storage.set('dsh-workbench:notify', JSON.stringify({ ...JSON.parse(storage.get('dsh-workbench:notify')), enabled: false }))
timers.clear()
audioLog.length = 0
const offRuntime = mount(alertEntry.component, {
  useSessionStatus: selector => selector(new Map([
    ['s1', { running: true, pendingInteraction: { kind: 'approval' }, completionUnread: false }],
  ])),
})
await new Promise(resolve => queueMicrotask(resolve))
check('disabled config schedules nothing', timers.size, 0)
check('disabled config stays silent', audioLog.length, 0)
void offRuntime

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
if (failures !== 0) process.exitCode = 1
