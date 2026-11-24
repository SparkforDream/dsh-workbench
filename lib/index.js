/**
 * dsh-workbench — host half.
 *
 * Registers ONE session projection unit (`workbenchStats`) that folds the durable
 * session log into timing figures the shipped `sessionStats` unit does not
 * expose:
 *
 *   - `busyMs`        Σ step/start → step/end (the AI owns the step: model
 *                     dispatch, retries, tool execution, scheduling)
 *   - `llmMs`         Σ step/start → first assembled assistant/message
 *   - `toolRawMs`     Σ tool/call → tool/result
 *   - `approvalMs`    Σ approval/asked → approval/decided  (human wait)
 *   - `askMs`         Σ ask_user_question call → result     (human wait)
 *   - `toolMs`        toolRawMs − (approvalMs + askMs)  (clamped at 0)
 *   - `aiWorkingMs`   busyMs − (approvalMs + askMs)     (clamped at 0)
 *
 * Plus per-tool-name call counts and durations, plus per-tool approval waits.
 *
 * Why the split matters: `tool/call` is appended BEFORE the approval question
 * (`dsh-tools/src/batch.ts`: `settlement.start()` then `pipeline.prepare()`,
 * and `prepare()` → `serviceAsk()` → `approval.request()`). So the shipped
 * `toolMs` silently includes every minute the user spent away from the
 * keyboard. Subtracting `approvalMs` is what makes "AI working time" honest.
 *
 * Fold fidelity notes taken from the shipped units:
 *   - `step/end` (not `assistant/message`) is the step authority: exactly one
 *     per entered step, appended in a finally, so cancelled and max-token
 *     steps still count.
 *   - `tool/result` carries the tool NAME nowhere; only `message.source.callId`.
 *     The name must be captured at `tool/call` or per-tool stats degrade to an
 *     unnamed bucket.
 *   - `approval/asked` / `approval/decided` are log-only audit events; the
 *     registry validates them, so a replay reconstructs identical figures.
 *
 * @module dsh-workbench
 */

export const name = 'workbench'

/** The projection registry is the whole point; without it this fiber waits. */
export const inject = ['sessionProjections']

const NUMERIC_FIELDS = [
  'busyMs', 'llmMs', 'toolRawMs', 'approvalMs', 'askMs', 'toolMs',
  'aiWorkingMs',
  'turns', 'steps', 'toolCalls', 'approvals', 'asks',
]

/**
 * The one tool whose entire call duration is human time. It is a normal tool
 * as far as the log is concerned — `tool/call` opens, the user answers, then
 * `tool/result` lands — so without this list the minutes a user spends reading
 * and typing an answer are counted as AI working time.
 */
const ASK_TOOL = 'ask_user_question'

const isCount = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isMs = value => typeof value === 'number' && Number.isFinite(value) && value >= 0

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A minimal `{ parse }` schema: the projection registry only ever calls
 * `stateSchema.parse(state)` and `viewSchema.parse(view)`. Hand-rolling it
 * keeps this package dependency-free, so a `file:` install from any directory
 * resolves without a node_modules tree of its own.
 */
function fail(where, detail) {
  throw new Error(`workbenchStats: ${where}${detail === undefined ? '' : ` (${detail})`}`)
}

function validateRecord(where, value, check) {
  if (!isPlainObject(value)) fail(where, 'expected an object')
  for (const [key, row] of Object.entries(value)) {
    if (!isPlainObject(row)) fail(`${where}.${key}`, 'expected an object')
    check(`${where}.${key}`, row)
  }
}

const rowChecks = {
  tools: (where, row) => {
    for (const field of ['calls', 'ms', 'maxMs', 'errors']) {
      if (!isMs(row[field])) fail(`${where}.${field}`)
    }
  },
  approvalByTool: (where, row) => {
    for (const field of ['count', 'ms']) {
      if (!isMs(row[field])) fail(`${where}.${field}`)
    }
  },
  askByTool: (where, row) => {
    for (const field of ['count', 'ms']) {
      if (!isMs(row[field])) fail(`${where}.${field}`)
    }
  },
  pending: (where, row) => {
    if (!isMs(row.at)) fail(`${where}.at`)
    if (typeof row.name !== 'string') fail(`${where}.name`)
  },
  askOpen: (where, row) => {
    if (!isMs(row.at)) fail(`${where}.at`)
    if (typeof row.tool !== 'string') fail(`${where}.tool`)
  },
}

