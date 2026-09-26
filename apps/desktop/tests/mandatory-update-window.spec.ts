import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindow, WebContents, WebFrameMain } from 'electron'
import { DesktopMandatoryUpdateWindow, type MandatoryUpdateView } from '../src/mandatory-update-window.ts'
import { MANDATORY_IPC } from '../src/mandatory-update-ipc.ts'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { DesktopPolicyState } from '../src/mandatory-update-policy.ts'
import type { DesktopUpdateState } from '../src/ipc.ts'

const native = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(),
  open: vi.fn<(...args: unknown[]) => Promise<void>>(), write: vi.fn(), read: vi.fn(), quit: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: {
  handle: (channel: string, handler: (...args: unknown[]) => unknown) => native.handlers.set(channel, handler),
  removeHandler: (channel: string) => native.handlers.delete(channel),
}, app: { quit: native.quit }, shell: { openExternal: native.open }, clipboard: { writeText: native.write, readText: native.read } }))

type WindowFixture = EventEmitter & Pick<BrowserWindow, 'setMenu' | 'setTitle' | 'loadURL' | 'destroy' | 'isDestroyed'
  | 'isFocused' | 'isMinimized' | 'focus' | 'show' | 'restore'> & {
    webContents: EventEmitter & Pick<WebContents, 'send' | 'setWindowOpenHandler'> & { mainFrame: Pick<WebFrameMain, 'url'> }
  }

let window: ReturnType<typeof fakeWindow>
let ui: DesktopMandatoryUpdateWindow | undefined
function fakeWindow() {
  const contents = Object.assign(new EventEmitter(), { mainFrame: { url: 'dsh-app://shell/mandatory-update.html' },
    send: vi.fn(), setWindowOpenHandler: vi.fn() })
  return Object.assign(new EventEmitter(), { webContents: contents, setMenu: vi.fn(), setTitle: vi.fn(),
    loadURL: vi.fn(async () => {}), destroy: vi.fn(), isDestroyed: (): boolean => false,
    isFocused: () => true, isMinimized: () => false, focus: vi.fn(), show: vi.fn(), restore: vi.fn() })
}
afterEach(() => { ui?.dispose(); vi.restoreAllMocks(); vi.clearAllMocks(); native.handlers.clear(); vi.useRealTimers() })
function setup(platform: NodeJS.Platform = 'darwin') {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  window = fakeWindow()
  if (platform === 'win32') window.webContents.mainFrame.url = 'dsh-app://app/'
  let policy: DesktopPolicyState = { blocking: true, checking: false, page: 'https://downloads.example.com/desktop' }
  let update: DesktopUpdateState = { phase: 'ready', version: '1.0.1-nightly.1' }
  const install = vi.fn(async () => update)
  const createOverlay = (): WindowFixture => window
  const parent = createOverlay as () => BrowserWindow
  ui = new DesktopMandatoryUpdateWindow({ overlays: { create: parent }, preload: 'owned', locale: resolveDesktopLocale('zh'),
    allowedPageOrigins: ['https://downloads.example.com'], parent,
    policy: () => policy, update: () => update, refresh: async () => {}, download: async () => update, install })
  ui.sync()
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const view = () => native.handlers.get(MANDATORY_IPC.status)!(event) as MandatoryUpdateView
  const action = (name: string, version: string = '1.0.1-nightly.1', revision = view().confirmation?.revision) =>
    native.handlers.get(MANDATORY_IPC.action)!(event, name, version, revision)
  return { view, action, install, policy(next: DesktopPolicyState) { policy = next; ui!.sync() },
    update(next: DesktopUpdateState) { update = next; ui!.sync() } }
}

it('releases IPC after the Windows main window has already been destroyed', () => {
  setup('win32')
  vi.spyOn(window, 'isDestroyed').mockReturnValue(true)
  Object.defineProperty(window, 'webContents', { get() { throw new Error('Object has been destroyed') } })
  expect(() => { ui!.sync(); ui!.focus() }).not.toThrow()
  expect(() => { ui!.dispose() }).not.toThrow()
  expect(native.handlers.size).toBe(0)
  expect(() => { ui!.dispose() }).not.toThrow()
})

