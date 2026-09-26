import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdater } from 'electron-updater'
import type { DesktopUpdateState } from '../src/ipc.ts'
import { DesktopUpdateSchedule, resolveDesktopUpdateScheduleConfig } from '../src/update-schedule.ts'

vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: {} } }))
const { DesktopUpdateCoordinator } = await import('../src/update-coordinator.ts')

const cleanup: (() => void)[] = []
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function fixture(jitter = 0, random = () => 0.5) {
  const checkForUpdates = vi.fn(async () => ({ isUpdateAvailable: false, updateInfo: { version: '1.0.0' } }))
  const events = new EventEmitter()
  const downloadUpdate = vi.fn(async () => {
    events.emit('update-downloaded', { version: '1.1.0-nightly.1' })
    return ['verified']
  })
  const updater = Object.assign(events, { checkForUpdates, downloadUpdate, quitAndInstall: vi.fn() }) as unknown as AppUpdater
  const states: DesktopUpdateState[] = []
  const coordinator = new DesktopUpdateCoordinator((state) => { states.push(state); return state }, async () => true,
    updater, () => true, () => '1.0.0')
  const schedule = new DesktopUpdateSchedule(coordinator, { intervalMs: 10_000, maxBackoffMs: 40_000, jitter }, random)
  cleanup.push(() => { schedule.dispose(); coordinator.dispose() })
  return { schedule, coordinator, states, checkForUpdates, downloadUpdate }
}

describe('ordinary update polling', () => {
  it('checks immediately, doubles failed delays up to the cap, and resets after success', async () => {
    const f = fixture()
    f.checkForUpdates.mockRejectedValue(new Error('offline'))
    await f.schedule.check()
    expect(f.checkForUpdates).toHaveBeenCalledTimes(1)
    for (const [delay, calls] of [[20_000, 2], [40_000, 3], [40_000, 4]] as const) {
      await vi.advanceTimersByTimeAsync(delay - 1)
      await f.schedule.check()
      expect(f.checkForUpdates).toHaveBeenCalledTimes(calls - 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(f.checkForUpdates).toHaveBeenCalledTimes(calls)
    }
    expect(f.states).toEqual([])
    f.checkForUpdates.mockResolvedValue({ isUpdateAvailable: false, updateInfo: { version: '1.0.0' } })
    await f.schedule.check(true)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(f.checkForUpdates).toHaveBeenCalledTimes(5)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.checkForUpdates).toHaveBeenCalledTimes(6)
    expect(f.downloadUpdate).not.toHaveBeenCalled()
  })

  it.each([[0, 8_000, 32_000], [0.5, 10_000, 36_000], [0.9999, 12_000, 39_999]])(
    'samples jitter %s without exceeding the final backoff cap', async (sample, healthyDelay, cappedDelay) => {
      const f = fixture(0.2, () => sample)
      await f.schedule.check()
      await vi.advanceTimersByTimeAsync(healthyDelay - 1)
      expect(f.checkForUpdates).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(f.checkForUpdates).toHaveBeenCalledTimes(2)
      f.checkForUpdates.mockRejectedValue(new Error('offline'))
      await f.schedule.check(true)
      await f.schedule.check(true)
      await vi.advanceTimersByTimeAsync(cappedDelay - 1)
      expect(f.checkForUpdates).toHaveBeenCalledTimes(4)
      await vi.advanceTimersByTimeAsync(1)
      expect(f.checkForUpdates).toHaveBeenCalledTimes(5)
    },
  )

  it('starts the delay at completion and joins a manual caller without hiding its failure', async () => {
    const f = fixture()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof f.checkForUpdates>>>()
    f.checkForUpdates.mockImplementationOnce(() => pending.promise)
    const automatic = f.schedule.check()
    const manual = f.schedule.check(true)
    try {
      await vi.advanceTimersByTimeAsync(100_000)
      expect(f.checkForUpdates).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      pending.reject(new Error('offline'))
      await Promise.all([automatic, manual])
    }
    expect(f.states).toEqual([expect.objectContaining({ phase: 'error', failedOperation: 'check' })])
    await vi.advanceTimersByTimeAsync(19_999)
    expect(f.checkForUpdates).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('ignores wall-clock changes and lets policy arrival bypass the automatic deadline silently', async () => {
    const f = fixture()
    await f.schedule.check()
    vi.setSystemTime(Date.now() + 86_400_000)
    await f.schedule.check()
    expect(f.checkForUpdates).toHaveBeenCalledOnce()
    f.checkForUpdates.mockRejectedValue(new Error('offline'))
    await f.schedule.check(false, true)
    expect(f.states).toEqual([{ phase: 'idle' }])
    vi.setSystemTime(Date.now() - 172_800_000)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(f.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('never downloads automatically or retargets a downloaded version during polling', async () => {
    const f = fixture()
    f.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true, updateInfo: { version: '1.1.0-nightly.1' } })
    await f.schedule.check()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.downloadUpdate).not.toHaveBeenCalled()
    await f.coordinator.download('1.1.0-nightly.1')
    await vi.advanceTimersByTimeAsync(50_000)
    await f.schedule.check(true)
    expect(f.checkForUpdates).toHaveBeenCalledTimes(2)
    expect(f.downloadUpdate).toHaveBeenCalledOnce()
    expect(f.coordinator.state).toEqual({ phase: 'ready', version: '1.1.0-nightly.1' })
  })

  it('retains a failed download for user retry without automatic transfers', async () => {
    const f = fixture()
    f.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true, updateInfo: { version: '1.1.0-nightly.1' } })
    await f.schedule.check()
    f.downloadUpdate.mockRejectedValue(new Error('disk full'))
    await f.coordinator.download('1.1.0-nightly.1')
    await vi.advanceTimersByTimeAsync(50_000)
    expect(f.checkForUpdates).toHaveBeenCalledOnce()
    expect(f.downloadUpdate).toHaveBeenCalledOnce()
    expect(f.coordinator.state).toMatchObject({ phase: 'error', failedOperation: 'download' })
  })

  it('clears its timer and does not rearm after a pending check settles during disposal', async () => {
    const f = fixture()
    await f.schedule.check()
    expect(vi.getTimerCount()).toBe(1)
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof f.checkForUpdates>>>()
    const started = Promise.withResolvers<undefined>()
    f.checkForUpdates.mockImplementationOnce(() => { started.resolve(undefined); return pending.promise })
    const checking = f.schedule.check(true)
    try {
      await started.promise
      f.schedule.dispose()
      f.coordinator.dispose()
      await expect(f.schedule.check(true)).rejects.toThrow('disposed')
    } finally {
      pending.resolve({ isUpdateAvailable: false, updateInfo: { version: '1.0.0' } })
      await checking
    }
    expect(vi.getTimerCount()).toBe(0)
    expect(f.states).toEqual([{ phase: 'idle' }])
    await vi.advanceTimersByTimeAsync(100_000)
    expect(f.checkForUpdates).toHaveBeenCalledTimes(2)
  })
})

