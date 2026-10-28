/** Managed application preparation and installed receipt validation. */
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { buildNativeExecutable, isSourcePackage, nativeExecutablePath, nativeHostArchitecture, prepareNativeExecutable } from '../src/native-build.ts'

async function publish(directory: string, bytes: Buffer): Promise<string> {
  const bundle = createHash('sha256').update(bytes).digest('hex')
  const executable = join(directory, bundle, 'DSH Computer Use.app', 'Contents/MacOS/dsh-cua-native')
  await mkdir(dirname(executable), { recursive: true })
  await writeFile(executable, bytes, { mode: 0o755 })
  await writeFile(join(directory, 'current.json'), JSON.stringify({ bundle }))
  return executable
}

async function fixture(diagnostics = true) {
  const root = await mkdtemp(join(tmpdir(), 'cua-native-build-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'packages/experimental/cua-macos')
  await mkdir(join(packageRoot, 'native'), { recursive: true })
  const controller = new AbortController()
  let output: Buffer = Buffer.from('signed application executable')
  let outcome: SubprocessOutcome = { exitCode: 0, signal: null }
  let beforeExit = async () => {}
  const terminate = vi.fn()
  const waitForExit = vi.fn(async () => true)
  const spawn = vi.fn((request: SubprocessSpawnSpec): SubprocessHandle => ({
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
    collected: diagnostics ? {
      stdout: { readFrom: () => ({ text: 'build output', nextOffset: 12, lossy: false }) },
      stderr: { readFrom: () => ({ text: 'compiler diagnostic', nextOffset: 19, lossy: false }) },
    } : {},
    done: (async () => {
      await beforeExit()
      if (outcome.exitCode === 0 && !request.signal?.aborted) {
        await publish(request.argv[request.argv.indexOf('--output-directory') + 1]!, output)
      }
      return outcome
    })(), terminate, waitForExit,
  }))
  const spec = { packageRoot, architecture: 'arm64' as const, subprocess: { spawn }, signal: controller.signal, timeoutMs: 60_000, graceMs: 100 }
  const directory = join(packageRoot, 'native/.build/prepared/arm64')
  return { root, spec, directory, spawn, output, controller, terminate, waitForExit,
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

it.each([['darwin', 'arm64'], ['darwin', 'x64']])('selects the %s/%s application', (platform, architecture) => {
  expect(nativeHostArchitecture(platform, architecture)).toBe(architecture)
})
it.each([['linux', 'arm64'], ['win32', 'x64'], ['darwin', 'ia32']])('refuses unsupported %s/%s hosts', (platform, architecture) => {
  expect(() => nativeHostArchitecture(platform, architecture)).toThrow('requires macOS')
})

it('returns a bundled executable only after the managed builder exits', async () => {
  const f = await fixture()
  const path = await buildNativeExecutable(f.spec)
  expect(await readFile(path)).toEqual(f.output)
  expect(path).toContain(join('DSH Computer Use.app', 'Contents', 'MacOS'))
  expect(f.spawn.mock.calls[0]![0].argv).toEqual([
    '/usr/bin/xcrun', 'python3', join(f.spec.packageRoot, 'native/build_app.py'),
    '--scratch-path', join(f.spec.packageRoot, 'native/.build/runtime-arm64'),
    '--output-directory', f.directory, '--arch', 'arm64',
  ])
  expect(f.terminate).toHaveBeenCalledTimes(1)
  expect(f.waitForExit).toHaveBeenCalledTimes(1)
})

it('checks source builds on activation and maps Intel architecture to the compiler target', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'package.json'), '{"name":"@deepseek-ai/dsh-root"}')
  const path = await prepareNativeExecutable({ ...f.spec, architecture: 'x64' })
  expect(f.spawn.mock.calls[0]![0].argv).toContain('x86_64')
  expect(path).toContain(join('native', '.build', 'prepared', 'x64'))
})

it('uses an installed application without compiling or re-signing it', async () => {
  const f = await fixture()
  const path = await publish(join(f.spec.packageRoot, 'native/bin/darwin-arm64'), f.output)
  expect(await prepareNativeExecutable(f.spec)).toBe(path)
  expect(f.spawn).not.toHaveBeenCalled()
  f.controller.abort()
  await expect(prepareNativeExecutable(f.spec)).rejects.toThrow()
})

it.each(['../outside', '/absolute', '', 'a'.repeat(63), 'A'.repeat(64)])('rejects an invalid installed generation %s', async (bundle) => {
  const f = await fixture()
  await mkdir(f.directory, { recursive: true })
  await writeFile(join(f.directory, 'current.json'), JSON.stringify({ bundle }))
  await expect(nativeExecutablePath(f.directory)).rejects.toThrow()
})

it('refuses a missing executable selected by an otherwise valid receipt', async () => {
  const f = await fixture()
  const path = await publish(f.directory, f.output)
  await rm(path)
  await expect(nativeExecutablePath(f.directory)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('preserves the previous generation when preparation fails and reports diagnostics', async () => {
  const f = await fixture()
  const path = await buildNativeExecutable(f.spec)
  f.setOutcome({ exitCode: 1, signal: null })
  await expect(buildNativeExecutable(f.spec)).rejects.toThrow('compiler diagnostic')
  expect(await nativeExecutablePath(f.directory)).toBe(path)
  f.setOutcome({ exitCode: null, signal: 'SIGTERM' })
  await expect(buildNativeExecutable(f.spec)).rejects.toThrow('SIGTERM')
})

it('awaits cleanup and refuses a result after cancellation', async () => {
  const f = await fixture()
  f.beforeExit(async () => { f.controller.abort() })
  await expect(buildNativeExecutable(f.spec)).rejects.toThrow()
  expect(f.waitForExit).toHaveBeenCalledTimes(1)
  await expect(readFile(join(f.directory, 'current.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(buildNativeExecutable(f.spec)).rejects.toThrow()
  expect(f.spawn).toHaveBeenCalledTimes(1)
})

it('reports failed builder range observation before returning an executable', async () => {
  const f = await fixture()
  f.waitForExit.mockRejectedValue(new Error('compiler range observation failed'))
  await expect(buildNativeExecutable(f.spec)).rejects.toThrow('compiler range observation failed')
})

it('rejects a builder whose managed process range remains occupied', async () => {
  const f = await fixture()
  f.waitForExit.mockResolvedValue(false)
  await expect(buildNativeExecutable(f.spec)).rejects.toThrow('did not release its managed process range')
})

it('serializes builds and cancels a competing preparation before starting it', async () => {
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
  try { await rejected; expect(f.spawn).toHaveBeenCalledTimes(1) }
  finally { release.resolve(); await first }
})

it('reports an unsuccessful builder without collected diagnostics', async () => {
  const f = await fixture(false)
  f.setOutcome({ exitCode: 2, signal: null })
  await expect(buildNativeExecutable(f.spec)).rejects.toThrow('preparation failed (2, null)')
})

it('retains an earlier generation when the builder selects a new one', async () => {
  const f = await fixture()
  const first = await buildNativeExecutable(f.spec)
  f.setOutput(Buffer.from('new signed executable'))
  const second = await buildNativeExecutable(f.spec)
  expect(second).not.toBe(first)
  expect(await readFile(first)).toEqual(f.output)
})