it('waits for a version-bound second click in the same modal and rejects obsolete or hidden responses', async () => {
  const f = setup()
  const pending = ui!.confirm('1.0.1-nightly.1', false)
  expect(f.view().confirmation).toEqual({ version: '1.0.1-nightly.1', active: false, revision: 1 })
  expect(window.loadURL).toHaveBeenCalledOnce()
  expect(f.install).not.toHaveBeenCalled()
  expect(() => f.action('install', '2.0.0')).toThrow(/stale/)
  expect(() => f.action('later')).toThrow(/deferral/)
  await f.action('install')
  expect(await pending).toBe(true)
  expect(f.view().confirmation).toBeUndefined()
  ui!.preparingRestart(false)
  expect(f.view().restart).toBe('preparing')
  ui!.preparingRestart(true)
  expect(f.view().restart).toBe('stopping-tasks')
  expect(window.loadURL).toHaveBeenCalledOnce()
})

it('defers without dismissing, and cancels pending approval on policy clearance or disposal', async () => {
  const f = setup()
  const deferred = ui!.confirm('1.0.1-nightly.1', true)
  await f.action('later')
  expect(await deferred).toBe(false)
  expect(f.view().deferred).toBe(true)
  expect(window.destroy).not.toHaveBeenCalled()
  const cleared = ui!.confirm('1.0.1-nightly.1', false)
  expect(() => f.action('install', '1.0.1-nightly.1', 1)).toThrow(/stale/)
  f.policy({ blocking: false, checking: false })
  expect(await cleared).toBe(false)
  ui!.preparingRestart(false)
  f.policy({ blocking: true, checking: false })
  expect(f.view().restart).toBeUndefined()
  expect(f.view().deferred).toBe(false)
  const disposed = ui!.confirm('1.0.1-nightly.1', false)
  ui!.dispose()
  expect(await disposed).toBe(false)
  expect(native.handlers.size).toBe(0)
})

it('offers copy immediately while browser opening is pending and keeps navigation failures separate', async () => {
  const f = setup()
  const opened = Promise.withResolvers<undefined>()
  native.open.mockReturnValueOnce(opened.promise)
  native.read.mockResolvedValue('https://downloads.example.com/desktop')
  const pending = f.action('page')
  expect(f.view().navigation).toEqual({ page: 'requested' })
  await f.action('copy')
  expect(f.view().navigation).toEqual({ page: 'requested', copy: 'copied' })
  opened.reject(new Error('browser rejected'))
  await pending
  expect(f.view().navigation).toEqual({ page: 'failed', copy: 'copied' })
  expect(f.view().error).toBeUndefined()
  expect(f.view().policy.blocking).toBe(true)
})

it('reports clipboard failure and ignores completion after the policy destination changes', async () => {
  const f = setup()
  native.read.mockResolvedValue('different clipboard contents')
  await f.action('page')
  await f.action('copy')
  expect(f.view().navigation?.copy).toBe('failed')
  const pendingCopy = Promise.withResolvers<undefined>()
  native.write.mockReturnValueOnce(pendingCopy.promise)
  const pending = f.action('copy')
  f.policy({ blocking: true, checking: false, page: 'https://downloads.example.com/new' })
  pendingCopy.reject(new Error('old copy failed'))
  await pending
  expect(f.view().navigation).toBeUndefined()
  f.policy({ blocking: true, checking: false, page: 'https://evil.example/desktop' })
  await expect(f.action('page')).rejects.toThrow(/no allowed/)
  expect(native.open).toHaveBeenCalledTimes(1)
})

