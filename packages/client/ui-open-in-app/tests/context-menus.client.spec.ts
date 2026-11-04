// @vitest-environment jsdom
import type { FileActionSource } from '@deepseek-ai/dsh-client-ui-file-actions/client'
import { Blob as NodeBlob } from 'node:buffer'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MenuRegistry } from '@deepseek-ai/dsh-client-ui-context-menu/src/client/registry.ts'
import { OpenInAppPathController } from '../src/client/open-path.ts'
import { OpenInAppController } from '../src/client/controller.ts'
import { registerFileMenus } from '@deepseek-ai/dsh-client-ui-file-actions/src/client/context-menus.tsx'
import { registerContextMenus } from '../src/client/context-menus.tsx'

afterEach(() => { vi.unstubAllGlobals() })

it('offers image actions on file targets, copies absolute paths, and keeps save feedback after dismissal', async () => {
  vi.stubGlobal('Blob', NodeBlob)
  const ctx = new Context()
  const notify = vi.fn(), failed = vi.fn()
  const registry = new MenuRegistry(failed)
  const id = SessionId('context-file')
  const save = vi.fn(async (_source: FileActionSource, _mode: 'download' | 'saveAs') => ({ status: 'saved' as const, path: '/downloads/original.svg' }))
  const copy = vi.fn(async () => {})
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ apps: ['finder'] }))))
  const remote = { session: {
    canOpenWorkspacePath: async () => ({ ok: true as const, value: true }),
    workspacePathApplications: async () => ({ ok: true as const, value: [] }),
    openWorkspacePath: async () => ({ ok: true as const, value: undefined }),
  }, workspaceFiles: {
    stat: async () => ({ ok: true as const, value: { absolutePath: '/workspace/original.svg' } }),
    readBytes: async () => ({ ok: true as const, value: { data: [...new TextEncoder().encode('<svg/>')] } }),
  } }
  ctx.provide('remote', remote as never)
  ctx.provide('contextMenus', { register: registry.register.bind(registry), notify } as never)
  ctx.provide('sessions', { list: createSnapshotStore({ byId: { [id]: { cwd: '/workspace' } } }) } as never)
  ctx.provide('fileActions', { save, copyImage: copy, canSaveAs: true } as never)
  const paths = new OpenInAppPathController(remote)
  const directories = new OpenInAppController()
  const fiber = ctx.plugin({ apply: (plugin: Context) => {
    registerContextMenus(plugin, paths, key => key, directories, vi.fn())
    registerFileMenus(plugin, ctx.fileActions, key => key)
  } })
  await fiber.await()
  try {
    const file = { kind: 'file' as const, value: { sessionId: id, path: 'original.svg', line: 42 } }
    const copying = registry.resolve(file)
    await copying.ready
    expect(copying.source.getSnapshot().map(action => action.id)).toEqual([
      'open-in-app.file/sidebar', 'open-in-app.file/float', 'open-in-app.file/reveal', 'open-in-app.file/open',
      'open-in-app.file/copyPath', 'file-actions.file/copyImage', 'file-actions.file/download', 'file-actions.file/saveAs',
    ])
    copying.select('open-in-app.file/copyPath')
    expect(writeText).toHaveBeenCalledWith('/workspace/original.svg')
    const downloading = registry.resolve(file)
    await downloading.ready
    downloading.select('file-actions.file/download')
    downloading.dispose()
    await vi.waitFor(() => { expect(notify).toHaveBeenCalledWith('menu.downloaded', true, expect.objectContaining({ failureLabel: 'path.revealError' })) })
    const source = save.mock.calls[0]?.[0]
    expect(source).toMatchObject({ name: 'original.svg', mediaType: 'image/svg+xml' })
    expect(await (await source!.read!(new AbortController().signal)).text()).toBe('<svg/>')
    const image = registry.resolve({ kind: 'image', value: { url: 'https://example.com/image.png' } })
    await image.ready
    expect(image.source.getSnapshot().find(action => action.id.endsWith('/reveal'))?.disabled).toBe(true)
    image.dispose()
    expect(failed).not.toHaveBeenCalled()
    await fiber.dispose()
    const unloaded = registry.resolve(file)
    await unloaded.ready
    expect(unloaded.source.getSnapshot().filter(action => action.id.startsWith('open-in-app.'))).toEqual([])
    unloaded.dispose()
  } finally { registry.dispose(); await fiber.dispose() }
})
