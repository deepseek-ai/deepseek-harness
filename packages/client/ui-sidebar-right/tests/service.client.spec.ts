/**
 * What `ctx.sidebarRight` promises other plugins.
 *
 * The service is root-scoped and the surface is per session, so every command
 * depends on a binding the mounted seat publishes; the interesting cases are all
 * about that seam. Opening is asserted against a real store instance, because
 * "already open" and "in that tab's place" mean whatever the planner means by
 * them and nothing else, and against the Tab domain, because an open is not
 * complete until the tab knows how it was navigated to.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { LayoutState, PaneId, TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { dockPaneIds, findTabPane, getPane } from '@deepseek-ai/dsh-client-ui-dockkit'
import { createSidebarRightController } from '../src/client/service.ts'
import { SidebarRightTabRegistry } from '../src/client/tab-registry.ts'
import { createSidebarRightStore } from '../src/client/stores.ts'
import { guideDefinition } from '../src/client/tabs/guide/definition.ts'

// The params map is empty in this package; a test-only scheme lets specs hand
// parameters through the typed `open`/`navigate` faces.
declare module '../src/client/contract/params.ts' {
  interface SidebarRightResourceParamsMap {
    test: { line?: number; x?: number }
  }
}

const SESSION = 's-test' as SessionId

/** Key-echoing translate: this file asserts behaviour, not copy. */
const t = ((key: string) => key) as Parameters<typeof guideDefinition>[0]

/** A controller over a real registry and a real store, bound as a mounted seat would be. */
function harness() {
  const ctx = new Context()
  const tabs = new SidebarRightTabRegistry(ctx)
  tabs.register(guideDefinition(t))
  // A type claiming `file:` addresses, standing in for whatever package owns
  // them: this service's contract is that SOME registered type claims, not that
  // a particular one does.
  tabs.register({
    id: 'test/text',
    kind: 'text',
    patterns: ['dsh-resource://file/**'],
    priority: 'fallback',
    title: address => address.slice(address.lastIndexOf('/') + 1),
  })
  const pin = vi.fn<(address: string, signal: AbortSignal) => void>()
  const { controller, adopt } = createSidebarRightController(tabs, pin)
  const instance = createSidebarRightStore(() => ({ kind: 'guide', title: 'seed' })).create()
  const layout = (): LayoutState => {
    const surface = instance.getSnapshot().bySession[SESSION]
    if (surface === undefined) throw new Error('expected a surface')
    return surface.layout
  }
  /** Republish the way the seat does after each commit, and sync the domain the way it does too. */
  /** The room rule's verdict the seat would report; a spec flips it to model a narrow pane. */
  const room = { allowed: true }
  const publish = (): (() => void) => {
    const surface = instance.getSnapshot().bySession[SESSION]
    if (surface !== undefined) controller.tabDomain.sync(SESSION, surface.layout)
    return controller.bind({
      sessionId: SESSION, actions: instance.actions, surfaces: instance.getSnapshot().bySession,
      closeWithFocus: (_paneId, close) => { close() },
      openWithFocus: (open) => { open() },
      canSplitPane: () => room.allowed,
    })
  }
  const titles = (): string[] => {
    const surface = instance.getSnapshot().bySession[SESSION]
    return surface === undefined ? [] : Object.values(surface.layout.tabs).map(tab => tab.title)
  }
  const tabOf = (title: string): TabId => {
    const found = Object.values(layout().tabs).find(tab => tab.title === title)
    if (found === undefined) throw new Error(`expected a tab titled ${title}`)
    return found.id
  }
  const entries = (): number => instance.getSnapshot().bySession[SESSION]?.history.entries.length ?? 0
  // A surface starts empty; expanding seeds the default guide ('seed').
  const expand = (): void => { instance.actions.setExpanded(SESSION, true) }
  return { controller, adopt, tabs, instance, pin, publish, titles, tabOf, layout, entries, room, expand }
}

