import { describe, expect, it } from 'vitest'
import {
  canonicalizeCronExpression, canonicalizeTimeZone, createAtScheduleRecord, createCronScheduleRecord,
  createDailyScheduleRecord, createEveryScheduleRecord, createWeeklyScheduleRecord,
  decodeScheduleRecord, isRecurringScheduleRecord, parseCronInput,
  renderRecurringReminderBatchFraming, resolveCronOccurrence, resolveRecurringOccurrence,
  ScheduleId, ScheduleLogError,
} from '../src/domain.ts'
import { updateResult } from './rule-edits.ts'
import type { CronInput, CronScheduleRecord } from '../src/types.ts'
import type { ScheduleRecord, ScheduleTiming } from '../src/types.ts'

function cron(now: string, expression: string, timeZone = 'UTC'): CronScheduleRecord {
  return createCronScheduleRecord(
    ScheduleId('cron'), '  Cron reminder  ', { expression, time_zone: timeZone }, Date.parse(now), 'Cron reminder',
  )
}

function decision(record: CronScheduleRecord, now: string) {
  return resolveCronOccurrence(record, Date.parse(now))
}

describe('cron selector validation', () => {
  it('normalizes a cron selector without calculating a target', () => {
    expect(parseCronInput({ expression: '*/15 9-17 * * 1-5', time_zone: 'Asia/Shanghai' }))
      .toEqual({ expression: '*/15 9-17 * * 1-5', timeZone: 'Asia/Shanghai' })
    expect(parseCronInput({ expression: '00 09 * * 7', time_zone: 'US/Eastern' }))
      .toEqual({ expression: '0 9 * * 0', timeZone: canonicalizeTimeZone('US/Eastern') })
  })

  it.each<[unknown, string]>([
    [null, 'invalid_rule'], [[], 'invalid_rule'], [{}, 'invalid_rule'],
    [{ expression: '0 0 * * *' }, 'invalid_rule'], [{ time_zone: 'UTC' }, 'invalid_rule'],
    [{ expression: '0 0 * * *', time_zone: 'UTC', extra: true }, 'invalid_rule'],
    [{ expression: 7, time_zone: 'UTC' }, 'invalid_rule'],
    [{ expression: '0 0 L * *', time_zone: 'UTC' }, 'invalid_rule'],
    [{ expression: '0 0 * * *', time_zone: 7 }, 'invalid_time_zone'],
    [{ expression: '0 0 * * *', time_zone: '+08:00' }, 'invalid_time_zone'],
    [{ expression: '0 0 * * *', time_zone: 'Unknown/Zone' }, 'invalid_time_zone'],
  ])('rejects the malformed cron selector %#', (input, code) => {
    expect(() => parseCronInput(input as CronInput)).toThrow(expect.objectContaining({ code }))
  })
})

describe('cron task construction and decisions', () => {
  it('chooses the first strictly future matching minute in the rule zone', () => {
    const record = cron('2026-09-16T00:00:00Z', '30 9 * * *', 'Asia/Shanghai')
    expect(record).toEqual({
      id: 'cron', kind: 'cron', title: 'Cron reminder', prompt: 'Cron reminder', expression: '30 9 * * *',
      timeZone: 'Asia/Shanghai', scheduledAt: '2026-09-16T01:30:00.000Z',
    })
    expect(Object.isFrozen(record)).toBe(true)
  })

  it('rejects a decision before the committed target or outside supported instants', () => {
    const record = cron('2026-09-16T00:00:00Z', '0 9 * * *')
    expect(() => decision(record, '2026-09-16T00:00:00Z')).toThrow(/cannot precede/)
    for (const now of [Number.NaN, Date.parse('0000-12-31T23:59:59.999Z'), Date.parse('+010000-01-01T00:00:00Z')]) {
      expect(() => resolveCronOccurrence(record, now)).toThrow(/acceptedAt/)
    }
  })

  it('rejects an impossible schedule and an unsupported creation instant', () => {
    expect(() => cron('2026-01-01T00:00:00Z', '0 0 30 2 *')).toThrow(/four-digit-year/)
    for (const now of [Number.NaN, 0.5, Date.parse('0000-12-31T23:59:59.999Z'), Date.parse('+010000-01-01T00:00:00Z')]) {
      expect(() => createCronScheduleRecord(
        ScheduleId('bad'), 'Reminder', { expression: '0 0 * * *', time_zone: 'UTC' }, now, 'Reminder',
      )).toThrow(expect.objectContaining({ code: 'time_out_of_range' }))
    }
  })

  it('rejects empty prompts and blank fields before computing a target', () => {
    expect(() => createCronScheduleRecord(
      ScheduleId('bad'), ' ', { expression: '0 0 * * *', time_zone: 'UTC' }, 0, 'Title',
    )).toThrow(/prompt/)
    expect(() => createCronScheduleRecord(
      ScheduleId('bad'), 'Reminder', { expression: '0 0 * * *', time_zone: 'UTC' }, 0, 'x'.repeat(121),
    )).toThrow(/title/)
  })

})

