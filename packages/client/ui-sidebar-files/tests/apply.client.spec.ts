/**
 * The plugin's registrations, and their removal when the plugin goes.
 *
 * The registry is real, because "registered" means what it says a type is; the
 * slot, locale, and Remote faces are recorders, because what matters here is
 * what was handed to them — the navigator and toggle Factories,
 * and the page body under the type's id, all over one store and one face per
 * store instance — and that every registration is gone after dispose, which is
 * what makes a reload safe.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ShortcutCommand } from '@deepseek-ai/dsh-client-shortcuts/client'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import type { PaneId, TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { FILES_ID, FILES_KIND } from '../src/client/definition.tsx'
import type { FilesInjected } from '../src/client/face.ts'
import { apply, inject } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'
import { FileTree } from '../src/client/FileTree.tsx'
import { FileNavigator } from '../src/client/FileNavigator.tsx'
import { FilesBody } from '../src/client/FilesBody.tsx'
import { FilesTitle } from '../src/client/FilesTitle.tsx'
import { NavigatorToggle } from '../src/client/NavigatorToggle.tsx'
import { en, ja, zh, es, fr, de, ru, pt } from '../src/client/locales.ts'
import type { createFilesStore } from '../src/client/store.ts'

interface Recorded {
  name: string
  key: string
  scope: string
  locale: string
  store: ReturnType<typeof createFilesStore> | undefined
  inject: ((sessionId: SessionId, actions: object) => object) | undefined
  component: unknown
}

const SESSION = 'files-session' as SessionId
const PANE = 'pane-1' as PaneId

async function boot() {
  const ctx = new Context()
  ctx.provide('contextMenus', { open: vi.fn() } as never)
  const tabs = new SidebarRightTabRegistry(ctx)
  const registered: Recorded[] = []
  const slots = {
    inject: vi.fn((_name: string, register: () => () => void) => register()),
    register: vi.fn((options: Omit<Recorded, 'component'>, component: unknown) => {
      const entry: Recorded = { ...options, component }
      registered.push(entry)
      return () => { registered.splice(registered.indexOf(entry), 1) }
    }),
    registerFactory: vi.fn((options: Omit<Recorded, 'component'>, component: unknown) => {
      const entry: Recorded = { ...options, component }
      registered.push(entry)
      return () => { registered.splice(registered.indexOf(entry), 1) }
    }),
  }
  const dictionaries = new Map<string, unknown>()
  const locale = {
    // Copy is the dictionary's contract; the key stands in for the translation.
    bind: vi.fn(() => (key: string) => key),
    register: vi.fn((ns: string, dicts: unknown) => {
      dictionaries.set(ns, dicts)
      return () => { dictionaries.delete(ns) }
    }),
  }
  const workspaceFiles = { list: vi.fn() }
  const navigation = createSnapshotStore({ address: 'sidebar://files', params: undefined, revision: 0 })
  const source = {
    getSnapshot: () => navigation.getSnapshot(),
    subscribe: vi.fn((listener: () => void) => vi.fn(navigation.subscribe(listener))),
  }
  const sidebar = {
    tabDomain: { occurrence: vi.fn(() => ({ navigation: source })) },
    commandTarget: vi.fn(), openTabFromTarget: vi.fn(),
    isExpanded: vi.fn(() => true), toggleExpanded: vi.fn(),
  }
  const commands: ShortcutCommand[] = []
  ctx.provide('shortcuts', { register: (command: ShortcutCommand) => {
    commands.push(command)
    return () => { commands.splice(commands.indexOf(command), 1) }
  } } as never)
  ctx.provide('sidebarRight', sidebar as never)
  ctx.provide('sidebarRightTabs', tabs as never)
  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale as never)
  ctx.provide('remote', { workspaceFiles } as never)
  ctx.provide('remote.workspaceFiles', workspaceFiles as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, tabs, registered, dictionaries, fiber, sidebar, commands, slots, navigation, source }
}

/** Run the files command for one target. */
function run(h: Awaited<ReturnType<typeof boot>>, target: object): void {
  h.sidebar.commandTarget.mockReturnValue(target)
  const result = h.commands[0]!.resolve({ region: 'page', modal: null, target: null })
  if (result.status !== 'handled') throw new Error('Expected files command to be available')
  result.run()
}

