import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScheduleId, ScheduleRecord } from '@deepseek-ai/dsh-schedule/client'
import {
  FALLBACK_ZONES, formatAvailableAt, formatScheduleAbsolute, formatScheduleFrequency, formatScheduleNextRun, formatWeekdays, recordTimeZone,
  zoneChoices, zoneLabel, zoneName,
} from '../src/client/schedule-format.ts'
import { en, zh } from '../src/client/task-manager-locales.ts'

/** Host zone pinned for every case, so menu order reads the same on any runner. */
const SYSTEM = 'Asia/Shanghai'
const OFFSET_DATE = Date.parse('2026-01-15T00:00:00.000Z')

/**
 * ICU's long generic name for one zone in one locale.
 *
 * The wording moves with the runtime's ICU data version (`West Africa Time` on
 * macOS, `West Africa Standard Time` on Linux), so the cases derive it from the
 * engine the implementation reads instead of pinning one platform's spelling.
 * @param zone - IANA zone to name.
 * @param locale - locale owning the name.
 * @param at - instant the name is resolved at.
 * @returns the ICU name, or an empty string when ICU states none.
 */
function icuZoneName(zone: string, locale: string, at: number = OFFSET_DATE): string {
  return new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: 'longGeneric' })
    .formatToParts(at).find(part => part.type === 'timeZoneName')?.value ?? ''
}

/**
 * The offset prefix the label states, read from ICU directly.
 * @param zone - IANA zone to offset.
 * @param at - instant the offset is resolved at.
 * @returns `UTC±HH:MM`.
 */
function utcOffset(zone: string, at: number = OFFSET_DATE): string {
  const raw = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(at).find(part => part.type === 'timeZoneName')?.value ?? ''
  // ICU answers `GMT+01:00` (and bare `GMT` for UTC); the row states `UTC…`.
  return raw === 'GMT' ? 'UTC+00:00' : raw.replace(/^GMT/, 'UTC')
}

/**
 * The composed label one zone states in one locale: offset, then ICU name.
 * @param zone - IANA zone to state.
 * @param locale - locale owning the name.
 * @returns the expected label.
 */
function statedZoneLabel(zone: string, locale: string): string {
  return `${utcOffset(zone)} · ${icuZoneName(zone, locale)}`
}

/** One record per rule kind, so the zone lookup is read for every discriminator. */
const ZONE_RECORDS = [
  { id: 'task-after' as ScheduleId, kind: 'after', title: 'After', prompt: 'After', afterSeconds: 90, scheduledAt: '2026-10-01T15:00:00.000Z' },
  { id: 'task-at' as ScheduleId, kind: 'at', title: 'At', prompt: 'At', scheduledAt: '2026-10-01T15:00:00.000Z' },
  { id: 'task-every' as ScheduleId, kind: 'every', title: 'Every', prompt: 'Every', everySeconds: 301, scheduledAt: '2026-10-01T15:00:00.000Z' },
  { id: 'task-daily' as ScheduleId, kind: 'daily', title: 'Daily', prompt: 'Daily', time: '23:00:00.000', timeZone: SYSTEM, scheduledAt: '2026-10-01T15:00:00.000Z' },
  { id: 'task-weekly' as ScheduleId, kind: 'weekly', title: 'Weekly', prompt: 'Weekly', time: '09:30:00.000', timeZone: SYSTEM, weekdays: [1], scheduledAt: '2026-10-01T15:00:00.000Z' },
  { id: 'task-cron' as ScheduleId, kind: 'cron', title: 'Cron', prompt: 'Cron', expression: '0 9 * * 1', timeZone: SYSTEM, scheduledAt: '2026-10-01T15:00:00.000Z' },
] as const satisfies readonly ScheduleRecord[]

afterEach(() => { vi.restoreAllMocks() })

