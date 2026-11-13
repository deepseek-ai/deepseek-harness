/**
 * Real two-process lock contention over one shared root: a child Node
 * process (running the built package under plain Node) creates a session and
 * holds its kernel write lock; this process is excluded while the child
 * lives, and acquires immediately after a SIGKILL — the kernel releases the
 * lock with the dead process's descriptors, no waiting period. Two child
 * processes also commit to different SQLite-backed Sessions in one Segment
 * database concurrently. Keyless.
 */
import { brandString } from '@deepseek-ai/dsh-brand'

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { SessionAlreadyExistsError, SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { routeOf } from './fixtures/segments.ts'

const SESSION = 'two-process-lease'

const dirs: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const HOLDER = fileURLToPath(new URL('./fixtures/lease-holder.mjs', import.meta.url))
const APPENDER = fileURLToPath(new URL('./fixtures/segment-appender.mjs', import.meta.url))

async function storedFiles(root: string): Promise<{ jsonl: boolean; database: boolean }> {
  const names = await readdir(root, { recursive: true })
  const database = await stat(join(root, '.segments', 'sessions.sqlite')).then(() => true, (error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  })
  return { jsonl: names.some(name => name.endsWith('.jsonl')), database }
}

describe('two-process SQLite write lock (built lib)', () => {
  it('excludes a pending creator in another project and releases the Session lock on crash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-create-2proc-'))
    dirs.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(JsonlSessionPersistence, { storage: 'sqlite', root, compression: 'none' })
    const id = SessionId(SESSION)
    const pending = await ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION, id, createdAt: 1000, isSeeded: false, cwd: join(root, 'other-project'),
    })
    const holder = spawn(process.execPath, [HOLDER, root, SESSION, 'segments', 'pending'], { stdio: ['pipe', 'pipe', 'inherit'] })
    const exited = new Promise<void>((resolve) => { holder.once('exit', () => { resolve() }) })
    const ready = () => Promise.race([
      once(holder.stdout, 'data'),
      exited.then(() => { throw new Error(`Creator exited before ready: ${String(holder.exitCode ?? holder.signalCode)}`) }),
    ])
    try {
      await ready()
      const holding = ready()
      holder.stdin.end('commit\n')
      await holding
      const event = { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 2 } } as const
      await expect(pending.append([event])).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
      holder.kill('SIGKILL')
      await exited
      await expect(pending.append([event])).rejects.toBeInstanceOf(SessionAlreadyExistsError)
      await pending.close()
      expect((await ctx.sessionPersistence.list()).map(entry => entry.header.id)).toEqual([id])
      const reader = await ctx.sessionPersistence.open(id, 'read')
      try { expect((await reader.read()).events.map(entry => entry.seq)).toEqual([0, 1]) }
      finally { await reader.close() }
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL')
      await exited
    }
  })

  it('excludes a live holder process and takes over immediately after its crash', { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lease-2proc-'))
    dirs.push(root)

    const holder = spawn(process.execPath, [HOLDER, root, SESSION, 'segments'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const exited = new Promise<void>((resolve) => { holder.once('exit', () => { resolve() }) })
    try {
      await Promise.race([
        once(holder.stdout, 'data'), // 'holding'
        exited.then(() => { throw new Error(`Lease holder exited before holding: ${String(holder.exitCode ?? holder.signalCode)}`) }),
      ])
      // The holder's Session is stored by the selected backend only.
      expect(await routeOf(root, SessionId(SESSION))).toBe('sqlite')
      expect(await storedFiles(root)).toEqual({ jsonl: false, database: true })

      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(JsonlSessionPersistence, { storage: 'sqlite', root, compression: 'none' })
      const mine = ctx.sessionPersistence

      // Excluded while the other process's descriptor holds the kernel lock.
      await expect(mine.open(brandString<SessionId>(SESSION), 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
      // Reads are unaffected across processes.
      const reader = await mine.open(brandString<SessionId>(SESSION), 'read')
      expect((await reader.read()).events.map(event => event.seq)).toEqual([0, 1])
      await reader.close()

      // Crash the holder: no release runs, but the kernel drops the lock with
      // the process, so takeover succeeds without any waiting period.
      holder.kill('SIGKILL')
      await exited
      const taken = await mine.open(brandString<SessionId>(SESSION), 'write')
      await taken.append([{ type: 'turn/start', seq: SessionSeq(2), time: 3, data: { turn: 2 } }])
      expect((await taken.read()).events.map(event => event.seq)).toEqual([0, 1, 2])
      await taken.close()
    } finally {
      if (holder.exitCode === null) holder.kill('SIGKILL')
      await exited
    }
  })
})

describe('two-process Segment database writers (built lib)', () => {
  it('commits concurrent appends to different Sessions in one database from two processes', { timeout: 60_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-segment-2proc-'))
    dirs.push(root)
    // Initialize the shared database before the writers start.
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(JsonlSessionPersistence, { storage: 'sqlite', root, compression: 'none' })
    const count = 200
    const ids = [SessionId('segment-writer-a'), SessionId('segment-writer-b')]
    const writers = ids.map(id => spawn(process.execPath, [APPENDER, root, id, String(count)], {
      stdio: ['pipe', 'pipe', 'inherit'],
    }))
    const exits = writers.map(writer => new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      writer.once('exit', (code, signal) => { resolve({ code, signal }) })
    }))
    try {
      // 'ready'; a writer that exits first fails the case instead of leaving the readiness wait pending.
      await Promise.all(writers.map(async (writer, index) => {
        await Promise.race([
          once(writer.stdout, 'data'),
          exits[index]!.then((status) => { throw new Error(`Segment writer exited before ready: ${JSON.stringify(status)}`) }),
        ])
      }))
      // Release both writers together so their commit loops overlap.
      for (const writer of writers) writer.stdin.end('go\n')
      expect(await Promise.all(exits)).toEqual([{ code: 0, signal: null }, { code: 0, signal: null }])
    } finally {
      for (const writer of writers) if (writer.exitCode === null && writer.signalCode === null) writer.kill('SIGKILL')
      await Promise.all(exits)
    }
    const expected = Array.from({ length: count }, (_, seq) => seq)
    for (const id of ids) {
      expect((await ctx.sessionPersistence.stat(id))?.eventCount).toBe(count)
      expect(await routeOf(root, id)).toBe('sqlite')
      const reader = await ctx.sessionPersistence.open(id, 'read')
      try { expect((await reader.read()).events.map(event => event.seq)).toEqual(expected) } finally { await reader.close() }
    }
    expect((await ctx.sessionPersistence.list()).map(entry => entry.header.id).sort()).toEqual(ids)
    expect(await storedFiles(root)).toEqual({ jsonl: false, database: true })
  })
})