describe('SidebarRightController — opening', () => {
  it('keeps independently opened instances distinct when they return to the same pane', () => {
    const h = harness()
    h.tabs.register({ id: 'test/terminal', kind: 'terminal', multiple: true, title: () => 'terminal' })
    const release = h.publish()
    try {
      h.controller.openTab('terminal')
      h.controller.openTab('terminal')
      const terminals = Object.values(h.layout().tabs).filter(tab => tab.kind === 'terminal')
      expect(terminals).toHaveLength(2)
      expect(terminals[0]!.contentId).not.toBe(terminals[1]!.contentId)
      const pane = findTabPane(h.layout(), terminals[0]!.id).id
      h.instance.actions.floatTab(SESSION, terminals[0]!.id)
      const floating = findTabPane(h.layout(), terminals[0]!.id).id
      h.instance.actions.unfloatPane(SESSION, floating)
      expect(getPane(h.layout(), pane).tabs).toContain(terminals[0]!.id)
      expect(getPane(h.layout(), pane).tabs).toContain(terminals[1]!.id)
    } finally { release() }
  })

  it('refuses every write while no seat is mounted', () => {
    const { controller } = harness()
    expect(() => { controller.openResource('dsh-resource://file/session/s-test/a.txt') }).toThrow('no session surface is mounted')
    expect(() => { controller.openTab('guide') }).toThrow('no session surface is mounted')
    expect(() => { controller.close('tab1' as TabId) }).toThrow('no session surface is mounted')
    expect(() => { controller.toggleExpanded() }).toThrow('no session surface is mounted')
    expect(() => { controller.focus('tab1' as TabId) }).toThrow('no session surface is mounted')
    expect(() => { controller.split() }).toThrow('no session surface is mounted')
    expect(() => { controller.float('tab1' as TabId) }).toThrow('no session surface is mounted')
    expect(() => { controller.dock('pane1' as PaneId) }).toThrow('no session surface is mounted')
  })

  it('publishes the mounted session only on real transitions of the seat binding', () => {
    const h = harness()
    const seen: (string | undefined)[] = []
    const unsubscribe = h.controller.mounted.subscribe(() => { seen.push(h.controller.mounted.getSnapshot()) })
    try {
      expect(h.controller.mounted.getSnapshot()).toBeUndefined()
      const first = h.publish()
      expect(h.controller.mounted.getSnapshot()).toBe(SESSION)
      // The seat republishes on every store commit; the same session is silent.
      const second = h.publish()
      expect(seen).toEqual([SESSION])
      // A stale release — the first seat's, after a newer one took over — changes nothing.
      first()
      expect(h.controller.mounted.getSnapshot()).toBe(SESSION)
      second()
      expect(h.controller.mounted.getSnapshot()).toBeUndefined()
      expect(seen).toEqual([SESSION, undefined])
    } finally { unsubscribe() }
  })

  it('refuses an address no registered type claims, before touching the surface', () => {
    const { controller, publish, titles } = harness()
    publish()
    expect(() => { controller.openResource('https://example.com') }).toThrow('no registered tab type claims')
    expect(titles()).toEqual([])
  })

  it('opens claimed content and reveals the column in one history entry', () => {
    const { controller, publish, layout, titles, entries } = harness()
    publish()
    controller.openResource('dsh-resource://file/session/s-test/notes/readme.txt')
    expect(layout().expanded).toBe(true)
    expect(titles()).toContain('readme.txt')
    // One intent, one entry: stepping back removes the tab and re-collapses.
    expect(entries()).toBe(1)
    publish()
    controller._undo()
    expect(layout().expanded).toBe(false)
    expect(titles()).not.toContain('readme.txt')
  })

  it('focuses the tab already showing the same (kind, contentId) instead of opening a second one', () => {
    const { controller, publish, titles, layout, tabOf } = harness()
    publish()
    controller.openResource('dsh-resource://file/session/s-test/notes/readme.txt')
    publish()
    controller.openTab('guide')
    publish()
    controller.openResource('dsh-resource://file/session/s-test/notes/readme.txt')
    expect(titles().filter(title => title === 'readme.txt')).toHaveLength(1)
    expect(getPane(layout(), layout().activePaneId).activeTabId).toBe(tabOf('readme.txt'))
  })

  it('opens another tab for the same address when told not to reveal, and when another kind is named', () => {
    const { controller, tabs, publish, titles } = harness()
    tabs.register({ id: 'test/hex', kind: 'hex', patterns: [], title: () => 'hex view' })
    publish()
    controller.openResource('dsh-resource://file/session/s-test/notes/readme.txt')
    publish()
    controller.openResource('dsh-resource://file/session/s-test/notes/readme.txt', { revealIfOpened: false })
    publish()
    controller.openResource('dsh-resource://file/session/s-test/notes/readme.txt', { kind: 'hex' })
    expect(titles().filter(title => title === 'readme.txt')).toHaveLength(2)
    expect(titles()).toContain('hex view')
  })

  it('lands a new tab in the pane the caller names', () => {
    const { controller, instance, publish, layout, tabOf, expand } = harness()
    expand()
    publish()
    instance.actions.splitPane(SESSION)
    publish()
    const [left, right] = Object.values(layout().nodes).filter(node => node.kind === 'pane').map(node => node.id)
    if (left === undefined || right === undefined) throw new Error('expected two panes')
    controller.openResource('dsh-resource://file/session/s-test/a.txt', { paneId: left })
    expect(findTabPane(layout(), tabOf('a.txt')).id).toBe(left)
  })

  it('opens new content alone in a preferred pane and falls back to the current pane at the limit', () => {
    const { controller, publish, layout, tabOf, entries, expand } = harness()
    expand()
    publish()
    const before = entries()
    controller.openResource('dsh-resource://file/session/s-test/a.txt', { preferNewPane: true })
    const a = tabOf('a.txt')
    const pane = findTabPane(layout(), a)
    expect(dockPaneIds(layout())).toHaveLength(2)
    expect(pane.tabs).toEqual([a])
    expect(entries()).toBe(before + 1)

    publish()
    controller.openResource('dsh-resource://file/session/s-test/b.txt', { preferNewPane: true })
    expect(dockPaneIds(layout())).toHaveLength(2)
    expect(findTabPane(layout(), tabOf('b.txt')).id).toBe(pane.id)
  })

  it('falls back when the pane is too narrow and reveals existing content without splitting', () => {
    const { controller, publish, layout, tabOf, room, expand } = harness()
    expand()
    publish()
    room.allowed = false
    controller.openResource('dsh-resource://file/session/s-test/a.txt', { preferNewPane: true })
    expect(dockPaneIds(layout())).toHaveLength(1)
    publish()

    room.allowed = true
    controller.openResource('dsh-resource://file/session/s-test/a.txt', { preferNewPane: true })
    expect(dockPaneIds(layout())).toHaveLength(1)
    expect(getPane(layout(), layout().activePaneId).activeTabId).toBe(tabOf('a.txt'))
  })

  it('takes the replaced tab\'s pane and slot, closes it, and records one entry', () => {
    const { controller, publish, layout, tabOf, entries } = harness()
    publish()
    controller.openResource('dsh-resource://file/session/s-test/a.txt')
    publish()
    controller.openResource('dsh-resource://file/session/s-test/b.txt')
    publish()
    const a = tabOf('a.txt')
    const before = entries()
    controller.openResource('dsh-resource://file/session/s-test/c.txt', { replaceTab: a })
    const pane = findTabPane(layout(), tabOf('c.txt'))
    // a took slot 0 of the lazily-seeded (still empty) surface; c took a's slot.
    expect(pane.tabs.indexOf(tabOf('c.txt'))).toBe(0)
    expect(layout().tabs[a]).toBeUndefined()
    expect(entries()).toBe(before + 1)
    publish()
    controller._undo()
    expect(layout().tabs[a]).toBeDefined()
    expect(Object.values(layout().tabs).map(tab => tab.title)).not.toContain('c.txt')
  })

  it('still closes the replaced tab when the address is already open elsewhere', () => {
    const { controller, publish, layout, tabOf, titles } = harness()
    publish()
    controller.openResource('dsh-resource://file/session/s-test/a.txt')
    publish()
    controller.openResource('dsh-resource://file/session/s-test/b.txt')
    publish()
    const spare = tabOf('b.txt')
    controller.openResource('dsh-resource://file/session/s-test/a.txt', { replaceTab: spare })
    expect(layout().tabs[spare]).toBeUndefined()
    expect(titles().filter(title => title === 'a.txt')).toHaveLength(1)
    expect(getPane(layout(), layout().activePaneId).activeTabId).toBe(tabOf('a.txt'))
  })

  it('refuses to copy the guide, and records nothing for the attempt', () => {
    const { controller, instance, publish, layout, tabOf, entries, expand } = harness()
    instance.actions.open(SESSION)
    expand()
    publish()
    controller.openResource('dsh-resource://file/session/s-test/a.txt')
    publish()
    const before = entries()
    instance.actions.duplicateTab(SESSION, tabOf('seed'))
    expect(Object.values(layout().tabs).filter(tab => tab.contentId === 'sidebar://guide')).toHaveLength(1)
    expect(entries()).toBe(before)
    // Any other tab still copies beside itself.
    instance.actions.duplicateTab(SESSION, tabOf('a.txt'))
    expect(Object.values(layout().tabs).filter(tab => tab.title === 'a.txt')).toHaveLength(2)
  })

  it('focuses the existing guide in the target pane', () => {
    const { controller, instance, publish, layout, tabOf, expand } = harness()
    instance.actions.open(SESSION)
    expand()
    publish()
    controller.openResource('dsh-resource://file/session/s-test/a.txt')
    publish()
    controller.openTab('guide')
    expect(Object.values(layout().tabs).filter(tab => tab.contentId === 'sidebar://guide')).toHaveLength(1)
    expect(getPane(layout(), layout().activePaneId).activeTabId).toBe(tabOf('seed'))
  })

  it('keeps the guide to one per pane: opening it into a pane that holds one settles on that one', () => {
    const { controller, instance, publish, layout, tabOf, expand } = harness()
    instance.actions.open(SESSION)
    expand()
    publish()
    controller.openResource('dsh-resource://file/session/s-test/a.txt')
    publish()
    const root = getPane(layout(), layout().rootId).id
    let settled: TabId | undefined
    instance.actions.openContent(SESSION, {
      kind: 'guide', contentId: 'sidebar://guide', title: 'seed', paneId: root, revealIfOpened: false,
    }, (tabId) => { settled = tabId })
    expect(settled).toBe(tabOf('seed'))
    expect(Object.values(layout().tabs).filter(tab => tab.contentId === 'sidebar://guide')).toHaveLength(1)
    // A pane without one gets its own.
    instance.actions.closeTab(SESSION, tabOf('seed'))
    instance.actions.openContent(SESSION, {
      kind: 'guide', contentId: 'sidebar://guide', title: 'seed', paneId: root, revealIfOpened: false,
    }, () => {})
    expect(Object.values(layout().tabs).filter(tab => tab.contentId === 'sidebar://guide')).toHaveLength(1)
  })

  it('merges a guide placed, dropped, or docked into a pane that already holds one', () => {
    const { instance, publish, layout, expand } = harness()
    instance.actions.open(SESSION)
    expand()
    publish()
    const guides = (): TabId[] => Object.values(layout().tabs).filter(tab => tab.contentId === 'sidebar://guide').map(tab => tab.id)
    // Place: the split's guide dragged into the first pane's strip.
    instance.actions.splitPane(SESSION)
    let [left, right] = dockPaneIds(layout())
    if (left === undefined || right === undefined) throw new Error('expected two panes')
    const [own] = getPane(layout(), left).tabs
    const arrivingByPlace = getPane(layout(), right).tabs[0]
    if (own === undefined || arrivingByPlace === undefined) throw new Error('expected seeded guides')
    instance.actions.placeTab(SESSION, arrivingByPlace, left, 0)
    expect(guides()).toEqual([own])
    expect(dockPaneIds(layout())).toHaveLength(1)
    expect(getPane(layout(), left).activeTabId).toBe(own)
    // Drop on the centre: the same merge. An edge drop makes a new pane and keeps both.
    instance.actions.splitPane(SESSION)
    ;[left, right] = dockPaneIds(layout())
    if (left === undefined || right === undefined) throw new Error('expected two panes')
    const arrivingByDrop = getPane(layout(), right).tabs[0]
    if (arrivingByDrop === undefined) throw new Error('expected the seeded guide')
    instance.actions.dropTab(SESSION, arrivingByDrop, left, 'right')
    expect(guides()).toHaveLength(2)
    instance.actions.dropTab(SESSION, arrivingByDrop, left, 'center')
    expect(guides()).toEqual([own])
    // Dock: a floating guide returning to a pane that reseeded its own.
    instance.actions.floatTab(SESSION, own)
    expect(layout().floats).toHaveLength(1)
    const reseeded = guides().find(id => id !== own)
    if (reseeded === undefined) throw new Error('expected the root to reseed a guide')
    const [float] = layout().floats
    if (float === undefined) throw new Error('expected the float')
    instance.actions.unfloatPane(SESSION, float)
    expect(layout().floats).toHaveLength(0)
    expect(guides()).toEqual([reseeded])
  })

  it('records the navigation in the Tab domain: params delivered, revision counting every open', () => {
    const { controller, publish, tabOf } = harness()
    publish()
    controller.openResource('dsh-resource://file/session/s-test/a.txt', { params: { line: 3 } })
    const occurrence = controller.tabDomain.occurrence(SESSION, { id: tabOf('a.txt') })
    expect(occurrence.navigation.getSnapshot()).toEqual({ address: 'dsh-resource://file/session/s-test/a.txt', params: { line: 3 }, revision: 1 })
    publish()
    controller.openResource('dsh-resource://file/session/s-test/a.txt')
    expect(occurrence.navigation.getSnapshot()).toEqual({ address: 'dsh-resource://file/session/s-test/a.txt', params: undefined, revision: 2 })
  })

  it('closes a tab of the mounted session', () => {
    const { controller, publish, tabOf, titles } = harness()
    publish()
    controller.openResource('dsh-resource://file/session/s-test/a.txt')
    publish()
    controller.close(tabOf('a.txt'))
    expect(titles()).not.toContain('a.txt')
  })

  it('records the presentation switch, so it steps back with everything else', () => {
    const { controller, instance, publish, layout } = harness()
    publish()
    instance.actions.setMode(SESSION, 'fullscreen')
    expect(layout().mode).toBe('fullscreen')
    publish()
    controller._undo()
    expect(layout().mode).toBe('push')
    controller._redo()
    expect(layout().mode).toBe('fullscreen')
  })
})