describe('zoneChoices', () => {
  it('offers every zone the runtime enumerates, far past the fallback', () => {
    const choices = zoneChoices(SYSTEM, SYSTEM)
    expect(choices[0]).toBe(SYSTEM)
    for (const zone of Intl.supportedValuesOf('timeZone')) expect(choices).toContain(zone)
    expect(choices).toEqual(expect.arrayContaining(['Africa/Lagos', 'Pacific/Auckland']))
    expect(choices.length).toBeGreaterThan(FALLBACK_ZONES.length)
    expect(new Set(choices).size).toBe(choices.length)
  })

  it('leads with the host zone, then orders the inventory by UTC offset and IANA id', () => {
    const choices = zoneChoices(SYSTEM, SYSTEM, OFFSET_DATE)
    expect(choices[0]).toBe(SYSTEM)
    expect(choices.indexOf('America/Los_Angeles')).toBeLessThan(choices.indexOf('UTC'))
    expect(choices.indexOf('UTC')).toBeLessThan(choices.indexOf('Asia/Tokyo'))
    expect(choices.indexOf('Asia/Singapore')).toBeLessThan(choices.indexOf('Australia/Perth'))
  })

  it('leads with the host zone regardless of the fallback', () => {
    const choices = zoneChoices(SYSTEM, 'Europe/Paris', OFFSET_DATE)
    expect(choices[0]).toBe('Europe/Paris')
    expect(choices.filter(zone => zone === 'Europe/Paris')).toHaveLength(1)
  })

  it('appends a stored zone the runtime inventory omits', () => {
    vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue(['Europe/Paris', 'Europe/Berlin', 'Africa/Lagos'])
    const choices = zoneChoices('US/Pacific', SYSTEM, OFFSET_DATE)
    expect(choices[0]).toBe(SYSTEM)
    expect(choices).toContain('US/Pacific')
    expect(choices.indexOf('US/Pacific')).toBeLessThan(choices.indexOf('UTC'))
  })

  it('orders zones sharing one offset by IANA id rather than inventory order', () => {
    // Berlin and Paris share an offset in January, so their order is the id order
    // even though the runtime enumerated Paris first.
    vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue(['Europe/Paris', 'Europe/Berlin'])
    const choices = zoneChoices('UTC', 'UTC', OFFSET_DATE)
    expect(choices.indexOf('Europe/Berlin')).toBeLessThan(choices.indexOf('Europe/Paris'))
  })

  it('falls back to system, UTC, and the stored zone when enumeration throws', () => {
    vi.spyOn(Intl, 'supportedValuesOf').mockImplementation(() => { throw new TypeError('no time zones') })
    const choices = zoneChoices('Europe/Paris', SYSTEM, OFFSET_DATE)
    expect(choices[0]).toBe(SYSTEM)
    expect(choices).toEqual(expect.arrayContaining([...FALLBACK_ZONES, 'Europe/Paris']))
    expect(zoneChoices(SYSTEM, SYSTEM, OFFSET_DATE)).toHaveLength(2)
  })

  it('falls back to system and UTC when the runtime has no enumerator', () => {
    const original = Intl.supportedValuesOf
    Reflect.deleteProperty(Intl, 'supportedValuesOf')
    try {
      const choices = zoneChoices(SYSTEM, SYSTEM, OFFSET_DATE)
      expect(choices[0]).toBe(SYSTEM)
      expect(choices).toHaveLength(2)
      expect(choices).toEqual(expect.arrayContaining([...FALLBACK_ZONES, SYSTEM]))
    } finally {
      Object.defineProperty(Intl, 'supportedValuesOf', { value: original, writable: true, configurable: true })
    }
  })
})

