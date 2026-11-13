/**
 * SQLite Segment crash safety across a real process boundary: a child Node process holds an
 * open write transaction with uncommitted event rows for an existing Session and is killed with
 * SIGKILL before COMMIT. The parent's provider must read the Session unchanged and append after
 * the kernel releases the dead process's database locks. The child uses only `node:sqlite`. Keyless.
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished } from 'vitest'
import * as plugin from '../src/index.ts'

const event = (seq: number): SessionEvent<'turn/start' | 'turn/end'> => seq % 2 === 0
  ? { type: 'turn/start', seq: SessionSeq(seq), time: 0, data: { turn: seq / 2 + 1 } }
  : { type: 'turn/end', seq: SessionSeq(seq), time: 0, data: { turn: (seq + 1) / 2, reason: { kind: 'completed' } } }

// A one-page cache makes SQLite spill the uncommitted rows into the WAL before the kill.
const UNCOMMITTED_WRITER = `
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(process.env.DSH_DATABASE, { timeout: 5000 })
db.exec('PRAGMA cache_size = 1; BEGIN IMMEDIATE')
const { segment } = db.prepare('SELECT tail_segment_uuid AS segment FROM traces WHERE trace_uuid = ?').get(process.env.DSH_SESSION)
const { next } = db.prepare('SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM events WHERE segment_uuid = ?').get(segment)
const insert = db.prepare('INSERT INTO events VALUES (?, ?, ?)')
for (let offset = 0; offset < 64; offset++) {
  const seq = next + offset
  insert.run(segment, seq, JSON.stringify({ type: 'turn/start', seq, time: 0, data: { turn: seq + 1 }, padding: 'x'.repeat(16384) }))
}
process.stdout.write('inserted\\n')
setInterval(() => {}, 1000)
`

it('discards an uncommitted transaction from a SIGKILLed writer process', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-segment-crash-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(plugin, { storage: 'sqlite', root, compression: 'none' })
  const id = SessionId('crash-target')
  const writer = await ctx.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false })
  await writer.append([event(0), event(1)])
  await writer.close()
  const database = join(root, '.segments', 'sessions.sqlite')
  const before = await ctx.sessionPersistence.stat(id)
  expect(before?.eventCount).toBe(2)
  const walBefore = (await stat(`${database}-wal`)).size

  const child = spawn(process.execPath, ['--input-type=module', '-e', UNCOMMITTED_WRITER], {
    env: { ...process.env, DSH_DATABASE: database, DSH_SESSION: id },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
  })
  await once(child.stdout, 'data')
  // The rows are spilled but not committed: a concurrent WAL reader still sees the committed count.
  expect((await stat(`${database}-wal`)).size).toBeGreaterThan(walBefore)
  expect(await ctx.sessionPersistence.stat(id)).toEqual(before)

  child.kill('SIGKILL')
  await exited
  expect({ code: child.exitCode, signal: child.signalCode }).toEqual({ code: null, signal: 'SIGKILL' })

  const reader = await ctx.sessionPersistence.open(id, 'read')
  try { expect((await reader.read()).events).toEqual([event(0), event(1)]) } finally { await reader.close() }
  const resumed = await ctx.sessionPersistence.open(id, 'write')
  try {
    await resumed.append([event(2)])
    expect((await resumed.read()).events).toEqual([event(0), event(1), event(2)])
  } finally { await resumed.close() }
  const inspect = new DatabaseSync(database, { readOnly: true })
  try { expect(inspect.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' }) } finally { inspect.close() }
})
