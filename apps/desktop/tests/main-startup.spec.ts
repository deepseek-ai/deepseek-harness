import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { DESKTOP_IPC } from '../src/ipc.ts'

const harness = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  function deferred() {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((accept, decline) => { resolve = accept; reject = decline })
    return { promise, resolve, reject }
  }
  const windows: FakeWindow[] = []
  const hosts: FakeHost[] = []
  const handlers = new Map<string, (event: { senderFrame: { url: string } }) => unknown>()
  let pluginsEnabled = false
  let preparing = deferred()
  let prepared = deferred()
  let hostStarted = deferred()
  let navigated = deferred()
  let errorPublished = deferred()
  let quitCompleted = deferred()
  class FakeWindow extends EventEmitter {
    destroyed = false
    readonly urls: string[] = []
    readonly webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
      openDevTools: vi.fn(),
      getURL: () => this.urls.at(-1) ?? '',
      send: vi.fn((channel: string, state: { phase?: string }) => {
        if (channel === 'dsh-desktop:backend-state' && state.phase === 'error') errorPublished.resolve()
      }),
    })
    readonly show = vi.fn()
    readonly focus = vi.fn()
    readonly restore = vi.fn()
    constructor(readonly options: { show: boolean }) { super(); windows.push(this) }
    isDestroyed() { return this.destroyed }
    isMinimized() { return false }
    async loadURL(url: string) {
      this.urls.push(url)
      if (url === 'dsh-app://app/index.html') navigated.resolve()
    }
    static getAllWindows() { return windows.filter(window => !window.destroyed) }
    close() { this.destroyed = true; this.emit('closed') }
  }
  class FakeHost {
    readonly ready = deferred()
    readonly exited = deferred()
    readonly stopping = deferred()
    readonly start = vi.fn(() => { hostStarted.resolve(); return this.ready.promise })
    readonly stop = vi.fn(() => {
      this.stopping.resolve()
      this.ready.reject(new Error('child stopped'))
      return this.exited.promise
    })
    constructor(readonly node: string, readonly runtime: string, readonly profile: string) { hosts.push(this) }
  }
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    name: 'Desktop test',
    whenReady: () => Promise.resolve(),
    getLocale: () => 'en-US',
    getVersion: () => '1.0.0',
    getAppPath: () => 'desktop-test-app',
    requestSingleInstanceLock: () => true,
    exit: vi.fn(),
    relaunch: vi.fn(),
    quit: vi.fn(() => {
      const event = { preventDefault: vi.fn() }
      app.emit('before-quit', event)
      if (event.preventDefault.mock.calls.length === 0) quitCompleted.resolve()
    }),
  })
  return {
    windows, hosts, handlers, app, FakeWindow, FakeHost,
    dialog: { showErrorBox: vi.fn(), showMessageBox: vi.fn() },
    applyRelease: vi.fn(() => { preparing.resolve(); return prepared.promise }),
    assertProfileRuntime: vi.fn(),
    canRecoverProfile: vi.fn(() => true),
    get preparing() { return preparing }, get prepared() { return prepared },
    get hostStarted() { return hostStarted }, get navigated() { return navigated },
    get errorPublished() { return errorPublished }, get quitCompleted() { return quitCompleted },
    nextHostStart() { hostStarted = deferred(); return hostStarted.promise },
    get pluginsEnabled() { return pluginsEnabled },
    set pluginsEnabled(value: boolean) { pluginsEnabled = value },
    reset() {
      windows.length = 0; hosts.length = 0; handlers.clear(); app.removeAllListeners()
      app.isPackaged = true
      pluginsEnabled = false
      preparing = deferred(); prepared = deferred(); hostStarted = deferred()
      navigated = deferred(); errorPublished = deferred(); quitCompleted = deferred()
    },
  }
})

vi.mock('electron', () => ({
  app: harness.app,
  BrowserWindow: harness.FakeWindow,
  dialog: harness.dialog,
  ipcMain: {
    handle: (channel: string, handler: (event: { senderFrame: { url: string } }) => unknown) => { harness.handlers.set(channel, handler) },
  },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
}))
vi.mock('../src/paths.ts', () => ({ resolveDesktopPaths: () => ({ profile: 'desktop-test-profile' }) }))
vi.mock('../src/project-manager.ts', () => ({
  DesktopProjectManager: class {
    readonly applyRelease = harness.applyRelease
    readonly assertProfileRuntime = harness.assertProfileRuntime
    canRecoverProfile = harness.canRecoverProfile
    async mutate(_mutation: unknown, hooks: { beforeChange(): Promise<void>; afterChange(): Promise<void> }) {
      await hooks.beforeChange()
      harness.pluginsEnabled = false
      await hooks.afterChange()
    }
    async resetConfiguration(hooks: { beforeChange(): Promise<void>; afterChange(): Promise<void> }) {
      await this.mutate(undefined, hooks)
    }
  },
}))
vi.mock('../src/host-process.ts', () => ({ DesktopHostProcess: harness.FakeHost }))
vi.mock('../src/update-coordinator.ts', () => ({ DesktopUpdateCoordinator: vi.fn() }))

