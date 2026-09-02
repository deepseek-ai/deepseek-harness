/**
 * Package-owned strict Schedule stream invariant.
 * @module @deepseek-ai/dsh-schedule/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { foldScheduleEvents, ScheduleLogError } from './domain.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-schedule'

/** Cordis invariant-companion plugin name. */
export const name = 'tool-schedule-invariant'
/** Service required before reserving this package's invariant ownership. */
export const inject = ['invariants']

/** Validate a complete exact-session stream under its fork suffix policy. */
function validate(events: readonly SessionEvent[], fail: InvariantFailure): void {
  try {
    foldScheduleEvents(events)
  } catch (error: unknown) {
    /* v8 ignore next -- foldScheduleEvents normalizes every rejected stream to ScheduleLogError. */
    if (!(error instanceof ScheduleLogError)) throw error
    fail(error.message)
  }
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Install replay and pre-append validation for the owned event stream. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    validate(session.ownEvents(), fail)
  }
  ctx.on('session/created', (session) => {
    validate(session.ownEvents(), fail)
  }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type !== 'schedule/change') return
    validate([...session.ownEvents(), event], fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the package-owned invariant companion.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns Exact registration disposer after child setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
