/** Preparation uses the existing compiler cache and publishes only successful build output. */
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { buildNativeExecutable, isSourcePackage, nativeExecutablePath, nativeHostArchitecture, prepareNativeExecutable } from '../src/native-build.ts'

async function fixture(diagnostics = true) {
  const root = await mkdtemp(join(tmpdir(), 'cua-native-build-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'packages/experimental/cua-macos')
  await mkdir(packageRoot, { recursive: true })
  const controller = new AbortController()
  let output: Buffer = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 255, 128])
  let outcome: SubprocessOutcome = { exitCode: 0, signal: null }
  let beforeExit = async () => {}
  const terminate = vi.fn()
  const waitForExit = vi.fn(async () => true)
  const spawn = vi.fn((request: SubprocessSpawnSpec): SubprocessHandle => {
    const scratch = request.argv[request.argv.indexOf('--scratch-path') + 1]!
    return {
      stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
      collected: diagnostics ? {
        stdout: { readFrom: () => ({ text: 'build output', nextOffset: 12, lossy: false }) },
        stderr: { readFrom: () => ({ text: 'compiler diagnostic', nextOffset: 19, lossy: false }) },
      } : {},
      done: (async () => {
        await beforeExit()
        if (outcome.exitCode === 0) {
          await mkdir(join(scratch, 'release'), { recursive: true })
          await writeFile(join(scratch, 'release/dsh-cua-native'), output)
        }
        return outcome
      })(), terminate, waitForExit,
    }
  })
  const spec = { packageRoot, architecture: 'arm64' as const, subprocess: { spawn }, signal: controller.signal, timeoutMs: 60_000, graceMs: 100 }
  return { root, spec, spawn, output, controller, terminate, waitForExit,
    setOutput: (value: Buffer) => { output = value },
    setOutcome: (value: SubprocessOutcome) => { outcome = value },
    beforeExit: (callback: () => Promise<void>) => { beforeExit = callback },
  }
}

it('recognizes only the repository-owned package location as a source build', async () => {
  const f = await fixture()
  expect(await isSourcePackage(f.spec.packageRoot)).toBe(false)
  for (const value of [null, 2, {}, { name: 'another-project' }, { name: '@deepseek-ai/dsh-root' }]) {
    await writeFile(join(f.root, 'package.json'), JSON.stringify(value))
    expect(await isSourcePackage(f.spec.packageRoot)).toBe(typeof value === 'object' && value !== null && 'name' in value && value.name === '@deepseek-ai/dsh-root')
  }
  expect(await isSourcePackage(join(f.root, 'node_modules/@deepseek-ai/dsh-cua'))).toBe(false)
  await writeFile(join(f.root, 'package.json'), '{')
  await expect(isSourcePackage(f.spec.packageRoot)).rejects.toThrow()
})

it.each([['darwin', 'arm64'], ['darwin', 'x64']])('selects the %s/%s executable', (platform, architecture) => {
  expect(nativeHostArchitecture(platform, architecture)).toBe(architecture)
})
it.each([['linux', 'arm64'], ['win32', 'x64'], ['darwin', 'ia32']])('refuses unsupported %s/%s hosts', (platform, architecture) => {
  expect(() => nativeHostArchitecture(platform, architecture)).toThrow('requires macOS')
})

it('publishes exact bytes and leaves an unchanged executable inode intact', async () => {
  const f = await fixture()
  const path = await buildNativeExecutable(f.spec)
  const first = await stat(path)
  expect(await readFile(path)).toEqual(f.output)
  await buildNativeExecutable(f.spec)
  expect((await stat(path)).ino).toBe(first.ino)
  expect(f.spawn).toHaveBeenCalledTimes(2)
  expect(f.spawn.mock.calls[0]![0].argv).toContain('arm64')
  expect(f.terminate).toHaveBeenCalledTimes(2)
  expect(f.waitForExit).toHaveBeenCalledTimes(2)
})

it('checks source builds on activation and maps Intel architecture to the compiler target', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'package.json'), '{"name":"@deepseek-ai/dsh-root"}')
  const path = await prepareNativeExecutable({ ...f.spec, architecture: 'x64' })
  expect(f.spawn.mock.calls[0]![0].argv).toContain('x86_64')
  expect(path).toContain(join('native', '.build', 'prepared', 'x64'))
  expect(await readFile(nativeExecutablePath(f.spec.packageRoot, 'x64'))).toEqual(f.output)
})

