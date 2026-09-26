import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AccountUserId } from '@deepseek-ai/dsh-deepseek-account/types'
import { DesktopPlatformView, platformBounds } from '../src/platform-view.ts'

const state = vi.hoisted(() => ({
  views: [] as unknown[], sessions: [] as unknown[], openExternal: vi.fn(async () => {}),
  loadFailure: undefined as Error | undefined, loadBarrier: undefined as Promise<void> | undefined,
}))
vi.mock('electron', () => ({
  shell: { openExternal: state.openExternal },
  session: { fromPartition: vi.fn((partition: string) => {
    const existing = state.sessions.find(value => (value as { partition: string }).partition === partition)
    if (existing !== undefined) return existing
    const value = {
      partition, webRequest: { onBeforeSendHeaders: vi.fn(), onCompleted: vi.fn(), onErrorOccurred: vi.fn() },
      setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
      clearStorageData: vi.fn(async (_options?: { storages: string[] }) => {}),
      clearCache: vi.fn(async () => {}), flushStorageData: vi.fn(),
      clearAuthCache: vi.fn(async () => {}), closeAllConnections: vi.fn(async () => {}),
      isPersistent: () => partition.startsWith('persist:'),
    }
    state.sessions.push(value)
    return value
  }) },
  WebContentsView: class {
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: 'https://platform.deepseek.com/usage' },
      session: undefined as object | undefined,
      setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn(async (_url: string) => { await state.loadBarrier; if (state.loadFailure !== undefined) throw state.loadFailure }),
      isDestroyed: () => false, close: vi.fn(() => { this.webContents.emit('destroyed') }), send: vi.fn(),
    })
    setVisible = vi.fn()
    setBounds = vi.fn()
    constructor(options: { webPreferences: { session: object } }) {
      this.webContents.session = options.webPreferences.session
      state.views.push(this)
    }
  },
}))

beforeEach(() => { vi.stubEnv('DSH_CLIENT_VERSION', '1.2.3') })
afterEach(() => {
  state.views.length = 0; state.sessions.length = 0; state.loadFailure = undefined; state.loadBarrier = undefined
  vi.clearAllMocks(); vi.unstubAllEnvs()
})
function setup() {
  const removeChildView = vi.fn()
  const owner = Object.assign(new EventEmitter(), {
    webContents: new EventEmitter(), contentView: { addChildView: vi.fn(), removeChildView }, isDestroyed: () => false,
  })
  const manager = new DesktopPlatformView('/bundled/preload.cjs', () => 'en_US', 'darwin')
  manager.setSession({ origin: 'https://platform.deepseek.com', userId: 'fixture-user' as AccountUserId, token: 'fixture-secret' })
  return { manager, owner, removeChildView }
}

/** Invoke the first registered header interceptor for one request. */
function interceptHeaders(id: number, url: string, requestHeaders: Record<string, string>): Record<string, string> {
  const browserSession = state.sessions.at(-1) as { webRequest: { onBeforeSendHeaders: ReturnType<typeof vi.fn> } }
  const handler = browserSession.webRequest.onBeforeSendHeaders.mock.calls[0]![0] as (
    details: { id: number; url: string; requestHeaders: Record<string, string> },
    callback: (value: { requestHeaders: Record<string, string> }) => void,
  ) => void
  const callback = vi.fn()
  handler({ id, url, requestHeaders }, callback)
  return (callback.mock.calls[0]![0] as { requestHeaders: Record<string, string> }).requestHeaders
}
function view() {
  return state.views.at(-1) as {
    setVisible: ReturnType<typeof vi.fn>
    webContents: EventEmitter & {
      mainFrame: { url: string }
      loadURL: ReturnType<typeof vi.fn>
      setWindowOpenHandler: ReturnType<typeof vi.fn>
      close: ReturnType<typeof vi.fn>
      send: ReturnType<typeof vi.fn>
    } }
}
const bounds = { x: 10, y: 20, width: 800, height: 600 }

it('bootstraps only the owned main frame and never puts the token in a URL', async () => {
  const { manager, owner } = setup()
  await manager.open(owner, 'usage', bounds)
  const sender = view().webContents
  const event = { sender, senderFrame: sender.mainFrame }
  expect(manager.bootstrap(event)).toEqual({ origin: 'https://platform.deepseek.com', token: 'fixture-secret', locale: 'en_US' })
  expect(sender.loadURL).toHaveBeenCalledWith('https://platform.deepseek.com/usage')
  expect(() => manager.bootstrap({ ...event, senderFrame: { url: sender.mainFrame.url } })).toThrow()
  expect(() => manager.bootstrap({ ...event, sender: {} })).toThrow()
  sender.mainFrame.url = 'https://other.example/usage'
  expect(() => manager.bootstrap(event)).toThrow()
  manager.close()
})