function parseState(value) {
  if (!isPlainObject(value)) fail('state', 'expected an object')
  for (const field of NUMERIC_FIELDS) {
    if (!isMs(value[field])) fail(field)
  }
  for (const field of ['turns', 'steps', 'toolCalls', 'approvals', 'asks']) {
    if (!isCount(value[field])) fail(field, 'expected a non-negative integer')
  }
  if (value.firstAt !== null && !isMs(value.firstAt)) fail('firstAt')
  if (value.lastAt !== null && !isMs(value.lastAt)) fail('lastAt')
  if (value.openStep !== null) {
    if (!isPlainObject(value.openStep)) fail('openStep', 'expected an object or null')
    if (!isCount(value.openStep.turn)) fail('openStep.turn')
    if (!isCount(value.openStep.step)) fail('openStep.step')
    if (!isMs(value.openStep.start)) fail('openStep.start')
    if (typeof value.openStep.llmClosed !== 'boolean') fail('openStep.llmClosed')
  }
  for (const [field, check] of Object.entries(rowChecks)) {
    validateRecord(field, value[field], check)
  }
  // Scalar map, not a row map: tool name → last observed wait in ms.
  if (!isPlainObject(value.lastWaitByTool)) fail('lastWaitByTool', 'expected an object')
  for (const [tool, ms] of Object.entries(value.lastWaitByTool)) {
    if (!isMs(ms)) fail(`lastWaitByTool.${tool}`)
  }
  return value
}

const stateSchema = { parse: parseState }
const viewSchema = { parse: parseState }

/** Bump when the fold's semantics or fields change. */
const STATE_VERSION = 3

function init() {
  return {
    busyMs: 0,
    llmMs: 0,
    toolRawMs: 0,
    approvalMs: 0,
    askMs: 0,
    toolMs: 0,
    aiWorkingMs: 0,
    turns: 0,
    steps: 0,
    toolCalls: 0,
    approvals: 0,
    asks: 0,
    firstAt: null,
    lastAt: null,
    lastTurn: null,
    openStep: null,
    pending: {},
    askOpen: {},
    tools: {},
    approvalByTool: {},
    askByTool: {},
    lastWaitByTool: {},
  }
}

/**
 * Recompute the derived totals from their parts.
 *
 * `toolMs` and `aiWorkingMs` both subtract `approvalMs` AND `askMs`: approval
 * waits and question waits are the same kind of thing — a person deciding —
 * they simply arrive through different channels.
 */
function realign(state) {
  const humanMs = state.approvalMs + state.askMs
  const toolMs = Math.max(0, state.toolRawMs - humanMs)
  const aiWorkingMs = Math.max(0, state.busyMs - humanMs)
  return toolMs === state.toolMs && aiWorkingMs === state.aiWorkingMs
    ? state
    : { ...state, toolMs, aiWorkingMs }
}

function touch(state, time) {
  return {
    firstAt: state.firstAt === null ? time : state.firstAt,
    lastAt: state.lastAt === null ? time : Math.max(state.lastAt, time),
  }
}

function bumpToolRow(tools, name, ms, isError) {
  const prev = tools[name] ?? { calls: 0, ms: 0, maxMs: 0, errors: 0 }
  return {
    ...tools,
    [name]: {
      calls: prev.calls + 1,
      ms: prev.ms + ms,
      maxMs: Math.max(prev.maxMs, ms),
      errors: prev.errors + (isError ? 1 : 0),
    },
  }
}

