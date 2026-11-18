// @vitest-environment jsdom
/** Conversation View pins share one in-memory root list for every Session and ignore Chat. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createViewPins } from '../src/client/view-pins.ts'

const KEY = 'dsh.slot.manual-order.conversation.view.v1'
afterEach(() => { localStorage.clear() })

describe('Conversation View pins', () => {
  it('keeps unpinned View ids in memory without restoring them in a new instance', () => {
    const pins = createViewPins()
    const initial = pins.unpinned.getSnapshot()
    expect(initial).toEqual([])
    expect(pins.unpinned.getSnapshot()).toBe(initial)
    pins.setPinned('trajectory', false)
    pins.setPinned('timeline', false)
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(createViewPins().unpinned.getSnapshot()).toEqual([])
    pins.setPinned('trajectory', true)
    expect(pins.unpinned.getSnapshot()).toEqual(['timeline'])
  })

  it('ignores Chat and repeated choices without republishing', () => {
    const pins = createViewPins()
    pins.setPinned('timeline', false)
    const snapshot = pins.unpinned.getSnapshot()
    const listener = vi.fn()
    pins.unpinned.subscribe(listener)
    pins.setPinned('chat', false)
    pins.setPinned('timeline', false)
    pins.setPinned('trajectory', true)
    expect(pins.unpinned.getSnapshot()).toBe(snapshot)
    expect(listener).not.toHaveBeenCalled()
  })

  it('keeps ids of Views that are not registered', () => {
    const pins = createViewPins()
    pins.setPinned('removed-view', false)
    pins.setPinned('timeline', false)
    expect(pins.unpinned.getSnapshot()).toEqual(['removed-view', 'timeline'])
  })

  it('ignores a legacy stored list instead of restoring it', () => {
    localStorage.setItem(KEY, JSON.stringify({ unpinned: ['trajectory'] }))
    const pins = createViewPins()
    const snapshot = pins.unpinned.getSnapshot()
    expect(snapshot).toEqual([])
    expect(pins.unpinned.getSnapshot()).toBe(snapshot)
  })
})
