/** Provider preparation must finish before installation and join cancellation on unload. */
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { WslPreparation } from '../src/windows-host.ts'
import type { NativeBuildSpec } from '../src/native-build.ts'
import type { installCua } from '@deepseek-ai/dsh-cua'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { apply, Config } from '../src/index.ts'
import { GUIDANCE } from '../src/guidance.ts'

const native = vi.hoisted(() => ({
  prepare: vi.fn<(spec: NativeBuildSpec) => Promise<string>>(),
  host: vi.fn<() => 'windows' | 'wsl'>(() => 'windows'),
  wsl: vi.fn<(spec: WslPreparation) => Promise<{ architecture: 'arm64'; cacheDirectory: string }>>(),
  retain: vi.fn<(path: string, cache: string, signal: AbortSignal) => Promise<string>>(),
  architecture: vi.fn(() => 'x64' as const),
  install: vi.fn<typeof installCua>(), connect: vi.fn(), dispose: vi.fn(), construct: vi.fn(),
}))
vi.mock('../src/windows-host.ts', () => ({ windowsHost: native.host, prepareWsl: native.wsl, retainWslHelper: native.retain }))
vi.mock('../src/native-build.ts', async original => ({
  ...await original<typeof import('../src/native-build.ts')>(),
  prepareNativeExecutable: native.prepare, nativeHostArchitecture: native.architecture,
}))
vi.mock('@deepseek-ai/dsh-cua', async original => ({
  ...await original<typeof import('@deepseek-ai/dsh-cua')>(), installCua: native.install,
}))
vi.mock('../src/native-runtime.ts', () => ({ WindowsNativeRuntime: class {
  constructor(...args: unknown[]) { native.construct(...args) }
  connect = native.connect
  dispose = native.dispose
} }))
beforeEach(() => { vi.clearAllMocks(); native.host.mockReturnValue('windows'); native.prepare.mockResolvedValue(resolve('prepared-helper')); native.dispose.mockResolvedValue(undefined) })
function owner() { const ctx = new Context(); onTestFinished(() => ctx.fiber.dispose()); return ctx }

it('rejects relative overrides before installing a native provider', async () => {
  await expect(apply(owner(), Config({ helperPath: 'relative.exe' }))).rejects.toThrow('must be absolute')
  expect(native.install).not.toHaveBeenCalled()
})
it('uses an absolute fixture without compiling and disposes the Host runtime', async () => {
  const ctx = owner(), config = Config({ helperPath: resolve('fixture.exe'), pollIntervalMs: 13 })
  await apply(ctx, config)
  expect(native.prepare).not.toHaveBeenCalled()
  expect(native.construct).toHaveBeenCalledWith(ctx, 13, 1000, 'pipe')
  const backend = native.install.mock.calls[0]![2]
  expect(backend.helperPath).toBe(config.helperPath)
  expect(native.architecture).not.toHaveBeenCalled()
  expect(backend.getGuidance('raw')).toBe(GUIDANCE)
  expect(backend.getGuidance('standalone')).toBe(GUIDANCE)
  expect(backend.permissionParameters('requestPermission', 'accessibility', 'en')).toEqual({ permission: 'accessibility' })
  expect(backend.capabilities).toMatchObject({ platform: 'windows', appLevelAccessibility: false, keyboard: ['window'] })
  expect(backend.capabilities.methods).toContain('sendKeyEvent')
  expect(backend.sendKeyEvent).toBeUndefined()
  const channel = { marker: 'native stream' }
  native.connect.mockReturnValue(channel)
  const options = { ...config, helperPath: backend.helperPath, cwd: process.cwd() }
  expect(backend.createChannel(ctx, options)).toBe(channel)
  expect(native.connect).toHaveBeenCalledWith(options)
  await ctx.fiber.dispose()
  expect(native.dispose).toHaveBeenCalledOnce()
})
it('prepares before installation and aborts the completed preparation scope on unload', async () => {
  const ctx = owner(), prepared = Promise.withResolvers<string>()
  native.prepare.mockReturnValueOnce(prepared.promise)
  const config = Config({ buildTimeoutMs: 90_000, graceMs: 250 })
  const pending = apply(ctx, config)
  expect(native.prepare.mock.calls[0]![0]).toMatchObject({
    subprocess: ctx.subprocess, timeoutMs: config.buildTimeoutMs, graceMs: config.graceMs,
  })
  expect(native.install).not.toHaveBeenCalled()
  prepared.resolve(resolve('compiled.exe'))
  await pending
  expect(native.install.mock.calls[0]![2].helperPath).toBe(resolve('compiled.exe'))
  await ctx.fiber.dispose()
  expect(native.prepare.mock.calls[0]![0].signal.aborted).toBe(true)
})
it('reports a missing helper without installing tool registrations', async () => {
  native.prepare.mockRejectedValueOnce(new Error('helper unavailable'))
  const ctx = owner()
  await expect(apply(ctx, Config({}))).rejects.toThrow('helper unavailable')
  await ctx.fiber.dispose()
  expect(native.install).not.toHaveBeenCalled()
})
it('joins canceled preparation and rejects its late success', async () => {
  const ctx = owner(), prepared = Promise.withResolvers<string>()
  onTestFinished(() =>{  prepared.resolve(resolve('late.exe')) })
  native.prepare.mockReturnValueOnce(prepared.promise)
  const starting = apply(ctx, Config({}))
  const rejected = expect(starting).rejects.toThrow()
  const signal = native.prepare.mock.calls[0]![0].signal
  const aborted = new Promise<void>((resolve) =>{  signal.addEventListener('abort', () =>{  resolve() }, { once: true }) })
  let closed = false
  const closing = ctx.fiber.dispose().then(() => { closed = true })
  await aborted
  expect(closed).toBe(false)
  prepared.resolve(resolve('late.exe'))
  await Promise.all([rejected, closing])
  expect(native.install).not.toHaveBeenCalled()
})

it('prepares the Windows architecture and stdio transport for WSL', async () => {
  native.host.mockReturnValue('wsl')
  native.wsl.mockResolvedValue({ architecture: 'arm64', cacheDirectory: '/mnt/c/cache' })
  native.retain.mockResolvedValue('/mnt/c/cache/helper.exe')
  const ctx = owner()
  await apply(ctx, Config({}))
  expect(native.prepare.mock.calls[0]![0].architecture).toBe('arm64')
  expect(native.architecture).not.toHaveBeenCalled()
  expect(native.construct).toHaveBeenCalledWith(ctx, 25, 1000, 'stdio')
  expect(native.install.mock.calls[0]![2].helperPath).toBe('/mnt/c/cache/helper.exe')
})

it('does not compile or register CUA when WSL interoperation fails', async () => {
  native.host.mockReturnValue('wsl')
  native.wsl.mockRejectedValue(new Error('Windows interoperation unavailable'))
  await expect(apply(owner(), Config({}))).rejects.toThrow('interoperation unavailable')
  expect(native.prepare).not.toHaveBeenCalled()
  expect(native.install).not.toHaveBeenCalled()
})
