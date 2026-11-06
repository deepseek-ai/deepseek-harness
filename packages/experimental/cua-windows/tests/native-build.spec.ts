/** The Windows compiler publishes one immutable executable and installed packages need no SDK. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { buildNativeExecutable, nativeExecutablePath, nativeHostArchitecture, prepareNativeExecutable } from '../src/native-build.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cua-windows-build-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'packages/experimental/cua-windows')
  await mkdir(packageRoot, { recursive: true })
  const bytes = Buffer.from('MZ Windows executable fixture')
  const spawn = vi.fn((request: SubprocessSpawnSpec): SubprocessHandle => ({
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined, collected: {},
    done: (async () => {
      const output = request.argv[request.argv.indexOf('--output') + 1]!
      await mkdir(output, { recursive: true })
      await writeFile(join(output, 'dsh-cua-windows.exe'), bytes)
      return { exitCode: 0, signal: null }
    })(),
    terminate: vi.fn(), waitForExit: async () => true,
  }))
  const spec = { packageRoot, architecture: 'x64' as const, dotnetPath: 'fixture-dotnet', subprocess: { spawn },
    signal: new AbortController().signal, timeoutMs: 60_000, graceMs: 1000 }
  return { root, spec, spawn, bytes }
}

it.each(['x64', 'arm64'])('accepts the Windows %s process target', (architecture) => {
  expect(nativeHostArchitecture('win32', architecture)).toBe(architecture)
})
it.each([['darwin', 'arm64'], ['linux', 'x64'], ['win32', 'ia32']])('rejects unsupported %s/%s runtime targets', (platform, architecture) => {
  expect(() => nativeHostArchitecture(platform, architecture)).toThrow('requires Windows')
})

it('passes an explicit Windows RID and SDK to the managed compiler and retains the bytes', async () => {
  const f = await fixture()
  const output = await buildNativeExecutable(f.spec)
  expect(await readFile(output)).toEqual(f.bytes)
  expect(await readFile(nativeExecutablePath(f.spec.packageRoot, 'x64'))).toEqual(f.bytes)
  expect(f.spawn.mock.calls[0]![0].argv).toEqual(expect.arrayContaining([
    'fixture-dotnet', '--runtime', 'win-x64', '--self-contained', 'true', '-p:EnableWindowsTargeting=true',
  ]))
  expect(await buildNativeExecutable(f.spec)).toBe(output)
})

it('compiles a recognized source package and resolves an installed payload without a compiler', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root' }))
  expect(await prepareNativeExecutable(f.spec)).toContain('prepared')
  expect(f.spawn).toHaveBeenCalledOnce()
  await rm(join(f.root, 'package.json'))
  expect(await prepareNativeExecutable(f.spec)).toBe(nativeExecutablePath(f.spec.packageRoot, 'x64'))
  expect(f.spawn).toHaveBeenCalledOnce()
  const controller = new AbortController()
  controller.abort()
  await expect(prepareNativeExecutable({ ...f.spec, signal: controller.signal })).rejects.toThrow()
  await rm(nativeExecutablePath(f.spec.packageRoot, 'x64'))
  await expect(prepareNativeExecutable(f.spec)).rejects.toThrow()
})
