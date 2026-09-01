/** Package-owned approval audit-stream invariants. @module @deepseek-ai/dsh-user-approval/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { ApprovalRequestId } from './index.ts'
import { APPROVAL_POLICIES } from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-user-approval'
const APPROVAL_OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable'] as const

/** Cordis companion plugin name. */
export const name = 'user-approval-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

type ApprovalTransition =
  | { kind: 'asked'; id: ApprovalRequestId }
  | { kind: 'decided'; id: ApprovalRequestId }

interface ApprovalTrace {
  openTurn: number | null
  pending: Set<ApprovalRequestId>
}

/** Validate one approval event against committed unmatched questions. */
function validateApprovalEvent(
  trace: ApprovalTrace,
  event: SessionEvent,
  fail: InvariantFailure,
): ApprovalTransition | undefined {
  if (event.type === 'approval/asked') {
    if (trace.openTurn === null) fail('approval/asked appended outside any open turn')
    if (event.data.toolName.length === 0) fail('approval/asked toolName must be non-empty')
    if (trace.pending.has(event.data.id)) fail(`approval/asked repeated open id ${JSON.stringify(event.data.id)}`)
    return { kind: 'asked', id: event.data.id }
  }
  if (event.type === 'approval/decided') {
    if (trace.openTurn === null) fail('approval/decided appended outside any open turn')
    if (!trace.pending.has(event.data.id)) fail(`approval/decided has no matching approval/asked for id ${JSON.stringify(event.data.id)}`)
    if (!APPROVAL_OUTCOMES.includes(event.data.outcome)) {
      fail(`approval/decided carries unknown outcome ${JSON.stringify(event.data.outcome)}`)
    }
    return { kind: 'decided', id: event.data.id }
  }
  if (event.type === 'approval/policy' && !APPROVAL_POLICIES.includes(event.data.policy)) {
    fail(`approval/policy carries unknown policy ${JSON.stringify(event.data.policy)}`)
  }
  return undefined
}

/** Apply one accepted approval-pair transition. */
function applyApprovalTransition(pending: Set<ApprovalRequestId>, transition: ApprovalTransition): void {
  if (transition.kind === 'asked') pending.add(transition.id)
  else pending.delete(transition.id)
}

/** Install audit pairing and closed-vocabulary checks. */
// Event owners keep precommit staging local so their vocabularies never move into a central helper.
/* jscpd:ignore-start */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const traces = new WeakMap<Session, ApprovalTrace>()
  const staged = new WeakMap<SessionEvent, { session: Session; transition: ApprovalTransition }>()
  const seed = (session: Session): ApprovalTrace => {
    const trace: ApprovalTrace = { openTurn: null, pending: new Set() }
    traces.set(session, trace)
    for (const event of session.snapshotEvents()) {
      if (event.type === 'turn/start') trace.openTurn = event.data.turn
      else if (event.type === 'turn/end') trace.openTurn = null
      const transition = validateApprovalEvent(trace, event, fail)
      if (transition !== undefined) applyApprovalTransition(trace.pending, transition)
    }
    return trace
  }
  const traceFor = (session: Session): ApprovalTrace => traces.get(session) ?? seed(session)

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
    if (event.type !== 'approval/asked' && event.type !== 'approval/decided') return
    const candidate = staged.get(event)
    /* v8 ignore next -- internal/dispatch stages every package-owned pair event */
    if (candidate === undefined || candidate.session !== session) return fail('approval audit event published without pre-commit validation')
    staged.delete(event)
    applyApprovalTransition(trace.pending, candidate.transition)
  }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    const transition = validateApprovalEvent(traceFor(session), event, fail)
    if (transition !== undefined) staged.set(event, { session, transition })
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the approval invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
