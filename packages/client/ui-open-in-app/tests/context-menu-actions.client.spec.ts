// @vitest-environment jsdom
/** Original-byte actions and feedback survive the menu that initiated them. */
import { Blob as NodeBlob } from 'node:buffer'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MenuRegistry } from '@deepseek-ai/dsh-client-ui-context-menu/src/client/registry.ts'
import type { ContextMenus, ContextMenuTarget } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionWorkspacePathApplication } from '@deepseek-ai/dsh-api-session-controller/types'
import type { FileActionSource, FileSaveResult } from '@deepseek-ai/dsh-client-ui-file-actions/client'
import { OpenInAppPathController } from '../src/client/open-path.ts'
import { OpenInAppController } from '../src/client/controller.ts'
import { registerFileMenus } from '@deepseek-ai/dsh-client-ui-file-actions/src/client/context-menus.tsx'
import { registerContextMenus } from '../src/client/context-menus.tsx'
import type { OpenInAppToastSource } from '../src/client/open-toast.tsx'

const sessionId = SessionId('menu-actions')
type Applications = readonly SessionWorkspacePathApplication[]
/** Let settled Remote answers finish their queued continuations. */
const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function boot() {
  vi.stubGlobal('Blob', NodeBlob)
  const ctx = new Context()
  const notify = vi.fn<ContextMenus['notify']>(), failure = vi.fn(), writeText = vi.fn(async () => {})
  const report = vi.fn<OpenInAppToastSource['report']>()
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const registry = new MenuRegistry(failure)
  const remote = {
    session: {
      canOpenWorkspacePath: vi.fn(async () => ({ ok: true as const, value: true })),
      workspacePathApplications: vi.fn(async (_request: { path: string }, _signal?: AbortSignal): Promise<RemoteResult<Applications>> => ({
        ok: true, value: [{ id: 'preview', name: 'Preview', default: true, icon: 'data:image/png;base64,a' }],
      })),
      openWorkspacePath: vi.fn(async () => ({ ok: true as const, value: undefined })),
    },
    workspaceFiles: {
      stat: vi.fn(async (_sessionId: SessionId, path: string) => ({ ok: true as const, value: { absolutePath: path.startsWith('/') ? path : `/workspace/${path}` } })),
      readBytes: vi.fn(async () => ({ ok: true as const, value: { data: [...new TextEncoder().encode('<svg/>')] } })),
    },
  }
  const save = vi.fn<(source: FileActionSource, mode: 'download' | 'saveAs') => Promise<FileSaveResult>>()
    .mockResolvedValue({ status: 'saved', path: '/downloads/file.svg' })
  const copyImage = vi.fn<(source: FileActionSource) => Promise<void>>().mockResolvedValue()
  const fileActions = { save, copyImage, canSaveAs: true }
  const sessions = createSnapshotStore({ byId: { [sessionId]: { cwd: '/workspace' } } })
  const sidebar = { openResourceIn: vi.fn(), openTabIn: vi.fn() }
  const browserTab = vi.fn(() => ({}))
  const directoryFetch = vi.fn(async () => new Response(JSON.stringify({ apps: ['vscode', 'finder'] })))
  const directories = new OpenInAppController(directoryFetch)
  const paths = new OpenInAppPathController(remote)
  ctx.provide('remote', remote as never)
  ctx.provide('contextMenus', { register: registry.register.bind(registry), notify } as never)
  ctx.provide('sessions', { list: sessions } as never)
  ctx.provide('fileActions', fileActions as never)
  ctx.provide('sidebarRight', sidebar as never)
  ctx.provide('sidebarRightTabs', { get: browserTab } as never)
  const fiber = ctx.plugin({ apply: (plugin: Context) => {
    registerContextMenus(plugin, paths, key => key, directories, report)
    registerFileMenus(plugin, ctx.fileActions, key => key)
  } })
  await fiber.await()
  onTestFinished(async () => { registry.dispose(); await ctx.fiber.dispose() })
  const resolve = async (target: ContextMenuTarget) => {
    const menu = registry.resolve(target)
    await menu.ready
    return menu
  }
  const choose = async (target: ContextMenuTarget, id: string) => {
    const menu = await resolve(target)
    const action = menu.source.getSnapshot().find(item => item.id === id)
    expect(action?.disabled).not.toBe(true)
    expect(action).toBeDefined()
    menu.select(id)
    menu.dispose()
    await vi.waitFor(() => { expect(save.mock.settledResults.every(result => result.type !== 'incomplete')).toBe(true) })
    return action
  }
  return { registry, resolve, choose, remote, fileActions, paths, directories, directoryFetch, sessions,
    sidebar, browserTab, notify, failure, writeText, report }
}

