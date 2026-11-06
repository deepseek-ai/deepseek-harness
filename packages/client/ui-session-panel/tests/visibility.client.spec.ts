// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  DOCK_MIN_GUTTER, PINNED_STORAGE_KEY, SessionPanelState, fitsGutter, presentationOf,
} from '../src/client/visibility.ts'

const A = 'session-a' as SessionId
const B = 'session-b' as SessionId
const NARROW = 200
const WIDE = DOCK_MIN_GUTTER

/** A state whose Chat Views show `A` and `B` with narrow gutters. */
function newState(): SessionPanelState {
  const state = new SessionPanelState()
  state.measure(A, 'main', NARROW)
  state.measure(B, 'main', NARROW)
  return state
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

describe('SessionPanelState gutters', () => {
  it('keeps the widest gutter of each Session and drops a Session once its last panel unmounts', () => {
    const state = new SessionPanelState()
    const empty = state.gutters.getSnapshot()
    expect(empty.size).toBe(0)
    state.measure(A, 'main', 420)
    state.measure(A, 'embedded', 16)
    expect(state.gutters.getSnapshot().get(A)).toBe(420)
    state.measure(A, 'main', null)
    expect(state.gutters.getSnapshot().get(A)).toBe(16)
    state.measure(A, 'embedded', null)
    expect(state.gutters.getSnapshot().has(A)).toBe(false)
    // A withdrawal for a panel that never reported changes nothing.
    const before = state.gutters.getSnapshot()
    state.measure(B, 'main', null)
    expect(state.gutters.getSnapshot()).toBe(before)
  })

  it('keeps the snapshot identity until a widest gutter changes', () => {
    const state = new SessionPanelState()
    state.measure(A, 'main', 420)
    const first = state.gutters.getSnapshot()
    let calls = 0
    const off = state.gutters.subscribe(() => { calls += 1 })
    state.measure(A, 'embedded', 16)
    state.measure(A, 'main', 420)
    expect(state.gutters.getSnapshot()).toBe(first)
    expect(calls).toBe(0)
    state.measure(A, 'main', 400)
    expect(calls).toBe(1)
    off()
  })
})

describe('SessionPanelState visibility', () => {
  it('docks by default and keeps the snapshot identity until a member changes', () => {
    const state = newState()
    const first = state.visibility.getSnapshot()
    expect(first).toEqual({ pinned: true, overlay: null })
    expect(state.visibility.getSnapshot()).toBe(first)
  })

  it('flips and persists the docking preference when the gutter has room, closing any overlay', () => {
    const state = newState()
    state.toggle(A)
    expect(state.visibility.getSnapshot().overlay).toBe(A)
    state.measure(A, 'main', WIDE)
    expect(state.visibility.getSnapshot().overlay).toBeNull()
    state.toggle(A)
    expect(state.visibility.getSnapshot()).toEqual({ pinned: false, overlay: null })
    expect(localStorage.getItem(PINNED_STORAGE_KEY)).toBe('false')
    expect(new SessionPanelState().visibility.getSnapshot().pinned).toBe(false)
    state.toggle(A)
    expect(state.visibility.getSnapshot().pinned).toBe(true)
  })

  it('opens and closes one Session overlay without touching the docking preference', () => {
    const state = newState()
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
    expect(newState().visibility.getSnapshot().pinned).toBe(true)
  })

  it('notifies subscribers of both members and stops after unsubscribe', () => {
    const state = newState()
    let calls = 0
    const off = state.visibility.subscribe(() => { calls += 1 })
    state.toggle(A)
    state.measure(A, 'main', WIDE)
    state.toggle(A)
    const seen = calls
    expect(seen).toBeGreaterThanOrEqual(2)
    off()
    state.toggle(A)
    expect(calls).toBe(seen)
  })

  it('closes an overlay once its gutter can dock the panel, without reopening it when the gutter narrows again', () => {
    const state = newState()
    state.toggle(A)
    state.measure(A, 'main', 300)
    expect(state.visibility.getSnapshot().overlay).toBe(A)
    state.measure(A, 'main', WIDE)
    expect(state.visibility.getSnapshot()).toEqual({ pinned: true, overlay: null })
    state.measure(A, 'main', NARROW)
    expect(presentationOf(false, state.visibility.getSnapshot(), A)).toBe('hidden')
  })

  it('closes an overlay once no Chat View shows its Session, so returning to it shows no overlay', () => {
    const state = newState()
    state.toggle(A)
    state.measure(A, 'main', null)
    expect(state.visibility.getSnapshot().overlay).toBeNull()
    state.measure(A, 'main', NARROW)
    expect(presentationOf(false, state.visibility.getSnapshot(), A)).toBe('hidden')
  })

  it('follows only the open overlay, and nothing after dispose', () => {
    const state = newState()
    state.toggle(A)
    state.toggle(B)
    // A's Chat View no longer matters once B holds the overlay.
    state.measure(A, 'main', null)
    expect(state.visibility.getSnapshot().overlay).toBe(B)
    state.dispose()
    state.measure(B, 'main', null)
    expect(state.visibility.getSnapshot().overlay).toBe(B)
  })
})