it('destroys old documents on sign-out or credential replacement', async () => {
  const { manager, owner } = setup()
  await manager.open(owner, 'usage', bounds)
  const first = view().webContents
  manager.setSession({ origin: 'https://platform.deepseek.com', userId: 'fixture-user' as AccountUserId, token: 'replacement' })
  expect(first.close).toHaveBeenCalledOnce()
  expect(() => manager.bootstrap({ sender: first, senderFrame: first.mainFrame })).toThrow()
  await manager.open(owner, 'top-up', bounds)
  expect(view().webContents.loadURL).toHaveBeenCalledWith('https://platform.deepseek.com/top_up')
  const second = view().webContents
  manager.setSession(null)
  expect(second.close).toHaveBeenCalledOnce()
  await expect(manager.open(owner, 'usage', bounds)).rejects.toThrow()
})

it('keeps the view when the Platform document replaces its own URL during the first load', async () => {
  const { manager, owner } = setup()
  state.loadFailure = Object.assign(new Error("ERR_ABORTED (-3) loading 'https://platform.deepseek.com/usage'"), { code: 'ERR_ABORTED' })
  await manager.open(owner, 'usage', bounds)
  expect(view().setVisible).toHaveBeenCalledWith(true)
  expect(view().webContents.close).not.toHaveBeenCalled()
  state.loadFailure = Object.assign(new Error("ERR_FAILED (-2) loading 'https://platform.deepseek.com/usage'"), { code: 'ERR_FAILED' })
  await expect(manager.open(owner, 'usage', bounds)).rejects.toThrow('ERR_FAILED')
  expect(view().webContents.close).toHaveBeenCalledOnce()
})

it('blocks cross-origin navigation and redirects', async () => {
  const { manager, owner } = setup()
  await manager.open(owner, 'usage', bounds)
  for (const name of ['will-navigate', 'will-redirect']) {
    const event = { preventDefault: vi.fn() }
    view().webContents.emit(name, event, 'https://platform.deepseek.com.evil/usage')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    event.preventDefault.mockClear()
    view().webContents.emit(name, event, 'https://platform.deepseek.com/top_up')
    expect(event.preventDefault).not.toHaveBeenCalled()
  }
  manager.close()
})

it('injects the deployment and client identity headers only at the Platform origin', async () => {
  const { manager, owner } = setup()
  manager.setSession({ origin: 'https://platform.deepseek.com', userId: null, token: 'fixture-secret',
    requestHeaders: { cookie: 'gate=synthetic', 'x-deployment': 'harness' } })
  await manager.open(owner, 'usage', bounds)
  const request = { Cookie: 'route=user', 'x-client-platform': 'stale', 'x-deployment': 'stale' }
  expect(interceptHeaders(1, 'https://platform.deepseek.com/api/v0/users/current', request)).toEqual({
    'x-deployment': 'harness', cookie: 'route=user; gate=synthetic', 'x-client-bundle-id': '',
    'x-client-platform': 'desktop-mac', 'x-client-version': '1.2.3', 'x-client-locale': 'en_US',
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
  })
  // A redirect to another origin keeps the injected headers out of the follow-up request.
  expect(interceptHeaders(1, 'https://login.example.com/authorize', request)).toEqual({})
  manager.close()
})

it('samples the language and UTC offset on every Platform request', async () => {
  let locale: 'en_US' | 'zh_CN' = 'en_US'
  const owner = Object.assign(new EventEmitter(), {
    webContents: new EventEmitter(), contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }, isDestroyed: () => false,
  })
  const manager = new DesktopPlatformView('/bundled/preload.cjs', () => locale, 'darwin')
  manager.setSession({ origin: 'https://platform.deepseek.com', userId: null, token: 'fixture-secret' })
  await manager.open(owner, 'usage', bounds)
  const offset = vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(480)
  expect(interceptHeaders(1, 'https://platform.deepseek.com/usage', {})).toMatchObject({
    'x-client-locale': 'en_US', 'x-client-timezone-offset': '-28800',
  })
  locale = 'zh_CN'
  offset.mockReturnValue(-300)
  expect(interceptHeaders(1, 'https://platform.deepseek.com/usage', {})).toMatchObject({
    'x-client-locale': 'zh_CN', 'x-client-timezone-offset': '18000',
  })
  offset.mockRestore()
  manager.close()
})

