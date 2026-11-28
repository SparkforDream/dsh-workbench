/**
 * Replay one real session log through the `powertoysStats` fold and print the
 * figures, next to an INDEPENDENT recount computed straight from the log with
 * a different code path. Two implementations agreeing is the point; one
 * implementation agreeing with itself proves nothing.
 *
 * Usage: node test/replay.mjs [path-to-_concat.jsonl]
 */
import { readFileSync } from 'node:fs'
import { powertoysStatsDefinition as def } from '../lib/index.js'

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: node test/replay.mjs <session _concat.jsonl>')
  process.exit(2)
}

const MIN = 60_000

function fmtMin(ms) {
  return `${(ms / MIN).toFixed(1)} min`
}

/* ------------------------------------------------------------------ */
/* Path A: the plugin's own fold                                       */
/* ------------------------------------------------------------------ */
const events = []
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (line.trim() === '') continue
  let record
  try {
    record = JSON.parse(line)
  } catch {
    continue
  }
  // The header line is `{type:'session', ...}` with no seq; skip it.
  if (typeof record.seq !== 'number') continue
  events.push(record)
}

let state = def.init()
let folded = 0
for (const event of events) {
  const next = def.apply(state, event)
  if (next !== state) folded += 1
  state = next
}
// The registry re-parses on every publication; do it here so a schema bug
// surfaces in the test rather than in the live change feed.
const view = def.wire.viewSchema.parse(def.wire.view(state))

/* ------------------------------------------------------------------ */
/* Path B: independent recount, written from the event shapes directly  */
/* ------------------------------------------------------------------ */
const stepOpen = new Map()
const pendingCalls = new Map()
const askOpen = new Map()
const questionOpen = new Map()
let bBusy = 0
let bToolRaw = 0
let bApproval = 0
let bAsk = 0
let bLlm = 0
let bSteps = 0
const bTools = new Map()

/** The one tool whose whole duration is a person reading and typing. */
const ASK_TOOL = 'ask_user_question'

for (const event of events) {
  const t = event.time
  const d = event.data ?? {}
  switch (event.type) {
    case 'step/start':
      stepOpen.set(`${d.turn}/${d.step}`, { at: t, llmDone: false })
      break
    case 'assistant/message': {
      const open = stepOpen.get(`${d.turn}/${d.step}`)
      if (open !== undefined && !open.llmDone) {
        bLlm += Math.max(0, t - open.at)
        open.llmDone = true
      }
      break
    }
    case 'step/end': {
      const key = `${d.turn}/${d.step}`
      const open = stepOpen.get(key)
      if (open !== undefined) {
        bBusy += Math.max(0, t - open.at)
        bSteps += 1
        stepOpen.delete(key)
      }
      break
    }
    case 'tool/call':
      if (typeof d.callId === 'string') {
        pendingCalls.set(d.callId, { at: t, name: String(d.name ?? '') })
        if (d.name === ASK_TOOL) questionOpen.set(d.callId, t)
      }
      break
    case 'tool/result': {
      const id = d.message?.source?.callId
      const open = pendingCalls.get(id)
      if (open === undefined) break
      pendingCalls.delete(id)
      const ms = Math.max(0, t - open.at)
      bToolRaw += ms
      if (open.name === ASK_TOOL) {
        questionOpen.delete(id)
        bAsk += ms
        break
      }
      const row = bTools.get(open.name) ?? { calls: 0, ms: 0 }
      bTools.set(open.name, { calls: row.calls + 1, ms: row.ms + ms })
      break
    }
    case 'approval/asked':
      if (typeof d.id === 'string') askOpen.set(d.id, t)
      break
    case 'approval/decided': {
      const at = askOpen.get(d.id)
      if (at === undefined) break
      askOpen.delete(d.id)
      bApproval += Math.max(0, t - at)
      break
    }
    default:
      break
  }
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */
const rows = [
  ['events in log', String(events.length), String(events.length)],
  ['events that changed state', String(folded), '—'],
  ['AI working (main number)', fmtMin(view.aiWorkingMs), fmtMin(Math.max(0, bBusy - bApproval - bAsk))],
  ['  step spans (busy)', fmtMin(view.busyMs), fmtMin(bBusy)],
  ['  − approval wait', fmtMin(view.approvalMs), fmtMin(bApproval)],
  ['  − question wait', fmtMin(view.askMs), fmtMin(bAsk)],
  ['model time (llm)', fmtMin(view.llmMs), fmtMin(bLlm)],
  ['tool time (waits removed)', fmtMin(view.toolMs), fmtMin(Math.max(0, bToolRaw - bApproval - bAsk))],
  ['tool time (raw)', fmtMin(view.toolRawMs), fmtMin(bToolRaw)],
  ['steps', String(view.steps), String(bSteps)],
  ['tool calls (excl. ask)', String(Object.values(view.tools).reduce((n, r) => n + r.calls, 0)), String([...bTools.values()].reduce((n, r) => n + r.calls, 0))],
]

console.log('')
console.log('metric                              plugin            independent')
console.log('-'.repeat(72))
let mismatch = 0
for (const [label, a, b] of rows) {
  const same = a === b || (a.endsWith('min') && b.endsWith('min') && a === b)
  if (!same && b !== '—') mismatch += 1
  console.log(`${label.padEnd(34)}${a.padStart(17)}${b.padStart(21)}${same || b === '—' ? '' : '   <-- MISMATCH'}`)
}

console.log('')
const topTools = Object.entries(view.tools)
  .sort((x, y) => y[1].ms - x[1].ms)
  .slice(0, 12)
console.log('top tools by duration           calls        total       avg       max   errors')
console.log('-'.repeat(80))
for (const [tool, row] of topTools) {
  const avg = row.calls === 0 ? 0 : row.ms / row.calls
  console.log(
    `${tool.slice(0, 30).padEnd(32)}${String(row.calls).padStart(6)}`
    + `${fmtMin(row.ms).padStart(13)}${(avg / 1000).toFixed(1).padStart(10)}s`
    + `${(row.maxMs / 1000).toFixed(1).padStart(10)}s${String(row.errors).padStart(9)}`,
  )
}

console.log('')
console.log(`approvals observed : ${view.approvals}`)
console.log(`approval wait      : ${fmtMin(view.approvalMs)}`)
console.log(`questions observed : ${view.asks}`)
console.log(`question wait      : ${fmtMin(view.askMs)}`)
console.log(`turns              : ${view.turns}`)
console.log('')
console.log(mismatch === 0
  ? 'RESULT: PASS — both code paths agree on every timed figure.'
  : `RESULT: FAIL — ${mismatch} figure(s) disagree.`)
process.exit(mismatch === 0 ? 0 : 1)
