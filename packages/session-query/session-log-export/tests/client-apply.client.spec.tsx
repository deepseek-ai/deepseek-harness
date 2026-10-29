import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { MenuRegistry } from '@deepseek-ai/dsh-client-ui-context-menu/src/client/registry.ts'
import type { ContextMenuTarget } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SessionMarkdownCopyToast } from '../src/client/CopyToast.tsx'
import type { SessionMarkdownCopyToastInjected } from '../src/client/CopyToast.tsx'
import { SessionLogDownloadHeaderAction } from '../src/client/HeaderAction.tsx'
import { apply, inject } from '../src/client/index.ts'
import type { SessionLogDownloadHeaderInjected } from '../src/client/HeaderAction.tsx'

const SID = 'session-export-apply' as SessionId

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
      'shell.overlay': { kind: 'list', scope: 'root' },
      'contextMenu.icon': { kind: 'keyed', scope: 'root', inline: true },
    },
  } as never, () => null)
}

function injectedOf(entry: { inject?: ((...args: never[]) => object) | undefined } | undefined): object {
  if (entry?.inject === undefined) throw new Error('slot entry has no injection')
  return entry.inject()
}

async function bench() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const declaration = declare(slots)
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.locale.setLocale('en')
  const failed = vi.fn(), registry = new MenuRegistry(failed)
  onTestFinished(() => { registry.dispose() })
  const active = createSnapshotStore<ContextMenuTarget | null>(null)
  const open = vi.fn((target: ContextMenuTarget) => { active.set(target) })
  const close = vi.fn(() => { active.set(null) })
  ctx.provide('contextMenus', { active, open, close, register: registry.register.bind(registry) } as never)
  const menu = () => registry.resolve({ kind: 'sessionHeader', value: { sessionId: SID } })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, slots, declaration, fiber, registry, menu, active, open, close, failed }
}

