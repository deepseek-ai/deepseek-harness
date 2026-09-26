// @vitest-environment jsdom
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import type { BrowserWindow, WebContents, WebFrameMain } from 'electron'
import type { DesktopShortcutInput, ShortcutBinding, ShortcutCommandId, ShortcutConfigSnapshot,
  ShortcutDefinition, ShortcutSaveResult } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import { ShortcutRegistry } from '@deepseek-ai/dsh-client-shortcuts/src/client/registry.ts'
import { installKeyboard } from '@deepseek-ai/dsh-client-shortcuts/src/client/dom.ts'
import { installNativeKeyboard } from '@deepseek-ai/dsh-client-shortcuts/src/client/native.ts'
import type { DesktopBrowserLeaseId, DesktopBrowserReservation } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DESKTOP_IPC } from '../src/ipc.ts'

const ipc = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }))
const overlays = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  class Window extends EventEmitter {
    private destroyed = false
    readonly webContents = { setWindowOpenHandler: vi.fn() }
    readonly focus = vi.fn()
    readonly show = vi.fn()
    readonly setBounds = vi.fn()
    setMenu() {}
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true; this.emit('closed') }
  }
  return { Window }
})
vi.mock('electron', () => ({ ipcMain: ipc, BrowserWindow: overlays.Window, app: { isPackaged: true }, session: { fromPartition: () => ({
  setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn(),
  setDisplayMediaRequestHandler: vi.fn(), on: vi.fn(), webRequest: { onBeforeRequest: vi.fn() },
}) } }))
const { installDesktopShortcuts } = await import('../src/keyboard.ts')
const { DesktopBrowserGuests } = await import('../src/browser-guests.ts')
const { DesktopUpdateOverlays } = await import('../src/update-overlay.ts')
afterEach(() => { vi.clearAllMocks() })

type FrameFixture = { url: WebFrameMain['url']; name: WebFrameMain['name']; parent: FrameFixture | null }
type ContentsFixture = EventEmitter & Pick<WebContents,
  'isDestroyed' | 'isFocused' | 'send' | 'setIgnoreMenuShortcuts' | 'focus' | 'sendInputEvent'> & {
    mainFrame: FrameFixture
    focusedFrame: FrameFixture | null
  }
type WindowFixture = EventEmitter & Pick<BrowserWindow, 'isDestroyed' | 'isFocused' | 'isEnabled' | 'close'> & {
  webContents: ContentsFixture
}
type InvokeFixture = { sender: object; senderFrame: object | null }
type KeyboardFixture = Omit<ReturnType<typeof installDesktopShortcuts>, 'attach' | 'attachGuest'> & {
  attach(window: WindowFixture): void
  attachGuest(window: WindowFixture, guest: ContentsFixture, name: DesktopBrowserLeaseId): () => void
}
// Electron is substituted at module load; fixtures implement the native members exercised by this installer.
const installFixture = installDesktopShortcuts as (
  getWindow: () => WindowFixture | undefined, userData: string,
  platform: Parameters<typeof installDesktopShortcuts>[2], updateMenu: () => void,
  overlayInput: (window: WindowFixture) => { readonly revision: number; readonly blocked: boolean },
) => KeyboardFixture
type GuestsFixture = {
  acquire(owner: ContentsFixture, workspace: unknown): DesktopBrowserReservation
  release(owner: ContentsFixture, id: unknown): Promise<void>
  bind(window: WindowFixture, attachInput: (guest: ContentsFixture, name: DesktopBrowserLeaseId) => () => void): void
}

function desktopDefaults(binding: ShortcutBinding): ShortcutDefinition['defaults'] {
  return { 'desktop:macos': binding, 'desktop:windows': binding, 'desktop:linux': binding }
}

function browserGuest(reservation: DesktopBrowserReservation) {
  const frame: FrameFixture = { url: `about:blank#${reservation.lease}`, name: '', parent: null }
  const guest = Object.assign(new EventEmitter(), { mainFrame: frame, focusedFrame: frame,
    getURL: () => frame.url, isDestroyed: () => false, isFocused: vi.fn(() => true),
    setWindowOpenHandler: vi.fn(), setIgnoreMenuShortcuts: vi.fn(), send: vi.fn(), close: vi.fn(),
    focus: vi.fn(), sendInputEvent: vi.fn() })
  onTestFinished(() => { guest.emit('destroyed') })
  return { frame, guest }
}

async function fixture(platform: 'macos' | 'windows' | 'linux' = 'macos') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-keyboard-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  const frame: FrameFixture = { url: 'dsh-app://app/', name: '', parent: null }
  const contents = Object.assign(new EventEmitter(), { mainFrame: frame, focusedFrame: frame,
    isDestroyed: () => false, isFocused: () => true, send: vi.fn(),
    setIgnoreMenuShortcuts: vi.fn(), focus: vi.fn(), sendInputEvent: vi.fn() })
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => true), isEnabled: vi.fn(() => true), close: vi.fn() })
  let current: WindowFixture | undefined = window
  const updateMenu = vi.fn()
  const updateOverlays = new DesktopUpdateOverlays()
  const keyboard = installFixture(() => current, root, platform, updateMenu, window => updateOverlays.input(window as BrowserWindow))
  keyboard.attach(current)
  onTestFinished(() => { keyboard.dispose() })
  const handlers = new Map<string, (event: InvokeFixture, ...args: unknown[]) => unknown>(
    ipc.handle.mock.calls.map(([channel, handler]) => [channel, handler]))
  const event: InvokeFixture = { sender: contents, senderFrame: frame }
  const call = async <T>(channel: string, ...args: unknown[]): Promise<T> => await handlers.get(channel)!(event, ...args) as T
  const definitions: readonly ShortcutDefinition[] = [
    { id: 'sidebar.left.toggle' as ShortcutCommandId, defaults: desktopDefaults({ code: 'KeyB', modifiers: ['primary'] }) },
  ]
  return { keyboard, window, updateOverlays, contents, frame, event, handlers, call, definitions, updateMenu,
    detach: () => { current = undefined } }
}

function updateOverlayFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  onTestFinished(() => { platform.mockRestore() })
  const parent: WindowFixture & Pick<BrowserWindow, 'getContentBounds'> = Object.assign(f.window, {
    getContentBounds: () => ({ x: 0, y: 0, width: 900, height: 650 }),
  })
  Object.assign(f.contents, { insertCSS: vi.fn(async () => 'blur'), removeInsertedCSS: vi.fn(async () => {}) })
  return () => {
    const overlay = f.updateOverlays.create(parent as BrowserWindow, 'test-overlay-preload', 'Update', false)
    onTestFinished(() => { if (!overlay.isDestroyed()) overlay.destroy() })
    expect(vi.spyOn(overlay, 'show')).not.toHaveBeenCalled()
    return overlay
  }
}

it('mirrors only successful bindings, suppresses recording menus, and invalidates pre-navigation drafts', async () => {
  const f = await fixture()
  const initial = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, f.definitions)
  const press = (code: string) => f.contents.emit('before-input-event', { preventDefault: vi.fn() },
    { type: 'keyDown', modifiers: [], code, key: code.replace('Key', ''), meta: true, control: false, alt: false, shift: false })
  press('KeyB'); expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true)
  press('KeyJ'); expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false)
  const saved = await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit, { type: 'set', id: 'sidebar.left.toggle', binding: { code: 'KeyJ', modifiers: ['primary'] } }, initial.revision)
  expect(saved.status).toBe('saved')
  press('KeyB'); expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false)
  press('KeyJ'); expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true)
  expect((await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit, { type: 'reset-all' }, initial.revision)).status).toBe('stale')
  await f.call(DESKTOP_IPC.shortcutsRecording, true)
  press('KeyW'); expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true)
  f.window.isFocused.mockReturnValue(false)
  press('KeyW'); expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false)
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }, 'dsh-app://app/', false, true)
  expect((await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit, { type: 'reset-all' }, saved.snapshot.revision)).status).toBe('not-ready')
  await f.call(DESKTOP_IPC.shortcutsGet, f.definitions)
  expect((await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit, { type: 'reset-all' }, saved.snapshot.revision)).status).toBe('stale')
})

it('blocks macOS shortcuts while an update overlay loads and clears held and consumed keys before dismissal', async () => {
  const f = await fixture()
  const open = updateOverlayFixture(f)
  const snapshot = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, [
    { id: 'page.close', defaults: { 'desktop:macos': { code: 'KeyA', secondCode: 'KeyB', modifiers: [] } } },
    { id: 'sidebar.left.toggle', defaults: desktopDefaults({ code: 'KeyK', modifiers: ['primary'] }) },
  ])
  const menu = f.keyboard.fileMenu({ fileMenu: 'File', closePage: 'Close' }).submenu as Electron.MenuItemConstructorOptions[]
  const closeMenu = menu[0]!.click as () => void
  const press = (code: string, type = 'keyDown', meta = false) => {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    f.contents.emit('before-input-event', event, { type, code, key: code.slice(3), modifiers: meta ? ['meta'] : [],
      meta, control: false, alt: false, shift: false, isAutoRepeat: false, isComposing: false })
    return event.defaultPrevented
  }
  f.contents.send.mockClear()
  expect(press('KeyA')).toBe(false)
  const first = open()
  expect(press('KeyB')).toBe(true)
  expect(press('KeyK', 'keyDown', true)).toBe(true)
  closeMenu()
  await f.call(DESKTOP_IPC.shortcutsCloseWindow, snapshot.revision)
  f.keyboard.sendEditingKey('C', ['control'])
  expect(f.window.close).not.toHaveBeenCalled()
  expect(f.contents.sendInputEvent).not.toHaveBeenCalled()
  expect(f.contents.send).not.toHaveBeenCalled()
  first.destroy()
  expect(press('KeyB')).toBe(false)
  expect(press('KeyB', 'keyUp')).toBe(false)
  expect(f.contents.send).not.toHaveBeenCalled()
  expect(press('KeyA')).toBe(false)
  expect(press('KeyB')).toBe(true)
  expect(f.contents.send).toHaveBeenCalledOnce()
  expect(f.contents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.shortcutsInput,
    expect.objectContaining({ code: 'KeyA', secondCode: 'KeyB' }))
  const second = open()
  expect(press('KeyB', 'keyUp')).toBe(true)
  second.destroy()
  expect(press('KeyB', 'keyUp')).toBe(false)
  expect(press('KeyK', 'keyDown', true)).toBe(true)
  expect(f.contents.send).toHaveBeenCalledTimes(2)
  expect(f.contents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.shortcutsInput,
    expect.objectContaining({ code: 'KeyK', meta: true }))
  closeMenu()
  expect(f.contents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.shortcutsInput, expect.objectContaining({ kind: 'menu' }))
  await f.call(DESKTOP_IPC.shortcutsCloseWindow, snapshot.revision)
  expect(f.window.close).toHaveBeenCalledOnce()
  f.keyboard.sendEditingKey('C', ['control'])
  expect(f.contents.sendInputEvent).toHaveBeenCalledTimes(2)
})