describe('recordTimeZone', () => {
  it('reads a stored rule zone from the wall-clock kinds and none from the instant kinds', () => {
    // The card asks each record for its own rule zone; the instant-only kinds
    // store no zone and are displayed in the browser zone.
    expect(ZONE_RECORDS.filter(record => record.kind === 'daily' || record.kind === 'weekly' || record.kind === 'cron')
      .map(recordTimeZone)).toEqual([SYSTEM, SYSTEM, SYSTEM])
    expect(ZONE_RECORDS.filter(record => record.kind === 'after' || record.kind === 'at' || record.kind === 'every')
      .map(recordTimeZone)).toEqual([undefined, undefined, undefined])
  })
})

/**
 * Stub one formatter's parts by the field the caller asked it to name.
 * @param offset - `timeZoneName` value of a `longOffset` call, or undefined when the runtime reports none.
 * @param name - `timeZoneName` value of a `longGeneric` call, or undefined when the runtime reports none.
 */
function stubZoneParts(offset: string | undefined, name: string | undefined): void {
  vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementation(function (this: Intl.DateTimeFormat) {
    const value = this.resolvedOptions().timeZoneName === 'longOffset' ? offset : name
    return value === undefined ? [{ type: 'literal', value: ',' }] : [{ type: 'timeZoneName', value }]
  })
}

describe('zone label resilience', () => {
  it('labels an engine that reports UTC as the bare GMT name', () => {
    // Engines differ: this runtime answers `GMT+00:00`, an older ICU answers `GMT`.
    stubZoneParts('GMT', undefined)
    expect(zoneLabel('UTC', makeTranslate(en), OFFSET_DATE)).toBe('UTC+00:00')
  })

  it('keeps the ICU name when the runtime reports no readable UTC offset', () => {
    stubZoneParts(undefined, 'China Standard Time')
    expect(zoneLabel('Asia/Shanghai', makeTranslate(en), OFFSET_DATE)).toBe('China Standard Time')
  })

  it('keeps the IANA id when neither the offset nor the name is readable', () => {
    stubZoneParts(undefined, undefined)
    expect(zoneLabel('Asia/Shanghai', makeTranslate(en), OFFSET_DATE)).toBe('Asia/Shanghai')
  })

  it('keeps the readable half when the runtime cannot name one zone', () => {
    // Only the offset is readable: the raw IANA id stands in for the missing name.
    vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementation(function (this: Intl.DateTimeFormat) {
      if (this.resolvedOptions().timeZoneName === 'longGeneric') throw new RangeError('no zone name')
      return [{ type: 'timeZoneName', value: 'GMT+08:00' }]
    })
    expect(zoneLabel('Asia/Shanghai', makeTranslate(en), OFFSET_DATE)).toBe('UTC+08:00 · Asia/Shanghai')
  })

  it('falls back to the IANA id alone when the runtime rejects the zone twice', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementation(() => {
      throw new RangeError('no such zone')
    })
    expect(zoneLabel('Asia/Shanghai', makeTranslate(en), OFFSET_DATE)).toBe('Asia/Shanghai')
  })

  it('orders a zone whose offset is unreadable after the readable ones', () => {
    vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue(['Asia/Tokyo', 'Australia/Perth'])
    vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementation(function (this: Intl.DateTimeFormat) {
      const { timeZone, timeZoneName } = this.resolvedOptions()
      if (timeZoneName !== 'longOffset') return [{ type: 'timeZoneName', value: 'Zone' }]
      // The runtime cannot state Tokyo's offset; every other zone answers.
      return timeZone === 'Asia/Tokyo' ? [] : [{ type: 'timeZoneName', value: 'GMT+08:00' }]
    })
    const choices = zoneChoices('Europe/Paris', SYSTEM, OFFSET_DATE)
    expect(choices.indexOf('UTC')).toBeLessThan(choices.indexOf('Asia/Tokyo'))
    expect(choices.indexOf('Australia/Perth')).toBeLessThan(choices.indexOf('Asia/Tokyo'))
  })
})

