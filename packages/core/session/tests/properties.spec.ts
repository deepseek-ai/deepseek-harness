/**
 * Property-based tests for the Session event log (the property-testing Agent Note).
 *
 * Generates arbitrary event logs and asserts the derivation invariants the
 * agent loop and replay depend on: deriveMessages is deterministic and
 * replay-from-seed reproduces it; seq is strictly monotonic; non-message
 * events never affect derived history.
 */

import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { createUserMessage, ToolCallId , createMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEventMap, SessionEventType, SurfaceIntent } from '@deepseek-ai/dsh-session'

// Each arbitrary supplies its own surface intent; `build` must not synthesize
// one or the property would fail to exercise malformed fixture choices.
type Appendable = {
  [T in SessionEventType]: { type: T; data: SessionEventMap[T]; intent?: SurfaceIntent }
}[SessionEventType]

const textContentArb = fc.array(
  fc.record({ type: fc.constant<'text'>('text'), text: fc.string() }),
  { maxLength: 3 },
)

// A message-producing event (these DO affect derived history). Each carries an
// explicit `surfaceOp: 'append'` intent — the marker the real loop passes.
const messageEventArb: fc.Arbitrary<Appendable> = fc.oneof(
  textContentArb.map((content): Appendable => ({ type: 'user/message', data: createUserMessage({
    content, source: { kind: 'user' },
  }), intent: { surfaceOp: 'append' } })),
  textContentArb.map((content): Appendable => ({
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content,
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    },
    intent: { surfaceOp: 'append' },
  })),
  textContentArb.map((content): Appendable => ({
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content,
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    intent: { surfaceOp: 'append' },
  })),
  fc.record({ id: fc.string({ minLength: 1 }), content: textContentArb, isError: fc.boolean() })
    .map((r): Appendable => ({ type: 'tool/result', data: {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: ToolCallId(r.id),
        content: r.content,
        isError: r.isError,
      }),
    }, intent: { surfaceOp: 'append' } })),
)

// A non-message event (trace/replay data — must NOT affect derived history).
const nonMessageEventArb: fc.Arbitrary<Appendable> = fc.oneof(
  fc.constant<Appendable>({ type: 'turn/start', data: { turn: 1 } }),
  fc.constant<Appendable>({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }),
  fc.constant<Appendable>({ type: 'step/start', data: { turn: 1, step: 1 } }),
  fc.constant<Appendable>({ type: 'step/end', data: { turn: 1, step: 1 } }),
  fc.string().map((text): Appendable => ({ type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } } })),
)

const anyEventArb = fc.oneof(messageEventArb, nonMessageEventArb)
const logArb = fc.array(anyEventArb, { maxLength: 25 })

let counter = 0
function build(events: Appendable[]): Session {
  const session = Session.create(SessionId(`prop-${counter++}`))
  for (const e of events) {
    // Forward the generated intent verbatim; non-surface events carry none.
    if (e.intent !== undefined) session.append(e.type, e.data, e.intent)
    else session.append(e.type, e.data)
  }
  return session
}

describe('Session properties', () => {
  it('deriveMessages is deterministic (same log → identical derivation)', () => {
    fc.assert(fc.property(logArb, (events) => {
      const a = build(events)
      expect(a.deriveMessages()).toEqual(a.deriveMessages())
    }))
  })

  it('seq is strictly monotonic and zero-based contiguous', () => {
    fc.assert(fc.property(logArb, (events) => {
      const session = build(events)
      session.snapshotEvents().forEach((event, i) => { expect(event.seq).toBe(i) })
      expect(session.seq).toBe(events.length)
    }))
  })

  it('replay-from-seed reproduces the derivation identically', () => {
    fc.assert(fc.property(logArb, (events) => {
      const original = build(events)
      const replayed = Session.create(SessionId(`replay-${counter++}`), original.snapshotEvents())
      expect(replayed.deriveMessages()).toEqual(original.deriveMessages())
      // Every explicit replay grows by exactly one log-only boundary.
      expect(replayed.snapshotEvents().slice(0, original.seq)).toEqual(original.snapshotEvents())
      expect(replayed.seq).toBe(original.seq + 1)
    }))
  })

  it('replaying a log that already ends in end-seed adds no further marker', () => {
    fc.assert(fc.property(logArb, (events) => {
      const original = build(events)
      const once = Session.create(SessionId(`idem-a-${counter++}`), original.snapshotEvents())
      const twice = Session.create(SessionId(`idem-b-${counter++}`), once.snapshotEvents())
      // Lazy resume makes browsing a pickup, so this must not grow per open.
      expect(twice.snapshotEvents()).toEqual(once.snapshotEvents())
    }))
  })

  it('non-message events never affect derived history (any interleaving)', () => {
    fc.assert(fc.property(
      fc.array(messageEventArb, { maxLength: 12 }),
      fc.array(nonMessageEventArb, { maxLength: 12 }),
      // An arbitrary merge of the two streams that PRESERVES each stream's
      // relative order (a random interleaving, not a fixed alternation).
      fc.infiniteStream(fc.boolean()),
      (messages, noise, pick) => {
        const clean = build(messages).deriveMessages()
        const interleaved: Appendable[] = []
        let mi = 0
        let ni = 0
        const picker = pick[Symbol.iterator]()
        while (mi < messages.length || ni < noise.length) {
          // take from noise when chosen and available, else from messages
          const takeNoise = ni < noise.length && (mi >= messages.length || picker.next().value === true)
          if (takeNoise) { interleaved.push(noise[ni]!); ni++ }
          else { interleaved.push(messages[mi]!); mi++ }
        }
        const withNoise = build(interleaved).deriveMessages()
        expect(withNoise).toEqual(clean)
      },
    ))
  })

  it('every derived message has a known role and is frozen (append-only contract)', () => {
    fc.assert(fc.property(logArb, (events) => {
      const session = build(events)
      const messages = session.deriveMessages()
      const before = structuredClone(session.snapshotEvents())
      for (const m of messages) {
        expect(['user', 'assistant', 'system']).toContain(m.role)
        // Derived messages are frozen shared projections: mutation THROWS
        // (strict mode) instead of relying on per-call clones for isolation.
        expect(Object.isFrozen(m)).toBe(true)
        expect(() => { m.content.push({ type: 'text', text: 'mutation' }) }).toThrow(TypeError)
      }
      expect(session.snapshotEvents()).toEqual(before)
    }))
  })
})
