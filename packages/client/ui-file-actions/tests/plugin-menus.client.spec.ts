// @vitest-environment jsdom
/** File-operation contributions survive removal of application-opening providers. */
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { MenuRegistry } from '@deepseek-ai/dsh-client-ui-context-menu/src/client/registry.ts'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { apply } from '../src/client/index.ts'
import type { FileActionSource } from '../src/types.ts'

afterEach(() => { vi.unstubAllGlobals() })

it('contributes file and image operations without open-in-app and withdraws them on unload', async () => {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const { ctx } = runtime
  await runtime.declare({
    'contextMenu.icon': { kind: 'keyed', scope: 'root', inline: true },
  })
  const failure = vi.fn(), notify = vi.fn()
  const registry = new MenuRegistry(failure)
  ctx.provide('contextMenus', { register: registry.register.bind(registry), notify } as never)
  const registerLocale = vi.fn(() => () => {})
  ctx.provide('locale', { register: registerLocale, bind: () => (key: string) => key } as never)
  const readBytes = vi.fn(async () => ({ ok: true as const, value: { data: [1, 2, 3] } }))
  const workspaceFiles = {
    stat: async () => ({ ok: true, value: { absolutePath: '/workspace/image.png' } }),
    readBytes,
  }
  const session = { openWorkspacePath: vi.fn() }
  runtime.remote.provideNamespaces({ workspaceFiles, session })
  const fiber = ctx.plugin({ apply })
  await fiber.await()
  try {
    await vi.waitFor(() => { expect(registerLocale).toHaveBeenCalledOnce() })
    expect(ctx.slots.entries('contextMenu.icon').map(entry => entry.options.key)).toEqual([
      'file-actions.copy', 'file-actions.download', 'file-actions.save',
    ])
    const file = registry.resolve({ kind: 'file', value: { sessionId: SessionId('files'), path: 'image.png' } })
    await file.ready
    expect(file.source.getSnapshot().map(action => action.id)).toEqual([
      'file-actions.file/copyImage', 'file-actions.file/download',
    ])
    expect(file.source.getSnapshot().find(action => action.id.endsWith('/download'))?.disabled).toBe(false)
    const save = vi.spyOn(ctx.fileActions, 'save').mockImplementation(async (source: FileActionSource) => {
      await source.read!(new AbortController().signal)
      return { status: 'requested' }
    })
    const downloading = registry.resolve({ kind: 'file', value: { sessionId: SessionId('files'), path: 'report.txt' } })
    await downloading.ready
    expect(downloading.source.getSnapshot().map(action => action.id)).toEqual(['file-actions.file/download'])
    downloading.select('file-actions.file/download')
    await vi.waitFor(() => { expect(notify).toHaveBeenCalledWith('menu.downloadStarted', true, undefined) })
    expect(save).toHaveBeenCalledOnce()
    expect(readBytes).toHaveBeenCalledWith(SessionId('files'), 'report.txt', {}, expect.any(AbortSignal))
    save.mockRestore()
    const image = registry.resolve({ kind: 'image', value: { url: 'https://example.com/image.png' } })
    await image.ready
    expect(image.source.getSnapshot().map(action => action.id)).toEqual([
      'file-actions.image/copy', 'file-actions.image/download',
    ])
    await fiber.dispose()
    expect(ctx.slots.entries('contextMenu.icon')).toEqual([])
    expect(file.source.getSnapshot()).toEqual([])
    expect(image.source.getSnapshot()).toEqual([])
    file.dispose()
    image.dispose()
    expect(failure).not.toHaveBeenCalled()
  } finally {
    registry.dispose()
    await runtime.dispose()
  }
})
