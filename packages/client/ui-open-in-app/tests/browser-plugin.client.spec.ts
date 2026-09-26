// @vitest-environment jsdom
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
/**
 * Browser-half lifecycle over the real SlotRegistry: the dictionary,
 * header-slot, and document-preview path registrations with fiber teardown
 * proving removal (HMR safety) and the injected controller faces.
 */

import type { ShortcutCommand } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { LayoutController, type MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { createLayoutStore } from '@deepseek-ai/dsh-client-ui-layout/src/client/stores.ts'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { apply, inject, type OpenInAppActionInjected, type OpenPathInjected } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'
import { OpenInAppAction } from '../src/client/OpenInAppAction.tsx'
import { OpenPathAction } from '../src/client/OpenPathAction.tsx'
import { OpenPathEmptyAction } from '../src/client/OpenPathEmptyAction.tsx'
import { en, NS, zh } from '../src/client/locales.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

/** The Session Remote slice the path controls call; answers a desktop and acknowledges every gesture. */
const remote = {
  session: {
    workspacePathApplications: vi.fn(async () => ({ ok: true as const, value: [] })),
    canOpenWorkspacePath: vi.fn(async () => ({ ok: true as const, value: true })),
    openWorkspacePath: vi.fn(async () => ({ ok: true as const, value: { opened: true as const } })),
  },
}

/** Boot the browser half over a real slot tree that declares the header list and the document-preview seats. */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
      'sidebar.right.tab.document.actions': { kind: 'list', scope: 'session' },
      'sidebar.right.tab.document.unpreviewable': { kind: 'list', scope: 'session' },
      'deliverables.file.actions': { kind: 'list', scope: 'session' },
      'deliverables.review.file.actions': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
  const list = createSnapshotStore<SessionListState>({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} })
  const commands = new Map<string, ShortcutCommand>()
  const layoutStore = createLayoutStore().create()
  const layout = new LayoutController(layoutStore.actions, id => id === 'plugins', {
    getSnapshot: () => layoutStore.getSnapshot().panelInfo,
    subscribe: listener => layoutStore.subscribe(listener),
  })
  ctx.provide('layout', layout)
  ctx.provide('sessions', { list })
  ctx.provide('shortcuts', { register: (command: ShortcutCommand) => { commands.set(command.id, command); return () => { commands.delete(command.id) } }, catalog: createSnapshotStore([]) })
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('remote', remote as never)
  ctx.provide('remote.session', remote.session as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, list, commands, layout }
}

function headerEntryIds(ctx: Context): (string | undefined)[] {
  return ctx.slots.entries('conversation.session.header.utilities').map(entry => entry.options.id)
}

