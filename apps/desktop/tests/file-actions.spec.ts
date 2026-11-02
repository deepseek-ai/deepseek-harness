/** Native original-byte saves and window-scoped IPC ownership. */
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { installFileActions } from '../src/file-actions.ts'
import { DESKTOP_IPC } from '../src/ipc.ts'

const electron = vi.hoisted(() => ({
  app: { getPath: vi.fn() }, ipcMain: { handle: vi.fn() }, session: { defaultSession: { on: vi.fn() } },
}))
vi.mock('electron', () => electron)
const roots: string[] = []
const owners: EventEmitter[] = []
afterEach(async () => {
  for (const owner of owners.splice(0)) owner.emit('closed')
  vi.useRealTimers(); vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); vi.clearAllMocks(); vi.unstubAllGlobals()
})
async function directory() { const path = await mkdtemp(join(tmpdir(), 'dsh-file-actions-')); roots.push(path); return path }

function harness(root: string) {
  const owner = Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), { downloadURL: vi.fn<(url: string) => void>() }), isDestroyed: () => false,
  })
  owners.push(owner)
  const assertOwner = vi.fn(() => owner as never)
  electron.app.getPath.mockReturnValue(root)
  installFileActions(assertOwner)
  const event = {} as IpcMainInvokeEvent
  const invoke = async (channel: string, value: unknown): Promise<unknown> => {
    const handler = electron.ipcMain.handle.mock.calls.find(([name]) => name === channel)?.[1] as
      (event: IpcMainInvokeEvent, value: unknown) => Promise<unknown>
    return handler(event, value)
  }
  const item = (mime = 'image/gif', url = owner.webContents.downloadURL.mock.lastCall![0]) => {
    let destination = ''
    const download = Object.assign(new EventEmitter(), {
      getURLChain: () => [url],
      getFilename: () => 'original.gif', getMimeType: () => mime, getSavePath: () => destination,
      setSavePath: vi.fn((path: string) => { destination = path }),
      setSaveDialogOptions: vi.fn(), cancel: vi.fn(),
    })
    const willDownload = electron.session.defaultSession.on.mock.calls[0]![1] as
      (event: object, item: object, contents: object) => void
    willDownload({}, download, owner.webContents)
    return download
  }
  const save = async (mode: 'download' | 'saveAs' = 'download') => {
    const pending = invoke(DESKTOP_IPC.fileSave, { url: 'https://images.example/original.gif', name: 'image.gif', mode })
    const download = item()
    if (mode === 'download') await writeFile(download.getSavePath(), new Uint8Array([0, 128, 255]))
    download.emit('done', {}, 'completed')
    return pending
  }
  return { owner, assertOwner, invoke, item, save }
}

it('returns the completed destination and releases download listeners', async () => {
  const root = await directory(), f = harness(root)
  await expect(f.save()).resolves.toEqual({ status: 'saved', path: join(root, 'image.gif') })
  expect(f.owner.listenerCount('closed')).toBe(0)
  expect(f.owner.webContents.listenerCount('did-start-navigation')).toBe(0)
})

it.each(['file:///private/data', 'dsh-app://app/api/private', 'javascript:alert(1)'])('rejects unsupported URL %s', async (url) => {
  const root = await directory(), f = harness(root)
  await expect(f.invoke(DESKTOP_IPC.fileSave, { url, mode: 'download' })).rejects.toThrow('Unsupported')
  expect(await readdir(root)).toEqual([])
})

it('retains original downloads and reserves distinct paths until Chromium finishes', async () => {
  const root = await directory(), f = harness(root)
  await writeFile(join(root, 'image.gif'), 'previous')
  await f.save()
  expect(await readFile(join(root, 'image.gif'), 'utf8')).toBe('previous')
  expect(await readFile(join(root, 'image (1).gif'))).toEqual(Buffer.from([0, 128, 255]))
})

