/**
 * Reusable handle contract test for any {@link SessionPersistence} backend. A
 * backend package imports {@link runPersistenceContract} and calls it with a
 * factory that yields a fresh, empty backend (plus teardown, an optional
 * same-storage reopen, and an optional physical tail corruptor), so every
 * backend is held to the same create/open/handle semantics: append-only
 * contiguous seqs, single-writer ownership, lazy materialization, fail-closed
 * vocabulary, freshness, and torn-tail repair. Backend-specific behavior
 * (file layout, encodings, artifact export) stays in each backend's own spec.
 *
 * @module @deepseek-ai/dsh-session-persistence/tests/contract
 */

import { describe, expect, it } from 'vitest'
import { SessionSeq, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { MessageId, freezeMessage } from '@deepseek-ai/dsh-llm'
import {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionFormatUnsupportedError,
  SessionHandleClosedError,
  SessionPersistenceNotFoundError,
  SessionReadOnlyError,
} from '../src/index.ts'
import type { SessionHandle, SessionPersistence } from '../src/index.ts'

/** One backend service instance under test plus its teardown. */
interface ContractBackendInstance {
  persistence: SessionPersistence
  dispose: () => Promise<void>
}

/** A backend under test: the primary instance plus optional storage-level capabilities. */
export interface ContractBackend extends ContractBackendInstance {
  /**
   * Open a FRESH backend instance over the SAME storage, as another process
   * would after this one exits. Enables the cross-instance visibility and
   * reopen-continuation tests; a backend without shared storage omits it and
   * those tests self-skip.
   */
  reopen?: () => Promise<ContractBackendInstance>
  /**
   * Inject a torn physical tail after the committed log of one stored session,
   * simulating a crash mid-write. Enables the torn-tail tests.
   */
  corruptTail?: (id: SessionId, cwd: string | undefined) => Promise<void>
}

/** Build a minimal {@link SessionHeader} for a session id. */
export function meta(id: string, cwd?: string): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1000,
    isSeeded: false,
    ...cwd !== undefined ? { cwd } : {},
  }
}

/** A well-formed one-turn event log (contiguous seqs from 0). */
export function oneTurnLog(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: SessionSeq(1), time: 2, data: freezeMessage({
      id: MessageId('one-turn-user'),
      role: 'user',
      content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
    }), surfaceOp: 'append' },
    { type: 'step/start', seq: SessionSeq(2), time: 3, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: SessionSeq(3), time: 4, data: {
      turn: 1, step: 1,
      message: freezeMessage({
        id: MessageId('one-turn-assistant'),
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        source: {
          kind: 'model',
          ...{ provider: 'mock', model: 'mock' },
        },
      }),
      stream: [
        { type: 'chunk', time: 3, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
        { type: 'text-chunks', time0: 3, index: 0, dt: [], texts: ['hello'] },
        { type: 'chunk', time: 4, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } } },
        { type: 'chunk', time: 4, chunk: { type: 'finish', reason: { kind: 'stop' } } },
      ],
    }, surfaceOp: 'append' },
    { type: 'step/end', seq: SessionSeq(4), time: 5, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: SessionSeq(5), time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/** Frozen v0/v1 form of {@link oneTurnLog} with top-level raw chunk events. */
export function releasedV1OneTurnLog(): SessionEvent[] {
  const current = oneTurnLog()
  const message = current[3] as SessionEvent<'assistant/message'>
  return [
    current[0] as SessionEvent,
    current[1] as SessionEvent,
    current[2] as SessionEvent,
    { type: 'assistant/chunk', seq: SessionSeq(3), time: 3, data: {
      turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' },
    } } as unknown as SessionEvent,
    { type: 'assistant/chunk', seq: SessionSeq(4), time: 3, data: {
      turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hello' },
    } } as unknown as SessionEvent,
    { type: 'assistant/chunk', seq: SessionSeq(5), time: 4, data: {
      turn: 1, step: 1, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
    } } as unknown as SessionEvent,
    { type: 'assistant/chunk', seq: SessionSeq(6), time: 4, data: {
      turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } },
    } } as unknown as SessionEvent,
    { ...message, seq: SessionSeq(7), data: {
      turn: message.data.turn,
      step: message.data.step,
      message: message.data.message,
    }, sourceEventSeqs: [SessionSeq(3), SessionSeq(4), SessionSeq(5), SessionSeq(6)] } as SessionEvent,
    { ...(current[4] as SessionEvent), seq: SessionSeq(8) },
    { ...(current[5] as SessionEvent), seq: SessionSeq(9) },
  ]
}


