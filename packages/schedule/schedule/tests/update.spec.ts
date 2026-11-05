/** Every timing kind uses one record construction and edit path. */
import { expect, it } from 'vitest'
import { ScheduleId } from '../src/domain.ts'
import { createScheduleRecord, updateScheduleRecord } from '../src/update.ts'
import type { ScheduleTiming } from '../src/types.ts'

const now = Date.parse('2026-09-16T00:00:00.125Z')
const id = ScheduleId('unchanged-identity')
const timings: ScheduleTiming[] = [
  { kind: 'after', after_seconds: 61 },
  { kind: 'at', at: '2026-09-17T01:00:00.123Z' },
  { kind: 'every', every_seconds: 300 },
  { kind: 'daily', daily: { time: '09:00:00.123', time_zone: 'UTC' } },
  { kind: 'weekly', weekly: { time: '09:00:00.123', time_zone: 'UTC', weekdays: [1, 5] } },
  { kind: 'cron', cron: { expression: '0 9 * * 1-5', time_zone: 'UTC' } },
  { kind: 'rrule', rrule: 'DTSTART:20260916T010000Z\nRRULE:FREQ=DAILY' },
]
const expiredTimings: ScheduleTiming[] = [
  { kind: 'after', after_seconds: 61 },
  { kind: 'at', at: '2026-09-17T01:00:00.123Z' },
  { kind: 'rrule', rrule: 'DTSTART:20260916T010000Z\nRRULE:FREQ=DAILY;COUNT=1' },
]

it.each(timings.flatMap(from => timings.map(to => ({ from, to }))))('edits $from.kind to $to.kind without changing identity', ({ from, to }) => {
  const current = createScheduleRecord(id, 'Title', 'Prompt', from, now)
  const expected = createScheduleRecord(id, 'New title', 'New prompt', to, now)
  expect(updateScheduleRecord(current, { title: ' New title ', prompt: ' New prompt ', timing: to }, now, false)).toEqual(expected)
})

it.each(timings)('retains $kind timing on a descriptive edit after its committed target', (timing) => {
  const current = createScheduleRecord(id, 'Title', 'Prompt', timing, now)
  expect(updateScheduleRecord(current, { title: 'Renamed' }, now + 86_400_000, false))
    .toEqual({ ...current, title: 'Renamed' })
})

it.each([
  { title: '' }, { title: 'x'.repeat(121) }, { prompt: '' },
  { title: 1 }, { prompt: null },
  { timing: null }, { timing: [] }, { timing: { kind: 'unknown' } },
  { timing: { kind: 'cron', cron: { expression: '* * * * *', time_zone: 'UTC' }, rrule: 'ignored' } },
])('rejects an invalid patch %j before changing any rule', (patch) => {
  const current = createScheduleRecord(id, 'Title', 'Prompt', timings[2]!, now)
  expect(() => updateScheduleRecord(current, patch as never, now, false)).toThrow()
})

it('re-arms an unchanged recurrence only on an explicit resume', () => {
  const current = createScheduleRecord(id, 'Title', 'Prompt', timings[2]!, now)
  expect(updateScheduleRecord(current, { active: true }, now + 86_400_000, true).scheduledAt)
    .toBe('2026-09-17T00:05:00.125Z')
})

it.each(expiredTimings.flatMap(timing => [false, true].map(includeTiming => ({ timing, includeTiming }))))(
  'requires a future schedule to resume expired $timing.kind (timing supplied: $includeTiming)', ({ timing, includeTiming }) => {
    const current = createScheduleRecord(id, 'Title', 'Prompt', timing, now)
    const unchanged = timing.kind === 'after' ? { kind: 'at' as const, at: current.scheduledAt } : timing
    const patch = { active: true, ...includeTiming ? { timing: unchanged } : {} }
    expect(() => updateScheduleRecord(current, patch, now + 2 * 86_400_000, true)).toThrow(expect.objectContaining({
      code: 'not_future', message: 'This task has no future occurrence. Set a future schedule before resuming it.',
    }))
  })

it.each(expiredTimings)('retains expired $kind timing on a descriptive edit and accepts a future replacement', (timing) => {
  const current = createScheduleRecord(id, 'Title', 'Prompt', timing, now)
  const later = now + 2 * 86_400_000
  expect(updateScheduleRecord(current, { title: 'Renamed' }, later, false)).toEqual({ ...current, title: 'Renamed' })
  const at = new Date(later + 60_000).toISOString()
  expect(updateScheduleRecord(current, { active: true, timing: { kind: 'at', at } }, later, true))
    .toEqual({ id, kind: 'at', title: 'Title', prompt: 'Prompt', scheduledAt: at })
})

it('keeps the committed delay target on no-op and prompt-only edits', () => {
  const current = createScheduleRecord(id, 'Title', 'Prompt', expiredTimings[0]!, now)
  const later = now + 2 * 86_400_000
  expect(updateScheduleRecord(current, { prompt: ' Prompt ' }, later, false)).toBe(current)
  expect(updateScheduleRecord(current, { prompt: 'New prompt' }, later, false)).toEqual({ ...current, prompt: 'New prompt' })
})

it('uses an explicit relative delay as new timing when resuming', () => {
  const timing = expiredTimings[0]!
  const current = createScheduleRecord(id, 'Title', 'Prompt', timing, now)
  const later = now + 2 * 86_400_000
  expect(updateScheduleRecord(current, { active: true, timing }, later, true))
    .toEqual(createScheduleRecord(id, 'Title', 'Prompt', timing, later))
})

it('resumes an exhausted RRULE when a replacement has a future occurrence', () => {
  const current = createScheduleRecord(id, 'Title', 'Prompt', expiredTimings[2]!, now)
  const rrule = 'DTSTART:20260920T010000Z\nRRULE:FREQ=DAILY;COUNT=1'
  expect(updateScheduleRecord(current, { active: true, timing: { kind: 'rrule', rrule } }, now + 2 * 86_400_000, true))
    .toMatchObject({ kind: 'rrule', scheduledAt: '2026-09-20T01:00:00.000Z' })
})

it('keeps a rule-validation error when resuming with an invalid replacement', () => {
  const current = createScheduleRecord(id, 'Title', 'Prompt', expiredTimings[2]!, now)
  expect(() => updateScheduleRecord(current, { active: true, timing: { kind: 'rrule', rrule: 'RRULE:FREQ=DAILY' } }, now, true))
    .toThrow(expect.objectContaining({ code: 'invalid_rule', message: 'rrule must contain one DTSTART line followed by one RRULE line.' }))
})

it.each([false, true])('keeps the original error for an explicit past timing replacement (resume: %s)', (resume) => {
  const current = createScheduleRecord(id, 'Title', 'Prompt', timings[2]!, now)
  expect(() => updateScheduleRecord(current, { timing: { kind: 'at', at: new Date(now).toISOString() } }, now, resume))
    .toThrow(expect.objectContaining({ code: 'not_future', message: 'The scheduled time must be strictly in the future.' }))
})