describe('SidebarRightController — the two opens', () => {
  it('refuses an address outside dsh-resource:// on the same path as an unclaimed one', () => {
    const { controller, instance, publish, entries } = harness()
    instance.actions.open(SESSION)
    publish()
    const before = entries()
    expect(() => { controller.openResource('sidebar://guide') }).toThrow('no registered tab type claims')
    expect(() => { controller.openResource('https://example.com/a.txt') }).toThrow('no registered tab type claims')
    expect(() => { controller.openResource('dsh-resource://unknown/x') }).toThrow('no registered tab type claims')
    expect(entries()).toBe(before)
  })

  it('opens a page by kind at the address the package records it under, and refuses an unregistered kind', () => {
    const { controller, instance, publish, layout, entries } = harness()
    instance.actions.open(SESSION)
    publish()
    controller.openResource('dsh-resource://file/session/s-test/a.txt')
    publish()
    // No pane holds the page yet: opening it by kind opens its tab.
    controller.openTab('guide')
    publish()
    expect(Object.values(layout().tabs).filter(tab => tab.contentId === 'sidebar://guide')).toHaveLength(1)
    expect(controller.active()?.kind).toBe('guide')
    const before = entries()
    expect(() => { controller.openTab('nope') }).toThrow('no tab type is registered as "nope"')
    expect(entries()).toBe(before)
  })

  it('replaceTab opens in the named tab\'s place and closes it, as one entry', () => {
    const { controller, instance, publish, layout, tabOf, entries, expand } = harness()
    instance.actions.open(SESSION)
    expand()
    publish()
    controller.openResource('dsh-resource://file/session/s-test/a.txt')
    publish()
    const before = entries()
    controller.openTab('guide', { replaceTab: tabOf('a.txt') })
    expect(Object.values(layout().tabs).map(tab => tab.title)).toEqual(['seed'])
    expect(entries()).toBe(before + 1)
  })
})

