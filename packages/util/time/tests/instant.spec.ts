import { Temporal } from '@js-temporal/polyfill'
import { describe, expect, it } from 'vitest'
import {
  MAX_FOUR_DIGIT_YEAR_MS,
  MIN_FOUR_DIGIT_YEAR_MS,
  canonicalizeTimeZone,
  formatFourDigitYearInstant,
  fourDigitYearEpoch,
  isFourDigitYearInstant,
  parseLocalCalendar,
  parseOffsetInstant,
  resolveLocalInstant,
} from '@deepseek-ai/dsh-util-time'

describe('parseLocalCalendar', () => {
  it('reads exact calendar fields and normalizes an absent fraction to zero', () => {
    expect(parseLocalCalendar('2026-03-08', '02:30:00')).toEqual({
      kind: 'accepted',
      time: { year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0, millisecond: 0 },
    })
  })

  it('pads a one- or two-digit fraction to milliseconds', () => {
    expect(parseLocalCalendar('2026-03-08', '02:30:00.5')).toEqual({
      kind: 'accepted',
      time: { year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0, millisecond: 500 },
    })
    expect(parseLocalCalendar('2026-03-08', '02:30:00.25')).toEqual({
      kind: 'accepted',
      time: { year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0, millisecond: 250 },
    })
  })

  it('distinguishes malformed text from an out-of-range field', () => {
    expect(parseLocalCalendar('2026-3-08', '02:30:00').kind).toBe('rejected')
    expect(parseLocalCalendar('2026-3-08', '02:30:00')).toEqual({ kind: 'rejected', reason: 'malformed' })
    expect(parseLocalCalendar('2026-03-08', '2:30:00')).toEqual({ kind: 'rejected', reason: 'malformed' })
    expect(parseLocalCalendar('2026-03-08', '02:30:00.1234')).toEqual({ kind: 'rejected', reason: 'malformed' })
    expect(parseLocalCalendar('0000-03-08', '02:30:00')).toEqual({ kind: 'rejected', reason: 'out_of_range' })
    expect(parseLocalCalendar('2026-03-08', '24:00:00')).toEqual({ kind: 'rejected', reason: 'out_of_range' })
    expect(parseLocalCalendar('2026-03-08', '02:60:00')).toEqual({ kind: 'rejected', reason: 'out_of_range' })
    expect(parseLocalCalendar('2026-03-08', '02:30:60')).toEqual({ kind: 'rejected', reason: 'out_of_range' })
  })

  it('rejects a date the calendar does not have', () => {
    expect(parseLocalCalendar('2026-02-30', '02:30:00')).toEqual({
      kind: 'rejected',
      reason: 'not_a_calendar_date',
    })
    expect(parseLocalCalendar('2025-02-29', '02:30:00')).toEqual({
      kind: 'rejected',
      reason: 'not_a_calendar_date',
    })
    expect(parseLocalCalendar('2024-02-29', '02:30:00').kind).toBe('accepted')
  })
})

