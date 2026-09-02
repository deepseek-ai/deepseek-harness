/**
 * Unit tests for the backend-shared storage validation helpers and the
 * stable error vocabulary.
 */

import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionFormatUnsupportedError,
  SessionHandleClosedError,
  SessionOwnershipLostError,
  SessionPersistenceCorruptionError,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  SessionReadOnlyError,
  assertContiguous,
  assertStoredId,
  assertVersion,
  materializeAppendBatch,
  sessionFormatVersionRefusal,
  validateStoredEvents,
} from '../src/index.ts'
import type { SessionLocation } from '../src/index.ts'
import { meta } from './contract.ts'

const LOCATION: SessionLocation = { kind: 'jsonl', path: '/store/session.jsonl' }

/** A stored user/message event with a well-formed identified message. */
function userMessage(seq: number): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: seq + 1,
    data: {
      id: 'stored-user',
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  } as unknown as SessionEvent
}

describe('assertStoredId', () => {
  it('accepts a bound header and names both ids on a mismatch', () => {
    const m = meta('bound')
    expect(() => { assertStoredId(m.id, m) }).not.toThrow()
    expect(() => { assertStoredId(SessionId('requested'), m) })
      .toThrow('stored session identity mismatch: requested "requested", header contains "bound"')
  })
})

