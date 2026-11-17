/** Follow-up batching deadlines while a preceding write remains in flight. @module */
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { sqliteLogs } from './fixtures/store.ts'
import * as persistence from '../src/index.ts'
import { SqliteStore, SqliteSessionHandle } from '../src/sqlite.ts'

const event = (seq: number): SessionEvent => seq % 2 === 0
  ? { type: 'turn/start', seq: SessionSeq(seq), time: 0, data: { turn: seq / 2 + 1 } }
  : { type: 'turn/end', seq: SessionSeq(seq), time: 0, data: { turn: (seq + 1) / 2, reason: { kind: 'completed' } } }

it.each([false, true])('schedules a threshold batch during drain settlement, failure=%s', async (fail) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-drain-settlement-'))
  const reported = Promise.withResolvers<unknown>()
  const logs = sqliteLogs(join(root, 'sessions.sqlite'), root, {
    report: (_id, error) => { reported.resolve(error) },
  })
  onTestFinished(async () => { try { await logs.close() } finally { await rm(root, { recursive: true, force: true }) } })
  const writer = await logs.create({ version: SESSION_FORMAT_VERSION, id: SessionId('settlement'), createdAt: 0, isSeeded: false })
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const stored = Promise.withResolvers<undefined>(), failure = new Error('follow-up rejected')
  const append = logs.append.bind(logs)
  let refused = false
  const spy = vi.spyOn(logs, 'append').mockImplementation(async (...args) => {
    if (args[1][0]?.seq === 0) { entered.resolve(undefined); await release.promise }
    if (args[1][0]?.seq === 256 && fail && !refused) { refused = true; throw failure }
    await append(...args)
    if (args[1][0]?.seq === 256) stored.resolve(undefined)
  })
  onTestFinished(() => { release.resolve(undefined); spy.mockRestore() })
  for (let seq = 0; seq < 256; seq++) await writer.receive(event(seq))
  await entered.promise
  // This queue barrier places admission after the drain's last batch, before its completion handler.
  const pending: unknown = Reflect.get(writer, 'pending')
  if (!(pending instanceof Promise)) throw new Error('Missing write queue barrier')
  const admission = pending.then(() => Promise.all(
    Array.from({ length: 256 }, (_, seq) => writer.receive(event(seq + 256))),
  ))
  release.resolve(undefined)
  await writer.drainLive()
  await admission
  expect(spy).toHaveBeenCalledTimes(2)
  if (fail) {
    expect(await reported.promise).toBe(failure)
    await writer.flush()
  }
  await stored.promise
  await writer.close()
  const reader = await logs.open(writer.id, 'read')
  try { expect((await reader.read()).events.map(event => event.seq)).toEqual(Array.from({ length: 512 }, (_, seq) => seq)) }
  finally { await reader.close() }
})

it('starts a follow-up write once its own batching deadline elapsed during the preceding commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-deadline-'))
  const logs = sqliteLogs(join(root, 'sessions.sqlite'), root)
  const writer = await logs.create({ version: SESSION_FORMAT_VERSION, id: SessionId('deadline'), createdAt: 0, isSeeded: false })
  await writer.flush()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const append = logs.append.bind(logs)
  const writes = vi.spyOn(logs, 'append').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined)
    await release.promise
    await append(...args)
  })
  vi.useFakeTimers()
  try {
    await writer.receive(event(0)); await writer.receive(event(1))
    await vi.advanceTimersByTimeAsync(200)
    await entered.promise
    await writer.receive(event(2))
    // The follow-up deadline expires while the first commit remains owned by the barrier.
    await vi.advanceTimersByTimeAsync(400)
    expect(writes).toHaveBeenCalledTimes(1)
    release.resolve(undefined)
    await writer.drainLive()
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toHaveBeenCalledTimes(2)
  } finally {
    release.resolve(undefined)
    try { await writer.close() }
    finally {
      writes.mockRestore()
      vi.useRealTimers()
      try { await logs.close() }
      finally { await rm(root, { recursive: true, force: true }) }
    }
  }
})

it('retains the published settlement event under an immediate-close interleaving', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-close-settlement-'))
  const ctx = new Context()
  onTestFinished(async () => { try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } })
  await ctx.plugin(SessionStore)
  await ctx.plugin(persistence, { root, compression: 'none' })
  const session = ctx.sessions.create(SessionId('settlement-parity'))
  const writer = await ctx.sessionPersistence.create(session.header)
  if (!(writer instanceof SqliteSessionHandle)) throw new Error('Missing provider handle')
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  let restore: () => void
  {
    // oxlint-disable-next-line typescript/unbound-method -- Called with the intercepted store as receiver below.
    const original = SqliteStore.prototype.append
    const spy = vi.spyOn(SqliteStore.prototype, 'append').mockImplementationOnce(async function (this: SqliteStore, ...args) {
      entered.resolve(undefined)
      await release.promise
      await original.call(this, ...args)
    })
    restore = () => { spy.mockRestore() }
  }
  onTestFinished(() => { release.resolve(undefined); restore() })
  session.append('turn/start', { turn: 1 })
  const draining = writer.drainLive()
  await entered.promise
  const pending: unknown = Reflect.get(writer, 'pending')
  if (!(pending instanceof Promise)) throw new Error('Missing current provider queue barrier')
  const closing = pending.then(() => {
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    return writer.close()
  })
  release.resolve(undefined)
  await draining
  await closing
  restore()
  const reader = await ctx.sessionPersistence.open(session.id, 'read')
  try { expect((await reader.read()).events.map(item => item.type)).toEqual(['turn/start', 'turn/end']) }
  finally { await reader.close() }
})
