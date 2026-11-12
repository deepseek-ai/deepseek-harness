/** Test double for `ctx.uiSession.sessionStatus` that scripts the status table and reading readiness. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session-status/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { vi } from 'vitest'

/**
 * Provide `uiSession` and its `sessionStatus` child with an empty table and synchronized reading.
 * @param ctx - bench root Context.
 * @returns the scripted table, readiness, and mark command.
 */
export function provideSessionStatus(ctx: Context) {
  const table = createSnapshotStore<SessionStatusSnapshot>(new Map())
  const readingReady = createSnapshotStore(true)
  const mark = vi.fn<(sessionId: SessionId, unread: boolean) => Promise<void>>(
    () => Promise.reject(new Error('reading mark not stubbed')),
  )
  const sessionStatus = {
    getSnapshot: () => table.getSnapshot(),
    subscribe: (listener: () => void) => table.subscribe(listener),
    readingReady,
    mark,
  }
  ctx.provide('uiSession', { sessionStatus } as never)
  ctx.provide('uiSession.sessionStatus', sessionStatus as never)
  const setUnread = (sessionId: SessionId, unread: boolean): void => {
    table.set(new Map([[sessionId, {
      running: false, pendingInteraction: undefined, completionUnread: unread, completionFailed: false,
    }]]))
  }
  return { table, readingReady, mark, setUnread }
}
