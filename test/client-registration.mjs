/**
 * Load the browser half in a stubbed host and assert what it registers.
 *
 * The client bundle normally runs inside `window.__ModuleLoader__.load`, where
 * only a fixed set of host modules is `require`-able. This harness reproduces
 * that one contract: a module loader, a fake `ctx.slots` that records every
 * registration, and the handful of globals the module touches at import time.
 *
 * Why bother: a slot id typo or a second `inject()` on the same slot fails
 * silently in the real app (the cell simply never appears), and a duplicate id
 * inside one activation is worse — it replaces rather than adds. Asserting the
 * exact fan-out here catches both before a restart.
 *
 * Usage: node test/client-registration.mjs
 */
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')
const source = readFileSync(clientPath, 'utf8')

/* ---------------- minimal host stubs ---------------- */

/** React is only ever called as createElement / hooks inside components. */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'Fragment',
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: factory => factory(),
  useRef: value => ({ current: value }),
  useCallback: fn => fn,
}

const registrations = []
const injections = []

const ctx = {
  effect(factory) {
    const dispose = factory()
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
  /**
   * `ctx.inject(names, scope => ...)`: activate only when every named service
   * exists. The plugin's shortcut registration lives behind this, and a real
   * fiber would never run it if `shortcuts` were absent — so the stub simply
   * refuses, which is the truthful outcome for a host without that service.
   */
  inject(services, factory) {
    if (services.includes('shortcuts')) {
      console.log('  (shortcuts service absent in this stub: registration skipped)')
      return
    }
    factory(ctx)
  },
  slots: {
    /** `inject(name, factory)`: the factory receives the scope with `register`. */
    inject(name, factory) {
      injections.push(name)
      const scope = { register: (options, component) => register(options, component) }
      const produced = factory(scope)
      // A generator factory yields every registration of this activation.
      if (produced !== null && typeof produced === 'object' && typeof produced.next === 'function') {
        for (const _ of produced) { /* each yield already registered */ }
      }
      return produced
    },
    register(options) {
      registrations.push(options)
      return { dispose() {} }
    },
  },
}

function register(options, component) {
  registrations.push({ ...options, component })
  return { dispose() {} }
}

const storage = new Map()
const windowStub = {
  __ModuleLoader__: {
    load(definition) {
      windowStub.__loaded = definition
    },
  },
  localStorage: {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  getSelection: () => null,
  // No AudioContext / indexedDB: the alert path must degrade, not throw.
  innerWidth: 1440,
  innerHeight: 900,
}

const sandbox = {
  window: windowStub,
  document: { head: null, getElementById: () => null, createElement: () => ({}) },
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  CustomEvent: class CustomEvent {
    constructor(type, init) {
      this.type = type
      this.detail = init?.detail
    }
  },
  React: undefined,
}
sandbox.globalThis = sandbox

createContext(sandbox)

/* ---------------- load the module ---------------- */

const context = createContext(sandbox)
runInContext(source, context, { filename: clientPath })

const definition = windowStub.__loaded
if (definition === undefined) {
  console.error('FAIL  the module never called window.__ModuleLoader__.load')
  process.exit(1)
}

console.log(`module id: ${definition.id}`)

if (definition.id !== 'dsh-workbench') {
  console.error(`FAIL  module id is ${JSON.stringify(definition.id)}`)
  process.exit(1)
}

const exportsObject = definition.factory(name => {
  if (name === 'react') return reactStub
  throw new Error(`unexpected require(${JSON.stringify(name)})`)
})

console.log(`inject: ${JSON.stringify(exportsObject.inject)}`)

/* ---------------- run apply ---------------- */

exportsObject.apply(ctx)

/* ---------------- assertions ---------------- */

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`)
}

const names = registrations.map(entry => entry.name)
const ids = registrations.map(entry => entry.id)

console.log('\nregistrations:')
for (const entry of registrations) {
  console.log(`  ${String(entry.order ?? '-').padStart(4)}  ${entry.name}  id=${entry.id}`)
}

console.log('\nassertions:')
check('header utilities entries', names.filter(n => n === 'conversation.session.header.utilities').length, 4)
check('overlay entries', names.filter(n => n === 'shell.overlay').length, 2)
check('settings section entries', names.filter(n => n === 'settings.section').length, 1)
check('no duplicate ids', ids.length - new Set(ids).size, 0)
check('every entry carries an id', ids.every(id => typeof id === 'string' && id !== ''), true)
check('every entry carries a name', names.every(name => typeof name === 'string' && name !== ''), true)

// One activation per slot: a second inject() on the same slot would fight for
// the same cell in the real renderer instead of adding a sibling.
check('one inject per slot', injections.length - new Set(injections).size, 0)

const section = registrations.find(entry => entry.name === 'settings.section')
check('settings section is discoverable', typeof section?.label === 'function' ? section.label() : null, '会话工作台')

const headerOrders = registrations
  .filter(entry => entry.name === 'conversation.session.header.utilities')
  .map(entry => entry.order)
check('header entries are ordered and distinct', headerOrders.length - new Set(headerOrders).size, 0)

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
if (failures !== 0) process.exitCode = 1

