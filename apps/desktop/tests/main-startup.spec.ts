import type { AccountView } from '@deepseek-ai/dsh-deepseek-account/types'
import { WINDOWS_TITLEBAR_HEIGHT } from '../src/windows-layout.ts'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { MenuItemConstructorOptions, MessageBoxOptions } from 'electron'
import { DESKTOP_IPC, type DesktopUpdateState } from '../src/ipc.ts'
import { MANDATORY_IPC } from '../src/mandatory-update-ipc.ts'
import { DesktopHostFatalError, DesktopHostUncleanExitError } from '../src/host-process.ts'
import { en, zh } from '../src/locale.ts'
import { DesktopUpdatePreparationError } from '../src/update-error.ts'
import { writeCrashReport } from '../src/crash-report.ts'

type InvokeEvent = { sender?: unknown; senderFrame: { url: string } }
type InvokeHandler = (event: InvokeEvent, ...args: unknown[]) => unknown

vi.mock('../src/web-document.ts', () => ({ authenticateWebHost: async () => 'test-cookie', serveWebDocument: vi.fn(), forwardWebRequest: vi.fn() }))
// Report persistence has its own unit tests; here it resolves within microtasks so the fatal
// dialog never outlives the test that triggered it.
vi.mock('../src/crash-report.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/crash-report.ts')>(),
  writeCrashReport: vi.fn(async () => 'desktop-test-logs/crash-test.log'),
  pruneCrashReports: vi.fn(async () => {}),
}))

const harness = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  function deferred() {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((accept, decline) => { resolve = accept; reject = decline })
    return { promise, resolve, reject }
  }
  const windows: FakeWindow[] = []
  let windowFailure: Error | undefined
  const powerMonitor = new EventEmitter()
  const hosts: FakeHost[] = []
  const handlers = new Map<string, InvokeHandler>()
  let pluginsEnabled = false
  let prepareUpdate: (() => Promise<boolean>) | undefined
  let publishUpdate: ((state: DesktopUpdateState) => DesktopUpdateState) | undefined
  let preparing = deferred()
  let prepared = deferred()
  let hostStarted = deferred()
  let navigated = deferred()
  let dialogShown = deferred()
  let quitCompleted = deferred()
  let policyBlocked = deferred()
  let embeddedPolicy: unknown
  let closeWindowsOnQuit = false
  let updateState: DesktopUpdateState = { phase: 'idle' }
  let platformDisposeDeferred: ReturnType<typeof deferred> | undefined
  // The native Platform view owns persistent browser storage; Desktop startup tests replace it so
  // each quit can control when that cleanup settles.
  const platformDispose = vi.fn(() => platformDisposeDeferred?.promise ?? Promise.resolve())
  let platformCloseDeferred: ReturnType<typeof deferred> | undefined
  const platformCloseAndWait = vi.fn(() => platformCloseDeferred?.promise ?? Promise.resolve())
  const readLoginShell = async (base: NodeJS.ProcessEnv) => ({
    environment: { ...base, DSH_TEST_LOGIN_SHELL: 'login' }, failures: [{ shell: '/account/shell', reason: 'timeout' }],
  })
  const loginShell = vi.fn((base: NodeJS.ProcessEnv, _config: unknown, _options: { signal?: AbortSignal }) => readLoginShell(base))
  const updateCheck = vi.fn(async (_manual?: boolean): Promise<DesktopUpdateState> => updateState)
  const updateDownload = vi.fn(async (_version: string): Promise<DesktopUpdateState> => updateState)
  const updateInstall = vi.fn(async (_version: string): Promise<DesktopUpdateState> => updateState)
  const popup = vi.fn<(options: { window: FakeWindow; x?: number; y?: number; callback?: () => void }) => void>()
  const menuBuilder = vi.fn<(template: MenuItemConstructorOptions[]) => { popup: typeof popup }>(() => ({ popup }))
  const menu = Object.assign(menuBuilder, { buildFromTemplate: menuBuilder, setApplicationMenu: vi.fn() })
  class FakeWindow extends EventEmitter {
    destroyed = false
    readonly urls: string[] = []
    readonly webContents = Object.assign(new EventEmitter(), {
      id: 42,
      setWindowOpenHandler: vi.fn(),
      insertCSS: vi.fn(async () => 'blur'),
      removeInsertedCSS: vi.fn(async () => {}),
      openDevTools: vi.fn(),
      getURL: () => this.urls.at(-1) ?? '',
      mainFrame: { url: '' },
      getZoomFactor: () => 1,
      isDestroyed: () => this.destroyed,
      setIgnoreMenuShortcuts: vi.fn(),
      focus: vi.fn(),
      sendInputEvent: vi.fn(),
      send: vi.fn((channel: string, state: { policy?: { blocking: boolean } }) => {
        if (channel === 'dsh-desktop:mandatory-state' && state.policy?.blocking) policyBlocked.resolve()
      }),
    })
    readonly shown = deferred()
    readonly show = vi.fn(() => { this.shown.resolve() })
    readonly hide = vi.fn()
    readonly focus = vi.fn()
    readonly moveTop = vi.fn()
    readonly setAlwaysOnTop = vi.fn()
    readonly restore = vi.fn()
    readonly setSize = vi.fn()
    readonly getBounds = vi.fn(() => ({ x: 0, y: 0, width: 800, height: 700 }))
    readonly setMinimumSize = vi.fn()
    readonly setTitleBarOverlay = vi.fn()
    readonly setVibrancy = vi.fn()
    readonly setBackgroundColor = vi.fn()
    constructor(readonly options: { show: boolean; modal?: boolean }) {
      super(); if (windowFailure !== undefined) throw windowFailure; windows.push(this)
    }
    isDestroyed() { return this.destroyed }
    fullscreen = false
    isFullScreen() { return this.fullscreen }
    readonly setFullScreen = vi.fn((flag: boolean) => { this.fullscreen = flag; this.emit(flag ? 'enter-full-screen' : 'leave-full-screen') })
    minimized = false
    isMinimized() { return this.minimized }
    visible = true
    isVisible() { return this.visible }
    isFocused() { return true }
    async loadURL(url: string) {
      this.urls.push(url)
      this.webContents.mainFrame.url = url
      if (url === 'dsh-app://app/') navigated.resolve()
    }
    static getAllWindows() { return windows.filter(window => !window.destroyed) }
    setMenu() {}
    getContentBounds() { return { x: 0, y: 0, width: 900, height: 650 } }
    setBounds() {}
    setTitle = vi.fn()
    destroy() { this.destroyed = true; this.emit('closed') }
    close() {
      const event = { preventDefault: vi.fn() }
      this.emit('close', event)
      if (event.preventDefault.mock.calls.length === 0) this.destroy()
    }
  }
  class FakeHost {
    readonly updateTasks = vi.fn(async (_action: 'inspect' | 'lock' | 'unlock') => false)
    readonly inspectQuit = vi.fn(async () => ({ activeTasks: false, scheduledTasks: false }))
    url = 'http://127.0.0.1:3080/?token=test'
    fetch = vi.fn(async () => Response.json({ hasApiKey: true, writable: true, localePreference: null }))
    readonly ready = deferred()
    readonly exited = deferred()
    readonly stopping = deferred()
    readonly start = vi.fn(() => { hostStarted.resolve(); return this.ready.promise.then(() => ({ url: this.url, injections: [] })) })
    readonly stop = vi.fn(() => {
      this.stopping.resolve()
      this.ready.reject(new Error('child stopped'))
      return this.exited.promise
    })
    constructor(
      readonly node: string, readonly runtime: string, readonly profile: string,
      readonly inspectPort?: number, readonly environment?: NodeJS.ProcessEnv, readonly onFailure?: (error: Error) => void,
      readonly primaryRuntime?: string,
      readonly packageManager?: { pnpm: string; nodeBin: string },
    ) { hosts.push(this) }
  }
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    name: 'Desktop test',
    whenReady: () => Promise.resolve(),
    getLocale: (): string => 'en-US',
    getPreferredSystemLanguages: () => ['en-US'],
    getVersion: () => '1.0.0',
    getAppPath: (): string => 'desktop-test-app',
    setAppLogsPath: vi.fn(),
    getPath: vi.fn<(name: string) => string>(),
    setAboutPanelOptions: vi.fn<(options: Electron.AboutPanelOptionsOptions) => void>(),
    requestSingleInstanceLock: () => true,
    setAsDefaultProtocolClient: vi.fn(),
    exit: vi.fn(),
    relaunch: vi.fn(),
    focus: vi.fn(),
    quit: vi.fn(() => {
      const event = { preventDefault: vi.fn() }
      app.emit('before-quit', event)
      if (event.preventDefault.mock.calls.length === 0) {
        if (closeWindowsOnQuit) for (const window of [...windows]) if (!window.isDestroyed()) window.close()
        if (!closeWindowsOnQuit || windows.every(window => window.isDestroyed())) quitCompleted.resolve()
      }
    }),
  })
  let accountListener: ((state: AccountView) => void) | undefined
  let analyticsEnabled = true
  let analyticsEnabledListener: ((enabled: boolean) => void) | undefined
  const analytics = vi.fn(async (_event: unknown) => {})
  const nativeTheme = { themeSource: 'system', shouldUseDarkColors: false }
  const trays: FakeTray[] = []
  class FakeTray extends EventEmitter {
    readonly setToolTip = vi.fn()
    readonly setContextMenu = vi.fn()
    readonly destroy = vi.fn()
    constructor(readonly image: unknown) { super(); trays.push(this) }
  }
  const backgroundNotice = { close: vi.fn((hide: () => void) => { hide() }), dispose: vi.fn(), markerPath: undefined as string | undefined }
  const shellDialog = { isOpen: false, focus: vi.fn() }
  return {
    failWindow(error: Error) { windowFailure = error },
    windows, hosts, handlers, app, FakeWindow, FakeHost, powerMonitor, nativeTheme, analytics,
    trays, FakeTray, backgroundNotice, shellDialog,
    menu, popup, socketHeaders: vi.fn(), loginShell, readLoginShell, updateCheck, updateDownload, updateInstall,
    platformDispose,
    platformCloseAndWait,

    get analyticsEnabled() { return analyticsEnabled },
    set analyticsEnabled(value: boolean) { analyticsEnabled = value; analyticsEnabledListener?.(value) },
    watchAccount: (
      listener: (state: AccountView) => void, _failed: () => void, _expired: () => void,
      onAnalyticsEnabledChanged?: (enabled: boolean) => void,
    ) => {
      analyticsEnabledListener = onAnalyticsEnabledChanged
      accountListener = listener
      return () => { accountListener = undefined; analyticsEnabledListener = undefined }
    },
    publishAccount(state: AccountView) { accountListener?.(state) },
    ipcOn: vi.fn<(channel: string, listener: (event: { sender: unknown; senderFrame: unknown }, ...args: unknown[]) => void) => void>(),
    get updateState() { return updateState },
    set updateState(value: DesktopUpdateState) { updateState = value },
    get prepareUpdate() { return prepareUpdate! },
    set prepareUpdate(value: () => Promise<boolean>) { prepareUpdate = value },
    get publishUpdate() { return publishUpdate! },
    set publishUpdate(value: (state: DesktopUpdateState) => DesktopUpdateState) { publishUpdate = value },
    dialog: { showOpenDialog: vi.fn(), showErrorBox: vi.fn(), showMessageBox: vi.fn() },
    openExternal: vi.fn(async () => {}),
    protocolHandle: vi.fn<(scheme: string, handler: (request: Request) => Response | Promise<Response>) => void>(),
    applyRelease: vi.fn(() => { preparing.resolve(); return prepared.promise }),
    disableAllPlugins: vi.fn(async () => {
      pluginsEnabled = false
      return 'desktop-test-profile/cordis.patch.yml.bak-1789555200000'
    }),
    get preparing() { return preparing }, get prepared() { return prepared },
    get hostStarted() { return hostStarted }, get navigated() { return navigated },
    get dialogShown() { return dialogShown }, get quitCompleted() { return quitCompleted },
    get policyBlocked() { return policyBlocked },
    get embeddedPolicy() { return embeddedPolicy },
    set embeddedPolicy(value: unknown) { embeddedPolicy = value },
    nextNavigation() { navigated = deferred(); return navigated.promise },
    nextHostStart() { hostStarted = deferred(); return hostStarted.promise },
    deferPlatformDispose() { platformDisposeDeferred = deferred(); return platformDisposeDeferred },
    deferPlatformClose() { platformCloseDeferred = deferred(); return platformCloseDeferred },
    get pluginsEnabled() { return pluginsEnabled },
    set pluginsEnabled(value: boolean) { pluginsEnabled = value },
    set closeWindowsOnQuit(value: boolean) { closeWindowsOnQuit = value },
    reset() {
      accountListener = undefined
      windows.length = 0; hosts.length = 0; handlers.clear(); app.removeAllListeners()
      trays.length = 0
      backgroundNotice.markerPath = undefined
      shellDialog.isOpen = false
      powerMonitor.removeAllListeners()
      app.isPackaged = true
      windowFailure = undefined
      pluginsEnabled = false
      closeWindowsOnQuit = false
      prepareUpdate = undefined
      publishUpdate = undefined
      updateState = { phase: 'idle' }
      updateCheck.mockReset().mockImplementation(async () => updateState)
      loginShell.mockReset().mockImplementation(base => readLoginShell(base))
      updateDownload.mockReset().mockImplementation(async () => updateState)
      updateInstall.mockReset().mockImplementation(async () => updateState)
      nativeTheme.themeSource = 'system'; nativeTheme.shouldUseDarkColors = false
      preparing = deferred(); prepared = deferred(); hostStarted = deferred()
      navigated = deferred(); dialogShown = deferred(); quitCompleted = deferred()
      policyBlocked = deferred()
      embeddedPolicy = undefined
      platformDisposeDeferred = undefined
      platformCloseDeferred = undefined
    },
  }
})

