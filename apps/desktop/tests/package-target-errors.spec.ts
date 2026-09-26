import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ root: '', directory: '' }))
vi.mock('../scripts/desktop-package-environment.mjs', () => ({
  loadDesktopPackageEnvironment: () => ({ DSH_DESKTOP_WINDOWS_TOKEN_PIN: 'credential-sentinel' }),
  validateDesktopPackageEnvironment: () => {},
}))
vi.mock('../scripts/macos-signing-keychain.mjs', () => ({
  withMacOSSigningKeychain: async (_environment: object, action: (environment: object) => Promise<unknown>) => action({}),
}))
// This test fakes the host platform, so the real probes would report the absent Windows compilers rather than the failure under test.
vi.mock('../scripts/desktop-toolchain-preflight.ts', () => ({ requireDesktopToolchain: async () => {} }))
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  rmSync: () => { throw new AggregateError([new Error('credential-sentinel')], 'restore:mac-proxy recovery required') },
}))
vi.mock('../scripts/packaging-run.mjs', async (importOriginal) => {
  const original = await importOriginal<typeof import('../scripts/packaging-run.mjs')>()
  return { ...original, createPackagingRun: (...args: Parameters<typeof original.createPackagingRun>) => {
    const run = original.createPackagingRun(state.root, args[1], args[2])
    state.directory = run.directory
    return run
  } }
})

it.each(['win32', 'darwin'] as const)('records and prints redacted parent failures on %s', async (platform) => {
  state.root = await mkdtemp(join(tmpdir(), 'package-errors-'))
  const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const savedArch = Object.getOwnPropertyDescriptor(process, 'arch')!
  const savedArgv = process.argv
  const savedExit = process.exitCode
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
  const savedDirectory = process.env.DSH_DESKTOP_PACKAGING_RUN_DIR
  try {
    Object.defineProperty(process, 'platform', { ...savedPlatform, value: platform })
    Object.defineProperty(process, 'arch', { ...savedArch, value: 'x64' })
    process.argv = [process.execPath, fileURLToPath(new URL('../scripts/package-target.ts', import.meta.url)), platform === 'win32' ? 'win-x64' : 'mac-x64']
    vi.resetModules()
    await import('../scripts/package-target.ts')
    expect(process.exitCode).toBe(1)
    const events = await readFile(join(state.directory, 'events.jsonl'), 'utf8')
    const output = stderr.mock.calls.map(([text]) => String(text)).join('')
    for (const diagnostic of [events, output]) {
      expect(diagnostic).toContain('restore:mac-proxy recovery required')
      expect(diagnostic).toContain('[REDACTED]')
      expect(diagnostic).not.toContain('credential-sentinel')
    }
    expect(JSON.parse(await readFile(join(state.directory, 'result.json'), 'utf8'))).toMatchObject({
      success: false, stages: [
        { stage: 'configuration', success: true },
        { stage: 'toolchain', success: true },
        { stage: platform === 'win32' ? 'windows-package' : 'macos-package', success: false },
      ],
    })
    expect(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR).toBe(savedDirectory)
  } finally {
    Object.defineProperty(process, 'platform', savedPlatform)
    Object.defineProperty(process, 'arch', savedArch)
    process.argv = savedArgv
    process.exitCode = savedExit
    if (savedDirectory === undefined) delete process.env.DSH_DESKTOP_PACKAGING_RUN_DIR
    else process.env.DSH_DESKTOP_PACKAGING_RUN_DIR = savedDirectory
    stderr.mockRestore()
    consoleLog.mockRestore()
    await rm(state.root, { recursive: true, force: true })
  }
})