describe('open-in-app browser half', () => {
  it('refuses absent workspaces and reports failed keyboard launches', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => String(input) === 'open-in-app/apps'
      ? new Response(JSON.stringify({ apps: ['finder'] })) : new Response('failed', { status: 500 })))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { fiber, list, commands } = await bench()
    try {
      const command = commands.get('workspace.openLocal')!
      const context = { region: 'page', modal: null, target: null } as const
      expect(command.resolve(context).status).toBe('blocked')
      const id = 'main' as SessionId
      const row = { id, displayTitle: 'Main', cwd: '/workspace', running: false, blank: false, updatedAt: 0, retainedBy: {} }
      list.set({ ...list.getSnapshot(), ids: [id], byId: { [id]: row } })
      expect(command.resolve(context).status).toBe('blocked')
      list.set({ ...list.getSnapshot(), byId: { [id]: { ...row, retainedBy: { mainView: 1 } } } })
      await vi.waitFor(() => { expect(command.resolve(context).status).toBe('handled') })
      const result = command.resolve(context)
      if (result.status !== 'handled') throw new Error('Expected an available workspace')
      result.run()
      await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith('workspace open rejected:', expect.any(Error)) })
    } finally { await fiber.dispose(); warn.mockRestore() }
  })
  it('captures the main directory and remembered app before dispatch and shares pointer launch occupancy', async () => {
    let finish!: (response: Response) => void
    const fetcher = vi.fn((input: string | URL, _init?: RequestInit) => String(input) === 'open-in-app/apps'
      ? Promise.resolve(new Response(JSON.stringify({ apps: ['finder', 'cursor'] })))
      : new Promise<Response>((resolve) => { finish = resolve }))
    vi.stubGlobal('fetch', fetcher)
    const { ctx, fiber, list, commands } = await bench()
    const id = 'main' as SessionId
    const select = (cwd: string) => { list.set({ ...list.getSnapshot(), ids: [id], byId: {
      [id]: { id, displayTitle: 'Main', cwd, running: false, blank: false, updatedAt: 0, retainedBy: { mainView: 1 } },
    } }) }
    const entry = ctx.slots.entries('conversation.session.header.utilities')[0]
    const face = (entry?.inject as unknown as () => OpenInAppActionInjected)()
    await vi.waitFor(() => { expect(face.hooks.openInAppApps.getSnapshot()).toEqual(['finder', 'cursor']) })
    select('/first')
    face.choose('cursor')
    const command = commands.get('workspace.openLocal')!
    const context = { region: 'page', modal: null, target: null } as const
    const resolution = command.resolve(context)
    select('/second')
    face.choose('finder')
    if (resolution.status !== 'handled') throw new Error('available workspace was blocked')
    resolution.run()
    expect(command.resolve(context).status).toBe('blocked')
    await face.launch('finder', '/second')
    const calls = fetcher.mock.calls.filter(call => call[0] === 'open-in-app/open')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[1]?.body).toBe(JSON.stringify({ app: 'cursor', path: '/first' }))
    finish(new Response('{}'))
    await vi.waitFor(() => { expect(face.hooks.openInAppLaunch.getSnapshot().phase).toBe('idle') })
    await fiber.dispose()
    expect(commands.size).toBe(0)
  })

  it('declares the services it binds', () => {
    expect(inject).toEqual(['sessions', 'slots', 'locale', 'remote', 'remote.session', 'shortcuts', 'layout'])
  })

  it('does not open a retained workspace while a global panel hides the Session header', async () => {
    const fetcher = vi.fn(async (input: string | URL) => new Response(
      String(input) === 'open-in-app/apps' ? JSON.stringify({ apps: ['finder'] }) : '{}',
    ))
    vi.stubGlobal('fetch', fetcher)
    const { ctx, fiber, list, commands, layout } = await bench()
    try {
      const id = 'main' as SessionId
      list.set({ ...list.getSnapshot(), ids: [id], byId: {
        [id]: { id, displayTitle: 'Main', cwd: '/workspace', running: false, blank: false, updatedAt: 0, retainedBy: { mainView: 1 } },
      } })
      const entry = ctx.slots.entries('conversation.session.header.utilities')[0]
      const face = (entry?.inject as unknown as () => OpenInAppActionInjected)()
      await vi.waitFor(() => { expect(face.hooks.openInAppApps.getSnapshot()).toEqual(['finder']) })
      const command = commands.get('workspace.openLocal')!
      const context = { region: 'page', modal: null, target: null } as const
      expect(command.resolve(context).status).toBe('handled')

      layout.selectPanel('plugins' as MainPanelId)
      expect(list.getSnapshot().byId[id]?.retainedBy.mainView).toBe(1)
      expect(command.resolve(context).status).toBe('blocked')
      expect(fetcher.mock.calls.filter(([input]) => input === 'open-in-app/open')).toEqual([])

      layout.selectPanel(null)
      const resolution = command.resolve(context)
      if (resolution.status !== 'handled') throw new Error('visible Session header was blocked')
      resolution.run()
      await vi.waitFor(() => { expect(face.hooks.openInAppLaunch.getSnapshot().phase).toBe('idle') })
      expect(fetcher.mock.calls.filter(([input]) => input === 'open-in-app/open')).toHaveLength(1)
    } finally { await fiber.dispose() }
  })

  it('registers both document-preview path controls behind one desktop answer, and fiber teardown removes them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ apps: [] }), { status: 200 })))
    const { ctx, fiber } = await bench()
    const header = ctx.slots.entries('sidebar.right.tab.document.actions')[0]
    const empty = ctx.slots.entries('sidebar.right.tab.document.unpreviewable')[0]
    expect(header?.component).toBe(OpenPathAction)
    expect(empty?.component).toBe(OpenPathEmptyAction)
    expect(ctx.slots.entries('deliverables.file.actions')).toHaveLength(1)
    expect(header?.options).toMatchObject({ id: 'open-in-app' })
    const face = (header?.inject as unknown as () => OpenPathInjected)()
    const emptyFace = (empty?.inject as unknown as () => OpenPathInjected)()
    expect(emptyFace.hooks.openInAppDesktop).toBe(face.hooks.openInAppDesktop)
    expect(emptyFace.applications).toBe(face.applications)
    expect(face.hooks.openInAppDesktop.getSnapshot()).toBeNull()
    await Promise.all([face.loadDesktop(), emptyFace.loadDesktop()])
    expect(remote.session.canOpenWorkspacePath).toHaveBeenCalledOnce()
    const signal = new AbortController().signal
    await expect(face.applications('/w/clip.mp4', signal)).resolves.toEqual([])
    expect(remote.session.workspacePathApplications).toHaveBeenCalledWith({ path: '/w/clip.mp4' }, signal)
    expect(face.hooks.openInAppDesktop.getSnapshot()).toBe(true)
    expect(await face.openPath('/w/clip.mp4', 'reveal')).toBeNull()
    expect(remote.session.openWorkspacePath).toHaveBeenLastCalledWith({ path: '/w/clip.mp4', action: 'reveal' })
    await fiber.dispose()
    expect(ctx.slots.entries('sidebar.right.tab.document.actions').map(entry => entry.options.id)).not.toContain('open-in-app')
    expect(ctx.slots.entries('sidebar.right.tab.document.unpreviewable').map(entry => entry.options.id)).not.toContain('open-in-app')
    expect(ctx.slots.entries('deliverables.file.actions')).toHaveLength(0)
  })

  it('registers the header split button, and fiber teardown removes it (HMR safety)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ apps: [] }), { status: 200 })))
    const { ctx, fiber } = await bench()
    const entry = ctx.slots.entries('conversation.session.header.utilities')[0]
    expect(entry?.component).toBe(OpenInAppAction)
    expect(entry?.options).toMatchObject({ id: 'open-in-app' })
    await fiber.dispose()
    expect(headerEntryIds(ctx)).not.toContain('open-in-app')
  })

  it('injects the controller face: availability sources, launch carrier, choice, and icon URLs', async () => {
    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      void init
      const url = String(input)
      if (url === 'open-in-app/apps') {
        return new Response(JSON.stringify({ apps: ['finder', 'cursor', 7] }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetcher)
    const { ctx, fiber } = await bench()
    const entry = ctx.slots.entries('conversation.session.header.utilities')[0]
    const injected: Partial<OpenInAppActionInjected> | undefined = entry?.inject?.()
    if (injected?.hooks === undefined || injected.iconUrl === undefined
      || injected.choose === undefined || injected.launch === undefined) {
      throw new Error('expected the injected open-in-app actions')
    }
    const { hooks } = injected

    await vi.waitFor(() => {
      expect(hooks.openInAppApps.getSnapshot()).toEqual(['finder', 'cursor'])
    })
    expect(injected.iconUrl('cursor')).toBe('open-in-app/icon/cursor')

    injected.choose('cursor')
    expect(hooks.openInAppChoice.getSnapshot()).toBe('cursor')

    await injected.launch('cursor', '/w/dir')
    const openCall = fetcher.mock.calls.find(call => call[0] === 'open-in-app/open')
    expect(openCall?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'cursor', path: '/w/dir' }),
    })
    await fiber.dispose()
  })

  it('publishes an empty availability list when the host read fails, and launches reject on HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      if (String(input) === 'open-in-app/apps') throw new Error('down')
      return new Response('', { status: 502 })
    }))
    const { ctx, fiber } = await bench()
    const entry = ctx.slots.entries('conversation.session.header.utilities')[0]
    const injected: Partial<OpenInAppActionInjected> | undefined = entry?.inject?.()
    if (injected?.hooks === undefined || injected.launch === undefined) throw new Error('expected the injected launch action')
    const { hooks } = injected
    await vi.waitFor(() => {
      expect(hooks.openInAppApps.getSnapshot()).toEqual([])
    })
    await expect(injected.launch('finder', '/w/dir')).rejects.toThrow('open failed: HTTP 502')
    await fiber.dispose()
  })

  it('registers both dictionaries under its own namespace and releases them with the fiber', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ apps: [] }), { status: 200 })))
    const { ctx, fiber } = await bench()
    ctx.locale.setLocale('zh')
    const translate = ctx.locale.bind(NS)
    expect(translate('path.more')).toBe(zh['path.more'])
    ctx.locale.setLocale('en')
    expect(translate('path.more')).toBe(en['path.more'])
    await fiber.dispose()
    expect(translate('path.more')).not.toBe(en['path.more'])
  })

  it('keeps the English dictionary key-identical to the Chinese source of truth', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})

describe('ui-open-in-app node half', () => {
  it('the node apply is an inert loader seat', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