describe('zone names', () => {
  it('uses ICU names after UTC offsets and keeps the IANA id internal', () => {
    const t = makeTranslate(en)
    // The expected wording is read from ICU at assert time, so the case holds on
    // any runtime data version.
    expect(zoneLabel('Asia/Shanghai', t, OFFSET_DATE)).toBe(statedZoneLabel('Asia/Shanghai', 'en'))
    expect(zoneLabel('Africa/Lagos', t, OFFSET_DATE)).toBe(statedZoneLabel('Africa/Lagos', 'en'))
    // The name is ICU's, so the label is neither the bare IANA id nor the offset.
    expect(icuZoneName('Africa/Lagos', 'en')).not.toBe('')
    expect(zoneLabel('Africa/Lagos', t, OFFSET_DATE)).not.toBe('Africa/Lagos')
    expect(zoneLabel('Africa/Lagos', t, OFFSET_DATE)).not.toBe(utcOffset('Africa/Lagos'))
    expect(zoneName('Asia/Shanghai', SYSTEM, t, OFFSET_DATE))
      .toBe(`${statedZoneLabel('Asia/Shanghai', 'en')}${en['rule.zone.system']}`)
    expect(zoneName('UTC', SYSTEM, t, OFFSET_DATE)).toBe(utcOffset('UTC'))
  })

  it('gets Chinese zone names from ICU rather than a product-owned lookup table', () => {
    const t = makeTranslate(zh)
    expect(zoneLabel('Asia/Shanghai', t, OFFSET_DATE)).toBe(statedZoneLabel('Asia/Shanghai', 'zh-CN'))
    expect(zoneLabel('America/New_York', t, OFFSET_DATE)).toBe(statedZoneLabel('America/New_York', 'zh-CN'))
    // A product-owned table could not follow the locale's own ICU names.
    expect(zoneLabel('Asia/Shanghai', t, OFFSET_DATE)).not.toBe(statedZoneLabel('Asia/Shanghai', 'en'))
  })
})

describe('formatWeekdays', () => {
  it('names every stored ISO weekday and joins them with the locale separator', () => {
    const t = makeTranslate(en)
    expect(formatWeekdays([1, 3, 7], t)).toBe([
      en['frequency.weekday.1'], en['frequency.weekday.3'], en['frequency.weekday.7'],
    ].join(en['frequency.weekday.join']))
  })

  it('names an index outside the ISO weekday range as Monday rather than an undefined word', () => {
    const t = makeTranslate(en)
    expect(formatWeekdays([0], t)).toBe(en['frequency.weekday.1'])
    expect(formatWeekdays([8], t)).toBe(en['frequency.weekday.1'])
  })
})

describe('formatScheduleAbsolute', () => {
  /** Independent absolute rendering of one instant in the device zone. */
  const expected = (locale: string, namesYear: boolean): string => new Intl.DateTimeFormat(locale, {
    month: 'short', day: 'numeric', ...(namesYear ? { year: 'numeric' as const } : {}),
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }).format(Date.parse(INSTANT))

  const INSTANT = '2026-10-01T15:00:00.000Z'

  it('names the year in English and reads month and day in Chinese, in the device zone', () => {
    expect(formatScheduleAbsolute(INSTANT, 'en')).toBe(expected('en', true))
    expect(formatScheduleAbsolute(INSTANT, 'zh-CN')).toBe(expected('zh-CN', false))
    // English carries the year; the Chinese form reads the date without it.
    expect(formatScheduleAbsolute(INSTANT, 'en')).toContain('2026')
    expect(formatScheduleAbsolute(INSTANT, 'zh-CN')).not.toContain('2026')
  })

  it('keeps the year for a language its policy does not list', () => {
    // An unlisted language takes the stated default: a target that can sit
    // months or a year away must not silently lose its year. German is not in
    // either list, and its own date form states the year.
    expect(formatScheduleAbsolute(INSTANT, 'de')).toBe(expected('de', true))
    expect(formatScheduleAbsolute(INSTANT, 'de')).toMatch(/\d{4}/)
    expect(formatScheduleAbsolute(INSTANT, 'de')).toContain('2026')
  })

  it('returns the stored text when the instant cannot be parsed', () => {
    expect(formatScheduleAbsolute('not an instant', 'en')).toBe('not an instant')
  })
})