describe('cron durable decoding', () => {
  const record = cron('2026-09-15T00:00:00Z', '*/15 9-17 * * 1-5', 'Asia/Shanghai')

  it('decodes a canonical cron record from current Host storage', () => {
    expect(record.expression).toBe('*/15 9-17 * * 1-5')
    expect(decodeScheduleRecord(record)).toEqual(record)
  })

  it('preserves a stored zone alias without recomputing the committed target', () => {
    const alias = decodeScheduleRecord({ ...record, timeZone: 'US/Eastern' }) as CronScheduleRecord
    expect(alias.timeZone).toBe('US/Eastern')
    expect(alias.scheduledAt).toBe(record.scheduledAt)
  })

  it('rejects a non-canonical stored expression and an unparseable one', () => {
    expect(() => decodeScheduleRecord({ ...record, expression: '00 09 * * 1-5' }))
      .toThrow(/cron expression must be canonical/)
    expect(() => decodeScheduleRecord({ ...record, expression: '0 0 L * *' })).toThrow(ScheduleLogError)
  })


  it.each([
    { kind: 'daily' }, { kind: 'after' }, { id: '' }, { id: ' padded' }, { title: '' }, { title: ' padded' },
    { prompt: '' }, { prompt: ' padded' }, { expression: 7 }, { timeZone: 7 }, { timeZone: 'Unknown/Zone' },
    { scheduledAt: '2026-09-15T01:00:00Z' }, { extra: true },
  ])('rejects the malformed durable cron field %#', (fields) => {
    expect(() => decodeScheduleRecord({ ...record, ...fields })).toThrow(ScheduleLogError)
  })

  it.each(['id', 'kind', 'title', 'prompt', 'expression', 'timeZone', 'scheduledAt'])(
    'rejects a cron record missing %s', (key) => {
      const incomplete = Object.fromEntries(Object.entries(record).filter(([field]) => field !== key))
      expect(() => decodeScheduleRecord(incomplete)).toThrow(ScheduleLogError)
    })

  it('shares recurring selection and batch framing with the existing recurring kinds', () => {
    const every = createEveryScheduleRecord(
      ScheduleId('every'), 'Every', 300, Date.parse('2026-09-15T00:00:00Z'), 'Every',
    )
    expect(isRecurringScheduleRecord(record)).toBe(true)
    expect(isRecurringScheduleRecord(every)).toBe(true)
    expect(isRecurringScheduleRecord(createAtScheduleRecord(ScheduleId('at'), 'Once', '2026-09-15T01:00:00Z',
      Date.parse('2026-09-15T00:00:00Z'), 'Once'))).toBe(false)
    expect(resolveRecurringOccurrence(record, Date.parse(record.scheduledAt))).toEqual(decision(record, record.scheduledAt))
    expect(renderRecurringReminderBatchFraming([{ record, occurrenceAt: record.scheduledAt }])).toBe([
      '[SCHEDULE REMINDER BATCH]',
      'This is a scheduled message from the user',
      `reminders_json: [{"schedule_id":"cron","occurrence_at":"${record.scheduledAt}","reminder_prompt":"Cron reminder"}]`,
    ].join('\n'))
  })
})

