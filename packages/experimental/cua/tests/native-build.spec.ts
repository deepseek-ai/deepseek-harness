/** Standalone helper generations remain immutable across rebuilds and publication failures. */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { expect, it, onTestFinished, vi } from 'vitest'
import { buildNativeExecutable, type NativeExecutableBuild } from '../src/native-build.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cua-build-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const handle: SubprocessHandle = {
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined, collected: {},
    done: Promise.resolve({ exitCode: 0, signal: null }), terminate: vi.fn(), waitForExit: async () => true,
  }
  const spec: NativeExecutableBuild = {
    packageRoot: root, subprocess: { spawn: () => handle }, signal: new AbortController().signal,
    timeoutMs: 60_000, graceMs: 100, argv: ['fixture-compiler'],
    outputPath: join(root, 'compiled'), executablePath: join(root, 'bin', 'helper.exe'),
    retainedDirectory: join(root, 'generations'), binaryName: 'helper.exe', lockPath: join(root, 'locks', 'compiler'),
  }
  await writeFile(spec.outputPath, 'first build')
  return spec
}

it('reuses an identical helper and retains the old generation when publishing different bytes', async () => {
  const spec = await fixture()
  const first = await buildNativeExecutable(spec)
  expect(await buildNativeExecutable(spec)).toBe(first)
  await writeFile(spec.outputPath, 'second build')
  const second = await buildNativeExecutable(spec)
  expect(second).not.toBe(first)
  expect(await readFile(first, 'utf8')).toBe('first build')
  expect(await readFile(second, 'utf8')).toBe('second build')
  expect(await readFile(spec.executablePath, 'utf8')).toBe('second build')
})

it('refuses to overwrite a retained generation containing other bytes', async () => {
  const spec = await fixture()
  const first = await buildNativeExecutable(spec)
  await writeFile(first, 'corrupted')
  await expect(buildNativeExecutable(spec)).rejects.toThrow('does not match its content digest')
  expect(await readFile(first, 'utf8')).toBe('corrupted')
})

it.each(['published', 'retained'] as const)('preserves an unreadable %s location', async (role) => {
  const spec = await fixture()
  const retained = await buildNativeExecutable(spec)
  const path = role === 'published' ? spec.executablePath : retained
  await rm(path)
  await mkdir(path)
  await expect(buildNativeExecutable(spec)).rejects.toMatchObject({ code: 'EISDIR' })
  expect((await stat(path)).isDirectory()).toBe(true)
})
