/**
 * Real two-process lock contention over one shared root: a child Node
 * process (running the built package under plain Node) creates a session and
 * holds its kernel write lock; this process is excluded while the child
 * lives, and acquires immediately after a SIGKILL — the kernel releases the
 * lock with the dead process's descriptors, no waiting period. Keyless.
 */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const SESSION = 'two-process-lease'

const dirs: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const HOLDER = fileURLToPath(new URL('./fixtures/lease-holder.mjs', import.meta.url))

describe('two-process write lock (built lib)', () => {
  it('excludes a live holder process and takes over immediately after its crash', { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lease-2proc-'))
    dirs.push(root)

    const holder = spawn(process.execPath, [HOLDER, root, SESSION], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const exited = new Promise<void>((resolve) => { holder.once('exit', () => { resolve() }) })
    try {
      await once(holder.stdout, 'data') // 'holding'

      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
      const mine = ctx.sessionPersistence

      // Excluded while the other process's descriptor holds the kernel lock.
      await expect(mine.open(SessionId(SESSION), 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
      // Reads are unaffected across processes.
      const reader = await mine.open(SessionId(SESSION), 'read')
      expect((await reader.read()).map(event => event.seq)).toEqual([0, 1])
      await reader.close()

      // Crash the holder: no release runs, but the kernel drops the lock with
      // the process, so takeover succeeds without any waiting period.
      holder.kill('SIGKILL')
      await exited
      const taken = await mine.open(SessionId(SESSION), 'write')
      await taken.append([{ type: 'turn/start', seq: SessionSeq(2), time: 3, data: { turn: 2 } }])
      expect((await taken.read()).map(event => event.seq)).toEqual([0, 1, 2])
      await taken.close()
    } finally {
      if (holder.exitCode === null) holder.kill('SIGKILL')
    }
  })
})
