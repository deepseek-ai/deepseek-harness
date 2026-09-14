/**
 * The Tab domain: what a record carries that the layout does not, and how long.
 *
 * Every assertion here is a lifetime rule a tab type relies on through its
 * owner props: the signal aborts exactly when the record is gone, the pin lasts
 * exactly as long, an undone close is a new occurrence, another session's
 * records are left alone, and a tab's own actions name the tab's session and land where the tab is now.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { LayoutState, TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { DockController, getPane } from '@deepseek-ai/dsh-client-ui-dockkit'
import { TabDomain } from '../src/client/tab-domain.ts'
import type { SidebarRightNavigator } from '../src/client/tab-domain.ts'

// The params map is empty in this package; a test-only scheme lets specs hand
// parameters through the typed `open`/`navigate` faces.
declare module '../src/client/contract/params.ts' {
  interface SidebarRightResourceParamsMap {
    test: { line?: number; x?: number }
  }
}

const SESSION = 's-one' as SessionId
const OTHER = 's-two' as SessionId

/** A layout driven by the kit's own controller; the domain only ever reads snapshots. */
function layouts() {
  const controller = new DockController({
    makeInitialTab: id => ({ id, kind: 'guide', contentId: 'sidebar://guide', title: 'Start' }),
    makePaneTab: id => ({ id, kind: 'guide', contentId: 'sidebar://guide', title: 'Start' }),
  })
  const current = (): LayoutState => controller.getSnapshot().state
  return { controller, current }
}

function harness() {
  const navigator = { openResourceIn: vi.fn(), openTabIn: vi.fn(), closeIn: vi.fn() } satisfies
    SidebarRightNavigator & Record<string, ReturnType<typeof vi.fn>>
  const pin = vi.fn<(address: string, signal: AbortSignal) => void>()
  const domain = new TabDomain(navigator, pin)
  return { domain, navigator, pin, ...layouts() }
}

/** The record for a tab id, as the seat would hand it over. */
function recordOf(state: LayoutState, tabId: TabId) {
  const tab = state.tabs[tabId]
  if (tab === undefined) throw new Error(`expected tab ${tabId}`)
  return tab
}

describe('TabDomain — occurrences follow records', () => {
  it('pins a record\'s address when it first appears, with the occurrence\'s signal', () => {
    const { domain, pin, controller, current } = harness()
    const tabId = controller.openContent({ kind: 'text', contentId: 'dsh-resource://file/session/s-one/a.txt', title: 'a' })
    domain.sync(SESSION, current())
    const occurrence = domain.occurrence(SESSION, recordOf(current(), tabId))
    expect(pin).toHaveBeenCalledWith('dsh-resource://file/session/s-one/a.txt', occurrence.signal)
    expect(occurrence.signal.aborted).toBe(false)
    // Seeded records are occurrences too; the guide is pinned like anything else.
    expect(pin).toHaveBeenCalledWith('sidebar://guide', expect.any(AbortSignal))
    expect(pin).toHaveBeenCalledTimes(2)
  })

  it('pins once per occurrence, however many times the layout commits', () => {
    const { domain, pin, controller, current } = harness()
    controller.openContent({ kind: 'text', contentId: 'dsh-resource://file/session/s-one/a.txt', title: 'a' })
    domain.sync(SESSION, current())
    controller.setExpanded(true)
    domain.sync(SESSION, current())
    expect(pin).toHaveBeenCalledTimes(2)
  })

  it('aborts the occurrence when its record vanishes, and builds a new one when undo restores it', () => {
    const { domain, pin, controller, current } = harness()
    const tabId = controller.openContent({ kind: 'text', contentId: 'dsh-resource://file/session/s-one/a.txt', title: 'a' })
    domain.sync(SESSION, current())
    const first = domain.occurrence(SESSION, recordOf(current(), tabId))
    controller.closeTab(tabId)
    domain.sync(SESSION, current())
    expect(first.signal.aborted).toBe(true)
    controller.undo()
    domain.sync(SESSION, current())
    const second = domain.occurrence(SESSION, recordOf(current(), tabId))
    expect(second).not.toBe(first)
    expect(second.signal.aborted).toBe(false)
    expect(second.navigation.getSnapshot()).toEqual({ address: 'dsh-resource://file/session/s-one/a.txt', params: undefined, revision: 0 })
    expect(pin.mock.calls.filter(([address]) => address === 'dsh-resource://file/session/s-one/a.txt')).toHaveLength(2)
  })

  it('leaves another session\'s occurrences alone when a session is synced', () => {
    const { domain, controller, current } = harness()
    const tabId = controller.openContent({ kind: 'text', contentId: 'dsh-resource://file/session/s-one/a.txt', title: 'a' })
    domain.sync(SESSION, current())
    const held = domain.occurrence(SESSION, recordOf(current(), tabId))
    const other = layouts()
    domain.sync(OTHER, other.current())
    expect(held.signal.aborted).toBe(false)
  })

  it('aborts every occurrence of every session on dispose', () => {
    const { domain, controller, current } = harness()
    const tabId = controller.openContent({ kind: 'text', contentId: 'dsh-resource://file/session/s-one/a.txt', title: 'a' })
    domain.sync(SESSION, current())
    domain.sync(OTHER, layouts().current())
    const held = domain.occurrence(SESSION, recordOf(current(), tabId))
    domain.dispose()
    expect(held.signal.aborted).toBe(true)
  })
})

