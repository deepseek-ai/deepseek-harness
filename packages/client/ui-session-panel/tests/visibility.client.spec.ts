// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConversationLayout } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  DOCK_MIN_GUTTER, PINNED_STORAGE_KEY, SessionPanelState, fitsLayout, presentationOf,
} from '../src/client/visibility.ts'

const A = 'session-a' as SessionId
const B = 'session-b' as SessionId

/** Main body layout of each Session, as `ctx.uiConversation.layouts` publishes it. */
let layouts: Map<SessionId, SnapshotStore<ConversationLayout>>

function layoutOf(sessionId: SessionId): SnapshotStore<ConversationLayout> {
  let store = layouts.get(sessionId)
  if (store === undefined) {
    store = createSnapshotStore<ConversationLayout>({ endGutter: 200, shown: true })
    layouts.set(sessionId, store)
  }
  return store
}

function newState(): SessionPanelState {
  return new SessionPanelState(layoutOf)
}

beforeEach(() => {
  localStorage.clear()
  layouts = new Map()
})
afterEach(() => { localStorage.clear() })

describe('fitsLayout', () => {
  it('docks only from the minimum gutter up', () => {
    expect(fitsLayout({ endGutter: DOCK_MIN_GUTTER - 1, shown: true })).toBe(false)
    expect(fitsLayout({ endGutter: DOCK_MIN_GUTTER, shown: true })).toBe(true)
    expect(fitsLayout({ endGutter: 0, shown: false })).toBe(false)
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

describe('SessionPanelState', () => {
  it('docks by default and keeps the snapshot identity until a member changes', () => {
    const state = newState()
    const first = state.visibility.getSnapshot()
    expect(first).toEqual({ pinned: true, overlay: null })
    expect(state.visibility.getSnapshot()).toBe(first)
  })

  it('flips and persists the docking preference when the gutter has room, closing any overlay', () => {
    const state = newState()
    state.toggle(A, false)
    expect(state.visibility.getSnapshot().overlay).toBe(A)
    state.toggle(A, true)
    expect(state.visibility.getSnapshot()).toEqual({ pinned: false, overlay: null })
    expect(localStorage.getItem(PINNED_STORAGE_KEY)).toBe('false')
    expect(newState().visibility.getSnapshot().pinned).toBe(false)
    state.toggle(A, true)
    expect(state.visibility.getSnapshot().pinned).toBe(true)
  })

  it('opens and closes one Session overlay without touching the docking preference', () => {
    const state = newState()
    state.toggle(A, false)
    state.toggle(B, false)
    expect(state.visibility.getSnapshot()).toEqual({ pinned: true, overlay: B })
    state.closeOverlay(A)
    expect(state.visibility.getSnapshot().overlay).toBe(B)
    state.toggle(B, false)
    expect(state.visibility.getSnapshot().overlay).toBeNull()
    state.toggle(A, false)
    state.closeOverlay(A)
    expect(state.visibility.getSnapshot().overlay).toBeNull()
  })

  it('treats a stored value other than false as the default', () => {
    localStorage.setItem(PINNED_STORAGE_KEY, '"yes"')
    expect(newState().visibility.getSnapshot().pinned).toBe(true)
  })

  it('notifies subscribers of both members and stops after unsubscribe', () => {
    const state = newState()
    let calls = 0
    const off = state.visibility.subscribe(() => { calls += 1 })
    state.toggle(A, false)
    state.toggle(A, true)
    const seen = calls
    expect(seen).toBeGreaterThanOrEqual(2)
    off()
    state.toggle(A, true)
    expect(calls).toBe(seen)
  })

  it('closes an overlay once its gutter can dock the panel, without reopening it when the gutter narrows again', () => {
    const state = newState()
    state.toggle(A, false)
    layoutOf(A).set({ endGutter: 300, shown: true })
    expect(state.visibility.getSnapshot().overlay).toBe(A)
    layoutOf(A).set({ endGutter: DOCK_MIN_GUTTER, shown: true })
    expect(state.visibility.getSnapshot()).toEqual({ pinned: true, overlay: null })
    layoutOf(A).set({ endGutter: 200, shown: true })
    expect(presentationOf(false, state.visibility.getSnapshot(), A)).toBe('hidden')
  })

  it('closes an overlay once the main body stops showing its Session, so returning to it shows no overlay', () => {
    const state = newState()
    state.toggle(A, false)
    layoutOf(A).set({ endGutter: 0, shown: false })
    expect(state.visibility.getSnapshot().overlay).toBeNull()
    layoutOf(A).set({ endGutter: 200, shown: true })
    expect(presentationOf(false, state.visibility.getSnapshot(), A)).toBe('hidden')
  })

  it('follows only the open overlay, and nothing after dispose', () => {
    const state = newState()
    state.toggle(A, false)
    state.toggle(B, false)
    // A's layout no longer matters once B holds the overlay.
    layoutOf(A).set({ endGutter: 0, shown: false })
    expect(state.visibility.getSnapshot().overlay).toBe(B)
    state.dispose()
    layoutOf(B).set({ endGutter: 0, shown: false })
    expect(state.visibility.getSnapshot().overlay).toBe(B)
  })
})