describe('assertVersion', () => {
  it('accepts the current format version', () => {
    expect(() => { assertVersion(meta('current')) }).not.toThrow()
  })

  it('refuses a newer version with the upgrade direction and the artifact location', () => {
    const newer = { ...meta('newer'), version: SESSION_FORMAT_VERSION + 42 }
    let refusal: unknown
    try {
      assertVersion(newer, LOCATION)
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(SessionFormatUnsupportedError)
    expect((refusal as Error).message).toContain('written by a newer harness — upgrade the harness to open it')
    expect((refusal as Error).message).toContain(`(raw log: ${LOCATION.path})`)
    expect((refusal as SessionFormatUnsupportedError).location).toBe(LOCATION)
  })

  it('refuses an older version without a location suffix when the backend has no artifact', () => {
    const older = { ...meta('older'), version: SESSION_FORMAT_VERSION - 1 }
    let refusal: unknown
    try {
      assertVersion(older)
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(SessionFormatUnsupportedError)
    expect((refusal as Error).message).toBe(sessionFormatVersionRefusal('older', SESSION_FORMAT_VERSION - 1))
    expect((refusal as Error).message).toContain('this build ships no upgrade path for it')
    expect((refusal as Error).message).not.toContain('raw log')
    expect((refusal as SessionFormatUnsupportedError).location).toBeUndefined()
  })
})

describe('sessionFormatVersionRefusal', () => {
  it('states the direction for newer and older stored versions', () => {
    expect(sessionFormatVersionRefusal('s', SESSION_FORMAT_VERSION + 1))
      .toBe(`session "s" uses log format v${SESSION_FORMAT_VERSION + 1}, but this harness reads only v${SESSION_FORMAT_VERSION}: the log was written by a newer harness — upgrade the harness to open it`)
    expect(sessionFormatVersionRefusal('s', SESSION_FORMAT_VERSION - 1))
      .toBe(`session "s" uses log format v${SESSION_FORMAT_VERSION - 1}, older than the supported v${SESSION_FORMAT_VERSION}, and this build ships no upgrade path for it`)
  })
})

describe('validateStoredEvents', () => {
  it('adopts and freezes the events in place, returning the same array', () => {
    const m = meta('adopted')
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      userMessage(1),
    ] as SessionEvent[]
    const validated = validateStoredEvents(m, events)
    expect(validated).toBe(events)
    expect(Object.isFrozen(validated[1]!.data)).toBe(true)
  })

  it('adopts a merge-extended turn/end reason outside the closed built-in set', () => {
    const m = meta('extended-reason')
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'plugin/custom-outcome' } } },
    ] as SessionEvent[]
    expect(validateStoredEvents(m, events)).toBe(events)
  })

  it('refuses an unknown event type before adopting anything', () => {
    const m = meta('unknown-type')
    const events = [
      { type: 'mystery/event', seq: 0, time: 1, data: {} },
    ] as unknown as SessionEvent[]
    expect(() => validateStoredEvents(m, events)).toThrow(SessionFormatUnsupportedError)
    expect(() => validateStoredEvents(m, events)).toThrow(
      'session "unknown-type" contains event type "mystery/event" (seq 0) unknown to this harness',
    )
    // With an artifact, the refusal points at the raw log.
    let refusal: unknown
    try {
      validateStoredEvents(m, events, LOCATION)
    } catch (error) {
      refusal = error
    }
    expect((refusal as Error).message).toContain(`(raw log: ${LOCATION.path})`)
    expect((refusal as SessionFormatUnsupportedError).location).toBe(LOCATION)
  })

  it('retains an unknown event type its writer marked ignorable', () => {
    const m = meta('ignorable-unknown')
    const events = [
      { type: 'foreign/telemetry', seq: 0, time: 1, data: {}, ignorable: true },
    ] as unknown as SessionEvent[]
    expect(validateStoredEvents(m, events)).toBe(events)
    expect(events[0]).toMatchObject({ type: 'foreign/telemetry', ignorable: true })
  })

  it('refuses the retired request/header "fallback" reason while accepting current headers', () => {
    const m = meta('retired-reason')
    const retired = [
      {
        type: 'request/header',
        seq: 0,
        time: 1,
        data: { header: { config: { provider: 'mock', model: 'legacy' } }, reason: 'fallback' },
      },
    ] as unknown as SessionEvent[]
    expect(() => validateStoredEvents(m, retired)).toThrow(SessionFormatUnsupportedError)
    expect(() => validateStoredEvents(m, retired)).toThrow(
      'session "retired-reason" contains a request/header event (seq 0) with the unsupported legacy reason "fallback"',
    )

    const current = [
      {
        type: 'request/header',
        seq: 0,
        time: 1,
        data: { header: { config: { provider: 'mock', model: 'current' } }, reason: 'initial' },
      },
    ] as unknown as SessionEvent[]
    expect(validateStoredEvents(m, current)).toBe(current)
  })

  it('wraps a record validation failure as corruption with its cause', () => {
    const m = meta('damaged')
    const events = [
      {
        type: 'user/message',
        seq: 0,
        time: 1,
        // No identified message: adoption refuses the record.
        data: { role: 'user', content: [], source: { kind: 'user' } },
      },
    ] as unknown as SessionEvent[]
    let failure: unknown
    try {
      validateStoredEvents(m, events)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(SessionPersistenceCorruptionError)
    expect((failure as Error).message).toContain('stored session "damaged" failed validation')
    expect((failure as Error).message).toContain('lacks an identified message')
    expect((failure as Error).cause).toBeInstanceOf(Error)
  })

  it('passes an adoption-side format refusal through unwrapped', () => {
    // The adoption step may itself refuse a record as unsupported rather than
    // damaged; such a refusal must reach the caller as-is, never rebranded as
    // corruption.
    const m = meta('adoption-refusal')
    const passthrough = new SessionFormatUnsupportedError('refused during adoption')
    const trap = {
      type: 'user/message',
      seq: 0,
      time: 1,
      get data(): never {
        throw passthrough
      },
    } as unknown as SessionEvent
    expect(() => validateStoredEvents(m, [trap])).toThrow(passthrough)
  })
})

