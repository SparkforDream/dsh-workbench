/**
 * Replay a REAL session containing `ask_user_question` calls and compare what
 * the old fold (approval only) and the new fold (approval + ask) report.
 *
 * The point is the delta: the old number silently billed the user's thinking
 * time to the AI, and that error grows without bound on long sessions.
 *
 * Usage: node test/ask-real.mjs <session.v4.jsonl.zstd|_concat.jsonl>
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { workbenchStatsDefinition as def } from '../lib/index.js'

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: node test/ask-real.mjs <session log>')
  process.exit(2)
}

const raw = readFileSync(file)
const text = file.endsWith('.zstd') ? zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8')

const events = []
for (const line of text.split('\n')) {
  if (line.trim() === '') continue
  let parsed
  try { parsed = JSON.parse(line) } catch { continue }
  const event = parsed.event ?? parsed
  if (event.type === undefined || event.time === undefined) continue
  events.push(event)
}

/* ---- independent recount straight from the log (second code path) ---- */

const openAsk = new Map()
const openApproval = new Map()
const truth = { askMs: 0, askCount: 0, approvalMs: 0, approvalCount: 0, asks: [] }
const askTimes = new Map()

for (const event of events) {
  if (event.type === 'tool/call' && event.data?.name === 'ask_user_question') {
    openAsk.set(event.data.callId, event.time)
  } else if (event.type === 'tool/result') {
    const id = event.data?.message?.toolCallId ?? event.data?.message?.source?.callId
    if (openAsk.has(id)) {
      const ms = Math.max(0, event.time - openAsk.get(id))
      openAsk.delete(id)
      truth.askMs += ms
      truth.askCount += 1
      truth.asks.push(ms)
    }
  } else if (event.type === 'approval/asked') {
    openApproval.set(String(event.data?.id ?? ''), event.time)
  } else if (event.type === 'approval/decided') {
    const id = String(event.data?.id ?? '')
    if (openApproval.has(id)) {
      truth.approvalMs += Math.max(0, event.time - openApproval.get(id))
      truth.approvalCount += 1
      openApproval.delete(id)
    }
  }
}

/* ---- plugin fold ---- */

let state = def.init()
for (const event of events) state = def.apply(state, event)
const view = def.wire.view(state)

/* ---- what the old build reported ---- */

const oldToolMs = Math.max(0, view.toolRawMs - view.approvalMs)
const oldAiWorkingMs = Math.max(0, view.busyMs - view.approvalMs)

const min = ms => `${(ms / 60_000).toFixed(1)} min`
const sec = ms => `${(ms / 1000).toFixed(0)}s`

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`)
}

console.log(`log ${file}`)
console.log(`events ${events.length}`)
console.log('')
console.log('question waits (independent recount):')
for (const ms of truth.asks.sort((a, b) => b - a)) console.log(`  ${sec(ms).padStart(9)}  (${min(ms)})`)
console.log('')
console.log('agreement:')
check('askMs', view.askMs, truth.askMs)
check('asks', view.asks, truth.askCount)
check('approvalMs', view.approvalMs, truth.approvalMs)
check('approvals', view.approvals, truth.approvalCount)
check('askMs absent from tools table', Object.hasOwn(view.tools, 'ask_user_question') ? 1 : 0, 0)
console.log('')
console.log('effect of the fix:')
console.log(`  toolMs      old ${min(oldToolMs).padStart(10)}   new ${min(view.toolMs).padStart(10)}   removed ${min(oldToolMs - view.toolMs)}`)
console.log(`  aiWorkingMs old ${min(oldAiWorkingMs).padStart(10)}   new ${min(view.aiWorkingMs).padStart(10)}   removed ${min(oldAiWorkingMs - view.aiWorkingMs)}`)
console.log('')
if (truth.askCount === 0) {
  console.log('NOTE: this log has no answered question, so nothing to subtract.')
}
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
if (failures !== 0) process.exitCode = 1