it('uses an installed executable without starting a compiler', async () => {
  const f = await fixture()
  const path = nativeExecutablePath(f.spec.packageRoot, 'arm64')
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, f.output, { mode: 0o755 })
  expect(await prepareNativeExecutable(f.spec)).toBe(path)
  expect(f.spawn).not.toHaveBeenCalled()
})

it('keeps the previous executable when a build fails and reports compiler output', async () => {
  const f = await fixture()
  const path = await buildNativeExecutable(f.spec)
  f.setOutcome({ exitCode: 1, signal: null })
  await expect(buildNativeExecutable(f.spec)).rejects.toThrow('compiler diagnostic')
  expect(await readFile(path)).toEqual(f.output)
  f.setOutcome({ exitCode: null, signal: 'SIGTERM' })
  await expect(buildNativeExecutable(f.spec)).rejects.toThrow('SIGTERM')
})

it('awaits compiler cleanup and refuses to publish after cancellation', async () => {
  const f = await fixture()
  f.beforeExit(async () => { f.controller.abort() })
  await expect(buildNativeExecutable(f.spec)).rejects.toThrow()
  expect(f.waitForExit).toHaveBeenCalledTimes(1)
  await expect(readFile(nativeExecutablePath(f.spec.packageRoot, 'arm64'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(buildNativeExecutable(f.spec)).rejects.toThrow()
  expect(f.spawn).toHaveBeenCalledTimes(1)
})

it('reports failed compiler range observation before publishing', async () => {
  const f = await fixture()
  f.waitForExit.mockRejectedValue(new Error('compiler range observation failed'))
  await expect(buildNativeExecutable(f.spec)).rejects.toThrow('compiler range observation failed')
  await expect(readFile(nativeExecutablePath(f.spec.packageRoot, 'arm64'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('serializes publication and cancels a competing preparation without starting another compiler', async () => {
  const f = await fixture()
  const release: PromiseWithResolvers<void> = Promise.withResolvers()
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  onTestFinished(() => { release.resolve() })
  f.beforeExit(async () => { entered.resolve(); await release.promise })
  const first = buildNativeExecutable(f.spec)
  await entered.promise
  const competing = new AbortController()
  const second = buildNativeExecutable({ ...f.spec, signal: competing.signal })
  const rejected = expect(second).rejects.toThrow()
  competing.abort()
  try {
    await rejected
    expect(f.spawn).toHaveBeenCalledTimes(1)
  } finally { release.resolve(); await first }
  expect(await readFile(nativeExecutablePath(f.spec.packageRoot, 'arm64'))).toEqual(f.output)
})

it('reports an unsuccessful compiler even when no collected diagnostics are available', async () => {
  const f = await fixture(false)
  f.setOutcome({ exitCode: 2, signal: null })
  await expect(buildNativeExecutable(f.spec)).rejects.toThrow('preparation failed (2, null)')
})

it('preserves an invalid existing artifact location instead of treating every read error as a missing file', async () => {
  const f = await fixture()
  const target = nativeExecutablePath(f.spec.packageRoot, 'arm64')
  await mkdir(target, { recursive: true })
  await expect(buildNativeExecutable(f.spec)).rejects.toMatchObject({ code: 'EISDIR' })
  expect((await stat(target)).isDirectory()).toBe(true)
})

it('keeps running generations immutable while publishing a newer package payload', async () => {
  const f = await fixture()
  const first = await buildNativeExecutable(f.spec)
  const firstInode = (await stat(first)).ino
  const replacement = Buffer.from('new executable')
  f.setOutput(replacement)
  const second = await buildNativeExecutable(f.spec)
  expect(second).not.toBe(first)
  expect(await readFile(first)).toEqual(f.output)
  expect((await stat(first)).ino).toBe(firstInode)
  expect(await readFile(second)).toEqual(replacement)
  expect(await readFile(nativeExecutablePath(f.spec.packageRoot, 'arm64'))).toEqual(replacement)
})

it('refuses a corrupted retained generation without replacing it', async () => {
  const f = await fixture()
  const path = await buildNativeExecutable(f.spec)
  await writeFile(path, 'corrupted')
  await expect(buildNativeExecutable(f.spec)).rejects.toThrow('does not match its content digest')
  expect(await readFile(path, 'utf8')).toBe('corrupted')
  await rm(path)
  await mkdir(path)
  await expect(buildNativeExecutable(f.spec)).rejects.toMatchObject({ code: 'EISDIR' })
})
