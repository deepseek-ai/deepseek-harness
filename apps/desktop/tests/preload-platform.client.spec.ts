// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { DESKTOP_IPC } from '../src/ipc.ts'
import { syncWindowFullscreen } from '../src/preload-platform.ts'

const on = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ ipcRenderer: { on } }))

afterEach(() => {
  delete document.documentElement.dataset.fullscreen
  vi.restoreAllMocks()
  on.mockClear()
})

it.each(['win32', 'linux'] as const)('subscribes no fullscreen channel on %s', (platform) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  syncWindowFullscreen()
  expect(on).not.toHaveBeenCalled()
})

it('mirrors the sent fullscreen state onto html[data-fullscreen] on darwin', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  syncWindowFullscreen()
  expect(on).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.windowFullscreen, expect.any(Function))
  const handler = on.mock.calls[0]?.[1] as (event: unknown, fullscreen: boolean) => void
  handler({}, true)
  expect(document.documentElement.dataset.fullscreen).toBe('true')
  handler({}, false)
  expect(document.documentElement.dataset.fullscreen).toBeUndefined()
  // A repeated windowed report stays a no-op rather than toggling the flag.
  handler({}, false)
  expect(document.documentElement.dataset.fullscreen).toBeUndefined()
})
