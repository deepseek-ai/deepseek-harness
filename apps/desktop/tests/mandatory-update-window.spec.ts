import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindow, MessageBoxOptions, WebContents, WebFrameMain } from 'electron'
import { DesktopMandatoryUpdateWindow, type MandatoryUpdateView } from '../src/mandatory-update-window.ts'
import { MANDATORY_IPC } from '../src/mandatory-update-ipc.ts'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { DesktopPolicyState } from '../src/mandatory-update-policy.ts'
import type { DesktopUpdateState } from '../src/ipc.ts'

const native = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(),
  open: vi.fn<(...args: unknown[]) => Promise<void>>(), write: vi.fn(), read: vi.fn(), quit: vi.fn(),
  messageBox: vi.fn<(parent: BrowserWindow, options: MessageBoxOptions) => Promise<{ response: number }>>() }))
vi.mock('electron', () => ({ ipcMain: {
  handle: (channel: string, handler: (...args: unknown[]) => unknown) => native.handlers.set(channel, handler),
  removeHandler: (channel: string) => native.handlers.delete(channel),
}, dialog: { showMessageBox: native.messageBox }, app: { quit: native.quit }, shell: { openExternal: native.open },
clipboard: { writeText: native.write, readText: native.read } }))

type WindowFixture = EventEmitter & Pick<BrowserWindow, 'setMenu' | 'setTitle' | 'loadURL' | 'destroy' | 'isDestroyed'
  | 'isVisible' | 'isFocused' | 'isMinimized' | 'focus' | 'show' | 'restore'> & {
    webContents: EventEmitter & Pick<WebContents, 'send' | 'setWindowOpenHandler'> & { mainFrame: Pick<WebFrameMain, 'url'> }
  }

