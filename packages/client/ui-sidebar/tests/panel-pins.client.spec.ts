// @vitest-environment jsdom
/** Sidebar launcher pins persist per panel id and ignore the fixed Plugins panel. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPanelPins } from '../src/client/panel-pins.ts'

const KEY = 'dsh.slot.manual-order.sidebar.panellist.v1'
afterEach(() => { localStorage.clear(); vi.restoreAllMocks() })

describe('sidebar panel pins', () => {
  it('persists unpinned panel ids and restores them in a new instance', () => {
    const pins = createPanelPins()
    const listener = vi.fn()
    pins.unpinned.subscribe(listener)
    const initial = pins.unpinned.getSnapshot()
    expect(initial).toEqual([])
    expect(pins.unpinned.getSnapshot()).toBe(initial)
    pins.setPinned('notes', false)
    pins.setPinned('tasks', false)
    expect(pins.unpinned.getSnapshot()).toEqual(['notes', 'tasks'])
    expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toEqual({ unpinned: ['notes', 'tasks'] })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(createPanelPins().unpinned.getSnapshot()).toEqual(['notes', 'tasks'])
    pins.setPinned('notes', true)
    expect(pins.unpinned.getSnapshot()).toEqual(['tasks'])
    expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toEqual({ unpinned: ['tasks'] })
  })

  it('ignores Plugins and repeated choices without republishing', () => {
    const pins = createPanelPins()
    pins.setPinned('notes', false)
    const snapshot = pins.unpinned.getSnapshot()
    const listener = vi.fn()
    pins.unpinned.subscribe(listener)
    pins.setPinned('plugins', false)
    pins.setPinned('notes', false)
    pins.setPinned('absent', true)
    expect(pins.unpinned.getSnapshot()).toBe(snapshot)
    expect(listener).not.toHaveBeenCalled()
  })

  it('keeps ids of panels that are not registered', () => {
    localStorage.setItem(KEY, JSON.stringify({ unpinned: ['removed-plugin'] }))
    const pins = createPanelPins()
    pins.setPinned('notes', false)
    expect(pins.unpinned.getSnapshot()).toEqual(['removed-plugin', 'notes'])
  })

  it.each([
    ['a non-array list', { unpinned: 'notes' }],
    ['non-string ids', { unpinned: ['notes', 1] }],
    ['a missing list', { order: ['notes'] }],
    ['null', null],
    ['a string', 'notes'],
  ])('reads %s as no unpinned panels with a stable snapshot', (_name, stored) => {
    localStorage.setItem(KEY, JSON.stringify(stored))
    const pins = createPanelPins()
    const snapshot = pins.unpinned.getSnapshot()
    expect(snapshot).toEqual([])
    expect(pins.unpinned.getSnapshot()).toBe(snapshot)
    pins.setPinned('notes', false)
    expect(pins.unpinned.getSnapshot()).toEqual(['notes'])
  })
})