it('routes file actions through an explicit host, the line, native association and original bytes', async () => {
  const h = await boot()
  // A menu raised inside a floating panel names that panel; the open names a host instead, never a pane.
  const file = { kind: 'file', value: { sessionId, path: 'file.svg', paneId: 'float7' as never, line: 24 } } as const
  const first = await h.resolve(file)
  const items = () => first.source.getSnapshot().filter(item => item.id.startsWith('open-in-app.file/'))
  await vi.waitFor(() => { expect(items().find(item => item.id === 'open-in-app.file/open')?.label).toBe('open.title') })
  expect(items().map(item => [item.id, item.label, item.icon?.key])).toEqual([
    ['open-in-app.file/sidebar', 'menu.openInSidebar', 'open-in-app.sidebar'],
    ['open-in-app.file/float', 'menu.openInFloat', 'open-in-app.float'],
    ['open-in-app.file/reveal', 'menu.reveal', 'open-in-app.reveal'],
    ['open-in-app.file/open', 'open.title', 'open-in-app.application'],
    ['open-in-app.file/copyPath', 'menu.copyPath', 'open-in-app.copy'],
  ])
  first.dispose()
  await h.choose(file, 'open-in-app.file/sidebar')
  expect(h.sidebar.openResourceIn).toHaveBeenLastCalledWith(sessionId, expect.stringContaining('file.svg'),
    { destination: 'sidebar', params: { line: 24 } })
  await h.choose(file, 'open-in-app.file/float')
  expect(h.sidebar.openResourceIn).toHaveBeenLastCalledWith(sessionId, expect.stringContaining('file.svg'),
    { destination: 'float', params: { line: 24 } })
  const opened = await h.choose(file, 'open-in-app.file/open')
  expect(opened?.icon).toEqual({ key: 'open-in-app.application', src: 'data:image/png;base64,a' })
  expect(h.remote.session.openWorkspacePath).toHaveBeenCalledWith({ path: '/workspace/file.svg', application: 'preview' })
  await vi.waitFor(() => { expect(h.report).toHaveBeenLastCalledWith({ kind: 'opened' }) })
  await h.choose(file, 'open-in-app.file/reveal')
  expect(h.remote.session.openWorkspacePath).toHaveBeenCalledWith({ path: '/workspace/file.svg', action: 'reveal' })
  await vi.waitFor(() => { expect(h.report).toHaveBeenLastCalledWith({ kind: 'revealed' }) })
  await h.choose(file, 'file-actions.file/copyImage')
  await vi.waitFor(() => { expect(h.notify).toHaveBeenCalledWith('menu.copied', true) })
  const source = h.fileActions.copyImage.mock.calls[0]![0]
  expect(await (await source.read!(new AbortController().signal)).text()).toBe('<svg/>')
  h.remote.workspaceFiles.readBytes.mockResolvedValueOnce({ ok: false } as never)
  await expect(source.read!(new AbortController().signal)).rejects.toThrow('Original file unavailable')
  await h.choose(file, 'file-actions.file/saveAs')
  await vi.waitFor(() => { expect(h.notify).toHaveBeenCalledWith('menu.saved', true, expect.objectContaining({ label: 'menu.reveal' })) })
  const simple = { kind: 'file', value: { sessionId: SessionId('absent'), path: '/file.unknown' } } as const
  h.remote.session.workspacePathApplications.mockResolvedValueOnce({ ok: true, value: [] })
  const menu = await h.resolve(simple)
  // The Host's empty answer arrives within the first-answer wait, so the row opens disabled.
  await vi.waitFor(() => { expect(menu.source.getSnapshot().find(item => item.id.endsWith('/open'))?.disabled).toBe(true) })
  expect(menu.source.getSnapshot().some(item => item.id.endsWith('/copyImage'))).toBe(false)
  expect(menu.source.getSnapshot().filter(item => item.id.startsWith('file-actions.')).map(item => item.id))
    .toEqual(['file-actions.file/saveAs'])
  menu.select('open-in-app.file/sidebar')
  expect(h.sidebar.openResourceIn).toHaveBeenLastCalledWith(SessionId('absent'), expect.any(String), { destination: 'sidebar' })
  h.remote.session.workspacePathApplications.mockResolvedValueOnce({ ok: true, value: [] })
  const floating = await h.resolve(simple)
  expect(floating.source.getSnapshot().find(item => item.id.endsWith('/open'))?.disabled).toBe(true)
  floating.select('open-in-app.file/float')
  expect(h.sidebar.openResourceIn).toHaveBeenLastCalledWith(SessionId('absent'), expect.any(String), { destination: 'float' })
})

