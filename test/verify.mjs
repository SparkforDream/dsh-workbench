/**
 * Three checks that a real-log replay cannot make on its own:
 *
 *  1. AGREEMENT WITH THE SHIPPED UNIT — fold the same log with
 *     `@deepseek-ai/dsh-session-stats`'s own definition and compare `llmMs`
 *     and `toolMs` field by field. If my fold disagrees with the shipped one
 *     on logs that contain no approvals, my fold is simply wrong.
 *  2. THE APPROVAL SUBTRACTION — a hand-built log where the user sits on an
 *     approval for exactly 10 minutes. `toolRawMs` must contain it, `toolMs`
 *     and `aiWorkingMs` must not, and the wait must surface per tool.
 *  3. CANCELLED-TURN HYGIENE — an approval whose `decided` never arrives (the
 *     turn dies) must not accumulate a wait or leak into the next turn.
 *
 * Usage: node test/verify.mjs [path-to-_concat.jsonl]
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { powertoysStatsDefinition as powertoys } from '../lib/index.js'

/**
 * Resolve the shipped sessionStats unit only when running real-log comparison
 * and `$DSH_SESSION_STATS` points to a local DSH checkout.
 */
const shippedUrl = process.env.DSH_SESSION_STATS
let shipped
if (shippedUrl !== undefined && shippedUrl !== '') {
  const mod = await import(pathToFileURL(shippedUrl).href)
  shipped = mod.sessionStatsProjectionDefinition
  if (shipped === undefined) {
    console.error(`could not load the shipped sessionStats unit from ${shippedUrl}`)
    process.exit(2)
  }
}

const MIN = 60_000
let failures = 0

