/**
 * The store shell over the docking kit: every action is one settled intent
 * recorded as one history entry, or no entry when it changes nothing.
 *
 * The opens, page uniqueness, and the merge rule are asserted through
 * `ctx.sidebarRight` in service.client.spec.ts; here are the intents only the
 * kit's gestures reach — floating-panel moves and resizes, divider drags — and
 * the sequence's ends, plus the seed's timing: a surface starts empty, and the
 * default page arrives with the expansion that would otherwise show nothing.
 */
import { describe, expect, it, vi } from 'vitest'
import type { LayoutState, PaneId, TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { dockPaneIds, findTabPane, getPane, getSplit } from '@deepseek-ai/dsh-client-ui-dockkit'
import { createSidebarRightStore } from '../src/client/stores.ts'
import { pageAddress } from '../src/client/contract/seed.ts'

const SESSION = 's-test'

function harness() {
  const instance = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' })).create()
  instance.actions.open(SESSION)
  const surface = () => {
    const held = instance.getSnapshot().bySession[SESSION]
    if (held === undefined) throw new Error('expected a surface')
    return held
  }
  const layout = (): LayoutState => surface().layout
  const entries = (): number => surface().history.entries.length
  const guide = (): TabId => {
    const seeded = Object.values(layout().tabs).find(tab => tab.kind === 'guide')
    if (seeded === undefined) throw new Error('expected the seeded guide')
    return seeded.id
  }
  // The surface starts empty; expanding seeds the default guide.
  const expand = (): void => { instance.actions.setExpanded(SESSION, true) }
  return { instance, actions: instance.actions, surface, layout, entries, guide, expand }
}

describe('createSidebarRightStore — the sequence', () => {
  it.each(['left', 'right'] as const)('splits one pane at its %s edge and records the tab move as one reversible intent', (zone) => {
    const { actions, layout, entries, guide, expand } = harness()
    expand()
    actions.openContent(SESSION, {
      kind: 'text', contentId: 'dsh-resource://file/session/s-test/a.txt', title: 'a',
    }, () => {})
    const text = Object.values(layout().tabs).find(tab => tab.kind === 'text')
    if (text === undefined) throw new Error('expected the text tab')
    const before = layout()
    const home = getPane(before, before.rootId).id
    const recorded = entries()

    actions.dropTab(SESSION, text.id, home, zone)

    const split = getSplit(layout(), layout().rootId)
    const destination = findTabPane(layout(), text.id)
    expect(split.axis).toBe('row')
    expect(split.children).toEqual(zone === 'left' ? [destination.id, home] : [home, destination.id])
    expect(split.sizes).toEqual([0.5, 0.5])
    expect(destination.tabs).toEqual([text.id])
    expect(destination.activeTabId).toBe(text.id)
    expect(getPane(layout(), home).tabs).toEqual([guide()])
    expect(layout().tabs).toEqual(before.tabs)
    expect(entries()).toBe(recorded + 1)
    const dropped = layout()

    actions.undo(SESSION)
    expect(layout()).toEqual(before)
    actions.redo(SESSION)
    expect(layout()).toEqual(dropped)
  })

  it('splits on a sole tab\'s own edge drop, backfilling the vacated pane with the default page', () => {
    const { actions, layout, entries, guide, expand } = harness()
    expand()
    const dragged = guide()
    const home = layout().activePaneId
    const recorded = entries()
    // Released on its own centre, a sole tab still changes nothing.
    actions.dropTab(SESSION, dragged, home, 'center')
    expect(entries()).toBe(recorded)

    actions.dropTab(SESSION, dragged, home, 'right')

    const split = getSplit(layout(), layout().rootId)
    const destination = findTabPane(layout(), dragged)
    expect(split.children).toEqual([home, destination.id])
    expect(destination.tabs).toEqual([dragged])
    // The vacated pane holds a fresh default page rather than merging away.
    const backfill = getPane(layout(), home).tabs
    expect(backfill).toHaveLength(1)
    expect(backfill[0]).not.toBe(dragged)
    expect(layout().tabs[backfill[0]!]?.kind).toBe('guide')
    // The dragged tab keeps focus, as any other drop leaves it.
    expect(layout().activePaneId).toBe(destination.id)
    expect(destination.activeTabId).toBe(dragged)
    expect(entries()).toBe(recorded + 1)

    actions.undo(SESSION)
    expect(getPane(layout(), home).tabs).toEqual([dragged])
    expect(Object.values(layout().tabs)).toHaveLength(1)
  })

  it.each([false, true])('does not split an empty collapsed pane after close=%s', (afterClose) => {
    const { actions, layout, surface } = harness()
    if (afterClose) {
      actions.openContent(SESSION, { kind: 'text', contentId: 'file:a', title: 'a' }, () => {})
      actions.closeTab(SESSION, Object.values(layout().tabs)[0]!.id)
    }
    const before = surface()
    const settled = vi.fn()
    actions.splitPane(SESSION, undefined, settled)
    expect(surface()).toBe(before)
    expect(settled).not.toHaveBeenCalled()
    expect(layout().expanded).toBe(false)
    expect(Object.keys(layout().tabs)).toHaveLength(0)
  })

  it.each(['guide', 'files'])('opens %s in the requested pane and merges a moved duplicate there', (kind) => {
    const { actions, layout } = harness()
    const address = pageAddress(kind)
    actions.openContent(SESSION, { kind, contentId: address, title: kind }, () => {})
    const first = Object.values(layout().tabs)[0]!
    const firstPane = layout().activePaneId
    actions.splitPane(SESSION)
    const secondPane = layout().activePaneId
    const seed = getPane(layout(), secondPane).tabs[0]!
    actions.openContent(SESSION, { kind: 'text', contentId: 'file:b', title: 'b', replaceTab: seed }, () => {})
    const opened = vi.fn<(tabId: TabId) => void>()
    actions.openContent(SESSION, { kind, contentId: address, title: kind, paneId: secondPane }, opened)
    const second = opened.mock.calls[0]![0]
    expect(second).not.toBe(first.id)
    expect(getPane(layout(), firstPane).tabs).toEqual([first.id])
    expect(getPane(layout(), secondPane).activeTabId).toBe(second)
    expect(layout().activePaneId).toBe(secondPane)
    const held = vi.fn()
    actions.openContent(SESSION, { kind, contentId: address, title: kind, paneId: secondPane, revealIfOpened: false }, held)
    expect(held).toHaveBeenCalledWith(second)
    actions.dropTab(SESSION, first.id, secondPane, 'center')
    expect(layout().tabs[first.id]).toBeUndefined()
    expect(getPane(layout(), secondPane).activeTabId).toBe(second)
    expect(dockPaneIds(layout())).toEqual([secondPane])
  })

  it('allows two docked panes and rejects further splits without recording', () => {
    const { actions, layout, entries, expand } = harness()
    expand()
    actions.splitPane(SESSION)
    expect(dockPaneIds(layout())).toHaveLength(2)
    const before = entries()
    const settled = vi.fn()
    actions.splitPane(SESSION, undefined, settled)
    expect(dockPaneIds(layout())).toHaveLength(2)
    expect(entries()).toBe(before)
    expect(settled).not.toHaveBeenCalled()
  })

  it('rejects vertical drops and keeps split ratios within twenty to eighty percent', () => {
    const { actions, layout, entries, guide, expand } = harness()
    expand()
    actions.openContent(SESSION, { kind: 'text', contentId: 'file:a', title: 'a' }, () => {})
    const before = entries()
    actions.dropTab(SESSION, guide(), layout().activePaneId, 'top')
    actions.dropTab(SESSION, guide(), layout().activePaneId, 'bottom')
    expect(entries()).toBe(before)
    actions.splitPane(SESSION)
    const split = getSplit(layout(), layout().rootId).id
    actions.resizeSplit(SESSION, split, [0.01, 0.99])
    expect(getSplit(layout(), split).sizes).toEqual([0.2, 0.8])
    actions.resizeSplit(SESSION, split, [0.99, 0.01])
    expect(getSplit(layout(), split).sizes).toEqual([0.8, 0.2])
    const splitCount = entries()
    actions.dropTab(SESSION, guide(), layout().activePaneId, 'right')
    expect(entries()).toBe(splitCount)
  })

  it('materializes a session empty on open without recording, then seeds the guide with the first expansion', () => {
    const { actions, layout, entries } = harness()
    expect(layout().expanded).toBe(false)
    expect(Object.values(layout().tabs)).toHaveLength(0)
    expect(entries()).toBe(0)
    // The expansion and the seed it makes visible are one recorded entry.
    actions.setExpanded(SESSION, true)
    expect(layout().expanded).toBe(true)
    expect(Object.values(layout().tabs)).toHaveLength(1)
    expect(entries()).toBe(1)
    // Already expanded: nothing to plan, nothing recorded, the surface kept by reference.
    const before = layout()
    actions.setExpanded(SESSION, true)
    expect(layout()).toBe(before)
    expect(entries()).toBe(1)
    // Collapsing keeps the seeded guide; the next expansion has nothing to seed.
    actions.setExpanded(SESSION, false)
    actions.setExpanded(SESSION, true)
    expect(Object.values(layout().tabs)).toHaveLength(1)
  })

  it('closes a tab once: a second close of a record already gone records nothing and throws nothing', () => {
    const { actions, layout, entries } = harness()
    actions.openContent(SESSION, { kind: 'text', contentId: 'dsh-resource://file/session/s-test/a.txt', title: 'a' }, () => {})
    const tab = Object.values(layout().tabs).find(record => record.title === 'a')
    if (tab === undefined) throw new Error('expected the opened tab')
    actions.closeTab(SESSION, tab.id)
    expect(layout().tabs[tab.id]).toBeUndefined()
    const recorded = entries()
    // A racing callback closing what the user already closed.
    expect(() => { actions.closeTab(SESSION, tab.id) }).not.toThrow()
    expect(entries()).toBe(recorded)
  })

  it('steps nowhere before the first entry, and forward again through an undone one', () => {
    const { actions, surface, layout } = harness()
    const start = surface()
    actions.undo(SESSION)
    expect(surface()).toBe(start)
    actions.redo(SESSION)
    expect(surface()).toBe(start)
    actions.toggleExpanded(SESSION)
    actions.undo(SESSION)
    expect(layout().expanded).toBe(false)
    actions.redo(SESSION)
    expect(layout().expanded).toBe(true)
  })
})

describe('createSidebarRightStore — the last docked tab', () => {
  it('refuses to close the guide standing as the docked surface\'s only tab, recording nothing', () => {
    const { actions, surface, layout, entries, guide } = harness()
    actions.setExpanded(SESSION, true)
    const before = surface()
    const recorded = entries()
    actions.closeTab(SESSION, guide())
    expect(surface()).toBe(before)
    expect(entries()).toBe(recorded)
    expect(layout().tabs[guide()]).toBeDefined()
  })

  it('closes the last non-guide tab together with the column, leaving it empty until the next expansion seeds', () => {
    const { actions, layout, entries, expand, guide } = harness()
    expand()
    actions.openContent(SESSION, { kind: 'text', contentId: 'dsh-resource://file/session/s-test/a.txt', title: 'a' }, () => {})
    const text = Object.values(layout().tabs).find(tab => tab.kind === 'text')
    if (text === undefined) throw new Error('expected the text tab beside the guide')
    // Two tabs: closing the guide is an ordinary close, and the column stays open.
    actions.closeTab(SESSION, guide())
    expect(layout().expanded).toBe(true)
    expect(Object.values(layout().tabs)).toEqual([text])
    const before = layout()
    const recorded = entries()
    // Fullscreen at the moment of the close: the collapse must hand the mode
    // back too, or the next expand gives the whole window to the default page.
    actions.setMode(SESSION, 'fullscreen')

    actions.closeTab(SESSION, text.id)

    expect(layout().expanded).toBe(false)
    expect(layout().mode).toBe('push')
    // The collapsed column stands empty: no page was seeded behind the collapse.
    expect(Object.values(layout().tabs)).toHaveLength(0)
    expect(entries()).toBe(recorded + 2)

    actions.undo(SESSION)
    actions.undo(SESSION)
    expect(layout()).toEqual(before)

    // The next expansion seeds the then-current default page.
    actions.redo(SESSION)
    actions.redo(SESSION)
    expand()
    expect(layout().expanded).toBe(true)
    expect(Object.values(layout().tabs)).toHaveLength(1)
    expect(guide()).toBeDefined()
  })

  it('closes a floating tab without touching the column: floats do not count as the last docked tab', () => {
    const { actions, layout, guide } = harness()
    actions.setExpanded(SESSION, true)
    actions.openContent(SESSION, { kind: 'text', contentId: 'dsh-resource://file/session/s-test/a.txt', title: 'a' }, () => {})
    const text = Object.values(layout().tabs).find(tab => tab.kind === 'text')
    if (text === undefined) throw new Error('expected the text tab')
    actions.floatTab(SESSION, text.id, { x: 10, y: 20, width: 300, height: 200 })
    // The guide is now the docked surface's only tab; the floating text tab closes freely.
    actions.closeTab(SESSION, text.id)
    expect(layout().floats).toHaveLength(0)
    expect(layout().tabs[text.id]).toBeUndefined()
    expect(layout().expanded).toBe(true)
    expect(layout().tabs[guide()]).toBeDefined()
  })
})

describe('createSidebarRightStore — floating panels and dividers', () => {
  it('closes the sole tab in a floating pane while retaining the docked pane', () => {
    const { actions, layout, entries, guide, expand } = harness()
    expand()
    const floating = guide()
    actions.floatTab(SESSION, floating, { x: 10, y: 20, width: 300, height: 200 })
    expect(findTabPane(layout(), floating).host).toBe('float')
    const recorded = entries()

    actions.closeTab(SESSION, floating)

    expect(layout().tabs[floating]).toBeUndefined()
    expect(layout().floats).toHaveLength(0)
    expect(getPane(layout(), layout().rootId).tabs).toHaveLength(1)
    expect(entries()).toBe(recorded + 1)

    const docked = getPane(layout(), layout().rootId).tabs[0]!
    const retained = layout()
    actions.closeTab(SESSION, docked)
    expect(layout()).toBe(retained)
    expect(entries()).toBe(recorded + 1)
  })

  it('moves and resizes a floating panel, one entry each', () => {
    const { actions, layout, entries, guide, expand } = harness()
    expand()
    actions.floatTab(SESSION, guide(), { x: 10, y: 20, width: 300, height: 200 })
    const [float] = layout().floats
    if (float === undefined) throw new Error('expected a floating pane')
    const recorded = entries()
    actions.moveFloat(SESSION, float, 40, 60)
    expect(findTabPane(layout(), guide()).rect).toEqual({ x: 40, y: 60, width: 300, height: 200 })
    actions.resizeFloat(SESSION, float, { x: 40, y: 60, width: 420, height: 260 })
    expect(findTabPane(layout(), guide()).rect).toEqual({ x: 40, y: 60, width: 420, height: 260 })
    expect(entries()).toBe(recorded + 2)
  })

  it('focuses a pane as one entry, which a click on a floating panel records', () => {
    const { actions, layout, entries, guide, expand } = harness()
    expand()
    actions.floatTab(SESSION, guide(), { x: 10, y: 20, width: 300, height: 200 })
    const [float] = layout().floats
    if (float === undefined) throw new Error('expected a floating pane')
    // The root pane was reseeded when its guide floated away, so it is docked and focusable.
    const docked = getPane(layout(), layout().rootId).id
    actions.focusPane(SESSION, docked)
    expect(layout().activePaneId).toBe(docked)
    const recorded = entries()
    actions.focusPane(SESSION, float)
    expect(layout().activePaneId).toBe(float)
    expect(entries()).toBe(recorded + 1)
  })

  it('records a divider drag as the split\'s new fractions', () => {
    const { actions, layout, entries, expand } = harness()
    expand()
    actions.splitPane(SESSION)
    const rootId = getSplit(layout(), layout().rootId).id
    expect(getSplit(layout(), rootId).sizes).toEqual([0.5, 0.5])
    const recorded = entries()
    actions.resizeSplit(SESSION, rootId, [0.3, 0.7])
    expect(getSplit(layout(), rootId).sizes).toEqual([0.3, 0.7])
    expect(entries()).toBe(recorded + 1)
  })

  it('reports the pane a split created, and only then', () => {
    const { actions, layout, expand } = harness()
    expand()
    const settled = vi.fn<(paneId: PaneId) => void>()
    const before = dockPaneIds(layout())
    actions.splitPane(SESSION, undefined, settled)
    const created = dockPaneIds(layout()).filter(id => !before.includes(id))
    expect(created).toHaveLength(1)
    expect(settled).toHaveBeenCalledExactlyOnceWith(created[0])
    // A floating pane cannot be split: nothing changes and nothing is reported.
    const [tab] = getPane(layout(), created[0] as PaneId).tabs
    if (tab === undefined) throw new Error('expected the seeded guide')
    actions.floatTab(SESSION, tab)
    const [float] = layout().floats
    if (float === undefined) throw new Error('expected a floating pane')
    actions.splitPane(SESSION, float, settled)
    expect(settled).toHaveBeenCalledTimes(1)
  })
})

describe('createSidebarRightStore — focus', () => {
  it('records a focus only when it changes which tab or pane is active, docked or floating', () => {
    const { actions, layout, entries, guide, expand } = harness()
    expand()
    actions.openContent(SESSION, { kind: 'text', contentId: 'dsh-resource://file/session/s-test/a.txt', title: 'a' }, () => {})
    const text = Object.values(layout().tabs).find(tab => tab.kind === 'text')
    if (text === undefined) throw new Error('expected the text tab')
    const home = layout().activePaneId
    expect(getPane(layout(), home).activeTabId).toBe(text.id)
    const recorded = entries()
    // Already the active tab of the active pane, already the active pane: nothing to record.
    actions.focusTab(SESSION, text.id)
    actions.focusPane(SESSION, home)
    expect(entries()).toBe(recorded)
    // Another tab of the same pane: recorded.
    actions.focusTab(SESSION, guide())
    expect(getPane(layout(), home).activeTabId).toBe(guide())
    expect(entries()).toBe(recorded + 1)
    // Two panes: the home pane's active tab, focused while the other pane is active, is recorded.
    actions.splitPane(SESSION)
    const other = dockPaneIds(layout()).find(id => id !== home)
    if (other === undefined) throw new Error('expected a second pane')
    actions.focusPane(SESSION, other)
    const split = entries()
    actions.focusTab(SESSION, guide())
    expect(layout().activePaneId).toBe(home)
    expect(entries()).toBe(split + 1)
    // A floating pane: focusing it while it is active records nothing; after
    // a docked pane took focus, focusing its pane and its tab record again.
    actions.floatTab(SESSION, text.id)
    const [float] = layout().floats
    if (float === undefined) throw new Error('expected a floating pane')
    expect(layout().activePaneId).toBe(float)
    const floated = entries()
    actions.focusPane(SESSION, float)
    actions.focusTab(SESSION, text.id)
    expect(entries()).toBe(floated)
    actions.focusPane(SESSION, home)
    actions.focusPane(SESSION, float)
    expect(layout().activePaneId).toBe(float)
    actions.focusPane(SESSION, home)
    actions.focusTab(SESSION, text.id)
    expect(layout().activePaneId).toBe(float)
    expect(entries()).toBe(floated + 4)
  })
})

describe('createSidebarRightStore — page uniqueness', () => {
  it('places and drops any other tab as the kit plans it, guides in the target pane or not', () => {
    const { actions, layout, expand } = harness()
    expand()
    actions.openContent(SESSION, { kind: 'text', contentId: 'dsh-resource://file/session/s-test/a.txt', title: 'a' }, () => {})
    const text = Object.values(layout().tabs).find(tab => tab.kind === 'text')
    if (text === undefined) throw new Error('expected the text tab')
    actions.splitPane(SESSION)
    const [left, right] = dockPaneIds(layout())
    if (left === undefined || right === undefined) throw new Error('expected two panes')
    // Placed beside the right pane's guide: both stay, the text tab at the named slot.
    actions.placeTab(SESSION, text.id, right, 0)
    expect(getPane(layout(), right).tabs[0]).toBe(text.id)
    expect(getPane(layout(), right).tabs).toHaveLength(2)
    // Dropped on the left pane's centre: it moves in beside that pane's guide too.
    actions.dropTab(SESSION, text.id, left, 'center')
    expect(getPane(layout(), left).tabs).toContain(text.id)
    expect(Object.values(layout().tabs).filter(tab => tab.kind === 'guide')).toHaveLength(2)
  })

  it('reorders the guide within its own pane as a plain place', () => {
    const { actions, layout, guide, expand } = harness()
    expand()
    const pane = layout().activePaneId
    actions.openContent(SESSION, { kind: 'text', contentId: 'dsh-resource://file/session/s-test/a.txt', title: 'a' }, () => {})
    expect(getPane(layout(), pane).tabs[0]).toBe(guide())
    actions.placeTab(SESSION, guide(), pane, 2)
    expect(getPane(layout(), pane).tabs.at(-1)).toBe(guide())
    expect(Object.values(layout().tabs).filter(tab => tab.kind === 'guide')).toHaveLength(1)
  })
})