describe('SidebarRightController — layout operations', () => {
  it('focuses an existing tab and its pane, and leaves a missing tab alone', () => {
    const { controller, publish, layout, tabOf, entries, expand } = harness()
    expand()
    publish()
    controller.openResource('dsh-resource://file/session/s-test/a.txt')
    publish()
    expect(getPane(layout(), layout().activePaneId).activeTabId).toBe(tabOf('a.txt'))
    const before = entries()
    controller.focus(tabOf('seed'))
    expect(getPane(layout(), layout().activePaneId).activeTabId).toBe(tabOf('seed'))
    expect(entries()).toBe(before + 1)
    controller.focus('tab-nowhere' as TabId)
    expect(entries()).toBe(before + 1)
  })

  it('splits nothing before the seat has materialized the surface', () => {
    const { controller, publish } = harness()
    publish()
    expect(controller.split()).toBeUndefined()
  })

  it('splits the active docked pane and names the new one, or nothing when the budget or the room rule says no', () => {
    const { controller, instance, publish, layout, entries, room, expand } = harness()
    instance.actions.open(SESSION)
    expand()
    publish()
    const created = controller.split()
    expect(created).toBeDefined()
    expect(dockPaneIds(layout())).toHaveLength(2)
    expect(dockPaneIds(layout())).toContain(created)
    publish()
    // The room rule blocks: nothing is split and nothing is recorded.
    room.allowed = false
    const before = entries()
    expect(controller.split()).toBeUndefined()
    expect(entries()).toBe(before)
    room.allowed = true
    // A floating pane cannot be split.
    const seed = Object.values(layout().tabs).find(tab => tab.title === 'seed')
    if (seed === undefined) throw new Error('expected the seeded guide')
    controller.float(seed.id)
    publish()
    const [float] = layout().floats
    expect(controller.split(float)).toBeUndefined()
    // The budget: split to two panes, then no more.
    while (dockPaneIds(layout()).length < 2) {
      expect(controller.split(dockPaneIds(layout()).at(-1))).toBeDefined()
      publish()
    }
    expect(controller.split()).toBeUndefined()
  })

  it('floats a docked tab, and leaves a floating or missing tab alone', () => {
    const { controller, publish, layout, tabOf, entries } = harness()
    publish()
    controller.openResource('dsh-resource://file/session/s-test/a.txt')
    publish()
    controller.float(tabOf('a.txt'), { x: 10, y: 20, width: 300, height: 200 })
    expect(layout().floats).toHaveLength(1)
    expect(findTabPane(layout(), tabOf('a.txt')).rect).toEqual({ x: 10, y: 20, width: 300, height: 200 })
    publish()
    const before = entries()
    controller.float(tabOf('a.txt'))
    controller.float('tab-nowhere' as TabId)
    expect(entries()).toBe(before)
    expect(layout().floats).toHaveLength(1)
  })

  it('docks a floating panel back into the active docked pane, and leaves a docked or missing pane alone', () => {
    const { controller, publish, layout, tabOf, entries } = harness()
    publish()
    controller.openResource('dsh-resource://file/session/s-test/a.txt')
    publish()
    controller.float(tabOf('a.txt'))
    publish()
    const [float] = layout().floats
    if (float === undefined) throw new Error('expected a float')
    controller.dock(float)
    expect(layout().floats).toHaveLength(0)
    expect(findTabPane(layout(), tabOf('a.txt')).host).toBe('dock')
    publish()
    const before = entries()
    controller.dock(getPane(layout(), layout().rootId).id)
    controller.dock('pane-nowhere' as PaneId)
    expect(entries()).toBe(before)
  })
})

