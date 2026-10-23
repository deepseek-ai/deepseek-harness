import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { DesktopUpdateDialog, UPDATE_DIALOG_IPC, type UpdateDialogOptions } from '../src/update-dialog.ts'
import { DesktopUpdateOverlays } from '../src/update-overlay.ts'
import { resolveDesktopLocale, type DesktopLocale } from '../src/locale.ts'

const fixture = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const views: FakeView[] = []
  const load = { failure: false }
  class FakeParent extends EventEmitter {
    destroyed = false
    readonly focus = vi.fn()
    readonly isFocused = vi.fn(() => true)
    readonly contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
    readonly webContents = Object.assign(new EventEmitter(), { focus: vi.fn() })
    getContentBounds() { return { x: 10, y: 20, width: 900, height: 650 } }
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true; this.emit('closed') }
  }
  class FakeView {
    destroyed = false
    readonly webContents = Object.assign(new EventEmitter(), {
      send: vi.fn(), focus: vi.fn(),
      mainFrame: { url: 'dsh-app://shell/update-dialog.html' },
      setWindowOpenHandler: vi.fn<(handler: () => { action: 'deny' }) => void>(),
      isDestroyed: () => this.destroyed,
      loadURL: vi.fn(async () => { if (load.failure) throw new Error('load failed'); this.webContents.emit('did-finish-load') }),
      close: vi.fn(() => { this.destroyed = true; this.webContents.emit('destroyed') }),
    })
    readonly setBackgroundColor = vi.fn()
    readonly setBounds = vi.fn()
    constructor(readonly options: unknown) { views.push(this) }
  }
  return { handlers, views, FakeParent, FakeView, load }
})
vi.mock('electron', () => ({ WebContentsView: fixture.FakeView, ipcMain: {
  handle: (name: string, fn: (...args: unknown[]) => unknown) => fixture.handlers.set(name, fn),
  removeHandler: (name: string) => fixture.handlers.delete(name),
} }))

let dialogs: DesktopUpdateDialog | undefined
afterEach(() => {
  dialogs?.dispose()
  dialogs = undefined
  vi.useRealTimers()
  fixture.views.length = 0
  fixture.handlers.clear()
  fixture.load.failure = false
  vi.restoreAllMocks()
})

function setup(locale: DesktopLocale | (() => DesktopLocale) = resolveDesktopLocale('zh-CN')) {
  const parent = new fixture.FakeParent()
  const owner = parent as unknown as BrowserWindow
  const overlays = new DesktopUpdateOverlays()
  dialogs = new DesktopUpdateDialog('preload-update-dialog.cjs', locale, overlays)
  const show = (signal?: AbortSignal, options: Partial<UpdateDialogOptions> = {}) => dialogs!.show(owner, {
    message: '下载完成', buttons: ['安装并重启'], cancelId: 1, ...options, ...(signal === undefined ? {} : { signal }),
  })
  const invoke = (channel: string, ...args: unknown[]) => {
    const view = fixture.views.at(-1)!
    const event = { sender: view.webContents, senderFrame: view.webContents.mainFrame }
    const state = fixture.handlers.get(UPDATE_DIALOG_IPC.status)!(event) as { revision: number }
    return fixture.handlers.get(channel)!(event, ...(channel === UPDATE_DIALOG_IPC.respond ? [state.revision, ...args] : args))
  }
  return { parent, owner, show, invoke, overlays }
}

it('accepts only a displayed choice from its isolated shell frame', async () => {
  const f = setup()
  const pending = f.show()
  const view = fixture.views[0]!
  expect(dialogs!.isOpen).toBe(true)
  expect(f.invoke(UPDATE_DIALOG_IPC.status)).toMatchObject({ closeLabel: '关闭', buttons: ['安装并重启'], cancelId: 1 })
  const respond = fixture.handlers.get(UPDATE_DIALOG_IPC.respond)!
  expect(() => respond({ sender: f.parent.webContents, senderFrame: view.webContents.mainFrame }, 0)).toThrow(/unowned/)
  expect(() => respond({ sender: view.webContents, senderFrame: { ...view.webContents.mainFrame } }, 0)).toThrow(/unowned/)
  for (const index of [-1, 2, '0', 0.5, NaN]) expect(() => f.invoke(UPDATE_DIALOG_IPC.respond, index)).toThrow(/invalid/)
  f.invoke(UPDATE_DIALOG_IPC.respond, 1)
  expect(await pending).toEqual({ response: 1, checkboxChecked: false })
  expect(dialogs!.isOpen).toBe(false)
})

it('attaches within its owner and resizes below the Windows caption without a native child window', async () => {
  const f = setup()
  const pending = f.show()
  const view = fixture.views[0]!
  expect(f.parent.contentView.addChildView).toHaveBeenCalledWith(view)
  expect(view.options).toMatchObject({ webPreferences: { preload: 'preload-update-dialog.cjs', sandbox: true, contextIsolation: true } })
  expect(view.setBackgroundColor).toHaveBeenCalledWith('#00000000')
  const top = process.platform === 'win32' ? 40 : 0
  expect(view.setBounds).toHaveBeenCalledWith({ x: 0, y: top, width: 900, height: 650 - top })
  f.parent.emit('resize')
  expect(view.setBounds).toHaveBeenCalledTimes(2)
  f.parent.destroy()
  expect((await pending).response).toBe(1)
  expect(view.webContents.close).toHaveBeenCalledOnce()
  expect(f.parent.listenerCount('resize')).toBe(0)
  expect(f.parent.webContents.listenerCount('before-input-event')).toBe(0)
})

