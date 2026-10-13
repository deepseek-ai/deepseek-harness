/** Desktop resource preparation publishes versions only for complete resources. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  root: '',
  target: 'mac-arm64' as 'mac-arm64' | 'mac-x64' | 'win-x64',
  pnpm: '11.7.0' as string | undefined,
  failure: undefined as 'electron' | 'primary' | 'cli' | undefined,
  preparePrimary: vi.fn(),
  commandLink: vi.fn(),
}))
vi.mock('../scripts/desktop-build-paths.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('../scripts/desktop-build-paths.mjs')>(),
  resolveDesktopBuildTarget: () => state.target,
  resolveDesktopTargetBuildPaths: () => ({
    runtime: join(state.root, 'runtime'), electron: join(state.root, 'electron'), downloads: join(state.root, 'downloads'),
  }),
}))
vi.mock('@electron/get', () => ({ downloadArtifact: async () => 'electron.zip' }))
vi.mock('extract-zip', () => ({ default: async () => {
  if (state.failure === 'electron') throw new Error('Electron extraction failed')
} }))
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: (file: string) => file === '/usr/libexec/PlistBuddy' ? '12.0\n' : '24.18.1\n',
}))
vi.mock('../scripts/prepare-command-link.ts', () => ({ prepareCommandLink: state.commandLink }))
// The compiled command manager is a build input; all source resource copies use real files.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, cpSync: (...args: Parameters<typeof actual.cpSync>) => {
    if (String(args[0]).endsWith(join('lib', 'command-manager-entry.js'))) {
      if (state.failure === 'cli') throw new Error('command manager copy failed')
      actual.writeFileSync(args[1], 'command manager fixture')
    } else actual.cpSync(...args)
  } }
})
vi.mock('../scripts/prepare-primary-runtime.ts', () => ({
  preparePrimaryRuntime: state.preparePrimary,
}))

const originalArgv = process.argv
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  state.root = mkdtempSync(join(tmpdir(), 'desktop-runtime-preparation-'))
  state.target = 'mac-arm64'
  state.pnpm = '11.7.0'
  state.failure = undefined
  process.argv = [process.execPath, 'prepare-runtime.ts']
  vi.stubEnv('DSH_DESKTOP_PACKAGING_RUN_DIR', undefined)
  state.preparePrimary.mockImplementation(async () => {
    if (state.failure === 'primary') throw new Error('primary preparation failed')
    const root = join(state.root, 'runtime', 'primary-runtime')
    const pnpm = join(root, 'dependencies', 'pnpm', 'bin')
    mkdirSync(pnpm, { recursive: true })
    writeFileSync(join(pnpm, 'pnpm.mjs'), '')
    writeFileSync(join(root, 'runtime.json'), JSON.stringify({
      desktopVersion: '1.0.0', platform: state.target === 'win-x64' ? 'win32' : 'darwin',
      arch: state.target === 'mac-arm64' ? 'arm64' : 'x64',
      python: '3.12.14', node: '24.17.0', pnpm: state.pnpm, pythonPackages: { numpy: '2.3.5' },
    }))
  })
})

afterEach(async () => {
  process.argv = originalArgv
  vi.unstubAllEnvs()
  await rm(state.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
})

it.each(['mac-arm64', 'mac-x64', 'win-x64'] as const)('prepares %s with one pnpm distribution and its CLI resources', async (target) => {
  state.target = target
  const windows = target === 'win-x64'
  if (windows) process.argv.push('--defer-primary-runtime-smoke')
  const runtime = join(state.root, 'runtime')
  mkdirSync(join(runtime, 'pnpm'), { recursive: true })
  await import('../scripts/prepare-runtime.ts')
  expect(existsSync(join(runtime, 'pnpm'))).toBe(false)
  expect(existsSync(join(runtime, 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'))).toBe(true)
  expect(existsSync(join(runtime, 'bin', 'node'))).toBe(true)
  expect(existsSync(join(runtime, 'cli', 'bin', windows ? 'dsh.cmd' : 'dsh'))).toBe(true)
  expect(readFileSync(join(runtime, 'cli', 'command-manager.js'), 'utf8')).toBe('command manager fixture')
  expect(existsSync(join(runtime, 'cli', 'command-path.ps1'))).toBe(true)
  expect(JSON.parse(readFileSync(join(runtime, 'versions.json'), 'utf8'))).toEqual({
    schemaVersion: 1, node: '24.18.1', pnpm: '11.7.0',
  })
  expect(state.preparePrimary).toHaveBeenCalledWith({ deferSmoke: windows })
  if (windows) expect(state.commandLink).not.toHaveBeenCalled()
  else expect(state.commandLink).toHaveBeenCalledWith(join(runtime, 'cli'), target === 'mac-arm64' ? 'arm64' : 'x64', '12.0')
})

it.each([
  ['electron', 'Electron extraction failed'],
  ['primary', 'primary preparation failed'],
  ['cli', 'command manager copy failed'],
] as const)('does not publish versions when %s preparation fails', async (failure, error) => {
  state.failure = failure
  const runtime = join(state.root, 'runtime')
  mkdirSync(runtime)
  writeFileSync(join(runtime, 'versions.json'), 'stale versions')
  await expect(import('../scripts/prepare-runtime.ts')).rejects.toThrow(error)
  expect(existsSync(join(runtime, 'versions.json'))).toBe(false)
})

it.each([
  ['not-a-version', 'primary runtime: invalid metadata'],
  [undefined, 'primary-runtime manifest has no pnpm version'],
])('rejects pnpm metadata %s even when Windows smoke is deferred', async (pnpm, error) => {
  state.target = 'win-x64'
  process.argv.push('--defer-primary-runtime-smoke')
  state.pnpm = pnpm
  await expect(import('../scripts/prepare-runtime.ts')).rejects.toThrow(error)
  expect(existsSync(join(state.root, 'runtime', 'versions.json'))).toBe(false)
})
