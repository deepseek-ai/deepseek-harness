// @vitest-environment jsdom
/** Selecting the one Session a served viewer page presents, once the page's list carries it. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { openSharedSession } from '../src/client/viewer-session.ts'

const SHARED = 'fx-shared' as SessionId

interface ViewerTargetWindow {
  __DSH_LIVESHARE_VIEWER__?: { shareId: string; sessionId: string; basePath: string }
}

/** The page global one served viewer page installs. */
function target(sessionId: string): void {
  ;(globalThis as ViewerTargetWindow).__DSH_LIVESHARE_VIEWER__ = { shareId: 'share-1', sessionId, basePath: '' }
}

describe('opening the shared Session', () => {
  it('navigates at once when the session list already carries the shared Session', () => {
    const openSession = vi.fn()
    const ctx = new Context()
    ctx.provide('sessions', { list: { getSnapshot: () => ({ byId: { [SHARED]: { id: SHARED } } }), subscribe: () => () => {} } } as never)
    ctx.provide('uiWorkspace', { openSession } as never)
    target(SHARED)

    openSharedSession(ctx)

    expect(openSession).toHaveBeenCalledWith(SHARED)
    void ctx.fiber.dispose()
  })

  it('navigates once the list publishes the Session after the page opened', () => {
    let snapshot: { byId: Record<string, unknown> } = { byId: {} }
    let notify: (() => void) | undefined
    const openSession = vi.fn()
    const ctx = new Context()
    ctx.provide('sessions', {
      list: {
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => { notify = listener; return () => { notify = undefined } },
      },
    } as never)
    ctx.provide('uiWorkspace', { openSession } as never)
    target(SHARED)

    openSharedSession(ctx)
    expect(openSession).not.toHaveBeenCalled()

    snapshot = { byId: { [SHARED]: { id: SHARED } } }
    notify?.()
    // A notifier that delivers once more while removing this listener cannot navigate twice.
    notify?.()
    expect(openSession).toHaveBeenCalledOnce()
    expect(openSession).toHaveBeenCalledWith(SHARED)
    void ctx.fiber.dispose()
  })

  it('opens nothing for a page with no share, no Session id, or no session service', () => {
    const ctx = new Context()
    const openSession = vi.fn()
    ctx.provide('uiWorkspace', { openSession } as never)
    // No page global at all.
    delete (globalThis as ViewerTargetWindow).__DSH_LIVESHARE_VIEWER__
    openSharedSession(ctx)
    // A page global that names no Session.
    target('')
    openSharedSession(ctx)
    expect(openSession).not.toHaveBeenCalled()
    void ctx.fiber.dispose()

    // The page has not listed sessions yet: there is no list to wait on.
    target(SHARED)
    openSharedSession(new Context())
    expect(openSession).not.toHaveBeenCalled()
  })
})