it('updates a background result in the same view without activating its owner', async () => {
  const f = setup()
  f.parent.isFocused.mockReturnValue(false)
  const first = f.show()
  await Promise.resolve()
  const view = fixture.views[0]!
  const old = f.invoke(UPDATE_DIALOG_IPC.status) as { revision: number }
  const next = f.show(undefined, { message: '已是最新版本' })
  expect((await first).response).toBe(1)
  expect(fixture.views).toHaveLength(1)
  expect(f.parent.contentView.addChildView).toHaveBeenCalledOnce()
  expect(view.webContents.loadURL).toHaveBeenCalledOnce()
  expect(f.parent.focus).not.toHaveBeenCalled()
  expect(view.webContents.focus).not.toHaveBeenCalled()
  expect(view.webContents.send).toHaveBeenLastCalledWith(UPDATE_DIALOG_IPC.changed, expect.objectContaining({ message: '已是最新版本' }))
  expect(() => fixture.handlers.get(UPDATE_DIALOG_IPC.respond)!({
    sender: view.webContents, senderFrame: view.webContents.mainFrame,
  }, old.revision, 0)).toThrow(/stale/)
  f.invoke(UPDATE_DIALOG_IPC.respond, 0)
  expect((await next).response).toBe(0)
})

it('releases keyboard blocking only after fade-out and retains it across replacement', async () => {
  vi.useFakeTimers()
  const f = setup()
  expect(f.overlays.input(f.owner)).toEqual({ revision: 0, blocked: false })
  const first = f.show()
  const view = fixture.views[0]!
  expect(f.overlays.input(f.owner)).toEqual({ revision: 1, blocked: true })
  dialogs!.cancel()
  await first
  expect(view.webContents.send).toHaveBeenLastCalledWith(UPDATE_DIALOG_IPC.changed, null)
  const next = f.show()
  await vi.advanceTimersByTimeAsync(150)
  expect(view.destroyed).toBe(false)
  expect(f.overlays.input(f.owner)).toEqual({ revision: 1, blocked: true })
  dialogs!.cancel()
  await next
  await vi.advanceTimersByTimeAsync(150)
  expect(view.destroyed).toBe(true)
  expect(f.parent.contentView.removeChildView).toHaveBeenCalledWith(view)
  expect(f.overlays.input(f.owner)).toEqual({ revision: 2, blocked: false })
})

it('blocks owner input and restores dialog focus only when that owner is focused', async () => {
  const f = setup()
  f.parent.isFocused.mockReturnValue(false)
  const pending = f.show()
  await Promise.resolve()
  const view = fixture.views[0]!
  const event = { preventDefault: vi.fn() }
  f.parent.webContents.emit('before-input-event', event)
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(view.webContents.focus).not.toHaveBeenCalled()
  f.parent.isFocused.mockReturnValue(true)
  f.parent.emit('focus')
  expect(view.webContents.focus).toHaveBeenCalledOnce()
  dialogs!.focus()
  expect(f.parent.focus).toHaveBeenCalledOnce()
  dialogs!.dispose()
  await pending
  expect(f.parent.listenerCount('focus')).toBe(0)
})

it('cancels on abort, renderer failure, failed load, disposal, or a destroyed owner', async () => {
  const f = setup()
  const abort = new AbortController()
  const pending = f.show(abort.signal)
  abort.abort()
  expect((await pending).response).toBe(1)
  expect((await f.show(abort.signal)).response).toBe(1)
  const crashing = f.show()
  fixture.views.at(-1)!.webContents.emit('render-process-gone')
  expect((await crashing).response).toBe(1)
  fixture.load.failure = true
  expect((await f.show()).response).toBe(1)
  fixture.load.failure = false
  const stopping = f.show()
  dialogs!.dispose()
  expect((await stopping).response).toBe(1)
  expect(fixture.handlers.size).toBe(0)
  expect((await f.show()).response).toBe(1)
  f.parent.destroy()
  expect((await f.show()).response).toBe(1)
})

it('denies foreign navigation, redirects, and new windows', async () => {
  const f = setup()
  const pending = f.show()
  const contents = fixture.views[0]!.webContents
  const event = { preventDefault: vi.fn() }
  contents.emit('will-navigate', event, 'https://example.com')
  contents.emit('will-navigate', event, 'dsh-app://shell/update-dialog.html')
  expect(event.preventDefault).toHaveBeenCalledOnce()
  contents.emit('will-redirect', event)
  expect(event.preventDefault).toHaveBeenCalledTimes(2)
  expect(contents.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({ action: 'deny' })
  dialogs!.cancel()
  await pending
})

it('reads the current locale and keeps technical diagnostics separate from ordinary detail', async () => {
  let locale = resolveDesktopLocale('en')
  const f = setup(() => locale)
  for (const language of ['zh-CN', 'en']) {
    locale = resolveDesktopLocale(language)
    const pending = f.show(undefined, { technicalDetails: 'exit 0; shutdown acknowledged false' })
    expect(f.invoke(UPDATE_DIALOG_IPC.status)).toMatchObject({ locale: locale.id, closeLabel: locale.messages.updateClose,
      detail: '', technicalDetails: 'exit 0; shutdown acknowledged false', technicalDetailsLabel: locale.messages.updateTechnicalDetails })
    dialogs!.cancel()
    await pending
  }
})