it.each(['cancelled', 'interrupted'] as const)('reports native %s without a completed path', async (state) => {
  const root = await directory(), f = harness(root)
  const pending = f.invoke(DESKTOP_IPC.fileSave, { url: 'https://images.example/a', name: 'wrong.png', mode: 'download' })
  const download = f.item('image/webp')
  expect(download.setSavePath).toHaveBeenCalledWith(join(root, 'wrong.webp'))
  download.emit('done', {}, state)
  if (state === 'cancelled') await expect(pending).resolves.toEqual({ status: 'cancelled' })
  else await expect(pending).rejects.toThrow('interrupted')
  expect(await readdir(root)).toEqual([])
})

it('uses the native save dialog and waits for completion before reporting success', async () => {
  const root = await directory(), f = harness(root)
  const pending = f.invoke(DESKTOP_IPC.fileSave, { url: 'https://images.example/a', name: 'photo.png', mode: 'saveAs' })
  const download = f.item('image/jpeg')
  expect(download.setSavePath).not.toHaveBeenCalled()
  expect(download.setSaveDialogOptions).toHaveBeenCalledWith({ defaultPath: join(root, 'photo.jpg'), properties: ['showOverwriteConfirmation', 'createDirectory'] })
  download.emit('done', {}, 'cancelled')
  await expect(pending).resolves.toEqual({ status: 'cancelled' })
  f.assertOwner.mockImplementation(() => { throw new Error('Rejected owner') })
  await expect(f.invoke(DESKTOP_IPC.fileSave, {})).rejects.toThrow('Rejected owner')
})

it('cancels pending downloads when the owning document changes', async () => {
  const f = harness(await directory())
  const pending = f.invoke(DESKTOP_IPC.fileSave, { url: 'https://images.example/a', mode: 'download' })
  const download = f.item()
  f.owner.webContents.emit('did-start-navigation', {}, 'dsh-app://app/', false, true)
  await expect(pending).resolves.toEqual({ status: 'cancelled' })
  expect(download.cancel).toHaveBeenCalledOnce()
  download.emit('done', {}, 'cancelled')
  expect(f.owner.listenerCount('closed')).toBe(0)
})

it('matches overlapping downloads of the same source to their captured requests', async () => {
  const root = await directory(), f = harness(root)
  const first = f.invoke(DESKTOP_IPC.fileSave, { url: 'https://images.example/a', name: 'first.gif', mode: 'download' })
  const firstUrl = f.owner.webContents.downloadURL.mock.lastCall![0]
  const second = f.invoke(DESKTOP_IPC.fileSave, { url: 'https://images.example/a', name: 'second.gif', mode: 'saveAs' })
  const secondItem = f.item()
  const firstItem = f.item('image/gif', firstUrl)
  expect(firstItem.setSavePath).toHaveBeenCalledWith(join(root, 'first.gif'))
  expect(secondItem.setSaveDialogOptions.mock.lastCall?.[0]).toMatchObject({ defaultPath: join(root, 'second.gif') })
  secondItem.emit('done', {}, 'cancelled')
  firstItem.emit('done', {}, 'completed')
  await expect(first).resolves.toMatchObject({ status: 'saved' })
  await expect(second).resolves.toEqual({ status: 'cancelled' })
})

it('retires timed-out downloads and cancels items arriving after their window closes', async () => {
  vi.useFakeTimers(); vi.stubEnv('DSH_DESKTOP_FILE_DOWNLOAD_TIMEOUT_MS', '1000')
  const root = await directory(), f = harness(root)
  const pending = f.invoke(DESKTOP_IPC.fileSave, { url: 'https://images.example/a', mode: 'download' })
  const rejected = expect(pending).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(1000)
  await rejected
  const download = f.item()
  expect(download.cancel).toHaveBeenCalledOnce()
  download.emit('done', {}, 'cancelled')
  expect(await readdir(root)).toEqual([])
  expect(f.owner.listenerCount('closed')).toBe(0)
  expect(f.owner.webContents.listenerCount('did-start-navigation')).toBe(0)

  const late = f.invoke(DESKTOP_IPC.fileSave, { url: 'https://images.example/a', mode: 'download' })
  f.owner.emit('closed')
  await expect(late).resolves.toEqual({ status: 'cancelled' })
  const stale = f.item()
  expect(stale.cancel).toHaveBeenCalledOnce()
  expect(stale.setSavePath).not.toHaveBeenCalled()
})

