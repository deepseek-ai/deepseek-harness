// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  DOCK_MIN_GUTTER, PINNED_STORAGE_KEY, SessionPanelState, fitsLayout, presentationOf,
} from '../src/client/visibility.ts'

const A = 'session-a' as SessionId
const B = 'session-b' as SessionId

beforeEach(() => { localStorage.clear() })
afterEach(() => { localStorage.clear() })

describe('fitsLayout', () => {
  it('docks only from the minimum gutter up', () => {
    expect(fitsLayout({ endGutter: DOCK_MIN_GUTTER - 1 })).toBe(false)
    expect(fitsLayout({ endGutter: DOCK_MIN_GUTTER })).toBe(true)
    expect(fitsLayout({ endGutter: 0 })).toBe(false)
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
    const state = new SessionPanelState()
    const first = state.visibility.getSnapshot()
    expect(first).toEqual({ pinned: true, overlay: null })
    expect(state.visibility.getSnapshot()).toBe(first)
  })

  it('flips and persists the docking preference when the gutter has room, closing any overlay', () => {
    const state = new SessionPanelState()
    state.toggle(A, false)
    expect(state.visibility.getSnapshot().overlay).toBe(A)
    state.toggle(A, true)
    expect(state.visibility.getSnapshot()).toEqual({ pinned: false, overlay: null })
    expect(localStorage.getItem(PINNED_STORAGE_KEY)).toBe('false')
    expect(new SessionPanelState().visibility.getSnapshot().pinned).toBe(false)
    state.toggle(A, true)
    expect(state.visibility.getSnapshot().pinned).toBe(true)
  })

  it('opens and closes one Session overlay without touching the docking preference', () => {
    const state = new SessionPanelState()
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
    expect(new SessionPanelState().visibility.getSnapshot().pinned).toBe(true)
  })

  it('notifies subscribers of both members and stops after unsubscribe', () => {
    const state = new SessionPanelState()
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
})