it.each([null, {}, { ...bounds, width: NaN }, { ...bounds, x: -1 }, { ...bounds, y: Infinity }])('rejects malformed IPC rectangles', (value) => {
  expect(() => platformBounds(value)).toThrow()
})

it('opens HTTPS payment links in the system browser without an embedded child window', async () => {
  const { manager, owner } = setup()
  await manager.open(owner, 'top-up', bounds)
  const handler = view().webContents.setWindowOpenHandler.mock.calls[0]![0] as (details: { url: string }) => { action: string }
  expect(handler({ url: 'https://payment.example/order' })).toEqual({ action: 'deny' })
  expect(state.openExternal).toHaveBeenCalledWith('https://payment.example/order')
  vi.mocked(state.openExternal).mockClear()
  for (const url of ['file:///tmp/test', 'javascript:alert(1)', 'https://user:pass@payment.example/order']) {
    expect(handler({ url })).toEqual({ action: 'deny' })
  }
  expect(state.openExternal).not.toHaveBeenCalled()
  manager.close()
})

it('reveals a loaded document only after loading finishes', async () => {
  const { manager, owner } = setup()
  const loaded = Promise.withResolvers<undefined>()
  state.loadBarrier = loaded.promise
  const loading = manager.open(owner, 'usage', bounds)
  await vi.waitFor(() => { expect(state.views).toHaveLength(1) })
  const active = view()
  expect(active.setVisible.mock.calls).toEqual([[false]])
  loaded.resolve(undefined)
  await loading
  expect(active.setVisible.mock.calls).toEqual([[false], [true]])
  manager.close()
})

it('does not reveal a document closed before its load settles', async () => {
  const { manager, owner } = setup()
  const loaded = Promise.withResolvers<undefined>()
  state.loadBarrier = loaded.promise
  const loading = manager.open(owner, 'usage', bounds)
  await vi.waitFor(() => { expect(state.views).toHaveLength(1) })
  const active = view()
  manager.close()
  loaded.resolve(undefined)
  await loading
  expect(active.setVisible.mock.calls).toEqual([[false]])
})

it('injects deployment headers only at the Platform origin and excludes them from bootstrap', async () => {
  const { manager, owner } = setup()
  manager.setSession({ origin: 'https://platform.deepseek.com', userId: 'fixture-user' as AccountUserId, token: 'fixture-secret',
    requestHeaders: { cookie: 'route=new; gate=private', 'x-private-gate': 'private', 'x-client-platform': 'desktop-mac' } })
  await manager.open(owner, 'usage', bounds)
  const browserSession = state.sessions.at(-1) as { webRequest: { onBeforeSendHeaders: ReturnType<typeof vi.fn> } }
  const intercept = browserSession.webRequest.onBeforeSendHeaders.mock.calls[0]![0] as (
    details: { id: number; url: string; requestHeaders: Record<string, string> },
    callback: (value: { requestHeaders: Record<string, string> }) => void,
  ) => void
  const callback = vi.fn()
  for (const path of ['/usage', '/top_up', '/api/v0/users/get_user_summary']) {
    intercept({ id: 1, url: `https://platform.deepseek.com${path}`, requestHeaders: { Cookie: 'route=old; browser=keep', Accept: 'application/json' } }, callback)
    expect(callback).toHaveBeenLastCalledWith({ requestHeaders: {
      cookie: 'route=new; browser=keep; gate=private', accept: 'application/json', 'x-private-gate': 'private', 'x-client-platform': 'desktop-mac',
      'x-client-bundle-id': '', 'x-client-version': '1.2.3', 'x-client-locale': 'en_US',
      'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
    } })
  }
  intercept({ id: 1, url: 'https://other.example/api', requestHeaders: {
    cookie: 'route=new; gate=private', 'x-private-gate': 'private', 'x-client-platform': 'desktop-mac', accept: 'application/json',
  } }, callback)
  expect(callback).toHaveBeenLastCalledWith({ requestHeaders: { accept: 'application/json' } })
  intercept({ id: 2, url: 'https://other.example/api', requestHeaders: { cookie: 'payment=session', constructor: 'keep' } }, callback)
  expect(callback).toHaveBeenLastCalledWith({ requestHeaders: { cookie: 'payment=session', constructor: 'keep' } })
  const sender = view().webContents
  expect(manager.bootstrap({ sender, senderFrame: sender.mainFrame }))
    .toEqual({ origin: 'https://platform.deepseek.com', token: 'fixture-secret', locale: 'en_US' })
  manager.close()
})

