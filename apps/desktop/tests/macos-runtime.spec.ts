import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { signMacOSRuntime } from '../scripts/macos-runtime.ts'
import { signMacOSRuntimeCode, verifyMacOSRuntimeCode } from '../scripts/verify-macos-signature.mjs'

vi.mock('../scripts/verify-macos-signature.mjs', () => ({ signMacOSRuntimeCode: vi.fn(), verifyMacOSRuntimeCode: vi.fn() }))
const roots: string[] = []
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'desktop-signing-'))
  roots.push(path)
  return path
}
const identity = { signingIdentity: 'Example (TEAMID1234)', teamId: 'TEAMID1234' }
afterEach(() => {
  vi.resetAllMocks()
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})
it('signs Mach-O files in their final locations and verifies each signature', async () => {
  const path = root()
  writeFileSync(join(path, 'addon.node'), Buffer.from('cffaedfe00000000', 'hex'))
  writeFileSync(join(path, 'source.js'), 'export {}')
  await expect(signMacOSRuntime(path, 'com.example.app', identity, 'arm64')).resolves.toBe(1)
  expect(signMacOSRuntimeCode).toHaveBeenCalledWith(join(path, 'addon.node'), expect.stringMatching(/^com\.example\.app\.runtime\.[a-f0-9]{64}$/u), identity, undefined)
  expect(verifyMacOSRuntimeCode).toHaveBeenCalledWith(join(path, 'addon.node'), identity)
})

// File symlinks in these macOS fixtures require privileges unavailable to ordinary Windows processes.
it.skipIf(process.platform === 'win32')('signs a shared Python interpreter once and retains both executable aliases', async () => {
  const path = root()
  const bin = join(path, 'dependencies/python/bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(path, 'runtime.json'), JSON.stringify({ desktopVersion: '1', platform: 'darwin', arch: 'arm64', python: '3.12.14', pythonPackages: {} }))
  writeFileSync(join(bin, 'python3.12'), Buffer.from('cffaedfe00000000', 'hex'))
  for (const name of ['python', 'python3']) symlinkSync('python3.12', join(bin, name))
  await expect(signMacOSRuntime(path, 'com.example.app', identity, 'arm64', undefined, 'primary')).resolves.toBe(1)
  expect(signMacOSRuntimeCode).toHaveBeenCalledExactlyOnceWith(join(bin, 'python3.12'), expect.any(String), identity, undefined)
  for (const name of ['python', 'python3']) expect(readlinkSync(join(bin, name))).toBe('python3.12')
  await expect(signMacOSRuntime(path, 'com.example.app', identity, 'arm64')).rejects.toThrow('unsupported filesystem entry')
})

// The signer must inspect real file symlinks, including dangling and cyclic ones.
it.skipIf(process.platform === 'win32').each(['unknown', 'absolute', 'escaping', 'dangling', 'chained', 'directory'])('rejects a %s runtime link before signing any file', async (kind) => {
  const path = root()
  const bin = join(path, 'dependencies/python/bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(path, 'runtime.json'), JSON.stringify({ desktopVersion: '1', platform: 'darwin', arch: 'arm64', python: '3.12.14', pythonPackages: {} }))
  const canonical = join(bin, 'python3.12')
  if (kind === 'directory') mkdirSync(canonical)
  else if (kind !== 'dangling') writeFileSync(canonical, Buffer.from('cffaedfe00000000', 'hex'))
  if (kind === 'chained') {
    rmSync(canonical)
    symlinkSync('python3', canonical)
  }
  const target = kind === 'absolute' ? canonical : kind === 'escaping' ? '../outside' : 'python3.12'
  symlinkSync(target, join(bin, kind === 'unknown' ? 'unlisted' : 'python3'))
  const result = signMacOSRuntime(path, 'com.example.app', identity, 'arm64', undefined, 'primary')
  if (kind === 'dangling') await expect(result).rejects.toMatchObject({ code: 'ENOENT', path: canonical })
  else await expect(result).rejects.toThrow(kind === 'unknown' ? 'unsupported filesystem entry' : 'invalid Python alias')
  expect(signMacOSRuntimeCode).not.toHaveBeenCalled()
})
it('awaits other signers before rejecting and permitting output cleanup', async () => {
  const path = root()
  for (const name of ['a.node', 'b.node']) writeFileSync(join(path, name), Buffer.from('cffaedfe00000000', 'hex'))
  let release!: () => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  let started!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })
  vi.mocked(signMacOSRuntimeCode).mockImplementation(async (file) => {
    if (file.endsWith('a.node')) throw new Error('sign failure')
    started()
    await barrier
  })
  let completed = false
  const result = signMacOSRuntime(path, 'com.example.app', identity, 'arm64').catch((error: unknown) => { completed = true; return error })
  try {
    await ready
    expect(completed).toBe(false)
  } finally { release() }
  expect(await result).toBeInstanceOf(AggregateError)
  expect(verifyMacOSRuntimeCode).toHaveBeenCalledWith(join(path, 'b.node'), identity)
})

it.each(['arm64', 'x64'] as const)('selects %s Node entitlements and keeps helpers JIT-only', async (arch) => {
  const path = root()
  mkdirSync(join(path, 'dependencies/node/bin'), { recursive: true })
  const node = join(path, 'dependencies/node/bin/node')
  const addon = join(path, 'addon.node')
  const helpers = ['arm64', 'x64'].map(helperArch => join(path, 'node_modules/@deepseek-ai', `libreoffice-kit-darwin-${helperArch}`, 'bin/libreoffice-kit'))
  for (const helper of helpers) mkdirSync(join(helper, '..'), { recursive: true })
  for (const file of [node, addon, ...helpers]) writeFileSync(file, Buffer.from('cffaedfe00000000', 'hex'))
  await signMacOSRuntime(path, 'com.example.app', identity, arch)
  const nodePlist = join(import.meta.dirname, '../scripts', arch === 'x64' ? 'node-x64-entitlements.plist' : 'jit-entitlements.plist')
  expect(signMacOSRuntimeCode).toHaveBeenCalledWith(node, expect.any(String), identity, nodePlist)
  const xml = readFileSync(nodePlist, 'utf8')
  expect(xml).toMatch(/<key>com\.apple\.security\.cs\.allow-jit<\/key>\s*<true\s*\/>/u)
  expect(/<key>com\.apple\.security\.cs\.allow-unsigned-executable-memory<\/key>\s*<true\s*\/>/u.test(xml)).toBe(arch === 'x64')
  for (const file of helpers) {
    expect(signMacOSRuntimeCode).toHaveBeenCalledWith(file, expect.any(String), identity,
      join(import.meta.dirname, '../scripts/jit-entitlements.plist'))
  }
  expect(signMacOSRuntimeCode).toHaveBeenCalledWith(addon, expect.any(String), identity, undefined)
})
