// @vitest-environment jsdom
/** Saved layouts reject invalid structures and references before either rendering or inventory publication. */
import { afterEach, expect, it, vi } from 'vitest'
import { createSurface, createSidebarRightStore } from '../src/client/stores.ts'
import { readSidebarLayout, writeSidebarLayout, clearSidebarLayout, sidebarPersistence } from '../src/client/persistence.ts'
import { SidebarTabInventory } from '../src/client/tab-inventory.ts'

const session = 'session'
const key = `${sidebarPersistence}.${session}`
const empty = createSurface()
const tab = { id: 'tab2', kind: 'terminal', contentId: 'sidebar://terminal/unique', title: 'Terminal' }
const pane = { id: 'pane1', kind: 'pane', host: 'dock', tabs: ['tab2'], activeTabId: 'tab2' }
const layout = { ...empty.layout, nodes: { pane1: pane }, tabs: { tab2: tab } }
const valid = { layout, minted: 2 }
const split = { id: 'split3', kind: 'split', axis: 'row', children: ['pane1', 'pane4'], sizes: [0.5, 0.5] }
const otherPane = { ...pane, id: 'pane4', tabs: [], activeTabId: undefined }
const splitLayout = { ...layout, rootId: 'split3', nodes: { pane1: pane, split3: split, pane4: otherPane } }

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear() })

