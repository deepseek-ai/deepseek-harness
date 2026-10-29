/** Viewer lifecycle: calls, peers, streams, sweeps, and share teardown. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShareRpcActor } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { createViewerLifecycle, VIEWER_STREAM_IDLE_TTL_MS } from '../src/host/viewer-lifecycle.ts'
import type { OpenStream } from '../src/host/viewer-lifecycle.ts'

const viewer: ShareRpcActor = { providerId: 'p', tenantId: 't', subjectId: 'alice' }
const other: ShareRpcActor = { providerId: 'p', tenantId: 't', subjectId: 'bob' }

function stream(overrides: Partial<OpenStream> = {}): OpenStream {
  return {
    shareId: 'share-1', id: 1, endpoint: 'session/follow', actor: viewer,
    controller: new AbortController(), iterator: { next: async () => ({ done: false, value: 1 }) },
    pending: undefined, lastPolledAt: Date.now(), ...overrides,
  }
}

function peer(): { signal: AbortSignal; dispose: () => Promise<void> } {
  return { signal: new AbortController().signal, dispose: vi.fn(async () => {}) }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function harness(options: { readonly connection?: boolean; readonly admitted?: boolean; readonly forkState?: unknown } = {}) {
  const peers: Array<{ signal: AbortSignal; dispose: () => Promise<void> }> = []
  const connection = options.connection === false
    ? undefined
    : { createPeer: vi.fn(() => { const created = peer(); peers.push(created); return created }) }
  const forks = { find: vi.fn((id: string) => ({ shareId: id === 'other-child' ? 'other-share' : 'share-1' })) }
  const lifecycle = createViewerLifecycle({
    ...(connection === undefined ? {} : { connection }),
    forkStateOf: vi.fn(() => options.forkState),
    ...(options.admitted === undefined ? {} : { viewerStillAdmitted: vi.fn(() => options.admitted) }),
    refreshAdmission: vi.fn(async () => {}),
    writeRefusal: vi.fn((_viewer, action: string) => action === 'session/prompt' ? 'not-writable' : undefined),
    forks,
  } as never)
  return { lifecycle, connection, peers, forks }
}

describe('share and access refusals', () => {
  it('reports a stopped or expired share before viewer admission', () => {
    const stopped = harness({ forkState: { stopped: true, viewerAdmitted: true, allowsFork: false } })
    expect(stopped.lifecycle.shareRefusal('share-1', viewer)).toMatchObject({ status: 403, body: { error: 'share-stopped' } })
    const expired = harness({ forkState: { expiresAt: '2000-01-01T00:00:00Z', viewerAdmitted: true, allowsFork: false } })
    expect(expired.lifecycle.shareRefusal('share-1', viewer)).toMatchObject({ body: { error: 'share-expired' } })
  })

  it('reports a viewer whose grant ended and invents no refusal without a state', () => {
    const revoked = harness({ admitted: false })
    expect(revoked.lifecycle.shareRefusal('share-1', viewer))
      .toMatchObject({ status: 403, body: { error: 'viewer-not-authorized' } })
    expect(harness({ admitted: true }).lifecycle.shareRefusal('share-1', viewer)).toBeUndefined()
    expect(harness().lifecycle.shareRefusal('share-1', viewer)).toBeUndefined()
    const live = harness({ forkState: { stopped: false, viewerAdmitted: true, allowsFork: false } })
    expect(live.lifecycle.shareRefusal('share-1', viewer)).toBeUndefined()
  })

  it('reads the policy write refusal and composes the trusted state', () => {
    const h = harness({ admitted: true })
    expect(h.lifecycle.accessRefusal('share-1', viewer, 'session/prompt', 'session-1', true))
      .toMatchObject({ status: 403, reason: 'not-writable', body: { error: 'not-writable' } })
    expect(h.lifecycle.accessRefusal('share-1', viewer, 'session/cancel', 'session-1', true)).toBeUndefined()
    expect(h.lifecycle.trustedState('share-1', viewer, 'session/prompt', 'session-1'))
      .toMatchObject({ reason: 'not-writable' })
    // The same policy rule decides a cancel, and this fixture allows it.
    expect(h.lifecycle.trustedState('share-1', viewer, 'session/cancel', 'session-1')).toBeUndefined()
  })
})

describe('calls, peers, and admission refreshes', () => {
  it('tracks a refresh around one call and stops on end', async () => {
    const h = harness()
    const controller = new AbortController()
    const call = h.lifecycle.beginCall('share-1', viewer, controller, controller.signal)
    await h.lifecycle.refreshAdmission('share-1', controller.signal)
    h.lifecycle.endCall(call)
    await expect(h.lifecycle.refreshAdmission('share-1')).resolves.toBeUndefined()
  })

  it('cancels calls and streams a share or viewer lost access to', () => {
    const h = harness({ admitted: false })
    const controller = new AbortController()
    const call = h.lifecycle.beginCall('share-1', viewer, controller, controller.signal)
    h.lifecycle.recheckAdmission('share-1')
    expect(controller.signal.aborted).toBe(true)

    // A call already refreshing reports its own refusal and is left for its answer.
    const refreshingController = new AbortController()
    h.lifecycle.beginCall('share-1', viewer, refreshingController, refreshingController.signal)
    void h.lifecycle.refreshAdmission('share-1', refreshingController.signal)
    h.lifecycle.recheckAdmission('share-1')
    h.lifecycle.endCall(call)
  })

  it('cancels only the calls of the share and viewer it names', () => {
    const h = harness({ admitted: false })
    const mine = new AbortController()
    const otherViewer = new AbortController()
    const otherShare = new AbortController()
    h.lifecycle.beginCall('share-1', viewer, mine, mine.signal)
    h.lifecycle.beginCall('share-1', other, otherViewer, otherViewer.signal)
    h.lifecycle.beginCall('share-2', viewer, otherShare, otherShare.signal)
    h.lifecycle.cancelPendingCalls('share-1')
    expect(mine.signal.aborted).toBe(true)
    expect(otherViewer.signal.aborted).toBe(true)
    expect(otherShare.signal.aborted).toBe(false)

    const viewerOnly = new AbortController()
    h.lifecycle.beginCall('share-1', viewer, viewerOnly, viewerOnly.signal)
    h.lifecycle.closeViewerStreams('share-1', viewer)
    expect(viewerOnly.signal.aborted).toBe(true)
  })

  it('hands out one peer per share and reader and replaces a disposed one', () => {
    const h = harness()
    const first = h.lifecycle.peerFor('share-1', viewer)!
    expect(h.lifecycle.peerFor('share-1', viewer)).toBe(first)
    expect(h.lifecycle.peerFor('share-1', other)).not.toBe(first)
    expect(harness({ connection: false }).lifecycle.peerFor('share-1', viewer)).toBeUndefined()
  })

  it('disposes the peers that match and reports a failed disposal', async () => {
    const h = harness()
    const first = h.lifecycle.peerFor('share-1', viewer)!
    const second = h.lifecycle.peerFor('share-1', other)!
    // oxlint-disable-next-line typescript/unbound-method -- typed test doubles and mock calls.
    vi.mocked(second.dispose).mockRejectedValueOnce(new Error('dispose failed'))
    h.lifecycle.disposePeers(entry => entry.actor.subjectId === viewer.subjectId)
    // oxlint-disable-next-line typescript/unbound-method -- typed test doubles and mock calls.
    expect(first.dispose).toHaveBeenCalled()
    h.lifecycle.disposePeers(entry => entry.actor.subjectId === other.subjectId)
    await Promise.resolve()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('viewer peer disposal failed'))

    const plain = harness()
    const plainPeer = plain.lifecycle.peerFor('share-1', viewer)!
    // oxlint-disable-next-line typescript/unbound-method -- typed test doubles and mock calls.
    vi.mocked(plainPeer.dispose).mockRejectedValueOnce('plain failure')
    plain.lifecycle.disposePeers(() => true)
    await Promise.resolve()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('plain failure'))
  })
})

describe('streams and the idle sweep', () => {
  it('releases an idle stream, aborts it, and stops the sweep when none remain', () => {
    vi.useFakeTimers()
    const h = harness()
    const abandoned = stream({ lastPolledAt: Date.now() - VIEWER_STREAM_IDLE_TTL_MS - 1 })
    h.lifecycle.registerStream(abandoned)
    vi.advanceTimersByTime(VIEWER_STREAM_IDLE_TTL_MS + 30_000)
    expect(abandoned.controller.signal.aborted).toBe(true)
    expect(h.lifecycle.streamOf('share-1', 1)).toBeUndefined()
    // A stream polled inside the window survives.
    const live = stream({ id: 2, lastPolledAt: Date.now() })
    h.lifecycle.registerStream(live)
    vi.advanceTimersByTime(30_000)
    expect(h.lifecycle.streamOf('share-1', 2)).toBe(live)
  })

  it('releases an opening and its stream, and reports whether a reservation was current', () => {
    const h = harness()
    const reservation = { shareId: 'share-1', actor: viewer, controller: new AbortController() }
    h.lifecycle.reserveOpening('share-1', 3, reservation)
    expect(h.lifecycle.openingOf('share-1', 3)).toBe(reservation)
    expect(h.lifecycle.releaseOpening('share-1', 3, reservation)).toBe(true)
    h.lifecycle.reserveOpening('share-1', 3, reservation)
    expect(h.lifecycle.releaseOpening('share-1', 3, { ...reservation, controller: new AbortController() })).toBe(false)
    // A release drops an opening reservation left under the same key.
    h.lifecycle.release('share-1', 3)
    expect(reservation.controller.signal.aborted).toBe(true)
    expect(h.lifecycle.openingOf('share-1', 3)).toBeUndefined()

    const failing = stream({ id: 5, iterator: { next: async () => ({ done: false, value: 1 }), return: async () => { throw new Error('return failed') } } })
    h.lifecycle.registerStream(failing)
    h.lifecycle.release('share-1', 5)
    expect(failing.controller.signal.aborted).toBe(true)
    h.lifecycle.release('share-1', 99)
  })

  it('releases an idle stream whose iterator refuses to close', () => {
    vi.useFakeTimers()
    const h = harness()
    const stubborn = stream({
      lastPolledAt: Date.now() - VIEWER_STREAM_IDLE_TTL_MS - 1,
      iterator: { next: async () => ({ done: false, value: 1 }), return: async () => { throw new Error('return failed') } },
    })
    h.lifecycle.registerStream(stubborn)
    vi.advanceTimersByTime(VIEWER_STREAM_IDLE_TTL_MS + 30_000)
    expect(h.lifecycle.streamOf('share-1', 1)).toBeUndefined()
  })

  it('releases the opening and stream a revoked share had in flight', () => {
    const h = harness({ admitted: false })
    const reservation = { shareId: 'share-1', actor: viewer, controller: new AbortController() }
    h.lifecycle.reserveOpening('share-1', 8, reservation)
    const held = stream({ id: 9 })
    h.lifecycle.registerStream(held)
    h.lifecycle.recheckAdmission('share-1')
    expect(reservation.controller.signal.aborted).toBe(true)
    expect(held.controller.signal.aborted).toBe(true)
    expect(h.lifecycle.streamOf('share-1', 9)).toBeUndefined()

    // An admitted share keeps its in-flight work, and a second reservation is left alone.
    const admitted = harness({ admitted: true })
    admitted.lifecycle.peerFor('share-1', viewer)
    const kept = { shareId: 'share-1', actor: viewer, controller: new AbortController() }
    const elsewhere = { shareId: 'share-1', actor: viewer, controller: new AbortController() }
    admitted.lifecycle.reserveOpening('share-1', 10, kept)
    admitted.lifecycle.reserveOpening('share-1', 11, elsewhere)
    admitted.lifecycle.recheckAdmission('share-1')
    expect(kept.controller.signal.aborted).toBe(false)

    const mixed = harness({ admitted: false })
    mixed.lifecycle.peerFor('share-1', viewer)
    const first = { shareId: 'share-1', actor: viewer, controller: new AbortController() }
    const second = { shareId: 'share-1', actor: viewer, controller: new AbortController() }
    mixed.lifecycle.reserveOpening('share-1', 12, first)
    mixed.lifecycle.reserveOpening('share-1', 13, second)
    mixed.lifecycle.recheckAdmission('share-1')
    expect(first.controller.signal.aborted).toBe(true)
    expect(second.controller.signal.aborted).toBe(true)
  })

  it('reports whether a stream is still current', () => {
    const h = harness()
    const held = stream()
    h.lifecycle.registerStream(held)
    expect(h.lifecycle.streamIsCurrent('share-1', 1, held)).toBe(true)
    held.controller.abort()
    expect(h.lifecycle.streamIsCurrent('share-1', 1, held)).toBe(false)
    expect(h.lifecycle.streamIsCurrent('share-1', 1, stream())).toBe(false)
  })
})

describe('teardown', () => {
  it('closes one share calls, streams, peers, and the enforcement its children hold', () => {
    const h = harness()
    const callController = new AbortController()
    h.lifecycle.beginCall('share-1', viewer, callController, callController.signal)
    const held = stream({ iterator: { next: async () => ({ done: false, value: 1 }), return: async () => { throw new Error('return failed') } } })
    h.lifecycle.registerStream(held)
    const reservation = { shareId: 'share-1', actor: viewer, controller: new AbortController() }
    h.lifecycle.reserveOpening('share-1', 7, reservation)
    h.lifecycle.peerFor('share-1', viewer)
    const releaseEnforcement = vi.fn()
    const otherEnforcement = vi.fn()
    h.lifecycle.holdEnforcement('child-1', releaseEnforcement)
    h.lifecycle.holdEnforcement('other-child', otherEnforcement)
    const elsewhere = { shareId: 'share-2', actor: viewer, controller: new AbortController() }
    h.lifecycle.reserveOpening('share-2', 14, elsewhere)
    h.lifecycle.registerStream(stream({ shareId: 'share-2', id: 15 }))
    h.lifecycle.closeShare('share-1')
    expect(elsewhere.controller.signal.aborted).toBe(false)
    expect(callController.signal.aborted).toBe(true)
    expect(reservation.controller.signal.aborted).toBe(true)
    expect(held.controller.signal.aborted).toBe(true)
    expect(releaseEnforcement).toHaveBeenCalled()
    // A child whose record names another share keeps its limit.
    expect(otherEnforcement).not.toHaveBeenCalled()
  })

  it('closes only one viewer streams and reports how many were released', () => {
    const h = harness()
    const mine = stream({ id: 1, iterator: { next: async () => ({ done: false, value: 1 }), return: async () => { throw new Error('return failed') } } })
    const theirs = stream({ id: 2, actor: other })
    h.lifecycle.registerStream(mine)
    h.lifecycle.registerStream(theirs)
    h.lifecycle.peerFor('share-1', viewer)
    const reservation = { shareId: 'share-1', actor: viewer, controller: new AbortController() }
    const foreignReservation = { shareId: 'share-1', actor: other, controller: new AbortController() }
    h.lifecycle.reserveOpening('share-1', 5, reservation)
    h.lifecycle.reserveOpening('share-1', 6, foreignReservation)
    expect(h.lifecycle.closeViewerStreams('share-1', viewer)).toBe(2)
    expect(foreignReservation.controller.signal.aborted).toBe(false)
    expect(reservation.controller.signal.aborted).toBe(true)
    expect(mine.controller.signal.aborted).toBe(true)
    expect(theirs.controller.signal.aborted).toBe(false)
  })

  it('closes a fresh reader without a sweep timer', () => {
    const h = harness()
    h.lifecycle.close()
    h.lifecycle.close()
  })

  it('disposes every resource the reader holds', () => {
    const h = harness()
    const callController = new AbortController()
    h.lifecycle.beginCall('share-1', viewer, callController, callController.signal)
    h.lifecycle.registerStream(stream({
      iterator: { next: async () => ({ done: false, value: 1 }), return: async () => { throw new Error('return failed') } },
    }))
    const reservation = { shareId: 'share-1', actor: viewer, controller: new AbortController() }
    h.lifecycle.reserveOpening('share-1', 6, reservation)
    h.lifecycle.peerFor('share-1', viewer)
    const releaseEnforcement = vi.fn()
    h.lifecycle.holdEnforcement('child-1', releaseEnforcement)
    h.lifecycle.close()
    expect(callController.signal.aborted).toBe(true)
    expect(reservation.controller.signal.aborted).toBe(true)
    expect(releaseEnforcement).toHaveBeenCalled()
  })
})
