/** Client Session status plugin: the `uiSession.sessionStatus` service, the `useSessionStatus` root hook, and reading. */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: declares the `sessions` Controller service.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only service merge for ctx.slots.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { installReading } from './read.ts'
import { UiSessionStatus } from './status.ts'

export type { SessionStatus, SessionStatusSnapshot, UiSessionStatus, UseSessionStatus } from './status.ts'

/** Required Controller, Remote, generated reading namespace, access, renderer, and Session UI services. */
export const inject = ['remote', 'remote.sessionStatus', 'remoteAccess', 'sessions', 'slots', 'uiSession']

/**
 * Install `ctx.uiSession.sessionStatus`, publish it through the `useSessionStatus` root hook, and follow Host reading
 * records into it.
 * @param ctx - Client root context.
 */
export function apply(ctx: Context): void {
  const status = new UiSessionStatus(ctx, ctx.sessions, ctx.uiSession.pendingInteractions)
  ctx.slots.provideRoot({ hooks: { sessionStatus: status } })
  installReading(ctx, status)
}