it.each(['usage', 'top-up'] as const)('selects the configured frontend deployment for %s', async (page) => {
  const { manager, owner } = setup()
  manager.setSession({ origin: 'https://platform.deepseek.com', userId: 'fixture-user' as AccountUserId, token: 'fixture-secret', embeddedPageDist: 'feat/test&other=value' })
  await manager.open(owner, page, bounds)
  const url = new URL(view().webContents.loadURL.mock.calls[0]![0] as string)
  expect(url.origin).toBe('https://platform.deepseek.com')
  expect(url.pathname).toBe(page === 'usage' ? '/usage' : '/top_up')
  expect([...url.searchParams]).toEqual([['dist', 'feat/test&other=value']])
  const previous = view().webContents
  manager.setSession({ origin: 'https://platform.deepseek.com', userId: 'fixture-user' as AccountUserId, token: 'fixture-secret', embeddedPageDist: 'another' })
  expect(previous.close).toHaveBeenCalledOnce()
  manager.close()
})

it('removes the native view when its application document reloads, without renderer cleanup', async () => {
  const { manager, owner, removeChildView } = setup()
  await manager.open(owner, 'usage', bounds)
  const child = view()
  owner.webContents.emit('did-start-navigation', {}, 'dsh-app://app/', false, true)
  expect(removeChildView).toHaveBeenCalledWith(child)
  expect(child.webContents.close).toHaveBeenCalledOnce()
  expect(owner.webContents.listenerCount('did-start-navigation')).toBe(0)
  expect(owner.listenerCount('closed')).toBe(0)
})

it('retains the view on same-document and subframe navigation', async () => {
  const { manager, owner } = setup()
  await manager.open(owner, 'usage', bounds)
  owner.webContents.emit('did-start-navigation', {}, 'dsh-app://app/#account', true, true)
  owner.webContents.emit('did-start-navigation', {}, 'about:blank', false, false)
  expect(view().webContents.close).not.toHaveBeenCalled()
  manager.close()
})

it.each(['render-process-gone', 'destroyed', 'closed'])('removes the view on owner %s', async (event) => {
  const { manager, owner } = setup()
  await manager.open(owner, 'usage', bounds)
  const child = view()
  ;(event === 'closed' ? owner : owner.webContents).emit(event)
  expect(child.webContents.close).toHaveBeenCalledOnce()
  expect(owner.webContents.listenerCount('destroyed')).toBe(0)
  expect(owner.webContents.listenerCount('render-process-gone')).toBe(0)
})

it('does not reveal a pending view after the owner reloads or remove a replacement view', async () => {
  const { manager, owner } = setup()
  const loaded = Promise.withResolvers<undefined>()
  state.loadBarrier = loaded.promise
  const loading = manager.open(owner, 'usage', bounds)
  await vi.waitFor(() => { expect(state.views).toHaveLength(1) })
  const previous = view()
  owner.webContents.emit('did-start-navigation', {}, 'dsh-app://app/', false, true)
  state.loadBarrier = undefined
  await manager.open(owner, 'top-up', bounds)
  const current = view()
  loaded.resolve(undefined)
  await loading
  expect(previous.setVisible.mock.calls).toEqual([[false]])
  expect(current.setVisible).toHaveBeenLastCalledWith(true)
  expect(current.webContents.close).not.toHaveBeenCalled()
  expect(owner.webContents.listenerCount('did-start-navigation')).toBe(1)
  manager.close()
  expect(owner.webContents.listenerCount('did-start-navigation')).toBe(0)
})

