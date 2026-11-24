/**
 * Fold growth check: replay the session log twice — once cut off at a baseline
 * timestamp and once complete — and compare the rise in `aiWorkingMs` against an
 * independent tally of the step spans inside that window. A step finishing
 * across the baseline carries its pre-baseline head, so the tally counts the
 * whole span and reports that head separately.
 *
 * Usage: node test/fold-growth.mjs <ISO-or-HH:MM:SS baseline>
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import { workbenchStatsDefinition as def } from '../lib/index.js'

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

function parseBaseline(text) {
  if (/^\d+$/.test(text)) return Number(text)
  const today = new Date()
  const [h, m, s = '0'] = text.split(':')
  today.setHours(Number(h), Number(m), Number(s), 0)
  return today.getTime()
}

const baselineArg = process.argv[2]
if (baselineArg === undefined) {
  console.error('usage: node test/fold-growth.mjs <HH:MM:SS | epoch-ms>')
  process.exit(2)
}
const baseline = parseBaseline(baselineArg)

const file = newestLog(join(homedir(), '.dsh', 'sessions'))
const text = zstdDecompressSync(readFileSync(file)).toString('utf8')

const all = []
for (const line of text.split('\n')) {
  if (line.trim() === '') continue
  try {
    const event = JSON.parse(line)
    if (event.type !== undefined && event.time !== undefined) all.push(event)
  } catch {}
}

const fold = events => {
  let state = def.init()
  for (const event of events) state = def.apply(state, event)
  return def.wire.view(state)
}

const before = fold(all.filter(e => e.time <= baseline))
const after = fold(all)

// The still-open step is included by the fold up to the last recorded event, so
// the independent tally has to clip it at the same instant or the two disagree
// by exactly the length of the in-flight step.
const endTime = all.at(-1).time

const delta = after.aiWorkingMs - before.aiWorkingMs

// Independent tally of real span time inside the window. A step is atomic in
// the fold: it contributes its whole span at `step/end`, so a step that was
// already running at the baseline brings its pre-baseline head along. Clip it
// at the baseline and the two numbers differ by exactly that head.
let spanSum = 0
let straddlerMs = 0
let open = new Map()
let compressInside = []
let openStepStart = null
for (const event of all) {
  if (event.type === 'step/start') {
    open.set(event.data?.id ?? '?', event.time)
    openStepStart = event.time
  } else if (event.type === 'step/end') {
    const key = event.data?.id ?? '?'
    const start = open.get(key)
    if (start !== undefined) {
      open.delete(key)
      if (event.time > baseline) {
        spanSum += event.time - start
        if (start < baseline) straddlerMs += baseline - start
      }
    }
  }
  if (event.type === 'tool/call' && event.data?.name === 'compress' && event.time > baseline) {
    compressInside.push({ at: event.time, stepStart: openStepStart })
  }
}

const clock = ms => new Date(ms).toTimeString().slice(0, 8)
const sec = ms => `${(ms / 1000).toFixed(1)}s`

console.log(`log ${file}`)
console.log(`events ${all.length}`)
console.log(`baseline ${clock(baseline)}  window ${clock(baseline)} -> ${clock(all.at(-1).time)}`)
console.log('')
console.log('                        before          after           delta')
const row = (label, a, b) => {
  console.log(`  ${label.padEnd(20)} ${String(a).padStart(10)} ${String(b).padStart(14)} ${String(b - a).padStart(15)}`)
}
row('aiWorkingMs', before.aiWorkingMs, after.aiWorkingMs)
row('busyMs', before.busyMs, after.busyMs)
row('llmMs', before.llmMs, after.llmMs)
row('toolRawMs', before.toolRawMs, after.toolRawMs)
row('toolMs', before.toolMs, after.toolMs)
row('approvalMs', before.approvalMs, after.approvalMs)
row('askMs', before.askMs, after.askMs)
row('steps', before.steps, after.steps)
console.log('')

console.log(`compress calls inside the window: ${compressInside.length}`)
for (const c of compressInside) {
  console.log(`  at ${clock(c.at)}  inside step started ${clock(c.stepStart)}  (+${sec(c.at - c.stepStart)} into that step)`)
}
console.log('')

const tolerance = 30 // ms of rounding slack
const consistent = Math.abs(delta - spanSum) <= tolerance
console.log(`independent span tally    ${spanSum} ms  (${sec(spanSum)})`)
if (straddlerMs > 0) {
  console.log(`  of which pre-baseline head ${straddlerMs} ms (a step already running at the baseline adds its whole span at step/end)`)
}
console.log(`plugin recorded growth    ${delta} ms  (${sec(delta)})`)
console.log(`difference               ${delta - spanSum} ms`)
console.log(`open step at snapshot     ${after.openStep === null ? 'none' : `${sec(endTime - after.openStep.start)} in flight, excluded from the tally`}`)
console.log('')
console.log(consistent ? 'PASS  recorded growth matches the independent span tally' : 'FAIL  growth and span tally disagree')
process.exit(consistent ? 0 : 1)
