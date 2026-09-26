/** Pure timing edits accept every recurrence kind, compute creation targets, and preserve targets for normalized no-ops. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as domain from '../src/domain.ts'
import { resolveScheduleUpdate, retainedTitle } from '../src/update.ts'
import type { ScheduleRecord, ScheduleTimingChange, ScheduleToolError, ScheduleUpdateContent } from '../src/types.ts'

const now = Date.parse('2026-09-16T00:00:00.125Z')
const id = domain.ScheduleId('timing')
const prompt = 'Keep exact prompt\nwith details'
/** Title every stored record carries; it is the instruction's first line, supplied at creation. */
const storedTitle = 'Keep exact prompt'
const after = domain.createAfterScheduleRecord(id, prompt, 60, now, storedTitle)
const at = domain.createAtScheduleRecord(id, prompt, '2026-09-16T01:00:00.125Z', now, storedTitle)
const every = domain.createEveryScheduleRecord(id, prompt, 300, now, storedTitle)
const daily = domain.createDailyScheduleRecord(id, prompt, { time: '09:00:00.125', time_zone: 'US/Eastern' }, now, storedTitle)
const weekly = domain.createWeeklyScheduleRecord(id, prompt, {
  time: '09:00:00.125', time_zone: 'US/Eastern', weekdays: [1, 3],
}, now, storedTitle)
const cron = domain.createCronScheduleRecord(id, prompt, {
  expression: '0 9 * * 1-5', time_zone: 'US/Eastern',
}, now, storedTitle)
afterEach(() => vi.restoreAllMocks())

function update(current: ScheduleRecord, change: ScheduleTimingChange, acceptedAt = now) {
  return resolveScheduleUpdate(current, current, change, acceptedAt)
}

/** Target changes covering every kind a timing change can select. */
const targetChanges: Record<'at' | 'every' | 'daily' | 'weekly' | 'cron', ScheduleTimingChange> = {
  at: { kind: 'at', at: '2026-09-20T10:30:00.321+08:00' },
  every: { kind: 'every', every_seconds: 600 },
  daily: { kind: 'daily', daily: { time: '08:00:00.125', time_zone: 'Asia/Shanghai' } },
  weekly: { kind: 'weekly', weekly: { time: '07:00:00.125', time_zone: 'Asia/Shanghai', weekdays: [2, 5] } },
  cron: { kind: 'cron', cron: { expression: '0 7 * * 2,5', time_zone: 'Asia/Shanghai' } },
}

/** Recompute the record creation itself would produce from the same accepted save time. */
function createdFrom(change: ScheduleTimingChange): ScheduleRecord {
  switch (change.kind) {
    case 'at': return domain.createAtScheduleRecord(id, prompt, change.at, now, storedTitle)
    case 'every': return domain.createEveryScheduleRecord(id, prompt, change.every_seconds, now, storedTitle)
    case 'daily': return domain.createDailyScheduleRecord(id, prompt, change.daily, now, storedTitle)
    case 'weekly': return domain.createWeeklyScheduleRecord(id, prompt, change.weekly, now, storedTitle)
    case 'cron': return domain.createCronScheduleRecord(id, prompt, change.cron, now, storedTitle)
  }
}

const storedRecords: ScheduleRecord[] = [after, at, every, daily, weekly, cron]
const transitions = storedRecords.flatMap(current => Object.keys(targetChanges)
  .map(kind => [current.kind, kind, current] as const))

it.each(transitions)('converts a %s task to a %s rule with the creation target, identity, and prompt', (storedKind, kind, current) => {
  expect(storedKind).toBe(current.kind)
  const change = targetChanges[kind as keyof typeof targetChanges]
  const result = update(current, change)
  expect(result).toEqual({ id, updated: true, record: createdFrom(change) })
  if (!('record' in result)) throw new Error('Expected a new record')
  expect(result.record).toMatchObject({ id, prompt, kind })
  expect(Date.parse(result.record.scheduledAt)).toBeGreaterThan(now)
})

