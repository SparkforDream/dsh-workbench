/**
 * Verify that a `ask_user_question` wait is folded into `askMs` and kept OUT of
 * tool time — the case the earlier build got wrong.
 *
 * Usage: node test/ask-fold.mjs [session _concat.jsonl]
 *
 * With no argument it runs a synthetic log so the assertion is reproducible on
 * any machine; pass a real log to check the live fold as well.
 */
import { readFileSync } from 'node:fs'
import { workbenchStatsDefinition as def } from '../lib/index.js'

const MIN = 60_000

/** Build a log where the AI works, then asks a question and waits 8 minutes. */
function synthetic() {
  const t0 = 1_700_000_000_000
  const events = [
    { type: 'turn/start', time: t0, data: { turn: 1 } },
    { type: 'step/start', time: t0, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', time: t0 + 4_000, data: { turn: 1, step: 1, message: { content: [] } } },
    // The AI calls the question tool: this is where human time begins.
    { type: 'tool/call', time: t0 + 5_000, data: { callId: 'q1', name: 'ask_user_question' } },
    // ... the user thinks about it for eight minutes ...
    {
      type: 'tool/result',
      time: t0 + 5_000 + 8 * MIN,
      data: { message: { source: { callId: 'q1' }, content: [], toolCallId: 'q1' } },
    },
    { type: 'step/end', time: t0 + 5_000 + 8 * MIN + 1_000, data: { turn: 1, step: 1 } },
    // An ordinary tool afterwards, so the per-tool table still has a real row.
    { type: 'step/start', time: t0 + 9 * MIN, data: { turn: 1, step: 2 } },
    { type: 'tool/call', time: t0 + 9 * MIN, data: { callId: 'p1', name: 'pwsh' } },
    { type: 'tool/result', time: t0 + 9 * MIN + 3_000, data: { message: { source: { callId: 'p1' }, content: [], toolCallId: 'p1' } } },
    { type: 'step/end', time: t0 + 9 * MIN + 4_000, data: { turn: 1, step: 2 } },
    { type: 'turn/end', time: t0 + 9 * MIN + 5_000, data: { turn: 1 } },
  ]
  return events
}

function fold(events) {
  let state = def.init()
  for (const event of events) state = def.apply(state, event)
  return def.wire.view(state)
}

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`)
}

/* ---------------- synthetic ---------------- */

console.log('synthetic log (8-minute question wait):')
const view = fold(synthetic())
const ASK_WAIT = 8 * MIN

check('askMs', view.askMs, ASK_WAIT)
check('asks', view.asks, 1)
check('askByTool.ask_user_question.ms', view.askByTool.ask_user_question?.ms ?? -1, ASK_WAIT)
check('toolMs excludes the ask wait', view.toolMs, view.toolRawMs - ASK_WAIT)
check('aiWorkingMs excludes the ask wait', view.aiWorkingMs, view.busyMs - ASK_WAIT)
check('ask_user_question absent from tools table', Object.hasOwn(view.tools, 'ask_user_question') ? 1 : 0, 0)
check('pwsh still in tools table', view.tools.pwsh?.calls ?? -1, 1)
check('pwsh measured 3000ms', view.tools.pwsh?.ms ?? -1, 3_000)

// The headline assertion: without the ask subtraction this number would be
// eight minutes larger. State it as a value so a regression is unmistakable.
const naive = view.busyMs
console.log(`  info  busyMs ${naive} ms, of which ${ASK_WAIT} ms is the person answering`)

/* ---------------- real log ---------------- */

const file = process.argv[2]
if (file !== undefined) {
  console.log(`\nreal log ${file}:`)
  const events = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    let parsed
    try { parsed = JSON.parse(line) } catch { continue }
    const event = parsed.event ?? parsed
    if (event.type === undefined || event.time === undefined) continue
    events.push(event)
  }
  const live = fold(events)
  console.log(`  events ${events.length}`)
  console.log(`  askMs ${live.askMs} ms, asks ${live.asks}`)
  console.log(`  approvalMs ${live.approvalMs} ms, approvals ${live.approvals}`)
  console.log(`  aiWorkingMs ${live.aiWorkingMs} ms`)
  console.log(`  toolMs ${live.toolMs} ms`)
  for (const [tool, row] of Object.entries(live.askByTool)) {
    console.log(`  askByTool.${tool}: ${row.count} call(s), ${row.ms} ms`)
  }
}

console.log('')
if (failures === 0) {
  console.log('ALL CHECKS PASSED')
} else {
  console.log(`${failures} CHECK(S) FAILED`)
  process.exitCode = 1
}