let window: ReturnType<typeof fakeWindow>
let ui: DesktopMandatoryUpdateWindow | undefined
function fakeWindow() {
  const contents = Object.assign(new EventEmitter(), { mainFrame: { url: 'dsh-app://shell/mandatory-update.html' },
    send: vi.fn(), setWindowOpenHandler: vi.fn() })
  return Object.assign(new EventEmitter(), { webContents: contents, setMenu: vi.fn(), setTitle: vi.fn(),
    loadURL: vi.fn(async () => {}), destroy: vi.fn(), isDestroyed: (): boolean => false,
    isVisible: (): boolean => true, isFocused: (): boolean => true,
    isMinimized: () => false, focus: vi.fn(), show: vi.fn(), restore: vi.fn() })
}
afterEach(() => { ui?.dispose(); vi.restoreAllMocks(); vi.clearAllMocks(); native.handlers.clear(); vi.useRealTimers() })
function setup(platform: NodeJS.Platform = 'darwin', beforeSync?: (surface: ReturnType<typeof fakeWindow>) => void) {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  native.messageBox.mockImplementation(() => new Promise(() => {}))
  window = fakeWindow()
  const owner = platform === 'win32' ? window : fakeWindow()
  owner.webContents.mainFrame.url = 'dsh-app://app/'
  let policy: DesktopPolicyState = { blocking: true, checking: false, page: 'https://downloads.example.com/desktop' }
  let update: DesktopUpdateState = { phase: 'ready', version: '1.0.1-nightly.1' }
  const install = vi.fn(async () => update)
  const createOverlay = (): WindowFixture => window
  const create = createOverlay as () => BrowserWindow
  const currentParent = (): WindowFixture => platform === 'win32' ? window : owner
  const parent = currentParent as () => BrowserWindow
  ui = new DesktopMandatoryUpdateWindow({ overlays: { create }, preload: 'owned', locale: resolveDesktopLocale('zh'),
    allowedPageOrigins: ['https://downloads.example.com'], parent,
    policy: () => policy, update: () => update, refresh: async () => {}, download: async () => update, install })
  beforeSync?.(window)
  ui.sync()
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const view = () => native.handlers.get(MANDATORY_IPC.status)!(event) as MandatoryUpdateView
  const action = (name: string, version: string = '1.0.1-nightly.1', revision = view().confirmation?.revision) =>
    native.handlers.get(MANDATORY_IPC.action)!(event, name, version, revision)
  return { view, action, install, owner, policy(next: DesktopPolicyState) { policy = next; ui!.sync() },
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

it('updates the same macOS view in the background without showing or focusing the owner', () => {
  const f = setup()
  f.update({ phase: 'downloading', version: '1.0.1-nightly.1', percent: 35 })
  f.update({ phase: 'error', version: '1.0.1-nightly.1', failedOperation: 'download' })
  expect(f.owner).not.toBe(window)
  expect(f.owner.show).not.toHaveBeenCalled()
  expect(f.owner.focus).not.toHaveBeenCalled()
  expect(window.loadURL).toHaveBeenCalledOnce()
  expect(ui!.confirmationWindow).toBe(f.owner)
  expect(f.view().policy.blocking).toBe(true)
})

it('cancels outstanding approval when the mandatory view is destroyed without clearing policy', async () => {
  const f = setup()
  const approval = ui!.confirm('1.0.1-nightly.1', true)
  window.webContents.emit('destroyed')
  expect(await approval).toBe(false)
  expect(f.view().policy.blocking).toBe(true)
})

it.each(['initial', 'recovery'] as const)('keeps the native owner title unchanged after %s view loading fails', async (stage) => {
  const failure = new Error('view load failed')
  const report = vi.spyOn(console, 'error').mockImplementation(() => {})
  const f = setup('darwin', (surface) => {
    if (stage === 'initial') surface.loadURL.mockRejectedValueOnce(failure)
  })
  expect(f.owner).not.toBe(window)
  if (stage === 'recovery') {
    window.loadURL.mockRejectedValueOnce(failure)
    window.webContents.emit('render-process-gone')
  }
  await expect(window.loadURL.mock.results.at(-1)!.value).rejects.toBe(failure)
  expect(f.owner.setTitle).not.toHaveBeenCalled()
  expect(f.owner.show).not.toHaveBeenCalled()
  expect(f.owner.focus).not.toHaveBeenCalled()
  expect(native.quit).not.toHaveBeenCalled()
  expect(f.view().policy.blocking).toBe(true)
  expect(report).toHaveBeenCalledWith(expect.stringContaining('mandatory update view'), failure)
  f.policy({ blocking: false, checking: false })
  ui!.dispose()
  expect(f.owner.setTitle).not.toHaveBeenCalled()
})

it('defers native recovery until foreground and opens the policy download page without installing', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const f = setup('darwin')
  await Promise.resolve()
  vi.spyOn(f.owner, 'isFocused').mockReturnValue(false)
  window.loadURL.mockRejectedValueOnce(new Error('local load failed'))
  window.webContents.emit('render-process-gone')
  await Promise.resolve()
  expect(native.messageBox).not.toHaveBeenCalled()
  const answer = Promise.withResolvers<{ response: number }>()
  native.messageBox.mockReturnValueOnce(answer.promise)
  vi.spyOn(f.owner, 'isFocused').mockReturnValue(true)
  f.owner.emit('focus')
  f.owner.emit('focus')
  expect(native.messageBox).toHaveBeenCalledOnce()
  expect(native.messageBox).toHaveBeenCalledWith(f.owner, expect.objectContaining({
    message: '请更新后继续使用', cancelId: -1,
    buttons: ['打开下载页面', '退出'],
  }))
  expect(native.messageBox.mock.calls[0]![1].detail).toContain('1.0.1-nightly.1')
  answer.resolve({ response: 0 })
  await Promise.resolve()
  await Promise.resolve()
  expect(window.loadURL).toHaveBeenCalledTimes(2)
  expect(native.open).toHaveBeenCalledWith('https://downloads.example.com/desktop')
  expect(f.install).not.toHaveBeenCalled()
  expect(f.view().policy.blocking).toBe(true)
  expect(native.quit).not.toHaveBeenCalled()
})

it.each(['clearance', 'dispose', 'hide'] as const)('ignores native recovery responses after %s', async (reason) => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const f = setup('darwin', (surface) => { surface.loadURL.mockRejectedValueOnce(new Error('local load failed')) })
  await Promise.resolve()
  const options = native.messageBox.mock.calls[0]![1]
  expect(options.signal!.aborted).toBe(false)
  if (reason === 'clearance') f.policy({ blocking: false, checking: false })
  else if (reason === 'dispose') ui!.dispose()
  else f.owner.emit('hide')
  expect(options.signal!.aborted).toBe(true)
  expect(f.owner.setTitle).not.toHaveBeenCalled()
})

it('uses the normal quit entry only for an explicit native recovery exit', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const answer = Promise.withResolvers<{ response: number }>()
  const f = setup('darwin')
  await Promise.resolve()
  native.messageBox.mockReturnValueOnce(answer.promise)
  window.loadURL.mockRejectedValueOnce(new Error('local recovery failed'))
  window.webContents.emit('render-process-gone')
  await Promise.resolve()
  answer.resolve({ response: 1 })
  await Promise.resolve()
  expect(native.quit).toHaveBeenCalledOnce()
  expect(f.view().policy.blocking).toBe(true)
  expect(f.install).not.toHaveBeenCalled()
})