describe('TabDomain — navigation', () => {
  it('creates the occurrence for a tab the seat has not shown yet, at revision 1, and pins it on the next sync', () => {
    const { domain, pin, controller, current } = harness()
    const tabId = controller.openContent({ kind: 'text', contentId: 'dsh-resource://file/session/s-one/a.txt', title: 'a' })
    domain.navigate(SESSION, tabId, { address: 'dsh-resource://file/session/s-one/a.txt', params: { line: 7 } })
    expect(pin).not.toHaveBeenCalled()
    const occurrence = domain.occurrence(SESSION, recordOf(current(), tabId))
    expect(occurrence.navigation.getSnapshot()).toEqual({ address: 'dsh-resource://file/session/s-one/a.txt', params: { line: 7 }, revision: 1 })
    domain.sync(SESSION, current())
    expect(domain.occurrence(SESSION, recordOf(current(), tabId))).toBe(occurrence)
    expect(pin).toHaveBeenCalledWith('dsh-resource://file/session/s-one/a.txt', occurrence.signal)
  })

  it('steps the revision on every navigation, params changed or not, and notifies', () => {
    const { domain, controller, current } = harness()
    const tabId = controller.openContent({ kind: 'text', contentId: 'dsh-resource://file/session/s-one/a.txt', title: 'a' })
    domain.sync(SESSION, current())
    const occurrence = domain.occurrence(SESSION, recordOf(current(), tabId))
    const seen = vi.fn()
    occurrence.navigation.subscribe(seen)
    domain.navigate(SESSION, tabId, { address: 'dsh-resource://file/session/s-one/a.txt', params: { line: 3 } })
    domain.navigate(SESSION, tabId, { address: 'dsh-resource://file/session/s-one/a.txt', params: { line: 3 } })
    expect(occurrence.navigation.getSnapshot()).toEqual({ address: 'dsh-resource://file/session/s-one/a.txt', params: { line: 3 }, revision: 2 })
    expect(seen).toHaveBeenCalledTimes(2)
  })

  it('refuses an uncommitted occurrence without creating it during a read', () => {
    const { domain, pin, controller, current } = harness()
    const tabId = controller.openContent({ kind: 'text', contentId: 'dsh-resource://file/session/s-one/a.txt', title: 'a' })
    expect(() => domain.occurrence(SESSION, { id: tabId })).toThrow('has no committed occurrence')
    expect(pin).not.toHaveBeenCalled()
    domain.sync(SESSION, current())
    const occurrence = domain.occurrence(SESSION, { id: tabId })
    expect(domain.occurrence(SESSION, { id: tabId })).toBe(occurrence)
    expect(pin).toHaveBeenCalledWith('dsh-resource://file/session/s-one/a.txt', occurrence.signal)
    controller.closeTab(tabId)
    domain.sync(SESSION, current())
    expect(() => domain.occurrence(SESSION, { id: tabId })).toThrow('has no committed occurrence')
  })
})