it('bootstraps the current language and updates an open view without reloading', async () => {
  const { owner } = setup()
  let locale: 'en_US' | 'zh_CN' = 'zh_CN'
  const manager = new DesktopPlatformView('/bundled/preload.cjs', () => locale, 'win32')
  manager.setSession({ origin: 'https://platform.deepseek.com', userId: 'fixture-user' as AccountUserId, token: 'fixture-secret' })
  manager.notifyLocaleChanged()
  await manager.open(owner, 'usage', bounds)
  const sender = view().webContents
  expect(manager.bootstrap({ sender, senderFrame: sender.mainFrame }).locale).toBe('zh_CN')
  locale = 'en_US'
  manager.notifyLocaleChanged()
  expect(sender.send).toHaveBeenCalledWith('dsh-platform:locale-changed', 'en_US')
  expect(sender.loadURL).toHaveBeenCalledOnce()
  manager.close()
  sender.send.mockClear()
  manager.notifyLocaleChanged()
  expect(sender.send).not.toHaveBeenCalled()
  await manager.open(owner, 'top-up', bounds)
  const reopened = view().webContents
  expect(manager.bootstrap({ sender: reopened, senderFrame: reopened.mainFrame }).locale).toBe('en_US')
  manager.close()
})

function browserSession() {
  return (state.views.at(-1) as { webContents: { session: object } }).webContents.session as {
    partition: string
    clearStorageData: ReturnType<typeof vi.fn<(options?: { storages: string[] }) => Promise<void>>>
    clearAuthCache: ReturnType<typeof vi.fn<() => Promise<void>>>
    closeAllConnections: ReturnType<typeof vi.fn<() => Promise<void>>>
    flushStorageData: ReturnType<typeof vi.fn>
    webRequest: {
      onBeforeSendHeaders: ReturnType<typeof vi.fn>
      onCompleted: ReturnType<typeof vi.fn>
      onErrorOccurred: ReturnType<typeof vi.fn>
    }
  }
}

it('reuses persistent storage across closes, token replacement, and manager recreation', async () => {
  const { manager, owner } = setup()
  await manager.open(owner, 'usage', bounds)
  const first = browserSession()
  expect(first.partition).toMatch(/^persist:dsh-platform-[a-f0-9]{64}$/)
  expect(first.partition).not.toContain('fixture-user')
  expect(first.partition).not.toContain('fixture-secret')
  manager.close()
  await manager.open(owner, 'top-up', bounds)
  expect(browserSession().partition).toBe(first.partition)
  expect(first.flushStorageData).toHaveBeenCalledOnce()
  expect(first.clearStorageData).toHaveBeenCalledWith({ storages: ['cookies', 'filesystem', 'indexdb', 'shadercache', 'serviceworkers', 'cachestorage'] })
  expect(first.clearAuthCache).toHaveBeenCalledTimes(3)
  expect(first.closeAllConnections).toHaveBeenCalledTimes(3)
  expect(first.webRequest.onBeforeSendHeaders).toHaveBeenCalledWith(null)
  expect(first.webRequest.onCompleted).toHaveBeenCalledWith(null)
  expect(first.webRequest.onErrorOccurred).toHaveBeenCalledWith(null)
  manager.setSession({ origin: 'https://platform.deepseek.com', userId: 'fixture-user' as AccountUserId, token: 'rotated' })
  await manager.open(owner, 'usage', bounds)
  expect(browserSession().partition).toBe(first.partition)
  manager.close()
  const restarted = setup().manager
  await restarted.open(owner, 'usage', bounds)
  expect(browserSession().partition).toBe(first.partition)
  restarted.close()
})

it('isolates accounts and issuers and restores the original account partition after sign-out', async () => {
  const { manager, owner } = setup()
  await manager.open(owner, 'usage', bounds)
  const first = browserSession().partition
  // The ID must invalidate even an otherwise identical credential snapshot.
  manager.setSession({ origin: 'https://platform.deepseek.com', userId: 'other-user' as AccountUserId, token: 'fixture-secret' })
  expect(view().webContents.close).toHaveBeenCalledOnce()
  await manager.open(owner, 'usage', bounds)
  const second = browserSession().partition
  expect(second).not.toBe(first)
  manager.setSession({ origin: 'https://another.example', userId: 'fixture-user' as AccountUserId, token: 'fixture-secret' })
  await manager.open(owner, 'usage', bounds)
  expect(browserSession().partition).not.toBe(first)
  expect(browserSession().partition).not.toBe(second)
  manager.setSession(null)
  manager.setSession({ origin: 'https://platform.deepseek.com', userId: 'fixture-user' as AccountUserId, token: 'signed-in-again' })
  await manager.open(owner, 'usage', bounds)
  expect(browserSession().partition).toBe(first)
  manager.close()
})