describe('ui-sidebar-files apply', () => {
  it('opens files for the command target and refuses without a selected Session', async () => {
    const h = await boot()
    try {
      const input = { region: 'page', modal: null, target: null } as const
      expect(h.commands[0]!.resolve(input)).toEqual({ status: 'blocked', reason: 'shortcut.noSession' })
      expect(h.commands[0]!.label()).toBe('guide.title')
      const target = { sessionId: SESSION, paneId: PANE, host: 'float' }
      run(h, target)
      expect(h.sidebar.openTabFromTarget).toHaveBeenCalledWith('files', target)
    } finally { await h.fiber.dispose() }
    expect(h.commands).toEqual([])
  })

  it('shows and focuses the tree of the docked tab the face is placed beside, and elsewhere opens the page, whose tree always shows', async () => {
    const h = await boot()
    try {
      const page = h.registered.find(entry => entry.name === 'sidebar.right.pane.tab')!
      const instance = page.store!.create(SESSION)
      const face = page.inject!(SESSION, instance.actions) as FilesInjected
      const focus = vi.spyOn(face, 'focus')
      const tab = new AbortController()
      face.attach(PANE, 'tab-1' as TabId, tab.signal)
      // A tab with no navigator placed beside it, as when the Session has no working directory, leaves the command to the page.
      run(h, { sessionId: SESSION, paneId: PANE, host: 'dock', tabId: 'tab-1' })
      expect(h.sidebar.openTabFromTarget).toHaveBeenCalledTimes(1)
      expect(focus).not.toHaveBeenCalled()
      h.sidebar.openTabFromTarget.mockClear()
      face.placeBeside('tab-1' as TabId)
      h.sidebar.isExpanded.mockReturnValue(false)
      run(h, { sessionId: SESSION, paneId: PANE, host: 'dock', tabId: 'tab-1' })
      expect(h.sidebar.openTabFromTarget).not.toHaveBeenCalled()
      expect(h.sidebar.toggleExpanded).toHaveBeenCalledTimes(1)
      expect(focus.mock.calls).toEqual([[PANE]])
      expect(instance.getSnapshot().byPane[PANE]?.open).toBe(true)

      h.sidebar.isExpanded.mockReturnValue(true)
      run(h, { sessionId: SESSION, paneId: PANE, host: 'dock', tabId: 'tab-1' })
      expect(h.sidebar.toggleExpanded).toHaveBeenCalledTimes(1)
      expect(focus).toHaveBeenCalledTimes(2)

      // A tab without the navigator beside it, the page itself, a floating tab, or another Session goes through the page open,
      // which writes no shown choice: the page's tree always shows.
      for (const target of [
        { sessionId: SESSION, paneId: PANE, host: 'dock', tabId: 'tab-2' },
        { sessionId: SESSION, paneId: PANE, host: 'dock', tabId: undefined },
        { sessionId: SESSION, paneId: 'float-1', host: 'float', tabId: 'tab-1' },
        { sessionId: 'other' as SessionId, paneId: PANE, host: 'dock', tabId: 'tab-1' },
      ]) {
        run(h, target)
        expect(h.sidebar.openTabFromTarget).toHaveBeenLastCalledWith('files', target)
      }
      expect(focus).toHaveBeenCalledTimes(2)
    } finally { await h.fiber.dispose() }
  })

  it('finds a tab\'s face while any of its placements remains, and the latest face placed for the tab', async () => {
    const h = await boot()
    try {
      const page = h.registered.find(entry => entry.name === 'sidebar.right.pane.tab')!
      const instance = page.store!.create(SESSION)
      const face = page.inject!(SESSION, instance.actions) as FilesInjected
      const focus = vi.spyOn(face, 'focus')
      const target = { sessionId: SESSION, paneId: PANE, host: 'dock', tabId: 'tab-1' }
      face.attach(PANE, 'tab-1' as TabId, new AbortController().signal)
      // The tab's loading drawing and its loaded drawing each place the face; the first going leaves the second.
      const loading = face.placeBeside('tab-1' as TabId)
      const loaded = face.placeBeside('tab-1' as TabId)
      const sibling = face.placeBeside('tab-2' as TabId)
      loading()
      loading()
      run(h, target)
      expect(focus).toHaveBeenCalledTimes(1)
      // Once the last placement goes, the command opens the page.
      loaded()
      run(h, target)
      expect(h.sidebar.openTabFromTarget).toHaveBeenLastCalledWith('files', target)
      expect(focus).toHaveBeenCalledTimes(1)
      sibling()
      run(h, { ...target, tabId: 'tab-2' })
      expect(h.sidebar.openTabFromTarget).toHaveBeenLastCalledWith('files', { ...target, tabId: 'tab-2' })
      // A newer instance for the Session placed beside the same tab takes it over, and the older face's release leaves it.
      const older = face.placeBeside('tab-1' as TabId)
      const next = page.store!.create(SESSION)
      const nextFace = page.inject!(SESSION, next.actions) as FilesInjected
      const nextFocus = vi.spyOn(nextFace, 'focus')
      nextFace.attach(PANE, 'tab-1' as TabId, new AbortController().signal)
      nextFace.placeBeside('tab-1' as TabId)
      older()
      run(h, target)
      expect(nextFocus).toHaveBeenCalledWith(PANE)
      expect(focus).toHaveBeenCalledTimes(1)
    } finally { await h.fiber.dispose() }
  })

  it('serves every occurrence of one store instance with one face, and only instances its store minted', async () => {
    const h = await boot()
    try {
      const factory = h.registered.find(entry => entry.name === 'sidebar.files.navigator')!
      const page = h.registered.find(entry => entry.name === 'sidebar.right.pane.tab')!
      const one = factory.store!.create(SESSION)
      const two = factory.store!.create('other')
      expect(factory.inject!(SESSION, one.actions)).toBe(page.inject!(SESSION, one.actions))
      expect(factory.inject!('other' as SessionId, two.actions)).not.toBe(factory.inject!(SESSION, one.actions))
      expect(factory.store!.create(undefined).getSnapshot()).toEqual({ byPane: {} })
      expect(() => factory.inject!(SESSION, {})).toThrow('Session "files-session" has no files store instance')
    } finally { await h.fiber.dispose() }
  })
  it('releases navigation subscriptions when the tab closes or the files plugin unloads', async () => {
    const h = await boot()
    const factory = h.registered.find(entry => entry.name === 'sidebar.files.navigator')!
    const instance = factory.store!.create(SESSION)
    const face = factory.inject!(SESSION, instance.actions) as FilesInjected
    const first = new AbortController()
    const second = new AbortController()
    face.attach(PANE, 'first' as TabId, first.signal)
    face.attach(PANE, 'second' as TabId, second.signal)
    expect(h.sidebar.tabDomain.occurrence.mock.calls).toEqual([[SESSION, { id: 'first' }], [SESSION, { id: 'second' }]])
    expect(h.source.subscribe).toHaveBeenCalledTimes(2)
    const unsubscribers = h.source.subscribe.mock.results.map((result) => {
      if (result.type !== 'return') throw new Error('Expected navigation subscription to return a disposer')
      return result.value
    })
    h.navigation.set({ address: 'sidebar://files', params: undefined, revision: 1 })
    first.abort()
    expect(unsubscribers[0]).toHaveBeenCalledOnce()
    await h.fiber.dispose()
    expect(unsubscribers[1]).toHaveBeenCalledOnce()
    second.abort()
    expect(unsubscribers[1]).toHaveBeenCalledOnce()
  })

  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('registers the type, its dictionaries, and the body and title seats under the type\'s id', async () => {
    const { tabs, registered, dictionaries, fiber, slots } = await boot()
    onTestFinished(() => fiber.dispose())
    const definition = tabs.get(FILES_KIND)
    expect(definition?.id).toBe(FILES_ID)
    expect(definition?.priority).toBe('builtin')
    expect(definition?.title('sidebar://files')).toBe('type.label')
    expect(definition?.guide?.map(entry => [entry.order, entry.title(), entry.description?.()]))
      .toEqual([[10, 'guide.title', 'guide.description']])
    expect(dictionaries.get('sidebarFiles')).toEqual({ zh, en, ja, es, fr, de, ru, pt })
    // The seat key is the implementation's id, not the kind: an extension may
    // take the kind over, and the seat must still find this body.
    expect(registered.map(entry => [entry.name, entry.key, entry.locale])).toEqual([
      ['sidebar.files.tree', undefined, 'sidebarFiles'],
      ['sidebar.files.navigator', undefined, 'sidebarFiles'],
      ['sidebar.files.navigator.toggle', undefined, 'sidebarFiles'],
      ['sidebar.right.pane.tab', FILES_ID, 'sidebarFiles'],
      ['sidebar.right.pane.tab.title', FILES_ID, undefined],
    ])
    expect(slots.registerFactory.mock.calls.map(([options]) => [options.name, options.scope]))
      .toEqual([['sidebar.files.tree', 'root'], ['sidebar.files.navigator', 'session'], ['sidebar.files.navigator.toggle', 'session']])
    const [tree, factory, toggle, body, title] = registered
    expect([factory?.component, toggle?.component, body?.component, title?.component])
      .toEqual([FileNavigator, NavigatorToggle, FilesBody, FilesTitle])
    expect(tree?.component).toBe(FileTree)
    expect(slots.registerFactory.mock.calls[0]?.[0]).toMatchObject({ slots: { accessory: { scope: 'root' } } })
    // One store handle for the Factory, the toggle and the page.
    expect(toggle?.store).toBe(factory?.store)
    expect(toggle?.inject).toBe(factory?.inject)
    expect(body?.store).toBe(factory?.store)
    expect(body?.inject).toBe(factory?.inject)
  })

  it('takes every registration back when the plugin is disposed', async () => {
    const { tabs, registered, dictionaries, fiber } = await boot()
    expect(registered.some(entry => entry.name === 'sidebar.files.tree')).toBe(true)
    await fiber.dispose()
    expect(registered.some(entry => entry.name === 'sidebar.files.tree')).toBe(false)
    expect(tabs.get(FILES_KIND)).toBeUndefined()
    expect(registered).toEqual([])
    expect(dictionaries.size).toBe(0)
  })
})


it('carries the file tree path and pane into its menu gesture', async () => {
  const h = await boot()
  try {

  } finally { await h.fiber.dispose() }
})