const testAuth = vi.hoisted(() => ({ login: vi.fn<() => Promise<'returned' | 'cancelled' | 'failed'>>(),
  focus: vi.fn(), dispose: vi.fn(async () => {}) }))
vi.mock('../src/policy-test-auth.ts', () => ({ DesktopPolicyTestAuth: class {
  readonly login = testAuth.login
  readonly focus = testAuth.focus
  readonly dispose = testAuth.dispose
  readonly request: typeof fetch = (input, init) => fetch(input, init)
} }))

vi.mock('electron', () => ({
  app: harness.app,
  BrowserWindow: harness.FakeWindow,
  dialog: harness.dialog,
  shell: { openExternal: harness.openExternal },
  nativeTheme: harness.nativeTheme,
  net: { fetch: vi.fn() },
  ipcMain: {
    on: harness.ipcOn,
    handle: (channel: string, handler: InvokeHandler) => {
      if (harness.handlers.has(channel)) throw new Error(`duplicate IPC handler ${channel}`)
      harness.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => { harness.handlers.delete(channel) },
  },
  Menu: { setApplicationMenu: harness.menu.setApplicationMenu, buildFromTemplate: harness.menu },
  session: { defaultSession: {
    setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(), webRequest: { onBeforeSendHeaders: harness.socketHeaders },
  } },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: harness.protocolHandle },
  powerMonitor: harness.powerMonitor,
  Tray: harness.FakeTray,
  nativeImage: { createFromPath: (path: string) => ({ path }) },
}))
vi.mock('../src/background-notice.ts', () => ({ DesktopBackgroundNotice: class {
  constructor(options: { markerPath: string }) { harness.backgroundNotice.markerPath = options.markerPath }
  readonly close = harness.backgroundNotice.close
  readonly dispose = harness.backgroundNotice.dispose
} }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, readFile: vi.fn((path: Parameters<typeof original.readFile>[0], encoding?: 'utf8') => {
    if (path === join('desktop-test-app', 'package.json')) {
      return Promise.resolve(JSON.stringify({ dshDesktopAppId: 'com.deepseek.dsh', dshMandatoryUpdatePolicy: harness.embeddedPolicy }))
    }
    return encoding === undefined ? original.readFile(path) : original.readFile(path, encoding)
  }) }
})
vi.mock('../src/login-shell-environment.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/login-shell-environment.ts')>(),
  readDesktopLoginShellEnvironment: harness.loginShell,
}))
vi.mock('../src/runtime-tree.ts', () => ({ readDesktopRuntime: () => ({ release: { version: '1.0.0' } }) }))
vi.mock('../src/paths.ts', () => ({ resolveDesktopPaths: () => ({ profile: 'desktop-test-profile' }) }))
vi.mock('../src/project-manager.ts', () => ({
  DesktopProjectManager: class {
    readonly applyRelease = harness.applyRelease
    disableAllPlugins = harness.disableAllPlugins

  },
}))
vi.mock('../src/host-process.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/host-process.ts')>(), DesktopHostProcess: harness.FakeHost,
}))
vi.mock('../src/update-dialog.ts', () => ({ DesktopUpdateDialog: class {
  get isOpen() { return harness.shellDialog.isOpen }
  show(owner: { options: { modal?: boolean } }, options: unknown) {
    return (owner.options.modal ? harness.dialog.showMessageBox(owner, options)
      : harness.dialog.showMessageBox(options)) as Promise<Electron.MessageBoxReturnValue>
  }
  cancel() {}
  readonly focus = harness.shellDialog.focus
  dispose() {}
} }))
vi.mock('../src/update-coordinator.ts', () => ({ DesktopUpdateCoordinator: class {
  constructor(publish: (state: DesktopUpdateState) => DesktopUpdateState, beforeRestart: () => Promise<boolean>) {
    harness.prepareUpdate = beforeRestart
    harness.publishUpdate = publish
  }
  get state() { return harness.updateState }
  readonly check = harness.updateCheck
  readonly download = harness.updateDownload
  readonly install = harness.updateInstall
  readonly dispose = vi.fn()
} }))
vi.mock('../src/platform-view.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/platform-view.ts')>(),
  DesktopPlatformView: class {
    notifyLocaleChanged() {}
    setSession() {}
    setBounds() {}
    close() {}
    closeAndWait(): Promise<void> { return harness.platformCloseAndWait() }
    dispose(): Promise<void> { return harness.platformDispose() }
  },
}))
vi.mock('../src/welcome-backend.ts', () => ({
  connectDesktopWelcome: async () => ({
    analyticsEnabled: async () => harness.analyticsEnabled,
    report: harness.analytics,
    readLocalePreference: async () => null,
    read: async (): Promise<unknown> => (await harness.hosts.at(-1)!.fetch()).json() as Promise<unknown>,
    save: async () => ({ ok: true }),
    account: { watch: harness.watchAccount, state: async () => ({ status: 'signed-out', attempt: null }) },
  }),
}))

function invoke(channel: string, origin = channel === DESKTOP_IPC.boot ? 'app' : 'shell', ...args: unknown[]): unknown {
  const handler = harness.handlers.get(channel)
  if (handler === undefined) throw new Error(`missing handler ${channel}`)
  if (origin === 'app') {
    const sender = harness.windows[0]!.webContents
    return handler({ sender, senderFrame: sender.mainFrame }, ...args)
  }
  return handler({ senderFrame: { url: `dsh-app://${origin}/index.html` } }, ...args)
}