it('names the application when the first answer of a file type arrives within the wait', async () => {
  const h = await boot()
  // The answer arrives a macrotask later, after a resolution that did not wait would have published its rows.
  h.remote.session.workspacePathApplications.mockImplementationOnce(() => new Promise((answer) => {
    setTimeout(() => { answer({ ok: true, value: [{ id: 'preview', name: 'Preview', default: true, icon: null }] }) }, 10)
  }))
  const menu = h.registry.resolve({ kind: 'file', value: { sessionId, path: 'notes.txt' } })
  const labels: (string | undefined)[] = []
  const stop = menu.source.subscribe(() => {
    labels.push(menu.source.getSnapshot().find(item => item.id === 'open-in-app.file/open')?.label)
  })
  await menu.ready
  stop()
  expect(labels.filter(label => label !== undefined)).toEqual(['open.title'])
  menu.dispose()
})

it('waits for the first answer of a file type at most 300 ms, and a dismissal ends the wait', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  onTestFinished(() => { vi.useRealTimers() })
  const h = await boot()
  h.remote.session.workspacePathApplications.mockImplementation(() => new Promise(() => {}))
  const menu = h.registry.resolve({ kind: 'file', value: { sessionId, path: 'notes.txt' } })
  let ready = false
  void menu.ready.then(() => { ready = true })
  await vi.advanceTimersByTimeAsync(299)
  expect(ready).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(ready).toBe(true)
  expect(menu.source.getSnapshot().find(item => item.id === 'open-in-app.file/open')).toMatchObject({ label: 'menu.defaultApp', disabled: false })
  menu.dispose()
  const dismissed = h.registry.resolve({ kind: 'file', value: { sessionId, path: 'todo.md' } })
  await vi.advanceTimersByTimeAsync(100)
  expect(vi.getTimerCount()).toBe(1)
  dismissed.dispose()
  await dismissed.ready
  expect(vi.getTimerCount()).toBe(0)
  expect(h.failure).not.toHaveBeenCalled()
})

