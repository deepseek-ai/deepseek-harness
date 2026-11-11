/** Native compilation resolves the platform executable only after successful process cleanup. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { expect, it, onTestFinished, vi } from 'vitest'
import { buildNativeExecutable } from '../src/native-build.ts'

async function fixture(exitCode = 0, exited = true) {
  const root = await mkdtemp(join(tmpdir(), 'cua-build-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const handle = {
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined, collected: {},
    done: Promise.resolve({ exitCode, signal: null }), terminate: vi.fn(), waitForExit: vi.fn(async () => exited),
  } satisfies SubprocessHandle
  const executable = join(root, 'bin', 'helper.exe')
  const resolveExecutable = vi.fn(async () => {
    expect(handle.waitForExit).toHaveBeenCalledOnce()
    return executable
  })
  const spec = {
    packageRoot: root, subprocess: { spawn: () => handle }, signal: new AbortController().signal,
    timeoutMs: 60_000, graceMs: 100, argv: ['fixture-compiler'],
    lockPath: join(root, 'locks', 'compiler'), resolveExecutable,
  }
  return { spec, handle, executable, resolveExecutable }
}

it('returns the platform executable after the compiler exits', async () => {
  const f = await fixture()
  expect(await buildNativeExecutable(f.spec)).toBe(f.executable)
  expect(f.handle.terminate).toHaveBeenCalledOnce()
  expect(f.resolveExecutable).toHaveBeenCalledOnce()
})

it.each([{ exitCode: 1, exited: true }, { exitCode: 0, exited: false }])('does not resolve output after compiler failure or incomplete cleanup ($exitCode, $exited)', async ({ exitCode, exited }) => {
  const f = await fixture(exitCode, exited)
  await expect(buildNativeExecutable(f.spec)).rejects.toThrow()
  expect(f.handle.terminate).toHaveBeenCalledOnce()
  expect(f.handle.waitForExit).toHaveBeenCalledOnce()
  expect(f.resolveExecutable).not.toHaveBeenCalled()
})