it.each([false, true])('blocks approved browser guest input across update overlays, including guests attached while blocked: %s', async (attachWhileBlocked) => {
  const f = await fixture()
  const open = updateOverlayFixture(f)
  await f.call(DESKTOP_IPC.shortcutsGet, [
    { id: 'page.close', defaults: { 'desktop:macos': { code: 'KeyA', secondCode: 'KeyB', modifiers: [] } } },
    { id: 'sidebar.left.toggle', defaults: desktopDefaults({ code: 'KeyK', modifiers: ['primary'] }) },
  ])
  const guests = new DesktopBrowserGuests(() => undefined) as GuestsFixture
  guests.bind(f.window, (guest, name) => f.keyboard.attachGuest(f.window, guest, name))
  const reservation = guests.acquire(f.contents, 'session:test')
  const { frame, guest } = browserGuest(reservation)
  const attach = () => {
    const event = { preventDefault: vi.fn() }
    f.contents.emit('will-attach-webview', event, {}, { src: frame.url, partition: reservation.partition })
    expect(event.preventDefault).not.toHaveBeenCalled()
    f.contents.emit('did-attach-webview', {}, guest)
    guest.emit('dom-ready')
  }
  if (!attachWhileBlocked) attach()
  const first = open()
  if (attachWhileBlocked) attach()
  const press = (code: string, type = 'keyDown', meta = false) => {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    guest.emit('before-input-event', event, { type, code, key: code.slice(3), modifiers: meta ? ['meta'] : [],
      meta, control: false, alt: false, shift: false, isAutoRepeat: false, isComposing: false })
    return event.defaultPrevented
  }
  f.contents.send.mockClear()
  expect(press('KeyK', 'keyDown', true)).toBe(true)
  f.keyboard.sendEditingKey('C', ['control'])
  expect(guest.sendInputEvent).not.toHaveBeenCalled()
  expect(f.contents.send).not.toHaveBeenCalled()
  const second = open()
  first.destroy()
  expect(press('KeyA')).toBe(true)
  expect(press('KeyB')).toBe(true)
  expect(f.contents.send).not.toHaveBeenCalled()
  second.destroy()
  expect(press('KeyB')).toBe(false)
  expect(press('KeyB', 'keyUp')).toBe(false)
  expect(press('KeyA')).toBe(false)
  open().destroy()
  expect(press('KeyB')).toBe(false)
  expect(press('KeyB', 'keyUp')).toBe(false)
  expect(f.contents.send).not.toHaveBeenCalled()
  expect(press('KeyA')).toBe(false)
  expect(press('KeyB')).toBe(true)
  expect(f.contents.send).toHaveBeenCalledOnce()
  expect(f.contents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.shortcutsInput,
    expect.objectContaining({ kind: 'webview', frameName: reservation.lease, code: 'KeyA', secondCode: 'KeyB' }))
  open().destroy()
  expect(press('KeyB', 'keyUp')).toBe(false)
  expect(press('KeyK', 'keyDown', true)).toBe(true)
  expect(f.contents.send).toHaveBeenCalledTimes(2)
  f.keyboard.sendEditingKey('C', ['control'])
  expect(guest.sendInputEvent).toHaveBeenCalledTimes(2)
})

it('rejects other windows, subframes, remote/shell pages, and malformed edits', async () => {
  const f = await fixture()
  const get = f.handlers.get(DESKTOP_IPC.shortcutsGet)!
  for (const event of [{ ...f.event, sender: {} }, { ...f.event, senderFrame: null }, { ...f.event, senderFrame: {} }]) {
    await expect(get(event, f.definitions)).rejects.toThrow('rejected sender')
  }
  for (const url of ['dsh-app://shell/', 'https://example.com/', 'http://localhost/']) {
    f.frame.url = url
    await expect(get(f.event, f.definitions)).rejects.toThrow('unowned renderer')
  }
  f.frame.url = 'dsh-app://app/'
  const ready = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, f.definitions)
  await expect(f.call(DESKTOP_IPC.shortcutsEdit, { type: 'reset-all', path: '/tmp' }, ready.revision)).rejects.toThrow('Invalid')
  await expect(f.call(DESKTOP_IPC.shortcutsEdit, { type: 'reset-all' }, 1)).rejects.toThrow('revision')
  await expect(f.call(DESKTOP_IPC.shortcutsRecording, 'true')).rejects.toThrow('recording')
  f.window.isDestroyed.mockReturnValue(true)
  await expect(get(f.event, f.definitions)).rejects.toThrow('rejected sender')
  f.detach(); await expect(get(f.event, f.definitions)).rejects.toThrow('rejected sender')
})

it('routes embedded input once, follows rebindings, and guards native window closure by revision and focus', async () => {
  const f = await fixture()
  const closeItem = () => (f.keyboard.fileMenu({ fileMenu: 'File', closePage: 'Close' }).submenu as Electron.MenuItemConstructorOptions[])[0]!
  const initial = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, [
    { id: 'page.close', defaults: desktopDefaults({ code: 'KeyW', modifiers: ['primary'] }) },
    { id: 'page.refresh', defaults: desktopDefaults({ code: 'KeyR', modifiers: ['primary'] }) },
  ])
  expect(closeItem().accelerator).toBe('Command+W')
  const preventDefault = vi.fn()
  const input = { modifiers: [], type: 'keyDown', code: 'KeyW', key: 'w', meta: true, control: false, alt: false, shift: false, isAutoRepeat: false, isComposing: false }
  f.contents.send.mockClear()
  f.contents.emit('before-input-event', { preventDefault }, input)
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(f.contents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.shortcutsInput,
    expect.objectContaining({ kind: 'keyboard', code: 'KeyW' }))
  preventDefault.mockClear(); f.contents.send.mockClear()
  Object.assign(f.contents, { focusedFrame: { name: 'embedded', parent: f.frame } })
  f.contents.emit('before-input-event', { preventDefault }, input)
  expect(preventDefault).toHaveBeenCalledTimes(1)
  expect(f.contents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.shortcutsInput, expect.objectContaining({ kind: 'iframe', revision: initial.revision, frameName: 'embedded', code: 'KeyW' }))
  f.contents.emit('before-input-event', { preventDefault }, { ...input, type: 'keyUp' })
  expect(f.contents.send).toHaveBeenCalledTimes(1)
  const saved = await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit,
    { type: 'set', id: 'page.close', binding: { code: 'KeyJ', modifiers: ['primary'] } }, initial.revision)
  expect(closeItem().accelerator).toBe('Command+J')
  f.contents.send.mockClear()
  f.contents.emit('before-input-event', { preventDefault }, input)
  expect(f.contents.send).not.toHaveBeenCalled()
  f.contents.emit('before-input-event', { preventDefault }, { ...input, code: 'KeyZ', key: 'j' })
  expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true)
  expect(f.contents.send).not.toHaveBeenCalled()
  await f.call(DESKTOP_IPC.shortcutsCloseWindow, initial.revision)
  expect(f.window.close).not.toHaveBeenCalled()
  f.window.isEnabled.mockReturnValue(false)
  await f.call(DESKTOP_IPC.shortcutsCloseWindow, saved.snapshot.revision)
  expect(f.window.close).not.toHaveBeenCalled()
  f.window.isEnabled.mockReturnValue(true)
  await f.call(DESKTOP_IPC.shortcutsCloseWindow, saved.snapshot.revision)
  expect(f.window.close).toHaveBeenCalledTimes(1)
  await f.call(DESKTOP_IPC.shortcutsEdit, { type: 'set', id: 'page.close', binding: null }, saved.snapshot.revision)
  expect(closeItem().accelerator).toBeUndefined()
  f.keyboard.dispose()
  expect(f.contents.listenerCount('before-input-event')).toBe(0)
})