describe('TabDomain — a tab\'s own actions', () => {
  it('opens into the pane holding the tab at call time, including after it was moved', () => {
    const { domain, navigator, controller, current } = harness()
    controller.setExpanded(true)
    const tabId = controller.openContent({ kind: 'text', contentId: 'dsh-resource://file/session/s-one/a.txt', title: 'a' })
    controller.splitPane()
    domain.sync(SESSION, current())
    const occurrence = domain.occurrence(SESSION, recordOf(current(), tabId))
    const home = current().nodes[current().rootId]
    if (home?.kind !== 'split') throw new Error('expected a split root')
    const [left, right] = home.children
    if (left === undefined || right === undefined) throw new Error('expected two panes')
    const leftPane = getPane(current(), left).id
    const rightPane = getPane(current(), right).id
    occurrence.tabActions.openResource('dsh-resource://file/session/s-one/b.txt')
    expect(navigator.openResourceIn).toHaveBeenLastCalledWith(SESSION, 'dsh-resource://file/session/s-one/b.txt', { paneId: leftPane })
    controller.placeTab(tabId, rightPane, 0)
    domain.sync(SESSION, current())
    occurrence.tabActions.openResource('dsh-resource://file/session/s-one/b.txt', { params: { line: 1 } })
    expect(navigator.openResourceIn).toHaveBeenLastCalledWith(SESSION, 'dsh-resource://file/session/s-one/b.txt', { paneId: rightPane, params: { line: 1 } })
    // The caller's pane wins over the default.
    occurrence.tabActions.openResource('dsh-resource://file/session/s-one/b.txt', { paneId: leftPane })
    expect(navigator.openResourceIn).toHaveBeenLastCalledWith(SESSION, 'dsh-resource://file/session/s-one/b.txt', { paneId: leftPane })
  })

  it('opens unplaced from a floating tab, since a floating pane holds one tab', () => {
    const { domain, navigator, controller, current } = harness()
    const tabId = controller.openContent({ kind: 'text', contentId: 'dsh-resource://file/session/s-one/a.txt', title: 'a' })
    controller.floatTab(tabId)
    domain.sync(SESSION, current())
    domain.occurrence(SESSION, recordOf(current(), tabId)).tabActions.openResource('dsh-resource://file/session/s-one/b.txt')
    expect(navigator.openResourceIn).toHaveBeenLastCalledWith(SESSION, 'dsh-resource://file/session/s-one/b.txt', {})
  })

  it('replaces itself and closes itself through the navigator', () => {
    const { domain, navigator, controller, current } = harness()
    const tabId = controller.openContent({ kind: 'text', contentId: 'dsh-resource://file/session/s-one/a.txt', title: 'a' })
    domain.sync(SESSION, current())
    const { tabActions } = domain.occurrence(SESSION, recordOf(current(), tabId))
    tabActions.openTab('files', { replaceTab: true })
    expect(navigator.openTabIn).toHaveBeenLastCalledWith(SESSION, 'files', { replaceTab: tabId })
    tabActions.close()
    expect(navigator.closeIn).toHaveBeenCalledWith(SESSION, tabId)
  })

  it('passes revealIfOpened through, so a tab may open a second copy beside itself', () => {
    const { domain, navigator, controller, current } = harness()
    const tabId = controller.openContent({ kind: 'text', contentId: 'dsh-resource://file/session/s-one/a.txt', title: 'a' })
    domain.sync(SESSION, current())
    const { tabActions } = domain.occurrence(SESSION, recordOf(current(), tabId))
    tabActions.openResource('dsh-resource://file/session/s-one/a.txt', { revealIfOpened: false })
    expect(navigator.openResourceIn).toHaveBeenLastCalledWith(
      SESSION,
      'dsh-resource://file/session/s-one/a.txt',
      { paneId: current().rootId, revealIfOpened: false },
    )
  })
})