/** A contiguous second-turn batch continuing {@link oneTurnLog}. */
function secondTurn(startSeq = 6): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(startSeq), time: 9, data: { turn: 2 } },
    { type: 'turn/end', seq: SessionSeq(startSeq + 1), time: 10, data: { turn: 2, reason: { kind: 'completed' } } },
  ]
}

/**
 * Run the backend-agnostic handle contract suite. `make()` MUST return a
 * fresh backend over fresh, empty storage each call.
 * @param name - suite label, e.g. `jsonl-none` / `sqlite`.
 * @param make - factory producing one fresh {@link ContractBackend} per test.
 */
export function runPersistenceContract(name: string, make: () => Promise<ContractBackend>): void {
  describe(`SessionPersistence contract: ${name}`, () => {
    it('round-trips through one write handle: append, self-read, offset/length defaults', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = meta('round-trip', '/work')
        const log = oneTurnLog()
        const handle = await persistence.create(m)
        expect(handle.access).toBe('write')
        expect(handle.id).toBe(m.id)
        expect(handle.header).toMatchObject(m)

        await handle.append(log)
        // An empty batch is a no-op, not an error.
        await handle.append([])
        // A write handle reads its own successful appends.
        expect(await handle.read()).toEqual(log)
        expect(await handle.read(3)).toEqual(log.slice(3))
        expect(await handle.read(0, 2)).toEqual(log.slice(0, 2))
        expect(await handle.read(1, 3)).toEqual(log.slice(1, 4))
        // At/past the stored end: an empty list, never an error.
        expect(await handle.read(log.length)).toEqual([])
        expect(await handle.read(log.length + 100)).toEqual([])
        // flush after a durable append is a satisfied barrier, not an error.
        await handle.flush()
        await handle.close()
      } finally {
        await dispose()
      }
    })

    it('read rejects negative or fractional offsets and lengths', async () => {
      const { persistence, dispose } = await make()
      try {
        const handle = await persistence.create(meta('read-args'))
        await expect(handle.read(-1)).rejects.toThrow(/non-negative safe integer/)
        await expect(handle.read(1.5)).rejects.toThrow(/non-negative safe integer/)
        await expect(handle.read(0, -1)).rejects.toThrow(/non-negative safe integer/)
        await handle.close()
      } finally {
        await dispose()
      }
    })

    it('duplicate create rejects against a live pending session and allows the id after an erasing close', async () => {
      const { persistence, dispose } = await make()
      try {
        const first = await persistence.create(meta('dup-pending'))
        await expect(persistence.create(meta('dup-pending'))).rejects.toBeInstanceOf(SessionAlreadyExistsError)
        // Closing the creator without ever appending erases the session, so
        // the id is free again.
        await first.close()
        const second = await persistence.create(meta('dup-pending'))
        await second.close()
      } finally {
        await dispose()
      }
    })

    it('concurrent duplicate creates: one wins, the loser rejects SessionAlreadyExistsError', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = meta('dup-race')
        // Both calls pass the stored-existence check before either registers,
        // so the loser is refused at the claim, still as a duplicate create.
        const results = await Promise.allSettled([persistence.create(m), persistence.create(m)])
        const winners = results.filter(r => r.status === 'fulfilled')
        const losers = results.filter(r => r.status === 'rejected')
        expect(winners).toHaveLength(1)
        expect(losers).toHaveLength(1)
        expect((losers[0] as PromiseRejectedResult).reason).toBeInstanceOf(SessionAlreadyExistsError)
        await (winners[0] as PromiseFulfilledResult<SessionHandle>).value.close()
      } finally {
        await dispose()
      }
    })

    it('duplicate create rejects against a materialized artifact seen by a fresh instance', async () => {
      const backend = await make()
      try {
        if (backend.reopen === undefined) return
        const m = meta('dup-stored', '/work')
        const handle = await backend.persistence.create(m)
        await handle.append(oneTurnLog())
        await handle.close()

        const reopened = await backend.reopen()
        try {
          await expect(reopened.persistence.create(meta('dup-stored', '/work')))
            .rejects.toBeInstanceOf(SessionAlreadyExistsError)
        } finally {
          await reopened.dispose()
        }
      } finally {
        await backend.dispose()
      }
    })

    it('open of an absent session rejects with SessionPersistenceNotFoundError for both accesses', async () => {
      const { persistence, dispose } = await make()
      try {
        await expect(persistence.open(SessionId('absent'), 'read')).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
        await expect(persistence.open(SessionId('absent'), 'write')).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
      } finally {
        await dispose()
      }
    })

    it('write ownership is single-holder per instance and released by close', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = meta('owned')
        const creator = await persistence.create(m)
        // The creator holds ownership even before materialization.
        await expect(persistence.open(m.id, 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
        await creator.append(oneTurnLog())
        await expect(persistence.open(m.id, 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
        await creator.close()

        // After close, a new write handle continues at the stored next-seq.
        const writer = await persistence.open(m.id, 'write')
        await writer.append(secondTurn())
        expect((await writer.read()).map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
        await writer.close()
      } finally {
        await dispose()
      }
    })

    it('a read handle refuses append and flush with SessionReadOnlyError', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = meta('read-only')
        const writer = await persistence.create(m)
        await writer.append(oneTurnLog())
        await writer.close()

        const reader = await persistence.open(m.id, 'read')
        expect(reader.access).toBe('read')
        await expect(reader.append(secondTurn())).rejects.toBeInstanceOf(SessionReadOnlyError)
        await expect(reader.flush()).rejects.toBeInstanceOf(SessionReadOnlyError)
        // The refusals mutated nothing.
        expect(await reader.read()).toEqual(oneTurnLog())
        await reader.close()
      } finally {
        await dispose()
      }
    })

    it('operations on a closed handle reject; close is idempotent; asyncDispose releases ownership', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = meta('closed')
        const handle = await persistence.create(m)
        await handle.append(oneTurnLog())
        await handle.close()
        await handle.close()
        await expect(handle.read()).rejects.toBeInstanceOf(SessionHandleClosedError)
        await expect(handle.append(secondTurn())).rejects.toBeInstanceOf(SessionHandleClosedError)
        await expect(handle.flush()).rejects.toBeInstanceOf(SessionHandleClosedError)

        {
          await using writer = await persistence.open(m.id, 'write')
          await writer.append(secondTurn())
        }
        // Leaving the block disposed the handle, so ownership is free again.
        const reopened = await persistence.open(m.id, 'write')
        await reopened.close()
      } finally {
        await dispose()
      }
    })

    it('service-level flush materializes every active write handle and counts a closing one as flushed', async () => {
      const backend = await make()
      try {
        const materialized = await backend.persistence.create(meta('flush-all'))
        const abandoned = await backend.persistence.create(meta('flush-all-closing'))
        // Close starts before the barrier: the swept handle refuses its flush,
        // which counts as flushed — close itself drained durably.
        const closing = abandoned.close()
        await backend.persistence.flush()
        await closing

        if (backend.reopen !== undefined) {
          const reopened = await backend.reopen()
          try {
            // The barrier materialized the empty session durably...
            expect(await reopened.persistence.stat(SessionId('flush-all'))).toBeDefined()
            // ...while the one that closed unappended never existed.
            expect(await reopened.persistence.stat(SessionId('flush-all-closing'))).toBeUndefined()
          } finally {
            await reopened.dispose()
          }
        }
        await materialized.close()
      } finally {
        await backend.dispose()
      }
    })

    it('a created-but-unappended session is visible to this instance and invisible to a fresh one', async () => {
      const backend = await make()
      try {
        const m = meta('lazy', '/work')
        const creator = await backend.persistence.create(m)
        // The creator's own reads see the empty log before materialization.
        expect(await creator.read()).toEqual([])

        const snapshot = await backend.persistence.stat(m.id)
        expect(snapshot?.header).toMatchObject(m)
        expect((await backend.persistence.list()).map(s => s.header.id)).toContain(m.id)
        const reader = await backend.persistence.open(m.id, 'read')
        expect(await reader.read()).toEqual([])
        await reader.close()

        if (backend.reopen !== undefined) {
          const reopened = await backend.reopen()
          try {
            expect(await reopened.persistence.stat(m.id)).toBeUndefined()
            expect((await reopened.persistence.list()).map(s => s.header.id)).not.toContain(m.id)
            await expect(reopened.persistence.open(m.id, 'read')).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
          } finally {
            await reopened.dispose()
          }
        }
        await creator.close()
      } finally {
        await backend.dispose()
      }
    })

    it('close without an append erases the created session from this instance', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = meta('never-was')
        const creator = await persistence.create(m)
        await creator.close()

        expect(await persistence.stat(m.id)).toBeUndefined()
        expect((await persistence.list()).map(s => s.header.id)).not.toContain(m.id)
        await expect(persistence.open(m.id, 'read')).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
      } finally {
        await dispose()
      }
    })

    it('flush materializes an empty session durably for a fresh instance', async () => {
      const backend = await make()
      try {
        if (backend.reopen === undefined) return
        const m = meta('durable-empty', '/work')
        const creator = await backend.persistence.create(m)
        await creator.flush()
        await creator.close()

        const reopened = await backend.reopen()
        try {
          expect((await reopened.persistence.list()).map(s => s.header.id)).toContain(m.id)
          expect((await reopened.persistence.stat(m.id))?.header).toMatchObject(m)
          const reader = await reopened.persistence.open(m.id, 'read')
          expect(await reader.read()).toEqual([])
          await reader.close()
        } finally {
          await reopened.dispose()
        }
      } finally {
        await backend.dispose()
      }
    })

    it('freshness: reads started after an append resolves observe that prefix on any handle', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = meta('fresh')
        const writer = await persistence.create(m)
        await writer.append(oneTurnLog())

        const before = await persistence.open(m.id, 'read')
        expect(await before.read()).toEqual(oneTurnLog())

        await writer.append(secondTurn())
        // Both a pre-existing read handle and a freshly opened one observe the
        // append once it has resolved.
        expect((await before.read()).map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
        const after = await persistence.open(m.id, 'read')
        expect((await after.read()).map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
        await before.close()
        await after.close()
        await writer.close()
      } finally {
        await dispose()
      }
    })

    it('a fresh instance continues the stored log at the committed next-seq', async () => {
      const backend = await make()
      try {
        if (backend.reopen === undefined) return
        const m = meta('continue', '/work')
        const creator = await backend.persistence.create(m)
        await creator.append(oneTurnLog())
        await creator.close()

        const reopened = await backend.reopen()
        try {
          const writer = await reopened.persistence.open(m.id, 'write')
          await writer.append(secondTurn())
          expect((await writer.read()).map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
          await writer.close()
        } finally {
          await reopened.dispose()
        }
      } finally {
        await backend.dispose()
      }
    })

    it('append rejects a batch that does not contiguously continue the log, naming the expected seq', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = meta('contiguity')
        const handle = await persistence.create(m)
        await handle.append(oneTurnLog()) // seqs 0..5, next-seq = 6
        // A re-append of an already-stored seq is rejected, not duplicated.
        await expect(handle.append(oneTurnLog())).rejects.toThrow(/expected 6/)
        // A mid-batch gap is rejected as a whole.
        const gapped: SessionEvent[] = [
          { type: 'turn/start', seq: SessionSeq(6), time: 9, data: { turn: 2 } },
          { type: 'turn/end', seq: SessionSeq(8), time: 10, data: { turn: 2, reason: { kind: 'completed' } } },
        ]
        await expect(handle.append(gapped)).rejects.toThrow(/expected 7/)
        // Neither rejection changed the stored log.
        expect((await handle.read()).map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5])
        await handle.close()
      } finally {
        await dispose()
      }
    })

    it('append rejects non-JSON-serializable event data without storing anything', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = meta('non-json')
        const handle = await persistence.create(m)
        const bad = (extra: unknown): SessionEvent[] => [{
          type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1, extra },
        }] as unknown as SessionEvent[]
        await expect(handle.append(bad(1n))).rejects.toThrow(TypeError)
        await expect(handle.append(bad(1n))).rejects.toThrow(/losslessly JSON-serializable/)
        await expect(handle.append(bad(undefined))).rejects.toThrow(/losslessly JSON-serializable/)
        // The rejected batches left no events behind: seq 0 is still free.
        await handle.append(oneTurnLog())
        expect(await handle.read()).toEqual(oneTurnLog())
        await handle.close()
      } finally {
        await dispose()
      }
    })

    it('vocabulary fail-closed: an unknown stored event type refuses reads and write opens', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = meta('foreign-vocabulary')
        const handle = await persistence.create(m)
        // The append side is permissive — a newer producer's event type is
        // stored verbatim…
        await handle.append(oneTurnLog())
        await handle.append([
          { type: 'mystery/event', seq: SessionSeq(6), time: 7, data: { payload: true } },
        ] as unknown as SessionEvent[])
        await handle.close()

        // …but this build refuses to interpret the stored log: a write open
        // rejects, and a read handle (or its first read) rejects.
        await expect(persistence.open(m.id, 'write')).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
        // The failed write open released its ownership claim: retrying yields
        // the same refusal, never SessionAlreadyOwnedError.
        await expect(persistence.open(m.id, 'write')).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
        const readFailure = await persistence.open(m.id, 'read').then(
          async (reader) => {
            try {
              return await reader.read().then(() => undefined, (error: unknown) => error)
            } finally {
              await reader.close()
            }
          },
          (error: unknown) => error,
        )
        expect(readFailure).toBeInstanceOf(SessionFormatUnsupportedError)
        expect((readFailure as Error).message).toContain('mystery/event')
      } finally {
        await dispose()
      }
    })

    it('a torn physical tail is never served and is durably truncated by the write path', async () => {
      const backend = await make()
      try {
        if (backend.reopen === undefined || backend.corruptTail === undefined) return
        const m = meta('torn', '/work')
        const creator = await backend.persistence.create(m)
        await creator.append(oneTurnLog())
        await creator.close()
        await backend.corruptTail(m.id, m.cwd)

        // A reader over the corrupted artifact serves only the committed prefix.
        const readerInstance = await backend.reopen()
        try {
          const reader = await readerInstance.persistence.open(m.id, 'read')
          expect(await reader.read()).toEqual(oneTurnLog())
          await reader.close()

          // A write open + first append durably truncates the torn tail and
          // continues at the committed next-seq.
          const writer = await readerInstance.persistence.open(m.id, 'write')
          await writer.append(secondTurn())
          expect((await writer.read()).map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
          await writer.close()
        } finally {
          await readerInstance.dispose()
        }

        // The repaired log is intact for the next instance.
        const verifyInstance = await backend.reopen()
        try {
          const verify = await verifyInstance.persistence.open(m.id, 'read')
          expect((await verify.read()).map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
          await verify.close()
        } finally {
          await verifyInstance.dispose()
        }
      } finally {
        await backend.dispose()
      }
    })

    it('stat and list agree on stable revisions that change after an append', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = meta('revisions', '/work')
        const writer = await persistence.create(m)
        await writer.append(oneTurnLog())

        const statFirst = await persistence.stat(m.id)
        const statAgain = await persistence.stat(m.id)
        const listFirst = (await persistence.list()).find(s => s.header.id === m.id)
        expect(statFirst).toBeDefined()
        expect(statAgain?.revision).toBe(statFirst?.revision)
        expect(listFirst?.revision).toBe(statFirst?.revision)

        await writer.append(secondTurn())
        const statChanged = await persistence.stat(m.id)
        expect(statChanged?.revision).not.toBe(statFirst?.revision)
        const listChanged = (await persistence.list()).find(s => s.header.id === m.id)
        expect(listChanged?.revision).toBe(statChanged?.revision)

        // Snapshot headers carry the stored header, identically everywhere.
        const reader = await persistence.open(m.id, 'read')
        expect(statChanged?.header).toEqual(reader.header)
        expect(listChanged?.header).toEqual(reader.header)
        expect(statChanged?.header).toMatchObject(m)
        await reader.close()
        await writer.close()

        expect(await persistence.stat(SessionId('absent-stat'))).toBeUndefined()
      } finally {
        await dispose()
      }
    })
  })
}
