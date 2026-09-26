/** Desktop media permissions exclude external pages, subframes and camera requests. */
import type { Session, WebContents } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { installMicrophonePermissions } from '../src/microphone-permissions.ts'

const access = vi.hoisted(() => ({ getMediaAccessStatus: vi.fn(() => 'granted'), askForMediaAccess: vi.fn(async () => true) }))
vi.mock('electron', () => ({ systemPreferences: access }))
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks() })
function fixture(platform: NodeJS.Platform = 'darwin') {
  vi.stubGlobal('process', { ...process, platform })
  const setPermissionCheckHandler = vi.fn<Session['setPermissionCheckHandler']>()
  const setPermissionRequestHandler = vi.fn<Session['setPermissionRequestHandler']>()
  const primary = {} as WebContents
  installMicrophonePermissions({ setPermissionCheckHandler, setPermissionRequestHandler }, () => primary)
  return { primary, check: setPermissionCheckHandler.mock.calls[0]![0]!, request: setPermissionRequestHandler.mock.calls[0]![0]! }
}
it('allows only audio checks from the owned primary application frame', () => {
  const f = fixture(), details = { isMainFrame: true, mediaType: 'audio' as const }
  expect(f.check(f.primary, 'media', 'dsh-app://app', details)).toBe(true)
  expect(f.check(null, 'media', 'dsh-app://app', details)).toBe(false)
  expect(f.check({} as WebContents, 'media', 'dsh-app://app', details)).toBe(false)
  expect(f.check(f.primary, 'media', 'https://example.com', details)).toBe(false)
  expect(f.check(f.primary, 'media', 'invalid', details)).toBe(false)
  expect(f.check(f.primary, 'media', 'dsh-app://app', { ...details, isMainFrame: false })).toBe(false)
  expect(f.check(f.primary, 'media', 'dsh-app://app', { ...details, mediaType: 'video' })).toBe(false)
  expect(f.check(f.primary, 'clipboard-sanitized-write', 'dsh-app://app', details)).toBe(true)
})
it.each(['not-determined', 'granted', 'denied', 'restricted', 'unknown'] as const)(
  'reports existing macOS microphone authorization for %s', (status) => {
    const f = fixture()
    access.getMediaAccessStatus.mockReturnValueOnce(status)
    expect(f.check(f.primary, 'media', 'dsh-app://app', { isMainFrame: true, mediaType: 'audio' })).toBe(status === 'granted')
    expect(access.getMediaAccessStatus).toHaveBeenCalledExactlyOnceWith('microphone')
    expect(access.askForMediaAccess).not.toHaveBeenCalled()
  },
)
it.each([true, false])('waits for the first macOS authorization decision: %s', async (allowed) => {
  const f = fixture(), decision = Promise.withResolvers<boolean>(), done = vi.fn()
  access.getMediaAccessStatus.mockReturnValue('not-determined')
  access.askForMediaAccess.mockReturnValueOnce(decision.promise)
  try {
    f.request(f.primary, 'media', done, { isMainFrame: true, requestingUrl: 'dsh-app://app/', mediaTypes: ['audio'] })
    expect(access.askForMediaAccess).toHaveBeenCalledExactlyOnceWith('microphone')
    expect(done).not.toHaveBeenCalled()
  } finally { decision.resolve(allowed); await decision.promise }
  expect(done).toHaveBeenCalledExactlyOnceWith(allowed)
})
it('requests macOS microphone access and reports operating-system rejection', async () => {
  const f = fixture(), done = vi.fn(), details = { isMainFrame: true, requestingUrl: 'dsh-app://app/', mediaTypes: ['audio'] }
  f.request(f.primary, 'media', done, details)
  await vi.waitFor(() => { expect(done).toHaveBeenLastCalledWith(true) })
  expect(access.askForMediaAccess).toHaveBeenCalledWith('microphone')
  access.askForMediaAccess.mockRejectedValueOnce(new Error('permission denied'))
  f.request(f.primary, 'media', done, details)
  await vi.waitFor(() => { expect(done).toHaveBeenLastCalledWith(false) })
  for (const denied of [{ ...details, mediaTypes: ['audio', 'video'] }, { ...details, mediaTypes: [] },
    { ...details, isMainFrame: false }, { isMainFrame: true, requestingUrl: 'dsh-app://app/' }]) {
    f.request(f.primary, 'media', done, denied); expect(done).toHaveBeenLastCalledWith(false)
  }
  f.request(f.primary, 'clipboard-sanitized-write', done, details)
  expect(done).toHaveBeenLastCalledWith(true)
})
it.each(['win32', 'linux'] as const)('leaves system authorization to Chromium on %s', (platform) => {
  const f = fixture(platform), done = vi.fn()
  expect(f.check(f.primary, 'media', 'dsh-app://app', { isMainFrame: true, mediaType: 'audio' })).toBe(true)
  f.request(f.primary, 'media', done, { isMainFrame: true, requestingUrl: 'dsh-app://app/', mediaTypes: ['audio'] })
  expect(done).toHaveBeenCalledWith(true)
  expect(access.askForMediaAccess).not.toHaveBeenCalled()
})
