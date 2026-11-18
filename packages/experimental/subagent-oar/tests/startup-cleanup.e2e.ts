/** Native startup rejection releases the Codex process before DSH releases its activation slot. */

import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { codexRuntime } from '@botiverse/oar/runtimes/codex'
import type { Runtime } from '@botiverse/oar'
import { expect, it, vi, type TestContext } from 'vitest'
import { externalTestParent } from '../../../subagent/subagent/tests/external-activation-helpers.ts'
import { startOarRun } from '../src/run.ts'

interface Outcome {
  readonly opened: boolean
  readonly error?: Error
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
    throw error
  }
}

async function fixture(test: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-oar-startup-'))
  const ctx = new Context()
  const pidPath = join(root, 'pid')
  const stopping = join(root, 'stopping')
  const release = join(root, 'release')
  const openings: Promise<Outcome>[] = []
  test.onTestFinished(async () => {
    try {
      await writeFile(release, 'release')
      if (existsSync(pidPath)) {
        const pid = Number(await readFile(pidPath, 'utf8'))
        if (running(pid)) process.kill(pid, 'SIGKILL')
        await expect.poll(() => running(pid)).toBe(false)
      }
      await Promise.all(openings)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
      vi.unstubAllEnvs()
    }
  })
  // The release file, rather than the dependency's escalation timer, controls the assertion.
  vi.stubEnv('OAR_KILL_GRACE_MS', '30000')
  const command = join(root, 'codex')
  const native = fileURLToPath(new URL('./fixtures/codex-startup.mjs', import.meta.url))
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  await writeFile(command, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(native)} "$@"\n`)
  await chmod(command, 0o700)
  const runtime: Runtime = {
    ...codexRuntime,
    installation: async () => ({ kind: 'available', via: 'executable', command }),
  }
  const parent = await externalTestParent(ctx, root)
  const start = (failure: 'initialize' | 'thread' | 'missing-thread-id', hold: boolean) => {
    let outcome: Outcome | undefined
    const promise = startOarRun({
      parent, cwd: root, signal: test.signal, prompt: [{ type: 'text', text: 'fixture task' }],
    }, {
      runtime, timeoutMs: 10_000, launchArgs: [],
      env: {
        CODEX_HOME: root,
        OAR_FIXTURE_PID: pidPath,
        OAR_FIXTURE_FAILURE: failure,
        ...hold ? { OAR_FIXTURE_STOPPING: stopping, OAR_FIXTURE_RELEASE: release } : {},
      },
    }).then(async (run): Promise<Outcome> => {
      await run.dispose()
      return { opened: true }
    }, (error: unknown): Outcome => ({ opened: false, error: error instanceof Error ? error : new Error(String(error)) }))
      .then((value) => { outcome = value; return value })
    openings.push(promise)
    return { promise, outcome: () => outcome }
  }
  return { start, pidPath, stopping, release }
}

// The shell launcher and SIGTERM barrier are POSIX-specific.
it.skipIf(process.platform === 'win32').for(['thread', 'missing-thread-id', 'warm-initialize'] as const)(
  'awaits native process exit after %s rejection',
  { retry: 0 },
  async (failure, test) => {
    const subject = await fixture(test)
    if (failure === 'warm-initialize') {
      await expect(subject.start('thread', false).promise).resolves.toMatchObject({ opened: false })
      const warmPid = Number(await readFile(subject.pidPath, 'utf8'))
      await expect.poll(() => running(warmPid)).toBe(false)
    }
    const opening = subject.start(failure === 'warm-initialize' ? 'initialize' : failure, true)
    // Native startup and home coordination can exceed expect.poll's one-second default on a shared host.
    await expect.poll(() => existsSync(subject.stopping) || opening.outcome() !== undefined, { timeout: 30_000 }).toBe(true)
    expect(opening.outcome(), 'startup rejected before native process exit').toBeUndefined()
    expect(existsSync(subject.stopping)).toBe(true)
    const pid = Number(await readFile(subject.pidPath, 'utf8'))
    expect(running(pid)).toBe(true)
    await writeFile(subject.release, 'release')
    const result = await opening.promise
    expect(result.opened).toBe(false)
    expect(result.error?.message).toContain('stage: startup')
    expect(running(pid)).toBe(false)
  },
)
