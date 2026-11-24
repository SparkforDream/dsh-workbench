/**
 * Live sampler: every 2 seconds, print the session's current approval/ask
 * figures with the wall-clock time, so a wait in progress is visible as a
 * growing number instead of a single before/after pair.
 *
 * Usage: node test/live-watch.mjs [seconds] [log path]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import { workbenchStatsDefinition as def } from '../lib/index.js'

const seconds = Number(process.argv[2] ?? 90)
const explicit = process.argv[3]

function newestLog(root) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.name.startsWith('session.v4') && entry.name.endsWith('.zstd')) found.push(full)
    }
  }
  walk(root, 0)
  found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return found[0]
}

const file = explicit ?? newestLog(join(homedir(), '.dsh', 'sessions'))

function snapshot() {
  const raw = readFileSync(file)
  const text = zstdDecompressSync(raw).toString('utf8')
  let state = def.init()
  let events = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === undefined || event.time === undefined) continue
    events += 1
    state = def.apply(state, event)
  }
  return { view: def.wire.view(state), events }
}

const clock = () => new Date().toTimeString().slice(0, 8)
const s = ms => `${(ms / 1000).toFixed(1)}s`

console.log(`watching ${file}`)
console.log(`sampling every 2s for ${seconds}s`)
console.log('')
console.log('  time      events  approvalMs   askMs   pending  askOpen  aiWorkingMs')

const deadline = Date.now() + seconds * 1000
let previous = null
while (Date.now() < deadline) {
  let current
  try {
    current = snapshot()
  } catch (error) {
    console.log(`  ${clock()}  read failed: ${String(error).slice(0, 60)}`)
    await new Promise(resolve => setTimeout(resolve, 2000))
    continue
  }
  const { view, events } = current
  const pending = Object.keys(view.pending ?? {}).length
  const askOpen = Object.keys(view.askOpen ?? {}).length
  const line = `  ${clock()}  ${String(events).padStart(6)}  ${s(view.approvalMs).padStart(9)}  ${s(view.askMs).padStart(7)}  ${String(pending).padStart(7)}  ${String(askOpen).padStart(7)}  ${s(view.aiWorkingMs).padStart(10)}`
  const changed = previous === null
    || previous.approvalMs !== view.approvalMs
    || previous.askMs !== view.askMs
    || previous.pending !== pending
  // Print on change, plus once every 10s so a long flat wait still shows life.
  if (changed || events % 5 === 0) console.log(line)
  previous = { approvalMs: view.approvalMs, askMs: view.askMs, pending }
  await new Promise(resolve => setTimeout(resolve, 2000))
}

const final = snapshot().view
console.log('')
console.log(`final: approvalMs=${final.approvalMs} askMs=${final.askMs} approvals=${final.approvals} asks=${final.asks}`)
console.log(`       aiWorkingMs=${final.aiWorkingMs} toolMs=${final.toolMs}`)
