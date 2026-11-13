// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  DOCK_MIN_GUTTER, PINNED_STORAGE_KEY, SessionPanelState, fitsGutter, presentationOf,
} from '../src/client/visibility.ts'

const A = 'session-a' as SessionId
const B = 'session-b' as SessionId
const NARROW = 200
const WIDE = DOCK_MIN_GUTTER

/** A Chat View whose panel the state tracks: its gutter source and the disposer of that registration. */
function chatView(state: SessionPanelState, sessionId: SessionId, gutter: number) {
  const source = createSnapshotStore(gutter)
  const stop = state.track(sessionId, source)
  return { source, stop }
}

/** A state whose Chat Views show `A` and `B` with narrow gutters. */
function newState() {
  const state = new SessionPanelState()
  return { state, a: chatView(state, A, NARROW), b: chatView(state, B, NARROW) }
}

beforeEach(() => { localStorage.clear() })
afterEach(() => { localStorage.clear() })

describe('fitsGutter', () => {
  it('docks only from the minimum gutter up', () => {
    expect(fitsGutter(DOCK_MIN_GUTTER - 1)).toBe(false)
    expect(fitsGutter(DOCK_MIN_GUTTER)).toBe(true)
    expect(fitsGutter(0)).toBe(false)
  })
})

describe('presentationOf', () => {
  it.each([
    [true, true, null, 'docked'],
    [true, true, A, 'docked'],
    [true, false, null, 'hidden'],
    [true, false, A, 'hidden'],
    [false, true, null, 'hidden'],
    [false, false, null, 'hidden'],
    [false, true, A, 'overlay'],
    [false, false, A, 'overlay'],
    [false, true, B, 'hidden'],
  ] as const)('fits=%s pinned=%s overlay=%s shows %s', (fits, pinned, overlay, expected) => {
    expect(presentationOf(fits, { pinned, overlay }, A)).toBe(expected)
  })
})

describe('SessionPanelState room to dock', () => {
  it('gives a Session room while any of its Chat Views has it, and drops the Session once its last panel stops', () => {
    const state = new SessionPanelState()
    expect(state.dockable.getSnapshot().size).toBe(0)
    const main = chatView(state, A, 420)
    const embedded = chatView(state, A, 16)
    expect(state.dockable.getSnapshot().get(A)).toBe(true)
    main.stop()
    expect(state.dockable.getSnapshot().get(A)).toBe(false)
    embedded.source.set(WIDE)
    expect(state.dockable.getSnapshot().get(A)).toBe(true)
    embedded.stop()
    expect(state.dockable.getSnapshot().has(A)).toBe(false)
    // A stopped source publishes nothing.
    const before = state.dockable.getSnapshot()
    embedded.source.set(NARROW)
    expect(state.dockable.getSnapshot()).toBe(before)
  })

  it('publishes only when a Session crosses the docking threshold', () => {
    const state = new SessionPanelState()
    const view = chatView(state, A, 420)
    const first = state.dockable.getSnapshot()
    let calls = 0
    const off = state.dockable.subscribe(() => { calls += 1 })
    view.source.set(400)
    view.source.set(WIDE)
    chatView(state, A, 16)
    expect(state.dockable.getSnapshot()).toBe(first)
    expect(calls).toBe(0)
    view.source.set(WIDE - 1)
    expect(calls).toBe(1)
    off()
  })
})

describe('SessionPanelState visibility', () => {
  it('docks by default and keeps the snapshot identity until a member changes', () => {
    const { state } = newState()
    const first = state.visibility.getSnapshot()
    expect(first).toEqual({ pinned: true, overlay: null })
    expect(state.visibility.getSnapshot()).toBe(first)
  })

  it('flips and persists the docking preference when the gutter has room, closing any overlay', () => {
    const { state, a } = newState()
    state.toggle(A)
    expect(state.visibility.getSnapshot().overlay).toBe(A)
    a.source.set(WIDE)
    expect(state.visibility.getSnapshot().overlay).toBeNull()
    state.toggle(A)
    expect(state.visibility.getSnapshot()).toEqual({ pinned: false, overlay: null })
    expect(localStorage.getItem(PINNED_STORAGE_KEY)).toBe('false')
    expect(new SessionPanelState().visibility.getSnapshot().pinned).toBe(false)
    state.toggle(A)
    expect(state.visibility.getSnapshot().pinned).toBe(true)
  })

  it('opens and closes one Session overlay without touching the docking preference', () => {
    const { state } = newState()
    state.toggle(A)
    state.toggle(B)
    expect(state.visibility.getSnapshot()).toEqual({ pinned: true, overlay: B })
    state.closeOverlay(A)
    expect(state.visibility.getSnapshot().overlay).toBe(B)
    state.toggle(B)
    expect(state.visibility.getSnapshot().overlay).toBeNull()
    state.toggle(A)
    state.closeOverlay(A)
    expect(state.visibility.getSnapshot().overlay).toBeNull()
  })

  it('ignores the toggle of a Session that no Chat View shows', () => {
    const state = new SessionPanelState()
    const before = state.visibility.getSnapshot()
    state.toggle(A)
    expect(state.visibility.getSnapshot()).toBe(before)
  })

  it('treats a stored value other than false as the default', () => {
    localStorage.setItem(PINNED_STORAGE_KEY, '"yes"')
    expect(newState().state.visibility.getSnapshot().pinned).toBe(true)
  })

  it('notifies subscribers of both members and stops after unsubscribe', () => {
    const { state, a } = newState()
    let calls = 0
    const off = state.visibility.subscribe(() => { calls += 1 })
    state.toggle(A)
    a.source.set(WIDE)
    state.toggle(A)
    const seen = calls
    expect(seen).toBeGreaterThanOrEqual(2)
    off()
    state.toggle(A)
    expect(calls).toBe(seen)
  })

  it('closes an overlay once its gutter can dock the panel, without reopening it when the gutter narrows again', () => {
    const { state, a } = newState()
    state.toggle(A)
    a.source.set(300)
    expect(state.visibility.getSnapshot().overlay).toBe(A)
    a.source.set(WIDE)
    expect(state.visibility.getSnapshot()).toEqual({ pinned: true, overlay: null })
    a.source.set(NARROW)
    expect(presentationOf(false, state.visibility.getSnapshot(), A)).toBe('hidden')
  })

  it('closes an overlay once no Chat View shows its Session, so returning to it shows no overlay', () => {
    const { state, a } = newState()
    state.toggle(A)
    a.stop()
    expect(state.visibility.getSnapshot().overlay).toBeNull()
    chatView(state, A, NARROW)
    expect(presentationOf(false, state.visibility.getSnapshot(), A)).toBe('hidden')
  })

  it('follows only the open overlay, and nothing after dispose', () => {
    const { state, a, b } = newState()
    state.toggle(A)
    state.toggle(B)
    // A's Chat View no longer matters once B holds the overlay.
    a.stop()
    expect(state.visibility.getSnapshot().overlay).toBe(B)
    state.dispose()
    b.stop()
    expect(state.visibility.getSnapshot().overlay).toBe(B)
  })
})
