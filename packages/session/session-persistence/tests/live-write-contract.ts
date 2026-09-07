/**
 * Shared live-write-path contract for any {@link SessionPersistence} backend:
 * published live events route by session id into the active write handle,
 * `session/flush` is the durability and error-observation barrier,
 * `session/disposed` drains and closes, and `close()` itself drains the
 * routed buffer — including through backend teardown with no cross-fiber
 * ordering. Each provider owns its storage runtime; this suite pins the
 * equivalent observable behavior the seam requires.
 *
 * @module @deepseek-ai/dsh-session-persistence/tests/live-write-contract
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '../src/index.ts'

/** One mounted backend under a session store, plus same-storage remount support. */
export interface LiveWriteBackend {
  /** Context with SessionStore and the persistence backend mounted. */
  readonly ctx: Context
  /** Mount a FRESH context over the SAME storage, as after a process restart. */
  readonly remount: () => Promise<Context>
}

async function readAll(persistence: SessionPersistence, id: ReturnType<typeof SessionId>): Promise<readonly SessionEvent[]> {
  const reader = await persistence.open(id, 'read')
  try {
    return (await reader.read()).events
  } finally {
    await reader.close()
  }
}

/**
 * Run the backend-agnostic live-write-path suite.
 * @param name - suite label, e.g. `jsonl` / `sqlite`.
 * @param batchDelayMs - the provider's fixed live batching window.
 * @param make - factory producing one fresh mounted backend per test; every
 *   created context is disposed by the test that made it.
 */
