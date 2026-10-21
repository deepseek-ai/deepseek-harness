// @vitest-environment jsdom
/** Conversation View pins persist one root list for every Session and ignore Chat. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createViewPins } from '../src/client/view-pins.ts'

const KEY = 'dsh.slot.manual-order.conversation.view.v1'
afterEach(() => { localStorage.clear() })

describe('Conversation View pins', () => {
  it('persists unpinned View ids and restores them in a new instance', () => {
    const pins = createViewPins()
    const initial = pins.unpinned.getSnapshot()
    expect(initial).toEqual([])
    expect(pins.unpinned.getSnapshot()).toBe(initial)
    pins.setPinned('trajectory', false)
    pins.setPinned('timeline', false)
    expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toEqual({ unpinned: ['trajectory', 'timeline'] })
    expect(createViewPins().unpinned.getSnapshot()).toEqual(['trajectory', 'timeline'])
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
    localStorage.setItem(KEY, JSON.stringify({ unpinned: ['removed-view'] }))
    const pins = createViewPins()
    pins.setPinned('timeline', false)
    expect(pins.unpinned.getSnapshot()).toEqual(['removed-view', 'timeline'])
  })

  it.each([
    ['a non-array list', { unpinned: { timeline: true } }],
    ['non-string ids', { unpinned: [null] }],
    ['a missing list', { pinned: [] }],
    ['null', null],
    ['an array root', ['timeline']],
  ])('reads %s as no unpinned Views with a stable snapshot', (_name, stored) => {
    localStorage.setItem(KEY, JSON.stringify(stored))
    const pins = createViewPins()
    const snapshot = pins.unpinned.getSnapshot()
    expect(snapshot).toEqual([])
    expect(pins.unpinned.getSnapshot()).toBe(snapshot)
  })
})