it('allows the native save dialog to remain open beyond the download startup deadline', async () => {
  vi.useFakeTimers(); vi.stubEnv('DSH_DESKTOP_FILE_DOWNLOAD_TIMEOUT_MS', '1000')
  const f = harness(await directory())
  const pending = f.invoke(DESKTOP_IPC.fileSave, { url: 'https://images.example/a', mode: 'saveAs' })
  const download = f.item()
  await vi.advanceTimersByTimeAsync(2000)
  expect(download.cancel).not.toHaveBeenCalled()
  download.emit('done', {}, 'completed')
  await expect(pending).resolves.toMatchObject({ status: 'saved' })
})

it('reports a synchronous Chromium launch failure and releases pending listeners', async () => {
  const f = harness(await directory())
  f.owner.webContents.downloadURL.mockImplementation(() => { throw new Error('Download unavailable') })
  await expect(f.invoke(DESKTOP_IPC.fileSave, { url: 'https://images.example/a', mode: 'download' })).rejects.toThrow('Download unavailable')
  expect(f.owner.listenerCount('closed')).toBe(0)
  expect(f.owner.webContents.listenerCount('did-start-navigation')).toBe(0)
})

it('aborts original-image reads on window navigation and releases lifecycle listeners', async () => {
  const f = harness(await directory())
  let signal!: AbortSignal
  vi.stubGlobal('fetch', vi.fn((_url: URL, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    signal = options.signal!
    signal.addEventListener('abort', () => { reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
  })))
  const reading = f.invoke(DESKTOP_IPC.clipboardImageRead, 'https://images.example/original.gif')
  f.owner.webContents.emit('did-start-navigation', {}, 'dsh-app://app/', false, true)
  await expect(reading).rejects.toThrow('Aborted')
  expect(signal.aborted).toBe(true)
  expect(f.owner.listenerCount('closed')).toBe(0)
  expect(f.owner.webContents.listenerCount('did-start-navigation')).toBe(0)
})

it('preserves pending downloads across iframe and same-document navigation', async () => {
  const root = await directory(), f = harness(root)
  const pending = f.invoke(DESKTOP_IPC.fileSave, { url: 'https://images.example/a', mode: 'saveAs' })
  const download = f.item()
  f.owner.webContents.emit('did-start-navigation', {}, 'https://example.org', false, false)
  f.owner.webContents.emit('did-start-navigation', {}, 'dsh-app://app/#tab', true, true)
  download.setSavePath(join(root, 'chosen.gif'))
  download.emit('done', {}, 'completed')
  await expect(pending).resolves.toEqual({ status: 'saved', path: join(root, 'chosen.gif') })
  expect(download.cancel).not.toHaveBeenCalled()
})

it('rejects redirects to the application Host', async () => {
  const root = await directory()
  const owner = Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), { downloadURL: vi.fn<(url: string) => void>() }), isDestroyed: () => false,
  })
  installFileActions(() => owner as never, () => 'http://127.0.0.1:19321')
  const handler = (name: string) => electron.ipcMain.handle.mock.calls.find(([channel]) => channel === name)![1] as
    (event: IpcMainInvokeEvent, value: unknown) => Promise<unknown>
  const fetchImage = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://localhost:19321/api/private' } }))
  vi.stubGlobal('fetch', fetchImage)
  const event = {} as IpcMainInvokeEvent
  await expect(handler(DESKTOP_IPC.clipboardImageRead)(event, 'https://images.example/photo')).rejects.toThrow('Invalid image URL')
  expect(fetchImage).toHaveBeenCalledOnce()
  expect(await readdir(root)).toEqual([])
})
