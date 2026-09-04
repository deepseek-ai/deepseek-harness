import { describe, expect, it } from 'vitest'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { SessionAssistantStreamAccumulator } from '../src/assistant-stream.ts'

describe('SessionAssistantStreamAccumulator', () => {
  it('replaces stale lifecycles, rejects frame gaps, and caches each baseline', () => {
    const accumulator = new SessionAssistantStreamAccumulator()
    const empty = accumulator.snapshot()
    expect(accumulator.snapshot()).toBe(empty)

    accumulator.accept({
      type: 'start', attemptId: LlmAttemptId('stale'), revision: 2, turn: 1, step: 1,
    }, -1)
    expect(accumulator.snapshot()).toEqual({ revision: 2 })

    accumulator.accept({
      type: 'start', attemptId: LlmAttemptId('current'), revision: 1, turn: 2, step: 3,
    }, SessionSeq(5))
    expect(accumulator.snapshot()).toMatchObject({
      revision: 1,
      activeAttempt: {
        attemptId: 'current', startedAfterSeq: 5, turn: 2, step: 3, nextIndex: 0, stream: [],
      },
    })

    accumulator.accept({
      type: 'chunk', attemptId: LlmAttemptId('other'), revision: 2, index: 0,
      time: 4, chunk: { type: 'text-delta', index: 0, text: 'lost' },
    }, SessionSeq(5))
    expect(accumulator.snapshot()).toEqual({ revision: 2 })

    accumulator.accept({
      type: 'start', attemptId: LlmAttemptId('settled'), revision: 3, turn: 2, step: 4,
    }, SessionSeq(8))
    accumulator.accept({
      type: 'chunk', attemptId: LlmAttemptId('settled'), revision: 4, index: 0,
      time: 5, chunk: { type: 'text-delta', index: 0, text: 'ok' },
    }, SessionSeq(8))
    const active = accumulator.snapshot()
    expect(active).toMatchObject({
      revision: 4,
      activeAttempt: {
        attemptId: 'settled', startedAfterSeq: 8, nextIndex: 1,
        stream: [{ type: 'text-chunks', time0: 5, index: 0, dt: [], texts: ['ok'] }],
      },
    })
    expect(accumulator.snapshot()).toBe(active)

    accumulator.accept({
      type: 'end', attemptId: LlmAttemptId('settled'), revision: 5, index: 1,
      outcome: { kind: 'abandoned' },
    }, SessionSeq(9))
    expect(accumulator.snapshot()).toEqual({ revision: 5 })
  })
})
