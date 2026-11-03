import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdater } from 'electron-updater'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { parseDesktopRelease } from '../src/release.ts'
import type { DesktopUpdateState } from '../src/ipc.ts'
import { DesktopUpdatePreparationError } from '../src/update-error.ts'
import { zh } from '../src/locale.ts'

vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('electron-updater', () => ({
  default: { autoUpdater: { autoDownload: true, autoInstallOnAppQuit: true } },
}))

const { DesktopUpdateCoordinator } = await import('../src/update-coordinator.ts')

describe('desktop release metadata', () => {
  it('accepts one exact release identity for Electron and dsh', () => {
    expect(parseDesktopRelease({
      schemaVersion: 1,
      version: '1.2.3',
      hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      nodeVersion: '24.17.0',
      pnpmVersion: '11.7.0',
    })).toEqual({
      schemaVersion: 1,
      version: '1.2.3',
      hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      nodeVersion: '24.17.0',
      pnpmVersion: '11.7.0',
    })
  })

  it('rejects invalid versions and unsupported host protocols', () => {
    const base = {
      schemaVersion: 1,
      version: '1.2.3',
      hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      nodeVersion: '24.17.0',
      pnpmVersion: '11.7.0',
    }
    expect(() => parseDesktopRelease({ ...base, version: 'stable' })).toThrow(/invalid desktop release metadata/u)
    expect(() => parseDesktopRelease({ ...base, hostProtocolVersion: 999 })).toThrow(/invalid desktop release metadata/u)
  })
})

const coordinators: InstanceType<typeof DesktopUpdateCoordinator>[] = []
afterEach(() => { for (const item of coordinators.splice(0)) item.dispose() })

function fixture(channel: 'nightly' | 'stable' = 'nightly', version = '1.1.0-alpha.1', discard?: (updater: AppUpdater) => Promise<void>) {
  const events = new EventEmitter()
  const checkForUpdates = vi.fn(async () => ({
    isUpdateAvailable: true,
    updateInfo: { version: '1.1.0-rc.2' },
  }))
  const downloadUpdate = vi.fn(async () => {
    events.emit('download-progress', { percent: 58 })
    events.emit('download-progress', { percent: 100 })
    events.emit('update-downloaded', { version: '1.1.0-rc.2' })
    return ['verified-package']
  })
  const quitAndInstall = vi.fn()
  const beforeRestart = vi.fn(async () => true)
  const downloadResult = vi.fn()
  const states: DesktopUpdateState[] = []
  const updater = Object.assign(events, { checkForUpdates, downloadUpdate, quitAndInstall }) as unknown as AppUpdater
  const coordinator = new DesktopUpdateCoordinator(
    (state) => { states.push(state); return state },
    beforeRestart, updater, () => true, () => version, downloadResult, channel, discard,
  )
  coordinators.push(coordinator)
  return { coordinator, updater, events, states, checkForUpdates, downloadUpdate, quitAndInstall, beforeRestart, downloadResult }
}