it.each([
  ['browser.new', 'KeyT'], ['session.new', 'KeyN'],
])('forwards Linux %s from embedded frames while leaving main-document input to the DOM', async (id, code) => {
  const f = await fixture('linux')
  const initial = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet,
    [{ id, defaults: desktopDefaults({ code, modifiers: ['primary'] }) }])
  const input = { modifiers: ['control'], type: 'keyDown', code, key: code.slice(3).toLowerCase(),
    control: true, meta: false, alt: false, shift: false, isAutoRepeat: false, isComposing: false }
  const preventDefault = vi.fn()
  f.contents.send.mockClear()
  f.contents.emit('before-input-event', { preventDefault }, input)
  expect(preventDefault).not.toHaveBeenCalled()
  expect(f.contents.send).not.toHaveBeenCalled()

  Object.assign(f.contents, { focusedFrame: { name: 'browser', parent: f.frame } })
  f.contents.emit('before-input-event', { preventDefault }, input)
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(f.contents.send).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.shortcutsInput,
    expect.objectContaining({ kind: 'iframe', frameName: 'browser', code, revision: initial.revision }))
  f.contents.emit('before-input-event', { preventDefault }, { ...input, type: 'keyUp' })
  expect(f.contents.send).toHaveBeenCalledOnce()

  const cleared = await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit,
    { type: 'set', id, binding: null }, initial.revision)
  expect(cleared.status).toBe('saved')
  preventDefault.mockClear(); f.contents.send.mockClear()
  f.contents.emit('before-input-event', { preventDefault }, input)
  expect(preventDefault).not.toHaveBeenCalled()
  expect(f.contents.send).not.toHaveBeenCalled()
})

it.each([
  ['ArrowUp', 'Command+Up'], ['ArrowDown', 'Command+Down'],
  ['ArrowLeft', 'Command+Left'], ['ArrowRight', 'Command+Right'],
])('uses the Electron accelerator for a saved %s binding', async (code, accelerator) => {
  const f = await fixture()
  const initial = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet,
    [{ id: 'page.close', defaults: desktopDefaults({ code: 'KeyW', modifiers: ['primary'] }) }])
  const saved = await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit,
    { type: 'set', id: 'page.close', binding: { code, modifiers: ['primary'] } }, initial.revision)
  expect(saved.status).toBe('saved')
  const menu = f.keyboard.fileMenu({ fileMenu: 'File', closePage: 'Close' }).submenu as Electron.MenuItemConstructorOptions[]
  expect(menu[0]?.accelerator).toBe(accelerator)
})

it('refreshes the native menu only when its accelerator or availability changes', async () => {
  const f = await fixture()
  const close = { id: 'page.close', defaults: desktopDefaults({ code: 'KeyW', modifiers: ['primary'] }) }
  expect(f.updateMenu).not.toHaveBeenCalled()
  await f.call(DESKTOP_IPC.shortcutsGet, [close])
  expect(f.updateMenu).toHaveBeenCalledOnce()
  const menu = f.keyboard.fileMenu({ fileMenu: 'File', closePage: 'Close' }).submenu as Electron.MenuItemConstructorOptions[]
  const registered = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, [close, ...f.definitions])
  const edited = await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit,
    { type: 'set', id: 'sidebar.left.toggle', binding: { code: 'KeyJ', modifiers: ['primary'] } }, registered.revision)
  expect(edited.status).toBe('saved')
  expect(f.updateMenu).toHaveBeenCalledOnce()
  f.contents.send.mockClear()
  const click = menu[0]!.click as () => void
  click()
  expect(f.contents.send).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.shortcutsInput,
    { kind: 'menu', commandId: 'page.close', revision: edited.snapshot.revision })
  await f.call(DESKTOP_IPC.shortcutsEdit,
    { type: 'set', id: 'page.close', binding: { code: 'KeyQ', modifiers: ['primary'] } }, edited.snapshot.revision)
  expect(f.updateMenu).toHaveBeenCalledTimes(2)
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  expect(f.updateMenu).toHaveBeenCalledTimes(3)
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  expect(f.updateMenu).toHaveBeenCalledTimes(3)
})

it.each(['macos', 'windows'] as const)('prioritizes %s custom editing bindings before both main and embedded frame handlers', async (platform) => {
  const f = await fixture(platform)
  const initial = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet,
    [{ id: 'session.new', defaults: desktopDefaults({ code: 'KeyN', modifiers: ['primary'] }) }])
  const saved = await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit,
    { type: 'set', id: 'session.new', binding: { code: 'KeyC', modifiers: ['primary'] } }, initial.revision)
  expect(saved.status).toBe('saved')
  const input = { modifiers: [], type: 'keyDown', code: 'KeyC', key: 'c', meta: platform === 'macos',
    control: platform === 'windows', alt: false, shift: false, isAutoRepeat: false, isComposing: false }
  const preventDefault = vi.fn()
  const press = (changes = {}) => f.contents.emit('before-input-event', { preventDefault }, { ...input, ...changes })
  f.contents.send.mockClear()
  press()
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(f.contents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.shortcutsInput, expect.objectContaining({ kind: 'keyboard', code: 'KeyC' }))
  press({ type: 'keyUp' })
  expect(preventDefault).toHaveBeenCalledTimes(2)
  expect(f.contents.send).toHaveBeenCalledOnce()
  Object.assign(f.contents, { focusedFrame: { name: 'embedded', parent: f.frame } })
  press()
  expect(f.contents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.shortcutsInput, expect.objectContaining({ kind: 'iframe', frameName: 'embedded' }))
  await f.call(DESKTOP_IPC.shortcutsRecording, true)
  preventDefault.mockClear(); f.contents.send.mockClear()
  press()
  expect(preventDefault).not.toHaveBeenCalled()
  expect(f.contents.send).not.toHaveBeenCalled()
  await f.call(DESKTOP_IPC.shortcutsRecording, false)
  press({ isComposing: true })
  press({ modifiers: ['altgr'] })
  press({ key: 'Dead' })
  press()
  expect(preventDefault).not.toHaveBeenCalled()
  await f.call(DESKTOP_IPC.shortcutsEdit, { type: 'set', id: 'session.new', binding: null }, saved.snapshot.revision)
  f.contents.send.mockClear()
  press()
  expect(preventDefault).not.toHaveBeenCalled()
  expect(f.contents.send).not.toHaveBeenCalled()
  expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false)
})