it('uses disposable storage when no stable account ID is available', async () => {
  const { manager, owner } = setup()
  manager.setSession({ origin: 'https://platform.deepseek.com', userId: null, token: 'fixture-secret' })
  await manager.open(owner, 'usage', bounds)
  const first = browserSession()
  expect(first.partition).not.toMatch(/^persist:/)
  manager.close()
  await manager.open(owner, 'usage', bounds)
  expect(browserSession().partition).not.toBe(first.partition)
  expect(first.clearStorageData).toHaveBeenCalledWith(undefined)
  manager.close()
})

it('waits for authentication cleanup before reopening and ignores superseded opens', async () => {
  const { manager, owner } = setup()
  await manager.open(owner, 'usage', bounds)
  const cleared = Promise.withResolvers<undefined>()
  browserSession().clearStorageData.mockReturnValueOnce(cleared.promise)
  manager.close()
  const obsolete = manager.open(owner, 'usage', bounds)
  const current = manager.open(owner, 'top-up', bounds)
  expect(state.views).toHaveLength(1)
  cleared.resolve(undefined)
  await Promise.all([obsolete, current])
  expect(state.views).toHaveLength(2)
  expect(view().webContents.loadURL).toHaveBeenCalledWith('https://platform.deepseek.com/top_up')
  manager.close()
})

it('does not open a view when authentication cleanup fails', async () => {
  const { manager, owner } = setup()
  await manager.open(owner, 'usage', bounds)
  browserSession().clearAuthCache.mockRejectedValue(new Error('authentication cleanup failed'))
  manager.close()
  await expect(manager.open(owner, 'usage', bounds)).rejects.toThrow('Platform storage cleanup failed')
  expect(state.views).toHaveLength(1)
  browserSession().clearAuthCache.mockResolvedValue(undefined)
  await manager.open(owner, 'usage', bounds)
  expect(state.views).toHaveLength(2)
  await manager.dispose()
})

it.each(['did-start-navigation', 'closed', 'destroyed'])('cancels allocation when owner %s during storage cleanup', async (event) => {
  const { manager, owner } = setup()
  await manager.open(owner, 'usage', bounds)
  const cleared = Promise.withResolvers<undefined>()
  browserSession().clearStorageData.mockReturnValueOnce(cleared.promise)
  const opening = manager.open(owner, 'usage', bounds)
  if (event === 'closed') owner.emit(event)
  else owner.webContents.emit(event, {}, 'dsh-app://app/', false, true)
  cleared.resolve(undefined)
  await opening
  expect(state.views).toHaveLength(1)
  expect(owner.listenerCount('closed')).toBe(0)
  await manager.dispose()
})

it('keeps failed account cleanup isolated from other accounts', async () => {
  const { manager, owner } = setup()
  await manager.open(owner, 'usage', bounds)
  browserSession().clearAuthCache.mockRejectedValue(new Error('failed'))
  manager.setSession({ origin: 'https://platform.deepseek.com', userId: 'second' as AccountUserId, token: 'second' })
  await manager.open(owner, 'usage', bounds)
  expect(state.views).toHaveLength(2)
  await expect(manager.dispose()).rejects.toThrow('Platform storage cleanup failed')
})

it('awaits cleanup on disposal and rejects subsequent opens', async () => {
  const { manager, owner } = setup()
  await manager.open(owner, 'usage', bounds)
  const cleared = Promise.withResolvers<undefined>()
  browserSession().clearStorageData.mockReturnValueOnce(cleared.promise)
  const finished = vi.fn()
  const disposing = manager.dispose().then(finished)
  await Promise.resolve()
  expect(finished).not.toHaveBeenCalled()
  cleared.resolve(undefined)
  await disposing
  expect(view().webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false })
  await expect(manager.open(owner, 'usage', bounds)).rejects.toThrow('Platform view disposed')
})

it('keeps an open temporary document when its credential gains a stable identity', async () => {
  const { manager, owner } = setup()
  manager.setSession({ origin: 'https://platform.deepseek.com', userId: null, token: 'fixture-secret' })
  await manager.open(owner, 'usage', bounds)
  manager.setSession({ origin: 'https://platform.deepseek.com', userId: 'fixture-user' as AccountUserId, token: 'fixture-secret' })
  expect(view().webContents.close).not.toHaveBeenCalled()
  expect(browserSession().partition).not.toMatch(/^persist:/)
  await manager.open(owner, 'usage', bounds)
  expect(browserSession().partition).toMatch(/^persist:/)
  await manager.dispose()
})
