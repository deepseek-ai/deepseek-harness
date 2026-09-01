/** Package-owned hook invocation/result stream invariants. @module @deepseek-ai/dsh-hook-protocol/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type {} from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-hook-protocol'

/** Cordis companion plugin name. */
export const name = 'hook-protocol-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

interface HookTransition {
  key: string
  delta: 1 | -1
}

interface HookTrace {
  openTurn: number | null
  pending: Map<string, number>
}

/** Correlation key shared by an invoked/result pair. */
function hookKey(data: { turn: number; point: string; handlerId: string }): string {
  return `${data.turn}\0${data.point}\0${data.handlerId}`
}

/** Validate one hook event against committed pending invocations. */
function validateHookEvent(
  trace: HookTrace,
  event: SessionEvent,
  fail: InvariantFailure,
): HookTransition | undefined {
  if (event.type !== 'hook/invoked' && event.type !== 'hook/result') return undefined
  if (trace.openTurn === null) fail(`${event.type} appended outside any open turn`)
  if (event.data.turn !== trace.openTurn) {
    fail(`${event.type} names turn ${event.data.turn} but open turn is ${trace.openTurn}`)
  }
  if (event.type === 'hook/invoked') {
    if (event.data.point.length === 0 || event.data.handlerId.length === 0) {
      fail('hook/invoked point and handlerId must be non-empty')
    }
    const dialect: string = event.data.dialect
    if (dialect !== 'claude-code' && dialect !== 'codex') {
      fail(`hook/invoked carries unknown dialect ${JSON.stringify(dialect)}`)
    }
    return { key: hookKey(event.data), delta: 1 }
  }
  const key = hookKey(event.data)
  if ((trace.pending.get(key) ?? 0) === 0) {
    fail(`hook/result has no matching hook/invoked for ${JSON.stringify(event.data.handlerId)}`)
  }
  if (!Number.isFinite(event.data.durationMs) || event.data.durationMs < 0) {
    fail('hook/result durationMs must be a non-negative finite number')
  }
  return { key, delta: -1 }
}

/** Apply one committed hook-pair transition. */
function applyHookTransition(pending: Map<string, number>, transition: HookTransition): void {
  const next = (pending.get(transition.key) ?? 0) + transition.delta
  if (next === 0) pending.delete(transition.key)
  else pending.set(transition.key, next)
}

/** Install hook invoked/result pairing checks. */
// Event owners keep precommit staging local so their vocabularies never move into a central helper.
/* jscpd:ignore-start */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const traces = new WeakMap<Session, HookTrace>()
  const staged = new WeakMap<SessionEvent, { session: Session; transition: HookTransition }>()
  const seed = (session: Session): HookTrace => {
    const trace: HookTrace = { openTurn: null, pending: new Map() }
    traces.set(session, trace)
    for (const event of session.snapshotEvents()) {
      if (event.type === 'turn/start') trace.openTurn = event.data.turn
      else if (event.type === 'turn/end') trace.openTurn = null
      const transition = validateHookEvent(trace, event, fail)
      if (transition !== undefined) applyHookTransition(trace.pending, transition)
    }
    return trace
  }
  const traceFor = (session: Session): HookTrace => traces.get(session) ?? seed(session)

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('session/event', (session, event) => {
    const trace = traceFor(session)
    if (event.type === 'turn/start') {
      trace.openTurn = event.data.turn
      return
    }
    if (event.type === 'turn/end') {
      trace.openTurn = null
      return
    }
    if (event.type !== 'hook/invoked' && event.type !== 'hook/result') return
    const candidate = staged.get(event)
    /* v8 ignore next -- internal/dispatch stages every hook invocation/result event */
    if (candidate === undefined || candidate.session !== session) return fail('hook event published without pre-commit validation')
    staged.delete(event)
    applyHookTransition(trace.pending, candidate.transition)
  }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    const transition = validateHookEvent(traceFor(session), event, fail)
    if (transition !== undefined) staged.set(event, { session, transition })
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the hook-protocol invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