describe('desktop update coordinator', () => {
  it.each(['stop-failed', 'fullscreen-timeout'] as const)('keeps safe %s diagnostics separate and clears them on an explicit retry', async (kind) => {
    const f = fixture()
    await f.coordinator.check()
    await f.coordinator.download('1.1.0-rc.2')
    f.beforeRestart.mockRejectedValueOnce(new DesktopUpdatePreparationError(kind, zh.updateStopFailed, 'exit 0; shutdown acknowledged false'))
    expect(await f.coordinator.install('1.1.0-rc.2')).toEqual({ phase: 'error', version: '1.1.0-rc.2',
      failedOperation: 'install', preparationFailure: kind, message: zh.updateStopFailed,
      technicalDetails: 'exit 0; shutdown acknowledged false' })
    expect(f.quitAndInstall).not.toHaveBeenCalled()
    f.beforeRestart.mockResolvedValueOnce(false)
    expect(await f.coordinator.install('1.1.0-rc.2')).toEqual({ phase: 'ready', version: '1.1.0-rc.2' })
    expect(f.quitAndInstall).not.toHaveBeenCalled()
  })

  it('retains an asynchronous installer failure after quitAndInstall returns', async () => {
    const f = fixture()
    await f.coordinator.check()
    await f.coordinator.download('1.1.0-rc.2')
    await f.coordinator.install('1.1.0-rc.2')
    f.events.emit('error', new Error('installer could not start'))
    expect(f.coordinator.state).toMatchObject({ phase: 'error', failedOperation: 'install', message: 'installer could not start' })
  })

  it('waits for platform preparation after its downloaded event and rejects stale download approval', async () => {
    const f = fixture()
    const prepared = Promise.withResolvers<string[]>()
    f.downloadUpdate.mockImplementationOnce(async () => {
      f.events.emit('update-downloaded', { version: '1.1.0-rc.2' })
      return prepared.promise
    })
    await f.coordinator.check()
    await expect(f.coordinator.download('1.1.0-rc.1')).rejects.toThrow(/stale/u)
    const downloading = f.coordinator.download('1.1.0-rc.2')
    await Promise.resolve()
    await Promise.resolve()
    try {
      expect(f.coordinator.state.phase).not.toBe('ready')
      await expect(f.coordinator.install('1.1.0-rc.2')).rejects.toThrow(/not ready/u)
    } finally { prepared.resolve(['verified']); await downloading }
    expect(f.coordinator.state.phase).toBe('ready')
  })

  it('consumes late updater errors until an in-flight check settles after disposal', async () => {
    const f = fixture()
    const checked = Promise.withResolvers<{ isUpdateAvailable: boolean; updateInfo: { version: string } }>()
    f.checkForUpdates.mockImplementation(() => checked.promise)
    const pending = f.coordinator.check()
    await Promise.resolve()
    f.coordinator.dispose()
    expect(() => f.events.emit('error', new Error('late network failure'))).not.toThrow()
    checked.reject(new Error('offline'))
    await pending
    await Promise.resolve()
    expect(f.events.listenerCount('error')).toBe(0)
  })

  it('checks, downloads on demand, then requires separate installation approval', async () => {
    const f = fixture()
    await f.coordinator.check()
    expect(f.downloadUpdate).not.toHaveBeenCalled()
    await expect(f.coordinator.install('1.1.0-rc.2')).rejects.toThrow(/not ready/u)
    await f.coordinator.download('1.1.0-rc.2')
    expect(f.quitAndInstall).not.toHaveBeenCalled()
    expect(f.beforeRestart).not.toHaveBeenCalled()
    expect(f.coordinator.state).toEqual({ phase: 'ready', version: '1.1.0-rc.2' })
    await f.coordinator.install('1.1.0-rc.2')
    expect(f.beforeRestart).toHaveBeenCalledOnce()
    expect(f.quitAndInstall).toHaveBeenCalledWith(true, true)
    expect(f.states.map(state => state.phase)).toEqual([
      'available', 'downloading', 'downloading', 'verifying', 'ready', 'installing',
    ])
    expect(f.updater).toMatchObject({
      autoDownload: false, autoInstallOnAppQuit: false, channel: 'nightly',
      allowPrerelease: true, allowDowngrade: false,
    })
  })

  it('joins checks and downloads without retargeting a prepared release', async () => {
    const f = fixture()
    const checked = Promise.withResolvers<{ isUpdateAvailable: boolean; updateInfo: { version: string } }>()
    f.checkForUpdates.mockImplementation(() => checked.promise)
    const checking = f.coordinator.check()
    const manual = f.coordinator.check(true)
    const firstDownload = f.coordinator.download('1.1.0-rc.2')
    const secondDownload = f.coordinator.download('1.1.0-rc.2')
    checked.resolve({ isUpdateAvailable: true, updateInfo: { version: '1.1.0-rc.2' } })
    await Promise.all([checking, manual, firstDownload, secondDownload])
    expect(f.checkForUpdates).toHaveBeenCalledOnce()
    expect(f.downloadUpdate).toHaveBeenCalledOnce()
    await f.coordinator.check(true)
    expect(f.checkForUpdates).toHaveBeenCalledOnce()
    await expect(f.coordinator.install('1.2.0')).rejects.toThrow(/not ready/u)
  })

  it('keeps automatic failures silent and exposes a manual caller joining the same check', async () => {
    const f = fixture()
    f.checkForUpdates.mockRejectedValue(new Error('offline'))
    expect(await f.coordinator.check()).toMatchObject({ phase: 'error', failedOperation: 'check' })
    expect(f.states).toEqual([])
    await Promise.all([f.coordinator.check(), f.coordinator.check(true)])
    expect(f.states).toEqual([expect.objectContaining({ phase: 'error', failedOperation: 'check' })])
    expect(f.downloadUpdate).not.toHaveBeenCalled()
  })

  it.each(['1.0.0', '1.1.0-alpha.1', 'invalid'])('does not download or install inapplicable version %s', async (version) => {
    const f = fixture()
    f.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true, updateInfo: { version } })
    await f.coordinator.check()
    await expect(f.coordinator.download('1.1.0-rc.2')).rejects.toThrow(/no checked update/u)
    expect(f.downloadUpdate).not.toHaveBeenCalled()
  })

  it('retains retry state after download failure and never equates 100 percent with readiness', async () => {
    const f = fixture()
    f.downloadUpdate.mockImplementationOnce(async () => {
      f.events.emit('download-progress', { percent: 100 })
      throw new Error('signature rejected')
    })
    await f.coordinator.check()
    expect(await f.coordinator.download('1.1.0-rc.2')).toMatchObject({ phase: 'error', failedOperation: 'download' })
    await expect(f.coordinator.install('1.1.0-rc.2')).rejects.toThrow(/not ready/u)
    await f.coordinator.download('1.1.0-rc.2')
    expect(f.coordinator.state.phase).toBe('ready')
    expect(f.quitAndInstall).not.toHaveBeenCalled()
  })

  it('refuses handoff after failed task preparation while retaining the prepared package', async () => {
    const f = fixture()
    f.beforeRestart.mockRejectedValueOnce(new Error('tasks could not stop'))
    await f.coordinator.check()
    await f.coordinator.download('1.1.0-rc.2')
    expect(await f.coordinator.install('1.1.0-rc.2')).toMatchObject({ phase: 'error', failedOperation: 'install' })
    expect(f.quitAndInstall).not.toHaveBeenCalled()
    await f.coordinator.install('1.1.0-rc.2')
    expect(f.downloadUpdate).toHaveBeenCalledOnce()
    expect(f.quitAndInstall).toHaveBeenCalledOnce()
  })

  it('does not publish late check completion after disposal', async () => {
    const f = fixture()
    const checked = Promise.withResolvers<{ isUpdateAvailable: boolean; updateInfo: { version: string } }>()
    f.checkForUpdates.mockImplementation(() => checked.promise)
    const pending = f.coordinator.check()
    f.coordinator.dispose()
    checked.resolve({ isUpdateAvailable: true, updateInfo: { version: '1.1.0-rc.2' } })
    await pending
    expect(f.states).toEqual([])
    expect(f.events.listenerCount('download-progress')).toBe(0)
  })
})


