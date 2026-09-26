import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { DesktopUpdateDialog, UPDATE_DIALOG_IPC } from '../src/update-dialog.ts'
import { DesktopUpdateOverlays } from '../src/update-overlay.ts'
import { resolveDesktopLocale, type DesktopLocale } from '../src/locale.ts'

const fixture = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const windows: FakeWindow[] = []
  class FakeWindow extends EventEmitter {
    destroyed = false
    readonly webContents = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      mainFrame: { url: 'dsh-app://shell/update-dialog.html' },
      setWindowOpenHandler: vi.fn(),
      insertCSS: vi.fn(async () => 'blur'),
      removeInsertedCSS: vi.fn(async () => {}),
    })
    readonly focus = vi.fn()
    readonly show = vi.fn()
    readonly setBounds = vi.fn()
    readonly loadURL = vi.fn(async () => {})
    constructor(readonly options: unknown) { super(); windows.push(this) }
    getContentBounds() { return { x: 10, y: 20, width: 900, height: 650 } }
    isDestroyed() { return this.destroyed }
    isVisible() { return true }
    destroy() { this.destroyed = true; this.emit('closed') }
    setMenu() {}
  }
  return { handlers, windows, FakeWindow }
})
vi.mock('electron', () => ({ BrowserWindow: fixture.FakeWindow, ipcMain: {
  handle: (name: string, fn: (...args: unknown[]) => unknown) => fixture.handlers.set(name, fn),
  removeHandler: (name: string) => fixture.handlers.delete(name),
} }))

let dialogs: DesktopUpdateDialog | undefined
afterEach(() => {
  vi.useRealTimers()
  dialogs?.dispose()
  dialogs = undefined
  for (const window of fixture.windows) if (!window.isDestroyed()) window.destroy()
  fixture.windows.length = 0
  fixture.handlers.clear()
})

function setup(locale: DesktopLocale | (() => DesktopLocale) = resolveDesktopLocale('zh-CN')) {
  const parent = new fixture.FakeWindow({})
  dialogs = new DesktopUpdateDialog('preload-update-dialog.cjs', locale, new DesktopUpdateOverlays())
  const show = (signal?: AbortSignal) => dialogs!.show(parent as unknown as BrowserWindow, {
    message: '下载完成', buttons: ['安装并重启'], cancelId: 1, ...(signal === undefined ? {} : { signal }),
  })
  const invoke = (channel: string, ...args: unknown[]) => {
    const window = fixture.windows.at(-1)!
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    const view = fixture.handlers.get(UPDATE_DIALOG_IPC.status)!(event) as { revision: number }
    return fixture.handlers.get(channel)!(event, ...(channel === UPDATE_DIALOG_IPC.respond ? [view.revision, ...args] : args))
  }
  return { parent, show, invoke }
}

it('accepts only a displayed choice from its own main frame and retains cancellation outside the button list', async () => {
  const f = setup()
  expect(dialogs!.isOpen).toBe(false)
  const pending = f.show()
  expect(dialogs!.isOpen).toBe(true)
  const window = fixture.windows.at(-1)!
  expect(f.invoke(UPDATE_DIALOG_IPC.status)).toMatchObject({ closeLabel: '关闭', buttons: ['安装并重启'], cancelId: 1 })
  const respond = fixture.handlers.get(UPDATE_DIALOG_IPC.respond)!
  expect(() => respond({ sender: {}, senderFrame: window.webContents.mainFrame }, 0)).toThrow(/unowned/)
  expect(() => respond({ sender: window.webContents, senderFrame: { ...window.webContents.mainFrame } }, 0)).toThrow(/unowned/)
  for (const index of [-1, 2, '0', 0.5, NaN]) expect(() => f.invoke(UPDATE_DIALOG_IPC.respond, index)).toThrow(/invalid/)
  f.invoke(UPDATE_DIALOG_IPC.respond, 1)
  expect(await pending).toEqual({ response: 1, checkboxChecked: false })
  expect(dialogs!.isOpen).toBe(false)
  const next = f.show()
  f.invoke(UPDATE_DIALOG_IPC.respond, 0)
  expect((await next).response).toBe(0)
})

it('follows the parent geometry and removes listeners when closed or replaced', async () => {
  const f = setup()
  const first = f.show()
  const window = fixture.windows.at(-1)!
  expect(window.options).toMatchObject({ frame: false, transparent: true, modal: process.platform !== 'darwin', width: 900, height: 650 })
  window.emit('ready-to-show')
  expect(window.show).toHaveBeenCalledOnce()
  f.parent.emit('resize')
  expect(window.setBounds).toHaveBeenCalledWith(f.parent.getContentBounds())
  const next = f.show()
  expect((await first).response).toBe(1)
  expect(f.parent.listenerCount('resize')).toBe(1)
  fixture.windows.at(-1)!.destroy()
  expect((await next).response).toBe(1)
  expect(f.parent.listenerCount('resize')).toBe(0)
  expect(f.parent.listenerCount('move')).toBe(0)
  expect(f.parent.webContents.insertCSS).not.toHaveBeenCalled()
  expect(f.parent.webContents.removeInsertedCSS).not.toHaveBeenCalled()
})

