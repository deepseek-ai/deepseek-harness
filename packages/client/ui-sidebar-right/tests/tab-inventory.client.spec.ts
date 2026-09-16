// @vitest-environment jsdom
/** Dormant saved layouts expose only provider metadata, with in-window stores authoritative. */
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TabRecord } from '@deepseek-ai/dsh-client-ui-dockkit'
import { SidebarTabInventory } from '../src/client/tab-inventory.ts'
import { sidebarPersistence } from '../src/client/persistence.ts'

afterEach(() => { localStorage.clear(); vi.restoreAllMocks() })
const session = 'inactive-session' as SessionId
const tab = { id: 'tab2', kind: 'terminal', contentId: 'terminal-page', title: 'Terminal' } as TabRecord
function save(id: SessionId, tabs: Record<string, unknown>): void {
  localStorage.setItem(`${sidebarPersistence}.${id}`, JSON.stringify({ bySession: { [id]: { minted: 3, layout: { tabs, expanded: false, mode: 'push', rootId: 'pane1', activePaneId: 'pane1', floats: [], nodes: { pane1: { id: 'pane1', kind: 'pane', host: 'dock', tabs: Object.keys(tabs), activeTabId: Object.keys(tabs)[0] } } } } } }))
}

it('inventories collapsed and inactive saved Sessions without creating occurrences or resources', () => {
  save(session, { [tab.id]: tab })
  const other = 'other-session' as SessionId
  save(other, { tab3: { ...tab, id: 'tab3', kind: 'documentPreview', contentId: '/a.ts' } })
  localStorage.setItem('unrelated', 'broken')
  const inventory = new SidebarTabInventory()
  expect(inventory.source.getSnapshot()).toEqual([
    { sessionId: session, tabId: tab.id, kind: tab.kind, contentId: tab.contentId },
    { sessionId: other, tabId: 'tab3', kind: 'documentPreview', contentId: '/a.ts' },
  ])
})

it('rejects an invalid layout as a whole without skipping later valid Sessions', () => {
  save('invalid' as SessionId, { [tab.id]: tab, wrongId: tab })
  save(session, { [tab.id]: tab })
  localStorage.setItem(`${sidebarPersistence}.broken-json`, '{')
  localStorage.setItem(`${sidebarPersistence}.missing-tabs`, '{"bySession":null}')
  const inventory = new SidebarTabInventory()
  expect(inventory.source.getSnapshot()).toHaveLength(1)
  inventory.remove(session)
  expect(inventory.source.getSnapshot()).toEqual([])
})

it('keeps stable membership across title and layout changes and ignores another window storage writes', () => {
  save(session, { [tab.id]: tab })
  const inventory = new SidebarTabInventory()
  const snapshot = inventory.source.getSnapshot()
  inventory.update(session, [{ ...tab, title: 'Renamed' }])
  expect(inventory.source.getSnapshot()).toBe(snapshot)
  save(session, {})
  window.dispatchEvent(new StorageEvent('storage', { key: `${sidebarPersistence}.${session}` }))
  expect(inventory.source.getSnapshot()).toBe(snapshot)
  inventory.update(session, [])
  expect(inventory.source.getSnapshot()).toEqual([])
})

it('publishes in-memory membership even when browser storage is inaccessible', () => {
  vi.spyOn(Storage.prototype, 'length', 'get').mockImplementation(() => { throw new Error('storage blocked') })
  const inventory = new SidebarTabInventory()
  inventory.update(session, [tab])
  expect(inventory.source.getSnapshot()).toMatchObject([{ sessionId: session, tabId: tab.id }])
})

it('allows startup without browser globals or with a key removed during enumeration', () => {
  vi.stubGlobal('localStorage', undefined)
  try { expect(new SidebarTabInventory().source.getSnapshot()).toEqual([]) }
  finally { vi.unstubAllGlobals() }
  save(session, { [tab.id]: tab })
  vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null)
  expect(new SidebarTabInventory().source.getSnapshot()).toEqual([])
})