function invoke(channel: string): unknown {
  const handler = harness.handlers.get(channel)
  if (handler === undefined) throw new Error(`missing handler ${channel}`)
  return handler({ senderFrame: { url: 'dsh-app://shell/startup.html' } })
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  harness.reset()
  vi.stubEnv('DSH_DESKTOP_NODE_BINARY', 'test-node')
  vi.stubEnv('DSH_DESKTOP_PNPM_ENTRY', 'test-pnpm')
  vi.stubEnv('DSH_DESKTOP_DSH_DIR', 'test-runtime')
  vi.stubGlobal('process', { ...process, resourcesPath: 'desktop-test-resources' })
  vi.stubEnv('DSH_DESKTOP_HOST_INSPECT_PORT', undefined)
})

afterEach(async () => {
  harness.prepared.resolve()
  for (const host of harness.hosts) { host.ready.resolve(); host.exited.resolve() }
  harness.app.quit()
  await harness.quitCompleted.promise
  vi.restoreAllMocks()
  harness.canRecoverProfile.mockReturnValue(true)
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('desktop main startup', () => {
  it('exits with a diagnostic when both initialization and emergency navigation fail', async () => {
    const exited = Promise.withResolvers<undefined>()
    vi.spyOn(harness.app, 'getLocale').mockImplementationOnce(() => { throw new Error('locale unavailable') })
    vi.spyOn(harness.FakeWindow.prototype, 'loadURL').mockRejectedValueOnce(new Error('emergency navigation failed'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    harness.app.exit.mockImplementationOnce(() => { exited.resolve(undefined) })
    await import('../src/main.ts')
    await exited.promise
    expect(harness.app.exit).toHaveBeenCalledWith(1)
    expect(console.error).toHaveBeenCalledWith(expect.objectContaining({ message: 'emergency navigation failed' }))
  })

  it('withholds profile recovery after application resources fail to load', async () => {
    harness.canRecoverProfile.mockReturnValue(false)
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.reject(new Error('runtime resources missing'))
    await harness.errorPublished.promise
    expect(invoke(DESKTOP_IPC.backendStatus)).toMatchObject({ phase: 'error', profileRecovery: false })
    const window = harness.windows[0]!
    window.webContents.emit('preload-error', {}, 'preload-app.cjs', new Error('preload unavailable'))
    const html = decodeURIComponent(window.urls.at(-1)!)
    expect(html).toContain('dsh-recovery://restart')
    expect(html).not.toContain('dsh-recovery://reset')
    expect(html).not.toContain('dsh-recovery://plugins')
  })

  it('reloads a crashed startup renderer in the same window', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    await harness.errorPublished.promise
    expect(window.urls).toEqual(['dsh-app://shell/startup.html', 'dsh-app://shell/startup.html'])
    expect(invoke(DESKTOP_IPC.backendStatus)).toMatchObject({ phase: 'error', message: 'Desktop renderer exited: crashed' })
  })

  it.each(['plugins', 'reset'])('runs %s recovery from a document with a broken preload', async (action) => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    window.webContents.emit('preload-error', {}, 'preload-app.cjs', new Error('preload unavailable'))
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.ready.resolve()
    await Promise.resolve(invoke(DESKTOP_IPC.backendRetry))
    const started = harness.nextHostStart()
    const event = { preventDefault: vi.fn() }
    window.webContents.emit('will-navigate', event, `dsh-recovery://${action}/?`)
    await harness.hosts[0]!.stopping.promise
    harness.hosts[0]!.exited.resolve()
    await started
    harness.hosts[1]!.ready.resolve()
    await harness.navigated.promise
    expect(event.preventDefault).toHaveBeenCalled()
    expect(window.urls.at(-1)).toBe('dsh-app://app/index.html')
  })

  it('allows a full profile reset for an unclassified startup failure', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.exited.resolve()
    harness.hosts[0]!.ready.reject(new Error('Unknown startup failure'))
    await harness.errorPublished.promise
    const started = harness.nextHostStart()
    const reset = Promise.resolve(invoke(DESKTOP_IPC.configurationReset))
    await started
    harness.hosts[1]!.ready.resolve()
    await reset
    expect(invoke(DESKTOP_IPC.backendStatus)).toEqual({ phase: 'ready' })
  })

  it('keeps a self-contained reinstall document in the main window after preload failure', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    window.webContents.emit('preload-error', {}, 'preload-app.cjs', new Error('preload unavailable'))
    expect(window.urls.at(-1)).toContain('data:text/html')
    expect(decodeURIComponent(window.urls.at(-1)!)).toContain('preload unavailable')
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.ready.resolve()
    await Promise.resolve(invoke(DESKTOP_IPC.backendRetry))
    expect(harness.windows).toHaveLength(1)
    expect(window.urls.at(-1)).toContain('data:text/html')
    expect(harness.dialog.showErrorBox).not.toHaveBeenCalled()
  })

  it('offers plugin recovery and disables plugins before restarting in the same window', async () => {
    harness.pluginsEnabled = true
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.exited.resolve()
    harness.hosts[0]!.ready.reject(new Error('Plugin initialization failed'))
    await harness.errorPublished.promise
    expect(invoke(DESKTOP_IPC.backendStatus)).toMatchObject({ phase: 'error', profileRecovery: true })
    const nextStarted = harness.nextHostStart()
    const recovery = Promise.resolve(invoke(DESKTOP_IPC.pluginsDisableAll))
    await nextStarted
    expect(harness.pluginsEnabled).toBe(false)
    harness.hosts[1]!.ready.resolve()
    await recovery
    expect(harness.windows).toHaveLength(1)
    expect(invoke(DESKTOP_IPC.backendStatus)).toEqual({ phase: 'ready' })
  })

  it('waits for Host exit before relaunching the application', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.ready.resolve()
    await harness.navigated.promise
    const restart = Promise.resolve(invoke(DESKTOP_IPC.applicationRestart))
    await harness.hosts[0]!.stopping.promise
    expect(harness.app.relaunch).not.toHaveBeenCalled()
    harness.hosts[0]!.exited.resolve()
    await restart
    expect(harness.app.relaunch).toHaveBeenCalledOnce()
  })

  it('shows the loading window before profile preparation and starts one actual Host', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    expect(harness.windows).toHaveLength(1)
    const window = harness.windows[0]!
    expect(window.options.show).toBe(true)
    expect(window.urls).toEqual(['dsh-app://shell/startup.html'])
    expect(harness.hosts).toHaveLength(0)
    const retry = invoke(DESKTOP_IPC.backendRetry)
    const secondRetry = invoke(DESKTOP_IPC.backendRetry)
    harness.prepared.resolve()
    await harness.hostStarted.promise
    expect(harness.hosts).toHaveLength(1)
    expect(window.urls).toEqual(['dsh-app://shell/startup.html'])
    harness.hosts[0]!.ready.resolve()
    await Promise.all([retry, secondRetry, harness.navigated.promise])
    expect(harness.applyRelease).toHaveBeenCalledTimes(1)
    expect(harness.assertProfileRuntime).toHaveBeenCalledWith('desktop-test-profile')
    expect(harness.hosts[0]).toMatchObject({
      node: join('desktop-test-resources', 'runtime', 'node', process.platform === 'win32' ? 'node.exe' : 'node'),
      runtime: join('desktop-test-resources', 'dsh'),
      profile: 'desktop-test-profile',
    })
    expect(harness.hosts[0]!.start).toHaveBeenCalledTimes(1)
    expect(harness.windows).toHaveLength(1)
    expect(window.urls).toEqual(['dsh-app://shell/startup.html', 'dsh-app://app/index.html'])
    expect(invoke(DESKTOP_IPC.backendStatus)).toEqual({ phase: 'ready' })
  })

  it('starts the unpackaged Host from the application development directory', async () => {
    harness.app.isPackaged = false
    await import('../src/main.ts')
    await harness.hostStarted.promise
    const project = join(harness.app.getAppPath(), '.desktop-build', 'development', 'project')
    expect(harness.hosts[0]).toMatchObject({ node: 'test-node', runtime: project, profile: project })
    expect(harness.applyRelease).not.toHaveBeenCalled()
    expect(harness.assertProfileRuntime).not.toHaveBeenCalled()
    harness.hosts[0]!.ready.resolve()
    await harness.navigated.promise
    expect(harness.dialog.showErrorBox).not.toHaveBeenCalled()
  })

  it('keeps startup errors and a successful retry in the same window', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const first = harness.hosts[0]!
    const failedRetry = expect(Promise.resolve(invoke(DESKTOP_IPC.backendRetry))).rejects.toThrow('plugin composition failed')
    first.exited.resolve()
    first.ready.reject(new Error('plugin composition failed'))
    await harness.errorPublished.promise
    await failedRetry
    expect(invoke(DESKTOP_IPC.backendStatus)).toEqual({ phase: 'error', message: 'plugin composition failed', profileRecovery: true })
    expect(harness.windows[0]!.urls).toEqual(['dsh-app://shell/startup.html'])
    const nextStarted = harness.nextHostStart()
    const retry = Promise.resolve(invoke(DESKTOP_IPC.backendRetry))
    await nextStarted
    expect(harness.hosts).toHaveLength(2)
    harness.hosts[1]!.ready.resolve()
    await retry
    expect(harness.windows).toHaveLength(1)
    expect(harness.windows[0]!.urls.at(-1)).toBe('dsh-app://app/index.html')
    expect(harness.dialog.showErrorBox).not.toHaveBeenCalled()
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
    expect(window.urls).toEqual(['dsh-app://shell/startup.html'])
    expect(harness.windows).toHaveLength(1)
  })
})
