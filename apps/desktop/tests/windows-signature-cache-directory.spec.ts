import { execFile } from 'node:child_process'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { prepareWindowsSignatureCacheDirectory, resolveWindowsSignatureCacheDirectory } from '../scripts/windows-signature-cache-directory.mjs'

it.skipIf(process.platform !== 'win32')('resolves an account cache independently of checkout and LocalAppData virtualization', () => {
  expect(resolveWindowsSignatureCacheDirectory({ LOCALAPPDATA: 'C:\\Users\\build\\AppData\\Local' }))
    .toBe(join(homedir(), '.dsh-desktop-signing', 'signature-cache', 'v1'))
})

it('accepts an explicit local cache directory', () => {
  expect(resolveWindowsSignatureCacheDirectory({ DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_DIR: 'D:/private-cache' }))
    .toBe('D:\\private-cache')
})

it.skipIf(process.platform !== 'win32')('prepares storage when the inherited process execution policy is Restricted', async (t) => {
  const root = await mkdtemp(join(import.meta.dirname, 'directory-test-'))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('PSExecutionPolicyPreference', 'Restricted')
  t.onTestFinished(() => { vi.unstubAllEnvs() })
  await prepareWindowsSignatureCacheDirectory(join(root, 'private'))
  expect(process.env.PSExecutionPolicyPreference).toBe('Restricted')
})

it.each(['', 'cache', 'C:cache', '\\cache', '\\\\server\\share', '\\\\?\\C:\\cache', 'C:\\cache:stream'])
('rejects unsupported cache path %j', (path) => {
  expect(() => resolveWindowsSignatureCacheDirectory({ DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_DIR: path })).toThrow(/absolute local/u)
})

it.skipIf(process.platform !== 'win32')('creates private storage and rejects linked or publicly readable cache roots', async (t) => {
  const root = await mkdtemp(join(import.meta.dirname, 'directory-test-'))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const cache = join(root, 'private')
  await prepareWindowsSignatureCacheDirectory(cache)
  await prepareWindowsSignatureCacheDirectory(cache)
  const link = join(root, 'linked')
  await symlink(cache, link, 'junction')
  await expect(prepareWindowsSignatureCacheDirectory(join(link, 'child'))).rejects.toThrow(/reparse/u)
  await promisify(execFile)('icacls.exe', [cache, '/grant', '*S-1-1-0:(OI)(CI)R'], { windowsHide: true })
  await expect(prepareWindowsSignatureCacheDirectory(cache)).rejects.toThrow(/permissions/u)
})
