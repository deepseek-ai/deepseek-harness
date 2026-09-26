import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DesktopPolicyTestAuth } from '../src/policy-test-auth.ts'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { BrowserWindowConstructorOptions } from 'electron'

const native = vi.hoisted(() => ({ create: vi.fn<(options: BrowserWindowConstructorOptions) => object>(), partition: vi.fn() }))
vi.mock('electron', () => ({ BrowserWindow: function (options: BrowserWindowConstructorOptions) { return native.create(options) },
  session: { fromPartition: native.partition } }))

let auth: DesktopPolicyTestAuth
let browserSession: ReturnType<typeof makeSession>
let window: ReturnType<typeof makeWindow>
const record = vi.fn()
function makeSession() {
  return Object.assign(new EventEmitter(), { fetch: vi.fn(async () => Response.json({ code: 0 })),
    setPermissionRequestHandler: vi.fn<(handler: (
      contents: unknown, permission: string, callback: (allowed: boolean) => void) => void) => void>(),
    setPermissionCheckHandler: vi.fn<(handler: () => boolean) => void>(),
    setDevicePermissionHandler: vi.fn<(handler: () => boolean) => void>(),
    webRequest: { onBeforeRequest: vi.fn<(handler: (details: { resourceType: string; url: string },
      callback: (result: { cancel: boolean }) => void) => void) => void>() }, closeAllConnections: vi.fn(async () => {}),
    clearStorageData: vi.fn(async () => {}), clearAuthCache: vi.fn(async () => {}) })
}
function makeWindow() {
  let destroyed = false
  const instance = Object.assign(new EventEmitter(), { webContents: Object.assign(new EventEmitter(), {
    setWindowOpenHandler: vi.fn<(handler: () => { action: string }) => void>(), openDevTools: vi.fn() }),
  show: vi.fn(), focus: vi.fn(), setMenu: vi.fn(), loadFile: vi.fn(async () => {}),
  loadURL: vi.fn(async () => {}), isDestroyed: () => destroyed,
  destroy: () => { if (!destroyed) { destroyed = true; instance.emit('closed') } } })
  return instance
}
beforeEach(() => {
  vi.clearAllMocks()
  browserSession = makeSession(); window = makeWindow()
  native.partition.mockReturnValue(browserSession); native.create.mockReturnValue(window)
  auth = new DesktopPolicyTestAuth('https://policy.example.com', ['https://login.example.com'], resolveDesktopLocale('zh'), () => undefined, record)
})
afterEach(async () => { await auth.dispose() })

it('shares an isolated memory Session with policy fetches, without opening a login automatically', async () => {
  expect(native.partition.mock.calls[0]![0]).toMatch(/^dsh-policy-auth-/)
  expect(native.create).not.toHaveBeenCalled()
  await auth.request('https://policy.example.com/api/v0/check_client_update?scenario=manual', { credentials: 'omit', redirect: 'follow' })
  expect(browserSession.fetch).toHaveBeenCalledWith('https://policy.example.com/api/v0/check_client_update?scenario=manual',
    { credentials: 'include', redirect: 'error', cache: 'no-store' })
  await expect(auth.request('https://other.example.com/api/v0/check_client_update')).rejects.toThrow('disallowed')
  await expect(auth.request('https://policy.example.com/other')).rejects.toThrow('disallowed')
  await expect(auth.request('https://user:secret@policy.example.com/api/v0/check_client_update')).rejects.toThrow('disallowed')
  expect(browserSession.fetch).toHaveBeenCalledTimes(1)
})

it('opens a sandboxed window on explicit action and coalesces logins without authorizing an update', async () => {
  const pending = auth.login()
  expect(auth.login()).toBe(pending)
  expect(native.create).toHaveBeenCalledTimes(1)
  expect(native.create.mock.calls[0]![0]).toMatchObject({ title: '登录测试环境', webPreferences: {
    session: browserSession, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
    webviewTag: false, devTools: true } })
  expect(native.create.mock.calls[0]![0].webPreferences?.preload).toBeUndefined()
  expect(window.loadFile).toHaveBeenCalledWith('renderer/policy-login-loading.html', { query: { label: '正在加载登录页面…' } })
  // The placeholder is the first document: the remote page waits for it.
  expect(window.loadURL).not.toHaveBeenCalled()
  await vi.waitFor(() => { expect(window.loadURL).toHaveBeenCalledWith('https://policy.example.com/') })
  expect(window.loadFile).toHaveBeenCalledTimes(1)
  window.webContents.emit('did-navigate', {}, 'https://login.example.com/open-apis/authen/v1/index?state=secret')
  expect(window.isDestroyed()).toBe(false)
  window.webContents.emit('did-navigate', {}, 'https://policy.example.com/')
  expect(await pending).toBe('returned')
  expect(record.mock.calls).toEqual([['opened'], ['returned']])
  expect(browserSession.fetch).not.toHaveBeenCalled()
})

