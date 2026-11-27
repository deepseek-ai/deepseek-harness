import { spawn } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareDevelopmentApp } from '../scripts/development-app.ts'

const state = vi.hoisted(() => ({ nativeStatus: 0 }))

vi.mock('node:child_process', async (importOriginal) => {
  const { EventEmitter } = await import('node:events')
  return {
    ...await importOriginal<typeof import('node:child_process')>(),
    execFileSync: vi.fn(() => '24.17.0'),
    spawn: vi.fn((_command: string, args: readonly string[]) => {
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('exit', args.includes('build:native') ? state.nativeStatus : 0, null))
      return child
    }),
  }
})
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  existsSync: vi.fn(() => true),
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(() => JSON.stringify({ version: '1.0.0' })),
}))
vi.mock('node:module', () => ({ createRequire: () => () => 'fixture-electron' }))
vi.mock('../scripts/development-app.ts', () => ({ prepareDevelopmentApp: vi.fn(() => 'fixture-macos-launcher') }))
vi.mock('../scripts/development-project.ts', () => ({ prepareDevelopmentProject: vi.fn() }))
vi.mock('../scripts/prepare-primary-runtime.ts', () => ({ preparePrimaryRuntime: vi.fn(async () => {}) }))
vi.mock('../scripts/native-package-builds.mjs', () => ({
  buildNativePackage: vi.fn(), nativeBuildEnvironment: vi.fn(), nativePackageBuildAt: vi.fn(),
}))

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); state.nativeStatus = 0 })

async function develop(platform: 'darwin' | 'win32', skipBuild = false) {
  const host = process
  const argv = host.argv
  // Node's parseArgs reads the native process object, not the stubbed global.
  host.argv = ['node', 'dev.ts', ...(skipBuild ? ['--skip-build'] : [])]
  vi.stubGlobal('process', {
    ...host, platform, arch: 'x64', exitCode: undefined,
    env: { ...process.env, npm_execpath: 'fixture-pnpm.cjs' },
  })
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    vi.resetModules()
    await import('../scripts/dev.ts')
    expect(error).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
    return { calls: vi.mocked(spawn).mock.calls, warnings: [...warning.mock.calls] }
  } finally {
    vi.unstubAllGlobals()
    host.argv = argv
    log.mockRestore(); warning.mockRestore(); error.mockRestore()
  }
}

it.each(['darwin', 'win32'] as const)('builds the native addons before launching the %s development runtime', async (platform) => {
  const { calls } = await develop(platform)
  expect(calls.slice(0, -1).map(call => call[1])).toEqual([
    ['fixture-pnpm.cjs', 'run', 'build:artifacts'],
    ['fixture-pnpm.cjs', 'run', 'build'],
    ['fixture-pnpm.cjs', 'run', 'build:native'],
  ])
  expect(calls.at(-1)![0]).toBe(platform === 'darwin' ? 'fixture-macos-launcher' : 'fixture-electron')
  expect(prepareDevelopmentApp).toHaveBeenCalledTimes(platform === 'darwin' ? 1 : 0)
})

it.each(['darwin', 'win32'] as const)('keeps --skip-build from compiling native addons on %s', async (platform) => {
  const { calls } = await develop(platform, true)
  expect(calls).toHaveLength(1)
  expect(calls[0]![0]).toBe(platform === 'darwin' ? 'fixture-macos-launcher' : 'fixture-electron')
})

it.each(['darwin', 'win32'] as const)('reports a native build failure and still launches development on %s', async (platform) => {
  state.nativeStatus = 1
  const { calls, warnings } = await develop(platform)
  expect(warnings).toHaveLength(1)
  expect(warnings[0]![0]).toContain('build:native exited with 1')
  expect(calls.at(-1)![0]).toBe(platform === 'darwin' ? 'fixture-macos-launcher' : 'fixture-electron')
})