it.each(['macos', 'windows'] as const)('intercepts complete %s chords once and leaves their first key untouched', async (platform) => {
  const f = await fixture(platform)
  const initial = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet,
    [{ id: 'page.close', defaults: desktopDefaults({ code: 'KeyW', modifiers: ['primary'] }) }])
  const saved = await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit,
    { type: 'set', id: 'page.close', binding: { code: 'KeyA', secondCode: 'KeyB', modifiers: [] } }, initial.revision)
  expect(saved.status).toBe('saved')
  const menu = f.keyboard.fileMenu({ fileMenu: 'File', closePage: 'Close' }).submenu as Electron.MenuItemConstructorOptions[]
  expect(menu[0]?.accelerator).toBeUndefined()
  const preventDefault = vi.fn()
  const press = (code: string, type = 'keyDown', isAutoRepeat = false) => {
    f.contents.emit('before-input-event', { preventDefault }, { code, key: code.slice(3), type, modifiers: [],
      control: false, alt: false, shift: false, meta: false, isAutoRepeat, isComposing: false })
  }
  for (const embedded of [false, true]) {
    Object.assign(f.contents, { focusedFrame: embedded ? { name: 'browser', parent: f.frame } : f.frame })
    f.contents.send.mockClear(); preventDefault.mockClear()
    press('KeyA'); press('KeyA', 'keyUp'); press('KeyB'); press('KeyB', 'keyUp')
    expect(preventDefault).not.toHaveBeenCalled()
    expect(f.contents.send).not.toHaveBeenCalled()
    press('KeyB')
    expect(preventDefault).not.toHaveBeenCalled()
    press('KeyA')
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(f.contents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.shortcutsInput,
      expect.objectContaining({ kind: embedded ? 'iframe' : 'keyboard', code: 'KeyA', secondCode: 'KeyB', repeat: false }))
    press('KeyA', 'keyUp'); press('KeyB', 'keyUp')
  }
  for (const reset of [() => { f.window.emit('blur') },
    () => { press('MetaLeft', 'keyUp') },
    () => { Object.assign(f.contents, { focusedFrame: f.frame }) }]) {
    press('KeyA'); reset(); f.contents.send.mockClear(); press('KeyB')
    expect(f.contents.send).not.toHaveBeenCalled()
    press('KeyA', 'keyUp'); press('KeyB', 'keyUp')
  }
  f.contents.send.mockClear()
  press('KeyC'); press('KeyA'); press('KeyB')
  expect(f.contents.send).not.toHaveBeenCalled()
})

it.each(['C', 'V', 'Z'])('delivers Windows Edit %s to the editor and physical input to its shortcut', async (keyCode) => {
  const f = await fixture('windows')
  const initial = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, f.definitions)
  const saved = await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit,
    { type: 'set', id: 'sidebar.left.toggle', binding: { code: `Key${keyCode}`, modifiers: ['control'] } }, initial.revision)
  const registry = new ShortcutRegistry('desktop', 'windows', saved.snapshot)
  const run = vi.fn()
  registry.register({ ...f.definitions[0]!, label: () => 'Toggle sidebar', aliases: [], regions: ['page', 'editable'], modals: [],
    resolve: () => ({ status: 'handled', run }) })
  let nativeInput: (input: DesktopShortcutInput) => void = () => {}
  onTestFinished(installNativeKeyboard(window, {
    closeWindow: vi.fn(), subscribe: (listener) => { nativeInput = listener; return () => {} },
  }, registry, () => registry.config.getSnapshot()))
  onTestFinished(installKeyboard(window, registry, undefined, true))
  f.contents.send.mockImplementation((channel: string, input: DesktopShortcutInput) => {
    if (channel === DESKTOP_IPC.shortcutsInput) nativeInput(input)
  })
  const editorInput: string[] = []
  const deliver = (type: 'keyDown' | 'keyUp'): void => {
    const preventDefault = vi.fn()
    f.contents.emit('before-input-event', { preventDefault }, { type, code: `Key${keyCode}`, key: keyCode.toLowerCase(),
      modifiers: ['control'], control: true, meta: false, alt: false, shift: false, isAutoRepeat: false, isComposing: false })
    if (!preventDefault.mock.calls.length) {
      editorInput.push(type)
      document.body.dispatchEvent(new KeyboardEvent(type === 'keyDown' ? 'keydown' : 'keyup',
        { code: `Key${keyCode}`, key: keyCode.toLowerCase(), ctrlKey: true, bubbles: true, cancelable: true }))
    }
  }
  f.contents.sendInputEvent.mockImplementation((input: { type: 'keyDown' | 'keyUp' }) => { deliver(input.type) })
  f.contents.send.mockClear()

  f.keyboard.sendEditingKey(keyCode, ['control'])

  expect(f.contents.focus).toHaveBeenCalledOnce()
  expect(editorInput).toEqual(['keyDown', 'keyUp'])
  expect(f.contents.send).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
  expect(f.contents.sendInputEvent.mock.calls).toEqual([
    [{ type: 'keyDown', keyCode, modifiers: ['control'] }],
    [{ type: 'keyUp', keyCode, modifiers: ['control'] }],
  ])
  editorInput.length = 0
  deliver('keyDown')
  deliver('keyUp')
  expect(editorInput).toEqual([])
  expect(f.contents.send).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.shortcutsInput,
    expect.objectContaining({ kind: 'keyboard', code: `Key${keyCode}` }))
  expect(run).toHaveBeenCalledOnce()
})