it('rejects same-URL child frames and removes quit from renderer privileges', () => {
  const f = setup()
  const event = { sender: window.webContents, senderFrame: { ...window.webContents.mainFrame } }
  expect(() => native.handlers.get(MANDATORY_IPC.status)!(event)).toThrow(/unowned/)
  expect(() => f.action('quit')).toThrow(/invalid action/)
})

it('exits the application when the mandatory window is closed without clearing the policy', () => {
  const f = setup()
  const event = { preventDefault: vi.fn() }
  window.emit('close', event)
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(native.quit).toHaveBeenCalledOnce()
  expect(f.view().policy.blocking).toBe(true)
})

it('fades on clearance, reuses a reblocked window, and cancels teardown on disposal', () => {
  vi.useFakeTimers()
  const f = setup()
  f.policy({ blocking: false, checking: false })
  expect(window.webContents.send).toHaveBeenLastCalledWith(MANDATORY_IPC.state,
    f.view())
  vi.advanceTimersByTime(100)
  expect(window.destroy).not.toHaveBeenCalled()
  f.policy({ blocking: true, checking: false })
  vi.advanceTimersByTime(150)
  expect(window.destroy).not.toHaveBeenCalled()
  expect(window.loadURL).toHaveBeenCalledOnce()
  f.policy({ blocking: false, checking: false })
  vi.advanceTimersByTime(150)
  expect(window.destroy).toHaveBeenCalledOnce()
  expect(ui!.confirmationWindow).toBeUndefined()
  f.policy({ blocking: true, checking: false })
  f.policy({ blocking: false, checking: false })
  ui!.dispose()
  expect(vi.getTimerCount()).toBe(0)
})

it('publishes Windows overlays into the main document without creating or destroying a window', () => {
  const f = setup('win32')
  expect(window.loadURL).not.toHaveBeenCalled()
  expect(ui!.confirmationWindow).toBe(window)
  expect(window.webContents.send).toHaveBeenLastCalledWith(MANDATORY_IPC.state, f.view())
  window.webContents.emit('did-finish-load')
  expect(window.webContents.send).toHaveBeenCalledTimes(2)
  const event = { sender: window.webContents, senderFrame: { ...window.webContents.mainFrame } }
  expect(() => native.handlers.get(MANDATORY_IPC.status)!(event)).toThrow(/unowned/)
  f.policy({ blocking: false, checking: false })
  expect(window.destroy).not.toHaveBeenCalled()
  ui!.dispose()
  expect(window.destroy).not.toHaveBeenCalled()
  expect(window.webContents.listenerCount('did-finish-load')).toBe(0)
})

it('rebinds policy updates and reloads to a replacement Windows main window', () => {
  setup('win32')
  const previous = window
  window = fakeWindow()
  window.webContents.mainFrame.url = 'dsh-app://app/?recovery=1#home'
  ui!.sync()
  expect(previous.webContents.listenerCount('did-finish-load')).toBe(0)
  expect(window.webContents.send.mock.calls.at(-1)).toMatchObject([MANDATORY_IPC.state, { policy: { blocking: true } }])
  window.webContents.send.mockClear()
  window.webContents.emit('did-finish-load')
  expect(window.webContents.send).toHaveBeenCalledOnce()
  expect(() => native.handlers.get(MANDATORY_IPC.status)!({
    sender: previous.webContents, senderFrame: previous.webContents.mainFrame,
  })).toThrow(/unowned/)
  expect(() => native.handlers.get(MANDATORY_IPC.status)!({
    sender: window.webContents, senderFrame: window.webContents.mainFrame,
  })).not.toThrow()
})

it.each(['darwin', 'win32'] as const)('includes the installation wait notice only on Windows: %s', (platform) => {
  const f = setup(platform)
  expect(f.view().locale.messages.mandatoryReadyDetail).toBe(platform === 'win32'
    ? '更新期间应用将暂时关闭，完成后会自动打开。\n\n更新可能需要一些时间，请耐心等待，期间请勿重复启动应用。'
    : '更新期间应用将暂时关闭，完成后会自动打开。')
})