it('reports one download result when callers share an operation and none for cached readiness', async () => {
  const f = fixture()
  await f.coordinator.check()
  await Promise.all([f.coordinator.download('1.1.0-rc.2'), f.coordinator.download('1.1.0-rc.2')])
  await f.coordinator.download('1.1.0-rc.2')
  expect(f.downloadResult).toHaveBeenCalledExactlyOnceWith(true)
})


it.each([new DesktopUpdatePreparationError('stop-failed', 'private diagnostic'), new Error('private URL')])('reports safe download failure classification: %s', async (error) => {
  const f = fixture()
  await f.coordinator.check()
  f.downloadUpdate.mockRejectedValueOnce(error)
  await f.coordinator.download('1.1.0-rc.2')
  expect(f.downloadResult).toHaveBeenCalledExactlyOnceWith(false, error instanceof DesktopUpdatePreparationError ? 'stop-failed' : 'download_failed')
  expect(JSON.stringify(f.downloadResult.mock.calls)).not.toContain('private')
})


it('keeps a stable-version nightly installation on nightly and rejects prereleases on stable', async () => {
  const nightly = fixture('nightly', '1.0.0')
  expect(nightly.updater.channel).toBe('nightly')
  expect(nightly.updater.allowPrerelease).toBe(true)
  expect((await nightly.coordinator.check()).phase).toBe('available')
  expect(nightly.updater.channel).toBe('nightly')
  const stable = fixture('stable', '1.0.0')
  expect(stable.updater.channel).toBe('stable')
  expect(stable.updater.allowPrerelease).toBe(false)
  expect(stable.updater.allowDowngrade).toBe(false)
  expect((await stable.coordinator.check()).phase).toBe('error')
  expect(stable.downloadUpdate).not.toHaveBeenCalled()
})


it('retires a downloaded target and rejects its old confirmation after switching', async () => {
  const f = fixture()
  await f.coordinator.check()
  const revision = f.coordinator.revision
  await f.coordinator.download('1.1.0-rc.2')
  const save = vi.fn(async () => {})
  f.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: { version: '1.2.0' } })
  await f.coordinator.switchChannel('stable', save)
  expect(save).toHaveBeenCalledOnce()
  expect(f.coordinator.selectedChannel).toBe('stable')
  expect(f.updater.allowDowngrade).toBe(false)
  expect(f.coordinator.state).toMatchObject({ phase: 'available', version: '1.2.0' })
  await f.coordinator.install('1.1.0-rc.2', revision)
  expect(f.quitAndInstall).not.toHaveBeenCalled()
})