describe('materializeAppendBatch', () => {
  it('returns a detached lossless-JSON snapshot of the batch', () => {
    const original = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    ] as SessionEvent[]
    const batch = materializeAppendBatch(original)
    expect(batch).not.toBe(original)
    expect(batch).toEqual(original)
    // The snapshot is detached: mutating the caller's batch afterwards cannot
    // change what a backend persists.
    ;(original[0]!.data as { turn: number }).turn = 99
    expect((batch[0]!.data as { turn: number }).turn).toBe(1)
  })

  it('rejects every non-JSON value, not only BigInt', () => {
    // Every value `snapshotJsonValue` refuses must be refused here — a backend
    // passing this helper cannot accept values that corrupt the durable
    // round-trip.
    const cyclic: Record<string, unknown> = { type: 'text', text: 'x' }
    cyclic['self'] = cyclic
    const badValues: unknown[] = [
      1n,                  // BigInt
      undefined,           // dropped by JSON.stringify
      Infinity,            // → null
      () => 0,             // function
      Symbol('s'),         // symbol
      new Map(),           // exotic object
      cyclic,              // circular ref
    ]
    for (const bad of badValues) {
      const events = [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, extra: bad } },
      ] as unknown as SessionEvent[]
      expect(() => materializeAppendBatch(events)).toThrow(TypeError)
      expect(() => materializeAppendBatch(events)).toThrow(/losslessly JSON-serializable/)
    }
  })
})

describe('assertContiguous', () => {
  it('accepts a batch continuing exactly at the cursor', () => {
    const events = [
      { type: 'turn/start', seq: 6, time: 1, data: { turn: 2 } },
      { type: 'turn/end', seq: 7, time: 2, data: { turn: 2, reason: { kind: 'completed' } } },
    ] as SessionEvent[]
    expect(() => { assertContiguous(SessionId('ok'), events, 6) }).not.toThrow()
    expect(() => { assertContiguous(SessionId('ok'), [], 6) }).not.toThrow()
  })

  it('names the expected seq for a stale batch and for a mid-batch gap', () => {
    const stale = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    ] as SessionEvent[]
    expect(() => { assertContiguous(SessionId('stale'), stale, 6) })
      .toThrow('append seq mismatch for "stale": expected 6 at index 0, got 0')

    const gapped = [
      { type: 'turn/start', seq: 6, time: 1, data: { turn: 2 } },
      { type: 'turn/end', seq: 8, time: 2, data: { turn: 2, reason: { kind: 'completed' } } },
    ] as SessionEvent[]
    expect(() => { assertContiguous(SessionId('gapped'), gapped, 6) })
      .toThrow('append seq mismatch for "gapped": expected 7 at index 1, got 8')
  })
})

describe('error vocabulary', () => {
  it('carries stable names, messages, and the session id', () => {
    const id = SessionId('errored')
    const notFound = new SessionPersistenceNotFoundError(id)
    expect(notFound.name).toBe('SessionPersistenceNotFoundError')
    expect(notFound.sessionId).toBe(id)
    expect(notFound.message).toBe('session "errored" not found')

    const exists = new SessionAlreadyExistsError(id)
    expect(exists.name).toBe('SessionAlreadyExistsError')
    expect(exists.message).toBe('session "errored" already exists')

    const owned = new SessionAlreadyOwnedError(id)
    expect(owned.name).toBe('SessionAlreadyOwnedError')
    expect(owned.message).toBe('session "errored" is already owned by an active write handle')

    const readOnly = new SessionReadOnlyError(id, 'append')
    expect(readOnly.name).toBe('SessionReadOnlyError')
    expect(readOnly.message).toBe('session "errored": append is not available on a read handle')

    const lost = new SessionOwnershipLostError(id)
    expect(lost.name).toBe('SessionOwnershipLostError')
    expect(lost.message).toBe('session "errored": write ownership was lost; close this handle and reopen')

    const closed = new SessionHandleClosedError(id, 'flush')
    expect(closed.name).toBe('SessionHandleClosedError')
    expect(closed.message).toBe('session "errored": flush on a closed handle')

    const cause = new Error('detail')
    const corruption = new SessionPersistenceCorruptionError('bad log', { cause })
    expect(corruption.name).toBe('SessionPersistenceCorruptionError')
    expect(corruption.cause).toBe(cause)
  })
})

describe('SessionPersistenceRevision', () => {
  it('brands the backend token without changing its runtime value', () => {
    expect(SessionPersistenceRevision('rev:1')).toBe('rev:1')
  })
})