describe('SidebarRightController — a tab\'s own actions', () => {
  const OTHER = 's-other' as SessionId
  const A_TXT = 'dsh-resource://file/session/s-test/a.txt'
  const B_TXT = 'dsh-resource://file/session/s-test/b.txt'

  it('opens into an adopted store before that store has created its session surface', () => {
    const { controller, adopt, instance, titles } = harness()
    const releaseOwn = adopt(SESSION, instance)
    const other = createSidebarRightStore(() => ({ kind: 'guide', title: 'seed' })).create(OTHER)
    const releaseBinding = controller.bind({
      sessionId: OTHER,
      actions: other.actions,
      surfaces: other.getSnapshot().bySession,
      closeWithFocus: (_paneId, close) => { close() },
      openWithFocus: (open) => { open() }, canSplitPane: () => true,
    })
    controller.openResourceIn(SESSION, A_TXT)
    expect(titles()).toContain('a.txt')
    releaseBinding()
    releaseOwn()
  })

  it('land in the session the tab is in through its own adopted store, after another session\'s seat took over', () => {
    const { controller, adopt, instance, publish, layout, expand } = harness()
    const releaseOwn = adopt(SESSION, instance)
    expand()
    publish()
    controller.openResource(A_TXT)
    const own = Object.values(layout().tabs).find(tab => tab.title === 'a.txt')
    const guide = Object.values(layout().tabs).find(tab => tab.kind === 'guide')
    if (own === undefined || guide === undefined) throw new Error('expected the opened tab and the seeded guide')
    const fromOwn = controller.tabDomain.occurrence(SESSION, own).tabActions
    const guideOccurrence = controller.tabDomain.occurrence(SESSION, guide)
    // The user switches sessions: the other seat binds with the other session's
    // own instance, whose store knows nothing of this session.
    const other = createSidebarRightStore(() => ({ kind: 'guide', title: 'seed' })).create(OTHER)
    const releaseOther = adopt(OTHER, other)
    other.actions.open(OTHER)
    other.actions.setExpanded(OTHER, true)
    const otherSurface = other.getSnapshot().bySession[OTHER]
    if (otherSurface === undefined) throw new Error('expected the other surface')
    controller.bind({
      sessionId: OTHER, actions: other.actions, surfaces: other.getSnapshot().bySession,
      closeWithFocus: (_paneId, close) => { close() },
      openWithFocus: (open) => { open() },
      canSplitPane: () => true,
    })
    fromOwn.openResource(B_TXT)
    fromOwn.openTab('guide', { revealIfOpened: false })
    expect(Object.values(layout().tabs).map(tab => tab.title)).toContain('b.txt')
    expect(other.getSnapshot().bySession[OTHER]).toBe(otherSurface)
    // Tab ids repeat across sessions: the seeded guides share one. Closing this
    // session's closes this session's, aborts its occurrence at once although
    // no seat draws the session, and the other keeps its own.
    expect(otherSurface.layout.tabs[guide.id]).toBeDefined()
    guideOccurrence.tabActions.close()
    expect(layout().tabs[guide.id]).toBeUndefined()
    expect(guideOccurrence.signal.aborted).toBe(true)
    expect(other.getSnapshot().bySession[OTHER]).toBe(otherSurface)
    expect(controller.active()?.kind).toBe('guide')
    releaseOther()
    releaseOwn()
  })

  it('do nothing for a session whose store is not adopted, and again once its adoption is released', () => {
    const { controller, adopt, instance, publish, layout, titles } = harness()
    publish()
    controller.openResource(A_TXT)
    publish()
    const own = Object.values(layout().tabs).find(tab => tab.title === 'a.txt')
    if (own === undefined) throw new Error('expected the opened tab')
    const { tabActions } = controller.tabDomain.occurrence(SESSION, own)
    const before = instance.getSnapshot().bySession
    tabActions.openResource(B_TXT)
    tabActions.openTab('guide')
    tabActions.close()
    expect(instance.getSnapshot().bySession).toBe(before)
    // Adopted, they land; released, they stop again.
    const release = adopt(SESSION, instance)
    tabActions.openResource(B_TXT)
    expect(titles()).toContain('b.txt')
    release()
    tabActions.close()
    expect(titles()).toContain('a.txt')
  })

  it('adoption syncs the Tab domain on each commit of that store: the seeded guide is pinned, a closed tab aborted', () => {
    const { controller, adopt, instance, pin } = harness()
    const first = adopt(SESSION, instance)
    // An empty adopted surface has no resources to pin; another Session's
    // commits do not populate it.
    instance.actions.open(OTHER)
    expect(pin).not.toHaveBeenCalled()
    instance.actions.setExpanded(SESSION, true)
    expect(pin).toHaveBeenCalledWith('sidebar://guide', expect.any(AbortSignal))
    instance.actions.openContent(SESSION, { kind: 'text', contentId: A_TXT, title: 'a' }, () => {})
    const surface = instance.getSnapshot().bySession[SESSION]
    const tab = Object.values(surface?.layout.tabs ?? {}).find(record => record.contentId === A_TXT)
    if (tab === undefined) throw new Error('expected the opened tab')
    const occurrence = controller.tabDomain.occurrence(SESSION, tab)
    expect(pin).toHaveBeenCalledWith(A_TXT, occurrence.signal)
    instance.actions.closeTab(SESSION, tab.id)
    expect(occurrence.signal.aborted).toBe(true)
    // A release ends the syncing; a stale release leaves a newer adoption standing.
    first()
    const second = adopt(SESSION, instance)
    first()
    instance.actions.openContent(SESSION, { kind: 'text', contentId: B_TXT, title: 'b' }, () => {})
    const again = Object.values(instance.getSnapshot().bySession[SESSION]?.layout.tabs ?? {}).find(record => record.contentId === B_TXT)
    if (again === undefined) throw new Error('expected the second tab')
    const held = controller.tabDomain.occurrence(SESSION, again)
    expect(pin).toHaveBeenCalledWith(B_TXT, held.signal)
    // Adopting another instance for the session ends the earlier adoption's
    // subscription with its routing: the old store's commits sync nothing, the
    // new store's commits reconcile the session against its own layout.
    const replacement = createSidebarRightStore(() => ({ kind: 'guide', title: 'seed' })).create()
    const third = adopt(SESSION, replacement)
    const pins = pin.mock.calls.length
    instance.actions.openContent(SESSION, { kind: 'text', contentId: 'dsh-resource://file/session/s-test/c.txt', title: 'c' }, () => {})
    expect(pin.mock.calls.length).toBe(pins)
    expect(held.signal.aborted).toBe(false)
    replacement.actions.open(SESSION)
    expect(held.signal.aborted).toBe(true)
    second()
    third()
  })
})