it('does not treat a cross-kind change to the committed instant as a no-op', () => {
  for (const current of [every, daily, weekly, cron]) {
    expect(update(current, { kind: 'at', at: current.scheduledAt }))
      .toEqual({ id, updated: true, record: domain.createAtScheduleRecord(id, prompt, current.scheduledAt, now, storedTitle) })
  }
})

it('refuses a stale snapshot before applying a cross-kind timing change', () => {
  expect(resolveScheduleUpdate(every, { ...every, everySeconds: 600 }, targetChanges.daily, now))
    .toEqual({ id, updated: false, code: 'schedule_conflict' })
  expect(resolveScheduleUpdate(every, daily, targetChanges.weekly, now))
    .toEqual({ id, updated: false, code: 'schedule_conflict' })
})

it.each([after, at])('converts changed $kind targets to at without changing identity or prompt', (current) => {
  expect(update(current, { kind: 'at', at: '2026-09-16T10:30:00.321+08:00' })).toEqual({
    id, updated: true, record: { id, kind: 'at', title: storedTitle, prompt, scheduledAt: '2026-09-16T02:30:00.321Z' },
  })
  expect(update(current, { kind: 'at', at: { date: '2026-09-16', time: '10:30:00.321', time_zone: 'Asia/Shanghai' } }))
    .toEqual({
      id, updated: true, record: { id, kind: 'at', title: storedTitle, prompt, scheduledAt: '2026-09-16T02:30:00.321Z' },
    })
})

it.each([after, at])('retains original $kind fields when the equivalent target is already due', (current) => {
  const localTime = current.kind === 'after' ? '08:01:00.125' : '09:00:00.125'
  for (const input of [current.scheduledAt, `2026-09-16T${localTime}+08:00`, {
    date: '2026-09-16', time: localTime, time_zone: 'Asia/Shanghai',
  }]) {
    const result = update(current, { kind: 'at', at: input }, Date.parse('2026-09-17T00:00:00Z'))
    expect(result).toEqual({ id, updated: false, record: current })
    if (!('record' in result)) throw new Error('Expected unchanged record')
    expect(result.record).toBe(current)
  }
})

it('reanchors changed every intervals at the save sample but never moves an unchanged interval', () => {
  expect(update(every, { kind: 'every', every_seconds: 600 }, now + 75_000)).toEqual({
    id, updated: true, record: { ...every, everySeconds: 600, scheduledAt: '2026-09-16T00:11:15.125Z' },
  })
  expect(update(every, { kind: 'every', every_seconds: 300 }, now + 900_000))
    .toEqual({ id, updated: false, record: every })
})

it('changes daily time and zone, preserving milliseconds and choosing the first strictly future date', () => {
  expect(update(daily, { kind: 'daily', daily: { time: '08:00:00.125', time_zone: 'Asia/Shanghai' } })).toEqual({
    id, updated: true, record: {
      id, kind: 'daily', title: storedTitle, prompt, time: '08:00:00.125', timeZone: 'Asia/Shanghai',
      scheduledAt: '2026-09-17T00:00:00.125Z',
    },
  })
})

it.each([
  [{ time: '10:00:00.125', time_zone: 'America/New_York' }, '2026-09-16T14:00:00.125Z'],
  [{ time: '09:00:00.125', time_zone: 'UTC' }, '2026-09-16T09:00:00.125Z'],
] as const)('changes daily time or zone independently without changing identity (%j)', (input, scheduledAt) => {
  expect(update(daily, { kind: 'daily', daily: input })).toMatchObject({
    id, updated: true, record: { id, kind: 'daily', prompt, scheduledAt },
  })
})

it('keeps exact stored zone spelling and committed target for equivalent daily selectors', () => {
  const current: ScheduleRecord = { ...daily, timeZone: 'US/Eastern', time: '09:00:00.100', scheduledAt: at.scheduledAt }
  expect(update(current, { kind: 'daily', daily: { time: '09:00:00.1', time_zone: 'America/New_York' } }, now + 86_400_000))
    .toEqual({ id, updated: false, record: current })
})

