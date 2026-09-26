/** Exact rules, native drafts, and Host failure mapping the retained-task detail composes. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScheduleCatalogEntry, ScheduleId, ScheduleRecord } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  draftZone, timingDraft, timingError, timingSnapshot, zonedWallClock,
} from '../src/client/task-timing.ts'
import type { TimingDraft } from '../src/client/task-timing.ts'

const at: ScheduleCatalogEntry = {
  id: 'at' as ScheduleId, sessionId: 'original' as SessionId, status: 'active', kind: 'at',
  title: 'One-time instruction', prompt: 'One-time instruction', scheduledAt: '2099-10-01T09:12:34.567Z',
}
const after: ScheduleCatalogEntry = { ...at, id: 'after' as ScheduleId, kind: 'after', afterSeconds: 90 }
const every: ScheduleCatalogEntry = { ...at, id: 'every' as ScheduleId, kind: 'every', everySeconds: 301 }
const daily: ScheduleCatalogEntry = {
  ...at, id: 'daily' as ScheduleId, kind: 'daily', time: '09:12:34.567', timeZone: 'Asia/Shanghai',
}
const weekly: ScheduleCatalogEntry = {
  ...at, id: 'weekly' as ScheduleId, kind: 'weekly', time: '09:12:34.567',
  timeZone: 'Asia/Shanghai', weekdays: [1, 3],
}
const cron: ScheduleCatalogEntry = {
  ...at, id: 'cron' as ScheduleId, kind: 'cron', expression: '0 9 * * 1-5', timeZone: 'Asia/Shanghai',
}

// Literal records, written independently of timingSnapshot, that fix each kind's complete expected rule.
const literalExpectedRules: readonly {
  kind: ScheduleRecord['kind']
  task: ScheduleCatalogEntry
  expected: ScheduleRecord
}[] = [
  {
    kind: 'at', task: at,
    expected: {
      id: 'at' as ScheduleId, title: 'One-time instruction', prompt: 'One-time instruction', kind: 'at',
      scheduledAt: '2099-10-01T09:12:34.567Z',
    },
  },
  {
    kind: 'after', task: after,
    expected: {
      id: 'after' as ScheduleId, title: 'One-time instruction', prompt: 'One-time instruction', kind: 'after',
      afterSeconds: 90, scheduledAt: '2099-10-01T09:12:34.567Z',
    },
  },
  {
    kind: 'every', task: every,
    expected: {
      id: 'every' as ScheduleId, title: 'One-time instruction', prompt: 'One-time instruction', kind: 'every',
      everySeconds: 301, scheduledAt: '2099-10-01T09:12:34.567Z',
    },
  },
  {
    kind: 'daily', task: daily,
    expected: {
      id: 'daily' as ScheduleId, title: 'One-time instruction', prompt: 'One-time instruction', kind: 'daily',
      time: '09:12:34.567', timeZone: 'Asia/Shanghai', scheduledAt: '2099-10-01T09:12:34.567Z',
    },
  },
  {
    kind: 'weekly', task: weekly,
    expected: {
      id: 'weekly' as ScheduleId, title: 'One-time instruction', prompt: 'One-time instruction', kind: 'weekly',
      time: '09:12:34.567', timeZone: 'Asia/Shanghai', weekdays: [1, 3],
      scheduledAt: '2099-10-01T09:12:34.567Z',
    },
  },
  {
    kind: 'cron', task: cron,
    expected: {
      id: 'cron' as ScheduleId, title: 'One-time instruction', prompt: 'One-time instruction', kind: 'cron',
      expression: '0 9 * * 1-5', timeZone: 'Asia/Shanghai', scheduledAt: '2099-10-01T09:12:34.567Z',
    },
  },
]

// Native input values each kind initializes, written independently of timingDraft.
const literalDrafts: readonly { kind: ScheduleRecord['kind']; task: ScheduleCatalogEntry; expected: TimingDraft }[] = [
  {
    kind: 'at', task: at,
    expected: { date: '2099-10-01', time: '17:12:34.567', timeZone: 'Asia/Shanghai', seconds: '', expression: '' },
  },
  {
    kind: 'after', task: after,
    expected: { date: '2099-10-01', time: '17:12:34.567', timeZone: 'Asia/Shanghai', seconds: '', expression: '' },
  },
  {
    kind: 'every', task: every,
    expected: { date: '', time: '', timeZone: '', seconds: '301', expression: '' },
  },
  {
    kind: 'daily', task: daily,
    expected: { date: '', time: '09:12:34.567', timeZone: 'Asia/Shanghai', seconds: '', expression: '' },
  },
  {
    kind: 'weekly', task: weekly,
    expected: { date: '', time: '09:12:34.567', timeZone: 'Asia/Shanghai', seconds: '', expression: '' },
  },
  {
    kind: 'cron', task: cron,
    expected: { date: '', time: '', timeZone: 'Asia/Shanghai', seconds: '', expression: '0 9 * * 1-5' },
  },
]

describe('timingSnapshot', () => {
  it.each(literalExpectedRules)('projects the literal $kind expected rule without catalog metadata', ({ task, expected }) => {
    const snapshot = timingSnapshot(task)
    expect(snapshot).toStrictEqual(expected)
    for (const metadata of ['sessionId', 'status', 'lastDelivery'] as const) {
      expect(snapshot).not.toHaveProperty(metadata)
    }
  })

  it('excludes the delivery receipt from the expected rule', () => {
    const delivered: ScheduleCatalogEntry = {
      ...daily,
      lastDelivery: {
        messageId: 'delivery' as NonNullable<ScheduleCatalogEntry['lastDelivery']>['messageId'],
        scheduledAt: daily.scheduledAt,
        deliveredAt: daily.scheduledAt,
      },
    }
    expect(timingSnapshot(delivered)).not.toHaveProperty('lastDelivery')
  })

  it('copies the weekly weekday set instead of aliasing the catalog row', () => {
    const snapshot = timingSnapshot(weekly)
    if (snapshot.kind !== 'weekly') throw new Error('expected a weekly rule')
    snapshot.weekdays.push(5)
    expect(weekly.weekdays).toEqual([1, 3])
  })
})

describe('timingDraft', () => {
  // A one-shot target stores only its instant, so its rows start in this device's
  // zone. The case pins that zone to keep the literals host-independent:
  // 09:12:34.567Z is 17:12:34.567 on the same date in Asia/Shanghai.
  afterEach(() => { vi.restoreAllMocks() })
  it.each(literalDrafts)('initializes the $kind native inputs', ({ task, expected }) => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      ...new Intl.DateTimeFormat().resolvedOptions(), timeZone: 'Asia/Shanghai',
    })
    expect(timingDraft(task)).toStrictEqual(expected)
  })
})

describe('device zone', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('falls back to UTC when the runtime reports no device zone', () => {
    // `resolvedOptions().timeZone` may be empty on a runtime that cannot name
    // the device zone; the draft then needs one explicit fallback to store.
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      ...new Intl.DateTimeFormat().resolvedOptions(), timeZone: '',
    })
    expect(draftZone(at)).toEqual({ zone: 'UTC', stored: false })
    expect(timingDraft(at)).toStrictEqual({
      date: '2099-10-01', time: '09:12:34.567', timeZone: 'UTC', seconds: '', expression: '',
    })
  })

  it('keeps the stored text when a zone cannot place the instant', () => {
    expect(zonedWallClock('2099-10-01T09:12:34.567Z', 'Not/AZone')).toBe('')
    // A rule that stores such a zone keeps its own clock text and date rows empty.
    expect(timingDraft({ ...daily, timeZone: 'Not/AZone' })).toStrictEqual({
      date: '', time: '09:12:34.567', timeZone: 'Not/AZone', seconds: '', expression: '',
    })
  })
})

describe('timingError', () => {
  it.each([
    ['schedule_conflict', 'timing.conflict'],
    ['schedule_ended', 'timing.inactive'],
    ['schedule_not_found', 'timing.notFound'],
    ['invalid_time_zone', 'timing.invalidZone'],
    ['not_future', 'timing.notFuture'],
    ['frequency_too_high', 'timing.invalidInterval'],
    ['invalid_prompt', 'timing.invalid'],
    ['invalid_selector', 'timing.invalid'],
    ['invalid_rule', 'timing.invalid'],
    ['time_out_of_range', 'timing.invalid'],
    ['internal_error', 'timing.error'],
  ] as const)('maps the Host %s failure to %s', (code, key) => {
    expect(timingError(code)).toBe(key)
  })
})