describe('cron timing edits', () => {
  const now = Date.parse('2026-09-16T00:00:00.125Z')
  const id = ScheduleId('timing')
  const current: ScheduleRecord = createCronScheduleRecord(id, 'Keep prompt', {
    expression: '0 9 * * 1-5', time_zone: 'US/Eastern',
  }, now, 'Kept name')

  function update(change: ScheduleTiming, acceptedAt = now) {
    return updateResult(current, change, acceptedAt)
  }

  it('is a no-op for an equivalent normalized cron rule', () => {
    const result = update({
      kind: 'cron', cron: { expression: '00 09 * * 5,4,3,2,1', time_zone: 'America/New_York' },
    }, now + 86_400_000)
    expect(result).toEqual({ id, updated: false, record: current })
    if (!('record' in result)) throw new Error('Expected unchanged record')
    expect(result.record).toBe(current)
  })

  it('is a no-op for the stored zone alias as well as the canonical name', () => {
    const aliased: ScheduleRecord = { ...current, timeZone: 'US/Eastern' }
    expect(updateResult(aliased, {
      kind: 'cron', cron: { expression: '0 9 * * 1-5', time_zone: 'America/New_York' },
    }, now + 86_400_000)).toEqual({ id, updated: false, record: aliased })
  })

  it.each<[CronInput, string]>([
    [{ expression: '0 8 * * 2', time_zone: 'Asia/Shanghai' }, '2026-09-22T00:00:00.000Z'],
    [{ expression: '0 9 * * 1-5', time_zone: 'Asia/Shanghai' }, '2026-09-16T01:00:00.000Z'],
    [{ expression: '30 9 * * 1-5', time_zone: 'US/Eastern' }, '2026-09-16T13:30:00.000Z'],
  ])('reanchors a changed cron rule at the accepted save sample (%#)', (input, scheduledAt) => {
    expect(update({ kind: 'cron', cron: input }, now + 75_000)).toEqual({
      id, updated: true, record: {
        id, kind: 'cron', title: 'Kept name', prompt: 'Keep prompt',
        expression: canonicalizeCronExpression(input.expression), timeZone: canonicalizeTimeZone(input.time_zone),
        scheduledAt,
      },
    })
  })

  it('converts a stored one-shot, fixed-rate, daily, or weekly record into cron with the same identity', () => {
    const input = { expression: '0 7 * * 2,5', time_zone: 'Asia/Shanghai' }
    for (const other of [
      createAtScheduleRecord(id, 'Keep prompt', '2026-09-16T01:00:00.125Z', now, 'Keep prompt'),
      createEveryScheduleRecord(id, 'Keep prompt', 300, now, 'Keep prompt'),
      createDailyScheduleRecord(id, 'Keep prompt', { time: '09:00:00.125', time_zone: 'UTC' }, now, 'Keep prompt'),
      createWeeklyScheduleRecord(
        id, 'Keep prompt', { time: '09:00:00.125', time_zone: 'UTC', weekdays: [1] }, now, 'Keep prompt',
      ),
    ] as ScheduleRecord[]) {
      expect(updateResult(other, { kind: 'cron', cron: input }, now)).toEqual({
        id, updated: true, record: createCronScheduleRecord(id, 'Keep prompt', input, now, 'Keep prompt'),
      })
    }
  })

  it('converts a cron record into each other timing kind', () => {
    for (const change of [
      { kind: 'every', every_seconds: 300 },
      { kind: 'daily', daily: { time: '09:00:00', time_zone: 'UTC' } },
      { kind: 'weekly', weekly: { time: '09:00:00', time_zone: 'UTC', weekdays: [1] } },
      { kind: 'at', at: '2026-09-16T10:00:00Z' },
    ] as ScheduleTiming[]) {
      expect(update(change, now)).toMatchObject({
        id, updated: true, record: { id, kind: change.kind, prompt: 'Keep prompt' },
      })
    }
  })

  it.each<[unknown]>([
    [{ expression: '0 0 L * *', time_zone: 'UTC' }],
    [{ expression: '0 0 * * *', time_zone: '+08:00' }],
    [{ expression: '0 0 30 2 *', time_zone: 'UTC' }],
    // An extra selector key is not representable in CronInput, so the wire shape is unchecked here.
    [{ expression: '0 0 * * *', time_zone: 'UTC', extra: true }],
  ])('returns a bounded input error for the invalid cron timing %#', (candidate) => {
    const result = update({ kind: 'cron', cron: candidate as CronInput }, now)
    if (!('code' in result)) throw new Error('Expected a bounded input error')
    expect(['invalid_rule', 'invalid_time_zone', 'time_out_of_range']).toContain(result.code)
  })

  it('rejects a cron change carrying extra selector keys', () => {
    const change: unknown = { kind: 'cron', cron: { expression: '0 0 * * *', time_zone: 'UTC' }, extra: true }
    expect(update(change as ScheduleTiming)).toMatchObject({ code: 'invalid_rule' })
  })
})