it('opens file menus after the first-answer wait and changes only the application row in place', async () => {
  const h = await boot()
  const answers: ((answer: RemoteResult<Applications>) => void)[] = []
  h.remote.session.workspacePathApplications.mockImplementation(() => new Promise((answer) => { answers.push(answer) }))
  const file = { kind: 'file', value: { sessionId, path: 'notes.txt' } } as const
  const menu = await h.resolve(file)
  const rows = () => menu.source.getSnapshot().filter(item => item.id.startsWith('open-in-app.file/'))
  const application = () => rows().find(item => item.id === 'open-in-app.file/open')
  expect(answers).toHaveLength(1)
  expect(application()).toMatchObject({ label: 'menu.defaultApp', disabled: false })
  expect(application()?.icon).toEqual({ key: 'open-in-app.application' })
  const published: number[] = []
  const stop = menu.source.subscribe(() => { published.push(rows().length) })
  answers[0]!({ ok: true, value: [
    { id: '/Applications/TextEdit.app', name: 'TextEdit', default: false, icon: null },
    { id: '/Applications/Sublime Text.app', name: 'Sublime Text', default: true, icon: 'data:image/png;base64,c3Vi' },
  ] })
  await vi.waitFor(() => { expect(application()).toMatchObject({ label: 'open.title', icon: { src: 'data:image/png;base64,c3Vi' } }) })
  stop()
  expect(published.length).toBeGreaterThan(0)
  expect(published.every(count => count === 5)).toBe(true)
  menu.select('open-in-app.file/open')
  await vi.waitFor(() => {
    expect(h.remote.session.openWorkspacePath).toHaveBeenLastCalledWith({ path: '/workspace/notes.txt', application: '/Applications/Sublime Text.app' })
  })
  // Another file of the same type shows the recorded answer at once and asks the Host again.
  const other = await h.resolve({ kind: 'file', value: { sessionId, path: 'todo.txt' } })
  const otherApplication = () => other.source.getSnapshot().find(item => item.id === 'open-in-app.file/open')
  expect(otherApplication()?.label).toBe('open.title')
  expect(answers).toHaveLength(2)
  answers[1]!({ ok: true, value: [] })
  await vi.waitFor(() => { expect(otherApplication()).toMatchObject({ label: 'menu.defaultApp', disabled: true }) })
  other.dispose()
  expect(h.failure).not.toHaveBeenCalled()
})

it('opens through the OS association until the Host first answers, including after failed queries', async () => {
  const h = await boot()
  let refuse = () => {}
  h.remote.session.workspacePathApplications.mockImplementationOnce(() => new Promise((answer) => {
    refuse = () => { answer({ ok: false } as never) }
  }))
  const menu = await h.resolve({ kind: 'file', value: { sessionId, path: 'notes.md' } })
  const application = () => menu.source.getSnapshot().find(item => item.id === 'open-in-app.file/open')
  expect(application()).toMatchObject({ label: 'menu.defaultApp', disabled: false })
  refuse()
  await settle()
  expect(h.paths.cachedApplications('/workspace/notes.md')).toBeUndefined()
  expect(application()).toMatchObject({ label: 'menu.defaultApp', disabled: false })
  menu.select('open-in-app.file/open')
  await vi.waitFor(() => { expect(h.remote.session.openWorkspacePath).toHaveBeenLastCalledWith({ path: '/workspace/notes.md' }) })
  await vi.waitFor(() => { expect(h.report).toHaveBeenLastCalledWith({ kind: 'opened' }) })
})

it('verifies a file menu once when answers for other files arrive during verification', async () => {
  const h = await boot()
  let release = () => {}
  const verifying = new Promise<void>((resolve) => { release = resolve })
  h.remote.workspaceFiles.stat.mockImplementation(async (_sessionId: SessionId, path: string) => {
    await verifying
    return { ok: true as const, value: { absolutePath: `/workspace/${path}` } }
  })
  const menu = h.registry.resolve({ kind: 'file', value: { sessionId, path: 'notes.txt' } })
  await h.paths.applications('/workspace/other.md', new AbortController().signal)
  expect(h.paths.cachedApplications('/workspace/other.md')).toHaveLength(1)
  release()
  await menu.ready
  expect(h.remote.workspaceFiles.stat).toHaveBeenCalledTimes(2)
  await vi.waitFor(() => { expect(menu.source.getSnapshot().find(item => item.id === 'open-in-app.file/open')?.label).toBe('open.title') })
  expect(h.remote.workspaceFiles.stat).toHaveBeenCalledTimes(2)
  menu.dispose()
})

it('verifies every opening of a file target, whatever order the registry observes and resolves in', async () => {
  const register = vi.spyOn(MenuRegistry.prototype, 'register')
  const h = await boot()
  const contribution = register.mock.calls.map(([input]) => input).find(input => input.id === 'open-in-app.file')!
  const target = { sessionId, path: 'notes.txt' }
  // Resolving without observing first, as a registry that subscribes after its first resolution would.
  await contribution.resolve(target, new AbortController().signal)
  await contribution.resolve(target, new AbortController().signal)
  expect(h.remote.workspaceFiles.stat).toHaveBeenCalledTimes(2)
})