describe('ordinary update polling disposal', () => {
  it('does not start queued network work after disposal', async () => {
    const f = fixture()
    const pending = f.schedule.check()
    f.schedule.dispose()
    await expect(pending).rejects.toThrow('disposed')
    expect(f.checkForUpdates).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('ordinary update polling configuration', () => {
  it('resolves defaults and supports an explicit interval longer than the default backoff cap', () => {
    expect(resolveDesktopUpdateScheduleConfig({})).toEqual({ intervalMs: 600_000, maxBackoffMs: 3_600_000, jitter: 0.2 })
    expect(resolveDesktopUpdateScheduleConfig({ DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS: '7200000' }))
      .toEqual({ intervalMs: 7_200_000, maxBackoffMs: 7_200_000, jitter: 0.2 })
  })

  it.each([
    ['INTERVAL_MS', '0'], ['INTERVAL_MS', '1.5'], ['INTERVAL_MS', '2147483648'], ['INTERVAL_MS', ''],
    ['MAX_BACKOFF_MS', '1000'], ['MAX_BACKOFF_MS', 'Infinity'],
    ['JITTER', '-0.1'], ['JITTER', '1.1'], ['JITTER', 'NaN'],
  ])('rejects invalid %s=%s at configuration load', (suffix, value) => {
    expect(() => resolveDesktopUpdateScheduleConfig({ [`DSH_DESKTOP_UPDATE_CHECK_${suffix}`]: value })).toThrow()
  })
})