describe('parseOffsetInstant', () => {
  it('reads a Z instant as its UTC epoch', () => {
    expect(parseOffsetInstant('2026-03-08T02:30:00Z')).toEqual({
      kind: 'accepted',
      epoch: Date.parse('2026-03-08T02:30:00.000Z'),
    })
  })

  it('subtracts a numeric offset from the written wall-clock value', () => {
    const wallClock = Date.parse('2026-03-08T02:30:00.000Z')
    expect(parseOffsetInstant('2026-03-08T02:30:00+08:00')).toEqual({
      kind: 'accepted',
      epoch: wallClock - 8 * 3_600_000,
    })
    expect(parseOffsetInstant('2026-03-08T02:30:00-05:30')).toEqual({
      kind: 'accepted',
      epoch: wallClock + 5.5 * 3_600_000,
    })
  })

  it('normalizes an optional one-to-three digit fraction to milliseconds', () => {
    expect(parseOffsetInstant('2026-03-08T02:30:00.5Z')).toEqual({
      kind: 'accepted',
      epoch: Date.parse('2026-03-08T02:30:00.500Z'),
    })
    expect(parseOffsetInstant('2026-03-08T02:30:00.25Z')).toEqual({
      kind: 'accepted',
      epoch: Date.parse('2026-03-08T02:30:00.250Z'),
    })
  })

  it('rejects text that is not the accepted RFC 3339 profile', () => {
    for (const value of [
      '2026-03-08T02:30:00',
      '2026-03-08 02:30:00Z',
      '2026-03-08T02:30Z',
      '2026-03-08T02:30:00.1234Z',
      '2026-3-08T02:30:00Z',
    ]) {
      expect(parseOffsetInstant(value)).toEqual({ kind: 'rejected', reason: 'not_rfc3339' })
    }
  })

  it('rejects a clock field, a zero year, and a non-existent calendar date', () => {
    expect(parseOffsetInstant('0000-03-08T02:30:00Z')).toEqual({
      kind: 'rejected',
      reason: 'out_of_range',
    })
    expect(parseOffsetInstant('2026-03-08T24:30:00Z')).toEqual({
      kind: 'rejected',
      reason: 'out_of_range',
    })
    expect(parseOffsetInstant('2026-03-08T02:60:00Z')).toEqual({
      kind: 'rejected',
      reason: 'out_of_range',
    })
    expect(parseOffsetInstant('2026-03-08T02:30:60Z')).toEqual({
      kind: 'rejected',
      reason: 'out_of_range',
    })
    expect(parseOffsetInstant('2026-02-30T02:30:00Z')).toEqual({
      kind: 'rejected',
      reason: 'not_a_calendar_date',
    })
  })

  it('rejects an unusable numeric offset', () => {
    expect(parseOffsetInstant('2026-03-08T02:30:00+24:00')).toEqual({
      kind: 'rejected',
      reason: 'invalid_numeric_offset',
    })
    expect(parseOffsetInstant('2026-03-08T02:30:00+08:60')).toEqual({
      kind: 'rejected',
      reason: 'invalid_numeric_offset',
    })
    expect(parseOffsetInstant('2026-03-08T02:30:00-00:00')).toEqual({
      kind: 'rejected',
      reason: 'invalid_numeric_offset',
    })
    expect(parseOffsetInstant('2026-03-08T02:30:00+00:00')).toEqual({
      kind: 'accepted',
      epoch: Date.parse('2026-03-08T02:30:00.000Z'),
    })
  })
})

describe('fourDigitYearEpoch', () => {
  it('accepts the canonical profile and answers its epoch', () => {
    expect(fourDigitYearEpoch('2026-03-08T02:30:00.000Z')).toEqual({
      kind: 'accepted',
      epoch: Date.parse('2026-03-08T02:30:00.000Z'),
    })
    expect(fourDigitYearEpoch('0001-01-01T00:00:00.000Z')).toEqual({
      kind: 'accepted',
      epoch: MIN_FOUR_DIGIT_YEAR_MS,
    })
    expect(fourDigitYearEpoch('9999-12-31T23:59:59.999Z')).toEqual({
      kind: 'accepted',
      epoch: MAX_FOUR_DIGIT_YEAR_MS,
    })
  })

  it('rejects everything outside the canonical profile', () => {
    for (const value of [
      '2026-03-08T02:30:00Z',
      '2026-03-08T02:30:00.000+00:00',
      '2026-03-08T02:30:00.00Z',
      '0000-01-01T00:00:00.000Z',
      '2026-3-08T02:30:00.000Z',
    ]) {
      expect(fourDigitYearEpoch(value)).toEqual({ kind: 'rejected', reason: 'not_rfc3339' })
    }
  })

  it('rejects a profile-shaped text whose date does not exist', () => {
    expect(fourDigitYearEpoch('2026-02-30T02:30:00.000Z')).toEqual({
      kind: 'rejected',
      reason: 'not_a_calendar_date',
    })
  })
})

describe('isFourDigitYearInstant', () => {
  it('answers the range including both bounds and excludes everything else', () => {
    expect(isFourDigitYearInstant(MIN_FOUR_DIGIT_YEAR_MS)).toBe(true)
    expect(isFourDigitYearInstant(MAX_FOUR_DIGIT_YEAR_MS)).toBe(true)
    expect(isFourDigitYearInstant(Date.parse('2026-03-08T02:30:00.000Z'))).toBe(true)
    for (const epoch of [MIN_FOUR_DIGIT_YEAR_MS - 1, MAX_FOUR_DIGIT_YEAR_MS + 1, 0.5, Number.NaN]) {
      expect(isFourDigitYearInstant(epoch)).toBe(false)
    }
  })
})