describe('formatAvailableAt', () => {
  // Device-local wall-clock instants, so the same-day comparison holds in any runner zone.
  const now = new Date(2026, 9, 19, 12, 0, 0).getTime()

  it('reads the clock to the second today and adds the month and day for another day', () => {
    const today = new Date(2026, 9, 19, 15, 51, 37).getTime()
    const tomorrow = new Date(2026, 9, 20, 15, 51, 37).getTime()
    expect(formatAvailableAt(today, 'en', now)).toBe('15:51:37')
    expect(formatAvailableAt(today, 'zh-CN', now)).toBe('15:51:37')
    expect(formatAvailableAt(tomorrow, 'en', now)).toBe('Oct 20, 15:51:37')
    expect(formatAvailableAt(tomorrow, 'zh-CN', now)).toBe('10月20日 15:51:37')
  })

  it('reads the first hour of the day as 00, not 24', () => {
    expect(formatAvailableAt(new Date(2026, 9, 20, 0, 0, 5).getTime(), 'en', now)).toBe('Oct 20, 00:00:05')
  })
})

describe('formatScheduleNextRun', () => {
  /** The display zone's current calendar year; an instant inside it stays year-less. */
  const yearIn = (timeZone: string): string =>
    new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone }).format(Date.now())

  // The month is a locale-owned name plus the locale's own clock: en writes
  // `Oct 1, 3:00 PM` and zh-CN writes `10月1日 23:00`. Neither locale can emit
  // the retired zero-padded `MM-DD` pair.
  it('names the month and the clock field pair in each locale, in the given zone', () => {
    expect(formatScheduleNextRun(`${yearIn('UTC')}-10-01T15:00:00.000Z`, 'en', 'UTC')).toBe('Oct 1, 3:00 PM')
    expect(formatScheduleNextRun(`${yearIn('Asia/Shanghai')}-10-01T15:00:00.000Z`, 'en', 'Asia/Shanghai')).toBe('Oct 1, 11:00 PM')
    expect(formatScheduleNextRun(`${yearIn('UTC')}-12-31T15:00:00.000Z`, 'zh-CN', 'UTC')).toBe('12月31日 15:00')
    expect(formatScheduleNextRun(`${yearIn('Asia/Shanghai')}-12-31T15:00:00.000Z`, 'zh-CN', 'Asia/Shanghai')).toBe('12月31日 23:00')
  })

  it('adds the year when the instant falls outside the display zone\'s current year', () => {
    expect(formatScheduleNextRun('2001-10-01T15:00:00.000Z', 'en', 'UTC')).toBe('Oct 1, 2001, 3:00 PM')
    expect(formatScheduleNextRun('2001-10-01T15:00:00.000Z', 'zh-CN', 'Asia/Shanghai')).toBe('2001年10月1日 23:00')
  })

  it('matches the universal card field pair and never emits a padded month-day pair', () => {
    const at = `${yearIn('UTC')}-10-01T15:00:00.000Z`
    const expected = (locale: string, timeZone: string): string => new Intl.DateTimeFormat(locale, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone,
    }).format(Date.parse(at))
    for (const [locale, timeZone] of [['en', 'UTC'], ['zh-CN', 'UTC']] as const) {
      const shown = formatScheduleNextRun(at, locale, timeZone)
      expect(shown).toBe(expected(locale, timeZone))
      // No two-digit month-day pair, whatever separators the locale uses.
      expect(shown).not.toMatch(/\d{2}-\d{2}/)
      // The name and the clock are both present: a month word or 月, an hour
      // marker, and a day number.
      expect(shown).toMatch(locale === 'zh-CN' ? /月\s*\d{1,2}日/ : /[A-Za-z]{3}/)
      expect(shown).toMatch(/\d{1,2}:\d{2}/)
    }
  })

  it('returns the stored value when it is not a parseable instant', () => {
    expect(formatScheduleNextRun('not an instant', 'en')).toBe('not an instant')
  })

  it('leaves seconds out of the line for both locales', () => {
    // 15:20:37 shows as the 3:20 clock field pair, so the stored second and
    // millisecond cannot appear anywhere in the line.
    for (const locale of ['en', 'zh-CN']) {
      const shown = formatScheduleNextRun(`${yearIn('UTC')}-10-01T15:20:37.456Z`, locale, 'UTC')
      expect(shown).not.toContain('37')
      expect(shown).not.toContain('456')
    }
  })
})