it('re-resolves an open file menu only when its own file type answers differently', async () => {
  const h = await boot()
  const menu = await h.resolve({ kind: 'file', value: { sessionId, path: 'notes.txt' } })
  await vi.waitFor(() => { expect(menu.source.getSnapshot().find(item => item.id === 'open-in-app.file/open')?.label).toBe('open.title') })
  const shown = menu.source.getSnapshot()
  await h.paths.applications('/workspace/other.md', new AbortController().signal)
  expect(h.paths.cachedApplications('/workspace/other.md')).toHaveLength(1)
  expect(menu.source.getSnapshot()).toBe(shown)
  h.remote.session.workspacePathApplications.mockResolvedValueOnce({ ok: true, value: [] })
  await h.paths.applications('/workspace/todo.txt', new AbortController().signal)
  const changed = menu.source.getSnapshot()
  expect(changed.find(item => item.id === 'open-in-app.file/open')).toMatchObject({ label: 'menu.defaultApp', disabled: true })
  h.remote.session.workspacePathApplications.mockResolvedValueOnce({ ok: true, value: [] })
  await h.paths.applications('/workspace/other.md', new AbortController().signal)
  expect(menu.source.getSnapshot()).toBe(changed)
  menu.dispose()
})

it('keeps copy-path available on failed metadata and reports native action failures', async () => {
  const h = await boot()
  const file = { kind: 'file', value: { sessionId, path: 'file.svg' } } as const
  h.remote.workspaceFiles.stat.mockResolvedValueOnce({ ok: false } as never).mockResolvedValueOnce({ ok: false } as never)
  const menu = await h.resolve(file)
  expect(menu.source.getSnapshot().find(item => item.id.endsWith('/saveAs'))?.disabled).toBe(true)
  menu.select('open-in-app.file/copyPath')
  expect(h.writeText).toHaveBeenCalledWith('/workspace/file.svg')
  h.remote.workspaceFiles.stat.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'))
  expect((await h.resolve(file)).source.getSnapshot().find(item => item.id.endsWith('/sidebar'))?.disabled).toBe(true)
  h.remote.session.openWorkspacePath.mockResolvedValueOnce({ ok: false } as never)
  await h.choose(file, 'open-in-app.file/reveal')
  await vi.waitFor(() => { expect(h.report).toHaveBeenLastCalledWith({ kind: 'failed', failure: 'revealError' }) })
  await vi.waitFor(() => { expect(h.paths.cachedApplications('/workspace/file.svg')).toHaveLength(1) })
  // A failed query keeps the recorded answer.
  h.remote.session.workspacePathApplications.mockResolvedValueOnce({ ok: false } as never)
  const kept = await h.resolve(file)
  await vi.waitFor(() => {
    expect(h.remote.session.workspacePathApplications.mock.settledResults.every(result => result.type !== 'incomplete')).toBe(true)
  })
  await settle()
  expect(h.paths.cachedApplications('/workspace/file.svg')).toHaveLength(1)
  expect(kept.source.getSnapshot().find(item => item.id.endsWith('/open'))).toMatchObject({ label: 'open.title', disabled: false })
  kept.dispose()
  h.paths.desktop.set(false)
  h.fileActions.canSaveAs = false
  const queried = h.remote.session.workspacePathApplications.mock.calls.length
  const web = await h.resolve(file)
  expect(web.source.getSnapshot().some(item => item.id.endsWith('/saveAs'))).toBe(false)
  expect(web.source.getSnapshot().filter(item => ['/open', '/reveal'].some(suffix => item.id.endsWith(suffix)))
    .every(item => item.disabled)).toBe(true)
  expect(h.remote.session.workspacePathApplications).toHaveBeenCalledTimes(queried)
})