it.each([
  ['missing layout', { minted: 2 }],
  ['wrong tab fields', { ...valid, layout: { ...layout, tabs: { tab2: { ...tab, kind: null } } } }],
  ['mismatched tab identity', { ...valid, layout: { ...layout, tabs: { tab2: { ...tab, id: 'tab3' } } } }],
  ['reused future identity', { ...valid, minted: 1 }],
  ['missing root', { ...valid, layout: { ...layout, rootId: 'pane3' } }],
  ['unreachable node', { ...valid, minted: 4, layout: { ...layout, nodes: { pane1: pane, pane4: otherPane } } }],
  ['missing tab reference', { ...valid, minted: 3, layout: { ...layout, nodes: { pane1: { ...pane, tabs: ['tab3'], activeTabId: 'tab3' } } } }],
  ['duplicate tab reference', { ...valid, layout: { ...layout, nodes: { pane1: { ...pane, tabs: ['tab2', 'tab2'] } } } }],
  ['unreachable tab', { ...valid, layout: { ...layout, nodes: { pane1: { ...pane, tabs: [], activeTabId: undefined } } } }],
  ['missing selection', { ...valid, layout: { ...layout, nodes: { pane1: { ...pane, activeTabId: undefined } } } }],
  ['invalid selection', { ...valid, minted: 3, layout: { ...layout, nodes: { pane1: { ...pane, activeTabId: 'tab3' } } } }],
  ['selection in empty pane', { ...valid, layout: { ...layout, nodes: { pane1: { ...pane, tabs: [] } } } }],
  ['floating host in dock tree', { ...valid, layout: { ...layout, nodes: { pane1: { ...pane, host: 'float' } } } }],
  ['rectangle on dock pane', { ...valid, layout: { ...layout, nodes: { pane1: { ...pane, rect: { x: 0, y: 0, width: 100, height: 100 } } } } }],
  ['duplicate split child', { minted: 4, layout: { ...splitLayout, nodes: { ...splitLayout.nodes, split3: { ...split, children: ['pane1', 'pane1'] } } } }],
  ['split cycle', { minted: 4, layout: { ...splitLayout, nodes: { ...splitLayout.nodes, split3: { ...split, children: ['split3', 'pane1'] } } } }],
  ['invalid split sum', { minted: 4, layout: { ...splitLayout, nodes: { ...splitLayout.nodes, split3: { ...split, sizes: [0.4, 0.4] } } } }],
  ['mismatched split sizes', { minted: 4, layout: { ...splitLayout, nodes: { ...splitLayout.nodes, split3: { ...split, sizes: [0.2, 0.3, 0.5] } } } }],
  ['split as active pane', { minted: 4, layout: { ...splitLayout, activePaneId: 'split3' } }],
  ['floating split', { minted: 4, layout: { ...splitLayout, floats: ['split3'] } }],
  ['float without rectangle', { minted: 3, layout: { ...empty.layout, tabs: { tab2: tab }, floats: ['float3'], nodes: { ...empty.layout.nodes, float3: { ...pane, id: 'float3', host: 'float' } } } }],
  ['empty floating pane', { minted: 3, layout: { ...empty.layout, floats: ['float3'], nodes: { ...empty.layout.nodes, float3: { ...otherPane, id: 'float3', host: 'float', rect: { x: 0, y: 0, width: 100, height: 100 } } } } }],
] as const)('discards %s without affecting another Session', (_name, invalid) => {
  localStorage.setItem(key, JSON.stringify({ bySession: { [session]: invalid } }))
  writeSidebarLayout('other', empty)
  expect(createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' })).create(session).getSnapshot()).toEqual({ bySession: {} })
  expect(localStorage.getItem(key)).toBeNull()
  expect(readSidebarLayout('other')).toEqual(empty)
  expect(new SidebarTabInventory().source.getSnapshot()).toEqual([])
})

it('discards structurally invalid JSON envelopes and keeps an empty saved Session usable', () => {
  for (const raw of ['null', '{"bySession":null}', '{"bySession":[]}']) {
    localStorage.setItem(key, raw)
    expect(readSidebarLayout(session)).toBeUndefined()
    expect(localStorage.getItem(key)).toBeNull()
  }
  localStorage.setItem(key, '{"bySession":{}}')
  expect(readSidebarLayout(session)).toBeUndefined()
})

it('keeps persisted bytes independent of focus history and preserves undo only in the live store', () => {
  const seed = () => ({ kind: 'guide', title: 'Start' })
  const current = createSidebarRightStore(seed).create(session)
  let a = tab.id as Parameters<typeof current.actions.focusTab>[1]
  let b = a
  current.actions.openContent(session, { kind: 'text', contentId: 'file:a', title: 'A' }, (id) => { a = id })
  current.actions.openContent(session, { kind: 'text', contentId: 'file:b', title: 'B' }, (id) => { b = id })
  const before = localStorage.getItem(key)
  for (let i = 0; i < 1000; i++) current.actions.focusTab(session, i % 2 === 0 ? a : b)
  expect(localStorage.getItem(key)).toBe(before)
  current.actions.setMode(session, 'fullscreen')
  expect(current.getSnapshot().bySession[session]!.layout.mode).toBe('fullscreen')
  current.actions.undo(session)
  expect(current.getSnapshot().bySession[session]!.layout.mode).toBe('push')
  const restored = createSidebarRightStore(seed).create(session)
  const saved = restored.getSnapshot()
  expect(saved.bySession[session]!.history).toEqual({ entries: [], cursor: 0 })
  restored.actions.undo(session)
  expect(restored.getSnapshot()).toBe(saved)
})

it('contains inaccessible storage and failed removal while keeping memory state available', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage blocked') })
  expect(readSidebarLayout(session)).toBeUndefined()
  vi.restoreAllMocks()
  localStorage.setItem(key, 'null')
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('Storage blocked') })
  expect(readSidebarLayout(session)).toBeUndefined()
  vi.stubGlobal('localStorage', undefined)
  expect(readSidebarLayout(session)).toBeUndefined()
  expect(() => { writeSidebarLayout(session, empty); clearSidebarLayout(session) }).not.toThrow()
})

it('does not persist a scope until the live store has a surface for it', () => {
  const instance = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' })).create(session)
  instance.store.set({ bySession: {} })
  expect(localStorage.getItem(key)).toBeNull()
  instance.actions.setExpanded(session, true)
  expect(readSidebarLayout(session)?.layout.expanded).toBe(true)
})