it('restores shortcut interception after native Edit delivery fails', async () => {
  const f = await fixture('windows')
  await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, f.definitions)
  f.contents.sendInputEvent.mockImplementationOnce(() => { throw new Error('editor unavailable') })
  expect(() => { f.keyboard.sendEditingKey('C', ['control']) }).toThrow('editor unavailable')
  const preventDefault = vi.fn()
  f.contents.emit('before-input-event', { preventDefault }, { type: 'keyDown', code: 'KeyB', key: 'b', modifiers: ['control'],
    control: true, meta: false, alt: false, shift: false, isAutoRepeat: false, isComposing: false })
  expect(preventDefault).toHaveBeenCalledOnce()
  f.window.isDestroyed.mockReturnValue(true)
  expect(() => { f.keyboard.sendEditingKey('C', ['control']) }).not.toThrow()
  f.detach()
  expect(() => { f.keyboard.sendEditingKey('C', ['control']) }).not.toThrow()
  expect(f.contents.sendInputEvent).toHaveBeenCalledOnce()
})

it.each(['macos', 'windows'] as const)('intercepts %s standalone custom keys and clears held state when preferences change', async (platform) => {
  const f = await fixture(platform)
  let snapshot = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, f.definitions)
  for (const code of ['KeyA', 'F1', 'ArrowLeft', 'Escape', 'Tab', 'Enter']) {
    const saved = await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit,
      { type: 'set', id: 'sidebar.left.toggle', binding: { code, modifiers: [] } }, snapshot.revision)
    expect(saved.status).toBe('saved'); snapshot = saved.snapshot
    const preventDefault = vi.fn()
    f.contents.send.mockClear()
    f.contents.emit('before-input-event', { preventDefault }, { type: 'keyDown', code, key: code, modifiers: [],
      control: false, alt: false, shift: false, meta: false, isAutoRepeat: false, isComposing: false })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(f.contents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.shortcutsInput,
      expect.objectContaining({ code, revision: snapshot.revision }))
  }
})

it.each(['macos', 'windows'] as const)('keeps %s native interception identical for inherited, saved and reset bindings', async (platform) => {
  const f = await fixture(platform)
  let snapshot = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, f.definitions)
  for (const operation of [null,
    { type: 'set', id: 'sidebar.left.toggle', binding: { code: 'KeyB', modifiers: ['primary'] } },
    { type: 'reset', id: 'sidebar.left.toggle' }]) {
    if (operation !== null) {
      const result = await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit, operation, snapshot.revision)
      expect(result.status).toBe('saved'); snapshot = result.snapshot
    }
    for (const embedded of [false, true]) {
      Object.assign(f.contents, { focusedFrame: embedded ? { name: 'browser', parent: f.frame } : f.frame })
      const preventDefault = vi.fn()
      f.contents.send.mockClear()
      f.contents.emit('before-input-event', { preventDefault }, { type: 'keyDown', code: 'KeyB', key: 'b', modifiers: [],
        control: platform === 'windows', meta: platform === 'macos', alt: false, shift: false, isAutoRepeat: false, isComposing: false })
      expect(preventDefault).toHaveBeenCalledOnce()
      expect(f.contents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.shortcutsInput,
        expect.objectContaining({ kind: embedded ? 'iframe' : 'keyboard', code: 'KeyB', revision: snapshot.revision }))
    }
  }
})

it('consumes a held single-key repeat after focus reset without treating it as a fresh press', async () => {
  const f = await fixture('macos')
  await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, f.definitions)
  const preventDefault = vi.fn()
  const input = { type: 'keyDown', code: 'KeyB', key: 'b', modifiers: [],
    control: false, meta: true, alt: false, shift: false, isAutoRepeat: false, isComposing: false }
  f.contents.emit('before-input-event', { preventDefault }, input)
  f.window.emit('blur')
  f.contents.send.mockClear(); preventDefault.mockClear()
  f.contents.emit('before-input-event', { preventDefault }, { ...input, isAutoRepeat: true })
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(f.contents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.shortcutsInput, expect.objectContaining({ code: 'KeyB', repeat: true }))
})

it('delivers a fresh unbound key release after macOS omitted the previous Command character release', async () => {
  const f = await fixture('macos')
  await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, f.definitions)
  const preventDefault = vi.fn()
  const press = (code: string, type: string, meta: boolean): void => {
    f.contents.emit('before-input-event', { preventDefault }, { type, code, key: code, modifiers: [],
      control: false, meta, alt: false, shift: false, isAutoRepeat: false, isComposing: false })
  }
  press('KeyB', 'keyDown', true)
  expect(preventDefault).toHaveBeenCalledOnce()
  press('MetaLeft', 'keyUp', false)
  preventDefault.mockClear()
  press('KeyB', 'keyDown', false); press('KeyB', 'keyUp', false)
  expect(preventDefault).not.toHaveBeenCalled()
})

it.each(['macos', 'windows'] as const)('releases %s native input when a saved binding overlaps a mounted fixed action', async (platform) => {
  const f = await fixture(platform)
  const initial = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, f.definitions)
  const saved = await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit,
    { type: 'set', id: 'sidebar.left.toggle', binding: { code: 'Escape', modifiers: [] } }, initial.revision)
  expect(saved.status).toBe('saved')
  await f.call(DESKTOP_IPC.shortcutsGet, [...f.definitions,
    { id: 'menu.dismiss', defaults: {}, fixed: [{ code: 'Escape', modifiers: [] }] }])
  const preventDefault = vi.fn()
  f.contents.send.mockClear()
  f.contents.emit('before-input-event', { preventDefault }, { type: 'keyDown', code: 'Escape', key: 'Escape', modifiers: [],
    control: false, meta: false, alt: false, shift: false, isAutoRepeat: false, isComposing: false })
  expect(preventDefault).not.toHaveBeenCalled()
  expect(f.contents.send).not.toHaveBeenCalled()
})

