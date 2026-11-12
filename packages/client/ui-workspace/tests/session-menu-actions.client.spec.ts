import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { MenuRegistry } from '@deepseek-ai/dsh-client-ui-context-menu/src/client/registry.ts'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { registerSessionMenus } from '../src/client/session-actions/context-menus.tsx'
import { en, zh } from '../src/client/locales.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import { provideSessionStatus } from './session-status.client.ts'

function bench() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const registry = new MenuRegistry(vi.fn())
  onTestFinished(() => { registry.dispose() })
  ctx.provide('contextMenus', { register: registry.register.bind(registry) } as never)
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  locale.register('workspace', { en, zh }); locale.setLocale('en')
  const list = createSnapshotStore<WorkspaceSnapshot>({
    items: [], pinnedSessionIds: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  })
  ctx.provide('workspaces', { list } as never)
  const status = provideSessionStatus(ctx)
  const permissions = new Map<string, ReturnType<typeof createSnapshotStore<boolean>>>()
  const access = (action: string) => {
    let source = permissions.get(action)
    if (source === undefined) { source = createSnapshotStore(true); permissions.set(action, source) }
    return source
  }
  ctx.provide('remoteAccess', { source: (_kind: string, _id: string, action: string) => access(action) } as never)
  const actions = { pinSession: vi.fn(), unpinSession: vi.fn(), archiveSession: vi.fn(), unarchiveSession: vi.fn(),
    forkSession: vi.fn(), requestSessionRename: vi.fn(), copySessionId: vi.fn(async () => {}), markSession: vi.fn() }
  const fiber = ctx.plugin({ apply: (plugin: Context) => { registerSessionMenus(plugin, actions) } })
  const target = { kind: 'session' as const, value: { sessionId: brandString<SessionId>('background'), displayTitle: 'Background' } }
  const open = () => registry.resolve(target)
  return { ctx, fiber, registry, locale, list, status, access, actions, target, open }
}

it('preserves built-in order, groups, icons, command identities, and captured action targets', async () => {
  const b = bench()
  await b.fiber.await()
  const menu = b.open()
  const views = menu.source.getSnapshot()
  expect(views.map(({ id, label, icon, commandId, separatorBefore, afterContent }) =>
    [id, label, icon !== undefined, commandId, separatorBefore, afterContent])).toEqual([
    ['session.pin/pin', 'Pin session', true, undefined, undefined, undefined],
    ['session.rename/rename', 'Rename', true, 'session.rename', undefined, undefined],
    ['session.read-state/mark', 'Mark as unread', true, 'session.toggleRead', undefined, undefined],
    ['session.fork/fork', 'Fork session', true, 'session.fork', undefined, undefined],
    ['session.id/copy', 'Copy Session ID', true, undefined, true, undefined],
    ['session.archive/archive', 'Archive session', true, 'session.archive', true, true],
  ])
  menu.dispose()
  for (const id of views.map(item => item.id)) b.open().select(id)
  expect(b.actions.pinSession).toHaveBeenCalledWith('background')
  expect(b.actions.requestSessionRename).toHaveBeenCalledWith('background', 'Background')
  expect(b.actions.markSession).toHaveBeenCalledWith('background', true)
  expect(b.actions.forkSession).toHaveBeenCalledWith('background')
  expect(b.actions.copySessionId).toHaveBeenCalledWith('background')
  expect(b.actions.archiveSession).toHaveBeenCalledWith('background')
  const unpin = b.open()
  b.list.set({ ...b.list.getSnapshot(), pinnedSessionIds: [b.target.value.sessionId] })
  expect(unpin.source.getSnapshot()[0]).toMatchObject({ label: 'Unpin session' })
  unpin.select('session.pin/pin')
  expect(b.actions.unpinSession).toHaveBeenCalledWith('background')
  const restore = b.open()
  b.list.set({ ...b.list.getSnapshot(), archivedSessionIds: [b.target.value.sessionId] })
  expect(restore.source.getSnapshot().some(item => item.id === 'session.pin/pin')).toBe(false)
  const archive = restore.source.getSnapshot().at(-1)!
  expect(archive).toMatchObject({ label: 'Unarchive session' })
  expect(archive.commandId).toBeUndefined()
  restore.select(archive.id)
  expect(b.actions.unarchiveSession).toHaveBeenCalledWith('background')
})

it('reacts to permission and locale updates, prevents withdrawn actions, and disposes subscriptions', async () => {
  const b = bench()
  await b.fiber.await()
  const menu = b.open()
  b.access('session/rename').set(false)
  b.access('session/fork').set(false)
  b.access('workspace/archiveSession').set(false)
  b.access('workspace/pinSession').set(false)
  b.access('sessionStatus/mark').set(false)
  expect(menu.source.getSnapshot().map(item => item.id)).toEqual(['session.id/copy'])
  menu.select('session.rename/rename')
  expect(b.actions.requestSessionRename).not.toHaveBeenCalled()
  b.locale.setLocale('zh')
  expect(menu.source.getSnapshot()[0]?.label).toBe('复制 Session ID')
  b.access('session/rename').set(true)
  expect(menu.source.getSnapshot()[0]?.label).toBe('重命名')
  await b.fiber.dispose()
  expect(menu.source.getSnapshot()).toEqual([])
  b.access('session/rename').set(false)
  b.list.set({ ...b.list.getSnapshot(), pinnedSessionIds: [] })
  menu.select('session.id/copy')
  expect(b.actions.copySessionId).not.toHaveBeenCalled()
  expect(menu.source.getSnapshot()).toEqual([])
  menu.dispose()
})

it('updates reading labels and availability while retaining the captured Session', async () => {
  const b = bench()
  await b.fiber.await()
  const menu = b.open()
  const action = () => menu.source.getSnapshot().find(item => item.id === 'session.read-state/mark')
  b.status.readingReady.set(false)
  expect(action()).toMatchObject({ label: 'Mark as unread', disabled: true, icon: { key: 'workspace.markUnread' } })
  menu.select('session.read-state/mark')
  expect(b.actions.markSession).not.toHaveBeenCalled()

  b.status.readingReady.set(true)
  b.status.setUnread(b.target.value.sessionId, true)
  expect(action()).toMatchObject({ label: 'Mark as read', disabled: false, icon: { key: 'workspace.markRead' } })
  menu.select('session.read-state/mark')
  expect(b.actions.markSession).toHaveBeenCalledExactlyOnceWith(b.target.value.sessionId, false)

  const archivedMenu = b.open()
  b.list.set({ ...b.list.getSnapshot(), archivedSessionIds: [b.target.value.sessionId] })
  expect(archivedMenu.source.getSnapshot().some(item => item.id === 'session.read-state/mark')).toBe(false)
  archivedMenu.select('session.read-state/mark')
  expect(b.actions.markSession).toHaveBeenCalledOnce()
  b.list.set({ ...b.list.getSnapshot(), archivedSessionIds: [] })
  expect(archivedMenu.source.getSnapshot().some(item => item.id === 'session.read-state/mark')).toBe(true)
  archivedMenu.dispose()

  const restricted = b.open()
  b.access('sessionStatus/mark').set(false)
  expect(restricted.source.getSnapshot().some(item => item.id === 'session.read-state/mark')).toBe(false)
  restricted.select('session.read-state/mark')
  expect(b.actions.markSession).toHaveBeenCalledOnce()
  restricted.dispose()
})