describe('SidebarRightController — the readable slice', () => {
  it('answers for the no-session case rather than throwing', () => {
    const { controller } = harness()
    expect(controller.isExpanded()).toBe(false)
    expect(controller.active()).toBeUndefined()
  })

  it('reports the last committed surface', () => {
    const { controller, publish, layout } = harness()
    publish()
    controller.toggleExpanded()
    publish()
    expect(controller.isExpanded()).toBe(true)
    controller.openResource('dsh-resource://file/session/s-test/a.txt')
    publish()
    expect(Object.values(layout().tabs).filter(tab => tab.contentId === 'dsh-resource://file/session/s-test/a.txt')).toHaveLength(1)
    expect(controller.active()?.contentId).toBe('dsh-resource://file/session/s-test/a.txt')
  })
})

describe('SidebarRightController — binding lifetime', () => {
  it('acts on the newest binding when a seat republishes', () => {
    const { controller, publish, layout } = harness()
    publish()
    controller.toggleExpanded()
    publish()
    expect(controller.isExpanded()).toBe(true)
    expect(layout().expanded).toBe(true)
  })

  it('goes back to refusing writes once the seat releases', () => {
    const { controller, publish } = harness()
    const release = publish()
    release()
    expect(() => { controller.toggleExpanded() }).toThrow('no session surface is mounted')
    expect(controller.isExpanded()).toBe(false)
  })

  it('a stale release does not clear a newer binding', () => {
    const { controller, publish } = harness()
    const stale = publish()
    publish()
    stale()
    expect(() => { controller.toggleExpanded() }).not.toThrow()
  })
})