it.each(['macos', 'windows'] as const)('keeps %s chord presses singular across native interception and renderer key delivery', async (platform) => {
  const f = await fixture(platform)
  const initial = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, f.definitions)
  const saved = await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit,
    { type: 'set', id: 'sidebar.left.toggle', binding: { code: 'KeyF', secondCode: 'KeyG', modifiers: [] } }, initial.revision)
  const registry = new ShortcutRegistry('desktop', platform, saved.snapshot)
  const run = vi.fn()
  registry.register({ ...f.definitions[0]!, label: () => 'Toggle sidebar', aliases: [], regions: ['page'], modals: [],
    resolve: () => ({ status: 'handled', run }) })
  let deliver: (input: DesktopShortcutInput) => void = () => {}
  onTestFinished(installNativeKeyboard(window, { closeWindow: vi.fn(), subscribe: (listener) => { deliver = listener; return () => {} } },
    registry, () => registry.config.getSnapshot()))
  onTestFinished(installKeyboard(window, registry, undefined, true))
  f.contents.send.mockImplementation((channel: string, input: DesktopShortcutInput) => {
    if (channel === DESKTOP_IPC.shortcutsInput) deliver(input)
  })
  const rendererReleases: string[] = []
  const press = (code: string, type: 'keyDown' | 'keyUp', repeat = false): void => {
    const preventDefault = vi.fn()
    f.contents.emit('before-input-event', { preventDefault }, { code, key: code.slice(3).toLowerCase(), type, modifiers: [],
      control: false, meta: false, alt: false, shift: false, isAutoRepeat: repeat, isComposing: false })
    // Electron only delivers input to the document when the main process did not intercept it.
    if (!preventDefault.mock.calls.length) {
      if (type === 'keyUp') rendererReleases.push(code)
      document.body.dispatchEvent(new KeyboardEvent(type === 'keyDown' ? 'keydown' : 'keyup',
        { code, key: code.slice(3).toLowerCase(), repeat, bubbles: true, cancelable: true }))
    }
  }
  for (const [index, [first, second]] of ([['KeyF', 'KeyG'], ['KeyG', 'KeyF']] as const).entries()) {
    press(first, 'keyDown'); press(first, 'keyUp'); press(second, 'keyDown'); press(second, 'keyUp')
    expect(run).toHaveBeenCalledTimes(index)
    press(first, 'keyDown'); press(second, 'keyDown'); press(second, 'keyDown', true); press(first, 'keyDown', true)
    expect(run).toHaveBeenCalledTimes(index + 1)
    if (index === 0) { press(first, 'keyUp'); press(second, 'keyUp') }
    else { press(second, 'keyUp'); press(first, 'keyUp') }
    press(second, 'keyDown'); press(second, 'keyUp'); press(first, 'keyDown'); press(first, 'keyUp')
    expect(run).toHaveBeenCalledTimes(index + 1)
  }
  expect(rendererReleases.filter(code => code === 'KeyF')).toHaveLength(5)
  expect(rendererReleases.filter(code => code === 'KeyG')).toHaveLength(5)
})

it.each(['macos', 'windows'] as const)('requires fresh %s chord presses when Electron omits intercepted key releases', async (platform) => {
  const f = await fixture(platform)
  const bindings = [
    { id: 'sidebar.left.toggle', binding: { code: 'KeyJ', secondCode: 'KeyK', modifiers: [] } },
    { id: 'sidebar.right.toggle', binding: { code: 'KeyF', secondCode: 'KeyG', modifiers: [] } },
    { id: 'shortcuts.open', binding: { code: 'KeyV', modifiers: [] } },
  ]
  let snapshot = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet,
    bindings.map(({ id }) => ({ id, defaults: {} })))
  for (const binding of bindings) {
    const saved = await f.call<ShortcutSaveResult>(DESKTOP_IPC.shortcutsEdit, { type: 'set', ...binding }, snapshot.revision)
    expect(saved.status).toBe('saved')
    snapshot = saved.snapshot
  }
  const press = (code: string, type = 'keyDown', repeat = false): boolean => {
    const preventDefault = vi.fn()
    f.contents.emit('before-input-event', { preventDefault }, { code, key: code.slice(3).toLowerCase(), type, modifiers: [],
      control: false, meta: false, alt: false, shift: false, isAutoRepeat: repeat, isComposing: false })
    return preventDefault.mock.calls.length > 0
  }
  for (const embedded of [false, true]) {
    Object.assign(f.contents, { focusedFrame: embedded ? { name: 'browser', parent: f.frame } : f.frame })
    f.contents.send.mockClear()
    expect(press('KeyJ')).toBe(false)
    expect(press('KeyK')).toBe(true)
    expect(f.contents.send).toHaveBeenCalledOnce()
    // Electron on macOS can omit both releases after intercepting the second keydown.
    for (const code of ['KeyJ', 'KeyK']) {
      expect(press(code)).toBe(false)
      expect(press(code, 'keyUp')).toBe(false)
    }
    expect(f.contents.send).toHaveBeenCalledOnce()
    expect(press('KeyK')).toBe(false)
    expect(press('KeyJ')).toBe(true)
    expect(f.contents.send).toHaveBeenCalledTimes(2)
    expect(press('KeyJ', 'keyDown', true)).toBe(true)
    expect(press('KeyK', 'keyDown', true)).toBe(true)
    expect(f.contents.send).toHaveBeenCalledTimes(2)
    expect(press('KeyF')).toBe(false)
    expect(press('KeyG')).toBe(true)
    expect(f.contents.send).toHaveBeenCalledTimes(3)
    expect(press('KeyV')).toBe(true)
    expect(press('KeyJ')).toBe(false)
    expect(press('KeyK')).toBe(true)
    expect(f.contents.send).toHaveBeenCalledTimes(5)
  }
})

