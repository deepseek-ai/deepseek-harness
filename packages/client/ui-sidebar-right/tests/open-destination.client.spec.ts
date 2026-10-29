/**
 * `openResource(address, { destination })`: an explicit host for a resource.
 *
 * Each case drives the controller over a real registry and store, because a
 * reveal, a move, and a new tab are whatever one store intent plans, and the
 * Tab domain must keep a moved tab's occurrence across that commit.
 */
import { describe, expect, it, vi } from 'vitest'
import type { PaneId, TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { dockPaneIds, findTabPane, getPane } from '@deepseek-ai/dsh-client-ui-dockkit'
import { controllerHarness, SESSION } from './controller-harness.client.ts'

const A = 'dsh-resource://file/session/s-test/a.txt'
const B = 'dsh-resource://file/session/s-test/b.txt'

function harness() {
  const { controller, instance, layout, entries, show } = controllerHarness()
  show(SESSION)
  const closed = vi.fn()
  controller.registerCloseHandler('text', closed)
  const copies = (title: string): TabId[] => Object.values(layout().tabs).filter(tab => tab.title === title).map(tab => tab.id)
  const only = (title: string): TabId => {
    const [id, ...rest] = copies(title)
    if (id === undefined || rest.length > 0) throw new Error(`expected one ${title}`)
    return id
  }
  const host = (tabId: TabId) => findTabPane(layout(), tabId).host
  const occurrence = (tabId: TabId) => controller.tabDomain.occurrence(SESSION, { id: tabId })
  const titles = () => Object.values(layout().tabs).map(tab => tab.title).sort()
  return { controller, instance, layout, entries, copies, only, host, occurrence, closed, titles }
}

describe('openResource with a destination — six transitions', () => {
  it('1. opens unopened content in the default docked pane and expands the column, without splitting or a seeded guide', () => {
    const h = harness()
    h.controller.openResource(A, { destination: 'sidebar', params: { line: 3 } })
    const a = h.only('a.txt')
    expect(h.host(a)).toBe('dock')
    expect(h.layout().expanded).toBe(true)
    expect(dockPaneIds(h.layout())).toHaveLength(1)
    expect(h.titles()).toEqual(['a.txt'])
    expect(h.occurrence(a).navigation.getSnapshot()).toEqual({ address: A, params: { line: 3 }, revision: 1 })
    expect(h.entries()).toBe(1)
  })

  it('2. opens unopened content in a new floating panel on a surface not yet created, leaving the column collapsed and unseeded', () => {
    const h = harness()
    expect(h.instance.getSnapshot().bySession[SESSION]).toBeUndefined()
    h.controller.openResource(A, { destination: 'float', params: { line: 7 } })
    const a = h.only('a.txt')
    expect(h.host(a)).toBe('float')
    expect(h.layout().floats).toHaveLength(1)
    expect(h.layout().expanded).toBe(false)
    expect(h.titles()).toEqual(['a.txt'])
    expect(getPane(h.layout(), h.layout().rootId).tabs).toEqual([])
    expect(h.layout().activePaneId).toBe(findTabPane(h.layout(), a).id)
    expect(h.occurrence(a).navigation.getSnapshot()).toEqual({ address: A, params: { line: 7 }, revision: 1 })
    expect(h.entries()).toBe(1)
  })

  it('2. opens a new floating panel beside other floating panels and keeps the docked selection and expansion', () => {
    const h = harness()
    h.controller.openResource(B, { destination: 'sidebar' })
    h.controller.openResource('dsh-resource://file/session/s-test/c.txt', { destination: 'float' })
    const root = getPane(h.layout(), h.layout().rootId)
    h.controller.openResource(A, { destination: 'float' })
    const floats = h.layout().floats
    expect(floats).toHaveLength(2)
    const [first, second] = floats.map(id => getPane(h.layout(), id))
    expect(second!.tabs).toEqual([h.only('a.txt')])
    expect(second!.rect).not.toEqual(first!.rect)
    expect(getPane(h.layout(), h.layout().rootId)).toEqual(root)
    expect(h.layout().expanded).toBe(true)
  })

  it('3. reveals a docked copy where it is and flashes its pane once it is on screen', () => {
    const h = harness()
    h.controller.openResource(A, { destination: 'sidebar' })
    h.controller.openResource(B, { destination: 'sidebar' })
    const a = h.only('a.txt')
    const held = h.occurrence(a)
    h.controller.openResource(A, { destination: 'sidebar', params: { line: 9 } })
    expect(h.only('a.txt')).toBe(a)
    expect(getPane(h.layout(), h.layout().activePaneId).activeTabId).toBe(a)
    expect(h.occurrence(a)).toBe(held)
    expect(held.navigation.getSnapshot()).toEqual({ address: A, params: { line: 9 }, revision: 2 })
    // Switching to the tab is the visible change; only a reveal of the tab already on screen flashes.
    expect(h.controller.flashOf(SESSION).getSnapshot()).toBeUndefined()
    h.controller.openResource(A, { destination: 'sidebar' })
    expect(h.controller.flashOf(SESSION).getSnapshot()).toEqual({ paneId: findTabPane(h.layout(), a).id, serial: 1 })
  })

  it('4. moves a docked tab into a new floating panel, keeping its id, occurrence and the expansion, as one entry', () => {
    const h = harness()
    h.controller.openResource(B, { destination: 'sidebar' })
    h.controller.openResource(A, { destination: 'sidebar' })
    const a = h.only('a.txt')
    const held = h.occurrence(a)
    const before = h.entries()
    h.controller.openResource(A, { destination: 'float', params: { line: 4 } })
    expect(h.only('a.txt')).toBe(a)
    expect(h.host(a)).toBe('float')
    expect(h.layout().floats).toHaveLength(1)
    expect(h.layout().expanded).toBe(true)
    expect(h.occurrence(a)).toBe(held)
    expect(held.signal.aborted).toBe(false)
    expect(held.navigation.getSnapshot()).toEqual({ address: A, params: { line: 4 }, revision: 2 })
    expect(h.closed).not.toHaveBeenCalled()
    expect(h.controller.flashOf(SESSION).getSnapshot()).toBeUndefined()
    expect(h.entries()).toBe(before + 1)
    h.controller._undo()
    expect(h.host(a)).toBe('dock')
    expect(h.layout().floats).toEqual([])
    expect(h.occurrence(a)).toBe(held)
  })

  it('4. moves the last docked tab out under the empty-pane rule, without ending its occurrence', () => {
    const h = harness()
    h.controller.openResource(A, { destination: 'sidebar' })
    const a = h.only('a.txt')
    const held = h.occurrence(a)
    h.controller.openResource(A, { destination: 'float' })
    expect(h.host(a)).toBe('float')
    expect(h.occurrence(a)).toBe(held)
    expect(held.signal.aborted).toBe(false)
    // An expanded column never stands empty: its root pane reseeds the default page in the same entry.
    expect(h.titles()).toEqual(['a.txt', 'seed'])
    expect(h.entries()).toBe(2)
  })

  it('5. reveals a floating copy, raising its panel, without another panel or expanding the column', () => {
    const h = harness()
    h.controller.openResource(A, { destination: 'float' })
    h.controller.openResource(B, { destination: 'float' })
    const a = h.only('a.txt')
    const pane = findTabPane(h.layout(), a).id
    h.controller.openResource(A, { destination: 'float', params: { line: 2 } })
    expect(h.layout().floats).toEqual([findTabPane(h.layout(), h.only('b.txt')).id, pane])
    expect(h.layout().activePaneId).toBe(pane)
    expect(h.layout().expanded).toBe(false)
    expect(h.occurrence(a).navigation.getSnapshot()).toMatchObject({ params: { line: 2 }, revision: 2 })
    expect(h.controller.flashOf(SESSION).getSnapshot()).toEqual({ paneId: pane, serial: 1 })
  })

  it('6. moves a floating tab into the default docked pane and expands the column, keeping its occurrence, as one entry', () => {
    const h = harness()
    h.controller.openResource(A, { destination: 'float' })
    const a = h.only('a.txt')
    const held = h.occurrence(a)
    const before = h.entries()
    h.controller.openResource(A, { destination: 'sidebar', params: { line: 5 } })
    expect(h.only('a.txt')).toBe(a)
    expect(h.host(a)).toBe('dock')
    expect(h.layout().floats).toEqual([])
    expect(h.layout().expanded).toBe(true)
    // The collapsed empty root takes the tab; nothing else is seeded beside it.
    expect(h.titles()).toEqual(['a.txt'])
    expect(h.occurrence(a)).toBe(held)
    expect(held.navigation.getSnapshot()).toEqual({ address: A, params: { line: 5 }, revision: 2 })
    expect(h.closed).not.toHaveBeenCalled()
    expect(h.entries()).toBe(before + 1)
    h.controller._undo()
    expect(h.host(a)).toBe('float')
    expect(h.layout().expanded).toBe(false)
  })
})

describe('openResource with a destination — copies and precedence', () => {
  it('prefers the copy already in the requested host and leaves the other copies open', () => {
    const h = harness()
    h.controller.openResource(A, { destination: 'sidebar' })
    h.controller.openResource(A, { revealIfOpened: false })
    const docked = h.copies('a.txt')
    h.instance.actions.floatTab(SESSION, docked[1]!)
    h.controller.openResource(A, { destination: 'float' })
    expect(h.copies('a.txt')).toEqual(docked)
    expect(h.layout().floats).toHaveLength(1)
    expect(h.layout().activePaneId).toBe(findTabPane(h.layout(), docked[1]!).id)
    h.controller.openResource(A, { destination: 'sidebar' })
    expect(h.host(docked[0]!)).toBe('dock')
    expect(h.host(docked[1]!)).toBe('float')
    expect(getPane(h.layout(), h.layout().activePaneId).activeTabId).toBe(docked[0])
  })

  it('moves one copy from the other host when the requested one holds none', () => {
    const h = harness()
    h.controller.openResource(A, { destination: 'float' })
    h.controller.openResource(A, { destination: 'float', revealIfOpened: false })
    expect(h.layout().floats).toHaveLength(1)
    h.controller.openResource(A, { revealIfOpened: false })
    const [floating, docked] = h.copies('a.txt')
    h.instance.actions.floatTab(SESSION, docked!)
    h.controller.openResource(A, { destination: 'sidebar' })
    expect([h.host(floating!), h.host(docked!)].sort()).toEqual(['dock', 'float'])
    expect(h.copies('a.txt')).toHaveLength(2)
  })

  it('ignores a floating paneId, replaceTab, and preferNewPane, and runs no close handler', () => {
    const h = harness()
    h.controller.openResource(B, { destination: 'float' })
    const b = h.only('b.txt')
    const floating: PaneId = findTabPane(h.layout(), b).id
    h.controller.openResource(A, { destination: 'sidebar', paneId: floating, replaceTab: b, preferNewPane: true })
    expect(h.host(h.only('a.txt'))).toBe('dock')
    expect(h.only('b.txt')).toBe(b)
    expect(dockPaneIds(h.layout())).toHaveLength(1)
    expect(h.closed).not.toHaveBeenCalled()
  })

  it('reaches a Session through openResourceIn', () => {
    const h = harness()
    h.controller.openResourceIn(SESSION, A, { destination: 'float' })
    expect(h.host(h.only('a.txt'))).toBe('float')
  })

  it('keeps the traditional placement when destination is omitted: a floating paneId still fails as before', () => {
    const h = harness()
    h.controller.openResource(B, { destination: 'float' })
    const floating = findTabPane(h.layout(), h.only('b.txt')).id
    expect(() => { h.controller.openResource(A, { paneId: floating }) }).toThrow('openTab requires a docked pane')
  })
})
