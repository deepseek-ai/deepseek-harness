/** Session creation identity and consumer teardown across persistence instances. @module */
import { Context } from '@deepseek-ai/cordis'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionAlreadyExistsError, SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import { SessionWriteLease } from '../src/lease.ts'
import { generationLogPath, toHeaderLine } from '../../session-persistence-jsonl/src/format.ts'
import { persistenceFixture } from './fixtures/persistence.ts'

const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId('competing'), createdAt: 0, isSeeded: false }
const event = (turn: number): SessionEvent<'turn/start'> => ({ type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn } })

async function fixture() {
  const storage = await persistenceFixture()
  const mount = async () => {
    const backend = await storage.mount('sqlite')
    return backend.context
  }
  return { root: storage.root, mount }
}

it('preserves the identity refusal and release failure without retaining either lock', async () => {
  const { mount, root } = await fixture()
  const a = await mount(), b = await mount()
  const first = await a.sessionPersistence.create(header)
  const second = await b.sessionPersistence.create({ ...header, cwd: join(root, 'other-project') })
  await first.flush(); await first.close()
  await writeFile(generationLogPath(root, header.cwd, header.id, header.version, 'none'), JSON.stringify(toHeaderLine(header)) + '\n')
  const failure = new Error('creation lease release failed')
  const spy = vi.spyOn(SessionWriteLease.prototype, 'release').mockImplementationOnce(async function (this: SessionWriteLease) {
    spy.mockRestore()
    await this.release()
    throw failure
  })
  try {
    await expect(second.flush()).rejects.toMatchObject({ errors: [expect.any(SessionAlreadyExistsError), failure] })
  } finally { spy.mockRestore() }
  await expect(second.flush()).rejects.toBeInstanceOf(SessionAlreadyExistsError)
  await second.close()
})

it('excludes another provider while the first creation holds the Session write lock', async () => {
  const { mount, root } = await fixture()
  const a = await mount(), b = await mount()
  const first = await a.sessionPersistence.create(header)
  const second = await b.sessionPersistence.create({ ...header, cwd: join(root, 'other-project') })
  const acquired = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const acquire = SessionWriteLease.acquire.bind(SessionWriteLease)
  const spy = vi.spyOn(SessionWriteLease, 'acquire').mockImplementationOnce(async (...args) => {
    const lease = await acquire(...args)
    acquired.resolve(undefined)
    await release.promise
    return lease
  })
  onTestFinished(() => { release.resolve(undefined); spy.mockRestore() })
  const writing = first.append([event(1)])
  try {
    await acquired.promise
    await expect(second.append([event(2)])).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
  } finally { release.resolve(undefined); spy.mockRestore(); await writing; await first.close() }
  await expect(second.append([event(2)])).rejects.toBeInstanceOf(SessionAlreadyExistsError)
  await second.close()
})

it.each([false, true])('refuses a losing create with different cwd=%s', async (differentCwd) => {
  const { mount, root } = await fixture()
  const a = await mount(), b = await mount()
  const first = await a.sessionPersistence.create(header)
  const second = await b.sessionPersistence.create({ ...header, ...differentCwd ? { cwd: join(root, 'project') } : {} })
  await first.append([event(1)]); await first.close()
  const result = await second.append([event(2)]).then(() => 'committed', (error: unknown) => error)
  await second.close()
  const restarted = await mount()
  const listed = await restarted.sessionPersistence.list()
  const reader = await restarted.sessionPersistence.open(header.id, 'read')
  let stored: readonly SessionEvent[]
  try { stored = (await reader.read()).events } finally { await reader.close() }
  expect(result).toBeInstanceOf(SessionAlreadyExistsError)
  expect(listed.map(entry => entry.header.id)).toEqual([header.id])
  expect(stored).toEqual([event(1)])
})

it.each(['provider', 'root', 'consumer-first'] as const)('preserves the final event during %s teardown', async (owner) => {
  const storage = await persistenceFixture()
  const { context: ctx, provider } = await storage.mount('sqlite')
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const consumer = await ctx.plugin({ name: 'final-writer', inject: ['sessionPersistence', 'sessions'],
    async apply(consumerCtx: Context) {
      const sessions = consumerCtx.sessions
      const live = sessions.prepare(SessionId('final'))
      // Own the Session and final dependency use in one ordered effect, as the Agent factory does.
      consumerCtx.effect(function* () {
        yield sessions.enter(live)
        sessions.announce(live)
        yield async () => {
          entered.resolve(undefined)
          await release.promise
          live.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
          await sessions.flush(live)
        }
      })
      await consumerCtx.sessionPersistence.create(live.header)
      live.append('turn/start', { turn: 1 })
      await consumerCtx.sessions.flush(live)
    },
  })
  const consumerStop = owner === 'consumer-first' ? consumer.dispose() : undefined
  if (consumerStop !== undefined) await entered.promise
  let finished = false
  const stop = (owner === 'root' ? ctx.fiber.dispose() : provider.dispose()).then(() => { finished = true })
  await entered.promise
  // Immediate inspection after a microtask only checks the known consumer barrier.
  await Promise.resolve(undefined)
  expect(finished).toBe(false)
  expect(ctx.events.dispatch('emit', ['session/event'])).toHaveLength(1)
  release.resolve(undefined)
  await stop
  await consumerStop
  const { context: fresh } = await storage.mount('sqlite')
  const reader = await fresh.sessionPersistence.open(SessionId('final'), 'read')
  try { expect((await reader.read()).events.map(item => item.type)).toEqual(['turn/start', 'turn/end']) }
  finally { await reader.close() }
})

it('rejects creation of an existing legacy JSONL identity before reserving a SQLite writer', async () => {
  const fixture = await persistenceFixture()
  const jsonl = await fixture.mount('jsonl')
  const writer = await jsonl.persistence.create(header)
  await writer.flush(); await writer.close()
  const sqlite = await fixture.mount('sqlite')
  await expect(sqlite.persistence.create(header)).rejects.toBeInstanceOf(SessionAlreadyExistsError)
  const reader = await sqlite.persistence.open(header.id, 'read')
  await reader.close()
})
