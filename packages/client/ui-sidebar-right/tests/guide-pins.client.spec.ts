// @vitest-environment jsdom
/** Guide card pins stay in memory per `kind:id` and ignore every Files card. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGuidePins, guideEntryId } from '../src/client/tabs/guide/guide-pins.ts'

const KEY = 'dsh.slot.manual-order.sidebar.right.tab.guide.list.v1'
afterEach(() => { localStorage.clear() })

describe('guide card pins', () => {
  it('identifies cards by kind and entry id, independent of the provider', () => {
    expect(guideEntryId({ kind: 'terminal', id: 'shell' })).toBe('terminal:shell')
  })

  it('keeps unpinned card ids in memory without restoring them in a new instance', () => {
    const pins = createGuidePins()
    const initial = pins.unpinned.getSnapshot()
    expect(initial).toEqual([])
    expect(pins.unpinned.getSnapshot()).toBe(initial)
    pins.setPinned('terminal:shell', false)
    pins.setPinned('browser:page', false)
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(createGuidePins().unpinned.getSnapshot()).toEqual([])
    pins.setPinned('terminal:shell', true)
    expect(pins.unpinned.getSnapshot()).toEqual(['browser:page'])
  })

  it('ignores Files cards and repeated choices without republishing', () => {
    const pins = createGuidePins()
    pins.setPinned('terminal:shell', false)
    const snapshot = pins.unpinned.getSnapshot()
    const listener = vi.fn()
    pins.unpinned.subscribe(listener)
    pins.setPinned('files:workspace', false)
    pins.setPinned('terminal:shell', false)
    pins.setPinned('browser:page', true)
    expect(pins.unpinned.getSnapshot()).toBe(snapshot)
    expect(listener).not.toHaveBeenCalled()
  })

  it('keeps ids of cards that are not registered', () => {
    const pins = createGuidePins()
    pins.setPinned('removed:card', false)
    pins.setPinned('terminal:shell', false)
    expect(pins.unpinned.getSnapshot()).toEqual(['removed:card', 'terminal:shell'])
  })

  it('ignores a legacy stored list instead of restoring it', () => {
    localStorage.setItem(KEY, JSON.stringify({ unpinned: ['terminal:shell'] }))
    const pins = createGuidePins()
    const snapshot = pins.unpinned.getSnapshot()
    expect(snapshot).toEqual([])
    expect(pins.unpinned.getSnapshot()).toBe(snapshot)
  })
})