export function runLiveWritePathContract(
  name: string,
  batchDelayMs: number,
  make: () => Promise<LiveWriteBackend>,
): void {
  describe(`live session write path: ${name}`, () => {
    it('routes published events into the active write handle within one batching window', async () => {
      const { ctx } = await make()
      const session = ctx.sessions.create(SessionId('routed'))
      const handle = await ctx.sessionPersistence.create(session.header)
      vi.useFakeTimers()
      try {
        session.append('turn/start', { turn: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        await vi.advanceTimersByTimeAsync(batchDelayMs - 1)
        // One tick short of the window: nothing stored yet (in-process
        // visibility serves the created-but-empty session).
        expect(await readAll(ctx.sessionPersistence, session.id)).toEqual([])
        await vi.advanceTimersByTimeAsync(1)
      } finally {
        vi.useRealTimers()
      }
      // The deadline started a background write; wait for its durability.
      await vi.waitFor(async () => {
        expect((await readAll(ctx.sessionPersistence, session.id)).map(event => [event.type, event.seq])).toEqual([
          ['turn/start', 0],
          ['turn/end', 1],
        ])
      })
      await handle.close()
      await ctx.fiber.dispose()
    })

    it('a session without an active write handle persists nothing', async () => {
      const { ctx } = await make()
      const session = ctx.sessions.create(SessionId('unrouted'))
      session.append('turn/start', { turn: 1 })
      await ctx.sessions.flush(session)
      await expect(ctx.sessionPersistence.stat(session.id)).resolves.toBeUndefined()
      await ctx.fiber.dispose()
    })

    it('session/flush drains immediately and surfaces a retained background failure', async () => {
      const { ctx } = await make()
      const session = ctx.sessions.create(SessionId('flush-surfaces'))
      const handle = await ctx.sessionPersistence.create(session.header)
      const warned = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
      const failure = new Error('backend write refused')
      // Inject at the service's storage primitive: the routed drain writes
      // through the handle's internal chain, not the public append.
      const persist = vi.spyOn(ctx.sessionPersistence as unknown as { persistBatch: () => Promise<void> }, 'persistBatch')
        .mockRejectedValue(failure)

      vi.useFakeTimers()
      session.append('turn/start', { turn: 1 })
      await vi.advanceTimersByTimeAsync(batchDelayMs)
      vi.useRealTimers()
      await vi.waitFor(() => {
        expect(warned.mock.calls.join('\n')).toContain('background write for session "flush-surfaces" failed')
      })

      // The barrier retries the retained batch and rejects loudly...
      await expect(ctx.sessions.flush(session)).rejects.toBe(failure)
      // ...and once the backend recovers, the same events land exactly once.
      persist.mockRestore()
      await expect(ctx.sessions.flush(session)).resolves.toBe(true)
      expect((await readAll(ctx.sessionPersistence, session.id)).map(event => event.seq)).toEqual([0])
      warned.mockRestore()
      await handle.close()
      await ctx.fiber.dispose()
    })

    it('service-level flush drains every active handle and aggregates the failures', async () => {
      const { ctx } = await make()
      const healthy = ctx.sessions.create(SessionId('flush-all-healthy'))
      const failing = ctx.sessions.create(SessionId('flush-all-failing'))
      const healthyHandle = await ctx.sessionPersistence.create(healthy.header)
      const failingHandle = await ctx.sessionPersistence.create(failing.header)
      const service = ctx.sessionPersistence as unknown as {
        persistBatch: (header: { id: string }, ...rest: unknown[]) => Promise<void>
      }
      const original = service.persistBatch.bind(service)
      const failure = new Error('backend write refused')
      const persist = vi.spyOn(service, 'persistBatch').mockImplementation((header, ...rest) =>
        header.id === failing.id ? Promise.reject(failure) : original(header, ...rest))

      vi.useFakeTimers()
      try {
        healthy.append('turn/start', { turn: 1 })
        failing.append('turn/start', { turn: 1 })
        // No batching window elapses: the service barrier itself drains both
        // buffers and reports the one failure without abandoning the sweep.
        await expect(ctx.sessionPersistence.flush()).rejects.toSatisfy((error: unknown) =>
          error instanceof AggregateError && error.errors.length === 1 && error.errors[0] === failure)
      } finally {
        vi.useRealTimers()
      }
      // The healthy session flushed durably despite its neighbor's failure...
      expect((await readAll(ctx.sessionPersistence, healthy.id)).map(event => event.seq)).toEqual([0])
      // ...and the failed batch is retained: a recovered backend flushes it exactly once.
      persist.mockRestore()
      await ctx.sessionPersistence.flush()
      expect((await readAll(ctx.sessionPersistence, failing.id)).map(event => event.seq)).toEqual([0])
      await healthyHandle.close()
      await failingHandle.close()
      await ctx.fiber.dispose()
    })

    it('session/disposed drains buffered events and closes the handle', async () => {
      const { ctx } = await make()
      let session: ReturnType<Context['sessions']['create']> | undefined
      const owner = await ctx.plugin(Object.assign((inner: Context) => {
        session = inner.sessions.create(SessionId('disposed-drains'))
      }, { inject: ['sessions'] }))
      if (session === undefined) throw new Error('session was not created')
      const handle = await ctx.sessionPersistence.create(session.header)
      session.append('turn/start', { turn: 1 })
      // Buffered, not yet written: disposal must drain before the close.
      await owner.dispose()
      await vi.waitFor(async () => {
        expect((await readAll(ctx.sessionPersistence, SessionId('disposed-drains'))).map(event => event.seq)).toEqual([0])
      })
      await expect(handle.append([])).rejects.toThrow(/closed handle/)
      await ctx.fiber.dispose()
    })

    it('a failing final drain on disposal is warned, not thrown', async () => {
      const { ctx } = await make()
      let session: ReturnType<Context['sessions']['create']> | undefined
      const owner = await ctx.plugin(Object.assign((inner: Context) => {
        session = inner.sessions.create(SessionId('disposed-drain-fails'))
      }, { inject: ['sessions'] }))
      if (session === undefined) throw new Error('session was not created')
      const handle = await ctx.sessionPersistence.create(session.header)
      const warned = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
      vi.spyOn(handle, 'close').mockRejectedValue(new Error('drain exploded'))
      session.append('turn/start', { turn: 1 })
      await owner.dispose()
      await vi.waitFor(() => {
        expect(warned.mock.calls.join('\n')).toContain('final drain for session "disposed-drain-fails" failed')
      })
      warned.mockRestore()
      await ctx.fiber.dispose()
    })

    it('backend teardown drains buffered events through the close sweep', async () => {
      const backend = await make()
      const { ctx } = backend
      const session = ctx.sessions.create(SessionId('teardown-drains'))
      const handle = await ctx.sessionPersistence.create(session.header)
      session.append('turn/start', { turn: 1 })
      // Root disposal closes the still-open handle; close drains the buffer.
      await ctx.fiber.dispose()
      await expect(handle.append([])).rejects.toThrow(/closed handle/)

      const verify = await backend.remount()
      expect((await readAll(verify.sessionPersistence, session.id)).map(event => event.seq)).toEqual([0])
      await verify.fiber.dispose()
    })

    it('close itself surfaces a failing drain and still releases write ownership', async () => {
      const { ctx } = await make()
      const session = ctx.sessions.create(SessionId('close-drain-fails'))
      const handle = await ctx.sessionPersistence.create(session.header)
      const failure = new Error('storage refused the drain')
      vi.spyOn(ctx.sessionPersistence as unknown as { persistBatch: () => Promise<void> }, 'persistBatch')
        .mockRejectedValue(failure)
      session.append('turn/start', { turn: 1 })
      await expect(handle.close()).rejects.toBe(failure)
      // Ownership was released despite the failed drain: the id is claimable.
      const second = await ctx.sessionPersistence.create(session.header)
      await second.close()
      await ctx.fiber.dispose()
    })

    it('close normalizes a non-Error drain failure', async () => {
      const { ctx } = await make()
      const session = ctx.sessions.create(SessionId('close-drain-string'))
      const handle = await ctx.sessionPersistence.create(session.header)
      vi.spyOn(ctx.sessionPersistence as unknown as { persistBatch: () => Promise<void> }, 'persistBatch')
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error arm is the case under test.
        .mockImplementation(() => Promise.reject('backend string refusal'))
      session.append('turn/start', { turn: 1 })
      await expect(handle.close()).rejects.toThrow('backend string refusal')
      await ctx.fiber.dispose()
    })

    it('a failed drain retains order, quiets the timer, and recovers exactly once', async () => {
      const { ctx } = await make()
      const session = ctx.sessions.create(SessionId('retained-order'))
      const handle = await ctx.sessionPersistence.create(session.header)
      const warned = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
      const host = ctx.sessionPersistence as unknown as { persistBatch: (...args: unknown[]) => Promise<void> }
      // Materialize under real timers first: the write lock is acquired ahead
      // of the first materializing write, and that real I/O must not sit
      // inside the fake-timer window below.
      await handle.flush()
      const real = host.persistBatch.bind(host)
      const persist = vi.spyOn(host, 'persistBatch').mockRejectedValue(new Error('first drain refused'))

      vi.useFakeTimers()
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      await vi.advanceTimersByTimeAsync(batchDelayMs)
      // Events arriving after the failure join the retained queue, and no new
      // timer fires while the automatic path is paused.
      session.append('step/end', { turn: 1, step: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await vi.advanceTimersByTimeAsync(batchDelayMs * 4)
      vi.useRealTimers()
      expect(persist).toHaveBeenCalledTimes(1)

      persist.mockImplementation(real)
      await expect(ctx.sessions.flush(session)).resolves.toBe(true)
      expect((await readAll(ctx.sessionPersistence, session.id)).map(event => event.seq)).toEqual([0, 1, 2, 3])
      warned.mockRestore()
      await handle.close()
      await ctx.fiber.dispose()
    })

    it('a second write handle after close routes subsequent events', async () => {
      const { ctx } = await make()
      const session = ctx.sessions.create(SessionId('rebind'))
      const first = await ctx.sessionPersistence.create(session.header)
      session.append('turn/start', { turn: 1 })
      await ctx.sessions.flush(session)
      await first.close()

      const second = await ctx.sessionPersistence.open(session.id, 'write')
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await ctx.sessions.flush(session)
      expect((await readAll(ctx.sessionPersistence, session.id)).map(event => event.seq)).toEqual([0, 1])
      await second.close()
      await ctx.fiber.dispose()
    })
  })
}