it('opens links in the registered browser, externally, and on the clipboard', async () => {
  const h = await boot()
  const target = { kind: 'url', value: { sessionId, url: 'https://example.com/page' } } as const
  expect((await h.resolve(target)).source.getSnapshot().find(item => item.id === 'open-in-app.url/sidebar')?.label).toBe('menu.openInSidebar')
  await h.choose(target, 'open-in-app.url/sidebar')
  expect(h.sidebar.openTabIn).toHaveBeenCalledWith(sessionId, 'browser', { params: { url: target.value.url } })
  const external = vi.spyOn(window, 'open').mockReturnValue(null)
  await h.choose(target, 'open-in-app.url/external')
  expect(external).toHaveBeenCalledWith(target.value.url, '_blank', 'noopener,noreferrer')
  await h.choose(target, 'open-in-app.url/copy')
  expect(h.writeText).toHaveBeenCalledWith(target.value.url)
  h.browserTab.mockReturnValueOnce(undefined as never)
  expect((await h.resolve(target)).source.getSnapshot()[0]?.disabled).toBe(true)
})

it('distinguishes completed, requested and cancelled saves and surfaces rejected saves', async () => {
  const h = await boot()
  const image = { kind: 'image', value: { url: 'https://example.com/original' } } as const
  for (const [status, notice] of [['saved', 'menu.downloaded'], ['requested', 'menu.downloadStarted'], ['cancelled', undefined]] as const) {
    h.fileActions.save.mockResolvedValueOnce(status === 'saved' ? { status, path: '/downloads/file.png' } : { status })
    h.notify.mockClear()
    await h.choose(image, 'file-actions.image/download')
    if (notice === undefined) expect(h.notify).not.toHaveBeenCalled()
    else await vi.waitFor(() => { expect(h.notify).toHaveBeenCalledWith(notice, true,
      status === 'saved' ? expect.objectContaining({ label: 'menu.reveal' }) : undefined) })
  }
  h.fileActions.save.mockRejectedValueOnce(new Error('disk full'))
  await h.choose(image, 'file-actions.image/saveAs')
  await vi.waitFor(() => { expect(h.failure).toHaveBeenCalledWith('menu.saveFailed') })
})

it('uses original image reads and keeps menu reveal on the original after saving elsewhere', async () => {
  const h = await boot()
  const local = { kind: 'image', value: { sessionId, path: 'file.svg', url: 'https://example.com/file', mediaType: 'image/svg+xml' } } as const
  await h.choose(local, 'file-actions.image/copy')
  const source = h.fileActions.copyImage.mock.calls[0]![0]
  expect(source.name).toBe('file.svg')
  expect((await source.read!(new AbortController().signal)).type).toBe('image/svg+xml')
  h.remote.workspaceFiles.readBytes.mockResolvedValueOnce({ ok: false } as never)
  await expect(source.read!(new AbortController().signal)).rejects.toThrow('Original image unavailable')
  await h.choose(local, 'open-in-app.image/reveal')
  expect(h.remote.session.openWorkspacePath).toHaveBeenCalledWith({ path: '/workspace/file.svg', action: 'reveal' })
  await h.choose(local, 'file-actions.image/saveAs')
  const menu = await h.resolve(local)
  expect(menu.source.getSnapshot().filter(item => item.id.endsWith('/reveal'))).toMatchObject([
    { id: 'open-in-app.image/reveal', disabled: false },
  ])
  menu.select('open-in-app.image/reveal')
  await vi.waitFor(() => { expect(h.remote.session.openWorkspacePath).toHaveBeenLastCalledWith({ path: '/workspace/file.svg', action: 'reveal' }) })
  const unknown = { kind: 'image', value: { sessionId, path: 'file.unknown', url: 'data:image/png;base64,eA==' } } as const
  await h.choose(unknown, 'file-actions.image/saveAs')
  expect((await h.fileActions.save.mock.calls.at(-1)![0].read!(new AbortController().signal)).type).toBe('')
  h.fileActions.canSaveAs = false
  const remote = await h.resolve({ kind: 'image', value: { url: 'https://example.com/file.png' } })
  expect(remote.source.getSnapshot().some(item => item.id.endsWith('/saveAs'))).toBe(false)
  expect(remote.source.getSnapshot().filter(item => item.id.endsWith('/reveal')).every(item => item.disabled)).toBe(true)
})