it.each([
  ['2026-03-08T00:00:00Z', '02:30:00', '2026-03-09T06:30:00.000Z'],
  ['2026-11-01T00:00:00Z', '01:30:00', '2026-11-01T05:30:00.000Z'],
])('uses existing gap/overlap semantics at %s', (acceptedAt, time, scheduledAt) => {
  expect(update(daily, { kind: 'daily', daily: { time, time_zone: 'America/New_York' } }, Date.parse(acceptedAt)))
    .toMatchObject({ updated: true, record: { scheduledAt } })
})

it('accepts reordered expected keys while comparing every field', () => {
  const reordered = Object.fromEntries(Object.entries(daily).reverse()) as ScheduleRecord
  expect(resolveScheduleUpdate(daily, reordered, { kind: 'daily', daily: { time: '10:00:00', time_zone: 'UTC' } }, now))
    .toMatchObject({ updated: true })
  for (const expected of [
    { ...daily, prompt: 'Different prompt' }, { ...daily, id: domain.ScheduleId('other') },
    { ...daily, scheduledAt: at.scheduledAt }, { ...daily, timeZone: 'UTC' }, { ...daily, time: '10:00:00.125' },
  ]) {
    expect(resolveScheduleUpdate(daily, expected, { kind: 'daily', daily: { time: daily.time, time_zone: daily.timeZone } }, now))
      .toEqual({ id, updated: false, code: 'schedule_conflict' })
  }
})

it.each([
  null, [], {}, { ...daily, private: 'must not appear' }, { ...daily, time: 'bad' },
  Object.fromEntries(Object.entries(daily).filter(([key]) => key !== 'title')),
])
('returns a fixed public error for malformed expected JSON %#', (expected) => {
  expect(resolveScheduleUpdate(daily, expected as ScheduleRecord, { kind: 'daily', daily: { time: '10:00:00', time_zone: 'UTC' } }, now))
    .toEqual({ code: 'invalid_rule', message: 'expected must be a complete valid Schedule record.' })
})

const invalidChanges: [ScheduleRecord, unknown, string][] = [
  [at, null, 'invalid_rule'], [at, [], 'invalid_rule'], [at, 'at', 'invalid_rule'],
  [at, {}, 'invalid_rule'], [at, { kind: 'after', after_seconds: 60 }, 'invalid_rule'],
  [at, { kind: 'at', at: at.scheduledAt, prompt: 'Overwrite' }, 'invalid_rule'],
  [at, { kind: 'at', every_seconds: 300 }, 'invalid_rule'], [at, { at: at.scheduledAt }, 'invalid_rule'],
  [at, { kind: 'at' }, 'invalid_rule'],
  [at, { kind: 'at', at: 'invalid' }, 'invalid_rule'],
  [at, { kind: 'at', at: '2026-02-30T00:00:00Z' }, 'invalid_rule'],
  [at, { kind: 'at', at: '2026-09-15T00:00:00Z' }, 'not_future'],
  [at, { kind: 'at', at: '0001-01-01T00:00:00+01:00' }, 'time_out_of_range'],
  [at, { kind: 'at', at: { date: '2026-09-16', time: '12:00:00', time_zone: 'Invalid/Zone' } }, 'invalid_time_zone'],
  [at, { kind: 'at', at: { date: '2026-09-16', time: '12:00:00', time_zone: 'UTC', extra: true } }, 'invalid_rule'],
  [at, { kind: 'at', at: { date: '2027-03-14', time: '02:30:00', time_zone: 'America/New_York' } }, 'invalid_rule'],
  [every, { kind: 'every', every_seconds: 59 }, 'frequency_too_high'],
  [every, { kind: 'every', every_seconds: '300' }, 'invalid_rule'],
  [every, { kind: 'every', every_seconds: 300.5 }, 'invalid_rule'],
  [every, { kind: 'every', every_seconds: Number.MAX_SAFE_INTEGER }, 'time_out_of_range'],
  [daily, { kind: 'daily', daily: { time: '24:00:00', time_zone: 'UTC' } }, 'invalid_rule'],
  [daily, { kind: 'daily', daily: { time: '10:00:00', time_zone: '+08:00' } }, 'invalid_time_zone'],
  [daily, { kind: 'daily', daily: { time: '10:00:00', time_zone: 'UTC', extra: true } }, 'invalid_rule'],
]

