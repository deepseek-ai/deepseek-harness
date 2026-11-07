/** Windows publishes its executable and dependencies directly into the package payload. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { buildNativeExecutable, nativeExecutablePath, nativeHostArchitecture, prepareNativeExecutable } from '../src/native-build.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cua-windows-build-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'packages/experimental/cua-windows')
  await mkdir(packageRoot, { recursive: true })
  const bytes = Buffer.from('MZ Windows executable fixture')
  const files = new Map([
    ['dsh-cua-windows.dll', 'managed code'],
    ['dsh-cua-windows.runtimeconfig.json', '{"runtimeOptions":{}}'],
    ['dsh-cua-windows.deps.json', '{}'],
    ['resources/zh-CN/messages.dll', 'localized resources'],
  ])
  const spawn = vi.fn((request: SubprocessSpawnSpec): SubprocessHandle => ({
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined, collected: {},
    done: (async () => {
      const output = request.argv[request.argv.indexOf('--output') + 1]!
      await mkdir(output, { recursive: true })
      await writeFile(join(output, 'dsh-cua-windows.exe'), bytes, { mode: 0o755 })
      for (const [name, content] of files) {
        await mkdir(dirname(join(output, name)), { recursive: true })
        await writeFile(join(output, name), content)
      }
      return { exitCode: 0, signal: null }
    })(),
    terminate: vi.fn(), waitForExit: async () => true,
  }))
  const spec = { packageRoot, architecture: 'x64' as const, dotnetPath: 'fixture-dotnet', subprocess: { spawn },
    signal: new AbortController().signal, timeoutMs: 60_000, graceMs: 1000 }
  return { root, spec, spawn, bytes, files }
}

it.each(['x64', 'arm64'])('accepts the Windows %s process target', (architecture) => {
  expect(nativeHostArchitecture('win32', architecture)).toBe(architecture)
})
it.each([['darwin', 'arm64'], ['linux', 'x64'], ['win32', 'ia32']])('rejects unsupported %s/%s runtime targets', (platform, architecture) => {
  expect(() => nativeHostArchitecture(platform, architecture)).toThrow('requires Windows')
})

it('publishes all dependencies and nested resources without single-file bundling', async () => {
  const f = await fixture()
  const output = await buildNativeExecutable(f.spec)
  const packaged = nativeExecutablePath(f.spec.packageRoot, 'x64')
  expect(output).toBe(packaged)
  expect(await readFile(output)).toEqual(f.bytes)
  for (const [name, content] of f.files)
    expect(await readFile(join(dirname(output), name), 'utf8')).toBe(content)
  const argv = f.spawn.mock.calls[0]![0].argv
  expect(argv.slice(0, 3)).toEqual(['fixture-dotnet', 'publish', join(f.spec.packageRoot, 'native', 'entry', 'CuaWindows.csproj')])
  expect(argv).toEqual(expect.arrayContaining([
    '--runtime', 'win-x64', '--self-contained', 'true', '-p:EnableWindowsTargeting=true',
  ]))
  expect(argv.some(arg => arg.includes('PublishSingleFile') || arg.includes('IncludeNativeLibrariesForSelfExtract'))).toBe(false)
  expect(argv[argv.indexOf('--output') + 1]).toBe(dirname(packaged))
  expect(await buildNativeExecutable(f.spec)).toBe(output)
})

it('publishes dependency updates at the same package path', async () => {
  const f = await fixture()
  const first = await buildNativeExecutable(f.spec)
  f.files.set('dsh-cua-windows.dll', 'updated managed code')
  expect(await buildNativeExecutable(f.spec)).toBe(first)
  expect(await readFile(join(dirname(first), 'dsh-cua-windows.dll'), 'utf8')).toBe('updated managed code')
})

it('rejects canceled preparation without starting the compiler', async () => {
  const f = await fixture()
  const controller = new AbortController()
  controller.abort(new Error('provider unloaded'))
  await expect(buildNativeExecutable({ ...f.spec, signal: controller.signal })).rejects.toThrow('provider unloaded')
  expect(f.spawn).not.toHaveBeenCalled()
})

it('compiles a recognized source package and resolves an installed payload without a compiler', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root' }))
  expect(await prepareNativeExecutable(f.spec)).toBe(nativeExecutablePath(f.spec.packageRoot, 'x64'))
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