it('leaves the current target intact if saving the choice fails', async () => {
  const f = fixture()
  await f.coordinator.check()
  await f.coordinator.download('1.1.0-rc.2')
  await expect(f.coordinator.switchChannel('stable', () => Promise.reject(new Error('read only')))).rejects.toThrow('read only')
  expect(f.coordinator.selectedChannel).toBe('nightly')
  expect(f.coordinator.state.phase).toBe('ready')
  await f.coordinator.install('1.1.0-rc.2')
  expect(f.quitAndInstall).toHaveBeenCalledOnce()
})

it('discards a check result that belongs to the previous channel', async () => {
  const f = fixture()
  const started = Promise.withResolvers<undefined>()
  const checked = Promise.withResolvers<{ isUpdateAvailable: boolean; updateInfo: { version: string } }>()
  f.checkForUpdates.mockImplementationOnce(() => { started.resolve(undefined); return checked.promise })
  const checking = f.coordinator.check()
  await started.promise
  const saved = Promise.withResolvers<undefined>()
  const switching = f.coordinator.switchChannel('stable', async () => { saved.resolve(undefined) })
  await saved.promise
  f.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: { version: '1.2.0' } })
  checked.resolve({ isUpdateAvailable: true, updateInfo: { version: '9.0.0-alpha.1' } })
  await Promise.all([checking, switching])
  expect(f.states.some(state => state.version === '9.0.0-alpha.1')).toBe(false)
  expect(f.coordinator.state).toMatchObject({ phase: 'available', version: '1.2.0' })
})

it('does not check or install while startup channel configuration is invalid', async () => {
  const f = fixture()
  f.coordinator.suspendConfiguration('/settings.json')
  expect(f.coordinator.configurationFailure).toBe('startup')
  await f.coordinator.check(true)
  await f.coordinator.download('1.1.0-rc.2')
  expect(f.checkForUpdates).not.toHaveBeenCalled()
  expect(f.downloadUpdate).not.toHaveBeenCalled()
  expect(f.coordinator.state).toMatchObject({ phase: 'error', failedOperation: 'configuration' })
  await f.coordinator.switchChannel('nightly', async () => {})
  expect(f.coordinator.state.phase).toBe('available')
  expect(f.coordinator.configurationFailure).toBeUndefined()
})


it('waits for a cancelled download before checking the new channel and ignores late progress', async () => {
  const f = fixture()
  const entered = Promise.withResolvers<undefined>()
  const finished = Promise.withResolvers<string[]>()
  f.downloadUpdate.mockImplementationOnce(async () => { entered.resolve(undefined); return finished.promise })
  await f.coordinator.check()
  const downloading = f.coordinator.download('1.1.0-rc.2')
  await entered.promise
  const persisted = Promise.withResolvers<undefined>()
  const switching = f.coordinator.switchChannel('stable', async () => { persisted.resolve(undefined) })
  await persisted.promise
  await Promise.resolve()
  const count = f.states.length
  f.events.emit('download-progress', { percent: 99 })
  f.events.emit('update-downloaded', { version: '1.1.0-rc.2' })
  expect(f.states).toHaveLength(count)
  expect(f.checkForUpdates).toHaveBeenCalledTimes(1)
  f.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: { version: '1.2.0' } })
  finished.resolve([])
  await Promise.all([downloading, switching])
  expect(f.coordinator.state).toEqual({ phase: 'available', version: '1.2.0' })
  expect(f.downloadResult).not.toHaveBeenCalled()
  expect(f.updater.allowDowngrade).toBe(false)
})

it('rejects a channel switch during installation preparation without persisting it', async () => {
  const f = fixture()
  await f.coordinator.check()
  await f.coordinator.download('1.1.0-rc.2')
  const preparation = Promise.withResolvers<boolean>()
  f.beforeRestart.mockReturnValueOnce(preparation.promise)
  const installing = f.coordinator.install('1.1.0-rc.2')
  const save = vi.fn(async () => {})
  await expect(f.coordinator.switchChannel('stable', save)).rejects.toThrow('installation is in progress')
  expect(save).not.toHaveBeenCalled()
  preparation.resolve(false)
  await installing
  expect(f.coordinator.state.phase).toBe('ready')
})


