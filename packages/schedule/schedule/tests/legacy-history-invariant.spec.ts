/**
 * The Schedule `session/created` listener must not veto Session creation when a historical
 * `schedule/change` stream is unreadable. This suite excludes the package invariant companion
 * on purpose: the companion owns the failure signal and rejects the stream before this
 * listener runs, so only a companion-free topology can observe the listener's warn-and-continue
 * behavior for a bad historical stream.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { harness } from './harness.ts'

const tests: Awaited<ReturnType<typeof harness>>[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-16T00:00:00Z')) })
afterEach(async () => {
  await Promise.all(tests.splice(0).map(test => test.ctx.fiber.dispose()))
  vi.useRealTimers()
})

/** Build one seeded historical Schedule event, including deliberately unreadable payloads. */
function scheduleEvent(data: unknown, seq: number): SessionEvent {
  return { type: 'schedule/change', seq: SessionSeq(seq), time: Date.now(), data } as SessionEvent
}

describe('unreadable legacy Schedule history', () => {
  it.each([
    {
      label: 'a malformed schedule/change event',
      data: { version: 1, operation: 'create', schedule: {} },
      reason: 'v1 schedule kind must be',
    },
    {
      label: 'a transition-invalid schedule/change event',
      data: { version: 1, operation: 'delete', id: 'schedule-inactive' },
      reason: 'schedule delete targets inactive id',
    },
  ])('keeps the Session attached and warns for $label', async ({ data, reason }) => {
    const test = await harness()
    tests.push(test)
    const warning = vi.spyOn(test.ctx.logger, 'warn')
    const sessionId = SessionId('legacy-unreadable')
    const session = test.ctx.sessions.create(sessionId, { seed: [scheduleEvent(data, 0)] })
    expect(test.ctx.sessions.get(sessionId)).toBe(session)
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(`Session "${sessionId}"`))
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('historical events could not be read'))
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(reason))
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('the legacy reminder is ignored'))
    expect(await test.service.catalog()).toEqual([])
    expect(await test.service.list({ sessionId })).toEqual([])
  })
})