function applicationMenuItems(): MenuItemConstructorOptions[] {
  const native = harness.menu.mock.calls[0]?.[0][0]?.submenu
  if (Array.isArray(native)) return native
  const sender = harness.windows[0]!.webContents
  void harness.handlers.get(DESKTOP_IPC.windowsMenu)!({ sender, senderFrame: sender.mainFrame }, 'application', 0, 0)
  return harness.menu.mock.lastCall![0]
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  harness.dialog.showMessageBox.mockReset()
  harness.dialog.showMessageBox.mockResolvedValue({ response: 1 })
  testAuth.login.mockReset()
  testAuth.login.mockResolvedValue('cancelled')
  vi.useFakeTimers()
  harness.reset()
  const userData = mkdtempSync(join(tmpdir(), 'dsh-main-user-data-'))
  onTestFinished(() => { rmSync(userData, { recursive: true, force: true }) })
  harness.app.getPath.mockImplementation(name => name === 'userData' ? userData : `desktop-test-${name}`)
  harness.dialog.showMessageBox.mockImplementation((options: { title?: string }) => {
    if (options.title !== en.startupFailed) return Promise.resolve({ response: 1 })
    harness.dialogShown.resolve()
    return new Promise(() => {})
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubEnv('DSH_DESKTOP_PNPM_ENTRY', 'test-pnpm')
  vi.stubEnv('DSH_DESKTOP_DSH_DIR', 'test-runtime')
  vi.stubEnv('DSH_DESKTOP_PRIMARY_RUNTIME_DIR', 'test-primary-runtime')
  vi.stubGlobal('process', { ...process, platform: 'win32', arch: 'x64', resourcesPath: 'desktop-test-resources' })
  vi.stubEnv('DSH_DESKTOP_HOST_INSPECT_PORT', undefined)
  vi.stubEnv('DSH_DESKTOP_DEV_PROJECT_DIR', undefined)
  vi.stubEnv('DSH_DESKTOP_MANDATORY_UPDATE_CONFIG', undefined)
  vi.stubEnv('DSH_DESKTOP_UPDATE_JOURNAL_DIR', undefined)
  vi.stubEnv('DSH_CLIENT_VERSION', '1.2.3')
  harness.analyticsEnabled = true
})

afterEach(async () => {
  harness.prepared.resolve()
  for (const host of harness.hosts) { host.ready.resolve(); host.exited.resolve() }
  harness.app.quit()
  // The quit decides asynchronously; a Host that starts meanwhile must still be released.
  await vi.advanceTimersByTimeAsync(0)
  for (const host of harness.hosts) { host.ready.resolve(); host.exited.resolve() }
  await harness.quitCompleted.promise
  vi.restoreAllMocks()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('desktop main startup', () => {
  it('routes shell update documents and assets through the registered main protocol handler', async () => {
    const root = join(import.meta.dirname, '..')
    vi.spyOn(harness.app, 'getAppPath').mockReturnValue(root)
    const web = await import('../src/web-document.ts')
    const actual = await vi.importActual<typeof import('../src/web-document.ts')>('../src/web-document.ts')
    vi.mocked(web.serveWebDocument).mockImplementation(actual.serveWebDocument)
    try {
      await readyForUpdate()
      const { protocol } = await import('electron')
      const handler = vi.mocked(protocol).handle.mock.calls.at(-1)?.[1]
      if (handler === undefined) throw new Error('main did not register its protocol handler')
      for (const [name, mime] of [
        ['update-dialog.html', 'text/html'], ['update-dialog.css', 'text/css'], ['update-dialog.js', 'text/javascript'],
        ['mandatory-update.html', 'text/html'], ['mandatory-update.css', 'text/css'], ['mandatory-update.js', 'text/javascript'],
        ['update-close.svg', 'image/svg+xml'],
      ] as const) {
        const response = await handler(new Request(`dsh-app://shell/${name}`))
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain(mime)
        expect(await response.text()).toBe(readFileSync(join(root, 'renderer', name), 'utf8'))
      }
      const head = await handler(new Request('dsh-app://shell/update-dialog.html', { method: 'HEAD' }))
      expect(head.status).toBe(200)
      expect(await head.text()).toBe('')
      expect((await handler(new Request('dsh-app://shell/update-dialog.html', { method: 'POST' }))).status).toBe(405)
      expect((await handler(new Request('dsh-app://shell/%'))).status).toBe(400)
      expect((await handler(new Request('dsh-app://shell/%2e%2e%2fpackage.json'))).status).toBe(403)
      expect((await handler(new Request('dsh-app://shell/missing.html'))).status).toBe(404)
      expect((await handler(new Request('dsh-app://other/update-dialog.html'))).status).toBe(404)
    } finally {
      vi.mocked(web.serveWebDocument).mockReset()
    }
  })

  it('serves shell dialogs and their assets without forwarding them to the Host', async () => {
    await readyForUpdate()
    const { serveWebDocument, forwardWebRequest } = await import('../src/web-document.ts')
    const handler = harness.protocolHandle.mock.calls[0]![1]
    for (const file of ['update-dialog.html', 'update-dialog.js', 'update-dialog.css', 'update-close.svg', 'mandatory-update.html']) {
      const request = new Request(`dsh-app://shell/${file}`)
      await handler(request)
      expect(serveWebDocument).toHaveBeenLastCalledWith(request, join('desktop-test-app', 'renderer'))
    }
    expect(forwardWebRequest).not.toHaveBeenCalled()
    expect((await handler(new Request('dsh-app://unknown/update-dialog.html'))).status).toBe(404)
  })

  it('installs hidden native DevTools shortcuts in the macOS application menu', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    await readyForUpdate()
    expect(applicationMenuItems().slice(-2)).toEqual([
      { role: 'toggleDevTools', visible: false },
      { role: 'toggleDevTools', visible: false, accelerator: 'F12' },
    ])
    expect(harness.windows[0]!.options).toMatchObject({ webPreferences: { devTools: true } })
  })

  it.each([
    ['darwin', true, 'en-US'],
    ['darwin', false, 'zh-CN'],
    ['win32', true, 'zh-CN'],
    ['win32', false, 'en-US'],
  ] as const)('offers the About command before other commands on %s (packaged=%s, locale=%s)', async (platform, packaged, locale) => {
    vi.stubGlobal('process', { ...process, platform })
    harness.app.isPackaged = packaged
    vi.spyOn(harness.app, 'getLocale').mockReturnValue(locale)
    vi.spyOn(harness.app, 'getPreferredSystemLanguages').mockReturnValue([locale])
    vi.spyOn(harness.app, 'getPreferredSystemLanguages').mockReturnValue([locale])
    await readyForUpdate()
    const submenu = applicationMenuItems()
    const options = harness.app.setAboutPanelOptions.mock.calls[0]![0]
    const expected = JSON.parse(readFileSync(new URL('./expected/about-panel.json', import.meta.url), 'utf8')) as Record<string, unknown>
    const [about, separator] = submenu
    expect({ menu: [{ label: about!.label, role: about!.role }, separator], options: { ...options, iconPath: '<app icon>' } })
      .toEqual(expected[`${platform}:${locale}`])
    expect(options.iconPath).toBe(packaged ? join('desktop-test-resources', 'icon.png')
      : join('desktop-test-app', 'resources', 'icon-windows.png'))
    if (platform !== 'win32') { expect(about!.click).toBeUndefined(); return }
    // Windows reuses the dimmed update dialog because Electron's fallback is a bare message box.
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    ;(about!.click as () => void)()
    await vi.advanceTimersByTimeAsync(0)
    const zh = locale === 'zh-CN'
    expect(harness.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'info', title: zh ? '关于 DeepSeek Harness' : 'About DeepSeek Harness', message: 'DeepSeek Harness',
      detail: zh ? '版本 V1.0.0' : 'Version V1.0.0', buttons: [zh ? '确定' : 'OK'], cancelId: 0,
    }))
    // A dialog that cannot open is logged, not surfaced as an unhandled rejection.
    harness.dialog.showMessageBox.mockRejectedValueOnce(new Error('overlay unavailable'))
    ;(about!.click as () => void)()
    await vi.advanceTimersByTimeAsync(0)
    expect(console.error).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'overlay unavailable' }))
  })

  it('shows one explained startup login before Host readiness and joins concurrent checks without reopening it', async () => {
    harness.embeddedPolicy = { origin: 'https://policy.example.com', authentication: 'feishu-test', allowedAuthOrigins: ['https://login.example.com'],
      allowedPageOrigins: ['https://downloads.example.com'], intervalMs: 1000, jitter: 0 }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 })))
    const explanation = Promise.withResolvers<{ response: number }>()
    const explained = Promise.withResolvers<undefined>()
    const login = Promise.withResolvers<'cancelled'>()
    const entered = Promise.withResolvers<undefined>()
    harness.dialog.showMessageBox.mockImplementationOnce(() => { explained.resolve(undefined); return explanation.promise })
    testAuth.login.mockImplementationOnce(() => { entered.resolve(undefined); return login.promise })
    const checks: Promise<unknown>[] = []
    try {
      await import('../src/main.ts')
      await explained.promise
      expect(harness.hosts).toHaveLength(0)
      expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
      expect(harness.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
        message: en.policyLoginRequired, buttons: [en.policyLogin, en.later], cancelId: 1,
      }))
      checks.push(Promise.resolve(invoke(DESKTOP_IPC.updatesOpen, 'app')))
      expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
      expect(testAuth.login).not.toHaveBeenCalled()
      explanation.resolve({ response: 0 })
      await entered.promise
      checks.push(Promise.resolve(invoke(DESKTOP_IPC.updatesOpen, 'app')))
      expect(testAuth.focus).toHaveBeenCalled()
      expect(testAuth.login).toHaveBeenCalledOnce()
      expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
      login.resolve('cancelled')
      await Promise.all(checks)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(testAuth.login).toHaveBeenCalledOnce()
      const messages = harness.dialog.showMessageBox.mock.calls.map(call => (call.at(-1) as { message: string }).message)
      expect(messages.filter(message => message === en.policyLoginRequired)).toHaveLength(1)
      expect(messages).toContain('You’re up to date!')
    } finally {
      explanation.resolve({ response: 1 })
      login.resolve('cancelled')
      await Promise.allSettled(checks)
    }
  })

  it.each(['returned', 'cancelled', 'failed'] as const)('requires explicit test login and handles %s without downloading', async (outcome) => {
    harness.embeddedPolicy = { origin: 'https://policy.example.com', authentication: 'feishu-test', allowedAuthOrigins: ['https://login.example.com'],
      allowedPageOrigins: ['https://downloads.example.com'], intervalMs: 10_000, jitter: 0 }
    const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 }))
    vi.stubGlobal('fetch', request)
    await readyForUpdate()
    await vi.advanceTimersByTimeAsync(0)
    expect(testAuth.login).not.toHaveBeenCalled()
    expect(harness.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ message: en.policyLoginRequired }))
    harness.dialog.showMessageBox.mockClear()
    testAuth.login.mockImplementationOnce(async () => {
      request.mockImplementation(async () => Response.json({ code: 0, data: { biz_code: 0, biz_data: null } }))
      return outcome
    })
    harness.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    await invoke(DESKTOP_IPC.updatesOpen, 'app')
    expect(testAuth.login).toHaveBeenCalledOnce()
    expect(harness.dialog.showMessageBox.mock.calls.map(call => call.at(-1) as unknown)).toContainEqual(expect.objectContaining({
      message: en.policyLoginRequired, buttons: [en.policyLogin, en.later],
    }))
    expect(harness.updateDownload).not.toHaveBeenCalled()
    expect(harness.updateInstall).not.toHaveBeenCalled()
    const messages = harness.dialog.showMessageBox.mock.calls.map(call => (call.at(-1) as { message: string }).message)
    const expected = JSON.parse(readFileSync(new URL('./expected/policy-login-en.json', import.meta.url), 'utf8')) as Record<string, string[]>
    expect(messages).toEqual(expected[outcome])
  })

  it('does not open Feishu when the user declines test login', async () => {
    harness.embeddedPolicy = { origin: 'https://policy.example.com', authentication: 'feishu-test', allowedAuthOrigins: ['https://login.example.com'],
      allowedPageOrigins: ['https://downloads.example.com'] }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 })))
    await readyForUpdate()
    harness.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    await invoke(DESKTOP_IPC.updatesOpen, 'app')
    expect(testAuth.login).not.toHaveBeenCalled()
  })

  it('does not require gateway login to download an already available ordinary update', async () => {
    harness.embeddedPolicy = { origin: 'https://policy.example.com', authentication: 'feishu-test', allowedAuthOrigins: ['https://login.example.com'],
      allowedPageOrigins: ['https://downloads.example.com'] }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 })))
    await readyForUpdate()
    await vi.advanceTimersByTimeAsync(0)
    harness.updateState = { phase: 'available', version: '1.0.1-nightly.1' }
    await invoke(DESKTOP_IPC.updatesOpen, 'app')
    expect(harness.updateDownload).toHaveBeenCalledWith('1.0.1-nightly.1')
    expect(testAuth.login).not.toHaveBeenCalled()
  })

  it('retains the embedded block and running Host after expired test login is cancelled', async () => {
    harness.embeddedPolicy = { origin: 'https://policy.example.com', authentication: 'feishu-test', allowedAuthOrigins: ['https://login.example.com'],
      allowedPageOrigins: ['https://downloads.example.com'], intervalMs: 1000, jitter: 0 }
    const request = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ code: 40005, data: { show_content: { title: 'Update', detail: 'Required' },
        desktop_app_link: 'https://downloads.example.com/' } }))
    vi.stubGlobal('fetch', request)
    const host = await readyForUpdate()
    await harness.policyBlocked.promise
    await vi.advanceTimersByTimeAsync(1000)
    const modal = harness.windows[0]!
    const owned = { sender: modal.webContents, senderFrame: modal.webContents.mainFrame }
    harness.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    testAuth.login.mockResolvedValueOnce('cancelled')
    await harness.handlers.get(MANDATORY_IPC.action)!(owned, 'refresh')
    expect(testAuth.login).toHaveBeenCalledOnce()
    expect(harness.handlers.get(MANDATORY_IPC.status)!(owned)).toMatchObject({
      policy: { blocking: true, error: 'authentication-required' },
    })
    expect(modal.isDestroyed()).toBe(false)
    expect(host.stop).not.toHaveBeenCalled()
    expect(harness.updateDownload).not.toHaveBeenCalled()
  })

  it('persists opt-in update evidence from the real main entry without private diagnostics', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-main-update-journal-'))
    try {
      vi.stubEnv('DSH_DESKTOP_UPDATE_JOURNAL_DIR', directory)
      await readyForUpdate()
      harness.publishUpdate({ phase: 'error', failedOperation: 'download', version: '1.2.3', message: 'ENOSPC secret-url' })
      const checkUpdates = applicationMenuItems().find(item => item.label === en.checkUpdatesMenu)!.click as () => void
      checkUpdates()
      await vi.advanceTimersByTimeAsync(0)
      for (const host of harness.hosts) host.exited.resolve()
      harness.app.quit()
      await harness.quitCompleted.promise
      const files = readdirSync(directory)
      expect(files).toHaveLength(1)
      const contents = readFileSync(join(directory, files[0]!), 'utf8')
      const records = contents.trim().split('\n').map(line => JSON.parse(line) as { event: string })
      expect(records.map(row => row.event)).toEqual(expect.arrayContaining(['started', 'workspace-ready', 'state', 'check-requested', 'quit-requested']))
      expect(contents).toContain('ENOSPC')
      expect(contents).not.toContain('secret-url')
    } finally {
      // The existing teardown calls quit again; retain its journal until listeners are removed.
      harness.app.removeAllListeners('before-quit')
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('accepts product IPC only from the current application top frame in the owned main window', async () => {
    await readyForUpdate()
    const sender = harness.windows[0]!.webContents
    for (const channel of [DESKTOP_IPC.updatesStatus, DESKTOP_IPC.deviceInfo]) {
      const handler = harness.handlers.get(channel)!
      expect(() => handler({ sender, senderFrame: sender.mainFrame })).not.toThrow()
      for (const event of [
        { sender: {}, senderFrame: sender.mainFrame },
        { sender, senderFrame: { url: sender.mainFrame.url } },
        { sender, senderFrame: { url: 'http://127.0.0.1:40000/' } },
      ]) expect(() => handler(event)).toThrow('unowned renderer')
      const original = sender.mainFrame.url
      sender.mainFrame.url = 'http://127.0.0.1:40000/'
      expect(() => handler({ sender, senderFrame: sender.mainFrame })).toThrow('unowned renderer')
      sender.mainFrame.url = original
    }
  })

  it.each(['darwin', 'win32', 'linux'] as const)('limits native titlebar styling to macOS on %s', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    expect(window.urls).toEqual(['dsh-app://app/'])
    if (platform === 'darwin') {
      expect(window.options).toMatchObject({ titleBarStyle: 'hiddenInset', vibrancy: 'sidebar', backgroundColor: '#00000000' })
    } else if (platform === 'win32') {
      expect(window.options).toMatchObject({ titleBarStyle: 'hidden', titleBarOverlay: { height: WINDOWS_TITLEBAR_HEIGHT } })
      expect(window.options).not.toHaveProperty('vibrancy')
      expect(harness.menu.mock.calls[0]![0]).toEqual([
        { role: 'toggleDevTools', visible: false },
        { role: 'toggleDevTools', visible: false, accelerator: 'F12' },
      ])
    } else {
      expect(window.options).not.toHaveProperty('titleBarStyle')
      expect(window.options).not.toHaveProperty('vibrancy')
    }
    expect(harness.hosts).toHaveLength(0)
  })

  it('serves packaged shell documents instead of rejecting the shell origin', async () => {
    const { serveWebDocument } = await import('../src/web-document.ts')
    vi.mocked(serveWebDocument).mockResolvedValue(new Response('shell document'))
    await import('../src/main.ts')
    await harness.preparing.promise
    const handler = harness.protocolHandle.mock.calls[0]![1]
    const request = new Request('dsh-app://shell/update-dialog.html')
    expect(await (await handler(request)).text()).toBe('shell document')
    expect(serveWebDocument).toHaveBeenCalledWith(request, join('desktop-test-app', 'renderer'))
    expect((await handler(new Request('dsh-app://foreign/index.html'))).status).toBe(404)
  })

  it.each(['darwin', 'win32'] as const)('relays the %s fullscreen state on transitions and after each load', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    const sent = () => window.webContents.send.mock.calls.filter(([channel]) => channel === DESKTOP_IPC.windowFullscreen)
    expect(sent()).toHaveLength(0)
    window.fullscreen = true
    window.emit('enter-full-screen')
    expect(sent().at(-1)).toEqual([DESKTOP_IPC.windowFullscreen, true])
    // A reload re-registers the preload listener; the finished load resends
    // the current state so fullscreen CSS survives the reload.
    window.webContents.emit('did-finish-load')
    expect(sent().at(-1)).toEqual([DESKTOP_IPC.windowFullscreen, true])
    window.fullscreen = false
    window.emit('leave-full-screen')
    expect(sent().at(-1)).toEqual([DESKTOP_IPC.windowFullscreen, false])
    const relayed = sent().length
    window.destroyed = true
    window.emit('enter-full-screen')
    expect(sent()).toHaveLength(relayed)
  })

  it.each(['linux'] as const)('registers no fullscreen relay on %s', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    window.emit('enter-full-screen')
    window.webContents.emit('did-finish-load')
    expect(window.webContents.send.mock.calls.filter(([channel]) => channel === DESKTOP_IPC.windowFullscreen)).toHaveLength(0)
  })

  it('covers the macOS vibrancy reattach gap with an opaque base while minimized or hidden', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    // Minimizing drops the vibrancy material and paints the theme's opaque fill.
    window.minimized = true
    window.emit('minimize')
    expect(window.setVibrancy).toHaveBeenLastCalledWith(null)
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith('#f9fafb')
    // Restoring re-requests the material and returns to the transparent base.
    window.minimized = false
    window.emit('restore')
    expect(window.setVibrancy).toHaveBeenLastCalledWith('sidebar')
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith('#00000000')
    // Hiding under the dark palette picks the dark opaque fill.
    harness.nativeTheme.shouldUseDarkColors = true
    window.visible = false
    window.emit('hide')
    expect(window.setVibrancy).toHaveBeenLastCalledWith(null)
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith('#1b1b1c')
    window.visible = true
    window.emit('show')
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith('#00000000')
    // A destroyed window ends the backdrop updates.
    const applied = window.setVibrancy.mock.calls.length
    window.destroyed = true
    window.emit('minimize')
    expect(window.setVibrancy.mock.calls).toHaveLength(applied)
  })

  it.each(['win32', 'linux'] as const)('registers no backdrop swap on %s', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    window.minimized = true
    window.emit('minimize')
    expect(window.setVibrancy).not.toHaveBeenCalled()
    expect(window.setBackgroundColor).not.toHaveBeenCalled()
  })

  it('follows the Windows primary document language and palette without trusting other frames', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    const listener = harness.ipcOn.mock.calls.find(([channel]) => channel === DESKTOP_IPC.windowsAppearance)![1]
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    listener({ ...event, senderFrame: { url: 'dsh-app://app/' } }, 'zh-CN', '#ffffff', '#000000')
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled()
    listener(event, 'zh-CN', 'rgb(249, 250, 251)', '#0f1115')
    expect(window.setTitleBarOverlay).toHaveBeenCalledWith({ color: 'rgb(249, 250, 251)', symbolColor: '#0f1115' })
    window.webContents.emit('context-menu', {}, { isEditable: false, selectionText: 'text', editFlags: { canCopy: true } })
    expect(harness.menu.buildFromTemplate).toHaveBeenLastCalledWith([{ role: 'copy', enabled: true, label: '复制', accelerator: '' }])
    listener(event, 'en', '#1b1b1c', '#f9fafb')
    window.webContents.emit('context-menu', {}, { isEditable: false, selectionText: 'text', editFlags: { canCopy: true } })
    expect(harness.menu.buildFromTemplate).toHaveBeenLastCalledWith([{ role: 'copy', enabled: true, label: 'Copy', accelerator: '' }])
    window.setTitleBarOverlay.mockClear()
    listener(event, 'en', 'url(file:///bad)', '#fff')
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled()
    listener(event, {}, '#fff', '#000')
    expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith({ color: '#fff', symbolColor: '#000' })
    window.setTitleBarOverlay.mockClear()
    window.webContents.mainFrame.url = 'dsh-app://unowned/index.html'
    listener(event, 'zh-CN', '#fff', '#000')
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled()
    expect(harness.menu.setApplicationMenu).toHaveBeenCalledOnce()
  })

  it('maps Windows caption menus to localized native commands and rejects foreign popup requests', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    const appearance = harness.ipcOn.mock.calls.find(([channel]) => channel === DESKTOP_IPC.windowsAppearance)![1]
    appearance(event, 'zh-CN', '#fff', '#000')
    const handler = harness.handlers.get(DESKTOP_IPC.windowsMenu)!
    const foreignEvent = { ...event, sender: {} }
    expect(() => handler(foreignEvent, 'application', 48, 34)).toThrow('rejected sender')
    expect(() => handler(event, 'arbitrary-command', 48, 34)).toThrow('invalid popup request')
    expect(() => handler(event, 'application', NaN, 34)).toThrow('invalid popup request')
    const application = handler(event, 'application', 48, 34)
    expect(harness.menu.buildFromTemplate.mock.lastCall![0].map(item => item.label ?? item.type)).toEqual([
      '关于 DeepSeek Harness', 'separator', '检查更新…', '管理 dsh 命令…', 'separator', '退出',
    ])
    expect(harness.popup.mock.lastCall![0]).toMatchObject({ window, x: 48, y: 34 })
    expect(harness.popup.mock.lastCall![0].callback).toBeTypeOf('function')
    harness.popup.mock.lastCall![0].callback!()
    await application
    const edit = handler(event, 'edit', 104, 34)
    expect(harness.menu.buildFromTemplate.mock.lastCall![0].map(item => item.label ?? item.type)).toEqual([
      '撤销', '重做', 'separator', '剪切', '复制', '粘贴', '删除', 'separator', '全选',
    ])
    const commands = harness.menu.buildFromTemplate.mock.lastCall![0].filter(item => item.type !== 'separator')
    for (const [index, keyCode] of ['Z', 'Y', 'X', 'C', 'V', 'Delete', 'A'].entries()) {
      const click = commands[index]!.click as () => void
      click()
      const modifiers = keyCode === 'Delete' ? [] : ['control']
      expect(window.webContents.sendInputEvent).toHaveBeenNthCalledWith(index * 2 + 1, { type: 'keyDown', keyCode, modifiers })
      expect(window.webContents.sendInputEvent).toHaveBeenNthCalledWith(index * 2 + 2, { type: 'keyUp', keyCode, modifiers })
    }
    harness.popup.mock.lastCall![0].callback!()
    await edit
  })

  it.each(['darwin', 'linux'] as const)('adds the product File menu and standard window commands only on macOS (%s)', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    await import('../src/main.ts')
    await harness.preparing.promise
    const describeItem = (item: MenuItemConstructorOptions): string | undefined =>
      item.role ?? (item.type === 'separator' ? 'separator' : item.label)
    const template = harness.menu.buildFromTemplate.mock.calls
      .map(call => call[0])
      .find(items => items.some(item => item.role === 'editMenu'))
    if (template === undefined) throw new Error('application menu missing')
    expect(template.map(describeItem)).toEqual(platform === 'darwin'
      ? ['Desktop test', en.fileMenu, 'editMenu', 'windowMenu']
      : ['Application', 'editMenu'])
    const application = template[0]!.submenu as MenuItemConstructorOptions[]
    expect(application.filter(item => item.visible !== false).map(describeItem)).toEqual(platform === 'darwin'
      ? ['about', 'separator', en.checkUpdatesMenu, en.cliCommandMenu, 'separator', 'hide', 'hideOthers', 'unhide', 'separator', 'quit']
      : ['about', 'separator', en.checkUpdatesMenu, 'separator', 'quit'])
    expect(harness.menu.setApplicationMenu).toHaveBeenCalledOnce()
  })

  it.each(['en-US', 'zh-CN'])('localizes macOS application commands without changing the application name (%s)', async (locale) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    vi.spyOn(harness.app, 'getLocale').mockReturnValue(locale)
    vi.spyOn(harness.app, 'getPreferredSystemLanguages').mockReturnValue([locale])
    const originalName = harness.app.name
    harness.app.name = '@deepseek-ai/dsh-desktop'
    try {
      await import('../src/main.ts')
      await harness.preparing.promise
      const commands = applicationMenuItems().filter(item =>
        item.role === 'hide' || item.role === 'hideOthers' || item.role === 'unhide' || item.role === 'quit'
        || item.label === en.checkUpdatesMenu || item.label === zh.checkUpdatesMenu
        || item.label === en.cliCommandMenu || item.label === zh.cliCommandMenu)
      await expect(JSON.stringify(commands, null, 2) + '\n')
        .toMatchFileSnapshot(`./expected/application-menu-${locale}.json`)
      expect(harness.app.name).toBe('@deepseek-ai/dsh-desktop')
    } finally { harness.app.name = originalName }
  })

  it('attaches Host socket credentials only to the owned application origin and window', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.ready.resolve()
    await Promise.resolve(invoke(DESKTOP_IPC.boot))
    const handler = harness.socketHeaders.mock.calls[0]![1] as (
      details: { url: string; webContentsId: number; requestHeaders: Record<string, string> },
      callback: (result: unknown) => void,
    ) => void
    const callback = vi.fn()
    const details = { url: 'ws://127.0.0.1:3080/api/remote.mux', webContentsId: 42, requestHeaders: { Origin: 'dsh-app://app' } }
    handler(details, callback)
    expect(callback).toHaveBeenLastCalledWith({ requestHeaders: {
      origin: 'http://127.0.0.1:3080', cookie: 'test-cookie', 'sec-fetch-site': 'same-origin',
    } })
    handler({ ...details, requestHeaders: { Origin: 'https://other.example' } }, callback)
    expect(callback).toHaveBeenLastCalledWith({ cancel: true })
    handler({ ...details, webContentsId: 43 }, callback)
    expect(callback).toHaveBeenLastCalledWith({})
    handler({ ...details, url: 'ws://127.0.0.1:9999/api/remote.mux' }, callback)
    expect(callback).toHaveBeenLastCalledWith({})
  })

  it('shares login key discovery with onboarding and rejects foreign renderers', async () => {
    await readyForUpdate()
    const window = harness.windows[0]!
    const handler = harness.handlers.get(DESKTOP_IPC.onboardingApiKey)!
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    await vi.waitFor(async () => { expect(await handler(event)).toBe(true) })
    harness.hosts.at(-1)!.fetch.mockResolvedValueOnce(Response.json({ hasApiKey: false }))
    await expect(handler(event)).resolves.toBe(false)
    await expect(handler({ ...event, sender: {} })).rejects.toThrow()
  })

  it('enlarges only an active onboarding window and keeps its size after completion', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    const listener = harness.ipcOn.mock.calls.find(([channel]) => channel === DESKTOP_IPC.onboardingActive)![1]
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    expect(window.setMinimumSize).not.toHaveBeenCalled()
    listener({ ...event, sender: {} }, true)
    listener(event, 'true')
    expect(window.setMinimumSize).not.toHaveBeenCalled()
    listener(event, true)
    expect(window.setMinimumSize).toHaveBeenLastCalledWith(960, 600)
    expect(window.setSize).toHaveBeenLastCalledWith(960, 700)
    window.setSize.mockClear()
    window.getBounds.mockReturnValue({ x: 0, y: 0, width: 1200, height: 800 })
    listener(event, true)
    expect(window.setSize).not.toHaveBeenCalled()
    listener(event, false)
    expect(window.setMinimumSize).toHaveBeenLastCalledWith(520, 600)
    expect(window.setSize).not.toHaveBeenCalled()
  })

  it('registers the window-owned directory picker during startup and rejects foreign callers', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    const handler = harness.handlers.get(DESKTOP_IPC.directoryPick) as (event: IpcMainInvokeEvent) => Promise<string | null>
    expect(handler).toBeTypeOf('function')
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame } as unknown as IpcMainInvokeEvent
    harness.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/workspace'] })
    await expect(handler(event)).resolves.toBe('/workspace')
    expect(harness.dialog.showOpenDialog).toHaveBeenCalledExactlyOnceWith(window, { properties: ['openDirectory', 'createDirectory'] })
    window.webContents.mainFrame.url = 'https://other.example/'
    await expect(handler(event)).rejects.toThrow('unowned renderer')
  })

  it('holds boot injections until the Host is ready and rejects foreign boot callers', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const handler = harness.handlers.get(DESKTOP_IPC.boot)!
    await expect(handler({ senderFrame: { url: 'https://other.example/' } })).rejects.toThrow('unowned renderer')
    let settled = false
    const boot = Promise.resolve(handler({ senderFrame: { url: 'dsh-app://app/' } })).then((value) => { settled = true; return value })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/'])
    harness.prepared.resolve()
    await harness.hostStarted.promise
    expect(settled).toBe(false)
    harness.hosts[0]!.ready.resolve()
    await expect(boot).resolves.toEqual({ injections: [], streamBaseUrl: 'http://127.0.0.1:3080' })
    expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/'])
  })

  it('retains macOS native editing actions on right-click and only copy for selected read-only text', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    const editFlags = { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true }
    harness.menu.mockClear()

    window.webContents.emit('context-menu', {}, { isEditable: true, selectionText: 'text', editFlags })
    expect(harness.menu).toHaveBeenLastCalledWith([
      { role: 'undo', enabled: true, accelerator: '' }, { role: 'redo', enabled: false, accelerator: '' },
      { type: 'separator', accelerator: '' },
      { role: 'cut', enabled: true, accelerator: '' }, { role: 'copy', enabled: true, accelerator: '' },
      { role: 'paste', enabled: true, accelerator: '' }, { type: 'separator', accelerator: '' },
      { role: 'selectAll', enabled: true, accelerator: '' },
    ])
    expect(harness.popup).toHaveBeenCalledWith({ window })

    window.webContents.emit('context-menu', {}, { isEditable: false, selectionText: 'text', editFlags })
    expect(harness.menu).toHaveBeenLastCalledWith([{ role: 'copy', enabled: true, accelerator: '' }])

    harness.menu.mockClear()
    window.webContents.emit('context-menu', {}, { isEditable: false, selectionText: '', editFlags })
    expect(harness.menu).not.toHaveBeenCalled()
  })

  it('opens message links externally while retaining same-origin application navigation', async () => {
    await readyForUpdate()
    const window = harness.windows[0]!
    const openWindow = window.webContents.setWindowOpenHandler.mock.calls[0]![0] as
      (details: { url: string }) => { action: string }
    const source = 'https://example.com/source?q=reference'
    expect(openWindow({ url: source })).toEqual({ action: 'deny' })
    expect(harness.openExternal).toHaveBeenCalledWith(source)
    harness.openExternal.mockClear()
    const external = { preventDefault: vi.fn() }
    window.webContents.emit('will-navigate', external, 'https://example.com/document')
    expect(external.preventDefault).toHaveBeenCalledOnce()
    expect(harness.openExternal).toHaveBeenCalledWith('https://example.com/document')
    harness.openExternal.mockClear()
    const internal = { preventDefault: vi.fn() }
    window.webContents.emit('will-navigate', internal, 'dsh-app://app/session/task-1')
    expect(internal.preventDefault).not.toHaveBeenCalled()
    expect(harness.openExternal).not.toHaveBeenCalled()
  })

  async function readyForUpdate() {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.ready.resolve()
    await harness.navigated.promise
    return harness.hosts[0]!
  }

  it.each([
    ['win32', ['--updated'], true],
    ['win32', [], false],
    ['darwin', ['--updated'], false],
    ['linux', ['--updated'], false],
  ] as const)('raises the first workspace only for a Windows installer restart (%s, %j)', async (platform, args, raises) => {
    vi.stubGlobal('process', { ...process, platform, argv: ['desktop', ...args] })
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    expect(window.moveTop).not.toHaveBeenCalled()
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.ready.resolve()
    await window.shown.promise
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.moveTop).toHaveBeenCalledTimes(raises ? 1 : 0)
    expect(window.focus).toHaveBeenCalledTimes(raises ? 1 : 0)
    expect(window.setAlwaysOnTop).not.toHaveBeenCalled()
    if (raises) {
      expect(window.show.mock.invocationCallOrder[0]).toBeLessThan(window.moveTop.mock.invocationCallOrder[0]!)
    }
    window.destroy()
    harness.app.emit('second-instance')
    const replacement = harness.windows[1]!
    await replacement.shown.promise
    expect(replacement.show).toHaveBeenCalledOnce()
    expect(replacement.moveTop).not.toHaveBeenCalled()
    expect(replacement.setAlwaysOnTop).not.toHaveBeenCalled()
  })

  it.each([
    ['win32', 'zh-CN'], ['win32', 'en-US'], ['darwin', 'zh-CN'], ['darwin', 'en-US'],
  ] as const)('records the restart confirmation on %s in %s', async (platform, language) => {
    vi.stubGlobal('process', { ...process, platform })
    vi.spyOn(harness.app, 'getPreferredSystemLanguages').mockReturnValue([language])
    await readyForUpdate()
    harness.updateState = { phase: 'ready', version: '0.1.7-alpha.2' }
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 })
    await expect(harness.prepareUpdate()).resolves.toBe(false)
    const { message, detail, buttons } = harness.dialog.showMessageBox.mock.lastCall![0] as MessageBoxOptions
    await expect(JSON.stringify({ message, detail, buttons }, null, 2) + '\n')
      .toMatchFileSnapshot(`./expected/update-restart-${platform}-${language}.json`)
  })

  /** Like readyForUpdate, but past backend readiness and the workspace reveal, so the Host answers quit inspections. */
  async function readyWorkspace() {
    const host = await readyForUpdate()
    await Promise.resolve(invoke(DESKTOP_IPC.boot))
    return host
  }

  it('hides the workspace before intentional Host shutdown can look like reconnection', async () => {
    const host = await readyWorkspace()
    const window = harness.windows[0]!
    window.show.mockClear()
    window.focus.mockClear()
    harness.app.quit()
    // The quit inspects the Host before hiding; nothing to interrupt means no dialog.
    await vi.advanceTimersByTimeAsync(0)
    expect(host.inspectQuit).toHaveBeenCalledOnce()
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(window.hide).toHaveBeenCalledOnce()
    await host.stopping.promise
    harness.app.emit('second-instance')
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
    host.exited.resolve()
    await harness.quitCompleted.promise
    expect(harness.trays[0]!.destroy).toHaveBeenCalledOnce()
  })

  it('routes closing through the tray confirmation and keeps the Host running', async () => {
    const host = await readyWorkspace()
    const window = harness.windows[0]!
    expect(harness.trays).toHaveLength(1)
    expect(harness.trays[0]!.image).toEqual({ path: join('desktop-test-resources', 'tray.ico') })
    expect(harness.backgroundNotice.markerPath).toBe(join(harness.app.getPath('userData'), 'background-close-confirmed'))
    window.show.mockClear()
    window.close()
    expect(window.isDestroyed()).toBe(false)
    expect(window.hide).toHaveBeenCalledOnce()
    expect(host.stop).not.toHaveBeenCalled()
    expect(harness.app.quit).not.toHaveBeenCalled()
    expect(harness.backgroundNotice.close).toHaveBeenCalledOnce()
    harness.trays[0]!.emit('click')
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalled()
    harness.app.emit('second-instance')
    expect(window.show).toHaveBeenCalledTimes(2)
    // Locale changes relabel the tray together with the application menu.
    const relabels = harness.trays[0]!.setContextMenu.mock.calls.length
    harness.ipcOn.mock.calls.find(call => call[0] === DESKTOP_IPC.localeChanged)![1]({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, 'zh')
    expect(harness.trays[0]!.setContextMenu.mock.calls.length).toBe(relabels + 1)
  })

  it('keeps the workspace visible while acknowledgement is pending and ignores a destroyed window', async () => {
    await readyWorkspace()
    const window = harness.windows[0]!
    const approval = Promise.withResolvers<() => void>()
    harness.backgroundNotice.close.mockImplementationOnce((hide) => { approval.resolve(hide) })
    window.close()
    const hide = await approval.promise
    expect(window.hide).not.toHaveBeenCalled()
    window.destroy()
    hide()
    expect(window.hide).not.toHaveBeenCalled()
  })

  it('focuses an existing shell dialog instead of replacing it with a close confirmation', async () => {
    await readyWorkspace()
    const window = harness.windows[0]!
    harness.shellDialog.isOpen = true
    window.close()
    expect(harness.shellDialog.focus).toHaveBeenCalledOnce()
    expect(harness.backgroundNotice.close).not.toHaveBeenCalled()
    expect(window.hide).not.toHaveBeenCalled()
  })

  it('leaves macOS fullscreen before hiding on close and reopens the hidden window on activate', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin', arch: 'arm64', resourcesPath: 'desktop-test-resources' })
    await readyWorkspace()
    const window = harness.windows[0]!
    expect(harness.trays).toHaveLength(0)
    window.fullscreen = true
    window.close()
    expect(window.setFullScreen).toHaveBeenCalledWith(false)
    expect(window.hide).toHaveBeenCalledOnce()
    expect(harness.backgroundNotice.close).not.toHaveBeenCalled()
    window.show.mockClear()
    harness.app.emit('activate', {}, false)
    expect(window.show).toHaveBeenCalledOnce()
    harness.app.emit('activate', {}, true)
    expect(window.show).toHaveBeenCalledOnce()
  })

  it('skips the confirmation during a macOS shutdown but asks again once a cancelled shutdown returns focus', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin', arch: 'arm64', resourcesPath: 'desktop-test-resources' })
    const host = await readyWorkspace()
    const window = harness.windows[0]!
    host.inspectQuit.mockResolvedValue({ activeTasks: true, scheduledTasks: false })
    harness.dialog.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    harness.powerMonitor.emit('shutdown')
    // Another application vetoed the shutdown; the user comes back to the window.
    window.emit('focus')
    window.close()
    expect(window.isDestroyed()).toBe(false)
    harness.app.quit()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect(host.stop).not.toHaveBeenCalled()
    harness.powerMonitor.emit('shutdown')
    harness.app.quit()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    await host.stopping.promise
    host.exited.resolve()
    await harness.quitCompleted.promise
  })

  it('drops a pending confirmation when a bypassing quit starts first', async () => {
    harness.app.isPackaged = false
    const host = await readyWorkspace()
    const inspected = Promise.withResolvers<{ activeTasks: boolean; scheduledTasks: boolean }>()
    host.inspectQuit.mockReturnValue(inspected.promise)
    harness.app.quit()
    await vi.advanceTimersByTimeAsync(0)
    const restart = applicationMenuItems().find(item => item.label === en.restartAppHostMenu)!
    ;(restart as { click: () => void }).click()
    await vi.advanceTimersByTimeAsync(0)
    inspected.resolve({ activeTasks: true, scheduledTasks: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    await host.stopping.promise
    host.exited.resolve()
    await harness.quitCompleted.promise
  })

  it('asks before quitting when the Host reports interruptible work and cancels without stopping anything', async () => {
    const host = await readyWorkspace()
    const window = harness.windows[0]!
    host.inspectQuit.mockResolvedValue({ activeTasks: true, scheduledTasks: true })
    harness.dialog.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    harness.app.quit()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.dialog.showMessageBox).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      message: en.quitTitle, detail: en.quitActiveAndScheduledTasks, buttons: [en.quit, en.cancel], defaultId: 0, cancelId: 1,
    }))
    expect(window.hide).not.toHaveBeenCalled()
    expect(host.stop).not.toHaveBeenCalled()
    expect(harness.trays[0]!.destroy).not.toHaveBeenCalled()
    // A second request while the box is open joins it instead of stacking another.
    const pending = Promise.withResolvers<Electron.MessageBoxReturnValue>()
    harness.dialog.showMessageBox.mockReturnValue(pending.promise)
    harness.app.quit()
    await vi.advanceTimersByTimeAsync(0)
    harness.app.quit()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.dialog.showMessageBox).toHaveBeenCalledTimes(2)
    expect(host.inspectQuit).toHaveBeenCalledTimes(2)
    pending.resolve({ response: 0, checkboxChecked: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(window.hide).toHaveBeenCalledOnce()
    await host.stopping.promise
    host.exited.resolve()
    await harness.quitCompleted.promise
  })

  it('warns about running tasks when the inspection fails and quits directly on session end or a development restart', async () => {
    harness.app.isPackaged = false
    const host = await readyWorkspace()
    host.inspectQuit.mockRejectedValue(new Error('desktop quit: inspection timed out'))
    harness.dialog.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    harness.app.quit()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.dialog.showMessageBox).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ detail: en.quitActiveTasks }))
    expect(host.stop).not.toHaveBeenCalled()
    const restart = applicationMenuItems().find(item => item.label === en.restartAppHostMenu)!
    harness.dialog.showMessageBox.mockClear()
    ;(restart as { click: () => void }).click()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.app.relaunch).toHaveBeenCalledOnce()
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    await host.stopping.promise
    host.exited.resolve()
    await harness.quitCompleted.promise
  })

  it('does not block a Windows session end on the quit confirmation', async () => {
    const host = await readyWorkspace()
    const window = harness.windows[0]!
    host.inspectQuit.mockResolvedValue({ activeTasks: true, scheduledTasks: false })
    // The session-end question alone proves nothing: another application can veto it silently.
    window.emit('query-session-end', { reasons: ['shutdown'] })
    window.close()
    expect(window.isDestroyed()).toBe(false)
    expect(window.hide).toHaveBeenCalledOnce()
    window.emit('session-end', { reasons: ['shutdown'] })
    window.close()
    expect(window.isDestroyed()).toBe(true)
    // Electron follows the last closed window with window-all-closed, which quits on Windows.
    harness.app.quit()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(host.inspectQuit).not.toHaveBeenCalled()
    await host.stopping.promise
    host.exited.resolve()
    await harness.quitCompleted.promise
  })

  it('defers the downloaded-update confirmation until the hidden window is shown again', async () => {
    await readyWorkspace()
    const window = harness.windows[0]!
    harness.updateState = { phase: 'available', version: '1.0.1' }
    harness.updateDownload.mockImplementation(async () => { harness.updateState = { phase: 'ready', version: '1.0.1' }; return harness.updateState })
    window.close()
    window.visible = false
    const opened = invoke(DESKTOP_IPC.updatesOpen, 'app') as Promise<void>
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.updateDownload).toHaveBeenCalledWith('1.0.1')
    expect(harness.updateInstall).not.toHaveBeenCalled()
    window.visible = true
    window.emit('show')
    await opened
    expect(harness.updateInstall).toHaveBeenCalledWith('1.0.1')
  })

  it('waits for Platform view storage cleanup before an ordinary quit completes', async () => {
    const host = await readyForUpdate()
    const disposal = harness.deferPlatformDispose()
    harness.app.quit()
    await host.stopping.promise
    expect(harness.platformDispose).toHaveBeenCalledOnce()
    host.exited.resolve()
    expect(harness.app.quit).toHaveBeenCalledOnce()
    disposal.resolve()
    await harness.quitCompleted.promise
    expect(harness.app.quit).toHaveBeenCalledTimes(2)
  })

  it('reports a Platform cleanup failure without ending the Host shutdown early', async () => {
    const host = await readyForUpdate()
    const disposal = harness.deferPlatformDispose()
    const failure = new Error('platform storage cleanup failed')
    harness.app.quit()
    await host.stopping.promise
    disposal.reject(failure)
    await vi.waitFor(() => { expect(console.error).toHaveBeenCalledWith(failure) })
    expect(harness.app.quit).toHaveBeenCalledOnce()
    host.exited.resolve()
    await harness.quitCompleted.promise
    expect(harness.app.quit).toHaveBeenCalledTimes(2)
  })

  it('finishes quitting when the native window is destroyed before its closed listener clears ownership', async () => {
    const host = await readyForUpdate()
    const window = harness.windows[0]!
    window.destroyed = true
    window.hide.mockImplementation(() => { throw new TypeError('Object has been destroyed') })
    expect(() => { harness.app.quit() }).not.toThrow()
    expect(window.hide).not.toHaveBeenCalled()
    await host.stopping.promise
    window.emit('closed')
    host.exited.resolve()
    await harness.quitCompleted.promise
  })

  it('shares the failed-check deadline across focus and resume, while explicit checks reset polling', async () => {
    vi.stubEnv('DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS', '1000')
    vi.stubEnv('DSH_DESKTOP_UPDATE_CHECK_MAX_BACKOFF_MS', '4000')
    vi.stubEnv('DSH_DESKTOP_UPDATE_CHECK_JITTER', '0')
    harness.updateCheck.mockResolvedValue({ phase: 'error', failedOperation: 'check', message: 'offline' })
    const host = await readyForUpdate()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.updateCheck).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1999)
    harness.windows[0]!.emit('focus')
    harness.powerMonitor.emit('resume')
    expect(harness.updateCheck).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.updateCheck).toHaveBeenCalledTimes(2)
    harness.updateCheck.mockResolvedValue({ phase: 'idle' })
    await invoke(DESKTOP_IPC.updatesOpen, 'app')
    expect(harness.updateCheck).toHaveBeenLastCalledWith(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(harness.updateCheck).toHaveBeenCalledTimes(4)
    harness.app.quit()
    try {
      await host.stopping.promise
      await vi.advanceTimersByTimeAsync(10_000)
      harness.powerMonitor.emit('resume')
      expect(harness.updateCheck).toHaveBeenCalledTimes(4)
      expect(vi.getTimerCount()).toBe(0)
    } finally { host.exited.resolve(); await harness.quitCompleted.promise }
  })

  it('blocks subsequent product operations without stopping the Host and clears only on a fresh no-force policy', async () => {
    harness.embeddedPolicy = { origin: 'https://policy.example.com',
      allowedPageOrigins: ['https://downloads.example.com'], intervalMs: 10_000, jitter: 0 }
    vi.stubEnv('DSH_DESKTOP_MANDATORY_UPDATE_CONFIG', '{invalid environment override}')
    const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ code: 40005,
      data: { show_content: { title: 'Update required', detail: 'Please update' }, desktop_app_link: 'https://downloads.example.com/' } }))
    vi.stubGlobal('fetch', request)
    const host = await readyForUpdate()
    await harness.policyBlocked.promise
    const modal = harness.windows[0]!
    expect(modal).toBeDefined()
    expect(harness.windows).toHaveLength(1)
    const status = harness.handlers.get(MANDATORY_IPC.status)!
    const action = harness.handlers.get(MANDATORY_IPC.action)!
    const owned = { sender: modal.webContents, senderFrame: modal.webContents.mainFrame }
    expect(status(owned)).toMatchObject({ policy: { blocking: true } })
    const unowned = [
      { ...owned, sender: {} },
      { ...owned, senderFrame: { url: 'dsh-app://app/index.html' } },
      { ...owned, senderFrame: { url: 'https://untrusted.example.com/' } },
    ]
    for (const event of unowned) {
      expect(() => status(event)).toThrow('unowned renderer')
      expect(() => action(event, 'download', '1.0.1-nightly.1')).toThrow('unowned renderer')
    }
    expect(() => action(owned, 'open-arbitrary-url')).toThrow('invalid action')
    expect(() => action(owned, 'download')).toThrow('missing confirmed version')
    expect(() => action(owned, 'install', 123)).toThrow('missing confirmed version')
    expect(harness.updateDownload).not.toHaveBeenCalled()
    expect(harness.updateInstall).not.toHaveBeenCalled()
    expect(host.stop).not.toHaveBeenCalled()
    expect(harness.updateDownload).not.toHaveBeenCalled()
    await invoke(DESKTOP_IPC.updatesOpen, 'app')
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    request.mockImplementationOnce(async () => Response.json({ code: 500 }, { status: 503 }))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(modal.isDestroyed()).toBe(false)
    expect(host.stop).not.toHaveBeenCalled()
    request.mockImplementationOnce(async () => Response.json({ code: 0, data: { biz_code: 0, biz_data: null } }))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(modal.isDestroyed()).toBe(false)
    await vi.advanceTimersByTimeAsync(150)
    expect(modal.isDestroyed()).toBe(false)
    expect(modal.webContents.send.mock.calls.at(-1)).toMatchObject([MANDATORY_IPC.state, { policy: { blocking: false } }])
    expect(host.stop).not.toHaveBeenCalled()
    expect(request.mock.calls[0]![1]!.headers).toMatchObject({
      'x-client-bundle-id': '', 'x-client-platform': 'desktop-win', 'x-client-version': '1.2.3',
      'x-client-arch': 'x64', 'x-client-update-channel': 'nightly', 'x-client-bundled-dsh-version': '1.0.0',
      'x-client-locale': 'en_US', 'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
    })
  })

  it('keeps one checking dialog open until the manual check settles, then reports the current version', async () => {
    await readyForUpdate()
    const checked = Promise.withResolvers<DesktopUpdateState>()
    const checking = Promise.withResolvers<AbortSignal>()
    const requested = Promise.withResolvers<undefined>()
    harness.updateCheck.mockImplementationOnce(() => { requested.resolve(undefined); return checked.promise })
    harness.dialog.showMessageBox.mockImplementationOnce(({ signal }: { signal: AbortSignal }) => {
      checking.resolve(signal)
      return new Promise((resolve) => { signal.addEventListener('abort', () => { resolve({ response: 0 }) }, { once: true }) })
    }).mockImplementationOnce(() => {
      expect((harness.dialog.showMessageBox.mock.calls[0]![0] as { signal: AbortSignal }).signal.aborted).toBe(false)
      return Promise.resolve({ response: 0 })
    })
    const submenu = applicationMenuItems()
    const action = submenu.find(item => item.label === 'Check for Updates…')
    expect(action?.click).toBeTypeOf('function')
    // Electron supplies menu arguments that this callback does not consume.
    Reflect.apply(action!.click!, undefined, [])
    const prompt = Promise.resolve(invoke(DESKTOP_IPC.updatesOpen, 'app'))
    const signal = await checking.promise
    await requested.promise
    expect(signal.aborted).toBe(false)
    expect(harness.dialog.showMessageBox).toHaveBeenCalledTimes(1)
    expect(harness.updateCheck).toHaveBeenLastCalledWith(true)
    checked.resolve({ phase: 'idle' })
    await prompt
    expect(signal.aborted).toBe(true)
    expect(harness.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({
      message: 'You’re up to date!', detail: 'Current version: 1.0.0',
    }))
  })

  it('reports a manual check failure without offering a download', async () => {
    await readyForUpdate()
    harness.updateCheck.mockResolvedValueOnce({ phase: 'error', failedOperation: 'check', message: 'Feed unavailable' })
    harness.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    await invoke(DESKTOP_IPC.updatesOpen, 'app')
    expect(harness.dialog.showMessageBox).toHaveBeenCalledTimes(2)
    expect(harness.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error',
      message: 'Could not check for updates. Please try again later.', technicalDetails: 'Feed unavailable' }))
    expect(harness.updateDownload).not.toHaveBeenCalled()
  })

  it('reports a stale download confirmation as a download failure', async () => {
    await readyForUpdate()
    harness.updateCheck.mockResolvedValueOnce({ phase: 'available', version: '1.0.1-nightly.1' })
    harness.updateDownload.mockRejectedValueOnce(new Error('desktop update: download confirmation is stale'))
    await invoke(DESKTOP_IPC.updatesOpen, 'app')
    expect(harness.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error',
      message: en.updateDownloadFailed, technicalDetails: 'desktop update: download confirmation is stale' }))
  })

  it('keeps policy failures silent while an ordinary update proceeds', async () => {
    harness.embeddedPolicy = { origin: 'https://policy.example.com',
      allowedPageOrigins: ['https://downloads.example.com'] }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({ code: 500 }, { status: 503 })))
    await readyForUpdate()
    await vi.advanceTimersByTimeAsync(0)
    harness.dialog.showMessageBox.mockClear()
    harness.updateCheck.mockResolvedValueOnce({ phase: 'available', version: '1.0.1-nightly.1' })
    await invoke(DESKTOP_IPC.updatesOpen, 'app')
    const messages = harness.dialog.showMessageBox.mock.calls.map(call => (call.at(-1) as { message: string }).message)
    expect(messages).not.toContain(en.mandatoryUnavailable)
    expect(harness.updateDownload).toHaveBeenCalledExactlyOnceWith('1.0.1-nightly.1')
  })

  it('does not wait for a pending policy request before proceeding with an ordinary update', async () => {
    harness.embeddedPolicy = { origin: 'https://policy.example.com',
      allowedPageOrigins: ['https://downloads.example.com'] }
    const policy = Promise.withResolvers<Response>()
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(() => policy.promise))
    harness.updateCheck.mockResolvedValue({ phase: 'available', version: '1.0.1-nightly.1' })
    const operation = Promise.resolve().then(async () => {
      await readyForUpdate()
      await invoke(DESKTOP_IPC.updatesOpen, 'app')
    })
    try {
      await vi.waitFor(() => { expect(harness.updateDownload).toHaveBeenCalledWith('1.0.1-nightly.1') })
    } finally {
      policy.resolve(Response.json({ code: 500 }, { status: 503 }))
      await operation
    }
  })

  it('lets a confirmed mandatory policy preempt an ordinary result dialog', async () => {
    harness.embeddedPolicy = { origin: 'https://policy.example.com',
      allowedPageOrigins: ['https://downloads.example.com'] }
    const policy = Promise.withResolvers<Response>()
    const available = Promise.withResolvers<AbortSignal>()
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(() => policy.promise))
    harness.updateCheck.mockResolvedValue({ phase: 'available', version: '1.0.1-nightly.1' })
    harness.dialog.showMessageBox.mockImplementation(({ signal, message }: { signal?: AbortSignal; message: string }) => {
      if (message !== en.updateAvailable.replace('{version}', '1.0.1-nightly.1') || signal === undefined) return Promise.resolve({ response: 1 })
      available.resolve(signal)
      return new Promise((resolve) => { signal.addEventListener('abort', () => { resolve({ response: 0 }) }, { once: true }) })
    })
    await readyForUpdate()
    const submenu = applicationMenuItems()
    const action = submenu.find(item => item.label === 'Check for Updates…')
    Reflect.apply(action!.click!, undefined, [])
    const operation = Promise.resolve(invoke(DESKTOP_IPC.updatesOpen, 'app'))
    try {
      const signal = await available.promise
      policy.resolve(Response.json({ code: 40005,
        data: { show_content: { title: 'Update required', detail: 'Please update' },
          desktop_app_link: 'https://downloads.example.com/' } }))
      await harness.policyBlocked.promise
      expect(signal.aborted).toBe(true)
      await operation
      expect(harness.updateDownload).not.toHaveBeenCalled()
    } finally {
      policy.resolve(Response.json({ code: 500 }, { status: 503 }))
      await operation
    }
  })

  it('queues policy authentication until the ordinary result dialog closes', async () => {
    harness.embeddedPolicy = { origin: 'https://policy.example.com', authentication: 'feishu-test', allowedAuthOrigins: ['https://login.example.com'],
      allowedPageOrigins: ['https://downloads.example.com'], intervalMs: 10_000, jitter: 0 }
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ code: 0, data: { biz_code: 0, biz_data: null } }))
      .mockResolvedValue(Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 }))
    vi.stubGlobal('fetch', request)
    await readyForUpdate()
    await vi.advanceTimersByTimeAsync(0)
    const ordinaryResult = Promise.withResolvers<{ response: number }>()
    const ordinaryShown = Promise.withResolvers<undefined>()
    const policyShown = Promise.withResolvers<undefined>()
    harness.dialog.showMessageBox.mockImplementation(({ message }: { message: string }) => {
      if (message === en.updateCurrent) {
        ordinaryShown.resolve(undefined)
        return ordinaryResult.promise
      }
      if (message === en.policyLoginRequired) policyShown.resolve(undefined)
      return Promise.resolve({ response: 1 })
    })
    const operation = Promise.resolve(invoke(DESKTOP_IPC.updatesOpen, 'app'))
    await ordinaryShown.promise
    expect(harness.dialog.showMessageBox.mock.calls.map(call => (call.at(-1) as { message: string }).message))
      .not.toContain(en.policyLoginRequired)
    ordinaryResult.resolve({ response: 0 })
    await operation
    await policyShown.promise
    expect(testAuth.login).not.toHaveBeenCalled()
  })

  it('downloads on the first click and opens installation confirmation only after readiness', async () => {
    await readyForUpdate()
    harness.updateState = { phase: 'available', version: '1.0.1-nightly.1' }
    const downloading = Promise.withResolvers<DesktopUpdateState>()
    const started = Promise.withResolvers<undefined>()
    harness.updateDownload.mockImplementationOnce(async (version) => {
      harness.updateState = { phase: 'downloading', version }
      started.resolve(undefined)
      return downloading.promise
    })
    const action = invoke(DESKTOP_IPC.updatesOpen, 'app')
    await started.promise
    const repeated = invoke(DESKTOP_IPC.updatesOpen, 'app')
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(harness.updateDownload).toHaveBeenCalledExactlyOnceWith('1.0.1-nightly.1')
    expect(harness.updateInstall).not.toHaveBeenCalled()
    downloading.resolve({ phase: 'ready', version: '1.0.1-nightly.1' })
    await Promise.all([action, repeated])
    expect(harness.updateInstall).toHaveBeenCalledExactlyOnceWith('1.0.1-nightly.1')
    await harness.updateCheck()
    expect(harness.updateInstall).toHaveBeenCalledOnce()
  })

  it('does not lock or stop tasks when restart confirmation is dismissed', async () => {
    const host = await readyForUpdate()
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 })
    await expect(harness.prepareUpdate()).resolves.toBe(false)
    expect(host.updateTasks.mock.calls).toEqual([['inspect']])
    expect(host.stop).not.toHaveBeenCalled()
  })

  it('rechecks admission after approval and rejects work that started during confirmation', async () => {
    const host = await readyForUpdate()
    host.updateTasks.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    await expect(harness.prepareUpdate()).rejects.toThrow(/New tasks/u)
    expect(host.updateTasks.mock.calls).toEqual([['inspect'], ['lock'], ['unlock']])
    expect(host.stop).not.toHaveBeenCalled()
  })

  it('warns about active tasks and waits for a graceful Host exit after approval', async () => {
    const host = await readyForUpdate()
    host.updateTasks.mockResolvedValue(true)
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const preparing = harness.prepareUpdate()
    await host.stopping.promise
    expect(harness.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Tasks are still in progress', buttons: ['Stop tasks and update', 'Update later'],
    }))
    expect(host.stop).toHaveBeenCalledWith(true)
    host.exited.resolve()
    await expect(preparing).resolves.toBe(true)
  })

  it('unlocks admission without stopping the Host when request draining fails', async () => {
    const host = await readyForUpdate()
    host.updateTasks.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('task inspection timed out'))
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    await expect(harness.prepareUpdate()).rejects.toThrow('task inspection timed out')
    expect(host.updateTasks.mock.calls).toEqual([['inspect'], ['lock'], ['unlock']])
    expect(host.stop).not.toHaveBeenCalled()
  })

  it('waits for Platform storage cleanup before the installer takes over', async () => {
    const host = await readyForUpdate()
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const cleanup = harness.deferPlatformClose()
    const preparing = harness.prepareUpdate()
    await vi.waitFor(() => { expect(harness.platformCloseAndWait).toHaveBeenCalledOnce() })
    expect(host.updateTasks).toHaveBeenLastCalledWith('lock')
    expect(host.stop).not.toHaveBeenCalled()
    cleanup.resolve()
    await host.stopping.promise
    expect(host.stop).toHaveBeenCalledWith(true)
    host.exited.resolve()
    await expect(preparing).resolves.toBe(true)
  })

  it.each(['accepted', 'failed'] as const)('settles analytics intake before locking API admission and continues after intake failure: %s', async (outcome) => {
    const host = await readyForUpdate()
    await vi.waitFor(() => { expect(harness.analytics).toHaveBeenCalledWith(expect.objectContaining({ eventName: 'desktop_app_launch' })) })
    const intake = Promise.withResolvers<undefined>()
    harness.analytics.mockImplementationOnce(() => intake.promise)
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const preparing = harness.prepareUpdate()
    await vi.waitFor(() => { expect(harness.analytics).toHaveBeenLastCalledWith(expect.objectContaining({ eventName: 'desktop_upgrade_install_restart_click' })) })
    expect(host.updateTasks.mock.calls).toEqual([['inspect']])
    expect(host.stop).not.toHaveBeenCalled()
    if (outcome === 'accepted') intake.resolve(undefined)
    else intake.reject(new Error('local analytics intake timed out'))
    await host.stopping.promise
    host.exited.resolve()
    await expect(preparing).resolves.toBe(true)
  })

  it('reports a Platform storage cleanup failure as preparation failure without stopping the Host', async () => {
    const host = await readyForUpdate()
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const cleanup = harness.deferPlatformClose()
    const preparing = harness.prepareUpdate()
    await vi.waitFor(() => { expect(harness.platformCloseAndWait).toHaveBeenCalledOnce() })
    cleanup.reject(new Error('platform storage cleanup failed'))
    await expect(preparing).rejects.toThrow('platform storage cleanup failed')
    expect(host.updateTasks.mock.calls).toEqual([['inspect'], ['lock'], ['unlock']])
    expect(host.stop).not.toHaveBeenCalled()
  })

  async function answerMandatory(action: 'install' | 'later') {
    const modal = harness.windows[0]!
    const event = { sender: modal.webContents, senderFrame: modal.webContents.mainFrame }
    await vi.waitFor(() => {
      expect(harness.handlers.get(MANDATORY_IPC.status)!(event)).toHaveProperty('confirmation')
    })
    const view = harness.handlers.get(MANDATORY_IPC.status)!(event) as { confirmation: { version: string; revision: number } }
    await harness.handlers.get(MANDATORY_IPC.action)!(event, action, view.confirmation.version, view.confirmation.revision)
  }

  it.each(['inspection', 'dialog'] as const)('closes the main window and cancels the pending quit %s when the installer quits Electron', async (pendingPhase) => {
    harness.embeddedPolicy = { origin: 'https://policy.example.com', allowedPageOrigins: ['https://downloads.example.com'] }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 40005, data: {
      show_content: { title: 'Update required', detail: 'Please update' }, desktop_app_link: 'https://downloads.example.com/',
    } })))
    const host = await readyWorkspace()
    await harness.policyBlocked.promise
    const inspected = Promise.withResolvers<{ activeTasks: boolean; scheduledTasks: boolean }>()
    const answered = Promise.withResolvers<Electron.MessageBoxReturnValue>()
    host.inspectQuit.mockReturnValue(inspected.promise)
    harness.dialog.showMessageBox.mockReturnValue(answered.promise)
    harness.app.quit()
    await vi.advanceTimersByTimeAsync(0)
    expect(host.inspectQuit).toHaveBeenCalledOnce()
    if (pendingPhase === 'dialog') {
      inspected.resolve({ activeTasks: true, scheduledTasks: true })
      await vi.advanceTimersByTimeAsync(0)
      expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    }
    const modal = harness.windows[0]!
    const preparing = harness.prepareUpdate()
    await answerMandatory('install')
    await host.stopping.promise
    host.exited.resolve()
    await expect(preparing).resolves.toBe(true)
    harness.closeWindowsOnQuit = true
    const disposal = harness.deferPlatformDispose()
    harness.app.quit()
    await harness.quitCompleted.promise
    expect(modal.isDestroyed()).toBe(true)
    expect(harness.app.quit).toHaveBeenCalledTimes(2)
    // The installer owns the exit, so Platform cleanup starts without holding the quit open.
    expect(harness.platformDispose).toHaveBeenCalledOnce()
    inspected.resolve({ activeTasks: true, scheduledTasks: true })
    answered.resolve({ response: 0, checkboxChecked: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.dialog.showMessageBox).toHaveBeenCalledTimes(pendingPhase === 'dialog' ? 1 : 0)
    expect(harness.platformDispose).toHaveBeenCalledOnce()
    expect(harness.app.quit).toHaveBeenCalledTimes(2)
    disposal.resolve()
  })

  it.each([false, true])('restores a cleanly stopped Host after installer failure and retains mandatory blocking: %s', async (mandatory) => {
    if (mandatory) {
      harness.embeddedPolicy = { origin: 'https://policy.example.com', allowedPageOrigins: ['https://downloads.example.com'] }
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 40005, data: {
        show_content: { title: 'Update required', detail: 'Please update' }, desktop_app_link: 'https://downloads.example.com/',
      } })))
    }
    const host = await readyForUpdate()
    if (mandatory) await harness.policyBlocked.promise
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const preparing = harness.prepareUpdate()
    if (mandatory) await answerMandatory('install')
    await host.stopping.promise
    host.exited.resolve()
    await expect(preparing).resolves.toBe(true)
    harness.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    const restarted = harness.nextHostStart()
    harness.publishUpdate({ phase: 'error', version: '1.0.1-nightly.1', failedOperation: 'install', message: 'Installer failed' })
    await restarted
    const replacement = harness.hosts[1]!
    replacement.url = 'http://127.0.0.1:3099/?token=replacement'
    if (mandatory) replacement.updateTasks.mockResolvedValue(true)
    const retry = harness.prepareUpdate()
    expect(replacement.updateTasks).not.toHaveBeenCalled()
    replacement.ready.resolve()
    await vi.waitFor(() => { expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/', 'dsh-app://app/']) })
    await expect(Promise.resolve(invoke(DESKTOP_IPC.boot))).resolves.toEqual({ injections: [], streamBaseUrl: 'http://127.0.0.1:3099' })
    if (mandatory) await answerMandatory('later')
    await expect(retry).resolves.toBe(false)
    expect(replacement.updateTasks.mock.calls).toEqual([['inspect']])
    expect(replacement.stop).not.toHaveBeenCalled()
    if (mandatory) {
      expect(harness.windows).toHaveLength(1)
      expect(harness.windows[0]!.isDestroyed()).toBe(false)
    }
  })

  it.each([false, true])('restores a confirmed non-graceful exit without approving installation, mandatory: %s', async (mandatory) => {
    if (mandatory) {
      harness.embeddedPolicy = { origin: 'https://policy.example.com', allowedPageOrigins: ['https://downloads.example.com'] }
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 40005, data: {
        show_content: { title: 'Update required', detail: 'Please update' }, desktop_app_link: 'https://downloads.example.com/',
      } })))
    }
    const host = await readyForUpdate()
    if (mandatory) await harness.policyBlocked.promise
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const preparing = harness.prepareUpdate()
    const rejected = expect(preparing).rejects.toMatchObject(new DesktopUpdatePreparationError('stop-failed', en.updateStopFailed, 'Task teardown failed after child exit'))
    if (mandatory) await answerMandatory('install')
    await host.stopping.promise
    host.exited.reject(new DesktopHostUncleanExitError('Task teardown failed after child exit'))
    await rejected
    expect(host.updateTasks.mock.calls).toEqual([['inspect'], ['lock']])
    harness.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    const restarted = harness.nextHostStart()
    harness.publishUpdate({ phase: 'error', version: '1.0.1-nightly.1', failedOperation: 'install', message: 'Task teardown failed' })
    await restarted
    const replacement = harness.hosts[1]!
    if (mandatory) replacement.updateTasks.mockResolvedValue(true)
    const retry = harness.prepareUpdate()
    expect(replacement.updateTasks).not.toHaveBeenCalled()
    replacement.ready.resolve()
    await vi.waitFor(() => { expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/', 'dsh-app://app/']) })
    if (mandatory) await answerMandatory('later')
    await expect(retry).resolves.toBe(false)
    expect(replacement.updateTasks.mock.calls).toEqual([['inspect']])
    expect(replacement.stop).not.toHaveBeenCalled()
    if (mandatory) {
      expect(harness.windows).toHaveLength(1)
      expect(harness.windows[0]!.isDestroyed()).toBe(false)
    }
  })

  it('does not replace a Host whose failed stop has not confirmed process exit', async () => {
    const host = await readyForUpdate()
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const preparing = harness.prepareUpdate()
    const rejected = expect(preparing).rejects.toThrow('child did not exit')
    await host.stopping.promise
    host.exited.reject(new Error('child did not exit'))
    await rejected
    harness.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    harness.publishUpdate({ phase: 'error', version: '1.0.1-nightly.1', failedOperation: 'install', message: 'child did not exit' })
    await expect(harness.prepareUpdate()).rejects.toThrow('Task status is unavailable')
    expect(harness.hosts).toHaveLength(1)
    expect(host.updateTasks.mock.calls).toEqual([['inspect'], ['lock'], ['unlock']])
  })

  it('reports replacement startup failure without authorizing installation or retrying automatically', async () => {
    const host = await readyForUpdate()
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const preparing = harness.prepareUpdate()
    const rejected = expect(preparing).rejects.toMatchObject(new DesktopUpdatePreparationError('stop-failed', en.updateStopFailed, 'Task teardown failed after child exit'))
    await host.stopping.promise
    host.exited.reject(new DesktopHostUncleanExitError('Task teardown failed after child exit'))
    await rejected
    harness.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    const restarted = harness.nextHostStart()
    harness.publishUpdate({ phase: 'error', version: '1.0.1-nightly.1', failedOperation: 'install', message: 'Task teardown failed' })
    await restarted
    const replacement = harness.hosts[1]!
    harness.dialog.showMessageBox.mockImplementation(() => { harness.dialogShown.resolve(); return new Promise(() => {}) })
    replacement.ready.reject(new Error('replacement startup failed'))
    replacement.exited.resolve()
    await harness.dialogShown.promise
    expect(harness.dialog.showMessageBox.mock.calls.some(call =>
      (call.at(-1) as MessageBoxOptions).detail?.includes('replacement startup failed'))).toBe(true)
    await expect(harness.prepareUpdate()).rejects.toThrow('replacement startup failed')
    expect(harness.hosts).toHaveLength(2)
  })

  it('opens fatal recovery when the replacement page cannot reload', async () => {
    const host = await readyForUpdate()
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const preparing = harness.prepareUpdate()
    await host.stopping.promise
    host.exited.resolve()
    await expect(preparing).resolves.toBe(true)
    const window = harness.windows[0]!
    vi.spyOn(window, 'loadURL').mockRejectedValueOnce(new Error('replacement page failed to load'))
    harness.dialog.showMessageBox.mockImplementation((options: MessageBoxOptions) => {
      if (options.detail?.includes('replacement page failed to load')) {
        harness.dialogShown.resolve()
        return new Promise(() => {})
      }
      return Promise.resolve({ response: 1 })
    })
    const restarted = harness.nextHostStart()
    harness.publishUpdate({ phase: 'error', version: '1.0.1-nightly.1', failedOperation: 'install', message: 'Installer failed' })
    await restarted
    harness.hosts[1]!.ready.resolve()
    await harness.dialogShown.promise
    expect(harness.dialog.showMessageBox.mock.calls.some(call =>
      (call.at(-1) as MessageBoxOptions).detail?.includes('replacement page failed to load'))).toBe(true)
  })

  it('reports a window construction failure without requiring a window', async () => {
    const shown = Promise.withResolvers<undefined>()
    harness.dialog.showMessageBox.mockImplementation(() => { shown.resolve(undefined); return new Promise(() => {}) })
    harness.failWindow(new Error('window creation failed'))
    await import('../src/main.ts')
    await shown.promise
    expect(harness.windows).toHaveLength(0)
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).toContain('window creation failed')
  })

  it('accepts Web fatal reports only from the primary application frame', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    const frame = { url: 'dsh-app://app/' }
    Object.assign(window.webContents, { mainFrame: frame })
    const handler = harness.handlers.get(DESKTOP_IPC.bootFailed)! as (event: unknown, message: unknown) => void
    const event = { sender: window.webContents, senderFrame: frame }
    expect(() => { handler({ ...event, senderFrame: { url: 'https://other.example/' } }, 'untrusted') }).toThrow('unowned renderer')
    expect(() => { handler({ ...event, senderFrame: { ...frame } }, 'subframe') }).toThrow('non-primary frame')
    expect(() => { handler(event, {}) }).toThrow('must be text')
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    handler(event, 'client mount failed')
    await harness.dialogShown.promise
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).toContain('client mount failed')
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).toContain('desktop-test-logs/crash-test.log')
    expect(writeCrashReport).toHaveBeenCalledWith('desktop-test-logs', expect.objectContaining({ source: 'web-boot', phase: 'startup' }))
    expect(window.urls).toEqual(['dsh-app://app/'])
  })

  it('ignores subresource failures and navigation cancellation but reports a failed main document', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    window.webContents.emit('did-fail-load', {}, -2, 'failed', 'dsh-app://app/image.png', false)
    window.webContents.emit('did-fail-load', {}, -3, 'aborted', 'dsh-app://app/', true)
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    window.webContents.emit('did-fail-load', {}, -2, 'failed', 'dsh-app://app/', true)
    await harness.dialogShown.promise
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).toContain('Desktop page failed to load')
    expect(writeCrashReport).toHaveBeenCalledWith('desktop-test-logs', expect.objectContaining({ source: 'renderer' }))
  })

  it('offers all recovery choices when resources fail before the Host starts', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.reject(new Error('runtime resources missing'))
    await harness.dialogShown.promise
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).toContain('runtime resources missing')
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).buttons).toEqual(['Exit', 'Restart', 'Disable third-party plugins, back up profile patch, and restart'])
    expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/'])
  })

  it.each(['preload', 'renderer'])('retains the document after a fatal %s failure and reports only the first error', async (kind) => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    if (kind === 'preload') window.webContents.emit('preload-error', {}, 'preload-app.cjs', new Error('preload unavailable'))
    else window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    window.webContents.emit('preload-error', {}, 'preload-app.cjs', new Error('secondary failure'))
    harness.prepared.reject(new Error('backend also failed'))
    await harness.dialogShown.promise
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).not.toContain('secondary failure')
    expect(window.urls).toEqual(['dsh-app://app/'])
  })

  it('ignores clean renderer exits and exits of a destroyed window', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    window.webContents.emit('render-process-gone', {}, { reason: 'clean-exit' })
    window.destroy()
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('reports a rejected document load without navigating to a recovery page', async () => {
    const shown = Promise.withResolvers<undefined>()
    harness.dialog.showMessageBox.mockImplementation(() => { shown.resolve(undefined); return new Promise(() => {}) })
    vi.spyOn(harness.FakeWindow.prototype, 'loadURL').mockRejectedValueOnce(new Error('document missing'))
    await import('../src/main.ts')
    await shown.promise
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).toContain('document missing')
    expect(harness.hosts).toHaveLength(0)
  })

  it('writes the Host\'s own diagnostic into a startup-phase crash report when the Host reports a fatal error before ready', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const host = harness.hosts[0]!
    const diagnostic = "Error: profile has no cordis.yml\n    at loadProfileDirectory (app-boot/lib/index.js:12:3) {\n  code: 'ENOENT',\n  path: '/profiles/desktop/cordis.yml'\n}"
    // DesktopHostProcess.fail() rejects start() and calls onFailure with the same error object.
    const failure = new DesktopHostFatalError('profile has no cordis.yml', diagnostic)
    host.onFailure!(failure)
    host.ready.reject(failure)
    await host.stopping.promise
    host.exited.resolve()
    await harness.dialogShown.promise
    const [directory, report] = vi.mocked(writeCrashReport).mock.calls[0]!
    expect(directory).toBe('desktop-test-logs')
    expect(report.source).toBe('host')
    expect(report.phase).toBe('startup')
    expect(report.error).toBeInstanceOf(DesktopHostFatalError)
    expect(report.hostDiagnostic).toBe(diagnostic)
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).toContain('profile has no cordis.yml')
  })

  it('attaches the primary window\'s error-level console output to a running-phase Host crash report', async () => {
    harness.dialog.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const host = harness.hosts[0]!
    host.ready.resolve()
    await Promise.resolve(invoke(DESKTOP_IPC.boot))
    const window = harness.windows[0]!
    window.webContents.emit('console-message', { level: 'info', message: 'boot ok', sourceId: 'dsh-app://app/assets/entry.js', lineNumber: 1 })
    window.webContents.emit('console-message', {
      level: 'error', message: 'client-modules: bundle script plugins/??a/client.js&rev=1 failed to load',
      sourceId: 'dsh-app://app/assets/entry.js', lineNumber: 12,
    })
    host.onFailure!(new Error('dsh desktop host exited with 1: fatal uncaught exception: ENOENT'))
    await host.stopping.promise
    expect(writeCrashReport).toHaveBeenCalledOnce()
    const [directory, report] = vi.mocked(writeCrashReport).mock.calls[0]!
    expect(directory).toBe('desktop-test-logs')
    expect(report.source).toBe('host')
    expect(report.phase).toBe('running')
    expect(report.error).toBeInstanceOf(Error)
    expect((report.error as Error).message).toContain('fatal uncaught exception: ENOENT')
    expect(report.rendererConsole).toEqual(['dsh-app://app/assets/entry.js:12 client-modules: bundle script plugins/??a/client.js&rev=1 failed to load'])
    expect(report.app).toMatchObject({ name: 'Desktop test', version: '1.0.0', platform: process.platform, locale: 'en' })
    expect(report.time).toBeInstanceOf(Date)
    host.exited.resolve()
    await harness.quitCompleted.promise
  })

  it.each([0, 1, 2])('waits for Host exit before recovery action %s', async (response) => {
    harness.dialog.showMessageBox.mockResolvedValue({ response, checkboxChecked: false })
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const host = harness.hosts[0]!
    host.ready.resolve()
    await Promise.resolve(invoke(DESKTOP_IPC.boot))
    host.onFailure!(new Error('backend exited'))
    await host.stopping.promise
    expect(harness.app.relaunch).not.toHaveBeenCalled()
    expect(harness.disableAllPlugins).not.toHaveBeenCalled()
    host.exited.resolve()
    await harness.quitCompleted.promise
    expect(harness.app.relaunch).toHaveBeenCalledTimes(response === 0 ? 0 : 1)
    expect(harness.disableAllPlugins).toHaveBeenCalledTimes(response === 2 ? 1 : 0)
    if (response === 2) {
      expect(console.info).toHaveBeenCalledWith('Desktop profile recovery completed:', {
        profilePatchBackup: 'desktop-test-profile/cordis.patch.yml.bak-1789555200000', homePatch: 'unchanged',
      })
    } else {
      expect(console.info).not.toHaveBeenCalled()
    }
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/'])
  })

  it('creates the Host only after the login-shell read and ends the read on quit', async () => {
    let finishRead!: () => void
    const read = new Promise<void>((resolve) => { finishRead = resolve })
    harness.loginShell.mockImplementation(async (base) => { await read; return harness.readLoginShell(base) })
    await import('../src/main.ts')
    await harness.preparing.promise
    const boot = invoke(DESKTOP_IPC.boot)
    harness.prepared.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.hosts).toHaveLength(0)
    finishRead()
    await harness.hostStarted.promise
    expect(harness.hosts[0]!.environment?.DSH_TEST_LOGIN_SHELL).toBe('login')
    harness.hosts[0]!.ready.resolve()
    await Promise.all([boot, harness.navigated.promise])
    const { signal } = harness.loginShell.mock.calls[0]![2]
    expect(signal?.aborted).toBe(false)
    harness.app.emit('will-quit')
    expect(signal?.aborted).toBe(true)
  })

  it('prepares recovery offscreen and starts one Host before choosing the first visible window', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    expect(harness.windows).toHaveLength(1)
    const window = harness.windows[0]!
    expect(window.options.show).toBe(false)
    expect(window.show).not.toHaveBeenCalled()
    expect(window.urls).toEqual(['dsh-app://app/'])
    expect(harness.hosts).toHaveLength(0)
    const retry = invoke(DESKTOP_IPC.boot)
    const secondRetry = invoke(DESKTOP_IPC.boot)
    harness.prepared.resolve()
    await harness.hostStarted.promise
    expect(harness.hosts).toHaveLength(1)
    expect(window.urls).toEqual(['dsh-app://app/'])
    harness.hosts[0]!.ready.resolve()
    await Promise.all([retry, secondRetry, harness.navigated.promise])
    expect(harness.applyRelease).toHaveBeenCalledTimes(1)
    expect(harness.hosts[0]).toMatchObject({
      node: process.execPath,
      runtime: join(harness.app.getAppPath(), 'dsh'),
      primaryRuntime: join('desktop-test-resources', 'runtime', 'primary-runtime'),
      profile: 'desktop-test-profile',
    })
    expect(harness.hosts[0]!.environment).not.toBe(process.env)
    expect(harness.hosts[0]!.environment?.DSH_CLIENT_VERSION).toBe('1.2.3')
    expect(harness.hosts[0]!.environment?.DSH_TEST_LOGIN_SHELL).toBe('login')
    expect(console.warn).toHaveBeenCalledWith('desktop login shell: /account/shell failed (timeout)')
    expect(harness.analytics).toHaveBeenCalledExactlyOnceWith({ eventName: 'desktop_app_launch', timestamp: Date.now(), attributes: {} })
    expect(harness.hosts[0]!.start).toHaveBeenCalledTimes(1)
    expect(harness.windows).toHaveLength(1)
    expect(window.urls).toEqual(['dsh-app://app/'])
  })

  it('prepares an independent plugin profile for the unpackaged Host', async () => {
    harness.app.isPackaged = false
    vi.stubEnv('DSH_DESKTOP_DSH_DIR', undefined)
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const project = join(harness.app.getAppPath(), '.desktop-build', 'development', 'project')
    expect(harness.hosts[0]).toMatchObject({ node: process.execPath, runtime: project,
      primaryRuntime: 'test-primary-runtime', profile: 'desktop-test-profile' })
    expect(harness.applyRelease).toHaveBeenCalledOnce()
    harness.hosts[0]!.ready.resolve()
    await harness.navigated.promise
    expect(harness.dialog.showErrorBox).not.toHaveBeenCalled()
  })

  it('fails an unpackaged launch that receives no primary runtime directory', async () => {
    harness.app.isPackaged = false
    vi.stubEnv('DSH_DESKTOP_PRIMARY_RUNTIME_DIR', undefined)
    await import('../src/main.ts')
    await harness.dialogShown.promise
    const options = harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions
    expect(options.detail).toContain('DSH_DESKTOP_PRIMARY_RUNTIME_DIR is required for an unpackaged launch')
    expect(harness.hosts).toHaveLength(0)
  })

  it('keeps startup errors in the existing window without a retry handler', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const first = harness.hosts[0]!
    first.exited.resolve()
    first.ready.reject(new Error('plugin composition failed'))
    await harness.dialogShown.promise
    expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/'])
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect(harness.handlers.has('dsh-desktop:backend-retry')).toBe(false)
    expect(harness.hosts).toHaveLength(1)
  })

  it('keeps recovery visible when the backend fails during the welcome preference read', async () => {
    const preferences = Promise.withResolvers<Response>()
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const host = harness.hosts[0]!
    host.fetch.mockReturnValueOnce(preferences.promise)
    const startup = expect(Promise.resolve(invoke(DESKTOP_IPC.boot))).rejects.toThrow('Desktop Host is unavailable')
    host.ready.resolve()
    await vi.waitFor(() => { expect(host.fetch).toHaveBeenCalledOnce() })
    host.exited.resolve()
    host.onFailure!(new Error('backend exited during startup preferences'))
    await harness.dialogShown.promise
    preferences.resolve(Response.json({ hasApiKey: true, localePreference: null }))
    await startup
    expect(harness.windows[0]!.urls).not.toContain('http://127.0.0.1:3080/?token=test')
    const failureDialog = harness.dialog.showMessageBox.mock.calls[0]![0] as { detail: string }
    expect(failureDialog.detail).toContain('backend exited during startup preferences')
    expect(harness.windows[0]!.show).not.toHaveBeenCalled()
  })

  it('waits for a pending child to exit on quit without late window navigation', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const window = harness.windows[0]!
    const host = harness.hosts[0]!
    host.stop.mockImplementation(() => { host.stopping.resolve(); return host.exited.promise })
    window.close()
    harness.app.quit()
    await host.stopping.promise
    expect(harness.app.quit).toHaveBeenCalledTimes(1)
    host.ready.resolve()
    host.exited.resolve()
    await harness.quitCompleted.promise
    expect(host.stop).toHaveBeenCalledTimes(1)
    expect(window.urls).toEqual(['dsh-app://app/'])
    expect(harness.windows).toHaveLength(1)
  })
})

