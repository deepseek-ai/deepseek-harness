// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { DESKTOP_IPC } from '../src/ipc.ts'
import { syncNativeTheme } from '../src/preload-theme.ts'

const send = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ ipcRenderer: { send } }))

/** Observers created by the module under test; jsdom keeps one document per file. */
const observers = new Set<MutationObserver>()
const NativeMutationObserver = MutationObserver

/** Records every observer so teardown detaches it from the shared document. */
class TrackedMutationObserver extends NativeMutationObserver {
  constructor(callback: MutationCallback) {
    super(callback)
    observers.add(this)
  }
}

afterEach(() => {
  for (const observer of observers) observer.disconnect()
  observers.clear()
  document.documentElement.removeAttribute('data-ds-theme-source')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  send.mockClear()
})

it.each(['darwin', 'win32'] as const)('mirrors the application theme source on %s', async (platform) => {
  vi.stubGlobal('MutationObserver', TrackedMutationObserver)
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  document.documentElement.setAttribute('data-ds-theme-source', 'dark')
  syncNativeTheme()
  expect(send).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.nativeThemeSet, 'dark')
  document.documentElement.setAttribute('data-ds-theme-source', 'system')
  await vi.waitFor(() => { expect(send).toHaveBeenLastCalledWith(DESKTOP_IPC.nativeThemeSet, 'system') })
  expect(send).toHaveBeenCalledTimes(2)
})

it('defers observation until the document root exists', () => {
  vi.stubGlobal('MutationObserver', TrackedMutationObserver)
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading')
  syncNativeTheme()
  expect(send).not.toHaveBeenCalled()
  document.documentElement.setAttribute('data-ds-theme-source', 'light')
  window.dispatchEvent(new Event('DOMContentLoaded'))
  expect(send).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.nativeThemeSet, 'light')
})