it.each(['macos', 'windows', 'linux'] as const)('routes approved %s browser guest input to its owner and stops delivery before guest destruction', async (platform) => {
  const f = await fixture(platform)
  const snapshot = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet,
    [{ id: 'browser.new', defaults: desktopDefaults({ code: 'KeyT', modifiers: ['primary'] }) }])
  const guests = new DesktopBrowserGuests(() => undefined) as GuestsFixture
  const attach = vi.fn((guest: ContentsFixture, name: DesktopBrowserLeaseId) => f.keyboard.attachGuest(f.window, guest, name))
  guests.bind(f.window, attach)
  const reservation = guests.acquire(f.contents, 'session:test')
  const { frame, guest } = browserGuest(reservation)
  const rejected = { preventDefault: vi.fn() }
  f.contents.emit('will-attach-webview', rejected, {}, { src: 'about:blank#unknown', partition: reservation.partition })
  expect(rejected.preventDefault).toHaveBeenCalledOnce()
  const invalid = Object.assign(new EventEmitter(), { getURL: () => 'about:blank#unknown', setWindowOpenHandler: vi.fn(), close: vi.fn() })
  f.contents.emit('did-attach-webview', {}, invalid)
  invalid.emit('dom-ready')
  expect(invalid.close).toHaveBeenCalledExactlyOnceWith({ waitForBeforeUnload: false })
  expect(attach).not.toHaveBeenCalled()

  const approved = { preventDefault: vi.fn() }
  f.contents.emit('will-attach-webview', approved, {}, { src: frame.url, partition: reservation.partition })
  expect(approved.preventDefault).not.toHaveBeenCalled()
  f.contents.emit('did-attach-webview', {}, guest)
  guest.emit('dom-ready')
  expect(attach).toHaveBeenCalledExactlyOnceWith(guest, reservation.lease)
  const input = { modifiers: [], type: 'keyDown', code: 'KeyT', key: 't', meta: platform === 'macos',
    control: platform !== 'macos', alt: false, shift: false, isAutoRepeat: false, isComposing: false }
  const preventDefault = vi.fn()
  f.contents.send.mockClear()
  guest.emit('before-input-event', { preventDefault }, input)
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(guest.send).not.toHaveBeenCalled()
  expect(f.contents.send).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.shortcutsInput, {
    kind: 'webview', frameName: reservation.lease, revision: snapshot.revision, code: 'KeyT',
    meta: platform === 'macos', control: platform !== 'macos', alt: false, shift: false, repeat: false,
  })
  guest.isFocused.mockReturnValue(false)
  guest.emit('before-input-event', { preventDefault }, input)
  expect(f.contents.send).toHaveBeenCalledOnce()
  guest.isFocused.mockReturnValue(true)
  const release = guests.release(f.contents, reservation.lease)
  expect(guest.close).toHaveBeenCalledExactlyOnceWith({ waitForBeforeUnload: false })
  expect(guest.listenerCount('before-input-event')).toBe(0)
  guest.emit('before-input-event', { preventDefault }, input)
  expect(f.contents.send).toHaveBeenCalledOnce()
  guest.emit('destroyed')
  await release
})

it('keeps browser guest chord state local and leaves accepted bindings active through guest navigation', async () => {
  const f = await fixture('macos')
  const initial = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, f.definitions)
  await f.call(DESKTOP_IPC.shortcutsEdit, { type: 'set', id: 'sidebar.left.toggle',
    binding: { code: 'KeyF', secondCode: 'KeyG', modifiers: [] } }, initial.revision)
  const frame: FrameFixture = { url: 'https://example.test/', name: '', parent: null }
  const guest = Object.assign(new EventEmitter(), { mainFrame: frame, focusedFrame: frame,
    isDestroyed: () => false, isFocused: () => true, setIgnoreMenuShortcuts: vi.fn(),
    send: vi.fn(), focus: vi.fn(), sendInputEvent: vi.fn() })
  const blurListeners = f.window.listenerCount('blur')
  const closedListeners = f.window.listenerCount('closed')
  const dispose = f.keyboard.attachGuest(f.window, guest, 'guest' as DesktopBrowserLeaseId)
  onTestFinished(dispose)
  expect(f.window.listenerCount('blur')).toBe(blurListeners)
  expect(f.window.listenerCount('closed')).toBe(closedListeners)
  const press = (contents: EventEmitter, code: string): void => {
    contents.emit('before-input-event', { preventDefault: vi.fn() }, { modifiers: [], type: 'keyDown', code, key: code,
      meta: false, control: false, alt: false, shift: false, isAutoRepeat: false, isComposing: false })
  }
  f.contents.send.mockClear()
  press(guest, 'KeyF')
  guest.emit('blur')
  press(guest, 'KeyG')
  expect(f.contents.send).not.toHaveBeenCalled()
  f.window.emit('blur')
  press(guest, 'KeyF')
  expect(f.contents.send).not.toHaveBeenCalled()
  guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  press(guest, 'KeyF')
  press(f.contents, 'KeyG')
  expect(f.contents.send).not.toHaveBeenCalled()
  press(guest, 'KeyG')
  expect(f.contents.send).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.shortcutsInput,
    expect.objectContaining({ kind: 'webview', frameName: 'guest', code: 'KeyF', secondCode: 'KeyG' }))
  guest.emit('destroyed')
  press(f.contents, 'KeyF')
  expect(f.contents.send).toHaveBeenCalledTimes(2)
  expect(f.contents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.shortcutsInput,
    expect.objectContaining({ kind: 'keyboard', code: 'KeyF', secondCode: 'KeyG' }))
})

it('delivers Windows Edit actions to the focused browser guest without invoking its custom shortcut', async () => {
  const f = await fixture('windows')
  const initial = await f.call<ShortcutConfigSnapshot>(DESKTOP_IPC.shortcutsGet, f.definitions)
  await f.call(DESKTOP_IPC.shortcutsEdit, { type: 'set', id: 'sidebar.left.toggle',
    binding: { code: 'KeyC', modifiers: ['control'] } }, initial.revision)
  const frame: FrameFixture = { url: 'https://example.test/', name: '', parent: null }
  const guest = Object.assign(new EventEmitter(), { mainFrame: frame, focusedFrame: frame,
    isDestroyed: () => false, isFocused: () => true, setIgnoreMenuShortcuts: vi.fn(),
    send: vi.fn(), focus: vi.fn(), sendInputEvent: vi.fn() })
  const dispose = f.keyboard.attachGuest(f.window, guest, 'guest' as DesktopBrowserLeaseId)
  onTestFinished(dispose)
  const events: string[] = []
  guest.sendInputEvent.mockImplementation((input: { type: 'keyDown' | 'keyUp' }) => {
    const preventDefault = vi.fn()
    guest.emit('before-input-event', { preventDefault }, { ...input, code: 'KeyC', key: 'c', modifiers: ['control'],
      control: true, meta: false, alt: false, shift: false, isAutoRepeat: false, isComposing: false })
    if (!preventDefault.mock.calls.length) events.push(input.type)
  })
  f.contents.send.mockClear()
  f.keyboard.sendEditingKey('C', ['control'])
  expect(guest.focus).toHaveBeenCalledOnce()
  expect(events).toEqual(['keyDown', 'keyUp'])
  expect(f.contents.send).not.toHaveBeenCalled()
  expect(f.contents.sendInputEvent).not.toHaveBeenCalled()
  dispose()
  f.keyboard.sendEditingKey('C', ['control'])
  expect(f.contents.sendInputEvent).toHaveBeenCalledTimes(2)
})
