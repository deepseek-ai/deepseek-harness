import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { scanCommand } from '../src/process.ts'
import { harness, repository } from './harness.ts'

const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})

/**
 * Make `done` reject once `terminate()` is called, as the SSH provider does
 * when it cancels a launch whose start it has not yet acknowledged.
 */
function rejectDoneOnTerminate(ctx: Context): void {
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
    const handle = spawn(spec)
    let cancelled: Promise<never> | undefined
    return {
      get stdin() { return handle.stdin },
      get stdout() { return handle.stdout },
      get stderr() { return handle.stderr },
      get control() { return handle.control },
      get collected() { return handle.collected },
      get done() { return cancelled === undefined ? handle.done : Promise.race([handle.done, cancelled]) },
      terminate() {
        cancelled ??= Promise.reject(new Error('SSH process terminated before launch acknowledgement'))
        handle.terminate()
      },
      waitForExit: signal => handle.waitForExit(signal),
    }
  })
}

describe('streamed commands', () => {
  it('returns the early answer when stopping rejects the outcome of an unacknowledged launch', async () => {
    const root = await repository()
    disposers.push(() => rm(root, { recursive: true, force: true }))
    const ctx = await harness(root)
    disposers.push(() => ctx.fiber.dispose())
    await writeFile(join(root, 'untracked.txt'), 'dirty\n')
    rejectDoneOnTerminate(ctx)
    const fields: string[] = []

    const stopped = await scanCommand(
      ctx, { timeoutMs: 30_000, graceMs: 1_000, maxOutputBytes: 1_024 }, ctx.sandboxPolicy.resolve(), root,
      ['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], new AbortController().signal,
      (field) => {
        fields.push(field)
        return false
      },
    )

    expect(stopped).toBe(true)
    expect(fields).toEqual(['?? untracked.txt'])
  })
})