it.each(['darwin', 'win32'])('captures each completed destination in its %s toast action', async (platform) => {
  const h = await boot()
  const previous = document.documentElement.getAttribute('data-platform')
  document.documentElement.setAttribute('data-platform', platform)
  onTestFinished(() => {
    if (previous === null) document.documentElement.removeAttribute('data-platform')
    else document.documentElement.setAttribute('data-platform', previous)
  })
  const image = { kind: 'image', value: { url: 'https://example.com/original.png' } } as const
  const actions: NonNullable<Parameters<ContextMenus['notify']>[2]>[] = []
  for (const [mode, path] of [['download', '/downloads/original.png'], ['saveAs', '/elsewhere/renamed.png']] as const) {
    h.fileActions.save.mockResolvedValueOnce({ status: 'saved', path })
    await h.choose(image, `file-actions.image/${mode}`)
    const action = h.notify.mock.lastCall![2]!
    expect(action.label).toBe(platform === 'darwin' ? 'menu.finder' : 'menu.reveal')
    actions.push(action)
  }
  await actions[0]!.run()
  expect(h.remote.session.openWorkspacePath).toHaveBeenLastCalledWith({ path: '/downloads/original.png', action: 'reveal' }, expect.any(AbortSignal))
  await actions[1]!.run()
  expect(h.remote.session.openWorkspacePath).toHaveBeenLastCalledWith({ path: '/elsewhere/renamed.png', action: 'reveal' }, expect.any(AbortSignal))
  expect((await h.resolve(image)).source.getSnapshot().filter(item => item.id.endsWith('/reveal'))).toMatchObject([
    { id: 'open-in-app.image/reveal', disabled: true },
  ])
  h.remote.session.openWorkspacePath.mockResolvedValueOnce({ ok: false } as never)
  await expect(actions[1]!.run()).rejects.toThrow('File location unavailable')
  expect(actions[1]!.failureLabel).toBe('path.revealError')
})

it('offers only folder reveal and path copy, retaining the captured directory', async () => {
  const h = await boot()
  const target = { kind: 'directory', value: { sessionId, path: 'src' } } as const
  const menu = await h.resolve(target)
  expect(menu.source.getSnapshot().map(item => item.id)).toEqual(['open-in-app.directory/reveal', 'open-in-app.directory/copyPath'])
  expect(h.remote.workspaceFiles.stat).not.toHaveBeenCalled()
  h.sessions.set({ byId: { [sessionId]: { cwd: '/changed' } } })
  menu.select('open-in-app.directory/reveal')
  await vi.waitFor(() => { expect(h.remote.session.openWorkspacePath).toHaveBeenCalledWith({ path: '/workspace/src', action: 'reveal' }) })
  h.sessions.set({ byId: { [sessionId]: { cwd: '/workspace' } } })
  await h.choose(target, 'open-in-app.directory/copyPath')
  expect(h.writeText).toHaveBeenLastCalledWith('/workspace/src')
  h.paths.desktop.set(false)
  const unavailable = await h.resolve(target)
  expect(unavailable.source.getSnapshot()[0]?.disabled).toBe(true)
  expect(unavailable.source.getSnapshot()[1]?.disabled).not.toBe(true)
  await h.choose({ kind: 'directory', value: { sessionId: SessionId('absent'), path: '/absolute' } }, 'open-in-app.directory/copyPath')
  expect(h.writeText).toHaveBeenLastCalledWith('/absolute')
})

it('opens the captured Workspace through the directory app catalog and reports launch failure', async () => {
  const h = await boot()
  const target: ContextMenuTarget = { kind: 'workspace', value: { workspaceId: 'workspace' as never, path: '/workspace', displayTitle: 'Workspace' } }
  await h.choose(target, 'open-in-app.workspace/reveal')
  expect(h.directoryFetch).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ body: JSON.stringify({ app: 'finder', path: '/workspace' }) }))
  await vi.waitFor(() => { expect(h.report).toHaveBeenLastCalledWith({ kind: 'opened' }) })
  h.directoryFetch.mockResolvedValueOnce(new Response('', { status: 500 }))
  await h.choose(target, 'open-in-app.workspace/reveal')
  await vi.waitFor(() => { expect(h.report).toHaveBeenLastCalledWith({ kind: 'failed', failure: 'revealError' }) })
  h.directories.apps.set([])
  expect((await h.resolve(target)).source.getSnapshot()[0]?.disabled).toBe(true)
})
