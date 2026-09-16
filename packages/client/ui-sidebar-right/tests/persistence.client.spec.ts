/** Per-Session layout recovery precedes resource-body rendering. */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { createSidebarRightStore } from '../src/client/stores.ts'
import { createSidebarRightController } from '../src/client/service.ts'
import { SidebarRightTabRegistry } from '../src/client/tab-registry.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function storage() {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  })
  return values
}

const sessionId = 'first' as SessionId
const seed = () => ({ kind: 'guide', title: 'Start' })

it('restores current layout independently by Session with a fresh undo history', () => {
  storage()
  const handle = createSidebarRightStore(seed)
  const first = handle.create(sessionId)
  let file!: TabId
  first.actions.openContent(sessionId, { kind: 'text', contentId: 'file:a', title: 'a' }, (id) => { file = id })
  first.actions.splitPane(sessionId)
  let floating!: TabId
  first.actions.openContent(sessionId, { kind: 'text', contentId: 'file:b', title: 'b' }, (id) => { floating = id })
  first.actions.floatTab(sessionId, floating, { x: 20, y: 30, width: 480, height: 320 })
  const layout = first.getSnapshot().bySession[sessionId]!.layout
  const split = Object.values(layout.nodes).find(node => node.kind === 'split')!
  first.actions.resizeSplit(sessionId, split.id, [0.3, 0.7])
  first.actions.focusTab(sessionId, file)
  first.actions.setMode(sessionId, 'fullscreen')
  const second = handle.create('second')
  second.actions.open('second')
  const saved = first.getSnapshot()
  const restored = createSidebarRightStore(seed).create(sessionId)
  const recovered = { bySession: { [sessionId]: { ...saved.bySession[sessionId], history: { entries: [], cursor: 0 } } } }
  expect(restored.getSnapshot()).toEqual(recovered)
  expect(createSidebarRightStore(seed).create('second').getSnapshot()).toEqual(second.getSnapshot())
  expect(createSidebarRightStore(seed).create('new').getSnapshot()).toEqual({ bySession: {} })
  restored.actions.undo(sessionId)
  restored.actions.redo(sessionId)
  expect(restored.getSnapshot()).toEqual(recovered)
  restored.actions.setExpanded(sessionId, false)
  expect(createSidebarRightStore(seed).create(sessionId).getSnapshot().bySession[sessionId]!.layout.expanded).toBe(false)
  restored.clearPersisted()
  expect(createSidebarRightStore(seed).create(sessionId).getSnapshot()).toEqual({ bySession: {} })
  expect(createSidebarRightStore(seed).create('second').getSnapshot()).toEqual(second.getSnapshot())
})

it('pins restored records during adoption before the first render or store mutation', async () => {
  storage()
  const first = createSidebarRightStore(seed).create(sessionId)
  let file!: TabId
  const address = 'dsh-resource://file/session/first/a.txt'
  first.actions.openContent(sessionId, { kind: 'text', contentId: address, title: 'a' }, (id) => { file = id })
  const ctx = new Context()
  const pin = vi.fn()
  const { controller, adopt } = createSidebarRightController(new SidebarRightTabRegistry(ctx), pin)
  expect(controller.tabsIn(sessionId)).toEqual([])
  const restored = createSidebarRightStore(seed).create(sessionId)
  const release = adopt(sessionId, restored)
  try {
    const occurrence = controller.tabDomain.occurrence(sessionId, { id: file })
    expect(controller.tabsIn(sessionId)).toEqual([{ id: file, kind: 'text', contentId: address, title: 'a' }])
    expect(pin).toHaveBeenCalledWith(address, occurrence.signal)
    expect(occurrence.navigation.getSnapshot().address).toBe(address)
    restored.actions.closeTab(sessionId, file)
    expect(occurrence.signal.aborted).toBe(true)
  } finally {
    release()
    controller.tabDomain.dispose()
    await ctx.fiber.dispose()
  }
})

it('starts from an empty layout when stored JSON is corrupt and keeps working when storage rejects writes', () => {
  const values = storage()
  values.set(`dsh.sidebar-right.v1.${sessionId}`, '{broken')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const instance = createSidebarRightStore(seed).create(sessionId)
  expect(instance.getSnapshot()).toEqual({ bySession: {} })
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('Storage full') })
  instance.actions.setExpanded(sessionId, true)
  expect(instance.getSnapshot().bySession[sessionId]!.layout.expanded).toBe(true)
})