it('does not accept a channel switch after installer handoff even if a later error is reported', async () => {
  const f = fixture()
  await f.coordinator.check()
  await f.coordinator.download('1.1.0-rc.2')
  await f.coordinator.install('1.1.0-rc.2')
  f.events.emit('error', new Error('native updater failed after handoff'))
  expect(f.coordinator.state.phase).toBe('error')
  const save = vi.fn(async () => {})
  await expect(f.coordinator.switchChannel('stable', save)).rejects.toThrow('installation is in progress')
  expect(save).not.toHaveBeenCalled()
})

it('suspends updates if retiring a downloaded target fails and recovers on a later switch', async () => {
  const discard = vi.fn().mockRejectedValueOnce(new Error('native target busy')).mockResolvedValueOnce(undefined)
  const f = fixture('nightly', '1.1.0-alpha.1', discard)
  await f.coordinator.check()
  await f.coordinator.download('1.1.0-rc.2')
  await expect(f.coordinator.switchChannel('stable', async () => {})).rejects.toThrow('native target busy')
  expect(f.coordinator.configurationFailure).toBe('cleanup')
  expect(f.coordinator.state).toMatchObject({ phase: 'error', failedOperation: 'configuration' })
  const checks = f.checkForUpdates.mock.calls.length
  await f.coordinator.check(true)
  await expect(f.coordinator.install('1.1.0-rc.2')).rejects.toThrow('channel selection is not ready')
  expect(f.checkForUpdates).toHaveBeenCalledTimes(checks)
  expect(f.quitAndInstall).not.toHaveBeenCalled()
  await f.coordinator.switchChannel('stable', async () => {})
  expect(f.coordinator.configurationFailure).toBeUndefined()
})


it.each(['idle', 'downloading', 'ready'] as const)('preserves %s when the current channel is selected again', async (phase) => {
  const f = fixture()
  const save = vi.fn(async () => {})
  const pending = Promise.withResolvers<string[]>()
  const started = Promise.withResolvers<undefined>()
  let downloading: Promise<DesktopUpdateState> | undefined
  if (phase !== 'idle') {
    await f.coordinator.check()
    if (phase === 'downloading') f.downloadUpdate.mockImplementationOnce(() => { started.resolve(undefined); return pending.promise })
    downloading = f.coordinator.download('1.1.0-rc.2')
    if (phase === 'ready') await downloading
    else await started.promise
  }
  const before = f.coordinator.state
  const revision = f.coordinator.revision
  const checks = f.checkForUpdates.mock.calls.length
  try {
    expect(await f.coordinator.switchChannel('nightly', save)).toBe('unchanged')
    expect(save).not.toHaveBeenCalled()
    expect(f.coordinator.state).toBe(before)
    expect(f.coordinator.revision).toBe(revision)
    expect(f.checkForUpdates).toHaveBeenCalledTimes(checks)
  } finally {
    pending.resolve(['verified-package'])
    await downloading
  }
})

it.each([
  ['ENOSPC', 'space'], ['EACCES', 'permission'], ['EPERM', 'permission'], ['EROFS', 'permission'], ['EBUSY', 'busy'],
] as const)('reports the current %s download failure without attributing it to cleanup', async (code, kind) => {
  const f = fixture()
  await f.coordinator.check()
  f.downloadUpdate.mockRejectedValueOnce(Object.assign(new Error('write failed'), {
    code, path: '/cache/new.zip', dest: '/cache/pending/new.zip',
  }))
  const state = await f.coordinator.download('1.1.0-rc.2')
  expect(state).toMatchObject({ phase: 'error', failedOperation: 'download', downloadFailure: kind,
    technicalDetails: `${code}\nwrite failed\n/cache/new.zip\n/cache/pending/new.zip` })
  await expect(f.coordinator.install('1.1.0-rc.2')).rejects.toThrow('not ready')
  expect((await f.coordinator.download('1.1.0-rc.2')).phase).toBe('ready')
  expect(f.coordinator.state.downloadFailure).toBeUndefined()
})

it('does not diagnose a filesystem cause from error wording alone', async () => {
  const f = fixture()
  await f.coordinator.check()
  f.downloadUpdate.mockRejectedValueOnce(new Error('ENOSPC or EACCES in a remote response'))
  expect((await f.coordinator.download('1.1.0-rc.2')).downloadFailure).toBeUndefined()
})