describe('session-log-download browser plugin', () => {
  it('follows feedback plugin availability without adding Header actions to Session context menus', async () => {
    const b = await bench()
    const menu = b.menu()
    expect(menu.source.getSnapshot().map(row => row.label)).toEqual(['Copy Session as Markdown', 'Download session log'])
    const openSession = vi.fn()
    const feedback = b.ctx.plugin((ctx) => { ctx.provide('feedbackUi', { openSession }) })
    await feedback.await()
    await vi.waitFor(() => { expect(menu.source.getSnapshot().map(row => row.label)).toEqual(['Copy Session as Markdown', 'Download session log', 'Feedback']) })
    b.menu().select('session-log-download.feedback/feedback')
    expect(openSession).toHaveBeenCalledWith(SID)
    await feedback.dispose()
    await vi.waitFor(() => { expect(menu.source.getSnapshot()).toHaveLength(2) })
    const session = b.registry.resolve({ kind: 'session', value: { sessionId: SID, displayTitle: 'Captured' } })
    expect(session.source.getSnapshot()).toEqual([])
    const reloaded = b.ctx.plugin((ctx) => { ctx.provide('feedbackUi', { openSession }) })
    await reloaded.await()
    await vi.waitFor(() => { expect(menu.source.getSnapshot()).toHaveLength(3) })
    b.menu().select('session-log-download.feedback/feedback')
    expect(openSession).toHaveBeenCalledTimes(2)
    await b.fiber.dispose()
    expect(menu.source.getSnapshot()).toEqual([])
  })

  it('toggles only its captured Header menu and replaces an unrelated target', async () => {
    const b = await bench()
    const face = injectedOf(b.slots.entries('conversation.session.header.utilities')[0]) as SessionLogDownloadHeaderInjected
    const point = { x: 20, y: 30 }
    face.openMenu(SID, point)
    expect(b.open).toHaveBeenCalledExactlyOnceWith({ kind: 'sessionHeader', value: { sessionId: SID } }, point)
    face.openMenu(SID, point)
    expect(b.close).toHaveBeenCalledOnce()
    b.active.set({ kind: 'session', value: { sessionId: SID, displayTitle: 'Same' } })
    face.openMenu(SID, point)
    expect(b.open).toHaveBeenCalledTimes(2)
    face.openMenu('another' as SessionId, point)
    expect(b.active.getSnapshot()).toEqual({ kind: 'sessionHeader', value: { sessionId: 'another' } })
  })

  it('dismisses the same Header menu after its button anchor moves more than four pixels', async () => {
    const b = await bench()
    const face = injectedOf(b.slots.entries('conversation.session.header.utilities')[0]) as SessionLogDownloadHeaderInjected
    face.openMenu(SID, { x: 20, y: 30 })
    const moved = { x: 120, y: 80 }
    face.openMenu(SID, moved)
    expect(b.close).toHaveBeenCalledOnce()
    expect(b.open).toHaveBeenCalledOnce()
    expect(b.active.getSnapshot()).toBeNull()
    face.openMenu(SID, moved)
    expect(b.open).toHaveBeenLastCalledWith({ kind: 'sessionHeader', value: { sessionId: SID } }, moved)
  })

  it('provides one controller and removes its Header and overlay contributions on disposal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    const b = await bench()
    expect(inject).toEqual(['slots', 'locale', 'contextMenus'])
    expect(b.ctx.sessionLogDownload).toBeDefined()
    expect(b.slots.entries('conversation.session.header.actions')).toHaveLength(0)
    const entry = b.slots.entries('conversation.session.header.utilities')[0]
    expect(entry?.component).toBe(SessionLogDownloadHeaderAction)
    expect(entry?.options).toMatchObject({ id: 'session-log-download' })
    const injected = injectedOf(entry) as SessionLogDownloadHeaderInjected
    await injected.request(SID)
    expect(b.ctx.sessionLogDownload.store.getSnapshot().bySession[SID]?.status).toBe('error')
    injected.dismiss(SID)
    expect(b.ctx.sessionLogDownload.store.getSnapshot().bySession[SID]?.open).toBe(false)

    const overlay = b.slots.entries('shell.overlay')[0]
    expect(overlay?.component).toBe(SessionMarkdownCopyToast)
    expect(overlay?.options).toMatchObject({ id: 'session-log-download.copy-toast' })
    const overlayInjected = injectedOf(overlay) as SessionMarkdownCopyToastInjected
    b.menu().select('session-log-download.export/copy')
    await vi.waitFor(() => { expect(injected.hooks.sessionMarkdownCopy.getSnapshot().notice?.kind).toBe('preparationFailed') })
    overlayInjected.dismiss()
    expect(injected.hooks.sessionMarkdownCopy.getSnapshot().notice).toBeNull()

    const retained = b.menu()
    await b.fiber.dispose()
    expect(retained.source.getSnapshot()).toEqual([])
    expect(b.menu().source.getSnapshot()).toEqual([])
    expect(b.slots.entries('contextMenu.icon')).toHaveLength(0)
    expect(b.slots.entries('conversation.session.header.utilities')).toHaveLength(0)
    expect(b.slots.entries('shell.overlay')).toHaveLength(0)
  })

  it('updates only occupied export rows and keeps feedback available during downloads and copy', async () => {
    const download = Promise.withResolvers<Response>(), copy = Promise.withResolvers<Response>()
    const fetcher = vi.fn((input: string | URL) => String(input).includes('session.markdown') ? copy.promise : download.promise)
    vi.stubGlobal('fetch', fetcher)
    const b = await bench()
    const feedback = b.ctx.plugin((ctx) => { ctx.provide('feedbackUi', { openSession: vi.fn() }) })
    await feedback.await()
    const menu = b.menu()
    b.menu().select('session-log-download.export/download')
    expect(menu.source.getSnapshot().map(row => [row.label, row.disabled === true])).toEqual([
      ['Copy Session as Markdown', false], ['Download session log', true], ['Feedback', false],
    ])
    b.menu().select('session-log-download.export/download')
    expect(fetcher).toHaveBeenCalledOnce()
    b.menu().select('session-log-download.export/copy')
    expect(menu.source.getSnapshot().map(row => row.disabled === true)).toEqual([true, true, false])
    b.menu().select('session-log-download.export/copy')
    expect(fetcher).toHaveBeenCalledTimes(2)
    download.resolve(new Response('', { status: 500 }))
    copy.resolve(new Response('', { status: 500 }))
    await vi.waitFor(() => { expect(menu.source.getSnapshot().every(row => !row.disabled)).toBe(true) })
    expect(b.ctx.sessionLogDownload.store.getSnapshot().bySession[SID]).toMatchObject({ open: true, status: 'error' })
    const face = injectedOf(b.slots.entries('conversation.session.header.utilities')[0]) as SessionLogDownloadHeaderInjected
    expect(face.hooks.sessionMarkdownCopy.getSnapshot().notice?.kind).toBe('preparationFailed')
    expect(b.failed).not.toHaveBeenCalled()
    b.ctx.locale.setLocale('zh')
    expect(menu.source.getSnapshot()[0]?.label).not.toBe('Copy Session as Markdown')
  })

  it('downloads only for an export execution acknowledged by this browser client', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 500 }))
    vi.stubGlobal('fetch', fetcher)
    const first = await bench()
    const second = await bench()

    first.ctx.emit('command/executed', SID, 'plan', { kind: 'success' })
    expect(fetcher).not.toHaveBeenCalled()
    first.ctx.emit('command/executed', SID, 'export', { kind: 'error', text: 'bad path' })
    expect(fetcher).not.toHaveBeenCalled()
    first.ctx.emit('command/executed', SID, 'export', { kind: 'success' })
    await vi.waitFor(() => {
      expect(fetcher).toHaveBeenCalledOnce()
      expect(first.ctx.sessionLogDownload.store.getSnapshot().bySession[SID]?.status).toBe('error')
    })
    expect(second.ctx.sessionLogDownload.store.getSnapshot().bySession[SID]).toBeUndefined()

    await first.fiber.dispose()
    await second.fiber.dispose()
  })

  it('re-registers after the declaring Header slot collapses and returns', async () => {
    const b = await bench()
    b.declaration()
    expect(b.slots.entries('conversation.session.header.utilities')).toHaveLength(0)
    expect(b.slots.entries('shell.overlay')).toHaveLength(0)
    const redeclare = declare(b.slots)
    await Promise.resolve()
    expect(b.slots.entries('conversation.session.header.utilities')[0]?.component).toBe(SessionLogDownloadHeaderAction)
    expect(b.slots.entries('shell.overlay')[0]?.component).toBe(SessionMarkdownCopyToast)
    redeclare()
    await b.fiber.dispose()
  })
})