describe('explicit tab resource cleanup', () => {
  it.each(['close', 'replace'] as const)('immediately removes the tab after a synchronous cleanup handler during %s', (operation) => {
    const h = harness()
    const release = h.adopt(SESSION, h.instance)
    const unbind = h.publish()
    h.controller.openResource('dsh-resource://file/session/s-test/terminal')
    const tabId = h.tabOf('terminal')
    const original = h.layout().tabs[tabId]
    const handler = vi.fn(() => { expect(h.layout().tabs[tabId]).toBe(original) })
    const unregister = h.controller.registerCloseHandler('text', handler)
    try {
      const before = h.entries()
      if (operation === 'close') h.controller.close(tabId)
      else h.controller.openTab('guide', { replaceTab: tabId, revealIfOpened: false })
      expect(handler).toHaveBeenCalledExactlyOnceWith(SESSION, original)
      expect(h.layout().tabs[tabId]).toBeUndefined()
      expect(h.entries()).toBe(before + 1)
      h.controller.closeIn(SESSION, tabId)
      expect(handler).toHaveBeenCalledOnce()
    } finally {
      unregister()
      unbind()
      release()
    }
  })

  it('does not invoke cleanup on collapse or when revealing the same tab', () => {
    const h = harness()
    h.adopt(SESSION, h.instance)
    h.publish()
    const address = 'dsh-resource://file/session/s-test/terminal'
    h.controller.openResource(address)
    h.publish()
    const tabId = h.tabOf('terminal')
    const handler = vi.fn()
    h.controller.registerCloseHandler('text', handler)
    h.controller.toggleExpanded()
    h.controller.openResource(address, { replaceTab: tabId })
    expect(handler).not.toHaveBeenCalled()
    expect(h.layout().tabs[tabId]).toBeDefined()
  })

  it.each(['close', 'replace'] as const)('preserves a tab when its synchronous %s handler throws', (operation) => {
    const h = harness()
    h.adopt(SESSION, h.instance)
    h.publish()
    h.controller.openResource('dsh-resource://file/session/s-test/terminal')
    const tabId = h.tabOf('terminal')
    const release = h.controller.registerCloseHandler('text', () => { throw new Error('cannot retain cleanup') })
    const perform = () => {
      if (operation === 'close') h.controller.closeIn(SESSION, tabId)
      else h.controller.openTab('guide', { replaceTab: tabId, revealIfOpened: false })
    }
    expect(perform).toThrow('cannot retain cleanup')
    expect(h.layout().tabs[tabId]).toBeDefined()
    release()
    perform()
    expect(h.layout().tabs[tabId]).toBeUndefined()
  })
})

it('releases close handlers without a stale disposer removing a replacement', () => {
  const h = harness()
  h.adopt(SESSION, h.instance)
  h.publish()
  const first = vi.fn(() => {})
  const second = vi.fn(() => {})
  const release = h.controller.registerCloseHandler('text', first)
  expect(() => h.controller.registerCloseHandler('text', second)).toThrow('already registered')
  release()
  const releaseSecond = h.controller.registerCloseHandler('text', second)
  release()
  h.controller.openResource('dsh-resource://file/session/s-test/one')
  h.publish()
  h.controller.closeIn(SESSION, h.tabOf('one'))
  expect(first).not.toHaveBeenCalled()
  expect(second).toHaveBeenCalledOnce()
  releaseSecond()
  h.controller.openResource('dsh-resource://file/session/s-test/two')
  h.publish()
  const tabId = h.tabOf('two')
  h.controller.openTab('guide', { replaceTab: tabId, revealIfOpened: false })
  expect(h.layout().tabs[tabId]).toBeUndefined()
  expect(second).toHaveBeenCalledOnce()
})
