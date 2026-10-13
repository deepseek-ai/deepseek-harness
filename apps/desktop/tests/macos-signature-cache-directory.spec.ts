import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveMacOSSignatureCacheDirectory, validateMacOSSignatureCacheDirectory } from '../scripts/macos-signature-cache-directory.mjs'
import { cachedMacOSSignature } from '../scripts/macos-signature-cache.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mac-cache-directory-')))
  roots.push(root)
  return root
}

it('retains target-local storage only when the setting is absent', () => {
  expect(resolveMacOSSignatureCacheDirectory({}, '/build/mac-arm64')).toBe(join('/build/mac-arm64', 'signature-cache'))
  for (const path of ['', 'relative/cache', '~/ci/cache', '/cache\0invalid']) {
    expect(() => resolveMacOSSignatureCacheDirectory({ DSH_DESKTOP_MACOS_SIGNATURE_CACHE_DIR: path }, '/build')).toThrow(/absolute directory/u)
  }
})

// Machine storage requires POSIX ownership and permissions, which Windows cannot represent.
describe.skipIf(process.platform === 'win32')('private external macOS storage', () => {
  it('rejects missing, non-directory, linked and non-private storage without repairing it', () => {
    const root = fixture()
    expect(() => validateMacOSSignatureCacheDirectory(join(root, 'absent'))).toThrow(/ENOENT/u)
    const file = join(root, 'file')
    writeFileSync(file, '')
    expect(() => validateMacOSSignatureCacheDirectory(file)).toThrow(/unlinked directory/u)
    const cache = join(root, 'cache')
    mkdirSync(cache, { mode: 0o700 })
    const link = join(root, 'link')
    symlinkSync(root, link)
    expect(() => validateMacOSSignatureCacheDirectory(join(link, 'cache'))).toThrow(/unlinked directory/u)
    for (const mode of [0o755, 0o500]) {
      chmodSync(cache, mode)
      expect(() => validateMacOSSignatureCacheDirectory(cache)).toThrow(/private, accessible/u)
    }
    chmodSync(cache, 0o700)
    expect(validateMacOSSignatureCacheDirectory(cache)).toBe(cache)
  })

  it('restores a verified signature after removing and recreating the checkout', async () => {
    const root = fixture()
    const cache = join(root, 'machine-cache')
    mkdirSync(cache, { mode: 0o700 })
    const checkout = join(root, 'checkout')
    const sign = vi.fn(async (path: string) => { writeFileSync(path, 'signed bytes') })
    const verify = vi.fn((path: string) => { expect(readFileSync(path, 'utf8')).toBe('signed bytes') })
    for (const hit of [false, true]) {
      mkdirSync(checkout)
      const file = join(checkout, 'runtime')
      writeFileSync(file, 'unsigned bytes', { mode: 0o755 })
      const selected = resolveMacOSSignatureCacheDirectory({ DSH_DESKTOP_MACOS_SIGNATURE_CACHE_DIR: cache }, checkout)
      expect(await cachedMacOSSignature(file, selected, { policy: 'same certificate and tools', sign, verify })).toBe(hit)
      expect(readFileSync(file, 'utf8')).toBe('signed bytes')
      rmSync(checkout, { recursive: true })
    }
    expect(sign).toHaveBeenCalledTimes(1)
    expect(verify).toHaveBeenCalledTimes(2)
  })
})