describe('strict wire timing validation', () => {
  it.each(invalidChanges)('rejects invalid timing %#', (current, change, code) => {
    const result = update(current, change as ScheduleTimingChange) as ScheduleToolError
    expect(result).toMatchObject({ code })
    expect(result.message).toEqual(expect.any(String))
  })
})

it('rejects daily exhaustion using the actual acceptance clock', () => {
  expect(update(daily, { kind: 'daily', daily: { time: '00:00:00', time_zone: 'UTC' } }, Date.parse('9999-12-31T23:59:59.999Z')))
    .toMatchObject({ code: 'time_out_of_range' })
})

it('does not turn programming failures in decoding or timing calculation into public input results', () => {
  const failure = new Error('Programming failure')
  vi.spyOn(domain, 'decodeScheduleRecord').mockImplementationOnce(() => { throw failure })
  expect(() => update(at, { kind: 'at', at: at.scheduledAt })).toThrow(failure)
  vi.spyOn(domain, 'parseAtInput').mockImplementationOnce(() => { throw failure })
  expect(() => update(at, { kind: 'at', at: at.scheduledAt })).toThrow(failure)
})

it('compares every interval and delayed one-shot metadata rather than only their target', () => {
  for (const [current, expected] of [
    [every, { ...every, everySeconds: 600 }], [after, { ...after, afterSeconds: 61 }],
    [after, { id, kind: 'at', title: storedTitle, prompt, scheduledAt: after.scheduledAt }],
  ] as [ScheduleRecord, ScheduleRecord][]) {
    expect(resolveScheduleUpdate(current, expected, { kind: 'at', at: at.scheduledAt }, now))
      .toEqual({ id, updated: false, code: 'schedule_conflict' })
  }
})

it('preserves the stored title through a timing edit', () => {
  const result = resolveScheduleUpdate(daily, daily, { kind: 'every', every_seconds: 600 }, now)
  if (!('record' in result)) throw new Error('Expected a new record')
  expect(result.record.title).toBe(storedTitle)
})

it('applies a replacement name and instruction without moving the committed target', () => {
  for (const current of storedRecords) {
    const result = resolveScheduleUpdate(current, current, undefined, now, { title: 'Renamed', prompt: 'New instruction' })
    expect(result).toEqual({ id, updated: true, record: { ...current, title: 'Renamed', prompt: 'New instruction' } })
    if (!('record' in result)) throw new Error('Expected a new record')
    expect(result.record.scheduledAt).toBe(current.scheduledAt)
    expect(result.record.kind).toBe(current.kind)
  }
})

it.each<[string, ScheduleUpdateContent, ScheduleUpdateContent]>([
  ['name', { title: 'Only the name' }, { title: 'Only the name', prompt }],
  ['instruction', { prompt: 'Only the instruction' }, { title: storedTitle, prompt: 'Only the instruction' }],
])('applies a %s-only change while keeping the other content and the committed target', (_field, content, expected) => {
  for (const current of storedRecords) {
    const result = resolveScheduleUpdate(current, current, undefined, now, content)
    expect(result).toEqual({ id, updated: true, record: { ...current, ...expected } })
    if (!('record' in result)) throw new Error('Expected a new record')
    expect(result.record.scheduledAt).toBe(current.scheduledAt)
  }
})

