/** Source preparation publishes for the selected Windows architecture; installed helpers never compile. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { expect, it, onTestFinished, vi } from 'vitest'
import { nativeExecutablePath, nativeHostArchitecture, prepareNativeExecutable, type NativeArchitecture } from '../src/native-build.ts'

async function fixture(source: boolean, architecture: NativeArchitecture = 'x64', asar = false, exitCode = 0) {
  const root = await mkdtemp(join(tmpdir(), 'cua-native-build-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const packageRoot = source ? join(root, 'packages', 'experimental', 'cua-windows')
    : join(root, ...(asar ? ['app.asar'] : []), 'node_modules', '@deepseek-ai', 'dsh-cua-windows')
  const executable = nativeExecutablePath(packageRoot, architecture)
  const local = join(packageRoot, 'native', 'bin', 'local', 'dsh-cua-windows.exe')
  const otherArchitecture = nativeExecutablePath(packageRoot, architecture === 'x64' ? 'arm64' : 'x64')
  for (const path of [executable, local, otherArchitecture]) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'helper', { mode: 0o755 })
  }
  if (source) await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root' }))
  const handle = {
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined, collected: {},
    done: Promise.resolve({ exitCode, signal: null }), terminate: vi.fn(), waitForExit: vi.fn(async () => true),
  } satisfies SubprocessHandle
  const spawn = vi.fn<SubprocessRuntime['spawn']>(() => handle)
  return { executable, handle, spawn, spec: {
    packageRoot, architecture, subprocess: { spawn },
    timeoutMs: 60_000, graceMs: 100, signal: new AbortController().signal,
  } }
}

it.each(['x64', 'arm64'])('accepts the Windows %s runtime', (architecture) => {
  expect(nativeHostArchitecture('win32', architecture)).toBe(architecture)
})
it.each([['darwin', 'arm64'], ['linux', 'x64'], ['win32', 'ia32']])('rejects unsupported %s/%s runtimes', (platform, architecture) => {
  expect(() => nativeHostArchitecture(platform, architecture)).toThrow('requires Windows')
})

it.each(['x64', 'arm64'] as const)('publishes source output for %s even when that output exists', async (architecture) => {
  const f = await fixture(true, architecture)
  expect(await prepareNativeExecutable(f.spec)).toBe(f.executable)
  const nativeRoot = join(f.spec.packageRoot, 'native')
  expect(f.spawn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    argv: ['dotnet', 'publish', join(nativeRoot, 'entry', 'CuaWindows.csproj'),
      '--configuration', 'Release', '--runtime', `win-${architecture}`, '--self-contained', 'true',
      '--output', join(nativeRoot, 'bin', `win-${architecture}`), '-p:EnableWindowsTargeting=true'],
    cwd: f.spec.packageRoot, graceMs: f.spec.graceMs,
  }))
  expect(f.handle.terminate).toHaveBeenCalledOnce()
  expect(f.handle.waitForExit).toHaveBeenCalledOnce()
})

it('rejects missing published output without falling back to local or another architecture', async () => {
  const f = await fixture(true)
  await rm(f.executable)
  await expect(prepareNativeExecutable(f.spec)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.spawn).toHaveBeenCalledOnce()
})

it('rejects build failure even when previous output exists', async () => {
  const f = await fixture(true, 'x64', false, 1)
  await expect(prepareNativeExecutable(f.spec)).rejects.toThrow('native preparation failed')
  expect(f.handle.waitForExit).toHaveBeenCalledOnce()
})

it.each(['x64', 'arm64'] as const)('uses the placeholder installed-package path for %s', async (architecture) => {
  const f = await fixture(false, architecture)
  expect(await prepareNativeExecutable(f.spec)).toBe(f.executable)
  expect(f.spawn).not.toHaveBeenCalled()
  await rm(f.executable)
  await expect(prepareNativeExecutable(f.spec)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.spawn).not.toHaveBeenCalled()
})

it('uses the unpacked Electron payload for the placeholder installed layout', async () => {
  const f = await fixture(false, 'x64', true)
  expect(await prepareNativeExecutable(f.spec)).toBe(f.executable)
  expect(f.spawn).not.toHaveBeenCalled()
  expect(f.executable).toContain('app.asar.unpacked')
})

it('rejects canceled helper preparation before compilation', async () => {
  const f = await fixture(true)
  const controller = new AbortController()
  controller.abort(new Error('provider unloaded'))
  await expect(prepareNativeExecutable({ ...f.spec, signal: controller.signal })).rejects.toThrow('provider unloaded')
  expect(f.spawn).not.toHaveBeenCalled()
})