it('opens only the Feishu login window DevTools on a single F12 keydown', () => {
  void auth.login()
  const preventDefault = vi.fn()
  const press = (type: string, key: string, isAutoRepeat = false) => {
    window.webContents.emit('before-input-event', { preventDefault }, { type, key, isAutoRepeat })
  }
  press('keyDown', 'F11')
  press('keyUp', 'F12')
  press('keyDown', 'F12', true)
  expect(window.webContents.openDevTools).not.toHaveBeenCalled()
  expect(preventDefault).not.toHaveBeenCalled()
  press('keyDown', 'F12')
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(window.webContents.openDevTools).toHaveBeenCalledExactlyOnceWith({ mode: 'detach' })
})

it('shows the placeholder without letting it outlive the first remote document', async () => {
  const placeholder = { resourceType: 'mainFrame', url: 'file:///app/renderer/policy-login-loading.html?label=x' }
  const callback = vi.fn()
  // The window's own placeholder is the one document the filter accepts locally.
  browserSession.webRequest.onBeforeRequest.mock.calls[0]![0](placeholder, callback)
  expect(callback).toHaveBeenCalledWith({ cancel: false })
  window.loadFile.mockRejectedValueOnce(new Error('missing renderer document'))
  const pending = auth.login()
  // A placeholder that cannot load must not fail the login or hold it back.
  window.webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', placeholder.url, true)
  expect(window.isDestroyed()).toBe(false)
  await vi.waitFor(() => { expect(window.loadURL).toHaveBeenCalledWith('https://policy.example.com/') })
  // Entering the placeholder never covers the remote page: it is replaced by
  // navigation and is never loaded again.
  window.webContents.emit('did-navigate', {}, 'https://policy.example.com/')
  expect(await pending).toBe('returned')
  expect(window.loadFile).toHaveBeenCalledTimes(1)
})

it('cancels a login closed while the placeholder is still loading, without starting the remote page', async () => {
  const loading = Promise.withResolvers<undefined>()
  window.loadFile.mockReturnValueOnce(loading.promise)
  const pending = auth.login()
  window.destroy()
  expect(await pending).toBe('cancelled')
  loading.resolve(undefined)
  await Promise.resolve()
  expect(window.loadURL).not.toHaveBeenCalled()
})

it.each(['will-navigate', 'will-redirect'])('refuses unapproved %s targets without logging OAuth data', async (eventName) => {
  const pending = auth.login()
  const event = { preventDefault: vi.fn() }
  window.webContents.emit(eventName, event, 'https://login.example.com.evil.example/?code=secret')
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(await pending).toBe('failed')
  expect(record.mock.calls).toEqual([['opened'], ['failed']])
})

it('rejects child-frame escapes, permissions, downloads, new windows and HTTP authentication', async () => {
  const pending = auth.login()
  const preventDefault = vi.fn(), callback = vi.fn()
  browserSession.setPermissionRequestHandler.mock.calls[0]![0](null, 'camera', callback)
  expect(callback).toHaveBeenCalledWith(false)
  expect(browserSession.setPermissionCheckHandler.mock.calls[0]![0]()).toBe(false)
  expect(browserSession.setDevicePermissionHandler.mock.calls[0]![0]()).toBe(false)
  browserSession.emit('will-download', { preventDefault })
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(window.webContents.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({ action: 'deny' })
  window.webContents.emit('login', { preventDefault }, {}, {}, callback)
  expect(callback).toHaveBeenLastCalledWith()
  browserSession.webRequest.onBeforeRequest.mock.calls[0]![0]({ resourceType: 'subFrame', url: 'file:///secret' }, callback)
  expect(callback).toHaveBeenLastCalledWith({ cancel: true })
  expect(await pending).toBe('failed')
})

it.each(['https://login.example.com/', 'https://login.example.com/', 'https://login.example.com/',
  'https://login.example.com/'])('allows reviewed login documents: %s', (url) => {
  const callback = vi.fn()
  browserSession.webRequest.onBeforeRequest.mock.calls[0]![0]({ resourceType: 'mainFrame', url }, callback)
  expect(callback).toHaveBeenCalledWith({ cancel: false })
})

it('keeps manual login open until close, reports cancellation once, and permits a fresh retry', async () => {
  const pending = auth.login()
  window.destroy()
  expect(await pending).toBe('cancelled')
  window = makeWindow(); native.create.mockReturnValue(window)
  const retry = auth.login()
  window.webContents.emit('did-fail-load', {}, -105, 'raw URL error', 'https://login.example.com/?state=secret', true)
  expect(await retry).toBe('failed')
  expect(record.mock.calls).toEqual([['opened'], ['cancelled'], ['opened'], ['failed']])
})

it('awaits cleanup, closes pending login and refuses work after disposal', async () => {
  const pending = auth.login()
  const closed = Promise.withResolvers<undefined>()
  browserSession.closeAllConnections.mockReturnValueOnce(closed.promise)
  const disposal = auth.dispose()
  expect(await pending).toBe('cancelled')
  expect(browserSession.clearStorageData).not.toHaveBeenCalled()
  closed.resolve(undefined)
  await disposal
  expect(browserSession.clearStorageData).toHaveBeenCalledOnce()
  await expect(auth.login()).resolves.toBe('cancelled')
  await expect(auth.request('https://policy.example.com/api/v0/check_client_update')).rejects.toThrow('disallowed')
})