describe('formatFourDigitYearInstant', () => {
  it('formats both inclusive bounds in the canonical profile', () => {
    expect(formatFourDigitYearInstant(MIN_FOUR_DIGIT_YEAR_MS)).toBe('0001-01-01T00:00:00.000Z')
    expect(formatFourDigitYearInstant(MAX_FOUR_DIGIT_YEAR_MS)).toBe('9999-12-31T23:59:59.999Z')
  })

  it('refuses a non-integral or out-of-range epoch', () => {
    for (const epoch of [MIN_FOUR_DIGIT_YEAR_MS - 1, MAX_FOUR_DIGIT_YEAR_MS + 1, 0.5, Number.NaN]) {
      expect(formatFourDigitYearInstant(epoch)).toBeUndefined()
    }
  })
})

describe('canonicalizeTimeZone', () => {
  it('answers the runtime-canonical name', () => {
    expect(canonicalizeTimeZone('UTC')).toEqual({ kind: 'accepted', timeZone: 'UTC' })
    expect(canonicalizeTimeZone('US/Eastern')).toEqual({ kind: 'accepted', timeZone: 'America/New_York' })
    expect(canonicalizeTimeZone('America/New_York')).toEqual({
      kind: 'accepted',
      timeZone: 'America/New_York',
    })
  })

  it('reports why a name is refused', () => {
    expect(canonicalizeTimeZone('')).toEqual({ kind: 'rejected', reason: 'blank' })
    expect(canonicalizeTimeZone(' UTC')).toEqual({ kind: 'rejected', reason: 'padded' })
    expect(canonicalizeTimeZone('UTC ')).toEqual({ kind: 'rejected', reason: 'padded' })
    expect(canonicalizeTimeZone('Asia')).toEqual({ kind: 'rejected', reason: 'not_area_location' })
    expect(canonicalizeTimeZone('GMT+8')).toEqual({ kind: 'rejected', reason: 'not_area_location' })
    expect(canonicalizeTimeZone('utc')).toEqual({ kind: 'rejected', reason: 'not_area_location' })
    const unsupported = canonicalizeTimeZone('Not/A_Real_Zone')
    if (unsupported.kind !== 'rejected') throw new Error('expected a rejection')
    expect(unsupported.reason).toBe('unsupported')
    // The platform refusal is the caller's only evidence of why a well-formed name failed,
    // so the rejection carries it instead of hiding it.
    expect(unsupported.cause).toBeInstanceOf(RangeError)
    expect(canonicalizeTimeZone('Asia')).not.toHaveProperty('cause')
  })
})

describe('resolveLocalInstant', () => {
  const local = (hour: number, minute: number) => ({
    year: 2026, month: 3, day: 8, hour, minute, second: 0, millisecond: 0,
  })

  it('resolves a wall-clock value that exists exactly once', () => {
    expect(resolveLocalInstant(local(12, 0), 'America/New_York')).toBe(
      Date.parse('2026-03-08T16:00:00.000Z'),
    )
  })

  it('answers undefined for a forward-transition gap', () => {
    // 2026-03-08T02:30 local does not exist in America/New_York.
    expect(resolveLocalInstant(local(2, 30), 'America/New_York')).toBeUndefined()
  })

  it('selects the earlier instant of a backward-transition overlap', () => {
    // 2026-11-01T01:30 local occurs twice in America/New_York.
    const overlap = { ...local(1, 30), month: 11, day: 1 }
    expect(resolveLocalInstant(overlap, 'America/New_York')).toBe(
      Date.parse('2026-11-01T05:30:00.000Z'),
    )
  })

  it('resolves UTC without a transition', () => {
    expect(resolveLocalInstant(local(2, 30), 'UTC')).toBe(Date.parse('2026-03-08T02:30:00.000Z'))
  })

  it('accepts an already-built plain date-time, so a caller that holds one needs no copy', () => {
    expect(resolveLocalInstant(Temporal.PlainDateTime.from('2026-03-08T12:00:00'), 'America/New_York'))
      .toBe(Date.parse('2026-03-08T16:00:00.000Z'))
    expect(resolveLocalInstant(Temporal.PlainDateTime.from('2026-03-08T02:30:00'), 'America/New_York'))
      .toBeUndefined()
  })
})