it('retains blocking and reopens native recovery after a non-action dismissal', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const answer = Promise.withResolvers<{ response: number }>()
  const f = setup()
  await Promise.resolve()
  native.messageBox.mockReturnValueOnce(answer.promise)
  window.loadURL.mockRejectedValueOnce(new Error('local recovery failed'))
  window.webContents.emit('render-process-gone')
  await Promise.resolve()
  answer.resolve({ response: -1 })
  await Promise.resolve()
  expect(native.quit).not.toHaveBeenCalled()
  expect(f.view().policy.blocking).toBe(true)
  expect(window.loadURL).toHaveBeenCalledTimes(2)
  expect(native.messageBox).toHaveBeenCalledTimes(2)
})

it('ignores a late quit response after policy clearance', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const f = setup()
  await Promise.resolve()
  const answer = Promise.withResolvers<{ response: number }>()
  native.messageBox.mockReturnValueOnce(answer.promise)
  window.loadURL.mockRejectedValueOnce(new Error('local recovery failed'))
  window.webContents.emit('render-process-gone')
  await Promise.resolve()
  f.policy({ blocking: false, checking: false })
  answer.resolve({ response: 1 })
  await Promise.resolve()
  expect(native.quit).not.toHaveBeenCalled()
})


it.each([undefined, 'https://unapproved.example.com/download'])('omits native download action for unavailable destination %s', async (page) => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const f = setup()
  await Promise.resolve()
  f.policy({ blocking: true, checking: false, ...(page === undefined ? {} : { page }) })
  window.loadURL.mockRejectedValueOnce(new Error('local recovery failed'))
  window.webContents.emit('render-process-gone')
  await Promise.resolve()
  expect(native.messageBox.mock.calls[0]![1].buttons).toEqual(['退出'])
  expect(native.messageBox.mock.calls[0]![1].cancelId).toBe(-1)
  expect(native.open).not.toHaveBeenCalled()
})

it('does not open a changed policy URL using approval for the previous destination', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const f = setup()
  await Promise.resolve()
  const answer = Promise.withResolvers<{ response: number }>()
  native.messageBox.mockReturnValueOnce(answer.promise)
  window.loadURL.mockRejectedValueOnce(new Error('local recovery failed'))
  window.webContents.emit('render-process-gone')
  await Promise.resolve()
  f.policy({ blocking: true, checking: false, page: 'https://downloads.example.com/new' })
  answer.resolve({ response: 0 })
  await Promise.resolve()
  expect(native.open).not.toHaveBeenCalled()
  expect(native.messageBox).toHaveBeenCalledTimes(2)
})


it('reports a browser-opening failure in the native fallback without claiming download success', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const f = setup()
  await Promise.resolve()
  const answer = Promise.withResolvers<{ response: number }>()
  native.messageBox.mockReturnValueOnce(answer.promise)
  native.open.mockRejectedValueOnce(new Error('browser unavailable'))
  window.loadURL.mockRejectedValueOnce(new Error('local recovery failed'))
  window.webContents.emit('render-process-gone')
  await Promise.resolve()
  answer.resolve({ response: 0 })
  await vi.waitFor(() => { expect(native.messageBox).toHaveBeenCalledTimes(2) })
  expect(native.messageBox.mock.calls[1]![1].detail).toContain('无法打开下载页面，请重试')
  expect(f.view().policy.blocking).toBe(true)
  expect(f.install).not.toHaveBeenCalled()
})


it('uses the configured policy title as the native headline without repeating it in detail', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const f = setup()
  await Promise.resolve()
  f.policy({ blocking: true, checking: false, title: 'Configured title', detail: 'Configured detail' })
  window.loadURL.mockRejectedValueOnce(new Error('local recovery failed'))
  window.webContents.emit('render-process-gone')
  await Promise.resolve()
  const options = native.messageBox.mock.calls[0]![1]
  expect(options.message).toBe('Configured title')
  expect(options.detail).toBe('Configured detail\n\n新版本：1.0.1-nightly.1')
})


it('rechecks recovery after an aborted native prompt finishes following a foreground return', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const f = setup()
  await Promise.resolve()
  const answer = Promise.withResolvers<{ response: number }>()
  native.messageBox.mockReturnValueOnce(answer.promise)
  window.loadURL.mockRejectedValueOnce(new Error('local recovery failed'))
  window.webContents.emit('render-process-gone')
  await Promise.resolve()
  f.owner.emit('hide')
  f.owner.emit('focus')
  expect(native.messageBox).toHaveBeenCalledOnce()
  answer.resolve({ response: 1 })
  await Promise.resolve()
  expect(native.messageBox).toHaveBeenCalledTimes(2)
  expect(native.quit).not.toHaveBeenCalled()
  expect(f.view().policy.blocking).toBe(true)
})
