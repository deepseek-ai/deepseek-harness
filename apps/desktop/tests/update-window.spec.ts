import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareDesktopUpdateWindow } from '../src/update-window.ts'
import { en } from '../src/locale.ts'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function setup(platform = 'darwin', fullscreen = true, destroyed = false) {
  vi.stubGlobal('process', { ...process, platform })
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed,
    isFullScreen: () => fullscreen,
    setFullScreen: vi.fn(),
  })
  return { window, prepare: () => prepareDesktopUpdateWindow(window, en.updateFullscreenTimeout) }
}

it.each(['darwin', 'win32', 'linux'])('does not transition an ordinary %s window', async (platform) => {
  const f = setup(platform, false)
  await expect(f.prepare()).resolves.toBe(true)
  expect(f.window.setFullScreen).not.toHaveBeenCalled()
})

it('preserves Windows fullscreen', async () => {
  const windows = setup('win32')
  await expect(windows.prepare()).resolves.toBe(true)
  expect(windows.window.setFullScreen).not.toHaveBeenCalled()
})

it('refuses a destroyed product window', async () => {
  const destroyed = setup('darwin', true, true)
  await expect(destroyed.prepare()).resolves.toBe(false)
  expect(destroyed.window.setFullScreen).not.toHaveBeenCalled()
})

it.each(['leave-full-screen', 'closed'])('settles on %s and releases both listeners and the deadline', async (event) => {
  vi.useFakeTimers()
  const f = setup()
  const preparing = f.prepare()
  expect(f.window.setFullScreen).toHaveBeenCalledWith(false)
  f.window.emit(event)
  await expect(preparing).resolves.toBe(event === 'leave-full-screen')
  expect(f.window.eventNames()).toEqual([])
  expect(vi.getTimerCount()).toBe(0)
})

it('rejects a stalled native transition and allows a later attempt to complete', async () => {
  vi.useFakeTimers()
  const f = setup()
  const failure = expect(f.prepare()).rejects.toMatchObject({ kind: 'fullscreen-timeout', message: en.updateFullscreenTimeout })
  await vi.advanceTimersByTimeAsync(5000)
  await failure
  expect(f.window.eventNames()).toEqual([])
  expect(vi.getTimerCount()).toBe(0)
  const retry = f.prepare()
  f.window.emit('leave-full-screen')
  await expect(retry).resolves.toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('releases native listeners when requesting the transition throws', async () => {
  vi.useFakeTimers()
  const f = setup()
  const nativeError = new Error('native window unavailable')
  f.window.setFullScreen.mockImplementation(() => { throw nativeError })
  await expect(f.prepare()).rejects.toBe(nativeError)
  expect(f.window.eventNames()).toEqual([])
  expect(vi.getTimerCount()).toBe(0)
})
