/** Client Session status plugin: the `uiSession.sessionStatus` service and the `useSessionStatus` root hook. */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: declares the `sessions` Controller service.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { UiSessionStatus } from './status.ts'

export type { SessionStatus, SessionStatusSnapshot, UiSessionStatus, UseSessionStatus } from './status.ts'

/** Required Controller, Remote, renderer, and Session UI services. */
export const inject = ['remote', 'sessions', 'slots', 'uiSession']

/**
 * Install `ctx.uiSession.sessionStatus` and publish it through the `useSessionStatus` root hook.
 * @param ctx - Client root context.
 */
export function apply(ctx: Context): void {
  const status = new UiSessionStatus(ctx, ctx.sessions, ctx.uiSession.pendingInteractions)
  ctx.slots.provideRoot({ hooks: { sessionStatus: status } })
}