it('applies name, instruction, and a changed rule together with the creation target', () => {
  const weekly = { time: '07:00:00.125', time_zone: 'Asia/Shanghai', weekdays: [2, 5] }
  expect(resolveScheduleUpdate(every, every, { kind: 'weekly', weekly }, now, {
    title: 'Renamed', prompt: 'New instruction',
  })).toEqual({
    id, updated: true, record: domain.createWeeklyScheduleRecord(id, 'New instruction', weekly, now, 'Renamed'),
  })
})

it('keeps the committed target when an equivalent rule change also edits content', () => {
  expect(resolveScheduleUpdate(every, every, { kind: 'every', every_seconds: 300 }, now + 900_000, { title: 'Renamed' }))
    .toEqual({ id, updated: true, record: { ...every, title: 'Renamed' } })
  expect(resolveScheduleUpdate(after, after, { kind: 'at', at: after.scheduledAt }, now, { prompt: 'New instruction' }))
    .toEqual({ id, updated: true, record: { ...after, prompt: 'New instruction' } })
  const alias: ScheduleRecord = { ...daily, time: '09:00:00.100', timeZone: 'US/Eastern' }
  expect(resolveScheduleUpdate(alias, alias, {
    kind: 'daily', daily: { time: '09:00:00.1', time_zone: 'America/New_York' },
  }, now + 86_400_000, { title: 'Renamed' })).toEqual({ id, updated: true, record: { ...alias, title: 'Renamed' } })
})

it('writes nothing when trimmed content already matches every stored value', () => {
  for (const current of storedRecords) {
    expect(resolveScheduleUpdate(current, current, undefined, now)).toEqual({ id, updated: false, record: current })
    expect(resolveScheduleUpdate(current, current, undefined, now, {
      title: `  ${current.title}  `, prompt: `  ${current.prompt}  `,
    })).toEqual({ id, updated: false, record: current })
  }
})

it.each<[string, ScheduleUpdateContent, string]>([
  ['title', { title: '   ' }, 'title is required and must be non-empty after trimming.'],
  ['title', { title: 'x'.repeat(domain.MAX_TITLE_LENGTH + 1) }, 'title must be at most 120 characters.'],
  ['prompt', { prompt: ' \n ' }, 'prompt must be non-empty after trimming.'],
])('rejects an invalid replacement %s with its stable message', (_field, content, message) => {
  expect(resolveScheduleUpdate(daily, daily, undefined, now, content)).toEqual({ code: 'invalid_prompt', message })
})

it.each<[string, unknown]>([['title', { title: 7 }], ['prompt', { prompt: 7 }]])(
  'rejects a non-string replacement %s at the wire boundary',
  (_field, content) => {
    expect(resolveScheduleUpdate(daily, daily, undefined, now, content as ScheduleUpdateContent))
      .toMatchObject({ code: 'invalid_prompt' })
  },
)

it('refuses a stale snapshot before applying a content edit or reporting invalid content', () => {
  for (const expected of [{ ...every, everySeconds: 600 }, daily]) {
    expect(resolveScheduleUpdate(every, expected, undefined, now, { title: 'Renamed' }))
      .toEqual({ id, updated: false, code: 'schedule_conflict' })
    expect(resolveScheduleUpdate(every, expected, targetChanges.weekly, now, { title: 'Renamed', prompt: 'New' }))
      .toEqual({ id, updated: false, code: 'schedule_conflict' })
    expect(resolveScheduleUpdate(every, expected, undefined, now, { title: '  ' }))
      .toEqual({ id, updated: false, code: 'schedule_conflict' })
  }
})

it('returns the stored title and refuses a record without a valid one', () => {
  expect(retainedTitle(daily)).toBe(storedTitle)
  for (const title of ['   ', ` ${storedTitle}`, 'x'.repeat(domain.MAX_TITLE_LENGTH + 1)]) {
    expect(() => retainedTitle({ ...daily, title })).toThrow(domain.ScheduleLogError)
  }
})