function apply(state, event) {
  switch (event.type) {
    case 'step/start': {
      const next = {
        ...state,
        ...touch(state, event.time),
        openStep: {
          turn: event.data.turn,
          step: event.data.step,
          start: event.time,
          llmClosed: false,
        },
      }
      return realign(next)
    }
    case 'assistant/message': {
      const open = state.openStep
      // One assembled message closes a step's model span. Retries land before
      // it, so the span already contains them — matching the shipped unit.
      if (open === null || open.llmClosed) return realign(state)
      if (open.turn !== event.data.turn || open.step !== event.data.step) return realign(state)
      const closed = { ...open, llmClosed: true }
      const next = {
        ...state,
        ...touch(state, event.time),
        llmMs: state.llmMs + Math.max(0, event.time - open.start),
        openStep: closed,
      }
      return realign(next)
    }
    case 'step/end': {
      const open = state.openStep
      if (open === null || open.turn !== event.data.turn || open.step !== event.data.step) {
        return realign(state)
      }
      const next = {
        ...state,
        ...touch(state, event.time),
        busyMs: state.busyMs + Math.max(0, event.time - open.start),
        steps: state.steps + 1,
        turns: state.lastTurn === event.data.turn ? state.turns : state.turns + 1,
        lastTurn: event.data.turn,
        openStep: null,
      }
      return realign(next)
    }
    case 'tool/call': {
      const callId = String(event.data.callId ?? '')
      if (callId === '') return realign(state)
      const next = {
        ...state,
        ...touch(state, event.time),
        pending: {
          ...state.pending,
          [callId]: { at: event.time, name: String(event.data.name ?? '') || '(unnamed)' },
        },
      }
      return realign(next)
    }
    case 'tool/result': {
      const callId = event.data?.message?.source?.callId
      if (typeof callId !== 'string' || !Object.hasOwn(state.pending, callId)) {
        return realign(state)
      }
      const pending = { ...state.pending }
      const { at, name } = pending[callId]
      delete pending[callId]
      const ms = Math.max(0, event.time - at)
      const isError = event.data?.message?.isError === true
      // A question is human time from end to end: the model asked, then sat
      // waiting for a person. Fold it into `askMs` instead of tool time, and
      // keep it out of the per-tool table (a 40-minute "tool" is noise there).
      const isAsk = name === ASK_TOOL
      const askRow = state.askByTool[name] ?? { count: 0, ms: 0 }
      const next = {
        ...state,
        ...touch(state, event.time),
        pending,
        toolRawMs: state.toolRawMs + ms,
        toolCalls: state.toolCalls + 1,
        tools: isAsk ? state.tools : bumpToolRow(state.tools, name, ms, isError),
        ...(isAsk
          ? {
            askMs: state.askMs + ms,
            asks: state.asks + 1,
            askByTool: {
              ...state.askByTool,
              [name]: { count: askRow.count + 1, ms: askRow.ms + ms },
            },
          }
          : {}),
      }
      return realign(next)
    }
    case 'approval/asked': {
      const id = String(event.data?.id ?? '')
      if (id === '') return realign(state)
      const next = {
        ...state,
        ...touch(state, event.time),
        askOpen: {
          ...state.askOpen,
          [id]: { at: event.time, tool: String(event.data?.toolName ?? '') || '(unnamed)' },
        },
      }
      return realign(next)
    }
    case 'approval/decided': {
      const id = String(event.data?.id ?? '')
      if (id === '' || !Object.hasOwn(state.askOpen, id)) return realign(state)
      const askOpen = { ...state.askOpen }
      const { at, tool } = askOpen[id]
      delete askOpen[id]
      const ms = Math.max(0, event.time - at)
      const prevRow = state.approvalByTool[tool] ?? { count: 0, ms: 0 }
      const next = {
        ...state,
        ...touch(state, event.time),
        askOpen,
        approvalMs: state.approvalMs + ms,
        approvals: state.approvals + 1,
        approvalByTool: {
          ...state.approvalByTool,
          [tool]: { count: prevRow.count + 1, ms: prevRow.ms + ms },
        },
        lastWaitByTool: { ...state.lastWaitByTool, [tool]: ms },
      }
      return realign(next)
    }
    case 'turn/end': {
      // A call whose result never landed belongs to a cancelled or failed turn.
      // Approval asks and an unclosed step behave the same way: clear them so
      // an aborted turn cannot leave the live badge ticking forever.
      const hasPending = Object.keys(state.pending).length > 0
      const hasAsks = Object.keys(state.askOpen).length > 0
      const hasOpenStep = state.openStep !== null
      if (!hasPending && !hasAsks && !hasOpenStep) return realign(state)
      const next = {
        ...state,
        ...touch(state, event.time),
        openStep: null,
        pending: {},
        askOpen: {},
      }
      return realign(next)
    }
    default:
      // Every uninteresting event returns the SAME reference: Object.is gates
      // the change feed, so a new object here would publish nothing but cost.
      return state
  }
}

function view(state) {
  return {
    busyMs: state.busyMs,
    llmMs: state.llmMs,
    toolRawMs: state.toolRawMs,
    approvalMs: state.approvalMs,
    askMs: state.askMs,
    toolMs: state.toolMs,
    aiWorkingMs: state.aiWorkingMs,
    turns: state.turns,
    steps: state.steps,
    toolCalls: state.toolCalls,
    approvals: state.approvals,
    asks: state.asks,
    firstAt: state.firstAt,
    lastAt: state.lastAt,
    lastTurn: state.lastTurn,
    openStep: state.openStep,
    pending: state.pending,
    askOpen: state.askOpen,
    tools: state.tools,
    approvalByTool: state.approvalByTool,
    askByTool: state.askByTool,
    lastWaitByTool: state.lastWaitByTool,
  }
}

export const workbenchStatsDefinition = {
  key: 'workbenchStats',
  stateVersion: STATE_VERSION,
  stateSchema,
  init,
  apply,
  wire: {
    viewSchema,
    view,
    // An attached Session still receives this key: its control baseline reads
    // `snapshot(session)` with no key selection, so every registered wire key
    // travels. Keeping it out of the LIST summary (the `summaryKeys()` set)
    // avoids attaching a per-tool map to every sidebar row on every refresh.
    summary: false,
  },
}

/**
 * Register the projection unit.
 * @param ctx - registrant context carrying the projection registry.
 * @returns when the unit is registered.
 */
export async function apply_(ctx) {
  await ctx.sessionProjections.register(workbenchStatsDefinition)
}

// Cordis reads `apply` as the plugin body.
export { apply_ as apply }