it.each(['failed', 'expired'] as const)('focuses DSH once when browser authorization becomes %s', async (phase) => {
  await import('../src/main.ts')
  await harness.preparing.promise
  harness.prepared.resolve()
  await harness.hostStarted.promise
  harness.hosts[0]!.ready.resolve()
  await Promise.resolve(invoke(DESKTOP_IPC.boot))
  const window = harness.windows[0]!
  window.focus.mockClear()
  const state: AccountView = {
    status: 'signed-out', links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' },
    attempt: { id: 'test-failed-attempt' as NonNullable<AccountView['attempt']>['id'], phase },
  }
  harness.publishAccount(state)
  harness.publishAccount(state)
  expect(window.focus).toHaveBeenCalledTimes(1)
})

it.each([['light', false], ['dark', true]] as const)('opens Platform authorization in the effective %s palette', async (theme, shouldUseDarkColors) => {
  await import('../src/main.ts')
  await harness.preparing.promise
  harness.prepared.resolve()
  await harness.hostStarted.promise
  harness.hosts[0]!.ready.resolve()
  await Promise.resolve(invoke(DESKTOP_IPC.boot))
  harness.nativeTheme.shouldUseDarkColors = shouldUseDarkColors
  const state: AccountView = {
    status: 'signed-out', links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' },
    attempt: { id: 'test-theme-attempt' as NonNullable<AccountView['attempt']>['id'], phase: 'waiting-browser',
      authorizeUrl: 'https://platform.deepseek.com/dsh/authorize?state=state-1' },
  }
  harness.publishAccount(state)
  harness.publishAccount(state)
  expect(harness.openExternal).toHaveBeenCalledExactlyOnceWith(`https://platform.deepseek.com/dsh/authorize?state=state-1&theme=${theme}`)
})

it('disables native product events for a disabled Desktop launch', async () => {
  harness.analyticsEnabled = false
  await import('../src/main.ts')
  await harness.preparing.promise
  harness.prepared.resolve()
  await harness.hostStarted.promise
  harness.hosts[0]!.ready.resolve()
  await harness.navigated.promise
  expect(harness.analytics).not.toHaveBeenCalled()
  harness.analyticsEnabled = true
})