function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`)
}

/* ------------------------------------------------------------------ */
/* 1. Agreement with the shipped sessionStats unit                     */
/* ------------------------------------------------------------------ */
const file = process.argv[2]
if (file !== undefined && shipped !== undefined) {
  const events = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (typeof record.seq !== 'number') continue
    events.push(record)
  }
  const header = { id: 'synthetic', createdAt: events[0]?.time ?? 0 }
  let mine = powertoys.init(header, 0)
  let theirs = shipped.init(header, 0)
  for (const event of events) {
    mine = powertoys.apply(mine, event)
    theirs = shipped.apply(theirs, event)
  }
  console.log('--- agreement with @deepseek-ai/dsh-session-stats ---')
  check('llmMs matches shipped', mine.llmMs, theirs.llmMs)
  check('toolMs matches shipped when no approval occurred', mine.toolMs, theirs.toolMs)
  check('steps matches shipped', mine.steps, theirs.steps)
  check('turns matches shipped', mine.turns, theirs.turns)
  console.log('')
}

/* ------------------------------------------------------------------ */
/* 2 + 3. Synthetic logs                                               */
/* ------------------------------------------------------------------ */
const T0 = 1_700_000_000_000

function event(type, time, data) {
  return { type, seq: 0, time, data }
}

/** One turn: step → tool call → approval (waited `waitMs`) → result → step end. */
function turnWithWait({ start, waitMs, decide = true, callId = 'call-1', tool = 'pwsh', workMs = 2_000 }) {
  const out = [event('turn/start', start, { turn: 1 })]
  const stepAt = start + 1_000
  out.push(event('step/start', stepAt, { turn: 1, step: 1 }))
  const modelAt = stepAt + 3_000
  out.push(event('assistant/message', modelAt, { turn: 1, step: 1, stream: [], usage: { outputTokens: 10 } }))
  const callAt = modelAt + 500
  out.push(event('tool/call', callAt, { turn: 1, step: 1, callId, name: tool, arguments: '{}' }))
  const askedAt = callAt + 20
  out.push(event('approval/asked', askedAt, { id: `ask-${callId}`, toolName: tool, callId }))
  if (decide) {
    const decidedAt = askedAt + waitMs
    out.push(event('approval/decided', decidedAt, { id: `ask-${callId}`, outcome: 'allowed-once' }))
    out.push(event('tool/result', decidedAt + workMs, {
      turn: 1, step: 1,
      message: { source: { callId }, isError: false, content: [] },
    }))
    const endAt = decidedAt + workMs + 500
    out.push(event('step/end', endAt, { turn: 1, step: 1 }))
    out.push(event('turn/end', endAt + 10, { turn: 1, reason: 'stop' }))
    return { events: out, endAt }
  }
  // Cancelled: the turn dies while the question is still open.
  const endAt = askedAt + waitMs
  out.push(event('turn/end', endAt, { turn: 1, reason: 'cancelled' }))
  return { events: out, endAt }
}

console.log('--- approval wait is subtracted from AI working time ---')
{
  const { events, endAt } = turnWithWait({ start: T0, waitMs: 10 * MIN })
  let state = powertoys.init({ id: 's', createdAt: T0 }, 0)
  for (const e of events) state = powertoys.apply(state, e)
  const v = powertoys.wire.viewSchema.parse(powertoys.wire.view(state))

  const stepSpan = endAt - (T0 + 1_000)          // whole step, wait included
  // tool/call lands 20 ms before the question is asked, so the raw span is
  // approval + prep + execution. That 20 ms is genuinely AI-side dispatch.
  const rawTool = 10 * MIN + 2_000 + 20
  check('step span counted in busyMs', v.busyMs, stepSpan)
  check('approval wait measured', v.approvalMs, 10 * MIN)
  check('toolRawMs keeps the wait', v.toolRawMs, rawTool)
  check('toolMs drops the wait', v.toolMs, rawTool - 10 * MIN)
  check('aiWorkingMs drops the wait', v.aiWorkingMs, stepSpan - 10 * MIN)
  check('wait attributed to the tool', v.approvalByTool.pwsh?.ms, 10 * MIN)
  check('approval counted', v.approvals, 1)
  check('model time untouched', v.llmMs, 3_000)
}

console.log('')
console.log('--- an approval the user never answers does not leak ---')
{
  const { events } = turnWithWait({ start: T0, waitMs: 10 * MIN, decide: false })
  let state = powertoys.init({ id: 's', createdAt: T0 }, 0)
  for (const e of events) state = powertoys.apply(state, e)
  const v = powertoys.wire.viewSchema.parse(powertoys.wire.view(state))
  check('no wait accumulated', v.approvalMs, 0)
  check('open asks cleared on turn/end', Object.keys(v.askOpen).length, 0)
  check('tool time unaffected', v.toolMs, 0)
}

console.log('')
console.log('--- approved work still books its own duration ---')
{
  const { events } = turnWithWait({ start: T0, waitMs: 30_000, workMs: 5_000 })
  let state = powertoys.init({ id: 's', createdAt: T0 }, 0)
  for (const e of events) state = powertoys.apply(state, e)
  const v = powertoys.wire.view(state)
  // 20 ms of pre-question dispatch + 5 s of execution; the 30 s wait is out.
  check('toolMs is execution plus dispatch only', v.toolMs, 5_020)
  check('calls counted', v.tools.pwsh?.calls, 1)
  // The per-tool row keeps the raw span on purpose: that is what the timeline
  // shows. The wait is reachable separately via approvalByTool.
  check('per-tool total includes wait (raw view)', v.tools.pwsh?.ms, 35_020)
  check('per-tool wait is separately addressable', v.approvalByTool.pwsh?.ms, 30_000)
}

console.log('')
console.log('--- aborted turn clears openStep so badge stops ticking ---')
{
  let state = powertoys.init({ id: 's', createdAt: T0 }, 0)
  state = powertoys.apply(state, event('step/start', T0, { turn: 1, step: 1 }))
  state = powertoys.apply(state, event('turn/end', T0 + 5_000, { turn: 1 }))
  const v = powertoys.wire.viewSchema.parse(powertoys.wire.view(state))
  check('openStep cleared on turn/end', v.openStep, null)
}

console.log('')
console.log(failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures} check(s))`)
process.exit(failures === 0 ? 0 : 1)