it('cancels on abort, renderer failure, disposal, or an already-closed parent', async () => {
  const f = setup()
  const controller = new AbortController()
  const pending = f.show(controller.signal)
  controller.abort()
  expect((await pending).response).toBe(1)
  expect((await f.show(controller.signal)).response).toBe(1)
  const crashing = f.show()
  fixture.windows.at(-1)!.webContents.emit('render-process-gone')
  expect((await crashing).response).toBe(1)
  const stopping = f.show()
  dialogs!.dispose()
  expect((await stopping).response).toBe(1)
  expect(fixture.handlers.size).toBe(0)
  const count = fixture.windows.length
  expect((await f.show()).response).toBe(1)
  expect(fixture.windows).toHaveLength(count)
  f.parent.destroy()
  expect((await f.show()).response).toBe(1)
})

it('denies navigation away from the owned document', async () => {
  const f = setup()
  const pending = f.show()
  const window = fixture.windows.at(-1)!
  const event = { preventDefault: vi.fn() }
  window.webContents.emit('will-navigate', event, 'https://example.com')
  expect(event.preventDefault).toHaveBeenCalledOnce()
  window.webContents.emit('will-navigate', event, 'dsh-app://shell/update-dialog.html')
  expect(event.preventDefault).toHaveBeenCalledOnce()
  dialogs!.cancel()
  await pending
})

it('supplies localized disclosure copy without putting diagnostics in the ordinary detail', async () => {
  const f = setup()
  const pending = dialogs!.show(f.parent as unknown as BrowserWindow, {
    message: '未能安全停止任务', technicalDetails: 'exit 0; shutdown acknowledged false',
  })
  expect(f.invoke(UPDATE_DIALOG_IPC.status)).toMatchObject({ detail: '',
    technicalDetails: 'exit 0; shutdown acknowledged false', technicalDetailsLabel: '查看技术详情' })
  dialogs!.cancel()
  await pending
})

it('replaces content without releasing the backdrop and rejects a response from the previous prompt', async () => {
  const f = setup()
  const abort = new AbortController()
  const first = f.show(abort.signal)
  const window = fixture.windows.at(-1)!
  const old = f.invoke(UPDATE_DIALOG_IPC.status) as { revision: number }
  const next = f.show()
  expect((await first).response).toBe(1)
  expect(fixture.windows).toHaveLength(2)
  expect(window.loadURL).toHaveBeenCalledOnce()
  expect(window.webContents.send.mock.calls).toEqual([[UPDATE_DIALOG_IPC.changed, f.invoke(UPDATE_DIALOG_IPC.status)]])
  expect(f.parent.webContents.removeInsertedCSS).not.toHaveBeenCalled()
  abort.abort()
  expect(() => fixture.handlers.get(UPDATE_DIALOG_IPC.respond)!({
    sender: window.webContents, senderFrame: window.webContents.mainFrame,
  }, old.revision, 0)).toThrow(/stale/)
  f.invoke(UPDATE_DIALOG_IPC.respond, 0)
  expect((await next).response).toBe(0)
})

it('fades out before releasing the backdrop and cancels pending removal when another prompt opens', async () => {
  vi.useFakeTimers()
  const f = setup()
  const first = f.show()
  const window = fixture.windows.at(-1)!
  dialogs!.cancel()
  await first
  expect(window.isDestroyed()).toBe(false)
  expect(window.webContents.send).toHaveBeenLastCalledWith(UPDATE_DIALOG_IPC.changed, null)
  const next = f.show()
  await vi.advanceTimersByTimeAsync(150)
  expect(window.isDestroyed()).toBe(false)
  dialogs!.cancel()
  await next
  await vi.advanceTimersByTimeAsync(150)
  expect(window.isDestroyed()).toBe(true)
  expect(f.parent.listenerCount('focus')).toBe(0)
  expect(f.parent.webContents.listenerCount('before-input-event')).toBe(0)
})

it.runIf(process.platform === 'darwin')('blocks parent keyboard input and redirects focus without a native sheet', async () => {
  const f = setup()
  const pending = f.show()
  const window = fixture.windows.at(-1)!
  const event = { preventDefault: vi.fn() }
  f.parent.webContents.emit('before-input-event', event)
  expect(event.preventDefault).toHaveBeenCalledOnce()
  f.parent.emit('focus')
  expect(window.focus).toHaveBeenCalledTimes(2)
  dialogs!.dispose()
  await pending
  expect(f.parent.webContents.listenerCount('before-input-event')).toBe(0)
})

it('reads the current locale for each presentation', async () => {
  let locale = resolveDesktopLocale('en')
  const f = setup(() => locale)
  for (const language of ['zh-CN', 'en']) {
    locale = resolveDesktopLocale(language)
    const pending = f.show()
    const window = fixture.windows.at(-1)!
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    expect(fixture.handlers.get(UPDATE_DIALOG_IPC.status)!(event)).toMatchObject({
      locale: locale.id, closeLabel: locale.messages.updateClose,
      technicalDetailsLabel: locale.messages.updateTechnicalDetails,
    })
    dialogs!.cancel()
    await pending
  }
})