/**
 * One Host task under one recurrence rule.
 * @param rrule - stored DTSTART and RRULE lines.
 * @returns the task record the formatter reads.
 */
function hostRecord(rrule: string): ScheduleRecord {
  return { kind: 'rrule', id: 'task-host' as ScheduleId, title: 'Host', prompt: 'Host', rrule, scheduledAt: '2026-10-05T01:00:00.000Z' }
}

describe('formatScheduleFrequency', () => {
  const t = makeTranslate(en)
  const local = { system: SYSTEM, label: (zone: string) => zone }
  const start = 'DTSTART;TZID=Asia/Shanghai:20261005T090000\nRRULE:'

  it.each([
    ['FREQ=WEEKLY;BYDAY=MO;COUNT=3', 'Custom'],
    ['FREQ=DAILY;COUNT=1', 'Once'],
    ['FREQ=DAILY;BYHOUR=9;BYMINUTE=0', 'Daily at 09:00'],
    ['FREQ=DAILY;INTERVAL=2', 'Every 2 days at 09:00'],
    ['FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE', 'Every 2 weeks on Mon, Wed at 09:00'],
    ['FREQ=MINUTELY;INTERVAL=15', 'Every 15 minutes'],
    ['FREQ=HOURLY;INTERVAL=2', 'Every 2 hours'],
    ['FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15,-1;BYSETPOS=1', 'Monthly on day 15 at 09:00, or month end'],
    ['FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15,-1;BYSETPOS=1', 'Every 3 months on day 15 at 09:00, or month end'],
  ])('reads the Host rule %s', (rule, expected) => {
    expect(formatScheduleFrequency(hostRecord(start + rule), t, local)).toBe(expected)
  })

  it('names UTC for a Host rule whose start states no zone', () => {
    expect(formatScheduleFrequency(hostRecord('DTSTART:20261005T090000Z\nRRULE:FREQ=DAILY;INTERVAL=1'), t, local))
      .toBe('Daily at 09:00 (UTC)')
  })

  it('names the zone of a Session-bound daily or weekly rule only when it is not the system zone', () => {
    const elsewhere = { system: 'UTC', label: (zone: string) => zone }
    const [, , , daily, weekly] = ZONE_RECORDS
    expect(formatScheduleFrequency(daily, t)).toBe(`Daily at 23:00 (${zoneLabel(SYSTEM, t)})`)
    expect(formatScheduleFrequency(daily, t, local)).toBe('Daily at 23:00')
    expect(formatScheduleFrequency(daily, t, elsewhere)).toBe('Daily at 23:00 (Asia/Shanghai)')
    expect(formatScheduleFrequency(weekly, t)).toBe(`Weekly on Mon at 09:30 (${zoneLabel(SYSTEM, t)})`)
    expect(formatScheduleFrequency(weekly, t, local)).toBe('Weekly on Mon at 09:30')
    expect(formatScheduleFrequency(weekly, t, elsewhere)).toBe('Weekly on Mon at 09:30 (Asia/Shanghai)')
  })
})
